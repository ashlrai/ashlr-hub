/**
 * run-tests.ts — M331 (completes M140): run a proposal's diff against the
 * repo's own verification commands in a throwaway sandbox worktree.
 *
 * THIS MODULE'S NAME AND `runTests` SIGNATURE ARE LOAD-BEARING: best-of-n.ts
 * imports `./run-tests.js` expecting
 * `runTests(proposalId, cfg): Promise<boolean>` since M170 and degraded
 * `runTests(proposalId, cfg): Promise<boolean>`. The in-memory companion keeps
 * winner-only Best-of-N capture behind the same verification path.
 *
 * Flow: loadProposal → createSandbox (policy-gated, kill-switch aware) →
 * select verification from the trusted base → `git apply` the diff → reject
 * verifier-selection drift → run the base commands cheap-first
 * (typecheck → lint → build → test) → removeSandbox.
 *
 * Semantics: absence of verification (no proposal, no diff, no commands,
 * sandbox unavailable) is NEUTRAL (passed: true, skipped set) — a candidate
 * must never be disqualified because a repo has no test suite. A diff that
 * FAILS TO APPLY or whose checks FAIL is a real negative (passed: false).
 *
 * Infrastructure failures never throw. Caller cancellation rejects from the
 * boolean wrapper after bounded cleanup. No network. Worktrees are retained
 * for orphan recovery when subprocess closure cannot be confirmed.
 */

import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { AshlrConfig, Proposal, Sandbox } from '../types.js';
import type { SandboxRetentionEvidence } from './sandboxed-engine.js';
import {
  canonicalizeVerifyCommands,
  detectRepoExecutionProfile,
  type MergeVerifyContractScannerSource,
  type RepoExecutionProfile,
  type RepoVerifyContractSource,
} from './repo-profile.js';
import {
  filterVerifyCommandsForProfile,
  runVerifyCommandAsync,
  runVerifySubprocessAsync,
  type VerifyCommand,
  type VerifyFailureCategory,
  type VerifyCommandProfile,
} from './verify-commands.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestRunCommandResult {
  kind: VerifyCommand['kind'];
  command: string;
  exitCode: number;
  ok: boolean;
  timedOut: boolean;
  failureCategory?: VerifyFailureCategory;
  /** Combined stdout+stderr tail (scrubbed + capped by verify-commands). */
  outputTail: string;
}

export interface TestRunResult {
  passed: boolean;
  commands: TestRunCommandResult[];
  /** Set when verification could not run; apply/cleanup failures are non-neutral. */
  skipped?:
    | 'no-proposal'
    | 'no-diff'
    | 'sandbox-failed'
    | 'apply-failed'
    | 'verification-selection-unavailable'
    | 'verification-selection-drift'
    | 'no-commands'
    | 'cancelled'
    | 'process-cleanup-unconfirmed';
  /** Present when the worktree remains intact because subprocess closure was not proven. */
  sandboxRetention?: SandboxRetentionEvidence;
}

export interface RunTestsOptions {
  signal?: AbortSignal;
}

/** Cheap-first ordering: typecheck → lint → build → test. */
const KIND_RANK: Record<VerifyCommand['kind'], number> = { typecheck: 0, lint: 1, build: 2, test: 3 };

const PER_COMMAND_TIMEOUT_MS = 180_000;
const MAX_VERIFIER_CONTROL_FILES = 512;
const MAX_VERIFIER_CONTROL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_VERIFIER_CONTROL_TOTAL_BYTES = 16 * 1024 * 1024;

interface VerifierControlFileIdentity {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  device: number;
  inode: number;
}

interface VerificationSelectionSnapshot {
  profile: VerifyCommandProfile;
  verifyContractSource: RepoVerifyContractSource;
  source: MergeVerifyContractScannerSource;
  commandPlan: ReturnType<typeof canonicalizeVerifyCommands>;
  controlFiles: VerifierControlFileIdentity[];
}

function safeRelativeFile(root: string, path: string): string | null {
  const rel = relative(root, path).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

function detectedManifestPaths(profile: RepoExecutionProfile): string[] | null {
  const repoRoot = resolve(profile.repoRoot);
  const paths = new Set<string>();
  for (const project of profile.projects) {
    const projectRoot = resolve(project.root);
    const projectRel = relative(repoRoot, projectRoot);
    if (projectRel.startsWith('..') || isAbsolute(projectRel)) return null;
    for (const manifest of project.manifests) {
      const exact = resolve(projectRoot, manifest);
      const exactRel = safeRelativeFile(repoRoot, exact);
      if (!exactRel) return null;
      try {
        lstatSync(exact);
        paths.add(exactRel);
        continue;
      } catch {
        // `vitest.config` is a detector marker for its supported extensions.
      }
      let matches: string[];
      try {
        matches = readdirSync(projectRoot)
          .filter((entry) => entry.startsWith(`${manifest}.`))
          .sort();
      } catch {
        return null;
      }
      if (matches.length === 0) return null;
      for (const match of matches) {
        const matchRel = safeRelativeFile(repoRoot, resolve(projectRoot, match));
        if (!matchRel) return null;
        paths.add(matchRel);
      }
    }
  }
  for (const command of profile.verifyCommands) {
    const cwd = resolve(command.cwd ?? repoRoot);
    const cwdRel = relative(repoRoot, cwd);
    if (cwdRel.startsWith('..') || isAbsolute(cwdRel)) return null;
    for (const [index, argument] of command.cmd.entries()) {
      if (
        !argument ||
        argument.includes('\0') ||
        argument.startsWith('-') ||
        (index === 0 && !argument.includes('/') && !argument.includes('\\'))
      ) {
        continue;
      }
      const candidate = resolve(cwd, argument);
      const candidateRel = safeRelativeFile(repoRoot, candidate);
      if (!candidateRel) continue;
      try {
        const stat = lstatSync(candidate);
        if (stat.isFile() || stat.isSymbolicLink()) paths.add(candidateRel);
      } catch {
        // Non-file argv values do not belong to the available control closure.
      }
    }
  }
  for (const authorityFile of profile.mergeVerifyContractSource.verifyContract?.authorityFiles ?? []) {
    const authorityRel = safeRelativeFile(repoRoot, resolve(repoRoot, authorityFile));
    if (!authorityRel || authorityRel !== authorityFile) return null;
    paths.add(authorityRel);
  }
  const out = [...paths].sort();
  return out.length <= MAX_VERIFIER_CONTROL_FILES ? out : null;
}

function readControlFileIdentity(
  repoRoot: string,
  relativePath: string,
): VerifierControlFileIdentity | null {
  const root = resolve(repoRoot);
  const path = resolve(root, relativePath);
  if (safeRelativeFile(root, path) !== relativePath) return null;
  let fd: number | null = null;
  try {
    const beforePath = lstatSync(path);
    if (beforePath.isSymbolicLink() || !beforePath.isFile()) return null;
    if (beforePath.size > MAX_VERIFIER_CONTROL_FILE_BYTES) return null;
    const physicalRoot = realpathSync(root);
    const physicalPath = realpathSync(path);
    const physicalRel = relative(physicalRoot, physicalPath);
    if (!physicalRel || physicalRel.startsWith('..') || isAbsolute(physicalRel)) return null;

    fd = openSync(path, 'r');
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_VERIFIER_CONTROL_FILE_BYTES) return null;
    if (
      beforePath.dev !== before.dev ||
      beforePath.ino !== before.ino ||
      beforePath.mode !== before.mode ||
      beforePath.size !== before.size ||
      beforePath.mtimeMs !== before.mtimeMs
    ) {
      return null;
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const afterPath = lstatSync(path);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== afterPath.dev ||
      after.ino !== afterPath.ino ||
      after.mode !== afterPath.mode ||
      after.size !== afterPath.size ||
      after.mtimeMs !== afterPath.mtimeMs
    ) {
      return null;
    }
    return {
      path: relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: after.size,
      mode: after.mode & 0o777,
      device: after.dev,
      inode: after.ino,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
  }
}

function captureControlFiles(profile: RepoExecutionProfile): VerifierControlFileIdentity[] | null {
  const paths = detectedManifestPaths(profile);
  if (!paths) return null;
  const identities: VerifierControlFileIdentity[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const identity = readControlFileIdentity(profile.repoRoot, path);
    if (!identity) return null;
    totalBytes += identity.size;
    if (totalBytes > MAX_VERIFIER_CONTROL_TOTAL_BYTES) return null;
    identities.push(identity);
  }
  return identities;
}

function captureVerificationSelectionOnce(
  worktreePath: string,
  profile: VerifyCommandProfile,
): { snapshot: VerificationSelectionSnapshot; commands: VerifyCommand[] } | null {
  try {
    const executionProfile = detectRepoExecutionProfile(worktreePath);
    if (
      executionProfile.mergeVerifyContractSource.inputState !== 'complete' ||
      !['missing', 'tracked-clean'].includes(executionProfile.verifyContractSource) ||
      (executionProfile.verifyContract?.present === true && !executionProfile.verifyContract.valid)
    ) {
      return null;
    }
    const controlFiles = captureControlFiles(executionProfile);
    if (!controlFiles) return null;
    const commands = filterVerifyCommandsForProfile(
      executionProfile.verifyCommands,
      profile,
    ).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    return {
      commands,
      snapshot: {
        profile,
        verifyContractSource: executionProfile.verifyContractSource,
        source: executionProfile.mergeVerifyContractSource,
        // Preserve execution order while canonicalizing repository-relative cwd values.
        commandPlan: commands.flatMap((command) => canonicalizeVerifyCommands(worktreePath, [command])),
        controlFiles,
      },
    };
  } catch {
    return null;
  }
}

function captureVerificationSelection(
  worktreePath: string,
  profile: VerifyCommandProfile,
): { snapshot: VerificationSelectionSnapshot; commands: VerifyCommand[] } | null {
  const first = captureVerificationSelectionOnce(worktreePath, profile);
  const second = captureVerificationSelectionOnce(worktreePath, profile);
  if (!first || !second || !verificationSelectionMatches(first.snapshot, second.snapshot)) return null;
  return first;
}

function verificationSelectionMatches(
  trusted: VerificationSelectionSnapshot,
  candidate: VerificationSelectionSnapshot,
): boolean {
  return JSON.stringify(trusted) === JSON.stringify(candidate);
}

const PROCESS_CLEANUP_UNCONFIRMED_RE =
  /(?:termination authority lost|termination deadline elapsed[^\n]*(?:unconfirmed|could not be authenticated)|process(?:-group)?[^\n]*(?:closure|exit)[^\n]*unconfirmed)/i;

function processCleanupUnconfirmed(detail: string | undefined): boolean {
  return PROCESS_CLEANUP_UNCONFIRMED_RE.test(detail ?? '');
}

function retainedSandboxEvidence(sb: Sandbox): SandboxRetentionEvidence {
  return {
    status: 'retained',
    reason: 'process-cleanup-unconfirmed',
    sandboxId: sb.id,
    worktreePath: sb.worktreePath,
    recovery: 'orphan-sweep',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The exact shape best-of-n.ts imports (M170 contract). True on green OR
 * neutral skip; false when the diff fails to apply or a check fails.
 */
export async function runTests(
  proposalId: string,
  cfg: AshlrConfig,
  profile: VerifyCommandProfile = 'merge',
  options: RunTestsOptions = {},
): Promise<boolean> {
  const detailed = await runTestsDetailed(proposalId, cfg, profile, options);
  if (detailed.skipped === 'cancelled') {
    if (options.signal?.reason instanceof Error) throw options.signal.reason;
    const error = new Error('Test run cancelled');
    error.name = 'AbortError';
    throw error;
  }
  return detailed.passed;
}

/** Verify an in-memory proposal draft before it is persisted. */
export async function runTestsForProposal(
  proposal: Pick<Proposal, 'repo' | 'diff'>,
  cfg: AshlrConfig,
  profile: VerifyCommandProfile = 'merge',
  options: RunTestsOptions = {},
): Promise<boolean> {
  const detailed = await runTestsForProposalDetailed(proposal, cfg, profile, options);
  if (detailed.skipped === 'cancelled') {
    if (options.signal?.reason instanceof Error) throw options.signal.reason;
    const error = new Error('Test run cancelled');
    error.name = 'AbortError';
    throw error;
  }
  return detailed.passed;
}

/** Full-fidelity variant for evidence packs and the M335 dashboard. */
export async function runTestsDetailed(
  proposalId: string,
  cfg: AshlrConfig,
  profile: VerifyCommandProfile = 'merge',
  options: RunTestsOptions = {},
): Promise<TestRunResult> {
  if (options.signal?.aborted) return { passed: false, commands: [], skipped: 'cancelled' };
  let proposal: Pick<Proposal, 'repo' | 'diff'> | null = null;
  try {
    const { loadProposal } = await import('../inbox/store.js');
    proposal = loadProposal(proposalId);
  } catch {
    /* fall through to no-proposal */
  }
  if (options.signal?.aborted) return { passed: false, commands: [], skipped: 'cancelled' };
  if (!proposal) return { passed: true, commands: [], skipped: 'no-proposal' };
  return runTestsForProposalDetailed(proposal, cfg, profile, options);
}

/** Full-fidelity draft verifier shared by persisted and winner-only proposal paths. */
export async function runTestsForProposalDetailed(
  proposal: Pick<Proposal, 'repo' | 'diff'>,
  cfg: AshlrConfig,
  profile: VerifyCommandProfile = 'merge',
  options: RunTestsOptions = {},
): Promise<TestRunResult> {
  let sb: Sandbox | null = null;
  let removeSandbox: ((sandbox: Sandbox) => void) | undefined;
  let sandboxRetention: SandboxRetentionEvidence | undefined;
  const results: TestRunCommandResult[] = [];
  const cancelled = (): TestRunResult => ({ passed: false, commands: results, skipped: 'cancelled' });
  const cleanupUnconfirmed = (): TestRunResult => ({
    passed: false,
    commands: results,
    skipped: 'process-cleanup-unconfirmed',
    sandboxRetention: sandboxRetention!,
  });
  try {
    if (options.signal?.aborted) return cancelled();

    const repo = proposal.repo ?? undefined;
    const diff = proposal.diff ?? undefined;
    if (!repo) return { passed: true, commands: [], skipped: 'no-proposal' };
    if (!diff || diff.trim().length === 0) {
      return { passed: true, commands: [], skipped: 'no-diff' };
    }

    // 2. Throwaway worktree via the sandbox machinery (policy-gated: kill
    //    switch + enrollment apply exactly as for any other sandbox).
    try {
      const worktree = await import('../sandbox/worktree.js');
      removeSandbox = worktree.removeSandbox;
      sb = worktree.createSandbox(repo);
    } catch {
      return { passed: true, commands: [], skipped: 'sandbox-failed' };
    }
    if (options.signal?.aborted) return cancelled();

    // Select the complete verification plan from the clean base. Candidate
    // bytes are not allowed to add, remove, replace, or re-profile their own
    // verifier before this draft is evaluated.
    const trustedSelection = captureVerificationSelection(sb.worktreePath, profile);
    if (!trustedSelection) {
      return { passed: false, commands: [], skipped: 'verification-selection-unavailable' };
    }

    // 3. Apply the diff. A diff that does not apply is a REAL negative — the
    //    candidate's patch is broken against the current tree.
    const patchDir = mkdtempSync(join(tmpdir(), 'ashlr-run-tests-'));
    const patchFile = join(patchDir, 'proposal.patch');
    try {
      writeFileSync(patchFile, diff.endsWith('\n') ? diff : diff + '\n', 'utf8');
      const applied = await runVerifySubprocessAsync(
        ['git', 'apply', '--whitespace=nowarn', patchFile],
        {
          cwd: sb.worktreePath,
          env: process.env,
          timeoutMs: 30_000,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (processCleanupUnconfirmed(applied.error)) {
        sandboxRetention = retainedSandboxEvidence(sb);
        return cleanupUnconfirmed();
      }
      if (applied.cancelled || options.signal?.aborted) return cancelled();
      if (applied.error || applied.timedOut || applied.exitCode !== 0) {
        return { passed: false, commands: [], skipped: 'apply-failed' };
      }
    } catch {
      if (options.signal?.aborted) return cancelled();
      return { passed: false, commands: [], skipped: 'apply-failed' };
    } finally {
      try {
        rmSync(patchDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }

    if (options.signal?.aborted) return cancelled();

    // 4. Re-read selection inputs after apply. Any candidate-induced change is
    // an authority violation, including changes outside the requested profile.
    const candidateSelection = captureVerificationSelection(sb.worktreePath, profile);
    if (
      !candidateSelection ||
      !verificationSelectionMatches(trustedSelection.snapshot, candidateSelection.snapshot)
    ) {
      return { passed: false, commands: [], skipped: 'verification-selection-drift' };
    }

    const verifyCommands = trustedSelection.commands;
    if (verifyCommands.length === 0) return { passed: true, commands: [], skipped: 'no-commands' };
    const selectionStillTrusted = (): boolean => {
      const current = captureVerificationSelection(sb!.worktreePath, profile);
      return current !== null && verificationSelectionMatches(trustedSelection.snapshot, current.snapshot);
    };

    // 5. Run the base-derived plan cheap-first; stop at the first failure.
    for (const [index, vc] of verifyCommands.entries()) {
      if (options.signal?.aborted) return cancelled();
      if (!selectionStillTrusted()) {
        return { passed: false, commands: results, skipped: 'verification-selection-drift' };
      }
      const r = await runVerifyCommandAsync(vc, sb.worktreePath, cfg, {
        timeoutMs: vc.timeoutMs ?? PER_COMMAND_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const commandCleanupUnconfirmed =
        r.failureCategory === 'infra' && processCleanupUnconfirmed(r.output);
      const commandCancelled = r.cancelled === true || (
        options.signal?.aborted === true && r.failureCategory === 'infra' && !commandCleanupUnconfirmed
      );
      const result: TestRunCommandResult = {
        kind: vc.kind,
        command: r.command,
        exitCode: r.exitCode,
        ok: r.ok,
        timedOut: r.timedOut,
        ...(commandCancelled
          ? { failureCategory: 'cancelled' as const }
          : (r.failureCategory ? { failureCategory: r.failureCategory } : {})),
        outputTail: r.output.slice(-4_096),
      };
      results.push(result);
      if (commandCleanupUnconfirmed) {
        sandboxRetention = retainedSandboxEvidence(sb);
        return cleanupUnconfirmed();
      }
      if (!selectionStillTrusted()) {
        return { passed: false, commands: results, skipped: 'verification-selection-drift' };
      }
      if (commandCancelled) return cancelled();
      if (!r.ok && vc.required !== false) return { passed: false, commands: results };
      if (options.signal?.aborted) {
        if (index === verifyCommands.length - 1) return { passed: true, commands: results };
        return cancelled();
      }
    }
    return { passed: true, commands: results };
  } catch {
    if (sandboxRetention) return cleanupUnconfirmed();
    if (options.signal?.aborted) return cancelled();
    // Never throws — an infrastructure error is neutral, not a candidate fault.
    return { passed: true, commands: [], skipped: 'sandbox-failed' };
  } finally {
    if (sb && removeSandbox && !sandboxRetention) {
      try {
        removeSandbox(sb);
      } catch {
        /* best-effort cleanup — sweepOrphanSandboxes reclaims stragglers */
      }
    }
  }
}

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
 * `git apply` the diff → detectRepoExecutionProfile INSIDE the worktree (so a
 * diff that adds a test script counts) → run verify commands cheap-first
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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, Proposal, Sandbox } from '../types.js';
import type { SandboxRetentionEvidence } from './sandboxed-engine.js';
import { detectRepoExecutionProfile, mergeContractCoverageFailure } from './repo-profile.js';
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
    | 'no-commands'
    | 'merge-contract-coverage-incomplete'
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

    // 4. Detect verification commands INSIDE the patched worktree.
    const executionProfile = detectRepoExecutionProfile(sb.worktreePath);
    if (profile === 'merge' && mergeContractCoverageFailure(executionProfile) !== null) {
      return { passed: false, commands: [], skipped: 'merge-contract-coverage-incomplete' };
    }
    const verifyCommands = filterVerifyCommandsForProfile(
      executionProfile.verifyCommands,
      profile,
    ).sort(
      (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind],
    );
    if (verifyCommands.length === 0) return { passed: true, commands: [], skipped: 'no-commands' };

    // 5. Run cheap-first; stop at the first failure.
    for (const [index, vc] of verifyCommands.entries()) {
      if (options.signal?.aborted) return cancelled();
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

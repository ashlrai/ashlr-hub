/**
 * Observation-only detached post-merge verification runner.
 *
 * The runner checks out one exact commit into a fresh temporary worktree,
 * executes the repository-owned merge verification profile, records only
 * bounded metadata through the detached cohort store, and removes the worktree.
 * It never grants merge, rollback, deployment, routing, canary, or daemon
 * authority.
 */

import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AshlrConfig } from '../types.js';
import {
  recordDetachedPostMergeVerificationCohort,
  type DetachedPostMergeVerificationCohortInput,
} from './detached-post-merge-verification.js';
import { buildRequiredVerificationManifest } from '../run/verification-manifest.js';
import {
  detectVerifyCommands,
  runVerifyCommandAsync,
  type VerifyCommand,
  type VerifyFailureCategory,
} from '../run/verify-commands.js';
import type { ImmutablePrivateRecordWriteDisposition } from '../util/immutable-private-record-store.js';

const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_TOTAL_TIMEOUT_MS = 60 * 60 * 1_000;
const TEMP_PREFIX = 'ashlr-detached-postmerge-';

export type DetachedPostMergeRunnerTerminal = 'pass' | 'fail' | 'unknown';
export type DetachedPostMergeRunnerCleanup = 'removed' | 'failed' | 'not-created';
export type DetachedPostMergeRunnerReason =
  | 'verified'
  | 'code-failure'
  | 'verification-infrastructure'
  | 'verification-timeout'
  | 'invalid-input'
  | 'source-unavailable'
  | 'binding-mismatch'
  | 'worktree-create-failed'
  | 'manifest-unavailable'
  | 'isolation-lost'
  | 'cleanup-failed'
  | 'record-rejected';

export interface DetachedPostMergeRunnerInput {
  repo: string;
  cohortId: string;
  proposalId: string;
  baseBranch: string;
  baseHead: string;
  candidateHead: string;
  mergeCommit: string;
  runId?: string;
  trajectoryId?: string;
  workItemId?: string;
}

export interface DetachedPostMergeRunnerResult {
  schemaVersion: 1;
  authority: 'observation-only';
  policyEligible: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  terminal: DetachedPostMergeRunnerTerminal;
  reason: DetachedPostMergeRunnerReason;
  verifierManifestDigest: string | null;
  requiredCommandCount: number;
  commandsRun: number;
  failureCategory: VerifyFailureCategory | null;
  cleanup: DetachedPostMergeRunnerCleanup;
  recordDisposition: ImmutablePrivateRecordWriteDisposition | 'not-recorded';
}

export interface DetachedPostMergeRunnerOptions {
  maxCommandTimeoutMs?: number;
  maxTotalTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Adversarial test seams only. Production callers must leave these unset.
   * They add no authority and cannot change the hard-false result flags.
   */
  _beforeCommand?: (worktreePath: string, commandIndex: number) => void | Promise<void>;
  _beforeCleanup?: (worktreePath: string, tempRoot: string) => void | Promise<void>;
  _now?: () => Date;
}

interface GitResult {
  ok: boolean;
  status: number;
  stdout: string;
}

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
}

interface IsolationProof {
  head: string;
  clean: boolean;
  detached: boolean;
}

function result(
  overrides: Partial<DetachedPostMergeRunnerResult>,
): DetachedPostMergeRunnerResult {
  return {
    schemaVersion: 1,
    authority: 'observation-only',
    policyEligible: false,
    mergePermitted: false,
    rollbackPermitted: false,
    deployPermitted: false,
    terminal: 'unknown',
    reason: 'verification-infrastructure',
    verifierManifestDigest: null,
    requiredCommandCount: 0,
    commandsRun: 0,
    failureCategory: null,
    cleanup: 'not-created',
    recordDisposition: 'not-recorded',
    ...overrides,
  };
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), maximum)
    : fallback;
}

function nowMs(now: () => Date): number | null {
  try {
    const value = now().getTime();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function nowIso(now: () => Date): string | null {
  try {
    const value = now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  } catch {
    return null;
  }
}

function git(cwd: string, args: readonly string[]): GitResult {
  try {
    const run = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    });
    return {
      ok: run.status === 0 && run.error === undefined,
      status: run.status ?? -1,
      stdout: String(run.stdout ?? '').trim(),
    };
  } catch {
    return { ok: false, status: -1, stdout: '' };
  }
}

function nestedWithin(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested !== '' && nested !== '..' &&
    !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function privateDirectoryIdentity(path: string): DirectoryIdentity | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat) ||
      (process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n)) return null;
    return { path: resolve(path), dev: stat.dev, ino: stat.ino, uid: stat.uid };
  } catch {
    return null;
  }
}

function sameDirectoryIdentity(expected: DirectoryIdentity): boolean {
  const actual = privateDirectoryIdentity(expected.path);
  return actual !== null && actual.dev === expected.dev &&
    actual.ino === expected.ino && actual.uid === expected.uid;
}

function canonicalRepo(repo: string): string | null {
  if (typeof repo !== 'string' || !isAbsolute(repo) || repo.length > 4_096) return null;
  try {
    const lexical = resolve(repo);
    const stat = lstatSync(lexical, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser(stat)) return null;
    const physical = realpathSync.native(lexical);
    const top = git(physical, ['rev-parse', '--path-format=absolute', '--show-toplevel']);
    if (!top.ok || realpathSync.native(top.stdout) !== physical) return null;
    return physical;
  } catch {
    return null;
  }
}

function exactCommit(repo: string, sha: string): boolean {
  if (!GIT_SHA_RE.test(sha)) return false;
  const resolved = git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
  return resolved.ok && resolved.stdout === sha;
}

function exactMergeBinding(
  repo: string,
  baseHead: string,
  candidateHead: string,
  mergeCommit: string,
): boolean {
  if (mergeCommit === candidateHead && baseHead !== candidateHead) {
    return git(repo, ['merge-base', '--is-ancestor', baseHead, candidateHead]).ok;
  }
  const parents = git(repo, ['show', '--no-patch', '--format=%P', mergeCommit]);
  if (!parents.ok) return false;
  const parentShas = parents.stdout.split(/\s+/).filter(Boolean);
  return parentShas.length === 2 &&
    parentShas[0] === baseHead &&
    parentShas[1] === candidateHead;
}

function commonGitDirectory(repo: string): string | null {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok || !isAbsolute(common.stdout)) return null;
  try { return realpathSync.native(common.stdout); } catch { return null; }
}

function inspectIsolation(
  repo: string,
  expectedHead: string,
  expectedWorktree: string,
  expectedCommonDir: string,
): IsolationProof | null {
  try {
    if (realpathSync.native(repo) !== expectedWorktree ||
      commonGitDirectory(repo) !== expectedCommonDir) return null;
    const head = git(repo, ['rev-parse', '--verify', 'HEAD']);
    const status = git(repo, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
    ]);
    const branch = git(repo, ['symbolic-ref', '--quiet', 'HEAD']);
    if (!head.ok || head.stdout !== expectedHead || !status.ok ||
      (branch.status !== 1 && branch.status !== 128)) return null;
    return {
      head: head.stdout,
      clean: status.stdout.length === 0,
      detached: !branch.ok,
    };
  } catch {
    return null;
  }
}

function commandTimeout(
  command: VerifyCommand,
  maxCommandTimeoutMs: number,
  remainingMs: number,
): number {
  const declared = boundedTimeout(
    command.timeoutMs,
    DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
  );
  return Math.max(1, Math.min(declared, maxCommandTimeoutMs, remainingMs));
}

function safeCleanup(
  sourceRepo: string,
  worktreePath: string,
  tempIdentity: DirectoryIdentity,
  expectedWorktree: string | null,
): DetachedPostMergeRunnerCleanup {
  if (expectedWorktree === null) {
    if (!sameDirectoryIdentity(tempIdentity)) return 'failed';
    try {
      rmdirSync(tempIdentity.path);
      return 'not-created';
    } catch {
      return 'failed';
    }
  }

  try {
    if (!sameDirectoryIdentity(tempIdentity) ||
      !nestedWithin(tempIdentity.path, worktreePath) ||
      realpathSync.native(worktreePath) !== expectedWorktree) return 'failed';
    const worktreeStat = lstatSync(worktreePath, { bigint: true });
    if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink() ||
      !ownedByCurrentUser(worktreeStat)) return 'failed';
  } catch {
    return 'failed';
  }

  const removed = git(sourceRepo, ['worktree', 'remove', '--force', worktreePath]);
  if (!removed.ok || !sameDirectoryIdentity(tempIdentity)) return 'failed';
  try {
    // The worktree command owns removal of its child. Refuse recursive fallback.
    statSync(worktreePath);
    return 'failed';
  } catch {
    try {
      rmdirSync(tempIdentity.path);
      return 'removed';
    } catch {
      return 'failed';
    }
  }
}

function recordObservation(input: {
  runnerInput: DetachedPostMergeRunnerInput;
  repo: string;
  manifest: NonNullable<ReturnType<typeof buildRequiredVerificationManifest>>;
  sourceState: 'healthy' | 'degraded';
  terminal: DetachedPostMergeRunnerTerminal;
  failureCategory: VerifyFailureCategory | null;
  verifiedHead: string | null;
  verifiedAt: string | null;
  workspaceClean: boolean;
  observedAt: string;
}): ImmutablePrivateRecordWriteDisposition {
  const member: DetachedPostMergeVerificationCohortInput['members'][number] = {
    repo: input.repo,
    proposalId: input.runnerInput.proposalId,
    baseBranch: input.runnerInput.baseBranch,
    baseHead: input.runnerInput.baseHead,
    candidateHead: input.runnerInput.candidateHead,
    mergeCommit: input.runnerInput.mergeCommit,
    verifierManifest: input.manifest,
    sourceState: input.sourceState,
    ...(input.sourceState === 'healthy' && input.terminal !== 'unknown'
      ? { terminal: input.terminal }
      : {}),
    ...(input.verifiedHead ? { verifiedHead: input.verifiedHead } : {}),
    ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
    workspaceClean: input.workspaceClean,
    isolation: 'detached-worktree',
    ...(input.failureCategory ? { failureCategory: input.failureCategory } : {}),
    ...(input.runnerInput.runId ? { runId: input.runnerInput.runId } : {}),
    ...(input.runnerInput.trajectoryId ? { trajectoryId: input.runnerInput.trajectoryId } : {}),
    ...(input.runnerInput.workItemId ? { workItemId: input.runnerInput.workItemId } : {}),
  };
  return recordDetachedPostMergeVerificationCohort({
    cohortId: input.runnerInput.cohortId,
    observedAt: input.observedAt,
    expectedMemberCount: 1,
    members: [member],
  });
}

export async function runDetachedPostMergeVerification(
  input: DetachedPostMergeRunnerInput,
  options: DetachedPostMergeRunnerOptions = {},
): Promise<DetachedPostMergeRunnerResult> {
  const now = options._now ?? (() => new Date());
  const repo = canonicalRepo(input.repo);
  if (!repo || !GIT_SHA_RE.test(input.baseHead) ||
    !GIT_SHA_RE.test(input.candidateHead) || !GIT_SHA_RE.test(input.mergeCommit)) {
    return result({ reason: 'invalid-input' });
  }
  if (![input.baseHead, input.candidateHead, input.mergeCommit]
    .every((sha) => exactCommit(repo, sha))) {
    return result({ reason: 'source-unavailable' });
  }
  const sourceCommonDir = commonGitDirectory(repo);
  if (!sourceCommonDir) return result({ reason: 'source-unavailable' });
  const bindingExact = exactMergeBinding(
    repo,
    input.baseHead,
    input.candidateHead,
    input.mergeCommit,
  );

  const maxCommandTimeoutMs = boundedTimeout(
    options.maxCommandTimeoutMs,
    MAX_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
  );
  const maxTotalTimeoutMs = boundedTimeout(
    options.maxTotalTimeoutMs,
    DEFAULT_TOTAL_TIMEOUT_MS,
    MAX_TOTAL_TIMEOUT_MS,
  );
  const startedMs = nowMs(now);
  if (startedMs === null) return result({ reason: 'invalid-input' });

  let tempRoot: string;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  } catch {
    return result({ reason: 'worktree-create-failed' });
  }
  const tempIdentity = privateDirectoryIdentity(tempRoot);
  if (!tempIdentity) {
    return result({ reason: 'worktree-create-failed', cleanup: 'failed' });
  }

  const worktreePath = join(tempIdentity.path, 'worktree');
  const added = git(repo, ['worktree', 'add', '--detach', worktreePath, input.mergeCommit]);
  if (!added.ok) {
    const cleanup = safeCleanup(repo, worktreePath, tempIdentity, null);
    return result({ reason: 'worktree-create-failed', cleanup });
  }

  let expectedWorktree: string;
  try {
    expectedWorktree = realpathSync.native(worktreePath);
  } catch {
    return result({ reason: 'worktree-create-failed', cleanup: 'failed' });
  }

  const before = inspectIsolation(
    worktreePath,
    input.mergeCommit,
    expectedWorktree,
    sourceCommonDir,
  );
  if (!before || !before.clean || !before.detached) {
    const cleanup = safeCleanup(repo, worktreePath, tempIdentity, expectedWorktree);
    return result({ reason: 'isolation-lost', cleanup });
  }

  let commands: VerifyCommand[];
  try {
    commands = detectVerifyCommands(worktreePath, 'merge');
  } catch {
    const cleanup = safeCleanup(repo, worktreePath, tempIdentity, expectedWorktree);
    return result({ reason: 'manifest-unavailable', cleanup });
  }
  const manifest = buildRequiredVerificationManifest(worktreePath, commands);
  if (!manifest) {
    try {
      await options._beforeCleanup?.(worktreePath, tempIdentity.path);
    } catch {
      // The hook is an adversarial test seam; cleanup remains mandatory.
    }
    const cleanup = safeCleanup(repo, worktreePath, tempIdentity, expectedWorktree);
    return result({ reason: 'manifest-unavailable', cleanup });
  }

  let terminal: DetachedPostMergeRunnerTerminal = bindingExact ? 'pass' : 'unknown';
  let reason: DetachedPostMergeRunnerReason = bindingExact ? 'verified' : 'binding-mismatch';
  let failureCategory: VerifyFailureCategory | null = bindingExact ? null : 'infra';
  let commandsRun = 0;
  let isolationHealthy = true;

  for (let index = 0; bindingExact && index < commands.length; index += 1) {
    try {
      await options._beforeCommand?.(worktreePath, index);
    } catch {
      terminal = 'unknown';
      reason = 'verification-infrastructure';
      failureCategory = 'infra';
      break;
    }
    const preflight = inspectIsolation(
      worktreePath,
      input.mergeCommit,
      expectedWorktree,
      sourceCommonDir,
    );
    if (!preflight || !preflight.clean || !preflight.detached ||
      !exactCommit(repo, input.mergeCommit)) {
      terminal = 'unknown';
      reason = 'isolation-lost';
      isolationHealthy = false;
      break;
    }
    if (options.signal?.aborted) {
      terminal = 'unknown';
      reason = 'verification-infrastructure';
      failureCategory = 'cancelled';
      break;
    }
    const currentMs = nowMs(now);
    const elapsedMs = currentMs === null ? Number.NaN : currentMs - startedMs;
    const remainingMs = maxTotalTimeoutMs - elapsedMs;
    if (!Number.isFinite(remainingMs) || elapsedMs < 0 || remainingMs <= 0) {
      terminal = 'unknown';
      reason = elapsedMs >= 0 ? 'verification-timeout' : 'verification-infrastructure';
      failureCategory = elapsedMs >= 0 ? 'timeout' : 'infra';
      break;
    }

    const command = commands[index]!;
    const verification = await runVerifyCommandAsync(
      command,
      worktreePath,
      {} as AshlrConfig,
      {
        timeoutMs: commandTimeout(command, maxCommandTimeoutMs, remainingMs),
        signal: options.signal,
      },
    );
    commandsRun += 1;

    const postflight = inspectIsolation(
      worktreePath,
      input.mergeCommit,
      expectedWorktree,
      sourceCommonDir,
    );
    if (!postflight || !postflight.clean || !postflight.detached ||
      !exactCommit(repo, input.mergeCommit)) {
      terminal = 'unknown';
      reason = 'isolation-lost';
      isolationHealthy = false;
      break;
    }
    if (!verification.ok && command.required !== false) {
      failureCategory = verification.failureCategory ?? 'infra';
      if (failureCategory === 'code') {
        terminal = 'fail';
        reason = 'code-failure';
      } else {
        terminal = 'unknown';
        reason = failureCategory === 'timeout'
          ? 'verification-timeout'
          : 'verification-infrastructure';
      }
      break;
    }
  }

  const finalProof = inspectIsolation(
    worktreePath,
    input.mergeCommit,
    expectedWorktree,
    sourceCommonDir,
  );
  if (!finalProof || !finalProof.clean || !finalProof.detached) {
    terminal = 'unknown';
    reason = 'isolation-lost';
    isolationHealthy = false;
  }
  const verifiedAt = nowIso(now);
  if (verifiedAt === null) {
    terminal = 'unknown';
    reason = 'verification-infrastructure';
    failureCategory = 'infra';
  }

  try {
    await options._beforeCleanup?.(worktreePath, tempIdentity.path);
  } catch {
    terminal = 'unknown';
    reason = 'cleanup-failed';
    failureCategory = 'infra';
  }
  const cleanup = safeCleanup(repo, worktreePath, tempIdentity, expectedWorktree);
  if (cleanup !== 'removed') {
    terminal = 'unknown';
    reason = 'cleanup-failed';
  }
  const observedAt = nowIso(now);
  if (observedAt === null) {
    return result({
      terminal: 'unknown',
      reason: 'record-rejected',
      verifierManifestDigest: manifest.digest,
      requiredCommandCount: manifest.commandCount,
      commandsRun,
      failureCategory: failureCategory ?? 'infra',
      cleanup,
    });
  }
  let recordDisposition: ImmutablePrivateRecordWriteDisposition;
  try {
    recordDisposition = recordObservation({
      runnerInput: input,
      repo,
      manifest,
      sourceState: cleanup === 'removed' ? 'healthy' : 'degraded',
      terminal,
      failureCategory,
      verifiedHead: isolationHealthy && finalProof?.head === input.mergeCommit
        ? input.mergeCommit
        : null,
      verifiedAt: isolationHealthy ? verifiedAt : null,
      workspaceClean: isolationHealthy && finalProof?.clean === true,
      observedAt,
    });
  } catch {
    return result({
      terminal,
      reason: 'record-rejected',
      verifierManifestDigest: manifest.digest,
      requiredCommandCount: manifest.commandCount,
      commandsRun,
      failureCategory,
      cleanup,
    });
  }
  if (!['recorded', 'replayed'].includes(recordDisposition)) {
    return result({
      terminal,
      reason: 'record-rejected',
      verifierManifestDigest: manifest.digest,
      requiredCommandCount: manifest.commandCount,
      commandsRun,
      failureCategory,
      cleanup,
      recordDisposition,
    });
  }
  return result({
    terminal,
    reason,
    verifierManifestDigest: manifest.digest,
    requiredCommandCount: manifest.commandCount,
    commandsRun,
    failureCategory,
    cleanup,
    recordDisposition,
  });
}

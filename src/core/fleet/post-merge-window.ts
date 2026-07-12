import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isAbsolute, resolve } from 'node:path';

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const TOTAL_DEADLINE_MS = 15_000;
const METADATA_OUTPUT_BYTES = 64 * 1024;
const FILE_LIST_OUTPUT_BYTES = 512 * 1024;
const HISTORY_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_INVOCATIONS = 7;
const FOLLOWUP_SUBJECT_RE = /\b(fix|hotfix|revert)\b/i;
const MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;

export type PostMergeWindowInconclusiveReason =
  | 'invalid-input'
  | 'merge-missing'
  | 'merge-not-ancestor'
  | 'head-moved'
  | 'clock-skew'
  | 'timeout'
  | 'output-limit'
  | 'malformed-output'
  | 'git-error';

export interface PostMergeWindowInput {
  repo: string;
  mergeCommit: string;
  observedAtMs: number;
  followUpWindowMs: number;
  /** Authoritative host merge time when available; commit time is the legacy fallback. */
  windowStartedAtMs?: number;
}

export type PostMergeWindowAdverse =
  | {
      outcome: 'reverted';
      basis: 'git-revert-reference';
      confidence: 'deterministic';
      commit: string;
    }
  | {
      outcome: 'followed-up';
      basis: 'overlapping-fix';
      confidence: 'heuristic';
      commit: string;
    };

export type PostMergeWindowResult =
  | {
      state: 'complete';
      mergeCommit: string;
      observedHead: string;
      mergeTimeMs: number;
      windowStartedAtMs: number;
      followUpWindowEndMs: number;
      windowElapsed: boolean;
      commitsInspected: number;
      adverse: PostMergeWindowAdverse | null;
    }
  | {
      state: 'inconclusive';
      reason: PostMergeWindowInconclusiveReason;
      observedHead?: string;
    };

export interface PostMergeGitInvocation {
  repo: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export type PostMergeGitRunResult =
  | { ok: true; stdout: Buffer }
  | {
      ok: false;
      reason: 'timeout' | 'output-limit' | 'git-error';
      exitCode?: number;
    };

export type PostMergeGitRunner = (invocation: PostMergeGitInvocation) => PostMergeGitRunResult;

interface HistoryCommit {
  sha: string;
  committedAtMs: number;
  subject: string;
  body: string;
  pathKeys: Set<string>;
}

interface SuccessfulGitRun {
  stdout: Buffer;
}

class InspectionFailure extends Error {
  constructor(readonly reason: PostMergeWindowInconclusiveReason) {
    super(reason);
  }
}

function defaultGitRunner(invocation: PostMergeGitInvocation): PostMergeGitRunResult {
  try {
    const result = spawnSync('git', invocation.args, {
      cwd: invocation.repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
      windowsHide: true,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
      if (code === 'ENOBUFS') return { ok: false, reason: 'output-limit' };
      return { ok: false, reason: 'git-error' };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        reason: 'git-error',
        ...(typeof result.status === 'number' ? { exitCode: result.status } : {}),
      };
    }
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
    if (stdout.length > invocation.maxOutputBytes) return { ok: false, reason: 'output-limit' };
    return { ok: true, stdout };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
    if (code === 'ENOBUFS') return { ok: false, reason: 'output-limit' };
    return { ok: false, reason: 'git-error' };
  }
}

function exactAscii(buffer: Buffer): string | null {
  if (buffer.some((byte) => byte > 0x7f)) return null;
  return buffer.toString('ascii');
}

function exactUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function exactGitLine(buffer: Buffer): Buffer | null {
  if (buffer.length < 2 || buffer[buffer.length - 1] !== 0x0a) return null;
  const line = buffer.subarray(0, -1);
  return line.includes(0x0a) || line.includes(0x0d) ? null : line;
}

function splitNul(buffer: Buffer): Buffer[] | null {
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0) return null;
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

function parseShaField(buffer: Buffer): string | null {
  const text = exactAscii(buffer) ?? '';
  return GIT_SHA_RE.test(text) ? text : null;
}

function parseSingleSha(buffer: Buffer): string | null {
  const line = exactGitLine(buffer);
  return line ? parseShaField(line) : null;
}

function parseEpochSeconds(buffer: Buffer): number | null {
  const text = exactAscii(buffer) ?? '';
  if (!/^(0|[1-9]\d{0,12})$/.test(text)) return null;
  const milliseconds = Number(text) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function parseMergeMetadata(buffer: Buffer): { mergeTimeMs: number; firstParent: string | null } | null {
  const line = exactGitLine(buffer);
  if (!line) return null;
  const separator = line.indexOf(0);
  if (separator < 1 || line.indexOf(0, separator + 1) !== -1) return null;
  const mergeTimeMs = parseEpochSeconds(line.subarray(0, separator));
  const parentsText = exactAscii(line.subarray(separator + 1));
  if (mergeTimeMs === null || parentsText === null) return null;
  if (parentsText === '') return { mergeTimeMs, firstParent: null };
  const parents = parentsText.split(' ');
  if (parents.some((parent) => !GIT_SHA_RE.test(parent))) return null;
  return { mergeTimeMs, firstParent: parents[0]! };
}

function parsePathList(buffer: Buffer): Set<string> | null {
  if (buffer.length === 0) return new Set<string>();
  const fields = splitNul(buffer);
  if (!fields) return null;
  const paths = new Set<string>();
  for (const field of fields) {
    if (field.length === 0) return null;
    paths.add(field.toString('hex'));
  }
  return paths;
}

function parseHistory(buffer: Buffer): HistoryCommit[] | null {
  if (buffer.length === 0) return [];
  const fields = splitNul(buffer);
  if (!fields || fields.length < 6 || fields[0]?.length !== 0) return null;
  const commits: HistoryCommit[] = [];
  let index = 0;
  while (index < fields.length) {
    if (fields[index]?.length !== 0) return null;
    index += 1;
    if (index + 4 >= fields.length) return null;
    const sha = parseShaField(fields[index++]!);
    const committedAtMs = parseEpochSeconds(fields[index++]!);
    const subject = exactUtf8(fields[index++]!);
    const body = exactUtf8(fields[index++]!);
    if (!sha || committedAtMs === null || subject === null || body === null) return null;
    if (fields[index]?.length !== 0) return null;
    index += 1;

    const pathKeys = new Set<string>();
    let firstPath = true;
    while (index < fields.length && fields[index]!.length > 0) {
      let path = fields[index++]!;
      if (firstPath) {
        if (path[0] !== 0x0a) return null;
        path = path.subarray(1);
        firstPath = false;
      }
      if (path.length === 0) return null;
      pathKeys.add(path.toString('hex'));
    }
    commits.push({ sha, committedAtMs, subject, body, pathKeys });
  }
  return commits;
}

function failureResult(reason: PostMergeWindowInconclusiveReason, observedHead?: string): PostMergeWindowResult {
  return {
    state: 'inconclusive',
    reason,
    ...(observedHead ? { observedHead } : {}),
  };
}

/**
 * Inspect one immutable post-merge history snapshot. This function has no
 * ledger or policy side effects; callers decide whether returned evidence is
 * eligible for observational persistence.
 */
export function inspectPostMergeWindow(
  input: PostMergeWindowInput,
  options: { runGit?: PostMergeGitRunner; deadlineMs?: number } = {},
): PostMergeWindowResult {
  if (
    !input || typeof input.repo !== 'string' || input.repo.length === 0 || input.repo.length > 4_096 ||
    !isAbsolute(input.repo) || resolve(input.repo) !== input.repo ||
    [...input.repo].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    !GIT_SHA_RE.test(input.mergeCommit) ||
    !Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0 ||
    !Number.isSafeInteger(input.followUpWindowMs) || input.followUpWindowMs < 1 ||
    input.followUpWindowMs > MAX_WINDOW_MS ||
    (input.windowStartedAtMs !== undefined &&
      (!Number.isSafeInteger(input.windowStartedAtMs) || input.windowStartedAtMs < 0))
  ) return failureResult('invalid-input');

  const runGit = options.runGit ?? defaultGitRunner;
  const requestedDeadline = options.deadlineMs;
  const deadlineMs = typeof requestedDeadline === 'number' && Number.isFinite(requestedDeadline)
    ? Math.max(1, Math.min(TOTAL_DEADLINE_MS, Math.floor(requestedDeadline)))
    : TOTAL_DEADLINE_MS;
  const deadline = performance.now() + deadlineMs;
  let invocations = 0;
  let observedHead: string | undefined;

  const invoke = (args: readonly string[], maxOutputBytes: number): PostMergeGitRunResult => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1 || invocations >= MAX_GIT_INVOCATIONS) throw new InspectionFailure('timeout');
    invocations += 1;
    const result = runGit({
      repo: input.repo,
      args,
      timeoutMs: Math.max(1, Math.min(deadlineMs, remaining)),
      maxOutputBytes,
    });
    if (performance.now() > deadline) throw new InspectionFailure('timeout');
    if (result.ok && !Buffer.isBuffer(result.stdout)) throw new InspectionFailure('malformed-output');
    if (result.ok && result.stdout.length > maxOutputBytes) {
      return { ok: false, reason: 'output-limit' };
    }
    return result;
  };

  const run = (args: readonly string[], maxOutputBytes: number): SuccessfulGitRun => {
    const result = invoke(args, maxOutputBytes);
    if (!result.ok) throw new InspectionFailure(result.reason);
    return result;
  };

  try {
    const headBefore = parseSingleSha(run(['rev-parse', '--verify', 'HEAD^{commit}'], METADATA_OUTPUT_BYTES).stdout);
    if (!headBefore) return failureResult('malformed-output');
    observedHead = headBefore;

    const mergeLookup = invoke(
      ['rev-parse', '--verify', `${input.mergeCommit}^{commit}`],
      METADATA_OUTPUT_BYTES,
    );
    if (!mergeLookup.ok) {
      return failureResult(
        mergeLookup.reason === 'git-error' && typeof mergeLookup.exitCode === 'number'
          ? 'merge-missing'
          : mergeLookup.reason,
        observedHead,
      );
    }
    const canonicalMerge = parseSingleSha(mergeLookup.stdout);
    if (canonicalMerge !== input.mergeCommit) return failureResult('merge-missing', observedHead);

    const ancestry = invoke(
      ['merge-base', '--is-ancestor', canonicalMerge, headBefore],
      METADATA_OUTPUT_BYTES,
    );
    if (!ancestry.ok) {
      if (ancestry.reason === 'git-error' && ancestry.exitCode === 1) {
        return failureResult('merge-not-ancestor', observedHead);
      }
      return failureResult(ancestry.reason, observedHead);
    }
    if (ancestry.stdout.length !== 0) return failureResult('malformed-output', observedHead);

    const mergeMetadata = parseMergeMetadata(run(
      ['show', '-s', '--format=%ct%x00%P', canonicalMerge],
      METADATA_OUTPUT_BYTES,
    ).stdout);
    if (!mergeMetadata) return failureResult('malformed-output', observedHead);
    const { mergeTimeMs } = mergeMetadata;
    const windowStartedAtMs = input.windowStartedAtMs ?? mergeTimeMs;
    if (input.observedAtMs < mergeTimeMs || input.observedAtMs < windowStartedAtMs) {
      return failureResult('clock-skew', observedHead);
    }
    const followUpWindowEndMs = windowStartedAtMs + input.followUpWindowMs;
    if (!Number.isSafeInteger(followUpWindowEndMs)) return failureResult('invalid-input', observedHead);

    const mergedPathArgs = mergeMetadata.firstParent
      ? ['diff', '--name-only', '-z', '--no-renames', mergeMetadata.firstParent, canonicalMerge]
      : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', '--no-renames', canonicalMerge];
    const mergedPaths = parsePathList(run(mergedPathArgs, FILE_LIST_OUTPUT_BYTES).stdout);
    if (!mergedPaths) return failureResult('malformed-output', observedHead);

    const history = parseHistory(run([
      'log', '-z', '--no-renames',
      '--format=%x00%H%x00%ct%x00%s%x00%B%x00',
      '--name-only', `${canonicalMerge}..${headBefore}`,
    ], HISTORY_OUTPUT_BYTES).stdout);
    if (!history) return failureResult('malformed-output', observedHead);

    const headAfter = parseSingleSha(run(['rev-parse', '--verify', 'HEAD^{commit}'], METADATA_OUTPUT_BYTES).stdout);
    if (!headAfter) return failureResult('malformed-output', observedHead);
    if (headAfter !== headBefore) return failureResult('head-moved', observedHead);

    const revertNeedles = new Set([
      `This reverts commit ${canonicalMerge}`,
      `This reverts commit ${canonicalMerge}.`,
    ]);
    const reverted = history.find((commit) =>
      commit.body.split('\n').some((line) => revertNeedles.has(line)));
    let adverse: PostMergeWindowAdverse | null = reverted
      ? {
          outcome: 'reverted',
          basis: 'git-revert-reference',
          confidence: 'deterministic',
          commit: reverted.sha,
        }
      : null;
    if (!adverse && mergedPaths.size > 0) {
      const heuristicCutoff = Math.min(followUpWindowEndMs, input.observedAtMs);
      const followedUp = [...history].reverse().find((commit) =>
        commit.committedAtMs >= mergeTimeMs && commit.committedAtMs <= heuristicCutoff &&
        FOLLOWUP_SUBJECT_RE.test(commit.subject) &&
        [...commit.pathKeys].some((path) => mergedPaths.has(path)));
      if (followedUp) {
        adverse = {
          outcome: 'followed-up',
          basis: 'overlapping-fix',
          confidence: 'heuristic',
          commit: followedUp.sha,
        };
      }
    }

    return {
      state: 'complete',
      mergeCommit: canonicalMerge,
      observedHead: headBefore,
      mergeTimeMs,
      windowStartedAtMs,
      followUpWindowEndMs,
      windowElapsed: input.observedAtMs >= followUpWindowEndMs,
      commitsInspected: history.length,
      adverse,
    };
  } catch (error) {
    if (error instanceof InspectionFailure) return failureResult(error.reason, observedHead);
    return failureResult('git-error', observedHead);
  }
}

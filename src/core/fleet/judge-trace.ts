/**
 * M141: Judge trace store — append-only JSONL sink for the full CoT reasoning
 * produced by the manager judge on every proposal.
 *
 * Writes to ~/.ashlr/judge-traces/YYYY-MM-DD.jsonl — one JudgeTrace per line.
 * Mirrors decisions-ledger.ts conventions:
 *   - Append-only; never truncate/rewrite/delete.
 *   - Secret-scrubbed before write.
 *   - recordJudgeTrace() never throws.
 *   - readJudgeTraces() preserves the legacy array API while detailed reads
 *     expose bounded source quality and completeness.
 *   - linkOutcome() appends an immutable patch record; reads materialize the
 *     newest patch onto exactly one logical trace.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { scrubSecrets } from '../util/scrub.js';
import type { Proposal } from '../types.js';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import {
  POST_MERGE_CREDIT_RELEASE_LABEL,
  hasReleasedPostMergeCredit,
} from './post-merge-credit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JudgeOutcome = 'merged' | 'reverted' | 'rejected' | 'followed-up';
export const REALIZED_MERGE_OUTCOME_BASIS = 'realized-merge-v1' as const;
export const RELEASED_MERGE_OUTCOME_BASIS = POST_MERGE_CREDIT_RELEASE_LABEL;
export const PROPOSAL_REJECTION_OUTCOME_BASIS = 'proposal-rejection-v1' as const;
export const POST_MERGE_OBSERVATION_OUTCOME_BASIS = 'post-merge-observation-v1' as const;
export type JudgeOutcomeBasis =
  | typeof REALIZED_MERGE_OUTCOME_BASIS
  | typeof RELEASED_MERGE_OUTCOME_BASIS
  | typeof PROPOSAL_REJECTION_OUTCOME_BASIS
  | typeof POST_MERGE_OBSERVATION_OUTCOME_BASIS;
export interface JudgeOutcomeQualification {
  basis: JudgeOutcomeBasis;
}
export interface RealizedMergeOutcomeQualification {
  basis: typeof REALIZED_MERGE_OUTCOME_BASIS | typeof RELEASED_MERGE_OUTCOME_BASIS;
}
export interface ProposalRejectionOutcomeQualification {
  basis: typeof PROPOSAL_REJECTION_OUTCOME_BASIS;
}
export interface PostMergeObservationOutcomeQualification {
  basis: typeof POST_MERGE_OBSERVATION_OUTCOME_BASIS;
}
// M332: 'followed-up' — the merge survived but a near-term fix commit touched
// the same files (detected by outcome-watcher.ts). Weaker negative signal
// than 'reverted'; maps to intent 'review' in calibration.

export interface JudgeTrace {
  /** Stable identity used by append-only outcome patches. */
  traceId?: string;
  /** Proposal id this trace belongs to. */
  proposalId: string;
  /** Model/engine that produced the verdict (e.g. 'claude-sonnet-4-5'). */
  judgeEngine: string;
  /** Parsed verdict: ship | review | noise | harmful. */
  verdict: 'ship' | 'review' | 'noise' | 'harmful';
  /** Dimension scores (clamped 1-5). */
  scores: {
    value: number;
    correctness: number;
    scope: number;
    alignment: number;
  };
  /**
   * Full chain-of-thought reasoning text extracted from the judge response
   * (the prose that precedes the verdict JSON). May be empty string when
   * the judge emitted no prose before the JSON block.
   */
  fullReasoning: string;
  /**
   * Snapshot of the prompt context sent to the judge (title, summary, kind,
   * engine, optional vision section — NOT the full diff to keep the file lean).
   */
  promptContext: string;
  /** ISO timestamp of when the trace was recorded. */
  ts: string;
  /**
   * Real-world outcome, populated later via linkOutcome().
   * undefined until the proposal is merged/reverted/rejected.
   */
  outcome?: JudgeOutcome;
  /**
   * Closed provenance label for outcome authority. Legacy rows omit this field
   * and remain readable for forensics, but an unqualified `merged` outcome is
   * never eligible for success, calibration, or learning credit.
   */
  outcomeBasis?: JudgeOutcomeBasis;
  /** ISO timestamp when linkOutcome() was called. */
  outcomeAt?: string;
  /** Internal append-only patch marker; omitted from materialized reads. */
  _patchForTraceId?: string;
  /** Legacy patch provenance retained for backward-compatible reads. */
  _patchFor?: string;
}

const DEFAULT_MAX_FILES = 1_024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 100_000;
const HARD_MAX_FILES = 1_024;
const HARD_MAX_BYTES = 256 * 1024 * 1024;
const HARD_MAX_ROWS = 1_000_000;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_ROW_BYTES = 128 * 1024;
const MAX_FUTURE_SKEW_MS = 60_000;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const VERDICTS = new Set<JudgeTrace['verdict']>(['ship', 'review', 'noise', 'harmful']);
const OUTCOMES = new Set<JudgeOutcome>(['merged', 'reverted', 'rejected', 'followed-up']);
const OUTCOME_BASES = new Set<JudgeOutcomeBasis>([
  REALIZED_MERGE_OUTCOME_BASIS,
  RELEASED_MERGE_OUTCOME_BASIS,
  PROPOSAL_REJECTION_OUTCOME_BASIS,
  POST_MERGE_OBSERVATION_OUTCOME_BASIS,
]);

export interface ReadJudgeTracesOptions {
  proposalId?: string;
  verdict?: JudgeTrace['verdict'];
  sinceMs?: number;
  limit?: number;
  outcomeOnly?: boolean;
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  requireComplete?: boolean;
}

export type JudgeTraceReadStopReason =
  | 'file-limit'
  | 'byte-limit'
  | 'row-limit'
  | 'io-error'
  | 'conflicting-row';

export interface JudgeTraceSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: JudgeTraceReadStopReason[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface JudgeTracesReadResult extends JudgeTraceSourceQuality {
  traces: JudgeTrace[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the judge-traces directory: ~/.ashlr/judge-traces. */
export function judgeTracesDir(): string {
  const configured = process.env.ASHLR_HOME;
  const root = typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
  return join(root, 'judge-traces');
}

// ---------------------------------------------------------------------------
// Secret scrubbing — delegates to shared scrubSecrets (src/core/util/scrub.ts)
// ---------------------------------------------------------------------------

function scrubTrace(trace: JudgeTrace): JudgeTrace {
  return {
    ...trace,
    fullReasoning: scrubSecrets(trace.fullReasoning).slice(0, 32_000),
    promptContext: scrubSecrets(trace.promptContext).slice(0, 16_000),
  };
}

function ownedByCurrentUser(stat: ReturnType<typeof fstatSync>): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

export function isSafeJudgeTraceFile(
  stat: ReturnType<typeof fstatSync>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && Number(stat.nlink) === 1 &&
    ownedByCurrentUser(stat) && (platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

export function isSafeJudgeTraceDirectory(
  stat: ReturnType<typeof fstatSync>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && ownedByCurrentUser(stat) &&
    (platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function appendTraceLine(path: string, line: string): boolean {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length > MAX_ROW_BYTES) return false;
  let fd: number | undefined;
  try {
    const directoryBefore = lstatSync(dirname(path));
    if (!isSafeJudgeTraceDirectory(directoryBefore)) return false;
    let pathBefore: ReturnType<typeof lstatSync> | undefined;
    try {
      pathBefore = lstatSync(path);
      if (!isSafeJudgeTraceFile(pathBefore)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
        (pathBefore ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    const stat = fstatSync(fd);
    if (!isSafeJudgeTraceFile(stat) || (pathBefore && !sameFile(pathBefore, stat))) return false;
    fchmodSync(fd, 0o600);
    if (stat.size > 0) {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, Number(stat.size) - 1) !== 1) return false;
      if (tail[0] !== 0x0a) writeAll(fd, Buffer.from('\n'));
    }
    writeAll(fd, bytes);
    const pathAfter = lstatSync(path);
    const directoryAfter = lstatSync(dirname(path));
    if (
      !isSafeJudgeTraceFile(pathAfter) || !sameFile(stat, pathAfter) ||
      !isSafeJudgeTraceDirectory(directoryAfter) || !sameFile(directoryBefore, directoryAfter)
    ) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort telemetry append */ }
    }
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('judge trace append made no progress');
    offset += written;
  }
}

// ---------------------------------------------------------------------------
// Public: recordJudgeTrace()
// ---------------------------------------------------------------------------

/**
 * Append one JudgeTrace to today's JSONL file under ~/.ashlr/judge-traces/.
 * Sets `ts` to current ISO timestamp when not provided.
 *
 * Append-only. Never throws.
 */
export function recordJudgeTrace(trace: Omit<JudgeTrace, 'ts'> & { ts?: string }): void {
  try {
    const dir = judgeTracesDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const directory = lstatSync(dir);
    if (!isSafeJudgeTraceDirectory(directory)) return;
    chmodSync(dir, 0o700);

    const record: JudgeTrace = scrubTrace({
      ...trace,
      ts: (() => {
        const value = trace.ts ?? new Date().toISOString();
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
      })(),
      traceId: trace.traceId ?? `jt-${randomUUID()}`,
    } as JudgeTrace);
    if (!record.ts) return;
    if (record.outcome !== undefined && !OUTCOMES.has(record.outcome)) return;
    // Positive merged outcomes are reserved for the future proof-bound release
    // writer. This generic trace API may record predictions and adverse facts.
    if (record.outcome === 'merged') return;
    if (record.outcomeBasis !== undefined &&
      (!OUTCOME_BASES.has(record.outcomeBasis) || record.outcome === undefined ||
        !isOutcomeBasisCompatible(record.outcome, record.outcomeBasis))) return;

    const line = JSON.stringify(record) + '\n';
    const filePath = join(dir, `${record.ts.slice(0, 10)}.jsonl`);
    appendTraceLine(filePath, line);
  } catch {
    // Intentionally swallowed: trace store must never disrupt the caller's flow.
  }
}

// ---------------------------------------------------------------------------
// Public: readJudgeTraces()
// ---------------------------------------------------------------------------

/**
 * Read judge traces, newest-first.
 *
 * Options:
 *   proposalId — filter to a specific proposal id
 *   verdict    — filter to a specific verdict
 *   sinceMs    — exclude entries older than this epoch ms
 *   limit      — cap total returned (0 or undefined = all)
 *   outcomeOnly — when true, only return traces that have an outcome set
 *
 * Malformed JSONL lines are silently skipped. Never throws.
 */
function bounded(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyTraceRead(
  sourceState: JudgeTraceSourceQuality['sourceState'],
  overrides: Partial<JudgeTracesReadResult> = {},
): JudgeTracesReadResult {
  return {
    traces: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function pushStopReason(reasons: JudgeTraceReadStopReason[], reason: JudgeTraceReadStopReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readTraceFile(
  path: string,
  maxBytes: number,
): { ok: true; text: string; bytesRead: number } | { ok: false; reason: 'byte-limit' | 'io-error' } {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (!isSafeJudgeTraceFile(pathBefore)) {
      return { ok: false, reason: 'io-error' };
    }
    if (Number(pathBefore.size) > maxBytes) return { ok: false, reason: 'byte-limit' };
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!isSafeJudgeTraceFile(before) || !sameFile(pathBefore, before)) {
      return { ok: false, reason: 'io-error' };
    }
    const size = Number(before.size);
    if (size > maxBytes) return { ok: false, reason: 'byte-limit' };
    const buffer = Buffer.alloc(size);
    const bytesRead = size > 0 ? readSync(fd, buffer, 0, size, 0) : 0;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !isSafeJudgeTraceFile(after) ||
      !sameFile(before, after) ||
      !sameFile(after, pathAfter) ||
      Number(after.size) !== size ||
      bytesRead !== size
    ) return { ok: false, reason: 'io-error' };
    return { ok: true, text: buffer.toString('utf8'), bytesRead };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort trace read */ }
    }
  }
}

function validScores(value: unknown): value is JudgeTrace['scores'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scores = value as Record<string, unknown>;
  return ['value', 'correctness', 'scope', 'alignment'].every((key) =>
    typeof scores[key] === 'number' &&
    Number.isFinite(scores[key]) &&
    Number(scores[key]) >= 1 &&
    Number(scores[key]) <= 5);
}

function isOutcomeBasisCompatible(
  outcome: JudgeOutcome,
  basis: JudgeOutcomeBasis | undefined,
): boolean {
  if (basis === undefined) return outcome !== 'merged';
  if (outcome === 'merged') return basis === RELEASED_MERGE_OUTCOME_BASIS;
  if (outcome === 'rejected') return basis === PROPOSAL_REJECTION_OUTCOME_BASIS;
  return basis === POST_MERGE_OBSERVATION_OUTCOME_BASIS;
}

function isOutcomeBasisStructurallyCompatible(
  outcome: JudgeOutcome,
  basis: JudgeOutcomeBasis,
): boolean {
  if (outcome === 'merged') {
    return basis === REALIZED_MERGE_OUTCOME_BASIS || basis === RELEASED_MERGE_OUTCOME_BASIS;
  }
  return isOutcomeBasisCompatible(outcome, basis);
}

function parseTraceRow(value: unknown, fileDate: string): JudgeTrace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const patch = typeof obj['_patchForTraceId'] === 'string' || typeof obj['_patchFor'] === 'string';
  if (
    typeof obj['proposalId'] !== 'string' ||
    typeof obj['judgeEngine'] !== 'string' ||
    typeof obj['verdict'] !== 'string' ||
    !VERDICTS.has(obj['verdict'] as JudgeTrace['verdict']) ||
    typeof obj['ts'] !== 'string' ||
    !Number.isFinite(Date.parse(obj['ts'])) ||
    typeof obj['fullReasoning'] !== 'string' ||
    typeof obj['promptContext'] !== 'string' ||
    (!patch && !validScores(obj['scores']))
  ) return null;
  const now = Date.now();
  if (Date.parse(obj['ts'] as string) > now + MAX_FUTURE_SKEW_MS) return null;
  if (obj['outcome'] !== undefined && !OUTCOMES.has(obj['outcome'] as JudgeOutcome)) return null;
  if (obj['outcomeBasis'] !== undefined &&
    (typeof obj['outcomeBasis'] !== 'string' ||
      !OUTCOME_BASES.has(obj['outcomeBasis'] as JudgeOutcomeBasis))) return null;
  if (obj['outcomeBasis'] !== undefined &&
    (obj['outcome'] === undefined ||
      !isOutcomeBasisStructurallyCompatible(
        obj['outcome'] as JudgeOutcome,
        obj['outcomeBasis'] as JudgeOutcomeBasis,
      ))) return null;
  if (obj['outcomeAt'] !== undefined &&
    (typeof obj['outcomeAt'] !== 'string' || !Number.isFinite(Date.parse(obj['outcomeAt'])))) return null;
  if (typeof obj['outcomeAt'] === 'string' &&
    Date.parse(obj['outcomeAt']) > now + MAX_FUTURE_SKEW_MS) return null;
  const physicalDate = patch && typeof obj['outcomeAt'] === 'string'
    ? obj['outcomeAt'].slice(0, 10)
    : obj['ts'].slice(0, 10);
  if (physicalDate !== fileDate) return null;
  return scrubTrace(obj as unknown as JudgeTrace);
}

function traceKey(trace: JudgeTrace): string {
  return trace.traceId ?? `${trace.proposalId}|${trace.ts}|${trace.judgeEngine}`;
}

export function readJudgeTracesDetailed(filter: ReadJudgeTracesOptions = {}): JudgeTracesReadResult {
  try {
    const maxFiles = bounded(filter.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES);
    const maxBytes = bounded(filter.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    const maxRows = bounded(filter.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
    const dir = judgeTracesDir();
    if (!existsSync(dir)) return emptyTraceRead('missing');
    const dirBefore = lstatSync(dir);
    if (!isSafeJudgeTraceDirectory(dirBefore)) {
      return emptyTraceRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }

    let files: string[];
    try {
      const handle = opendirSync(dir);
      const selected: string[] = [];
      let seen = 0;
      let invalidPartition = false;
      try {
        let entry = handle.readSync();
        while (entry !== null) {
          seen++;
          if (seen > MAX_DIRECTORY_ENTRIES) {
            return emptyTraceRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['file-limit'] });
          }
          if (entry.name.endsWith('.jsonl')) {
            const match = DATE_FILE_RE.exec(entry.name);
            if (!match) invalidPartition = true;
            else {
              selected.push(entry.name);
            }
          }
          entry = handle.readSync();
        }
      } finally {
        handle.closeSync();
      }
      if (invalidPartition) {
        return emptyTraceRead('degraded', {
          sourcePresent: true,
          complete: false,
          stopReasons: ['io-error'],
          unreadableFiles: 1,
        });
      }
      files = selected.sort().reverse();
    } catch {
      return emptyTraceRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }

    const result = emptyTraceRead('healthy');
    result.sourcePresent = true;
    const physical: JudgeTrace[] = [];

    for (const file of files) {
      if (result.filesRead >= maxFiles) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        break;
      }
      const remaining = maxBytes - result.bytesRead;
      if (remaining <= 0) {
        pushStopReason(result.stopReasons, 'byte-limit');
        result.complete = false;
        break;
      }
      const loaded = readTraceFile(join(dir, file), remaining);
      result.filesRead++;
      if (!loaded.ok) {
        if (loaded.reason === 'io-error') result.unreadableFiles++;
        pushStopReason(result.stopReasons, loaded.reason);
        result.complete = false;
        break;
      }
      result.bytesRead += loaded.bytesRead;
      const fileDate = DATE_FILE_RE.exec(file)?.[1] ?? '';
      for (const line of loaded.text.split('\n').reverse()) {
        if (!line.trim()) continue;
        if (result.rowsScanned >= maxRows) {
          pushStopReason(result.stopReasons, 'row-limit');
          result.complete = false;
          break;
        }
        result.rowsScanned++;
        if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) {
          result.invalidRows++;
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          const trace = parseTraceRow(parsed, fileDate);
          if (!trace) result.invalidRows++;
          else physical.push(trace);
        } catch {
          result.invalidRows++;
        }
      }
      if (!result.complete) break;
    }
    try {
      const dirAfter = lstatSync(dir);
      if (!isSafeJudgeTraceDirectory(dirAfter) || !sameFile(dirBefore, dirAfter) ||
        dirBefore.mtimeMs !== dirAfter.mtimeMs || dirBefore.ctimeMs !== dirAfter.ctimeMs) {
        pushStopReason(result.stopReasons, 'io-error');
        result.complete = false;
        result.unreadableFiles++;
      }
    } catch {
      pushStopReason(result.stopReasons, 'io-error');
      result.complete = false;
      result.unreadableFiles++;
    }

    const patches = new Map<string, Pick<JudgeTrace, 'outcome' | 'outcomeAt' | 'outcomeBasis'>>();
    const baseRows = new Map<string, JudgeTrace>();
    let conflictingRows = false;
    for (const trace of physical) {
      const patchTarget = trace._patchForTraceId ?? (trace._patchFor ? traceKey(trace) : undefined);
      if (patchTarget) {
        const candidate = {
          outcome: trace.outcome,
          outcomeAt: trace.outcomeAt,
          outcomeBasis: trace.outcomeBasis,
        };
        const existing = patches.get(patchTarget);
        if (existing === undefined) {
          patches.set(patchTarget, candidate);
        } else if (JSON.stringify(existing) !== JSON.stringify(candidate)) {
          conflictingRows = true;
        }
        continue;
      }
      const key = traceKey(trace);
      const existing = baseRows.get(key);
      if (existing === undefined) baseRows.set(key, trace);
      else if (JSON.stringify(existing) !== JSON.stringify(trace)) conflictingRows = true;
    }
    if (conflictingRows) {
      pushStopReason(result.stopReasons, 'conflicting-row');
      result.complete = false;
    }
    for (const trace of baseRows.values()) {
      const patch = patches.get(traceKey(trace));
      const materialized: JudgeTrace = { ...trace, ...(patch ?? {}) };
      delete materialized._patchFor;
      delete materialized._patchForTraceId;
      const eventMs = Date.parse(materialized.outcomeAt ?? materialized.ts);
      if (filter.sinceMs !== undefined && eventMs < filter.sinceMs) continue;
      if (filter.proposalId !== undefined && materialized.proposalId !== filter.proposalId) continue;
      if (filter.verdict !== undefined && materialized.verdict !== filter.verdict) continue;
      if (filter.outcomeOnly === true && !materialized.outcome) continue;
      result.traces.push(materialized);
    }
    if (!result.complete) result.sourceState = 'degraded';
    result.traces.sort((a, b) => Date.parse(b.outcomeAt ?? b.ts) - Date.parse(a.outcomeAt ?? a.ts));
    if (typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0) {
      result.traces = result.traces.slice(0, Math.floor(filter.limit));
    }
    if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.sourceState = 'degraded';
      result.complete = false;
    }
    return result;
  } catch {
    return emptyTraceRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
  }
}

export function readJudgeTraces(filter: ReadJudgeTracesOptions = {}): JudgeTrace[] {
  const result = readJudgeTracesDetailed(filter);
  const traces = filter.requireComplete === true && (!result.complete || result.sourceState === 'degraded')
    ? []
    : result.traces;
  Object.defineProperty(traces, 'sourceQuality', {
    value: {
      sourceState: result.sourceState,
      sourcePresent: result.sourcePresent,
      complete: result.complete,
      stopReasons: result.stopReasons,
      filesRead: result.filesRead,
      bytesRead: result.bytesRead,
      rowsScanned: result.rowsScanned,
      invalidRows: result.invalidRows,
      unreadableFiles: result.unreadableFiles,
    } satisfies JudgeTraceSourceQuality,
    enumerable: false,
  });
  return traces;
}

/** True only when a merged label carries explicit post-merge credit release. */
export function isQualifiedMergedJudgeOutcome<
  T extends Pick<JudgeTrace, 'outcome' | 'outcomeBasis'>,
>(trace: T): trace is T & {
  outcome: 'merged';
  outcomeBasis: typeof RELEASED_MERGE_OUTCOME_BASIS;
} {
  return trace.outcome === 'merged' &&
    trace.outcomeBasis === RELEASED_MERGE_OUTCOME_BASIS &&
    hasReleasedPostMergeCredit(trace.outcomeBasis);
}

/**
 * Adverse outcomes retain their historical semantics. A positive merged label
 * is authoritative only when it is explicitly bound to a post-merge credit release.
 */
export function isQualifiedJudgeOutcome<
  T extends Pick<JudgeTrace, 'outcome' | 'outcomeBasis'>,
>(trace: T): trace is T & { outcome: JudgeOutcome } {
  if (trace.outcome === undefined || !OUTCOMES.has(trace.outcome)) return false;
  if (trace.outcomeBasis !== undefined && !OUTCOME_BASES.has(trace.outcomeBasis)) return false;
  if (trace.outcome === 'merged') return isQualifiedMergedJudgeOutcome(trace);
  return isOutcomeBasisCompatible(trace.outcome, trace.outcomeBasis);
}

export interface JudgeProposalSource {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  proposals: readonly Proposal[];
}

/**
 * Resolve one positive judge label to its persisted proposal authority.
 * Caller-supplied basis strings are never sufficient: the proposal source must
 * be complete and the exact linked proposal must carry a current authenticated
 * realized-merge witness whose observation is not in the future.
 */
export function qualifiedMergedProposal(
  proposalId: string,
  source: JudgeProposalSource,
  qualificationAtMs = Date.now(),
): Proposal | null {
  if (!proposalId || source.sourceState !== 'healthy' || source.complete !== true ||
    !Array.isArray(source.proposals) || !Number.isFinite(qualificationAtMs)) return null;
  const matches = source.proposals.filter((proposal) => proposal.id === proposalId);
  if (matches.length !== 1) return null;
  const proposal = matches[0]!;
  const witness = authenticatedRealizedMergeOf(proposal);
  if (!witness) return null;
  const witnessedAt = witness.source === 'local-default-branch'
    ? witness.observedAt
    : witness.reconciliation.observedAt;
  const witnessedAtMs = Date.parse(witnessedAt);
  return Number.isFinite(witnessedAtMs) && witnessedAtMs <= qualificationAtMs
    ? proposal
    : null;
}

// ---------------------------------------------------------------------------
// Public: linkOutcome()
// ---------------------------------------------------------------------------

/**
 * Attach a real-world outcome to a previously recorded trace.
 *
 * Scans a complete bounded source, selects the newest judgment by trace time,
 * and appends an idempotent outcome patch targeting its stable trace id.
 *
 * Never throws.
 */
export type LinkJudgeOutcomeResult =
  | { status: 'linked' | 'already-linked'; traceId?: string }
  | { status: 'not-found' | 'degraded' | 'write-failed' | 'unqualified' };

export function linkOutcomeResult(
  proposalId: string,
  outcome: 'merged',
  qualification: RealizedMergeOutcomeQualification,
): LinkJudgeOutcomeResult;
export function linkOutcomeResult(
  proposalId: string,
  outcome: 'rejected',
  qualification?: ProposalRejectionOutcomeQualification,
): LinkJudgeOutcomeResult;
export function linkOutcomeResult(
  proposalId: string,
  outcome: 'reverted' | 'followed-up',
  qualification?: PostMergeObservationOutcomeQualification,
): LinkJudgeOutcomeResult;
export function linkOutcomeResult(
  proposalId: string,
  outcome: JudgeOutcome,
  qualification?: JudgeOutcomeQualification,
): LinkJudgeOutcomeResult {
  try {
    // The generic trace writer is not release authority. A future dedicated
    // release worker must verify the protected-base proof before it can append
    // positive outcome credit; accepting a caller-supplied label here would
    // make the firewall forgeable.
    if (outcome === 'merged') return { status: 'unqualified' };
    if (!isOutcomeBasisCompatible(outcome, qualification?.basis)) {
      return { status: 'unqualified' };
    }
    const dir = judgeTracesDir();
    if (!existsSync(dir)) return { status: 'not-found' };
    const read = readJudgeTracesDetailed({ proposalId });
    if (read.sourceState === 'degraded' || !read.complete) return { status: 'degraded' };
    const target = [...read.traces].sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))[0];
    if (!target) return { status: 'not-found' };
    const outcomeBasis = qualification?.basis;
    if (target.outcome === outcome && target.outcomeBasis === outcomeBasis) {
      return { status: 'already-linked', ...(target.traceId ? { traceId: target.traceId } : {}) };
    }
    const outcomeAt = new Date().toISOString();
    const patch: JudgeTrace = {
      proposalId,
      judgeEngine: target.judgeEngine,
      verdict: target.verdict,
      scores: target.scores,
      fullReasoning: '',
      promptContext: '',
      ts: target.ts,
      outcome,
      outcomeAt,
      ...(outcomeBasis ? { outcomeBasis } : {}),
      ...(target.traceId
        ? { _patchForTraceId: target.traceId }
        : { _patchFor: `${target.proposalId}|${target.ts}|${target.judgeEngine}` }),
    };
    const ok = appendTraceLine(
      join(dir, `${outcomeAt.slice(0, 10)}.jsonl`),
      JSON.stringify(patch) + '\n',
    );
    return ok
      ? { status: 'linked', ...(target.traceId ? { traceId: target.traceId } : {}) }
      : { status: 'write-failed' };
  } catch {
    return { status: 'degraded' };
  }
}

export function linkOutcome(
  proposalId: string,
  outcome: 'merged',
  qualification: RealizedMergeOutcomeQualification,
): void;
export function linkOutcome(
  proposalId: string,
  outcome: 'rejected',
  qualification?: ProposalRejectionOutcomeQualification,
): void;
export function linkOutcome(
  proposalId: string,
  outcome: 'reverted' | 'followed-up',
  qualification?: PostMergeObservationOutcomeQualification,
): void;
export function linkOutcome(
  proposalId: string,
  outcome: JudgeOutcome,
  qualification?: JudgeOutcomeQualification,
): void {
  if (outcome === 'merged') {
    void linkOutcomeResult(proposalId, outcome, qualification as RealizedMergeOutcomeQualification);
    return;
  }
  if (outcome === 'rejected') {
    void linkOutcomeResult(proposalId, outcome, qualification as ProposalRejectionOutcomeQualification);
    return;
  }
  void linkOutcomeResult(
    proposalId,
    outcome,
    qualification as PostMergeObservationOutcomeQualification,
  );
}

// ---------------------------------------------------------------------------
// Public: outcomeStats()
// ---------------------------------------------------------------------------

/**
 * Compute outcome-link coverage across all traces.
 * Returns { total, withOutcome, outcomeRate, byVerdict, byOutcome }.
 * Never throws.
 */
export function outcomeStats(): {
  total: number;
  withOutcome: number;
  outcomeRate: number;
  byVerdict: Record<string, { total: number; withOutcome: number }>;
  byOutcome: Record<string, number>;
} {
  const zero = () => ({ total: 0, withOutcome: 0 });
  try {
    const read = readJudgeTracesDetailed();
    if (read.sourceState === 'degraded' || !read.complete) {
      return { total: 0, withOutcome: 0, outcomeRate: 0, byVerdict: {}, byOutcome: {} };
    }
    const traces = read.traces;
    const byVerdict: Record<string, { total: number; withOutcome: number }> = {};
    const byOutcome: Record<string, number> = {};

    for (const t of traces) {
      if (!byVerdict[t.verdict]) byVerdict[t.verdict] = zero();
      byVerdict[t.verdict]!.total++;
      if (isQualifiedJudgeOutcome(t)) {
        byVerdict[t.verdict]!.withOutcome++;
        byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
      }
    }

    const total = traces.length;
    const withOutcome = traces.filter(isQualifiedJudgeOutcome).length;
    return {
      total,
      withOutcome,
      outcomeRate: total > 0 ? withOutcome / total : 0,
      byVerdict,
      byOutcome,
    };
  } catch {
    return { total: 0, withOutcome: 0, outcomeRate: 0, byVerdict: {}, byOutcome: {} };
  }
}

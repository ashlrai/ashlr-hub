/**
 * M119: Append-only decisions ledger for the fleet oversight layer.
 *
 * Writes to ~/.ashlr/decisions/<YYYY-MM-DD>.jsonl — one DecisionEntry per line.
 *
 * Rules (mirror audit.ts):
 *   - Append-only: never truncate, never rewrite, never delete a prior line.
 *   - Never write secrets: detail field is stripped of secret-shaped tokens.
 *   - recordDecision() never throws.
 *   - readDecisions() skips malformed lines, never throws.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { fsyncDirectory } from '../util/durability.js';
import type { DecisionEntry } from '../types.js';
import { normalizeDecisionLearningFields } from '../learning/causal.js';
import {
  agentSemanticProposalSubjectRef,
  agentSemanticModelFamily,
  remintAgentSemanticEvents,
  sanitizeAgentSemanticEvents,
} from '../learning/agent-semantic-events.js';
import { scrubSecrets } from '../util/scrub.js';
import { POST_MERGE_CREDIT_RELEASE_LABEL } from './post-merge-credit.js';
import {
  isJudgeDecisionReasonCode,
  isJudgeDecisionVerdict,
  judgeDecisionReasonCode,
  normalizeJudgeDecisionVerdict,
} from './judge-decision-metadata.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to the decisions directory: ~/.ashlr/decisions. */
export function decisionsDir(): string {
  return join(process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'), 'decisions');
}

/** Persist each newly-created authority directory and its first existing parent. */
export function _fsyncCreatedDecisionDirectoryChainForTest(
  dir: string,
  firstCreated: string,
  syncDirectory: (path: string) => void = fsyncDirectory,
): void {
  const firstExistingParent = dirname(firstCreated);
  let current = dir;
  while (true) {
    syncDirectory(current);
    if (current === firstExistingParent) return;
    const parent = dirname(current);
    if (parent === current) throw new Error('decisions ledger creation escaped filesystem root');
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Secret scrubbing (mirror audit.ts's stripSecrets)
// ---------------------------------------------------------------------------

function stripSecrets(s: string): string {
  return scrubSecrets(s);
}

const DECISION_ACTIONS = new Set<DecisionEntry['action']>([
  'proposed',
  'verified',
  'judged',
  'merge-authorized',
  'merged',
  'handoff',
  'rejected',
  'escalated',
  'self-improve:written',
  'skill-library:written',
]);

const DEFAULT_READ_MAX_FILES = 366;
const DEFAULT_READ_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 100_000;
const HARD_READ_MAX_FILES = 1_024;
const HARD_READ_MAX_BYTES = 256 * 1024 * 1024;
const HARD_READ_MAX_ROWS = 1_000_000;
const MAX_READ_ROW_BYTES = 128 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_048;
const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

interface DecisionWriteFailureForTest {
  stage: 'sanitize' | 'ensure-directory' | 'create-directory-durability' | 'append';
  operation?:
    | 'inspect-path'
    | 'open'
    | 'inspect-opened'
    | 'read-tail'
    | 'write'
    | 'file-fsync'
    | 'inspect-path-after'
    | 'directory-fsync'
    | 'close';
  code?: string;
  syscall?: string;
}

let latestDecisionWriteFailureForTest: DecisionWriteFailureForTest | undefined;

/** Test-only metadata for diagnosing a never-throw persistence failure. */
export function _getLatestDecisionWriteFailureForTest(): DecisionWriteFailureForTest | undefined {
  return latestDecisionWriteFailureForTest;
}

export interface ReadDecisionsOptions {
  sinceMs?: number;
  proposalId?: string;
  limit?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  /** Return no entries unless every selected source row was read and validated. */
  requireComplete?: boolean;
}

export type DecisionReadStopReason = 'file-limit' | 'byte-limit' | 'row-limit' | 'io-error';

export interface DecisionSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: DecisionReadStopReason[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  semanticRejectedRows?: number;
  unreadableFiles: number;
}

export interface DecisionsReadResult extends DecisionSourceQuality {
  decisions: DecisionEntry[];
}

function isDecisionAction(value: unknown): value is DecisionEntry['action'] {
  return typeof value === 'string' && DECISION_ACTIONS.has(value as DecisionEntry['action']);
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function hasValidAccountingTelemetry(value: Record<string, unknown>): boolean {
  return (
    (value['costUsd'] === undefined || nonNegativeFiniteNumber(value['costUsd']) !== undefined) &&
    (value['tokensIn'] === undefined || nonNegativeSafeInteger(value['tokensIn']) !== undefined) &&
    (value['tokensOut'] === undefined || nonNegativeSafeInteger(value['tokensOut']) !== undefined) &&
    (value['durationMs'] === undefined || nonNegativeSafeInteger(value['durationMs']) !== undefined)
  );
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalScrubbedText(value: unknown): string | undefined {
  return typeof value === 'string' ? stripSecrets(value) : undefined;
}

function optionalJudgeAttestation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  return stripSecrets(value);
}

function sanitizeDecisionEntry(entry: DecisionEntry, remintSemanticOccurrence = false): DecisionEntry {
  const action = entry.action;
  const verdict = action === 'judged'
    ? normalizeJudgeDecisionVerdict(entry.verdict)
    : entry.verdict;
  const detail = entry.detail;
  const judged = action === 'judged';
  const parsedTs = Date.parse(entry.ts);
  const proposalId = stripSecrets(entry.proposalId);
  const semanticSubjectRef = agentSemanticProposalSubjectRef(proposalId);
  const semanticEvents = semanticSubjectRef
    ? (remintSemanticOccurrence ? remintAgentSemanticEvents : sanitizeAgentSemanticEvents)(
        entry.semanticEvents,
        semanticSubjectRef,
        agentSemanticModelFamily(entry.model ?? entry.engine),
        { producerRole: 'manager', producerVersion: 'manager-semantic-v1' },
      )
    : undefined;
  const semanticEventsState = semanticEvents
    ? undefined
    : entry.semanticEvents !== undefined || entry.semanticEventsState === 'rejected'
      ? 'rejected' as const
      : undefined;
  const clean: DecisionEntry = {
    ts: Number.isFinite(parsedTs) ? new Date(parsedTs).toISOString() : new Date().toISOString(),
    proposalId,
    action,
    ...(optionalScrubbedText(entry.workItemId) !== undefined ? { workItemId: optionalScrubbedText(entry.workItemId) } : {}),
    ...(optionalScrubbedText(entry.workSource) !== undefined ? { workSource: optionalScrubbedText(entry.workSource) as DecisionEntry['workSource'] } : {}),
    ...(optionalScrubbedText(entry.runId) !== undefined ? { runId: optionalScrubbedText(entry.runId) } : {}),
    ...(optionalScrubbedText(entry.trajectoryId) !== undefined ? { trajectoryId: optionalScrubbedText(entry.trajectoryId) } : {}),
    ...(entry.routeSnapshot !== undefined ? { routeSnapshot: entry.routeSnapshot } : {}),
    ...(entry.runEventSummary !== undefined ? { runEventSummary: entry.runEventSummary } : {}),
    ...(entry.evidenceOutcome !== undefined ? { evidenceOutcome: entry.evidenceOutcome } : {}),
    ...(optionalScrubbedText(entry.learningSource) !== undefined ? { learningSource: optionalScrubbedText(entry.learningSource) as DecisionEntry['learningSource'] } : {}),
    ...(optionalScrubbedText(entry.labelBasis) !== undefined ? { labelBasis: optionalScrubbedText(entry.labelBasis) as DecisionEntry['labelBasis'] } : {}),
    ...(optionalScrubbedText(entry.routerPolicyVersion) !== undefined ? { routerPolicyVersion: optionalScrubbedText(entry.routerPolicyVersion) } : {}),
    ...(optionalScrubbedText(entry.learningEpoch) !== undefined ? { learningEpoch: optionalScrubbedText(entry.learningEpoch) } : {}),
    ...(semanticEvents ? { semanticEvents } : {}),
    ...(semanticEventsState ? { semanticEventsState } : {}),
    ...(optionalScrubbedText(entry.engine) !== undefined ? { engine: optionalScrubbedText(entry.engine) } : {}),
    ...(optionalScrubbedText(entry.model) !== undefined ? { model: optionalScrubbedText(entry.model) } : {}),
    ...(optionalScrubbedText(verdict) !== undefined ? { verdict: optionalScrubbedText(verdict) } : {}),
    ...(judged ? {
      judgeDecisionMetadataVersion: remintSemanticOccurrence || entry.judgeDecisionMetadataVersion === 2
        ? 2 as const
        : 1 as const,
      judgeReasonCode: judgeDecisionReasonCode(verdict, detail === 'would-merge'),
      judgeRationaleState: remintSemanticOccurrence || entry.judgeDecisionMetadataVersion === 2
        ? 'not-persisted' as const
        : 'legacy-redacted' as const,
      ...(detail === 'would-merge' ? { detail: 'would-merge' } : {}),
    } : {
      ...(optionalScrubbedText(entry.reason) !== undefined ? { reason: optionalScrubbedText(entry.reason) } : {}),
      ...(optionalScrubbedText(detail) !== undefined ? { detail: optionalScrubbedText(detail) } : {}),
    }),
    ...(optionalJudgeAttestation(entry.judgeAttestation) !== undefined ? { judgeAttestation: optionalJudgeAttestation(entry.judgeAttestation) } : {}),
    ...(optionalScrubbedText(entry.judgeAttestationIssuedAt) !== undefined
      ? { judgeAttestationIssuedAt: optionalScrubbedText(entry.judgeAttestationIssuedAt) }
      : {}),
    ...(entry.judgeAttestationIntent === 'would-merge' ? { judgeAttestationIntent: 'would-merge' } : {}),
    ...(nonNegativeFiniteNumber(entry.costUsd) !== undefined ? { costUsd: nonNegativeFiniteNumber(entry.costUsd) } : {}),
    ...(nonNegativeSafeInteger(entry.tokensIn) !== undefined ? { tokensIn: nonNegativeSafeInteger(entry.tokensIn) } : {}),
    ...(nonNegativeSafeInteger(entry.tokensOut) !== undefined ? { tokensOut: nonNegativeSafeInteger(entry.tokensOut) } : {}),
    ...(nonNegativeSafeInteger(entry.durationMs) !== undefined ? { durationMs: nonNegativeSafeInteger(entry.durationMs) } : {}),
    ...(optionalBoolean(entry.cacheHit) !== undefined ? { cacheHit: optionalBoolean(entry.cacheHit) } : {}),
  };
  return normalizeDecisionLearningFields(clean);
}

// ---------------------------------------------------------------------------
// Public: recordDecision()
// ---------------------------------------------------------------------------

/**
 * Append one DecisionEntry to today's JSONL file under ~/.ashlr/decisions/.
 * Sets `ts` to the current ISO timestamp when not provided.
 *
 * Append-only. Never throws.
 */
export function recordDecision(entry: DecisionEntry): boolean {
  let stage: DecisionWriteFailureForTest['stage'] = 'sanitize';
  let operation: DecisionWriteFailureForTest['operation'];
  try {
    latestDecisionWriteFailureForTest = undefined;
    const record = sanitizeDecisionEntry(entry, true);
    // Reserved positive authority must come from the future proof-bound release
    // writer, never this generic operational ledger API. Check the immutable
    // sanitized snapshot so stateful getters cannot change values after guard.
    if (record.labelBasis === POST_MERGE_CREDIT_RELEASE_LABEL) return false;
    const dir = decisionsDir();
    stage = 'ensure-directory';
    if (!existsSync(dir)) {
      const firstCreated = mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (firstCreated) {
        stage = 'create-directory-durability';
        // Persist the leaf entry and every newly-created ancestor entry through
        // the first pre-existing parent. Without this, a first-use nested
        // ASHLR_HOME can lose the whole ledger tree after reporting success.
        _fsyncCreatedDecisionDirectoryChainForTest(dir, firstCreated);
      }
    }

    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) return false;
    const filePath = join(dir, `${record.ts.slice(0, 10)}.jsonl`);
    stage = 'append';
    return appendDecisionLine(filePath, line, (nextOperation) => {
      operation = nextOperation;
    });
  } catch (error) {
    // Intentionally swallowed: ledger must never disrupt the caller's flow.
    latestDecisionWriteFailureForTest = {
      stage,
      ...(operation ? { operation } : {}),
      ...(typeof error === 'object' && error !== null &&
        typeof (error as NodeJS.ErrnoException).code === 'string'
        ? { code: (error as NodeJS.ErrnoException).code }
        : {}),
      ...(typeof error === 'object' && error !== null &&
        typeof (error as NodeJS.ErrnoException).syscall === 'string'
        ? { syscall: (error as NodeJS.ErrnoException).syscall }
        : {}),
    };
    return false;
  }
}

function appendDecisionLine(
  path: string,
  line: string,
  setOperation: (operation: NonNullable<DecisionWriteFailureForTest['operation']>) => void,
): boolean {
  let fd: number | undefined;
  let pendingError: unknown;
  try {
    let pathBefore: ReturnType<typeof lstatSync> | undefined;
    try {
      setOperation('inspect-path');
      pathBefore = lstatSync(path);
      if (!isSafeDecisionAuthorityFile(pathBefore)) {
        throw new Error('decisions ledger path is unsafe');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    setOperation('open');
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
        (pathBefore ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    setOperation('inspect-opened');
    const opened = fstatSync(fd);
    if (!isSafeDecisionAuthorityFile(opened) || (pathBefore && !sameFile(pathBefore, opened))) {
      throw new Error('decisions ledger is not a safe regular file');
    }
    if (opened.size > 0) {
      setOperation('read-tail');
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, opened.size - 1);
      if (read !== 1) throw new Error('decisions ledger tail is unreadable');
      if (tail[0] !== 0x0a) writeAll(fd, Buffer.from('\n', 'utf8'));
    }
    setOperation('write');
    writeAll(fd, Buffer.from(line, 'utf8'));
    setOperation('file-fsync');
    fsyncSync(fd);
    setOperation('inspect-path-after');
    const pathAfter = lstatSync(path);
    if (!isSafeDecisionAuthorityFile(pathAfter) || !sameFile(opened, pathAfter)) {
      throw new Error('decisions ledger path changed during append');
    }
    setOperation('directory-fsync');
    fsyncDirectory(dirname(path));
  } catch (error) {
    pendingError = error;
  }
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch (error) {
      if (pendingError === undefined) {
        setOperation('close');
        pendingError = error;
      }
    }
  }
  if (pendingError !== undefined) throw pendingError;
  return true;
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('decisions ledger append made no progress');
    offset += written;
  }
}

// ---------------------------------------------------------------------------
// Public: readDecisions()
// ---------------------------------------------------------------------------

/**
 * Read decision entries, newest-first.
 *
 * Options:
 *   sinceMs   — exclude entries older than this epoch ms
 *   proposalId — filter to a specific proposal id
 *   limit     — cap total returned (0 or undefined = all)
 *
 * Malformed JSONL lines are silently skipped. Never throws.
 */
function boundedReadOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyDecisionRead(
  sourceState: DecisionSourceQuality['sourceState'],
  overrides: Partial<DecisionsReadResult> = {},
): DecisionsReadResult {
  return {
    decisions: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    semanticRejectedRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function pushStopReason(reasons: DecisionReadStopReason[], reason: DecisionReadStopReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(stat: ReturnType<typeof fstatSync>): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

export function isSafeDecisionAuthorityFile(
  stat: ReturnType<typeof fstatSync>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1 &&
    ownedByCurrentUser(stat) && (platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

export function isSafeDecisionAuthorityDirectory(
  stat: ReturnType<typeof fstatSync>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function sameDirectorySnapshot(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return sameFile(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readDecisionFile(
  path: string,
  maxBytes: number,
): { ok: true; text: string; bytesRead: number } | { ok: false; reason: 'byte-limit' | 'io-error' } {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (!isSafeDecisionAuthorityFile(pathBefore)) {
      return { ok: false, reason: 'io-error' };
    }
    if (pathBefore.size > maxBytes) return { ok: false, reason: 'byte-limit' };
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!isSafeDecisionAuthorityFile(before) || !sameFile(pathBefore, before)) {
      return { ok: false, reason: 'io-error' };
    }
    if (before.size > maxBytes) return { ok: false, reason: 'byte-limit' };
    const buffer = Buffer.alloc(before.size);
    const bytesRead = before.size > 0 ? readSync(fd, buffer, 0, before.size, 0) : 0;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !after.isFile() ||
      !isSafeDecisionAuthorityFile(after) ||
      !sameFile(before, after) ||
      !sameFile(after, pathAfter) ||
      after.size !== before.size ||
      bytesRead !== before.size
    ) return { ok: false, reason: 'io-error' };
    return { ok: true, text: buffer.toString('utf8'), bytesRead };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort read */ }
    }
  }
}

export function readDecisionsDetailed(opts: ReadDecisionsOptions = {}): DecisionsReadResult {
  try {
    const maxFiles = boundedReadOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
    const maxBytes = boundedReadOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
    const maxRows = boundedReadOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
    const dir = decisionsDir();
    if (!existsSync(dir)) return emptyDecisionRead('missing');
    let directorySnapshot: ReturnType<typeof lstatSync>;
    try {
      directorySnapshot = lstatSync(dir);
      if (
        directorySnapshot.isSymbolicLink() ||
        !directorySnapshot.isDirectory() ||
        !isSafeDecisionAuthorityDirectory(directorySnapshot)
      ) {
        return emptyDecisionRead('degraded', {
          complete: false,
          stopReasons: ['io-error'],
          unreadableFiles: 1,
        });
      }
    } catch {
      return emptyDecisionRead('degraded', {
        complete: false,
        stopReasons: ['io-error'],
        unreadableFiles: 1,
      });
    }

    let files: string[];
    try {
      const handle = opendirSync(dir);
      const selected: string[] = [];
      let entriesSeen = 0;
      let invalidPartition = false;
      try {
        let entry = handle.readSync();
        while (entry !== null) {
          entriesSeen++;
          if (entriesSeen > MAX_DIRECTORY_ENTRIES) {
            return emptyDecisionRead('degraded', {
              sourcePresent: true,
              complete: false,
              stopReasons: ['file-limit'],
            });
          }
          if (entry.name.endsWith('.jsonl')) {
            const match = DATE_LEDGER_FILE_RE.exec(entry.name);
            if (!match) invalidPartition = true;
            else {
              const endOfDay = Date.parse(`${match[1]}T23:59:59.999Z`);
              if (opts.sinceMs === undefined || !Number.isFinite(endOfDay) || endOfDay >= opts.sinceMs) {
                selected.push(entry.name);
              }
            }
          }
          entry = handle.readSync();
        }
      } finally {
        handle.closeSync();
      }
      if (invalidPartition) {
        return emptyDecisionRead('degraded', {
          sourcePresent: true,
          complete: false,
          stopReasons: ['io-error'],
          unreadableFiles: 1,
        });
      }
      files = selected.sort().reverse(); // newest date first
    } catch {
      return emptyDecisionRead('degraded', {
        complete: false,
        stopReasons: ['io-error'],
        unreadableFiles: 1,
      });
    }
    if (files.length === 0) return emptyDecisionRead('healthy');

    const result = emptyDecisionRead('healthy');
    result.sourcePresent = true;
    const sinceMs = opts.sinceMs;
    const pid = opts.proposalId;

    for (const file of files) {
      if (result.filesRead >= maxFiles) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        break;
      }
      const remainingBytes = maxBytes - result.bytesRead;
      if (remainingBytes <= 0) {
        pushStopReason(result.stopReasons, 'byte-limit');
        result.complete = false;
        break;
      }

      const filePath = join(dir, file);
      const loaded = readDecisionFile(filePath, remainingBytes);
      result.filesRead++;
      if (!loaded.ok) {
        if (loaded.reason === 'io-error') result.unreadableFiles++;
        pushStopReason(result.stopReasons, loaded.reason);
        result.complete = false;
        break;
      }
      result.bytesRead += loaded.bytesRead;

      // Newest physical append first; stable timestamp sorting below preserves
      // this ordering when multiple decisions share the same millisecond.
      const lines = loaded.text.split('\n').reverse();

      for (const line of lines) {
        if (!line.trim()) continue;
        if (result.rowsScanned >= maxRows) {
          pushStopReason(result.stopReasons, 'row-limit');
          result.complete = false;
          break;
        }
        result.rowsScanned++;
        if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
          result.invalidRows++;
          continue;
        }

        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            if (
              typeof obj['ts'] === 'string' &&
              typeof obj['proposalId'] === 'string' &&
              typeof obj['action'] === 'string'
            ) {
              if (!isDecisionAction(obj['action'])) {
                result.invalidRows++;
                continue;
              }
              if (!hasValidAccountingTelemetry(obj)) {
                result.invalidRows++;
                continue;
              }
              const judged = obj['action'] === 'judged';
              const judgeMetadataVersion = obj['judgeDecisionMetadataVersion'];
              if (judged && judgeMetadataVersion !== undefined &&
                judgeMetadataVersion !== 1 && judgeMetadataVersion !== 2) {
                result.invalidRows++;
                continue;
              }
              if (judged && judgeMetadataVersion === 2) {
                const expectedCode = judgeDecisionReasonCode(
                  obj['verdict'], obj['detail'] === 'would-merge',
                );
                if (
                  !isJudgeDecisionVerdict(obj['verdict']) ||
                  obj['judgeRationaleState'] !== 'not-persisted' ||
                  !isJudgeDecisionReasonCode(obj['judgeReasonCode']) ||
                  obj['judgeReasonCode'] !== expectedCode ||
                  (obj['detail'] !== undefined && obj['detail'] !== 'would-merge') ||
                  Object.hasOwn(obj, 'reason') ||
                  Object.hasOwn(obj, 'rationale') ||
                  Object.hasOwn(obj, 'fullReasoning') ||
                  Object.hasOwn(obj, 'promptContext')
                ) {
                  result.invalidRows++;
                  continue;
                }
              }
              if (!judged && (
                judgeMetadataVersion !== undefined ||
                obj['judgeReasonCode'] !== undefined ||
                obj['judgeRationaleState'] !== undefined
              )) {
                result.invalidRows++;
                continue;
              }
              if (obj['semanticEvents'] !== undefined) {
                const subjectRef = agentSemanticProposalSubjectRef(stripSecrets(obj['proposalId']));
                if (!subjectRef || !sanitizeAgentSemanticEvents(
                  obj['semanticEvents'], subjectRef, agentSemanticModelFamily(obj['model'] ?? obj['engine']),
                  { producerRole: 'manager', producerVersion: 'manager-semantic-v1' },
                )) {
                  result.invalidRows++;
                  continue;
                }
              }
              if (obj['semanticEventsState'] !== undefined) {
                if (obj['semanticEventsState'] !== 'rejected' || obj['semanticEvents'] !== undefined) {
                  result.invalidRows++;
                  continue;
                }
                result.semanticRejectedRows = (result.semanticRejectedRows ?? 0) + 1;
              }
              const entryMs = Date.parse(obj['ts']);
              if (!Number.isFinite(entryMs)) {
                result.invalidRows++;
                continue;
              }
              const partitionDate = DATE_LEDGER_FILE_RE.exec(file)?.[1];
              if (partitionDate === undefined || obj['ts'].slice(0, 10) !== partitionDate) {
                result.invalidRows++;
                continue;
              }
              const record = sanitizeDecisionEntry(obj as unknown as DecisionEntry);
              // Window filter
              if (sinceMs !== undefined) {
                if (entryMs < sinceMs) continue;
              }
              // Proposal filter
              if (pid !== undefined && record.proposalId !== pid) continue;

              result.decisions.push(record);
            } else {
              result.invalidRows++;
            }
          } else {
            result.invalidRows++;
          }
        } catch {
          result.invalidRows++;
        }
      }
      if (!result.complete) break;
    }

    try {
      const directoryAfter = lstatSync(dir);
      if (
        directoryAfter.isSymbolicLink() ||
        !directoryAfter.isDirectory() ||
        !isSafeDecisionAuthorityDirectory(directoryAfter) ||
        !sameDirectorySnapshot(directorySnapshot, directoryAfter)
      ) {
        pushStopReason(result.stopReasons, 'io-error');
        result.complete = false;
        result.unreadableFiles++;
      }
    } catch {
      pushStopReason(result.stopReasons, 'io-error');
      result.complete = false;
      result.unreadableFiles++;
    }

    result.decisions.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    if (typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0) {
      result.decisions = result.decisions.slice(0, Math.floor(opts.limit));
    }
    if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.complete = false;
      result.sourceState = 'degraded';
    }
    return result;
  } catch {
    return emptyDecisionRead('degraded', {
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  }
}

export function readDecisions(opts: ReadDecisionsOptions = {}): DecisionEntry[] {
  const result = readDecisionsDetailed(opts);
  const decisions = opts.requireComplete === true && (!result.complete || result.sourceState === 'degraded')
    ? []
    : result.decisions;
  Object.defineProperty(decisions, 'sourceQuality', {
    value: {
      sourceState: result.sourceState,
      sourcePresent: result.sourcePresent,
      complete: result.complete,
      stopReasons: result.stopReasons,
      filesRead: result.filesRead,
      bytesRead: result.bytesRead,
      rowsScanned: result.rowsScanned,
      invalidRows: result.invalidRows,
      semanticRejectedRows: result.semanticRejectedRows,
      unreadableFiles: result.unreadableFiles,
    } satisfies DecisionSourceQuality,
    enumerable: false,
  });
  return decisions;
}

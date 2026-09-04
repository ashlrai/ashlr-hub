/**
 * M356: Append-only, bounded persistence for periodic scorecard snapshots.
 *
 * Uses a one-shot POSIX helper whose cwd is the validated private state root.
 * The helper enters the history directory by one relative component, pins and
 * validates that directory identity, then uses only single-component paths
 * relative to cwd. This avoids re-entering the store through a mutable
 * absolute parent pathname.
 * Node has no equivalent guaranteed directory-relative primitive on Windows,
 * so persistence is withheld there and reads report explicit degradation.
 *
 *   - Writes to ~/.ashlr/scorecard-history/<YYYY-MM>.jsonl — one
 *     ScorecardSnapshotRecord per line, monthly partitions.
 *   - Append-only: never truncates, never rewrites, never deletes a prior
 *     line. "Bounded" is achieved the same way decisions-ledger.ts achieves
 *     it — via a capped, newest-first bounded READ (maxFiles/maxBytes/maxRows)
 *     — not via deleting old data. Monthly partitioning keeps file count
 *     naturally small for years of daily snapshots.
 *   - Successful appends fsync the file and fsync a newly-created partition's
 *     directory entry before the helper acknowledges success.
 *   - appendScorecardSnapshot() never throws and returns true only after the
 *     durable helper acknowledgement and post-operation identity checks.
 *   - readScorecardHistory() skips malformed lines, never throws, and
 *     reports sourceQuality exactly like readDecisionsDetailed().
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import type { FleetScorecard, ScorecardWindow } from './scorecard.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function scorecardHistoryDir(): string {
  return join(process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'), 'scorecard-history');
}

const MAX_READ_ROW_BYTES = 128 * 1024;
const DEFAULT_READ_MAX_FILES = 120; // 10 years of monthly partitions
const HARD_READ_MAX_FILES = 1_024;
const DEFAULT_READ_MAX_BYTES = 16 * 1024 * 1024;
const HARD_READ_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 20_000;
const HARD_READ_MAX_ROWS = 200_000;

export interface ScorecardSnapshotRecord {
  ts: string;
  window: ScorecardWindow;
  scorecard: FleetScorecard;
}

export interface ScorecardHistorySourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: ('file-limit' | 'byte-limit' | 'row-limit' | 'io-error' | 'unsupported-platform')[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface ScorecardHistoryReadResult extends ScorecardHistorySourceQuality {
  records: ScorecardSnapshotRecord[];
}

interface ScorecardHistoryParentSwapTestAttack {
  directoryPath: string;
  displacedPath: string;
  replacementFiles?: Record<string, string>;
}

interface ScorecardHistoryFileSwapTestAttack {
  fileName: string;
  displacedName: string;
  replacementContents: string;
}

interface ScorecardHistoryTestHooks {
  operation: 'append' | 'read';
  parentSwap?: ScorecardHistoryParentSwapTestAttack;
  fileSwap?: ScorecardHistoryFileSwapTestAttack;
  beforeAppendSymlinkTarget?: string;
  workerFailure?: 'malformed-output' | 'nonzero' | 'timeout' | 'oversized-output';
  workerTimeoutMs?: number;
  workerMaxBufferBytes?: number;
}

let scorecardHistoryTestHooks: ScorecardHistoryTestHooks | undefined;

/** Test-only declarative attacks executed by the helper after cwd/file pinning. */
export function setScorecardHistoryTestHooksForTests(hooks?: ScorecardHistoryTestHooks): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('scorecard history hooks are test-only');
  scorecardHistoryTestHooks = hooks;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface ScorecardDirectoryGuard {
  rootPath: string;
  directoryPath: string;
  expectedRootDev: string;
  expectedRootIno: string;
  assertRootStable(): void;
  assertDirectoryStable(identity: { dev: string; ino: string }): void;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function inspectPrivateDirectory(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  const ownedByCurrentUser = typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByCurrentUser ||
    (stat.mode & 0o022n) !== 0n) {
    throw new Error('scorecard history directory is not private');
  }
  return stat;
}

function ensurePrivateDirectory(path: string, create: boolean): BigIntStats | undefined {
  if (!create) {
    try {
      return inspectPrivateDirectory(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  inspectPrivateDirectory(dirname(path));
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return inspectPrivateDirectory(path);
}

/** Capture the exact private root that the helper must acquire as cwd. */
function openScorecardRoot(create: boolean): ScorecardDirectoryGuard | undefined {
  const directoryPath = scorecardHistoryDir();
  const rootPath = dirname(directoryPath);
  const root = ensurePrivateDirectory(rootPath, create);
  if (!root) return undefined;
  const rootSnapshot: BigIntStats = root;
  const realRoot = realpathSync(rootPath);

  return {
    rootPath,
    directoryPath,
    expectedRootDev: String(rootSnapshot.dev),
    expectedRootIno: String(rootSnapshot.ino),
    assertRootStable: () => {
      const rootNow = inspectPrivateDirectory(rootPath);
      if (!sameFile(rootSnapshot, rootNow) || realpathSync(rootPath) !== realRoot) {
        throw new Error('scorecard history root identity changed');
      }
    },
    assertDirectoryStable: (identity) => {
      const directoryNow = inspectPrivateDirectory(directoryPath);
      if (String(directoryNow.dev) !== identity.dev || String(directoryNow.ino) !== identity.ino ||
        dirname(realpathSync(directoryPath)) !== realRoot) {
        throw new Error('scorecard history directory identity changed');
      }
    },
  };
}

const SCORECARD_HISTORY_WORKER = fileURLToPath(
  new URL('../../../scripts/scorecard-history-worker.mjs', import.meta.url),
);
const SCORECARD_WORKER_TIMEOUT_MS = 30_000;
const SCORECARD_WORKER_MAX_OUTPUT_BYTES = 260 * 1024 * 1024;

interface ScorecardWorkerRequest {
  operation: 'append' | 'read';
  expectedRootDev: string;
  expectedRootIno: string;
  directoryName: 'scorecard-history';
  fileName?: string;
  line?: string;
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  sinceMs?: number;
  limit?: number;
  testAttack?: Omit<ScorecardHistoryTestHooks, 'operation'>;
}

function runScorecardWorker(
  directory: ScorecardDirectoryGuard,
  request: Omit<ScorecardWorkerRequest, 'expectedRootDev' | 'expectedRootIno' | 'directoryName'>,
  maxBuffer: number,
): unknown {
  directory.assertRootStable();
  const hooks = scorecardHistoryTestHooks?.operation === request.operation
    ? scorecardHistoryTestHooks
    : undefined;
  const testTimeout = process.env.NODE_ENV === 'test' && hooks?.workerTimeoutMs !== undefined &&
    Number.isInteger(hooks.workerTimeoutMs) && hooks.workerTimeoutMs > 0
    ? Math.min(SCORECARD_WORKER_TIMEOUT_MS, hooks.workerTimeoutMs)
    : SCORECARD_WORKER_TIMEOUT_MS;
  const productionMaxBuffer = Math.min(
    SCORECARD_WORKER_MAX_OUTPUT_BYTES,
    Math.max(1024 * 1024, maxBuffer),
  );
  const effectiveMaxBuffer = process.env.NODE_ENV === 'test' &&
    hooks?.workerMaxBufferBytes !== undefined && Number.isInteger(hooks.workerMaxBufferBytes) &&
    hooks.workerMaxBufferBytes > 0
    ? Math.min(productionMaxBuffer, hooks.workerMaxBufferBytes)
    : productionMaxBuffer;
  const result = spawnSync(
    process.execPath,
    [SCORECARD_HISTORY_WORKER],
    {
      cwd: directory.rootPath,
      input: JSON.stringify({
        ...request,
        expectedRootDev: directory.expectedRootDev,
        expectedRootIno: directory.expectedRootIno,
        directoryName: 'scorecard-history',
        ...(hooks ? {
          testAttack: {
            ...(hooks.parentSwap ? { parentSwap: hooks.parentSwap } : {}),
            ...(hooks.fileSwap ? { fileSwap: hooks.fileSwap } : {}),
            ...(hooks.beforeAppendSymlinkTarget
              ? { beforeAppendSymlinkTarget: hooks.beforeAppendSymlinkTarget }
              : {}),
            ...(hooks.workerFailure ? { workerFailure: hooks.workerFailure } : {}),
          },
        } : {}),
      } satisfies ScorecardWorkerRequest),
      encoding: 'utf8',
      timeout: testTimeout,
      maxBuffer: effectiveMaxBuffer,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error || result.signal !== null || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('scorecard history worker failed');
  }
  return JSON.parse(result.stdout);
}

/**
 * Append one scorecard snapshot record. Append-only, monthly-partitioned.
 * Never throws.
 */
export function appendScorecardSnapshot(record: ScorecardSnapshotRecord): boolean {
  try {
    // Windows has no public Node primitive whose relative lookup is bound to a
    // directory handle. Observability is withheld instead of falling back to
    // the raceable absolute-path implementation.
    if (process.platform === 'win32') return false;
    const parsedTs = Date.parse(record.ts);
    const ts = Number.isFinite(parsedTs) ? new Date(parsedTs).toISOString() : new Date().toISOString();
    const clean: ScorecardSnapshotRecord = { ts, window: record.window, scorecard: record.scorecard };
    const directory = openScorecardRoot(true);
    if (!directory) return false;
    const line = JSON.stringify(clean) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) return false;
    const result = runScorecardWorker(directory, {
      operation: 'append',
      fileName: `${ts.slice(0, 7)}.jsonl`,
      line,
    }, 1024 * 1024);
    if (result === null || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) return false;
    const identity = parseWorkerDirectoryIdentity((result as Record<string, unknown>)['directoryIdentity']);
    if (!identity) return false;
    directory.assertRootStable();
    directory.assertDirectoryStable(identity);
    return true;
  } catch {
    // Never throws — history is observability, not authority.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function boundedOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyRead(
  sourceState: ScorecardHistorySourceQuality['sourceState'],
  overrides: Partial<ScorecardHistoryReadResult> = {},
): ScorecardHistoryReadResult {
  return {
    records: [],
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

function isScorecardWindow(value: unknown): value is ScorecardWindow {
  return value === '7d' || value === '30d';
}

function parseWorkerDirectoryIdentity(value: unknown): { dev: string; ino: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['dev'] === 'string' && /^\d+$/.test(candidate['dev']) &&
    typeof candidate['ino'] === 'string' && /^\d+$/.test(candidate['ino'])
    ? { dev: candidate['dev'], ino: candidate['ino'] }
    : undefined;
}

function parseWorkerReadResult(value: unknown): ScorecardHistoryReadResult | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate['sourceState'] !== 'missing' && candidate['sourceState'] !== 'healthy' &&
    candidate['sourceState'] !== 'degraded') return undefined;
  if (typeof candidate['sourcePresent'] !== 'boolean' || typeof candidate['complete'] !== 'boolean' ||
    !Array.isArray(candidate['stopReasons']) || !Array.isArray(candidate['records'])) return undefined;
  const allowedReasons = new Set<ScorecardHistorySourceQuality['stopReasons'][number]>([
    'file-limit', 'byte-limit', 'row-limit', 'io-error',
  ]);
  if (!candidate['stopReasons'].every((reason) => allowedReasons.has(
    reason as ScorecardHistorySourceQuality['stopReasons'][number],
  ))) return undefined;
  const counters = ['filesRead', 'bytesRead', 'rowsScanned', 'invalidRows', 'unreadableFiles'] as const;
  if (!counters.every((key) => Number.isInteger(candidate[key]) && Number(candidate[key]) >= 0)) return undefined;
  if (!candidate['records'].every((record) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
    const parsed = record as Record<string, unknown>;
    return typeof parsed['ts'] === 'string' && Number.isFinite(Date.parse(parsed['ts'])) &&
      isScorecardWindow(parsed['window']) && parsed['scorecard'] !== null &&
      typeof parsed['scorecard'] === 'object' && !Array.isArray(parsed['scorecard']);
  })) return undefined;
  return value as ScorecardHistoryReadResult;
}

/**
 * Read persisted scorecard snapshots, newest-first, bounded. Never throws.
 * Malformed lines are skipped and counted in invalidRows.
 */
export function readScorecardHistory(
  opts: { sinceMs?: number; limit?: number; maxFiles?: number; maxBytes?: number; maxRows?: number } = {},
): ScorecardHistoryReadResult {
  try {
    if (process.platform === 'win32') {
      return emptyRead('degraded', {
        sourcePresent: false,
        complete: false,
        stopReasons: ['unsupported-platform'],
      });
    }
    const maxFiles = boundedOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
    const maxBytes = boundedOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
    const maxRows = boundedOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
    const directory = openScorecardRoot(false);
    if (!directory) return emptyRead('missing');
    const workerResult = runScorecardWorker(directory, {
      operation: 'read',
      maxFiles,
      maxBytes,
      maxRows,
      ...(typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) ? { sinceMs: opts.sinceMs } : {}),
      ...(typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
        ? { limit: Math.min(HARD_READ_MAX_ROWS, Math.floor(opts.limit)) }
        : {}),
    }, Math.min(SCORECARD_WORKER_MAX_OUTPUT_BYTES, maxBytes * 2 + 1024 * 1024));
    if (workerResult !== null && typeof workerResult === 'object' &&
      !Array.isArray(workerResult) && (workerResult as Record<string, unknown>)['missing'] === true) {
      directory.assertRootStable();
      return emptyRead('missing');
    }
    if (workerResult === null || typeof workerResult !== 'object' || Array.isArray(workerResult)) {
      throw new Error('invalid scorecard history worker response');
    }
    const response = workerResult as Record<string, unknown>;
    const identity = parseWorkerDirectoryIdentity(response['directoryIdentity']);
    const result = parseWorkerReadResult(response['result']);
    if (!identity) throw new Error('invalid scorecard history directory identity');
    if (!result) throw new Error('invalid scorecard history worker response');
    directory.assertRootStable();
    directory.assertDirectoryStable(identity);
    return result;
  } catch {
    return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
  }
}

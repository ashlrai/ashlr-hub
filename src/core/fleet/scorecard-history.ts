/**
 * M356: Append-only, bounded persistence for periodic scorecard snapshots.
 *
 * Mirrors decisions-ledger.ts's conventions exactly (same safe-append
 * primitives, same partitioned-file + bounded-read shape) so week-over-week
 * scorecard trend is computable without ever needing to truncate or rewrite
 * a history file:
 *
 *   - Writes to ~/.ashlr/scorecard-history/<YYYY-MM>.jsonl — one
 *     ScorecardSnapshotRecord per line, monthly partitions.
 *   - Append-only: never truncates, never rewrites, never deletes a prior
 *     line. "Bounded" is achieved the same way decisions-ledger.ts achieves
 *     it — via a capped, newest-first bounded READ (maxFiles/maxBytes/maxRows)
 *     — not via deleting old data. Monthly partitioning keeps file count
 *     naturally small for years of daily snapshots.
 *   - appendScorecardSnapshot() never throws.
 *   - readScorecardHistory() skips malformed lines, never throws, and
 *     reports sourceQuality exactly like readDecisionsDetailed().
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Stats,
  writeSync,
} from 'node:fs';
import type { FleetScorecard, ScorecardWindow } from './scorecard.js';
import { isSafeDecisionAuthorityDirectory, isSafeDecisionAuthorityFile } from './decisions-ledger.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function scorecardHistoryDir(): string {
  return join(process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'), 'scorecard-history');
}

const PARTITION_FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;
const MAX_READ_ROW_BYTES = 128 * 1024;
const DEFAULT_READ_MAX_FILES = 120; // 10 years of monthly partitions
const HARD_READ_MAX_FILES = 1_024;
const DEFAULT_READ_MAX_BYTES = 16 * 1024 * 1024;
const HARD_READ_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 20_000;
const HARD_READ_MAX_ROWS = 200_000;
const MAX_DIRECTORY_ENTRIES = 2_048;

export interface ScorecardSnapshotRecord {
  ts: string;
  window: ScorecardWindow;
  scorecard: FleetScorecard;
}

export interface ScorecardHistorySourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: ('file-limit' | 'byte-limit' | 'row-limit' | 'io-error')[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface ScorecardHistoryReadResult extends ScorecardHistorySourceQuality {
  records: ScorecardSnapshotRecord[];
}

interface ScorecardHistoryTestHooks {
  afterDirectoryOpen?: (operation: 'append' | 'read', path: string) => void;
  afterFileOpen?: (operation: 'append' | 'read', path: string) => void;
  beforeAppendOpen?: (path: string) => void;
}

let scorecardHistoryTestHooks: ScorecardHistoryTestHooks | undefined;

/** Test-only seam for deterministic pathname replacement after descriptor open. */
export function setScorecardHistoryTestHooksForTests(hooks?: ScorecardHistoryTestHooks): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('scorecard history hooks are test-only');
  scorecardHistoryTestHooks = hooks;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('scorecard history append made no progress');
    offset += written;
  }
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface ScorecardDirectoryGuard {
  assertStable(): void;
  close(): void;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function inspectPrivateDirectory(path: string): Stats {
  const stat = lstatSync(path);
  if (!isSafeDecisionAuthorityDirectory(stat)) {
    throw new Error('scorecard history directory is not private');
  }
  return stat;
}

function ensurePrivateDirectory(path: string, create: boolean): Stats | undefined {
  try {
    return inspectPrivateDirectory(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!create) return undefined;
  }

  inspectPrivateDirectory(dirname(path));
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return inspectPrivateDirectory(path);
}

/** Pin the private state root and history directory across one operation. */
function openScorecardDirectory(create: boolean): ScorecardDirectoryGuard | undefined {
  const directoryPath = scorecardHistoryDir();
  const rootPath = dirname(directoryPath);
  const root = ensurePrivateDirectory(rootPath, create);
  if (!root) return undefined;
  const directory = ensurePrivateDirectory(directoryPath, create);
  if (!directory) return undefined;
  const rootSnapshot: Stats = root;
  const directorySnapshot: Stats = directory;
  const realRoot = realpathSync(rootPath);
  const realDirectory = realpathSync(directoryPath);
  if (dirname(realDirectory) !== realRoot) throw new Error('scorecard history escapes private root');

  let fd: number | undefined;
  if (process.platform !== 'win32') {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const directoryOnly = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
    fd = openSync(directoryPath, fsConstants.O_RDONLY | noFollow | directoryOnly);
    const opened = fstatSync(fd);
    if (!isSafeDecisionAuthorityDirectory(opened) || !sameFile(directorySnapshot, opened)) {
      closeSync(fd);
      fd = undefined;
      throw new Error('scorecard history directory changed while opening');
    }
  }

  let closed = false;
  return {
    assertStable: () => {
      if (closed) throw new Error('scorecard history directory guard is closed');
      const rootNow = inspectPrivateDirectory(rootPath);
      const directoryNow = inspectPrivateDirectory(directoryPath);
      const openedNow = fd === undefined ? directorySnapshot : fstatSync(fd);
      if (!sameFile(rootSnapshot, rootNow) || !sameFile(directorySnapshot, directoryNow) ||
        !sameFile(directorySnapshot, openedNow) || realpathSync(rootPath) !== realRoot ||
        realpathSync(directoryPath) !== realDirectory) {
        throw new Error('scorecard history directory identity changed');
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (fd !== undefined) closeSync(fd);
    },
  };
}

function appendHistoryLine(path: string, line: string, directory: ScorecardDirectoryGuard): void {
  let fd: number | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    directory.assertStable();
    scorecardHistoryTestHooks?.beforeAppendOpen?.(path);
    directory.assertStable();
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_CREAT | noFollow,
      0o600,
    );
    const opened = fstatSync(fd);
    scorecardHistoryTestHooks?.afterFileOpen?.('append', path);
    const pathBefore = lstatSync(path);
    if (!isSafeDecisionAuthorityFile(opened) || !isSafeDecisionAuthorityFile(pathBefore) ||
      !sameFile(pathBefore, opened)) {
      throw new Error('scorecard history is not a safe regular file');
    }
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, opened.size - 1);
      if (read !== 1) throw new Error('scorecard history tail is unreadable');
      if (tail[0] !== 0x0a) writeAll(fd, Buffer.from('\n', 'utf8'));
    }
    writeAll(fd, Buffer.from(line, 'utf8'));
    const pathAfter = lstatSync(path);
    if (!isSafeDecisionAuthorityFile(pathAfter) || !sameFile(opened, pathAfter)) {
      throw new Error('scorecard history path changed during append');
    }
    directory.assertStable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Append one scorecard snapshot record. Append-only, monthly-partitioned.
 * Never throws.
 */
export function appendScorecardSnapshot(record: ScorecardSnapshotRecord): void {
  try {
    const parsedTs = Date.parse(record.ts);
    const ts = Number.isFinite(parsedTs) ? new Date(parsedTs).toISOString() : new Date().toISOString();
    const clean: ScorecardSnapshotRecord = { ts, window: record.window, scorecard: record.scorecard };
    const dir = scorecardHistoryDir();
    const directory = openScorecardDirectory(true);
    if (!directory) return;
    const line = JSON.stringify(clean) + '\n';
    try {
      if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) return;
      scorecardHistoryTestHooks?.afterDirectoryOpen?.('append', dir);
      directory.assertStable();
      const filePath = join(dir, `${ts.slice(0, 7)}.jsonl`);
      appendHistoryLine(filePath, line, directory);
    } finally {
      directory.close();
    }
  } catch {
    // Never throws — history is observability, not authority.
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

function pushStop(
  reasons: ScorecardHistorySourceQuality['stopReasons'],
  reason: ScorecardHistorySourceQuality['stopReasons'][number],
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function readHistoryFile(
  path: string,
  maxBytes: number,
  directory: ScorecardDirectoryGuard,
): { ok: true; text: string; bytesRead: number } | { ok: false; reason: 'byte-limit' | 'io-error' } {
  let fd: number | undefined;
  try {
    directory.assertStable();
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    scorecardHistoryTestHooks?.afterFileOpen?.('read', path);
    const pathBefore = lstatSync(path);
    if (!isSafeDecisionAuthorityFile(before) || !isSafeDecisionAuthorityFile(pathBefore) ||
      !sameFile(pathBefore, before)) return { ok: false, reason: 'io-error' };
    if (before.size > maxBytes) return { ok: false, reason: 'byte-limit' };
    const buffer = Buffer.alloc(before.size);
    const bytesRead = before.size > 0 ? readSync(fd, buffer, 0, before.size, 0) : 0;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() || !pathAfter.isFile() || !after.isFile() ||
      !isSafeDecisionAuthorityFile(after) || !sameFile(before, after) || !sameFile(after, pathAfter) ||
      after.size !== before.size || bytesRead !== before.size
    ) return { ok: false, reason: 'io-error' };
    directory.assertStable();
    return { ok: true, text: buffer.toString('utf8'), bytesRead };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort */ } }
  }
}

function isScorecardWindow(value: unknown): value is ScorecardWindow {
  return value === '7d' || value === '30d';
}

/**
 * Read persisted scorecard snapshots, newest-first, bounded. Never throws.
 * Malformed lines are skipped and counted in invalidRows.
 */
export function readScorecardHistory(
  opts: { sinceMs?: number; limit?: number; maxFiles?: number; maxBytes?: number; maxRows?: number } = {},
): ScorecardHistoryReadResult {
  let directory: ScorecardDirectoryGuard | undefined;
  try {
    const maxFiles = boundedOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
    const maxBytes = boundedOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
    const maxRows = boundedOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
    const dir = scorecardHistoryDir();
    directory = openScorecardDirectory(false);
    if (!directory) return emptyRead('missing');
    scorecardHistoryTestHooks?.afterDirectoryOpen?.('read', dir);
    directory.assertStable();

    let files: string[];
    try {
      const handle = opendirSync(dir);
      const selected: string[] = [];
      let seen = 0;
      try {
        let entry = handle.readSync();
        while (entry !== null) {
          seen++;
          if (seen > MAX_DIRECTORY_ENTRIES) {
            return emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['file-limit'] });
          }
          if (entry.name.endsWith('.jsonl') && PARTITION_FILE_RE.test(entry.name)) {
            selected.push(entry.name);
          }
          entry = handle.readSync();
        }
      } finally {
        handle.closeSync();
      }
      files = selected.sort().reverse(); // newest month first
    } catch {
      return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }
    if (files.length === 0) return emptyRead('healthy');

    const result = emptyRead('healthy');
    result.sourcePresent = true;

    for (const file of files) {
      if (result.filesRead >= maxFiles) {
        pushStop(result.stopReasons, 'file-limit');
        result.complete = false;
        break;
      }
      const remaining = maxBytes - result.bytesRead;
      if (remaining <= 0) {
        pushStop(result.stopReasons, 'byte-limit');
        result.complete = false;
        break;
      }
      const loaded = readHistoryFile(join(dir, file), remaining, directory);
      result.filesRead++;
      if (!loaded.ok) {
        if (loaded.reason === 'io-error') result.unreadableFiles++;
        pushStop(result.stopReasons, loaded.reason);
        result.complete = false;
        break;
      }
      result.bytesRead += loaded.bytesRead;

      const lines = loaded.text.split('\n').reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (result.rowsScanned >= maxRows) {
          pushStop(result.stopReasons, 'row-limit');
          result.complete = false;
          break;
        }
        result.rowsScanned++;
        if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) { result.invalidRows++; continue; }
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
            typeof (parsed as Record<string, unknown>)['ts'] === 'string' &&
            isScorecardWindow((parsed as Record<string, unknown>)['window']) &&
            (parsed as Record<string, unknown>)['scorecard'] !== null &&
            typeof (parsed as Record<string, unknown>)['scorecard'] === 'object'
          ) {
            const entryMs = Date.parse((parsed as { ts: string }).ts);
            if (!Number.isFinite(entryMs)) { result.invalidRows++; continue; }
            if (opts.sinceMs !== undefined && entryMs < opts.sinceMs) continue;
            result.records.push(parsed as ScorecardSnapshotRecord);
          } else {
            result.invalidRows++;
          }
        } catch {
          result.invalidRows++;
        }
      }
      if (!result.complete) break;
    }

    result.records.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    if (typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0) {
      result.records = result.records.slice(0, Math.floor(opts.limit));
    }
    if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.complete = false;
      result.sourceState = 'degraded';
    }
    directory.assertStable();
    return result;
  } catch {
    return emptyRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
  } finally {
    directory?.close();
  }
}

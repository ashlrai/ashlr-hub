/**
 * Codex rollout reader — the ONLY place Verse learns a codex turn's exact
 * context occupancy, its window, its compactions and its true per-turn usage.
 *
 * WHY THIS EXISTS. `codex exec --json` never prints per-call usage or the
 * window: its `turn.completed.usage` is a SUM over every model call in the
 * turn (a 20-call turn reports ~20× the live prompt), and codex seeds that sum
 * from the rollout when a thread is resumed, so on `exec resume` it is the
 * THREAD's running total rather than the turn's. The CLI's own session file
 * does carry the truth, one `token_count` per model call:
 *
 *   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local ts>-<thread id>.jsonl
 *     {"timestamp":…,"type":"event_msg","payload":{"type":"token_count","info":{
 *        "total_token_usage":{…cumulative…},"last_token_usage":{…this call…},
 *        "model_context_window":258400}}}
 *     {"timestamp":…,"type":"event_msg","payload":{"type":"task_started","model_context_window":258400}}
 *     {"timestamp":…,"type":"compacted","payload":{…replacement history, often MEGABYTES…}}
 *     {"timestamp":…,"type":"token_usage_record","payload":{"thread_id":…,"turn_token_usage":{…}}}   (0.149+)
 *
 * (Shapes verified against 4,001 rollouts on this machine, CLI 0.136 – 0.155.)
 *
 * WHAT "OCCUPANCY" MEANS HERE. `last_token_usage.total_tokens` — the last
 * call's prompt plus its reply. That is the quantity codex itself compares to
 * its auto-compaction limit (no uncompacted call ever exceeded 244,800 = 90% of
 * the raw 272k window, across 62,104 calls), and it is what the NEXT call's
 * prompt starts from, so the meter and the compaction tick share one unit.
 * Right after a compaction codex writes a `token_count` whose cumulative total
 * is unchanged but whose `last_token_usage` is the post-compaction size — so a
 * reading is taken from EVERY token_count, while usage is only summed for
 * records whose cumulative total moved (a real model call).
 *
 * BOUNDS. A `compacted` line is routinely 2–17 MB (it embeds the replacement
 * history), so nothing here ever holds a whole line in memory: lines are
 * scanned in chunks and only their first CODEX_ROLLOUT_LINE_HEAD_BYTES are
 * kept. The small records (token_count ≤ 1 KB) are parsed whole; an oversized
 * line is classified from its head alone. First reads look at most
 * CODEX_ROLLOUT_TAIL_BYTES back from EOF (doubling to a hard cap only when the
 * turn's start is not in that window); incremental reads scan at most
 * CODEX_ROLLOUT_MAX_SCAN_BYTES. A missing, pruned, rewritten or unreadable file
 * yields null / "no reading" — nothing here throws.
 *
 * PRIVACY. Paths computed here name native-profile directories (account
 * identity). They are used to read files and are never returned in events,
 * logged, or persisted.
 */

import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** First read of a rollout: at most this much from EOF (spec: ≤ 2 MB). */
export const CODEX_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
/**
 * When the turn's first record is not inside the first tail window (a turn
 * that wrote megabytes before the first poll — i.e. an early compaction), the
 * window doubles up to this cap. Past it the turn is accounted as partial.
 */
export const CODEX_ROLLOUT_MAX_TAIL_BYTES = 16 * 1024 * 1024;
/** One incremental read scans at most this much; beyond it the reader jumps to the tail and records a gap. */
export const CODEX_ROLLOUT_MAX_SCAN_BYTES = 32 * 1024 * 1024;
/** Bytes of each line retained for classification. Every record we parse whole is far smaller. */
export const CODEX_ROLLOUT_LINE_HEAD_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
/** Day directories a fallback thread search may open (≈ two years of daily use). */
const MAX_DAY_DIRS = 750;
/** profile.json is a few hundred bytes; anything bigger is not a profile. */
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 128;

const NEWLINE = 0x0a;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One usage block as codex writes it. `inputTokens` INCLUDES the cached portion. */
export interface CodexTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  /** 0.155+ only; 0 when absent. */
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type CodexRolloutRecord =
  | {
    kind: 'token-count';
    /** Byte offset of the line — a stable identity for "already seen". */
    offset: number;
    /** Epoch ms from the record's `timestamp`, or null when absent/unparsable. */
    at: number | null;
    total: CodexTokenTotals;
    last: CodexTokenTotals;
    modelContextWindow: number | null;
  }
  | { kind: 'task-started'; offset: number; at: number | null; modelContextWindow: number | null }
  | { kind: 'compacted'; offset: number; at: number | null }
  | { kind: 'token-usage-record'; offset: number; at: number | null; threadId: string | null; turn: CodexTokenTotals | null };

export interface CodexRolloutRead {
  /** File size when the read started. */
  size: number;
  /** First byte the read considered. */
  start: number;
  /** Offset just past the last COMPLETE line consumed — where an incremental read resumes. */
  end: number;
  records: CodexRolloutRecord[];
  /** True when bytes between `start` and `size` were skipped for the scan budget. */
  skipped: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export const ZERO_CODEX_TOTALS: Readonly<CodexTokenTotals> = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

/** A codex usage block → totals, or null when it is not one. `total_tokens` falls back to input + output. */
export function codexTotals(value: unknown): CodexTokenTotals | null {
  if (!isObject(value)) return null;
  const hasAny = ['input_tokens', 'output_tokens', 'total_tokens'].some((key) => typeof value[key] === 'number');
  if (!hasAny) return null;
  const inputTokens = count(value['input_tokens']);
  const outputTokens = count(value['output_tokens']);
  const reported = count(value['total_tokens']);
  return {
    inputTokens,
    cachedInputTokens: count(value['cached_input_tokens']),
    cacheWriteInputTokens: count(value['cache_write_input_tokens']),
    outputTokens,
    reasoningOutputTokens: count(value['reasoning_output_tokens']),
    totalTokens: reported > 0 ? reported : inputTokens + outputTokens,
  };
}

export function addCodexTotals(a: CodexTokenTotals, b: CodexTokenTotals): CodexTokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** a − b, each bucket clamped at 0 (a counter that went backwards is a reset, never negative usage). */
export function subtractCodexTotals(a: CodexTokenTotals, b: CodexTokenTotals): CodexTokenTotals {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, a.cacheWriteInputTokens - b.cacheWriteInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
  };
}

/**
 * The live occupancy one `token_count` describes: its last call's
 * `total_tokens` (prompt + reply), the figure codex compacts against.
 */
export function codexOccupancy(last: CodexTokenTotals): number {
  return last.totalTokens > 0 ? last.totalTokens : last.inputTokens + last.outputTokens;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Classify one COMPLETE, small line. Unknown or malformed lines → null. */
function classifyParsed(obj: JsonObject, offset: number): CodexRolloutRecord | null {
  const at = timestampMs(obj['timestamp']);
  const type = obj['type'];
  const payload = isObject(obj['payload']) ? obj['payload'] : null;
  if (type === 'compacted') return { kind: 'compacted', offset, at };
  if (!payload) return null;
  if (type === 'event_msg') {
    const inner = payload['type'];
    if (inner === 'token_count') {
      // `info` is null on a rate-limit-only refresh: no reading in it.
      const info = isObject(payload['info']) ? payload['info'] : null;
      if (!info) return null;
      const total = codexTotals(info['total_token_usage']);
      const last = codexTotals(info['last_token_usage']);
      if (!total || !last) return null;
      return { kind: 'token-count', offset, at, total, last, modelContextWindow: positiveIntOrNull(info['model_context_window']) };
    }
    if (inner === 'task_started') {
      return { kind: 'task-started', offset, at, modelContextWindow: positiveIntOrNull(payload['model_context_window']) };
    }
    return null;
  }
  if (type === 'token_usage_record') {
    const threadId = typeof payload['thread_id'] === 'string' ? payload['thread_id'] : null;
    return { kind: 'token-usage-record', offset, at, threadId, turn: codexTotals(payload['turn_token_usage']) };
  }
  return null;
}

/**
 * An oversized line cannot be parsed, but every rollout line starts
 * `{"timestamp":"…","type":"…",…` — so a `compacted` record (the only big line
 * this reader cares about) is recognisable from its first bytes. The type is
 * only trusted when it appears BEFORE `"payload"`, i.e. at the top level.
 */
function classifyHead(head: string, offset: number): CodexRolloutRecord | null {
  const payloadAt = head.indexOf('"payload"');
  const prefix = payloadAt === -1 ? head.slice(0, 512) : head.slice(0, payloadAt);
  if (!/"type"\s*:\s*"compacted"/.test(prefix)) return null;
  const ts = /"timestamp"\s*:\s*"([^"]{1,64})"/.exec(prefix);
  return { kind: 'compacted', offset, at: ts ? timestampMs(ts[1]) : null };
}

function classifyLine(head: Buffer, offset: number, length: number): CodexRolloutRecord | null {
  if (length <= head.length) {
    const text = head.toString('utf8').trim();
    if (!text.startsWith('{')) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    return isObject(parsed) ? classifyParsed(parsed, offset) : null;
  }
  return classifyHead(head.toString('utf8'), offset);
}

// ---------------------------------------------------------------------------
// Bounded line scanner
// ---------------------------------------------------------------------------

interface ScanResult {
  /** Start of the first line NOT consumed (a partial line at EOF, or where the budget ran out). */
  end: number;
  /** How far the scan physically read. */
  pos: number;
  /** The budget ran out before `to`. */
  exhausted: boolean;
}

/**
 * Scan complete lines in [from, to), keeping only each line's head. When
 * `skipFirstPartial`, bytes up to and including the first newline belong to a
 * line that started before `from` and are discarded.
 */
function scanLines(
  fd: number,
  from: number,
  to: number,
  budget: number,
  skipFirstPartial: boolean,
  onLine: (head: Buffer, start: number, length: number) => void,
): ScanResult {
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const headParts: Buffer[] = [];
  let headBytes = 0;
  let lineStart = from;
  let skipping = skipFirstPartial;
  let pos = from;
  let scanned = 0;

  const keep = (slice: Buffer): void => {
    if (skipping || headBytes >= CODEX_ROLLOUT_LINE_HEAD_BYTES || slice.length === 0) return;
    const take = slice.subarray(0, CODEX_ROLLOUT_LINE_HEAD_BYTES - headBytes);
    headParts.push(Buffer.from(take));
    headBytes += take.length;
  };

  while (pos < to) {
    if (scanned >= budget) return { end: skipping ? pos : lineStart, pos, exhausted: true };
    const want = Math.min(READ_CHUNK_BYTES, to - pos);
    let n: number;
    try { n = readSync(fd, chunk, 0, want, pos); } catch { break; }
    if (n <= 0) break;
    let cursor = 0;
    while (cursor < n) {
      const nl = chunk.indexOf(NEWLINE, cursor);
      if (nl === -1 || nl >= n) {
        keep(chunk.subarray(cursor, n));
        cursor = n;
        break;
      }
      keep(chunk.subarray(cursor, nl));
      const lineEnd = pos + nl;
      if (!skipping) {
        const length = lineEnd - lineStart;
        if (length > 0) onLine(Buffer.concat(headParts, headBytes), lineStart, length);
      }
      skipping = false;
      headParts.length = 0;
      headBytes = 0;
      lineStart = lineEnd + 1;
      cursor = nl + 1;
    }
    pos += n;
    scanned += n;
  }
  return { end: skipping ? pos : lineStart, pos, exhausted: false };
}

function byteBefore(fd: number, offset: number): number | null {
  if (offset <= 0) return null;
  const one = Buffer.allocUnsafe(1);
  try {
    return readSync(fd, one, 0, 1, offset - 1) === 1 ? one[0]! : null;
  } catch {
    return null;
  }
}

/** Open a rollout for reading: a regular, non-symlinked file, or null. */
function openRollout(file: string): { fd: number; size: number; ino: number } | null {
  try {
    const link = lstatSync(file);
    if (!link.isFile() || link.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      closeSync(fd);
      return null;
    }
    return { fd, size: stat.size, ino: stat.ino };
  } catch {
    try { closeSync(fd); } catch { /* already closed */ }
    return null;
  }
}

function readRange(fd: number, size: number, from: number, budget: number, midLine: boolean): CodexRolloutRead {
  const start = Math.max(0, Math.min(from, size));
  const records: CodexRolloutRecord[] = [];
  // A start that is not a line boundary cuts the line it lands in: drop it.
  const cut = midLine || (start > 0 && byteBefore(fd, start) !== NEWLINE);
  const scan = scanLines(fd, start, size, budget, cut, (head, offset, length) => {
    const record = classifyLine(head, offset, length);
    if (record) records.push(record);
  });
  return { size, start, end: scan.end, records, skipped: scan.exhausted };
}

/**
 * Complete records from the last `maxBytes` of a rollout (never more than
 * CODEX_ROLLOUT_MAX_TAIL_BYTES). A line cut by the window start is dropped.
 * Null when the file is missing or unreadable.
 */
export function readCodexRolloutTail(file: string, maxBytes: number = CODEX_ROLLOUT_TAIL_BYTES): CodexRolloutRead | null {
  const opened = openRollout(file);
  if (!opened) return null;
  try {
    const window = Math.max(1, Math.min(Math.floor(maxBytes), CODEX_ROLLOUT_MAX_TAIL_BYTES));
    return readRange(opened.fd, opened.size, Math.max(0, opened.size - window), window, false);
  } finally {
    try { closeSync(opened.fd); } catch { /* already closed */ }
  }
}

/**
 * Complete records from byte `from` to EOF, scanning at most `maxScanBytes`.
 * Null when the file is missing, unreadable, or SHORTER than `from` (rewritten
 * or truncated — the caller must start over rather than trust its offset).
 */
export function readCodexRolloutFrom(
  file: string,
  from: number,
  maxScanBytes: number = CODEX_ROLLOUT_MAX_SCAN_BYTES,
): CodexRolloutRead | null {
  const opened = openRollout(file);
  if (!opened) return null;
  try {
    if (!Number.isSafeInteger(from) || from < 0 || from > opened.size) return null;
    return readRange(opened.fd, opened.size, from, Math.max(1, maxScanBytes), false);
  } finally {
    try { closeSync(opened.fd); } catch { /* already closed */ }
  }
}

/** What one read of a rollout says, in the shape the spec names. */
export interface CodexRolloutSummary {
  /** The LAST `token_count` in the window: occupancy and the window codex measured it against. */
  lastTokenCount: {
    /** `last_token_usage.total_tokens` — live occupancy (see file header). */
    lastTotalTokens: number;
    /** `last_token_usage.input_tokens` — that call's prompt alone. */
    lastInputTokens: number;
    modelContextWindow: number | null;
    /** Cumulative `total_token_usage` at that point. */
    total: CodexTokenTotals;
  } | null;
  /** `model_context_window` of the last `task_started` in the window. */
  taskStartedWindow: number | null;
  /** `compacted` records at or after `afterOffset`. */
  compactions: number;
  size: number;
  end: number;
}

/**
 * One-shot extraction from a rollout's tail (or from `afterOffset`, when
 * given). Missing or pruned file → null; never throws.
 */
export function summarizeCodexRollout(
  file: string,
  opts: { afterOffset?: number; maxBytes?: number } = {},
): CodexRolloutSummary | null {
  const read = opts.afterOffset !== undefined
    ? readCodexRolloutFrom(file, opts.afterOffset, opts.maxBytes ?? CODEX_ROLLOUT_MAX_SCAN_BYTES)
    : readCodexRolloutTail(file, opts.maxBytes ?? CODEX_ROLLOUT_TAIL_BYTES);
  if (!read) return null;
  let lastTokenCount: CodexRolloutSummary['lastTokenCount'] = null;
  let taskStartedWindow: number | null = null;
  let compactions = 0;
  const after = opts.afterOffset ?? 0;
  for (const record of read.records) {
    if (record.kind === 'token-count') {
      lastTokenCount = {
        lastTotalTokens: codexOccupancy(record.last),
        lastInputTokens: record.last.inputTokens,
        modelContextWindow: record.modelContextWindow,
        total: record.total,
      };
    } else if (record.kind === 'task-started') {
      taskStartedWindow = record.modelContextWindow ?? taskStartedWindow;
    } else if (record.kind === 'compacted' && record.offset >= after) {
      compactions += 1;
    }
  }
  return { lastTokenCount, taskStartedWindow, compactions, size: read.size, end: read.end };
}

// ---------------------------------------------------------------------------
// Locating a seat's rollouts
// ---------------------------------------------------------------------------

function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

const nativeStateCache = new Map<string, string>();

function isCleanAbsolute(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 4096 && isAbsolute(value) &&
    normalize(value) === value && !value.includes('\0');
}

/**
 * The CODEX_HOME a seat's launcher pins, derived from the launcher argv the
 * session was created with — the same `<profile>/launcher.mjs` ⇒
 * `<profile>/native-state` relation `accounts.ts` (codexSessionRoots) and
 * `mcp-seat-view.ts` use, preferring the profile's own `profile.json`
 * `nativeStatePath` when it is readable.
 *
 * Null for a launcher-less seat: Verse never reads the unpinned global
 * `~/.codex`, whose rollouts belong to other tools and other accounts.
 */
export function codexNativeStatePath(launcher: readonly string[] | null | undefined): string | null {
  if (!Array.isArray(launcher)) return null;
  const launcherPath = [...launcher].reverse().find((part) =>
    isCleanAbsolute(part) && basename(part) === 'launcher.mjs');
  if (!launcherPath) return null;
  const cached = nativeStateCache.get(launcherPath);
  if (cached) return cached;

  const profileDir = dirname(launcherPath);
  let resolved = join(profileDir, 'native-state');
  try {
    const manifestPath = join(profileDir, 'profile.json');
    const stat = lstatSync(manifestPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_PROFILE_BYTES) {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (isObject(manifest)) {
        const provider = manifest['provider'];
        if (provider !== undefined && provider !== 'codex') return null;
        if (isCleanAbsolute(manifest['nativeStatePath'])) resolved = manifest['nativeStatePath'];
      }
    }
  } catch {
    // No manifest (or an unreadable one): the launcher's sibling is the pinned home.
  }
  boundedSet(nativeStateCache, launcherPath, resolved);
  return resolved;
}

/**
 * Codex thread ids are UUIDs (v7 on every CLI this was verified against). The
 * id is interpolated into a filename match, so anything else is refused.
 */
const THREAD_ID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export function isCodexThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID_RE.test(value);
}

/** Creation time embedded in a UUIDv7 (first 48 bits, epoch ms), else null. */
export function uuidV7Millis(id: string): number | null {
  if (!isCodexThreadId(id) || id[14] !== '7') return null;
  const ms = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  // Sanity window: 2020 … 2100. Anything outside is not a timestamp.
  return Number.isSafeInteger(ms) && ms > 1_577_836_800_000 && ms < 4_102_444_800_000 ? ms : null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `YYYY/MM/DD` in LOCAL time — codex names both the directory and the file from local time. */
function localDayPath(ms: number): string[] {
  const d = new Date(ms);
  return [String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate())];
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function rolloutIn(dir: string, suffix: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const name of safeReaddir(dir)) {
    if (!name.startsWith('rollout-') || !name.endsWith(suffix)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (!best || stat.mtimeMs > best.mtime) best = { path, mtime: stat.mtimeMs };
    } catch {
      // Pruned between readdir and lstat.
    }
  }
  return best?.path ?? null;
}

const rolloutCache = new Map<string, string>();

function stillRollout(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export interface LocateCodexRolloutOptions {
  /**
   * Also run the bounded newest-first scan of every day directory when the
   * id's own date does not hold the file. Callers polling every few seconds
   * pass false after their first attempt so a missing file costs three
   * `readdir`s, not hundreds.
   */
  fullScan?: boolean;
}

/**
 * Path of the rollout for `threadId` under `<nativeStatePath>/sessions`, or
 * null when there is none (never run, pruned, `--ephemeral`, unreadable).
 *
 * Cheap path first: a UUIDv7 id carries its creation instant, so the file is
 * in that LOCAL day's directory (±1 day for a timezone change or a thread
 * created just before midnight). Otherwise a bounded newest-first descent.
 * If several files match (never observed), the most recently written wins.
 */
export function locateCodexRollout(
  nativeStatePath: string,
  threadId: string,
  opts: LocateCodexRolloutOptions = {},
): string | null {
  if (!isCleanAbsolute(nativeStatePath) || !isCodexThreadId(threadId)) return null;
  const sessionsRoot = join(nativeStatePath, 'sessions');
  const key = `${sessionsRoot}\0${threadId}`;
  const cached = rolloutCache.get(key);
  if (cached && stillRollout(cached)) return cached;
  if (cached) rolloutCache.delete(key);

  const suffix = `-${threadId}.jsonl`;
  const remember = (path: string | null): string | null => {
    if (path) boundedSet(rolloutCache, key, path);
    return path;
  };

  const created = uuidV7Millis(threadId);
  if (created !== null) {
    const day = 24 * 60 * 60 * 1000;
    const tried = new Set<string>();
    for (const ms of [created, created - day, created + day]) {
      const dir = join(sessionsRoot, ...localDayPath(ms));
      if (tried.has(dir)) continue;
      tried.add(dir);
      const found = rolloutIn(dir, suffix);
      if (found) return remember(found);
    }
  }
  if (opts.fullScan === false) return null;

  let dirsOpened = 0;
  const years = safeReaddir(sessionsRoot).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  for (const year of years) {
    const months = safeReaddir(join(sessionsRoot, year)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
    for (const month of months) {
      const days = safeReaddir(join(sessionsRoot, year, month)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
      for (const dayName of days) {
        if (++dirsOpened > MAX_DAY_DIRS) return null;
        const found = rolloutIn(join(sessionsRoot, year, month, dayName), suffix);
        if (found) return remember(found);
      }
    }
  }
  return null;
}

/** Test seam: forget cached profile and rollout paths. */
export function resetCodexRolloutCaches(): void {
  nativeStateCache.clear();
  rolloutCache.clear();
}

// ---------------------------------------------------------------------------
// Per-turn accounting
// ---------------------------------------------------------------------------

export interface CodexCompactionObservation {
  /** Occupancy at the last reading before the compaction (this turn's or the previous turn's). */
  preTokens: number | null;
  /** Occupancy of the first reading after it; null until one is seen. */
  postTokens: number | null;
}

/**
 * Everything one turn has learned from its thread's rollout. Plain data, held
 * in the adapter hook's per-turn `ctx.state`, advanced by
 * `advanceCodexTurnTracker` on every poll and once more after the turn.
 */
export interface CodexTurnTracker {
  file: string | null;
  ino: number | null;
  /** Where the next incremental read starts. */
  offset: number;
  /** `offset` lands inside a line (a skipped oversized line); drop up to the next newline. */
  midLine: boolean;
  /** The first read (turn-start discovery) has happened. */
  initialized: boolean;
  /** This turn's first record was located, so everything it wrote has been seen. */
  regionFound: boolean;
  /** Some bytes this turn wrote were skipped (scan budget / tail cap). Sums are then partial. */
  gap: boolean;
  /** Cumulative totals just before this turn; `ZERO` when the thread had none; null when unknown. */
  baseline: CodexTokenTotals | null;
  /** Cumulative `total_tokens` of the latest token_count seen — a record that repeats it is not a new call. */
  prevTotalTokens: number | null;
  /** Model calls this turn and the sum of their `last_token_usage`. */
  calls: number;
  callSum: CodexTokenTotals;
  /** Cumulative totals at this turn's first and latest call (the first call's own usage alongside). */
  firstCall: { total: CodexTokenTotals; last: CodexTokenTotals } | null;
  lastTotals: CodexTokenTotals | null;
  /** The CLI's own per-turn figure (0.149+ `token_usage_record.turn_token_usage`), when written. */
  turnUsage: CodexTokenTotals | null;
  /** The latest occupancy reading, and whether this turn produced it. */
  reading: { tokens: number; window: number | null; inTurn: boolean; offset: number } | null;
  /** `task_started.model_context_window` of this turn. */
  taskStartedWindow: number | null;
  compactions: CodexCompactionObservation[];
}

export function createCodexTurnTracker(): CodexTurnTracker {
  return {
    file: null,
    ino: null,
    offset: 0,
    midLine: false,
    initialized: false,
    regionFound: false,
    gap: false,
    baseline: null,
    prevTotalTokens: null,
    calls: 0,
    callSum: { ...ZERO_CODEX_TOTALS },
    firstCall: null,
    lastTotals: null,
    turnUsage: null,
    reading: null,
    taskStartedWindow: null,
    compactions: [],
  };
}

/** Reset everything a (re)discovery recomputes, keeping only the file identity. */
function resetAccounting(tracker: CodexTurnTracker): void {
  const fresh = createCodexTurnTracker();
  Object.assign(tracker, { ...fresh, file: tracker.file, ino: tracker.ino });
}

function applyRecord(tracker: CodexTurnTracker, record: CodexRolloutRecord, inTurn: boolean, threadId: string | null): void {
  switch (record.kind) {
    case 'token-count': {
      tracker.reading = {
        tokens: codexOccupancy(record.last),
        window: record.modelContextWindow ?? tracker.taskStartedWindow,
        inTurn,
        offset: record.offset,
      };
      if (!inTurn) {
        tracker.baseline = record.total;
        tracker.prevTotalTokens = record.total.totalTokens;
        return;
      }
      const newCall = tracker.prevTotalTokens === null || record.total.totalTokens !== tracker.prevTotalTokens;
      if (newCall) {
        tracker.calls += 1;
        tracker.callSum = addCodexTotals(tracker.callSum, record.last);
        tracker.firstCall ??= { total: record.total, last: record.last };
      }
      tracker.lastTotals = record.total;
      tracker.prevTotalTokens = record.total.totalTokens;
      for (const compaction of tracker.compactions) {
        if (compaction.postTokens === null) compaction.postTokens = tracker.reading.tokens;
      }
      return;
    }
    case 'compacted':
      if (inTurn) tracker.compactions.push({ preTokens: tracker.reading?.tokens ?? null, postTokens: null });
      return;
    case 'task-started':
      if (inTurn) tracker.taskStartedWindow = record.modelContextWindow ?? tracker.taskStartedWindow;
      return;
    case 'token-usage-record':
      if (inTurn && record.turn && (threadId === null || record.threadId === null || record.threadId === threadId)) {
        tracker.turnUsage = record.turn;
      }
      return;
    default:
      return;
  }
}

/**
 * Turn-start discovery. Records written at or after `startedAtMs` (the spawn
 * instant) belong to this turn: an `exec` process runs exactly one turn, and
 * the previous turn's process had exited before this one was spawned.
 */
function discover(tracker: CodexTurnTracker, fd: number, size: number, startedAtMs: number, threadId: string | null): void {
  for (let window = CODEX_ROLLOUT_TAIL_BYTES; ; window *= 2) {
    const capped = Math.min(window, CODEX_ROLLOUT_MAX_TAIL_BYTES);
    const read = readRange(fd, size, Math.max(0, size - capped), capped, false);
    const atFileStart = read.start === 0;
    let regionIndex = -1;
    for (let i = read.records.length - 1; i >= 0; i--) {
      const at = read.records[i]!.at;
      if (at !== null && at < startedAtMs) { regionIndex = i + 1; break; }
    }
    const regionFound = regionIndex !== -1 || atFileStart;
    if (regionIndex === -1) regionIndex = 0;
    const baselineInWindow = read.records.slice(0, regionIndex).some((r) => r.kind === 'token-count');
    const settled = (regionFound && (baselineInWindow || atFileStart)) || capped >= CODEX_ROLLOUT_MAX_TAIL_BYTES;
    if (!settled) continue;

    resetAccounting(tracker);
    tracker.initialized = true;
    tracker.regionFound = regionFound;
    tracker.gap = !regionFound || read.skipped;
    // No token_count before this turn in a window that reaches the file start: the thread had no calls yet.
    if (atFileStart) {
      tracker.baseline = { ...ZERO_CODEX_TOTALS };
      tracker.prevTotalTokens = 0;
    }
    read.records.forEach((record, index) => applyRecord(tracker, record, index >= regionIndex, threadId));
    if (!regionFound) tracker.baseline = null;
    tracker.offset = read.end;
    tracker.midLine = false;
    return;
  }
}

/**
 * Bring a turn's tracker up to date with `file`. Returns false when the file
 * cannot be read (the tracker keeps what it had). Bounded: one discovery of
 * ≤ CODEX_ROLLOUT_MAX_TAIL_BYTES, then ≤ CODEX_ROLLOUT_MAX_SCAN_BYTES per call.
 */
export function advanceCodexTurnTracker(
  tracker: CodexTurnTracker,
  file: string,
  startedAtMs: number,
  threadId: string | null = null,
): boolean {
  const opened = openRollout(file);
  if (!opened) return false;
  try {
    const rewritten = tracker.file !== file || tracker.ino !== opened.ino || opened.size < tracker.offset;
    if (!tracker.initialized || rewritten) {
      tracker.file = file;
      tracker.ino = opened.ino;
      // A rewritten file (0.155 `migrate-rollouts`, a prune) invalidates every
      // offset: rediscover from timestamps, which recomputes the turn exactly.
      discover(tracker, opened.fd, opened.size, startedAtMs, threadId);
      return true;
    }
    if (opened.size === tracker.offset) return true;
    let from = tracker.offset;
    let midLine = tracker.midLine;
    if (opened.size - from > CODEX_ROLLOUT_MAX_SCAN_BYTES) {
      // Too much appeared at once: keep the newest tail, account the rest as a gap.
      from = opened.size - CODEX_ROLLOUT_TAIL_BYTES;
      midLine = byteBefore(opened.fd, from) !== NEWLINE;
      tracker.gap = true;
    }
    const read = readRange(opened.fd, opened.size, from, CODEX_ROLLOUT_MAX_SCAN_BYTES, midLine);
    for (const record of read.records) applyRecord(tracker, record, true, threadId);
    if (read.skipped && read.end <= from) {
      // One line longer than the whole scan budget: step past what was read
      // and drop the rest of that line next time.
      tracker.offset = Math.min(opened.size, from + CODEX_ROLLOUT_MAX_SCAN_BYTES);
      tracker.midLine = true;
      tracker.gap = true;
    } else {
      tracker.offset = read.end;
      tracker.midLine = false;
    }
    return true;
  } finally {
    try { closeSync(opened.fd); } catch { /* already closed */ }
  }
}

export type CodexTurnUsageSource =
  /** The CLI's own per-turn record (0.149+). */
  | 'turn-record'
  /** Sum of every call this turn made, all of which were seen. */
  | 'calls'
  /** `turn.completed.usage` as printed (a first turn, or a per-turn figure). */
  | 'reported'
  /** `turn.completed.usage` was the thread's running total; the pre-turn total was subtracted. */
  | 'reported-delta'
  /** Only part of the turn was seen; the calls that were. A lower bound. */
  | 'calls-partial';

export interface CodexTurnUsage {
  totals: CodexTokenTotals;
  source: CodexTurnUsageSource;
}

function sameUsage(a: CodexTokenTotals, b: CodexTokenTotals): boolean {
  return a.inputTokens === b.inputTokens && a.cachedInputTokens === b.cachedInputTokens && a.outputTokens === b.outputTokens;
}

/**
 * This turn's true usage, from the best evidence available.
 *
 * WHY `turn.completed` IS NOT TRUSTED ON ITS OWN: codex prints its session's
 * `total_token_usage` there, and on `exec resume` that session is seeded from
 * the rollout — so turn 5 reports turns 1–5. Summing it per turn (which is
 * what the engine does with `usage` events) would count turn 1 five times.
 * The rollout's per-call records are the ground truth either way; the printed
 * figure is used only when the rollout cannot answer, and even then a figure
 * that equals the rollout's running total is converted to a delta.
 *
 * Verified on this machine's rollouts (221 turns with a CLI per-turn record):
 * the per-call sum equals codex's own `turn_token_usage` exactly on every
 * fully observed turn WITHOUT a compaction; with one, the record is larger by
 * that compaction request's usage, which codex never writes as a
 * `token_count` (its running total does not move either). The record is
 * therefore preferred when present (0.149+); on older CLIs no codex surface —
 * rollout or stdout — counts compaction requests, and neither does this.
 *
 * @param reported   `turn.completed.usage` (null when the turn printed none)
 * @param firstTurn  true when this turn STARTED the thread — its printed
 *                   figure is per-turn by construction
 */
export function codexTurnUsage(
  tracker: CodexTurnTracker | null,
  reported: CodexTokenTotals | null,
  firstTurn: boolean,
): CodexTurnUsage | null {
  if (tracker?.turnUsage) return { totals: tracker.turnUsage, source: 'turn-record' };
  if (tracker && tracker.calls > 0 && tracker.regionFound && !tracker.gap) {
    return { totals: tracker.callSum, source: 'calls' };
  }
  if (reported) {
    if (firstTurn || !tracker?.lastTotals || !sameUsage(reported, tracker.lastTotals)) {
      return { totals: reported, source: 'reported' };
    }
    // The printed figure IS the running total.
    if (tracker.baseline) return { totals: subtractCodexTotals(reported, tracker.baseline), source: 'reported-delta' };
    if (tracker.firstCall) {
      const before = subtractCodexTotals(tracker.firstCall.total, tracker.firstCall.last);
      return { totals: subtractCodexTotals(reported, before), source: 'calls-partial' };
    }
    return { totals: reported, source: 'reported' };
  }
  if (tracker && tracker.calls > 0) return { totals: tracker.callSum, source: 'calls-partial' };
  return null;
}

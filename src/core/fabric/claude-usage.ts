/**
 * claude-usage.ts — M253 real-time Claude subscription usage reader.
 *
 * Reads ~/.claude/projects/**\/*.jsonl (the ccusage method) to compute actual
 * rolling token consumption over a 5-hour and 7-day window. This is the ONLY
 * programmatically-accessible source of Claude Code subscription usage —
 * stats-cache.json is dead on most machines.
 *
 * TOKEN WEIGHTING:
 *   total = input_tokens + output_tokens
 *         + cache_creation_input_tokens + cache_read_input_tokens
 *
 *   All four fields count toward the subscription limit (Anthropic bills and
 *   rate-limits on the sum of all input variants plus output). cache_read is
 *   discounted by Anthropic on cost (~10x cheaper) but still consumes message
 *   quota, so we count it at 1:1 for conservative availability estimation.
 *   The ccusage project uses the same four-field sum.
 *
 * PUBLISHED CLAUDE CODE SUBSCRIPTION LIMITS (as of 2025, Anthropic docs):
 *   Pro  ($20/mo):  ~900 messages / 5h rolling window (varies by model)
 *   Max5 ($100/mo): ~5× Pro ≈ 4500 messages / 5h (Anthropic published "5x more")
 *   Max20($200/mo): ~20× Pro ≈ unlimited/"much higher" (Anthropic: "20x more")
 *
 *   Anthropic does NOT publish a per-5h TOKEN cap; the cap is message-count
 *   based. Token totals are still the best proxy: a high token session burns
 *   multiple "message credits" faster. We offer both token and message counting
 *   and default to messages (most conservative / most comparable to the plan).
 *
 *   Config overrides: foundry.claudeResource.{fiveHourTokenCap, weeklyTokenCap,
 *   fiveHourMessageCap, weeklyMessageCap, protectPct}
 *
 * PERFORMANCE:
 *   Files older than the window are skipped by mtime. Hard cap: scans up to
 *   MAX_FILES_PER_CALL files per call (most recent first by mtime). Each file's
 *   parsed records are kept with the byte offset they cover, so a refresh
 *   parses only appended bytes (see "Incremental reader"). 30-second
 *   module-level result cache on top.
 *
 * PRIVACY: reads ONLY token counts + timestamps from message.usage — never
 *   message content, tool args/results, prompts, or completions.
 *
 * NEVER THROWS.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Published default limits (Anthropic Claude Code subscription, 2025)
// ---------------------------------------------------------------------------

/**
 * Default 5-hour message caps by plan tier.
 * Source: Anthropic support docs + ccusage community calibration.
 * Pro ≈ 900 msgs/5h; Max5 ≈ 4500; Max20 ≈ "very high" (we use 9000 as floor).
 */
export const DEFAULT_5H_MESSAGE_CAP_PRO   = 900;
export const DEFAULT_5H_MESSAGE_CAP_MAX5  = 4500;
export const DEFAULT_5H_MESSAGE_CAP_MAX20 = 9000;

/**
 * Default 7-day message caps (conservative weekly limits).
 * Not officially published; derived as 7 × 24/5 × 5h cap (rolling windows overlap).
 */
export const DEFAULT_7D_MESSAGE_CAP_PRO   = DEFAULT_5H_MESSAGE_CAP_PRO   * Math.floor((7 * 24) / 5); // ≈30k
export const DEFAULT_7D_MESSAGE_CAP_MAX5  = DEFAULT_5H_MESSAGE_CAP_MAX5  * Math.floor((7 * 24) / 5); // ≈150k
export const DEFAULT_7D_MESSAGE_CAP_MAX20 = DEFAULT_5H_MESSAGE_CAP_MAX20 * Math.floor((7 * 24) / 5); // ≈300k

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaudeUsageResult {
  /** Rolling 5-hour token total (input + output + cache_create + cache_read). */
  tokens5h: number;
  /** Rolling 7-day token total. */
  tokens7d: number;
  /** Number of distinct assistant messages in the 5h window. */
  messages5h: number;
  /** Number of distinct assistant messages in the 7d window. */
  messages7d: number;
  /** Epoch ms when this reading was taken. */
  readAt: number;
  /** Number of JSONL files scanned (capped at MAX_FILES_PER_CALL). */
  filesScanned: number;
}

// ---------------------------------------------------------------------------
// Incremental reader
// ---------------------------------------------------------------------------
//
// PERF (3.10): this used to re-read and JSON-parse every transcript touched in
// the last 7 days on every cache miss — ~124 files, ~330 ms of synchronous
// work — and the Verse UI's 30 s poll missed the 30 s cache every time, so the
// server froze for a third of a second twice a minute. Transcripts are
// append-only JSONL, so each file's parsed (timestamp, tokens) records are now
// kept with the byte offset they cover; a miss stats the tree and parses only
// the bytes appended since. A file that shrank, was replaced (inode/birth
// time), or whose bytes just before the saved offset changed is re-read from
// the start, so a rewrite can never be double-counted.

const READ_CHUNK   = 64 * 1024;          // 64 KiB per chunk
const MAX_BYTES    = 256 * 1024 * 1024;  // 256 MiB per file hard-cap
/** Max files scanned per readClaudeUsage call — prevents long-tail slowness. */
const MAX_FILES_PER_CALL = 500;
/** Bytes before the saved offset that must be unchanged for an append-only read. */
const GUARD_BYTES = 64;
const NEWLINE = 0x0a;

/**
 * `key` is the response identity (message.id + requestId), null when the line
 * has none. Claude Code writes one line PER CONTENT BLOCK (thinking, text,
 * each tool_use), every one repeating the response's id and full usage, so
 * the aggregate counts each key once — otherwise a reply with three tool
 * calls counted as four messages and four times its tokens.
 */
interface UsageRecord { ts: number; total: number; key: string | null }

interface FileUsageState {
  ino: number;
  birthtimeMs: number;
  size: number;
  mtimeMs: number;
  /** Bytes consumed through the last complete line. */
  committedOffset: number;
  /** Up to GUARD_BYTES ending at committedOffset, to detect in-place rewrites. */
  guard: Buffer;
  /** Records from complete lines (pruned to the 7-day horizon each scan). */
  records: UsageRecord[];
  /** Records from a trailing line without a newline yet; re-parsed next scan. */
  tailRecords: UsageRecord[];
}

let fileStates = new Map<string, FileUsageState>();
let fileStatesRoot: string | null = null;

/**
 * Parse one JSONL line into a usage record, or null. Reads ONLY the
 * timestamp and message.usage token counts (privacy contract above).
 */
function parseUsageLine(line: string): UsageRecord | null {
  // Every counted line carries a "usage" key; skipping the rest without a
  // JSON.parse is most of the cold-read win (tool results are the big lines).
  if (!line.includes('"usage"')) return null;
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o['type'] !== 'assistant') return null;
  const tsStr = o['timestamp'];
  if (typeof tsStr !== 'string') return null;
  const tsMs = new Date(tsStr).getTime();
  if (isNaN(tsMs)) return null;
  const msg = o['message'];
  if (typeof msg !== 'object' || msg === null) return null;
  const usage = (msg as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const tin   = typeof u['input_tokens']                === 'number' ? (u['input_tokens']                as number) : 0;
  const tout  = typeof u['output_tokens']               === 'number' ? (u['output_tokens']               as number) : 0;
  const tcr   = typeof u['cache_read_input_tokens']     === 'number' ? (u['cache_read_input_tokens']     as number) : 0;
  const tcw   = typeof u['cache_creation_input_tokens'] === 'number' ? (u['cache_creation_input_tokens'] as number) : 0;
  const total = tin + tout + tcr + tcw;
  if (total === 0) return null;
  const id = (msg as Record<string, unknown>)['id'];
  const requestId = typeof o['requestId'] === 'string' ? o['requestId'] : '';
  const key = typeof id === 'string' && id.length > 0 ? `${id}\u0000${requestId}` : null;
  return { ts: tsMs, total, key };
}

function pushLines(text: string, into: UsageRecord[], sinceMs: number): void {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const rec = parseUsageLine(line);
    if (rec && rec.ts >= sinceMs) into.push(rec);
  }
}

function readGuard(fd: number, offset: number): Buffer | null {
  const len = Math.min(GUARD_BYTES, offset);
  const buf = Buffer.alloc(len);
  if (len === 0) return buf;
  try {
    const n = fs.readSync(fd, buf, 0, len, offset - len);
    return n === len ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Bring one file's state up to date. Reads from the saved offset when the
 * file only grew; from 0 otherwise. Byte-level newline splitting keeps
 * multi-byte UTF-8 intact across chunk boundaries (0x0a never occurs inside a
 * multi-byte sequence). Returns null when the file cannot be read at all.
 */
function refreshFile(
  filePath: string,
  st: fs.Stats,
  prev: FileUsageState | undefined,
  sinceMs: number,
): FileUsageState | null {
  if (prev && prev.ino === st.ino && prev.birthtimeMs === st.birthtimeMs &&
      prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
    return prev;
  }
  let fd: number;
  try { fd = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    let offset = 0;
    let records: UsageRecord[] = [];
    if (prev && prev.ino === st.ino && prev.birthtimeMs === st.birthtimeMs && st.size >= prev.committedOffset) {
      const guard = readGuard(fd, prev.committedOffset);
      if (guard !== null && guard.equals(prev.guard)) {
        offset = prev.committedOffset;
        records = prev.records;
      }
    }
    const acc = new LineAccumulator(offset, records, sinceMs);
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      if (acc.position >= MAX_BYTES) break;
      let n: number;
      try { n = fs.readSync(fd, chunk, 0, Math.min(READ_CHUNK, MAX_BYTES - acc.position), acc.position); } catch { break; }
      if (n <= 0) break;
      acc.push(chunk.subarray(0, n));
    }
    return acc.finish(st, readGuard(fd, acc.committed));
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Splits a byte stream into complete lines and parses them into records. */
class LineAccumulator {
  position: number;
  committed: number;
  /** Bytes after the last newline, kept as parts so a multi-MB line is not re-copied per chunk. */
  private pending: Buffer[] = [];

  constructor(offset: number, private readonly records: UsageRecord[], private readonly sinceMs: number) {
    this.position = offset;
    this.committed = offset;
  }

  push(bytes: Buffer): void {
    this.position += bytes.length;
    const lastNl = bytes.lastIndexOf(NEWLINE);
    if (lastNl === -1) {
      this.pending.push(Buffer.from(bytes));
      return;
    }
    const head = bytes.subarray(0, lastNl);
    const text = this.pending.length > 0
      ? Buffer.concat([...this.pending, head]).toString('utf8')
      : head.toString('utf8');
    const consumed = this.pending.reduce((n, part) => n + part.length, 0) + lastNl + 1;
    pushLines(text, this.records, this.sinceMs);
    this.committed += consumed;
    this.pending = lastNl + 1 < bytes.length ? [Buffer.from(bytes.subarray(lastNl + 1))] : [];
  }

  finish(st: fs.Stats, guard: Buffer | null): FileUsageState {
    const tailRecords: UsageRecord[] = [];
    if (this.pending.length > 0) pushLines(Buffer.concat(this.pending).toString('utf8'), tailRecords, this.sinceMs);
    return {
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      size: st.size,
      mtimeMs: st.mtimeMs,
      committedOffset: this.committed,
      guard: guard ?? Buffer.alloc(0),
      records: this.records,
      tailRecords,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level cache (30 seconds)
// ---------------------------------------------------------------------------

interface UsageCache {
  result: ClaudeUsageResult;
  expiresAt: number;
}

let _cache: UsageCache | null = null;
const CACHE_TTL_MS = 30_000;

// Overridable for tests (set process.env.CLAUDE_PROJECTS_DIR)
function claudeProjectsDir(): string {
  return process.env['CLAUDE_PROJECTS_DIR']
    ?? path.join(os.homedir(), '.claude', 'projects');
}

// ---------------------------------------------------------------------------
// Core reader
// ---------------------------------------------------------------------------

/**
 * Walk ~/.claude/projects/**\/*.jsonl and sum message.usage token counts for
 * assistant messages whose timestamp falls within windowMs of now.
 *
 * Returns both 5h and 7d windows in one pass. Cached for 30 seconds; a miss
 * parses only bytes appended since the previous scan. Never throws.
 */
export function readClaudeUsage(): ClaudeUsageResult {
  const now = Date.now();

  // Return cached result if fresh
  if (_cache && _cache.expiresAt > now) return _cache.result;

  const empty: ClaudeUsageResult = {
    tokens5h: 0, tokens7d: 0,
    messages5h: 0, messages7d: 0,
    readAt: now, filesScanned: 0,
  };

  try {
    const projectsRoot = claudeProjectsDir();
    if (fileStatesRoot !== projectsRoot) {
      fileStates = new Map();
      fileStatesRoot = projectsRoot;
    }
    const window5h = 5 * 60 * 60 * 1000;
    const window7d  = 7 * 24 * 60 * 60 * 1000;
    const since7d   = now - window7d;
    const since5h   = now - window5h;

    // Collect all JSONL files with mtime >= since7d, sorted newest-first
    type FileEntry = { filePath: string; mtime: number; stat: fs.Stats };
    const candidates: FileEntry[] = [];

    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(projectsRoot);
    } catch {
      fileStates = new Map();
      return cacheAndReturn(empty, now);
    }

    for (const dirName of projectDirs) {
      const dirPath = path.join(projectsRoot, dirName);
      let stat: fs.Stats;
      try { stat = fs.statSync(dirPath); } catch { continue; }
      if (!stat.isDirectory()) continue;

      // Also check subdirectory (subagents/) for nested session files
      const subDirs = [dirPath];
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) subDirs.push(path.join(dirPath, e.name));
        }
      } catch { /* ignore */ }

      for (const subDir of subDirs) {
        let files: fs.Dirent[];
        try { files = fs.readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const filePath = path.join(subDir, f.name);
          let fstat: fs.Stats;
          try { fstat = fs.statSync(filePath); } catch { continue; }
          if (fstat.mtimeMs >= since7d) {
            candidates.push({ filePath, mtime: fstat.mtimeMs, stat: fstat });
          }
        }
      }
    }

    // Sort newest-first, cap to MAX_FILES_PER_CALL
    candidates.sort((a, b) => b.mtime - a.mtime);
    const toScan = candidates.slice(0, MAX_FILES_PER_CALL);

    let tokens5h = 0, tokens7d = 0;
    let messages5h = 0, messages7d = 0;
    const nextStates = new Map<string, FileUsageState>();
    // Keyed records already counted, across files (a resumed session can
    // replay earlier responses into a new transcript): first ts + counted total.
    const counted = new Map<string, { ts: number; total: number }>();

    for (const { filePath, stat } of toScan) {
      const state = refreshFile(filePath, stat, fileStates.get(filePath), since7d);
      if (!state) continue;
      // Age out records that left the 7-day horizon so memory stays bounded.
      if (state.records.length > 0 && state.records[0]!.ts < since7d) {
        state.records = state.records.filter((r) => r.ts >= since7d);
      }
      nextStates.set(filePath, state);
      for (const list of [state.records, state.tailRecords]) {
        for (const r of list) {
          if (r.ts < since7d) continue;
          if (r.key !== null) {
            const prev = counted.get(r.key);
            if (prev) {
              // A repeat line of a counted response: never a new message; its
              // tokens only if a later copy reports more (a streamed early copy).
              if (r.total > prev.total) {
                const delta = r.total - prev.total;
                tokens7d += delta;
                if (prev.ts >= since5h) tokens5h += delta;
                prev.total = r.total;
              }
              continue;
            }
            counted.set(r.key, { ts: r.ts, total: r.total });
          }
          tokens7d += r.total;
          messages7d += 1;
          if (r.ts >= since5h) {
            tokens5h += r.total;
            messages5h += 1;
          }
        }
      }
    }
    // Files that fell out of the window (or were deleted) are forgotten.
    fileStates = nextStates;

    const result: ClaudeUsageResult = {
      tokens5h, tokens7d,
      messages5h, messages7d,
      readAt: now,
      filesScanned: toScan.length,
    };
    return cacheAndReturn(result, now);
  } catch {
    return cacheAndReturn(empty, now);
  }
}

function cacheAndReturn(result: ClaudeUsageResult, now: number): ClaudeUsageResult {
  _cache = { result, expiresAt: now + CACHE_TTL_MS };
  return result;
}

/**
 * Invalidate the cache (used in tests and after config changes). Also drops
 * the per-file parse state, so the next read is a full, from-scratch scan.
 */
export function invalidateClaudeUsageCache(): void {
  _cache = null;
  fileStates = new Map();
  fileStatesRoot = null;
}

/**
 * Do the expensive first read (every transcript of the last 7 days, ~116 MB
 * on a busy machine, ~360 ms synchronous) asynchronously, one 64 KiB chunk
 * per event-loop turn, so a server can warm this at startup without freezing.
 * Afterwards readClaudeUsage() only parses appended bytes. A file whose stat
 * changes during the async read is simply left for the sync path. Never
 * throws; concurrent calls share one run.
 */
export function primeClaudeUsage(): Promise<void> {
  if (primeInFlight) return primeInFlight;
  primeInFlight = primeAsync().catch(() => { /* never throws */ }).finally(() => {
    primeInFlight = null;
  });
  return primeInFlight;
}

let primeInFlight: Promise<void> | null = null;

async function primeAsync(): Promise<void> {
  const projectsRoot = claudeProjectsDir();
  const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const fsp = fs.promises;
  const files: Array<{ filePath: string; mtime: number }> = [];
  let projectDirs: string[];
  try { projectDirs = await fsp.readdir(projectsRoot); } catch { return; }
  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsRoot, dirName);
    const subDirs = [dirPath];
    try {
      for (const e of await fsp.readdir(dirPath, { withFileTypes: true })) {
        if (e.isDirectory()) subDirs.push(path.join(dirPath, e.name));
      }
    } catch { continue; }
    for (const subDir of subDirs) {
      let entries: fs.Dirent[];
      try { entries = await fsp.readdir(subDir, { withFileTypes: true }); } catch { continue; }
      for (const f of entries) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const filePath = path.join(subDir, f.name);
        try {
          const st = await fsp.stat(filePath);
          if (st.mtimeMs >= since7d) files.push({ filePath, mtime: st.mtimeMs });
        } catch { /* vanished */ }
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  for (const { filePath } of files.slice(0, MAX_FILES_PER_CALL)) {
    if (fileStatesRoot !== null && fileStatesRoot !== projectsRoot) return;
    let handle: fs.promises.FileHandle;
    try { handle = await fsp.open(filePath, 'r'); } catch { continue; }
    try {
      const st = await handle.stat();
      const known = fileStatesRoot === projectsRoot ? fileStates.get(filePath) : undefined;
      if (known && known.ino === st.ino && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
      const acc = new LineAccumulator(0, [], since7d);
      for (;;) {
        if (acc.position >= MAX_BYTES) break;
        const { bytesRead } = await handle.read(chunk, 0, Math.min(READ_CHUNK, MAX_BYTES - acc.position), acc.position);
        if (bytesRead <= 0) break;
        acc.push(chunk.subarray(0, bytesRead));
      }
      const guardLen = Math.min(GUARD_BYTES, acc.committed);
      const guard = Buffer.alloc(guardLen);
      if (guardLen > 0) await handle.read(guard, 0, guardLen, acc.committed - guardLen);
      // Only adopt the result if the file did not move underneath us and the
      // sync path has not already produced something at least as new.
      const after = await handle.stat();
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) continue;
      if (fileStatesRoot === null) {
        fileStatesRoot = projectsRoot;
        fileStates = new Map();
      }
      if (fileStatesRoot !== projectsRoot) return;
      const current = fileStates.get(filePath);
      if (current && current.mtimeMs >= st.mtimeMs) continue;
      fileStates.set(filePath, acc.finish(st, guard));
    } catch {
      // Unreadable file: the sync path will try again on its own terms.
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

/**
 * Expire only the 30 s result cache, keeping per-file parse state — the next
 * read is the incremental path. For the perf benchmark and tests.
 */
export function expireClaudeUsageResultCache(): void {
  _cache = null;
}

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
 *   Reuses the existing eachLine + mtime-skip infrastructure from usage-source.ts.
 *   Files older than the window are skipped by mtime. Hard cap: scans up to
 *   MAX_FILES_PER_CALL files per call (most recent first by mtime). 30-second
 *   module-level cache to avoid hammering the filesystem on repeated calls.
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
// Internal streaming reader (mirrors usage-source.ts eachLine — kept local
// to avoid a circular import between fabric/ and observability/)
// ---------------------------------------------------------------------------

const READ_CHUNK   = 64 * 1024;          // 64 KiB per chunk
const MAX_BYTES    = 256 * 1024 * 1024;  // 256 MiB per file hard-cap
/** Max files scanned per readClaudeUsage call — prevents long-tail slowness. */
const MAX_FILES_PER_CALL = 500;

function eachLine(filePath: string, cb: (line: string) => void): void {
  let fd: number;
  try { fd = fs.openSync(filePath, 'r'); } catch { return; }
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    let pending = '';
    let bytesRead = 0;
    for (;;) {
      let n: number;
      try { n = fs.readSync(fd, chunk, 0, READ_CHUNK, null); } catch { break; }
      if (n <= 0) break;
      bytesRead += n;
      pending += chunk.toString('utf8', 0, n);
      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line.length > 0) cb(line);
      }
      if (bytesRead >= MAX_BYTES) break;
    }
    const last = pending.trim();
    if (last.length > 0) cb(last);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
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
 * Returns both 5h and 7d windows in one pass (cheapest: one filesystem scan).
 * Cached for 30 seconds. Never throws.
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
    const window5h = 5 * 60 * 60 * 1000;
    const window7d  = 7 * 24 * 60 * 60 * 1000;
    const since7d   = now - window7d;
    const since5h   = now - window5h;

    // Collect all JSONL files with mtime >= since7d, sorted newest-first
    type FileEntry = { filePath: string; mtime: number };
    const candidates: FileEntry[] = [];

    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(projectsRoot);
    } catch {
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
            candidates.push({ filePath, mtime: fstat.mtimeMs });
          }
        }
      }
    }

    // Sort newest-first, cap to MAX_FILES_PER_CALL
    candidates.sort((a, b) => b.mtime - a.mtime);
    const toScan = candidates.slice(0, MAX_FILES_PER_CALL);

    let tokens5h = 0, tokens7d = 0;
    let messages5h = 0, messages7d = 0;

    for (const { filePath } of toScan) {
      eachLine(filePath, (line) => {
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { return; }
        if (typeof obj !== 'object' || obj === null) return;
        const o = obj as Record<string, unknown>;

        if (o['type'] !== 'assistant') return;

        // Parse timestamp
        const tsStr = o['timestamp'];
        if (typeof tsStr !== 'string') return;
        let tsMs: number;
        try { tsMs = new Date(tsStr).getTime(); } catch { return; }
        if (isNaN(tsMs) || tsMs < since7d) return;

        // Extract usage from message.usage
        const msg = o['message'];
        if (typeof msg !== 'object' || msg === null) return;
        const usage = (msg as Record<string, unknown>)['usage'];
        if (typeof usage !== 'object' || usage === null) return;
        const u = usage as Record<string, unknown>;

        const tin   = typeof u['input_tokens']                === 'number' ? (u['input_tokens']                as number) : 0;
        const tout  = typeof u['output_tokens']               === 'number' ? (u['output_tokens']               as number) : 0;
        const tcr   = typeof u['cache_read_input_tokens']     === 'number' ? (u['cache_read_input_tokens']     as number) : 0;
        const tcw   = typeof u['cache_creation_input_tokens'] === 'number' ? (u['cache_creation_input_tokens'] as number) : 0;
        const total = tin + tout + tcr + tcw;
        if (total === 0) return;

        // Count into windows
        tokens7d += total;
        messages7d += 1;
        if (tsMs >= since5h) {
          tokens5h += total;
          messages5h += 1;
        }
      });
    }

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

/** Invalidate the cache (used in tests and after config changes). */
export function invalidateClaudeUsageCache(): void {
  _cache = null;
}

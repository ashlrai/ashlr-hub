/**
 * codex-source.ts — M64: Codex (OpenAI) session ingestion for observability.
 *
 * Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl files and extracts:
 *   1. collectCodexEvents(sinceMs)  — UsageEvents for the rollup/pulse pipeline
 *   2. readCodexRateLimits()        — real subscription rate-limit data for limits.ts
 *
 * DOUBLE-COUNTING STRATEGY: We emit ONE UsageEvent per session using the FINAL
 * token_count event's `total_token_usage` (cumulative across all turns). This
 * means we never accumulate per-turn last_token_usage across multiple events —
 * the last total_token_usage IS the session total.
 *
 * PRIVACY: only token counts, model id ('codex'), timestamp, and project basename
 * (from session_meta.cwd) are retained. Never reads message content.
 *
 * PERFORMANCE: skips files with mtime < sinceMs and reads only bounded head and
 * tail windows from each transcript; never throws.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { UsageEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodexRateLimits {
  primary?: { usedPercent: number; windowMinutes: number; resetsAt: number };
  secondary?: { usedPercent: number; windowMinutes: number; resetsAt: number };
  planType?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Provider key used by rollup.ts / limits.ts for Codex. */
export const CODEX_PROVIDER_KEY = 'codex';

/** Model string stored on each UsageEvent. */
const CODEX_MODEL = 'codex';

/** Root of Codex session files. Overridable via CODEX_SESSIONS_DIR for tests. */
function codexSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

const READ_CHUNK = 64 * 1024;

/** Maximum bytes inspected for session_meta at the start of each transcript. */
export const CODEX_TRANSCRIPT_HEAD_BYTES = 256 * 1024;

/** Maximum bytes inspected for final token_count rows at the end of each transcript. */
export const CODEX_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/** Maximum transcripts inspected by one collectCodexEvents call. */
export const CODEX_TRANSCRIPT_MAX_FILES = 32;

/** Maximum aggregate head/tail bytes inspected by one collectCodexEvents call. */
export const CODEX_TRANSCRIPT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Maximum transcript metadata records inspected before content sampling. */
export const CODEX_TRANSCRIPT_DISCOVERY_MAX_FILES = 128;

// ---------------------------------------------------------------------------
// Bounded transcript reader
// ---------------------------------------------------------------------------

function readWindow(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;

  while (total < length) {
    let n: number;
    try {
      n = fs.readSync(fd, buffer, total, Math.min(READ_CHUNK, length - total), position + total);
    } catch {
      break;
    }
    if (n <= 0) break;
    total += n;
  }

  return buffer.subarray(0, total);
}

function eachCompleteLine(
  buffer: Buffer,
  skipLeadingPartial: boolean,
  skipTrailingPartial: boolean,
  cb: (line: string) => void,
): void {
  let start = 0;
  let end = buffer.length;

  if (skipLeadingPartial) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) return;
    start = firstNewline + 1;
  }

  if (skipTrailingPartial) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < start) return;
    end = lastNewline;
  }

  if (start >= end) return;
  for (const rawLine of buffer.subarray(start, end).toString('utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length > 0) cb(line);
  }
}

/**
 * Read complete JSONL records from bounded head and tail windows. Records cut by
 * an outer window boundary are ignored, while records split across READ_CHUNK
 * reads are reconstructed in the bounded buffer.
 */
function readBoundedTranscript(
  filePath: string,
  expectedSize: number,
  onHeadLine: ((line: string) => void) | null,
  onTailLine: ((line: string) => void) | null,
): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return;
  }

  try {
    let size: number;
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size !== expectedSize
      ) return;
      size = stat.size;
    } catch {
      return;
    }

    if (onHeadLine) {
      const headLength = Math.min(size, CODEX_TRANSCRIPT_HEAD_BYTES);
      const head = readWindow(fd, 0, headLength);
      eachCompleteLine(head, false, size > headLength, onHeadLine);
    }

    if (onTailLine) {
      const tailLength = Math.min(size, CODEX_TRANSCRIPT_TAIL_BYTES);
      const tailStart = size - tailLength;
      const tail = readWindow(fd, tailStart, tailLength);
      const preceding = tailStart > 0 ? readWindow(fd, tailStart - 1, 1) : null;
      const startsMidLine = preceding !== null && preceding[0] !== 0x0a;
      eachCompleteLine(tail, startsMidLine, false, onTailLine);
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function transcriptReadCost(size: number, includeHead: boolean, includeTail: boolean): number {
  return (
    (includeHead ? Math.min(size, CODEX_TRANSCRIPT_HEAD_BYTES) : 0) +
    (includeTail
      ? Math.min(size, CODEX_TRANSCRIPT_TAIL_BYTES) + (size > CODEX_TRANSCRIPT_TAIL_BYTES ? 1 : 0)
      : 0)
  );
}

// ---------------------------------------------------------------------------
// Per-session state machine
// ---------------------------------------------------------------------------

interface SessionState {
  /** cwd basename from session_meta, used as project label. */
  cwd: string | null;
  /** ISO timestamp from session_meta or first event. */
  ts: string | null;
  /** Cumulative token counts from the LAST token_count event seen. */
  lastTotal: { input_tokens: number; output_tokens: number } | null;
  /** Rate limits from the LAST token_count event seen. */
  lastRateLimits: CodexRateLimits | null;
}

function parseRateLimits(rl: Record<string, unknown>): CodexRateLimits {
  const result: CodexRateLimits = {};

  const primary = rl['primary'];
  if (typeof primary === 'object' && primary !== null) {
    const p = primary as Record<string, unknown>;
    if (
      typeof p['used_percent'] === 'number' &&
      typeof p['window_minutes'] === 'number' &&
      typeof p['resets_at'] === 'number'
    ) {
      result.primary = {
        usedPercent: p['used_percent'],
        windowMinutes: p['window_minutes'],
        resetsAt: p['resets_at'],
      };
    }
  }

  const secondary = rl['secondary'];
  if (typeof secondary === 'object' && secondary !== null) {
    const s = secondary as Record<string, unknown>;
    if (
      typeof s['used_percent'] === 'number' &&
      typeof s['window_minutes'] === 'number' &&
      typeof s['resets_at'] === 'number'
    ) {
      result.secondary = {
        usedPercent: s['used_percent'],
        windowMinutes: s['window_minutes'],
        resetsAt: s['resets_at'],
      };
    }
  }

  if (typeof rl['plan_type'] === 'string') {
    result.planType = rl['plan_type'];
  }

  return result;
}

function parseRow(line: string): Record<string, unknown> | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  return typeof obj === 'object' && obj !== null
    ? obj as Record<string, unknown>
    : null;
}

function processHeadLine(line: string, state: SessionState): void {
  if (!line.includes('session_meta')) return;
  const row = parseRow(line);
  if (!row || row['type'] !== 'session_meta') return;

  const payload = row['payload'];
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>;
    if (typeof p['cwd'] === 'string') state.cwd = p['cwd'];
    if (typeof p['timestamp'] === 'string') state.ts = p['timestamp'];
  }
  if (!state.ts && typeof row['timestamp'] === 'string') state.ts = row['timestamp'];
}

function processTailLine(line: string, state: SessionState): void {
  if (!line.includes('token_count')) return;
  const row = parseRow(line);
  if (!row || row['type'] !== 'event_msg') return;

  const payload = row['payload'];
  if (typeof payload !== 'object' || payload === null) return;
  const p = payload as Record<string, unknown>;
  if (p['type'] !== 'token_count') return;

  if (!state.ts && typeof row['timestamp'] === 'string') state.ts = row['timestamp'];

  const info = p['info'];
  if (typeof info === 'object' && info !== null) {
    const i = info as Record<string, unknown>;
    const total = i['total_token_usage'];
    if (typeof total === 'object' && total !== null) {
      const t = total as Record<string, unknown>;
      state.lastTotal = {
        input_tokens:  typeof t['input_tokens']  === 'number' ? t['input_tokens']  : 0,
        output_tokens: typeof t['output_tokens'] === 'number' ? t['output_tokens'] : 0,
      };
    }
  }

  const rl = p['rate_limits'];
  if (typeof rl === 'object' && rl !== null) {
    state.lastRateLimits = parseRateLimits(rl as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

interface TranscriptFile {
  path: string;
  mtime: number;
  size: number;
}

/** List eligible transcripts in deterministic newest-first order. */
function listCodexSessions(sinceMs: number): TranscriptFile[] {
  const root = codexSessionsRoot();
  const result: TranscriptFile[] = [];
  let discoveredEntries = 0;

  let yearDirs: string[];
  try {
    yearDirs = fs.readdirSync(root);
  } catch {
    return result;
  }

  yearDirs.sort((a, b) => b.localeCompare(a));
  for (const year of yearDirs) {
    const yearPath = path.join(root, year);
    let monthDirs: string[];
    try {
      monthDirs = fs.readdirSync(yearPath);
    } catch { continue; }

    monthDirs.sort((a, b) => b.localeCompare(a));
    for (const month of monthDirs) {
      const monthPath = path.join(yearPath, month);
      let dayDirs: string[];
      try {
        dayDirs = fs.readdirSync(monthPath);
      } catch { continue; }

      dayDirs.sort((a, b) => b.localeCompare(a));
      for (const day of dayDirs) {
        const dayPath = path.join(monthPath, day);
        let dir: fs.Dir;
        try {
          dir = fs.opendirSync(dayPath);
        } catch { continue; }

        try {
          for (;;) {
            if (discoveredEntries >= CODEX_TRANSCRIPT_DISCOVERY_MAX_FILES) {
              result.sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
              return result;
            }
            const entry = dir.readSync();
            if (!entry) break;
            discoveredEntries += 1;
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            const filePath = path.join(dayPath, entry.name);
            try {
              const stat = fs.statSync(filePath);
              if (
                !stat.isFile() ||
                stat.mtimeMs < sinceMs ||
                !Number.isSafeInteger(stat.size) ||
                stat.size < 0
              ) continue;
              result.push({ path: filePath, mtime: stat.mtimeMs, size: stat.size });
            } catch { continue; }
          }
        } finally {
          try { dir.closeSync(); } catch { /* ignore */ }
        }
      }
    }
  }

  result.sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect UsageEvents from Codex session files with ts >= sinceMs.
 *
 * ONE event per session: uses the FINAL token_count's total_token_usage to
 * avoid double-counting per-turn activity. Project = cwd basename.
 *
 * Never throws.
 */
export function collectCodexEvents(sinceMs: number): UsageEvent[] {
  const events: UsageEvent[] = [];

  try {
    let inspectedFiles = 0;
    let inspectedBytes = 0;

    for (const file of listCodexSessions(sinceMs)) {
      const readCost = transcriptReadCost(file.size, true, true);
      if (
        inspectedFiles >= CODEX_TRANSCRIPT_MAX_FILES ||
        readCost > CODEX_TRANSCRIPT_MAX_TOTAL_BYTES - inspectedBytes
      ) break;

      inspectedFiles += 1;
      inspectedBytes += readCost;

      const state: SessionState = {
        cwd: null,
        ts: null,
        lastTotal: null,
        lastRateLimits: null,
      };

      readBoundedTranscript(
        file.path,
        file.size,
        (line) => processHeadLine(line, state),
        (line) => processTailLine(line, state),
      );

      // Skip sessions with no token data
      if (!state.lastTotal) continue;
      if (state.lastTotal.input_tokens === 0 && state.lastTotal.output_tokens === 0) continue;

      // Use session timestamp, falling back to a synthesized ISO from file path
      const ts = state.ts ?? new Date().toISOString();

      // Apply sinceMs filter on the session timestamp
      try {
        if (new Date(ts).getTime() < sinceMs) continue;
      } catch {
        // Malformed ts — include it anyway (mtime already passed)
      }

      const project = state.cwd ? path.basename(state.cwd) : null;

      events.push({
        ts,
        project,
        model: CODEX_MODEL,
        source: 'run',
        tokensIn:   state.lastTotal.input_tokens,
        tokensOut:  state.lastTotal.output_tokens,
        cacheRead:  0,
        cacheWrite: 0,
      });
    }
  } catch {
    // Belt-and-suspenders: top-level guard
  }

  return events;
}

/**
 * Read rate-limit data from the most recent Codex session file.
 *
 * Returns the primary/secondary/planType from the LAST token_count event in
 * the most recently modified session file. Returns null when no data is
 * available (no sessions, no token_count lines, malformed file, etc.).
 *
 * Never throws.
 */
export function readCodexRateLimits(): CodexRateLimits | null {
  try {
    const allFiles = listCodexSessions(Number.NEGATIVE_INFINITY);
    if (allFiles.length === 0) return null;
    const newest = allFiles[0]!;

    const state: SessionState = {
      cwd: null,
      ts: null,
      lastTotal: null,
      lastRateLimits: null,
    };
    readBoundedTranscript(newest.path, newest.size, null, (line) => processTailLine(line, state));
    return state.lastRateLimits;
  } catch {
    return null;
  }
}

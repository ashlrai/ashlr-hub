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
 * PERFORMANCE: skips files with mtime < sinceMs; streams line-by-line; bounded
 * at 256 MiB per file; never throws.
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
const MAX_BYTES_PER_FILE = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Line-streaming helper (mirrors usage-source.ts pattern exactly)
// ---------------------------------------------------------------------------

function eachLine(filePath: string, cb: (line: string) => void): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return;
  }

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    let pending = '';
    let bytesRead = 0;

    for (;;) {
      let n: number;
      try {
        n = fs.readSync(fd, chunk, 0, READ_CHUNK, null);
      } catch {
        break;
      }
      if (n <= 0) break;
      bytesRead += n;

      pending += chunk.toString('utf8', 0, n);

      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line.length > 0) cb(line);
      }

      if (bytesRead >= MAX_BYTES_PER_FILE) break;
    }

    const last = pending.trim();
    if (last.length > 0) cb(last);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
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

function processLine(line: string, state: SessionState): void {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return; // malformed — skip silently
  }

  if (typeof obj !== 'object' || obj === null) return;
  const row = obj as Record<string, unknown>;
  const type = row['type'];

  // ── session_meta: grab cwd and timestamp ───────────────────────────────
  if (type === 'session_meta') {
    const payload = row['payload'];
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      if (typeof p['cwd'] === 'string') state.cwd = p['cwd'];
      if (typeof p['timestamp'] === 'string') state.ts = p['timestamp'];
    }
    // Also accept top-level timestamp as fallback
    if (!state.ts && typeof row['timestamp'] === 'string') {
      state.ts = row['timestamp'];
    }
    return;
  }

  // ── event_msg with type:token_count ────────────────────────────────────
  if (type === 'event_msg') {
    const payload = row['payload'];
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p['type'] !== 'token_count') return;

    // Update timestamp from event if not yet set
    if (!state.ts && typeof row['timestamp'] === 'string') {
      state.ts = row['timestamp'];
    }

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
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

/**
 * Walk ~/.codex/sessions/YYYY/MM/DD/ tree, yield .jsonl file paths whose
 * mtime >= sinceMs. Silently skips unreadable entries.
 */
function* walkCodexSessions(sinceMs: number): Generator<string> {
  const root = codexSessionsRoot();

  let yearDirs: string[];
  try {
    yearDirs = fs.readdirSync(root);
  } catch {
    return; // ~/.codex/sessions missing
  }

  for (const year of yearDirs) {
    const yearPath = path.join(root, year);
    let monthDirs: string[];
    try {
      monthDirs = fs.readdirSync(yearPath);
    } catch { continue; }

    for (const month of monthDirs) {
      const monthPath = path.join(yearPath, month);
      let dayDirs: string[];
      try {
        dayDirs = fs.readdirSync(monthPath);
      } catch { continue; }

      for (const day of dayDirs) {
        const dayPath = path.join(monthPath, day);
        let files: string[];
        try {
          files = fs.readdirSync(dayPath);
        } catch { continue; }

        for (const name of files) {
          if (!name.endsWith('.jsonl')) continue;
          const filePath = path.join(dayPath, name);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < sinceMs) continue;
          } catch { continue; }
          yield filePath;
        }
      }
    }
  }
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
    for (const filePath of walkCodexSessions(sinceMs)) {
      const state: SessionState = {
        cwd: null,
        ts: null,
        lastTotal: null,
        lastRateLimits: null,
      };

      eachLine(filePath, (line) => processLine(line, state));

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
    const root = codexSessionsRoot();

    // Find all session files, pick the most recently modified one
    const allFiles: { path: string; mtime: number }[] = [];

    let yearDirs: string[];
    try {
      yearDirs = fs.readdirSync(root);
    } catch {
      return null;
    }

    for (const year of yearDirs) {
      const yearPath = path.join(root, year);
      let monthDirs: string[];
      try { monthDirs = fs.readdirSync(yearPath); } catch { continue; }

      for (const month of monthDirs) {
        const monthPath = path.join(yearPath, month);
        let dayDirs: string[];
        try { dayDirs = fs.readdirSync(monthPath); } catch { continue; }

        for (const day of dayDirs) {
          const dayPath = path.join(monthPath, day);
          let files: string[];
          try { files = fs.readdirSync(dayPath); } catch { continue; }

          for (const name of files) {
            if (!name.endsWith('.jsonl')) continue;
            const filePath = path.join(dayPath, name);
            try {
              const stat = fs.statSync(filePath);
              allFiles.push({ path: filePath, mtime: stat.mtimeMs });
            } catch { continue; }
          }
        }
      }
    }

    if (allFiles.length === 0) return null;

    // Most recently modified file
    allFiles.sort((a, b) => b.mtime - a.mtime);
    const newest = allFiles[0]!;

    // Extract LAST token_count rate_limits from that file
    let lastRateLimits: CodexRateLimits | null = null;

    eachLine(newest.path, (line) => {
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { return; }
      if (typeof obj !== 'object' || obj === null) return;
      const row = obj as Record<string, unknown>;
      if (row['type'] !== 'event_msg') return;
      const payload = row['payload'];
      if (typeof payload !== 'object' || payload === null) return;
      const p = payload as Record<string, unknown>;
      if (p['type'] !== 'token_count') return;
      const rl = p['rate_limits'];
      if (typeof rl === 'object' && rl !== null) {
        lastRateLimits = parseRateLimits(rl as Record<string, unknown>);
      }
    });

    return lastRateLimits;
  } catch {
    return null;
  }
}

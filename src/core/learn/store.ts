/**
 * store.ts — M26 reflection report persistence (~/.ashlr/learn/).
 *
 * Persists + loads ReflectionReport snapshots so each run can compute
 * week-over-week deltas against the previous snapshot.
 *
 * Layout:
 *   ~/.ashlr/learn/reports/<generatedAt-ms>.json   — one pretty-printed
 *                                                     ReflectionReport per run
 *
 * HARD SAFETY INVARIANTS (M26):
 *  - READ-ONLY over history: this module READS swarms/genome/usage via the
 *    reflect engine; it WRITES ONLY under ~/.ashlr/learn/. It NEVER writes
 *    CONFIG_PATH / saveConfig() / router policy / prompts, and NEVER touches a
 *    user repo working tree.
 *  - Atomic-ish write: tmp-write + rename (POSIX-atomic), mirroring
 *    core/swarm/store.ts and core/inbox/store.ts.
 *  - Bounded: listReports caps how many snapshot files it reads.
 *  - Never throws: all exported functions swallow errors and return safe
 *    defaults (null / []).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { learnDir } from '../config.js';
import type { ReflectionReport } from '../types.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Never read more than this many snapshot files at once (bounds I/O). */
const MAX_REPORTS = 200;

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/**
 * Absolute path to the reports directory: `~/.ashlr/learn/reports`.
 * Created lazily by saveReport — this function does NOT create it.
 */
export function reportsDir(): string {
  return join(learnDir(), 'reports');
}

/** Ensure a directory exists, silently creating it if needed. */
function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort; a subsequent write will fail gracefully in its try/catch.
  }
}

/** Derive a filename-safe, chronologically-sortable stem from an ISO ts. */
function reportStem(generatedAt: string): string {
  // Epoch-ms keeps lexicographic order == chronological order. Fall back to a
  // sanitized ISO string if the timestamp is unparseable.
  const ms = Date.parse(generatedAt);
  if (Number.isFinite(ms)) return String(ms);
  return generatedAt.replace(/[^\w.-]+/g, '-');
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

/**
 * Persist a ReflectionReport snapshot under ~/.ashlr/learn/reports/.
 *
 * Returns the absolute path written, or null on failure. Never throws.
 *
 * Atomic tmp-write + rename of `JSON.stringify(report, null, 2) + '\n'` to
 * `reportsDir()/<reportStem(report.generatedAt)>.json`.
 * MUST NOT write anywhere outside reportsDir().
 */
export function saveReport(report: ReflectionReport): string | null {
  try {
    const dir = reportsDir();
    ensureDir(dir);
    const dest = join(dir, `${reportStem(report.generatedAt)}.json`);
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
    return dest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/** Light structural guard so we never return garbage from the store. */
function isReport(parsed: unknown): parsed is ReflectionReport {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const r = parsed as Record<string, unknown>;
  return (
    typeof r['generatedAt'] === 'string' &&
    typeof r['since'] === 'string' &&
    typeof r['successRate'] === 'number'
  );
}

/**
 * List persisted ReflectionReport snapshots, most-recent first by
 * `generatedAt`. Reads at most MAX_REPORTS files. Never throws; returns [] on
 * any error and silently skips unreadable/malformed files.
 */
export function listReports(): ReflectionReport[] {
  try {
    const dir = reportsDir();
    if (!existsSync(dir)) return [];

    let files: string[];
    try {
      // Filename stems are epoch-ms, so a lexicographic descending sort of the
      // filenames already orders newest-first; sort here so the slice keeps the
      // MOST-RECENT MAX_REPORTS rather than an arbitrary directory order.
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .slice(0, MAX_REPORTS);
    } catch {
      return [];
    }

    const reports: ReflectionReport[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isReport(parsed)) reports.push(parsed);
      } catch {
        // Unreadable or malformed — skip silently.
      }
    }

    // Most-recent first by generatedAt (ISO strings sort lexicographically).
    reports.sort((a, b) =>
      a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0,
    );

    return reports;
  } catch {
    return [];
  }
}

/**
 * Load the most recent previously-persisted snapshot (the prior report used to
 * compute week-over-week deltas), or null when none exists.
 *
 * `before` (optional ISO ts) excludes snapshots at/after it so a freshly-saved
 * current report is not compared against itself.
 */
export function loadPreviousReport(before?: string): ReflectionReport | null {
  try {
    const all = listReports();
    if (all.length === 0) return null;
    if (before === undefined) return all[0] ?? null;
    for (const r of all) {
      if (r.generatedAt < before) return r;
    }
    return null;
  } catch {
    return null;
  }
}

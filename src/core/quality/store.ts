/**
 * store.ts — M27 HealthReport snapshot persistence (~/.ashlr/quality/).
 *
 * Persists + loads HealthReport snapshots so each `ashlr health` run can compute
 * per-repo score deltas (trend) against the previous snapshot.
 *
 * Layout:
 *   ~/.ashlr/quality/reports/<generatedAt-ms>.json   — one pretty-printed
 *                                                       HealthReport per run
 *   ~/.ashlr/quality/reports/<generatedAt-ms>-N.json  — collision fallback for a
 *                                                       second run in the SAME ms
 *
 * Trend caveat: loadPreviousReport selects the newest snapshot STRICTLY BEFORE
 * the current report's generatedAt (so a just-saved report is never diffed
 * against itself). Snapshots are thus effectively at most one-per-ms for trend
 * purposes: two runs that share an identical ms-resolution generatedAt are both
 * persisted (distinct `-N` files, no history loss) but the second's delta degrades
 * gracefully to '—' rather than diffing against the same-ms prior. This is benign
 * for an interactive CLI; only a sub-ms daemon/cron driver would notice.
 *
 * HARD SAFETY INVARIANTS (M27):
 *  - WRITES ONLY under ~/.ashlr/quality/. NEVER writes CONFIG_PATH /
 *    saveConfig() / router policy / prompts, and NEVER touches a user repo
 *    working tree.
 *  - Atomic-ish write: tmp-write + rename (POSIX-atomic), mirroring
 *    core/learn/store.ts and core/inbox/store.ts.
 *  - Bounded: listReports caps how many snapshot files it reads (MAX_REPORTS).
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
import { qualityDir } from '../config.js';
import type { HealthReport } from '../types.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Never read more than this many snapshot files at once (bounds I/O). */
const MAX_REPORTS = 200;

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/**
 * Absolute path to the reports directory: `~/.ashlr/quality/reports`.
 * Created lazily by saveReport — this function does NOT create it.
 */
export function reportsDir(): string {
  return join(qualityDir(), 'reports');
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

/**
 * Pick a destination path under `dir` for `stem` that does NOT already exist,
 * so two runs in the same millisecond (identical epoch-ms stem) do not collide
 * and overwrite each other's snapshot. The first run in a fresh dir gets the
 * plain `<stem>.json` (preserving chronological lexicographic ordering and the
 * documented filename), and a same-ms collision falls back to `<stem>-1.json`,
 * `<stem>-2.json`, … (a tiny bounded suffix probe). Best-effort: on the rare
 * exhaustion of the probe it returns the plain path (last-writer-wins, as before).
 */
function uniqueDest(dir: string, stem: string): string {
  const plain = join(dir, `${stem}.json`);
  try {
    if (!existsSync(plain)) return plain;
    for (let i = 1; i <= 1000; i++) {
      const candidate = join(dir, `${stem}-${i}.json`);
      if (!existsSync(candidate)) return candidate;
    }
  } catch {
    // existsSync should not throw, but fall through to the plain path defensively.
  }
  return plain;
}

/** Light type-guard so we never return garbage from the store. */
function isValidReport(parsed: unknown): parsed is HealthReport {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const r = parsed as Record<string, unknown>;
  return (
    typeof r['generatedAt'] === 'string' &&
    Array.isArray(r['repos']) &&
    Array.isArray(r['scores']) &&
    typeof r['averageScore'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a HealthReport snapshot under reportsDir() as
 * `<generatedAt-ms>.json` via atomic tmp-write + rename. Returns the written
 * path, or null on any failure. Never throws. The ONLY filesystem destination
 * is under ~/.ashlr/quality/.
 */
export function saveReport(report: HealthReport): string | null {
  try {
    const dir = reportsDir();
    ensureDir(dir);
    // Collision-resistant: a second run in the SAME millisecond (identical
    // epoch-ms stem) gets a `-N` suffix instead of overwriting the first snapshot.
    const dest = uniqueDest(dir, reportStem(report.generatedAt));
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * List persisted HealthReport snapshots, most-recent first by generatedAt,
 * bounded to MAX_REPORTS files. Read-only. Corrupt files are skipped silently.
 * Never throws (returns [] on error).
 */
export function listReports(): HealthReport[] {
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

    const reports: HealthReport[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isValidReport(parsed)) reports.push(parsed);
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
 * Return the newest persisted snapshot strictly BEFORE `before` (the current
 * report's generatedAt) — so a just-saved report isn't diffed against itself.
 * When `before` is omitted, returns the newest snapshot. Used to compute the
 * per-repo score delta trend in the report. Never throws (null on absence).
 */
export function loadPreviousReport(before?: string): HealthReport | null {
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

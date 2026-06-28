/**
 * core/digest/store.ts — M29 digest artifact persistence.
 *
 * Pure FS layer under `~/.ashlr/digests/`. Mirrors the M26 learn store / M27
 * quality store: atomic tmp-write + rename, never throws on reads, filename
 * stems are epoch-ms so lexicographic order == chronological order, and the
 * read path is bounded by MAX_DIGESTS.
 *
 * HARD SAFETY INVARIANTS (M29) enforced here:
 *  - READ-ONLY AGGREGATION: this module WRITES only under digestsDir()
 *    (~/.ashlr/digests/). It NEVER writes CONFIG_PATH, never mutates a repo
 *    working tree, never applies/approves a proposal. The verifier proves it by
 *    asserting every write target resolves under digestsDir().
 *  - NO OUTWARD ACTION: persistence is local disk only. ZERO network calls.
 *  - BOUNDED + NEVER-THROWS: every read/write is wrapped; failures degrade to
 *    null / []. listDigests reads at most MAX_DIGESTS files.
 *
 * Each digest is persisted as TWO sibling artifacts sharing a stem:
 *   <stem>.json  — the canonical DigestReport (used as the prior for deltas).
 *   <stem>.md    — the human-readable markdown rendering (renderDigestText).
 * The markdown is advisory; loadPreviousDigest reads only the JSON.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { digestsDir } from '../config.js';
import type { DigestReport, DigestWindow, PortfolioSummary, PortfolioTodayDelta } from '../types.js';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Max digest snapshots listDigests will read (bounds I/O). */
const MAX_DIGESTS = 200;

// ---------------------------------------------------------------------------
// Empty / zeroed defaults — single source of truth (M198 consolidation)
// ---------------------------------------------------------------------------

/** A null-filled "today" delta block (no prior digest to compare against). */
export function emptyTodayDelta(): PortfolioTodayDelta {
  return {
    previousAt: null,
    pendingProposalsDelta: null,
    dirtyReposDelta: null,
    spendUsdDelta: null,
    healthScoreDelta: null,
    goalsInFlightDelta: null,
  };
}

/**
 * A zeroed PortfolioSummary — the canonical empty value shared by
 * build.ts (degradation) and dashboard.ts (initial value). Exported so
 * callers import one copy rather than each maintaining their own.
 */
export function emptyPortfolio(window: DigestWindow): PortfolioSummary {
  return {
    health: { reposScored: 0, averageScore: 0, averageGrade: 'F', worstRepos: [] },
    goalsInFlight: [],
    backlogTop: [],
    cost: { window, spentUsd: 0, localSavingsUsd: 0, projectedMonthlyUsd: 0 },
    effectiveness: null,
    today: emptyTodayDelta(),
  };
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/**
 * Re-export of {@link digestsDir} for store-local convenience and to mirror the
 * `reportsDir()` shape of the learn/quality stores. `~/.ashlr/digests`.
 * Created lazily by {@link saveDigest} — this function does NOT create it.
 */
export function digestsDirPath(): string {
  return digestsDir();
}

/** Ensure a directory exists, silently creating it if needed. Best-effort. */
function ensureDir(dir: string): void {
  // Recursive mkdir so intermediate dirs are created in one shot. EEXIST is
  // benign (dir was created concurrently or existsSync raced); any other OS
  // error (EACCES, ENOTDIR, …) is logged once so it surfaces in diagnostics
  // without ever throwing to the caller. A subsequent write will fail in its
  // own try/catch and degrade to null, satisfying the never-throws contract.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      // Real failure — surface it without throwing.
      console.error(`[ashlr:digest] ensureDir failed for ${dir}: ${String(err)}`);
    }
  }
}

/**
 * Derive a filename-safe, chronologically-sortable stem from an ISO ts.
 * Epoch-ms keeps lexicographic order == chronological order; falls back to a
 * sanitized ISO string when the timestamp is unparseable.
 */
function digestStem(generatedAt: string): string {
  // Mirror reportStem in quality/store.ts: epoch-ms keeps lexicographic order ==
  // chronological order; fall back to a sanitized ISO string when unparseable.
  const ms = Date.parse(generatedAt);
  if (Number.isFinite(ms)) return String(ms);
  return generatedAt.replace(/[^\w.-]+/g, '-');
}

/**
 * Pick a collision-free stem under `dir`: if `<stem>.json` already exists (a
 * second digest built in the SAME millisecond), append a bounded `-N` suffix so
 * the second artifact does not silently clobber the first. The first writer in a
 * fresh dir keeps the plain `<stem>` (preserving chronological lexicographic
 * ordering). Mirrors uniqueDest() in quality/store.ts. Best-effort: on probe
 * exhaustion it returns the plain stem (last-writer-wins, as before). Both the
 * `.json` and its sibling `.md` share the returned stem, so they stay paired.
 */
function uniqueStem(dir: string, stem: string): string {
  try {
    if (!existsSync(join(dir, `${stem}.json`))) return stem;
    for (let i = 1; i <= 1000; i++) {
      const candidate = `${stem}-${i}`;
      if (!existsSync(join(dir, `${candidate}.json`))) return candidate;
    }
  } catch {
    // existsSync should not throw, but fall through to the plain stem defensively.
  }
  return stem;
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

/**
 * Persist a DigestReport (JSON) + its markdown rendering under
 * `~/.ashlr/digests/`. Atomic tmp-write + rename for each artifact.
 *
 * MUST NOT write anywhere outside digestsDir(). Returns the absolute paths of
 * the artifacts written (null on failure). Never throws.
 *
 * @param report   the digest to persist.
 * @param markdown the pre-rendered markdown body (from renderDigestText).
 */
export function saveDigest(
  report: DigestReport,
  markdown: string,
): { jsonPath: string | null; markdownPath: string | null } {
  const dir = digestsDir();
  ensureDir(dir);
  // Collision-resistant: a second digest built in the SAME millisecond gets a
  // `-N` suffix rather than overwriting the first artifact. The json + md share
  // this one resolved stem so the pair stays together.
  const stem = uniqueStem(dir, digestStem(report.generatedAt));

  // Each artifact is written atomically (tmp-write + rename) and independently —
  // a failure on one degrades that path to null without affecting the other.
  // Both targets resolve under digestsDir(); nothing is written elsewhere.
  let jsonPath: string | null = null;
  try {
    const dest = join(dir, `${stem}.json`);
    const tmp = dest + '.tmp';
    writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
    jsonPath = dest;
  } catch {
    jsonPath = null;
  }

  let markdownPath: string | null = null;
  try {
    const dest = join(dir, `${stem}.md`);
    const tmp = dest + '.tmp';
    writeFileSync(tmp, markdown, 'utf8');
    renameSync(tmp, dest);
    markdownPath = dest;
  } catch {
    markdownPath = null;
  }

  return { jsonPath, markdownPath };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/** Light structural guard so we never return garbage from the store. */
function isDigest(parsed: unknown): parsed is DigestReport {
  // Mirror isReport in learn/store.ts — validate generatedAt:string, date:string,
  // window in {'7d','30d'}, portfolio:object.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const r = parsed as Record<string, unknown>;
  return (
    typeof r['generatedAt'] === 'string' &&
    typeof r['date'] === 'string' &&
    (r['window'] === '7d' || r['window'] === '30d') &&
    typeof r['portfolio'] === 'object' &&
    r['portfolio'] !== null
  );
}

/**
 * List persisted DigestReport snapshots, most-recent first by `generatedAt`.
 * Reads at most MAX_DIGESTS JSON files. Never throws; returns [] on any error
 * and silently skips unreadable/malformed files.
 */
export function listDigests(): DigestReport[] {
  try {
    const dir = digestsDir();
    if (!existsSync(dir)) return [];

    let files: string[];
    try {
      // Filename stems are epoch-ms, so a lexicographic descending sort of the
      // filenames already orders newest-first; sort here so the slice keeps the
      // MOST-RECENT MAX_DIGESTS rather than an arbitrary directory order. We read
      // ONLY *.json artifacts (skip the sibling *.md and any *.tmp leftovers).
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .slice(0, MAX_DIGESTS);
    } catch {
      return [];
    }

    const digests: DigestReport[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isDigest(parsed)) digests.push(parsed);
      } catch {
        // Unreadable or malformed — skip silently.
      }
    }

    // Most-recent first by generatedAt (ISO strings sort lexicographically).
    digests.sort((a, b) =>
      a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0,
    );

    return digests;
  } catch {
    return [];
  }
}

/**
 * Load the most recent previously-persisted digest (the prior used to compute
 * day-over-day deltas), or null when none exists.
 *
 * `before` (optional ISO ts) excludes digests at/after it so a freshly-saved
 * current digest is not compared against itself.
 */
export function loadPreviousDigest(before?: string): DigestReport | null {
  try {
    const all = listDigests();
    if (all.length === 0) return null;
    if (before === undefined) return all[0] ?? null;
    for (const d of all) {
      if (d.generatedAt < before) return d;
    }
    return null;
  } catch {
    return null;
  }
}

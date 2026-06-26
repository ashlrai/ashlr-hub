/**
 * M119: Quality-metrics computation for the fleet oversight layer.
 *
 * computeQualityMetrics reads proposals + decisions ledger and derives
 * productivity/quality signals without touching any repo or making network calls.
 *
 * Never throws — degrades to zeroed metrics on any error.
 */

import type { QualityMetrics, EngineQuality } from '../types.js';
import { listProposals } from '../inbox/store.js';
import { readDecisions } from './decisions-ledger.js';

// ---------------------------------------------------------------------------
// Trivial-patch heuristics
// ---------------------------------------------------------------------------

/** Patterns in titles that indicate a trivial (doc/comment-only) proposal. */
const TRIVIAL_TITLE_RE =
  /^\s*(fix(ed)?\s+(typo|comment|doc)|update\s+(comment|doc|readme)|add\s+(comment|doc\s*comment)|remove\s+(comment|dead\s*code)|nit:|trivial)/i;

/**
 * Count changed lines in a unified diff (lines starting with + or - but not
 * +++ / ---). Returns 0 when diff is absent or malformed.
 */
function countDiffLines(diff: string | undefined): number {
  if (!diff) return 0;
  let count = 0;
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      count++;
    }
  }
  return count;
}

/** Return true when the proposal looks trivial (small diff or trivial title). */
function isTrivial(title: string, diff: string | undefined): boolean {
  if (TRIVIAL_TITLE_RE.test(title)) return true;
  const lines = countDiffLines(diff);
  return lines > 0 && lines <= 6;
}

// ---------------------------------------------------------------------------
// Window helper
// ---------------------------------------------------------------------------

function windowMs(window: '7d' | '30d' | 'all'): number | undefined {
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  if (window === '30d') return 30 * 24 * 60 * 60 * 1000;
  return undefined;
}

// ---------------------------------------------------------------------------
// Public: computeQualityMetrics()
// ---------------------------------------------------------------------------

/**
 * Compute QualityMetrics over the requested time window.
 *
 * @param window  '7d' | '30d' | 'all'
 * @param opts    optional engine/repo filters (applied AFTER window)
 */
export function computeQualityMetrics(
  window: '7d' | '30d' | 'all',
  opts?: { engine?: string; repo?: string },
): QualityMetrics {
  try {
    const nowMs = Date.now();
    const deltaMs = windowMs(window);
    const sinceMs = deltaMs !== undefined ? nowMs - deltaMs : undefined;

    // ── Load proposals ───────────────────────────────────────────────────────
    let proposals = listProposals();

    // Filter by time window (use createdAt)
    if (sinceMs !== undefined) {
      proposals = proposals.filter((p) => {
        const ms = Date.parse(p.createdAt);
        return !isNaN(ms) && ms >= sinceMs;
      });
    }

    // Filter by repo
    if (opts?.repo) {
      const repoFilter = opts.repo;
      proposals = proposals.filter((p) => p.repo === repoFilter);
    }

    // Filter by engine (engineModel prefix match)
    if (opts?.engine) {
      const engineFilter = opts.engine;
      proposals = proposals.filter((p) =>
        p.engineModel?.startsWith(engineFilter) || p.engineModel === engineFilter,
      );
    }

    // ── Load decisions (same window) ────────────────────────────────────────
    const decisions = readDecisions({ sinceMs });

    // ── Aggregate counts ─────────────────────────────────────────────────────
    const created = proposals.length;
    let merged = 0;
    let rejected = 0;
    let pending = 0;
    let withDiff = 0;
    let totalTrivial = 0;
    let totalDiffLines = 0;
    let withDiffForAvg = 0;

    // verify pass/fail from verifyResult (only proposals that have one)
    let verifyTotal = 0;
    let verifyPassed = 0;

    // per-engine accumulators
    const byEngine: Record<string, {
      created: number; merged: number; rejected: number;
      totalDiffLines: number; withDiff: number; trivialCount: number;
    }> = {};

    // per-repo: just a count of created proposals in window
    const byRepo: Record<string, number> = {};

    for (const p of proposals) {
      // Status buckets
      if (p.status === 'applied' || p.status === 'approved') merged++;
      else if (p.status === 'rejected' || p.status === 'failed') rejected++;
      else if (p.status === 'pending') pending++;

      // Diff presence
      const hasDiff = typeof p.diff === 'string' && p.diff.length > 0;
      if (hasDiff) withDiff++;

      // Diff size
      const diffLines = countDiffLines(p.diff);
      if (diffLines > 0) {
        totalDiffLines += diffLines;
        withDiffForAvg++;
      }

      // Trivial
      const trivial = isTrivial(p.title, p.diff);
      if (trivial) totalTrivial++;

      // Verify result
      if (p.verifyResult !== undefined) {
        verifyTotal++;
        if (p.verifyResult.passed) verifyPassed++;
      }

      // Per-engine
      const engineKey = p.engineModel ?? '(unknown)';
      if (!byEngine[engineKey]) {
        byEngine[engineKey] = { created: 0, merged: 0, rejected: 0, totalDiffLines: 0, withDiff: 0, trivialCount: 0 };
      }
      const eng = byEngine[engineKey]!;
      eng.created++;
      if (p.status === 'applied' || p.status === 'approved') eng.merged++;
      if (p.status === 'rejected' || p.status === 'failed') eng.rejected++;
      if (diffLines > 0) { eng.totalDiffLines += diffLines; eng.withDiff++; }
      if (trivial) eng.trivialCount++;

      // Per-repo
      const repoKey = p.repo ?? '(unscoped)';
      byRepo[repoKey] = (byRepo[repoKey] ?? 0) + 1;
    }

    // ── Rates ────────────────────────────────────────────────────────────────
    const emptyRate = created > 0 ? (created - withDiff) / created : 0;
    const trivialRatio = created > 0 ? totalTrivial / created : 0;
    const acceptRate = created > 0 ? merged / created : 0;
    const rejectRate = created > 0 ? rejected / created : 0;
    const verifyPassRate = verifyTotal > 0 ? verifyPassed / verifyTotal : 0;
    const avgDiffLines = withDiffForAvg > 0 ? totalDiffLines / withDiffForAvg : 0;

    // ── Per-engine quality ────────────────────────────────────────────────────
    const byEngineQuality: Record<string, EngineQuality> = {};
    for (const [key, acc] of Object.entries(byEngine)) {
      byEngineQuality[key] = {
        created: acc.created,
        merged: acc.merged,
        rejected: acc.rejected,
        acceptRate: acc.created > 0 ? acc.merged / acc.created : 0,
        avgDiffLines: acc.withDiff > 0 ? acc.totalDiffLines / acc.withDiff : 0,
        trivialRatio: acc.created > 0 ? acc.trivialCount / acc.created : 0,
      };
    }

    // ── Trend (per-week buckets from decisions ledger) ────────────────────────
    // Build a simple 4-week trend from decisions when window is 30d/all.
    const trend = buildTrend(decisions, window);

    return {
      window,
      proposalsCreated: created,
      merged,
      rejected,
      pending,
      withDiff,
      emptyRate,
      trivialRatio,
      acceptRate,
      rejectRate,
      verifyPassRate,
      avgDiffLines,
      byEngine: byEngineQuality,
      byRepo,
      ...(trend.length > 0 ? { trend } : {}),
    };
  } catch {
    // Never throws — return zeroed metrics.
    return zeroMetrics(window);
  }
}

// ---------------------------------------------------------------------------
// Trend builder
// ---------------------------------------------------------------------------

function buildTrend(
  decisions: ReturnType<typeof readDecisions>,
  window: '7d' | '30d' | 'all',
): NonNullable<QualityMetrics['trend']> {
  if (window === '7d') return []; // not enough data for multi-period trend

  // Group decisions by ISO week (YYYY-Www)
  const weekMap: Record<string, { merged: number; created: number }> = {};

  for (const d of decisions) {
    const ms = Date.parse(d.ts);
    if (isNaN(ms)) continue;
    const weekKey = isoWeek(new Date(ms));
    if (!weekMap[weekKey]) weekMap[weekKey] = { merged: 0, created: 0 };
    if (d.action === 'merged') weekMap[weekKey]!.merged++;
    if (d.action === 'proposed') weekMap[weekKey]!.created++;
  }

  return Object.entries(weekMap)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, v]) => ({
      period,
      acceptRate: v.created > 0 ? v.merged / v.created : 0,
      merged: v.merged,
    }));
}

/** Return an ISO 8601 week string like "2026-W25" for the given date. */
function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // ISO week: Thursday of the week determines the year.
  const dayNum = date.getUTCDay() || 7; // 1=Mon … 7=Sun
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const year = date.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - startOfYear.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(weekNo).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Zero fallback
// ---------------------------------------------------------------------------

function zeroMetrics(window: string): QualityMetrics {
  return {
    window,
    proposalsCreated: 0,
    merged: 0,
    rejected: 0,
    pending: 0,
    withDiff: 0,
    emptyRate: 0,
    trivialRatio: 0,
    acceptRate: 0,
    rejectRate: 0,
    verifyPassRate: 0,
    avgDiffLines: 0,
    byEngine: {},
    byRepo: {},
  };
}

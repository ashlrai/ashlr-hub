/**
 * feedback.ts — M125: Outcome feedback loop for the fleet.
 *
 * Aggregates per-source productivity stats from three ledgers:
 *   - decisions-ledger: Manager verdicts (ship/noise/harmful) + merged/rejected
 *   - inbox/store:      Proposal lifecycle (created, authorized, merged, rejected)
 *   - worked-ledger:    Per-item run outcomes (diff / empty)
 *
 * Exports:
 *   - `computeOutcomePriors(opts?)` — builds per-(source × repo) + global stats
 *   - `scoreAdjustment(item, priors)` — bounded multiplier [0.5, 1.5] on item score
 *
 * DESIGN INVARIANTS (mirror learned-router.ts):
 *   - PURE / DETERMINISTIC given the ledgers. Never throws.
 *   - Never zeros a source — floor multiplier ≥ 0.5 (keep exploration).
 *   - Confidence gate: < MIN_SAMPLES → multiplier 1.0 (no change).
 *   - NO side effects, NO imports of apply/merge/push primitives.
 *   - Flag-off: scoreAdjustment returns 1.0 when priors are empty.
 *   - `listProposals` is injectable for tests; falls back to inbox/store at runtime.
 *
 * M151: EDV (Execute-Distill-Verify) independent-confirmation gate.
 *   - Flag: cfg.foundry.edvVerify (default false = current behavior).
 *   - When ON: merged outcomes require an independent confirmation
 *     (proposal.verifyResult.passed OR a separate 'verified' decision entry)
 *     before counting at full weight. Unconfirmed accepts contribute
 *     EDV_UNVERIFIED_WEIGHT (0.3) to mergedWeightedSum rather than 1.0.
 *   - SourceStats gains an optional `mergedWeightedSum` field (absent when EDV
 *     is OFF, so flag-off acceptRate is byte-identical to pre-M151).
 *   - acceptRate in EDV mode uses mergedWeightedSum in place of merged.
 *     Judge `ship` verdicts remain predictive metrics and never count as an
 *     accepted outcome before an authoritative `merged` lifecycle row exists.
 */

import type { DecisionEntry, Proposal, WorkItem, WorkSource } from '../types.js';
import { readDecisions } from './decisions-ledger.js';
import { loadWorkedLedger } from './worked-ledger.js';
import { edvConfirmationWeight } from '../portfolio/edv-verify.js';
import {
  hasRealizedMergeEvidence,
  realizedMergeOf,
} from '../inbox/realized-merge.js';
import { hasReleasedPostMergeCredit } from './post-merge-credit.js';
import { verifyProducerProvenanceV2 } from '../foundry/provenance.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum effective-sample count before we trust a prior enough to adjust.
 * Below this threshold scoreAdjustment returns 1.0 (no change).
 * Mirrors learned-router.ts's ">= 3 samples" confidence gate.
 */
export const MIN_SAMPLES = 3;

/** Floor multiplier — worst source still scores at 50% of its base value. */
export const MULTIPLIER_FLOOR = 0.5;

/** Ceiling multiplier — best source scores at most 1.5× its base value. */
export const MULTIPLIER_CEIL = 1.5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Productivity statistics for one (source, scope) bucket.
 * All rates are fractions in [0, 1]. Raw counts are non-negative integers.
 */
export interface SourceStats {
  /** Proposals created from this source. */
  created: number;
  /** Proposals that received a manager verdict (judged count). */
  judged: number;
  /** Distinct proposals with released post-merge credit and exact merge evidence. */
  merged: number;
  /** Proposals explicitly rejected. */
  rejected: number;
  /** Proposals where manager verdict was 'ship'. */
  shipCount: number;
  /** Proposals where manager verdict was 'noise' or 'harmful'. */
  noiseCount: number;
  /** Item runs that produced a real diff. */
  diffCount: number;
  /** Item runs that produced no diff (empty). */
  emptyCount: number;
  /** shipCount / judged  (0 when judged === 0). */
  shipRate: number;
  /** merged / created (or EDV-weighted merged / created; 0 when created === 0). */
  acceptRate: number;
  /** emptyCount / (diffCount + emptyCount)  (0 when no runs). */
  emptyRate: number;
  /** noiseCount / judged  (0 when judged === 0). */
  noiseRate: number;
  /**
   * M151 EDV: fractional sum of independently-confirmed merged accepts.
   * Present ONLY when computeOutcomePriors was called with edvVerify=true.
   * Each accept contributes its EDV weight (1.0 if confirmed, 0.3 if not).
   * When present, acceptRate is derived from this value instead of `merged`.
   * Absent (undefined) when EDV is OFF — ensures flag-off byte-identity.
   */
  mergedWeightedSum?: number;
}

/**
 * Full priors table from computeOutcomePriors.
 *
 * Layout:
 *   global   — per-source stats aggregated across all repos
 *   byRepo   — repo-path → per-source stats
 *
 * scoreAdjustment checks byRepo[item.repo][item.source] first, then falls
 * back to global[item.source].
 */
export interface OutcomePriors {
  global: Partial<Record<string, SourceStats>>;
  byRepo: Record<string, Partial<Record<string, SourceStats>>>;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// computeOutcomePriors options
// ---------------------------------------------------------------------------

export interface ComputeOutcomePriorsOpts {
  /**
   * Time window in ms. Entries older than now − windowMs are excluded.
   * Undefined → all history.
   */
  windowMs?: number;
  /**
   * Injectable listProposals function (for tests). When absent, the production
   * inbox/store is loaded lazily via a best-effort dynamic import.
   */
  listProposals?: () => Proposal[];
  /**
   * M151: Enable EDV (Execute-Distill-Verify) independent-confirmation gate.
   * When true, merged/accepted outcomes are weighted by whether an independent
   * confirmation exists (proposal.verifyResult.passed or a separate 'verified'
   * decision). Unconfirmed accepts contribute EDV_UNVERIFIED_WEIGHT (0.3)
   * rather than 1.0 to the mergedWeightedSum accumulator.
   *
   * Default: false (flag-off = byte-identical pre-M151 behavior).
   */
  edvVerify?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyStats(): SourceStats {
  return {
    created: 0,
    judged: 0,
    merged: 0,
    rejected: 0,
    shipCount: 0,
    noiseCount: 0,
    diffCount: 0,
    emptyCount: 0,
    shipRate: 0,
    acceptRate: 0,
    emptyRate: 0,
    noiseRate: 0,
  };
}

function recomputeRates(s: SourceStats): SourceStats {
  const runs = s.diffCount + s.emptyCount;
  // M151: when mergedWeightedSum is present (EDV ON), acceptRate uses the
  // fractional weighted sum rather than the integer merged count.
  const effectiveMerged = s.mergedWeightedSum !== undefined ? s.mergedWeightedSum : s.merged;
  return {
    ...s,
    shipRate: s.judged > 0 ? Math.min(1, s.shipCount / s.judged) : 0,
    acceptRate: s.created > 0 ? Math.min(1, effectiveMerged / s.created) : 0,
    emptyRate: runs > 0 ? s.emptyCount / runs : 0,
    noiseRate: s.judged > 0 ? Math.min(1, s.noiseCount / s.judged) : 0,
  };
}

function isNewerDecision(candidate: DecisionEntry, existing: DecisionEntry | undefined): boolean {
  if (existing === undefined) return true;
  const candidateMs = Date.parse(candidate.ts);
  const existingMs = Date.parse(existing.ts);
  if (!Number.isFinite(candidateMs)) return false;
  if (!Number.isFinite(existingMs)) return true;
  return candidateMs > existingMs;
}

function judgePredictionKey(entry: DecisionEntry): string {
  return `${entry.proposalId}\u0000${entry.engine ?? ''}\u0000${entry.model ?? ''}`;
}

function isReleasedMergedDecision(entry: DecisionEntry): boolean {
  return entry.action === 'merged' && hasReleasedPostMergeCredit(entry.labelBasis);
}

function isInWindow(timestampMs: number, sinceMs: number | undefined): boolean {
  return Number.isFinite(timestampMs) && timestampMs <= Date.now() &&
    (sinceMs === undefined || timestampMs >= sinceMs);
}

function realizedEvidenceMs(proposal: Proposal): number | null {
  const evidence = realizedMergeOf(proposal);
  if (!evidence) return null;
  const timestamp = evidence.source === 'github-host'
    ? evidence.reconciliation.observedAt
    : evidence.observedAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function realizedEvidenceSupersedes(
  proposal: Proposal,
  terminal: DecisionEntry | undefined,
): boolean {
  if (!hasRealizedMergeEvidence(proposal)) return false;
  const evidenceMs = realizedEvidenceMs(proposal);
  if (evidenceMs === null) return false;
  if (terminal?.action !== 'rejected') return true;
  const terminalMs = Date.parse(terminal.ts);
  return !Number.isFinite(terminalMs) || evidenceMs >= terminalMs;
}

/** Mutable per-scope accumulator keyed by source string. */
type StatsMap = Map<string, SourceStats>;

function touch(map: StatsMap, source: string): SourceStats {
  let s = map.get(source);
  if (s === undefined) {
    s = emptyStats();
    map.set(source, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// computeOutcomePriors
// ---------------------------------------------------------------------------

/**
 * Compute per-(source × repo) and global productivity priors.
 *
 * Signal sources:
 *   1. decisions-ledger  — manager predictions + merged/rejected lifecycle events.
 *      Each DecisionEntry is linked to a proposal via proposalId. We load
 *      proposals to resolve source/repo and qualify positive realized evidence.
 *   2. inbox/store proposals — provide `created` counts per (source, repo).
 *      `source` is derived from proposal.kind via a best-effort mapping.
 *   3. worked-ledger — WorkedEvent.itemId encodes `${repo}:${source}:${rest}`.
 *      Provides diff/empty run counts per (source, repo).
 *
 * M151: when opts.edvVerify=true, positive reinforcement from merged/accepted
 * outcomes is weighted by an independent confirmation signal. See module doc.
 *
 * Never throws. Returns empty priors on any error.
 */
export async function computeOutcomePriors(
  opts?: ComputeOutcomePriorsOpts,
): Promise<OutcomePriors> {
  try {
    const windowMs = opts?.windowMs;
    const sinceMs = windowMs !== undefined ? Date.now() - windowMs : undefined;
    const edvVerify = opts?.edvVerify === true;

    // ── 1. Load decisions ─────────────────────────────────────────────────────
    // Merge rows may predate the host observation that makes them authoritative.
    // Read bounded history, then apply merge windows to the witness timestamp.
    const decisions = readDecisions({ requireComplete: true });
    const decisionSource = (decisions as typeof decisions & {
      sourceQuality?: { sourceState: string; complete: boolean };
    }).sourceQuality;
    if (decisionSource && (decisionSource.sourceState === 'degraded' || !decisionSource.complete)) {
      return { global: {}, byRepo: {}, computedAt: new Date().toISOString() };
    }

    // ── 2. Resolve proposals (proposalId → {source, repo, proposal}) ──────────
    let proposals: Proposal[] = [];
    if (typeof opts?.listProposals === 'function') {
      try {
        proposals = opts.listProposals();
      } catch {
        proposals = [];
      }
    } else {
      // Production: lazy-import inbox/store (avoids circular dep at module load).
      try {
        const { listProposalsDetailed } = await import('../inbox/store.js');
        const read = listProposalsDetailed({ requireComplete: true });
        if (!read.complete || read.sourceState === 'degraded') {
          return { global: {}, byRepo: {}, computedAt: new Date().toISOString() };
        }
        proposals = read.proposals;
      } catch {
        proposals = [];
      }
    }

    // Build proposalId → {source, repo, proposal} lookup.
    const proposalMeta = new Map<string, { source: string; repo: string | null; proposal: Proposal }>();
    for (const p of proposals) {
      proposalMeta.set(p.id, {
        source: proposalSourceOf(p),
        repo: p.repo,
        proposal: p,
      });
    }

    // ── 3. M151 EDV: group decisions by proposalId for per-proposal lookup ────
    // Only built when edvVerify=true; skipped entirely in flag-off mode.
    const decisionsByProposal = edvVerify
      ? (() => {
          const m = new Map<string, typeof decisions>();
          for (const d of decisions) {
            let arr = m.get(d.proposalId);
            if (arr === undefined) {
              arr = [];
              m.set(d.proposalId, arr);
            }
            arr.push(d);
          }
          return m;
        })()
      : null;

    // ── 4. Load worked-ledger ─────────────────────────────────────────────────
    const worked = loadWorkedLedger();

    // ── Accumulators ──────────────────────────────────────────────────────────
    const globalMap: StatsMap = new Map();
    const repoMap = new Map<string, StatsMap>();

    function gStats(source: string): SourceStats {
      return touch(globalMap, source);
    }
    function rStats(repo: string, source: string): SourceStats {
      let rm = repoMap.get(repo);
      if (rm === undefined) {
        rm = new Map();
        repoMap.set(repo, rm);
      }
      return touch(rm, source);
    }

    // ── Count proposals created per (source, repo) ────────────────────────────
    for (const p of proposals) {
      const source = proposalSourceOf(p);
      gStats(source).created++;
      if (p.repo) rStats(p.repo, source).created++;
    }

    // ── Process decisions ─────────────────────────────────────────────────────
    // Decision rows identify when an outcome entered this reporting window,
    // but positive credit requires both the release label and the current
    // proposal's exact realized-merge witness.
    const latestMerged = new Map<string, DecisionEntry>();
    const latestRejection = new Map<string, DecisionEntry>();
    const latestJudgePrediction = new Map<string, DecisionEntry>();
    for (const d of decisions) {
      if (isReleasedMergedDecision(d)) {
        const existing = latestMerged.get(d.proposalId);
        if (isNewerDecision(d, existing)) latestMerged.set(d.proposalId, d);
      }
      if (d.action === 'rejected') {
        const existing = latestRejection.get(d.proposalId);
        if (isNewerDecision(d, existing)) latestRejection.set(d.proposalId, d);
      }
      if (d.action === 'judged' && isInWindow(Date.parse(d.ts), sinceMs)) {
        const verdict = (d.verdict ?? '').toLowerCase();
        if (verdict === 'ship' || verdict === 'noise' || verdict === 'harmful' || verdict === 'rejected') {
          const key = judgePredictionKey(d);
          const existing = latestJudgePrediction.get(key);
          if (isNewerDecision(d, existing)) latestJudgePrediction.set(key, d);
        }
      }
    }

    for (const [proposalId] of latestMerged) {
      const meta = proposalMeta.get(proposalId);
      const evidenceMs = meta ? realizedEvidenceMs(meta.proposal) : null;
      if (meta === undefined || evidenceMs === null || !isInWindow(evidenceMs, sinceMs) ||
        !verifyProducerProvenanceV2(meta.proposal).ok ||
        !realizedEvidenceSupersedes(meta.proposal, latestRejection.get(proposalId))) continue;
      const { source, repo } = meta;
      if (edvVerify && decisionsByProposal !== null) {
        const decisionsForProposal = decisionsByProposal.get(proposalId) ?? [];
        const { weight } = edvConfirmationWeight(meta.proposal, decisionsForProposal);
        gStats(source).merged++;
        if (repo) rStats(repo, source).merged++;
        const gs = gStats(source);
        gs.mergedWeightedSum = (gs.mergedWeightedSum ?? 0) + weight;
        if (repo) {
          const rs = rStats(repo, source);
          rs.mergedWeightedSum = (rs.mergedWeightedSum ?? 0) + weight;
        }
      } else {
        gStats(source).merged++;
        if (repo) rStats(repo, source).merged++;
      }
    }

    for (const [proposalId, terminal] of latestRejection) {
      if (!isInWindow(Date.parse(terminal.ts), sinceMs)) continue;
      const meta = proposalMeta.get(proposalId);
      if (meta !== undefined && latestMerged.has(proposalId) &&
        realizedEvidenceSupersedes(meta.proposal, terminal)) continue;
      if (terminal.action !== 'rejected') continue;
      const source = meta?.source ?? 'unknown';
      const repo = meta?.repo ?? null;
      gStats(source).rejected++;
      if (repo) rStats(repo, source).rejected++;
    }

    // Judge rows remain predictive calibration only. Retries by the same
    // judge engine/model collapse to the newest prediction for each proposal.
    for (const d of latestJudgePrediction.values()) {
      const meta = proposalMeta.get(d.proposalId);
      const source = meta?.source ?? 'unknown';
      const repo = meta?.repo ?? null;
      const verdict = (d.verdict ?? '').toLowerCase();
      gStats(source).judged++;
      if (repo) rStats(repo, source).judged++;

      if (verdict === 'ship') {
        gStats(source).shipCount++;
        if (repo) rStats(repo, source).shipCount++;
      }

      if (verdict === 'noise' || verdict === 'harmful') {
        gStats(source).noiseCount++;
        if (repo) rStats(repo, source).noiseCount++;
      }
    }

    // ── Process worked-ledger (diff/empty run counts) ─────────────────────────
    for (const ev of worked.events) {
      if (sinceMs !== undefined) {
        const evMs = Date.parse(ev.ts);
        if (!isNaN(evMs) && evMs < sinceMs) continue;
      }

      const parsed = parseItemId(ev.itemId);
      if (parsed === null) continue;
      const { source, repo } = parsed;

      if (ev.outcome === 'dispatch-blocked') continue;
      if (ev.outcome === 'diff') {
        // Historical executor diffs and merge:shipped credit share one
        // origin-less schema. Until an origin-bound v2 event exists, treating
        // either as positive adaptive credit would preserve false merge reward.
        continue;
      } else {
        gStats(source).emptyCount++;
        if (repo) rStats(repo, source).emptyCount++;
      }
    }

    // ── Finalize: recompute rates ─────────────────────────────────────────────
    const global: OutcomePriors['global'] = {};
    for (const [src, stats] of globalMap) {
      global[src] = recomputeRates(stats);
    }

    const byRepo: OutcomePriors['byRepo'] = {};
    for (const [repo, rm] of repoMap) {
      byRepo[repo] = {};
      for (const [src, stats] of rm) {
        byRepo[repo]![src] = recomputeRates(stats);
      }
    }

    return { global, byRepo, computedAt: new Date().toISOString() };
  } catch {
    return { global: {}, byRepo: {}, computedAt: new Date().toISOString() };
  }
}

// ---------------------------------------------------------------------------
// scoreAdjustment
// ---------------------------------------------------------------------------

/**
 * Return a bounded score multiplier for `item` based on its source's
 * historical productivity in `priors`.
 *
 * Productivity formula (weights sum to 1.0):
 *   productivity =
 *     acceptRate × 0.70   (work authoritatively merged)
 *     (1 - emptyRate) × 0.20   (runs produce real diffs)
 *     (1 - noiseRate) × 0.10   (not noise/harmful)
 *
 * shipRate remains available as a judge-prediction metric, but it cannot
 * positively adjust source routing before application/merge is observed.
 *
 * Multiplier mapping  [0, 1] → [FLOOR, CEIL]:
 *   multiplier = FLOOR + productivity × (CEIL − FLOOR)
 *              = 0.5  + productivity × 1.0
 *
 * Confidence gate:
 *   effectiveSamples = max(judged, created, diffCount + emptyCount)
 *   if effectiveSamples < MIN_SAMPLES → return 1.0 (no adjustment)
 *
 * Lookup: byRepo[item.repo][item.source] → global[item.source] → 1.0
 *
 * M151: acceptRate is pre-adjusted by EDV weighting in computeOutcomePriors
 * (via mergedWeightedSum). scoreAdjustment itself is unchanged — it reads
 * stats.acceptRate which already reflects the EDV-adjusted value when EDV
 * is ON. Flag-off: stats.acceptRate is identical to pre-M151 (no mergedWeightedSum).
 *
 * Never throws.
 */
export function scoreAdjustment(item: WorkItem, priors: OutcomePriors): number {
  try {
    const repoSpecific = priors.byRepo[item.repo]?.[item.source];
    const globalFallback = priors.global[item.source];
    const stats: SourceStats | undefined = repoSpecific ?? globalFallback;

    if (stats === undefined) return 1.0;

    const effectiveSamples = Math.max(
      stats.judged,
      stats.created,
      stats.diffCount + stats.emptyCount,
    );
    if (effectiveSamples < MIN_SAMPLES) return 1.0;

    const productivity =
      stats.acceptRate * 0.7 +
      (1 - stats.emptyRate) * 0.2 +
      (1 - stats.noiseRate) * 0.1;

    // Map [0,1] → [FLOOR, CEIL].
    const raw = MULTIPLIER_FLOOR + productivity * (MULTIPLIER_CEIL - MULTIPLIER_FLOOR);

    // Clamp for floating-point safety.
    return Math.max(MULTIPLIER_FLOOR, Math.min(MULTIPLIER_CEIL, raw));
  } catch {
    return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Internal: WorkItem id parser
// ---------------------------------------------------------------------------

/**
 * Parse a WorkItem id `${repo}:${source}:${rest}` → {source, repo}.
 *
 * WorkItem ids are produced by scanners as `${repoAbsPath}:${source}:${hash}`.
 * Absolute paths on macOS/Linux contain no ':', so splitting by ':' is safe.
 * Returns null when the id doesn't match the expected format.
 */
function parseItemId(itemId: string): { source: string; repo: string } | null {
  try {
    const colonIdx = itemId.indexOf(':');
    if (colonIdx < 0) return null;
    const repo = itemId.slice(0, colonIdx);
    const rest = itemId.slice(colonIdx + 1);
    const colonIdx2 = rest.indexOf(':');
    if (colonIdx2 < 0) return null;
    const source = rest.slice(0, colonIdx2);
    if (repo === '' || source === '') return null;
    return { source, repo };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: proposal → source label
// ---------------------------------------------------------------------------

/**
 * Map a Proposal's kind to a WorkSource-equivalent label for bucketing.
 * Proposals don't carry WorkItem.source directly, so proposal.kind is the
 * best available proxy.
 */
function proposalSourceOf(p: Proposal): string {
  if (p.workSource) return p.workSource;
  const KIND_TO_SOURCE: Record<string, string> = {
    patch: 'todo',
    pr: 'todo',
    note: 'doc',
    tuning: 'self',
    security: 'security',
    dep: 'dep',
    issue: 'issue',
    test: 'test',
    lint: 'lint',
    refactor: 'todo',
  };
  return KIND_TO_SOURCE[p.kind] ?? p.kind;
}

// Re-export for consumers.
export type { WorkSource };

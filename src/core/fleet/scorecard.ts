/**
 * M356: Fleet self-evaluation scorecard.
 *
 * docs/NORTH-STAR.md defines success as "a system measurably better at
 * improving itself over time": compounding velocity, merges/week up, cost/merge
 * down. This module is the MEASUREMENT layer that makes that claim provable
 * instead of asserted — a velocity + quality + capability scorecard computed
 * strictly from evidence stores (proposal store, decisions ledger, persisted
 * eval reports), never from a live model call, network fetch, or repo mutation.
 *
 * EVIDENCE-ONLY DISCIPLINE (non-negotiable; mirrors quality-metrics.ts and
 * post-merge-credit.ts, this codebase's existing authentication vocabulary):
 *
 *   - "realized" merges are derived directly from complete, non-partial
 *     patch/PR proposals with a non-empty diff whose persisted realized-merge
 *     witness passes authenticatedRealizedMergeOf() and whose canonical
 *     identity is available on this read. Duplicate canonical identities
 *     degrade the section to unknown rather than selecting a winner. The
 *     generic decisions ledger is never treated as merge authority; its rows
 *     may attribute spend/producer metadata but cannot create or replay credit.
 *
 *   - "released" merges require action==='merged' plus a label accepted by
 *     hasReleasedPostMergeCredit(labelBasis).
 *     hasReleasedPostMergeCredit() cryptographically verifies an HMAC-signed
 *     token (post-merge-credit.ts). A bare or forged label verifies false.
 *     While operational release is compile-time disabled, the scorecard
 *     reports this channel as uncommissioned with a null count.
 *
 *   - Every section of FleetScorecard carries its own `sourceQuality`. When
 *     the read behind a section is incomplete or degraded, every count in
 *     that section is `null` — UNKNOWN, never a fabricated 0. Only a
 *     genuinely empty, COMPLETE read produces a real 0. A caller must check
 *     sourceQuality before trusting a 0.
 *
 *   - Never throws. Every public function degrades to an all-null/unknown
 *     section on any read error, mirroring computeQualityMetrics's contract.
 *
 * WHAT THIS DOES NOT DO:
 *   - No repo mutation, no network call, no live model invocation.
 *   - Does not touch daemon/loop.ts (see snapshotScorecardIfDue doc comment
 *     for the recommended, NOT-applied, one-line call site).
 */

import { listProposalsDetailed } from '../inbox/store.js';
import {
  authenticatedRealizedMergeOf,
  canonicalRealizedMergeIdentity,
} from '../inbox/realized-merge.js';
import {
  readDecisions,
  readDecisionsDetailed,
  type DecisionsReadResult,
} from './decisions-ledger.js';
import {
  hasReleasedPostMergeCredit,
  POST_MERGE_CREDIT_OPERATIONAL_RELEASE,
} from './post-merge-credit.js';
import { canonicalModelTag } from '../run/model-catalog.js';
import { loadLastReport, type BenchReport } from '../eval/swe-bench.js';
import type { DecisionEntry, Proposal } from '../types.js';
import {
  appendScorecardSnapshot,
  readScorecardHistory,
  type ScorecardSnapshotRecord,
} from './scorecard-history.js';

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export type ScorecardWindow = '7d' | '30d';

function windowMs(window: ScorecardWindow): number {
  return window === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Shared source-quality shape
// ---------------------------------------------------------------------------

export interface ScorecardSourceQuality {
  sourceState: 'healthy' | 'degraded' | 'missing';
  complete: boolean;
  reasons: string[];
}

function sqFromProposals(read: { sourceState: 'missing' | 'healthy' | 'degraded'; complete: boolean; stopReasons?: readonly string[] }): ScorecardSourceQuality {
  return {
    sourceState: read.sourceState,
    complete: read.complete,
    reasons: [...(read.stopReasons ?? [])],
  };
}

function sqFromDecisions(read: DecisionsReadResult): ScorecardSourceQuality {
  return {
    sourceState: read.sourceState,
    complete: read.complete,
    reasons: [...read.stopReasons],
  };
}

const UNKNOWN_SQ: ScorecardSourceQuality = {
  sourceState: 'degraded',
  complete: false,
  reasons: ['unexpected-error'],
};

// ---------------------------------------------------------------------------
// Section shapes
// ---------------------------------------------------------------------------

export interface ScorecardProposals {
  sourceQuality: ScorecardSourceQuality;
  /** Proposals created (dispatched) within the window. */
  filed: number | null;
  /** Filed proposals carrying a non-empty diff and not isPartial. */
  complete: number | null;
  /** filed - complete (empty-diff or partial-capture proposals). */
  partial: number | null;
}

export interface ScorecardJudge {
  sourceQuality: ScorecardSourceQuality;
  /** All 'judged' decision rows in window (attempts, including failures). */
  calls: number | null;
  /** Judge calls that produced a real verdict (calls - failures.total). */
  verdicts: number | null;
  failures: { parse: number | null; network: number | null; total: number | null };
  /** failures.total / calls. Null when calls is 0 or unknown. */
  failureRate: number | null;
}

export interface ScorecardMerges {
  sourceQuality: ScorecardSourceQuality;
  /** Decision rows correlated to exact authenticated realized-merge proposals. */
  realized: number | null;
  /** Released credit count, or null while the release protocol is uncommissioned. */
  released: number | null;
  releasedState: 'commissioned' | 'uncommissioned';
  releasedReason?: 'operational-release-disabled';
}

export interface ScorecardCost {
  sourceQuality: ScorecardSourceQuality;
  /** Count of authenticated realized merges this section's spend is joined against. */
  mergedChanges: number | null;
  /** Producer (dispatch) spend attributed to those merges. */
  totalCostUsd: number | null;
  totalTokensIn: number | null;
  totalTokensOut: number | null;
  /** totalCostUsd / mergedChanges. Null when mergedChanges is 0/unknown — never a fabricated division. */
  perMergedChangeUsd: number | null;
  /** True when the per-proposal cost join was capped before covering every merge this window. */
  capped: boolean;
}

export interface ScorecardLatency {
  sourceQuality: ScorecardSourceQuality;
  sampleSize: number | null;
  dispatchToVerdictMsMedian: number | null;
  dispatchToVerdictMsMean: number | null;
}

export interface ScorecardLearning {
  sourceQuality: ScorecardSourceQuality;
  /** 'self-improve:written' decision rows in window — the anti-playbook lesson writer's own telemetry. */
  rejectionLessonsWritten: number | null;
}

export interface ScorecardEngineSplit {
  engine: string;
  model: string;
  dispatches: number;
  realizedMerges: number;
  releasedMerges: number | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** costUsd / realizedMerges for THIS engine/model. Null when realizedMerges is 0. */
  costPerRealizedMergeUsd: number | null;
}

export interface ScorecardCapability {
  sourceQuality: ScorecardSourceQuality;
  state: 'observed' | 'unavailable';
  reason?: string;
  latest?: {
    id: string;
    ts: string;
    engine: string;
    total: number;
    resolved: number;
    resolveRate: number;
  };
}

export interface FleetScorecard {
  window: ScorecardWindow;
  generatedAt: string;
  proposals: ScorecardProposals;
  judge: ScorecardJudge;
  merges: ScorecardMerges;
  cost: ScorecardCost;
  latency: ScorecardLatency;
  learning: ScorecardLearning;
  byEngine: ScorecardEngineSplit[];
  /** Capability axis — separate from production velocity. See module doc. */
  capability: ScorecardCapability;
}

// ---------------------------------------------------------------------------
// Authenticated merge classification
// ---------------------------------------------------------------------------

interface AuthenticatedRealizedSelection {
  ids: Set<string>;
  duplicateCanonicalIdentity: boolean;
}

function authenticatedRealizedSelection(
  proposalsById: ReadonlyMap<string, Proposal>,
  sinceMs: number,
): AuthenticatedRealizedSelection {
  const ids = new Set<string>();
  const proposalByCanonicalIdentity = new Map<string, string>();
  let duplicateCanonicalIdentity = false;
  const nowMs = Date.now();
  for (const [proposalId, proposal] of proposalsById) {
    if (proposal.id !== proposalId || proposal.isPartial === true ||
      (proposal.kind !== 'patch' && proposal.kind !== 'pr') ||
      typeof proposal.diff !== 'string' || proposal.diff.trim().length === 0) continue;
    const evidence = authenticatedRealizedMergeOf(proposal);
    const identity = canonicalRealizedMergeIdentity(proposal);
    if (!evidence || !identity) continue;
    const priorProposalId = proposalByCanonicalIdentity.get(identity.key);
    if (priorProposalId !== undefined && priorProposalId !== proposalId) {
      duplicateCanonicalIdentity = true;
    } else {
      proposalByCanonicalIdentity.set(identity.key, proposalId);
    }
    const observedAt = evidence?.source === 'local-default-branch'
      ? evidence.observedAt
      : evidence?.reconciliation.observedAt;
    const witnessedMs = Date.parse(observedAt ?? '');
    if (!Number.isFinite(witnessedMs) || witnessedMs < sinceMs || witnessedMs > nowMs) continue;
    ids.add(proposalId);
  }
  return { ids, duplicateCanonicalIdentity };
}

function isReleasedMergedDecision(entry: DecisionEntry): boolean {
  return entry.action === 'merged' && hasReleasedPostMergeCredit(entry.labelBasis);
}

function isNewer(candidate: DecisionEntry, existing: DecisionEntry | undefined): boolean {
  if (!existing) return true;
  const a = Date.parse(candidate.ts);
  const b = Date.parse(existing.ts);
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

interface ScorecardProposalEvidence {
  section: ScorecardProposals;
  proposalsById: Map<string, Proposal>;
  sourceQuality: ScorecardSourceQuality;
  ok: boolean;
}

function buildProposalsSection(sinceMs: number): ScorecardProposalEvidence {
  try {
    const read = listProposalsDetailed({ requireComplete: true });
    const sq = sqFromProposals(read);
    if (!read.complete || read.sourceState === 'degraded') {
      return {
        section: { sourceQuality: sq, filed: null, complete: null, partial: null },
        proposalsById: new Map(),
        sourceQuality: sq,
        ok: false,
      };
    }
    let filed = 0;
    let complete = 0;
    const proposalsById = new Map<string, Proposal>();
    for (const p of read.proposals) {
      proposalsById.set(p.id, p);
      const createdMs = Date.parse(p.createdAt);
      if (!Number.isFinite(createdMs) || createdMs < sinceMs) continue;
      filed++;
      const hasDiff = typeof p.diff === 'string' && p.diff.length > 0;
      if (hasDiff && p.isPartial !== true) complete++;
    }
    return {
      section: { sourceQuality: sq, filed, complete, partial: filed - complete },
      proposalsById,
      sourceQuality: sq,
      ok: true,
    };
  } catch {
    return {
      section: { sourceQuality: UNKNOWN_SQ, filed: null, complete: null, partial: null },
      proposalsById: new Map(),
      sourceQuality: UNKNOWN_SQ,
      ok: false,
    };
  }
}

function combinedSourceQuality(
  decisions: ScorecardSourceQuality,
  proposals: ScorecardSourceQuality,
): ScorecardSourceQuality {
  const sourceState = decisions.sourceState === 'degraded' || proposals.sourceState === 'degraded'
    ? 'degraded'
    : decisions.sourceState === 'missing' || proposals.sourceState === 'missing'
      ? 'missing'
      : 'healthy';
  return {
    sourceState,
    complete: decisions.complete && proposals.complete,
    reasons: [
      ...decisions.reasons.map((reason) => `decisions:${reason}`),
      ...proposals.reasons.map((reason) => `proposals:${reason}`),
    ],
  };
}

function releasedMergeFields(released: number | null): Pick<
  ScorecardMerges,
  'released' | 'releasedState' | 'releasedReason'
> {
  return POST_MERGE_CREDIT_OPERATIONAL_RELEASE
    ? { released, releasedState: 'commissioned' }
    : {
        released: null,
        releasedState: 'uncommissioned',
        releasedReason: 'operational-release-disabled',
      };
}

function buildJudgeSection(decisions: readonly DecisionEntry[], sq: ScorecardSourceQuality, ok: boolean): ScorecardJudge {
  if (!ok) {
    return {
      sourceQuality: sq,
      calls: null,
      verdicts: null,
      failures: { parse: null, network: null, total: null },
      failureRate: null,
    };
  }
  let calls = 0;
  let parse = 0;
  let network = 0;
  for (const d of decisions) {
    if (d.action !== 'judged') continue;
    calls++;
    if (d.judgeReasonCode === 'judge-parse-failure') parse++;
    else if (d.judgeReasonCode === 'judge-network-failure') network++;
  }
  const total = parse + network;
  return {
    sourceQuality: sq,
    calls,
    verdicts: calls - total,
    failures: { parse, network, total },
    failureRate: calls > 0 ? total / calls : null,
  };
}

function buildMergesSection(
  decisions: readonly DecisionEntry[],
  proposalsById: ReadonlyMap<string, Proposal>,
  sq: ScorecardSourceQuality,
  ok: boolean,
  sinceMs: number,
): {
  section: ScorecardMerges;
  realizedIds: Set<string>;
  releasedIds: Set<string>;
  identityComplete: boolean;
} {
  if (!ok) {
    return {
      section: { sourceQuality: sq, realized: null, ...releasedMergeFields(null) },
      realizedIds: new Set(),
      releasedIds: new Set(),
      identityComplete: false,
    };
  }
  // Realized identity comes only from authenticated proposal witnesses. The
  // unsigned decisions ledger cannot create or multiply this set.
  const selection = authenticatedRealizedSelection(proposalsById, sinceMs);
  if (selection.duplicateCanonicalIdentity) {
    return {
      section: {
        sourceQuality: {
          sourceState: 'degraded',
          complete: false,
          reasons: [...sq.reasons, 'duplicate-canonical-realized-merge-identity'],
        },
        realized: null,
        ...releasedMergeFields(null),
      },
      realizedIds: new Set(),
      releasedIds: new Set(),
      identityComplete: false,
    };
  }
  const realizedIds = selection.ids;
  const latestReleased = new Map<string, DecisionEntry>();
  for (const d of decisions) {
    if (POST_MERGE_CREDIT_OPERATIONAL_RELEASE && isReleasedMergedDecision(d)) {
      const existing = latestReleased.get(d.proposalId);
      if (isNewer(d, existing)) latestReleased.set(d.proposalId, d);
    }
  }
  const releasedIds = new Set(
    [...latestReleased.keys()].filter((proposalId) => realizedIds.has(proposalId)),
  );
  return {
    section: {
      sourceQuality: sq,
      realized: realizedIds.size,
      ...releasedMergeFields(releasedIds.size),
    },
    realizedIds,
    releasedIds,
    identityComplete: true,
  };
}

/** Bound on individual proposalId cost lookups per scorecard build — mirrors
 *  self-improve.ts / post-merge-credit.ts's own per-pass sweep bounds. */
const MAX_COST_JOIN_PROPOSALS = 500;

function buildCostSection(
  realizedIds: Set<string>,
  sq: ScorecardSourceQuality,
  ok: boolean,
): { section: ScorecardCost; dispatchByProposal: Map<string, DecisionEntry[]> } {
  const dispatchByProposal = new Map<string, DecisionEntry[]>();
  if (!ok) {
    return {
      section: {
        sourceQuality: sq, mergedChanges: null, totalCostUsd: null,
        totalTokensIn: null, totalTokensOut: null, perMergedChangeUsd: null, capped: false,
      },
      dispatchByProposal,
    };
  }
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let degraded = false;
  let capped = false;
  let inspected = 0;

  for (const proposalId of realizedIds) {
    if (inspected >= MAX_COST_JOIN_PROPOSALS) {
      capped = true;
      break;
    }
    inspected++;
    try {
      const rows = readDecisions({ proposalId, requireComplete: true });
      const quality = (rows as typeof rows & {
        sourceQuality?: { sourceState?: string; complete?: boolean };
      }).sourceQuality;
      if (quality && (quality.sourceState === 'degraded' || quality.complete === false)) {
        degraded = true;
        continue;
      }
      const proposedRows = rows.filter((r) => r.action === 'proposed');
      dispatchByProposal.set(proposalId, proposedRows);
      for (const r of proposedRows) {
        if (typeof r.costUsd === 'number') totalCostUsd += r.costUsd;
        if (typeof r.tokensIn === 'number') totalTokensIn += r.tokensIn;
        if (typeof r.tokensOut === 'number') totalTokensOut += r.tokensOut;
      }
    } catch {
      degraded = true;
    }
  }

  if (degraded) {
    return {
      section: {
        sourceQuality: { sourceState: 'degraded', complete: false, reasons: ['cost-join-degraded'] },
        mergedChanges: null, totalCostUsd: null, totalTokensIn: null, totalTokensOut: null,
        perMergedChangeUsd: null, capped,
      },
      dispatchByProposal,
    };
  }

  const mergedChanges = capped ? inspected : realizedIds.size;
  return {
    section: {
      sourceQuality: capped
        ? { sourceState: 'degraded', complete: false, reasons: ['cost-join-capped'] }
        : sq,
      mergedChanges,
      totalCostUsd,
      totalTokensIn,
      totalTokensOut,
      perMergedChangeUsd: mergedChanges > 0 ? totalCostUsd / mergedChanges : null,
      capped,
    },
    dispatchByProposal,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function buildLatencySection(decisions: readonly DecisionEntry[], sq: ScorecardSourceQuality, ok: boolean): ScorecardLatency {
  if (!ok) {
    return { sourceQuality: sq, sampleSize: null, dispatchToVerdictMsMedian: null, dispatchToVerdictMsMean: null };
  }
  const earliestProposed = new Map<string, number>();
  for (const d of decisions) {
    if (d.action !== 'proposed') continue;
    const ms = Date.parse(d.ts);
    if (!Number.isFinite(ms)) continue;
    const existing = earliestProposed.get(d.proposalId);
    if (existing === undefined || ms < existing) earliestProposed.set(d.proposalId, ms);
  }
  const deltas: number[] = [];
  for (const d of decisions) {
    if (d.action !== 'judged') continue;
    const dispatchMs = earliestProposed.get(d.proposalId);
    if (dispatchMs === undefined) continue;
    const judgedMs = Date.parse(d.ts);
    if (!Number.isFinite(judgedMs) || judgedMs < dispatchMs) continue;
    deltas.push(judgedMs - dispatchMs);
  }
  const mean = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  return {
    sourceQuality: sq,
    sampleSize: deltas.length,
    dispatchToVerdictMsMedian: median(deltas),
    dispatchToVerdictMsMean: mean,
  };
}

function buildLearningSection(decisions: readonly DecisionEntry[], sq: ScorecardSourceQuality, ok: boolean): ScorecardLearning {
  if (!ok) return { sourceQuality: sq, rejectionLessonsWritten: null };
  let count = 0;
  for (const d of decisions) {
    if (d.action === 'self-improve:written') count++;
  }
  return { sourceQuality: sq, rejectionLessonsWritten: count };
}

function buildEngineSplits(
  decisions: readonly DecisionEntry[],
  realizedIds: Set<string>,
  releasedIds: Set<string>,
  ok: boolean,
): ScorecardEngineSplit[] {
  if (!ok) return [];

  const producerOf = new Map<string, { engine: string; model: string }>();
  const key = (engine: string, model: string) => `${engine}:${model}`;
  const acc = new Map<string, ScorecardEngineSplit>();

  const ensure = (engine: string, model: string): ScorecardEngineSplit => {
    const k = key(engine, model);
    let entry = acc.get(k);
    if (!entry) {
      entry = {
        engine,
        model,
        dispatches: 0,
        realizedMerges: 0,
        releasedMerges: POST_MERGE_CREDIT_OPERATIONAL_RELEASE ? 0 : null,
        costUsd: 0, tokensIn: 0, tokensOut: 0, costPerRealizedMergeUsd: null,
      };
      acc.set(k, entry);
    }
    return entry;
  };

  // Newest-first ledger: earliest 'proposed' per proposal wins for producer identity.
  for (const d of [...decisions].reverse()) {
    if (d.action !== 'proposed' || !d.engine) continue;
    const model = canonicalModelTag(d.engine, d.model ?? '') || '(unknown)';
    if (!producerOf.has(d.proposalId)) producerOf.set(d.proposalId, { engine: d.engine, model });
    const entry = ensure(d.engine, model);
    entry.dispatches++;
    if (typeof d.costUsd === 'number') entry.costUsd += d.costUsd;
    if (typeof d.tokensIn === 'number') entry.tokensIn += d.tokensIn;
    if (typeof d.tokensOut === 'number') entry.tokensOut += d.tokensOut;
  }

  for (const proposalId of realizedIds) {
    const producer = producerOf.get(proposalId);
    if (!producer) continue;
    ensure(producer.engine, producer.model).realizedMerges++;
  }
  for (const proposalId of releasedIds) {
    const producer = producerOf.get(proposalId);
    if (!producer) continue;
    const entry = ensure(producer.engine, producer.model);
    if (entry.releasedMerges !== null) entry.releasedMerges++;
  }

  for (const entry of acc.values()) {
    entry.costPerRealizedMergeUsd = entry.realizedMerges > 0 ? entry.costUsd / entry.realizedMerges : null;
  }

  return [...acc.values()].sort((a, b) => b.dispatches - a.dispatches);
}

function benchReportSummary(report: BenchReport): NonNullable<ScorecardCapability['latest']> {
  return {
    id: report.id, ts: report.ts, engine: report.engine,
    total: report.total, resolved: report.resolved, resolveRate: report.resolveRate,
  };
}

function buildCapabilitySection(): ScorecardCapability {
  try {
    const report = loadLastReport();
    if (!report) {
      return {
        sourceQuality: { sourceState: 'missing', complete: true, reasons: [] },
        state: 'unavailable',
        reason:
          'no swe-bench report has been persisted to ~/.ashlr/eval/ — the harness needs ' +
          'a real dataset (see loadSweBenchDataset) and a reachable coding engine to produce ' +
          'non-empty diffs. `ashlr eval swe-bench --fixtures` runs hermetically (no network/dataset) ' +
          'but still needs a configured engine to resolve any task; without one it correctly reports 0% resolved.',
      };
    }
    return {
      sourceQuality: { sourceState: 'healthy', complete: true, reasons: [] },
      state: 'observed',
      latest: benchReportSummary(report),
    };
  } catch {
    return {
      sourceQuality: { sourceState: 'degraded', complete: false, reasons: ['eval-report-read-error'] },
      state: 'unavailable',
      reason: 'failed to read persisted eval reports',
    };
  }
}

// ---------------------------------------------------------------------------
// Public: computeFleetScorecard()
// ---------------------------------------------------------------------------

/**
 * Compute the fleet self-evaluation scorecard for the requested trailing
 * window. Reads the proposal store, the decisions ledger, and persisted eval
 * reports — nothing else. Never throws.
 */
export function computeFleetScorecard(window: ScorecardWindow): FleetScorecard {
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const sinceMs = nowMs - windowMs(window);

  const proposalEvidence = buildProposalsSection(sinceMs);

  let decisionRead: DecisionsReadResult;
  try {
    decisionRead = readDecisionsDetailed({ sinceMs });
  } catch {
    decisionRead = {
      decisions: [], sourceState: 'degraded', sourcePresent: false, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
  }
  const decisionsOk = decisionRead.complete && decisionRead.sourceState !== 'degraded';
  const decisionsSq = sqFromDecisions(decisionRead);
  const decisions = decisionRead.decisions;
  const mergeSq = POST_MERGE_CREDIT_OPERATIONAL_RELEASE
    ? combinedSourceQuality(decisionsSq, proposalEvidence.sourceQuality)
    : proposalEvidence.sourceQuality;
  const mergesOk = proposalEvidence.ok &&
    (!POST_MERGE_CREDIT_OPERATIONAL_RELEASE || decisionsOk);
  const attributionSq = combinedSourceQuality(decisionsSq, proposalEvidence.sourceQuality);
  const attributionOk = decisionsOk && proposalEvidence.ok;

  const judge = buildJudgeSection(decisions, decisionsSq, decisionsOk);
  const { section: merges, realizedIds, releasedIds, identityComplete } = buildMergesSection(
    decisions,
    proposalEvidence.proposalsById,
    mergeSq,
    mergesOk,
    sinceMs,
  );
  const mergeAttributionOk = attributionOk && identityComplete;
  const mergeAttributionSq = identityComplete ? attributionSq : merges.sourceQuality;
  const { section: cost } = buildCostSection(realizedIds, mergeAttributionSq, mergeAttributionOk);
  const latency = buildLatencySection(decisions, decisionsSq, decisionsOk);
  const learning = buildLearningSection(decisions, decisionsSq, decisionsOk);
  const byEngine = buildEngineSplits(decisions, realizedIds, releasedIds, mergeAttributionOk);
  const capability = buildCapabilitySection();

  return {
    window,
    generatedAt,
    proposals: proposalEvidence.section,
    judge,
    merges,
    cost,
    latency,
    learning,
    byEngine,
    capability,
  };
}

// ---------------------------------------------------------------------------
// Trend — week-over-week deltas from persisted snapshot history
// ---------------------------------------------------------------------------

export interface ScorecardTrendPoint {
  ts: string;
  window: ScorecardWindow;
  merges: { realized: number | null; released: number | null };
  releasedState: ScorecardMerges['releasedState'];
  costPerMergedChangeUsd: number | null;
  proposalsFiled: number | null;
  rejectionLessonsWritten: number | null;
}

export interface ScorecardTrend {
  sourceQuality: ScorecardSourceQuality;
  points: ScorecardTrendPoint[];
}

function toTrendPoint(record: ScorecardSnapshotRecord): ScorecardTrendPoint {
  return {
    ts: record.ts,
    window: record.window,
    merges: { realized: record.scorecard.merges.realized, released: record.scorecard.merges.released },
    releasedState: record.scorecard.merges.releasedState ?? 'uncommissioned',
    costPerMergedChangeUsd: record.scorecard.cost.perMergedChangeUsd,
    proposalsFiled: record.scorecard.proposals.filed,
    rejectionLessonsWritten: record.scorecard.learning.rejectionLessonsWritten,
  };
}

/**
 * Read persisted scorecard history for the given window, newest first,
 * bounded. Never throws.
 */
export function readScorecardTrend(window: ScorecardWindow, opts: { limit?: number } = {}): ScorecardTrend {
  try {
    const read = readScorecardHistory({ limit: opts.limit ?? 26 });
    const points = read.records
      .filter((r) => r.window === window)
      .map(toTrendPoint);
    return {
      sourceQuality: { sourceState: read.sourceState, complete: read.complete, reasons: [...read.stopReasons] },
      points,
    };
  } catch {
    return { sourceQuality: UNKNOWN_SQ, points: [] };
  }
}

// ---------------------------------------------------------------------------
// Periodic snapshot hook
// ---------------------------------------------------------------------------

/** Minimum time between persisted snapshots — daily cadence is enough
 *  resolution for a weekly trend without spamming the history file. */
const SNAPSHOT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Compute both trailing windows and append a snapshot to scorecard history
 * IF the last persisted snapshot is missing or older than
 * SNAPSHOT_MIN_INTERVAL_MS. No-ops otherwise. Never throws.
 *
 * NOT WIRED IN. This codebase's only low-cadence periodic hook today is
 * daemon/loop.ts's setInterval tick (out of scope for this change — see
 * module doc / task report). The intended call site, once wired, is a
 * one-line addition alongside the existing sibling sweeps in loop.ts's tick
 * handler (next to `sweepRejectionLearning(liveCfg)` and
 * `sweepPostMergeCreditReleases()`):
 *
 *   const { snapshotScorecardIfDue } = await import('../fleet/scorecard.js');
 *   snapshotScorecardIfDue();
 *
 * Safe to call from anywhere else in the meantime (CLI, a cron script, a
 * future scheduler) — it is idempotent and self-throttling.
 */
export function snapshotScorecardIfDue(opts: { nowMs?: number } = {}): { wrote: boolean } {
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const last = readScorecardHistory({ limit: 2 });
    if (last.stopReasons.includes('unsupported-platform')) return { wrote: false };
    const recentWindows = new Set(
      last.records
        .filter((record) => {
          const lastMs = Date.parse(record.ts);
          return Number.isFinite(lastMs) && nowMs - lastMs < SNAPSHOT_MIN_INTERVAL_MS;
        })
        .map((record) => record.window),
    );
    if (recentWindows.has('7d') && recentWindows.has('30d')) {
      return { wrote: false };
    }
    const ts = new Date(nowMs).toISOString();
    let complete = true;
    for (const window of ['7d', '30d'] as const) {
      const scorecard = computeFleetScorecard(window);
      complete = appendScorecardSnapshot({ ts, window, scorecard }) && complete;
    }
    return { wrote: complete };
  } catch {
    return { wrote: false };
  }
}

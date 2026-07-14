/**
 * M187: Counterfactual replay for judge calibration.
 *
 * The problem this fixes
 * ──────────────────────
 * The judge-trace store (M141) + decisions ledger (M119) record what the judge
 * said and what later happened (merged / reverted / rejected), but nothing
 * turns that history into a *measurable* trust signal — judgeHealth's kappa is
 * computed against the SAME historical verdicts that produced the outcome, so a
 * judge that simply ships everything that gets merged scores high while telling
 * us nothing new (κ collapses toward 0 / uninformative).
 *
 * Counterfactual replay closes the loop: re-run past JUDGED-and-realized
 * proposals against the CURRENT frontier judge (a fresh, independent rater) and
 * compare its *new* verdict to the *recorded real-world outcome*. Because the
 * re-judge never saw the outcome, the agreement is a genuine out-of-sample
 * calibration measurement — Cohen's kappa per judge + accuracy per work-source.
 *
 * Shape of the flow
 * ─────────────────
 *   1. Read outcome-linked judge traces (readJudgeTraces, M141) — newest first.
 *      Fall back to / enrich with the decisions ledger (readDecisions, M119) for
 *      the originating engine/model when the proposal file is gone.
 *   2. Keep only traces with a qualified OUTCOME (merged | reverted | rejected),
 *      cap to a bounded sample (cfg.foundry.counterfactualSampleCap, default 10).
 *   3. Take one complete proposal snapshot for merge authority, diff, and
 *      work-source. Skip when the diff is gone (can't counterfactually re-judge).
 *   4. Re-judge the diff with the CURRENT frontier judge (resolveFrontierJudgeClient
 *      + judgeProposal from manager.js — imported only, never modified).
 *   5. Map the fresh verdict → intent and the recorded outcome → intent; an
 *      AGREEMENT is intent-equality. Compute Cohen's kappa per judge engine and
 *      an accuracy breakdown per work-source (engineModel / origin).
 *   6. Persist a calibration report to ~/.ashlr/fleet/calibration.json (scrubbed).
 *
 * Guarantees: never throws, bounded sample, secret-scrubbed before persist.
 * BUILD-ONLY: no integration/cadence wiring — callers invoke this directly.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import type { AshlrConfig, Proposal, DecisionEntry } from '../types.js';
import {
  isQualifiedJudgeOutcome,
  qualifiedMergedProposal,
  type JudgeOutcome,
  type JudgeProposalSource,
  type JudgeTrace,
} from './judge-trace.js';
import type { JudgeProposalOptions, ManagerVerdict } from './manager.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cap on how many judged-with-outcome proposals to replay per run. */
const DEFAULT_SAMPLE_CAP = 10;

/** Hard ceiling so a misconfigured cap can never trigger an unbounded run. */
const MAX_SAMPLE_CAP = 100;

const DEGRADED_PROPOSAL_SOURCE: JudgeProposalSource = {
  sourceState: 'degraded',
  complete: false,
  proposals: [],
};

function oneTracePerProposal(traces: readonly JudgeTrace[]): JudgeTrace[] {
  const selected = new Map<string, JudgeTrace>();
  for (const trace of traces) {
    const existing = selected.get(trace.proposalId);
    const traceMs = Date.parse(trace.outcomeAt ?? trace.ts);
    const existingMs = existing ? Date.parse(existing.outcomeAt ?? existing.ts) : Number.NEGATIVE_INFINITY;
    if (!existing || traceMs > existingMs) selected.set(trace.proposalId, trace);
  }
  return [...selected.values()].sort(
    (a, b) => Date.parse(b.outcomeAt ?? b.ts) - Date.parse(a.outcomeAt ?? a.ts),
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One replayed proposal: recorded outcome vs. fresh frontier verdict. */
export interface ReplayedProposal {
  proposalId: string;
  /** Judge engine that produced the ORIGINAL recorded verdict. */
  originalJudgeEngine: string;
  /** The verdict the original judge recorded. */
  originalVerdict: string;
  /** The real-world outcome that was later linked to the proposal. */
  outcome: JudgeOutcome;
  /** Coarse intent bucket of the realized outcome (merge | review | reject). */
  outcomeIntent: string;
  /** Judge engine that produced the fresh counterfactual verdict. */
  replayJudgeEngine: string;
  /** The verdict the CURRENT frontier judge produced on re-judge. */
  replayVerdict: string;
  /** Coarse intent bucket of the fresh verdict (merge | review | reject). */
  replayIntent: string;
  /** True when replayIntent === outcomeIntent. */
  agreed: boolean;
  /** Work-source attribution (engineModel ?? origin ?? 'unknown'). */
  workSource: string;
}

/** Per-judge calibration: agreement + Cohen's kappa vs. realized outcomes. */
export interface JudgeCalibration {
  judgeEngine: string;
  sampleSize: number;
  agreements: number;
  /** agreements / sampleSize (0–1). */
  agreementRate: number;
  /** Cohen's kappa between fresh-verdict-intent and outcome-intent (null when N<2). */
  kappa: number | null;
}

/** Per-work-source calibration: how well the frontier judge re-confirms its outputs. */
export interface SourceCalibration {
  workSource: string;
  sampleSize: number;
  agreements: number;
  /** agreements / sampleSize (0–1). */
  accuracy: number;
}

/** Full counterfactual replay report (persisted to calibration.json). */
export interface CounterfactualReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** Number of proposals actually replayed (had an outcome AND a recoverable diff). */
  replayed: number;
  /** Total agreements across all replayed proposals. */
  agreements: number;
  /** Total disagreements across all replayed proposals. */
  disagreements: number;
  /** Per-judge-engine Cohen's kappa keyed by engine id. */
  kappaByJudge: Record<string, JudgeCalibration>;
  /** Per-work-source accuracy breakdown keyed by source id. */
  calibrationBySource: Record<string, SourceCalibration>;
  /** Per-proposal detail (scrubbed). */
  details: ReplayedProposal[];
  /** Plain-language notes (e.g. why the run was empty). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Directory for fleet calibration artifacts: ~/.ashlr/fleet. */
export function fleetDir(): string {
  return join(homedir(), '.ashlr', 'fleet');
}

/** Absolute path to the persisted calibration report. */
export function calibrationReportPath(): string {
  return join(fleetDir(), 'calibration.json');
}

// ---------------------------------------------------------------------------
// Intent mapping (local copies — kept independent of judge-calibration.ts so
// this module never reaches across to a sibling's internal mapping; the buckets
// match verdictToIntent/outcomeToIntent by construction).
// ---------------------------------------------------------------------------

/** ship → merge, review → review, noise|harmful → reject. */
function verdictToIntent(verdict: string): string {
  if (verdict === 'ship') return 'merge';
  if (verdict === 'review') return 'review';
  return 'reject';
}

/** merged → merge, reverted/followed-up → review, rejected → reject. */
function outcomeToIntent(outcome: string): string {
  if (outcome === 'merged') return 'merge';
  if (outcome === 'reverted') return 'review';
  if (outcome === 'followed-up') return 'review'; // M332
  return 'reject';
}

// ---------------------------------------------------------------------------
// Cohen's kappa (self-contained, pure, never-throws)
// ---------------------------------------------------------------------------

/**
 * Cohen's kappa between two categorical raters.
 *   kappa = (p_o - p_e) / (1 - p_e)
 * Returns null for < 2 pairs (kappa is undefined on a single observation),
 * 1.0 for a degenerate all-one-category set. Pure. Never throws.
 */
export function cohenKappa(pairs: Array<{ a: string; b: string }>): number | null {
  try {
    const n = pairs.length;
    if (n < 2) return null;

    const cats = new Set<string>();
    for (const p of pairs) {
      cats.add(p.a);
      cats.add(p.b);
    }
    const categories = Array.from(cats);

    const matrix: Record<string, Record<string, number>> = {};
    const marginalA: Record<string, number> = {};
    const marginalB: Record<string, number> = {};
    for (const c of categories) {
      matrix[c] = {};
      marginalA[c] = 0;
      marginalB[c] = 0;
      for (const c2 of categories) matrix[c]![c2] = 0;
    }

    for (const p of pairs) {
      matrix[p.a]![p.b]! += 1;
      marginalA[p.a]! += 1;
      marginalB[p.b]! += 1;
    }

    let observed = 0;
    for (const c of categories) observed += matrix[c]?.[c] ?? 0;
    const p_o = observed / n;

    let expected = 0;
    for (const c of categories) expected += (marginalA[c]! / n) * (marginalB[c]! / n);
    const p_e = expected;

    if (p_e >= 1.0) return 1.0; // every observation in one category
    return (p_o - p_e) / (1 - p_e);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Work-source attribution
// ---------------------------------------------------------------------------

/**
 * Resolve the "work source" for a proposal — the producer we want to calibrate.
 * Preference: the proposal's engineModel (e.g. 'codex:gpt-5.5'), then its
 * origin, then the originating engine/model recorded in the decisions ledger,
 * then 'unknown'. Always returns a non-empty string.
 */
function resolveWorkSource(
  proposal: Proposal | null,
  ledgerEntry: DecisionEntry | undefined,
): string {
  const fromProposal =
    (proposal?.engineModel && String(proposal.engineModel)) ||
    (proposal?.origin && String(proposal.origin));
  if (fromProposal) return scrubSecrets(fromProposal);

  const fromLedger =
    (ledgerEntry?.model && String(ledgerEntry.model)) ||
    (ledgerEntry?.engine && String(ledgerEntry.engine));
  if (fromLedger) return scrubSecrets(fromLedger);

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Options (test seams are underscore-prefixed; production path uses real APIs)
// ---------------------------------------------------------------------------

export interface CounterfactualOpts {
  /** Override the sample cap (else cfg.foundry.counterfactualSampleCap ?? 10). */
  maxSamples?: number;
  /** Test seam: read judge traces. */
  _readTracesFn?: (filter?: {
    outcomeOnly?: boolean;
    limit?: number;
  }) => JudgeTrace[];
  /** Test seam: read the decisions ledger. */
  _readDecisionsFn?: (opts?: { proposalId?: string; limit?: number }) => DecisionEntry[];
  /** Test seam: take the complete proposal snapshot used by the whole replay. */
  _readProposalsFn?: () => JudgeProposalSource;
  /** Test seam: resolve the current frontier judge client. */
  _resolveJudgeFn?: (
    cfg: AshlrConfig,
  ) => { complete: (system: string, user: string) => Promise<string>; model: string } | null;
  /** Test seam: re-judge a proposal with a client (else manager.judgeProposal). */
  _judgeProposalFn?: (
    proposal: Proposal,
    cfg: AshlrConfig,
    client: { complete: (system: string, user: string) => Promise<string> },
    options: JudgeProposalOptions,
  ) => Promise<ManagerVerdict>;
  /** Test seam: persist the report (else writeFileSync to calibrationReportPath). */
  _persistFn?: (report: CounterfactualReport) => void;
}

async function readProposalSnapshot(
  override?: () => JudgeProposalSource,
): Promise<JudgeProposalSource> {
  try {
    const source = override
      ? override()
      : (await import('../inbox/store.js')).listProposalsDetailed({ requireComplete: true });
    if (!source || !Array.isArray(source.proposals) || typeof source.complete !== 'boolean' ||
      !['missing', 'healthy', 'degraded'].includes(source.sourceState)) {
      return DEGRADED_PROPOSAL_SOURCE;
    }
    return source;
  } catch {
    return DEGRADED_PROPOSAL_SOURCE;
  }
}

function uniqueProposalIndex(source: JudgeProposalSource): Map<string, Proposal> {
  const index = new Map<string, Proposal>();
  const duplicates = new Set<string>();
  for (const proposal of source.proposals) {
    if (index.has(proposal.id)) duplicates.add(proposal.id);
    else index.set(proposal.id, proposal);
  }
  for (const id of duplicates) index.delete(id);
  return index;
}

// ---------------------------------------------------------------------------
// Secret scrubbing for the persisted report
// ---------------------------------------------------------------------------

function scrubReport(report: CounterfactualReport): CounterfactualReport {
  return {
    ...report,
    notes: report.notes.map((n) => scrubSecrets(n)),
    details: report.details.map((d) => ({
      ...d,
      // Engine/source strings can rarely carry an inlined token — scrub defensively.
      originalJudgeEngine: scrubSecrets(d.originalJudgeEngine),
      replayJudgeEngine: scrubSecrets(d.replayJudgeEngine),
      workSource: scrubSecrets(d.workSource),
    })),
  };
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

function persistReport(report: CounterfactualReport): void {
  try {
    const dir = fleetDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      calibrationReportPath(),
      JSON.stringify(scrubReport(report), null, 2) + '\n',
      'utf8',
    );
  } catch {
    // Best-effort — the report is still returned even if the write fails.
  }
}

// ---------------------------------------------------------------------------
// Public: runCounterfactualReplay()
// ---------------------------------------------------------------------------

/**
 * Re-run past judged-and-realized proposals against the current frontier judge
 * and measure agreement with the recorded real-world outcome.
 *
 * @param cfg   AshlrConfig — passed through to the frontier judge.
 * @param opts  Optional cap + test seams.
 * @returns     A CounterfactualReport. Persisted unless proposal authority is withheld.
 *
 * Never throws. Bounded. Secret-scrubbed before persist.
 */
export async function runCounterfactualReplay(
  cfg: AshlrConfig,
  opts?: CounterfactualOpts,
): Promise<CounterfactualReport> {
  const emptyReport = (note: string): CounterfactualReport => ({
    generatedAt: new Date().toISOString(),
    replayed: 0,
    agreements: 0,
    disagreements: 0,
    kappaByJudge: {},
    calibrationBySource: {},
    details: [],
    notes: [note],
  });

  try {
    // --- Resolve the bounded sample cap -------------------------------------
    const cfgCap = (cfg?.foundry as Record<string, unknown> | undefined)?.[
      'counterfactualSampleCap'
    ];
    let cap = DEFAULT_SAMPLE_CAP;
    if (opts?.maxSamples !== undefined && Number.isFinite(opts.maxSamples)) {
      cap = opts.maxSamples;
    } else if (typeof cfgCap === 'number' && Number.isFinite(cfgCap)) {
      cap = cfgCap;
    }
    // Clamp to [1, MAX_SAMPLE_CAP]; a non-positive cap means "nothing to do".
    cap = Math.floor(cap);
    if (cap > MAX_SAMPLE_CAP) cap = MAX_SAMPLE_CAP;

    // Snapshot proposal authority exactly once. Replays and merged-label
    // qualification below must observe the same complete persistence boundary.
    const proposalSource = await readProposalSnapshot(opts?._readProposalsFn);
    if (proposalSource.sourceState === 'degraded' || !proposalSource.complete) {
      return emptyReport('calibration withheld: proposal source is degraded or incomplete');
    }
    const proposalSnapshotAtMs = Date.now();
    const proposalsById = uniqueProposalIndex(proposalSource);
    if (cap <= 0) {
      const r = emptyReport('sample cap <= 0 — nothing replayed');
      (opts?._persistFn ?? persistReport)(r);
      return r;
    }

    // --- 1. Read outcome-linked traces (over-fetch a little, then cap) ------
    let readTraces = opts?._readTracesFn;
    const injectedTraceReader = readTraces !== undefined;
    if (!readTraces) {
      const { readJudgeTraces } = await import('./judge-trace.js');
      readTraces = readJudgeTraces;
    }
    // Over-fetch (cap * 3) so we still hit `cap` replays after diff-less skips.
    const traces = readTraces({
      outcomeOnly: true,
      limit: cap * 3,
      ...(!injectedTraceReader ? { requireComplete: true } : {}),
    });

    // A historical bare `merged` label remains readable but cannot seed replay.
    const qualifiedMergedProposals = new Map<string, Proposal>();
    const qualifiedOutcomes = oneTracePerProposal(traces).filter(
      (t): t is JudgeTrace & { outcome: JudgeOutcome } =>
        isQualifiedJudgeOutcome(t) &&
        (t.outcome === 'merged' || t.outcome === 'reverted' || t.outcome === 'rejected'),
    );
    const withOutcome = qualifiedOutcomes.filter((trace) => {
      if (trace.outcome !== 'merged') return true;
      const proposal = qualifiedMergedProposal(
        trace.proposalId,
        proposalSource,
        proposalSnapshotAtMs,
      );
      if (!proposal) return false;
      qualifiedMergedProposals.set(trace.proposalId, proposal);
      return true;
    });

    if (withOutcome.length === 0) {
      const r = emptyReport(qualifiedOutcomes.length > 0
        ? 'no replayable proposals (merged proposal authority missing or unrecoverable)'
        : 'no judged proposals with a recorded outcome found');
      (opts?._persistFn ?? persistReport)(r);
      return r;
    }

    // --- 2. Resolve the current frontier judge ------------------------------
    let resolveJudge = opts?._resolveJudgeFn;
    if (!resolveJudge) {
      const { resolveFrontierJudgeClient } = await import('./manager.js');
      resolveJudge = resolveFrontierJudgeClient;
    }
    const judgeClient = resolveJudge(cfg);
    if (!judgeClient) {
      const r = emptyReport('no frontier judge client available — cannot re-judge');
      (opts?._persistFn ?? persistReport)(r);
      return r;
    }

    let judgeProposalFn = opts?._judgeProposalFn;
    if (!judgeProposalFn) {
      const { judgeProposal } = await import('./manager.js');
      judgeProposalFn = judgeProposal;
    }

    let readDecisionsFn = opts?._readDecisionsFn;
    if (!readDecisionsFn) {
      try {
        const { readDecisions } = await import('./decisions-ledger.js');
        readDecisionsFn = readDecisions;
      } catch {
        readDecisionsFn = () => [];
      }
    }

    const replayJudgeEngine = judgeClient.model || 'frontier';

    // --- 3. Replay each proposal up to the cap ------------------------------
    const details: ReplayedProposal[] = [];
    const notes: string[] = [];

    for (const trace of withOutcome) {
      if (details.length >= cap) break;

      try {
        const proposal = trace.outcome === 'merged'
          ? qualifiedMergedProposals.get(trace.proposalId)
          : proposalsById.get(trace.proposalId);
        if (!proposal || !proposal.diff || proposal.diff.trim() === '') {
          // No recoverable diff → cannot counterfactually re-judge. Skip.
          continue;
        }

        // Pull the originating engine/model from the ledger (best-effort).
        let ledgerEntry: DecisionEntry | undefined;
        try {
          const entries = readDecisionsFn({ proposalId: trace.proposalId, limit: 5 });
          ledgerEntry = entries.find((e) => e.engine || e.model);
        } catch {
          ledgerEntry = undefined;
        }
        const workSource = resolveWorkSource(proposal, ledgerEntry);

        // Re-judge with the CURRENT frontier judge (never saw the outcome).
        const verdict = await judgeProposalFn(proposal, cfg, judgeClient, { recordTrace: false });

        const replayIntent = verdictToIntent(verdict.verdict);
        const outcomeIntent = outcomeToIntent(trace.outcome);

        details.push({
          proposalId: trace.proposalId,
          originalJudgeEngine: trace.judgeEngine || 'unknown',
          originalVerdict: trace.verdict,
          outcome: trace.outcome,
          outcomeIntent,
          replayJudgeEngine,
          replayVerdict: verdict.verdict,
          replayIntent,
          agreed: replayIntent === outcomeIntent,
          workSource,
        });
      } catch {
        // Per-proposal failure must never abort the run.
        continue;
      }
    }

    if (details.length === 0) {
      const r = {
        ...emptyReport('no replayable proposals (outcomes present but diffs unrecoverable)'),
      };
      (opts?._persistFn ?? persistReport)(r);
      return r;
    }

    // --- 4. Aggregate: per-judge kappa + per-source accuracy ----------------
    const agreements = details.filter((d) => d.agreed).length;
    const disagreements = details.length - agreements;

    // Group by the ORIGINAL judge engine for per-judge kappa: the kappa pairs
    // are (fresh-verdict-intent, realized-outcome-intent) for proposals that
    // engine originally judged — i.e. how well the frontier judge re-confirms
    // reality on that engine's decision set.
    const byJudge: Record<string, ReplayedProposal[]> = {};
    for (const d of details) {
      (byJudge[d.originalJudgeEngine] ??= []).push(d);
    }
    const kappaByJudge: Record<string, JudgeCalibration> = {};
    for (const [engine, group] of Object.entries(byJudge)) {
      const pairs = group.map((d) => ({ a: d.replayIntent, b: d.outcomeIntent }));
      const ag = group.filter((d) => d.agreed).length;
      kappaByJudge[engine] = {
        judgeEngine: engine,
        sampleSize: group.length,
        agreements: ag,
        agreementRate: group.length > 0 ? ag / group.length : 0,
        kappa: cohenKappa(pairs),
      };
    }

    // Per-work-source accuracy: of the diffs this source produced, how often did
    // the frontier judge's fresh verdict match the realized outcome?
    const bySource: Record<string, ReplayedProposal[]> = {};
    for (const d of details) {
      (bySource[d.workSource] ??= []).push(d);
    }
    const calibrationBySource: Record<string, SourceCalibration> = {};
    for (const [source, group] of Object.entries(bySource)) {
      const ag = group.filter((d) => d.agreed).length;
      calibrationBySource[source] = {
        workSource: source,
        sampleSize: group.length,
        agreements: ag,
        accuracy: group.length > 0 ? ag / group.length : 0,
      };
    }

    if (withOutcome.length > details.length) {
      notes.push(
        `${withOutcome.length - details.length} outcome-linked trace(s) skipped (no recoverable diff)`,
      );
    }

    const report: CounterfactualReport = {
      generatedAt: new Date().toISOString(),
      replayed: details.length,
      agreements,
      disagreements,
      kappaByJudge,
      calibrationBySource,
      details,
      notes,
    };

    (opts?._persistFn ?? persistReport)(report);
    return report;
  } catch {
    // Never throws — return an empty report describing the failure.
    const r = emptyReport('unexpected error during counterfactual replay');
    try {
      (opts?._persistFn ?? persistReport)(r);
    } catch {
      /* best-effort */
    }
    return r;
  }
}

/**
 * M32: pre-flight cost estimation — predict tokens / cost / duration for a
 * `run` or `swarm` BEFORE committing, from persisted history.
 *
 * Method: percentile statistics (p25 / median / p75) over completed history
 * (~/.ashlr/runs/, ~/.ashlr/swarms/), lightly weighted toward goals that share
 * keywords with the new goal. The upper bound is clamped to the requested
 * budget. Cloud cost uses the same reference pricing as forecast.ts; local
 * runs cost $0 (the would-be-cloud figure is reported for context).
 *
 * Contract: PURE READ-ONLY (never writes, never scans repos, never calls a
 * model); NEVER throws — empty/corrupt history yields a zeroed estimate with
 * confidence 'low'.
 */

import type { AshlrConfig, RunEstimate } from '../types.js';

/** Reference cloud pricing ($/M tokens) — mirrors forecast.ts. */
const CLOUD_REF_PRICE_IN = 3.0;
const CLOUD_REF_PRICE_OUT = 15.0;

/** Minimum samples for medium/high confidence. */
const MEDIUM_SAMPLES = 3;
const HIGH_SAMPLES = 10;

/** A normalized history record (run or swarm). */
interface HistorySample {
  goal: string;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  steps: number;
  estCostUsd: number;
  durationMs: number;
}

function keywordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
}

/** Jaccard-ish goal similarity in [0,1]. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.max(a.size, b.size);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx] ?? 0;
}

function cloudCost(tokensIn: number, tokensOut: number): number {
  return (
    (Math.max(0, tokensIn) / 1_000_000) * CLOUD_REF_PRICE_IN +
    (Math.max(0, tokensOut) / 1_000_000) * CLOUD_REF_PRICE_OUT
  );
}

function buildEstimate(
  kind: 'run' | 'swarm',
  goal: string,
  samples: HistorySample[],
  opts: { maxTokens?: number; allowCloud?: boolean },
): RunEstimate {
  const zeroed: RunEstimate = {
    kind,
    goal,
    sampleSize: 0,
    confidence: 'low',
    tokens: { p25: 0, median: 0, p75: 0 },
    steps: { p25: 0, median: 0, p75: 0 },
    estCostUsd: { p25: 0, median: 0, p75: 0 },
    wouldBeCloudUsd: 0,
    durationMs: { p25: 0, median: 0, p75: 0 },
    budgetClamped: false,
    generatedAt: new Date().toISOString(),
  };
  if (samples.length === 0) return zeroed;

  // Similarity weighting: when ≥3 samples share keywords with the goal, use
  // ONLY those (a focused prior beats a diffuse one); otherwise use everything.
  const goalWords = keywordSet(goal);
  const similar = samples.filter((s) => similarity(goalWords, keywordSet(s.goal)) > 0.15);
  const used = similar.length >= MEDIUM_SAMPLES ? similar : samples;

  const tokens = used.map((s) => s.tokens).sort((a, b) => a - b);
  const steps = used.map((s) => s.steps).sort((a, b) => a - b);
  const costs = used.map((s) => s.estCostUsd).sort((a, b) => a - b);
  const durations = used.map((s) => s.durationMs).filter((d) => d > 0).sort((a, b) => a - b);

  let p25t = percentile(tokens, 25);
  let p50t = percentile(tokens, 50);
  let p75t = percentile(tokens, 75);

  // Clamp to the requested budget (a run can never exceed its hard cap).
  let budgetClamped = false;
  const cap = opts.maxTokens;
  if (cap !== undefined && cap > 0) {
    if (p75t > cap) { p75t = cap; budgetClamped = true; }
    if (p50t > cap) { p50t = cap; budgetClamped = true; }
    if (p25t > cap) { p25t = cap; budgetClamped = true; }
  }

  // Median in/out split from history (for the would-be-cloud figure).
  const ratioSum = used.reduce(
    (acc, s) => {
      acc.in += s.tokensIn;
      acc.out += s.tokensOut;
      return acc;
    },
    { in: 0, out: 0 },
  );
  const total = ratioSum.in + ratioSum.out;
  const inShare = total > 0 ? ratioSum.in / total : 0.7;

  const confidence: RunEstimate['confidence'] =
    used.length >= HIGH_SAMPLES ? 'high' : used.length >= MEDIUM_SAMPLES ? 'medium' : 'low';

  return {
    kind,
    goal,
    sampleSize: used.length,
    confidence,
    tokens: { p25: p25t, median: p50t, p75: p75t },
    steps: { p25: percentile(steps, 25), median: percentile(steps, 50), p75: percentile(steps, 75) },
    estCostUsd: {
      p25: percentile(costs, 25),
      median: percentile(costs, 50),
      p75: percentile(costs, 75),
    },
    wouldBeCloudUsd: cloudCost(p50t * inShare, p50t * (1 - inShare)),
    durationMs: {
      p25: percentile(durations, 25),
      median: percentile(durations, 50),
      p75: percentile(durations, 75),
    },
    budgetClamped,
    generatedAt: new Date().toISOString(),
  };
}

/** Estimate a `run` from run history. Never throws. */
export async function estimateRun(
  goal: string,
  opts: { maxTokens?: number; allowCloud?: boolean },
  _cfg: AshlrConfig,
): Promise<RunEstimate> {
  let samples: HistorySample[] = [];
  try {
    const { listRuns } = await import('../run/orchestrator.js');
    samples = listRuns()
      .filter((r) => r.status === 'done' || r.status === 'failed')
      .map((r) => ({
        goal: r.goal,
        tokens: r.usage.tokensIn + r.usage.tokensOut,
        tokensIn: r.usage.tokensIn,
        tokensOut: r.usage.tokensOut,
        steps: r.usage.steps,
        estCostUsd: r.usage.estCostUsd,
        durationMs: Date.parse(r.updatedAt) - Date.parse(r.createdAt) || 0,
      }));
  } catch {
    samples = [];
  }
  return buildEstimate('run', goal, samples, opts);
}

/** Estimate a `swarm` from swarm history. Never throws. */
export async function estimateSwarm(
  goal: string,
  opts: { maxTokens?: number; allowCloud?: boolean },
  _cfg: AshlrConfig,
): Promise<RunEstimate> {
  let samples: HistorySample[] = [];
  try {
    const { listSwarms } = await import('../swarm/store.js');
    samples = listSwarms()
      .filter((s) => s.status === 'done' || s.status === 'failed' || s.status === 'aborted')
      .map((s) => ({
        goal: s.goal,
        tokens: s.usage.tokensIn + s.usage.tokensOut,
        tokensIn: s.usage.tokensIn,
        tokensOut: s.usage.tokensOut,
        steps: s.usage.steps,
        estCostUsd: s.usage.estCostUsd,
        durationMs: Date.parse(s.updatedAt) - Date.parse(s.createdAt) || 0,
      }));
  } catch {
    samples = [];
  }
  return buildEstimate('swarm', goal, samples, opts);
}

/** Render an estimate as a compact human block (shared by run/swarm CLIs). */
export function renderEstimate(e: RunEstimate): string {
  const fmtTok = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
  const fmtDur = (ms: number): string => {
    if (ms <= 0) return '—';
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
  };
  const lines = [
    `estimate (${e.kind}) — confidence: ${e.confidence} (${e.sampleSize} similar ${e.kind}${e.sampleSize === 1 ? '' : 's'})`,
    `  tokens    p25 ${fmtTok(e.tokens.p25)} · median ${fmtTok(e.tokens.median)} · p75 ${fmtTok(e.tokens.p75)}${e.budgetClamped ? ' (clamped to budget)' : ''}`,
    `  steps     p25 ${Math.round(e.steps.p25)} · median ${Math.round(e.steps.median)} · p75 ${Math.round(e.steps.p75)}`,
    `  cost      median $${e.estCostUsd.median.toFixed(4)} (local $0; would-be-cloud ≈ $${e.wouldBeCloudUsd.toFixed(4)})`,
    `  duration  p25 ${fmtDur(e.durationMs.p25)} · median ${fmtDur(e.durationMs.median)} · p75 ${fmtDur(e.durationMs.p75)}`,
  ];
  if (e.sampleSize === 0) {
    lines.push('  (no history yet — run a few goals first for meaningful estimates)');
  }
  return lines.join('\n');
}

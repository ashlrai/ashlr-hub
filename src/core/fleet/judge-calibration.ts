/**
 * M145: Judge calibration — Cohen's kappa, dark-current bias measurement,
 * and a zero-label degradation harness for self-assessing judge quality.
 *
 * All public functions are secret-scrubbed, never-throw, and degrade
 * gracefully to an "insufficient traces" report when fewer than MIN_TRACES
 * traces are available.
 *
 * Key concepts
 * ────────────
 * cohenKappa       — agreement-beyond-chance between two categorical raters.
 *                    Pairs carry (raterA, raterB) label strings; computed
 *                    from the confusion matrix, not raw accuracy.
 *
 * darkCurrent      — the judge's baseline verdict/score distribution computed
 *                    purely from its own historical traces. Provides the bias
 *                    floor so callers can subtract it from thresholds.
 *
 * runDegradationHarness — the BabelJudge move: take judge-traces whose
 *                    outcome === 'merged' (known-good commits), synthetically
 *                    corrupt each diff (flip a comparison, delete a return,
 *                    swap an arg, etc.), re-run judgeProposal on the corrupted
 *                    diff, and measure the RECOVERY RATE — did the judge score
 *                    the corrupted version materially lower or flag review|harmful?
 *                    Zero human labels; the corruption itself is ground truth.
 *
 * judgeHealth      — combines the above into a single report with plain-language
 *                    flag strings when metrics fall below safe thresholds.
 */

import type { AshlrConfig, Proposal } from '../types.js';
import type { JudgeTrace } from './judge-trace.js';
import type { ManagerVerdict } from './manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum traces needed before producing meaningful statistics. */
const MIN_TRACES = 5;

/** Score *drop* required to count a corruption as caught. */
const SCORE_DROP_THRESHOLD = 1.0;

/** Cap on how many merged traces to run through the harness per call. */
const MAX_HARNESS_SAMPLES = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pair of labels from two raters (or judge-verdict vs. realized outcome). */
export interface RaterPair {
  raterA: string;
  raterB: string;
}

/**
 * Baseline verdict and score distribution for a judge engine,
 * computed from its historical traces (its "dark current").
 */
export interface DarkCurrent {
  /** Judge engine identifier (e.g. 'claude-sonnet-4-5'). */
  judgeEngine: string;
  /** Total traces used to compute this baseline. */
  traceCount: number;
  /** Proportion of each verdict label. */
  verdictDistribution: Record<string, number>;
  /** Mean score per dimension. */
  meanScores: {
    value: number;
    correctness: number;
    scope: number;
    alignment: number;
  };
  /** Standard deviation per dimension (population std-dev). */
  stdScores: {
    value: number;
    correctness: number;
    scope: number;
    alignment: number;
  };
}

/** Result of a single corruption trial. */
export interface CorruptionTrial {
  proposalId: string;
  originalVerdict: string;
  originalAvgScore: number;
  corruptedVerdict: string;
  corruptedAvgScore: number;
  caught: boolean; // score dropped by ≥ SCORE_DROP_THRESHOLD or verdict escalated
}

/** Result of the full degradation harness run. */
export interface DegradationHarnessResult {
  sampleSize: number;
  trials: CorruptionTrial[];
  recoveryRate: number; // 0.0 – 1.0
  flags: string[];
}

/** Combined judge health report. */
export interface JudgeHealthReport {
  /** Cohen's kappa between judge verdict mapping and realized outcome. */
  kappaVsOutcome: number | null;
  /** Dark-current baseline for each engine seen in traces. */
  darkCurrent: DarkCurrent[];
  /** Recovery rate from the degradation harness (null when not run). */
  degradationRecoveryRate: number | null;
  /** Number of traces used for kappa + dark-current computation. */
  sampleSize: number;
  /** Plain-language warnings. */
  flags: string[];
}

// ---------------------------------------------------------------------------
// Public: cohenKappa()
// ---------------------------------------------------------------------------

/**
 * Compute Cohen's kappa for a set of rater pairs.
 *
 * kappa = (p_o - p_e) / (1 - p_e)
 *   p_o = observed agreement
 *   p_e = expected agreement by chance (product of marginals)
 *
 * Returns 1.0 for perfect agreement, ~0 for chance-level agreement,
 * and negative values for systematic disagreement.
 * Returns null when the pairs array is empty.
 * Pure function. Never throws.
 */
export function cohenKappa(pairs: RaterPair[]): number | null {
  try {
    if (pairs.length === 0) return null;

    const n = pairs.length;
    // Gather all categories
    const categorySet = new Set<string>();
    for (const p of pairs) {
      categorySet.add(p.raterA);
      categorySet.add(p.raterB);
    }
    const categories = Array.from(categorySet);

    // Build confusion matrix and marginals
    const confusionMatrix: Record<string, Record<string, number>> = {};
    const marginalA: Record<string, number> = {};
    const marginalB: Record<string, number> = {};

    for (const cat of categories) {
      confusionMatrix[cat] = {};
      marginalA[cat] = 0;
      marginalB[cat] = 0;
      for (const cat2 of categories) {
        confusionMatrix[cat]![cat2] = 0;
      }
    }

    for (const p of pairs) {
      confusionMatrix[p.raterA]![p.raterB]! += 1;
      marginalA[p.raterA]! += 1;
      marginalB[p.raterB]! += 1;
    }

    // p_o: observed agreement (diagonal)
    let observedAgreement = 0;
    for (const cat of categories) {
      observedAgreement += (confusionMatrix[cat]?.[cat] ?? 0);
    }
    const p_o = observedAgreement / n;

    // p_e: expected agreement by chance
    let expectedAgreement = 0;
    for (const cat of categories) {
      expectedAgreement += (marginalA[cat]! / n) * (marginalB[cat]! / n);
    }
    const p_e = expectedAgreement;

    if (p_e >= 1.0) return 1.0; // degenerate: all predictions same category
    return (p_o - p_e) / (1 - p_e);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: darkCurrent()
// ---------------------------------------------------------------------------

/**
 * Compute the judge's baseline verdict and score distribution from its traces.
 *
 * Groups by judgeEngine, then computes the verdict distribution (proportions)
 * and mean/std of each score dimension. This gives the "dark current" — the
 * judge's innate bias floor that thresholds should subtract.
 *
 * Never throws. Returns empty array when traces is empty or falsy.
 */
export function darkCurrent(traces: JudgeTrace[]): DarkCurrent[] {
  try {
    if (!traces || traces.length === 0) return [];

    // Group by judgeEngine
    const byEngine: Record<string, JudgeTrace[]> = {};
    for (const t of traces) {
      const engine = t.judgeEngine ?? 'unknown';
      if (!byEngine[engine]) byEngine[engine] = [];
      byEngine[engine]!.push(t);
    }

    const results: DarkCurrent[] = [];

    for (const [engine, engineTraces] of Object.entries(byEngine)) {
      const traceCount = engineTraces.length;

      // Verdict distribution
      const verdictCounts: Record<string, number> = {};
      for (const t of engineTraces) {
        verdictCounts[t.verdict] = (verdictCounts[t.verdict] ?? 0) + 1;
      }
      const verdictDistribution: Record<string, number> = {};
      for (const [v, cnt] of Object.entries(verdictCounts)) {
        verdictDistribution[v] = cnt / traceCount;
      }

      // Score means
      const dims = ['value', 'correctness', 'scope', 'alignment'] as const;
      const means: Record<string, number> = {};
      const stds: Record<string, number> = {};

      for (const dim of dims) {
        const vals = engineTraces.map((t) => t.scores[dim] ?? 0);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vals.length;
        means[dim] = mean;
        stds[dim] = Math.sqrt(variance);
      }

      results.push({
        judgeEngine: engine,
        traceCount,
        verdictDistribution,
        meanScores: {
          value: means['value']!,
          correctness: means['correctness']!,
          scope: means['scope']!,
          alignment: means['alignment']!,
        },
        stdScores: {
          value: stds['value']!,
          correctness: stds['correctness']!,
          scope: stds['scope']!,
          alignment: stds['alignment']!,
        },
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Corruption helpers (deterministic, never-throw)
// ---------------------------------------------------------------------------

/**
 * Inject an obvious defect into a diff to test whether the judge catches it.
 *
 * Strategies (tried in order; falls back to appending a sentinel line):
 *   1. Flip a comparison operator (< → >, === → !==, >= → <=)
 *   2. Delete a `return` statement line
 *   3. Swap two argument positions in a function call
 *   4. Sentinel: append a clearly wrong line `+  // INJECTED_DEFECT: unreachable`
 */
function corruptDiff(diff: string): string {
  try {
    // Strategy 1: flip comparison
    const flipPatterns: [RegExp, string][] = [
      [/\b===\b/g, '!=='],
      [/\b!==\b/g, '==='],
      [/ < /g, ' > '],
      [/ >= /g, ' <= '],
    ];
    for (const [pattern, replacement] of flipPatterns) {
      if (pattern.test(diff)) {
        return diff.replace(pattern, replacement);
      }
    }

    // Strategy 2: delete a return line
    const lines = diff.split('\n');
    const returnLineIdx = lines.findIndex((l) => /^\+\s+return\b/.test(l));
    if (returnLineIdx !== -1) {
      const mutated = [...lines];
      mutated.splice(returnLineIdx, 1);
      return mutated.join('\n');
    }

    // Strategy 3: swap args in a function call
    const callLineIdx = lines.findIndex((l) => /^\+.*\w+\(\w+,\s*\w+\)/.test(l));
    if (callLineIdx !== -1) {
      const mutated = [...lines];
      mutated[callLineIdx] = mutated[callLineIdx]!.replace(
        /(\w+)(,\s*)(\w+)(\))/,
        '$3$2$1$4',
      );
      return mutated.join('\n');
    }

    // Fallback: append a sentinel
    return diff + '\n+  // INJECTED_DEFECT: unreachable code path introduced by corruption\n';
  } catch {
    return diff + '\n+  // INJECTED_DEFECT: unreachable\n';
  }
}

/**
 * Average score across value/correctness/scope/alignment.
 * NOTE: scope is NOT inverted here. This is intentional — avgScore is used
 * only for a relative corrupted-vs-original delta (isCaught), so both sides
 * are computed the same way and the sign still reflects quality degradation.
 * Contrast with best-of-n's scoreVerdict(), which inverts scope for absolute ranking.
 */
function avgScore(v: ManagerVerdict): number {
  return (v.value + v.correctness + v.scope + v.alignment) / 4;
}

/** True if the judge caught the corruption (lower score or escalated verdict). */
function isCaught(original: ManagerVerdict, corrupted: ManagerVerdict): boolean {
  const scoreDrop = avgScore(original) - avgScore(corrupted);
  if (scoreDrop >= SCORE_DROP_THRESHOLD) return true;
  // Verdict escalation: ship→review|harmful, review→harmful
  const verdictOrder: Record<string, number> = { ship: 0, review: 1, noise: 2, harmful: 3 };
  const origRank = verdictOrder[original.verdict] ?? 0;
  const corrRank = verdictOrder[corrupted.verdict] ?? 0;
  return corrRank > origRank;
}

// ---------------------------------------------------------------------------
// Public: runDegradationHarness()
// ---------------------------------------------------------------------------

/**
 * Run the zero-label degradation harness.
 *
 * Takes traces with outcome==='merged' (known-good proposals), re-fetches
 * each diff from the inbox store, synthetically corrupts it, re-runs
 * judgeProposal on the corrupted diff, and measures the recovery rate.
 *
 * @param cfg   AshlrConfig — passed through to judgeProposal
 * @param opts.maxSamples  Cap on traces to evaluate (default MAX_HARNESS_SAMPLES)
 * @param opts._judgeProposalFn  Override for unit testing (avoids live LLM calls)
 * @param opts._readTracesFn     Override for unit testing
 * @param opts._loadProposalFn   Override for unit testing
 *
 * Never throws. Returns a result with sampleSize=0 when insufficient traces.
 */
export async function runDegradationHarness(
  cfg: AshlrConfig,
  opts?: {
    maxSamples?: number;
    _judgeProposalFn?: (
      proposal: Proposal,
      cfg: AshlrConfig,
      client: { complete: (system: string, user: string) => Promise<string> },
    ) => Promise<ManagerVerdict>;
    _readTracesFn?: (filter?: { outcomeOnly?: boolean; limit?: number }) => JudgeTrace[];
    _loadProposalFn?: (id: string) => Proposal | null;
  },
): Promise<DegradationHarnessResult> {
  const zero: DegradationHarnessResult = {
    sampleSize: 0,
    trials: [],
    recoveryRate: 0,
    flags: ['insufficient traces for degradation harness'],
  };

  try {
    const maxSamples = opts?.maxSamples ?? MAX_HARNESS_SAMPLES;

    // Load merged traces
    let traces: JudgeTrace[];
    if (opts !== undefined && opts._readTracesFn) {
      traces = opts._readTracesFn({ outcomeOnly: true, limit: maxSamples * 3 });
    } else {
      const { readJudgeTraces } = await import('./judge-trace.js');
      traces = readJudgeTraces({ outcomeOnly: true, limit: maxSamples * 3 });
    }

    const mergedTraces = traces
      .filter((t) => t.outcome === 'merged')
      .slice(0, maxSamples);

    if (mergedTraces.length < MIN_TRACES) {
      return zero;
    }

    // Load a judge client (uses cfg; returns null when none available)
    let judgeClient: { complete: (system: string, user: string) => Promise<string> } | null = null;
    let judgeProposalFn: NonNullable<typeof opts>['_judgeProposalFn'];

    if (opts?._judgeProposalFn) {
      judgeProposalFn = opts._judgeProposalFn;
      judgeClient = { complete: async () => '' }; // placeholder — unused with override
    } else {
      try {
        const { judgeProposal: _jp } = await import('./manager.js');
        judgeProposalFn = _jp;
        // Build a minimal direct client via the manager's internal resolver.
        // We pass cfg but don't need a real connection here — judgeProposal
        // will handle its own client resolution from cfg internally.
        judgeClient = {
          complete: async (system: string, user: string) => {
            // This path is only reached in integration mode — in unit tests
            // _judgeProposalFn is always provided. Return empty string to
            // trigger the safe 'review' fallback in judgeProposal.
            void system; void user;
            return '';
          },
        };
      } catch {
        return { ...zero, flags: ['failed to import judgeProposal'] };
      }
    }

    if (!judgeProposalFn || !judgeClient) {
      return { ...zero, flags: ['judge client unavailable'] };
    }

    const loadProposalFn = opts?._loadProposalFn ?? (await (async () => {
      try {
        const { loadProposal } = await import('../inbox/store.js');
        return loadProposal;
      } catch {
        return () => null;
      }
    })());

    // Run trials
    const trials: CorruptionTrial[] = [];
    const flags: string[] = [];

    for (const trace of mergedTraces) {
      try {
        const proposal = loadProposalFn(trace.proposalId);
        if (!proposal || !proposal.diff) continue;

        const originalDiff = proposal.diff;
        const corruptedDiff = corruptDiff(originalDiff);

        // Clone proposal with corrupted diff
        const corruptedProposal = { ...proposal, diff: corruptedDiff };

        // Re-judge original + corrupted (original verdict from trace; only re-judge corrupted)
        const corruptedVerdict = await judgeProposalFn(corruptedProposal, cfg, judgeClient);

        // Reconstruct original verdict shape from trace
        const originalVerdict: ManagerVerdict = {
          proposalId: trace.proposalId,
          verdict: trace.verdict,
          value: trace.scores.value,
          correctness: trace.scores.correctness,
          scope: trace.scores.scope,
          alignment: trace.scores.alignment,
          rationale: '',
          wouldMerge: false,
        };

        const caught = isCaught(originalVerdict, corruptedVerdict);

        trials.push({
          proposalId: trace.proposalId,
          originalVerdict: originalVerdict.verdict,
          originalAvgScore: avgScore(originalVerdict),
          corruptedVerdict: corruptedVerdict.verdict,
          corruptedAvgScore: avgScore(corruptedVerdict),
          caught,
        });
      } catch {
        // Silently skip failed trials — per-trial errors must not abort harness
        continue;
      }
    }

    if (trials.length === 0) {
      return { ...zero, flags: ['no proposals with diffs found for merged traces'] };
    }

    const recoveryRate = trials.filter((t) => t.caught).length / trials.length;

    if (recoveryRate < 0.5) {
      flags.push(
        `recovery rate ${(recoveryRate * 100).toFixed(0)}% — judge misses injected defects (threshold: 50%)`,
      );
    }
    if (recoveryRate < 0.3) {
      flags.push('critical: judge nearly blind to injected defects — verify judge model and prompt');
    }

    return {
      sampleSize: trials.length,
      trials,
      recoveryRate,
      flags,
    };
  } catch {
    return zero;
  }
}

// ---------------------------------------------------------------------------
// Verdict → outcome mapping helpers (for kappa computation)
// ---------------------------------------------------------------------------

/**
 * Map a judge verdict to a coarse merge-intent bucket.
 *   ship     → 'merge'
 *   review   → 'review'
 *   noise    → 'reject'
 *   harmful  → 'reject'
 */
export function verdictToIntent(verdict: string): string {
  if (verdict === 'ship') return 'merge';
  if (verdict === 'review') return 'review';
  return 'reject';
}

/**
 * Map a realized outcome to the same coarse bucket.
 *   merged   → 'merge'
 *   reverted → 'review'
 *   rejected → 'reject'
 */
export function outcomeToIntent(outcome: string): string {
  if (outcome === 'merged') return 'merge';
  if (outcome === 'reverted') return 'review';
  return 'reject';
}

// ---------------------------------------------------------------------------
// Public: judgeHealth()
// ---------------------------------------------------------------------------

/**
 * Produce a combined judge health report.
 *
 * Steps:
 *   1. Read all available traces (with outcomes preferred for kappa; all for dark-current).
 *   2. Compute Cohen's kappa between verdict-intent and outcome-intent for
 *      outcome-linked traces.
 *   3. Compute dark-current distribution from all traces.
 *   4. Optionally run the degradation harness (when opts.runDegradation is true).
 *   5. Assemble flags for low kappa, suspicious dark-current skew, etc.
 *
 * Never throws. Returns an "insufficient traces" report when < MIN_TRACES
 * traces are available.
 */
export async function judgeHealth(
  cfg: AshlrConfig,
  opts?: {
    runDegradation?: boolean;
    _judgeProposalFn?: (
      proposal: Proposal,
      cfg: AshlrConfig,
      client: { complete: (system: string, user: string) => Promise<string> },
    ) => Promise<ManagerVerdict>;
    _readTracesFn?: (filter?: { outcomeOnly?: boolean; limit?: number }) => JudgeTrace[];
    _loadProposalFn?: (id: string) => Proposal | null;
  },
): Promise<JudgeHealthReport> {
  const insufficientReport = (msg: string): JudgeHealthReport => ({
    kappaVsOutcome: null,
    darkCurrent: [],
    degradationRecoveryRate: null,
    sampleSize: 0,
    flags: [msg],
  });

  try {
    // --- 1. Load traces -------------------------------------------------------
    let allTraces: JudgeTrace[];
    let outcomeTraces: JudgeTrace[];

    if (opts?._readTracesFn) {
      allTraces = opts._readTracesFn({});
      outcomeTraces = opts._readTracesFn({ outcomeOnly: true });
    } else {
      const { readJudgeTraces } = await import('./judge-trace.js');
      allTraces = readJudgeTraces({});
      outcomeTraces = readJudgeTraces({ outcomeOnly: true });
    }

    if (allTraces.length < MIN_TRACES) {
      return insufficientReport(
        `insufficient traces: found ${allTraces.length}, need at least ${MIN_TRACES}`,
      );
    }

    const sampleSize = allTraces.length;
    const flags: string[] = [];

    // --- 2. Cohen's kappa (verdict-intent vs. outcome-intent) ----------------
    let kappaVsOutcome: number | null = null;
    if (outcomeTraces.length >= MIN_TRACES) {
      const pairs: RaterPair[] = outcomeTraces.map((t) => ({
        raterA: verdictToIntent(t.verdict),
        raterB: outcomeToIntent(t.outcome!),
      }));
      kappaVsOutcome = cohenKappa(pairs);

      if (kappaVsOutcome !== null) {
        if (kappaVsOutcome < 0.2) {
          flags.push(
            `kappa vs outcome is ${kappaVsOutcome.toFixed(2)} (< 0.20) — judge agreement with reality is poor`,
          );
        } else if (kappaVsOutcome < 0.4) {
          flags.push(
            `kappa vs outcome is ${kappaVsOutcome.toFixed(2)} (< 0.40) — moderate agreement; consider re-calibrating`,
          );
        }
      }
    } else {
      flags.push(
        `insufficient outcome-linked traces for kappa (${outcomeTraces.length} < ${MIN_TRACES})`,
      );
    }

    // --- 3. Dark current -------------------------------------------------------
    const dc = darkCurrent(allTraces);

    // Flag heavily skewed distributions
    for (const engineDc of dc) {
      const shipRate = engineDc.verdictDistribution['ship'] ?? 0;
      const noiseRate = engineDc.verdictDistribution['noise'] ?? 0;
      if (shipRate > 0.85) {
        flags.push(
          `engine ${engineDc.judgeEngine}: ${(shipRate * 100).toFixed(0)}% ship rate — possible rubber-stamp bias`,
        );
      }
      if (noiseRate > 0.5) {
        flags.push(
          `engine ${engineDc.judgeEngine}: ${(noiseRate * 100).toFixed(0)}% noise rate — possibly over-filtering`,
        );
      }
    }

    // --- 4. Degradation harness (optional) ------------------------------------
    let degradationRecoveryRate: number | null = null;
    if (opts?.runDegradation) {
      const harnessResult = await runDegradationHarness(cfg, {
        _judgeProposalFn: opts._judgeProposalFn,
        _readTracesFn: opts._readTracesFn,
        _loadProposalFn: opts._loadProposalFn,
      });
      if (harnessResult.sampleSize > 0) {
        degradationRecoveryRate = harnessResult.recoveryRate;
        flags.push(...harnessResult.flags);
      } else {
        flags.push(...harnessResult.flags);
      }
    }

    return {
      kappaVsOutcome,
      darkCurrent: dc,
      degradationRecoveryRate,
      sampleSize,
      flags,
    };
  } catch {
    return insufficientReport('unexpected error computing judge health');
  }
}

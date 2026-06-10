/**
 * reflect.ts — M26 deterministic reflection metrics engine.
 *
 * Scores the org's OWN past swarms/usage/genome and computes a ReflectionReport:
 * success rate, avg cost & tokens per swarm, local-vs-cloud share, clustered
 * top failure modes, slowest/most-expensive goal categories, and week-over-week
 * deltas vs the prior persisted snapshot.
 *
 * HARD SAFETY INVARIANTS (M26):
 *  1. READ-ONLY over history. Reads listSwarms() / genomeHubHealth /
 *     collectUsageEvents() ONLY — the HUB-ONLY genome reader (no portfolio
 *     disk scan). Writes nothing here (the CLI persists the snapshot via
 *     learn/store.ts under ~/.ashlr/learn/).
 *  2. NO TUNING. This module never proposes or applies anything — pure metrics.
 *  3. LOCAL-FIRST / NO LLM. buildReflection is DETERMINISTIC and makes ZERO
 *     network connections. No getActiveClient, no fetch. Narrative generation
 *     lives in playbooks.ts, never here.
 *  4. BOUNDED. Reads at most `maxRuns` recent swarms (default DEFAULT_MAX_RUNS)
 *     and/or those within `sinceMs`. listSwarms() is itself capped at 200.
 *  5. NEVER THROWS. Degrades to a zeroed report on any failure.
 *
 * METADATA ONLY — never reads/retains secret values or raw code/payloads.
 */

import type {
  AshlrConfig,
  FailureMode,
  GoalCategoryStat,
  ReflectionDelta,
  ReflectionOptions,
  ReflectionReport,
  SwarmRun,
} from '../types.js';
import { listSwarms } from '../swarm/store.js';
import { genomeHubHealth } from '../genome/store.js';
import { collectUsageEvents } from '../observability/usage-source.js';
import { isLocalProviderModel } from '../observability/rollup.js';
import { loadPreviousReport } from './store.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Default cap on how many recent swarms to analyze (bounds work). */
export const DEFAULT_MAX_RUNS = 100;

/**
 * Default usage-window lookback (ms) applied when NO --since window is given.
 * Bounds collectUsageEvents() so the default path never streams the entire
 * historical transcript corpus — it matches the report's week-over-week
 * framing. `--since all` (sinceMs explicitly 0) is the opt-in to scan all
 * history (still bounded by the per-file caps in usage-source.ts).
 */
export const DEFAULT_USAGE_LOOKBACK_MS = 30 * 86_400_000;

/** Max distinct failure-mode clusters surfaced on a report. */
const MAX_FAILURE_MODES = 8;

/** Max representative swarm ids retained per failure cluster. */
const MAX_FAILURE_EXAMPLES = 3;

/** Coarse goal categories (keyword heuristic; deterministic). */
const GOAL_CATEGORIES = [
  'feature',
  'bugfix',
  'refactor',
  'test',
  'docs',
  'chore',
  'other',
] as const;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing) — NO I/O, NO LLM
// ---------------------------------------------------------------------------

/**
 * Bucket a swarm goal string into one coarse GOAL_CATEGORIES label using a
 * deterministic keyword heuristic. Pure; never throws.
 *
 * Order matters: the first matching category wins (most-specific verbs first).
 */
export function classifyGoal(goal: string): (typeof GOAL_CATEGORIES)[number] {
  const g = (goal ?? '').toLowerCase();
  if (!g.trim()) return 'other';
  // bugfix: fix / bug / crash / regression / hotfix
  if (/\b(fix|fixes|fixed|bug|bugs|crash|regression|hotfix|defect|broken)\b/.test(g)) {
    return 'bugfix';
  }
  // test: test / spec / coverage / vitest / jest
  if (/\b(test|tests|testing|spec|specs|coverage|vitest|jest)\b/.test(g)) {
    return 'test';
  }
  // docs: doc / readme / comment / changelog
  if (/\b(doc|docs|document|documentation|readme|changelog|comment|comments)\b/.test(g)) {
    return 'docs';
  }
  // refactor: refactor / cleanup / rename / restructure / simplify
  if (/\b(refactor|refactors|refactoring|cleanup|clean-up|rename|restructure|simplify|tidy|dedupe)\b/.test(g)) {
    return 'refactor';
  }
  // chore: chore / bump / deps / config / ci / lint / format / upgrade
  if (/\b(chore|bump|deps|dependency|dependencies|config|ci|lint|format|upgrade|version)\b/.test(g)) {
    return 'chore';
  }
  // feature: add / implement / build / create / feature / support / new
  if (/\b(feature|features|add|adds|implement|implements|build|create|support|introduce|new)\b/.test(g)) {
    return 'feature';
  }
  // GOAL_CATEGORIES is the single source of truth for the valid labels; the
  // fallthrough returns the final ('other') bucket from it.
  return GOAL_CATEGORIES[GOAL_CATEGORIES.length - 1];
}

/**
 * Normalize a raw task.error string into a stable cluster key (lowercase,
 * stripped of ids/paths/numbers/hashes) so similar errors cluster together.
 * Pure; never throws.
 */
export function normalizeErrorKey(error: string): string {
  if (typeof error !== 'string') return '';
  let s = error.toLowerCase().trim();
  if (!s) return '';
  // Strip uuids first (more specific than the generic hash rule below).
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>');
  // Strip absolute/relative paths to a placeholder.
  s = s.replace(/(?:\/[\w.\-@]+)+/g, ' <path> ');
  // Strip hex hashes.
  s = s.replace(/\b[0-9a-f]{8,}\b/g, '<hash>');
  // Strip standalone numbers (line/col/byte counts, ports, durations).
  s = s.replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, '<n>');
  // Strip quoted identifiers so 'foo'/"bar" don't fragment the cluster.
  s = s.replace(/['"`][^'"`]*['"`]/g, '<id>');
  // Collapse whitespace and cap length so the key stays stable + bounded.
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 120);
}

/**
 * Cluster failed tasks across swarms into the top FailureMode buckets, most
 * frequent first, capped at MAX_FAILURE_MODES. Pure over the provided swarms;
 * never throws.
 */
export function clusterFailures(swarms: SwarmRun[]): FailureMode[] {
  const buckets = new Map<
    string,
    { label: string; count: number; phases: Set<string>; examples: Set<string> }
  >();

  try {
    for (const s of swarms) {
      const tasks = Array.isArray(s.tasks) ? s.tasks : [];
      for (const t of tasks) {
        if (t.status !== 'failed') continue;
        const raw = (t.error ?? '').trim();
        // Fall back to the phase name when no error string is present, so a
        // failed task with no message still clusters by phase.
        const key = normalizeErrorKey(raw) || `phase:${t.phase ?? 'unknown'}`;
        const label = raw ? raw.slice(0, 100) : `failed in ${t.phase ?? 'unknown'} phase`;

        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { label, count: 0, phases: new Set(), examples: new Set() };
          buckets.set(key, bucket);
        }
        bucket.count++;
        if (t.phase) bucket.phases.add(String(t.phase));
        if (s.id && bucket.examples.size < MAX_FAILURE_EXAMPLES) {
          bucket.examples.add(s.id);
        }
      }
    }
  } catch {
    return [];
  }

  const modes: FailureMode[] = [];
  for (const [key, b] of buckets) {
    modes.push({
      key,
      label: b.label,
      count: b.count,
      phases: [...b.phases].sort(),
      exampleSwarmIds: [...b.examples],
    });
  }
  // Most frequent first; tiebreak on key for determinism.
  modes.sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return modes.slice(0, MAX_FAILURE_MODES);
}

/** Total (in+out) tokens for a swarm's cumulative usage. Pure. */
function swarmTokens(s: SwarmRun): number {
  const u = s.usage;
  if (!u) return 0;
  const ti = typeof u.tokensIn === 'number' ? u.tokensIn : 0;
  const to = typeof u.tokensOut === 'number' ? u.tokensOut : 0;
  return ti + to;
}

/** Estimated USD cost for a swarm. Pure. */
function swarmCost(s: SwarmRun): number {
  const c = s.usage?.estCostUsd;
  return typeof c === 'number' && Number.isFinite(c) ? c : 0;
}

/**
 * Aggregate per-goal-category cost/token/success stats over the swarms,
 * most-expensive (avgCostUsd) first. Pure; never throws.
 */
export function summarizeGoalCategories(swarms: SwarmRun[]): GoalCategoryStat[] {
  const buckets = new Map<
    string,
    { swarms: number; cost: number; tokens: number; done: number }
  >();

  try {
    for (const s of swarms) {
      const cat = classifyGoal(s.goal ?? '');
      let b = buckets.get(cat);
      if (!b) {
        b = { swarms: 0, cost: 0, tokens: 0, done: 0 };
        buckets.set(cat, b);
      }
      b.swarms++;
      b.cost += swarmCost(s);
      b.tokens += swarmTokens(s);
      if (s.status === 'done') b.done++;
    }
  } catch {
    return [];
  }

  const stats: GoalCategoryStat[] = [];
  for (const [category, b] of buckets) {
    if (b.swarms === 0) continue;
    stats.push({
      category,
      swarms: b.swarms,
      avgCostUsd: b.cost / b.swarms,
      avgTokens: b.tokens / b.swarms,
      successRate: b.done / b.swarms,
    });
  }
  // Most-expensive first; tiebreak on category for determinism.
  stats.sort(
    (a, b) =>
      b.avgCostUsd - a.avgCostUsd ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
  );
  return stats;
}

/**
 * Compute week-over-week deltas vs a prior snapshot. Pure; never throws.
 * When `previous` is null, returns a no-prior delta (all numeric fields null).
 *
 * `currentWindow` (the window/scope label of the CURRENT report) is compared
 * against `previous.window`. When they differ, the metrics were computed over
 * DIFFERENT populations, so the headline is annotated '(windows differ)' to
 * flag that the delta is apples-to-oranges. Omitting it (or passing the same
 * label) leaves the headline unannotated.
 */
export function computeDelta(
  current: Pick<ReflectionReport, 'successRate' | 'avgCostUsd' | 'localShare'>,
  previous: ReflectionReport | null,
  currentWindow?: string | null,
): ReflectionDelta {
  if (!previous) {
    return {
      previousAt: null,
      effectivenessPct: null,
      costPct: null,
      localSharePct: null,
      headline: 'No prior snapshot — this is the first reflection.',
    };
  }

  const round1 = (n: number): number => Math.round(n * 10) / 10;

  // Effectiveness: signed percentage-POINT change of success rate.
  const effectivenessPct = round1((current.successRate - previous.successRate) * 100);

  // Cost: signed PERCENT change in avg cost per swarm. Guard divide-by-zero.
  let costPct: number;
  if (previous.avgCostUsd > 0) {
    costPct = round1(((current.avgCostUsd - previous.avgCostUsd) / previous.avgCostUsd) * 100);
  } else if (current.avgCostUsd > 0) {
    // Was free, now costs something — represent as +100% (newly non-zero).
    costPct = 100;
  } else {
    costPct = 0;
  }

  // Local share: signed percentage-POINT change.
  const localSharePct = round1((current.localShare - previous.localShare) * 100);

  // Only annotate when BOTH windows are known and actually differ — comparing
  // metrics across different windows/scopes makes the delta apples-to-oranges.
  const windowsDiffer =
    currentWindow !== undefined &&
    (previous.window ?? null) !== (currentWindow ?? null);
  const baseHeadline = composeHeadline(effectivenessPct, costPct, localSharePct);
  const headline = windowsDiffer
    ? `${baseHeadline} (windows differ: prior ${previous.window ?? 'all'} vs current ${currentWindow ?? 'all'})`
    : baseHeadline;

  return { previousAt: previous.generatedAt, effectivenessPct, costPct, localSharePct, headline };
}

/** Compose the deterministic week-over-week headline string. Pure. */
function composeHeadline(effPct: number, costPct: number, localPct: number): string {
  const parts: string[] = [];

  if (effPct > 0) parts.push(`${effPct.toFixed(1)}% more effective`);
  else if (effPct < 0) parts.push(`${Math.abs(effPct).toFixed(1)}% less effective`);
  else parts.push('equally effective');

  if (costPct < 0) parts.push(`${Math.abs(costPct).toFixed(1)}% cheaper`);
  else if (costPct > 0) parts.push(`${costPct.toFixed(1)}% more expensive`);
  else parts.push('cost unchanged');

  if (localPct > 0) parts.push(`${localPct.toFixed(1)} pts more local`);
  else if (localPct < 0) parts.push(`${Math.abs(localPct).toFixed(1)} pts less local`);

  return `Since the last reflection, the org got ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Public: buildReflection — DETERMINISTIC, NO LLM, NO NETWORK
// ---------------------------------------------------------------------------

/**
 * Build a ReflectionReport from the user's OWN local history.
 *
 * Reads (READ-ONLY):
 *  - listSwarms() — capped to the most-recent `maxRuns` and/or `sinceMs` window.
 *  - collectUsageEvents(sinceMs) — for the local-vs-cloud token share.
 *  - genomeHubHealth — HUB-ONLY entry counts (no portfolio disk scan).
 *
 * Computes: success rate, avg cost & tokens per swarm, local share, top failure
 * modes, goal-category stats, and week-over-week deltas vs loadPreviousReport().
 *
 * DETERMINISTIC: makes ZERO network connections and uses NO LLM. Never throws —
 * returns a zeroed report on any failure.
 */
export function buildReflection(
  // cfg is retained for API compatibility (callers pass it positionally) but is
  // no longer consumed: genomeHubHealth() reads ONLY the local hub store and
  // takes no config (no portfolio walk, no embeddings probe).
  _cfg: AshlrConfig,
  opts: ReflectionOptions = {},
): ReflectionReport {
  const now = new Date().toISOString();
  // Window resolution:
  //  - opts.sinceMs === undefined  => NO explicit window: apply the bounded
  //    DEFAULT_USAGE_LOOKBACK_MS so the default path never streams the entire
  //    historical corpus.
  //  - opts.sinceMs === 0          => explicit '--since all': scan all history
  //    (the caller opted in; still bounded by usage-source's per-file caps).
  //  - opts.sinceMs > 0            => an explicit Nd window.
  const explicitAll = opts.sinceMs === 0;
  const sinceMs =
    opts.sinceMs === undefined ? Date.now() - DEFAULT_USAGE_LOOKBACK_MS : opts.sinceMs;
  const maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;

  // --- Read swarm history (READ-ONLY, BOUNDED) ---
  let swarms: SwarmRun[] = [];
  try {
    const all = listSwarms(); // already capped at 200 + sorted most-recent first
    swarms = all
      .filter((s) => {
        if (sinceMs <= 0) return true;
        const t = Date.parse(s.createdAt ?? '');
        return Number.isFinite(t) ? t >= sinceMs : true;
      })
      .slice(0, Math.max(0, maxRuns));
  } catch {
    swarms = [];
  }

  // --- Success / cost / token aggregates ---
  let swarmsDone = 0;
  let swarmsFailed = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const s of swarms) {
    if (s.status === 'done') swarmsDone++;
    else if (s.status === 'failed' || s.status === 'aborted') swarmsFailed++;
    totalCostUsd += swarmCost(s);
    totalTokens += swarmTokens(s);
  }
  const swarmsAnalyzed = swarms.length;
  // Success rate is computed over TERMINAL swarms only ('done'|'failed'|
  // 'aborted'); in-flight statuses ('planning'|'running'|'needs-approval') are
  // NOT counted as non-successes in the denominator (that would understate
  // effectiveness and corrupt the week-over-week delta when in-flight counts
  // differ between snapshots). swarmsAnalyzed still reports how many were read.
  const swarmsTerminal = swarmsDone + swarmsFailed;
  const successRate = swarmsTerminal > 0 ? swarmsDone / swarmsTerminal : 0;
  // Cost/token averages stay over all analyzed swarms (in-flight runs still
  // incur real spend that belongs in the per-swarm average).
  const avgCostUsd = swarmsAnalyzed > 0 ? totalCostUsd / swarmsAnalyzed : 0;
  const avgTokens = swarmsAnalyzed > 0 ? totalTokens / swarmsAnalyzed : 0;

  // --- Local-vs-cloud token share from usage events (READ-ONLY) ---
  let localShare = 0;
  try {
    const events = collectUsageEvents(explicitAll ? 0 : sinceMs);
    let localTokens = 0;
    let allTokens = 0;
    for (const e of events) {
      const tok = (e.tokensIn ?? 0) + (e.tokensOut ?? 0);
      if (tok <= 0) continue;
      allTokens += tok;
      if (isLocalProviderModel(e.model)) localTokens += tok;
    }
    localShare = allTokens > 0 ? localTokens / allTokens : 0;
  } catch {
    localShare = 0;
  }

  // --- Failure clustering + goal categories (pure) ---
  const topFailures = clusterFailures(swarms);
  const goalCategories = summarizeGoalCategories(swarms);

  // --- Week-over-week delta vs the prior snapshot ---
  // currentWindow lets computeDelta annotate the headline when the prior
  // snapshot covered a DIFFERENT window/scope (apples-to-oranges deltas).
  const currentWindow = explicitAll ? 'all' : opts.window ?? null;
  const delta = computeDelta(
    { successRate, avgCostUsd, localShare },
    loadPreviousReport(now),
    currentWindow,
  );

  // --- Genome health snapshot (HUB-ONLY: no portfolio disk scan) ---
  // Reads ONLY ~/.ashlr/genome/hub.jsonl via genomeHubHealth — it does NOT walk
  // the configured portfolio roots, honouring invariant #4 (operate only on the
  // user's OWN local hub history, never a portfolio disk scan).
  let genome: ReflectionReport['genome'];
  try {
    genome = genomeHubHealth();
  } catch {
    genome = {
      totalEntries: 0,
      projects: 0,
      hubEntries: 0,
      sizeBytes: 0,
      lastLearnedAt: null,
      embeddingsAvailable: false,
    };
  }

  return {
    generatedAt: now,
    // Record the analysis lower bound. For '--since all' (explicitAll) there is
    // no lower bound, so we record the sentinel 'all' rather than the Unix epoch
    // (which would misrender as a 1970 window). An Nd / default window records
    // its concrete ISO lower bound.
    since: explicitAll ? 'all' : new Date(sinceMs).toISOString(),
    window: explicitAll ? 'all' : opts.window ?? null,
    swarmsAnalyzed,
    swarmsDone,
    swarmsFailed,
    successRate,
    avgCostUsd,
    avgTokens,
    totalCostUsd,
    localShare,
    topFailures,
    goalCategories,
    delta,
    genome,
  };
}

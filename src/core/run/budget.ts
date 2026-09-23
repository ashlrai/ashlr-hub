/**
 * Budget accounting for `ashlr run`.
 *
 * Pure, deterministic functions — no I/O, no side effects. All functions
 * return new objects; RunUsage is never mutated in place.
 */

import type { AshlrConfig, RunUsage, RunBudget } from '../types.js';
import { subjectMeteredness, type Meteredness } from '../policy/local-only.js';

// ---------------------------------------------------------------------------
// Static price table (rough $/M-token estimates for cloud providers).
// Local providers always return 0. Cloud prices are ESTIMATES only — used
// for informational cost summaries, not billing.
// ---------------------------------------------------------------------------

/** $/M input tokens */
const PRICE_IN: Record<string, number> = {
  // Anthropic Claude models
  anthropic: 3.0,           // conservative mid-tier estimate
  claude: 3.0,
  // OpenAI
  openai: 2.5,              // gpt-4o-mini ballpark
  gpt: 2.5,
  // Google
  google: 1.25,
  gemini: 1.25,
  // Mistral
  mistral: 2.0,
  // Cohere
  cohere: 1.0,
};

/** $/M output tokens */
const PRICE_OUT: Record<string, number> = {
  anthropic: 15.0,
  claude: 15.0,
  openai: 10.0,
  gpt: 10.0,
  google: 5.0,
  gemini: 5.0,
  mistral: 6.0,
  cohere: 3.0,
};

// ---------------------------------------------------------------------------
// What costs nothing — asked, never restated
// ---------------------------------------------------------------------------

/**
 * WHAT MAKES A CALL FREE IS METEREDNESS, NEVER LOCALITY.
 *
 * This file used to carry its own two-entry set (`ollama`, `lmstudio`). That was
 * wrong in one direction — `local-coder` and `llama-server` serve the same
 * weights off the same loopback port and were priced as cloud — and the obvious
 * repair was worse in the other: routing the question through
 * `engineLocality` would have called `ashlrcode` local and billed every
 * ashlrcode run at $0.
 *
 * ZERO IS WORSE THAN WRONG. Before this change `'ashlrcode'` matched no price
 * key and fell to the conservative $3/$15 estimate: a wrong number, but a
 * VISIBLE one, and a wrong number invites scrutiny where a zero ends it. So the
 * question asked here is the spend question, and `ashlrcode` stays priced.
 *
 * `subjectMeteredness` also settles the id-space confusion this function was
 * living with: the doc comment below said "provider id" while
 * `run/sandboxed-engine.ts` passed an ENGINE id at `:1825`, `:2161` and
 * `:3061`. Both id spaces now resolve, and the parameter is named for it.
 */
function meterednessOf(subject: string, cfg?: AshlrConfig): Meteredness {
  const key = subject.trim().toLowerCase();
  if (key.length === 0) return 'unknown';
  const bucket = cacheBucket(cfg);
  const hit = bucket.get(key);
  if (hit !== undefined) return hit;
  const answer = subjectMeteredness(subject, cfg);
  bucket.set(key, answer);
  return answer;
}

/**
 * Memoised because `estCostUsd` runs once per model step and per usage event in
 * the rollup, while `subjectMeteredness` resolves the whole engine registry.
 * Keyed by cfg identity so a caller that passes a different config is not served
 * another config's answer; the no-cfg bucket is separate for the same reason.
 */
const meterednessByCfg = new WeakMap<object, Map<string, Meteredness>>();
const meterednessNoCfg = new Map<string, Meteredness>();

function cacheBucket(cfg?: AshlrConfig): Map<string, Meteredness> {
  if (!cfg) return meterednessNoCfg;
  const existing = meterednessByCfg.get(cfg);
  if (existing) return existing;
  const fresh = new Map<string, Meteredness>();
  meterednessByCfg.set(cfg, fresh);
  return fresh;
}

/**
 * Test-only: drop memoised answers so suites that vary env or registry entries
 * stay independent of each other's ordering.
 */
export function __resetBudgetMeterednessCacheForTests(): void {
  meterednessNoCfg.clear();
}

/**
 * True when at least one of these subjects could actually bill someone.
 *
 * The daemon needs this to answer "can a dollar cap bound this tick at all?"
 * before it consults one. Billable is the COMPLEMENT of provably free, so
 * `'unknown'` counts as billable: a subject we cannot account for is charged,
 * never assumed free — under-charging is how an unbounded loop hides.
 *
 * Note the axis. This asks METEREDNESS, never locality. `ashlrcode` runs on this
 * machine and is billable; a self-hosted endpoint on loopback is free wherever
 * the operator thinks it lives. Empty input is NOT billable — nothing to charge.
 */
export function anyBillableSubject(subjects: Iterable<string>, cfg?: AshlrConfig): boolean {
  for (const subject of subjects) {
    if (meterednessOf(subject, cfg) !== 'free') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a fresh, zeroed RunUsage.
 */
export function newUsage(): RunUsage {
  return { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 };
}

/**
 * Return a NEW RunUsage = a + b.
 * `b` is partial — missing fields are treated as 0.
 * `estCostUsd` is RECOMPUTED from the merged token totals using a neutral
 * provider label; callers that track the provider should use estCostUsd()
 * directly and store the result, rather than relying on the summed field.
 * In practice the orchestrator stores per-task provider and sets estCostUsd
 * independently; this function sums the existing estCostUsd fields to
 * preserve already-computed values.
 */
export function addUsage(a: RunUsage, b: Partial<RunUsage>): RunUsage {
  const tokensIn = a.tokensIn + (b.tokensIn ?? 0);
  const tokensOut = a.tokensOut + (b.tokensOut ?? 0);
  const steps = a.steps + (b.steps ?? 0);
  const estCostUsdVal = a.estCostUsd + (b.estCostUsd ?? 0);
  return { tokensIn, tokensOut, steps, estCostUsd: estCostUsdVal };
}

// ---------------------------------------------------------------------------
// Non-dollar ceilings — tokens, steps, iterations, time
// ---------------------------------------------------------------------------

/** Which ceiling stopped a run. */
export type BudgetLimiter = 'tokens' | 'steps' | 'iterations' | 'deadline';

/** The verdict from `budgetVerdict`. `limiter` is null iff `exhausted` is false. */
export interface BudgetVerdict {
  /** True when the run has hit at least one ceiling and must not continue. */
  exhausted: boolean;
  /** The FIRST ceiling that fired, in declaration order. Null when none did. */
  limiter: BudgetLimiter | null;
  /** One line naming the ceiling and the numbers behind it. */
  reason: string;
}

/**
 * Everything a budget check needs, PASSED IN.
 *
 * Nothing in this section calls `Date.now()`. A deadline check that reads the
 * clock itself is neither pure nor testable — you cannot assert "stops at
 * exactly T+5s" against an ambient clock without sleeping. The caller owns the
 * clock.
 */
export interface RunProgress {
  /** Token and step accounting so far. */
  usage: RunUsage;
  /** Completed iterations (outer ticks). Absent ⇒ `maxIterations` cannot fire. */
  iterations?: number;
  /** Wall-clock now, epoch ms. Absent ⇒ no time-based ceiling can fire. */
  nowMs?: number;
  /** When the run started, epoch ms. Required for `maxWallClockMs`. */
  startedAtMs?: number;
}

const NOT_EXHAUSTED: BudgetVerdict = Object.freeze({
  exhausted: false,
  limiter: null,
  reason: 'within budget',
});

/**
 * A ceiling only binds when it is a real, finite number.
 *
 * `undefined` means the dimension is unused. `Infinity` means explicitly
 * unbounded. `NaN` is nonsense and must not silently disable a ceiling in a way
 * that reads as "unlimited" — but a NaN comparison is false anyway, so this
 * makes that explicit rather than accidental.
 */
function binds(ceiling: number | undefined): ceiling is number {
  return typeof ceiling === 'number' && Number.isFinite(ceiling);
}

/**
 * The single pure predicate over every NON-MONETARY ceiling in `RunBudget`.
 *
 * WHY THIS EXISTS. A dollar cap cannot bound local work: a provably-free
 * dispatch moves realized spend by $0, so a USD guard never fires and "bounded
 * by budget" becomes a comfortable fiction wrapped around an unbounded loop.
 * Every ceiling here is non-monetary and bounds a run whether it reached a
 * frontier API or never left this machine.
 *
 * Checks, in order — the first to fire names the limiter:
 *   1. tokens      — (tokensIn + tokensOut) >= maxTokens
 *   2. steps       — steps                  >= maxSteps
 *   3. iterations  — iterations             >= maxIterations
 *   4. deadline    — nowMs                  >= deadlineEpochMs, or
 *                    (nowMs - startedAtMs)  >= maxWallClockMs
 *
 * Every comparison is `>=`, not `>`: once the ceiling is reached we stop BEFORE
 * attempting more work. That is the conservative reading and it matches the
 * behaviour `overBudget` has always had.
 *
 * A dimension whose ceiling is absent, non-finite, or whose progress the caller
 * did not supply simply does not fire. That is deliberate: an unbounded
 * dimension must never be confused with an exhausted one.
 */
export function budgetVerdict(progress: RunProgress, budget: RunBudget): BudgetVerdict {
  const { usage } = progress;

  const totalTokens = usage.tokensIn + usage.tokensOut;
  if (binds(budget.maxTokens) && totalTokens >= budget.maxTokens) {
    return {
      exhausted: true,
      limiter: 'tokens',
      reason: `token ceiling reached (${totalTokens}/${budget.maxTokens})`,
    };
  }

  if (binds(budget.maxSteps) && usage.steps >= budget.maxSteps) {
    return {
      exhausted: true,
      limiter: 'steps',
      reason: `step ceiling reached (${usage.steps}/${budget.maxSteps})`,
    };
  }

  // An ABSENT iteration count is an unsupplied dimension, not zero iterations.
  // Defaulting it to 0 would make `maxIterations: 0` fire through `overBudget`
  // — which carries no iteration count — while `maxIterations: 5` silently
  // could not. Same rule as the clock below: no progress, no ceiling.
  const iterations = progress.iterations;
  if (
    binds(budget.maxIterations) &&
    typeof iterations === 'number' &&
    Number.isFinite(iterations) &&
    iterations >= budget.maxIterations
  ) {
    return {
      exhausted: true,
      limiter: 'iterations',
      reason: `iteration ceiling reached (${iterations}/${budget.maxIterations})`,
    };
  }

  const now = progress.nowMs;
  if (typeof now === 'number' && Number.isFinite(now)) {
    if (binds(budget.deadlineEpochMs) && now >= budget.deadlineEpochMs) {
      return {
        exhausted: true,
        limiter: 'deadline',
        reason: `deadline reached (${new Date(budget.deadlineEpochMs).toISOString()})`,
      };
    }
    const startedAt = progress.startedAtMs;
    if (
      binds(budget.maxWallClockMs) &&
      typeof startedAt === 'number' &&
      Number.isFinite(startedAt) &&
      now - startedAt >= budget.maxWallClockMs
    ) {
      return {
        exhausted: true,
        limiter: 'deadline',
        reason: `wall-clock ceiling reached (${now - startedAt}ms/${budget.maxWallClockMs}ms)`,
      };
    }
  }

  return NOT_EXHAUSTED;
}

/**
 * Returns true when usage has EXCEEDED the budget.
 *
 * Triggers:
 *   - (tokensIn + tokensOut) >= budget.maxTokens, OR
 *   - steps >= budget.maxSteps
 *
 * Using >= (not >) means: once we hit the ceiling we stop BEFORE attempting
 * another step, which is the conservative / safe behaviour.
 *
 * This is the token/step SLICE of `budgetVerdict` and is kept for the many
 * existing callers that have only a `RunUsage` to hand. It carries no iteration
 * count and no clock, so the iteration and deadline ceilings cannot fire through
 * it — a caller that sets those must call `budgetVerdict` with the corresponding
 * progress, or they are silently unenforced.
 */
export function overBudget(usage: RunUsage, budget: RunBudget): boolean {
  return budgetVerdict({ usage }, budget).exhausted;
}

/**
 * M246: Cache token pricing multipliers relative to base input price.
 *
 * These match the Anthropic prompt-cache pricing tiers:
 *   - 5-minute write:  1.25× base input price
 *   - 1-hour write:    2.0×  base input price
 *   - cache read:      0.1×  base input price
 *
 * Additive params with defaults — existing callers (zero cache tokens) are
 * unaffected: estCostUsd('claude', 1000, 500) behaves identically to before.
 */
export const CACHE_WRITE_5M_MULT  = 1.25;  // 5-min TTL cache write
export const CACHE_WRITE_1H_MULT  = 2.0;   // 1-hour TTL cache write
export const CACHE_READ_MULT      = 0.1;   // cache read (served from cache)

/**
 * Estimated USD cost for a single model call.
 *
 * - PROVABLY FREE subjects → 0. That is `subjectMeteredness(...) === 'free'`:
 *   loopback endpoints and the local serving runtimes, whatever they are called
 *   in either id space.
 * - Everything else → looked up from the static price table by matching the id
 *   (case-insensitive prefix match against known keys). Falls back to a
 *   conservative $3/$15 per-M-token estimate when nothing matches — which is
 *   where `'ashlrcode'` lands, ON PURPOSE. A metered subject must never report
 *   $0; a wrong number invites scrutiny, a zero ends it.
 * - M246: optional cache token params (default 0) add tiered cache pricing
 *   on top of the base cost. Existing callers with no cache args are unaffected.
 *
 * @param subject        Provider id OR engine id — e.g. 'ollama', 'anthropic',
 *                       'local-coder', 'ashlrcode'. Both id spaces resolve; see
 *                       `meterednessOf` for why this parameter used to lie.
 * @param tokensIn       Number of prompt/input tokens (non-cached).
 * @param tokensOut      Number of completion/output tokens.
 * @param cacheRead      M246: Cache-read tokens (0 by default).
 * @param cacheWrite5m   M246: 5-min TTL cache-write tokens (0 by default).
 * @param cacheWrite1h   M246: 1-hour TTL cache-write tokens (0 by default).
 * @param cfg            Optional config, so engines registered through
 *                       `cfg.foundry.engines` classify correctly. Omitting it
 *                       can only make a subject LESS provably free, never more.
 * @returns Estimated USD cost as a number (0 only when provably free).
 */
export function estCostUsd(
  subject: string,
  tokensIn: number,
  tokensOut: number,
  cacheRead = 0,
  cacheWrite5m = 0,
  cacheWrite1h = 0,
  cfg?: AshlrConfig,
): number {
  const key = subject.toLowerCase();

  // Fast path: nothing that is PROVABLY free can bill anyone.
  if (meterednessOf(subject, cfg) === 'free') return 0;

  // Prefix match against the price table keys
  let priceIn = 3.0;   // conservative fallback
  let priceOut = 15.0; // conservative fallback

  for (const tableKey of Object.keys(PRICE_IN)) {
    if (key.includes(tableKey) || tableKey.includes(key)) {
      priceIn = PRICE_IN[tableKey]!;
      priceOut = PRICE_OUT[tableKey] ?? priceOut;
      break;
    }
  }

  const costIn       = (tokensIn      / 1_000_000) * priceIn;
  const costOut      = (tokensOut     / 1_000_000) * priceOut;
  // M246: tiered cache pricing — multiplied against base input price
  const costCacheRead    = (cacheRead    / 1_000_000) * priceIn * CACHE_READ_MULT;
  const costCacheWrite5m = (cacheWrite5m / 1_000_000) * priceIn * CACHE_WRITE_5M_MULT;
  const costCacheWrite1h = (cacheWrite1h / 1_000_000) * priceIn * CACHE_WRITE_1H_MULT;
  return costIn + costOut + costCacheRead + costCacheWrite5m + costCacheWrite1h;
}

// ---------------------------------------------------------------------------
// The dollar cap, and when it is not the thing that binds
//
// OWNERSHIP NOTE. Everything below is a pure predicate intended for
// `src/core/daemon/loop.ts`, which this change does NOT edit. The loop owner
// wires these in; see the call contract on each function.
// ---------------------------------------------------------------------------

/**
 * What the daily USD cap means for the work about to be dispatched.
 *
 *  - `stopped`        — the operator set the cap to 0. An explicit STOP.
 *  - `not-applicable` — the cap is positive but nothing about to run can bill
 *                       anyone, so dollars cannot bound this work at all. The
 *                       honest limiters are the non-monetary ones: serving
 *                       slots, `perTickItems`, `localFleet.maxDispatchesPerDay`,
 *                       and `RunBudget` through `budgetVerdict`.
 *  - `enforced`       — the cap is positive and real spend is possible.
 */
export type DollarCapVerdict =
  | { kind: 'stopped'; reason: string }
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'enforced'; remainingUsd: number };

/**
 * Decide whether the dollar cap binds, and if so with how much headroom.
 *
 * ── ZERO IS STILL A CHOICE, NOT AN ABSENCE ─────────────────────────────────
 * `loop.ts` deliberately preserves a stored `dailyBudgetUsd` of 0 instead of
 * defaulting it, because the Verse control plane offers 0 as "stop the loop"
 * and the cockpit states that as fact. Knowing that some work is free creates an
 * obvious temptation: "it costs nothing, so a $0 cap shouldn't stop it." That
 * temptation is the trap. Reinterpreting an explicit 0 would authorise
 * autonomous work against a screen that says the loop is stopped.
 *
 * So `stopped` is checked FIRST, before billability is even considered, and it
 * wins unconditionally. Free work is not exempted from a stop; it is given a
 * DIFFERENT way to say "run without a dollar bound" — a positive cap that simply
 * never binds because nothing is billable (`not-applicable`), with the real
 * ceilings expressed in `RunBudget` and the fleet's own dispatch ledger. "Free"
 * and "stopped" stay two different states.
 *
 * Negative and non-finite caps are nonsense; they are treated as `stopped`,
 * which fails closed.
 *
 * CALL CONTRACT for `loop.ts`: replace the bare `remainingBudget <= 0` skip with
 * a switch on this verdict. `billable` is
 * `anyBillableSubject(enginesThisTick, cfg)` — a METEREDNESS question. Passing
 * something derived from locality would reintroduce exactly the confusion
 * `docs/LOCALITY-VS-SPEND.md` exists to prevent: `ashlrcode` runs here and
 * still bills.
 */
export function dollarCapVerdict(input: {
  /** The configured daily cap in USD. 0 means the operator stopped the loop. */
  dailyBudgetUsd: number;
  /** Realized spend so far today, in USD. */
  spentUsd: number;
  /** True when at least one subject this tick could bill someone. */
  billable: boolean;
}): DollarCapVerdict {
  const { dailyBudgetUsd, spentUsd, billable } = input;

  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
    return {
      kind: 'stopped',
      reason: 'daily budget is 0 — the loop is stopped by operator choice',
    };
  }

  if (!billable) {
    return {
      kind: 'not-applicable',
      reason:
        'nothing this tick can bill anyone — a dollar cap cannot bound free work; ' +
        'serving slots, perTickItems, maxDispatchesPerDay and RunBudget bound it instead',
    };
  }

  const spent = Number.isFinite(spentUsd) ? Math.max(0, spentUsd) : dailyBudgetUsd;
  return { kind: 'enforced', remainingUsd: Math.max(0, dailyBudgetUsd - spent) };
}

/** The daemon's existing $/M-output assumption when slicing dollars into tokens. */
export const DEFAULT_USD_PER_MTOKEN_OUT = 15.0;

/** The daemon's existing floor: never hand an item a budget it cannot use. */
export const MIN_PER_ITEM_MAX_TOKENS = 1000;

/**
 * Per-item token budget for one tick's items.
 *
 * ── WHY THIS MOVED OUT OF THE DOLLAR SLICE ─────────────────────────────────
 * `loop.ts` derives `perItemMaxTokens` by dividing the REMAINING DOLLARS across
 * items and converting at $15/Mtok. When a tick's work is provably free,
 * realized spend never moves, so that derivation stops tracking anything: it
 * pins to the full daily budget forever and reports a token ceiling derived from
 * a dollar figure that has no relationship to the work. Dividing a number that
 * cannot change is not a budget.
 *
 * So the derivation forks on the cap verdict:
 *   - `enforced`       — unchanged arithmetic, unchanged floor. Existing
 *                        behaviour for billable work is preserved exactly.
 *   - `not-applicable` — the token ceiling comes from `RunBudget.maxTokens`,
 *                        the dimension that actually bounds free work.
 *   - `stopped`        — the floor. Nothing should dispatch under a stop; this
 *                        returns a small, sane number rather than 0 (which a
 *                        careless caller would read as "no budget, skip") or
 *                        Infinity.
 *
 * NEITHER COLLAPSES NOR EXPLODES: the result is always a finite integer at or
 * above `floor`. An unbounded or non-finite `maxTokens` yields the floor rather
 * than Infinity, because "unbounded per item" is not a token cap any caller can
 * act on.
 *
 * CALL CONTRACT for `loop.ts`: replace the inline `perItemUsdSlice` /
 * `usdPerMTokenOut` block with a single call to this function.
 */
export function perItemMaxTokens(input: {
  /** How many items this tick will work. Coerced to at least 1. */
  items: number;
  /** The run budget in force, read for `maxTokens` when dollars do not bind. */
  budget: RunBudget;
  /** The verdict from `dollarCapVerdict`. */
  cap: DollarCapVerdict;
  /** $/M output tokens used to convert dollars to tokens. */
  usdPerMTokenOut?: number;
  /** Lower bound on the result. */
  floor?: number;
}): number {
  const floor = Math.max(1, Math.floor(input.floor ?? MIN_PER_ITEM_MAX_TOKENS));
  const items = Math.max(1, Math.floor(Number.isFinite(input.items) ? input.items : 1));

  if (input.cap.kind === 'stopped') return floor;

  if (input.cap.kind === 'not-applicable') {
    const maxTokens = input.budget.maxTokens;
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return floor;
    return Math.max(floor, Math.floor(maxTokens / items));
  }

  const rate = input.usdPerMTokenOut ?? DEFAULT_USD_PER_MTOKEN_OUT;
  if (!Number.isFinite(rate) || rate <= 0) return floor;
  const perItemUsdSlice = input.cap.remainingUsd / items;
  const derived = Math.floor((perItemUsdSlice / rate) * 1_000_000);
  if (!Number.isFinite(derived)) return floor;
  return Math.max(floor, derived);
}

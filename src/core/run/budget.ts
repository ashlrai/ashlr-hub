/**
 * Budget accounting for `ashlr run`.
 *
 * Deterministic functions — no side effects, no ambient clock. All functions
 * return new objects; RunUsage is never mutated in place. Nothing here reads
 * `Date.now()`: a time-bounded run passes its own `nowMs` in, so every ceiling
 * in this file stays a testable predicate.
 *
 * The one thing that is not self-contained is LOCALITY. `estCostUsd` has to
 * know whether a subject's inference runs on this machine, and that question
 * already has exactly one authority — `src/core/policy/local-only.ts`, which
 * derives the answer from the resolved engine registry. This file asks it
 * rather than keeping a list of its own; see `isFreeSubject`.
 */

import type { RunUsage, RunBudget, AshlrConfig } from '../types.js';
import { engineLocality, providerLocality } from '../policy/local-only.js';

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
// Locality — delegated, never duplicated
// ---------------------------------------------------------------------------

/**
 * Does this subject's inference run on THIS machine, and therefore cost zero?
 *
 * ── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 * This used to be `const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio'])`.
 * That set knew about PROVIDER ids, but `src/core/run/sandboxed-engine.ts` —
 * the daemon's dispatch path — calls `estCostUsd(engine, …)` with an ENGINE
 * id: `llama-server`, `local-coder`, `builtin`, `ashlrcode`, `aw`. None of
 * those were in the set, and none are in the price table either, so every
 * local run fell through to the conservative $3/$15-per-Mtok fallback below.
 * A free overnight fleet run therefore billed itself at frontier rates and
 * halted on an imaginary dollar budget.
 *
 * ── WHY THIS IS NOT JUST A LONGER LIST ─────────────────────────────────────
 * A second hardcoded set fixed today drifts from the first tomorrow. Locality
 * already has ONE authority in this codebase, `src/core/policy/local-only.ts`,
 * and it is DERIVED rather than enumerated: `engineLocality` resolves the
 * engine registry and lets an api-model's ENDPOINT decide, so an engine added
 * through `cfg.foundry.engines` pointing at loopback is recognised as free
 * without anyone editing anything here. That is the property
 * `test/local-cost-zero-budget.test.ts` locks: a future local engine cannot be
 * silently priced as frontier, because nothing here enumerates engines at all.
 *
 * Two authorities are consulted because `estCostUsd` genuinely receives two
 * kinds of id:
 *   - `providerLocality` — set membership, no I/O. Checked FIRST because it
 *     answers the common cases (`ollama`, `lmstudio`, `llama-server`,
 *     `builtin`) without resolving the registry.
 *   - `engineLocality`   — registry-derived; catches `local-coder`, `aw`,
 *     `ashlrcode`, and anything the operator added.
 *
 * Both FAIL CLOSED to 'cloud'. A subject we cannot account for is priced, never
 * assumed free — under-charging is how an unbounded loop hides.
 *
 * @param subject A provider id ('ollama') or an EngineId ('local-coder').
 * @param cfg     Resolved config, so operator-added engines and a llama-server
 *                moved to another port are classified correctly. Omitted, only
 *                the builtin registry and process env are consulted.
 */
export function isFreeSubject(subject: string, cfg?: AshlrConfig): boolean {
  const id = subject.trim().toLowerCase();
  if (id.length === 0) return false;
  if (providerLocality(id) === 'local') return true;
  return engineLocality(id, cfg) === 'local';
}

/**
 * True when at least one of these subjects would actually bill someone.
 *
 * The daemon needs this to answer "can a dollar cap bound this tick at all?"
 * before it consults one. Empty input is NOT billable — nothing to charge.
 */
export function anyBillableSubject(subjects: Iterable<string>, cfg?: AshlrConfig): boolean {
  for (const subject of subjects) {
    if (!isFreeSubject(subject, cfg)) return true;
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
 * `budget.ts` never calls `Date.now()`. A deadline check that reads the clock
 * itself is neither pure nor testable — you cannot assert "stops at exactly
 * T+5s" against an ambient clock without sleeping. The caller owns the clock.
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
 * existing callers that have only a `RunUsage` to hand. It carries no
 * iteration count and no clock, so the iteration and deadline ceilings cannot
 * fire through it — a caller that sets those must call `budgetVerdict` with
 * the corresponding progress, or they are silently unenforced.
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

/** Optional context for `estCostUsd`. */
export interface EstCostOptions {
  /**
   * Resolved config. Threaded so locality is judged against the EFFECTIVE
   * engine registry: an engine added through `cfg.foundry.engines` on a
   * loopback endpoint, or a llama-server started on a non-default port, is
   * priced at zero without anyone editing this file.
   */
  cfg?: AshlrConfig;
}

/**
 * Estimated USD cost for a single model call.
 *
 * - Anything that runs on this machine → always 0, whether it was named by
 *   provider id ('ollama', 'lmstudio', 'llama-server') or by EngineId
 *   ('local-coder', 'builtin', 'aw', 'ashlrcode', or an operator-added engine
 *   on loopback). See `isFreeSubject` for why this is derived, not listed.
 * - Cloud providers → looked up from the static price table by matching
 *   the provider id (case-insensitive prefix match against known keys).
 *   Falls back to a conservative $3/$15 per-M-token estimate when unknown.
 * - M246: optional cache token params (default 0) add tiered cache pricing
 *   on top of the base cost. Existing callers with no cache args are unaffected.
 *
 * @param provider       Provider id string (e.g. 'ollama', 'anthropic', 'openai').
 * @param tokensIn       Number of prompt/input tokens (non-cached).
 * @param tokensOut      Number of completion/output tokens.
 * @param cacheRead      M246: Cache-read tokens (0 by default).
 * @param cacheWrite5m   M246: 5-min TTL cache-write tokens (0 by default).
 * @param cacheWrite1h   M246: 1-hour TTL cache-write tokens (0 by default).
 * @param opts           Optional context; `cfg` lets operator-added local
 *                       engines and a relocated llama-server price at zero.
 * @returns Estimated USD cost as a number (0 for local).
 */
export function estCostUsd(
  provider: string,
  tokensIn: number,
  tokensOut: number,
  cacheRead = 0,
  cacheWrite5m = 0,
  cacheWrite1h = 0,
  opts: EstCostOptions = {},
): number {
  const key = provider.toLowerCase();

  // LOCAL EXECUTION IS FREE ON EVERY PATH. `isFreeSubject` accepts both a
  // provider id (the orchestrator path) and an EngineId (the daemon's
  // sandboxed-engine path) — the mismatch between those two was the bug.
  if (isFreeSubject(provider, opts.cfg)) return 0;

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
 *  - `not-applicable` — the cap is positive but nothing about to run is
 *                       billable, so dollars cannot bound this work at all.
 *                       The honest limiters are the non-monetary ones:
 *                       serving slots, `perTickItems`,
 *                       `localFleet.maxDispatchesPerDay`, and `RunBudget`.
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
 * and the cockpit states that as fact. Making local work free creates an
 * obvious temptation: "it costs nothing, so a $0 cap shouldn't stop it." That
 * temptation is the trap. Reinterpreting an explicit 0 would authorise
 * autonomous work against a screen that says the loop is stopped.
 *
 * So `stopped` is checked FIRST, before billability is even considered, and it
 * wins unconditionally. A local-only run is not exempted from a stop; it is
 * given a DIFFERENT way to say "run without a dollar bound" — a positive cap
 * that simply never binds because nothing is billable (`not-applicable`),
 * with the real ceilings expressed in `RunBudget` and the fleet's own dispatch
 * ledger. "Free" and "stopped" stay two different states.
 *
 * Negative and non-finite caps are nonsense; they are treated as `stopped`,
 * which fails closed.
 *
 * CALL CONTRACT for `loop.ts`: replace the bare `remainingBudget <= 0` skip
 * with a switch on this verdict. `billable` is
 * `anyBillableSubject(enginesThisTick, cfg)`.
 */
export function dollarCapVerdict(input: {
  /** The configured daily cap in USD. 0 means the operator stopped the loop. */
  dailyBudgetUsd: number;
  /** Realized spend so far today, in USD. */
  spentUsd: number;
  /** True when at least one engine this tick could dispatch to is billable. */
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
        'every engine this tick runs locally — a dollar cap cannot bound free work; ' +
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
 * `loop.ts` derives `perItemMaxTokens` by dividing the REMAINING DOLLARS
 * across items and converting at $15/Mtok. With local cost correctly at zero,
 * realized spend never moves, so that derivation stops tracking anything: it
 * pins to the full daily budget forever and reports a token ceiling derived
 * from a dollar figure that has no relationship to the work. Dividing a number
 * that cannot change is not a budget.
 *
 * So the derivation forks on the cap verdict:
 *   - `enforced`       — unchanged arithmetic, unchanged floor. Existing
 *                        behaviour for billable work is preserved exactly.
 *   - `not-applicable` — the token ceiling comes from `RunBudget.maxTokens`,
 *                        the dimension that actually bounds local work.
 *   - `stopped`        — the floor. Nothing should dispatch under a stop; this
 *                        returns a small, sane number rather than 0 (which a
 *                        careless caller would read as "no budget, skip") or
 *                        Infinity.
 *
 * NEITHER COLLAPSES NOR EXPLODES: the result is always a finite integer at or
 * above `floor`. An unbounded or non-finite `maxTokens` yields the floor
 * rather than Infinity, because "unbounded per item" is not a token cap any
 * caller can act on.
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

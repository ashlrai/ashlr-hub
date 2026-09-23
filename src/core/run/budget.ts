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

/**
 * Returns true when usage has EXCEEDED the budget.
 *
 * Triggers:
 *   - (tokensIn + tokensOut) >= budget.maxTokens, OR
 *   - steps >= budget.maxSteps
 *
 * Using >= (not >) means: once we hit the ceiling we stop BEFORE attempting
 * another step, which is the conservative / safe behaviour.
 */
export function overBudget(usage: RunUsage, budget: RunBudget): boolean {
  const totalTokens = usage.tokensIn + usage.tokensOut;
  return totalTokens >= budget.maxTokens || usage.steps >= budget.maxSteps;
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

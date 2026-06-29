/**
 * Budget accounting for `ashlr run`.
 *
 * Pure, deterministic functions — no I/O, no side effects. All functions
 * return new objects; RunUsage is never mutated in place.
 */

import type { RunUsage, RunBudget } from '../types.js';

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

/** Providers that are always local (zero cost). */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

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
 * - Local providers (ollama, lmstudio) → always 0.
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
 * @returns Estimated USD cost as a number (0 for local).
 */
export function estCostUsd(
  provider: string,
  tokensIn: number,
  tokensOut: number,
  cacheRead = 0,
  cacheWrite5m = 0,
  cacheWrite1h = 0,
): number {
  const key = provider.toLowerCase();

  // Fast path: known local providers
  if (LOCAL_PROVIDERS.has(key)) return 0;

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

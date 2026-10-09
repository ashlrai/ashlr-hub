/**
 * The ONE tier model every resource surface shares (3.15, "equal partners").
 *
 * Mason, 2026-09-27: Claude, Codex and Devin are all elite and all a
 * commodity — different models for different things, but none of them is the
 * house favourite. The configured quality priors below originated in that
 * preference; they are not measured performance. They affect ranking without
 * restricting which providers can serve eligible roles:
 *
 *   elite  Claude Code, Codex (every account), Devin (cloud and CLI), and
 *          the local Qwen 3.8 27B (the operator's configured preference)
 *   fast   Grok, and Devin's SWE models
 *   free   every other local model (Ollama / LM Studio / llama-server)
 *
 * A seat's tier is per MODEL: the same Devin CLI seat is elite on its default
 * model and fast on SWE, and the built-in local preference is elite for Qwen
 * 3.8 27B. Tier is a ranking prior; cost basis is a separate billing category.
 * Neither alone proves current model quality, price or funding eligibility.
 *
 * Inside a tier nothing here prefers one provider over another: the seat
 * router (router.ts) orders a tier by headroom, marginal cost and latency, and
 * the Resources drawer orders it by status. Reserves and budget modes stay per
 * SEAT (policy.ts) — Mason's reserve on Claude is a configured reserve, not a
 * provider preference.
 *
 * Cost basis is what one more turn costs:
 *   subscription  a flat plan; a turn only spends its usage window
 *   credits       a metered balance (Claude cloud credits, Devin ACUs)
 *   per-token     billed per token by an API key
 *   free          nothing (local models, a plan's included free model)
 *
 * BROWSER-SAFE and PURE: plain consts and type-only imports. The router, the
 * Auto seat (in the browser), the New chat picker and the Resources drawer all
 * read the same table, so they can never disagree about a seat's tier.
 */

export type ResourceTier = 'elite' | 'fast' | 'free';

/** Best-first. The router's QUALITY order; CHEAP order is its reverse. */
export const RESOURCE_TIERS: readonly ResourceTier[] = ['elite', 'fast', 'free'];

export const TIER_LABELS: Readonly<Record<ResourceTier, string>> = Object.freeze({
  elite: 'Elite',
  fast: 'Fast',
  free: 'Free · local',
});

/** One line per tier, for the drawer's group headings and tooltips. */
export const TIER_BLURBS: Readonly<Record<ResourceTier, string>> = Object.freeze({
  elite: 'Resources in the Elite routing tier. Eligible providers are equal partners; this grouping does not restrict Leader or Manager roles.',
  fast: 'Resources in the Fast routing tier. This is a configured preference, not a measured speed or price.',
  free: 'Local resources in this routing tier. Inference runs on this computer; connected tools can use network services.',
});

export type CostBasis = 'subscription' | 'credits' | 'per-token' | 'free';

export const COST_BASIS_LABELS: Readonly<Record<CostBasis, string>> = Object.freeze({
  subscription: 'subscription',
  credits: 'credits',
  'per-token': 'per token',
  free: 'free',
});

/**
 * Marginal cost rank of one more turn, 0 = nothing. A subscription turn
 * spends a window that refills; credits and per-token turns spend money.
 * Used by the router only INSIDE a tier, as a tie-breaker below headroom.
 */
export const COST_BASIS_RANK: Readonly<Record<CostBasis, number>> = Object.freeze({
  free: 0,
  subscription: 0,
  credits: 1,
  'per-token': 1,
});

/**
 * Where a seat's model catalog can say "this model is free / fast" (the Devin
 * model list, `devin models list`, is owned by core/devin; until it supplies
 * one, `defaultModelTier` is the fallback). Returns null when it has no
 * opinion about a model.
 */
export interface ModelTierSource {
  tierOf(engine: string, modelId: string): ResourceTier | null;
}

/**
 * Devin's SWE family uses the configured Fast prior. Native execution must
 * separately qualify the selected model's current included funding boundary.
 */
const DEVIN_FAST_MODEL_RE = /^swe(?:$|[-_.\d])/i;

/**
 * Local models configured as ELITE (2026-09-27): Qwen 3.8 27B — the house
 * default `qwen3.8:27b-ctx64k` and any other context build of it. Still free
 * and still local (cost basis `free`); it simply competes for elite work
 * instead of waiting behind it. Other local tags stay in the free tier.
 */
const ELITE_LOCAL_MODEL_RE = /(?:^|[/:])qwen3\.8[^/]*?[:_-]27b(?:$|[^0-9])/i;

/** True when a local model tag is on the elite list. */
export function isEliteLocalModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && ELITE_LOCAL_MODEL_RE.test(`:${modelId.trim()}`);
}

/** The built-in answer for a model; null = the engine's own tier. */
export function defaultModelTier(engine: string, modelId: string | null | undefined): ResourceTier | null {
  if (typeof modelId !== 'string') return null;
  if (engine === 'devin' && DEVIN_FAST_MODEL_RE.test(modelId.trim())) return 'fast';
  if (engine === 'local' && isEliteLocalModel(modelId)) return 'elite';
  return null;
}

/** The tier an engine sits in with its default model. Unknown engines are elite-class (never assumed free). */
export function engineTier(engine: string): ResourceTier {
  if (engine === 'local') return 'free';
  if (engine === 'grok') return 'fast';
  return 'elite';
}

/** A seat's tier for one model: the model's own tier when it has one, else the engine's. */
export function seatTier(engine: string, modelId?: string | null, source?: ModelTierSource | null): ResourceTier {
  if (typeof modelId === 'string' && modelId.length > 0) {
    const fromSource = source?.tierOf(engine, modelId) ?? null;
    if (fromSource) return fromSource;
    const builtIn = defaultModelTier(engine, modelId);
    if (builtIn) return builtIn;
  }
  return engineTier(engine);
}

/**
 * Engines that expose NO usage window by design (Devin meters in ACUs and
 * plan usage). Interactive ranking treats their headroom as neutral, never
 * as the worst; autonomy still treats unknown usage as no headroom.
 */
export function isWindowlessEngine(engine: string): boolean {
  return engine === 'devin';
}

/** 0 = best tier. */
export function tierRank(tier: ResourceTier): number {
  return RESOURCE_TIERS.indexOf(tier);
}

export interface CostBasisHints {
  /** The seat runs in a hosted cloud lane on a credit balance (Claude cloud, Devin cloud ACUs). */
  cloud?: boolean;
  /** An API-key seat billed per token. */
  apiKey?: boolean;
  modelId?: string | null;
}

/** What one more turn on this seat costs. */
export function costBasisOf(engine: string, hints: CostBasisHints = {}): CostBasis {
  if (engine === 'local') return 'free';
  if (hints.apiKey) return 'per-token';
  if (hints.cloud) return 'credits';
  // A plan's included free model (Devin SWE) costs nothing more than the plan.
  if (engine === 'devin' && seatTier(engine, hints.modelId) === 'fast') return 'free';
  return 'subscription';
}

/**
 * Seat order for pickers: tier first, then the caller's order (discovery,
 * which already lists the operator's preferred local tags first). Stable —
 * two seats of one tier never swap because of their provider.
 */
export function orderByTier<T>(items: readonly T[], tierOfItem: (item: T) => ResourceTier): T[] {
  return items
    .map((item, index) => ({ item, index, rank: tierRank(tierOfItem(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item);
}

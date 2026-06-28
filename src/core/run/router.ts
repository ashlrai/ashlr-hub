/**
 * router.ts — per-task model router (M15 + M128).
 *
 * M15 (unchanged): LOCAL-FIRST, NO SILENT CLOUD.
 *   - Default path is always LOCAL (Ollama / LM Studio).
 *   - A CLOUD RouteDecision is returned ONLY when ALL three gates hold:
 *       1. opts.allowCloud === true
 *       2. opts.lastReason !== 'none'  (a real escalation trigger)
 *       3. cloudKeyAvailable(<cloud provider>) === true
 *   - If any gate fails the router returns the best available LOCAL route.
 *
 * M128: routeTask — difficulty/type/cost/quota-aware model routing for the fleet.
 *   Called by fleet/router.ts to enrich RouteDecision with a concrete model.
 *   Uses model-catalog.ts, quota.ts, subscription-usage.ts to pick the optimal
 *   model for a WorkItem given a cfg.foundry.routingPolicy.
 *
 * Never throws — on any error returns a safe local fallback RouteDecision.
 * No auto-download. No side-effects.
 */

import type { AshlrConfig, EscalationReason, RouteDecision, WorkItem } from '../types.js';
import { getProviderRegistry } from '../providers.js';
import { estCostUsd } from './budget.js';
import {
  KNOWN_MODELS,
  pickModel,
  type ModelEntry,
  type ModelCapability,
} from './model-catalog.js';
import { withinLimit } from '../fleet/quota.js';
import { subscriptionAllows } from '../fleet/subscription-usage.js';
import type { EngineId } from '../types.js';
// M195: read RESOLVED engine tier (honors cfg.foundry.nim frontier promotion).
// Imported from the registry (not sandboxed-engine.ts) to avoid an import cycle.
import { resolveEngineSpec } from './engine-registry.js';

// ---------------------------------------------------------------------------
// Cloud provider env-key map — detection only, values are NEVER read/logged.
// ---------------------------------------------------------------------------

const CLOUD_PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cohere: 'COHERE_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  nvidia_nim: 'NVIDIA_NIM_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  hermes_api: 'HERMES_API_KEY',
};

/** Known local (zero-cost) provider ids. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

/**
 * Returns true iff `provider` is a known cloud provider
 * (i.e. not a local provider).
 */
function isCloudProvider(id: string): boolean {
  return !LOCAL_PROVIDERS.has(id.toLowerCase());
}

// ---------------------------------------------------------------------------
// Public: cloudKeyAvailable
// ---------------------------------------------------------------------------

/**
 * Returns true iff the conventional API-key env var for `provider` is present
 * and non-empty. Detection only — the value is NEVER read, returned, or logged.
 */
export function cloudKeyAvailable(provider: string): boolean {
  const envVar = CLOUD_PROVIDER_ENV[provider.toLowerCase()];
  if (!envVar) return false;
  const val = process.env[envVar];
  return typeof val === 'string' && val.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Public: wouldBeCloudCost
// ---------------------------------------------------------------------------

/**
 * Estimate the USD cost that `tokensIn`/`tokensOut` would have incurred on a
 * representative cloud provider (Anthropic mid-tier). This is an ESTIMATE only,
 * used for the "would-have-been-cloud" savings display — never used for billing.
 *
 * Reuses budget.ts `estCostUsd` with provider='anthropic'.
 */
export function wouldBeCloudCost(tokensIn: number, tokensOut: number): number {
  return estCostUsd('anthropic', tokensIn, tokensOut);
}

// ---------------------------------------------------------------------------
// Internal helpers (M15)
// ---------------------------------------------------------------------------

/**
 * Pick the best local model from a list of available model names.
 * Mirrors the heuristic in provider-client.ts (small/fast preferred; skip
 * embedding-only models; slight bias for coder models).
 * Returns 'default' for an empty list (safe fallback).
 */
function pickBestLocalModel(models: string[]): string {
  if (models.length === 0) return 'default';

  const isEmbed = (m: string) => /embed|bge|e5|nomic/i.test(m);
  const pool = models.filter((m) => !isEmbed(m));
  const ranked = (pool.length ? pool : models).slice();

  const sizeOf = (m: string): number => {
    const b = m.match(/(\d+(?:\.\d+)?)\s*b\b/i);
    if (b) return parseFloat(b[1]);
    if (/mini|small|tiny|nano|phi/i.test(m)) return 3;
    return 999;
  };
  const score = (m: string): number => sizeOf(m) - (/coder|code/i.test(m) ? 0.5 : 0);
  ranked.sort((a, b) => score(a) - score(b));
  return ranked[0];
}

/**
 * Return the first cloud provider from `chain` that has a key available.
 * Returns null when no cloud provider in the chain has a key.
 */
function pickCloudProvider(chain: string[]): string | null {
  for (const id of chain) {
    if (isCloudProvider(id) && cloudKeyAvailable(id)) {
      return id;
    }
  }
  return null;
}

/**
 * Derive a cloud model label from a provider id.
 * Used only in the reason string — never affects routing logic.
 */
function defaultCloudModel(provider: string): string {
  const models: Record<string, string> = {
    anthropic: 'claude-3-5-haiku',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-1.5-flash',
    cohere: 'command-r',
    groq: 'llama3-8b-8192',
    mistral: 'mistral-small',
    azure: 'gpt-4o-mini',
    nvidia_nim: 'meta/llama-3.1-70b-instruct',
    moonshot: 'kimi-k2-0711-preview',
    kimi: 'kimi-k2-0711-preview',
    hermes_api: 'nousresearch/hermes-3-llama-3.1-70b',
  };
  return models[provider.toLowerCase()] ?? provider;
}

// ---------------------------------------------------------------------------
// M128: routeTask — fleet-level model routing
// ---------------------------------------------------------------------------

/**
 * The routing policy that controls how routeTask balances cost vs quality.
 *  'balanced' (DEFAULT) — free-local for bulk, reserve strong models for hard
 *                          tasks, cheap-cloud for medium.
 *  'cost'     — default to free-local + cheapest that meets difficulty, escalate
 *               only when local is unavailable or task is hard.
 *  'quality'  — best model for the task regardless of cost.
 */
export type RoutingPolicy = 'balanced' | 'cost' | 'quality';

/**
 * The result of routing a WorkItem to a specific {engine, model}.
 * Extends the existing engine-level decision with a concrete model id and the
 * routing policy reasoning.
 */
export interface TaskRouteDecision {
  /** The fleet engine chosen. */
  engine: EngineId;
  /**
   * The concrete model tag to pass as opts.model.
   * This is the model portion of the catalog id (after `<engine>:`).
   * E.g. 'opus', 'gpt-5.5', 'qwen2.5:72b'.
   * Null means "use the engine default / no override".
   */
  model: string | null;
  /** Full catalog entry for the chosen model, or null if no catalog match. */
  catalogEntry: ModelEntry | null;
  /** Short human-readable rationale for the command-center Routing panel. */
  reason: string;
}

/**
 * Context passed to routeTask about what engines are actually available.
 * Mirrors the availability check in fleet/router.ts.
 */
export interface RoutingContext {
  /** Engines that are both in allowedBackends AND pass engineInstalled(). */
  availableEngines: EngineId[];
}

// Thresholds (mirror fleet/router.ts so they stay in sync)
const FRONTIER_EFFORT_THRESHOLD = 4;
const FRONTIER_SCORE_THRESHOLD = 8;

/** True when a WorkItem is "hard" by effort/score/source. */
function isHardItem(item: WorkItem): boolean {
  if ((item.source as string) === 'escalation') return true;
  const effort = typeof item.effort === 'number' ? item.effort : 3;
  const score = typeof item.score === 'number' ? item.score : 3;
  return effort >= FRONTIER_EFFORT_THRESHOLD || score >= FRONTIER_SCORE_THRESHOLD;
}

/** True when a WorkItem is trivial (effort 1, score ≤ 3). */
function isTrivialItem(item: WorkItem): boolean {
  const effort = typeof item.effort === 'number' ? item.effort : 3;
  const score = typeof item.score === 'number' ? item.score : 3;
  return effort <= 1 && score <= 3;
}

/** Capability required by a WorkItem's source type. */
function capabilityForSource(source: string): ModelCapability | null {
  switch (source) {
    case 'todo':
    case 'lint':
    case 'self':
      return 'coder';
    case 'security':
    case 'issue':
    case 'goal':
      return 'reasoning';
    case 'feature':
      return 'coder';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// M164: Substantive-source detection
// ---------------------------------------------------------------------------

/**
 * M164: Sources that are inherently high-value / substantive and should be
 * routed to frontier under the 'quality' policy (or as a default override when
 * the source is substantive regardless of policy).
 *
 * 'feature' is included for forward-compatibility (not yet in WorkSource type
 * but expected soon).
 */
export const SUBSTANTIVE_SOURCES = new Set([
  'issue',
  'goal',
  'security',
  'feature',
  'invent',
]);

/**
 * M164: Returns true when the item is "substantive" — i.e. should be routed to
 * a frontier model when quality policy is active or when the source alone
 * qualifies for frontier routing.
 *
 * An item is substantive when ANY of the following hold:
 *  - source ∈ SUBSTANTIVE_SOURCES
 *  - effort >= FRONTIER_EFFORT_THRESHOLD (hard)
 *  - score >= FRONTIER_SCORE_THRESHOLD (hard)
 *  - localizedScope.fileCount > 5 OR localizedScope.symbolCount > 20
 */
export function isSubstantiveItem(item: WorkItem): boolean {
  if (SUBSTANTIVE_SOURCES.has(item.source as string)) return true;
  if (isHardItem(item)) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = (item as any).localizedScope as
    | { fileCount?: number; symbolCount?: number }
    | undefined;
  if ((scope?.fileCount ?? 0) > 5 || (scope?.symbolCount ?? 0) > 20) return true;
  return false;
}

/**
 * M164: Pick the preferred frontier engine for a substantive item.
 *
 * Strategy:
 *  - source ∈ {issue, goal, security} → reasoning-heavy → prefer claude:opus
 *  - source ∈ {feature, todo, lint, self} → implementation-heavy → prefer codex:gpt-5.5
 *  - effort >= FRONTIER_EFFORT_THRESHOLD with cap=coder → prefer codex
 *  - otherwise → prefer claude:opus (safer for unknown types)
 */
function preferredFrontierEngine(item: WorkItem): 'claude' | 'codex' {
  const src = item.source as string;
  if (src === 'issue' || src === 'goal' || src === 'security') return 'claude';
  if (src === 'feature' || src === 'self' || src === 'todo' || src === 'lint') return 'codex';
  // High-effort items with coder cap → codex; else claude
  const cap = capabilityForSource(src);
  if (cap === 'coder') return 'codex';
  return 'claude';
}

/**
 * True when `engine` is allowed, within quota, and subscription window is open.
 * Never throws.
 */
function engineAvailable(engine: EngineId, cfg: AshlrConfig, ctx: RoutingContext): boolean {
  // When ctx.availableEngines is absent (e.g. ctx={}), treat all engines as
  // available — a missing list is a permissive default, not a block-all.
  const avail = ctx.availableEngines ?? null;
  if (avail !== null && !avail.includes(engine)) return false;
  try {
    if (!withinLimit(engine, cfg)) return false;
    const sub = subscriptionAllows(engine, { cfg });
    if (!sub.allowed) return false;
  } catch {
    // fail-open: if quota/subscription checks throw, treat engine as available
  }
  return true;
}

/**
 * Extract the model tag from a catalog id (the part after `<engine>:`).
 * E.g. 'claude:opus' → 'opus', 'local-coder:qwen2.5:72b' → 'qwen2.5:72b'.
 */
function modelTagFrom(catalogId: string): string {
  const colonIdx = catalogId.indexOf(':');
  return colonIdx === -1 ? catalogId : catalogId.slice(colonIdx + 1);
}

/**
 * Pick the best available model for a given engine from the catalog,
 * filtered by capability and sorted by the policy.
 */
function pickForEngine(
  engine: EngineId,
  capability: ModelCapability | null,
  preferCheap: boolean,
  effort: number,
): ModelEntry | null {
  return pickModel({
    engine,
    capability: capability ?? undefined,
    maxEffort: effort,
    preferCheap,
  });
}

/**
 * Route a WorkItem to a concrete {engine, model}, respecting difficulty, source
 * type, cost policy, and quota/subscription availability.
 *
 * Fallback chain: preferred → same-tier alt → free local → builtin.
 * Never throws; always returns a decision (engine='builtin', model=null as last resort).
 *
 * This is called by fleet/router.ts AFTER it has already determined the engine
 * tier. It enriches the decision with model granularity.
 */
export function routeTask(
  item: WorkItem,
  cfg: AshlrConfig,
  ctx: RoutingContext,
): TaskRouteDecision {
  try {
    const policy: RoutingPolicy =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((cfg.foundry as any)?.routingPolicy as RoutingPolicy | undefined) ?? 'balanced';

    const effort = typeof item.effort === 'number' ? item.effort : 3;
    const score = typeof item.score === 'number' ? item.score : 3;
    const hard = isHardItem(item);
    const trivial = isTrivialItem(item);
    const cap = capabilityForSource(item.source);

    const preferCheap = policy === 'cost';
    const preferQuality = policy === 'quality';

    // ── Helpers ──────────────────────────────────────────────────────────

    const available = (e: EngineId) => engineAvailable(e, cfg, ctx);

    /** Attempt to pick a model on a given engine; return null if unavailable. */
    const tryEngine = (
      engine: EngineId,
      capability: ModelCapability | null,
      overrideReason: string,
    ): TaskRouteDecision | null => {
      if (!available(engine)) return null;
      // Check cfg.foundry.models override first (operator explicit preference)
      const cfgModel = cfg.foundry?.models?.[engine] ?? null;
      if (cfgModel) {
        // Find catalog entry for the configured model
        const entry =
          KNOWN_MODELS.find((m) => m.engine === engine && m.id.endsWith(':' + cfgModel)) ?? null;
        return {
          engine,
          model: cfgModel,
          catalogEntry: entry,
          reason: `${overrideReason} (cfg override → ${cfgModel})`,
        };
      }
      const entry = pickForEngine(engine, capability, preferCheap && !preferQuality, effort);
      if (!entry) {
        // Engine available but no matching catalog entry — return engine with null model
        return { engine, model: null, catalogEntry: null, reason: overrideReason };
      }
      return {
        engine,
        model: modelTagFrom(entry.id),
        catalogEntry: entry,
        reason: overrideReason,
      };
    };

    // ── Strategy ─────────────────────────────────────────────────────────

    // M164: QUALITY-POLICY SUBSTANTIVE FAST-PATH
    // When routingPolicy === 'quality' AND the item is substantive (high-value
    // source, high effort/score, or large localizedScope), route immediately to
    // the appropriate frontier engine with a descriptive reason.
    //
    // This runs before all other routing logic so that substantive items never
    // fall through to medium/balanced paths on quality policy.
    //
    // IMPORTANT: we use effort=5 when picking the frontier model so that the
    // effort cap never filters out the strongest model (e.g. claude:opus has
    // minEffort=3; a medium-effort substantive item must still get opus).
    const substantive = isSubstantiveItem(item);
    if (preferQuality && substantive) {
      const frontierEngine = preferredFrontierEngine(item);
      const altEngine: 'claude' | 'codex' = frontierEngine === 'claude' ? 'codex' : 'claude';
      const cap164 = capabilityForSource(item.source as string);
      const reasonPrefix = `substantive ${item.source} (effort ${effort}, score ${score}) → quality policy`;

      // tryEngineFrontier: like tryEngine but uses effort=5 so minEffort caps
      // never filter out the flagship model (opus / gpt-5.5).
      const tryFrontier = (
        engine: EngineId,
        capability: ModelCapability | null,
        reason: string,
      ): TaskRouteDecision | null => {
        if (!available(engine)) return null;
        const cfgModel = cfg.foundry?.models?.[engine] ?? null;
        if (cfgModel) {
          const entry =
            KNOWN_MODELS.find((m) => m.engine === engine && m.id.endsWith(':' + cfgModel)) ?? null;
          return { engine, model: cfgModel, catalogEntry: entry, reason: `${reason} (cfg override → ${cfgModel})` };
        }
        // Use effort=5 to bypass minEffort filtering — we always want the strongest model.
        const entry = pickForEngine(engine, capability, false, 5);
        if (!entry) return { engine, model: null, catalogEntry: null, reason };
        return { engine, model: modelTagFrom(entry.id), catalogEntry: entry, reason };
      };

      // Primary frontier engine
      const primary = tryFrontier(
        frontierEngine,
        cap164,
        `${reasonPrefix} → ${frontierEngine}-${frontierEngine === 'claude' ? 'opus (reasoning/architecture)' : 'gpt-5.5 (implementation)'}`,
      );
      if (primary) return primary;

      // Alternate frontier engine (quota/subscription fallback)
      const alt = tryFrontier(
        altEngine,
        cap164,
        `${reasonPrefix} → ${altEngine} (primary frontier rate-limited, fallback)`,
      );
      if (alt) return alt;

      // Both frontiers unavailable (quota exhausted) → fall to local with warning
      const localFallback = tryEngine(
        'local-coder' as EngineId,
        cap164,
        `${reasonPrefix} → local-coder (both frontiers quota-exhausted, cascade fallback)`,
      );
      if (localFallback) return localFallback;
    }

    // 0. ESCALATION is always hard regardless of effort/score — check before trivial
    const isEscalation = (item.source as string) === 'escalation';

    // 1. TRIVIAL items: cheapest capable model (local-small / haiku)
    // Skip trivial fast-path for escalation items — they must go to frontier.
    if (trivial && policy !== 'quality' && !isEscalation) {
      // Try local small first (free)
      const localSmall = tryEngine(
        'local-coder' as EngineId,
        null,
        `trivial task (effort ${effort}, score ${score}) → local-small (free)`,
      );
      if (localSmall) return localSmall;

      // Try haiku (cheapest Claude)
      const haiku = available('claude')
        ? (() => {
            const entry = KNOWN_MODELS.find((m) => m.id === 'claude:haiku');
            if (!entry) return null;
            return {
              engine: 'claude' as EngineId,
              model: 'haiku',
              catalogEntry: entry,
              reason: `trivial task (effort ${effort}, score ${score}) → claude:haiku`,
            };
          })()
        : null;
      if (haiku) return haiku;
    }

    // 2. HARD items: strongest available model
    if (hard || preferQuality) {
      const hardLabel = `hard task (effort ${effort}, score ${score}, source=${item.source})`;

      // Hard coding → codex:gpt-5.5 preferred; else claude:opus
      if (cap === 'coder' || item.source === 'todo' || item.source === 'lint' || item.source === 'self') {
        const codex = tryEngine('codex', 'coder', `${hardLabel} → codex:gpt-5.5 (coding)`);
        if (codex) return codex;
        const opus = tryEngine('claude', 'reasoning', `${hardLabel} → claude:opus (fallback, coding)`);
        if (opus) return opus;
      }

      // Hard reasoning / security / architecture → opus or deepseek-r1
      if (cap === 'reasoning' || item.source === 'security' || item.source === 'issue') {
        const opus = tryEngine('claude', 'reasoning', `${hardLabel} → claude:opus (reasoning)`);
        if (opus) return opus;
        const deepseek = tryEngine(
          'local-coder' as EngineId,
          'reasoning',
          `${hardLabel} → deepseek-r1:32b (local reasoning)`,
        );
        if (deepseek) return deepseek;
      }

      // Any hard item: try frontier in order
      const claudeHard = tryEngine('claude', null, `${hardLabel} → claude (hard)`);
      if (claudeHard) return claudeHard;
      const codexHard = tryEngine('codex', null, `${hardLabel} → codex (hard)`);
      if (codexHard) return codexHard;

      // M195: NIM as frontier ammo (e.g. Kimi K2) — only when 'nim' is
      // config-promoted to frontier (cfg.foundry.nim.tier='frontier'). Gated on
      // the RESOLVED tier so a default-mid nim is NOT pulled into the frontier
      // hard-path (it is still routed via the mid/bulk paths below, unchanged).
      if (resolveEngineSpec('nim' as EngineId, cfg)?.tier === 'frontier') {
        const nimHard = tryEngine('nim' as EngineId, null, `${hardLabel} → nim (frontier ammo, e.g. Kimi K2)`);
        if (nimHard) return nimHard;
      }

      // Frontier unavailable — fall to local 72b
      const local72b = tryEngine(
        'local-coder' as EngineId,
        null,
        `${hardLabel} → local qwen2.5:72b (frontier unavailable)`,
      );
      if (local72b) return local72b;
    }

    // 2.5. BULK source types (dep/doc) in cost/balanced → always prefer free local
    // These sources never need frontier models and should consume zero budget.
    const isBulkSource = item.source === 'dep' || item.source === 'doc';
    if (isBulkSource && policy !== 'quality') {
      const localBulkEarly = tryEngine(
        'local-coder' as EngineId,
        null,
        `bulk source (${item.source}) → local free (balanced/cost policy)`,
      );
      if (localBulkEarly) return localBulkEarly;
    }

    // 3. MEDIUM tasks (effort 2–3): balanced selection
    {
      const medLabel = `medium task (effort ${effort}, source=${item.source})`;

      if (policy === 'cost') {
        // cost policy: prefer free local → cheap cloud
        const localCoder = tryEngine(
          'local-coder' as EngineId,
          cap,
          `${medLabel} → local coder (cost policy)`,
        );
        if (localCoder) return localCoder;

        // cheapest NIM
        const nim = tryEngine('nim' as EngineId, cap, `${medLabel} → nim (cost policy)`);
        if (nim) return nim;

        // claude:sonnet as cheap cloud
        const sonnet = available('claude')
          ? (() => {
              const entry = KNOWN_MODELS.find((m) => m.id === 'claude:sonnet');
              if (!entry) return null;
              return {
                engine: 'claude' as EngineId,
                model: 'sonnet',
                catalogEntry: entry,
                reason: `${medLabel} → claude:sonnet (cost policy, medium)`,
              };
            })()
          : null;
        if (sonnet) return sonnet;
      } else if (policy === 'balanced') {
        // balanced: free-local for coding bulk; sonnet/codex for general medium
        if (cap === 'coder' || item.source === 'todo' || item.source === 'lint') {
          const localCoder = tryEngine(
            'local-coder' as EngineId,
            'coder',
            `${medLabel} → local qwen2.5-coder:32b (bulk coding, free)`,
          );
          if (localCoder) return localCoder;
        }

        // General medium: sonnet
        const sonnet = available('claude')
          ? (() => {
              const entry = KNOWN_MODELS.find((m) => m.id === 'claude:sonnet');
              if (!entry) return null;
              return {
                engine: 'claude' as EngineId,
                model: 'sonnet',
                catalogEntry: entry,
                reason: `${medLabel} → claude:sonnet (balanced medium)`,
              };
            })()
          : null;
        if (sonnet) return sonnet;

        // Try codex for coding tasks
        const codex = tryEngine('codex', cap, `${medLabel} → codex (balanced medium)`);
        if (codex) return codex;

        // Local 72b for mid when cloud unavailable
        const local = tryEngine(
          'local-coder' as EngineId,
          cap,
          `${medLabel} → local qwen2.5:72b (balanced medium, cloud unavailable)`,
        );
        if (local) return local;
      } else {
        // quality: pick strongest available
        const claude = tryEngine('claude', cap, `${medLabel} → claude (quality policy)`);
        if (claude) return claude;
        const codex = tryEngine('codex', cap, `${medLabel} → codex (quality policy)`);
        if (codex) return codex;
        const local = tryEngine('local-coder' as EngineId, cap, `${medLabel} → local (quality policy)`);
        if (local) return local;
      }
    }

    // 4. Bulk / dep / doc tasks: free local
    {
      const bulkLabel = `bulk task (source=${item.source}, effort ${effort})`;
      const localBulk = tryEngine(
        'local-coder' as EngineId,
        cap,
        `${bulkLabel} → local (free)`,
      );
      if (localBulk) return localBulk;

      const nim = tryEngine('nim' as EngineId, null, `${bulkLabel} → nim fallback`);
      if (nim) return nim;

      const frontier = tryEngine('claude', null, `${bulkLabel} → claude fallback (no local)`);
      if (frontier) return frontier;

      const codex = tryEngine('codex', null, `${bulkLabel} → codex fallback`);
      if (codex) return codex;
    }

    // 5. Last resort: builtin
    return {
      engine: 'builtin',
      model: null,
      catalogEntry: null,
      reason: `no external engine available+within-quota → builtin (source=${item.source})`,
    };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      engine: 'builtin',
      model: null,
      catalogEntry: null,
      reason: `routeTask error (${detail}) → builtin fallback`,
    };
  }
}

// ---------------------------------------------------------------------------
// M155: Cheap-first cascade — decision types, shouldEscalate, escalationRate
// ---------------------------------------------------------------------------

/**
 * Tier ordering for escalation purposes.
 * 'local' < 'mid' < 'frontier' — each step up is one escalation hop.
 */
const ESCALATION_TIER_ORDER: readonly string[] = ['local', 'mid', 'frontier'];

/**
 * Which tier a TaskRouteDecision's engine belongs to for cascade purposes.
 *
 * M195: cfg-aware. When a cfg is supplied it reads the RESOLVED tier from the
 * engine registry (engineTierOf), so a config-promoted 'nim' (cfg.foundry.nim
 * .tier='frontier', running Kimi K2) is correctly treated as frontier in the
 * cascade. Without a cfg it falls back to the static pre-M195 mapping
 * (builtin/local-coder/nim → local/mid, else frontier) for byte-identical
 * behaviour on the legacy callers that don't thread a cfg.
 */
function engineTierLabel(engine: EngineId, cfg?: AshlrConfig): 'local' | 'mid' | 'frontier' {
  if (cfg) {
    const tier = resolveEngineSpec(engine, cfg)?.tier;
    if (tier === 'frontier' || tier === 'mid' || tier === 'local') return tier;
  }
  if (engine === 'builtin') return 'local';
  if ((engine as string) === 'local-coder' || (engine as string) === 'nim') return 'mid';
  return 'frontier';
}

/**
 * The result of a cascade-first routing decision.
 * Extends TaskRouteDecision with cascade metadata so the orchestrator
 * knows whether this is attempt-1 (cheap-first) or a re-dispatch.
 */
export interface CascadeDecision extends TaskRouteDecision {
  /**
   * Attempt number: 1 = cheap-first, 2+ = escalated.
   * Always 1 when cascade is OFF (flag-off path).
   */
  attempt: number;
  /**
   * True when this decision was forced to the cheapest capable tier
   * (cascade ON and difficulty is low/mid) rather than the normally
   * selected tier.
   */
  cheapFirst: boolean;
  /**
   * The tier label for this decision ('local'|'mid'|'frontier').
   * Derived from `engine` for quick comparisons without re-importing engine maps.
   */
  tierLabel: 'local' | 'mid' | 'frontier';
}

/**
 * The result of shouldEscalate: whether the orchestrator should re-dispatch
 * this task at a higher tier and why.
 *
 * WHERE THE ORCHESTRATOR SHOULD CALL THIS:
 *   After each cheap-first attempt completes, before marking a task done:
 *
 *   ```ts
 *   const firstDecision = routeTask(item, cfg, ctx);  // attempt 1
 *   const taskResult = await runEngine(firstDecision, item);
 *   const esc = shouldEscalate(taskResult, firstDecision);
 *   if (esc.escalate) {
 *     const escalatedDecision = routeTask(item, cfg, ctx, esc.toTier, 2);
 *     const finalResult = await runEngine(escalatedDecision, item);
 *   }
 *   ```
 *
 * Record each decision (escalated or not) in the run ledger so
 * `escalationRate()` can track the metric.
 */
export interface EscalationSignal {
  /** True when the orchestrator should re-dispatch at a higher tier. */
  escalate: boolean;
  /**
   * The tier to escalate to when escalate=true.
   * Null when escalate=false or already at frontier.
   */
  toTier: 'mid' | 'frontier' | null;
  /** Human-readable reason for the escalation (or non-escalation) decision. */
  reason: string;
}

/**
 * The minimal shape of a task result needed to decide whether to escalate.
 * Deliberately kept narrow — the orchestrator fills this from its run record.
 */
export interface TaskResult {
  /** Whether the run produced a non-empty diff. */
  hasDiff: boolean;
  /** Whether automated tests passed (null = not run / unknown). */
  testsPassed: boolean | null;
  /**
   * Optional judge verdict ('ok' | 'noise' | 'harmful' | 'uncertain').
   * When absent, verdict check is skipped.
   */
  judgeVerdict?: 'ok' | 'noise' | 'harmful' | 'uncertain';
  /** Whether the diff/patch applied cleanly (null = not checked). */
  applySucceeded: boolean | null;
}

/**
 * M155: Decide whether a cheap-first attempt should be escalated to the next
 * tier based on OBJECTIVE failure signals only (never pure confidence).
 *
 * Escalation triggers (any one is sufficient):
 *  - Tests failed:  testsPassed === false
 *  - Empty diff:    hasDiff === false
 *  - Apply failed:  applySucceeded === false
 *  - Judge noise/harmful: judgeVerdict === 'noise' | 'harmful'
 *
 * Escalation is CAPPED at frontier (max 2 hops: local→mid→frontier).
 * A task already at frontier is never escalated further.
 *
 * @param result    The objective result of the cheap-first attempt.
 * @param decision  The CascadeDecision that produced this result (used for tier cap).
 */
export function shouldEscalate(result: TaskResult, decision: CascadeDecision): EscalationSignal {
  const currentTierIdx = ESCALATION_TIER_ORDER.indexOf(decision.tierLabel);
  const atFrontier = decision.tierLabel === 'frontier';

  // ── Cap check: already at frontier → never escalate ───────────────────────
  if (atFrontier || currentTierIdx < 0) {
    return {
      escalate: false,
      toTier: null,
      reason: `already at frontier tier (${decision.engine}) — no further escalation`,
    };
  }

  // ── Hop cap: max 2 hops (attempt 1→2, 2→3); attempt 3+ at frontier ─────────
  // attempt is 1-based; max hops = 2 means we allow attempt 1 and 2 as cheap,
  // and the final escalation target is attempt 3 = frontier (capped at index 2).
  const maxAttempts = 3; // attempt 1 (local), 2 (mid), 3 (frontier)
  if (decision.attempt >= maxAttempts) {
    return {
      escalate: false,
      toTier: null,
      reason: `escalation cap reached (attempt ${decision.attempt} >= ${maxAttempts}) — no further escalation`,
    };
  }

  // ── Evaluate objective failure signals ─────────────────────────────────────
  const failures: string[] = [];

  if (result.testsPassed === false) {
    failures.push('tests-failed');
  }
  if (!result.hasDiff) {
    failures.push('empty-diff');
  }
  if (result.applySucceeded === false) {
    failures.push('apply-failed');
  }
  if (result.judgeVerdict === 'noise' || result.judgeVerdict === 'harmful') {
    failures.push(`judge-${result.judgeVerdict}`);
  }

  if (failures.length === 0) {
    // Clean pass — no escalation needed.
    return {
      escalate: false,
      toTier: null,
      reason: `cheap attempt passed all checks (no escalation signals)`,
    };
  }

  // ── Determine target tier: one hop up from current ─────────────────────────
  const nextTierIdx = Math.min(currentTierIdx + 1, ESCALATION_TIER_ORDER.length - 1);
  const nextTier = ESCALATION_TIER_ORDER[nextTierIdx] as 'local' | 'mid' | 'frontier';

  // If stepping up would leave us at the same tier (shouldn't happen, but guard),
  // or the next tier is the same, cap at frontier.
  const toTier: 'mid' | 'frontier' = nextTier === 'local' ? 'mid' : nextTier;

  return {
    escalate: true,
    toTier,
    reason: `escalating ${decision.tierLabel}→${toTier}: signals=[${failures.join(',')}] on attempt ${decision.attempt}`,
  };
}

/**
 * A single entry in the cascade run ledger (persisted by the orchestrator).
 * Minimal — only what escalationRate() needs to compute the metric.
 */
export interface CascadeRunEntry {
  /** The task id. */
  taskId: string;
  /** The attempt number (1 = cheap-first, 2+ = escalated). */
  attempt: number;
  /** True when this attempt was followed by an escalation. */
  escalated: boolean;
  /** ISO timestamp (for future windowing). */
  ts: string;
}

/**
 * M155: Compute the escalation rate from a run ledger slice.
 *
 * Returns the fraction of first attempts (attempt===1) that were escalated.
 * Expects 7–10% in a well-tuned fleet; >15% suggests the cheap-first tier is
 * underfit for the task mix; <5% suggests over-escalation is rare but
 * cheap-first may not be selecting the cheapest tier correctly.
 *
 * @param entries  The cascade run ledger (read-only; typically from decisions-ledger.ts).
 * @returns        { rate, firstAttempts, escalatedCount } — rate is 0 when no data.
 */
export function escalationRate(entries: readonly CascadeRunEntry[]): {
  rate: number;
  firstAttempts: number;
  escalatedCount: number;
} {
  const firstAttempts = entries.filter((e) => e.attempt === 1);
  const escalatedCount = firstAttempts.filter((e) => e.escalated).length;
  const rate = firstAttempts.length === 0 ? 0 : escalatedCount / firstAttempts.length;
  return { rate, firstAttempts: firstAttempts.length, escalatedCount };
}

// ---------------------------------------------------------------------------
// M155: Cascade-aware routeTask wrapper
// ---------------------------------------------------------------------------

/**
 * Cheap-first difficulty threshold: items with effort <= this value are
 * considered low/mid difficulty and get the cheap-first treatment when
 * cascade is ON. Hard items (effort > threshold OR isHardItem()) bypass
 * cheap-first and route to the normally-selected tier.
 */
const CASCADE_CHEAP_EFFORT_THRESHOLD = 3;

/**
 * M155 cascade-aware routeTask.
 *
 * When cfg.foundry.cascade === true:
 *   - Attempt 1 for low/mid-difficulty tasks routes to the cheapest capable
 *     tier (local if available; else mid). Hard items are unaffected.
 *   - Attempt 2+ (escalation re-dispatch) respects `forceTier` to route to
 *     the tier determined by shouldEscalate().
 *   - Wraps the base routeTask result in a CascadeDecision.
 *
 * When cfg.foundry.cascade is absent/false:
 *   - Delegates byte-identically to the base routeTask, with attempt=1 and
 *     cheapFirst=false always (flag-off parity).
 *
 * Optional M154 localized-scope signal: if `item` has a
 * `(item as any).localizedScope` with `fileCount` and/or `symbolCount`, the
 * cheap-first decision uses those as an additional difficulty input — a large
 * localized scope (fileCount > 5 or symbolCount > 20) nudges toward skipping
 * the cheap-first step.
 *
 * @param item       The work item to route.
 * @param cfg        Full AshlrConfig.
 * @param ctx        RoutingContext (available engines).
 * @param forceTier  When set, override the tier to this (used for escalation re-dispatch).
 * @param attempt    Attempt number (1-based; default 1).
 */
export function routeTaskCascade(
  item: WorkItem,
  cfg: AshlrConfig,
  ctx: RoutingContext,
  forceTier?: 'local' | 'mid' | 'frontier',
  attempt = 1,
): CascadeDecision {
  // ── Flag gate ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cascadeEnabled = (cfg.foundry as any)?.cascade === true;

  if (!cascadeEnabled) {
    // FLAG-OFF: delegate byte-identically to the base routeTask.
    const base = routeTask(item, cfg, ctx);
    return {
      ...base,
      attempt: 1,
      cheapFirst: false,
      tierLabel: engineTierLabel(base.engine, cfg),
    };
  }

  // ── Escalation re-dispatch: honor forceTier ────────────────────────────────
  if (forceTier !== undefined) {
    // Build a context filtered to only engines at the requested tier.
    // M195: 'nim' appears under BOTH mid and frontier — its EFFECTIVE tier is
    // resolved per-cfg by engineTierLabel/routeTask, so listing it here only
    // makes it a CANDIDATE for that tier; a non-frontier-promoted nim won't be
    // selected as frontier (its resolved tier stays 'mid').
    const tierEngines: Record<string, EngineId[]> = {
      local: ['builtin' as EngineId],
      mid: ['local-coder' as EngineId, 'nim' as EngineId],
      frontier: ['claude' as EngineId, 'codex' as EngineId, 'nim' as EngineId],
    };
    const preferredEngines = tierEngines[forceTier] ?? [];
    // Narrow context to requested tier engines still in availableEngines.
    const filteredEngines = preferredEngines.filter((e) => ctx.availableEngines.includes(e));
    const escalatedCtx: RoutingContext = {
      availableEngines:
        filteredEngines.length > 0
          ? [...filteredEngines, ...(ctx.availableEngines.filter((e) => !preferredEngines.includes(e)))]
          : ctx.availableEngines,
    };
    const base = routeTask(item, cfg, escalatedCtx);
    return {
      ...base,
      attempt,
      cheapFirst: false,
      tierLabel: engineTierLabel(base.engine, cfg),
    };
  }

  // ── Cheap-first decision ───────────────────────────────────────────────────
  const effort = typeof item.effort === 'number' ? item.effort : 3;
  const hard = isHardItem(item);

  // M154 localized-scope signal (tolerate absence).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localizedScope = (item as any).localizedScope as
    | { fileCount?: number; symbolCount?: number }
    | undefined;
  const largeScope =
    (localizedScope?.fileCount ?? 0) > 5 || (localizedScope?.symbolCount ?? 0) > 20;

  // Hard items or large-scope items bypass cheap-first → normal routing.
  if (hard || largeScope) {
    const base = routeTask(item, cfg, ctx);
    return {
      ...base,
      attempt,
      cheapFirst: false,
      tierLabel: engineTierLabel(base.engine, cfg),
    };
  }

  // Low/mid difficulty: prefer the cheapest capable tier (local → mid).
  const cheapCtx: RoutingContext = {
    // Put local engines first to bias routeTask's "available" ordering toward free local.
    availableEngines: [
      ...ctx.availableEngines.filter(
        (e) => engineTierLabel(e, cfg) === 'local' || engineTierLabel(e, cfg) === 'mid',
      ),
      ...ctx.availableEngines.filter((e) => engineTierLabel(e, cfg) === 'frontier'),
    ],
  };

  // Use 'cost' policy to steer routeTask toward free local; wrap over the item's
  // own policy so quality-policy items still get cheap-first on low effort.
  // We achieve this by temporarily projecting a cost-preferring config slice.
  const cheapCfg: AshlrConfig = {
    ...cfg,
    foundry: {
      ...cfg.foundry,
      // Bias toward cost/local for cheap-first attempt; cap effort signal at threshold
      // so routeTask's hard-item fast-path doesn't fire.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      routingPolicy: effort <= CASCADE_CHEAP_EFFORT_THRESHOLD ? 'cost' : (cfg.foundry as any)?.routingPolicy ?? 'balanced',
    } as AshlrConfig['foundry'],
  };

  const base = routeTask(item, cheapCfg, cheapCtx);
  const tierLabel = engineTierLabel(base.engine, cfg);

  return {
    ...base,
    attempt,
    cheapFirst: tierLabel !== 'frontier', // cheapFirst only when we actually landed below frontier
    tierLabel,
  };
}

// ---------------------------------------------------------------------------
// M15: chooseRoute (unchanged, preserved exactly)
// ---------------------------------------------------------------------------

/**
 * Choose the provider + model for a single task attempt.
 *
 * LOCAL-FIRST: the default return is always a local RouteDecision (tier
 * 'local'). A cloud route is returned ONLY when ALL three gates hold:
 *   - opts.allowCloud === true
 *   - opts.lastReason !== 'none'
 *   - cloudKeyAvailable(<cloud provider from chain>) === true
 *
 * Routing-rule application (cfg.models.routing):
 *   The first rule whose `match` string appears (case-insensitive substring)
 *   in taskGoal wins and sets the preferred model. The preferred model is
 *   applied to whichever LOCAL provider is active; it does NOT force a cloud
 *   provider on its own.
 *
 * Never throws — returns a safe 'local-fallback' RouteDecision on any error.
 */
export async function chooseRoute(
  taskGoal: string,
  cfg: AshlrConfig,
  opts: { allowCloud: boolean; attempt: number; lastReason: EscalationReason },
): Promise<RouteDecision> {
  try {
    // ------------------------------------------------------------------
    // 1. Check escalation gates — cloud is ONLY reachable when all hold.
    // ------------------------------------------------------------------
    const mayEscalate =
      opts.allowCloud &&
      opts.lastReason !== 'none';

    if (mayEscalate) {
      const cloudProvider = pickCloudProvider(cfg.models.providerChain);
      if (cloudProvider !== null) {
        // All three gates passed — return a cloud escalation route.
        const cloudModel = defaultCloudModel(cloudProvider);
        return {
          provider: cloudProvider,
          model: cloudModel,
          tier: 'cloud',
          reason: `escalated to cloud (${cloudProvider}/${cloudModel}) after ${opts.lastReason} on attempt ${opts.attempt}; --allow-cloud set and key present`,
        };
      }
      // allowCloud + real reason, but no cloud key available → fall through to local.
    }

    // ------------------------------------------------------------------
    // 2. Resolve the best available LOCAL provider via the registry.
    // ------------------------------------------------------------------
    const registry = await getProviderRegistry(cfg);

    // Walk the chain for the first UP local provider.
    let activeLocalId: string | null = null;
    let activeModels: string[] = [];

    for (const providerId of registry.chain) {
      if (isCloudProvider(providerId)) continue; // skip cloud entries in chain
      const endpoint = registry.providers.find((p) => p.id === providerId);
      if (endpoint?.up) {
        activeLocalId = providerId;
        activeModels = endpoint.models;
        break;
      }
    }

    // Failover: if the chain yielded nothing, take any up local endpoint.
    if (activeLocalId === null) {
      for (const endpoint of registry.providers) {
        if (!isCloudProvider(endpoint.id) && endpoint.up) {
          activeLocalId = endpoint.id;
          activeModels = endpoint.models;
          break;
        }
      }
    }

    // ------------------------------------------------------------------
    // 3. Apply routing rules (cfg.models.routing) to pick a preferred model.
    //    Rules only affect model selection — they never force a cloud route.
    // ------------------------------------------------------------------
    let preferredModel: string | null = null;
    let ruleMatchReason = '';

    if (cfg.models.routing && cfg.models.routing.length > 0) {
      const goalLower = taskGoal.toLowerCase();
      for (const rule of cfg.models.routing) {
        if (goalLower.includes(rule.match.toLowerCase())) {
          preferredModel = rule.model;
          ruleMatchReason = `routing rule "${rule.match}" → model "${rule.model}"; `;
          break;
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. No local provider available — return a safe "unavailable" local
    //    decision. Never silently escalate to cloud.
    // ------------------------------------------------------------------
    if (activeLocalId === null) {
      return {
        provider: 'local',
        model: preferredModel ?? 'default',
        tier: 'local',
        reason:
          `${ruleMatchReason}no local provider reachable; staying local (start Ollama or LM Studio, ` +
          `or pass --allow-cloud with an escalation reason to escalate)`,
      };
    }

    // ------------------------------------------------------------------
    // 5. Determine the concrete model.
    //    If a routing rule fired and that model is available → use it.
    //    Otherwise → pickBestLocalModel from the provider's model list.
    // ------------------------------------------------------------------
    let chosenModel: string;
    let modelReason: string;

    if (preferredModel !== null) {
      // Prefer the rule's model if it exists in the provider's list,
      // otherwise use it verbatim (the user explicitly chose it).
      const exists = activeModels.some(
        (m) => m.toLowerCase() === preferredModel!.toLowerCase(),
      );
      chosenModel = exists
        ? activeModels.find((m) => m.toLowerCase() === preferredModel!.toLowerCase())!
        : preferredModel;
      modelReason = `${ruleMatchReason}model from routing rule`;
    } else {
      chosenModel = pickBestLocalModel(activeModels);
      modelReason = activeModels.length > 0
        ? 'local-first default (smallest/fastest available model)'
        : 'local-first default (no models listed; using "default")';
    }

    return {
      provider: activeLocalId,
      model: chosenModel,
      tier: 'local',
      reason: `${modelReason} on ${activeLocalId}`,
    };
  } catch (err: unknown) {
    // Never throw — return a safe local fallback.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      provider: 'local',
      model: 'default',
      tier: 'local',
      reason: `router error (${detail}); safe local fallback`,
    };
  }
}

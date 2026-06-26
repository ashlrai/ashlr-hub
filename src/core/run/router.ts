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
      return 'reasoning';
    default:
      return null;
  }
}

/**
 * True when `engine` is allowed, within quota, and subscription window is open.
 * Never throws.
 */
function engineAvailable(engine: EngineId, cfg: AshlrConfig, ctx: RoutingContext): boolean {
  if (!ctx.availableEngines.includes(engine)) return false;
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

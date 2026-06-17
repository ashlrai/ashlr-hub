/**
 * router.ts — per-task model router (M15).
 *
 * LOCAL-FIRST, NO SILENT CLOUD:
 *   - Default path is always LOCAL (Ollama / LM Studio).
 *   - A CLOUD RouteDecision is returned ONLY when ALL three gates hold:
 *       1. opts.allowCloud === true
 *       2. opts.lastReason !== 'none'  (a real escalation trigger)
 *       3. cloudKeyAvailable(<cloud provider>) === true
 *   - If any gate fails the router returns the best available LOCAL route.
 *
 * Never throws — on any error returns a safe local fallback RouteDecision.
 * No auto-download. No side-effects.
 */

import type { AshlrConfig, EscalationReason, RouteDecision } from '../types.js';
import { getProviderRegistry } from '../providers.js';
import { estCostUsd } from './budget.js';

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
// Internal helpers
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
// Public: chooseRoute
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

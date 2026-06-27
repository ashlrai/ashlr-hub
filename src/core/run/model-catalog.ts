/**
 * model-catalog.ts — M128: authoritative model roster for the autonomous fleet.
 *
 * Defines every model the fleet can route to, its engine, capability profile,
 * cost ($/M tokens, 0 for local), and the minimum effort level it is suited for.
 *
 * PURE — no I/O, no side effects. All routing logic in run/router.ts uses this
 * catalog; fleet/router.ts references it for model selection.
 *
 * MODEL IDS use a `<engine>:<model-tag>` convention so they are unambiguous
 * across engines. Local models use `local-coder:<ollama-tag>`.
 */

import type { EngineId } from '../types.js';

// ---------------------------------------------------------------------------
// Capability tags
// ---------------------------------------------------------------------------

export type ModelCapability =
  | 'fast'          // optimised for low-latency / cheap
  | 'general'       // broad competence
  | 'coder'         // code generation, refactoring, lint fixes
  | 'reasoning'     // chain-of-thought, architecture, security analysis
  | 'long-context'; // >=100k token context window

// ---------------------------------------------------------------------------
// Catalog entry
// ---------------------------------------------------------------------------

export interface ModelEntry {
  /** Unique catalog id: `<engine>:<model-tag>`. */
  id: string;
  /** The fleet engine this model runs on. */
  engine: EngineId;
  /**
   * Broad tier used to align model selection with engine tier.
   *  'small'   -- <=7B or dedicated fast/cheap cloud tier (haiku, gpt-mini)
   *  'mid'     -- 8-40B or cloud mid-tier (sonnet, gpt-4o)
   *  'large'   -- 70B+ or cloud frontier (opus, gpt-5.5, deepseek-r1:32b w/ long CoT)
   */
  tier: 'small' | 'mid' | 'large';
  /** USD per million input tokens (0 for local/free). */
  costPerMTokIn: number;
  /** USD per million output tokens (0 for local/free). */
  costPerMTokOut: number;
  /** What this model is good at. */
  capabilities: ModelCapability[];
  /**
   * Minimum effort level (1-5) this model is suited for.
   * Models with minEffort > 1 are skipped for trivial tasks.
   * Models with minEffort <= 1 handle everything.
   */
  minEffort: 1 | 2 | 3 | 4 | 5;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const KNOWN_MODELS: readonly ModelEntry[] = [
  // -- Claude (subscription / token-billed via API) -------------------------
  {
    id: 'claude:opus',
    engine: 'claude',
    tier: 'large',
    costPerMTokIn: 15.0,
    costPerMTokOut: 75.0,
    capabilities: ['general', 'reasoning', 'long-context'],
    minEffort: 3,
  },
  {
    id: 'claude:sonnet',
    engine: 'claude',
    tier: 'mid',
    costPerMTokIn: 3.0,
    costPerMTokOut: 15.0,
    capabilities: ['fast', 'general', 'coder'],
    minEffort: 2,
  },
  {
    id: 'claude:haiku',
    engine: 'claude',
    tier: 'small',
    costPerMTokIn: 0.25,
    costPerMTokOut: 1.25,
    capabilities: ['fast', 'general'],
    minEffort: 1,
  },

  // -- Codex / OpenAI -------------------------------------------------------
  {
    id: 'codex:gpt-5.5',
    engine: 'codex',
    tier: 'large',
    costPerMTokIn: 10.0,
    costPerMTokOut: 30.0,
    capabilities: ['general', 'coder', 'reasoning'],
    minEffort: 2,
  },

  // -- Local -- qwen2.5:72b (general large) ---------------------------------
  // M132: 'coder' capability removed. qwen2.5-coder:32b is the verified
  // coding specialist (M118 content-parse path confirmed working 2026-06-26).
  // 72b handles general / long-context / fallback; coder:32b owns all
  // pickModel({capability:'coder'}) calls on local-coder.
  {
    id: 'local-coder:qwen2.5:72b',
    engine: 'local-coder' as EngineId,
    tier: 'large',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: ['general', 'long-context'],
    minEffort: 2,
  },

  // -- Local -- qwen2.5-coder:32b (coder specialist) -----------------------
  {
    id: 'local-coder:qwen2.5-coder:32b',
    engine: 'local-coder' as EngineId,
    tier: 'mid',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: ['coder'],
    minEffort: 1,
  },

  // -- Local -- deepseek-r1:32b (reasoning / architecture) -----------------
  {
    id: 'local-coder:deepseek-r1:32b',
    engine: 'local-coder' as EngineId,
    tier: 'mid',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: ['reasoning'],
    minEffort: 2,
  },

  // -- Local -- small (catch-all tiny model for trivial tasks) --------------
  {
    id: 'local-coder:small',
    engine: 'local-coder' as EngineId,
    tier: 'small',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: ['fast', 'general'],
    minEffort: 1,
  },

  // -- NVIDIA NIM -- llama-3.1-70b -----------------------------------------
  {
    id: 'nim:meta/llama-3.1-70b-instruct',
    engine: 'nim' as EngineId,
    tier: 'large',
    costPerMTokIn: 0.97,
    costPerMTokOut: 0.97,
    capabilities: ['general', 'coder'],
    minEffort: 2,
  },

  // -- NVIDIA NIM -- llama-3.1-8b (fast/cheap NIM) -------------------------
  {
    id: 'nim:meta/llama-3.1-8b-instruct',
    engine: 'nim' as EngineId,
    tier: 'small',
    costPerMTokIn: 0.05,
    costPerMTokOut: 0.05,
    capabilities: ['fast', 'general'],
    minEffort: 1,
  },

  // =========================================================================
  // M144: 2026 local-model upgrade — llama-server engine
  // =========================================================================
  //
  // llama-server (llama.cpp) with EAGLE-3 speculative decoding + continuous
  // batching + prefix-cache delivers ~1.5-2.5x throughput vs single-slot Ollama
  // on Apple Silicon at zero quality cost.
  //
  // Engine id: 'llama-server' (api-model, OpenAI-compat at localhost:8080/v1)
  // Default base URL: http://localhost:8080/v1 (override: cfg.models.llamaServer.baseUrl)
  //
  // -- llama-server: qwen3-coder-next (2026 flagship local coder) -----------
  // qwen3-coder-next: 80B-A3B MoE (active 3B), q4 quant ~52 GB — fits 128 GB Mac.
  // Supersedes qwen2.5-coder:32b as the best local coding model (2026).
  // Context window: 128k. Capabilities: coder + long-context.
  {
    id: 'llama-server:qwen3-coder-next',
    engine: 'llama-server' as EngineId,
    tier: 'large',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: ['coder', 'long-context'],
    minEffort: 1,
  },

  // -- llama-server: qwen3-coder-30b-a3b (lighter MoE coder) ---------------
  // ~18 GB q4 — fits 24 GB GPU or 32 GB Mac. Good coder at lower memory cost.
  // Context window: 128k. Capabilities: coder.
  {
    id: 'llama-server:qwen3-coder-30b-a3b',
    engine: 'llama-server' as EngineId,
    tier: 'mid',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: ['coder'],
    minEffort: 1,
  },

  // -- llama-server: deepseek-r1-distill-70b (reasoning / judge base) ------
  // Distilled 70B dense model. Strong chain-of-thought + architecture analysis.
  // Context window: 128k. Capabilities: reasoning + long-context.
  // Use as local judge or hard-problem fallback when cloud reasoning is unavailable.
  {
    id: 'llama-server:deepseek-r1-distill-70b',
    engine: 'llama-server' as EngineId,
    tier: 'large',
    costPerMTokIn: 0,
    costPerMTokOut: 0,
    capabilities: ['reasoning', 'long-context'],
    minEffort: 2,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * All entries for a specific engine.
 */
export function catalogFor(engine: EngineId | string): ModelEntry[] {
  return KNOWN_MODELS.filter((m) => m.engine === (engine as EngineId));
}

/**
 * Cost (combined in+out at a 1:1 ratio estimate) for a catalog id.
 * Returns 0 for local/unknown models (safe default).
 */
export function costOf(id: string): number {
  const entry = KNOWN_MODELS.find((m) => m.id === id);
  if (!entry) return 0;
  return (entry.costPerMTokIn + entry.costPerMTokOut) / 2;
}

/**
 * Pick the best model from the catalog given selection criteria.
 *
 * @param opts.engine     - restrict to this engine (optional)
 * @param opts.capability - require this capability (optional)
 * @param opts.maxEffort  - task effort level; skip models with minEffort > maxEffort (optional)
 * @param opts.preferCheap - when true, sort by cost ascending; else sort by tier descending
 *
 * Returns null when no matching model exists in the catalog.
 */
export function pickModel(opts: {
  engine?: EngineId | string;
  capability?: ModelCapability;
  maxEffort?: number;
  preferCheap?: boolean;
}): ModelEntry | null {
  let pool = KNOWN_MODELS.filter((m) => {
    if (opts.engine && m.engine !== (opts.engine as EngineId)) return false;
    if (opts.capability && !m.capabilities.includes(opts.capability)) return false;
    if (opts.maxEffort !== undefined && m.minEffort > opts.maxEffort) return false;
    return true;
  });

  if (pool.length === 0) return null;

  const tierRank: Record<ModelEntry['tier'], number> = { small: 0, mid: 1, large: 2 };

  if (opts.preferCheap) {
    // Sort by total cost ascending (free first), break ties by tier ascending
    pool = [...pool].sort((a, b) => {
      const aCost = a.costPerMTokIn + a.costPerMTokOut;
      const bCost = b.costPerMTokIn + b.costPerMTokOut;
      if (aCost !== bCost) return aCost - bCost;
      return tierRank[a.tier] - tierRank[b.tier];
    });
  } else {
    // Sort by tier descending (strongest first), then cost ascending
    pool = [...pool].sort((a, b) => {
      const tierDiff = tierRank[b.tier] - tierRank[a.tier];
      if (tierDiff !== 0) return tierDiff;
      const aCost = a.costPerMTokIn + a.costPerMTokOut;
      const bCost = b.costPerMTokIn + b.costPerMTokOut;
      return aCost - bCost;
    });
  }

  return pool[0] ?? null;
}

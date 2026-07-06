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
  /**
   * M320: full provider API model id (e.g. 'claude-sonnet-5'). Used for CLI
   * --model dispatch of Claude 5 entries, mergeAuthority matching, and
   * telemetry key normalization (canonicalModelTag). Absent ⇒ the catalog tag
   * (after ':') is used verbatim (legacy behavior).
   */
  apiModelId?: string;
  /**
   * M320: quality rank within an engine (higher = more capable). Drives the
   * pickModel preferStrong sort (quality policy). Absent ⇒ derived from tier.
   */
  qualityRank?: number;
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
    // M320: corrected to Opus 4.8 sticker pricing ($5/$25 per MTok — the old
    // 15/75 predates the 4.x price cuts and skewed cost estimates 3x high).
    costPerMTokIn: 5.0,
    costPerMTokOut: 25.0,
    capabilities: ['general', 'reasoning', 'long-context'],
    minEffort: 3,
    apiModelId: 'claude-opus-4-8',
    qualityRank: 4,
  },
  {
    id: 'claude:sonnet',
    engine: 'claude',
    tier: 'mid',
    costPerMTokIn: 3.0,
    costPerMTokOut: 15.0,
    capabilities: ['fast', 'general', 'coder'],
    minEffort: 2,
    // M320: pinned legacy generation. Dispatch still sends the bare 'sonnet'
    // tag — this id only anchors canonicalModelTag / telemetry mapping.
    apiModelId: 'claude-sonnet-4-6',
    qualityRank: 2,
  },
  {
    id: 'claude:haiku',
    engine: 'claude',
    tier: 'small',
    // M320: corrected to Haiku 4.5 sticker pricing ($1/$5 per MTok).
    costPerMTokIn: 1.0,
    costPerMTokOut: 5.0,
    capabilities: ['fast', 'general'],
    minEffort: 1,
    apiModelId: 'claude-haiku-4-5',
    qualityRank: 1,
  },

  // -- Claude 5 generation (M320) -------------------------------------------
  // Sonnet 5: frontier-class coding at mid cost — the fleet's generation
  // workhorse once M321 routing lands. Large tier + cheapest-large means the
  // default pickModel sort prefers it over Opus automatically — but ONLY for
  // callers that opt in via claude5ExcludeIds(cfg); every legacy pickModel
  // call site excludes these ids by default (see pickModel excludeIds).
  {
    id: 'claude:sonnet-5',
    engine: 'claude',
    tier: 'large',
    costPerMTokIn: 3.0,
    costPerMTokOut: 15.0,
    capabilities: ['fast', 'general', 'coder', 'reasoning', 'long-context'],
    minEffort: 2,
    apiModelId: 'claude-sonnet-5',
    qualityRank: 3,
  },
  // Fable 5: Mythos-class tier ABOVE Opus — judge/strategist material.
  // minEffort 5 keeps it out of every default generation path; it is reachable
  // only via the quality fast-path at effort 5 or explicit config. Priced
  // above Opus, so it must never become an accidental workhorse.
  {
    id: 'claude:fable-5',
    engine: 'claude',
    tier: 'large',
    costPerMTokIn: 10.0,
    costPerMTokOut: 50.0,
    capabilities: ['general', 'reasoning', 'long-context', 'coder'],
    minEffort: 5,
    apiModelId: 'claude-fable-5',
    qualityRank: 5,
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
  /** M320: sort by qualityRank desc (strongest first), then cost asc. */
  preferStrong?: boolean;
  /**
   * M320: catalog ids to exclude. DEFAULT: the Claude 5 ids — callers must
   * opt in via claude5ExcludeIds(cfg) to route the new generation, so every
   * pre-M320 call site stays byte-identical without changes.
   */
  excludeIds?: ReadonlySet<string>;
}): ModelEntry | null {
  const excluded = opts.excludeIds ?? CLAUDE5_CATALOG_IDS;
  let pool = KNOWN_MODELS.filter((m) => {
    if (excluded.has(m.id)) return false;
    if (opts.engine && m.engine !== (opts.engine as EngineId)) return false;
    if (opts.capability && !m.capabilities.includes(opts.capability)) return false;
    if (opts.maxEffort !== undefined && m.minEffort > opts.maxEffort) return false;
    return true;
  });

  if (pool.length === 0) return null;

  const tierRank: Record<ModelEntry['tier'], number> = { small: 0, mid: 1, large: 2 };

  if (opts.preferStrong) {
    // M320: strongest first (qualityRank desc, tier-derived fallback), then
    // cost ascending — the quality-policy sort. Fable 5 (5) > Opus (4) >
    // Sonnet 5 (3) > unranked large (3, costlier loses) > mid > small.
    const qualityOf = (m: ModelEntry): number => m.qualityRank ?? tierRank[m.tier] + 1;
    pool = [...pool].sort((a, b) => {
      const qDiff = qualityOf(b) - qualityOf(a);
      if (qDiff !== 0) return qDiff;
      const aCost = a.costPerMTokIn + a.costPerMTokOut;
      const bCost = b.costPerMTokIn + b.costPerMTokOut;
      return aCost - bCost;
    });
  } else if (opts.preferCheap) {
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

// ---------------------------------------------------------------------------
// M320: Claude 5 generation — ids, flags, canonical spelling
// ---------------------------------------------------------------------------

/** Full provider API ids for the Claude 5 rollout (M320). */
export const CLAUDE5_SONNET_API_ID = 'claude-sonnet-5';
export const CLAUDE5_FABLE_API_ID = 'claude-fable-5';
export const CLAUDE_OPUS_API_ID = 'claude-opus-4-8';

/** Catalog ids introduced by M320 — excluded from pickModel unless opted in. */
export const CLAUDE5_CATALOG_IDS: ReadonlySet<string> = new Set([
  'claude:sonnet-5',
  'claude:fable-5',
]);

const EMPTY_EXCLUDES: ReadonlySet<string> = new Set();
const FABLE_ONLY_EXCLUDES: ReadonlySet<string> = new Set(['claude:fable-5']);

/** Minimal structural view of cfg — keeps this module dependency-light/PURE. */
type Claude5Cfg = { foundry?: { claude5?: { enabled?: boolean; fable?: boolean } } };

/** M320 master switch. Absent ⇒ enabled. false ⇒ pre-M320 byte-identical. */
export function claude5Enabled(cfg?: Claude5Cfg): boolean {
  return cfg?.foundry?.claude5?.enabled !== false;
}

/** Fable 5 as judge/strategist default. Requires claude5Enabled. Absent ⇒ on. */
export function fableEnabled(cfg?: Claude5Cfg): boolean {
  return claude5Enabled(cfg) && cfg?.foundry?.claude5?.fable !== false;
}

/**
 * The excludeIds set a Claude5-aware caller passes to pickModel:
 * claude5 off ⇒ both new ids excluded (pre-M320 byte-identical);
 * fable off ⇒ only fable-5 excluded; otherwise nothing excluded.
 */
export function claude5ExcludeIds(cfg?: Claude5Cfg): ReadonlySet<string> {
  if (!claude5Enabled(cfg)) return CLAUDE5_CATALOG_IDS;
  if (!fableEnabled(cfg)) return FABLE_ONLY_EXCLUDES;
  return EMPTY_EXCLUDES;
}

/**
 * M320: single source of truth for the strategist default model
 * (comms/director.ts, vision/strategist.ts, comms/elon-dialogue.ts — this
 * ends the triple-maintained constant). Fable 5 when claude5.fable is on,
 * else Opus 4.8. cfg.foundry.strategistModel always overrides at call sites.
 */
export function defaultStrategistModel(cfg?: Claude5Cfg): string {
  return fableEnabled(cfg) ? CLAUDE5_FABLE_API_ID : CLAUDE_OPUS_API_ID;
}

/**
 * Map any spelling of a model to its canonical catalog tag for `engine`:
 *   'sonnet-5' | 'claude-sonnet-5' | 'claude:sonnet-5' | 'claude:claude-sonnet-5'
 * all → 'sonnet-5'. Unknown strings are returned with the engine prefix
 * stripped. Used by the merge-authority gate (M320) and telemetry key
 * normalization (M322/M323) so spelling variants never split a key.
 */
export function canonicalModelTag(
  engine: EngineId | string,
  model: string | null | undefined,
): string {
  if (!model) return '';
  let tag = model.trim();
  const prefix = `${String(engine)}:`;
  while (tag.startsWith(prefix)) tag = tag.slice(prefix.length);
  for (const m of KNOWN_MODELS) {
    if (m.engine !== (engine as EngineId)) continue;
    const mTag = m.id.slice(m.id.indexOf(':') + 1);
    if (tag === mTag || (m.apiModelId !== undefined && tag === m.apiModelId)) return mTag;
  }
  return tag;
}

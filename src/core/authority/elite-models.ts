/**
 * Elite models — "elite self-land" (3.15, Mason's decision of 2026-09-27).
 *
 * THE single source of truth for which producer models may land their own
 * work without an LLM judge. When the producing run's signed identity
 * (`proposal.engineModel`, `<engine>:<model>`, host-signed provenance) names
 * an elite model AND the live grant's current rollout stage is
 * `elite-direct` (a stage Mason signed with Touch ID), gate G6 is satisfied
 * by deterministic verification instead of a judge: the repo's own tests in
 * the mirror (G3, exact tree bound), claim-vs-diff (G4), and on GitHub the
 * App's host-verified `ashlr/verify` check plus every required check (G7).
 * Everything that is NOT an LLM opinion still applies unchanged: Stop,
 * holds, the daily cap, size/risk caps, protected paths (Tier-1 work always
 * goes to the owner lane), test-tamper refusal, and the post-merge watch
 * with automatic revert.
 *
 * Matching rules (fail closed):
 *  - The ENGINE prefix carries the identity. A bare model id (no engine), an
 *    engine this table does not list for the model (a local runtime serving
 *    a model named after a vendor, the per-token Grok API engine), or any
 *    model id not listed exactly is NOT elite.
 *  - Model ids are compared lowercased, with a trailing context tag such as
 *    `[1m]` removed. Nothing else is normalized: `claude:opus` and
 *    `claude:sonnet` resolve to Claude 4.x in the fleet catalog
 *    (run/model-catalog.ts), so version-less aliases are never elite.
 *  - `llama-server` is deliberately absent from the local engines: it serves
 *    whatever weights it loaded, whatever tag the record carries
 *    (local-runtime/llama/config.ts), so its recorded tag proves nothing.
 *
 * Configuration can only NARROW this list (invariant I3: config tightens,
 * never widens): `foundry.autoMerge.eliteModels` = an array of entry ids
 * keeps only those, `false` or `[]` turns elite self-land off. Widening it
 * means editing this file — a Tier-1 path (authority/**) the fleet can never
 * change; it goes to Mason's owner lane and CODEOWNERS.
 *
 * PURE and import-free at runtime, so it adds nothing to the authority
 * surface's import closure beyond itself.
 */

/** The reserved rollout-stage id that turns elite self-land on while it is the CURRENT stage. */
export const ELITE_DIRECT_STAGE_ID = 'elite-direct';

/** The G6 row code for a pass on deterministic verification (no judge). */
export const ELITE_DIRECT_G6_CODE = 'elite-direct';

/** One line for setup / re-approve / the Touch ID sheet. */
export const ELITE_DIRECT_ONE_LINE =
  'Elite direct: work by an elite model (Opus 5.5/5, Fable 5.1/5, Sonnet 5, GPT-6 Astra/Sol/Luna, Grok 4.7/4.6, SWE-2, Qwen 3.8 27B) '
  + 'lands on green tests with no judge; other models still need an independent judge, and Tier-1 changes still go to you.';

export type EliteVendor = 'anthropic' | 'openai' | 'xai' | 'cognition' | 'qwen';

export interface EliteModelEntry {
  /** Stable id — what `foundry.autoMerge.eliteModels` narrows by. */
  id: string;
  /** Human name for the UI ("Landed directly · elite model GPT-6 Sol · tests green"). */
  label: string;
  vendor: EliteVendor;
  /** Execution-engine prefixes (the signed identity's `<engine>`) that may run it. */
  engines: readonly string[];
  /** Model ids exactly as those engines record them (lowercase). */
  ids: readonly string[];
}

/** Claude Code / Anthropic engines (fleet `claude-cli` records `claude:<model>`). */
const ANTHROPIC_ENGINES = ['claude', 'claude-cli', 'anthropic'] as const;
/** Codex CLI / OpenAI engines. */
const OPENAI_ENGINES = ['codex', 'openai'] as const;
/**
 * The SuperGrok seat engine only. The per-token API engine (`grok:`) never
 * carries merge authority (engine-registry M298) and is not elite either.
 */
const XAI_ENGINES = ['grok-cli'] as const;
/** Devin: the cloud intake (`devin:`) and the local CLI adapter (`devin-cli:`). */
const DEVIN_ENGINES = ['devin', 'devin-cli'] as const;
/** Local runtimes that request the model by tag per call (never llama-server — see header). */
const LOCAL_ENGINES = ['local', 'local-coder', 'ollama'] as const;

/** Effort suffixes GPT-6 ids carry in Devin's catalog (`gpt-6-sol-high`) and some Codex configs. */
const GPT6_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function gpt6Ids(name: string): string[] {
  const base = `gpt-6-${name}`;
  return [base, ...GPT6_EFFORTS.map((effort) => `${base}-${effort}`)];
}

/**
 * The allowlist. Each id string below is one an engine in this repo actually
 * records or passes on argv:
 *  - Claude: verse/model-windows.ts VERSE_CLAUDE_MODEL_SPECS, run/model-catalog.ts
 *    CLAUDE5_* (`claude:claude-sonnet-5`, `claude:sonnet-5`, `claude:fable-5`);
 *    `claude-opus-5.5` is the retired dotted alias that actually ran Opus 5
 *    (verse/context-math.ts), so it is listed under Opus 5.
 *  - GPT-6: verse/model-windows.ts CODEX_DOCUMENTED_MODELS (`gpt-6-astra`,
 *    `gpt-6-sol`, `gpt-6-luna`); Devin's catalog adds effort suffixes.
 *  - Grok: run/model-catalog.ts GROK_CLI_DEFAULT_MODEL / GROK_CLI_FAST_MODEL
 *    (`grok-4.7`, `grok-4.7-build-fast`), the seat's models_cache
 *    (`grok-4.6`), and `grok-4.6-build` (how the CLI reports 4.6 usage).
 *  - SWE-2: `devin models list` names (`swe-2`, `swe-2-high|medium|max`) and
 *    the CLI family alias `swe` (verse/devin-seats.ts).
 *  - Qwen 3.8 27B: run/model-catalog.ts DEFAULT_LOCAL_MODEL_TAG
 *    (`qwen3.8:27b-ctx64k`) and the other tags seen (`qwen3.8:27b`,
 *    `qwen3.8:27b-q8_0`).
 */
const ELITE_MODEL_TABLE: readonly EliteModelEntry[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', vendor: 'anthropic', engines: [...ANTHROPIC_ENGINES, ...DEVIN_ENGINES], ids: ['claude-opus-5-5', 'opus-5-5'] },
  { id: 'claude-opus-5', label: 'Claude Opus 5', vendor: 'anthropic', engines: [...ANTHROPIC_ENGINES, ...DEVIN_ENGINES], ids: ['claude-opus-5', 'opus-5', 'claude-opus-5.5'] },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', vendor: 'anthropic', engines: [...ANTHROPIC_ENGINES, ...DEVIN_ENGINES], ids: ['claude-fable-5-1', 'fable-5-1'] },
  { id: 'claude-fable-5', label: 'Claude Fable 5', vendor: 'anthropic', engines: [...ANTHROPIC_ENGINES, ...DEVIN_ENGINES], ids: ['claude-fable-5', 'fable-5'] },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vendor: 'anthropic', engines: [...ANTHROPIC_ENGINES, ...DEVIN_ENGINES], ids: ['claude-sonnet-5', 'sonnet-5'] },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', vendor: 'openai', engines: [...OPENAI_ENGINES, ...DEVIN_ENGINES], ids: gpt6Ids('astra') },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', vendor: 'openai', engines: [...OPENAI_ENGINES, ...DEVIN_ENGINES], ids: gpt6Ids('sol') },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', vendor: 'openai', engines: [...OPENAI_ENGINES, ...DEVIN_ENGINES], ids: gpt6Ids('luna') },
  { id: 'grok-4.7', label: 'Grok 4.7', vendor: 'xai', engines: [...XAI_ENGINES], ids: ['grok-4.7', 'grok-4.7-build-fast'] },
  { id: 'grok-4.6', label: 'Grok 4.6', vendor: 'xai', engines: [...XAI_ENGINES], ids: ['grok-4.6', 'grok-4.6-build'] },
  { id: 'swe-2', label: 'SWE-2', vendor: 'cognition', engines: [...DEVIN_ENGINES], ids: ['swe-2', 'swe-2-high', 'swe-2-medium', 'swe-2-max', 'swe'] },
  { id: 'qwen3.8-27b', label: 'Qwen 3.8 27B', vendor: 'qwen', engines: [...LOCAL_ENGINES], ids: ['qwen3.8:27b', 'qwen3.8:27b-ctx64k', 'qwen3.8:27b-q8_0'] },
];

export const ELITE_MODELS: readonly EliteModelEntry[] = Object.freeze(ELITE_MODEL_TABLE.map((entry): EliteModelEntry =>
  Object.freeze({ ...entry, engines: Object.freeze([...entry.engines]), ids: Object.freeze([...entry.ids]) })));

export const ELITE_MODEL_IDS: readonly string[] = Object.freeze(ELITE_MODELS.map((entry) => entry.id));

export interface EliteModelMatch {
  entry: EliteModelEntry;
  /** The engine prefix, lowercased. */
  engine: string;
  /** The model id as matched (lowercased, context tag removed). */
  model: string;
}

/** `claude-opus-4-8[1m]` → `claude-opus-4-8`; everything else is compared as-is. */
function normalizeModelId(model: string): string {
  return model.replace(/\[[0-9a-z]+\]$/u, '');
}

/**
 * PURE: the elite entry for a signed producer identity, or null. `allow`
 * (from config) narrows the list: null / undefined = every compiled entry.
 */
export function matchEliteModel(
  engineModel: unknown,
  allow?: readonly string[] | null,
): EliteModelMatch | null {
  if (typeof engineModel !== 'string') return null;
  const normalized = engineModel.trim().toLowerCase();
  if (!normalized || normalized.length > 200) return null;
  const colon = normalized.indexOf(':');
  const slash = normalized.indexOf('/');
  const separator = colon < 0 ? slash : slash < 0 ? colon : Math.min(colon, slash);
  // A bare id has no execution identity: never elite.
  if (separator < 1) return null;
  const engine = normalized.slice(0, separator);
  const model = normalizeModelId(normalized.slice(separator + 1));
  if (!model) return null;
  for (const entry of ELITE_MODELS) {
    if (allow && !allow.includes(entry.id)) continue;
    if (entry.engines.includes(engine) && entry.ids.includes(model)) return { entry, engine, model };
  }
  return null;
}

/**
 * The config narrowing (`foundry.autoMerge.eliteModels`): null = the whole
 * compiled list; [] = elite self-land off; otherwise the listed ids that the
 * compiled list knows (an unknown id is ignored — config never widens).
 * A mangled value is ignored like every other mangled tighten-only key.
 */
export function eliteModelAllowFromConfig(cfg: unknown): readonly string[] | null {
  if (!cfg || typeof cfg !== 'object') return null;
  const foundry = (cfg as Record<string, unknown>)['foundry'];
  if (!foundry || typeof foundry !== 'object') return null;
  const autoMerge = (foundry as Record<string, unknown>)['autoMerge'];
  if (!autoMerge || typeof autoMerge !== 'object') return null;
  const value = (autoMerge as Record<string, unknown>)['eliteModels'];
  if (value === false) return [];
  if (!Array.isArray(value)) return null;
  return value.filter((id): id is string => typeof id === 'string' && ELITE_MODEL_IDS.includes(id));
}

/**
 * Is elite self-land in force under this live policy — is the CURRENT rollout
 * stage the signed `elite-direct` rung? The switch is not consulted here: with
 * the switch at Propose an elite change still skips the judge, and its PR is
 * held for Mason by the ordinary withhold (mergeWithheldBecause).
 */
export function eliteDirectInForce(policy: { rollout: { stageId: string } } | null | undefined): boolean {
  return policy !== null && policy !== undefined && policy.rollout.stageId === ELITE_DIRECT_STAGE_ID;
}

/** Does this signed grant carry an `elite-direct` stage anywhere on its ladder? */
export function grantHasEliteDirect(grant: { rollout: { stages: readonly { id: string }[] } }): boolean {
  return grant.rollout.stages.some((stage) => stage.id === ELITE_DIRECT_STAGE_ID);
}

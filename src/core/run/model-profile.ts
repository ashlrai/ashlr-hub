/**
 * model-profile.ts — M41 model-adaptive capability profiles.
 *
 * Local models vary wildly: a 1.5B chat model and a 32B coder need very
 * different scaffolding. A ModelProfile bundles the knobs that should adapt to
 * the model actually serving a task — prompt verbosity, tool-call format,
 * step cap, sampling temperature, and a prompt/context size budget.
 *
 * Resolution is by model-NAME pattern only (zero I/O, fully deterministic and
 * testable), reusing the exact size/coder vocabulary already used by
 * provider-client.pickModel and router.pickBestLocalModel so detection stays
 * consistent across the codebase.
 *
 * EVERYTHING here is additive and gated: profiles only take effect when
 * adaptive prompts are enabled (adaptivePromptsEnabled). With the flag off the
 * harness behaves exactly as before.
 */

import type { AshlrConfig } from '../types.js';

export type PromptVerbosity = 'terse' | 'standard' | 'rich';

/**
 * How a model best receives tool intent.
 *  - 'native': provider tool API (tool_calls) — capable models.
 *  - 'json':   ask for a JSON tool-call block in content — weak/small models
 *              that fumble native tool calling but can emit structured text.
 *  - 'none':   no tools (no-tool contract only).
 */
export type ToolFormat = 'native' | 'json' | 'none';

export interface ModelProfile {
  /** Stable profile id (e.g. 'coder', 'general', 'small', 'default'). */
  id: string;
  /** Prompt verbosity tier — selects the layer variant during assembly. */
  verbosity: PromptVerbosity;
  /** Preferred tool-call format. */
  toolFormat: ToolFormat;
  /** Optional one-liner appended to the tool layer (e.g. JSON-block hint). */
  toolFormatHint?: string;
  /** Per-task ReAct step ceiling (overrides agent-loop TASK_STEP_CAP). */
  stepCap: number;
  /** Suggested sampling temperature (lower = more disciplined). */
  temperature: number;
  /** Hard character ceiling for the assembled system prompt. */
  promptCharCap: number;
  /** Approx context window in tokens (informs the prompt/memory budget). */
  contextTokens: number;
}

// ---------------------------------------------------------------------------
// Name-pattern vocabulary (kept in sync with provider-client / router)
// ---------------------------------------------------------------------------

/** Parse a parameter count in billions from a model name ("3b" / "7b" / "72b"). */
function sizeOf(name: string): number {
  const b = name.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (b) return parseFloat(b[1]);
  if (/mini|small|tiny|nano|phi/i.test(name)) return 3; // unlabeled small models
  return -1; // unknown size
}

/** Coder/code-specialized models that reward richer engineering discipline. */
function isCoderModel(name: string): boolean {
  return /coder|codellama|code-?llama|codegemma|codestral|starcoder|deepseek-?coder|code-/i.test(
    name,
  );
}

/** Explicitly small/weak families regardless of a labeled size. */
function isSmallName(name: string): boolean {
  return /tinyllama|tiny|nano|mini|gemma:?2b|phi-?[123]|qwen2?\.?5?:?(0\.5|1\.5|1|3)b/i.test(
    name,
  );
}

// ---------------------------------------------------------------------------
// Named profiles
// ---------------------------------------------------------------------------

const SMALL_HINT =
  'If native tool calls fail, emit ONE JSON object: {"tool":"<name>","arguments":{...}} and nothing else.';

/** Weak/small models (≤3B): tight prompt, lower step budget, JSON tool hint. */
const SMALL: ModelProfile = {
  id: 'small',
  verbosity: 'terse',
  toolFormat: 'json',
  toolFormatHint: SMALL_HINT,
  stepCap: 12,
  temperature: 0.2,
  promptCharCap: 1200,
  contextTokens: 4096,
};

/** Capable general chat models (≈4–14B). Balanced defaults. */
const GENERAL: ModelProfile = {
  id: 'general',
  verbosity: 'standard',
  toolFormat: 'native',
  stepCap: 20,
  temperature: 0.3,
  promptCharCap: 2200,
  contextTokens: 8192,
};

/** Coder-specialized or large (≥20B) models: full discipline, more headroom. */
const CODER: ModelProfile = {
  id: 'coder',
  verbosity: 'rich',
  toolFormat: 'native',
  stepCap: 28,
  temperature: 0.2,
  promptCharCap: 3200,
  contextTokens: 16384,
};

/** Fallback when the model name is unknown — behaves like GENERAL. */
export const DEFAULT_PROFILE: ModelProfile = { ...GENERAL, id: 'default' };

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a ModelProfile from a model name. Deterministic, no I/O.
 *
 * Bands (most specific first):
 *  - small  : labeled ≤3B or an explicitly-small family.
 *  - coder  : coder-specialized name, OR a large (≥20B) capable model.
 *  - general: any other recognizable chat model.
 *  - default: unknown / undefined name.
 *
 * `overrides` allows per-id shallow tuning (e.g. cfg.models.profiles['coder']).
 */
export function resolveModelProfile(
  modelName?: string,
  overrides?: Record<string, Partial<ModelProfile>>,
): ModelProfile {
  if (!modelName || modelName.trim().length === 0) {
    return applyOverride(DEFAULT_PROFILE, overrides);
  }
  const name = modelName.trim();
  const size = sizeOf(name);
  const coder = isCoderModel(name);

  let base: ModelProfile;
  if (isSmallName(name) || (size > 0 && size <= 3)) {
    base = SMALL;
  } else if (coder || (size >= 20 && size < 900)) {
    base = CODER;
  } else {
    // Recognizable mid-size chat model, or unknown size that still names a
    // known family → general. Truly unknown strings fall here too (safe).
    base = GENERAL;
  }
  return applyOverride(base, overrides);
}

function applyOverride(
  profile: ModelProfile,
  overrides?: Record<string, Partial<ModelProfile>>,
): ModelProfile {
  const o = overrides?.[profile.id];
  return o ? { ...profile, ...o } : { ...profile };
}

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Whether the M41 adaptive-prompt suite is active. Default OFF.
 *
 * Precedence: ASHLR_ADAPTIVE_PROMPTS env (1/true | 0/false) overrides config;
 * otherwise cfg.models.adaptivePrompts === true. Absent everywhere → false, so
 * the harness keeps its legacy prompts/step-cap untouched.
 */
export function adaptivePromptsEnabled(cfg?: AshlrConfig): boolean {
  const env = process.env.ASHLR_ADAPTIVE_PROMPTS?.trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'on') return true;
  if (env === '0' || env === 'false' || env === 'off') return false;
  return cfg?.models?.adaptivePrompts === true;
}

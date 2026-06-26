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
  /**
   * Per-profile engineering discipline injected by agent-loop as a final
   * system-prompt block when adaptivePrompts is enabled. Pushes model-specific
   * behaviors (e.g. complete diffs for coder models). Optional — absent means
   * no extra block.
   */
  roleHint?: string;
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

/**
 * Capable general chat models (≈4–72B, e.g. qwen2.5:72b).
 *
 * Native tool calls. Adequate step budget to handle multi-file tasks. The
 * roleHint pushes completeness — these large models tend to draft partial
 * changes and self-truncate without explicit guidance.
 */
const GENERAL: ModelProfile = {
  id: 'general',
  verbosity: 'standard',
  toolFormat: 'native',
  roleHint:
    'Engineering completeness for this task:\n' +
    '- Read the file before editing it.\n' +
    '- Write COMPLETE changes — no "// ... rest unchanged ..." truncations.\n' +
    '- Scope edits to this task only; do not touch unrelated code.\n' +
    '- Verify the change was applied correctly before reporting done.',
  stepCap: 24,
  temperature: 0.3,
  promptCharCap: 2200,
  contextTokens: 32768,
};

/**
 * Coder-specialized or large (≥20B) models (e.g. qwen2.5-coder:32b).
 *
 * Goal: complete, applyable diffs — not partial stubs. stepCap raised so the
 * model can finish the full read→edit→write→verify loop. Low temperature for
 * disciplined, deterministic edits. Context budget reflects the 32k window
 * these models typically carry.
 */
const CODER: ModelProfile = {
  id: 'coder',
  verbosity: 'rich',
  toolFormat: 'native',
  roleHint:
    'Diff-quality contract for this task:\n' +
    '- READ the file in full before editing it — never modify a file you have not read.\n' +
    '- Make COMPLETE changes: produce the entire updated function/block/file, not a ' +
    'truncated fragment or a stub with "// ... existing code ..." placeholders.\n' +
    '- Keep the change SCOPED: edit only what the task requires; do not refactor or ' +
    'rename unrelated symbols.\n' +
    '- After writing, verify by reading back the changed region and confirming the ' +
    'edit landed correctly — do not declare done on assumption.\n' +
    '- If the task requires a new file, write the complete file content in one call.\n' +
    '- Prefer small, atomic writes over large batch rewrites where the task allows.',
  stepCap: 32,
  temperature: 0.2,
  promptCharCap: 3200,
  contextTokens: 32768,
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

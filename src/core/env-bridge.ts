/**
 * env-bridge.ts — M10: Config->Env bridge
 *
 * Projects unified ~/.ashlr/config.json values into the environment of spawned
 * child processes (engine delegation, MCP gateway downstreams, ship commands)
 * so every independently-shipped ecosystem tool honours ONE config without
 * modification.
 *
 * SECURITY GUARDRAIL: this module NEVER emits secret values. Credentials are
 * phantom-owned and must only reach children via their own secret resolution.
 * The banned vars are:
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, COHERE_API_KEY,
 *   GROQ_API_KEY, and any *_API_KEY / *_SECRET / *_TOKEN pattern.
 *
 * Env-var mapping table
 * ─────────────────────────────────────────────────────────────────────────────
 * Env var(s)            Source / derivation                    Notes
 * ─────────────────────────────────────────────────────────────────────────────
 * OLLAMA_HOST           cfg.models.ollama                      Ollama base URL
 * OLLAMA_BASE_URL       cfg.models.ollama                      Alias; same value
 * LM_STUDIO_URL         cfg.models.lmstudio                    LM Studio base URL
 * OPENAI_BASE_URL       cfg.models.lmstudio                    OAI-compat endpoint;
 *                                                              NEVER the key
 * ASHLR_LLM_PROVIDER    opts.provider ?? providerChain[0]      Active provider id
 * ASHLR_PROVIDER_CHAIN  cfg.models.providerChain.join(',')     Full chain, CSV
 * ASHLR_MODEL           opts.model (when provided)             Chosen model name;
 *                                                              OMITTED if unknown
 * AC_MODEL              opts.model (when provided)             ashlrcode alias;
 *                                                              mirrors ASHLR_MODEL;
 *                                                              OMITTED if unknown
 * ASHLR_LOCAL_FIRST     constant "1"                           Local-first flag
 * ASHLR_CONFIG          CONFIG_PATH (~/.ashlr/config.json)     Unified config path
 * ASHLR_GENOME_DIR      join(CONFIG_DIR,'genome')              Hub genome store dir
 * ASHLR_ROOTS           cfg.roots.join(':')                    Colon-joined roots
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { join } from 'path';
import type { AshlrConfig } from './types.js';
import { CONFIG_DIR, CONFIG_PATH } from './config.js';

/** Options for callers that already know the active provider / model. */
export interface BuildToolEnvOpts {
  /** The resolved active provider id (e.g. 'lmstudio', 'ollama', 'anthropic'). */
  provider?: string;
  /** The chosen model name to propagate to children. */
  model?: string;
}

/**
 * Build a flat Record of ashlr-derived, NON-SECRET environment keys to merge
 * into a spawned child's environment.
 *
 * Pure and deterministic — never throws, never makes network probes.
 * Keys with empty/undefined source values are omitted from the result.
 */
export function buildToolEnv(
  cfg: AshlrConfig,
  opts?: BuildToolEnvOpts,
): Record<string, string> {
  const env: Record<string, string> = {};

  // ── Ollama endpoint ───────────────────────────────────────────────────────
  const ollamaUrl = cfg.models.ollama?.trim();
  if (ollamaUrl) {
    env['OLLAMA_HOST'] = ollamaUrl;
    env['OLLAMA_BASE_URL'] = ollamaUrl;
  }

  // ── LM Studio endpoint (OpenAI-compatible; endpoint only, never the key) ──
  const lmStudioUrl = cfg.models.lmstudio?.trim();
  if (lmStudioUrl) {
    env['LM_STUDIO_URL'] = lmStudioUrl;
    env['OPENAI_BASE_URL'] = lmStudioUrl;
  }

  // ── Active provider ───────────────────────────────────────────────────────
  const chain = cfg.models.providerChain ?? [];
  const activeProvider = opts?.provider?.trim() || chain[0]?.trim();
  if (activeProvider) {
    env['ASHLR_LLM_PROVIDER'] = activeProvider;
  }

  // ── Full provider chain ───────────────────────────────────────────────────
  if (chain.length > 0) {
    env['ASHLR_PROVIDER_CHAIN'] = chain.join(',');
  }

  // ── Model name (omitted when unknown) ─────────────────────────────────────
  const model = opts?.model?.trim();
  if (model) {
    env['ASHLR_MODEL'] = model;
    env['AC_MODEL'] = model; // ashlrcode alias
  }

  // ── Local-first flag (always "1") ─────────────────────────────────────────
  env['ASHLR_LOCAL_FIRST'] = '1';

  // ── Config path (always emitted; path-derived) ────────────────────────────
  env['ASHLR_CONFIG'] = CONFIG_PATH;

  // ── Genome store dir (always emitted; path-derived) ───────────────────────
  env['ASHLR_GENOME_DIR'] = join(CONFIG_DIR, 'genome');

  // ── Scan roots (colon-joined) ─────────────────────────────────────────────
  const roots = (cfg.roots ?? []).filter(Boolean);
  if (roots.length > 0) {
    env['ASHLR_ROOTS'] = roots.join(':');
  }

  return env;
}

/**
 * Merge ashlr-derived env vars over a base environment.
 *
 * Ashlr keys override base on collision so child tools always see the hub's
 * unified config regardless of what the parent shell has set.
 *
 * @param cfg   Loaded AshlrConfig.
 * @param base  Base env to extend (defaults to process.env).
 * @param opts  Optional provider/model hints for the child.
 * @returns     New env object safe to pass as `{ env }` to spawn/spawnSync.
 */
export function withToolEnv(
  cfg: AshlrConfig,
  base?: NodeJS.ProcessEnv,
  opts?: BuildToolEnvOpts,
): NodeJS.ProcessEnv {
  return { ...(base ?? process.env), ...buildToolEnv(cfg, opts) };
}

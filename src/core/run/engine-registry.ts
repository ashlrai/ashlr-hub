/**
 * engine-registry.ts — M50 (v5 Open Fleet): the single, declarative source of
 * truth for how every backend engine is invoked, probed, and trust-tiered.
 *
 * Before M50 these facts lived in three hand-written switches (buildEngineCommand,
 * engineInstalled, engineTierOf). M50 collapses them into one table of
 * `EngineSpec`s so that ADDING A BACKEND IS CONFIG-ONLY: a `cfg.foundry.engines`
 * entry is merged over `BUILTIN_ENGINE_REGISTRY` by `resolveEngineRegistry` and
 * picked up by the router, the containment, the gate, and the control plane with
 * no code change.
 *
 * PARITY GUARANTEE (locked by test/m50.engine-registry): `compileArgv` reproduces
 * the EXACT non-autonomous argv the pre-M50 switch produced for builtin/ashlrcode/
 * aw/claude/codex, while autonomous mode may append engine-specific unattended
 * flags required by the sandboxed fleet executor.
 *
 * GUARDRAILS:
 *  - compileArgv is PURE and injection-safe: placeholders are substituted only as
 *    WHOLE argv elements; a goal/cwd/model containing '$CWD', ';', or backticks is
 *    passed verbatim as a single element and never shell-expanded.
 *  - No implicit frontier: a malformed or tier-less added entry is DROPPED, never
 *    defaulted to a merge-authority tier.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AshlrConfig,
  ArgvSeg,
  EngineCommand,
  EngineSpec,
  EngineTier,
} from '../types.js';
import { DEFAULT_LOCAL_MODEL_TAG, GROK_CLI_DEFAULT_MODEL } from './model-catalog.js';
import { resolveNativeSeatLaunch, type NativeSeatLaunchResult } from '../resources/native-profile.js';
// The serving runtime owns where llama-server actually is; resolving it here
// as well would let dispatch and supervision disagree about the endpoint.
import {
  LEGACY_DEFAULT_BASE_URL,
  resolveLlamaServerBaseUrl,
} from '../local-runtime/llama/config.js';

// ---------------------------------------------------------------------------
// Built-in roster — encodes the five v1–v4 engines (parity-locked) plus the two
// v5 CLI agents plus three curated api-model entries (nim/kimi/openai-compat).
// New API models / agents are added via cfg.foundry.engines.
// ---------------------------------------------------------------------------

/**
 * The canonical built-in engine roster. Keyed by engine id. The five original
 * engines reproduce their pre-M50 argv byte-for-byte; `hermes` and `opencode`
 * are new v5 CLI agents (tier 'local' in M50 — M51's tri-tier promotes the strong
 * open models to 'mid'; nothing new is granted frontier/main authority here).
 *
 * M92 additions — three curated api-model entries that resolve via
 * resolveEngineRegistry but are NOT in the default allowedBackends (opt-in only).
 * Flag-off/default behavior is identical: they are available but inactive until
 * explicitly added to cfg.foundry.allowedBackends.
 *
 *   nim          — NVIDIA NIM cloud API (OpenAI-compat), tier mid
 *   kimi         — Moonshot/Kimi cloud API (OpenAI-compat), tier mid
 *   openai-compat — generic OpenAI-compatible endpoint, tier mid
 */
export const BUILTIN_ENGINE_REGISTRY: Readonly<Record<string, EngineSpec>> = Object.freeze({
  builtin: { id: 'builtin', kind: 'builtin', tier: 'local' },

  // claude -p <goal> [--model M] --output-format stream-json --verbose [--dangerously-skip-permissions --add-dir CWD when autonomous]
  // Uses the Claude Code SUBSCRIPTION (env API keys are stripped by CRED_ENV_DENY).
  // --dangerously-skip-permissions is SAFE here: we externally confine the run in
  // sandbox-exec (worktree-only writes) and every result is a PROPOSAL, never applied.
  //
  // M298: switched from --output-format json (single final blob) to
  // --output-format stream-json --verbose so the stall monitor (run-monitor.ts)
  // receives real RunEvents (content_block_start, content_block_delta, result)
  // line-by-line while the agent runs, enabling event-driven stall detection
  // instead of a blunt 30-min idle window. --verbose is required by claude CLI
  // when -p (print mode) + stream-json are combined. engines.ts normalizeRunEvent
  // and parseUsageFromLines already handle stream-json JSONL (the 'result' event
  // carries usage; content_block_start/delta carry tool_call/text events).
  claude: {
    id: 'claude',
    kind: 'cli-agent',
    tier: 'frontier',
    bin: 'claude',
    bins: ['claude'],
    // M298b: REVERTED to --output-format json. stream-json regressed the dispatch:
    // claude in `-p --output-format stream-json --verbose` returned ok=true in ~77s
    // WITHOUT executing the task (no diff, no proposal), vs 240-470s of real work in
    // json mode. Reliable dispatch >> stall-monitor progress visibility. (Stall
    // monitoring keeps working via the M291 idle/no-diff fixes.)
    argv: ['-p', '$GOAL', { optModel: ['--model', '$MODEL'] }, '--output-format', 'json'],
    autonomousArgv: ['--dangerously-skip-permissions', '--add-dir', '$CWD'],
    capabilities: ['agent', 'edit', 'architecture'],
    // M260: canonical concrete model for merge-authority resolution.
    // Must match an entry in cfg.foundry.mergeAuthority (e.g. {engine:'claude',model:'claude-opus-4-8'}).
    // Update here when the authorised Claude model changes.
    defaultModel: 'claude-opus-4-8',
  },

  // codex exec [--model M] --cd CWD --json <goal> [--dangerously-bypass-approvals-and-sandbox when autonomous]
  // Uses the Codex SUBSCRIPTION (env API keys stripped by CRED_ENV_DENY).
  codex: {
    id: 'codex',
    kind: 'cli-agent',
    tier: 'frontier',
    bin: 'codex',
    bins: ['codex'],
    argv: [
      'exec',
      { optModel: ['--model', '$MODEL'] },
      '--cd',
      '$CWD',
      '--json',
      '$GOAL',
    ],
    // yolo when autonomous: skip approvals + codex's own sandbox. SAFE because we
    // externally confine via sandbox-exec and everything is proposal-only — exactly
    // the "externally sandboxed environment" this flag is documented for.
    autonomousArgv: ['--dangerously-bypass-approvals-and-sandbox'],
    capabilities: ['agent', 'edit', 'refactor'],
    // M260: canonical concrete model for merge-authority resolution.
    // Must match an entry in cfg.foundry.mergeAuthority (e.g. {engine:'codex',model:'gpt-5.5'}).
    // Update here when the authorised Codex model changes.
    defaultModel: 'gpt-5.5',
  },

  // aw auto <goal> --cwd CWD [--model M]
  aw: {
    id: 'aw',
    kind: 'cli-agent',
    tier: 'local',
    bin: 'aw',
    bins: ['aw'],
    argv: ['auto', '$GOAL', '--cwd', '$CWD', { optModel: ['--model', '$MODEL'] }],
    capabilities: ['agent', 'edit'],
  },

  // ac --goal <goal>   (real bin is 'ac'; alias 'ashlrcode')
  // autonomous: run ac's unattended single-shot agent loop inside Ashlr's
  // external sandbox/proposal-capture path.
  ashlrcode: {
    id: 'ashlrcode',
    kind: 'cli-agent',
    tier: 'local',
    bin: 'ac',
    bins: ['ac', 'ashlrcode'],
    argv: ['--goal', '$GOAL'],
    autonomousArgv: ['--autonomous', '--dangerously-skip-permissions', '--surgical'],
    capabilities: ['agent', 'edit'],
  },

  // M50/M51: Hermes Agent (Nous Research) — a strong OPEN model. Tier 'mid':
  // branch-eligible after full verification, but never merge-authority for main.
  // hermes -z <goal> [-m M] [--yolo when autonomous]
  hermes: {
    id: 'hermes',
    kind: 'cli-agent',
    tier: 'mid',
    bin: 'hermes',
    bins: ['hermes'],
    argv: ['-z', '$GOAL', { optModel: ['-m', '$MODEL'] }],
    autonomousArgv: ['--yolo'],
    capabilities: ['agent', 'edit', 'tools'],
  },

  // M50: OpenCode ("open claw"-class). opencode run <goal> [--model M]. Config-only
  // by default (binary absent on most machines → engineInstalled returns false).
  opencode: {
    id: 'opencode',
    kind: 'cli-agent',
    tier: 'local',
    bin: 'opencode',
    bins: ['opencode'],
    argv: ['run', '$GOAL', { optModel: ['--model', '$MODEL'] }],
    capabilities: ['agent', 'edit'],
  },

  // ---------------------------------------------------------------------------
  // M92: curated api-model entries — BUILTIN but NOT in default allowedBackends.
  // Opt-in only: add the id to cfg.foundry.allowedBackends to activate.
  // All three are tier 'mid' — branch-eligible, never merge-authority for main.
  // Driven via buildOpenAICompatibleClient (provider-client.ts); no CLI argv.
  // ---------------------------------------------------------------------------

  // NVIDIA NIM — OpenAI-compatible cloud inference for NVIDIA-hosted open models.
  // Default model: meta/llama-3.1-70b-instruct (strong open model, mid tier).
  // Env: NVIDIA_NIM_API_KEY (set via: phantom add NVIDIA_NIM_API_KEY)
  // Base URL override: NVIDIA_NIM_BASE_URL
  //
  // M195: this builtin entry stays tier 'mid' (M50 invariant: no builtin entry
  // is frontier except claude/codex). To run NIM as FRONTIER-class ammo (e.g.
  // Kimi K2 — moonshotai/kimi-k2.6), set cfg.foundry.nim = { tier:
  // 'frontier', model: 'moonshotai/kimi-k2.6' }. applyNimConfig() (below)
  // folds that into the resolved 'nim' spec — so engineTierOf('nim', cfg) returns
  // 'frontier' and the routers add it to the frontier rotation, WITHOUT mutating
  // the builtin roster. Absent cfg.foundry.nim ⇒ this exact mid-tier spec.
  nim: {
    id: 'nim',
    kind: 'api-model',
    tier: 'mid',
    api: {
      envKey: 'NVIDIA_NIM_API_KEY',
      baseUrlEnv: 'NVIDIA_NIM_BASE_URL',
      defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
      defaultModel: 'meta/llama-3.1-70b-instruct',
      protocol: 'openai' as const,
    },
    capabilities: ['agent', 'edit', 'tools'],
  },

  // Moonshot/Kimi — OpenAI-compatible cloud inference (Moonshot AI).
  // Default model: kimi-k2-0711-preview (strong reasoning + long-context).
  // Env: MOONSHOT_API_KEY (set via: phantom add MOONSHOT_API_KEY)
  // Base URL override: MOONSHOT_BASE_URL
  kimi: {
    id: 'kimi',
    kind: 'api-model',
    tier: 'mid',
    api: {
      envKey: 'MOONSHOT_API_KEY',
      baseUrlEnv: 'MOONSHOT_BASE_URL',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      defaultModel: 'kimi-k2-0711-preview',
      protocol: 'openai' as const,
    },
    capabilities: ['agent', 'edit', 'architecture'],
  },

  // Generic OpenAI-compatible endpoint — bring-your-own base URL and key.
  // Covers any provider that speaks /v1/chat/completions (vLLM, Together AI,
  // Fireworks, Anyscale, local OpenAI-compat servers, etc.).
  // Env: OPENAI_COMPAT_API_KEY  Base URL: OPENAI_COMPAT_BASE_URL
  'openai-compat': {
    id: 'openai-compat',
    kind: 'api-model',
    tier: 'mid',
    api: {
      envKey: 'OPENAI_COMPAT_API_KEY',
      baseUrlEnv: 'OPENAI_COMPAT_BASE_URL',
      defaultBaseUrl: 'http://localhost:8000/v1',
      defaultModel: 'default',
      protocol: 'openai' as const,
    },
    capabilities: ['agent', 'edit'],
  },

  // ---------------------------------------------------------------------------
  // M115: local-coder — Ollama as a first-class, FREE, unlimited fleet coding
  // engine. Runs qwen2.5:72b (strong instruct model with native tool_calls) via
  // the OpenAI-compat path at http://localhost:11434/v1.
  //
  // Tier 'mid': branch-eligible after verification, NEVER merge-authority for
  // main (frontier gate enforces this — local-coder cannot satisfy the
  // engineTier === 'frontier' main-merge requirement).
  //
  // No envKey: Ollama is local/free — "installed" is determined by probing the
  // endpoint at http://localhost:11434/v1/models (engineInstalled in engines.ts
  // returns true when the probe succeeds; false when Ollama is not running).
  //
  // Default model: DEFAULT_LOCAL_MODEL_TAG (run/model-catalog.ts) — currently
  // qwen3.8:27b-ctx64k. It replaced qwen2.5:72b-instruct-q4_K_M, which was a
  // 44 GB model that hit the turn cap on 2 of 3 runs of the fixture Qwen3.8
  // passed 2/2; see that constant's doc comment for the measurement.
  // Override with cfg.foundry.models['local-coder'] = '<ollama tag>'.
  //
  // BUILTIN but NOT in default allowedBackends — activated by adding 'local-coder'
  // to cfg.foundry.allowedBackends (or the machine-local defaultConfig override).
  // ---------------------------------------------------------------------------
  'local-coder': {
    id: 'local-coder',
    kind: 'api-model',
    tier: 'mid',
    api: {
      // No envKey: Ollama requires no API key. engineInstalled probes the
      // endpoint URL instead (envKey absent → URL-probe path in engines.ts).
      envKey: '',
      baseUrlEnv: 'OLLAMA_BASE_URL',
      defaultBaseUrl: 'http://localhost:11434/v1',
      defaultModel: DEFAULT_LOCAL_MODEL_TAG,
      protocol: 'openai' as const,
    },
    capabilities: ['agent', 'edit', 'tools'],
  },

  // ---------------------------------------------------------------------------
  // llama-server — the PARALLEL local fleet engine (docs/LOCAL-FLEET.md).
  //
  // 'local-coder' above and this entry serve the same weights and differ in
  // exactly one property, which is the only one that matters for a fleet:
  // Ollama refuses to run this model architecture concurrently
  // (`model architecture does not currently support parallel requests,
  // architecture=qwen35`), so four agents queue — measured 3.7 / 7.6 / 11.4 /
  // 15.2s. llama-server serves the same GGUF across N continuous-batching
  // slots sharing ONE 27 GB copy of the weights — measured 8.6 / 8.9 / 9.0 /
  // 9.0s, all four finishing together.
  //
  // So: 'local-coder' for a single interactive turn, 'llama-server' for the
  // fleet. Both are local, free and unmetered.
  //
  // No envKey: local, no API key. `engineInstalled` probes <baseUrl>/models.
  // `defaultBaseUrl` is REPLACED below by applyLlamaServerConfig with the
  // runtime's actually-resolved endpoint, so dispatch follows a runtime that
  // was started on a non-default port instead of talking to nothing.
  //
  // Supervise it with `ashlr local-runtime start|status|stop`.
  //
  // BUILTIN but NOT in default allowedBackends — activated by adding
  // 'llama-server' to cfg.foundry.allowedBackends.
  // ---------------------------------------------------------------------------
  'llama-server': {
    id: 'llama-server',
    kind: 'api-model',
    tier: 'mid',
    api: {
      envKey: '',
      baseUrlEnv: 'LLAMA_SERVER_BASE_URL',
      defaultBaseUrl: LEGACY_DEFAULT_BASE_URL,
      defaultModel: DEFAULT_LOCAL_MODEL_TAG,
      protocol: 'openai' as const,
    },
    capabilities: ['agent', 'edit', 'tools'],
  },

  // ---------------------------------------------------------------------------
  // M298: xAI Grok — OpenAI-compatible cloud inference (xAI).
  // Default model: grok-4 (xAI flagship; strong coding + reasoning).
  // Env: XAI_API_KEY (primary) or GROK_API_KEY (alias).
  // Base URL override: XAI_BASE_URL
  //
  // Tier 'mid' by default — branch-eligible after full verification, but
  // NEVER merge-authority for main (grok is NOT in cfg.foundry.mergeAuthority
  // by default; frontier WORK-tier ≠ merge authority — M270 invariant).
  //
  // To promote grok to frontier WORK-ASSIGNMENT (route it like claude/codex)
  // without granting merge authority, set:
  //   cfg.foundry.grok = { tier: 'frontier' }
  // applyGrokConfig() (below) folds that into the resolved spec — exactly
  // parallel to applyKimiConfig/applyNimConfig. The builtin entry stays 'mid'.
  //
  // BUILTIN but NOT in default allowedBackends — activated by adding 'grok'
  // to cfg.foundry.allowedBackends.
  // ---------------------------------------------------------------------------
  grok: {
    id: 'grok',
    kind: 'api-model',
    tier: 'mid',
    api: {
      envKey: 'XAI_API_KEY',
      baseUrlEnv: 'XAI_BASE_URL',
      defaultBaseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4',
      protocol: 'openai' as const,
    },
    capabilities: ['agent', 'edit', 'architecture'],
  },

  // ---------------------------------------------------------------------------
  // V3.10 (SPEC-310B §3): grok-cli — the SuperGrok SEAT (grok-a) as a fleet
  // cli-agent. NOT the per-token `grok` api-model above, which stays mid-tier
  // and out of allowedBackends.
  //
  // Tier 'frontier': Grok 4.7 is a frontier model and the fleet routes medium/
  // high work to it. Merge authority is still gated separately (the grant's
  // repo stages + gates G0–G7); tier alone never merges anything.
  //
  // Launch: ALWAYS through the grok-a native profile — `node launcher.mjs`,
  // which execs the seat's pinned binary with a scrubbed env and GROK_HOME set
  // to the seat's native state. resolveEngineRegistry folds the launcher in
  // (applyGrokCliProfile); when the seat cannot be resolved the resolved spec
  // has NO argv, so buildEngineCommand returns null and the run fails as
  // `engine-command-missing` instead of falling back to the ambient `grok`
  // login in ~/.grok (a different identity, unmetered by the SeatRouter).
  //
  // Flags, each checked against the pinned 0.2.118 binary (clap rejects an
  // unknown flag or value with exit 2 before any inference):
  //  - --no-auto-update: the launcher leaves it to the caller; a fleet run must
  //    never replace the seat's pinned binary.
  //  - --output-format streaming-messages-json: Anthropic-wire NDJSON, the
  //    format Verse's shared parser already reads for this seat.
  //  - --permission-mode dontAsk: there is no interactive approver; acceptEdits
  //    cancels the turn on the first shell command (measured). Safe ONLY under
  //    OS confinement — autonomous runs are forced to `mode:'os'`.
  //  - --single=<goal> as ONE element ({join}): a leading-dash goal is only
  //    accepted in the `--opt=value` spelling.
  // ---------------------------------------------------------------------------
  'grok-cli': {
    id: 'grok-cli',
    kind: 'cli-agent',
    tier: 'frontier',
    // Identity for PATH probes / bin classification BEFORE the fold. The fold
    // replaces it with the profile's pinned node + launcher.
    bin: 'grok',
    bins: ['grok'],
    argv: [
      '--no-auto-update',
      '--output-format', 'streaming-messages-json',
      '--cwd', '$CWD',
      // INT4: optional like every other CLI's model flag — a bare '$MODEL'
      // compiled to `--model ''` when the caller named no model (measured on
      // the producer path). The sandboxed producer now always names one
      // (GROK_CLI_DEFAULT_MODEL), so the recorded engineModel is what ran.
      { optModel: ['--model', '$MODEL'] },
      '--permission-mode', 'dontAsk',
      { join: ['--single=', '$GOAL'] },
    ],
    capabilities: ['agent', 'edit', 'architecture'],
    defaultModel: GROK_CLI_DEFAULT_MODEL,
  },
});

// ---------------------------------------------------------------------------
// argv compilation — pure + injection-safe
// ---------------------------------------------------------------------------

const VALID_TIERS: ReadonlySet<string> = new Set<EngineTier>(['local', 'mid', 'frontier']);
const VALID_KINDS: ReadonlySet<string> = new Set(['builtin', 'cli-agent', 'api-model']);
const ENGINE_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Substitute a single template token as a WHOLE argv element (never shell-split). */
function subst(seg: string, vars: { goal: string; cwd: string; model: string }): string {
  switch (seg) {
    case '$GOAL':
      return vars.goal;
    case '$CWD':
      return vars.cwd;
    case '$MODEL':
      return vars.model;
    default:
      return seg;
  }
}

/**
 * Compile a declarative argv template into a concrete argv. `optModel` segments
 * are emitted only when a non-empty model is present. A `join` segment
 * substitutes each part as a whole token, then glues the parts into ONE
 * element (so `--single=` + a goal stays one argv element whatever the goal
 * contains). Pure; injection-safe.
 */
export function compileArgv(
  template: ArgvSeg[],
  ctx: { goal: string; cwd: string; model?: string; autonomous?: boolean },
  autonomousArgv?: ArgvSeg[],
): string[] {
  const model = ctx.model?.trim() ?? '';
  const vars = { goal: ctx.goal, cwd: ctx.cwd, model };
  const segs: ArgvSeg[] = ctx.autonomous && autonomousArgv ? [...template, ...autonomousArgv] : [...template];
  const out: string[] = [];
  for (const seg of segs) {
    if (typeof seg === 'string') {
      out.push(subst(seg, vars));
    } else if (seg && 'optModel' in seg && Array.isArray(seg.optModel)) {
      if (model.length > 0) {
        for (const s of seg.optModel) out.push(subst(s, vars));
      }
    } else if (seg && 'join' in seg && Array.isArray(seg.join)) {
      out.push(seg.join.map((s) => subst(s, vars)).join(''));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// registry resolution + lookups
// ---------------------------------------------------------------------------

/** True when an added engine spec is structurally valid (else it is dropped). */
function isValidSpec(spec: unknown): spec is EngineSpec {
  if (!spec || typeof spec !== 'object') return false;
  const s = spec as Record<string, unknown>;
  if (typeof s['id'] !== 'string' || !ENGINE_ID_RE.test(s['id'])) return false;
  if (typeof s['kind'] !== 'string' || !VALID_KINDS.has(s['kind'])) return false;
  // No implicit frontier: tier is REQUIRED and must be a known tier.
  if (typeof s['tier'] !== 'string' || !VALID_TIERS.has(s['tier'])) return false;
  return true;
}

/**
 * M195: fold a `cfg.foundry.nim` block into the resolved 'nim' EngineSpec.
 *
 * This is the high-level, typed activation surface for the NVIDIA NIM backend
 * (running Kimi K2 as frontier-tier ammo). It is purely a CONVENIENCE over
 * `cfg.foundry.engines.nim`: it lets Mason promote NIM to frontier and point it
 * at the Kimi model with a small `nim: { tier, model, baseUrl }` block instead
 * of hand-writing a full EngineSpec.
 *
 * Precedence: an explicit `cfg.foundry.engines.nim` ALWAYS wins (it has already
 * been merged into `spec` before this runs) — we only fill from cfg.foundry.nim.
 * The API KEY is never read here; only its env-var NAME flows through.
 *
 * Returns a new spec (never mutates the builtin). Absent cfg.foundry.nim ⇒ the
 * input spec is returned unchanged (byte-identical to pre-M195).
 */
function applyNimConfig(spec: EngineSpec, cfg?: AshlrConfig): EngineSpec {
  const nim = cfg?.foundry?.nim;
  if (!nim || typeof nim !== 'object' || spec.kind !== 'api-model' || !spec.api) {
    return spec;
  }
  const tier = VALID_TIERS.has(nim.tier as string) ? (nim.tier as EngineTier) : spec.tier;
  return {
    ...spec,
    tier,
    api: {
      ...spec.api,
      envKey: (typeof nim.apiKeyEnv === 'string' && nim.apiKeyEnv) || spec.api.envKey,
      defaultBaseUrl:
        (typeof nim.baseUrl === 'string' && nim.baseUrl) || spec.api.defaultBaseUrl,
      defaultModel:
        (typeof nim.model === 'string' && nim.model) || spec.api.defaultModel,
    },
  };
}

/**
 * M270: fold a `cfg.foundry.kimi` block into the resolved 'kimi' EngineSpec.
 *
 * Parallel to applyNimConfig — lets Kimi be promoted to frontier WORK-ASSIGNMENT
 * tier via `cfg.foundry.kimi = { tier: 'frontier' }` without touching the builtin
 * roster.
 *
 * SAFETY INVARIANT: this promotes the ROUTING tier only (work assignment).
 * Merge authority is SEPARATELY gated by evaluateMergeAuthority in inbox/merge.ts,
 * which requires proposal.engineModel ∈ cfg.foundry.mergeAuthority. Kimi is NOT
 * in that list by default, so a frontier-promoted Kimi will have its proposals
 * branch-eligible (not main-merge-eligible) until explicitly added to
 * cfg.foundry.mergeAuthority with a human trust decision.
 *
 * Absent cfg.foundry.kimi ⇒ input spec returned unchanged (byte-identical to pre-M270).
 */
export function applyKimiConfig(spec: EngineSpec, cfg?: AshlrConfig): EngineSpec {
  const kimi = (cfg?.foundry as Record<string, unknown> | undefined)?.['kimi'] as
    | { tier?: string; model?: string; apiKeyEnv?: string }
    | undefined;
  if (!kimi || typeof kimi !== 'object' || spec.kind !== 'api-model' || !spec.api) {
    return spec;
  }
  const tier = VALID_TIERS.has(kimi.tier as string) ? (kimi.tier as EngineTier) : spec.tier;
  return {
    ...spec,
    tier,
    api: {
      ...spec.api,
      envKey: (typeof kimi.apiKeyEnv === 'string' && kimi.apiKeyEnv) || spec.api.envKey,
      defaultModel:
        (typeof kimi.model === 'string' && kimi.model) || spec.api.defaultModel,
    },
  };
}

/**
 * M298: fold a `cfg.foundry.grok` block into the resolved 'grok' EngineSpec.
 *
 * Parallel to applyKimiConfig — lets Grok be promoted to frontier WORK-ASSIGNMENT
 * tier via `cfg.foundry.grok = { tier: 'frontier' }` without touching the builtin
 * roster.
 *
 * SAFETY INVARIANT: this promotes the ROUTING tier only (work assignment).
 * Merge authority is SEPARATELY gated by evaluateMergeAuthority in inbox/merge.ts,
 * which requires proposal.engineModel ∈ cfg.foundry.mergeAuthority. Grok is NOT
 * in that list by default, so a frontier-promoted Grok will have its proposals
 * branch-eligible (not main-merge-eligible) until explicitly added to
 * cfg.foundry.mergeAuthority with a human trust decision.
 *
 * Absent cfg.foundry.grok ⇒ input spec returned unchanged (byte-identical to pre-M298).
 */
export function applyGrokConfig(spec: EngineSpec, cfg?: AshlrConfig): EngineSpec {
  const grok = (cfg?.foundry as Record<string, unknown> | undefined)?.['grok'] as
    | { tier?: string; model?: string; apiKeyEnv?: string }
    | undefined;
  if (!grok || typeof grok !== 'object' || spec.kind !== 'api-model' || !spec.api) {
    return spec;
  }
  const tier = VALID_TIERS.has(grok.tier as string) ? (grok.tier as EngineTier) : spec.tier;
  return {
    ...spec,
    tier,
    api: {
      ...spec.api,
      envKey: (typeof grok.apiKeyEnv === 'string' && grok.apiKeyEnv) || spec.api.envKey,
      defaultModel:
        (typeof grok.model === 'string' && grok.model) || spec.api.defaultModel,
    },
  };
}

/**
 * Resolve the effective engine roster: the built-in registry with any
 * `cfg.foundry.engines` entries merged over it. Malformed added entries are
 * dropped (never fatal, never defaulted to frontier). Returns a fresh object.
 *
 * M195: after the `cfg.foundry.engines` merge, the high-level `cfg.foundry.nim`
 * block (if present) is folded into the resolved 'nim' spec via applyNimConfig —
 * letting NIM be promoted to frontier (Kimi K2 ammo) without touching the
 * builtin roster. `cfg.foundry.engines.nim` still wins (already merged above).
 */
/**
 * Point the llama-server spec at the runtime that is actually serving.
 *
 * Pure: takes a spec and a config, returns a new spec. The base URL comes from
 * the local-runtime resolver (config override > env > ownership record >
 * default), so `ashlr local-runtime start --port 8081` is enough to move the
 * whole fleet without editing an engine spec by hand.
 */
export function applyLlamaServerConfig(spec: EngineSpec, cfg?: AshlrConfig): EngineSpec {
  if (!spec.api) return spec;
  const defaultBaseUrl = resolveLlamaServerBaseUrl(cfg);
  if (defaultBaseUrl === spec.api.defaultBaseUrl) return spec;
  return { ...spec, api: { ...spec.api, defaultBaseUrl } };
}

// ---------------------------------------------------------------------------
// V3.10: grok-cli seat resolution (the grok-a native profile)
// ---------------------------------------------------------------------------

/** The registry id of the Grok seat engine. */
export const GROK_CLI_ENGINE_ID = 'grok-cli';

/**
 * `cfg.foundry.grokCli` — which seat the grok-cli engine runs on.
 *  - `seat`: the account id in `<accountsRoot>/connections.json` (the same id
 *    the SeatRouter and Verse use). Absent ⇒ the ONLY grok account; two grok
 *    accounts and no `seat` is refused as ambiguous.
 *  - `accountsRoot`: override of the roster directory. Absent ⇒
 *    `cfg.verse.accountsRoot` ⇒ `~/.ashlr/account-connections` (Verse's rule).
 */
export interface GrokCliSeatConfig {
  seat?: string;
  accountsRoot?: string;
}

function grokCliSeatConfig(cfg?: AshlrConfig): { seat: string | null; accountsRoot: string } {
  const raw = (cfg?.foundry as Record<string, unknown> | undefined)?.['grokCli'];
  const block = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const verseRoot = ((cfg as Record<string, unknown> | undefined)?.['verse'] as Record<string, unknown> | undefined)?.['accountsRoot'];
  const pick = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value : null);
  return {
    seat: pick(block['seat']),
    accountsRoot: pick(block['accountsRoot']) ?? pick(verseRoot) ?? join(homedir(), '.ashlr', 'account-connections'),
  };
}

// resolveEngineRegistry runs on hot paths (engineTierOf, routing, the local-only
// predicate), and a seat resolution is ~a dozen syscalls. A short TTL keeps it
// off the event loop's back without letting a repinned or removed profile stay
// "resolved" for long; nothing here is authority — the launcher re-checks its
// own directories and binary on every exec.
const GROK_CLI_RESOLUTION_TTL_MS = 5_000;
const grokCliResolutionCache = new Map<string, { at: number; result: NativeSeatLaunchResult }>();

/** Resolve the grok-cli seat's launcher (cached briefly). PRIVATE locators inside — never log `launch`. */
export function resolveGrokCliSeat(cfg?: AshlrConfig, nowMs: number = Date.now()): NativeSeatLaunchResult {
  const { seat, accountsRoot } = grokCliSeatConfig(cfg);
  const key = `${accountsRoot}\0${seat ?? ''}`;
  const hit = grokCliResolutionCache.get(key);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < GROK_CLI_RESOLUTION_TTL_MS) return hit.result;
  const result = resolveNativeSeatLaunch({ accountsRoot, provider: 'grok', seatId: seat });
  grokCliResolutionCache.set(key, { at: nowMs, result });
  if (grokCliResolutionCache.size > 16) grokCliResolutionCache.delete(grokCliResolutionCache.keys().next().value!);
  return result;
}

/** Test seam: forget cached seat resolutions. */
export function __resetGrokCliSeatCacheForTests(): void {
  grokCliResolutionCache.clear();
}

/**
 * Fold the resolved grok-a launcher into the grok-cli spec, or strip its argv.
 *
 * Resolved: `bin` = the profile's pinned node, argv = `[launcher.mjs, …grok
 * flags]` — the launcher then execs the pinned grok with GROK_HOME. `bins` is
 * that node path, so the local-only spawn gate (`binPermitted`, which matches
 * basenames) classifies this spawn as grok-cli (metered) rather than an
 * unclaimed binary. Every native-profile launcher is `node launcher.mjs` for a
 * CLOUD seat, so claiming `node` for a cloud engine is accurate there.
 *
 * Unresolved: no argv (buildEngineCommand → null) and no PATH probe candidates
 * (engineInstalled → false). There is deliberately no fallback to a bare
 * `grok` on PATH: that is Mason's own login, not the seat.
 */
export function applyGrokCliProfile(spec: EngineSpec, cfg?: AshlrConfig, nowMs?: number): EngineSpec {
  const resolved = resolveGrokCliSeat(cfg, nowMs);
  const { argv: templateArgv, ...rest } = spec;
  if (!resolved.ok || !templateArgv) return { ...rest, bins: [] };
  const [node, launcher] = resolved.launch.command;
  // V3.10 (INT4): the pinned binary is claimed too. Autonomous runs exec it
  // DIRECTLY (grokCliDirectCommand) — without this, the local-only spawn gate
  // (basename match) would see an unclaimed binary and permit a metered cloud
  // seat as 'free' under local-only.
  return { ...rest, bin: node, bins: [node, resolved.launch.executable], argv: [launcher, ...templateArgv] };
}

/**
 * V3.10 (INT4 — B-U2 deviation 1): the grok-cli command for an AUTONOMOUS
 * (standing-policy) run — the seat's pinned binary exec'd directly, with the
 * same flags, instead of `node launcher.mjs`.
 *
 * WHY: the launcher hard-codes GROK_HOME to the seat's REAL vendor home. Under
 * a standing policy that home is denied to agents outright; each run gets a
 * private copy (sandbox/autonomous-env.ts) whose refreshed auth.json is
 * written back only after a same-account check. Going through the launcher
 * would either fail (the profile dir is read-jailed) or, if allowed, hand
 * the agent Mason's real grok state to write. The binary is the one the
 * profile pins and the launcher itself would exec (resolveNativeSeatLaunch
 * re-validated the launcher byte for byte).
 *
 * Returns null unless `cmd` is exactly the launcher form built from this
 * seat (bin = the profile's node, args[0] = its launcher.mjs), so nothing
 * else can be rewritten into a grok exec.
 */
export function grokCliDirectCommand(
  cmd: EngineCommand,
  cfg?: AshlrConfig,
): { cmd: EngineCommand; seatId: string; nativeStatePath: string; executable: string } | null {
  const resolved = resolveGrokCliSeat(cfg);
  if (!resolved.ok) return null;
  const [node, launcher] = resolved.launch.command;
  if (cmd.bin !== node || cmd.args[0] !== launcher) return null;
  return {
    cmd: { ...cmd, bin: resolved.launch.executable, args: cmd.args.slice(1) },
    seatId: resolved.launch.seatId,
    nativeStatePath: resolved.launch.nativeStatePath,
    executable: resolved.launch.executable,
  };
}

export function resolveEngineRegistry(cfg?: AshlrConfig): Record<string, EngineSpec> {
  const merged: Record<string, EngineSpec> = { ...BUILTIN_ENGINE_REGISTRY };
  const added = cfg?.foundry?.engines;
  if (added && typeof added === 'object') {
    for (const [key, spec] of Object.entries(added)) {
      // V3.10: grok-cli cannot be redefined from config. Its judge ids are
      // frontier (reviewer-independence isFrontierJudgeId), so a config-authored
      // spec could point a merge-authority judge identity at any binary.
      // Config may tighten authority, never widen it (SPEC-310B I3).
      if (key === GROK_CLI_ENGINE_ID) continue;
      // Honor the map key as the id when the spec omits/!matches it.
      const candidate = { ...(spec as EngineSpec), id: (spec as EngineSpec)?.id ?? key };
      if (isValidSpec(candidate)) merged[key] = candidate;
    }
  }
  // M195: high-level cfg.foundry.nim convenience override (frontier promotion +
  // Kimi model id). No-op when cfg.foundry.nim is absent.
  if (merged['nim']) {
    merged['nim'] = applyNimConfig(merged['nim'], cfg);
  }
  // M270: high-level cfg.foundry.kimi convenience override (frontier work-assignment
  // promotion). No-op when cfg.foundry.kimi is absent. WORK-ASSIGNMENT tier only —
  // merge authority is gated separately by evaluateMergeAuthority (inbox/merge.ts).
  if (merged['kimi']) {
    merged['kimi'] = applyKimiConfig(merged['kimi'], cfg);
  }
  // M298: high-level cfg.foundry.grok convenience override (frontier work-assignment
  // promotion). No-op when cfg.foundry.grok is absent. WORK-ASSIGNMENT tier only —
  // merge authority is gated separately by evaluateMergeAuthority (inbox/merge.ts).
  // SAFETY: grok is NOT in cfg.foundry.mergeAuthority by default.
  if (merged['grok']) {
    merged['grok'] = applyGrokConfig(merged['grok'], cfg);
  }
  // The llama-server endpoint is resolved, not fixed: the supervised runtime
  // may be on another port, and a spec still naming :8080 would dispatch into
  // silence. Same fold shape as the nim/kimi/grok overrides above.
  if (merged['llama-server']) {
    merged['llama-server'] = applyLlamaServerConfig(merged['llama-server'], cfg);
  }
  // V3.10: the grok-cli spec only ever runs through the resolved seat launcher.
  merged[GROK_CLI_ENGINE_ID] = applyGrokCliProfile(BUILTIN_ENGINE_REGISTRY[GROK_CLI_ENGINE_ID]!, cfg);
  return merged;
}

/** Look up a single engine spec from the effective registry. */
export function resolveEngineSpec(engine: string, cfg?: AshlrConfig): EngineSpec | undefined {
  return resolveEngineRegistry(cfg)[engine];
}

// ---------------------------------------------------------------------------
// V3.10: headless judge / Leader invocations (SPEC-310B §1 residual risks, §3)
// ---------------------------------------------------------------------------
//
// A judge (and the Leader, U8) needs text in, text out — never tools. Both
// commands below are built so the model CANNOT act: no shell, no file writes,
// no MCP servers, no web. That is what makes it acceptable to hand the claude-a
// token to a Claude judge call at all ("the token only reaches restricted
// calls; with no tools there is nothing to exfiltrate with").

/**
 * Appended to every Claude judge / Leader call. Each flag is in `claude --help`
 * on 2.1.280, and the exact sequence parses (a `-p` run with empty stdin
 * reaches "Input must be provided" rather than "unknown option"):
 *  - --restricted: removes Bash/REPL/code-running tools and WebFetch, ignores
 *    user/project/local settings files (so Mason's hooks never run on a judge
 *    call), refuses bypassPermissions;
 *  - --tools '': no built-in tools at all;
 *  - --disallowedTools mcp__*: no MCP tool even if one is configured;
 *  - --strict-mcp-config: no MCP servers except --mcp-config (none is passed);
 *  - --no-session-persistence: judge prompts never land in Mason's sessions.
 * Order matters: `--tools` and `--disallowedTools` are variadic, so each is
 * closed by the next flag; the prompt stays before them.
 */
export const CLAUDE_RESTRICTED_ARGS: readonly string[] = Object.freeze([
  '--restricted',
  '--tools', '',
  '--disallowedTools', 'mcp__*',
  '--strict-mcp-config',
  '--no-session-persistence',
]);

/** Flags that would re-open what CLAUDE_RESTRICTED_ARGS closes. */
const CLAUDE_UNRESTRICTING_FLAGS: ReadonlySet<string> = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', '--mcp-config',
  '--settings', '--setting-sources', '--allowedTools', '--allowed-tools', '--permission-mode', '--plugin-dir', '--agents',
]);

/**
 * Append CLAUDE_RESTRICTED_ARGS to a NON-autonomous claude command
 * (`claude -p <prompt> [--model M] --output-format json`, from
 * run/engines.ts buildEngineCommand). Returns null — never a partially
 * restricted command — when the input already carries a flag that would
 * re-open what the restriction closes (e.g. an autonomous argv).
 */
export function restrictClaudeCommand(cmd: EngineCommand): EngineCommand | null {
  const base = Array.isArray(cmd.args) ? cmd.args : [];
  const restricted: EngineCommand = { ...cmd, args: [...base, ...CLAUDE_RESTRICTED_ARGS] };
  return isRestrictedClaudeCommand(restricted) ? restricted : null;
}

/**
 * True when `cmd` carries the full restricted sequence contiguously and no flag
 * that re-opens tools, settings or MCP. The ONLY check that decides whether a
 * claude-a credential may be attached to a spawn (fleet/manager.ts).
 */
export function isRestrictedClaudeCommand(cmd: EngineCommand): boolean {
  const args = cmd.args;
  const want = CLAUDE_RESTRICTED_ARGS;
  let at = -1;
  for (let i = 0; i + want.length <= args.length; i += 1) {
    if (want.every((flag, j) => args[i + j] === flag)) { at = i; break; }
  }
  if (at < 0) return false;
  return !args.some((arg, i) => {
    if (i >= at && i < at + want.length) return false;
    const flag = arg.split('=')[0]!;
    return CLAUDE_UNRESTRICTING_FLAGS.has(flag) || flag === '--tools' || flag === '--disallowedTools' || flag === '--disallowed-tools';
  });
}

/**
 * The grok-cli argv for a TEXT-ONLY call (judge / Leader). Differs from the
 * producer argv on purpose:
 *  - --permission-mode default: with no approver, a tool that needs approval
 *    cancels the turn (measured on 0.2.118) — the judge then records a failure
 *    and fails closed to 'review'; nothing is ever auto-approved;
 *  - --tools= (empty allow-list), --disable-web-search, --no-subagents,
 *    --no-memory: belt and braces around "no tools, no web, no state".
 * Every flag and value parses on the pinned 0.2.118 (clap exits 0 with
 * `--version`; an unknown flag or value exits 2). Whether an EMPTY --tools
 * list means "none" rather than "default" cannot be probed without inference;
 * `default` permission mode plus an empty private cwd bounds either reading.
 */
export const GROK_CLI_HEADLESS_ARGV: readonly ArgvSeg[] = Object.freeze([
  '--no-auto-update',
  '--output-format', 'streaming-messages-json',
  '--cwd', '$CWD',
  '--model', '$MODEL',
  '--permission-mode', 'default',
  '--tools=',
  '--disable-web-search',
  '--no-subagents',
  '--no-memory',
  { join: ['--single=', '$GOAL'] },
]);

/** Launch GROK_CLI_HEADLESS_ARGV through the grok-a seat launcher; null when the seat does not resolve. */
export function buildGrokCliHeadlessCommand(
  prompt: string,
  cfg: AshlrConfig | undefined,
  opts: { cwd: string; model?: string },
): EngineCommand | null {
  const resolved = resolveGrokCliSeat(cfg);
  if (!resolved.ok) return null;
  const model = opts.model?.trim() || GROK_CLI_DEFAULT_MODEL;
  const [node, launcher] = resolved.launch.command;
  return { bin: node, args: [launcher, ...compileArgv([...GROK_CLI_HEADLESS_ARGV], { goal: prompt, cwd: opts.cwd, model })], cwd: opts.cwd };
}

export interface GrokStreamText {
  /** The answer text ('' when none). */
  text: string;
  /** The CLI's own error summary when the turn did not succeed; null on success. */
  error: string | null;
  /** The model the stream says answered; null = not reported. */
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

const GROK_STREAM_MAX_LINES = 20_000;

/**
 * Extract the answer from grok's `streaming-messages-json` stdout (Anthropic
 * Messages wire NDJSON: bare `message_start` / `content_block_delta` /
 * `message_delta` events, whole `assistant` envelopes, `stream_event`
 * wrappers, and a terminal `result`).
 *
 * Text precedence: the terminal `result.result` string (the CLI's own final
 * answer), else the `assistant` envelope text blocks, else the streamed
 * `text_delta`s. Never both envelope and deltas — the same block arrives both
 * ways when partial messages are on, and doubling a JSON verdict would make
 * the judge's parser see two objects. Thinking blocks are never text.
 * Non-JSON lines are the CLI talking, not the model, and are ignored.
 */
export function extractGrokStreamText(output: string): GrokStreamText {
  let resultText: string | null = null;
  const envelopeText: string[] = [];
  const deltaText: string[] = [];
  let error: string | null = null;
  let model: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const readUsage = (usage: unknown): void => {
    if (!isObj(usage)) return;
    if (typeof usage['input_tokens'] === 'number') tokensIn = usage['input_tokens'];
    if (typeof usage['output_tokens'] === 'number') tokensOut = usage['output_tokens'];
  };
  const wire = (ev: Record<string, unknown>): void => {
    const type = ev['type'];
    if (type === 'message_start' && isObj(ev['message'])) {
      if (typeof ev['message']['model'] === 'string' && ev['message']['model']) model = ev['message']['model'];
      readUsage(ev['message']['usage']);
    } else if (type === 'content_block_delta' && isObj(ev['delta'])) {
      if (ev['delta']['type'] === 'text_delta' && typeof ev['delta']['text'] === 'string') deltaText.push(ev['delta']['text']);
    } else if (type === 'message_delta') {
      readUsage(ev['usage']);
    }
  };
  const lines = output.split('\n');
  for (let i = 0; i < lines.length && i < GROK_STREAM_MAX_LINES; i += 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isObj(ev)) continue;
    switch (ev['type']) {
      case 'stream_event':
        if (isObj(ev['event'])) wire(ev['event']);
        break;
      case 'assistant': {
        const message = ev['message'];
        if (!isObj(message)) break;
        if (typeof message['model'] === 'string' && message['model']) model = message['model'];
        readUsage(message['usage']);
        const content = message['content'];
        if (typeof content === 'string') envelopeText.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (isObj(block) && block['type'] === 'text' && typeof block['text'] === 'string') envelopeText.push(block['text']);
          }
        }
        break;
      }
      case 'result': {
        readUsage(ev['usage']);
        const subtype = typeof ev['subtype'] === 'string' ? ev['subtype'] : null;
        if ((subtype !== null && subtype !== 'success') || ev['is_error'] === true) {
          error = (subtype && subtype !== 'success' ? subtype : 'result reported an error').slice(0, 200);
        } else if (typeof ev['result'] === 'string') {
          resultText = ev['result'];
        }
        break;
      }
      default:
        wire(ev);
    }
  }
  const text = error !== null ? '' : resultText !== null && resultText.trim().length > 0 ? resultText
    : envelopeText.length > 0 ? envelopeText.join('') : deltaText.join('');
  return { text, error, model, tokensIn, tokensOut };
}

/**
 * V3.10 (INT4 — B-U7 request to U6): token usage of a whole grok-cli PRODUCER
 * run from its `streaming-messages-json` stdout.
 *
 * spawnEngine's generic parser (run/engines.ts) finds usage only on a line
 * carrying top-level `usage.input_tokens` AND `usage.output_tokens` — grok's
 * terminal `result`. When that line is missing (killed by a stall or the
 * backstop, or a CLI build that does not emit it), a multi-turn agent run
 * would record NO usage. extractGrokStreamText keeps only the LAST message's
 * usage (right for a one-message judge, an undercount for an agent). Here:
 *  - a `result` with usage wins (the CLI's own run total);
 *  - otherwise per-message usage is summed across the run, each message
 *    counted once whether it arrived as `message_start`/`message_delta`
 *    events, a whole `assistant` envelope, or `stream_event` wrappers of
 *    either (deduplicated by message id; the max seen per message, because
 *    message_delta usage is cumulative within its message).
 * Returns null when the stream reports no usage at all.
 */
export function grokStreamUsage(output: string): { tokensIn: number; tokensOut: number } | null {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  let result: { tokensIn: number; tokensOut: number } | null = null;
  const perMessage = new Map<string, { in: number; out: number }>();
  let anonymous = 0;
  let current: string | null = null;
  const note = (id: string | null, usage: unknown): void => {
    if (!isObj(usage)) return;
    const tin = num(usage['input_tokens']);
    const tout = num(usage['output_tokens']);
    if (tin === null && tout === null) return;
    const key = id ?? current ?? `anon-${anonymous++}`;
    const row = perMessage.get(key) ?? { in: 0, out: 0 };
    row.in = Math.max(row.in, tin ?? 0);
    row.out = Math.max(row.out, tout ?? 0);
    perMessage.set(key, row);
  };
  const wire = (ev: Record<string, unknown>): void => {
    if (ev['type'] === 'message_start' && isObj(ev['message'])) {
      current = typeof ev['message']['id'] === 'string' ? ev['message']['id'] : `start-${anonymous++}`;
      note(current, ev['message']['usage']);
    } else if (ev['type'] === 'message_delta') {
      note(current, ev['usage']);
    }
  };
  const lines = output.split('\n');
  for (let i = 0; i < lines.length && i < GROK_STREAM_MAX_LINES * 10; i += 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isObj(ev)) continue;
    if (ev['type'] === 'result' && isObj(ev['usage'])) {
      const tin = num(ev['usage']['input_tokens']);
      const tout = num(ev['usage']['output_tokens']);
      if (tin !== null && tout !== null) result = { tokensIn: tin, tokensOut: tout };
    } else if (ev['type'] === 'assistant' && isObj(ev['message'])) {
      const id = typeof ev['message']['id'] === 'string' ? ev['message']['id'] : null;
      note(id, ev['message']['usage']);
    } else if (ev['type'] === 'stream_event' && isObj(ev['event'])) {
      wire(ev['event']);
    } else {
      wire(ev);
    }
  }
  if (result) return result;
  if (perMessage.size === 0) return null;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const row of perMessage.values()) { tokensIn += row.in; tokensOut += row.out; }
  return { tokensIn, tokensOut };
}

/**
 * SPEC-310B lanes (fleet-types FleetEngine) → registry engine ids. `local`
 * maps to the parallel llama-server lane unless the caller names Ollama.
 */
export function registryEngineForFleetEngine(
  lane: 'local' | 'grok-cli' | 'claude-cli' | 'codex',
  localEngine: 'llama-server' | 'local-coder' = 'llama-server',
): string {
  switch (lane) {
    case 'grok-cli': return GROK_CLI_ENGINE_ID;
    case 'claude-cli': return 'claude';
    case 'codex': return 'codex';
    default: return localEngine;
  }
}

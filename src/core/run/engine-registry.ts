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
 * the EXACT argv the pre-M50 switch produced for builtin/ashlrcode/aw/claude/codex,
 * with and without a model and with and without autonomous mode.
 *
 * GUARDRAILS:
 *  - compileArgv is PURE and injection-safe: placeholders are substituted only as
 *    WHOLE argv elements; a goal/cwd/model containing '$CWD', ';', or backticks is
 *    passed verbatim as a single element and never shell-expanded.
 *  - No implicit frontier: a malformed or tier-less added entry is DROPPED, never
 *    defaulted to a merge-authority tier.
 */

import type {
  AshlrConfig,
  ArgvSeg,
  EngineSpec,
  EngineTier,
} from '../types.js';

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

  // claude -p <goal> [--model M] --output-format json [--dangerously-skip-permissions --add-dir CWD when autonomous]
  // Uses the Claude Code SUBSCRIPTION (env API keys are stripped by CRED_ENV_DENY).
  // --dangerously-skip-permissions is SAFE here: we externally confine the run in
  // sandbox-exec (worktree-only writes) and every result is a PROPOSAL, never applied.
  claude: {
    id: 'claude',
    kind: 'cli-agent',
    tier: 'frontier',
    bin: 'claude',
    bins: ['claude'],
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
  ashlrcode: {
    id: 'ashlrcode',
    kind: 'cli-agent',
    tier: 'local',
    bin: 'ac',
    bins: ['ac', 'ashlrcode'],
    argv: ['--goal', '$GOAL'],
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
  // Default model: qwen2.5:72b-instruct-q4_K_M (best available on this machine).
  // Upgrade path: `ollama pull qwen2.5-coder:32b` for a dedicated coder model —
  // then set cfg.foundry.models['local-coder'] = 'qwen2.5-coder:32b'.
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
      defaultModel: 'qwen2.5:72b-instruct-q4_K_M',
      protocol: 'openai' as const,
    },
    capabilities: ['agent', 'edit', 'tools'],
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
 * are emitted only when a non-empty model is present. Pure; injection-safe.
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
    } else if (seg && Array.isArray(seg.optModel)) {
      if (model.length > 0) {
        for (const s of seg.optModel) out.push(subst(s, vars));
      }
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
 * Resolve the effective engine roster: the built-in registry with any
 * `cfg.foundry.engines` entries merged over it. Malformed added entries are
 * dropped (never fatal, never defaulted to frontier). Returns a fresh object.
 *
 * M195: after the `cfg.foundry.engines` merge, the high-level `cfg.foundry.nim`
 * block (if present) is folded into the resolved 'nim' spec via applyNimConfig —
 * letting NIM be promoted to frontier (Kimi K2 ammo) without touching the
 * builtin roster. `cfg.foundry.engines.nim` still wins (already merged above).
 */
export function resolveEngineRegistry(cfg?: AshlrConfig): Record<string, EngineSpec> {
  const merged: Record<string, EngineSpec> = { ...BUILTIN_ENGINE_REGISTRY };
  const added = cfg?.foundry?.engines;
  if (added && typeof added === 'object') {
    for (const [key, spec] of Object.entries(added)) {
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
  return merged;
}

/** Look up a single engine spec from the effective registry. */
export function resolveEngineSpec(engine: string, cfg?: AshlrConfig): EngineSpec | undefined {
  return resolveEngineRegistry(cfg)[engine];
}

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
  EngineId,
  EngineSpec,
  EngineTier,
} from '../types.js';

// ---------------------------------------------------------------------------
// Built-in roster — encodes the five v1–v4 engines (parity-locked) plus the two
// v5 CLI agents. New API models / agents are added via cfg.foundry.engines.
// ---------------------------------------------------------------------------

/**
 * The canonical built-in engine roster. Keyed by engine id. The five original
 * engines reproduce their pre-M50 argv byte-for-byte; `hermes` and `opencode`
 * are new v5 CLI agents (tier 'local' in M50 — M51's tri-tier promotes the strong
 * open models to 'mid'; nothing new is granted frontier/main authority here).
 */
export const BUILTIN_ENGINE_REGISTRY: Readonly<Record<EngineId, EngineSpec>> = Object.freeze({
  builtin: { id: 'builtin', kind: 'builtin', tier: 'local' },

  // claude -p <goal> [--model M] --output-format json [--permission-mode acceptEdits --add-dir CWD]
  claude: {
    id: 'claude',
    kind: 'cli-agent',
    tier: 'frontier',
    bin: 'claude',
    bins: ['claude'],
    argv: ['-p', '$GOAL', { optModel: ['--model', '$MODEL'] }, '--output-format', 'json'],
    autonomousArgv: ['--permission-mode', 'acceptEdits', '--add-dir', '$CWD'],
    capabilities: ['agent', 'edit', 'architecture'],
  },

  // codex exec [--model M] --sandbox workspace-write --cd CWD --json <goal>
  codex: {
    id: 'codex',
    kind: 'cli-agent',
    tier: 'frontier',
    bin: 'codex',
    bins: ['codex'],
    argv: [
      'exec',
      { optModel: ['--model', '$MODEL'] },
      '--sandbox',
      'workspace-write',
      '--cd',
      '$CWD',
      '--json',
      '$GOAL',
    ],
    capabilities: ['agent', 'edit', 'refactor'],
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
 * Resolve the effective engine roster: the built-in registry with any
 * `cfg.foundry.engines` entries merged over it. Malformed added entries are
 * dropped (never fatal, never defaulted to frontier). Returns a fresh object.
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
  return merged;
}

/** Look up a single engine spec from the effective registry. */
export function resolveEngineSpec(engine: string, cfg?: AshlrConfig): EngineSpec | undefined {
  return resolveEngineRegistry(cfg)[engine];
}

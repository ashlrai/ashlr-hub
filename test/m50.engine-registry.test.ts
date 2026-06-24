/**
 * M50 — declarative engine registry: parity, coverage, tier, and config merge.
 *
 * Hermetic; no spawn, no network. The PARITY block locks buildEngineCommand to
 * the EXACT pre-M50 argv for the five original engines (the byte-identical
 * guarantee). The COVERAGE block proves every EngineId has a registry entry. The
 * MERGE block proves config-only additions work and that malformed / tier-less
 * entries are dropped (no implicit frontier).
 */

import { describe, it, expect } from 'vitest';
import type { AshlrConfig, EngineId, EngineSpec } from '../src/core/types.js';
import { buildEngineCommand, engineInstalled } from '../src/core/run/engines.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';
import {
  BUILTIN_ENGINE_REGISTRY,
  resolveEngineRegistry,
  resolveEngineSpec,
} from '../src/core/run/engine-registry.js';

const GOAL = 'harden the inbox apply path';
const CWD = '/tmp/ashlr-wt-xyz';
const MODEL = 'opus-4.8';

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

const KNOWN_ENGINES: EngineId[] = ['builtin', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'opencode', 'nim', 'kimi', 'openai-compat'];

describe('M50 registry — coverage', () => {
  it('every known EngineId has a builtin registry entry', () => {
    for (const e of KNOWN_ENGINES) {
      expect(BUILTIN_ENGINE_REGISTRY[e], `missing spec for ${e}`).toBeDefined();
      expect(BUILTIN_ENGINE_REGISTRY[e].id).toBe(e);
    }
  });

  it('no builtin entry is tier "frontier" except claude and codex (no implicit frontier)', () => {
    const frontier = KNOWN_ENGINES.filter((e) => BUILTIN_ENGINE_REGISTRY[e].tier === 'frontier');
    expect(frontier.sort()).toEqual(['claude', 'codex']);
  });
});

describe('M50 registry — engineTierOf parity', () => {
  it('maps claude/codex → frontier, everything else → local (byte-identical to pre-M50)', () => {
    expect(engineTierOf('claude')).toBe('frontier');
    expect(engineTierOf('codex')).toBe('frontier');
    expect(engineTierOf('builtin')).toBe('local');
    expect(engineTierOf('aw')).toBe('local');
    expect(engineTierOf('ashlrcode')).toBe('local');
    expect(engineTierOf('hermes')).toBe('mid'); // M51: strong open model → mid
    expect(engineTierOf('opencode')).toBe('local');
  });

  it('an unknown engine is local, never frontier', () => {
    expect(engineTierOf('nonexistent' as EngineId)).toBe('local');
  });
});

describe('M50 registry — buildEngineCommand argv PARITY (byte-identical)', () => {
  const cfg = makeConfig();

  it('builtin → null', () => {
    expect(buildEngineCommand('builtin', GOAL, cfg, { cwd: CWD })).toBeNull();
  });

  it('claude — exact argv with model, no autonomous', () => {
    const cmd = buildEngineCommand('claude', GOAL, cfg, { cwd: CWD, model: MODEL });
    expect(cmd!.bin).toBe('claude');
    expect(cmd!.args).toEqual(['-p', GOAL, '--model', MODEL, '--output-format', 'json']);
  });

  it('claude — autonomous appends permission-mode + add-dir', () => {
    const cmd = buildEngineCommand('claude', GOAL, cfg, { cwd: CWD, model: MODEL, autonomous: true });
    expect(cmd!.args).toEqual([
      '-p', GOAL, '--model', MODEL, '--output-format', 'json',
      '--dangerously-skip-permissions', '--add-dir', CWD,
    ]);
  });

  it('claude — no model omits --model', () => {
    const cmd = buildEngineCommand('claude', GOAL, cfg, { cwd: CWD });
    expect(cmd!.args).toEqual(['-p', GOAL, '--output-format', 'json']);
  });

  it('codex — exact argv with and without model (yolo when autonomous)', () => {
    expect(buildEngineCommand('codex', GOAL, cfg, { cwd: CWD, model: MODEL })!.args).toEqual([
      'exec', '--model', MODEL, '--cd', CWD, '--json', GOAL,
    ]);
    expect(buildEngineCommand('codex', GOAL, cfg, { cwd: CWD })!.args).toEqual([
      'exec', '--cd', CWD, '--json', GOAL,
    ]);
    // autonomous → yolo (skip approvals + codex's own sandbox; we confine externally)
    expect(buildEngineCommand('codex', GOAL, cfg, { cwd: CWD, autonomous: true })!.args).toEqual([
      'exec', '--cd', CWD, '--json', GOAL, '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('aw — exact argv with and without model', () => {
    expect(buildEngineCommand('aw', GOAL, cfg, { cwd: CWD, model: MODEL })!.args).toEqual([
      'auto', GOAL, '--cwd', CWD, '--model', MODEL,
    ]);
    expect(buildEngineCommand('aw', GOAL, cfg, { cwd: CWD })!.args).toEqual([
      'auto', GOAL, '--cwd', CWD,
    ]);
  });

  it('ashlrcode — bin is "ac" with --goal', () => {
    const cmd = buildEngineCommand('ashlrcode', GOAL, cfg, { cwd: CWD });
    expect(cmd!.bin).toBe('ac');
    expect(cmd!.args).toEqual(['--goal', GOAL]);
  });

  it('empty model string is treated as absent', () => {
    expect(buildEngineCommand('codex', GOAL, cfg, { cwd: CWD, model: '' })!.args).not.toContain('--model');
  });
});

describe('M50 registry — new v5 CLI agents', () => {
  const cfg = makeConfig();

  it('hermes — hermes -z <goal>, --yolo when autonomous, -m when model', () => {
    expect(buildEngineCommand('hermes', GOAL, cfg, { cwd: CWD })!.args).toEqual(['-z', GOAL]);
    expect(buildEngineCommand('hermes', GOAL, cfg, { cwd: CWD, model: 'hermes-3', autonomous: true })!.args).toEqual([
      '-z', GOAL, '-m', 'hermes-3', '--yolo',
    ]);
    expect(buildEngineCommand('hermes', GOAL, cfg, { cwd: CWD })!.bin).toBe('hermes');
  });

  it('opencode — opencode run <goal>', () => {
    const cmd = buildEngineCommand('opencode', GOAL, cfg, { cwd: CWD });
    expect(cmd!.bin).toBe('opencode');
    expect(cmd!.args).toEqual(['run', GOAL]);
  });

  it('engineInstalled never throws and returns a boolean for new agents', () => {
    expect(typeof engineInstalled('hermes')).toBe('boolean');
    expect(typeof engineInstalled('opencode')).toBe('boolean');
    expect(engineInstalled('builtin')).toBe(true);
  });
});

describe('M50 registry — config-only additions (cfg.foundry.engines)', () => {
  it('merges a new cli-agent backend with no code change', () => {
    const spec: EngineSpec = {
      id: 'mycli',
      kind: 'cli-agent',
      tier: 'local',
      bin: 'mycli',
      bins: ['mycli'],
      argv: ['do', '$GOAL'],
    };
    const cfg = makeConfig({ foundry: { engines: { mycli: spec } } } as Partial<AshlrConfig>);
    const reg = resolveEngineRegistry(cfg);
    expect(reg['mycli']).toBeDefined();
    expect(buildEngineCommand('mycli' as EngineId, GOAL, cfg, { cwd: CWD })!.args).toEqual(['do', GOAL]);
  });

  it('resolves tier for an api-model addition from its declared tier', () => {
    const spec: EngineSpec = {
      id: 'nim',
      kind: 'api-model',
      tier: 'local',
      api: { envKey: 'NVIDIA_NIM_API_KEY', defaultBaseUrl: 'https://integrate.api.nvidia.com/v1', protocol: 'openai' },
    };
    const cfg = makeConfig({ foundry: { engines: { nim: spec } } } as Partial<AshlrConfig>);
    expect(resolveEngineSpec('nim', cfg)?.tier).toBe('local');
    // api-model has no CLI argv → buildEngineCommand returns null (runs via the loop).
    expect(buildEngineCommand('nim' as EngineId, GOAL, cfg, { cwd: CWD })).toBeNull();
  });

  it('DROPS a tier-less entry — no implicit frontier', () => {
    const bad = { id: 'sneaky', kind: 'cli-agent', bin: 'sneaky', argv: ['x'] } as unknown as EngineSpec;
    const cfg = makeConfig({ foundry: { engines: { sneaky: bad } } } as Partial<AshlrConfig>);
    const reg = resolveEngineRegistry(cfg);
    expect(reg['sneaky']).toBeUndefined();
  });

  it('DROPS an entry with an invalid id or unknown kind', () => {
    const cfg = makeConfig({
      foundry: {
        engines: {
          BadId: { id: 'BadId', kind: 'cli-agent', tier: 'local' } as EngineSpec,
          weird: { id: 'weird', kind: 'telepathy', tier: 'local' } as unknown as EngineSpec,
        },
      },
    } as Partial<AshlrConfig>);
    const reg = resolveEngineRegistry(cfg);
    expect(reg['BadId']).toBeUndefined();
    expect(reg['weird']).toBeUndefined();
  });

  it('absent cfg.foundry.engines ⇒ exactly the builtin roster', () => {
    const reg = resolveEngineRegistry(makeConfig());
    expect(Object.keys(reg).sort()).toEqual([...KNOWN_ENGINES].sort());
  });
});

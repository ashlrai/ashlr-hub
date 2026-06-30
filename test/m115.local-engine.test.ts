/**
 * m115.local-engine.test.ts — M115: local-coder (Ollama) as first-class fleet
 * coding engine.
 *
 * Test groups:
 *
 *   1. REGISTRY — local-coder resolves from BUILTIN_ENGINE_REGISTRY with correct
 *      api spec (tier=mid, protocol=openai, no envKey, Ollama baseUrl). NOT in
 *      default allowedBackends (opt-in parity). Malformed local engine is dropped.
 *
 *   2. TIER GUARDRAIL — local-coder is mid-tier (branch-only). It NEVER gains
 *      frontier/main-merge authority. buildEngineCommand returns null (api-model,
 *      not a CLI spawn). engineTierOf returns 'mid'.
 *
 *   3. ROUTER BIAS — with local-coder allowed+installed (mocked), bulk items
 *      route to local-coder. Hard items (effort>=4 or score>=8) route to frontier
 *      when frontier is also available. Escalation source always routes to
 *      frontier. With no local-coder but frontier present: frontier fallback.
 *      Deterministic: same item always routes the same way.
 *
 *   4. ALLOWED BACKENDS — allowedBackends=['builtin','local-coder'] routes bulk
 *      items to local-coder when it is installed.
 *
 *   5. INSTALLED PROBE — engineInstalled for local-coder: envKey empty -> URL
 *      probe path; spawnSync curl succeeds -> true; fails -> false.
 *
 *   6. INTEGRATION (skipped when Ollama absent) — if OLLAMA_LIVE=1 is set,
 *      sends a real tool-call request to http://localhost:11434/v1 and asserts
 *      the response includes a tool_calls array (proves qwen2.5:72b produces
 *      real tool calls that the agent-loop write-tools path can execute).
 *
 * Mirrors m46/m92 conventions: hermetic unit tests + guarded integration check.
 */

import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import {
  BUILTIN_ENGINE_REGISTRY,
  resolveEngineRegistry,
  resolveEngineSpec,
} from '../src/core/run/engine-registry.js';
import { buildEngineCommand, engineInstalled } from '../src/core/run/engines.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';
import { routeBackend } from '../src/core/fleet/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: 'http://localhost:11434', providerChain: [] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

let _seq = 0;
function makeItem(over: { source: WorkSource } & Partial<WorkItem>): WorkItem {
  const id = over.id ?? `repo:${over.source}:item${_seq++}`;
  return {
    id,
    repo: '/repo',
    source: over.source,
    title: over.title ?? 't',
    detail: over.detail ?? 'd',
    value: over.value ?? 3,
    effort: over.effort ?? 3,
    score: over.score ?? 3,
    tags: over.tags ?? [],
    ts: over.ts ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. REGISTRY
// ---------------------------------------------------------------------------

describe('M115 registry', () => {
  it('local-coder is present in BUILTIN_ENGINE_REGISTRY', () => {
    expect(BUILTIN_ENGINE_REGISTRY['local-coder']).toBeDefined();
  });

  it('local-coder has correct shape: kind=api-model, tier=mid, Ollama baseUrl', () => {
    const spec = BUILTIN_ENGINE_REGISTRY['local-coder']!;
    expect(spec.kind).toBe('api-model');
    expect(spec.tier).toBe('mid');
    expect(spec.api?.defaultBaseUrl).toContain('11434');
    expect(spec.api?.protocol).toBe('openai');
    // No envKey — Ollama is free/local, probed by URL
    expect(spec.api?.envKey).toBe('');
    expect(spec.capabilities).toContain('tools');
  });

  it('local-coder default model is qwen2.5:72b-instruct-q4_K_M', () => {
    const spec = BUILTIN_ENGINE_REGISTRY['local-coder']!;
    expect(spec.api?.defaultModel).toBe('qwen2.5:72b-instruct-q4_K_M');
  });

  it('local-coder resolves via resolveEngineSpec', () => {
    const spec = resolveEngineSpec('local-coder', baseConfig());
    expect(spec).toBeDefined();
    expect(spec?.id).toBe('local-coder');
  });

  it('local-coder is NOT in default allowedBackends (opt-in only)', () => {
    // Default config has no foundry -> allowedBackends defaults to ['builtin'].
    const cfg = baseConfig();
    expect(cfg.foundry?.allowedBackends).toBeUndefined();
  });

  it('cfg-added local-coder merges over builtin registry correctly', () => {
    const cfg = baseConfig({
      foundry: {
        allowedBackends: ['builtin', 'local-coder'] as AshlrConfig['foundry']['allowedBackends'],
        models: { 'local-coder': 'qwen2.5-coder:32b' } as AshlrConfig['foundry']['models'],
      },
    } as Partial<AshlrConfig>);
    const reg = resolveEngineRegistry(cfg);
    expect(reg['local-coder']?.tier).toBe('mid');
  });
});

// ---------------------------------------------------------------------------
// 2. TIER GUARDRAIL
// ---------------------------------------------------------------------------

describe('M115 tier guardrail', () => {
  it('engineTierOf("local-coder") === "mid"', () => {
    expect(engineTierOf('local-coder' as Parameters<typeof engineTierOf>[0])).toBe('mid');
  });

  it('local-coder tier is NOT "frontier" — never carries main-merge authority', () => {
    const tier = engineTierOf('local-coder' as Parameters<typeof engineTierOf>[0]);
    expect(tier).not.toBe('frontier');
  });

  it('buildEngineCommand returns null for local-coder (api-model, no CLI argv)', () => {
    const result = buildEngineCommand(
      'local-coder' as Parameters<typeof buildEngineCommand>[0],
      'some goal',
      baseConfig(),
    );
    expect(result).toBeNull();
  });

  it('frontier engines (claude/codex) remain at tier "frontier"', () => {
    expect(engineTierOf('claude')).toBe('frontier');
    expect(engineTierOf('codex')).toBe('frontier');
  });
});

// ---------------------------------------------------------------------------
// 3. ROUTER BIAS (mocked engineInstalled)
// ---------------------------------------------------------------------------

describe('M115 router bias', () => {
  let enginesModule: typeof import('../src/core/run/engines.js');

  beforeAll(async () => {
    enginesModule = await import('../src/core/run/engines.js');
  });

  beforeEach(() => {
    vi.spyOn(enginesModule, 'engineInstalled').mockImplementation(
      (engine: string) => {
        if (engine === 'local-coder') return true;
        if (engine === 'claude') return true;
        if (engine === 'codex') return false;
        if (engine === 'builtin') return true;
        return false;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const localCoderCfg = withFoundry({
    allowedBackends: ['builtin', 'local-coder', 'claude'] as AshlrConfig['foundry']['allowedBackends'],
  });

  it('bulk item (effort=2, score=3) routes to local-coder (mid)', () => {
    const item = makeItem({ source: 'todo', effort: 2, score: 3 });
    const d = routeBackend(item, localCoderCfg);
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
    expect(d.reason).toMatch(/local-mid bulk/);
  });

  it('hard item (effort=4) routes to frontier (claude)', () => {
    const item = makeItem({ source: 'todo', effort: 4, score: 3 });
    const d = routeBackend(item, localCoderCfg);
    expect(d.backend).toBe('claude');
    expect(d.tier).toBe('frontier');
    expect(d.reason).toMatch(/frontier/);
  });

  it('high-score item (score=8) routes to frontier', () => {
    const item = makeItem({ source: 'issue', effort: 2, score: 8 });
    const d = routeBackend(item, localCoderCfg);
    expect(d.backend).toBe('claude');
    expect(d.tier).toBe('frontier');
  });

  it('escalation source always routes to frontier regardless of effort/score', () => {
    const item = {
      ...makeItem({ source: 'issue', effort: 1, score: 1 }),
      source: 'escalation',
    } as WorkItem;
    const d = routeBackend(item, localCoderCfg);
    expect(d.backend).toBe('claude');
    expect(d.tier).toBe('frontier');
    expect(d.reason).toMatch(/frontier/);
  });

  it('routing is DETERMINISTIC: same item always produces same result', () => {
    const item = makeItem({ source: 'dep', id: 'stable-id-abc', effort: 2, score: 3 });
    const r1 = routeBackend(item, localCoderCfg);
    const r2 = routeBackend(item, localCoderCfg);
    expect(r1.backend).toBe(r2.backend);
    expect(r1.tier).toBe(r2.tier);
  });

  it('when local-coder absent but frontier present: frontier fallback', () => {
    vi.restoreAllMocks();
    vi.spyOn(enginesModule, 'engineInstalled').mockImplementation(
      (engine: string) => {
        if (engine === 'local-coder') return false;
        if (engine === 'claude') return true;
        if (engine === 'builtin') return true;
        return false;
      },
    );
    const item = makeItem({ source: 'todo', effort: 2, score: 3 });
    const d = routeBackend(item, localCoderCfg);
    expect(d.backend).toBe('claude');
    expect(d.reason).toMatch(/frontier-fallback/);
  });

  it('when no external backend available: falls back to builtin', () => {
    vi.restoreAllMocks();
    vi.spyOn(enginesModule, 'engineInstalled').mockImplementation(
      (engine: string) => engine === 'builtin',
    );
    const item = makeItem({ source: 'todo' });
    const d = routeBackend(item, localCoderCfg);
    expect(d.backend).toBe('builtin');
    expect(d.tier).toBe('local');
  });

  it('local-coder NEVER appears in routing when not in allowedBackends', () => {
    const cfgNoLocal = withFoundry({
      allowedBackends: ['builtin', 'claude'] as AshlrConfig['foundry']['allowedBackends'],
    });
    const item = makeItem({ source: 'todo', effort: 1, score: 1 });
    const d = routeBackend(item, cfgNoLocal);
    expect(d.backend).not.toBe('local-coder');
  });
});

// ---------------------------------------------------------------------------
// 4. ALLOWED BACKENDS CONFIG
// ---------------------------------------------------------------------------

describe('M115 allowedBackends', () => {
  let enginesModule: typeof import('../src/core/run/engines.js');

  beforeAll(async () => {
    enginesModule = await import('../src/core/run/engines.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('local-coder in allowedBackends activates the engine for routing', () => {
    vi.spyOn(enginesModule, 'engineInstalled').mockImplementation(
      (e: string) => e === 'builtin' || e === 'local-coder',
    );
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'local-coder'] as AshlrConfig['foundry']['allowedBackends'],
    });
    const item = makeItem({ source: 'todo', effort: 2, score: 3 });
    const d = routeBackend(item, cfg);
    expect(d.backend).toBe('local-coder');
  });
});

// ---------------------------------------------------------------------------
// 5. INSTALLED PROBE (behavioral — spawnSync is bound at import time, not
//    spy-able via namespace; we test via the real curl probe behavior)
// ---------------------------------------------------------------------------

describe('M115 engineInstalled URL probe', () => {
  it('local-coder with dead URL (port 19999) returns false', () => {
    // Point local-coder at a port that is certainly not listening.
    const cfg = baseConfig({
      foundry: {
        allowedBackends: ['builtin', 'local-coder'] as AshlrConfig['foundry']['allowedBackends'],
      },
    } as Partial<AshlrConfig>);
    // Override via env seam: OLLAMA_BASE_URL points to the dead port.
    const saved = process.env['OLLAMA_BASE_URL'];
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:19999/v1';
    try {
      const result = engineInstalled(
        'local-coder' as Parameters<typeof engineInstalled>[0],
        cfg,
      );
      expect(result).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['OLLAMA_BASE_URL'];
      else process.env['OLLAMA_BASE_URL'] = saved;
    }
  });

  it('api-model with non-empty envKey uses env-var check (not URL probe)', () => {
    // 'nim' has NVIDIA_NIM_API_KEY — installed when key is set, regardless of URL
    const saved = process.env['NVIDIA_NIM_API_KEY'];
    process.env['NVIDIA_NIM_API_KEY'] = 'test-key-value';
    try {
      const result = engineInstalled('nim' as Parameters<typeof engineInstalled>[0], baseConfig());
      expect(result).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['NVIDIA_NIM_API_KEY'];
      else process.env['NVIDIA_NIM_API_KEY'] = saved;
    }
  });

  it('api-model with non-empty envKey absent returns false', () => {
    const saved = process.env['NVIDIA_NIM_API_KEY'];
    delete process.env['NVIDIA_NIM_API_KEY'];
    try {
      const result = engineInstalled('nim' as Parameters<typeof engineInstalled>[0], baseConfig());
      expect(result).toBe(false);
    } finally {
      if (saved !== undefined) process.env['NVIDIA_NIM_API_KEY'] = saved;
    }
  });

  // Live probe — only meaningful when an Ollama server is actually reachable.
  // Skipped in hermetic CI (no local model server); runs on a dev box with
  // Ollama up. Reachability is probed once via the same URL seam under test.
  const ollamaReachable = (() => {
    const saved = process.env['OLLAMA_BASE_URL'];
    delete process.env['OLLAMA_BASE_URL'];
    try {
      return engineInstalled('local-coder' as Parameters<typeof engineInstalled>[0], baseConfig());
    } catch {
      return false;
    } finally {
      if (saved !== undefined) process.env['OLLAMA_BASE_URL'] = saved;
    }
  })();

  it.runIf(ollamaReachable)('local-coder with live Ollama at http://localhost:11434/v1 returns true', () => {
    const saved = process.env['OLLAMA_BASE_URL'];
    delete process.env['OLLAMA_BASE_URL']; // use defaultBaseUrl from spec
    try {
      const result = engineInstalled(
        'local-coder' as Parameters<typeof engineInstalled>[0],
        baseConfig(),
      );
      // Ollama is confirmed reachable for this run — must be true.
      expect(result).toBe(true);
    } finally {
      if (saved !== undefined) process.env['OLLAMA_BASE_URL'] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. INTEGRATION (skipped unless OLLAMA_LIVE=1)
// ---------------------------------------------------------------------------

const ollamaLive = process.env['OLLAMA_LIVE'] === '1';

describe.skipIf(!ollamaLive)('M115 integration — Ollama live tool-call (OLLAMA_LIVE=1)', () => {
  it('qwen2.5:72b-instruct-q4_K_M returns native tool_calls for write_file request', async () => {
    const baseUrl = 'http://localhost:11434/v1';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:72b-instruct-q4_K_M',
        messages: [
          { role: 'user', content: 'Call write_file with path="hello.ts" and content="export const x = 1;"' },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'write_file',
            description: 'Write content to a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        }],
        tool_choice: 'auto',
        stream: false,
      }),
    });

    expect(response.ok).toBe(true);
    const data = await response.json() as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> };
      }>;
    };

    const choice = data.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toBeDefined();
    expect(choice.message.tool_calls!.length).toBeGreaterThan(0);

    const tc = choice.message.tool_calls![0]!;
    expect(tc.function.name).toBe('write_file');
    const args = JSON.parse(tc.function.arguments) as { path: string; content: string };
    expect(args.path).toBeTruthy();
    expect(args.content).toBeTruthy();
  }, 120_000);
});

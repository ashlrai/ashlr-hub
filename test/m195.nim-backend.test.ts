/**
 * m195.nim-backend.test.ts — M195: NVIDIA NIM backend running Kimi K2 as
 * frontier-tier ammo.
 *
 * NIM exposes an OpenAI-COMPATIBLE chat-completions API:
 *   base URL  https://integrate.api.nvidia.com/v1   (verified live 2026-06)
 *   endpoint  POST /v1/chat/completions
 *   auth      Authorization: Bearer <NVIDIA_NIM_API_KEY>
 *   model id  moonshotai/kimi-k2-instruct            (verified live on the NIM
 *                                                      model catalog 2026-06)
 *
 * What this suite locks (mirrors the codex backend's tests, fully hermetic —
 * fetch is mocked, NO live NIM calls):
 *   1. CLIENT  — buildOpenAICompatibleClient hits the configured endpoint with
 *      the bearer key + model; the request SHAPE is asserted from a mocked fetch.
 *   2. CATALOG — the engine registry includes the 'nim' api-model entry wired to
 *      NVIDIA NIM, and cfg.foundry.nim folds in the Kimi model + frontier tier.
 *   3. ROUTING — routeBackend / routeTask select 'nim' as a FRONTIER engine when
 *      it is config-promoted (cfg.foundry.nim.tier='frontier') AND allowed.
 *   4. GATING  — absent the nim config / not in allowedBackends ⇒ NOT selectable;
 *      zero effect (byte-identical to a fleet without NIM).
 *   5. SECRET  — the API key is NEVER logged or returned in any client/route value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, EngineId, WorkItem, WorkSource } from '../src/core/types.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import {
  BUILTIN_ENGINE_REGISTRY,
  resolveEngineRegistry,
  resolveEngineSpec,
} from '../src/core/run/engine-registry.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';
import { routeTask } from '../src/core/run/router.js';

// ---------------------------------------------------------------------------
// Verified NIM constants (the values M195 ships with).
// ---------------------------------------------------------------------------

const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NIM_KIMI_MODEL = 'moonshotai/kimi-k2-instruct';
const NIM_KEY_ENV = 'NVIDIA_NIM_API_KEY';
// A fake, obviously-not-real key. We assert it is used over the wire but NEVER
// surfaced in any logged/returned value.
const FAKE_KEY = 'nvapi-FAKE-key-do-not-use-0123456789';

// ---------------------------------------------------------------------------
// Config helpers (mirror m46/m128 scaffolding)
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
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
  } as WorkItem;
}

// Routing context that treats nim (+ builtin) as available. routeTask consults
// ctx.availableEngines; engineAvailable() passes when the engine is listed.
const NIM_CTX = { availableEngines: ['nim', 'builtin'] as unknown as EngineId[] };

// ---------------------------------------------------------------------------
// 1. CLIENT — request shape (mocked fetch, no live NIM call)
// ---------------------------------------------------------------------------

describe('M195 NIM client — OpenAI-compatible request shape', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello from kimi' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs to <baseUrl>/chat/completions with Bearer key + Kimi model', async () => {
    const client = buildOpenAICompatibleClient(NIM_BASE_URL, FAKE_KEY, NIM_KIMI_MODEL, true);
    const res = await client.chat([{ role: 'user', content: 'hi' }]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    // Endpoint
    expect(url).toBe(`${NIM_BASE_URL}/chat/completions`);
    expect(init.method).toBe('POST');
    // Bearer auth header carries the configured key
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    // Body carries the configured model
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(NIM_KIMI_MODEL);
    expect(Array.isArray(body.messages)).toBe(true);
    // Response is parsed
    expect(res.content).toBe('hello from kimi');
    expect(res.usage.tokensIn).toBe(11);
    expect(res.usage.tokensOut).toBe(7);
  });

  it('omits the Authorization header entirely when no key is provided', async () => {
    const client = buildOpenAICompatibleClient(NIM_BASE_URL, '', NIM_KIMI_MODEL, false);
    await client.chat([{ role: 'user', content: 'hi' }]);
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('the API key never appears in the returned client object', () => {
    const client = buildOpenAICompatibleClient(NIM_BASE_URL, FAKE_KEY, NIM_KIMI_MODEL, true);
    // The client exposes id/model/supportsTools/chat/chatStream — never the key.
    const serialized = JSON.stringify({ id: client.id, model: client.model, supportsTools: client.supportsTools });
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain('nvapi-');
  });
});

// ---------------------------------------------------------------------------
// 2. CATALOG — the engine registry includes the NIM entry
// ---------------------------------------------------------------------------

describe('M195 catalog — NIM engine entry', () => {
  it('builtin registry has a "nim" api-model entry wired to NVIDIA NIM', () => {
    const nim = BUILTIN_ENGINE_REGISTRY['nim'];
    expect(nim).toBeDefined();
    expect(nim.id).toBe('nim');
    expect(nim.kind).toBe('api-model');
    expect(nim.api?.envKey).toBe(NIM_KEY_ENV);
    expect(nim.api?.defaultBaseUrl).toBe(NIM_BASE_URL);
    expect(nim.api?.baseUrlEnv).toBe('NVIDIA_NIM_BASE_URL');
    expect(nim.api?.protocol).toBe('openai');
  });

  it('the builtin nim entry is tier "mid" (M50 invariant: no new builtin frontier)', () => {
    expect(BUILTIN_ENGINE_REGISTRY['nim'].tier).toBe('mid');
  });

  it('cfg.foundry.nim folds in the Kimi model + frontier tier on resolve', () => {
    const cfg = withFoundry({
      nim: { tier: 'frontier', model: NIM_KIMI_MODEL },
    } as NonNullable<AshlrConfig['foundry']>);
    const spec = resolveEngineSpec('nim' as EngineId, cfg)!;
    expect(spec.tier).toBe('frontier');
    expect(spec.api?.defaultModel).toBe(NIM_KIMI_MODEL);
    // base URL + key env are preserved from the builtin spec
    expect(spec.api?.defaultBaseUrl).toBe(NIM_BASE_URL);
    expect(spec.api?.envKey).toBe(NIM_KEY_ENV);
  });

  it('engineTierOf("nim", cfg) reflects the configured tier', () => {
    expect(engineTierOf('nim' as EngineId)).toBe('mid'); // no cfg → builtin mid
    const promoted = withFoundry({ nim: { tier: 'frontier' } } as NonNullable<AshlrConfig['foundry']>);
    expect(engineTierOf('nim' as EngineId, promoted)).toBe('frontier');
  });

  it('absent cfg.foundry.nim ⇒ resolved nim is byte-identical to the builtin (zero effect)', () => {
    const reg = resolveEngineRegistry(baseConfig());
    expect(reg['nim']).toEqual(BUILTIN_ENGINE_REGISTRY['nim']);
    expect(reg['nim'].tier).toBe('mid');
  });
});

// ---------------------------------------------------------------------------
// 3. ROUTING — routeBackend / routeTask select NIM as frontier when configured
// ---------------------------------------------------------------------------
//
// routeBackend's engineInstalled() probe for an api-model with a key checks the
// env var. We set NVIDIA_NIM_API_KEY in this block so the probe reports installed,
// then clear it so the GATING block can prove the absent-config no-effect path.

describe('M195 routing — NIM as frontier ammo (configured + allowed)', () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env[NIM_KEY_ENV];
    process.env[NIM_KEY_ENV] = FAKE_KEY; // makes engineInstalled('nim') true
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env[NIM_KEY_ENV];
    else process.env[NIM_KEY_ENV] = prevKey;
    vi.resetModules();
  });

  function frontierNimCfg(): AshlrConfig {
    return withFoundry({
      allowedBackends: ['builtin', 'nim'] as EngineId[],
      // promote nim to frontier + run Kimi K2
      nim: { tier: 'frontier', model: NIM_KIMI_MODEL },
      models: { nim: NIM_KIMI_MODEL } as NonNullable<AshlrConfig['foundry']>['models'],
    } as NonNullable<AshlrConfig['foundry']>);
  }

  it('routeBackend routes a hard item to nim (tier=frontier) when no other frontier is allowed', async () => {
    const { routeBackend } = await import('../src/core/fleet/router.js');
    const cfg = frontierNimCfg();
    const d = routeBackend(makeItem({ source: 'security', effort: 5, score: 10 }), cfg);
    expect(d.backend).toBe('nim');
    expect(d.tier).toBe('frontier');
    // model enrichment carries the Kimi id (cfg.foundry.models override)
    expect(d.model).toBe(NIM_KIMI_MODEL);
    // reason mentions nim — never the key
    expect(d.reason).toMatch(/nim/i);
    expect(JSON.stringify(d)).not.toContain(FAKE_KEY);
  });

  it('routeTask picks nim for a hard item when nim is the promoted frontier engine', () => {
    const cfg = frontierNimCfg();
    const r = routeTask(makeItem({ source: 'security', effort: 5, score: 9 }), cfg, NIM_CTX);
    expect(r.engine).toBe('nim');
    expect(r.model).toBe(NIM_KIMI_MODEL);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  it('routeBackend NEVER returns nim when it is not in allowedBackends', async () => {
    const { routeBackend } = await import('../src/core/fleet/router.js');
    // nim promoted to frontier but NOT allowed → must fall back to builtin
    const cfg = withFoundry({
      allowedBackends: ['builtin'] as EngineId[],
      nim: { tier: 'frontier', model: NIM_KIMI_MODEL },
    } as NonNullable<AshlrConfig['foundry']>);
    const d = routeBackend(makeItem({ source: 'security', effort: 5, score: 10 }), cfg);
    expect(d.backend).toBe('builtin');
  });
});

// ---------------------------------------------------------------------------
// 4. GATING — absent config ⇒ NIM not selectable; zero effect
// ---------------------------------------------------------------------------

describe('M195 gating — absent NIM config has zero effect', () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env[NIM_KEY_ENV];
    delete process.env[NIM_KEY_ENV]; // no key → engineInstalled('nim') is false
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env[NIM_KEY_ENV];
    else process.env[NIM_KEY_ENV] = prevKey;
  });

  it('with no foundry config at all, routeBackend falls back to builtin', async () => {
    const { routeBackend } = await import('../src/core/fleet/router.js');
    const d = routeBackend(makeItem({ source: 'security', effort: 5, score: 10 }), baseConfig());
    expect(d.backend).toBe('builtin');
    expect(d.tier).toBe('local');
  });

  it('nim allowed but NOT promoted (default mid) AND no key ⇒ not selected as frontier', async () => {
    const { routeBackend } = await import('../src/core/fleet/router.js');
    const cfg = withFoundry({ allowedBackends: ['builtin', 'nim'] as EngineId[] });
    const d = routeBackend(makeItem({ source: 'security', effort: 5, score: 10 }), cfg);
    // no NIM key in env → engineInstalled('nim') false → builtin
    expect(d.backend).toBe('builtin');
  });

  it('routeTask does not pick a frontier nim when nim is not promoted', () => {
    // nim listed available but tier stays mid (no cfg.foundry.nim) → the
    // frontier hard-path does not select it; hard item falls through to builtin.
    const cfg = withFoundry({ allowedBackends: ['builtin', 'nim'] as EngineId[] });
    const r = routeTask(makeItem({ source: 'security', effort: 5, score: 9 }), cfg, NIM_CTX);
    // Either builtin or a mid nim — but NEVER reported at frontier tier here.
    expect(engineTierOf(r.engine, cfg)).not.toBe('frontier');
  });
});

// ---------------------------------------------------------------------------
// 5. SECRET — the key is never logged/returned anywhere we surface
// ---------------------------------------------------------------------------

describe('M195 secret hygiene — NVIDIA_NIM_API_KEY never leaks', () => {
  it('resolved engine spec never embeds the key value', () => {
    const prev = process.env[NIM_KEY_ENV];
    process.env[NIM_KEY_ENV] = FAKE_KEY;
    try {
      const cfg = withFoundry({ nim: { tier: 'frontier', model: NIM_KIMI_MODEL } } as NonNullable<AshlrConfig['foundry']>);
      const spec = resolveEngineSpec('nim' as EngineId, cfg)!;
      // The spec references only the env-var NAME, never the value.
      expect(spec.api?.envKey).toBe(NIM_KEY_ENV);
      expect(JSON.stringify(spec)).not.toContain(FAKE_KEY);
    } finally {
      if (prev === undefined) delete process.env[NIM_KEY_ENV];
      else process.env[NIM_KEY_ENV] = prev;
    }
  });
});

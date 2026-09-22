/**
 * Tests for src/core/verse/local-models.ts and the capability-driven local
 * seat filter in src/core/verse/seats.ts (owner T, V2.1).
 *
 * Hermetic and fast: every runtime call goes through an injected `fetchImpl`
 * over fixture JSON, so nothing binds a port or spawns a process. The fixture
 * shapes are the REAL ones documented in docs/VERSE-TELEMETRY-V2.md — an
 * Ollama `/api/ps` row with `size_vram`, an `/api/show` body with
 * `capabilities` + `model_info`, and an LM Studio `/api/v0/models` row.
 */
import { describe, it, expect, beforeEach} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import {
  collectVerseLocalModels,
  normalizeLocalBaseUrl,
  numCtxFromShowParameters,
  nativeContextFromModelInfo,
  placementOf,
  probeLmStudioModels,
  probeOllamaModelDetail,
  VERSE_DEFAULT_LMSTUDIO_BASE,
  VERSE_DEFAULT_OLLAMA_BASE,
  VERSE_LOCAL_REACHABILITY_TIMEOUT_MS,
  VERSE_LOCAL_PROBE_TIMEOUT_MS,
  resetVerseLocalModelCache,
  VERSE_LOCAL_LAST_GOOD_TTL_MS,
} from '../src/core/verse/local-models.js';
import { discoverSeats, localSeatIsSelectable, VERSE_LOCAL_TAG_RE } from '../src/core/verse/seats.js';

// ---------------------------------------------------------------------------
// Fixtures — verbatim provider shapes
// ---------------------------------------------------------------------------

const GB = 1024 ** 3;

/** `size_vram === size` ⇒ fully on the GPU. */
const PS_FULL_GPU = {
  name: 'qwen3-coder-next:ctx64k',
  model: 'qwen3-coder-next:ctx64k',
  size: 48 * GB,
  size_vram: 48 * GB,
  expires_at: '2026-09-20T01:30:00.000Z',
  context_length: 65_536,
};

/** `0 < size_vram < size` ⇒ a layer split: the difference between fast and unusable. */
const PS_SPLIT = {
  name: 'deepseek-v3:latest',
  size: 60 * GB,
  size_vram: 20 * GB,
  expires_at: '0001-01-01T00:00:00Z', // Ollama's "no keep-alive" sentinel
};

/** `size_vram === 0` ⇒ entirely on the CPU. */
const PS_CPU = { name: 'embed-only:latest', size: 2 * GB, size_vram: 0 };

const SHOW_WITH_TOOLS = {
  parameters: 'num_ctx                        65536\nstop                           "<|im_end|>"',
  details: { parameter_size: '79.7B', quantization_level: 'Q4_K_M', family: 'qwen3moe' },
  model_info: { 'general.architecture': 'qwen3moe', 'qwen3moe.context_length': 262_144 },
  capabilities: ['completion', 'tools', 'thinking'],
};

const SHOW_NO_TOOLS = {
  details: { parameter_size: '137M', quantization_level: 'F16', family: 'nomic-bert' },
  model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 2_048 },
  capabilities: ['embedding'],
};

/** An older Ollama: no `capabilities` key at all. */
const SHOW_NO_CAPABILITIES = {
  details: { parameter_size: '3B', quantization_level: 'Q4_0', family: 'llama' },
  model_info: { 'general.architecture': 'llama', 'llama.context_length': 131_072 },
};

const LMSTUDIO_BODY = {
  object: 'list',
  data: [
    {
      id: 'qwen3-coder-30b',
      object: 'model',
      type: 'llm',
      publisher: 'qwen',
      arch: 'qwen3moe',
      compatibility_type: 'gguf',
      quantization: 'Q4_K_M',
      state: 'loaded',
      max_context_length: 262_144,
      loaded_context_length: 32_768,
    },
    {
      id: 'text-embedding-nomic',
      object: 'model',
      type: 'embeddings',
      arch: 'nomic-bert',
      quantization: 'F16',
      state: 'not-loaded',
      max_context_length: 2_048,
    },
  ],
};

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

interface Routes {
  tags?: unknown;
  ps?: unknown;
  show?: (tag: string) => unknown;
  lmstudio?: unknown;
}

function fakeFetch(routes: Routes, log?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const missing = { ok: false, status: 404, json: async () => ({}) };
    if (url.endsWith('/api/tags')) {
      log?.push('tags');
      return routes.tags === undefined ? missing : reply(routes.tags);
    }
    if (url.endsWith('/api/ps')) {
      log?.push('ps');
      return routes.ps === undefined ? missing : reply(routes.ps);
    }
    if (url.endsWith('/api/show')) {
      let tag = '';
      try { tag = String((JSON.parse(String(init?.body ?? '{}')) as { name?: string }).name ?? ''); } catch { /* ignore */ }
      log?.push(`show:${tag}`);
      return routes.show === undefined ? missing : reply(routes.show(tag));
    }
    if (url.endsWith('/api/v0/models')) {
      log?.push('lmstudio');
      return routes.lmstudio === undefined ? missing : reply(routes.lmstudio);
    }
    return missing;
  }) as unknown as typeof fetch;
}

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://127.0.0.1:1234', ollama: 'http://127.0.0.1:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  } as unknown as AshlrConfig;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('verse local models — helpers', () => {
  it('reads the GPU/CPU split from size vs size_vram', () => {
    expect(placementOf(48 * GB, 48 * GB)).toBe('gpu');
    expect(placementOf(60 * GB, 20 * GB)).toBe('split');
    expect(placementOf(2 * GB, 0)).toBe('cpu');
    // No signal is not a placement claim.
    expect(placementOf(null, null)).toBe('unknown');
    expect(placementOf(10, null)).toBe('unknown');
  });

  it('parses num_ctx and the architecture context length', () => {
    expect(numCtxFromShowParameters(SHOW_WITH_TOOLS.parameters)).toBe(65_536);
    expect(numCtxFromShowParameters('temperature 0.7')).toBeNull();
    expect(numCtxFromShowParameters(undefined)).toBeNull();
    expect(nativeContextFromModelInfo(SHOW_WITH_TOOLS.model_info)).toEqual({ value: 262_144, arch: 'qwen3moe' });
    expect(nativeContextFromModelInfo({})).toEqual({ value: null, arch: null });
  });

  it('normalizes base urls, stripping a trailing slash and /v1', () => {
    expect(normalizeLocalBaseUrl('http://localhost:11434/v1/', VERSE_DEFAULT_OLLAMA_BASE)).toBe('http://localhost:11434');
    expect(normalizeLocalBaseUrl('', VERSE_DEFAULT_OLLAMA_BASE)).toBe(VERSE_DEFAULT_OLLAMA_BASE);
    expect(normalizeLocalBaseUrl(undefined, VERSE_DEFAULT_LMSTUDIO_BASE)).toBe(VERSE_DEFAULT_LMSTUDIO_BASE);
  });
});

// ---------------------------------------------------------------------------
// /api/show
// ---------------------------------------------------------------------------

describe('verse local models — /api/show', () => {
  it('surfaces tool capability as a first-class fact and prefers num_ctx over the arch maximum', async () => {
    const detail = await probeOllamaModelDetail(
      fakeFetch({ show: () => SHOW_WITH_TOOLS }), 'http://x', 'qwen3-coder-next:ctx64k');
    expect(detail).not.toBeNull();
    expect(detail!.supportsTools).toBe(true);
    expect(detail!.capabilities).toEqual(['completion', 'tools', 'thinking']);
    // `num_ctx` is the effective window; `model_info` is the architecture max.
    expect(detail!.contextWindow).toBe(65_536);
    expect(detail!.nativeContextLength).toBe(262_144);
    expect(detail!.parameterSize).toBe('79.7B');
    expect(detail!.quantization).toBe('Q4_K_M');
    expect(detail!.family).toBe('qwen3moe');
    expect(detail!.arch).toBe('qwen3moe');
  });

  it('reports a model that cannot drive an agent as supportsTools: false', async () => {
    const detail = await probeOllamaModelDetail(fakeFetch({ show: () => SHOW_NO_TOOLS }), 'http://x', 'nomic');
    expect(detail!.supportsTools).toBe(false);
    expect(detail!.contextWindow).toBe(2_048);
  });

  it('distinguishes "no capabilities reported" from "no tools"', async () => {
    const detail = await probeOllamaModelDetail(fakeFetch({ show: () => SHOW_NO_CAPABILITIES }), 'http://x', 'llama3.2:3b');
    expect(detail!.supportsTools).toBeNull();
    expect(detail!.capabilities).toEqual([]);
  });

  it('degrades to null instead of throwing when the runtime is gone', async () => {
    await expect(probeOllamaModelDetail(fakeFetch({}), 'http://x', 'anything')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full sweep
// ---------------------------------------------------------------------------

describe('verse local models — collectVerseLocalModels', () => {
  it('joins /api/ps residency to /api/show shape, with memory fit against the machine', async () => {
    const snapshot = await collectVerseLocalModels({
      fetchImpl: fakeFetch({
        tags: { models: [{ name: 'qwen3-coder-next:ctx64k' }, { name: 'deepseek-v3:latest' }, { name: 'embed-only:latest' }] },
        ps: { models: [PS_FULL_GPU, PS_SPLIT, PS_CPU] },
        show: (tag) => (tag === 'embed-only:latest' ? SHOW_NO_TOOLS : SHOW_WITH_TOOLS),
        lmstudio: LMSTUDIO_BODY,
      }),
    });

    expect(snapshot.ollama.reachable).toBe(true);
    expect(snapshot.ollama.reason).toBeNull();
    expect(snapshot.machine.totalMemoryBytes).toBe(os.totalmem());

    const qwen = snapshot.ollama.models.find((m) => m.id === 'qwen3-coder-next:ctx64k')!;
    expect(qwen.state).toBe('loaded');
    expect(qwen.placement).toBe('gpu');
    expect(qwen.gpuPercent).toBe(100);
    expect(qwen.sizeVramBytes).toBe(48 * GB);
    expect(qwen.expiresAt).toBe('2026-09-20T01:30:00.000Z');
    // /api/ps reports the loaded instance's context; /api/show the arch max.
    expect(qwen.contextLength).toBe(65_536);
    expect(qwen.nativeContextLength).toBe(262_144);
    expect(qwen.supportsTools).toBe(true);
    expect(qwen.memoryPercent).toBe(
      Math.round(Math.max(0, Math.min(100, (48 * GB / os.totalmem()) * 100)) * 10) / 10);

    const split = snapshot.ollama.models.find((m) => m.id === 'deepseek-v3:latest')!;
    expect(split.placement).toBe('split');
    expect(split.gpuPercent).toBeCloseTo(33.3, 1);
    // The "0001-01-01" keep-alive sentinel is NOT an expiry.
    expect(split.expiresAt).toBeNull();

    const cpu = snapshot.ollama.models.find((m) => m.id === 'embed-only:latest')!;
    expect(cpu.placement).toBe('cpu');
    expect(cpu.gpuPercent).toBe(0);
    expect(cpu.supportsTools).toBe(false);

    expect(snapshot.notes.some((n) => n.includes('cannot drive an agentic session'))).toBe(true);
  });

  it('marks installed-but-not-resident models as available with no residency claims', async () => {
    const snapshot = await collectVerseLocalModels({
      fetchImpl: fakeFetch({
        tags: { models: [{ name: 'qwen3-coder-next:ctx64k', size: 48 * GB }] },
        ps: { models: [] },
        show: () => SHOW_WITH_TOOLS,
      }),
    });
    const model = snapshot.ollama.models[0]!;
    expect(model.state).toBe('available');
    expect(model.sizeVramBytes).toBeNull();
    expect(model.placement).toBe('unknown');
    expect(model.gpuPercent).toBeNull();
    expect(model.expiresAt).toBeNull();
  });

  it('reads LM Studio availability from /api/v0/models', async () => {
    const report = await probeLmStudioModels(fakeFetch({ lmstudio: LMSTUDIO_BODY }), 'http://127.0.0.1:1234');
    expect(report.reachable).toBe(true);
    const loaded = report.models.find((m) => m.id === 'qwen3-coder-30b')!;
    expect(loaded.state).toBe('loaded');
    expect(loaded.nativeContextLength).toBe(262_144);
    expect(loaded.contextLength).toBe(32_768);
    expect(loaded.quantization).toBe('Q4_K_M');
    expect(loaded.arch).toBe('qwen3moe');
    // This endpoint carries no tool-capability field: unknown, never false.
    expect(loaded.supportsTools).toBeNull();
    expect(report.models.find((m) => m.id === 'text-embedding-nomic')!.state).toBe('available');
  });

  it('degrades each runtime independently and never throws', async () => {
    const snapshot = await collectVerseLocalModels({ fetchImpl: fakeFetch({ lmstudio: LMSTUDIO_BODY }) });
    expect(snapshot.ollama.reachable).toBe(false);
    expect(snapshot.ollama.reason).toBe('ollama-unreachable');
    expect(snapshot.ollama.models).toEqual([]);
    expect(snapshot.lmStudio.reachable).toBe(true);

    const both = await collectVerseLocalModels({ fetchImpl: fakeFetch({}) });
    expect(both.ollama.reason).toBe('ollama-unreachable');
    expect(both.lmStudio.reason).toBe('lmstudio-unreachable');
  });
});

// ---------------------------------------------------------------------------
// Seat visibility — capability replaces the name heuristic
// ---------------------------------------------------------------------------

describe('verse seats — local seat visibility by tool capability', () => {
  const detail = (supportsTools: boolean | null) => ({
    contextWindow: 4_096,
    nativeContextLength: 4_096,
    capabilities: supportsTools === null ? [] : supportsTools ? ['tools'] : ['embedding'],
    supportsTools,
    parameterSize: null,
    quantization: null,
    family: null,
    arch: null,
  });

  it('decides on the reported capability, and falls back to the legacy name regex only when unknown', () => {
    expect(localSeatIsSelectable(detail(true), 'mistral-small')).toBe(true);
    expect(localSeatIsSelectable(detail(false), 'qwen3-coder-next')).toBe(false);
    // Unknown ⇒ the legacy heuristic, so an old Ollama does not empty the picker.
    expect(localSeatIsSelectable(detail(null), 'qwen3-coder-next')).toBe(VERSE_LOCAL_TAG_RE.test('qwen3-coder-next'));
    expect(localSeatIsSelectable(null, 'nomic-embed-text')).toBe(false);
  });

  it('shows a tool-capable model whose name matches nothing, and hides a coder-named model without tools', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-localseats-'));
    try {
      fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify({ accounts: [] }));
      const discovery = await discoverSeats(makeConfig(), {
        accountsRoot: root,
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        claudeUsage: () => ({ tokens5h: 0, tokens7d: 0, messages5h: 0, messages7d: 0, readAt: 0, filesScanned: 0 }),
        fetchImpl: fakeFetch({
          tags: { models: [{ name: 'mistral-small:latest' }, { name: 'qwen3-coder-embed:latest' }] },
          ps: { models: [] },
          show: (tag) => (tag === 'mistral-small:latest' ? SHOW_WITH_TOOLS : SHOW_NO_TOOLS),
        }),
      });
      const ids = discovery.seats.map((s) => s.id);
      expect(ids).toContain('local:mistral-small:latest');
      expect(ids).not.toContain('local:qwen3-coder-embed:latest');
      // The effective window comes from /api/show, not from the tag name.
      expect(discovery.seats.find((s) => s.id === 'local:mistral-small:latest')!.contextWindow).toBe(65_536);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('reachability probes get a longer budget than detail probes', () => {
  // The known-good cache is module-level by design (it is a per-process memory
  // of the runtime). Each case here asserts probe behaviour, not retention.
  beforeEach(() => resetVerseLocalModelCache());

  it('reports a timed-out runtime as a timeout, not as absent', async () => {
    // A 2s-budget probe starved by the Usage section's own seven-read burst
    // used to declare the whole local stack "unreachable". The two claims are
    // different and the operator needs to be told which one happened.
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/api/tags')) {
        const err = new Error('timed out');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const report = await collectVerseLocalModels({ fetchImpl, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    expect(report.ollama.reachable).toBe(false);
    expect(report.ollama.reason).toBe('ollama-timeout');
  });

  it('still reports a refused runtime as unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const report = await collectVerseLocalModels({ fetchImpl, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    expect(report.ollama.reachable).toBe(false);
    expect(report.ollama.reason).toBe('ollama-unreachable');
  });

  it('gives reachability a budget well above the per-model detail timeout', () => {
    expect(VERSE_LOCAL_REACHABILITY_TIMEOUT_MS).toBeGreaterThan(VERSE_LOCAL_PROBE_TIMEOUT_MS * 2);
  });
});

describe('a timed-out probe does not erase a known-good reading', () => {
  beforeEach(() => resetVerseLocalModelCache());

  function fetchThat(mode: { fail: 'none' | 'timeout' | 'refused' }): typeof fetch {
    return (async (url: string) => {
      if (mode.fail !== 'none') {
        const err = new Error(mode.fail);
        err.name = mode.fail === 'timeout' ? 'TimeoutError' : 'TypeError';
        throw err;
      }
      if (String(url).includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3-coder:30b', size: 1000 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('serves the last good report, marked stale, when a later probe times out', async () => {
    const mode: { fail: 'none' | 'timeout' | 'refused' } = { fail: 'none' };
    const fetchImpl = fetchThat(mode);
    const first = await collectVerseLocalModels({ fetchImpl, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    expect(first.ollama.reachable).toBe(true);
    expect(first.ollama.stale).toBeUndefined();

    mode.fail = 'timeout';
    const second = await collectVerseLocalModels({ fetchImpl, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    expect(second.ollama.reachable).toBe(true);
    expect(second.ollama.stale).toBe(true);
    expect(second.ollama.models).toHaveLength(1);
    expect(second.ollama.reason).toBe('ollama-timeout');
    expect(second.ollama.staleForMs).toBeGreaterThanOrEqual(0);
  });

  it('never masks a REFUSED connection — absence is real evidence', async () => {
    const mode: { fail: 'none' | 'timeout' | 'refused' } = { fail: 'none' };
    const fetchImpl = fetchThat(mode);
    await collectVerseLocalModels({ fetchImpl, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    mode.fail = 'refused';
    const after = await collectVerseLocalModels({ fetchImpl, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    expect(after.ollama.reachable).toBe(false);
    expect(after.ollama.reason).toBe('ollama-unreachable');
    expect(after.ollama.stale).toBeUndefined();
  });

  it('lets the retained reading expire rather than serving it forever', async () => {
    const mode: { fail: 'none' | 'timeout' | 'refused' } = { fail: 'none' };
    const fetchImpl = fetchThat(mode);
    await collectVerseLocalModels({ fetchImpl, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    mode.fail = 'timeout';
    const expired = await collectVerseLocalModels({
      fetchImpl,
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      lastGoodTtlMs: 0,
    });
    expect(expired.ollama.reachable).toBe(false);
    expect(expired.ollama.models).toHaveLength(0);
  });

  it('retains for a bounded window, not indefinitely', () => {
    expect(VERSE_LOCAL_LAST_GOOD_TTL_MS).toBeGreaterThan(0);
    expect(VERSE_LOCAL_LAST_GOOD_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});

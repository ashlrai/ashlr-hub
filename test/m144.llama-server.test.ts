/**
 * m144.llama-server.test.ts — M144: llama-server engine adapter (EAGLE-3 speculative
 * decoding + continuous batching + prefix-cache) and 2026 local-model catalog update.
 *
 * Mirrors m117/m128/m132 conventions: vi.doMock for module isolation, randomUUID
 * cache-busting for fresh module imports, mock node-http for probe tests.
 *
 * TEST GROUPS:
 *   1. buildLlamaServerBaseUrl — cfg override > env > default (localhost:8080/v1)
 *   2. engineInstalled('llama-server') — probes configured URL via Node http child process
 *   3. engineInstalled('llama-server') — returns false when server unreachable
 *   4. buildEngineCommand('llama-server') — returns null (api-model, no CLI argv)
 *   5. Ollama default unchanged — engineInstalled('local-coder') probes :11434 (flag-off parity)
 *   6. 2026 catalog entries — qwen3-coder-next, qwen3-coder-30b-a3b, deepseek-r1-distill-70b
 *   7. pickModel on llama-server — coder/long-context/reasoning capability routing
 *   8. KNOWN_MODELS integrity — all entries have required fields
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. buildLlamaServerBaseUrl — config override priority
// ---------------------------------------------------------------------------

describe('M144 buildLlamaServerBaseUrl — URL resolution priority', () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env['LLAMA_SERVER_BASE_URL'];
  });

  it('returns http://localhost:8080/v1 when no cfg or env set (default)', async () => {
    const { buildLlamaServerBaseUrl } = await import('../src/core/run/engines.js');
    const url = buildLlamaServerBaseUrl(undefined);
    expect(url).toBe('http://localhost:8080/v1');
  });

  it('returns cfg.models.llamaServer.baseUrl when set (highest priority)', async () => {
    const { buildLlamaServerBaseUrl } = await import('../src/core/run/engines.js');
    const cfg = { models: { llamaServer: { baseUrl: 'http://192.168.1.10:8080/v1' } } } as never;
    const url = buildLlamaServerBaseUrl(cfg);
    expect(url).toBe('http://192.168.1.10:8080/v1');
  });

  it('returns LLAMA_SERVER_BASE_URL env var when cfg has no override', async () => {
    process.env['LLAMA_SERVER_BASE_URL'] = 'http://localhost:9090/v1';
    const { buildLlamaServerBaseUrl } = await import('../src/core/run/engines.js');
    const url = buildLlamaServerBaseUrl(undefined);
    expect(url).toBe('http://localhost:9090/v1');
  });

  it('cfg override takes precedence over env var', async () => {
    process.env['LLAMA_SERVER_BASE_URL'] = 'http://env-host:8080/v1';
    const { buildLlamaServerBaseUrl } = await import('../src/core/run/engines.js');
    const cfg = { models: { llamaServer: { baseUrl: 'http://cfg-host:8080/v1' } } } as never;
    const url = buildLlamaServerBaseUrl(cfg);
    expect(url).toBe('http://cfg-host:8080/v1');
  });

  it('whitespace-only cfg.baseUrl falls through to env', async () => {
    process.env['LLAMA_SERVER_BASE_URL'] = 'http://env-host:9090/v1';
    const { buildLlamaServerBaseUrl } = await import('../src/core/run/engines.js');
    const cfg = { models: { llamaServer: { baseUrl: '   ' } } } as never;
    const url = buildLlamaServerBaseUrl(cfg);
    expect(url).toBe('http://env-host:9090/v1');
  });
});

// ---------------------------------------------------------------------------
// 2. engineInstalled('llama-server') — probes the configured URL (healthy)
// ---------------------------------------------------------------------------

describe('M144 engineInstalled llama-server — Node-http probe healthy', () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env['LLAMA_SERVER_BASE_URL'];
  });

  it('uses Node child process (process.execPath) to probe http://localhost:8080/v1/models', async () => {
    const calls: Array<[string, string[]]> = [];

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: (cmd: string, args?: string[], _opts?: object) => {
          calls.push([cmd, args ?? []]);
          return { status: 0, stdout: '', stderr: '', pid: 1, output: [] };
        },
      };
    });

    const { engineInstalled } = await import('../src/core/run/engines.js?bust-ls-' + randomUUID());
    const result = engineInstalled('llama-server' as never);

    // Must probe via Node process, not curl
    const nodeCalls = calls.filter(([cmd]) => cmd === process.execPath);
    const curlCalls = calls.filter(([cmd]) => cmd === 'curl');
    expect(nodeCalls.length).toBeGreaterThan(0);
    expect(curlCalls.length).toBe(0);
    expect(result).toBe(true);

    // The probe URL must target port 8080 (llama-server default), not 11434 (Ollama)
    const probeScript = nodeCalls[0]?.[1]?.find((a) => a?.includes('localhost:8080')) ?? '';
    expect(probeScript).toContain('localhost:8080');
  });

  it('probes the cfg-override URL when cfg.models.llamaServer.baseUrl is set', async () => {
    const calls: Array<[string, string[]]> = [];

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: (cmd: string, args?: string[], _opts?: object) => {
          calls.push([cmd, args ?? []]);
          return { status: 0, stdout: '', stderr: '', pid: 1, output: [] };
        },
      };
    });

    const { engineInstalled } = await import('../src/core/run/engines.js?bust-cfg-' + randomUUID());
    const cfg = { models: { llamaServer: { baseUrl: 'http://192.168.1.5:8080/v1' } } } as never;
    const result = engineInstalled('llama-server' as never, cfg);

    expect(result).toBe(true);
    const nodeCalls = calls.filter(([cmd]) => cmd === process.execPath);
    expect(nodeCalls.length).toBeGreaterThan(0);
    // URL in probe script should reference the cfg-override host
    const probeScript = nodeCalls[0]?.[1]?.find((a) => typeof a === 'string' && a.includes('192.168.1.5')) ?? '';
    expect(probeScript).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. engineInstalled('llama-server') — returns false when server unreachable
// ---------------------------------------------------------------------------

describe('M144 engineInstalled llama-server — Node-http probe unhealthy', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns false when Node probe exits with status 1 (llama-server not running)', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: () => ({ status: 1, stdout: '', stderr: '', pid: 1, output: [] }),
      };
    });

    const { engineInstalled } = await import('../src/core/run/engines.js?bust-unr-' + randomUUID());
    expect(engineInstalled('llama-server' as never)).toBe(false);
  });

  it('returns false when spawnSync throws (hard failure)', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: () => { throw new Error('spawn failed'); },
      };
    });

    const { engineInstalled } = await import('../src/core/run/engines.js?bust-thr-' + randomUUID());
    expect(engineInstalled('llama-server' as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. buildEngineCommand('llama-server') — returns null (api-model, no CLI argv)
// ---------------------------------------------------------------------------

describe('M144 buildEngineCommand llama-server — returns null', () => {
  it('buildEngineCommand for llama-server is null (api-model has no CLI argv)', async () => {
    const { buildEngineCommand } = await import('../src/core/run/engines.js');
    const result = buildEngineCommand('llama-server' as never, 'test goal', {} as never, {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Ollama default unchanged — flag-off parity
// ---------------------------------------------------------------------------

describe('M144 flag-off parity — Ollama (local-coder) unchanged when llamaServer unconfigured', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('engineInstalled(local-coder) still probes localhost:11434 (Ollama default)', async () => {
    const calls: Array<[string, string[]]> = [];

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        spawnSync: (cmd: string, args?: string[], _opts?: object) => {
          calls.push([cmd, args ?? []]);
          return { status: 0, stdout: '', stderr: '', pid: 1, output: [] };
        },
      };
    });

    const { engineInstalled } = await import('../src/core/run/engines.js?bust-ol-' + randomUUID());
    engineInstalled('local-coder' as never);

    const nodeCalls = calls.filter(([cmd]) => cmd === process.execPath);
    expect(nodeCalls.length).toBeGreaterThan(0);
    const probeScript = nodeCalls[0]?.[1]?.find((a) => typeof a === 'string' && a.includes('11434')) ?? '';
    expect(probeScript).toContain('11434');
  });

  it('buildEngineCommand(local-coder) returns null (api-model, unchanged)', async () => {
    const { buildEngineCommand } = await import('../src/core/run/engines.js');
    expect(buildEngineCommand('local-coder' as never, 'goal', {} as never, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. 2026 catalog entries — shape + capability tags
// ---------------------------------------------------------------------------

describe('M144 model-catalog — 2026 llama-server entries', () => {
  it('qwen3-coder-next exists with coder + long-context capabilities and tier=large', async () => {
    const { KNOWN_MODELS } = await import('../src/core/run/model-catalog.js');
    const entry = KNOWN_MODELS.find((m) => m.id === 'llama-server:qwen3-coder-next');
    expect(entry).toBeDefined();
    expect(entry!.engine).toBe('llama-server');
    expect(entry!.tier).toBe('large');
    expect(entry!.capabilities).toContain('coder');
    expect(entry!.capabilities).toContain('long-context');
    expect(entry!.costPerMTokIn).toBe(0);
    expect(entry!.costPerMTokOut).toBe(0);
    expect(entry!.minEffort).toBe(1);
  });

  it('qwen3-coder-30b-a3b exists with coder capability and tier=mid', async () => {
    const { KNOWN_MODELS } = await import('../src/core/run/model-catalog.js');
    const entry = KNOWN_MODELS.find((m) => m.id === 'llama-server:qwen3-coder-30b-a3b');
    expect(entry).toBeDefined();
    expect(entry!.engine).toBe('llama-server');
    expect(entry!.tier).toBe('mid');
    expect(entry!.capabilities).toContain('coder');
    expect(entry!.costPerMTokIn).toBe(0);
    expect(entry!.minEffort).toBe(1);
  });

  it('deepseek-r1-distill-70b exists with reasoning + long-context and tier=large', async () => {
    const { KNOWN_MODELS } = await import('../src/core/run/model-catalog.js');
    const entry = KNOWN_MODELS.find((m) => m.id === 'llama-server:deepseek-r1-distill-70b');
    expect(entry).toBeDefined();
    expect(entry!.engine).toBe('llama-server');
    expect(entry!.tier).toBe('large');
    expect(entry!.capabilities).toContain('reasoning');
    expect(entry!.capabilities).toContain('long-context');
    expect(entry!.costPerMTokIn).toBe(0);
    expect(entry!.minEffort).toBe(2);
  });

  it('all three 2026 entries are present', async () => {
    const { KNOWN_MODELS } = await import('../src/core/run/model-catalog.js');
    const llamaEntries = KNOWN_MODELS.filter((m) => m.engine === ('llama-server' as never));
    const ids = llamaEntries.map((m) => m.id);
    expect(ids).toContain('llama-server:qwen3-coder-next');
    expect(ids).toContain('llama-server:qwen3-coder-30b-a3b');
    expect(ids).toContain('llama-server:deepseek-r1-distill-70b');
    expect(llamaEntries.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 7. pickModel on llama-server — capability routing
// ---------------------------------------------------------------------------

describe('M144 pickModel — llama-server capability routing', () => {
  it('pickModel({engine:llama-server, capability:coder}) -> qwen3-coder-next (tier:large wins)', async () => {
    const { pickModel } = await import('../src/core/run/model-catalog.js');
    const entry = pickModel({ engine: 'llama-server' as never, capability: 'coder' });
    expect(entry).not.toBeNull();
    // qwen3-coder-next is tier:large; qwen3-coder-30b-a3b is tier:mid — large wins
    expect(entry!.id).toBe('llama-server:qwen3-coder-next');
  });

  it('pickModel({engine:llama-server, capability:reasoning}) -> deepseek-r1-distill-70b', async () => {
    const { pickModel } = await import('../src/core/run/model-catalog.js');
    const entry = pickModel({ engine: 'llama-server' as never, capability: 'reasoning' });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('llama-server:deepseek-r1-distill-70b');
  });

  it('pickModel({engine:llama-server, capability:long-context}) -> qwen3-coder-next or deepseek-r1-distill-70b', async () => {
    const { pickModel } = await import('../src/core/run/model-catalog.js');
    const entry = pickModel({ engine: 'llama-server' as never, capability: 'long-context' });
    expect(entry).not.toBeNull();
    // Both qwen3-coder-next and deepseek-r1-distill-70b have long-context + tier:large
    // pickModel sorts by tier desc then cost asc — both are free tier:large, first in array wins
    expect(['llama-server:qwen3-coder-next', 'llama-server:deepseek-r1-distill-70b']).toContain(entry!.id);
  });

  it('pickModel({engine:llama-server}) no capability -> qwen3-coder-next (tier:large, first)', async () => {
    const { pickModel } = await import('../src/core/run/model-catalog.js');
    const entry = pickModel({ engine: 'llama-server' as never });
    expect(entry).not.toBeNull();
    expect(entry!.tier).toBe('large');
  });

  it('pickModel({engine:llama-server, capability:coder, preferCheap:true}) -> mid wins over large (same cost=0)', async () => {
    const { pickModel } = await import('../src/core/run/model-catalog.js');
    // preferCheap: both free (cost 0), tie-break by tier asc -> mid before large
    const entry = pickModel({ engine: 'llama-server' as never, capability: 'coder', preferCheap: true });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('llama-server:qwen3-coder-30b-a3b'); // tier:mid wins on cost tie
  });

  it('pickModel({engine:llama-server, capability:coder, maxEffort:1}) -> includes both coder entries', async () => {
    const { pickModel } = await import('../src/core/run/model-catalog.js');
    const entry = pickModel({ engine: 'llama-server' as never, capability: 'coder', maxEffort: 1 });
    expect(entry).not.toBeNull();
    expect(entry!.capabilities).toContain('coder');
  });

  it('pickModel({engine:llama-server, capability:reasoning, maxEffort:1}) -> null (deepseek minEffort=2)', async () => {
    const { pickModel } = await import('../src/core/run/model-catalog.js');
    const entry = pickModel({ engine: 'llama-server' as never, capability: 'reasoning', maxEffort: 1 });
    // deepseek-r1-distill-70b has minEffort=2 > maxEffort=1 -> excluded -> null
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. KNOWN_MODELS integrity — all entries have required fields
// ---------------------------------------------------------------------------

describe('M144 KNOWN_MODELS — all entries pass structural integrity check', () => {
  it('all entries have required fields with correct types', async () => {
    const { KNOWN_MODELS } = await import('../src/core/run/model-catalog.js');
    for (const m of KNOWN_MODELS) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.engine).toBe('string');
      expect(['small', 'mid', 'large']).toContain(m.tier);
      expect(typeof m.costPerMTokIn).toBe('number');
      expect(typeof m.costPerMTokOut).toBe('number');
      expect(Array.isArray(m.capabilities)).toBe(true);
      expect(m.capabilities.length).toBeGreaterThan(0);
      expect([1, 2, 3, 4, 5]).toContain(m.minEffort);
    }
  });

  it('KNOWN_MODELS contains all pre-M144 engines unchanged (regression guard)', async () => {
    const { KNOWN_MODELS } = await import('../src/core/run/model-catalog.js');
    const engines = new Set(KNOWN_MODELS.map((m) => m.engine));
    expect(engines.has('claude')).toBe(true);
    expect(engines.has('codex')).toBe(true);
    expect(engines.has('local-coder' as never)).toBe(true);
    expect(engines.has('nim' as never)).toBe(true);
    expect(engines.has('llama-server' as never)).toBe(true);
  });

  it('catalogFor(llama-server) returns exactly 3 entries (M144)', async () => {
    const { catalogFor } = await import('../src/core/run/model-catalog.js');
    const entries = catalogFor('llama-server' as never);
    expect(entries).toHaveLength(3);
  });

  it('costOf(llama-server:qwen3-coder-next) is 0 (free local)', async () => {
    const { costOf } = await import('../src/core/run/model-catalog.js');
    expect(costOf('llama-server:qwen3-coder-next')).toBe(0);
  });

  it('pre-M144 local-coder models still present (regression guard)', async () => {
    const { KNOWN_MODELS } = await import('../src/core/run/model-catalog.js');
    const ids = KNOWN_MODELS.map((m) => m.id);
    expect(ids).toContain('local-coder:qwen2.5:72b');
    expect(ids).toContain('local-coder:qwen2.5-coder:32b');
    expect(ids).toContain('local-coder:deepseek-r1:32b');
    expect(ids).toContain('local-coder:small');
  });
});

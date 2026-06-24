/**
 * M92 — NIM / OpenAI-compatible engines: operational proof.
 *
 * Four test groups, all hermetic (no real network, no spawn):
 *
 *   1. REGISTRY — nim/kimi/openai-compat resolve from BUILTIN_ENGINE_REGISTRY
 *      with correct api specs; they are NOT in default allowedBackends (opt-in
 *      parity preserved); malformed api-model is dropped, never promoted.
 *
 *   2. TIER GUARDRAIL — nim/kimi/openai-compat are mid-tier (branch-only);
 *      buildEngineCommand returns null (driven via run loop, not CLI argv).
 *
 *   3. SMOKE TEST — buildOpenAICompatibleClient drives a full
 *      tool-call → tool-result → completion cycle against a mocked endpoint.
 *      This is the operational proof that the NIM/OpenAI-compat path works
 *      end-to-end without real network.
 *
 *   4. PROBING — probeApiModelEngine returns correct readiness shape based
 *      on env-var presence and mocked fetch responses.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { AshlrConfig, EngineSpec } from '../src/core/types.js';
import {
  BUILTIN_ENGINE_REGISTRY,
  resolveEngineRegistry,
  resolveEngineSpec,
} from '../src/core/run/engine-registry.js';
import { buildEngineCommand } from '../src/core/run/engines.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import { probeApiModelEngine } from '../src/core/providers.js';
import type { ChatMessage } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

function makeMessages(texts: string[] = ['hello']): ChatMessage[] {
  return texts.map((content, i) => ({
    role: i === 0 ? ('user' as const) : ('assistant' as const),
    content,
  }));
}

/** Build a mock Response with a JSON body. */
function mockJson(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** Standard OpenAI tool-call response. */
function toolCallResponse(toolName: string, toolArgs: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_m92_test',
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(toolArgs) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 12 },
  };
}

/** Standard OpenAI text completion response. */
function textResponse(content: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  };
}

/** OpenAI /v1/models response with a list of model ids. */
function modelsListResponse(ids: string[]): unknown {
  return { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) };
}

// ---------------------------------------------------------------------------
// 1. REGISTRY
// ---------------------------------------------------------------------------

describe('M92 registry — builtin api-model entries (nim / kimi / openai-compat)', () => {
  it('nim is present in BUILTIN_ENGINE_REGISTRY with correct api spec', () => {
    const spec = BUILTIN_ENGINE_REGISTRY['nim'];
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('api-model');
    expect(spec!.tier).toBe('mid');
    expect(spec!.api).toBeDefined();
    expect(spec!.api!.envKey).toBe('NVIDIA_NIM_API_KEY');
    expect(spec!.api!.defaultBaseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(spec!.api!.defaultModel).toBe('meta/llama-3.1-70b-instruct');
    expect(spec!.api!.protocol).toBe('openai');
  });

  it('kimi is present with correct Moonshot api spec', () => {
    const spec = BUILTIN_ENGINE_REGISTRY['kimi'];
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('api-model');
    expect(spec!.tier).toBe('mid');
    expect(spec!.api!.envKey).toBe('MOONSHOT_API_KEY');
    expect(spec!.api!.defaultBaseUrl).toBe('https://api.moonshot.ai/v1');
    expect(spec!.api!.defaultModel).toBe('kimi-k2-0711-preview');
    expect(spec!.api!.protocol).toBe('openai');
  });

  it('openai-compat is present with a generic api spec', () => {
    const spec = BUILTIN_ENGINE_REGISTRY['openai-compat'];
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('api-model');
    expect(spec!.tier).toBe('mid');
    expect(spec!.api!.envKey).toBe('OPENAI_COMPAT_API_KEY');
    expect(spec!.api!.protocol).toBe('openai');
  });

  it('resolveEngineRegistry includes nim/kimi/openai-compat even without foundry config', () => {
    const reg = resolveEngineRegistry(makeConfig());
    expect(reg['nim']).toBeDefined();
    expect(reg['kimi']).toBeDefined();
    expect(reg['openai-compat']).toBeDefined();
  });

  it('resolveEngineSpec finds nim by id', () => {
    const spec = resolveEngineSpec('nim', makeConfig());
    expect(spec?.id).toBe('nim');
    expect(spec?.kind).toBe('api-model');
  });

  it('nim/kimi/openai-compat are NOT in the default builtin set of cli/builtin engines', () => {
    // These engines have no bin — they are driven via the run loop, not CLI.
    expect(BUILTIN_ENGINE_REGISTRY['nim']!.bin).toBeUndefined();
    expect(BUILTIN_ENGINE_REGISTRY['kimi']!.bin).toBeUndefined();
    expect(BUILTIN_ENGINE_REGISTRY['openai-compat']!.bin).toBeUndefined();
  });

  it('a cfg.foundry.engines entry for nim overrides the builtin with merged fields', () => {
    const override: EngineSpec = {
      id: 'nim',
      kind: 'api-model',
      tier: 'mid',
      api: {
        envKey: 'NVIDIA_NIM_API_KEY',
        defaultBaseUrl: 'https://custom.nim.example.com/v1',
        defaultModel: 'meta/llama-3.1-405b-instruct',
        protocol: 'openai',
      },
    };
    const cfg = makeConfig({ foundry: { engines: { nim: override } } } as Partial<AshlrConfig>);
    const spec = resolveEngineSpec('nim', cfg);
    expect(spec?.api?.defaultBaseUrl).toBe('https://custom.nim.example.com/v1');
    expect(spec?.api?.defaultModel).toBe('meta/llama-3.1-405b-instruct');
  });

  it('a malformed api-model (no tier) is dropped — never promoted to frontier', () => {
    const bad = {
      id: 'sneaky-nim',
      kind: 'api-model',
      // tier intentionally omitted
      api: { envKey: 'NVIDIA_NIM_API_KEY', protocol: 'openai' },
    } as unknown as EngineSpec;
    const cfg = makeConfig({
      foundry: { engines: { 'sneaky-nim': bad } },
    } as Partial<AshlrConfig>);
    const reg = resolveEngineRegistry(cfg);
    expect(reg['sneaky-nim']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. TIER GUARDRAIL
// ---------------------------------------------------------------------------

describe('M92 tier guardrail — api-model engines are mid, not frontier', () => {
  const cfg = makeConfig();
  const GOAL = 'add a smoke test for NIMs';
  const CWD = '/tmp/ashlr-wt-nim';

  it('nim tier is mid — never frontier (cannot reach main)', () => {
    expect(resolveEngineSpec('nim', cfg)?.tier).toBe('mid');
  });

  it('kimi tier is mid', () => {
    expect(resolveEngineSpec('kimi', cfg)?.tier).toBe('mid');
  });

  it('openai-compat tier is mid', () => {
    expect(resolveEngineSpec('openai-compat', cfg)?.tier).toBe('mid');
  });

  it('buildEngineCommand returns null for nim (no CLI argv; driven via run loop)', () => {
    expect(buildEngineCommand('nim' as never, GOAL, cfg, { cwd: CWD })).toBeNull();
  });

  it('buildEngineCommand returns null for kimi', () => {
    expect(buildEngineCommand('kimi' as never, GOAL, cfg, { cwd: CWD })).toBeNull();
  });

  it('buildEngineCommand returns null for openai-compat', () => {
    expect(buildEngineCommand('openai-compat' as never, GOAL, cfg, { cwd: CWD })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. SMOKE TEST — buildOpenAICompatibleClient end-to-end tool-call cycle
//
// This is the proof that the driver actually works for NIM/OpenAI-compat.
// Mock sequence:
//   turn 1: assistant emits a tool_call (read_file)
//   turn 2: we supply the tool result and the model emits a text completion
// ---------------------------------------------------------------------------

describe('M92 smoke test — buildOpenAICompatibleClient tool-call→completion cycle (mocked)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives a full tool-call → tool-result → completion cycle', async () => {
    // Two fetch calls: first returns a tool_call, second returns text.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJson(toolCallResponse('read_file', { path: '/src/main.ts' })))
      .mockResolvedValueOnce(mockJson(textResponse('Done. The file has 42 lines.')));

    vi.stubGlobal('fetch', fetchMock);

    const client = buildOpenAICompatibleClient(
      'https://integrate.api.nvidia.com/v1',
      'test-nim-key',
      'meta/llama-3.1-70b-instruct',
      true, // supportsTools
    );

    // Turn 1: user sends a task, model issues a tool call
    const msgs1 = makeMessages(['How many lines does /src/main.ts have?']);
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ];

    const result1 = await client.chat(msgs1, tools);

    // Assert the tool call was parsed correctly
    expect(result1.toolCalls).toBeDefined();
    expect(result1.toolCalls!.length).toBe(1);
    expect(result1.toolCalls![0]!.name).toBe('read_file');
    expect((result1.toolCalls![0]!.arguments as Record<string, string>)['path']).toBe(
      '/src/main.ts',
    );
    expect(result1.usage.tokensIn).toBe(30);
    expect(result1.usage.tokensOut).toBe(12);

    // Turn 2: append tool result and get final answer
    const msgs2: ChatMessage[] = [
      ...msgs1,
      { role: 'assistant', content: '' },
      { role: 'tool', content: '42 lines' },
    ];
    const result2 = await client.chat(msgs2, tools);

    expect(result2.content).toBe('Done. The file has 42 lines.');
    expect(result2.toolCalls).toBeUndefined();
    expect(result2.usage.tokensIn).toBe(20);
    expect(result2.usage.tokensOut).toBe(8);

    // Assert fetch was called twice with the correct NIM endpoint
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url1).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    const [url2] = fetchMock.mock.calls[1] as [string, unknown];
    expect(url2).toBe('https://integrate.api.nvidia.com/v1/chat/completions');

    // Assert Authorization header was set with the key
    const opts1 = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(opts1.headers['Authorization']).toBe('Bearer test-nim-key');
  });

  it('uses the model name in the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJson(textResponse('pong')));
    vi.stubGlobal('fetch', fetchMock);

    const client = buildOpenAICompatibleClient(
      'https://api.moonshot.ai/v1',
      'kimi-key',
      'kimi-k2-0711-preview',
      false,
    );

    await client.chat(makeMessages(['ping']));

    const opts = fetchMock.mock.calls[0]![1] as { body: string };
    const body = JSON.parse(opts.body) as Record<string, unknown>;
    expect(body['model']).toBe('kimi-k2-0711-preview');
    expect(body['stream']).toBe(false);
  });

  it('tool_choice is omitted when supportsTools=false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJson(textResponse('ok')));
    vi.stubGlobal('fetch', fetchMock);

    const client = buildOpenAICompatibleClient(
      'https://integrate.api.nvidia.com/v1',
      'key',
      'meta/llama-3.1-70b-instruct',
      false, // supportsTools=false
    );

    const tools = [{ type: 'function', function: { name: 'noop' } }];
    await client.chat(makeMessages(['test']), tools);

    const opts = fetchMock.mock.calls[0]![1] as { body: string };
    const body = JSON.parse(opts.body) as Record<string, unknown>;
    expect(body['tool_choice']).toBeUndefined();
    expect(body['tools']).toBeUndefined();
  });

  it('HTTP error from endpoint surfaces as a thrown Error (not swallowed)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJson({ error: 'quota' }, false, 429));
    vi.stubGlobal('fetch', fetchMock);

    const client = buildOpenAICompatibleClient(
      'https://integrate.api.nvidia.com/v1',
      'key',
      'meta/llama-3.1-70b-instruct',
      true,
    );

    await expect(client.chat(makeMessages(['test']))).rejects.toThrow('429');
  });
});

// ---------------------------------------------------------------------------
// 4. PROBING — probeApiModelEngine readiness
// ---------------------------------------------------------------------------

describe('M92 probing — probeApiModelEngine readiness', () => {
  const NIM_API = {
    envKey: 'NVIDIA_NIM_API_KEY',
    baseUrlEnv: 'NVIDIA_NIM_BASE_URL',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
  };

  beforeEach(() => {
    // Ensure no env bleed between tests
    delete process.env['NVIDIA_NIM_API_KEY'];
    delete process.env['NVIDIA_NIM_BASE_URL'];
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    delete process.env['NVIDIA_NIM_API_KEY'];
    delete process.env['NVIDIA_NIM_BASE_URL'];
    vi.unstubAllGlobals();
  });

  it('returns keyPresent=false when env var is absent', async () => {
    const result = await probeApiModelEngine('nim', NIM_API);
    expect(result.keyPresent).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.models).toEqual([]);
  });

  it('returns keyPresent=false when env var is empty string', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = '   ';
    const result = await probeApiModelEngine('nim', NIM_API);
    expect(result.keyPresent).toBe(false);
    expect(result.reachable).toBe(false);
  });

  it('returns reachable=true + models list when key present and /v1/models returns 200', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = 'test-key-123';

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockJson(modelsListResponse(['meta/llama-3.1-70b-instruct', 'meta/llama-3.1-8b-instruct'])),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeApiModelEngine('nim', NIM_API);
    expect(result.keyPresent).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([
      'meta/llama-3.1-70b-instruct',
      'meta/llama-3.1-8b-instruct',
    ]);
    expect(result.error).toBeUndefined();

    // Assert the probe hit /v1/models with the Authorization header
    const [probeUrl, probeOpts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(probeUrl).toContain('/v1/models');
    expect(probeOpts.headers['Authorization']).toBe('Bearer test-key-123');
  });

  it('returns reachable=false + error when /v1/models returns 401', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = 'bad-key';

    const fetchMock = vi.fn().mockResolvedValue(mockJson({ error: 'Unauthorized' }, false, 401));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeApiModelEngine('nim', NIM_API);
    expect(result.keyPresent).toBe(true);
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it('returns reachable=false + timeout error when fetch aborts', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = 'key';

    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeApiModelEngine('nim', NIM_API);
    expect(result.keyPresent).toBe(true);
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it('uses NVIDIA_NIM_BASE_URL override when set', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = 'key';
    process.env['NVIDIA_NIM_BASE_URL'] = 'https://custom-nim.example.com/v1';

    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJson(modelsListResponse(['custom-model'])));
    vi.stubGlobal('fetch', fetchMock);

    await probeApiModelEngine('nim', NIM_API);

    const [probeUrl] = fetchMock.mock.calls[0] as [string];
    expect(probeUrl).toContain('custom-nim.example.com');
  });

  it('never throws on any failure — always returns an ApiModelReadiness shape', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = 'key';

    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeApiModelEngine('nim', NIM_API);
    expect(result).toMatchObject({ engineId: 'nim', keyPresent: true, reachable: false });
    expect(typeof result.error).toBe('string');
  });
});

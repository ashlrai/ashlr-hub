/**
 * m118.content-toolcalls.test.ts — M118: content-embedded tool-call parsing.
 *
 * When a local coder model (qwen2.5-coder:32b, deepseek-coder, etc.) emits a
 * tool call as JSON inside message.content instead of the structured tool_calls
 * field, the agent-loop previously saw no toolCalls and treated the response as
 * a final answer — the model could never drive writes and never produced a diff.
 *
 * M118 adds parseContentToolCalls() + toolNamesFromSpecs() and wires them as a
 * fallback in buildOpenAICompatibleClient: fired ONLY when:
 *   a) no structured tool_calls were present (native path still wins), AND
 *   b) tools were provided in the request, AND
 *   c) message.content is non-empty.
 *
 * Test groups:
 *
 *   1. UNIT — parseContentToolCalls / toolNamesFromSpecs pure-function tests.
 *      Covers all 5 accepted shapes + rejection of plain prose + native-path
 *      safety (native tool_calls still bypasses the parser).
 *
 *   2. INTEGRATION — buildOpenAICompatibleClient.chat() with a mocked fetch
 *      that simulates the qwen2.5-coder:32b response shape (finish_reason:'stop',
 *      content = bare JSON, no tool_calls field): asserts toolCalls are parsed
 *      and finalContent is cleaned.
 *
 *   3. STREAMING INTEGRATION — buildOpenAICompatibleClient.chatStream() with
 *      mocked SSE stream: asserts the accumulated content fallback fires.
 *
 *   4. NATIVE-PATH SAFETY — when structured tool_calls ARE present, the content
 *      fallback is NOT invoked; existing tool_calls pass through unchanged.
 *
 *   5. LIVE (skipped unless CODER_LIVE=1) — real qwen2.5-coder:32b call through
 *      buildOpenAICompatibleClient: asserts a toolCall is returned even though
 *      the model emits finish_reason:'stop' with JSON in content.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseContentToolCalls,
  toolNamesFromSpecs,
  buildOpenAICompatibleClient,
} from '../src/core/run/provider-client.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TOOL_NAMES = new Set(['read_file', 'write_file', 'list_dir']);

// A minimal OpenAI-format tools array matching TOOL_NAMES.
const TOOLS_ARRAY = [
  { type: 'function', function: { name: 'read_file', description: 'read', parameters: {} } },
  { type: 'function', function: { name: 'write_file', description: 'write', parameters: {} } },
  { type: 'function', function: { name: 'list_dir', description: 'list', parameters: {} } },
];

// ---------------------------------------------------------------------------
// 1. UNIT — parseContentToolCalls + toolNamesFromSpecs
// ---------------------------------------------------------------------------

describe('M118 unit — toolNamesFromSpecs', () => {
  it('extracts names from OpenAI-format tools', () => {
    const names = toolNamesFromSpecs(TOOLS_ARRAY);
    expect(names.has('read_file')).toBe(true);
    expect(names.has('write_file')).toBe(true);
    expect(names.size).toBe(3);
  });

  it('extracts names from ToolSpec format ({name:...})', () => {
    const tools = [{ name: 'read_file' }, { name: 'write_file' }];
    const names = toolNamesFromSpecs(tools);
    expect(names.has('read_file')).toBe(true);
    expect(names.has('write_file')).toBe(true);
    expect(names.size).toBe(2);
  });

  it('returns empty set for empty array', () => {
    expect(toolNamesFromSpecs([]).size).toBe(0);
  });

  it('skips non-object entries', () => {
    const names = toolNamesFromSpecs([null, 42, 'string', { name: 'read_file' }] as unknown[]);
    expect(names.size).toBe(1);
    expect(names.has('read_file')).toBe(true);
  });
});

describe('M118 unit — parseContentToolCalls shape 1: bare JSON object', () => {
  it('parses {"name":"read_file","arguments":{...}}', () => {
    const content = JSON.stringify({ name: 'read_file', arguments: { path: '/tmp/x' } });
    const result = parseContentToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0]!.name).toBe('read_file');
    expect((result!.toolCalls[0]!.arguments as Record<string, unknown>)['path']).toBe('/tmp/x');
    // JSON consumed → cleaned content is empty
    expect(result!.cleanedContent).toBe('');
  });

  it('generates a stable tool-call id', () => {
    const content = JSON.stringify({ name: 'read_file', arguments: {} });
    const result = parseContentToolCalls(content, TOOL_NAMES)!;
    expect(result.toolCalls[0]!.id).toMatch(/^call_content_0_read_fil/);
  });
});

describe('M118 unit — parseContentToolCalls shape 2: string-encoded arguments', () => {
  it('parses {"name":"write_file","arguments":"{\\"path\\":\\"/out.ts\\"}"}', () => {
    const content = JSON.stringify({
      name: 'write_file',
      arguments: JSON.stringify({ path: '/out.ts', content: 'hello' }),
    });
    const result = parseContentToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls[0]!.name).toBe('write_file');
    const args = result!.toolCalls[0]!.arguments as Record<string, unknown>;
    expect(args['path']).toBe('/out.ts');
    expect(args['content']).toBe('hello');
  });
});

describe('M118 unit — parseContentToolCalls shape 3: array of calls', () => {
  it('parses an array of two tool calls', () => {
    const content = JSON.stringify([
      { name: 'read_file', arguments: { path: '/a.ts' } },
      { name: 'write_file', arguments: { path: '/b.ts', content: 'x' } },
    ]);
    const result = parseContentToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls).toHaveLength(2);
    expect(result!.toolCalls[0]!.name).toBe('read_file');
    expect(result!.toolCalls[1]!.name).toBe('write_file');
  });

  it('rejects array where one name is unknown', () => {
    const content = JSON.stringify([
      { name: 'read_file', arguments: {} },
      { name: 'unknown_tool', arguments: {} },
    ]);
    const result = parseContentToolCalls(content, TOOL_NAMES);
    expect(result).toBeUndefined();
  });
});

describe('M118 unit — parseContentToolCalls shape 4: fenced JSON block', () => {
  it('parses ```json\\n{...}\\n```', () => {
    const content = '```json\n{"name":"read_file","arguments":{"path":"/x.ts"}}\n```';
    const result = parseContentToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls[0]!.name).toBe('read_file');
    // Fence stripped from cleanedContent
    expect(result!.cleanedContent).toBe('');
  });

  it('parses ``` (no lang tag) fenced block', () => {
    const content = '```\n{"name":"write_file","arguments":{"path":"/y.ts","content":"x"}}\n```';
    const result = parseContentToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls[0]!.name).toBe('write_file');
  });
});

describe('M118 unit — parseContentToolCalls shape 5: prose around JSON', () => {
  it('extracts bare JSON from prose surrounding it', () => {
    const content = 'I will read the file for you.\n{"name":"read_file","arguments":{"path":"/z"}}\nDone.';
    const result = parseContentToolCalls(content, TOOL_NAMES);
    expect(result).toBeDefined();
    expect(result!.toolCalls[0]!.name).toBe('read_file');
  });
});

describe('M118 unit — rejection of false positives', () => {
  it('returns undefined for plain prose (no valid JSON)', () => {
    const result = parseContentToolCalls('Here is my answer.', TOOL_NAMES);
    expect(result).toBeUndefined();
  });

  it('returns undefined when content is empty', () => {
    expect(parseContentToolCalls('', TOOL_NAMES)).toBeUndefined();
  });

  it('returns undefined when toolNames set is empty', () => {
    const content = JSON.stringify({ name: 'read_file', arguments: {} });
    expect(parseContentToolCalls(content, new Set())).toBeUndefined();
  });

  it('returns undefined when JSON name does not match any tool', () => {
    const content = JSON.stringify({ name: 'unknown_tool', arguments: {} });
    expect(parseContentToolCalls(content, TOOL_NAMES)).toBeUndefined();
  });

  it('returns undefined for valid JSON with no "name" field', () => {
    const content = JSON.stringify({ foo: 'bar', baz: 123 });
    expect(parseContentToolCalls(content, TOOL_NAMES)).toBeUndefined();
  });

  it('returns undefined for JSON number', () => {
    expect(parseContentToolCalls('42', TOOL_NAMES)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. INTEGRATION — buildOpenAICompatibleClient.chat() with mocked fetch
//    Simulates qwen2.5-coder:32b: finish_reason='stop', no tool_calls, JSON in content
// ---------------------------------------------------------------------------

describe('M118 integration — chat() content fallback (mocked fetch)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses content-embedded tool call when no structured tool_calls present', async () => {
    const coderContent = JSON.stringify({
      name: 'write_file',
      arguments: { path: '/out.ts', content: 'export const x = 42;' },
    });

    // Simulate qwen2.5-coder:32b: finish_reason:'stop', no tool_calls field
    const mockResponse = {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: coderContent,
          // NOTE: no tool_calls field — this is the qwen2.5-coder:32b shape
        },
      }],
      usage: { prompt_tokens: 50, completion_tokens: 30 },
    };

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    }));

    const client = buildOpenAICompatibleClient(
      'http://localhost:11434/v1',
      '',
      'qwen2.5-coder:32b',
      true,
    );

    const result = await client.chat(
      [{ role: 'user', content: 'Write x=42 to /out.ts' }],
      TOOLS_ARRAY,
    );

    // M118: tool call extracted from content
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0]!.name).toBe('write_file');
    const args = result.toolCalls![0]!.arguments as Record<string, unknown>;
    expect(args['path']).toBe('/out.ts');
    // JSON stripped from visible content
    expect(result.content).toBe('');
  });

  it('native tool_calls path is UNCHANGED when model returns structured tool_calls', async () => {
    const mockResponse = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_native_0',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/native.ts"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 40, completion_tokens: 20 },
    };

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    }));

    const client = buildOpenAICompatibleClient(
      'http://localhost:11434/v1',
      '',
      'qwen2.5:72b-instruct-q4_K_M',
      true,
    );

    const result = await client.chat(
      [{ role: 'user', content: 'Read /native.ts' }],
      TOOLS_ARRAY,
    );

    // Native path: tool_calls preserved, id unchanged
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0]!.id).toBe('call_native_0');
    expect(result.toolCalls![0]!.name).toBe('read_file');
    // content is null/empty from native response — stays as-is
    expect(result.content).toBe('');
  });

  it('plain prose content is NOT parsed as a tool call', async () => {
    const mockResponse = {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'The answer is 42.' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    }));

    const client = buildOpenAICompatibleClient(
      'http://localhost:11434/v1',
      '',
      'qwen2.5-coder:32b',
      true,
    );

    const result = await client.chat(
      [{ role: 'user', content: 'What is 6*7?' }],
      TOOLS_ARRAY,
    );

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe('The answer is 42.');
  });

  it('no fallback attempted when no tools provided', async () => {
    const coderContent = JSON.stringify({ name: 'write_file', arguments: { path: '/x.ts' } });
    const mockResponse = {
      choices: [{ finish_reason: 'stop', message: { content: coderContent } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    }));

    const client = buildOpenAICompatibleClient(
      'http://localhost:11434/v1',
      '',
      'qwen2.5-coder:32b',
      true,
    );

    // No tools passed → fallback must NOT fire
    const result = await client.chat(
      [{ role: 'user', content: 'Write file' }],
    );

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe(coderContent); // content returned as-is
  });
});

// ---------------------------------------------------------------------------
// 3. STREAMING INTEGRATION — chatStream() content fallback
// ---------------------------------------------------------------------------

describe('M118 integration — chatStream() content fallback (mocked SSE)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses content-embedded tool call from accumulated SSE content', async () => {
    const coderContent = JSON.stringify({
      name: 'write_file',
      arguments: { path: '/stream.ts', content: 'export const y = 1;' },
    });

    // Split content across two SSE chunks to test accumulation
    const half = Math.floor(coderContent.length / 2);
    const chunk1 = coderContent.slice(0, half);
    const chunk2 = coderContent.slice(half);

    const sseLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: chunk1 } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: chunk2 } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const sseBytes = encoder.encode(sseLines);

    vi.stubGlobal('fetch', async () => {
      let pos = 0;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (pos >= sseBytes.length) return { done: true };
              const slice = sseBytes.slice(pos, pos + 128);
              pos += slice.length;
              return { done: false, value: slice };
            },
            releaseLock: () => {},
          }),
        },
      };
    });

    const client = buildOpenAICompatibleClient(
      'http://localhost:11434/v1',
      '',
      'qwen2.5-coder:32b',
      true,
    );

    const deltas: string[] = [];
    const result = await client.chatStream!(
      [{ role: 'user', content: 'Write y=1 to /stream.ts' }],
      TOOLS_ARRAY,
      (d) => deltas.push(d),
    );

    // M118: accumulated content triggers fallback parse
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0]!.name).toBe('write_file');
    const args = result.toolCalls![0]!.arguments as Record<string, unknown>;
    expect(args['path']).toBe('/stream.ts');
  });
});

// ---------------------------------------------------------------------------
// 4. NATIVE-PATH SAFETY — structured tool_calls bypass the content fallback
// ---------------------------------------------------------------------------

describe('M118 native-path safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('structured tool_calls win even when content also contains JSON matching a tool', async () => {
    // Adversarial: content contains a different tool call JSON, but structured
    // tool_calls has the real call. M118 must NOT touch this response.
    const mockResponse = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          // Content also has JSON — the fallback must be skipped entirely.
          content: JSON.stringify({ name: 'list_dir', arguments: { path: '/' } }),
          tool_calls: [{
            id: 'call_real_0',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/real.ts"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    }));

    const client = buildOpenAICompatibleClient(
      'http://localhost:11434/v1',
      '',
      'qwen2.5:72b-instruct-q4_K_M',
      true,
    );

    const result = await client.chat(
      [{ role: 'user', content: 'Use native tool_calls' }],
      TOOLS_ARRAY,
    );

    // Must use native tool_calls, not content JSON
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0]!.id).toBe('call_real_0');
    expect(result.toolCalls![0]!.name).toBe('read_file');
  });
});

// ---------------------------------------------------------------------------
// 5. LIVE (skipped unless CODER_LIVE=1)
//    Requires: Ollama running at localhost:11434 with qwen2.5-coder:32b pulled.
// ---------------------------------------------------------------------------

const coderLive = process.env['CODER_LIVE'] === '1';

describe.skipIf(!coderLive)('M118 live — qwen2.5-coder:32b content-tool-call (CODER_LIVE=1)', () => {
  it(
    'qwen2.5-coder:32b returns tool call via content fallback (finish_reason=stop)',
    async () => {
      const client = buildOpenAICompatibleClient(
        'http://localhost:11434/v1',
        '',
        'qwen2.5-coder:32b',
        true,
      );

      const result = await client.chat(
        [{ role: 'user', content: 'Call write_file with path="/tmp/m118-live.ts" and content="// M118 live test\\nexport const m118 = true;"' }],
        TOOLS_ARRAY,
      );

      // M118: even though model emits stop+JSON-in-content, we parse it.
      // The model may pick any tool from the spec — what matters is that a tool
      // call was returned at all (not undefined) and the name is a known tool.
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);
      const toolName = result.toolCalls![0]!.name;
      expect(['read_file', 'write_file', 'list_dir']).toContain(toolName);
      const args = result.toolCalls![0]!.arguments as Record<string, unknown>;
      expect(typeof args).toBe('object');
      console.info('[M118 live] parsed tool call:', toolName, JSON.stringify(args));
    },
    120_000,
  );
});

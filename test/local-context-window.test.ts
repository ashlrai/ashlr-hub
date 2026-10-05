/** Pure/fake transport fixtures; no provider, model, credentials or service contact. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitTaskContext } from '../src/core/run/context-window.js';
import { conservativeRequestTokenReservation, MAX_GOVERNED_OUTPUT_TOKENS } from '../src/core/run/model-call-authority.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { buildOllamaClient, buildOpenAICompatibleClient, discoverOllamaRequestContextWindow } from '../src/core/run/provider-client.js';
import { newUsage } from '../src/core/run/budget.js';
import type { ChatMessage, ProviderClient, RunTask } from '../src/core/types.js';

const pinned: ChatMessage[] = [{ role: 'system', content: 'Exact system instruction Ω' }, { role: 'user', content: 'Original goal: finish the real change.' }];
function group(id: string, content: string): ChatMessage[] {
  return [{ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', arguments: { path: 'demo.ts', offset: 0, limit: 20 } }] },
    { role: 'tool', toolCallId: id, name: 'read_file', content }];
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Runtime context projection', () => {
  it('retains a complete recent60000-byte tool group while dropping older history and preserving prompts exactly', () => {
    const original = [...pinned, ...group('older', 'OLD'.repeat(20000)), ...group('recent', 'R'.repeat(60000))];
    const saved = structuredClone(original); const projected = fitTaskContext(original, [], 65536);
    expect(projected.omittedGroups).toBe(1); expect(projected.shortenedToolResults).toBe(0);
    expect(projected.messages.slice(0, 2)).toEqual(pinned); expect(original).toEqual(saved);
    expect(projected.messages.slice(-2)).toEqual(group('recent', 'R'.repeat(60000)));
    expect(projected.messages[2]?.content).toContain('Previous tool effects still happened');
    expect(conservativeRequestTokenReservation(projected.messages, []) + MAX_GOVERNED_OUTPUT_TOKENS).toBeLessThanOrEqual(65536);
  });
  it('shortens model-facing multi-tool results with explicit refetch markers, preserving IDs/arguments and original effects', () => {
    const original = [...pinned, { role: 'assistant' as const, content: '', toolCalls: [
      { id: 'a', name: 'read_file', arguments: { path: 'a.ts' } }, { id: 'b', name: 'grep', arguments: { pattern: 'key' } }] },
      { role: 'tool' as const, toolCallId: 'a', name: 'read_file', content: 'Ω'.repeat(80000) },
      { role: 'tool' as const, toolCallId: 'b', name: 'grep', content: 'B'.repeat(80000) }];
    const saved = structuredClone(original); const projected = fitTaskContext(original, [], 65536);
    expect(projected.shortenedToolResults).toBe(2); expect(projected.messages[3]?.toolCalls).toEqual(original[2]?.toolCalls);
    expect(projected.messages.slice(4).map(m => m.toolCallId)).toEqual(['a', 'b']);
    expect(projected.messages.slice(4).every(m => m.content.includes('not the complete result'))).toBe(true);
    expect(original).toEqual(saved); expect(projected.messages.slice(0, 2)).toEqual(pinned);
    expect(conservativeRequestTokenReservation(projected.messages, []) + MAX_GOVERNED_OUTPUT_TOKENS).toBeLessThanOrEqual(65536);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid physical context %s', window => {
    expect(() => fitTaskContext(pinned, [], window)).toThrow('Context window');
  });
  it('refuses pinned goal/system or schemas too large without truncating them', () => {
    const task = [...pinned, ...group('a', 'tool')]; task[0] = { role: 'system', content: 'S'.repeat(70000) };
    expect(() => fitTaskContext(task, [], 65536)).toThrow('Original task');
    expect(() => fitTaskContext(pinned, [{ description: 'T'.repeat(70000) }], 65536)).toThrow('Original task');
    expect(task[0].content).toHaveLength(70000);
  });
  it('refuses orphan, mismatched, duplicate and incomplete tool groups', () => {
    for (const tail of [group('x', 'a').slice(1), group('x', 'a').slice(0, 1),
      [{ role: 'assistant' as const, content: '', toolCalls: [{ id: 'x', name: 'read_file', arguments: {} }] },
        { role: 'tool' as const, toolCallId: 'different', name: 'read_file', content: 'a' }],
      [{ role: 'assistant' as const, content: '', toolCalls: [{ id: 'x', name: 'read_file', arguments: {} }, { id: 'x', name: 'read_file', arguments: {} }] },
        ...group('x', 'a').slice(1), ...group('x', 'b').slice(1)]]) {
      expect(() => fitTaskContext([...pinned, ...tail], [], 65536)).toThrow('Context');
    }
  });
  it('counts escaped tool arguments and Unicode as request input, not exact provider token usage', () => {
    const messages = group('x', 'Ω'); messages[0]!.toolCalls![0]!.arguments = { text: '\\"'.repeat(100) };
    expect(conservativeRequestTokenReservation(messages, [])).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ messages, tools: [] })));
  });
  it('keeps the original query through a fake ten-request trajectory with a reported60000-token ninth prompt', async () => {
    let calls = 0; const seen: ChatMessage[][] = []; const usage = newUsage();
    const client: ProviderClient = { id: 'fake', supportsTools: true, chat: vi.fn(async messages => {
      seen.push(structuredClone(messages)); calls++;
      expect(messages[0]?.role).toBe('system'); expect(messages[1]?.content).toBe(pinned[1]!.content);
      expect(conservativeRequestTokenReservation(messages, [{ name: 'read_file' }]) + 4096).toBeLessThanOrEqual(65536);
      return { content: calls === 10 ? 'Verified final answer.' : '',
        ...(calls < 10 ? { toolCalls: [{ id: `call-${calls}`, name: 'read_file', arguments: { offset: calls * 20, limit: 20 } }] } : {}),
        usage: { tokensIn: calls === 9 ? 60000 : 11000, tokensOut: 100 }, usageKnown: true };
    }) };
    const task: RunTask = { id: 't', goal: pinned[1]!.content, deps: [], status: 'pending' };
    await runTask(task, client, { tools: [{ name: 'read_file', fn: async () => 'FILE'.repeat(10000) }],
      contextWindowTokens: 65536, budget: { maxTokens: 1000000, maxSteps: 40, allowCloud: false }, usage,
      onStep: step => { if (step.usage) { usage.tokensIn += step.usage.tokensIn; usage.tokensOut += step.usage.tokensOut; usage.steps += step.usage.steps; } } });
    expect(calls).toBe(10); expect(task.status).toBe('done'); expect(task.result).toBe('Verified final answer.');
    expect(seen[9]!.some(m => m.content.includes('Context history compacted'))).toBe(true);
    expect(usage.tokensIn).toBe(159000); // recorded counts stay exact, no reset during compaction
  });
  it('refuses oversized pinned context before reserving or contacting the model', async () => {
    const chat = vi.fn(); const reserveModelStep = vi.fn();
    const task: RunTask = { id: 't', goal: 'G'.repeat(70000), deps: [], status: 'pending' };
    await runTask(task, { id: 'fake', supportsTools: false, chat }, { contextWindowTokens: 65536,
      budget: { maxTokens: 1000000, maxSteps: 40, allowCloud: false }, usage: newUsage(), reserveModelStep, onStep: () => {} });
    expect(chat).not.toHaveBeenCalled(); expect(reserveModelStep).not.toHaveBeenCalled(); expect(task.status).toBe('failed');
    expect(task.error).toContain('Original task'); expect(task.goal).toHaveLength(70000);
  });
  it('preserves unknown-window history rather than silently imposing a profile size', async () => {
    const seen: ChatMessage[][] = [];
    const task: RunTask = { id: 't', goal: pinned[1]!.content, deps: [], status: 'pending' };
    await runTask(task, { id: 'fake', supportsTools: true, chat: async messages => {
      seen.push(structuredClone(messages));
      return seen.length === 1 ? { content: '', toolCalls: [{ id: 'x', name: 'read_file', arguments: {} }], usage: { tokensIn: 10, tokensOut: 1 } } : { content: 'done', usage: { tokensIn: 20, tokensOut: 1 } };
    } }, { tools: [{ name: 'read_file', fn: async () => 'X'.repeat(100000) }],
      budget: { maxTokens: 1000000, maxSteps: 40, allowCloud: false }, usage: newUsage(), onStep: () => {} });
    expect(seen[1]![3]!.content).toHaveLength(100000);
    expect(seen[1]![2]!.toolCalls![0]!.id).toBe('x');
    expect(seen[1]!.some(message => message.content.includes('Context history compacted'))).toBe(false);
    expect(task.status).toBe('done');
  });
});

describe('Selected model metadata and tool replay', () => {
  it.each(['127.0.0.1', '[::1]', 'localhost'])('discovers the explicit64k pin at the same %s origin rather than trained256k', async host => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ parameters: 'num_ctx 65536', model_info: { 'qwen.context_length': 262144 } })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await discoverOllamaRequestContextWindow(`http://${host}:11434/v1`, 'qwen:ctx64k')).toBe(65536);
    expect(fetchMock).toHaveBeenCalledOnce(); const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://${host}:11434/api/show`); expect(init).toMatchObject({ redirect: 'error' });
    expect(JSON.parse(init!.body as string).model).toBe('qwen:ctx64k');
  });
  it.each(['unpin', 'malformed', 'oversized', 'http'])('retains unknown on %s metadata without trained/profile fallback', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(kind === 'oversized' ? 'X'.repeat(1024 * 1024 + 1) : JSON.stringify({
      parameters: kind === 'unpin' ? '' : 'num_ctx invalid', model_info: { 'qwen.context_length': 262144 },
    }), { status: kind === 'http' ? 500 : 200 })));
    expect(await discoverOllamaRequestContextWindow('http://127.0.0.1:11434/v1', 'qwen')).toBeUndefined();
  });
  it('does not fetch remote/credential endpoints or a cancelled metadata request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); const abort = new AbortController(); abort.abort();
    expect(await discoverOllamaRequestContextWindow('http://127.0.0.1:11434/v1', 'qwen', abort.signal)).toBeUndefined();
    for (const url of ['https://provider.invalid/v1', 'http://user:secret@127.0.0.1:11434/v1',
      'http://ollama.internal:11434/v1', 'http://localhost:1234/v1', 'http://localhost:11434/not-v1'])
      expect(await discoverOllamaRequestContextWindow(url, 'qwen')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['openai', 'ollama'] as const)('replays %s assistant call IDs and matching tool results on the wire', async kind => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(kind === 'openai' ? {
      choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 20, completion_tokens: 2 },
    } : { message: { content: 'done' }, prompt_eval_count: 20, eval_count: 2 })));
    vi.stubGlobal('fetch', fetchMock);
    const client = kind === 'openai' ? buildOpenAICompatibleClient('http://127.0.0.1:11434/v1', '', 'qwen', true) :
      buildOllamaClient('http://127.0.0.1:11434', 'qwen', true);
    await client.chat([...pinned, ...group('exact-id', 'result')]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages[2].tool_calls[0]).toMatchObject({ id: 'exact-id', function: { name: 'read_file' } });
    expect(body.messages[2].tool_calls[0].function.arguments).toEqual(kind === 'openai' ? JSON.stringify(group('exact-id', 'result')[0]!.toolCalls![0]!.arguments) : group('exact-id', 'result')[0]!.toolCalls![0]!.arguments);
    expect(body.messages[3].tool_call_id).toBe('exact-id');
  });
  it.each(['openai', 'ollama'] as const)('preserves the same %s tool protocol and output limit when streaming', async kind => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(kind === 'openai' ?
      'data: {"choices":[{"delta":{"content":"done"}}],"usage":{"prompt_tokens":20,"completion_tokens":2}}\n\ndata: [DONE]\n\n' :
      '{"message":{"content":"done"},"done":true,"prompt_eval_count":20,"eval_count":2}\n'));
    vi.stubGlobal('fetch', fetchMock);
    const client = kind === 'openai' ? buildOpenAICompatibleClient('http://127.0.0.1:11434/v1', '', 'qwen', true) :
      buildOllamaClient('http://127.0.0.1:11434', 'qwen', true);
    await client.chatStream!([...pinned, ...group('exact-id', 'result')], [], () => {}, undefined, { maxOutputTokens: 1024 });
    expect(fetchMock).toHaveBeenCalledOnce(); // actual streaming path, no hidden fallback/retry
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages[2].tool_calls[0]).toMatchObject({ id: 'exact-id', function: { name: 'read_file' } });
    expect(body.messages[2].tool_calls[0].function.arguments).toEqual(kind === 'openai' ? JSON.stringify(group('exact-id', 'result')[0]!.toolCalls![0]!.arguments) : group('exact-id', 'result')[0]!.toolCalls![0]!.arguments);
    expect(body.messages[3].tool_call_id).toBe('exact-id');
    expect(kind === 'openai' ? body.max_tokens : body.options.num_predict).toBe(1024);
  });
});

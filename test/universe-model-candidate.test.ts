import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateModelCandidate, type ModelCandidateContext } from '../src/core/universe/model-candidate.js';
import { validGenerationReceipt } from '../src/core/universe/generation.js';
import type { UniverseGenerationConfig } from '../src/core/universe/types.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(contents: Record<string, string | Buffer> = { 'value.json': '1' }): {
  config: UniverseGenerationConfig; context: ModelCandidateContext; root: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-universe-model-')));
  roots.push(root);
  for (const [path, content] of Object.entries(contents)) writeFileSync(join(root, path), content);
  return { root, config: { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1',
    model: 'test-local-model', files: Object.keys(contents), maxOutputTokens: 256 },
  context: { candidatePath: root, objective: 'Increase value', hypothesis: 'Try a larger integer',
    generation: 2, parentTrialId: 'previous-winner', timeoutMs: 2_000, signal: new AbortController().signal } };
}

function response(content = '{"edits":[{"path":"value.json","content":"2"}]}', usage: unknown = {
  prompt_tokens: 11, completion_tokens: 7,
}, messageExtra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content, ...messageExtra } }], ...(usage === null ? {} : { usage }) }), { status: 200 });
}

describe('Universe prompt-only local candidate generation', () => {
  it('reuses bounded no-auth/no-tools transport and supplies only declared current-parent context', async () => {
    const { config, context, root } = fixture();
    writeFileSync(join(root, 'evaluate.mjs'), 'PRIVATE FIXED EVALUATOR');
    const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit) => response());
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await generateModelCandidate({ ...config, endpoint: 'http://127.0.0.1:11434/' }, context);
    expect(receipt).toMatchObject({ status: 'succeeded', endpoint: 'http://127.0.0.1:11434/v1',
      requestStarted: true, usage: { state: 'reported', inputTokens: 11, outputTokens: 7 }, changedFiles: ['value.json'] });
    expect(validGenerationReceipt(receipt)).toBe(true);
    expect(receipt.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.responseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('Increase value');
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('2');
    expect(readFileSync(join(root, 'evaluate.mjs'), 'utf8')).toBe('PRIVATE FIXED EVALUATOR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
    expect(Object.keys(init.headers as object)).toEqual(['Content-Type']);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: config.model, stream: false, max_tokens: 256 });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(JSON.parse(body.messages[1].content)).toEqual({ objective: context.objective,
      hypothesis: context.hypothesis, generation: 2, parentTrialId: 'previous-winner', files: [{ path: 'value.json', content: '1' }] });
    expect(init.body).not.toContain('PRIVATE FIXED EVALUATOR');
  });

  it('accepts empty file replacements and reports actual changed paths only', async () => {
    const { config, context, root } = fixture({ 'value.json': '1', 'keep.txt': 'same' });
    vi.stubGlobal('fetch', vi.fn(async () => response('{"edits":[{"path":"value.json","content":""},{"path":"keep.txt","content":"same"}]}')));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('succeeded');
    expect(receipt.changedFiles).toEqual(['value.json']);
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('');
  });

  it('preserves Unicode and a UTF-8 byte-order mark in the declared parent text', async () => {
    const source = '\uFEFFconst word = "宇宙 🚀";\n';
    const { config, context, root } = fixture({ 'value.json': source });
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(JSON.parse(body.messages[1].content).files).toEqual([{ path: 'value.json', content: source }]);
      return response(JSON.stringify({ edits: [{ path: 'value.json', content: source }] }));
    }));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt).toMatchObject({ status: 'succeeded', changedFiles: [] });
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe(source);
  });

  it.each([
    'http://localhost:11434/v1', 'http://192.168.1.1:11434/v1', 'https://127.0.0.1:11434/v1',
    'http://user:password@127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1?key=secret',
  ])('refuses unapproved endpoint %s before contact', async (endpoint) => {
    const { config, context } = fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await generateModelCandidate({ ...config, endpoint }, context);
    expect(receipt).toMatchObject({ status: 'failed', requestStarted: false, promptDigest: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'plain text', '```json\n{"edits":[]}\n```', '{"edits":[]}', '{"edits":[{"path":"value.json","content":"2","extra":true}]}',
    '{"edits":[{"path":"value.json","content":"2"}],"score":999}',
    '{"edits":[{"path":"value.json","content":"2"},{"path":"value.json","content":"3"}]}',
    '{"edits":[{"path":"../escape","content":"2"}]}', '{"edits":[{"path":"/value.json","content":"2"}]}',
    '{"edits":[{"path":".git/config","content":"2"}]}', '{"edits":[{"path":"evaluate.mjs","content":"2"}]}',
    '{"edits":[{"path":"value.json","content":"\\u0000"}]}', '{"edits":[{"path":"value.json","content":"\\ud800"}]}',
  ])('rejects malformed or undeclared edits without writing: %s', async (content) => {
    const { config, context, root } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => response(content)));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt).toMatchObject({ status: 'failed', requestStarted: true, changedFiles: [],
      usage: { state: 'reported', inputTokens: 11, outputTokens: 7 } });
    expect(validGenerationReceipt(receipt)).toBe(true);
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('1');
  });

  it('validates every replacement before any file write', async () => {
    const { config, context, root } = fixture({ 'value.json': '1', 'other.txt': 'original' });
    vi.stubGlobal('fetch', vi.fn(async () => response(JSON.stringify({ edits: [
      { path: 'value.json', content: '2' }, { path: 'outside.txt', content: 'must not write' },
    ] }))));
    expect((await generateModelCandidate(config, context)).status).toBe('failed');
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('1');
    expect(readFileSync(join(root, 'other.txt'), 'utf8')).toBe('original');
  });

  it('rejects structured tool calls even when accompanying edits parse', async () => {
    const { config, context, root } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => response(undefined, undefined, { tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{}' } },
    ] })));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/requested tools/);
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('1');
  });

  it.each([
    null, {}, { prompt_tokens: 11 }, { prompt_tokens: -1, completion_tokens: 7 },
    { prompt_tokens: 1.5, completion_tokens: 7 }, { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
  ])('never reports heuristic or invalid counters as measured usage: %j', async (usage) => {
    const { config, context } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => response(undefined, usage)));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('succeeded');
    expect(receipt.usage).toEqual({ state: 'unavailable', inputTokens: null, outputTokens: null });
  });

  it('rejects a reported output-budget overrun while retaining the actual usage', async () => {
    const { config, context, root } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => response(undefined, { prompt_tokens: 11, completion_tokens: 257 })));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt).toMatchObject({ status: 'failed', requestStarted: true, changedFiles: [],
      usage: { state: 'reported', inputTokens: 11, outputTokens: 257 } });
    expect(receipt.error).toMatch(/output-token budget/);
    expect(validGenerationReceipt(receipt)).toBe(true);
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('1');
  });

  it.each(['oversized', 'binary', 'invalid-utf8', 'symlink', 'hardlink', 'directory-symlink'] as const)(
    'rejects %s input before model contact', async (kind) => {
      const { config, context, root } = fixture();
      if (kind === 'oversized') writeFileSync(join(root, 'value.json'), 'x'.repeat(64 * 1024 + 1));
      if (kind === 'binary') writeFileSync(join(root, 'value.json'), Buffer.from([0]));
      if (kind === 'invalid-utf8') writeFileSync(join(root, 'value.json'), Buffer.from([0xff]));
      if (kind === 'symlink') { symlinkSync(join(root, 'value.json'), join(root, 'linked')); config.files = ['linked']; }
      if (kind === 'hardlink') { linkSync(join(root, 'value.json'), join(root, 'linked')); config.files = ['linked']; }
      if (kind === 'directory-symlink') {
        mkdirSync(join(root, 'real'));
        writeFileSync(join(root, 'real/value.json'), '1');
        symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');
        config.files = ['linked/value.json'];
      }
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const receipt = await generateModelCandidate(config, context);
      expect(receipt).toMatchObject({ status: 'failed', requestStarted: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('caps aggregate context and serialized request before contact', async () => {
    const oversized = fixture({ a: 'x'.repeat(64 * 1024), b: 'x'.repeat(64 * 1024), c: 'x' });
    const escaped = fixture({ a: '\u0001'.repeat(64 * 1024) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await generateModelCandidate(oversized.config, oversized.context)).requestStarted).toBe(false);
    expect((await generateModelCandidate(escaped.config, escaped.context)).requestStarted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized replacement text but retains provider-reported usage', async () => {
    const { config, context, root } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => response(JSON.stringify({ edits: [{ path: 'value.json', content: 'x'.repeat(64 * 1024 + 1) }] }))));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('failed');
    expect(receipt.usage.state).toBe('reported');
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('1');
  });

  it('caps the transport response without retaining its content', async () => {
    const { config, context } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private response marker' + 'x'.repeat(256 * 1024))));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt).toMatchObject({ status: 'failed', requestStarted: true, responseDigest: null,
      usage: { state: 'unavailable', inputTokens: null, outputTokens: null } });
    expect(JSON.stringify(receipt)).not.toContain('private response marker');
  });

  it('does not apply a stale answer after any declared parent input changes', async () => {
    const { config, context, root } = fixture({ 'value.json': '1', 'other.txt': 'original' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      writeFileSync(join(root, 'other.txt'), 'changed by owner');
      return response();
    }));
    const receipt = await generateModelCandidate(config, context);
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/changed during/);
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('1');
    expect(readFileSync(join(root, 'other.txt'), 'utf8')).toBe('changed by owner');
  });

  it('does not contact a provider when already cancelled', async () => {
    const { config, context } = fixture();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await generateModelCandidate(config, { ...context, signal: controller.signal })).toMatchObject({
      status: 'cancelled', requestStarted: false, changedFiles: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'cancel'] as const)('owns a hanging model request until %s', async (mode) => {
    const { config, context, root } = fixture();
    const owner = new AbortController();
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('private transport error marker')); }, { once: true });
      if (mode === 'cancel') owner.abort();
    })));
    const receipt = await generateModelCandidate(config, { ...context, timeoutMs: 30, signal: owner.signal });
    expect(receipt.status).toBe(mode === 'timeout' ? 'timed-out' : 'cancelled');
    expect(receipt.requestStarted).toBe(true);
    expect(aborted).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain('private transport error marker');
    expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('1');
  });

  it('keeps the deadline armed through a hanging response body', async () => {
    const { config, context } = fixture();
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(new Error('body stopped')), { once: true }); },
    }))));
    const receipt = await generateModelCandidate(config, { ...context, timeoutMs: 30 });
    expect(receipt).toMatchObject({ status: 'timed-out', requestStarted: true, responseDigest: null });
  });
});

/** Actual inert wrapper processes and test-owned loopback HTTP only; never vendor CLIs. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeResourceWorker, validateResourceBindings, type ResourceBinding, type ResourceWorkerTask } from '../src/core/resources/worker.js';
import type { ResourcePool, ResourceWorker } from '../src/core/resources/pool-policy.js';

let fixtureRoot: string;
let cleanups: Array<() => Promise<void>>;
beforeEach(() => { fixtureRoot = mkdtempSync(join(tmpdir(), 'ashlr-resource-worker-')); cleanups = []; });
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function worker(provider: ResourceWorker['provider'] = 'codex', id = 'worker-a'): ResourceWorker {
  return { id, provider, model: 'fixture-model', maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 };
}
function pool(workers = [worker()]): ResourcePool { return { schemaVersion: 1, id: 'fixture', workers }; }
function task(patch: Partial<ResourceWorkerTask> = {}): ResourceWorkerTask {
  return { prompt: 'TASK_ONLY_ON_STDIN\nExplain the explicit fixture.', cwd: fixtureRoot,
    timeoutMs: 5_000, maxOutputTokens: 100, mode: 'read-only', ...patch };
}
function codexEvents(text = 'fixture completed', usage: unknown = { input_tokens: 12, cached_input_tokens: 8, output_tokens: 4 }) {
  return [{ type: 'thread.started', thread_id: 'fixture-thread' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed', usage }];
}
function claudeEvents(patch: Record<string, unknown> = {}) {
  return [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', is_error: false,
    result: 'fixture completed', usage: { input_tokens: 12, output_tokens: 4,
      cache_creation_input_tokens: 6, cache_read_input_tokens: 8 }, ...patch }];
}
function nativeFixture(rows: unknown[] | string, extra = '', exitCode = 0): ResourceBinding {
  const script = join(fixtureRoot, `worker-${Math.random().toString(16).slice(2)}.cjs`);
  const transcript = typeof rows === 'string' ? rows : rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(script, [
    'const fs=require("node:fs");const chunks=[];',
    'process.stdin.on("data",chunk=>chunks.push(chunk));',
    'process.stdin.on("end",()=>{',
    `fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'invocation.json'))},JSON.stringify({argv:process.argv.slice(2),`,
    'prompt:Buffer.concat(chunks).toString("utf8"),cwd:process.cwd(),env:process.env}));',
    extra || `process.stdout.write(${JSON.stringify(transcript)},()=>{process.exitCode=${exitCode};});`,
    '});',
  ].join(''));
  return { workerId: 'worker-a', capacityKey: 'account-a', kind: 'native-cli', command: [process.execPath, script] };
}
function invocation() { return JSON.parse(readFileSync(join(fixtureRoot, 'invocation.json'), 'utf8')) as {
  argv: string[]; prompt: string; cwd: string; env: Record<string, string>;
}; }
async function endpoint(respond: (res: ServerResponse, req: IncomingMessage) => void) {
  const requests: Array<{ headers: IncomingMessage['headers']; url: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      respond(res, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable');
  const binding: ResourceBinding = { workerId: 'worker-a', capacityKey: 'local-a', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` };
  return { binding, requests };
}
function completion(usage: unknown = { prompt_tokens: 12, completion_tokens: 4 }, message: Record<string, unknown> = { content: 'fixture completed' }) {
  return { choices: [{ message }], usage };
}

describe('resource worker exact enrollment', () => {
  it('detaches and freezes complete bindings and normalizes numeric loopback', () => {
    const values: ResourceBinding[] = [nativeFixture(codexEvents()),
      { workerId: 'local-b', capacityKey: 'local-b', kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/' }];
    const result = validateResourceBindings(values, pool([worker(), worker('local', 'local-b')]));
    expect(result[1]).toMatchObject({ endpoint: 'http://127.0.0.1:12345/v1' });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0])).toBe(true);
    if (result[0]?.kind !== 'native-cli' || values[0]?.kind !== 'native-cli') throw new Error('Fixture type');
    expect(Object.isFrozen(result[0].command)).toBe(true);
    values[0].command.push('later'); expect(result[0].command).toHaveLength(2);
  });

  it.each([
    [], [{ workerId: 'orphan', capacityKey: 'account-a', kind: 'native-cli', command: ['/fixture'] }],
    [{ workerId: 'worker-a', capacityKey: 'UPPER', kind: 'native-cli', command: ['/fixture'] }],
    [{ workerId: 'worker-a', capacityKey: 'account-a', kind: 'native-cli', command: ['relative'] }],
    [{ workerId: 'worker-a', capacityKey: 'account-a', kind: 'native-cli', command: ['/fixture', 'bad\0arg'] }],
    [{ workerId: 'worker-a', capacityKey: 'account-a', kind: 'native-cli', command: ['/fixture'], env: {} }],
    [{ workerId: 'worker-a', capacityKey: 'account-a', kind: 'local-chat', endpoint: 'http://127.0.0.1:1234/v1' }],
    new Array(1),
  ])('rejects incomplete, malformed, or provider-mismatched bindings %#', (value) => {
    expect(() => validateResourceBindings(value, pool())).toThrow('Invalid resource bindings');
  });

  it.each(['https://127.0.0.1/v1', 'http://localhost/v1', 'http://192.0.2.1/v1',
    'http://name:password@127.0.0.1/v1', 'http://127.0.0.1/v1?token=fixture', 'http://127.0.0.1/other'])(
    'rejects noncanonical local transport scope %s', (url) => {
    expect(() => validateResourceBindings([{ workerId: 'worker-a', capacityKey: 'local-a', kind: 'local-chat', endpoint: url }],
      pool([worker('local')]))).toThrow('Invalid resource bindings');
  });

  it('rejects duplicate or extra identity rows and getter-based configuration without invoking getters', () => {
    const binding = nativeFixture(codexEvents());
    expect(() => validateResourceBindings([binding, binding], pool([worker(), worker('codex', 'worker-b')]))).toThrow();
    let read = false; const value = { ...binding };
    Object.defineProperty(value, 'kind', { get: () => { read = true; return 'native-cli'; } });
    expect(() => validateResourceBindings([value], pool())).toThrow();
    expect(read).toBe(false);
  });

  it.each(['provider', 'maxConcurrent', 'maxTasksPerWindow', 'taskWindowMs'] as const)(
    'rejects conflicting %s settings within a shared capacity key', (field) => {
    const second = worker('codex', 'worker-b');
    const changed = { ...second, [field]: field === 'provider' ? 'claude' : Number(second[field]) + 1 };
    const first = nativeFixture(codexEvents());
    expect(() => validateResourceBindings([first, { ...first, workerId: 'worker-b' }],
      pool([worker(), changed as ResourceWorker]))).toThrow('shared capacity');
  });

  it('permits multiple explicit models sharing one consistently capped account', () => {
    const first = nativeFixture(codexEvents()); const second = { ...worker('codex', 'worker-b'), model: 'other-model' };
    expect(validateResourceBindings([first, { ...first, workerId: 'worker-b' }], pool([worker(), second]))).toHaveLength(2);
  });
});

describe('resource native worker terminal and accounting evidence', () => {
  it('uses exact Codex sandbox/stdin arguments and omits ambient credential and loader variables', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'dummy-not-a-secret'); vi.stubEnv('ANTHROPIC_API_KEY', 'dummy-not-a-secret');
    vi.stubEnv('NODE_OPTIONS', '--require /fixture/not-used'); vi.stubEnv('CODEX_HOME', '/fixture/not-used');
    const binding = nativeFixture(codexEvents()); const request = task();
    const result = await executeResourceWorker(worker(), binding, request);
    expect(result).toEqual({ status: 'completed', output: 'fixture completed', inputTokens: 12, outputTokens: 4,
      usageScope: 'codex-turn', reason: 'worker-completed', nativeProcess: { schemaVersion: 1, scope: 'native-process',
        exitCode: 0, signal: null, stderrPresent: false, outputTruncated: false } });
    expect(invocation().argv).toEqual(['exec', '--model', 'fixture-model', '--cd', fixtureRoot, '--sandbox', 'read-only',
      '--json', '--ephemeral', '--ignore-user-config', '-']);
    expect(invocation().prompt).toBe(request.prompt); expect(invocation().argv.join(' ')).not.toContain('TASK_ONLY_ON_STDIN');
    expect(invocation().env.HOME).toBe(process.env.HOME);
    // macOS may add its own CoreFoundation text-encoding marker after spawn.
    expect(Object.keys(invocation().env).filter((key) => key !== '__CF_USER_TEXT_ENCODING').sort()).toEqual(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((key) => process.env[key] !== undefined).sort());
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'CODEX_HOME']) {
      expect(invocation().env[key]).toBeUndefined();
    }
  });

  it('uses explicitly requested Codex workspace-write without disabling rule or approval boundaries', async () => {
    await executeResourceWorker(worker(), nativeFixture(codexEvents()), task({ mode: 'workspace-write' }));
    expect(invocation().argv).toContain('workspace-write');
    expect(invocation().argv.some((arg) => /bypass|ignore-rules|full-auto/.test(arg))).toBe(false);
  });

  it.each(['read-only', 'workspace-write'] as const)('uses explicit restricted Claude %s tools and permissions', async (mode) => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents()), task({ mode }));
    expect(result).toMatchObject({ status: 'completed', inputTokens: 26, outputTokens: 4, usageScope: 'claude-main-loop' });
    expect(invocation().argv).toEqual(['-p', '--model', 'fixture-model', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--safe-mode', '--restricted', '--strict-mcp-config', '--tools',
      mode === 'read-only' ? '' : 'Read,Glob,Grep,Edit,Write', '--permission-mode', mode === 'read-only' ? 'plan' : 'acceptEdits']);
  });

  it('sums Codex completed turn usage without double-counting cached input or retaining intermediate output', async () => {
    const rows = [...codexEvents('first'), ...codexEvents('final', { input_tokens: 5, cached_input_tokens: 4, output_tokens: 2 })];
    const result = await executeResourceWorker(worker(), nativeFixture(rows), task());
    expect(result).toMatchObject({ status: 'completed', output: 'final', inputTokens: 17, outputTokens: 6 });
  });

  it.each([undefined, {}, { input_tokens: 12 }, { input_tokens: -1, output_tokens: 4 }, { input_tokens: 1.5, output_tokens: 4 }])(
    'keeps incomplete or invalid Codex reported usage unknown %#', async (usage) => {
    const rows = codexEvents(); rows.at(-1)!.usage = usage;
    const result = await executeResourceWorker(worker(), nativeFixture(rows), task());
    expect(result).toMatchObject({ status: 'completed', inputTokens: null, outputTokens: null });
    expect(result).not.toHaveProperty('usageScope');
  });

  it('retains genuine reported zeros and withholds unsafe summed counts', async () => {
    const zero = await executeResourceWorker(worker(), nativeFixture(codexEvents('zero', { input_tokens: 0, output_tokens: 0 })), task());
    expect(zero).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    const overflow = await executeResourceWorker(worker(), nativeFixture([
      ...codexEvents('one', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }), ...codexEvents('two'),
    ]), task());
    expect(overflow).toMatchObject({ inputTokens: null, outputTokens: null });
    const pairOverflow = await executeResourceWorker(worker(), nativeFixture(codexEvents('pair', {
      input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1,
    })), task());
    expect(pairOverflow).toMatchObject({ status: 'completed', inputTokens: null, outputTokens: null });
  });

  it.each([
    { input_tokens: 12, output_tokens: 4 },
    { input_tokens: 12, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: null },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ])('does not fabricate Claude cache-inclusive input usage %#', async (usage) => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents({ usage })), task());
    expect(result).toMatchObject({ status: 'completed', inputTokens: null, outputTokens: null });
    expect(result).not.toHaveProperty('usageScope');
  });

  it.each([
    ['plain stdout', 'worker-invalid-events'],
    [JSON.stringify({ type: 'turn.started' }), 'worker-terminal-missing'],
    [codexEvents().slice(0, -1), 'worker-terminal-missing'],
    [[...codexEvents(), { type: 'turn.failed', error: { message: 'PRIVATE_VENDOR_ERROR' } }], 'worker-terminal-failed'],
    [[...codexEvents(), { type: 'error', message: 'PRIVATE_VENDOR_ERROR' }], 'worker-terminal-failed'],
  ] as const)('does not equate exit zero with native success %#', async (rows, reason) => {
    const result = await executeResourceWorker(worker(), nativeFixture(rows as unknown[] | string), task());
    expect(result.status).toBe('failed'); expect(result.reason).toBe(reason); expect(result.reason).not.toContain('PRIVATE');
  });

  it.each([{ subtype: 'error_max_turns', is_error: true }, { subtype: 'success', is_error: true }, { subtype: 'success', is_error: undefined }])(
    'requires Claude terminal success without an error indicator %#', async (patch) => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents(patch)), task());
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-terminal-failed', inputTokens: 26, outputTokens: 4 });
  });

  it('refuses duplicate Claude terminal results', async () => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture([...claudeEvents(), ...claudeEvents()]), task());
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-terminal-missing', inputTokens: null });
    expect(result).not.toHaveProperty('usageScope');
  });

  it.each([
    { terminal_reason: 'aborted_streaming' }, { terminal_reason: 'aborted_tools' },
    { terminal_reason: 'max_turns' }, { terminal_reason: 'api_error' }, { terminal_reason: 'future-reason' },
    { terminal_reason: false }, { api_error_status: 429 }, { api_error_status: 'malformed' },
    { deferred_tool_use: { id: 'deferred', name: 'Edit', input: {} } },
  ])('does not promote contradictory Claude terminal completion metadata %#', async (patch) => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents(patch)), task());
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-terminal-failed',
      inputTokens: 26, outputTokens: 4, usageScope: 'claude-main-loop' });
  });

  it.each([{}, { terminal_reason: null }, { terminal_reason: 'completed', api_error_status: null,
    deferred_tool_use: null, origin: { kind: 'human' } }])('accepts legacy or explicit completed Claude metadata %#', async (patch) => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents(patch)), task());
    expect(result).toMatchObject({ status: 'completed', inputTokens: 26, outputTokens: 4, usageScope: 'claude-main-loop' });
  });

  it.each([{ kind: 'task-notification' }, { kind: 'remote' }, {}, 'human', false])(
    'refuses injected or malformed Claude result origins without attributing their usage %#', async (origin) => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents({ origin })), task());
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-result-origin-unexpected', inputTokens: null, outputTokens: null });
    expect(result).not.toHaveProperty('usageScope');
  });

  it('withholds reset or cumulative multi-result Claude accounting instead of adding or selecting totals', async () => {
    const reset = await executeResourceWorker(worker('claude'), nativeFixture([
      { type: 'conversation_reset', new_conversation_id: 'new-conversation' }, ...claudeEvents(),
    ]), task());
    expect(reset).toMatchObject({ status: 'failed', reason: 'worker-conversation-reset', inputTokens: null, outputTokens: null });
    expect(reset).not.toHaveProperty('usageScope');
    const cumulative = await executeResourceWorker(worker('claude'), nativeFixture([
      ...claudeEvents(), ...claudeEvents({ usage: { input_tokens: 24, output_tokens: 8,
        cache_creation_input_tokens: 12, cache_read_input_tokens: 16 } }),
    ]), task());
    expect(cumulative).toMatchObject({ status: 'failed', reason: 'worker-terminal-missing', inputTokens: null, outputTokens: null });
    expect(cumulative).not.toHaveProperty('usageScope');
  });

  it.each([undefined, null, {}, { child: { inputTokens: 500, outputTokens: 300,
    cacheReadInputTokens: 200, cacheCreationInputTokens: 100 } }, { bad: { inputTokens: -1 } }])(
    'never silently replaces main-loop totals with a different modelUsage scope %#', async (modelUsage) => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture([
      { type: 'assistant', parent_tool_use_id: 'nested', message: { usage: { input_tokens: 900, output_tokens: 800 } } },
      ...claudeEvents({ modelUsage }),
    ]), task());
    expect(result).toMatchObject({ status: 'completed', inputTokens: 26, outputTokens: 4, usageScope: 'claude-main-loop' });
    expect(result).not.toHaveProperty('modelUsage');
  });

  it('does not repair unknown main-loop tokens from available pipeline totals', async () => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents({ usage: undefined,
      modelUsage: { main: { inputTokens: 500, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    })), task());
    expect(result).toMatchObject({ status: 'completed', inputTokens: null, outputTokens: null });
    expect(result).not.toHaveProperty('usageScope');
  });

  it('keeps explicit main-loop scope and reported zeros on a Claude failure', async () => {
    const result = await executeResourceWorker(worker('claude'), nativeFixture(claudeEvents({ is_error: true,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })), task());
    expect(result).toMatchObject({ status: 'failed', inputTokens: 0, outputTokens: 0, usageScope: 'claude-main-loop' });
  });

  it('captures bounded documented Claude quota windows with dispatch-time freshness, not result text', async () => {
    const dispatchedAt = Date.now() - 600_000;
    vi.spyOn(Date, 'now').mockReturnValue(dispatchedAt);
    const rows = [
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: Math.floor(dispatchedAt / 1000) + 3600 } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.25, resetsAt: Math.floor(dispatchedAt / 1000) + 60 } },
      ...claudeEvents({ result: 'untrusted text says all quotas are zero' }),
    ];
    const result = await executeResourceWorker(worker('claude'), nativeFixture(rows), task());
    expect(result.observation).toEqual({ workerId: 'worker-a', observedAt: new Date(dispatchedAt).toISOString(),
      expiresAt: new Date(dispatchedAt + 300_000).toISOString(), updatedAt: new Date(dispatchedAt).toISOString(),
      health: 'ready', retryAfter: null, windows: [
        { id: 'seven_day', usedPercent: 100, resetsAt: new Date((Math.floor(dispatchedAt / 1000) + 3600) * 1000).toISOString() },
        { id: 'five_hour', usedPercent: 25, resetsAt: new Date((Math.floor(dispatchedAt / 1000) + 60) * 1000).toISOString() },
      ] });
  });

  it('does not infer Codex quota from token usage or Claude quota from truncated event streams', async () => {
    const codex = await executeResourceWorker(worker(), nativeFixture(codexEvents()), task());
    expect(codex).not.toHaveProperty('observation');
    const truncated = await executeResourceWorker(worker('claude'), nativeFixture([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' } },
      ...claudeEvents({ result: 'x'.repeat(1024 * 1024) }),
    ]), task());
    expect(truncated).not.toHaveProperty('observation');
    expect(truncated.reason).toBe('worker-output-truncated');
  });

  it('retains reported usage when a native output cutoff or nonzero exit rejects the task', async () => {
    const cutoff = await executeResourceWorker(worker(), nativeFixture(codexEvents()), task({ maxOutputTokens: 3 }));
    expect(cutoff).toMatchObject({ status: 'failed', reason: 'worker-output-token-limit', inputTokens: 12, outputTokens: 4 });
    const exit = await executeResourceWorker(worker(), nativeFixture(codexEvents(), '', 2), task());
    expect(exit).toMatchObject({ status: 'failed', reason: 'worker-exit-failed', inputTokens: 12, outputTokens: 4,
      nativeProcess: { exitCode: 2, signal: null, stderrPresent: false, outputTruncated: false } });
  });

  it('records a real inert-process exit and stderr presence without retaining stderr text', async () => {
    const binding = nativeFixture([], 'process.stderr.write("PRIVATE_NATIVE_STDERR");process.exitCode=23;');
    const result = await executeResourceWorker(worker(), binding, task());
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-exit-failed',
      nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 23, signal: null,
        stderrPresent: true, outputTruncated: false } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NATIVE_STDERR');
  });

  it.skipIf(process.platform === 'win32')('keeps a real native signal distinct from a synthesized exit code', async () => {
    const result = await executeResourceWorker(worker(), nativeFixture([], 'process.kill(process.pid,"SIGTERM");'), task());
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-exit-failed', nativeProcess: { exitCode: null, signal: 'SIGTERM' } });
  });

  it('refuses truncated native output even when the visible tail contains a success event', async () => {
    const result = await executeResourceWorker(worker(), nativeFixture([
      { type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(1024 * 1024) } }, ...codexEvents(),
    ]), task());
    expect(result).toEqual({ status: 'failed', reason: 'worker-output-truncated', output: '', inputTokens: null, outputTokens: null,
      nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: false, outputTruncated: true } });
  });

  it('accepts complete native evidence longer than the legacy verification capture cap', async () => {
    const output = 'fixture-output '.repeat(5_000);
    const result = await executeResourceWorker(worker(), nativeFixture(codexEvents(output)), task());
    expect(result).toMatchObject({ status: 'completed', output, inputTokens: 12, outputTokens: 4 });
  });

  it('does not start a fixture process for cancellation or invalid task scope', async () => {
    const binding = nativeFixture(codexEvents()); const controller = new AbortController(); controller.abort();
    const cancelled = await executeResourceWorker(worker(), binding, task(), controller.signal);
    expect(cancelled).toMatchObject({ status: 'cancelled' }); expect(cancelled).not.toHaveProperty('nativeProcess');
    expect(existsSync(join(fixtureRoot, 'invocation.json'))).toBe(false);
    for (const patch of [{ cwd: '.' }, { timeoutMs: 0 }, { maxOutputTokens: 0 }, { prompt: 'x'.repeat(1024 * 1024 + 1) }]) {
      expect(await executeResourceWorker(worker(), binding, task(patch))).toMatchObject({ reason: 'worker-invalid-configuration' });
      expect(existsSync(join(fixtureRoot, 'invocation.json'))).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')('reports process-ownership uncertainty on cooperative timeout rather than inventing clean termination', async () => {
    const binding = nativeFixture([], 'console.log(JSON.stringify({type:"turn.started"}));setInterval(()=>{},1000);');
    const result = await executeResourceWorker(worker(), binding, task({ timeoutMs: 300 }));
    expect(result).toMatchObject({ status: 'uncertain', reason: 'worker-termination-uncertain', inputTokens: null, outputTokens: null,
      nativeProcess: { exitCode: null, signal: 'SIGTERM', stderrPresent: true, outputTruncated: false } });
  });
});

describe('resource local-chat worker transport', () => {
  it('contacts only the explicit endpoint once with no auth/tools and an enforced output request limit', async () => {
    const fixture = await endpoint((res) => res.end(JSON.stringify(completion())));
    const result = await executeResourceWorker(worker('local'), fixture.binding, task());
    expect(result).toEqual({ status: 'completed', output: 'fixture completed', inputTokens: 12, outputTokens: 4,
      usageScope: 'local-chat-completion', reason: 'worker-completed' });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ url: '/v1/chat/completions', body: {
      model: 'fixture-model', messages: [{ role: 'user', content: task().prompt }], stream: false, max_tokens: 100,
    } });
    expect(fixture.requests[0]?.headers.authorization).toBeUndefined();
    expect(fixture.requests[0]?.body).not.toHaveProperty('tools');
    expect(JSON.stringify(fixture.requests[0]?.body)).not.toContain(fixtureRoot);
  });

  it.each([undefined, {}, { prompt_tokens: 12 }, { prompt_tokens: -1, completion_tokens: 4 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }])(
    'does not promote provider-client estimates to reported usage %#', async (usage) => {
    const fixture = await endpoint((res) => res.end(JSON.stringify({ ...completion(), usage })));
    expect(await executeResourceWorker(worker('local'), fixture.binding, task())).toMatchObject({
      status: 'completed', inputTokens: null, outputTokens: null,
    });
  });

  it('retains local usage on tool-call refusal and a reported output overrun', async () => {
    const fixture = await endpoint((res) => res.end(JSON.stringify(completion(undefined, {
      content: 'not accepted', tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'fixture', arguments: '{}' } }],
    }))));
    expect(await executeResourceWorker(worker('local'), fixture.binding, task())).toMatchObject({
      status: 'failed', reason: 'worker-tool-calls-not-allowed', inputTokens: 12, outputTokens: 4,
    });
    const excessive = await endpoint((res) => res.end(JSON.stringify(completion({ prompt_tokens: 12, completion_tokens: 101 }))));
    expect(await executeResourceWorker(worker('local'), excessive.binding, task())).toMatchObject({
      status: 'failed', reason: 'worker-output-token-limit', inputTokens: 12, outputTokens: 101,
    });
  });

  it('does not follow endpoint redirects or retry provider errors', async () => {
    const target = await endpoint((res) => res.end(JSON.stringify(completion())));
    const redirected = await endpoint((res) => { res.statusCode = 307; res.setHeader('location', `${target.binding.kind === 'local-chat' ? target.binding.endpoint : ''}/chat/completions`); res.end(); });
    expect(await executeResourceWorker(worker('local'), redirected.binding, task())).toMatchObject({ status: 'failed', reason: 'worker-transport-failed' });
    expect(redirected.requests).toHaveLength(1); expect(target.requests).toHaveLength(0);
    const rejected = await endpoint((res) => { res.statusCode = 429; res.end('PRIVATE_VENDOR_ERROR'); });
    const result = await executeResourceWorker(worker('local'), rejected.binding, task());
    expect(result).toMatchObject({ status: 'failed', reason: 'worker-transport-failed', inputTokens: null, outputTokens: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VENDOR_ERROR'); expect(rejected.requests).toHaveLength(1);
  });

  it('rejects request-envelope overflow before contact and response overflow without treating partial bytes as success', async () => {
    const fixture = await endpoint((res) => res.end(JSON.stringify(completion())));
    expect(await executeResourceWorker(worker('local'), fixture.binding, task({ prompt: 'x'.repeat(1024 * 1024) }))).toMatchObject({ status: 'failed' });
    expect(fixture.requests).toHaveLength(0);
    const oversized = await endpoint((res) => res.end(JSON.stringify(completion(undefined, { content: 'x'.repeat(1024 * 1024) }))));
    expect(await executeResourceWorker(worker('local'), oversized.binding, task())).toMatchObject({ status: 'failed', reason: 'worker-transport-failed', inputTokens: null });
  });

  it('honors pre-cancel, in-flight cancellation, and timeout without retries', async () => {
    const fixture = await endpoint(() => {}); const before = new AbortController(); before.abort();
    expect(await executeResourceWorker(worker('local'), fixture.binding, task(), before.signal)).toMatchObject({ status: 'cancelled' });
    expect(fixture.requests).toHaveLength(0);
    const during = new AbortController(); const pending = executeResourceWorker(worker('local'), fixture.binding, task(), during.signal);
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1)); during.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', inputTokens: null, outputTokens: null });
    expect(await executeResourceWorker(worker('local'), fixture.binding, task({ timeoutMs: 30 }))).toMatchObject({ status: 'timed-out' });
    expect(fixture.requests).toHaveLength(2);
  });

  it('rejects a completed response past monotonic deadline even before the timer callback and retains its usage', async () => {
    let responseSent = false;
    const fixture = await endpoint((res) => { responseSent = true; res.end(JSON.stringify(completion())); });
    const monotonicNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow() + (responseSent ? 1_000 : 0));
    const result = await executeResourceWorker(worker('local'), fixture.binding, task({ timeoutMs: 500 }));
    expect(result).toMatchObject({ status: 'timed-out', reason: 'worker-timed-out', inputTokens: 12, outputTokens: 4 });
    expect(fixture.requests).toHaveLength(1);
  });
});

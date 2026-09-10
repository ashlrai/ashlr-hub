/** Test-owned loopback HTTP and inert native wrappers only; never vendor CLIs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { getEventListeners } from 'node:events';
import { executeResourceWorker, type ResourceBinding, type ResourceWorkerTask } from '../src/core/resources/worker.js';
import type { ResourceWorker } from '../src/core/resources/pool-policy.js';
import * as policy from '../src/core/sandbox/policy.js';
import * as verification from '../src/core/run/verify-commands.js';

let root: string;
let cleanups: Array<() => Promise<void>>;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-kill-fixture-')));
  vi.stubEnv('HOME', root); mkdirSync(join(root, '.ashlr'), { mode: 0o700 }); cleanups = [];
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
function worker(provider: ResourceWorker['provider'] = 'local'): ResourceWorker {
  return { id: 'fixture-worker', provider, model: 'inert-fixture', maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 2, taskWindowMs: 60_000, priority: 1 };
}
function task(): ResourceWorkerTask {
  return { prompt: 'A local fixture, not a model request.', cwd: root, timeoutMs: 10_000, maxOutputTokens: 100, mode: 'read-only' };
}
function engage(): void { writeFileSync(join(root, '.ashlr', 'KILL'), 'test-owned kill\n', { mode: 0o600 }); }
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() >= end) throw new Error('Fixture condition timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function endpoint(respond: (response: ServerResponse) => void) {
  let requests = 0; let closed = false;
  const server = createServer((request, response) => {
    request.resume(); request.once('end', () => {
      requests++; response.once('close', () => { closed = true; }); respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const binding: ResourceBinding = { workerId: 'fixture-worker', capacityKey: 'local-fixture', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` };
  return { binding, requests: () => requests, closed: () => closed };
}
function native(linger = false): ResourceBinding {
  const path = join(root, 'worker.cjs');
  writeFileSync(path, `const fs=require('node:fs');
    process.stdin.resume(); process.stdin.on('end',()=>{
      fs.appendFileSync(${JSON.stringify(join(root, 'invocations'))},'once\\n');
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'work completed before stop'}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:4}}));
      ${linger ? `process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(join(root, 'signal'))},'SIGINT');
        setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(root, 'cleaned'))},'cleaned');process.exit(0);},80);});
        setInterval(()=>{},1000);` : ''}
      fs.writeFileSync(${JSON.stringify(join(root, 'ready'))},String(process.pid));
    });`, { mode: 0o600 });
  return { workerId: 'fixture-worker', capacityKey: 'native-fixture', kind: 'native-cli', command: [process.execPath, path] };
}

describe('shared KILL enforcement at resource transport boundary', () => {
  it('denies pre-existing KILL without contacting local HTTP or a native wrapper', async () => {
    const http = await endpoint(() => undefined); const binding = native(); engage();
    for (const [source, value] of [[worker(), http.binding], [worker('codex'), binding]] as const) {
      expect(await executeResourceWorker(source, value, task())).toEqual({ status: 'cancelled', reason: 'worker-kill-active',
        output: '', inputTokens: null, outputTokens: null });
    }
    expect(http.requests()).toBe(0); expect(existsSync(join(root, 'invocations'))).toBe(false);
  });

  it.each(['directory', 'symlink'])('fails closed on a malformed %s KILL sentinel', async (kind) => {
    const http = await endpoint(() => undefined);
    if (kind === 'directory') mkdirSync(join(root, '.ashlr', 'KILL'));
    else symlinkSync(join(root, 'absent'), join(root, '.ashlr', 'KILL'));
    expect(await executeResourceWorker(worker(), http.binding, task())).toMatchObject({ status: 'cancelled', reason: 'worker-kill-unavailable' });
    expect(http.requests()).toBe(0);
  });

  it('fails closed when reading shared kill authority throws', async () => {
    const http = await endpoint(() => undefined);
    vi.spyOn(policy, 'readKillSwitch').mockImplementation(() => { throw new Error('Private unreadable authority path'); });
    const result = await executeResourceWorker(worker(), http.binding, task());
    expect(result).toMatchObject({ status: 'cancelled', reason: 'worker-kill-unavailable' });
    expect(JSON.stringify(result)).not.toContain('Private'); expect(http.requests()).toBe(0);
  });

  it.each(['active', 'unknown'])('aborts in-flight local HTTP on %s KILL and never redispatches', async (state) => {
    const http = await endpoint(() => undefined);
    const timer = vi.spyOn(globalThis, 'setInterval');
    const pending = executeResourceWorker(worker(), http.binding, task());
    await until(() => http.requests() === 1);
    if (state === 'active') engage(); else mkdirSync(join(root, '.ashlr', 'KILL'));
    expect(await pending).toMatchObject({ status: 'cancelled', reason: state === 'active' ? 'worker-kill-active' : 'worker-kill-unavailable',
      inputTokens: null, outputTokens: null });
    await until(http.closed);
    expect(timer.mock.calls.some((call) => call[1] === 50)).toBe(true);
    expect(http.requests()).toBe(1);
    expect(await executeResourceWorker(worker(), http.binding, task())).toMatchObject({ status: 'cancelled' });
    expect(http.requests()).toBe(1);
  });

  it('preserves caller cancellation and removes its listener', async () => {
    const http = await endpoint(() => undefined); const abort = new AbortController();
    const pending = executeResourceWorker(worker(), http.binding, task(), abort.signal);
    await until(() => http.requests() === 1); abort.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', reason: 'worker-cancelled' });
    await until(http.closed); expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    expect(http.requests()).toBe(1);
  });

  it('does not start work for an already aborted caller', async () => {
    const http = await endpoint(() => undefined); const abort = new AbortController(); abort.abort();
    expect(await executeResourceWorker(worker(), http.binding, task(), abort.signal)).toMatchObject({ reason: 'worker-cancelled' });
    expect(http.requests()).toBe(0); expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('preserves normal completion and reported local usage', async () => {
    const http = await endpoint((response) => response.end(JSON.stringify({ choices: [{ message: { content: 'observed result' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 } })));
    const abort = new AbortController();
    expect(await executeResourceWorker(worker(), http.binding, task(), abort.signal)).toEqual({ status: 'completed', reason: 'worker-completed',
      output: 'observed result', inputTokens: 12, outputTokens: 4, usageScope: 'local-chat-completion' });
    expect(http.requests()).toBe(1); expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('explicitly refuses native Windows dispatch without claiming process cleanup', async () => {
    const binding = native(); const runner = vi.spyOn(verification, 'runVerifySubprocessAsync');
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const abort = new AbortController();
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      expect(await executeResourceWorker(worker('codex'), binding, task(), abort.signal)).toEqual({
        status: 'failed', reason: 'worker-kill-cancellation-unsupported', output: '', inputTokens: null, outputTokens: null,
      });
    } finally { Object.defineProperty(process, 'platform', original); }
    expect(runner).not.toHaveBeenCalled(); expect(existsSync(join(root, 'invocations'))).toBe(false);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('preserves local HTTP execution on the Windows branch', async () => {
    const http = await endpoint((response) => response.end(JSON.stringify({ choices: [{ message: { content: 'local result' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 } })));
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
      expect(await executeResourceWorker(worker(), http.binding, task())).toMatchObject({
        status: 'completed', reason: 'worker-completed', output: 'local result', inputTokens: 12, outputTokens: 4,
      });
    } finally { Object.defineProperty(process, 'platform', original); }
    expect(http.requests()).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('awaits owned native cleanup and retains completed-turn usage after KILL', async () => {
    const binding = native(true); const abort = new AbortController();
    const pending = executeResourceWorker(worker('codex'), binding, task(), abort.signal);
    cleanups.push(async () => { abort.abort(); await pending; });
    await until(() => existsSync(join(root, 'ready'))); engage();
    const result = await pending;
    expect(existsSync(join(root, 'signal'))).toBe(true); expect(existsSync(join(root, 'cleaned'))).toBe(true);
    expect(result).toMatchObject({ output: 'work completed before stop', inputTokens: 12, outputTokens: 4, usageScope: 'codex-turn',
      nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: null, outputTruncated: false } });
    // The existing runner may conservatively withhold group ownership after the
    // leader exits. KILL must not turn that uncertainty into a clean cancellation.
    expect(['cancelled', 'uncertain']).toContain(result.status);
    expect(result.reason).toBe(result.status === 'uncertain' ? 'worker-termination-uncertain' : 'worker-kill-active');
    expect(readFileSync(join(root, 'invocations'), 'utf8')).toBe('once\n');
    const pid = Number(readFileSync(join(root, 'ready'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    expect(await executeResourceWorker(worker('codex'), binding, task())).toMatchObject({ reason: 'worker-kill-active' });
    expect(readFileSync(join(root, 'invocations'), 'utf8')).toBe('once\n');
  });
});

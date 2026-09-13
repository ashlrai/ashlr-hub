/** Follow-ups use actual HTTP and one ledger; completion is a private loopback fixture. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleSnapshot, ResourceConsoleTaskInput, ResourceConsoleTranscript } from '../src/core/resources/console-types.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';

let directory: string;
const handles: ResourceConsoleServerHandle[] = [];
const endpoints: Array<ReturnType<typeof createServer>> = [];
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-followup-http-'))); });
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const endpoint of endpoints.splice(0)) {
    endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
  rmSync(directory, { recursive: true, force: true });
});
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const readHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.readToken });
const controlHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.controlToken!, origin: handle.url });
const historyPath = (id: string) => `/api/resources/tasks/${id}/history`;
function http(handle: ResourceConsoleServerHandle, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown;
} = {}): Promise<{ status: number; text: string; noStore: boolean }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: options.method ?? 'GET', agent: false,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) req.destroy(new Error('Fixture response exceeds bound')); else chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode!,
        text: Buffer.concat(chunks).toString('utf8'), noStore: response.headers['cache-control'] === 'no-store' }));
    });
    req.on('error', reject); req.setTimeout(12_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end(body);
  });
}
async function fixture(maxTasks = 100) {
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []; const held: ServerResponse[] = [];
  const endpoint = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); held.push(res); });
  });
  endpoints.push(endpoint); await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const options: ResourceConsoleServerOptions = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json'), execute: true, workspace };
  save(options.poolFile, { schemaVersion: 1, id: 'followup-http', workers: ['local-a', 'local-b'].map((id) => ({ id,
    provider: 'local', model: 'inert-followup-fixture', maxConcurrent: 1, reservePercent: 0,
    maxTasksPerWindow: maxTasks, taskWindowMs: 3_600_000, priority: 1 })) });
  save(options.bindingsFile, ['local-a', 'local-b'].map((workerId) => ({ workerId, capacityKey: 'shared-fixture',
    kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })));
  save(options.observationsFile, ['local-a', 'local-b'].map((workerId) => ({ workerId,
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    health: 'ready', windows: [], retryAfter: null })));
  const start = async (patch: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
  };
  const task = (id = 'parent', patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_FOLLOWUP ${id}`, allowedWorkerIds: ['local-a'], mode: 'read-only', timeoutMs: 20_000,
    maxOutputTokens: 100, retainHistory: true, ...patch });
  const finish = (index = 0, text = `PRIVATE_RESPONSE ${index}`) => held[index]!.end(JSON.stringify({
    choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  return { options, requests, held, start, task, finish };
}
const submit = (handle: ResourceConsoleServerHandle, task: unknown) => http(handle, '/api/resources/tasks', {
  method: 'POST', headers: controlHeaders(handle), body: task });
const pause = (handle: ResourceConsoleServerHandle, paused: boolean) => http(handle, '/api/resources/queue', {
  method: 'POST', headers: controlHeaders(handle), body: { paused } });
const remove = (handle: ResourceConsoleServerHandle, id: string) => http(handle, `${historyPath(id)}/delete`, {
  method: 'POST', headers: controlHeaders(handle), body: {} });
async function snapshot(handle: ResourceConsoleServerHandle): Promise<ResourceConsoleSnapshot> {
  const response = await http(handle, '/api/resources', { headers: readHeaders(handle) }); expect(response.status).toBe(200);
  expect(response.text).not.toContain('PRIVATE_'); return JSON.parse(response.text);
}
async function history(handle: ResourceConsoleServerHandle, id = 'parent'): Promise<ResourceConsoleTranscript> {
  const response = await http(handle, historyPath(id), { headers: readHeaders(handle) });
  expect(response.status).toBe(200); expect(response.noStore).toBe(true);
  const value = JSON.parse(response.text) as ResourceConsoleTranscript;
  expect(value.transcriptDigest).toMatch(/^[a-f0-9]{64}$/); return value;
}
async function settled(handle: ResourceConsoleServerHandle, id = 'parent') {
  await vi.waitFor(async () => expect((await snapshot(handle)).supervisor?.jobs.find((job) => job.id === id)?.state).toBe('settled'),
    { timeout: 10_000, interval: 50 });
}
async function completedParent(f: Awaited<ReturnType<typeof fixture>>, handle: ResourceConsoleServerHandle, output?: string) {
  expect((await submit(handle, f.task())).status).toBe(202);
  await vi.waitFor(() => expect(f.held).toHaveLength(1)); f.finish(0, output); await settled(handle); return history(handle);
}
const parentRef = (value: ResourceConsoleTranscript) => ({ taskId: value.id, expectedTranscriptDigest: value.transcriptDigest! });

describe('resource console follow-up HTTP contract', () => {
  it('advertises follow-up only with execution and requires control authority, not read proof', async () => {
    const f = await fixture(); const readOnly = await f.start({ execute: false, workspace: undefined });
    expect(readOnly.scope.followUpSupported).toBeUndefined();
    const input = { ...f.task('child'), parent: { taskId: 'parent', expectedTranscriptDigest: 'a'.repeat(64) } };
    expect((await http(readOnly, '/api/resources/tasks', { method: 'POST', headers: readHeaders(readOnly), body: input })).status).toBe(403);
    expect(existsSync(f.options.root)).toBe(false);
    const handle = await f.start(); expect(handle.scope).toMatchObject({ historySupported: true, followUpSupported: true });
    for (const headers of [{}, readHeaders(handle)]) {
      expect((await http(handle, '/api/resources/tasks', { method: 'POST', headers, body: input })).status).toBe(401);
    }
    expect((await http(handle, '/api/resources/tasks?root=/tmp', { method: 'POST', headers: controlHeaders(handle), body: input })).status).toBe(400);
    expect((await http(handle, '/api/resources/tasks', { method: 'POST', headers: { ...controlHeaders(handle), origin: 'https://example.invalid' }, body: input })).status).toBe(403);
    expect(f.requests).toEqual([]);
  });

  it.each([null, [], 'parent', {}, { taskId: 'parent' }, { expectedTranscriptDigest: 'a'.repeat(64) },
    { taskId: '../parent', expectedTranscriptDigest: 'a'.repeat(64) }, { taskId: 'parent', expectedTranscriptDigest: 'A'.repeat(64) },
    { taskId: 'parent', expectedTranscriptDigest: 'a'.repeat(63) },
    { taskId: 'parent', expectedTranscriptDigest: 'a'.repeat(64), prompt: 'forged context' },
    { taskId: 'parent', expectedTranscriptDigest: 'a'.repeat(64), cwd: '/tmp' },
  ])('rejects malformed or expanded parent authority %j before queueing', async (parent) => {
    const f = await fixture(); const handle = await f.start();
    expect((await submit(handle, { ...f.task('child'), parent })).status).toBe(400);
    expect((await snapshot(handle)).supervisor?.jobs).toEqual([]); expect(f.requests).toEqual([]);
  });

  it('freezes flat context on the original ledger across deletion and restart without replaying either task', async () => {
    const f = await fixture(); const first = await f.start(); const parent = await completedParent(f, first);
    const child = f.task('child', { parent: parentRef(parent), allowedWorkerIds: ['local-b'] });
    expect((await submit(first, { ...child, parent: { ...child.parent, expectedTranscriptDigest: '0'.repeat(64) } })).status).toBe(409);
    expect((await pause(first, true)).status).toBe(200);
    const queued = await submit(first, child); expect(queued.status).toBe(202); expect(queued.text).not.toContain('PRIVATE_');
    expect(JSON.parse(queued.text).job.parent).toEqual(child.parent);
    expect((await remove(first, 'parent')).status).toBe(200);
    expect((await submit(first, child)).status).toBe(202);
    expect((await submit(first, { ...child, prompt: 'changed child' })).status).toBe(409);
    expect((await submit(first, { ...child, id: 'new-child' })).status).toBe(404);
    await first.close(); const restarted = await f.start();
    expect((await submit(restarted, child)).status).toBe(202);
    expect((await pause(restarted, false)).status).toBe(200);
    await vi.waitFor(() => expect(f.held).toHaveLength(2));
    expect(f.requests[0]!.messages).toEqual([{ role: 'user', content: f.task().prompt }]);
    expect(JSON.parse(f.requests[1]!.messages[0]!.content)).toEqual({ schemaVersion: 1, kind: 'resource-console-conversation',
      context: [{ taskId: 'parent', prompt: parent.prompt, output: parent.output, outcome: 'completed' }], request: child.prompt });
    f.finish(1); await settled(restarted, 'child');
    const childHistory = await history(restarted, 'child'); expect(childHistory.prompt).toBe(child.prompt);
    expect(childHistory.parent).toEqual(child.parent); expect(childHistory.context).toHaveLength(1);
    const grandchild = f.task('grandchild', { parent: parentRef(childHistory) });
    expect((await submit(restarted, grandchild)).status).toBe(202);
    await vi.waitFor(() => expect(f.held).toHaveLength(3));
    const frame = JSON.parse(f.requests[2]!.messages[0]!.content);
    expect(frame.context.map((turn: { taskId: string }) => turn.taskId)).toEqual(['parent', 'child']);
    expect(frame.context[1].prompt).toBe(child.prompt); expect(frame.request).toBe(grandchild.prompt);
    f.finish(2); await settled(restarted, 'grandchild');
    const ledger = JSON.parse(readFileSync(join(f.options.root, 'pool-state.json'), 'utf8'));
    expect(ledger.attempts.map((attempt: { id: string }) => attempt.id)).toEqual(['parent', 'child', 'grandchild']);
    expect(ledger.attempts.every((attempt: { capacityKey: string }) => attempt.capacityKey === 'shared-fixture')).toBe(true);
    expect(new Set(ledger.attempts.map((attempt: { taskDigest: string }) => attempt.taskDigest)).size).toBe(3);
    expect((await submit(restarted, child)).status).toBe(202); expect(f.requests).toHaveLength(3);
  });

  it('refuses missing/nonterminal parents and own-prompt overflow before dispatch', async () => {
    const f = await fixture(); const handle = await f.start();
    const parent = { taskId: 'parent', expectedTranscriptDigest: 'a'.repeat(64) };
    expect((await submit(handle, f.task('child', { parent }))).status).toBe(404);
    expect((await pause(handle, true)).status).toBe(200); expect((await submit(handle, f.task())).status).toBe(202);
    expect((await submit(handle, f.task('child', { parent: parentRef(await history(handle)) }))).status).toBe(409);
    expect((await submit(handle, f.task('oversized', { prompt: 'x'.repeat(32 * 1024 + 1), parent }))).status).toBe(400);
    expect(f.requests).toEqual([]);
  });

  it('preserves a cancelled parent and null output explicitly instead of inventing a response', async () => {
    const f = await fixture(); const handle = await f.start(); await pause(handle, true); await submit(handle, f.task());
    expect((await http(handle, '/api/resources/tasks/parent/cancel', { method: 'POST', headers: controlHeaders(handle), body: {} })).status).toBe(200);
    const parent = await history(handle); expect(parent.output).toBeNull();
    const child = f.task('child', { parent: parentRef(parent) }); expect((await submit(handle, child)).status).toBe(202);
    await pause(handle, false); await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect(JSON.parse(f.requests[0]!.messages[0]!.content).context).toEqual([
      { taskId: 'parent', prompt: parent.prompt, output: null, outcome: 'cancelled' },
    ]);
    f.finish(); await settled(handle, 'child');
  });

  it('carries explicitly truncated retained context above32KiB without truncating the child request', async () => {
    const f = await fixture(); const handle = await f.start(); const parent = await completedParent(f, handle, 'x'.repeat(70 * 1024));
    expect(parent.output?.truncated).toBe(true); expect(Buffer.byteLength(parent.output!.text)).toBe(64 * 1024);
    const child = f.task('child', { prompt: 'u'.repeat(20_000), parent: parentRef(parent) });
    expect((await submit(handle, child)).status).toBe(202); await vi.waitFor(() => expect(f.held).toHaveLength(2));
    const encoded = f.requests[1]!.messages[0]!.content; const frame = JSON.parse(encoded);
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(32 * 1024); expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(256 * 1024);
    expect(frame.context[0].output).toEqual(parent.output); expect(frame.request).toBe(child.prompt);
    f.finish(1); await settled(handle, 'child');
  });

  it('does not grant a follow-up a new shared-account task allowance', async () => {
    const f = await fixture(1); const handle = await f.start(); const parent = await completedParent(f, handle);
    expect((await submit(handle, f.task('child', { allowedWorkerIds: ['local-b'], parent: parentRef(parent) }))).status).toBe(202);
    await vi.waitFor(async () => {
      const state = await snapshot(handle);
      expect(state.supervisor?.jobs.find((job) => job.id === 'child')?.state).toBe('queued');
      expect(state.plan?.exclusions.every((row) => row.reasons.includes('operator-task-cap-reached'))).toBe(true);
    });
    expect(f.requests).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.options.root, 'pool-state.json'), 'utf8')).attempts).toHaveLength(1);
  });
});

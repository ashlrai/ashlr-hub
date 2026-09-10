/** Real scoped HTTP, durable supervisor and loopback-only completion fixture. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleSnapshot, ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';

let directory: string;
const handles: ResourceConsoleServerHandle[] = [];
const endpoints: Array<ReturnType<typeof createServer>> = [];
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-history-http-'))); });
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const endpoint of endpoints.splice(0)) {
    endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
  rmSync(directory, { recursive: true, force: true });
});
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const historyPath = (id = 'task-a') => `/api/resources/tasks/${id}/history`;
const readHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.readToken });
const controlHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.controlToken!, origin: handle.url });
function http(handle: ResourceConsoleServerHandle, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown;
} = {}): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: options.method ?? 'GET', agent: false,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length;
        if (bytes > 1024 * 1024) req.destroy(new Error('Fixture response exceeds bound')); else chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode!,
        text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    req.on('error', reject); req.setTimeout(12_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end(body);
  });
}

async function fixture() {
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const requests: unknown[] = []; const held: ServerResponse[] = [];
  const endpoint = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); held.push(res); });
  });
  endpoints.push(endpoint); await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const options: ResourceConsoleServerOptions = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json'), execute: true, workspace };
  save(options.poolFile, { schemaVersion: 1, id: 'history-http', workers: [{ id: 'local', provider: 'local', model: 'inert-history-fixture',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 100, taskWindowMs: 1000, priority: 1 }] });
  save(options.bindingsFile, [{ workerId: 'local', capacityKey: 'fixture-only', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }]);
  save(options.observationsFile, [{ workerId: 'local', observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), health: 'ready', windows: [], retryAfter: null }]);
  const start = async (patch: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
  };
  const task = (patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id: 'task-a',
    prompt: 'PRIVATE_HISTORY_PROMPT with explicit attached text', allowedWorkerIds: ['local'], mode: 'read-only',
    timeoutMs: 20_000, maxOutputTokens: 100, ...patch });
  const finish = (index = 0, text = 'PRIVATE_HISTORY_OUTPUT') => held[index]!.end(JSON.stringify({
    choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  return { options, requests, held, start, task, finish };
}
const submit = (handle: ResourceConsoleServerHandle, task: unknown) => http(handle, '/api/resources/tasks', {
  method: 'POST', headers: controlHeaders(handle), body: task });
const remove = (handle: ResourceConsoleServerHandle, id = 'task-a', body: unknown = {}) => http(handle, `${historyPath(id)}/delete`, {
  method: 'POST', headers: controlHeaders(handle), body });
async function snapshot(handle: ResourceConsoleServerHandle): Promise<ResourceConsoleSnapshot> {
  const response = await http(handle, '/api/resources', { headers: readHeaders(handle) });
  expect(response.status).toBe(200); return JSON.parse(response.text);
}
async function settle(handle: ResourceConsoleServerHandle) {
  await vi.waitFor(async () => expect((await snapshot(handle)).supervisor?.jobs[0]?.state).toBe('settled'), { timeout: 10_000, interval: 50 });
}

describe('resource console retained history HTTP boundary', () => {
  it('advertises support only for execution consoles and keeps read-only history inert', async () => {
    const f = await fixture(); const handle = await f.start({ execute: false, workspace: undefined });
    expect(handle.scope.historySupported).toBeUndefined();
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers: readHeaders(handle), body: {} })).status).toBe(403);
    expect(existsSync(f.options.root)).toBe(false); expect(f.requests).toEqual([]);
  });

  it('separates read-session proof from deletion control and rejects unknown task IDs', async () => {
    const f = await fixture(); const handle = await f.start(); expect(handle.scope.historySupported).toBe(true);
    expect((await http(handle, historyPath())).status).toBe(401);
    expect((await http(handle, historyPath(), { headers: controlHeaders(handle) })).status).toBe(401);
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    const client = randomBytes(32).toString('hex');
    const session = await http(handle, '/api/session', { method: 'POST', headers: { ...readHeaders(handle), 'x-ashlr-read-client': client } });
    expect(session.status).toBe(204); const cookie = session.headers['set-cookie']![0]!.split(';')[0]!;
    const headers = { cookie, 'x-ashlr-read-client': client };
    expect((await http(handle, historyPath(), { headers })).status).toBe(404);
    expect((await http(handle, historyPath(), { headers: { ...headers, 'x-ashlr-read-client': '0'.repeat(64) } })).status).toBe(401);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers, body: {} })).status).toBe(401);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers: readHeaders(handle), body: {} })).status).toBe(401);
    expect((await remove(handle)).status).toBe(404); expect(f.requests).toEqual([]);
  });

  it('rejects query scope, unexpected methods, origins and deletion payload fields', async () => {
    const f = await fixture(); const handle = await f.start();
    for (const suffix of ['?root=/tmp', '?client=secret', '?id=other']) {
      expect((await http(handle, `${historyPath()}${suffix}`, { headers: readHeaders(handle) })).status).toBe(400);
      expect((await http(handle, `${historyPath()}/delete${suffix}`, { method: 'POST', headers: controlHeaders(handle), body: {} })).status).toBe(400);
    }
    expect((await http(handle, historyPath(), { method: 'POST', headers: controlHeaders(handle), body: {} })).status).toBe(404);
    expect((await http(handle, historyPath(), { method: 'DELETE', headers: readHeaders(handle), body: {} })).status).toBe(405);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers: { ...controlHeaders(handle), origin: 'https://example.invalid' }, body: {} })).status).toBe(403);
    for (const body of [{ root: '/tmp' }, { id: 'task-a' }, { confirm: true }, [], null]) expect((await remove(handle, 'task-a', body)).status).toBe(400);
    expect((await submit(handle, { ...f.task({ retainHistory: true }), cwd: '/tmp' })).status).toBe(400);
    expect(f.requests).toEqual([]);
  });

  it.each([null, 'true', 1, {}, []])('rejects non-boolean retention consent %j before queueing', async (retainHistory) => {
    const f = await fixture(); const handle = await f.start();
    expect((await submit(handle, { ...f.task(), retainHistory })).status).toBe(400);
    expect((await snapshot(handle)).supervisor?.jobs).toEqual([]); expect(f.requests).toEqual([]);
  });

  it('retains exactly opted-in text across restart, deletes it without ledger loss, and never resurrects a retry', async () => {
    const f = await fixture(); const first = await f.start(); const task = f.task({ retainHistory: true });
    const queued = await submit(first, task); expect(queued.status).toBe(202); expect(queued.text).not.toContain(task.prompt);
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); f.finish(); await settle(first);
    const read = await http(first, historyPath(), { headers: readHeaders(first) }); expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store'); expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(read.text)).toEqual({ id: task.id, prompt: task.prompt,
      output: { text: 'PRIVATE_HISTORY_OUTPUT', truncated: false }, retention: 'local-until-deleted' });
    const proof = randomBytes(32).toString('hex');
    const session = await http(first, '/api/session', { method: 'POST', headers: { ...readHeaders(first), 'x-ashlr-read-client': proof } });
    expect(session.status).toBe(204); const cookie = session.headers['set-cookie']![0]!.split(';')[0]!;
    const sessionRead = await http(first, historyPath(), { headers: { cookie, 'x-ashlr-read-client': proof } });
    expect(sessionRead.status).toBe(200); expect(JSON.parse(sessionRead.text)).toEqual(JSON.parse(read.text));
    expect(sessionRead.headers['cache-control']).toBe('no-store');
    const metadata = await snapshot(first); expect(metadata.supervisor?.jobs[0]?.historyAvailable).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_HISTORY');
    const ledgerFile = join(f.options.root, 'pool-state.json'); const ledger = readFileSync(ledgerFile);
    await first.close(); const restarted = await f.start();
    const retained = await http(restarted, historyPath(), { headers: readHeaders(restarted) }); expect(retained.status).toBe(200);
    expect(JSON.parse(retained.text)).toEqual(JSON.parse(read.text)); expect(f.requests).toHaveLength(1);
    const deleted = await remove(restarted); expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.text).job.historyAvailable).toBeUndefined(); expect(deleted.text).not.toContain('PRIVATE_HISTORY');
    expect((await http(restarted, historyPath(), { headers: readHeaders(restarted) })).status).toBe(404);
    expect((await remove(restarted)).status).toBe(200); expect(readFileSync(ledgerFile)).toEqual(ledger);
    expect((await submit(restarted, task)).status).toBe(202);
    expect((await submit(restarted, { ...task, retainHistory: false })).status).toBe(409);
    expect((await http(restarted, historyPath(), { headers: readHeaders(restarted) })).status).toBe(404);
    await restarted.close(); const third = await f.start();
    expect((await http(third, historyPath(), { headers: readHeaders(third) })).status).toBe(404);
    expect(f.requests).toHaveLength(1); expect(readFileSync(ledgerFile)).toEqual(ledger);
  });

  it('keeps omitted/false consent ephemeral and immutable on retry', async () => {
    const f = await fixture(); const handle = await f.start(); const task = f.task();
    expect((await submit(handle, task)).status).toBe(202);
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); f.finish(); await settle(handle);
    expect((await submit(handle, { ...task, retainHistory: false })).status).toBe(202);
    expect((await submit(handle, { ...task, retainHistory: true })).status).toBe(409);
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    expect((await remove(handle)).status).toBe(200);
    await handle.close(); const restarted = await f.start();
    expect((await http(restarted, historyPath(), { headers: readHeaders(restarted) })).status).toBe(404);
    expect(f.requests).toHaveLength(1);
  });

  it('refuses queued/active deletion, then clears both retained history and session output after settlement', async () => {
    const f = await fixture(); const handle = await f.start();
    expect((await http(handle, '/api/resources/queue', { method: 'POST', headers: controlHeaders(handle), body: { paused: true } })).status).toBe(200);
    expect((await submit(handle, f.task({ retainHistory: true }))).status).toBe(202);
    expect((await remove(handle)).status).toBe(409); expect(f.requests).toEqual([]);
    expect((await http(handle, '/api/resources/queue', { method: 'POST', headers: controlHeaders(handle), body: { paused: false } })).status).toBe(200);
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); expect((await remove(handle)).status).toBe(409);
    f.finish(); await settle(handle); expect((await remove(handle)).status).toBe(200);
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    expect((await http(handle, '/api/resources/tasks/task-a/output', { headers: readHeaders(handle) })).status).toBe(404);
  });
});

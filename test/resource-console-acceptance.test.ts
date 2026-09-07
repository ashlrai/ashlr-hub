/** Independent real HTTP + read worker + durable supervisor acceptance. All workers are private fixtures. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import type { ResourceConsoleSnapshot, ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool, ResourceWorker } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

let base: string; let handles: ResourceConsoleServerHandle[]; let cleanup: Array<() => Promise<void>>;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-http-'))); handles = []; cleanup = []; });
afterEach(async () => {
  for (const handle of handles) await handle.close();
  for (const close of cleanup.reverse()) await close();
  rmSync(base, { recursive: true, force: true });
});
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const observation = (workerId: string, patch: Partial<ResourceObservation> = {}): ResourceObservation => ({ workerId,
  observedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
  health: 'ready', windows: [], retryAfter: null, ...patch });
interface Response { status: number; headers: IncomingHttpHeaders; body: string }
function http(handle: ResourceConsoleServerHandle, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown;
} = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const encoded = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: options.method ?? 'GET', agent: false,
      headers: { Host: `127.0.0.1:${handle.port}`, ...(encoded === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(encoded)),
      }), ...options.headers } }, (res) => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) req.destroy(new Error('Fixture response over budget')); else chunks.push(chunk); });
      res.once('error', reject); res.once('end', () => resolve({ status: res.statusCode ?? 0,
        headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(12_000, () => req.destroy(new Error('Fixture HTTP deadline')));
    req.once('error', reject); req.end(encoded);
  });
}
const readHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.readToken });
const controlHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.controlToken!, Origin: handle.url });
async function snapshot(handle: ResourceConsoleServerHandle): Promise<ResourceConsoleSnapshot> {
  const response = await http(handle, '/api/resources', { headers: readHeaders(handle) }); expect(response.status).toBe(200);
  return JSON.parse(response.body) as ResourceConsoleSnapshot;
}
async function until(handle: ResourceConsoleServerHandle, check: (value: ResourceConsoleSnapshot) => void) {
  let value: ResourceConsoleSnapshot | undefined;
  // Server retry defaults to 2 seconds and each observation uses the real worker.
  await vi.waitFor(async () => { value = await snapshot(handle); check(value); }, { timeout: 10_000, interval: 100 });
  return value!;
}
async function session(handle: ResourceConsoleServerHandle) {
  const proof = randomBytes(32).toString('hex');
  const response = await http(handle, '/api/session', { method: 'POST',
    headers: { ...readHeaders(handle), 'x-ashlr-read-client': proof, Origin: handle.url } });
  expect(response.status).toBe(204); const setCookie = response.headers['set-cookie']?.[0] ?? '';
  expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict');
  const cookie = setCookie.split(';')[0]!;
  return { cookie, proof, headers: { Cookie: cookie, 'x-ashlr-read-client': proof } };
}

async function fixture(name = 'alpha', settings: { second?: boolean; native?: boolean } = {}) {
  const directory = join(base, name); mkdirSync(directory, { mode: 0o700 });
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const root = join(directory, 'store'); const held: ServerResponse[] = []; const requests: unknown[] = [];
  const endpoint = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); held.push(res); });
  });
  await new Promise<void>((done) => endpoint.listen(0, '127.0.0.1', done));
  cleanup.push(async () => { endpoint.closeAllConnections(); await new Promise<void>((done) => endpoint.close(() => done())); });
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable');
  const worker = (id: string, provider: ResourceWorker['provider'] = 'local'): ResourceWorker => ({ id, provider,
    model: `fixture-${name}-${id}`, priority: 1, reservePercent: 10, maxConcurrent: 1,
    maxTasksPerWindow: 100, taskWindowMs: 1000 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'same-pool-id', workers: [worker('local'),
    ...(settings.second ? [worker('other')] : []), ...(settings.native ? [worker('native', 'codex')] : [])] };
  const nativePath = join(directory, 'native.cjs'); const nativeMarker = join(directory, 'native-started');
  if (settings.native) writeFileSync(nativePath, `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(nativeMarker)},'one',{mode:384,flag:'wx'});process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'PRIVATE_NATIVE_OUTPUT'}})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}})+'\\n')});`, { mode: 0o600 });
  const bindings: ResourceBinding[] = pool.workers.map((item) => item.provider === 'local'
    ? { workerId: item.id, capacityKey: item.id, kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }
    : { workerId: item.id, capacityKey: item.id, kind: 'native-cli', command: [process.execPath, nativePath] });
  const poolFile = join(directory, 'pool.json'); const bindingsFile = join(directory, 'bindings.json');
  const observationsFile = join(directory, 'observations.json');
  save(poolFile, pool); save(bindingsFile, bindings);
  const observations = () => pool.workers.map((item) => observation(item.id, item.provider === 'local' ? {} : {
    windows: [{ id: 'seven_day', usedPercent: 100, resetsAt: new Date(Date.now() + 86400_000).toISOString() }],
  }));
  save(observationsFile, observations());
  const options: ResourceConsoleServerOptions = { root, poolFile, bindingsFile, observationsFile, execute: true, workspace };
  const start = async (patch: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
  };
  const task = (id = 'task-a', patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_HTTP_TASK ${name} ${id}`, allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 20_000, maxOutputTokens: 100, ...patch });
  const finish = (index: number, output = 'PRIVATE_HTTP_OUTPUT', known = true) => held[index]!.end(JSON.stringify({
    choices: [{ message: { content: output } }], ...(known ? { usage: { prompt_tokens: 12, completion_tokens: 4 } } : {}),
  }));
  return { directory, root, workspace, pool, observationsFile, observations, options, nativeMarker, start, task, held, requests, finish };
}
const submit = (handle: ResourceConsoleServerHandle, task: ResourceConsoleTaskInput) => http(handle, '/api/resources/tasks', {
  method: 'POST', headers: controlHeaders(handle), body: task,
});
const pause = (handle: ResourceConsoleServerHandle, paused: boolean) => http(handle, '/api/resources/queue', {
  method: 'POST', headers: controlHeaders(handle), body: { paused },
});
const cancel = (handle: ResourceConsoleServerHandle, id: string) => http(handle, `/api/resources/tasks/${id}/cancel`, {
  method: 'POST', headers: controlHeaders(handle), body: {},
});

describe.skipIf(process.platform === 'win32')('independent resource console HTTP acceptance', () => {
  it('isolates identical pool ids across stores, read sessions and control capabilities', async () => {
    const alpha = await fixture('alpha'); const beta = await fixture('beta'); const a = await alpha.start(); const b = await beta.start();
    const sa = await session(a); const sb = await session(b);
    expect(a.readToken).not.toBe(b.readToken); expect(a.controlToken).not.toBe(b.controlToken);
    expect(sa.cookie.split('=')[0]).not.toBe(sb.cookie.split('=')[0]);
    const observedA = await http(a, '/api/resources', { headers: sa.headers });
    const observedB = await http(b, '/api/resources', { headers: sb.headers });
    expect(observedA.status).toBe(200); expect(observedB.status).toBe(200);
    expect(observedA.body).toContain('fixture-alpha-local'); expect(observedA.body).not.toContain('fixture-beta-local');
    expect(observedB.body).toContain('fixture-beta-local'); expect(observedB.body).not.toContain('fixture-alpha-local');
    expect((await http(b, '/api/resources', { headers: sa.headers })).status).toBe(401);
    expect((await http(b, '/api/resources', { headers: readHeaders(a) })).status).toBe(401);
    expect((await http(a, '/api/resources/tasks', { method: 'POST', headers: sa.headers, body: alpha.task() })).status).toBe(401);
    expect((await http(a, '/api/resources/tasks', { method: 'POST', headers: readHeaders(a), body: alpha.task() })).status).toBe(401);
    expect((await http(a, '/api/resources/tasks', { method: 'POST', headers: { 'x-ashlr-token': b.controlToken! }, body: alpha.task() })).status).toBe(401);
    expect((await http(a, '/api/resources', { headers: controlHeaders(a) })).status).toBe(401);
    expect(alpha.requests).toHaveLength(0); expect(beta.requests).toHaveLength(0);
  });

  it('observes missing roots without creating runtime or supervisor state and never exposes mutation authority', async () => {
    const f = await fixture(); const handle = await f.start({ execute: false, workspace: undefined });
    expect(handle.controlToken).toBeNull(); expect(handle.scope).toMatchObject({ readOnly: true, workspace: null });
    const value = await snapshot(handle); expect(value).toMatchObject({ sourceState: 'missing', supervisor: null, counts: { total: 0 } });
    expect((await submit(handle, f.task())).status).toBe(403);
    expect((await http(handle, '/health')).body).toBe('{"ok":true}');
    await handle.close(); expect(existsSync(f.root)).toBe(false); expect(f.requests).toHaveLength(0);
  });

  it('rejects unsupported scopes and methods before worker contact', async () => {
    const f = await fixture(); const handle = await f.start();
    for (const path of ['/api/resources?root=/tmp', '/api/resources?root=a&root=b', '/api/resources/console?pool=x']) {
      expect((await http(handle, path, { headers: readHeaders(handle) })).status).toBe(400);
    }
    for (const path of ['/api/events', '/api/dashboard/snapshot', '/api/fleet', '/api/universe']) {
      expect((await http(handle, path, { headers: readHeaders(handle) })).status).toBe(404);
    }
    expect((await http(handle, '/api/resources/tasks', { method: 'POST', headers: { ...controlHeaders(handle), Origin: 'http://127.0.0.1:1' }, body: f.task() })).status).toBe(403);
    expect((await http(handle, '/api/resources/tasks', { method: 'POST', headers: { ...controlHeaders(handle), Host: '127.0.0.1:1' }, body: f.task() })).status).toBe(403);
    for (const field of ['root', 'cwd', 'command', 'endpoint', 'env']) {
      expect((await submit(handle, { ...f.task(), [field]: 'not accepted' })).status).toBe(400);
    }
    expect((await http(handle, '/api/resources/tasks', { method: 'POST', headers: { ...controlHeaders(handle), 'Content-Type': 'text/plain' }, body: f.task() })).status).toBe(415);
    expect(f.requests).toHaveLength(0); expect((await snapshot(handle)).supervisor?.jobs).toEqual([]);
  });

  it('keeps actual dispatch alive after the launch connection closes, and exposes bounded output only on demand', async () => {
    const f = await fixture(); const handle = await f.start(); const input = f.task();
    const launched = await submit(handle, input); expect(launched.status).toBe(202); expect(launched.body).not.toContain(input.prompt);
    // Each HTTP helper uses agent:false; the launch socket is no longer held.
    const active = await until(handle, (value) => expect(value.supervisor?.activeCount).toBe(1));
    expect(active.activeAttempts[0]).toMatchObject({ id: input.id, status: 'reserved', verifiedAccepted: false });
    expect(active.supervisor?.jobs[0]).toMatchObject({ state: 'dispatching', workerId: 'local', cancellable: true });
    expect(f.requests).toHaveLength(1); expect(f.held[0]!.destroyed).toBe(false);
    expect((await http(handle, '/api/resources/tasks/task-a/output', { headers: readHeaders(handle) })).status).toBe(404);
    f.finish(0); const done = await until(handle, (value) => expect(value.supervisor?.jobs[0]?.state).toBe('settled'));
    expect(done).toMatchObject({ counts: { completed: 1 }, usage: { complete: true, totalInputTokens: 12, totalOutputTokens: 4 } });
    expect(JSON.stringify(done)).not.toContain('PRIVATE_HTTP_OUTPUT'); expect(JSON.stringify(done)).not.toContain('PRIVATE_HTTP_TASK');
    const output = await http(handle, '/api/resources/tasks/task-a/output', { headers: readHeaders(handle) });
    expect(output.status).toBe(200); expect(JSON.parse(output.body)).toMatchObject({ text: 'PRIVATE_HTTP_OUTPUT', truncated: false, retention: 'this-console-session' });
    const metadata = readFileSync(join(f.root, 'pool-state.json'), 'utf8'); expect(metadata).not.toContain('PRIVATE_HTTP');
    expect(read(join(f.root, 'resource-console-state.json')).jobs[0].input).toBeNull();
    expect(lstatSync(join(f.root, 'resource-console-state.json')).mode & 0o777).toBe(0o600);
    const before = hash(readFileSync(join(f.root, 'resource-console-state.json'))); expect((await submit(handle, input)).status).toBe(202);
    expect(hash(readFileSync(join(f.root, 'resource-console-state.json')))).toBe(before);
    expect((await submit(handle, { ...input, prompt: 'changed' })).status).toBe(409); expect(f.requests).toHaveLength(1);
  });

  it('pauses durable queued work, cancels a queued item and an owned request, then continues the next item', async () => {
    const f = await fixture(); const handle = await f.start({ maxParallel: 1 }); expect((await pause(handle, true)).status).toBe(200);
    for (const id of ['one', 'two', 'discard']) expect((await submit(handle, f.task(id))).status).toBe(202);
    expect((await cancel(handle, 'discard')).status).toBe(200);
    expect((await snapshot(handle)).supervisor).toMatchObject({ paused: true, queuedCount: 2, activeCount: 0 }); expect(f.requests).toHaveLength(0);
    await pause(handle, false); await until(handle, (value) => expect(value.activeAttempts[0]?.id).toBe('one'));
    expect((await cancel(handle, 'one')).status).toBe(200);
    await until(handle, (value) => expect(value.supervisor?.jobs.find((job) => job.id === 'one')?.outcome).toBe('cancelled'));
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 10_000 }); f.finish(1);
    const done = await until(handle, (value) => expect(value.supervisor?.jobs.find((job) => job.id === 'two')?.outcome).toBe('completed'));
    expect(done.supervisor?.jobs.find((job) => job.id === 'discard')).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
    expect(done.counts).toMatchObject({ total: 2, completed: 1, cancelled: 1 }); expect(done.usage.complete).toBe(false);
  });

  it('shows source degradation without aborting owned work and automatically resumes queued work after repair', async () => {
    const f = await fixture('alpha', { second: true }); const handle = await f.start();
    await submit(handle, f.task('one')); await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 10_000 });
    unlinkSync(f.observationsFile); await submit(handle, f.task('two', { allowedWorkerIds: ['other'] }));
    const degraded = await until(handle, (value) => {
      expect(value.sourceState).toBe('degraded'); expect(value.supervisor?.error).toBe('supervisor-observations-unavailable');
    });
    expect(degraded.counts.total).toBeNull(); expect(degraded.usage.complete).toBe(false);
    expect(degraded.supervisor?.activeCount).toBe(1); expect(f.held[0]!.destroyed).toBe(false); expect(f.requests).toHaveLength(1);
    expect((await pause(handle, true)).status).toBe(200); expect((await pause(handle, false)).status).toBe(200);
    writeFileSync(f.observationsFile, '{', { mode: 0o600 }); expect((await snapshot(handle)).sourceState).toBe('degraded');
    f.finish(0); await until(handle, (value) => expect(value.supervisor?.jobs[0]?.outcome).toBe('completed'));
    save(f.observationsFile, f.pool.workers.map((item) => observation(item.id, { observedAt: new Date().toISOString() })));
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 10_000 }); f.finish(1, 'PRIVATE_UNKNOWN_USAGE', false);
    const restored = await until(handle, (value) => expect(value.supervisor?.jobs[1]?.state).toBe('settled'));
    expect(restored.sourceState).toBe('healthy'); expect(restored.supervisor?.error).toBeNull();
    expect(restored.usage).toMatchObject({ complete: false, unknownAttempts: 1, totalInputTokens: null, totalOutputTokens: null });
  });

  it('keeps known exhausted native work queued until fresh quota arrives, then executes and deduplicates the actual fixture', async () => {
    const f = await fixture('alpha', { native: true }); const handle = await f.start(); const input = f.task('native-task', { allowedWorkerIds: ['native'] });
    await submit(handle, input);
    const denied = await until(handle, (value) => expect(value.plan?.exclusions.find((row) => row.workerId === 'native')?.reasons).toContain('quota-reserve-reached'));
    expect(denied.supervisor?.jobs[0]?.state).toBe('queued'); expect(existsSync(f.nativeMarker)).toBe(false);
    const fresh = f.observations().map((item) => item.workerId === 'native' ? { ...item, observedAt: new Date().toISOString(),
      windows: item.windows.map((window) => ({ ...window, usedPercent: 0 })) } : item);
    save(f.observationsFile, fresh);
    const done = await until(handle, (value) => expect(value.supervisor?.jobs[0]?.outcome).toBe('completed'));
    expect(readFileSync(f.nativeMarker, 'utf8')).toBe('one'); expect(done.usage).toMatchObject({ totalInputTokens: 5, totalOutputTokens: 2, complete: true });
    expect((await submit(handle, input)).status).toBe(202); expect((await snapshot(handle)).counts.total).toBe(1);
    expect(f.requests).toHaveLength(0);
  });

  it('waits for owned shutdown, invalidates old sessions on restart and does not replay settled tasks', async () => {
    const f = await fixture(); const first = await f.start(); const sessionBefore = await session(first);
    await submit(first, f.task()); await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 10_000 });
    const closing = first.close(); expect(first.close()).toBe(closing); await closing;
    expect(read(join(f.root, 'pool-state.json')).attempts[0].status).toBe('cancelled');
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);
    const next = await f.start({ port: first.port }); expect(next.readToken).not.toBe(first.readToken); expect(next.controlToken).not.toBe(first.controlToken);
    expect((await http(next, '/api/resources', { headers: sessionBefore.headers })).status).toBe(401);
    expect((await http(next, '/api/resources', { headers: readHeaders(first) })).status).toBe(401);
    expect((await http(next, '/api/resources/queue', { method: 'POST', headers: controlHeaders(first), body: { paused: true } })).status).toBe(401);
    const after = await snapshot(next); expect(after.supervisor?.jobs[0]).toMatchObject({ state: 'settled', outcome: 'cancelled', outputAvailable: false });
    expect(f.requests).toHaveLength(1); expect((await http(next, '/api/resources/tasks/task-a/output', { headers: readHeaders(next) })).status).toBe(404);
  });

  it('logs out the exact read session without changing queued evidence', async () => {
    const f = await fixture(); const handle = await f.start(); const connected = await session(handle);
    await pause(handle, true); await submit(handle, f.task()); const before = hash(readFileSync(join(f.root, 'resource-console-state.json')));
    expect((await http(handle, '/api/session', { method: 'DELETE', headers: { ...connected.headers, Origin: handle.url } })).status).toBe(204);
    expect((await http(handle, '/api/resources', { headers: connected.headers })).status).toBe(401);
    expect(hash(readFileSync(join(f.root, 'resource-console-state.json')))).toBe(before); expect(f.requests).toHaveLength(0);
  });
});

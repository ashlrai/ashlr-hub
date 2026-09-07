import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';

let directory: string; let options: ResourceConsoleServerOptions;
const handles: ResourceConsoleServerHandle[] = [];
function write(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-http-')));
  options = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json') };
  write(options.poolFile, { schemaVersion: 1, id: 'http-fixture', workers: [{ id: 'local', provider: 'local',
    model: 'not-a-real-model', maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] });
  write(options.bindingsFile, [{ workerId: 'local', capacityKey: 'fixture-local', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
  write(options.observationsFile, [{ workerId: 'local', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }]);
});
afterEach(async () => { await Promise.allSettled(handles.splice(0).map((handle) => handle.close())); rmSync(directory, { recursive: true, force: true }); });
async function start(extra: Partial<ResourceConsoleServerOptions> = {}) {
  const handle = await startResourceConsoleServer({ ...options, ...extra }); handles.push(handle); return handle;
}
async function http(handle: ResourceConsoleServerHandle, path: string, method = 'GET',
  headers: Record<string, string> = {}, input?: string) {
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject); req.setTimeout(15_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end(input);
  });
}

describe('resource console HTTP fences', () => {
  it('reads explicit missing-store evidence without initialization or exposing bindings', async () => {
    const original = readFileSync(options.observationsFile); const handle = await start();
    expect(handle.controlToken).toBeNull(); expect(handle.scope.readOnly).toBe(true);
    const response = await http(handle, '/api/resources', 'GET', { 'x-ashlr-token': handle.readToken });
    expect(response.status).toBe(200); const value = JSON.parse(response.text);
    expect(value.sourceState).toBe('missing'); expect(value.supervisor).toBeNull();
    expect(value.pool.id).toBe('http-fixture'); expect(response.text).not.toContain(':9/v1');
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['x-frame-options']).toBe('DENY');
    expect(existsSync(options.root)).toBe(false); expect(readFileSync(options.observationsFile)).toEqual(original);
  });
  it.each(['/api/resources', '/api/resources/console', '/api/resources/tasks/a/output'])('rejects unauthenticated %s', async (path) => {
    const handle = await start(); expect((await http(handle, path)).status).toBe(401);
    expect(existsSync(options.root)).toBe(false);
  });
  it('requires independent read proof for a port-scoped session and revokes logout', async () => {
    const handle = await start(); const client = 'c'.repeat(64);
    const session = await http(handle, '/api/session', 'POST', { 'x-ashlr-token': handle.readToken, 'x-ashlr-read-client': client });
    expect(session.status).toBe(204); const cookie = (session.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
    expect((await http(handle, '/api/resources/console', 'GET', { cookie })).status).toBe(401);
    expect((await http(handle, '/api/resources/console', 'GET', { cookie, 'x-ashlr-read-client': 'd'.repeat(64) })).status).toBe(401);
    expect((await http(handle, '/api/resources/console', 'GET', { cookie, 'x-ashlr-read-client': client })).status).toBe(200);
    expect((await http(handle, '/api/session', 'DELETE', { cookie, 'x-ashlr-read-client': client })).status).toBe(204);
    expect((await http(handle, '/api/resources/console', 'GET', { cookie, 'x-ashlr-read-client': client })).status).toBe(401);
  });
  it.each(['/api/resources/tasks', '/api/resources/queue', '/api/resources/tasks/task/cancel'])('read-only refuses mutation %s', async (path) => {
    const handle = await start(); expect((await http(handle, path, 'POST', { 'x-ashlr-token': handle.readToken,
      'content-type': 'application/json' }, '{}')).status).toBe(403); expect(existsSync(options.root)).toBe(false);
  });
  it.each(['/api/events', '/api/config', '/api/fleet', '/api/universe', '/api/resources/tasks/../output', '/next/index.html', '/universe/'])('does not expose unrelated route %s', async (path) => {
    const handle = await start(); expect((await http(handle, path, 'GET', { 'x-ashlr-token': handle.readToken })).status).toBe(404);
  });
  it.each([{ host: 'evil.invalid' }, { origin: 'https://evil.invalid' }, { origin: 'null' }])('rejects host/origin %j', async (headers) => {
    const handle = await start(); expect((await http(handle, '/api/resources/console', 'GET', {
      'x-ashlr-token': handle.readToken, ...headers } as Record<string, string>)).status).toBe(403);
  });
  it.each(['/api/resources?root=/private/elsewhere', '/api/resources?client=secret', '/api/session?token=secret', '/resources/?token=secret'])('rejects query scope or token delivery %s', async (path) => {
    const handle = await start(); expect((await http(handle, path, 'GET', { 'x-ashlr-token': handle.readToken })).status).toBe(400);
  });
  it('reports source degradation while cheap scope stays reachable', async () => {
    const handle = await start(); writeFileSync(options.observationsFile, '{invalid private source', { mode: 0o600 });
    const response = await http(handle, '/api/resources', 'GET', { 'x-ashlr-token': handle.readToken });
    expect(response.status).toBe(200); expect(JSON.parse(response.text).sourceState).toBe('degraded');
    expect(JSON.parse(response.text).counts.total).toBeNull(); expect(response.text).not.toContain('private source');
    expect((await http(handle, '/api/resources/console', 'GET', { 'x-ashlr-token': handle.readToken })).status).toBe(200);
  });
  it.each(['root', 'poolFile', 'bindingsFile', 'observationsFile'] as const)('rejects mutable control input %s inside workspace before writes', async (key) => {
    const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const nested = join(workspace, key);
    if (key !== 'root') writeFileSync(nested, readFileSync(options[key]), { mode: 0o600 });
    await expect(start({ execute: true, workspace, [key]: nested })).rejects.toThrow(/outside the writable workspace/);
    expect(existsSync(options.root)).toBe(false); expect(existsSync(join(workspace, 'root'))).toBe(false);
  });
  it.each([{ execute: true }, { workspace: '/private/work' }, { maxParallel: 1 }, { port: -1 }, { port: 65536 }])('rejects invalid programmatic options before state %j', async (extra) => {
    await expect(start(extra)).rejects.toThrow(); expect(existsSync(options.root)).toBe(false);
  });
  it('pre-aborted startup is inert and close is idempotent', async () => {
    const controller = new AbortController(); controller.abort(); await expect(start({ signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(existsSync(options.root)).toBe(false); const handle = await start(); await handle.close(); await handle.close();
  });
});

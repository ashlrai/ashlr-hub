/** Real loopback protocol coverage; project reads never invoke a worker. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';

let directory: string;
const handles: ResourceConsoleServerHandle[] = [];
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-files-http-'))); });
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  rmSync(directory, { recursive: true, force: true });
});
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const route = (operation: 'list' | 'read', project = 'default') => `/api/resources/projects/${project}/files/${operation}`;
function http(handle: ResourceConsoleServerHandle, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown; raw?: string;
} = {}): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: options.method ?? 'GET', agent: false,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(new Error('Fixture response exceeds limit')); else chunks.push(chunk);
      });
      response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode!,
        text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    req.on('error', reject); req.setTimeout(10_000, () => req.destroy(new Error('Fixture request timed out'))); req.end(body);
  });
}
const control = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.controlToken!, origin: handle.url });
const inspect = (handle: ResourceConsoleServerHandle, operation: 'list' | 'read', path: string, project = 'default') =>
  http(handle, route(operation, project), { method: 'POST', headers: control(handle), body: { path } });
async function fixture() {
  const workspace = join(directory, 'workspace'); const extra = join(directory, 'extra');
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(extra, { mode: 0o700 });
  writeFileSync(join(workspace, 'hello.txt'), 'PRIVATE_FILE_TEXT 世界\n', { mode: 0o600 });
  mkdirSync(join(workspace, 'src'), { mode: 0o700 });
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const value = 1;\n', { mode: 0o600 });
  writeFileSync(join(extra, 'hello.txt'), 'PRIVATE_OTHER_PROJECT\n', { mode: 0o600 });
  const options: ResourceConsoleServerOptions = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json'),
    projectsFile: join(directory, 'projects.json'), execute: true, workspace };
  save(options.poolFile, { schemaVersion: 1, id: 'files-http', workers: [{ id: 'local', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1 }] });
  save(options.bindingsFile, [{ workerId: 'local', capacityKey: 'one-account', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
  save(options.observationsFile, [{ workerId: 'local', observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), health: 'ready', windows: [], retryAfter: null }]);
  save(options.projectsFile!, { schemaVersion: 1, projects: [{ id: 'extra', label: 'Extra', workspace: extra }] });
  const start = async (patch: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
  };
  return { options, workspace, extra, start };
}

describe('control-unlocked project file HTTP boundary', () => {
  it('advertises only catalog-backed execution and never grants read-only or legacy file authority', async () => {
    const f = await fixture(); const readonly = await f.start({ execute: false, workspace: undefined, projectsFile: undefined });
    expect(readonly.scope.workspaceFilesSupported).toBeUndefined();
    expect((await http(readonly, route('list'), { method: 'POST', headers: { 'x-ashlr-token': readonly.readToken, origin: readonly.url }, body: { path: '' } })).status).toBe(403);
    expect(existsSync(f.options.root)).toBe(false); await readonly.close();
    const legacy = await f.start({ projectsFile: undefined }); expect(legacy.scope.workspaceFilesSupported).toBeUndefined();
    expect((await inspect(legacy, 'list', '')).status).toBe(403); await legacy.close();
    const enabled = await f.start(); expect(enabled.scope.workspaceFilesSupported).toBe(true);
    const scope = await http(enabled, '/api/resources/console', { headers: { 'x-ashlr-token': enabled.readToken } });
    expect(JSON.parse(scope.text).workspaceFilesSupported).toBe(true);
    await enabled.close(); const persisted = await f.start({ projectsFile: undefined });
    expect(persisted.scope.workspaceFilesSupported).toBe(true);
    expect((await inspect(persisted, 'read', 'hello.txt')).status).toBe(200);
    expect((await inspect(persisted, 'read', 'hello.txt', 'extra')).status).toBe(503);
  });

  it('requires control token and explicit exact Origin, rejecting read headers and authenticated read cookies', async () => {
    const f = await fixture(); const handle = await f.start(); const client = 'c'.repeat(64);
    const session = await http(handle, '/api/session', { method: 'POST', headers: { 'x-ashlr-token': handle.readToken, 'x-ashlr-read-client': client } });
    expect(session.status).toBe(204); const cookie = session.headers['set-cookie']![0]!.split(';')[0]!;
    for (const headers of [{ origin: handle.url }, { 'x-ashlr-token': handle.readToken, origin: handle.url },
      { cookie, 'x-ashlr-read-client': client, origin: handle.url }]) {
      expect((await http(handle, route('read'), { method: 'POST', headers, body: { path: 'hello.txt' } })).status).toBe(401);
    }
    for (const headers of [{ 'x-ashlr-token': handle.controlToken! }, { ...control(handle), origin: 'null' },
      { ...control(handle), origin: 'https://example.invalid' }, { ...control(handle), host: 'example.invalid' }]) {
      expect((await http(handle, route('read'), { method: 'POST', headers, body: { path: 'hello.txt' } })).status).toBe(403);
    }
    expect((await inspect(handle, 'read', 'hello.txt')).status).toBe(200);
  });

  it.each([null, [], {}, { path: null }, { path: 1 }, { path: '' , workspace: '/tmp' },
    { path: '', projectId: 'extra' }, { path: '', recursive: true }, { path: '', limit: 9999 }])('rejects nonexact body %j', async (body) => {
    const f = await fixture(); const handle = await f.start();
    const result = await http(handle, route('list'), { method: 'POST', headers: control(handle), body });
    expect(result.status).toBe(400); expect(result.text).not.toContain(directory); expect(result.text).not.toContain('PRIVATE_');
  });

  it('rejects queries, other methods, unregistered route forms, content types and malformed JSON', async () => {
    const f = await fixture(); const handle = await f.start();
    expect((await http(handle, `${route('read')}?path=hello.txt`, { method: 'POST', headers: control(handle), body: { path: 'hello.txt' } })).status).toBe(400);
    expect((await http(handle, route('read'), { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(404);
    expect((await http(handle, route('read'), { method: 'PUT', headers: { 'x-ashlr-token': handle.readToken }, body: { path: 'hello.txt' } })).status).toBe(405);
    for (const path of [route('read', 'Uppercase'), route('read', 'x'.repeat(65)), `${route('read')}/extra`, '/api/resources/files/read']) {
      expect((await http(handle, path, { method: 'POST', headers: control(handle), body: { path: 'hello.txt' } })).status).toBe(404);
    }
    expect((await http(handle, route('read'), { method: 'POST', headers: { ...control(handle), 'content-type': 'text/plain' }, body: { path: 'hello.txt' } })).status).toBe(415);
    expect((await http(handle, route('read'), { method: 'POST', headers: control(handle), raw: '{' })).status).toBe(400);
    expect((await http(handle, route('read'), { method: 'POST', headers: control(handle), body: { path: 'x'.repeat(128 * 1024) } })).status).toBe(413);
  });

  it.each(['/tmp/file.txt', '../file.txt', 'src/../hello.txt', 'src//index.ts', 'src\\index.ts', 'hello.txt\0'])('rejects unsafe relative path %j without private diagnostics', async (path) => {
    const f = await fixture(); const handle = await f.start(); const result = await inspect(handle, 'read', path);
    expect(result.status).toBe(400); expect(result.text).not.toContain(directory); expect(result.text).not.toContain(path);
  });

  it('lists one directory and returns exact bounded UTF-8 preview bytes without accounting or transcript mutation', async () => {
    const f = await fixture(); const handle = await f.start(); const statePath = join(f.options.root, 'resource-console-state.json');
    const before = readFileSync(statePath); const text = 'PRIVATE_FILE_TEXT 世界\n';
    const listing = await inspect(handle, 'list', ''); expect(listing.status).toBe(200);
    expect(listing.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(listing.text)).toEqual({ projectId: 'default', path: '', entries: [
      { name: 'src', path: 'src', kind: 'directory', sizeBytes: null },
      { name: 'hello.txt', path: 'hello.txt', kind: 'file', sizeBytes: Buffer.byteLength(text) },
    ] });
    const preview = await inspect(handle, 'read', 'hello.txt'); expect(preview.status).toBe(200);
    expect(preview.headers['cache-control']).toBe('no-store'); expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(preview.text)).toEqual({ projectId: 'default', path: 'hello.txt', text,
      sizeBytes: Buffer.byteLength(text), byteLength: Buffer.byteLength(text), truncated: false,
      digest: createHash('sha256').update(text).digest('hex') });
    expect(JSON.parse((await inspect(handle, 'list', 'src')).text).entries).toEqual([
      { name: 'index.ts', path: 'src/index.ts', kind: 'file', sizeBytes: Buffer.byteLength('export const value = 1;\n') },
    ]);
    expect(JSON.parse((await inspect(handle, 'read', 'hello.txt', 'extra')).text).text).toBe('PRIVATE_OTHER_PROJECT\n');
    const snapshot = await http(handle, '/api/resources', { headers: { 'x-ashlr-token': handle.readToken } });
    expect(snapshot.text).not.toContain('PRIVATE_'); expect(JSON.parse(snapshot.text).supervisor.jobs).toEqual([]);
    expect(readFileSync(statePath)).toEqual(before); expect(existsSync(join(f.options.root, 'pool-state.json'))).toBe(false);
  });

  it('maps unavailable files and directory listing limits to bounded status responses', async () => {
    const f = await fixture(); const handle = await f.start();
    expect((await inspect(handle, 'read', 'missing.txt')).status).toBe(404);
    expect((await inspect(handle, 'read', 'hello.txt', 'unknown')).status).toBe(404);
    mkdirSync(join(f.workspace, 'large'), { mode: 0o700 });
    for (let index = 0; index < 257; index++) writeFileSync(join(f.workspace, 'large', `file-${index}.txt`), '', { mode: 0o600 });
    const overflow = await inspect(handle, 'list', 'large'); expect(overflow.status).toBe(413);
    expect(overflow.text).not.toContain('file-'); expect(overflow.text).not.toContain(directory);
  });

  it('marks a large preview and hashes only the exact UTF-8 bytes returned at the boundary', async () => {
    const f = await fixture(); const handle = await f.start(); const prefix = 'a'.repeat(64 * 1024 - 1);
    const text = `${prefix}😺tail`; writeFileSync(join(f.workspace, 'large.txt'), text, { mode: 0o600 });
    const result = await inspect(handle, 'read', 'large.txt'); expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ projectId: 'default', path: 'large.txt', text: prefix,
      sizeBytes: Buffer.byteLength(text), byteLength: Buffer.byteLength(prefix), truncated: true,
      digest: createHash('sha256').update(prefix).digest('hex') });
    expect(result.headers['cache-control']).toBe('no-store');
  });
});

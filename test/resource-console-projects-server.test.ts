/** Project selection uses one real HTTP console and ledger, with inert loopback completions. */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleSnapshot, ResourceConsoleTaskInput, ResourceConsoleTranscript } from '../src/core/resources/console-types.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';

let directory: string;
const handles: ResourceConsoleServerHandle[] = [];
const endpoints: Array<ReturnType<typeof createServer>> = [];
const children: ChildProcess[] = [];
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-project-http-'))); });
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
  for (const handle of handles.splice(0)) await handle.close();
  for (const endpoint of endpoints.splice(0)) {
    endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
  rmSync(directory, { recursive: true, force: true });
});
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const readHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.readToken });
const controlHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.controlToken!, origin: handle.url });
function http(handle: Pick<ResourceConsoleServerHandle, 'port'>, path: string, options: {
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
  const workspace = join(directory, 'default'); const extra = join(directory, 'tools');
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(extra, { mode: 0o700 });
  const held: ServerResponse[] = []; const requests: unknown[] = [];
  const endpoint = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); held.push(res); });
  });
  endpoints.push(endpoint); await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const options: ResourceConsoleServerOptions = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json'),
    projectsFile: join(directory, 'projects.json'), execute: true, workspace };
  save(options.poolFile, { schemaVersion: 1, id: 'project-http', workers: ['local-a', 'local-b'].map((id) => ({ id,
    provider: 'local', model: 'inert-project-fixture', maxConcurrent: 1, reservePercent: 0,
    maxTasksPerWindow: maxTasks, taskWindowMs: 3_600_000, priority: 1 })) });
  save(options.bindingsFile, ['local-a', 'local-b'].map((workerId) => ({ workerId, capacityKey: 'shared-fixture',
    kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })));
  save(options.observationsFile, ['local-a', 'local-b'].map((workerId) => ({ workerId,
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    health: 'ready', windows: [], retryAfter: null })));
  const catalog = (projects: unknown = [{ id: 'tools', label: 'Tools', workspace: extra }]) =>
    save(options.projectsFile!, { schemaVersion: 1, projects });
  catalog();
  const start = async (patch: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
  };
  const task = (id = 'task', patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_PROJECT ${id}`, allowedWorkerIds: ['local-a'], mode: 'read-only', timeoutMs: 20_000,
    maxOutputTokens: 100, retainHistory: true, ...patch });
  const finish = (index: number) => held[index]!.end(JSON.stringify({ choices: [{ message: { content: `PRIVATE_OUTPUT ${index}` } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  return { options, extra, held, requests, catalog, start, task, finish };
}
const submit = (handle: ResourceConsoleServerHandle, task: unknown) => http(handle, '/api/resources/tasks', {
  method: 'POST', headers: controlHeaders(handle), body: task });
const pause = (handle: ResourceConsoleServerHandle, paused: boolean) => http(handle, '/api/resources/queue', {
  method: 'POST', headers: controlHeaders(handle), body: { paused } });
async function snapshot(handle: ResourceConsoleServerHandle): Promise<ResourceConsoleSnapshot> {
  const result = await http(handle, '/api/resources', { headers: readHeaders(handle) });
  expect(result.status).toBe(200); expect(result.text).not.toContain('PRIVATE_'); return JSON.parse(result.text);
}
async function history(handle: ResourceConsoleServerHandle, id: string): Promise<ResourceConsoleTranscript> {
  const result = await http(handle, `/api/resources/tasks/${id}/history`, { headers: readHeaders(handle) });
  expect(result.status).toBe(200); expect(result.noStore).toBe(true); return JSON.parse(result.text);
}
async function settled(handle: ResourceConsoleServerHandle, id: string) {
  await vi.waitFor(async () => expect((await snapshot(handle)).supervisor?.jobs.find((job) => job.id === id)?.state).toBe('settled'),
    { timeout: 10_000, interval: 50 });
}

describe('trusted startup project catalog', () => {
  it.each(['permissions', 'symlink', 'oversized', 'schema', 'unknown-field', 'invalid-utf8'])('rejects %s catalog before initializing a ledger', async (kind) => {
    const f = await fixture();
    if (kind === 'permissions') chmodSync(f.options.projectsFile!, 0o644);
    if (kind === 'symlink') { const target = join(directory, 'target.json'); save(target, { schemaVersion: 1, projects: [] });
      rmSync(f.options.projectsFile!); symlinkSync(target, f.options.projectsFile!); }
    if (kind === 'oversized') writeFileSync(f.options.projectsFile!, ' '.repeat(256 * 1024 + 1));
    if (kind === 'schema') save(f.options.projectsFile!, { schemaVersion: 2, projects: [] });
    if (kind === 'unknown-field') save(f.options.projectsFile!, { schemaVersion: 1, projects: [], discover: true });
    if (kind === 'invalid-utf8') writeFileSync(f.options.projectsFile!, Buffer.from([0xff]));
    await expect(f.start()).rejects.toThrow(); expect(existsSync(f.options.root)).toBe(false); expect(f.requests).toEqual([]);
  });

  it.each(['default', 'duplicate-id', 'duplicate-path', 'default-path', 'too-many', 'relative', 'extra-key'])('rejects %s project entries without effects', async (kind) => {
    const f = await fixture(); const entry = { id: 'tools', label: 'Tools', workspace: f.extra };
    if (kind === 'default') f.catalog([{ ...entry, id: 'default' }]);
    if (kind === 'duplicate-id') f.catalog([entry, { ...entry, workspace: join(directory, 'other') }]);
    if (kind === 'duplicate-path') f.catalog([entry, { ...entry, id: 'other' }]);
    if (kind === 'default-path') f.catalog([{ ...entry, workspace: f.options.workspace }]);
    if (kind === 'too-many') f.catalog(Array.from({ length: 32 }, (_, i) => ({ ...entry, id: `p${i}`, workspace: join(directory, `p${i}`) })));
    if (kind === 'relative') f.catalog([{ ...entry, workspace: 'relative' }]);
    if (kind === 'extra-key') f.catalog([{ ...entry, allowWrite: true }]);
    await expect(f.start()).rejects.toThrow(); expect(existsSync(f.options.root)).toBe(false);
  });

  it.each(['root-inside', 'inside-root', 'pool', 'bindings', 'observations', 'catalog', 'quota', 'connections'])('rejects project/control overlap: %s', async (kind) => {
    const f = await fixture(); const patch: Partial<ResourceConsoleServerOptions> = {};
    if (kind === 'root-inside') patch.root = join(f.extra, 'ledger');
    if (kind === 'inside-root') f.catalog([{ id: 'tools', label: 'Tools', workspace: join(f.options.root, 'project') }]);
    if (kind === 'pool') patch.poolFile = join(f.extra, 'pool.json');
    if (kind === 'bindings') patch.bindingsFile = join(f.extra, 'bindings.json');
    if (kind === 'observations') patch.observationsFile = join(f.extra, 'observations.json');
    if (kind === 'catalog') { patch.projectsFile = join(f.extra, 'projects.json'); save(patch.projectsFile, JSON.parse(readFileSync(f.options.projectsFile!, 'utf8'))); }
    if (kind === 'quota') patch.quotaConfigFile = join(f.extra, 'quota.json');
    if (kind === 'connections') patch.connectionsConfigFile = join(f.extra, 'connections.json');
    await expect(f.start(patch)).rejects.toThrow('Resource control files');
    expect(existsSync(patch.root ?? f.options.root)).toBe(false); expect(f.requests).toEqual([]);
  });

  it('keeps read-only and legacy startup unchanged, and accepts an explicit empty catalog', async () => {
    const f = await fixture();
    await expect(f.start({ execute: false, workspace: undefined })).rejects.toThrow(); expect(existsSync(f.options.root)).toBe(false);
    const reader = await f.start({ execute: false, workspace: undefined, projectsFile: undefined });
    expect(reader.scope.projects).toBeUndefined(); expect(reader.scope.defaultProjectId).toBeUndefined(); await reader.close();
    const legacy = await f.start({ projectsFile: undefined }); expect(legacy.scope.projects).toBeUndefined(); await legacy.close();
    f.catalog([]); const explicit = await f.start(); expect(explicit.scope.projects).toEqual([
      { id: 'default', label: 'Default workspace', workspace: f.options.workspace, enabled: true },
    ]); expect(explicit.scope.defaultProjectId).toBe('default');
  });

  it('preserves a legacy workspace below the store but refuses catalog adoption for that scope', async () => {
    const f = await fixture(); mkdirSync(f.options.root, { mode: 0o700 });
    const workspace = join(f.options.root, 'legacy-workspace'); mkdirSync(workspace, { mode: 0o700 });
    const legacy = await f.start({ workspace, projectsFile: undefined });
    expect(legacy.scope.workspace).toBe(workspace); expect(legacy.scope.projects).toBeUndefined(); await legacy.close();
    const restarted = await f.start({ workspace, projectsFile: undefined }); await restarted.close();
    const stateFile = join(f.options.root, 'resource-console-state.json'); const before = readFileSync(stateFile);
    f.catalog([]); await expect(f.start({ workspace })).rejects.toThrow('Resource control files');
    expect(readFileSync(stateFile)).toEqual(before);
    await expect(f.start({ workspace, projectsFile: undefined, poolFile: join(workspace, 'pool.json') }))
      .rejects.toThrow('Resource control files');
    expect(f.requests).toEqual([]);
  });

  it('permits explicitly registered nested projects and freezes catalog input until restart', async () => {
    const f = await fixture(); const nested = join(f.options.workspace!, 'nested'); mkdirSync(nested, { mode: 0o700 });
    f.catalog([{ id: 'nested', label: 'Nested', workspace: nested }]); const handle = await f.start();
    f.catalog(); const response = await http(handle, '/api/resources/console', { headers: readHeaders(handle) });
    expect(response.status).toBe(200); expect(response.noStore).toBe(true);
    expect(JSON.parse(response.text).projects.map((project: { id: string }) => project.id)).toEqual(['default', 'nested']);
    await pause(handle, true); expect((await submit(handle, f.task('nested-task', { projectId: 'nested' }))).status).toBe(202);
    expect((await submit(handle, f.task('unconfigured', { projectId: 'tools' }))).status).toBe(400);
  });

  it('holds a missing pinned directory without blocking healthy projects, and rejects rebinding its ID', async () => {
    const f = await fixture(); const first = await f.start(); await first.close(); rmSync(f.extra, { recursive: true });
    const restarted = await f.start();
    expect(restarted.scope.projects?.find((project) => project.id === 'tools')?.enabled).toBe(true);
    expect((await submit(restarted, f.task('missing-project', { projectId: 'tools' }))).status).toBe(503);
    expect((await submit(restarted, f.task('healthy-default'))).status).toBe(202);
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); f.finish(0); await settled(restarted, 'healthy-default');
    await restarted.close();
    const replacement = join(directory, 'replacement'); mkdirSync(replacement, { mode: 0o700 });
    f.catalog([{ id: 'tools', label: 'Tools', workspace: replacement }]);
    await expect(f.start()).rejects.toThrow('binding cannot be changed'); expect(f.requests).toHaveLength(1);
  });
});

describe('project ID HTTP admission over a shared ledger', () => {
  it.each([null, [], {}, 1, '', '/tmp', '../tools', 'Tools', 'x'.repeat(65)])('rejects invalid project ID %j without queueing', async (projectId) => {
    const f = await fixture(); const handle = await f.start();
    expect((await submit(handle, { ...f.task(), projectId })).status).toBe(400);
    expect((await snapshot(handle)).supervisor?.jobs).toEqual([]); expect(f.requests).toEqual([]);
  });

  it('requires control authority and accepts only the ID field, with explicit default equivalent to omission', async () => {
    const f = await fixture(); const handle = await f.start(); await pause(handle, true);
    const task = f.task('default-task');
    for (const headers of [{}, readHeaders(handle)]) expect((await http(handle, '/api/resources/tasks', {
      method: 'POST', headers, body: { ...task, projectId: 'tools' } })).status).toBe(401);
    expect((await submit(handle, { ...task, cwd: f.extra })).status).toBe(400);
    expect((await http(handle, '/api/resources/tasks?projectId=tools', { method: 'POST', headers: controlHeaders(handle), body: task })).status).toBe(400);
    expect((await submit(handle, task)).status).toBe(202);
    const retry = await submit(handle, { ...task, projectId: 'default' }); expect(retry.status).toBe(202);
    expect(JSON.parse(retry.text).job.projectId).toBeUndefined();
    expect((await submit(handle, { ...task, projectId: 'tools' })).status).toBe(409);
  });

  it('preserves shared account concurrency and rejects cross-project continuation while retaining project history', async () => {
    const f = await fixture(); const handle = await f.start();
    expect((await submit(handle, f.task('default-task'))).status).toBe(202);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect((await submit(handle, f.task('tools-task', { projectId: 'tools', allowedWorkerIds: ['local-b'] }))).status).toBe(202);
    await vi.waitFor(async () => expect((await snapshot(handle)).supervisor?.jobs.find((job) => job.id === 'tools-task')?.state).toBe('queued'));
    expect(f.requests).toHaveLength(1); f.finish(0); await settled(handle, 'default-task');
    await vi.waitFor(() => expect(f.held).toHaveLength(2), { timeout: 10_000, interval: 50 });
    f.finish(1); await settled(handle, 'tools-task');
    const transcript = await history(handle, 'tools-task'); expect(transcript.projectId).toBe('tools');
    const parent = { taskId: transcript.id, expectedTranscriptDigest: transcript.transcriptDigest! };
    expect((await submit(handle, f.task('cross-project', { parent }))).status).toBe(409);
    await pause(handle, true);
    expect((await submit(handle, f.task('same-project', { parent, projectId: 'tools' }))).status).toBe(202);
    const ledger = JSON.parse(readFileSync(join(f.options.root, 'pool-state.json'), 'utf8'));
    expect(ledger.attempts.map((row: { capacityKey: string }) => row.capacityKey)).toEqual(['shared-fixture', 'shared-fixture']);
    await handle.close(); f.catalog([]); const restarted = await f.start();
    expect(restarted.scope.projects?.find((project) => project.id === 'tools')).toMatchObject({ workspace: f.extra, enabled: false });
    expect((await history(restarted, 'tools-task')).projectId).toBe('tools');
    expect((await submit(restarted, f.task('disabled-project', { projectId: 'tools' }))).status).toBe(503);
    expect(f.requests).toHaveLength(2);
  });

  it('does not grant a different project a fresh shared account task allowance', async () => {
    const f = await fixture(1); const handle = await f.start(); await submit(handle, f.task('default-task'));
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); f.finish(0); await settled(handle, 'default-task');
    expect((await submit(handle, f.task('tools-task', { projectId: 'tools', allowedWorkerIds: ['local-b'] }))).status).toBe(202);
    await vi.waitFor(async () => {
      const state = await snapshot(handle);
      expect(state.supervisor?.jobs.find((job) => job.id === 'tools-task')?.state).toBe('queued');
      expect(state.plan?.exclusions.every((row) => row.reasons.includes('operator-task-cap-reached'))).toBe(true);
    });
    expect(f.requests).toHaveLength(1);
  });

  it('starts the actual source CLI with a private catalog and closes its one supervisor cleanly', async () => {
    const f = await fixture(); const cli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
    const home = join(directory, 'home'); mkdirSync(home, { mode: 0o700 });
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'resources', 'pool', 'console', '--root', f.options.root,
      '--pool', f.options.poolFile, '--bindings', f.options.bindingsFile, '--observations', f.options.observationsFile,
      '--execute', '--workspace', f.options.workspace!, '--projects', f.options.projectsFile!, '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    }); children.push(child);
    let output = ''; let errors = ''; child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
    await vi.waitFor(() => { expect(child.exitCode, errors).toBeNull(); expect(output).toContain('\n'); }, { timeout: 15_000 });
    const record = JSON.parse(output.trim()); expect(record.projects.map((project: { id: string }) => project.id)).toEqual(['default', 'tools']);
    const scope = await http(record, '/api/resources/console', { headers: { 'x-ashlr-token': record.readToken } });
    expect(scope.status).toBe(200); expect(JSON.parse(scope.text).projects).toEqual(record.projects); expect(f.requests).toEqual([]);
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); expect(await exited).toBe(0);
    expect(existsSync(join(f.options.root, '.resource-console.lock'))).toBe(false);
  });
});

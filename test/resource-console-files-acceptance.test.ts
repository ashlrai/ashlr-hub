/** Independent file-view acceptance: temporary projects and inert loopback workers only. */
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import { composeWorkspaceTaskPrompt, parseWorkspaceTextAttachment } from '../src/web-ui/routes/workspace/workspace-attachments.js';
import { digest } from '../src/core/universe/artifacts.js';
import type { ResourceConsoleFileListing as Listing, ResourceConsoleFilePreview as Preview } from '../src/core/resources/console-files-types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function http(handle: ResourceConsoleServerHandle, path: string, body?: unknown, headers?: Record<string, string>) {
  return new Promise<{ status: number; text: string; noStore: boolean }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: bytes === undefined ? 'GET' : 'POST', agent: false,
      headers: { ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bytes)) }),
        ...(headers ?? { 'x-ashlr-token': handle.controlToken!, origin: handle.url }) } }, (res) => {
      const chunks: Buffer[] = []; let total = 0;
      res.on('data', (chunk: Buffer) => { total += chunk.length;
        if (total > 1024 * 1024) req.destroy(new Error('Fixture response exceeds bound')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'),
        noStore: res.headers['cache-control'] === 'no-store' }));
    });
    req.on('error', reject); req.setTimeout(10_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end(bytes);
  });
}
const files = (handle: ResourceConsoleServerHandle, project: string, action: 'list' | 'read', path: string) =>
  http(handle, `/api/resources/projects/${project}/files/${action}`, { path });

async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-files-acceptance-')));
  const workspace = join(base, 'default'); const second = join(base, 'second');
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(second, { mode: 0o700 });
  const requests: unknown[] = [];
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify({ choices: [{ message: { content: 'FIXTURE_COMPLETED' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 } })); });
  });
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const options: ResourceConsoleServerOptions = { root: join(base, 'ledger'), workspace, execute: true,
    poolFile: join(base, 'pool.json'), bindingsFile: join(base, 'bindings.json'), observationsFile: join(base, 'observations.json'),
    projectsFile: join(base, 'projects.json') };
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save(options.poolFile, { schemaVersion: 1, id: 'file-acceptance', workers: [{ id: 'worker', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] });
  save(options.bindingsFile, [{ workerId: 'worker', capacityKey: 'fixture', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }]);
  const now = Date.now(); save(options.observationsFile, [{ workerId: 'worker', observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', windows: [], retryAfter: null }]);
  const catalog = (enabled = true) => save(options.projectsFile!, { schemaVersion: 1,
    projects: enabled ? [{ id: 'second', label: 'Second', workspace: second }] : [] });
  catalog();
  const handles: ResourceConsoleServerHandle[] = [];
  cleanups.push(async () => { for (const handle of handles) await handle.close();
    worker.closeAllConnections(); await new Promise<void>((resolve) => worker.close(() => resolve()));
    rmSync(base, { recursive: true, force: true }); });
  const start = async (patch: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
  };
  const state = () => readFileSync(join(options.root, 'resource-console-state.json'), 'utf8');
  const ledger = () => { const path = join(options.root, 'pool-state.json'); return existsSync(path) ? readFileSync(path, 'utf8') : null; };
  return { base, workspace, second, options, requests, catalog, start, state, ledger };
}

describe.skipIf(process.platform === 'win32')('independent scoped file HTTP acceptance', () => {
  it('does not grant legacy scopes file access or alter their schema and accounting', async () => {
    const f = await fixture(); writeFileSync(join(f.workspace, 'source.ts'), 'PRIVATE_LEGACY_SOURCE');
    const legacy = await f.start({ projectsFile: undefined }); const before = f.state(); const ledger = f.ledger();
    for (const action of ['list', 'read'] as const) {
      const response = await files(legacy, 'default', action, action === 'list' ? '' : 'source.ts');
      expect(response.status).toBeGreaterThanOrEqual(400); expect(response.text).not.toContain('PRIVATE_LEGACY_SOURCE');
    }
    expect(f.state()).toBe(before); expect(f.ledger()).toBe(ledger); expect(f.requests).toEqual([]);
    await legacy.close(); const registered = await f.start();
    expect((await files(registered, 'default', 'read', 'source.ts')).status).toBe(200);
  });

  it('refuses disabled and replaced project roots while healthy project reads remain available', async () => {
    const f = await fixture(); writeFileSync(join(f.workspace, 'ok.ts'), 'HEALTHY_SOURCE');
    writeFileSync(join(f.second, 'other.ts'), 'ORIGINAL_SOURCE');
    const first = await f.start(); await first.close(); f.catalog(false);
    const disabled = await f.start();
    expect((await files(disabled, 'second', 'read', 'other.ts')).status).toBe(503);
    expect((await files(disabled, 'default', 'read', 'ok.ts')).status).toBe(200); await disabled.close();
    f.catalog(); const live = await f.start(); const old = join(f.base, 'original-second'); renameSync(f.second, old);
    mkdirSync(f.second, { mode: 0o700 }); writeFileSync(join(f.second, 'other.ts'), 'REPLACEMENT_MUST_NOT_BE_READ');
    const response = await files(live, 'second', 'read', 'other.ts');
    expect(response.status).toBe(503); expect(response.text).not.toContain('REPLACEMENT_MUST_NOT_BE_READ');
    expect((await files(live, 'default', 'read', 'ok.ts')).status).toBe(200);
    rmSync(f.second, { recursive: true }); renameSync(old, f.second);
    expect(JSON.parse((await files(live, 'second', 'read', 'other.ts')).text)).toMatchObject({ text: 'ORIGINAL_SOURCE' });
    expect(f.requests).toEqual([]); expect(JSON.parse(f.state()).jobs).toEqual([]);
  });

  it('lists only supported entries and refuses aliases, hidden components and special files without leaking content', async () => {
    const f = await fixture(); const privateFile = join(f.base, 'private.txt');
    writeFileSync(privateFile, 'PRIVATE_OUTSIDE_CONTENT');
    writeFileSync(join(f.workspace, 'safe.ts'), 'SAFE_VISIBLE');
    symlinkSync(privateFile, join(f.workspace, 'link.txt')); linkSync(privateFile, join(f.workspace, 'hard.txt'));
    mkdirSync(join(f.workspace, '.private')); writeFileSync(join(f.workspace, '.private', 'hidden.txt'), 'PRIVATE_HIDDEN_CONTENT');
    mkdirSync(join(f.workspace, 'sub')); symlinkSync(f.second, join(f.workspace, 'linked-directory'));
    expect(spawnSync('mkfifo', [join(f.workspace, 'pipe.txt')]).status).toBe(0);
    const handle = await f.start(); const state = f.state(); const ledger = f.ledger();
    const listingResponse = await files(handle, 'default', 'list', ''); expect(listingResponse.status).toBe(200);
    const listing = JSON.parse(listingResponse.text) as Listing;
    expect(listing.entries.map(({ name }) => name).sort()).toEqual(['safe.ts', 'sub']);
    for (const path of ['link.txt', 'hard.txt', 'pipe.txt', '.private/hidden.txt', 'linked-directory/other.ts']) {
      const response = await files(handle, 'default', 'read', path);
      expect(response.status).toBeGreaterThanOrEqual(400); expect(response.noStore).toBe(true);
      expect(response.text).not.toContain('PRIVATE_'); expect(response.text).not.toContain(f.base);
    }
    expect(f.state()).toBe(state); expect(f.ledger()).toBe(ledger); expect(f.requests).toEqual([]);
  });

  it('keeps malformed text unavailable and large previews truthful, bounded and unattached', async () => {
    const f = await fixture(); writeFileSync(join(f.workspace, 'invalid.ts'), Buffer.from([0xff, 0xfe, 0x61]));
    writeFileSync(join(f.workspace, 'nul.ts'), Buffer.from([0x61, 0x00, 0x62]));
    const large = 'a' + '😀'.repeat(20_000); writeFileSync(join(f.workspace, 'large.ts'), large);
    const handle = await f.start();
    for (const path of ['invalid.ts', 'nul.ts']) expect((await files(handle, 'default', 'read', path)).status).toBeGreaterThanOrEqual(400);
    const response = await files(handle, 'default', 'read', 'large.ts'); expect(response.status).toBe(200);
    const preview = JSON.parse(response.text) as Preview;
    expect(preview).toMatchObject({ projectId: 'default', path: 'large.ts', sizeBytes: Buffer.byteLength(large), truncated: true });
    expect(preview.byteLength).toBeLessThanOrEqual(64 * 1024); expect(preview.byteLength).toBe(Buffer.byteLength(preview.text));
    expect(large.startsWith(preview.text)).toBe(true); expect(preview.text).not.toContain('�');
    expect(preview.digest).toBe(digest(Buffer.from(preview.text)));
    expect(() => parseWorkspaceTextAttachment('large.ts', Buffer.from(preview.text))).toThrow(); expect(f.requests).toEqual([]);
  });

  it('sends only explicitly copied preview bytes, not later file changes or other browsed files', async () => {
    const f = await fixture(); const original = 'const reference = "EXPLICIT_OLD_SNAPSHOT";';
    writeFileSync(join(f.workspace, 'chosen.ts'), original); writeFileSync(join(f.workspace, 'other.ts'), 'UNATTACHED_PRIVATE_CONTENT');
    const handle = await f.start(); const before = f.state();
    expect((await files(handle, 'default', 'list', '')).status).toBe(200);
    expect((await files(handle, 'default', 'read', 'other.ts')).status).toBe(200);
    const preview = JSON.parse((await files(handle, 'default', 'read', 'chosen.ts')).text) as Preview;
    expect(preview).toMatchObject({ text: original, truncated: false, digest: digest(Buffer.from(original)) });
    const attachment = { ...parseWorkspaceTextAttachment('chosen.ts', Buffer.from(preview.text)),
      source: { projectId: preview.projectId, path: preview.path, digest: preview.digest } };
    writeFileSync(join(f.workspace, 'chosen.ts'), 'LATER_DISK_CONTENT');
    const prompt = composeWorkspaceTaskPrompt('Explain the explicitly attached snapshot.', [attachment]);
    expect(prompt).toContain(original.replaceAll('"', '\\"')); expect(prompt).not.toContain('UNATTACHED_PRIVATE_CONTENT');
    expect(prompt).not.toContain('LATER_DISK_CONTENT'); expect(f.state()).toBe(before); expect(f.requests).toEqual([]);
    expect(prompt).toContain(preview.digest);
    const snapshot = await http(handle, '/api/resources', undefined, { 'x-ashlr-token': handle.readToken });
    expect(snapshot.status).toBe(200); expect(snapshot.text).not.toContain('UNATTACHED_PRIVATE_CONTENT');
    expect(snapshot.text).not.toContain('EXPLICIT_OLD_SNAPSHOT'); expect(snapshot.text).not.toContain('chosen.ts');
    const response = await http(handle, '/api/resources/tasks', { id: 'explicit-file-task', prompt,
      allowedWorkerIds: ['worker'], mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 100 });
    expect(response.status).toBe(202); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const sent = JSON.stringify(f.requests[0]); expect(sent).toContain('EXPLICIT_OLD_SNAPSHOT');
    expect(sent).not.toContain('LATER_DISK_CONTENT'); expect(sent).not.toContain('UNATTACHED_PRIVATE_CONTENT');
    await vi.waitFor(() => expect(JSON.parse(f.state()).jobs[0]?.state).toBe('settled'));
    expect(JSON.parse(f.ledger()!).attempts).toHaveLength(1);
  });
});

/** Actual loopback execution; exact root-rename fault, not a simulated settlement or durable deletion. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const fault = vi.hoisted(() => ({ target: null as string | null, hits: 0 }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync(from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) {
    if (to === fault.target && typeof from === 'string' && /^\.resource-console-[a-f0-9-]+\.tmp$/.test(basename(from))) {
      fault.target = null; fault.hits++;
      throw Object.assign(new Error('Fixture root publication refused'), { code: 'EIO' });
    }
    return actual.renameSync(from, to);
  } };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  fault.target = null;
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
  fault.hits = 0;
  if (failures.length) throw new AggregateError(failures, 'Deletion-failure fixture cleanup was not confirmed');
});

async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-delete-failure-')));
  const root = join(base, 'pool'); const workspace = join(base, 'workspace');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  const archiveRoot = join(root, 'resource-console-history'); mkdirSync(archiveRoot, { mode: 0o700 });
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ choices: [{ message: { content: `private-loopback-result-${requests.length}` } }],
        usage: { prompt_tokens: 8, completion_tokens: 4 } }));
    });
  });
  const owners = new Set<ResourcePoolSupervisor>();
  cleanups.push(async () => {
    const results = await Promise.allSettled([...owners].map(owner => owner.close()));
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Unexpected supervisor cleanup failure');
    rmSync(base, { recursive: true, force: true });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const pool: ResourcePool = { schemaVersion: 1, id: 'delete-failure', workers: [{ id: 'local', provider: 'local', model: 'fixture',
    maxConcurrent: 1, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }];
  const observations: ResourceObservation[] = [{ workerId: 'local', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }];
  return { root, archiveRoot, requests, owners, statePath: join(root, 'resource-console-state.json'), ledgerPath: join(root, 'pool-state.json'),
    async start() {
      const owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings, readObservations: () => observations,
        pollIntervalMs: 20, maxParallel: 1 }); owners.add(owner); return owner;
    },
    task(id: string): ResourceConsoleTaskInput { return { id, prompt: `private-loopback-prompt-${id}`, allowedWorkerIds: ['local'],
      mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 128, retainHistory: true }; },
  };
}

describe.skipIf(process.platform === 'win32')('console deletion root-publication failure', () => {
  it('clears only the requested session output before a failed root rename, without claiming durable history deletion', async () => {
    const f = await fixture(); const owner = await f.start();
    const target = f.task('target'); const unrelated = f.task('unrelated');
    owner.submit(target);
    await vi.waitFor(() => expect(owner.snapshot().jobs.find(job => job.id === target.id))
      .toMatchObject({ state: 'settled', outcome: 'completed' }), { timeout: 5000, interval: 20 });
    owner.submit(unrelated);
    await vi.waitFor(() => expect(owner.snapshot().jobs.find(job => job.id === unrelated.id))
      .toMatchObject({ state: 'settled', outcome: 'completed' }), { timeout: 5000, interval: 20 });
    owner.setPaused(true);
    const targetHistory = owner.history(target.id); const otherOutput = owner.output(unrelated.id);
    expect(owner.output(target.id)?.text).toBe('private-loopback-result-1');
    expect(otherOutput?.text).toBe('private-loopback-result-2'); expect(f.requests).toHaveLength(2);
    const rootBefore = readFileSync(f.statePath); const ledgerBefore = readFileSync(f.ledgerPath);
    expect(readdirSync(f.archiveRoot)).toEqual([]); fault.target = f.statePath;
    expect(() => owner.deleteHistory(target.id)).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(fault.hits).toBe(1); expect(fault.target).toBeNull();
    expect(owner.snapshot().error).not.toBeNull(); expect(owner.output(target.id)).toBeNull();
    expect(owner.output(unrelated.id)).toEqual(otherOutput);
    expect(() => owner.history(target.id)).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(readFileSync(f.statePath)).toEqual(rootBefore); expect(readFileSync(f.ledgerPath)).toEqual(ledgerBefore);
    expect(existsSync(join(f.archiveRoot, 'tombstones'))).toBe(false);
    await expect(owner.close()).rejects.toMatchObject({ code: 'UNAVAILABLE' }); f.owners.delete(owner);
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);

    // No task had ever been staged: no tombstone was committed. The failed
    // atomic root replacement therefore leaves durable history intact, honestly.
    const reopened = await f.start(); expect(reopened.snapshot().paused).toBe(true);
    expect(reopened.history(target.id)).toEqual(targetHistory); expect(reopened.output(target.id)).toBeNull();
    expect(reopened.submit(target)).toMatchObject({ state: 'settled', outcome: 'completed' });
    expect(f.requests).toHaveLength(2); expect(readFileSync(f.ledgerPath)).toEqual(ledgerBefore);
    await reopened.close(); f.owners.delete(reopened);
  });
});

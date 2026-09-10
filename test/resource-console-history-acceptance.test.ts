/** Independent retained-history acceptance using only a test-owned local provider. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { runResourceTask } from '../src/core/resources/pool-runtime.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-history-acceptance-')));
  const root = join(base, 'pool'); const workspace = join(base, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  let calls = 0;
  const responseText = 'PRIVATE_ASSISTANT <script>not executable</script>';
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      calls++;
      response.end(JSON.stringify({ choices: [{ message: { content: responseText } }],
        usage: { prompt_tokens: 8, completion_tokens: 4 } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const pool: ResourcePool = { schemaVersion: 1, id: 'history-acceptance', workers: [{ id: 'local', provider: 'local',
    model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 100, taskWindowMs: 1000, priority: 1, reservePercent: 10 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }];
  const now = Date.now();
  const observations: ResourceObservation[] = [{ workerId: 'local', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }];
  const owners: ResourcePoolSupervisor[] = [];
  cleanups.push(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  });
  const start = async () => {
    const owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings,
      readObservations: () => observations, pollIntervalMs: 20 });
    owners.push(owner); return owner;
  };
  const task = (id = 'retained'): ResourceConsoleTaskInput => ({ id, prompt: 'PRIVATE_REQUEST and PRIVATE_ATTACHMENT text',
    allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 100, retainHistory: true });
  const statePath = join(root, 'resource-console-state.json');
  return { root, workspace, pool, bindings, observations, responseText, start, task, calls: () => calls,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    save: (value: unknown) => writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 }) };
}

async function settled(owner: ResourcePoolSupervisor, id = 'retained') {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find((job) => job.id === id)?.state).toBe('settled'));
}

describe.skipIf(process.platform === 'win32')('independent local retained transcript boundaries', () => {
  it('reconciles a completed receipt before history capture without replaying or inventing output', async () => {
    const f = await fixture(); const first = await f.start(); first.setPaused(true); first.submit(f.task());
    const interrupted = f.state();
    interrupted.jobs[0].state = 'dispatching'; interrupted.jobs[0].reason = 'dispatch-requested';
    await first.close();
    // This is the exact durable interval after supervisor intent and runtime settlement,
    // but before the supervisor can publish its terminal transcript transaction.
    const { retainHistory: _consent, ...input } = f.task();
    const result = await runResourceTask({ root: f.root, pool: f.pool, bindings: f.bindings,
      observations: f.observations, task: { ...input, schemaVersion: 1, cwd: f.workspace } });
    expect(result.receipt?.status).toBe('completed'); expect(f.calls()).toBe(1);
    f.save(interrupted);
    const next = await f.start();
    expect(next.snapshot().jobs[0]).toMatchObject({ state: 'settled', outcome: 'completed' });
    expect(next.history('retained')).toMatchObject({ prompt: f.task().prompt, output: null });
    expect(next.output('retained')).toBeNull();
    next.submit(f.task()); next.setPaused(false);
    await new Promise((done) => setTimeout(done, 50));
    expect(f.calls()).toBe(1); expect(next.history('retained')?.output).toBeNull();
  });

  it('deletes retained bytes from both read paths and never resurrects them on retry or restart', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task()); await settled(owner);
    expect(owner.history('retained')?.output?.text).toBe(f.responseText);
    owner.deleteHistory('retained');
    expect(owner.history('retained')).toBeNull(); expect(owner.output('retained')).toBeNull();
    expect(JSON.stringify(f.state())).not.toContain('PRIVATE_');
    owner.submit(f.task()); owner.deleteHistory('retained');
    expect(owner.history('retained')).toBeNull(); await owner.close();
    const next = await f.start(); next.submit(f.task());
    expect(next.snapshot().jobs).toHaveLength(1); expect(next.history('retained')).toBeNull();
    expect(f.calls()).toBe(1);
  });

  it('binds consent independently from runtime identity, including deleted and legacy jobs', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task()); await settled(owner);
    const { retainHistory: _consent, ...legacy } = f.task();
    expect(() => owner.submit(legacy)).toThrow();
    expect(() => owner.submit({ ...legacy, retainHistory: false })).toThrow();
    owner.deleteHistory('retained'); expect(() => owner.submit(legacy)).toThrow();
    owner.submit({ ...legacy, id: 'legacy' }); await settled(owner, 'legacy');
    expect(() => owner.submit({ ...f.task(), id: 'legacy' })).toThrow();
    expect(owner.history('legacy')).toBeNull();
    expect(f.calls()).toBe(2);
  });

  it('keeps private prompt and output out of detached metadata and preserves explicit transcript reads', async () => {
    const f = await fixture(); const owner = await f.start();
    const submitted = owner.submit(f.task());
    expect(JSON.stringify(submitted)).not.toContain('PRIVATE_'); await settled(owner);
    const snapshot = owner.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_');
    expect(snapshot.jobs[0]).toMatchObject({ historyAvailable: true });
    const history = owner.history('retained')!; history.prompt = 'tampered'; history.output!.text = 'tampered';
    expect(owner.history('retained')).toMatchObject({ prompt: f.task().prompt, output: { text: f.responseText } });
    await owner.close(); const next = await f.start();
    expect(next.history('retained')).toMatchObject({ prompt: f.task().prompt, output: { text: f.responseText } });
    expect(JSON.stringify(next.snapshot())).not.toContain('PRIVATE_');
  });

  it('refuses deletion while input is still queued, then deletes after explicit cancellation without dispatch', async () => {
    const f = await fixture(); const owner = await f.start(); owner.setPaused(true); owner.submit(f.task());
    expect(() => owner.deleteHistory('retained')).toThrow();
    expect(owner.history('retained')?.prompt).toBe(f.task().prompt);
    owner.cancel('retained'); owner.deleteHistory('retained'); await owner.close();
    const next = await f.start(); next.submit(f.task()); next.setPaused(false);
    expect(next.snapshot().jobs[0]).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
    expect(next.history('retained')).toBeNull(); expect(f.calls()).toBe(0);
  });

  it('fails closed on restored history that disagrees with the pending dispatch input', async () => {
    const f = await fixture(); const owner = await f.start(); owner.setPaused(true); owner.submit(f.task());
    const malformed = f.state(); await owner.close();
    malformed.jobs[0].history.prompt = 'Different request'; f.save(malformed);
    await expect(f.start()).rejects.toThrow(); expect(f.calls()).toBe(0);
  });
});

/** Durable transcript tests use private temporary stores and an inert local transport. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const response = (text: string) => JSON.stringify({ choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 8, completion_tokens: 4 } });

async function fixture(output = 'PRIVATE_OUTPUT', hold = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-transcript-test-')));
  const root = join(base, 'pool'); const workspace = join(base, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const requests: unknown[] = []; const held: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (hold) held.push(res); else res.end(response(output));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
  const pool: ResourcePool = { schemaVersion: 1, id: 'history', workers: [{ id: 'local', provider: 'local',
    model: 'inert', maxConcurrent: 1, maxTasksPerWindow: 100, taskWindowMs: 1000, priority: 1, reservePercent: 10 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }];
  const observations: ResourceObservation[] = [{ workerId: 'local', observedAt: new Date(Date.now() - 100).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'ready', windows: [], retryAfter: null }];
  const owners: ResourcePoolSupervisor[] = [];
  cleanups.push(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  });
  const statePath = join(root, 'resource-console-state.json');
  return { root, workspace, requests, held, statePath,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    save: (value: unknown) => writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 }),
    start: async () => {
      const owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings,
        readObservations: () => observations, pollIntervalMs: 20, maxParallel: 1 });
      owners.push(owner); return owner;
    },
    task: (id = 'task', patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({
      id, prompt: `PRIVATE_PROMPT ${id}`, allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 10_000,
      maxOutputTokens: 128, retainHistory: true, ...patch,
    }),
  };
}

async function settled(owner: ResourcePoolSupervisor, id = 'task') {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find((row) => row.id === id)?.state).toBe('settled'), { timeout: 10_000 });
}

describe.skipIf(process.platform === 'win32')('opt-in atomic resource transcripts', () => {
  it('normalizes false and omitted consent while preserving schema1 and the runtime digest', async () => {
    const f = await fixture(); const owner = await f.start(); owner.setPaused(true);
    const { retainHistory: _flag, ...legacy } = f.task();
    owner.submit({ ...legacy, retainHistory: false }); owner.submit(legacy);
    expect(f.state().schemaVersion).toBe(1);
    expect(f.state().jobs[0]).not.toHaveProperty('retainHistory');
    expect(f.state().jobs[0].input).not.toHaveProperty('retainHistory');
    expect(f.state().jobs[0].taskDigest).toBe(digest(canonical({ ...legacy, schemaVersion: 1, cwd: f.workspace })));
    owner.setPaused(false); await settled(owner);
    expect(owner.history('task')).toBeNull(); expect(owner.snapshot().jobs[0]).not.toHaveProperty('historyAvailable');
    expect(readFileSync(f.statePath, 'utf8')).not.toContain('PRIVATE_');
    expect(f.requests).toHaveLength(1);
  });

  it('upgrades only on explicit consent without changing legacy rows or provider input', async () => {
    const f = await fixture(); const owner = await f.start(); owner.setPaused(true);
    owner.submit(f.task('legacy', { retainHistory: false })); const legacy = f.state().jobs[0];
    const input = f.task(); owner.submit(input);
    expect(f.state()).toMatchObject({ schemaVersion: 2, jobs: [legacy, { retainHistory: true,
      history: { prompt: input.prompt, output: null } }] });
    expect(f.state().jobs[0]).toEqual(legacy);
    const { retainHistory: _flag, ...runtime } = input;
    expect(f.state().jobs[1].taskDigest).toBe(digest(canonical({ ...runtime, schemaVersion: 1, cwd: f.workspace })));
    owner.setPaused(false); await settled(owner); await settled(owner, 'legacy');
    expect(JSON.stringify(f.requests)).not.toContain('retainHistory');
    const ledger = readFileSync(join(f.root, 'pool-state.json'), 'utf8');
    expect(ledger).not.toContain('PRIVATE_'); expect(ledger).not.toContain('retainHistory');
  });

  it('publishes terminal state and captured output together and reads them after restart', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task()); await settled(owner);
    const row = f.state().jobs[0];
    expect(row).toMatchObject({ state: 'settled', outcome: 'completed', input: null,
      history: { prompt: f.task().prompt, output: { text: 'PRIVATE_OUTPUT', truncated: false } } });
    expect(lstatSync(f.statePath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(owner.snapshot())).not.toContain('PRIVATE_');
    const captured = owner.history('task')!; captured.prompt = 'changed'; captured.output!.text = 'changed';
    await owner.close(); const next = await f.start();
    expect(next.history('task')).toEqual({ id: 'task', prompt: f.task().prompt,
      output: { text: 'PRIVATE_OUTPUT', truncated: false }, retention: 'local-until-deleted',
      transcriptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(next.output('task')).toBeNull(); expect(f.requests).toHaveLength(1);
  });

  it('deletes only text while preserving immutable consent, identity and ledger bytes', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task()); await settled(owner);
    const before = f.state().jobs[0]; const ledger = readFileSync(join(f.root, 'pool-state.json'));
    expect(owner.deleteHistory('task')).not.toHaveProperty('historyAvailable');
    expect(owner.output('task')).toBeNull(); expect(owner.history('task')).toBeNull();
    expect(f.state()).toMatchObject({ schemaVersion: 2, jobs: [{ retainHistory: true, history: null, taskDigest: before.taskDigest }] });
    expect(readFileSync(f.statePath, 'utf8')).not.toContain('PRIVATE_');
    expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(ledger);
    owner.submit(f.task()); owner.deleteHistory('task');
    expect(() => owner.submit(f.task('task', { prompt: 'changed' }))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => owner.submit(f.task('task', { retainHistory: false }))).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    await owner.close(); const next = await f.start(); next.submit(f.task());
    expect(next.history('task')).toBeNull(); expect(f.requests).toHaveLength(1);
  });

  it('refuses deletion of queued or dispatching text, but allows terminal cancellation', async () => {
    const f = await fixture('held', true); const owner = await f.start(); owner.setPaused(true); owner.submit(f.task());
    expect(() => owner.deleteHistory('task')).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    owner.setPaused(false); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(() => owner.deleteHistory('task')).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    owner.cancel('task'); await settled(owner);
    expect(owner.history('task')?.output).toBeNull(); owner.deleteHistory('task');
    expect(owner.history('task')).toBeNull();
  });

  it('keeps a previous dispatch unresolved and refuses deletion or replay', async () => {
    const f = await fixture(); const first = await f.start(); first.setPaused(true); first.submit(f.task());
    const interrupted = f.state(); interrupted.jobs[0].state = 'dispatching'; await first.close(); f.save(interrupted);
    const next = await f.start();
    expect(next.snapshot().jobs[0].state).toBe('unresolved');
    expect(next.history('task')).toMatchObject({ prompt: f.task().prompt, output: null });
    expect(() => next.deleteHistory('task')).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    next.submit(f.task()); next.setPaused(false);
    await new Promise((done) => setTimeout(done, 50)); expect(f.requests).toHaveLength(0);
  });

  it.each([
    ['exact ASCII boundary', 'a'.repeat(65_536), 'a'.repeat(65_536), false],
    ['UTF8 boundary', '界'.repeat(21_846), '界'.repeat(21_845), true],
    ['four-byte boundary', '😀'.repeat(16_385), '😀'.repeat(16_384), true],
  ] as const)('bounds persisted output at 64KiB on a %s', async (_label, output, expected, truncated) => {
    const f = await fixture(output); const owner = await f.start(); owner.submit(f.task()); await settled(owner);
    expect(owner.history('task')?.output).toEqual({ text: expected, truncated });
    expect(Buffer.byteLength(owner.history('task')!.output!.text)).toBeLessThanOrEqual(65_536);
    await owner.close(); const next = await f.start(); expect(next.history('task')?.output).toEqual({ text: expected, truncated });
  });

  it('reserves all future escaped outputs before intent and settles every admitted task within 4MiB', async () => {
    const f = await fixture('\u0000'.repeat(65_536)); const owner = await f.start(); owner.setPaused(true);
    const prompt = 'x' + '\u0001'.repeat(28_000); const admitted: string[] = [];
    for (let index = 0; index < 64; index++) {
      const before = readFileSync(f.statePath); const id = `bounded-${index}`;
      try { owner.submit(f.task(id, { prompt })); admitted.push(id); }
      catch (error) {
        expect(error).toMatchObject({ code: 'CAPACITY' }); expect(readFileSync(f.statePath)).toEqual(before);
        expect(owner.snapshot().jobs.some((job) => job.id === id)).toBe(false); break;
      }
    }
    expect(admitted.length).toBeGreaterThan(1); expect(admitted.length).toBeLessThan(10);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false); expect(f.requests).toHaveLength(0);
    owner.setPaused(false);
    for (const id of admitted) await settled(owner, id);
    expect(owner.snapshot().error).toBeNull(); expect(f.requests).toHaveLength(admitted.length);
    expect(readFileSync(f.statePath).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    for (const id of admitted) expect(owner.history(id)?.output).toEqual({ text: '\u0000'.repeat(65_536), truncated: false });
    await owner.close(); const next = await f.start(); expect(next.snapshot().jobs).toHaveLength(admitted.length);
  });

  it.each([null, 'true', 1, undefined])('rejects malformed explicit consent %s before admission', async (retainHistory) => {
    const f = await fixture(); const owner = await f.start();
    const before = readFileSync(f.statePath);
    expect(() => owner.submit({ ...f.task(), retainHistory } as ResourceConsoleTaskInput))
      .toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(readFileSync(f.statePath)).toEqual(before); expect(f.requests).toHaveLength(0);
  });

  it('rejects malformed persisted output and missing consent rather than silently discarding history', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task()); await settled(owner);
    const state = f.state(); await owner.close();
    for (const mutate of [
      (value: typeof state) => { value.jobs[0].history.output.text = 'a'.repeat(65_537); },
      (value: typeof state) => { delete value.jobs[0].retainHistory; },
      (value: typeof state) => { value.schemaVersion = 1; },
    ]) {
      const changed = structuredClone(state); mutate(changed); f.save(changed);
      await expect(f.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    }
    expect(f.requests).toHaveLength(1);
  });
});

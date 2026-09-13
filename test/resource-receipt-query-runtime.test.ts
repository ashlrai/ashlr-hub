/** Independent real ledger and loopback execution; seeded time cases are explicitly labelled. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { resourcePoolQueryStatus, resourcePoolStatus, runResourceTask, type ResourceTask, type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import { planResourceAssignment, type ResourceObservation, type ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const completion = () => JSON.stringify({ choices: [{ message: { content: 'LOCAL_RECEIPT_QUERY_RESULT' } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 } });
async function fixture(options: { respond?: (res: ServerResponse) => void; temporal?: number } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'receipt-query-runtime-')));
  const root = join(base, 'ledger'); const cwd = join(base, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const requests: string[] = []; const pending: Array<Promise<unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(Buffer.concat(chunks).toString('utf8')); if (options.respond) options.respond(res); else res.end(completion()); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  cleanup.push(async () => {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await Promise.allSettled(pending); rmSync(base, { recursive: true, force: true });
  });
  const pool: ResourcePool = { schemaVersion: 1, id: 'receipt-query-runtime', workers: ['alias-a', 'alias-b', 'independent'].map((id, index) => ({
    id, provider: 'local', model: 'fixture', reservePercent: 25, priority: index + 1,
    maxConcurrent: options.temporal ? 3 : 1, maxTasksPerWindow: options.temporal ? 3 : 10,
    taskWindowMs: options.temporal ?? 60_000,
  })) };
  const bindings: ResourceBinding[] = pool.workers.map(worker => ({ workerId: worker.id,
    capacityKey: worker.id === 'independent' ? 'separate' : 'shared', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }));
  const now = Date.now();
  const observations: ResourceObservation[] = pool.workers.map(worker => ({ workerId: worker.id, health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }));
  const task = (id: string, workerId = 'alias-a', patch: Partial<ResourceTask> = {}): ResourceTask => ({ schemaVersion: 1, id,
    prompt: `PRIVATE_QUERY_TASK_${id}`, allowedWorkerIds: [workerId], cwd, mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 100, ...patch });
  const run = (input: ResourceTask, extra: Partial<Parameters<typeof runResourceTask>[0]> = {}) => {
    const promise = runResourceTask({ root, pool, bindings, observations, task: input, ...extra });
    pending.push(promise); void promise.catch(() => {}); return promise;
  };
  const status = () => resourcePoolStatus(root, pool, bindings, []);
  const queryStatus = () => resourcePoolQueryStatus(root, pool, bindings, []);
  return { root, pool, bindings, observations, requests, task, run, status, queryStatus, now,
    bytes: () => readFileSync(join(root, 'pool-state.json'), 'utf8') };
}

describe('query-backed runtime accounting retains complete receipt semantics', () => {
  it('reads missing receipt evidence without creating storage or exposing a partial attempts array', async () => {
    const f = await fixture(); const query = f.queryStatus();
    expect(query.sourceState).toBe('missing'); expect(query).not.toHaveProperty('attempts');
    expect(query.receipts.getMany(['first', 'second', 'first'])).toEqual([
      { status: 'proven-absent', id: 'first' }, { status: 'proven-absent', id: 'second' }, { status: 'proven-absent', id: 'first' },
    ]);
    expect(query.receipts.unresolved()).toEqual([]);
    expect(existsSync(f.root)).toBe(false); expect(f.requests).toHaveLength(0);
  });

  it('keeps detached query evidence coherent while a real reservation settles', async () => {
    const held: ServerResponse[] = []; const f = await fixture({ respond: res => held.push(res) });
    const running = f.run(f.task('query-snapshot'));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const before = f.bytes(); const query = f.queryStatus();
    expect(f.bytes()).toBe(before);
    expect(query.plan.exclusions.find(row => row.workerId === 'alias-b')?.reasons).toContain('concurrency-exhausted');
    const found = query.receipts.get('query-snapshot');
    expect(found.status).toBe('found');
    if (found.status !== 'found') throw new Error('Fixture reservation missing');
    found.receipt.reason = 'changed-returned-copy';
    expect(query.receipts.unresolved('shared')[0]?.reason).not.toBe('changed-returned-copy');
    held[0]!.end(completion()); await running;
    expect(query.receipts.get('query-snapshot')).toMatchObject({ receipt: { status: 'reserved' } });
    expect(query.receipts.accountWindow('shared', 60_000, Date.now()).inFlightCount).toBe(1);
    const current = f.queryStatus();
    expect(current.receipts.get('query-snapshot')).toMatchObject({ receipt: { status: 'completed' } });
    expect(current.receipts.unresolved()).toEqual([]);
    expect(f.status().attempts).toHaveLength(1); expect(f.status()).not.toHaveProperty('receipts');
  });

  it('refuses corrupt ledger evidence instead of returning proven absence', async () => {
    const f = await fixture(); await f.run(f.task('before-corruption'));
    writeFileSync(join(f.root, 'pool-state.json'), '{"schemaVersion":1}\n');
    const before = f.bytes();
    expect(() => f.queryStatus()).toThrow(); expect(() => f.status()).toThrow();
    expect(f.bytes()).toBe(before); expect(f.requests).toHaveLength(1);
  });

  it('conserves a real shared reservation while permitting an independent capacity and exact blocked replay', async () => {
    const held: ServerResponse[] = []; const f = await fixture({ respond: res => held.push(res) });
    const task = f.task('held'); const running = f.run(task);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const reserved = f.status().attempts[0]!; expect(reserved.status).toBe('reserved');
    const fresh = vi.fn(() => { throw new Error('Exact replay must bypass fresh admission'); });
    const replay = await f.run(task, { unavailableWorkerIds: ['alias-a'], readAdmissionEvidence: fresh });
    expect(replay).toMatchObject({ replayed: true, receipt: reserved, output: null, plan: null }); expect(fresh).not.toHaveBeenCalled();
    const denied = await f.run(f.task('alias-blocked', 'alias-b'));
    expect(denied.receipt).toBeNull();
    expect(denied.plan?.exclusions.find(row => row.workerId === 'alias-b')?.reasons).toContain('concurrency-exhausted');
    const independent = f.run(f.task('independent-live', 'independent'));
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.status().attempts.filter(row => row.status === 'reserved').map(row => row.capacityKey).sort()).toEqual(['separate', 'shared']);
    held.forEach(res => res.end(completion()));
    expect((await Promise.all([running, independent])).every(result => result.receipt?.status === 'completed')).toBe(true);
    expect(f.requests).toHaveLength(2); expect(f.status().attempts).toHaveLength(2);
  });

  it('charges an actual no-dispatch veto without cooldown, then shares actual worker failure cooldown across aliases', async () => {
    const f = await fixture({ respond: res => { res.statusCode = 500; res.end('PRIVATE_LOCAL_FAILURE'); } });
    const veto = await f.run(f.task('vetoed'), { beforeWorkerDispatch: () => false });
    expect(veto.receipt).toMatchObject({ status: 'failed', reason: 'worker-dispatch-precondition-failed', inputTokens: null,
      outputTokens: null, outputDigest: null }); expect(veto.receipt).not.toHaveProperty('execution');
    expect(f.requests).toHaveLength(0);
    const afterVeto = f.status();
    expect(afterVeto.plan.candidates.find(row => row.workerId === 'alias-b')?.taskReservationCount).toBe(1);
    expect(afterVeto.plan.exclusions.find(row => row.workerId === 'alias-b')).toBeUndefined();
    const failed = await f.run(f.task('contacted', 'alias-b'));
    expect(failed.receipt?.status).toBe('failed'); expect(failed.receipt).toHaveProperty('execution'); expect(f.requests).toHaveLength(1);
    const status = f.status();
    for (const workerId of ['alias-a', 'alias-b']) {
      expect(status.plan.exclusions.find(row => row.workerId === workerId)?.reasons).toContain('provider-retry-after');
    }
    expect(status.plan.candidates.find(row => row.workerId === 'independent')).toBeDefined();
    expect((await f.run(f.task('cooldown-refused'))).receipt).toBeNull(); expect(f.requests).toHaveLength(1);
    expect(f.bytes()).not.toContain('PRIVATE_LOCAL_FAILURE'); expect(f.status().attempts).toHaveLength(2);
  });

  it('replays exact completed identity under blocked gates and rejects a changed task without another request', async () => {
    const f = await fixture(); const task = f.task('completed'); const first = await f.run(task);
    const before = f.bytes(); const fresh = vi.fn(() => { throw new Error('Replay attempted fresh admission'); });
    const replay = await f.run(task, { unavailableWorkerIds: ['alias-b'], quotaUnavailableWorkerIds: ['alias-a'], readAdmissionEvidence: fresh });
    expect(replay).toMatchObject({ replayed: true, receipt: first.receipt, output: null, plan: null });
    expect(fresh).not.toHaveBeenCalled(); expect(f.bytes()).toBe(before);
    await expect(f.run({ ...task, prompt: 'changed identity' })).rejects.toThrow('Resource task identity conflict');
    expect(f.bytes()).toBe(before); expect(f.requests).toHaveLength(1);
  });

  it.each([2000, 4000])('matches the original complete-array plan at strict window edges and clock rollback with a %ims account window', async windowMs => {
    const f = await fixture({ temporal: windowMs }); const base = f.now;
    // These historical rows are seeded decoder-valid evidence, NOT executions.
    // Actual reservation and contact behavior is exercised in the cases above.
    const rows: ResourceTaskReceipt[] = [-2000, -1999, 100, -10_000].map((offset, index) => ({ schemaVersion: 1,
      id: `seeded-${index}`, taskDigest: digest(`seeded-task-${index}`), poolDigest: digest(canonical({ pool: f.pool, bindings: f.bindings })),
      workerId: index % 2 ? 'alias-b' : 'alias-a', capacityKey: 'shared', status: index === 3 ? 'uncertain' : index === 1 ? 'cancelled' : 'completed',
      startedAt: new Date(base + offset).toISOString(), finishedAt: new Date(base + offset).toISOString(),
      outputDigest: index === 0 || index === 2 ? digest('seeded-output') : null, inputTokens: null, outputTokens: null,
      reason: 'seeded-history', verifiedAccepted: false }));
    mkdirSync(f.root, { mode: 0o700 }); writeFileSync(join(f.root, 'pool-state.json'), canonical({ schemaVersion: 1,
      poolDigest: rows[0]!.poolDigest, observations: f.observations, attempts: rows }) + '\n', { mode: 0o600 });
    const before = f.bytes(); const clock = vi.spyOn(Date, 'now');
    for (const nowMs of [base, base - 1000, base + 1000, base - 20_000]) {
      clock.mockReturnValue(nowMs);
      const activeCounts: Record<string, number> = {};
      const taskReservationCounts: Record<string, { count: number; nextEligibleAt: string | null }> = {};
      // Independent golden: the exact pre-query runtime formulas, not query helpers.
      for (const binding of f.bindings) {
        const worker = f.pool.workers.find(row => row.id === binding.workerId)!;
        const account = rows.filter(row => row.capacityKey === binding.capacityKey);
        activeCounts[worker.id] = account.filter(row => !['completed', 'failed', 'timed-out', 'cancelled'].includes(row.status)).length;
        const recent = account.filter(row => Date.parse(row.startedAt) > nowMs - worker.taskWindowMs);
        taskReservationCounts[worker.id] = { count: recent.length,
          nextEligibleAt: recent.length ? new Date(Math.min(...recent.map(row => Date.parse(row.startedAt))) + worker.taskWindowMs).toISOString() : null };
      }
      const expected = planResourceAssignment({ pool: f.pool, observations: f.observations,
        allowedWorkerIds: f.pool.workers.map(row => row.id), activeCounts, taskReservationCounts, nowMs });
      expect(f.status().plan).toEqual(expected); expect(f.status().attempts).toEqual(rows);
      expect(activeCounts['alias-a']).toBe(1); expect(activeCounts.independent).toBe(0);
      if (nowMs === base) expect([taskReservationCounts['alias-a']!.count, taskReservationCounts['alias-b']!.count])
        .toEqual(windowMs === 2000 ? [2, 2] : [3, 3]);
      if (nowMs === base - 20_000) expect(taskReservationCounts['alias-a']!.count).toBe(4);
    }
    expect(f.bytes()).toBe(before); expect(f.requests).toHaveLength(0);
  });
});

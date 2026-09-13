/** Real private state/ledger transactions; provider traffic is confined to a test-owned server. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(output = 'Private prior answer') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-followup-core-')));
  const workspace = join(base, 'workspace'); const root = join(base, 'pool'); mkdirSync(workspace, { mode: 0o700 });
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => { requests++; res.end(JSON.stringify({ choices: [{ message: { content: output } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 } })); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const pool: ResourcePool = { schemaVersion: 1, id: 'core-followup', workers: [{ id: 'local', provider: 'local',
    model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 100, taskWindowMs: 1000, priority: 1, reservePercent: 10 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }];
  const owners: ResourcePoolSupervisor[] = []; const statePath = join(root, 'resource-console-state.json');
  cleanups.push(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  });
  return { root, statePath, requests: () => requests,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    save: (value: unknown) => writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 }),
    start: async () => {
      const now = Date.now();
      const owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings, maxParallel: 1, pollIntervalMs: 20,
        readObservations: () => [{ workerId: 'local', observedAt: new Date(now - 100).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', windows: [], retryAfter: null }] });
      owners.push(owner); return owner;
    },
    task: (id: string, patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
      prompt: `Private own request ${id}`, allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 10_000,
      maxOutputTokens: 128, retainHistory: true, ...patch }),
  };
}
async function settled(owner: ResourcePoolSupervisor, id: string) {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find((row) => row.id === id)?.state).toBe('settled'), { timeout: 10_000 });
}

describe.skipIf(process.platform === 'win32')('follow-up durable context admission', () => {
  it('fails closed on malformed schema3 context, identity and consent without replay', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task('root')); await settled(owner, 'root');
    owner.setPaused(true); owner.submit(f.task('child', { parent: { taskId: 'root', expectedTranscriptDigest: owner.history('root')!.transcriptDigest! } }));
    const valid = f.state(); await owner.close();
    for (const mutate of [
      (value: typeof valid) => { value.jobs[1].context[0].prompt = 'retargeted'; },
      (value: typeof valid) => { value.jobs[1].context[0].outcome = 'failed'; },
      (value: typeof valid) => { value.jobs[1].context = null; },
      (value: typeof valid) => { value.jobs[1].parent.expectedTranscriptDigest = '0'.repeat(64); },
      (value: typeof valid) => { value.jobs[1].submissionDigest = '0'.repeat(64); },
      (value: typeof valid) => { value.jobs[1].input.parent.expectedTranscriptDigest = '0'.repeat(64); },
      (value: typeof valid) => { value.jobs[1].context.push(structuredClone(value.jobs[1].context[0])); },
      (value: typeof valid) => { value.schemaVersion = 2; },
    ]) {
      const changed = structuredClone(valid); mutate(changed); f.save(changed);
      const before = readFileSync(f.statePath);
      await expect(f.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(readFileSync(f.statePath)).toEqual(before); expect(f.requests()).toBe(1);
    }
    f.save(valid); const recovered = await f.start(); recovered.setPaused(false); await settled(recovered, 'child');
    expect(f.requests()).toBe(2);
  });

  it('counts frozen escaped context and future outputs in state headroom before publishing any new intent', async () => {
    const f = await fixture('\u0000'.repeat(32_000)); const owner = await f.start();
    owner.submit(f.task('root')); await settled(owner, 'root'); owner.setPaused(true);
    const parent = { taskId: 'root', expectedTranscriptDigest: owner.history('root')!.transcriptDigest! };
    const admitted: string[] = []; let rejected = false;
    for (let index = 0; index < 64; index++) {
      const before = readFileSync(f.statePath); const ledger = readFileSync(join(f.root, 'pool-state.json'));
      const id = `child-${index}`;
      try { owner.submit(f.task(id, { parent })); admitted.push(id); }
      catch (error) {
        expect(error).toMatchObject({ code: 'CAPACITY' }); rejected = true;
        expect(readFileSync(f.statePath)).toEqual(before); expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(ledger);
        expect(owner.snapshot().jobs.some((row) => row.id === id)).toBe(false); break;
      }
    }
    expect(rejected).toBe(true); expect(admitted.length).toBeGreaterThan(1);
    // Without counting six-byte JSON escaping in each frozen source copy,
    // nine such retained children would incorrectly appear admissible.
    expect(admitted.length).toBeLessThan(9); expect(f.requests()).toBe(1);
    owner.setPaused(false); for (const id of admitted) await settled(owner, id);
    expect(owner.snapshot().error).toBeNull(); expect(f.requests()).toBe(admitted.length + 1);
    expect(readFileSync(f.statePath).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    await owner.close(); const next = await f.start();
    for (const id of admitted) expect(next.history(id)?.context?.[0]?.output?.text).toBe('\u0000'.repeat(32_000));
  });

  it('scrubs an unretained child context on queued cancellation while keeping exact retry identity', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task('root')); await settled(owner, 'root');
    const child = f.task('child', { retainHistory: false,
      parent: { taskId: 'root', expectedTranscriptDigest: owner.history('root')!.transcriptDigest! } });
    owner.setPaused(true); owner.submit(child);
    expect(f.state().jobs[1].context).toHaveLength(1); owner.cancel('child');
    expect(f.state().jobs[1]).toMatchObject({ context: null, input: null, state: 'cancelled' });
    owner.deleteHistory('root'); expect(JSON.stringify(f.state())).not.toContain('Private');
    await owner.close(); const next = await f.start();
    expect(() => next.submit(child)).not.toThrow(); expect(next.history('child')).toBeNull(); expect(f.requests()).toBe(1);
  });
});

/** Independent frozen-context acceptance; all provider traffic terminates in this fixture. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(responseText = 'PRIVATE_CAPTURED_ANSWER') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-followup-acceptance-')));
  const root = join(base, 'pool'); const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ choices: [{ message: { content: responseText } }],
        usage: { prompt_tokens: 8, completion_tokens: 4 } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const pool: ResourcePool = { schemaVersion: 1, id: 'followup-acceptance', workers: [{ id: 'local', provider: 'local',
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
      readObservations: () => observations, pollIntervalMs: 20 }); owners.push(owner); return owner;
  };
  const task = (id: string, patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_REQUEST_${id}`, allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 5000,
    maxOutputTokens: 100, retainHistory: true, ...patch });
  return { start, task, requests, responseText,
    state: () => JSON.parse(readFileSync(join(root, 'resource-console-state.json'), 'utf8')),
    ledger: () => JSON.parse(readFileSync(join(root, 'pool-state.json'), 'utf8')) };
}
async function settled(owner: ResourcePoolSupervisor, id: string) {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find((job) => job.id === id)?.state).toBe('settled'));
}
function parent(owner: ResourcePoolSupervisor, taskId: string) {
  return { taskId, expectedTranscriptDigest: owner.history(taskId)!.transcriptDigest };
}

describe.skipIf(process.platform === 'win32')('independent follow-up context and replay boundaries', () => {
  it('retries a frozen child after parent deletion and restart, then never resurrects deleted child copies', async () => {
    const f = await fixture(); const first = await f.start(); first.submit(f.task('root')); await settled(first, 'root');
    const rootHistory = first.history('root')!;
    const child = f.task('child', { parent: parent(first, 'root') });
    first.setPaused(true); first.submit(child); first.deleteHistory('root');
    expect(first.history('root')).toBeNull();
    expect(first.history('child')?.context).toEqual([{ taskId: 'root', prompt: f.task('root').prompt,
      output: rootHistory.output, outcome: 'completed' }]);
    await first.close(); const next = await f.start();
    expect(() => next.submit(child)).not.toThrow(); expect(next.snapshot().jobs).toHaveLength(2);
    expect(() => next.submit({ ...child, parent: { ...child.parent!, expectedTranscriptDigest: '0'.repeat(64) } })).toThrow();
    next.setPaused(false); await settled(next, 'child');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.messages[0]!.content).toContain(f.task('root').prompt);
    expect(f.ledger().attempts.map((row: { id: string }) => row.id)).toEqual(['root', 'child']);
    next.deleteHistory('child'); next.submit(child); await next.close();
    const last = await f.start(); expect(() => last.submit(child)).not.toThrow();
    expect(last.history('child')).toBeNull(); expect(last.history('root')).toBeNull();
    expect(last.output('child')).toBeNull(); expect(JSON.stringify(f.state())).not.toContain('PRIVATE_');
    expect(f.requests).toHaveLength(2); expect(f.ledger().attempts).toHaveLength(2);
  });

  it('flattens multiple generations into distinct own turns, without recursively embedding compiled prompts', async () => {
    const f = await fixture(); const owner = await f.start();
    owner.submit(f.task('root')); await settled(owner, 'root');
    owner.submit(f.task('child', { parent: parent(owner, 'root') })); await settled(owner, 'child');
    owner.submit(f.task('grandchild', { parent: parent(owner, 'child') })); await settled(owner, 'grandchild');
    const history = owner.history('grandchild')!;
    expect(history.prompt).toBe(f.task('grandchild').prompt);
    expect(history.context).toEqual(['root', 'child'].map((taskId) => ({ taskId, prompt: f.task(taskId).prompt,
      output: { text: f.responseText, truncated: false }, outcome: 'completed' })));
    const compiled = f.requests[2]!.messages[0]!.content;
    for (const id of ['root', 'child', 'grandchild']) expect(compiled.split(f.task(id).prompt)).toHaveLength(2);
    expect(JSON.stringify(owner.snapshot())).not.toContain('PRIVATE_');
    expect(f.ledger().attempts).toHaveLength(3); expect(f.state().schemaVersion).toBe(3);
    owner.deleteHistory('root'); owner.deleteHistory('child'); await owner.close();
    const next = await f.start(); expect(next.history('grandchild')).toEqual(history);
    next.submit(f.task('great-grandchild', { parent: parent(next, 'grandchild') })); await settled(next, 'great-grandchild');
    expect(next.history('great-grandchild')?.context?.map((turn) => turn.taskId)).toEqual(['root', 'child', 'grandchild']);
    expect(f.requests).toHaveLength(4); expect(f.ledger().attempts).toHaveLength(4);
  });

  it('rejects changed parent identity and stale parent digests without creating a new reservation', async () => {
    const f = await fixture(); const owner = await f.start();
    owner.submit(f.task('root')); await settled(owner, 'root');
    owner.submit(f.task('other')); await settled(owner, 'other');
    owner.setPaused(true); const child = f.task('child', { parent: parent(owner, 'root') }); owner.submit(child);
    expect(() => owner.submit({ ...child, parent: parent(owner, 'other') })).toThrow();
    expect(() => owner.submit(f.task('stale', { parent: { taskId: 'root', expectedTranscriptDigest: '0'.repeat(64) } }))).toThrow();
    expect(owner.snapshot().jobs.map((job) => job.id)).toEqual(['root', 'other', 'child']);
    expect(f.requests).toHaveLength(2); expect(f.ledger().attempts).toHaveLength(2);
  });

  it('rejects an oversized compiled context instead of pruning ancestors or reserving another task', async () => {
    const f = await fixture('A'.repeat(64 * 1024)); const owner = await f.start();
    const prompt = (id: string) => id + 'p'.repeat(32 * 1024 - id.length);
    owner.submit(f.task('root', { prompt: prompt('root') })); await settled(owner, 'root');
    owner.submit(f.task('child', { prompt: prompt('child'), parent: parent(owner, 'root') })); await settled(owner, 'child');
    owner.submit(f.task('grandchild', { prompt: prompt('grandchild'), parent: parent(owner, 'child') })); await settled(owner, 'grandchild');
    expect(() => owner.submit(f.task('too-large', { prompt: prompt('too-large'), parent: parent(owner, 'grandchild') }))).toThrow();
    expect(owner.snapshot().jobs).toHaveLength(3); expect(f.requests).toHaveLength(3); expect(f.ledger().attempts).toHaveLength(3);
    expect(owner.history('grandchild')?.context).toHaveLength(2);
  });

  it('preserves an explicitly cancelled parent with no captured response as context, not an invented answer', async () => {
    const f = await fixture(); const owner = await f.start(); owner.setPaused(true);
    owner.submit(f.task('root')); owner.cancel('root');
    owner.submit(f.task('child', { parent: parent(owner, 'root') })); owner.setPaused(false); await settled(owner, 'child');
    expect(owner.history('child')?.context).toEqual([{ taskId: 'root', prompt: f.task('root').prompt,
      output: null, outcome: 'cancelled' }]);
    expect(f.requests).toHaveLength(1); expect(f.ledger().attempts.map((row: { id: string }) => row.id)).toEqual(['child']);
  });

  it('preserves parent truncation metadata when continuing from a retained response prefix', async () => {
    const f = await fixture('Z'.repeat(64 * 1024) + '🙂'); const owner = await f.start();
    owner.submit(f.task('root')); await settled(owner, 'root');
    owner.submit(f.task('child', { parent: parent(owner, 'root') })); await settled(owner, 'child');
    expect(owner.history('child')?.context?.[0]?.output).toEqual({ text: 'Z'.repeat(64 * 1024), truncated: true });
    expect(f.requests).toHaveLength(2);
  });

  it('scrubs copied context after a non-retained child settles while preserving replay identity', async () => {
    const f = await fixture(); const owner = await f.start(); owner.submit(f.task('root')); await settled(owner, 'root');
    const child = f.task('child', { parent: parent(owner, 'root'), retainHistory: false });
    owner.submit(child); await settled(owner, 'child'); owner.deleteHistory('root');
    expect(owner.history('child')).toBeNull(); expect(JSON.stringify(f.state())).not.toContain('PRIVATE_');
    await owner.close(); const next = await f.start(); expect(() => next.submit(child)).not.toThrow();
    expect(next.history('child')).toBeNull(); expect(f.requests).toHaveLength(2);
  });
});

/** Independent project-bound execution acceptance, using test-owned directories and transports only. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor, type ResourcePoolSupervisorOptions } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

type Project = { id: string; label: string; workspace: string };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(config: { hold?: boolean; maxTasks?: number; native?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-projects-acceptance-')));
  const root = join(base, 'pool'); const workspace = join(base, 'default');
  const second = join(base, 'second'); const third = join(base, 'third');
  for (const path of [workspace, second, third]) mkdirSync(path, { mode: 0o700 });
  const requests: unknown[] = []; const held: ServerResponse[] = [];
  const answer = () => JSON.stringify({ choices: [{ message: { content: 'PRIVATE_PROJECT_RESPONSE' } }],
    usage: { prompt_tokens: 8, completion_tokens: 4 } });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (config.hold) held.push(response); else response.end(answer());
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const pool: ResourcePool = { schemaVersion: 1, id: 'projects-acceptance', workers: [{ id: 'worker',
    provider: config.native ? 'codex' : 'local', model: 'fixture', maxConcurrent: 1,
    maxTasksPerWindow: config.maxTasks ?? 100, taskWindowMs: 60_000, priority: 1, reservePercent: 10,
    ...(config.native ? { allowUnknownQuota: true } : {}) }] };
  const script = join(base, 'fixture-worker.cjs');
  if (config.native) writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => {
    const text = JSON.stringify({ cwd: process.cwd(), requestedCwd: process.argv[process.argv.indexOf('--cd') + 1] });
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n');
    process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:4}})+'\\n');
  });`, { mode: 0o600 });
  const bindings: ResourceBinding[] = [config.native
    ? { workerId: 'worker', capacityKey: 'shared-account', kind: 'native-cli', command: [process.execPath, script] }
    : { workerId: 'worker', capacityKey: 'shared-account', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }];
  const now = Date.now();
  const observations: ResourceObservation[] = [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }];
  const owners: ResourcePoolSupervisor[] = [];
  cleanups.push(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  });
  const start = async (projects?: Project[], patch: Partial<ResourcePoolSupervisorOptions> = {}) => {
    const owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings,
      readObservations: () => observations, pollIntervalMs: 20, ...(projects === undefined ? {} : { projects }), ...patch });
    owners.push(owner); return owner;
  };
  const task = (id: string, patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id,
    prompt: `PRIVATE_PROJECT_REQUEST_${id}`, allowedWorkerIds: ['worker'], mode: 'read-only', timeoutMs: 5000,
    maxOutputTokens: 100, retainHistory: true, ...patch });
  return { base, root, workspace, second, third, start, task, requests, held,
    secondProject: { id: 'second', label: 'Second project', workspace: second },
    thirdProject: { id: 'third', label: 'Third project', workspace: third },
    release: () => { const response = held.shift(); if (!response) throw new Error('No held fixture request'); response.end(answer()); },
    state: () => JSON.parse(readFileSync(join(root, 'resource-console-state.json'), 'utf8')),
    ledger: () => JSON.parse(readFileSync(join(root, 'pool-state.json'), 'utf8')) };
}
async function settled(owner: ResourcePoolSupervisor, id: string) {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find((job) => job.id === id)?.state).toBe('settled'));
}

describe.skipIf(process.platform === 'win32')('independent shared-ledger project acceptance', () => {
  it('migrates legacy follow-ups without changing their transcripts, receipts, or default-project replay identity', async () => {
    const f = await fixture(); const legacy = await f.start(); expect(legacy.projects()).toBeUndefined();
    legacy.submit(f.task('root')); await settled(legacy, 'root');
    const child = f.task('child', { parent: { taskId: 'root', expectedTranscriptDigest: legacy.history('root')!.transcriptDigest! } });
    legacy.submit(child); await settled(legacy, 'child');
    const rootHistory = legacy.history('root'); const childHistory = legacy.history('child'); const ledger = f.ledger();
    expect(f.state().schemaVersion).toBe(3); await legacy.close();
    const upgraded = await f.start([f.secondProject]);
    expect(f.state().schemaVersion).toBe(4);
    expect(upgraded.history('root')).toEqual(rootHistory); expect(upgraded.history('child')).toEqual(childHistory);
    expect(() => upgraded.submit({ ...f.task('root'), projectId: 'default' })).not.toThrow();
    expect(() => upgraded.submit({ ...child, projectId: 'default' })).not.toThrow();
    expect(f.ledger()).toEqual(ledger); expect(f.requests).toHaveLength(2);
  });

  it('holds disabled catalog work, preserves accepted retries, and permits relabeling/reordering/additions without rebinding', async () => {
    const f = await fixture(); const first = await f.start([f.secondProject]); first.setPaused(true);
    const pending = f.task('pending', { projectId: 'second' }); first.submit(pending); await first.close();
    const disabled = await f.start([]); disabled.setPaused(false);
    await vi.waitFor(() => expect(disabled.snapshot().jobs[0]).toMatchObject({ state: 'queued', reason: 'project-not-enabled' }));
    expect(disabled.projects()?.find((project) => project.id === 'second')).toMatchObject({ enabled: false, workspace: f.second });
    expect(() => disabled.submit(pending)).not.toThrow();
    expect(() => disabled.submit(f.task('new-disabled', { projectId: 'second' }))).toThrow();
    expect(f.requests).toHaveLength(0); disabled.setPaused(true); await disabled.close();
    const restored = await f.start([f.thirdProject, { ...f.secondProject, label: 'Renamed project' }]);
    expect(restored.projects()?.find((project) => project.id === 'second')).toMatchObject({ label: 'Renamed project', enabled: true });
    expect(restored.projects()?.find((project) => project.id === 'third')).toMatchObject({ enabled: true });
    expect(() => restored.submit(pending)).not.toThrow(); restored.setPaused(false); await settled(restored, 'pending');
    expect(f.requests).toHaveLength(1); await restored.close();
    const replacement = join(f.base, 'replacement-project'); mkdirSync(replacement, { mode: 0o700 });
    await expect(f.start([{ ...f.secondProject, workspace: replacement }])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.ledger().attempts).toHaveLength(1);
  });

  it('shares both the account slot and rolling task cap across projects', async () => {
    const f = await fixture({ hold: true, maxTasks: 2 }); const owner = await f.start([f.secondProject]); owner.setPaused(true);
    owner.submit(f.task('default-job')); owner.submit(f.task('second-job', { projectId: 'second' })); owner.setPaused(false);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.ledger().attempts).toHaveLength(1);
    expect(owner.snapshot().jobs.filter((job) => job.state === 'queued')).toHaveLength(1);
    f.release(); await vi.waitFor(() => expect(f.requests).toHaveLength(2)); f.release();
    await settled(owner, 'default-job'); await settled(owner, 'second-job');
    owner.submit(f.task('capped-job', { projectId: 'second' }));
    await vi.waitFor(() => expect(owner.snapshot().jobs.find((job) => job.id === 'capped-job')).toMatchObject({ state: 'queued', reason: 'no-eligible-capacity' }));
    expect(f.requests).toHaveLength(2); expect(f.ledger().attempts).toHaveLength(2);
    expect(new Set(f.ledger().attempts.map((row: { capacityKey: string }) => row.capacityKey))).toEqual(new Set(['shared-account']));
  });

  it('runs test-owned native work in the selected project directory while retaining one ledger', async () => {
    const f = await fixture({ native: true }); const owner = await f.start([f.secondProject]);
    owner.submit(f.task('default-job')); await settled(owner, 'default-job');
    owner.submit(f.task('second-job', { projectId: 'second' })); await settled(owner, 'second-job');
    expect(JSON.parse(owner.output('default-job')!.text)).toEqual({ cwd: f.workspace, requestedCwd: f.workspace });
    expect(JSON.parse(owner.output('second-job')!.text)).toEqual({ cwd: f.second, requestedCwd: f.second });
    expect(owner.snapshot().jobs.find((job) => job.id === 'second-job')).toMatchObject({ projectId: 'second' });
    expect(owner.history('second-job')).toMatchObject({ projectId: 'second' });
    expect(f.ledger().attempts).toHaveLength(2);
  });

  it('rejects cross-project follow-ups and changed-project retries before reserving work', async () => {
    const f = await fixture(); const owner = await f.start([f.secondProject]);
    owner.submit(f.task('root', { projectId: 'second' })); await settled(owner, 'root');
    const reference = { taskId: 'root', expectedTranscriptDigest: owner.history('root')!.transcriptDigest! };
    expect(() => owner.submit(f.task('cross-project', { projectId: 'default', parent: reference }))).toThrow();
    expect(() => owner.submit(f.task('root', { projectId: 'default' }))).toThrow();
    owner.submit(f.task('child', { projectId: 'second', parent: reference })); await settled(owner, 'child');
    expect(owner.snapshot().jobs.map((job) => job.id)).toEqual(['root', 'child']); expect(f.ledger().attempts).toHaveLength(2);
  });

  it('isolates directory-identity drift to its project and resumes only when the pinned directory is restored', async () => {
    const f = await fixture(); const owner = await f.start([f.secondProject]); owner.setPaused(true);
    owner.submit(f.task('changed-directory', { projectId: 'second' })); owner.submit(f.task('healthy-default'));
    const parked = join(f.base, 'original-second'); renameSync(f.second, parked); mkdirSync(f.second, { mode: 0o700 });
    owner.setPaused(false); await settled(owner, 'healthy-default');
    expect(owner.snapshot().error).toBeNull();
    expect(owner.snapshot().jobs.find((job) => job.id === 'changed-directory')).toMatchObject({ state: 'queued', reason: 'project-directory-unavailable' });
    expect(f.requests).toHaveLength(1); expect(f.ledger().attempts).toHaveLength(1);
    rmdirSync(f.second); renameSync(parked, f.second); await settled(owner, 'changed-directory');
    expect(f.requests).toHaveLength(2); expect(f.ledger().attempts).toHaveLength(2);
  });
});

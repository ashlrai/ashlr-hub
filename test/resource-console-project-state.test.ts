/** Project admission tests use only private temporary directories and an inert loopback worker. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { resourcePoolStatus, runResourceTask } from '../src/core/resources/pool-runtime.js';
import * as projects from '../src/core/resources/console-projects.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourcePool, ResourceObservation } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-project-state-')));
  const root = join(base, 'pool'); const workspace = join(base, 'default'); const extra = join(base, 'extra');
  mkdirSync(workspace, { mode: 0o755 }); mkdirSync(extra, { mode: 0o755 }); let requests = 0;
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => { requests++; res.end(JSON.stringify({ choices: [{ message: { content: 'Actual fixture response' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 } })); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const pool: ResourcePool = { schemaVersion: 1, id: 'project-state', workers: [{ id: 'local', provider: 'local', model: 'fixture',
    maxConcurrent: 1, maxTasksPerWindow: 100, taskWindowMs: 1000, priority: 1, reservePercent: 10 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }];
  const observations: ResourceObservation[] = [{ workerId: 'local', observedAt: new Date(Date.now() - 100).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'ready', windows: [], retryAfter: null }];
  const owners: ResourcePoolSupervisor[] = [];
  cleanups.push(async () => {
    for (const owner of owners) await owner.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); rmSync(base, { recursive: true, force: true });
  });
  const catalog = [{ id: 'extra', label: 'Extra', workspace: extra }];
  return { base, root, workspace, extra, pool, bindings, observations, catalog, requests: () => requests,
    state: () => JSON.parse(readFileSync(join(root, 'resource-console-state.json'), 'utf8')),
    ledger: () => JSON.parse(readFileSync(join(root, 'pool-state.json'), 'utf8')),
    start: async (configured = catalog) => {
      const owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings, projects: configured,
        readObservations: () => observations, pollIntervalMs: 20 }); owners.push(owner); return owner;
    },
    task: (id: string, projectId?: string): ResourceConsoleTaskInput => ({ id, prompt: `Private request ${id}`,
      allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 64, retainHistory: true,
      ...(projectId ? { projectId } : {}) }),
  };
}
async function settled(owner: ResourcePoolSupervisor, id: string) {
  await vi.waitFor(() => expect(owner.snapshot().jobs.find((job) => job.id === id)?.state).toBe('settled'));
}

describe.skipIf(process.platform === 'win32')('project identity and shared durable state', () => {
  it('pins descriptor identities without changing directory permissions and refuses replacement/symlink aliases', async () => {
    const f = await fixture(); const binding = projects.pinResourceConsoleProject(f.catalog[0]!);
    expect(binding.dev).toMatch(/^\d+$/); expect(binding.ino).toMatch(/^\d+$/);
    expect(projects.matchesResourceConsoleProject({ ...binding, label: 'Renamed display' })).toBe(true);
    renameSync(f.extra, join(f.base, 'moved')); mkdirSync(f.extra, { mode: 0o755 });
    expect(projects.matchesResourceConsoleProject(binding)).toBe(false);
    const alias = join(f.base, 'alias'); symlinkSync(f.extra, alias);
    expect(() => projects.pinResourceConsoleProject({ id: 'alias', label: 'Alias', workspace: alias })).toThrow();
  });

  it.each([4, 5])('blocks a real directory swap at identity check %i without invoking the worker', async (swapAt) => {
    const f = await fixture(); const owner = await f.start(); const original = projects.matchesResourceConsoleProject;
    let swapped = false;
    vi.spyOn(projects, 'matchesResourceConsoleProject').mockImplementation((binding) => {
      const ledger = existsSync(join(f.root, 'pool-state.json')) ? f.ledger() : null;
      const atBoundary = swapAt === 4 ? existsSync(join(f.root, '.pool.lock')) :
        ledger?.attempts.some((attempt: { id: string; status: string }) => attempt.id === 'held' && attempt.status === 'reserved');
      if (binding.id === 'extra' && !swapped && atBoundary) {
        swapped = true;
        renameSync(f.extra, join(f.base, 'original-extra')); mkdirSync(f.extra, { mode: 0o755 });
      }
      return original(binding);
    });
    owner.submit(f.task('held', 'extra'));
    if (swapAt === 4) {
      await vi.waitFor(() => expect(owner.snapshot().jobs[0]).toMatchObject({ state: 'queued', reason: 'project-directory-unavailable' }));
      expect(f.ledger().attempts).toHaveLength(0);
    } else {
      await settled(owner, 'held');
      expect(f.ledger().attempts).toHaveLength(1);
      expect(f.ledger().attempts[0]).toMatchObject({ status: 'failed', reason: 'worker-dispatch-precondition-failed',
        inputTokens: null, outputTokens: null, outputDigest: null, verifiedAccepted: false });
      expect(f.ledger().attempts[0]).not.toHaveProperty('execution'); expect(f.ledger().attempts[0]).not.toHaveProperty('nativeProcess');
      expect(owner.history('held')?.output).toBeNull();
    }
    expect(swapped).toBe(true); expect(f.requests()).toBe(0); expect(owner.snapshot().error).toBeNull();
    owner.submit(f.task('unrelated')); await settled(owner, 'unrelated'); expect(f.requests()).toBe(1);
  });

  it('holds a replaced default directory across restart without disabling another enabled project', async () => {
    const f = await fixture(); const first = await f.start(); first.setPaused(true); first.submit(f.task('default-held'));
    await first.close(); renameSync(f.workspace, join(f.base, 'old-default')); mkdirSync(f.workspace, { mode: 0o755 });
    const next = await f.start(); next.setPaused(false);
    await vi.waitFor(() => expect(next.snapshot().jobs[0]).toMatchObject({ state: 'queued', reason: 'project-directory-unavailable' }));
    expect(() => next.submit(f.task('default-new'))).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    next.submit(f.task('extra-ok', 'extra')); await settled(next, 'extra-ok'); expect(f.requests()).toBe(1);
    expect(next.cancel('default-held').state).toBe('cancelled');
  });

  it('rejects configured path rebinding before state writes and retains disabled historical catalog entries', async () => {
    const f = await fixture(); const first = await f.start(); await first.close();
    const before = readFileSync(join(f.root, 'resource-console-state.json'));
    const other = join(f.base, 'different'); mkdirSync(other, { mode: 0o755 });
    await expect(f.start([{ id: 'extra', label: 'Changed', workspace: other }])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readFileSync(join(f.root, 'resource-console-state.json'))).toEqual(before);
    const disabled = await f.start([]);
    expect(disabled.projects()).toContainEqual({ ...f.catalog[0], enabled: false });
    expect(() => disabled.submit(f.task('disabled', 'extra'))).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(f.requests()).toBe(0);
  });

  it.each(['false', 'throw', 'non-boolean'] as const)('settles a %s final precondition without invented execution and preserves replay', async (kind) => {
    const f = await fixture(); let checks = 0;
    const input = f.task('guarded'); const { retainHistory: _consent, ...runtime } = input;
    const options = { root: f.root, pool: f.pool, bindings: f.bindings, observations: f.observations,
      task: { ...runtime, schemaVersion: 1 as const, cwd: f.workspace }, beforeWorkerDispatch: () => {
        checks++; if (kind === 'throw') throw new Error('Private error');
        return (kind === 'non-boolean' ? 'truthy' : false) as boolean;
      } };
    const result = await runResourceTask(options);
    expect(result.receipt).toMatchObject({ status: 'failed', reason: 'worker-dispatch-precondition-failed', inputTokens: null, outputTokens: null });
    expect(result.receipt).not.toHaveProperty('execution'); expect(result.output).toBeNull(); expect(f.requests()).toBe(0);
    expect((await runResourceTask(options)).replayed).toBe(true); expect(checks).toBe(1); expect(f.ledger().attempts).toHaveLength(1);
  });

  it('does not exempt an executed worker failure from cooldown merely because its reason matches a host veto', async () => {
    const f = await fixture(); const { retainHistory: _consent, ...input } = f.task('failed');
    await runResourceTask({ root: f.root, pool: f.pool, bindings: f.bindings, observations: f.observations,
      task: { ...input, schemaVersion: 1, cwd: f.workspace }, beforeWorkerDispatch: () => false });
    expect(resourcePoolStatus(f.root, f.pool, f.bindings, f.observations).plan.selectedWorkerId).toBe('local');
    const ledger = f.ledger();
    // Only test-owned fixture evidence: an actual adapter invocation carries an
    // execution measurement even if it happens to use the same reason string.
    ledger.attempts[0].execution = { schemaVersion: 1, scope: 'worker-execution', durationMs: 1, usageScope: null };
    writeFileSync(join(f.root, 'pool-state.json'), JSON.stringify(ledger), { mode: 0o600 });
    expect(resourcePoolStatus(f.root, f.pool, f.bindings, f.observations).plan.selectedWorkerId).toBeNull();
    expect(f.requests()).toBe(0);
  });
});

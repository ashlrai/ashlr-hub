import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectResourceConsoleJobView, selectResourceConsoleJobsPage, validateResourceConsoleJobId } from '../src/core/resources/console-job-view.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import type { ResourceSupervisorJob } from '../src/core/resources/console-types.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';

const at = '2026-09-13T00:00:00.000Z';
const row = (index: number, state: ResourceSupervisorJob['state'] = 'settled'): ResourceSupervisorJob => ({
  id: `task-${String(index).padStart(4, '0')}`, state, enqueuedAt: at, updatedAt: at,
  allowedWorkerIds: Array.from({ length: 32 }, (_, n) => `worker-${n}-`.padEnd(64, 'a')),
  mode: 'read-only', workerId: null, outcome: null, reason: null, cancellable: false, outputAvailable: false,
});

describe('bounded joined console observation selection', () => {
  it('projects at most 256 of 4352 identities with wide worker lists, retaining all active states', () => {
    const rows = Array.from({ length: 4352 }, (_, index) => row(index, index === 0 ? 'unresolved' : index === 1 ? 'dispatching' : index === 2 ? 'queued' : 'settled'));
    const selected = selectResourceConsoleJobView(rows);
    expect(selected.jobWindow).toEqual({ totalJobs: 4352, visibleJobs: 256, omittedJobs: 4096 });
    expect(selected.jobs.slice(0, 3).map(job => job.id)).toEqual(['task-0000', 'task-0001', 'task-0002']);
    expect(selected.jobs[3].id).toBe('task-4099');
    expect(selected.jobs.at(-1)?.id).toBe('task-4351');
    expect(selected.jobs[0]).toBe(rows[0]); // Selection never makes a whole-history public copy.
    expect(Buffer.byteLength(JSON.stringify({ jobs: selected.jobs, jobWindow: selected.jobWindow }))).toBeLessThan(1024 * 1024);
    expect(rows[3].id).toBe('task-0003');
  });
  it('keeps 256 nonterminal jobs and refuses inconsistent excess rather than hiding unresolved work', () => {
    const active = Array.from({ length: 256 }, (_, index) => row(index, 'unresolved'));
    expect(selectResourceConsoleJobView([...active, row(256)]).jobs).toEqual(active);
    expect(() => selectResourceConsoleJobView([...active, row(256, 'queued')])).toThrow('history unavailable');
  });
  it('orders enqueue timestamps before deterministic ID ties, without mutating input', () => {
    const early = { ...row(9), enqueuedAt: '2026-09-12T00:00:00.000Z' };
    const rows = [row(2), early, row(1)];
    expect(selectResourceConsoleJobView(rows).jobs.map(job => job.id)).toEqual(['task-0009', 'task-0001', 'task-0002']);
    expect(selectResourceConsoleJobsPage(rows).items.map(job => job.id)).toEqual(['task-0002', 'task-0001', 'task-0009']);
    expect(rows[0].id).toBe('task-0002');
  });
  it('navigates every identity once and preserves cursors across reordered storage', () => {
    const rows = Array.from({ length: 4352 }, (_, index) => row(index));
    let page = selectResourceConsoleJobsPage(rows);
    expect(page.items).toHaveLength(64);
    const ids = page.items.map(job => job.id);
    while (page.nextBefore) {
      page = selectResourceConsoleJobsPage([...rows].reverse(), { before: page.nextBefore });
      ids.push(...page.items.map(job => job.id));
    }
    expect(ids).toHaveLength(4352);
    expect(new Set(ids).size).toBe(4352);
    expect(ids[0]).toBe('task-4351'); expect(ids.at(-1)).toBe('task-0000');
    expect(selectResourceConsoleJobsPage(rows, { limit: 256 }).items).toHaveLength(256);
  });
  it('handles empty history and absent cursor identity without claiming a stable snapshot', () => {
    expect(selectResourceConsoleJobsPage([])).toEqual({ items: [], totalJobs: 0, nextBefore: null });
    expect(selectResourceConsoleJobView([]).jobWindow).toEqual({ totalJobs: 0, visibleJobs: 0, omittedJobs: 0 });
    expect(selectResourceConsoleJobsPage([row(1), row(3)], { before: { enqueuedAt: at, id: row(2).id } }).items).toEqual([row(1)]);
  });
  it('navigates ordinary and canonical extended-year dates chronologically with stable ID ties', () => {
    const rows = [
      { ...row(1), enqueuedAt: '9999-12-31T23:59:59.999Z' },
      { ...row(2), enqueuedAt: '+010000-01-01T00:00:00.000Z' },
      { ...row(3), enqueuedAt: '-000001-01-01T00:00:00.000Z' },
      { ...row(4), enqueuedAt: '+010000-01-01T00:00:00.000Z' },
    ];
    expect(selectResourceConsoleJobView(rows).jobs.map(job => job.id)).toEqual(['task-0003', 'task-0001', 'task-0002', 'task-0004']);
    const first = selectResourceConsoleJobsPage(rows, { limit: 1 });
    expect(first.items.map(job => job.id)).toEqual(['task-0004']);
    expect(first.nextBefore).toEqual({ enqueuedAt: '+010000-01-01T00:00:00.000Z', id: 'task-0004' });
    const second = selectResourceConsoleJobsPage(rows, { limit: 1, before: first.nextBefore! });
    expect(second.items.map(job => job.id)).toEqual(['task-0002']);
    const third = selectResourceConsoleJobsPage(rows, { limit: 1, before: second.nextBefore! });
    expect(third.items.map(job => job.id)).toEqual(['task-0001']);
    const fourth = selectResourceConsoleJobsPage(rows, { limit: 1, before: third.nextBefore! });
    expect(fourth.items.map(job => job.id)).toEqual(['task-0003']);
    expect(fourth.nextBefore).toBeNull();
    expect(selectResourceConsoleJobsPage(rows, { before: { enqueuedAt: rows[2].enqueuedAt, id: rows[2].id } }).items).toEqual([]);
  });
  it.each([null, [], 1, 'x', { limit: 0 }, { limit: 257 }, { limit: 1.5 }, { limit: NaN }, { limit: undefined },
    { before: null }, { before: undefined }, { extra: true }, { before: { enqueuedAt: at } },
    { before: { enqueuedAt: at, id: '../bad' } }, { before: { enqueuedAt: at, id: 'good\n' } }, { before: { enqueuedAt: '2026-09-13', id: 'good' } },
    { before: { enqueuedAt: '2026-02-30T00:00:00.000Z', id: 'good' } },
    { before: { enqueuedAt: at, id: 'good', extra: true } }, { [Symbol('private')]: 1 },
  ])('rejects malformed page options %#', value => {
    expect(() => selectResourceConsoleJobsPage([], value)).toThrow('Invalid resource task history query');
  });
  it('rejects descriptors, inherited fields and proxies without invoking hostile code', () => {
    const trap = vi.fn(() => { throw new Error('must not run'); });
    const values = [Object.defineProperty({}, 'limit', { get: trap, enumerable: true }),
      { before: Object.defineProperty({ id: 'good' }, 'enqueuedAt', { get: trap, enumerable: true }) },
      Object.create({ get limit() { return trap(); } }), new Proxy({}, { getPrototypeOf: trap, ownKeys: trap }),
      { before: new Proxy({}, { getPrototypeOf: trap }) }, Object.defineProperty({}, 'limit', { value: 4 })];
    for (const value of values) expect(() => selectResourceConsoleJobsPage([], value)).toThrow('Invalid resource task history query');
    expect(trap).not.toHaveBeenCalled();
    expect(selectResourceConsoleJobsPage([], Object.assign(Object.create(null), { limit: 1 }))).toEqual({ items: [], totalJobs: 0, nextBefore: null });
  });
  it.each([null, undefined, {}, '', '../secret', 'Bad', 'good\n', 'a'.repeat(65)])('rejects malformed exact job identity %#', id => {
    expect(() => validateResourceConsoleJobId(id)).toThrow('Invalid resource task history query');
  });
});

let base: string | undefined; let owner: ResourcePoolSupervisor | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (owner) { await owner.close(); owner = undefined; }
  if (base) { rmSync(base, { recursive: true, force: true }); base = undefined; }
});

describe.skipIf(process.platform === 'win32')('actual supervisor bounded observation methods', () => {
  it.each(['close', 'ownership-loss'] as const)('keeps snapshot compatibility, redacts public rows, and refuses reads after %s', async failure => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'console-job-view-')));
    const root = join(base, 'pool'); const workspace = join(base, 'workspace');
    mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
    const pool = validateResourcePool({ schemaVersion: 1, id: 'view', workers: [{ id: 'local', provider: 'local', model: 'fixture',
      maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 25 }] });
    const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
    writeFileSync(join(root, 'resource-console-state.json'), canonical({ schemaVersion: 1, scopeDigest: digest(canonical({ pool, bindings, workspace })),
      paused: true, jobs: [] }) + '\n', { mode: 0o600 });
    owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings, readObservations: () => [], pollIntervalMs: 60_000 });
    const job = owner.submit({ id: 'held', prompt: 'private prompt never dispatched', allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 100 });
    expect(owner.snapshot().jobWindow).toBeUndefined();
    expect(owner.view()).toEqual({ ...owner.snapshot(), jobWindow: { totalJobs: 1, visibleJobs: 1, omittedJobs: 0 } });
    expect(owner.job('held')).toEqual(job);
    expect(owner.job('missing')).toBeNull();
    expect(owner.jobsPage()).toEqual({ items: [job], totalJobs: 1, nextBefore: null });
    expect(JSON.stringify(owner.job('held'))).not.toContain('private prompt');
    expect(owner.job('held')).not.toHaveProperty('taskDigest');
    const publicRow = owner.job('held')!; publicRow.allowedWorkerIds.push('foreign');
    expect(owner.job('held')!.allowedWorkerIds).toEqual(['local']);
    expect(() => owner!.job(null as unknown as string)).toThrow('Invalid resource task history query');
    if (failure === 'close') await owner.close();
    else {
      const lock = join(root, '.resource-console.lock');
      unlinkSync(lock); writeFileSync(lock, '{"replacement":true}\n', { mode: 0o600 });
    }
    expect(() => owner!.view()).toThrow();
    expect(() => owner!.job('held')).toThrow('unavailable');
    expect(() => owner!.jobsPage()).toThrow('unavailable');
    if (failure === 'close') expect(owner.snapshot().closing).toBe(true);
    else {
      expect(owner.snapshot().error).toBe('supervisor-ownership-lost');
      await expect(owner.close()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(readFileSync(join(root, '.resource-console.lock'), 'utf8')).toBe('{"replacement":true}\n');
      owner = undefined; // Expected failed release is asserted, never silently swallowed.
    }
  });
});

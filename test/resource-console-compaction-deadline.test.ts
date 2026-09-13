/** Real eight-record staging over a seeded legacy fixture, not 256 actual admissions. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { decodeResourceConsoleState, type ResourceConsoleDurableState } from '../src/core/resources/console-state-codec.js';
import type { ResourceConsoleHistoryDescriptor } from '../src/core/resources/console-history-view.js';

const hooks = vi.hoisted(() => ({ afterCompaction: null as (() => void) | null, compactions: 0 }));
vi.mock('../src/core/resources/console-state-storage.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/resources/console-state-storage.js')>();
  return { ...actual, compactResourceConsoleStorage: (...args: Parameters<typeof actual.compactResourceConsoleStorage>) => {
    const result = actual.compactResourceConsoleStorage(...args);
    hooks.compactions++; hooks.afterCompaction?.();
    return result;
  } };
});

let base: string | undefined; let owner: ResourcePoolSupervisor | undefined;
afterEach(async () => {
  hooks.afterCompaction = null; hooks.compactions = 0;
  vi.restoreAllMocks();
  // Preserve evidence if ownership cannot be cleanly released.
  if (owner) { await owner.close(); owner = undefined; }
  if (base) { rmSync(base, { recursive: true, force: true }); base = undefined; }
});
async function fixture() {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'console-compaction-deadline-')));
  const root = join(base, 'pool'); const workspace = join(base, 'workspace');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'deadline', workers: [{ id: 'local', provider: 'local', model: 'fixture',
    maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 25 }] });
  const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'local', kind: 'local-chat',
    endpoint: 'http://127.0.0.1:1/v1' }], pool);
  const at = '2026-09-13T00:00:00.000Z';
  const state: ResourceConsoleDurableState = { schemaVersion: 1, scopeDigest: digest(canonical({ pool, bindings, workspace })),
    paused: true, jobs: Array.from({ length: 256 }, (_, index) => ({ id: `old-${index}`, state: 'cancelled',
      enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['local'], mode: 'read-only', workerId: null,
      outcome: 'cancelled', reason: 'queued-task-cancelled', taskDigest: digest(`old-${index}`), input: null })) };
  expect(decodeResourceConsoleState(state, { pool, bindings, workspace })).toEqual(state);
  const path = join(root, 'resource-console-state.json');
  writeFileSync(path, canonical(state) + '\n', { mode: 0o600 });
  owner = await createResourcePoolSupervisor({ root, workspace, pool, bindings, archiveHistory: true,
    readObservations: () => [], pollIntervalMs: 60_000 });
  const task = { id: 'new-intent', prompt: 'Never execute this fixture task', allowedWorkerIds: ['local'],
    mode: 'read-only' as const, timeoutMs: 1000, maxOutputTokens: 100 };
  return { root, path, task, owner };
}

describe.skipIf(process.platform === 'win32')('post-compaction admission boundary', () => {
  it.each(['deadline', 'stop', 'reentrant-pause'] as const)('refuses %s after real staging without publishing the proposed task', async kind => {
    const f = await fixture();
    const deadline = Date.now() + 60_000;
    let stopped = false; let after = false;
    hooks.afterCompaction = () => {
      after = true;
      if (kind === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(deadline);
      if (kind === 'stop') stopped = true;
    };
    const lifetime = { deadlineAt: new Date(deadline).toISOString(), isExecutionStopped: () => {
      if (kind === 'reentrant-pause' && after) {
        after = false; f.owner.setPaused(false);
      }
      return stopped;
    } };
    expect(() => f.owner.submit(f.task, lifetime)).toThrow(kind === 'reentrant-pause'
      ? 'Resource queue changed during admission' : 'host-execution-stopped');
    expect(hooks.compactions).toBe(1);
    const source = JSON.parse(readFileSync(f.path, 'utf8')) as ResourceConsoleHistoryDescriptor;
    expect(source.kind).toBe('resource-console-history-descriptor');
    expect(source.order.filter(row => row.source === 'archive')).toHaveLength(8);
    expect(source.order).toHaveLength(256);
    expect(source.currentJobs).toHaveLength(248);
    expect(source.currentJobs.some(job => job.id === f.task.id)).toBe(false);
    expect(f.owner.snapshot().jobs).toHaveLength(256);
    expect(f.owner.snapshot().activeCount).toBe(0);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  }, 20_000);
});


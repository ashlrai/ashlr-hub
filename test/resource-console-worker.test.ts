import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planResourceAssignment, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceConsoleResponse } from '../src/core/web/resource-console-public.js';
import { createResourceConsoleReader, type ResourceConsoleReadScope } from '../src/core/web/resource-console-reads.js';

const fixture = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn(), read: vi.fn(), status: vi.fn(), run: vi.fn(),
  scope: { root: '/private/tmp/resource-worker-root', observationsFile: '/private/tmp/resource-worker-observations.json',
    pool: { schemaVersion: 1, id: 'pool', workers: [{ id: 'local', provider: 'local', model: 'model', maxConcurrent: 1,
      maxTasksPerWindow: 5, taskWindowMs: 60_000, reservePercent: 0, priority: 1 }] },
    bindings: [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1' }] } }));
vi.mock('node:worker_threads', async (original) => ({ ...await original<typeof import('node:worker_threads')>(),
  parentPort: { on: fixture.on, postMessage: fixture.postMessage }, workerData: fixture.scope }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: fixture.read, resourcePoolStatus: fixture.status,
  runResourceTask: fixture.run }));
const scope = fixture.scope as ResourceConsoleReadScope;
let dispatch: (value: unknown) => void;
beforeAll(async () => {
  await import('../src/core/web/resource-console-worker.js');
  expect(fixture.on.mock.calls[0]![0]).toBe('message'); dispatch = fixture.on.mock.calls[0]![1];
});
beforeEach(() => {
  fixture.postMessage.mockClear(); fixture.read.mockReset(); fixture.status.mockReset(); fixture.run.mockClear();
  fixture.read.mockReturnValue([]);
  fixture.status.mockReturnValue({ schemaVersion: 1, poolId: 'pool', sourceState: 'missing', observations: [], attempts: [],
    plan: planResourceAssignment({ pool: scope.pool, observations: [], allowedWorkerIds: ['local'], activeCounts: {},
      taskReservationCounts: {}, nowMs: Date.now() }) });
});
function result() {
  const value = fixture.postMessage.mock.calls.at(-1)![0];
  expect(value).toMatchObject({ type: 'result', ok: true }); expect(typeof value.value).toBe('string');
  return validateResourceConsoleResponse(value.value, scope.pool, scope.bindings);
}

describe('resource evidence worker protocol', () => {
  it('reads only the pinned private file and projects status without executing tasks', () => {
    dispatch({ type: 'read', id: 1, kind: 'snapshot' });
    expect(fixture.read).toHaveBeenCalledExactlyOnceWith(scope.observationsFile);
    expect(fixture.status).toHaveBeenCalledExactlyOnceWith(scope.root, scope.pool, scope.bindings, []);
    expect(result()).toMatchObject({ sourceState: 'missing', counts: { total: 0 } }); expect(fixture.run).not.toHaveBeenCalled();
    expect(JSON.stringify(result())).not.toMatch(/endpoint|11434|resource-worker-root/);
  });

  it('rereads observations for each request instead of renewing cached quota freshness', () => {
    dispatch({ type: 'read', id: 1, kind: 'snapshot' });
    const observation = { workerId: 'local', observedAt: '2026-09-07T12:00:00.000Z', expiresAt: '2026-09-07T12:01:00.000Z',
      health: 'ready', windows: [], retryAfter: null };
    fixture.read.mockReturnValue([observation]); dispatch({ type: 'read', id: 2, kind: 'snapshot' });
    expect(fixture.read).toHaveBeenCalledTimes(2); expect(fixture.status.mock.calls[1]?.[3]).toEqual([observation]);
  });

  it.each(['missing-file', 'unsafe-file', 'corrupt-source', 'malformed-observation'])('returns fixed degraded evidence for %s', (kind) => {
    if (kind === 'malformed-observation') fixture.read.mockReturnValue([{ private: 'not evidence' }]);
    else if (kind === 'corrupt-source') fixture.status.mockImplementation(() => { throw new Error('/private/secret ledger'); });
    else fixture.read.mockImplementation(() => { throw new Error('/private/secret input'); });
    dispatch({ type: 'read', id: 1, kind: 'snapshot' });
    expect(result()).toMatchObject({ sourceState: 'degraded', plan: null, counts: { total: null }, groups: [{ occupiedSlots: null }] });
    expect(JSON.stringify(result())).not.toContain('secret'); expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each([{ type: 'read', id: 1, kind: 'snapshot', payload: { root: '/other' } },
    { type: 'read', id: 1, kind: 'snapshot', root: '/other' }, { type: 'read', id: 1, kind: 'execute' }])(
    'rejects browser scope or unsupported requests before evidence reads %#', (request) => {
      dispatch(request); expect(fixture.read).not.toHaveBeenCalled(); expect(fixture.status).not.toHaveBeenCalled();
      expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 1, ok: false });
    });

  it.each([null, [], { type: 'read', id: 0, kind: 'snapshot' }, { type: 'execute', id: 1 }])('ignores invalid framing %#', (request) => {
    dispatch(request); expect(fixture.read).not.toHaveBeenCalled(); expect(fixture.postMessage).not.toHaveBeenCalled();
  });

  it('rejects framing accessors and symbol fields before source reads without invoking getters', () => {
    const getter = vi.fn(() => 'snapshot');
    dispatch(Object.defineProperty({ type: 'read', id: 1 }, 'kind', { get: getter }));
    dispatch({ type: 'read', id: 2, kind: 'snapshot', [Symbol('private')]: true });
    dispatch(Object.defineProperty({ type: 'read', kind: 'snapshot' }, 'id', { get: getter }));
    expect(getter).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.postMessage.mock.calls.map((call) => call[0])).toEqual([
      { type: 'result', id: 1, ok: false }, { type: 'result', id: 2, ok: false },
    ]);
  });
});

describe('managed quota gate through the actual read worker', () => {
  async function runCase(kind: 'fresh' | 'missing-alias' | 'explicit-veto' | 'expired' | 'future-update' | 'unknown') {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-managed-resource-read-')));
    const root = join(temporary, 'absent-ledger'); const observationsFile = join(temporary, 'observations.json');
    const worker = { ...scope.pool.workers[0]!, provider: 'codex' as const, allowUnknownQuota: true };
    const selectedScope: ResourceConsoleReadScope = { root, observationsFile,
      pool: { schemaVersion: 1, id: 'managed', workers: [{ ...worker, id: 'codex-a' }, { ...worker, id: 'codex-b' }] },
      bindings: ['codex-a', 'codex-b'].map((workerId) => ({ workerId, capacityKey: 'shared', kind: 'native-cli',
        command: ['/fixture/this-command-must-never-execute'] })), managedWorkerIds: ['codex-a', 'codex-b'] };
    const now = Date.now();
    const observed = (workerId: string): ResourceObservation => ({ workerId, observedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', retryAfter: null,
      windows: [{ id: 'codex_primary', usedPercent: 25, resetsAt: new Date(now + 90_000).toISOString() }] });
    // The private owner file is fresh in every case; it must not mask a missing
    // or stale reading from the explicitly commissioned collector itself.
    writeFileSync(observationsFile, JSON.stringify([observed('codex-a'), observed('codex-b')]), { mode: 0o600 });
    const managed = { observations: [observed('codex-a'), observed('codex-b')], unavailableWorkerIds: [] as string[] };
    if (kind === 'missing-alias') managed.observations.pop();
    if (kind === 'explicit-veto') managed.unavailableWorkerIds.push('codex-b');
    if (kind === 'expired') Object.assign(managed.observations[1]!, { observedAt: new Date(now - 61_000).toISOString(),
      updatedAt: new Date(now - 61_000).toISOString(), expiresAt: new Date(now - 1_000).toISOString() });
    if (kind === 'future-update') managed.observations[1]!.updatedAt = new Date(now + 50_000).toISOString();
    if (kind === 'unknown') managed.observations[1]!.windows[0]!.usedPercent = null;
    const reader = createResourceConsoleReader(selectedScope);
    try {
      const original = readFileSync(observationsFile); const stat = statSync(observationsFile);
      const result = await reader.snapshot(managed);
      expect(result.sourceState).toBe('missing'); expect(result.counts.total).toBe(0);
      if (kind === 'fresh') expect(result.plan?.candidates.map((row) => row.workerId)).toEqual(['codex-a', 'codex-b']);
      else {
        expect(result.plan?.selectedWorkerId).toBeNull(); expect(result.plan?.candidates).toEqual([]);
        for (const id of ['codex-a', 'codex-b']) expect(result.plan?.exclusions.find((row) => row.workerId === id)?.reasons).toContain('worker-unavailable');
      }
      expect(existsSync(root)).toBe(false); expect(readdirSync(temporary)).toEqual(['observations.json']);
      expect(readFileSync(observationsFile)).toEqual(original); expect(statSync(observationsFile).mtimeMs).toBe(stat.mtimeMs);
      expect(JSON.stringify(result)).not.toContain('this-command-must-never-execute');
    } finally { await reader.close(); rmSync(temporary, { recursive: true, force: true }); }
  }

  it.each(['fresh', 'missing-alias', 'explicit-veto', 'expired', 'future-update', 'unknown'] as const)(
    'preserves source bytes and applies %s managed evidence after IPC', runCase);
});

describe('actual bounded resource read worker with private temporary evidence', () => {
  it('rereads one private file without creating an absent ledger or dispatching the configured local worker', async () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-console-read-'))); chmodSync(temporary, 0o700);
    const root = join(temporary, 'absent-ledger'); const observationsFile = join(temporary, 'observations.json');
    writeFileSync(observationsFile, '[]', { mode: 0o600 });
    const reader = createResourceConsoleReader({ ...scope, root, observationsFile });
    try {
      const first = await reader.snapshot();
      expect(first).toMatchObject({ sourceState: 'missing', counts: { total: 0 }, plan: { selectedWorkerId: null } });
      const now = Date.now();
      const observation = { workerId: 'local', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
        health: 'ready', retryAfter: null, windows: [] };
      writeFileSync(observationsFile, JSON.stringify([observation]));
      const before = statSync(observationsFile);
      const second = await reader.snapshot();
      expect(second).toMatchObject({ sourceState: 'missing', observations: [observation], plan: { selectedWorkerId: 'local' } });
      expect(statSync(observationsFile).mtimeMs).toBe(before.mtimeMs);
      expect(existsSync(root)).toBe(false); expect(readdirSync(temporary)).toEqual(['observations.json']);
      expect(fixture.run).not.toHaveBeenCalled();
    } finally { await reader.close(); rmSync(temporary, { recursive: true, force: true }); }
  });

  it('preserves corrupt ledger bytes and fails unavailable for unsafe observation aliases', async () => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-console-corrupt-'))); chmodSync(temporary, 0o700);
    const root = join(temporary, 'ledger'); mkdirSync(root, { mode: 0o700 });
    const ledger = join(root, 'pool-state.json'); writeFileSync(ledger, '{"private":"malformed ledger"}', { mode: 0o600 });
    const observationsFile = join(temporary, 'observations.json'); writeFileSync(observationsFile, '[]', { mode: 0o600 });
    const reader = createResourceConsoleReader({ ...scope, root, observationsFile });
    const alias = join(temporary, 'observations-alias.json'); symlinkSync(observationsFile, alias);
    const aliasReader = createResourceConsoleReader({ ...scope, root: join(temporary, 'other-absent'), observationsFile: alias });
    try {
      const before = readFileSync(ledger, 'utf8');
      const result = await reader.snapshot();
      expect(result).toMatchObject({ sourceState: 'degraded', counts: { total: null }, usage: { reportedAttempts: null } });
      expect(JSON.stringify(result)).not.toContain('malformed ledger'); expect(readFileSync(ledger, 'utf8')).toBe(before);
      expect((await aliasReader.snapshot()).sourceState).toBe('degraded'); expect(existsSync(join(temporary, 'other-absent'))).toBe(false);
    } finally { await Promise.all([reader.close(), aliasReader.close()]); rmSync(temporary, { recursive: true, force: true }); }
  });
});

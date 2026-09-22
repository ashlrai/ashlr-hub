/** Real private durable queue/lease with inert engineering owner callbacks. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConsoleEngineeringSupervisor, validateResourceConsoleEngineeringSupervisionConfig,
  type ResourceConsoleEngineeringSupervisionConfig } from '../src/core/resources/console-engineering-supervisor.js';
import type { ResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import type { ResourceConsoleEngineeringEnrollment, ResourceConsoleEngineeringJob, ResourceConsoleEngineeringReadiness } from '../src/core/resources/console-engineering-types.js';

const hash = 'a'.repeat(64);
const request = (ids: string[], expectedRevision = 0) => ({ expectedRevision,
  enrollments: ids.map(enrollmentId => ({ enrollmentId, expectedEnrollmentDigest: hash })) });
const config = (): ResourceConsoleEngineeringSupervisionConfig => ({ schemaVersion: 1, id: 'queue', maxDurationMs: 60_000,
  pollIntervalMs: 100, maxConcurrent: 1, maxAttemptsPerEnrollment: 3, maxEnrollments: 3, enrollments: [] });
let root: string;
const opened: Array<ReturnType<typeof createResourceConsoleEngineeringSupervisor>> = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-admission-'))); vi.useFakeTimers(); });
afterEach(async () => {
  for (const supervisor of opened.splice(0).reverse()) await supervisor.close().catch(() => {});
  vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});
const path = () => join(root, 'engineering-supervision', 'queue', 'state.json');
const saved = () => readFileSync(path(), 'utf8');
const durable = () => JSON.parse(saved());
const ticks = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
function fixture() {
  const catalog: ResourceConsoleEngineeringEnrollment[] = [];
  const jobs = new Map<string, ResourceConsoleEngineeringJob>();
  const add = (id: string) => {
    catalog.push({ id, projectId: 'default', graphId: `graph-${id}`, enrollmentDigest: hash, objective: 'Fixture', campaigns: [],
      budget: { maxDurationMs: 60_000, maxParallel: 1 }, acceptanceScope: 'fixed-evaluator-and-local-branch-only' });
    jobs.set(id, { enrollmentId: id, projectId: 'default', graphId: `graph-${id}`, enrollmentDigest: hash, state: 'ready', sourceState: 'missing',
      cancellable: false, launched: false, cancelled: false, definitionDigest: null, deadlineAt: null, nodes: [], reasons: [],
      acceptanceScope: 'fixed-evaluator-and-local-branch-only' });
  };
  ['one', 'two', 'three', 'four'].forEach(add);
  const owner = {
    catalog: vi.fn(() => structuredClone(catalog)), snapshot: vi.fn((id: string) => structuredClone(jobs.get(id)!)),
    readiness: vi.fn((id: string): ResourceConsoleEngineeringReadiness => ({ schemaVersion: 1, enrollmentId: id, enrollmentDigest: hash,
      sampledAt: new Date().toISOString(), status: 'ready', action: 'launch', reasons: [], scope: 'local-admission-check-only', effectsExecuted: false, providerContacted: false })),
    evidenceFingerprint: vi.fn(() => 'b'.repeat(64)),
    launch: vi.fn<ResourceConsoleEngineeringOwner['launch']>(input => {
      const job = jobs.get(input.enrollmentId)!; job.state = 'completed'; job.sourceState = 'healthy'; job.launched = true; return structuredClone(job);
    }), awaitSettlement: vi.fn(async (_id: string) => {}),
  };
  const create = (value = config(), signal?: AbortSignal) => {
    const supervisor = createResourceConsoleEngineeringSupervisor({ root, owner: owner as unknown as ResourceConsoleEngineeringOwner, config: value, signal });
    opened.push(supervisor); return supervisor;
  };
  return { owner, jobs, catalog, add, create };
}

describe('opt-in admission to the existing bounded engineering supervisor', () => {
  it('retains exact legacy config and fixed queue behavior', async () => {
    const { maxEnrollments: _cap, ...legacy } = config(); legacy.enrollments = request(['one']).enrollments;
    expect(validateResourceConsoleEngineeringSupervisionConfig(legacy)).toEqual(legacy);
    const f = fixture(); const supervisor = f.create(legacy);
    expect(supervisor.snapshot()).not.toHaveProperty('admission'); const before = saved();
    expect(() => supervisor.admit(request(['two']))).toThrow('not enabled'); expect(saved()).toBe(before);
    supervisor.start(); await ticks(); expect(supervisor.snapshot().state).toBe('completed');
  });
  it.each([0, 33, -1, 1.5, '3', null])('rejects invalid enrollment cap %j', maxEnrollments => {
    expect(() => validateResourceConsoleEngineeringSupervisionConfig({ ...config(), maxEnrollments })).toThrow();
  });
  it('requires explicit capacity for empty queues and automatic preparation admission', () => {
    const { maxEnrollments: _cap, ...legacy } = config();
    expect(() => validateResourceConsoleEngineeringSupervisionConfig(legacy)).toThrow();
    expect(() => validateResourceConsoleEngineeringSupervisionConfig({ ...legacy, enrollments: request(['one']).enrollments, autoAdmitPrepared: true })).toThrow();
    expect(() => validateResourceConsoleEngineeringSupervisionConfig({ ...config(), maxEnrollments: 1, enrollments: request(['one', 'two']).enrollments })).toThrow();
    for (const autoAdmitPrepared of [false, null, 1]) expect(() => validateResourceConsoleEngineeringSupervisionConfig({ ...config(), autoAdmitPrepared })).toThrow();
    const f = fixture(); expect(f.create({ ...config(), autoAdmitPrepared: true }).snapshot().admission).toEqual({ maxEnrollments: 3, remainingEnrollments: 3, autoAdmitPrepared: true });
  });
  it.each([null, undefined])('normalizes malformed %j configuration without file effects', value => {
    expect(() => validateResourceConsoleEngineeringSupervisionConfig(value)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('waits without polling or writing when empty, then wakes after durable admission', async () => {
    const f = fixture(); const supervisor = f.create(); const original = supervisor.snapshot();
    expect(original.state).toBe('idle'); expect(original.admission).toEqual({ maxEnrollments: 3, remainingEnrollments: 3, autoAdmitPrepared: false });
    supervisor.start(); const before = saved(); await ticks(1000);
    expect(saved()).toBe(before); expect(f.owner.snapshot).not.toHaveBeenCalled(); expect(f.owner.launch).not.toHaveBeenCalled();
    f.owner.launch.mockImplementation(input => {
      expect(durable().entries[0]).toMatchObject({ enrollmentId: 'one', enrollmentDigest: hash, attempts: 1 });
      expect(durable().revision).toBe(1); f.jobs.get(input.enrollmentId)!.state = 'completed'; return f.jobs.get(input.enrollmentId)!;
    });
    expect(supervisor.admit(request(['one']))).toMatchObject({ revision: 1, deadlineAt: original.deadlineAt, configDigest: original.configDigest });
    await ticks(); expect(f.owner.launch).toHaveBeenCalledTimes(1); expect(supervisor.snapshot().state).toBe('running');
    const calls = f.owner.snapshot.mock.calls.length; const complete = saved(); await ticks(1000);
    expect(f.owner.snapshot).toHaveBeenCalledTimes(calls); expect(saved()).toBe(complete);
    supervisor.admit(request(['two'], 1)); await ticks(); expect(f.owner.launch).toHaveBeenCalledTimes(2);
  });
  it('does not start execution merely by admitting before start', async () => {
    const f = fixture(); const supervisor = f.create(); const result = supervisor.admit(request(['one', 'two']));
    expect(result).toMatchObject({ state: 'idle', revision: 1, admission: { remainingEnrollments: 1 }, entries: [{ attempts: 0 }, { attempts: 0 }] });
    await ticks(1000); expect(f.owner.launch).not.toHaveBeenCalled();
  });
  it('allows paused admission and shares a single revision with pause controls', async () => {
    const f = fixture(); const supervisor = f.create(); supervisor.start(); supervisor.setPaused(true, 0);
    const admitted = supervisor.admit(request(['one'], 1)); expect(admitted).toMatchObject({ paused: true, revision: 2 });
    await ticks(500); expect(f.owner.launch).not.toHaveBeenCalled();
    expect(() => supervisor.setPaused(false, 1)).toThrow('revision');
    supervisor.setPaused(false, 2); await ticks(); expect(f.owner.launch).toHaveBeenCalledTimes(1);
  });
  it('permits only all-existing exact stale retries, with no writes or wake', async () => {
    const f = fixture(); const supervisor = f.create(); supervisor.admit(request(['one'])); supervisor.setPaused(true, 1);
    const before = saved(); expect(supervisor.admit(request(['one'], 0))).toMatchObject({ revision: 2, paused: true });
    expect(saved()).toBe(before); expect(f.owner.launch).not.toHaveBeenCalled();
    expect(() => supervisor.admit(request(['one', 'two'], 0))).toThrow('revision'); expect(saved()).toBe(before);
    expect(() => supervisor.admit(request(['one'], 3))).toThrow('revision'); expect(saved()).toBe(before);
  });
  it('rejects unknown/conflicting/batch-duplicate identities atomically and preserves slots', () => {
    const f = fixture(); const supervisor = f.create(); const before = saved();
    expect(() => supervisor.admit(request(['one', 'unknown']))).toThrow('enrollment changed');
    expect(() => supervisor.admit(request(['one', 'one']))).toThrow('Invalid');
    const changed = request(['one']); changed.enrollments[0]!.expectedEnrollmentDigest = 'c'.repeat(64);
    expect(() => supervisor.admit(changed)).toThrow('enrollment changed'); expect(saved()).toBe(before);
    supervisor.admit(request(['one'])); f.catalog[0]!.enrollmentDigest = 'c'.repeat(64);
    const admitted = saved(); expect(() => supervisor.admit(changed)).toThrow('enrollment changed'); expect(saved()).toBe(admitted);
  });
  it('rejects cap exhaustion without changing old entries or budgets', () => {
    const f = fixture(); const supervisor = f.create({ ...config(), maxEnrollments: 1 }); supervisor.admit(request(['one']));
    const before = saved(); expect(() => supervisor.admit(request(['two'], 1))).toThrow('capacity'); expect(saved()).toBe(before);
    expect(supervisor.snapshot().admission?.remainingEnrollments).toBe(0);
  });
  it('refuses ambiguous host catalog identity instead of choosing a matching duplicate', () => {
    const f = fixture(); const supervisor = f.create(); const before = saved();
    f.catalog.push({ ...f.catalog[0]!, enrollmentDigest: 'c'.repeat(64) });
    expect(() => supervisor.admit(request(['one']))).toThrow('enrollment changed'); expect(saved()).toBe(before);
  });
  it.each(['removed-replay', 'drifted-replay', 'removed-new', 'drifted-new'])('requires current durable evidence on %s', mode => {
    const f = fixture(); const supervisor = f.create(); supervisor.admit(request(['one']));
    if (mode.startsWith('removed')) unlinkSync(path());
    else { const changed = durable(); changed.revision++; writeFileSync(path(), JSON.stringify(changed), { mode: 0o600 }); }
    const next = mode.endsWith('replay') ? request(['one'], 0) : request(['two'], 1);
    expect(() => supervisor.admit(next)).toThrow('state unavailable'); expect(f.owner.launch).not.toHaveBeenCalled();
    expect(supervisor.snapshot().sourceState).toBe('degraded');
  });
  it('captures request data and rejects accessors/symbol/extra/malformed values', () => {
    const f = fixture(); const supervisor = f.create(); const getter = vi.fn(() => request(['one']).enrollments);
    expect(() => supervisor.admit({ expectedRevision: 0, get enrollments() { return getter(); } })).toThrow(); expect(getter).not.toHaveBeenCalled();
    for (const input of [null, {}, { ...request(['one']), extra: true }, { ...request(['one']), [Symbol('extra')]: true },
      request([]), request(['one'], -1), { ...request(['one']), expectedRevision: 0.5 }]) expect(() => supervisor.admit(input)).toThrow();
    const input = request(['one']); supervisor.admit(input); input.enrollments[0]!.enrollmentId = 'other';
    expect(supervisor.snapshot().entries[0]?.enrollmentId).toBe('one');
  });
  it('restores admitted rows, pauses, attempt budgets and original deadline without writes', async () => {
    const f = fixture(); const first = f.create({ ...config(), enrollments: request(['one']).enrollments });
    first.admit(request(['two'])); first.start(); await ticks(); first.setPaused(true, 1);
    const state = durable(); await first.close(); await ticks(1000); const before = saved();
    const second = f.create({ ...config(), enrollments: request(['one']).enrollments });
    expect(saved()).toBe(before); expect(second.snapshot()).toMatchObject({ paused: true, revision: 2, deadlineAt: state.deadlineAt,
      entries: [{ enrollmentId: 'one', attempts: 1 }, { enrollmentId: 'two', attempts: 1 }] });
    second.start(); await ticks(500); expect(f.owner.launch).toHaveBeenCalledTimes(2);
  });
  it.each(['missing-host', 'changed-host', 'prefix', 'duplicate', 'beyond-cap'])('refuses invalid admitted restart state: %s', async mode => {
    const f = fixture(); const value = { ...config(), enrollments: request(['one']).enrollments }; const first = f.create(value);
    first.admit(request(['two'])); await first.close(); const state = durable();
    if (mode === 'missing-host') f.catalog.splice(1, 1);
    if (mode === 'changed-host') f.catalog[1]!.enrollmentDigest = 'c'.repeat(64);
    if (mode === 'prefix') state.entries.reverse();
    if (mode === 'duplicate') state.entries.push(state.entries[1]);
    if (mode === 'beyond-cap') state.entries.push({ ...state.entries[1], enrollmentId: 'three' }, { ...state.entries[1], enrollmentId: 'four' });
    writeFileSync(path(), JSON.stringify(state), { mode: 0o600 }); const before = saved();
    expect(() => f.create(value)).toThrow(); expect(saved()).toBe(before);
  });
  it('does not renew deadline on admission or permit new work after expiry', async () => {
    const f = fixture(); const supervisor = f.create({ ...config(), maxDurationMs: 100 }); supervisor.admit(request(['one']));
    const original = supervisor.snapshot().deadlineAt; await ticks(200); const before = saved();
    expect(() => supervisor.admit(request(['two'], 1))).toThrow('deadline'); expect(saved()).toBe(before);
    expect(supervisor.admit(request(['one'], 0))).toMatchObject({ state: 'timed-out', deadlineAt: original }); expect(saved()).toBe(before);
    supervisor.start(); await ticks(); expect(f.owner.launch).not.toHaveBeenCalled();
  });
  it('preserves in-flight attempts while adding rows and obeys existing concurrency', async () => {
    const f = fixture(); const supervisor = f.create(); let release!: () => void;
    f.owner.launch.mockImplementation(input => { const job = f.jobs.get(input.enrollmentId)!; job.state = 'running'; return job; });
    f.owner.awaitSettlement.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); f.jobs.get('one')!.state = 'completed'; });
    supervisor.admit(request(['one'])); supervisor.start(); await ticks(); supervisor.admit(request(['two'], 1)); await ticks(500);
    expect(f.owner.launch).toHaveBeenCalledTimes(1); expect(durable().entries).toMatchObject([{ attempts: 1 }, { attempts: 0 }]);
    f.owner.launch.mockImplementation(input => { const job = f.jobs.get(input.enrollmentId)!; job.state = 'completed'; return job; });
    release(); await ticks(); expect(f.owner.launch).toHaveBeenCalledTimes(2); expect(durable().entries).toMatchObject([{ attempts: 1 }, { attempts: 1 }]);
  });
  it('refuses admission after close or ownership loss without changing durable rows', async () => {
    const f = fixture(); const supervisor = f.create(); const before = saved(); await supervisor.close();
    expect(() => supervisor.admit(request(['one']))).toThrow('unavailable'); expect(saved()).toBe(before);
    const restarted = f.create(); unlinkSync(join(root, 'engineering-supervision', 'queue', '.execution.lock'));
    expect(() => restarted.admit(request(['one']))).toThrow('ownership'); expect(saved()).toBe(before);
  });
});

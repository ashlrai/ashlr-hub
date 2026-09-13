/** Inert owner callbacks with real private supervision state and leases. No provider execution. */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConsoleEngineeringSupervisor, validateResourceConsoleEngineeringSupervisionConfig } from '../src/core/resources/console-engineering-supervisor.js';
import type { ResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import type { ResourceConsoleEngineeringEnrollment, ResourceConsoleEngineeringJob, ResourceConsoleEngineeringReadiness } from '../src/core/resources/console-engineering-types.js';
import type { ResourceConsoleEngineeringSupervisionConfig } from '../src/core/resources/console-engineering-supervisor-types.js';

const hash = 'a'.repeat(64);
const config = (): ResourceConsoleEngineeringSupervisionConfig => ({ schemaVersion: 1, id: 'boundary-queue',
  maxDurationMs: 60_000, pollIntervalMs: 100, maxConcurrent: 1, maxAttemptsPerEnrollment: 3,
  enrollments: [{ enrollmentId: 'first', expectedEnrollmentDigest: hash }] });
function fixture() {
  const enrollment: ResourceConsoleEngineeringEnrollment = { id: 'first', projectId: 'default', graphId: 'first-graph',
    enrollmentDigest: hash, objective: 'Inert boundary fixture', campaigns: [], budget: { maxParallel: 1, maxDurationMs: 60_000 },
    acceptanceScope: 'fixed-evaluator-and-local-branch-only' };
  const current: { job: ResourceConsoleEngineeringJob; readiness: ResourceConsoleEngineeringReadiness; fingerprint: string | null } = {
    job: { enrollmentId: 'first', projectId: 'default', graphId: 'first-graph', enrollmentDigest: hash,
      state: 'ready', sourceState: 'missing', cancellable: false, launched: false, cancelled: false,
      definitionDigest: null, deadlineAt: null, nodes: [], reasons: [], acceptanceScope: 'fixed-evaluator-and-local-branch-only' },
    readiness: { schemaVersion: 1, enrollmentId: 'first', enrollmentDigest: hash, sampledAt: new Date().toISOString(),
      status: 'ready', action: 'launch', reasons: [], scope: 'local-admission-check-only', effectsExecuted: false, providerContacted: false },
    fingerprint: 'b'.repeat(64),
  };
  const owner = {
    checkRegistration: vi.fn(() => { throw new Error('Registration is outside this fixture'); }),
    register: vi.fn(() => { throw new Error('Registration is outside this fixture'); }),
    outcomes: vi.fn(() => { throw new Error('Outcomes are outside this fixture'); }),
    catalog: vi.fn(() => [structuredClone(enrollment)]), snapshot: vi.fn(() => structuredClone(current.job)),
    readiness: vi.fn(() => structuredClone(current.readiness)), evidenceFingerprint: vi.fn(() => current.fingerprint),
    launch: vi.fn<ResourceConsoleEngineeringOwner['launch']>(() => structuredClone(current.job)),
    awaitSettlement: vi.fn(async () => {}), cancel: vi.fn(() => structuredClone(current.job)), close: vi.fn(async () => {}),
  } satisfies ResourceConsoleEngineeringOwner;
  return { owner, current };
}
let root: string;
const supervisors: Array<ReturnType<typeof createResourceConsoleEngineeringSupervisor>> = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-supervision-boundaries-'))); });
afterEach(async () => {
  for (const supervisor of supervisors.splice(0).reverse()) await supervisor.close().catch(() => {});
  vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});
function create(owner: ResourceConsoleEngineeringOwner, value = config()) {
  const supervisor = createResourceConsoleEngineeringSupervisor({ owner, root, config: value });
  supervisors.push(supervisor); return supervisor;
}
const stateFile = () => join(root, 'engineering-supervision', 'boundary-queue', 'state.json');
async function ticks(ms = 350) { await vi.advanceTimersByTimeAsync(ms); }

describe('finite engineering supervision boundaries', () => {
  it('checks the dispatch veto without projecting owner evidence and preserves pause and shutdown', async () => {
    vi.useFakeTimers(); const { owner } = fixture(); const supervisor = create(owner);
    expect(supervisor.isExecutionStopped()).toBe(true);
    supervisor.start(); await ticks();
    owner.snapshot.mockClear(); owner.readiness.mockClear(); owner.evidenceFingerprint.mockClear();
    const saved = readFileSync(stateFile(), 'utf8');
    expect(supervisor.isExecutionStopped()).toBe(false);
    expect(supervisor.isExecutionStopped()).toBe(false);
    expect(owner.snapshot).not.toHaveBeenCalled(); expect(owner.readiness).not.toHaveBeenCalled();
    expect(owner.evidenceFingerprint).not.toHaveBeenCalled(); expect(readFileSync(stateFile(), 'utf8')).toBe(saved);
    const revision = supervisor.snapshot().revision;
    supervisor.setPaused(true, revision); expect(supervisor.isExecutionStopped()).toBe(true);
    supervisor.setPaused(false, revision + 1); expect(supervisor.isExecutionStopped()).toBe(false);
    await supervisor.close(); expect(supervisor.isExecutionStopped()).toBe(true);
  });
  it('vetoes dispatch when persisted supervision state changes without reading the owner', async () => {
    vi.useFakeTimers(); const { owner } = fixture(); const supervisor = create(owner);
    supervisor.start(); await ticks(); owner.snapshot.mockClear(); owner.readiness.mockClear(); owner.evidenceFingerprint.mockClear();
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    writeFileSync(stateFile(), JSON.stringify({ ...state, revision: state.revision + 1 }), { mode: 0o600 });
    expect(supervisor.isExecutionStopped()).toBe(true);
    expect(owner.snapshot).not.toHaveBeenCalled(); expect(owner.readiness).not.toHaveBeenCalled();
    expect(owner.evidenceFingerprint).not.toHaveBeenCalled();
  });
  it.each([
    { schemaVersion: 2 }, { id: '../outside' }, { maxDurationMs: Infinity }, { maxDurationMs: 0 },
    { pollIntervalMs: 0 }, { maxConcurrent: 0 }, { maxAttemptsPerEnrollment: 0 }, { unexpected: true },
    { enrollments: [] }, { enrollments: [{ enrollmentId: 'first', expectedEnrollmentDigest: 'bad' }] },
    { enrollments: [config().enrollments[0], config().enrollments[0]] },
  ])('rejects malformed finite configuration %#', (change) => {
    expect(() => validateResourceConsoleEngineeringSupervisionConfig({ ...config(), ...change })).toThrow();
  });
  it('does not invoke getters while validating configuration', () => {
    const getter = vi.fn(() => 60_000); const value = config();
    Object.defineProperty(value, 'maxDurationMs', { enumerable: true, get: getter });
    expect(() => validateResourceConsoleEngineeringSupervisionConfig(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['missing', 'changed'])('refuses %s catalog enrollment identity before any invocation', (mode) => {
    const { owner } = fixture();
    if (mode === 'missing') owner.catalog.mockReturnValue([]);
    else owner.catalog.mockReturnValue([{ ...owner.catalog()[0], enrollmentDigest: 'e'.repeat(64) }]);
    expect(() => create(owner)).toThrow(); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('construction and repeated inspection do not invoke the owner or rewrite state', async () => {
    const { owner } = fixture(); const supervisor = create(owner); const saved = readFileSync(stateFile(), 'utf8');
    for (let i = 0; i < 3; i++) expect(supervisor.snapshot().state).toBe('idle');
    expect(readFileSync(stateFile(), 'utf8')).toBe(saved); expect(owner.launch).not.toHaveBeenCalled();
    await supervisor.close(); expect(owner.close).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled();
  });
  it('excludes a second live instance and preserves the first owner', () => {
    const { owner } = fixture(); const supervisor = create(owner); const saved = readFileSync(stateFile(), 'utf8');
    expect(() => create(owner)).toThrow(); expect(readFileSync(stateFile(), 'utf8')).toBe(saved);
    expect(supervisor.snapshot().sourceState).toBe('healthy'); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('refuses changed durable configuration on restart without replacing the original state', async () => {
    const { owner } = fixture(); const supervisor = create(owner); await supervisor.close();
    const saved = readFileSync(stateFile(), 'utf8');
    expect(() => create(owner, { ...config(), maxAttemptsPerEnrollment: 4 })).toThrow();
    expect(readFileSync(stateFile(), 'utf8')).toBe(saved); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('uses exact pause revisions without granting dispatch through inspection or stale controls', () => {
    const { owner } = fixture(); const supervisor = create(owner); const initial = supervisor.snapshot();
    const paused = supervisor.setPaused(true, initial.revision); expect(paused.paused).toBe(true);
    expect(paused.revision).toBe(initial.revision + 1);
    expect(() => supervisor.setPaused(false, initial.revision)).toThrow(); expect(supervisor.snapshot().paused).toBe(true);
    expect(supervisor.setPaused(false, paused.revision).paused).toBe(false); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('retains the original deadline across a closed-owner restart', async () => {
    vi.useFakeTimers(); const { owner } = fixture(); const first = create(owner); const original = first.snapshot().deadlineAt;
    await first.close(); await ticks(120_000); const second = create(owner);
    expect(second.snapshot().deadlineAt).toBe(original); second.start(); await ticks();
    expect(second.snapshot().state).toBe('timed-out'); expect(owner.launch).not.toHaveBeenCalled();
  });
  it.each(['undefined', 'unknown', 'unavailable', 'wrong-identity', 'wrong-id', 'wrong-readiness-id', 'null-fingerprint'])('does not dispatch from %s owner evidence', async (mode) => {
    vi.useFakeTimers(); const { owner, current } = fixture();
    if (mode === 'undefined') owner.snapshot.mockReturnValue(undefined as unknown as ResourceConsoleEngineeringJob);
    if (mode === 'unknown') current.job.state = 'unknown' as ResourceConsoleEngineeringJob['state'];
    if (mode === 'unavailable') { current.job.state = 'unavailable'; current.job.sourceState = 'degraded'; }
    if (mode === 'wrong-identity') current.job.enrollmentDigest = 'c'.repeat(64);
    if (mode === 'wrong-id') current.job.enrollmentId = 'foreign';
    if (mode === 'wrong-readiness-id') current.readiness.enrollmentId = 'foreign';
    if (mode === 'null-fingerprint') current.fingerprint = null;
    const supervisor = create(owner); supervisor.start(); await ticks(); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('reserves a bounded attempt before entering the owner and suppresses unchanged unresolved evidence', async () => {
    vi.useFakeTimers(); const { owner, current } = fixture();
    current.job = { ...current.job, state: 'incomplete', sourceState: 'healthy', launched: true,
      definitionDigest: 'd'.repeat(64), nodes: [{ id: 'deliver', kind: 'deliver', state: 'unresolved', artifactDigest: null }] };
    current.readiness.action = 'reconcile'; const supervisor = create(owner);
    owner.launch.mockImplementation(() => {
      expect(supervisor.snapshot().entries[0].attempts).toBe(1);
      expect(readFileSync(stateFile(), 'utf8')).toContain('"attempts":1');
      return structuredClone(current.job);
    });
    supervisor.start(); await ticks(1000); expect(owner.launch).toHaveBeenCalledTimes(1);
    expect(owner.awaitSettlement).toHaveBeenCalledTimes(1); expect(supervisor.snapshot().entries[0].attempts).toBe(1);
    await supervisor.close(); const restarted = create(owner); restarted.start(); await ticks(500);
    expect(owner.launch).toHaveBeenCalledTimes(1); expect(restarted.snapshot().entries[0].attempts).toBe(1);
  });
  it('does not close or cancel an unrelated already-running owner invocation', async () => {
    vi.useFakeTimers(); const { owner, current } = fixture(); current.job.state = 'running'; current.job.launched = true;
    current.readiness = { ...current.readiness, status: 'not-applicable', action: 'none', reasons: ['already-running'] };
    const supervisor = create(owner); supervisor.start(); await ticks(); await supervisor.close();
    expect(owner.launch).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled(); expect(owner.close).not.toHaveBeenCalled();
  });
  it('pause preserves an active call, while close aborts and awaits only that call', async () => {
    vi.useFakeTimers(); const { owner, current } = fixture(); let finish!: () => void;
    const settlement = new Promise<void>((resolve) => { finish = resolve; });
    owner.awaitSettlement.mockImplementation(() => settlement);
    owner.launch.mockImplementation((_input, controls) => {
      expect(controls?.signal).toBeDefined(); expect(controls?.isExecutionStopped?.()).toBe(false);
      current.job.state = 'running'; return structuredClone(current.job);
    });
    const supervisor = create(owner); supervisor.start(); await ticks(); expect(owner.launch).toHaveBeenCalledTimes(1);
    const controls = owner.launch.mock.calls[0][1]!; supervisor.setPaused(true, supervisor.snapshot().revision);
    await ticks(); expect(controls.signal?.aborted).toBe(false); expect(controls.isExecutionStopped?.()).toBe(false);
    let drained = false; const closing = supervisor.close().then(() => { drained = true; });
    await Promise.resolve(); expect(controls.signal?.aborted).toBe(true); expect(controls.isExecutionStopped?.()).toBe(true);
    expect(drained).toBe(false); finish(); await closing; expect(drained).toBe(true);
    expect(owner.close).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled();
  });
  it('retains a failed invocation attempt instead of retrying unchanged uncertainty', async () => {
    vi.useFakeTimers(); const { owner } = fixture(); owner.launch.mockImplementation(() => { throw new Error('fixture ambiguous call'); });
    const supervisor = create(owner); supervisor.start(); await ticks(1000);
    expect(owner.launch).toHaveBeenCalledTimes(1); expect(supervisor.snapshot().entries[0].attempts).toBe(1);
    await supervisor.close(); const restarted = create(owner); restarted.start(); await ticks(500);
    expect(owner.launch).toHaveBeenCalledTimes(1); expect(restarted.snapshot().entries[0].attempts).toBe(1);
  });
  it('awaits possible partial acceptance even when launch throws before returning a job', async () => {
    vi.useFakeTimers(); const { owner } = fixture(); let finish!: () => void;
    const settlement = new Promise<void>((resolve) => { finish = resolve; });
    owner.awaitSettlement.mockImplementation(() => settlement);
    owner.launch.mockImplementation(() => { throw new Error('fixture accepted, response unavailable'); });
    const supervisor = create(owner); supervisor.start(); await ticks();
    expect(owner.awaitSettlement).toHaveBeenCalledTimes(1);
    let drained = false; const closing = supervisor.close().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); finish(); await closing;
    expect(owner.launch).toHaveBeenCalledTimes(1); expect(owner.close).not.toHaveBeenCalled();
  });
  it('does not await a manual same-ID call when stopped before its own launch microtask', async () => {
    vi.useFakeTimers(); const { owner, current } = fixture(); let finish!: () => void;
    const externalSettlement = new Promise<void>((resolve) => { finish = resolve; });
    owner.awaitSettlement.mockImplementation(() => externalSettlement);
    owner.launch.mockImplementation(() => { current.job.state = 'running'; return structuredClone(current.job); });
    const supervisor = create(owner); supervisor.start();
    // A manual call is permitted by the retained owner, independently of this queue.
    owner.launch({ enrollmentId: 'first', expectedEnrollmentDigest: hash });
    const closing = supervisor.close(); await ticks(1);
    const awaitedExternalCall = owner.awaitSettlement.mock.calls.length;
    finish(); await closing;
    expect(owner.launch).toHaveBeenCalledTimes(1); expect(awaitedExternalCall).toBe(0);
    expect(owner.cancel).not.toHaveBeenCalled(); expect(owner.close).not.toHaveBeenCalled();
  });
  it('suppresses the new intent written by its own completed invocation as unchanged evidence', async () => {
    vi.useFakeTimers(); const { owner, current } = fixture();
    owner.launch.mockImplementation(() => {
      current.fingerprint = 'f'.repeat(64); current.job.state = 'incomplete'; current.job.sourceState = 'healthy';
      current.job.launched = true; current.job.nodes = [{ id: 'deliver', kind: 'deliver', state: 'unresolved', artifactDigest: null }];
      current.readiness.action = 'reconcile'; return structuredClone(current.job);
    });
    const supervisor = create(owner); supervisor.start(); await ticks(1000);
    expect(owner.launch).toHaveBeenCalledTimes(1); expect(supervisor.snapshot().entries[0].attempts).toBe(1);
  });
  it('never replenishes the attempt cap even when durable evidence changes', async () => {
    vi.useFakeTimers(); const { owner, current } = fixture(); const supervisor = create(owner, { ...config(), maxAttemptsPerEnrollment: 2 });
    supervisor.start(); await ticks(); expect(owner.launch).toHaveBeenCalledTimes(1);
    current.fingerprint = 'c'.repeat(64); await ticks(); expect(owner.launch).toHaveBeenCalledTimes(2);
    current.fingerprint = 'd'.repeat(64); await ticks(); expect(owner.launch).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot().entries[0]).toMatchObject({ attempts: 2, state: 'held', reasons: ['attempt-limit'] });
    await supervisor.close(); const restarted = create(owner, { ...config(), maxAttemptsPerEnrollment: 2 }); restarted.start(); await ticks();
    expect(owner.launch).toHaveBeenCalledTimes(2); expect(restarted.snapshot().entries[0].attempts).toBe(2);
  });
  it('retains pause across restart and requires explicit start after unpausing', async () => {
    vi.useFakeTimers(); const { owner } = fixture(); const first = create(owner);
    first.setPaused(true, first.snapshot().revision); await first.close(); const second = create(owner);
    expect(second.snapshot().paused).toBe(true); second.setPaused(false, second.snapshot().revision); await ticks();
    expect(owner.launch).not.toHaveBeenCalled(); second.start(); await ticks(); expect(owner.launch).toHaveBeenCalledTimes(1);
  });
});

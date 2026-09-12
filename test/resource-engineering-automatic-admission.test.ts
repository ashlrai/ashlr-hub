/** Pure owner mocks: no HTTP, subprocess, provider, or private store creation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceEngineeringAutomaticAdmission } from '../src/core/resources/engineering-automatic-admission.js';
import { ResourceEngineeringAutomaticAdmissionOwnershipError } from '../src/core/resources/console-engineering-preparation.js';
import { ResourceSupervisorError } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleEngineeringSupervisor } from '../src/core/resources/console-engineering-supervisor.js';
import type { ResourceConsoleEngineeringPreparationOwner } from '../src/core/resources/console-engineering-preparation.js';
import type { ResourceEngineeringAutomaticAdmissionCandidate } from '../src/core/resources/engineering-preparation-registry.js';

const binding = { schemaVersion: 1 as const, supervisionId: 'original', configDigest: 'a'.repeat(64), deadlineAt: '2026-09-12T12:01:00.000Z' };
const row = (id: string): ResourceEngineeringAutomaticAdmissionCandidate => ({ enrollmentId: id, expectedEnrollmentDigest: 'b'.repeat(64), reason: null });
const owners: Array<ReturnType<typeof createResourceEngineeringAutomaticAdmission>> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T12:00:00.000Z')); });
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); vi.useRealTimers(); });
function fixture() {
  const state = { schemaVersion: 1, configId: binding.supervisionId, configDigest: binding.configDigest, deadlineAt: binding.deadlineAt,
    sourceState: 'healthy', state: 'paused', paused: true, revision: 7,
    admission: { autoAdmitPrepared: true, maxEnrollments: 4, remainingEnrollments: 4 },
    entries: [] as Array<{ enrollmentId: string; enrollmentDigest: string; attempts: number }> };
  let rows = [row('first')]; let closing = false;
  const snapshot = vi.fn(() => structuredClone(state) as unknown as ReturnType<ResourceConsoleEngineeringSupervisor['snapshot']>);
  const admit = vi.fn((input: unknown) => {
    const request = input as { expectedRevision: number; enrollments: Array<{ enrollmentId: string; expectedEnrollmentDigest: string }> };
    expect(request.expectedRevision).toBe(state.revision);
    for (const entry of request.enrollments) if (!state.entries.some(value => value.enrollmentId === entry.enrollmentId)) {
      state.entries.push({ enrollmentId: entry.enrollmentId, enrollmentDigest: entry.expectedEnrollmentDigest, attempts: 0 });
      state.revision++; state.admission.remainingEnrollments--;
    }
    return snapshot();
  });
  const pending = vi.fn(async (_binding: typeof binding, admitted: Array<{ enrollmentId: string; enrollmentDigest: string }>) =>
    rows.filter(value => !admitted.some(entry => entry.enrollmentId === value.enrollmentId && entry.enrollmentDigest === value.expectedEnrollmentDigest)));
  const prepared = { enrollment: { id: 'first', enrollmentDigest: 'b'.repeat(64) }, disposition: 'replayed' } as unknown as ReturnType<ResourceConsoleEngineeringPreparationOwner['prepare']>;
  const prepare = vi.fn(async () => prepared); const onFatal = vi.fn();
  const recovery = createResourceEngineeringAutomaticAdmission({ preparation: { prepareAutomatically: prepare, pendingAutomaticAdmissions: pending },
    supervision: { snapshot, admit }, isClosing: () => closing, onFatal }); owners.push(recovery);
  return { recovery, state, snapshot, admit, pending, prepare, onFatal, rows: (value: typeof rows) => { rows = value; }, closing: () => { closing = true; } };
}
describe('durable ordinary automatic admission recovery', () => {
  it('recovers a preexisting obligation while paused without prepare, launch, or renewed allowance', async () => {
    const f = fixture(); await f.recovery.reconcile();
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.state).toMatchObject({ state: 'paused', paused: true, revision: 8, deadlineAt: binding.deadlineAt,
      admission: { maxEnrollments: 4, remainingEnrollments: 3 }, entries: [{ enrollmentId: 'first', attempts: 0 }] });
    await f.recovery.reconcile(); expect(f.admit).toHaveBeenCalledTimes(1); expect(f.state.revision).toBe(8);
    expect(f.recovery.snapshot()).toMatchObject({ state: 'ready', pending: [], ...binding });
  });
  it('retries transient admission failure on its timer without another preparation request', async () => {
    const f = fixture(); f.admit.mockImplementationOnce(() => { throw new ResourceSupervisorError('CONFLICT', '/private/conflict'); });
    f.recovery.start(); await f.recovery.reconcile(); expect(f.recovery.snapshot().pending[0]?.reason).toBe('admission-unavailable');
    await vi.advanceTimersByTimeAsync(3000); expect(f.state.entries).toHaveLength(1); expect(f.prepare).not.toHaveBeenCalled();
    expect(JSON.stringify(f.recovery.snapshot())).not.toContain('/private');
  });
  it('keeps capacity holds visible and retries without deleting the obligation', async () => {
    const f = fixture(); f.admit.mockImplementationOnce(() => { throw new ResourceSupervisorError('CAPACITY', 'full'); });
    await f.recovery.reconcile(); expect(f.recovery.snapshot().pending).toEqual([{ enrollmentId: 'first', enrollmentDigest: 'b'.repeat(64), reason: 'capacity' }]);
    await f.recovery.reconcile(); expect(f.state.entries).toHaveLength(1);
  });
  it('does not reconstruct bundle proofs when the durable queue has no capacity', async () => {
    const f = fixture(); f.state.admission.remainingEnrollments = 0;
    const before = structuredClone(f.state);
    f.recovery.start(); await f.recovery.reconcile(); await vi.advanceTimersByTimeAsync(6000);
    expect(f.pending).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
    expect(f.state).toEqual(before); expect(f.recovery.snapshot()).toMatchObject({ state: 'held', reason: 'capacity' });
  });
  it('prunes exact already-admitted pending pairs when another admission fills the queue', async () => {
    const f = fixture(); f.admit.mockImplementationOnce(() => { throw new ResourceSupervisorError('CAPACITY', 'full'); });
    await f.recovery.reconcile(); expect(f.recovery.snapshot().pending).toHaveLength(1);
    f.state.entries.push({ enrollmentId: 'first', enrollmentDigest: 'b'.repeat(64), attempts: 0 }); f.state.admission.remainingEnrollments = 0;
    await f.recovery.reconcile(); expect(f.pending).toHaveBeenCalledOnce(); expect(f.recovery.snapshot().pending).toEqual([]);
  });
  it('does not let a stale first obligation starve an independent valid one', async () => {
    const f = fixture(); f.rows([{ ...row('first'), reason: 'evidence-unavailable' }, row('second')]);
    await f.recovery.reconcile(); expect(f.state.entries.map(value => value.enrollmentId)).toEqual(['second']);
    expect(f.recovery.snapshot().pending[0]?.enrollmentId).toBe('first');
  });
  it('does not infer admission when no marked obligation exists, including an explicit legacy replay', async () => {
    const f = fixture(); f.rows([]);
    expect(await f.recovery.prepare({ objective: 'legacy request' })).toMatchObject({ automaticAdmission: { state: 'unavailable' } });
    expect(f.admit).not.toHaveBeenCalled(); expect(f.prepare).toHaveBeenCalledWith({ objective: 'legacy request' }, binding);
  });
  it.each(['configDigest', 'deadlineAt', 'configId', 'state'] as const)('refuses changed queue %s before querying pending work', async key => {
    const f = fixture(); f.state[key] = key === 'deadlineAt' ? '2026-09-12T12:02:00.000Z' : 'changed';
    await f.recovery.reconcile(); expect(f.pending).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled(); expect(f.recovery.snapshot().state).toBe('held');
  });
  it('checks the original deadline directly even when a snapshot claims to be paused', async () => {
    const f = fixture(); vi.setSystemTime(new Date(binding.deadlineAt));
    const before = structuredClone(f.state);
    f.recovery.start(); await f.recovery.reconcile(); await vi.advanceTimersByTimeAsync(6000);
    expect(f.admit).not.toHaveBeenCalled(); expect(f.pending).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    expect(f.state).toEqual(before); expect(f.recovery.snapshot()).toMatchObject({ state: 'held', deadlineAt: binding.deadlineAt });
  });
  it('refuses admission if the original deadline expires during pending proof verification', async () => {
    const f = fixture(); const before = structuredClone(f.state);
    f.pending.mockImplementationOnce(async () => { vi.setSystemTime(new Date(binding.deadlineAt)); return [row('first')]; });
    await f.recovery.reconcile();
    expect(f.pending).toHaveBeenCalledOnce(); expect(f.admit).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    expect(f.state).toEqual(before);
    expect(f.recovery.snapshot()).toMatchObject({ state: 'held', pending: [{ enrollmentId: 'first', reason: 'admission-unavailable' }] });
  });
  it('serializes overlapping recovery calls and drains a suspended read before closing', async () => {
    const f = fixture(); let release!: (value: ResourceEngineeringAutomaticAdmissionCandidate[]) => void;
    f.pending.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.recovery.reconcile(); expect(f.recovery.reconcile()).toBe(first); await Promise.resolve();
    let drained = false; const close = f.recovery.close().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
    release([row('first')]); await first; await close;
    expect(f.admit).not.toHaveBeenCalled(); expect(f.recovery.snapshot()).toMatchObject({ state: 'closed', sampledAt: null });
  });
  it('does not admit after the parent starts closing during a pending read', async () => {
    const f = fixture(); f.pending.mockImplementationOnce(async () => { f.closing(); return [row('first')]; });
    await f.recovery.reconcile(); expect(f.admit).not.toHaveBeenCalled();
  });
  it('does not classify an intentional owner refusal during close as a new fatal fault', async () => {
    const f = fixture(); f.pending.mockImplementationOnce(async () => { f.closing(); throw new ResourceEngineeringAutomaticAdmissionOwnershipError(); });
    await f.recovery.reconcile(); expect(f.onFatal).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });
  it('stops recovery on an owner registration fault instead of retrying it as stale metadata', async () => {
    const f = fixture(); f.pending.mockRejectedValue(new ResourceEngineeringAutomaticAdmissionOwnershipError());
    f.recovery.start(); await f.recovery.reconcile(); await vi.advanceTimersByTimeAsync(6000);
    expect(f.onFatal).toHaveBeenCalledOnce(); expect(f.pending).toHaveBeenCalledOnce(); expect(f.recovery.snapshot().state).toBe('closed');
  });
  it('recovers publication even when preparation fails before returning the durable result', async () => {
    const f = fixture(); f.prepare.mockRejectedValueOnce(new Error('owner return interrupted'));
    await expect(f.recovery.prepare({})).rejects.toThrow('owner return interrupted'); await f.recovery.reconcile();
    expect(f.state.entries).toHaveLength(1);
  });
});

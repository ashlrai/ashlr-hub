import { describe, expect, it } from 'vitest';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import type { ResourceTaskReceipt } from '../../../core/resources/pool-runtime.js';
import { buildResourceFleet, resourceTaskRows } from './fleet-model.js';
import { resourceFixture } from './fixtures.test-support.js';

const fixture = () => resourceFixture().snapshot;
const task = (snapshot: ResourceConsoleSnapshot, id: string) => buildResourceFleet(snapshot).tasks.find((row) => row.id === id)!;
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

describe('resource task row projection', () => {
  it('deduplicates supervisor and receipt records while preserving both evidence types', () => {
    const snapshot = fixture(); const rows = resourceTaskRows(snapshot);
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.id === 'owned-task')).toEqual({ id: 'owned-task',
      job: snapshot.supervisor!.jobs[1], receipt: snapshot.activeAttempts[0] });
    expect(rows.at(-1)?.id).toBe('done-task');
  });

  it('sorts occupied work before terminal rows, then by latest supervisor update', () => {
    const snapshot = fixture();
    snapshot.supervisor!.jobs[0]!.updatedAt = '2026-09-07T12:00:01.000Z';
    snapshot.supervisor!.jobs[2]!.updatedAt = '2026-09-07T12:00:02.000Z';
    expect(resourceTaskRows(snapshot).map((row) => row.id)).toEqual(['queued-task', 'owned-task', 'external-task', 'done-task']);
  });

  it.each((['settled', 'cancelled'] as const).flatMap((state) =>
    (['reserved', 'uncertain'] as const).map((status) => [state, status] as const)))('keeps %s supervisor / %s receipt work ahead of newer history', (state, status) => {
    const snapshot = fixture();
    const job = snapshot.supervisor!.jobs[2]!;
    job.state = state; job.outcome = state === 'settled' ? 'completed' : 'cancelled';
    job.updatedAt = '2026-09-07T11:00:00.000Z';
    const receipt = snapshot.recentAttempts.pop()!;
    snapshot.activeAttempts.push({ ...receipt, status, finishedAt: null });
    snapshot.recentAttempts.push({ ...receipt, id: 'newer-history', startedAt: '2026-09-07T13:00:00.000Z' });
    const rows = resourceTaskRows(snapshot);
    expect(rows.findIndex((row) => row.id === 'done-task')).toBeLessThan(rows.findIndex((row) => row.id === 'newer-history'));
    const model = buildResourceFleet(snapshot);
    expect(model.tasks.find((row) => row.id === 'done-task')).toMatchObject({ active: true, receiptOccupied: true, stateDisagreement: true });
    expect(model.tasks.at(-1)?.id).toBe('newer-history');
  });

  it('matches settled outcome and ownership precedence without mutating frozen input', () => {
    const snapshot = fixture(); const original = JSON.stringify(snapshot); freeze(snapshot);
    const model = buildResourceFleet(snapshot);
    expect(model.tasks.find((row) => row.id === 'done-task')).toMatchObject({ state: 'completed', ownership: 'Supervisor task', active: false });
    expect(model.tasks.find((row) => row.id === 'owned-task')).toMatchObject({ state: 'dispatching', ownership: 'Console-owned dispatch', active: true });
    expect(model.tasks.find((row) => row.id === 'external-task')).toMatchObject({ state: 'uncertain', ownership: 'Unresolved external reservation', active: true });
    expect(JSON.stringify(snapshot)).toBe(original);
  });
});

describe('resource fleet relationships', () => {
  it('counts shared capacity once and links only explicit worker assignments', () => {
    const model = buildResourceFleet(fixture());
    expect(model.counts).toMatchObject({ capacityGroups: 2, workers: 3, eligibleWorkers: 1, occupiedSlots: 2, slotLimit: 4,
      queued: 1, ownedDispatches: 1, assignments: 3, unassigned: 0, includedTasks: 4, omittedHistory: 0 });
    expect(model.groups[0]!.workers.map((row) => row.id)).toEqual(['codex-a', 'codex-alias']);
    expect(model.groups[0]!.workers[0]!.tasks.map((row) => row.id)).toEqual(['external-task']);
    expect(model.groups[1]!.workers[0]!.tasks.map((row) => row.id)).toEqual(['owned-task', 'done-task']);
    expect(model.queued[0]).toMatchObject({ workerId: null, assignment: 'unassigned', assignmentReason: 'queued-without-assignment' });
  });

  it('does not infer queued edges from the sole eligible allowed worker or next preview', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs[0]!.allowedWorkerIds = ['local-a'];
    const model = buildResourceFleet(snapshot);
    expect(model.queued[0]).toMatchObject({ workerId: null, assignment: 'unassigned', queuePreview: { state: 'ready', eligibleWorkerIds: ['local-a'] } });
    expect(model.groups[1]!.workers[0]!.tasks.some((row) => row.id === 'queued-task')).toBe(false);
  });

  it('keeps dispatch intent without a worker unassigned even when a sampled receipt exists', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs[1]!.workerId = null;
    const model = buildResourceFleet(snapshot);
    expect(model.unassigned.map((row) => row.id)).toEqual(['owned-task']);
    expect(model.unassigned[0]).toMatchObject({ assignment: 'pending', assignmentReason: 'assignment-pending', workerId: null });
    expect(model.groups[1]!.workers[0]!.tasks.map((row) => row.id)).toEqual(['done-task']);
    expect(model.counts.ownedDispatches).toBe(1);
  });

  it('retains a supervisor-only explicit assignment without claiming a receipt', () => {
    const snapshot = fixture(); snapshot.activeAttempts = snapshot.activeAttempts.filter((row) => row.id !== 'owned-task');
    expect(task(snapshot, 'owned-task')).toMatchObject({ assignment: 'recorded', workerId: 'local-a', assignmentReason: 'supervisor-recorded-assignment' });
    expect(task(snapshot, 'owned-task').receipt).toBeUndefined();
  });

  it('retains external terminal receipts as recorded assignments and not owned tasks', () => {
    const snapshot = fixture(); snapshot.supervisor = null;
    expect(task(snapshot, 'done-task')).toMatchObject({ state: 'completed', assignment: 'recorded', active: false,
      ownership: 'Recorded external task', assignmentReason: 'receipt-recorded-assignment' });
  });

  it.each(['reserved', 'uncertain'] as const)('preserves %s receipt occupancy after the supervisor sample has settled', (status) => {
    const snapshot = fixture(); const receipt = snapshot.recentAttempts.pop()!;
    snapshot.activeAttempts.push({ ...receipt, status, finishedAt: null });
    const row = task(snapshot, 'done-task');
    expect(row).toMatchObject({ state: 'completed', active: true, receiptOccupied: true, stateDisagreement: true,
      assignment: 'recorded', workerId: 'local-a' });
    expect(buildResourceFleet(snapshot).groups[1]!.workers[0]!.tasks.filter((entry) => entry.active).map((entry) => entry.id))
      .toEqual(['owned-task', 'done-task']);
  });

  it('preserves an occupied receipt after a queued supervisor job was cancelled', () => {
    const snapshot = fixture(); const job = snapshot.supervisor!.jobs[0]!;
    job.state = 'cancelled'; job.outcome = 'cancelled'; job.allowedWorkerIds = ['local-a'];
    snapshot.activeAttempts.push({ ...snapshot.activeAttempts[0]!, id: job.id });
    expect(task(snapshot, job.id)).toMatchObject({ state: 'cancelled', active: true, receiptOccupied: true, stateDisagreement: true,
      assignment: 'recorded', workerId: 'local-a' });
  });

  it('marks a newer terminal receipt during supervisor dispatch without discarding dispatch ownership', () => {
    const snapshot = fixture(); snapshot.activeAttempts[0]!.status = 'completed';
    expect(task(snapshot, 'owned-task')).toMatchObject({ state: 'dispatching', active: true, receiptOccupied: false,
      stateDisagreement: true, ownership: 'Console-owned dispatch' });
  });

  it('does not manufacture state disagreement for agreeing occupied or terminal samples', () => {
    const snapshot = fixture();
    expect(task(snapshot, 'owned-task')).toMatchObject({ state: 'dispatching', receiptOccupied: true, stateDisagreement: false });
    expect(task(snapshot, 'done-task')).toMatchObject({ state: 'completed', receiptOccupied: false, stateDisagreement: false });
    expect(task(snapshot, 'external-task').stateDisagreement).toBe(false);
  });

  it.each(['reserved', 'uncertain'] as const)('retains external %s occupancy without manufacturing console ownership', (status) => {
    const snapshot = fixture(); snapshot.supervisor = null; snapshot.activeAttempts[0]!.status = status;
    expect(task(snapshot, 'owned-task')).toMatchObject({ state: status, active: true, assignment: 'recorded',
      ownership: status === 'reserved' ? 'External reservation' : 'Unresolved external reservation' });
  });

  it('withholds conflicting supervisor and receipt worker identities', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs[1]!.workerId = 'codex-a';
    expect(task(snapshot, 'owned-task')).toMatchObject({ workerId: null, assignment: 'conflict', assignmentReason: 'assignment-evidence-conflict' });
  });

  it('withholds a recorded receipt whose capacity group does not match its worker', () => {
    const snapshot = fixture(); snapshot.activeAttempts[1]!.capacityKey = 'local-machine';
    expect(task(snapshot, 'external-task')).toMatchObject({ workerId: null, assignment: 'conflict' });
  });

  it('withholds a supervisor assignment outside its recorded allowlist', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs[1]!.allowedWorkerIds = ['codex-a'];
    expect(task(snapshot, 'owned-task')).toMatchObject({ workerId: null, assignment: 'conflict' });
  });

  it('does not substitute a worker for an unknown assigned identity', () => {
    const snapshot = fixture(); snapshot.activeAttempts[1]!.workerId = 'not-enrolled';
    const model = buildResourceFleet(snapshot);
    expect(model.unassigned[0]).toMatchObject({ id: 'external-task', workerId: null, assignmentReason: 'assigned-worker-not-enrolled' });
    expect(model.counts.assignments).toBe(2);
  });

  it('keeps queued and receipt disagreement visible without drawing an assignment edge', () => {
    const snapshot = fixture(); snapshot.activeAttempts.push({ ...snapshot.activeAttempts[0]!, id: 'queued-task' });
    snapshot.supervisor!.jobs[0]!.allowedWorkerIds = ['local-a'];
    const model = buildResourceFleet(snapshot);
    expect(model.queued[0]).toMatchObject({ assignment: 'conflict', workerId: null,
      queuePreview: { state: 'unavailable', eligibleWorkerIds: [], reasons: ['assignment-evidence-conflict'], nextRecheckAt: null } });
    expect(model.queue).toMatchObject({ state: 'unavailable', reason: 'assignment-evidence-conflict' });
    expect(model.unassigned).toHaveLength(0);
  });

  it('does not use the last duplicate queued identity to claim eligible capacity', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs.push({ ...snapshot.supervisor!.jobs[0]!, allowedWorkerIds: ['local-a'] });
    const model = buildResourceFleet(snapshot);
    expect(model.queued[0]).toMatchObject({ assignment: 'conflict', workerId: null,
      queuePreview: { state: 'unavailable', eligibleWorkerIds: [], reasons: ['assignment-evidence-conflict'] } });
    expect(model.queue.state).toBe('unavailable');
  });

  it('still reports eligible preview for a separate nonconflicting queued task', () => {
    const snapshot = fixture(); snapshot.activeAttempts.push({ ...snapshot.activeAttempts[0]!, id: 'queued-task' });
    snapshot.supervisor!.jobs.push({ ...snapshot.supervisor!.jobs[0]!, id: 'other-queued-task', allowedWorkerIds: ['local-a'] });
    const model = buildResourceFleet(snapshot);
    expect(model.queued[0]!.queuePreview?.state).toBe('unavailable');
    expect(model.queued[1]!.queuePreview).toMatchObject({ state: 'ready', eligibleWorkerIds: ['local-a'] });
    expect(model.queue).toMatchObject({ state: 'ready', reason: 'eligible-allowlist-preview' });
  });

  it('deduplicates identical repeated receipts without duplicating a graph edge', () => {
    const snapshot = fixture(); snapshot.activeAttempts.push({ ...snapshot.activeAttempts[0]! });
    expect(buildResourceFleet(snapshot).counts).toMatchObject({ assignments: 3, includedTasks: 4 });
  });

  it.each(['workerId', 'capacityKey', 'taskDigest', 'poolDigest'] as const)('withholds conflicting duplicate receipt %s', (field) => {
    const snapshot = fixture(); const duplicate = { ...snapshot.activeAttempts[0]!, [field]: 'different' };
    snapshot.activeAttempts.push(duplicate);
    expect(task(snapshot, 'owned-task')).toMatchObject({ assignment: 'conflict', workerId: null });
  });

  it('withholds conflicting duplicate supervisor identities', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs.push({ ...snapshot.supervisor!.jobs[1]!, workerId: 'codex-a' });
    expect(task(snapshot, 'owned-task')).toMatchObject({ assignment: 'conflict', workerId: null });
  });

  it('keeps unresolved work without a recorded worker in the unassigned rail', () => {
    const snapshot = fixture(); const row = snapshot.supervisor!.jobs[1]!;
    row.state = 'unresolved'; row.workerId = null;
    snapshot.activeAttempts = snapshot.activeAttempts.filter((receipt) => receipt.id !== row.id);
    expect(task(snapshot, 'owned-task')).toMatchObject({ assignment: 'unassigned', active: true, ownership: 'Unresolved prior dispatch' });
  });
});

describe('resource fleet queue previews', () => {
  it('explains allowlist bottlenecks without replacing them with globally eligible workers', () => {
    const model = buildResourceFleet(fixture());
    expect(model.queue).toMatchObject({ state: 'waiting', reason: 'no-eligible-allowed-workers' });
    expect(model.queued[0]!.queuePreview).toEqual({ state: 'waiting', eligibleWorkerIds: [], blockedWorkerIds: ['codex-a'],
      reasons: ['no-eligible-allowed-workers', 'quota-reserve-reached'], nextRecheckAt: null });
  });

  it('distinguishes an eligible preview from an actual queued assignment', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs[0]!.allowedWorkerIds.push('local-a');
    const model = buildResourceFleet(snapshot);
    expect(model.queue).toMatchObject({ state: 'ready', reason: 'eligible-allowlist-preview' });
    expect(model.queued[0]!.queuePreview).toMatchObject({ state: 'ready', eligibleWorkerIds: ['local-a'], blockedWorkerIds: ['codex-a'] });
    expect(model.queued[0]!.workerId).toBeNull();
  });

  it.each([
    { property: 'paused', value: true, state: 'paused', reason: 'queue-paused' },
    { property: 'closing', value: true, state: 'closing', reason: 'supervisor-closing' },
    { property: 'error', value: 'supervisor-observations-unavailable', state: 'unavailable', reason: 'supervisor-unavailable' },
    { property: 'activeCount', value: 4, state: 'limited', reason: 'parallel-limit-reached' },
  ])('honors $property before current capacity preview', ({ property, value, state, reason }) => {
    const snapshot = fixture(); Object.assign(snapshot.supervisor!, { [property]: value });
    snapshot.supervisor!.jobs[0]!.allowedWorkerIds = ['local-a'];
    const model = buildResourceFleet(snapshot);
    expect(model.queue).toMatchObject({ state, reason });
    expect(model.queued[0]!.queuePreview).toMatchObject({ state, eligibleWorkerIds: ['local-a'], reasons: [reason] });
  });

  it('treats stale observations as history, retaining assignments but withholding fresh routing claims', () => {
    const model = buildResourceFleet(fixture(), true);
    expect(model.evidenceAvailable).toBe(false); expect(model.counts.eligibleWorkers).toBeNull();
    expect(model.counts.assignments).toBe(3); expect(model.counts.occupiedSlots).toBe(2);
    expect(model.queue).toMatchObject({ state: 'unavailable', reason: 'last-successful-read' });
    expect(model.groups[1]!.workers[0]).toMatchObject({ eligibility: 'unknown', reasons: ['last-successful-read'] });
    expect(model.queued[0]!.queuePreview?.eligibleWorkerIds).toEqual([]);
  });

  it('does not turn missing supervisor evidence into zero queued or owned tasks', () => {
    const snapshot = fixture(); snapshot.supervisor = null;
    const model = buildResourceFleet(snapshot);
    expect(model.counts).toMatchObject({ queued: null, ownedDispatches: null });
    expect(model.queue).toMatchObject({ state: 'unavailable', reason: 'supervisor-not-enabled' });
  });

  it('preserves null capacity evidence and does not claim no reservations on degradation', () => {
    const snapshot = fixture(); snapshot.sourceState = 'degraded'; snapshot.plan = null;
    snapshot.groups.forEach((group) => { group.occupiedSlots = null; }); snapshot.counts.omittedHistory = null;
    const model = buildResourceFleet(snapshot);
    expect(model.counts).toMatchObject({ occupiedSlots: null, eligibleWorkers: null, omittedHistory: null });
    expect(model.queue.reason).toBe('resource-evidence-unavailable');
  });

  it('keeps a null group count unknown rather than summing only reported groups', () => {
    const snapshot = fixture(); snapshot.groups[0]!.occupiedSlots = null;
    expect(buildResourceFleet(snapshot).counts.occupiedSlots).toBeNull();
  });

  it('preserves explicitly operator-capped unknown quota without converting it into measured capacity', () => {
    const snapshot = fixture(); snapshot.plan!.candidates[0]!.reason = 'operator-capped-unknown-quota';
    const worker = buildResourceFleet(snapshot).groups[1]!.workers[0]!;
    expect(worker.reasons).toEqual(['operator-capped-unknown-quota']);
    expect(worker.eligibility).toBe('eligible');
  });

  it('returns only future allowlisted recheck hints, not another worker’s earlier reset', () => {
    const snapshot = fixture(); snapshot.plan!.exclusions[0]!.nextEligibleAt = '2026-09-07T12:00:10.000Z';
    snapshot.plan!.exclusions[1]!.nextEligibleAt = '2026-09-07T12:00:01.000Z';
    expect(buildResourceFleet(snapshot).queue.nextRecheckAt).toBe('2026-09-07T12:00:10.000Z');
    snapshot.plan!.exclusions[0]!.nextEligibleAt = snapshot.sampledAt;
    expect(buildResourceFleet(snapshot).queue.nextRecheckAt).toBeNull();
  });

  it('reports unknown allowed workers and never maps them to enrolled substitutes', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs[0]!.allowedWorkerIds = ['missing'];
    expect(buildResourceFleet(snapshot).queued[0]!.queuePreview).toMatchObject({ eligibleWorkerIds: [], blockedWorkerIds: ['missing'],
      reasons: ['no-eligible-allowed-workers', 'allowed-worker-not-enrolled'] });
  });

  it('reports an idle queue only when a supervisor exists and no work is queued', () => {
    const snapshot = fixture(); snapshot.supervisor!.jobs = snapshot.supervisor!.jobs.filter((job) => job.state !== 'queued');
    snapshot.supervisor!.queuedCount = 0;
    expect(buildResourceFleet(snapshot).queue).toEqual({ state: 'idle', reason: 'no-queued-tasks', nextRecheckAt: null });
  });

  it('keeps valid missing-ledger previews distinct from degraded evidence', () => {
    const snapshot = fixture(); snapshot.sourceState = 'missing';
    expect(buildResourceFleet(snapshot).evidenceAvailable).toBe(true);
  });
});

describe('resource fleet bounds and stable identities', () => {
  it('does not double-count duplicated capacity groups or worker memberships', () => {
    const snapshot = fixture(); snapshot.groups[0]!.workerIds.push('codex-a'); snapshot.groups.push({ ...snapshot.groups[0]! });
    const model = buildResourceFleet(snapshot);
    expect(model.counts).toMatchObject({ capacityGroups: 2, slotLimit: 4, occupiedSlots: 2 });
    expect(model.groups[0]!.workers).toHaveLength(2);
  });

  it('does not connect a worker through a mismatching shared-capacity membership', () => {
    const snapshot = fixture(); snapshot.groups[0]!.workerIds.push('local-a');
    expect(buildResourceFleet(snapshot).groups[0]!.workers.map((worker) => worker.id)).toEqual(['codex-a', 'codex-alias']);
  });

  it('keeps all bounded source rows and explicit omission counts for view pagination', () => {
    const snapshot = fixture(); const baseWorker = snapshot.pool.workers[0]!; const baseGroup = snapshot.groups[0]!;
    snapshot.pool.workers = Array.from({ length: 32 }, (_, index) => ({ ...baseWorker, id: `worker-${index}`, capacityKey: `group-${index}` }));
    snapshot.groups = snapshot.pool.workers.map((worker) => ({ ...baseGroup, capacityKey: worker.capacityKey, workerIds: [worker.id], occupiedSlots: 128 }));
    const baseReceipt = snapshot.activeAttempts[0]!;
    snapshot.activeAttempts = Array.from({ length: 4096 }, (_, index): ResourceTaskReceipt => ({ ...baseReceipt,
      id: `task-${index}`, workerId: `worker-${index % 32}`, capacityKey: `group-${index % 32}` }));
    snapshot.recentAttempts = []; snapshot.supervisor = null; snapshot.counts.omittedHistory = 100;
    const model = buildResourceFleet(snapshot);
    expect(model.counts).toMatchObject({ capacityGroups: 32, workers: 32, occupiedSlots: 4096, assignments: 4096, includedTasks: 4096, omittedHistory: 100 });
    expect(model.groups).toHaveLength(32); expect(model.groups.every((group) => group.workers[0]!.tasks.length === 128)).toBe(true);
    expect(new Set(model.tasks.map((row) => row.id)).size).toBe(4096);
  });
});

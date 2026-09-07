import type { ResourceConsoleGroup, ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import type { ResourceTaskRow } from './TaskInspector.js';
import { compareResourceTaskRows, hasResourceTaskOccupancy } from './task-order.js';

type ConsoleWorker = ResourceConsoleSnapshot['pool']['workers'][number];
export type ResourceFleetQueueState = 'unavailable' | 'closing' | 'paused' | 'limited' | 'waiting' | 'ready';
export interface ResourceFleetQueuePreview {
  state: ResourceFleetQueueState;
  eligibleWorkerIds: string[];
  blockedWorkerIds: string[];
  reasons: string[];
  /** A recorded recheck hint, never an assigned worker or promised start time. */
  nextRecheckAt: string | null;
}
export interface ResourceFleetTask extends ResourceTaskRow {
  state: string;
  ownership: string;
  workerId: string | null;
  assignment: 'recorded' | 'pending' | 'unassigned' | 'conflict';
  assignmentReason: string;
  active: boolean;
  /** Occupancy in the ledger observation, not an OS process heartbeat. */
  receiptOccupied: boolean;
  /** Supervisor and ledger samples can straddle a settlement. Preserve both. */
  stateDisagreement: boolean;
  queuePreview: ResourceFleetQueuePreview | null;
}
export interface ResourceFleetWorker extends ConsoleWorker {
  eligibility: 'eligible' | 'blocked' | 'unknown';
  reasons: string[];
  nextEligibleAt: string | null;
  tasks: ResourceFleetTask[];
}
export interface ResourceFleetGroup extends ResourceConsoleGroup { workers: ResourceFleetWorker[] }
export interface ResourceFleetModel {
  sampledAt: string;
  stale: boolean;
  evidenceAvailable: boolean;
  groups: ResourceFleetGroup[];
  tasks: ResourceFleetTask[];
  queued: ResourceFleetTask[];
  /** Queued tasks live in their own rail, not in this unassigned collection. */
  unassigned: ResourceFleetTask[];
  queue: { state: ResourceFleetQueueState | 'idle'; reason: string; nextRecheckAt: string | null };
  counts: {
    capacityGroups: number;
    workers: number;
    eligibleWorkers: number | null;
    occupiedSlots: number | null;
    slotLimit: number;
    queued: number | null;
    ownedDispatches: number | null;
    assignments: number;
    unassigned: number;
    includedTasks: number;
    omittedHistory: number | null;
  };
}

const taskState = (row: ResourceTaskRow): string => row.job?.state === 'settled'
  ? row.job.outcome ?? 'settled' : row.job?.state ?? row.receipt?.status ?? 'unknown';
function taskOwnership(row: ResourceTaskRow): string {
  if (row.job?.state === 'dispatching') return 'Console-owned dispatch';
  if (row.job?.state === 'queued') return 'Queued in this supervisor';
  if (row.job?.state === 'unresolved') return 'Unresolved prior dispatch';
  if (row.job) return 'Supervisor task';
  if (row.receipt?.status === 'uncertain') return 'Unresolved external reservation';
  if (row.receipt?.status === 'reserved') return 'External reservation';
  return 'Recorded external task';
}

function sampledStateDisagreement(row: ResourceTaskRow, receiptOccupied: boolean): boolean {
  if (!row.job || !row.receipt) return false;
  if (row.job.state === 'queued') return true;
  if (row.job.state === 'settled') return row.job.outcome !== row.receipt.status;
  if (row.job.state === 'cancelled') return row.receipt.status !== 'cancelled';
  if (row.job.state === 'dispatching' && row.receipt.status === 'uncertain') return true;
  return !receiptOccupied;
}

/** Same precedence and ordering as the task desk; inputs are never changed. */
export function resourceTaskRows(snapshot: ResourceConsoleSnapshot): ResourceTaskRow[] {
  const rows = new Map<string, ResourceTaskRow>();
  for (const job of snapshot.supervisor?.jobs ?? []) rows.set(job.id, { id: job.id, job });
  for (const receipt of [...snapshot.activeAttempts, ...snapshot.recentAttempts]) {
    rows.set(receipt.id, { ...rows.get(receipt.id), id: receipt.id, receipt });
  }
  return [...rows.values()].sort(compareResourceTaskRows);
}

function earliest(values: Array<string | null>, sampledAt: string): string | null {
  return values.filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)) &&
    Date.parse(value) > Date.parse(sampledAt)).sort()[0] ?? null;
}

function queueConstraint(snapshot: ResourceConsoleSnapshot, stale: boolean, evidenceAvailable: boolean):
  { state: ResourceFleetQueueState; reason: string } | null {
  if (stale) return { state: 'unavailable', reason: 'last-successful-read' };
  if (!evidenceAvailable) return { state: 'unavailable', reason: 'resource-evidence-unavailable' };
  const supervisor = snapshot.supervisor;
  if (!supervisor) return { state: 'unavailable', reason: 'supervisor-not-enabled' };
  if (supervisor.closing) return { state: 'closing', reason: 'supervisor-closing' };
  if (supervisor.error) return { state: 'unavailable', reason: 'supervisor-unavailable' };
  if (supervisor.paused) return { state: 'paused', reason: 'queue-paused' };
  if (supervisor.activeCount >= supervisor.maxParallel) return { state: 'limited', reason: 'parallel-limit-reached' };
  return null;
}

/** Duplicate identities cannot gain an edge merely by winning array order. */
function conflictingIds(snapshot: ResourceConsoleSnapshot): Set<string> {
  const conflicts = new Set<string>();
  const receipts = new Map<string, string>();
  for (const receipt of [...snapshot.activeAttempts, ...snapshot.recentAttempts]) {
    const identity = JSON.stringify([receipt.workerId, receipt.capacityKey, receipt.taskDigest, receipt.poolDigest]);
    if (receipts.has(receipt.id) && receipts.get(receipt.id) !== identity) conflicts.add(receipt.id);
    receipts.set(receipt.id, identity);
  }
  const jobs = new Map<string, string>();
  for (const job of snapshot.supervisor?.jobs ?? []) {
    const identity = JSON.stringify([job.workerId, [...job.allowedWorkerIds].sort(), job.mode]);
    if (jobs.has(job.id) && jobs.get(job.id) !== identity) conflicts.add(job.id);
    jobs.set(job.id, identity);
  }
  return conflicts;
}

function assignment(row: ResourceTaskRow, workers: Map<string, ConsoleWorker>, conflicts: Set<string>):
  Pick<ResourceFleetTask, 'workerId' | 'assignment' | 'assignmentReason'> {
  const none = (kind: ResourceFleetTask['assignment'], reason: string) => ({ workerId: null, assignment: kind, assignmentReason: reason });
  if (conflicts.has(row.id)) return none('conflict', 'assignment-evidence-conflict');
  if (row.job?.state === 'queued') return row.job.workerId !== null || row.receipt
    ? none('conflict', 'assignment-evidence-conflict') : none('unassigned', 'queued-without-assignment');
  // Dispatch intent is published before reservation. A separately sampled
  // receipt must not turn a still-pending supervisor assignment into an edge.
  if (row.job?.state === 'dispatching' && row.job.workerId === null) return none('pending', 'assignment-pending');
  if (row.job?.workerId && row.receipt && row.job.workerId !== row.receipt.workerId) return none('conflict', 'assignment-evidence-conflict');
  const workerId = row.job?.workerId ?? row.receipt?.workerId ?? null;
  if (workerId === null) return none('unassigned', 'assignment-not-recorded');
  const worker = workers.get(workerId);
  if (!worker) return none('unassigned', 'assigned-worker-not-enrolled');
  if (row.job && !row.job.allowedWorkerIds.includes(workerId) || row.receipt && row.receipt.capacityKey !== worker.capacityKey) {
    return none('conflict', 'assignment-evidence-conflict');
  }
  return { workerId, assignment: 'recorded', assignmentReason: row.job?.workerId ? 'supervisor-recorded-assignment' : 'receipt-recorded-assignment' };
}

/**
 * A deterministic observation model, not a second scheduler. Shared capacity is
 * counted once; candidate intersections are previews; only explicit identities
 * create task relationships. Rendering bounds belong to the view, never here.
 */
export function buildResourceFleet(snapshot: ResourceConsoleSnapshot, stale = false): ResourceFleetModel {
  const workers = new Map(snapshot.pool.workers.map((worker) => [worker.id, worker]));
  const evidenceAvailable = !stale && snapshot.sourceState !== 'degraded' && snapshot.plan !== null;
  const candidates = new Map((snapshot.plan?.candidates ?? []).map((row) => [row.workerId, row]));
  const exclusions = new Map((snapshot.plan?.exclusions ?? []).map((row) => [row.workerId, row]));
  const constraint = queueConstraint(snapshot, stale, evidenceAvailable);
  const conflicts = conflictingIds(snapshot);
  const tasks = resourceTaskRows(snapshot).map((row): ResourceFleetTask => {
    const state = taskState(row);
    const receiptOccupied = row.receipt?.status === 'reserved' || row.receipt?.status === 'uncertain';
    const recordedAssignment = assignment(row, workers, conflicts);
    const conflictingQueue = state === 'queued' && recordedAssignment.assignment === 'conflict';
    const allowed = [...new Set(row.job?.allowedWorkerIds ?? [])];
    const eligibleWorkerIds = evidenceAvailable && !conflictingQueue ? allowed.filter((id) => workers.has(id) && candidates.has(id)) : [];
    const blockedWorkerIds = allowed.filter((id) => !eligibleWorkerIds.includes(id));
    const reasons = [...new Set(blockedWorkerIds.flatMap((id) => !workers.has(id) ? ['allowed-worker-not-enrolled']
      : exclusions.get(id)?.reasons ?? ['routing-evidence-unavailable']))];
    const nextRecheckAt = evidenceAvailable && !conflictingQueue ? earliest(blockedWorkerIds.map((id) => exclusions.get(id)?.nextEligibleAt ?? null), snapshot.sampledAt) : null;
    return { ...row, state, ownership: taskOwnership(row), ...recordedAssignment,
      active: hasResourceTaskOccupancy(row), receiptOccupied,
      stateDisagreement: sampledStateDisagreement(row, receiptOccupied),
      queuePreview: state === 'queued' ? { state: conflictingQueue ? 'unavailable' : constraint?.state ?? (eligibleWorkerIds.length ? 'ready' : 'waiting'),
        eligibleWorkerIds, blockedWorkerIds,
        reasons: conflictingQueue ? ['assignment-evidence-conflict'] : constraint ? [constraint.reason, ...reasons] : eligibleWorkerIds.length ? ['eligible-allowlist-preview']
          : ['no-eligible-allowed-workers', ...reasons], nextRecheckAt } : null };
  });
  const groups = [...new Map(snapshot.groups.map((group) => [group.capacityKey, group])).values()].map((group): ResourceFleetGroup => ({
    ...group, workerIds: [...new Set(group.workerIds)],
    workers: [...new Set(group.workerIds)].flatMap((id) => {
      const worker = workers.get(id);
      if (!worker || worker.capacityKey !== group.capacityKey) return [];
      const candidate = candidates.get(id); const exclusion = exclusions.get(id);
      return [{ ...worker, eligibility: !evidenceAvailable ? 'unknown' : candidate ? 'eligible' : exclusion ? 'blocked' : 'unknown',
        reasons: !evidenceAvailable ? [stale ? 'last-successful-read' : 'resource-evidence-unavailable']
          : candidate ? [candidate.reason] : [...(exclusion?.reasons ?? ['routing-evidence-unavailable'])],
        nextEligibleAt: evidenceAvailable ? earliest([exclusion?.nextEligibleAt ?? null], snapshot.sampledAt) : null,
        tasks: tasks.filter((task) => task.assignment === 'recorded' && task.workerId === id) }];
    }),
  }));
  const queued = tasks.filter((task) => task.state === 'queued');
  const unassigned = tasks.filter((task) => task.state !== 'queued' && task.assignment !== 'recorded');
  const availableQueued = queued.some((task) => task.queuePreview?.state === 'ready');
  const allQueuedConflicted = queued.length > 0 && queued.every((task) => task.assignment === 'conflict');
  const queue: ResourceFleetModel['queue'] = { state: constraint?.state ?? (!queued.length ? 'idle' : availableQueued ? 'ready' : allQueuedConflicted ? 'unavailable' : 'waiting'),
    reason: constraint?.reason ?? (!queued.length ? 'no-queued-tasks' : availableQueued ? 'eligible-allowlist-preview' : allQueuedConflicted ? 'assignment-evidence-conflict' : 'no-eligible-allowed-workers'),
    nextRecheckAt: earliest(queued.map((task) => task.queuePreview?.nextRecheckAt ?? null), snapshot.sampledAt) };
  return { sampledAt: snapshot.sampledAt, stale, evidenceAvailable, groups, tasks, queued, unassigned, queue,
    counts: { capacityGroups: groups.length, workers: workers.size,
      eligibleWorkers: evidenceAvailable ? [...workers.keys()].filter((id) => candidates.has(id)).length : null,
      occupiedSlots: snapshot.sourceState === 'degraded' || groups.some((group) => group.occupiedSlots === null)
        ? null : groups.reduce((total, group) => total + group.occupiedSlots!, 0),
      slotLimit: groups.reduce((total, group) => total + group.maxConcurrent, 0),
      queued: snapshot.supervisor?.queuedCount ?? null, ownedDispatches: snapshot.supervisor?.activeCount ?? null,
      assignments: tasks.filter((task) => task.assignment === 'recorded').length, unassigned: unassigned.length,
      includedTasks: tasks.length, omittedHistory: snapshot.counts.omittedHistory } };
}

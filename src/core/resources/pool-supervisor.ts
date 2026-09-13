/** Durable foreground queue. Only this live owner may dispatch or cancel its tasks. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock, type LocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { validateResourceObservations, validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { readResourceJson, readResourcePoolHistory, resourcePoolStatus, runResourceTask, validateResourceTask, validateUnavailableResourceWorkerIds,
  type ResourcePoolConfigSnapshot, type ResourceTask, type ResourceTaskReceipt } from './pool-runtime.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';
import { resourcePoolConfigSnapshot, validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import { MAX_RESOURCE_CONVERSATION_BYTES, resourceConsoleConversationPrompt, resourceConsoleTranscriptDigest,
  validateResourceConsoleContext, validateResourceConsoleParent } from './console-conversation.js';
import { matchesResourceConsoleProject, pinResourceConsoleProject, validateResourceConsoleProjectBindings,
  validateResourceConsoleProjects, type ResourceConsoleProjectBinding } from './console-projects.js';
import type { ResourceConsoleContextTurn, ResourceConsoleOutput, ResourceConsoleTaskInput, ResourceConsoleTranscript,
  ResourceConsoleProject, ResourceConsoleProjectInput, ResourceSupervisorJob, ResourceSupervisorSnapshot } from './console-types.js';
import { captureResourceExecutionVeto } from './execution-veto.js';
import { captureResourceEngineeringLifetime, type ResourceEngineeringLifetime } from './engineering-lifetime.js';

export class ResourceSupervisorError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'CAPACITY' | 'UNAVAILABLE' | 'NOT_FOUND', message: string) {
    super(message); this.name = 'ResourceSupervisorError';
  }
}
export const MAX_RESOURCE_SUPERVISOR_JOBS = 256;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_OUTPUT_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ['queued', 'dispatching', 'settled', 'cancelled', 'unresolved'];
const OUTCOMES = ['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'];
type DurableJob = Omit<ResourceSupervisorJob, 'cancellable' | 'outputAvailable' | 'historyAvailable'> & {
  taskDigest: string; input: ResourceConsoleTaskInput | null;
  /** Never changed after admission, including after explicit text deletion. */
  retainHistory?: true;
  history?: Pick<ResourceConsoleTranscript, 'prompt' | 'output'> | null;
  /** Exact original submission identity survives deletion of all private text. */
  submissionDigest?: string;
  /** Accepted copies are independent of later edits/deletion of source history. */
  context?: ResourceConsoleContextTurn[] | null;
  /** Immutable admission epoch; omitted jobs retain the state's original epoch. */
  originPoolDigest?: string;
  /** Attribution only: the live accepting instance must still own the private veto. */
  executionOwnerId?: string;
  executionDeadlineAt?: string;
  /** Immutable edge to an abandoned, never-dispatched child. */
  recoveryOf?: string;
};
export interface ResourceConsoleDurableState {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Original scope anchor, never rewritten when the active pool evolves. */
  scopeDigest: string;
  paused: boolean; jobs: DurableJob[]; projects?: ResourceConsoleProjectBinding[];
  /** Schema5 base epoch for unchanged historical jobs without an explicit origin. */
  originPoolDigest?: string;
}
type DurableState = ResourceConsoleDurableState;
export interface ResourcePoolSupervisorOptions {
  /** Host mission ownership/deadline veto; false is the only permitting result. */
  isExecutionStopped?: () => boolean;
  /** Host-only child veto, checked again at fresh reservation dispatch. */
  isTaskExecutionStopped?: (id: string) => boolean;
  root: string; pool: ResourcePool; bindings: ResourceBinding[]; workspace: string;
  projects?: ResourceConsoleProjectInput[];
  readObservations(): ResourceObservation[];
  /** Non-durable admission veto; callback failure blocks new work until recovery. */
  readUnavailableWorkerIds?(): string[];
  readQuotaUnavailableWorkerIds?(): string[];
  maxParallel?: number; maxQueued?: number; pollIntervalMs?: number; signal?: AbortSignal;
}
export interface ResourcePoolSupervisor {
  snapshot(): ResourceSupervisorSnapshot;
  projects(): ResourceConsoleProject[] | undefined;
  projectFileBinding(projectId: string): ResourceConsoleProjectBinding;
  /** Persisted identity for host enrollment; does not authorize execution. */
  engineeringBinding(projectId: string): { project: ResourceConsoleProjectBinding; root: string; poolDigest: string };
  /** Synchronous owning/paused/enabled/directory check at engineering effect boundaries. */
  projectExecutionBinding(projectId: string): ResourceConsoleProjectBinding;
  submit(input: ResourceConsoleTaskInput, lifetime?: ResourceEngineeringLifetime): ResourceSupervisorJob;
  /** Explicit host recovery; never retries manual cancellations or uncertain work. */
  recover(input: ResourceConsoleTaskInput, lifetime: ResourceEngineeringLifetime): ResourceSupervisorJob;
  /** Optional exact retained task pin for host-driven, scoped cancellation. */
  cancel(id: string, expectedTaskDigest?: string): ResourceSupervisorJob;
  /** Cancel exactly one retained task and await its verified transport settlement. */
  cancelAndDrain(id: string, expectedTaskDigest: string): Promise<ResourceSupervisorJob>;
  /** Live custody only, not settlement. Never accepts external or uncertain work. */
  ownsActiveTaskReceipt(receipt: ResourceTaskReceipt): boolean;
  setPaused(paused: boolean): ResourceSupervisorSnapshot;
  output(id: string): ResourceConsoleOutput | null;
  history(id: string): ResourceConsoleTranscript | null;
  deleteHistory(id: string): ResourceSupervisorJob;
  close(): Promise<void>;
}

/** Host-only live ownership, issued by the actual constructor, never by a wire descriptor. */
export interface ResourceSupervisorCustody {
  root: string; workspace: string; poolDigest: string; lock: LocalStoreLock; stateDigest: string;
  ownsReceipt(receipt: ResourceTaskReceipt): boolean;
  /** Read-only historical join: exact reservation prefix of a proven owned settlement. */
  ownsSettledReservation(receipt: ResourceTaskReceipt): boolean;
}
const supervisorCustodies = new WeakMap<ResourcePoolSupervisor, () => ResourceSupervisorCustody>();
export function readResourceSupervisorCustody(supervisor: ResourcePoolSupervisor): ResourceSupervisorCustody {
  const read = supervisorCustodies.get(supervisor);
  if (!read) throw new ResourceSupervisorError('UNAVAILABLE', 'Unrecognized resource supervisor owner');
  return read();
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    value !== parse(value).root && [...value].every((char) => char.charCodeAt(0) >= 32 &&
      !(char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function limit(value: unknown, fallback: number, max: number, min = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource supervisor limits');
  }
  return Number(value);
}
function detached<T>(value: T): T { return structuredClone(value); }
/** The evidence-pack serializer has a smaller cap than this store; preserve 4MiB compatibility. */
function assertStateData(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > MAX_STATE_BYTES || depth > 32) throw new Error('Invalid resource supervisor state');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value) || !Array.isArray(value) && !object(value)) {
    throw new Error('Invalid resource supervisor state');
  }
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('Invalid resource supervisor state');
      }
      assertStateData(descriptor.value, ancestors, depth + 1, budget);
    }
  } finally { ancestors.delete(value); }
}
function entryExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function assertStateHeadroom(next: DurableState): void {
  // Reserve the complete future metadata envelope, not a guessed byte margin.
  // Mutable IDs/reasons are unescaped ASCII bounded at 64/120 characters;
  // canonical ISO dates are at most 27 characters. Every other job field is
  // immutable, or its only future change is to drop the private input. Keeping
  // that input while maximizing all metadata therefore bounds every transition.
  let futureOutputBytes = 0;
  const envelope = { ...next, paused: false, jobs: next.jobs.map((job) => {
    if (job.input === null) return job;
    // A raw byte can require six JSON bytes (for example U+0000). Reserve
    // every pending opted-in response, including ones not yet dispatching.
    if (job.history) futureOutputBytes += 6 * MAX_HISTORY_OUTPUT_BYTES;
    return {
      ...job, state: 'dispatching', workerId: 'w'.repeat(64), outcome: 'completed',
      reason: 'r'.repeat(120), updatedAt: '+275760-09-13T00:00:00.000Z',
      ...(job.history ? { history: { prompt: job.history.prompt, output: { text: '', truncated: false } } } : {}),
    };
  }) };
  if (Buffer.byteLength(canonical(envelope) + '\n') + futureOutputBytes > MAX_STATE_BYTES) {
    throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor state capacity reached');
  }
}

function boundedOutput(text: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text); let end = Math.min(bytes.length, maximum);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: end < bytes.length };
}

function consoleTaskCodec(workspace: string, workerIds: Set<string>, scopeDigest: string,
  projectBindings?: ResourceConsoleProjectBinding[]) {
  function projectWorkspace(projectId?: string): string {
    if (projectId === undefined || projectId === 'default') return workspace;
    const binding = projectBindings?.find((project) => project.id === projectId);
    if (!binding) throw new ResourceSupervisorError('INVALID_INPUT', 'Unknown resource project');
    return binding.workspace;
  }
  function taskInput(value: unknown): ResourceConsoleTaskInput {
    try {
      if (!object(value) || !exact(value, ['id', 'prompt', 'allowedWorkerIds', 'mode', 'timeoutMs', 'maxOutputTokens',
        ...(Object.hasOwn(value, 'retainHistory') ? ['retainHistory'] : []), ...(Object.hasOwn(value, 'parent') ? ['parent'] : []),
        ...(Object.hasOwn(value, 'projectId') ? ['projectId'] : [])]) ||
        Object.hasOwn(value, 'retainHistory') && typeof value.retainHistory !== 'boolean' ||
        Object.hasOwn(value, 'projectId') && (typeof value.projectId !== 'string' || !ID.test(value.projectId)) ||
        typeof value.prompt !== 'string' || Buffer.byteLength(value.prompt) > 32 * 1024) throw new Error();
      const ids = value.allowedWorkerIds;
      if (!Array.isArray(ids) || Reflect.ownKeys(ids).length !== ids.length + 1 ||
        !Array.from({ length: ids.length }, (_, index) => index).every((index) =>
          Object.hasOwn(ids, index) && 'value' in Object.getOwnPropertyDescriptor(ids, index)!)) throw new Error();
      const { retainHistory, parent: parentValue, projectId: projectValue, ...runtimeInput } = value;
      const projectId = typeof projectValue === 'string' && projectValue !== 'default' ? projectValue : undefined;
      const parent = Object.hasOwn(value, 'parent') ? validateResourceConsoleParent(parentValue) : undefined;
      if (parent?.taskId === value.id) throw new Error();
      const task = validateResourceTask({ ...runtimeInput, schemaVersion: 1, cwd: projectWorkspace(projectId) });
      if (task.allowedWorkerIds.some((id) => !workerIds.has(id))) throw new Error();
      return { id: task.id, prompt: task.prompt, allowedWorkerIds: task.allowedWorkerIds, mode: task.mode,
        timeoutMs: task.timeoutMs, maxOutputTokens: task.maxOutputTokens, ...(retainHistory === true ? { retainHistory: true } : {}),
        ...(parent ? { parent } : {}), ...(projectId ? { projectId } : {}) };
    } catch { throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource console task'); }
  }
  // Local text-retention consent is not provider input or a new ledger identity.
  const taskFor = (input: ResourceConsoleTaskInput, context?: ResourceConsoleContextTurn[] | null): ResourceTask => {
    const { retainHistory: _retention, parent, projectId, ...runtimeInput } = detached(input);
    if (parent) {
      if (!context) throw new ResourceSupervisorError('UNAVAILABLE', 'Accepted conversation context is unavailable');
      runtimeInput.prompt = resourceConsoleConversationPrompt(input.prompt, context);
      if (Buffer.byteLength(runtimeInput.prompt) > MAX_RESOURCE_CONVERSATION_BYTES) {
        throw new ResourceSupervisorError('CAPACITY', 'Conversation context exceeds the 256 KiB limit');
      }
    }
    return { ...runtimeInput, schemaVersion: 1, cwd: projectWorkspace(projectId) };
  };
  const submissionDigestFor = (input: ResourceConsoleTaskInput): string => digest(canonical({
    domain: 'ashlr-resource-console-submission-v1', scopeDigest, input,
  }));
  return { taskInput, taskFor, submissionDigestFor };
}

/** Validate epoch snapshots supplied by the verified resource ledger, never by console state. */
function consoleEpochs(history: ResourcePoolConfigSnapshot[] | undefined, pool: ResourcePool, bindings: ResourceBinding[]) {
  const current = resourcePoolConfigSnapshot(pool, bindings);
  if (history === undefined) return new Map([[current.poolDigest, current]]);
  const checked = validateResourcePoolConfigHistory(history);
  const epochs = new Map(checked.map((row) => [row.poolDigest, row]));
  if (checked.at(-1)?.poolDigest !== current.poolDigest) throw new Error('Console active pool epoch mismatch');
  return epochs;
}

export function resourceConsoleRecoveryId(prior: { id: string; taskDigest: string }): string {
  return `recovery-${digest(canonical({ domain: 'ashlr-console-recovery-v1', id: prior.id, taskDigest: prior.taskDigest })).slice(0, 40)}`;
}

/** Read-only identity join over already decoded state, never execution authority. */
export function resourceConsoleTaskContinuation(state: ResourceConsoleDurableState, original: ResourceTask,
  projectId?: string, deadlineAt?: string): DurableJob[] {
  const task = validateResourceTask(original);
  const root = state.jobs.find(row => row.id === task.id);
  if (!root) return [];
  const chain: DurableJob[] = []; let current: DurableJob | undefined = root;
  while (current) {
    if (chain.length >= MAX_RESOURCE_SUPERVISOR_JOBS || chain.some(row => row.id === current!.id) ||
      current.taskDigest !== digest(canonical({ ...task, id: current.id })) || current.projectId !== projectId ||
      (current.executionOwnerId !== undefined && current.executionDeadlineAt !== deadlineAt) ||
      (chain.length > 0 && current.executionOwnerId === undefined) ||
      (chain.length === 0 ? current.recoveryOf !== undefined : current.recoveryOf !== chain.at(-1)!.id)) {
      throw new ResourceSupervisorError('CONFLICT', 'Resource task recovery identity changed');
    }
    chain.push(current);
    const children = state.jobs.filter(row => row.recoveryOf === current!.id);
    if (children.length > 1 || children.length && (current.state !== 'cancelled' || current.reason !== 'task-owner-unavailable' ||
      children[0]!.id !== resourceConsoleRecoveryId(current))) throw new ResourceSupervisorError('CONFLICT', 'Resource task recovery chain changed');
    current = children[0];
  }
  return detached(chain);
}

/** Strict detached schema1–7 validation; no ownership, recovery, reads or writes. */
export function decodeResourceConsoleState(value: unknown, options: {
  pool: ResourcePool; bindings: ResourceBinding[]; workspace: string;
  /** Must be obtained from verified ledger evidence by the caller. Required for schema5. */
  configHistory?: ResourcePoolConfigSnapshot[];
}): ResourceConsoleDurableState {
  const pool = validateResourcePool(options.pool);
  const bindings = validateResourceBindings(options.bindings, pool);
  const workspace = options.workspace;
  const epochs = consoleEpochs(options.configHistory, pool, bindings);
  const activeDigest = digest(canonical({ pool, bindings }));
  function epochFor(state: Record<string, unknown>, row?: { originPoolDigest?: unknown }) {
    const id = Number(state.schemaVersion) >= 5 ? row?.originPoolDigest ?? state.originPoolDigest : activeDigest;
    if (typeof id !== 'string' || !epochs.has(id)) throw new Error('Unknown console origin pool epoch');
    return epochs.get(id)!;
  }
  function scopeFor(state: Record<string, unknown>, row?: { originPoolDigest?: unknown }) {
    const { pool, bindings } = epochFor(state, row);
    return digest(canonical({ pool, bindings, workspace }));
  }
  let projectBindings: ResourceConsoleProjectBinding[] | undefined;
  function decode(value: unknown): DurableState {
    if (!object(value) || !exact(value, ['schemaVersion', 'scopeDigest', 'paused', 'jobs',
      ...(value.schemaVersion === 4 || Number(value.schemaVersion) >= 5 && Object.hasOwn(value, 'projects') ? ['projects'] : []),
      ...(Number(value.schemaVersion) >= 5 ? ['originPoolDigest'] : [])]) ||
      ![1, 2, 3, 4, 5, 6, 7].includes(Number(value.schemaVersion)) ||
      typeof value.schemaVersion !== 'number' ||
      Number(value.schemaVersion) >= 5 && options.configHistory === undefined ||
      value.scopeDigest !== scopeFor(value) || typeof value.paused !== 'boolean' || !Array.isArray(value.jobs) ||
      value.jobs.length > MAX_RESOURCE_SUPERVISOR_JOBS) throw new Error('Invalid resource supervisor state');
    if (Object.hasOwn(value, 'projects')) projectBindings = validateResourceConsoleProjectBindings(value.projects, workspace);
    const ids = new Set<string>();
    for (const row of value.jobs) {
      if (!object(row)) throw new Error('Invalid resource supervisor job');
      if (Object.hasOwn(row, 'originPoolDigest') && Number(value.schemaVersion) < 5) throw new Error('Unexpected console origin epoch');
      if (Object.hasOwn(row, 'originPoolDigest') && (typeof row.originPoolDigest !== 'string' || !HASH.test(row.originPoolDigest))) {
        throw new Error('Invalid console origin epoch');
      }
      const epoch = epochFor(value, row);
      const workerIds = new Set(epoch.pool.workers.map((worker) => worker.id));
      const { taskInput, taskFor, submissionDigestFor } = consoleTaskCodec(workspace, workerIds, scopeFor(value, row), projectBindings);
      const retained = object(row) && (Object.hasOwn(row, 'retainHistory') || Object.hasOwn(row, 'history'));
      const continuation = object(row) && ['parent', 'submissionDigest', 'context'].some((key) => Object.hasOwn(row, key));
      if (!object(row) || !exact(row, ['id', 'state', 'enqueuedAt', 'updatedAt', 'allowedWorkerIds', 'mode', 'workerId',
        'outcome', 'reason', 'taskDigest', 'input', ...(retained ? ['retainHistory', 'history'] : []),
        ...(continuation ? ['parent', 'submissionDigest', 'context'] : []), ...(Object.hasOwn(row, 'projectId') ? ['projectId'] : []),
        ...(Object.hasOwn(row, 'originPoolDigest') ? ['originPoolDigest'] : []),
        ...(Object.hasOwn(row, 'executionOwnerId') ? ['executionOwnerId'] : []),
        ...(Object.hasOwn(row, 'executionDeadlineAt') ? ['executionDeadlineAt'] : []),
        ...(Object.hasOwn(row, 'recoveryOf') ? ['recoveryOf'] : [])]) ||
        typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id) ||
        typeof row.state !== 'string' || !STATES.includes(row.state) || !iso(row.enqueuedAt) || !iso(row.updatedAt) ||
        row.updatedAt < row.enqueuedAt || !Array.isArray(row.allowedWorkerIds) || row.allowedWorkerIds.length < 1 ||
        row.allowedWorkerIds.length > 32 || row.allowedWorkerIds.some((id) => typeof id !== 'string' || !workerIds.has(id)) ||
        new Set(row.allowedWorkerIds).size !== row.allowedWorkerIds.length ||
        !['read-only', 'workspace-write'].includes(String(row.mode)) ||
        !(row.workerId === null || typeof row.workerId === 'string' && row.allowedWorkerIds.includes(row.workerId)) ||
        !(row.outcome === null || typeof row.outcome === 'string' && OUTCOMES.includes(row.outcome)) ||
        !(row.reason === null || typeof row.reason === 'string' && /^[a-z0-9-]{1,120}$/.test(row.reason)) ||
        typeof row.taskDigest !== 'string' || !HASH.test(row.taskDigest)) throw new Error('Invalid resource supervisor job');
      if (Object.hasOwn(row, 'executionOwnerId') && (Number(value.schemaVersion) < 6 || typeof row.executionOwnerId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.executionOwnerId))) {
        throw new Error('Invalid task execution owner');
      }
      if (Object.hasOwn(row, 'executionDeadlineAt') && (!Object.hasOwn(row, 'executionOwnerId') || !iso(row.executionDeadlineAt))) {
        throw new Error('Invalid task execution deadline');
      }
      if (Object.hasOwn(row, 'recoveryOf')) {
        const prior = (value.jobs as DurableJob[]).find(job => job.id === row.recoveryOf);
        if (value.schemaVersion !== 7 || typeof row.recoveryOf !== 'string' || !ids.has(row.recoveryOf) || !prior ||
          prior.state !== 'cancelled' || prior.reason !== 'task-owner-unavailable' || prior.executionOwnerId === undefined ||
          row.executionOwnerId === undefined || row.executionDeadlineAt === undefined || row.executionDeadlineAt !== prior.executionDeadlineAt ||
          row.projectId !== prior.projectId || row.mode !== 'read-only' || prior.mode !== 'read-only' ||
          row.parent !== undefined || prior.parent !== undefined || row.retainHistory !== prior.retainHistory ||
          canonical(row.allowedWorkerIds) !== canonical(prior.allowedWorkerIds) ||
          row.id !== resourceConsoleRecoveryId(prior) ||
          (value.jobs as DurableJob[]).filter(job => job.recoveryOf === prior.id).length !== 1) {
          throw new Error('Invalid task recovery edge');
        }
      }
      if (Object.hasOwn(row, 'projectId') && (Number(value.schemaVersion) < 4 || typeof row.projectId !== 'string' ||
        row.projectId === 'default' || !projectBindings?.some((project) => project.id === row.projectId))) throw new Error('Invalid task project');
      if (retained) {
        if (value.schemaVersion === 1 || row.retainHistory !== true) throw new Error('Invalid history consent');
        const history = row.history;
        if (history !== null) {
          if (!object(history) || !exact(history, ['prompt', 'output']) || typeof history.prompt !== 'string' ||
            !history.prompt.trim() || history.prompt.includes('\0') || Buffer.byteLength(history.prompt) > 32 * 1024) throw new Error('Invalid task history');
          if (history.output !== null && (!object(history.output) || !exact(history.output, ['text', 'truncated']) ||
            typeof history.output.text !== 'string' || Buffer.byteLength(history.output.text) > MAX_HISTORY_OUTPUT_BYTES ||
            typeof history.output.truncated !== 'boolean' || row.state !== 'settled' || row.outcome !== 'completed')) {
            throw new Error('Invalid captured output');
          }
        }
      }
      let context: ResourceConsoleContextTurn[] | null = null;
      if (continuation) {
        const parent = validateResourceConsoleParent(row.parent);
        if (Number(value.schemaVersion) < 3 || !ids.has(parent.taskId) || typeof row.submissionDigest !== 'string' ||
          !HASH.test(row.submissionDigest)) throw new Error('Invalid conversation identity');
        const source = value.jobs.find((job: DurableJob) => job.id === parent.taskId) as DurableJob;
        if (source.projectId !== row.projectId) throw new Error('Conversation parent crosses project bindings');
        const needsContext = row.input !== null || retained && row.history !== null;
        if (needsContext) {
          context = validateResourceConsoleContext(row.context, row.id, parent.taskId);
          if (context.some((turn) => !ids.has(turn.taskId))) throw new Error('Conversation source identity unavailable');
          if (context.some((turn) =>
            (value.jobs as DurableJob[]).find((job) => job.id === turn.taskId)?.projectId !== row.projectId)) {
            throw new Error('Conversation context crosses project bindings');
          }
          const last = context.at(-1)!;
          if (!['settled', 'cancelled'].includes(source.state) || last.outcome !== source.outcome ||
            resourceConsoleTranscriptDigest(scopeFor(value, source), source, { prompt: last.prompt, output: last.output }, context.slice(0, -1)) !==
              parent.expectedTranscriptDigest) throw new Error('Conversation snapshot does not match its pinned parent');
          const ownPrompt = row.input !== null && object(row.input) ? row.input.prompt : object(row.history) ? row.history.prompt : null;
          if (typeof ownPrompt !== 'string' || Buffer.byteLength(resourceConsoleConversationPrompt(ownPrompt, context)) >
            MAX_RESOURCE_CONVERSATION_BYTES) throw new Error('Conversation snapshot exceeds its limit');
        } else if (row.context !== null) throw new Error('Terminal task retained context without consent');
      }
      if (row.state === 'queued' || row.state === 'dispatching') {
        const input = taskInput(row.input);
        if (input.id !== row.id || input.mode !== row.mode || canonical(input.allowedWorkerIds) !== canonical(row.allowedWorkerIds) ||
          input.projectId !== row.projectId ||
          digest(canonical(taskFor(input, context))) !== row.taskDigest || row.outcome !== null ||
          (input.parent !== undefined) !== continuation || continuation && (canonical(input.parent) !== canonical(row.parent) ||
            submissionDigestFor(input) !== row.submissionDigest) ||
          (input.retainHistory === true) !== retained || retained &&
          (!object(row.history) || row.history.prompt !== input.prompt || row.history.output !== null)) {
          throw new Error('Invalid queued task identity');
        }
      } else if (row.input !== null) throw new Error('Settled resource task retained private prompt');
      if (row.state === 'settled' && !['completed', 'failed', 'timed-out', 'cancelled'].includes(String(row.outcome))) throw new Error('Invalid settled outcome');
      if (row.state === 'settled' && row.workerId === null) throw new Error('Settled task has no worker');
      if (row.state === 'queued' && row.workerId !== null) throw new Error('Queued task already names a worker');
      if (row.state === 'unresolved' && row.outcome !== null && !['reserved', 'uncertain'].includes(String(row.outcome))) throw new Error('Invalid unresolved outcome');
      if (row.state === 'cancelled' && (row.outcome !== 'cancelled' || row.workerId !== null)) throw new Error('Invalid queued cancellation');
      ids.add(row.id);
    }
    const decoded = detached(value as unknown as DurableState);
    // A restored pending record must have the same guaranteed settlement space
    // as a newly admitted one; do not dispatch externally edited overfull state.
    if (decoded.schemaVersion !== 1) assertStateHeadroom(decoded);
    return decoded;
  }
  assertStateData(value);
  if (Buffer.byteLength(canonical(value)) > MAX_STATE_BYTES) throw new Error('Invalid resource supervisor state');
  return decode(value);
}

/** Offline transform only. Caller owns both stopped stores and publishes through its migration journal. */
export function previewResourceConsolePoolEvolution(value: unknown, options: {
  workspace: string;
  from: { pool: ResourcePool; bindings: ResourceBinding[] };
  to: { pool: ResourcePool; bindings: ResourceBinding[] };
  configHistory: ResourcePoolConfigSnapshot[];
}): ResourceConsoleDurableState | null {
  if (value === null) return null;
  const fromDigest = resourcePoolConfigSnapshot(options.from.pool, options.from.bindings).poolDigest;
  const configHistory = validateResourcePoolConfigHistory(options.configHistory);
  const fromIndex = configHistory.findIndex((row) => row.poolDigest === fromDigest);
  if (fromIndex < 0) throw new Error('Console origin missing from verified pool history');
  const previous = decodeResourceConsoleState(value, { ...options.from, workspace: options.workspace,
    configHistory: configHistory.slice(0, fromIndex + 1) });
  if (previous.jobs.some((job) => job.state === 'dispatching' || job.state === 'unresolved')) {
    throw new ResourceSupervisorError('CONFLICT', 'Settle unresolved console work before pool evolution');
  }
  const next: ResourceConsoleDurableState = { ...previous, schemaVersion: previous.schemaVersion >= 6 ? previous.schemaVersion : 5,
    originPoolDigest: previous.originPoolDigest ?? fromDigest };
  return decodeResourceConsoleState(next, { ...options.to, workspace: options.workspace, configHistory });
}

export interface ResourceConsoleProjectPreview {
  bindings: ResourceConsoleProjectBinding[] | undefined;
  projects: ResourceConsoleProject[] | undefined;
  registration: 'persisted' | 'would-register' | 'not-configured';
  changed: boolean;
}

/** Project registration projection only; never persists or replaces historical inode evidence. */
export function previewResourceConsoleProjects(options: {
  workspace: string; projects?: ResourceConsoleProjectInput[]; state?: ResourceConsoleDurableState;
}): ResourceConsoleProjectPreview {
  const configured = options.projects === undefined ? [] : validateResourceConsoleProjects(options.projects);
  const prior = options.state?.projects !== undefined && Number(options.state.schemaVersion) >= 4
    ? validateResourceConsoleProjectBindings(options.state.projects, options.workspace) : undefined;
  if (options.projects === undefined && !prior) {
    return { bindings: undefined, projects: undefined, registration: 'not-configured', changed: false };
  }
  // Legacy paths are pinned NOW in a proposed registration, not retroactively.
  const proposed = prior ? detached(prior) : [pinResourceConsoleProject({
    id: 'default', label: 'Default workspace', workspace: options.workspace,
  })];
  let added = !prior;
  for (const configuredProject of configured) {
    const existing = proposed.find((project) => project.id === configuredProject.id);
    if (existing) {
      if (existing.workspace !== configuredProject.workspace) throw new ResourceSupervisorError('CONFLICT', 'Resource project binding cannot be changed');
      existing.label = configuredProject.label;
    } else {
      if (proposed.length >= 32) throw new ResourceSupervisorError('CAPACITY', 'Resource project binding capacity reached');
      const pinned = pinResourceConsoleProject(configuredProject);
      if (proposed.some((project) => project.workspace === pinned.workspace || project.dev === pinned.dev && project.ino === pinned.ino)) {
        throw new ResourceSupervisorError('CONFLICT', 'Resource projects must identify distinct directories');
      }
      proposed.push(pinned); added = true;
    }
  }
  const enabled = new Set(['default', ...configured.map((project) => project.id)]);
  return { bindings: proposed, projects: proposed.map(({ dev: _dev, ino: _ino, ...project }) =>
    ({ ...project, enabled: enabled.has(project.id) })), registration: added ? 'would-register' : 'persisted',
    changed: !prior || canonical(prior) !== canonical(proposed) };
}

/** Scope is explicit and immutable; no input callback can alter the chosen worker bindings. */
export async function createResourcePoolSupervisor(options: ResourcePoolSupervisorOptions): Promise<ResourcePoolSupervisor> {
  const hostStopped = captureResourceExecutionVeto(options);
  const hasHostVeto = Object.hasOwn(options, 'isExecutionStopped');
  const taskVeto = Object.getOwnPropertyDescriptor(options, 'isTaskExecutionStopped');
  if (taskVeto && (!Object.hasOwn(taskVeto, 'value') || typeof taskVeto.value !== 'function') ||
    !taskVeto && 'isTaskExecutionStopped' in options) throw new Error('Invalid task execution veto');
  const readTaskVeto = taskVeto?.value as ((id: string) => unknown) | undefined;
  const taskLifetimes = new Map<string, ReturnType<typeof captureResourceEngineeringLifetime>>();
  const taskStopped = (id: string) => {
    if (hostStopped()) return true;
    const job = state.jobs.find(row => row.id === id);
    if (job?.executionOwnerId !== undefined && (job.executionOwnerId !== instanceId ||
      !taskLifetimes.has(id) || taskLifetimes.get(id)!.isStopped())) return true;
    if (!readTaskVeto) return false;
    try {
      const result = readTaskVeto(id);
      if (result instanceof Promise) void result.catch(() => {});
      return result !== false;
    } catch { return true; }
  };
  let pool: ResourcePool; let bindings: ResourceBinding[];
  const root = options.root; const workspace = options.workspace;
  const configuredCatalogValue = options.projects;
  const readObservations = options.readObservations; const signal = options.signal;
  const readUnavailableWorkerIds = options.readUnavailableWorkerIds === undefined ? () => [] : options.readUnavailableWorkerIds;
  const readQuotaUnavailableWorkerIds = options.readQuotaUnavailableWorkerIds === undefined ? () => [] : options.readQuotaUnavailableWorkerIds;
  const maxParallel = limit(options.maxParallel, 4, 16);
  const maxQueued = limit(options.maxQueued, 64, 64);
  const pollIntervalMs = limit(options.pollIntervalMs, 2000, 60_000, 20);
  const stoppedBeforeStart = () => { if (signal?.aborted) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor startup cancelled'); };
  stoppedBeforeStart();
  let configuredProjects: ResourceConsoleProjectInput[] = [];
  let projectBindings: ResourceConsoleProjectBinding[] | undefined;
  // This read is only a startup validation hint. The owned decoder below still
  // validates every byte before using any durable binding or queue record.
  let persistedCatalog = false;
  if (path(root)) {
    try { const source = readResourceJson(join(root, 'resource-console-state.json'), MAX_STATE_BYTES) as ResourceConsoleDurableState;
      persistedCatalog = source.schemaVersion === 4 || source.schemaVersion >= 5 && source.projects !== undefined; }
    catch { /* Missing/invalid state remains the owned decoder's responsibility. */ }
  }
  stoppedBeforeStart();
  try {
    if (process.platform === 'win32' || !path(root) || !path(workspace) ||
      !persistedCatalog && (realpathSync(workspace) !== workspace || !lstatSync(workspace).isDirectory()) ||
      typeof readObservations !== 'function' || typeof readUnavailableWorkerIds !== 'function' ||
      typeof readQuotaUnavailableWorkerIds !== 'function') throw new Error();
    const nested = relative(workspace, root);
    if (nested === '' || nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested)) throw new Error();
    if (configuredCatalogValue !== undefined || persistedCatalog) {
      const insideStore = relative(root, workspace);
      if (insideStore === '' || insideStore !== '..' && !insideStore.startsWith(`..${sep}`) && !isAbsolute(insideStore)) throw new Error();
    }
    configuredProjects = configuredCatalogValue === undefined ? [] : validateResourceConsoleProjects(configuredCatalogValue);
    for (const project of configuredProjects) {
      if (project.workspace === workspace) throw new Error();
      for (const [from, to] of [[project.workspace, root], [root, project.workspace]]) {
        const nested = relative(from!, to!);
        if (nested === '' || nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested)) throw new Error();
      }
    }
    pool = validateResourcePool(options.pool); bindings = validateResourceBindings(options.bindings, pool);
    validateResourceObservations(readObservations(), pool);
    // Read validates an existing ledger but never initializes a missing one.
    resourcePoolStatus(root, pool, bindings, []);
  } catch { throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource supervisor scope or evidence'); }
  const scopeDigest = digest(canonical({ pool, bindings, workspace }));
  const poolDigest = digest(canonical({ pool, bindings }));
  const configHistory = readResourcePoolHistory(root, pool, bindings);
  const epochs = consoleEpochs(configHistory, pool, bindings);
  const statePath = join(root, 'resource-console-state.json');
  const instanceId = randomUUID();
  const workerIds = new Set(pool.workers.map((worker) => worker.id));
  const enabledProjects = new Set(['default', ...configuredProjects.map((project) => project.id)]);
  function projectHold(projectId?: string): string | null {
    if (!projectBindings) return null;
    const id = projectId ?? 'default';
    if (!enabledProjects.has(id)) return 'project-not-enabled';
    const binding = projectBindings.find((project) => project.id === id);
    return binding && matchesResourceConsoleProject(binding) ? null : 'project-directory-unavailable';
  }

  const taskInput = (value: unknown) => consoleTaskCodec(workspace, workerIds, scopeDigest, projectBindings).taskInput(value);
  const taskFor = (input: ResourceConsoleTaskInput, context?: ResourceConsoleContextTurn[] | null) =>
    consoleTaskCodec(workspace, workerIds, scopeDigest, projectBindings).taskFor(input, context);
  const submissionDigestFor = (input: ResourceConsoleTaskInput) =>
    consoleTaskCodec(workspace, workerIds, scopeDigest, projectBindings).submissionDigestFor(input);
  function originFor(job: DurableJob): ResourcePoolConfigSnapshot {
    const id = state.schemaVersion >= 5 ? job.originPoolDigest ?? state.originPoolDigest : poolDigest;
    const epoch = typeof id === 'string' ? epochs.get(id) : undefined;
    if (!epoch) throw new ResourceSupervisorError('UNAVAILABLE', 'Console task origin unavailable');
    return epoch;
  }
  function originScope(job: DurableJob): string {
    const { pool, bindings } = originFor(job);
    return digest(canonical({ pool, bindings, workspace }));
  }
  function originCodec(job: DurableJob) {
    return consoleTaskCodec(workspace, new Set(originFor(job).pool.workers.map((worker) => worker.id)), originScope(job), projectBindings);
  }
  function decode(value: unknown): DurableState {
    const decoded = decodeResourceConsoleState(value, { pool, bindings, workspace, configHistory });
    projectBindings = decoded.projects;
    return decoded;
  }

  stoppedBeforeStart();
  if (!existsSync(root)) {
    if (realpathSync(dirname(root)) !== dirname(root) || !lstatSync(dirname(root)).isDirectory()) {
      throw new ResourceSupervisorError('INVALID_INPUT', 'Resource supervisor store parent unavailable');
    }
    mkdirSync(root, { mode: 0o700 }); fsyncDirectory(dirname(root));
  }
  inspectPrivateDirectory(root);
  if (!assurePrivateStoragePath(root, 'directory', 'inspect-existing', { anchorPath: root }).ok) {
    throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor store unavailable');
  }
  stoppedBeforeStart();
  const lock = acquireLocalStoreLock(join(root, '.resource-console.lock'), 100, { anchorPath: root, exactPrivateStorage: true });
  if (!lock) throw new ResourceSupervisorError('CONFLICT', 'Resource supervisor already owned or unavailable');
  let state: DurableState = { schemaVersion: 1, scopeDigest, paused: false, jobs: [] };
  let persistedDigest: string | null = null;
  let error: string | null = null;
  let sourceError: string | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = 0;
  const active = new Map<string, { controller: AbortController; promise: Promise<void>; workerStarted: boolean }>();
  const attemptedAt = new Map<string, number>();
  const dispatched = new Set<string>();
  const outputs = new Map<string, ResourceConsoleOutput>();
  let outputBytes = 0;

  function fault(code: string): void {
    error ??= code;
    if (timer) { clearTimeout(timer); timer = null; }
    for (const owned of active.values()) owned.controller.abort();
  }
  function own(): void {
    if (!ownsLocalStoreLock(lock)) { fault('supervisor-ownership-lost'); throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor ownership lost'); }
  }
  function persist(next: DurableState): void {
    own();
    const temporary = join(root, `.resource-console-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      const before = entryExists(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (before !== persistedDigest) throw new Error('State identity changed');
      const bytes = Buffer.from(canonical(next) + '\n');
      if (bytes.length > MAX_STATE_BYTES) throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor state capacity reached');
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let offset = 0;
      while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written < 1) throw new Error('Incomplete state write'); offset += written; }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      own();
      const current = entryExists(statePath) ? digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) : null;
      if (current !== persistedDigest) throw new Error('State identity changed');
      renameSync(temporary, statePath); fsyncDirectory(root); own();
      state = next; persistedDigest = digest(canonical(next));
    } catch (cause) {
      if (cause instanceof ResourceSupervisorError && cause.code === 'CAPACITY') throw cause;
      fault('supervisor-persistence-unavailable');
      throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor state unavailable');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* Only this exact private temporary file. */ }
    }
  }
  function update(id: string, patch: Partial<DurableJob>): void {
    const next = detached(state); const job = next.jobs.find((row) => row.id === id);
    if (!job) throw new ResourceSupervisorError('NOT_FOUND', 'Resource supervisor job unavailable');
    Object.assign(job, patch, { updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() });
    persist(next);
  }
  function publicJob(job: DurableJob): ResourceSupervisorJob {
    const { taskDigest: _digest, input: _input, retainHistory: _consent, history,
      submissionDigest: _submission, context: _context, originPoolDigest: _origin,
      executionOwnerId: _owner, executionDeadlineAt: _deadline, recoveryOf: _recovery, ...publicFields } = job;
    return detached({ ...publicFields, cancellable: !closing && !error && (job.state === 'queued' || job.state === 'dispatching' && active.has(job.id)),
      outputAvailable: outputs.has(job.id), ...(history ? { historyAvailable: true as const } : {}) });
  }
  function ensureAvailable(): void {
    if (closing || error) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor unavailable');
    own();
  }
  function receiptFor(job: DurableJob, receipts: ResourceTaskReceipt[]): ResourceTaskReceipt | undefined {
    const receipt = receipts.find((row) => row.id === job.id);
    if (receipt && (receipt.taskDigest !== job.taskDigest || receipt.poolDigest !== originFor(job).poolDigest ||
      !job.allowedWorkerIds.includes(receipt.workerId))) throw new ResourceSupervisorError('CONFLICT', 'Task receipt identity mismatch');
    return receipt;
  }
  function settle(job: DurableJob, receipt: ResourceTaskReceipt | undefined, reason: string, output?: string): void {
    const terminal = receipt && !['reserved', 'uncertain'].includes(receipt.status);
    const history = state.jobs.find((row) => row.id === job.id)?.history;
    // Supervisor terminal state and captured text publish together. A recovered receipt
    // without its fresh return value cannot reconstruct or regenerate output.
    update(job.id, { state: terminal ? 'settled' : 'unresolved', workerId: receipt?.workerId ?? null,
      outcome: receipt?.status ?? null, reason: receipt?.reason ?? reason, input: null,
      ...(job.parent && !history ? { context: null } : {}),
      ...(history && receipt?.status === 'completed' && output !== undefined
        ? { history: { prompt: history.prompt, output: boundedOutput(output, MAX_HISTORY_OUTPUT_BYTES) } } : {}) });
  }
  function retainOutput(id: string, text: string): void {
    const retained = boundedOutput(text, MAX_OUTPUT_BYTES); const bytes = Buffer.byteLength(retained.text);
    while (outputBytes + bytes > MAX_TOTAL_OUTPUT_BYTES && outputs.size) {
      const first = outputs.keys().next().value!; outputBytes -= Buffer.byteLength(outputs.get(first)!.text); outputs.delete(first);
    }
    outputs.set(id, { id, ...retained, retention: 'this-console-session' }); outputBytes += bytes;
  }
  function schedule(delay = pollIntervalMs): void {
    if (closing || error) return;
    const at = performance.now() + delay;
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => { timer = null; pump(); }, delay);
  }
  function start(job: DurableJob, observations: ResourceObservation[], unavailableWorkerIds: string[], quotaUnavailableWorkerIds: string[]): void {
    if (!job.input) throw new Error('Queued task input unavailable');
    const initialProjectHold = recoveryHold(job.recoveryOf) ?? (taskStopped(job.id) ? 'host-execution-stopped' : projectHold(job.projectId));
    if (initialProjectHold) { if (job.reason !== initialProjectHold) update(job.id, { reason: initialProjectHold }); return; }
    update(job.id, { state: 'dispatching', reason: 'dispatch-requested', workerId: null });
    // Publish the supervisor's irreversible intent before entering the runtime.
    // A crash anywhere after this point is never recovered by replaying input.
    const controller = new AbortController(); const owned = { controller, promise: Promise.resolve(), workerStarted: false };
    active.set(job.id, owned);
    dispatched.add(job.id);
    attemptedAt.set(job.id, performance.now());
    const input = taskFor(job.input, job.context);
    let admissionProjectHold: string | null = null;
    owned.promise = runResourceTask({ root, pool, bindings, observations, task: input, signal: controller.signal,
      unavailableWorkerIds, quotaUnavailableWorkerIds,
      beforeWorkerDispatch: () => {
        // Runtime invokes this only for this call's fresh reservation, never
        // replay. An active scheduler promise alone is not transport custody.
        owned.workerStarted = recoveryHold(job.recoveryOf) === null && !taskStopped(job.id) && projectHold(job.projectId) === null;
        return owned.workerStarted;
      },
      ...(projectBindings || hasHostVeto || readTaskVeto || job.executionOwnerId ? { readAdmissionEvidence: () => {
        admissionProjectHold = recoveryHold(job.recoveryOf) ?? (taskStopped(job.id) ? 'host-execution-stopped' : projectHold(job.projectId));
        return { observations, unavailableWorkerIds: admissionProjectHold ? [...workerIds] : unavailableWorkerIds, quotaUnavailableWorkerIds };
      } } : {}) }).then((result) => {
      if (result.replayed || !result.receipt) dispatched.delete(job.id);
      if (!result.receipt) {
        update(job.id, { state: controller.signal.aborted || closing ? 'cancelled' : 'queued',
          outcome: controller.signal.aborted || closing ? 'cancelled' : null, workerId: null,
          input: controller.signal.aborted || closing ? null : job.input, reason: admissionProjectHold ?? 'no-eligible-capacity',
          ...((controller.signal.aborted || closing) && job.parent && !job.history ? { context: null } : {}) });
      } else {
        const recorded = resourcePoolStatus(root, pool, bindings, []).attempts;
        const receipt = receiptFor(job, recorded);
        if (!receipt || canonical(receipt) !== canonical(result.receipt)) throw new Error('Settlement evidence mismatch');
        settle(job, receipt, 'settlement-unavailable', !result.replayed && result.output !== null ? result.output : undefined);
        if (receipt.status === 'completed' && !result.replayed && result.output !== null) retainOutput(job.id, result.output);
      }
    }).catch(() => {
      if (error) return;
      try { settle(job, receiptFor(job, resourcePoolStatus(root, pool, bindings, []).attempts), 'dispatch-settlement-unavailable'); }
      catch (cause) {
        if (cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT') {
          dispatched.delete(job.id);
          try { settle(job, undefined, 'task-identity-conflict'); } catch { fault('supervisor-settlement-unavailable'); }
        } else fault('supervisor-settlement-unavailable');
      }
    }).finally(() => { active.delete(job.id); schedule(0); });
    try {
      const reserved = receiptFor(job, resourcePoolStatus(root, pool, bindings, []).attempts);
      if (reserved?.status === 'reserved') update(job.id, { workerId: reserved.workerId });
    } catch (cause) {
      // The attached settlement handler isolates a competing runtime identity.
      if (!(cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT')) throw cause;
    }
  }
  function admissionConstraint(): { account: string[]; quota: string[] } | null {
    try { return { account: validateUnavailableResourceWorkerIds(readUnavailableWorkerIds(), pool),
      quota: validateUnavailableResourceWorkerIds(readQuotaUnavailableWorkerIds(), pool) }; }
    catch { sourceError = 'supervisor-admission-constraint-unavailable'; return null; }
  }
  function pump(): void {
    if (closing || error) return;
    try {
      own();
      let observations: ResourceObservation[];
      try { observations = validateResourceObservations(readObservations(), pool); sourceError = null; }
      catch {
        // A quota-file update is not authority to cancel already-admitted work.
        // Keep the queue and controls available, but do not admit more work until
        // the same pinned observation source becomes readable again.
        sourceError = 'supervisor-observations-unavailable'; schedule(); return;
      }
      if (admissionConstraint() === null) { schedule(); return; }
      if (!state.paused) {
        // Oldest-attempt-first remains fair even when one disk transaction takes
        // longer than the configured retry interval. New jobs begin unattempted.
        const jobs = [...state.jobs].sort((left, right) => (attemptedAt.get(left.id) ?? -1) - (attemptedAt.get(right.id) ?? -1));
        for (const job of jobs) {
          if (closing || error || state.paused || active.size >= maxParallel) break;
          if (job.state !== 'queued') continue;
          if (performance.now() - (attemptedAt.get(job.id) ?? -Infinity) < pollIntervalMs) continue;
          // Capture a fresh, detached gate for this particular admission. The
          // callback itself may cancel or pause its owner synchronously.
          const unavailableWorkerIds = admissionConstraint();
          if (unavailableWorkerIds === null || closing || error || state.paused) break;
          if (state.jobs.find((row) => row.id === job.id)?.state !== 'queued') continue;
          const status = resourcePoolStatus(root, pool, bindings, observations, unavailableWorkerIds.account, unavailableWorkerIds.quota);
          let receipt: ResourceTaskReceipt | undefined;
          try { receipt = receiptFor(job, status.attempts); }
          catch (cause) {
            if (!(cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT')) throw cause;
            settle(job, undefined, 'task-identity-conflict'); continue;
          }
          if (receipt) { settle(job, receipt, 'existing-receipt-unresolved'); continue; }
          if (originFor(job).poolDigest !== poolDigest) {
            if (job.reason !== 'pool-evolution-reenrollment-required') update(job.id, { reason: 'pool-evolution-reenrollment-required' });
            continue;
          }
          const projectReason = projectHold(job.projectId);
          if (projectReason) { if (job.reason !== projectReason) update(job.id, { reason: projectReason }); continue; }
          // Even a denied admission persists new quota evidence in the existing
          // runtime. Recently denied jobs are skipped until their retry interval,
          // so they cannot starve other enrolled workers behind them in the queue.
          start(job, observations, unavailableWorkerIds.account, unavailableWorkerIds.quota);
        }
      }
    } catch { fault('supervisor-evidence-unavailable'); }
    schedule();
  }

  function recoveryHold(recoveryOf?: string): string | null {
    if (!recoveryOf) return null;
    try {
      const attempts = resourcePoolStatus(root, pool, bindings, []).attempts;
      const seen = new Set<string>(); let id: string | undefined = recoveryOf;
      while (id) {
        const prior = state.jobs.find(row => row.id === id);
        if (seen.has(id) || !prior || prior.state !== 'cancelled' || prior.reason !== 'task-owner-unavailable' ||
          prior.executionOwnerId === undefined || prior.mode !== 'read-only' || prior.parent ||
          originFor(prior).poolDigest !== poolDigest || attempts.some(row => row.id === id)) return 'task-recovery-evidence-unavailable';
        seen.add(id); id = prior.recoveryOf;
      }
      return null;
    } catch { return 'task-recovery-evidence-unavailable'; }
  }
  function submitTask(value: ResourceConsoleTaskInput, lifetime?: ResourceEngineeringLifetime, recoveryOf?: string): ResourceSupervisorJob {
      ensureAvailable();
      const admissionDigest = persistedDigest;
      const child = captureResourceEngineeringLifetime(lifetime === undefined ? {} : { engineeringLifetime: lifetime });
      // Choose the historical codec without invoking an unvalidated accessor.
      const descriptor = object(value) ? Object.getOwnPropertyDescriptor(value, 'id') : undefined;
      const previous = descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
        ? state.jobs.find((job) => job.id === descriptor.value) : undefined;
      const retryCodec = previous ? originCodec(previous) : null;
      const input = retryCodec ? retryCodec.taskInput(value) : taskInput(value);
      if (previous) {
        if (recoveryOf !== undefined && previous.recoveryOf !== recoveryOf) {
          throw new ResourceSupervisorError('CONFLICT', 'Resource task recovery identity already used');
        }
        // A retry may observe terminal evidence, but cannot adopt a lost owner,
        // convert ordinary work to mission work, or replace the original veto.
        if ((previous.executionOwnerId !== undefined) !== child.configured ||
          child.configured && (previous.executionDeadlineAt !== child.deadlineAt ||
            ['queued', 'dispatching'].includes(previous.state) && previous.executionOwnerId !== instanceId)) {
          throw new ResourceSupervisorError('CONFLICT', 'Resource task execution owner already set');
        }
        if (previous.projectId !== input.projectId) throw new ResourceSupervisorError('CONFLICT', 'Resource task project already set');
        // Retry the accepted identity before looking up a potentially deleted
        // source. A retry is never permission to rebuild context or restore text.
        if (previous.parent) {
          if (!input.parent || previous.submissionDigest !== retryCodec!.submissionDigestFor(input)) {
            throw new ResourceSupervisorError('CONFLICT', 'Resource conversation identity already used');
          }
          return publicJob(previous);
        }
        if (input.parent || previous.taskDigest !== digest(canonical(retryCodec!.taskFor(input)))) {
          throw new ResourceSupervisorError('CONFLICT', 'Resource task identity already used');
        }
        if ((previous.retainHistory === true) !== (input.retainHistory === true)) {
          throw new ResourceSupervisorError('CONFLICT', 'Resource task retention consent already set');
        }
        return publicJob(previous);
      }
      const projectReason = child.isStopped() || taskStopped(input.id) ? 'host-execution-stopped' : projectHold(input.projectId);
      if (projectReason) throw new ResourceSupervisorError('UNAVAILABLE', projectReason);
      if (state.jobs.length >= MAX_RESOURCE_SUPERVISOR_JOBS || state.jobs.filter((job) => job.state === 'queued').length >= maxQueued) {
        throw new ResourceSupervisorError('CAPACITY', 'Resource supervisor history or queue capacity reached');
      }
      let context: ResourceConsoleContextTurn[] | undefined;
      if (input.parent) {
        const parent = state.jobs.find((job) => job.id === input.parent!.taskId);
        if (!parent?.history) throw new ResourceSupervisorError('NOT_FOUND', 'Parent transcript is unavailable or deleted');
        if (parent.projectId !== input.projectId) throw new ResourceSupervisorError('CONFLICT', 'Follow-up must remain in its parent project');
        if (parent.state !== 'settled' && parent.state !== 'cancelled') {
          throw new ResourceSupervisorError('CONFLICT', 'Parent task has not reached terminal settlement');
        }
        if (resourceConsoleTranscriptDigest(originScope(parent), parent, parent.history, parent.context) !== input.parent.expectedTranscriptDigest) {
          throw new ResourceSupervisorError('CONFLICT', 'Parent transcript changed; refresh before continuing');
        }
        context = validateResourceConsoleContext([...(parent.context ?? []), { taskId: parent.id,
          prompt: parent.history.prompt, output: parent.history.output, outcome: parent.outcome }], input.id, parent.id);
      }
      const taskDigest = digest(canonical(taskFor(input, context)));
      let previousRuntime: ResourceTaskReceipt | undefined;
      try { previousRuntime = resourcePoolStatus(root, pool, bindings, []).attempts.find((row) => row.id === input.id); }
      catch { throw new ResourceSupervisorError('UNAVAILABLE', 'Resource task evidence unavailable'); }
      if (previousRuntime && (previousRuntime.taskDigest !== taskDigest || previousRuntime.poolDigest !== poolDigest)) {
        throw new ResourceSupervisorError('CONFLICT', 'Resource task identity already used');
      }
      if (recoveryOf && (previousRuntime || recoveryHold(recoveryOf))) {
        throw new ResourceSupervisorError('CONFLICT', 'Resource task recovery evidence unavailable');
      }
      // Host callbacks can synchronously submit, cancel, pause or close. Never
      // publish an intent built before such a change, even when they return false.
      ensureAvailable();
      if (persistedDigest !== admissionDigest) throw new ResourceSupervisorError('CONFLICT', 'Resource queue changed during admission');
      const now = new Date().toISOString();
      const job: DurableJob = { id: input.id, state: 'queued', enqueuedAt: now, updatedAt: now,
        allowedWorkerIds: [...input.allowedWorkerIds], mode: input.mode, workerId: null, outcome: null, reason: null, input, taskDigest,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(state.schemaVersion >= 5 ? { originPoolDigest: poolDigest } : {}),
        ...(child.configured ? { executionOwnerId: instanceId, ...(child.deadlineAt ? { executionDeadlineAt: child.deadlineAt } : {}) } : {}),
        ...(recoveryOf ? { recoveryOf } : {}),
        ...(input.parent ? { parent: detached(input.parent), submissionDigest: submissionDigestFor(input), context: context! } : {}),
        ...(input.retainHistory === true ? { retainHistory: true as const, history: { prompt: input.prompt, output: null } } : {}) };
      const next: DurableState = { ...detached(state), schemaVersion: recoveryOf || state.schemaVersion === 7 ? 7 : child.configured ? 6 : state.schemaVersion >= 4 ? state.schemaVersion : input.parent ? 3 :
        state.schemaVersion === 1 && input.retainHistory === true ? 2 : state.schemaVersion,
        ...(child.configured ? { originPoolDigest: state.originPoolDigest ?? poolDigest } : {}),
        jobs: [...detached(state.jobs), job] };
      assertStateHeadroom(next); persist(next);
      if (child.configured) taskLifetimes.set(job.id, child);
      schedule(0); return publicJob(job);
  }

  const supervisor: ResourcePoolSupervisor = {
    engineeringBinding(projectId) {
      ensureAvailable();
      if (typeof projectId !== 'string' || !ID.test(projectId)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource project');
      if (!projectBindings || state.schemaVersion < 4) throw new ResourceSupervisorError('UNAVAILABLE', 'Register engineering projects first');
      const project = projectBindings.find((row) => row.id === projectId);
      if (!project) throw new ResourceSupervisorError('NOT_FOUND', 'Resource project was not found');
      return { project: detached(project), root, poolDigest };
    },
    projectExecutionBinding(projectId) {
      ensureAvailable();
      if (hostStopped()) throw new ResourceSupervisorError('UNAVAILABLE', 'Host execution stopped');
      if (state.paused) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor is paused');
      return supervisor.projectFileBinding(projectId);
    },
    projectFileBinding(projectId) {
      ensureAvailable();
      if (typeof projectId !== 'string' || !ID.test(projectId)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource project');
      if (!projectBindings || state.schemaVersion < 4) throw new ResourceSupervisorError('UNAVAILABLE', 'Register projects before browsing files.');
      const binding = projectBindings.find((project) => project.id === projectId);
      if (!binding) throw new ResourceSupervisorError('NOT_FOUND', 'Resource project was not found');
      const reason = projectHold(projectId);
      if (reason) throw new ResourceSupervisorError('UNAVAILABLE', reason);
      return detached(binding);
    },
    projects() {
      return projectBindings ? detached(projectBindings.map(({ dev: _dev, ino: _ino, ...project }) =>
        ({ ...project, enabled: enabledProjects.has(project.id) }))) : undefined;
    },
    snapshot() {
      if (!closing && !error) { try { own(); } catch { /* Snapshot reports loss without private diagnostics. */ } }
      return { instanceId, paused: state.paused, closing, error: error ?? sourceError, maxParallel, maxQueued,
        activeCount: active.size, queuedCount: state.jobs.filter((job) => job.state === 'queued').length,
        jobs: state.jobs.map(publicJob) };
    },
    submit: (value, lifetime) => submitTask(value, lifetime),
    recover(value, lifetime) {
      ensureAvailable();
      const child = captureResourceEngineeringLifetime({ engineeringLifetime: lifetime });
      const input = taskInput(value);
      if (!child.deadlineAt || input.mode !== 'read-only' || input.parent) {
        throw new ResourceSupervisorError('INVALID_INPUT', 'Recovery requires a deadline-bound read-only task');
      }
      const chain = resourceConsoleTaskContinuation(state, taskFor(input), input.projectId, child.deadlineAt);
      if (chain.some(row => originFor(row).poolDigest !== poolDigest || (row.retainHistory === true) !== (input.retainHistory === true))) {
        throw new ResourceSupervisorError('CONFLICT', 'Resource task recovery scope changed');
      }
      const previous = chain.at(-1);
      if (!previous || previous.state !== 'cancelled') return submitTask({ ...input, ...(previous ? { id: previous.id } : {}) }, lifetime);
      if (state.paused || child.isStopped()) throw new ResourceSupervisorError('UNAVAILABLE', 'host-execution-stopped');
      if (recoveryHold(previous.id)) throw new ResourceSupervisorError('CONFLICT', 'Resource task recovery evidence unavailable');
      return submitTask({ ...input, id: resourceConsoleRecoveryId(previous) },
        { deadlineAt: child.deadlineAt, isExecutionStopped: child.isStopped }, previous.id);
    },
    ownsActiveTaskReceipt(receipt) {
      try {
        ensureAvailable();
        if (receipt.status !== 'reserved' || receipt.origin !== undefined) return false;
        const job = state.jobs.find((row) => row.id === receipt.id);
        const owned = active.get(receipt.id);
        return !!job && !!owned?.workerStarted && !owned.controller.signal.aborted && job.state === 'dispatching' &&
          job.taskDigest === receipt.taskDigest && originFor(job).poolDigest === receipt.poolDigest &&
          job.allowedWorkerIds.includes(receipt.workerId) && (job.workerId === null || job.workerId === receipt.workerId);
      } catch { return false; }
    },
    cancel(id, expectedTaskDigest) {
      ensureAvailable(); if (typeof id !== 'string' || !ID.test(id)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource task id');
      if (expectedTaskDigest !== undefined && (typeof expectedTaskDigest !== 'string' || !HASH.test(expectedTaskDigest))) {
        throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid expected task digest');
      }
      const job = state.jobs.find((row) => row.id === id);
      if (!job) throw new ResourceSupervisorError('NOT_FOUND', 'Resource task unavailable');
      // Compare before changing queued state or signalling an active worker.
      // A matching ID alone must not let an old mission cancel a different envelope.
      if (expectedTaskDigest !== undefined && job.taskDigest !== expectedTaskDigest) {
        throw new ResourceSupervisorError('CONFLICT', 'Resource task identity changed');
      }
      if (job.state === 'queued') update(id, { state: 'cancelled', outcome: 'cancelled', input: null, reason: 'queued-task-cancelled',
        ...(job.parent && !job.history ? { context: null } : {}) });
      else if (active.has(id)) { update(id, { reason: 'cancellation-requested' }); active.get(id)!.controller.abort(); }
      else if (job.state === 'dispatching' || job.state === 'unresolved') throw new ResourceSupervisorError('CONFLICT', 'Resource task is not owned by this console');
      return publicJob(state.jobs.find((row) => row.id === id)!);
    },
    async cancelAndDrain(id, expectedTaskDigest) {
      if (typeof expectedTaskDigest !== 'string' || !HASH.test(expectedTaskDigest)) {
        throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid expected task digest');
      }
      const verifyState = () => {
        ensureAvailable();
        if (digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) !== persistedDigest) {
          throw new ResourceSupervisorError('UNAVAILABLE', 'Resource task state changed');
        }
      };
      verifyState();
      // Capture this task's owning promise before cancellation. Never join the
      // whole supervisor: other human tasks retain their independent lifetime.
      const owned = active.get(id);
      supervisor.cancel(id, expectedTaskDigest);
      if (owned) await owned.promise;
      verifyState();
      const job = state.jobs.find((row) => row.id === id);
      if (!job || job.taskDigest !== expectedTaskDigest || active.has(id) || !['settled', 'cancelled'].includes(job.state)) {
        throw new ResourceSupervisorError('UNAVAILABLE', 'Resource task settlement unconfirmed');
      }
      const receipt = receiptFor(job, resourcePoolStatus(root, pool, bindings, []).attempts);
      if (receipt ? ['reserved', 'uncertain'].includes(receipt.status) || job.state !== 'settled' ||
        receipt.status !== job.outcome || receipt.workerId !== job.workerId : dispatched.has(id) || job.state === 'settled') {
        throw new ResourceSupervisorError('UNAVAILABLE', 'Resource task settlement unconfirmed');
      }
      return publicJob(job);
    },
    setPaused(paused) {
      ensureAvailable(); if (typeof paused !== 'boolean') throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid pause state');
      if (state.paused !== paused) persist({ ...detached(state), paused });
      schedule(0); return supervisor.snapshot();
    },
    output(id) { const value = outputs.get(id); return value ? detached(value) : null; },
    history(id) {
      ensureAvailable();
      if (typeof id !== 'string' || !ID.test(id)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource task id');
      const job = state.jobs.find((row) => row.id === id);
      return job?.history ? detached({ id, ...job.history, retention: 'local-until-deleted' as const,
        transcriptDigest: resourceConsoleTranscriptDigest(originScope(job), job, job.history, job.context),
        ...(job.projectId ? { projectId: job.projectId } : {}),
        ...(job.parent ? { parent: job.parent, context: job.context! } : {}) }) : null;
    },
    deleteHistory(id) {
      ensureAvailable();
      if (typeof id !== 'string' || !ID.test(id)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource task id');
      const job = state.jobs.find((row) => row.id === id);
      if (!job) throw new ResourceSupervisorError('NOT_FOUND', 'Resource task unavailable');
      if (job.state !== 'settled' && job.state !== 'cancelled') {
        throw new ResourceSupervisorError('CONFLICT', 'Task history can be deleted only after terminal settlement');
      }
      // Consent and task identity remain, so identical retries cannot restore
      // deliberately removed text or acquire a second runtime allowance.
      if (job.history) update(id, { history: null, ...(job.parent ? { context: null } : {}) });
      const ephemeral = outputs.get(id);
      if (ephemeral) { outputBytes -= Buffer.byteLength(ephemeral.text); outputs.delete(id); }
      return publicJob(state.jobs.find((row) => row.id === id)!);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; if (timer) { clearTimeout(timer); timer = null; }
      signal?.removeEventListener('abort', onAbort);
      for (const owned of active.values()) owned.controller.abort();
      closePromise = Promise.allSettled([...active.values()].map((owned) => owned.promise)).then(() => {
        outputs.clear(); outputBytes = 0;
        try {
          if (dispatched.size) {
            const receipts = resourcePoolStatus(root, pool, bindings, []).attempts;
            for (const id of dispatched) {
              const job = state.jobs.find((row) => row.id === id)!; const receipt = receiptFor(job, receipts);
              if (!receipt || ['reserved', 'uncertain'].includes(receipt.status)) error ??= 'supervisor-termination-unconfirmed';
            }
          }
        } catch { error ??= 'supervisor-termination-unconfirmed'; }
        if (!releaseLocalStoreLock(lock)) { fault('supervisor-release-uncertain'); }
        if (error) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor closed with unresolved evidence');
      });
      return closePromise;
    },
  };
  function onAbort(): void { void supervisor.close().catch(() => {}); }
  try {
    stoppedBeforeStart();
    if (entryExists(statePath)) {
      const source = readResourceJson(statePath, MAX_STATE_BYTES); state = decode(source); persistedDigest = digest(canonical(source));
    }
    const receipts = resourcePoolStatus(root, pool, bindings, []).attempts;
    const recovered = detached(state); let changed = persistedDigest === null;
    if (configuredCatalogValue !== undefined || state.projects !== undefined) {
      const preview = previewResourceConsoleProjects({ workspace, projects: configuredCatalogValue === undefined ? undefined : configuredProjects, state });
      projectBindings = preview.bindings;
      if (preview.changed) {
        recovered.schemaVersion = state.schemaVersion >= 5 ? state.schemaVersion : 4;
        recovered.projects = detached(preview.bindings!); assertStateHeadroom(recovered); changed = true;
      }
    }
    for (const job of recovered.jobs) {
      if (job.state !== 'dispatching' && job.state !== 'queued') continue;
      let receipt: ResourceTaskReceipt | undefined;
      try { receipt = receiptFor(job, receipts); }
      catch (cause) {
        if (!(cause instanceof ResourceSupervisorError && cause.code === 'CONFLICT')) throw cause;
        Object.assign(job, { state: 'unresolved', workerId: null, outcome: null, reason: 'task-identity-conflict', input: null,
          ...(job.parent && !job.history ? { context: null } : {}),
          updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() }); changed = true; continue;
      }
      if (job.state === 'queued' && !receipt) {
        // No dispatch occurred, but the in-process parent is gone. Cancel only
        // this abandoned child; ordinary queued human work retains its replay.
        if (job.executionOwnerId !== undefined) {
          Object.assign(job, { state: 'cancelled', outcome: 'cancelled', reason: 'task-owner-unavailable', input: null,
            ...(job.parent && !job.history ? { context: null } : {}),
            updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() }); changed = true;
        }
        continue;
      }
      const terminal = receipt && !['reserved', 'uncertain'].includes(receipt.status);
      Object.assign(job, { state: terminal ? 'settled' : 'unresolved', workerId: receipt?.workerId ?? null,
        outcome: receipt?.status ?? null, reason: receipt?.reason ?? 'previous-dispatch-unresolved', input: null,
        ...(job.parent && !job.history ? { context: null } : {}),
        updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() }); changed = true;
    }
    stoppedBeforeStart(); if (changed) persist(recovered);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { await supervisor.close(); throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor startup cancelled'); }
    const ownsActiveReceipt = supervisor.ownsActiveTaskReceipt.bind(supervisor);
    supervisorCustodies.set(supervisor, () => {
      ensureAvailable();
      if (hostStopped() || signal?.aborted || state.paused || persistedDigest === null ||
        digest(canonical(readResourceJson(statePath, MAX_STATE_BYTES))) !== persistedDigest ||
        digest(canonical(state)) !== persistedDigest || state.jobs.some(job => job.state === 'unresolved' ||
          job.state === 'dispatching' && (!active.has(job.id) || active.get(job.id)!.controller.signal.aborted || taskStopped(job.id)))) {
        throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor custody unavailable');
      }
      // Copy the exact known identities for this sample. Never infer ownership
      // from a task prefix or from the absence of an engineering origin alone.
      const jobs = detached(state.jobs);
      return Object.freeze({ root, workspace, poolDigest, lock, stateDigest: persistedDigest,
        ownsReceipt(receipt: ResourceTaskReceipt) {
          if (receipt.origin !== undefined || receipt.status === 'uncertain') return false;
          if (receipt.status === 'reserved') return ownsActiveReceipt(receipt);
          return jobs.some(job => job.id === receipt.id && job.taskDigest === receipt.taskDigest &&
            originFor(job).poolDigest === receipt.poolDigest && job.allowedWorkerIds.includes(receipt.workerId) &&
            job.state === 'settled' && job.workerId === receipt.workerId && job.outcome === receipt.status);
        },
        ownsSettledReservation(receipt: ResourceTaskReceipt) {
          try {
            // A worker may have read the reservation just before its human
            // task settled. Re-prove live custody and the actual terminal row;
            // never infer settlement from a task ID, elapsed time or old sample.
            const fresh = readResourceSupervisorCustody(supervisor);
            if (receipt.status !== 'reserved' || receipt.origin !== undefined) return false;
            const terminal = resourcePoolStatus(root, pool, bindings, []).attempts.find(row => row.id === receipt.id);
            if (!terminal || !['completed', 'failed', 'timed-out', 'cancelled'].includes(terminal.status) ||
              !fresh.ownsReceipt(terminal)) return false;
            const { execution: _execution, nativeProcess: _nativeProcess, ...base } = terminal;
            const reservation = { ...base, status: 'reserved', finishedAt: null, outputDigest: null,
              inputTokens: null, outputTokens: null, reason: 'task-reserved' };
            return Object.keys(receipt).sort().join(',') === Object.keys(reservation).sort().join(',') &&
              canonical(receipt) === canonical(reservation);
          } catch { return false; }
        } });
    });
    schedule(0); return supervisor;
  } catch (cause) {
    signal?.removeEventListener('abort', onAbort); if (timer) clearTimeout(timer);
    releaseLocalStoreLock(lock);
    if (cause instanceof ResourceSupervisorError) throw cause;
    throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor state unavailable');
  }
}

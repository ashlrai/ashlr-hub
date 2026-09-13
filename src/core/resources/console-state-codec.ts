/** Pure console identity and schema1–7 validation; no owner or storage effects. */
import { canonical, digest } from '../universe/artifacts.js';
import { validateResourcePool, type ResourcePool } from './pool-policy.js';
import { validateResourceTask, type ResourcePoolConfigSnapshot, type ResourceTask } from './pool-runtime.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';
import { resourcePoolConfigSnapshot, validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import { MAX_RESOURCE_CONVERSATION_BYTES, resourceConsoleConversationPrompt, resourceConsoleTranscriptDigest,
  validateResourceConsoleContext, validateResourceConsoleParent } from './console-conversation.js';
import { validateResourceConsoleProjectBindings, type ResourceConsoleProjectBinding } from './console-projects.js';
import type { ResourceConsoleContextTurn, ResourceConsoleTaskInput, ResourceConsoleTranscript, ResourceSupervisorJob } from './console-types.js';

export class ResourceSupervisorError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'CAPACITY' | 'UNAVAILABLE' | 'NOT_FOUND', message: string) {
    super(message); this.name = 'ResourceSupervisorError';
  }
}
export const MAX_RESOURCE_SUPERVISOR_JOBS = 256;
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_HISTORY_OUTPUT_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ['queued', 'dispatching', 'settled', 'cancelled', 'unresolved'];
const OUTCOMES = ['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'];
export type ResourceConsoleDurableJob = Omit<ResourceSupervisorJob, 'cancellable' | 'outputAvailable' | 'historyAvailable'> & {
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
  paused: boolean; jobs: ResourceConsoleDurableJob[]; projects?: ResourceConsoleProjectBinding[];
  /** Schema5 base epoch for unchanged historical jobs without an explicit origin. */
  originPoolDigest?: string;
}
type DurableState = ResourceConsoleDurableState;

type DurableJob = ResourceConsoleDurableJob;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
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

export function assertStateHeadroom(next: DurableState): void {
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


export function consoleTaskCodec(workspace: string, workerIds: Set<string>, scopeDigest: string,
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
export function consoleEpochs(history: ResourcePoolConfigSnapshot[] | undefined, pool: ResourcePool, bindings: ResourceBinding[]) {
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


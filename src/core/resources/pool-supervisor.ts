/** Durable foreground queue. Only this live owner may dispatch or cancel its tasks. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { validateResourceObservations, validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { readResourceJson, resourcePoolStatus, runResourceTask, validateResourceTask, validateUnavailableResourceWorkerIds,
  type ResourceTask, type ResourceTaskReceipt } from './pool-runtime.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';
import { MAX_RESOURCE_CONVERSATION_BYTES, resourceConsoleConversationPrompt, resourceConsoleTranscriptDigest,
  validateResourceConsoleContext, validateResourceConsoleParent } from './console-conversation.js';
import { matchesResourceConsoleProject, pinResourceConsoleProject, validateResourceConsoleProjectBindings,
  validateResourceConsoleProjects, type ResourceConsoleProjectBinding } from './console-projects.js';
import type { ResourceConsoleContextTurn, ResourceConsoleOutput, ResourceConsoleTaskInput, ResourceConsoleTranscript,
  ResourceConsoleProject, ResourceConsoleProjectInput, ResourceSupervisorJob, ResourceSupervisorSnapshot } from './console-types.js';

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
};
interface DurableState { schemaVersion: 1 | 2 | 3 | 4; scopeDigest: string; paused: boolean; jobs: DurableJob[];
  projects?: ResourceConsoleProjectBinding[] }
export interface ResourcePoolSupervisorOptions {
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
  submit(input: ResourceConsoleTaskInput): ResourceSupervisorJob;
  cancel(id: string): ResourceSupervisorJob;
  setPaused(paused: boolean): ResourceSupervisorSnapshot;
  output(id: string): ResourceConsoleOutput | null;
  history(id: string): ResourceConsoleTranscript | null;
  deleteHistory(id: string): ResourceSupervisorJob;
  close(): Promise<void>;
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

/** Scope is explicit and immutable; no input callback can alter the chosen worker bindings. */
export async function createResourcePoolSupervisor(options: ResourcePoolSupervisorOptions): Promise<ResourcePoolSupervisor> {
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
    try { persistedCatalog = (readResourceJson(join(root, 'resource-console-state.json'), MAX_STATE_BYTES) as { schemaVersion?: unknown }).schemaVersion === 4; }
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
  const statePath = join(root, 'resource-console-state.json');
  const instanceId = randomUUID();
  const workerIds = new Set(pool.workers.map((worker) => worker.id));
  const enabledProjects = new Set(['default', ...configuredProjects.map((project) => project.id)]);
  function projectWorkspace(projectId?: string): string {
    if (projectId === undefined || projectId === 'default') return workspace;
    const binding = projectBindings?.find((project) => project.id === projectId);
    if (!binding) throw new ResourceSupervisorError('INVALID_INPUT', 'Unknown resource project');
    return binding.workspace;
  }
  function projectHold(projectId?: string): string | null {
    if (!projectBindings) return null;
    const id = projectId ?? 'default';
    if (!enabledProjects.has(id)) return 'project-not-enabled';
    const binding = projectBindings.find((project) => project.id === id);
    return binding && matchesResourceConsoleProject(binding) ? null : 'project-directory-unavailable';
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
  function decode(value: unknown): DurableState {
    if (!object(value) || !exact(value, ['schemaVersion', 'scopeDigest', 'paused', 'jobs', ...(value.schemaVersion === 4 ? ['projects'] : [])]) ||
      ![1, 2, 3, 4].includes(Number(value.schemaVersion)) ||
      typeof value.schemaVersion !== 'number' ||
      value.scopeDigest !== scopeDigest || typeof value.paused !== 'boolean' || !Array.isArray(value.jobs) ||
      value.jobs.length > MAX_RESOURCE_SUPERVISOR_JOBS) throw new Error('Invalid resource supervisor state');
    if (value.schemaVersion === 4) projectBindings = validateResourceConsoleProjectBindings(value.projects, workspace);
    const ids = new Set<string>();
    for (const row of value.jobs) {
      const retained = object(row) && (Object.hasOwn(row, 'retainHistory') || Object.hasOwn(row, 'history'));
      const continuation = object(row) && ['parent', 'submissionDigest', 'context'].some((key) => Object.hasOwn(row, key));
      if (!object(row) || !exact(row, ['id', 'state', 'enqueuedAt', 'updatedAt', 'allowedWorkerIds', 'mode', 'workerId',
        'outcome', 'reason', 'taskDigest', 'input', ...(retained ? ['retainHistory', 'history'] : []),
        ...(continuation ? ['parent', 'submissionDigest', 'context'] : []), ...(Object.hasOwn(row, 'projectId') ? ['projectId'] : [])]) ||
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
      if (Object.hasOwn(row, 'projectId') && (value.schemaVersion !== 4 || typeof row.projectId !== 'string' ||
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
            resourceConsoleTranscriptDigest(scopeDigest, source, { prompt: last.prompt, output: last.output }, context.slice(0, -1)) !==
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
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
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
      submissionDigest: _submission, context: _context, ...publicFields } = job;
    return detached({ ...publicFields, cancellable: !closing && !error && (job.state === 'queued' || job.state === 'dispatching' && active.has(job.id)),
      outputAvailable: outputs.has(job.id), ...(history ? { historyAvailable: true as const } : {}) });
  }
  function ensureAvailable(): void {
    if (closing || error) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor unavailable');
    own();
  }
  function receiptFor(job: DurableJob, receipts: ResourceTaskReceipt[]): ResourceTaskReceipt | undefined {
    const receipt = receipts.find((row) => row.id === job.id);
    if (receipt && (receipt.taskDigest !== job.taskDigest || receipt.poolDigest !== poolDigest ||
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
    const initialProjectHold = projectHold(job.projectId);
    if (initialProjectHold) { if (job.reason !== initialProjectHold) update(job.id, { reason: initialProjectHold }); return; }
    update(job.id, { state: 'dispatching', reason: 'dispatch-requested', workerId: null });
    // Publish the supervisor's irreversible intent before entering the runtime.
    // A crash anywhere after this point is never recovered by replaying input.
    const controller = new AbortController(); const owned = { controller, promise: Promise.resolve() };
    active.set(job.id, owned);
    dispatched.add(job.id);
    attemptedAt.set(job.id, performance.now());
    const input = taskFor(job.input, job.context);
    let admissionProjectHold: string | null = null;
    owned.promise = runResourceTask({ root, pool, bindings, observations, task: input, signal: controller.signal,
      unavailableWorkerIds, quotaUnavailableWorkerIds,
      ...(projectBindings ? { beforeWorkerDispatch: () => projectHold(job.projectId) === null, readAdmissionEvidence: () => {
        admissionProjectHold = projectHold(job.projectId);
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

  const supervisor: ResourcePoolSupervisor = {
    projectFileBinding(projectId) {
      ensureAvailable();
      if (typeof projectId !== 'string' || !ID.test(projectId)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource project');
      if (!projectBindings || state.schemaVersion !== 4) throw new ResourceSupervisorError('UNAVAILABLE', 'Register projects before browsing files.');
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
    submit(value) {
      ensureAvailable(); const input = taskInput(value);
      const previous = state.jobs.find((job) => job.id === input.id);
      if (previous) {
        if (previous.projectId !== input.projectId) throw new ResourceSupervisorError('CONFLICT', 'Resource task project already set');
        // Retry the accepted identity before looking up a potentially deleted
        // source. A retry is never permission to rebuild context or restore text.
        if (previous.parent) {
          if (!input.parent || previous.submissionDigest !== submissionDigestFor(input)) {
            throw new ResourceSupervisorError('CONFLICT', 'Resource conversation identity already used');
          }
          return publicJob(previous);
        }
        if (input.parent || previous.taskDigest !== digest(canonical(taskFor(input)))) {
          throw new ResourceSupervisorError('CONFLICT', 'Resource task identity already used');
        }
        if ((previous.retainHistory === true) !== (input.retainHistory === true)) {
          throw new ResourceSupervisorError('CONFLICT', 'Resource task retention consent already set');
        }
        return publicJob(previous);
      }
      const projectReason = projectHold(input.projectId);
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
        if (resourceConsoleTranscriptDigest(scopeDigest, parent, parent.history, parent.context) !== input.parent.expectedTranscriptDigest) {
          throw new ResourceSupervisorError('CONFLICT', 'Parent transcript changed; refresh before continuing');
        }
        context = validateResourceConsoleContext([...(parent.context ?? []), { taskId: parent.id,
          prompt: parent.history.prompt, output: parent.history.output, outcome: parent.outcome }], input.id, parent.id);
      }
      const taskDigest = digest(canonical(taskFor(input, context)));
      let previousRuntime: ResourceTaskReceipt | undefined;
      try { previousRuntime = resourcePoolStatus(root, pool, bindings, []).attempts.find((row) => row.id === input.id); }
      catch { throw new ResourceSupervisorError('UNAVAILABLE', 'Resource task evidence unavailable'); }
      if (previousRuntime && previousRuntime.taskDigest !== taskDigest) {
        throw new ResourceSupervisorError('CONFLICT', 'Resource task identity already used');
      }
      const now = new Date().toISOString();
      const job: DurableJob = { id: input.id, state: 'queued', enqueuedAt: now, updatedAt: now,
        allowedWorkerIds: [...input.allowedWorkerIds], mode: input.mode, workerId: null, outcome: null, reason: null, input, taskDigest,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.parent ? { parent: detached(input.parent), submissionDigest: submissionDigestFor(input), context: context! } : {}),
        ...(input.retainHistory === true ? { retainHistory: true as const, history: { prompt: input.prompt, output: null } } : {}) };
      const next: DurableState = { ...detached(state), schemaVersion: state.schemaVersion === 4 ? 4 : input.parent ? 3 :
        state.schemaVersion === 1 && input.retainHistory === true ? 2 : state.schemaVersion,
        jobs: [...detached(state.jobs), job] };
      assertStateHeadroom(next); persist(next); schedule(0); return publicJob(job);
    },
    cancel(id) {
      ensureAvailable(); if (typeof id !== 'string' || !ID.test(id)) throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource task id');
      const job = state.jobs.find((row) => row.id === id);
      if (!job) throw new ResourceSupervisorError('NOT_FOUND', 'Resource task unavailable');
      if (job.state === 'queued') update(id, { state: 'cancelled', outcome: 'cancelled', input: null, reason: 'queued-task-cancelled',
        ...(job.parent && !job.history ? { context: null } : {}) });
      else if (active.has(id)) { update(id, { reason: 'cancellation-requested' }); active.get(id)!.controller.abort(); }
      else if (job.state === 'dispatching' || job.state === 'unresolved') throw new ResourceSupervisorError('CONFLICT', 'Resource task is not owned by this console');
      return publicJob(state.jobs.find((row) => row.id === id)!);
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
        transcriptDigest: resourceConsoleTranscriptDigest(scopeDigest, job, job.history, job.context),
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
    if (configuredCatalogValue !== undefined || state.schemaVersion === 4) {
      // Legacy tasks had canonical-path binding, not recorded inode evidence.
      // The first explicit catalog adoption pins the default directory NOW;
      // it does not manufacture historical identity evidence or alter task hashes.
      const proposed = state.projects ? detached(state.projects) : [pinResourceConsoleProject({
        id: 'default', label: 'Default workspace', workspace,
      })];
      for (const configured of configuredProjects) {
        const prior = proposed.find((project) => project.id === configured.id);
        if (prior) {
          if (prior.workspace !== configured.workspace) throw new ResourceSupervisorError('CONFLICT', 'Resource project binding cannot be changed');
          prior.label = configured.label;
        } else {
          if (proposed.length >= 32) throw new ResourceSupervisorError('CAPACITY', 'Resource project binding capacity reached');
          const pinned = pinResourceConsoleProject(configured);
          if (proposed.some((project) => project.workspace === pinned.workspace || project.dev === pinned.dev && project.ino === pinned.ino)) {
            throw new ResourceSupervisorError('CONFLICT', 'Resource projects must identify distinct directories');
          }
          proposed.push(pinned);
        }
      }
      projectBindings = proposed;
      if (state.schemaVersion !== 4 || canonical(state.projects) !== canonical(proposed)) {
        recovered.schemaVersion = 4; recovered.projects = detached(proposed); assertStateHeadroom(recovered); changed = true;
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
      if (job.state === 'queued' && !receipt) continue;
      const terminal = receipt && !['reserved', 'uncertain'].includes(receipt.status);
      Object.assign(job, { state: terminal ? 'settled' : 'unresolved', workerId: receipt?.workerId ?? null,
        outcome: receipt?.status ?? null, reason: receipt?.reason ?? 'previous-dispatch-unresolved', input: null,
        ...(job.parent && !job.history ? { context: null } : {}),
        updatedAt: new Date(Math.max(Date.now(), Date.parse(job.updatedAt))).toISOString() }); changed = true;
    }
    stoppedBeforeStart(); if (changed) persist(recovered);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { await supervisor.close(); throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor startup cancelled'); }
    schedule(0); return supervisor;
  } catch (cause) {
    signal?.removeEventListener('abort', onAbort); if (timer) clearTimeout(timer);
    releaseLocalStoreLock(lock);
    if (cause instanceof ResourceSupervisorError) throw cause;
    throw new ResourceSupervisorError('UNAVAILABLE', 'Resource supervisor state unavailable');
  }
}

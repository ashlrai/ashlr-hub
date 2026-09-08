/** Explicit resource handoff; native completion is response data, never candidate acceptance. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { mergeResourceObservations, readResourceJson, resourcePoolStatus, runResourceTask, type ResourceTask } from '../resources/pool-runtime.js';
import { refreshResourceQuotaOnce, validateResourceQuotaRefreshConfig } from '../resources/quota-refresh.js';
import { waitForResourceCapacity } from '../resources/capacity-wait.js';
import { refreshResourceLocalModelsOnce, validateResourceLocalModelConfig } from '../resources/local-model-refresh.js';
import { validateResourcePool, validateResourceObservations } from '../resources/pool-policy.js';
import { validateResourceBindings } from '../resources/worker.js';
import { resourceUsageScopeForProvider } from '../resources/performance.js';
import type { ChatMessage } from '../types.js';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { newGenerationReceipt, resourceGenerationTaskId, validateGenerationConfig, validResourceGenerationEvidence } from './generation.js';
import type { UniverseGenerationReceipt, UniverseResourceGenerationConfig, UniverseResourceGenerationEvidence } from './types.js';

const MAX_TRANSPORT_BYTES = 256 * 1024;
export interface ResourceGenerationRuntime {
  schemaVersion: 1;
  poolPath: string;
  bindingsPath: string;
  observationsPath: string;
  root: string;
  workspace: string;
  quotaConfigPath?: string;
  localModelConfigPath?: string;
  capacityWaitMs?: number;
}
export interface ResourceGenerationContext {
  messages: ChatMessage[];
  candidatePath: string;
  timeoutMs: number;
  signal: AbortSignal;
  resourceRuntime?: string;
  resourceUniverseRoot?: string;
  resourceIdentity?: { universeId: string; runId: string; variantId: string };
}
export interface ResourceGenerationCompletion {
  status: UniverseGenerationReceipt['status'];
  content: string | null;
  resource: UniverseResourceGenerationEvidence;
  usage: UniverseGenerationReceipt['usage'];
  error?: string;
}

function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    value !== parse(value).root && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === '' || difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}
function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }
export function validateResourceGenerationRuntime(value: unknown): ResourceGenerationRuntime {
  const keys = ['schemaVersion', 'poolPath', 'bindingsPath', 'observationsPath', 'root', 'workspace'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    !keys.every((key) => Object.hasOwn(value, key)) || Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
      ![...keys, 'quotaConfigPath', 'localModelConfigPath', 'capacityWaitMs'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error();
  const config = value as Record<string, unknown>;
  if (config.schemaVersion !== 1 || !keys.slice(1).every((key) => path(config[key])) ||
    Object.hasOwn(config, 'quotaConfigPath') && !path(config.quotaConfigPath) ||
    Object.hasOwn(config, 'localModelConfigPath') && !path(config.localModelConfigPath) ||
    Object.hasOwn(config, 'capacityWaitMs') && (!Number.isSafeInteger(config.capacityWaitMs) ||
      Number(config.capacityWaitMs) < 0 || Number(config.capacityWaitMs) > 60_000)) throw new Error();
  return config as unknown as ResourceGenerationRuntime;
}
export function checkResourceGenerationWorkspace(workspace: string, remainingMs: () => number): void {
  inspectPrivateDirectory(workspace);
  if (contains(workspace, homedir()) || readdirSync(workspace).join('\0') !== '.git') throw new Error();
  const metadata = join(workspace, '.git'); const stat = lstatSync(metadata);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(metadata) !== metadata ||
    stat.mode & 0o022 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error();
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-C', workspace, ...args], { encoding: 'utf8', timeout: Math.min(5000, remainingMs()), maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const identities = git(['rev-parse', '--is-inside-work-tree', '--absolute-git-dir', '--git-common-dir', '--show-toplevel']).split('\n');
  if (identities.length !== 4 || identities[0] !== 'true' || identities[1] !== metadata ||
    resolve(workspace, identities[2]!) !== metadata || identities[3] !== workspace ||
    git(['ls-files', '-z']) !== '' || git(['for-each-ref', '--format=%(refname)']) !== '') throw new Error();
}

/**
 * One immutable task and at most one new worker execution. Only explicit
 * no-reservation admission races may recheck; no worker retry or API fallback.
 */
export async function generateResourceCompletion(config: UniverseResourceGenerationConfig,
  context: ResourceGenerationContext): Promise<ResourceGenerationCompletion> {
  const evidence = newGenerationReceipt(config).resource!;
  const result: ResourceGenerationCompletion = { status: 'failed', content: null, resource: evidence,
    usage: { state: 'unavailable', inputTokens: null, outputTokens: null } };
  const started = performance.now(); const controller = new AbortController(); let timedOut = false;
  let quotaRefreshStarted = false;
  let localRefreshStarted = false;
  let capacityWaiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => controller.abort();
  context.signal.addEventListener('abort', cancel, { once: true });
  if (context.signal.aborted) cancel();
  const remaining = (): number => {
    if (context.signal.aborted) throw new Error();
    const available = Math.floor(context.timeoutMs - (performance.now() - started));
    if (available < 1) { timedOut = true; controller.abort(); throw new Error(); }
    return available;
  };
  try {
    const validated = validateGenerationConfig(config);
    if (validated.kind !== 'resource-pool' || !Number.isSafeInteger(context.timeoutMs) || context.timeoutMs < 1 ||
      context.timeoutMs > 900_000 || !context.resourceIdentity || !path(context.resourceRuntime) ||
      !path(context.resourceUniverseRoot) || !path(context.candidatePath)) throw new Error();
    const taskId = resourceGenerationTaskId(context.resourceIdentity);
    const withheld = (): ResourceGenerationCompletion => {
      evidence.taskId = taskId; evidence.dispatch = 'withheld';
      result.error = 'Resource generation withheld by current capacity evidence'; return result;
    };
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, context.timeoutMs);
    remaining();
    const runtime = validateResourceGenerationRuntime(readResourceJson(context.resourceRuntime));
    inspectPrivateDirectory(context.resourceUniverseRoot);
    if (realpathSync(context.candidatePath) !== context.candidatePath || !lstatSync(context.candidatePath).isDirectory()) throw new Error();
    for (const boundary of [context.candidatePath, context.resourceUniverseRoot, runtime.root]) {
      if (overlaps(runtime.workspace, boundary)) throw new Error();
    }
    if (overlaps(runtime.root, context.resourceUniverseRoot) || overlaps(runtime.root, context.candidatePath)) throw new Error();
    for (const file of [context.resourceRuntime, runtime.poolPath, runtime.bindingsPath, runtime.observationsPath,
      ...(runtime.quotaConfigPath ? [runtime.quotaConfigPath] : []),
      ...(runtime.localModelConfigPath ? [runtime.localModelConfigPath] : [])]) {
      if ([context.resourceUniverseRoot, context.candidatePath, runtime.workspace].some((boundary) => contains(boundary, file))) throw new Error();
    }
    if (realpathSync(dirname(runtime.root)) !== dirname(runtime.root)) throw new Error();
    checkResourceGenerationWorkspace(runtime.workspace, remaining);
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
    if (pool.id !== validated.poolId || digest(canonical({ pool, bindings })) !== validated.poolDigest ||
      validated.allowedWorkerIds.some((id) => !pool.workers.some((worker) => worker.id === id))) throw new Error();
    const fileObservations = validateResourceObservations(readResourceJson(runtime.observationsPath), pool);
    let observations = fileObservations;
    let managedUnavailable: string[] = [];
    let capturedObservations: typeof fileObservations = [];
    const quotaConfig = runtime.quotaConfigPath ?
      validateResourceQuotaRefreshConfig(readResourceJson(runtime.quotaConfigPath), pool, bindings) : null;
    const localConfig = runtime.localModelConfigPath ?
      validateResourceLocalModelConfig(readResourceJson(runtime.localModelConfigPath), pool, bindings) : null;
    // Keep only bounded worker IDs, not a growing collection of file snapshots.
    // A denial observed before or during either capture remains an invocation veto.
    const deniedWorkerIds = new Set<string>();
    const observeDenials = (rows: typeof fileObservations): void => {
      const now = Date.now();
      for (const worker of pool.workers) {
        const capacityKey = bindings.find((binding) => binding.workerId === worker.id)!.capacityKey;
        const allowedAliases = pool.workers.filter((alias) => validated.allowedWorkerIds.includes(alias.id) &&
          bindings.find((binding) => binding.workerId === alias.id)!.capacityKey === capacityKey);
        if (!allowedAliases.length) continue;
        const reserve = Math.max(...allowedAliases.map((alias) => alias.reservePercent));
        if (rows.some((row) => row.workerId === worker.id && (row.health === 'unavailable' ||
          row.retryAfter !== null && Date.parse(row.retryAfter) > now ||
          row.windows.some((window) => window.usedPercent !== null && window.usedPercent >= 100 - reserve)))) {
          deniedWorkerIds.add(worker.id);
        }
      }
    };
    observeDenials(fileObservations);
    const prompt = canonical(context.messages);
    if (Buffer.byteLength(prompt, 'utf8') > MAX_TRANSPORT_BYTES) throw new Error();
    remaining();
    // One pre-admission wait allowance spans both collector and worker slots.
    // It never extends the outer generation budget or resets after a race.
    const capacityDeadline = performance.now() + (runtime.capacityWaitMs ?? 0);
    const capacityRemaining = (): number => Math.max(0, Math.floor(capacityDeadline - performance.now()));
    if (quotaConfig) {
      // Existing receipts must not cause fresh metadata contact. The eventual
      // transaction still enforces the full task digest and replay semantics.
      const prior = resourcePoolStatus(runtime.root, pool, bindings, fileObservations);
      if (!prior.attempts.some((attempt) => attempt.id === taskId)) {
        const quotaTimeoutMs = remaining();
        const quotaCapacityWaitMs = runtime.capacityWaitMs ? capacityRemaining() : undefined;
        if (quotaCapacityWaitMs !== undefined && quotaCapacityWaitMs < 1) return withheld();
        quotaRefreshStarted = true;
        const refreshed = await refreshResourceQuotaOnce({ pool, bindings, config: quotaConfig,
          cwd: runtime.root, observations: fileObservations, signal: controller.signal, timeoutMs: quotaTimeoutMs,
          ...(quotaCapacityWaitMs !== undefined ? { capacityWaitMs: quotaCapacityWaitMs } : {}) });
        remaining();
        const latestFile = validateResourceObservations(readResourceJson(runtime.observationsPath), pool);
        capturedObservations = refreshed.observations.filter((row) =>
          quotaConfig.workers.some((managed) => managed.workerId === row.workerId));
        observations = mergeResourceObservations(latestFile, capturedObservations);
        // A refresh renews measured freshness, not the operator's independent
        // denial. Preserve denials present before contact or supplied during it.
        observeDenials(latestFile);
        managedUnavailable = refreshed.unavailableWorkerIds;
      }
    }
    if (localConfig) {
      const prior = resourcePoolStatus(runtime.root, pool, bindings, observations, managedUnavailable);
      if (!prior.attempts.some((attempt) => attempt.id === taskId)) {
        const timeoutMs = remaining();
        const waitMs = runtime.capacityWaitMs ? capacityRemaining() : undefined;
        if (waitMs !== undefined && waitMs < 1) return withheld();
        localRefreshStarted = true;
        const refreshed = await refreshResourceLocalModelsOnce({ pool, bindings, config: localConfig,
          timeoutMs: waitMs === undefined ? timeoutMs : Math.min(timeoutMs, waitMs), signal: controller.signal });
        remaining();
        const latestFile = validateResourceObservations(readResourceJson(runtime.observationsPath), pool);
        capturedObservations = mergeResourceObservations(capturedObservations, refreshed.observations);
        observations = mergeResourceObservations(latestFile, capturedObservations);
        observeDenials(latestFile);
        managedUnavailable = [...new Set([...managedUnavailable, ...refreshed.unavailableWorkerIds])];
      }
    }
    // Only managed captures can supplement the current file during waiting.
    // Unmanaged workers removed from that file must not regain cached readiness.
    let evidenceRead = false;
    const readEvidence = () => {
      if (evidenceRead) {
        const latestFile = validateResourceObservations(readResourceJson(runtime.observationsPath), pool);
        observations = capturedObservations.length ? mergeResourceObservations(latestFile, capturedObservations) : latestFile;
        observeDenials(latestFile);
      }
      evidenceRead = true;
      const now = Date.now();
      // This integration requires current explicit evidence even when a general
      // resource pool permits operator-capped unknown-quota bootstrap elsewhere.
      const unavailableWorkerIds = new Set(validated.allowedWorkerIds.filter((id) => {
        const worker = pool.workers.find((row) => row.id === id)!;
        const observation = observations.find((row) => row.workerId === id);
        return !observation || observation.health !== 'ready' || Date.parse(observation.expiresAt) <= now || Date.parse(observation.observedAt) > now ||
          observation.updatedAt !== undefined && Date.parse(observation.updatedAt) > now || worker.provider !== 'local' &&
          (!observation.windows.length || observation.windows.some((window) => window.usedPercent === null ||
            window.resetsAt === null || Date.parse(window.resetsAt) <= now));
      }));
      for (const id of deniedWorkerIds) unavailableWorkerIds.add(id);
      for (const id of managedUnavailable) unavailableWorkerIds.add(id);
      return { observations, unavailableWorkerIds: [...unavailableWorkerIds] };
    };
    // The ID never depends on temporary trial paths. The full task digest also
    // binds this call's effective budget, workspace and prompt: a changed
    // envelope conflicts rather than replaying or creating another invocation.
    const task: ResourceTask = { schemaVersion: 1, id: taskId, allowedWorkerIds: [...validated.allowedWorkerIds],
      prompt, cwd: runtime.workspace, timeoutMs: context.timeoutMs, maxOutputTokens: validated.maxOutputTokens, mode: 'read-only' };
    let handoff: Awaited<ReturnType<typeof runResourceTask>>;
    while (true) {
      let current: ReturnType<typeof readEvidence>;
      if (runtime.capacityWaitMs) {
        capacityWaiting = true;
        const waitMs = capacityRemaining();
        if (waitMs < 1) {
          // Derived zero is not the operator's legacy no-wait setting. After
          // expiry only an existing identity may reach atomic replay/conflict.
          current = readEvidence();
          const prior = resourcePoolStatus(runtime.root, pool, bindings, current.observations, current.unavailableWorkerIds);
          remaining();
          if (!prior.attempts.some((attempt) => attempt.id === taskId)) return withheld();
        } else {
          const capacity = await waitForResourceCapacity({ root: runtime.root, pool, bindings, task,
            waitMs, signal: controller.signal, readEvidence });
          remaining();
          if (!capacity.ready) return withheld();
          current = { observations: capacity.observations, unavailableWorkerIds: capacity.unavailableWorkerIds };
        }
        capacityWaiting = false;
      } else current = readEvidence();
      remaining();
      if (runtime.capacityWaitMs && capacityRemaining() < 1) {
        const prior = resourcePoolStatus(runtime.root, pool, bindings, current.observations, current.unavailableWorkerIds);
        remaining();
        if (!prior.attempts.some((attempt) => attempt.id === taskId)) return withheld();
      }
      evidence.taskId = taskId; evidence.dispatch = 'unavailable';
      handoff = await runResourceTask({ root: runtime.root, pool, bindings, ...current, task, signal: controller.signal });
      // Only an explicit no-reservation concurrency race can return to waiting.
      // Throws and every receipt retain the existing no-retry semantics.
      if (handoff.receipt || handoff.replayed || !runtime.capacityWaitMs || capacityRemaining() < 1 ||
        !handoff.plan?.exclusions.some((row) => validated.allowedWorkerIds.includes(row.workerId) &&
          row.reasons.length === 1 && row.reasons[0] === 'concurrency-exhausted')) break;
      evidence.dispatch = 'withheld';
    }
    if (!handoff.receipt) return withheld();
    const receipt = handoff.receipt; const worker = pool.workers.find((row) => row.id === receipt.workerId);
    const binding = bindings.find((row) => row.workerId === receipt.workerId);
    if (!worker || !binding || !validated.allowedWorkerIds.includes(worker.id) || receipt.id !== taskId ||
      receipt.taskDigest !== digest(canonical(task)) || receipt.poolDigest !== validated.poolDigest ||
      receipt.capacityKey !== binding.capacityKey || receipt.verifiedAccepted !== false ||
      !handoff.replayed && receipt.status === 'reserved') throw new Error();
    const knownUsage = !handoff.replayed && receipt.inputTokens !== null && receipt.outputTokens !== null &&
      Number.isSafeInteger(receipt.inputTokens) && receipt.inputTokens >= 0 && Number.isSafeInteger(receipt.outputTokens) &&
      receipt.outputTokens >= 0 && Number.isSafeInteger(receipt.inputTokens + receipt.outputTokens) &&
      receipt.execution?.usageScope === resourceUsageScopeForProvider(worker.provider);
    const witness: UniverseResourceGenerationEvidence = { ...evidence, taskDigest: receipt.taskDigest,
      workerId: worker.id, workerProvider: worker.provider, workerModel: worker.model, receiptDigest: digest(canonical(receipt)),
      dispatch: handoff.replayed ? 'replayed' : 'settled', taskStatus: receipt.status,
      usageScope: knownUsage ? receipt.execution!.usageScope : null };
    if (!validResourceGenerationEvidence(witness)) throw new Error();
    Object.assign(evidence, witness);
    if (handoff.replayed) { result.error = 'Resource generation receipt was replayed without recoverable output'; return result; }
    if (knownUsage) {
      result.usage = { state: 'reported', inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens };
    }
    if (receipt.status !== 'completed') {
      result.status = receipt.status === 'timed-out' || receipt.status === 'cancelled' ? receipt.status : 'failed';
      result.error = receipt.status === 'uncertain' ? 'Resource generation termination remains uncertain' :
        receipt.reason === 'worker-cli-upgrade-required' ? 'Resource generation requires a compatible native CLI version' :
          'Resource generation did not complete';
      return result;
    }
    if (typeof handoff.output !== 'string' || Buffer.byteLength(handoff.output, 'utf8') > MAX_TRANSPORT_BYTES ||
      digest(handoff.output) !== receipt.outputDigest) {
      result.error = 'Resource generation output was unavailable, oversized, or inconsistent'; return result;
    }
    remaining();
    result.status = 'succeeded'; result.content = handoff.output;
    return result;
  } catch {
    result.status = context.signal.aborted ? 'cancelled' : timedOut ? 'timed-out' : 'failed';
    result.error = result.status === 'cancelled' ? 'Resource generation cancelled by its owner' :
      result.status === 'timed-out' ? 'Resource generation exceeded its time budget' :
        capacityWaiting ? 'Resource capacity wait unavailable; inspect current pool evidence' :
        evidence.dispatch === 'not-started' ? localRefreshStarted ?
          'Resource local model inventory unavailable; verify configured endpoint and model identity' : quotaRefreshStarted ?
          'Resource quota refresh unavailable; reconcile collector ownership before retrying' :
          'Resource generation requires valid private runtime, workspace, and pinned enrollment' :
          'Resource generation handoff unavailable; do not retry this task identity';
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener('abort', cancel);
  }
}

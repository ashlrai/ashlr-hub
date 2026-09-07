import { normalizeNumericLoopbackOllamaBaseUrl } from '../run/ollama-identity.js';
import { resourceUsageScopeForProvider } from '../resources/performance.js';
import { canonical, digest } from './artifacts.js';
import type { UniverseGenerationConfig, UniverseGenerationReceipt, UniverseGenerationUsage, UniverseResourceGenerationEvidence,
  UniverseRun, UniverseTrial } from './types.js';

const RESOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
function dataObject(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!object(value)) return false;
  const keys = Reflect.ownKeys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => typeof key === 'string' &&
    [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function denseArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) =>
      Object.hasOwn(value, index) && 'value' in Object.getOwnPropertyDescriptor(value, index)!).every(Boolean);
}
function resourceId(value: unknown): value is string { return typeof value === 'string' && RESOURCE_ID.test(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function resourceWorkers(value: unknown): value is string[] {
  return denseArray(value, 1, 32) && value.every(resourceId) && new Set(value).size === value.length;
}

/** Deterministic within the durable run/variant scope, independent of scratch UUIDs. */
export function resourceGenerationTaskId(identity: { universeId: string; runId: string; variantId: string }): string {
  if (!dataObject(identity, ['universeId', 'runId', 'variantId']) ||
    !Object.values(identity).every((value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value))) {
    throw new Error('Invalid Universe resource generation identity');
  }
  const identityDigest = digest(canonical(identity));
  // Keep each segment below the public scrubber's token-shaped string bound.
  return `u-${identityDigest.slice(0, 30)}-${identityDigest.slice(30, 60)}`;
}
export function validGenerationPath(value: unknown): value is string {
  return boundedText(value, 512) && !value.includes('\\') && !value.startsWith('/') &&
    !value.includes(':') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' &&
      part !== '.git' && part !== '.ashlr');
}

/** Portable identities for the opt-in mode only; legacy spelling is unchanged. */
export function validFileOperationsPath(value: unknown): value is string {
  return validGenerationPath(value) && value.normalize('NFC') === value && value.split('/').length <= 32 &&
    value.split('/').every((part) => !/[. ]$/.test(part) && !['.git', '.ashlr'].includes(part.toLowerCase()) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function fileOperationsPathKey(path: string): string { return path.normalize('NFD').toLowerCase(); }

function validFileScope(files: string[], context: unknown): context is string[] {
  if (!Array.isArray(context) || context.length > 16 || !context.every(validFileOperationsPath) ||
      !files.every(validFileOperationsPath)) return false;
  const paths = [...files, ...context].map(fileOperationsPathKey);
  return paths.every((path, index) => paths.every((other, next) => index === next ||
    path !== other && !path.startsWith(`${other}/`) && !other.startsWith(`${path}/`)));
}

export function validateGenerationConfig(value: unknown): UniverseGenerationConfig {
  if (object(value) && Object.getOwnPropertyDescriptor(value, 'kind') &&
    !('value' in Object.getOwnPropertyDescriptor(value, 'kind')!)) {
    throw new Error('Invalid Universe generation: a data-only discriminator is required');
  }
  if (object(value) && Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'resource-pool') {
    if (!dataObject(value, ['kind', 'poolId', 'poolDigest', 'allowedWorkerIds', 'files', 'maxOutputTokens'], ['fileOperations']) ||
      !resourceId(value.poolId) || !hash(value.poolDigest) || !resourceWorkers(value.allowedWorkerIds) ||
      !denseArray(value.files, 1, 16) || !value.files.every(validGenerationPath) || new Set(value.files).size !== value.files.length ||
      !count(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 16_384 ||
      value.fileOperations !== undefined && (!dataObject(value.fileOperations, ['schemaVersion', 'contextFiles']) ||
        value.fileOperations.schemaVersion !== 1 || !denseArray(value.fileOperations.contextFiles, 0, 16) ||
        !validFileScope(value.files, value.fileOperations.contextFiles))) {
      throw new Error('Invalid Universe resource generation: explicit pool identity, pinned bindings, worker allowlist and bounded file scope required');
    }
    return { kind: 'resource-pool', poolId: value.poolId, poolDigest: value.poolDigest,
      allowedWorkerIds: [...value.allowedWorkerIds], files: [...value.files], maxOutputTokens: value.maxOutputTokens,
      ...(value.fileOperations === undefined ? {} : { fileOperations: { schemaVersion: 1,
        contextFiles: [...(value.fileOperations as { contextFiles: string[] }).contextFiles] } }) };
  }
  if (!object(value) || !exact(value, ['kind', 'endpoint', 'model', 'files', 'maxOutputTokens', 'fileOperations']) ||
      value.kind !== 'local-chat' || !boundedText(value.endpoint, 512) || !normalizeNumericLoopbackOllamaBaseUrl(value.endpoint) ||
      !boundedText(value.model, 160) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 16 ||
      !value.files.every(validGenerationPath) || new Set(value.files).size !== value.files.length ||
      !count(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 16_384 ||
      (value.fileOperations !== undefined && (!object(value.fileOperations) ||
        !exact(value.fileOperations, ['schemaVersion', 'contextFiles']) || value.fileOperations.schemaVersion !== 1 ||
        !validFileScope(value.files, value.fileOperations.contextFiles)))) {
    throw new Error('Invalid Universe local generation: explicit numeric-loopback endpoint, model, bounded existing file allowlist and output budget required');
  }
  return { kind: 'local-chat', endpoint: normalizeNumericLoopbackOllamaBaseUrl(value.endpoint)!,
    model: value.model, files: [...value.files], maxOutputTokens: value.maxOutputTokens,
    ...(value.fileOperations === undefined ? {} : { fileOperations: { schemaVersion: 1,
      contextFiles: [...(value.fileOperations as { contextFiles: string[] }).contextFiles] } }) };
}

/** A failed preflight has a receipt, but does not invent a model request or usage. */
export function newGenerationReceipt(config: UniverseGenerationConfig): UniverseGenerationReceipt {
  if (config.kind === 'resource-pool') {
    return { schemaVersion: 1, provider: 'resource-pool', endpoint: null, model: null,
      status: 'failed', requestStarted: false, promptDigest: null, responseDigest: null, durationMs: 0,
      usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, changedFiles: [],
      resource: { schemaVersion: 1, poolId: config.poolId, poolDigest: config.poolDigest, allowedWorkerIds: [...config.allowedWorkerIds],
        taskId: null, taskDigest: null, workerId: null, workerProvider: null, workerModel: null, receiptDigest: null,
        dispatch: 'not-started', taskStatus: null, usageScope: null },
      ...(config.fileOperations ? { fileOperations: { schemaVersion: 1, contextDigest: null, operations: [] } } : {}) };
  }
  return { schemaVersion: 1, provider: 'local-openai-compatible',
    endpoint: normalizeNumericLoopbackOllamaBaseUrl(config.endpoint) ?? config.endpoint, model: config.model,
    status: 'failed', requestStarted: false, promptDigest: null, responseDigest: null, durationMs: 0,
    usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, changedFiles: [],
    ...(config.fileOperations ? { fileOperations: { schemaVersion: 1, contextDigest: null, operations: [] } } : {}) };
}

/** Shape and consistency only; the run/store pin the witness to its declared scope. */
export function validResourceGenerationEvidence(value: unknown): value is UniverseResourceGenerationEvidence {
  if (!dataObject(value, ['schemaVersion', 'poolId', 'poolDigest', 'allowedWorkerIds', 'taskId', 'taskDigest', 'workerId',
    'workerProvider', 'workerModel', 'receiptDigest', 'dispatch', 'taskStatus', 'usageScope']) || value.schemaVersion !== 1 ||
    !resourceId(value.poolId) || !hash(value.poolDigest) || !resourceWorkers(value.allowedWorkerIds) ||
    typeof value.dispatch !== 'string' || !['not-started', 'withheld', 'settled', 'replayed', 'unavailable'].includes(value.dispatch) ||
    !(value.taskId === null || resourceId(value.taskId))) return false;
  const receiptFields = [value.taskDigest, value.workerId, value.workerProvider, value.workerModel, value.receiptDigest, value.taskStatus];
  if (value.dispatch === 'not-started' || value.dispatch === 'withheld' || value.dispatch === 'unavailable') {
    return (value.dispatch === 'not-started' ? value.taskId === null : resourceId(value.taskId)) &&
      receiptFields.every((field) => field === null) && value.usageScope === null;
  }
  if (!resourceId(value.taskId) || !hash(value.taskDigest) || !resourceId(value.workerId) ||
    !value.allowedWorkerIds.includes(value.workerId) || typeof value.workerProvider !== 'string' ||
    !['codex', 'claude', 'local'].includes(value.workerProvider) ||
    !boundedText(value.workerModel, 160) || !hash(value.receiptDigest) ||
    typeof value.taskStatus !== 'string' || !['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'].includes(value.taskStatus)) return false;
  if (value.dispatch === 'replayed') return value.usageScope === null;
  return value.taskStatus !== 'reserved' && (value.usageScope === null ||
    value.usageScope === resourceUsageScopeForProvider(value.workerProvider as 'codex' | 'claude' | 'local'));
}

function validFileOperationsReceipt(value: unknown, promptDigest: unknown, changedFiles: string[], status: unknown): boolean {
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (!object(value) || !exact(value, ['schemaVersion', 'contextDigest', 'operations']) || value.schemaVersion !== 1 ||
      (value.contextDigest !== null && !hash(value.contextDigest)) ||
      (promptDigest === null) !== (value.contextDigest === null) || !Array.isArray(value.operations) || value.operations.length > 16 ||
      (status !== 'succeeded' && value.operations.length !== 0)) return false;
  const paths: string[] = [];
  for (const operation of value.operations) {
    if (!object(operation) || !exact(operation, ['op', 'path', 'beforeDigest', 'afterDigest']) || !validFileOperationsPath(operation.path) ||
        (operation.beforeDigest !== null && !hash(operation.beforeDigest)) || (operation.afterDigest !== null && !hash(operation.afterDigest)) ||
        !(operation.op === 'create' && operation.beforeDigest === null && hash(operation.afterDigest) ||
          operation.op === 'delete' && hash(operation.beforeDigest) && operation.afterDigest === null ||
          operation.op === 'replace' && hash(operation.beforeDigest) && hash(operation.afterDigest) && operation.beforeDigest !== operation.afterDigest)) return false;
    paths.push(operation.path);
  }
  return new Set(paths.map(fileOperationsPathKey)).size === paths.length &&
    paths.length === changedFiles.length && paths.every((path, index) => path === changedFiles[index]);
}

export function validGenerationReceipt(value: unknown): value is UniverseGenerationReceipt {
  if (!object(value)) return false;
  const provider = Object.getOwnPropertyDescriptor(value, 'provider')?.value;
  const resource = provider === 'resource-pool';
  if (resource && !dataObject(value, ['schemaVersion', 'provider', 'endpoint', 'model', 'status', 'requestStarted',
    'promptDigest', 'responseDigest', 'durationMs', 'usage', 'changedFiles', 'resource'], ['error', 'feedback', 'search', 'fileOperations'])) return false;
  if (resource && (typeof value.status !== 'string' || !dataObject(value.usage, ['state', 'inputTokens', 'outputTokens']) ||
    !denseArray(value.changedFiles, 0, 16))) return false;
  if (!object(value) || !exact(value, ['schemaVersion', 'provider', 'endpoint', 'model', 'status', 'requestStarted',
    'promptDigest', 'responseDigest', 'durationMs', 'usage', 'changedFiles', 'error', 'feedback', 'search', 'fileOperations', 'resource']) ||
      value.schemaVersion !== 1 || (resource ? value.endpoint !== null || value.model !== null || value.requestStarted !== false ||
        !validResourceGenerationEvidence(value.resource)
        : provider !== 'local-openai-compatible' || Object.hasOwn(value, 'resource') || !boundedText(value.endpoint, 512) ||
          normalizeNumericLoopbackOllamaBaseUrl(value.endpoint) !== value.endpoint || !boundedText(value.model, 160)) ||
      !['succeeded', 'failed', 'timed-out', 'cancelled'].includes(String(value.status)) || typeof value.requestStarted !== 'boolean' ||
      ![value.promptDigest, value.responseDigest].every((item) => item === null || (typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) ||
      typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      !object(value.usage) || !exact(value.usage, ['state', 'inputTokens', 'outputTokens']) ||
      !Array.isArray(value.changedFiles) || value.changedFiles.length > 16 || !value.changedFiles.every(validGenerationPath) ||
      new Set(value.changedFiles).size !== value.changedFiles.length ||
      (value.feedback !== undefined && (!validFeedbackReceipt(value.feedback) || value.promptDigest === null)) ||
      (value.search !== undefined && (!object(value.search) || !exact(value.search, ['schemaVersion', 'digest']) ||
        value.search.schemaVersion !== 2 || typeof value.search.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.search.digest) ||
        value.promptDigest === null)) ||
      (value.error !== undefined && (typeof value.error !== 'string' || value.error.length < 1 || value.error.length > 1_024 || value.error.includes('\0')))) return false;
  const usage = value.usage;
  const witness = resource ? value.resource as UniverseResourceGenerationEvidence : undefined;
  if (resource && (!dataObject(usage, ['state', 'inputTokens', 'outputTokens']) || !denseArray(value.changedFiles, 0, 16))) return false;
  if (value.fileOperations !== undefined && !validFileOperationsReceipt(value.fileOperations, value.promptDigest, value.changedFiles as string[], value.status)) return false;
  if (usage.state === 'reported') {
    if ((witness ? witness.dispatch !== 'settled' || witness.usageScope === null : !value.requestStarted) ||
      !count(usage.inputTokens) || !count(usage.outputTokens) || !count(usage.inputTokens + usage.outputTokens)) return false;
  } else if (usage.state !== 'unavailable' || usage.inputTokens !== null || usage.outputTokens !== null) return false;
  if (witness) {
    if (usage.state === 'unavailable' && witness.usageScope !== null) return false;
    if (witness.dispatch !== 'not-started' && value.promptDigest === null) return false;
    const completed = witness.dispatch === 'settled' && witness.taskStatus === 'completed';
    if (!completed && (value.responseDigest !== null || value.changedFiles.length !== 0 || value.status === 'succeeded')) return false;
    if (value.status === 'succeeded' && (value.responseDigest === null || value.error !== undefined)) return false;
    return value.status === 'succeeded' || value.changedFiles.length === 0;
  }
  if (!value.requestStarted && (value.responseDigest !== null || value.changedFiles.length !== 0 || value.status === 'succeeded')) return false;
  if (value.requestStarted && value.promptDigest === null) return false;
  if (value.status === 'succeeded' && (value.responseDigest === null || value.error !== undefined)) return false;
  return value.status === 'succeeded' || value.changedFiles.length === 0;
}

function validFeedbackReceipt(value: unknown): boolean {
  return object(value) && exact(value, ['runId', 'trialId', 'generation', 'comparatorDigest', 'artifactDigest', 'digest']) &&
    [value.runId, value.trialId].every((item) => typeof item === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(item)) &&
    count(value.generation) && value.generation >= 1 &&
    [value.comparatorDigest, value.digest].every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) &&
    (value.artifactDigest === null || (typeof value.artifactDigest === 'string' && /^[a-f0-9]{64}$/.test(value.artifactDigest)));
}

export function validGenerationUsage(value: unknown): value is UniverseGenerationUsage {
  if (!object(value) || !exact(value, ['scope', 'trials', 'requestsStarted', 'reportedRequests', 'inputTokens', 'outputTokens',
    'resourceAttempts', 'resourceReportedAttempts']) || value.scope !== 'model-generation' || !count(value.trials) ||
    value.trials < 1 || value.trials > 64 || !count(value.requestsStarted) || value.requestsStarted > value.trials ||
    !count(value.reportedRequests) || value.reportedRequests > value.requestsStarted) return false;
  const resources = Object.hasOwn(value, 'resourceAttempts') || Object.hasOwn(value, 'resourceReportedAttempts');
  if (resources && (!dataObject(value, ['scope', 'trials', 'requestsStarted', 'reportedRequests', 'inputTokens', 'outputTokens',
    'resourceAttempts', 'resourceReportedAttempts']) || !count(value.resourceAttempts) || !count(value.resourceReportedAttempts) ||
    value.resourceReportedAttempts > value.resourceAttempts || value.requestsStarted + value.resourceAttempts > value.trials)) return false;
  const attempts = resources ? value.resourceAttempts as number : 0;
  const reported = resources ? value.resourceReportedAttempts as number : 0;
  return value.inputTokens === null && value.outputTokens === null ||
    value.requestsStarted + attempts > 0 && value.reportedRequests === value.requestsStarted && reported === attempts &&
    count(value.inputTokens) && count(value.outputTokens) && count(value.inputTokens + value.outputTokens);
}

/** Replay and the writer share one definition; failed requests still consume resources. */
export function generationResources(trials: UniverseTrial[], recordingComplete = true): Pick<UniverseRun, 'tokensUsed' | 'costUsd' | 'generationUsage'> {
  const receipts = trials.flatMap((trial) => trial.generation ? [trial.generation] : []);
  if (!receipts.length) return { tokensUsed: null, costUsd: null };
  const requests = receipts.filter((receipt) => receipt.provider === 'local-openai-compatible' && receipt.requestStarted);
  const reported = requests.filter((receipt) => receipt.usage.state === 'reported');
  const resources = receipts.filter((receipt) => receipt.provider === 'resource-pool');
  const attempts = resources.filter((receipt) => receipt.resource?.dispatch !== 'not-started' && receipt.resource?.dispatch !== 'withheld');
  const resourceReported = attempts.filter((receipt) => receipt.resource?.dispatch === 'settled' &&
    receipt.resource.taskStatus !== 'uncertain' && receipt.resource.taskStatus !== 'reserved' && receipt.usage.state === 'reported');
  const measured = [...reported, ...resourceReported];
  const input = measured.reduce((total, receipt) => total + receipt.usage.inputTokens!, 0);
  const output = measured.reduce((total, receipt) => total + receipt.usage.outputTokens!, 0);
  // A process can die after starting a request but before publishing its trial.
  // Only a completed generation establishes that all started trials were recorded.
  const complete = recordingComplete && requests.length + attempts.length > 0 && reported.length === requests.length &&
    resourceReported.length === attempts.length && count(input) && count(output) && count(input + output);
  return { tokensUsed: complete ? input + output : null, costUsd: null,
    generationUsage: { scope: 'model-generation', trials: receipts.length, requestsStarted: requests.length,
      reportedRequests: reported.length, ...(resources.length ? { resourceAttempts: attempts.length,
        resourceReportedAttempts: resourceReported.length } : {}),
      inputTokens: complete ? input : null, outputTokens: complete ? output : null } };
}

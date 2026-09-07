import { normalizeNumericLoopbackOllamaBaseUrl } from '../run/ollama-identity.js';
import type { UniverseGenerationConfig, UniverseGenerationReceipt, UniverseGenerationUsage, UniverseRun, UniverseTrial } from './types.js';

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
  return { schemaVersion: 1, provider: 'local-openai-compatible',
    endpoint: normalizeNumericLoopbackOllamaBaseUrl(config.endpoint) ?? config.endpoint, model: config.model,
    status: 'failed', requestStarted: false, promptDigest: null, responseDigest: null, durationMs: 0,
    usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, changedFiles: [],
    ...(config.fileOperations ? { fileOperations: { schemaVersion: 1, contextDigest: null, operations: [] } } : {}) };
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
  if (!object(value) || !exact(value, ['schemaVersion', 'provider', 'endpoint', 'model', 'status', 'requestStarted',
    'promptDigest', 'responseDigest', 'durationMs', 'usage', 'changedFiles', 'error', 'feedback', 'search', 'fileOperations']) ||
      value.schemaVersion !== 1 || value.provider !== 'local-openai-compatible' || !boundedText(value.endpoint, 512) ||
      normalizeNumericLoopbackOllamaBaseUrl(value.endpoint) !== value.endpoint || !boundedText(value.model, 160) ||
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
  if (value.fileOperations !== undefined && !validFileOperationsReceipt(value.fileOperations, value.promptDigest, value.changedFiles as string[], value.status)) return false;
  if (usage.state === 'reported') {
    if (!value.requestStarted || !count(usage.inputTokens) || !count(usage.outputTokens) || !count(usage.inputTokens + usage.outputTokens)) return false;
  } else if (usage.state !== 'unavailable' || usage.inputTokens !== null || usage.outputTokens !== null) return false;
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
  return object(value) && exact(value, ['scope', 'trials', 'requestsStarted', 'reportedRequests', 'inputTokens', 'outputTokens']) &&
    value.scope === 'model-generation' && count(value.trials) && value.trials >= 1 && value.trials <= 64 &&
    count(value.requestsStarted) && value.requestsStarted <= value.trials && count(value.reportedRequests) &&
    value.reportedRequests <= value.requestsStarted &&
    ((value.inputTokens === null && value.outputTokens === null) ||
      (value.requestsStarted > 0 && value.reportedRequests === value.requestsStarted &&
        count(value.inputTokens) && count(value.outputTokens) && count(value.inputTokens + value.outputTokens)));
}

/** Replay and the writer share one definition; failed requests still consume resources. */
export function generationResources(trials: UniverseTrial[], recordingComplete = true): Pick<UniverseRun, 'tokensUsed' | 'costUsd' | 'generationUsage'> {
  const receipts = trials.flatMap((trial) => trial.generation ? [trial.generation] : []);
  if (!receipts.length) return { tokensUsed: null, costUsd: null };
  const requests = receipts.filter((receipt) => receipt.requestStarted);
  const reported = requests.filter((receipt) => receipt.usage.state === 'reported');
  const input = reported.reduce((total, receipt) => total + receipt.usage.inputTokens!, 0);
  const output = reported.reduce((total, receipt) => total + receipt.usage.outputTokens!, 0);
  // A process can die after starting a request but before publishing its trial.
  // Only a completed generation establishes that all started trials were recorded.
  const complete = recordingComplete && requests.length > 0 && reported.length === requests.length && count(input) && count(output) && count(input + output);
  return { tokensUsed: complete ? input + output : null, costUsd: null,
    generationUsage: { scope: 'model-generation', trials: receipts.length, requestsStarted: requests.length,
      reportedRequests: reported.length, inputTokens: complete ? input : null, outputTokens: complete ? output : null } };
}

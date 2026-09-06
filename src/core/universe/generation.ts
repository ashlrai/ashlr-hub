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

export function validateGenerationConfig(value: unknown): UniverseGenerationConfig {
  if (!object(value) || !exact(value, ['kind', 'endpoint', 'model', 'files', 'maxOutputTokens']) ||
      value.kind !== 'local-chat' || !boundedText(value.endpoint, 512) || !normalizeNumericLoopbackOllamaBaseUrl(value.endpoint) ||
      !boundedText(value.model, 160) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 16 ||
      !value.files.every(validGenerationPath) || new Set(value.files).size !== value.files.length ||
      !count(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 16_384) {
    throw new Error('Invalid Universe local generation: explicit numeric-loopback endpoint, model, bounded existing file allowlist and output budget required');
  }
  return { kind: 'local-chat', endpoint: normalizeNumericLoopbackOllamaBaseUrl(value.endpoint)!,
    model: value.model, files: [...value.files], maxOutputTokens: value.maxOutputTokens };
}

/** A failed preflight has a receipt, but does not invent a model request or usage. */
export function newGenerationReceipt(config: UniverseGenerationConfig): UniverseGenerationReceipt {
  return { schemaVersion: 1, provider: 'local-openai-compatible',
    endpoint: normalizeNumericLoopbackOllamaBaseUrl(config.endpoint) ?? config.endpoint, model: config.model,
    status: 'failed', requestStarted: false, promptDigest: null, responseDigest: null, durationMs: 0,
    usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, changedFiles: [] };
}

export function validGenerationReceipt(value: unknown): value is UniverseGenerationReceipt {
  if (!object(value) || !exact(value, ['schemaVersion', 'provider', 'endpoint', 'model', 'status', 'requestStarted',
    'promptDigest', 'responseDigest', 'durationMs', 'usage', 'changedFiles', 'error']) ||
      value.schemaVersion !== 1 || value.provider !== 'local-openai-compatible' || !boundedText(value.endpoint, 512) ||
      normalizeNumericLoopbackOllamaBaseUrl(value.endpoint) !== value.endpoint || !boundedText(value.model, 160) ||
      !['succeeded', 'failed', 'timed-out', 'cancelled'].includes(String(value.status)) || typeof value.requestStarted !== 'boolean' ||
      ![value.promptDigest, value.responseDigest].every((item) => item === null || (typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) ||
      typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
      !object(value.usage) || !exact(value.usage, ['state', 'inputTokens', 'outputTokens']) ||
      !Array.isArray(value.changedFiles) || value.changedFiles.length > 16 || !value.changedFiles.every(validGenerationPath) ||
      new Set(value.changedFiles).size !== value.changedFiles.length ||
      (value.error !== undefined && (typeof value.error !== 'string' || value.error.length < 1 || value.error.length > 1_024 || value.error.includes('\0')))) return false;
  const usage = value.usage;
  if (usage.state === 'reported') {
    if (!value.requestStarted || !count(usage.inputTokens) || !count(usage.outputTokens) || !count(usage.inputTokens + usage.outputTokens)) return false;
  } else if (usage.state !== 'unavailable' || usage.inputTokens !== null || usage.outputTokens !== null) return false;
  if (!value.requestStarted && (value.responseDigest !== null || value.changedFiles.length !== 0 || value.status === 'succeeded')) return false;
  if (value.requestStarted && value.promptDigest === null) return false;
  if (value.status === 'succeeded' && (value.responseDigest === null || value.error !== undefined)) return false;
  return value.status === 'succeeded' || value.changedFiles.length === 0;
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

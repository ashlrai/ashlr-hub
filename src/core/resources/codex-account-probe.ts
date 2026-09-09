/** Explicit native metadata sampling, not login, account attestation or a model request. */
import { lstatSync, mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isVerifyProcessGroupLifecycle, runVerifySubprocessAsync, type VerifyProcessGroupLifecycle } from '../run/verify-commands.js';
import { canonical, digest } from '../universe/artifacts.js';
import { validateResourceObservations, validateResourcePool, type ResourceObservation, type ResourcePool } from './pool-policy.js';
import { validateResourceBindings, workerEnvironment, type ResourceBinding } from './worker.js';

export interface CodexResourceProbeOptions {
  pool: ResourcePool;
  bindings: ResourceBinding[];
  workerId: string;
  /** Validated caller scope only. Native metadata runs in a private temporary cwd. */
  cwd: string;
  bucketIds: string[];
  expectedAccountHint?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** In-process ownership evidence only; never forwarded to the native protocol. */
  processGroupLifecycle?: VerifyProcessGroupLifecycle;
}
export interface CodexResourceProbeResult {
  schemaVersion: 1;
  scope: 'codex-native-metadata';
  workerId: string;
  poolDigest: string;
  status: 'observed' | 'failed' | 'cancelled' | 'timed-out' | 'uncertain';
  reason: string;
  startedAt: string;
  finishedAt: string;
  /** SHA256 of reported type/email/plan, not a stable account or workspace identity. */
  accountHint: string | null;
  planType: string | null;
  observation: ResourceObservation | null;
}
export interface CodexProbeProcessInput {
  schemaVersion: 1;
  command: string[];
  workerId: string;
  bucketIds: string[];
  expectedAccountHint: string | null;
  startedAt: string;
}
export interface CodexProbeProcessOutput {
  schemaVersion: 1;
  status: 'observed' | 'failed';
  reason: string;
  accountHint: string | null;
  planType: string | null;
  observation: ResourceObservation | null;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROCESS_REASONS = new Set(['probe-observed', 'probe-native-unavailable', 'probe-protocol-invalid',
  'probe-output-limit', 'probe-provider-error', 'probe-server-request-refused', 'probe-account-unavailable',
  'probe-account-unsupported', 'probe-account-hint-mismatch', 'probe-account-changed', 'probe-quota-invalid',
  'probe-native-exit-failed']);
const PLAN_TYPES = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_usage_based',
  'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => typeof key === 'string' &&
    [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 32 &&
      !(character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159));
}
function configuration(options: CodexResourceProbeOptions) {
  if (!record(options) || !exact(options, ['pool', 'bindings', 'workerId', 'cwd', 'bucketIds'],
    ['expectedAccountHint', 'timeoutMs', 'signal', 'processGroupLifecycle'])) throw new Error('Invalid Codex resource probe configuration');
  const lifecycle = options.processGroupLifecycle;
  if (lifecycle !== undefined && !isVerifyProcessGroupLifecycle(lifecycle)) throw new Error('Invalid Codex resource probe configuration');
  const pool = validateResourcePool(options.pool); const bindings = validateResourceBindings(options.bindings, pool);
  const worker = pool.workers.find((item) => item.id === options.workerId);
  const binding = bindings.find((item) => item.workerId === options.workerId);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!worker || worker.provider !== 'codex' || binding?.kind !== 'native-cli' ||
    !text(options.cwd, 4_096) || !isAbsolute(options.cwd) || resolve(options.cwd) === parse(options.cwd).root ||
    !lstatSync(options.cwd).isDirectory() || lstatSync(options.cwd).isSymbolicLink() ||
    realpathSync(options.cwd) !== resolve(options.cwd) ||
    !Array.isArray(options.bucketIds) || options.bucketIds.length < 1 || options.bucketIds.length > 4 ||
    Reflect.ownKeys(options.bucketIds).length !== options.bucketIds.length + 1 ||
    !Array.from({ length: options.bucketIds.length }, (_, i) => i).every((i) =>
      Object.hasOwn(options.bucketIds, i) && 'value' in Object.getOwnPropertyDescriptor(options.bucketIds, i)! &&
      typeof options.bucketIds[i] === 'string' && ID.test(options.bucketIds[i]!)) ||
    new Set(options.bucketIds).size !== options.bucketIds.length ||
    (options.expectedAccountHint !== undefined && (typeof options.expectedAccountHint !== 'string' || !HASH.test(options.expectedAccountHint))) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new Error('Invalid Codex resource probe configuration');
  }
  return { pool, bindings, binding, workerId: worker.id, bucketIds: [...options.bucketIds],
    expectedAccountHint: options.expectedAccountHint ?? null, timeoutMs, signal: options.signal, processGroupLifecycle: lifecycle,
    poolDigest: digest(canonical({ pool, bindings })) };
}

function helperArgv(): string[] {
  if (import.meta.url.endsWith('/codex-account-probe.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./codex-account-probe-process.ts', import.meta.url).href;
    return [process.execPath, '--input-type=module', '--eval',
      `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`];
  }
  return [process.execPath, fileURLToPath(new URL('./codex-account-probe-process.js', import.meta.url))];
}

function checkedOutput(output: string, pool: ResourcePool, workerId: string, startedAt: string,
  expectedAccountHint: string | null): CodexProbeProcessOutput | null {
  try {
    const value: unknown = JSON.parse(output);
    if (!record(value) || !exact(value, ['schemaVersion', 'status', 'reason', 'accountHint', 'planType', 'observation']) ||
      value.schemaVersion !== 1 || !['observed', 'failed'].includes(String(value.status)) ||
      typeof value.reason !== 'string' || !PROCESS_REASONS.has(value.reason) ||
      (value.accountHint !== null && (typeof value.accountHint !== 'string' || !HASH.test(value.accountHint))) ||
      (value.planType !== null && (typeof value.planType !== 'string' || !PLAN_TYPES.has(value.planType))) ||
      (value.accountHint === null) !== (value.planType === null)) return null;
    if (value.status === 'failed') {
      if (value.observation !== null || value.reason === 'probe-observed') return null;
    } else {
      if (!value.accountHint || !value.planType || value.reason !== 'probe-observed' ||
        expectedAccountHint !== null && value.accountHint !== expectedAccountHint) return null;
      const observation = validateResourceObservations([value.observation], pool)[0]!;
      if (observation.workerId !== workerId || observation.observedAt !== startedAt || observation.updatedAt !== startedAt ||
        observation.expiresAt !== new Date(Date.parse(startedAt) + 60_000).toISOString() ||
        observation.health !== 'ready' || observation.retryAfter !== null) return null;
      value.observation = observation;
    }
    return value as unknown as CodexProbeProcessOutput;
  } catch { return null; }
}

/**
 * A short-lived App Server connection: initialize, account/read(false), quota,
 * account/read(false), EOF. No native credential files are read by Hub. Native
 * global configuration/auth maintenance remains native-owned; false disables
 * proactive refresh, not every possible provider-side or local auth operation.
 */
export async function probeCodexResourceAccount(options: CodexResourceProbeOptions): Promise<CodexResourceProbeResult> {
  let pinned: ReturnType<typeof configuration>;
  try { pinned = configuration(options); } catch { throw new Error('Invalid Codex resource probe configuration'); }
  const started = performance.now(); const startedAt = new Date().toISOString();
  const result = (status: CodexResourceProbeResult['status'], reason: string,
    metadata?: Pick<CodexProbeProcessOutput, 'accountHint' | 'planType' | 'observation'>): CodexResourceProbeResult => ({
    schemaVersion: 1, scope: 'codex-native-metadata', workerId: pinned.workerId, poolDigest: pinned.poolDigest,
    status, reason, startedAt, finishedAt: new Date().toISOString(),
    accountHint: metadata?.accountHint ?? null, planType: metadata?.planType ?? null, observation: metadata?.observation ?? null,
  });
  if (pinned.signal?.aborted) return result('cancelled', 'probe-cancelled');
  if (process.platform === 'win32') return result('failed', 'probe-platform-unsupported');
  let scratch: string | undefined; let cleanupConfirmed = false; let invocationAttempted = false;
  try {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), 'ashlr-codex-metadata-'));
    const remaining = pinned.timeoutMs - (performance.now() - started);
    if (remaining <= 0) { cleanupConfirmed = true; return result('timed-out', 'probe-timed-out'); }
    const input: CodexProbeProcessInput = { schemaVersion: 1, command: [...pinned.binding.command], workerId: pinned.workerId,
      bucketIds: pinned.bucketIds, expectedAccountHint: pinned.expectedAccountHint, startedAt };
    const argv = helperArgv();
    const executionOptions = { cwd: scratch, env: workerEnvironment(), input: JSON.stringify(input),
      timeoutMs: Math.max(1, Math.floor(remaining)), maxOutputChars: 32 * 1024, signal: pinned.signal,
      requireProcessGroupExit: true, processGroupLifecycle: pinned.processGroupLifecycle };
    // A rejected runner call provides no teardown witness, even if it threw synchronously.
    invocationAttempted = true;
    const executed = await runVerifySubprocessAsync(argv, executionOptions);
    // Exit status and output are not evidence that native descendants have stopped.
    if (executed.processGroupSettlement !== 'not-started' && executed.processGroupSettlement !== 'group-exit-confirmed') {
      return result('uncertain', 'probe-termination-uncertain');
    }
    cleanupConfirmed = true;
    if (executed.cancelled || pinned.signal?.aborted) return result('cancelled', 'probe-cancelled');
    if (executed.timedOut || performance.now() - started >= pinned.timeoutMs) return result('timed-out', 'probe-timed-out');
    if (executed.outputTruncated || executed.error || executed.exitCode !== 0 || executed.signal) {
      return result('failed', 'probe-process-failed');
    }
    const metadata = checkedOutput(executed.stdout, pinned.pool, pinned.workerId, startedAt, pinned.expectedAccountHint);
    return metadata ? result(metadata.status, metadata.reason, metadata) : result('failed', 'probe-process-output-invalid');
  } catch { return invocationAttempted && !cleanupConfirmed
    ? result('uncertain', 'probe-termination-uncertain') : result('failed', 'probe-process-failed'); }
  finally {
    // Never recursively remove native-created data, nor remove the cwd while
    // teardown is unconfirmed. A nonempty/uncertain scratch is left private.
    if (scratch && cleanupConfirmed) { try { rmdirSync(scratch); } catch { /* Exact owned directory only. */ } }
  }
}

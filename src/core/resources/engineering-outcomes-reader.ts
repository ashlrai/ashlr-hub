/** One-shot, bounded observation transport. No admission, provider or evaluator calls. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types as utilTypes } from 'node:util';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import { digest } from '../universe/artifacts.js';
import type { createFirmEngineeringControlHandler } from '../universe/firm-engineering-control-handler.js';
import { ReadProjectionError } from '../web/bounded-read-worker.js';
import type { readResourceEngineeringOutcomes } from './engineering-outcomes.js';
import type { ResourceEngineeringOutcomes } from './engineering-outcomes-types.js';
import { validateResourceEngineeringOutcomes } from './engineering-outcomes-validation.js';
import { workerEnvironment } from './worker.js';

type Input = Parameters<typeof readResourceEngineeringOutcomes>[0];
type NodeInput = ReturnType<typeof createFirmEngineeringControlHandler>['nodeInput'];
export interface ResourceEngineeringOutcomesReadOptions { expectedNodeInput: NodeInput; signal?: AbortSignal }
export interface ResourceEngineeringOutcomesReader {
  read(input: Input, options: ResourceEngineeringOutcomesReadOptions): Promise<ResourceEngineeringOutcomes>;
  close(): Promise<void>;
}
/** Includes the runner's five-second termination grace and one-second drain. */
export const ENGINEERING_OUTCOMES_READ_BUDGET_MS = 60_000;
const WORK_MS = ENGINEERING_OUTCOMES_READ_BUDGET_MS - 6_000;
const INPUT_BYTES = 256 * 1024;
const REPORT_BYTES = 192 * 1024;
export interface EngineeringOutcomesReadRequest {
  schemaVersion: 1; requestId: string; scopeDigest: string; deadlineAt: number;
  input: Input; expectedNodeInput: NodeInput;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max &&
  ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const unique = (rows: Record<string, unknown>[], key: string) => new Set(rows.map(row => row[key])).size === rows.length;
function fail(code = 'READ_PROJECTION_UNAVAILABLE'): never { throw new ReadProjectionError('Engineering outcome observation unavailable', code); }

function readOptions(value: unknown): ResourceEngineeringOutcomesReadOptions {
  if (!object(value) || utilTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('READ_PROJECTION_INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['signal', 'expectedNodeInput'].includes(key) ||
    !Object.hasOwn(descriptors[key]!, 'value')) || !Object.hasOwn(descriptors, 'expectedNodeInput')) fail('READ_PROJECTION_INVALID_REQUEST');
  const signal = descriptors.signal?.value as unknown;
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('READ_PROJECTION_INVALID_REQUEST');
  return { expectedNodeInput: descriptors.expectedNodeInput!.value as NodeInput, signal: signal as AbortSignal | undefined };
}

/** Fixed-process protocol codec, not an additional acceptance decision. */
export function validateEngineeringOutcomesReadRequest(value: unknown): EngineeringOutcomesReadRequest {
  const serialized = canonicalEvidencePackJsonV3(value);
  if (serialized === null || Buffer.byteLength(serialized) > INPUT_BYTES + 2048) fail('READ_PROJECTION_INVALID_REQUEST');
  const v = JSON.parse(serialized) as unknown;
  if (!object(v) || !exact(v, ['schemaVersion', 'requestId', 'scopeDigest', 'deadlineAt', 'input', 'expectedNodeInput']) ||
    v.schemaVersion !== 1 || typeof v.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.requestId) || !hash(v.scopeDigest) ||
    !Number.isSafeInteger(v.deadlineAt) || !object(v.expectedNodeInput) || !exact(v.expectedNodeInput, ['bindingDigest', 'requestDigest']) ||
    !hash(v.expectedNodeInput.bindingDigest) || !hash(v.expectedNodeInput.requestDigest) || !object(v.input) ||
    !exact(v.input, ['enrollment', 'host', 'root', 'poolFile', 'bindingsFile']) || !object(v.input.enrollment) || !object(v.input.host) ||
    !id(v.input.enrollment.id) || !hash(v.input.enrollment.enrollmentDigest) || !Array.isArray(v.input.enrollment.campaigns) ||
    v.input.enrollment.campaigns.length > 32 || !v.input.enrollment.campaigns.every(c => object(c) && id(c.id)) ||
    !unique(v.input.enrollment.campaigns, 'id') || [v.input.root, v.input.poolFile, v.input.bindingsFile, v.input.host.root, v.input.host.resourceRuntime]
      .some(p => typeof p !== 'string' || p === '/' || !text(p, 4096) || !isAbsolute(p) || resolve(p) !== p) ||
    Buffer.byteLength(JSON.stringify(v.input)) > INPUT_BYTES || digest(canonicalEvidencePackJsonV3({ input: v.input, expectedNodeInput: v.expectedNodeInput })!) !== v.scopeDigest) fail('READ_PROJECTION_INVALID_REQUEST');
  return v as unknown as EngineeringOutcomesReadRequest;
}
function report(value: unknown, request: EngineeringOutcomesReadRequest, startedAt: number): ResourceEngineeringOutcomes {
  if (!object(value) || !exact(value, ['schemaVersion', 'requestId', 'scopeDigest', 'report']) || value.schemaVersion !== 1 ||
    value.requestId !== request.requestId || value.scopeDigest !== request.scopeDigest || !object(value.report)) fail();
  const result = validateResourceEngineeringOutcomes(value.report, request.input.enrollment);
  if (!timestamp(result.sampledAt) || Date.parse(result.sampledAt) < startedAt || Date.parse(result.sampledAt) > Date.now()) fail();
  return result;
}

function argv(): string[] {
  if (import.meta.url.endsWith('/engineering-outcomes-reader.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./engineering-outcomes-read-process.ts', import.meta.url).href;
    return [process.execPath, '--input-type=module', '--eval', `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`];
  }
  return [process.execPath, fileURLToPath(new URL('./engineering-outcomes-read-process.js', import.meta.url))];
}

export function createResourceEngineeringOutcomesReader(): ResourceEngineeringOutcomesReader {
  let closed = false, faulted = false;
  let active: { abort: AbortController; done: Promise<void> } | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    async read(input, options) {
      if (faulted) fail('READ_PROJECTION_CLEANUP_UNCONFIRMED');
      if (closed) fail('READ_PROJECTION_CLOSED');
      if (active) fail('READ_PROJECTION_BUSY');
      const startedAt = Date.now(), startedMono = performance.now();
      const deadlineAt = startedAt + WORK_MS, deadlineMono = startedMono + WORK_MS;
      // Capture only own data, including an absent (never inherited) signal.
      options = readOptions(options);
      const captured = canonicalEvidencePackJsonV3({ input, expectedNodeInput: options.expectedNodeInput });
      if (captured === null || Buffer.byteLength(captured) > INPUT_BYTES + 1024) fail('READ_PROJECTION_INVALID_REQUEST');
      const request = validateEngineeringOutcomesReadRequest({ ...JSON.parse(captured), schemaVersion: 1, requestId: randomUUID(), scopeDigest: digest(captured), deadlineAt });
      if (options.signal?.aborted) fail('READ_PROJECTION_CANCELLED');
      const abort = new AbortController();
      const cancelled = () => abort.abort();
      options.signal?.addEventListener('abort', cancelled, { once: true });
      let expired = false;
      const remaining = Math.floor(Math.min(deadlineAt - Date.now(), deadlineMono - performance.now()));
      if (remaining <= 0) { options.signal?.removeEventListener('abort', cancelled); fail('READ_PROJECTION_TIMEOUT'); }
      const timer = setTimeout(() => { expired = true; abort.abort(); }, remaining);
      let release!: () => void;
      const invocation = { abort, done: new Promise<void>(resolveDone => { release = resolveDone; }) };
      active = invocation;
      try {
        let result;
        try {
          result = await runVerifySubprocessAsync(argv(), { cwd: request.input.root, env: workerEnvironment(), input: JSON.stringify(request),
            timeoutMs: remaining, terminationGraceMs: 5_000, maxOutputChars: REPORT_BYTES + 2048, signal: abort.signal, requireProcessGroupExit: true });
        } catch { faulted = true; fail('READ_PROJECTION_CLEANUP_UNCONFIRMED'); }
        if (result.processGroupSettlement !== 'not-started' && result.processGroupSettlement !== 'group-exit-confirmed') {
          faulted = true; fail('READ_PROJECTION_CLEANUP_UNCONFIRMED');
        }
        if (expired || result.timedOut || Date.now() >= deadlineAt || performance.now() >= deadlineMono) fail('READ_PROJECTION_TIMEOUT');
        if (closed || options.signal?.aborted || result.cancelled || abort.signal.aborted) fail('READ_PROJECTION_CANCELLED');
        if (result.processGroupSettlement !== 'group-exit-confirmed' || result.error || result.exitCode !== 0 || result.signal || result.outputTruncated ||
          Buffer.byteLength(result.stdout) > REPORT_BYTES + 2048) fail();
        try { return report(JSON.parse(result.stdout), request, startedAt); } catch { fail(); }
      } finally {
        clearTimeout(timer); options.signal?.removeEventListener('abort', cancelled);
        if (active === invocation) active = undefined;
        release();
      }
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      const pending = active;
      pending?.abort.abort();
      closePromise = (async () => { await pending?.done; if (faulted) fail('READ_PROJECTION_CLEANUP_UNCONFIRMED'); })();
      return closePromise;
    },
  };
}

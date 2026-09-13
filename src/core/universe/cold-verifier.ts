import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const COLD_VERIFIER_LIMITS = Object.freeze({ diffBytes: 256 * 1024, logBytes: 64 * 1024, maxDurationMs: 30_000 });
export interface ColdVerificationInput { schemaVersion: 1; specDigest: string; candidateDiff: string; testLog: string }
export interface ColdVerificationRequest extends ColdVerificationInput { inputDigest: string }
export interface ColdVerificationResponse {
  inputDigest: string; invocationId: string; executionId: string; verdict: 'pass' | 'fail' | 'unavailable';
}
export type ColdVerifierTransport = (request: Readonly<ColdVerificationRequest>, context: Readonly<{
  executionId: string; invocationId: string; signal: AbortSignal;
}>) => Promise<unknown> | unknown;
export interface ColdVerificationOptions {
  /** Trusted caller enrollment, not identities supplied by candidate output. */
  builderExecutionId: string;
  verifierExecutionId: string;
  enrolledExecutionIds: readonly string[];
  maxDurationMs: number;
  transport: ColdVerifierTransport;
  signal?: AbortSignal;
}
export type ColdVerificationReason = 'verified' | 'verifier-unavailable' | 'invalid-input' | 'invalid-options' |
  'identity-unavailable' | 'invalid-response' | 'binding-mismatch' | 'transport-failed' | 'cancelled' | 'timed-out';
export interface ColdVerificationResult {
  schemaVersion: 1; inputDigest: string | null; invocationId: string; builderExecutionId: string | null; verifierExecutionId: string | null;
  verdict: 'pass' | 'fail' | 'unavailable'; independent: boolean; durationMs: number; reason: ColdVerificationReason;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
/** Read data descriptors only: a verdict or evidence getter must never execute. */
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length ||
      !required.every((key) => keys.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}
function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes && Buffer.from(value, 'utf8').toString('utf8') === value;
}

/** No implementer rationale, transcript, prompt or chain of thought is accepted. */
export function createColdVerificationRequest(input: unknown): Readonly<ColdVerificationRequest> {
  const row = fields(input, ['schemaVersion', 'specDigest', 'candidateDiff', 'testLog']);
  if (!row || row.schemaVersion !== 1 || typeof row.specDigest !== 'string' || !HASH.test(row.specDigest) ||
      !boundedText(row.candidateDiff, COLD_VERIFIER_LIMITS.diffBytes) || !boundedText(row.testLog, COLD_VERIFIER_LIMITS.logBytes)) {
    throw new Error('Invalid cold verification evidence');
  }
  const { specDigest, candidateDiff, testLog } = row;
  // Fixed tuple encoding avoids locale-dependent object ordering and binds exact bytes.
  const inputDigest = createHash('sha256').update(JSON.stringify(['universe-cold-verification-v1', specDigest, candidateDiff, testLog])).digest('hex');
  return Object.freeze({ schemaVersion: 1, specDigest, candidateDiff, testLog, inputDigest });
}

/**
 * In-memory adapter only; never starts a process, contacts a provider or grants an
 * effect. The trusted transport must resolve the pinned spec and perform its own
 * confined checks; diff/log content is untrusted evidence, not instructions.
 * Distinct enrolled execution IDs + exact response binding establish only the
 * `independent` flag below, not separate human/model identity or oracle quality.
 * Aborting bounds this adapter's wait, not proof of transport/process settlement.
 * The trusted transport must return promptly: JavaScript cannot preempt a blocked
 * synchronous callback; its elapsed time is checked before accepting any result.
 */
export async function verifyUniverseCold(input: unknown, options: ColdVerificationOptions): Promise<ColdVerificationResult> {
  const start = performance.now();
  const invocationId = randomUUID();
  let request: Readonly<ColdVerificationRequest> | undefined;
  let builderExecutionId: string | null = null;
  let verifierExecutionId: string | null = null;
  const result = (reason: ColdVerificationReason, verdict: ColdVerificationResult['verdict'] = 'unavailable'): ColdVerificationResult => ({
    schemaVersion: 1, inputDigest: request?.inputDigest ?? null, invocationId, builderExecutionId, verifierExecutionId,
    verdict, independent: reason === 'verified' && verdict !== 'unavailable', durationMs: Math.max(0, performance.now() - start), reason,
  });
  try { request = createColdVerificationRequest(input); } catch { return result('invalid-input'); }
  let config: Record<string, unknown> | null;
  try { config = fields(options, ['builderExecutionId', 'verifierExecutionId', 'enrolledExecutionIds', 'maxDurationMs', 'transport'], ['signal']); }
  catch { return result('invalid-options'); }
  if (!config || typeof config.transport !== 'function' || !Number.isSafeInteger(config.maxDurationMs) ||
      (config.maxDurationMs as number) < 1 || (config.maxDurationMs as number) > COLD_VERIFIER_LIMITS.maxDurationMs ||
      (config.signal !== undefined && !(config.signal instanceof AbortSignal))) return result('invalid-options');
  const builder = config.builderExecutionId;
  const verifier = config.verifierExecutionId;
  const enrolled = config.enrolledExecutionIds;
  // Snapshot the trusted enrollment before transport starts; reject array getters.
  try {
    if (typeof builder !== 'string' || !ID.test(builder) || typeof verifier !== 'string' || !ID.test(verifier) || builder === verifier ||
        !Array.isArray(enrolled) || enrolled.length < 2 || enrolled.length > 128 || Reflect.ownKeys(enrolled).length !== enrolled.length + 1) return result('identity-unavailable');
    const identities: string[] = [];
    for (let index = 0; index < enrolled.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(enrolled, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !ID.test(descriptor.value)) return result('identity-unavailable');
      identities.push(descriptor.value);
    }
    if (new Set(identities).size !== identities.length || !identities.includes(builder) || !identities.includes(verifier)) return result('identity-unavailable');
  } catch { return result('identity-unavailable'); }
  builderExecutionId = builder; verifierExecutionId = verifier;
  const signal = config.signal as AbortSignal | undefined;
  const duration = config.maxDurationMs as number;
  const deadline = start + duration;
  if (signal?.aborted) return result('cancelled');
  if (performance.now() >= deadline) return result('timed-out');
  const controller = new AbortController();
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: 'cancelled' | 'timed-out' | undefined;
  const unavailable = new Promise<undefined>((resolve) => {
    const halt = (reason: 'cancelled' | 'timed-out'): void => {
      stopped ??= reason; controller.abort(); resolve(undefined);
    };
    stop = () => halt('cancelled');
    signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(() => halt('timed-out'), Math.max(1, deadline - performance.now()));
  });
  try {
    // Promise.race observes late rejection even when cancellation wins.
    const reply = Promise.resolve().then(() => {
      if (signal?.aborted || stopped || performance.now() >= deadline) return undefined;
      return (config.transport as ColdVerifierTransport)(request!, Object.freeze({ executionId: verifier, invocationId, signal: controller.signal }));
    });
    const response = await Promise.race([reply, unavailable]);
    if (signal?.aborted) return result('cancelled');
    if (stopped || performance.now() >= deadline) return result(stopped ?? 'timed-out');
    const row = fields(response, ['inputDigest', 'invocationId', 'executionId', 'verdict']);
    if (!row || typeof row.verdict !== 'string' || !['pass', 'fail', 'unavailable'].includes(row.verdict)) return result('invalid-response');
    if (row.inputDigest !== request.inputDigest || row.invocationId !== invocationId || row.executionId !== verifier) return result('binding-mismatch');
    return row.verdict === 'unavailable' ? result('verifier-unavailable') : result('verified', row.verdict as 'pass' | 'fail');
  } catch { return result(signal?.aborted ? 'cancelled' : stopped ?? (performance.now() >= deadline ? 'timed-out' : 'transport-failed')); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
    controller.abort();
  }
}

/** Pure sizing of already validated hot state; not receipts, quota evidence or
 * permission to publish. Keep this leaf independent of storage/runtime imports. */
import { canonical } from '../universe/artifacts.js';
import { MAX_RESOURCE_OBSERVATION_WINDOWS, type ResourcePool } from './pool-policy.js';
import { RESOURCE_NATIVE_PROCESS_SIGNALS } from './native-diagnostics.js';
import { resourceUsageScopeForProvider } from './performance.js';
import type { ResourcePoolState } from './pool-runtime.js';

const MAX_STATE_BYTES = 4 * 1024 * 1024;

/** Conservative future hot-state bytes, INCLUDING one persisted newline.
 * Caller supplies validated state/pool; returned sizing bytes are not evidence. */
export function resourcePoolSettlementEnvelopeBytes(state: ResourcePoolState, pool: ResourcePool): number {
  // The widest valid nonnegative duration JSON number occupies24characters.
  const widestNumber = 1.0000000000000002e-6;
  const widestDate = new Date(8_640_000_000_000_000).toISOString();
  const quotaDate = '9999-12-31T23:59:59.999Z';
  const longestSignal = RESOURCE_NATIVE_PROCESS_SIGNALS.reduce((longest, signal) => signal.length > longest.length ? signal : longest);
  const attempts = state.attempts.map((receipt) => {
    if (receipt.status !== 'reserved') return receipt;
    const provider = pool.workers.find((worker) => worker.id === receipt.workerId)!.provider;
    return { ...receipt, status: 'completed', finishedAt: widestDate, outputDigest: '0'.repeat(64),
      inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER,
      reason: 'x'.repeat(120), execution: { schemaVersion: 1, scope: 'worker-execution',
        durationMs: widestNumber, usageScope: resourceUsageScopeForProvider(provider) },
      ...(provider === 'local' ? {} : { nativeProcess: { schemaVersion: 1, scope: 'native-process',
        exitCode: null, signal: longestSignal, stderrPresent: false, outputTruncated: false } }) };
  });
  // Concurrent admissions may publish refreshes while these tasks run. Reserve
  // every enrolled worker/window, including optional native result timestamps.
  const observations = pool.workers.map((worker) => ({ workerId: worker.id, observedAt: quotaDate,
    expiresAt: quotaDate, updatedAt: quotaDate, health: 'unavailable', retryAfter: quotaDate,
    windows: Array.from({ length: MAX_RESOURCE_OBSERVATION_WINDOWS }, (_, index) => ({
      id: String(index).padStart(64, '0'), usedPercent: widestNumber, resetsAt: quotaDate })) }));
  return Buffer.byteLength(canonical({ ...state, attempts, observations }) + '\n');
}

/** Legacy entrypoint: unchanged limit and error, now sharing one sizing model. */
export function requireResourcePoolSettlementHeadroom(state: ResourcePoolState, pool: ResourcePool): void {
  if (resourcePoolSettlementEnvelopeBytes(state, pool) > MAX_STATE_BYTES) {
    throw new Error('Resource ledger settlement capacity reached');
  }
}

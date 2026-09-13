/** Explicit operator-pinned quota association. Model availability and account
 * entitlement still require native evidence; these references enable neither.
 */
import type { ResourceWorker } from './pool-policy.js';
import type { ResourcePool } from './pool-policy.js';
import type { ResourceBinding } from './worker.js';

export type ResourceQuotaScope = 'codex-general-v1' | 'codex-spark-v1';
const GENERAL_MODELS = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

export function validateResourceQuotaScope(provider: string, model: string, scope: unknown): ResourceQuotaScope {
  if (provider === 'codex' && (scope === 'codex-general-v1' && GENERAL_MODELS.has(model) ||
      scope === 'codex-spark-v1' && model === 'gpt-5.3-codex-spark')) return scope;
  throw new Error('Invalid resource quota scope: exact supported provider and model required');
}

export function resourceQuotaBuckets(worker: ResourceWorker): string[] | null {
  if (worker.quotaScope === undefined) return null;
  const scope = validateResourceQuotaScope(worker.provider, worker.model, worker.quotaScope);
  return [scope === 'codex-spark-v1' ? 'codex_bengalfox' : 'codex'];
}

/** Unmapped aliases retain the existing conservative account-wide quota scope. */
export function sharesResourceQuota(left: ResourceWorker, right: ResourceWorker): boolean {
  const a = resourceQuotaBuckets(left); const b = resourceQuotaBuckets(right);
  return a === null || b === null || a.some((bucket) => b.includes(bucket));
}

/** Expand quota-only vetoes, without splitting the account concurrency identity. */
export function expandResourceQuotaDenials(pool: ResourcePool, bindings: ResourceBinding[], ids: string[]): string[] {
  const denied = new Set(ids);
  for (const source of ids) {
    const worker = pool.workers.find((row) => row.id === source)!;
    const capacity = bindings.find((row) => row.workerId === source)!.capacityKey;
    for (const target of pool.workers) if (bindings.some((row) => row.workerId === target.id && row.capacityKey === capacity) &&
      sharesResourceQuota(worker, target)) denied.add(target.id);
  }
  return [...denied];
}

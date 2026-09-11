/** Durable operator restrictions, distinct from measured quota and account pauses. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { validateResourcePool, type ResourcePool } from './pool-policy.js';
import type { ResourceQuotaScope } from './quota-scope.js';
import { validateResourceBindings, type ResourceBinding } from './worker.js';

export interface ResourceQuotaScopeExclusion { capacityKey: string; quotaScope: ResourceQuotaScope }
export interface ResourceQuotaScopeAccess {
  exclusions: ResourceQuotaScopeExclusion[];
  revision: number;
  updatedAt: string | null;
}

/** Capture getter-free data before any policy inspection or storage effects. */
export function validateResourceQuotaScopeExclusions(value: unknown, pool: ResourcePool, bindings: ResourceBinding[]): ResourceQuotaScopeExclusion[] {
  const json = canonicalEvidencePackJsonV3(value);
  if (json === null || Buffer.byteLength(json) > 16 * 1024) throw new Error('Invalid resource quota scope exclusions');
  const rows: unknown = JSON.parse(json);
  const checkedPool = validateResourcePool(pool); const checkedBindings = validateResourceBindings(bindings, checkedPool);
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('Invalid resource quota scope exclusions');
  const seen = new Set<string>();
  const result = rows.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'capacityKey,quotaScope') {
      throw new Error('Invalid resource quota scope exclusions');
    }
    const candidate = row as ResourceQuotaScopeExclusion;
    if (typeof candidate.capacityKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate.capacityKey) ||
      !['codex-general-v1', 'codex-spark-v1'].includes(candidate.quotaScope) ||
      !checkedBindings.some(binding => binding.capacityKey === candidate.capacityKey &&
        checkedPool.workers.some(worker => worker.id === binding.workerId && worker.quotaScope === candidate.quotaScope))) {
      throw new Error('Invalid resource quota scope exclusions: exact enrolled account scope required');
    }
    const key = `${candidate.capacityKey}/${candidate.quotaScope}`;
    if (seen.has(key)) throw new Error('Invalid resource quota scope exclusions: duplicate account scope');
    seen.add(key); return { capacityKey: candidate.capacityKey, quotaScope: candidate.quotaScope };
  });
  return result.sort((a, b) => a.capacityKey.localeCompare(b.capacityKey) || a.quotaScope.localeCompare(b.quotaScope));
}

/** Unknown aliases are blocked, but never used to spread a veto to a separately pinned scope. */
export function excludedResourceQuotaScopeWorkerIds(pool: ResourcePool, bindings: ResourceBinding[], exclusions: ResourceQuotaScopeExclusion[]): string[] {
  const checked = validateResourceQuotaScopeExclusions(exclusions, pool, bindings);
  return pool.workers.filter(worker => bindings.some(binding => binding.workerId === worker.id &&
    checked.some(row => row.capacityKey === binding.capacityKey && (worker.quotaScope === undefined || worker.quotaScope === row.quotaScope))))
    .map(worker => worker.id);
}

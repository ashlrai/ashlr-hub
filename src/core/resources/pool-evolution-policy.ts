/** Pure additive compatibility; importing it never opens a store. */
import { canonical, digest } from '../universe/artifacts.js';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { validateResourcePool } from './pool-policy.js';
import { validateResourceBindings } from './worker.js';
import type { ResourcePoolConfigSnapshot } from './pool-evolution-types.js';
export const MAX_RESOURCE_POOL_CONFIGURATIONS = 16;
export function resourcePoolConfigSnapshot(pool: unknown, bindings: unknown): ResourcePoolConfigSnapshot {
  const text = canonicalEvidencePackJsonV3({ pool, bindings });
  if (text === null || Buffer.byteLength(text) > 256 * 1024) throw new Error('Invalid resource configuration snapshot');
  const input = JSON.parse(text) as { pool: unknown; bindings: unknown };
  const checkedPool = validateResourcePool(input.pool); const checkedBindings = validateResourceBindings(input.bindings, checkedPool);
  return { poolDigest: digest(canonical({ pool: checkedPool, bindings: checkedBindings })), pool: checkedPool, bindings: checkedBindings };
}
export function validateResourcePoolAdditiveEvolution(from: ResourcePoolConfigSnapshot, to: ResourcePoolConfigSnapshot): { addedWorkerIds: string[]; annotatedWorkerIds: string[] } {
  if (from.pool.id !== to.pool.id || from.poolDigest === to.poolDigest) throw new Error('Resource evolution requires a changed additive pool');
  const annotatedWorkerIds: string[] = [];
  for (const worker of from.pool.workers) {
    const next = to.pool.workers.find(row => row.id === worker.id);
    if (!next) throw new Error('Resource evolution cannot remove a worker');
    const { quotaScope: oldScope, ...oldRest } = worker; const { quotaScope: nextScope, ...nextRest } = next;
    if (canonical(oldRest) !== canonical(nextRest) || oldScope !== undefined && oldScope !== nextScope) throw new Error('Resource evolution cannot change existing worker policy');
    if (oldScope === undefined && nextScope !== undefined) annotatedWorkerIds.push(worker.id);
    if (canonical(from.bindings.find(row => row.workerId === worker.id)) !== canonical(to.bindings.find(row => row.workerId === worker.id))) {
      throw new Error('Resource evolution cannot change existing account bindings');
    }
  }
  const addedWorkerIds = to.pool.workers.filter(row => !from.pool.workers.some(old => old.id === row.id)).map(row => row.id);
  for (const id of addedWorkerIds) {
    const worker = to.pool.workers.find(row => row.id === id)!; const binding = to.bindings.find(row => row.workerId === id)!;
    const { workerId: _workerId, capacityKey: _capacityKey, ...locator } = binding;
    if (to.bindings.some(old => {
      const { workerId: _oldId, capacityKey: oldCapacity, ...oldLocator } = old;
      return oldCapacity !== binding.capacityKey && canonical(oldLocator) === canonical(locator);
    })) throw new Error('Resource evolution cannot split an existing account locator across capacities');
    const aliases = from.bindings.filter(row => row.capacityKey === binding.capacityKey);
    for (const alias of aliases) {
      const prior = from.pool.workers.find(row => row.id === alias.workerId)!;
      const { workerId: _old, ...oldLocator } = alias; const { workerId: _next, ...nextLocator } = binding;
      if (canonical(oldLocator) !== canonical(nextLocator) || worker.provider !== prior.provider ||
        worker.maxConcurrent !== prior.maxConcurrent || worker.maxTasksPerWindow !== prior.maxTasksPerWindow || worker.taskWindowMs !== prior.taskWindowMs ||
        worker.reservePercent < prior.reservePercent || worker.allowUnknownQuota === true && prior.allowUnknownQuota !== true) {
        throw new Error('Resource evolution cannot weaken an existing account capacity or reserve');
      }
    }
  }
  if (!addedWorkerIds.length && !annotatedWorkerIds.length) throw new Error('Resource evolution has no supported additions');
  return { addedWorkerIds, annotatedWorkerIds };
}
export function validateResourcePoolConfigHistory(value: unknown): ResourcePoolConfigSnapshot[] {
  const json = canonicalEvidencePackJsonV3(value);
  if (json === null || Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error('Invalid resource configuration history');
  const rows = JSON.parse(json) as ResourcePoolConfigSnapshot[];
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_RESOURCE_POOL_CONFIGURATIONS) throw new Error('Invalid resource configuration history');
  const result = rows.map(row => {
    if (!row || Object.keys(row).sort().join(',') !== 'bindings,pool,poolDigest') throw new Error('Invalid resource configuration snapshot');
    const checked = resourcePoolConfigSnapshot(row.pool, row.bindings);
    if (checked.poolDigest !== row.poolDigest) throw new Error('Resource configuration digest mismatch'); return checked;
  });
  if (new Set(result.map(row => row.poolDigest)).size !== result.length) throw new Error('Duplicate resource configuration epoch');
  for (let index = 1; index < result.length; index++) validateResourcePoolAdditiveEvolution(result[index - 1]!, result[index]!);
  return result;
}

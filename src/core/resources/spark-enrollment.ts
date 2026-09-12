/** Pure configuration proposal. No account discovery, admission, or policy mutation. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical } from '../universe/artifacts.js';
import { resourcePoolConfigSnapshot, validateResourcePoolAdditiveEvolution } from './pool-evolution-policy.js';
import type { ResourcePool } from './pool-policy.js';
import { validateResourceQuotaRefreshConfig, type ResourceQuotaRefreshConfig } from './quota-refresh.js';
import { validateResourceQuotaScope } from './quota-scope.js';
import { validateResourceQuotaScopeExclusions, type ResourceQuotaScopeExclusion } from './quota-scope-access.js';
import type { ResourceBinding } from './worker.js';

export interface ResourceSparkEnrollmentOptions {
  pool: unknown;
  bindings: unknown;
  quotaConfig: unknown;
  generalWorkerId: string;
  sparkWorkerId: string;
}

export interface ResourceSparkEnrollmentPreparation {
  pool: ResourcePool;
  bindings: ResourceBinding[];
  quotaConfig: ResourceQuotaRefreshConfig;
  /** Proposed restriction only: the caller must separately apply it through the existing policy owner. */
  generalExclusion: ResourceQuotaScopeExclusion;
  fromPoolDigest: string;
  toPoolDigest: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function fail(): never { throw new Error('Spark enrollment requires an unambiguous supported General account configuration'); }

export function prepareResourceSparkEnrollment(input: ResourceSparkEnrollmentOptions): ResourceSparkEnrollmentPreparation {
  // Capture strict own-data once, so accessors/proxies cannot alter a later validation phase.
  const json = canonicalEvidencePackJsonV3(input);
  if (json === null || Buffer.byteLength(json) > 256 * 1024) fail();
  const options = JSON.parse(json) as ResourceSparkEnrollmentOptions;
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).sort().join(',') !== 'bindings,generalWorkerId,pool,quotaConfig,sparkWorkerId' ||
    typeof options.generalWorkerId !== 'string' || !ID.test(options.generalWorkerId) ||
    typeof options.sparkWorkerId !== 'string' || !ID.test(options.sparkWorkerId) ||
    options.sparkWorkerId === options.generalWorkerId) fail();

  const from = resourcePoolConfigSnapshot(options.pool, options.bindings);
  const quota = validateResourceQuotaRefreshConfig(options.quotaConfig, from.pool, from.bindings);
  const general = from.pool.workers.find(worker => worker.id === options.generalWorkerId);
  const binding = from.bindings.find(row => row.workerId === options.generalWorkerId);
  const account = quota.workers.find(row => row.workerId === options.generalWorkerId);
  if (!general || !binding || binding.kind !== 'native-cli' || !account ||
    from.pool.workers.some(worker => worker.id === options.sparkWorkerId)) fail();
  validateResourceQuotaScope(general.provider, general.model, 'codex-general-v1');
  if (general.quotaScope !== undefined && general.quotaScope !== 'codex-general-v1') fail();

  // This bounded planner never reinterprets other aliases. Even an already scoped
  // alias requires a separate reviewed evolution rather than inferred independence.
  if (from.bindings.some(row => row.workerId !== general.id && (row.capacityKey === binding.capacityKey ||
    row.kind === 'native-cli' && canonical(row.command) === canonical(binding.command)))) fail();

  const to = resourcePoolConfigSnapshot({ ...from.pool, workers: [
    ...from.pool.workers.map(worker => worker.id === general.id ? { ...worker, quotaScope: 'codex-general-v1' } : worker),
    { ...general, id: options.sparkWorkerId, model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
  ] }, [...from.bindings, { ...binding, workerId: options.sparkWorkerId, command: [...binding.command] }]);
  validateResourcePoolAdditiveEvolution(from, to);

  // Preserve unrelated quota rows, including their existing bucket order. The
  // validator is authoritative but its sorted projection is not a requested edit.
  const suppliedQuota = options.quotaConfig as ResourceQuotaRefreshConfig;
  const quotaConfig: ResourceQuotaRefreshConfig = { schemaVersion: 1, poolDigest: to.poolDigest, workers: [
    ...suppliedQuota.workers.map(row => row.workerId === general.id ? { ...row, bucketIds: ['codex'] } : row),
    { workerId: options.sparkWorkerId, accountHint: account.accountHint, bucketIds: ['codex_bengalfox'] },
  ] };
  validateResourceQuotaRefreshConfig(quotaConfig, to.pool, to.bindings);
  const generalExclusion = validateResourceQuotaScopeExclusions([
    { capacityKey: binding.capacityKey, quotaScope: 'codex-general-v1' },
  ], to.pool, to.bindings)[0]!;
  return { pool: to.pool, bindings: to.bindings, quotaConfig, generalExclusion,
    fromPoolDigest: from.poolDigest, toPoolDigest: to.poolDigest };
}

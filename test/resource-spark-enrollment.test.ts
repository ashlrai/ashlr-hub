import { describe, expect, it, vi } from 'vitest';
import { prepareResourceSparkEnrollment } from '../src/core/resources/spark-enrollment.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { planResourceAssignment, type ResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from '../src/core/resources/worker.js';
import { validateResourceQuotaRefreshConfig, type ResourceQuotaRefreshConfig } from '../src/core/resources/quota-refresh.js';
import { resourcePoolConfigSnapshot, validateResourcePoolAdditiveEvolution } from '../src/core/resources/pool-evolution-policy.js';
import { excludedResourceQuotaScopeWorkerIds } from '../src/core/resources/quota-scope-access.js';

// Synthetic data only. No account files, native clients, leases or providers.
function fixture() {
  const pool: ResourcePool = { schemaVersion: 1, id: 'fixture-subscriptions', workers: [
    { id: 'personal', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 2, reservePercent: 25,
      maxTasksPerWindow: 7, taskWindowMs: 120_000, priority: 3 },
    { id: 'cmp', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 40,
      maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 9 },
    { id: 'claude', provider: 'claude', model: 'opus', maxConcurrent: 1, reservePercent: 30,
      maxTasksPerWindow: 2, taskWindowMs: 60_000, priority: 1 },
  ] };
  const bindings: ResourceBinding[] = pool.workers.map(row => ({ workerId: row.id, capacityKey: `${row.id}-account`,
    kind: 'native-cli', command: [`/synthetic/${row.id}/launcher`, '--fixed-profile'] }));
  const quotaConfig: ResourceQuotaRefreshConfig = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })), workers: [
    { workerId: 'personal', accountHint: 'a'.repeat(64), bucketIds: ['codex', 'legacy-extra'] },
    { workerId: 'cmp', accountHint: 'b'.repeat(64), bucketIds: ['codex'] },
  ] };
  return { pool, bindings, quotaConfig, generalWorkerId: 'personal', sparkWorkerId: 'personal-spark' };
}
type Fixture = ReturnType<typeof fixture>;
function repin(f: Fixture) { f.quotaConfig.poolDigest = digest(canonical({ pool: f.pool, bindings: f.bindings })); }
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
}

describe('pure Spark enrollment preparation', () => {
  it('adds an exact Spark alias without changing the account locator or any limits', () => {
    const f = fixture(); const before = structuredClone(f); freeze(f);
    const result = prepareResourceSparkEnrollment(f);
    expect(f).toEqual(before);
    expect(result.pool.workers).toEqual([
      { ...before.pool.workers[0], quotaScope: 'codex-general-v1' },
      ...before.pool.workers.slice(1),
      { ...before.pool.workers[0], id: 'personal-spark', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
    ]);
    expect(result.bindings).toEqual([...before.bindings, { ...before.bindings[0], workerId: 'personal-spark' }]);
    expect(validateResourceBindings(result.bindings, result.pool)).toEqual(result.bindings);
    expect(result.generalExclusion).toEqual({ capacityKey: 'personal-account', quotaScope: 'codex-general-v1' });
    expect(excludedResourceQuotaScopeWorkerIds(result.pool, result.bindings, [result.generalExclusion])).toEqual(['personal']);
    expect(validateResourcePoolAdditiveEvolution(resourcePoolConfigSnapshot(before.pool, before.bindings),
      resourcePoolConfigSnapshot(result.pool, result.bindings))).toEqual({ addedWorkerIds: ['personal-spark'], annotatedWorkerIds: ['personal'] });
  });

  it('rebinds the digest and exact quota buckets while retaining CMP and the pinned account hint', () => {
    const f = fixture(); const result = prepareResourceSparkEnrollment(f);
    expect(result.fromPoolDigest).toBe(f.quotaConfig.poolDigest);
    expect(result.toPoolDigest).toBe(digest(canonical({ pool: result.pool, bindings: result.bindings })));
    expect(result.toPoolDigest).not.toBe(result.fromPoolDigest);
    expect(result.quotaConfig).toEqual({ schemaVersion: 1, poolDigest: result.toPoolDigest, workers: [
      { ...f.quotaConfig.workers[0], bucketIds: ['codex'] }, f.quotaConfig.workers[1],
      { ...f.quotaConfig.workers[0], workerId: 'personal-spark', bucketIds: ['codex_bengalfox'] },
    ] });
    expect(validateResourceQuotaRefreshConfig(result.quotaConfig, result.pool, result.bindings)).toEqual(result.quotaConfig);
    expect(() => validateResourceQuotaRefreshConfig(f.quotaConfig, result.pool, result.bindings)).toThrow();
  });

  it.each([undefined, false, true])('preserves explicit/absent unknown-quota policy: %s', (policy) => {
    const f = fixture(); if (policy !== undefined) f.pool.workers[0]!.allowUnknownQuota = policy; repin(f);
    const result = prepareResourceSparkEnrollment(f); const spark = result.pool.workers.at(-1)!;
    expect(spark.allowUnknownQuota).toBe(policy);
    expect(Object.hasOwn(spark, 'allowUnknownQuota')).toBe(policy !== undefined);
  });

  it('accepts an already pinned General scope without changing its worker row', () => {
    const f = fixture(); f.pool.workers[0]!.quotaScope = 'codex-general-v1'; f.quotaConfig.workers[0]!.bucketIds = ['codex']; repin(f);
    const result = prepareResourceSparkEnrollment(f);
    expect(result.pool.workers[0]).toEqual(f.pool.workers[0]);
    expect(validateResourcePoolAdditiveEvolution(resourcePoolConfigSnapshot(f.pool, f.bindings),
      resourcePoolConfigSnapshot(result.pool, result.bindings)).annotatedWorkerIds).toEqual([]);
  });

  it('preserves unrelated quota row order and bucket order exactly', () => {
    const f = fixture(); f.quotaConfig.workers[1]!.bucketIds = ['z-last', 'codex'];
    f.quotaConfig.workers.reverse();
    const result = prepareResourceSparkEnrollment(f);
    expect(result.quotaConfig.workers[0]).toEqual(f.quotaConfig.workers[0]);
    expect(result.quotaConfig.workers.map(row => row.workerId)).toEqual(['cmp', 'personal', 'personal-spark']);
    expect(result.pool.workers.slice(1, 3)).toEqual(f.pool.workers.slice(1));
  });

  it('returns detached data and no observations, account unpause or evidence of readiness', () => {
    const f = fixture(); const result = prepareResourceSparkEnrollment(f);
    expect(Object.keys(result).sort()).toEqual(['bindings', 'fromPoolDigest', 'generalExclusion', 'pool', 'quotaConfig', 'toPoolDigest']);
    expect(result.pool).not.toBe(f.pool); expect(result.pool.workers[1]).not.toBe(f.pool.workers[1]);
    expect(result.bindings[0]).not.toBe(f.bindings[0]);
    expect(result.quotaConfig.workers[1]).not.toBe(f.quotaConfig.workers[1]);
    const plan = planResourceAssignment({ pool: result.pool, observations: [], allowedWorkerIds: ['personal-spark'],
      activeCounts: {}, taskReservationCounts: {}, nowMs: 1_800_000_000_000 });
    expect(plan.candidates).toEqual([]);
    expect(plan.exclusions.find(row => row.workerId === 'personal-spark')?.reasons).toContain('observation-missing');
  });

  const invalid: Array<[string, (f: Fixture) => void]> = [
    ['occupied Spark id', f => { f.sparkWorkerId = 'cmp'; }],
    ['same worker id', f => { f.sparkWorkerId = 'personal'; }],
    ['invalid Spark id', f => { f.sparkWorkerId = '../spark'; }],
    ['missing General id', f => { f.generalWorkerId = 'missing'; }],
    ['unsupported General model', f => { f.pool.workers[0]!.model = 'unsupported-general'; repin(f); }],
    ['Spark as General', f => { f.pool.workers[0]!.model = 'gpt-5.3-codex-spark'; repin(f); }],
    ['non-Codex selection', f => { f.generalWorkerId = 'claude'; }],
    ['wrong existing scope', f => { f.pool.workers[0]!.quotaScope = 'codex-spark-v1'; repin(f); }],
    ['stale config digest', f => { f.quotaConfig.poolDigest = '0'.repeat(64); }],
    ['missing selected quota row', f => { f.quotaConfig.workers.shift(); }],
    ['duplicate pool id', f => { f.pool.workers.push({ ...f.pool.workers[0]! }); repin(f); }],
    ['duplicate binding', f => { f.bindings.push(structuredClone(f.bindings[0]!)); repin(f); }],
    ['duplicate quota row', f => { f.quotaConfig.workers.push(structuredClone(f.quotaConfig.workers[0]!)); }],
    ['stale binding locator', f => { const b = f.bindings[0]!; if (b.kind === 'native-cli') b.command.push('--changed'); }],
    ['ambiguous account hint', f => { f.quotaConfig.workers[1]!.accountHint = f.quotaConfig.workers[0]!.accountHint; }],
    ['same locator under a different capacity', f => {
      const b = f.bindings[0]!; if (b.kind !== 'native-cli') throw new Error('fixture');
      f.bindings[1] = { ...b, workerId: 'cmp', capacityKey: 'cmp-account', command: [...b.command] }; repin(f);
    }],
    ['existing same-capacity alias', f => {
      f.pool.workers.push({ ...f.pool.workers[0]!, id: 'old-alias' });
      f.bindings.push({ ...structuredClone(f.bindings[0]!), workerId: 'old-alias' });
      f.quotaConfig.workers.push({ ...structuredClone(f.quotaConfig.workers[0]!), workerId: 'old-alias' }); repin(f);
    }],
  ];
  it.each(invalid)('refuses %s without mutating inputs', (_name, mutate) => {
    const f = fixture(); mutate(f); const before = structuredClone(f);
    expect(() => prepareResourceSparkEnrollment(f)).toThrow(); expect(f).toEqual(before);
  });

  it.each(['pool', 'bindings', 'quotaConfig'] as const)('rejects malformed %s', key => {
    const f = fixture(); expect(() => prepareResourceSparkEnrollment({ ...f, [key]: null })).toThrow();
  });

  it('refuses an unexpected input field instead of accepting observation or mutation authority', () => {
    const input = { ...fixture(), observations: [] };
    expect(() => prepareResourceSparkEnrollment(input)).toThrow();
  });

  it('rejects accessors without invoking them', () => {
    const f = fixture(); const getter = vi.fn(() => f.pool);
    Object.defineProperty(f, 'pool', { enumerable: true, get: getter });
    expect(() => prepareResourceSparkEnrollment(f)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });

  it('rejects nested accessors, sparse arrays and cycles', () => {
    const getter = vi.fn(() => 'gpt-6-astra'); const f = fixture();
    Object.defineProperty(f.pool.workers[0], 'model', { enumerable: true, get: getter });
    expect(() => prepareResourceSparkEnrollment(f)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const sparse = fixture(); delete sparse.bindings[0]; expect(() => prepareResourceSparkEnrollment(sparse)).toThrow();
    const cycle = fixture(); Object.assign(cycle.pool, { cycle: cycle.pool }); expect(() => prepareResourceSparkEnrollment(cycle)).toThrow();
  });
});

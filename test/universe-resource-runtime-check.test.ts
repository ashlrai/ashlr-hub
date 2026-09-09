/** Private fixtures and bounded Git inspection only; provider transports must stay inert. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { checkResourceGenerationRuntime, type ResourceGenerationCheckStage } from '../src/core/universe/resource-runtime-check.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import * as worker from '../src/core/resources/worker.js';
import * as quota from '../src/core/resources/quota-refresh.js';
import * as local from '../src/core/resources/local-model-refresh.js';
import * as probe from '../src/core/resources/codex-account-probe.js';
import * as poolRuntime from '../src/core/resources/pool-runtime.js';

let base: string;
const save = (file: string, value: unknown): void => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-runtime-check-')));
  for (const [module, name] of [[worker, 'executeResourceWorker'], [quota, 'refreshResourceQuotaOnce'],
    [local, 'refreshResourceLocalModelsOnce'], [probe, 'probeCodexResourceAccount']] as const) {
    vi.spyOn(module, name).mockImplementation(() => { throw new Error('Provider must not be contacted'); });
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network must not be contacted'); });
});
afterEach(() => {
  expect(worker.executeResourceWorker).not.toHaveBeenCalled(); expect(quota.refreshResourceQuotaOnce).not.toHaveBeenCalled();
  expect(local.refreshResourceLocalModelsOnce).not.toHaveBeenCalled(); expect(probe.probeCodexResourceAccount).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true });
});

function fixture(refresh = true) {
  const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', workspace], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'four-worker-fleet',
    workers: ['codex-a', 'codex-b', 'claude-a', 'local-a'].map((id) => ({ id,
      provider: id.startsWith('codex') ? 'codex' : id.startsWith('claude') ? 'claude' : 'local', model: `private-${id}-model`,
      maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 })) });
  const bindings = validateResourceBindings(pool.workers.map((row) => row.provider === 'local'
    ? { workerId: row.id, capacityKey: row.id, kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1' }
    : { workerId: row.id, capacityKey: row.id, kind: 'native-cli', command: [join(base, `${row.id}-must-not-run`)] }), pool);
  const poolDigest = digest(canonical({ pool, bindings }));
  const now = Date.now(); const at = (offset: number) => new Date(now + offset).toISOString();
  const observations = pool.workers.map((row) => ({ workerId: row.id, health: 'ready', observedAt: at(-1000),
    expiresAt: at(60_000), retryAfter: null, windows: row.provider === 'local' ? []
      : [{ id: 'weekly', usedPercent: 20, resetsAt: at(120_000) }] }));
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: join(base, 'ledger'), workspace,
    ...(refresh ? { quotaConfigPath: join(base, 'quota.json'), localModelConfigPath: join(base, 'local.json') } : {}) };
  const runtimePath = join(base, 'runtime.json');
  save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations); save(runtimePath, runtime);
  const quotaConfig = { schemaVersion: 1, poolDigest, workers: ['codex-a', 'codex-b'].map((workerId, index) =>
    ({ workerId, accountHint: (index ? 'b' : 'a').repeat(64), bucketIds: ['codex'] })) };
  const localConfig = { schemaVersion: 1, poolDigest, workers: [{ workerId: 'local-a', modelDigest: `sha256:${'c'.repeat(64)}` }] };
  if (runtime.quotaConfigPath) save(runtime.quotaConfigPath, quotaConfig);
  if (runtime.localModelConfigPath) save(runtime.localModelConfigPath, localConfig);
  return { runtime, runtimePath, pool, bindings, poolDigest, observations, quotaConfig, localConfig, at,
    check: () => checkResourceGenerationRuntime({ resourceRuntime: runtimePath }) };
}

function inventory(root: string): unknown {
  const stat = lstatSync(root);
  return stat.isDirectory() ? { mode: stat.mode, children: Object.fromEntries(readdirSync(root).sort().map((name) => [name, inventory(join(root, name))])) }
    : { mode: stat.mode, contents: readFileSync(root).toString('base64') };
}
function failed(result: ReturnType<typeof checkResourceGenerationRuntime>, stage: ResourceGenerationCheckStage): void {
  expect(result).toMatchObject({ status: 'invalid', providerContacted: false, poolId: null, poolDigest: null,
    sourceState: null, sampledAt: null, workers: [], counts: null, allocationCeilingPercent: null, nextEligibleAt: null });
  expect(result.checks.filter((row) => row.status === 'failed')).toEqual([{ code: stage, status: 'failed' }]);
  expect(JSON.stringify(result)).not.toContain(base);
}

describe.skipIf(process.platform === 'win32')('read-only resource runtime configuration check', () => {
  it('reports two Codex identities, Claude and local coverage without claiming authentication or mutating any input', () => {
    const f = fixture(); const before = inventory(base); const result = f.check();
    expect(result).toMatchObject({ schemaVersion: 1, status: 'valid', evidenceScope: 'local-configuration-only', providerContacted: false,
      poolId: f.pool.id, poolDigest: f.poolDigest, sourceState: 'missing' });
    expect(result).toMatchObject({ counts: { workers: 4, eligibleWorkers: 4, excludedWorkers: 0, capacities: 4, eligibleCapacities: 4 },
      allocationCeilingPercent: null, nextEligibleAt: null });
    expect(result.workers.every((row) => row.nextEligibleAt === null && !row.policyHolds.length && !row.nextChecks.length)).toBe(true);
    expect(result.checks.every((row) => row.status === 'passed')).toBe(true);
    expect(result.sampledAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(result.workers.map((row) => [row.workerId, row.provider, row.quotaRefreshConfigured, row.localModelRefreshConfigured,
      row.eligibility])).toEqual([
      ['codex-a', 'codex', true, false, 'eligible'], ['codex-b', 'codex', true, false, 'eligible'],
      ['claude-a', 'claude', false, false, 'eligible'], ['local-a', 'local', false, true, 'eligible']]);
    expect(result.warnings).toEqual(['execution-and-account-identity-unverified', 'campaign-boundaries-unchecked', 'resource-store-missing']);
    expect(inventory(base)).toEqual(before); expect(existsSync(f.runtime.root)).toBe(false);
    const text = JSON.stringify(result);
    for (const privateValue of [base, 'private-codex-a-model', '127.0.0.1', 'a'.repeat(64), 'sha256:', 'must-not-run']) {
      expect(text).not.toContain(privateValue);
    }
  });
  it('does not require refresh configuration or reinterpret missing coverage as current readiness', () => {
    const f = fixture(false); const result = f.check(); expect(result.status).toBe('valid');
    expect(result.checks.filter((row) => row.status === 'not-configured').map((row) => row.code)).toEqual(['quota-refresh', 'local-model-refresh']);
    expect(result.workers[0]!.warnings).toContain('quota-refresh-not-configured');
    expect(result.workers[3]!.warnings).toContain('local-model-refresh-not-configured');
  });
  it.each(['missing', 'stale', 'future', 'unavailable', 'unknown', 'exhausted', 'retry'] as const)(
    'keeps valid configuration distinct from %s admission evidence', (kind) => {
      const f = fixture(); const observations = f.observations;
      if (kind === 'missing') observations.splice(0, 1);
      if (kind === 'stale') Object.assign(observations[0]!, { observedAt: f.at(-120_000), expiresAt: f.at(-60_000) });
      if (kind === 'future') Object.assign(observations[0]!, { observedAt: f.at(10_000), expiresAt: f.at(60_000) });
      if (kind === 'unavailable') observations[0]!.health = 'unavailable';
      if (kind === 'unknown') observations[0]!.windows = [];
      if (kind === 'exhausted') observations[0]!.windows[0]!.usedPercent = 95;
      if (kind === 'retry') Object.assign(observations[0]!, { retryAfter: f.at(60_000) });
      save(f.runtime.observationsPath, observations);
      const result = f.check(); expect(result.status).toBe('valid');
      expect(result.workers[0]!.eligibility).toBe('excluded'); expect(result.workers[0]!.exclusionReasons.length).toBeGreaterThan(0);
    });
  it('marks identical native argv in different capacity keys without claiming different argv establish identity', () => {
    const f = fixture(false); const bindings = JSON.parse(JSON.stringify(f.bindings));
    bindings[1].command = bindings[0].command; save(f.runtime.bindingsPath, bindings);
    const result = f.check(); expect(result.status).toBe('valid');
    expect(result.workers.slice(0, 2).every((row) => row.warnings.includes('duplicate-native-command-across-capacities'))).toBe(true);
    expect(result.workers[2]!.warnings).not.toContain('duplicate-native-command-across-capacities');
  });
  it('permits deliberately shared aliases without a duplicate-capacity warning', () => {
    const f = fixture(false); const bindings = JSON.parse(JSON.stringify(f.bindings));
    bindings[1].command = bindings[0].command; bindings[1].capacityKey = bindings[0].capacityKey;
    save(f.runtime.bindingsPath, bindings); const result = f.check(); expect(result.status).toBe('valid');
    expect(result.workers.every((row) => !row.warnings.includes('duplicate-native-command-across-capacities'))).toBe(true);
    expect(result.counts).toEqual({ workers: 4, eligibleWorkers: 4, excludedWorkers: 0, capacities: 3, eligibleCapacities: 3 });
  });
  it('explains an owner pause for every shared-capacity alias from one unchanged snapshot', () => {
    const f = fixture(false); const bindings = f.bindings.map((row) => row.workerId === 'codex-b' ? { ...row, capacityKey: 'codex-a' } : row);
    save(f.runtime.bindingsPath, bindings); mkdirSync(f.runtime.root, { mode: 0o700 });
    save(join(f.runtime.root, 'pool-state.json'), { schemaVersion: 1, poolDigest: digest(canonical({ pool: f.pool, bindings })),
      observations: [], attempts: [], workerAccess: { pausedWorkerIds: ['codex-a'], revision: 1, updatedAt: f.at(-1000) } });
    const status = vi.spyOn(poolRuntime, 'resourcePoolStatus'); const before = inventory(base); const result = f.check();
    expect(status).toHaveBeenCalledTimes(1);
    expect(result.counts).toEqual({ workers: 4, eligibleWorkers: 2, excludedWorkers: 2, capacities: 3, eligibleCapacities: 2 });
    for (const row of result.workers.slice(0, 2)) expect(row).toMatchObject({ eligibility: 'excluded',
      policyHolds: ['owner-paused'], nextChecks: ['review-owner-pause'], exclusionReasons: ['worker-unavailable'] });
    expect(result.workers.slice(2).every((row) => row.eligibility === 'eligible' && !row.policyHolds.length)).toBe(true);
    expect(inventory(base)).toEqual(before);
  });
  it('explains a zero subscription allocation without mislabeling local models or altering reserves', () => {
    const f = fixture(); mkdirSync(f.runtime.root, { mode: 0o700 });
    save(join(f.runtime.root, 'pool-state.json'), { schemaVersion: 1, poolDigest: f.poolDigest, observations: [], attempts: [],
      allocation: { ceilingPercent: 0, revision: 1, updatedAt: f.at(-1000) } });
    const before = inventory(base); const result = f.check();
    expect(result).toMatchObject({ status: 'valid', allocationCeilingPercent: 0,
      counts: { workers: 4, eligibleWorkers: 1, excludedWorkers: 3, capacities: 4, eligibleCapacities: 1 } });
    for (const row of result.workers.slice(0, 3)) expect(row).toMatchObject({ eligibility: 'excluded',
      policyHolds: ['subscription-allocation-disabled'], nextChecks: ['review-subscription-allocation'] });
    expect(result.workers[3]).toMatchObject({ eligibility: 'eligible', policyHolds: [], nextChecks: [] });
    expect(inventory(base)).toEqual(before);
  });
  it('preserves each planner retry hint and the earliest pool hint without predicting quota reset recovery', () => {
    const f = fixture(); Object.assign(f.observations[0]!, { retryAfter: f.at(50_000) });
    Object.assign(f.observations[1]!, { retryAfter: f.at(40_000) });
    f.observations[2]!.windows[0]!.usedPercent = 95;
    save(f.runtime.observationsPath, f.observations); const result = f.check();
    expect(result.nextEligibleAt).toBe(f.at(40_000));
    expect(result.workers[0]).toMatchObject({ nextEligibleAt: f.at(50_000), nextChecks: ['recheck-after-hint'] });
    expect(result.workers[1]).toMatchObject({ nextEligibleAt: f.at(40_000), nextChecks: ['recheck-after-hint'] });
    expect(result.workers[2]).toMatchObject({ nextEligibleAt: null, policyHolds: [] });
    expect(result.workers[2]!.nextChecks).toContain('review-reserve-evidence');
  });
  it('reports all-excluded valid configuration and unavailable as inspection rather than a diagnosed provider outage', () => {
    const f = fixture(); save(f.runtime.observationsPath, f.observations.map((row) => ({ ...row, health: 'unavailable' })));
    const result = f.check(); expect(result).toMatchObject({ status: 'valid',
      counts: { workers: 4, eligibleWorkers: 0, excludedWorkers: 4, capacities: 4, eligibleCapacities: 0 } });
    for (const row of result.workers) expect(row).toMatchObject({ policyHolds: [], nextChecks: ['review-worker-availability'] });
  });
  it('keeps missing alias evidence as a planner exclusion without inventing an owner hold', () => {
    const f = fixture(false); const bindings = f.bindings.map((row) => row.workerId === 'codex-b' ? { ...row, capacityKey: 'codex-a' } : row);
    save(f.runtime.bindingsPath, bindings); save(f.runtime.observationsPath, f.observations.filter((row) => row.workerId !== 'codex-b'));
    mkdirSync(f.runtime.root, { mode: 0o700 });
    save(join(f.runtime.root, 'pool-state.json'), { schemaVersion: 1, poolDigest: digest(canonical({ pool: f.pool, bindings })),
      observations: [], attempts: [], allocation: { ceilingPercent: 75, revision: 1, updatedAt: f.at(-1000) } });
    const before = inventory(base); const result = f.check();
    expect(result.workers[0]).toMatchObject({ eligibility: 'excluded', policyHolds: [], exclusionReasons: ['worker-unavailable'],
      nextChecks: ['review-worker-availability'] });
    expect(result.workers[1]!.nextChecks).toContain('refresh-quota-evidence');
    expect(result.counts).toMatchObject({ eligibleWorkers: 2, excludedWorkers: 2, capacities: 3, eligibleCapacities: 2 });
    expect(inventory(base)).toEqual(before);
  });
  it('suggests local evidence refresh without equating configuration to a running local server', () => {
    const f = fixture(); save(f.runtime.observationsPath, f.observations.filter((row) => row.workerId !== 'local-a'));
    expect(f.check().workers[3]).toMatchObject({ eligibility: 'excluded', exclusionReasons: ['observation-missing'],
      policyHolds: [], nextChecks: ['refresh-local-evidence'], nextEligibleAt: null });
  });
  it.each(['missing', 'stale', 'unknown'] as const)('suggests evidence refresh for %s observations without weakening allocation', (kind) => {
    const f = fixture(); mkdirSync(f.runtime.root, { mode: 0o700 });
    save(join(f.runtime.root, 'pool-state.json'), { schemaVersion: 1, poolDigest: f.poolDigest, observations: [], attempts: [],
      allocation: { ceilingPercent: 75, revision: 1, updatedAt: f.at(-1000) } });
    if (kind === 'missing') f.observations.splice(0, 1);
    if (kind === 'stale') Object.assign(f.observations[0]!, { observedAt: f.at(-120_000), expiresAt: f.at(-60_000) });
    if (kind === 'unknown') f.observations[0]!.windows = [];
    save(f.runtime.observationsPath, f.observations); const before = inventory(base); const result = f.check();
    expect(result.allocationCeilingPercent).toBe(75);
    expect(result.workers[0]).toMatchObject({ eligibility: 'excluded', policyHolds: [] });
    expect(result.workers[0]!.nextChecks).toContain('refresh-quota-evidence');
    expect(inventory(base)).toEqual(before);
  });
  it('reports explicit unknown quota bootstrap separately from healthy evidence', () => {
    const f = fixture(false); const pool = JSON.parse(JSON.stringify(f.pool)); pool.workers[0].allowUnknownQuota = true;
    save(f.runtime.poolPath, pool); save(f.runtime.observationsPath, f.observations.map((row) => ({ ...row, windows: [] })));
    const result = f.check(); expect(result.status).toBe('valid');
    expect(result.workers[0]).toMatchObject({ eligibility: 'eligible', warnings: ['quota-refresh-not-configured', 'unknown-quota-opt-in'] });
    expect(result.workers[1]!.eligibility).toBe('excluded');
  });
  it.each(['runtime', 'pool', 'bindings', 'observations', 'quota-refresh', 'local-model-refresh'] as const)(
    'redacts malformed %s data and does not create the ledger', (stage) => {
      const f = fixture(); const files = { runtime: f.runtimePath, pool: f.runtime.poolPath, bindings: f.runtime.bindingsPath,
        observations: f.runtime.observationsPath, 'quota-refresh': f.runtime.quotaConfigPath!, 'local-model-refresh': f.runtime.localModelConfigPath! };
      writeFileSync(files[stage], `private malformed data ${base}`); failed(f.check(), stage); expect(existsSync(f.runtime.root)).toBe(false);
    });
  it.each(['runtime', 'pool', 'bindings', 'observations', 'quota-refresh', 'local-model-refresh'] as const)(
    'refuses non-private %s files', (stage) => {
      const f = fixture(); const files = { runtime: f.runtimePath, pool: f.runtime.poolPath, bindings: f.runtime.bindingsPath,
        observations: f.runtime.observationsPath, 'quota-refresh': f.runtime.quotaConfigPath!, 'local-model-refresh': f.runtime.localModelConfigPath! };
      chmodSync(files[stage], 0o644); failed(f.check(), stage);
    });
  it('rejects an unsupported Grok provider without fabricating a transport', () => {
    const f = fixture(); const pool = JSON.parse(JSON.stringify(f.pool)); pool.workers[0].provider = 'grok'; save(f.runtime.poolPath, pool);
    failed(f.check(), 'pool');
  });
  it('rejects mismatched quota pins', () => {
    const f = fixture(); save(f.runtime.quotaConfigPath!, { ...f.quotaConfig, poolDigest: 'd'.repeat(64) }); failed(f.check(), 'quota-refresh');
  });
  it('rejects the same Codex hint represented as independent capacity', () => {
    const f = fixture(); const quotaConfig = JSON.parse(JSON.stringify(f.quotaConfig));
    quotaConfig.workers[1].accountHint = quotaConfig.workers[0].accountHint; save(f.runtime.quotaConfigPath!, quotaConfig);
    failed(f.check(), 'quota-refresh');
  });
  it('rejects an omitted alias from managed shared quota capacity', () => {
    const f = fixture(); const bindings = JSON.parse(JSON.stringify(f.bindings)); bindings[1].capacityKey = bindings[0].capacityKey;
    save(f.runtime.bindingsPath, bindings); save(f.runtime.quotaConfigPath!, { ...f.quotaConfig,
      poolDigest: digest(canonical({ pool: f.pool, bindings })), workers: [f.quotaConfig.workers[0]] }); failed(f.check(), 'quota-refresh');
  });
  it('rejects changed local model pool pins before contacting its endpoint', () => {
    const f = fixture(); save(f.runtime.localModelConfigPath!, { ...f.localConfig, poolDigest: 'd'.repeat(64) }); failed(f.check(), 'local-model-refresh');
  });
  it('rejects unsafe runtime/workspace overlap', () => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, root: join(f.runtime.workspace, 'ledger') }); failed(f.check(), 'boundaries');
  });
  it('rejects config paths inside the task workspace before reading them', () => {
    const f = fixture(); save(f.runtimePath, { ...f.runtime, poolPath: join(f.runtime.workspace, 'pool.json') }); failed(f.check(), 'boundaries');
  });
  it('rejects a missing canonical ledger parent without creating it', () => {
    const f = fixture(); const missing = join(base, 'missing-parent'); save(f.runtimePath, { ...f.runtime, root: join(missing, 'ledger') });
    failed(f.check(), 'boundaries'); expect(existsSync(missing)).toBe(false);
  });
  it.each(['not-empty', 'public', 'git-symlink'] as const)('rejects %s workspace', (kind) => {
    const f = fixture();
    if (kind === 'not-empty') writeFileSync(join(f.runtime.workspace, 'task.txt'), 'must not execute');
    if (kind === 'public') chmodSync(f.runtime.workspace, 0o755);
    if (kind === 'git-symlink') {
      const other = join(base, 'elsewhere'); mkdirSync(other, { mode: 0o700 });
      rmSync(join(f.runtime.workspace, '.git'), { recursive: true }); symlinkSync(other, join(f.runtime.workspace, '.git'));
    }
    failed(f.check(), 'workspace');
  });
  it('reads an existing ledger without changing it or reserving locks', () => {
    const f = fixture(); mkdirSync(f.runtime.root, { mode: 0o700 });
    save(join(f.runtime.root, 'pool-state.json'), { schemaVersion: 1, poolDigest: f.poolDigest, observations: [], attempts: [] });
    const before = inventory(base); const result = f.check(); expect(result).toMatchObject({ status: 'valid', sourceState: 'healthy' });
    expect(inventory(base)).toEqual(before);
  });
  it('redacts a malformed ledger and leaves it unchanged', () => {
    const f = fixture(); mkdirSync(f.runtime.root, { mode: 0o700 }); save(join(f.runtime.root, 'pool-state.json'), { private: base });
    const before = inventory(base); failed(f.check(), 'ledger'); expect(inventory(base)).toEqual(before);
  });
  it.each(['reserved', 'uncertain'] as const)('preserves %s ownership and reports occupied capacity without repairing it', (status) => {
    const f = fixture(); mkdirSync(f.runtime.root, { mode: 0o700 });
    save(join(f.runtime.root, 'pool-state.json'), { schemaVersion: 1, poolDigest: f.poolDigest, observations: [], attempts: [{
      schemaVersion: 1, id: 'prior-task', taskDigest: 'd'.repeat(64), poolDigest: f.poolDigest, workerId: 'codex-a', capacityKey: 'codex-a',
      status, startedAt: f.at(-1000), finishedAt: status === 'reserved' ? null : f.at(-500), outputDigest: null,
      inputTokens: null, outputTokens: null, reason: 'prior-owner-evidence', verifiedAccepted: false,
    }] });
    const before = inventory(base); const result = f.check(); expect(result.status).toBe('valid');
    expect(result.workers[0]).toMatchObject({ eligibility: 'excluded', exclusionReasons: ['concurrency-exhausted'] });
    expect(result.workers[0]!.nextChecks).toEqual([status === 'reserved' ? 'wait-for-active-work' : 'inspect-capacity-ownership']);
    expect(result.workers[1]!.eligibility).toBe('eligible'); expect(inventory(base)).toEqual(before);
  });
  it.each(['relative.json', '/', '/tmp/../tmp/runtime.json', '/tmp/runtime\n.json'])('refuses invalid explicit path %j', (resourceRuntime) => {
    failed(checkResourceGenerationRuntime({ resourceRuntime }), 'runtime');
  });
});

/** Real private quota witnesses, Git workspaces and ledger transactions; worker/probe transports are inert. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { generateResourceCompletion, validateResourceGenerationRuntime, type ResourceGenerationContext,
  type ResourceGenerationRuntime } from '../src/core/universe/resource-generation.js';
import { resourcePoolStatus, setResourcePoolAllocation } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { publishSharedQuotaEvidence, readSharedQuotaEvidence, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME } from '../src/core/resources/quota-shared-evidence.js';
import * as workers from '../src/core/resources/worker.js';
import * as quota from '../src/core/resources/quota-refresh.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import type { UniverseResourceGenerationConfig } from '../src/core/universe/types.js';

let base: string;
const leases: ResourceQuotaRefreshLease[] = [];
const output = JSON.stringify({ edits: [{ path: 'value.json', content: '1\n' }] });
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-universe-shared-quota-'))); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Intentionally changed ownership fixtures. */ } }
  rmSync(base, { recursive: true, force: true });
});
async function fixture(capacityWaitMs?: number) {
  const universeRoot = join(base, 'universe'); const candidatePath = join(universeRoot, 'candidate');
  mkdirSync(universeRoot, { mode: 0o700 }); mkdirSync(candidatePath, { mode: 0o700 });
  writeFileSync(join(candidatePath, 'value.json'), '0\n');
  const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', workspace], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'shared-universe', workers: [{
    id: 'native', provider: 'codex', model: 'fixture', maxConcurrent: 1, reservePercent: 25,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: false }] });
  const bindings = workers.validateResourceBindings([{ workerId: 'native', capacityKey: 'account', kind: 'native-cli',
    command: ['/test-owned/inert-native'] }], pool);
  const config: UniverseResourceGenerationConfig = { kind: 'resource-pool', poolId: pool.id,
    poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['native'], files: ['value.json'], maxOutputTokens: 100 };
  const runtime: ResourceGenerationRuntime = { schemaVersion: 1, poolPath: join(base, 'pool.json'),
    bindingsPath: join(base, 'bindings.json'), observationsPath: join(base, 'observations.json'),
    root: join(base, 'ledger'), workspace, quotaConfigPath: join(base, 'quota.json'), quotaEvidenceMode: 'shared-collector',
    ...(capacityWaitMs === undefined ? {} : { capacityWaitMs }) };
  const quotaConfig = quota.validateResourceQuotaRefreshConfig({ schemaVersion: 1, poolDigest: config.poolDigest,
    workers: [{ workerId: 'native', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] }, pool, bindings);
  const observedAt = Date.now();
  const observation: ResourceObservation = { workerId: 'native', observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(observedAt + 60_000).toISOString(), health: 'ready',
    retryAfter: null, windows: [{ id: 'codex_codex_primary', usedPercent: 20, resetsAt: iso(3_600_000) }] };
  const runtimePath = join(base, 'runtime.json');
  save(runtimePath, runtime); save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.quotaConfigPath!, quotaConfig);
  // A successful generation must actually consume shared evidence: the ordinary
  // observations file cannot independently establish fresh readiness.
  save(runtime.observationsPath, [{ ...observation, observedAt: iso(-120_000), expiresAt: iso(-60_000) }]);
  const lease = await acquireResourceQuotaRefreshLease(runtime.root); leases.push(lease); lease.markPending();
  const sharedScope = { root: runtime.root, pool, bindings, config: quotaConfig };
  const publish = (unavailableWorkerIds: string[] = [], rows = [observation]) => publishSharedQuotaEvidence({
    ...sharedScope, lease, evidence: { observations: rows, unavailableWorkerIds }, state: 'running' });
  publish(); setResourcePoolAllocation(runtime.root, pool, bindings, 75, 0);
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output,
    inputTokens: 7, outputTokens: 3, usageScope: 'codex-turn', reason: 'worker-completed' });
  const oneShot = vi.spyOn(quota, 'refreshResourceQuotaOnce').mockRejectedValue(new Error('PROBE_MUST_NOT_RUN'));
  const context: ResourceGenerationContext = { messages: [{ role: 'system', content: 'Return edits only' }, { role: 'user', content: 'Improve value' }],
    candidatePath, timeoutMs: 5000, signal: new AbortController().signal, resourceRuntime: runtimePath,
    resourceUniverseRoot: universeRoot, resourceIdentity: { universeId: 'fixture',
      runId: '164f9f23-9e4c-4897-9243-71142ccf45d3', variantId: 'edit' } };
  return { runtime, runtimePath, config, quotaConfig, pool, bindings, observation, lease, execute, oneShot, context, publish, sharedScope,
    snapshotPath: join(runtime.root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME),
    status: () => resourcePoolStatus(runtime.root, pool, bindings, []),
    run: (patch: Partial<ResourceGenerationContext> = {}) => generateResourceCompletion(config, { ...context, ...patch }) };
}
// Instrument the real admission lock solely to perform an external-state change
// in the preview-to-reservation gap. The lock itself and transaction remain real.
function beforeAdmission(root: string, change: () => void): void {
  const acquire = locks.acquireLocalStoreLock; let changed = false;
  vi.spyOn(locks, 'acquireLocalStoreLock').mockImplementation((path, ...rest) => {
    if (!changed && path === join(root, '.pool.lock')) { changed = true; change(); }
    return acquire(path, ...rest);
  });
}

describe.skipIf(process.platform === 'win32')('Universe consumption of live shared quota evidence', () => {
  it.each([undefined, 2000])('completes with collector ownership retained (capacity wait %s)', async (waitMs) => {
    const f = await fixture(waitMs); const owner = readSharedQuotaEvidence(f.sharedScope).owner;
    const snapshot = readFileSync(f.snapshotPath); const file = readFileSync(f.runtime.observationsPath);
    expect(await f.run()).toMatchObject({ status: 'succeeded', content: output,
      usage: { state: 'reported', inputTokens: 7, outputTokens: 3 }, resource: { dispatch: 'settled', taskStatus: 'completed' } });
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.oneShot).not.toHaveBeenCalled();
    expect(readSharedQuotaEvidence(f.sharedScope).owner).toBe(owner); f.lease.assertOwnership();
    expect(readFileSync(f.snapshotPath)).toEqual(snapshot); expect(readFileSync(f.runtime.observationsPath)).toEqual(file);
    expect(f.status().allocation.ceilingPercent).toBe(75); expect(f.status().attempts).toHaveLength(1);
  });

  it.each(['missing', 'expired', 'failed', 'owner-closed', 'owner-changed', 'wrong-config'])('does not fall back to a probe or cached readiness for %s evidence', async (kind) => {
    const f = await fixture();
    if (kind === 'missing') unlinkSync(f.snapshotPath);
    if (kind === 'expired') {
      const row = JSON.parse(readFileSync(f.snapshotPath, 'utf8')); row.publishedAt = iso(-6000); row.expiresAt = iso(-1000); save(f.snapshotPath, row);
    }
    if (kind === 'failed') f.publish(['native']);
    if (kind === 'owner-closed') f.lease.close();
    if (kind === 'owner-changed') {
      f.lease.close(); const replacement = await acquireResourceQuotaRefreshLease(f.runtime.root); leases.push(replacement); replacement.markPending();
    }
    if (kind === 'wrong-config') save(f.runtime.quotaConfigPath!, { ...f.quotaConfig,
      workers: [{ ...f.quotaConfig.workers[0], accountHint: 'b'.repeat(64) }] });
    const result = await f.run(); expect(result.status).toBe('failed'); expect(result.content).toBeNull();
    expect(f.execute).not.toHaveBeenCalled(); expect(f.oneShot).not.toHaveBeenCalled(); expect(f.status().attempts).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('PROBE_MUST_NOT_RUN');
  });

  it.each(['collector-close', 'collector-token-change', 'native-refusal', 'at-ceiling'])('rechecks %s at atomic admission after a successful preview', async (change) => {
    const f = await fixture();
    beforeAdmission(f.runtime.root, () => {
      if (change === 'collector-close') f.lease.close();
      if (change === 'collector-token-change') {
        const path = join(f.runtime.root, '.resource-quota-refresh.lock');
        const row = JSON.parse(readFileSync(path, 'utf8')); row.token = '12345678-1234-4234-8234-123456789abc'; save(path, row);
      }
      if (change === 'native-refusal') f.publish(['native']);
      if (change === 'at-ceiling') f.publish([], [{ ...f.observation,
        windows: [{ ...f.observation.windows[0]!, usedPercent: 75 }] }]);
    });
    expect((await f.run()).status).toBe('failed');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.oneShot).not.toHaveBeenCalled(); expect(f.status().attempts).toHaveLength(0);
  });

  it('enforces a lower saved ceiling installed between preview and reservation', async () => {
    const f = await fixture();
    beforeAdmission(f.runtime.root, () => { setResourcePoolAllocation(f.runtime.root, f.pool, f.bindings, 15, 1); });
    expect((await f.run()).status).toBe('failed'); expect(f.execute).not.toHaveBeenCalled(); expect(f.oneShot).not.toHaveBeenCalled();
    expect(f.status().allocation.ceilingPercent).toBe(15); expect(f.status().attempts).toHaveLength(0);
  });

  it('retains a file denial even when shared evidence is fresh and ready', async () => {
    const f = await fixture();
    save(f.runtime.observationsPath, [{ ...f.observation, health: 'unavailable' }]);
    expect((await f.run()).status).toBe('failed'); expect(f.execute).not.toHaveBeenCalled(); expect(f.oneShot).not.toHaveBeenCalled();
  });

  it.each([undefined, 2000])('replays an exact receipt without a collector or snapshot (capacity wait %s)', async (waitMs) => {
    const f = await fixture(waitMs); expect((await f.run()).status).toBe('succeeded');
    const receipt = f.status().attempts[0]; f.lease.close(); unlinkSync(f.snapshotPath);
    expect(await f.run()).toMatchObject({ status: 'failed', content: null, resource: { dispatch: 'replayed' }, usage: { state: 'unavailable' } });
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.oneShot).not.toHaveBeenCalled(); expect(f.status().attempts).toEqual([receipt]);
  });

  it.each([undefined, 2000])('rejects a conflicting receipt without consulting the missing snapshot (capacity wait %s)', async (waitMs) => {
    const f = await fixture(waitMs); expect((await f.run()).status).toBe('succeeded');
    const receipt = f.status().attempts[0]; f.lease.close(); unlinkSync(f.snapshotPath);
    const result = await f.run({ messages: [{ role: 'user', content: 'Changed immutable prompt' }] });
    expect(result.status).toBe('failed'); expect(result.error).not.toContain('Shared quota');
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.oneShot).not.toHaveBeenCalled(); expect(f.status().attempts).toEqual([receipt]);
  });

  it('withholds when a synchronous admission read exhausts the generation time budget', async () => {
    const f = await fixture(); const start = performance.now(); let expired = false;
    beforeAdmission(f.runtime.root, () => { expired = true; });
    vi.spyOn(performance, 'now').mockImplementation(() => start + (expired ? 5001 : 0));
    expect((await f.run()).status).toBe('timed-out'); expect(f.execute).not.toHaveBeenCalled();
    expect(f.oneShot).not.toHaveBeenCalled(); expect(f.status().attempts).toHaveLength(0);
  });

  it.each([undefined, null, 'relative.json'])('requires a valid pinned quota config for shared mode (%s)', async (quotaConfigPath) => {
    const f = await fixture(); const runtime = { ...f.runtime, quotaConfigPath };
    if (quotaConfigPath === undefined) delete runtime.quotaConfigPath;
    expect(() => validateResourceGenerationRuntime(runtime)).toThrow(); save(f.runtimePath, runtime);
    expect((await f.run()).status).toBe('failed'); expect(f.execute).not.toHaveBeenCalled(); expect(f.oneShot).not.toHaveBeenCalled();
  });
});

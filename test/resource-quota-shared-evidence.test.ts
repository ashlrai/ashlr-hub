/** Private filesystem and OS process-identity fixtures only; no provider contact. */
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireResourceQuotaRefreshLease, inspectResourceQuotaRefreshOwner, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { publishSharedQuotaEvidence, readSharedQuotaEvidence, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME,
  RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS, type SharedQuotaEvidence } from '../src/core/resources/quota-shared-evidence.js';
import type { ResourcePool, ResourceObservation } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { ResourceQuotaRefreshConfig } from '../src/core/resources/quota-refresh.js';
import * as bootIdentity from '../src/core/resources/native-boot-identity.js';

let root: string;
const leases: ResourceQuotaRefreshLease[] = [];
const time = (ms = Date.now()) => new Date(ms).toISOString();
const file = () => join(root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME);
const lockFile = () => join(root, '.resource-quota-refresh.lock');
const pendingFile = () => join(root, '.resource-quota-refresh-pending.json');
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-shared-quota-'))); chmodSync(root, 0o700); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Deliberate ownership mutation fixtures. */ } }
  rmSync(root, { recursive: true, force: true });
});
function fixture(shared = false) {
  const pool: ResourcePool = { schemaVersion: 1, id: 'shared-quota', workers: ['codex-a', 'codex-b'].map((id) => ({
    id, provider: 'codex', model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 10,
    taskWindowMs: 60_000, priority: 1, reservePercent: 25, allowUnknownQuota: false })) };
  const bindings: ResourceBinding[] = pool.workers.map((worker) => ({ workerId: worker.id,
    capacityKey: shared ? 'same-account' : worker.id, kind: 'native-cli', command: [`/test-owned/${worker.id}`] }));
  const config: ResourceQuotaRefreshConfig = { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    workers: pool.workers.map((worker, i) => ({ workerId: worker.id, accountHint: (shared || i === 0 ? 'a' : 'b').repeat(64), bucketIds: ['codex'] })) };
  return { root, pool, bindings, config };
}
function observation(workerId: string, patch: Partial<ResourceObservation> = {}): ResourceObservation {
  const now = Date.now();
  return { workerId, observedAt: time(now), updatedAt: time(now), expiresAt: time(now + 60_000), health: 'ready', retryAfter: null,
    windows: [{ id: 'codex_codex_primary', usedPercent: 20, resetsAt: time(now + 3_600_000) }], ...patch };
}
function evidence(): SharedQuotaEvidence { return { observations: ['codex-a', 'codex-b'].map((id) => observation(id)), unavailableWorkerIds: [] }; }
async function acquire(mark = true) {
  const lease = await acquireResourceQuotaRefreshLease(root); leases.push(lease);
  if (mark) lease.markPending();
  return lease;
}
function mutate(target: string, change: (row: any) => void): void {
  const row = JSON.parse(readFileSync(target, 'utf8')); change(row); writeFileSync(target, JSON.stringify(row), { mode: 0o600 });
}

describe.skipIf(process.platform === 'win32')('shared quota admission witness', () => {
  it('does not revive old successful quota evidence after reboot reconciliation installs a new owner', async () => {
    const beforeBoot = { machineDigest: 'c'.repeat(64), bootId: '11111111-2222-3333-4444-555555555555' };
    const boot = vi.spyOn(bootIdentity, 'readNativeBootIdentity').mockReturnValue(beforeBoot);
    const f = fixture(); const first = await acquire();
    publishSharedQuotaEvidence({ ...f, lease: first, evidence: evidence(), state: 'running' });
    const prior = readSharedQuotaEvidence(f); first.close(true);
    boot.mockReturnValue({ ...beforeBoot, bootId: '66666666-2222-3333-4444-555555555555' });
    const successor = await acquire();
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
    publishSharedQuotaEvidence({ ...f, lease: successor, evidence: { observations: [], unavailableWorkerIds: [] }, state: 'running' });
    expect(() => readSharedQuotaEvidence({ ...f, expectedOwner: prior.owner })).toThrow('evidence unavailable');
    expect(readSharedQuotaEvidence(f)).toMatchObject({ observations: [], unavailableWorkerIds: ['codex-a', 'codex-b'] });
    expect(readSharedQuotaEvidence(f).owner).not.toBe(prior.owner);
  });

  it('publishes private pinned evidence while the original collector remains the owner', async () => {
    const f = fixture(); const lease = await acquire(); const captured = evidence();
    const before = readFileSync(lockFile(), 'utf8');
    publishSharedQuotaEvidence({ ...f, lease, evidence: captured, state: 'running' });
    const result = readSharedQuotaEvidence(f);
    expect(result.observations).toEqual(captured.observations); expect(result.unavailableWorkerIds).toEqual([]);
    expect(result.owner).toMatch(/^[a-f0-9]{64}$/);
    expect(readSharedQuotaEvidence({ ...f, expectedOwner: result.owner })).toEqual(result);
    expect(lstatSync(file()).mode & 0o777).toBe(0o600); expect(lstatSync(file()).nlink).toBe(1);
    expect(readFileSync(file(), 'utf8')).not.toContain('accountHint');
    expect(readFileSync(file(), 'utf8')).not.toContain('a'.repeat(64));
    expect(readFileSync(lockFile(), 'utf8')).toBe(before); expect(existsSync(pendingFile())).toBe(true);
    lease.assertOwnership();
  });

  it('does not expose a lease identity before the durable pending marker exists', async () => {
    const lease = await acquire(false);
    expect(() => lease.identity()).toThrow('identity unavailable');
    expect(() => publishSharedQuotaEvidence({ ...fixture(), lease, evidence: evidence(), state: 'running' })).toThrow('evidence unavailable');
    expect(existsSync(file())).toBe(false);
    lease.markPending(); expect(lease.identity()).toEqual(inspectResourceQuotaRefreshOwner(root));
  });

  it('publishes initial empty captures as unavailable without manufacturing readings', async () => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: { observations: [], unavailableWorkerIds: [] }, state: 'running' });
    expect(readSharedQuotaEvidence(f)).toMatchObject({ observations: [], unavailableWorkerIds: ['codex-a', 'codex-b'] });
  });

  it('retains a latest native refusal despite a fresh older successful capture', async () => {
    const f = fixture(); const lease = await acquire(); const captured = evidence();
    publishSharedQuotaEvidence({ ...f, lease, evidence: captured, state: 'running' });
    publishSharedQuotaEvidence({ ...f, lease, evidence: { ...captured, unavailableWorkerIds: ['codex-a'] }, state: 'running' });
    expect(readSharedQuotaEvidence(f).unavailableWorkerIds).toEqual(['codex-a']);
  });

  it('shares refusal across every configured account capacity alias', async () => {
    const f = fixture(true); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: { ...evidence(), unavailableWorkerIds: ['codex-b'] }, state: 'running' });
    expect(readSharedQuotaEvidence(f).unavailableWorkerIds).toEqual(['codex-a', 'codex-b']);
  });

  it.each([
    ['unknown usage', () => ({ windows: [{ id: 'codex_codex_primary', usedPercent: null, resetsAt: time(Date.now() + 60_000) }] })],
    ['missing reset', () => ({ windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: null }] })],
    ['past reset', () => ({ windows: [{ id: 'codex_codex_primary', usedPercent: 0, resetsAt: time(Date.now() - 1) }] })],
    ['exhausted', () => ({ windows: [{ id: 'codex_codex_primary', usedPercent: 100, resetsAt: time(Date.now() + 60_000) }] })],
    ['no windows', () => ({ windows: [] })],
    ['native refusal', () => ({ health: 'unavailable' as const })],
    ['retry later', () => ({ retryAfter: time(Date.now() + 60_000) })],
    ['overlong native ttl', () => ({ expiresAt: time(Date.now() + 120_000) })],
    ['expired capture', () => ({ observedAt: time(Date.now() - 61_000), updatedAt: time(Date.now() - 61_000), expiresAt: time(Date.now() - 1_000) })],
    ['future capture', () => ({ observedAt: time(Date.now() + 1000), updatedAt: time(Date.now() + 1000) })],
  ] as const)('withholds %s regardless of live collector heartbeat', async (_label, patch) => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: { observations: [observation('codex-a', patch()), observation('codex-b')], unavailableWorkerIds: [] }, state: 'running' });
    expect(readSharedQuotaEvidence(f).unavailableWorkerIds).toEqual(['codex-a']);
  });

  it('does not bake an operator allocation threshold into measured metadata', async () => {
    const f = fixture(); const lease = await acquire(); const captured = evidence();
    captured.observations[0]!.windows[0]!.usedPercent = 80;
    publishSharedQuotaEvidence({ ...f, lease, evidence: captured, state: 'running' });
    expect(readSharedQuotaEvidence(f).unavailableWorkerIds).toEqual([]);
    expect(readSharedQuotaEvidence(f).observations[0]!.windows[0]!.usedPercent).toBe(80);
  });

  it('fails closed once the owner closes, even while the original capture remains fresh', async () => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: evidence(), state: 'running' }); lease.close();
    expect(existsSync(file())).toBe(true); expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
  });

  it('refuses an explicitly closed snapshot before lease teardown', async () => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: evidence(), state: 'closed' });
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable'); lease.assertOwnership();
  });

  it('rejects an old snapshot under a new owner and pins an invocation to its first owner', async () => {
    const f = fixture(); const first = await acquire();
    publishSharedQuotaEvidence({ ...f, lease: first, evidence: evidence(), state: 'running' });
    const owner = readSharedQuotaEvidence(f).owner; first.close(); const next = await acquire();
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
    publishSharedQuotaEvidence({ ...f, lease: next, evidence: evidence(), state: 'running' });
    expect(readSharedQuotaEvidence(f).owner).not.toBe(owner);
    expect(() => readSharedQuotaEvidence({ ...f, expectedOwner: owner })).toThrow('evidence unavailable');
  });

  it('expires the publication heartbeat without extending original native observation time', async () => {
    const f = fixture(); const lease = await acquire(); const captured = evidence();
    publishSharedQuotaEvidence({ ...f, lease, evidence: captured, state: 'running' });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + RESOURCE_SHARED_QUOTA_EVIDENCE_TTL_MS + 1);
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
    publishSharedQuotaEvidence({ ...f, lease, evidence: captured, state: 'running' });
    expect(readSharedQuotaEvidence(f).observations).toEqual(captured.observations);
  });

  it.each([
    ['pool digest', (row: any) => { row.poolDigest = '0'.repeat(64); }],
    ['config digest', (row: any) => { row.configDigest = '0'.repeat(64); }],
    ['extra field', (row: any) => { row.extra = true; }],
    ['unavailable worker', (row: any) => { row.unavailableWorkerIds = ['not-enrolled']; }],
    ['duplicate unavailable worker', (row: any) => { row.unavailableWorkerIds = ['codex-a', 'codex-a']; }],
    ['future publication', (row: any) => { row.publishedAt = time(Date.now() + 60_000); row.expiresAt = time(Date.now() + 65_000); }],
    ['long heartbeat ttl', (row: any) => { row.expiresAt = time(Date.parse(row.publishedAt) + 10_000); }],
    ['owner token', (row: any) => { row.owner.lock.token = '0'.repeat(36); }],
  ])('rejects modified %s', async (_label, change) => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: evidence(), state: 'running' }); mutate(file(), change);
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
  });

  it('rejects a caller with different account pins even when the pool digest matches', async () => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: evidence(), state: 'running' });
    f.config.workers[0]!.accountHint = 'c'.repeat(64);
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
  });

  it.each(['dead-pid', 'start-mismatch', 'lock-replacement', 'marker-replacement', 'marker-mutation'])('rejects %s ownership', async (kind) => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: evidence(), state: 'running' });
    if (kind === 'dead-pid') mutate(lockFile(), (row) => { row.pid = 2147483647; });
    if (kind === 'start-mismatch') mutate(lockFile(), (row) => { row.startRef = '0'.repeat(64); });
    if (kind === 'marker-mutation') mutate(pendingFile(), (row) => { row.startedAt = time(Date.now() - 10_000); });
    if (kind === 'lock-replacement' || kind === 'marker-replacement') {
      const target = kind === 'lock-replacement' ? lockFile() : pendingFile();
      renameSync(target, `${target}.old`); writeFileSync(target, readFileSync(`${target}.old`), { mode: 0o600 });
    }
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
  });

  it.each(['symlink', 'hardlink', 'public', 'oversized', 'malformed'])('refuses %s evidence storage on reads and replacement', async (kind) => {
    const f = fixture(); const lease = await acquire();
    publishSharedQuotaEvidence({ ...f, lease, evidence: evidence(), state: 'running' });
    if (kind === 'symlink') { renameSync(file(), `${file()}.old`); symlinkSync(`${file()}.old`, file()); }
    if (kind === 'hardlink') linkSync(file(), `${file()}.alias`);
    if (kind === 'public') chmodSync(file(), 0o644);
    if (kind === 'oversized') writeFileSync(file(), ' '.repeat(128 * 1024 + 1));
    if (kind === 'malformed') writeFileSync(file(), '{');
    expect(() => readSharedQuotaEvidence(f)).toThrow('evidence unavailable');
    expect(() => publishSharedQuotaEvidence({ ...f, lease, evidence: evidence(), state: 'running' })).toThrow('evidence unavailable');
  });
});

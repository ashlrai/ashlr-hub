/** Private marker fixtures and loopback HTTP only; no native clients or provider reads. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireResourceQuotaRefreshLease, ResourceQuotaRefreshLeaseError } from '../src/core/resources/quota-refresh-lease.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle } from '../src/core/web/resource-console-server.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourceCollectorRecoveryDiagnosis } from '../src/core/resources/console-types.js';
import * as privateWrite from '../src/core/util/private-file-write.js';

const boot = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-boot-identity.js', () => ({ readNativeBootIdentity: boot }));
const identity = { machineDigest: 'a'.repeat(64), bootId: '11111111-2222-3333-4444-555555555555' };
const token = '22222222-2222-3333-4444-555555555555';
const priorPid = 2147482900; const pgid = priorPid - 1;
let directory: string; let root: string; let ownerAbsent: boolean; let groupAbsent: boolean;
const handles: ResourceConsoleServerHandle[] = [];
const markerPath = () => join(root, '.resource-quota-refresh-pending.json');
const activityPath = () => join(root, '.resource-quota-refresh-activity.json');
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'collector-diagnosis-')));
  root = join(directory, 'ledger'); mkdirSync(root, { mode: 0o700 });
  boot.mockReset(); boot.mockReturnValue(identity); ownerAbsent = true; groupAbsent = false;
  const original = process.kill;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== priorPid && pid !== -pgid) return original(pid, signal);
    expect(signal).toBe(0);
    if (pid === priorPid ? ownerAbsent : groupAbsent) throw Object.assign(new Error('PRIVATE_PROCESS_DETAIL'), { code: 'ESRCH' });
    return true;
  });
});
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true });
});
function fixture(version: 1 | 2 | 3 | 4, phase: 'ready' | 'preparing' | 'registered' = 'ready') {
  const marker = { schemaVersion: version, scope: 'native-connection-metadata', state: 'pending', startedAt: '2026-09-08T00:00:00.000Z',
    ...(version > 1 ? { bootIdentity: identity, ownerToken: token } : {}), ...(version >= 3 ? { ownerPid: priorPid } : {}) };
  save(markerPath(), marker);
  if (version >= 3) {
    const stat = lstatSync(markerPath(), { bigint: true });
    save(activityPath(), { schemaVersion: version === 3 ? 1 : 2, ownerToken: token, markerDigest: digest(canonical(marker)),
      pending: { dev: stat.dev.toString(), ino: stat.ino.toString() }, sequence: 1,
      reservations: version === 3 ? [token] : [{ id: token, phase, pgid: phase === 'registered' ? pgid : null }] });
  }
  return readFileSync(markerPath(), 'utf8');
}
async function refusal(reasonCode: ResourceCollectorRecoveryDiagnosis['reasonCode'], markerVersion: ResourceCollectorRecoveryDiagnosis['markerVersion']) {
  const before = readFileSync(markerPath(), 'utf8');
  let failure: unknown;
  try { await acquireResourceQuotaRefreshLease(root, { trackNativeActivity: true }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ResourceQuotaRefreshLeaseError);
  expect(failure).toMatchObject({ code: 'reconciliation-required', safeReadOnlyFallback: true, recovery: { reasonCode, markerVersion } });
  expect(Object.keys((failure as ResourceQuotaRefreshLeaseError).recovery!).sort()).toEqual(['markerVersion', 'reasonCode']);
  expect(readFileSync(markerPath(), 'utf8')).toBe(before);
  expect(existsSync(join(root, '.resource-quota-refresh-recovery.json'))).toBe(false);
  expect(existsSync(join(root, '.resource-quota-refresh.lock'))).toBe(false);
}

describe.skipIf(process.platform === 'win32')('acquisition-time collector recovery diagnostics', () => {
  it('identifies a legacy marker without probing current boot or trusting its timestamp', async () => {
    fixture(1); await refusal('legacy-owner-evidence-missing', 1); expect(boot).not.toHaveBeenCalled();
  });
  it.each([
    [2, 'ready', 'same-boot-owner-evidence-missing'],
    [3, 'ready', 'legacy-active-work-unverifiable'],
    [4, 'preparing', 'command-registration-incomplete'],
    [4, 'registered', 'process-group-not-confirmed-absent'],
  ] as const)('classifies v%s %s evidence without authorizing recovery', async (version, phase, reason) => {
    fixture(version, phase); await refusal(reason, version);
  });
  it('distinguishes a present owner before reading activity', async () => {
    fixture(4); ownerAbsent = false; await refusal('owner-not-confirmed-absent', 4);
  });
  it('distinguishes unavailable boot identity', async () => {
    fixture(2); boot.mockReturnValue(null); await refusal('boot-identity-unavailable', 2);
  });
  it('distinguishes a different machine without exposing its identity', async () => {
    fixture(2); boot.mockReturnValue({ ...identity, machineDigest: 'b'.repeat(64) }); await refusal('machine-identity-mismatch', 2);
  });
  it('does not infer a version from malformed evidence', async () => {
    save(markerPath(), { schemaVersion: 4, privateValue: token }); await refusal('pending-evidence-unavailable', null);
  });
  it('does not expose malformed activity details', async () => {
    fixture(4); save(activityPath(), { privateValue: token }); await refusal('activity-evidence-unavailable', 4);
  });
  it('reports uncertain recovery publication without making startup a safe fallback', async () => {
    const before = fixture(2); boot.mockReturnValue({ ...identity, bootId: token });
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation(() => { throw new Error('PRIVATE_SYNC_FAILURE'); });
    let failure: unknown;
    try { await acquireResourceQuotaRefreshLease(root, { trackNativeActivity: true }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'cleanup-unconfirmed', safeReadOnlyFallback: false,
      recovery: { reasonCode: 'recovery-confirmation-failed', markerVersion: 2 } });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_SYNC_FAILURE');
    expect(readFileSync(markerPath(), 'utf8')).toBe(before);
  });
  it('does not attach a diagnosis to cancellation before inspection', async () => {
    const before = fixture(1); const controller = new AbortController(); controller.abort();
    let failure: unknown;
    try { await acquireResourceQuotaRefreshLease(root, { signal: controller.signal }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'cancelled' }); expect((failure as ResourceQuotaRefreshLeaseError).recovery).toBeUndefined();
    expect(readFileSync(markerPath(), 'utf8')).toBe(before); expect(boot).not.toHaveBeenCalled();
  });
  it('copies only public diagnosis fields and freezes the error snapshot', () => {
    const detail = { reasonCode: 'legacy-owner-evidence-missing' as const, markerVersion: 1 as const, secret: token };
    const error = new ResourceQuotaRefreshLeaseError('reconciliation-required', 'fixed message', detail);
    expect(error.recovery).toEqual({ reasonCode: detail.reasonCode, markerVersion: 1 });
    expect(error.recovery).not.toBe(detail); expect(Object.isFrozen(error.recovery)).toBe(true);
    expect(new ResourceQuotaRefreshLeaseError('collector-owned', 'fixed message').recovery).toBeUndefined();
  });

  it('projects the actual legacy refusal through authenticated HTTP without read-time probes or mutation', async () => {
    const before = fixture(1);
    const pool = { schemaVersion: 1, id: 'diagnostic-fixture', workers: [{ id: 'codex-a', provider: 'codex', model: 'inert',
      maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: false }] };
    const bindings = [{ workerId: 'codex-a', capacityKey: 'fixture-capacity', kind: 'native-cli', command: [process.execPath, '--version'] }];
    const poolFile = join(directory, 'pool.json'); const bindingsFile = join(directory, 'bindings.json');
    const observationsFile = join(directory, 'observations.json'); const quotaConfigFile = join(directory, 'quota.json');
    save(poolFile, pool); save(bindingsFile, bindings); save(observationsFile, []);
    save(quotaConfigFile, { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
      workers: [{ workerId: 'codex-a', accountHint: 'c'.repeat(64), bucketIds: ['codex'] }] });
    const handle = await startResourceConsoleServer({ root, poolFile, bindingsFile, observationsFile, quotaConfigFile }); handles.push(handle);
    const read = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: handle.port, path: '/api/resources', agent: false,
        headers: { 'x-ashlr-token': handle.readToken } }, (response) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => { try { expect(response.statusCode).toBe(200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end();
    });
    const first = await read();
    expect(first.metadataCollector).toMatchObject({ state: 'blocked', reasonCode: 'reconciliation-required',
      recovery: { reasonCode: 'legacy-owner-evidence-missing', markerVersion: 1 } });
    expect(first.quotaRefresh).toBeUndefined();
    const diagnosis = (first.metadataCollector as { recovery: ResourceCollectorRecoveryDiagnosis }).recovery;
    diagnosis.markerVersion = 4;
    for (let count = 0; count < 3; count++) {
      const next = await read(); expect(next.metadataCollector).toMatchObject({ recovery: { markerVersion: 1 } });
      const text = JSON.stringify(next.metadataCollector);
      for (const secret of [token, identity.machineDigest, root, String(priorPid), 'PRIVATE_PROCESS_DETAIL']) expect(text).not.toContain(secret);
    }
    expect(boot).not.toHaveBeenCalled(); expect(readFileSync(markerPath(), 'utf8')).toBe(before);
    expect(existsSync(join(root, '.resource-quota-refresh.lock'))).toBe(false);
    await handle.close(); expect(readFileSync(markerPath(), 'utf8')).toBe(before);
  });
});

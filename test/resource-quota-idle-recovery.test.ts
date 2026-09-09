/** Private fixtures with mocked prior-owner liveness; never signals a foreign process. */
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireResourceQuotaRefreshLease, inspectResourceQuotaRefreshOwner,
  type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as privateWrite from '../src/core/util/private-file-write.js';

const boot = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-boot-identity.js', () => ({ readNativeBootIdentity: boot }));
const identity = { machineDigest: 'a'.repeat(64), bootId: '11111111-2222-3333-4444-555555555555' };
const priorPid = 2147483000;
let root: string; const leases: ResourceQuotaRefreshLease[] = [];
const markerPath = () => join(root, '.resource-quota-refresh-pending.json');
const activityPath = () => join(root, '.resource-quota-refresh-activity.json');
const receiptPath = () => join(root, '.resource-quota-refresh-recovery.json');
const activity = () => JSON.parse(readFileSync(activityPath(), 'utf8'));
async function acquire(trackNativeActivity = true) {
  const lease = await acquireResourceQuotaRefreshLease(root, { trackNativeActivity }); leases.push(lease); return lease;
}
async function retained(active = false) {
  const lease = await acquire(); lease.markPending(); if (active) lease.beginNativeActivity().processGroupLifecycle.prepare(); lease.close(true);
  const marker = JSON.parse(readFileSync(markerPath(), 'utf8')); marker.ownerPid = priorPid;
  writeFileSync(markerPath(), JSON.stringify(marker) + '\n', { mode: 0o600 });
  const record = activity(); record.markerDigest = digest(canonical(marker));
  writeFileSync(activityPath(), canonical(record) + '\n', { mode: 0o600 });
  const originalKill = process.kill;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === priorPid) throw Object.assign(new Error('fixture owner absent'), { code: 'ESRCH' });
    return originalKill(pid, signal);
  });
  return readFileSync(markerPath(), 'utf8');
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'quota-idle-'))); boot.mockReset(); boot.mockReturnValue(identity); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Expected retained fixture. */ } }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('durable collector idle recovery', () => {
  it('keeps shared owner identity immutable across two durable native reservations', async () => {
    const lease = await acquire(); lease.markPending(); const owner = lease.identity();
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ schemaVersion: 4, ownerPid: process.pid });
    expect(activity().reservations).toEqual([]);
    const first = lease.beginNativeActivity(); const second = lease.beginNativeActivity();
    expect(activity().reservations).toHaveLength(2); expect(lease.identity()).toEqual(owner);
    first.settle(); first.settle(); expect(activity().reservations).toHaveLength(1);
    second.settle(); expect(activity()).toMatchObject({ sequence: 4, reservations: [] });
    expect(inspectResourceQuotaRefreshOwner(root)).toEqual(owner);
    expect(lstatSync(activityPath()).mode & 0o777).toBe(0o600);
    lease.close(); expect(existsSync(markerPath())).toBe(false); expect(existsSync(activityPath())).toBe(true);
    const next = await acquire(); next.markPending(); expect(activity().ownerToken).not.toBe(owner.lock.token); next.close();
  });

  it('refuses to close as settled while a native reservation remains', async () => {
    const lease = await acquire(); lease.markPending(); lease.beginNativeActivity();
    expect(() => lease.close()).toThrow(/shutdown uncertain/);
    expect(existsSync(markerPath())).toBe(true); expect(activity().reservations).toHaveLength(1);
  });

  it('rejects shared owner inspection when a tracked marker PID disagrees with its token-matched lock', async () => {
    const lease = await acquire(); lease.markPending();
    const marker = JSON.parse(readFileSync(markerPath(), 'utf8')); marker.ownerPid = priorPid;
    writeFileSync(markerPath(), JSON.stringify(marker) + '\n', { mode: 0o600 });
    expect(() => inspectResourceQuotaRefreshOwner(root)).toThrow(/identity unavailable/);
    expect(existsSync(markerPath())).toBe(true);
  });

  it('refuses a third reservation and prevents later calls after that boundary failure', async () => {
    const lease = await acquire(); lease.markPending(); const first = lease.beginNativeActivity(); lease.beginNativeActivity();
    expect(() => lease.beginNativeActivity()).toThrow(/reservation unavailable/);
    expect(() => first.settle()).toThrow(/settlement unavailable/);
    expect(activity().reservations).toHaveLength(2);
  });

  it.each(['begin', 'settle'] as const)('preserves a fence and stops further activity on %s persistence failure', async (stage) => {
    const lease = await acquire(); lease.markPending(); const token = stage === 'settle' ? lease.beginNativeActivity() : null;
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation(() => { throw new Error('fixture write failure'); });
    expect(() => token ? token.settle() : lease.beginNativeActivity()).toThrow(/unavailable/);
    expect(() => lease.beginNativeActivity()).toThrow(/unavailable/);
    expect(() => lease.close()).toThrow(/uncertain/); expect(existsSync(markerPath())).toBe(true);
    expect(activity().reservations).toHaveLength(stage === 'settle' ? 1 : 0);
  });

  it('uses memory reservations but no recoverable sidecar without verified boot identity', async () => {
    boot.mockReturnValue(null); const lease = await acquire(); lease.markPending(); lease.beginNativeActivity();
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).schemaVersion).toBe(1);
    expect(existsSync(activityPath())).toBe(false); expect(() => lease.close()).toThrow(/uncertain/);
  });

  it('does not grant idle recovery to an untracked lease', async () => {
    const lease = await acquire(false); lease.markPending(); expect(JSON.parse(readFileSync(markerPath(), 'utf8')).schemaVersion).toBe(2);
    expect(() => lease.beginNativeActivity()).toThrow(/reservation unavailable/); expect(existsSync(activityPath())).toBe(false);
  });

  it('rejects invalid opt-in without creating a root or lock', async () => {
    await expect(acquireResourceQuotaRefreshLease(join(root, 'absent'), { trackNativeActivity: 1 as unknown as boolean }))
      .rejects.toThrow(/Invalid native activity/); expect(existsSync(join(root, 'absent'))).toBe(false);
  });

  it('recovers only exact idle evidence and dead owner on the verified same boot', async () => {
    const bytes = await retained(); const original = privateWrite.writePrivateFileAtomically;
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation((...args) => {
      expect(readFileSync(markerPath(), 'utf8')).toBe(bytes); return original(...args);
    });
    const next = await acquire(); expect(existsSync(markerPath())).toBe(false);
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt).toMatchObject({ reason: 'same-boot-verified-idle-dead-owner', state: 'authorized-before-unlink',
      activity: { record: { reservations: [] } } });
    expect(lstatSync(receiptPath()).size).toBeLessThanOrEqual(2048); next.close();
  });

  it.each(['active', 'missing', 'permissions', 'different-marker', 'malformed', 'hardlink', 'symlink'] as const)('preserves the exact marker for %s activity evidence', async (kind) => {
    const bytes = await retained(kind === 'active');
    if (kind === 'missing') unlinkSync(activityPath());
    if (kind === 'permissions') chmodSync(activityPath(), 0o644);
    if (kind === 'different-marker') { const record = activity(); record.markerDigest = 'b'.repeat(64); writeFileSync(activityPath(), JSON.stringify(record)); }
    if (kind === 'malformed') writeFileSync(activityPath(), '{}');
    if (kind === 'hardlink') linkSync(activityPath(), join(root, 'alias'));
    if (kind === 'symlink') { renameSync(activityPath(), join(root, 'original')); symlinkSync(join(root, 'original'), activityPath()); }
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' });
    expect(readFileSync(markerPath(), 'utf8')).toBe(bytes); expect(existsSync(receiptPath())).toBe(false);
  });

  it.each(['alive', 'permission'] as const)('never infers dead ownership from %s liveness result', async (kind) => {
    const bytes = await retained(); const originalKill = process.kill;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== priorPid) return originalKill(pid, signal);
      if (kind === 'alive') return true;
      throw Object.assign(new Error('fixture unknown'), { code: 'EPERM' });
    });
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' }); expect(readFileSync(markerPath(), 'utf8')).toBe(bytes);
  });

  it.each(['activity', 'activity-identity', 'marker', 'boot', 'owner'] as const)('retains changed %s witness after writing recovery authorization', async (kind) => {
    const bytes = await retained(); const original = privateWrite.writePrivateFileAtomically;
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation((...args) => {
      original(...args);
      if (kind === 'activity') writeFileSync(activityPath(), canonical({ ...activity(), sequence: 99 }) + '\n');
      if (kind === 'activity-identity') {
        const record = readFileSync(activityPath()); renameSync(activityPath(), join(root, 'old-activity'));
        writeFileSync(activityPath(), record, { mode: 0o600 });
      }
      if (kind === 'marker') writeFileSync(markerPath(), '{}\n');
      if (kind === 'boot') boot.mockReturnValue(null);
      if (kind === 'owner') {
        const actual = process.kill;
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid === priorPid ? true : actual(pid, signal));
      }
    });
    await expect(acquire()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' });
    expect(readFileSync(markerPath(), 'utf8')).toBe(kind === 'marker' ? '{}\n' : bytes);
    expect(existsSync(receiptPath())).toBe(true);
  });

  it('retains idle authorization evidence when the recovery receipt cannot be persisted', async () => {
    const bytes = await retained(); const prior = readFileSync(activityPath());
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation(() => { throw new Error('fixture sync failure'); });
    await expect(acquire()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' });
    expect(readFileSync(markerPath(), 'utf8')).toBe(bytes); expect(readFileSync(activityPath())).toEqual(prior);
  });

  it('still permits verified reboot recovery for a preparing reservation without claiming native success', async () => {
    await retained(true); boot.mockReturnValue({ ...identity, bootId: '66666666-2222-3333-4444-555555555555' });
    const next = await acquire(); expect(existsSync(markerPath())).toBe(false);
    expect(JSON.parse(readFileSync(receiptPath(), 'utf8')).reason).toBe('same-machine-different-boot');
    expect(activity().reservations).toHaveLength(1); next.close();
  });
});

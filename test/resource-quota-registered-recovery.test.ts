/** Private fixtures only; every synthetic owner/group probe is intercepted, never signaled. */
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireResourceQuotaRefreshLease, type ResourceNativeActivity, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as privateWrite from '../src/core/util/private-file-write.js';

const boot = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-boot-identity.js', () => ({ readNativeBootIdentity: boot }));
const identity = { machineDigest: 'a'.repeat(64), bootId: '11111111-2222-3333-4444-555555555555' };
const priorPid = 2147483000; const group = 2147482999; const otherGroup = group - 1;
let root: string; const leases: ResourceQuotaRefreshLease[] = [];
const markerPath = () => join(root, '.resource-quota-refresh-pending.json');
const activityPath = () => join(root, '.resource-quota-refresh-activity.json');
const receiptPath = () => join(root, '.resource-quota-refresh-recovery.json');
const activity = () => JSON.parse(readFileSync(activityPath(), 'utf8'));
const groups = new Map<number, 'absent' | 'present' | 'permission'>();
let observed: number[];
async function acquire() {
  const lease = await acquireResourceQuotaRefreshLease(root, { trackNativeActivity: true }); leases.push(lease); return lease;
}
async function start() { const lease = await acquire(); lease.markPending(); return { lease, handle: lease.beginNativeActivity() }; }
function retain(lease: ResourceQuotaRefreshLease) {
  lease.close(true);
  const marker = JSON.parse(readFileSync(markerPath(), 'utf8')); marker.ownerPid = priorPid;
  writeFileSync(markerPath(), JSON.stringify(marker) + '\n', { mode: 0o600 });
  const record = activity(); record.markerDigest = digest(canonical(marker));
  writeFileSync(activityPath(), canonical(record) + '\n', { mode: 0o600 });
  return readFileSync(markerPath(), 'utf8');
}
function register(handle: ResourceNativeActivity, pgid = group) {
  const phase = handle.processGroupLifecycle.prepare(); phase.spawned(pgid); return phase;
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'quota-registered-'))); boot.mockReset(); boot.mockReturnValue(identity);
  groups.clear(); groups.set(group, 'absent'); groups.set(otherGroup, 'absent'); observed = [];
  const originalKill = process.kill;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === priorPid || pid === -group || pid === -otherGroup) {
      expect(signal).toBe(0); observed.push(pid);
      const state = pid === priorPid ? 'absent' : groups.get(-pid);
      if (state === 'present') return true;
      throw Object.assign(new Error('fixture signal-zero result'), { code: state === 'permission' ? 'EPERM' : 'ESRCH' });
    }
    return originalKill(pid, signal);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Deliberately retained fixture. */ } }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('passive registered native group recovery', () => {
  it('publishes bounded schema2 phases without changing the immutable shared owner identity', async () => {
    const { lease, handle } = await start(); const owner = lease.identity();
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).schemaVersion).toBe(4);
    expect(activity()).toMatchObject({ schemaVersion: 2, reservations: [{ phase: 'ready', pgid: null }] });
    const phase = handle.processGroupLifecycle.prepare();
    expect(activity().reservations[0]).toMatchObject({ phase: 'preparing', pgid: null });
    phase.spawned(group); expect(activity().reservations[0]).toMatchObject({ phase: 'registered', pgid: group });
    expect(lease.identity()).toEqual(owner);
    phase.settled('group-exit-confirmed'); expect(activity().reservations[0]).toMatchObject({ phase: 'ready', pgid: null });
    handle.settle(); expect(activity().reservations).toEqual([]);
    expect(lstatSync(activityPath()).size).toBeLessThanOrEqual(1024); lease.close();
  });

  it('repeats preparation for every sequential Claude command, leaving no recoverable unregistered gap', async () => {
    const { lease, handle } = await start();
    for (let command = 0; command < 3; command++) {
      const phase = register(handle); phase.settled('group-exit-confirmed');
      expect(activity().reservations[0].phase).toBe('ready');
    }
    handle.processGroupLifecycle.prepare(); const before = retain(lease);
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' });
    expect(readFileSync(markerPath(), 'utf8')).toBe(before); expect(observed).not.toContain(-group);
  });

  it('recovers a never-started ready reservation without claiming a provider result', async () => {
    const { lease } = await start(); retain(lease); const next = await acquire();
    expect(existsSync(markerPath())).toBe(false);
    expect(JSON.parse(readFileSync(receiptPath(), 'utf8')).reason).toBe('same-boot-verified-idle-dead-owner');
    expect(observed).not.toContain(-group); next.close();
  });

  it('recovers both registered groups only after two sets of ESRCH probes and durable authorization', async () => {
    const { lease, handle } = await start(); register(handle); register(lease.beginNativeActivity(), otherGroup);
    const before = retain(lease); const write = privateWrite.writePrivateFileAtomically;
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation((...args) => {
      expect(readFileSync(markerPath(), 'utf8')).toBe(before);
      expect(observed.filter((pid) => pid < 0)).toEqual([-group, -otherGroup]); return write(...args);
    });
    const next = await acquire(); expect(existsSync(markerPath())).toBe(false);
    expect(observed.filter((pid) => pid < 0)).toEqual([-group, -otherGroup, -group, -otherGroup]);
    expect(JSON.parse(readFileSync(receiptPath(), 'utf8'))).toMatchObject({
      reason: 'same-boot-verified-groups-absent-dead-owner', state: 'authorized-before-unlink',
      activity: { record: { schemaVersion: 2, reservations: [{ pgid: group }, { pgid: otherGroup }] } },
    });
    expect(lstatSync(receiptPath()).size).toBeLessThanOrEqual(2048); next.close();
  });

  it.each(['present', 'permission'] as const)('retains exact evidence when a registered group is %s', async (state) => {
    const { lease, handle } = await start(); register(handle); const before = retain(lease); groups.set(group, state);
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' });
    expect(readFileSync(markerPath(), 'utf8')).toBe(before); expect(existsSync(receiptPath())).toBe(false);
  });

  it('a preparing peer blocks recovery even when the other registered group is absent', async () => {
    const { lease, handle } = await start(); register(handle); lease.beginNativeActivity().processGroupLifecycle.prepare();
    const before = retain(lease); await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' });
    expect(readFileSync(markerPath(), 'utf8')).toBe(before);
  });

  it.each(['group-present', 'group-permission', 'activity'] as const)('retains evidence if %s changes after durable authorization', async (change) => {
    const { lease, handle } = await start(); register(handle); const before = retain(lease);
    const write = privateWrite.writePrivateFileAtomically;
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation((...args) => {
      write(...args);
      if (change === 'activity') writeFileSync(activityPath(), canonical({ ...activity(), sequence: 999 }) + '\n');
      else groups.set(group, change === 'group-present' ? 'present' : 'permission');
    });
    await expect(acquire()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' });
    expect(readFileSync(markerPath(), 'utf8')).toBe(before); expect(existsSync(receiptPath())).toBe(true);
  });

  it.each(['prepare', 'register', 'settle'] as const)('poisons ownership and preserves the prior phase when %s persistence fails', async (stage) => {
    const { lease, handle } = await start(); const phase = stage === 'prepare' ? null : handle.processGroupLifecycle.prepare();
    if (stage === 'settle') phase!.spawned(group);
    const prior = readFileSync(activityPath(), 'utf8');
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation(() => { throw new Error('fixture disk failure'); });
    expect(() => stage === 'prepare' ? handle.processGroupLifecycle.prepare() : stage === 'register' ? phase!.spawned(group) : phase!.settled('group-exit-confirmed')).toThrow(/unavailable/);
    expect(readFileSync(activityPath(), 'utf8')).toBe(prior);
    expect(() => handle.settle()).toThrow(/unavailable/); expect(() => lease.close()).toThrow(/uncertain/);
    expect(existsSync(markerPath())).toBe(true);
  });

  it.each(['preparing-exit', 'registered-not-started', 'outer-preparing', 'outer-registered', 'repeat-prepare', 'repeat-spawn', 'old-handle', 'invalid-group'] as const)(
    'rejects impossible transition %s and retains the fence', async (kind) => {
      const { lease, handle } = await start(); const phase = handle.processGroupLifecycle.prepare();
      if (['registered-not-started', 'outer-registered', 'repeat-spawn'].includes(kind)) phase.spawned(group);
      if (kind === 'old-handle') { phase.settled('not-started'); handle.processGroupLifecycle.prepare(); }
      expect(() => {
        if (kind === 'preparing-exit') phase.settled('group-exit-confirmed');
        else if (kind === 'registered-not-started') phase.settled('not-started');
        else if (kind === 'outer-preparing' || kind === 'outer-registered') handle.settle();
        else if (kind === 'repeat-prepare') handle.processGroupLifecycle.prepare();
        else phase.spawned(kind === 'invalid-group' ? 0 : group);
      }).toThrow(/unavailable/);
      expect(() => lease.close()).toThrow(/uncertain/); expect(existsSync(markerPath())).toBe(true);
    });

  it('allows explicit no-start settlement to return to ready before another command', async () => {
    const { lease, handle } = await start(); handle.processGroupLifecycle.prepare().settled('not-started');
    register(handle).settled('group-exit-confirmed'); handle.settle(); lease.close(); expect(existsSync(markerPath())).toBe(false);
  });

  it.each(['negative-pgid', 'fractional-pgid', 'preparing-pgid', 'registered-null', 'unknown-phase', 'duplicate-id', 'extra-field', 'old-schema'] as const)(
    'rejects malformed schema2 witness %s', async (kind) => {
      const { lease, handle } = await start(); register(handle); const before = retain(lease); const record = activity();
      if (kind === 'negative-pgid') record.reservations[0].pgid = -1;
      if (kind === 'fractional-pgid') record.reservations[0].pgid = 1.5;
      if (kind === 'preparing-pgid') record.reservations[0].phase = 'preparing';
      if (kind === 'registered-null') record.reservations[0].pgid = null;
      if (kind === 'unknown-phase') record.reservations[0].phase = 'idle';
      if (kind === 'duplicate-id') record.reservations.push({ ...record.reservations[0] });
      if (kind === 'extra-field') record.reservations[0].extra = true;
      if (kind === 'old-schema') record.schemaVersion = 1;
      writeFileSync(activityPath(), canonical(record) + '\n');
      await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' });
      expect(readFileSync(markerPath(), 'utf8')).toBe(before);
    });

  it.each([false, true])('preserves v3 schema1 compatibility: active=%s', async (active) => {
    const { lease } = await start(); retain(lease); const marker = JSON.parse(readFileSync(markerPath(), 'utf8'));
    marker.schemaVersion = 3; writeFileSync(markerPath(), JSON.stringify(marker) + '\n');
    const record = activity(); record.schemaVersion = 1; record.markerDigest = digest(canonical(marker));
    record.reservations = active ? record.reservations.map((row: { id: string }) => row.id) : [];
    writeFileSync(activityPath(), canonical(record) + '\n'); const before = readFileSync(markerPath(), 'utf8');
    if (active) { await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' }); expect(readFileSync(markerPath(), 'utf8')).toBe(before); }
    else { const next = await acquire(); expect(existsSync(markerPath())).toBe(false); next.close(); }
  });

  it('allows verified reboot recovery for preparing v4 evidence without any stale group probe', async () => {
    const { lease, handle } = await start(); handle.processGroupLifecycle.prepare(); retain(lease);
    boot.mockReturnValue({ ...identity, bootId: '66666666-2222-3333-4444-555555555555' });
    const next = await acquire(); expect(existsSync(markerPath())).toBe(false); expect(observed.filter((pid) => pid < 0)).toEqual([]); next.close();
  });
});

/** Private fixtures and mocked boot identity only; no native clients or foreign PID signals. */
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireResourceQuotaRefreshLease, inspectResourceQuotaRefreshOwner,
  type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as privateWrite from '../src/core/util/private-file-write.js';
import * as locks from '../src/core/fleet/local-store-lock.js';

const boot = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-boot-identity.js', () => ({ readNativeBootIdentity: boot }));
const beforeBoot = { machineDigest: 'a'.repeat(64), bootId: '11111111-2222-3333-4444-555555555555' };
const afterBoot = { ...beforeBoot, bootId: '66666666-2222-3333-4444-555555555555' };
let root: string; const leases: ResourceQuotaRefreshLease[] = [];
const pending = () => join(root, '.resource-quota-refresh-pending.json');
const lock = () => join(root, '.resource-quota-refresh.lock');
const receipt = () => join(root, '.resource-quota-refresh-recovery.json');
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'quota-recovery-'))); boot.mockReset(); boot.mockReturnValue(beforeBoot); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Deliberate identity/fence fixtures. */ } }
  rmSync(root, { recursive: true, force: true });
});
async function acquire() { const value = await acquireResourceQuotaRefreshLease(root); leases.push(value); return value; }
async function retained() { const lease = await acquire(); lease.markPending(); lease.close(true); return readFileSync(pending(), 'utf8'); }

describe.skipIf(process.platform === 'win32')('boot-bound native collector reconciliation', () => {
  it('publishes a v2 boot-and-owner-bound marker before exposing shared owner identity', async () => {
    const lease = await acquire(); lease.markPending(); const marker = JSON.parse(readFileSync(pending(), 'utf8'));
    const owner = JSON.parse(readFileSync(lock(), 'utf8'));
    expect(marker).toEqual({ schemaVersion: 2, scope: 'codex-native-metadata', state: 'pending',
      startedAt: expect.any(String), bootIdentity: beforeBoot, ownerToken: owner.token });
    expect(lstatSync(pending()).mode & 0o777).toBe(0o600); expect(lstatSync(pending()).size).toBeLessThan(512);
    expect(lease.identity()).toEqual(inspectResourceQuotaRefreshOwner(root));
  });

  it.each([null, {}, { ...beforeBoot, machineDigest: 'invalid' },
    { ...beforeBoot, bootId: '00000000-0000-0000-0000-000000000000' }])('falls back to a legacy fence for unavailable identity %#', async (value) => {
    boot.mockReturnValue(value); const bytes = await retained();
    expect(JSON.parse(bytes).schemaVersion).toBe(1);
    boot.mockReturnValue(afterBoot);
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required', safeReadOnlyFallback: true });
    expect(readFileSync(pending(), 'utf8')).toBe(bytes); expect(existsSync(receipt())).toBe(false);
  });

  it('does not propagate boot probe private diagnostics or make an unproven marker recoverable', async () => {
    boot.mockImplementation(() => { throw new Error('private boot diagnostic'); });
    expect(JSON.parse(await retained()).schemaVersion).toBe(1);
  });

  it.each([beforeBoot, { ...afterBoot, machineDigest: 'b'.repeat(64) }, null])(
    'retains the exact pending marker for same boot, foreign machine or unknown identity %#', async (current) => {
      const bytes = await retained(); boot.mockReturnValue(current);
      await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required', safeReadOnlyFallback: true });
      expect(readFileSync(pending(), 'utf8')).toBe(bytes); expect(existsSync(lock())).toBe(false); expect(existsSync(receipt())).toBe(false);
    });

  it('durably records exact prior evidence before unlink and permits a fresh owner only after a verified reboot', async () => {
    const bytes = await retained(); const prior = JSON.parse(bytes); const stat = lstatSync(pending(), { bigint: true });
    boot.mockReturnValue(afterBoot);
    const original = privateWrite.writePrivateFileAtomically;
    const write = vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation((...args) => {
      expect(readFileSync(pending(), 'utf8')).toBe(bytes); return original(...args);
    });
    const successor = await acquire();
    expect(write).toHaveBeenCalledOnce(); expect(existsSync(pending())).toBe(false);
    const record = JSON.parse(readFileSync(receipt(), 'utf8'));
    expect(record).toMatchObject({ state: 'authorized-before-unlink', reason: 'same-machine-different-boot',
      markerDigest: digest(canonical(prior)), pending: { dev: stat.dev.toString(), ino: stat.ino.toString() } });
    expect(JSON.stringify(record)).toContain(afterBoot.bootId); expect(JSON.stringify(record)).toContain(beforeBoot.bootId);
    expect(lstatSync(receipt()).mode & 0o777).toBe(0o600); expect(lstatSync(receipt()).size).toBeLessThanOrEqual(2048);
    successor.markPending(); expect(JSON.parse(readFileSync(pending(), 'utf8')).bootIdentity).toEqual(afterBoot);
    successor.close(); const before = readFileSync(receipt()); const next = await acquire(); next.close();
    expect(readFileSync(receipt())).toEqual(before);
  });

  it.each(['permissions', 'hardlink', 'symlink', 'malformed'] as const)('refuses unsafe pending evidence during reboot recovery: %s', async (kind) => {
    const bytes = await retained(); boot.mockReturnValue(afterBoot);
    if (kind === 'permissions') chmodSync(pending(), 0o644);
    if (kind === 'hardlink') linkSync(pending(), join(root, 'alias'));
    if (kind === 'symlink') { renameSync(pending(), join(root, 'original')); symlinkSync(join(root, 'original'), pending()); }
    if (kind === 'malformed') writeFileSync(pending(), '{');
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required' });
    expect(existsSync(pending())).toBe(true); expect(existsSync(receipt())).toBe(false);
    if (kind !== 'malformed') expect(readFileSync(pending(), 'utf8')).toBe(bytes);
  });

  it('preserves the fence when recovery receipt publication fails', async () => {
    const bytes = await retained(); boot.mockReturnValue(afterBoot);
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation(() => { throw new Error('private sync failure'); });
    await expect(acquire()).rejects.toMatchObject({ code: 'cleanup-unconfirmed', safeReadOnlyFallback: false });
    expect(readFileSync(pending(), 'utf8')).toBe(bytes); expect(existsSync(lock())).toBe(false);
  });

  it('does not unlink a marker changed during durable receipt publication', async () => {
    await retained(); boot.mockReturnValue(afterBoot); const original = privateWrite.writePrivateFileAtomically;
    vi.spyOn(privateWrite, 'writePrivateFileAtomically').mockImplementation((...args) => {
      const result = original(...args); writeFileSync(pending(), '{}\n', { mode: 0o600 }); return result;
    });
    await expect(acquire()).rejects.toMatchObject({ code: 'cleanup-unconfirmed', safeReadOnlyFallback: false });
    expect(readFileSync(pending(), 'utf8')).toBe('{}\n'); expect(existsSync(lock())).toBe(false);
  });

  it.each([null, { ...afterBoot, bootId: '77777777-2222-3333-4444-555555555555' }])(
    'preserves pending work if boot identity becomes unknown or changes after the durable receipt %#', async (changed) => {
      const bytes = await retained(); boot.mockReturnValueOnce(afterBoot).mockReturnValue(changed);
      await expect(acquire()).rejects.toMatchObject({ code: 'cleanup-unconfirmed', safeReadOnlyFallback: false });
      expect(readFileSync(pending(), 'utf8')).toBe(bytes); expect(existsSync(receipt())).toBe(true);
      expect(existsSync(lock())).toBe(false);
    });

  it.each(['symlink', 'oversize'] as const)('never overwrites an unsafe existing recovery receipt: %s', async (kind) => {
    const bytes = await retained(); boot.mockReturnValue(afterBoot);
    const target = join(root, 'private-receipt-target'); writeFileSync(target, 'preserve this receipt target', { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(target, receipt());
    else writeFileSync(receipt(), 'x'.repeat(2049), { mode: 0o600 });
    const prior = readFileSync(receipt());
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required', safeReadOnlyFallback: true });
    expect(readFileSync(pending(), 'utf8')).toBe(bytes); expect(readFileSync(receipt())).toEqual(prior);
    expect(readFileSync(target, 'utf8')).toBe('preserve this receipt target'); expect(existsSync(lock())).toBe(false);
  });

  it('cannot turn uncertain lock cleanup into a read-only fallback', async () => {
    await retained(); vi.spyOn(locks, 'releaseLocalStoreLock').mockReturnValue(false);
    await expect(acquire()).rejects.toMatchObject({ code: 'cleanup-unconfirmed', safeReadOnlyFallback: false });
    expect(existsSync(pending())).toBe(true);
  });

  it('does not reconcile or create a lock after cancellation', async () => {
    const bytes = await retained(); boot.mockReturnValue(afterBoot); const controller = new AbortController(); controller.abort();
    await expect(acquireResourceQuotaRefreshLease(root, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled', safeReadOnlyFallback: false });
    expect(readFileSync(pending(), 'utf8')).toBe(bytes); expect(existsSync(lock())).toBe(false); expect(existsSync(receipt())).toBe(false);
  });
});

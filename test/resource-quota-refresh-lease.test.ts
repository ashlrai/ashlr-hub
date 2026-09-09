/** Private filesystem fixtures only; acquiring a lease never contacts a native provider. */
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import * as durability from '../src/core/util/durability.js';
// These fixtures specifically preserve and exercise the legacy marker contract.
vi.mock('../src/core/resources/native-boot-identity.js', () => ({ readNativeBootIdentity: () => null }));

let base: string; let root: string;
const leases: ResourceQuotaRefreshLease[] = [];
const lockPath = () => join(root, '.resource-quota-refresh.lock');
const pendingPath = () => join(root, '.resource-quota-refresh-pending.json');
async function acquire(): Promise<ResourceQuotaRefreshLease> {
  const lease = await acquireResourceQuotaRefreshLease(root); leases.push(lease); return lease;
}
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-quota-lease-'))); root = join(base, 'ledger'); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Intentional lost-owner/fence fixtures. */ } }
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('shared quota refresh lease', () => {
  it('creates a private lease without marking contact, then closes idempotently', async () => {
    expect(existsSync(root)).toBe(false);
    const lease = await acquire();
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(lockPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(pendingPath())).toBe(false); expect(Object.isFrozen(lease)).toBe(true);
    expect(() => lease.assertOwnership()).not.toThrow();
    lease.close(); lease.close();
    expect(existsSync(lockPath())).toBe(false); expect(existsSync(pendingPath())).toBe(false);
    expect(() => lease.assertOwnership()).toThrow(/ownership lost/);
    expect(() => lease.markPending()).toThrow(/ownership lost/);
  });

  it('publishes only a bounded private marker and removes it after confirmed close', async () => {
    const lease = await acquire(); lease.markPending();
    const stat = lstatSync(pendingPath()); const bytes = readFileSync(pendingPath(), 'utf8');
    const marker = JSON.parse(bytes);
    expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(1); expect(stat.size).toBeLessThan(512);
    expect(Object.keys(marker).sort()).toEqual(['schemaVersion', 'scope', 'startedAt', 'state']);
    expect(marker).toMatchObject({ schemaVersion: 1, scope: 'codex-native-metadata', state: 'pending' });
    expect(new Date(marker.startedAt).toISOString()).toBe(marker.startedAt);
    expect(bytes).not.toContain(base);
    expect(() => lease.markPending()).toThrow(/marker unavailable/);
    expect(readFileSync(pendingPath(), 'utf8')).toBe(bytes);
    lease.assertOwnership(); lease.close();
    expect(existsSync(pendingPath())).toBe(false); expect(existsSync(lockPath())).toBe(false);
    const next = await acquire(); next.markPending(); next.close();
  });

  it('retains uncertain pending work across close and refuses a successor without retaining its lock', async () => {
    const lease = await acquire(); lease.markPending();
    const before = readFileSync(pendingPath(), 'utf8');
    lease.close(true); lease.close(false);
    expect(existsSync(lockPath())).toBe(false); expect(readFileSync(pendingPath(), 'utf8')).toBe(before);
    await expect(acquire()).rejects.toThrow(/unavailable.*reconciliation/);
    expect(existsSync(lockPath())).toBe(false); expect(readFileSync(pendingPath(), 'utf8')).toBe(before);
  });

  it('refuses a concurrent owner without changing the first lease or marker', async () => {
    const first = await acquire(); first.markPending();
    const before = readFileSync(lockPath(), 'utf8'); const pending = readFileSync(pendingPath(), 'utf8');
    await expect(acquire()).rejects.toThrow(/already owned|unavailable/);
    expect(readFileSync(lockPath(), 'utf8')).toBe(before); expect(readFileSync(pendingPath(), 'utf8')).toBe(pending);
    first.assertOwnership(); first.close();
    const next = await acquire(); next.close();
  });

  it.each(['regular', 'empty', 'malformed', 'directory', 'symlink', 'hardlink'])(
    'refuses an existing %s pending path and releases the acquisition lock', async (kind) => {
      mkdirSync(root, { mode: 0o700 });
      const target = join(base, 'existing-private-data');
      writeFileSync(target, 'PRIVATE_EXISTING_DATA', { mode: 0o600 });
      if (kind === 'directory') mkdirSync(pendingPath(), { mode: 0o700 });
      else if (kind === 'symlink') symlinkSync(target, pendingPath());
      else if (kind === 'hardlink') linkSync(target, pendingPath());
      else writeFileSync(pendingPath(), kind === 'empty' ? '' : kind === 'malformed' ? '{' : '{}', { mode: 0o600 });
      const stat = lstatSync(pendingPath());
      await expect(acquire()).rejects.toThrow(/unavailable.*reconciliation/);
      expect(existsSync(lockPath())).toBe(false);
      expect(lstatSync(pendingPath()).ino).toBe(stat.ino);
      expect(readFileSync(target, 'utf8')).toBe('PRIVATE_EXISTING_DATA');
    });

  it.each(['replacement', 'content', 'permissions', 'hardlink', 'symlink'])(
    'does not remove a pending marker after %s invalidates its ownership', async (kind) => {
      const lease = await acquire(); lease.markPending();
      const before = readFileSync(pendingPath(), 'utf8');
      if (kind === 'replacement' || kind === 'symlink') {
        const original = join(base, 'original-marker'); renameSync(pendingPath(), original);
        if (kind === 'symlink') symlinkSync(original, pendingPath());
        else writeFileSync(pendingPath(), before, { mode: 0o600 });
      }
      if (kind === 'content') writeFileSync(pendingPath(), '{}\n');
      if (kind === 'permissions') chmodSync(pendingPath(), 0o644);
      if (kind === 'hardlink') linkSync(pendingPath(), join(base, 'extra-link'));
      const changed = lstatSync(pendingPath());
      expect(() => lease.assertOwnership()).toThrow(/marker changed/);
      expect(() => lease.close()).toThrow(/shutdown uncertain/);
      expect(() => lease.close()).toThrow(/shutdown uncertain/);
      expect(lstatSync(pendingPath()).ino).toBe(changed.ino); expect(existsSync(lockPath())).toBe(false);
    });

  it.each([false, true])('never removes a replacement lock or pending work after lease loss (preserve=%s)', async (preserve) => {
    const lease = await acquire(); lease.markPending();
    const pending = readFileSync(pendingPath(), 'utf8'); const original = readFileSync(lockPath(), 'utf8');
    renameSync(lockPath(), join(base, 'original-lock'));
    writeFileSync(lockPath(), original, { mode: 0o600 });
    const replacement = lstatSync(lockPath());
    expect(() => lease.assertOwnership()).toThrow(/ownership lost/);
    expect(() => lease.close(preserve)).toThrow(/shutdown uncertain/);
    expect(lstatSync(lockPath()).ino).toBe(replacement.ino);
    expect(readFileSync(pendingPath(), 'utf8')).toBe(pending);
  });

  it('does not remove replacement-root data after the pinned directory moves', async () => {
    const lease = await acquire(); lease.markPending();
    const moved = join(base, 'original-root'); renameSync(root, moved); mkdirSync(root, { mode: 0o700 });
    writeFileSync(pendingPath(), 'NEW_ROOT_DATA', { mode: 0o600 });
    expect(() => lease.assertOwnership()).toThrow(/ownership lost/);
    expect(() => lease.close()).toThrow(/shutdown uncertain/);
    expect(readFileSync(pendingPath(), 'utf8')).toBe('NEW_ROOT_DATA');
    expect(existsSync(join(moved, '.resource-quota-refresh-pending.json'))).toBe(true);
  });

  it('leaves failed marker publication fenced without keeping the collector lock', async () => {
    const lease = await acquire();
    const sync = vi.spyOn(durability, 'fsyncDirectory').mockImplementationOnce(() => { throw new Error('PRIVATE_SYNC_ERROR'); });
    expect(() => lease.markPending()).toThrow('Resource quota collector pending marker unavailable');
    sync.mockRestore();
    expect(existsSync(pendingPath())).toBe(true); lease.close();
    expect(existsSync(lockPath())).toBe(false);
    await expect(acquire()).rejects.toThrow(/unavailable.*reconciliation/);
    expect(existsSync(lockPath())).toBe(false);
  });

  it.each(['relative', '', '/', '/invalid\0root', '/invalid\u0080root'])(
    'rejects invalid root syntax without creating private storage: %j', async (value) => {
      await expect(acquireResourceQuotaRefreshLease(value)).rejects.toThrow(/Invalid resource quota collector root/);
      expect(existsSync(root)).toBe(false);
    });

  it.each(['symlink', 'permissions'])('does not repair an unsafe existing %s root', async (kind) => {
    const target = join(base, 'target'); mkdirSync(target, { mode: 0o700 });
    if (kind === 'symlink') symlinkSync(target, root);
    else mkdirSync(root, { mode: 0o755 });
    await expect(acquire()).rejects.toThrow(/unavailable/);
    expect(existsSync(lockPath())).toBe(false); expect(existsSync(pendingPath())).toBe(false);
    if (kind === 'permissions') expect(lstatSync(root).mode & 0o777).toBe(0o755);
  });
});

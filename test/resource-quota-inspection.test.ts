/** Real private marker reads; no collector, boot query, or account contact. */
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectResourceQuotaRefreshPending } from '../src/core/resources/quota-refresh-lease.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import * as runtime from '../src/core/resources/pool-runtime.js';
import * as boot from '../src/core/resources/native-boot-identity.js';

let base: string; let root: string;
const markerPath = () => join(root, '.resource-quota-refresh-pending.json');
const marker = (schemaVersion = 1, scope = 'codex-native-metadata') => ({ schemaVersion, scope, state: 'pending',
  startedAt: '2026-09-12T00:00:00.000Z', ...(schemaVersion >= 2 ? {
    bootIdentity: { machineDigest: 'a'.repeat(64), bootId: '11111111-2222-3333-4444-555555555555' },
    ownerToken: '66666666-2222-3333-4444-555555555555',
  } : {}), ...(schemaVersion >= 3 ? { ownerPid: 12345 } : {}) });
const save = (value: unknown) => writeFileSync(markerPath(), JSON.stringify(value) + '\n', { mode: 0o600 });
const unavailable = { scope: 'local-record-inspection', state: 'unavailable', markerVersion: null,
  reasonCode: 'pending-evidence-unavailable', recoveryAttempted: false };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'quota-inspection-')));
  root = join(base, 'ledger'); mkdirSync(root, { mode: 0o700 });
  vi.spyOn(boot, 'readNativeBootIdentity').mockImplementation(() => { throw new Error('Unexpected boot query'); });
  vi.spyOn(locks, 'acquireLocalStoreLockWithOutcome').mockImplementation(() => { throw new Error('Unexpected lock acquisition'); });
  vi.spyOn(locks, 'verifiedProcessStartIdentity').mockImplementation(() => { throw new Error('Unexpected PID query'); });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process observation'); });
});
afterEach(() => {
  try {
    expect(boot.readNativeBootIdentity).not.toHaveBeenCalled();
    expect(locks.acquireLocalStoreLockWithOutcome).not.toHaveBeenCalled();
    expect(locks.verifiedProcessStartIdentity).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); }
});

describe('read-only native quota pending inspection', () => {
  it('reports absence only inside an existing private root without creating records', () => {
    const result = inspectResourceQuotaRefreshPending(root);
    expect(result).toEqual({ scope: 'local-record-inspection', sampledAt: expect.any(String), state: 'absent',
      markerVersion: null, reasonCode: 'no-pending-record', recoveryAttempted: false });
    expect(new Date(result.sampledAt).toISOString()).toBe(result.sampledAt);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([1, 2, 3, 4])('reports version %i without exposing private identity or evaluating recovery', version => {
    save(marker(version));
    // Unrelated evidence is neither interpreted nor overwritten by this inspection.
    for (const name of ['.resource-quota-refresh.lock', '.resource-quota-refresh-activity.json', '.resource-quota-refresh-recovery.json']) {
      writeFileSync(join(root, name), 'PRIVATE_UNRELATED_BYTES', { mode: 0o600 });
    }
    const snapshot = () => readdirSync(root).sort().map(name => [name, readFileSync(join(root, name), 'utf8')]);
    const before = snapshot();
    for (let index = 0; index < 2; index++) {
      const result = inspectResourceQuotaRefreshPending(root);
      expect(result).toEqual({ scope: 'local-record-inspection', sampledAt: expect.any(String), state: 'pending',
        markerVersion: version, reasonCode: version === 1 ? 'legacy-owner-evidence-missing' : 'recovery-not-evaluated', recoveryAttempted: false });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('12345');
      expect(JSON.stringify(result)).not.toContain('11111111');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
    expect(snapshot()).toEqual(before);
  });

  it('accepts the existing connection-metadata marker scope without claiming a collector is running', () => {
    save(marker(4, 'native-connection-metadata'));
    expect(inspectResourceQuotaRefreshPending(root)).toMatchObject({ state: 'pending', markerVersion: 4, reasonCode: 'recovery-not-evaluated' });
  });

  it('does not create a missing root or mistake it for missing pending evidence', () => {
    const missing = join(base, 'missing');
    expect(inspectResourceQuotaRefreshPending(missing)).toMatchObject(unavailable);
    expect(existsSync(missing)).toBe(false);
  });

  it.each(['relative', '/', 'invalid\nroot'])('refuses invalid root syntax: %j', value => {
    expect(inspectResourceQuotaRefreshPending(value)).toMatchObject(unavailable);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a root symlink rather than inspecting its destination', () => {
    save(marker()); const alias = join(base, 'alias'); symlinkSync(root, alias, 'dir');
    expect(inspectResourceQuotaRefreshPending(alias)).toMatchObject(unavailable);
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toEqual(marker());
  });

  it.skipIf(process.platform === 'win32')('refuses an existing non-private root even without a marker', () => {
    chmodSync(root, 0o755);
    expect(inspectResourceQuotaRefreshPending(root)).toMatchObject(unavailable);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(['directory', 'symlink', 'hardlink', 'oversized', 'malformed', 'invalid-utf8'])('refuses %s marker evidence without changing it', kind => {
    if (kind === 'directory') mkdirSync(markerPath(), { mode: 0o700 });
    else if (kind === 'symlink') {
      const target = join(base, 'target.json'); writeFileSync(target, JSON.stringify(marker()), { mode: 0o600 }); symlinkSync(target, markerPath());
    } else if (kind === 'hardlink') { save(marker()); linkSync(markerPath(), join(base, 'alias.json')); }
    else writeFileSync(markerPath(), kind === 'oversized' ? 'x'.repeat(513) : kind === 'malformed' ? '{PRIVATE_ERROR' : Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    const names = readdirSync(root);
    expect(inspectResourceQuotaRefreshPending(root)).toMatchObject(unavailable);
    expect(readdirSync(root)).toEqual(names);
  });

  it.skipIf(process.platform === 'win32')('refuses a non-private marker', () => {
    save(marker()); chmodSync(markerPath(), 0o644);
    expect(inspectResourceQuotaRefreshPending(root)).toMatchObject(unavailable);
  });

  it.each([{ ...marker(), extra: true }, { ...marker(), schemaVersion: 5 }, { ...marker(2), ownerToken: 'invalid' },
    { ...marker(3), ownerPid: 0 }, { ...marker(), startedAt: 'yesterday' }])('refuses invalid marker shape %#', value => {
    save(value); const before = readFileSync(markerPath());
    expect(inspectResourceQuotaRefreshPending(root)).toMatchObject(unavailable);
    expect(readFileSync(markerPath())).toEqual(before);
  });

  it('refuses a marker changed during the bounded read', () => {
    save(marker()); const read = runtime.readResourceJson;
    vi.spyOn(runtime, 'readResourceJson').mockImplementation((...args) => {
      const value = read(...args); writeFileSync(markerPath(), '{"changed":true}\n', { mode: 0o600 }); return value;
    });
    expect(inspectResourceQuotaRefreshPending(root)).toMatchObject(unavailable);
    expect(readFileSync(markerPath(), 'utf8')).toBe('{"changed":true}\n');
  });

  it('refuses root replacement after reading otherwise valid evidence', () => {
    save(marker()); const read = runtime.readResourceJson;
    vi.spyOn(runtime, 'readResourceJson').mockImplementation((...args) => {
      const value = read(...args); renameSync(root, join(base, 'previous')); mkdirSync(root, { mode: 0o700 }); save(marker()); return value;
    });
    expect(inspectResourceQuotaRefreshPending(root)).toMatchObject(unavailable);
    expect(existsSync(join(base, 'previous', '.resource-quota-refresh-pending.json'))).toBe(true);
  });
});

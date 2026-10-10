/** Inert public metadata ports only; never reads a live app or Keychain. */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as desktopTrust from '../src/core/run/desktop-metadata-launch-trust.js';
import { acquireResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { createDesktopMetadataTrust, parseDesktopPairBuildIdentity, DESKTOP_METADATA_SIGNER, type DesktopMetadataTrustIO, type DesktopFileStamp } from '../src/core/run/desktop-metadata-launch-trust.js';
const app = '/Applications/Phantom.app', host = `${app}/Contents/MacOS/ashlr-desktop`, sidecar = `${app}/Contents/MacOS/ashlr`;
const identity = { schemaVersion: 1 as const, revision: 'a'.repeat(40), tree: 'b'.repeat(40), version: '3.29.5' };
const stamp = (ino: string): DesktopFileStamp => ({ dev: '1', ino, size: '1', mtimeNs: '1', ctimeNs: '1', mode: '33261', uid: '0', nlink: '1' });
function fixture() {
  const stamps = new Map<string, DesktopFileStamp>(); let next = 1;
  const get = (path: string) => { if (!stamps.has(path)) stamps.set(path, stamp(String(next++))); return structuredClone(stamps.get(path)!); };
  let record = canonicalJson({ schemaVersion: 1, version: identity.version, source: { revision: identity.revision, tree: identity.tree }, authoritySurfaceDigest: 'c'.repeat(64), packageSha256: 'd'.repeat(64) });
  let parent = { pid: 123, startRef: 'e'.repeat(64), executable: host }; let bytes = 'f'.repeat(64);
  const io: DesktopMetadataTrustIO = { directory: get, stamp: get, readImage: vi.fn(async path => ({ path, stamp: get(path), sha256: bytes })),
    readRecord: vi.fn(async () => record), parent: vi.fn(async () => ({ ...parent })), inventory: vi.fn(async () => '1'.repeat(64)),
    metadata: vi.fn(async (command, args) => command.endsWith('codesign') ? '' : args[1] === 'CFBundleIdentifier' ? 'ai.ashlr.desktop' : args[1] === 'CFBundleExecutable' ? 'ashlr-desktop' : identity.version) };
  return { io, get, stamps, changeBytes() { bytes = '0'.repeat(64); }, setRecord(value: string) { record = value; }, setParent(value: typeof parent) { parent = value; },
    qualify: createDesktopMetadataTrust(io, { sidecar, parentPid: 123, identity }), signal: new AbortController().signal };
}
describe('signed desktop metadata pair', () => {
  it('qualifies exact signed/source pair, rehashes four files on every preflight and caches only whole signature qualification', async () => {
    const f = fixture(), backend = await f.qualify(f.signal);
    expect(backend.kind).toBe('signed-desktop'); expect(backend.image().path).toBe(host); expect(backend.parent().pid).toBe(123);
    const reads = vi.mocked(f.io.readImage).mock.calls.length; await backend.preflight(f.signal);
    expect(vi.mocked(f.io.readImage).mock.calls.length - reads).toBe(4);
    expect(vi.mocked(f.io.metadata).mock.calls.filter(([bin]) => bin.endsWith('codesign'))).toHaveLength(1);
    expect(f.io.metadata).toHaveBeenCalledWith('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=identifier "ai.ashlr.desktop" and certificate leaf = H"${DESKTOP_METADATA_SIGNER}"`, app], f.signal);
    f.stamps.set(host, { ...f.get(host), ctimeNs: '2' }); expect(() => backend.assertCurrent()).toThrow();
    await expect(backend.preflight(f.signal)).rejects.toThrow();
  });
  it('refuses same-stamp byte drift, changed native parent or mismatched sealed source rather than renewing the captured backend', async () => {
    const f = fixture(), backend = await f.qualify(f.signal); f.changeBytes(); await expect(backend.preflight(f.signal)).rejects.toThrow();
    const p = fixture(); p.setParent({ pid: 123, startRef: 'e'.repeat(64), executable: '/unqualified/native' }); await expect(p.qualify(p.signal)).rejects.toThrow();
    const r = fixture(); r.setRecord(canonicalJson({ schemaVersion: 1, version: identity.version, source: { revision: '0'.repeat(40), tree: identity.tree }, authoritySurfaceDigest: 'c'.repeat(64), packageSha256: 'd'.repeat(64) })); await expect(r.qualify(r.signal)).rejects.toThrow();
  });
  it('refuses interrupted inventory/signature, source duplicates and unavailable compiled identity without exposing records', async () => {
    const f = fixture(); vi.mocked(f.io.inventory).mockResolvedValueOnce('1'.repeat(64)).mockResolvedValueOnce('2'.repeat(64)); await expect(f.qualify(f.signal)).rejects.toThrow();
    const bad = fixture(); vi.mocked(bad.io.metadata).mockRejectedValue(new Error('signature failure')); await expect(bad.qualify(bad.signal)).rejects.toThrow();
    expect(parseDesktopPairBuildIdentity(JSON.stringify(identity))).toEqual(identity);
    expect(parseDesktopPairBuildIdentity(JSON.stringify(identity).replace('{', '{"revision":"' + '0'.repeat(40) + '",'))).toBeNull();
    expect(parseDesktopPairBuildIdentity(undefined)).toBeNull();
  });
  it('keeps an unqualified Bun pair pre-contact without publishing an owned pending marker', async () => {
    if (process.platform !== 'darwin') return;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-unqualified-pair-')));
    const before = Object.getOwnPropertyDescriptor(process.versions, 'bun');
    Object.defineProperty(process.versions, 'bun', { value: 'inert-fixture', configurable: true });
    try {
      await expect(acquireResourceQuotaRefreshLease(root, { trackNativeActivity: true, trackNativeLaunchHandoff: true })).rejects.toMatchObject({ code: 'collector-unavailable' });
      expect(existsSync(join(root, '.resource-quota-refresh.lock'))).toBe(false);
      expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(false);
    } finally { if (before) Object.defineProperty(process.versions, 'bun', before); else Reflect.deleteProperty(process.versions, 'bun'); rmSync(root, { recursive: true, force: true }); }
  });
  it('bounds initial desktop proof by the existing acquisition deadline and abort without creating a lease', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-desktop-proof-budget-')));
    const proof = vi.spyOn(desktopTrust, 'qualifyDesktopMetadataLaunch').mockImplementation(async () => await new Promise(() => {}));
    const before = Object.getOwnPropertyDescriptor(process.versions, 'bun');
    Object.defineProperty(process.versions, 'bun', { value: 'inert-fixture', configurable: true });
    try {
      await expect(acquireResourceQuotaRefreshLease(root, { waitMs: 20, trackNativeActivity: true, trackNativeLaunchHandoff: true })).rejects.toMatchObject({ code: 'collector-unavailable' });
      const controller = new AbortController();
      const pending = acquireResourceQuotaRefreshLease(root, { signal: controller.signal, trackNativeActivity: true, trackNativeLaunchHandoff: true });
      controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      expect(proof).toHaveBeenCalledTimes(2);
      for (const [signal] of proof.mock.calls) expect(signal.aborted).toBe(true);
      expect(existsSync(join(root, '.resource-quota-refresh.lock'))).toBe(false);
      expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(false);
    } finally {
      proof.mockRestore(); if (before) Object.defineProperty(process.versions, 'bun', before); else Reflect.deleteProperty(process.versions, 'bun');
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('uses the existing public commissioned certificate without a publisher tool import', () => {
    const policy = readFileSync(new URL('../scripts/desktop-release-policy.mjs', import.meta.url), 'utf8');
    expect(policy).toContain(DESKTOP_METADATA_SIGNER);
  });
});

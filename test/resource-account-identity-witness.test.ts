/** Local fixture metadata only. No CLI, keychain, credential read or provider request. */
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readResourceAccountLocalEpoch, resourceAccountProfileDigest, recheckResourceAccountIdentitySnapshot } from '../src/core/resources/account-identity-witness.js';
import type { ResourceConnectionConfig } from '../src/core/resources/connection-monitor.js';

const resolver = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-profile.js', () => ({ resolveNativeSeatLaunch: resolver }));
let root: string; let state: string;
type Account = ResourceConnectionConfig['accounts'][number];
const account = (provider: Account['provider'] = 'codex'): Account => ({ id: `${provider}-a`, label: 'Demo', provider, command: ['/private/inert/node', '/private/inert/launcher.mjs'] });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-account-epoch-'))); state = join(root, 'native-state'); mkdirSync(state, { mode: 0o700 });
  resolver.mockReset().mockImplementation(({ provider, seatId }) => ({ ok: true,
    launch: { provider, seatId, nativeStatePath: state, command: account(provider).command, executable: '/private/inert/native' } }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('same-profile last-checked local identity epoch', () => {
  it.each(['codex', 'grok'] as const)('pins %s private auth file metadata without parsing credential contents', provider => {
    const file = join(state, 'auth.json'); writeFileSync(file, 'not parsed credential content', { mode: 0o600 });
    const a = account(provider); const first = readResourceAccountLocalEpoch(root, a);
    expect(first?.profileDigest).toBe(resourceAccountProfileDigest(a)); expect(first?.epochDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toHaveProperty('accountDigest'); expect(readResourceAccountLocalEpoch(root, a)).toEqual(first);
    writeFileSync(file, 'changed credential file epoch', { mode: 0o600 });
    expect(readResourceAccountLocalEpoch(root, a)?.epochDigest).not.toBe(first?.epochDigest);
  });
  it('matches only Claude exact profile OAuth metadata with native auth-status account-hint formula', () => {
    const file = join(state, '.claude.json');
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'demo@example.invalid', organizationUuid: 'demo-org' },
      unrelatedPrivateSettings: 'SECRET_SENTINEL_NOT_PROJECTED' }), { mode: 0o600 });
    const result = readResourceAccountLocalEpoch(root, account('claude'));
    expect(result?.accountDigest).toBe(createHash('sha256').update(JSON.stringify(['claude-native-auth-v1', 'demo@example.invalid', 'demo-org'])).digest('hex'));
    expect(JSON.stringify(result)).not.toContain('demo@example.invalid'); expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');
    const original = readFileSync(file, 'utf8'); expect(readFileSync(file, 'utf8')).toBe(original);
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'other@example.invalid', organizationUuid: 'demo-org' } }), { mode: 0o600 });
    expect(readResourceAccountLocalEpoch(root, account('claude'))?.accountDigest).not.toBe(result?.accountDigest);
  });
  it.each([
    {}, { oauthAccount: {} }, { oauthAccount: { emailAddress: 'demo@example.invalid' } },
    { oauthAccount: { emailAddress: 'demo@example.invalid', organizationUuid: null } },
    { oauthAccount: { emailAddress: 'bad\nidentity', organizationUuid: 'demo-org' } },
  ])('refuses missing or malformed Claude local identity (%j)', value => {
    writeFileSync(join(state, '.claude.json'), JSON.stringify(value), { mode: 0o600 });
    expect(readResourceAccountLocalEpoch(root, account('claude'))).toBeNull();
  });
  it.each(['missing', 'public', 'symlink', 'hardlink', 'oversized'] as const)('holds %s auth metadata as unknown', kind => {
    const file = join(state, 'auth.json'); const other = join(state, 'other');
    if (kind !== 'missing') {
      const source = kind === 'symlink' || kind === 'hardlink' ? other : file;
      writeFileSync(source, kind === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : '{}', { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(other, file); if (kind === 'hardlink') linkSync(other, file);
      if (kind === 'public') chmodSync(file, 0o644);
    }
    expect(readResourceAccountLocalEpoch(root, account())).toBeNull();
  });
  it('refuses a changed launcher, unresolved roster or nonprivate native-state directory', () => {
    writeFileSync(join(state, 'auth.json'), '{}', { mode: 0o600 });
    expect(readResourceAccountLocalEpoch(root, { ...account(), command: ['/private/different/launcher'] })).toBeNull();
    resolver.mockReturnValueOnce({ ok: false, reason: 'profile-invalid' }); expect(readResourceAccountLocalEpoch(root, account())).toBeNull();
    chmodSync(state, 0o755); expect(readResourceAccountLocalEpoch(root, account())).toBeNull();
  });
  it('worker rechecks original native witness against current file epoch without renewing provider freshness', () => {
    const a = account(); const file = join(state, 'auth.json'); writeFileSync(file, '{}', { mode: 0o600 });
    const captured = readResourceAccountLocalEpoch(root, a)!; const now = Date.now();
    const snapshot = { witness: { provider: a.provider, accountId: a.id, accountDigest: 'a'.repeat(64), profileDigest: resourceAccountProfileDigest(a),
      generation: 1, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), source: 'native-account-checked' as const }, localEpoch: captured };
    expect(recheckResourceAccountIdentitySnapshot(root, a, snapshot, now + 1)).toEqual(snapshot.witness);
    expect(recheckResourceAccountIdentitySnapshot(root, a, { ...snapshot, localEpoch: null }, now + 1)).toBeNull();
    expect(recheckResourceAccountIdentitySnapshot(root, a, snapshot, now + 60_000)).toBeNull();
    writeFileSync(file, 'changed', { mode: 0o600 }); expect(recheckResourceAccountIdentitySnapshot(root, a, snapshot, now + 1)).toBeNull();
  });
});

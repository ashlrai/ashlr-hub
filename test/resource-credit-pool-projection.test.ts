/** Real private files, synthetic accounts, and inert launch resolution only. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCreditPoolsProjection } from '../src/core/resources/credit-pool-projection.js';
import { resourceAccountProfileDigest, readResourceAccountLocalEpoch } from '../src/core/resources/account-identity-witness.js';
import type { ResourceAccountIdentitySnapshot } from '../src/core/resources/account-identity-witness.js';
import type { CreditPoolObservation } from '../src/core/resources/credit-pool-types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { ResourceConnectionConfig } from '../src/core/resources/connection-monitor.js';
import { parseCreditPoolObservation } from '../src/core/resources/credit-pool-observations.js';
import { createResourceReadingCache } from '../src/core/resources/reading-cache.js';
const resolver = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-profile.js', () => ({ resolveNativeSeatLaunch: resolver }));
const now = Date.parse('2026-10-01T12:00:00.000Z');
const hint = createHash('sha256').update(JSON.stringify(['claude-native-auth-v1', 'demo@example.invalid', 'demo-org'])).digest('hex');
let root: string; let state: string; let account: ResourceConnectionConfig['accounts'][number]; let snapshot: ResourceAccountIdentitySnapshot;
const read = (snapshots = [snapshot], time = now) => readCreditPoolsProjection({ verse: { accountsRoot: root } } as AshlrConfig, snapshots, [], time);
function record(): CreditPoolObservation {
  return { v: 1, poolId: 'synthetic-gift', kind: 'gifted-cloud', accountId: account.id, provider: 'claude', amount: '12.34', total: '50', unit: 'USD',
    surface: 'cloud-session', capturedAt: new Date(now - 500).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), expiryKind: 'fixed',
    source: { kind: 'verified-manual', adapter: 'claude-account-ui' }, capture: { before: { ...snapshot.witness, observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 59000).toISOString() }, after: snapshot.witness } };
}
function roster(accounts = [account]) { writeFileSync(join(root, 'connections.json'), JSON.stringify({ schemaVersion: 1, intervalMs: 30_000, accounts }), { mode: 0o600 }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-credit-projection-'))); chmodSync(root, 0o700);
  state = join(root, 'native-state'); mkdirSync(state, { mode: 0o700 }); mkdirSync(join(root, 'ledger'), { mode: 0o700 });
  account = { id: 'demo-claude', label: 'Synthetic', provider: 'claude', command: ['/private/inert/node', '/private/inert/launcher.mjs'] };
  resolver.mockReset().mockReturnValue({ ok: true, launch: { provider: account.provider, seatId: account.id, nativeStatePath: state, command: account.command } });
  writeFileSync(join(state, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'demo@example.invalid', organizationUuid: 'demo-org' } }), { mode: 0o600 });
  snapshot = { witness: { provider: 'claude', accountId: account.id, accountDigest: hint, profileDigest: resourceAccountProfileDigest(account), generation: 1,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), source: 'native-account-checked' }, localEpoch: readResourceAccountLocalEpoch(root, account) };
  roster(); writeFileSync(join(root, 'credit-pools.json'), JSON.stringify({ v: 1, observations: [record()] }), { mode: 0o600 });
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
describe('worker credit identity projection', () => {
  it('shows only same-account amount after exact profile/local metadata check, without private evidence', () => {
    expect(parseCreditPoolObservation(record(), now)).not.toBeNull(); const view = read(); expect(view).toMatchObject({ sourceState: 'healthy', rows: [{ amount: '12.34', identityState: 'matched', evidenceState: 'recorded' }] });
    for (const secret of [hint, root, 'demo@example.invalid', 'accountDigest', 'profileDigest', 'epochDigest']) expect(JSON.stringify(view)).not.toContain(secret);
  });
  it.each(['expired', 'changed-auth', 'changed-launcher', 'missing-epoch', 'wrong-account'] as const)('withholds %s identity without zeroing the balance', kind => {
    if (kind === 'changed-auth') writeFileSync(join(state, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.invalid', organizationUuid: 'demo-org' } }), { mode: 0o600 });
    if (kind === 'changed-launcher') roster([{ ...account, command: ['/private/changed/launcher'] }]);
    if (kind === 'missing-epoch') snapshot.localEpoch = null;
    if (kind === 'wrong-account') snapshot.witness.accountDigest = 'd'.repeat(64);
    expect(read([snapshot], kind === 'expired' ? now + 60_000 : now)).toMatchObject({ sourceState: 'healthy', rows: [{ amount: null, total: null, identityState: 'unknown', evidenceState: 'identity-unknown' }] });
  });
  it.each(['malformed', 'duplicate', 'public'])('refuses %s whole roster rather than trusting a matching partial row', kind => {
    if (kind === 'malformed') writeFileSync(join(root, 'connections.json'), '{bad', { mode: 0o600 });
    if (kind === 'duplicate') roster([account, account]);
    if (kind === 'public') chmodSync(join(root, 'connections.json'), 0o644);
    expect(read()).toEqual({ v: 1, sourceState: 'unavailable', rows: [] });
  });
  it('can show restart history only after unchanged original account/profile epoch, never as native-current', async () => {
    vi.useRealTimers(); // Existing async cache writer has a native setImmediate boundary.
    const actualNow = Date.now(); const observedAt = new Date(actualNow).toISOString(); const expiresAt = new Date(actualNow + 60_000).toISOString();
    snapshot.witness.observedAt = observedAt; snapshot.witness.expiresAt = expiresAt;
    const observation = record(); observation.capturedAt = observedAt; observation.capture.before = { ...snapshot.witness }; observation.capture.after = { ...snapshot.witness };
    observation.expiresAt = new Date(actualNow + 86_400_000).toISOString();
    writeFileSync(join(root, 'credit-pools.json'), JSON.stringify({ v: 1, observations: [observation] }), { mode: 0o600 });
    expect(parseCreditPoolObservation(observation, actualNow)).not.toBeNull();
    const cache = createResourceReadingCache({ root: join(root, 'ledger'), accountsRoot: root, accounts: [account], assertOwnership: () => {} });
    cache.remember(account, { id: account.id, label: account.label, provider: 'claude', state: 'observed', authentication: 'signed-in', health: 'reachable',
      planType: 'max', observedAt, expiresAt, windows: [], codexCredits: null, reason: 'synthetic', onDemandEnabled: null, executionSupported: true }, hint, readResourceAccountLocalEpoch(root, account));
    expect(cache.witness(account)).not.toBeNull(); await cache.flush();
    const restarted = createResourceReadingCache({ root: join(root, 'ledger'), accountsRoot: root, accounts: [account], assertOwnership: () => { throw new Error('read-only'); } });
    expect(restarted.witness(account)).toMatchObject({ source: 'native-account-checked-local-epoch' });
    expect(readCreditPoolsProjection({ verse: { accountsRoot: root } } as AshlrConfig, [], ['demo-claude'], Date.now()).rows[0]?.amount).toBeNull();
    // A later local metadata check must use the projection clock, rather than
    // manufacture a future witness rejected by its own captured read time.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(actualNow + 20);
    expect(readCreditPoolsProjection({ verse: { accountsRoot: root } } as AshlrConfig, [], [], actualNow + 10)).toMatchObject({ sourceState: 'healthy', rows: [{ amount: '12.34', evidenceState: 'recorded' }] });
    clock.mockRestore();
    writeFileSync(join(state, '.claude.json'), '{}', { mode: 0o600 });
    expect(readCreditPoolsProjection({ verse: { accountsRoot: root } } as AshlrConfig, [], [], Date.now()).rows[0]?.amount).toBeNull();
  });
});

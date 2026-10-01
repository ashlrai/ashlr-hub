/** Synthetic account evidence only; no provider/native executable or real wallet. */
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_POOL_FILE, CREDIT_POOL_MAX_BYTES, parseCreditPoolObservation, projectCreditPoolObservations,
  readCreditPoolObservations, writeCreditPoolObservation } from '../src/core/resources/credit-pool-observations.js';
import type { CreditPoolObservation } from '../src/core/resources/credit-pool-types.js';
import type { ResourceAccountIdentityWitness } from '../src/core/resources/account-identity-witness.js';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const at = (delta = 0) => new Date(NOW + delta).toISOString();
function witness(patch: Partial<ResourceAccountIdentityWitness> = {}): ResourceAccountIdentityWitness {
  return { provider: 'claude', accountId: 'demo-claude', accountDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), generation: 1,
    observedAt: at(-1_000), expiresAt: at(59_000), source: 'native-account-checked', ...patch };
}
function observation(patch: Partial<CreditPoolObservation> = {}): CreditPoolObservation {
  return { v: 1, poolId: 'demo-cloud-gift', kind: 'gifted-cloud', accountId: 'demo-claude', provider: 'claude',
    amount: '12.340000000000000001', total: '50', unit: 'USD', surface: 'cloud-session', capturedAt: at(-500),
    expiresAt: at(86_400_000), expiryKind: 'fixed', source: { kind: 'verified-manual', adapter: 'claude-account-ui' },
    capture: { before: witness(), after: witness({ observedAt: at(-100) }) }, ...patch };
}
function subscription(): CreditPoolObservation {
  return observation({ poolId: 'demo-weekly', kind: 'subscription-allowance', amount: '37.5', total: null, unit: 'percent', surface: 'subscription',
    source: { kind: 'native-metadata', adapter: 'claude-usage' } });
}
let root: string;
const file = () => join(root, CREDIT_POOL_FILE);
const read = (currentWitnesses: ResourceAccountIdentityWitness[] = [witness()], nowMs = NOW) => readCreditPoolObservations({ root, currentWitnesses, nowMs });
const write = (value: unknown, readCurrentWitness: () => ResourceAccountIdentityWitness | null = () => witness(), nowMs = NOW) => writeCreditPoolObservation(value, { root, nowMs, readCurrentWitness });
const raw = (rows: unknown[]) => writeFileSync(file(), JSON.stringify({ v: 1, observations: rows }), { mode: 0o600 });
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-credit-pools-'))); chmodSync(root, 0o700); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('private credit pool evidence', () => {
  it('keeps distinct gift, purchased and subscription observations with exact decimals and original dates', () => {
    write(observation()); write(observation({ poolId: 'demo-purchased', kind: 'purchased-usage', surface: 'over-plan-usage', amount: '7.01', total: null,
      expiresAt: null, expiryKind: 'unknown' })); write(subscription());
    const view = read(); expect(view.sourceState).toBe('healthy'); expect(view.rows).toHaveLength(3);
    expect(view.rows.map(row => row.kind)).toEqual(['gifted-cloud', 'purchased-usage', 'subscription-allowance']);
    expect(view.rows[0]).toMatchObject({ amount: '12.340000000000000001', capturedAt: at(-500), expiresAt: at(86_400_000), evidenceState: 'recorded' });
    expect(view.rows[2]?.evidenceState).toBe('current-native');
    expect(JSON.stringify(view)).not.toContain('accountDigest'); expect(JSON.stringify(view)).not.toContain('profileDigest');
    expect(JSON.stringify(view)).not.toContain('generation'); expect(JSON.stringify(view)).not.toContain('capture"');
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
  it('preserves all 150 accounts without a count ceiling or replacing another pool', () => {
    const rows = Array.from({ length: 150 }, (_, i) => {
      const accountId = `demo-${i}`; return observation({ accountId, capture: { before: witness({ accountId }), after: witness({ accountId }) }, capturedAt: at(-1_000) });
    }); raw(rows);
    const current = rows.map(row => witness({ accountId: row.accountId }));
    expect(read(current).rows).toHaveLength(150);
    const first = rows[149]!; write({ ...first, amount: '8', capturedAt: at(-500), capture: { before: witness({ accountId: first.accountId }), after: witness({ accountId: first.accountId, observedAt: at(-100) }) } }, () => witness({ accountId: first.accountId }));
    expect(read(current).rows).toHaveLength(150); expect(read(current).rows.find(row => row.accountId === first.accountId)?.amount).toBe('8');
    expect(read(current).rows[0]?.amount).toBe(rows[0]?.amount);
  });
  it.each(['unknown', 'account', 'profile', 'provider', 'expired', 'duplicate'] as const)('hides balances for %s identity evidence', kind => {
    write(observation()); const current = kind === 'unknown' ? [] : kind === 'duplicate' ? [witness(), witness()] : [witness({
      ...(kind === 'account' ? { accountDigest: 'c'.repeat(64) } : {}), ...(kind === 'profile' ? { profileDigest: 'd'.repeat(64) } : {}),
      ...(kind === 'provider' ? { provider: 'grok' } : {}), ...(kind === 'expired' ? { expiresAt: at() } : {}) })];
    const view = read(current); expect(view.rows[0]?.amount).toBeNull(); expect(view.rows[0]?.total).toBeNull();
    expect(view.rows[0]?.identityState).toBe(['account', 'profile'].includes(kind) ? 'mismatch' : 'unknown');
  });
  it('qualifies restart local-epoch matches as history and never as current native usage', () => {
    write(subscription()); const view = read([witness({ source: 'native-account-checked-local-epoch', generation: 2 })]);
    expect(view.rows[0]).toMatchObject({ amount: '37.5', identityState: 'matched', evidenceState: 'stale-native' });
  });
  it('retains original expired gift history without extending its deadline', () => {
    write(observation()); const later = NOW + 86_400_001;
    const view = read([witness({ observedAt: new Date(later - 1).toISOString(), expiresAt: new Date(later + 59_999).toISOString() })], later);
    expect(view.rows[0]).toMatchObject({ amount: '12.340000000000000001', capturedAt: at(-500), expiresAt: at(86_400_000), expiryState: 'expired', evidenceState: 'recorded' });
  });
  it('never refreshes old native usage by pairing it with a new current witness', () => {
    write(subscription()); const later = NOW + 100_000;
    expect(read([witness({ observedAt: new Date(later).toISOString(), expiresAt: new Date(later + 60_000).toISOString() })], later).rows[0]?.evidenceState).toBe('stale-native');
  });
  it('distinguishes missing, malformed and private-file failures without zero defaults', () => {
    expect(read()).toEqual({ v: 1, sourceState: 'missing', rows: [] });
    writeFileSync(file(), '{', { mode: 0o600 }); expect(read().sourceState).toBe('unavailable');
    raw([observation()]); chmodSync(file(), 0o644); expect(read().sourceState).toBe('unavailable');
    chmodSync(file(), 0o600); chmodSync(root, 0o755); expect(read().sourceState).toBe('unavailable');
  });
  it.each(['symlink', 'dangling', 'hardlink'] as const)('refuses %s storage', kind => {
    const target = join(root, 'other.json'); writeFileSync(target, JSON.stringify({ v: 1, observations: [observation()] }), { mode: 0o600 });
    if (kind === 'hardlink') linkSync(target, file()); else symlinkSync(kind === 'dangling' ? join(root, 'absent') : target, file());
    expect(read().sourceState).toBe('unavailable'); expect(() => write(observation())).toThrow();
  });
  it('refuses whole-file partial success, duplicate records and oversized files', () => {
    raw([observation(), { ...observation(), poolId: 'other', amount: '-1' }]); expect(read().rows).toEqual([]); expect(read().sourceState).toBe('unavailable');
    raw([observation(), observation()]); expect(read().sourceState).toBe('unavailable');
    writeFileSync(file(), ' '.repeat(CREDIT_POOL_MAX_BYTES + 1)); expect(read().sourceState).toBe('unavailable');
  });
  it('preserves the previous file on byte exhaustion rather than writing an unreadable success', () => {
    const rows: CreditPoolObservation[] = [];
    // Each row adds only its serialized bytes and a comma; repeatedly serializing
    // the whole growing array makes this boundary fixture quadratic on CI.
    let bytes = Buffer.byteLength(JSON.stringify({ v: 1, observations: [] }) + '\n');
    for (let i = 0; ; i++) {
      const next = observation({ poolId: `demo-${i}` });
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(next)) + (rows.length === 0 ? 0 : 1);
      if (nextBytes > CREDIT_POOL_MAX_BYTES) break;
      rows.push(next); bytes = nextBytes;
    }
    expect(Buffer.byteLength(JSON.stringify({ v: 1, observations: rows }) + '\n')).toBe(bytes);
    raw(rows); const before = readFileSync(file());
    expect(() => write(observation({ poolId: 'demo-extra' }))).toThrow('byte limit');
    expect(readFileSync(file()).equals(before)).toBe(true); expect(read().sourceState).toBe('healthy');
  });
  it('deduplicates exact replay, refuses older/conflicting capture and preserves prior bytes', () => {
    const row = observation(); write(row); const before = readFileSync(file()); write(row); expect(read().rows).toHaveLength(1);
    expect(readFileSync(file())).toEqual(before);
    expect(() => write({ ...row, amount: '6' })).toThrow('replay conflict'); expect(readFileSync(file())).toEqual(before);
    expect(() => write({ ...row, capturedAt: at(-700) })).toThrow('replay conflict'); expect(readFileSync(file())).toEqual(before);
  });
  it.each(['generation', 'account', 'profile', 'unknown', 'local-epoch'] as const)('fences a %s switch during write', kind => {
    write(observation()); const before = readFileSync(file()); let calls = 0;
    const latest = kind === 'unknown' ? null : witness({ ...(kind === 'generation' ? { generation: 2 } : {}),
      ...(kind === 'account' ? { accountDigest: 'c'.repeat(64) } : {}), ...(kind === 'profile' ? { profileDigest: 'd'.repeat(64) } : {}),
      ...(kind === 'local-epoch' ? { source: 'native-account-checked-local-epoch' } : {}) });
    expect(() => write(observation({ poolId: 'other' }), () => ++calls === 1 ? witness() : latest)).toThrow('identity changed');
    expect(readFileSync(file())).toEqual(before);
  });
  it('refuses unbound/manual-only capture and cannot write with merely historical identity', () => {
    expect(() => write(observation(), () => witness({ source: 'native-account-checked-local-epoch' }))).toThrow('identity unavailable');
    expect(() => write(observation(), () => witness({ generation: 2 }))).toThrow('identity unavailable');
    expect(parseCreditPoolObservation(observation({ capture: { before: witness(), after: witness({ accountDigest: 'c'.repeat(64) }) } }), NOW)).toBeNull();
    expect(parseCreditPoolObservation(observation({ capture: { before: witness({ source: 'native-account-checked-local-epoch' }), after: witness() } }), NOW)).toBeNull();
  });
  it.each(['-1', 'NaN', 'Infinity', '1e4', '01', '1.', ' 2', 'secret'.repeat(30)])('refuses invalid decimal %s', amount => {
    expect(parseCreditPoolObservation(observation({ amount }), NOW)).toBeNull();
  });
  it('compares decimal totals without losing precision or fabricating unknown amounts', () => {
    expect(parseCreditPoolObservation(observation({ amount: '1.000000000000000001', total: '1' }), NOW)).toBeNull();
    expect(parseCreditPoolObservation(observation({ amount: null, total: null }), NOW)?.amount).toBeNull();
    expect(parseCreditPoolObservation(subscription(), NOW)?.amount).toBe('37.5');
    expect(parseCreditPoolObservation({ ...subscription(), amount: '100.0001' }, NOW)).toBeNull();
    expect(parseCreditPoolObservation({ ...subscription(), amount: '100.000000000000000001' }, NOW)).toBeNull();
  });
  it('rejects future/torn dates, overlong witness validity and cross-surface/source claims', () => {
    for (const row of [observation({ capturedAt: at(1) }), observation({ expiresAt: at(-600) }), observation({ capturedAt: '2026-10-01' }),
      observation({ capture: { before: witness({ expiresAt: at(70_000) }), after: witness() } }), observation({ surface: 'over-plan-usage' }),
      observation({ provider: 'codex' }), observation({ source: { kind: 'native-metadata', adapter: 'claude-usage' } }),
      { ...subscription(), source: { kind: 'native-metadata', adapter: 'grok-usage' } }]) expect(parseCreditPoolObservation(row, NOW)).toBeNull();
  });
  it('does not invoke getters or accept inherited fields, proxies or huge sparse arrays', () => {
    let called = 0; const getter = { ...observation(), get amount() { called++; return 'secret'; } };
    expect(parseCreditPoolObservation(getter, NOW)).toBeNull(); expect(called).toBe(0);
    expect(parseCreditPoolObservation(Object.create(observation()), NOW)).toBeNull();
    expect(parseCreditPoolObservation(new Proxy({}, { ownKeys() { throw new Error('secret'); } }), NOW)).toBeNull();
    expect(projectCreditPoolObservations(new Array(1_000_000_000), [witness()], NOW).sourceState).toBe('unavailable');
    expect(projectCreditPoolObservations([observation()], [getter as unknown as ResourceAccountIdentityWitness], NOW).rows[0]?.amount).toBeNull();
  });
});

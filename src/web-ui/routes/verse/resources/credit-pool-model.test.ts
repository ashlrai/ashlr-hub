import { describe, expect, it } from 'vitest';
import { creditPoolDisplay, narrowCreditPoolsRead } from './credit-pool-model';
import type { CreditPoolReadView, CreditPoolRowView } from '../../../../core/resources/credit-pool-types.js';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
function row(patch: Partial<CreditPoolRowView> = {}): CreditPoolRowView {
  return { poolId: 'demo-gift', accountId: 'demo-claude', provider: 'claude', kind: 'gifted-cloud', amount: '12.340000000000000001', total: '50',
    unit: 'USD', surface: 'cloud-session', capturedAt: '2026-10-01T11:59:30.000Z', expiresAt: '2026-10-02T12:00:00.000Z',
    expiryKind: 'fixed', source: { kind: 'verified-manual', adapter: 'claude-account-ui' }, identityState: 'matched', evidenceState: 'recorded', expiryState: 'upcoming', ...patch };
}
function view(rows: CreditPoolRowView[] = [row()]): CreditPoolReadView { return { v: 1, sourceState: 'healthy', rows }; }
function subscription(patch: Partial<CreditPoolRowView> = {}): CreditPoolRowView {
  return row({ poolId: 'demo-weekly', kind: 'subscription-allowance', unit: 'percent', surface: 'subscription', amount: '70', total: null,
    source: { kind: 'native-metadata', adapter: 'claude-usage' }, evidenceState: 'current-native', ...patch });
}

describe('credit pool display-only projection', () => {
  it('keeps a cloud gift historical and scoped separately from purchased credits and subscription', () => {
    const gift = creditPoolDisplay(row(), NOW);
    expect(gift.title).toBe('Cloud gift'); expect(gift.amountText).toBe('$12.340000000000000001 last recorded');
    expect(gift.sourceText).toBe('Verified account UI capture · historical reading'); expect(gift.expiryText).toBe('Verified credit expiry');
    expect(gift.scopeText).toContain('cloud sessions only'); expect(gift.scopeText).toContain('excludes Projects and Routines');
    const purchased = creditPoolDisplay(row({ kind: 'purchased-usage', surface: 'over-plan-usage', amount: '7.01', total: null, expiresAt: null, expiryKind: 'unknown', expiryState: 'unknown' }), NOW);
    expect(purchased.title).toBe('Purchased usage credits'); expect(purchased.expiryText).toBe('Expiry unknown');
    expect(purchased.scopeText).toContain('separate from cloud gifts');
    const plan = creditPoolDisplay(subscription(), NOW); expect(plan.amountText).toBe('70% used');
    expect(plan.scopeText).toBe('Subscription usage; separate from dollar credits.'); expect(plan.amountText).not.toContain('$');
  });
  it('passes exact source-compatible projection with all 150 accounts, without a count cap', () => {
    const data = view(Array.from({ length: 150 }, (_, i) => row({ accountId: `demo-${i}` })));
    expect(narrowCreditPoolsRead(data)?.rows).toHaveLength(150);
  });
  it('retains recorded dates when a verified deadline passes and never says spendable or usable', () => {
    const data = row(); const display = creditPoolDisplay(data, NOW + 86_400_001);
    expect(display.expiryText).toBe('Recorded deadline has passed'); expect(display.expiresAt).toBe(data.expiresAt);
    expect(display.capturedAt).toBe(data.capturedAt); expect(display.amountText).toContain('last recorded');
    expect(JSON.stringify(display)).not.toMatch(/spendable|usable|eligible|remaining tokens/);
    expect(creditPoolDisplay(subscription(), NOW + 86_400_001).sourceText).toContain('historical');
  });
  it('labels rolling subscription release without treating it as gift expiry', () => {
    const display = creditPoolDisplay(subscription({ expiryKind: 'rolling-release', evidenceState: 'stale-native' }), NOW);
    expect(display.expiryText).toBe('Rolling release, not credit expiry'); expect(display.amountText).toBe('70% used · last recorded');
  });
  it.each(['unknown', 'mismatch'] as const)('hides monetary values for %s account identity', identityState => {
    const data = row({ identityState, amount: null, total: null, evidenceState: identityState === 'unknown' ? 'identity-unknown' : 'identity-mismatch' });
    expect(narrowCreditPoolsRead(view([data]))).not.toBeNull();
    const display = creditPoolDisplay(data, NOW); expect(display.amountText).toContain('Balance hidden'); expect(display.amountText).not.toContain('$');
    expect(narrowCreditPoolsRead(view([{ ...data, amount: '12' }]))).toBeNull();
  });
  it('distinguishes a reported zero from missing amounts, missing store and unavailable source', () => {
    expect(creditPoolDisplay(row({ amount: '0' }), NOW).amountText).toBe('$0 last recorded');
    expect(creditPoolDisplay(row({ amount: null }), NOW).amountText).toBe('Balance unknown');
    expect(creditPoolDisplay(subscription({ amount: null }), NOW).amountText).toBe('Usage unknown');
    for (const sourceState of ['missing', 'unavailable'] as const) {
      expect(narrowCreditPoolsRead({ v: 1, sourceState, rows: [] })?.sourceState).toBe(sourceState);
      expect(narrowCreditPoolsRead({ ...view(), sourceState })).toBeNull();
    }
  });
  it('refuses raw identity evidence, private paths and unqualified manual/native sources', () => {
    for (const data of [{ ...row(), accountDigest: 'a'.repeat(64) }, { ...row(), path: '/private/demo' },
      row({ source: { kind: 'native-metadata', adapter: 'claude-usage' } }), row({ source: { kind: 'verified-manual', adapter: 'codex-rate-limits' } }),
      row({ provider: 'codex' }), row({ surface: 'over-plan-usage' }), subscription({ source: { kind: 'native-metadata', adapter: 'grok-usage' } }),
      row({ evidenceState: 'current-native' }), subscription({ evidenceState: 'recorded' })]) expect(narrowCreditPoolsRead(view([data]))).toBeNull();
  });
  it.each(['-1', '1e3', 'Infinity', 'NaN', '01', 'secret'.repeat(100)])('rejects malformed monetary text %s', amount => {
    expect(narrowCreditPoolsRead(view([row({ amount })]))).toBeNull();
  });
  it('rejects exact decimal contradictions and subscription percentages beyond 100', () => {
    expect(narrowCreditPoolsRead(view([row({ amount: '1.000000000000000001', total: '1' })]))).toBeNull();
    expect(narrowCreditPoolsRead(view([subscription({ amount: '100.000000000000000001' })]))).toBeNull();
  });
  it('refuses malformed dates/expiry metadata and duplicate rows without partial success', () => {
    for (const data of [row({ capturedAt: '2026-10-01' }), row({ expiresAt: null }), row({ expiryState: 'unknown' }), row({ expiryKind: 'rolling-release' })])
      expect(narrowCreditPoolsRead(view([data]))).toBeNull();
    expect(narrowCreditPoolsRead(view([row(), row()]))).toBeNull();
  });
  it('never invokes getters and bounds sparse/oversized payloads without truncating them', () => {
    let called = 0; const getter = { ...row(), get amount() { called++; return 'private'; } };
    expect(narrowCreditPoolsRead(view([getter]))).toBeNull(); expect(called).toBe(0);
    expect(narrowCreditPoolsRead(view([Object.create(row())]))).toBeNull();
    expect(narrowCreditPoolsRead({ v: 1, sourceState: 'healthy', rows: new Array(1_000_000_000) })).toBeNull();
    expect(narrowCreditPoolsRead(view(Array.from({ length: 5_000 }, (_, i) => row({ poolId: `demo-${i}` }))))).toBeNull();
  });
});

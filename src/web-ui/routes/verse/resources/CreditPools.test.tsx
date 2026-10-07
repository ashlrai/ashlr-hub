import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreditPools, narrowCreditPoolsEnvelope } from './CreditPools.js';
import { CREDIT_POOLS_PATH, type CreditPoolsRead } from '../../../../core/verse/credit-pools-api-types.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
const at = '2026-10-01T12:00:00.000Z';
function fixture(): CreditPoolsRead {
  return { v: 1, state: 'current', refreshedAt: at, pools: { v: 1, sourceState: 'healthy', rows: [
    { poolId: 'gift', accountId: 'sample-claude', provider: 'claude', kind: 'gifted-cloud', amount: '12.34', total: '50', unit: 'USD',
      surface: 'cloud-session', capturedAt: at, expiresAt: '2026-11-01T12:00:00.000Z', expiryKind: 'fixed',
      source: { kind: 'verified-manual', adapter: 'claude-account-ui' }, identityState: 'matched', evidenceState: 'recorded', expiryState: 'upcoming' },
    { poolId: 'paid', accountId: 'sample-claude', provider: 'claude', kind: 'purchased-usage', amount: '9.75', total: '15', unit: 'USD',
      surface: 'over-plan-usage', capturedAt: at, expiresAt: null, expiryKind: 'unknown',
      source: { kind: 'verified-manual', adapter: 'claude-account-ui' }, identityState: 'matched', evidenceState: 'recorded', expiryState: 'unknown' },
  ] } };
}
beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Credit balance disclosure', () => {
  it('does no request while closed, labels two separate exact dollar records and original capture dates', async () => {
    const { fetchMock, posted } = stubSurfaceFetch({ routes: { [CREDIT_POOLS_PATH]: fixture() } });
    render(<CreditPools accountNames={new Map([['sample-claude', 'My Claude']])} />);
    expect(fetchMock).not.toHaveBeenCalled(); await userEvent.setup().click(screen.getByText('Credit balances'));
    await screen.findByText('$12 last recorded'); expect(screen.getByText('$9.8 last recorded')).toBeVisible();
    expect(screen.getByText('Cloud gift')).toBeVisible(); expect(screen.getByText('Purchased usage credits')).toBeVisible();
    expect(screen.getByText('Recorded total: $15')).toBeVisible(); expect(screen.getByText('Recorded grant: $50')).toBeVisible();
    expect(screen.getAllByText('My Claude')).toHaveLength(2); expect(screen.getByText('Expiry unknown')).toBeVisible();
    expect(document.querySelectorAll(`time[datetime="${at}"]`)).toHaveLength(2); expect(posted).toEqual([]);
  });
  it('keeps a missing record unknown rather than a zero-dollar balance', async () => {
    const value = fixture(); value.pools = { v: 1, sourceState: 'missing', rows: [] };
    stubSurfaceFetch({ routes: { [CREDIT_POOLS_PATH]: value } }); render(<CreditPools />);
    await userEvent.setup().click(screen.getByText('Credit balances')); await screen.findByText(/Balances are unknown/);
    expect(screen.queryByText(/\$0/)).toBeNull();
  });
  it('refuses identity leaks and impossible current null records before render', () => {
    const value = fixture(); expect(narrowCreditPoolsEnvelope(value)).not.toBeNull();
    expect(narrowCreditPoolsEnvelope({ ...value, pools: null })).toBeNull();
    expect(narrowCreditPoolsEnvelope({ ...value, pools: { ...value.pools, rows: [{ ...value.pools!.rows[0], accountDigest: 'a'.repeat(64) }] } })).toBeNull();
  });
  it('catches up a warming worker without polling after collapse', async () => {
    vi.useFakeTimers(); const { fetchMock } = stubSurfaceFetch({ routes: { [CREDIT_POOLS_PATH]: { v: 1, state: 'warming', refreshedAt: null, pools: null } } });
    render(<CreditPools />); fireEvent.click(screen.getByText('Credit balances'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('Credit balances')); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

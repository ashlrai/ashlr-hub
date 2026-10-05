import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { ResetSpendingAccountStatus, ResetSpendingMode } from '../../../../core/routing/reset-spending-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { ResetSpendingAccountControl, ResetSpendingControl } from './ResetSpendingControl.js';
import { updateResetSpending } from './reset-spending-queries.js';
import { readResetSpendingAccount, readResetSpendingStatus } from './reset-spending-model.js';

const NOW = Date.parse('2026-10-05T05:00:00.000Z');
function account(patch: Partial<ResetSpendingAccountStatus> = {}): ResetSpendingAccountStatus {
  return { mode: 'inherit', enabled: false, savedReservePercent: 40, signedFloorPercent: 40,
    effectiveReservePercent: null, state: 'signed-floor', reason: 'Your approved minimum holds the reserve.',
    constraints: ['Short-window usage ceiling is 70%.'], deadline: null, forecastBasis: null,
    subscriptionOnly: 'unknown', ...patch };
}
function view(mode: ResetSpendingMode, row = account(), sampledAt = NOW): BudgetView {
  return { mode: 'balanced', seats: { claude: { seatId: 'claude', enabled: true, reservePercent: 40,
      ...(row.mode === 'inherit' ? {} : { resetSpending: row.mode === 'enabled' }) } },
    updatedAt: new Date(sampledAt).toISOString(), sampledAt: new Date(sampledAt).toISOString(), readingMaxAgeMs: 60_000,
    seatInfo: [], effective: {}, headroom: [],
    ...(mode === 'legacy-priority' ? {} : { resetSpending: { enabled: mode === 'enabled' } }),
    resetSpendingStatus: { mode, checkedAt: new Date(sampledAt).toISOString(), authorityState: 'paused', accounts: { claude: row } } };
}
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); evictAll(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('allowance setting: persisted readback', () => {
  it('token loss during POST refuses late confirmation and never begins the fresh GET', async () => {
    setMutationToken(TEST_TOKEN);
    const reply = deferred<Response>();
    const { calls } = installFetch(() => reply.promise);
    const pending = updateResetSpending({ resetSpending: { enabled: true } });
    const rejected = expect(pending).rejects.toThrow('Confirmation interrupted');
    clearMutationToken();
    reply.resolve(json(view('enabled')));
    await rejected;
    expect(calls.map(call => call.method)).toEqual(['POST']);
  });

  it('token loss during GET refuses the received reading even if the same token is later re-held', async () => {
    setMutationToken(TEST_TOKEN);
    const reply = deferred<Response>();
    const { calls } = installFetch(call => call.method === 'POST' ? json(view('enabled')) : reply.promise);
    const pending = updateResetSpending({ resetSpending: { enabled: true } });
    const rejected = expect(pending).rejects.toThrow('Confirmation interrupted');
    await waitFor(() => expect(calls.map(call => call.method)).toEqual(['POST', 'GET']));
    clearMutationToken(); setMutationToken(TEST_TOKEN);
    reply.resolve(json(view('enabled')));
    await rejected;
  });
  it('requires a fresh GET after the guarded write, rather than trusting the acknowledgement', async () => {
    setMutationToken(TEST_TOKEN);
    const { calls } = installFetch(call => json(call.method === 'POST' ? view('enabled') : view('disabled')));
    await expect(updateResetSpending({ resetSpending: { enabled: true } })).rejects.toThrow('fresh reading does not confirm');
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET']);
    expect(calls[0]!.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(calls[0]!.body).toEqual({ resetSpending: { enabled: true } });
  });

  it.each([true, false, null])('round trips the account override %s without changing its saved reserve', async enabled => {
    setMutationToken(TEST_TOKEN);
    const row = account({ mode: enabled === null ? 'inherit' : enabled ? 'enabled' : 'disabled' });
    const saved = view('enabled', row);
    const { calls } = installFetch(() => json(saved));
    const result = await updateResetSpending({ seatId: 'claude', policy: { resetSpending: enabled } });
    expect(result.seats.claude!.reservePercent).toBe(40);
    expect(calls[0]!.body).toEqual({ seatId: 'claude', policy: { resetSpending: enabled } });
    expect(calls.map(call => call.method)).toEqual(['POST', 'GET']);
  });

  it('rejects a server that acknowledges the write but has no supported reset status', async () => {
    setMutationToken(TEST_TOKEN);
    const old = view('enabled'); delete old.resetSpendingStatus;
    installFetch(() => json(old));
    await expect(updateResetSpending({ resetSpending: { enabled: true } })).rejects.toThrow('fresh reading does not confirm');
  });
});

describe('allowance controls', () => {
  it('confirmed On is cleared when the shared reading resets to null', async () => {
    setMutationToken(TEST_TOKEN);
    installFetch(() => json(view('enabled', account(), NOW + 1)));
    const mounted = render(<ResetSpendingControl view={view('legacy-priority')} nowMs={NOW + 1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enable allowance before resets' }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    mounted.rerender(<ResetSpendingControl view={null} nowMs={NOW + 1} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(/Saved and confirmed/)).toBeNull();
  });

  it('losing mutation authority clears the local confirmation and returns to the shared reading', async () => {
    setMutationToken(TEST_TOKEN);
    installFetch(() => json(view('enabled', account(), NOW + 1)));
    render(<ResetSpendingControl view={view('legacy-priority')} nowMs={NOW + 1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enable allowance before resets' }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    act(() => clearMutationToken());
    expect(screen.getByRole('button', { name: 'Enable allowance before resets' })).toBeInTheDocument();
    expect(screen.queryByText(/Saved and confirmed/)).toBeNull();
  });

  it('unmounting during the readback refuses its late response without reviving a confirmation', async () => {
    setMutationToken(TEST_TOKEN);
    const reply = deferred<Response>();
    const { calls } = installFetch(call => call.method === 'POST' ? json(view('enabled')) : reply.promise);
    const mounted = render(<ResetSpendingControl view={view('legacy-priority')} nowMs={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enable allowance before resets' }));
    await waitFor(() => expect(calls.map(call => call.method)).toEqual(['POST', 'GET']));
    mounted.unmount();
    await act(async () => reply.resolve(json(view('enabled'))));
    render(<ResetSpendingControl view={view('legacy-priority')} nowMs={NOW} />);
    expect(screen.queryByText(/Saved and confirmed/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Enable allowance before resets' })).toBeInTheDocument();
  });

  it('rejects incomplete or mismatched forecast cohorts instead of displaying a task estimate', () => {
    const good = { taskId: 't', engine: 'claude', model: 'fable', taskKind: 'todo', seatId: 'claude', p75Ms: 30_000, samples: 2, pooled: false };
    for (const patch of [{ engine: null }, { model: null }, { taskKind: undefined }, { seatId: 'another-account' }]) {
      const malformed = view('enabled', account({ forecastBasis: { ...good, ...patch } as unknown as ResetSpendingAccountStatus['forecastBasis'] }));
      expect(readResetSpendingAccount(readResetSpendingStatus(malformed), 'claude')).toBeNull();
    }
    expect(readResetSpendingAccount(readResetSpendingStatus(view('enabled', account({ forecastBasis: good }))), 'claude')?.forecastBasis).toEqual(good);
  });
  it('opening legacy controls neither enrolls the account nor changes authority', () => {
    const { calls } = installFetch(() => json(view('enabled')));
    render(<ResetSpendingControl view={view('legacy-priority')} nowMs={NOW} />);
    expect(screen.getByRole('button', { name: 'Enable allowance before resets' })).toBeEnabled();
    expect(screen.getByText(/reserve shrinking is not enabled/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('an older server shows unavailable controls instead of pretending the feature is off', () => {
    const old = view('enabled'); delete old.resetSpendingStatus;
    render(<ResetSpendingControl view={old} nowMs={NOW} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText(/Controls unavailable/)).toBeInTheDocument();
  });

  it('a pending initial reading does not tell a current installation to upgrade', () => {
    render(<ResetSpendingControl view={null} nowMs={NOW} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('Allowance setting has not loaded yet.')).toBeInTheDocument();
    expect(screen.queryByText(/update Ashlr/)).toBeNull();
  });

  it('a failed readback retains the previous choice and shows what needs review', async () => {
    setMutationToken(TEST_TOKEN);
    installFetch(call => call.method === 'POST' ? json(view('enabled')) : json({ error: 'temporarily unavailable' }, 503));
    render(<ResetSpendingControl view={view('legacy-priority')} nowMs={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enable allowance before resets' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('saved state could not be confirmed');
    expect(screen.getByRole('button', { name: 'Enable allowance before resets' })).toBeEnabled();
    expect(screen.queryByText(/Saved and confirmed/)).toBeNull();
  });

  it('confirmed On remains distinct from a held grant, and a newer shared Off supersedes it', async () => {
    setMutationToken(TEST_TOKEN);
    installFetch(() => json(view('enabled', account(), NOW + 1)));
    const review = vi.fn();
    const mounted = render(<ResetSpendingControl view={view('legacy-priority')} nowMs={NOW + 1} onReviewGrant={review} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enable allowance before resets' }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/restrictions still hold/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review grant' }));
    expect(review).toHaveBeenCalledOnce();
    // A policy save can happen without a new resource-capacity sample.
    const newerPolicy = view('disabled', account(), NOW + 2);
    newerPolicy.sampledAt = new Date(NOW + 1).toISOString();
    mounted.rerender(<ResetSpendingControl view={newerPolicy} nowMs={NOW + 2} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('malformed account rows do not crash the global control or expose a working account toggle', () => {
    const malformed = view('enabled');
    (malformed.resetSpendingStatus!.accounts as unknown as Record<string, unknown>).claude = null;
    render(<><ResetSpendingControl view={malformed} nowMs={NOW} />
      <ResetSpendingAccountControl view={malformed} nowMs={NOW} seatId="claude" label="Claude" /></>);
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('an account On override explains that global Off still wins, without enabling it silently', () => {
    const { calls } = installFetch(() => json(view('enabled')));
    render(<ResetSpendingAccountControl view={view('disabled', account({ mode: 'enabled', state: 'disabled' }))}
      nowMs={NOW} seatId="claude" label="Claude" />);
    expect(screen.getByRole('combobox')).toHaveValue('enabled');
    expect(screen.getByText(/global setting must be On/)).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('stale task evidence is not displayed as a currently applied reserve', () => {
    render(<ResetSpendingAccountControl view={view('enabled', account({ state: 'ready', effectiveReservePercent: 5 }), NOW - 120_000)}
      nowMs={NOW} seatId="claude" label="Claude" />);
    expect(screen.getByText('Current eligibility unconfirmed')).toBeInTheDocument();
    expect(screen.getByText('No current task reserve applied.')).toBeInTheDocument();
    expect(screen.queryByText(/Task-derived reserve 5/)).toBeNull();
  });

  it('read-only mode disables both legacy actions and account overrides', () => {
    render(<><ResetSpendingControl view={view('legacy-priority')} nowMs={NOW} readOnly />
      <ResetSpendingAccountControl view={view('legacy-priority')} nowMs={NOW} seatId="claude" label="Claude" readOnly /></>);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});

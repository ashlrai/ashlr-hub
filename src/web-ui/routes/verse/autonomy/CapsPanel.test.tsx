import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsPanel } from './CapsPanel.js';
import { updateVerseCaps } from './control-queries.js';
import { CAPS, controlSnapshot } from '../sections/section-fixtures.test-support.js';
import { VERSE_UNCAPPED_COUNT_KEYS, type VerseCaps, type VerseCapsApplyResult } from './control-types.js';
import type { GuardedAction } from './use-guarded-action.js';

vi.mock('./control-queries.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./control-queries.js')>(), updateVerseCaps: vi.fn(),
}));

const available: VerseCaps = { ...CAPS, supportsUncappedCounts: true, uncappedCountKeys: [] };
function response(caps: VerseCaps): VerseCapsApplyResult {
  return { ok: true, applied: ['parallel'], live: true, caps };
}
function guard(over: Partial<GuardedAction> = {}): GuardedAction {
  return { request: (fn) => { void fn().catch(() => {}); }, busy: false, error: null, readOnly: false,
    tokenOpen: false, tokenReason: '', clearError: vi.fn(), closeToken: vi.fn(), ...over };
}
const panel = (caps = available, action = guard(), enabled = true) => <CapsPanel caps={caps} snapshot={controlSnapshot()} guard={action} dispatchEnabled={enabled} />;
const automatic = () => screen.getByRole('button', { name: 'Use Automatic for Parallel swarms' });
afterEach(() => vi.clearAllMocks());

describe('CapsPanel Automatic counts', () => {
  it('keeps older-server nulls editable without labeling them Automatic or writing on mount', () => {
    render(panel({ ...CAPS, maxConcurrent: null, concurrency: { local: null, cloud: null, total: null } }));
    expect(screen.queryByRole('button', { name: /Automatic/ })).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Max concurrent' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: 'Max concurrent' })).toBeEnabled();
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });

  it('writes one minimal null choice through the guard and confirms actual server readback', async () => {
    const next = { ...available, parallel: null, uncappedCountKeys: ['parallel'] } satisfies VerseCaps;
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response(next));
    const { rerender } = render(panel());
    fireEvent.click(automatic());
    await screen.findByText('applied live');
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ parallel: null });
    rerender(panel(next));
    expect(automatic()).toHaveAttribute('aria-pressed', 'true');
    expect(automatic()).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Parallel swarms' })).toHaveAttribute('placeholder', 'Automatic');
  });

  it('supports returning to a manual positive count from Automatic', async () => {
    const source = { ...available, parallel: null, uncappedCountKeys: ['parallel'] } satisfies VerseCaps;
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...available, parallel: 17 }));
    render(panel(source));
    const input = screen.getByRole('spinbutton', { name: 'Parallel swarms' });
    fireEvent.change(input, { target: { value: '17' } }); fireEvent.blur(input);
    await screen.findByText('applied live');
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ parallel: 17 });
  });

  it('changes only six count preferences in one guarded action', async () => {
    const next = { ...available, perTickItems: null, parallel: null, maxConcurrent: null,
      concurrency: { local: null, cloud: null, total: null }, uncappedCountKeys: [...VERSE_UNCAPPED_COUNT_KEYS] };
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response(next));
    render(panel()); fireEvent.click(screen.getByRole('button', { name: 'Use Automatic counts' }));
    await screen.findByText('Automatic counts applied live');
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ perTickItems: null, parallel: null, maxConcurrent: null,
      concurrency: { local: null, cloud: null, total: null } });
  });

  it('bulk Automatic wins over a focused unsaved numeric draft without an intermediate blur write', async () => {
    const user = userEvent.setup();
    const next = { ...available, perTickItems: null, parallel: null, maxConcurrent: null,
      concurrency: { local: null, cloud: null, total: null }, uncappedCountKeys: [...VERSE_UNCAPPED_COUNT_KEYS] };
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response(next));
    render(panel());
    const input = screen.getByRole('spinbutton', { name: 'Parallel swarms' });
    await user.click(input); await user.clear(input); await user.type(input, '17');
    expect(updateVerseCaps).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use Automatic counts' }));
    await screen.findByText('Automatic counts applied live');
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ perTickItems: null, parallel: null, maxConcurrent: null,
      concurrency: { local: null, cloud: null, total: null } });
  });

  it('releases a failed save for retry without a success claim', async () => {
    vi.mocked(updateVerseCaps).mockRejectedValueOnce(new Error('private transport failure'));
    render(panel()); fireEvent.click(automatic());
    await waitFor(() => expect(automatic()).toBeEnabled());
    expect(screen.queryByText('applied live')).not.toBeInTheDocument();
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...available, parallel: null, uncappedCountKeys: ['parallel'] }));
    fireEvent.click(automatic()); await screen.findByText('applied live');
    expect(updateVerseCaps).toHaveBeenCalledTimes(2);
  });

  it.each([{ readOnly: true }, { tokenOpen: true }, { busy: true }])('respects the existing token/read-only guard %j', (state) => {
    render(panel(available, guard(state)));
    expect(automatic()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use Automatic counts' })).toBeDisabled();
    fireEvent.click(automatic()); expect(updateVerseCaps).not.toHaveBeenCalled();
  });

  it('refuses a deferred action after unmount or capability loss', async () => {
    let deferred: (() => Promise<unknown>) | undefined;
    const action = guard({ request: (fn) => { deferred = fn; } });
    const { rerender, unmount } = render(panel(available, action));
    fireEvent.click(automatic()); expect(updateVerseCaps).not.toHaveBeenCalled();
    rerender(panel({ ...available, supportsUncappedCounts: false }, action));
    await expect(deferred!()).rejects.toThrow(/unavailable/);
    expect(updateVerseCaps).not.toHaveBeenCalled();
    rerender(panel(available, action)); fireEvent.click(automatic()); unmount();
    await deferred!(); expect(updateVerseCaps).not.toHaveBeenCalled();
  });

  it('does not report success when the server returns old-style null without confirmation metadata', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...CAPS, parallel: null }));
    render(panel()); fireEvent.click(automatic());
    await waitFor(() => expect(updateVerseCaps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(automatic()).toBeEnabled());
    expect(screen.queryByText('applied live')).not.toBeInTheDocument();
    expect(automatic()).toHaveAttribute('aria-pressed', 'false');
  });

  it('rejects blank and zero manual counts while budget zero still means stopped', () => {
    render(panel({ ...available, dailyBudgetUsd: 0 }));
    expect(screen.getByText('Loop stopped ($0 budget).')).toBeInTheDocument();
    const input = screen.getByRole('spinbutton', { name: 'Parallel swarms' });
    fireEvent.change(input, { target: { value: '0' } }); fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent(/between 1/);
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });
});

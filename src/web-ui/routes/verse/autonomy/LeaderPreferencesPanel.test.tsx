import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LeaderPreferencesPanel } from './LeaderPreferencesPanel.js';
import { updateVerseCaps } from './control-queries.js';
import type { VerseCapsApplyResult } from './control-types.js';
import type { LeaderPreferences } from './leader-preferences-spec.js';
import type { GuardedAction } from './use-guarded-action.js';

vi.mock('./control-queries.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./control-queries.js')>(), updateVerseCaps: vi.fn(),
}));
const preferences: LeaderPreferences = { maxFullRunsPerDay: 3, maxTotalRunsPerDay: 8, maxGrokLanes: 4,
  sourceState: 'ready', errors: [], defaulted: ['maxFullRunsPerDay', 'maxTotalRunsPerDay', 'maxGrokLanes'] };
function response(next?: LeaderPreferences): VerseCapsApplyResult {
  return { ok: true, applied: ['leaderPreferences'], live: true, caps: {
    dailyBudgetUsd: 25, perTickItems: 4, parallel: 2, intervalMs: 900_000, mode: 'batch', maxConcurrent: 8,
    concurrency: { local: 2, cloud: 6, total: 8 }, subscriptionMaxPercent: 80, foundryLimits: [], defaulted: [],
    ...(next ? { leaderPreferences: next } : {}),
  } };
}
function guard(over: Partial<GuardedAction> = {}): GuardedAction {
  const request: GuardedAction['request'] = (fn, _reason, onResult) => { void fn().then((result) => onResult?.(result)).catch(() => {}); };
  return { request, busy: false, error: null, clearError: vi.fn(), readOnly: false, tokenOpen: false,
    tokenReason: '', closeToken: vi.fn(), ...over };
}
function open(next: LeaderPreferences | undefined = preferences, over: Partial<GuardedAction> = {}) {
  const g = guard(over);
  const view = render(<LeaderPreferencesPanel preferences={next} guard={g} dispatchEnabled />);
  fireEvent.click(screen.getByText('Leader preferences'));
  return { ...view, guard: g };
}
const full = () => screen.getByRole('textbox', { name: 'Full plans per day' });
const save = () => screen.getByRole('button', { name: 'Save Leader preferences' });
afterEach(() => vi.clearAllMocks());

describe('LeaderPreferencesPanel', () => {
  it('keeps advanced controls optional and displays actual legacy projections without starting work', () => {
    const g = guard();
    const { rerender } = render(<LeaderPreferencesPanel preferences={preferences} guard={g} dispatchEnabled />);
    expect(screen.getByText('Leader preferences').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Leader preferences'));
    expect(full()).toHaveValue('3');
    expect(screen.getByRole('textbox', { name: 'Total runs per day' })).toHaveValue('8');
    expect(screen.getByRole('textbox', { name: 'Parallel Grok lanes' })).toHaveValue('4');
    rerender(<LeaderPreferencesPanel preferences={{ ...preferences, maxTotalRunsPerDay: 3 }} guard={g} dispatchEnabled />);
    expect(screen.getByRole('textbox', { name: 'Total runs per day' })).toHaveValue('3');
    expect(save()).toBeDisabled(); expect(updateVerseCaps).not.toHaveBeenCalled();
    expect(screen.getByText(/Removing a preference limit does not start work/)).toBeInTheDocument();
  });
  it.each(['unsupported', 'invalid', 'unavailable'] as const)('does not imply no limits for %s metadata', (state) => {
    const g = guard();
    render(<LeaderPreferencesPanel preferences={state === 'unsupported' ? undefined : { ...preferences, sourceState: state, maxFullRunsPerDay: null }} guard={g} dispatchEnabled />);
    fireEvent.click(screen.getByText('Leader preferences'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Leader preferences' })).not.toBeInTheDocument();
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });
  it('saves only an explicitly changed field without altering goal, cadence, focus or account choices', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxGrokLanes: null, defaulted: ['maxFullRunsPerDay', 'maxTotalRunsPerDay'] }));
    open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'No preference limit for parallel grok lanes' }));
    fireEvent.click(save()); await screen.findByText(/Leader preferences saved/);
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ leaderPreferences: { maxGrokLanes: null } });
    expect(save()).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Parallel Grok lanes' })).toBeDisabled();
    expect(screen.getByText(/Available accounts and execution slots/)).toBeInTheDocument();
    expect(screen.queryByText(/Current default: 4/)).not.toBeInTheDocument();
  });
  it('accepts a large safe number and refuses malformed input without writing', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxFullRunsPerDay: Number.MAX_SAFE_INTEGER }));
    open();
    for (const value of ['0', '3.5', '3junk', String(Number.MAX_SAFE_INTEGER + 1)]) {
      fireEvent.change(full(), { target: { value } }); fireEvent.click(save());
      expect(screen.getByRole('alert')).toHaveTextContent(/positive whole number/);
    }
    expect(updateVerseCaps).not.toHaveBeenCalled();
    fireEvent.change(full(), { target: { value: String(Number.MAX_SAFE_INTEGER) } }); fireEvent.click(save());
    await screen.findByText(/Leader preferences saved/);
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ leaderPreferences: { maxFullRunsPerDay: Number.MAX_SAFE_INTEGER } });
  });
  it('requires explicit finite input after removing a no-limit choice rather than guessing a default', () => {
    open({ ...preferences, maxTotalRunsPerDay: null });
    fireEvent.click(screen.getByRole('checkbox', { name: 'No preference limit for total runs per day' }));
    expect(screen.getByRole('textbox', { name: 'Total runs per day' })).toHaveValue('');
    fireEvent.click(save()); expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });
  it('deduplicates pending saves and preserves failed drafts for retry', async () => {
    let reject!: (err: Error) => void;
    vi.mocked(updateVerseCaps).mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
    open(); fireEvent.change(full(), { target: { value: '17' } }); fireEvent.click(save()); fireEvent.click(save());
    expect(save()).toBeDisabled(); expect(updateVerseCaps).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('Unavailable')));
    await screen.findByRole('alert'); expect(full()).toHaveValue('17'); expect(save()).not.toBeDisabled();
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxFullRunsPerDay: 17 }));
    fireEvent.click(save()); await screen.findByText(/Leader preferences saved/); expect(updateVerseCaps).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, { ...preferences, maxFullRunsPerDay: 2 }])('requires matching saved readback %s', async (next) => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response(next)); open();
    fireEvent.change(full(), { target: { value: '17' } }); fireEvent.click(save());
    await screen.findByRole('alert'); expect(screen.queryByText(/Leader preferences saved/)).not.toBeInTheDocument();
    expect(full()).toHaveValue('17');
  });
  it('retains dirty choices while refreshing untouched values and discards to latest saved readback', () => {
    const { rerender, guard: g } = open(); fireEvent.change(full(), { target: { value: '17' } });
    rerender(<LeaderPreferencesPanel preferences={{ ...preferences, maxFullRunsPerDay: 5, maxTotalRunsPerDay: 30 }} guard={g} dispatchEnabled />);
    expect(full()).toHaveValue('17'); expect(screen.getByRole('textbox', { name: 'Total runs per day' })).toHaveValue('30');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); expect(full()).toHaveValue('5');
    expect(save()).toBeDisabled(); expect(updateVerseCaps).not.toHaveBeenCalled();
  });
  it('refuses a deferred token save if the supported form has disappeared', async () => {
    let queued!: () => Promise<unknown>;
    const request: GuardedAction['request'] = (fn) => { queued = fn; };
    const { rerender, guard: g } = open(preferences, { request });
    fireEvent.change(full(), { target: { value: '17' } }); fireEvent.click(save());
    rerender(<LeaderPreferencesPanel preferences={undefined} guard={g} dispatchEnabled />);
    await expect(queued()).rejects.toThrow(/Review Leader preferences again/); expect(updateVerseCaps).not.toHaveBeenCalled();
  });
  it.each([{ readOnly: true }, { tokenOpen: true }, { busy: true }])('uses the existing shared mutation lock %s', (over) => {
    open(preferences, over); expect(full()).toBeDisabled(); expect(save()).toBeDisabled();
    fireEvent.click(save()); expect(updateVerseCaps).not.toHaveBeenCalled();
  });
  it('adopts a fresh server read reverting a previously confirmed POST value', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxFullRunsPerDay: 17 }));
    const { rerender, guard: g } = open(); fireEvent.change(full(), { target: { value: '17' } }); fireEvent.click(save());
    await screen.findByText(/Leader preferences saved/);
    rerender(<LeaderPreferencesPanel preferences={{ ...preferences }} guard={g} dispatchEnabled />);
    await waitFor(() => expect(full()).toHaveValue('3')); expect(save()).toBeDisabled();
  });
});

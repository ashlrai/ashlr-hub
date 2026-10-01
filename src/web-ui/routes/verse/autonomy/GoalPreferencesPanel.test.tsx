import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GoalPreferencesPanel } from './GoalPreferencesPanel.js';
import { updateVerseCaps } from './control-queries.js';
import type { VerseCaps, VerseCapsApplyResult } from './control-types.js';
import type { GoalPreferences } from './goal-preferences-spec.js';
import type { GuardedAction } from './use-guarded-action.js';

vi.mock('./control-queries.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./control-queries.js')>(), updateVerseCaps: vi.fn(),
}));

const preferences: GoalPreferences = {
  maxOpenGoals: 4, maxNewGoalsPerDay: 3, maxGoalProposalsPerMemo: 3, maxGoalsPerConductorCycle: 3,
  sourceState: 'ready', errors: [], defaulted: ['maxOpenGoals', 'maxNewGoalsPerDay', 'maxGoalProposalsPerMemo', 'maxGoalsPerConductorCycle'],
  protocol: { maxMemoActions: 24, maxMemoRawChars: 256 * 1024 },
};

function response(next: GoalPreferences | undefined, focusMode?: boolean): VerseCapsApplyResult {
  return { ok: true, applied: ['goalPreferences'], live: true, caps: {
    dailyBudgetUsd: 25, perTickItems: 4, parallel: 2, intervalMs: 900_000, mode: 'batch', maxConcurrent: 8,
    concurrency: { local: 2, cloud: 6, total: 8 }, subscriptionMaxPercent: 80, foundryLimits: [], defaulted: [],
    ...(next ? { goalPreferences: next } : {}),
    ...(focusMode === undefined ? {} : { goalFocusMode: focusMode, goalFocusActiveThreshold: 4 }),
  } satisfies VerseCaps };
}

function guard(over: Partial<GuardedAction> = {}): GuardedAction {
  const request: GuardedAction['request'] = (fn, _reason, onResult) => { void fn().then((result) => onResult?.(result)).catch(() => {}); };
  return {
    request,
    busy: false, error: null, clearError: vi.fn(), readOnly: false, tokenOpen: false, tokenReason: '', closeToken: vi.fn(), ...over,
  };
}
const save = () => screen.getByRole('button', { name: 'Save goal preferences' });
const active = () => screen.getByRole('textbox', { name: 'Active goals' });
function renderExpanded(element: ReactElement) {
  const view = render(element);
  fireEvent.click(screen.getByText('Goal preferences'));
  return view;
}
afterEach(() => vi.clearAllMocks());

describe('GoalPreferencesPanel', () => {
  it('keeps advanced choices in an optional disclosure without starting work', () => {
    render(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    const disclosure = screen.getByText('Goal preferences').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Goal preferences'));
    expect(disclosure).toHaveAttribute('open');
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });
  it('shows actual defaults, no automatic mutation and no unsupported-server no-limit claim', () => {
    const { rerender } = renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    expect(active()).toHaveValue('4');
    expect(screen.getByText(/Current default: 4/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(updateVerseCaps).not.toHaveBeenCalled();
    rerender(<GoalPreferencesPanel preferences={undefined} guard={guard()} dispatchEnabled />);
    expect(screen.getByText(/unavailable from this server/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save goal preferences' })).not.toBeInTheDocument();
  });

  it.each(['invalid', 'unavailable'] as const)('holds %s source without presenting a null as uncapped', (sourceState) => {
    renderExpanded(<GoalPreferencesPanel preferences={{ ...preferences, maxOpenGoals: null, sourceState }} guard={guard()} dispatchEnabled />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });

  it('saves only an explicit changed no-limit field and adopts confirmed server values', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxOpenGoals: null, defaulted: preferences.defaulted.filter((key) => key !== 'maxOpenGoals') }));
    renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'No preference limit for active goals' }));
    expect(active()).toBeDisabled();
    fireEvent.click(save());
    await screen.findByText(/Goal preferences saved/);
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ goalPreferences: { maxOpenGoals: null } });
    expect(save()).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'New goals per day' })).toHaveValue('3');
    expect(screen.queryByText(/Current default: 4/)).not.toBeInTheDocument();
  });

  it('keeps the separate finishing preference when the active-goal preference becomes unlimited', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxOpenGoals: null }, true));
    renderExpanded(<GoalPreferencesPanel preferences={preferences} focusMode focusThreshold={4} focusDefaulted guard={guard()} dispatchEnabled />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'No preference limit for active goals' }));
    fireEvent.click(save()); await screen.findByText(/Goal preferences saved/);
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ goalPreferences: { maxOpenGoals: null } });
    expect(screen.getByRole('checkbox', { name: 'Prefer finishing current work before expanding' })).toBeChecked();
    expect(screen.getByText(/separate from the active-goal limit/)).toBeInTheDocument();
  });

  it('saves an explicitly disabled finishing preference without materializing numeric defaults', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response(preferences, false));
    renderExpanded(<GoalPreferencesPanel preferences={preferences} focusMode focusThreshold={4} guard={guard()} dispatchEnabled />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Prefer finishing current work before expanding' }));
    fireEvent.click(save()); await screen.findByText(/Goal preferences saved/);
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ goalFocusMode: false });
    expect(screen.getByRole('checkbox', { name: 'Prefer finishing current work before expanding' })).not.toBeChecked();
  });

  it('adopts newly supported finishing data without silently staging an off choice', () => {
    const { rerender } = renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    expect(screen.getByText(/finishing preference is unavailable/)).toBeInTheDocument();
    rerender(<GoalPreferencesPanel preferences={preferences} focusMode focusThreshold={4} guard={guard()} dispatchEnabled />);
    expect(screen.getByRole('checkbox', { name: 'Prefer finishing current work before expanding' })).toBeChecked();
    expect(save()).toBeDisabled(); expect(updateVerseCaps).not.toHaveBeenCalled();
  });

  it('accepts a large safe preference and re-adopts a fresh server read even when it returns the original value', async () => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxOpenGoals: Number.MAX_SAFE_INTEGER }));
    const { rerender } = renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    fireEvent.change(active(), { target: { value: String(Number.MAX_SAFE_INTEGER) } }); fireEvent.click(save());
    await screen.findByText(/Goal preferences saved/);
    expect(active()).toHaveValue(String(Number.MAX_SAFE_INTEGER));
    expect(updateVerseCaps).toHaveBeenCalledExactlyOnceWith({ goalPreferences: { maxOpenGoals: Number.MAX_SAFE_INTEGER } });
    rerender(<GoalPreferencesPanel preferences={{ ...preferences }} guard={guard()} dispatchEnabled />);
    expect(active()).toHaveValue('4'); expect(screen.queryByText(/Goal preferences saved/)).not.toBeInTheDocument();
  });

  it('refuses blank, fractional and unsafe input before network and retains it for correction', () => {
    renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    for (const text of ['', '0', '17.5', '17junk', String(Number.MAX_SAFE_INTEGER + 1)]) {
      fireEvent.change(active(), { target: { value: text } }); fireEvent.click(save());
      expect(active()).toHaveValue(text);
      expect(active()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('alert')).toHaveTextContent(/positive whole number/);
    }
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });

  it('locks pending edits and avoids repeated dispatch, then retains failed choices for retry', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(updateVerseCaps).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    fireEvent.change(active(), { target: { value: '17' } }); fireEvent.click(save());
    await waitFor(() => expect(active()).toBeDisabled());
    fireEvent.click(save());
    expect(updateVerseCaps).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('Connection failed. Try again.')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Connection failed');
    expect(active()).toHaveValue('17'); expect(active()).not.toBeDisabled();
    expect(screen.queryByText(/Goal preferences saved/)).not.toBeInTheDocument();
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response({ ...preferences, maxOpenGoals: 17 }));
    fireEvent.click(save()); await screen.findByText(/Goal preferences saved/);
    expect(updateVerseCaps).toHaveBeenNthCalledWith(2, { goalPreferences: { maxOpenGoals: 17 } });
  });

  it.each([undefined, { ...preferences, maxOpenGoals: 4 }])('does not call a missing or mismatched readback saved', async (next) => {
    vi.mocked(updateVerseCaps).mockResolvedValueOnce(response(next));
    renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    fireEvent.change(active(), { target: { value: '17' } }); fireEvent.click(save());
    await screen.findByRole('alert');
    expect(active()).toHaveValue('17'); expect(screen.queryByText(/Goal preferences saved/)).not.toBeInTheDocument();
  });

  it('refreshes untouched server values while preserving a dirty goal preference', () => {
    const { rerender } = renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled />);
    fireEvent.change(active(), { target: { value: '17' } });
    rerender(<GoalPreferencesPanel preferences={{ ...preferences, maxOpenGoals: 6, maxNewGoalsPerDay: 9 }} guard={guard()} dispatchEnabled />);
    expect(active()).toHaveValue('17'); expect(screen.getByRole('textbox', { name: 'New goals per day' })).toHaveValue('9');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(active()).toHaveValue('6');
  });

  it('uses existing read-only and token-pending gates', () => {
    const { rerender } = renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={guard()} dispatchEnabled={false} />);
    expect(active()).toBeDisabled(); expect(screen.getByText(/connection is read-only/)).toBeInTheDocument();
    rerender(<GoalPreferencesPanel preferences={preferences} guard={guard({ tokenOpen: true })} dispatchEnabled />);
    expect(active()).toBeDisabled();
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });

  it('does not execute a deferred token action after its supported form disappears', async () => {
    let queued: (() => Promise<unknown>) | undefined;
    const action = guard({ request: (fn) => { queued = fn; } });
    const { rerender } = renderExpanded(<GoalPreferencesPanel preferences={preferences} guard={action} dispatchEnabled />);
    fireEvent.change(active(), { target: { value: '17' } }); fireEvent.click(save());
    expect(queued).toBeDefined();
    rerender(<GoalPreferencesPanel preferences={undefined} guard={action} dispatchEnabled />);
    await expect(queued!()).rejects.toThrow('Review goal preferences again');
    expect(updateVerseCaps).not.toHaveBeenCalled();
  });
});

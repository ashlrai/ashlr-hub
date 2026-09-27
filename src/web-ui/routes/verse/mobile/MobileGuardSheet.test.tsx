/**
 * The phone's confirmation sheet: consequences first, the token only after
 * Confirm, a refused step-up sends nothing, a failure comes back to the sheet
 * with the server's sentence, and a no-confirm action skips straight to run.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, hasMutationHold, setMutationToken } from '../../../data/auth-store.js';
import { ApiError } from '../../../data/client.js';
import { resetGuard } from '../shell/guard-store.js';
import { registerStepUpProvider } from './device-permissions.js';
import { runMobileAction } from './mobile-actions.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { MobileGuardSheet } from './MobileGuardSheet.js';
import { TOKEN } from './mobile.test-support.js';

function mount() {
  return render(
    <>
      <MobileGuardSheet />
      <MobileToasts />
    </>,
  );
}

beforeEach(() => {
  resetGuard();
  resetMobileToastsForTest();
  clearMutationToken();
});

afterEach(() => {
  registerStepUpProvider(null);
  resetGuard();
  clearMutationToken();
});

const LAND = {
  title: 'Land this PR?',
  consequences: 'Merges PR #12 into main on your Mac. This can’t be undone from the phone.',
  confirmLabel: 'Land',
};

describe('MobileGuardSheet', () => {
  it('shows what will happen, then asks for the token only after Confirm, then runs', async () => {
    const run = vi.fn(async () => undefined);
    mount();
    act(() => {
      runMobileAction({ ...LAND, run, success: 'Landed' });
    });
    const sheet = screen.getByRole('alertdialog', { name: 'Land this PR?' });
    expect(within(sheet).getByText(/Merges PR #12/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mutation token')).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Land' }));
    const unlock = await screen.findByRole('dialog', { name: 'Unlock actions' });
    fireEvent.change(within(unlock).getByLabelText('Mutation token'), { target: { value: TOKEN } });
    fireEvent.click(within(unlock).getByRole('button', { name: 'Unlock and land' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(hasMutationHold()).toBe(true);
    expect(await screen.findByText('Landed')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Cancel sends nothing', () => {
    const run = vi.fn(async () => undefined);
    mount();
    act(() => {
      runMobileAction({ ...LAND, run });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('a refused step-up (the transport seam) keeps the sheet and sends nothing', async () => {
    setMutationToken(TOKEN);
    registerStepUpProvider(async () => false);
    const run = vi.fn(async () => undefined);
    mount();
    act(() => {
      runMobileAction({ ...LAND, run });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
    expect(await screen.findByText(/could not confirm it is you/)).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('a failure comes back with the server’s sentence, and Try again retries', async () => {
    setMutationToken(TOKEN);
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ApiError('POST failed', 409, '/api/x', 'The PR changed since you looked. Refresh and try again.'))
      .mockResolvedValueOnce(undefined);
    mount();
    act(() => {
      runMobileAction({ ...LAND, run });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
    expect(await screen.findByText('The PR changed since you looked. Refresh and try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('a no-confirm action with the token held runs at once; its failure is a toast', async () => {
    setMutationToken(TOKEN);
    const run = vi.fn(async () => {
      throw new ApiError('nope', 500, '/api/x', 'The Mac refused.');
    });
    mount();
    act(() => {
      runMobileAction({ title: 'Send', consequences: '', confirmLabel: 'Send', confirm: false, run });
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText('The Mac refused.')).toBeInTheDocument();
  });
});

/**
 * More on the phone: what this device may do (lock drops the hold, unlock
 * opens the one token sheet), the rows that go elsewhere, the theme chips,
 * the desktop layout, Home Screen install help, the connection with a
 * confirmed sign-out, and the version.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSE_LAYOUT_STORAGE_KEY } from '../../../../app/console-mode.js';
import { clearMutationToken, getMutationToken, hasMutationHold, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { getTheme, setTheme } from '../../../../data/theme-store.js';
import { APP_VERSION } from '../../sections/app-version.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { activityState, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { MoreScreen } from './MoreScreen.js';

function mount(overrides: Parameters<typeof renderMobile>[1] = {}) {
  return renderMobile(
    <>
      <MoreScreen />
      <MobileGuardSheet />
      <MobileToasts />
    </>,
    overrides,
  );
}

beforeEach(() => {
  setMutationToken(TOKEN);
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetMobileToastsForTest();
  setTheme('system');
  try {
    window.localStorage.removeItem(VERSE_LAYOUT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MoreScreen — this device', () => {
  it('unlocked: says until when, and Lock now drops the hold', async () => {
    mount({ permissions: permissionsFor('unlocked') });
    expect(screen.getByText('Unlocked')).toBeInTheDocument();
    expect(screen.getByText(/Actions stay unlocked until/)).toBeInTheDocument();
    expect(screen.getByText('This browser session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    expect(hasMutationHold()).toBe(false);
    expect(await screen.findByText('Actions locked')).toBeInTheDocument();
  });

  it('locked: Unlock opens the token sheet and holds the token', async () => {
    clearMutationToken();
    mount({ permissions: permissionsFor('locked') });
    expect(screen.getByText('Locked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Mutation token'), { target: { value: TOKEN } });
      fireEvent.click(screen.getByRole('button', { name: 'Unlock and continue' }));
    });
    expect(getMutationToken()).toBe(TOKEN);
    expect(await screen.findByText('Actions unlocked')).toBeInTheDocument();
  });

  it('unavailable: says why, and offers neither lock nor unlock nor New agent', () => {
    mount({ permissions: { ...permissionsFor('unavailable'), source: 'device', deviceLabel: 'Mason’s iPhone' } });
    expect(screen.getByText('Not on this device')).toBeInTheDocument();
    expect(screen.getByText('Your Mac started Verse without dispatch.')).toBeInTheDocument();
    expect(screen.getByText('Mason’s iPhone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lock now|Unlock/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New agent/ })).not.toBeInTheDocument();
  });
});

describe('MoreScreen — rows and settings', () => {
  it('goes to Fleet, New agent and Needs you', () => {
    const { context } = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Fleet/ }));
    fireEvent.click(screen.getByRole('button', { name: /^New agent/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    expect(context.navigate).toHaveBeenNthCalledWith(1, { screen: 'fleet' });
    expect(context.navigate).toHaveBeenNthCalledWith(2, { screen: 'new' });
    expect(context.navigate).toHaveBeenNthCalledWith(3, { screen: 'needs' });
  });

  it('theme chips set the shared theme', () => {
    mount();
    const system = screen.getByRole('button', { name: 'System' });
    expect(system).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(getTheme()).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(system).toHaveAttribute('aria-pressed', 'false');
  });

  it('the desktop layout remembers the choice and opens the workbench', () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
    try {
      mount();
      fireEvent.click(screen.getByRole('button', { name: /Use the desktop layout/ }));
      expect(window.localStorage.getItem(VERSE_LAYOUT_STORAGE_KEY)).toBe('desktop');
      expect(assign).toHaveBeenCalledWith('/verse/');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('explains installing on the Home Screen, or says it is installed', async () => {
    mount();
    expect(await screen.findByText(/tap Share, then Add to Home Screen/)).toBeInTheDocument();
    expect(screen.getByText(/Install app/)).toBeInTheDocument();
  });

  it('says it is installed when running from the Home Screen', async () => {
    Object.defineProperty(window.navigator, 'standalone', { configurable: true, value: true });
    try {
      mount();
      expect(await screen.findByText(/Installed — Verse is running from your Home Screen/)).toBeInTheDocument();
    } finally {
      Object.defineProperty(window.navigator, 'standalone', { configurable: true, value: undefined });
    }
  });

  it('shows the version', () => {
    mount();
    expect(screen.getByText(`Version ${APP_VERSION}`)).toBeInTheDocument();
  });
});

describe('MoreScreen — connection', () => {
  it('distinguishes an offline first load from an offline page with a prior update', () => {
    const view = mount({ reachability: 'offline', activity: activityState(null, 'unavailable') });
    expect(screen.getByText('This phone has no network. No update yet.')).toBeInTheDocument();
    view.unmount();
    mount({ reachability: 'offline' });
    expect(screen.getByText('This phone has no network. The last update stays on screen.')).toBeInTheDocument();
  });

  it('says when the Mac is out of reach', () => {
    mount({ reachability: 'unreachable' });
    expect(screen.getByText('Can’t reach your Mac')).toBeInTheDocument();
  });

  it('signs out only after a sheet that says what it means', async () => {
    const stub = stubFetch({ 'DELETE /api/session': { ok: true } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Sign out of this device?' });
    expect(sheet).toHaveTextContent('Signs this phone out. You’ll need the read token again.');
    expect(stub.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(stub.calls.map((c) => [c.method, c.url])).toEqual([['DELETE', '/api/session']]));
    expect(hasMutationHold()).toBe(false);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('cancel leaves the session alone', async () => {
    const stub = stubFetch({});
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });
});

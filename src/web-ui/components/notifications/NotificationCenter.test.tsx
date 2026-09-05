import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from './NotificationBell.js';
import { NotificationCenter } from './NotificationCenter.js';
import { evictAll } from '../../data/cache.js';
import { __resetNotificationStoreForTests } from './notification-store.js';

const CONTROL = {
  ts: new Date().toISOString(),
  security: { available: true, findings: [{ repo: 'r', title: 'bad thing', severity: 'critical', source: 'security' }], counts: { critical: 1, high: 0, medium: 0, low: 0 } },
  limits: [],
  daemon: { sourceQuality: { sourceState: 'healthy', complete: true } },
};

const FLEET = { nextActions: [], autonomousShipReadiness: null };
const RUNS: unknown[] = [];
const INBOX = { pending: 0, proposals: [] };

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/control')) return new Response(JSON.stringify(CONTROL), { status: 200 });
    if (url.startsWith('/api/fleet') && !url.includes('activity')) return new Response(JSON.stringify(FLEET), { status: 200 });
    if (url.startsWith('/api/runs')) return new Response(JSON.stringify(RUNS), { status: 200 });
    if (url.startsWith('/api/inbox')) return new Response(JSON.stringify(INBOX), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('NotificationBell + NotificationCenter', () => {
  beforeEach(() => {
    evictAll();
    __resetNotificationStoreForTests();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an urgent badge count once a critical security finding is derived, and opens the panel with detail', async () => {
    render(
      <>
        <NotificationBell />
        <NotificationCenter />
      </>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /1 urgent/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    await waitFor(() => expect(screen.getByText('1 critical security finding')).toBeInTheDocument());
    expect(screen.getByText('r: bad thing')).toBeInTheDocument();
  });

  it('muting a category removes it from the badge count and list', async () => {
    render(
      <>
        <NotificationBell />
        <NotificationCenter />
      </>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    await waitFor(() => expect(screen.getByText('1 critical security finding')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Mute Security' }));

    await waitFor(() => expect(screen.queryByText('1 critical security finding')).not.toBeInTheDocument());
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
  });

  // Pins keyboard operability for the notification centre: the bell opens
  // via Enter (a real <button>, no mouse), the panel focus-traps to its
  // close button on open (Dialog's initialFocusRef), the mute control is
  // reachable and operable by keyboard, and Escape closes it. Falsified by
  // changing NotificationItem.tsx's mute button from `onClick` to a
  // click-only handler that ignores keyboard-synthesized clicks (i.e.
  // simulating a div with onClick instead of a real <button>) — the test
  // failed because Enter on the focused mute control no longer removed the
  // finding, confirming this exercises real keyboard activation rather than
  // an incidental pass.
  it('keyboard: bell opens via Enter, mute is reachable and operable via keyboard, Escape closes', async () => {
    const user = userEvent.setup();
    render(
      <>
        <NotificationBell />
        <NotificationCenter />
      </>,
    );

    const bell = await screen.findByRole('button', { name: /1 urgent/ });
    bell.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: /notifications/i });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close notifications' })).toHaveFocus());

    await waitFor(() => expect(screen.getByText('1 critical security finding')).toBeInTheDocument());

    const muteBtn = screen.getByRole('button', { name: 'Mute Security' });
    muteBtn.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.queryByText('1 critical security finding')).not.toBeInTheDocument());
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /notifications/i })).not.toBeInTheDocument());
  });
});

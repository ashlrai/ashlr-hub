/**
 * Shell tests: the 56px rail, the five lazily-mounted sections, and the
 * global shortcuts. The chat surface itself is covered in
 * sections/ChatSection.test.tsx — this file only asserts that the shell
 * mounts it and gets out of the way.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { MockEventSource, verseFetch } from './fixtures.test-support.js';
import { MissingSection, VerseApp } from './VerseApp.js';
import { resetVerseStore } from './verse-store.js';
import { resetVerseUi, setVersePendingApprovals } from './verse-ui-store.js';

/** verseFetch's mock is typed loosely; this is the shape we actually delegate to. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mount() {
  return render(<ToastProvider><VerseApp /></ToastProvider>);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', verseFetch().fetch);
  markCheckComplete(true);
});
afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('VerseApp shell', () => {
  it('renders the five rail sections and mounts Chat first', async () => {
    mount();
    const rail = screen.getByRole('navigation', { name: 'Verse sections' });
    for (const label of ['Chat', 'Autonomy', 'Approvals', 'Usage', 'Settings']) {
      expect(within(rail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(rail).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
    // The Chat module exists, so it actually mounts (its own nav shows up).
    await screen.findByRole('navigation', { name: 'Chats' });
  });

  it('switches sections by click and by ⌘1–⌘5, mounting exactly one at a time', async () => {
    const user = userEvent.setup();
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const slot = () => view.container.querySelector('[data-section]:not(button)')!;

    await user.click(screen.getByRole('button', { name: 'Autonomy' }));
    expect(screen.getByRole('button', { name: 'Autonomy' })).toHaveAttribute('aria-current', 'page');
    expect(slot()).toHaveAttribute('data-section', 'autonomy');
    // Chat is unmounted, not hidden — a section owns its own polling and streams.
    expect(screen.queryByRole('navigation', { name: 'Chats' })).not.toBeInTheDocument();

    act(() => { fireEvent.keyDown(document, { key: '4', metaKey: true }); });
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');
    expect(slot()).toHaveAttribute('data-section', 'usage');

    act(() => { fireEvent.keyDown(document, { key: '1', metaKey: true }); });
    await screen.findByRole('navigation', { name: 'Chats' });
  });

  it('explains a rail slot whose module has not landed instead of going blank', () => {
    // Rendered directly: which sections exist changes as the other owners land
    // theirs, so the state is tested on its own rather than through whichever
    // module happens to be missing today.
    render(<MissingSection label="Settings" moduleName="SettingsSection" detail="boom" />);
    expect(screen.getByRole('status')).toHaveTextContent('Settings is not wired up yet');
    expect(screen.getByText('routes/verse/sections/SettingsSection.tsx')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('⌘, opens Settings and the active section survives a remount (ashlr.verse.ui.v2)', async () => {
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { fireEvent.keyDown(document, { key: ',', metaKey: true }); });
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(JSON.parse(localStorage.getItem('ashlr.verse.ui.v2') ?? '{}')).toMatchObject({ section: 'settings' });

    view.unmount();
    mount();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('⌘N and ⌘K come back to Chat and reach the chat surface', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { fireEvent.keyDown(document, { key: '5', metaKey: true }); });
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');

    act(() => { fireEvent.keyDown(document, { key: 'n', metaKey: true }); });
    expect(await screen.findByRole('dialog', { name: 'New chat' })).toBeInTheDocument();

    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
    expect(await screen.findByRole('dialog', { name: 'Switch chat' })).toBeInTheDocument();
  });

  it('publishes the pending-approval count from the shell, so the badge is right on any section', async () => {
    // The badge exists to be seen while you are NOT in Approvals, so the
    // count cannot come from ApprovalsSection's own mount. The shell reads
    // /api/inbox itself, through the same QueryDef the section uses.
    const base = verseFetch().fetch as unknown as FetchLike;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input.toString();
      if (path.startsWith('/api/inbox')) {
        return new Response(JSON.stringify({ pending: 4, items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return base(input, init);
    }));

    mount();

    // Still on Chat — the badge is published anyway.
    const rail = screen.getByRole('navigation', { name: 'Verse sections' });
    expect(within(rail).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
    const flagged = await screen.findByRole('button', { name: 'Approvals, 4 pending' });
    expect(flagged.querySelector('[data-pending="4"]')).not.toBeNull();
  });

  it('leaves the badge alone when the inbox read fails, rather than flashing a false all-clear', async () => {
    act(() => setVersePendingApprovals(2));
    const base = verseFetch().fetch as unknown as FetchLike;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input.toString();
      if (path.startsWith('/api/inbox')) return new Response('nope', { status: 500 });
      return base(input, init);
    }));

    mount();
    await screen.findByRole('navigation', { name: 'Chats' });

    // A failed count must not be reported as zero pending.
    expect(screen.getByRole('button', { name: 'Approvals, 2 pending' })).toBeInTheDocument();
  });

  it('shows a dot on Approvals only while a section reports pending items', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    expect(screen.getByRole('button', { name: 'Approvals' })).toBeInTheDocument();

    act(() => setVersePendingApprovals(3));
    const flagged = screen.getByRole('button', { name: 'Approvals, 3 pending' });
    expect(flagged.querySelector('[data-pending="3"]')).not.toBeNull();

    act(() => setVersePendingApprovals(0));
    expect(screen.getByRole('button', { name: 'Approvals' }).querySelector('[data-pending]')).toBeNull();
  });
});

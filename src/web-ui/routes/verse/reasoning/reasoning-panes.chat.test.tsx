/**
 * reasoning/reasoning-panes.chat.test.tsx — in the real chat surface, ⇧⌘S and
 * ⇧⌘Y open THIS unit's Sources and Reasoning panes (registered over the
 * first-party stubs by reasoning.pane.tsx), and the transcript's own toggles
 * open the same dock panes rather than a sheet of their own.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { VerseEvent } from '../../../data/api-types.js';
import { resetChatPanelSizing } from '../chat-panel-sizing.js';
import { resetLocalSeen } from '../chat/use-chat-activity.js';
import { getDockSnapshot, resetDockStore } from '../dock/dock-store.js';
import { ev, MockEventSource, session, verseFetch } from '../fixtures.test-support.js';
import { ChatSection, preloadChatSurface } from '../sections/ChatSection.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { setFocusMode } from '../shell/focus-mode.js';
import { resetVerseStore } from '../verse-store.js';
import { resetVerseUi } from '../verse-ui-store.js';

const EVENTS: VerseEvent[] = [
  ev(1, 'user-message', { turnId: 't1', text: 'Where is the login check?' }),
  ev(2, 'thinking', { turnId: 't1', text: 'Start from the auth middleware.', durationMs: 3000, kind: 'summary' }),
  ev(3, 'tool-use', { turnId: 't1', toolUseId: 'r1', name: 'Read', input: { file_path: '/Users/mason/dev/hub/src/auth.ts', offset: 5, limit: 20 } }),
  ev(4, 'tool-result', { turnId: 't1', toolUseId: 'r1', output: 'export function check() {}', isError: false }),
  ev(5, 'assistant-message', { turnId: 't1', text: 'It is in auth.ts.' }),
  ev(6, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 4000 }),
];

beforeAll(() => preloadChatSurface());

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  resetDockStore();
  resetLocalSeen();
  resetCommandBus();
  resetChatPanelSizing();
  setFocusMode(false);
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});
afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function openChat() {
  const { fetch } = verseFetch({ details: { vs_1: { session: session(), events: EVENTS } } });
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<ToastProvider><ChatSection /></ToastProvider>);
  await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
  await screen.findByText('It is in auth.ts.');
  return user;
}

describe('Sources and Reasoning panes in the chat', () => {
  it('⇧⌘S opens the Sources pane — this unit’s, not the stub', async () => {
    await openChat();
    // jsdom reports no macOS platform, so the catalog's "mod" is Ctrl here.
    fireEvent.keyDown(document.body, { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true });
    expect(getDockSnapshot().state).toMatchObject({ open: true, active: 'sources' });
    const pane = await screen.findByRole('complementary', { name: 'Dock: Sources' });
    expect(await within(pane).findByRole('searchbox', { name: 'Filter sources' })).toBeInTheDocument();
    expect(within(pane).getByText(':5-24')).toBeInTheDocument();
  });

  it('⇧⌘Y opens the Reasoning pane with the turn and what it did', async () => {
    await openChat();
    fireEvent.keyDown(document.body, { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true });
    expect(getDockSnapshot().state).toMatchObject({ open: true, active: 'reasoning' });
    const pane = await screen.findByRole('complementary', { name: 'Dock: Reasoning' });
    expect(await within(pane).findByRole('button', { name: /Turn 1: Where is the login check\?/ })).toBeInTheDocument();
    expect(within(pane).getByText('Read 1 file')).toBeInTheDocument();
  });

  it('the transcript’s Sources toggle opens the dock pane, and reflects it', async () => {
    const user = await openChat();
    const toggle = screen.getByRole('button', { name: /^Sources/, pressed: false });
    await user.click(toggle);
    expect(getDockSnapshot().state).toMatchObject({ open: true, active: 'sources' });
    expect(await screen.findByRole('complementary', { name: 'Dock: Sources' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sources/, pressed: true })).toBe(toggle);
    // No transcript-hosted sheet when the dock took it.
    expect(screen.queryByRole('complementary', { name: 'Reasoning and sources for this chat' })).toBeNull();
  });
});

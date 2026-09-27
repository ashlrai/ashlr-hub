/**
 * 3.15 — the Terminal panel is the dock's Terminal, through the pane
 * REGISTRY (panes/index.ts discovers terminal/terminal.pane.tsx): rendered, in the
 * real Chat surface, ⌃` opens THIS panel — its Agent tab is the tell — and
 * the registration replaced the first-party stub, keeping its key and toggle.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource, verseFetch } from '../fixtures.test-support.js';
import { resetVerseStore } from '../verse-store.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { getDockSnapshot, resetDockStore } from '../dock/dock-store.js';
import { resetChatPanelSizing } from '../chat-panel-sizing.js';
import { resetLocalSeen } from '../chat/use-chat-activity.js';
import { ChatSection, preloadChatSurface } from '../sections/ChatSection.js';
import { DISCOVERED_PANE_MODULES, getPane } from '../panes/index.js';
import { TerminalPaneBody } from '../panes/builtin/SlotPanes.js';
import { resetTerminalPanelForTest } from './TerminalPanel.js';

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
  resetTerminalPanelForTest();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});
afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

/** The chat fixtures, plus a terminal server with no PTY (as under Node) — the panel still draws. */
function stubFetch() {
  const { fetch } = verseFetch();
  const terminalCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    if (path.startsWith('/api/verse/terminal')) {
      terminalCalls.push(`${init?.method ?? 'GET'} ${path}`);
      return new Response(JSON.stringify({ available: false, reason: 'needs the desktop app', tabs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return (fetch as unknown as typeof globalThis.fetch)(input, init);
  }));
  return { terminalCalls };
}

describe('Terminal through the pane registry', () => {
  it('replaces the first-party Terminal, keeping its ⌃` key, header toggle, place and chat requirement', () => {
    expect(Object.keys(DISCOVERED_PANE_MODULES)).toContain('../terminal/terminal.pane.tsx');
    const pane = getPane('terminal')!;
    expect(pane.component).not.toBe(TerminalPaneBody);
    expect(pane).toMatchObject({ title: 'Terminal', command: 'dock.terminal', toggle: true, order: 10, needsSession: true });
  });

  it('⌃` in a chat opens THIS terminal panel (tabs, Agent tab), loaded on demand', async () => {
    const { terminalCalls } = stubFetch();
    const user = userEvent.setup();
    render(<ToastProvider><ChatSection /></ToastProvider>);
    await user.click(await screen.findByRole('button', { name: /Fix the login bug/ }));
    await screen.findByRole('heading', { name: 'Fix the login bug' });
    // Nothing of the terminal has asked the server anything yet: it is lazy.
    expect(terminalCalls).toEqual([]);

    fireEvent.keyDown(document.body, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(getDockSnapshot().state).toMatchObject({ open: true, active: 'terminal' });
    const dock = await screen.findByRole('complementary', { name: 'Dock: Terminal' });
    // The 3.15 panel's own strip: the read-only Agent tab, and (no PTY here) its fallback copy.
    const agentTab = await within(dock).findByRole('tab', { name: /Agent/ }, { timeout: 5_000 });
    expect(agentTab).toHaveTextContent('read-only');
    expect(within(dock).getByTestId('agent-terminal')).toBeInTheDocument();
    expect(terminalCalls[0]).toBe('GET /api/verse/terminal');

    // Pressed again, ⌃` hides it (the stub's toggle, inherited).
    fireEvent.keyDown(document.body, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(getDockSnapshot().state.open).toBe(false);
  });
});

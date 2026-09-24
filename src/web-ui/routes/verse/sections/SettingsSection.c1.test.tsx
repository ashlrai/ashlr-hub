/**
 * Settings ▸ Chat / Desktop / Keyboard — the 3.10 panels (unit C1).
 *
 *   - Chat writes C2's reasoning preference (and never keeps its own copy),
 *     and C3's new-chat defaults through the token dialog;
 *   - Desktop renders from what the desktop app REPORTS (C8), never from what
 *     was asked: a chord another app holds shows as not active, with why;
 *     an unsigned build says banners come from Script Editor; a browser says
 *     it needs the desktop app and offers no switch;
 *   - Keyboard is the catalog's own table (it cannot drift from the keys);
 *   - the page holds at 375 in dark mode.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopStateForTests, type DesktopState } from '../../../app/desktop-shell.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { getReasoningDisplay, resetReasoningDisplay } from '../chat/reasoning-pref.js';
import { mockCompactViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { SettingsSection } from './SettingsSection.js';

const TOKEN = 'b'.repeat(64);

function renderSettings() {
  return render(<ToastProvider><SettingsSection /></ToastProvider>);
}

function desktopState(over: { hotkey?: Partial<DesktopState['hotkey']>; notifications?: Partial<DesktopState['notifications']> } = {}): DesktopState {
  return {
    hotkey: { enabled: false, registered: false, accelerator: '⌃⌥Space', error: null, ...over.hotkey },
    notifications: { enabled: true, delivery: 'native', ...over.notifications },
  };
}

/** A fake of C8's injected bridge: `setPreference` records, and native answers later via the state event. */
function installBridge(initial: DesktopState) {
  let current = initial;
  const setPreference = vi.fn((_name: string, _value: boolean) => true);
  document.documentElement.setAttribute('data-app-shell', 'desktop');
  (window as { __ASHLR_DESKTOP__?: unknown }).__ASHLR_DESKTOP__ = { getState: () => ({ ...current }), setPreference };
  return {
    setPreference,
    answer(next: DesktopState) {
      current = next;
      act(() => { window.dispatchEvent(new CustomEvent('ashlr:desktop-state', { detail: next })); });
    },
  };
}

interface Defaults { global: Record<string, string>; seats: Record<string, Record<string, string>> }

function serverWith(defaults: Defaults | number) {
  const posts: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    if (path === '/api/verse/session-controls/defaults') {
      if ((init?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, string | null>;
        posts.push(body);
        if (typeof defaults === 'number') return new Response('{}', { status: defaults });
        if (body['permissionMode']) defaults.global['permissionMode'] = body['permissionMode'];
        if (body['effort'] === null) delete defaults.global['effort'];
        else if (body['effort']) defaults.global['effort'] = body['effort'];
        return new Response(JSON.stringify(defaults), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (typeof defaults === 'number') return new Response(JSON.stringify({ error: 'nope' }), { status: defaults });
      return new Response(JSON.stringify(defaults), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posts };
}

const panel = (name: string) => screen.getAllByRole('heading', { name })[0]!.closest('section')!;

let viewport: ViewportMock | null = null;

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetReasoningDisplay();
  resetDesktopStateForTests();
  clearMutationToken();
  serverWith({ global: {}, seats: {} });
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
  vi.unstubAllGlobals();
  resetDesktopStateForTests();
  clearMutationToken();
  delete (window as { __ASHLR_DESKTOP__?: unknown }).__ASHLR_DESKTOP__;
  document.documentElement.removeAttribute('data-app-shell');
  document.documentElement.removeAttribute('data-theme');
});

describe('Settings ▸ Chat', () => {
  it('Reasoning writes the transcript’s own preference', async () => {
    const user = userEvent.setup();
    renderSettings();
    // The Keyboard table has a "Chat" section too: the panel comes first.
    const chat = panel('Chat');
    await user.click(within(chat).getByRole('radio', { name: 'Hidden' }));
    expect(getReasoningDisplay()).toBe('hidden');
    expect(within(chat).getByText(/No reasoning in the transcript/)).toBeInTheDocument();
  });

  it('shows the server’s new-chat defaults and never offers Bypass as one', async () => {
    serverWith({ global: { permissionMode: 'plan', effort: 'high' }, seats: { 'codex-b': { effort: 'low' } } });
    renderSettings();
    const chat = panel('Chat');
    const group = await within(chat).findByRole('radiogroup', { name: 'New chats start in' });
    expect(within(group).getByRole('radio', { name: 'Plan' })).toBeChecked();
    expect(within(group).queryByRole('radio', { name: /Bypass/ })).not.toBeInTheDocument();
    const effort = within(chat).getByRole('combobox', { name: /Reasoning effort for new chats/ });
    expect(effort).toHaveValue('high');
    expect(within(effort).queryByRole('option', { name: /Bypass/ })).not.toBeInTheDocument();
    expect(within(chat).getByText(/One seat has its own default, which wins/)).toBeInTheDocument();
  });

  it('asks for the token before writing a default, and writes nothing when it is dismissed', async () => {
    const { posts } = serverWith({ global: {}, seats: {} });
    const user = userEvent.setup();
    renderSettings();
    const chat = panel('Chat');
    const group = await within(chat).findByRole('radiogroup', { name: 'New chats start in' });
    expect(within(group).getByRole('radio', { name: 'Accept edits' })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: 'Auto' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Start new chats in Auto.');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts).toEqual([]);
    expect(within(group).getByRole('radio', { name: 'Accept edits' })).toBeChecked();
  });

  it('with the token held, writes the default and renders the server’s answer', async () => {
    const { posts } = serverWith({ global: {}, seats: {} });
    setMutationToken(TOKEN);
    const user = userEvent.setup();
    renderSettings();
    const chat = panel('Chat');
    const effort = await within(chat).findByRole('combobox', { name: /Reasoning effort for new chats/ });
    await user.selectOptions(effort, 'medium');
    await waitFor(() => expect(posts).toEqual([{ effort: 'medium' }]));
    await waitFor(() => expect(effort).toHaveValue('medium'));
    await user.selectOptions(effort, '');
    await waitFor(() => expect(posts).toEqual([{ effort: 'medium' }, { effort: null }]));
  });

  it('a body that is not the contract is "unavailable" — never a crash of Settings, never an invented value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    renderSettings();
    expect(await within(panel('Chat')).findByText(/Couldn’t read the new-chat defaults/)).toBeInTheDocument();
    // The rest of Settings still works.
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
  });

  it('says plainly when this server cannot set defaults, instead of showing dead controls', async () => {
    serverWith(501);
    renderSettings();
    expect(await within(panel('Chat')).findByText(/can’t set new-chat defaults yet/)).toBeInTheDocument();
    expect(within(panel('Chat')).queryByRole('radiogroup', { name: 'New chats start in' })).not.toBeInTheDocument();
  });
});

describe('Settings ▸ Desktop', () => {
  it('in a browser says it needs the desktop app and offers no switch', () => {
    renderSettings();
    const desktop = panel('Desktop');
    expect(within(desktop).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(desktop).getByText(/available in the Verse desktop app/)).toBeInTheDocument();
  });

  it('renders from the reported state, and a change waits for native’s answer', async () => {
    const bridge = installBridge(desktopState());
    const user = userEvent.setup();
    renderSettings();
    const desktop = panel('Desktop');
    const hotkey = within(desktop).getByRole('switch', { name: 'System-wide shortcut' });
    expect(hotkey).toHaveAttribute('aria-checked', 'false');
    expect(within(desktop).getByText(/takes ⌃⌥Space away from every other app/)).toBeInTheDocument();
    await user.click(hotkey);
    expect(bridge.setPreference).toHaveBeenCalledWith('globalHotkey', true);
    // Not flipped optimistically: still off, and busy, until native answers.
    expect(hotkey).toHaveAttribute('aria-checked', 'false');
    expect(hotkey).toBeDisabled();
    expect(within(desktop).getByRole('status')).toHaveTextContent('Waiting for the desktop app');
    bridge.answer(desktopState({ hotkey: { enabled: true, registered: true } }));
    expect(hotkey).toHaveAttribute('aria-checked', 'true');
    expect(hotkey).toBeEnabled();
    expect(within(desktop).getByText(/Press ⌃⌥Space in any app/)).toBeInTheDocument();
  });

  it('a chord another app holds shows as NOT active, with native’s reason', () => {
    const bridge = installBridge(desktopState());
    renderSettings();
    bridge.answer(desktopState({ hotkey: { enabled: true, registered: false, error: 'Raycast already uses ⌃⌥Space' } }));
    const desktop = panel('Desktop');
    expect(within(desktop).getByRole('switch', { name: 'System-wide shortcut' })).toHaveAttribute('aria-checked', 'true');
    expect(within(desktop).getByText(/⌃⌥Space is not active: Raycast already uses ⌃⌥Space/)).toBeInTheDocument();
    expect(within(desktop).queryByText(/Press ⌃⌥Space in any app/)).not.toBeInTheDocument();
  });

  it('an unsigned build says banners arrive as Script Editor', () => {
    installBridge(desktopState({ notifications: { delivery: 'script' } }));
    renderSettings();
    expect(within(panel('Desktop')).getByText(/banners appear as Script Editor/)).toBeInTheDocument();
  });

  it('says so when the desktop app never answers, and keeps the last reported state', async () => {
    vi.useFakeTimers();
    try {
      installBridge(desktopState({ notifications: { enabled: true } }));
      renderSettings();
      const toggle = within(panel('Desktop')).getByRole('switch', { name: 'Notifications' });
      act(() => { toggle.click(); });
      act(() => { vi.advanceTimersByTime(4_100); });
      expect(within(panel('Desktop')).getByRole('alert')).toHaveTextContent('did not answer');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(toggle).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Settings ▸ Keyboard', () => {
  it('lists the catalog — 3.10 bindings, not the 3.9 ones', () => {
    renderSettings();
    const keyboard = panel('Keyboard');
    expect(within(keyboard).getByText('Go to Command')).toBeInTheDocument();
    expect(within(keyboard).getByText('Open Needs you')).toBeInTheDocument();
    expect(within(keyboard).queryByText('Quick switcher')).not.toBeInTheDocument();
  });
});

describe('Settings at 375, dark', () => {
  it('keeps every 3.10 panel and its controls reachable', async () => {
    viewport = mockCompactViewport();
    document.documentElement.setAttribute('data-theme', 'dark');
    installBridge(desktopState({ hotkey: { enabled: true, registered: true } }));
    renderSettings();
    for (const name of ['Chat', 'Desktop', 'Keyboard']) expect(panel(name)).toBeInTheDocument();
    expect(within(panel('Desktop')).getByRole('switch', { name: 'System-wide shortcut' })).toBeEnabled();
    expect(await within(panel('Chat')).findByRole('radiogroup', { name: 'New chats start in' })).toBeInTheDocument();
  });
});

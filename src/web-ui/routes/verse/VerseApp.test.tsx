/**
 * The 3.10 workbench shell (unit C1): the rail, keep-alive, the global keys,
 * the overlays, the badges and the native bridge. The chat surface itself is
 * C2's (sections/ChatSection.test.tsx); this file only asserts that the shell
 * mounts it, keeps it alive and gets out of its way.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { bootstrap, MockEventSource } from './fixtures.test-support.js';
import { CLAUDE_TIGHT_SEAT, GROK_SEAT, UNREAD_SEAT } from './seat-fixtures.test-support.js';
import { resetCommandBus } from './shell/command-bus.js';
import { resetGuard } from './shell/guarded-action.js';
import { resetResolvedForTest } from './shell/needs-you-actions.js';
import { activity, approvalNeed, shellFetch, vetoNeed, type ShellFetch } from './shell/shell-fixtures.test-support.js';
import { refreshActivity, resetActivityForTest } from './shell/useActivity.js';
import { mockCompactViewport, type ViewportMock } from './shell/viewport.test-support.js';
import { MissingSection, SECTION_MODULES, VerseApp } from './VerseApp.js';
import { resetVerseStore } from './verse-store.js';
import {
  getVerseUiState,
  landedModule,
  RAIL_SECTIONS,
  reloadVerseUiForTest,
  resetVerseUi,
  setVerseRailExpanded,
  setVerseSection,
  VERSE_SECTIONS,
  VERSE_UI_STORAGE_KEY,
  VERSE_UI_STORAGE_KEY_V2,
} from './verse-ui-store.js';

function mount() {
  return render(<ToastProvider><VerseApp /></ToastProvider>);
}

/**
 * The catalog's ⌘ is "CmdOrCtrl": jsdom reports no platform, so the matcher
 * runs its non-Mac branch and the modifier is Ctrl (command-catalog.ts).
 */
const key = (k: string, mods: Partial<Record<'metaKey' | 'shiftKey' | 'ctrlKey' | 'altKey', boolean>> = {}, code?: string) =>
  act(() => { fireEvent.keyDown(document, { key: k, code, ctrlKey: true, ...mods }); });

const rail = () => screen.getByRole('navigation', { name: 'Verse sections' });
const surface = (id: string) => document.querySelector<HTMLElement>(`[data-surface="${id}"]`);

/**
 * Resolve every lazily-imported section module BEFORE any test asserts one
 * mounted: a cold ChatSection does not reliably transform inside findBy's
 * 1 s window when this file runs alone, and a timeout there reads exactly
 * like "the shell did not mount Chat". Walks the shell's own glob.
 */
beforeAll(async () => {
  await Promise.all(Object.values(SECTION_MODULES).map((load) => load()));
}, 30_000);

let net: ShellFetch;
let viewport: ViewportMock | null = null;

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  resetCommandBus();
  resetGuard();
  resetResolvedForTest();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  net = shellFetch(
    activity({
      needsYou: [approvalNeed('p-1'), vetoNeed()],
      running: [{ sessionId: 'vs_1', title: 'Fix the login bug', engine: 'claude', seatId: 'claude-main', startedAt: new Date().toISOString(), live: null }],
    }),
  );
  vi.stubGlobal('fetch', net.fetch);
  resetActivityForTest();
  markCheckComplete(true);
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  resetActivityForTest();
  window.history.replaceState(null, '', '/');
});

describe('the rail', () => {
  it('shows the five surfaces in ⌘1–⌘5 order and mounts Chat first', async () => {
    mount();
    const buttons = within(rail()).getAllByRole('button').filter((b) => b.hasAttribute('data-section'));
    expect(buttons.map((b) => b.getAttribute('data-section'))).toEqual(RAIL_SECTIONS.map((s) => s.id));
    expect(within(rail()).getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-current', 'page');
    await screen.findByRole('navigation', { name: 'Chats' });
  });

  it('switches with ⌘1–⌘5 — a surface not in this build says so, with no source path', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    key('1', {}, 'Digit1');
    expect(getVerseUiState().section).toBe('command');
    expect(within(rail()).getByRole('button', { name: /^Command/ })).toHaveAttribute('aria-current', 'page');
    if (landedModule('command') === null) {
      expect(await screen.findByText("Command isn't in this build yet")).toBeInTheDocument();
      expect(surface('command')!.textContent).not.toMatch(/routes\/verse|\.tsx/);
    }
    key('5', {}, 'Digit5');
    expect(getVerseUiState().section).toBe('chat');
  });

  it('resolves EVERY section through the shell’s own glob — primary or declared fallback', async () => {
    // A section is reachable only when its module (or a fallback) is at
    // `sections/<module>.tsx`, where the glob sees it. MCP once shipped
    // complete and unreachable for a release; this pins the whole table.
    for (const entry of VERSE_SECTIONS) {
      const module = landedModule(entry.id);
      if (module === null) continue; // not landed yet: the designed missing state covers it
      const importer = SECTION_MODULES[`./sections/${module}.tsx`];
      expect(importer, `${entry.id} → ${module}`).toBeTypeOf('function');
      const mod = (await importer!()) as Record<string, unknown>;
      expect(typeof (mod[module] ?? mod.default), `${module} must export a ${module} component`).toBe('function');
    }
    // The ones that always exist in this repo.
    expect(landedModule('chat')).toBe('ChatSection');
    expect(landedModule('settings')).toBe('SettingsSection');
  });

  it('renders the missing state directly', () => {
    render(<MissingSection label="Growth" blurb="Is the fleet getting better?" />);
    expect(screen.getByRole('status')).toHaveTextContent("Growth isn't in this build yet");
    expect(screen.getByText('Is the fleet getting better?')).toBeInTheDocument();
  });

  it('carries the badges in the accessible names — Needs you, running chats, autonomy, capacity', async () => {
    mount();
    expect(await within(rail()).findByRole('button', { name: 'Command, 2 need you' })).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: 'Chat, 1 running' }).querySelector('[data-badge="pulse"]')).not.toBeNull();
    expect(within(rail()).getByRole('button', { name: 'Fleet, Propose · 2 building' }).querySelector('[data-badge="autonomy"]')).not.toBeNull();
    expect(within(rail()).getByRole('button', { name: 'Needs you, 2' })).toBeInTheDocument();
  });

  it('rings the scarcest seat from the shared capacity rows (C6), not a second description of it', async () => {
    // Activity still carries its own capacity badge (62% Claude); the ring
    // must ignore it and read the seat roster the capacity strip reads.
    net = shellFetch(activity(), { bootstrap: bootstrap({ seats: [GROK_SEAT, CLAUDE_TIGHT_SEAT, UNREAD_SEAT] }) });
    vi.stubGlobal('fetch', net.fetch);
    const user = userEvent.setup();
    mount();
    const ring = await within(rail()).findByRole('button', { name: /^Capacity — Claude Max: .*92% used/ });
    expect(ring).toHaveAttribute('data-capacity', '92');
    expect(within(rail()).queryByRole('button', { name: /62% used/ })).not.toBeInTheDocument();
    await user.click(ring);
    expect(getVerseUiState().section).toBe('apps');
  });

  it('draws no ring when no seat has a reading — an empty ring would claim headroom nobody measured', async () => {
    net = shellFetch(activity(), { bootstrap: bootstrap({ seats: [UNREAD_SEAT] }) });
    vi.stubGlobal('fetch', net.fetch);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    expect(within(rail()).queryByRole('button', { name: /^Capacity/ })).not.toBeInTheDocument();
  });

  it('draws no badge at all when activity is not in this build — never a false zero', async () => {
    net.setActivity(404);
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    await waitFor(() => expect(within(rail()).getByRole('button', { name: 'Needs you' })).toBeInTheDocument());
    expect(within(rail()).getByRole('button', { name: 'Command' })).toBeInTheDocument();
    expect(rail().querySelector('[data-badge]')).toBeNull();
  });

  it('⌘⇧\\ toggles rail labels, and the choice persists in v3', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    key('|', { shiftKey: true }, 'Backslash');
    expect(rail()).toHaveAttribute('data-rail', 'expanded');
    expect(within(rail()).getByRole('button', { name: /^Fleet/ })).toHaveTextContent('Fleet');
    expect(JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '{}')).toMatchObject({ railExpanded: true });
  });

  it('keeps the desktop drag strip as the rail’s first child in both widths', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    for (const state of ['collapsed', 'expanded'] as const) {
      act(() => setVerseRailExpanded(state === 'expanded'));
      const strip = rail().querySelector('[data-app-region="drag"]');
      expect(rail().firstElementChild, state).toBe(strip);
      expect(strip).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('becomes a bottom bar with labels at 375', async () => {
    viewport = mockCompactViewport({ dark: true });
    const view = mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    expect(view.container.firstElementChild).toHaveAttribute('data-compact', 'true');
    expect(within(rail()).getByRole('button', { name: /^Command/ })).toHaveTextContent('Command');
    expect(within(rail()).getByRole('button', { name: 'Settings and more' })).toHaveTextContent('More');
  });
});

describe('keep-alive', () => {
  it('keeps a left surface mounted — hidden and inert — and brings back the very same DOM', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const chatBefore = surface('chat')!.firstElementChild;
    const search = within(surface('chat')!).queryByRole('searchbox') ?? within(surface('chat')!).queryByRole('textbox');
    if (search) await user.type(search, 'login');

    key(',', {}, 'Comma');
    expect(getVerseUiState().section).toBe('settings');
    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    const chat = surface('chat')!;
    expect(chat).toHaveAttribute('hidden');
    expect(chat.hasAttribute('inert')).toBe(true);
    expect(surface('settings')).not.toHaveAttribute('hidden');

    key('5', {}, 'Digit5');
    expect(surface('chat')).not.toHaveAttribute('hidden');
    expect(surface('chat')!.firstElementChild).toBe(chatBefore);
    if (search) expect(search).toHaveValue('login');
    // The one <main> the skip link targets holds every mounted surface.
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(document.querySelector('main')).toHaveAttribute('id', 'main-content');
  });
});

describe('overlays and keys', () => {
  it('⌘K opens the palette WITHOUT switching surface', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    key(',', {}, 'Comma');
    key('k', {}, 'KeyK');
    expect(await screen.findByRole('combobox', { name: 'Search commands' })).toHaveFocus();
    expect(getVerseUiState().section).toBe('settings');
  });

  it('⌘J toggles the Needs-you drawer; ⌘/ shows every key from the catalog', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    key('j', {}, 'KeyJ');
    expect(await screen.findByRole('dialog', { name: /Needs you/ })).toBeInTheDocument();
    key('j', {}, 'KeyJ');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Needs you/ })).not.toBeInTheDocument());

    key('/', {}, 'Slash');
    const overlay = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(overlay).getByText('Go to Command')).toBeInTheDocument();
    expect(within(overlay).getByText('Approve')).toBeInTheDocument();
    key('/', {}, 'Slash');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument());
  });

  it('⌘[ and ⌘] step back and forward through surfaces', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    key(',', {}, 'Comma');
    key('2', {}, 'Digit2');
    key('[', {}, 'BracketLeft');
    expect(getVerseUiState().section).toBe('settings');
    key('[', {}, 'BracketLeft');
    expect(getVerseUiState().section).toBe('chat');
    key(']', {}, 'BracketRight');
    expect(getVerseUiState().section).toBe('settings');
  });

  it('the gear tray is a real menu: arrows move, Enter chooses', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    await user.click(within(rail()).getByRole('button', { name: 'Settings and more' }));
    const menu = await screen.findByRole('menu', { name: 'Settings and more' });
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: /Settings/ })).toHaveFocus());
    expect(within(menu).getByRole('menuitemradio', { name: 'Match system' })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: /Usage/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(getVerseUiState().section).toBe('usage');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks every key it routes as taken (preventDefault), and leaves other keys alone', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const routed = new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(routed); });
    expect(routed.defaultPrevented).toBe(true);
    expect(getVerseUiState().section).toBe('command');
    const plain = new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(false);
    // A key someone downstream already took is never run twice.
    const taken = new KeyboardEvent('keydown', { key: '5', code: 'Digit5', ctrlKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => { document.dispatchEvent(taken); });
    expect(getVerseUiState().section).toBe('command');
  });

  it('global keys stand down while a dialog the shell did not open is up', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    key('n', {}, 'KeyN');
    expect(await screen.findByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
    key('2', {}, 'Digit2');
    expect(getVerseUiState().section).toBe('chat');
  });
});

describe('announcements and the native bridge', () => {
  it('announces "Chat moved to ⌘5" once after a v2 migration', async () => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY_V2, JSON.stringify({ section: 'chat' }));
    reloadVerseUiForTest({ landed: (m) => m === 'ChatSection' });
    mount();
    // ⌘5 on a Mac; jsdom has no platform, so the catalog prints Ctrl+5.
    expect(await screen.findByText(/Chat moved to (⌘5|Ctrl\+5)/)).toBeInTheDocument();
    expect(getVerseUiState().announceChatMoved).toBe(false);
  });

  it('toasts a chat that finished while you were elsewhere', async () => {
    let polls = 0;
    net.setActivity(() => {
      polls += 1;
      return activity(polls > 1 ? { cursor: 'v1.aaaaaaaa.t.2', completions: [{ sessionId: 'vs_2', title: 'Write the docs', outcome: 'ok', at: new Date().toISOString(), durationMs: null }] } : {});
    });
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(1));
    await act(async () => { await refreshActivity(); });
    expect(await screen.findByText('Finished: Write the docs')).toBeInTheDocument();
  });

  it('runs native commands: Needs you, and opening a notified chat', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:desktop-command', { detail: { command: 'open-needs-you' } })); });
    expect(await screen.findByRole('dialog', { name: /Needs you/ })).toBeInTheDocument();
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:desktop-command', { detail: { command: 'open-session:vs_2' } })); });
    await waitFor(() => expect(getVerseUiState().overlay).toBeNull());
    expect(getVerseUiState()).toMatchObject({ section: 'chat', activeSessionId: 'vs_2' });
    // Unknown commands are inert.
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:desktop-command', { detail: { command: 'rm -rf' } })); });
    expect(getVerseUiState().section).toBe('chat');
  });

  it('the tray’s New chat and the hotkey land in Chat, closing an open palette first (C8)', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    key(',', {}, 'Comma');
    key('k', {}, 'KeyK');
    expect(await screen.findByRole('combobox', { name: 'Search commands' })).toBeInTheDocument();
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:desktop-command', { detail: { command: 'new-chat' } })); });
    expect(getVerseUiState().section).toBe('chat');
    expect(await screen.findByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Search commands' })).not.toBeInTheDocument();
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New chat' })).not.toBeInTheDocument());

    key(',', {}, 'Comma');
    key('/', {}, 'Slash');
    expect(getVerseUiState().overlay).toBe('shortcuts');
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:desktop-command', { detail: { command: 'focus-composer' } })); });
    expect(getVerseUiState()).toMatchObject({ section: 'chat', overlay: null });
    // The chat consumed the one-shot hand-off.
    await waitFor(() => expect(getVerseUiState().command).toBeNull());
  });

  it('reveals an anchor on the surface it names once that surface paints', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Chats' });
    const scrolled = vi.fn();
    act(() => { setVerseSection('settings', 'about'); });
    // The settings surface is a lazy chunk: the anchor appears after the event.
    const host = await waitFor(() => {
      const el = surface('settings');
      expect(el).not.toBeNull();
      return el!;
    });
    const target = document.createElement('div');
    target.setAttribute('data-verse-anchor', 'about');
    target.scrollIntoView = scrolled;
    act(() => { host.appendChild(target); });
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
  });
});

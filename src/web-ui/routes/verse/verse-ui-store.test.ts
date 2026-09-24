/**
 * verse-ui-store — the 3.10 shell state (unit C1).
 *
 * Pinned here:
 *   - the v2 → v3 storage migration (autonomy → Fleet, approvals → Command
 *     with the drawer open, mcp → Apps), and the "Chat moved" announcement
 *     only for someone who actually had v2;
 *   - the launch rule: the first launch of a local day opens Command (when
 *     Command exists in the build), later launches keep the last surface;
 *   - keep-alive: three recent surfaces plus Chat once visited;
 *   - back / forward through surfaces AND chats, ⌃Tab through recent chats;
 *   - the one v3 blob: its own fields, plus C2's dock folded in;
 *   - total loads: garbage in storage never breaks the shell.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openDockPane, resetDockStore } from './dock/dock-store.js';
import {
  acknowledgeChatMoved,
  clearVerseCommand,
  cycleVerseRecentChat,
  getVerseUiState,
  KEEP_ALIVE_SURFACES,
  landedModule,
  localDay,
  openVerseNeedsYou,
  openVerseSession,
  RAIL_SECTIONS,
  recordVerseAction,
  reloadVerseUiForTest,
  requestVerseCommand,
  resetVerseUi,
  setVerseActiveSession,
  setVerseSection,
  setVerseSidebarWidth,
  stepVerseHistory,
  toggleVerseOverlay,
  toggleVerseRail,
  TRAY_SECTIONS,
  VERSE_ANCHOR_EVENT,
  VERSE_SECTIONS,
  VERSE_SIDEBAR,
  VERSE_UI_STORAGE_KEY,
  VERSE_UI_STORAGE_KEY_V2,
} from './verse-ui-store.js';

const NOON = new Date(2026, 8, 24, 12, 0, 0).getTime();
const EVERYTHING_LANDED = () => true;
const NOTHING_LANDED = () => false;

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  resetVerseUi();
});

describe('sections', () => {
  it('puts the five surfaces on the rail in ⌘1–⌘5 order and the rest in the tray', () => {
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(['command', 'fleet', 'growth', 'mind', 'chat']);
    expect(TRAY_SECTIONS.map((s) => s.id)).toEqual(['settings', 'apps', 'usage']);
    for (const entry of VERSE_SECTIONS) expect(entry.module).toMatch(/Section$/);
  });

  it('falls back to the legacy panels until the new surface lands', () => {
    const only = (...names: string[]) => (m: string) => names.includes(m);
    expect(landedModule('fleet', only('AutonomySection'))).toBe('AutonomySection');
    expect(landedModule('fleet', only('FleetSection', 'AutonomySection'))).toBe('FleetSection');
    // Apps never falls back to the MCP page: AppsSection folds MCP in (C6).
    expect(landedModule('apps', only('McpSection'))).toBeNull();
    expect(landedModule('apps', only('AppsSection', 'McpSection'))).toBe('AppsSection');
    expect(landedModule('command', only('McpSection'))).toBeNull();
  });

  it('carries an anchor to the shell as a one-shot window event, never as persisted state', () => {
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(VERSE_ANCHOR_EVENT, listener);
    try {
      setVerseSection('mind', 'memo:m-7');
      setVerseSection('fleet');
    } finally {
      window.removeEventListener(VERSE_ANCHOR_EVENT, listener);
    }
    expect(seen).toEqual([{ section: 'mind', anchor: 'memo:m-7' }]);
    expect(getVerseUiState().section).toBe('fleet');
    expect(stored()).not.toHaveProperty('anchor');
  });
});

describe('v2 → v3 migration', () => {
  it.each([
    ['autonomy', 'fleet', null],
    ['approvals', 'command', 'needs-you'],
    ['mcp', 'apps', null],
    ['usage', 'usage', null],
    ['settings', 'settings', null],
    ['chat', 'chat', null],
  ] as const)('a saved v2 %s opens %s', (from, to, overlay) => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY_V2, JSON.stringify({ section: from, railExpanded: true, sidebarWidth: 300 }));
    // No Command module here, so the launch rule stays out of the way.
    reloadVerseUiForTest({ now: NOON, landed: NOTHING_LANDED });
    const s = getVerseUiState();
    expect(s.section).toBe(to);
    expect(s.overlay).toBe(overlay);
    expect(s.railExpanded).toBe(true);
    expect(s.sidebarWidth).toBe(300);
    expect(stored()).toMatchObject({ version: 3, section: to });
    // The v2 blob is left alone: a downgrade still finds its own state.
    expect(localStorage.getItem(VERSE_UI_STORAGE_KEY_V2)).not.toBeNull();
  });

  it('announces "Chat moved" once, and only to someone who had v2', () => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY_V2, JSON.stringify({ section: 'chat' }));
    reloadVerseUiForTest({ now: NOON, landed: NOTHING_LANDED });
    expect(getVerseUiState().announceChatMoved).toBe(true);
    acknowledgeChatMoved();
    expect(getVerseUiState().announceChatMoved).toBe(false);
    reloadVerseUiForTest({ now: NOON, landed: NOTHING_LANDED });
    expect(getVerseUiState().announceChatMoved).toBe(false);

    localStorage.clear();
    reloadVerseUiForTest({ now: NOON, landed: NOTHING_LANDED });
    expect(getVerseUiState().announceChatMoved).toBe(false);
  });

  it('never reads v2 again once v3 exists', () => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ version: 3, section: 'usage', lastLaunchDay: localDay(NOON) }));
    localStorage.setItem(VERSE_UI_STORAGE_KEY_V2, JSON.stringify({ section: 'approvals' }));
    reloadVerseUiForTest({ now: NOON, landed: EVERYTHING_LANDED });
    expect(getVerseUiState()).toMatchObject({ section: 'usage', overlay: null });
  });
});

describe('launch rule', () => {
  it('opens Command on the first launch of the day, then the last surface', () => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ version: 3, section: 'chat', lastLaunchDay: '2026-09-23' }));
    reloadVerseUiForTest({ now: NOON, landed: EVERYTHING_LANDED });
    expect(getVerseUiState().section).toBe('command');
    setVerseSection('fleet');
    // Same day, next launch: back where the operator left it.
    reloadVerseUiForTest({ now: NOON + 3_600_000, landed: EVERYTHING_LANDED });
    expect(getVerseUiState().section).toBe('fleet');
  });

  it('does not force a surface that is not in this build', () => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ version: 3, section: 'chat', lastLaunchDay: '2026-09-01' }));
    reloadVerseUiForTest({ now: NOON, landed: NOTHING_LANDED });
    expect(getVerseUiState().section).toBe('chat');
  });
});

describe('keep-alive', () => {
  it(`keeps the last ${KEEP_ALIVE_SURFACES} surfaces mounted, and Chat once visited`, () => {
    setVerseSection('chat');
    setVerseSection('command');
    setVerseSection('fleet');
    setVerseSection('growth');
    setVerseSection('mind');
    expect(getVerseUiState().mounted).toEqual(['mind', 'growth', 'fleet', 'chat']);
    setVerseSection('fleet');
    expect(getVerseUiState().mounted).toEqual(['fleet', 'mind', 'growth', 'chat']);
    setVerseSection('chat');
    expect(getVerseUiState().mounted[0]).toBe('chat');
    expect(getVerseUiState().mounted).toHaveLength(KEEP_ALIVE_SURFACES + 1);
  });
});

describe('history', () => {
  it('steps back and forward through surfaces and chats', () => {
    setVerseSection('chat');
    setVerseActiveSession('a');
    openVerseSession('b');
    setVerseSection('fleet');
    expect(stepVerseHistory(-1)).toBe(true);
    expect(getVerseUiState()).toMatchObject({ section: 'chat', activeSessionId: 'b' });
    expect(stepVerseHistory(-1)).toBe(true);
    const back = getVerseUiState();
    expect(back).toMatchObject({ section: 'chat', activeSessionId: 'a' });
    expect(back.command).toMatchObject({ name: 'open-session', sessionId: 'a' });
    expect(stepVerseHistory(1)).toBe(true);
    expect(stepVerseHistory(1)).toBe(true);
    expect(getVerseUiState().section).toBe('fleet');
    expect(stepVerseHistory(1)).toBe(false);
  });

  it('⌃Tab walks the recent chats like Alt-Tab', () => {
    setVerseSection('chat');
    for (const id of ['c', 'b', 'a']) setVerseActiveSession(id);
    // MRU is a, b, c: one press goes to b; a second press within the window to c.
    expect(cycleVerseRecentChat(1, 1_000)).toBe('b');
    expect(cycleVerseRecentChat(1, 1_500)).toBe('c');
    // After a pause the list is re-read from the top (c, b, a → b).
    expect(cycleVerseRecentChat(1, 9_000)).toBe('b');
    expect(getVerseUiState().command).toMatchObject({ name: 'open-session', sessionId: 'b' });
  });
});

describe('commands and overlays', () => {
  it('hands the chat a one-shot command and switches to it', () => {
    setVerseSection('fleet');
    requestVerseCommand('new-chat', { seatId: 'grok-a' });
    const s = getVerseUiState();
    expect(s.section).toBe('chat');
    expect(s.command).toMatchObject({ name: 'new-chat', seatId: 'grok-a' });
    const first = s.command!.nonce;
    clearVerseCommand();
    requestVerseCommand('quick-switcher');
    expect(getVerseUiState().command!.nonce).toBeGreaterThan(first);
    expect(stored()).not.toHaveProperty('command');
  });

  it('opening a chat before Chat has mounted also primes its selection key', () => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ version: 3, section: 'fleet', lastLaunchDay: localDay(NOON) }));
    reloadVerseUiForTest({ now: NOON, landed: EVERYTHING_LANDED });
    expect(getVerseUiState().mounted).toEqual(['fleet']);
    openVerseSession('vs_9');
    expect(localStorage.getItem('ashlr.verse.selected.v1')).toBe('vs_9');
    openVerseSession('../etc');
    expect(getVerseUiState().activeSessionId).toBe('vs_9');
  });

  it('toggles overlays without touching the surface', () => {
    setVerseSection('growth');
    toggleVerseOverlay('palette');
    expect(getVerseUiState()).toMatchObject({ overlay: 'palette', section: 'growth' });
    toggleVerseOverlay('palette');
    expect(getVerseUiState().overlay).toBeNull();
    openVerseNeedsYou({ split: 'accounts', focusId: 'accounts:reconnect:x' });
    expect(getVerseUiState()).toMatchObject({ overlay: 'needs-you', needsYouSplit: 'accounts', needsYouFocus: 'accounts:reconnect:x' });
  });
});

describe('the v3 blob', () => {
  it('persists preferences and folds in the dock, never the evidence', () => {
    toggleVerseRail();
    setVerseSidebarWidth(9_999);
    recordVerseAction('chats.stop-all');
    recordVerseAction('chat.new');
    recordVerseAction('chats.stop-all');
    openDockPane('tasks');
    const blob = stored();
    expect(blob).toMatchObject({
      version: 3,
      railExpanded: true,
      sidebarWidth: VERSE_SIDEBAR.max,
      recentActions: ['chats.stop-all', 'chat.new'],
      dock: { open: true, tabs: ['tasks'], active: 'tasks' },
    });
    // The desktop prefs belong to the desktop app (desktop_prefs.rs), not this blob.
    for (const key of ['overlay', 'mounted', 'history', 'command', 'activeSessionId', 'desktop']) expect(blob).not.toHaveProperty(key);
  });

  it('loads garbage field by field', () => {
    localStorage.setItem(
      VERSE_UI_STORAGE_KEY,
      JSON.stringify({ version: 3, section: 'wormhole', sidebarWidth: -3, recentChats: ['ok', '../bad', 7], recentActions: ['DROP TABLE'], desktop: 'x', lastLaunchDay: localDay(NOON) }),
    );
    reloadVerseUiForTest({ now: NOON, landed: EVERYTHING_LANDED });
    expect(getVerseUiState()).toMatchObject({
      section: 'chat',
      sidebarWidth: VERSE_SIDEBAR.def,
      recentChats: ['ok'],
      recentActions: [],
    });
    expect(getVerseUiState()).not.toHaveProperty('desktop');
    localStorage.setItem(VERSE_UI_STORAGE_KEY, '{not json');
    expect(() => reloadVerseUiForTest({ now: NOON })).not.toThrow();
  });
});

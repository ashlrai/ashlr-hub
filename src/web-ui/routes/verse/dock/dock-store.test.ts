/**
 * dock/dock-store.test.ts — the dock's state transitions (pure) and the
 * store's persistence contract: it READS the shell's v3 blob and never
 * writes it (C1's verse-ui-store is the one writer).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, DOCK_LAYOUT, VERSE_UI_STORAGE_KEY, type DockState } from '../shell/dock-catalog.js';
import {
  getDockSnapshot,
  getDockState,
  hydrateDockState,
  requestDiff,
  openDockPane,
  requestTerminal,
  requestTerminalBelow,
  resetDockStore,
  toggleDock,
  withPaneOpen,
  withPaneToggled,
  withSplit,
  withSplitRatio,
  withTabClosed,
  withWidth,
  activateDockChat,
  setDockHeight,
  toggleDockPlacement,
  withChatSwitch,
  withHeight,
} from './dock-store.js';

const base = (over: Partial<DockState> = {}): DockState => ({ ...DEFAULT_DOCK_STATE, tabs: [], ...over });

describe('transitions', () => {
  it('opens a pane as a new tab and makes it visible', () => {
    expect(withPaneOpen(base(), 'terminal')).toMatchObject({ open: true, tabs: ['terminal'], active: 'terminal', splitWith: null });
    expect(withPaneOpen(base({ tabs: ['terminal'], active: 'terminal' }), 'diff')).toMatchObject({ tabs: ['terminal', 'diff'], active: 'diff' });
  });

  it('opening the lower pane of a split swaps it to the top', () => {
    const split = base({ open: true, tabs: ['preview', 'terminal'], active: 'preview', splitWith: 'terminal' });
    expect(withPaneOpen(split, 'terminal')).toMatchObject({ active: 'terminal', splitWith: 'preview' });
  });

  it('a pane toggle closes the dock only when that pane is what is showing', () => {
    const shown = base({ open: true, tabs: ['terminal', 'tasks'], active: 'terminal' });
    expect(withPaneToggled(shown, 'terminal').open).toBe(false);
    expect(withPaneToggled(shown, 'tasks')).toMatchObject({ open: true, active: 'tasks' });
    expect(withPaneToggled({ ...shown, splitWith: 'tasks' }, 'tasks').open).toBe(false);
  });

  it('closing a tab hands over to the lower pane, else a neighbour, and closes an empty dock', () => {
    const split = base({ open: true, tabs: ['preview', 'terminal', 'tasks'], active: 'preview', splitWith: 'terminal' });
    expect(withTabClosed(split, 'preview')).toMatchObject({ tabs: ['terminal', 'tasks'], active: 'terminal', splitWith: null });
    expect(withTabClosed(base({ open: true, tabs: ['a' as never, 'tasks'], active: 'tasks' }), 'tasks')).toMatchObject({ active: 'a' });
    expect(withTabClosed(base({ open: true, tabs: ['tasks'], active: 'tasks' }), 'tasks')).toMatchObject({ open: false, tabs: [], active: null });
  });

  it('splits below the active pane, never with itself, and un-splits', () => {
    const one = base({ open: true, tabs: ['preview'], active: 'preview' });
    expect(withSplit(one, 'terminal')).toMatchObject({ tabs: ['preview', 'terminal'], active: 'preview', splitWith: 'terminal' });
    expect(withSplit(one, 'preview')).toBe(one);
    expect(withSplit(withSplit(one, 'terminal'), null).splitWith).toBeNull();
  });

  it('keeps the width at or above 320 and the split inside 20–80%', () => {
    expect(withWidth(base(), 100).width).toBe(320);
    expect(withWidth(base(), 512.4).width).toBe(512);
    expect(withWidth(base(), Number.NaN).width).toBe(DEFAULT_DOCK_STATE.width);
    expect(withSplitRatio(base(), 0.05).splitRatio).toBe(0.2);
    expect(withSplitRatio(base(), 0.95).splitRatio).toBe(0.8);
  });
});

describe('the store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDockStore();
  });

  it('reads its field of the shell\'s v3 blob, sanitised', () => {
    // Ids are checked by SHAPE (a unit's pane may register after the dock hydrates); anything that cannot be an id is dropped.
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ section: 'chat', dock: { open: true, tabs: ['tasks', 'Not a pane!', 'tasks'], active: 'Not a pane!', width: 500 } }));
    resetDockStore();
    expect(getDockState()).toMatchObject({ open: true, tabs: ['tasks'], active: 'tasks', width: 500 });
  });

  it('never writes the shell\'s key itself', () => {
    toggleDock();
    expect(getDockState()).toMatchObject({ open: true, active: 'tasks' });
    expect(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '').not.toContain('"dock"');
  });

  it('accepts a pushed field (C1 hydrating it)', () => {
    hydrateDockState({ open: true, tabs: ['context'], active: 'context' });
    expect(getDockState()).toMatchObject({ open: true, active: 'context' });
    hydrateDockState('garbage');
    expect(getDockState()).toMatchObject({ open: false, tabs: [] });
  });

  it('raises one-shot pane requests with a fresh nonce each time, opening the pane', () => {
    requestTerminal({ paste: 'npm test' });
    const first = getDockSnapshot().requests.terminal!;
    expect(first.paste).toBe('npm test');
    expect(getDockState()).toMatchObject({ open: true, active: 'terminal' });
    requestTerminal({ paste: 'npm test' });
    expect(getDockSnapshot().requests.terminal!.nonce).toBeGreaterThan(first.nonce);
    requestDiff({ root: '/repo', scope: 'branch' });
    expect(getDockSnapshot().requests.diff).toMatchObject({ root: '/repo', scope: 'branch' });
    expect(getDockState().active).toBe('diff');
  });

  it('Preview\'s Start puts Terminal BELOW the pane on top (Browser over Terminal), with the request', () => {
    openDockPane('preview'); // the legacy id opens the pane it became
    requestTerminalBelow({ root: '~/app', devServerId: 'dev-vite' });
    expect(getDockState()).toMatchObject({ open: true, active: 'browser', splitWith: 'terminal', tabs: ['browser', 'terminal'] });
    expect(getDockSnapshot().requests.terminal).toMatchObject({ root: '~/app', devServerId: 'dev-vite' });
  });

  it('with nothing on top (or Terminal already on top) it is a plain open', () => {
    requestTerminalBelow({ devServerId: 'dev-vite' });
    expect(getDockState()).toMatchObject({ open: true, active: 'terminal', splitWith: null });
    requestTerminalBelow({ devServerId: 'dev-vite' });
    expect(getDockState()).toMatchObject({ active: 'terminal', splitWith: null });
  });

  it('carries an Apps launch\'s via/model on the request (the server resolves the command)', () => {
    requestTerminal({ newTab: true, appId: 'codex', via: 'ollama', model: 'qwen3.8:27b' });
    expect(getDockSnapshot().requests.terminal).toMatchObject({ appId: 'codex', via: 'ollama', model: 'qwen3.8:27b' });
  });
});

describe('each chat keeps its own layout', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDockStore();
  });

  it('remembers the chat you leave and restores the one you open; a new chat starts as you were working', () => {
    const a = base({ open: true, tabs: ['terminal', 'diff'], active: 'diff', splitWith: 'terminal' });
    const toB = withChatSwitch(a, 'chat-a', 'chat-b');
    // chat-b has no memory: it carries the layout over…
    expect(toB).toMatchObject({ open: true, tabs: ['terminal', 'diff'], active: 'diff' });
    expect(toB.byChat['chat-a']).toEqual({ open: true, tabs: ['terminal', 'diff'], active: 'diff', splitWith: 'terminal' });
    // …and what you do there is chat-b's alone.
    const bReading = { ...toB, open: false, tabs: ['reasoning'], active: 'reasoning', splitWith: null };
    const backToA = withChatSwitch(bReading, 'chat-b', 'chat-a');
    expect(backToA).toMatchObject({ open: true, tabs: ['terminal', 'diff'], active: 'diff', splitWith: 'terminal' });
    expect(backToA.byChat['chat-a']).toBeUndefined(); // the open chat lives in the top-level fields
    expect(backToA.byChat['chat-b']).toEqual({ open: false, tabs: ['reasoning'], active: 'reasoning', splitWith: null });
  });

  it('keeps sizes and placement window-wide, and forgets the least recent chats past the cap', () => {
    let state = base({ width: 600, height: 420, placement: 'bottom', open: true, tabs: ['files'], active: 'files' });
    for (let i = 0; i < DOCK_LAYOUT.chatMemoryLimit + 5; i += 1) state = withChatSwitch(state, `chat-${i}`, `chat-${i + 1}`);
    expect(Object.keys(state.byChat)).toHaveLength(DOCK_LAYOUT.chatMemoryLimit);
    expect(state.byChat['chat-0']).toBeUndefined();
    expect(state).toMatchObject({ width: 600, height: 420, placement: 'bottom' });
  });

  it('adopts the persisted layout for the chat open at reload, then swaps on every switch', () => {
    openDockPane('terminal');
    activateDockChat('chat-a'); // mount: no swap
    expect(getDockState()).toMatchObject({ open: true, active: 'terminal' });
    activateDockChat('chat-b');
    openDockPane('sources');
    activateDockChat('chat-a');
    expect(getDockState()).toMatchObject({ active: 'terminal', tabs: ['terminal'] });
    activateDockChat('chat-b');
    expect(getDockState()).toMatchObject({ active: 'sources', tabs: ['terminal', 'sources'] });
  });
});

describe('placement and height', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDockStore();
  });

  it('moves between beside and below, and keeps the height at or above its floor', () => {
    expect(getDockState().placement).toBe('right');
    toggleDockPlacement();
    expect(getDockState().placement).toBe('bottom');
    setDockHeight(40);
    expect(getDockState().height).toBe(DOCK_LAYOUT.minHeight);
    expect(withHeight(base(), Number.NaN)).toEqual(base());
    toggleDockPlacement();
    expect(getDockState().placement).toBe('right');
  });
});

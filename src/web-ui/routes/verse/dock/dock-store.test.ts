/**
 * dock/dock-store.test.ts — the dock's state transitions (pure) and the
 * store's persistence contract: it READS the shell's v3 blob and never
 * writes it (C1's verse-ui-store is the one writer).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, VERSE_UI_STORAGE_KEY, type DockState } from '../shell/dock-catalog.js';
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
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ section: 'chat', dock: { open: true, tabs: ['tasks', 'bogus', 'tasks'], active: 'bogus', width: 500 } }));
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

  it('Preview\'s Start puts Terminal BELOW the pane on top (Preview over Terminal), with the request', () => {
    openDockPane('preview');
    requestTerminalBelow({ root: '~/app', devServerId: 'dev-vite' });
    expect(getDockState()).toMatchObject({ open: true, active: 'preview', splitWith: 'terminal', tabs: ['preview', 'terminal'] });
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

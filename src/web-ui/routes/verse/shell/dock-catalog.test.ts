/**
 * The dock's shared rules (unit C0; SPEC-310C §3): which panes exist, how
 * wide the dock may be, when it becomes a sheet, and how persisted state is
 * read back without trusting it.
 */
import { describe, expect, it } from 'vitest';
import {
  clampDockWidth,
  DEFAULT_DOCK_STATE,
  DOCK_LAYOUT,
  DOCK_PANE_IDS,
  DOCK_PANES,
  dockPresentation,
  clampDockHeight,
  isDockPaneId,
  normalizePaneId,
  sanitizeDockState,
  VERSE_UI_STORAGE_KEY,
  VERSE_UI_STORAGE_KEY_V2,
} from './dock-catalog.js';
import { SLOTS } from './slots.js';
import { COMPACT_WIDTH, MEDIUM_WIDTH, WIDE_WIDTH } from './viewport.test-support.js';

describe('dock panes', () => {
  it('lists the first-party panes — each other unit’s pane through a slot', () => {
    expect(DOCK_PANE_IDS).toEqual(['terminal', 'browser', 'diff', 'files', 'sources', 'reasoning', 'tasks', 'context']);
    for (const pane of DOCK_PANES) {
      if (pane.slot === null) {
        expect(['C2', 'workbench'], pane.id).toContain(pane.owner);
      } else {
        expect(SLOTS[pane.slot].kind, pane.id).toBe('pane');
        expect(SLOTS[pane.slot].owner, pane.id).toBe(pane.owner);
      }
    }
  });

  it('accepts any well-formed id (a unit may register it later) and renames legacy ones', () => {
    expect(isDockPaneId('terminal')).toBe(true);
    expect(isDockPaneId('test-runner')).toBe(true);
    for (const bad of ['', 'Browser', '9lives', 'a b', 'x'.repeat(41), 7, null]) expect(isDockPaneId(bad), String(bad)).toBe(false);
    expect(normalizePaneId('preview')).toBe('browser');
    expect(normalizePaneId('files')).toBe('files');
    expect(normalizePaneId('Not!')).toBeNull();
  });
});

describe('dock layout', () => {
  it('is a column from 1024 up, a sheet below it, and a 75vh bottom sheet below 480', () => {
    expect(dockPresentation(WIDE_WIDTH)).toBe('column');
    expect(dockPresentation(1024)).toBe('column');
    expect(dockPresentation(1023)).toBe('sheet');
    expect(dockPresentation(MEDIUM_WIDTH)).toBe('sheet');
    expect(dockPresentation(480)).toBe('sheet');
    expect(dockPresentation(479)).toBe('bottom-sheet');
    expect(dockPresentation(COMPACT_WIDTH)).toBe('bottom-sheet');
    expect(DOCK_LAYOUT.bottomSheetHeightVh).toBe(75);
  });

  it('sits under the chat when the operator places it there — where there is room for a docked panel', () => {
    expect(dockPresentation(WIDE_WIDTH, 'bottom')).toBe('bottom');
    expect(dockPresentation(WIDE_WIDTH, 'right')).toBe('column');
    // Below 1024 the window decides, whatever the placement.
    expect(dockPresentation(MEDIUM_WIDTH, 'bottom')).toBe('sheet');
    expect(dockPresentation(COMPACT_WIDTH, 'bottom')).toBe('bottom-sheet');
  });

  it('keeps the bottom panel between 160px and 70% of the chat, and the transcript at least 220px', () => {
    expect(clampDockHeight(40, 900)).toBe(160);
    expect(clampDockHeight(400, 900)).toBe(400);
    expect(clampDockHeight(5000, 900)).toBe(630); // 70% of 900
    expect(clampDockHeight(5000, 500)).toBe(280); // 500 − the transcript's 220
    expect(clampDockHeight(5000, 200)).toBe(160); // the floor wins on a tiny column
    expect(clampDockHeight('tall', 900)).toBe(DOCK_LAYOUT.defaultHeight);
    expect(clampDockHeight(250, 0)).toBe(250); // unmeasured: the floor only
  });

  it('resizes between 320px and 60% of the window', () => {
    expect(clampDockWidth(100, WIDE_WIDTH)).toBe(320);
    expect(clampDockWidth(500, WIDE_WIDTH)).toBe(500);
    expect(clampDockWidth(2000, WIDE_WIDTH)).toBe(864);
    expect(clampDockWidth(Number.NaN, WIDE_WIDTH)).toBe(DOCK_LAYOUT.defaultWidth);
    expect(clampDockWidth('wide', WIDE_WIDTH)).toBe(DOCK_LAYOUT.defaultWidth);
    // A window too narrow for both rules keeps the floor (it is a sheet there anyway).
    expect(clampDockWidth(400, 500)).toBe(320);
  });
});

describe('dock state', () => {
  it('persists as the `dock` field of the ONE v3 UI blob', () => {
    expect(VERSE_UI_STORAGE_KEY).toBe('ashlr.verse.ui.v3');
    expect(VERSE_UI_STORAGE_KEY_V2).toBe('ashlr.verse.ui.v2');
  });

  it('reads anything unreadable as the default, never throwing', () => {
    for (const junk of [null, undefined, 42, 'dock', [], { tabs: 'terminal' }]) {
      expect(sanitizeDockState(junk)).toEqual(DEFAULT_DOCK_STATE);
    }
  });

  it('keeps known panes once, in order, and forces active / splitWith onto open tabs', () => {
    const state = sanitizeDockState({
      open: true,
      width: 512.4,
      tabs: ['preview', 'browser', 'terminal', 'preview', 7],
      active: 'diff',
      splitWith: 'terminal',
      splitRatio: 0.95,
    });
    // 'preview' is the Browser pane's old id; 'browser' again is a duplicate.
    expect(state).toEqual({
      open: true, width: 512, tabs: ['browser', 'terminal'], active: 'browser', splitWith: 'terminal', splitRatio: 0.8,
      placement: 'right', height: DOCK_LAYOUT.defaultHeight, byChat: {},
    });
  });

  it('reads the placement, the height and each chat\'s layout without trusting them', () => {
    const state = sanitizeDockState({
      tabs: ['files'], placement: 'bottom', height: 480.6,
      byChat: { 'chat-a': { open: true, tabs: ['terminal', 'Nope!'], active: 'terminal' }, '../etc': { open: true, tabs: ['files'] }, 'chat-b': 'junk' },
    });
    expect(state.placement).toBe('bottom');
    expect(state.height).toBe(481);
    expect(state.byChat).toEqual({
      'chat-a': { open: true, tabs: ['terminal'], active: 'terminal', splitWith: null },
      'chat-b': { open: false, tabs: [], active: null, splitWith: null },
    });
    expect(sanitizeDockState({ placement: 'left', height: 12 })).toMatchObject({ placement: 'right', height: DOCK_LAYOUT.defaultHeight });
  });

  it('never splits a pane with itself, and never opens an empty dock', () => {
    expect(sanitizeDockState({ tabs: ['terminal'], active: 'terminal', splitWith: 'terminal' }).splitWith).toBeNull();
    expect(sanitizeDockState({ open: true, tabs: [] }).open).toBe(false);
  });

  it('drops a width under the floor back to the default', () => {
    expect(sanitizeDockState({ tabs: ['tasks'], width: 12 }).width).toBe(DOCK_LAYOUT.defaultWidth);
    expect(sanitizeDockState({ tabs: ['tasks'], splitRatio: -3 }).splitRatio).toBe(DOCK_LAYOUT.splitRatio.min);
  });
});

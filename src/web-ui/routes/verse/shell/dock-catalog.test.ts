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
  isDockPaneId,
  sanitizeDockState,
  VERSE_UI_STORAGE_KEY,
  VERSE_UI_STORAGE_KEY_V2,
} from './dock-catalog.js';
import { SLOTS } from './slots.js';
import { COMPACT_WIDTH, MEDIUM_WIDTH, WIDE_WIDTH } from './viewport.test-support.js';

describe('dock panes', () => {
  it('lists Terminal, Preview, Review, Tasks and Context — each other unit’s pane through a slot', () => {
    expect(DOCK_PANE_IDS).toEqual(['terminal', 'preview', 'diff', 'tasks', 'context']);
    for (const pane of DOCK_PANES) {
      if (pane.slot === null) {
        expect(pane.owner, pane.id).toBe('C2');
      } else {
        expect(SLOTS[pane.slot].kind, pane.id).toBe('pane');
        expect(SLOTS[pane.slot].owner, pane.id).toBe(pane.owner);
      }
    }
    expect(isDockPaneId('terminal')).toBe(true);
    expect(isDockPaneId('browser')).toBe(false);
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
    expect(state).toEqual({ open: true, width: 512, tabs: ['preview', 'terminal'], active: 'preview', splitWith: 'terminal', splitRatio: 0.8 });
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

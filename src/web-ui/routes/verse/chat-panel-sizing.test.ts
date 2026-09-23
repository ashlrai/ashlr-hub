/**
 * Unit tests for chat-panel-sizing.ts — the clamp/fit maths and the
 * localStorage round-trip, with no DOM in sight.
 *
 * WHAT THESE DO NOT TEST. jsdom computes no layout, so nothing here asserts
 * a rendered pixel. `fitChatPanels` is tested as what it is: a pure function
 * from (chosen widths, a measured container width) to afforded widths. The
 * measurement itself — `node.clientWidth` — is the part only a real browser
 * can produce, and it is deliberately the one input this module refuses to
 * guess at (a container width of 0 disables fitting entirely).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_PANEL_RANGES,
  CHAT_PANEL_SIZING_KEY,
  MIN_TRANSCRIPT_WIDTH,
  clampPanelWidth,
  defaultChatPanelWidths,
  fitChatPanels,
  getChatPanelSizing,
  nudgeChatPanelWidth,
  parseChatPanelWidths,
  readChatPanelWidths,
  reloadChatPanelSizing,
  resetChatPanelSizing,
  resetChatPanelWidth,
  setChatPanelFit,
  setChatPanelWidth,
  subscribeChatPanels,
  UNKNOWN_FIT,
} from './chat-panel-sizing.js';

const SIDE = CHAT_PANEL_RANGES.sidebar;
const RES = CHAT_PANEL_RANGES.resources;

beforeEach(() => {
  localStorage.clear();
  resetChatPanelSizing();
});

describe('clampPanelWidth', () => {
  it('holds a width inside its own range', () => {
    expect(clampPanelWidth('sidebar', 300)).toBe(300);
    expect(clampPanelWidth('sidebar', 10)).toBe(SIDE.min);
    expect(clampPanelWidth('sidebar', 4000)).toBe(SIDE.max);
    expect(clampPanelWidth('resources', 4000)).toBe(RES.max);
  });

  it('reads nonsense as "never chosen" rather than as the minimum', () => {
    // A hand-edited or half-written storage entry must not silently pin the
    // panel to its narrowest legal width — that looks like a deliberate choice.
    expect(clampPanelWidth('sidebar', 'wormhole')).toBe(SIDE.def);
    expect(clampPanelWidth('sidebar', Number.NaN)).toBe(SIDE.def);
    expect(clampPanelWidth('sidebar', -3)).toBe(SIDE.def);
    expect(clampPanelWidth('resources', null)).toBe(RES.def);
  });

  it('rounds to whole pixels', () => {
    expect(clampPanelWidth('sidebar', 300.6)).toBe(301);
  });
});

describe('fitChatPanels', () => {
  const wide = { sidebar: SIDE.max, resources: RES.max };

  it('leaves both panels alone when there is room', () => {
    const fit = { containerWidth: 1900, sidebarVisible: true, resourcesVisible: true };
    expect(fitChatPanels(wide, fit)).toEqual(wide);
  });

  it('does not fit at all when the container has not been measured', () => {
    // 0 means "unknown", not "zero wide". Guessing here would clamp every
    // panel to its minimum on the first paint, before layout exists.
    expect(fitChatPanels(wide, UNKNOWN_FIT)).toEqual(wide);
    expect(fitChatPanels(wide, { ...UNKNOWN_FIT, containerWidth: Number.NaN })).toEqual(wide);
  });

  it('takes the transcript back from a narrowed window, resources first', () => {
    // 1100px: 480 for the transcript and 2 hairlines leaves 618 for panels,
    // and the chosen 420 + 520 does not fit.
    const fit = { containerWidth: 1100, sidebarVisible: true, resourcesVisible: true };
    const got = fitChatPanels(wide, fit);
    expect(got.resources).toBe(RES.min);
    expect(got.sidebar).toBe(378);
    expect(got.sidebar + got.resources + 2).toBe(1100 - MIN_TRANSCRIPT_WIDTH);
  });

  it('never pushes a panel below its own minimum, however narrow the window', () => {
    // Past this point a sliver is the wrong answer; the narrow-width media
    // queries in ChatSection.module.css hide a panel outright instead.
    const got = fitChatPanels(wide, { containerWidth: 600, sidebarVisible: true, resourcesVisible: true });
    expect(got).toEqual({ sidebar: SIDE.min, resources: RES.min });
  });

  it('spends the hidden panel’s width on the visible one', () => {
    const fit = { containerWidth: 1100, sidebarVisible: true, resourcesVisible: false };
    // 1100 - 480 - 1 hairline = 619, so the sidebar keeps all 420 it asked for.
    expect(fitChatPanels(wide, fit).sidebar).toBe(SIDE.max);
  });

  it('range-clamps before fitting', () => {
    const got = fitChatPanels({ sidebar: 9999, resources: -1 }, UNKNOWN_FIT);
    expect(got).toEqual({ sidebar: SIDE.max, resources: RES.def });
  });
});

describe('chat panel persistence', () => {
  it('round-trips a chosen width under its own key', () => {
    setChatPanelWidth('sidebar', 340);
    expect(JSON.parse(localStorage.getItem(CHAT_PANEL_SIZING_KEY) ?? '{}')).toMatchObject({ sidebar: 340 });
    reloadChatPanelSizing();
    expect(getChatPanelSizing().desired.sidebar).toBe(340);
  });

  it('persists the clamped value, never the raw one', () => {
    setChatPanelWidth('resources', 5000);
    expect(readChatPanelWidths().resources).toBe(RES.max);
  });

  it('inherits a width from the legacy shell key on first run', () => {
    // Widths lived in `ashlr.verse.ui.v2` before they were draggable; the
    // upgrade must not reset a size the operator had already chosen.
    localStorage.setItem('ashlr.verse.ui.v2', JSON.stringify({ sidebarWidth: 330, resourcesWidth: 400 }));
    expect(readChatPanelWidths()).toEqual({ sidebar: 330, resources: 400 });
  });

  it('prefers its own key once it exists', () => {
    localStorage.setItem('ashlr.verse.ui.v2', JSON.stringify({ sidebarWidth: 330 }));
    localStorage.setItem(CHAT_PANEL_SIZING_KEY, JSON.stringify({ sidebar: 280, resources: 300 }));
    expect(readChatPanelWidths()).toEqual({ sidebar: 280, resources: 300 });
  });

  it('survives an unreadable or irrelevant payload', () => {
    expect(parseChatPanelWidths('not json')).toBeNull();
    expect(parseChatPanelWidths('[1,2]')).toBeNull();
    expect(parseChatPanelWidths('{"section":"chat"}')).toBeNull();
    localStorage.setItem(CHAT_PANEL_SIZING_KEY, 'not json');
    expect(readChatPanelWidths()).toEqual(defaultChatPanelWidths());
  });
});

describe('chat panel store', () => {
  it('notifies subscribers only when a number actually changed', () => {
    let calls = 0;
    const off = subscribeChatPanels(() => { calls += 1; });
    setChatPanelWidth('sidebar', 300);
    expect(calls).toBe(1);
    setChatPanelWidth('sidebar', 300);
    expect(calls).toBe(1);
    setChatPanelWidth('sidebar', 9999);
    expect(calls).toBe(2);
    setChatPanelWidth('sidebar', 10000); // still clamps to max — no change
    expect(calls).toBe(2);
    off();
  });

  it('steps from the effective width, and resets to the default', () => {
    setChatPanelWidth('sidebar', 300);
    nudgeChatPanelWidth('sidebar', 16);
    expect(getChatPanelSizing().effective.sidebar).toBe(316);
    nudgeChatPanelWidth('sidebar', -64);
    expect(getChatPanelSizing().effective.sidebar).toBe(252);
    resetChatPanelWidth('sidebar');
    expect(getChatPanelSizing().effective.sidebar).toBe(SIDE.def);
  });

  it('keeps the chosen width while a narrow window borrows from it', () => {
    // THE POINT OF THE desired/effective SPLIT. Shrinking the window must not
    // overwrite what the operator asked for, or widening it again would
    // leave the panel stuck at whatever the worst moment allowed.
    setChatPanelWidth('sidebar', SIDE.max);
    setChatPanelWidth('resources', RES.max);
    setChatPanelFit({ containerWidth: 1100, sidebarVisible: true, resourcesVisible: true });
    expect(getChatPanelSizing().effective.resources).toBe(RES.min);
    expect(getChatPanelSizing().desired.resources).toBe(RES.max);
    expect(JSON.parse(localStorage.getItem(CHAT_PANEL_SIZING_KEY) ?? '{}')).toMatchObject({ resources: RES.max });

    setChatPanelFit({ containerWidth: 1900, sidebarVisible: true, resourcesVisible: true });
    expect(getChatPanelSizing().effective.resources).toBe(RES.max);
  });

  it('re-fits when a panel is shown or hidden', () => {
    setChatPanelWidth('sidebar', SIDE.max);
    setChatPanelWidth('resources', RES.max);
    setChatPanelFit({ containerWidth: 1100, sidebarVisible: true, resourcesVisible: true });
    expect(getChatPanelSizing().effective.sidebar).toBe(378);
    setChatPanelFit({ containerWidth: 1100, sidebarVisible: true, resourcesVisible: false });
    expect(getChatPanelSizing().effective.sidebar).toBe(SIDE.max);
  });
});

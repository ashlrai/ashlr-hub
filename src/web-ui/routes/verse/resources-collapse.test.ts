/**
 * resources-collapse.test.ts — spent seats start shut, and an explicit
 * choice survives a reload. Defaults are not written, so a seat that later
 * becomes usable opens itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SeatWindowView } from './seat-subscription.js';
import {
  emptyResourcesCollapse,
  groupIsOpen,
  parseResourcesCollapse,
  readResourcesCollapse,
  reportedLimitBars,
  RESOURCES_COLLAPSE_KEY,
  seatDefaultOpen,
  seatIsOpen,
  toggleGroupCollapse,
  toggleSeatCollapse,
  writeResourcesCollapse,
} from './resources-collapse.js';

function windowView(id: string): SeatWindowView {
  return { id, label: id, usedPercent: 10, limitReached: false, resetText: null, resetsAt: null };
}

beforeEach(() => {
  localStorage.clear();
});

describe('resources collapse defaults', () => {
  it('starts groups open and only a blocked seat shut', () => {
    const state = emptyResourcesCollapse();
    expect(groupIsOpen(state, 'claude')).toBe(true);
    expect(groupIsOpen(state, 'codex')).toBe(true);
    expect(seatDefaultOpen('blocked')).toBe(false);
    expect(seatDefaultOpen('tight')).toBe(true);
    expect(seatDefaultOpen('ready')).toBe(true);
    expect(seatDefaultOpen('unread')).toBe(true);
    expect(seatIsOpen(state, 'claude', 'blocked')).toBe(false);
    expect(seatIsOpen(state, 'codex-personal', 'tight')).toBe(true);
  });

  it('does not invent a limit the seat does not carry, and keeps an unmeasured one', () => {
    const binding = windowView('seven_day_fable');
    const session = windowView('five_hour');
    const unread = { ...windowView('seven_day'), usedPercent: null };
    expect(reportedLimitBars({ kind: 'local', binding: null, others: [session] })).toEqual([]);
    expect(reportedLimitBars({ kind: 'subscription', binding, others: [session, unread] }).map((w) => w.id))
      .toEqual(['seven_day_fable', 'five_hour', 'seven_day']);
    expect(reportedLimitBars({ kind: 'subscription', binding: null, others: [] })).toEqual([]);
  });
});

describe('resources collapse persistence', () => {
  it('round-trips an explicit choice and drops anything that is not one', () => {
    const opened = toggleSeatCollapse(emptyResourcesCollapse(), 'claude', 'blocked');
    const collapsed = toggleGroupCollapse(opened, 'codex');
    writeResourcesCollapse(collapsed);

    const stored = JSON.parse(localStorage.getItem(RESOURCES_COLLAPSE_KEY) ?? '{}') as {
      collapsedGroups: string[];
      seats: Record<string, boolean>;
    };
    expect(stored.collapsedGroups).toEqual(['codex']);
    expect(stored.seats).toEqual({ claude: true });

    const read = readResourcesCollapse();
    expect(groupIsOpen(read, 'codex')).toBe(false);
    expect(groupIsOpen(read, 'claude')).toBe(true);
    // The stored open wins over the blocked default.
    expect(seatIsOpen(read, 'claude', 'blocked')).toBe(true);
    // No stored choice for this id: the live verdict still decides.
    expect(seatIsOpen(read, 'grok', 'blocked')).toBe(false);
    expect(seatIsOpen(read, 'grok', 'ready')).toBe(true);
  });

  it('ignores a corrupt payload rather than collapsing everything', () => {
    localStorage.setItem(RESOURCES_COLLAPSE_KEY, '{not json');
    expect(readResourcesCollapse()).toEqual(emptyResourcesCollapse());
    expect(parseResourcesCollapse(
      '{"collapsedGroups":["claude","nope","claude",3],"seats":{"claude":true,"":false,"ok":"yes","__proto__":true}}',
    )).toEqual({ collapsedGroups: ['claude'], seats: { claude: true } });
  });

  it('toggles back to the default instead of pinning it', () => {
    const opened = toggleSeatCollapse(emptyResourcesCollapse(), 'claude', 'blocked');
    const shutAgain = toggleSeatCollapse(opened, 'claude', 'blocked');
    expect(shutAgain.seats.claude).toBe(false);
    expect(seatIsOpen(shutAgain, 'claude', 'blocked')).toBe(false);
    const reopenedGroup = toggleGroupCollapse(toggleGroupCollapse(emptyResourcesCollapse(), 'grok'), 'grok');
    expect(groupIsOpen(reopenedGroup, 'grok')).toBe(true);
  });
});

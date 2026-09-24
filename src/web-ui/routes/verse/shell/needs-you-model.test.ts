/**
 * needs-you-model + nav-history — the drawer's rules and ⌘[ ⌘] (unit C1).
 */
import { describe, expect, it } from 'vitest';
import type { NeedsYouItem, VerseActivitySources } from '../../../../core/verse/workbench-types.js';
import { actionOf, ago, confirmCopy, describeSilence, itemsForSplit, splitCounts, splitCoverage, until } from './needs-you-model.js';
import { canGoBack, canGoForward, cycleRecent, EMPTY_NAV_HISTORY, NAV_HISTORY_LIMIT, pushNav, stepNav } from './nav-history.js';

function item(kind: NeedsYouItem['kind'], over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: `x:${kind}:${Math.random()}`,
    source: 'fleet',
    kind,
    severity: 'warn',
    title: `A ${kind}`,
    detail: null,
    since: '2026-09-24T10:00:00Z',
    expiresAt: null,
    subject: { repo: null, pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'section', section: 'fleet', anchor: null },
    actions: [
      { kind: 'veto', label: 'Veto', request: { method: 'POST', path: '/api/verse/leader', body: {} }, confirm: null, destructive: true },
      { kind: 'done', label: 'Mark done', request: { method: 'POST', path: '/api/verse/leader', body: {} }, confirm: null, destructive: false },
    ],
    ...over,
  };
}

const ALL_OK: VerseActivitySources = { approvals: 'ok', authority: 'ok', fleet: 'ok', leader: 'ok', chats: 'ok', accounts: 'ok' };

describe('splits', () => {
  it('files items by kind and counts every split', () => {
    const items = [item('approval'), item('owner-lane-pr'), item('veto-window'), item('chat-failed'), item('reconnect')];
    expect(itemsForSplit(items, 'approvals').map((i) => i.kind)).toEqual(['approval', 'owner-lane-pr']);
    expect(splitCounts(items)).toEqual({ all: 5, approvals: 2, fleet: 1, chats: 1, accounts: 1 });
  });

  it('only vouches for a split whose every producer answered', () => {
    expect(splitCoverage(ALL_OK, 'all').vouched).toBe(true);
    // An owner-lane PR is an Approval from the FLEET producer: fleet silent → Approvals not vouched.
    const fleetDown = { ...ALL_OK, fleet: 'unavailable' as const, leader: 'error' as const };
    const cov = splitCoverage(fleetDown, 'approvals');
    expect(cov.vouched).toBe(false);
    expect(describeSilence(cov)).toBe("The fleet isn't reporting in this build and the Leader failed to answer");
    expect(splitCoverage(fleetDown, 'chats').vouched).toBe(true);
    expect(splitCoverage(null, 'accounts').vouched).toBe(false);
  });
});

describe('actions', () => {
  it('always confirms a veto, even without copy, and never confirms a plain done', () => {
    const i = item('veto-window');
    expect(confirmCopy(i, actionOf(i, 'veto')!)).toEqual({ title: 'Veto this action?', body: 'A veto-window', confirmLabel: 'Veto' });
    expect(confirmCopy(i, actionOf(i, 'done')!)).toBeNull();
    expect(actionOf(i, 'approve')).toBeNull();
  });

  it('words time in operator language', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(ago('2026-09-24T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-09-24T11:30:00Z', now)).toBe('30m ago');
    expect(ago('nope', now)).toBe('—');
    expect(until('2026-09-24T12:24:00Z', now)).toBe('in 24m');
    expect(until('2026-09-24T11:00:00Z', now)).toBe('expired');
  });
});

describe('nav history', () => {
  it('drops the forward stack on a new visit and caps its length', () => {
    let h = pushNav(EMPTY_NAV_HISTORY, { section: 'command', sessionId: null });
    h = pushNav(h, { section: 'fleet', sessionId: 'ignored' });
    expect(h.entries[1]).toEqual({ section: 'fleet', sessionId: null });
    h = pushNav(h, { section: 'mind', sessionId: null });
    h = stepNav(h, -1)!.history;
    expect(canGoForward(h)).toBe(true);
    h = pushNav(h, { section: 'growth', sessionId: null });
    expect(h.entries.map((e) => e.section)).toEqual(['command', 'fleet', 'growth']);
    expect(canGoForward(h)).toBe(false);
    for (let i = 0; i < NAV_HISTORY_LIMIT + 10; i += 1) h = pushNav(h, { section: i % 2 ? 'fleet' : 'mind', sessionId: null });
    expect(h.entries).toHaveLength(NAV_HISTORY_LIMIT);
    expect(canGoBack(h)).toBe(true);
  });

  it('refines "Chat, nothing open" into the chat that opened', () => {
    let h = pushNav(EMPTY_NAV_HISTORY, { section: 'chat', sessionId: null });
    h = pushNav(h, { section: 'chat', sessionId: 'a' });
    expect(h.entries).toEqual([{ section: 'chat', sessionId: 'a' }]);
    h = pushNav(h, { section: 'chat', sessionId: 'b' });
    expect(h.entries).toHaveLength(2);
  });

  it('needs two chats to cycle', () => {
    expect(cycleRecent(['a'], null, 1, 0)).toBeNull();
    expect(cycleRecent(['a', 'b', 'c'], null, -1, 0)!.sessionId).toBe('c');
  });
});

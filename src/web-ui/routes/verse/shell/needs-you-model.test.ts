/**
 * needs-you-model + nav-history — the drawer's rules and ⌘[ ⌘] (unit C1).
 */
import { describe, expect, it, vi } from 'vitest';
import type { NeedsYouItem, VerseActivitySources } from '../../../../core/verse/workbench-types.js';
import {
  actionOf,
  confirmCopy,
  describeSilence,
  itemsForSplit,
  needsYouRowView,
  readableItemTitle,
  splitCounts,
  splitCoverage,
  until,
} from './needs-you-model.js';
import { canGoBack, canGoForward, cycleRecent, EMPTY_NAV_HISTORY, NAV_HISTORY_LIMIT, pushNav, stepNav } from './nav-history.js';
import { activity, approvalNeed, chatFailedNeed, vetoNeed } from './shell-fixtures.test-support.js';

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

  it('confirms with the readable title, not the wire text', () => {
    const i = item('veto-window', { title: 'codex run: Rename the flag.' });
    expect(confirmCopy(i, actionOf(i, 'veto')!)!.body).toBe('Rename the flag.');
  });

  it('words deadlines in operator language', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(until('2026-09-24T12:24:00Z', now)).toBe('in 24m');
    expect(until('2026-09-24T11:00:00Z', now)).toBe('expired');
  });

  it('shell fixtures are built on the clock, so their veto window can never have expired', () => {
    // Regression: the fixtures used to hang off a fixed instant, and the
    // drawer test read "closes expired" once the wall clock passed it.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const at of ['2026-09-24T12:30:00Z', '2031-01-01T00:00:00Z']) {
        vi.setSystemTime(Date.parse(at));
        expect(until(vetoNeed().expiresAt!, Date.now())).toBe('in 24m');
        expect(activity().generatedAt).toBe(new Date(at).toISOString());
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The live row that motivated this: a sandboxed Claude run whose title the
 * server prefixed with the proposal kind and sliced mid-word, whose detail is
 * a packed run summary, and whose age was "38d".
 */
describe('row view', () => {
  const NOW = Date.parse('2026-09-24T12:00:00.000Z');
  const RAW_TITLE = 'patch: claude run: Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a deg';
  const RAW_DETAIL = 'TITRR claude:claude-fable-5 run produced 2 file(s) (+384/-0). Review before applying.';
  const live = () => approvalNeed('p-live', { title: RAW_TITLE, detail: RAW_DETAIL, since: '2026-08-17T12:00:00.000Z' });

  it('reads the live approval like the approvals detail view does', () => {
    const view = needsYouRowView(live(), NOW);
    expect(view.kindLabel).toBe('Patch · Claude run');
    expect(view.title).toBe('Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a…"');
    expect(view.fullTitle).toBe(RAW_TITLE);
    expect(view.run).toMatchObject({
      stats: '2 files · +384 −0',
      statsSpoken: '2 files changed, 384 lines added, 0 removed',
      source: 'Test-and-repair loop',
      partial: false,
      model: 'claude:claude-fable-5',
    });
    expect(view.run!.sourceHint).toMatch(/^TITRR — Test, Iterate, Test, Refine, Repeat/);
    expect(view.detail).toBe('Review before applying.');
    expect(view.repo).toBe('binshield');
    expect(view.repoFull).toBeUndefined();
    expect(view.age).toBe('38 days ago');
    expect(view.ageStamp).toMatch(/2026/);
  });

  it('names a pull request in words and leaves a whole title whole', () => {
    expect(readableItemTitle(approvalNeed('p-1'))).toEqual({ kindLabel: 'Pull request', text: 'fix the flaky snapshot test' });
    expect(readableItemTitle({ kind: 'approval', title: 'note: Untitled proposal' })).toEqual({ kindLabel: 'Note', text: 'Untitled proposal' });
  });

  it('only takes an APPROVAL title apart — other kinds keep their colons', () => {
    const chat = needsYouRowView(chatFailedNeed(), NOW);
    expect(chat.kindLabel).toBeNull();
    expect(chat.title).toBe('Failed: Migrate the store');
    expect(chat.run).toBeNull();
    expect(chat.detail).toBe('CLI exited 1');
    expect(readableItemTitle({ kind: 'owner-lane-pr', title: 'patch: not a proposal prefix' }).text).toBe('patch: not a proposal prefix');
    // …but a run prefix is an engine wherever it appears.
    expect(readableItemTitle({ kind: 'owner-lane-pr', title: 'codex run: Rename the flag.' })).toEqual({ kindLabel: 'Codex run', text: 'Rename the flag.' });
  });

  it('prints a repo slug by name with the slug as its tooltip, and an unparseable age honestly', () => {
    const view = needsYouRowView(item('owner-hold', { subject: { repo: 'ashlrai/binshield', pr: null, seatId: null, sessionId: null, engine: null }, since: 'nope' }), NOW);
    expect(view.repo).toBe('binshield');
    expect(view.repoFull).toBe('ashlrai/binshield');
    expect(view.age).toBe('at an unknown time');
    expect(view.ageStamp).toBeUndefined();
  });

  it('drops a partial word the server clip left before its ellipsis', () => {
    const clipped = approvalNeed('p-2', { title: 'patch: Rework the worker scan pipeline so a degraded upstream never stalls the whole queue and every retr…' });
    expect(needsYouRowView(clipped, NOW).title).toBe('Rework the worker scan pipeline so a degraded upstream never stalls the whole queue and every…');
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

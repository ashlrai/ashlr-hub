/**
 * The per-seat burn-downs with their own data (useSeatBurns), as Usage mounts
 * them (audit 14 moved them off Command). These cases moved here from
 * CommandSection.test.tsx unchanged in substance: Claude's reset words, the
 * shared 0–100% frame, and the recorded seat history (3.10.1) with its
 * 5-minute poll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll, runQuery } from '../../../data/cache.js';
import { VERSE_BOOTSTRAP_KEY } from '../verse-queries.js';
import { stubSurfaceFetch } from './fetch-stub.test-support.js';
import { budgetView, seatHistory } from './fixtures.test-support.js';
import { LiveSeatBurnDowns } from './SeatBurnDowns.js';
import { SEAT_HISTORY_POLL_MS, resetSeatReadingsForTest } from './useSeatBurns.js';
import { mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let vp: ViewportMock | null = null;

beforeEach(() => {
  evictAll();
  resetSeatReadingsForTest();
  vp = mockWideViewport();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vp?.restore();
  vp = null;
});

/** "Sep 26 at 3pm (America/New_York)" — the collector's reset wording for an on-the-hour instant. */
function newYorkWords(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', hour12: true }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('month')} ${part('day')} at ${part('hour')}${part('dayPeriod').toLowerCase()} (America/New_York)`;
}

const historyCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/verse/budget/history')).length;

describe('LiveSeatBurnDowns — Claude\'s reset words', () => {
  // P4 regression: the Claude card in production has no machine reset time.
  it('draws Claude\'s readings with its own reset words when it publishes no reset time', async () => {
    const now = Date.now();
    const view = budgetView('live', now);
    view.headroom[0] = { ...view.headroom[0]!, resetAt: null };
    // The roster is read from the cache the console loads at startup — never fetched here.
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => ({
      seats: [{ id: 'claude-a', capacity: { windows: [
        { id: 'five_hour', usedPercent: 74, resetsAt: null, resetDescription: 'Sep 24 at 5pm (America/New_York)', limitReached: false, measured: true },
        { id: 'seven_day', usedPercent: 54, resetsAt: null, resetDescription: 'Sep 25 at 7pm (America/New_York)', limitReached: false, measured: true },
      ] } }],
    }));
    const { fetchMock } = stubSurfaceFetch({ kind: 'live', now });
    render(<LiveSeatBurnDowns budget={view} />);
    const seats = await screen.findByRole('group', { name: 'Seat windows' });
    await waitFor(() => expect(seats).toHaveTextContent('26% left · resets Sep 24 at 5pm (America/New_York)'));
    expect(within(seats).queryByText(/No window reading/)).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/verse/bootstrap'))).toBe(false);
  });

  // The live 3.10.0 defect: "Claude Code · weekly" drew one minute of samples
  // on a 0–40% axis and said the reset was "only in words" although the words
  // name a time. They now place the reset: the whole week, 0–100%, one marker.
  it('places Claude\'s weekly reset from its words: the whole window on the shared 0–100% axis', async () => {
    const now = Date.now();
    const words = newYorkWords(Math.ceil((now + 2 * DAY) / HOUR) * HOUR);
    const view = budgetView('live', now);
    view.headroom[0] = {
      ...view.headroom[0]!,
      bindingWindow: 'weekly',
      weeklyUsedPercent: 97,
      resetAt: null,
      reasons: ['The weekly window is 97% used; 40% is kept for you, so autonomy stops at 60%'],
    };
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => ({
      seats: [{ id: 'claude-a', capacity: { windows: [
        { id: 'five_hour', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false, measured: true },
        { id: 'seven_day', usedPercent: 97, resetsAt: null, resetDescription: words, limitReached: false, measured: true },
      ] } }],
    }));
    // The server records the snapshot behind every budget read (capacity-history-api.ts),
    // so its history ends on the same 97% the budget route serves.
    const recorded = seatHistory('live', now);
    recorded.series = recorded.series.map((s) =>
      s.seatId === 'claude-a' && s.window === 'weekly' ? { ...s, points: [...s.points, [Date.parse(view.sampledAt) - 1_000, 97] as [number, number]] } : s,
    );
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/budget/history': recorded } });
    render(<LiveSeatBurnDowns budget={view} />);
    const card = await screen.findByRole('figure', { name: 'Claude (claude-a) · weekly' });
    await waitFor(() => expect(card).toHaveTextContent(`3% left · resets ${words} · The weekly window is 97% used`));
    expect(card).not.toHaveTextContent(/only in words|could not be placed/);
    // The words are said once, in the header — never again as "(resets … (America/New_York))".
    expect(card.textContent?.split(words)).toHaveLength(2);
    expect(card).not.toHaveTextContent(/\(resets|\.\./);
    const labels = Array.from(card.querySelectorAll('svg text')).map((t) => t.textContent ?? '');
    expect(labels.filter((l) => l.startsWith('Resets '))).toHaveLength(1);
    const ticks = labels.filter((l) => /^\d+%$/.test(l)).map((l) => Number(l.slice(0, -1)));
    expect(Math.max(...ticks)).toBe(100);
    expect(card.querySelector('[data-role="pace"]')).not.toBeNull();
    expect(card.querySelector('[data-role="reserve-label"]')).toHaveTextContent('Reserved for you · 40%');
  });
});

// 3.10.1: the burn-downs keep the whole window across a reload — the
// server's recorded seat history (GET /api/verse/budget/history) is merged
// under this page's own readings.
describe('LiveSeatBurnDowns — recorded seat history', () => {
  it('draws the recorded window after a reload, without the "since Verse opened" note', async () => {
    const now = Date.now();
    const { fetchMock } = stubSurfaceFetch({ kind: 'live', now });
    render(<LiveSeatBurnDowns budget={budgetView('live', now)} />);
    const grok = await screen.findByRole('figure', { name: 'Grok (grok-a) · weekly' });
    // Recorded since the window opened three days ago: nothing to apologise for.
    await waitFor(() => expect(historyCalls(fetchMock)).toBe(1));
    await waitFor(() => expect(grok).not.toHaveTextContent('No readings before'));
    expect(grok).not.toHaveTextContent('Verse opened');
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/verse/budget/history?days=8')).toBe(true);
  });

  // The history read serves a file of up to 2 MiB, so it rides a 5-minute
  // poll — never the budget's 30–60 s one.
  it('re-asks the recorded history on the 5-minute poll only', { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.now();
    const { fetchMock } = stubSurfaceFetch({ kind: 'dark', now });
    render(<LiveSeatBurnDowns budget={budgetView('dark', now)} />);
    await waitFor(() => expect(historyCalls(fetchMock)).toBe(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(SEAT_HISTORY_POLL_MS - 2_000); });
    expect(historyCalls(fetchMock)).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await waitFor(() => expect(historyCalls(fetchMock)).toBe(2));
  });

  // The "since Verse opened" note is said ONCE, as the seat grid's tooltip —
  // never repeated on each card.
  it('says "since Verse opened" once, on the grid, when the server has no recorded history', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/budget/history': null } });
    render(<LiveSeatBurnDowns budget={budgetView('live', now)} />);
    const grok = await screen.findByRole('figure', { name: 'Grok (grok-a) · weekly' });
    const grid = screen.getByRole('group', { name: 'Seat windows' });
    await waitFor(() => expect(grid).toHaveAttribute('title', 'Lines without recorded history start when Verse opened.'));
    expect(grok).not.toHaveTextContent('Verse opened');
  });

  it('keeps the grid note when recorded history is empty too (nothing was recorded yet)', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/budget/history': { v: 1, generatedAt: new Date(now).toISOString(), days: 8, since: new Date(now - 8 * DAY).toISOString(), oldestAt: null, series: [], truncated: false } } });
    render(<LiveSeatBurnDowns budget={budgetView('live', now)} />);
    await screen.findByRole('figure', { name: 'Grok (grok-a) · weekly' });
    const grid = screen.getByRole('group', { name: 'Seat windows' });
    await waitFor(() => expect(grid).toHaveAttribute('title', 'Lines without recorded history start when Verse opened.'));
  });
});

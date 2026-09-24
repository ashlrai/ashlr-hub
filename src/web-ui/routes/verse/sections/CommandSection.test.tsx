import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COMMAND_HISTORY_POLL_MS, COMMAND_SLOW_POLL_MS, CommandSection } from './CommandSection.js';
import { evictAll, runQuery } from '../../../data/cache.js';
import { VERSE_BOOTSTRAP_KEY } from '../verse-queries.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { authorityStatus, budgetView, fleetHistory, fleetLive } from '../command/fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';

const TOKEN = 'a'.repeat(64);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let vp: ViewportMock | null = null;

beforeEach(() => {
  evictAll();
  resetActivityForTest();
  clearMutationToken();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  vp = mockWideViewport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  vp?.restore();
  vp = null;
});

async function ready() {
  await waitFor(() => expect(screen.getByTestId('verdict')).toHaveTextContent(/building|dark|Propose|unknown/));
}

describe('CommandSection — live fleet', () => {
  it('answers the questions top to bottom: verdict, needs you, Leader, KPIs, seats, runs', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    expect(screen.getByRole('heading', { level: 2, name: 'Command' })).toBeInTheDocument();
    expect(screen.getByTestId('verdict')).toHaveTextContent('Autonomous · 5 building · 7 merged today · 1 revert · Claude 40% reserved for you');
    const needs = screen.getByRole('region', { name: 'Needs you (4)' });
    expect(within(needs).getByText('measurably quarantined — post-merge suite failed, reverted')).toBeInTheDocument();
    expect(within(needs).getByRole('link', { name: /Open/ })).toHaveAttribute('href', 'https://github.com/ashlrai/ashlrcode/pull/81');
    const leader = screen.getByRole('region', { name: 'Leader' });
    expect(within(leader).getByText(/Judge queue on grok-a/)).toBeInTheDocument();
    expect(within(leader).getByText(/\+4 merges\/day by/)).toBeInTheDocument();
    expect(within(leader).getByRole('timer', { name: /Applies in 1[78]m unless vetoed/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Key numbers' })).toHaveTextContent('Merged · 7d23');
    await waitFor(() => expect(screen.getByRole('group', { name: 'Capacity per seat' })).toBeInTheDocument());
    expect(screen.getByRole('figure', { name: 'Last 12 hours' })).toBeInTheDocument();
  });

  it('lowers the switch instantly — no confirmation, no Touch ID (I1)', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live', post: () => json(authorityStatus('live', Date.now(), { switch: 'off', effectiveSwitch: 'off' })) });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/authority', body: { action: 'switch', to: 'off' } }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lowers from the keyboard too (arrow keys on the switch)', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    screen.getByRole('radio', { name: 'Autonomous' }).focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(posted[0]?.body).toEqual({ action: 'switch', to: 'propose' }));
  });

  it('asks for confirmation before Stop, and sends nothing on Cancel', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    const dialog = screen.getByRole('dialog', { name: 'Stop the fleet?' });
    // Destructive confirm starts on Cancel: a stray Enter never stops the fleet.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posted).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop fleet' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/authority', body: { action: 'stop' } }]));
  });

  it('asks for the mutation token when none is held, after the confirmation', async () => {
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop fleet' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it('vetoes a Leader action after confirming', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Veto: Raise Grok to 3 lanes' }));
    expect(screen.getByRole('dialog', { name: 'Veto this action?' })).toHaveTextContent('“Raise Grok to 3 lanes” will not apply.');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Veto' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/leader', body: { action: 'veto', actionId: 'a2' } }]));
  });

  it('runs a Needs-you item action through its confirmation', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Resume repo' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Resume measurably now?' })).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(posted[0]).toEqual({ url: '/api/verse/fleet/live', body: { action: 'resume-repo', repo: 'ashlrai/measurably', kind: 'quarantine' } }));
  });

  it('opens the budget with the grant ceiling stated', async () => {
    stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    await user.click(screen.getByRole('button', { name: /Budget/ }));
    expect(screen.getByRole('dialog', { name: 'Budget' })).toHaveTextContent('Your grant allows up to Balanced.');
  });
});

// P4 regressions: the Claude card in production (no machine reset time) and
// the Spend caption (needs the live budget to list subscription percent).
describe('CommandSection — seat capacity and metered spend', () => {
  it('puts subscription window usage in the metered-spend caption', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Key numbers' })).toHaveTextContent('subscriptions: Claude (claude-a) 74% · Grok (grok-a) 31% · Codex (codex-a) 100% of window used'),
    );
  });

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
    const { fetchMock } = stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/budget': view } });
    render(<CommandSection />);
    await ready();
    const seats = await screen.findByRole('group', { name: 'Capacity per seat' });
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
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/budget': view } });
    render(<CommandSection />);
    await ready();
    const card = await screen.findByRole('figure', { name: 'Claude (claude-a) · weekly' });
    await waitFor(() => expect(card).toHaveTextContent(`3% left · resets ${words} · The weekly window is 97% used`));
    expect(card).not.toHaveTextContent(/only in words|could not be placed/);
    const labels = Array.from(card.querySelectorAll('svg text')).map((t) => t.textContent ?? '');
    expect(labels.filter((l) => l.startsWith('Resets '))).toHaveLength(1);
    const ticks = labels.filter((l) => /^\d+%$/.test(l)).map((l) => Number(l.slice(0, -1)));
    expect(Math.max(...ticks)).toBe(100);
    expect(card.querySelector('[data-role="pace"]')).not.toBeNull();
    expect(card.querySelector('[data-role="reserve-label"]')).toHaveTextContent('Reserved for you · 40%');
  });
});

/** "Sep 26 at 3pm (America/New_York)" — the collector's reset wording for an on-the-hour instant. */
function newYorkWords(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', hour12: true }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('month')} ${part('day')} at ${part('hour')}${part('dayPeriod').toLowerCase()} (America/New_York)`;
}

// 3.10.1: the burn-downs keep the whole window across a reload — the
// server's recorded seat history (GET /api/verse/budget/history) is merged
// under this page's own readings.
describe('CommandSection — recorded seat history', () => {
  const historyCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/verse/budget/history')).length;

  it('draws the recorded window after a reload, without the "since Verse opened" note', async () => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    const grok = await screen.findByRole('figure', { name: 'Grok (grok-a) · weekly' });
    // Recorded since the window opened three days ago: nothing to apologise for.
    await waitFor(() => expect(historyCalls(fetchMock)).toBe(1));
    await waitFor(() => expect(grok).not.toHaveTextContent('Readings since Verse opened'));
    expect(grok).not.toHaveTextContent('No reading was recorded');
    // Asked once, on mount — the 30 s budget poll never re-asks it.
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/verse/budget/history?days=8')).toBe(true);
    expect(COMMAND_HISTORY_POLL_MS).toBeGreaterThanOrEqual(3 * 60_000);
    expect(COMMAND_HISTORY_POLL_MS).toBeGreaterThan(COMMAND_SLOW_POLL_MS);
  });

  it('keeps the "since Verse opened" note when the server has no recorded history', async () => {
    stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/budget/history': null } });
    render(<CommandSection />);
    await ready();
    const grok = await screen.findByRole('figure', { name: 'Grok (grok-a) · weekly' });
    await waitFor(() => expect(grok).toHaveTextContent('Readings since Verse opened'));
  });

  it('keeps the note when recorded history is empty too (nothing was recorded yet)', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/budget/history': { v: 1, generatedAt: new Date(now).toISOString(), days: 8, since: new Date(now - 8 * DAY).toISOString(), oldestAt: null, series: [], truncated: false } } });
    render(<CommandSection />);
    await ready();
    const grok = await screen.findByRole('figure', { name: 'Grok (grok-a) · weekly' });
    await waitFor(() => expect(grok).toHaveTextContent('Readings since Verse opened'));
  });
});

describe('CommandSection — dark since', () => {
  it('never calls an idle fleet dark from fleet history\'s last-activity date', async () => {
    const now = Date.now();
    const quiet = { ...fleetHistory('live', now), darkSince: '2026-08-18T12:00:00Z' };
    // Nothing building, so the verdict WOULD name a dark-since date if it had one.
    const base = fleetLive('live', now);
    const idle = { ...base, darkSince: null, summary: { ...base.summary, building: 0 } };
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/fleet/history': quiet, '/api/verse/fleet/live': idle } });
    render(<CommandSection />);
    await ready();
    expect(screen.getByTestId('verdict')).not.toHaveTextContent(/dark since/i);
    expect(document.body).not.toHaveTextContent(/Fleet dark since Aug 18/);
  });
});

describe('CommandSection — raising past the grant', () => {
  it('opens the Touch ID sheet with scope and expiry, signs the exact draft, then switches', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const granted = authorityStatus('live', now, { switch: 'propose', effectiveSwitch: 'propose', maxSwitchWithoutGrant: 'autonomous' });
    const { posted } = stubSurfaceFetch({
      kind: 'sparse',
      now,
      post: (_url, body) => (body['action'] === 'grant' ? json(granted) : json(authorityStatus('live', now))),
    });
    const user = userEvent.setup();
    render(<CommandSection />);
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Autonomous (needs a new grant — Touch ID)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Approve a standing grant' });
    // Nothing is sent before Mason approves.
    expect(posted).toEqual([]);
    await waitFor(() => expect(within(sheet).getByText(/30 days, until/)).toBeInTheDocument());
    expect(within(sheet).getByRole('cell', { name: 'ashlrai/ashlrcode' })).toBeInTheDocument();
    expect(within(sheet).getByText(/keeps 40% for you/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Rollout ladder \(4 stages/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Approve with Touch ID' }));
    await waitFor(() => expect(posted.map((p) => p.body['action'])).toEqual(['grant', 'switch']));
    expect(posted[0]!.body['draftDigest']).toMatch(/^[0-9a-f]{64}$/);
    expect(posted[1]!.body).toEqual({ action: 'switch', to: 'autonomous' });
  });
});

describe('CommandSection — dark and not-landed states', () => {
  it('designs the dark state everywhere instead of drawing empty axes', async () => {
    stubSurfaceFetch({ kind: 'dark' });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByTestId('verdict')).toHaveTextContent('Off · fleet dark since Sep 1'));
    expect(screen.getByText('Fleet dark since Sep 1')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Leader' })).toHaveTextContent('No memo yet');
    expect(screen.getByRole('button', { name: /Grant: No grant/ })).toBeInTheDocument();
    expect(screen.getByText('All clear')).toBeInTheDocument();
  });

  it('treats a module that has not landed as one card\'s absence, never a false all-clear', async () => {
    stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/authority': null, '/api/verse/activity': null, '/api/verse/leader': null } });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByTestId('verdict')).toHaveTextContent('Autonomy unknown'));
    expect(screen.getByRole('radio', { name: 'Off' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent('not in this build yet');
    expect(screen.queryByText('All clear')).toBeNull();
    expect(screen.getByRole('region', { name: 'Leader' })).toHaveTextContent('The Leader is not in this build yet');
  });

  it('refuses an all-clear when a producer is silent', async () => {
    const quiet = { ...(await import('../command/fixtures.test-support.js')).activitySnapshot('dark') };
    quiet.sources = { ...quiet.sources, fleet: 'unavailable' };
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/activity': quiet } });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Needs you (0)' })).toHaveTextContent('fleet is not answering — this is not an all-clear'));
  });
});

describe('CommandSection — 375 px', () => {
  it('shrinks the bar to [Autonomy][■], keeps Needs you first and shows 6 hours', async () => {
    vp?.restore();
    vp = mockCompactViewport({ dark: true });
    stubSurfaceFetch({ kind: 'live' });
    const { container } = render(<CommandSection />);
    await ready();
    const bar = screen.getByRole('toolbar', { name: 'Autonomy controls' });
    expect(within(bar).getByRole('button', { name: 'Stop the fleet' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /Budget/ })).toBeNull();
    expect(within(bar).getByRole('radio', { name: 'Autonomous' })).toHaveTextContent('Auto');
    // Budget and grant move under the bar.
    expect(screen.getByRole('button', { name: /Budget/ })).toBeInTheDocument();
    const regions = [...container.querySelectorAll('section[aria-labelledby]')].map((s) => s.textContent ?? '');
    const needsIndex = regions.findIndex((t) => t.startsWith('Needs you'));
    const leaderIndex = regions.findIndex((t) => t.startsWith('Leader'));
    expect(needsIndex).toBeGreaterThan(-1);
    expect(needsIndex).toBeLessThan(leaderIndex);
    expect(screen.getByRole('figure', { name: 'Last 6 hours' })).toBeInTheDocument();
    // Every grid cell is full width at compact.
    for (const cell of container.querySelectorAll('[data-span]')) expect((cell as HTMLElement).style.gridColumn).toBe('span 12');
  });
});

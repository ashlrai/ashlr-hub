import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COMMAND_HISTORY_POLL_MS, COMMAND_SLOW_POLL_MS, CommandSection } from './CommandSection.js';
import { evictAll, runQuery } from '../../../data/cache.js';
import { VERSE_BOOTSTRAP_KEY } from '../verse-queries.js';
import { VERSE_HEALTH_KEY } from '../health/health-queries.js';
import { closeResources, getResourcesUi } from '../resources/resources-store.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { draftRefused, stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { DARK_SINCE, activitySnapshot, authorityStatus, fleetHistory, fleetLive } from '../command/fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { overview as cloudOverview, task as cloudTask } from '../cloud/cloud-fixtures.test-support.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';

const TOKEN = 'a'.repeat(64);
const HOUR = 3_600_000;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
/** "Sep 1" — the viewer's local day for an instant, as the dark-since labels word it (never a hard-coded day). */
const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearMutationToken();
  vp?.restore();
  vp = null;
});

async function ready() {
  // The verdict line — or, with autonomy off, the banner that stands in for it.
  await waitFor(() => expect(screen.queryByTestId('autonomy-off') ?? screen.getByTestId('verdict')).toHaveTextContent(/building|dark|Propose|unknown|off/i));
}

/** Fleet history with nothing in it: a dormant fleet's KPI row has no figure to show. */
const emptyHistory = (now: number) => {
  const h = fleetHistory('dark', now);
  return { ...h, days: h.days.map((d) => ({ ...d, merges: { realized: 0 }, estCostUsd: 0 })) };
};

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
    // Autonomy is on: no banner, and nothing asks the server to draft a grant.
    expect(screen.queryByTestId('autonomy-off')).toBeNull();
  });

  it('mounts the Cloud card right after the seat strip (3.11), and a server without the lane shows no card', async () => {
    stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/cloud': cloudOverview({ tasks: [cloudTask('running')] }) } });
    const { unmount } = render(<CommandSection />);
    await ready();
    const cloud = await screen.findByRole('region', { name: 'Cloud' });
    expect(await within(cloud).findByText('$241 of $250 · estimate')).toBeInTheDocument();
    const seats = await screen.findByRole('group', { name: 'Capacity per seat' });
    expect(seats.compareDocumentPosition(cloud) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cloud.compareDocumentPosition(screen.getByRole('figure', { name: 'Last 12 hours' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    evictAll();
    stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    await waitFor(() => expect(screen.getByRole('group', { name: 'Capacity per seat' })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Cloud' })).toBeNull());
    expect(screen.queryByText('The cloud lane is not in this build yet.')).toBeNull();
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
// the Spend caption (one short line; subscription usage lives on the seat cards).
describe('CommandSection — seat capacity and metered spend', () => {
  it('keeps the metered-spend caption to one short line, without subscription usage', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    const kpis = screen.getByRole('group', { name: 'Key numbers' });
    await waitFor(() => expect(kpis).toHaveTextContent('Metered spend · 7d'));
    expect(kpis).not.toHaveTextContent('subscriptions:');
    expect(kpis).not.toHaveTextContent('of window used');
  });

  // Audit 14: one compact strip replaces the tall burn-down cards (they live on Usage).
  it('shows every seat\'s headroom in one compact strip: left, reset, autonomy — and opens Resources', async () => {
    const now = Date.now();
    // The roster is read from the cache the console loads at startup — never fetched here.
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => ({
      seats: [{ id: 'claude-a', engine: 'claude', label: 'Claude Max', health: { state: 'ready', summary: null, windows: [], observedAt: null }, capacity: {
        planType: 'max', usability: 'tight', observedAt: null, evidenceSource: 'collector', notes: [], credits: null,
        binding: { id: 'five_hour', usedPercent: 74, resetsAt: null, resetDescription: 'Sep 24 at 5pm (America/New_York)', limitReached: false, measured: true },
        windows: [
          { id: 'five_hour', usedPercent: 74, resetsAt: null, resetDescription: 'Sep 24 at 5pm (America/New_York)', limitReached: false, measured: true },
          { id: 'seven_day', usedPercent: 54, resetsAt: null, resetDescription: 'Sep 25 at 7pm (America/New_York)', limitReached: false, measured: true },
        ],
      } }],
    }));
    const { fetchMock } = stubSurfaceFetch({ kind: 'live', now });
    render(<CommandSection />);
    await ready();
    const seats = screen.getByRole('region', { name: 'Seats' });
    const claude = await within(seats).findByRole('button', { name: /^Claude Max: 26% left/ });
    expect(claude).toHaveTextContent('Claude Max26% left');
    expect(claude).toHaveTextContent('resets Sep 24 at 5pm (America/New_York)');
    // The router holds Claude above its 70% 5-hour ceiling.
    expect(claude).toHaveTextContent('Held back');
    expect(within(seats).queryByRole('figure')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/verse/bootstrap'))).toBe(false);
    await userEvent.setup().click(claude);
    expect(getResourcesUi().open).toBe(true);
    closeResources();
  });

  // Audit 20: the local seat said "Takes autonomous work" while the rail said "readiness not reported".
  it('says "Status unknown" when the router calls the local seat eligible but its readiness was never reported', async () => {
    const now = Date.now();
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => ({
      seats: [{ id: 'local-qwen', engine: 'local', label: 'Local Qwen', health: { state: 'unknown', summary: null, windows: [], observedAt: null } }],
    }));
    await runQuery(VERSE_HEALTH_KEY, async () => ({ checkedAt: new Date(now).toISOString(), seats: [] }));
    stubSurfaceFetch({ kind: 'live', now });
    render(<CommandSection />);
    await ready();
    const local = await within(screen.getByRole('region', { name: 'Seats' })).findByRole('button', { name: /^Local Qwen/ });
    expect(local).toHaveTextContent('Status unknown');
    expect(local).not.toHaveTextContent('Eligible');
    expect(document.body).not.toHaveTextContent('Takes autonomous work');
  });
});

// Review 3.10.1: Needs-you named a seat by its raw id ("claude-a · 2 hours
// ago") while the burn-down beside it said the seat's label.
describe('CommandSection — Needs-you names seats', () => {
  function reconnect(now: number) {
    const activity = activitySnapshot('live', now);
    activity.needsYou = [...activity.needsYou, {
      id: 'accounts:reconnect:claude-a', source: 'accounts', kind: 'reconnect', severity: 'high', title: 'Claude Max is signed out', detail: null,
      since: new Date(now - 2 * HOUR).toISOString(), expiresAt: null,
      subject: { repo: null, pr: null, seatId: 'claude-a', sessionId: null, engine: 'claude' }, target: { kind: 'seat', seatId: 'claude-a' }, actions: [],
    }];
    return activity;
  }

  it('by the roster label, with the id as the tooltip', async () => {
    const now = Date.now();
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => ({ seats: [{ id: 'claude-a', label: 'Claude Max', capacity: null }] }));
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/activity': reconnect(now) } });
    render(<CommandSection />);
    await ready();
    const row = (await screen.findByText('Claude Max is signed out')).closest('li')!;
    await waitFor(() => expect(within(row).getByText('Claude Max', { selector: 'span[title]' })).toHaveAttribute('title', 'claude-a'));
    expect(row.textContent).not.toContain('claude-a');
  });

  it('by the budget route\'s label when no roster is cached', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/activity': reconnect(now) } });
    render(<CommandSection />);
    await ready();
    const row = (await screen.findByText('Claude Max is signed out')).closest('li')!;
    await waitFor(() => expect(within(row).getByText('Claude (claude-a)')).toHaveAttribute('title', 'claude-a'));
  });
});

// Audit 14: the burn-downs (and the up-to-2 MiB recorded history behind them)
// moved to Usage — command/LiveSeatBurnDowns.test.tsx keeps their cases.
describe('CommandSection — no seat history read', () => {
  it('never asks for the recorded seat history, on mount or on any poll', { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = stubSurfaceFetch({ kind: 'dark' });
    render(<CommandSection />);
    await ready();
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMAND_HISTORY_POLL_MS + COMMAND_SLOW_POLL_MS); });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/verse/budget/history'))).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Capacity per seat' })).toBeInTheDocument();
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
    expect(document.body).not.toHaveTextContent(`Fleet dark since ${localDay('2026-08-18T12:00:00Z')}`);
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

describe('CommandSection — autonomy off', () => {
  it('says it ONCE, under the bar, with Approve grant — no verdict, Since strip, empty KPIs or empty swimlane', async () => {
    const now = Date.now();
    const { fetchMock } = stubSurfaceFetch({ kind: 'dark', now, routes: { '/api/verse/fleet/history': emptyHistory(now) } });
    const user = userEvent.setup();
    render(<CommandSection />);
    const banner = await screen.findByRole('region', { name: 'Autonomy is off' });
    expect(banner).toHaveTextContent('Approve a standing grant to let the fleet work.');
    // The viewer's local day for DARK_SINCE (Sep 1 19:10 UTC): Sep 1 in New York, Sep 2 in Tokyo.
    expect(within(banner).getByText(`Fleet dark since ${localDay(DARK_SINCE)}`)).toBeInTheDocument();
    const bar = screen.getByRole('toolbar', { name: 'Autonomy controls' });
    expect(bar.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('verdict')).toBeNull());
    expect(screen.queryByRole('group', { name: 'Key numbers' })).toBeNull();
    expect(screen.queryByRole('figure', { name: 'Last 12 hours' })).toBeNull();
    // "All clear" no longer repeats the dark-since fact a third time.
    expect(screen.getByText('All clear')).toBeInTheDocument();
    expect(screen.queryByText(`Fleet dark since ${localDay(DARK_SINCE)}.`)).toBeNull();
    expect(screen.getByRole('region', { name: 'Leader' })).toHaveTextContent('No memo yet');
    // The one action opens the bar's own Touch ID sheet.
    await user.click(within(banner).getByRole('button', { name: 'Approve grant' }));
    const sheet = await screen.findByRole('dialog', { name: 'Approve a standing grant' });
    expect(sheet).toHaveTextContent('Approve a standing grant to let the fleet work.');
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/verse/authority/draft'))).toBe(true);
  });

  it('asks for the one-time setup instead when the grant draft has no trust root', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'dark', now, routes: { '/api/verse/authority/draft': draftRefused(), '/api/verse/fleet/history': emptyHistory(now) } });
    render(<CommandSection />);
    const banner = await screen.findByRole('region', { name: 'Autonomy is off' });
    await waitFor(() => expect(within(banner).getByText('ashlr authority setup')).toBeInTheDocument());
    expect(banner).toHaveTextContent('Nothing runs or merges on its own until the one-time setup is done.');
    expect(within(banner).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Copy the command: ashlr authority setup']);
  });

  it('keeps a KPI row that has real figures, even with autonomy off', async () => {
    const now = Date.now();
    const base = fleetLive('dark', now);
    stubSurfaceFetch({ kind: 'dark', now, routes: { '/api/verse/fleet/live': { ...base, summary: { ...base.summary, merged7d: 4 } }, '/api/verse/fleet/history': emptyHistory(now) } });
    render(<CommandSection />);
    await screen.findByRole('region', { name: 'Autonomy is off' });
    expect(await screen.findByRole('group', { name: 'Key numbers' })).toHaveTextContent('Merged · 7d4');
  });
});

describe('CommandSection — not-landed states', () => {
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

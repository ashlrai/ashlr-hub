import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FleetSection } from './FleetSection.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SEAT_DECISION_FIXTURE, fleetLive } from '../command/fixtures.test-support.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import type { SeatDecision } from '../../../../core/routing/types.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { showTable } from '../../../components/charts/chart-test-support.js';

const TOKEN = 'b'.repeat(64);
let vp: ViewportMock | null = null;

beforeEach(() => {
  evictAll();
  clearMutationToken();
  vp = mockWideViewport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  vp?.restore();
});

describe('FleetSection — live', () => {
  it('shows lanes, the live swimlane, gates, why-this-seat, parked, overnight and repos', async () => {
    stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/budget/preview': SEAT_DECISION_FIXTURE } });
    const { container } = render(<FleetSection />);
    await waitFor(() => expect(screen.getByRole('figure', { name: 'Live fleet' })).toBeInTheDocument());
    await waitFor(() => expect(container.querySelectorAll('rect[data-item]').length).toBeGreaterThan(5));
    expect(screen.getByRole('list', { name: 'Lanes: busy of slots' })).toHaveTextContent('Local · 2/2Grok · 2/2Claude · 0/1Codex · off');
    // Engine ticks sit beside lane labels.
    expect(container.querySelector('[data-engine="grok"]')).not.toBeNull();
    expect(screen.getByRole('figure', { name: 'Gate funnel' })).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Refusals by gate' })).toBeInTheDocument();
    const why = screen.getByRole('region', { name: 'Why this seat' });
    expect(within(why).getByText(/grok-a has the most headroom/)).toBeInTheDocument();
    expect(within(why).getByText(/above the 70% ceiling/)).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Parked' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Overnight' })).toHaveTextContent('Nothing armed');
    const repos = screen.getByRole('region', { name: 'Repositories' });
    expect(within(repos).getByRole('rowheader', { name: 'ashlrai/measurably' })).toBeInTheDocument();
    expect(within(repos).getByText(/Quarantined · \d+m left/)).toBeInTheDocument();
  });

  it('pauses a repo only after confirming, as Mason', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<FleetSection />);
    await user.click(await screen.findByRole('button', { name: 'Pause ashlrai/binshield' }));
    expect(screen.getByRole('dialog', { name: 'Pause binshield?' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause repo' }));
    await waitFor(() => expect(posted[0]).toEqual({ url: '/api/verse/fleet/live', body: { action: 'pause-repo', repo: 'ashlrai/binshield', reason: 'Paused by Mason from the Fleet surface' } }));
  });

  it('resumes a held repo after confirming', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<FleetSection />);
    await user.click(await screen.findByRole('button', { name: 'Resume ashlrai/measurably' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Resume measurably?' })).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(posted[0]!.body).toEqual({ action: 'resume-repo', repo: 'ashlrai/measurably' }));
  });

  it('keeps the legacy panels closed (and unfetched) until Advanced is opened', async () => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    render(<FleetSection />);
    await screen.findByRole('figure', { name: 'Live fleet' });
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/verse/control'))).toBe(false);
    const disclosure = screen.getByRole('button', { name: /^Advanced/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/verse/control'))).toBe(true));
  });

  it('gives every chart a table twin', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    await screen.findByRole('figure', { name: 'Refusals by gate' });
    showTable('Refusals by gate');
    expect(screen.getByRole('columnheader', { name: 'Tests failed on the base head' })).toBeInTheDocument();
  });
});

describe('FleetSection — lane chips', () => {
  it('keeps each chip to "Lane · slots" and says a shared reason once, in full', async () => {
    const reason = 'No standing grant is in force.';
    const dark = fleetLive('dark');
    const live = { ...dark, stateReason: reason, lanes: dark.lanes.map((l) => ({ ...l, capReason: reason })) };
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/fleet/live': live } });
    render(<FleetSection />);
    const chips = await screen.findByRole('list', { name: 'Lanes: busy of slots' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Local · off', 'Grok · off', 'Claude · off', 'Codex · off']);
    expect(chips).not.toHaveTextContent(reason);
    const notes = screen.getByRole('list', { name: 'Why lanes are limited' });
    expect(within(notes).getAllByRole('listitem').map((li) => li.textContent)).toEqual([reason]);
    // Each chip still carries its reason as a tooltip.
    for (const li of within(chips).getAllByRole('listitem')) expect(li).toHaveAttribute('title', reason);
  });

  it('names the lanes when reasons differ', async () => {
    stubSurfaceFetch({ kind: 'dark' });
    render(<FleetSection />);
    const notes = await screen.findByRole('list', { name: 'Why lanes are limited' });
    expect(within(notes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Local, Grok, Claude: no grant.', 'Codex: off until its window resets.']);
  });
});

describe('FleetSection — why this seat', () => {
  // The live 3.10.0 preview, verbatim: sentences only, a run-on `why`.
  const cmpReset = '2026-09-26T03:46:56.000Z';
  const personalReset = '2026-09-25T18:25:44.000Z';
  const legacy: SeatDecision = {
    seatId: 'grok',
    candidates: ['grok'],
    exclusions: [
      { seatId: 'claude', reasons: ['The weekly window is 97% used; 40% is kept for you, so autonomy stops at 60% (resets Sep 25 at 6:59pm (America/New_York)).'], nextEligibleAt: null },
      { seatId: 'codex-cmp', reasons: ['Autonomy is switched off for this seat.', `The weekly window is spent — limit reached (resets ${cmpReset}).`], nextEligibleAt: null },
      { seatId: 'codex-personal', reasons: [`The weekly window is spent — limit reached (resets ${personalReset}).`], nextEligibleAt: personalReset },
    ],
    why: 'Routed autonomous medium-difficulty code work to Grok (grok) with 94% of its weekly window left for autonomy: balanced mode prefers Grok first for this work; held back 3 seats (claude: the weekly window is 97% used; 40% is kept for you, so autonomy stops at 60% (resets Sep 25 at 6:59pm (America/New_York)); codex-cmp: autonomy is switched off for this seat; …).',
    mode: 'balanced',
  };

  it('shows one short headline, prose reasons and a real "eligible again" per held-back seat', async () => {
    const dark = fleetLive('dark');
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/budget/preview': legacy, '/api/verse/fleet/live': { ...dark, runs: [] } } });
    render(<FleetSection />);
    const why = await screen.findByRole('region', { name: 'Why this seat' });
    await waitFor(() => expect(within(why).getByText('Grok — 94% of its weekly window left; balanced mode prefers Grok for this work. 3 seats held back.')).toBeInTheDocument());
    // (The card's caption "…would go to…" is a lead-in, not a truncation.)
    const held = within(why).getByRole('list', { name: 'Held back seats' }).textContent ?? '';
    expect(held).not.toMatch(/\.;|\.\.|…|T03:46:56|eligible again: unknown/);
    expect(within(why).getByText('Autonomy is switched off for this seat. The weekly window is spent — limit reached.')).toBeInTheDocument();
    expect(within(why).getByText(`eligible again: when you switch autonomy on for this seat, not before ${describeResetAt(cmpReset)}`)).toBeInTheDocument();
    expect(within(why).getByText(`eligible again: ${describeResetAt(personalReset)}`)).toBeInTheDocument();
    expect(within(why).getByText('eligible again: Sep 25 at 6:59pm (America/New_York)')).toBeInTheDocument();
  });
});

describe('FleetSection — dark and absent', () => {
  it('designs the dark state and never draws empty axes', async () => {
    stubSurfaceFetch({ kind: 'dark' });
    render(<FleetSection />);
    await waitFor(() => expect(screen.getAllByText('Fleet dark since Sep 1').length).toBeGreaterThanOrEqual(3));
    expect(screen.getByRole('region', { name: 'Repositories' })).toHaveTextContent('Not in grant');
  });

  it('dates the dark state from the server\'s darkSince — the one Command uses too', async () => {
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/fleet/live': { ...fleetLive('dark'), darkSince: '2026-08-30T15:00:00.000Z' } } });
    render(<FleetSection />);
    await waitFor(() => expect(screen.getAllByText('Fleet dark since Aug 30').length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByText('Fleet dark since Sep 1')).toBeNull();
  });

  it('says the live view is not in this build when its module has not landed', async () => {
    stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/fleet/live': null } });
    render(<FleetSection />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Repositories' })).toHaveTextContent('The live fleet view is not in this build yet'));
    expect(screen.getAllByRole('note').some((n) => /not in this build yet/.test(n.textContent ?? ''))).toBe(true);
  });
});

describe('FleetSection — 375 px', () => {
  it('turns the repo table into cards and keeps the order', async () => {
    vp?.restore();
    vp = mockCompactViewport({ dark: true });
    stubSurfaceFetch({ kind: 'live' });
    const { container } = render(<FleetSection />);
    const repos = await screen.findByRole('region', { name: 'Repositories' });
    await waitFor(() => expect(within(repos).queryByRole('table')).toBeNull());
    await waitFor(() => expect(within(repos).getAllByRole('listitem')).toHaveLength(4));
    expect(screen.getByRole('figure', { name: 'Live fleet' })).toHaveTextContent(/last 6 h/);
    for (const cell of container.querySelectorAll('[data-span]')) expect((cell as HTMLElement).style.gridColumn).toBe('span 12');
  });
});

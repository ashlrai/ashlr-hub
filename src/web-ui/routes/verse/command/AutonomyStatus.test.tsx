/**
 * The Autonomy status card (3.14) — on the Fleet tab since 3.15, where the
 * fleet is operated — against the real FleetSection (and CommandSection for
 * the bar's ⌘K path), the real authority and decisions reads (stubbed fetch)
 * and the real Touch ID sheet: the active fleet's ladder, Re-approve under 7
 * days opens the ONE grant sheet, and ⌘K "Re-approve grant…" runs the bar's path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { CommandSection } from '../sections/CommandSection.js';
import { FleetSection } from '../sections/FleetSection.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { executeCatalogCommand, setShellNotifier } from '../shell/run-command.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { stubSurfaceFetch } from './fetch-stub.test-support.js';
import { anchorId } from './nav.js';
import { decisionsView, shadowStatus } from './ladder-fixtures.test-support.js';

const TOKEN = 'a'.repeat(64);
const DAY = 86_400_000;
let vp: ViewportMock | null = null;
const notify = vi.fn();

beforeEach(() => {
  evictAll();
  resetActivityForTest();
  resetCommandBus();
  resetVerseUi();
  clearMutationToken();
  notify.mockReset();
  setShellNotifier(notify);
  vp = mockWideViewport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  setShellNotifier(null);
  vp?.restore();
  vp = null;
});

async function panel(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Autonomy' }, { timeout: 3_000 });
}

describe('Autonomy status (on Fleet since 3.15)', () => {
  it('shows the shadow stage, the 8-rung ladder, progress, grant time, switch state and the last decision — and no off-state', async () => {
    const now = Date.now();
    stubSurfaceFetch({
      now,
      routes: {
        '/api/verse/authority/ledger': decisionsView(now),
        '/api/verse/authority': shadowStatus(now, { digests: 2, hours: 3 }),
      },
    });
    render(<FleetSection />);
    const card = await panel();
    expect(card).toHaveTextContent('Shadow · 1 of 8');
    expect(card).toHaveTextContent('Autonomous');
    expect(card).toHaveTextContent(/Grant 29 d left/);
    expect(within(card).queryByRole('button', { name: 'Re-approve' })).toBeNull();

    const ladder = within(card).getByRole('list', { name: 'Rollout ladder: stage 1 of 8' });
    const rungs = within(ladder).getAllByRole('listitem');
    expect(rungs).toHaveLength(8);
    const current = ladder.querySelector('[aria-current="step"]')!;
    expect(current).toHaveTextContent('Shadow');
    expect(current.getAttribute('aria-label')).toMatch(/Stage 1, Shadow \(current\)\. Nothing merges — propose only\. Proposing: ashlrcode, fleet-canary, binshield/);
    expect(ladder.querySelector('[data-state="next"]')!.getAttribute('aria-label')).toMatch(/Merging: ashlrcode, fleet-canary/);

    expect(within(card).getByRole('meter', { name: 'Would-merge digests: 2 / 5' })).toBeInTheDocument();
    expect(within(card).getByRole('meter', { name: 'Hours in stage: 3 h / 12 h' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Next: 2a lets ashlrcode, fleet-canary merge.');

    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('Would merge ashlrcode #12 — every gate passed. · 2 h ago'));
    expect(screen.queryByText('Autonomy is off')).toBeNull();
    // Needs-you's rollout / Stop items reveal this card.
    expect(document.getElementById(anchorId('autonomy'))).toContainElement(card);
  });

  it('shows a regression as the last event, loudly', async () => {
    const now = Date.now();
    const at = new Date(now - 30 * 60_000).toISOString();
    stubSurfaceFetch({
      now,
      routes: {
        '/api/verse/authority/ledger': decisionsView(now, { moves: [{ move: 'regressed', fromStageId: '2a', toStageId: 'shadow', at, breach: '1 sandbox violation in stage 2a.' }] }),
        '/api/verse/authority': shadowStatus(now, { lastMove: { move: 'regressed', fromStageId: '2a', toStageId: 'shadow', at, breach: '1 sandbox violation in stage 2a.' } }),
      },
    });
    render(<FleetSection />);
    const card = await panel();
    const last = within(card).getByRole('status');
    expect(last).toHaveTextContent('Dropped back to Shadow from 2a: 1 sandbox violation in stage 2a. · 30 m ago');
    expect(last).toHaveAttribute('data-tone', 'danger');
  });

  it('offers Re-approve under 7 days, which opens the one Touch ID sheet as a re-approval', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const { posted } = stubSurfaceFetch({ now, routes: { '/api/verse/authority': shadowStatus(now, { expiresInMs: 5 * DAY }) } });
    const user = userEvent.setup();
    render(<FleetSection />);
    const card = await panel();
    expect(card).toHaveTextContent(/Grant [45] d( \d+ h)? left/);
    await user.click(within(card).getByRole('button', { name: 'Re-approve' }));
    const sheet = await screen.findByRole('dialog', { name: 'Re-approve the standing grant' });
    expect(sheet).toHaveTextContent(/continues the ladder from Shadow/);
    expect(posted).toEqual([]);
  });

  it('⌘K "Re-approve grant…" opens the same sheet; with no grant it says to approve one instead', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    stubSurfaceFetch({ now, routes: { '/api/verse/authority': shadowStatus(now) } });
    render(<CommandSection />);
    // The bar serves the palette entry once the authority read has answered.
    await waitFor(() => expect(screen.getByTestId('verdict')).toBeInTheDocument());
    act(() => { executeCatalogCommand('autonomy.reapprove', { via: 'palette' }); });
    expect(await screen.findByRole('dialog', { name: 'Re-approve the standing grant' })).toHaveTextContent(/continues the rollout from its current stage/);
  });

  it('⌘K "Re-approve grant…" with no grant sends nothing and says why', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'dark' });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByText('Autonomy is off')).toBeInTheDocument());
    act(() => { executeCatalogCommand('autonomy.reapprove', { via: 'palette' }); });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('There is no grant to re-approve. Use "Approve grant…" to sign a new one.', 'neutral'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posted).toEqual([]);
    // The dormant state keeps its banner; there is no ladder to draw.
    expect(screen.queryByRole('region', { name: 'Autonomy' })).toBeNull();
  });

  it('says Stopped while Stop is in force (the off-state banner owns that screen)', async () => {
    const now = Date.now();
    stubSurfaceFetch({ now, routes: { '/api/verse/authority': shadowStatus(now, { kill: true }) } });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByText('Fleet stopped')).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Autonomy' })).toBeNull();
  });

  it('draws nothing extra for a server that predates the ladder field', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByTestId('verdict')).toHaveTextContent(/Autonomous/));
    // Give the lazy chunk its chance to render (it returns nothing).
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('region', { name: 'Autonomy' })).toBeNull();
  });

  it('fits a phone: the ladder, bars and last line stay in one column', async () => {
    vp?.restore();
    vp = mockCompactViewport();
    const now = Date.now();
    stubSurfaceFetch({ now, routes: { '/api/verse/authority': shadowStatus(now, { digests: 1, hours: 2 }) } });
    render(<FleetSection />);
    const card = await panel();
    expect(within(card).getAllByRole('listitem')).toHaveLength(8);
    expect(within(card).getByRole('meter', { name: 'Would-merge digests: 1 / 5' })).toBeInTheDocument();
  });
});

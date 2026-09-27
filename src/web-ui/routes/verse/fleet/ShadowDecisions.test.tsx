/**
 * Fleet's Shadow decisions (3.14), in the real FleetSection: one row per
 * proposal with its G0–G7 chips and why, regressions above the list, the PR
 * link, and the cloud evidence timeline when a cloud task filed the proposal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken } from '../../../data/auth-store.js';
import { FleetSection } from '../sections/FleetSection.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { anchorId } from '../command/nav.js';
import { decisionsView, shadowStatus } from '../command/ladder-fixtures.test-support.js';
import { mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { overview, task } from '../cloud/cloud-fixtures.test-support.js';

let vp: ViewportMock | null = null;

beforeEach(() => {
  evictAll();
  clearMutationToken();
  vp = mockWideViewport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vp?.restore();
  vp = null;
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function cloudOverview(now: number) {
  return overview({
    tasks: [task('pr-open', { id: 'ct_20260926T0713_tpehly', title: 'Tighten the tokenizer', repo: 'ashlrai/ashlrcode', intake: { headSha: 'a'.repeat(40), proposalId: 'prop-ashlrcode-1', diffHash: null, refused: null, at: new Date(now).toISOString() } }, now)],
  });
}

describe('Shadow decisions on Fleet', () => {
  it('lists each decision with gate chips, why, size, stage and links; regressions sit above, loud', async () => {
    const now = Date.now();
    const regressedAt = new Date(now - 3 * 3_600_000).toISOString();
    stubSurfaceFetch({
      now,
      routes: {
        '/api/verse/authority/ledger': decisionsView(now, { moves: [{ move: 'regressed', fromStageId: '2a', toStageId: 'shadow', at: regressedAt, breach: '1 sandbox violation in stage 2a.' }] }),
        '/api/verse/authority': shadowStatus(now),
        '/api/verse/cloud': (url: string) => (url.split('?')[0] === '/api/verse/cloud' ? json(cloudOverview(now)) : json({ error: 'not found' }, 404)),
      },
    });
    const user = userEvent.setup();
    render(<FleetSection />);
    const card = await screen.findByRole('region', { name: 'Shadow decisions' }, { timeout: 3_000 });
    expect(card).toHaveTextContent('1 would merge · 0 merged · 1 refused');

    const rows = within(within(card).getByRole('list', { name: 'Decisions, newest first' })).getAllByRole('listitem', { name: undefined }).filter((li) => li.hasAttribute('data-outcome'));
    expect(rows).toHaveLength(2);
    const [would, refused] = rows as [HTMLElement, HTMLElement];
    expect(would).toHaveTextContent('ashlrcode#12Would merge+30 −4 · 2 files · low risk · Shadow · 2 h ago');
    expect(would).toHaveTextContent('Every gate passed; held because the ladder is in shadow, so it only proposes.');
    const chips = within(would).getByRole('list', { name: 'Gate verdicts' });
    expect(within(chips).getAllByRole('listitem').map((c) => c.textContent)).toEqual(['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
    expect(within(chips).getAllByRole('listitem').every((c) => c.getAttribute('data-tone') === 'success')).toBe(true);
    expect(within(would).getByRole('link', { name: /PR/ })).toHaveAttribute('href', 'https://github.com/ashlrai/ashlrcode/pull/12');

    expect(refused).toHaveTextContent('Refused at G2: The diff touches a protected path.');
    const refusedChips = within(within(refused).getByRole('list', { name: 'Gate verdicts' })).getAllByRole('listitem');
    expect(refusedChips[3]).toHaveAttribute('data-tone', 'danger');
    expect(refusedChips[3]).toHaveAccessibleName('G2 refused: The diff touches a protected path.');
    expect(refusedChips[4]).toHaveAttribute('data-tone', 'absent');
    expect(within(refused).queryByRole('link')).toBeNull();

    const alerts = screen.getByRole('list', { name: 'Ladder regressions' });
    expect(alerts).toHaveTextContent('▲ Dropped back to Shadow from 2a1 sandbox violation in stage 2a.3 h ago');
    // Command's "All decisions →" lands here.
    expect(document.getElementById(anchorId('shadow-decisions'))).toContainElement(card);

    // The cloud task that filed the would-merge proposal opens its evidence timeline.
    await user.click(await within(would).findByRole('button', { name: 'Evidence' }));
    expect(await screen.findByRole('dialog', { name: 'Evidence' })).toHaveTextContent('Tighten the tokenizer');
    expect(within(refused).queryByRole('button', { name: 'Evidence' })).toBeNull();
  });

  it('says plainly when nothing has reached the gates yet', async () => {
    const now = Date.now();
    stubSurfaceFetch({ now, routes: { '/api/verse/authority': shadowStatus(now) } });
    render(<FleetSection />);
    const card = await screen.findByRole('region', { name: 'Shadow decisions' }, { timeout: 3_000 });
    expect(await within(card).findByText(/No proposal has been through the merge gates under this grant yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Ladder regressions' })).toBeNull();
  });

  it('is left out while no grant was ever signed', async () => {
    stubSurfaceFetch({ kind: 'dark' });
    render(<FleetSection />);
    await screen.findByRole('region', { name: 'Repositories' }, { timeout: 3_000 });
    expect(screen.queryByRole('region', { name: 'Shadow decisions' })).toBeNull();
  });

  it('shows the server’s reason when the decisions view is not in this build', async () => {
    const now = Date.now();
    stubSurfaceFetch({ now, routes: { '/api/verse/authority': shadowStatus(now), '/api/verse/authority/ledger': null } });
    render(<FleetSection />);
    const card = await screen.findByRole('region', { name: 'Shadow decisions' }, { timeout: 3_000 });
    expect(await within(card).findByText(/Shadow decisions is not in this build yet/)).toBeInTheDocument();
  });
});

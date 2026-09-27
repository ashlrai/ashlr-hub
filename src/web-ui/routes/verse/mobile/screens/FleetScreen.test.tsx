/**
 * Fleet on the phone: loading / error / per-section unavailable states, the
 * one primary button and Stop (confirmed, then POST /api/verse/daemon), the kill
 * switch shown but never released from here, budget mode (confirmed, then POST
 * /api/verse/budget, capped by the grant), the read-only grant, recent
 * decisions with the finished-runs fallback, and controls hidden or disabled
 * when the device cannot act or the Mac is out of reach.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { authorityStatus, budgetView, fleetLive } from '../../command/fixtures.test-support.js';
import { decisionsView, wouldMergeDecision } from '../../command/ladder-fixtures.test-support.js';
import { controlSnapshot } from '../../sections/section-fixtures.test-support.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { FleetScreen } from './FleetScreen.js';

const NOW = Date.now();

function routes(over: Record<string, unknown> = {}) {
  return stubFetch({
    'GET /api/verse/control': controlSnapshot(),
    'GET /api/verse/fleet/live': fleetLive('live', NOW),
    'GET /api/verse/authority': authorityStatus('live', NOW),
    'GET /api/verse/budget': budgetView('live', NOW),
    'GET /api/verse/authority/ledger': decisionsView(NOW, {
      decisions: [wouldMergeDecision(NOW, { proposalId: 'p-merged', outcome: 'merged', prNumber: 88, why: 'Every gate passed; landed.' }), ...decisionsView(NOW).decisions],
    }),
    'POST /api/verse/daemon': (body: Record<string, unknown> | null) => ({ ok: true, note: `Daemon ${String(body?.['action'])} done.` }),
    'POST /api/verse/budget': (body: Record<string, unknown> | null) => ({ ...budgetView('live', NOW), mode: body?.['mode'] }),
    ...over,
  });
}

function mount(overrides: Parameters<typeof renderMobile>[1] = {}) {
  return renderMobile(
    <>
      <FleetScreen />
      <MobileGuardSheet />
      <MobileToasts />
    </>,
    overrides,
  );
}

beforeEach(() => {
  setMutationToken(TOKEN);
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
});

describe('FleetScreen states', () => {
  it('shows a skeleton while the fleet loads', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    mount();
    expect(screen.getByRole('status', { name: 'Loading the fleet' })).toBeInTheDocument();
  });

  it('says why when neither the control plane nor the live view answers', async () => {
    routes({ 'GET /api/verse/control': json({ error: 'The daemon state file is unreadable.' }, 500), 'GET /api/verse/fleet/live': json({ error: 'nope' }, 404) });
    mount();
    expect(await screen.findByText('Couldn’t read the fleet')).toBeInTheDocument();
    expect(screen.getByText('The daemon state file is unreadable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('gives each unavailable section its own reason, never a blank', async () => {
    routes({
      'GET /api/verse/fleet/live': json({ error: 'nope' }, 404),
      'GET /api/verse/authority': json({ error: 'nope' }, 404),
      'GET /api/verse/authority/ledger': json({ error: 'nope' }, 404),
    });
    mount();
    expect(await screen.findByText(/The live fleet view is not in this build yet/)).toBeInTheDocument();
    expect(await screen.findByText(/The authority service is not in this build yet/)).toBeInTheDocument();
    expect(await screen.findByText(/Shadow decisions is not in this build yet/)).toBeInTheDocument();
  });
});

describe('FleetScreen controls', () => {
  it('shows Running with live counts and lanes, unknown counts as —', async () => {
    const live = fleetLive('live', NOW);
    live.summary.parked = null;
    routes({ 'GET /api/verse/fleet/live': live });
    mount();
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Landed today').previousSibling).toHaveTextContent('7');
    expect(screen.getByText('Parked').previousSibling).toHaveTextContent('—');
    expect(screen.getAllByText('2 of 2 busy').length).toBe(2);
    expect(screen.getByText('off until its window resets Thu 09:00')).toBeInTheDocument();
  });

  it('Pause runs at once (no sheet) and posts the daemon action', async () => {
    const stub = routes();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(stub.posts().map((p) => [p.url, p.body])).toEqual([['/api/verse/daemon', { action: 'pause' }]]));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Stop confirms what it does, then posts stop', async () => {
    const stub = routes();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop fleet' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Stop the fleet?' });
    expect(sheet).toHaveTextContent(/engaging the kill switch/);
    expect(stub.posts()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Stop fleet' }));
    await waitFor(() => expect(stub.posts().map((p) => [p.url, p.body])).toEqual([['/api/verse/daemon', { action: 'stop' }]]));
    expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
    expect(await screen.findByText('Daemon stop done.')).toBeInTheDocument();
  });

  it('with the kill switch engaged: says so and how to release it on the Mac — no release, no Stop', async () => {
    const control = controlSnapshot();
    control.killSwitch = { ...control.killSwitch, state: 'active', reason: 'present', note: 'The kill switch halts the daemon and the agents’ write tools.' };
    routes({ 'GET /api/verse/control': control, 'GET /api/verse/fleet/live': { ...fleetLive('live', NOW), state: 'stopped' } });
    mount();
    expect(await screen.findByText('The kill switch halts the daemon and the agents’ write tools.')).toBeInTheDocument();
    expect(screen.getByText('ashlr fleet resume')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop fleet|Resume|Start fleet|Release/ })).not.toBeInTheDocument();
  });

  it('a stopped daemon offers Start, confirmed', async () => {
    const control = controlSnapshot();
    control.daemon = { ...control.daemon, running: false };
    const stub = routes({ 'GET /api/verse/control': control, 'GET /api/verse/fleet/live': { ...fleetLive('live', NOW), state: 'stopped', stateReason: null } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Start fleet' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Start the fleet?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start fleet' }));
    await waitFor(() => expect(stub.posts()[0]?.body).toEqual({ action: 'start' }));
  });

  it('hides every control when this device cannot act', async () => {
    routes();
    mount({ permissions: permissionsFor('unavailable') });
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pause|Stop fleet/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reserve' })).toBeDisabled();
  });

  it('disables controls while the Mac is out of reach', async () => {
    routes();
    mount({ reachability: 'unreachable' });
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeDisabled();
    expect(screen.getByText(/controls wait until it does/)).toBeInTheDocument();
  });
});

describe('FleetScreen budget mode', () => {
  it('shows the current mode, caps modes above the grant, and confirms a change before posting it', async () => {
    const stub = routes();
    mount();
    const group = await screen.findByRole('group', { name: 'Budget mode' });
    await waitFor(() => expect(within(group).getByRole('button', { name: 'Balanced' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText(/Autonomy stops at each seat’s reserve/)).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'All-in' })).toBeDisabled();
    expect(screen.getByText(/Above Balanced is off: the grant caps spending there/)).toBeInTheDocument();

    fireEvent.click(within(group).getByRole('button', { name: 'Reserve' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Switch to Reserve?' });
    expect(sheet).toHaveTextContent('Autonomy runs on free local models, plus only a small slice of paid seats. This applies to autonomous work immediately.');
    expect(stub.posts()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use Reserve' }));
    await waitFor(() => expect(stub.posts().map((p) => [p.url, p.body])).toEqual([['/api/verse/budget', { mode: 'reserve' }]]));
  });
});

describe('FleetScreen grant and decisions', () => {
  it('summarises the grant read-only, with the repo list collapsed', async () => {
    routes();
    mount();
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/^\d+ d left$/)).toBeInTheDocument();
    expect(screen.getByText('Autonomous')).toBeInTheDocument();
    expect(screen.getByText('Grants are signed on your Mac with Touch ID.')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Show \d+ granted repos/ });
    expect(screen.queryByText('ashlrai/ashlrcode', { selector: 'span' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getAllByText(/^ashlrai\//, { selector: 'span' }).length).toBeGreaterThan(0);
  });

  it('lists recent decisions with an outcome word, repo#PR, why and when', async () => {
    routes();
    mount();
    expect(await screen.findByText('Landed')).toBeInTheDocument();
    expect(screen.getByText('ashlrcode #88')).toBeInTheDocument();
    expect(screen.getByText('Would merge')).toBeInTheDocument();
    expect(screen.getByText('Refused')).toBeInTheDocument();
    expect(screen.getByText('Refused at G2: The diff touches a protected path.')).toBeInTheDocument();
    expect(screen.getAllByText('2 h ago').length).toBeGreaterThan(0);
  });

  it('falls back to finished runs when the decisions ledger is unavailable', async () => {
    routes({ 'GET /api/verse/authority/ledger': json({ error: 'nope' }, 404) });
    mount();
    expect(await screen.findByText(/Showing finished runs instead/)).toBeInTheDocument();
    expect(screen.getByText('Reverted')).toBeInTheDocument();
    expect(screen.getByText('Inline the score cache')).toBeInTheDocument();
    expect(screen.getAllByText('Landed').length).toBeGreaterThan(0);
  });
});

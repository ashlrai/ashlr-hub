/**
 * 3.15 — the Fleet control surface, against the real FleetSection (stubbed
 * fetch): one sentence and one blocker, Start / Pause / Resume / Stop with the
 * state READ BACK from the server's answer, keys and ⌘K on the same handlers,
 * the desktop app's native steps (resident daemon, custody) through
 * `__ASHLR_DESKTOP__.fleet`, run steering and the grant editor's diff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, METADATA_JSON_READ_TIMEOUT_MS } from '../../../data/client.js';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FleetSection } from '../sections/FleetSection.js';
import { evictAll, getQuerySnapshot, runQuery, queryGateStats } from '../../../data/cache.js';
import { refreshFleetControlReads } from './fleet-control-queries.js';
import { FleetControl, FLEET_CONTROL_POLL_MS } from './FleetControl.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { fleetControl, fleetLive, grantDraft } from '../command/fixtures.test-support.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import { mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { resetVerseUi } from '../verse-ui-store.js';
import type { FleetControlActionResultV1, FleetControlStateV1 } from '../../../../core/fleet/fleet-control-types.js';

const TOKEN = 'c'.repeat(64);
let vp: ViewportMock | null = null;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function answer(action: FleetControlActionResultV1['action'], state: FleetControlStateV1, extra: Partial<FleetControlActionResultV1> = {}): Response {
  return json({ ok: true, action, did: [], needs: null, state, ...extra } satisfies FleetControlActionResultV1);
}

beforeEach(() => {
  evictAll();
  resetCommandBus();
  resetVerseUi();
  clearMutationToken();
  vp = mockWideViewport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  vp?.restore();
  delete (window as unknown as { __ASHLR_DESKTOP__?: unknown }).__ASHLR_DESKTOP__;
});

async function control(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: 'Fleet control' });
  await waitFor(() => expect(region).not.toHaveAttribute('data-state', 'unknown'));
  return region;
}

describe('shared native readback', () => {
  const projections = [
    ['verse-fleet-control', '/api/verse/fleet/control'],
    ['verse-fleet-control-queue', '/api/verse/fleet/control/queue'],
    ['verse-fleet-live', '/api/verse/fleet/live'],
    ['verse-authority', '/api/verse/authority'],
    ['verse-control', '/api/verse/control'],
    ['verse-fleet', '/api/verse/fleet'],
  ] as const;

  it('refreshes all previously read metadata projections without starting unseen provider reads', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      calls.push(path);
      return Promise.resolve(json({ v: 1, state: 'running', headline: 'new', controls: {}, grant: {}, daemon: {}, tasks: [], goals: [], targets: {}, marker: 'new' }));
    }));
    for (const [key] of projections) await runQuery(key, async () => ({ marker: 'old' }));
    await runQuery('verse-usage-accounts', async () => ({ marker: 'provider reading' }));
    refreshFleetControlReads();
    await waitFor(() => expect(calls.filter(path => projections.some(([, wanted]) => wanted === path)).sort())
      .toEqual(projections.map(([, path]) => path).sort()));
    await waitFor(() => expect(getQuerySnapshot<{ marker: string }>('verse-control').data?.marker).toBe('new'));
    expect(calls).not.toContain('/api/verse/usage/accounts');
    expect(calls).not.toContain('/api/verse/runtime');
    expect(getQuerySnapshot<{ marker: string }>('verse-usage-accounts').data?.marker).toBe('provider reading');
  });

  it('does not mount unopened Advanced projections', async () => {
    const { fetchMock } = stubSurfaceFetch();
    await runQuery('verse-fleet-control', async () => ({}));
    refreshFleetControlReads();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const paths = fetchMock.mock.calls.map(([path]) => path);
    expect(paths).toContain('/api/verse/fleet/control');
    expect(paths).not.toContain('/api/verse/control');
    expect(paths).not.toContain('/api/verse/fleet');
    expect(paths).not.toContain('/api/verse/runtime');
  });

  it('issues a post-operation read even while the old PID response is outstanding', async () => {
    let finishOld!: (value: { pid: number }) => void;
    const old = runQuery('verse-control', () => new Promise<{ pid: number }>(resolve => { finishOld = resolve; }));
    await Promise.resolve();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ pid: 35431 }))));
    refreshFleetControlReads();
    await waitFor(() => expect(getQuerySnapshot<{ pid: number }>('verse-control').data?.pid).toBe(35431));
    finishOld({ pid: 56295 });
    await old;
    expect(getQuerySnapshot<{ pid: number }>('verse-control').data?.pid).toBe(35431);
  });

  it.each(['done', 'failed', 'cancelled'] as const)('reads shared state after a native %s event without assuming success', async (phase) => {
    let request: { id: string; op: string } | null = null;
    (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__ = {
      fleet: { version: 1, ops: ['resident-restart'], send: (message: { id: string; op: string }) => { request = message; return true; } },
    };
    stubSurfaceFetch({ routes: { '/api/verse/control': { pid: 35431 } } });
    await runQuery('verse-control', async () => ({ pid: 56295 }));
    render(<FleetSection />);
    const region = await control();
    await userEvent.setup().click(within(region).getByRole('button', { name: 'Restart' }));
    expect(request).toMatchObject({ op: 'resident-restart' });
    expect(getQuerySnapshot<{ pid: number }>('verse-control').data?.pid).toBe(56295);
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:fleet', { detail: { ...request, phase, message: 'Native operation finished.' } })); });
    await waitFor(() => expect(getQuerySnapshot<{ pid: number }>('verse-control').data?.pid).toBe(35431));
  });
});

describe('automatic control polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); evictAll(); });

  function panel(visible = true) {
    return <SectionVisibilityProvider visible={visible}>
      <FleetControl actions={{ act: vi.fn(), busy: false, error: null, clearError: vi.fn(), readOnly: false, dialogs: null }}
        grantFlow={{ open: vi.fn(), sheet: null }} />
    </SectionVisibilityProvider>;
  }

  it('lets a read slower than several poll intervals update the PID without accumulating reads', async () => {
    const fresh = fleetControl('live');
    fresh.daemon.pid = 36373;
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(panel());
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * FLEET_CONTROL_POLL_MS); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { finish(json(fresh)); });
    expect(screen.getByRole('region', { name: 'Fleet control' })).toHaveTextContent('Running · pid 36373');
    await act(async () => { await vi.advanceTimersByTimeAsync(FLEET_CONTROL_POLL_MS); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { finish(json(fresh)); });
    unmount();
  });

  it('coalesces while the control read is queued behind other metadata reads', async () => {
    const releases: (() => void)[] = [];
    const blockers = Array.from({ length: 4 }, (_, i) => runQuery(`pending-metadata-${i}`, () => new Promise<void>(resolve => { releases.push(resolve); })));
    const fetcher = vi.fn(() => Promise.resolve(json(fleetControl('live'))));
    vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(panel());
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * FLEET_CONTROL_POLL_MS); });
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { releases.forEach(release => release()); await Promise.all(blockers); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Fleet control' })).toHaveTextContent('Running · pid 4242');
    unmount();
  });

  it('reads the actual new PID after native completion once four stalled HTTP reads abort', async () => {
    let request: { id: string; op: string } | null = null;
    (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__ = {
      fleet: { version: 1, ops: ['resident-restart'], send: (message: { id: string; op: string }) => { request = message; return true; } },
    };
    const old = fleetControl('live');
    const fresh = fleetControl('live'); fresh.daemon.pid = 36373;
    await runQuery('verse-fleet-control', async () => ({ value: old, available: true, reason: null }));
    let live = 0; let peak = 0;
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
      paths.push(path);
      if (!path.startsWith('/stalled-')) return Promise.resolve(json(fresh));
      live += 1; peak = Math.max(peak, live);
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => {
        live -= 1; reject(init.signal!.reason);
      }, { once: true }));
    }));
    const blockers = Array.from({ length: 4 }, (_, i) => runQuery(`stalled-${i}`, () => apiGet(`/stalled-${i}`)));
    const { unmount } = render(panel());
    const region = screen.getByRole('region', { name: 'Fleet control' });
    fireEvent.click(within(region).getByRole('button', { name: 'Restart' }));
    expect(request).toMatchObject({ op: 'resident-restart' });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('ashlr:fleet', { detail: { ...request, phase: 'done', message: 'Native operation finished.' } }));
    });
    expect(region).toHaveTextContent('Running · pid 4242');
    expect(paths).not.toContain('/api/verse/fleet/control');
    expect(queryGateStats()).toMatchObject({ active: 4, peak: 4 });
    expect(queryGateStats().queued).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(METADATA_JSON_READ_TIMEOUT_MS); await Promise.all(blockers); });
    expect(region).toHaveTextContent('Running · pid 36373');
    // Native completion forces a current read after the already queued mount read.
    expect(paths.filter(path => path === '/api/verse/fleet/control')).toHaveLength(2);
    expect(peak).toBe(4);
    expect(queryGateStats().peak).toBe(4);
    expect(live).toBe(0);
    unmount();
  });

  it.each(['success', 'error'] as const)('keeps a forced completion read current after the old poll %s', async (outcome) => {
    const old = fleetControl('live');
    const fresh = fleetControl('live');
    fresh.daemon.pid = 36373;
    let finish!: (response: Response) => void;
    let fail!: (error: Error) => void;
    const fetcher = vi.fn((_path: string): Promise<Response> => fetcher.mock.calls.length === 1
      ? new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; })
      : Promise.resolve(json(fresh)));
    vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(panel());
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * FLEET_CONTROL_POLL_MS); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { refreshFleetControlReads(); });
    // The terminal sweep also refreshes activity; count only the control read.
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/verse/fleet/control')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Fleet control' })).toHaveTextContent('Running · pid 36373');
    await act(async () => { if (outcome === 'success') finish(json(old)); else fail(new Error('old read failed')); });
    expect(screen.getByRole('region', { name: 'Fleet control' })).toHaveTextContent('Running · pid 36373');
    expect(getQuerySnapshot('verse-fleet-control').status).toBe('success');
    unmount();
  });

  it('keeps hidden sections quiet and catches up when shown again', async () => {
    const fetcher = vi.fn(() => Promise.resolve(json(fleetControl('live'))));
    vi.stubGlobal('fetch', fetcher);
    const { rerender, unmount } = render(panel());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender(panel(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * FLEET_CONTROL_POLL_MS); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender(panel());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    unmount();
  });
});

describe('the header', () => {
  it('shows preparation and the last completed tick while no agents are working', async () => {
    const now = Date.now();
    const preparing = fleetControl('live', now, { working: 0 });
    preparing.state = 'running';
    preparing.headline = 'Running · preparing work: selection and dispatch · stage shadow';
    preparing.daemon.tickProgress = { phase: 'selection and dispatch', detail: null,
      tickStartedAt: new Date(now - 60_000).toISOString(), phaseStartedAt: new Date(now - 30_000).toISOString(),
      summary: 'tick in progress: selection and dispatch for 30s' };
    preparing.daemon.lastTickAt = new Date(now - 2 * 86_400_000).toISOString();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/fleet/control': preparing } });
    render(<FleetSection />);
    const region = await control();
    expect(region).toHaveTextContent('Preparing work');
    expect(region).toHaveTextContent('0 agents working · selection and dispatch');
    expect(region).toHaveTextContent('none working');
    expect(region).toHaveTextContent('tick in progress: selection and dispatch for 30s');
    expect(region).toHaveTextContent('last completed');
    expect(region).not.toHaveTextContent('waiting for work');
    expect(region).not.toHaveTextContent('ticked');
    expect(within(region).getByRole('button', { name: /^Start/ })).toBeDisabled();
  });

  it('does not display unconfirmed tick progress from a stale daemon', async () => {
    const now = Date.now();
    const stale = fleetControl('live', now, { working: 0 });
    stale.daemon.liveness = 'stale';
    stale.daemon.tickProgress = { phase: 'old preparation', detail: null,
      tickStartedAt: new Date(now - 60_000).toISOString(), phaseStartedAt: new Date(now - 30_000).toISOString(),
      summary: 'tick in progress: old preparation for 30s' };
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/fleet/control': stale } });
    render(<FleetSection />);
    const region = await control();
    expect(region).not.toHaveTextContent('old preparation');
    expect(region).not.toHaveTextContent('last completed');
  });

  it('says what the fleet is doing, with the grant, spend, daemon and agents', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    const region = await control();
    expect(region).toHaveTextContent('Running');
    expect(region).toHaveTextContent('2 agents working');
    expect(region).toHaveTextContent('#2 · 2 repos · 20 d left · 2a (2/4)');
    expect(region).toHaveTextContent('$3.5 of $20 cap');
    expect(region).toHaveTextContent(/Running · pid 4242/);
    // Start is not needed while it runs; Pause and Stop are.
    expect(within(region).getByRole('button', { name: /^Start/ })).toBeDisabled();
    expect(within(region).getByRole('button', { name: /^Pause/ })).toBeEnabled();
    expect(within(region).getByRole('button', { name: /^Stop/ })).toBeEnabled();
  });

  it('keeps unknown daemon evidence explicit instead of claiming it is stopped', async () => {
    const unknown = fleetControl('live');
    unknown.daemon.service = 'unknown';
    unknown.daemon.liveness = 'unknown';
    unknown.daemon.pid = null;
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control': unknown } });
    render(<FleetSection />);
    const region = await control();
    expect(region).toHaveTextContent('Status unavailable');
    expect(region).not.toHaveTextContent('Not running');
  });

  it('marks a retained failed reading and lets a fresh check replace it', async () => {
    const state = fleetControl('live');
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control': state } });
    render(<FleetSection />);
    const region = await control();
    await act(async () => { await runQuery('verse-fleet-control', () => Promise.reject(new Error('read failed'))); });
    expect(region).toHaveAttribute('data-state', 'unknown');
    expect(region).toHaveTextContent('Last known: Running');
    expect(region).toHaveTextContent('Showing the last reading');
    let finish!: (value: { value: FleetControlStateV1; available: boolean; reason: null }) => void;
    let pending!: Promise<void>;
    await act(async () => { pending = runQuery('verse-fleet-control', () => new Promise(resolve => { finish = resolve; })); });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('data-state', 'unknown');
    expect(region).toHaveTextContent('Last known: Running');
    await act(async () => { finish({ value: state, available: true, reason: null }); await pending; });
    expect(region).not.toHaveTextContent('Last known:');
    await act(async () => { await runQuery('verse-fleet-control', () => Promise.reject(new Error('read failed again'))); });
    state.daemon.pid = 36373;
    await userEvent.setup().click(within(region).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(region).toHaveTextContent('Running · pid 36373'));
    expect(region).not.toHaveTextContent('Last known:');
    expect(region).toHaveAttribute('data-state', 'running');
  });

  it('announces a refresh while preserving the useful last reading', async () => {
    const state = fleetControl('live');
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control': state } });
    render(<FleetSection />);
    const region = await control();
    let finish!: (value: { value: FleetControlStateV1; available: boolean; reason: null }) => void;
    let pending!: Promise<void>;
    await act(async () => { pending = runQuery('verse-fleet-control', () => new Promise(resolve => { finish = resolve; })); });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Updating fleet status…');
    expect(region).toHaveTextContent('Running · pid 4242');
    await act(async () => { finish({ value: state, available: true, reason: null }); await pending; });
    expect(region).toHaveAttribute('aria-busy', 'false');
    expect(region).not.toHaveTextContent('Updating fleet status…');
  });

  it.each([false, null])('opens helper maintenance automatically when installation is %s', async (installed) => {
    const state = fleetControl('live');
    state.custody.installed = installed;
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control': state } });
    render(<FleetSection />);
    const region = await control();
    expect(within(region).getByText('Helper settings').closest('details')).toHaveAttribute('open');
  });

  it('collapses healthy maintenance without hiding its installed status', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    const region = await control();
    expect(region).toHaveTextContent('Installed · key ready');
    const settings = within(region).getByText('Helper settings');
    expect(settings.closest('details')).not.toHaveAttribute('open');
    await userEvent.setup().click(settings);
    expect(settings.closest('details')).toHaveAttribute('open');
  });

  it.each([false, null])('opens helper maintenance automatically when key readiness is %s', async (keyInitialized) => {
    const state = fleetControl('live');
    state.custody.keyInitialized = keyInitialized;
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control': state } });
    render(<FleetSection />);
    const region = await control();
    expect(within(region).getByText('Helper settings').closest('details')).toHaveAttribute('open');
  });

  it('preserves a user-opened helper panel during healthy refreshes and opens it for a new blocker', async () => {
    const state = fleetControl('live');
    stubSurfaceFetch({ routes: { '/api/verse/fleet/control': state } });
    render(<FleetSection />);
    const region = await control();
    const settings = within(region).getByText('Helper settings');
    const user = userEvent.setup();
    await user.click(settings);
    await act(async () => { await runQuery('verse-fleet-control', async () => ({ value: { ...state }, available: true, reason: null })); });
    expect(settings.closest('details')).toHaveAttribute('open');
    await user.click(settings);
    expect(settings.closest('details')).not.toHaveAttribute('open');
    await act(async () => { await runQuery('verse-fleet-control', async () => ({ value: { ...state, custody: { ...state.custody, keyInitialized: false } }, available: true, reason: null })); });
    expect(settings.closest('details')).toHaveAttribute('open');
  });

  it('names one blocker with one button — here the Touch ID sheet', async () => {
    stubSurfaceFetch({ kind: 'dark' });
    const user = userEvent.setup();
    render(<FleetSection />);
    const region = await control();
    const alert = within(region).getByRole('alert');
    expect(alert).toHaveTextContent('No standing grant is in force.');
    await user.click(within(alert).getByRole('button', { name: 'Approve a grant with Touch ID' }));
    expect(await screen.findByRole('dialog', { name: 'Approve a standing grant' })).toBeInTheDocument();
  });

  it('without the desktop app, a native step shows its Terminal command instead of a dead button', async () => {
    const now = Date.now();
    const down = fleetControl('live', now, { service: 'absent', liveness: { state: 'stopped', pid: null, lastTickAt: null, reason: 'x' }, working: 0 });
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/fleet/control': down } });
    render(<FleetSection />);
    const region = await control();
    const alert = within(region).getByRole('alert');
    expect(alert).toHaveTextContent('The fleet daemon is not running.');
    expect(within(alert).queryByRole('button', { name: 'Start the daemon' })).toBeNull();
    expect(within(alert).getByText('ashlr authority resident start')).toBeInTheDocument();
  });
});

describe('the controls', () => {
  it('Pause posts once and shows the state the server read back', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const paused = fleetControl('live', now, { paused: true, pausedAt: new Date(now).toISOString() });
    const { posted } = stubSurfaceFetch({
      kind: 'live',
      now,
      post: (url) => (url === '/api/verse/fleet/control' ? answer('pause', paused, { did: ['Paused dispatch — runs in flight finish, nothing new starts.'] }) : undefined),
    });
    const user = userEvent.setup();
    render(<FleetSection />);
    const region = await control();
    await user.click(within(region).getByRole('button', { name: /^Pause/ }));
    await waitFor(() => expect(posted).toContainEqual({ url: '/api/verse/fleet/control', body: { action: 'pause' } }));
    await waitFor(() => expect(region).toHaveTextContent('Paused dispatch — runs in flight finish, nothing new starts.'));
  });

  it('Start confirms first, then hands the daemon step to the desktop app', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const sent: unknown[] = [];
    let nativeFinished = false;
    (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__ = {
      fleet: {
        version: 1,
        ops: ['resident-start', 'resident-restart', 'resident-stop', 'custody-install'],
        send: (msg: { id: string; op: string }) => {
          sent.push(msg);
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('ashlr:fleet', { detail: { id: msg.id, op: msg.op, phase: 'running', message: 'Starting the fleet daemon…', command: '/opt/homebrew/bin/ashlr authority resident start' } }));
            nativeFinished = true;
            window.dispatchEvent(new CustomEvent('ashlr:fleet', { detail: { id: msg.id, op: msg.op, phase: 'done', message: 'The fleet daemon is running under your grant.', exitCode: 0, output: '✓ ai.ashlr.daemon is running' } }));
          }, 0);
          return true;
        },
      },
    };
    const stopped = fleetControl('live', now, { kill: true, working: 0 });
    const after = fleetControl('live', now, { service: 'absent', liveness: { state: 'stopped', pid: null, lastTickAt: null, reason: 'x' }, working: 0 });
    const { posted } = stubSurfaceFetch({
      kind: 'live',
      now,
      routes: { '/api/verse/fleet/control': () => json(nativeFinished ? fleetControl('live', now) : stopped) },
      post: (url) => (url === '/api/verse/fleet/control'
        ? answer('start', after, { did: ['Cleared Stop.'], needs: { kind: 'resident-start', label: 'Start the daemon', command: 'ashlr authority resident start', native: true } })
        : undefined),
    });
    const user = userEvent.setup();
    render(<FleetSection />);
    const region = await control();
    await user.click(within(region).getByRole('button', { name: /^Start/ }));
    // Start raises (within the grant): it asks first.
    const dialog = await screen.findByRole('dialog', { name: 'Start the fleet?' });
    expect(posted).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Start fleet' }));
    await waitFor(() => expect(posted).toContainEqual({ url: '/api/verse/fleet/control', body: { action: 'start' } }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ op: 'resident-start' });
    await waitFor(() => expect(region).toHaveTextContent('Done — The fleet daemon is running under your grant.'));
    await waitFor(() => expect(region).toHaveTextContent('Running · pid 4242'));
    expect(within(region).getByText('/opt/homebrew/bin/ashlr authority resident start')).toBeInTheDocument();
  });

  it('Stop confirms with the catalog copy; ⌘⌥P and the palette run the same Pause', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const { posted } = stubSurfaceFetch({ kind: 'live', now, post: (url) => (url === '/api/verse/fleet/control' ? answer('pause', fleetControl('live', now)) : undefined) });
    const user = userEvent.setup();
    render(<FleetSection />);
    const region = await control();
    await user.click(within(region).getByRole('button', { name: /^Stop/ }));
    expect(await screen.findByRole('dialog', { name: 'Stop the fleet?' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(posted).toEqual([]);
    act(() => { executeCatalogCommand('fleet.pause', { via: 'palette' }); });
    await waitFor(() => expect(posted).toContainEqual({ url: '/api/verse/fleet/control', body: { action: 'pause' } }));
  });
});

describe('custody source checkout', () => {
  async function custodyControl(): Promise<HTMLElement> {
    const region = await control();
    const settings = within(region).getByText('Helper settings');
    if (!settings.closest('details')?.open) await userEvent.setup().click(settings);
    return region;
  }

  function nativeInstall(complete = true) {
    const sent: { id: string; op: string; checkout?: string }[] = [];
    (window as unknown as Record<string, unknown>).__ASHLR_DESKTOP__ = {
      fleet: { version: 1, ops: ['custody-install', 'resident-restart'], send: (message: typeof sent[number]) => {
        sent.push(message);
        if (complete) setTimeout(() => finish(message), 0);
        return true;
      } },
    };
    function finish(message: typeof sent[number]) {
      window.dispatchEvent(new CustomEvent('ashlr:fleet', { detail: {
        id: message.id, op: message.op, phase: 'cancelled', message: 'Nothing was changed.',
      } }));
    }
    return { sent, finish };
  }

  it('defaults to the detected checkout and preserves native confirmation', async () => {
    const { sent } = nativeInstall();
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    const region = await custodyControl();
    expect(within(region).getByRole('textbox', { name: 'Custody source checkout' })).toHaveValue('~/code/ashlr-hub');
    expect(region).toHaveTextContent('administrator approval is required');
    await userEvent.setup().click(within(region).getByRole('button', { name: 'Reinstall / upgrade' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ op: 'custody-install', checkout: '~/code/ashlr-hub' });
    await waitFor(() => expect(region).toHaveTextContent('Nothing was changed.'));
  });

  it('uses the same explicit alternate checkout for the button and menu', async () => {
    const { sent } = nativeInstall();
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    const region = await custodyControl();
    const field = within(region).getByRole('textbox', { name: 'Custody source checkout' });
    fireEvent.change(field, { target: { value: '/demo/validated hub' } });
    await userEvent.setup().click(within(region).getByRole('button', { name: 'Reinstall / upgrade' }));
    await waitFor(() => expect(region).toHaveTextContent('Nothing was changed.'));
    act(() => { executeCatalogCommand('fleet.install-custody', { via: 'palette' }); });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map(({ checkout }) => checkout)).toEqual(['/demo/validated hub', '/demo/validated hub']);
    expect(field).toHaveValue('/demo/validated hub');
  });

  it.each(['', 'relative/hub', '/demo/\u0000hub', '/' + 'a'.repeat(1024)])('refuses invalid choice %j without falling back to detected source', async (value) => {
    const { sent } = nativeInstall();
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    const region = await custodyControl();
    fireEvent.change(within(region).getByRole('textbox', { name: 'Custody source checkout' }), { target: { value } });
    expect(within(region).getByRole('button', { name: 'Reinstall / upgrade' })).toBeDisabled();
    expect(within(region).getByRole('textbox', { name: 'Custody source checkout' })).toHaveAttribute('aria-invalid', 'true');
    act(() => { executeCatalogCommand('fleet.install-custody', { via: 'palette' }); });
    expect(sent).toEqual([]);
  });

  it('allows an explicit trusted source when detection is unavailable', async () => {
    const { sent } = nativeInstall();
    const state = fleetControl('live');
    state.custody.hubCheckout = null;
    stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/fleet/control': state } });
    render(<FleetSection />);
    const region = await custodyControl();
    const button = within(region).getByRole('button', { name: 'Reinstall / upgrade' });
    expect(button).toBeDisabled();
    fireEvent.change(within(region).getByRole('textbox', { name: 'Custody source checkout' }), { target: { value: '~/reviewed-hub' } });
    await userEvent.setup().click(button);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ checkout: '~/reviewed-hub' });
  });

  it('refuses repeated menu requests while native confirmation or installation is pending', async () => {
    const { sent, finish } = nativeInstall(false);
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    const region = await custodyControl();
    act(() => {
      executeCatalogCommand('fleet.install-custody', { via: 'palette' });
      executeCatalogCommand('fleet.install-custody', { via: 'palette' });
    });
    expect(sent).toHaveLength(1);
    expect(within(region).getByRole('button', { name: 'Reinstall / upgrade' })).toBeDisabled();
    expect(within(region).getByRole('textbox', { name: 'Custody source checkout' })).toBeDisabled();
    act(() => { executeCatalogCommand('fleet.install-custody', { via: 'palette' }); });
    expect(sent).toHaveLength(1);
    act(() => { finish(sent[0]!); });
    await waitFor(() => expect(within(region).getByRole('button', { name: 'Reinstall / upgrade' })).toBeEnabled());
  });

  it('leaves resident menu requests to their existing native handling during custody confirmation', async () => {
    const { sent, finish } = nativeInstall(false);
    stubSurfaceFetch({ kind: 'live' });
    render(<FleetSection />);
    await control();
    act(() => {
      executeCatalogCommand('fleet.install-custody', { via: 'palette' });
      executeCatalogCommand('fleet.restart-daemon', { via: 'palette' });
    });
    expect(sent.map(({ op }) => op)).toEqual(['custody-install', 'resident-restart']);
    act(() => { finish(sent[1]!); });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Fleet control' })).toHaveTextContent('Nothing was changed.'));
    act(() => { executeCatalogCommand('fleet.install-custody', { via: 'palette' }); });
    expect(sent).toHaveLength(2);
    act(() => { finish(sent[0]!); });
  });
});

describe('steering', () => {
  const RUN = {
    id: 'run-7',
    taskId: '11111111-2222-3333-4444-555555555555',
    repo: 'ashlrai/ashlrcode',
    title: 'Add tests for the parser',
    lane: 'grok-cli' as const,
    seatId: 'grok-a',
    engine: 'grok-cli',
    model: null,
    phase: 'producing' as const,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    phaseStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    endedAt: null,
    outcome: null,
    prNumber: null,
    hold: null,
    seatDecision: null,
  };

  it('interjects on a working run: stop + requeue with the note', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const live = { ...fleetLive('live', now), runs: [RUN] };
    const { posted } = stubSurfaceFetch({
      kind: 'live',
      now,
      routes: { '/api/verse/fleet/live': live },
      post: (url) => (url === '/api/verse/fleet/control' ? answer('interject', fleetControl('live', now), { mode: 'stop-and-requeue' }) : undefined),
    });
    const user = userEvent.setup();
    render(<FleetSection />);
    const steer = await screen.findByRole('region', { name: 'Steer the fleet' });
    await waitFor(() => expect(steer).toHaveTextContent('Add tests for the parser'));
    const row = within(steer).getAllByRole('listitem')[0]!;
    await user.click(within(row).getByRole('button', { name: 'Interject' }));
    await user.type(within(row).getByRole('textbox'), 'Use the fixture helper');
    await user.click(within(row).getByRole('button', { name: 'Stop and requeue with note' }));
    await waitFor(() => expect(posted).toContainEqual({
      url: '/api/verse/fleet/control',
      body: { action: 'interject', runId: 'run-7', taskId: RUN.taskId, note: 'Use the fixture helper' },
    }));
  });

  it('reprioritizes a queued task', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const { posted } = stubSurfaceFetch({ kind: 'live', now, post: (url) => (url === '/api/verse/fleet/control' ? answer('task-edit', fleetControl('live', now)) : undefined) });
    const user = userEvent.setup();
    render(<FleetSection />);
    const select = await screen.findByRole('combobox', { name: 'Priority of Add tests for the parser' });
    await user.selectOptions(select, '5');
    await waitFor(() => expect(posted).toContainEqual({ url: '/api/verse/fleet/control', body: { action: 'task-edit', taskId: '11111111-2222-3333-4444-555555555555', value: 5 } }));
  });
});

describe('the grant editor', () => {
  it('edits the scope, shows the diff the server computed, and signs exactly that draft', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const base = grantDraft(now) as unknown as Record<string, unknown> & { payload: { repos: { nameWithOwner: string }[]; engines: string[] } };
    const served = {
      ...base,
      kind: 'new',
      diff: [],
      editable: { repos: base.payload.repos.map((r) => r.nameWithOwner), engines: ['local', 'grok-cli', 'claude-cli', 'codex'], leaderClasses: ['A', 'B'], maxDays: 30 },
    };
    const editedDigest = 'e'.repeat(64);
    const edited = { ...served, digest: editedDigest, diff: [{ field: 'leader', label: 'Leader classes', before: 'A, B', after: 'A', direction: 'narrower' }] };
    const { posted } = stubSurfaceFetch({
      kind: 'dark',
      now,
      routes: { '/api/verse/authority/draft': served },
      post: (url) => (url === '/api/verse/authority/draft' ? json(edited) : undefined),
    });
    const user = userEvent.setup();
    render(<FleetSection />);
    const region = await control();
    await user.click(within(region).getByRole('button', { name: /Edit scope/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Approve a standing grant' });
    await waitFor(() => expect(within(sheet).getByRole('group', { name: /Leader permission ceiling/ })).toBeInTheDocument());
    await user.click(within(sheet).getByRole('checkbox', { name: /Class B/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(posted.find((p) => p.url === '/api/verse/authority/draft')?.body).toMatchObject({ kind: 'new', scope: { leaderClasses: ['A'] } }));
    await waitFor(() => expect(within(sheet).getByRole('region', { name: 'Changes' })).toHaveTextContent('Leader classesA, BAnarrower'));
    await user.click(within(sheet).getByRole('button', { name: 'Approve with Touch ID' }));
    await waitFor(() => expect(posted).toContainEqual({ url: '/api/verse/authority', body: { action: 'grant', draftDigest: editedDigest } }));
  });
});

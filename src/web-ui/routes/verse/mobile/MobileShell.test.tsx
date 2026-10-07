/**
 * The phone shell and Home, end to end against a stubbed Mac: the frame
 * paints before the runtime, the tab bar and its badges, Home's cards in each
 * state, the fleet's one button through the guarded path (confirm → token →
 * POST), read-only devices, and the offline / unreachable strip.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { VerseControlSnapshot } from '../../../../core/verse/control-types.js';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { bootstrap } from '../fixtures.test-support.js';
import { resetGuard } from '../shell/guard-store.js';
import { resetResolvedForTest } from '../shell/resolved-store.js';
import { refreshActivity, resetActivityForTest } from '../shell/useActivity.js';
import { mockCompactViewport } from '../shell/viewport.test-support.js';
import { activityResponse, json, needsItem, runningRow, stubFetch, TOKEN } from './mobile.test-support.js';
import { resetMobileToastsForTest } from './mobile-toast.js';
import { ReachStrip } from './MobileRuntime.js';
import { ChunkBoundary, MobileShell } from './MobileShell.js';

function control(over: { paused?: boolean; running?: boolean; kill?: boolean; todayUsd?: number | null } = {}): VerseControlSnapshot {
  return {
    generatedAt: '2026-09-27T12:00:00Z',
    daemon: { running: over.running ?? true },
    fleet: {},
    caps: {},
    scope: {},
    killSwitch: { state: over.kill ? 'active' : 'inactive', sourceState: 'healthy', reason: over.kill ? 'Emergency stop engaged.' : '', note: '' },
    pause: { state: over.paused ? 'paused' : 'running', sourceState: 'healthy', reason: over.paused ? 'Paused from your phone.' : '', pausedAt: null, by: null, note: '' },
    pendingApprovals: 0,
    spend: { todayUsd: over.todayUsd === undefined ? 3.2 : over.todayUsd, todayDate: '2026-09-27', dailyBudgetUsd: 25 },
    quota: [],
    dispatchEnabled: true,
  } as unknown as VerseControlSnapshot;
}

function fleetLive(state: FleetLiveSnapshotV1['state'] = 'running'): FleetLiveSnapshotV1 {
  return {
    v: 1,
    generatedAt: '2026-09-27T12:00:00Z',
    state,
    stateReason: null,
    lastActivityAt: null,
    summary: { building: 2, queued: 1, parked: 0, waitingVerify: 0, mergedToday: 1, revertsToday: 0, merged7d: 4, postMergeGreenPct7d: null, cycleTimeP50Ms7d: null },
    lanes: [],
    runs: [],
    funnel: null,
    repos: [],
  };
}

const ACTIVITY = activityResponse({
  running: [runningRow({ sessionId: 'vs_9', title: 'Ship the phone app' })],
  needsYou: [needsItem()],
});

function mac(over: { control?: unknown; activity?: unknown; dispatch?: boolean; onDaemon?: (body: Record<string, unknown> | null) => unknown } = {}) {
  return stubFetch({
    'GET /api/verse/bootstrap': bootstrap({ dispatchEnabled: over.dispatch ?? true }),
    'GET /api/verse/seats': { seats: bootstrap().seats, localRuntime: bootstrap().localRuntime },
    'GET /api/verse/activity': over.activity ?? ACTIVITY,
    'GET /api/verse/control': over.control ?? control(),
    'GET /api/verse/fleet/live': fleetLive(),
    'GET /api/verse/cloud': json({ error: 'not found' }, 404),
    'POST /api/verse/daemon': (body: Record<string, unknown> | null) => over.onDaemon?.(body) ?? { ok: true, action: body?.action, note: 'Done on your Mac.' },
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/m/');
  evictAll();
  resetGuard();
  resetResolvedForTest();
  resetActivityForTest();
  resetMobileToastsForTest();
  clearMutationToken();
  act(() => markCheckComplete(true));
});

afterEach(() => {
  resetActivityForTest();
  resetGuard();
  clearMutationToken();
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function homeLoaded() {
  await screen.findByText('Ship the phone app');
  await screen.findByText('Running');
}

describe('the shell', () => {
  it('draws five tabs with Home current, and badges once the runtime has counted', async () => {
    mac();
    render(<MobileShell />);
    // The frame paints before the runtime chunk: tabs, no badges yet.
    const frameTabs = screen.getByRole('navigation', { name: 'Phantom' });
    expect(within(frameTabs).getAllByRole('button')).toHaveLength(5);
    expect(within(frameTabs).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(within(frameTabs).getByRole('button', { name: 'Needs you' })).toBeInTheDocument();
    // Then the runtime lands (the frame is redrawn with the live context).
    expect(await screen.findByRole('button', { name: 'Needs you, 1 waiting' }, { timeout: 4000 })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Phantom' });
    expect(within(tabs).getByRole('button', { name: 'Agents, 1 working' })).toBeInTheDocument();
  });

  it('switches screens through the hash (so Back works), and a re-tap pops to the tab root', async () => {
    mac();
    render(<MobileShell />);
    await homeLoaded();
    const tabs = screen.getByRole('navigation', { name: 'Phantom' });
    fireEvent.click(within(tabs).getByRole('button', { name: /^More/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/more'));
    await waitFor(() => expect(within(tabs).getByRole('button', { name: /^More/ })).toHaveAttribute('aria-current', 'page'));
    act(() => {
      window.location.hash = '#/fleet';
    });
    await waitFor(() => expect(within(tabs).getByRole('button', { name: /^More/ })).toHaveAttribute('aria-current', 'page'));
    fireEvent.click(within(tabs).getByRole('button', { name: /^More/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/more'));
  });

  it('says the Mac is unreachable when a poll fails, keeping the last data on screen', async () => {
    mac();
    render(<MobileShell />);
    await homeLoaded();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await act(async () => {
      await refreshActivity();
    });
    expect(await screen.findByText(/Can’t reach your Mac\. Updated just now\./)).toBeInTheDocument();
    expect(screen.getByText('Ship the phone app')).toBeInTheDocument();
  });

  it('says the phone is offline when the browser reports it', async () => {
    mac();
    render(<MobileShell />);
    await homeLoaded();
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText(/This phone is offline/)).toBeInTheDocument();
    onLine.mockRestore();
  });
});

describe('ChunkBoundary', () => {
  it('turns a chunk that cannot load into a sentence and a reload, not a blank app', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never {
      throw new TypeError('Failed to fetch dynamically imported module');
    }
    render(<ChunkBoundary><Broken /></ChunkBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    quiet.mockRestore();
  });
});

describe('ReachStrip', () => {
  it('does not promise cached data before the first successful update', () => {
    const { rerender } = render(<ReachStrip state="offline" updatedAt={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('This phone is offline. No update yet.');
    rerender(<ReachStrip state="offline" updatedAt={Date.now()} />);
    expect(screen.getByRole('status')).toHaveTextContent('This phone is offline — showing the last update.');
  });
});

describe('Home', () => {
  it('shows skeletons before the Mac answers', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    render(<MobileShell />);
    expect(screen.getByRole('heading', { name: 'Phantom', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole('status', { name: /Loading/ }).length).toBeGreaterThan(0);
  });

  it('shows the fleet, what needs you, who is working, and today’s spend', async () => {
    mac();
    render(<MobileShell />);
    await homeLoaded();
    expect(screen.getByText('2 runs building · 1 queued')).toBeInTheDocument();
    expect(screen.getByText('$3.20')).toBeInTheDocument();
    expect(screen.getByText('of $25.00')).toBeInTheDocument();
    const main = screen.getByRole('main');
    fireEvent.click(within(main).getByRole('button', { name: /Needs you/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/needs'));
    act(() => {
      window.location.hash = '#/';
    });
    await screen.findByText('Ship the phone app');
    fireEvent.click(screen.getByRole('button', { name: /Ship the phone app/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/agents/vs_9'));
  });

  it('an unreadable figure is a dash, never zero', async () => {
    mac({ control: json({ error: 'ledger unreadable' }, 503) });
    render(<MobileShell />);
    await screen.findByText('Ship the phone app');
    const spent = screen.getByText('Spent today').closest('div')!;
    expect(within(spent).getByText('—')).toBeInTheDocument();
  });

  it('Pause runs at once (no sheet) with the held token, then says so', async () => {
    setMutationToken(TOKEN);
    const fetches = mac();
    render(<MobileShell />);
    await homeLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(fetches.posts()).toHaveLength(1));
    const post = fetches.posts()[0]!;
    expect(post.url).toBe('/api/verse/daemon');
    expect(post.body).toEqual({ action: 'pause' });
    expect(post.headers['x-ashlr-token']).toBe(TOKEN);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Done on your Mac.')).toBeInTheDocument();
  });

  it('Resume confirms with its consequences first; Cancel sends nothing', async () => {
    setMutationToken(TOKEN);
    const fetches = mac({ control: control({ paused: true }) });
    render(<MobileShell />);
    await screen.findByText('Paused');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Resume the fleet?' });
    expect(within(sheet).getByText(/spends from your seats/)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetches.posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(fetches.posts().map((p) => p.body)).toEqual([{ action: 'resume' }]));
  });

  it('asks for the mutation token when it is not held, then runs', async () => {
    const fetches = mac();
    render(<MobileShell />);
    await homeLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const sheet = await screen.findByRole('dialog', { name: 'Unlock actions' });
    const field = within(sheet).getByLabelText('Mutation token');
    fireEvent.change(field, { target: { value: 'not-a-token' } });
    fireEvent.click(within(sheet).getByRole('button', { name: /Unlock and pause/ }));
    expect(within(sheet).getByText(/Expected 64 hex characters/)).toBeInTheDocument();
    expect(fetches.posts()).toHaveLength(0);
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(within(sheet).getByRole('button', { name: /Unlock and pause/ }));
    await waitFor(() => expect(fetches.posts()).toHaveLength(1));
    expect(fetches.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
  });

  it('a kill switch offers no release from the phone — only details', async () => {
    mac({ control: control({ kill: true }) });
    render(<MobileShell />);
    await screen.findByText('Emergency stop engaged.');
    expect(screen.queryByRole('button', { name: /Resume|Start/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    await waitFor(() => expect(window.location.hash).toBe('#/fleet'));
  });

  it('a read-only device sees no action at all', async () => {
    mac({ dispatch: false });
    render(<MobileShell />);
    await homeLoaded();
    await screen.findByText('Read-only on this device');
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New agent' })).not.toBeInTheDocument();
  });

  it('renders at 375 wide with nothing sized wider than the screen', async () => {
    const vp = mockCompactViewport();
    mac();
    const { container } = render(<MobileShell />);
    await homeLoaded();
    for (const el of container.querySelectorAll<HTMLElement>('[style]')) {
      const width = el.style.width || el.style.minWidth;
      if (width.endsWith('px')) expect(Number.parseFloat(width)).toBeLessThanOrEqual(375);
    }
    vp.restore();
  });
});

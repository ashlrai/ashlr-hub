/**
 * useSeatsRefresh.test.tsx — the other half of "usage is not showing".
 *
 * `/api/verse/bootstrap` carries the seats and has no SSE invalidation, so it
 * is re-read only on mount and after a write. The account collector needs
 * roughly a cycle and a half — about 75 seconds measured — before its first
 * readings exist. Open the app cold and the one read that ever happens lands
 * BEFORE any reading exists, so every seat reads "unknown" for the rest of
 * the session no matter how correctly the panel renders.
 *
 * V3.10: the poll reads the cheap `GET /api/verse/seats` and merges it into the
 * cached bootstrap, instead of re-reading all of bootstrap (~384 ms of server
 * event-loop time per poll, measured).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MockEventSource } from './fixtures.test-support.js';
import { openVerseListChannel, resetVerseListChannelCapabilities } from './verse-events.js';
import { markCheckComplete, setMutationToken, clearMutationToken } from '../../data/auth-store.js';
import { evictAll, getQuerySnapshot, invalidate, runQuery } from '../../data/cache.js';
import type { VerseBootstrap } from '../../data/api-types.js';
import { mergeSeatsIntoBootstrap, refreshAccountReading, refreshSeats, SEATS_POLL_MS, SEATS_STARTUP_POLL_MS, SEATS_STARTUP_WINDOW_MS, useSeatsRefresh } from './useSeatsRefresh.js';
import { VERSE_BOOTSTRAP_KEY, verseBootstrapQuery } from './verse-queries.js';

function Probe({ active = true }: { active?: boolean }) {
  useSeatsRefresh(active);
  return null;
}

function calls(fragment: string): number {
  const mock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } };
  return mock.mock.calls.filter(([input]) => String(input).includes(fragment)).length;
}
const bootstrapCalls = (): number => calls('/api/verse/bootstrap');
const seatsCalls = (): number => calls('/api/verse/seats');
const pollCalls = (): number => bootstrapCalls() + seatsCalls();

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

const BOOTSTRAP = {
  seats: [{ id: 'stale-seat' }],
  localRuntime: { ollama: { reachable: false, baseUrl: 'http://x', models: [] } },
  projects: [{ path: '/p', name: 'p', enrolled: true }],
} as unknown as VerseBootstrap;

const LIVE_SEATS = {
  sampledAt: '2026-09-23T20:00:00.000Z',
  accountTelemetry: { refreshing: false, pendingAccountIds: [] },
  seats: [{ id: 'live-seat' }],
  localRuntime: { ollama: { reachable: true, baseUrl: 'http://x', models: ['qwen'] } },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  evictAll();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/verse/seats')) return json(LIVE_SEATS);
    if (url.includes('/api/verse/bootstrap')) return json(BOOTSTRAP);
    return json({});
  }));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  cleanup();
  resetVerseListChannelCapabilities();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useSeatsRefresh', () => {
  it('reads immediately, catches up on initial metadata, then uses the normal cadence', async () => {
    await act(async () => { render(<Probe />); });
    expect(bootstrapCalls()).toBe(1);
    expect(seatsCalls()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_STARTUP_POLL_MS); });
    expect(seatsCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS - 1); });
    expect(seatsCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(seatsCalls()).toBe(2);
    const data = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data!;
    expect(data.seats).toEqual(LIVE_SEATS.seats);
    expect(data.localRuntime).toEqual(LIVE_SEATS.localRuntime);
    expect(data.accountTelemetry).toEqual(LIVE_SEATS.accountTelemetry);
    expect(data.projects).toEqual(BOOTSTRAP.projects);
  });

  it('shares one startup scheduler across every mounted surface', async () => {
    const view = await act(async () => render(<><Probe /><Probe /><Probe /></>));
    expect(bootstrapCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_STARTUP_POLL_MS); });
    expect(seatsCalls()).toBe(1);
    view.unmount();
    const count = pollCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 2); });
    expect(pollCalls()).toBe(count);
  });

  it('reads fast only while real initial checks are pending, and bounds even a stuck startup', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => json(String(input).includes('/seats')
      ? { ...LIVE_SEATS, accountTelemetry: { refreshing: true, pendingAccountIds: ['live-seat'] } } : BOOTSTRAP)));
    await act(async () => { render(<Probe />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_STARTUP_WINDOW_MS); });
    const count = pollCalls();
    expect(count).toBe(1 + SEATS_STARTUP_WINDOW_MS / SEATS_STARTUP_POLL_MS);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS - 1); });
    expect(pollCalls()).toBe(count);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(pollCalls()).toBe(count + 1);
  });

  it('treats malformed progress as unknown and still backs off instead of crashing or waiting forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...BOOTSTRAP, accountTelemetry: null })));
    await act(async () => { render(<Probe />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_STARTUP_WINDOW_MS); });
    const count = pollCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS - 1); });
    expect(pollCalls()).toBe(count);
  });

  it('never starts overlapping reads while a snapshot request is slow', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await act(async () => { render(<><Probe /><Probe /></>); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_STARTUP_WINDOW_MS * 2); });
    expect(pollCalls()).toBe(1);
    await act(async () => { finish(json(BOOTSTRAP)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS - 1); });
    expect(pollCalls()).toBe(1);
  });

  it('stops on sign-out and starts a new identity with no old cached readings', async () => {
    await act(async () => { render(<Probe />); });
    await act(async () => { evictAll(); markCheckComplete(false); });
    const count = pollCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 2); });
    expect(pollCalls()).toBe(count);
    expect(getQuerySnapshot(VERSE_BOOTSTRAP_KEY).data).toBeUndefined();
    await act(async () => { markCheckComplete(true); });
    expect(bootstrapCalls()).toBe(2);
  });

  it('a manual refresh supersedes an older in-flight snapshot', async () => {
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => BOOTSTRAP);
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); })));
    await act(async () => { render(<Probe />); });
    let fresh!: Promise<void>;
    await act(async () => { fresh = refreshSeats(); });
    expect(seatsCalls()).toBe(2);
    await act(async () => { resolvers[1]!(json(LIVE_SEATS)); await fresh; });
    await act(async () => { resolvers[0]!(json({ ...LIVE_SEATS, seats: [{ id: 'old-seat' }] })); });
    expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data!.seats).toEqual(LIVE_SEATS.seats);
  });

  it('startup ticks join a slow manual refresh rather than issue overlapping snapshots', async () => {
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => BOOTSTRAP);
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); })));
    await act(async () => { render(<Probe />); });
    let fresh!: Promise<void>;
    await act(async () => { fresh = refreshSeats(); });
    await act(async () => { resolvers[0]!(json(LIVE_SEATS)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_STARTUP_POLL_MS * 3); });
    expect(seatsCalls()).toBe(2);
    expect(getQuerySnapshot(VERSE_BOOTSTRAP_KEY).status).toBe('refreshing');
    await act(async () => { resolvers[1]!(json(LIVE_SEATS)); await fresh; });
  });

  it('never turns a later full refresh (after a write) into a seats-only read', async () => {
    await act(async () => { await runQuery(VERSE_BOOTSTRAP_KEY, () => verseBootstrapQuery.fetch()); });
    await act(async () => { render(<Probe />); });
    expect(seatsCalls()).toBe(1);
    const before = bootstrapCalls();
    await act(async () => { invalidate(VERSE_BOOTSTRAP_KEY); await vi.advanceTimersByTimeAsync(0); });
    expect(bootstrapCalls()).toBe(before + 1);
    expect(seatsCalls()).toBe(1);
  });

  it('asks for nothing while the window is hidden, and catches up the moment it is looked at', async () => {
    render(<Probe />);
    await act(async () => { setVisibility('hidden'); });
    const afterHide = pollCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 3); });
    // A backgrounded app spawns nothing.
    expect(pollCalls()).toBe(afterHide);

    await act(async () => { setVisibility('visible'); });
    expect(pollCalls()).toBe(afterHide + 1);
  });

  it('stops polling when it is turned off, and after unmount', async () => {
    const view = render(<Probe active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 2); });
    expect(pollCalls()).toBe(0);

    await act(async () => { view.rerender(<Probe active />); });
    expect(pollCalls()).toBe(1);

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 2); });
    expect(pollCalls()).toBe(1);
  });

  it('merges only the seat list and local runtime', () => {
    const merged = mergeSeatsIntoBootstrap(BOOTSTRAP, LIVE_SEATS as never);
    expect(merged).toEqual({ ...BOOTSTRAP, seats: LIVE_SEATS.seats, localRuntime: LIVE_SEATS.localRuntime, accountTelemetry: LIVE_SEATS.accountTelemetry });
    expect(BOOTSTRAP.seats).toEqual([{ id: 'stale-seat' }]);
  });
});


describe('published readings after startup', () => {
  it('updates each late account independently, keeping history and unknown current credits distinct', async () => {
    let seats = [{ id: 'account-a', health: 'unknown', codexCredits: null }, { id: 'account-b', health: 'unknown', codexCredits: null }];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => json(String(input).includes('/seats')
      ? { ...LIVE_SEATS, seats, accountTelemetry: { refreshing: true, pendingAccountIds: seats.filter(row => row.health === 'unknown').map(row => row.id) } }
      : { ...BOOTSTRAP, seats })));
    const dispose = openVerseListChannel();
    try {
      await act(async () => { render(<><Probe /><Probe /></>); });
      await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_STARTUP_WINDOW_MS + 1000); });
      const before = seatsCalls();
      seats = [{ id: 'account-a', health: 'healthy', codexCredits: null }, seats[1]!];
      await act(async () => {
        MockEventSource.instances.at(-1)!.emitNamed('verse-account-readings', { changed: true });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(seatsCalls()).toBe(before + 1);
      expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data!.seats).toEqual(seats);
      seats = [seats[0]!, { id: 'account-b', health: 'unavailable', codexCredits: null }];
      await act(async () => {
        const es = MockEventSource.instances.at(-1)!;
        es.emitNamed('verse-account-readings', { changed: true });
        es.emitNamed('verse-account-readings', { changed: true });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(seatsCalls()).toBe(before + 2);
      expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data!.seats).toEqual(seats);
      const count = pollCalls();
      await act(async () => { setVisibility('hidden'); });
      MockEventSource.instances.at(-1)!.emitNamed('verse-account-readings', { changed: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
      expect(pollCalls()).toBe(count);
    } finally { dispose(); }
  });

  it('coalesces a publication burst during an in-flight read into one catch-up read', async () => {
    await runQuery(VERSE_BOOTSTRAP_KEY, async () => BOOTSTRAP);
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolvers.push(resolve); })));
    const dispose = openVerseListChannel();
    try {
      await act(async () => { render(<Probe />); });
      await act(async () => {
        const es = MockEventSource.instances.at(-1)!;
        for (let i = 0; i < 12; i++) es.emitNamed('verse-account-readings', { changed: true });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(seatsCalls()).toBe(1);
      await act(async () => { resolvers[0]!(json(LIVE_SEATS)); });
      expect(seatsCalls()).toBe(2);
      await act(async () => { resolvers[1]!(json(LIVE_SEATS)); });
      expect(seatsCalls()).toBe(2);
      await act(async () => { markCheckComplete(false); });
      MockEventSource.instances.at(-1)!.emitNamed('verse-account-readings', { changed: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(seatsCalls()).toBe(2);
    } finally { dispose(); }
  });
});


describe('selected account reading confirmation', () => {
  const token = 'b'.repeat(64);
  const instant = '2026-09-23T20:00:00.000Z';
  const receipt = { seatId: 'target', state: 'completed', reading: 'current', reason: 'probe-observed',
    observedAt: instant, expiresAt: '2026-09-23T20:01:00.000Z', nextCheckAt: '2026-09-23T20:00:30.000Z', joined: false };
  const target = { id: 'target', health: { state: 'ready' }, capacity: { evidenceSource: 'collector', observedAt: instant,
    windows: [{ usedPercent: 0 }], credits: null } };
  async function seed() {
    vi.setSystemTime(instant); setMutationToken(token);
    await runQuery(VERSE_BOOTSTRAP_KEY, () => Promise.resolve(BOOTSTRAP));
  }
  afterEach(() => clearMutationToken());

  it('refuses same-token re-hold while the selected mutation chunk loads, before any POST', async () => {
    await seed();
    const fetch = vi.fn(async () => json(receipt)); vi.stubGlobal('fetch', fetch);
    const check = refreshAccountReading('target');
    clearMutationToken(); setMutationToken(token);
    await expect(check).rejects.toThrow('interrupted');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends only the selected id and confirms actual zero usage from a fresh target read', async () => {
    await seed();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input); requests.push({ url, init });
      return json(init?.method === 'POST' ? receipt : { ...LIVE_SEATS, seats: [target] });
    }));
    expect(await refreshAccountReading('target')).toEqual(receipt);
    expect(requests.map(r => [r.url, r.init?.method ?? 'GET'])).toEqual([
      ['/api/verse/seats/refresh', 'POST'], ['/api/verse/seats', 'GET']]);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ seatId: 'target' });
    expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data?.seats).toEqual([target]);
  });

  it('accepts a newer current collector observation that wins the selected readback race', async () => {
    await seed(); vi.setSystemTime('2026-09-23T20:00:02.000Z');
    const newer = { ...target, capacity: { ...target.capacity, observedAt: '2026-09-23T20:00:01.000Z' } };
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => json(init?.method === 'POST'
      ? receipt : { ...LIVE_SEATS, seats: [newer] })));
    expect(await refreshAccountReading('target')).toEqual(receipt);
    expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data?.seats).toEqual([newer]);
  });

  it.each(['old', 'historical', 'auth-only', 'missing'])('refuses %s readback rather than claiming fresh quota', async shape => {
    await seed();
    const seat = shape === 'old' ? { ...target, capacity: { ...target.capacity, observedAt: '2026-09-23T19:59:00.000Z' } }
      : shape === 'historical' ? { ...target, capacity: { ...target.capacity, evidenceSource: 'baseline' } }
        : shape === 'auth-only' ? { ...target, capacity: { ...target.capacity, windows: [] } } : null;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => json(init?.method === 'POST'
      ? receipt : { ...LIVE_SEATS, seats: seat ? [seat] : [] })));
    await expect(refreshAccountReading('target')).rejects.toThrow('does not confirm');
    expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data).toEqual(BOOTSTRAP);
  });

  it.each(['malformed-credit', 'expired-credit', 'future', 'malformed-next-check'])('refuses %s current evidence', async shape => {
    await seed();
    const credits = { hasCredits: true, unlimited: false, balance: shape === 'malformed-credit' ? 'Infinity' : '0.5' };
    const seat = { ...target, capacity: { ...target.capacity, windows: [], credits,
      observedAt: shape === 'future' ? '2026-09-23T20:00:01.000Z' : instant,
      creditsExpiresAt: shape === 'expired-credit' ? '2026-09-23T19:59:00.000Z' : receipt.expiresAt } };
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => json(init?.method === 'POST'
      ? { ...receipt, nextCheckAt: shape === 'malformed-next-check' ? 'unknown' : receipt.nextCheckAt } : { ...LIVE_SEATS, seats: [seat] })));
    await expect(refreshAccountReading('target')).rejects.toThrow(/could not be confirmed|does not confirm/);
    expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data).toEqual(BOOTSTRAP);
  });

  it('refuses token loss and re-hold even when the same token returns before POST completes', async () => {
    await seed(); let release!: (value: Response) => void;
    let started!: () => void; const contacted = new Promise<void>(resolve => { started = resolve; });
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; started(); })); vi.stubGlobal('fetch', fetch);
    const check = refreshAccountReading('target');
    await contacted;
    clearMutationToken(); setMutationToken(token); release(json(receipt));
    await expect(check).rejects.toThrow('interrupted'); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not admit a late GET after caller disposal or restore bootstrap after eviction', async () => {
    await seed(); let release!: (value: Response) => void; let live = true;
    let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => init?.method === 'POST'
      ? json(receipt) : new Promise<Response>(resolve => { release = resolve; started(); })));
    const check = refreshAccountReading('target', () => live);
    await reading;
    live = false; evictAll(); release(json({ ...LIVE_SEATS, seats: [target] }));
    await expect(check).rejects.toThrow('interrupted');
    expect(getQuerySnapshot(VERSE_BOOTSTRAP_KEY).data).toBeUndefined();
  });

  it('does not confirm when the cache swallows a merge failure after bootstrap eviction', async () => {
    await seed(); evictAll();
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => json(init?.method === 'POST'
      ? receipt : { ...LIVE_SEATS, seats: [target] })));
    await expect(refreshAccountReading('target')).rejects.toThrow('interrupted');
    expect(getQuerySnapshot(VERSE_BOOTSTRAP_KEY).data).toBeUndefined();
    expect(getQuerySnapshot(VERSE_BOOTSTRAP_KEY).status).toBe('error');
  });

  it('reports a held unknown check without inventing usage or a new provider reading', async () => {
    await seed(); const held = { ...receipt, state: 'held', reading: 'unknown', observedAt: null, expiresAt: null,
      reason: 'connection-collector-held' };
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => json(init?.method === 'POST'
      ? held : { ...LIVE_SEATS, seats: [] })));
    expect(await refreshAccountReading('target')).toEqual(held);
    expect(getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data?.seats).toEqual([]);
  });
});

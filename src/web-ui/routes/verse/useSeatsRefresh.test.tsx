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
import { act, render } from '@testing-library/react';
import { evictAll, getQuerySnapshot, invalidate, runQuery } from '../../data/cache.js';
import type { VerseBootstrap } from '../../data/api-types.js';
import { mergeSeatsIntoBootstrap, SEATS_POLL_MS, useSeatsRefresh } from './useSeatsRefresh.js';
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
  seats: [{ id: 'live-seat' }],
  localRuntime: { ollama: { reachable: true, baseUrl: 'http://x', models: ['qwen'] } },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  evictAll();
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
  vi.useRealTimers();
});

describe('useSeatsRefresh', () => {
  it('re-reads the roster on the collector’s own cadence', async () => {
    render(<Probe />);
    expect(pollCalls()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(pollCalls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(pollCalls()).toBe(2);
  });

  it('reads the full bootstrap only when nothing is cached, then polls /seats and merges it in', async () => {
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(bootstrapCalls()).toBe(1);
    expect(seatsCalls()).toBe(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(bootstrapCalls()).toBe(1);
    expect(seatsCalls()).toBe(1);
    const data = getQuerySnapshot<VerseBootstrap>(VERSE_BOOTSTRAP_KEY).data!;
    expect(data.seats).toEqual(LIVE_SEATS.seats);
    expect(data.localRuntime).toEqual(LIVE_SEATS.localRuntime);
    // Everything else in bootstrap is kept as it was.
    expect(data.projects).toEqual(BOOTSTRAP.projects);
  });

  it('never turns a later full refresh (after a write) into a seats-only read', async () => {
    await act(async () => { await runQuery(VERSE_BOOTSTRAP_KEY, () => verseBootstrapQuery.fetch()); });
    render(<Probe />);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
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

    view.rerender(<Probe active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS); });
    expect(pollCalls()).toBe(1);

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(SEATS_POLL_MS * 2); });
    expect(pollCalls()).toBe(1);
  });

  it('merges only the seat list and local runtime', () => {
    const merged = mergeSeatsIntoBootstrap(BOOTSTRAP, LIVE_SEATS as never);
    expect(merged).toEqual({ ...BOOTSTRAP, seats: LIVE_SEATS.seats, localRuntime: LIVE_SEATS.localRuntime });
    expect(BOOTSTRAP.seats).toEqual([{ id: 'stale-seat' }]);
  });
});

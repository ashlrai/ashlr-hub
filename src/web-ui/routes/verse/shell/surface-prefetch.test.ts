/**
 * surface-prefetch — the reads the shell warms at idle for each rail surface
 * (shell/warmup.ts). Pins the lists to what Command, Growth and Mind really
 * read, that a warmed surface paints with no loading state, and that the
 * warm-up reads go out ONE AT A TIME behind the idle gate.
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ensureQuery, evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { CommandSection } from '../sections/CommandSection.js';
import { GrowthSection } from '../sections/GrowthSection.js';
import { MindSection } from '../sections/MindSection.js';
import { resetActivityForTest } from './useActivity.js';
import { mockWideViewport, type ViewportMock } from './viewport.test-support.js';
import { PREFETCH_FRESH_MS, SURFACE_PREFETCH, prefetchSurfaceData } from './surface-prefetch.js';

let vp: ViewportMock | null = null;
beforeEach(() => {
  evictAll();
  resetActivityForTest();
  vp = mockWideViewport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetActivityForTest();
  vp?.restore();
});

/**
 * Reads the shell keeps warm on its own from first paint, so no surface's
 * table needs them: the one activity poll (VerseApp's rail) and the chat's
 * opening reads (bootstrap, sessions, workspaces — chat paints first).
 */
const SHELL_OWNED = ['/api/verse/activity', '/api/verse/bootstrap', '/api/verse/sessions', '/api/verse/workspaces'];

const getPaths = (fetchMock: ReturnType<typeof vi.fn>) =>
  new Set(
    fetchMock.mock.calls
      .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')
      .map(([input]) => String(input))
      .filter((path) => !SHELL_OWNED.some((owned) => path.startsWith(owned))),
  );

type Ensure = NonNullable<Parameters<typeof prefetchSurfaceData>[1]>['ensure'];

describe('surface prefetch', () => {
  it.each([
    ['command', CommandSection, () => screen.findByRole('group', { name: 'Capacity per seat' })],
    ['growth', GrowthSection, () => screen.findByRole('figure', { name: 'Harness level' })],
    ['mind', MindSection, () => screen.findByRole('figure', { name: 'Struggles and wins' })],
  ] as const)('warms every read %s makes on mount', async (id, Section, painted) => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live' });
    const { unmount } = render(createElement(Section));
    await painted();
    await waitFor(() => expect(screen.queryAllByText('Loading…')).toHaveLength(0));
    const mounted = getPaths(fetchMock);
    unmount();

    evictAll();
    fetchMock.mockClear();
    await Promise.all((SURFACE_PREFETCH[id] ?? []).map((def) => def.fetch().catch(() => undefined)));
    const warmed = getPaths(fetchMock);
    expect(mounted.size, `${id} mounted with no reads at all — the pin would be vacuous`).toBeGreaterThan(0);
    for (const path of mounted) expect(warmed, `${id} reads ${path} on mount but the prefetch does not warm it`).toContain(path);
  });

  it('warms Command’s seat history, so a first visit draws the recorded week — not “since Verse opened”', async () => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live' });
    await prefetchSurfaceData('command');
    expect([...getPaths(fetchMock)].some((path) => path.startsWith('/api/verse/budget/history'))).toBe(true);
  });

  it('warms Command’s Cloud card (3.11), so its first visit paints the credits, not “Reading the cloud lane…”', async () => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live' });
    await prefetchSurfaceData('command');
    expect(getPaths(fetchMock)).toContain('/api/verse/cloud');
    // Lazy only: the table reaches the cloud module, VerseApp never does.
    expect(SURFACE_PREFETCH.command!.map((d) => d.key)).toContain('verse-cloud');
  });

  it('a warmed Growth paints its charts on the very first render — no loading state', async () => {
    stubSurfaceFetch({ kind: 'live' });
    await prefetchSurfaceData('growth');
    render(createElement(GrowthSection));
    // Synchronously after the first render: nothing is loading.
    expect(screen.getByRole('figure', { name: 'Harness level' })).not.toHaveTextContent('Loading…');
    expect(screen.getByRole('figure', { name: 'Merges per week' })).not.toHaveTextContent('Loading…');
    expect(screen.queryAllByText('Loading…')).toHaveLength(0);
  });

  it('goes through the shared cache with the prefetch freshness, and never rejects', async () => {
    const ensure = vi.fn<NonNullable<Ensure>>(() => Promise.resolve());
    await prefetchSurfaceData('mind', { ensure });
    expect(ensure.mock.calls.map(([key]) => key)).toEqual((SURFACE_PREFETCH.mind ?? []).map((d) => d.key));
    expect(ensure.mock.calls.every(([, , maxAge]) => maxAge === PREFETCH_FRESH_MS)).toBe(true);
    await expect(prefetchSurfaceData('growth', { ensure: () => { throw new Error('boom'); } })).resolves.toBeUndefined();
    await expect(prefetchSurfaceData('growth', { ensure: () => Promise.reject(new Error('boom')) })).resolves.toBeUndefined();
    await expect(prefetchSurfaceData('settings', { ensure })).resolves.toBeUndefined();
    for (const id of ['command', 'fleet', 'growth', 'mind', 'chat'] as const) expect(SURFACE_PREFETCH[id]?.length, id).toBeGreaterThan(0);
  });

  it('issues ONE read at a time — the next only after the last has settled', async () => {
    const releases: Array<() => void> = [];
    const ensure = vi.fn<NonNullable<Ensure>>(() => new Promise<void>((resolve) => releases.push(resolve)));
    const run = prefetchSurfaceData('command', { ensure });
    const total = SURFACE_PREFETCH.command!.length;
    for (let i = 1; i <= total; i += 1) {
      await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(i));
      // Nothing else starts while this one is out.
      await Promise.resolve();
      expect(ensure).toHaveBeenCalledTimes(i);
      releases[i - 1]!();
    }
    await run;
    expect(ensure).toHaveBeenCalledTimes(total);
  });

  it('waits for the idle gate before EACH read, and stops when the gate is cancelled', async () => {
    const order: string[] = [];
    const ensure = vi.fn<NonNullable<Ensure>>(async (key) => { order.push(`read ${key}`); });
    let opened = 0;
    await prefetchSurfaceData('growth', {
      ensure,
      beforeEach: () => {
        order.push('gate');
        opened += 1;
        return opened <= 2; // the gate is cancelled before the third read
      },
    });
    const [first, second] = SURFACE_PREFETCH.growth!;
    expect(order).toEqual(['gate', `read ${first!.key}`, 'gate', `read ${second!.key}`, 'gate']);
  });

  it('leaves a key the cache already holds fresh alone — no request', async () => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live' });
    const [history] = SURFACE_PREFETCH.growth!;
    await ensureQuery(history!.key, () => history!.fetch(), PREFETCH_FRESH_MS);
    fetchMock.mockClear();
    await prefetchSurfaceData('growth');
    expect([...getPaths(fetchMock)].some((path) => path.startsWith('/api/verse/fleet/history'))).toBe(false);
  });
});

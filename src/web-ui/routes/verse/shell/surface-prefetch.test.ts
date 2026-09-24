/**
 * surface-prefetch — the reads the shell warms at idle for each rail surface
 * (VerseApp `prefetchAfterFirstPaint`). Pins the lists to what Growth and
 * Mind really read, and that a warmed surface paints with no loading state.
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ensureQuery, evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { GrowthSection } from '../sections/GrowthSection.js';
import { MindSection } from '../sections/MindSection.js';
import { mockWideViewport, type ViewportMock } from './viewport.test-support.js';
import { PREFETCH_FRESH_MS, SURFACE_PREFETCH, prefetchSurfaceData } from './surface-prefetch.js';

let vp: ViewportMock | null = null;
beforeEach(() => {
  evictAll();
  vp = mockWideViewport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vp?.restore();
});

const getPaths = (fetchMock: ReturnType<typeof vi.fn>) =>
  new Set(
    fetchMock.mock.calls
      .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')
      .map(([input]) => String(input)),
  );

describe('surface prefetch', () => {
  it.each([
    ['growth', GrowthSection, 'Harness level'],
    ['mind', MindSection, 'Struggles and wins'],
  ] as const)('warms every read %s makes on mount', async (id, Section, figure) => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live' });
    const { unmount } = render(createElement(Section));
    await screen.findByRole('figure', { name: figure });
    await waitFor(() => expect(screen.queryAllByText('Loading…')).toHaveLength(0));
    const mounted = getPaths(fetchMock);
    unmount();

    evictAll();
    fetchMock.mockClear();
    await Promise.all((SURFACE_PREFETCH[id] ?? []).map((def) => def.fetch().catch(() => undefined)));
    const warmed = getPaths(fetchMock);
    for (const path of mounted) expect(warmed, `${id} reads ${path} on mount but the prefetch does not warm it`).toContain(path);
  });

  it('a warmed Growth paints its charts on the very first render — no loading state', async () => {
    stubSurfaceFetch({ kind: 'live' });
    const pending: Promise<void>[] = [];
    prefetchSurfaceData('growth', (key, fetcher, maxAgeMs) => {
      const run = ensureQuery(key, fetcher, maxAgeMs);
      pending.push(run);
      return run;
    });
    await Promise.all(pending);
    render(createElement(GrowthSection));
    // Synchronously after the first render: nothing is loading.
    expect(screen.getByRole('figure', { name: 'Harness level' })).not.toHaveTextContent('Loading…');
    expect(screen.getByRole('figure', { name: 'Merges per week' })).not.toHaveTextContent('Loading…');
    expect(screen.queryAllByText('Loading…')).toHaveLength(0);
  });

  it('goes through the shared cache with the prefetch freshness, and never throws', () => {
    const ensure = vi.fn((_key: string, _fetcher: () => Promise<unknown>, _maxAgeMs: number) => Promise.resolve());
    prefetchSurfaceData('mind', ensure);
    expect(ensure.mock.calls.map(([key]) => key)).toEqual((SURFACE_PREFETCH.mind ?? []).map((d) => d.key));
    expect(ensure.mock.calls.every(([, , maxAge]) => maxAge === PREFETCH_FRESH_MS)).toBe(true);
    expect(() => prefetchSurfaceData('growth', () => { throw new Error('boom'); })).not.toThrow();
    expect(() => prefetchSurfaceData('settings', ensure)).not.toThrow();
    for (const id of ['command', 'fleet', 'growth', 'mind', 'chat'] as const) expect(SURFACE_PREFETCH[id]?.length, id).toBeGreaterThan(0);
  });
});

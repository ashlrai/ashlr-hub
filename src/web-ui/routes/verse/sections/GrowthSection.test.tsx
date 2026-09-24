import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { GrowthSection } from './GrowthSection.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { showTable } from '../../../components/charts/chart-test-support.js';
import { formatTimeLabel } from '../../../components/charts/format.js';
import type { ModelStats } from '../../../data/api-types.js';
import { learningState } from '../command/fixtures.test-support.js';
import { HARNESS_BASELINE_WINDOW_MS } from '../growth/growth-model.js';

let vp: ViewportMock | null = null;
beforeEach(() => {
  evictAll();
  vp = mockWideViewport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vp?.restore();
});

const model = (m: string, over: Partial<ModelStats>) => ({ engine: 'local', model: m, dispatches: 0, judged: 0, shipVerdicts: 0, merged: 0, costPerMergedUsd: null, ...over }) as ModelStats;
const models = { window: '30d', models: [model('qwen3.8:27b', { dispatches: 40, judged: 30, shipVerdicts: 18, merged: 14 }), model('grok-4.7', { engine: 'grok-cli', dispatches: 22, judged: 20, shipVerdicts: 15, merged: 12 })], bestOfNSource: { sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [], filesRead: 1, bytesRead: 1, rowsScanned: 1, invalidRows: 0, unreadableFiles: 0 } };

describe('GrowthSection', () => {
  it('draws every Growth chart from live data, each with a table twin', async () => {
    stubSurfaceFetch({ kind: 'live', routes: { '/api/models': models } });
    const { container } = render(<GrowthSection />);
    for (const name of ['Merges per week', 'Cost per merge', 'Pipeline · 90d', 'Model outcomes · 30d', 'Merges by day', 'Harness level', 'Experiments']) {
      await waitFor(() => expect(screen.getByRole('figure', { name })).toBeInTheDocument());
    }
    await waitFor(() => expect(container.querySelector('[data-marker="rollback"]')).not.toBeNull());
    expect(container.querySelectorAll('[data-role="ci"]').length).toBeGreaterThanOrEqual(3);
    showTable('Model outcomes · 30d');
    expect(screen.getByRole('cell', { name: 'qwen3.8:27b' })).toBeInTheDocument();
    showTable('Experiments');
    expect(within(screen.getByRole('figure', { name: 'Experiments' })).getByRole('cell', { name: 'running · 5/8 pairs' })).toBeInTheDocument();
  });

  it('is honest when learning has not landed and history is dark', async () => {
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/learning': null } });
    render(<GrowthSection />);
    // History's `darkSince` is "quiet since", never "dark" (fleet/dark-since.ts quietSinceStatus).
    await waitFor(() => expect(screen.getAllByText('No fleet runs or proposals since Sep 1.').length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getAllByText(/Self-improvement is not in this build yet/).length).toBe(2));
    expect(screen.getByText('No model dispatched fleet work in the last 30 days.')).toBeInTheDocument();
  });

  it('draws a defaults-only harness over its trailing window, never from the epoch baseline stamp', async () => {
    // The live registry's shape: nothing adopted, no experiments, and the
    // compiled-defaults baseline stamped 1970-01-01 (harness-registry.ts).
    const now = Date.parse('2026-09-24T15:00:00Z');
    const live = learningState('sparse', now);
    const learning = { ...live, experiments: [], versions: live.versions.map((v) => ({ ...v, createdAt: '1970-01-01T00:00:00.000Z' })) };
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/models': models, '/api/verse/learning': learning } });
    render(<GrowthSection />);
    const harness = await screen.findByRole('figure', { name: 'Harness level' });
    await waitFor(() => expect(within(harness).queryByText('Loading…')).not.toBeInTheDocument());
    showTable('Harness level');
    const whens = within(harness).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(whens).toEqual([formatTimeLabel(now - HARNESS_BASELINE_WINDOW_MS)]);
    expect(within(harness).queryByText(formatTimeLabel(0))).not.toBeInTheDocument();
    // The experiments card says so in plain words (no stray hyphen).
    expect(within(screen.getByRole('figure', { name: 'Experiments' })).getByText('No experiments have run yet.')).toBeInTheDocument();
  });

  it('stacks into one column at 375', async () => {
    vp?.restore();
    vp = mockCompactViewport({ dark: true });
    stubSurfaceFetch({ kind: 'sparse', routes: { '/api/models': models } });
    const { container } = render(<GrowthSection />);
    await screen.findByRole('figure', { name: 'Merges per week' });
    for (const cell of container.querySelectorAll('[data-span]')) expect((cell as HTMLElement).style.gridColumn).toBe('span 12');
  });
});

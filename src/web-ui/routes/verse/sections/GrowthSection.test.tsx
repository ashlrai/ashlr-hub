import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { GrowthSection } from './GrowthSection.js';
import { evictAll } from '../../../data/cache.js';
import { draftRefused, stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { showTable } from '../../../components/charts/chart-test-support.js';
import { formatDayLabel, formatTimeLabel } from '../../../components/charts/format.js';
import type { ModelStats } from '../../../data/api-types.js';
import { DARK_SINCE, authorityStatus, fleetHistory, learningState } from '../command/fixtures.test-support.js';
import { HARNESS_BASELINE_WINDOW_MS, weeklyBins } from '../growth/growth-model.js';
import { darkSinceLabel } from '../fleet/dark-since.js';

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
    // Autonomy is on and producing: no "off" state, every real data path as before.
    expect(screen.queryByTestId('autonomy-off')).toBeNull();
  });

  it('labels each week by the calendar day it ends on, in every rung of the axis and the table', async () => {
    // Bins used to sit at UTC midnight, and the axis's fallback rung (local
    // formatTimeLabel) read them a day early west of UTC ("wk to Sep 18" but
    // "Sep 17"); run under TZ=America/Los_Angeles to see it.
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/models': models } });
    render(<GrowthSection />);
    const fig = await screen.findByRole('figure', { name: 'Merges per week' });
    await waitFor(() => expect(fig.querySelector('svg')).not.toBeNull());
    const ends = weeklyBins(fleetHistory('live', now).days).map((b) => formatDayLabel(b.endDay));
    for (const t of [...fig.querySelectorAll('svg text')].map((n) => n.textContent ?? '').filter((s) => /[A-Z][a-z]{2} \d/.test(s))) {
      expect(ends.map((d) => [d, `wk to ${d}`]).flat(), t).toContain(t);
    }
    showTable('Merges per week');
    const whens = within(fig).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(whens).toEqual(ends.map((d) => `wk to ${d}`));
  });

  it('names each model in whole words and never gives two columns one label', async () => {
    const snapshots = { ...models, models: [model('claude-haiku-4-5-20251001', { engine: 'claude', dispatches: 9 }), model('claude-haiku-4-5', { engine: 'claude', dispatches: 7 }), model('grok-4.7-fast-reasoning', { engine: 'grok-cli', dispatches: 5 })] };
    stubSurfaceFetch({ kind: 'live', routes: { '/api/models': snapshots } });
    render(<GrowthSection />);
    const fig = await screen.findByRole('figure', { name: 'Model outcomes · 30d' });
    await waitFor(() => expect(within(fig).queryByText('Loading…')).not.toBeInTheDocument());
    showTable('Model outcomes · 30d');
    const names = within(fig).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    // Before: 'claude-haiku-4-5-…' twice and 'grok-4.7-fast-rea…'.
    expect(names).toEqual(['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'grok-4.7-fast…']);
  });

  it('is ONE state, not six empty cards, when autonomy is off and nothing was produced', async () => {
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/learning': null } });
    render(<GrowthSection />);
    const state = await screen.findByRole('region', { name: 'Growth starts with the first fleet run.' });
    expect(state).toHaveTextContent('Autonomy is off. Approve a standing grant to let the fleet work.');
    // THE dark-since day (the live view's), as the viewer's local day.
    expect(state).toHaveTextContent(`Fleet dark since ${darkSinceLabel(DARK_SINCE)}`);
    expect(within(state).getByRole('button', { name: 'Approve in Command' })).toBeInTheDocument();
    expect(screen.queryAllByRole('figure')).toHaveLength(0);
    expect(screen.queryByText(/No fleet runs or proposals|Nothing produced since/)).toBeNull();
  });

  it('asks for the one-time setup, copyable, when no grant can be drafted yet', async () => {
    const custody = { installed: true, keyInitialized: false, githubApp: false, claudeToken: false };
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/authority/draft': draftRefused(), '/api/verse/authority': authorityStatus('dark', Date.now(), { custody }) } });
    render(<GrowthSection />);
    const state = await screen.findByRole('region', { name: 'Growth starts with the first fleet run.' });
    await waitFor(() => expect(within(state).getByRole('button', { name: 'Copy the command: ashlr authority setup' })).toBeInTheDocument());
    expect(state).toHaveTextContent('Autonomy is off. Nothing runs or merges on its own until the one-time setup is done.');
    expect(within(state).getByRole('list', { name: 'Setup: 1 of 5 ready' })).toBeInTheDocument();
  });

  it('keeps the cards that have something real to draw while dormant, each under the one state', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'dark', now, routes: { '/api/models': models, '/api/verse/learning': learningState('live', now) } });
    render(<GrowthSection />);
    const state = await screen.findByRole('region', { name: 'Autonomy is off' });
    for (const name of ['Model outcomes · 30d', 'Harness level', 'Experiments']) expect(await screen.findByRole('figure', { name })).toBeInTheDocument();
    // History cards would each repeat the same "since" date: left out.
    for (const name of ['Merges per week', 'Cost per merge', 'Pipeline · 90d', 'Merges by day']) expect(screen.queryByRole('figure', { name })).toBeNull();
    expect(state.compareDocumentPosition(screen.getByRole('figure', { name: 'Harness level' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps every history card, with short empty lines, when autonomy is off but the fleet produced recently', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'dark', now, routes: { '/api/verse/fleet/history': fleetHistory('live', now) } });
    render(<GrowthSection />);
    await screen.findByRole('region', { name: 'Autonomy is off' });
    for (const name of ['Merges per week', 'Cost per merge', 'Pipeline · 90d', 'Merges by day', 'Model outcomes · 30d']) expect(screen.getByRole('figure', { name })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('No fleet dispatches in 30 days.')).toBeInTheDocument());
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
    expect(within(screen.getByRole('figure', { name: 'Experiments' })).getByText('No experiments yet.')).toBeInTheDocument();
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

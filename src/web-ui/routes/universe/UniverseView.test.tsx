import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseOverview, UniverseRun, UniverseSummary, UniverseTrial } from '../../data/api-types.js';
import { evictAll } from '../../data/cache.js';
import { UniverseView } from './UniverseView.js';

function trial(overrides: Partial<UniverseTrial> = {}): UniverseTrial {
  return {
    id: 'trial-first', variantId: 'small-motor', niche: 'efficient', parentTrialId: null,
    status: 'passed', score: 12, metrics: { quality: 12, latencyMs: 45 },
    artifact: { path: '/experiments/first', digest: 'digest-first', revision: 'a'.repeat(40) },
    durationMs: 321.486, delta: null, selected: true, ...overrides,
  };
}

function run(overrides: Partial<UniverseRun> = {}): UniverseRun {
  return {
    id: 'run-first', universeId: 'compiler', generation: 1,
    manifestDigest: 'manifest-digest', comparatorDigest: 'comparator-digest',
    startedAt: '2026-09-06T12:00:00.000Z', finishedAt: '2026-09-06T12:00:01.000Z',
    status: 'completed', trials: [trial()], durationMs: 1234.567, tokensUsed: null, costUsd: null,
    ...overrides,
  };
}

function summary(): UniverseSummary {
  const latest = trial({ id: 'trial-next', variantId: 'better-motor', parentTrialId: 'trial-first', score: 18, metrics: { quality: 18, latencyMs: 23 }, delta: 6 });
  return {
    manifest: {
      schemaVersion: 1, id: 'compiler', name: 'Compiler laboratory', objective: 'Improve useful compilation work per second.',
      seed: { repo: '/repos/compiler', revision: 'a'.repeat(40) },
      metric: { name: 'quality', direction: 'maximize', minImprovement: 0.5 },
      budget: { maxTrials: 3, maxDurationMs: 60_000, trialTimeoutMs: 10_000, maxParallel: 2 },
      evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1000 },
      variants: [
        { id: 'small-motor', niche: 'efficient', hypothesis: 'Use less context.', command: ['node', 'small.mjs'] },
        { id: 'better-motor', niche: 'efficient', hypothesis: 'Reuse a measured plan.', command: ['node', 'better.mjs'] },
        { id: 'invalid-motor', niche: 'explorer', hypothesis: 'Try a new planner.', command: ['node', 'invalid.mjs'] },
      ],
    },
    manifestDigest: 'manifest-digest', comparatorDigest: 'comparator-digest',
    runs: [run(), run({ id: 'run-next', generation: 2, trials: [latest, trial({ id: 'trial-bad', variantId: 'invalid-motor', niche: 'explorer', score: null, metrics: {}, selected: false, status: 'failed', error: 'Evaluator rejected invalid output.' })] })],
    elites: [{ niche: 'efficient', variantId: latest.variantId, trialId: latest.id, runId: 'run-next', generation: 2, score: 18, metrics: latest.metrics, artifact: latest.artifact!, comparatorDigest: 'comparator-digest' }],
    activeRun: null, sourceState: 'healthy', reasons: [],
  };
}

function overview(overrides: Partial<UniverseOverview> = {}): UniverseOverview {
  return { schemaVersion: 1, sampledAt: '2026-09-06T12:05:00.000Z', sourceState: 'healthy', reasons: [], universes: [summary()], measurementScope: 'local-experiment', ...overrides };
}

function mount(body: UniverseOverview) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter><UniverseView /></MemoryRouter>);
  return fetch;
}

describe('UniverseView', () => {
  beforeEach(() => evictAll());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows persisted archive selection, lineage, raw metrics and unknown model spend', async () => {
    const fetch = mount(overview());
    await screen.findByRole('heading', { name: 'Compiler laboratory' });
    expect(fetch).toHaveBeenCalledWith('/api/universe', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
    expect(screen.getByText('Improve useful compilation work per second.')).toBeInTheDocument();
    expect(screen.getByText('1 / 2 niches populated')).toBeInTheDocument();
    expect(screen.getByText('No retained variant')).toBeInTheDocument();
    const evidence = screen.getByRole('region', { name: 'Evidence for better-motor' });
    expect(within(evidence).getByText('18')).toBeInTheDocument();
    expect(within(evidence).getByText('23')).toBeInTheDocument();
    expect(within(evidence).getByText('small-motor')).toBeInTheDocument();
    expect(within(evidence).getByText('Current niche elite')).toBeInTheDocument();
    expect(within(evidence).getByText('321 ms')).toBeInTheDocument();
    expect(screen.getByText('1.23 s recorded')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('lets the operator compare failed trials without replacing the retained elite', async () => {
    const user = userEvent.setup();
    mount(overview());
    await screen.findByRole('heading', { name: 'Compiler laboratory' });
    await user.click(screen.getByRole('button', { name: /invalid-motor.*explorer/ }));
    const evidence = screen.getByRole('region', { name: 'Evidence for invalid-motor' });
    expect(within(evidence).getByText('Not measured')).toBeInTheDocument();
    expect(within(evidence).getAllByText('Evaluator rejected invalid output.')).toHaveLength(1);
    expect(within(evidence).getByRole('status', { name: 'Trial failure evidence' }).tagName).toBe('PRE');
    expect(within(evidence).getByText('Not admitted. The trial did not finish with a passing measurement.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect better-motor in efficient' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Inspect better-motor in efficient' }));
    expect(screen.getByRole('region', { name: 'Evidence for better-motor' })).toBeInTheDocument();
  });

  it('distinguishes historical admission from the current elite', async () => {
    const user = userEvent.setup();
    mount(overview());
    await screen.findByRole('heading', { name: 'Compiler laboratory' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Generation' }), 'run-first');
    const evidence = screen.getByRole('region', { name: 'Evidence for small-motor' });
    expect(within(evidence).getByText('Established the first measured elite in this niche.')).toBeInTheDocument();
    expect(within(evidence).getByText('Previously admitted; a later trial now holds this niche.')).toBeInTheDocument();
    expect(within(evidence).queryByText('Current niche elite')).not.toBeInTheDocument();
  });

  it('offers an executable demo for a missing store without fabricated results', async () => {
    mount(overview({ sourceState: 'missing', universes: [] }));
    expect(await screen.findByText('ashlr universe demo')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Current niche elite')).not.toBeInTheDocument();
  });

  it('does not describe unreadable history as a first-run empty state', async () => {
    mount(overview({ sourceState: 'degraded', universes: [], reasons: ['Invalid experiment record'] }));
    expect(await screen.findByText('Invalid experiment record')).toBeInTheDocument();
    expect(screen.queryByText('Start your first universe')).not.toBeInTheDocument();
  });

  it('does not infer an empty archive or a replacement winner from degraded history', async () => {
    const current = summary();
    current.sourceState = 'degraded';
    current.reasons = ['Incomplete generation history'];
    current.elites = [];
    mount(overview({ sourceState: 'degraded', universes: [current] }));
    await screen.findByText('Archive incomplete');
    expect(screen.getByText('Admission recorded; the current niche elite could not be verified.')).toBeInTheDocument();
    expect(screen.queryByText('0 / 2 niches populated')).not.toBeInTheDocument();
    expect(screen.queryByText('No retained variant')).not.toBeInTheDocument();
    expect(screen.queryByText('Previously admitted; a later trial now holds this niche.')).not.toBeInTheDocument();
  });

  it('retries transport failures using Refresh', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('offline', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(overview()), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<MemoryRouter><UniverseView /></MemoryRouter>);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: 'Compiler laboratory' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows running measurements without inferring completed selection and refreshes the active run', async () => {
    const current = summary();
    current.activeRun = run({ id: 'run-active', generation: 3, status: 'running', finishedAt: null, trials: [trial({ selected: false })] });
    let tick: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      tick = handler as () => void;
      return 44 as unknown as ReturnType<typeof window.setInterval>;
    });
    const fetch = mount(overview({ universes: [current] }));
    await screen.findByText(/Generation 3: 1 trial measurements recorded/);
    expect(screen.getByText('This generation has not completed. Its measurements have not been admitted to the archive.')).toBeInTheDocument();
    await act(async () => { tick?.(); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});

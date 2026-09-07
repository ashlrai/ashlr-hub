import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseOverview, UniverseRun, UniverseSummary, UniverseTrial } from '../../data/api-types.js';
import type { UniverseGraph } from '../../../core/universe/graph-types.js';
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

function generation(overrides: Partial<NonNullable<UniverseTrial['generation']>> = {}): NonNullable<UniverseTrial['generation']> {
  return {
    schemaVersion: 1, provider: 'local-openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local-coder',
    status: 'succeeded', requestStarted: true, promptDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64), durationMs: 700,
    usage: { state: 'reported', inputTokens: 1200, outputTokens: 150 }, changedFiles: ['candidate.mjs'], ...overrides,
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

function campaign(overrides: Partial<NonNullable<UniverseOverview['campaigns']>[number]> = {}): NonNullable<UniverseOverview['campaigns']>[number] {
  return {
    definition: { schemaVersion: 1, id: 'compiler-search', universeId: 'compiler', feedback: true,
      budget: { maxGenerations: 6, maxDurationMs: 60_000, maxModelRequests: 12, maxStagnantGenerations: 3, maxReportedTokens: 5000 } },
    definitionDigest: 'definition-digest', manifestDigest: 'manifest-digest', comparatorDigest: 'comparator-digest',
    createdAt: '2026-09-06T12:00:00.000Z', startedAt: '2026-09-06T12:00:00.000Z',
    deadlineAt: '2026-09-06T12:01:00.000Z', finishedAt: null, state: 'running', reason: null,
    owner: { pid: 123, startRef: 'a'.repeat(64) }, sourceState: 'healthy', reasons: [],
    steps: [{ ordinal: 1, runId: 'run-first', generation: 1, variantIds: ['small-motor'], reservedModelRequests: 1,
      createdAt: '2026-09-06T12:00:00.000Z', state: 'completed', trialCount: 1, passedTrials: 1, admissions: 1, improvements: 0, tokensUsed: 100 }],
    progress: { attempts: 1, completedRuns: 1, interruptedRuns: 0, reservedModelRequests: 1,
      reportedTokens: 100, recordedTokens: 100, usageComplete: true, admissions: 1, improvements: 0, stagnantGenerations: 0 },
    ...overrides,
  };
}

function mount(body: UniverseOverview) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter><UniverseView /></MemoryRouter>);
  return fetch;
}

function deliveryReport(overrides: Partial<NonNullable<UniverseOverview['deliveryReports']>[number]> = {}): NonNullable<UniverseOverview['deliveryReports']>[number] {
  return {
    universeId: 'compiler', sourceState: 'healthy', reasons: [], deliveries: [{
      schemaVersion: 1, id: 'delivery-1', universeId: 'compiler', trialId: 'trial-first', runId: 'run-first',
      niche: 'efficient', manifestDigest: 'manifest-digest', comparatorDigest: 'comparator-digest',
      artifactDigest: 'artifact-digest', repo: '/repos/compiler', branch: 'codex/compiler-first',
      baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), tree: 'c'.repeat(40), changedFiles: ['compiler.ts'],
      status: 'delivered', createdAt: '2026-09-06T12:00:00.000Z', completedAt: '2026-09-06T12:00:01.000Z',
    }], ...overrides,
  };
}

describe('UniverseView', () => {
  beforeEach(() => evictAll());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([true, false])('navigates only when an exact graph source exists in the current overview (%s)', async (present) => {
    const body = overview();
    const graph: UniverseGraph = {
      schemaVersion: 1, sampledAt: body.sampledAt, universeId: 'compiler', sourceState: 'healthy', complete: true,
      authority: 'observation-only', measurementScope: 'local-experiment',
      nodes: [{ id: 'graph-source', kind: 'trial', label: 'Graph source candidate', universeId: 'compiler', state: 'passed', evidence: 'recorded',
        generation: present ? 1 : 99, runId: present ? 'run-first' : 'run-unavailable', trialId: present ? 'trial-first' : 'trial-unavailable' }],
      edges: [], findings: [], issues: [], counts: { nodes: 1, edges: 0, trials: 1, currentElites: 0, verifiedDeliveries: 0 },
      limits: { maxNodes: 25000, maxEdges: 100000, maxFindings: 128 },
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes('/api/universe/graph?') ? graph : body), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<MemoryRouter><UniverseView /></MemoryRouter>);
    await screen.findByRole('region', { name: 'Evidence for better-motor' });
    expect(fetch).toHaveBeenCalledOnce();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open graph' }));
    await screen.findByRole('button', { name: 'Inspect exact trial evidence' });
    await user.click(screen.getByRole('button', { name: 'Inspect exact trial evidence' }));
    if (present) {
      expect(screen.getByRole('region', { name: 'Evidence for small-motor' })).toBeInTheDocument();
      expect(screen.getByLabelText('Generation')).toHaveValue('run-first');
    } else {
      expect(screen.getByText(/exact trial is not present in the current overview/)).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Evidence for better-motor' })).toBeInTheDocument();
      expect(screen.getByLabelText('Generation')).toHaveValue('run-next');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shows verified local branch provenance and navigates to its source generation', async () => {
    const user = userEvent.setup();
    mount(overview({ deliveryReports: [deliveryReport()] }));
    const region = await screen.findByRole('region', { name: 'Repository delivery' });
    await user.click(within(region).getByText('codex/compiler-first'));
    expect(within(region).getByText('Local branch verified')).toBeInTheDocument();
    expect(within(region).getByText('compiler.ts')).toBeInTheDocument();
    expect(within(region).getByText('artifact-digest')).toBeInTheDocument();
    expect(within(region).getByText(/not a fresh evaluation, a merge, or a production deployment/)).toBeInTheDocument();
    expect(within(region).getByText(`git -C '/repos/compiler' show --stat '${'b'.repeat(40)}'`)).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Inspect source trial' }));
    expect(screen.getByRole('region', { name: 'Evidence for small-motor' })).toBeInTheDocument();
  });

  it('opens the exact delivered trial when its generation has multiple retained niches', async () => {
    const user = userEvent.setup();
    const current = summary();
    current.runs[0]!.trials.push(trial({ id: 'trial-other', variantId: 'other-niche-motor', niche: 'explorer' }));
    const report = deliveryReport();
    report.deliveries[0]!.trialId = 'trial-other';
    report.deliveries[0]!.niche = 'explorer';
    mount(overview({ universes: [current], deliveryReports: [report] }));
    const region = await screen.findByRole('region', { name: 'Repository delivery' });
    await user.click(within(region).getByText('codex/compiler-first'));
    await user.click(within(region).getByRole('button', { name: 'Inspect source trial' }));
    expect(screen.getByRole('region', { name: 'Evidence for other-niche-motor' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Evidence for small-motor' })).not.toBeInTheDocument();
  });

  it.each(['pending', 'unchanged'] as const)('does not count a %s receipt as a delivered branch', async (status) => {
    const report = deliveryReport();
    report.deliveries[0]!.status = status;
    if (status === 'unchanged') report.deliveries[0]!.changedFiles = [];
    mount(overview({ deliveryReports: [report] }));
    const region = await screen.findByRole('region', { name: 'Repository delivery' });
    expect(within(region).getByText(status === 'pending' ? 'Pending; not confirmed delivered' : 'No change; no branch created')).toBeInTheDocument();
    expect(within(region).queryByText('Local branch verified')).not.toBeInTheDocument();
    expect(within(region).queryByText(/show --stat/)).not.toBeInTheDocument();
  });

  it('withholds verified status and delivery commands for drifted branch evidence', async () => {
    mount(overview({ deliveryReports: [deliveryReport({ sourceState: 'degraded', reasons: ['Branch target changed'] })] }));
    const region = await screen.findByRole('region', { name: 'Repository delivery' });
    expect(within(region).getByText('Branch target changed')).toBeInTheDocument();
    expect(within(region).getByText('Unverified record (delivered)')).toBeInTheDocument();
    expect(within(region).queryByText('Local branch verified')).not.toBeInTheDocument();
    expect(within(region).queryByText('Deliver a retained artifact from your terminal')).not.toBeInTheDocument();
  });

  it('does not navigate to an unrelated generation when delivery source history is missing', async () => {
    const report = deliveryReport({ sourceState: 'degraded', reasons: ['Source history unavailable'] });
    report.deliveries[0]!.runId = 'missing-run';
    mount(overview({ deliveryReports: [report] }));
    const region = await screen.findByRole('region', { name: 'Repository delivery' });
    expect(within(region).getByText('Source trial unavailable in the current history.')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Inspect source trial' })).not.toBeInTheDocument();
  });

  it('keeps privacy-filtered home paths runnable and explains hidden digests', async () => {
    const report = deliveryReport();
    report.deliveries[0]!.repo = "~/projects/compiler's library";
    report.deliveries[0]!.artifactDigest = '[REDACTED]';
    report.deliveries[0]!.comparatorDigest = '[REDACTED]';
    mount(overview({ deliveryReports: [report] }));
    const region = await screen.findByRole('region', { name: 'Repository delivery' });
    expect(within(region).getByText(`git -C "$HOME"/'projects/compiler'\\''s library' show --stat '${'b'.repeat(40)}'`)).toBeInTheDocument();
    expect(within(region).getAllByText('Hidden by the console privacy filter')).toHaveLength(2);
    expect(within(region).getByText("ashlr universe deliveries 'compiler' --json")).toBeInTheDocument();
    expect(within(region).queryByText('[REDACTED]')).not.toBeInTheDocument();
  });

  it('offers delivery only for the current verified elite, not every passing trial', async () => {
    mount(overview());
    const region = await screen.findByRole('region', { name: 'Repository delivery' });
    expect(within(region).getByText('No local branches delivered yet.')).toBeInTheDocument();
    expect(within(region).getByText("ashlr universe deliver 'compiler' --trial 'trial-next' --branch 'codex/universe-compiler-trial-ne' --json")).toBeInTheDocument();
    expect(within(region).queryByText(/--trial 'trial-first'/)).not.toBeInTheDocument();
  });

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

  it('shows trial model evidence and generation-scoped usage without calling it billing', async () => {
    const current = summary();
    const latest = current.runs[1]!;
    latest.trials = [trial({ variantId: 'better-motor', generation: generation() })];
    latest.tokensUsed = 1350;
    latest.generationUsage = { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: 1200, outputTokens: 150 };
    mount(overview({ universes: [current] }));
    const evidence = await screen.findByRole('region', { name: 'Model generation evidence' });
    expect(within(evidence).getByText('local-coder')).toBeInTheDocument();
    expect(within(evidence).getByText('Provider-reported')).toBeInTheDocument();
    expect(within(evidence).getByText('1,200')).toBeInTheDocument();
    expect(within(evidence).getByText('150')).toBeInTheDocument();
    expect(within(evidence).getByText('http://127.0.0.1:11434/v1')).toBeInTheDocument();
    expect(within(evidence).getByText('candidate.mjs')).toBeInTheDocument();
    expect(within(evidence).getByText(/Generation success means a valid replacement response, not evaluator acceptance/)).toBeInTheDocument();
    expect(screen.getByText('1 / 1 trials passed')).toBeInTheDocument();
    expect(screen.getByText('1 admitted')).toBeInTheDocument();
    const resources = screen.getByRole('contentinfo', { name: 'Generation resources' });
    expect(within(resources).getByText('Model tokens in generation 2')).toBeInTheDocument();
    expect(within(resources).getByText('1,350')).toBeInTheDocument();
    expect(within(resources).getByText(/1 \/ 1 recorded started requests reported tokens across 1 model trials/)).toBeInTheDocument();
    expect(within(resources).getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('does not turn missing generation usage or failed evaluation into a successful outcome', async () => {
    const current = summary();
    const latest = current.runs[1]!;
    latest.trials = [trial({ selected: false, status: 'failed', score: null, metrics: {}, generation: generation({
      usage: { state: 'unavailable', inputTokens: null, outputTokens: null },
    }) })];
    latest.generationUsage = { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 0, inputTokens: null, outputTokens: null };
    mount(overview({ universes: [current] }));
    await screen.findByRole('region', { name: 'Model generation evidence' });
    expect(screen.getByText('0 / 1 trials passed')).toBeInTheDocument();
    expect(screen.getByText('0 admitted')).toBeInTheDocument();
    expect(screen.getByText('Not admitted. The trial did not finish with a passing measurement.')).toBeInTheDocument();
    const resources = screen.getByRole('contentinfo', { name: 'Generation resources' });
    expect(within(resources).getAllByText('Unavailable')).toHaveLength(2);
    expect(within(resources).getByText(/0 \/ 1 recorded started requests reported tokens/)).toBeInTheDocument();
    expect(within(resources).queryByText('0')).not.toBeInTheDocument();
  });

  it('preserves reported zero and switches usage with the selected generation', async () => {
    const user = userEvent.setup();
    const current = summary();
    const latest = current.runs[1]!;
    latest.trials = [trial({ generation: generation({ usage: { state: 'reported', inputTokens: 0, outputTokens: 0 } }) })];
    latest.tokensUsed = 0;
    latest.generationUsage = { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: 0, outputTokens: 0 };
    mount(overview({ universes: [current] }));
    await screen.findByRole('region', { name: 'Model generation evidence' });
    const resources = screen.getByRole('contentinfo', { name: 'Generation resources' });
    expect(within(resources).getByText('0')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Generation' }), 'run-first');
    expect(within(resources).getByText('Model tokens in generation 1')).toBeInTheDocument();
    expect(within(resources).getAllByText('Unavailable')).toHaveLength(2);
    expect(within(resources).queryByText(/Generation usage coverage/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Model generation evidence' })).not.toBeInTheDocument();
  });

  it('distinguishes a cancelled request that never started from measured zero consumption', async () => {
    const current = summary();
    const latest = current.runs[1]!;
    latest.trials = [trial({ status: 'cancelled', selected: false, score: null, generation: generation({
      status: 'cancelled', requestStarted: false, changedFiles: [], promptDigest: null, responseDigest: null,
      usage: { state: 'unavailable', inputTokens: null, outputTokens: null },
    }) })];
    latest.generationUsage = { scope: 'model-generation', trials: 1, requestsStarted: 0, reportedRequests: 0, inputTokens: null, outputTokens: null };
    mount(overview({ universes: [current] }));
    const evidence = await screen.findByRole('region', { name: 'Model generation evidence' });
    expect(within(evidence).getByText('Not started')).toBeInTheDocument();
    expect(within(evidence).getByText('None')).toBeInTheDocument();
    const resources = screen.getByRole('contentinfo', { name: 'Generation resources' });
    expect(within(resources).getAllByText('Unavailable')).toHaveLength(2);
    expect(within(resources).getByText(/0 \/ 0 recorded started requests reported tokens/)).toBeInTheDocument();
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

  it('shows campaign budgets and links a recorded campaign step to its existing generation evidence', async () => {
    const user = userEvent.setup();
    mount(overview({ campaigns: [campaign({ state: 'completed', reason: 'generation-limit', finishedAt: '2026-09-06T12:01:00.000Z' })] }));
    const campaigns = await screen.findByRole('region', { name: 'Campaigns' });
    expect(within(campaigns).getByText('compiler-search')).toBeInTheDocument();
    expect(within(campaigns).getByText('generation-limit')).toBeInTheDocument();
    expect(within(campaigns).getByText('1 / 6')).toBeInTheDocument();
    expect(within(campaigns).getByText('1 / 12')).toBeInTheDocument();
    expect(within(campaigns).getByText('Strict improvements')).toBeInTheDocument();
    expect(within(campaigns).getByText(/Campaign termination is not project success/)).toBeInTheDocument();
    expect(within(campaigns).queryByText('ashlr universe campaign run compiler-search')).not.toBeInTheDocument();
    await user.click(within(campaigns).getByRole('button', { name: 'Inspect campaign generation 1' }));
    expect(screen.getByRole('region', { name: 'Evidence for small-motor' })).toBeInTheDocument();
  });

  it('continues polling an active campaign between generations without an active run', async () => {
    let tick: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      tick = handler as () => void;
      return 45 as unknown as ReturnType<typeof window.setInterval>;
    });
    const fetch = mount(overview({ campaigns: [campaign()] }));
    await screen.findByRole('heading', { name: 'Autonomous campaign' });
    expect(window.setInterval).toHaveBeenCalledWith(expect.any(Function), 3000);
    await act(async () => { tick?.(); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it.each(['pause-requested', 'stop-requested'] as const)('keeps %s distinct from acknowledged termination', async (state) => {
    const timer = vi.spyOn(window, 'setInterval').mockReturnValue(46 as unknown as ReturnType<typeof window.setInterval>);
    mount(overview({ campaigns: [campaign({ state, reason: 'owner-control-request' })] }));
    const campaigns = await screen.findByRole('region', { name: 'Campaigns' });
    expect(within(campaigns).getByText('Control requested. The owner has not yet acknowledged that work has stopped.')).toBeInTheDocument();
    expect(within(campaigns).getByText(state)).toBeInTheDocument();
    expect(timer).toHaveBeenCalled();
    expect(within(campaigns).queryByRole('button', { name: /pause|stop/i })).not.toBeInTheDocument();
  });

  it('stops campaign polling after a terminal update', async () => {
    const active = overview({ campaigns: [campaign()] });
    const stopped = overview({ campaigns: [campaign({ state: 'stopped', reason: 'owner-stop' })] });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(active))).mockResolvedValueOnce(new Response(JSON.stringify(stopped)));
    vi.stubGlobal('fetch', fetch);
    let tick: (() => void) | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      tick = handler as () => void;
      return 47 as unknown as ReturnType<typeof window.setInterval>;
    });
    const clear = vi.spyOn(window, 'clearInterval');
    render(<MemoryRouter><UniverseView /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Autonomous campaign' });
    await act(async () => { tick?.(); });
    await screen.findByText('owner-stop');
    expect(clear).toHaveBeenCalledWith(47);
  });

  it('keeps incomplete campaign spend separate from the recorded subtotal', async () => {
    const current = campaign({ state: 'interrupted', reason: 'owner-exited' });
    current.progress.usageComplete = false;
    current.progress.reportedTokens = null;
    current.progress.recordedTokens = 240;
    mount(overview({ campaigns: [current] }));
    const campaigns = await screen.findByRole('region', { name: 'Campaigns' });
    expect(within(campaigns).getByText('240')).toBeInTheDocument();
    expect(within(campaigns).getByText('Unavailable')).toBeInTheDocument();
    expect(within(campaigns).getByText(/recorded subtotal is not proof of complete spend/)).toBeInTheDocument();
    expect(within(campaigns).getByText(/ashlr universe campaign run compiler-search/)).toBeInTheDocument();
  });

  it('marks degraded campaign progress as unavailable rather than verified counters', async () => {
    mount(overview({ campaigns: [campaign({ sourceState: 'degraded', reasons: ['Invalid step reservation'] })] }));
    const campaigns = await screen.findByRole('region', { name: 'Campaigns' });
    expect(within(campaigns).getByText('Campaign history is incomplete.')).toBeInTheDocument();
    expect(within(campaigns).getByText('Invalid step reservation')).toBeInTheDocument();
    expect(within(campaigns).getByText('Unavailable / 6')).toBeInTheDocument();
    expect(within(campaigns).queryByText('1 / 6')).not.toBeInTheDocument();
  });

  it('shows only campaigns belonging to the selected universe', async () => {
    const other = campaign();
    other.definition = { ...other.definition, id: 'other-search', universeId: 'another-universe' };
    mount(overview({ campaigns: [other, campaign({ state: 'paused' })] }));
    const campaigns = await screen.findByRole('region', { name: 'Campaigns' });
    expect(within(campaigns).getByText('compiler-search')).toBeInTheDocument();
    expect(within(campaigns).queryByText('other-search')).not.toBeInTheDocument();
  });

  it('shows evaluator diagnostic codes without rendering messages or private locations, including raw details', async () => {
    const current = summary();
    current.runs[1]!.trials[0]!.diagnostics = [{ code: 'FORMAT_DATE_INVALID', message: 'private diagnostic marker', path: '/private/customer/location', line: 19 }];
    mount(overview({ universes: [current] }));
    const evidence = await screen.findByRole('region', { name: 'Evidence for better-motor' });
    expect(within(evidence).getByText('FORMAT_DATE_INVALID', { selector: 'code' })).toBeInTheDocument();
    expect(evidence.textContent).not.toContain('private diagnostic marker');
    expect(evidence.textContent).not.toContain('/private/customer/location');
  });

  it('distinguishes feedback from a failed attempt from the retained candidate parent', async () => {
    const current = summary();
    current.runs[1]!.trials[0]!.generation = generation({ feedback: {
      runId: 'run-first', trialId: 'previous-failed-attempt', generation: 1,
      comparatorDigest: 'c'.repeat(64), artifactDigest: 'd'.repeat(64), digest: 'e'.repeat(64),
    } });
    mount(overview({ universes: [current] }));
    const evidence = await screen.findByRole('region', { name: 'Model generation evidence' });
    expect(within(evidence).getByText('Generation 1 · trial previous-failed-attempt')).toBeInTheDocument();
    expect(within(evidence).getByText('Feedback can come from a failed attempt. It is distinct from the retained parent shown in the lineage.')).toBeInTheDocument();
    expect(screen.getByText('Current niche elite')).toBeInTheDocument();
  });
});

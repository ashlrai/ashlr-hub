import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseGenerationReceipt, UniverseOverview, UniverseTrial } from '../../../core/universe/types.js';
import { serializeUniverseConsoleOverview } from '../../../core/web/universe-console-public.js';
import { GenerationEvidence } from './UniverseView.js';

function generation(): UniverseGenerationReceipt {
  return { schemaVersion: 1, provider: 'resource-pool', endpoint: null, model: null, status: 'failed', requestStarted: false,
    promptDigest: 'a'.repeat(64), responseDigest: null, durationMs: 10, changedFiles: [],
    usage: { state: 'unavailable', inputTokens: null, outputTokens: null },
    resource: { schemaVersion: 1, poolId: 'fixture-pool', poolDigest: 'b'.repeat(64), allowedWorkerIds: ['worker-a'],
      taskId: 'resource-task', taskDigest: 'c'.repeat(64), workerId: 'worker-a', workerProvider: 'claude',
      workerModel: 'configured-model', receiptDigest: 'd'.repeat(64), dispatch: 'settled', taskStatus: 'completed', usageScope: null } };
}
function trial(receipt = generation()): UniverseTrial {
  return { id: 'trial-a', variantId: 'pooled', niche: 'one', parentTrialId: null, status: 'failed', score: null,
    metrics: {}, artifact: null, durationMs: 12, delta: null, selected: false, generation: receipt };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Universe recorded resource task evidence', () => {
  it('shows resource completion separately from candidate validity, acceptance and current worker state', () => {
    render(<GenerationEvidence trial={trial()} />);
    const region = within(screen.getByRole('region', { name: 'Recorded resource task evidence' }));
    expect(region.getByText('Receipt settled')).toBeVisible();
    expect(region.getByText('Recorded task outcome').parentElement).toHaveTextContent('completed');
    expect(region.getByText('Worker').parentElement).toHaveTextContent('worker-a');
    expect(region.getByText('Task').parentElement).toHaveTextContent('resource-task');
    expect(region.getByText(/not a current worker heartbeat/)).toBeVisible();
    expect(region.getByText(/Task completion does not mean the candidate response validated/)).toBeVisible();
    expect(screen.getByText('failed')).toBeVisible();
    expect(screen.queryByText('Endpoint')).not.toBeInTheDocument();
    expect(screen.getByText('Provider request count').parentElement).toHaveTextContent('Unknown');
    expect(screen.getByText('Input tokens').parentElement).toHaveTextContent('Unavailable');
    expect(screen.getByText('Worker usage scope').parentElement).toHaveTextContent('Unavailable');
    expect(screen.queryByRole('button')).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['not-started', 'withheld', 'unavailable'] as const)('leaves missing assignment and tokens unknown for %s', (dispatch) => {
    const value = generation(); Object.assign(value.resource!, { dispatch, taskStatus: null, workerId: null,
      workerProvider: null, workerModel: null, taskId: dispatch === 'not-started' ? null : 'resource-task', taskDigest: null, receiptDigest: null, usageScope: null });
    render(<GenerationEvidence trial={trial(value)} />);
    expect(screen.getByText('Model').parentElement).toHaveTextContent('Not assigned');
    expect(screen.getByText('Worker').parentElement).toHaveTextContent('Not assigned');
    expect(screen.getByText('Input tokens').parentElement).toHaveTextContent('Unavailable');
    expect(screen.getByText('Resource receipt digest').parentElement).toHaveTextContent('Unavailable');
    expect(screen.queryByText('Endpoint')).not.toBeInTheDocument();
  });
  it.each(['reserved', 'uncertain'] as const)('keeps %s resource occupancy explicit despite a failed generation', (taskStatus) => {
    const value = generation(); value.resource!.taskStatus = taskStatus;
    if (taskStatus === 'reserved') value.resource!.dispatch = 'replayed';
    render(<GenerationEvidence trial={trial(value)} />);
    expect(screen.getByText(/still occupies capacity/)).toBeVisible();
    expect(screen.getByText(/this view does not release its slot/)).toBeVisible();
  });
  it('shows replay without implying redispatch or new measured spend', () => {
    const value = generation(); value.resource!.dispatch = 'replayed';
    render(<GenerationEvidence trial={trial(value)} />);
    expect(screen.getByText('Recorded task replayed; no redispatch')).toBeVisible();
    expect(screen.getByText('Input tokens').parentElement).toHaveTextContent('Unavailable');
    expect(screen.getByText('Provider request count').parentElement).toHaveTextContent('Unknown');
  });
  it('preserves a reported zero for a settled handoff with its worker usage scope', () => {
    const value = generation(); value.usage = { state: 'reported', inputTokens: 0, outputTokens: 0 };
    value.resource!.usageScope = 'claude-main-loop';
    render(<GenerationEvidence trial={trial(value)} />);
    expect(screen.getByText('Input tokens').parentElement).toHaveTextContent('0');
    expect(screen.getByText('Output tokens').parentElement).toHaveTextContent('0');
    expect(screen.getByText('Worker usage scope').parentElement).toHaveTextContent('Claude main loop only');
    expect(screen.getByText('Provider request count').parentElement).toHaveTextContent('Unknown');
  });
  it('does not render private runtime fields or an unrecognized dispatch/usage scope', () => {
    const value = generation(); Object.assign(value.resource!, { runtimePath: '/private/PRIVATE_RUNTIME',
      command: '/private/PRIVATE_COMMAND', dispatch: '__proto__', usageScope: 'PRIVATE_SCOPE' });
    const { container } = render(<GenerationEvidence trial={trial(value)} />);
    expect(screen.getByText('Dispatch evidence').parentElement).toHaveTextContent('Unavailable');
    expect(container.innerHTML).not.toMatch(/PRIVATE_|__proto__|\/private\//);
  });
  it('renders the serialized public overview with a usable task reference and visibly redacted digests', async () => {
    const value = generation(); const taskId = `u-${'c'.repeat(30)}-${'d'.repeat(30)}`; value.resource!.taskId = taskId;
    const overview: UniverseOverview = { schemaVersion: 1, sampledAt: '2026-09-07T12:00:00.000Z',
      sourceState: 'healthy', reasons: [], measurementScope: 'local-experiment', universes: [{
        manifest: { schemaVersion: 1, id: 'fixture', name: 'Fixture', objective: 'Improve the fixture',
          seed: { repo: '/private/fixture-seed', revision: 'a'.repeat(40) }, metric: { name: 'score', direction: 'maximize', minImprovement: 1 },
          budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 500, maxParallel: 1 }, evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 500 },
          variants: [{ id: 'pooled', niche: 'one', hypothesis: 'Improve', generation: { kind: 'resource-pool',
            poolId: 'fixture-pool', poolDigest: 'b'.repeat(64), allowedWorkerIds: ['worker-a'], files: ['candidate.mjs'], maxOutputTokens: 32 } }] },
        manifestDigest: 'e'.repeat(64), comparatorDigest: 'f'.repeat(64), elites: [], activeRun: null,
        sourceState: 'healthy', reasons: [], runs: [{ id: 'run', universeId: 'fixture', generation: 1,
          manifestDigest: 'e'.repeat(64), comparatorDigest: 'f'.repeat(64), startedAt: '2026-09-07T12:00:00.000Z',
          finishedAt: '2026-09-07T12:00:01.000Z', status: 'completed', trials: [trial(value)], durationMs: 1000,
          tokensUsed: null, costUsd: null }],
      }] };
    const serialized: UniverseOverview = JSON.parse(serializeUniverseConsoleOverview(overview));
    render(<GenerationEvidence trial={serialized.universes[0]!.runs[0]!.trials[0]!} />);
    await userEvent.click(screen.getByText('Generation source and changes'));
    expect(screen.getByText('Task').parentElement).toHaveTextContent(taskId);
    expect(screen.getByText('Resource receipt digest').parentElement).toHaveTextContent('[REDACTED]');
    expect(screen.getByText(/Some digests are redacted in the web view/)).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the direct local generation presentation without a resource panel', () => {
    const local: UniverseGenerationReceipt = { schemaVersion: 1, provider: 'local-openai-compatible',
      endpoint: 'http://127.0.0.1:11434/v1', model: 'local-fixture', status: 'succeeded', requestStarted: true,
      promptDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64), durationMs: 10, changedFiles: ['candidate.mjs'],
      usage: { state: 'reported', inputTokens: 2, outputTokens: 1 } };
    render(<GenerationEvidence trial={trial(local)} />);
    expect(screen.getByText('Endpoint').parentElement).toHaveTextContent(local.endpoint!);
    expect(screen.getByText('Request').parentElement).toHaveTextContent('Started');
    expect(screen.queryByRole('region', { name: 'Recorded resource task evidence' })).not.toBeInTheDocument();
  });
});

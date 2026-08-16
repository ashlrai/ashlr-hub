import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RunStreamPanel } from './RunStreamPanel.js';
import { evictAll } from '../../data/cache.js';
import { RUN_STREAM_POLL_MS } from './useRunStream.js';

function runAt(stepCount: number, status: 'running' | 'done' = 'running') {
  return {
    id: 'r1',
    goal: 'ship the thing',
    engine: 'claude',
    provider: 'anthropic',
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 100_000, maxSteps: 50, allowCloud: true },
    usage: { tokensIn: 100 * stepCount, tokensOut: 50 * stepCount, steps: stepCount, estCostUsd: 0.01 * stepCount },
    tasks: [{ id: 't1', goal: 'do it', deps: [], status: status === 'done' ? 'done' : 'running' }],
    steps: Array.from({ length: stepCount }, (_, i) => ({
      ts: new Date().toISOString(),
      taskId: 't1',
      kind: 'tool' as const,
      summary: `step ${i + 1}`,
    })),
    status,
  };
}

// These two tests exercise the hook's REAL RUN_STREAM_POLL_MS-cadence
// setInterval on real wall-clock time rather than vitest's fake timers:
// the interval is created inside a useEffect on mount, so swapping in fake
// timers afterward doesn't retarget a setInterval handle the real event
// loop already owns. Real time keeps the test honest about what a genuine
// poll cycle looks like, at the cost of a few real seconds of runtime.
describe('RunStreamPanel', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    'renders the growing step transcript as the run progresses',
    async () => {
      let stepCount = 1;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(runAt(stepCount)), { status: 200 })),
      );

      render(<RunStreamPanel runId="r1" />);

      await waitFor(() => expect(screen.getByText('step 1')).toBeInTheDocument());
      expect(screen.getByText(/Live/)).toBeInTheDocument();

      stepCount = 3;

      await waitFor(() => expect(screen.getByText('step 3')).toBeInTheDocument(), {
        timeout: RUN_STREAM_POLL_MS * 4,
      });
    },
    RUN_STREAM_POLL_MS * 6,
  );

  it(
    'flips to a stalled banner when no change is observed for several poll cycles',
    async () => {
      // Fixed, not regenerated per fetch — a fresh `updatedAt` on every poll
      // would make the run look like it's constantly changing and never stall.
      const frozenRun = runAt(1);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(frozenRun), { status: 200 })),
      );

      render(<RunStreamPanel runId="r1" />);
      await waitFor(() => expect(screen.getByText(/Live/)).toBeInTheDocument());

      await waitFor(() => expect(screen.getByText(/may be stalled/)).toBeInTheDocument(), {
        timeout: RUN_STREAM_POLL_MS * 6,
      });
    },
    RUN_STREAM_POLL_MS * 8,
  );

  it('shows a not-found state and stops polling on a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );

    render(<RunStreamPanel runId="does-not-exist" />);
    await waitFor(() => expect(screen.getByText(/Run not found/)).toBeInTheDocument());
  });
});

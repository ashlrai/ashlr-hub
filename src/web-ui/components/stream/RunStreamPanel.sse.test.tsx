/**
 * DOM tests for the SSE-driven half of live run streaming: RunStreamPanel
 * consuming useRunStream -> useRunStreamEvents against a mocked
 * `EventSource` (jsdom has none). Complements RunStreamPanel.test.tsx, which
 * covers the polling fallback (exercised there for free, since jsdom's lack
 * of a real EventSource already forces that path).
 *
 * Covers:
 *   - append: a pushed step-done frame (plus the refetch it triggers)
 *     renders new step text without a poll tick.
 *   - pin/follow: scrolling away from the bottom shows a "Follow" button;
 *     clicking it re-pins and hides the button again.
 *   - stall banner: a server-pushed `stall` event flips the phase banner to
 *     the stalled state, driven by the server's own age, not a client guess.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { RunStreamPanel } from './RunStreamPanel.js';
import { evictAll } from '../../data/cache.js';

// ---------------------------------------------------------------------------
// Minimal EventSource mock — jsdom ships none.
// ---------------------------------------------------------------------------

type Listener = (evt: { data: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();
  closed = false;

  constructor(url: string, _init?: unknown) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emit(type: string, data: unknown): void {
    const evt = { data: JSON.stringify(data) };
    for (const cb of this.listeners.get(type) ?? []) cb(evt);
  }

  static latest(): MockEventSource {
    const inst = MockEventSource.instances.at(-1);
    if (!inst) throw new Error('no MockEventSource constructed yet');
    return inst;
  }
}

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

describe('RunStreamPanel (SSE transport)', () => {
  beforeEach(() => {
    evictAll();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends a new step to the transcript when a push frame arrives, without a poll tick', async () => {
    let stepCount = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runAt(stepCount)), { status: 200 })),
    );

    render(<RunStreamPanel runId="r1" />);
    await waitFor(() => expect(screen.getByText('step 1')).toBeInTheDocument());

    const source = MockEventSource.latest();
    act(() => source.emitOpen());
    await waitFor(() => expect(screen.getByText(/streaming/i)).toBeInTheDocument());

    // Server-side state advances; the push frame is what should trigger the
    // refetch that picks it up (not the 2s poll timer, which this test
    // never waits long enough for).
    stepCount = 2;
    act(() => source.emit('step-done', { taskId: 't1', kind: 'tool', index: 1, ts: new Date().toISOString(), usage: null }));

    await waitFor(() => expect(screen.getByText('step 2')).toBeInTheDocument(), { timeout: 1000 });
  });

  it('shows a Follow button after scrolling away from the bottom, and re-pins on click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runAt(5)), { status: 200 })),
    );

    render(<RunStreamPanel runId="r1" />);
    await waitFor(() => expect(screen.getByText('step 5')).toBeInTheDocument());

    const log = screen.getByRole('log', { name: /run step transcript/i });
    // jsdom has no real layout — force the scroll geometry a "scrolled up"
    // reader would have, then fire the scroll handler the component wires up.
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(log, 'scrollTop', { value: 0, configurable: true, writable: true });
    fireEvent.scroll(log);

    const followButton = await screen.findByRole('button', { name: /follow/i });
    expect(followButton).toBeInTheDocument();

    fireEvent.click(followButton);
    await waitFor(() => expect(screen.queryByRole('button', { name: /follow/i })).not.toBeInTheDocument());
  });

  it('flips to the stalled banner on a server-pushed stall event, showing the server age', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(runAt(1)), { status: 200 })),
    );

    render(<RunStreamPanel runId="r1" />);
    await waitFor(() => expect(screen.getByText('step 1')).toBeInTheDocument());

    const source = MockEventSource.latest();
    act(() => source.emitOpen());
    await waitFor(() => expect(screen.getByText(/streaming/i)).toBeInTheDocument());

    act(() => source.emit('stall', { ageMs: 9_000 }));

    await waitFor(() => expect(screen.getByText(/may be stalled/)).toBeInTheDocument());
    expect(screen.getByText(/in 9s/)).toBeInTheDocument();
    expect(screen.getByText(/still watching/i)).toBeInTheDocument();
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES } from '../src/core/web/universe-console-public.js';

const fixture = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn(), overview: vi.fn(), graph: vi.fn() }));
vi.mock('node:worker_threads', async (original) => ({ ...await original<typeof import('node:worker_threads')>(),
  parentPort: { on: fixture.on, postMessage: fixture.postMessage }, workerData: { root: '/private/tmp/console-worker-unit-scope' } }));
vi.mock('../src/core/universe/overview.js', () => ({ readUniverseOverview: fixture.overview }));
vi.mock('../src/core/universe/graph-reader.js', () => ({ readUniverseGraph: fixture.graph }));
let dispatch: (request: unknown) => void;
beforeAll(async () => {
  await import('../src/core/web/universe-console-worker.js');
  expect(fixture.on.mock.calls[0]![0]).toBe('message'); dispatch = fixture.on.mock.calls[0]![1];
});
beforeEach(() => {
  fixture.postMessage.mockClear(); fixture.overview.mockReset(); fixture.graph.mockReset();
});

describe('dedicated scoped console worker protocol', () => {
  it('posts only public serialized overview JSON, never the raw evidence object', () => {
    const raw = { schemaVersion: 1, universes: [{ runs: [{ trials: [{ diagnostics: [
      { code: 'failed', message: 'never leave worker' }],
    }] }], activeRun: null }] };
    fixture.overview.mockReturnValue(raw); dispatch({ type: 'read', id: 1, kind: 'overview' });
    expect(fixture.overview).toHaveBeenCalledWith({ root: '/private/tmp/console-worker-unit-scope' });
    const reply = fixture.postMessage.mock.calls[0]![0];
    expect(reply).toMatchObject({ type: 'result', id: 1, ok: true }); expect(typeof reply.value).toBe('string');
    expect(reply.value).not.toContain('never leave worker'); expect(reply.value).toContain('[omitted from web view]');
    expect(raw.universes[0]!.runs[0]!.trials[0]!.diagnostics[0]!.message).toBe('never leave worker');
  });

  it('pins graph reads to worker scope and serializes their result', () => {
    fixture.graph.mockReturnValue({ schemaVersion: 1, sourceState: 'missing' });
    dispatch({ type: 'read', id: 2, kind: 'graph', payload: { universeId: 'one' } });
    expect(fixture.graph).toHaveBeenCalledWith('one', { root: '/private/tmp/console-worker-unit-scope' });
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: 'result', id: 2, ok: true,
      value: '{"schemaVersion":1,"sourceState":"missing"}' });
  });

  it('reports unavailable without any partial value when UTF-8 serialized output exceeds budget', () => {
    fixture.overview.mockReturnValue({ schemaVersion: 1, universes: [], reasons: [
      'é'.repeat(MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES / 2),
    ] });
    dispatch({ type: 'read', id: 3, kind: 'overview' });
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 3, ok: false });
  });

  it('withholds private error details when a read fails', () => {
    fixture.overview.mockImplementation(() => { throw new Error('private filepath and diagnostic'); });
    dispatch({ type: 'read', id: 4, kind: 'overview' });
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 4, ok: false });
  });

  it('rejects request-selected roots and unknown fields before reading evidence', () => {
    dispatch({ type: 'read', id: 5, kind: 'graph', payload: { universeId: 'one', root: '/other' } });
    dispatch({ type: 'read', id: 6, kind: 'overview', root: '/other' });
    expect(fixture.graph).not.toHaveBeenCalled(); expect(fixture.overview).not.toHaveBeenCalled();
    expect(fixture.postMessage.mock.calls.map(([value]) => value)).toEqual([
      { type: 'result', id: 5, ok: false }, { type: 'result', id: 6, ok: false },
    ]);
  });
});

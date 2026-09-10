import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES } from '../src/core/web/universe-console-public.js';

const fixture = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn(), overview: vi.fn(), graph: vi.fn(), readiness: vi.fn(), controller: vi.fn() }));
vi.mock('node:worker_threads', async (original) => ({ ...await original<typeof import('node:worker_threads')>(),
  parentPort: { on: fixture.on, postMessage: fixture.postMessage }, workerData: { root: '/private/tmp/console-worker-unit-scope' } }));
vi.mock('../src/core/universe/overview.js', () => ({ readUniverseOverview: fixture.overview }));
vi.mock('../src/core/universe/graph-reader.js', () => ({ readUniverseGraph: fixture.graph }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: fixture.readiness }));
vi.mock('../src/core/universe/portfolio-controller.js', () => ({ readUniversePortfolioController: fixture.controller }));
let dispatch: (request: unknown) => void;
beforeAll(async () => {
  await import('../src/core/web/universe-console-worker.js');
  expect(fixture.on.mock.calls[0]![0]).toBe('message'); dispatch = fixture.on.mock.calls[0]![1];
});
beforeEach(() => {
  fixture.postMessage.mockClear(); fixture.overview.mockReset(); fixture.graph.mockReset(); fixture.readiness.mockReset();
  fixture.controller.mockReset();
});

describe('dedicated scoped console worker protocol', () => {
  it('pins the controller read to its worker root and posts only allowlisted observations', () => {
    fixture.controller.mockReturnValue({ schemaVersion: 1, controllerId: 'one', sourceState: 'healthy', status: 'draining',
      createdAt: null, deadlineAt: null, observedAt: '2026-09-09T00:00:00Z', reasons: [],
      definitionDigest: 'private-witness', futurePrivateField: 'private-witness',
      outcomes: [{ campaignId: 'a', state: 'in-flight', attempted: true, reasonCode: 'dispatch-in-flight',
        campaignDigest: 'private-witness', deliveryDigest: 'private-witness', extra: 'private-witness' }],
      control: { mode: 'drain', sequence: 4, requestedAt: '2026-09-09T00:00:00Z', acknowledgedAt: null, extra: 'private-witness' } });
    dispatch({ type: 'read', id: 20, kind: 'controller-status', payload: { controllerId: 'one' } });
    expect(fixture.controller).toHaveBeenCalledExactlyOnceWith('one', { root: '/private/tmp/console-worker-unit-scope' });
    const result = fixture.postMessage.mock.calls[0]![0];
    expect(result).toMatchObject({ type: 'result', id: 20, ok: true });
    expect(JSON.parse(result.value)).toMatchObject({ controllerId: 'one', status: 'draining', control: { acknowledgedAt: null } });
    expect(result.value).not.toContain('private-witness'); expect(result.value).not.toContain('Digest');
    expect(fixture.overview).not.toHaveBeenCalled(); expect(fixture.readiness).not.toHaveBeenCalled();
  });

  it.each([{}, undefined, { controllerId: '../one' }, { controllerId: 'one', root: '/other' },
    { controllerId: 'one', campaignId: 'one' }, { controllerId: ['one'] }, { controllerId: 'x'.repeat(65) }])(
    'rejects malformed controller selection before reading %#', (payload) => {
      dispatch({ type: 'read', id: 21, kind: 'controller-status', payload });
      expect(fixture.controller).not.toHaveBeenCalled();
      expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 21, ok: false });
    });

  it('withholds raw controller read errors', () => {
    fixture.controller.mockImplementation(() => { throw new Error('/private/controller-secret'); });
    dispatch({ type: 'read', id: 22, kind: 'controller-status', payload: { controllerId: 'one' } });
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 22, ok: false });
  });
  it('pins campaign readiness to its worker root and strips private witnesses before posting', () => {
    fixture.readiness.mockReturnValue({ schemaVersion: 1, campaignId: 'one', universeId: 'u-one',
      sourceState: 'healthy', disposition: 'startable', automaticAction: 'run',
      expectedIdentity: { private: 'worker-only' }, recordsDigest: 'worker-only', extra: 'worker-only' });
    dispatch({ type: 'read', id: 10, kind: 'campaign-readiness', payload: { campaignId: 'one' } });
    expect(fixture.readiness).toHaveBeenCalledExactlyOnceWith('one', { root: '/private/tmp/console-worker-unit-scope' });
    const result = fixture.postMessage.mock.calls[0]![0];
    expect(result).toMatchObject({ type: 'result', id: 10, ok: true });
    expect(JSON.parse(result.value)).toMatchObject({ campaignId: 'one', universeId: 'u-one' });
    expect(result.value).not.toContain('worker-only'); expect(result.value).not.toContain('automaticAction');
    expect(fixture.overview).not.toHaveBeenCalled(); expect(fixture.graph).not.toHaveBeenCalled();
  });

  it.each([{}, { campaignId: '../one' }, { campaignId: 'one', root: '/other' },
    { campaignId: 'one', universeId: 'other' }, { campaignId: ['one'] }, { campaignId: 'x'.repeat(65) }])(
    'rejects malformed readiness selection before evidence access %#', (payload) => {
      dispatch({ type: 'read', id: 11, kind: 'campaign-readiness', payload });
      expect(fixture.readiness).not.toHaveBeenCalled();
      expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 11, ok: false });
    });

  it('withholds readiness failure details without turning them into a healthy result', () => {
    fixture.readiness.mockImplementation(() => { throw new Error('/private/readiness-secret'); });
    dispatch({ type: 'read', id: 12, kind: 'campaign-readiness', payload: { campaignId: 'one' } });
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 12, ok: false });
  });

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

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn(), root: vi.fn(), readiness: vi.fn(), other: vi.fn(), case: vi.fn(), credits: vi.fn() }));
vi.mock('node:worker_threads', async (original) => ({ ...await original<typeof import('node:worker_threads')>(),
  parentPort: { on: fixture.on, postMessage: fixture.postMessage }, workerData: { cfg: { roots: ['/not-a-universe-root'] } } }));
vi.mock('../src/core/universe/artifacts.js', () => ({ defaultUniverseRoot: fixture.root }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: fixture.readiness }));
vi.mock('../src/core/dashboard.js', () => ({ buildSnapshot: fixture.other }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: fixture.other }));
vi.mock('../src/core/inbox/store.js', () => ({ listProposals: fixture.other }));
vi.mock('../src/core/run/orchestrator.js', () => ({ listRuns: fixture.other }));
vi.mock('../src/core/swarm/store.js', () => ({ listSwarms: fixture.other }));
vi.mock('../src/core/fleet/status.js', () => ({ readFleetDaemonStatus: fixture.other }));
vi.mock('../src/core/daemon/public-observation.js', () => ({ readPublicDaemonObservation: fixture.other }));
vi.mock('../src/core/web/control.js', () => ({ buildControlSnapshot: fixture.other, buildFleetActivity: fixture.other }));
vi.mock('../src/core/web/fleet-status-cache.js', () => ({ getCachedFleetStatus: fixture.other }));

vi.mock('../src/core/resources/credit-pool-projection.js', () => ({ readCreditPoolsProjection: fixture.credits }));
vi.mock('../src/core/fleet/execution-feedback-case.js', () => ({ readExecutionFeedbackCase: fixture.case }));

let dispatch: (request: unknown) => void;
beforeAll(async () => {
  await import('../src/core/web/read-projection-worker.js');
  dispatch = fixture.on.mock.calls[0]![1];
});
beforeEach(() => {
  fixture.postMessage.mockClear(); fixture.root.mockReset(); fixture.readiness.mockReset(); fixture.other.mockReset(); fixture.case.mockReset(); fixture.credits.mockReset();
  fixture.root.mockReturnValue('/private/tmp/general-worker-universe');
});
async function settle(): Promise<void> { for (let i = 0; i < 4; i++) await Promise.resolve(); }

describe('general worker recorded campaign readiness boundary', () => {
  it('resolves only the fixed worker-side default root and posts exactly the public observation', async () => {
    const publicView = { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: 'one',
      universeId: 'u-one', observedState: 'ready', sourceState: 'healthy', disposition: 'startable',
      reasonCode: 'never-started', resourceRuntimeRequired: false, sampledAt: '2026-09-08T00:00:00Z' };
    fixture.readiness.mockReturnValue({ ...publicView, automaticAction: 'run', recordsDigest: 'private-witness',
      expectedIdentity: { path: '/private/not-public' }, futurePrivate: 'do-not-send' });
    dispatch({ type: 'read', id: 1, kind: 'universe-campaign-readiness', payload: { campaignId: 'one' } });
    await settle();
    expect(fixture.root).toHaveBeenCalledExactlyOnceWith();
    expect(fixture.readiness).toHaveBeenCalledExactlyOnceWith('one', { root: '/private/tmp/general-worker-universe' });
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 1, ok: true, value: publicView });
    expect(fixture.other).not.toHaveBeenCalled();
  });

  it.each([{ campaignId: 'one', root: '/other' }, { campaignId: '../one' },
    { campaignId: 'one', universeId: 'two' }, { campaignId: ['one'] }, {}])(
    'rejects invalid readiness input before resolving or reading any root %#', async (payload) => {
      dispatch({ type: 'read', id: 2, kind: 'universe-campaign-readiness', payload }); await settle();
      expect(fixture.root).not.toHaveBeenCalled(); expect(fixture.readiness).not.toHaveBeenCalled();
      expect(fixture.other).not.toHaveBeenCalled();
      expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 2, ok: false, error: 'Read projection unavailable' });
    });

  it('withholds private core errors without invoking another projection', async () => {
    fixture.readiness.mockImplementation(() => { throw new Error('/private/readiness-failure'); });
    dispatch({ type: 'read', id: 3, kind: 'universe-campaign-readiness', payload: { campaignId: 'one' } }); await settle();
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 3, ok: false, error: 'Read projection unavailable' });
    expect(fixture.other).not.toHaveBeenCalled();
  });
});

describe('fixed execution case worker boundary', () => {
  it('passes only the canonical case ID to the fixed reader and preserves its projection', async () => {
    const view = { schemaVersion: 1, shipping: 'not-recorded' };
    fixture.case.mockResolvedValue(view);
    dispatch({ type: 'read', id: 20, kind: 'execution-feedback-case', payload: { caseId: 'a'.repeat(64) } });
    await vi.waitFor(() => expect(fixture.postMessage).toHaveBeenCalled());
    expect(fixture.case).toHaveBeenCalledExactlyOnceWith('a'.repeat(64));
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 20, ok: true, value: view });
    expect(fixture.other).not.toHaveBeenCalled();
  });
  it('refuses extra paths before any source lookup and withholds source error text', async () => {
    dispatch({ type: 'read', id: 21, kind: 'execution-feedback-case', payload: { caseId: 'a'.repeat(64), path: '/private' } });
    await settle(); expect(fixture.case).not.toHaveBeenCalled();
    expect(fixture.postMessage).toHaveBeenCalledWith({ type: 'result', id: 21, ok: false, error: 'Read projection unavailable' });
    fixture.postMessage.mockClear(); fixture.case.mockRejectedValue(new Error('secret account path'));
    dispatch({ type: 'read', id: 22, kind: 'execution-feedback-case', payload: { caseId: 'a'.repeat(64) } });
    await vi.waitFor(() => expect(fixture.postMessage).toHaveBeenCalled());
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 22, ok: false, error: 'Read projection unavailable' });
  });
});

describe('fixed credit worker boundary', () => {
  it('uses only server configuration and typed metadata for its fixed reader', async () => {
    const view = { v: 1, sourceState: 'missing', rows: [] };
    fixture.credits.mockReturnValue(view);
    dispatch({ type: 'read', id: 30, kind: 'credit-pools', payload: { identitySnapshots: [], invalidatedAccountIds: [] } });
    await vi.waitFor(() => expect(fixture.postMessage).toHaveBeenCalled());
    expect(fixture.credits).toHaveBeenCalledExactlyOnceWith({ roots: ['/not-a-universe-root'] }, [], []);
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 30, ok: true, value: view });
  });
  it('rejects caller roots before any credit file read', async () => {
    dispatch({ type: 'read', id: 31, kind: 'credit-pools', payload: { identitySnapshots: [], invalidatedAccountIds: [], root: '/caller' } }); await settle();
    expect(fixture.credits).not.toHaveBeenCalled();
    expect(fixture.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', id: 31, ok: false, error: 'Read projection unavailable' });
  });
});

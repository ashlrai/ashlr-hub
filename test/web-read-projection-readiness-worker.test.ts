import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn(), root: vi.fn(), readiness: vi.fn(), other: vi.fn() }));
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

let dispatch: (request: unknown) => void;
beforeAll(async () => {
  await import('../src/core/web/read-projection-worker.js');
  dispatch = fixture.on.mock.calls[0]![1];
});
beforeEach(() => {
  fixture.postMessage.mockClear(); fixture.root.mockReset(); fixture.readiness.mockReset(); fixture.other.mockReset();
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

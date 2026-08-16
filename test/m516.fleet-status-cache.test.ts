/**
 * m516.fleet-status-cache.test.ts — shared cache for buildFleetStatus
 * (src/core/web/fleet-status-cache.ts).
 *
 * Perf fix context: the operator console's /api/snapshot and /api/control
 * went from ~2.4s idle to 69-79s under concurrent load. Root cause:
 * buildFleetStatus (a large multi-source aggregator) was called with ZERO
 * caching from up to seven independent sites (dashboard.ts, control.ts x2,
 * api.ts x4), so concurrent requests each triggered their own full
 * recompute. This suite verifies the cache actually collapses concurrent
 * calls into one computation, serves warm/stale values correctly, and never
 * silently presents old data as current (every result reports `stale` +
 * `ageMs`).
 *
 * buildFleetStatus itself is mocked — this suite is about the CACHE's
 * behavior (dedup, TTL, staleness reporting, priming), not about
 * buildFleetStatus's own aggregation logic (covered by m49.fleet-status).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { FleetStatus } from '../src/core/fleet/status.js';

const buildFleetStatusMock = vi.fn<(cfg: AshlrConfig) => Promise<FleetStatus>>();

vi.mock('../src/core/fleet/status.js', () => ({
  buildFleetStatus: (cfg: AshlrConfig) => buildFleetStatusMock(cfg),
}));

function fleetStatusFixture(tag: string): FleetStatus {
  return { generatedAt: tag, killed: false } as unknown as FleetStatus;
}

function stubCfg(): AshlrConfig {
  return { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] as string[] }, telemetry: {}, tools: {} } as unknown as AshlrConfig;
}

describe('fleet-status-cache', () => {
  beforeEach(() => {
    vi.resetModules();
    buildFleetStatusMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cold call awaits a real computation (nothing honest to serve yet)', async () => {
    const { getCachedFleetStatus } = await import('../src/core/web/fleet-status-cache.js');
    buildFleetStatusMock.mockResolvedValue(fleetStatusFixture('v1'));
    const cfg = stubCfg();

    const result = await getCachedFleetStatus(cfg);

    expect(buildFleetStatusMock).toHaveBeenCalledTimes(1);
    expect(result.stale).toBe(false);
    expect(result.ageMs).toBe(0);
    expect(result.status.generatedAt).toBe('v1');
  });

  it('dedupes concurrent cold calls into exactly one underlying computation', async () => {
    const { getCachedFleetStatus } = await import('../src/core/web/fleet-status-cache.js');
    let resolveFn!: (value: FleetStatus) => void;
    buildFleetStatusMock.mockReturnValue(new Promise((resolve) => { resolveFn = resolve; }));
    const cfg = stubCfg();

    // Fire five concurrent callers before the single computation resolves —
    // this is the exact "thundering herd" shape that caused the 69s/79s
    // latency: many callers hitting an uncached buildFleetStatus at once.
    const calls = [
      getCachedFleetStatus(cfg),
      getCachedFleetStatus(cfg),
      getCachedFleetStatus(cfg),
      getCachedFleetStatus(cfg),
      getCachedFleetStatus(cfg),
    ];
    expect(buildFleetStatusMock).toHaveBeenCalledTimes(1);

    resolveFn(fleetStatusFixture('v1'));
    const results = await Promise.all(calls);

    expect(buildFleetStatusMock).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status.generatedAt).toBe('v1');
      expect(r.stale).toBe(false);
    }
  });

  it('serves a warm cached value without recomputing (within TTL)', async () => {
    const { getCachedFleetStatus } = await import('../src/core/web/fleet-status-cache.js');
    buildFleetStatusMock.mockResolvedValue(fleetStatusFixture('v1'));
    const cfg = stubCfg();

    await getCachedFleetStatus(cfg);
    vi.advanceTimersByTime(2_000); // < 5s TTL
    const warm = await getCachedFleetStatus(cfg);

    expect(buildFleetStatusMock).toHaveBeenCalledTimes(1);
    expect(warm.stale).toBe(false);
    expect(warm.ageMs).toBeGreaterThanOrEqual(2_000);
    expect(warm.status.generatedAt).toBe('v1');
  });

  it('serves the last good value immediately (stale: true) after the TTL, and refreshes in the background', async () => {
    const { getCachedFleetStatus } = await import('../src/core/web/fleet-status-cache.js');
    buildFleetStatusMock.mockResolvedValueOnce(fleetStatusFixture('v1'));
    const cfg = stubCfg();

    await getCachedFleetStatus(cfg);
    vi.advanceTimersByTime(6_000); // past the 5s TTL

    let resolveRefresh!: (value: FleetStatus) => void;
    buildFleetStatusMock.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));

    const stale = await getCachedFleetStatus(cfg);
    // Honest freshness reporting: never silently presented as current.
    expect(stale.stale).toBe(true);
    expect(stale.ageMs).toBeGreaterThanOrEqual(6_000);
    expect(stale.status.generatedAt).toBe('v1');
    // A background refresh must have been kicked off.
    expect(buildFleetStatusMock).toHaveBeenCalledTimes(2);

    // Concurrent callers during that refresh share the stale value + the
    // same in-flight refresh — no additional buildFleetStatus calls.
    const stale2 = await getCachedFleetStatus(cfg);
    expect(stale2.stale).toBe(true);
    expect(buildFleetStatusMock).toHaveBeenCalledTimes(2);

    resolveRefresh(fleetStatusFixture('v2'));
    await vi.waitFor(async () => {
      const fresh = await getCachedFleetStatus(cfg);
      expect(fresh.status.generatedAt).toBe('v2');
    });
  });

  it('falls back to waiting on a fresh computation once the value is older than the max-stale bound', async () => {
    const { getCachedFleetStatus } = await import('../src/core/web/fleet-status-cache.js');
    buildFleetStatusMock.mockResolvedValueOnce(fleetStatusFixture('v1'));
    const cfg = stubCfg();

    await getCachedFleetStatus(cfg);
    vi.advanceTimersByTime(120_000); // well past FLEET_STATUS_MAX_STALE_MS

    buildFleetStatusMock.mockResolvedValueOnce(fleetStatusFixture('v2'));
    const result = await getCachedFleetStatus(cfg);

    expect(result.stale).toBe(false);
    expect(result.ageMs).toBe(0);
    expect(result.status.generatedAt).toBe('v2');
  });

  it('primeFleetStatusCache makes a mutation immediately visible to the next cached read', async () => {
    const { getCachedFleetStatus, primeFleetStatusCache } = await import('../src/core/web/fleet-status-cache.js');
    buildFleetStatusMock.mockResolvedValue(fleetStatusFixture('v1'));
    const cfg = stubCfg();

    await getCachedFleetStatus(cfg);
    // Simulate a mutation route (e.g. POST /api/fleet/pause) that computed
    // its own fresh value directly and needs GET /api/fleet to reflect it
    // right away, not the pre-mutation cached value.
    primeFleetStatusCache(cfg, fleetStatusFixture('v2-post-mutation'));

    const next = await getCachedFleetStatus(cfg);
    expect(next.stale).toBe(false);
    expect(next.ageMs).toBe(0);
    expect(next.status.generatedAt).toBe('v2-post-mutation');
    // Priming must not have triggered its own buildFleetStatus call.
    expect(buildFleetStatusMock).toHaveBeenCalledTimes(1);
  });

  it('keys the cache per AshlrConfig instance — separate configs never share state', async () => {
    const { getCachedFleetStatus } = await import('../src/core/web/fleet-status-cache.js');
    buildFleetStatusMock
      .mockResolvedValueOnce(fleetStatusFixture('cfgA'))
      .mockResolvedValueOnce(fleetStatusFixture('cfgB'));

    const a = await getCachedFleetStatus(stubCfg());
    const b = await getCachedFleetStatus(stubCfg());

    expect(a.status.generatedAt).toBe('cfgA');
    expect(b.status.generatedAt).toBe('cfgB');
    expect(buildFleetStatusMock).toHaveBeenCalledTimes(2);
  });
});

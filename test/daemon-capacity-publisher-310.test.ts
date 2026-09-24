/**
 * Review finding c8 (3.10): the standing daemon must not depend on the Verse
 * server for seat headroom. With no fresh snapshot from another publisher,
 * the daemon samples through a short-lived account collector under the
 * native-metadata lease (publishing ONLY when it owns it — one writer), and
 * fails closed while cold. Everything is injected: no collector, probe or
 * seat is ever started (HOME is the per-worker temp home from test/setup).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDaemonCapacityPublisher,
  daemonCapacityPublisherRefusal,
  ensureDaemonCapacityPublisher,
  FOREIGN_FRESH_MS,
  SAMPLE_EVERY_MS,
  SAMPLE_TIMEOUT_MS,
  type DaemonCapacityPublisherDeps,
  type PublisherCollector,
} from '../src/core/daemon/capacity-publisher.js';
import { publishCapacitySnapshotFrom, setBudgetCapacitySourceForTest } from '../src/core/routing/budget-api.js';
import { readCapacitySnapshot, type CapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { VerseAccountCollector } from '../src/core/verse/accounts.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = {} as AshlrConfig;

interface Harness {
  deps: DaemonCapacityPublisherDeps;
  clock: { now: number };
  snapshot: { current: CapacitySnapshot | null };
  started: number;
  closed: number;
  published: string[];
  mode: 'owned' | 'read-only' | 'unconfigured';
  /** How many connections() reads report refreshing before the first sample completes. */
  refreshingReads: number;
  logs: string[];
}

function harness(): Harness {
  const h: Harness = {
    deps: undefined as unknown as DaemonCapacityPublisherDeps,
    clock: { now: Date.parse('2026-09-24T03:00:00Z') },
    snapshot: { current: null },
    started: 0,
    closed: 0,
    published: [],
    mode: 'owned',
    refreshingReads: 2,
    logs: [],
  };
  h.deps = {
    nowMs: () => h.clock.now,
    sleep: async (ms) => { h.clock.now += ms; },
    readSnapshot: () => h.snapshot.current,
    startCollector: async () => {
      h.started++;
      let reads = 0;
      const collector: PublisherCollector = {
        status: () => ({ mode: h.mode, reasonCode: h.mode === 'owned' ? null : 'collector-owned' }),
        connections: () => ({ refreshing: reads++ < h.refreshingReads }),
        close: async () => { h.closed++; },
      };
      return collector;
    },
    publish: async () => {
      const publishedAt = new Date(h.clock.now).toISOString();
      h.published.push(publishedAt);
      h.snapshot.current = { v: 1, publishedAt, seats: [] };
      return publishedAt;
    },
    log: (message) => { h.logs.push(message); },
  };
  return h;
}

const foreign = (h: Harness, ageMs: number): CapacitySnapshot => ({ v: 1, publishedAt: new Date(h.clock.now - ageMs).toISOString(), seats: [] });

describe('daemon capacity publisher (c8)', () => {
  it('COLD with no Verse: samples under an OWNED lease, waits for the first sample, publishes, then releases the lease', async () => {
    const h = harness();
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    const status = await pub.cycle();
    expect(status.state).toBe('published');
    expect(h.published).toHaveLength(1);
    expect(status.lastPublishedAt).toBe(h.published[0]);
    expect(h.started).toBe(1);
    expect(h.closed).toBe(1); // lease released between samples
  });

  it('a FRESH snapshot from another publisher (the Verse server) keeps the daemon dormant — no collector, no write', async () => {
    const h = harness();
    h.snapshot.current = foreign(h, 30_000);
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    expect((await pub.cycle()).state).toBe('dormant');
    expect(h.started).toBe(0);
    expect(h.published).toHaveLength(0);
  });

  it('takes over once the Verse snapshot is older than the foreign-fresh window (app quit)', async () => {
    const h = harness();
    h.snapshot.current = foreign(h, FOREIGN_FRESH_MS + 1_000);
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    expect((await pub.cycle()).state).toBe('published');
    expect(h.published).toHaveLength(1);
  });

  it('re-samples its own snapshot only every SAMPLE_EVERY_MS (well inside the 15-minute staleness limit)', async () => {
    const h = harness();
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    await pub.cycle();
    h.clock.now += 60_000;
    expect((await pub.cycle()).state).toBe('fresh');
    expect(h.started).toBe(1);
    h.clock.now += SAMPLE_EVERY_MS;
    expect((await pub.cycle()).state).toBe('published');
    expect(h.started).toBe(2);
    expect(SAMPLE_EVERY_MS).toBeLessThan(15 * 60_000);
  });

  it('yields to a Verse server that starts later: a newer foreign write makes the daemon dormant', async () => {
    const h = harness();
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    await pub.cycle();
    h.clock.now += 30_000;
    h.snapshot.current = foreign(h, 0); // Verse just published
    h.clock.now += 60_000;
    expect((await pub.cycle()).state).toBe('dormant');
    expect(h.started).toBe(1);
  });

  it('SINGLE WRITER: without the lease (read-only / refused) it never publishes and stays cold', async () => {
    const h = harness();
    h.mode = 'read-only';
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    const status = await pub.cycle();
    expect(status.state).toBe('lease-held-elsewhere');
    expect(h.published).toHaveLength(0);
    expect(h.closed).toBe(1);
    expect(h.snapshot.current).toBeNull(); // cold ⇒ readers fail closed
  });

  it('a sample that never completes publishes nothing (no half-sampled readings) and releases the lease', async () => {
    const h = harness();
    h.refreshingReads = Number.MAX_SAFE_INTEGER;
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    const started = h.clock.now;
    const status = await pub.cycle();
    expect(status.state).toBe('sample-timeout');
    expect(h.clock.now - started).toBeGreaterThanOrEqual(SAMPLE_TIMEOUT_MS);
    expect(h.published).toHaveLength(0);
    expect(h.closed).toBe(1);
  });

  it('a failed publish stays cold, releases the lease, and is logged once', async () => {
    const h = harness();
    h.deps.publish = async () => { throw new Error('disk full'); };
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    expect((await pub.cycle()).state).toBe('failed');
    expect(h.closed).toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.snapshot.current).toBeNull();
  });

  it('cycles are single-flight', async () => {
    const h = harness();
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    const [a, b] = await Promise.all([pub.cycle(), pub.cycle()]);
    expect(a).toBe(b);
    expect(h.started).toBe(1);
  });

  it('never starts outside a daemon process or under a test runner', () => {
    expect(daemonCapacityPublisherRefusal({})).toBe('not a daemon process');
    expect(daemonCapacityPublisherRefusal({ ASHLR_IN_DAEMON: '1', VITEST: 'true' })).toBe('test process');
    expect(daemonCapacityPublisherRefusal({ ASHLR_IN_DAEMON: '1', ASHLR_DAEMON_CAPACITY_PUBLISHER: '0' })).toMatch(/disabled/);
    expect(daemonCapacityPublisherRefusal({ ASHLR_IN_DAEMON: '1' })).toBeNull();
    // This process is a vitest worker: ensure is a no-op (no probe is ever spawned).
    expect(ensureDaemonCapacityPublisher(cfg)).toBeNull();
  });
});

describe('publishCapacitySnapshotFrom (c8)', () => {
  afterEach(() => setBudgetCapacitySourceForTest());

  it('reads through the DAEMON\'s collector (not the Verse registry) and writes the private snapshot', async () => {
    const fakeCollector = { accountsRoot: '/nowhere' } as unknown as VerseAccountCollector;
    let seen: unknown = 'unset';
    const observedAt = new Date().toISOString();
    setBudgetCapacitySourceForTest(async (_cfg, opts) => {
      seen = opts?.collector;
      return {
        sampledAt: observedAt,
        seats: [{
          seatId: 'grok', engine: 'grok', label: 'Grok', free: false,
          windows: [{ id: 'grok_unified_weekly', usedPercent: 12, resetsAt: null, resetDescription: null, limitReached: false }],
          signedOut: false, reachable: null, contextWindow: 256_000, observedAt, spentTodayUsd: null,
        }],
      };
    });
    const publishedAt = await publishCapacitySnapshotFrom(cfg, fakeCollector);
    expect(seen).toBe(fakeCollector);
    const snapshot = readCapacitySnapshot();
    expect(snapshot?.publishedAt).toBe(publishedAt);
    expect(snapshot?.seats.map((s) => s.seatId)).toEqual(['grok']);
  });
});

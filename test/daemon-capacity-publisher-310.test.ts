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
  defaultDaemonCapacityPublisherDeps,
  ensureDaemonCapacityPublisher,
  FOREIGN_FRESH_MS,
  SAMPLE_EVERY_MS,
  SAMPLE_TIMEOUT_MS,
  type DaemonCapacityPublisherDeps,
  type PublisherCollector,
} from '../src/core/daemon/capacity-publisher.js';
import { publishCapacitySnapshotFrom, setBudgetCapacitySourceForTest } from '../src/core/routing/budget-api.js';
import { readCapacitySnapshot, writeCapacitySnapshot, type CapacitySnapshot } from '../src/core/routing/budget-store.js';
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

// 3.10.1: every snapshot the daemon sees fresh also feeds the seat capacity
// history, so Command's burn-downs keep the whole window across reloads.
describe('daemon capacity publisher → seat capacity history (3.10.1)', () => {
  function recording(h: Harness): CapacitySnapshot[] {
    const seen: CapacitySnapshot[] = [];
    h.deps.recordHistory = (snapshot) => { seen.push(snapshot); return null; };
    return seen;
  }

  it('records its own publish — exactly the snapshot it wrote', async () => {
    const h = harness();
    const seen = recording(h);
    const status = await createDaemonCapacityPublisher(cfg, h.deps).cycle();
    expect(status.state).toBe('published');
    expect(seen.map((s) => s.publishedAt)).toEqual([status.lastPublishedAt]);
  });

  it('records the Verse server\'s fresh snapshot while dormant (the store drops what it already holds)', async () => {
    const h = harness();
    const seen = recording(h);
    h.snapshot.current = foreign(h, 30_000);
    expect((await createDaemonCapacityPublisher(cfg, h.deps).cycle()).state).toBe('dormant');
    expect(seen).toEqual([h.snapshot.current]);
  });

  it('records nothing while its own snapshot is fresh, or when nothing was published', async () => {
    const h = harness();
    const seen = recording(h);
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    await pub.cycle();
    h.clock.now += 60_000;
    expect((await pub.cycle()).state).toBe('fresh');
    expect(seen).toHaveLength(1);
    const cold = harness();
    const coldSeen = recording(cold);
    cold.mode = 'read-only';
    await createDaemonCapacityPublisher(cfg, cold.deps).cycle();
    expect(coldSeen).toEqual([]);
  });

  it('skips a snapshot another writer replaced between publish and record', async () => {
    const h = harness();
    const seen = recording(h);
    const publish = h.deps.publish;
    h.deps.publish = async (c, collector) => {
      const at = await publish(c, collector);
      h.snapshot.current = foreign(h, -1_000); // a Verse write landed right after ours
      return at;
    };
    expect((await createDaemonCapacityPublisher(cfg, h.deps).cycle()).state).toBe('published');
    expect(seen).toEqual([]);
  });

  it('a history failure never changes the publisher\'s state, and is logged once per distinct error', async () => {
    const h = harness();
    let calls = 0;
    h.deps.recordHistory = () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'EACCES'; };
    h.snapshot.current = foreign(h, 30_000);
    const pub = createDaemonCapacityPublisher(cfg, h.deps);
    expect((await pub.cycle()).state).toBe('dormant');
    expect((await pub.cycle()).state).toBe('dormant');
    expect((await pub.cycle()).state).toBe('dormant');
    expect(calls).toBe(3);
    expect(h.logs.filter((l) => l.includes('capacity history'))).toEqual([
      'daemon capacity publisher: capacity history was not recorded (boom)',
      'daemon capacity publisher: capacity history was not recorded (EACCES)',
    ]);
  });

  // Review finding (3.10.1): the old version of this test called the store
  // directly, so deleting `recordHistory` from the daemon's default wiring
  // (the field is optional) failed nothing. This drives the PRODUCTION deps.
  it('the daemon\'s DEFAULT wiring records history: a fresh Verse snapshot seen while dormant lands in the file (relocated HOME, 0600)', async () => {
    const { capacityHistoryPath, readCapacityHistory } = await import('../src/core/routing/capacity-history.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const nodePath = await import('node:path');
    const savedHome = process.env['HOME'];
    const savedFlag = process.env['ASHLR_CAPACITY_HISTORY'];
    const home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'publisher-history-')));
    process.env['HOME'] = home;
    delete process.env['ASHLR_CAPACITY_HISTORY'];
    const grok = (observedAt: string, usedPercent: number): CapacitySnapshot['seats'][number] => ({
      seatId: 'grok', engine: 'grok', label: 'Grok', free: false,
      windows: [{ id: 'grok_unified_weekly', usedPercent, resetsAt: null, resetDescription: null, limitReached: false }],
      signedOut: false, reachable: null, contextWindow: 256_000, observedAt, spentTodayUsd: null,
    });
    const tsOf = (iso: string) => new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    try {
      const deps = defaultDaemonCapacityPublisherDeps();
      expect(deps.recordHistory).toBeTypeOf('function');
      // The Verse server just published: the production readSnapshot finds it
      // fresh, the publisher stays dormant (no collector), and the production
      // recordHistory appends it.
      const observedAt = new Date(Date.now() - 5_000).toISOString();
      writeCapacitySnapshot([grok(observedAt, 12)], new Date());
      let started = 0;
      const pub = createDaemonCapacityPublisher(cfg, {
        ...deps,
        startCollector: async () => { started += 1; throw new Error('no collector in tests'); },
        log: () => {},
      });
      expect((await pub.cycle()).state).toBe('dormant');
      expect(started).toBe(0);
      const file = capacityHistoryPath();
      expect(file).toBe(nodePath.join(home, '.ashlr', 'routing', 'capacity-history.jsonl'));
      expect(readCapacityHistory()).toEqual([
        { ts: tsOf(observedAt), seat: 'grok', window: 'weekly', usedPct: 12, resetsAt: null, source: 'daemon' },
      ]);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // The default recorder alone: a changed reading, no error.
      const later = new Date().toISOString();
      expect(deps.recordHistory!({ v: 1, publishedAt: later, seats: [grok(later, 13)] })).toBeNull();
      expect(readCapacityHistory().map((r) => r.usedPct)).toEqual([12, 13]);
      // ASHLR_CAPACITY_HISTORY=0 stops the daemon's recorder too (enforced in the store).
      process.env['ASHLR_CAPACITY_HISTORY'] = '0';
      const last = new Date(Date.now() + 1_000).toISOString();
      expect(deps.recordHistory!({ v: 1, publishedAt: last, seats: [grok(last, 14)] })).toBeNull();
      expect(readCapacityHistory().map((r) => r.usedPct)).toEqual([12, 13]);
    } finally {
      process.env['HOME'] = savedHome;
      if (savedFlag === undefined) delete process.env['ASHLR_CAPACITY_HISTORY'];
      else process.env['ASHLR_CAPACITY_HISTORY'] = savedFlag;
      fs.rmSync(home, { recursive: true, force: true });
    }
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

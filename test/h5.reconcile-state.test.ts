/**
 * h5.reconcile-state.test.ts — H5 CHANGE 2 (reconcile stale daemon state).
 *
 * Proves the OBSERVABILITY-ONLY liveness reconcile required by CONTRACT-H5:
 *  - running:true + a DEAD pid  -> running:false / pid:null (dead daemon never
 *    misreported as live).
 *  - running:true + a LIVE pid (process.pid / self) -> unchanged (stays live).
 *  - running:false (or pid:null) -> unchanged (nothing to reconcile).
 *  - todaySpentUsd / itemsProcessed / ticks / dates are preserved EXACTLY —
 *    reconcile changes NO spend accounting and NO guard.
 *  - The loadDaemonState() chokepoint self-heals on read (wiring landed in H5),
 *    so status/start/tick never see a phantom-live daemon.
 *
 * Isolated tmp HOME via the H1 fixture — the real ~/.ashlr is NEVER touched.
 * Every it() carries a real expect() + expect.hasAssertions().
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  reconcileDaemonState,
  loadDaemonState,
  saveDaemonState,
} from '../src/core/daemon/state.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import type { DaemonState } from '../src/core/types.js';

let fx: H1Fixture;

afterEach(() => {
  fx?.cleanup();
});

/**
 * A pid that is (almost certainly) NOT a live process. 2**22 is far above any
 * realistic live pid on the test host; process.kill(pid, 0) yields ESRCH.
 */
function deadPid(): number {
  return 2 ** 22;
}

function seedState(over: Partial<DaemonState>): DaemonState {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
    ...over,
  };
}

const TICKS: DaemonState['ticks'] = [
  {
    ts: '2026-06-10T00:00:00.000Z',
    itemsConsidered: 1,
    proposalsCreated: 1,
    spentUsd: 0.1,
    reason: 'ok',
  },
  {
    ts: '2026-06-10T00:05:00.000Z',
    itemsConsidered: 2,
    proposalsCreated: 0,
    spentUsd: 0.2,
    reason: 'no-backlog',
  },
];

describe('H5 · reconcileDaemonState · dead-pid liveness (observability-only)', () => {
  it('flips running:true + a DEAD pid to running:false / pid:null', () => {
    expect.hasAssertions();
    fx = makeFixture();
    const seeded = seedState({ running: true, pid: deadPid() });
    const out = reconcileDaemonState(seeded);
    expect(out.running).toBe(false);
    expect(out.pid).toBeNull();
  });

  it('leaves running:true + a LIVE pid (process.pid / self) untouched', () => {
    expect.hasAssertions();
    fx = makeFixture();
    const seeded = seedState({ running: true, pid: process.pid });
    const out = reconcileDaemonState(seeded);
    expect(out.running).toBe(true);
    expect(out.pid).toBe(process.pid);
  });

  it('is a no-op when running:false (nothing to reconcile), even with a dead pid', () => {
    expect.hasAssertions();
    fx = makeFixture();
    const seeded = seedState({ running: false, pid: deadPid() });
    const out = reconcileDaemonState(seeded);
    // running was already false — reconcile must not invent a flip or null the pid.
    expect(out.running).toBe(false);
    expect(out.pid).toBe(deadPid());
    expect(out).toBe(seeded); // returned unchanged (same reference)
  });

  it('is a no-op when pid is null (nothing to reconcile)', () => {
    expect.hasAssertions();
    fx = makeFixture();
    const seeded = seedState({ running: true, pid: null });
    const out = reconcileDaemonState(seeded);
    expect(out.running).toBe(true);
    expect(out.pid).toBeNull();
    expect(out).toBe(seeded);
  });

  it('preserves todaySpentUsd / itemsProcessed / ticks / dates EXACTLY while flipping a dead pid', () => {
    expect.hasAssertions();
    fx = makeFixture();
    const seeded = seedState({
      running: true,
      pid: deadPid(),
      startedAt: '2026-06-10T00:00:00.000Z',
      lastTickAt: '2026-06-10T00:05:00.000Z',
      todayDate: '2026-06-10',
      todaySpentUsd: 0.99,
      itemsProcessed: 7,
      ticks: TICKS,
    });
    const out = reconcileDaemonState(seeded);
    // Only running/pid flip; ALL spend accounting is byte-for-byte identical.
    expect(out.running).toBe(false);
    expect(out.pid).toBeNull();
    expect(out.todaySpentUsd).toBe(0.99);
    expect(out.itemsProcessed).toBe(7);
    expect(out.todayDate).toBe('2026-06-10');
    expect(out.startedAt).toBe('2026-06-10T00:00:00.000Z');
    expect(out.lastTickAt).toBe('2026-06-10T00:05:00.000Z');
    expect(out.ticks).toEqual(TICKS);
    // The source ticks array reference is preserved (no spend mutation).
    expect(out.ticks).toBe(seeded.ticks);
  });

  it('loadDaemonState() self-heals a persisted dead-pid running:true on read', () => {
    expect.hasAssertions();
    fx = makeFixture();
    // Persist a phantom-live daemon (running:true, dead pid) with real spend.
    saveDaemonState(
      seedState({
        running: true,
        pid: deadPid(),
        todayDate: '2026-06-10',
        todaySpentUsd: 1.25,
        itemsProcessed: 3,
        ticks: TICKS,
      }),
    );
    const loaded = loadDaemonState();
    // Chokepoint reconcile: never reports the dead daemon as live...
    expect(loaded.running).toBe(false);
    expect(loaded.pid).toBeNull();
    // ...while preserving spend accounting untouched.
    expect(loaded.todaySpentUsd).toBe(1.25);
    expect(loaded.itemsProcessed).toBe(3);
    expect(loaded.todayDate).toBe('2026-06-10');
    expect(loaded.ticks).toEqual(TICKS);
  });

  it('loadDaemonState() keeps a persisted LIVE pid (self) reported as running', () => {
    expect.hasAssertions();
    fx = makeFixture();
    saveDaemonState(seedState({ running: true, pid: process.pid, todaySpentUsd: 0.5 }));
    const loaded = loadDaemonState();
    expect(loaded.running).toBe(true);
    expect(loaded.pid).toBe(process.pid);
    expect(loaded.todaySpentUsd).toBe(0.5);
  });
});

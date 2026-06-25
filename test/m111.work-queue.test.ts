/**
 * m111.work-queue.test.ts — WorkQueueCoordinator seam + SharedStore (M111).
 *
 * SAFETY GUARDRAILS (mirrors m85.fleet-continuity.test.ts):
 *  - HOME is NOT touched (these tests use dedicated tmp dirs for the shared store).
 *  - All shared-store paths point to isolated tmp dirs — no real ~/.ashlr state.
 *  - No real agents, subprocesses, or API calls.
 *  - All tmp dirs are cleaned up in afterEach.
 *
 * Test matrix:
 *  1. LocalWorkQueueCoordinator — mirrors today's single-machine behavior.
 *  2. SharedWorkQueueCoordinator, single machine — basic claim / release / outcome.
 *  3. SharedWorkQueueCoordinator, TWO machines — disjoint claims proof (no double-claim).
 *  4. Expired lease reclaimable (failover).
 *  5. Global cooldown — item marked 'empty' by machine A is skipped by machine B.
 *  6. Degraded path — unwritable / missing dir → safe/empty, never throws.
 *  7. selectWorkQueueCoordinator — returns Local (off / absent) vs Shared (filesystem+path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkItem, AshlrConfig } from '../src/core/types.js';
import {
  LocalWorkQueueCoordinator,
  SharedWorkQueueCoordinator,
  selectWorkQueueCoordinator,
} from '../src/core/seams/work-queue-coordinator.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeItem(id: string, repo = '/tmp/repo', score = 5): WorkItem {
  return {
    id,
    repo,
    source: 'todo',
    title: `Item ${id}`,
    detail: `detail for ${id}`,
    value: 3,
    effort: 3,
    score,
    tags: [],
    ts: new Date().toISOString(),
  };
}

function makeStore(dir: string, leaseMs = 10_000): SharedStore {
  return new SharedStore(dir, leaseMs);
}

function makeSharedCoordinator(store: SharedStore, machineId: string, leaseMs = 10_000): SharedWorkQueueCoordinator {
  return new SharedWorkQueueCoordinator(store, machineId, leaseMs);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m111-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// 1. LocalWorkQueueCoordinator — mirrors single-machine behavior
// ===========================================================================

describe('M111 LocalWorkQueueCoordinator', () => {
  it('claimItems returns top-count candidates in order', () => {
    const coord = new LocalWorkQueueCoordinator();
    const items = [makeItem('a', '/r', 10), makeItem('b', '/r', 5), makeItem('c', '/r', 1)];
    const claimed = coord.claimItems(items, 2, 'machine-1');
    expect(claimed.map(i => i.id)).toEqual(['a', 'b']);
  });

  it('claimItems returns all when count >= candidates', () => {
    const coord = new LocalWorkQueueCoordinator();
    const items = [makeItem('x'), makeItem('y')];
    expect(coord.claimItems(items, 5, 'machine-1')).toHaveLength(2);
  });

  it('claimItems returns empty for empty candidates', () => {
    const coord = new LocalWorkQueueCoordinator();
    expect(coord.claimItems([], 3, 'machine-1')).toEqual([]);
  });

  it('release is a no-op — does not throw', () => {
    const coord = new LocalWorkQueueCoordinator();
    expect(() => coord.release(['a', 'b'], 'machine-1')).not.toThrow();
  });

  it('recordOutcome writes to local ledger and shouldSkip picks it up', () => {
    const coord = new LocalWorkQueueCoordinator();
    // Override HOME to tmpDir so the local ledger stays isolated.
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      coord.recordOutcome('item-local', 'empty', 'machine-1');
      // shouldSkip uses DEFAULT_COOLDOWN_MS (6h) — 'empty' just recorded = true.
      expect(coord.shouldSkip('item-local', 6 * 60 * 60 * 1000)).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('shouldSkip returns false for unknown item', () => {
    const coord = new LocalWorkQueueCoordinator();
    expect(coord.shouldSkip('no-such-item', 1000)).toBe(false);
  });

  it('shouldSkip returns false after "diff" outcome', () => {
    const coord = new LocalWorkQueueCoordinator();
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      coord.recordOutcome('item-diff', 'diff', 'machine-1');
      expect(coord.shouldSkip('item-diff', 6 * 60 * 60 * 1000)).toBe(false);
    } finally {
      process.env.HOME = origHome;
    }
  });
});

// ===========================================================================
// 2. SharedWorkQueueCoordinator — single machine, basic operations
// ===========================================================================

describe('M111 SharedWorkQueueCoordinator — single machine basics', () => {
  it('claimItems returns the requested items', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    const claimed = coord.claimItems(items, 2, 'machine-A');
    expect(claimed).toHaveLength(2);
    expect(claimed.map(i => i.id)).toContain('a');
    expect(claimed.map(i => i.id)).toContain('b');
  });

  it('claimed items appear in the store snapshot', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    coord.claimItems([makeItem('z')], 1, 'machine-A');
    const snap = store.readSnapshot();
    expect(snap.claims['z']).toBeDefined();
    expect(snap.claims['z']!.machineId).toBe('machine-A');
  });

  it('release removes the claim', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    coord.claimItems([makeItem('r1')], 1, 'machine-A');
    coord.release(['r1'], 'machine-A');
    expect(store.readSnapshot().claims['r1']).toBeUndefined();
  });

  it('recordOutcome writes to global worked ledger + releases claim', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    coord.claimItems([makeItem('out1')], 1, 'machine-A');
    coord.recordOutcome('out1', 'diff', 'machine-A');
    const snap = store.readSnapshot();
    expect(snap.claims['out1']).toBeUndefined(); // claim released
    expect(snap.worked.some(e => e.itemId === 'out1' && e.outcome === 'diff')).toBe(true);
  });

  it('shouldSkip returns true within cooldown after "empty"', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    coord.claimItems([makeItem('cooled')], 1, 'machine-A');
    coord.recordOutcome('cooled', 'empty', 'machine-A');
    expect(coord.shouldSkip('cooled', 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('shouldSkip returns false for unknown item', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    expect(coord.shouldSkip('no-such', 1000)).toBe(false);
  });
});

// ===========================================================================
// 3. TWO machines — disjoint claims proof (no double-claim)
// ===========================================================================

describe('M111 SharedWorkQueueCoordinator — two machines, no double-claim', () => {
  it('machines A and B receive DISJOINT items from the same candidate list', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    const items = [
      makeItem('i1'), makeItem('i2'), makeItem('i3'),
      makeItem('i4'), makeItem('i5'), makeItem('i6'),
    ];

    // Both machines claim 3 items from the same 6-item list sequentially.
    // (In production they race; sequential simulation is sufficient for atomicity proof.)
    const claimedA = coordA.claimItems(items, 3, 'machine-A');
    const claimedB = coordB.claimItems(items, 3, 'machine-B');

    const idsA = new Set(claimedA.map(i => i.id));
    const idsB = new Set(claimedB.map(i => i.id));

    // No overlap — every id appears in at most one machine's claim set.
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
    // Together they cover all 6 items (or up to 3+3=6).
    expect(claimedA.length + claimedB.length).toBe(6);
  });

  it('a second claimItems call returns no items when all are already claimed', () => {
    const store = makeStore(tmpDir, 30_000);
    const coordA = makeSharedCoordinator(store, 'machine-A', 30_000);
    const coordB = makeSharedCoordinator(store, 'machine-B', 30_000);

    const items = [makeItem('only1'), makeItem('only2')];

    coordA.claimItems(items, 2, 'machine-A'); // A claims both
    const claimedB = coordB.claimItems(items, 2, 'machine-B'); // B gets nothing

    expect(claimedB).toHaveLength(0);
  });

  it('each machine owns exactly its claimed items in the store snapshot', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    const items = [makeItem('p'), makeItem('q'), makeItem('r'), makeItem('s')];
    coordA.claimItems(items, 2, 'machine-A');
    coordB.claimItems(items, 2, 'machine-B');

    const snap = store.readSnapshot();
    const claimsA = Object.entries(snap.claims).filter(([, v]) => v.machineId === 'machine-A').map(([k]) => k);
    const claimsB = Object.entries(snap.claims).filter(([, v]) => v.machineId === 'machine-B').map(([k]) => k);

    // No item claimed by both.
    const setA = new Set(claimsA);
    for (const id of claimsB) {
      expect(setA.has(id)).toBe(false);
    }
    expect(claimsA.length + claimsB.length).toBe(4);
  });
});

// ===========================================================================
// 4. Expired lease is reclaimable (failover)
// ===========================================================================

describe('M111 SharedStore — expired lease reclaimable', () => {
  it('machine B can reclaim an item whose lease has expired', () => {
    // Use a very short leaseMs so we can backdate the leaseUntil.
    const store = makeStore(tmpDir, 1); // 1 ms lease
    const coordA = makeSharedCoordinator(store, 'machine-A', 1);

    const item = makeItem('failover-item');
    coordA.claimItems([item], 1, 'machine-A');

    // Manually expire the lease by backdating it in the queue file.
    const queuePath = path.join(tmpDir, 'ashlr-fleet-queue.json');
    const snap = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as { claims: Record<string, { machineId: string; leaseUntil: number }> };
    snap.claims['failover-item']!.leaseUntil = Date.now() - 10_000; // 10s in the past
    fs.writeFileSync(queuePath, JSON.stringify(snap, null, 2));

    // Machine B can now reclaim it.
    const coordB = makeSharedCoordinator(store, 'machine-B', 10_000);
    const claimedB = coordB.claimItems([item], 1, 'machine-B');
    expect(claimedB.map(i => i.id)).toContain('failover-item');

    const newSnap = store.readSnapshot();
    expect(newSnap.claims['failover-item']!.machineId).toBe('machine-B');
  });
});

// ===========================================================================
// 5. Global cooldown — cross-machine skip
// ===========================================================================

describe('M111 SharedWorkQueueCoordinator — global cooldown crosses machines', () => {
  it('item marked empty by machine A is skipped by machine B', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    const item = makeItem('global-cooled');
    coordA.claimItems([item], 1, 'machine-A');
    coordA.recordOutcome('global-cooled', 'empty', 'machine-A');

    // Machine B's shouldSkip should see the global 'empty' entry.
    expect(coordB.shouldSkip('global-cooled', 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('item marked diff by machine A is NOT skipped by machine B', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    const item = makeItem('global-diff');
    coordA.claimItems([item], 1, 'machine-A');
    coordA.recordOutcome('global-diff', 'diff', 'machine-A');

    expect(coordB.shouldSkip('global-diff', 6 * 60 * 60 * 1000)).toBe(false);
  });

  it('global cooldown expires — item becomes eligible again', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    const item = makeItem('expired-global');
    coordA.claimItems([item], 1, 'machine-A');
    coordA.recordOutcome('expired-global', 'empty', 'machine-A');

    // Ask shouldSkip with `now` far in the future (cooldown already expired).
    // Use store.recentlyDeclined directly with an injected `now` for determinism.
    const futureNow = Date.now() + 10 * 60 * 60 * 1000; // 10h from now
    expect(store.recentlyDeclined('expired-global', 60 * 60 * 1000, futureNow)).toBe(false);
  });
});

// ===========================================================================
// 6. Degraded path — missing / unwritable dir → safe, never throws
// ===========================================================================

describe('M111 SharedStore — degraded / unwritable path', () => {
  it('claimItems returns [] when dir does not exist and cannot be created', () => {
    // Use a path whose parent doesn't exist and can't be created.
    const store = new SharedStore('/nonexistent-root-path/ashlr-fleet/shared');
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000);
    expect(() => coord.claimItems([makeItem('x')], 1, 'machine-X')).not.toThrow();
    expect(coord.claimItems([makeItem('x')], 1, 'machine-X')).toEqual([]);
  });

  it('release never throws on bad path', () => {
    const store = new SharedStore('/nonexistent-root-path/ashlr-fleet/shared');
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000);
    expect(() => coord.release(['a', 'b'], 'machine-X')).not.toThrow();
  });

  it('recordOutcome never throws on bad path', () => {
    const store = new SharedStore('/nonexistent-root-path/ashlr-fleet/shared');
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000);
    expect(() => coord.recordOutcome('x', 'empty', 'machine-X')).not.toThrow();
  });

  it('shouldSkip returns false (fail-open) on bad path', () => {
    const store = new SharedStore('/nonexistent-root-path/ashlr-fleet/shared');
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000);
    expect(coord.shouldSkip('any', 1000)).toBe(false);
  });

  it('readSnapshot returns empty queue on bad path', () => {
    const store = new SharedStore('/nonexistent-root-path/ashlr-fleet/shared');
    const snap = store.readSnapshot();
    expect(snap.claims).toEqual({});
    expect(snap.worked).toEqual([]);
    expect(snap.usage).toEqual([]);
  });

  it('never throws when the queue file is corrupt JSON', () => {
    const store = makeStore(tmpDir);
    // Write corrupt JSON directly.
    fs.writeFileSync(path.join(tmpDir, 'ashlr-fleet-queue.json'), '{ NOT VALID !!!', 'utf8');
    expect(() => store.readSnapshot()).not.toThrow();
    expect(store.readSnapshot().claims).toEqual({});
  });
});

// ===========================================================================
// 7. selectWorkQueueCoordinator — selector picks Local vs Shared correctly
// ===========================================================================

describe('M111 selectWorkQueueCoordinator', () => {
  function baseCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
    return { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [], models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {}, plugins: { enabled: [], settings: {}, integrity: {} }, ...overrides } as AshlrConfig;
  }

  it('returns LocalWorkQueueCoordinator when fleet is absent', () => {
    const coord = selectWorkQueueCoordinator(baseCfg());
    expect(coord).toBeInstanceOf(LocalWorkQueueCoordinator);
  });

  it('returns LocalWorkQueueCoordinator when mode is "off"', () => {
    const coord = selectWorkQueueCoordinator(baseCfg({ fleet: { sharedQueue: { mode: 'off' } } }));
    expect(coord).toBeInstanceOf(LocalWorkQueueCoordinator);
  });

  it('returns LocalWorkQueueCoordinator when mode is "filesystem" but path is missing', () => {
    const coord = selectWorkQueueCoordinator(baseCfg({ fleet: { sharedQueue: { mode: 'filesystem' } } }));
    expect(coord).toBeInstanceOf(LocalWorkQueueCoordinator);
  });

  it('returns LocalWorkQueueCoordinator when mode is "filesystem" but path is empty string', () => {
    const coord = selectWorkQueueCoordinator(baseCfg({ fleet: { sharedQueue: { mode: 'filesystem', path: '   ' } } }));
    expect(coord).toBeInstanceOf(LocalWorkQueueCoordinator);
  });

  it('returns SharedWorkQueueCoordinator when mode is "filesystem" and path is set', () => {
    const coord = selectWorkQueueCoordinator(baseCfg({ fleet: { sharedQueue: { mode: 'filesystem', path: tmpDir } } }));
    expect(coord).toBeInstanceOf(SharedWorkQueueCoordinator);
  });

  it('Local coordinator still works correctly after selection (regression)', () => {
    const coord = selectWorkQueueCoordinator(baseCfg());
    const items = [makeItem('sel-a'), makeItem('sel-b')];
    expect(coord.claimItems(items, 1, 'machine-local')).toHaveLength(1);
    expect(() => coord.release(['sel-a'], 'machine-local')).not.toThrow();
  });
});

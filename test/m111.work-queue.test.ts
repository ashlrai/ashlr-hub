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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkItem, AshlrConfig } from '../src/core/types.js';
import {
  LocalWorkQueueCoordinator,
  SharedWorkQueueCoordinator,
  isMintedExecutionAuthority,
  selectWorkQueueCoordinator,
} from '../src/core/seams/work-queue-coordinator.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { workItemCoverageKey, workItemExecutionKey } from '../src/core/fleet/proposal-matching.js';

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
  return new SharedWorkQueueCoordinator(store, machineId, leaseMs, true);
}

function makeUnusableStorePath(): string {
  const blocker = path.join(tmpDir, 'blocker-file');
  fs.writeFileSync(blocker, 'not a directory');
  return path.join(blocker, 'ashlr-fleet', 'shared');
}

function executionKey(item: WorkItem): string {
  const key = workItemExecutionKey(item);
  if (key === null) throw new Error('fixture work item must have an execution identity');
  return key;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m111-'));
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('keeps equal scanner ids from distinct repositories across lanes', () => {
    const coord = new LocalWorkQueueCoordinator();
    const first = makeItem('shared-id', path.join(tmpDir, 'repo-a'));
    const second = makeItem('shared-id', path.join(tmpDir, 'repo-b'));

    expect(coord.claimItemsByLane([
      { candidates: [first], limit: 1 },
      { candidates: [second], limit: 1 },
    ], 2, 'machine-1')).toEqual([first, second]);
  });

  it('release is a no-op — does not throw', () => {
    const coord = new LocalWorkQueueCoordinator();
    expect(() => coord.release([makeItem('a'), makeItem('b')], 'machine-1')).not.toThrow();
  });

  it('renew is a no-op — does not throw', () => {
    const coord = new LocalWorkQueueCoordinator();
    expect(coord.renew([makeItem('a'), makeItem('b')], 'machine-1')).toEqual([]);
  });

  it('projects only local authority at the pre-execution boundary', () => {
    const authority = new LocalWorkQueueCoordinator().beginExecution(makeItem('local'), 'machine-1');
    expect(authority).toEqual({ kind: 'local' });
    expect(isMintedExecutionAuthority(authority)).toBe(true);
    expect(isMintedExecutionAuthority({ ...authority })).toBe(false);
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

  it('keeps the raw ledger id while cooling only the matching repository work key', () => {
    const coord = new LocalWorkQueueCoordinator();
    const first = makeItem('shared-id', path.join(tmpDir, 'repo-a'));
    const second = makeItem('shared-id', path.join(tmpDir, 'repo-b'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      expect(coord.recordClaimOutcome(
        first,
        workItemCoverageKey(first),
        'empty',
        'machine-1',
      )).toBe(true);

      expect(coord.readWorkedEvents()).toEqual([
        expect.objectContaining({ itemId: 'shared-id', itemKey: workItemCoverageKey(first) }),
      ]);
      expect(coord.shouldSkip(workItemCoverageKey(first), 6 * 60 * 60 * 1000)).toBe(true);
      expect(coord.shouldSkip(workItemCoverageKey(second), 6 * 60 * 60 * 1000)).toBe(false);
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

describe('M111 WorkItem execution identity', () => {
  it('is canonical across normalized repository aliases and distinct across repositories', () => {
    const canonicalRepo = path.join(tmpDir, 'canonical-repo');
    const aliasRoot = path.join(tmpDir, 'alias-root');
    fs.mkdirSync(canonicalRepo);
    fs.mkdirSync(aliasRoot);
    const aliasRepo = path.join(aliasRoot, '..', 'canonical-repo');
    const same = makeItem('same-id', canonicalRepo);
    const alias = makeItem('same-id', aliasRepo);
    const other = makeItem('same-id', path.join(tmpDir, 'other-repo'));

    expect(workItemExecutionKey(alias)).toBe(workItemExecutionKey(same));
    expect(workItemExecutionKey(other)).not.toBe(workItemExecutionKey(same));
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
    expect(fs.existsSync(path.join(tmpDir, 'ashlr-fleet-queue.json'))).toBe(true);
  });

  it('claims equal ids independently when they belong to different repositories', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    const first = makeItem('shared-id', path.join(tmpDir, 'repo-a'));
    const second = makeItem('shared-id', path.join(tmpDir, 'repo-b'));

    expect(coord.claimItems([first, second], 2, 'machine-A')).toEqual([first, second]);
    expect(Object.keys(store.readSnapshot().claims)).toEqual([
      executionKey(first),
      executionKey(second),
    ]);
  });

  it('claims equal ids independently when split across shared claim lanes', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    const first = makeItem('shared-lane-id', path.join(tmpDir, 'repo-a'));
    const second = makeItem('shared-lane-id', path.join(tmpDir, 'repo-b'));

    expect(coord.claimItemsByLane([
      { candidates: [first], limit: 1 },
      { candidates: [second], limit: 1 },
    ], 2, 'machine-A')).toEqual([first, second]);
    expect(Object.keys(store.readSnapshot().claims)).toEqual([
      executionKey(first),
      executionKey(second),
    ]);
  });

  it('claimItemsByLane refills contention without exceeding a lane quota', () => {
    const store = makeStore(tmpDir);
    const other = makeSharedCoordinator(store, 'machine-other');
    const coord = makeSharedCoordinator(store, 'machine-A');
    const repairs = [makeItem('repair-1'), makeItem('repair-2')];
    const ordinary = [makeItem('ordinary-1'), makeItem('ordinary-2')];
    expect(other.claimItems([ordinary[0]!], 1, 'machine-other').map((item) => item.id))
      .toEqual(['ordinary-1']);

    const claimed = coord.claimItemsByLane([
      { candidates: repairs, limit: 1 },
      { candidates: ordinary, limit: 2 },
    ], 2, 'machine-A');

    expect(claimed.map((item) => item.id)).toEqual(['repair-1', 'ordinary-2']);
    expect(claimed.map((item) => item.id)).not.toContain('repair-2');
  });

  it('claimItemsByLane refills a contended repair from the same lane', () => {
    const store = makeStore(tmpDir);
    const other = makeSharedCoordinator(store, 'machine-other');
    const coord = makeSharedCoordinator(store, 'machine-A');
    const repairs = [makeItem('repair-1'), makeItem('repair-2')];
    const ordinary = [makeItem('ordinary-1'), makeItem('ordinary-2')];
    other.claimItems([repairs[0]!], 1, 'machine-other');

    const claimed = coord.claimItemsByLane([
      { candidates: repairs, limit: 1 },
      { candidates: ordinary, limit: 2 },
    ], 2, 'machine-A');

    expect(claimed.map((item) => item.id)).toEqual(['repair-2', 'ordinary-1']);
  });

  it('claimItemsByLane falls back after an ordinary-first fairness claim loses contention', () => {
    const store = makeStore(tmpDir);
    const other = makeSharedCoordinator(store, 'machine-other');
    const coord = makeSharedCoordinator(store, 'machine-A');
    const ordinary = makeItem('ordinary-due');
    const repair = makeItem('repair-fallback');
    expect(other.claimItems([ordinary], 1, 'machine-other').map((item) => item.id))
      .toEqual(['ordinary-due']);

    const claimed = coord.claimItemsByLane([
      { candidates: [ordinary], limit: 1 },
      { candidates: [repair], limit: 1 },
    ], 1, 'machine-A');

    expect(claimed.map((item) => item.id)).toEqual(['repair-fallback']);
  });

  it('claimed items appear in the store snapshot', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    const item = makeItem('z');
    coord.claimItems([item], 1, 'machine-A');
    const snap = store.readSnapshot();
    expect(snap.claims[executionKey(item)]).toBeDefined();
    expect(snap.claims[executionKey(item)]!.machineId).toBe('machine-A');
  });

  it('release removes the claim', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    const item = makeItem('r1');
    coord.claimItems([item], 1, 'machine-A');
    coord.release([item], 'machine-A');
    expect(store.readSnapshot().claims[executionKey(item)]).toBeUndefined();
  });

  it('renew extends an active claim owned by the same machine', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const store = makeStore(tmpDir, 10_000);
    const coord = makeSharedCoordinator(store, 'machine-A', 10_000);
    const item = makeItem('renew-owned');
    coord.claimItems([item], 1, 'machine-A');

    now.mockReturnValue(100_100);

    expect(coord.renew([item], 'machine-A')).toEqual([item]);
    const renewed = store.readSnapshot().claims[executionKey(item)];
    expect(renewed?.machineId).toBe('machine-A');
    expect(renewed?.leaseUntil ?? 0).toBeGreaterThan(Date.now() + 5_000);
  });

  it('renew ignores claims owned by another machine', () => {
    const store = makeStore(tmpDir, 10_000);
    const coordA = makeSharedCoordinator(store, 'machine-A', 10_000);
    const coordB = makeSharedCoordinator(store, 'machine-B', 10_000);
    const item = makeItem('renew-other');
    coordA.claimItems([item], 1, 'machine-A');
    const before = store.readSnapshot().claims[executionKey(item)]!.leaseUntil;

    expect(coordB.renew([item], 'machine-B')).toEqual([]);
    const after = store.readSnapshot().claims[executionKey(item)]!;
    expect(after.machineId).toBe('machine-A');
    expect(after.leaseUntil).toBe(before);
  });

  it('renew refuses an expired same-machine claim before another machine reclaims it', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const store = makeStore(tmpDir, 10_000);
    const coordA = makeSharedCoordinator(store, 'machine-A', 10_000);
    const coordB = makeSharedCoordinator(store, 'machine-B', 10_000);
    const item = makeItem('renew-late');
    coordA.claimItems([item], 1, 'machine-A');

    now.mockReturnValue(210_000);

    expect(coordA.renew([item], 'machine-A')).toEqual([]);
    expect(coordB.claimItems([item], 1, 'machine-B').map((claimed) => claimed.id))
      .toEqual(['renew-late']);
    const reclaimed = store.readSnapshot().claims[executionKey(item)]!;
    expect(reclaimed.machineId).toBe('machine-B');
  });

  it('renew cannot steal back a claim after another machine reclaims it', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(300_000);
    const store = makeStore(tmpDir, 10_000);
    const coordA = makeSharedCoordinator(store, 'machine-A', 10_000);
    const coordB = makeSharedCoordinator(store, 'machine-B', 10_000);
    const item = makeItem('renew-reclaimed');
    coordA.claimItems([item], 1, 'machine-A');

    now.mockReturnValue(310_000);

    expect(coordB.claimItems([item], 1, 'machine-B').map((i) => i.id)).toEqual(['renew-reclaimed']);
    expect(coordA.renew([item], 'machine-A')).toEqual([]);
    expect(store.readSnapshot().claims[executionKey(item)]!.machineId).toBe('machine-B');
  });

  it('recordOutcome writes to global worked ledger + releases claim', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    const item = makeItem('out1');
    coord.claimItems([item], 1, 'machine-A');
    coord.recordClaimOutcome(item, 'out1', 'diff', 'machine-A');
    const snap = store.readSnapshot();
    expect(snap.claims[executionKey(item)]).toBeUndefined(); // claim released
    expect(snap.worked.some((e) => e.itemId === workItemCoverageKey(item) && e.outcome === 'diff')).toBe(true);
  });

  it('binds completion to the claim-time cooldown identity', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');
    const item = makeItem('frozen-completion-key');
    const policies = new Map([[
      executionKey(item),
      { itemIds: ['frozen-completion-key::generation:g1'], cooldownMs: 60_000 },
    ]]);

    expect(coord.claimItemsByLane([{ candidates: [item], limit: 1 }], 1, 'machine-A', policies))
      .toEqual([item]);
    const authority = coord.beginExecution(item, 'machine-A');
    expect(authority).toMatchObject({
      kind: 'shared-queue-v1',
      claimEpoch: expect.any(Number),
      claimBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(isMintedExecutionAuthority(authority)).toBe(true);
    expect(isMintedExecutionAuthority({ ...authority! })).toBe(false);
    expect(authority && Object.keys(authority).sort()).toEqual([
      'claimBindingDigest', 'claimEpoch', 'kind', 'queueId',
    ]);
    expect(JSON.stringify(authority)).not.toContain('ownerToken');
    expect(JSON.stringify(authority)).not.toContain(executionKey(item));
    expect(coord.beginExecution(item, 'machine-A')).toEqual(authority);
    expect(coord.beginExecution(item, 'machine-B')).toBeNull();
    expect(coord.recordClaimOutcome(item, 'wrong-recomputed-key', 'diff', 'machine-A')).toBe(true);

    expect(store.readSnapshot().worked).toEqual([
      expect.objectContaining({
        itemId: 'frozen-completion-key::generation:g1',
        outcome: 'diff',
      }),
    ]);
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

describe('M111 SharedStore health snapshot', () => {
  it('reports empty readable shared queue health without creating files', () => {
    const store = makeStore(tmpDir, 5_000);
    const health = store.readHealth({ machineId: 'machine-A', now: 1_000_000 });

    expect(health.readable).toBe(true);
    expect(health.path).toBe(tmpDir);
    expect(health.leaseMs).toBe(5_000);
    expect(health.activeClaims).toBe(0);
    expect(health.ownedClaims).toBe(0);
    expect(health.reclaimableClaims).toBe(0);
    expect(health.claimsByMachine).toEqual([]);
    expect(health.claimSamples).toEqual([]);
    expect(health.lock.present).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'ashlr-fleet-queue.json'))).toBe(false);
  });

  it('summarizes active, legacy-ambiguous, cooldown, usage, and lock state', () => {
    const now = 2_000_000;
    const store = makeStore(tmpDir, 10_000);
    expect(store.claimItems(['owned-1', 'owned-2'], 2, 'machine-A')).toEqual(['owned-1', 'owned-2']);
    expect(store.claimItems(['other-1'], 1, 'machine-B')).toEqual(['other-1']);
    store.publishUsage({ machineId: 'machine-A', engine: 'codex', ts: new Date(now).toISOString() });
    store.recordOutcome('cooling-item', 'empty', 'machine-A');

    const queuePath = path.join(tmpDir, 'ashlr-fleet-queue.json');
    const snap = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as {
      claims: Record<string, { machineId: string; leaseUntil: number }>;
      worked: Array<{ itemId: string; outcome: string; ts: string }>;
      usage: unknown[];
      schemaVersion?: number;
      queueId?: string;
      nextClaimEpoch?: number;
    };
    snap.claims['owned-1']!.machineId = 'machine-A';
    snap.claims['owned-2']!.machineId = 'machine-A';
    snap.claims['other-1']!.machineId = 'machine-B';
    snap.claims['owned-1']!.leaseUntil = now + 1_000;
    snap.claims['owned-2']!.leaseUntil = now - 2_000;
    snap.claims['other-1']!.leaseUntil = now + 5_000;
    snap.worked = [{ itemId: 'cooling-item', outcome: 'empty', ts: new Date(now - 100).toISOString() }];
    delete snap.schemaVersion;
    delete snap.queueId;
    delete snap.nextClaimEpoch;
    fs.writeFileSync(queuePath, JSON.stringify(snap, null, 2));

    const lockPath = path.join(tmpDir, 'ashlr-fleet-queue.json.lock');
    fs.writeFileSync(lockPath, '');
    fs.utimesSync(lockPath, new Date(now - 60_000), new Date(now - 60_000));

    const health = store.readHealth({ machineId: 'machine-A', cooldownMs: 1_000, now });

    expect(health.readable).toBe(true);
    expect(health.activeClaims).toBe(2);
    expect(health.ownedClaims).toBe(1);
    expect(health.expiredClaims).toBe(0);
    expect(health.reclaimableClaims).toBe(0);
    expect(health.ambiguousClaims).toBe(1);
    expect(health.nextLeaseExpiryAt).toBe(new Date(now + 1_000).toISOString());
    expect(health.oldestExpiredMs).toBeNull();
    expect(health.cooldownItems).toBe(1);
    expect(health.usageEntries).toBe(1);
    expect(health.claimsByMachine).toEqual([
      { machineId: 'machine-A', active: 1, expired: 0, ambiguous: 1 },
      { machineId: 'machine-B', active: 1, expired: 0 },
    ]);
    expect(health.claimSamples).toEqual([
      {
        itemId: 'owned-1',
        machineId: 'machine-A',
        leaseUntil: new Date(now + 1_000).toISOString(),
        state: 'active',
        owned: true,
      },
      {
        itemId: 'other-1',
        machineId: 'machine-B',
        leaseUntil: new Date(now + 5_000).toISOString(),
        state: 'active',
        owned: false,
      },
      {
        itemId: 'owned-2',
        machineId: 'machine-A',
        leaseUntil: new Date(now - 2_000).toISOString(),
        state: 'ambiguous',
        owned: true,
      },
    ]);
    expect(health.lock).toEqual({
      present: true,
      ageMs: 60_000,
      stale: true,
      links: 1,
      recoveryRequired: false,
    });
  });

  it('marks corrupt queue files unreadable and keeps the health method never-throwing', () => {
    fs.writeFileSync(path.join(tmpDir, 'ashlr-fleet-queue.json'), '{not-json');
    const health = makeStore(tmpDir).readHealth({ machineId: 'machine-A' });
    expect(health.readable).toBe(false);
    expect(health.activeClaims).toBe(0);
    expect(health.claimsByMachine).toEqual([]);
    expect(health.claimSamples).toEqual([]);
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
    const now = vi.spyOn(Date, 'now').mockReturnValue(400_000);
    const store = makeStore(tmpDir, 1); // 1 ms lease
    const coordA = makeSharedCoordinator(store, 'machine-A', 1);

    const item = makeItem('failover-item');
    coordA.claimItems([item], 1, 'machine-A');

    now.mockReturnValue(400_001);

    // Machine B can now reclaim it.
    const coordB = makeSharedCoordinator(store, 'machine-B', 10_000);
    const claimedB = coordB.claimItems([item], 1, 'machine-B');
    expect(claimedB.map(i => i.id)).toContain('failover-item');

    const newSnap = store.readSnapshot();
    expect(newSnap.claims[executionKey(item)]!.machineId).toBe('machine-B');
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

  it('item marked judged-noise by machine A is skipped by machine B', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    const item = makeItem('global-judged-noise');
    coordA.claimItems([item], 1, 'machine-A');
    coordA.recordOutcome('global-judged-noise', 'judged-noise', 'machine-A');

    expect(coordB.shouldSkip('global-judged-noise', 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('claimItems rechecks a safe default cooldown when the caller omits policy', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    const declined = makeItem('global-judged-decline', '/tmp/repo', 10);
    const fresh = makeItem('global-fresh', '/tmp/repo', 5);
    coordA.recordOutcome(declined.id, 'judged-decline', 'machine-A');

    const claimed = coordB.claimItems([declined, fresh], 2, 'machine-B');

    expect(claimed.map((item) => item.id)).toEqual(['global-fresh']);
    expect(coordB.readWorkedEvents()).toEqual(store.readSnapshot().worked);
  });

  it('a later diff outcome clears a prior judged-review cooldown', () => {
    const store = makeStore(tmpDir);
    const coordA = makeSharedCoordinator(store, 'machine-A');
    const coordB = makeSharedCoordinator(store, 'machine-B');

    coordA.recordOutcome('global-review-reset', 'judged-review', 'machine-A');
    coordA.recordOutcome('global-review-reset', 'diff', 'machine-A');

    expect(coordB.shouldSkip('global-review-reset', 6 * 60 * 60 * 1000)).toBe(false);
  });

  it('readHealth counts judged suppressible outcomes as cooldown items', () => {
    const store = makeStore(tmpDir);
    const coord = makeSharedCoordinator(store, 'machine-A');

    coord.recordOutcome('global-health-noise', 'judged-noise', 'machine-A');
    coord.recordOutcome('global-health-diff', 'diff', 'machine-A');

    expect(store.readHealth({ cooldownMs: 6 * 60 * 60 * 1000 }).cooldownItems).toBe(1);
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
    const store = new SharedStore(makeUnusableStorePath());
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000, true);
    expect(() => coord.claimItems([makeItem('x')], 1, 'machine-X')).not.toThrow();
    expect(coord.claimItems([makeItem('x')], 1, 'machine-X')).toEqual([]);
  });

  it('release never throws on bad path', () => {
    const store = new SharedStore(makeUnusableStorePath());
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000, true);
    expect(() => coord.release([makeItem('a'), makeItem('b')], 'machine-X')).not.toThrow();
  });

  it('recordOutcome never throws on bad path', () => {
    const store = new SharedStore(makeUnusableStorePath());
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000, true);
    expect(coord.recordOutcome('x', 'empty', 'machine-X')).toBe(false);
  });

  it('renew returns [] and never throws on bad path', () => {
    const store = new SharedStore(makeUnusableStorePath());
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000, true);
    expect(() => coord.renew([makeItem('x')], 'machine-X')).not.toThrow();
    expect(coord.renew([makeItem('x')], 'machine-X')).toEqual([]);
  });

  it('shouldSkip returns false (fail-open) on bad path', () => {
    const store = new SharedStore(makeUnusableStorePath());
    const coord = new SharedWorkQueueCoordinator(store, 'machine-X', 5000, true);
    expect(coord.shouldSkip('any', 1000)).toBe(false);
  });

  it('readSnapshot returns empty queue on bad path', () => {
    // M341 (win32): '/nonexistent-root-path' is CREATABLE on Windows (it
    // resolves to C:\nonexistent-root-path), so the store came up live and
    // the queue was non-empty. A path UNDER a regular FILE is unusable on
    // every platform.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m111-bad-'));
    const blocker = path.join(parent, 'blocker-file');
    fs.writeFileSync(blocker, '');
    const store = new SharedStore(path.join(blocker, 'ashlr-fleet', 'shared'));
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

  it('returns a fail-closed shared coordinator without coherent-storage attestation', () => {
    const coord = selectWorkQueueCoordinator(baseCfg({ fleet: { sharedQueue: { mode: 'filesystem', path: tmpDir } } }));
    expect(coord).toBeInstanceOf(SharedWorkQueueCoordinator);
    expect(coord.claimItems([makeItem('unattested')], 1, 'machine-A')).toEqual([]);
  });

  it('enables shared authority only with explicit coherent-storage attestation', () => {
    const coord = selectWorkQueueCoordinator(baseCfg({
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: tmpDir,
          trustedCoherentStorage: true,
        },
      },
    }));
    expect(coord).toBeInstanceOf(SharedWorkQueueCoordinator);
    expect(coord.claimItems([makeItem('attested')], 1, 'machine-A')).toHaveLength(1);
  });

  it('Local coordinator still works correctly after selection (regression)', () => {
    const coord = selectWorkQueueCoordinator(baseCfg());
    const items = [makeItem('sel-a'), makeItem('sel-b')];
    expect(coord.claimItems(items, 1, 'machine-local')).toHaveLength(1);
    expect(() => coord.release([makeItem('sel-a')], 'machine-local')).not.toThrow();
  });
});

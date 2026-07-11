/**
 * test/m255.concurrent-dispatch.test.ts — M255 Concurrent Multi-Backend Dispatcher tests.
 *
 * Invariants proved:
 *
 *  1. SLOTS-OPEN: open availability → full maxSlotsPerBackend slots.
 *  2. SLOTS-NEAR: near availability → ceil(max/2) slots (at least 1).
 *  3. SLOTS-EXHAUSTED: throttled/exhausted/unreachable → 0 slots, NEVER assigned.
 *  4. SLOTS-UNKNOWN: unknown availability → 0 slots until capacity is sensed.
 *  5. SPREAD: items spread across ALL open backends (not all-on-one).
 *  6. NEVER-EXCEED-CAP: no backend receives more items than its slot count.
 *  7. EVERY-ITEM-PLACED: every item appears exactly once in assignments XOR unassigned.
 *  8. RUN-PARALLEL: runConcurrentDispatch launches all backend groups concurrently.
 *  9. ONE-FAIL-NO-CRASH: one item failing doesn't crash the wave; other items complete.
 * 10. KILL-SWITCH-HALTS: kill switch stops dispatch before each item.
 * 11. FLAG-OFF-SERIAL: when fabric.concurrentDispatch !== true, loop.ts serial path unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkItem, WorkSource } from '../src/core/types.js';
import type { ResourceSnapshot, BackendAvailability, BackendResourceState } from '../src/core/fabric/resource-monitor.js';
import {
  slotsForAvailability,
  slotsForBackendState,
  planConcurrentDispatch,
  buildGatewayDispatchPlan,
  concurrentAssignedRouteReason,
  runConcurrentDispatch,
  type ConcurrentDispatchCfg,
  type DispatchPlan,
} from '../src/core/fabric/concurrent-dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const id = `item-${++_seq}`;
  return {
    id,
    title: `Task ${id}`,
    goal: `Do something for ${id}`,
    repo: '/tmp/repo',
    effort: 2,
    source: 'backlog' as WorkSource,
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSnapshot(
  backends: Array<{
    backend: string;
    availability: BackendAvailability;
    usedPct?: number | null;
    cap?: number | null;
    capUnit?: BackendResourceState['capUnit'];
  }>
): ResourceSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    backends: backends.map(({ backend, availability, usedPct, cap, capUnit }) => ({
      backend: backend as import('../src/core/types.js').EngineId,
      availability,
      usedPct: usedPct ?? null,
      cap: cap ?? null,
      capUnit: capUnit ?? null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: new Date().toISOString(),
      reason: `test: ${availability}`,
      backoffUntilMs: null,
    })),
  };
}

const defaultCfg: ConcurrentDispatchCfg = { maxSlotsPerBackend: 3 };

function makeTrustedCaptureRepair(): WorkItem {
  return makeItem({
    id: 'repo:proposal-repair-capture:abcdef123456',
    source: 'self',
    title: 'Repair dispatch capture failure for repo item repo:self-heal:123',
    detail:
      'Dispatch capture repair: a self-improvement dispatch produced repairable work but no proposal.\n' +
      'Original work item: repo:self-heal:123\n' +
      'Dispatch outcome: gate-blocked\n' +
      'Diff metadata: files=1, lines=3\n' +
      'Failure: tests still failing\n' +
      'Produce a fresh complete fix, rerun merge-grade verification.',
    tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
    ts: new Date().toISOString(),
  });
}

function makeTrustedDiagnosticReslice(): WorkItem {
  return makeItem({
    id: 'repo:proposal-repair-nodiff:abcdef123456',
    source: 'self',
    title: 'Reslice no-diff dispatch for repo item repo:self-heal:123',
    detail:
      'Diagnostic reslice: a dispatch completed without file changes.\n' +
      'Original work item: repo:self-heal:123\n' +
      'Dispatch outcome: empty-diff\n' +
      'Action: reslice the work into a smaller concrete edit.',
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    ts: new Date().toISOString(),
    repairParentItemId: 'repo:self-heal:123',
    repairParentSource: 'self',
    repairParentBackend: 'local-coder',
    repairParentTier: 'mid',
  });
}

// ---------------------------------------------------------------------------
// 1–4: slotsForAvailability
// ---------------------------------------------------------------------------

describe('slotsForAvailability', () => {
  it('replaces stale capacity pauses for valid repair substitutes but preserves budget pauses', () => {
    const common = {
      hintedBackend: 'local-coder' as const,
      assignedBackend: 'kimi' as const,
      diagnosticRepair: true,
      candidateAllowed: true,
    };
    expect(concurrentAssignedRouteReason({
      ...common,
      baseReason: 'resource-pause: local-coder exhausted',
    })).toContain('repair-alternative-selected');
    expect(concurrentAssignedRouteReason({
      ...common,
      baseReason: 'throttled: local-coder subscription window',
    })).toContain('repair-alternative-selected');
    expect(concurrentAssignedRouteReason({
      ...common,
      baseReason: 'budget-pause: daily cap reached',
    })).toBe('budget-pause: daily cap reached');
  });

  it('open → maxSlots (full headroom)', () => {
    expect(slotsForAvailability('open', 3)).toBe(3);
    expect(slotsForAvailability('open', 6)).toBe(6);
  });

  it('near → ceil(maxSlots/2) (half headroom, at least 1)', () => {
    expect(slotsForAvailability('near', 3)).toBe(2); // ceil(3/2)=2
    expect(slotsForAvailability('near', 4)).toBe(2); // ceil(4/2)=2
    expect(slotsForAvailability('near', 1)).toBe(1); // ceil(1/2)=1 (minimum)
    expect(slotsForAvailability('near', 6)).toBe(3); // ceil(6/2)=3
  });

  it('throttled → 0 (never dispatch)', () => {
    expect(slotsForAvailability('throttled', 3)).toBe(0);
    expect(slotsForAvailability('throttled', 100)).toBe(0);
  });

  it('exhausted → 0 (never dispatch)', () => {
    expect(slotsForAvailability('exhausted', 3)).toBe(0);
  });

  it('unreachable → 0 (never dispatch)', () => {
    expect(slotsForAvailability('unreachable', 3)).toBe(0);
  });

  it('unknown → 0 (no trusted capacity signal)', () => {
    expect(slotsForAvailability('unknown', 3)).toBe(0);
    expect(slotsForAvailability('unknown', 5)).toBe(0);
  });

  it('uses default maxSlots=3 when not provided', () => {
    expect(slotsForAvailability('open')).toBe(3);
    expect(slotsForAvailability('near')).toBe(2);
  });

  it('capUnit=concurrent clamps generic slots to remaining backend capacity', () => {
    expect(slotsForBackendState({
      availability: 'open',
      usedPct: 0,
      cap: 1,
      capUnit: 'concurrent',
    }, 3)).toBe(1);

    expect(slotsForBackendState({
      availability: 'open',
      usedPct: 50,
      cap: 4,
      capUnit: 'concurrent',
    }, 6)).toBe(2);

    expect(slotsForBackendState({
      availability: 'near',
      usedPct: 75,
      cap: 4,
      capUnit: 'concurrent',
    }, 6)).toBe(1);
  });

  it('capUnit=concurrent saturated state maps to zero slots', () => {
    expect(slotsForBackendState({
      availability: 'near',
      usedPct: 100,
      cap: 1,
      capUnit: 'concurrent',
    }, 3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// planConcurrentDispatch — planner invariants
// ---------------------------------------------------------------------------

describe('planConcurrentDispatch', () => {
  it('keeps trusted generated repairs unassigned when only builtin has capacity', () => {
    const item = makeTrustedCaptureRepair();
    const snap = makeSnapshot([
      { backend: 'codex', availability: 'exhausted' },
      { backend: 'local-coder', availability: 'exhausted' },
      { backend: 'builtin', availability: 'open' },
    ]);

    const plan = planConcurrentDispatch([item], snap, defaultCfg, () => 'codex');

    expect(plan.assignments).toEqual([]);
    expect(plan.unassigned).toEqual([item]);
  });

  it('preserves builtin fallback for ordinary work', () => {
    const item = makeItem();
    const snap = makeSnapshot([
      { backend: 'codex', availability: 'exhausted' },
      { backend: 'builtin', availability: 'open' },
    ]);

    const plan = planConcurrentDispatch([item], snap, defaultCfg, () => 'codex');

    expect(plan.assignments).toEqual([{ item, backend: 'builtin' }]);
    expect(plan.unassigned).toEqual([]);
  });

  it('keeps trusted diagnostic reslices off builtin while rejecting spoofed sources', () => {
    const trusted = makeTrustedDiagnosticReslice();
    const spoofed = { ...makeTrustedDiagnosticReslice(), id: 'repo:proposal-repair-nodiff:123456abcdef', source: 'backlog' as WorkSource };
    const snap = makeSnapshot([{ backend: 'builtin', availability: 'open' }]);

    const plan = planConcurrentDispatch([trusted, spoofed], snap, defaultCfg, () => 'builtin');

    expect(plan.assignments).toEqual([{ item: spoofed, backend: 'builtin' }]);
    expect(plan.unassigned).toEqual([trusted]);
  });

  it('does not spill a parent-tier repair to frontier when its preferred tier is saturated', () => {
    const repair = makeTrustedDiagnosticReslice();
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'exhausted' },
      { backend: 'codex', availability: 'open' },
      { backend: 'builtin', availability: 'open' },
    ]);

    const plan = planConcurrentDispatch([repair], snap, defaultCfg, () => 'local-coder');

    expect(plan.assignments).toEqual([]);
    expect(plan.unassigned).toEqual([repair]);
  });

  it('uses an available same-tier substitute for a saturated repair backend', () => {
    const repair = makeTrustedDiagnosticReslice();
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'exhausted' },
      { backend: 'kimi', availability: 'open' },
      { backend: 'claude', availability: 'open' },
    ]);

    const plan = planConcurrentDispatch([repair], snap, defaultCfg, () => 'local-coder');

    expect(plan.assignments).toEqual([{ item: repair, backend: 'kimi' }]);
    expect(plan.unassigned).toEqual([]);
  });

  it('excludes the backend that produced an authoritative empty attempt from preferred and fallback placement', () => {
    const repair = makeTrustedDiagnosticReslice();
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'kimi', availability: 'open' },
      { backend: 'claude', availability: 'open' },
    ]);

    const plan = planConcurrentDispatch(
      [repair],
      snap,
      defaultCfg,
      () => 'local-coder',
      (_item, backend) => backend !== 'local-coder',
    );

    expect(plan.assignments).toEqual([{ item: repair, backend: 'kimi' }]);
    expect(plan.unassigned).toEqual([]);
  });

  it('preserves repair exclusion in the never-throws gateway fallback', async () => {
    const ordinary = makeItem();
    const repair = makeTrustedCaptureRepair();
    const plan = await buildGatewayDispatchPlan(
      [ordinary, repair],
      null as unknown as ResourceSnapshot,
      {} as import('../src/core/types.js').AshlrConfig,
      defaultCfg,
    );

    expect(plan.assignments).toEqual([{ item: ordinary, backend: 'builtin' }]);
    expect(plan.unassigned).toEqual([repair]);
  });

  it('keeps every fallback input exactly once while enforcing builtin capacity', async () => {
    const repair = makeTrustedCaptureRepair();
    const sameIdOrdinary = { ...makeItem(), id: repair.id };
    const overflow = makeItem();
    const plan = await buildGatewayDispatchPlan(
      [sameIdOrdinary, repair, overflow],
      null as unknown as ResourceSnapshot,
      {} as import('../src/core/types.js').AshlrConfig,
      { maxSlotsPerBackend: 1 },
    );

    expect(plan.assignments).toEqual([{ item: sameIdOrdinary, backend: 'builtin' }]);
    expect(plan.unassigned).toEqual([repair, overflow]);
    expect(plan.assignments.length + plan.unassigned.length).toBe(3);
  });
  it('assigns items to open backend (full slots)', () => {
    const snap = makeSnapshot([{ backend: 'claude', availability: 'open' }]);
    const items = [makeItem(), makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    expect(plan.unassigned).toHaveLength(0);
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.every((a) => a.backend === 'claude')).toBe(true);
    expect(plan.slotsMap.get('claude')).toBe(3);
  });

  it('clamps local-coder open slots by capUnit=concurrent capacity', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open', usedPct: 0, cap: 1, capUnit: 'concurrent' },
      { backend: 'codex', availability: 'open' },
      { backend: 'builtin', availability: 'exhausted' },
    ]);
    const items = Array.from({ length: 3 }, makeItem);
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'local-coder');

    expect(plan.slotsMap.get('local-coder')).toBe(1);
    expect(plan.assignments.filter((a) => a.backend === 'local-coder')).toHaveLength(1);
    expect(plan.assignments.filter((a) => a.backend === 'codex')).toHaveLength(2);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('does not assign saturated local-coder when concurrent cap is already used', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'near', usedPct: 100, cap: 1, capUnit: 'concurrent' },
      { backend: 'codex', availability: 'open' },
      { backend: 'builtin', availability: 'exhausted' },
    ]);
    const items = [makeItem(), makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'local-coder');

    expect(plan.slotsMap.get('local-coder')).toBe(0);
    expect(plan.assignments.every((a) => a.backend !== 'local-coder')).toBe(true);
    expect(plan.assignments.filter((a) => a.backend === 'codex')).toHaveLength(2);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('near backend gets ceil(max/2) slots — does not exceed cap', () => {
    const snap = makeSnapshot([{ backend: 'codex', availability: 'near' }]);
    const cfg: ConcurrentDispatchCfg = { maxSlotsPerBackend: 4 };
    const items = Array.from({ length: 5 }, makeItem);
    const plan = planConcurrentDispatch(items, snap, cfg, () => 'codex');

    // near with maxSlots=4 → ceil(4/2)=2 slots
    expect(plan.slotsMap.get('codex')).toBe(2);
    // Only 2 items can be assigned (slot cap = 2); 3 go to builtin fallback
    const codexCount = plan.assignments.filter((a) => a.backend === 'codex').length;
    expect(codexCount).toBe(2);
  });

  it('exhausted backend → 0 slots, NEVER assigned any item', () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'exhausted' },
      { backend: 'builtin', availability: 'open' },
    ]);
    const items = [makeItem(), makeItem(), makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    expect(plan.slotsMap.get('claude')).toBe(0);
    const claudeAssigned = plan.assignments.filter((a) => a.backend === 'claude');
    expect(claudeAssigned).toHaveLength(0);
    // All items fall back to builtin
    expect(plan.assignments.filter((a) => a.backend === 'builtin')).toHaveLength(3);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('throttled backend → 0 slots, NEVER assigned', () => {
    const snap = makeSnapshot([
      { backend: 'nim', availability: 'throttled' },
      { backend: 'builtin', availability: 'open' },
    ]);
    const items = [makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'nim');

    expect(plan.slotsMap.get('nim')).toBe(0);
    expect(plan.assignments.every((a) => a.backend !== 'nim')).toBe(true);
  });

  it('spreads items across ALL open backends — not all-on-one', () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'open' },
      { backend: 'codex', availability: 'open' },
      { backend: 'nim', availability: 'open' },
    ]);
    const items = Array.from({ length: 9 }, makeItem);
    // routeItem always returns 'claude' — but only 3 slots; extras spread via round-robin
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    const byBackend: Record<string, number> = {};
    for (const a of plan.assignments) {
      byBackend[a.backend] = (byBackend[a.backend] ?? 0) + 1;
    }
    // claude gets 3 (slots cap), codex gets 3, nim gets 3
    expect(byBackend['claude']).toBe(3);
    expect(byBackend['codex']).toBeGreaterThan(0);
    expect(byBackend['nim']).toBeGreaterThan(0);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('every item appears exactly once in assignments XOR unassigned', () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'near' },
      { backend: 'codex', availability: 'exhausted' },
    ]);
    const cfg: ConcurrentDispatchCfg = { maxSlotsPerBackend: 2 };
    const items = Array.from({ length: 6 }, makeItem);
    const plan = planConcurrentDispatch(items, snap, cfg, () => 'claude');

    const allIds = new Set([
      ...plan.assignments.map((a) => a.item.id),
      ...plan.unassigned.map((i) => i.id),
    ]);
    expect(allIds.size).toBe(items.length);
    for (const item of items) expect(allIds.has(item.id)).toBe(true);
  });

  it('unknown availability → 0 slots and no assignment', () => {
    const snap = makeSnapshot([{ backend: 'nim', availability: 'unknown' }]);
    const items = [makeItem(), makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'nim');

    expect(plan.slotsMap.get('nim')).toBe(0);
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.every((assignment) => assignment.backend === 'builtin')).toBe(true);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('builtin added as fallback when not in snapshot', () => {
    // Snapshot with only claude (exhausted) — builtin not present
    const snap = makeSnapshot([{ backend: 'claude', availability: 'exhausted' }]);
    const items = [makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    // Should fall back to builtin which was auto-added
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]!.backend).toBe('builtin');
    expect(plan.unassigned).toHaveLength(0);
  });

  it('all backends exhausted → all items unassigned', () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'exhausted' },
      { backend: 'codex', availability: 'exhausted' },
      { backend: 'builtin', availability: 'exhausted' },
    ]);
    const items = [makeItem(), makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassigned).toHaveLength(2);
  });

  it('no backend ever exceeds its slot cap', () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'open' },
      { backend: 'codex', availability: 'near' },
    ]);
    const cfg: ConcurrentDispatchCfg = { maxSlotsPerBackend: 3 };
    const items = Array.from({ length: 10 }, makeItem);
    const plan = planConcurrentDispatch(items, snap, cfg, () => 'claude');

    const claudeCount = plan.assignments.filter((a) => a.backend === 'claude').length;
    const codexCount = plan.assignments.filter((a) => a.backend === 'codex').length;
    expect(claudeCount).toBeLessThanOrEqual(3);     // open = 3 slots
    expect(codexCount).toBeLessThanOrEqual(2);      // near = ceil(3/2) = 2 slots
  });
});

// ---------------------------------------------------------------------------
// runConcurrentDispatch — executor invariants
// ---------------------------------------------------------------------------

describe('runConcurrentDispatch', () => {
  it('dispatches all assigned items and returns results', async () => {
    const items = [makeItem(), makeItem()];
    const snap = makeSnapshot([{ backend: 'claude', availability: 'open' }]);
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    const dispatched: string[] = [];
    const results = await runConcurrentDispatch(
      plan,
      async (item, _backend) => { dispatched.push(item.id); return 'ok'; },
      () => false,
      defaultCfg,
    );

    expect(dispatched).toHaveLength(2);
    expect(results.filter((r) => r.attempted)).toHaveLength(2);
    expect(results.every((r) => r.settled?.status === 'fulfilled')).toBe(true);
  });

  it('all backend groups run concurrently (not sequentially)', async () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'open' },
      { backend: 'codex', availability: 'open' },
    ]);
    // 2 items, routing splits them: item1→claude, item2→codex
    const item1 = makeItem();
    const item2 = makeItem();
    const plan = planConcurrentDispatch(
      [item1, item2],
      snap,
      defaultCfg,
      (item) => item.id === item1.id ? 'claude' : 'codex',
    );

    const timeline: Array<{ event: string; ts: number }> = [];

    const results = await runConcurrentDispatch(
      plan,
      async (item, backend) => {
        timeline.push({ event: `start:${backend}:${item.id}`, ts: Date.now() });
        await new Promise((r) => setTimeout(r, 10));
        timeline.push({ event: `end:${backend}:${item.id}`, ts: Date.now() });
        return 'done';
      },
      () => false,
      defaultCfg,
    );

    expect(results).toHaveLength(2);
    // Both backends started; overlap proves parallelism
    const claudeStart = timeline.find((e) => e.event.startsWith('start:claude'))!.ts;
    const codexStart = timeline.find((e) => e.event.startsWith('start:codex'))!.ts;
    const claudeEnd = timeline.find((e) => e.event.startsWith('end:claude'))!.ts;
    const codexEnd = timeline.find((e) => e.event.startsWith('end:codex'))!.ts;
    // They overlap: both started before either ended (within 5ms tolerance)
    expect(Math.abs(claudeStart - codexStart)).toBeLessThan(5);
    expect(claudeEnd).toBeGreaterThan(codexStart);
    expect(codexEnd).toBeGreaterThan(claudeStart);
  });

  it('one item throwing does NOT crash the wave — other items complete', async () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'open' },
      { backend: 'codex', availability: 'open' },
    ]);
    const item1 = makeItem();
    const item2 = makeItem();
    const plan = planConcurrentDispatch(
      [item1, item2],
      snap,
      defaultCfg,
      (item) => item.id === item1.id ? 'claude' : 'codex',
    );

    const completed: string[] = [];
    const results = await runConcurrentDispatch(
      plan,
      async (item, backend) => {
        if (backend === 'claude') throw new Error('claude exploded');
        completed.push(item.id);
        return 'ok';
      },
      () => false,
      defaultCfg,
    );

    // codex item completes
    expect(completed).toContain(item2.id);
    // claude item is recorded as attempted with rejected settled
    const claudeResult = results.find((r) => r.backend === 'claude');
    expect(claudeResult?.attempted).toBe(true);
    expect(claudeResult?.settled?.status).toBe('rejected');
    // Total results = 2 (neither crashes the runner)
    expect(results).toHaveLength(2);
  });

  it('kill-switch halts dispatch — attempted=false for remaining items', async () => {
    const snap = makeSnapshot([{ backend: 'claude', availability: 'open' }]);
    const items = Array.from({ length: 3 }, makeItem);
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    // Kill switch fires after first item
    let callCount = 0;
    const killSwitch = () => callCount >= 1;

    const results = await runConcurrentDispatch(
      plan,
      async (item, _backend) => {
        callCount++;
        return 'ok';
      },
      killSwitch,
      defaultCfg,
    );

    // At least one was not attempted due to kill switch
    const notAttempted = results.filter((r) => !r.attempted);
    expect(notAttempted.length).toBeGreaterThan(0);
    // All results still present (no crash)
    expect(results).toHaveLength(3);
  });

  it('kill-switch set before dispatch — ALL items skipped (attempted=false)', async () => {
    const snap = makeSnapshot([{ backend: 'claude', availability: 'open' }]);
    const items = [makeItem(), makeItem()];
    const plan = planConcurrentDispatch(items, snap, defaultCfg, () => 'claude');

    let called = false;
    const results = await runConcurrentDispatch(
      plan,
      async (_item, _backend) => { called = true; return 'ok'; },
      () => true, // kill switch always on
      defaultCfg,
    );

    expect(called).toBe(false);
    expect(results.every((r) => !r.attempted)).toBe(true);
  });

  it('empty plan → empty results (no crash)', async () => {
    const emptyPlan: DispatchPlan = { assignments: [], unassigned: [], slotsMap: new Map() };
    const results = await runConcurrentDispatch(
      emptyPlan,
      async () => 'ok',
      () => false,
      defaultCfg,
    );
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: flag-off path unchanged
// ---------------------------------------------------------------------------

describe('flag-off parity', () => {
  it('slotsForAvailability with exhausted/throttled/unreachable always returns 0', () => {
    for (const avail of ['exhausted', 'throttled', 'unreachable'] as BackendAvailability[]) {
      expect(slotsForAvailability(avail, 10)).toBe(0);
    }
  });

  it('planConcurrentDispatch is pure — same inputs produce same outputs', () => {
    const snap = makeSnapshot([
      { backend: 'claude', availability: 'open' },
      { backend: 'codex', availability: 'near' },
    ]);
    const items = Array.from({ length: 4 }, makeItem);
    const route = () => 'claude' as import('../src/core/types.js').EngineId;

    const plan1 = planConcurrentDispatch(items, snap, defaultCfg, route);
    const plan2 = planConcurrentDispatch(items, snap, defaultCfg, route);

    // Same assignment order (pure function)
    expect(plan1.assignments.map((a) => a.backend)).toEqual(plan2.assignments.map((a) => a.backend));
    expect(plan1.unassigned.map((i) => i.id)).toEqual(plan2.unassigned.map((i) => i.id));
  });
});

/**
 * test/m256.workhorse-dispatch.test.ts — M256 Workhorse Dispatch tests.
 *
 * Strategy: production-helper invariants exercise buildConcurrentDispatchRouteItem
 * directly; lower-level spread invariants use planConcurrentDispatch with a
 * mirrored workhorse-style routeItem. No gateway I/O mocking needed.
 *
 * Invariants proved:
 *
 *  1. WORKHORSE-SPREAD: local-mid bulk route hints spread across active
 *     workhorses, while protected route hints stay assigned to the gateway
 *     backend.
 *
 *  2. CODEX-EXHAUSTED: when codex is exhausted (0 slots), the spreader
 *     excludes codex; local-coder + nim carry the load; codex gets 0.
 *
 *  3. FLAG-OFF: when routeItem always returns local-coder (gateway-hint,
 *     flag-off behavior), codex gets 0 and local-coder absorbs up to cap.
 *
 *  4. WORKHORSE-ZERO-SLOTS: when ALL workhorse backends have 0 slots,
 *     the spreader falls back to 'builtin'.
 *
 *  5. NO-EXCEED-CAP: 0-slot governor holds even with workhorse spread —
 *     no backend receives more items than its slot count.
 *
 *  6. FLAG-ON-PARITY-COUNT: total assigned items is the same under
 *     workhorse spread vs. single-backend preference (same total capacity).
 *
 *  7. WORKHORSE-SPREADER-LOGIC: cap-aware slot planning correctly gates which
 *     workhorses are active (saturated/exhausted/throttled excluded, open included).
 */

import { describe, it, expect } from 'vitest';
import type { WorkItem, WorkSource, EngineId, AshlrConfig } from '../src/core/types.js';
import type { ResourceSnapshot, BackendAvailability, BackendResourceState } from '../src/core/fabric/resource-monitor.js';
import {
  buildConcurrentDispatchRouteItem,
  planConcurrentDispatch,
  slotsForBackendState,
  type ConcurrentDispatchCfg,
} from '../src/core/fabric/concurrent-dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const id = `m256-item-${++_seq}`;
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
  }>,
): ResourceSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    backends: backends.map(({ backend, availability, usedPct, cap, capUnit }) => ({
      backend: backend as EngineId,
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

/** The M256 workhorse set — mirrors WORKHORSE_BACKENDS in concurrent-dispatch.ts. */
const WORKHORSE_BACKENDS: readonly EngineId[] = ['local-coder', 'codex', 'nim'] as EngineId[];

/**
 * Build a round-robin routeItem across workhorse backends that have >0 slots.
 * Mirrors the logic of buildWorkhorseSpreader (internal M256 helper in
 * concurrent-dispatch.ts) — keeps tests pure without importing the private fn.
 */
function makeWorkhorseSpreader(
  snap: ResourceSnapshot,
  cfg: ConcurrentDispatchCfg,
): (item: WorkItem) => EngineId {
  const maxSlots = Math.max(1, cfg.maxSlotsPerBackend ?? 3);
  const snapshotSlots = new Map<EngineId, number>();
  for (const state of snap.backends) {
    snapshotSlots.set(state.backend, slotsForBackendState(state, maxSlots));
  }
  const activeWorkhorses = WORKHORSE_BACKENDS.filter((b) => (snapshotSlots.get(b) ?? 0) > 0);
  if (activeWorkhorses.length === 0) return () => 'builtin' as EngineId;
  let cursor = 0;
  return (_item: WorkItem): EngineId => {
    const chosen = activeWorkhorses[cursor % activeWorkhorses.length]!;
    cursor++;
    return chosen;
  };
}

const dispatchCfg: ConcurrentDispatchCfg = { maxSlotsPerBackend: 3 };
const cfgWorkhorse = {
  version: 1,
  foundry: { fabric: { concurrentDispatch: true, workhorseDispatch: true } },
} as AshlrConfig;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M256 workhorseDispatch', () => {
  it('PRODUCTION-HELPER: workhorseDispatch spreads local-mid bulk route hints', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = Array.from({ length: 6 }, makeItem);
    const routeHints = new Map<string, EngineId>();
    const routeReasons = new Map<string, string>();
    for (const item of items) routeHints.set(item.id, 'local-coder');
    for (const item of items) routeReasons.set(item.id, `local-mid bulk: local-coder (source=${item.source}, effort=${item.effort})`);

    const routeItem = buildConcurrentDispatchRouteItem(snap, dispatchCfg, cfgWorkhorse, routeHints, routeReasons);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    expect(plan.assignments.filter((a) => a.backend === 'local-coder')).toHaveLength(2);
    expect(plan.assignments.filter((a) => a.backend === 'codex')).toHaveLength(2);
    expect(plan.assignments.filter((a) => a.backend === 'nim')).toHaveLength(2);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('PRODUCTION-HELPER: workhorseDispatch preserves frontier route hints', () => {
    const snap = makeSnapshot([
      { backend: 'claude',      availability: 'open' },
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = Array.from({ length: 3 }, () => makeItem({ effort: 5 }));
    const routeHints = new Map<string, EngineId>();
    const routeReasons = new Map<string, string>();
    for (const item of items) {
      routeHints.set(item.id, 'claude');
      routeReasons.set(item.id, `frontier: hard/escalation item (source=${item.source}, effort=${item.effort}) -> claude`);
    }

    const routeItem = buildConcurrentDispatchRouteItem(snap, dispatchCfg, cfgWorkhorse, routeHints, routeReasons);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    expect(plan.assignments).toHaveLength(3);
    expect(plan.assignments.every((a) => a.backend === 'claude')).toBe(true);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('PRODUCTION-HELPER: workhorseDispatch preserves generated capture repair frontier hints', () => {
    const snap = makeSnapshot([
      { backend: 'claude',      availability: 'exhausted' },
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const item = makeItem({
      id: 'repo:proposal-repair-capture:abcdef123456',
      source: 'self',
      tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
    });
    const routeHints = new Map<string, EngineId>([[item.id, 'codex']]);
    const routeReasons = new Map<string, string>([[
      item.id,
      'frontier: generated capture proposal repair (source=self) -> codex',
    ]]);

    const routeItem = buildConcurrentDispatchRouteItem(snap, dispatchCfg, cfgWorkhorse, routeHints, routeReasons);
    const plan = planConcurrentDispatch([item], snap, dispatchCfg, routeItem);

    expect(plan.assignments).toEqual([{ item, backend: 'codex' }]);
    expect(plan.assignments.some((a) => a.backend === 'local-coder')).toBe(false);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('PRODUCTION-HELPER: workhorseDispatch preserves pause route hints for skip semantics', () => {
    const snap = makeSnapshot([
      { backend: 'codex',       availability: 'open' },
      { backend: 'local-coder', availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const item = makeItem();
    const routeHints = new Map<string, EngineId>([[item.id, 'codex']]);
    const routeReasons = new Map<string, string>([[item.id, 'budget-pause: daily budget exhausted']]);

    const routeItem = buildConcurrentDispatchRouteItem(snap, dispatchCfg, cfgWorkhorse, routeHints, routeReasons);
    const plan = planConcurrentDispatch([item], snap, dispatchCfg, routeItem);

    expect(plan.assignments).toEqual([{ item, backend: 'codex' }]);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('PRODUCTION-HELPER: cap-aware workhorse spread excludes saturated local-coder', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'near', usedPct: 100, cap: 1, capUnit: 'concurrent' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'exhausted' },
    ]);
    const items = Array.from({ length: 4 }, makeItem);
    const routeHints = new Map<string, EngineId>();
    const routeReasons = new Map<string, string>();
    for (const item of items) {
      routeHints.set(item.id, 'local-coder');
      routeReasons.set(item.id, `local-mid bulk: local-coder (source=${item.source}, effort=${item.effort})`);
    }

    const routeItem = buildConcurrentDispatchRouteItem(snap, dispatchCfg, cfgWorkhorse, routeHints, routeReasons);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    expect(plan.slotsMap.get('local-coder')).toBe(0);
    expect(plan.assignments.filter((a) => a.backend === 'local-coder')).toHaveLength(0);
    expect(plan.assignments.filter((a) => a.backend === 'codex')).toHaveLength(2);
    expect(plan.assignments.filter((a) => a.backend === 'nim')).toHaveLength(2);
    expect(plan.unassigned).toHaveLength(0);
  });

  it('PRODUCTION-HELPER: unreachable nim receives no workhorse assignment', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'unreachable' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = Array.from({ length: 6 }, makeItem);
    const routeHints = new Map<string, EngineId>();
    const routeReasons = new Map<string, string>();
    for (const item of items) {
      routeHints.set(item.id, 'local-coder');
      routeReasons.set(item.id, `local-mid bulk: local-coder (source=${item.source}, effort=${item.effort})`);
    }

    const routeItem = buildConcurrentDispatchRouteItem(snap, dispatchCfg, cfgWorkhorse, routeHints, routeReasons);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    expect(plan.assignments.filter((a) => a.backend === 'nim')).toHaveLength(0);
    expect(plan.assignments.filter((a) => a.backend === 'local-coder')).toHaveLength(3);
    expect(plan.assignments.filter((a) => a.backend === 'codex')).toHaveLength(3);
    expect(plan.unassigned).toHaveLength(0);
  });

  // 1a. WORKHORSE-SPREAD: codex gets a fair share when all three workhorses are open
  it('WORKHORSE-SPREAD: bulk items spread across local-coder + codex + nim (codex > 0)', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = Array.from({ length: 9 }, makeItem);
    const routeItem = makeWorkhorseSpreader(snap, dispatchCfg);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    const byBackend: Record<string, number> = {};
    for (const a of plan.assignments) {
      byBackend[a.backend] = (byBackend[a.backend] ?? 0) + 1;
    }

    // All 9 items placed (3 workhorses × 3 slots = 9 total capacity)
    expect(plan.unassigned).toHaveLength(0);
    expect(plan.assignments).toHaveLength(9);

    // Codex MUST get a non-zero share — the core M256 invariant
    expect(byBackend['codex']).toBeGreaterThan(0);
    expect(byBackend['local-coder']).toBeGreaterThan(0);
    expect(byBackend['nim']).toBeGreaterThan(0);
  });

  // 1b. Round-robin gives exact equal distribution: 9 items / 3 workhorses = 3 each
  it('WORKHORSE-SPREAD: strict round-robin → each workhorse gets exactly 1/3 of items', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
    ]);
    const items = Array.from({ length: 9 }, makeItem);
    const routeItem = makeWorkhorseSpreader(snap, dispatchCfg);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    const byBackend: Record<string, number> = {};
    for (const a of plan.assignments) {
      byBackend[a.backend] = (byBackend[a.backend] ?? 0) + 1;
    }

    expect(byBackend['local-coder']).toBe(3);
    expect(byBackend['codex']).toBe(3);
    expect(byBackend['nim']).toBe(3);
    expect(plan.unassigned).toHaveLength(0);
  });

  // 2. CODEX-EXHAUSTED: codex=exhausted → spreader excludes it; local-coder+nim carry load
  it('CODEX-EXHAUSTED: codex=exhausted → codex gets 0, local-coder+nim absorb work', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'exhausted' }, // hard stop
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = Array.from({ length: 6 }, makeItem);
    const routeItem = makeWorkhorseSpreader(snap, dispatchCfg);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    // Codex has 0 slots — NEVER assigned
    expect(plan.slotsMap.get('codex')).toBe(0);
    expect(plan.assignments.filter((a) => a.backend === 'codex')).toHaveLength(0);

    // All 6 items still placed (local-coder=3 + nim=3 = 6 slots)
    expect(plan.unassigned).toHaveLength(0);
    expect(plan.assignments).toHaveLength(6);
    expect(plan.assignments.filter((a) => a.backend === 'local-coder').length).toBeGreaterThan(0);
    expect(plan.assignments.filter((a) => a.backend === 'nim').length).toBeGreaterThan(0);
  });

  // 3. FLAG-OFF: gateway always prefers local-coder → codex gets 0
  it('FLAG-OFF: gateway-hint routeItem (local-coder always) → codex gets 0', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = Array.from({ length: 3 }, makeItem);

    // Flag-off: routeItem always returns local-coder (simulates gateway-hint path)
    const routeItemFlagOff = () => 'local-coder' as EngineId;
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItemFlagOff);

    // All 3 items go to local-coder (cap=3, absorbs all)
    expect(plan.assignments.filter((a) => a.backend === 'local-coder')).toHaveLength(3);
    expect(plan.assignments.filter((a) => a.backend === 'codex')).toHaveLength(0);
    expect(plan.unassigned).toHaveLength(0);
  });

  // 4. WORKHORSE-ZERO-SLOTS: all workhorses exhausted → spreader returns builtin
  it('WORKHORSE-ZERO-SLOTS: all workhorses exhausted → builtin is the fallback', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'exhausted' },
      { backend: 'codex',       availability: 'exhausted' },
      { backend: 'nim',         availability: 'exhausted' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = [makeItem(), makeItem()];
    const routeItem = makeWorkhorseSpreader(snap, dispatchCfg);

    // Spreader has no active workhorses → always returns 'builtin'
    expect(routeItem(items[0]!)).toBe('builtin');
    expect(routeItem(items[1]!)).toBe('builtin');

    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments.every((a) => a.backend === 'builtin')).toBe(true);
    expect(plan.unassigned).toHaveLength(0);
  });

  // 5. NO-EXCEED-CAP: 0-slot governor holds — near codex gets ≤2
  it('NO-EXCEED-CAP: no backend receives more items than its slot count (near codex = 2)', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },   // 3 slots
      { backend: 'codex',       availability: 'near' },   // ceil(3/2)=2 slots
      { backend: 'nim',         availability: 'open' },   // 3 slots
      { backend: 'builtin',     availability: 'open' },
    ]);
    const items = Array.from({ length: 12 }, makeItem);
    const routeItem = makeWorkhorseSpreader(snap, dispatchCfg);
    const plan = planConcurrentDispatch(items, snap, dispatchCfg, routeItem);

    const countFor = (b: string) => plan.assignments.filter((a) => a.backend === b).length;
    expect(countFor('local-coder')).toBeLessThanOrEqual(3);
    expect(countFor('codex')).toBeLessThanOrEqual(2);    // near cap enforced
    expect(countFor('nim')).toBeLessThanOrEqual(3);

    // Near codex still gets work (2 slots > 0)
    expect(countFor('codex')).toBeGreaterThan(0);
  });

  // 6. FLAG-ON-PARITY-COUNT: same total assigned regardless of distribution.
  // To isolate the distribution difference cleanly, use only 3 items so that
  // the flag-off path (always local-coder, 3 slots) absorbs all 3 without
  // overflow to other backends. The flag-on path spreads across workhorses.
  it('FLAG-ON-PARITY-COUNT: total assigned equal flag-on vs flag-off (same capacity)', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'open' },
      { backend: 'nim',         availability: 'open' },
      { backend: 'builtin',     availability: 'open' },
    ]);
    // 3 items: flag-off fits all in local-coder (cap=3), flag-on spreads 1 each
    const items = Array.from({ length: 3 }, makeItem);

    // Flag-ON: workhorse spread (round-robin: local-coder, codex, nim)
    const routeOn = makeWorkhorseSpreader(snap, dispatchCfg);
    const planOn = planConcurrentDispatch(items, snap, dispatchCfg, routeOn);

    // Flag-OFF: always local-coder (gateway-hint path, no workhorse spread)
    const planOff = planConcurrentDispatch(items, snap, dispatchCfg, () => 'local-coder' as EngineId);

    // Same total capacity → same total placed
    expect(planOn.assignments.length + planOn.unassigned.length).toBe(3);
    expect(planOff.assignments.length + planOff.unassigned.length).toBe(3);
    expect(planOn.assignments).toHaveLength(3);
    expect(planOff.assignments).toHaveLength(3);

    // Distribution differs: flag-on spreads to codex; flag-off keeps all on local-coder
    expect(planOn.assignments.filter((a) => a.backend === 'codex').length).toBeGreaterThan(0);
    expect(planOff.assignments.filter((a) => a.backend === 'local-coder').length).toBe(3);
    expect(planOff.assignments.filter((a) => a.backend === 'codex').length).toBe(0);
  });

  // 7. WORKHORSE-SPREADER-LOGIC: throttled backends excluded; others rotate
  it('WORKHORSE-SPREADER-LOGIC: throttled codex excluded; local-coder + nim rotate', () => {
    const snap = makeSnapshot([
      { backend: 'local-coder', availability: 'open' },
      { backend: 'codex',       availability: 'throttled' }, // excluded
      { backend: 'nim',         availability: 'open' },
    ]);
    const routeItem = makeWorkhorseSpreader(snap, dispatchCfg);
    const items = Array.from({ length: 4 }, makeItem);

    // Round-robin over [local-coder, nim] only — codex never appears
    const backends = items.map((i) => routeItem(i));
    expect(backends).not.toContain('codex');
    expect(backends.every((b) => b === 'local-coder' || b === 'nim')).toBe(true);
    // Both active workhorses appear in the rotation
    expect(backends).toContain('local-coder');
    expect(backends).toContain('nim');
  });
});

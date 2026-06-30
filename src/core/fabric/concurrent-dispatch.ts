/**
 * src/core/fabric/concurrent-dispatch.ts — M255 Concurrent Multi-Backend Dispatcher
 *
 * Provides pure planning + async execution primitives for running the work queue
 * across ALL backends with headroom simultaneously, rather than one at a time.
 *
 *   slotsForAvailability(avail, maxSlots)
 *     Maps BackendAvailability → concurrent-slot count (the hard governor).
 *     open        → maxSlots          (full headroom, default 3)
 *     near        → ceil(maxSlots/2)  (half headroom, round up)
 *     unknown     → maxSlots          (permissive — treat unknown as open)
 *     throttled   → 0                 (rate-limited — never dispatch)
 *     exhausted   → 0                 (subscription cap hit — never dispatch)
 *     unreachable → 0                 (health failure — never dispatch)
 *
 *   planConcurrentDispatch(items, snapshot, cfg, routeItem)
 *     Pure fn. Assigns WorkItems across eligible backends (round-robin spread).
 *     routeItem(item) injects the per-item routing hint (from gateway.decide or
 *     a plain router); preferred backend gets the item if it has slots, else
 *     falls back to round-robin across all open backends.
 *     Never mutates inputs, never throws.
 *
 *   runConcurrentDispatch(plan, dispatchFn, killSwitchFn, cfg)
 *     Executes a plan: all backends in PARALLEL (Promise.allSettled across
 *     backend groups), within each backend up to slot-cap concurrency.
 *     Kill-switch checked before each item. One backend failing an item never
 *     crashes the wave. Never throws.
 *
 *   buildGatewayDispatchPlan(items, snapshot, cfg, dispatchCfg)
 *     Async production entry point: calls gateway.decide per item to build the
 *     routing hint map, then delegates to planConcurrentDispatch.
 *     Never throws.
 *
 * Safety invariants:
 *   - 0-slot backends NEVER receive items (monitor is the hard governor).
 *   - Kill switch halts before/within each wave item.
 *   - Each item still flows through the full gate in dispatchFn
 *     (judge / scope-cap / sandbox / tests-green / provenance).
 *   - builtin is always available as a fallback — but ONLY if the snapshot
 *     doesn't mark it exhausted/unreachable/throttled (monitor wins).
 *   - Flag-off (fabric.concurrentDispatch !== true) → loop.ts uses the existing
 *     serial/tieredBounded path unchanged; this module is only imported on the
 *     flag-ON path.
 */

import type { EngineId, WorkItem, AshlrConfig } from '../types.js';
import type { BackendAvailability, ResourceSnapshot } from './resource-monitor.js';
import { decide as gatewayDecide } from './gateway.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One resolved assignment: a WorkItem mapped to a specific backend. */
export interface DispatchAssignment {
  item: WorkItem;
  backend: EngineId;
}

/** Plan output: concrete assignments + any items that could not be placed. */
export interface DispatchPlan {
  /** Items assigned to a backend (backend had headroom at plan time). */
  assignments: DispatchAssignment[];
  /** Items that could NOT be assigned (all backends at 0 slots). */
  unassigned: WorkItem[];
  /**
   * Per-backend slot count at plan time (for observability / test assertions).
   * Keyed by backend; includes all backends from the snapshot.
   */
  slotsMap: Map<EngineId, number>;
}

/** Outcome of a single dispatched item. */
export interface DispatchResult {
  item: WorkItem;
  backend: EngineId;
  /** True when dispatchFn was actually called (not halted by kill switch). */
  attempted: boolean;
  /** Settled result from the injected dispatchFn; null when kill-halted. */
  settled: PromiseSettledResult<unknown> | null;
}

/** Minimal cfg shape the dispatcher needs. Matches AshlrConfig.foundry.fabric. */
export interface ConcurrentDispatchCfg {
  /** Default slot cap per backend (default 3). */
  maxSlotsPerBackend?: number;
}

// ---------------------------------------------------------------------------
// slotsForAvailability — the hard governor
// ---------------------------------------------------------------------------

/**
 * Map a BackendAvailability to a concurrent-slot count.
 *
 * This is the SINGLE translation layer between resource-monitor state and
 * the dispatcher's slot budget. 0 = never dispatch to this backend.
 *
 * Mapping (from resource-monitor.ts spec comment, M255):
 *   open        → maxSlots          (full headroom)
 *   near        → ceil(maxSlots/2)  (half headroom, round up — at least 1)
 *   unknown     → maxSlots          (permissive: unknown = treat as open)
 *   throttled   → 0                 (rate-limited — hard stop)
 *   exhausted   → 0                 (subscription cap — hard stop)
 *   unreachable → 0                 (health check failed — hard stop)
 */
export function slotsForAvailability(
  avail: BackendAvailability,
  maxSlots = 3,
): number {
  switch (avail) {
    case 'open':        return maxSlots;
    case 'near':        return Math.max(1, Math.ceil(maxSlots / 2));
    case 'unknown':     return maxSlots;   // permissive — same as open
    case 'throttled':   return 0;
    case 'exhausted':   return 0;
    case 'unreachable': return 0;
    default:            return maxSlots;   // future availability values → permissive
  }
}

// ---------------------------------------------------------------------------
// planConcurrentDispatch — pure planner
// ---------------------------------------------------------------------------

/**
 * Pure planning function. Assigns items across ALL backends that have headroom.
 *
 * Algorithm:
 *  1. Compute slot budgets for every backend in the snapshot via slotsForAvailability.
 *  2. Ensure builtin always appears: if absent from snapshot, add it as open.
 *     If the snapshot marks builtin exhausted/throttled/unreachable, slots = 0
 *     (monitor wins — we do NOT force-open a backend the monitor says is dead).
 *  3. For each item:
 *     a. Call routeItem(item) to get a preferred backend.
 *     b. If that backend has remaining slots, assign there.
 *     c. Otherwise, round-robin across ALL eligible backends (slots > 0).
 *  4. Items with no eligible backend → unassigned.
 *
 * Invariants:
 *   - A backend with 0 slots is NEVER assigned an item.
 *   - No backend is assigned more items than its slot count.
 *   - Every input item appears exactly once in assignments XOR unassigned.
 *   - Pure: does not mutate inputs, does not perform I/O, never throws.
 *
 * @param items      Pending work items to assign.
 * @param snapshot   Current resource snapshot (from getResourceSnapshot).
 * @param cfg        Dispatcher config (maxSlotsPerBackend etc.).
 * @param routeItem  Per-item routing hint. Pure; called synchronously.
 *                   Returns preferred EngineId for the item. May return
 *                   'builtin' as default when no preference is known.
 */
export function planConcurrentDispatch(
  items: WorkItem[],
  snapshot: ResourceSnapshot,
  cfg: ConcurrentDispatchCfg,
  routeItem: (item: WorkItem) => EngineId,
): DispatchPlan {
  const maxSlots = Math.max(1, cfg.maxSlotsPerBackend ?? 3);

  // Build slot budget map from snapshot.
  const slotsMap = new Map<EngineId, number>();
  for (const state of snapshot.backends) {
    slotsMap.set(state.backend, slotsForAvailability(state.availability, maxSlots));
  }

  // Ensure builtin is present as a fallback if not in snapshot.
  // Only add if absent — if the snapshot marks builtin exhausted/throttled,
  // slotsForAvailability will return 0 for it, and it won't get eligible.
  if (!slotsMap.has('builtin')) {
    slotsMap.set('builtin', maxSlots);
  }

  // Eligible backends: stable order from snapshot, then builtin if added.
  const eligibleBackends: EngineId[] = [];
  const seenInSnapshot = new Set<EngineId>();
  for (const state of snapshot.backends) {
    seenInSnapshot.add(state.backend);
    if ((slotsMap.get(state.backend) ?? 0) > 0) {
      eligibleBackends.push(state.backend);
    }
  }
  if (!seenInSnapshot.has('builtin') && (slotsMap.get('builtin') ?? 0) > 0) {
    eligibleBackends.push('builtin');
  }

  // Mutable per-backend remaining-slot counters.
  const remaining = new Map<EngineId, number>(slotsMap);

  const assignments: DispatchAssignment[] = [];
  const unassigned: WorkItem[] = [];

  // Round-robin cursor for spreading across backends.
  let rrCursor = 0;

  for (const item of items) {
    // 1. Try preferred backend first.
    const preferred = routeItem(item);
    const prefRem = remaining.get(preferred) ?? 0;
    if (prefRem > 0) {
      assignments.push({ item, backend: preferred });
      remaining.set(preferred, prefRem - 1);
      continue;
    }

    // 2. Preferred backend has no slots — round-robin across all eligible.
    const n = eligibleBackends.length;
    let placed = false;
    for (let attempt = 0; attempt < n; attempt++) {
      const idx = (rrCursor + attempt) % n;
      const candidate = eligibleBackends[idx]!;
      const rem = remaining.get(candidate) ?? 0;
      if (rem > 0) {
        assignments.push({ item, backend: candidate });
        remaining.set(candidate, rem - 1);
        rrCursor = (idx + 1) % n;
        placed = true;
        break;
      }
    }

    if (!placed) {
      unassigned.push(item);
    }
  }

  return { assignments, unassigned, slotsMap };
}

// ---------------------------------------------------------------------------
// runConcurrentDispatch — async executor
// ---------------------------------------------------------------------------

/**
 * Execute a DispatchPlan with full parallelism across backends.
 *
 * Strategy:
 *  - Group assignments by backend.
 *  - Launch one Promise per backend group; all groups start in PARALLEL.
 *  - Within each backend group, run items with up to slot-cap concurrency
 *    (concurrent waves of slotCount items at a time).
 *  - Kill-switch checked before each wave and before each item.
 *  - Promise.allSettled at the wave level — one backend failure never
 *    crashes other backends.
 *  - dispatchFn is the ONLY I/O seam. Sync throws are caught and recorded
 *    as 'rejected' settled results.
 *  - Never throws itself.
 *
 * @param plan         Output of planConcurrentDispatch.
 * @param dispatchFn   Injected: (item, backend) → Promise<unknown>.
 * @param killSwitchFn Injected kill-switch check: () → boolean.
 * @param cfg          Dispatcher config.
 */
export async function runConcurrentDispatch(
  plan: DispatchPlan,
  dispatchFn: (item: WorkItem, backend: EngineId) => Promise<unknown>,
  killSwitchFn: () => boolean,
  cfg: ConcurrentDispatchCfg,
): Promise<DispatchResult[]> {
  const maxSlots = Math.max(1, cfg.maxSlotsPerBackend ?? 3);

  // Group assignments by backend.
  const byBackend = new Map<EngineId, DispatchAssignment[]>();
  for (const assignment of plan.assignments) {
    let group = byBackend.get(assignment.backend);
    if (!group) {
      group = [];
      byBackend.set(assignment.backend, group);
    }
    group.push(assignment);
  }

  // One async task per backend group — all start concurrently.
  const backendTasks: Array<Promise<DispatchResult[]>> = [];

  for (const [backend, group] of byBackend) {
    // Get slot count from plan's slotsMap (hard governor).
    const slotCount = Math.max(1, plan.slotsMap.get(backend) ?? maxSlots);
    backendTasks.push(runBackendGroup(backend, group, slotCount, dispatchFn, killSwitchFn));
  }

  // All backend groups run in parallel; collect regardless of per-group failures.
  const settled = await Promise.allSettled(backendTasks);

  const results: DispatchResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      results.push(...s.value);
    }
    // Rejected task (shouldn't happen — runBackendGroup never throws):
    // items are lost for this backend but the wave continues.
  }

  return results;
}

/**
 * Run a group of assignments for a single backend with up to `slotCount`
 * concurrent dispatches at a time (wave-based bounded concurrency).
 * Never throws.
 */
async function runBackendGroup(
  backend: EngineId,
  group: DispatchAssignment[],
  slotCount: number,
  dispatchFn: (item: WorkItem, backend: EngineId) => Promise<unknown>,
  killSwitchFn: () => boolean,
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  const concurrency = Math.max(1, slotCount);

  // Process in waves of `concurrency` items.
  for (let waveStart = 0; waveStart < group.length; waveStart += concurrency) {
    // Kill-switch check between waves.
    if (killSwitchFn()) {
      for (let j = waveStart; j < group.length; j++) {
        results.push({ item: group[j]!.item, backend, attempted: false, settled: null });
      }
      break;
    }

    const wave = group.slice(waveStart, waveStart + concurrency);

    // Launch all items in this wave concurrently.
    const wavePromises = wave.map(async (assignment): Promise<DispatchResult> => {
      // Per-item kill-switch check.
      if (killSwitchFn()) {
        return { item: assignment.item, backend, attempted: false, settled: null };
      }
      let settled: PromiseSettledResult<unknown>;
      try {
        const value = await dispatchFn(assignment.item, backend);
        settled = { status: 'fulfilled', value };
      } catch (err) {
        settled = { status: 'rejected', reason: err };
      }
      return { item: assignment.item, backend, attempted: true, settled };
    });

    const waveSettled = await Promise.allSettled(wavePromises);
    for (let wi = 0; wi < waveSettled.length; wi++) {
      const s = waveSettled[wi]!;
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        // Per-item handler never rejects, but if it did:
        results.push({
          item: wave[wi]!.item,
          backend,
          attempted: false,
          settled: { status: 'rejected', reason: s.reason },
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// buildGatewayDispatchPlan — production entry point (async, gateway-integrated)
// ---------------------------------------------------------------------------

/**
 * Build a DispatchPlan using gateway.decide() for per-item routing hints.
 *
 * Production entry point used by daemon/loop.ts on the concurrentDispatch=true
 * path. Runs all gateway decisions in parallel, then delegates to the pure
 * planConcurrentDispatch.
 *
 * Throttled/paused items (reason starts with 'throttled:' / 'budget-pause:' /
 * 'resource-pause:') still get assigned (to whatever backend the gateway
 * returned); dispatchFn is responsible for checking those reason prefixes and
 * skipping actual work. This preserves existing skip semantics.
 *
 * When cfg.foundry.fabric?.gateway !== true, all items route to 'builtin'
 * (same as the flag-off path in loop.ts).
 *
 * Never throws.
 */
export async function buildGatewayDispatchPlan(
  items: WorkItem[],
  snapshot: ResourceSnapshot,
  cfg: AshlrConfig,
  dispatchCfg: ConcurrentDispatchCfg,
): Promise<DispatchPlan> {
  try {
    const routeHints = new Map<string, EngineId>();

    if (cfg.foundry?.fabric?.gateway === true) {
      const decisions = await Promise.allSettled(
        items.map((item) => gatewayDecide(item, cfg, {}))
      );
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const d = decisions[i];
        if (d?.status === 'fulfilled') {
          routeHints.set(item.id, d.value.backend);
        }
        // Error → item gets 'builtin' via fallback below
      }
    }

    const routeItem = (item: WorkItem): EngineId =>
      routeHints.get(item.id) ?? 'builtin';

    return planConcurrentDispatch(items, snapshot, dispatchCfg, routeItem);
  } catch {
    // Never-throws: safe fallback assigns everything to builtin
    const fallbackSlots = Math.max(1, dispatchCfg.maxSlotsPerBackend ?? 3);
    const slotsMap = new Map<EngineId, number>([['builtin', fallbackSlots]]);
    return {
      assignments: items.map((item) => ({ item, backend: 'builtin' as EngineId })),
      unassigned: [],
      slotsMap,
    };
  }
}

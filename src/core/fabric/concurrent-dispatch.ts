/**
 * src/core/fabric/concurrent-dispatch.ts — M255/M256 Concurrent Multi-Backend Dispatcher
 *
 * Provides pure planning + async execution primitives for running the work queue
 * across ALL backends with headroom simultaneously, rather than one at a time.
 *
 *   slotsForAvailability(avail, maxSlots) / slotsForBackendState(state, maxSlots)
 *     Maps BackendAvailability plus backend-specific hard caps to
 *     concurrent-slot count (the hard governor).
 *     open        → maxSlots          (full headroom, default 3)
 *     near        → ceil(maxSlots/2)  (half headroom, round up)
 *     capUnit=concurrent clamps by remaining local concurrency
 *     unknown     → 0                 (no trusted capacity signal)
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
 *     When cfg.foundry.fabric.workhorseDispatch=true (M256), bulk items are
 *     spread evenly across WORKHORSE_BACKENDS (local-coder, codex, nim) that
 *     have headroom, while protected gateway decisions (frontier, throttled,
 *     budget-pause, resource-pause) keep their route hint. Flag-off = today's
 *     gateway-preference behavior.
 *     Never throws.
 *
 * Safety invariants:
 *   - 0-slot backends NEVER receive items (monitor is the hard governor).
 *   - Kill switch halts before/within each wave item.
 *   - Each item still flows through the full gate in dispatchFn
 *     (judge / scope-cap / sandbox / tests-green / provenance).
 *   - builtin is available as a fallback for ordinary work — but ONLY if the
 *     snapshot doesn't mark it exhausted/unreachable/throttled (monitor wins).
 *     Trusted generated repairs require an editing backend and wait unassigned
 *     rather than consuming a planning-only builtin slot.
 *   - Flag-off (fabric.concurrentDispatch !== true) → loop.ts uses the existing
 *     serial/tieredBounded path unchanged; this module is only imported on the
 *     flag-ON path.
 */

import type { EngineId, WorkItem, AshlrConfig } from '../types.js';
import { isTrustedGeneratedRepairItem } from '../fleet/self-heal-trust.js';
import type { BackendAvailability, BackendResourceState, ResourceSnapshot } from './resource-monitor.js';
import { decide as gatewayDecide } from './gateway.js';

// ---------------------------------------------------------------------------
// M256: Workhorse backend set
// ---------------------------------------------------------------------------

/**
 * M256: The backends that carry bulk parallel load when workhorseDispatch=true.
 * Codex is included as a co-equal workhorse alongside local-coder and nim —
 * it is a capable, authed, subscription-based engine that should receive a
 * fair share of bulk dispatch rather than sitting idle.
 *
 * NOTE: This set is ONLY used for the bulk-spread routeItem inside
 * buildGatewayDispatchPlan (concurrentDispatch + workhorseDispatch path).
 * It does NOT change frontier trust, merge authority, or the 0-slot governor.
 * Codex retains full frontier tier for trust/merge decisions.
 */
const WORKHORSE_BACKENDS: readonly EngineId[] = ['local-coder', 'codex', 'nim'] as readonly EngineId[];

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
  /** Items that could not be assigned to an eligible backend. */
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
 *   unknown     → 0                 (no trusted capacity signal)
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
    case 'unknown':     return 0;
    case 'throttled':   return 0;
    case 'exhausted':   return 0;
    case 'unreachable': return 0;
    default:            return 0;
  }
}

/**
 * Map a full backend resource state to concurrent slots.
 *
 * Most backends use availability buckets only. Local engines can report
 * `capUnit:'concurrent'`, where `cap` is the actual hard process/model
 * concurrency and `usedPct` estimates how much of that cap is already occupied.
 * Clamp the generic availability slot budget by that remaining capacity so a
 * local-coder with maxConcurrent=1 cannot receive multiple new assignments.
 */
export function slotsForBackendState(
  state: Pick<BackendResourceState, 'availability' | 'usedPct' | 'cap' | 'capUnit'>,
  maxSlots = 3,
): number {
  const baseSlots = slotsForAvailability(state.availability, maxSlots);
  if (baseSlots <= 0 || state.capUnit !== 'concurrent') {
    return baseSlots;
  }

  if (typeof state.cap !== 'number' || !Number.isFinite(state.cap)) {
    return baseSlots;
  }

  const concurrentCap = Math.max(0, Math.floor(state.cap));
  if (concurrentCap <= 0) {
    return 0;
  }

  let remainingByCap = concurrentCap;
  if (typeof state.usedPct === 'number' && Number.isFinite(state.usedPct)) {
    const usedPct = Math.min(100, Math.max(0, state.usedPct));
    const usedSlots = Math.round((concurrentCap * usedPct) / 100);
    remainingByCap = Math.max(0, concurrentCap - usedSlots);
  }

  return Math.min(baseSlots, remainingByCap);
}

// ---------------------------------------------------------------------------
// planConcurrentDispatch — pure planner
// ---------------------------------------------------------------------------

/**
 * Pure planning function. Assigns items across ALL backends that have headroom.
 *
 * Algorithm:
 *  1. Compute slot budgets for every backend in the snapshot via slotsForBackendState.
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
    slotsMap.set(state.backend, slotsForBackendState(state, maxSlots));
  }

  // Ensure builtin is present as a fallback if not in snapshot.
  // Only add if absent — if the snapshot marks builtin exhausted/throttled,
  // slotsForBackendState will return 0 for it, and it won't get eligible.
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
    const requiresEditingBackend = isTrustedGeneratedRepairItem(item);

    // 1. Try preferred backend first.
    const preferred = routeItem(item);
    const prefRem = remaining.get(preferred) ?? 0;
    if (prefRem > 0 && (!requiresEditingBackend || preferred !== 'builtin')) {
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
      if (requiresEditingBackend && candidate === 'builtin') continue;
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
    const routeReasons = new Map<string, string>();

    if (cfg.foundry?.fabric?.gateway === true) {
      const decisions = await Promise.allSettled(
        items.map((item) => gatewayDecide(item, cfg, {}))
      );
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const d = decisions[i];
        if (d?.status === 'fulfilled') {
          routeHints.set(item.id, d.value.backend);
          routeReasons.set(item.id, d.value.reason);
        }
        // Error → item gets 'builtin' via fallback below
      }
    }

    const routeItem = buildConcurrentDispatchRouteItem(snapshot, dispatchCfg, cfg, routeHints, routeReasons);
    return planConcurrentDispatch(items, snapshot, dispatchCfg, routeItem);
  } catch {
    // Never-throws fallback: ordinary work may use builtin, but trusted
    // generated repairs still wait for a real editing backend.
    const fallbackSlots = Math.max(1, dispatchCfg.maxSlotsPerBackend ?? 3);
    const slotsMap = new Map<EngineId, number>([['builtin', fallbackSlots]]);
    const assignments: DispatchAssignment[] = [];
    const unassigned: WorkItem[] = [];
    for (const item of items) {
      if (isTrustedGeneratedRepairItem(item) || assignments.length >= fallbackSlots) {
        unassigned.push(item);
      } else {
        assignments.push({ item, backend: 'builtin' });
      }
    }
    return {
      assignments,
      unassigned,
      slotsMap,
    };
  }
}

// ---------------------------------------------------------------------------
// M256: buildWorkhorseSpreader — round-robin routeItem across workhorse backends
// ---------------------------------------------------------------------------

/**
 * Build the routeItem function used by concurrent daemon dispatch.
 *
 * M256: workhorse-dispatch path spreads local-mid bulk items evenly across
 * WORKHORSE_BACKENDS (local-coder, codex, nim) that have headroom, while
 * preserving protected gateway route hints such as frontier, throttled,
 * budget-pause, and resource-pause decisions.
 *
 * Gated: only active when concurrentDispatch=true invokes this planner and
 * workhorseDispatch=true. Flag-off returns the gateway/router hint unchanged.
 */
export function buildConcurrentDispatchRouteItem(
  snapshot: ResourceSnapshot,
  dispatchCfg: ConcurrentDispatchCfg,
  cfg: AshlrConfig,
  routeHints: ReadonlyMap<string, EngineId>,
  routeReasons?: ReadonlyMap<string, string>,
): (item: WorkItem) => EngineId {
  if (cfg.foundry?.fabric?.workhorseDispatch === true) {
    const spreadBulkItem = buildWorkhorseSpreader(snapshot, dispatchCfg);
    return (item: WorkItem): EngineId => {
      const hinted = routeHints.get(item.id);
      const reason = routeReasons?.get(item.id);
      if (hinted !== undefined && shouldPreserveWorkhorseRouteHint(hinted, reason)) {
        return hinted;
      }
      return spreadBulkItem(item);
    };
  }
  return (item: WorkItem): EngineId => routeHints.get(item.id) ?? 'builtin';
}

function shouldPreserveWorkhorseRouteHint(hinted: EngineId, reason: string | undefined): boolean {
  const normalized = reason?.trim() ?? '';
  if (
    normalized.startsWith('throttled:') ||
    normalized.startsWith('budget-pause:') ||
    normalized.startsWith('resource-pause:') ||
    normalized.startsWith('frontier:') ||
    normalized.startsWith('frontier-fallback:')
  ) {
    return true;
  }

  if (normalized.startsWith('local-mid bulk:')) {
    return false;
  }

  return !WORKHORSE_BACKENDS.includes(hinted);
}

/**
 * M256: Build a stateful round-robin routeItem function that distributes items
 * across WORKHORSE_BACKENDS that have cap-aware available slots in the current
 * snapshot.
 *
 * Only backends that are BOTH in WORKHORSE_BACKENDS AND have > 0 slots in
 * the snapshot participate. If no workhorse backends have slots, falls back
 * to 'builtin' (same behavior as the flag-off path when all backends are full).
 *
 * The spreader is stateful (round-robin cursor) but deterministic within a
 * single planning call — items cycle through active workhorses in order.
 *
 * Safety: the 0-slot governor in planConcurrentDispatch still holds.
 * Even if this spreader picks a backend that just ran out of slots,
 * planConcurrentDispatch will fall back to round-robin across eligible backends.
 */
function buildWorkhorseSpreader(
  snapshot: ResourceSnapshot,
  cfg: ConcurrentDispatchCfg,
): (item: WorkItem) => EngineId {
  const maxSlots = Math.max(1, cfg.maxSlotsPerBackend ?? 3);

  // Build a slot budget map from the snapshot (same logic as planConcurrentDispatch).
  const snapshotSlots = new Map<EngineId, number>();
  for (const state of snapshot.backends) {
    snapshotSlots.set(state.backend, slotsForBackendState(state, maxSlots));
  }

  // Active workhorses = WORKHORSE_BACKENDS that have > 0 slots.
  const activeWorkhorses: EngineId[] = WORKHORSE_BACKENDS.filter(
    (b) => (snapshotSlots.get(b) ?? 0) > 0,
  );

  // If no workhorses have slots, fall back to builtin.
  if (activeWorkhorses.length === 0) {
    return () => 'builtin';
  }

  // Round-robin cursor (shared state across calls within this planning run).
  let cursor = 0;

  return (_item: WorkItem): EngineId => {
    const chosen = activeWorkhorses[cursor % activeWorkhorses.length]!;
    cursor++;
    return chosen;
  };
}

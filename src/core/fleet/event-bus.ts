/**
 * M241 — Fleet Event Bus.
 *
 * A small typed publish/subscribe bus so lifecycle events (proposal:filed,
 * merge:shipped, regression:detected, goal:done, anomaly) can trigger
 * automation without editing the daemon tick.
 *
 * DESIGN
 *   emit(kind, payload, cfg) — synchronously calls all registered handlers
 *   for `kind`.  Fire-and-forget, best-effort: a handler that throws is
 *   silently swallowed; no handler may affect control flow in the caller.
 *
 *   onFleetEvent(kind, handler) — register a handler.  Returns a deregister
 *   function.  Handlers are called in registration order.
 *
 * GATE
 *   cfg.foundry.eventBus === false  → no handlers fire (byte-identical to
 *   pre-M241 behaviour; default-on when key is absent or true).
 *
 * SAFETY INVARIANTS
 *   - Handlers may only ENQUEUE proposals / goals (proposal-only path).
 *   - NO handler may call merge/push/apply or any destructive primitive.
 *   - The gate at the merge/push path (autoMergeProposal, merge.ts, M47,
 *     kill-switch) is NEVER touched from here.
 *   - emit() never throws regardless of handler behaviour.
 *   - Flag-off (eventBus:false) is byte-identical to pre-M241 — no new
 *     control-flow, no imports triggered.
 *
 * BUILT-IN HANDLERS (registered at module load)
 *   (a) regression:detected  → enqueue a fix work-item goal (proposal-only)
 *   (b) merge:shipped        → record to the worked-ledger + notify (M212)
 *   (c) goal:done            → log + optionally trigger invent-engine for a
 *                              follow-up (flag-gated cfg.foundry.generative)
 *
 * All handlers are additive and individually flag-gated.  None bypass the
 * judge / scope-cap / safety gate or push/merge anything.
 */

import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Event catalogue
// ---------------------------------------------------------------------------

/** All lifecycle event kinds the fleet bus can carry. */
export type FleetBusEventKind =
  | 'proposal:filed'
  | 'merge:shipped'
  | 'regression:detected'
  | 'goal:done'
  | 'anomaly';

/** Per-kind payload shapes. */
export interface FleetBusPayloadMap {
  'proposal:filed': {
    proposalId: string;
    title?: string;
    repo?: string;
    engineTier?: string;
  };
  'merge:shipped': {
    proposalId?: string;
    title?: string;
    repo?: string;
    engineTier?: string;
  };
  'regression:detected': {
    /** Human-readable signal from the sentinel. */
    signal?: string;
    /** Repo directory the regression was observed in. */
    repo?: string;
  };
  'goal:done': {
    goalId: string;
    objective: string;
    repo?: string | null;
  };
  'anomaly': {
    detail?: string;
    source?: string;
  };
}

export type FleetBusPayload<K extends FleetBusEventKind> = FleetBusPayloadMap[K];

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

type AnyHandler = (payload: FleetBusPayloadMap[FleetBusEventKind], cfg: AshlrConfig) => void | Promise<void>;

const _registry = new Map<FleetBusEventKind, Set<AnyHandler>>();

/**
 * Register a handler for `kind`.  Returns a zero-arg deregister function.
 * Calling the deregister function is idempotent.
 */
export function onFleetEvent<K extends FleetBusEventKind>(
  kind: K,
  handler: (payload: FleetBusPayload<K>, cfg: AshlrConfig) => void | Promise<void>,
): () => void {
  let handlers = _registry.get(kind);
  if (!handlers) {
    handlers = new Set();
    _registry.set(kind, handlers);
  }
  handlers.add(handler as AnyHandler);
  return () => {
    _registry.get(kind)?.delete(handler as AnyHandler);
  };
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

/**
 * Emit a fleet lifecycle event.  All registered handlers for `kind` are
 * called synchronously (fire-and-forget async tails are detached).
 *
 * Gate: when cfg.foundry.eventBus === false, no handlers fire and the
 * function returns immediately — byte-identical to pre-M241.
 *
 * Never throws.
 */
export function emit<K extends FleetBusEventKind>(
  kind: K,
  payload: FleetBusPayload<K>,
  cfg: AshlrConfig,
): void {
  try {
    // Gate: flag-off = no-op (default ON when key is absent / true).
    const foundry = cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['eventBus'] === false) return;

    const handlers = _registry.get(kind);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        const result = handler(payload as FleetBusPayloadMap[FleetBusEventKind], cfg);
        // Swallow async tails — never let a rejected promise propagate.
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Handler throws are silently swallowed — fire-and-forget.
      }
    }
  } catch {
    // emit itself must never throw.
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Clear all registered handlers.  For testing only. */
export function _clearHandlers(): void {
  _registry.clear();
}

/** Return a snapshot of handler counts per kind.  For testing only. */
export function _handlerCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [kind, set] of _registry) {
    out[kind] = set.size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in handler (a): regression:detected → enqueue a fix goal/work-item
// ---------------------------------------------------------------------------

/**
 * Returns true when a path looks like an ephemeral Ashlr execution worktree.
 * Sandbox paths follow ~/.ashlr/sandboxes/<id>/worktree; verifier/temp
 * worktrees follow ~/.ashlr/tmp/vwt-*. A goal pointing at either path is
 * meaningless once the worktree is torn down.
 */
function _isEphemeralAshlrPath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  return (
    normalized.includes('/.ashlr/sandboxes/') ||
    /\/\.ashlr\/tmp\/vwt-[^/\s"'`)]*/.test(normalized)
  );
}

/**
 * When a regression is detected, create a new Goal (proposal-only path) to
 * fix it.  The goal goes through the normal planning + approval flow and is
 * NEVER auto-applied.
 *
 * M258/M314: ephemeral-path guard — if payload.repo is a transient Ashlr
 * execution worktree path, the goal is skipped entirely. These paths are
 * ephemeral; a goal pointing at one is garbage after teardown.
 * Dedupe: skips if an identical-objective goal already exists.
 *
 * Flag-gated: runs only when cfg.foundry.eventBus !== false (inherits the
 * bus gate) AND the handler is registered (see registerBuiltInHandlers).
 *
 * SAFETY: createGoal writes only to ~/.ashlr/goals/.  It never applies,
 * merges, pushes, or runs a swarm.  The resulting goal requires the same
 * human-approval flow as any other goal.
 */
async function _handleRegressionDetected(
  payload: FleetBusPayload<'regression:detected'>,
  cfg: AshlrConfig,
): Promise<void> {
  try {
    // M258/M314: translate-or-skip for ephemeral worktree paths.
    // When payload.repo is a transient sandbox path the goal would point at a
    // dead directory after the sandbox is torn down, polluting the goal-planner
    // with self-referential "path not present" noise.  We have no canonical
    // source-repo mapping at this layer, so we skip entirely — a real-repo
    // regression fired from process.cwd() of the live workspace will still
    // enqueue normally.
    const canonicalRepo: string | null =
      payload.repo != null && !_isEphemeralAshlrPath(payload.repo)
        ? payload.repo
        : null;

    if (payload.repo != null && canonicalRepo === null) {
      // Sandbox path detected and no canonical fallback — skip goal creation.
      return;
    }

    const objective =
      `Fix regression${canonicalRepo ? ` in ${canonicalRepo}` : ''}` +
      (payload.signal ? `: ${payload.signal.slice(0, 120)}` : '');

    // M258/M314: guard — never create a goal whose text contains an ephemeral path.
    if (_isEphemeralAshlrPath(objective)) return;

    // M258: dedupe — skip if an identical-objective goal already exists to
    // prevent pile-up when the sentinel fires repeatedly before a fix lands.
    const { createGoal, listGoals } = await import('../goals/store.js');
    const existing = listGoals();
    if (existing.some((g) => g.objective === objective)) return;

    createGoal(objective, { project: canonicalRepo, cfg });
  } catch {
    // Best-effort — never throw from a handler.
  }
}

// ---------------------------------------------------------------------------
// Built-in handler (b): merge:shipped → record to worked-ledger + notify
// ---------------------------------------------------------------------------

/**
 * When a merge ships, record a 'diff' outcome in the worked-ledger for the
 * source item (if a proposalId is present) and fire the M212
 * notifyFleetEvent('merge') notification.
 *
 * SAFETY: recordOutcome and notifyFleetEvent are both fire-and-forget,
 * proposal-only, and never apply/push/merge.
 */
async function _handleMergeShipped(
  payload: FleetBusPayload<'merge:shipped'>,
  cfg: AshlrConfig,
): Promise<void> {
  try {
    // Record to worked-ledger so the originating item is cooled down after a
    // real merge. New proposals carry workItemId; old records fall back to
    // proposalId for backward-compatible continuity.
    if (payload.proposalId) {
      const { recordOutcome } = await import('./worked-ledger.js');
      const { loadProposal } = await import('../inbox/store.js');
      const proposal = loadProposal(payload.proposalId);
      recordOutcome(proposal?.workItemId ?? payload.proposalId, 'diff');
    }
  } catch {
    // Best-effort.
  }
  try {
    // Reuse M212 notification (merge kind).
    const { notifyFleetEvent } = await import('../comms/events.js');
    void notifyFleetEvent(
      'merge',
      {
        repo: payload.repo,
        title: payload.title,
        engine: payload.engineTier,
        proposalId: payload.proposalId,
      },
      cfg,
    ).catch(() => {});
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Built-in handler (c): goal:done → log + optional invent-engine trigger
// ---------------------------------------------------------------------------

/**
 * When a goal is marked done, log it and — when cfg.foundry.generative is
 * enabled — fire a runInventCycle pass so the fleet synthesises follow-up
 * work automatically.
 *
 * SAFETY: runInventCycle only enqueues new work items to the backlog; it
 * never applies, pushes, or merges.  The resulting items require the same
 * swarm-propose-judge-approve flow as any backlog item.
 */
async function _handleGoalDone(
  payload: FleetBusPayload<'goal:done'>,
  cfg: AshlrConfig,
): Promise<void> {
  try {
    console.info(
      `[ashlr] event-bus: goal:done — "${payload.objective}" (${payload.goalId})`,
    );
    const foundry = cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['generative'] === true) {
      const { runInventCycle } = await import('../generative/invent-cycle.js');
      void (runInventCycle(cfg) as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Register built-in handlers (called once at module initialisation)
// ---------------------------------------------------------------------------

/**
 * Register all built-in handlers onto the bus.  Called automatically at
 * module load — callers that import emit() or onFleetEvent() get the
 * built-ins for free without any extra setup.
 *
 * Exported for testing (allows re-registering after _clearHandlers()).
 */
export function registerBuiltInHandlers(): void {
  onFleetEvent('regression:detected', _handleRegressionDetected);
  onFleetEvent('merge:shipped', _handleMergeShipped);
  onFleetEvent('goal:done', _handleGoalDone);
}

// Register at import time.
registerBuiltInHandlers();

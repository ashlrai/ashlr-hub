/**
 * loop.ts — The M24 daemon operator.
 *
 * Exports:
 *  - tick(cfg, opts): one operator cycle — check guards, load backlog, dispatch
 *    sandboxed swarms, create PENDING inbox proposals, record spend + state.
 *  - runDaemon(cfg, opts): loop ticks on an interval (or once); REFUSES when
 *    nested; marks running state; stops on kill switch / budget exhaustion.
 *  - stopDaemon(): set kill switch + clear running state.
 *
 * NON-NEGOTIABLE GUARDRAILS (enforced here, grep-provable):
 *  1. PROPOSAL-FIRST (proposal-only by default): every dispatch produces a
 *     PENDING inbox proposal (via the swarm runner or a sandboxed engine, with
 *     { propose: true }) — applied LATER only by explicit human approval. This
 *     file itself imports NO apply / push / PR-create / deploy primitive (the
 *     `daemon-no-primitive` contract). M48: an OPT-IN auto-merge pass
 *     (cfg.foundry.autoMerge.enabled, DEFAULT OFF) is delegated to a SEPARATE
 *     module (fleet/automerge-pass) and may merge a proposal to main ONLY
 *     through the M47 tiered-trust gate (frontier merge-authority + risk ≤
 *     maxRisk + full verify + kill-switch + enrollment). With autoMerge disabled
 *     the daemon stays strictly proposal-only.
 *  2. ENROLLMENT-ONLY: operates exclusively on listEnrolled() repos.
 *     DEFAULT EMPTY => the daemon does NOTHING.
 *  3. SANDBOXED: every runSwarm call sets opts.sandbox = true so all
 *     swarm work runs in an isolated git-worktree (M21).
 *  4. BOUNDED: hard daily USD cap + per-tick item cap + concurrency cap.
 *     Resets per calendar day. NO unbounded loop — every iteration
 *     re-checks kill switch + budget.
 *  5. RE-ENTRANCY: runDaemon REFUSES if ASHLR_IN_DAEMON or ASHLR_IN_SWARM
 *     is already set (no daemon-inside-daemon / daemon-inside-swarm fork bomb).
 *     Sets ASHLR_IN_DAEMON=1 on this process so child spawns inherit it.
 *
 * No new runtime deps; node builtins only; never throws out of public API.
 */

import type { AshlrConfig, DaemonConfig, DaemonState, DaemonTick, EngineId, WorkItem } from '../types.js';
import { killSwitchOn, setKill, listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { buildBacklog } from '../portfolio/backlog.js';
import {
  acquireDaemonLock,
  armDaemonSpendGuard,
  clearDaemonSpendGuard,
  heartbeatDaemonLock,
  loadDaemonState,
  loadDaemonStateStrict,
  readDaemonSpendGuard,
  releaseDaemonLock,
  resetDayIfNeeded,
  saveDaemonState,
  saveDaemonStateResult,
} from './state.js';
import { nullSink } from '../run/streaming.js';
import { runSwarm } from '../swarm/runner.js';
import { runGoal } from '../run/orchestrator.js';
import { routeBackend } from '../fleet/router.js';
import { withinLimit, recordUse } from '../fleet/quota.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import { subscriptionAllows, isSubscriptionEngine } from '../fleet/subscription-usage.js'; // M80
import { recommendRoute, recoverWithinBudget } from '../run/learned-router.js';
import { decide as gatewayDecide } from '../fabric/gateway.js'; // M247: InferenceGateway
import { planConcurrentDispatch, runConcurrentDispatch } from '../fabric/concurrent-dispatch.js'; // M255
import { getResourceSnapshot } from '../fabric/resource-monitor.js'; // M255
import { estimateRun } from '../observability/estimate.js';
import { buildForecast } from '../observability/forecast.js';
import { emitTuningProposals } from '../learn/tuning.js';
import { runAutoMergePass, type AutoMergePassResult } from '../fleet/automerge-pass.js';
import { runBestOfN } from '../run/best-of-n.js';
import { runSelfHealCycle } from '../fleet/self-heal.js';
import { runViaAshlrcode } from '../run/ashlrcode-engine.js'; // M185
import { runInventCycle } from '../generative/invent-cycle.js'; // M186
import { runCounterfactualReplay } from '../fleet/counterfactual.js'; // M187
import { detectRegression, bisectAndRevert } from '../fleet/regression-sentinel.js'; // M189
// M212: proactive notifications (fire-and-forget, never throws, never alters control flow)
import { notifyFleetEvent } from '../comms/events.js';
import { pendingCount, listProposals } from '../inbox/store.js';
// worked-ledger is used transitively via LocalWorkQueueCoordinator (selectWorkQueueCoordinator).
import { selectWorkQueueCoordinator } from '../seams/work-queue-coordinator.js';
// M220: verdict-feedback sweep — feed judge rejections back to the ledger so
// re-clogging items (e.g. "CI is failing") are suppressed for the cooldown window.
import { sweepJudgedProposals } from '../fleet/worked-ledger.js';
import { loadConfig } from '../config.js';
import { hostname as osHostname } from 'node:os';

// ---------------------------------------------------------------------------
// DaemonConfig defaults (conservative)
// ---------------------------------------------------------------------------

const DEFAULTS: DaemonConfig = {
  dailyBudgetUsd: 1.0,    // $1/day hard cap by default
  perTickItems: 3,         // at most 3 backlog items per tick
  parallel: 2,             // at most 2 concurrent sandboxed swarms per tick
  intervalMs: 5 * 60_000, // 5-minute tick interval in loop mode
};

/**
 * Merge the hard-coded defaults with any partial overrides in cfg.daemon.
 * cfg.daemon grants NO authority — it only tunes caps.
 */
function resolveCfg(cfg: AshlrConfig): DaemonConfig {
  const o = cfg.daemon ?? {};
  // M116: tiered concurrency caps — defaults chosen for M5 Max (18 cores, 137GB RAM):
  // local=2 (GPU/RAM bound), cloud=6 (I/O bound), total=8. Configurable upward.
  const concLocal = typeof o.concurrency?.local === 'number' && o.concurrency.local > 0
    ? Math.floor(o.concurrency.local) : 2;
  const concCloud = typeof o.concurrency?.cloud === 'number' && o.concurrency.cloud > 0
    ? Math.floor(o.concurrency.cloud) : 6;
  const concTotal = typeof o.concurrency?.total === 'number' && o.concurrency.total > 0
    ? Math.floor(o.concurrency.total) : 8;
  // maxConcurrent: explicit override > concurrency.total > 8
  const maxConcurrent = typeof o.maxConcurrent === 'number' && o.maxConcurrent > 0
    ? Math.floor(o.maxConcurrent)
    : (typeof o.concurrency?.total === 'number' && o.concurrency.total > 0
        ? Math.floor(o.concurrency.total) : 8);
  return {
    dailyBudgetUsd: typeof o.dailyBudgetUsd === 'number' && o.dailyBudgetUsd > 0
      ? o.dailyBudgetUsd
      : DEFAULTS.dailyBudgetUsd,
    perTickItems: typeof o.perTickItems === 'number' && o.perTickItems > 0
      ? Math.floor(o.perTickItems)
      : DEFAULTS.perTickItems,
    parallel: typeof o.parallel === 'number' && o.parallel > 0
      ? Math.min(Math.floor(o.parallel), 8) // hard upper bound at 8 (batch mode)
      : DEFAULTS.parallel,
    intervalMs: typeof o.intervalMs === 'number' && o.intervalMs > 0
      ? o.intervalMs
      : DEFAULTS.intervalMs,
    // M116: new fields — undefined/absent ⇒ undefined in returned config (backward-compat)
    mode: o.mode === 'continuous' ? 'continuous' : o.mode === 'batch' ? 'batch' : undefined,
    maxConcurrent,
    concurrency: { local: concLocal, cloud: concCloud, total: concTotal },
    idleBackoffMs: typeof o.idleBackoffMs === 'number' && o.idleBackoffMs > 0
      ? o.idleBackoffMs : 5_000,
  };
}

// ---------------------------------------------------------------------------
// Bounded concurrency helpers
// ---------------------------------------------------------------------------

/**
 * M116: map an EngineTier to the two-bucket pool tier used for concurrency accounting.
 * 'frontier' and 'mid' are I/O-bound subscription engines → 'cloud' bucket.
 * 'local' (on-device models) is GPU/RAM-bound → 'local' bucket.
 */
function poolTierOf(engineTier: import('../types.js').EngineTier): 'local' | 'cloud' {
  return engineTier === 'local' ? 'local' : 'cloud';
}

/**
 * M116: TieredPool — a mutable concurrency gate that enforces per-tier AND total
 * in-flight caps. Used by both batch (to add per-tier awareness) and continuous
 * (to gate refills).
 *
 * All methods are synchronous; callers await the task themselves. The pool only
 * counts slots — it does NOT run tasks. Usage:
 *   if (pool.canStart(tier)) { pool.start(tier); try { await task(); } finally { pool.finish(tier); } }
 */
class TieredPool {
  private readonly _localCap: number;
  private readonly _cloudCap: number;
  private readonly _totalCap: number;
  private _localInFlight = 0;
  private _cloudInFlight = 0;

  constructor(opts: { local: number; cloud: number; total: number }) {
    this._localCap = Math.max(1, opts.local);
    this._cloudCap = Math.max(1, opts.cloud);
    this._totalCap = Math.max(1, opts.total);
  }

  get totalInFlight(): number { return this._localInFlight + this._cloudInFlight; }
  get localInFlight(): number { return this._localInFlight; }
  get cloudInFlight(): number { return this._cloudInFlight; }

  canStart(tier: 'local' | 'cloud'): boolean {
    if (this.totalInFlight >= this._totalCap) return false;
    if (tier === 'local') return this._localInFlight < this._localCap;
    return this._cloudInFlight < this._cloudCap;
  }

  start(tier: 'local' | 'cloud'): void {
    if (tier === 'local') this._localInFlight++;
    else this._cloudInFlight++;
  }

  finish(tier: 'local' | 'cloud'): void {
    if (tier === 'local') this._localInFlight = Math.max(0, this._localInFlight - 1);
    else this._cloudInFlight = Math.max(0, this._cloudInFlight - 1);
  }
}

/**
 * Pre-M116 bounded worker-pool: run `tasks` with at most `limit` concurrent.
 * Used for BATCH mode (default) to preserve byte-identical dispatch + budget
 * short-circuit semantics (H3 budget-overshoot bound = (parallel-1)×cost).
 */
async function bounded<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      const fn = tasks[idx];
      if (fn === undefined) break;
      try {
        results[idx] = { status: 'fulfilled', value: await fn() };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }

  const slots = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return results;
}

/**
 * M116: run `tasks` with tiered concurrency caps.
 * Each task carries a pre-determined tier ('local' | 'cloud').
 * Returns all settled results in input order. Never throws.
 *
 * Algorithm: maintain a set of pending task indices. Each time a task
 * completes, immediately try to start more tasks (up to pool caps). A
 * Promise resolves only after ALL tasks have completed. No shared mutable
 * wake/resolve — each completion schedules the next batch synchronously
 * via the microtask queue, avoiding any lost-wake races.
 */
async function tieredBounded<T>(
  tasks: Array<{ tier: 'local' | 'cloud'; run: () => Promise<T> }>,
  pool: TieredPool,
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return [];

  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;      // index of next task not yet started
  let completed = 0;    // count of tasks that have fully settled

  return new Promise<PromiseSettledResult<T>[]>((resolve) => {
    // Attempt to start as many tasks as the pool currently allows.
    function drain(): void {
      while (nextIdx < tasks.length) {
        const idx = nextIdx;
        const task = tasks[idx];
        if (task === undefined) break;
        if (!pool.canStart(task.tier)) break; // pool full for this tier or total
        nextIdx++;
        pool.start(task.tier);
        const tier = task.tier;
        task.run().then(
          (value) => {
            results[idx] = { status: 'fulfilled', value };
            pool.finish(tier);
            completed++;
            if (completed === tasks.length) resolve(results);
            else drain(); // slot freed — try to start more
          },
          (reason) => {
            results[idx] = { status: 'rejected', reason };
            pool.finish(tier);
            completed++;
            if (completed === tasks.length) resolve(results);
            else drain();
          },
        );
      }
    }

    drain(); // initial fill
  });
}

// ---------------------------------------------------------------------------
// tick — one operator cycle
// ---------------------------------------------------------------------------

/**
 * One operator cycle. In order:
 *  1. Kill-switch check.
 *  2. Load + resetDayIfNeeded state; budget exhaustion check.
 *  3. Enrollment check (DEFAULT EMPTY => do nothing).
 *  4. Build/load backlog for enrolled repos.
 *  5. Select top-K items within remaining budget.
 *  6a. dryRun: describe what WOULD be worked; create NO proposals.
 *  6b. else: for each selected item (bounded concurrency):
 *       runSwarm({ sandbox:true, propose:true }) => a PENDING inbox proposal
 *       is produced by the runner + tally spend.
 *  7. Persist updated state; return tick record.
 *
 * Has NO outward-action path (no apply, no push, no PR, no deploy).
 * Never throws.
 */
export async function tick(
  cfg: AshlrConfig,
  opts: { dryRun: boolean },
): Promise<DaemonTick> {
  const now = new Date().toISOString();
  // tick() respects the cfg it is GIVEN — tests and callers inject it directly.
  // M85 live-reload happens in runDaemon's LOOP (it reloads config from disk
  // before each tick and passes the fresh cfg in here), so on-disk daemon tuning
  // (budget/parallel/interval/cooldown) still takes effect without a restart
  // WITHOUT this function clobbering an explicitly-supplied cfg.
  const liveCfg = cfg;
  const dcfg = resolveCfg(liveCfg);

  // Append a tick record to persisted state so every operator cycle (including
  // no-op reasons like kill-switch / no-enrolled-repos / dry-run) is visible to
  // `daemon status`, the TUI, and the web dashboard. Never throws.
  const recordTick = (t: DaemonTick): DaemonTick => {
    try {
      const loaded = loadDaemonStateStrict();
      if (!loaded.ok) return t;
      let s = loaded.state;
      s = resetDayIfNeeded(s);
      s.lastTickAt = t.ts;
      s.ticks = [...s.ticks, t];
      saveDaemonStateResult(s);
    } catch (err) {
      // persistence best-effort — never let observability crash a tick
      console.warn('[ashlr] daemon:recordTick persistence failed:', (err as Error)?.message ?? err);
    }
    return t;
  };
  const persistenceRefusal = (summary: string, result: 'refused' | 'error' = 'refused'): DaemonTick => {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary,
      result,
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'state-persistence-failed',
    });
  };

  // -------------------------------------------------------------------------
  // 1. Kill-switch check.
  // -------------------------------------------------------------------------
  if (killSwitchOn()) {
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: 'tick skipped: kill switch is ON',
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'kill-switch',
    });
  }

  // -------------------------------------------------------------------------
  // 2. Load state + daily reset + budget exhaustion check.
  // -------------------------------------------------------------------------
  const loadedState = loadDaemonStateStrict();
  if (!loadedState.ok) {
    return persistenceRefusal(`tick refused: daemon state ${loadedState.reason} (${loadedState.error})`);
  }
  const existingSpendGuard = readDaemonSpendGuard();
  if (existingSpendGuard.exists) {
    return persistenceRefusal(
      existingSpendGuard.guard
        ? `tick refused: unresolved spend guard from ${existingSpendGuard.guard.armedAt} (${existingSpendGuard.guard.itemIds.length} item(s))`
        : `tick refused: malformed or unreadable spend guard at ${existingSpendGuard.path}`,
    );
  }
  let state = loadedState.state;
  state = resetDayIfNeeded(state);
  const initialSave = saveDaemonStateResult(state);
  if (!initialSave.ok) {
    return persistenceRefusal(`tick refused: failed to persist daemon state before dispatch (${initialSave.error})`, 'error');
  }

  const remainingBudget = dcfg.dailyBudgetUsd - state.todaySpentUsd;
  if (remainingBudget <= 0) {
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: `tick skipped: daily budget exhausted ($${state.todaySpentUsd.toFixed(4)} >= $${dcfg.dailyBudgetUsd})`,
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'budget-exhausted',
    });
  }

  // -------------------------------------------------------------------------
  // 3. Enrollment check — NEVER touch non-enrolled repos.
  // -------------------------------------------------------------------------
  const enrolled = listEnrolled();
  if (enrolled.length === 0) {
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: 'tick skipped: no repos enrolled (DEFAULT EMPTY)',
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'no-enrolled-repos',
    });
  }

  // -------------------------------------------------------------------------
  // 4. Build / refresh backlog for ENROLLED repos only.
  // -------------------------------------------------------------------------
  let backlogItems: WorkItem[] = [];
  try {
    const backlog = await buildBacklog({ repos: enrolled });
    backlogItems = backlog.items;
  } catch (err) {
    // buildBacklog never throws by contract; extra guard
    console.warn('[ashlr] daemon:tick buildBacklog guard caught:', (err as Error)?.message ?? err);
    backlogItems = [];
  }

  if (backlogItems.length === 0) {
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: 'tick skipped: backlog is empty for enrolled repos',
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'no-backlog',
    });
  }

  // -------------------------------------------------------------------------
  // 5. Select top-K items within the per-tick cap and remaining budget.
  //
  //    M85 FAIRNESS: round-robin across repos so every enrolled repo gets a
  //    turn instead of a single high-scoring repo monopolising every tick.
  //    Within each repo, items are already sorted highest-score-first by
  //    buildBacklog, so we always pick the most valuable open item per repo.
  //    Selection algorithm:
  //      a. Group items by repo (preserving within-repo score order).
  //      b. Walk repos in round-robin until selectCount is reached.
  //      c. Skip any item that is recentlyDeclined (cooldown window) OR already
  //         has an open PENDING proposal (best-effort match via item.id in the
  //         proposal title/summary — if no clean match, ledger alone governs).
  //
  //    The real budget controls remain: (a) perTickItems cap, (b) remaining
  //    daily USD budget, (c) the swarm's own internal token budget.
  // -------------------------------------------------------------------------
  const MIN_PER_ITEM_USD = 0.01; // floor on a per-item slice for selection math
  const maxByBudget = Math.max(1, Math.floor(remainingBudget / MIN_PER_ITEM_USD));
  const selectCount = Math.min(dcfg.perTickItems, maxByBudget, backlogItems.length);

  // M85: read the cooldown window from liveCfg defensively (no types.ts change).
  const cooldownMs: number =
    typeof (liveCfg.daemon as Record<string, unknown> | undefined)?.['cooldownMs'] === 'number' &&
    ((liveCfg.daemon as Record<string, unknown>)['cooldownMs'] as number) > 0
      ? (liveCfg.daemon as Record<string, unknown>)['cooldownMs'] as number
      : 6 * 60 * 60 * 1000; // default 6h

  // M220: verdict-feedback sweep — feed judge rejections back to the worked ledger
  // BEFORE selection so items whose proposals were judged review/noise/harmful are
  // suppressed this tick. Gated: cfg.foundry?.antiClog !== false (DEFAULT ON).
  // Flag-off (antiClog:false) = skip the sweep = exact pre-M220 behavior.
  if ((liveCfg.foundry as Record<string, unknown> | undefined)?.['antiClog'] !== false) {
    try {
      const rejected = listProposals({ status: 'rejected' });
      if (rejected.length > 0) {
        sweepJudgedProposals(rejected, backlogItems);
      }
    } catch (err) {
      // Best-effort — sweep must never crash selection.
      console.warn('[ashlr] daemon:tick sweepJudgedProposals failed:', (err as Error)?.message ?? err);
    }
  }

  // M113: coordinator seam — once per tick. Local (default) = today's behavior;
  // Shared = multi-machine atomic claim (cfg.fleet.sharedQueue.mode==='filesystem').
  const coordinator = selectWorkQueueCoordinator(liveCfg);
  const machineId: string =
    (liveCfg.fleet as Record<string, unknown> | undefined)?.['sharedQueue'] &&
    typeof ((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)?.['machineId'] === 'string'
      ? ((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)['machineId'] as string
      : osHostname();
  const sharedQueueLeaseMs: number =
    (liveCfg.fleet as Record<string, unknown> | undefined)?.['sharedQueue'] &&
    typeof ((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)?.['leaseMs'] === 'number' &&
    (((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)['leaseMs'] as number) > 0
      ? Math.floor(((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)['leaseMs'] as number)
      : 5 * 60 * 1000;

  // Build a set of item ids that already have an open PENDING proposal so we
  // can skip duplicating work. Best-effort: match on item.id appearing in the
  // proposal title or summary. Never throws.
  const pendingItemIds = new Set<string>();
  try {
    for (const prop of listProposals({ status: 'pending' })) {
      const haystack = `${prop.title} ${prop.summary}`;
      // Match item.id as an exact token (surrounded by non-word chars or
      // start/end of string) to avoid substring false-positives where a short
      // id like "fix-1" would incorrectly match "fix-10" or "fix-100".
      for (const bi of backlogItems) {
        // Escape any regex metacharacters in the id, then require word-boundary
        // equivalents (non-word char or string edge) on both sides.
        const escaped = bi.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
        if (re.test(haystack)) {
          pendingItemIds.add(bi.id);
        }
      }
    }
  } catch (err) {
    // Best-effort — never block selection on inbox read failure.
    console.warn('[ashlr] daemon:tick inbox pendingItemIds read failed:', (err as Error)?.message ?? err);
  }

  // Group backlog items by repo (score-sorted within each group by buildBacklog).
  const byRepo = new Map<string, WorkItem[]>();
  for (const item of backlogItems) {
    let group = byRepo.get(item.repo);
    if (!group) { group = []; byRepo.set(item.repo, group); }
    group.push(item);
  }
  // Per-repo cursors (index into each repo's item array).
  const repoCursors = new Map<string, number>();
  for (const repo of byRepo.keys()) repoCursors.set(repo, 0);
  const repoOrder = [...byRepo.keys()];

  const selected: WorkItem[] = [];
  // Guard: if no repos were grouped (shouldn't happen given backlogItems > 0,
  // but belt-and-suspenders) skip the loop entirely.
  if (repoOrder.length > 0) {
    let rri = 0; // round-robin index
    let scanned = 0; // safety: never loop more than total items
    const totalItems = backlogItems.length;
    while (selected.length < selectCount && scanned < totalItems * repoOrder.length + 1) {
      scanned++;
      const repo = repoOrder[rri % repoOrder.length];
      if (repo === undefined) break;
      rri++;
      const group = byRepo.get(repo) ?? [];
      const cursor = repoCursors.get(repo) ?? 0;
      // Advance cursor past declined/pending items.
      let advance = cursor;
      while (advance < group.length) {
        const candidate = group[advance]!;
        const skip =
          coordinator.shouldSkip(candidate.id, cooldownMs) ||
          pendingItemIds.has(candidate.id);
        if (!skip) break;
        advance++;
      }
      repoCursors.set(repo, advance);
      if (advance < group.length) {
        selected.push(group[advance]!);
        repoCursors.set(repo, advance + 1);
      }
      // Check on EVERY iteration whether any repo still has selectable items;
      // stop as soon as none do to avoid spinning through a fully-skipped backlog.
      // (Previously only checked at modulo-repoOrder.length boundaries, which
      // could miss exhaustion mid-pass and spin needlessly.)
      let anyLeft = false;
      for (const [r, g] of byRepo) {
        const c = repoCursors.get(r) ?? 0;
        if (c < g.length) { anyLeft = true; break; }
      }
      if (!anyLeft) break;
    }
  }

  // M113: claimItems — Local returns top-selectCount (identical to today's raw
  // slice); Shared atomically claims items so two machines get disjoint work.
  const workedSet = coordinator.claimItems(selected, selectCount, machineId);

  // -------------------------------------------------------------------------
  // 6a. Dry-run mode: report what WOULD be worked; NO swarms, NO proposals.
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    try {
      const claimedIds = workedSet.map((i) => i.id);
      if (claimedIds.length > 0) coordinator.release(claimedIds, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick dry-run coordinator release failed:', (err as Error)?.message ?? err);
    }
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: `dry-run: would work ${workedSet.length} item(s): ${workedSet.map(i => i.title).join(', ')}`,
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: workedSet.length,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'dry-run',
    });
  }

  const workedSetIds = workedSet.map((i) => i.id);
  const spendGuard = armDaemonSpendGuard(workedSetIds);
  if (!spendGuard.ok) {
    try {
      if (workedSetIds.length > 0) coordinator.release(workedSetIds, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick coordinator release after spend-guard failure failed:', (err as Error)?.message ?? err);
    }
    return persistenceRefusal(`tick refused: failed to arm spend guard (${spendGuard.error})`);
  }
  let leaseRenewInterval: ReturnType<typeof setInterval> | null = null;
  const renewClaimLeases = (): void => {
    if (workedSetIds.length === 0) return;
    try {
      coordinator.renew(workedSetIds, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick coordinator renew failed:', (err as Error)?.message ?? err);
    }
  };
  const startLeaseRenewer = (): void => {
    if (workedSetIds.length === 0) return;
    renewClaimLeases();
    const intervalMs = Math.max(1, Math.min(60_000, Math.floor(sharedQueueLeaseMs / 3)));
    leaseRenewInterval = setInterval(renewClaimLeases, intervalMs);
    (leaseRenewInterval as { unref?: () => void }).unref?.();
  };
  const stopLeaseRenewer = (): void => {
    if (leaseRenewInterval) {
      clearInterval(leaseRenewInterval);
      leaseRenewInterval = null;
    }
  };
  startLeaseRenewer();

  // -------------------------------------------------------------------------
  // 6b. Live mode: for each selected item (bounded concurrency), run a
  //     sandboxed swarm that records a PENDING inbox proposal.
  //
  //     GUARDRAIL: each swarm call uses opts.sandbox=true (M21 worktree) so
  //     swarm work NEVER touches the user's working tree, plus opts.propose=true
  //     so the runner records the captured diff as a PENDING inbox proposal.
  //     This file has NO outward-action primitive of any kind; a PENDING
  //     proposal is applied LATER only by an explicit human inbox approve.
  // -------------------------------------------------------------------------

  // M170: Self-heal cadence — detect broken repos and queue HIGH-PRIORITY heal
  // WorkItems for the next backlog selection. Flag-gated: default ON (fix-forward
  // posture). Never throws; never blocks or breaks the tick on any error.
  // Runs at the START of a LIVE tick (NOT dry-run — dry-run returned above).
  // cfg.foundry?.selfHeal === false → skipped entirely (flag-off = no-op).
  try {
    await runSelfHealCycle(liveCfg);
  } catch (err) {
    // Best-effort — self-heal must never crash the tick.
    console.warn('[ashlr] daemon:tick runSelfHealCycle failed:', (err as Error)?.message ?? err);
  }

  // M186: Generative invent cycle — synthesise new work items from enrolled repos.
  // Flag-gated: cfg.foundry.generative === true → ON; absent/false → skipped (default OFF).
  // Never throws; never blocks or breaks the tick on any error.
  if ((liveCfg.foundry as Record<string, unknown>)?.generative === true) {
    try { await runInventCycle(liveCfg); } catch (err) { console.warn('[ashlr] daemon:tick runInventCycle failed:', (err as Error)?.message ?? err); }
  }

  // M187: Counterfactual replay — low-cadence judge calibration.
  // Flag-gated: cfg.foundry.counterfactual === true AND sparse tick cadence (every 20 ticks).
  // Never throws; never blocks or breaks the tick on any error.
  if (
    (liveCfg.foundry as Record<string, unknown>)?.counterfactual === true &&
    state.ticks.length % 20 === 0
  ) {
    try { await runCounterfactualReplay(liveCfg); } catch (err) { console.warn('[ashlr] daemon:tick runCounterfactualReplay failed:', (err as Error)?.message ?? err); }
  }

  // M189: Regression sentinel — detect regressions introduced by auto-merge and bisect/revert.
  // Flag-gated: cfg.foundry.regressionSentinel === true → ON; absent/false → skipped (default OFF).
  // Never throws; never blocks or breaks the tick on any error.
  if ((liveCfg.foundry as Record<string, unknown>)?.regressionSentinel === true) {
    try {
      const r = await detectRegression(liveCfg);
      if (r.regressed) {
        await bisectAndRevert(liveCfg);
        // M212: fire-and-forget anomaly notification — additive, never throws.
        void notifyFleetEvent('anomaly', { detail: 'Regression detected — bisect/revert triggered' }, liveCfg);
        // M241: fire-and-forget fleet event-bus emit — additive, never throws, no control-flow change.
        void import('../fleet/event-bus.js').then(({ emit }) => emit('regression:detected', { signal: r.signal, repo: process.cwd() }, liveCfg)).catch(() => {});
      }
    } catch (err) { console.warn('[ashlr] daemon:tick regressionSentinel failed:', (err as Error)?.message ?? err); }
  }

  // Shared, mutable in-tick spend tally. Read+incremented by each concurrent
  // task so later dispatches can short-circuit once cumulative realized spend
  // reaches the remaining daily headroom (the USD daily cap is otherwise only
  // enforced BETWEEN ticks — this keeps a single tick from overshooting it).
  let tickSpent = 0;
  // M48: per-backend dispatch tally for this tick (observability only).
  const backendDispatch: Record<string, number> = {};

  // Per-item USD budget slice: divide remaining budget evenly across items.
  const perItemUsdSlice = remainingBudget / Math.max(1, workedSet.length);

  // Convert USD slice to a rough token count for the swarm budget.
  // Using a conservative $15/M-output estimate as the binding constraint.
  // This is best-effort estimation — the daemon's HARD cap is the USD daily budget.
  const usdPerMTokenOut = 15.0;
  const perItemMaxTokens = Math.max(
    1000,
    Math.floor((perItemUsdSlice / usdPerMTokenOut) * 1_000_000),
  );

  // Count proposals by the ACTUAL change in the inbox's PENDING count across the
  // whole batch — NOT by inferring from swarmRun.status==='done'. A swarm that
  // finished but recorded no proposal (e.g. a strict-sandbox abort, or an empty
  // diff) must NEVER be mis-counted as a proposal. pendingCount() is read-only.
  let pendingBefore = 0;
  try { pendingBefore = pendingCount(); } catch { pendingBefore = 0; }
  let pendingBeforeIds = new Set<string>();
  try {
    pendingBeforeIds = new Set(listProposals({ status: 'pending' }).map((p) => p.id));
  } catch {
    pendingBeforeIds = new Set<string>();
  }

  // `dispatched` = a swarm was actually invoked for this item (kill switch /
  // budget short-circuit did NOT skip it). Drives itemsProcessed so `daemon
  // status` reflects real work, not merely items considered.
  type ItemOutcome = { item: WorkItem; spentUsd: number; dispatched: boolean };

  // M116: build TieredPool from resolved config.
  // In batch mode (default), cap each tier at parallel to preserve identical behavior.
  // In continuous mode (or when concurrency is configured), use the per-tier caps.
  const isContinuousMode = dcfg.mode === 'continuous';
  const tierPool = new TieredPool(
    isContinuousMode || dcfg.concurrency !== undefined
      ? {
          local: dcfg.concurrency?.local ?? 2,
          cloud: dcfg.concurrency?.cloud ?? 6,
          total: dcfg.maxConcurrent ?? dcfg.concurrency?.total ?? 8,
        }
      : {
          // Batch mode default: mirror old bounded(tasks, dcfg.parallel) — all tiers share parallel
          local: dcfg.parallel,
          cloud: dcfg.parallel,
          total: dcfg.parallel,
        },
  );

  // Determine each item's pool tier BEFORE building the task array so the
  // tieredBounded dispatcher knows which slot to request.
  const itemTiers: Array<'local' | 'cloud'> = workedSet.map((item) => {
    const routed = routeBackend(item, liveCfg);
    let backend = routed.backend;
    if (backend !== 'builtin' && !withinLimit(backend, liveCfg)) backend = 'builtin';
    const engineTier = engineTierOf(backend, liveCfg);
    return poolTierOf(engineTier);
  });

  const tasks: Array<{ tier: 'local' | 'cloud'; run: (assignedBackend?: EngineId, assignedReason?: string) => Promise<ItemOutcome> }> = workedSet.map((item, _taskIdx) => ({
    tier: itemTiers[_taskIdx] ?? 'local',
    run: async (assignedBackend?: EngineId, assignedReason?: string): Promise<ItemOutcome> => {
      // Re-check kill switch before each item dispatch.
      if (killSwitchOn()) {
        return { item, spentUsd: 0, dispatched: false };
      }
      // In-tick budget short-circuit: if cumulative realized spend has already
      // reached the remaining daily headroom, do NOT dispatch further items.
      if (tickSpent >= remainingBudget) {
        return { item, spentUsd: 0, dispatched: false };
      }

      let swarmSpent = 0;
      let dispatched = false;

      // M247: InferenceGateway — consolidates routing into one traceable decision.
      // FLAG-GATED: when cfg.foundry.fabric?.gateway === true, a single
      // gateway.decide() call replaces the double routeBackend + quota guard +
      // subscription throttle + M53 block below. Default false → old path runs
      // byte-identical. The gateway's flag-off path is itself a thin pass-through
      // to routeBackend, so both branches produce the same result when flag is off.
      //
      // Hoisted so both the gateway branch and the legacy branch can assign it,
      // and subsequent dispatch code sees the same name regardless of path.
      let backend: EngineId;
      if (assignedBackend !== undefined) {
        if (assignedReason?.startsWith('throttled:') || assignedReason?.startsWith('resource-pause:')) {
          audit({
            action: 'daemon:tick',
            repo: item.repo,
            sandboxId: null,
            summary: assignedReason,
            result: 'ok',
          });
          return { item, spentUsd: 0, dispatched: false };
        }
        if (assignedReason?.startsWith('budget-pause:')) {
          audit({
            action: 'daemon:budget-cascade',
            repo: item.repo,
            sandboxId: null,
            summary: `M255 concurrent dispatch: pausing "${item.title}" — ${assignedReason}`,
            result: 'ok',
          });
          return { item, spentUsd: 0, dispatched: false };
        }
        backend = assignedBackend;
      } else if (liveCfg.foundry?.fabric?.gateway === true) {
        const forecast = buildForecast('7d', liveCfg);
        const gd = await gatewayDecide(item, liveCfg, {
          spentUsd: tickSpent + state.todaySpentUsd,
          forecast,
        });
        // Throttled: subscription window at cap — skip item, same as old path.
        if (gd.reason.startsWith('throttled:')) {
          audit({
            action: 'daemon:tick',
            repo: item.repo,
            sandboxId: null,
            summary: gd.reason,
            result: 'ok',
          });
          return { item, spentUsd: 0, dispatched: false };
        }
        // Budget pause: step down exhausted budget — skip item, same as old path.
        if (gd.reason.startsWith('budget-pause:')) {
          audit({
            action: 'daemon:budget-cascade',
            repo: item.repo,
            sandboxId: null,
            summary: `M247 gateway budget cascade: pausing dispatch for "${item.title}" — ${gd.reason}`,
            result: 'ok',
          });
          return { item, spentUsd: 0, dispatched: false };
        }
        if (gd.reason.startsWith('resource-pause:')) {
          audit({
            action: 'daemon:tick',
            repo: item.repo,
            sandboxId: null,
            summary: gd.reason,
            result: 'ok',
          });
          return { item, spentUsd: 0, dispatched: false };
        }
        // Normal dispatch: use gateway decision's backend directly.
        backend = gd.backend;
      } else {
        // M48: route this item to a backend (M46). Default (no cfg.foundry) →
        // 'builtin'. A frontier backend over its rolling rate quota falls back to
        // local so work keeps flowing without exceeding the subscription's limit.
        // M85: use liveCfg (reloaded per-tick) for routing + quota checks.
        const routed = routeBackend(item, liveCfg);
        backend = routed.backend;
        if (backend !== 'builtin' && !withinLimit(backend, liveCfg)) {
          backend = 'builtin';
        }

        // M80: subscription-window throttle — skip this item (not crash) when a
        // KNOWN subscription window is at or above the cap (default 90%). Reads
        // cfg.foundry.subscriptionMaxPercent defensively with a fallback default.
        // allowed:true when usage is unknown (claude) or under the cap.
        if (isSubscriptionEngine(backend)) {
          // Read maxPercent from liveCfg.foundry defensively — no types.ts change.
          // Clamp to [1,100]: a negative or zero value would disable the throttle
          // (anything is "under 0%"), and >100 could never fire (nothing is ">100%").
          const rawPct = (liveCfg.foundry as Record<string, unknown> | undefined
            )?.['subscriptionMaxPercent'];
          const maxPct: number = typeof rawPct === 'number'
            ? Math.min(100, Math.max(1, rawPct))
            : 90;
          const subCheck = subscriptionAllows(backend, { maxPercent: maxPct });
          if (!subCheck.allowed) {
            audit({
              action: 'daemon:tick',
              repo: item.repo,
              sandboxId: null,
              summary: `throttled: ${backend} subscription window — ${subCheck.reason}`,
              result: 'ok',
            });
            return { item, spentUsd: 0, dispatched: false };
          }
        }

        // M53: learned-router recommend + budget cascade (flag-off: no-op when
        // cfg.foundry.intelligence is absent). recoverWithinBudget is PURE and
        // may only return a tier choice or a pause signal — no outward action.
        // This file imports NO apply/merge/push/deploy primitive.
        // M85: use liveCfg for intelligence config.
        {
          const intelRaw = liveCfg.foundry?.intelligence;
          if (intelRaw !== undefined && intelRaw !== null) {
            const forecast = buildForecast('7d', liveCfg);
            const goal = buildItemGoal(item);
            const est = await estimateRun(goal, { maxTokens: perItemMaxTokens }, liveCfg);
            const recommended = await recommendRoute(item, liveCfg, { estimate: est });
            // Only override when the recommend result doesn't escalate a local decision.
            if (routed.tier !== 'local' || recommended.tier === 'local') {
              backend = recommended.backend;
            }
            // Budget cascade: step down tier when near cap.
            const recovery = recoverWithinBudget(
              { backend, tier: recommended.tier, reason: recommended.reason },
              liveCfg,
              tickSpent + state.todaySpentUsd,
              forecast,
            );
            if (recovery.action === 'pause') {
              audit({
                action: 'daemon:budget-cascade',
                repo: item.repo,
                sandboxId: null,
                summary: `M53 budget cascade: pausing dispatch for "${item.title}" — ${recovery.reason}`,
                result: 'ok',
              });
              return { item, spentUsd: 0, dispatched: false };
            } else {
              backend = recovery.decision.backend;
            }
          }
        }
      } // end flag-off path

      const goal = buildItemGoal(item);
      const itemBudget = { maxTokens: perItemMaxTokens, maxSteps: 100, allowCloud: false };

    // Snapshot ASHLR_IN_SWARM and restore it after the call. The swarm runner
    // sets ASHLR_IN_SWARM=1 on THIS (long-lived) process and does not unwind it;
    // restoring keeps each subsequent dispatch / tick from hitting the recursion
    // guard while the runner's own child-spawn inheritance still works mid-call.
    const prevInSwarm = process.env['ASHLR_IN_SWARM'];

    try {
      const sink = nullSink();
      dispatched = true;
      backendDispatch[backend] = (backendDispatch[backend] ?? 0) + 1;

      if (backend === 'builtin') {
        const swarmRun = await runSwarm(
          { goal },
          liveCfg,
          {
            sandbox: true,             // M21: isolated git-worktree — NEVER user's tree
            requireSandbox: true,      // M24: sandbox MANDATORY — abort if it can't be created
            propose: true,             // M24: swarm records its diff as a PENDING inbox proposal
            project: item.repo,
            budget: itemBudget,
            parallel: 1,
            dryRun: false,
            noCapture: true,
            workItemId: item.id,
            workSource: item.source,
          },
          sink,
        );

        swarmSpent = swarmRun.usage?.estCostUsd ?? 0;
        tickSpent += swarmSpent;

        audit({
          action: 'daemon:proposal-created',
          repo: item.repo,
          sandboxId: null,
          summary: `swarm ${swarmRun.id} finished (status=${swarmRun.status}, spent=$${swarmSpent.toFixed(4)}) for "${item.title}"`,
          result: 'ok',
        });
      } else {
        // M48: a frontier backend (claude/codex) is itself a full agent — run
        // the WHOLE item as ONE sandboxed-external run (M45): worktree → agent →
        // diff → PENDING proposal. No nested swarm. M45 containment (severed git
        // push, scrubbed diff) + the M47 merge gate still apply downstream.
        recordUse(backend);

        // M185: ashlrcode executor — when flag ON and backend is a LOCAL tier,
        // delegate the item to the `ac` agent instead of the raw runGoal path.
        // Flag-off (ashlrcodeExecutor absent/false) → falls through to runGoal,
        // byte-identical to pre-M185 behavior.
        if (
          (liveCfg.foundry as Record<string, unknown>)?.['ashlrcodeExecutor'] === true &&
          poolTierOf(engineTierOf(backend)) === 'local'
        ) {
          const acResult = await runViaAshlrcode(item, item.repo, liveCfg);
          swarmSpent = 0; // ac does not bill separately; cost accounted by engine
          tickSpent += swarmSpent;
          audit({
            action: 'daemon:proposal-created',
            repo: item.repo,
            sandboxId: null,
            summary: `ashlrcode executor: ${acResult.ok ? 'ok' : `failed: ${acResult.error}`} for "${item.title}"`,
            result: acResult.ok ? 'ok' : 'error',
          });
          return { item, spentUsd: swarmSpent, dispatched: true };
        }

        // M170: best-of-N dispatch — when cfg.foundry.bestOfN > 1, generate N
        // candidates and let the critic pick the winner. Flag-off: bestOfN absent
        // or 1 → single runGoal call, byte-identical to pre-M170 behavior.
        const bestOfN: number =
          typeof (liveCfg.foundry as Record<string, unknown> | undefined)?.['bestOfN'] === 'number' &&
          ((liveCfg.foundry as Record<string, unknown>)['bestOfN'] as number) > 1
            ? Math.floor((liveCfg.foundry as Record<string, unknown>)['bestOfN'] as number)
            : 1;

        let runState: Awaited<ReturnType<typeof runGoal>>;
        if (bestOfN > 1) {
          // Route through runBestOfN; use its winner's underlying runState.
          // runBestOfN never throws; if all candidates fail, winner is undefined
          // and we fall through to a zero-cost no-proposal outcome.
          const bonResult = await runBestOfN(item, liveCfg, {
            n: bestOfN,
            workItemId: item.id,
            workSource: item.source,
          });
          if (!bonResult.winner) {
            // All candidates were empty/failing — count as dispatched but $0.
            swarmSpent = 0;
            tickSpent += swarmSpent;
            audit({
              action: 'daemon:proposal-created',
              repo: item.repo,
              sandboxId: null,
              summary: `best-of-${bestOfN}: all candidates empty for "${item.title}" — no proposal`,
              result: 'ok',
            });
            return { item, spentUsd: 0, dispatched: true };
          }
          // Winner's underlying run state lives in the candidate's state field.
          // Cast to the shape runGoal returns (id, status, usage).
          runState = (bonResult.winner as unknown as { state: Awaited<ReturnType<typeof runGoal>> }).state
            ?? { id: bonResult.winner.proposalId ?? `bon-${Date.now()}`, status: 'done' as const, usage: undefined };
        } else {
          runState = await runGoal(goal, liveCfg, {
            engine: backend,
            sandboxEngine: true,
            requireSandbox: true,
            cwd: item.repo,
            budget: itemBudget,
            tools: true,
            noMemory: false,
            workItemId: item.id,
            workSource: item.source,
          });
        }

        // M80: subscription-tier runs are not dollar-billed — count $0 toward
        // dailyBudgetUsd so they don't exhaust the daily cap. The subscription-
        // window guard (subscriptionAllows above) governs their pacing instead.
        // API-model / builtin paths are unaffected (their isSubscriptionEngine is false).
        swarmSpent = isSubscriptionEngine(backend)
          ? 0
          : (runState.usage?.estCostUsd ?? 0);
        tickSpent += swarmSpent;

        audit({
          action: 'daemon:proposal-created',
          repo: item.repo,
          sandboxId: null,
          summary: `${backend} run ${runState.id} finished (status=${runState.status}, spent=$${swarmSpent.toFixed(4)}) for "${item.title}"`,
          result: 'ok',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      audit({
        action: 'daemon:swarm-error',
        repo: item.repo,
        sandboxId: null,
        summary: `${backend} dispatch failed for "${item.title}": ${msg.slice(0, 200)}`,
        result: 'error',
      });
    } finally {
      if (prevInSwarm === undefined) delete process.env['ASHLR_IN_SWARM'];
      else process.env['ASHLR_IN_SWARM'] = prevInSwarm;
    }

    // M53: anomaly-hold — if run cost > k×p50, hold the proposal PENDING and
    // file a TuningProposal. NEVER auto-apply. This block imports NO
    // apply/merge/push/deploy primitive.
    if (dispatched && swarmSpent > 0) {
      const intelRaw2 = liveCfg.foundry?.intelligence;
      if (intelRaw2 !== undefined && intelRaw2 !== null) {
        const intelCfg2 = intelRaw2 as { anomalyK?: number };
        const anomalyK = typeof intelCfg2.anomalyK === 'number' && intelCfg2.anomalyK > 0
          ? intelCfg2.anomalyK : 4;
        const goal2 = buildItemGoal(item);
        const est2 = await estimateRun(goal2, { maxTokens: perItemMaxTokens }, liveCfg).catch((err) => { console.warn('[ashlr] daemon:tick estimateRun failed:', (err as Error)?.message ?? err); return null; });
        const p50 = est2?.estCostUsd.median ?? 0;
        if (p50 > 0 && swarmSpent > anomalyK * p50) {
          audit({
            action: 'daemon:anomaly-hold',
            repo: item.repo,
            sandboxId: null,
            summary:
              `M53 anomaly hold: "${item.title}" cost $${swarmSpent.toFixed(4)} ` +
              `> ${anomalyK}×p50 ($${(anomalyK * p50).toFixed(4)}) — proposal stays PENDING`,
            result: 'ok',
          });
          // File a TuningProposal describing the anomaly (proposal-only, never auto-applied).
          try {
            emitTuningProposals([{
              key: `anomaly.cost.${item.id.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
              area: 'policy',
              title: `Cost anomaly hold: "${item.title.slice(0, 60)}"`,
              rationale:
                `Run cost $${swarmSpent.toFixed(4)} exceeded ${anomalyK}×p50 ` +
                `($${(anomalyK * p50).toFixed(4)}) for "${item.title}". ` +
                `Proposal held PENDING for human review.`,
              confidence: Math.min(0.9, 0.5 + (swarmSpent / (anomalyK * p50) - 1) / 10),
            }]);
          } catch (err) {
            // Emission must never crash the tick.
            console.warn('[ashlr] daemon:tick emitTuningProposals failed:', (err as Error)?.message ?? err);
          }
        }
      }
    }

    return { item, spentUsd: swarmSpent, dispatched };
    }, // end run:
  }));  // end tasks.map

  // M255: Concurrent Multi-Backend Dispatcher — flag-gated.
  // When fabric.concurrentDispatch === true, replace the serial per-item loop
  // with planConcurrentDispatch + runConcurrentDispatch across ALL backends with
  // headroom in PARALLEL. Each backend is bounded to its slot cap from the
  // resource monitor. Results are converted to the same PromiseSettledResult<ItemOutcome>[]
  // shape as the existing paths so all downstream accounting (dispatchedCount,
  // proposalDelta, ledger recording) is byte-identical.
  //
  // FLAG-OFF (default): falls through to the existing batch/tieredBounded paths —
  // byte-identical to pre-M255 behavior.
  const useConcurrentDispatch = liveCfg.foundry?.fabric?.concurrentDispatch === true;

  let outcomes: PromiseSettledResult<ItemOutcome>[];

  try {
  if (useConcurrentDispatch) {
    // Re-sense headroom before planning (cached 30s; no extra cost in practice).
    const concurrentSnap = await getResourceSnapshot(liveCfg).catch(() => ({
      generatedAt: new Date().toISOString(),
      backends: [{ backend: 'builtin' as const, availability: 'open' as const, usedPct: null, cap: null, capUnit: null, capWindow: null, resetsAt: null, costPerMTokenOut: 0, p50LatencyMs: null, snapshotAt: new Date().toISOString(), reason: 'snapshot-failed', backoffUntilMs: null }],
    }));

    const maxSlotsPerBackend: number =
      typeof (liveCfg.foundry?.fabric as Record<string, unknown> | undefined)?.['maxSlotsPerBackend'] === 'number'
        ? Math.max(1, (liveCfg.foundry!.fabric as Record<string, unknown>)['maxSlotsPerBackend'] as number)
        : 3;

    const concurrentCfg = { maxSlotsPerBackend };

    // planConcurrentDispatch: pure, uses gateway routing hints for suitability.
    // Build routing hints in parallel via gateway.decide, then call the pure planner.
    const routeHints = new Map<string, EngineId>();
    const routeReasons = new Map<string, string>();
    if (liveCfg.foundry?.fabric?.gateway === true) {
      const gds = await Promise.allSettled(
        workedSet.map((item) => gatewayDecide(item, liveCfg, { spentUsd: tickSpent + state.todaySpentUsd }))
      );
      for (let i = 0; i < workedSet.length; i++) {
        const d = gds[i];
        if (d?.status === 'fulfilled') {
          routeHints.set(workedSet[i]!.id, d.value.backend);
          routeReasons.set(workedSet[i]!.id, d.value.reason);
        }
      }
    }
    const concurrentPlan = planConcurrentDispatch(
      workedSet,
      concurrentSnap,
      concurrentCfg,
      (item) => routeHints.get(item.id) ?? 'builtin',
    );

    // runConcurrentDispatch: executes plan with full cross-backend parallelism.
    const concurrentResults = await runConcurrentDispatch(
      concurrentPlan,
      async (item, _backend): Promise<unknown> => {
        // Each dispatched item flows through the FULL task run function.
        // Find the pre-built task for this item (same gate logic: kill-switch,
        // budget short-circuit, gateway/serial routing, sandbox, judge, etc.).
        // We look up by item.id to reuse the existing tasks[] entries which
        // already capture tickSpent/state/liveCfg via closure.
        const taskEntry = tasks.find((_t, idx) => workedSet[idx]?.id === item.id);
        if (taskEntry) return taskEntry.run(_backend, routeReasons.get(item.id));
        // Fallback: build a minimal no-op outcome (item not in tasks — shouldn't happen).
        return { item, spentUsd: 0, dispatched: false } satisfies ItemOutcome;
      },
      killSwitchOn,
      concurrentCfg,
    );

    // Convert DispatchResult[] → PromiseSettledResult<ItemOutcome>[] for downstream.
    outcomes = concurrentResults.map((r): PromiseSettledResult<ItemOutcome> => {
      if (r.settled?.status === 'rejected') {
        return { status: 'rejected', reason: r.settled.reason };
      }
      const inner = r.settled?.status === 'fulfilled'
        ? (r.settled.value as ItemOutcome | undefined)
        : undefined;
      return {
        status: 'fulfilled',
        value: inner ?? { item: r.item, spentUsd: 0, dispatched: r.attempted },
      };
    });

    // Add unassigned items as non-dispatched fulfilled outcomes.
    for (const item of concurrentPlan.unassigned) {
      outcomes.push({ status: 'fulfilled', value: { item, spentUsd: 0, dispatched: false } });
    }
  } else {
    // Batch mode (default — no continuous mode, no explicit concurrency config):
    // use the exact pre-M116 bounded worker-pool so dispatch + the in-tick budget
    // short-circuit are byte-identical (preserves the H3 overshoot bound). The
    // tiered pool only engages for continuous mode or explicit daemon.concurrency.
    // Detect batch mode from the RAW user config — resolveCfg ALWAYS populates
    // dcfg.concurrency with defaults, so checking dcfg would never be batch.
    const explicitConcurrency =
      liveCfg.daemon?.concurrency !== undefined || liveCfg.daemon?.maxConcurrent !== undefined;
    const useBatchPool = !isContinuousMode && !explicitConcurrency;
    outcomes = useBatchPool
      ? await bounded(tasks.map((t) => t.run), dcfg.parallel)
      : await tieredBounded(tasks, tierPool);
  }
  } finally {
    stopLeaseRenewer();
  }

  // itemsProcessed counts items whose swarm was actually dispatched (not those
  // skipped by the kill switch or the in-tick budget short-circuit).
  let dispatchedCount = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
      dispatchedCount++;
    }
  }

  // Proposals actually recorded this tick = the PENDING-count delta (clamped >=0).
  let proposalsCreated = 0;
  try { proposalsCreated = Math.max(0, pendingCount() - pendingBefore); } catch (err) { console.warn('[ashlr] daemon:tick proposalDelta count failed:', (err as Error)?.message ?? err); proposalsCreated = 0; }

  // M85/M305: record item-accurate outcomes to the worked ledger. New proposals
  // carry workItemId, so a multi-item tick can tell which dispatched item filed
  // a patch instead of relying on the old aggregate pending-count heuristic.
  // Non-dispatched items (kill-switch / budget skip) are NOT recorded — they
  // were never run, so they should not trigger a cooldown.
  if (dispatchedCount > 0) {
    try {
      const proposalItemIds = new Set<string>();
      try {
        for (const proposal of listProposals({ status: 'pending' })) {
          if (pendingBeforeIds.has(proposal.id)) continue;
          if (proposal.workItemId) proposalItemIds.add(proposal.workItemId);
        }
      } catch {
        // Fallback preserves the old conservative behavior if the inbox cannot
        // be read after dispatch.
        if (proposalsCreated >= dispatchedCount) {
          for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
              proposalItemIds.add(outcome.value.item.id);
            }
          }
        }
      }
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
          const outcomeLabel: 'diff' | 'empty' = proposalItemIds.has(outcome.value.item.id) ? 'diff' : 'empty';
          // M113: route through coordinator (Local → worked-ledger; Shared → global store).
          coordinator.recordOutcome(outcome.value.item.id, outcomeLabel, machineId);
        }
      }
    } catch (err) {
      // Ledger recording must never crash the tick.
      console.warn('[ashlr] daemon:tick ledger recordOutcome failed:', (err as Error)?.message ?? err);
    }
  }

  // M113: release any claimed-but-not-dispatched items so they're free for
  // the next machine or tick (no-op for LocalWorkQueueCoordinator).
  try {
    const dispatchedIds = new Set(
      outcomes
        .filter((o): o is PromiseFulfilledResult<ItemOutcome> => o.status === 'fulfilled' && o.value.dispatched)
        .map(o => o.value.item.id),
    );
    const unworkedIds = workedSet.map(i => i.id).filter(id => !dispatchedIds.has(id));
    if (unworkedIds.length > 0) coordinator.release(unworkedIds, machineId);
  } catch (err) {
    // Release must never crash the tick.
    console.warn('[ashlr] daemon:tick coordinator release failed:', (err as Error)?.message ?? err);
  }

  // M48: OPT-IN auto-merge pass (cfg.foundry.autoMerge.enabled, DEFAULT OFF).
  // Delegated to fleet/automerge-pass so THIS file imports no merge primitive.
  // Every merge runs the M47 tiered-trust gate (frontier authority + risk ≤
  // maxRisk + full verify + kill-switch + enrollment); unauthorized proposals
  // stay PENDING. With autoMerge disabled this is a no-op — the daemon stays
  // strictly proposal-only.
  let merged = 0;
  let autoMergePassResult: AutoMergePassResult | null = null;
  try { autoMergePassResult = await runAutoMergePass(liveCfg); merged = autoMergePassResult?.merged ?? 0; } catch (err) { console.warn('[ashlr] daemon:tick runAutoMergePass failed:', (err as Error)?.message ?? err); merged = 0; }

  // -------------------------------------------------------------------------
  // 7. Update + persist state with this tick's accounting.
  // -------------------------------------------------------------------------
  const finalLoadedState = loadDaemonStateStrict(); // reload in case of concurrent writes
  if (!finalLoadedState.ok) {
    const failedTick: DaemonTick = {
      ts: now,
      itemsConsidered: selected.length,
      proposalsCreated,
      spentUsd: tickSpent,
      reason: 'state-persistence-failed',
      ...(Object.keys(backendDispatch).length > 0 ? { backends: backendDispatch } : {}),
      ...(merged > 0 ? { merged } : {}),
    };
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `tick completed but spend accounting refused: daemon state ${finalLoadedState.reason} (${finalLoadedState.error}); spend guard remains armed`,
      result: 'error',
    });
    return failedTick;
  }
  state = finalLoadedState.state;
  state = resetDayIfNeeded(state);         // re-check day rollover after async work
  state.todaySpentUsd += tickSpent;
  state.itemsProcessed += dispatchedCount;
  state.lastTickAt = now;

  const tickRecord: DaemonTick = {
    ts: now,
    itemsConsidered: selected.length,
    proposalsCreated,
    spentUsd: tickSpent,
    reason: 'ok',
    ...(Object.keys(backendDispatch).length > 0 ? { backends: backendDispatch } : {}),
    ...(merged > 0 ? { merged } : {}),
  };
  state.ticks = [...state.ticks, tickRecord];
  const saveResult = saveDaemonStateResult(state);
  if (!saveResult.ok) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `tick completed but spend accounting save failed (${saveResult.error}); spend guard remains armed`,
      result: 'error',
    });
    return { ...tickRecord, reason: 'state-persistence-failed' };
  }
  const clearGuardResult = clearDaemonSpendGuard(spendGuard.guard.token);
  if (!clearGuardResult.ok) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `tick completed but spend guard clear failed (${clearGuardResult.error}); future ticks will refuse`,
      result: 'error',
    });
    return { ...tickRecord, reason: 'state-persistence-failed' };
  }

  // M89/M91: best-effort fleet→pulse telemetry export. Runs OUTSIDE the proposal
  // guarantees — only reads state + POSTs telemetry; never mutates repos.
  // M91 incremental: pass lastPulseExportAt as sinceTs so only NEW events are
  // sent each tick. On a 2xx response, advance the watermark and persist it;
  // on failure leave the watermark unchanged so events retry next tick.
  // Never throws.
  // M89/M91 pulse export: sinceTs is captured synchronously from the state we
  // just saved so the async export reads a stable, already-persisted watermark.
  // The watermark advance is done via a narrow read-modify-write that re-loads
  // the LATEST state immediately before writing, touching ONLY lastPulseExportAt,
  // so it cannot clobber a concurrent tick's todaySpentUsd / itemsProcessed /
  // ticks accounting.
  if (cfg.pulse?.enabled) {
    const sinceTs = state.lastPulseExportAt; // captured from the state we already saved
    void import('../fleet/pulse-export.js').then(async ({ exportToPulse }) => {
      try {
        const ok = await exportToPulse(cfg, { sinceTs });
        if (ok) {
          // Narrow read-modify-write: reload freshest state, touch ONLY the
          // watermark, then save — never clobbers concurrent tick accounting.
          const fresh = loadDaemonState();
          fresh.lastPulseExportAt = tickRecord.ts;
          saveDaemonState(fresh);
        }
      } catch (err) {
        // Best-effort — telemetry must never crash the daemon.
        console.warn('[ashlr] daemon:tick pulse export failed:', (err as Error)?.message ?? err);
      }
    }).catch((err) => { console.warn('[ashlr] daemon:tick pulse-export lazy-import failed:', (err as Error)?.message ?? err); return undefined; });
  }

  // ── Phase H: fleet→pulse ROUND-TRIP (cloud orchestrates, local executes). ──
  // On each live tick: emit a 'tick' heartbeat span, then POLL the cloud's
  // fleet_command queue (read-scoped PAT), CLAIM + APPLY each pending command
  // LOCALLY (assign_goal→createGoal / approve|reject_proposal→inbox setStatus /
  // enroll_repo→enrollment), PATCH the metadata-only outcome back, and ship
  // enrolled-repo dependency edges as `deps` spans.
  //
  // FULLY GATED + NO-THROW: pulse-sync is a complete no-op unless BOTH a Pulse
  // endpoint (PULSE_URL / cfg.pulse.endpoint) AND a PAT (PULSE_FLEET_PAT /
  // ASHLR_PULSE_*) are configured. It performs NO outward git action of its own
  // — assign_goal only PLANS, approve_proposal only flips a proposal's STATUS
  // (the diff is NOT applied here), enroll_repo only adds to the registry — so
  // the daemon's enrollment / kill-switch / proposal-only floor is unweakened.
  // LAZY-imported (keeps loop.ts's static outward-primitive grep-guards intact)
  // and fire-and-forget so a Pulse outage never blocks or breaks the tick.
  // DRY-RUN never reaches here (it returns earlier), so this only runs live.
  void import('../integrations/pulse-sync.js').then(async ({ runPulseSync }) => {
    try {
      await runPulseSync(cfg, { tickTs: tickRecord.ts });
    } catch (err) {
      // Best-effort — the round-trip must never crash the daemon.
      console.warn('[ashlr] daemon:tick pulse-sync failed:', (err as Error)?.message ?? err);
    }
  }).catch((err) => { console.warn('[ashlr] daemon:tick pulse-sync lazy-import failed:', (err as Error)?.message ?? err); return undefined; });

  // M214: fire-and-forget tick-cost emit to Pulse OTLP — additive, never throws, no control-flow change.
  // Lazy-imported (mirrors the pulse-sync pattern) so loop.ts's static grep-guards stay intact.
  void import('../integrations/fleet-pulse-emit.js').then(async ({ emitTickCost }) => {
    try {
      await emitTickCost(cfg, tickRecord.ts, tickRecord.spentUsd, tickRecord.proposalsCreated, merged);
    } catch {
      // Best-effort — telemetry must never crash the daemon.
    }
  }).catch(() => { /* lazy-import best-effort */ });

  // ── M257 Director cycle — gated, additive, fire-and-forget ─────────────────
  // Runs at most once every 15 minutes (tracked in process memory; dormant when
  // cfg.comms.director is absent/false — byte-identical to absent).
  // SAFETY: director is READ-ONLY god-view access in M257. No goal mutations,
  // no merge/push/apply, no bypass of any safety gate.
  void (() => {
    try {
      const directorEnabled =
        (cfg.comms as Record<string, unknown> | undefined)?.['director'] === true;
      if (!directorEnabled) return;

      const DIRECTOR_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
      const now = Date.now();
      const proc = process as unknown as Record<string, unknown>;
      const last = proc['__ashlrDirectorLastRunMs'];
      const lastMs = typeof last === 'number' ? last : 0;
      if (now - lastMs < DIRECTOR_INTERVAL_MS) return;
      proc['__ashlrDirectorLastRunMs'] = now;

      void import('../comms/director.js').then(async ({ runDirectorCycle }) => {
        try {
          await runDirectorCycle(cfg);
        } catch {
          // Fire-and-forget — director must never crash the daemon.
        }
      }).catch(() => { /* lazy-import best-effort */ });
    } catch {
      // Gate check must never crash the daemon.
    }
  })();

  audit({
    action: 'daemon:tick',
    repo: null,
    sandboxId: null,
    summary: `tick ok: ${selected.length} item(s) considered, ${proposalsCreated} proposal(s) created, ${merged} merged, $${tickSpent.toFixed(4)} spent`,
    result: 'ok',
  });

  return tickRecord;
}

// ---------------------------------------------------------------------------
// runDaemon — the operator loop
// ---------------------------------------------------------------------------

/**
 * Start the daemon operator.
 *
 * REFUSES (returns unchanged state) if ASHLR_IN_DAEMON or ASHLR_IN_SWARM is
 * set — prevents daemon-inside-daemon and daemon-inside-swarm fork bombs.
 *
 * Sets ASHLR_IN_DAEMON=1 on this process.env so all child spawns inherit it.
 *
 * opts.once = true  => run exactly one tick then stop.
 * opts.once = false => loop: tick → sleep intervalMs → tick → ... until kill
 *                      switch is set OR daily budget is exhausted.
 *                      NO unbounded loop — every iteration re-checks both.
 *
 * Never throws.
 */
export async function runDaemon(
  cfg: AshlrConfig,
  opts: { once: boolean; dryRun: boolean; maxCycles?: number },
): Promise<DaemonState> {
  // -------------------------------------------------------------------------
  // RE-ENTRANCY GUARD — must be the very first check.
  // -------------------------------------------------------------------------
  if (process.env['ASHLR_IN_DAEMON'] || process.env['ASHLR_IN_SWARM']) {
    // Refuse silently — do not start; return current state unchanged.
    return loadDaemonState();
  }

  const lockAttempt = acquireDaemonLock();
  if (!lockAttempt.acquired) {
    audit({
      action: 'daemon:start',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: singleton lock busy${lockAttempt.owner ? ` (pid ${lockAttempt.owner.pid})` : ''}`,
      result: 'refused',
    });
    return loadDaemonState();
  }
  const daemonLock = lockAttempt.lock;

  const startLoadedState = loadDaemonStateStrict();
  if (!startLoadedState.ok) {
    releaseDaemonLock(daemonLock);
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: daemon state ${startLoadedState.reason} (${startLoadedState.error})`,
      result: 'refused',
    });
    return loadDaemonState();
  }
  let state = startLoadedState.state;
  if (state.running === true && typeof state.pid === 'number' && state.pid !== process.pid) {
    releaseDaemonLock(daemonLock);
    audit({
      action: 'daemon:start',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: existing live daemon state pid ${state.pid}`,
      result: 'refused',
    });
    return state;
  }

  // -------------------------------------------------------------------------
  // Set ASHLR_IN_DAEMON=1 on THIS process so all child engine spawns inherit it.
  // Snapshot the prior value so it can be restored on exit — without this a
  // second in-process runDaemon call (programmatic reuse / tests) would hit the
  // re-entrancy guard above and silently refuse forever.
  // -------------------------------------------------------------------------
  const prevInDaemon = process.env['ASHLR_IN_DAEMON'];
  process.env['ASHLR_IN_DAEMON'] = '1';

  const dcfg = resolveCfg(cfg);

  // -------------------------------------------------------------------------
  // Mark daemon as running.
  // -------------------------------------------------------------------------
  state = resetDayIfNeeded(state);
  state.running = true;
  state.pid = process.pid;
  state.startedAt = new Date().toISOString();
  const startSave = saveDaemonStateResult(state);
  if (!startSave.ok) {
    releaseDaemonLock(daemonLock);
    if (prevInDaemon === undefined) delete process.env['ASHLR_IN_DAEMON'];
    else process.env['ASHLR_IN_DAEMON'] = prevInDaemon;
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: failed to persist running state (${startSave.error})`,
      result: 'refused',
    });
    return loadDaemonState();
  }
  heartbeatDaemonLock(daemonLock);

  audit({
    action: 'daemon:start',
    repo: null,
    sandboxId: null,
    summary: `daemon started: once=${opts.once}, dryRun=${opts.dryRun}, budget=$${dcfg.dailyBudgetUsd}, intervalMs=${dcfg.intervalMs}`,
    result: 'ok',
  });

  // -------------------------------------------------------------------------
  // H5 CHANGE 1 — WIRE THE ORPHAN SWEEP (crash-leftover reclaim).
  // On daemon start, BEFORE the first tick, reclaim crash-leftover worktrees with
  // a conservative staleMs GREATER than the max swarm wall-clock (ORPHAN_STALE_MS,
  // shared from worktree.ts) so a LIVE in-flight worktree younger than staleMs is
  // NEVER reclaimed — only genuine crash leftovers are swept. Inward cleanup only:
  // sweepOrphanSandboxes routes every removal through removeSandbox, inheriting its
  // containment guards verbatim (re-derived safe path + branch; a tampered/out-of-
  // namespace entry falls through to local-dir cleanup only). It pushes nothing,
  // opens no PR, applies no proposal — it is purely inward worktree reclaim. The
  // worktree module is LAZY-imported so the daemon's STATIC outward-primitive
  // grep-guards stay intact, and the whole thing is wrapped so a sweep failure
  // NEVER throws out of runDaemon. Audited via the daemon:start surface.
  //
  // DRY-RUN = ZERO SIDE EFFECTS: the sweep performs real destructive on-disk git
  // ops (`git worktree remove --force` / `git branch -D` via removeSandbox), so
  // in dry-run mode we SKIP the actual reclaim and instead audit a PREVIEW of
  // what WOULD be reclaimed (count only, via a guarded staleMs-eligible probe),
  // honoring the strict 'dry-run mutates nothing' expectation that the rest of
  // loop.ts upholds (it creates no proposals / makes no outward changes). A
  // normal (non-dry) start reclaims for real. Documented in docs/contracts/CONTRACT-H5.md.
  if (opts.dryRun) {
    // Dry-run previews the loop WITHOUT mutating disk: skip the real reclaim and
    // audit only the count that WOULD be reclaimed (a read-only listSandboxes()
    // count; the actual liveness/age filtering happens for real on a non-dry
    // start). This keeps `daemon start --dry-run` side-effect-free.
    try {
      const wt = await import('../sandbox/worktree.js');
      const wouldConsider = wt.listSandboxes().length;
      audit({
        action: 'daemon:start',
        repo: null,
        sandboxId: null,
        summary: `dry-run: orphan sweep skipped (${wouldConsider} sandbox(es) on disk; none swept)`,
        result: 'ok',
      });
    } catch {
      // Best-effort: a preview failure must never crash daemon start.
    }
  } else {
    try {
      const wt = await import('../sandbox/worktree.js');
      const swept = wt.sweepOrphanSandboxes({ staleMs: wt.ORPHAN_STALE_MS });
      audit({
        action: 'daemon:start',
        repo: null,
        sandboxId: null,
        summary: `orphan sweep reclaimed ${swept.length} sandbox(es)${swept.length ? `: ${swept.join(', ')}` : ''}`,
        result: 'ok',
      });
    } catch {
      // Best-effort: a sweep failure must never crash daemon start.
    }
  }

  try {
    if (opts.once) {
      // Single-tick mode — reload config so a manual tick picks up disk changes.
      let liveCfg = cfg;
      try { liveCfg = { ...cfg, daemon: loadConfig().daemon ?? cfg.daemon }; } catch { liveCfg = cfg; }
      if (heartbeatDaemonLock(daemonLock)) {
        await tick(liveCfg, { dryRun: opts.dryRun });
      }
    } else {
      // M116: choose loop strategy based on mode.
      // Continuous mode: keep dispatching back-to-back with only a short idle
      // backoff when the backlog is empty. Batch mode: existing behavior unchanged.
      const isContinuous = dcfg.mode === 'continuous';

      if (isContinuous) {
        // -----------------------------------------------------------------------
        // M116 CONTINUOUS MODE — saturate the machine.
        // Loop: reload cfg → tick → if backlog empty sleep idleBackoffMs → repeat.
        // Every iteration re-checks kill-switch + budget (same guarantees as batch).
        // NO fixed intervalMs sleep between non-empty ticks — the pool caps keep
        // concurrency safe; we only back off when work runs dry.
        // -----------------------------------------------------------------------
        // maxCycles bounds the loop for testability/safety; production omits it
        // (Infinity) so the daemon runs until kill-switch or budget exhaustion.
        let cyclesLeft = opts.maxCycles ?? Infinity;
        while (true) {
          if (!heartbeatDaemonLock(daemonLock)) break;
          if (cyclesLeft-- <= 0) break;
          if (killSwitchOn()) break;

          let liveCfg = cfg;
          try { liveCfg = { ...cfg, daemon: loadConfig().daemon ?? cfg.daemon }; } catch { liveCfg = cfg; }

          const currentLoaded = loadDaemonStateStrict();
          if (!currentLoaded.ok) {
            audit({
              action: 'daemon:persistence-failed',
              repo: null,
              sandboxId: null,
              summary: `daemon loop stopped: daemon state ${currentLoaded.reason} (${currentLoaded.error})`,
              result: 'refused',
            });
            break;
          }
          const current = currentLoaded.state;
          const recheckCfg = resolveCfg(liveCfg);
          if (current.todaySpentUsd >= recheckCfg.dailyBudgetUsd) break;

          const tickResult = await tick(liveCfg, { dryRun: opts.dryRun });

          if (opts.dryRun) break;

          if (killSwitchOn()) break;
          const afterTickLoaded = loadDaemonStateStrict();
          if (!afterTickLoaded.ok) {
            audit({
              action: 'daemon:persistence-failed',
              repo: null,
              sandboxId: null,
              summary: `daemon loop stopped after tick: daemon state ${afterTickLoaded.reason} (${afterTickLoaded.error})`,
              result: 'refused',
            });
            break;
          }
          const afterTick = afterTickLoaded.state;
          const recheck2 = resolveCfg(liveCfg);
          if (afterTick.todaySpentUsd >= recheck2.dailyBudgetUsd) break;

          // Back off only when the backlog was empty (no work dispatched this tick).
          if (tickResult.itemsConsidered === 0 ||
              tickResult.reason === 'no-backlog' ||
              tickResult.reason === 'no-enrolled-repos') {
            const idleMs = recheck2.idleBackoffMs ?? 5_000;
            await sleep(idleMs);
          }
          // Non-empty tick: immediately loop back — no sleep.

          if (killSwitchOn()) break;
        }
      } else {
        // -----------------------------------------------------------------------
        // BATCH MODE (default) — original behavior, byte-identical.
        // -----------------------------------------------------------------------
        while (true) {
          if (!heartbeatDaemonLock(daemonLock)) break;
          // Kill switch check — halt immediately.
          if (killSwitchOn()) break;

          // M85: reload config from disk each iteration so daemon tuning
          // (budget/parallel/interval/cooldown) takes effect without a restart.
          // Never throws — falls back to the caller cfg's daemon section.
          let liveCfg = cfg;
          try { liveCfg = { ...cfg, daemon: loadConfig().daemon ?? cfg.daemon }; } catch { liveCfg = cfg; }

          // Budget check — halt when daily cap exhausted.
          const currentLoaded = loadDaemonStateStrict();
          if (!currentLoaded.ok) {
            audit({
              action: 'daemon:persistence-failed',
              repo: null,
              sandboxId: null,
              summary: `daemon loop stopped: daemon state ${currentLoaded.reason} (${currentLoaded.error})`,
              result: 'refused',
            });
            break;
          }
          const current = currentLoaded.state;
          const recheckCfg = resolveCfg(liveCfg);
          if (current.todaySpentUsd >= recheckCfg.dailyBudgetUsd) break;

          // Run one tick with the freshly-reloaded config.
          await tick(liveCfg, { dryRun: opts.dryRun });

          // Dry-run is inherently a one-shot PLAN: it records spentUsd:0 forever,
          // so the budget break can never fire. Terminate after a single iteration
          // (matching --once semantics) so a dry-run loop is BOUNDED, not endless.
          if (opts.dryRun) break;

          // Re-check kill switch + budget after the tick before sleeping.
          if (killSwitchOn()) break;
          const afterTickLoaded = loadDaemonStateStrict();
          if (!afterTickLoaded.ok) {
            audit({
              action: 'daemon:persistence-failed',
              repo: null,
              sandboxId: null,
              summary: `daemon loop stopped after tick: daemon state ${afterTickLoaded.reason} (${afterTickLoaded.error})`,
              result: 'refused',
            });
            break;
          }
          const afterTick = afterTickLoaded.state;
          if (afterTick.todaySpentUsd >= recheckCfg.dailyBudgetUsd) break;

          // Sleep between ticks using a bounded interval.
          await sleep(dcfg.intervalMs);
          if (!heartbeatDaemonLock(daemonLock)) break;

          // Final kill-switch check after sleep (in case stop() was called while sleeping).
          if (killSwitchOn()) break;
        }
      }
    }
  } catch {
    // Unexpected error — swallow; still clean up running state below.
  }

  // -------------------------------------------------------------------------
  // Clear running state on exit.
  // -------------------------------------------------------------------------
  const stillOwnsLock = heartbeatDaemonLock(daemonLock);
  const stopLoadedState = loadDaemonStateStrict();
  state = stopLoadedState.ok ? stopLoadedState.state : loadDaemonState();
  if (stillOwnsLock && stopLoadedState.ok && state.pid === process.pid) {
    state.running = false;
    state.pid = null;
    const stopSave = saveDaemonStateResult(state);
    if (!stopSave.ok) {
      audit({
        action: 'daemon:persistence-failed',
        repo: null,
        sandboxId: null,
        summary: `daemon stop could not persist stopped state (${stopSave.error})`,
        result: 'error',
      });
    }
  } else if (stillOwnsLock && !stopLoadedState.ok) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `daemon stop skipped state update: daemon state ${stopLoadedState.reason} (${stopLoadedState.error})`,
      result: 'error',
    });
  }

  audit({
    action: 'daemon:stop',
    repo: null,
    sandboxId: null,
    summary: 'daemon stopped',
    result: 'ok',
  });

  // Restore ASHLR_IN_DAEMON to its prior value so a fresh runDaemon can run
  // again in the same process (a CLI process exits anyway; this matters for
  // programmatic reuse / tests). Child spawns already inherited it during the run.
  if (prevInDaemon === undefined) delete process.env['ASHLR_IN_DAEMON'];
  else process.env['ASHLR_IN_DAEMON'] = prevInDaemon;

  releaseDaemonLock(daemonLock);

  return loadDaemonState();
}

// ---------------------------------------------------------------------------
// stopDaemon — halt the operator
// ---------------------------------------------------------------------------

/**
 * Set the kill switch (M21 ~/.ashlr/KILL) AND mark running=false, pid=null in
 * persisted state. Idempotent; never throws. A running loop sees the kill
 * switch on the next iteration and stops cleanly.
 */
export function stopDaemon(): void {
  try {
    setKill(true);
  } catch {
    // setKill is idempotent + never throws by contract; extra guard
  }
  try {
    const state = loadDaemonState();
    state.running = false;
    state.pid = null;
    saveDaemonState(state);
  } catch {
    // Persistence failure — swallow; kill switch was already set above
  }
  try {
    audit({
      action: 'daemon:stop',
      repo: null,
      sandboxId: null,
      summary: 'stopDaemon() called: kill switch set + running=false',
      result: 'ok',
    });
  } catch {
    // Audit best-effort
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Promise-based sleep (bounded; never less than 0ms). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Build a focused, actionable engine prompt from a WorkItem.
 *
 * Framing goals:
 *  - Lead with the concrete objective so the engine can orient immediately.
 *  - Add scoped context (repo path, source/tags) so it doesn't guess location.
 *  - Append a clean no-op escape hatch so frontier models produce a focused diff
 *    OR cleanly stop — not a forced/garbage edit.
 *
 * Pure: never throws, never mutates item.
 */
export function buildItemGoal(item: WorkItem): string {
  const parts: string[] = [];

  // Objective — always present.
  parts.push(item.title.trim());

  // Detail / context — include when non-empty and not a duplicate of title.
  const detail = (item.detail ?? '').trim();
  if (detail && detail !== item.title.trim()) {
    parts.push(detail);
  }

  // Repo + source anchoring so the engine knows exactly where to look.
  const anchor: string[] = [];
  if (item.repo) anchor.push(`Repo: ${item.repo}`);
  if (item.source) anchor.push(`Source: ${item.source}`);
  if (item.tags && item.tags.length > 0) anchor.push(`Tags: ${item.tags.join(', ')}`);
  if (anchor.length > 0) parts.push(anchor.join(' | '));


  // Behavioral guidance — focused diff OR clean no-op. Keep it tight; the
  // executor role and TITRR already provide broader context.
  parts.push(
    'Make the smallest focused change that fully addresses this. ' +
    'Match existing conventions. Run/keep tests green. ' +
    'If on inspection this is NOT actionable as a code change ' +
    '(e.g. a platform-gated or intentionally-skipped test, an issue requiring ' +
    'product decisions, or already done), make NO changes and stop — ' +
    'do not force an edit.',
  );

  return parts.join('\n\n');
}

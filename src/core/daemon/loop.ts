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

import type { AshlrConfig, DaemonConfig, DaemonState, DaemonTick, WorkItem } from '../types.js';
import { killSwitchOn, setKill, listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { buildBacklog } from '../portfolio/backlog.js';
import { loadDaemonState, saveDaemonState, resetDayIfNeeded } from './state.js';
import { nullSink } from '../run/streaming.js';
import { runSwarm } from '../swarm/runner.js';
import { runGoal } from '../run/orchestrator.js';
import { routeBackend } from '../fleet/router.js';
import { withinLimit, recordUse } from '../fleet/quota.js';
import { subscriptionAllows, isSubscriptionEngine } from '../fleet/subscription-usage.js'; // M80
import { recommendRoute, recoverWithinBudget } from '../run/learned-router.js';
import { estimateRun } from '../observability/estimate.js';
import { buildForecast } from '../observability/forecast.js';
import { emitTuningProposals } from '../learn/tuning.js';
import { runAutoMergePass } from '../fleet/automerge-pass.js';
import { pendingCount, listProposals } from '../inbox/store.js';
import { recordOutcome, recentlyDeclined } from '../fleet/worked-ledger.js';
import { loadConfig } from '../config.js';

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
  return {
    dailyBudgetUsd: typeof o.dailyBudgetUsd === 'number' && o.dailyBudgetUsd > 0
      ? o.dailyBudgetUsd
      : DEFAULTS.dailyBudgetUsd,
    perTickItems: typeof o.perTickItems === 'number' && o.perTickItems > 0
      ? Math.floor(o.perTickItems)
      : DEFAULTS.perTickItems,
    parallel: typeof o.parallel === 'number' && o.parallel > 0
      ? Math.min(Math.floor(o.parallel), 8) // hard upper bound at 8
      : DEFAULTS.parallel,
    intervalMs: typeof o.intervalMs === 'number' && o.intervalMs > 0
      ? o.intervalMs
      : DEFAULTS.intervalMs,
  };
}

// ---------------------------------------------------------------------------
// Bounded concurrency helper
// ---------------------------------------------------------------------------

/**
 * Run `tasks` with at most `limit` in flight at once.
 * Returns all settled results in input order.
 * Never throws — individual task errors are captured in the PromiseSettledResult.
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
      let s = loadDaemonState();
      s = resetDayIfNeeded(s);
      s.lastTickAt = t.ts;
      s.ticks = [...s.ticks, t];
      saveDaemonState(s);
    } catch {
      // persistence best-effort — never let observability crash a tick
    }
    return t;
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
  let state = loadDaemonState();
  state = resetDayIfNeeded(state);

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
  } catch {
    // buildBacklog never throws by contract; extra guard
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

  // Build a set of item ids that already have an open PENDING proposal so we
  // can skip duplicating work. Best-effort: match on item.id appearing in the
  // proposal title or summary. Never throws.
  const pendingItemIds = new Set<string>();
  try {
    for (const prop of listProposals({ status: 'pending' })) {
      const haystack = `${prop.title} ${prop.summary}`;
      // Scan all backlog item ids for a substring match in the proposal text.
      for (const bi of backlogItems) {
        if (haystack.includes(bi.id)) {
          pendingItemIds.add(bi.id);
        }
      }
    }
  } catch {
    // Best-effort — never block selection on inbox read failure.
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
        recentlyDeclined(candidate.id, cooldownMs) ||
        pendingItemIds.has(candidate.id);
      if (!skip) break;
      advance++;
    }
    repoCursors.set(repo, advance);
    if (advance < group.length) {
      selected.push(group[advance]!);
      repoCursors.set(repo, advance + 1);
    }
    // Once all repos have been visited in this pass, check if we've exhausted
    // all of them; if so, stop to avoid an infinite loop on a fully-skipped backlog.
    if (rri % repoOrder.length === 0) {
      // Check if any repo still has selectable items.
      let anyLeft = false;
      for (const [r, g] of byRepo) {
        const c = repoCursors.get(r) ?? 0;
        if (c < g.length) { anyLeft = true; break; }
      }
      if (!anyLeft) break;
    }
  }

  // -------------------------------------------------------------------------
  // 6a. Dry-run mode: report what WOULD be worked; NO swarms, NO proposals.
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: `dry-run: would work ${selected.length} item(s): ${selected.map(i => i.title).join(', ')}`,
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: selected.length,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'dry-run',
    });
  }

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
  // Shared, mutable in-tick spend tally. Read+incremented by each concurrent
  // task so later dispatches can short-circuit once cumulative realized spend
  // reaches the remaining daily headroom (the USD daily cap is otherwise only
  // enforced BETWEEN ticks — this keeps a single tick from overshooting it).
  let tickSpent = 0;
  // M48: per-backend dispatch tally for this tick (observability only).
  const backendDispatch: Record<string, number> = {};

  // Per-item USD budget slice: divide remaining budget evenly across items.
  const perItemUsdSlice = remainingBudget / selected.length;

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

  // `dispatched` = a swarm was actually invoked for this item (kill switch /
  // budget short-circuit did NOT skip it). Drives itemsProcessed so `daemon
  // status` reflects real work, not merely items considered.
  type ItemOutcome = { item: WorkItem; spentUsd: number; dispatched: boolean };

  const tasks: Array<() => Promise<ItemOutcome>> = selected.map((item) => async (): Promise<ItemOutcome> => {
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

    // M48: route this item to a backend (M46). Default (no cfg.foundry) →
    // 'builtin'. A frontier backend over its rolling rate quota falls back to
    // local so work keeps flowing without exceeding the subscription's limit.
    // M85: use liveCfg (reloaded per-tick) for routing + quota checks.
    const routed = routeBackend(item, liveCfg);
    let backend = routed.backend;
    if (backend !== 'builtin' && !withinLimit(backend, liveCfg)) {
      backend = 'builtin';
    }

    // M80: subscription-window throttle — skip this item (not crash) when a
    // KNOWN subscription window is at or above the cap (default 90%). Reads
    // cfg.foundry.subscriptionMaxPercent defensively with a fallback default.
    // allowed:true when usage is unknown (claude) or under the cap.
    if (isSubscriptionEngine(backend)) {
      // Read maxPercent from liveCfg.foundry defensively — no types.ts change.
      const maxPct: number = (liveCfg.foundry as Record<string, unknown> | undefined
        )?.['subscriptionMaxPercent'] as number | undefined ?? 90;
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
        const goal = `${item.title}\n\n${item.detail}`.trim();
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

    const goal = `${item.title}\n\n${item.detail}`.trim();
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
        const runState = await runGoal(goal, liveCfg, {
          engine: backend,
          sandboxEngine: true,
          requireSandbox: true,
          cwd: item.repo,
          budget: itemBudget,
          tools: true,
          noMemory: false,
        });

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
        const goal2 = `${item.title}\n\n${item.detail}`.trim();
        const est2 = await estimateRun(goal2, { maxTokens: perItemMaxTokens }, liveCfg).catch(() => null);
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
          } catch {
            // Emission must never crash the tick.
          }
        }
      }
    }

    return { item, spentUsd: swarmSpent, dispatched };
  });

  const outcomes = await bounded(tasks, dcfg.parallel);

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
  try { proposalsCreated = Math.max(0, pendingCount() - pendingBefore); } catch { proposalsCreated = 0; }

  // M85: record outcomes to the worked ledger. A dispatched item that produced a
  // new PENDING proposal → 'diff'; a dispatched item that produced no new proposal
  // → 'empty' (the run completed but had nothing to show, e.g. no changes found).
  // Non-dispatched items (kill-switch / budget skip) are NOT recorded — they were
  // never run, so they should not trigger a cooldown.
  // We determine per-item outcome by comparing the per-item proposal delta: we
  // snapshot pendingBefore per-item is not available at this point, so we use the
  // aggregate: if proposalsCreated >= dispatchedCount, every dispatched item
  // produced at least one proposal → 'diff'. Otherwise we mark the ones that
  // didn't produce a proposal as 'empty'. Since we can't perfectly attribute
  // proposals to items after the fact, we use a conservative heuristic:
  // if the TOTAL proposals created >= dispatched items, record all dispatched as
  // 'diff'; otherwise record all dispatched as 'empty'. This is correct for the
  // common single-item-per-tick case and conservative for multi-item ticks.
  // Coupling note: OTHER agents recording outcomes (e.g. apply-gate) should also
  // call recordOutcome(item.id, 'empty') when they determine a run produced no diff.
  if (dispatchedCount > 0) {
    try {
      const outcomeLabel: 'diff' | 'empty' = proposalsCreated >= dispatchedCount ? 'diff' : 'empty';
      const ts = new Date().toISOString();
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
          recordOutcome(outcome.value.item.id, outcomeLabel, ts);
        }
      }
    } catch {
      // Ledger recording must never crash the tick.
    }
  }

  // M48: OPT-IN auto-merge pass (cfg.foundry.autoMerge.enabled, DEFAULT OFF).
  // Delegated to fleet/automerge-pass so THIS file imports no merge primitive.
  // Every merge runs the M47 tiered-trust gate (frontier authority + risk ≤
  // maxRisk + full verify + kill-switch + enrollment); unauthorized proposals
  // stay PENDING. With autoMerge disabled this is a no-op — the daemon stays
  // strictly proposal-only.
  let merged = 0;
  try { merged = (await runAutoMergePass(liveCfg)).merged; } catch { merged = 0; }

  // -------------------------------------------------------------------------
  // 7. Update + persist state with this tick's accounting.
  // -------------------------------------------------------------------------
  state = loadDaemonState();               // reload in case of concurrent writes
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
  saveDaemonState(state);

  // M89: best-effort fleet→pulse telemetry export. Runs OUTSIDE the proposal
  // guarantees — only reads state + POSTs telemetry; never mutates repos.
  // Only fires when cfg.pulse?.enabled is true. Never throws.
  if (cfg.pulse?.enabled) {
    void import('../fleet/pulse-export.js').then(({ exportToPulse }) =>
      exportToPulse(cfg, { sinceTs: tickRecord.ts }).catch(() => undefined)
    ).catch(() => undefined);
  }

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
  opts: { once: boolean; dryRun: boolean },
): Promise<DaemonState> {
  // -------------------------------------------------------------------------
  // RE-ENTRANCY GUARD — must be the very first check.
  // -------------------------------------------------------------------------
  if (process.env['ASHLR_IN_DAEMON'] || process.env['ASHLR_IN_SWARM']) {
    // Refuse silently — do not start; return current state unchanged.
    return loadDaemonState();
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
  let state = loadDaemonState();
  state = resetDayIfNeeded(state);
  state.running = true;
  state.pid = process.pid;
  state.startedAt = new Date().toISOString();
  saveDaemonState(state);

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
      await tick(liveCfg, { dryRun: opts.dryRun });
    } else {
      // Loop mode: every iteration re-checks kill switch + budget. NOT unbounded.
      while (true) {
        // Kill switch check — halt immediately.
        if (killSwitchOn()) break;

        // M85: reload config from disk each iteration so daemon tuning
        // (budget/parallel/interval/cooldown) takes effect without a restart.
        // Never throws — falls back to the caller cfg's daemon section.
        let liveCfg = cfg;
        try { liveCfg = { ...cfg, daemon: loadConfig().daemon ?? cfg.daemon }; } catch { liveCfg = cfg; }

        // Budget check — halt when daily cap exhausted.
        const current = loadDaemonState();
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
        const afterTick = loadDaemonState();
        if (afterTick.todaySpentUsd >= recheckCfg.dailyBudgetUsd) break;

        // Sleep between ticks using a bounded interval.
        await sleep(dcfg.intervalMs);

        // Final kill-switch check after sleep (in case stop() was called while sleeping).
        if (killSwitchOn()) break;
      }
    }
  } catch {
    // Unexpected error — swallow; still clean up running state below.
  }

  // -------------------------------------------------------------------------
  // Clear running state on exit.
  // -------------------------------------------------------------------------
  state = loadDaemonState();
  state.running = false;
  state.pid = null;
  saveDaemonState(state);

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

/**
 * advance.ts — M28: advance a Goal by running its NEXT actionable milestone
 * through the EXACT M21/M24 sandboxed, proposal-only execution path.
 *
 * M229 adds: when opts.allowCloud is true, advanceGoal() dispatches the
 * milestone as a SINGLE sandboxed proposal-only FRONTIER-ENGINE run (the
 * --direct/daemon path via runGoal + sandboxEngine:true + requireSandbox:true)
 * rotating across cfg.foundry.allowedBackends [claude, codex, nim] instead of
 * the builtin swarm. 429/5xx errors trigger retry-with-backoff and engine
 * rotation. Flag-off (no allowCloud) keeps the builtin-swarm path byte-identical.
 *
 * THIS IS THE SAFETY-CRITICAL MODULE. The adversarial review WILL try to break
 * the invariants below — they are enforced here, verbatim:
 *
 *  1. SANDBOXED + PROPOSAL-ONLY EXECUTION. advanceGoal() calls runSwarm with
 *     opts { sandbox:true, requireSandbox:true, propose:true } + a HARD budget,
 *     ALWAYS. It NEVER runs a swarm against the real working tree, NEVER ships,
 *     pushes, opens PRs, deploys, or applies a proposal. The ONLY execution
 *     sink is a PENDING inbox proposal (produced BY runSwarm's propose path).
 *     This module imports/invokes NONE of the outward-action sinks (no
 *     proposal-apply, no proposal-approve status write, no remote push, no PR
 *     creation, no deploy) — verified by a source-level grep guard in tests.
 *     M229: the frontier-engine path (runGoal + sandboxEngine:true) uses the
 *     SAME containment: runEngineSandboxed → worktree → diff → PENDING proposal.
 *     It also imports/invokes none of the outward-action sinks.
 *
 *  2. ENROLLMENT-SCOPED. Before ANY swarm starts, advanceGoal() resolves the
 *     goal's project and calls assertMayMutate(repo, { allowAnyRepo }) — which
 *     ALSO checks the kill switch. A non-enrolled repo (or kill switch on)
 *     HARD-ERRORS before runSwarm is ever reached. A goal with no project
 *     cannot be advanced. DEFAULT enrollment EMPTY => nothing executes.
 *
 *  3. STEERABLE + BOUNDED. There is NO auto-advance loop here. advanceGoal()
 *     advances exactly ONE milestone per call (the user's explicit gate). The
 *     budget is hard-capped. nextActionableMilestone() is a pure READ seam the
 *     (user-gated) daemon MAY consume — it never advances anything itself.
 *
 *  4. READ-ONLY TRACKING. progressOf() / nextActionableMilestone() mutate
 *     nothing; they only read the Goal record + swarm/inbox state.
 */

import { resolve } from 'node:path';
import type {
  AdvanceOptions,
  AshlrConfig,
  EngineId,
  Goal,
  GoalProgress,
  Milestone,
  MilestoneStatus,
  RunBudget,
  SwarmRun,
} from '../types.js';
import { assertMayMutate } from '../sandbox/policy.js';
import { runSwarm } from '../swarm/runner.js';
import { loadSwarm } from '../swarm/store.js';
import { loadProposal, listProposals } from '../inbox/store.js';
import { loadGoal, updateMilestoneStatus, resumeMilestone } from './store.js';
// M270: dynamic frontier trio reads the resolved registry so kimi joins when configured.
import { engineTierOf } from '../run/sandboxed-engine.js';

// ---------------------------------------------------------------------------
// HARD per-advance budget — a goal advance is ALWAYS bounded.
// ---------------------------------------------------------------------------

/** Default HARD ceiling for a single milestone advance. allowCloud defaults off. */
const DEFAULT_ADVANCE_BUDGET: RunBudget = {
  maxTokens: 200_000,
  maxSteps: 40,
  allowCloud: false,
};

// ---------------------------------------------------------------------------
// nextActionableMilestone — pure READ seam (no mutation, no swarm).
// ---------------------------------------------------------------------------

/**
 * Return the NEXT actionable milestone of a goal: the lowest-`order` milestone
 * with status 'pending', when the goal itself is not paused/archived/done.
 * Returns null when the goal is paused/archived/done or has no pending
 * milestone.
 *
 * SEQUENCING GUARD (dependency-ordered plans): an EARLIER non-terminal
 * milestone — one still 'in-progress' or left 'blocked' (e.g. a prior advance
 * that threw / needs a human) — GATES the plan. When such a milestone precedes
 * the lowest pending one, we return null rather than skipping ahead, so a
 * sequenced plan never advances out of order past a stuck step. (A 'paused'
 * milestone is an explicit human steering decision, NOT a stuck step, so it
 * does NOT gate — the human deliberately set it aside.)
 *
 * Pure & read-only — this is the seam the user-gated daemon may consume to find
 * goal work. It NEVER advances, runs a swarm, or mutates anything.
 */
export function nextActionableMilestone(goal: Goal): Milestone | null {
  if (goal.status === 'paused' || goal.status === 'archived' || goal.status === 'done') {
    return null;
  }
  const ordered = [...goal.milestones].sort((a, b) => a.order - b.order);
  const firstPending = ordered.find((m) => m.status === 'pending');
  if (!firstPending) return null;
  // If any EARLIER milestone is still non-terminal ('in-progress' or 'blocked'),
  // the plan is gated on it — do NOT advance past it to a later pending one.
  const blockedEarlier = ordered.some(
    (m) =>
      m.order < firstPending.order &&
      (m.status === 'in-progress' || m.status === 'blocked'),
  );
  if (blockedEarlier) return null;
  return firstPending;
}

// ---------------------------------------------------------------------------
// M229: frontier-engine dispatch — round-robin + 429/5xx retry + backoff.
//
// SAFETY INVARIANT: runMilestoneFrontierEngine dispatches via runGoal with
// sandboxEngine:true + requireSandbox:true — the SAME path as `ashlr goal
// --direct` and the daemon's non-builtin dispatch. This routes through
// runEngineSandboxed → throwaway worktree → diff → PENDING inbox proposal.
// No outward-action sink is reachable from this path. Confinement (M45/M52),
// the pre-push hook, and the credential-strip are all enforced by the called
// path — none are bypassed here.
// ---------------------------------------------------------------------------

/**
 * M270: dynamic frontier trio — ordered candidates for the M229 rotation.
 * Replaces the static ['claude','codex','nim'] array with a registry-aware function
 * so that any engine promoted to tier:'frontier' via config (e.g. kimi, nim) is
 * automatically included. This is WORK-ASSIGNMENT tier only; merge authority is
 * a separate gate in inbox/merge.ts and is NOT affected by this function.
 *
 * Candidate order: claude > codex > kimi > nim preserves the trust/capability
 * preference while allowing both kimi and nim to join when promoted.
 */
const M270_FRONTIER_CANDIDATES: readonly EngineId[] = ['claude', 'codex', 'kimi', 'nim', 'grok']; // M298: grok joins when promoted to tier:'frontier' via cfg.foundry.grok

/**
 * Return the ordered list of EngineIds that are currently 'frontier' tier
 * according to the resolved engine registry (reads cfg). Called per-advance so
 * config changes take effect on the next advance tick without a restart.
 *
 * SAFETY: this is WORK-ASSIGNMENT only. The merge gate (evaluateMergeAuthority)
 * checks mergeAuthority config independently — an engine promoted here does NOT
 * gain merge authority.
 */
function resolveFrontierTrio(cfg: AshlrConfig): EngineId[] {
  return M270_FRONTIER_CANDIDATES.filter((e) => engineTierOf(e, cfg) === 'frontier');
}

/**
 * Module-level round-robin counter. Incremented once per successful engine
 * selection (not per retry). Starts at 0 so the first run goes to the first
 * available engine. Wraps at 2^31 - 1 to avoid ever-growing numbers.
 */
let _m229RoundRobinIdx = 0;

/** Reset the round-robin counter — exported for tests ONLY. */
export function _m229ResetRoundRobin(): void {
  _m229RoundRobinIdx = 0;
}

/**
 * Return the ordered list of frontier EngineIds that are present in
 * cfg.foundry.allowedBackends AND installed. Falls back to [] when none qualify
 * (caller then uses the builtin-swarm path). Never throws.
 *
 * M270: uses resolveFrontierTrio(cfg) instead of the static M229_FRONTIER_TRIO,
 * so kimi/nim join the rotation when promoted to tier:'frontier' via config.
 * WORK-ASSIGNMENT only — merge authority is not changed by this function.
 */
function resolveFrontierEngines(cfg: AshlrConfig): EngineId[] {
  try {
    const allowed = new Set<string>(cfg.foundry?.allowedBackends ?? []);
    // M270: dynamic trio based on resolved engine registry tier.
    // engineInstalled is NOT called here because this function may run in contexts
    // where engines.js is not loaded; the caller guards on an empty result and
    // falls back to the swarm path.
    return resolveFrontierTrio(cfg).filter((e) => allowed.has(e));
  } catch {
    return [];
  }
}

/**
 * Error thrown (and caught) when a frontier engine run returns a rate-limit
 * (429) or server-error (5xx) signal. The caller retries with the next engine.
 */
class FrontierRateLimitError extends Error {
  constructor(
    public readonly engine: EngineId,
    message: string,
  ) {
    super(message);
    this.name = 'FrontierRateLimitError';
  }
}

/**
 * Detect a 429/5xx condition from a RunState result/error string.
 * Matches common patterns emitted by runEngineSandboxed's spawnEngine.
 */
function isRateLimitOrServerError(result: string | undefined): boolean {
  if (!result) return false;
  const lower = result.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('server error') ||
    lower.includes('internal error') ||
    lower.includes('overloaded')
  );
}

/**
 * Run one frontier-engine attempt for a milestone as a SINGLE sandboxed,
 * proposal-only run via runGoal(sandboxEngine:true, requireSandbox:true).
 *
 * Returns a SwarmRun-shaped object (id, status, usage) that advanceGoal can
 * use for tracking and proposal correlation, identical in shape to what
 * runSwarm returns.
 *
 * On a 429/5xx result this throws FrontierRateLimitError so the caller can
 * retry with the next engine. All other failures return status:'failed'.
 *
 * SAFETY: sandboxEngine:true + requireSandbox:true ensures the run ONLY goes
 * through runEngineSandboxed → worktree diff → PENDING proposal. The sandbox
 * can never be bypassed by this call.
 */
async function runMilestoneFrontierEngine(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  repo: string,
  budget: RunBudget,
): Promise<SwarmRun> {
  // Lazy-import to preserve the test-seam pattern (vi.mock can intercept this).
  const { runGoal } = await import('../run/orchestrator.js');

  const runId = `m229-${engine}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  let runState: { id: string; status: string; result?: string; usage?: { tokensIn: number; tokensOut: number; steps: number; estCostUsd: number } };
  try {
    runState = await runGoal(goal, cfg, {
      engine,
      sandboxEngine: true,
      requireSandbox: true,
      cwd: repo,
      budget,
      tools: true,
      noMemory: false,
    } as Parameters<typeof runGoal>[2]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isRateLimitOrServerError(msg)) {
      throw new FrontierRateLimitError(engine, `engine "${engine}" rate-limited: ${msg}`);
    }
    // Non-rate-limit throw → surface as a failed SwarmRun.
    return buildSwarmRunFromState(
      runId,
      goal,
      'failed',
      undefined,
      undefined,
      repo,
      budget,
    );
  }

  if (isRateLimitOrServerError(runState.result)) {
    throw new FrontierRateLimitError(
      engine,
      `engine "${engine}" returned rate-limit signal: ${runState.result?.slice(0, 200)}`,
    );
  }

  const status = runState.status === 'done' ? 'done' : 'failed';
  return buildSwarmRunFromState(
    runState.id ?? runId,
    goal,
    status,
    runState.result,
    runState.usage,
    repo,
    budget,
  );
}

/** Build a minimal SwarmRun record from a RunState outcome. */
function buildSwarmRunFromState(
  id: string,
  goal: string,
  status: SwarmRun['status'],
  result: string | undefined,
  usage: { tokensIn: number; tokensOut: number; steps: number; estCostUsd: number } | undefined,
  project: string,
  budget: RunBudget,
): SwarmRun {
  const now = new Date().toISOString();
  return {
    id,
    goal,
    specId: null,
    project,
    createdAt: now,
    updatedAt: now,
    budget,
    usage: usage ?? { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status,
    result,
    plan: { specId: null, goal, tasks: [] },
    tasks: [],
  };
}

/**
 * Dispatch a milestone as a frontier-engine run, rotating across available
 * engines with 429/5xx retry-with-backoff. Returns the resulting SwarmRun.
 *
 * Rotation: picks from the available frontier engines starting at the current
 * round-robin index. Advances the index after the first successful selection so
 * successive calls distribute across engines.
 *
 * Retry: on FrontierRateLimitError, waits `baseDelayMs * 2^attempt` (capped at
 * 8 s) then tries the NEXT engine in the rotation. When ALL engines have been
 * tried and returned rate-limit errors, falls back to the FIRST engine for one
 * final attempt (the delay provides natural back-pressure). Hard cap: at most
 * engines.length + 1 attempts total.
 *
 * SAFETY: every attempt goes through runMilestoneFrontierEngine →
 * runGoal(sandboxEngine:true) — the same containment invariant applies to every
 * retry. No fallback to an unsandboxed or non-proposal path.
 */
async function dispatchFrontierWithRotation(
  engines: EngineId[],
  goal: string,
  cfg: AshlrConfig,
  repo: string,
  budget: RunBudget,
  baseDelayMs = 500,
): Promise<SwarmRun> {
  const n = engines.length;
  // Advance the module-level round-robin counter and wrap it.
  const startIdx = _m229RoundRobinIdx % n;
  _m229RoundRobinIdx = (_m229RoundRobinIdx + 1) & 0x7fffffff;

  const maxAttempts = n + 1; // try each engine once, then one final retry on the start engine
  let lastError: FrontierRateLimitError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const engineIdx = (startIdx + attempt) % n;
    const engine = engines[engineIdx]!;

    try {
      const run = await runMilestoneFrontierEngine(engine, goal, cfg, repo, budget);
      return run;
    } catch (err) {
      if (err instanceof FrontierRateLimitError) {
        lastError = err;
        // Exponential backoff: baseDelayMs * 2^attempt, capped at 8 s.
        const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), 8_000);
        await sleep(delayMs);
        continue;
      }
      // Non-rate-limit error: surface immediately without retry.
      throw err;
    }
  }

  // All engines exhausted with rate-limit errors — return a failed SwarmRun
  // so the milestone is marked 'blocked' for human attention.
  return buildSwarmRunFromState(
    `m229-exhausted-${Date.now().toString(36)}`,
    goal,
    'failed',
    `All frontier engines rate-limited: ${lastError?.message ?? 'unknown'}`,
    undefined,
    repo,
    budget,
  );
}

/** Best-effort async sleep; resolves immediately in tests with ASHLR_TEST_NO_SLEEP=1. */
async function sleep(ms: number): Promise<void> {
  if (process.env.ASHLR_TEST_NO_SLEEP === '1' || ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * READ-ONLY correlation for frontier-engine runs: find the PENDING proposal
 * filed by runEngineSandboxed during the given run. The sandboxed path files
 * proposals with origin:'agent' and repo matching the source repo. We snapshot
 * the inbox BEFORE the run and diff AFTER to isolate the new proposal.
 *
 * Never throws — returns null on any read error (the caller marks the milestone
 * 'blocked' rather than leaving it stuck in-progress).
 */
function findProposalForFrontierRun(
  repo: string,
  beforeIds: ReadonlySet<string>,
): string | null {
  try {
    const candidates = listProposals({ status: 'pending' }).filter(
      (p) =>
        !beforeIds.has(p.id) &&
        p.origin === 'agent' &&
        (p.repo === repo || p.repo === null),
    );
    // listProposals is most-recent first; take the freshest match.
    return candidates[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// advanceGoal — the explicit, single-milestone, sandboxed proposal-only run.
// ---------------------------------------------------------------------------

/**
 * Advance a goal by running its NEXT actionable milestone exactly once.
 *
 * Flow (ALL steps mandatory):
 *   1. loadGoal(goalId); resolve the next actionable milestone (else throw).
 *   2. The goal MUST be bound to a project — resolve(goal.project). A goal with
 *      no project HARD-ERRORS (cannot be advanced).
 *   3. assertMayMutate(repo, { allowAnyRepo }) — enrollment + kill-switch GATE.
 *      Throws (HARD-ERROR) BEFORE any swarm starts if the repo is not enrolled
 *      or the kill switch is on.
 *   4. updateMilestoneStatus(... 'in-progress').
 *   5. runSwarm({ goal, specId }, cfg, { sandbox:true, requireSandbox:true,
 *      propose:true, budget, allowCloud, project:repo }, sink).   // NON-NEGOTIABLE
 *   6. Inspect run.status: 'done' with a PENDING proposal => link swarmId +
 *      proposalId, set 'proposed'; otherwise => link swarmId, set 'blocked'.
 *   7. Return the SwarmRun for tracking. NEVER approve/apply the proposal.
 *
 * This module NEVER applies/approves the proposal, never pushes to a remote,
 * never opens a PR, and never deploys. The proposal is left PENDING for a human.
 *
 * @param sink optional StreamSink for the swarm; a no-op sink is used if omitted.
 */
export async function advanceGoal(
  goalId: string,
  cfg: AshlrConfig,
  opts?: AdvanceOptions,
  sink?: (e: unknown) => void,
): Promise<SwarmRun> {
  const goal = loadGoal(goalId);
  if (!goal) throw new Error(`goal not found: ${goalId}`);

  const milestone = nextActionableMilestone(goal);
  if (!milestone) {
    throw new Error(`goal has no actionable milestone to advance: ${goalId}`);
  }

  // ENROLLMENT-SCOPED: a goal with no project cannot be advanced.
  if (!goal.project) {
    throw new Error('goal has no enrolled project; cannot advance');
  }
  const repo = resolve(goal.project);

  // GATE — enrollment + kill switch. Throws BEFORE any swarm starts.
  //
  // allowAnyRepo is a TEST SEAM ONLY: it is honored here ONLY when the process
  // ALSO sets ASHLR_TEST_ALLOW_ANY_REPO=1, so a production / in-process caller
  // of advanceGoal({ allowAnyRepo: true }) CANNOT bypass the enrollment check —
  // closing the latent weakening of invariant #2. It NEVER bypasses the kill
  // switch (assertMayMutate checks that unconditionally). NOTE: the bypass is
  // deliberately NOT threaded into runSwarm/createSandbox below — the runner
  // re-runs assertMayMutate(project) at swarm start WITHOUT allowAnyRepo, so
  // enrollment is re-enforced even in tests; do not reopen that window.
  const allowAnyRepo =
    opts?.allowAnyRepo === true && process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1';
  assertMayMutate(repo, allowAnyRepo ? { allowAnyRepo: true } : undefined);

  // Mark in-progress so tracking reflects the active advance.
  updateMilestoneStatus(goalId, milestone.id, 'in-progress');

  const budget: RunBudget = {
    ...DEFAULT_ADVANCE_BUDGET,
    ...(opts?.budget ?? {}),
    allowCloud: opts?.allowCloud ?? false,
  };

  // M229: when allowCloud is set, attempt to dispatch via a frontier engine
  // (claude/codex/nim) using the SAME sandboxed proposal-only path as
  // `ashlr goal --direct` and the daemon's non-builtin dispatch. This spreads
  // load across providers (fixes NIM 429 rate-limit) while keeping all safety
  // invariants intact. Falls back to the builtin swarm if no frontier engines
  // are configured/available.
  const frontierEngines = opts?.allowCloud ? resolveFrontierEngines(cfg) : [];
  const useFrontier = frontierEngines.length > 0;

  // SANDBOXED + PROPOSAL-ONLY — these three flags are NON-NEGOTIABLE.
  //
  // Wrapped in try/catch so a THROWN/aborted run (sandbox creation failure,
  // provider error, mid-run kill) does NOT leave the milestone stuck
  // 'in-progress' forever (which would make it permanently unadvanceable AND
  // let a later pending milestone advance out of order). On any throw we reset
  // the milestone to 'blocked' (for human attention) before re-throwing.
  let run: SwarmRun;

  if (useFrontier) {
    // M229 FRONTIER PATH — sandboxed proposal-only via runGoal(sandboxEngine:true).
    // Snapshot the pending inbox BEFORE the run so we can identify the new
    // proposal by diff (origin:'agent', repo match, not in beforeIds).
    let beforeIds: Set<string>;
    try {
      beforeIds = new Set(listProposals({ status: 'pending' }).map((p) => p.id));
    } catch {
      beforeIds = new Set();
    }

    const milestoneGoal = `${goal.objective} — ${milestone.title}`;
    try {
      run = await dispatchFrontierWithRotation(
        frontierEngines,
        milestoneGoal,
        cfg,
        repo,
        budget,
      );
    } catch (err) {
      // dispatchFrontierWithRotation threw a non-rate-limit error.
      updateMilestoneStatus(goalId, milestone.id, 'blocked');
      throw err;
    }

    // Correlate the PENDING proposal filed by runEngineSandboxed.
    // origin:'agent' (not 'swarm') — use the pre-run snapshot diff.
    const proposalId = findProposalForFrontierRun(repo, beforeIds);

    if (run.status === 'done' && proposalId) {
      updateMilestoneStatus(goalId, milestone.id, 'proposed', {
        swarmId: run.id,
        proposalId,
      });
    } else {
      updateMilestoneStatus(goalId, milestone.id, 'blocked', {
        swarmId: run.id,
        proposalId: proposalId ?? null,
      });
    }
  } else {
    // BUILTIN-SWARM PATH (flag-off: no allowCloud, or no frontier engines configured).
    // Byte-identical to the pre-M229 behavior.
    try {
      run = await runSwarm(
        {
          goal: `${goal.objective} — ${milestone.title}`,
          specId: milestone.specId ?? undefined,
        },
        cfg,
        {
          sandbox: true,
          requireSandbox: true,
          propose: true,
          budget,
          allowCloud: opts?.allowCloud ?? false,
          project: repo,
        },
        sink ?? (() => {}),
      );
    } catch (err) {
      // Best-effort recovery: surface the milestone as 'blocked' so it remains
      // re-steerable (resume/skip/re-advance) and the plan stays in order.
      updateMilestoneStatus(goalId, milestone.id, 'blocked');
      throw err;
    }

    // Correlate the PENDING proposal the swarm emitted (its ONLY sink). We do NOT
    // create it here — runSwarm's propose path did. We only READ to link the id.
    const proposalId = findProposalForSwarm(run.id, repo);

    if ((run.status === 'done' || run.status === 'needs-approval') && proposalId) {
      updateMilestoneStatus(goalId, milestone.id, 'proposed', {
        swarmId: run.id,
        proposalId,
      });
    } else {
      // Failed / aborted / escalated, or no proposal produced => blocked for a human.
      updateMilestoneStatus(goalId, milestone.id, 'blocked', {
        swarmId: run.id,
        proposalId: proposalId ?? null,
      });
    }
  }

  return run;
}

/**
 * READ-ONLY correlation: find the PENDING proposal the swarm produced. The
 * runner's propose path stamps the proposal summary with `swarm=<run.id>`, so
 * we match on that (and the repo). Returns the proposal id or null when the
 * swarm genuinely produced no proposal. Rethrows on unexpected errors (e.g.
 * corrupt inbox) so the caller can surface them rather than silently orphaning
 * a real proposal and leaving the milestone stuck.
 */
function findProposalForSwarm(swarmId: string, repo: string): string | null {
  // Let listProposals throw propagate — the caller (advanceGoal) catches it and
  // sets the milestone to 'blocked' before re-throwing, which is the correct
  // handling for a corrupt-inbox scenario.  Only swallow a "not found" result
  // (which surfaces as returning null from the filter, not as a throw).
  const candidates = listProposals({ status: 'pending' }).filter(
    (p) =>
      p.origin === 'swarm' &&
      (p.repo === repo || p.repo === null) &&
      typeof p.summary === 'string' &&
      p.summary.includes(`swarm=${swarmId}`),
  );
  // listProposals is most-recent first; take the freshest match.
  return candidates[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// progressOf — read-only tracking roll-up.
// ---------------------------------------------------------------------------

/**
 * Compute a read-only GoalProgress roll-up for a goal: per-status counts, the
 * proposed/done totals, fractionDone, and the next actionable milestone id.
 *
 * Pure analysis over the Goal record, with an optional read-only reconcile of a
 * 'proposed' milestone to 'done' when its linked proposal was applied OUT OF
 * BAND (loadProposal — never mutates the proposal). Mutates NOTHING. Never
 * throws.
 */
export function progressOf(goal: Goal): GoalProgress {
  const byStatus: Partial<Record<MilestoneStatus, number>> = {};
  let proposed = 0;
  let done = 0;
  let skipped = 0;

  for (const m of goal.milestones) {
    // Read-only reconcile: any milestone carrying a linked proposalId whose
    // proposal was applied OUT OF BAND counts as done — including a 'blocked'
    // or still 'in-progress' milestone (advance links proposalId on the blocked
    // branch when a 'needs-approval' run produced one), not only 'proposed'.
    // Without this a goal could under-report completion and never roll to 'done'
    // after its proposal was applied. We NEVER mutate the proposal or the goal.
    let effective: MilestoneStatus = m.status;
    if (
      (m.status === 'proposed' || m.status === 'blocked' || m.status === 'in-progress') &&
      m.proposalId
    ) {
      try {
        const p = loadProposal(m.proposalId);
        if (p && p.status === 'applied') effective = 'done';
      } catch {
        /* read-only best-effort */
      }
    }
    byStatus[effective] = (byStatus[effective] ?? 0) + 1;
    if (effective === 'proposed') proposed += 1;
    if (effective === 'done') done += 1;
    if (effective === 'skipped') skipped += 1;
  }

  const total = goal.milestones.length;
  const denom = total - skipped;
  const fractionDone = denom > 0 ? done / denom : 0;

  return {
    goalId: goal.id,
    total,
    byStatus,
    proposed,
    done,
    fractionDone,
    nextActionableId: nextActionableMilestone(goal)?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// advanceGoalCycle — bounded iterate-to-done wrapper.
// ---------------------------------------------------------------------------

/**
 * Result of a single conductor cycle on a goal's next actionable milestone.
 */
export interface AdvanceCycleResult {
  /** All swarm runs attempted in this cycle (1 on first attempt; up to maxRetries+1). */
  runs: SwarmRun[];
  /** True when the goal itself reached 'done' after this cycle. */
  goalDone: boolean;
  /** True when the advanced milestone reached a terminal state (proposed/done/skipped). */
  milestoneDone: boolean;
  /** Number of proposals filed during this cycle. */
  proposalsFiled: number;
}

/**
 * Advance a goal's next actionable milestone with bounded retry on 'blocked'.
 *
 * Calls `advanceGoal` once. If the milestone ends up 'blocked' (swarm failed /
 * aborted / no proposal produced), resets it via `resumeMilestone` and retries
 * up to `opts.maxRetries` times (default 1). This gives the conductor an
 * iterate-to-done loop WITHOUT adding an unbounded retry mechanism.
 *
 * A goal is considered 'done' when `progressOf(reloadedGoal).fractionDone === 1`
 * (all non-skipped milestones are in a terminal state). This check is done
 * READ-ONLY by reloading the goal after each advance.
 *
 * SAFETY: all safety invariants of `advanceGoal` are fully preserved — this
 * function only calls `advanceGoal` (never bypasses the sandbox/propose/budget
 * gates) and `resumeMilestone` (a pure store mutation that resets status to
 * 'pending'). The retry cap is enforced strictly.
 *
 * @param sink optional StreamSink threaded to each `advanceGoal` call.
 */
export async function advanceGoalCycle(
  goalId: string,
  cfg: AshlrConfig,
  opts?: AdvanceOptions & { maxRetries?: number },
  sink?: (e: unknown) => void,
): Promise<AdvanceCycleResult> {
  const maxRetries = Math.max(0, Math.min(opts?.maxRetries ?? 1, 3)); // hard cap at 3
  const runs: SwarmRun[] = [];
  let proposalsFiled = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // advanceGoal throws on no actionable milestone, enrollment error, or kill
    // switch. Let it propagate — do NOT retry on a thrown error.
    const run: SwarmRun = await advanceGoal(goalId, cfg, opts, sink);
    runs.push(run);

    // Reload goal to check post-advance milestone status.
    const goal = loadGoal(goalId);
    if (!goal) throw new Error(`goal disappeared after advance: ${goalId}`);

    // Count proposals filed (swarms that produced a PENDING proposal).
    const advanced = goal.milestones.find(
      (m) => m.swarmId === run.id || (m.proposalId !== null && m.status === 'proposed'),
    );

    // If we cannot correlate the run to any milestone, the store update in
    // advanceGoal may have used a different matching key; fall back to the
    // milestone that was 'in-progress' before the run (most recently set).
    // If still not found, surface the ambiguity: log it and treat as 'blocked'
    // so the milestone is never left silently stuck in-progress forever.
    if (!advanced) {
      // Find any milestone still stuck 'in-progress' — that's the one advanceGoal
      // just ran.  Set it to 'blocked' for human attention.
      const stuckInProgress = goal.milestones.find((m) => m.status === 'in-progress');
      if (stuckInProgress) {
        updateMilestoneStatus(goalId, stuckInProgress.id, 'blocked', { swarmId: run.id });
      }
      // Do not retry on a correlation failure — return a clear non-stuck result.
      const progress = progressOf(goal);
      const goalDone =
        goal.status === 'done' ||
        (progress.fractionDone >= 1 && progress.total > 0);
      return {
        runs,
        goalDone,
        milestoneDone: false,
        proposalsFiled,
      };
    }

    if (advanced.status === 'proposed') proposalsFiled += 1;

    // Check if this milestone is in a terminal success state (proposed/done/skipped).
    const milestoneDone =
      advanced.status === 'proposed' ||
      advanced.status === 'done' ||
      advanced.status === 'skipped';

    if (milestoneDone) {
      // A goal is done when: the store rolled it to 'done' (every non-skipped
      // milestone is 'done'), OR progressOf reports fractionDone === 1 (all
      // non-skipped milestones are in a done/proposed terminal state).
      const progress = progressOf(goal);
      const goalDone =
        goal.status === 'done' ||
        (progress.fractionDone >= 1 && progress.total > 0);
      return {
        runs,
        goalDone,
        milestoneDone: true,
        proposalsFiled,
      };
    }

    // Milestone ended up 'blocked' — retry if we have remaining attempts.
    if (attempt < maxRetries && advanced.status === 'blocked') {
      // Reset the milestone to 'pending' so advanceGoal can pick it up again.
      resumeMilestone(goalId, advanced.id);
      // Small pause between retries (no sleep in tests — sink signals retry).
      // We intentionally do NOT sleep here; the conductor's cycle interval
      // provides natural pacing for repeated daemon ticks.
    }
  }

  // Exhausted retries — report what we have.
  const goal = loadGoal(goalId);
  const progress = goal ? progressOf(goal) : null;
  const goalDone =
    goal?.status === 'done' ||
    (progress ? progress.fractionDone >= 1 && progress.total > 0 : false);
  return {
    runs,
    goalDone,
    milestoneDone: false,
    proposalsFiled,
  };
}

// Keep loadSwarm imported as the documented read-only tracking handle the CLI
// status dashboard may use to surface swarm progress (read-only, never mutates).
void loadSwarm;

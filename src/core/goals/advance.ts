/**
 * advance.ts — M28: advance a Goal by running its NEXT actionable milestone
 * through the EXACT M21/M24 sandboxed, proposal-only execution path.
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
import { loadGoal, updateMilestoneStatus } from './store.js';

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

  // SANDBOXED + PROPOSAL-ONLY — these three flags are NON-NEGOTIABLE.
  //
  // Wrapped in try/catch so a THROWN/aborted runSwarm (sandbox creation
  // failure, provider error, mid-run kill) does NOT leave the milestone stuck
  // 'in-progress' forever (which would make it permanently unadvanceable AND
  // let a later pending milestone advance out of order). On any throw we reset
  // the milestone to 'blocked' (for human attention) before re-throwing.
  let run: SwarmRun;
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

  return run;
}

/**
 * READ-ONLY correlation: find the PENDING proposal the swarm produced. The
 * runner's propose path stamps the proposal summary with `swarm=<run.id>`, so
 * we match on that (and the repo). Returns the proposal id or null. Never
 * mutates — pure read of the inbox.
 */
function findProposalForSwarm(swarmId: string, repo: string): string | null {
  try {
    const candidates = listProposals({ status: 'pending' }).filter(
      (p) =>
        p.origin === 'swarm' &&
        (p.repo === repo || p.repo === null) &&
        typeof p.summary === 'string' &&
        p.summary.includes(`swarm=${swarmId}`),
    );
    // listProposals is most-recent first; take the freshest match.
    return candidates[0]?.id ?? null;
  } catch {
    return null;
  }
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

// Keep loadSwarm imported as the documented read-only tracking handle the CLI
// status dashboard may use to surface swarm progress (read-only, never mutates).
void loadSwarm;

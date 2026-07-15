/**
 * test/h2.swarm-resume.test.ts — H2 BUILD task 1: CLEAN-RESUME of a crashed swarm.
 *
 * MILESTONE H2 "Harden & Prove" — CRASH RECOVERY & RESUMABILITY. This suite
 * proves the REAL resume path (`runSwarm(..., { resumeId })`, runner.ts ~1224)
 * picks up a swarm that a crash left at status 'running' with partial tasks, and
 * that recovery is CLEAN:
 *
 *   - RESUME-FROM-PERSISTED-STATE: a swarm persisted at 'running' with some
 *     tasks 'done' and the rest 'pending' is loadable + resumable; the runner
 *     SKIPS already-'done' tasks (executeTask returns 'continue' on done) and
 *     does NOT re-plan (plan.tasks already present) — no model dependency.
 *   - NO-STUCK-SWARM: after recovery the run reaches a TERMINAL status
 *     ('done'/'failed'/'aborted'/'needs-approval'), never trapped at 'running'.
 *   - DETERMINISTIC: the inner task executor (runGoal via the engine) is the
 *     only model-touching surface; this suite keeps it model-free by MOCKING
 *     orchestrator.runGoal (matching the m12 runner-test convention) so a
 *     resumed pending task runs a known, no-network, no-model stub, and the
 *     planner (planSwarm) is spied to PROVE it is never re-invoked on resume.
 *
 * SAFETY (inherited from H1, paramount): FRESH isolated tmp HOME per test;
 * DISPOSABLE git repos only; the real portfolio ({repos:[]}) is NEVER touched.
 * No project is set on the crashed runs, so NO sandbox/worktree is created and
 * no source tree is ever mutated — recovery here is proposal/record-only.
 *
 * RECOVERY GAP PROBED: is a crashed 'running' swarm actually resumable, or does
 * the resume path mishandle the non-terminal record? FINDING: the REAL path
 * recovers cleanly with NO production change — see the note at the bottom of
 * this file. These tests are therefore pure PROOF.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AshlrConfig, Proposal, RunState, RunUsage, SwarmRun, WorkItem } from '../src/core/types.js';
import type { StreamSink } from '../src/core/run/streaming.js';
import {
  makeFixture,
  makeCfg,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import {
  crashMidSwarm,
  reloadSwarm,
  makeOrphanSandbox,
} from './helpers/h2-faults.js';
import {
  listSandboxes,
  sweepOrphanSandboxes,
} from '../src/core/sandbox/worktree.js';
import { nullSink } from '../src/core/run/streaming.js';
import { createProposal, inboxDir, loadProposal, pendingCount } from '../src/core/inbox/store.js';
import {
  generatedRepairGenerationId,
  generatedRepairGenerationIds,
  readGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import {
  dispatchProductionDir,
  recordDispatchProduction,
  resolveDispatchProductionAttemptReceiptWitnesses,
  sanitizeDispatchProductionEvent,
  type DispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import {
  dispatchEventFromRepairHandoff,
  recordRepairHandoffs,
  repairHandoffFromDispatchEvent,
} from '../src/core/fleet/repair-handoff-journal.js';
import { workItemObjectiveHash } from '../src/core/fleet/work-item-objective.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { hashDiff } from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// Determinism: mock the ONLY model-touching surface (orchestrator.runGoal) and
// SPY the planner BEFORE the runner is imported, exactly as m12.runner.test.ts
// does. runGoal returns a known done RunState (no network, no model, no real
// subprocess); planSwarm is spied so resume can PROVE it never re-plans.
//
// crashMidSwarm persists a fully-populated plan, so on the resume path the
// runner must skip planning entirely — mockPlanSwarm therefore expects ZERO
// calls in every resume test below (its return value is never consumed).
// ---------------------------------------------------------------------------

const ZERO_USAGE: RunUsage = { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 };

const runGoalGoals: string[] = [];
let runGoalMutation: ((cwd: string) => void) | null = null;

const mockRunGoal = vi.fn(async (
  goal: string,
  _cfg?: AshlrConfig,
  opts?: { cwd?: string },
): Promise<RunState> => {
  runGoalGoals.push(goal);
  if (runGoalMutation !== null && opts?.cwd) runGoalMutation(opts.cwd);
  return {
    id: `mock-run-${runGoalGoals.length}`,
    goal,
    engine: 'builtin',
    provider: 'builtin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 1000, maxSteps: 10, allowCloud: false },
    usage: { ...ZERO_USAGE },
    tasks: [],
    steps: [],
    status: 'done',
    result: `done: ${goal}`,
  };
});

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: mockRunGoal,
  saveRun: vi.fn(),
  loadRun: vi.fn().mockReturnValue(null),
  listRuns: vi.fn().mockReturnValue([]),
  planGoal: vi.fn(),
}));

const mockPlanSwarm = vi.fn(async () => {
  // Resume must NEVER re-plan (plan.tasks already populated). If this fires the
  // resume contract is broken; return an empty plan so the failure is visible
  // as an assertion miss rather than a crash.
  return { specId: null, goal: '', tasks: [] };
});

vi.mock('../src/core/swarm/planner.js', () => ({
  planSwarm: mockPlanSwarm,
}));

// Lazy import AFTER the mocks are registered (ESM mock-hoist + call-time HOME).
let runSwarm: (
  input: { goal: string; specId?: string },
  cfg: AshlrConfig,
  opts: import('../src/core/types.js').SwarmOptions,
  sink: StreamSink,
) => Promise<SwarmRun>;
let swarmsDir: () => string;

async function ensureImported(): Promise<void> {
  if (!runSwarm) {
    const runner = await import('../src/core/swarm/runner.js');
    runSwarm = runner.runSwarm;
    const store = await import('../src/core/swarm/store.js');
    swarmsDir = store.swarmsDir;
  }
}

const TERMINAL = new Set<SwarmRun['status']>([
  'done',
  'failed',
  'aborted',
  'needs-approval',
]);

let fx: H1Fixture;
let cfg: AshlrConfig;
let previousAshlrHome: string | undefined;

const HANDOFF_ACTIVATION = {
  id: '11111111-1111-4111-8111-111111111111',
  activatedAt: '2020-01-01T00:00:00.000Z',
};
const DIAGNOSTIC_PROPOSAL_DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

async function diagnosticRepair(
  repo: string,
  parentId: string,
  parentTs: string,
  now: Date,
  parentAttemptId = 'attempt-02345678-1234-4123-8123-123456789abc',
  includeLegacyAlias = false,
): Promise<WorkItem> {
  const routeReason = 'h2 crash-recovery parent dispatch';
  const parent: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: parentTs,
    itemId: parentId,
    source: 'goal',
    repo,
    title: 'Recover a crash-interrupted diagnostic repair',
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason,
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: parentAttemptId,
    trajectoryId: `run:${parentAttemptId}`,
    routeSnapshot: {
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: parentAttemptId,
      status: 'done',
      outcome: 'empty-diff',
      proposalCreated: false,
      costUsd: 0,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: 'a'.repeat(64),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
  };
  if (includeLegacyAlias) {
    expect(recordRepairHandoffs(parent)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  }
  expect(recordRepairHandoffs(parent, {
    schemaVersion: 2,
    activation: HANDOFF_ACTIVATION,
  })).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  const handoff = repairHandoffFromDispatchEvent(parent)!;
  const { noDiffResliceWorkItem } = await import('../src/core/fleet/proposal-repair-work.js');
  return noDiffResliceWorkItem(dispatchEventFromRepairHandoff(handoff), now)!;
}

function diagnosticAttempt(
  repair: WorkItem,
  outcome: 'empty-diff' | 'proposal-created',
  attemptId: string,
  ts: string,
  proposalId?: string,
): DispatchProductionEvent {
  const routeReason = `h2 ${outcome} crash-recovery attempt`;
  return {
    schemaVersion: 1,
    ts,
    itemId: repair.id,
    source: repair.source,
    repo: repair.repo,
    title: repair.title,
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason,
    outcome,
    proposalCreated: outcome === 'proposal-created',
    ...(proposalId ? { proposalId } : {}),
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome,
      proposalCreated: outcome === 'proposal-created',
      ...(proposalId ? { proposalId, diffFiles: 1, diffLines: 2 } : {}),
      costUsd: 0,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(repair),
    spentUsd: 0,
    ...(proposalId ? { diffFiles: 1, diffLines: 2 } : {}),
    basis: 'run-proposal-outcome',
    repairHandoffId: repair.repairHandoffId,
    repairGenerationId: repair.repairGenerationId,
    repairTreatmentUnitId: repair.repairTreatmentUnitId,
    repairTreatment: repair.repairTreatment,
    repairAttemptOrdinal: 1,
  };
}

function diagnosticPendingProposal(
  repair: WorkItem,
  attemptId: string,
  proposalId: string,
  createdAt: string,
  generationId = repair.repairGenerationId,
): Proposal {
  return {
    id: proposalId,
    repo: repair.repo,
    origin: 'agent',
    kind: 'patch',
    title: 'Crash-persisted generated repair proposal',
    summary: 'The proposal committed before canonical attempt persistence completed.',
    diff: DIAGNOSTIC_PROPOSAL_DIFF,
    diffHash: hashDiff(DIAGNOSTIC_PROPOSAL_DIFF),
    workItemId: repair.id,
    workItemGenerationId: generationId,
    workSource: 'self',
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId,
    },
    status: 'pending',
    createdAt,
  };
}

function appendDispatchProductionWithoutReceipt(event: DispatchProductionEvent): void {
  const canonical = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
  const date = canonical.ts.slice(0, 10);
  mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
  appendFileSync(
    join(dispatchProductionDir(), `${date}.jsonl`),
    `${JSON.stringify(canonical)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

function useIsolatedDispatchStore(): void {
  process.env.ASHLR_HOME = fx.ashlrDir;
}

beforeEach(() => {
  // H2 false-green guard: every H2 it() MUST run at least one assertion. A
  // future empty-stub test (TODO body, zero expect) then FAILS loudly instead
  // of passing vacuously — the headline risk this milestone exists to disprove.
  expect.hasAssertions();
  fx = makeFixture();
  previousAshlrHome = process.env.ASHLR_HOME;
  cfg = makeCfg();
  runGoalGoals.length = 0;
  runGoalMutation = null;
  mockRunGoal.mockClear();
  mockPlanSwarm.mockClear();
});

afterEach(() => {
  fx.cleanup();
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  // Drop the ASHLR_IN_SWARM flag runSwarm sets on this process so the next test
  // is not refused by the recursion guard (the fixture also clears it on setup).
  delete process.env.ASHLR_IN_SWARM;
});

describe('H2 swarm resume — crashed running swarm recovers cleanly', () => {
  it('loads a crash-interrupted run persisted at status running with partial tasks', () => {
    // A kill mid-phase leaves a non-terminal 'running' record with partial
    // progress. Persist that EXACT shape through the real store and assert it
    // round-trips: t1 'done', t2/t3 'pending', status still 'running'.
    const id = 'h2-resume-load';
    crashMidSwarm({
      id,
      goal: 'partial crash',
      project: null,
      taskIds: ['t1', 't2', 't3'],
      doneTaskIds: ['t1'],
    });

    const reloaded = reloadSwarm(id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe('running'); // non-terminal — the crash shape
    expect(reloaded!.plan.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);

    const byId = new Map(reloaded!.tasks.map((t) => [t.id, t.status]));
    expect(byId.get('t1')).toBe('done');
    expect(byId.get('t2')).toBe('pending');
    expect(byId.get('t3')).toBe('pending');
  });

  it('resume skips already-done tasks and does NOT re-plan (deterministic)', async () => {
    await ensureImported();

    // Crash a run with EVERY task already 'done'. Resuming it must execute
    // ZERO model work (every executeTask short-circuits on 'done') and must NOT
    // re-plan (the persisted plan is already populated).
    const id = 'h2-resume-alldone';
    crashMidSwarm({
      id,
      goal: 'all already done',
      project: null,
      taskIds: ['a', 'b', 'c'],
      doneTaskIds: ['a', 'b', 'c'],
    });

    const result = await runSwarm(
      { goal: 'all already done' },
      cfg,
      { resumeId: id },
      () => {},
    );

    // No model touched: runGoal never called because all tasks were 'done'.
    expect(mockRunGoal).not.toHaveBeenCalled();
    // No re-plan: the populated plan short-circuits the planning stage.
    expect(mockPlanSwarm).not.toHaveBeenCalled();
    // Resume reached a TERMINAL status (all tasks done -> 'done').
    expect(result.status).toBe('done');
    expect(TERMINAL.has(result.status)).toBe(true);
    // The plan is unchanged (same task ids, still 3).
    expect(result.plan.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    // Persisted record agrees with the returned record (terminal on disk too).
    expect(reloadSwarm(id)!.status).toBe('done');
  });

  it('resume drives a partial run to a TERMINAL status — never stuck at running', async () => {
    await ensureImported();

    // Crash with one 'done' + one 'pending' task. Resume must SKIP the done one
    // (runGoal NOT called for it) and EXECUTE only the pending one (runGoal
    // called exactly once), then reach a terminal status — proving NO-STUCK.
    const id = 'h2-resume-partial';
    const before = crashMidSwarm({
      id,
      goal: 'finish the pending half',
      project: null,
      taskIds: ['done-1', 'pending-1'],
      doneTaskIds: ['done-1'],
      phase: 'build',
    });

    const result = await runSwarm(
      { goal: 'finish the pending half' },
      cfg,
      { resumeId: id },
      () => {},
    );

    // No re-plan on resume.
    expect(mockPlanSwarm).not.toHaveBeenCalled();
    // Exactly the pending task executed; the done task was skipped.
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(runGoalGoals).toHaveLength(1);
    expect(runGoalGoals[0]).toContain('task pending-1'); // the pending sub-goal

    // Terminal status, never stuck at 'running'.
    expect(result.status).not.toBe('running');
    expect(TERMINAL.has(result.status)).toBe(true);
    expect(result.status).toBe('done'); // the pending task's mock returns done

    // Both tasks now 'done' (the resumed one + the preserved one).
    const byId = new Map(result.tasks.map((t) => [t.id, t.status]));
    expect(byId.get('done-1')).toBe('done');
    expect(byId.get('pending-1')).toBe('done');

    // updatedAt advanced past the crash snapshot — recovery actually ran.
    expect(result.updatedAt >= before.updatedAt).toBe(true);

    // Persisted on disk as terminal — a later restart sees no work to resume.
    const persisted = reloadSwarm(id);
    expect(persisted!.status).toBe('done');
  });

  it('resume of an absent id fails safely (status failed, no crash, no mutation)', async () => {
    await ensureImported();

    // No swarm was ever persisted under this id. Resuming it must fail CLEANLY:
    // a 'failed' record mentioning "not found", no exception, no model work, and
    // — critically — no swarm file written to disk (no partial/limbo record).
    const absentId = 'h2-resume-never-existed';
    expect(reloadSwarm(absentId)).toBeNull();

    const result = await runSwarm(
      { goal: 'resume a ghost' },
      cfg,
      { resumeId: absentId },
      () => {},
    );

    expect(result.status).toBe('failed');
    expect(result.result ?? '').toMatch(/not found/i);

    // No model touched, no re-plan attempted.
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockPlanSwarm).not.toHaveBeenCalled();

    // No swarm record was written for the absent id (no stranded limbo file).
    expect(reloadSwarm(absentId)).toBeNull();
    const fs = await import('node:fs');
    expect(fs.existsSync(`${swarmsDir()}/${absentId}.json`)).toBe(false);
  });
});

// ===========================================================================
// RESUME + SANDBOX LIFECYCLE — a crashed swarm that HAD a real sandbox.
//
// The resume path (runner.ts) creates a BRAND-NEW sandbox (keyed on
// opts.sandbox/project, BEFORE the resume-load), so resuming a crashed swarm
// that had a pre-crash sandbox strictly INCREASES the orphan count by one: the
// old worktree is stranded (never re-attached) and a new one is created+removed.
// This proves (a) the resume's own sandbox is created and cleaned up, (b) the
// pre-crash worktree remains a surfaced + sweepable orphan (not silently leaked
// or double-counted), and (c) the SOURCE repo working tree is byte-identical.
//
// Deterministic: the crashed run is ALL-DONE, so resume executes ZERO tasks
// (runGoal never fires) — the only real work is the genuine createSandbox /
// removeSandbox worktree lifecycle against a disposable repo.
// ===========================================================================

describe('H2 swarm resume — resume of a crashed swarm that had a real sandbox', () => {
  let repo: DisposableRepo;

  beforeEach(() => {
    repo = fx.makeRepo();
  });

  it('creates+cleans its own sandbox while leaving the pre-crash worktree as a sweepable orphan; source byte-identical', async () => {
    await ensureImported();

    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    // The pre-crash sandbox: a real worktree the crashed swarm was using, left on
    // disk because the kill landed before its removeSandbox. It is a genuine
    // orphan (dropped handle) — surfaced by listSandboxes.
    // The autonomous daemon only sandboxes ENROLLED repos; enroll so the resume's
    // mandatory createSandbox(project) is permitted (createSandbox is called
    // WITHOUT allowAnyRepo on the real path — enrollment is the gate).
    repo.enroll();

    const preCrash = makeOrphanSandbox(repo.dir);
    expect(listSandboxes().map((s) => s.id)).toContain(preCrash.id);

    // The crashed run: ALL tasks already 'done' so resume executes ZERO tasks
    // (no model) — the ONLY real work is the sandbox lifecycle. project=repo.dir
    // so the resume creates a MANDATORY new sandbox off the disposable repo.
    const id = 'h2-resume-with-sandbox';
    crashMidSwarm({
      id,
      goal: 'resume with a real sandbox',
      project: repo.dir,
      taskIds: ['x', 'y'],
      doneTaskIds: ['x', 'y'],
    });

    const sandboxesBeforeResume = new Set(listSandboxes().map((s) => s.id));

    const result = await runSwarm(
      { goal: 'resume with a real sandbox' },
      cfg,
      {
        resumeId: id,
        project: repo.dir,
        sandbox: true,
        requireSandbox: true,
        propose: false,
        noCapture: true,
        parallel: 1,
        dryRun: false,
      },
      nullSink(),
    );

    // No model touched (all tasks were done), resume reached terminal 'done'.
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockPlanSwarm).not.toHaveBeenCalled();
    expect(result.status).toBe('done');

    // (a) The resume's OWN new sandbox was created off project and then cleaned
    // up at end-of-run — it is NOT left on disk (no leak from the resume itself).
    const afterIds = new Set(listSandboxes().map((s) => s.id));
    expect(afterIds.has(preCrash.id)).toBe(true); // pre-crash orphan survives
    // No NEW sandbox id lingers (the resume created+removed its own).
    for (const sid of afterIds) {
      if (sid !== preCrash.id) {
        expect(sandboxesBeforeResume.has(sid)).toBe(true);
      }
    }

    // (b) The pre-crash worktree is still a surfaced, reclaimable orphan — the
    // resume neither re-attached nor silently destroyed it. A sweep reclaims it.
    const swept = sweepOrphanSandboxes();
    expect(swept).toContain(preCrash.id);
    expect(listSandboxes().map((s) => s.id)).not.toContain(preCrash.id);

    // (c) The SOURCE repo working tree is byte-identical throughout: no sandbox
    // (pre-crash, resume, or sweep) ever touched the user's tree/branches.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);
  });

  it('files one typed proposal from the sandbox diff and persists its capture outcome', async () => {
    await ensureImported();
    repo = fx.makeRepo({ files: { 'src/value.ts': 'export const value = 1;\n' } });
    repo.enroll();
    const treeBefore = repo.shasumTree();
    const sandboxesBefore = new Set(listSandboxes().map((sandbox) => sandbox.id));
    const pendingBefore = pendingCount();
    const id = 'attempt-42345678-1234-4123-8123-123456789abc';
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:resume-generation',
      '2026-07-10T15:00:00.000Z',
      new Date('2026-07-10T16:00:00.000Z'),
      'attempt-32345678-1234-4123-8123-123456789abc',
    );
    const workItemGenerationId = generatedRepairGenerationId(repair)!;
    const fakeSecret = 'sk-' + 'testvalueverysecret00000000';
    crashMidSwarm({
      id,
      goal: 'change the sandboxed value',
      project: repo.dir,
      taskIds: ['build-value'],
      doneTaskIds: [],
      phase: 'build',
      workItemId: repair.id,
      workItemGenerationId,
      workSource: 'self',
      resumeOptions: {
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
      },
    });
    runGoalMutation = (cwd) => {
      writeFileSync(
        join(cwd, 'src/value.ts'),
        `export const value = 2; // ${fakeSecret}\n`,
        'utf8',
      );
    };

    const result = await runSwarm(
      { goal: 'change the sandboxed value' },
      cfg,
      {
        resumeId: id,
        parallel: 1,
        workItemId: 'caller-must-not-replace-durable-item',
        workItemGenerationId: 'c'.repeat(64),
        workSource: 'manual',
        sandbox: false,
        requireSandbox: false,
        propose: false,
      },
      nullSink(),
    );

    expect(result.status).toBe('done');
    expect(result.proposalOutcome).toMatchObject({
      kind: 'filed',
      files: 1,
      insertions: 1,
      deletions: 1,
    });
    expect(result.proposalOutcome?.proposalId).toMatch(/^prop-/);
    const proposal = loadProposal(result.proposalOutcome!.proposalId!)!;
    expect(proposal).toMatchObject({
      workItemId: repair.id,
      workItemGenerationId,
      workSource: 'self',
      runId: id,
      trajectoryId: `run:${id}`,
      runEventSummary: {
        runId: id,
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
      },
    });
    const { queueSelfHealItem } = await import('../src/core/fleet/self-heal.js');
    const {
      generatedRepairProposalDispatchAuthority,
      queueProposalRepairWorkForPendingProposals,
    } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );
    expect(queueSelfHealItem(repair)).toBe(true);
    expect(recordDispatchProduction(diagnosticAttempt(
      repair,
      'proposal-created',
      id,
      proposal.createdAt,
      proposal.id,
    ))).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('proven');
    expect(queueProposalRepairWorkForPendingProposals(undefined, new Date(), {
      dispatchEvents: [],
      lifecycleProposals: [proposal],
    })).toMatchObject({
      dispatchRepairRetired: 0,
      dispatchRepairPruned: 0,
      dispatchRepairLifecycleUnavailable: 0,
      blockedItemKeys: [],
    });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
    });
    expect(reloadSwarm(id)?.proposalOutcome).toEqual(result.proposalOutcome);
    expect(JSON.stringify(reloadSwarm(id))).not.toContain(fakeSecret);
    expect(result.result).not.toContain(fakeSecret);
    expect(pendingCount()).toBe(pendingBefore + 1);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(listSandboxes().every((sandbox) => sandboxesBefore.has(sandbox.id))).toBe(true);
  });

  it('recovers a persisted empty-diff receipt after a crash before lifecycle save', async () => {
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-empty-proof-crash',
      '2026-07-04T10:00:00.000Z',
      now,
    );
    const attempt = diagnosticAttempt(
      repair,
      'empty-diff',
      'attempt-12345678-1234-4123-8123-123456789abc',
      '2026-07-04T11:00:00.000Z',
    );
    const { queueSelfHealItem } = await import('../src/core/fleet/self-heal.js');
    const { queueProposalRepairWorkForPendingProposals } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );
    expect(queueSelfHealItem(repair)).toBe(true);
    expect(recordDispatchProduction(attempt)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });

    const recovered = queueProposalRepairWorkForPendingProposals([], now, {
      dispatchEvents: [],
      lifecycleProposals: [],
    });

    expect(recovered).toMatchObject({
      dispatchRepairPruned: 0,
      dispatchRepairLifecycleUnavailable: 0,
    });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
  });

  it('recovers an old proposal receipt without scanning production history', async () => {
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-old-proposal-proof',
      '2026-07-01T10:00:00.000Z',
      now,
    );
    const attemptId = 'attempt-22345678-1234-4123-8123-123456789abc';
    const proposalId = 'prop-h2-old-proof-recovery';
    const attempt = diagnosticAttempt(
      repair,
      'proposal-created',
      attemptId,
      '2026-07-01T11:00:00.000Z',
      proposalId,
    );
    const proposal = diagnosticPendingProposal(
      repair,
      attemptId,
      proposalId,
      attempt.ts,
    );
    const { queueSelfHealItem } = await import('../src/core/fleet/self-heal.js');
    const { queueProposalRepairWorkForPendingProposals } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );
    expect(now.getTime() - Date.parse(attempt.ts)).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(queueSelfHealItem(repair)).toBe(true);
    mkdirSync(inboxDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(inboxDir(), `${proposal.id}.json`), `${JSON.stringify(proposal)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    expect(recordDispatchProduction(attempt)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    for (let index = 0; index < 40; index++) {
      const date = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
      writeFileSync(join(dispatchProductionDir(), `${date}.jsonl`), 'malformed\n', 'utf8');
    }

    const recovered = queueProposalRepairWorkForPendingProposals([], now, {
      dispatchEvents: [],
      lifecycleProposals: [proposal],
    });

    expect(recovered).toMatchObject({ dispatchRepairRetired: 1, dispatchRepairPruned: 1 });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  });

  it('keeps a durable crash-before-intent proposal blocked despite healthy receipt absence', async () => {
    useIsolatedDispatchStore();
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-proposal-before-receipt',
      '2026-07-04T10:00:00.000Z',
      now,
    );
    const attemptId = 'attempt-52345678-1234-4123-8123-123456789abc';
    const proposalId = 'prop-h2-proposal-before-receipt';
    const candidate = diagnosticPendingProposal(
      repair,
      attemptId,
      proposalId,
      '2026-07-04T11:00:00.000Z',
    );
    const {
      id: _id,
      status: _status,
      createdAt: _createdAt,
      ...proposalInput
    } = candidate;
    const proposal = createProposal(proposalInput);
    const { generatedRepairProposalDispatchAuthority } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );

    expect(loadProposal(proposal.id)).toMatchObject({
      id: proposal.id,
      status: 'pending',
      workItemId: repair.id,
      workItemGenerationId: repair.repairGenerationId,
    });
    const { queueSelfHealItem } = await import('../src/core/fleet/self-heal.js');
    const { queueProposalRepairWorkForPendingProposals } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );
    expect(queueSelfHealItem(repair)).toBe(true);
    expect(queueProposalRepairWorkForPendingProposals([proposal], now, {
      dispatchEvents: [],
      lifecycleProposals: [proposal],
    })).toMatchObject({
      dispatchRepairLifecycleUnavailable: 1,
      dispatchRepairPruned: 0,
      blockedItemKeys: expect.arrayContaining([expect.any(String)]),
    });
    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('unavailable');
  });

  it('blocks an uncommitted pre-append intent until the exact original evidence is replayed', async () => {
    useIsolatedDispatchStore();
    repo.enroll();
    const now = new Date();
    const parentTs = new Date(now.getTime() - 2 * 60_000).toISOString();
    const proposalTs = new Date(now.getTime() - 60_000).toISOString();
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-uncommitted-attempt-intent',
      parentTs,
      now,
    );
    const attemptId = 'attempt-57345678-1234-4123-8123-123456789abc';
    const proposal = diagnosticPendingProposal(
      repair,
      attemptId,
      'prop-h2-uncommitted-attempt-intent',
      proposalTs,
    );
    const attempt = diagnosticAttempt(
      repair,
      'proposal-created',
      attemptId,
      proposal.createdAt,
      proposal.id,
    );
    const partition = join(dispatchProductionDir(), `${attempt.ts.slice(0, 10)}.jsonl`);
    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    const appendLock = acquireLocalStoreLock(`${partition}.lock`);
    expect(appendLock).not.toBeNull();
    try {
      expect(recordDispatchProduction(attempt)).toEqual({ attempted: 1, recorded: 0, failed: 1 });
    } finally {
      if (appendLock) releaseLocalStoreLock(appendLock);
    }
    const { generatedRepairProposalDispatchAuthority } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );

    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: repair.repairGenerationId!,
      repairAttemptOrdinal: 1,
    }])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'missing', reason: 'receipt-uncommitted' }],
    });
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('unavailable');

    expect(recordDispatchProduction(attempt)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('proven');
  });

  it('blocks on an authoritative JSONL append when immutable receipt publication is missing', async () => {
    useIsolatedDispatchStore();
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-append-before-receipt',
      '2026-07-04T10:00:00.000Z',
      now,
    );
    const attemptId = 'attempt-62345678-1234-4123-8123-123456789abc';
    const proposalId = 'prop-h2-append-before-receipt';
    const proposal = diagnosticPendingProposal(
      repair,
      attemptId,
      proposalId,
      '2026-07-04T11:00:00.000Z',
    );
    const attempt = diagnosticAttempt(
      repair,
      'proposal-created',
      attemptId,
      proposal.createdAt,
      proposalId,
    );
    const { generatedRepairProposalDispatchAuthority } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );

    appendDispatchProductionWithoutReceipt(attempt);

    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: repair.repairGenerationId!,
      repairAttemptOrdinal: 1,
    }])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'missing', reason: 'receipt-missing' }],
    });
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('proven');
  });

  it('fails closed for a valid non-current generation alias proposal', async () => {
    useIsolatedDispatchStore();
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-generation-alias',
      '2026-07-04T10:00:00.000Z',
      now,
      'attempt-12345678-2234-4123-8123-123456789abc',
      true,
    );
    const current = generatedRepairGenerationId(repair)!;
    const alias = generatedRepairGenerationIds(repair).find((generationId) => generationId !== current);
    if (!alias) throw new Error('expected a valid non-current generation alias');
    const proposal = diagnosticPendingProposal(
      repair,
      'attempt-72345678-1234-4123-8123-123456789abc',
      'prop-h2-generation-alias',
      '2026-07-04T11:00:00.000Z',
      alias,
    );
    const { generatedRepairProposalDispatchAuthority } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );

    expect(generatedRepairGenerationIds(repair)).toContain(alias);
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('unavailable');
  });

  it('turns a committed failed recovery attempt into fail-closed bounded state', async () => {
    useIsolatedDispatchStore();
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-dedup-recovery-bound',
      '2026-07-04T10:00:00.000Z',
      now,
    );
    const attemptId = 'attempt-82345678-1234-4123-8123-123456789abc';
    const proposal = diagnosticPendingProposal(
      repair,
      attemptId,
      'prop-h2-dedup-recovery-bound',
      '2026-07-04T11:00:00.000Z',
    );
    const failedRetry: DispatchProductionEvent = {
      ...diagnosticAttempt(repair, 'proposal-created', attemptId, proposal.createdAt, proposal.id),
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      proposalId: undefined,
      reason: 'retry diff deduplicated against the crash-persisted pending proposal',
    };
    const { generatedRepairProposalDispatchAuthority } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );

    mkdirSync(dispatchProductionDir(), { recursive: true, mode: 0o700 });
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('unavailable');
    expect(recordDispatchProduction(failedRetry)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    expect(generatedRepairProposalDispatchAuthority(repair, proposal)).toBe('unavailable');
  });

  it('does not advance diagnostic lifecycle from caller-only evidence', async () => {
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-forged-recovery-evidence',
      '2026-07-04T10:00:00.000Z',
      now,
    );
    const forged = diagnosticAttempt(
      repair,
      'empty-diff',
      'attempt-32345678-1234-4123-8123-123456789abc',
      '2026-07-04T11:00:00.000Z',
    );
    const { queueSelfHealItem } = await import('../src/core/fleet/self-heal.js');
    const { queueProposalRepairWorkForPendingProposals } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );
    expect(queueSelfHealItem(repair)).toBe(true);

    queueProposalRepairWorkForPendingProposals([], now, {
      dispatchEvents: [forged],
      lifecycleProposals: [],
    });

    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('does not let caller proposal identity replace the canonical receipt identity', async () => {
    repo.enroll();
    const now = new Date('2026-07-04T12:00:00.000Z');
    const repair = await diagnosticRepair(
      repo.dir,
      'repo:goal:h2-proposal-identity-confusion',
      '2026-07-04T10:00:00.000Z',
      now,
    );
    const attemptId = 'attempt-42345678-1234-4123-8123-123456789abc';
    const canonical = diagnosticAttempt(
      repair,
      'proposal-created',
      attemptId,
      '2026-07-04T11:00:00.000Z',
      'prop-canonical-receipt',
    );
    const callerClaim: DispatchProductionEvent = {
      ...canonical,
      proposalId: 'prop-durable-inbox',
      runEventSummary: {
        ...canonical.runEventSummary!,
        proposalId: 'prop-durable-inbox',
      },
    };
    const proposal = diagnosticPendingProposal(
      repair,
      attemptId,
      'prop-durable-inbox',
      canonical.ts,
    );
    const { queueSelfHealItem } = await import('../src/core/fleet/self-heal.js');
    const {
      generatedRepairProposalDispatchAuthority,
      queueProposalRepairWorkForPendingProposals,
    } = await import(
      '../src/core/fleet/proposal-repair-work.js'
    );
    expect(queueSelfHealItem(repair)).toBe(true);
    expect(recordDispatchProduction(canonical)).toEqual({ attempted: 1, recorded: 1, failed: 0 });

    const result = queueProposalRepairWorkForPendingProposals([], now, {
      dispatchEvents: [callerClaim],
      lifecycleProposals: [proposal],
    });
    const authority = generatedRepairProposalDispatchAuthority(repair, proposal);

    expect(result).toMatchObject({ dispatchRepairRetired: 0, dispatchRepairPruned: 0 });
    expect(authority).toBe('unavailable');
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('classifies a failed no-edit sandbox run as engine failure rather than empty diff', async () => {
    await ensureImported();
    repo.enroll();
    const treeBefore = repo.shasumTree();
    const sandboxesBefore = new Set(listSandboxes().map((sandbox) => sandbox.id));
    const id = 'h2-resume-failed-no-diff';
    crashMidSwarm({
      id,
      goal: 'fail without changing files',
      project: repo.dir,
      taskIds: ['build-fails'],
      doneTaskIds: [],
      phase: 'build',
    });
    mockRunGoal.mockRejectedValueOnce(new Error('synthetic task failure'));

    const result = await runSwarm(
      { goal: 'fail without changing files' },
      cfg,
      {
        resumeId: id,
        project: repo.dir,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
        parallel: 1,
      },
      nullSink(),
    );

    expect(result.status).toBe('failed');
    expect(result.proposalOutcome).toMatchObject({
      kind: 'engine-failed-no-diff',
      files: 0,
      insertions: 0,
      deletions: 0,
    });
    expect(reloadSwarm(id)?.proposalOutcome).toEqual(result.proposalOutcome);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(listSandboxes().every((sandbox) => sandboxesBefore.has(sandbox.id))).toBe(true);
  });

  it('captures failed builtin swarm edits only as non-authoritative partial evidence', async () => {
    await ensureImported();
    repo.enroll();
    const id = 'h2-resume-failed-with-diff';
    crashMidSwarm({
      id,
      goal: 'fail after changing a file',
      project: repo.dir,
      taskIds: ['build-fails-after-edit'],
      doneTaskIds: [],
      phase: 'build',
    });
    mockRunGoal.mockImplementationOnce(async (_goal, _cfg, opts) => {
      if (opts?.cwd) {
        writeFileSync(join(opts.cwd, 'partial.ts'), 'export const partial = true;\n', 'utf8');
      }
      throw new Error('synthetic task failure after edit');
    });

    const result = await runSwarm(
      { goal: 'fail after changing a file' },
      cfg,
      {
        resumeId: id,
        project: repo.dir,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
        parallel: 1,
      },
      nullSink(),
    );

    expect(result.status).toBe('failed');
    expect(result.proposalOutcome).toMatchObject({
      kind: 'filed',
      isPartial: true,
      files: 1,
    });
    const proposal = loadProposal(result.proposalOutcome!.proposalId!)!;
    expect(proposal).toMatchObject({
      status: 'pending',
      isPartial: true,
      runEventSummary: {
        status: 'failed',
        outcome: 'gate-blocked',
        proposalCreated: false,
      },
      verifyResult: {
        passed: false,
        source: 'capture-gate',
      },
    });
  });

  it('keeps a failed sandboxed dry-run out of the swarm store and removes its sandbox', async () => {
    await ensureImported();
    repo.enroll();
    const runId = 'h2-dry-run-planning-failure';
    const sandboxesBefore = new Set(listSandboxes().map((sandbox) => sandbox.id));
    mockPlanSwarm.mockRejectedValueOnce(new Error('synthetic planning failure'));

    const result = await runSwarm(
      { goal: 'preview a failing plan' },
      cfg,
      {
        runId,
        project: repo.dir,
        sandbox: true,
        requireSandbox: true,
        propose: false,
        noCapture: true,
        parallel: 1,
        dryRun: true,
      },
      nullSink(),
    );

    expect(result.status).toBe('failed');
    expect(reloadSwarm(runId)).toBeNull();
    expect(listSandboxes().every((sandbox) => sandboxesBefore.has(sandbox.id))).toBe(true);
    expect(repo.gitStatus()).toBe('');
  });

  it('reports completeness-gate truth and removes the blocked proposal sandbox', async () => {
    await ensureImported();
    repo = fx.makeRepo({
      files: {
        'package.json': '{"name":"fixture","dependencies":{}}\n',
        'package-lock.json': '{"name":"fixture","lockfileVersion":3}\n',
      },
    });
    repo.enroll();
    const treeBefore = repo.shasumTree();
    const sandboxesBefore = new Set(listSandboxes().map((sandbox) => sandbox.id));
    const pendingBefore = pendingCount();
    const id = 'h2-resume-completeness-block';
    crashMidSwarm({
      id,
      goal: 'change a dependency without its lockfile',
      project: repo.dir,
      taskIds: ['build-dependency'],
      doneTaskIds: [],
      phase: 'build',
    });
    runGoalMutation = (cwd) => {
      writeFileSync(
        join(cwd, 'package.json'),
        '{"name":"fixture","dependencies":{"left-pad":"1.3.0"}}\n',
        'utf8',
      );
    };

    const result = await runSwarm(
      { goal: 'change a dependency without its lockfile' },
      cfg,
      {
        resumeId: id,
        project: repo.dir,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
        parallel: 1,
      },
      nullSink(),
    );

    expect(result.status).toBe('done');
    expect(result.proposalOutcome).toMatchObject({
      kind: 'completeness-gate',
      reason: 'dependency change (package.json) lacks corresponding lockfile update',
      files: 1,
    });
    expect(reloadSwarm(id)?.proposalOutcome).toEqual(result.proposalOutcome);
    expect(pendingCount()).toBe(pendingBefore);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(listSandboxes().every((sandbox) => sandboxesBefore.has(sandbox.id))).toBe(true);
  });
});

/*
 * ───────────────────────────────────────────────────────────────────────────
 * RECOVERY-GAP FINDING (CLEAN-RESUME) — NO PRODUCTION CHANGE NEEDED.
 *
 * The REAL resume path already recovers a crash-interrupted 'running' swarm
 * cleanly, proven above with ZERO production edits:
 *
 *   - runSwarm({ resumeId }) loads the persisted 'running' record via loadSwarm
 *     and continues from it (runner.ts ~1224); it does NOT reject a non-terminal
 *     'running' record, so a crashed swarm is genuinely resumable.
 *   - The planning stage is guarded by `!opts.resumeId || run.plan.tasks.length
 *     === 0`, so a resume whose persisted plan is already populated NEVER
 *     re-plans (mockPlanSwarm asserted to 0 calls) — model-free + idempotent.
 *   - executeTask returns 'continue' immediately when `taskRun.status === 'done'`
 *     (runner.ts ~397), so already-completed tasks are SKIPPED, never re-run
 *     (runGoal asserted to 0 calls for the all-done run, exactly 1 for the one
 *     pending task in the partial run).
 *   - The phase loop always assigns a terminal status on exit (done/failed/
 *     aborted/needs-approval) and persists it, so resume can never leave the run
 *     stuck at 'running'.
 *   - An absent resumeId returns a self-contained 'failed' record ("not found")
 *     WITHOUT writing any swarm file — no partial work, no stranded limbo record.
 *
 * The only synthetic element is the "kill" itself: crashMidSwarm writes the
 * exact intermediate state through the REAL saveSwarm store, then the genuine
 * runSwarm resume entry point is exercised. Because no `project` is set, no
 * sandbox/worktree is created and no source tree is mutated, so the
 * REAL-TREE-UNCHANGED invariant holds trivially (there is nothing to change).
 * ───────────────────────────────────────────────────────────────────────────
 */

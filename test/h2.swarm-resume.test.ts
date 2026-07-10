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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AshlrConfig, RunState, RunUsage, SwarmRun } from '../src/core/types.js';
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
import { pendingCount } from '../src/core/inbox/store.js';

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

beforeEach(() => {
  // H2 false-green guard: every H2 it() MUST run at least one assertion. A
  // future empty-stub test (TODO body, zero expect) then FAILS loudly instead
  // of passing vacuously — the headline risk this milestone exists to disprove.
  expect.hasAssertions();
  fx = makeFixture();
  cfg = makeCfg();
  runGoalGoals.length = 0;
  runGoalMutation = null;
  mockRunGoal.mockClear();
  mockPlanSwarm.mockClear();
});

afterEach(() => {
  fx.cleanup();
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
    const id = 'h2-resume-files-proposal';
    const fakeSecret = 'sk-' + 'testvalueverysecret00000000';
    crashMidSwarm({
      id,
      goal: 'change the sandboxed value',
      project: repo.dir,
      taskIds: ['build-value'],
      doneTaskIds: [],
      phase: 'build',
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
      kind: 'filed',
      files: 1,
      insertions: 1,
      deletions: 1,
    });
    expect(result.proposalOutcome?.proposalId).toMatch(/^prop-/);
    expect(reloadSwarm(id)?.proposalOutcome).toEqual(result.proposalOutcome);
    expect(JSON.stringify(reloadSwarm(id))).not.toContain(fakeSecret);
    expect(result.result).not.toContain(fakeSecret);
    expect(pendingCount()).toBe(pendingBefore + 1);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(listSandboxes().every((sandbox) => sandboxesBefore.has(sandbox.id))).toBe(true);
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

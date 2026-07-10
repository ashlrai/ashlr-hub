/**
 * test/helpers/h2-faults.ts — H2 fault-injection helpers (CRASH SIMULATION).
 *
 * MILESTONE H2 "Harden & Prove" — proves CRASH RECOVERY & RESUMABILITY. These
 * helpers EXTEND the H1 testkit (test/helpers/h1-fixture.ts — REUSE IT) with the
 * one new capability H2 needs: constructing the EXACT persisted intermediate
 * state that a real crash would leave behind, so the REAL recovery / resume /
 * restart paths can then be invoked and asserted against.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAULT-INJECTION TECHNIQUE (the whole point — read before using):
 *   We do NOT spawn a real crashing subprocess and we do NOT depend on a live
 *   model. A "crash" is simulated by writing, with the REAL stores, the precise
 *   on-disk state a process killed at a chosen instant would have left:
 *
 *     - a SwarmRun persisted at status 'running' with SOME tasks 'done' and the
 *       rest 'pending' (saveSwarm) — what a kill mid-phase leaves;
 *     - daemon.json seeded with a mid-tick spend / running=true — what a kill
 *       mid-tick leaves;
 *     - a real on-disk sandbox worktree whose in-memory Sandbox handle is then
 *       DROPPED — what a kill before removeSandbox() leaves (an orphan);
 *     - the kill switch toggled BETWEEN persist points — the kill-switch race.
 *
 *   Then the test invokes the genuine production entry point (runSwarm with
 *   { resumeId }, tick(), listSandboxes(), loadDaemonState(), …) and asserts the
 *   outcome. Every byte these helpers write goes through the SAME stores the
 *   production code reads, so the recovery path under test is the real one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ABSOLUTE SAFETY (inherited from H1, unchanged):
 *   - These helpers only ever write under the fixture's ISOLATED tmp HOME
 *     (~/.ashlr/{swarms,sandboxes,inbox,daemon.json}) — NEVER the real ~/.ashlr.
 *     They resolve every path via the REAL store functions, which read
 *     homedir() at call time, so the H1 fixture's HOME relocation isolates them.
 *   - Sandboxes are created from DISPOSABLE git repos via the REAL createSandbox
 *     (with allowAnyRepo for tmp repos) so the orphan is a genuine worktree, not
 *     a hand-rolled fake.
 *   - DETERMINISTIC: no model, no network, no real subprocess crash. Pure state
 *     construction + real-store round-trips.
 *
 * These are TEST-ONLY helpers: no production behavior change, no new runtime
 * dep, strict TS, node builtins + the project's own stores only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  DaemonState,
  DaemonTick,
  Proposal,
  Sandbox,
  SwarmPhaseName,
  SwarmPlan,
  SwarmRun,
  SwarmTaskRun,
} from '../../src/core/types.js';
import { saveSwarm, loadSwarm } from '../../src/core/swarm/store.js';
import {
  loadDaemonState,
  saveDaemonState,
  daemonStatePath,
} from '../../src/core/daemon/state.js';
import {
  createSandbox,
  listSandboxes,
  sandboxesDir,
} from '../../src/core/sandbox/worktree.js';
import { createProposal } from '../../src/core/inbox/store.js';

// ===========================================================================
// Swarm crash simulation — persist a 'running' SwarmRun with partial tasks
// ===========================================================================

/** Today's calendar day in the YYYY-MM-DD form the daemon state uses. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A zeroed RunUsage. */
function zeroUsage(): SwarmRun['usage'] {
  return { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 };
}

/** A minimal RunBudget (local-first, no cloud). */
function localBudget(): SwarmRun['budget'] {
  return { maxTokens: 100_000, maxSteps: 100, allowCloud: false };
}

/**
 * Options for {@link crashMidSwarm}. `doneTaskIds` are the tasks a crash would
 * have already completed; every other planned task is left 'pending'. The run
 * is persisted at status 'running' — the EXACT shape a process killed mid-phase
 * leaves: a non-terminal record with partial progress that the resume path
 * (`runSwarm({ resumeId })`) must pick up without redoing finished tasks.
 */
export interface CrashMidSwarmOptions {
  /** Swarm id (must match the store's id charset: word chars, dot, hyphen). */
  id: string;
  /** The top-level goal text. */
  goal: string;
  /** Absolute project path the swarm operates in (a disposable repo), or null. */
  project: string | null;
  /** Planned task ids in plan order (each becomes a SwarmTaskRun). */
  taskIds: string[];
  /** Subset of taskIds already 'done' at crash time. The rest stay 'pending'. */
  doneTaskIds?: string[];
  /** Phase to label every task with. Default 'build'. */
  phase?: SwarmPhaseName;
  /**
   * Status to persist the crashed run at. Default 'running' (the crash-mid-run
   * shape). Pass 'needs-approval' to model a paused swarm awaiting approval.
   */
  status?: SwarmRun['status'];
  /** Optional durable causal identity left by the crashed producer. */
  workItemId?: string;
  workItemGenerationId?: string;
  workSource?: SwarmRun['workSource'];
  resumeOptions?: SwarmRun['resumeOptions'];
}

/**
 * Construct + persist (via the REAL saveSwarm) the on-disk SwarmRun a crash
 * would leave: status 'running' (default), some tasks 'done', the rest
 * 'pending'. Returns the persisted record so a test can assert against it and
 * then drive `runSwarm({ resumeId: run.id, ... })` to prove CLEAN-RESUME.
 *
 * The plan is populated (taskIds -> SwarmTaskSpec/SwarmTaskRun pairs) so the
 * resume path does NOT re-plan (the runner skips planning when the persisted
 * record already has plan.tasks), making resume deterministic and model-free.
 */
export function crashMidSwarm(opts: CrashMidSwarmOptions): SwarmRun {
  const phase: SwarmPhaseName = opts.phase ?? 'build';
  const done = new Set(opts.doneTaskIds ?? []);
  const now = new Date().toISOString();

  const tasks: SwarmTaskRun[] = opts.taskIds.map((id) => ({
    id,
    phase,
    status: done.has(id) ? 'done' : 'pending',
    ...(done.has(id) ? { result: `done(${id})` } : {}),
  }));

  const plan: SwarmPlan = {
    specId: null,
    goal: opts.goal,
    tasks: opts.taskIds.map((id) => ({
      id,
      phase,
      goal: `task ${id}`,
      deps: [] as string[],
    })),
  };

  const run: SwarmRun = {
    id: opts.id,
    goal: opts.goal,
    specId: null,
    project: opts.project,
    ...(opts.workItemId ? { workItemId: opts.workItemId } : {}),
    ...(opts.workItemGenerationId ? { workItemGenerationId: opts.workItemGenerationId } : {}),
    ...(opts.workSource ? { workSource: opts.workSource } : {}),
    ...(opts.resumeOptions ? { resumeOptions: opts.resumeOptions } : {}),
    createdAt: now,
    updatedAt: now,
    budget: localBudget(),
    usage: zeroUsage(),
    parallel: 1,
    status: opts.status ?? 'running',
    plan,
    tasks,
  };

  saveSwarm(run);
  return run;
}

/**
 * Re-read a swarm from the REAL store (convenience wrapper over loadSwarm) so
 * tests can assert the persisted post-recovery shape without importing the
 * store directly.
 */
export function reloadSwarm(id: string): SwarmRun | null {
  return loadSwarm(id);
}

// ===========================================================================
// Daemon mid-tick crash simulation — seed a partially-applied spend
// ===========================================================================

/** Options for {@link seedMidTickSpend}. */
export interface SeedMidTickSpendOptions {
  /** USD already debited to today's counter at crash time. */
  spentUsd: number;
  /**
   * Whether the persisted state still says the daemon is running (a kill leaves
   * running=true because the clean-exit `running=false` write never ran).
   * Default true — the realistic crash shape.
   */
  running?: boolean;
  /**
   * Whether a tick record for the in-flight tick was already appended before
   * the crash. Default false (the spend was debited but the tick record write
   * had not landed) — this is the shape that probes whether a naive restart
   * could DOUBLE-COUNT the same spend.
   */
  withTickRecord?: boolean;
}

/**
 * Seed daemon.json (via the REAL saveDaemonState) with the state a process
 * killed mid-tick would leave: today's spend already debited to `spentUsd`,
 * todayDate = today, and (by default) running=true because the clean-exit
 * write never executed. Returns the seeded state.
 *
 * This is the NO-DOUBLE-SPEND probe surface: a subsequent honest tick / restart
 * must treat `spentUsd` as already-counted and NEVER re-add it.
 */
export function seedMidTickSpend(opts: SeedMidTickSpendOptions): DaemonState {
  const running = opts.running ?? true;
  const ticks: DaemonTick[] = opts.withTickRecord
    ? [
        {
          ts: new Date().toISOString(),
          itemsConsidered: 1,
          proposalsCreated: 0,
          spentUsd: opts.spentUsd,
          reason: 'ok',
        },
      ]
    : [];

  const state: DaemonState = {
    running,
    pid: running ? 999_999 : null, // a pid that is not this process
    startedAt: running ? new Date().toISOString() : null,
    lastTickAt: null,
    todayDate: today(),
    todaySpentUsd: opts.spentUsd,
    itemsProcessed: 0,
    ticks,
  };

  saveDaemonState(state);
  return state;
}

/** Re-read daemon state from the REAL store. */
export function reloadDaemonState(): DaemonState {
  return loadDaemonState();
}

/** Whether daemon.json exists under the (isolated) HOME. */
export function daemonStateExists(): boolean {
  return existsSync(daemonStatePath());
}

// ===========================================================================
// Orphan sandbox simulation — a real on-disk worktree with a dropped handle
// ===========================================================================

/**
 * Create a REAL sandbox worktree from a disposable repo, then DROP the in-memory
 * handle to leave it on disk — exactly what a swarm killed before its
 * removeSandbox() leaves. The metadata persists under ~/.ashlr/sandboxes/<id>/,
 * so listSandboxes() surfaces it as an ORPHAN (no live owner). Returns the
 * Sandbox so a test can later assert it was swept (removed) by the recovery
 * path and was NOT a phantom hand-rolled fake.
 *
 * Uses allowAnyRepo so a TMP (un-enrolled) disposable repo can be sandboxed
 * without touching the enrollment registry — matching the M21 test convention.
 * The kill switch is NOT bypassed by allowAnyRepo, so this still proves the gate
 * runs.
 */
export function makeOrphanSandbox(repoDir: string): Sandbox {
  // H5 CHANGE 3: allowAnyRepo is effective ONLY when ASHLR_TEST_ALLOW_ANY_REPO=1.
  // This helper deliberately sandboxes an unenrolled TMP repo, so set the env
  // hatch around the call (restore after) — self-contained so every caller works
  // unchanged. The kill switch is still NOT bypassed by the hatch.
  const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  try {
    const sb = createSandbox(repoDir, { allowAnyRepo: true });
    // H5: createSandbox stamps `ownerPid: process.pid` as a POSITIVE liveness
    // marker so the orphan sweep never force-removes a LIVE worktree. But this
    // helper models a CRASHED swarm — its owner process is GONE — so we strip
    // the ownerPid from the persisted metadata. That makes it a TRUE orphan
    // (no live owner), reclaimable by the conservative createdAt-age staleMs
    // guard exactly as the H2/H5 recovery proofs assume. Without this, the
    // sandbox would carry THIS (live) test process's pid and the sweep would
    // correctly protect it as live — which is right for production, but the
    // wrong fixture for a crash-leftover.
    const metaFile = join(sandboxesDir(), sb.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    delete meta['ownerPid'];
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    delete (sb as { ownerPid?: number }).ownerPid;
    return sb;
  } finally {
    if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
  }
}

/**
 * List all sandboxes the REAL store currently surfaces (orphans included). A
 * sandbox is an orphan iff no running swarm owns it; after a simulated crash,
 * every sandbox here is by construction an orphan awaiting cleanup.
 */
export function listOrphanSandboxes(): Sandbox[] {
  return listSandboxes();
}

/** Whether a sandbox id still has an on-disk home under sandboxesDir(). */
export function sandboxHomeExists(id: string): boolean {
  if (!/^[\w.-]+$/.test(id)) return false;
  return existsSync(joinSandbox(id));
}

/** Internal: per-sandbox home dir (mirrors worktree.ts's private layout). */
function joinSandbox(id: string): string {
  // sandboxesDir() is re-resolved at call time so this honors the tmp HOME.
  return `${sandboxesDir()}/${id}`;
}

/** Ensure the sandboxes root exists (used by negative/empty-state assertions). */
export function ensureSandboxesDir(): void {
  const dir = sandboxesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ===========================================================================
// Inbox crash simulation — a surviving PENDING proposal
// ===========================================================================

/**
 * Create a PENDING proposal via the REAL createProposal store (atomic write).
 * Models the proposal a crashed-but-completed swarm left behind: H2 must prove
 * a restart leaves it intact + still PENDING (never auto-advanced, never stuck
 * in a non-terminal limbo). Returns the created Proposal.
 */
export function seedPendingProposal(repoDir: string, title = 'h2 pending'): Proposal {
  return createProposal({
    repo: repoDir,
    origin: 'swarm',
    kind: 'patch',
    title,
    summary: 'H2 crash-recovery: a PENDING proposal that must survive a restart',
    diff: `diff --git a/${title}.txt b/${title}.txt\n`,
  });
}

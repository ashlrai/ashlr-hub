/**
 * core/swarm/runner.ts — M12 swarm runner.
 *
 * Executes a contracts-first swarm: scaffold → build (parallel) → integrate →
 * verify → review. Each task delegates to orchestrator.runGoal (local-first).
 *
 * Guardrails:
 *  - RECURSION GUARD: refuses if ASHLR_IN_SWARM is set in the environment.
 *  - HARD TOTAL BUDGET across all tasks; aborts cleanly with partial state.
 *  - Bounded concurrency (opts.parallel, default 3, max 8).
 *  - LOCAL-FIRST: cloud only when opts.allowCloud + key present.
 *  - NO OUTWARD/DESTRUCTIVE ACTION by default (code/build/test only).
 *  - Resumable via opts.resumeId; persists after every step.
 *  - --background: re-execs self as a detached worker process.
 *  - ASHLR_IN_SWARM=1 is set ONCE on this runner's process.env (see runSwarm)
 *    and inherited by every spawned engine subprocess. That single assignment
 *    is the load-bearing recursion / fork-bomb guard — do not remove it.
 *  - Never throws out of runSwarm; all errors surface in SwarmRun.status.
 *
 * M16 addition: auto-capture.
 *  - On completion (any terminal status), calls captureFromSwarm (fire-and-
 *    forget) from genome/capture.ts. Disabled via opts.noCapture or
 *    cfg.genome?.autoCapture === false. Never throws, never blocks.
 */

import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  AshlrConfig,
  SwarmRun,
  SwarmOptions,
  SwarmPlan,
  SwarmTaskRun,
  SwarmPhaseName,
  RunBudget,
  RunUsage,
} from '../types.js';
import type { StreamSink } from '../run/streaming.js';
import { newUsage, addUsage, overBudget } from '../run/budget.js';
import { planSwarm } from './planner.js';
import { saveSwarm, loadSwarm } from './store.js';
import { runGoal } from '../run/orchestrator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PARALLEL = 3;
const MAX_PARALLEL = 8;
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_MAX_STEPS = 200;

const PHASE_ORDER: SwarmPhaseName[] = [
  'scaffold',
  'build',
  'integrate',
  'verify',
  'review',
];

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `swarm-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

function buildBudget(opts: SwarmOptions): RunBudget {
  return {
    maxTokens: opts.budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: opts.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
    allowCloud: opts.budget?.allowCloud ?? opts.allowCloud ?? false,
  };
}

/**
 * Return a per-task budget slice that NEVER lets the sum of concurrently
 * authorized tasks exceed the hard total budget.
 *
 * HARD-BUDGET CONTRACT: the caller passes `reserved` — the tokens/steps already
 * authorized to in-flight siblings in the current batch (not yet reflected in
 * `used`, because run.usage is only updated AFTER a task completes). The slice
 * is computed off the pool that remains AFTER subtracting both already-spent
 * (`used`) and in-flight-authorized (`reserved`) budget, then divided across the
 * tasks still to be launched in this batch (`remainingInBatch`, >= 1). This
 * guarantees sum(authorized task budgets in a batch) <= total - used, so a
 * single concurrent batch can never overshoot the swarm ceiling (the prior
 * 8 x 25% = ~200% overshoot is impossible).
 *
 * Returns maxTokens/maxSteps === 0 when the pool is exhausted, signalling the
 * caller to skip the task rather than authorize budget that doesn't exist.
 */
function sliceBudget(
  total: RunBudget,
  used: RunUsage,
  allowCloud: boolean,
  reserved: { tokens: number; steps: number } = { tokens: 0, steps: 0 },
  remainingInBatch = 1,
): RunBudget {
  const slots = Math.max(1, remainingInBatch);
  const poolTokens = Math.max(
    0,
    total.maxTokens - (used.tokensIn + used.tokensOut) - reserved.tokens,
  );
  const poolSteps = Math.max(0, total.maxSteps - used.steps - reserved.steps);
  // Per-task ceiling: an equal share of the UNRESERVED remaining pool, capped at
  // 25% of the total so one task can't hog the whole swarm even when the batch
  // is small. Never less than 1 (avoids a zero-budget task that aborts instantly)
  // UNLESS the pool itself is exhausted — then 0 tells the caller to skip.
  const fairShareTokens = Math.floor(poolTokens / slots);
  const fairShareSteps = Math.floor(poolSteps / slots);
  const taskMaxTokens =
    poolTokens <= 0
      ? 0
      : Math.max(1, Math.min(fairShareTokens, Math.ceil(total.maxTokens / 4)));
  const taskMaxSteps =
    poolSteps <= 0
      ? 0
      : Math.max(1, Math.min(fairShareSteps, Math.ceil(total.maxSteps / 4)));
  return {
    maxTokens: taskMaxTokens,
    maxSteps: taskMaxSteps,
    allowCloud,
  };
}

// ---------------------------------------------------------------------------
// Sink helpers
// ---------------------------------------------------------------------------

function emit(
  sink: StreamSink,
  kind: 'task-start' | 'task-done' | 'log',
  text: string,
  taskId?: string,
  data?: unknown,
): void {
  try {
    sink({ kind, taskId, text, data, ts: new Date().toISOString() });
  } catch {
    // sink must never propagate
  }
}

function emitLog(sink: StreamSink, text: string, data?: unknown): void {
  emit(sink, 'log', text, undefined, data);
}

// ---------------------------------------------------------------------------
// Swarm initialisation / state helpers
// ---------------------------------------------------------------------------

function initSwarmRun(
  id: string,
  goal: string,
  specId: string | null,
  plan: SwarmPlan,
  budget: RunBudget,
  parallel: number,
  project: string | null,
): SwarmRun {
  const now = new Date().toISOString();
  const tasks: SwarmTaskRun[] = plan.tasks.map((t) => ({
    id: t.id,
    phase: t.phase,
    status: 'pending',
  }));
  return {
    id,
    goal,
    specId,
    project,
    createdAt: now,
    updatedAt: now,
    budget,
    usage: newUsage(),
    parallel,
    status: 'planning',
    plan,
    tasks,
  };
}

function touch(run: SwarmRun): void {
  run.updatedAt = new Date().toISOString();
}

/** Persist + update timestamp. */
function persist(run: SwarmRun): void {
  touch(run);
  try {
    saveSwarm(run);
  } catch {
    // best-effort persistence; never crash the run
  }
}

// ---------------------------------------------------------------------------
// Single-task execution
// ---------------------------------------------------------------------------

async function executeTask(
  taskId: string,
  goal: string,
  phase: SwarmPhaseName,
  run: SwarmRun,
  cfg: AshlrConfig,
  opts: SwarmOptions,
  sink: StreamSink,
  /** Budget already authorized to in-flight sibling tasks in this batch. */
  reserved: { tokens: number; steps: number } = { tokens: 0, steps: 0 },
  /** Number of tasks (including this one) still being launched in this batch. */
  remainingInBatch = 1,
): Promise<void> {
  // Find the SwarmTaskRun slot.
  const taskRun = run.tasks.find((t) => t.id === taskId);
  if (!taskRun) return;

  // Skip if already done (resume path).
  if (taskRun.status === 'done') return;

  // Check hard budget before starting.
  if (overBudget(run.usage, run.budget)) {
    taskRun.status = 'skipped';
    taskRun.error = 'Skipped: swarm budget exceeded before task started';
    persist(run);
    return;
  }

  // Build per-task budget slice. This accounts for BOTH already-spent usage AND
  // the budget reserved by concurrent siblings, so the sum of all in-flight task
  // budgets in a batch can never exceed the swarm's remaining hard total.
  const taskBudget = sliceBudget(
    run.budget,
    run.usage,
    opts.allowCloud ?? false,
    reserved,
    remainingInBatch,
  );

  // If the unreserved pool is exhausted, skip rather than authorize phantom
  // budget. This is what keeps a concurrent batch under the hard ceiling.
  if (taskBudget.maxTokens <= 0 || taskBudget.maxSteps <= 0) {
    taskRun.status = 'skipped';
    taskRun.error =
      'Skipped: swarm budget exhausted (no remaining tokens/steps for this task)';
    persist(run);
    return;
  }

  taskRun.status = 'running';
  persist(run);

  emit(sink, 'task-start', `[${phase}] ${goal}`, taskId);

  // Build a safe goal that cannot trigger outward actions.
  // We prefix the goal with a guardrail instruction. This is DEFENSE-IN-DEPTH
  // only — the structural no-outward guarantee comes from forcing engine:'builtin'
  // below (the builtin agent loop has no outward tool executors).
  const safeGoal = [
    'IMPORTANT: This task is part of an automated swarm. Perform ONLY code/build/test work.',
    'Do NOT push to git, deploy, create repositories, or run any outward/destructive actions.',
    `Task: ${goal}`,
  ].join('\n');

  try {
    const taskResult = await runGoal(safeGoal, cfg, {
      budget: taskBudget,
      parallel: 1,
      tools: true,
      allowCloud: opts.allowCloud ?? false,
      // HARD NO-OUTWARD GUARD: force the builtin engine so a cfg/env default
      // engine can never silently delegate a swarm task to a real autonomous
      // CLI (claude/aw/ac) that could push/deploy/ship. The builtin agent loop
      // has no outward tool executors, so the no-outward property holds even if
      // the model ignores the prompt prefix above.
      engine: 'builtin',
      // Operate WITHIN the target project dir, not wherever the swarm launched.
      cwd: run.project ?? undefined,
      // RECURSION/FORK-BOMB GUARD: ASHLR_IN_SWARM=1 is set once on this runner
      // process's env (see runSwarm) and inherited by every spawned engine
      // subprocess. That single assignment is the load-bearing guard; this task
      // sets nothing per-call.
      noMemory: false,
    });

    // Accumulate usage into swarm totals.
    run.usage = addUsage(run.usage, taskResult.usage);

    taskRun.status = taskResult.status === 'done' ? 'done' : 'failed';
    taskRun.result = taskResult.result;
    taskRun.usage = taskResult.usage;
    if (taskResult.status !== 'done') {
      taskRun.error = `Task ended with status: ${taskResult.status}`;
    }
  } catch (err) {
    taskRun.status = 'failed';
    taskRun.error = err instanceof Error ? err.message : String(err);
  }

  emit(
    sink,
    'task-done',
    `[${phase}] ${taskId} ${taskRun.status}`,
    taskId,
    { status: taskRun.status, usage: taskRun.usage },
  );

  persist(run);
}

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

async function executePhase(
  phase: SwarmPhaseName,
  run: SwarmRun,
  cfg: AshlrConfig,
  opts: SwarmOptions,
  sink: StreamSink,
  parallelCap: number,
): Promise<boolean> {
  const phaseTasks = run.plan.tasks.filter((t) => t.phase === phase);
  if (phaseTasks.length === 0) return true; // nothing to do

  emitLog(sink, `phase start: ${phase} (${phaseTasks.length} task(s))`);

  if (phase === 'build') {
    // BUILD phase: run tasks in parallel batches, capped at parallelCap.
    // Dep-respecting within build: tasks with deps wait for their deps.
    // For simplicity (planner guarantees build tasks are independent), we
    // execute them in batches of parallelCap.
    const pending = phaseTasks.filter(
      (t) =>
        run.tasks.find((r) => r.id === t.id)?.status === 'pending',
    );

    for (let i = 0; i < pending.length; i += parallelCap) {
      // Abort entire phase if budget is already blown.
      if (overBudget(run.usage, run.budget)) {
        emitLog(sink, `phase ${phase}: aborting — swarm budget exceeded`);
        return false;
      }

      const batch = pending.slice(i, i + parallelCap);

      // Reserve budget for each concurrent task BEFORE launching it, so no two
      // siblings in the same batch can both be sized against the same stale
      // run.usage. The sum of reservations + run.usage never exceeds the hard
      // total, so the batch cannot overshoot the swarm ceiling.
      const reserved = { tokens: 0, steps: 0 };
      const launches: Promise<void>[] = [];
      for (let b = 0; b < batch.length; b++) {
        const t = batch[b]!;
        const remainingInBatch = batch.length - b;
        // Snapshot the per-task slice this task will be authorized so we can
        // reserve it for the siblings launched after it in this loop.
        const slice = sliceBudget(
          run.budget,
          run.usage,
          opts.allowCloud ?? false,
          reserved,
          remainingInBatch,
        );
        const snapshot = { tokens: reserved.tokens, steps: reserved.steps };
        reserved.tokens += Math.max(0, slice.maxTokens);
        reserved.steps += Math.max(0, slice.maxSteps);
        launches.push(
          executeTask(
            t.id,
            t.goal,
            phase,
            run,
            cfg,
            opts,
            sink,
            snapshot,
            remainingInBatch,
          ),
        );
      }
      await Promise.all(launches);

      // Persist burndown after each batch.
      const done = run.tasks.filter(
        (r) =>
          phaseTasks.some((pt) => pt.id === r.id) && r.status === 'done',
      ).length;
      emitLog(
        sink,
        `phase ${phase}: ${done}/${phaseTasks.length} done`,
        { done, total: phaseTasks.length },
      );
    }
  } else {
    // All other phases: sequential execution respecting deps.
    for (const taskSpec of phaseTasks) {
      if (overBudget(run.usage, run.budget)) {
        emitLog(sink, `phase ${phase}: aborting — swarm budget exceeded`);
        return false;
      }

      // Wait for deps (from earlier phases) to have completed.
      const depsOk = taskSpec.deps.every((depId) => {
        const depRun = run.tasks.find((r) => r.id === depId);
        return depRun?.status === 'done';
      });

      if (!depsOk) {
        const taskRun = run.tasks.find((r) => r.id === taskSpec.id);
        if (taskRun) {
          taskRun.status = 'skipped';
          taskRun.error = 'Skipped: one or more dependencies did not complete';
          persist(run);
        }
        emitLog(sink, `task ${taskSpec.id} skipped: deps not met`);
        continue;
      }

      await executeTask(taskSpec.id, taskSpec.goal, phase, run, cfg, opts, sink);
    }
  }

  emitLog(sink, `phase done: ${phase}`);
  return true;
}

// ---------------------------------------------------------------------------
// Background worker re-exec
// ---------------------------------------------------------------------------

/**
 * Launch a detached background worker that will run the swarm and write
 * progress to the swarm record. Returns the swarm id immediately.
 *
 * The worker is re-exec'd as:
 *   node <bin/ashlr> swarm --resume <id> --_worker
 *
 * The --_worker flag suppresses --background recursion and signals the
 * CLI to run the swarm synchronously (no further detach).
 */
function spawnBackgroundWorker(swarmId: string): void {
  // Locate the bin entry point relative to this file.
  // __dirname equivalent for ESM:
  const thisFile = fileURLToPath(import.meta.url);
  // src/core/swarm/runner.ts → go up 3 dirs to project root → bin/ashlr
  const projectRoot = path.resolve(path.dirname(thisFile), '..', '..', '..');
  const binPath = path.join(projectRoot, 'bin', 'ashlr');

  const child = child_process.spawn(
    process.execPath,
    [binPath, 'swarm', '--resume', swarmId, '--_worker'],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        // Worker must NOT set ASHLR_IN_SWARM itself — it IS the swarm runner.
        ASHLR_IN_SWARM: undefined as unknown as string,
      },
    },
  );
  child.unref();
}

// ---------------------------------------------------------------------------
// M16: Auto-capture helper (fire-and-forget, never throws)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget genome capture for a completed swarm.
 * Dynamically imports genome/capture.js so the module can be absent
 * during pre-M16 builds without breaking anything.
 * Never throws, never blocks the caller.
 */
function fireCaptureFromSwarm(run: SwarmRun, cfg: AshlrConfig): void {
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const capMod = await import('../genome/capture.js') as any;
      if (typeof capMod.captureFromSwarm === 'function') {
        capMod.captureFromSwarm(run, cfg);
      }
    } catch {
      // Never surface capture errors to the caller.
    }
  })();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a swarm: plan → execute phases → synthesize result.
 *
 * Contract:
 *  - Never throws; all errors surface in SwarmRun.status ('failed'/'aborted').
 *  - RECURSION GUARD: refuses if ASHLR_IN_SWARM is set.
 *  - HARD TOTAL BUDGET: aborts cleanly when exceeded.
 *  - LOCAL-FIRST: cloud only when opts.allowCloud.
 *  - NO OUTWARD ACTION by default.
 *  - Resumable via opts.resumeId.
 *  - --background: re-execs self detached, returns id immediately.
 *  - M16: calls captureFromSwarm on completion unless opts.noCapture is set.
 */
export async function runSwarm(
  input: { goal: string; specId?: string },
  cfg: AshlrConfig,
  opts: SwarmOptions & { noCapture?: boolean },
  sink: StreamSink,
): Promise<SwarmRun> {
  // -------------------------------------------------------------------------
  // RECURSION GUARD — must be the very first check.
  // -------------------------------------------------------------------------
  if (process.env['ASHLR_IN_SWARM']) {
    // Build a minimal failed run record (no persistence needed — we never
    // started, and there's no id to resume).
    const now = new Date().toISOString();
    const failedRun: SwarmRun = {
      id: makeId(),
      goal: input.goal,
      specId: input.specId ?? null,
      project: opts.project ?? null,
      createdAt: now,
      updatedAt: now,
      budget: buildBudget(opts),
      usage: newUsage(),
      parallel: Math.min(
        Math.max(1, opts.parallel ?? DEFAULT_PARALLEL),
        MAX_PARALLEL,
      ),
      status: 'failed',
      plan: { specId: input.specId ?? null, goal: input.goal, tasks: [] },
      tasks: [],
      result:
        'Refused: nested swarm detected (ASHLR_IN_SWARM is set). ' +
        'A swarm task must not spawn another swarm.',
    };
    emitLog(sink, failedRun.result ?? '');
    return failedRun;
  }

  // -------------------------------------------------------------------------
  // Set ASHLR_IN_SWARM=1 on THIS process so all child engine spawns inherit it.
  // This prevents any task (via runGoal → spawnEngine) from recursively
  // invoking `ashlr swarm`.
  // -------------------------------------------------------------------------
  process.env['ASHLR_IN_SWARM'] = '1';

  // Clamp parallel concurrency.
  const parallel = Math.min(
    Math.max(1, opts.parallel ?? DEFAULT_PARALLEL),
    MAX_PARALLEL,
  );
  const budget = buildBudget(opts);
  const project = opts.project ?? null;

  // -------------------------------------------------------------------------
  // RESUME: load existing SwarmRun if resumeId provided.
  // -------------------------------------------------------------------------
  let run: SwarmRun;

  if (opts.resumeId) {
    const existing = loadSwarm(opts.resumeId);
    if (!existing) {
      const now = new Date().toISOString();
      const notFound: SwarmRun = {
        id: opts.resumeId,
        goal: input.goal,
        specId: input.specId ?? null,
        project,
        createdAt: now,
        updatedAt: now,
        budget,
        usage: newUsage(),
        parallel,
        status: 'failed',
        plan: { specId: input.specId ?? null, goal: input.goal, tasks: [] },
        tasks: [],
        result: `Resume failed: swarm "${opts.resumeId}" not found.`,
      };
      emitLog(sink, notFound.result ?? '');
      return notFound;
    }

    // Already complete — return as-is.
    if (existing.status === 'done') {
      emitLog(sink, `Swarm ${existing.id} is already complete — nothing to resume.`);
      return existing;
    }

    run = existing;
    emitLog(sink, `Resuming swarm ${run.id} (status: ${run.status})`);
  } else {
    // Fresh swarm — generate id.
    run = initSwarmRun(
      makeId(),
      input.goal,
      input.specId ?? null,
      // Plan is populated below; use empty placeholder until then.
      { specId: input.specId ?? null, goal: input.goal, tasks: [] },
      budget,
      parallel,
      project,
    );
  }

  // -------------------------------------------------------------------------
  // BACKGROUND: re-exec as detached worker.
  // -------------------------------------------------------------------------
  if (opts.background && !opts.resumeId) {
    // Persist the skeleton record so the worker can find it.
    persist(run);
    spawnBackgroundWorker(run.id);
    emitLog(sink, `Swarm ${run.id} launched in background.`);
    return run;
  }

  // A dry-run is a plan-only PREVIEW: it must NOT pollute `ashlr swarms` with a
  // misleading record (it executes nothing). Suppress all persistence on the
  // dry-run path so no swarm file is written to ~/.ashlr/swarms.
  const maybePersist = (r: SwarmRun): void => {
    if (opts.dryRun) {
      touch(r); // keep updatedAt fresh in-memory, but do not write to disk
      return;
    }
    persist(r);
  };

  // -------------------------------------------------------------------------
  // PLAN (skip if resuming — plan is already in the persisted record).
  // -------------------------------------------------------------------------
  if (!opts.resumeId || run.plan.tasks.length === 0) {
    run.status = 'planning';
    maybePersist(run);
    emitLog(sink, `Planning swarm for goal: ${input.goal}`);

    try {
      // specBody is intentionally omitted here; spec-store (a sibling module)
      // is loaded by the CLI layer (cli/swarm.ts) and passed in via the input
      // if needed. The planner accepts undefined specBody and works goal-only.
      const specBody: string | undefined = undefined;

      const plan = await planSwarm({ goal: input.goal, specBody }, cfg);
      run.plan = plan;
      // Initialise task run records from the plan (preserve any from resume).
      const existingIds = new Set(run.tasks.map((t) => t.id));
      for (const t of plan.tasks) {
        if (!existingIds.has(t.id)) {
          run.tasks.push({ id: t.id, phase: t.phase, status: 'pending' });
        }
      }
      maybePersist(run);
      emitLog(sink, `Plan ready: ${plan.tasks.length} task(s) across phases`);
    } catch (err) {
      run.status = 'failed';
      run.result = `Planning failed: ${err instanceof Error ? err.message : String(err)}`;
      maybePersist(run);
      emitLog(sink, run.result);
      if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);
      return run;
    }
  }

  // -------------------------------------------------------------------------
  // DRY-RUN: return plan without executing. Status stays 'planning' (NOT 'done')
  // and nothing is persisted — the plan is returned to the caller for preview.
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    run.status = 'planning';
    run.result = `Dry run complete (preview only). Plan has ${run.plan.tasks.length} task(s).`;
    touch(run);
    emitLog(sink, run.result);
    return run;
  }

  // -------------------------------------------------------------------------
  // EXECUTE phases in order.
  // -------------------------------------------------------------------------
  run.status = 'running';
  persist(run);

  try {
    for (const phase of PHASE_ORDER) {
      // Check hard budget before each phase.
      if (overBudget(run.usage, run.budget)) {
        run.status = 'aborted';
        run.result =
          'Swarm aborted: hard total budget exceeded before phase ' + phase;
        persist(run);
        emitLog(sink, run.result);
        if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);
        return run;
      }

      const phaseOk = await executePhase(phase, run, cfg, opts, sink, parallel);

      if (!phaseOk) {
        // Phase returned false → budget exceeded mid-phase.
        run.status = 'aborted';
        run.result = `Swarm aborted: hard total budget exceeded during phase ${phase}`;
        persist(run);
        emitLog(sink, run.result);
        if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);
        return run;
      }
    }
  } catch (err) {
    // Unexpected error in the phase loop — surface cleanly.
    run.status = 'failed';
    run.result = `Swarm failed: ${err instanceof Error ? err.message : String(err)}`;
    persist(run);
    emitLog(sink, run.result);
    if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);
    return run;
  }

  // -------------------------------------------------------------------------
  // SYNTHESIZE result.
  // -------------------------------------------------------------------------
  const doneTasks = run.tasks.filter((t) => t.status === 'done');
  const failedTasks = run.tasks.filter((t) => t.status === 'failed');
  const skippedTasks = run.tasks.filter((t) => t.status === 'skipped');

  const summaryLines: string[] = [
    `Swarm complete. Goal: ${run.goal}`,
    `Tasks: ${doneTasks.length} done, ${failedTasks.length} failed, ${skippedTasks.length} skipped.`,
    `Total usage: ${run.usage.tokensIn + run.usage.tokensOut} tokens, ${run.usage.steps} steps.`,
  ];

  if (failedTasks.length > 0) {
    summaryLines.push(
      'Failed tasks: ' +
        failedTasks.map((t) => `${t.id} (${t.error ?? 'unknown'})`).join(', '),
    );
  }

  if (doneTasks.length > 0) {
    summaryLines.push('\nTask results:');
    for (const t of doneTasks) {
      if (t.result) {
        summaryLines.push(`[${t.id}] ${t.result.slice(0, 200)}`);
      }
    }
  }

  run.result = summaryLines.join('\n');
  run.status = failedTasks.length === run.tasks.length ? 'failed' : 'done';
  persist(run);

  emitLog(sink, `Swarm ${run.id} finished with status: ${run.status}`);

  // M16: Auto-capture on completion (fire-and-forget, never throws).
  if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);

  return run;
}

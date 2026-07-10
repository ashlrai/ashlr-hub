/**
 * core/swarm/runner.ts — M12 swarm runner, M17 verified + unattended-safe.
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
 *
 * M17 additions: verified + unattended-safe swarms.
 *  - snapshotProject: on swarm start, snapshot the project's git state.
 *  - signOutput: after each task completes (done), sign its result.
 *  - verifyOutput: before a task consumes a dep's result, verify the dep's sig.
 *    On mismatch → EscalationEvent{kind:'tamper'} + 'needs-approval' + STOP.
 *  - shouldEscalate: after each task, risk-scan goal+result; on a hit →
 *    EscalationEvent + 'needs-approval' + STOP. Over-budget is handled by
 *    the existing M12 hard-abort path (status='aborted'), not this gate.
 *  - opts.approved: when resuming a 'needs-approval' swarm, clear the pause.
 *  - All M17 helpers are best-effort: import failures degrade gracefully.
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
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
  EscalationEvent,
  EscalationReasonKind,
  Sandbox,
  SandboxDiff,
  DelegationScope,
} from '../types.js';
import type { StreamSink } from '../run/streaming.js';
import { newUsage, addUsage, overBudget } from '../run/budget.js';
import { planSwarm } from './planner.js';
import { saveSwarm, loadSwarm } from './store.js';
import { runGoal } from '../run/orchestrator.js';
import { scrubSecrets } from '../knowledge/index.js';
import { mergeDelegationScope, summarizeDelegationScope } from '../run/delegation-scope.js';
import { assertSafeExecutionIdentity } from '../fleet/attempt-identity.js';

// ---------------------------------------------------------------------------
// M17: lazy-load sign / gate / rollback helpers. Each import is best-effort:
// if the module hasn't been built yet the feature degrades silently.
// ---------------------------------------------------------------------------

// Inline type stubs so we can reference without a hard circular dep.
type SignFn = (content: string, cfg: AshlrConfig) => import('../types.js').OutputSignature;
type VerifyFn = (
  content: string,
  sig: import('../types.js').OutputSignature,
  cfg: AshlrConfig,
) => boolean;
type RiskScanFn = (text: string) => { risky: boolean; reason: string };
type ShouldEscalateFn = (ctx: {
  verifyFailed?: boolean;
  overBudget?: boolean;
  tamper?: boolean;
  risk?: boolean;
  lowConfidence?: boolean;
}) => EscalationReasonKind | null;
type SnapshotFn = (project: string | null) => import('../types.js').RollbackSnapshot;

let _signOutput: SignFn | null = null;
let _verifyOutput: VerifyFn | null = null;
let _riskScan: RiskScanFn | null = null;
let _shouldEscalate: ShouldEscalateFn | null = null;
let _snapshotProject: SnapshotFn | null = null;
let _m17Loaded = false;

async function loadM17(): Promise<void> {
  if (_m17Loaded) return;
  _m17Loaded = true;
  try {
    const sign = await import('./sign.js') as { signOutput: SignFn; verifyOutput: VerifyFn };
    _signOutput = sign.signOutput;
    _verifyOutput = sign.verifyOutput;
  } catch {
    // sign.ts not built yet — signing/verification degrades to no-op
  }
  try {
    const gate = await import('./gate.js') as { riskScan: RiskScanFn; shouldEscalate: ShouldEscalateFn };
    _riskScan = gate.riskScan;
    _shouldEscalate = gate.shouldEscalate;
  } catch {
    // gate.ts not built yet — escalation degrades to no-op
  }
  try {
    const rb = await import('./rollback.js') as { snapshotProject: SnapshotFn };
    _snapshotProject = rb.snapshotProject;
  } catch {
    // rollback.ts not built yet — snapshot degrades to no-op
  }
}

// ---------------------------------------------------------------------------
// M21: lazy-load sandbox primitives (best-effort; degrade if modules absent).
// Sandbox mode is a SEAM — default OFF; M24 wires it. When opts.sandbox is
// true and a project is set, the swarm operates inside an isolated worktree
// so autonomous edits NEVER touch the user's working tree.
// ---------------------------------------------------------------------------

type CreateSandboxFn = (sourceRepo: string, opts?: { allowAnyRepo?: boolean }) => Sandbox;
type SandboxDiffFn   = (sb: Sandbox) => SandboxDiff;
type RemoveSandboxFn = (sb: Sandbox) => void;
type AuditFn         = (entry: Omit<import('../types.js').AuditEntry, 'ts'>) => void;
// M24: lazy proposal sink — when opts.propose is set the captured sandbox diff
// is recorded as a PENDING inbox proposal (applied LATER only by a human).
type CreateProposalFn = (
  p: Omit<import('../types.js').Proposal, 'id' | 'status' | 'createdAt'>,
) => import('../types.js').Proposal;

let _createSandbox:  CreateSandboxFn  | null = null;
let _sandboxDiff:    SandboxDiffFn    | null = null;
let _removeSandbox:  RemoveSandboxFn  | null = null;
let _audit:          AuditFn          | null = null;
let _createProposal: CreateProposalFn | null = null;
let _m21Loaded = false;

async function loadM21(): Promise<void> {
  if (_m21Loaded) return;
  _m21Loaded = true;
  try {
    // Store the specifier in a variable so TypeScript does not attempt static
    // module resolution on a module that may not exist yet (M21 worktree.ts is
    // built by a sibling agent). The try/catch degrades gracefully if absent.
    const wtSpec = '../sandbox/worktree.js';
    const wt = await import(/* @vite-ignore */ wtSpec) as {
      createSandbox: CreateSandboxFn;
      sandboxDiff: SandboxDiffFn;
      removeSandbox: RemoveSandboxFn;
    };
    _createSandbox = wt.createSandbox;
    _sandboxDiff   = wt.sandboxDiff;
    _removeSandbox = wt.removeSandbox;
  } catch {
    // worktree.ts not built yet — sandbox mode degrades to no-op (default behavior)
  }
  try {
    const auSpec = '../sandbox/audit.js';
    const au = await import(/* @vite-ignore */ auSpec) as { audit: AuditFn };
    _audit = au.audit;
  } catch {
    // audit.ts not built yet — audit degrades to no-op
  }
  try {
    // M24: the inbox proposal sink — used ONLY when opts.propose is set.
    const ibSpec = '../inbox/store.js';
    const ib = await import(/* @vite-ignore */ ibSpec) as { createProposal: CreateProposalFn };
    _createProposal = ib.createProposal;
  } catch {
    // inbox/store.ts not built yet — propose degrades to no-op
  }
}

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

// Monotonic, process-local sequence counter. Date.now() has only millisecond
// resolution, so two swarms minted in the same ms would otherwise rely solely on
// the ~24-bit random suffix for uniqueness (birthday-bound collision risk under
// bursty creation). Mirrors inbox/store.ts generateId(): the zero-padded counter
// comes BEFORE the random segment so lexicographic id comparison orders by
// (timestamp, monotonic counter) — a stable most-recent-first tiebreak. Purely
// additive id-uniqueness hardening: no behavior/signature change, no new dep, no
// guard touched. Exported as a thin test seam for the H3 stress suite.
//
// SINGLE-PROCESS BOUNDARY: `_seq` is module-level and resets to 0 per process, so
// it guarantees uniqueness only WITHIN one process. Two concurrent daemon
// processes minting in the same ms rely on the `<ts>`+`<rand>` segments alone
// (astronomically unlikely, not a hard cross-process guarantee). Cross-process id
// allocation — like the multi-daemon budget race — is the GATED M30
// DaemonCoordinator seam, out of H3 scope. See docs/contracts/CONTRACT-H3.md MULTI-PROCESS
// LIMITATION.
let _seq = 0;
export function makeId(): string {
  const ts = Date.now().toString(36);
  const seq = (_seq++).toString(36).padStart(6, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `swarm-${ts}-${seq}-${rand}`;
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
// M17 helpers — escalation
// ---------------------------------------------------------------------------

/**
 * Push an EscalationEvent onto the SwarmRun, set status='needs-approval',
 * persist, and emit a log line. The CALLER must stop the swarm after this.
 * Never throws.
 */
function escalate(
  run: SwarmRun,
  kind: EscalationReasonKind,
  taskId: string | null,
  detail: string,
  sink: StreamSink,
): void {
  const event: EscalationEvent = {
    taskId,
    kind,
    detail,
    ts: new Date().toISOString(),
  };
  if (!run.escalations) run.escalations = [];
  run.escalations.push(event);
  run.status = 'needs-approval';
  persist(run);
  emitLog(sink, `[M17] Swarm PAUSED (needs-approval): ${kind} — ${detail}`, { taskId, kind });
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

/**
 * Returns 'continue' when the task completed normally (or was skipped/failed
 * without tripping a gate), 'escalate' when an M17 gate fired and the swarm
 * must STOP (status already set to 'needs-approval' by escalate()).
 */
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
  /**
   * M21 SANDBOX SEAM: when set, tasks run inside the worktree path instead of
   * run.project. Null (default) = exactly today's behavior (use run.project).
   */
  sandboxCwd: string | null = null,
): Promise<'continue' | 'escalate'> {
  // Find the SwarmTaskRun slot.
  const taskRun = run.tasks.find((t) => t.id === taskId);
  if (!taskRun) return 'continue';

  // Skip if already done (resume path).
  if (taskRun.status === 'done') return 'continue';

  // Check hard budget before starting.
  if (overBudget(run.usage, run.budget)) {
    taskRun.status = 'skipped';
    taskRun.error = 'Skipped: swarm budget exceeded before task started';
    persist(run);
    return 'continue';
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
    return 'continue';
  }
  const taskDelegationScope = mergeDelegationScope(opts.delegationScope, {
    origin: 'swarm',
    sourceRepo: run.project ?? undefined,
    executionRoot: sandboxCwd ?? run.project ?? undefined,
    workItemId: opts.workItemId,
    workSource: opts.workSource,
    swarmId: run.id,
    taskId,
    objective: goal,
    budget: taskBudget,
    resultContract: { kind: 'text' },
  });

  // -------------------------------------------------------------------------
  // M17: verify dependency signatures BEFORE consuming their outputs.
  // On any tamper/mismatch, escalate and stop — do NOT proceed.
  // -------------------------------------------------------------------------
  const taskSpec = run.plan.tasks.find((t) => t.id === taskId);
  if (taskSpec !== undefined && taskSpec.deps.length > 0 && _verifyOutput !== null) {
    for (const depId of taskSpec.deps) {
      const depRun = run.tasks.find((r) => r.id === depId);
      if (
        depRun !== undefined &&
        depRun.status === 'done' &&
        depRun.result !== undefined
      ) {
        // UNSIGNED-DEPENDENCY GATE: if signing is enabled (_signOutput present)
        // but this done dep carries NO signature, do NOT silently consume it.
        // An attacker who edits a persisted dep result AND strips its signature
        // would otherwise defeat tamper detection ("only when a signature happens
        // to exist"). Treat a missing signature on a signed-swarm dep as tamper.
        // Skip the gate when this task was explicitly approved by a human.
        if (
          depRun.signature === undefined &&
          _signOutput !== null &&
          taskRun.approved !== true
        ) {
          escalate(
            run,
            'tamper',
            taskId,
            `Dependency "${depId}" completed without a signature (signing is enabled) — ` +
              `cannot verify its output; possible tamper or stripped signature.`,
            sink,
          );
          return 'escalate';
        }

        if (depRun.signature !== undefined) {
          // verifyOutput never throws (contract); extra guard just in case.
          let ok = false;
          try {
            ok = _verifyOutput(depRun.result, depRun.signature, cfg);
          } catch {
            ok = false;
          }
          if (!ok) {
            escalate(
              run,
              'tamper',
              taskId,
              `Dependency "${depId}" output failed signature verification — possible tamper.`,
              sink,
            );
            return 'escalate';
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // M17: risk scan on the task GOAL before execution.
  //
  // SKIP when this task was explicitly approved by a human (taskRun.approved):
  // the pre-execution goal-risk gate trips BEFORE the task runs, so without this
  // skip an approved goal-risk escalation would re-scan the identical static
  // goal text on resume and re-escalate forever (infinite needs-approval loop).
  // approved is only set by `ashlr swarm approve <id>` for the escalated task.
  // -------------------------------------------------------------------------
  if (_riskScan !== null && _shouldEscalate !== null && taskRun.approved !== true) {
    let goalRisk = { risky: false, reason: '' };
    try { goalRisk = _riskScan(goal); } catch { /* never throws by contract */ }
    if (goalRisk.risky) {
      let kind: EscalationReasonKind | null = null;
      try { kind = _shouldEscalate({ risk: true }); } catch { /* pure, never throws */ }
      if (kind !== null) {
        escalate(run, kind, taskId, `Risk gate on task goal: ${goalRisk.reason}`, sink);
        return 'escalate';
      }
    }
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
      // M21: operate in the sandbox worktree when set; otherwise fall back to
      // run.project (unchanged behavior when opts.sandbox is falsy).
      cwd: sandboxCwd ?? run.project ?? undefined,
      // RECURSION/FORK-BOMB GUARD: ASHLR_IN_SWARM=1 is set once on this runner
      // process's env (see runSwarm) and inherited by every spawned engine
      // subprocess. That single assignment is the load-bearing guard; this task
      // sets nothing per-call.
      noMemory: false,
      ...(taskDelegationScope ? { delegationScope: taskDelegationScope } : {}),
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

  // -------------------------------------------------------------------------
  // M17: sign the task output when done (tamper-evidence for downstream tasks).
  // Best-effort: a signing failure never crashes or blocks the swarm.
  // -------------------------------------------------------------------------
  if (taskRun.status === 'done' && taskRun.result !== undefined && _signOutput !== null) {
    try {
      taskRun.signature = _signOutput(taskRun.result, cfg);
    } catch {
      // best-effort; absent signature means downstream verification skips this dep
    }
  }

  // -------------------------------------------------------------------------
  // M17: post-task escalation gates — risk scan on task result.
  //
  // NOTE: over-budget is intentionally NOT checked here. The existing M12
  // hard-budget abort logic (phase-loop pre-phase check + per-task pre-start
  // check) owns over-budget and surfaces it as status='aborted'. Passing
  // overBudget:true to shouldEscalate here would race against those checks
  // and produce status='needs-approval' instead of 'aborted', breaking the
  // M12 contract and the 1619 tests. The 'over-budget' escalation kind
  // remains available for callers that opt into it explicitly (e.g. the CLI
  // approve path), but the runner uses the M12 hard-abort for this condition.
  // -------------------------------------------------------------------------
  // SKIP the result risk scan for an explicitly-approved task too: once a human
  // has approved a task past its gate, re-escalating on the same task's output
  // would defeat the approval and (on the next approve) loop. approved tasks are
  // a deliberate, human-acknowledged exception.
  if (_riskScan !== null && _shouldEscalate !== null && taskRun.approved !== true) {
    // Risk scan on the result text (could contain outward-op output).
    let resultRisk = { risky: false, reason: '' };
    try { resultRisk = _riskScan(taskRun.result ?? ''); } catch { /* never throws */ }

    if (resultRisk.risky) {
      let kind: EscalationReasonKind | null = null;
      try { kind = _shouldEscalate({ risk: true }); } catch { kind = null; }

      if (kind !== null) {
        escalate(run, kind, taskId, `Risk gate on task result: ${resultRisk.reason}`, sink);
        return 'escalate';
      }
    }
  }

  persist(run);
  return 'continue';
}

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

/**
 * Returns:
 *   true        — phase completed normally
 *   false       — budget exceeded mid-phase
 *   'escalate'  — an M17 gate fired; swarm must STOP
 */
async function executePhase(
  phase: SwarmPhaseName,
  run: SwarmRun,
  cfg: AshlrConfig,
  opts: SwarmOptions,
  sink: StreamSink,
  parallelCap: number,
  /** M21 SANDBOX SEAM: worktree path to run tasks in. Null = today's behavior. */
  sandboxCwd: string | null = null,
): Promise<boolean | 'escalate'> {
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
      const launches: Promise<'continue' | 'escalate'>[] = [];
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
            sandboxCwd,
          ),
        );
      }
      const results = await Promise.all(launches);

      // If any task in the batch triggered an escalation gate, stop the phase.
      if (results.includes('escalate')) {
        return 'escalate';
      }

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

      const result = await executeTask(taskSpec.id, taskSpec.goal, phase, run, cfg, opts, sink, { tokens: 0, steps: 0 }, 1, sandboxCwd);
      if (result === 'escalate') {
        return 'escalate';
      }
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
// M19: Telemetry emit + governance (best-effort, fire-and-forget, opt-in)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget OTLP/local telemetry emit for a completed swarm.
 *
 * Dynamically imports observability/telemetry-sink.ts and observability/otlp.ts
 * so this file compiles even before those modules exist. Only emits when both
 * modules are available. All failures are logged to stderr; never thrown to
 * the caller. Never blocks. METADATA ONLY — spans carry model/token/cost/ids/
 * status; never prompts, completions, tool args, file contents, or secrets.
 */
async function fireEmitSwarm(run: SwarmRun, cfg: AshlrConfig): Promise<void> {
  await (async () => {
    try {
      // Lazy-import the telemetry seam so the swarm core has no hard dependency
      // on it at module-load time (keeps the emit fully best-effort). Both
      // modules are real and fully typed.
      const [sinkMod, otlpMod] = await Promise.all([
        import('../observability/telemetry-sink.js'),
        import('../observability/otlp.js'),
      ]);
      if (
        typeof sinkMod.getSink !== 'function' ||
        typeof otlpMod.spansFromSwarm !== 'function'
      ) {
        return;
      }
      // allowPhantomProbe:false — never run a blocking spawnSync phantom probe
      // on the swarm completion path; OtlpHttpSink resolves the PAT async/bounded.
      const telSink = sinkMod.getSink(cfg, false);
      const spans = otlpMod.spansFromSwarm(run);
      const result = await telSink.emit(spans);
      if (!result.ok) {
        process.stderr.write(
          `[ashlr swarm] telemetry: emit failed — ${result.detail ?? 'unknown'}\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashlr swarm] telemetry: best-effort emit failed — ${msg}\n`);
    }
  })();
}

/**
 * Evaluate spend governance for a swarm run.
 * Returns a blocking reason string when govAction==='block' AND level==='over'
 * AND --over-budget was not passed. Prints a prominent advisory for warn/over.
 * Never throws. Returns null to proceed normally.
 */
async function checkGovernanceSwarm(cfg: AshlrConfig, overBudgetFlag: boolean): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const govMod = await import('../observability/governance.js') as any;
    if (typeof govMod.evalGovernance !== 'function') return null;
    const verdict = govMod.evalGovernance(cfg) as import('../types.js').GovernanceStatus;
    if (verdict.level === 'over') {
      process.stderr.write(`\n[ashlr swarm] SPEND GOVERNANCE OVER-CAP: ${verdict.message}\n\n`);
      if (cfg.telemetry?.govAction === 'block' && !overBudgetFlag) {
        return (
          `Swarm blocked by spend governance: ${verdict.message} ` +
          `Pass --over-budget to proceed.`
        );
      }
    } else if (verdict.level === 'warn') {
      process.stderr.write(`\n[ashlr swarm] SPEND GOVERNANCE WARNING: ${verdict.message}\n\n`);
    }
    return null;
  } catch {
    // Governance must never block a swarm on error.
    return null;
  }
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
// M21: sandbox diff-capture + cleanup helper
// ---------------------------------------------------------------------------

/**
 * Capture the diff from an active sandbox worktree and remove it.
 * Appends a `[M21 sandbox proposal]` block to run.result.
 * Always cleans up (removes worktree + scratch branch) regardless of errors.
 * Never throws — all errors are logged to sink and audited.
 */
function captureSandboxAndCleanup(
  sb: Sandbox,
  run: SwarmRun,
  sink: StreamSink,
  propose = false,
  cfg?: import('../types.js').AshlrConfig,
  causal?: {
    workItemId?: string;
    workSource?: import('../types.js').WorkSource;
    delegationScope?: DelegationScope;
  },
): void {
  // Capture diff (read-only; never mutates source tree).
  let diff: SandboxDiff | null = null;
  if (_sandboxDiff !== null) {
    try {
      diff = _sandboxDiff(sb);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitLog(sink, `[M21] Sandbox diff capture failed: ${msg}`);
      try {
        _audit?.({
          action: 'sandbox:diff',
          repo: sb.sourceRepo,
          sandboxId: sb.id,
          summary: `Diff capture failed: ${msg.slice(0, 120)}`,
          result: 'error',
        });
      } catch { /* audit best-effort */ }
    }
  }

  if (diff !== null) {
    // Append proposed diff summary to run.result without overwriting it.
    const proposal = [
      '',
      `[M21 sandbox proposal] id=${sb.id}`,
      `files=${diff.files} insertions=${diff.insertions} deletions=${diff.deletions}`,
      diff.patch ? diff.patch.slice(0, 4000) : '(empty diff)',
    ].join('\n');
    run.result = (run.result ?? '') + proposal;
    emitLog(sink, `[M21] Sandbox diff captured: ${diff.files} file(s) changed`);
    try {
      _audit?.({
        action: 'sandbox:diff',
        repo: sb.sourceRepo,
        sandboxId: sb.id,
        summary: `files=${diff.files} +${diff.insertions} -${diff.deletions}`,
        result: 'ok',
      });
    } catch { /* audit best-effort */ }

    // M24: when the caller (e.g. the daemon) sets opts.propose, record the
    // captured diff as a PENDING inbox proposal. This is the ONLY way the
    // daemon's work surfaces. A PENDING proposal is applied LATER only by an
    // explicit human inbox approve — never automatically, never here.
    // M87: skip empty proposals — a 0-diff run produces no actionable patch.
    // The proposal-only gate line below is canonical (the H4 safety grep checks
    // for it), so the empty-skip is a NESTED guard, not inlined into the condition.
    if (propose && _createProposal !== null) {
      if (diff.files === 0 || diff.patch.trim().length === 0) {
        emitLog(sink, `[M87] swarm ${run.id} produced no diff — no proposal filed`);
      } else try {
        // M107 (P0): scrub secrets from the diff BEFORE storing. Mirrors the
        // sandboxed-engine path (M47.1) — an agent-hardcoded token in a patch
        // must not persist to the inbox or surface via ashlr_inbox_list.
        const scrubbedPatch = diff.patch ? scrubSecrets(diff.patch) : undefined;

        // M275 (sync): lockfile integrity check. Self-verify (typecheck/test)
        // runs only in the async sandboxed-engine path; here we validate that a
        // package.json change includes a lockfile update. Flag-off → skip.
        // NOTE: we do NOT import completeness-gate.ts here to keep runner.ts sync.
        if (cfg?.foundry?.completenessGate !== false) {
          const _lockfiles = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'];
          const _patch = diff.patch ?? '';
          const _hasPkgJson = _patch.includes('package.json');
          const _patchHasLockfile = _lockfiles.some((lf) => _patch.includes(lf));
          const _repoHasLockfile = _lockfiles.some((lf) => existsSync(path.join(sb.sourceRepo, lf)));
          if (_hasPkgJson && _repoHasLockfile && !_patchHasLockfile) {
            emitLog(sink, `[M275] completeness gate blocked swarm proposal: dependency change (package.json) lacks corresponding lockfile update`);
            return; // do not file — captureSandboxAndCleanup is void
          }
        }

        const proposalDelegationScope = summarizeDelegationScope(
          mergeDelegationScope(causal?.delegationScope, {
            origin: 'swarm',
            sourceRepo: sb.sourceRepo,
            executionRoot: sb.worktreePath,
            workItemId: causal?.workItemId,
            workSource: causal?.workSource,
            swarmId: run.id,
            objective: run.goal,
            budget: run.budget,
            resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
          }),
        );
        const created = _createProposal({
          repo: sb.sourceRepo,
          origin: 'swarm',
          kind: 'patch',
          title: (run.goal || `swarm ${run.id}`).slice(0, 120),
          summary: [
            `Autonomous swarm proposal (swarm=${run.id}, status=${run.status})`,
            `repo: ${sb.sourceRepo}`,
            `diff: ${diff.files} file(s), +${diff.insertions} -${diff.deletions}`,
          ].join('\n'),
          diff: scrubbedPatch,
          sandboxId: sb.id,
          workItemId: causal?.workItemId,
          workSource: causal?.workSource,
          runId: run.id,
          ...(proposalDelegationScope ? { delegationScope: proposalDelegationScope } : {}),
        });
        emitLog(sink, `[M24] PENDING proposal recorded for swarm ${run.id}`);
        // M32: unattended path (daemon-dispatched swarm) — fire opt-in desktop/
        // webhook notification. Fire-and-forget; metadata only; never blocks.
        void (async () => {
          try {
            const { loadConfig } = await import('../config.js');
            const { notifyNewProposal } = await import('../inbox/notify-proposal.js');
            await notifyNewProposal(created, loadConfig());
          } catch { /* notification is best-effort */ }
        })();
        try {
          _audit?.({
            action: 'inbox:proposal-created',
            repo: sb.sourceRepo,
            sandboxId: sb.id,
            summary: `daemon swarm ${run.id} -> PENDING proposal (${diff.files} file(s))`,
            result: 'ok',
          });
        } catch { /* audit best-effort */ }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitLog(sink, `[M24] Proposal creation failed: ${msg.slice(0, 120)}`);
      }
    }
  }

  // Always remove sandbox (worktree + scratch branch). Never touches source tree.
  if (_removeSandbox !== null) {
    try {
      _removeSandbox(sb);
      emitLog(sink, `[M21] Sandbox ${sb.id} removed`);
      try {
        _audit?.({
          action: 'sandbox:remove',
          repo: sb.sourceRepo,
          sandboxId: sb.id,
          summary: `Swarm ${run.id} sandbox removed`,
          result: 'ok',
        });
      } catch { /* audit best-effort */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitLog(sink, `[M21] Sandbox removal failed (manual cleanup may be needed): ${msg}`);
      try {
        _audit?.({
          action: 'sandbox:remove',
          repo: sb.sourceRepo,
          sandboxId: sb.id,
          summary: `Removal failed: ${msg.slice(0, 120)}`,
          result: 'error',
        });
      } catch { /* audit best-effort */ }
    }
  }
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
 *  - M17: snapshots project git state, signs task outputs, verifies dep
 *    signatures before consumption, escalates on gate trips.
 *    opts.approved: when set alongside opts.resumeId, resumes a swarm that
 *    is in 'needs-approval' status (set by ashlr swarm approve <id>).
 */
export async function runSwarm(
  input: { goal: string; specId?: string },
  cfg: AshlrConfig,
  opts: SwarmOptions & { noCapture?: boolean; approved?: boolean },
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

  const refuseFreshIdentity = (reason: string): SwarmRun => {
    const now = new Date().toISOString();
    const failed: SwarmRun = {
      id: makeId(),
      goal: input.goal,
      specId: input.specId ?? null,
      project: opts.project ?? null,
      createdAt: now,
      updatedAt: now,
      budget: buildBudget(opts),
      usage: newUsage(),
      parallel: Math.min(Math.max(1, opts.parallel ?? DEFAULT_PARALLEL), MAX_PARALLEL),
      status: 'failed',
      plan: { specId: input.specId ?? null, goal: input.goal, tasks: [] },
      tasks: [],
      result: `Refused: ${reason}. No swarm work was executed.`,
    };
    emitLog(sink, failed.result ?? '');
    return failed;
  };
  if (opts.resumeId && opts.runId) opts = { ...opts, runId: undefined };
  if (opts.runId) {
    let runId: string;
    try {
      runId = assertSafeExecutionIdentity(opts.runId);
    } catch {
      return refuseFreshIdentity('caller-supplied run id is invalid');
    }
    if (loadSwarm(runId)) {
      return refuseFreshIdentity(`swarm "${runId}" already exists; use resumeId to continue it`);
    }
    opts = { ...opts, runId };
  }

  // -------------------------------------------------------------------------
  // Set ASHLR_IN_SWARM=1 on THIS process so all child engine spawns inherit it.
  // This prevents any task (via runGoal → spawnEngine) from recursively
  // invoking `ashlr swarm`.
  // -------------------------------------------------------------------------
  process.env['ASHLR_IN_SWARM'] = '1';

  // -------------------------------------------------------------------------
  // M17: load sign / gate / rollback helpers (best-effort, never throws).
  // -------------------------------------------------------------------------
  await loadM17();

  // -------------------------------------------------------------------------
  // M21: load sandbox primitives (best-effort, never throws).
  // -------------------------------------------------------------------------
  await loadM21();

  // Clamp parallel concurrency.
  const parallel = Math.min(
    Math.max(1, opts.parallel ?? DEFAULT_PARALLEL),
    MAX_PARALLEL,
  );
  const budget = buildBudget(opts);
  const project = opts.project ?? null;
  const causal = {
    workItemId: opts.workItemId,
    workSource: opts.workSource,
    delegationScope: opts.delegationScope,
  };

  // -------------------------------------------------------------------------
  // M21 SANDBOX SEAM: when opts.sandbox is true AND project is set AND the
  // worktree module loaded, create an isolated git-worktree sandbox so all
  // task execution operates on the worktree path — NEVER the source working
  // tree. Default (opts.sandbox falsy or modules absent) = exactly today's
  // behavior; no worktree is created and sandboxCwd stays null.
  // -------------------------------------------------------------------------
  let activeSandbox: Sandbox | null = null;
  // The cwd that tasks should run in. null = use run.project (unchanged behavior).
  let sandboxCwd: string | null = null;

  // M24 STRICT SANDBOX: when the caller demands a mandatory sandbox
  // (opts.requireSandbox, ALWAYS set by the autonomous daemon), the sandbox is
  // non-optional. If it cannot be created — worktree module absent, source not a
  // git repo, HEAD unresolvable, `git worktree add` fails, or a kill-switch race
  // inside createSandbox — the swarm MUST abort and execute ZERO tasks rather
  // than silently falling back to run.project (the user's real working tree).
  const requireSandbox = opts.sandbox === true && opts.requireSandbox === true;

  const abortNoSandbox = (reason: string): SwarmRun => {
    const ts = new Date().toISOString();
    const aborted: SwarmRun = {
      id: opts.runId ?? makeId(),
      goal: input.goal,
      specId: input.specId ?? null,
      project,
      createdAt: ts,
      updatedAt: ts,
      budget,
      usage: newUsage(),
      parallel,
      status: 'failed',
      plan: { specId: input.specId ?? null, goal: input.goal, tasks: [] },
      tasks: [],
      result:
        `Refused: a mandatory sandbox could not be created (${reason}). ` +
        'No tasks were executed; the working tree was NOT touched.',
    };
    emitLog(sink, aborted.result ?? '');
    try {
      _audit?.({
        action: 'sandbox:create',
        repo: project,
        sandboxId: null,
        summary: `Mandatory sandbox unavailable — swarm aborted (zero tasks): ${reason.slice(0, 120)}`,
        result: 'error',
      });
    } catch { /* audit is best-effort */ }
    return aborted;
  };

  if (opts.sandbox === true && project !== null && _createSandbox !== null) {
    try {
      activeSandbox = _createSandbox(project);
      sandboxCwd = activeSandbox.worktreePath;
      emitLog(sink, `[M21] Sandbox created: ${activeSandbox.id} at ${sandboxCwd}`);
      try {
        _audit?.({
          action: 'sandbox:create',
          repo: project,
          sandboxId: activeSandbox.id,
          summary: `Sandbox created for goal: ${input.goal.slice(0, 120)}`,
          result: 'ok',
        });
      } catch { /* audit is best-effort */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // M24: when the sandbox is MANDATORY, a creation failure aborts the run —
      // NEVER fall back to the user's working tree.
      if (requireSandbox) {
        return abortNoSandbox(`createSandbox failed: ${msg}`);
      }
      // Legacy (non-strict) behavior: fall back to non-sandbox mode rather than
      // crashing the swarm. Log the failure and proceed with source tree.
      emitLog(sink, `[M21] Sandbox creation failed (running without sandbox): ${msg}`);
      try {
        _audit?.({
          action: 'sandbox:create',
          repo: project,
          sandboxId: null,
          summary: `Sandbox creation failed: ${msg.slice(0, 120)}`,
          result: 'error',
        });
      } catch { /* audit is best-effort */ }
      activeSandbox = null;
      sandboxCwd = null;
    }
  } else if (requireSandbox) {
    // Sandbox demanded but a precondition is missing: no project to sandbox, or
    // the worktree module is absent. Abort — do NOT run against run.project.
    if (project === null) {
      return abortNoSandbox('no project specified for a mandatory sandbox');
    }
    return abortNoSandbox('sandbox worktree module unavailable');
  }

  // -------------------------------------------------------------------------
  // M19: Spend governance check (advisory; block only when govAction==='block').
  // Read --over-budget as an extended property (same pattern as noCapture).
  // -------------------------------------------------------------------------
  {
    const overBudgetFlag =
      (opts as SwarmOptions & { overBudget?: boolean }).overBudget === true;
    const govBlock = await checkGovernanceSwarm(cfg, overBudgetFlag);
    if (govBlock !== null) {
      const now = new Date().toISOString();
      const blockedRun: SwarmRun = {
        id: opts.runId ?? makeId(),
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
        result: govBlock,
      };
      process.stderr.write(`[ashlr swarm] ${govBlock}\n`);
      emitLog(sink, govBlock);
      return blockedRun;
    }
  }

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

    // -----------------------------------------------------------------------
    // M17: 'needs-approval' — only proceed when explicitly approved.
    // No auto-approval path: if approved flag is absent, return as-is.
    // -----------------------------------------------------------------------
    if (existing.status === 'needs-approval') {
      if (!opts.approved) {
        emitLog(
          sink,
          `Swarm ${existing.id} is paused (needs-approval). ` +
          `Run \`ashlr swarm approve ${existing.id}\` to resume.`,
        );
        return existing;
      }
      // Approved: clear the gate, set running, persist, then continue.
      existing.status = 'running';
      persist(existing);
      emitLog(sink, `Swarm ${existing.id} approved — resuming execution.`);
    }

    run = existing;
    emitLog(sink, `Resuming swarm ${run.id} (status: ${run.status})`);
  } else {
    // Fresh swarm — generate id.
    run = initSwarmRun(
      opts.runId ?? makeId(),
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
      // M21: clean up sandbox even on planning failure (no diff to capture yet).
      if (activeSandbox !== null) captureSandboxAndCleanup(activeSandbox, run, sink, opts.propose === true, cfg, causal);
      await fireEmitSwarm(run, cfg);
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
  // M17: snapshot the project git state at swarm start (read-only, never throws).
  // Only snapshot once — skip if a rollback snapshot already exists (resume path).
  // -------------------------------------------------------------------------
  if (_snapshotProject !== null && run.rollback === undefined) {
    try {
      run.rollback = _snapshotProject(project);
    } catch {
      // best-effort: snapshot failure never blocks the swarm
    }
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
        // M21: capture diff of work done so far, then remove sandbox.
        if (activeSandbox !== null) captureSandboxAndCleanup(activeSandbox, run, sink, opts.propose === true, cfg, causal);
        await fireEmitSwarm(run, cfg);
        if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);
        return run;
      }

      const phaseResult = await executePhase(phase, run, cfg, opts, sink, parallel, sandboxCwd);

      if (phaseResult === 'escalate') {
        // Swarm already set to 'needs-approval' and persisted by escalate().
        // Stop cleanly — do NOT proceed to the next phase.
        emitLog(sink, `Swarm ${run.id} paused at phase "${phase}" — awaiting human approval.`);
        // M21: capture diff of partial work, then remove sandbox.
        if (activeSandbox !== null) captureSandboxAndCleanup(activeSandbox, run, sink, opts.propose === true, cfg, causal);
        await fireEmitSwarm(run, cfg);
        if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);
        return run;
      }

      if (!phaseResult) {
        // Phase returned false → budget exceeded mid-phase.
        run.status = 'aborted';
        run.result = `Swarm aborted: hard total budget exceeded during phase ${phase}`;
        persist(run);
        emitLog(sink, run.result);
        // M21: capture diff of partial work, then remove sandbox.
        if (activeSandbox !== null) captureSandboxAndCleanup(activeSandbox, run, sink, opts.propose === true, cfg, causal);
        await fireEmitSwarm(run, cfg);
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
    // M21: capture diff of any partial work, then remove sandbox.
    if (activeSandbox !== null) captureSandboxAndCleanup(activeSandbox, run, sink, opts.propose === true, cfg, causal);
    await fireEmitSwarm(run, cfg);
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

  // M21: capture full sandbox diff proposal, then remove sandbox.
  if (activeSandbox !== null) captureSandboxAndCleanup(activeSandbox, run, sink, opts.propose === true, cfg, causal);

  emitLog(sink, `Swarm ${run.id} finished with status: ${run.status}`);

  // M19: Emit telemetry (best-effort, opt-in, fire-and-forget).
  await fireEmitSwarm(run, cfg);

  // M16: Auto-capture on completion (fire-and-forget, never throws).
  if (!opts.noCapture) fireCaptureFromSwarm(run, cfg);

  return run;
}

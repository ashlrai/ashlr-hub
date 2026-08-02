/**
 * simple-conductor.ts — M280: SIMPLE-CONDUCTOR (Path A).
 *
 * Replaces the broken goal-conductor with the simplest loop that produces real
 * autonomous merges. Reads a flat task list from ~/.ashlr/tasks.json, dispatches
 * each ready task via the proven runEngineSandboxed primitive, marks done, and
 * runs runAutoMergePass so filed proposals get judged + merged in the same tick.
 *
 * SAFETY CONTRACT (non-negotiable):
 *  - killSwitchOn() checked first — if on, returns zeros immediately.
 *  - assertMayMutate(task.repo) called before EVERY dispatch — unenrolled/kill
 *    skips + logs (never-throws per task).
 *  - In-flight guard: tasks with an existing open PENDING proposal are skipped
 *    (no duplicate dispatch).
 *  - done:true tasks are always skipped.
 *  - dryRun: records intent, dispatches NOTHING, writes nothing.
 *  - maxTasksPerCycle (default 3) bounds dispatches per tick.
 *  - All merge safety (judge/gate/completeness/verification) is UNCHANGED —
 *    runAutoMergePass handles it; nothing is bypassed here.
 *  - never-throws per task (catch → record error → continue).
 *  - Flag off (cfg.foundry.simpleConductor !== true) ⇒ this module is never
 *    imported; loop.ts uses the old runConductor (byte-identical).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, EngineId, Proposal, RunProposalOutcome } from './types.js';
import type { SandboxedEngineResult } from './run/sandboxed-engine.js';
import type { AuthoritativePendingProposalExpectation } from './inbox/pending-authority.js';
import { isSafeExecutionIdentity } from './fleet/attempt-identity.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single entry in ~/.ashlr/tasks.json. */
export interface TaskSpec {
  /** Stable task id (caller-assigned; used as in-flight key). */
  id: string;
  /** Absolute path to the enrolled repo this task targets. */
  repo: string;
  /** Engine to dispatch (default 'claude'). */
  engine?: EngineId;
  /** Natural-language instruction for the frontier agent. */
  instruction: string;
  /** Higher = processed first. Default 0. */
  priority?: number;
  /** Set true once a proposal has been filed (skipped on future ticks). */
  done?: boolean;
  /** ISO timestamp when dispatched. */
  dispatchedAt?: string;
  /** Proposal id returned by runEngineSandboxed. */
  proposalId?: string;
  /** Error message if last dispatch attempt failed. */
  lastError?: string;
  /** M287: count of dispatch attempts that produced no proposal (retry guard). */
  attempts?: number;
  /** Exact authority disposition for the durable proposal that retired this task. */
  proposalDisposition?: 'newly-filed' | 'duplicate-owned';
  /** Recoverable capture infrastructure state; never terminal task authority. */
  captureFailureState?: 'recoverable' | 'cooling';
  /** ISO time after which a cooling capture failure becomes dispatchable again. */
  retryAfter?: string;
}

/** Result returned by runSimpleConductor. */
export interface SimpleConductorResult {
  tasksAttempted: number;
  proposalsFiled: number;
  duplicateProposalsOwned: number;
  recoverableFailures: number;
  coolingFailures: number;
  merged: number;
  errors: Array<{ taskId: string; error: string }>;
  killSwitchTripped: boolean;
  activationRefused?: boolean;
}

type ProposalCaptureClassification =
  | { kind: 'newly-filed'; proposalId: string }
  | { kind: 'duplicate-owned'; proposalId: string }
  | { kind: 'recoverable-failure'; reason: string }
  | { kind: 'rejected'; reason: string };

type ProposalLoader = (id: string) => Proposal | null;
type PendingAuthorityVerifier = (
  proposal: Proposal | null | undefined,
  expected: AuthoritativePendingProposalExpectation,
  cfg?: Pick<AshlrConfig, 'foundry'>,
) => boolean;

const PROPOSAL_OUTCOME_KINDS = new Set<RunProposalOutcome['kind']>([
  'filed', 'empty-diff', 'trivial-proposal', 'completeness-gate',
  'partial-completeness-gate', 'engine-failed-no-diff', 'api-model-task-failed',
  'sandbox-unavailable', 'engine-command-missing', 'engine-unsupported', 'kill-switch',
  'proposal-disabled', 'proposal-capture-error',
]);
const PROPOSAL_OUTCOME_KEYS = new Set([
  'kind', 'reason', 'isPartial', 'proposalId', 'files', 'insertions', 'deletions',
]);
const CAPTURE_FAILURE_ATTEMPT_LIMIT = 3;
const CAPTURE_FAILURE_BASE_COOLDOWN_MS = 15 * 60_000;
const CAPTURE_FAILURE_MAX_COOLDOWN_MS = 24 * 60 * 60_000;

function exactProposalOutcome(value: unknown): RunProposalOutcome | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PROPOSAL_OUTCOME_KEYS.has(key))) return null;
  if (!PROPOSAL_OUTCOME_KINDS.has(record['kind'] as RunProposalOutcome['kind'])) return null;
  if (typeof record['reason'] !== 'string' || record['reason'].trim().length === 0) return null;
  if (record['isPartial'] !== undefined && typeof record['isPartial'] !== 'boolean') return null;
  if (record['proposalId'] !== undefined && !isSafeExecutionIdentity(record['proposalId'])) return null;
  for (const key of ['files', 'insertions', 'deletions'] as const) {
    const count = record[key];
    if (count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 0)) return null;
  }
  return value as RunProposalOutcome;
}

function proposalOutcomesMatch(left: RunProposalOutcome, right: RunProposalOutcome): boolean {
  return left.kind === right.kind &&
    left.reason === right.reason &&
    left.isPartial === right.isPartial &&
    left.proposalId === right.proposalId &&
    left.files === right.files &&
    left.insertions === right.insertions &&
    left.deletions === right.deletions;
}

function recoverableCaptureFailure(
  topLevel: RunProposalOutcome | null,
  stateLevel: RunProposalOutcome | null,
): boolean {
  return topLevel?.kind === 'proposal-capture-error' || stateLevel?.kind === 'proposal-capture-error';
}

function runStateMatchesCapture(
  result: SandboxedEngineResult,
  outcome: RunProposalOutcome,
  proposalId: string,
  disposition: 'newly-filed' | 'duplicate-owned',
): boolean {
  const summary = result.state.runEventSummary;
  if (
    !isSafeExecutionIdentity(result.state.id) ||
    result.state.status !== 'done' ||
    !summary ||
    summary.runId !== result.state.id ||
    summary.status !== 'done'
  ) {
    return false;
  }
  if (summary.proposalId !== proposalId) return false;
  if (disposition === 'newly-filed') {
    return outcome.kind === 'filed' && summary.outcome === 'proposal-created' && summary.proposalCreated === true;
  }
  return outcome.kind === 'proposal-disabled' &&
    summary.outcome === 'proposal-disabled' &&
    summary.proposalCreated !== true;
}

function classifyProposalCapture(
  result: SandboxedEngineResult,
  task: TaskSpec,
  cfg: AshlrConfig,
  loadProposal: ProposalLoader,
  verifyPendingAuthority: PendingAuthorityVerifier,
): ProposalCaptureClassification {
  const topLevel = exactProposalOutcome(result.proposalOutcome);
  const stateLevel = exactProposalOutcome(result.state.proposalOutcome);
  if (!topLevel || !stateLevel || !proposalOutcomesMatch(topLevel, stateLevel)) {
    return recoverableCaptureFailure(topLevel, stateLevel)
      ? { kind: 'recoverable-failure', reason: 'proposal capture outcomes require persistence reconciliation' }
      : { kind: 'rejected', reason: 'proposal capture outcomes are missing, malformed, or contradictory' };
  }
  if (topLevel.kind === 'proposal-capture-error') {
    return { kind: 'recoverable-failure', reason: 'proposal capture requires persistence reconciliation' };
  }
  if (topLevel.isPartial === true || result.state.status !== 'done') {
    return { kind: 'rejected', reason: 'partial or failed producer capture is not authoritative' };
  }

  const proposalId = topLevel.proposalId;
  if (!proposalId) return { kind: 'rejected', reason: 'proposal capture lacks an authority id' };

  let disposition: 'newly-filed' | 'duplicate-owned';
  if (topLevel.kind === 'filed') {
    if (result.proposalId !== proposalId) {
      return { kind: 'rejected', reason: 'new proposal id does not match its capture outcome' };
    }
    disposition = 'newly-filed';
  } else if (topLevel.kind === 'proposal-disabled') {
    const exactDuplicateReason = `duplicate diff skipped; existing pending proposal ${proposalId} remains authoritative`;
    if (result.proposalId !== undefined || topLevel.reason !== exactDuplicateReason) {
      return { kind: 'rejected', reason: 'disabled proposal outcome is not an authoritative duplicate' };
    }
    disposition = 'duplicate-owned';
  } else {
    return { kind: 'rejected', reason: `proposal outcome ${topLevel.kind} grants no task settlement authority` };
  }

  if (!runStateMatchesCapture(result, topLevel, proposalId, disposition)) {
    return { kind: 'rejected', reason: 'run state does not match authoritative proposal capture' };
  }

  let proposal: Proposal | null;
  try {
    proposal = loadProposal(proposalId);
  } catch {
    return { kind: 'recoverable-failure', reason: 'proposal store read failed during authority verification' };
  }
  const expectation: AuthoritativePendingProposalExpectation = {
    id: proposalId,
    repo: task.repo,
    origin: 'agent',
    kind: 'patch',
    workItemId: undefined,
    workItemGenerationId: undefined,
    isPartial: false,
    ...(disposition === 'newly-filed'
      ? { runId: result.state.id, trajectoryId: `run:${result.state.id}` }
      : {}),
  };
  try {
    if (!verifyPendingAuthority(proposal, expectation, cfg)) {
      return { kind: 'recoverable-failure', reason: 'proposal store lacks exact authoritative pending evidence' };
    }
  } catch {
    return { kind: 'recoverable-failure', reason: 'proposal authority verification failed closed' };
  }
  return { kind: disposition, proposalId };
}

function captureFailureCooldownMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(10, attempts - CAPTURE_FAILURE_ATTEMPT_LIMIT));
  return Math.min(CAPTURE_FAILURE_MAX_COOLDOWN_MS, CAPTURE_FAILURE_BASE_COOLDOWN_MS * 2 ** exponent);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_TASKS_PER_CYCLE = 3;

function tasksPath(): string {
  return join(homedir(), '.ashlr', 'tasks.json');
}

function readTasks(): TaskSpec[] {
  const p = tasksPath();
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as TaskSpec[];
  } catch {
    // malformed — treat as empty
  }
  return [];
}

function writeTasks(tasks: TaskSpec[]): void {
  const dir = join(homedir(), '.ashlr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tasksPath(), JSON.stringify(tasks, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run one tick of the simple-conductor:
 *  1. Kill-switch check.
 *  2. Load + sort tasks.
 *  3. For each ready task (not done, no open PENDING proposal): assertMayMutate
 *     → runEngineSandboxed → mark done + write.
 *  4. runAutoMergePass so filed proposals get judged + merged this tick.
 */
export async function runSimpleConductor(
  cfg: AshlrConfig,
  opts: { once: boolean; dryRun: boolean; allowCloud: boolean },
): Promise<SimpleConductorResult> {
  const result: SimpleConductorResult = {
    tasksAttempted: 0,
    proposalsFiled: 0,
    duplicateProposalsOwned: 0,
    recoverableFailures: 0,
    coolingFailures: 0,
    merged: 0,
    errors: [],
    killSwitchTripped: false,
  };

  if (!opts.dryRun) {
    const { liveConductorActivationAuthorized } = await import('./daemon/activation-permit.js');
    if (!liveConductorActivationAuthorized()) {
      result.activationRefused = true;
      return result;
    }
  }

  // 1. Kill-switch check.
  const { killSwitchOn } = await import('./sandbox/policy.js');
  if (killSwitchOn()) {
    result.killSwitchTripped = true;
    return result;
  }

  // 2. Load tasks.
  let tasks = readTasks();
  if (tasks.length === 0) return result;

  // Sort: higher priority first; stable-sort preserves file order for ties.
  tasks = [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  // 3. Identify tasks that already have an open PENDING proposal (in-flight guard).
  const { listProposals, loadProposal } = await import('./inbox/store.js');
  const { isAuthoritativeDurablePendingProposal } = await import('./inbox/pending-authority.js');
  let inFlightProposalIds: Set<string> = new Set();
  try {
    const pending = listProposals({ status: 'pending' });
    // Map from proposalId → true; we match against task.proposalId.
    inFlightProposalIds = new Set(pending.map((p) => p.id));
  } catch {
    // best-effort — proceed without in-flight guard on store error
  }

  // 4. Dispatch ready tasks (bounded by maxTasksPerCycle).
  const { assertMayMutate } = await import('./sandbox/policy.js');
  const { runEngineSandboxed, runApiModelSandboxed } = await import('./run/sandboxed-engine.js');
  const { runAutoMergePass } = await import('./fleet/automerge-pass.js');
  const { resolveEngineSpec } = await import('./run/engine-registry.js');
  const { getResourceSnapshot } = await import('./fabric/resource-monitor.js');

  // M300: pre-fetch resource snapshot once per tick (cached 30s, never throws).
  let resourceSnap: Awaited<ReturnType<typeof getResourceSnapshot>> | null = null;
  try {
    resourceSnap = await getResourceSnapshot(cfg);
  } catch {
    // never throws per contract, but guard anyway — null = treat all as available
  }

  /**
   * M300: Resolve effective engine, rerouting away from unavailable backends.
   * Flag-gated: cfg.foundry.resourceAwareDispatch !== false (default ON).
   * Never throws.
   */
  function resolveEffectiveEngine(requestedEngine: EngineId): EngineId {
    try {
      const resourceAware = (cfg.foundry as Record<string, unknown> | undefined)?.['resourceAwareDispatch'] !== false;
      if (!resourceAware || !resourceSnap) return requestedEngine;

      const getAvailability = (engine: string): string => {
        const state = resourceSnap!.backends.find((b) => b.backend === engine);
        return state?.availability ?? 'unknown';
      };

      const unavailable = new Set(['exhausted', 'throttled', 'unreachable']);
      const avail = getAvailability(requestedEngine);
      if (!unavailable.has(avail)) return requestedEngine;

      // Primary engine is exhausted — try fallback order.
      const fallbackOrder = ((cfg.foundry as Record<string, unknown> | undefined)?.['engineFallbackOrder'] as string[] | undefined)
        ?? ['codex', 'kimi', 'nim', 'local-coder'];

      for (const candidate of fallbackOrder) {
        if (candidate === requestedEngine) continue;
        const candidateAvail = getAvailability(candidate);
        if (!unavailable.has(candidateAvail)) {
          console.log(`[simple-conductor] reroute: ${requestedEngine} ${avail} → ${candidate} (availability: ${candidateAvail})`);
          return candidate as EngineId;
        }
      }

      // All fallbacks exhausted — use original engine as last resort (degrades, never freezes).
      console.log(`[simple-conductor] reroute: all fallbacks exhausted, using original engine ${requestedEngine}`);
      return requestedEngine;
    } catch {
      return requestedEngine;
    }
  }

  // Re-read the mutable tasks array so we can write back updates.
  const mutableTasks = readTasks();
  let dispatched = 0;

  for (const task of tasks) {
    if (dispatched >= MAX_TASKS_PER_CYCLE) break;

    // Skip done tasks.
    if (task.done) continue;

    // Recoverable capture infrastructure failures cool down instead of being
    // converted into terminal completion. Invalid or elapsed timestamps grant no skip.
    if (task.captureFailureState === 'cooling' && task.retryAfter) {
      const retryAtMs = Date.parse(task.retryAfter);
      if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) continue;
    }

    // Skip tasks whose filed proposal is still PENDING (in-flight guard).
    if (task.proposalId && inFlightProposalIds.has(task.proposalId)) continue;

    result.tasksAttempted++;

    if (opts.dryRun) {
      // Dry-run: record intent only — no dispatch, no write.
      console.log(`[simple-conductor] dry-run: would dispatch task ${task.id} → ${task.repo}`);
      dispatched++;
      continue;
    }

    // assertMayMutate — skip + log if unenrolled or kill switch.
    try {
      assertMayMutate(task.repo);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[simple-conductor] skip task ${task.id}: ${msg}`);
      result.errors.push({ taskId: task.id, error: msg });
      continue;
    }

    // Dispatch via the proven sandboxed-engine primitive.
    try {
      // M300: resolve effective engine — reroutes away from exhausted backends.
      const engineId: EngineId = resolveEffectiveEngine((task.engine ?? 'claude') as EngineId);
      // M298: append a standing full-suite directive so the agent cannot finish
      // without running the complete test suite + typecheck and confirming zero
      // NEW failures. This closed a regression window where the agent ran only
      // related tests and missed failures in adjacent modules (doctor regression).
      const fullSuiteDirective =
        '\n\n---\nBEFORE FINISHING: run the FULL test suite (`npm test` or `npx vitest run`) ' +
        'AND typecheck (`npx tsc --noEmit`). Confirm there are ZERO new failures ' +
        '(pre-existing failures that were already failing before your change are exempt). ' +
        'Do NOT mark the task complete or file a proposal until both commands pass cleanly.';
      const instruction = task.instruction + fullSuiteDirective;

      // M300: route to the correct runner — cli-agents (claude/codex) via runEngineSandboxed,
      // api-models (nim/kimi/local-coder) via runApiModelSandboxed.
      const engineSpec = resolveEngineSpec(engineId, cfg);
      const isApiModel = engineSpec?.kind === 'api-model';

      const sandboxOpts = {
        sourceRepo: task.repo,
        budget: {
          // M287: raised from 50k/40 — substantial high-value work (new file +
          // wiring + test + iterate-to-green) exhausted the old budget on
          // attempt 1 ("budget exceeded after attempt 1"), leaving no room to
          // finish. Bigger budget lets the agent complete + verify substantial tasks.
          maxTokens: 150_000,
          maxSteps: 100,
          allowCloud: opts.allowCloud,
        },
        propose: true,
      };
      const sandboxResult = isApiModel
        ? await runApiModelSandboxed(engineId, instruction, cfg, sandboxOpts)
        : await runEngineSandboxed(engineId, instruction, cfg, sandboxOpts);
      const capture = classifyProposalCapture(
        sandboxResult,
        task,
        cfg,
        loadProposal,
        isAuthoritativeDurablePendingProposal,
      );

      // M287: mark done ONLY when a proposal was actually filed. A dispatch that
      // produced no proposal (empty/incomplete diff, blocked by verify) is NOT
      // success. Non-authoritative production stops after three attempts; capture
      // infrastructure failures remain recoverable and enter bounded cooling.
      const idx = mutableTasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        if (capture.kind === 'newly-filed' || capture.kind === 'duplicate-owned') {
          const {
            lastError: _lastError,
            attempts: _attempts,
            captureFailureState: _captureFailureState,
            retryAfter: _retryAfter,
            ...settledTask
          } = mutableTasks[idx];
          mutableTasks[idx] = {
            ...settledTask,
            done: true,
            dispatchedAt: new Date().toISOString(),
            proposalId: capture.proposalId,
            proposalDisposition: capture.kind,
          };
        } else {
          const attempts = ((mutableTasks[idx].attempts ?? 0) + 1);
          const recoverable = capture.kind === 'recoverable-failure';
          const cooling = recoverable && attempts >= CAPTURE_FAILURE_ATTEMPT_LIMIT;
          const { proposalId: _proposalId, proposalDisposition: _proposalDisposition, ...retryableTask } = mutableTasks[idx];
          mutableTasks[idx] = {
            ...retryableTask,
            dispatchedAt: new Date().toISOString(),
            lastError: capture.reason,
            attempts,
            done: recoverable ? false : attempts >= CAPTURE_FAILURE_ATTEMPT_LIMIT,
            ...(recoverable
              ? {
                  captureFailureState: cooling ? 'cooling' as const : 'recoverable' as const,
                  ...(cooling
                    ? { retryAfter: new Date(Date.now() + captureFailureCooldownMs(attempts)).toISOString() }
                    : { retryAfter: undefined }),
                }
              : { captureFailureState: undefined, retryAfter: undefined }),
          };
          if (recoverable) {
            result.recoverableFailures++;
            if (cooling) result.coolingFailures++;
          }
        }
      }
      writeTasks(mutableTasks);

      if (capture.kind === 'newly-filed') {
        result.proposalsFiled++;
      } else if (capture.kind === 'duplicate-owned') {
        result.duplicateProposalsOwned++;
      }
      dispatched++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[simple-conductor] task ${task.id} dispatch error: ${msg}`);
      result.errors.push({ taskId: task.id, error: msg });
      // never-throws — continue to next task
    }
  }

  // 5. Run the auto-merge pass so filed proposals get judged + merged this tick.
  // The full gate (judge/completeness/verification/kill-switch) is unchanged.
  if (!opts.dryRun) {
    try {
      const passResult = await runAutoMergePass(cfg);
      result.merged = passResult.merged;
    } catch {
      // best-effort — merge pass failure is non-fatal
    }
  }

  return result;
}

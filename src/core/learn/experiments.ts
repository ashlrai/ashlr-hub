/**
 * Harness experiments — V3.10 Track B (owner: unit U9).
 *
 * Paired A/B runs of a candidate harness against the active one on the
 * HELD-OUT task set (local-eval/tasks-heldout.ts), on free local slots — at
 * most one while the fleet queue is non-empty. The verdict comes from the
 * adoption gate in harness-registry.ts (95% CI lower bound > 0 on paired
 * lift, ≥ 8 pairs, no refuse regression, no rise in claimed-change-none-made,
 * cost ≤ +20%). An experiment never adopts anything: adoption is a separate,
 * ledgered, class-B step.
 *
 * GENERALIZES fleet/external-skill-shadow-eval.ts rather than re-deriving it.
 * Each experiment freezes a campaign with `buildExternalSkillTrialPlan`
 * (randomized, counterbalanced arm ORDER per pair — the local runtime's cache
 * and thermal state favour whichever arm runs second — committed before any
 * run), attests every run as a receipt, and scores with
 * `evaluateExternalSkillTrial`, which withholds the effect on any integrity
 * problem (replayed, conflicting or mismatched receipts, attrition). The
 * mapping: the evaluator's "skill" arm is the CANDIDATE (its content hash is
 * the candidate's config digest), its "no-skill" arm is the BASE harness
 * (exposure "no-skill-confirmed" = the candidate's change was confirmed
 * absent). The paired 95% CI is `pairedDifferenceConfidence95` (Newcombe),
 * added beside that evaluator.
 *
 * The attestation and randomization keys live only in the running process:
 * an experiment is not resumable across a crash (the runner's lease goes
 * stale and the experiment is marked failed, honestly), and receipts cannot
 * be forged after the fact.
 *
 * NOTHING HERE SPENDS. The default executor drives the local agent CLI at the
 * local llama-server proxy (local-eval/runner.ts), exactly as local-eval does.
 * Paid seats are never involved.
 */
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attestExternalSkillTrialOutcome,
  buildExternalSkillTrialPlan,
  evaluateExternalSkillTrial,
  pairedDifferenceConfidence95,
  type ExternalSkillTrialArm,
  type ExternalSkillTrialOutcomeReceipt,
  type ExternalSkillTrialPlan,
} from '../fleet/external-skill-shadow-eval.js';
import { HELD_OUT_TASKS, HELD_OUT_TASK_SET_ID, taskSetDigest } from '../local-eval/tasks-heldout.js';
import type { FailureMode, TaskSpec } from '../local-eval/types.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  BASELINE_VERSION_ID,
  HarnessRefusal,
  appendHarnessLedger,
  createCandidateVersion,
  currentBaseVersion,
  decideExperimentVerdict,
  harnessConfigDiff,
  loadHarnessState,
  mutateHarnessState,
  runnerIdentity,
  stripExperimentInternals,
  validateHarnessHypothesis,
  type ExperimentMeta,
} from './harness-registry.js';
import {
  HARNESS_ADOPTION_GATE,
  type CancelExperimentRequest,
  type CancelExperimentResult,
  type ExperimentLift,
  type ExperimentResultV1,
  type ExperimentStatus,
  type ExperimentVerdict,
  type HarnessActor,
  type HarnessConfigV1,
  type HarnessVersion,
  type StartExperimentRequest,
  type StartExperimentResult,
} from './harness-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXPERIMENT_POLICY_VERSION = 'harness-experiment-v1';

/** Local slots an experiment may use: SPEC-310B §5 — at most 1 while fleet work is queued. */
export const EXPERIMENT_SLOTS = Object.freeze({ idle: 2, fleetBusy: 1 } as const);

/**
 * The config paths the local-eval executor can actually apply to an agent
 * run. A candidate that changes anything else is REFUSED at start: both arms
 * would run the same agent and the experiment would report "no lift" for a
 * change it never applied — and adopting it would ship that change untested.
 *
 *  - prompts.producer → `--append-system-prompt`
 *  - effort.local     → `--effort` (with CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)
 *
 * Sampling on the local model is fixed by llama-server's launch flags, and
 * routing weights / skills act on dispatch, not on a single task, so none of
 * them is measurable here. (Routing has its own path: the Leader's bounded
 * class-A `router.tune`.)
 */
export const LOCAL_EVAL_EXERCISABLE: readonly string[] = Object.freeze(['prompts.producer', 'effort.local']);

/** A runner that has not heartbeat for this long is presumed dead. */
const RUNNER_STALE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const MAX_REASON_CHARS = 500;

// ---------------------------------------------------------------------------
// Executor contract
// ---------------------------------------------------------------------------

export type ExperimentArm = 'base' | 'candidate';

export interface ExperimentRunRequest {
  experimentId: string;
  task: TaskSpec;
  arm: ExperimentArm;
  config: HarnessConfigV1;
  configDigest: string;
  /** 0-based index of the pair in campaign order (stable per experiment). */
  pairIndex: number;
  /** 1 = this arm ran first in its pair, 2 = second. */
  ordinal: 1 | 2;
  signal: AbortSignal;
}

export interface ExperimentRunResult {
  passed: boolean;
  mode: FailureMode;
  wallMs: number;
  verifyExit: number | null;
  changedFiles: number | null;
}

export interface ExperimentExecutor {
  /** e.g. `local-eval`. */
  id: string;
  /** What every run shares (model, endpoint, budget) — bound into the campaign digest. */
  envelope: Readonly<Record<string, string | number | boolean | null>>;
  /** Config paths this executor applies (see LOCAL_EVAL_EXERCISABLE). */
  exercisable: readonly string[];
  /** Cheap readiness probe; a failure leaves the experiment queued instead of burning it. */
  preflight?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  run(req: ExperimentRunRequest): Promise<ExperimentRunResult>;
}

export interface LocalEvalExecutorOptions {
  baseUrl?: string;
  model?: string;
  agentCli?: string;
  timeoutMs?: number;
  trace?: boolean;
  /** Where trial directories go; default `$TMPDIR/ashlr-experiments`. */
  rootDir?: string;
}

/**
 * The default executor: one local-eval trial per run, with the arm's harness
 * applied through the runner's `appendSystemPrompt` / `effort` options.
 * Defaults (endpoint, model label, agent CLI) come from local-eval's own
 * `parseArgs`, so an experiment runs against the exact lane a baseline does.
 */
export async function localEvalExecutor(opts: LocalEvalExecutorOptions = {}): Promise<ExperimentExecutor> {
  const [{ parseArgs }, { runTrial }] = await Promise.all([
    import('../local-eval/main.js'),
    import('../local-eval/runner.js'),
  ]);
  const defaults = parseArgs([]);
  const baseUrl = opts.baseUrl ?? defaults.baseUrl;
  const model = opts.model ?? defaults.model;
  const agentCli = opts.agentCli ?? defaults.agentCli;
  const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
  const trace = opts.trace ?? true;
  const rootDir = opts.rootDir ?? join(tmpdir(), 'ashlr-experiments');
  return {
    id: 'local-eval',
    envelope: { executor: 'local-eval', baseUrl, model, agentCli, timeoutMs, trace },
    exercisable: LOCAL_EVAL_EXERCISABLE,
    preflight: async () => {
      try {
        // Any HTTP answer means the proxy is listening; a refused connection
        // means the local runtime is down and every trial would be a
        // harness-error, which is not the model's fault.
        await fetch(baseUrl, { signal: AbortSignal.timeout(3_000) });
        return { ok: true };
      } catch {
        return { ok: false, reason: `the local runtime at ${baseUrl} is not answering` };
      }
    },
    run: async (req) => {
      const result = await runTrial({
        task: req.task,
        trial: req.ordinal,
        trialDir: join(rootDir, req.experimentId, `${String(req.pairIndex).padStart(2, '0')}-${req.task.id}-${req.arm}`),
        baseUrl,
        model,
        agentCli,
        timeoutMs,
        trace,
        appendSystemPrompt: req.config.prompts.producer,
        effort: req.config.effort.local,
        signal: req.signal,
      });
      return {
        passed: result.passed,
        mode: result.mode,
        wallMs: result.wallMs,
        verifyExit: result.verifyExit,
        changedFiles: result.changedFiles,
      };
    },
  };
}

/**
 * Why a candidate cannot be tested by an executor, or null when it can: no
 * change at all, or a change to a path the executor does not apply.
 */
export function unexercisableReason(base: HarnessConfigV1, cand: HarnessConfigV1, exercisable: readonly string[]): string | null {
  const diff = harnessConfigDiff(base, cand);
  if (diff.length === 0) return 'the candidate is identical to the base harness';
  const missing = diff.filter((path) => !exercisable.includes(path));
  if (missing.length > 0) {
    return `the experiment runner cannot exercise ${missing.join(', ')} (it applies only ${exercisable.join(', ')}); `
      + 'both arms would run the same agent, so the change would be adopted untested';
  }
  return null;
}

// ---------------------------------------------------------------------------
// runExperiment — the paired campaign (no store; pure over its executor)
// ---------------------------------------------------------------------------

export interface RunExperimentOptions {
  executor: ExperimentExecutor;
  experimentId?: string;
  signal?: AbortSignal;
  /** Evaluated before each pair starts, so a fleet that wakes up mid-run shrinks the experiment to one slot. */
  slotLimit?: () => number;
  onPair?: (progress: { completedPairs: number; totalPairs: number }) => void;
  /** Test hook: fixed keys (≥ 32 bytes each, distinct). Production draws fresh random keys per experiment. */
  keys?: { randomization: Uint8Array; attestation: Uint8Array };
}

export interface ExperimentRunRecord {
  taskId: string;
  arm: ExperimentArm;
  ordinal: 1 | 2;
  passed: boolean;
  mode: FailureMode;
  wallMs: number;
}

export interface ExperimentOutcome {
  status: Extract<ExperimentStatus, 'done' | 'failed' | 'cancelled'>;
  pairs: number;
  wins: number;
  losses: number;
  ties: number;
  lift: ExperimentLift | null;
  refuseRegression: boolean | null;
  claimedChangeNoneMadeDelta: number | null;
  costDeltaPct: number | null;
  verdict: ExperimentVerdict | null;
  reasons: string[];
  armPasses: { base: number; candidate: number } | null;
  campaignDigest: string | null;
  runs: ExperimentRunRecord[];
}

const sha = (domain: string, values: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify([domain, ...values]), 'utf8').digest('hex');

function digestFiles(files: Readonly<Record<string, string>>): string {
  return sha('ashlr:experiment-fixture:v1', Object.keys(files).sort().map((path) => [path, files[path]]));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyOutcome(status: ExperimentOutcome['status'], reasons: string[], runs: ExperimentRunRecord[] = [], campaignDigest: string | null = null): ExperimentOutcome {
  return {
    status,
    pairs: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    lift: null,
    refuseRegression: null,
    claimedChangeNoneMadeDelta: null,
    costDeltaPct: null,
    verdict: status === 'cancelled' ? null : 'inconclusive',
    reasons,
    armPasses: null,
    campaignDigest,
    runs,
  };
}

class ExperimentAbort extends Error {}

/**
 * Run `cand` against `base` on `tasks` (one pair per task, both arms once, in
 * a randomized order committed up front) and score it. Returns the metrics
 * and the gate's verdict; persists nothing (runNextExperiment does that).
 *
 * A `harness-error` run (the CLI or runtime failed — not the model) is
 * retried once; a second one fails the whole experiment, because a pair with
 * an infrastructure failure on one side is not a comparison.
 */
export async function runExperiment(
  base: Pick<HarnessVersion, 'id' | 'config' | 'configDigest'>,
  cand: Pick<HarnessVersion, 'id' | 'config' | 'configDigest'>,
  tasks: readonly TaskSpec[],
  opts: RunExperimentOptions,
): Promise<ExperimentOutcome> {
  const { executor } = opts;
  const experimentId = opts.experimentId ?? `adhoc-${Date.now().toString(36)}`;
  if (tasks.length < HARNESS_ADOPTION_GATE.minPairs) {
    return emptyOutcome('failed', [`${tasks.length} tasks cannot give the ${HARNESS_ADOPTION_GATE.minPairs} pairs the gate needs`]);
  }
  const unexercisable = unexercisableReason(base.config, cand.config, executor.exercisable);
  if (unexercisable) return emptyOutcome('failed', [unexercisable]);

  // Freeze the campaign before any run.
  const randomizationKey = opts.keys?.randomization ?? randomBytes(32);
  const attestationKey = opts.keys?.attestation ?? randomBytes(32);
  const envelopeDigest = sha('ashlr:experiment-envelope:v1', [executor.id, Object.keys(executor.envelope).sort().map((k) => [k, executor.envelope[k]])]);
  const byCase = new Map<string, TaskSpec>();
  let plan: ExternalSkillTrialPlan;
  try {
    const cases = tasks.map((task) => {
      const caseDigest = sha('ashlr:experiment-case:v1', [task.id, task.expectation, task.prompt]);
      byCase.set(caseDigest, task);
      return {
        skillContentHash: cand.configDigest,
        caseDigest,
        fixtureDigest: digestFiles(task.files),
        verifierContractDigest: sha('ashlr:experiment-verifier:v1', [task.check, task.verify, task.expectation]),
        executionEnvelopeDigest: envelopeDigest,
      };
    });
    plan = buildExternalSkillTrialPlan({
      packDigest: sha('ashlr:experiment-pack:v1', [taskSetDigest(tasks), base.configDigest, cand.configDigest]),
      policyVersion: EXPERIMENT_POLICY_VERSION,
      randomizationKey,
      attestationKey,
      cases,
    });
  } catch (err) {
    return emptyOutcome('failed', [`the campaign could not be frozen: ${err instanceof Error ? err.message : String(err)}`]);
  }

  const internal = new AbortController();
  const onOuterAbort = (): void => internal.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (opts.signal?.aborted) internal.abort();

  const receipts: ExternalSkillTrialOutcomeReceipt[] = [];
  const runs: ExperimentRunRecord[] = [];
  const results = new Map<string, ExperimentRunResult>(); // `${pairId}:${arm}`
  let failure: string | null = null;
  let completedPairs = 0;

  const runOne = async (pairIndex: number, pairId: string, task: TaskSpec, trialArm: ExternalSkillTrialArm, ordinal: 1 | 2): Promise<void> => {
    const arm: ExperimentArm = trialArm === 'skill' ? 'candidate' : 'base';
    const version = arm === 'candidate' ? cand : base;
    let result: ExperimentRunResult | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (internal.signal.aborted) throw new ExperimentAbort('aborted');
      result = await executor.run({
        experimentId,
        task,
        arm,
        config: version.config,
        configDigest: version.configDigest,
        pairIndex,
        ordinal,
        signal: internal.signal,
      });
      if (result.mode !== 'harness-error') break;
    }
    if (internal.signal.aborted) throw new ExperimentAbort('aborted');
    if (!result || result.mode === 'harness-error') {
      throw new ExperimentAbort(`${task.id} (${arm}) hit a harness-error twice: the runtime, not the model, failed, so the pair cannot be scored`);
    }
    const nonce = randomBytes(16).toString('hex');
    receipts.push(attestExternalSkillTrialOutcome(plan, {
      pairId,
      arm: trialArm,
      exposure: trialArm === 'skill' ? 'skill-mounted' : 'no-skill-confirmed',
      skillContentHash: trialArm === 'skill' ? cand.configDigest : null,
      exposureReceiptDigest: sha('ashlr:experiment-exposure:v1', [plan.campaignDigest, pairId, arm, version.configDigest, nonce]),
      resultDigest: sha('ashlr:experiment-result:v1', [plan.campaignDigest, pairId, arm, result.mode, result.verifyExit, result.changedFiles, nonce]),
      evidenceDigest: sha('ashlr:experiment-evidence:v1', [plan.campaignDigest, pairId, arm, result.wallMs, nonce]),
      outcome: result.passed ? 'passed' : 'failed',
    }, attestationKey));
    results.set(`${pairId}:${arm}`, result);
    runs.push({ taskId: task.id, arm, ordinal, passed: result.passed, mode: result.mode, wallMs: result.wallMs });
  };

  const runPair = async (pairIndex: number): Promise<void> => {
    const pair = plan.assignments[pairIndex]!;
    const task = byCase.get(pair.caseDigest)!;
    // Both arms of a pair run back to back, in the committed order.
    for (const run of pair.runs) await runOne(pairIndex, pair.pairId, task, run.arm, run.ordinal);
    completedPairs += 1;
    opts.onPair?.({ completedPairs, totalPairs: plan.assignments.length });
  };

  // A small pool whose width is re-read before each pair starts.
  const inFlight = new Set<Promise<void>>();
  let next = 0;
  try {
    while ((next < plan.assignments.length && failure === null && !internal.signal.aborted) || inFlight.size > 0) {
      const width = Math.max(1, Math.floor(opts.slotLimit?.() ?? EXPERIMENT_SLOTS.idle));
      if (next < plan.assignments.length && failure === null && !internal.signal.aborted && inFlight.size < width) {
        const index = next;
        next += 1;
        const job: Promise<void> = runPair(index)
          .catch((err: unknown) => {
            if (failure === null) failure = err instanceof ExperimentAbort ? err.message : `runner error: ${err instanceof Error ? err.message : String(err)}`;
            internal.abort();
          })
          .finally(() => { inFlight.delete(job); });
        inFlight.add(job);
        continue;
      }
      await Promise.race(inFlight);
    }
  } finally {
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  if (opts.signal?.aborted) return emptyOutcome('cancelled', ['cancelled while running'], runs, plan.campaignDigest);
  if (failure !== null) return emptyOutcome('failed', [scrubSecrets(failure).slice(0, MAX_REASON_CHARS)], runs, plan.campaignDigest);

  const evaluation = evaluateExternalSkillTrial({ plan, receipts, attestationKey, sourceComplete: true, campaignClosed: true });
  if (evaluation.gate !== 'ready' || !evaluation.effect) {
    return emptyOutcome('failed', [`the campaign's integrity check withheld the result: ${evaluation.blockers.join(', ') || 'unknown'}`], runs, plan.campaignDigest);
  }

  // The 2×2 table and the gate's other metrics, from the verified pairs.
  let bothPass = 0; let candOnly = 0; let baseOnly = 0; let bothFail = 0;
  let refuseRegression = false;
  let candClaimed = 0; let baseClaimed = 0;
  let candWall = 0; let baseWall = 0;
  for (const pair of plan.assignments) {
    const task = byCase.get(pair.caseDigest)!;
    const b = results.get(`${pair.pairId}:base`)!;
    const c = results.get(`${pair.pairId}:candidate`)!;
    if (b.passed && c.passed) bothPass += 1;
    else if (c.passed) candOnly += 1;
    else if (b.passed) baseOnly += 1;
    else bothFail += 1;
    if (task.expectation === 'refuse' && b.passed && !c.passed) refuseRegression = true;
    if (c.mode === 'claimed-change-none-made') candClaimed += 1;
    if (b.mode === 'claimed-change-none-made') baseClaimed += 1;
    candWall += c.wallMs;
    baseWall += b.wallMs;
  }
  // Cross-check against the evaluator's own counts: two tallies of the same
  // receipts disagreeing means a bug here, and a bug must not reach the gate.
  if (candOnly !== evaluation.effect.skillOnlyWins || baseOnly !== evaluation.effect.noSkillOnlyWins) {
    return emptyOutcome('failed', ['internal tally disagrees with the evaluator; result withheld'], runs, plan.campaignDigest);
  }
  const interval = pairedDifferenceConfidence95({ bothPass, treatmentOnly: candOnly, controlOnly: baseOnly, bothFail });
  const pairs = evaluation.effect.completePairs;
  const lift: ExperimentLift | null = interval
    ? { mean: round2(interval.difference * 100), ciLow: round2(interval.lower * 100), ciHigh: round2(interval.upper * 100), level: 0.95 }
    : null;
  const metrics = {
    pairs,
    lift,
    refuseRegression,
    claimedChangeNoneMadeDelta: candClaimed - baseClaimed,
    costDeltaPct: baseWall > 0 ? round2(((candWall - baseWall) / baseWall) * 100) : null,
  };
  const decided = decideExperimentVerdict(metrics);
  return {
    status: 'done',
    wins: candOnly,
    losses: baseOnly,
    ties: bothPass + bothFail,
    ...metrics,
    verdict: decided.verdict,
    reasons: decided.reasons,
    armPasses: { base: bothPass + baseOnly, candidate: bothPass + candOnly },
    campaignDigest: plan.campaignDigest,
    runs,
  };
}

// ---------------------------------------------------------------------------
// Queue: start / cancel (frozen contract) + the runner
// ---------------------------------------------------------------------------

const ACTORS: ReadonlySet<HarnessActor> = new Set(['mason', 'leader', 'daemon']);

/** In-process runners, so a cancel in the same process aborts in-flight trials immediately. */
const liveRunners = new Map<string, AbortController>();

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function queuedResult(id: string, hypothesisId: string, base: HarnessVersion, cand: HarnessVersion): ExperimentResultV1 {
  return {
    v: 1,
    id,
    hypothesisId,
    baseVersionId: base.id,
    candidateVersionId: cand.id,
    taskSet: { id: HELD_OUT_TASK_SET_ID, digest: taskSetDigest(HELD_OUT_TASKS) },
    status: 'queued',
    pairs: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    lift: null,
    refuseRegression: null,
    claimedChangeNoneMadeDelta: null,
    costDeltaPct: null,
    verdict: null,
    reasons: [],
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Queue an experiment for a hypothesis (config-only patches; a code diff is
 * refused). Builds the candidate version (base = the active harness) and
 * refuses a change the runner cannot exercise. Idempotent: a hypothesis whose
 * candidate is already queued or running returns that experiment.
 *
 * Starting an experiment spends nothing and changes nothing in force, so it
 * is a Leader class-A action; its inverse is cancelExperiment.
 */
export function startExperiment(req: StartExperimentRequest, opts: { now?: Date } = {}): StartExperimentResult {
  if (typeof req !== 'object' || req === null) return { ok: false, reason: 'invalid request' };
  if (!ACTORS.has(req.requestedBy)) return { ok: false, reason: 'requestedBy must be mason, leader or daemon' };
  const checked = validateHarnessHypothesis(req.hypothesis);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const hypothesis = checked.value;
  const now = opts.now ?? new Date();
  const result = mutateHarnessState((state) => {
    const base = currentBaseVersion(state);
    const cand = createCandidateVersion(state, base, hypothesis.patch, { kind: 'hypothesis', hypothesisId: hypothesis.id }, now);
    const why = unexercisableReason(base.config, cand.config, LOCAL_EVAL_EXERCISABLE);
    if (why) throw new HarnessRefusal(why);
    const pending = state.experiments.find((e) => e.candidateVersionId === cand.id && (e.status === 'queued' || e.status === 'running'));
    if (pending) return pending.id;
    state.experimentSeq += 1;
    const id = `x-${String(state.experimentSeq).padStart(4, '0')}`;
    state.experiments.push(queuedResult(id, hypothesis.id, base, cand));
    const meta: ExperimentMeta = { requestedBy: req.requestedBy, hypothesis, queuedAt: nowIso(now), runner: null, cancel: null, armPasses: null };
    state.experimentMeta[id] = meta;
    state.hypotheses = state.hypotheses.filter((h) => h.id !== hypothesis.id);
    return id;
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, experimentId: result.value };
}

/**
 * Cancel a queued / running experiment — the inverse of a Leader
 * `experiment.start`. A running one is marked cancelled at once (a runner in
 * another process sees it at its next heartbeat and discards its result; one
 * in this process aborts its in-flight trials now). A finished experiment
 * cannot be cancelled.
 */
export function cancelExperiment(req: CancelExperimentRequest, opts: { now?: Date } = {}): CancelExperimentResult {
  if (typeof req !== 'object' || req === null || typeof req.experimentId !== 'string') return { ok: false, reason: 'experimentId is required' };
  if (!ACTORS.has(req.actor)) return { ok: false, reason: 'actor must be mason, leader or daemon' };
  const reason = scrubSecrets(typeof req.reason === 'string' && req.reason.trim() ? req.reason : 'cancelled').slice(0, MAX_REASON_CHARS);
  const now = opts.now ?? new Date();
  let cancelled: ExperimentResultV1 | null = null;
  const result = mutateHarnessState((state) => {
    const exp = state.experiments.find((e) => e.id === req.experimentId);
    if (!exp) throw new HarnessRefusal(`unknown experiment ${req.experimentId}`);
    if (exp.status !== 'queued' && exp.status !== 'running') throw new HarnessRefusal(`experiment ${exp.id} is ${exp.status}; only a queued or running experiment can be cancelled`);
    exp.status = 'cancelled';
    exp.verdict = null;
    exp.finishedAt = nowIso(now);
    exp.reasons = [`cancelled by ${req.actor}: ${reason}`];
    const meta = state.experimentMeta[exp.id];
    if (meta) meta.cancel = { reason, actor: req.actor, at: nowIso(now) };
    cancelled = stripExperimentInternals(exp);
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  liveRunners.get(req.experimentId)?.abort();
  if (cancelled) appendHarnessLedger('harness:experiment', cancelled, req.actor);
  return { ok: true };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RunNextExperimentOptions {
  /** Default: the local-eval executor. */
  executor?: ExperimentExecutor;
  /** Fleet queue depth, read before each pair (default 0 → idle width). */
  fleetQueueDepth?: () => number;
  tasks?: readonly TaskSpec[];
  signal?: AbortSignal;
  now?: () => Date;
}

export type RunNextExperimentResult =
  | { ran: ExperimentResultV1 }
  | { ran: null; reason: string };

/**
 * Take the oldest queued experiment, run it, record the verdict. Called by the
 * daemon's overnight window / idle ticks and by `local-eval/main.ts
 * --experiments`. At most one experiment runs per call; a stale runner lease
 * (dead pid, or no heartbeat for 30 min) is failed first so a crashed run
 * never blocks the queue.
 */
export async function runNextExperiment(opts: RunNextExperimentOptions = {}): Promise<RunNextExperimentResult> {
  const clock = opts.now ?? ((): Date => new Date());
  const tasks = opts.tasks ?? HELD_OUT_TASKS;
  const identity = runnerIdentity();

  // Sweep stale leases (finished-experiment ledger rows written below).
  const staleFailed: ExperimentResultV1[] = [];
  mutateHarnessState((state) => {
    for (const exp of state.experiments) {
      if (exp.status !== 'running') continue;
      const runner = state.experimentMeta[exp.id]?.runner;
      const heartbeat = runner ? Date.parse(runner.heartbeatAt) : Number.NaN;
      const dead = !runner
        || (runner.host === identity.host && runner.pid !== identity.pid && !pidAlive(runner.pid))
        || !Number.isFinite(heartbeat) || clock().getTime() - heartbeat > RUNNER_STALE_MS;
      if (!dead || (runner && runner.pid === identity.pid && liveRunners.has(exp.id))) continue;
      exp.status = 'failed';
      exp.verdict = 'inconclusive';
      exp.finishedAt = nowIso(clock());
      exp.reasons = ['the runner stopped before finishing (crash or restart); experiments are not resumable — re-queue the hypothesis'];
      staleFailed.push(stripExperimentInternals(exp));
    }
  });
  for (const exp of staleFailed) appendHarnessLedger('harness:experiment', exp, 'daemon');

  const executor = opts.executor ?? await localEvalExecutor();
  const queued = loadHarnessState().experiments.find((e) => e.status === 'queued');
  if (!queued) return { ran: null, reason: 'no experiment is queued' };
  if (executor.preflight) {
    const ready = await executor.preflight();
    if (!ready.ok) return { ran: null, reason: `${ready.reason}; the experiment stays queued` };
  }

  // Claim it.
  let claimed: { exp: ExperimentResultV1; base: HarnessVersion; cand: HarnessVersion } | null = null;
  let refusedAtClaim: ExperimentResultV1 | null = null;
  const claim = mutateHarnessState((state) => {
    const exp = state.experiments.find((e) => e.id === queued.id);
    if (!exp || exp.status !== 'queued') return;
    const activeId = state.activeId ?? BASELINE_VERSION_ID;
    const base = state.versions.find((v) => v.id === exp.baseVersionId);
    const cand = state.versions.find((v) => v.id === exp.candidateVersionId);
    let refusal: string | null = null;
    if (!base || !cand) refusal = 'a version this experiment compares is missing from the registry';
    else if (exp.baseVersionId !== activeId) refusal = `the active harness changed from ${exp.baseVersionId} to ${activeId} since this was queued; re-queue the hypothesis`;
    else if (exp.taskSet.digest !== taskSetDigest(tasks)) refusal = 'the held-out task set changed since this was queued; re-queue the hypothesis';
    if (refusal) {
      exp.status = 'cancelled';
      exp.finishedAt = nowIso(clock());
      exp.reasons = [refusal];
      refusedAtClaim = stripExperimentInternals(exp);
      return;
    }
    exp.status = 'running';
    exp.startedAt = nowIso(clock());
    const meta = state.experimentMeta[exp.id];
    if (meta) meta.runner = { ...identity, startedAt: exp.startedAt, heartbeatAt: exp.startedAt };
    claimed = { exp: structuredClone(exp), base: structuredClone(base!), cand: structuredClone(cand!) };
  });
  if (!claim.ok) return { ran: null, reason: claim.reason };
  if (refusedAtClaim) {
    appendHarnessLedger('harness:experiment', refusedAtClaim, 'daemon');
    return { ran: refusedAtClaim };
  }
  if (!claimed) return { ran: null, reason: 'the experiment was taken by another runner' };
  const { exp, base, cand } = claimed as { exp: ExperimentResultV1; base: HarnessVersion; cand: HarnessVersion };

  const controller = new AbortController();
  liveRunners.set(exp.id, controller);
  const onOuterAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  // Heartbeat: keeps the lease fresh and notices a cancel from another process.
  const heartbeat = setInterval(() => {
    mutateHarnessState((state) => {
      const e = state.experiments.find((x) => x.id === exp.id);
      if (!e || e.status !== 'running') {
        controller.abort();
        return;
      }
      const meta = state.experimentMeta[exp.id];
      if (meta?.runner) meta.runner.heartbeatAt = nowIso(clock());
    }, { waitMs: 250 });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let outcome: ExperimentOutcome;
  try {
    outcome = await runExperiment(base, cand, tasks, {
      executor,
      experimentId: exp.id,
      signal: controller.signal,
      slotLimit: () => ((opts.fleetQueueDepth?.() ?? 0) > 0 ? EXPERIMENT_SLOTS.fleetBusy : EXPERIMENT_SLOTS.idle),
    });
  } catch (err) {
    outcome = emptyOutcome('failed', [`runner error: ${err instanceof Error ? err.message : String(err)}`]);
  } finally {
    clearInterval(heartbeat);
    liveRunners.delete(exp.id);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  // Record it — unless it was cancelled meanwhile (the cancel already wrote
  // its own row; a late result must not resurrect it).
  let finished: ExperimentResultV1 | null = null;
  let rejected: { versionId: string; fromVersionId: string | null; configDigest: string } | null = null;
  const recorded = mutateHarnessState((state) => {
    const e = state.experiments.find((x) => x.id === exp.id);
    if (!e || e.status !== 'running') return;
    e.status = outcome.status;
    e.pairs = outcome.pairs;
    e.wins = outcome.wins;
    e.losses = outcome.losses;
    e.ties = outcome.ties;
    e.lift = outcome.lift;
    e.refuseRegression = outcome.refuseRegression;
    e.claimedChangeNoneMadeDelta = outcome.claimedChangeNoneMadeDelta;
    e.costDeltaPct = outcome.costDeltaPct;
    e.verdict = outcome.verdict;
    e.reasons = outcome.reasons.map((r) => scrubSecrets(r).slice(0, MAX_REASON_CHARS));
    e.finishedAt = nowIso(clock());
    const meta = state.experimentMeta[e.id];
    if (meta) {
      meta.armPasses = outcome.armPasses;
      meta.runner = null;
    }
    if (outcome.status === 'done' && outcome.verdict === 'reject') {
      const v = state.versions.find((x) => x.id === e.candidateVersionId);
      if (v && v.status === 'candidate') {
        v.status = 'rejected';
        rejected = { versionId: v.id, fromVersionId: state.activeId, configDigest: v.configDigest };
      }
    }
    finished = stripExperimentInternals(e);
  });
  const actor: HarnessActor = loadHarnessState().experimentMeta[exp.id]?.requestedBy ?? 'daemon';
  if (!recorded.ok) return { ran: null, reason: `the result could not be recorded: ${recorded.reason}` };
  if (!finished) {
    const current = loadHarnessState().experiments.find((x) => x.id === exp.id);
    return current ? { ran: stripExperimentInternals(current) } : { ran: null, reason: 'the experiment disappeared from the registry' };
  }
  appendHarnessLedger('harness:experiment', finished, actor);
  const r = rejected as { versionId: string; fromVersionId: string | null; configDigest: string } | null;
  if (r) {
    appendHarnessLedger('harness:rejected', {
      versionId: r.versionId,
      fromVersionId: r.fromVersionId,
      configDigest: r.configDigest,
      experimentId: exp.id,
      reason: (finished as ExperimentResultV1).reasons.join('; ').slice(0, MAX_REASON_CHARS),
    }, actor);
  }
  return { ran: finished };
}

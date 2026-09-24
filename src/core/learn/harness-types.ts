/**
 * Harness registry + experiments — V3.10 Track B contract (unit B-U1, frozen day 0).
 *
 * A HARNESS is the config-only envelope around the fleet's models: prompt
 * overlays, effort, sampling, routing weights and enabled skills. The
 * self-improvement loop (unit U9) versions harnesses, A/B-tests a candidate
 * against the active version on free local slots (paired runs, 95% CI,
 * ≥ 8 pairs, held-out tasks), and adopts a winner only through the Leader's
 * class-B action, behind a 48 h canary with automatic rollback.
 *
 * WHY config-only: a harness can never carry code, so adopting one can never
 * change authority (SPEC-310B I2). Code self-improvement arrives as ordinary
 * fleet PRs that pass every merge gate and only run after Mason deploys them.
 *
 * Honesty rule: `null` = unknown / not measured, never zero.
 *
 * BROWSER-SAFE: the Growth surface imports this — type-only imports, plain consts.
 */
import type { RoutingDifficulty } from '../routing/types.js';
import type { FleetEngine } from '../fleet/fleet-types.js';

export const VERSE_LEARNING_PATH = '/api/verse/learning';

// ---------------------------------------------------------------------------
// Harness config (what a version pins)
// ---------------------------------------------------------------------------

export type HarnessEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Roles a prompt overlay can target. */
export type HarnessRole = 'producer' | 'judge' | 'leader' | 'planner';

export interface HarnessSampling {
  /** null = the engine's own default. */
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
}

/**
 * The dispatch router's tunables. Precedence at dispatch (U5): a Leader
 * `router.tune` override (LeaderDirectivesV1) › the active harness › the
 * router's compiled defaults. All λ are ≥ 0.
 */
export interface HarnessRoutingWeights {
  lambdaCost: number;
  lambdaPressure: number;
  lambdaLatency: number;
  /** Best-of-N runs at and above this difficulty. */
  bonThreshold: RoutingDifficulty;
}

export interface HarnessConfigV1 {
  v: 1;
  /** Text appended to a role's system prompt; absent role = no overlay. Scrubbed, ≤ 4 KB each. */
  prompts: Partial<Record<HarnessRole, string>>;
  /** Effort per fleet engine; absent = engine default. */
  effort: Partial<Record<FleetEngine, HarnessEffort>>;
  /** Sampling per fleet engine; absent = engine default. */
  sampling: Partial<Record<FleetEngine, HarnessSampling>>;
  routing: HarnessRoutingWeights;
  /** Enabled skill ids, sorted. */
  skills: string[];
}

/** A config change. Top-level fields present here REPLACE the base's field wholesale (no deep merge). */
export type HarnessConfigPatch = Partial<Omit<HarnessConfigV1, 'v'>>;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * - `baseline`    — version 0: the compiled defaults.
 * - `candidate`   — under experiment.
 * - `canary`      — adopted, inside its 48 h canary.
 * - `adopted`     — canary passed; the active version.
 * - `rolled-back` — canary fell below baseline − 1 SE (or vetoed).
 * - `rejected`    — failed the adoption gate.
 */
export type HarnessVersionStatus = 'baseline' | 'candidate' | 'canary' | 'adopted' | 'rolled-back' | 'rejected';

export interface HarnessVersion {
  v: 1;
  /** Stable id, e.g. `h-0007`. */
  id: string;
  /** Monotonic; baseline = 0. */
  seq: number;
  parentId: string | null;
  createdAt: string;
  status: HarnessVersionStatus;
  config: HarnessConfigV1;
  /** sha256 hex of the canonical config — what experiments and ledger rows bind to. */
  configDigest: string;
  source: { kind: 'baseline' | 'hypothesis' | 'manual'; hypothesisId: string | null };
  /** The experiment whose verdict justified adoption; null for baseline / manual. */
  experimentId: string | null;
  adoptedAt: string | null;
  /** End of the 48 h canary; null when not in canary. */
  canaryUntil: string | null;
  rolledBackAt: string | null;
  rollbackReason: string | null;
}

// ---------------------------------------------------------------------------
// Hypotheses and experiments
// ---------------------------------------------------------------------------

export type HarnessTarget = 'prompt' | 'effort' | 'sampling' | 'routing' | 'skill';

/** A typed, testable claim about a config change (the Leader emits ≤ 3 per memo; A7 insights may too). */
export interface HarnessHypothesis {
  v: 1;
  id: string;
  source: { kind: 'leader' | 'insight' | 'manual'; ref: string | null };
  target: HarnessTarget;
  /** Config only — never code. */
  patch: HarnessConfigPatch;
  /** The claim in one sentence. Untrusted model text: scrubbed, rendered as text. */
  statement: string;
  /** Metric it should move, e.g. `local-eval.pass-rate`. */
  metric: string;
  /** Predicted change, in the metric's units. */
  predictedDelta: number;
  createdAt: string;
}

export type ExperimentVerdict = 'adopt' | 'reject' | 'inconclusive';

export type ExperimentStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'failed';

export interface ExperimentLift {
  /** Paired pass-rate lift of candidate over base, in percentage points. */
  mean: number;
  ciLow: number;
  ciHigh: number;
  level: 0.95;
}

export interface ExperimentResultV1 {
  v: 1;
  id: string;
  hypothesisId: string | null;
  baseVersionId: string;
  candidateVersionId: string;
  /** The held-out task set the pairs were drawn from. */
  taskSet: { id: string; digest: string };
  status: ExperimentStatus;
  /** Complete pairs so far. */
  pairs: number;
  wins: number;
  losses: number;
  ties: number;
  /** null until pairs ≥ HARNESS_ADOPTION_GATE.minPairs. */
  lift: ExperimentLift | null;
  /** Any `refuse`-class task regressed (blocks adoption). null = not measured yet. */
  refuseRegression: boolean | null;
  /** candidate − base count of `claimed-change-none-made` failures; must be ≤ 0 to adopt. */
  claimedChangeNoneMadeDelta: number | null;
  /** Wall-time / cost change in percent; must be ≤ +20 to adopt. */
  costDeltaPct: number | null;
  /** null while running. */
  verdict: ExperimentVerdict | null;
  /** Specific sentences behind the verdict. */
  reasons: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * The adoption gate (SPEC-310B §5) — frozen numbers. Adoption is a Leader
 * class-B action and requires ALL of: pairs ≥ minPairs, lift.ciLow >
 * minLiftCiLow, no refuse regression, claimedChangeNoneMadeDelta ≤ 0, and
 * costDeltaPct ≤ maxCostIncreasePct.
 */
export const HARNESS_ADOPTION_GATE = Object.freeze({
  minPairs: 8,
  ciLevel: 0.95,
  minLiftCiLow: 0,
  maxCostIncreasePct: 20,
  canaryHours: 48,
  /** Roll back when the canary pass rate falls below baseline − this many standard errors. */
  rollbackStandardErrors: 1,
  /** local-eval/tasks-heldout.ts must hold at least this many tasks (20 of 22 current tasks are saturated). */
  minHeldOutTasks: 12,
} as const);

/** Ledger payload for harness:adopted / harness:rolled-back / harness:rejected. */
export interface HarnessTransition {
  versionId: string;
  /** The version active before; null when none. */
  fromVersionId: string | null;
  configDigest: string;
  experimentId: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Cross-unit request / result shapes (learn/{experiments,harness-registry}.ts)
// ---------------------------------------------------------------------------

export type HarnessActor = 'mason' | 'leader' | 'daemon';

export interface StartExperimentRequest {
  hypothesis: HarnessHypothesis;
  requestedBy: HarnessActor;
}

export type StartExperimentResult = { ok: true; experimentId: string } | { ok: false; reason: string };

export interface CancelExperimentRequest {
  experimentId: string;
  reason: string;
  actor: HarnessActor;
}

/** A finished experiment cannot be cancelled (ok: false). */
export type CancelExperimentResult = { ok: true } | { ok: false; reason: string };

export interface AdoptHarnessRequest {
  versionId: string;
  /** The experiment whose verdict passed the gate. */
  experimentId: string;
  actor: HarnessActor;
}

export interface RollbackHarnessRequest {
  /** The version to make active again; null = back to the baseline defaults. */
  toVersionId: string | null;
  reason: string;
  actor: HarnessActor;
}

/** `before` is the version active before the call, so a veto can restore it exactly. */
export type HarnessChangeResult =
  | { ok: true; before: HarnessVersion | null; after: HarnessVersion | null }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Learning API (U9) — GET /api/verse/learning
// ---------------------------------------------------------------------------

export interface HarnessCanaryState {
  versionId: string;
  startedAt: string;
  until: string;
  baselinePassRate: number | null;
  baselineStandardError: number | null;
  currentPassRate: number | null;
  runs: number;
}

export interface LearningStateV1 {
  v: 1;
  generatedAt: string;
  /** null = nothing adopted; the baseline defaults are in force. */
  active: HarnessVersion | null;
  canary: HarnessCanaryState | null;
  /** Oldest → newest (Growth step chart with CI band and rollback markers). */
  versions: HarnessVersion[];
  /** Newest first (ForestPlot). */
  experiments: ExperimentResultV1[];
  /** Open hypotheses not yet tested. */
  hypotheses: HarnessHypothesis[];
}

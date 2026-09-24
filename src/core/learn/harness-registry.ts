/**
 * Harness registry — V3.10 Track B (owner: unit U9).
 *
 * Versions CONFIG-ONLY harnesses (prompt overlays, effort, sampling, routing
 * weights, skills). Adoption is a Leader class-B action (or Mason's) gated by
 * HARNESS_ADOPTION_GATE, followed by a 48 h canary with automatic rollback
 * when the live pass rate falls below baseline − 1 SE.
 *
 * STORE. One private file, ~/.ashlr/learn/harness/state.json (0600 in a 0700
 * directory): the version ladder, the active pointer, the canary, the
 * experiment results (learn/experiments.ts writes them here too, so a version
 * and the experiment that justified it can never disagree), open hypotheses
 * and a bounded ring of live run outcomes the canary is judged on. Every
 * write is a lock (fleet/local-store-lock) + atomic replace; reads are total
 * (a missing or mangled file is the empty registry — the baseline).
 *
 * WHY ONE FILE, NOT A LOG. The daemon reads `activeHarness()` on every
 * dispatch, synchronously; a single small document with an mtime cache is a
 * stat per call. The authority LEDGER is the append-only history: every
 * adoption, rollback, rejection and finished experiment is also a ledger row.
 *
 * INVARIANTS (each has a test in test/learn-harness-310b.test.ts):
 *  - Config only. A patch carries only the five HarnessConfigV1 fields, every
 *    value is bounds-checked, and anything that looks like a code diff is
 *    refused — a harness can never change authority (SPEC-310B I2).
 *  - Adoption re-derives the gate from the experiment's NUMBERS (never trusts
 *    its verdict string), requires the experiment to have compared against
 *    the version that is active NOW, and fails closed when the ledger append
 *    fails.
 *  - Rollback (lowering) always proceeds, even with a broken ledger: an unsafe
 *    harness must never be stuck in force because the record could not be
 *    written. The ledger row is best-effort there, by design.
 *  - Honesty: `null` = unknown. A canary with too few live runs is neither
 *    passed nor failed; it keeps waiting.
 */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import { appendLedger } from '../authority/ledger.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import type { LedgerEventKind, LedgerPayloads } from '../authority/types.js';
import type { FleetEngine } from '../fleet/fleet-types.js';
import type { RoutingDifficulty } from '../routing/types.js';
import {
  HARNESS_ADOPTION_GATE,
  type AdoptHarnessRequest,
  type ExperimentResultV1,
  type ExperimentVerdict,
  type HarnessActor,
  type HarnessCanaryState,
  type HarnessChangeResult,
  type HarnessConfigPatch,
  type HarnessConfigV1,
  type HarnessEffort,
  type HarnessHypothesis,
  type HarnessRole,
  type HarnessSampling,
  type HarnessTarget,
  type HarnessVersion,
  type LearningStateV1,
  type RollbackHarnessRequest,
} from './harness-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Version 0: the compiled defaults. Always present in the ladder. */
export const BASELINE_VERSION_ID = 'h-0000';

/**
 * The compiled defaults. Routing weights here are the values the dispatch
 * router (U5) falls back to when no harness is adopted — U5 imports this
 * constant rather than restating the numbers, so "baseline" is one fact.
 * λ = 1 for cost and pressure keeps the A9 router's own ordering; latency is
 * a tie-breaker; best-of-N only for high difficulty (the local slots are the
 * scarce resource and BoN multiplies their use).
 */
export const BASELINE_HARNESS_CONFIG: HarnessConfigV1 = Object.freeze({
  v: 1,
  prompts: Object.freeze({}),
  effort: Object.freeze({}),
  sampling: Object.freeze({}),
  routing: Object.freeze({ lambdaCost: 1, lambdaPressure: 1, lambdaLatency: 0.25, bonThreshold: 'high' }),
  skills: Object.freeze([]) as unknown as string[],
}) as HarnessConfigV1;

/** Bounds every config value must satisfy (a patch outside them is refused, not clamped). */
export const HARNESS_CONFIG_BOUNDS = Object.freeze({
  maxPromptBytes: 4096,
  maxSkills: 32,
  /** λ ∈ [0, lambdaMax]: a weight 10× the baseline already dominates the score. */
  lambdaMax: 10,
  temperature: Object.freeze({ min: 0, max: 2 }),
  topP: Object.freeze({ min: 0.01, max: 1 }),
  maxOutputTokens: Object.freeze({ min: 256, max: 128_000 }),
} as const);

/** Canary judgement needs at least this many live runs on each side. */
export const CANARY_MIN_RUNS = 8;
/** The pre-adoption live baseline looks back this far… */
export const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** …over at most this many newest runs. */
const BASELINE_MAX_RUNS = 200;

const HARNESS_DIR_PARTS = ['.ashlr', 'learn', 'harness'] as const;
const STATE_FILE = 'state.json';
const LOCK_FILE = '.state.lock';
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_VERSIONS = 200;
const MAX_EXPERIMENTS = 100;
const MAX_HYPOTHESES = 50;
const MAX_OUTCOMES = 2000;
const MAX_REASON_CHARS = 500;
const MAX_STATEMENT_CHARS = 1000;

const HARNESS_ROLES: readonly HarnessRole[] = ['producer', 'judge', 'leader', 'planner'];
const HARNESS_EFFORTS: readonly HarnessEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const HARNESS_ENGINES: readonly FleetEngine[] = ['local', 'grok-cli', 'claude-cli', 'codex'];
const DIFFICULTIES: readonly RoutingDifficulty[] = ['low', 'medium', 'high'];
const TARGET_FIELD: Readonly<Record<HarnessTarget, keyof HarnessConfigPatch>> = {
  prompt: 'prompts',
  effort: 'effort',
  sampling: 'sampling',
  routing: 'routing',
  skill: 'skills',
};
const PATCH_KEYS: ReadonlySet<string> = new Set(['prompts', 'effort', 'sampling', 'routing', 'skills']);
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HYPOTHESIS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const METRIC_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_ID_RE = /^h-\d{4,}$/;
/**
 * Unified-diff / patch markers. A prompt overlay is prose; one that carries a
 * diff is an attempt to smuggle code through the config channel.
 */
const CODE_DIFF_RE = /^(?:diff --git |index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- global twin of CONTROL_RE for replacement
const CONTROL_RE_G = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface HarnessCanaryRecord {
  versionId: string;
  /** The version active before adoption (null = baseline) — what a rollback restores. */
  fromVersionId: string | null;
  startedAt: string;
  until: string;
  baselinePassRate: number | null;
  baselineStandardError: number | null;
  baselineRuns: number;
  /** `live`: pre-adoption fleet runs; `experiment`: the experiment's base arm (too few live runs). */
  baselineSource: 'live' | 'experiment' | 'none';
}

/** One verified fleet run attributed to the harness version it ran under. */
export interface HarnessOutcome {
  versionId: string;
  passed: boolean;
  at: string;
}

export interface ExperimentMeta {
  requestedBy: HarnessActor;
  hypothesis: HarnessHypothesis;
  queuedAt: string;
  runner: { pid: number; host: string; startedAt: string; heartbeatAt: string } | null;
  cancel: { reason: string; actor: HarnessActor; at: string } | null;
  /**
   * Pass counts per arm over the complete pairs, once finished. Not on the
   * wire shape (ExperimentResultV1 carries wins/losses/ties only), but the
   * canary needs the base arm's pass rate when the fleet has no live baseline.
   */
  armPasses: { base: number; candidate: number } | null;
}

export interface HarnessStateV1 {
  v: 1;
  /** Highest version seq issued (baseline = 0). */
  versionSeq: number;
  experimentSeq: number;
  /** null = the baseline defaults are in force. */
  activeId: string | null;
  versions: HarnessVersion[];
  canary: HarnessCanaryRecord | null;
  /** Newest last. */
  experiments: ExperimentResultV1[];
  experimentMeta: Record<string, ExperimentMeta>;
  /** Open (untested) hypotheses, oldest first. */
  hypotheses: HarnessHypothesis[];
  /** Ring of live outcomes, oldest first. */
  outcomes: HarnessOutcome[];
}

// ---------------------------------------------------------------------------
// Canonical config + digest
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('non-finite number in harness config');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * sha256 hex of the canonical config (sorted keys, no undefined). Kept local
 * rather than importing daemon/activation-permit's canonicalizer: that module
 * pulls in the sandbox policy and daemon guard, and the harness registry is on
 * the dispatch hot path.
 */
export function harnessConfigDigest(config: HarnessConfigV1): string {
  return createHash('sha256').update(`ashlr:harness-config:v1\0${canonicalJson(config)}`, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkPrompt(role: string, text: unknown): Checked<string> {
  if (typeof text !== 'string') return { ok: false, reason: `prompts.${role} must be a string` };
  if (Buffer.byteLength(text, 'utf8') > HARNESS_CONFIG_BOUNDS.maxPromptBytes) {
    return { ok: false, reason: `prompts.${role} exceeds ${HARNESS_CONFIG_BOUNDS.maxPromptBytes} bytes` };
  }
  if (CONTROL_RE.test(text)) return { ok: false, reason: `prompts.${role} contains control characters` };
  if (CODE_DIFF_RE.test(text)) {
    return { ok: false, reason: `prompts.${role} carries a code diff; a harness is config only — code changes ship as fleet PRs` };
  }
  // Untrusted model text: secrets never reach a stored config or a system prompt.
  return { ok: true, value: scrubSecrets(text) };
}

function checkNumber(value: unknown, label: string, min: number, max: number, integer = false): Checked<number | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    return { ok: false, reason: `${label} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}] or null` };
  }
  return { ok: true, value };
}

function checkSampling(engine: string, value: unknown): Checked<HarnessSampling> {
  if (!isPlainObject(value)) return { ok: false, reason: `sampling.${engine} must be an object` };
  for (const key of Object.keys(value)) {
    if (key !== 'temperature' && key !== 'topP' && key !== 'maxOutputTokens') return { ok: false, reason: `sampling.${engine}: unknown key ${key}` };
  }
  const b = HARNESS_CONFIG_BOUNDS;
  const t = checkNumber(value.temperature ?? null, `sampling.${engine}.temperature`, b.temperature.min, b.temperature.max);
  if (!t.ok) return t;
  const p = checkNumber(value.topP ?? null, `sampling.${engine}.topP`, b.topP.min, b.topP.max);
  if (!p.ok) return p;
  const m = checkNumber(value.maxOutputTokens ?? null, `sampling.${engine}.maxOutputTokens`, b.maxOutputTokens.min, b.maxOutputTokens.max, true);
  if (!m.ok) return m;
  return { ok: true, value: { temperature: t.value, topP: p.value, maxOutputTokens: m.value } };
}

/**
 * Validate a config patch (untrusted: it comes from the Leader's memo, an
 * insight, or a POST). Returns a sanitized copy — prompts scrubbed, skills
 * sorted — or the first reason it is refused. With `target`, the patch must
 * touch exactly the field that target names, so a "prompt" hypothesis cannot
 * quietly also move routing weights.
 */
export function validateHarnessConfigPatch(patch: unknown, target?: HarnessTarget): Checked<HarnessConfigPatch> {
  if (!isPlainObject(patch)) return { ok: false, reason: 'patch must be a JSON object' };
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, reason: 'patch changes nothing' };
  for (const key of keys) {
    if (!PATCH_KEYS.has(key)) {
      return { ok: false, reason: `patch key "${key.slice(0, 40)}" is not a harness field; a harness is config only (prompts, effort, sampling, routing, skills)` };
    }
  }
  if (target !== undefined) {
    const field = TARGET_FIELD[target];
    if (!field) return { ok: false, reason: 'unknown hypothesis target' };
    if (keys.length !== 1 || keys[0] !== field) return { ok: false, reason: `a "${target}" hypothesis may only change ${field}` };
  }
  const out: HarnessConfigPatch = {};
  if ('prompts' in patch) {
    const prompts = patch.prompts;
    if (!isPlainObject(prompts)) return { ok: false, reason: 'prompts must be an object' };
    const next: Partial<Record<HarnessRole, string>> = {};
    for (const [role, text] of Object.entries(prompts)) {
      if (!(HARNESS_ROLES as readonly string[]).includes(role)) return { ok: false, reason: `prompts: unknown role ${role.slice(0, 40)}` };
      const checked = checkPrompt(role, text);
      if (!checked.ok) return checked;
      if (checked.value.length > 0) next[role as HarnessRole] = checked.value;
    }
    out.prompts = next;
  }
  if ('effort' in patch) {
    const effort = patch.effort;
    if (!isPlainObject(effort)) return { ok: false, reason: 'effort must be an object' };
    const next: Partial<Record<FleetEngine, HarnessEffort>> = {};
    for (const [engine, level] of Object.entries(effort)) {
      if (!(HARNESS_ENGINES as readonly string[]).includes(engine)) return { ok: false, reason: `effort: unknown engine ${engine.slice(0, 40)}` };
      if (!(HARNESS_EFFORTS as readonly unknown[]).includes(level)) return { ok: false, reason: `effort.${engine} must be one of ${HARNESS_EFFORTS.join(', ')}` };
      next[engine as FleetEngine] = level as HarnessEffort;
    }
    out.effort = next;
  }
  if ('sampling' in patch) {
    const sampling = patch.sampling;
    if (!isPlainObject(sampling)) return { ok: false, reason: 'sampling must be an object' };
    const next: Partial<Record<FleetEngine, HarnessSampling>> = {};
    for (const [engine, value] of Object.entries(sampling)) {
      if (!(HARNESS_ENGINES as readonly string[]).includes(engine)) return { ok: false, reason: `sampling: unknown engine ${engine.slice(0, 40)}` };
      const checked = checkSampling(engine, value);
      if (!checked.ok) return checked;
      next[engine as FleetEngine] = checked.value;
    }
    out.sampling = next;
  }
  if ('routing' in patch) {
    const routing = patch.routing;
    if (!isPlainObject(routing)) return { ok: false, reason: 'routing must be an object' };
    const allowed = new Set(['lambdaCost', 'lambdaPressure', 'lambdaLatency', 'bonThreshold']);
    for (const key of Object.keys(routing)) {
      if (!allowed.has(key)) return { ok: false, reason: `routing: unknown key ${key.slice(0, 40)}` };
    }
    for (const key of ['lambdaCost', 'lambdaPressure', 'lambdaLatency'] as const) {
      const v = routing[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > HARNESS_CONFIG_BOUNDS.lambdaMax) {
        return { ok: false, reason: `routing.${key} must be a number in [0, ${HARNESS_CONFIG_BOUNDS.lambdaMax}] (routing is replaced wholesale, so all four fields are required)` };
      }
    }
    if (!(DIFFICULTIES as readonly unknown[]).includes(routing.bonThreshold)) {
      return { ok: false, reason: `routing.bonThreshold must be one of ${DIFFICULTIES.join(', ')}` };
    }
    out.routing = {
      lambdaCost: routing.lambdaCost as number,
      lambdaPressure: routing.lambdaPressure as number,
      lambdaLatency: routing.lambdaLatency as number,
      bonThreshold: routing.bonThreshold as RoutingDifficulty,
    };
  }
  if ('skills' in patch) {
    const skills = patch.skills;
    if (!Array.isArray(skills) || skills.length > HARNESS_CONFIG_BOUNDS.maxSkills) {
      return { ok: false, reason: `skills must be an array of at most ${HARNESS_CONFIG_BOUNDS.maxSkills} ids` };
    }
    for (const id of skills) {
      if (typeof id !== 'string' || !SKILL_ID_RE.test(id)) return { ok: false, reason: 'skills: every id must match [a-z0-9][a-z0-9._-]{0,63}' };
    }
    out.skills = [...new Set(skills as string[])].sort();
  }
  return { ok: true, value: out };
}

/** Top-level fields present in `patch` REPLACE the base's field wholesale (the contract's no-deep-merge rule). */
export function applyHarnessPatch(base: HarnessConfigV1, patch: HarnessConfigPatch): HarnessConfigV1 {
  return {
    v: 1,
    prompts: { ...(patch.prompts ?? base.prompts) },
    effort: { ...(patch.effort ?? base.effort) },
    sampling: Object.fromEntries(Object.entries(patch.sampling ?? base.sampling).map(([k, v]) => [k, { ...v }])),
    routing: { ...(patch.routing ?? base.routing) },
    skills: [...(patch.skills ?? base.skills)],
  };
}

/**
 * The leaf paths that differ between two configs, e.g. `prompts.producer`,
 * `effort.local`, `routing`, `skills`. Experiments use it to refuse a
 * candidate whose change the runner cannot exercise.
 */
export function harnessConfigDiff(base: HarnessConfigV1, cand: HarnessConfigV1): string[] {
  const out: string[] = [];
  const mapDiff = (field: 'prompts' | 'effort' | 'sampling'): void => {
    const a = base[field] as Record<string, unknown>;
    const b = cand[field] as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null)) out.push(`${field}.${key}`);
    }
  };
  mapDiff('prompts');
  mapDiff('effort');
  mapDiff('sampling');
  if (canonicalJson(base.routing) !== canonicalJson(cand.routing)) out.push('routing');
  if (canonicalJson(base.skills) !== canonicalJson(cand.skills)) out.push('skills');
  return out;
}

/** Validate a hypothesis (untrusted). Returns a sanitized copy. */
export function validateHarnessHypothesis(value: unknown): Checked<HarnessHypothesis> {
  if (!isPlainObject(value)) return { ok: false, reason: 'hypothesis must be a JSON object' };
  const h = value;
  const allowed = new Set(['v', 'id', 'source', 'target', 'patch', 'statement', 'metric', 'predictedDelta', 'createdAt']);
  for (const key of Object.keys(h)) {
    if (!allowed.has(key)) return { ok: false, reason: `hypothesis: unknown key ${key.slice(0, 40)}` };
  }
  if (h.v !== 1) return { ok: false, reason: 'hypothesis.v must be 1' };
  if (typeof h.id !== 'string' || !HYPOTHESIS_ID_RE.test(h.id)) return { ok: false, reason: 'hypothesis.id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,63}' };
  if (!isPlainObject(h.source)) return { ok: false, reason: 'hypothesis.source must be an object' };
  const kind = h.source.kind;
  if (kind !== 'leader' && kind !== 'insight' && kind !== 'manual') return { ok: false, reason: 'hypothesis.source.kind must be leader, insight or manual' };
  const ref = h.source.ref;
  if (ref !== null && (typeof ref !== 'string' || ref.length > 128)) return { ok: false, reason: 'hypothesis.source.ref must be a string (≤ 128) or null' };
  if (typeof h.target !== 'string' || !(h.target in TARGET_FIELD)) return { ok: false, reason: 'hypothesis.target must be prompt, effort, sampling, routing or skill' };
  const patch = validateHarnessConfigPatch(h.patch, h.target as HarnessTarget);
  if (!patch.ok) return patch;
  if (typeof h.statement !== 'string' || h.statement.trim().length === 0) return { ok: false, reason: 'hypothesis.statement is required' };
  if (typeof h.metric !== 'string' || !METRIC_RE.test(h.metric)) return { ok: false, reason: 'hypothesis.metric must be a metric id like local-eval.pass-rate' };
  if (typeof h.predictedDelta !== 'number' || !Number.isFinite(h.predictedDelta)) return { ok: false, reason: 'hypothesis.predictedDelta must be a finite number' };
  if (typeof h.createdAt !== 'string' || !Number.isFinite(Date.parse(h.createdAt))) return { ok: false, reason: 'hypothesis.createdAt must be an ISO timestamp' };
  return {
    ok: true,
    value: {
      v: 1,
      id: h.id,
      source: { kind, ref: ref === null ? null : scrubSecrets(ref as string) },
      target: h.target as HarnessTarget,
      patch: patch.value,
      statement: scrubSecrets(h.statement.replace(CONTROL_RE_G, ' ')).slice(0, MAX_STATEMENT_CHARS),
      metric: h.metric,
      predictedDelta: h.predictedDelta,
      createdAt: new Date(Date.parse(h.createdAt)).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Adoption gate (pure)
// ---------------------------------------------------------------------------

export interface ExperimentMetrics {
  pairs: number;
  lift: ExperimentResultV1['lift'];
  refuseRegression: boolean | null;
  claimedChangeNoneMadeDelta: number | null;
  costDeltaPct: number | null;
}

const pp = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)} pp`;

/**
 * The verdict the adoption gate reaches on an experiment's numbers, with the
 * sentences behind it. Order matters: a hard rule (refuse regression, a rise
 * in claimed-change-none-made, cost) REJECTS regardless of lift, because a
 * pass-rate gain bought with any of those is not a gain the fleet wants.
 * Unmeasured metrics can never adopt (null = unknown, not zero).
 */
export function decideExperimentVerdict(m: ExperimentMetrics): { verdict: ExperimentVerdict; reasons: string[] } {
  const gate = HARNESS_ADOPTION_GATE;
  const reasons: string[] = [];
  if (!Number.isInteger(m.pairs) || m.pairs < gate.minPairs) {
    return { verdict: 'inconclusive', reasons: [`only ${m.pairs} complete pairs; the gate needs at least ${gate.minPairs}`] };
  }
  const rejects: string[] = [];
  if (m.refuseRegression === true) rejects.push('a refuse task regressed: the candidate did something the base harness correctly declined');
  if (m.claimedChangeNoneMadeDelta !== null && m.claimedChangeNoneMadeDelta > 0) {
    rejects.push(`claimed-change-none-made rose by ${m.claimedChangeNoneMadeDelta}`);
  }
  if (m.costDeltaPct !== null && m.costDeltaPct > gate.maxCostIncreasePct) {
    rejects.push(`cost rose ${m.costDeltaPct.toFixed(1)}%, above the +${gate.maxCostIncreasePct}% limit`);
  }
  if (m.lift && m.lift.ciHigh <= gate.minLiftCiLow) {
    rejects.push(`the 95% CI on lift [${pp(m.lift.ciLow)}, ${pp(m.lift.ciHigh)}] rules out any improvement`);
  }
  if (rejects.length > 0) return { verdict: 'reject', reasons: rejects };
  const unknown: string[] = [];
  if (m.lift === null) unknown.push('lift was not measured');
  if (m.refuseRegression === null) unknown.push('refuse regressions were not measured');
  if (m.claimedChangeNoneMadeDelta === null) unknown.push('claimed-change-none-made was not measured');
  if (m.costDeltaPct === null) unknown.push('cost was not measured');
  if (unknown.length > 0) return { verdict: 'inconclusive', reasons: unknown };
  const lift = m.lift!;
  if (lift.ciLow > gate.minLiftCiLow) {
    reasons.push(`lift ${pp(lift.mean)} over ${m.pairs} pairs, 95% CI [${pp(lift.ciLow)}, ${pp(lift.ciHigh)}] excludes 0`);
    reasons.push('no refuse regression');
    reasons.push(`claimed-change-none-made ${m.claimedChangeNoneMadeDelta! > 0 ? 'rose' : 'did not rise'} (Δ ${m.claimedChangeNoneMadeDelta})`);
    reasons.push(`cost ${m.costDeltaPct! >= 0 ? '+' : ''}${m.costDeltaPct!.toFixed(1)}% (limit +${gate.maxCostIncreasePct}%)`);
    return { verdict: 'adopt', reasons };
  }
  return {
    verdict: 'inconclusive',
    reasons: [`the 95% CI on lift [${pp(lift.ciLow)}, ${pp(lift.ciHigh)}] includes 0 — not enough evidence either way`],
  };
}

/** Does this finished experiment pass the adoption gate? Re-derived from its numbers. */
export function evaluateAdoptionGate(exp: ExperimentResultV1): { pass: boolean; reasons: string[] } {
  if (exp.status !== 'done') return { pass: false, reasons: [`experiment ${exp.id} is ${exp.status}, not done`] };
  const decided = decideExperimentVerdict(exp);
  if (decided.verdict !== 'adopt') return { pass: false, reasons: decided.reasons };
  if (exp.verdict !== 'adopt') return { pass: false, reasons: [`experiment ${exp.id} recorded verdict ${exp.verdict ?? 'none'}`] };
  return { pass: true, reasons: decided.reasons };
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

export function harnessDir(): string {
  return join(homedir(), ...HARNESS_DIR_PARTS);
}

export function harnessStatePath(): string {
  return join(harnessDir(), STATE_FILE);
}

function baselineVersion(): HarnessVersion {
  return {
    v: 1,
    id: BASELINE_VERSION_ID,
    seq: 0,
    parentId: null,
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'baseline',
    config: applyHarnessPatch(BASELINE_HARNESS_CONFIG, {}),
    configDigest: harnessConfigDigest(BASELINE_HARNESS_CONFIG),
    source: { kind: 'baseline', hypothesisId: null },
    experimentId: null,
    adoptedAt: null,
    canaryUntil: null,
    rolledBackAt: null,
    rollbackReason: null,
  };
}

export function emptyHarnessState(): HarnessStateV1 {
  return {
    v: 1,
    versionSeq: 0,
    experimentSeq: 0,
    activeId: null,
    versions: [baselineVersion()],
    canary: null,
    experiments: [],
    experimentMeta: {},
    hypotheses: [],
    outcomes: [],
  };
}

/**
 * Structural check of a loaded state. The file is ours, but it sits in the
 * user's home: anything that does not look exactly like a state we wrote is
 * treated as absent (the baseline), never partially trusted.
 */
function coerceState(raw: unknown): HarnessStateV1 | null {
  if (!isPlainObject(raw) || raw.v !== 1) return null;
  if (!Array.isArray(raw.versions) || !Array.isArray(raw.experiments) || !Array.isArray(raw.hypotheses) || !Array.isArray(raw.outcomes)) return null;
  if (!isPlainObject(raw.experimentMeta)) return null;
  if (typeof raw.versionSeq !== 'number' || typeof raw.experimentSeq !== 'number') return null;
  const state = raw as unknown as HarnessStateV1;
  if (state.activeId !== null && (typeof state.activeId !== 'string' || !state.versions.some((v) => v?.id === state.activeId))) return null;
  for (const version of state.versions) {
    if (!isPlainObject(version) || typeof version.id !== 'string' || !VERSION_ID_RE.test(version.id)) return null;
    // A version whose config no longer hashes to its digest was edited by hand
    // (or corrupted): refuse the whole file rather than run an unverified config.
    try {
      if (harnessConfigDigest(version.config) !== version.configDigest) return null;
    } catch {
      return null;
    }
  }
  if (!state.versions.some((v) => v.id === BASELINE_VERSION_ID)) state.versions.unshift(baselineVersion());
  return state;
}

let cache: { path: string; mtimeMs: number; bytes: number; ino: number; state: HarnessStateV1 } | null = null;

/**
 * The stored state, SHARED with the cache — callers must not mutate it. One
 * lstat when warm (activeHarness runs on every dispatch); a re-read only when
 * the file's identity, size or mtime moved. Total: never throws.
 */
function readSharedState(): HarnessStateV1 {
  const path = harnessStatePath();
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    cache = null;
    return emptyHarnessState();
  }
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.bytes === stat.size && cache.ino === stat.ino) {
    return cache.state;
  }
  const read = readPrivateFileCapped(path, MAX_STATE_BYTES);
  if (!read || read.truncated) {
    cache = null;
    return emptyHarnessState();
  }
  let parsed: HarnessStateV1 | null = null;
  try {
    parsed = coerceState(JSON.parse(read.text) as unknown);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    cache = null;
    return emptyHarnessState();
  }
  cache = { path, mtimeMs: read.mtimeMs, bytes: read.bytes, ino: stat.ino, state: parsed };
  return parsed;
}

/** The registry as stored (or empty) — a private copy the caller may mutate. Total: never throws. */
export function loadHarnessState(): HarnessStateV1 {
  return structuredClone(readSharedState());
}

function pruneState(state: HarnessStateV1): void {
  if (state.outcomes.length > MAX_OUTCOMES) state.outcomes.splice(0, state.outcomes.length - MAX_OUTCOMES);
  if (state.hypotheses.length > MAX_HYPOTHESES) state.hypotheses.splice(0, state.hypotheses.length - MAX_HYPOTHESES);
  if (state.experiments.length > MAX_EXPERIMENTS) {
    // Never drop a queued / running experiment or one a live version points at.
    const pinned = new Set(state.versions.map((v) => v.experimentId).filter((id): id is string => id !== null));
    const removable = state.experiments.filter((e) => e.status !== 'queued' && e.status !== 'running' && !pinned.has(e.id));
    const excess = state.experiments.length - MAX_EXPERIMENTS;
    const drop = new Set(removable.slice(0, excess).map((e) => e.id));
    state.experiments = state.experiments.filter((e) => !drop.has(e.id));
    for (const id of drop) delete state.experimentMeta[id];
  }
  if (state.versions.length > MAX_VERSIONS) {
    // History that matters (baseline, adopted, canary, rolled back, active) is
    // kept; the oldest rejected / abandoned candidates go first.
    const keep = (v: HarnessVersion): boolean => v.id === BASELINE_VERSION_ID || v.id === state.activeId
      || v.status === 'adopted' || v.status === 'canary' || v.status === 'rolled-back';
    const running = new Set(state.experiments.filter((e) => e.status === 'queued' || e.status === 'running').map((e) => e.candidateVersionId));
    const removable = state.versions.filter((v) => !keep(v) && !running.has(v.id));
    const excess = state.versions.length - MAX_VERSIONS;
    const drop = new Set(removable.slice(0, excess).map((v) => v.id));
    state.versions = state.versions.filter((v) => !drop.has(v.id));
  }
}

/**
 * Lock, load, mutate, write. `fn` may throw to abort (nothing is written) or
 * return `{ write: false }`-style values by leaving the state untouched —
 * the file is only rewritten when the serialized state changed.
 */
export function mutateHarnessState<T>(fn: (state: HarnessStateV1) => T, opts: { waitMs?: number } = {}): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    ensurePrivateDirectory(harnessDir());
  } catch {
    return { ok: false, reason: 'the harness store directory is not a private, owned directory' };
  }
  const lock = acquireLocalStoreLock(join(harnessDir(), LOCK_FILE), opts.waitMs ?? 2_000, { anchorPath: homedir() });
  if (!lock) return { ok: false, reason: 'the harness store is busy (lock not acquired)' };
  try {
    const state = loadHarnessState();
    const before = JSON.stringify(state);
    const value = fn(state);
    pruneState(state);
    const after = JSON.stringify(state);
    if (after !== before) {
      const encoded = `${JSON.stringify(state, null, 2)}\n`;
      if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) return { ok: false, reason: 'the harness store would exceed its size cap' };
      writePrivateFileAtomic(harnessStatePath(), encoded);
      cache = null;
    }
    return { ok: true, value };
  } catch (err) {
    if (err instanceof HarnessRefusal) return { ok: false, reason: err.message };
    return { ok: false, reason: 'the harness store could not be updated' };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Thrown inside a mutation to refuse with a specific, user-facing reason (nothing is written). */
export class HarnessRefusal extends Error {}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Append a harness row to the authority ledger. Never throws: a ledger that is
 * not installed yet (B-U1's day-0 stub throws) or broken reports ok:false, and
 * the caller decides — adoption fails closed, rollback proceeds.
 */
export function appendHarnessLedger<K extends LedgerEventKind>(kind: K, data: LedgerPayloads[K], actor: HarnessActor): { ok: true } | { ok: false; reason: string } {
  try {
    let grantId: string | null = null;
    try {
      grantId = currentStandingPolicy()?.grantId ?? null;
    } catch {
      grantId = null;
    }
    const result = appendLedger({ kind, data, actor, grantId, repo: null });
    return result.ok ? { ok: true } : { ok: false, reason: `ledger append refused: ${result.reason}` };
  } catch {
    return { ok: false, reason: 'the authority ledger is unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The active harness version, or null when none has been adopted — dispatch
 * then runs the baseline defaults (BASELINE_HARNESS_CONFIG). A version inside
 * its canary IS active. Synchronous and cheap (one stat on a warm cache);
 * returns a frozen copy the caller cannot mutate into the cache.
 */
export function activeHarness(): HarnessVersion | null {
  try {
    const state = readSharedState();
    if (state.activeId === null || state.activeId === BASELINE_VERSION_ID) return null;
    const version = state.versions.find((v) => v.id === state.activeId);
    return version ? freezeDeep(structuredClone(version)) : null;
  } catch {
    return null;
  }
}

/** The config dispatch should use right now: the active version's, else the baseline. */
export function activeHarnessConfig(): HarnessConfigV1 {
  return activeHarness()?.config ?? freezeDeep(applyHarnessPatch(BASELINE_HARNESS_CONFIG, {}));
}

export function harnessVersion(id: string): HarnessVersion | null {
  const found = readSharedState().versions.find((v) => v.id === id);
  return found ? structuredClone(found) : null;
}

// ---------------------------------------------------------------------------
// Versions + hypotheses (used by learn/experiments.ts)
// ---------------------------------------------------------------------------

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

/**
 * The version a new candidate should be built on: the active version, or the
 * baseline. Mutates nothing.
 */
export function currentBaseVersion(state: HarnessStateV1): HarnessVersion {
  const id = state.activeId ?? BASELINE_VERSION_ID;
  const found = state.versions.find((v) => v.id === id);
  if (!found) throw new HarnessRefusal(`active version ${id} is missing from the registry`);
  return found;
}

/**
 * Create (or reuse) a candidate version = base + patch, inside a mutation.
 * Reuses an existing candidate with the same parent and config digest so a
 * re-run of the same hypothesis does not grow the ladder.
 */
export function createCandidateVersion(
  state: HarnessStateV1,
  base: HarnessVersion,
  patch: HarnessConfigPatch,
  source: HarnessVersion['source'],
  now?: Date,
): HarnessVersion {
  const config = applyHarnessPatch(base.config, patch);
  const configDigest = harnessConfigDigest(config);
  if (configDigest === base.configDigest) throw new HarnessRefusal('the patch leaves the harness unchanged; there is nothing to test');
  const existing = state.versions.find((v) => v.status === 'candidate' && v.parentId === base.id && v.configDigest === configDigest);
  if (existing) return existing;
  const seq = state.versionSeq + 1;
  state.versionSeq = seq;
  const version: HarnessVersion = {
    v: 1,
    id: `h-${String(seq).padStart(4, '0')}`,
    seq,
    parentId: base.id,
    createdAt: nowIso(now),
    status: 'candidate',
    config,
    configDigest,
    source,
    experimentId: null,
    adoptedAt: null,
    canaryUntil: null,
    rolledBackAt: null,
    rollbackReason: null,
  };
  state.versions.push(version);
  return version;
}

/**
 * Register hypotheses as OPEN (untested) — the Leader's memo and insight
 * sweeps call this; the Growth surface lists them. Invalid ones are refused
 * with a reason; an id already known (open, or already tested) is skipped.
 */
export function recordHypotheses(hypotheses: readonly unknown[]): { accepted: string[]; refused: { id: string | null; reason: string }[] } {
  const accepted: string[] = [];
  const refused: { id: string | null; reason: string }[] = [];
  const valid: HarnessHypothesis[] = [];
  for (const raw of hypotheses.slice(0, MAX_HYPOTHESES)) {
    const checked = validateHarnessHypothesis(raw);
    if (!checked.ok) {
      const id = isPlainObject(raw) && typeof raw.id === 'string' ? raw.id.slice(0, 64) : null;
      refused.push({ id, reason: checked.reason });
    } else {
      valid.push(checked.value);
    }
  }
  if (valid.length === 0) return { accepted, refused };
  const result = mutateHarnessState((state) => {
    const tested = new Set(state.experiments.map((e) => e.hypothesisId).filter((id): id is string => id !== null));
    for (const h of valid) {
      if (tested.has(h.id) || state.hypotheses.some((open) => open.id === h.id)) {
        refused.push({ id: h.id, reason: 'already recorded' });
        continue;
      }
      state.hypotheses.push(h);
      accepted.push(h.id);
    }
  });
  if (!result.ok) return { accepted: [], refused: [...refused, ...valid.map((h) => ({ id: h.id, reason: result.reason }))] };
  return { accepted, refused };
}

/** An open or already-tested hypothesis by id (the Leader's `experiment.start` names one). */
export function findHypothesis(id: string): HarnessHypothesis | null {
  const state = readSharedState();
  const open = state.hypotheses.find((h) => h.id === id);
  if (open) return structuredClone(open);
  for (const meta of Object.values(state.experimentMeta)) if (meta.hypothesis.id === id) return structuredClone(meta.hypothesis);
  return null;
}

// ---------------------------------------------------------------------------
// Canary
// ---------------------------------------------------------------------------

/**
 * A pass-rate standard error that does not collapse at 0% or 100% (Agresti–
 * Coull: add two passes and two failures). With the plain √(p(1−p)/n), a
 * perfect 20/20 baseline has SE 0 and one failed canary run would roll back
 * a harness that is doing fine.
 */
export function passRateStandardError(passes: number, runs: number): number | null {
  if (!Number.isInteger(runs) || runs <= 0 || !Number.isInteger(passes) || passes < 0 || passes > runs) return null;
  const n = runs + 4;
  const p = (passes + 2) / n;
  return Math.sqrt((p * (1 - p)) / n);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function liveBaseline(state: HarnessStateV1, versionId: string, nowMs: number): { passes: number; runs: number } {
  const rows = state.outcomes
    .filter((o) => o.versionId === versionId && nowMs - Date.parse(o.at) <= BASELINE_WINDOW_MS)
    .slice(-BASELINE_MAX_RUNS);
  return { passes: rows.filter((o) => o.passed).length, runs: rows.length };
}

/** The canary as the API shows it: baseline, live pass rate and run count under the canary version. */
export function canaryView(state: HarnessStateV1): HarnessCanaryState | null {
  const c = state.canary;
  if (!c) return null;
  const rows = state.outcomes.filter((o) => o.versionId === c.versionId && Date.parse(o.at) >= Date.parse(c.startedAt));
  const passes = rows.filter((o) => o.passed).length;
  return {
    versionId: c.versionId,
    startedAt: c.startedAt,
    until: c.until,
    baselinePassRate: c.baselinePassRate,
    baselineStandardError: c.baselineStandardError,
    currentPassRate: rows.length === 0 ? null : round4(passes / rows.length),
    runs: rows.length,
  };
}

export type CanaryCheck =
  | { action: 'none' }
  | { action: 'waiting'; versionId: string; runs: number; reason: string }
  | { action: 'promoted'; versionId: string; runs: number; passRate: number }
  | { action: 'rolled-back'; versionId: string; toVersionId: string | null; reason: string };

/**
 * Judge the running canary (pure over `state`, mutates it when it decides):
 *  - ≥ CANARY_MIN_RUNS live runs and pass rate < baseline − 1 SE → roll back
 *    to the version active before adoption (any time, not just at 48 h);
 *  - past `until` with ≥ CANARY_MIN_RUNS runs at or above the line → promote
 *    to `adopted`;
 *  - otherwise wait. With the fleet dark, a canary simply waits — too few runs
 *    is "not measured", not a pass.
 */
export function judgeCanary(state: HarnessStateV1, now: Date): CanaryCheck {
  const c = state.canary;
  if (!c) return { action: 'none' };
  const view = canaryView(state)!;
  const version = state.versions.find((v) => v.id === c.versionId);
  if (!version || state.activeId !== c.versionId) {
    // The canary version is no longer active (rolled back by hand): the canary is over.
    state.canary = null;
    return { action: 'none' };
  }
  const line = c.baselinePassRate !== null && c.baselineStandardError !== null
    ? c.baselinePassRate - HARNESS_ADOPTION_GATE.rollbackStandardErrors * c.baselineStandardError
    : null;
  if (line !== null && view.runs >= CANARY_MIN_RUNS && view.currentPassRate !== null && view.currentPassRate < line) {
    const reason = `canary pass rate ${(view.currentPassRate * 100).toFixed(1)}% over ${view.runs} runs fell below baseline `
      + `${(c.baselinePassRate! * 100).toFixed(1)}% − 1 SE (${(line * 100).toFixed(1)}%)`;
    applyRollback(state, c.fromVersionId, reason, now);
    return { action: 'rolled-back', versionId: c.versionId, toVersionId: c.fromVersionId, reason };
  }
  if (now.getTime() >= Date.parse(c.until)) {
    if (line === null) {
      return { action: 'waiting', versionId: c.versionId, runs: view.runs, reason: 'no baseline pass rate to judge the canary against' };
    }
    if (view.runs >= CANARY_MIN_RUNS) {
      version.status = 'adopted';
      version.canaryUntil = null;
      state.canary = null;
      return { action: 'promoted', versionId: version.id, runs: view.runs, passRate: view.currentPassRate ?? 0 };
    }
    return { action: 'waiting', versionId: c.versionId, runs: view.runs, reason: `canary window elapsed with ${view.runs} of ${CANARY_MIN_RUNS} live runs; waiting for evidence` };
  }
  return { action: 'waiting', versionId: c.versionId, runs: view.runs, reason: 'canary window still open' };
}

/** Config digest of a version id (null / baseline = the compiled defaults). */
function digestOf(state: HarnessStateV1, versionId: string | null): string {
  if (versionId === null || versionId === BASELINE_VERSION_ID) return harnessConfigDigest(BASELINE_HARNESS_CONFIG);
  return state.versions.find((v) => v.id === versionId)?.configDigest ?? '';
}

/** Mark the active version rolled back and make `toVersionId` (null = baseline) active. Mutates `state`. */
function applyRollback(state: HarnessStateV1, toVersionId: string | null, reason: string, now: Date): void {
  const current = state.activeId === null ? null : state.versions.find((v) => v.id === state.activeId) ?? null;
  if (current && current.id !== BASELINE_VERSION_ID) {
    current.status = 'rolled-back';
    current.rolledBackAt = nowIso(now);
    current.rollbackReason = reason.slice(0, MAX_REASON_CHARS);
    current.canaryUntil = null;
  }
  state.activeId = toVersionId === BASELINE_VERSION_ID ? null : toVersionId;
  state.canary = null;
}

/**
 * Check the canary now and act on it (rollback / promotion), recording the
 * decision in the ledger. The daemon calls this each tick; recordHarnessOutcome
 * calls it after every outcome so a failing canary rolls back as soon as the
 * evidence exists. Never throws.
 */
export function checkHarnessCanary(now: Date = new Date()): CanaryCheck {
  let decided: CanaryCheck = { action: 'none' };
  let toDigest = '';
  let experimentId: string | null = null;
  const result = mutateHarnessState((state) => {
    experimentId = state.canary ? state.versions.find((v) => v.id === state.canary!.versionId)?.experimentId ?? null : null;
    decided = judgeCanary(state, now);
    toDigest = digestOf(state, state.activeId);
  });
  if (!result.ok) return { action: 'none' };
  const d = decided as CanaryCheck;
  if (d.action === 'rolled-back') {
    appendHarnessLedger('harness:rolled-back', {
      versionId: d.toVersionId ?? BASELINE_VERSION_ID,
      fromVersionId: d.versionId,
      configDigest: toDigest,
      experimentId,
      reason: d.reason,
    }, 'daemon');
  } else if (d.action === 'promoted') {
    appendHarnessLedger('note', { topic: 'harness:canary-passed', detail: `${d.versionId}: ${d.runs} live runs at ${(d.passRate * 100).toFixed(1)}%` }, 'daemon');
  }
  return d;
}

/**
 * Record one verified fleet run under the harness version it ran with (the
 * active one when `versionId` is omitted; the baseline is `h-0000`). This is
 * the canary's evidence and the next adoption's live baseline. U5 calls it
 * after each verification verdict. Never throws.
 */
export function recordHarnessOutcome(input: { passed: boolean; versionId?: string; at?: Date }): { ok: boolean; canary: CanaryCheck } {
  const at = input.at ?? new Date();
  const result = mutateHarnessState((state) => {
    const versionId = input.versionId ?? state.activeId ?? BASELINE_VERSION_ID;
    if (!state.versions.some((v) => v.id === versionId)) throw new HarnessRefusal(`unknown harness version ${versionId}`);
    state.outcomes.push({ versionId, passed: input.passed === true, at: nowIso(at) });
  });
  if (!result.ok) return { ok: false, canary: { action: 'none' } };
  return { ok: true, canary: checkHarnessCanary(at) };
}

// ---------------------------------------------------------------------------
// Adoption + rollback (frozen contract)
// ---------------------------------------------------------------------------

const ADOPTING_ACTORS: ReadonlySet<HarnessActor> = new Set(['mason', 'leader']);

/**
 * Adopt a candidate that passed the gate; starts its 48 h canary. Refuses
 * (ok: false) when the gate does not hold, when the experiment compared
 * against a version that is no longer active, while another canary runs, or
 * when the ledger cannot record it (fail closed).
 *
 * The Leader reaches this through its class-B `harness.adopt` action (veto
 * window first); Mason may adopt directly. The daemon never adopts.
 */
export function adoptHarness(req: AdoptHarnessRequest, opts: { now?: Date } = {}): HarnessChangeResult {
  const now = opts.now ?? new Date();
  if (!isPlainObject(req) || typeof req.versionId !== 'string' || typeof req.experimentId !== 'string') {
    return { ok: false, reason: 'versionId and experimentId are required' };
  }
  if (!ADOPTING_ACTORS.has(req.actor)) return { ok: false, reason: `${String(req.actor)} may not adopt a harness (Mason or the Leader only)` };

  // Phase 1 (read-only): every check, so a refusal writes nothing — not even
  // a ledger row.
  const state = loadHarnessState();
  const version = state.versions.find((v) => v.id === req.versionId);
  if (!version) return { ok: false, reason: `unknown harness version ${req.versionId}` };
  if (version.status !== 'candidate') return { ok: false, reason: `${version.id} is ${version.status}, not a candidate` };
  const exp = state.experiments.find((e) => e.id === req.experimentId);
  if (!exp) return { ok: false, reason: `unknown experiment ${req.experimentId}` };
  if (exp.candidateVersionId !== version.id) return { ok: false, reason: `experiment ${exp.id} tested ${exp.candidateVersionId}, not ${version.id}` };
  const gate = evaluateAdoptionGate(exp);
  if (!gate.pass) return { ok: false, reason: `the adoption gate does not hold: ${gate.reasons.join('; ')}` };
  const activeId = state.activeId ?? BASELINE_VERSION_ID;
  if (exp.baseVersionId !== activeId) {
    return { ok: false, reason: `experiment ${exp.id} compared against ${exp.baseVersionId}, but ${activeId} is active now; re-run the experiment` };
  }
  if (state.canary) return { ok: false, reason: `a canary is running (${state.canary.versionId} until ${state.canary.until}); wait for it or roll it back` };
  const before = state.activeId === null ? null : state.versions.find((v) => v.id === state.activeId) ?? null;

  // Phase 2: the ledger row first — no row, no adoption.
  const transition = {
    versionId: version.id,
    fromVersionId: state.activeId,
    configDigest: version.configDigest,
    experimentId: exp.id,
    reason: `adopted by ${req.actor}: ${gate.reasons[0] ?? 'gate passed'}`.slice(0, MAX_REASON_CHARS),
  };
  const ledger = appendHarnessLedger('harness:adopted', transition, req.actor);
  if (!ledger.ok) return { ok: false, reason: `not adopted: ${ledger.reason}` };

  // Phase 3: commit, re-checking under the lock (the state may have moved
  // between the read and the lock).
  let after: HarnessVersion | null = null;
  const committed = mutateHarnessState((draft) => {
    const v = draft.versions.find((x) => x.id === version.id);
    if (!v || v.status !== 'candidate') throw new HarnessRefusal(`${version.id} changed while adopting`);
    if ((draft.activeId ?? BASELINE_VERSION_ID) !== activeId) throw new HarnessRefusal('the active version changed while adopting');
    if (draft.canary) throw new HarnessRefusal('a canary started while adopting');
    const nowMs = now.getTime();
    const live = liveBaseline(draft, activeId, nowMs);
    let baselinePassRate: number | null = null;
    let baselineStandardError: number | null = null;
    let baselineRuns = 0;
    let baselineSource: HarnessCanaryRecord['baselineSource'] = 'none';
    if (live.runs >= CANARY_MIN_RUNS) {
      baselinePassRate = round4(live.passes / live.runs);
      baselineStandardError = round4(passRateStandardError(live.passes, live.runs)!);
      baselineRuns = live.runs;
      baselineSource = 'live';
    } else {
      // Too few live runs under the current version (a dark fleet): judge the
      // canary against the experiment's own base arm instead, and say so.
      const basePasses = draft.experimentMeta[exp.id]?.armPasses?.base;
      if (typeof basePasses === 'number' && Number.isInteger(basePasses) && basePasses >= 0 && basePasses <= exp.pairs && exp.pairs > 0) {
        baselinePassRate = round4(basePasses / exp.pairs);
        baselineStandardError = round4(passRateStandardError(basePasses, exp.pairs)!);
        baselineRuns = exp.pairs;
        baselineSource = 'experiment';
      }
    }
    v.status = 'canary';
    v.adoptedAt = nowIso(now);
    v.canaryUntil = new Date(nowMs + HARNESS_ADOPTION_GATE.canaryHours * 3_600_000).toISOString();
    v.experimentId = exp.id;
    draft.activeId = v.id;
    draft.canary = {
      versionId: v.id,
      fromVersionId: activeId === BASELINE_VERSION_ID ? null : activeId,
      startedAt: v.adoptedAt,
      until: v.canaryUntil,
      baselinePassRate,
      baselineStandardError,
      baselineRuns,
      baselineSource,
    };
    after = structuredClone(v);
  });
  if (!committed.ok) {
    // The ledger says adopted but the registry did not change: record the
    // correction so the ledger never claims a harness is in force when it is not.
    appendHarnessLedger('harness:rolled-back', {
      versionId: activeId,
      fromVersionId: version.id,
      configDigest: digestOf(state, activeId),
      experimentId: exp.id,
      reason: `adoption not committed: ${committed.reason}`.slice(0, MAX_REASON_CHARS),
    }, req.actor);
    return { ok: false, reason: committed.reason };
  }
  return { ok: true, before: before ? structuredClone(before) : null, after };
}

/**
 * Make an earlier version (null = baseline) active again — canary failure,
 * a Leader veto of `harness.adopt`, or Mason. Lowering is never blocked: the
 * target must be the baseline or a version that was genuinely adopted (never a
 * candidate — that would be an adoption that skipped the gate), and the ledger
 * row is best-effort.
 */
export function rollbackHarness(req: RollbackHarnessRequest, opts: { now?: Date } = {}): HarnessChangeResult {
  const now = opts.now ?? new Date();
  if (!isPlainObject(req)) return { ok: false, reason: 'invalid rollback request' };
  const toVersionId = req.toVersionId === BASELINE_VERSION_ID ? null : req.toVersionId;
  if (toVersionId !== null && (typeof toVersionId !== 'string' || !VERSION_ID_RE.test(toVersionId))) {
    return { ok: false, reason: 'toVersionId must be a version id or null (baseline)' };
  }
  const reason = scrubSecrets(typeof req.reason === 'string' && req.reason.trim() ? req.reason : 'rolled back').replace(CONTROL_RE_G, ' ').slice(0, MAX_REASON_CHARS);
  let before: HarnessVersion | null = null;
  let after: HarnessVersion | null = null;
  let toDigest = '';
  let fromExperiment: string | null = null;
  const result = mutateHarnessState((state) => {
    const current = state.activeId === null ? null : state.versions.find((v) => v.id === state.activeId) ?? null;
    before = current ? structuredClone(current) : null;
    if (toVersionId !== null) {
      const target = state.versions.find((v) => v.id === toVersionId);
      if (!target) throw new HarnessRefusal(`unknown harness version ${toVersionId}`);
      // Only a version that was adopted (and is not the one being rolled back)
      // may be restored; a candidate or rejected version never passed the gate.
      const restorable = target.adoptedAt !== null && (target.status === 'adopted' || target.status === 'rolled-back' || target.id === state.activeId);
      if (!restorable) throw new HarnessRefusal(`${toVersionId} was never adopted; only the baseline or a previously adopted version can be restored`);
    }
    if ((state.activeId ?? null) === toVersionId) {
      after = before;
      return;
    }
    toDigest = digestOf(state, toVersionId);
    fromExperiment = current?.experimentId ?? null;
    applyRollback(state, toVersionId, reason, now);
    if (toVersionId !== null) {
      const target = state.versions.find((v) => v.id === toVersionId)!;
      // A restored version is the adopted one again (its own canary passed or
      // it was active before this one).
      target.status = 'adopted';
      target.rolledBackAt = null;
      target.rollbackReason = null;
      after = structuredClone(target);
    } else {
      after = null;
    }
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  const b = before as HarnessVersion | null;
  const a = after as HarnessVersion | null;
  if ((b?.id ?? null) !== (a?.id ?? null)) {
    appendHarnessLedger('harness:rolled-back', {
      versionId: a?.id ?? BASELINE_VERSION_ID,
      fromVersionId: b?.id ?? null,
      configDigest: toDigest,
      experimentId: fromExperiment,
      reason: `${req.actor}: ${reason}`.slice(0, MAX_REASON_CHARS),
    }, req.actor);
  }
  return { ok: true, before: b, after: a };
}

// ---------------------------------------------------------------------------
// Learning state (the API's GET)
// ---------------------------------------------------------------------------

/** LearningStateV1 for the Growth surface. Pure over the stored state; no writes. */
export function buildLearningState(now: Date = new Date(), state: HarnessStateV1 = loadHarnessState()): LearningStateV1 {
  const active = state.activeId === null ? null : state.versions.find((v) => v.id === state.activeId) ?? null;
  return {
    v: 1,
    generatedAt: now.toISOString(),
    active,
    canary: canaryView(state),
    versions: [...state.versions].sort((a, b) => a.seq - b.seq),
    experiments: [...state.experiments].reverse().map(stripExperimentInternals),
    hypotheses: [...state.hypotheses],
  };
}

/** The wire shape: the frozen ExperimentResultV1 fields only. */
export function stripExperimentInternals(exp: ExperimentResultV1): ExperimentResultV1 {
  return {
    v: 1,
    id: exp.id,
    hypothesisId: exp.hypothesisId,
    baseVersionId: exp.baseVersionId,
    candidateVersionId: exp.candidateVersionId,
    taskSet: { ...exp.taskSet },
    status: exp.status,
    pairs: exp.pairs,
    wins: exp.wins,
    losses: exp.losses,
    ties: exp.ties,
    lift: exp.lift ? { ...exp.lift } : null,
    refuseRegression: exp.refuseRegression,
    claimedChangeNoneMadeDelta: exp.claimedChangeNoneMadeDelta,
    costDeltaPct: exp.costDeltaPct,
    verdict: exp.verdict,
    reasons: [...exp.reasons],
    startedAt: exp.startedAt,
    finishedAt: exp.finishedAt,
  };
}

/** This process's identity for experiment runner leases. */
export function runnerIdentity(): { pid: number; host: string } {
  return { pid: process.pid, host: hostname() };
}

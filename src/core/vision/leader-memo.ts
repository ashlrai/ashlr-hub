/**
 * Leader memo — parsing, validation and persistence (V3.10 Track B unit U8).
 *
 * The Leader ("Visionary" persona) is a model call. Everything it returns is
 * UNTRUSTED model output, so this module is the one gate between that text
 * and anything the Leader can do:
 *
 *   - PARSING FAILS CLOSED. Output that is not one JSON object, or that lacks
 *     the two things a memo exists for (the bottleneck and the move), becomes
 *     a `parse-failed` memo with NO actions. There is no "best effort"
 *     recovery of actions from prose.
 *   - Every action is re-validated field by field against an exact per-kind
 *     schema (unknown keys, wrong types, out-of-range values → the action is
 *     dropped, and the drop is noted). A dropped action is never "repaired".
 *   - Every free-text field is scrubbed (secrets, home paths, emails) and
 *     length-capped before it is stored or shown; it is rendered as plain text
 *     and never replayed to a worker as an instruction.
 *
 * Classifying actions (A / B / C) is NOT done here — that is the pure policy
 * check in leader-apply.ts, which needs the grant. This module only turns text
 * into well-formed drafts.
 *
 * Persistence: one 0600 JSON file per memo under ~/.ashlr/vision/leader/memos/
 * (0700), newest MEMO_KEEP kept. Paths re-resolve homedir() per call so a
 * relocated HOME (tests) is always honoured.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, unlinkSync } from 'node:fs';

import { scrubPrivateText } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { BUDGET_MODES, type BudgetMode, type RoutingDifficulty } from '../routing/types.js';
import type { FleetTaskInput } from '../fleet/fleet-types.js';
import type {
  HarnessConfigPatch,
  HarnessEffort,
  HarnessHypothesis,
  HarnessRole,
  HarnessRoutingWeights,
  HarnessSampling,
  HarnessTarget,
} from '../learn/harness-types.js';
import {
  LEADER_ACTION_KINDS,
  LEADER_LIMITS,
  type LeaderActionKind,
  type LeaderActionParamsMap,
  type LeaderExpectedDelta,
  type LeaderGoalProposal,
  type LeaderMemo,
  type LeaderMemoSummary,
  type LeaderOutcomeRecord,
} from './leader-types.js';

// ---------------------------------------------------------------------------
// Limits and vocabulary
// ---------------------------------------------------------------------------

/**
 * Metrics a move may promise to change. A closed vocabulary because the
 * 7-day grade has to MEASURE the metric: a move that names anything else is
 * kept, but graded `hit: null` (ungradeable) — the Leader cannot score itself
 * on a metric nobody can read back. (north-star's leverage score is NOT here:
 * it is held at 0 until post-merge credit has a verifier, so grading against
 * it would be grading against a constant.)
 */
export const LEADER_METRICS = [
  'fleet-merges-7d',
  'fleet-reverts-7d',
  'post-merge-green-pct-7d',
  'active-goals',
  'proposals-7d',
] as const;
export type LeaderMetric = (typeof LEADER_METRICS)[number];

export function isLeaderMetric(value: unknown): value is LeaderMetric {
  return typeof value === 'string' && (LEADER_METRICS as readonly string[]).includes(value);
}

/** Structural caps on one memo (blast radius of a malformed or hostile output). */
export const LEADER_MEMO_CAPS = Object.freeze({
  maxRawChars: 256 * 1024,
  maxActions: 24,
  maxKillList: 10,
  maxPriorityChanges: 24,
  maxStandards: 5,
  maxCritiques: 10,
  maxSeatPlan: 8,
  maxQuestions: 5,
  maxEvidence: 6,
  maxAcceptance: 5,
  maxReorder: 10,
  /** Longest a move may take to pay off (byDate) — the grade happens at byDate. */
  maxHorizonDays: 30,
});

/**
 * Router tuning bounds the Leader may set (class A "within bounds"). The
 * dispatch router (U5) re-clamps anything it reads, so these are the Leader's
 * own ceiling, not the only one.
 */
export const LEADER_ROUTER_TUNING_BOUNDS = Object.freeze({ lambdaMin: 0, lambdaMax: 10 });

const TEXT = Object.freeze({
  short: 160,
  line: 300,
  statement: 400,
  why: 600,
  detail: 2_000,
  prompt: 4_096,
});

const GOAL_ID_RE = /^[\w.-]{1,200}$/;
const NAME_WITH_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SEAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const VERSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const DIFFICULTIES: readonly RoutingDifficulty[] = ['low', 'medium', 'high'];
const HARNESS_TARGETS: readonly HarnessTarget[] = ['prompt', 'effort', 'sampling', 'routing', 'skill'];
const HARNESS_ROLES: readonly HarnessRole[] = ['producer', 'judge', 'leader', 'planner'];
const HARNESS_EFFORTS: readonly HarnessEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const FLEET_ENGINE_KEYS = ['local', 'grok-cli', 'claude-cli', 'codex'] as const;

// ---------------------------------------------------------------------------
// Small total helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exactly these keys (optional ones may be absent), nothing else. */
function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  for (const key of required) if (!(key in value)) return false;
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) return false;
  return true;
}

/**
 * Scrub + normalise one piece of model text: secrets, home paths and emails
 * out, control characters (except newline/tab) removed, whitespace trimmed,
 * then capped. Null when nothing is left.
 */
export function cleanModelText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const stripped = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/g, ' ').trim();
  if (stripped.length === 0) return null;
  const scrubbed = scrubPrivateText(stripped.slice(0, max * 2), { emails: true }).trim();
  if (scrubbed.length === 0) return null;
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

function cleanList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= maxItems) break;
    const text = cleanModelText(entry, maxChars);
    if (text) out.push(text);
  }
  return out;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// JSON extraction — one object or nothing
// ---------------------------------------------------------------------------

/**
 * The single JSON object in a model reply: the whole reply, the body of ONE
 * ```json fence, or the outermost balanced {...} when the reply is that object
 * wrapped in prose. Anything ambiguous (two fences, trailing junk that breaks
 * the parse) yields null — parsing fails closed rather than guessing which of
 * two objects the model "meant".
 */
export function extractMemoJson(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LEADER_MEMO_CAPS.maxRawChars) return null;
  const attempt = (text: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const whole = attempt(raw.trim());
  if (whole) return whole;
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length === 1) {
    const fenced = attempt(fences[0]![1]!.trim());
    if (fenced) return fenced;
  }
  if (fences.length > 1) return null;
  // Outermost balanced object, string-aware so braces inside strings do not count.
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const rest = raw.slice(i + 1);
        // A second object after the first is ambiguous — refuse.
        if (rest.includes('{')) return null;
        return attempt(raw.slice(start, i + 1));
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-kind action parameter validation (exact shapes)
// ---------------------------------------------------------------------------

type ParamResult<K extends LeaderActionKind> = { ok: true; params: LeaderActionParamsMap[K] } | { ok: false; reason: string };

function nullableIso(value: unknown): value is string | null {
  return value === null || isIsoDate(value);
}

function parseGoalProposal(value: unknown): LeaderGoalProposal | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['objective'], ['rationale', 'targetRepo', 'deliverable', 'acceptanceEvidence'])) return null;
  const objective = cleanModelText(value['objective'], TEXT.line);
  if (!objective) return null;
  const targetRepo = value['targetRepo'] ?? null;
  if (targetRepo !== null && (typeof targetRepo !== 'string' || !NAME_WITH_OWNER_RE.test(targetRepo))) return null;
  return {
    objective,
    rationale: cleanModelText(value['rationale'], TEXT.why) ?? '',
    targetRepo,
    deliverable: cleanModelText(value['deliverable'], TEXT.statement),
    acceptanceEvidence: cleanList(value['acceptanceEvidence'], LEADER_MEMO_CAPS.maxAcceptance, TEXT.line),
  };
}

function parseTaskInput(value: unknown): FleetTaskInput | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['repo', 'title', 'difficulty', 'value'], ['detail', 'goalId'])) return null;
  const repo = value['repo'];
  if (typeof repo !== 'string' || !NAME_WITH_OWNER_RE.test(repo)) return null;
  const title = cleanModelText(value['title'], 120);
  if (!title) return null;
  const difficulty = value['difficulty'];
  if (typeof difficulty !== 'string' || !(DIFFICULTIES as readonly string[]).includes(difficulty)) return null;
  const taskValue = value['value'];
  if (!Number.isInteger(taskValue) || (taskValue as number) < 1 || (taskValue as number) > 5) return null;
  const goalId = value['goalId'] ?? null;
  if (goalId !== null && (typeof goalId !== 'string' || !GOAL_ID_RE.test(goalId))) return null;
  // `source` and `requestedBy` are FORCED, never taken from the model: a task
  // the Leader dispatches is always attributed to the Leader.
  return {
    repo,
    source: 'leader',
    title,
    detail: cleanModelText(value['detail'], TEXT.detail) ?? '',
    difficulty: difficulty as RoutingDifficulty,
    value: taskValue as number,
    requestedBy: 'leader',
    goalId,
    dedupeKey: null,
  };
}

function parseRouterTuning(value: unknown): Partial<HarnessRoutingWeights> | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  const out: Partial<HarnessRoutingWeights> = {};
  for (const key of keys) {
    const entry = value[key];
    if (key === 'lambdaCost' || key === 'lambdaPressure' || key === 'lambdaLatency') {
      if (!finiteNumber(entry) || entry < LEADER_ROUTER_TUNING_BOUNDS.lambdaMin || entry > LEADER_ROUTER_TUNING_BOUNDS.lambdaMax) {
        return null;
      }
      out[key] = entry;
    } else if (key === 'bonThreshold') {
      if (typeof entry !== 'string' || !(DIFFICULTIES as readonly string[]).includes(entry)) return null;
      out.bonThreshold = entry as RoutingDifficulty;
    } else {
      return null;
    }
  }
  return out;
}

function parseSampling(value: unknown): HarnessSampling | null {
  if (!isRecord(value) || !hasExactKeys(value, ['temperature', 'topP', 'maxOutputTokens'])) return null;
  const t = value['temperature'];
  const p = value['topP'];
  const m = value['maxOutputTokens'];
  if (t !== null && (!finiteNumber(t) || t < 0 || t > 2)) return null;
  if (p !== null && (!finiteNumber(p) || p <= 0 || p > 1)) return null;
  if (m !== null && (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 1_000_000)) return null;
  return { temperature: t as number | null, topP: p as number | null, maxOutputTokens: m as number | null };
}

/**
 * A harness patch is CONFIG ONLY (SPEC-310B §5): prompt overlays, effort,
 * sampling, routing weights, skill ids. Anything else — and in particular
 * anything shaped like code or a path — is refused here, and U9 re-validates.
 */
export function parseHarnessPatch(value: unknown): HarnessConfigPatch | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  const out: HarnessConfigPatch = {};
  for (const key of keys) {
    const entry = value[key];
    switch (key) {
      case 'prompts': {
        if (!isRecord(entry)) return null;
        const prompts: Partial<Record<HarnessRole, string>> = {};
        for (const [role, text] of Object.entries(entry)) {
          if (!(HARNESS_ROLES as readonly string[]).includes(role)) return null;
          const clean = cleanModelText(text, TEXT.prompt);
          if (!clean) return null;
          prompts[role as HarnessRole] = clean;
        }
        out.prompts = prompts;
        break;
      }
      case 'effort': {
        if (!isRecord(entry)) return null;
        const effort: Partial<Record<(typeof FLEET_ENGINE_KEYS)[number], HarnessEffort>> = {};
        for (const [engine, level] of Object.entries(entry)) {
          if (!(FLEET_ENGINE_KEYS as readonly string[]).includes(engine)) return null;
          if (typeof level !== 'string' || !(HARNESS_EFFORTS as readonly string[]).includes(level)) return null;
          effort[engine as (typeof FLEET_ENGINE_KEYS)[number]] = level as HarnessEffort;
        }
        out.effort = effort;
        break;
      }
      case 'sampling': {
        if (!isRecord(entry)) return null;
        const sampling: Partial<Record<(typeof FLEET_ENGINE_KEYS)[number], HarnessSampling>> = {};
        for (const [engine, raw] of Object.entries(entry)) {
          if (!(FLEET_ENGINE_KEYS as readonly string[]).includes(engine)) return null;
          const parsed = parseSampling(raw);
          if (!parsed) return null;
          sampling[engine as (typeof FLEET_ENGINE_KEYS)[number]] = parsed;
        }
        out.sampling = sampling;
        break;
      }
      case 'routing': {
        const tuning = parseRouterTuning(entry);
        if (!tuning || !hasExactKeys(entry as Record<string, unknown>, ['lambdaCost', 'lambdaPressure', 'lambdaLatency', 'bonThreshold'])) {
          return null;
        }
        out.routing = tuning as HarnessRoutingWeights;
        break;
      }
      case 'skills': {
        if (!Array.isArray(entry) || entry.length > 32) return null;
        const skills: string[] = [];
        for (const id of entry) {
          if (typeof id !== 'string' || !VERSION_ID_RE.test(id)) return null;
          skills.push(id);
        }
        out.skills = [...new Set(skills)].sort();
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

/** Validate one action's params against its kind's exact schema. */
export function parseActionParams<K extends LeaderActionKind>(kind: K, raw: unknown): ParamResult<K> {
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (!isRecord(raw)) return fail('params must be an object');
  const done = (params: LeaderActionParamsMap[LeaderActionKind]): ParamResult<K> =>
    ({ ok: true, params: params as LeaderActionParamsMap[K] });
  switch (kind) {
    case 'goal.focus':
    case 'goal.archive': {
      if (!hasExactKeys(raw, ['goalId'])) return fail('expected {goalId}');
      const goalId = raw['goalId'];
      if (typeof goalId !== 'string' || !GOAL_ID_RE.test(goalId)) return fail('goalId is not a goal id');
      return done({ goalId });
    }
    case 'goal.pause': {
      if (!hasExactKeys(raw, ['goalId'], ['until'])) return fail('expected {goalId, until?}');
      const goalId = raw['goalId'];
      const until = raw['until'] ?? null;
      if (typeof goalId !== 'string' || !GOAL_ID_RE.test(goalId)) return fail('goalId is not a goal id');
      if (!nullableIso(until)) return fail('until must be an ISO time or null');
      return done({ goalId, until: until === null ? null : new Date(Date.parse(until)).toISOString() });
    }
    case 'goal.reorder': {
      if (!hasExactKeys(raw, ['goalIds'])) return fail('expected {goalIds}');
      const ids = raw['goalIds'];
      if (!Array.isArray(ids) || ids.length < 2 || ids.length > LEADER_MEMO_CAPS.maxReorder) {
        return fail(`goalIds must list 2–${LEADER_MEMO_CAPS.maxReorder} goals`);
      }
      if (!ids.every((id) => typeof id === 'string' && GOAL_ID_RE.test(id))) return fail('goalIds must be goal ids');
      if (new Set(ids).size !== ids.length) return fail('goalIds must not repeat');
      return done({ goalIds: ids as string[] });
    }
    case 'goal.create': {
      if (!hasExactKeys(raw, ['goal'])) return fail('expected {goal}');
      const goal = parseGoalProposal(raw['goal']);
      return goal ? done({ goal }) : fail('goal is malformed');
    }
    case 'work.dispatch': {
      if (!hasExactKeys(raw, ['task'])) return fail('expected {task}');
      const task = parseTaskInput(raw['task']);
      return task ? done({ task }) : fail('task is malformed');
    }
    case 'standard.add': {
      if (!hasExactKeys(raw, ['rule', 'appliesTo'], ['evidence'])) return fail('expected {rule, appliesTo, evidence?}');
      const rule = cleanModelText(raw['rule'], TEXT.line);
      const appliesTo = cleanModelText(raw['appliesTo'], 80);
      if (!rule || !appliesTo) return fail('rule and appliesTo are required');
      return done({ rule, appliesTo, evidence: cleanModelText(raw['evidence'], TEXT.line) });
    }
    case 'router.tune': {
      if (!hasExactKeys(raw, ['tuning'])) return fail('expected {tuning}');
      const tuning = parseRouterTuning(raw['tuning']);
      return tuning
        ? done({ tuning })
        : fail(`tuning must set lambdaCost / lambdaPressure / lambdaLatency within ${LEADER_ROUTER_TUNING_BOUNDS.lambdaMin}–${LEADER_ROUTER_TUNING_BOUNDS.lambdaMax} or bonThreshold`);
    }
    case 'experiment.start': {
      if (!hasExactKeys(raw, ['hypothesisId'])) return fail('expected {hypothesisId}');
      const id = raw['hypothesisId'];
      if (typeof id !== 'string' || !VERSION_ID_RE.test(id)) return fail('hypothesisId is malformed');
      return done({ hypothesisId: id });
    }
    case 'repo.pause': {
      if (!hasExactKeys(raw, ['repo', 'reason'], ['until'])) return fail('expected {repo, reason, until?}');
      const repo = raw['repo'];
      const until = raw['until'] ?? null;
      const reason = cleanModelText(raw['reason'], TEXT.line);
      if (typeof repo !== 'string' || !NAME_WITH_OWNER_RE.test(repo)) return fail('repo must be owner/name');
      if (!reason) return fail('reason is required');
      if (!nullableIso(until)) return fail('until must be an ISO time or null');
      return done({ repo, reason, until: until === null ? null : new Date(Date.parse(until)).toISOString() });
    }
    case 'repo.resume': {
      if (!hasExactKeys(raw, ['repo'])) return fail('expected {repo}');
      const repo = raw['repo'];
      if (typeof repo !== 'string' || !NAME_WITH_OWNER_RE.test(repo)) return fail('repo must be owner/name');
      return done({ repo });
    }
    case 'pr.close': {
      if (!hasExactKeys(raw, ['repo', 'number', 'reason'])) return fail('expected {repo, number, reason}');
      const repo = raw['repo'];
      const number = raw['number'];
      const reason = cleanModelText(raw['reason'], TEXT.line);
      if (typeof repo !== 'string' || !NAME_WITH_OWNER_RE.test(repo)) return fail('repo must be owner/name');
      if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > 10_000_000) return fail('number must be a PR number');
      if (!reason) return fail('reason is required');
      return done({ repo, number: number as number, reason });
    }
    case 'budget.mode': {
      if (!hasExactKeys(raw, ['to'])) return fail('expected {to}');
      const to = raw['to'];
      if (typeof to !== 'string' || !(BUDGET_MODES as readonly string[]).includes(to)) return fail('to must be a budget mode');
      return done({ to: to as BudgetMode });
    }
    case 'lanes.grok': {
      if (!hasExactKeys(raw, ['slots'])) return fail('expected {slots}');
      const slots = raw['slots'];
      if (!Number.isInteger(slots) || (slots as number) < LEADER_LIMITS.grokLanes.min || (slots as number) > LEADER_LIMITS.grokLanes.max) {
        return fail(`slots must be ${LEADER_LIMITS.grokLanes.min}–${LEADER_LIMITS.grokLanes.max}`);
      }
      return done({ slots: slots as number });
    }
    case 'lanes.codex': {
      if (!hasExactKeys(raw, ['enabled'])) return fail('expected {enabled}');
      if (typeof raw['enabled'] !== 'boolean') return fail('enabled must be true or false');
      return done({ enabled: raw['enabled'] });
    }
    case 'harness.adopt': {
      if (!hasExactKeys(raw, ['versionId', 'experimentId'])) return fail('expected {versionId, experimentId}');
      const versionId = raw['versionId'];
      const experimentId = raw['experimentId'];
      if (typeof versionId !== 'string' || !VERSION_ID_RE.test(versionId)) return fail('versionId is malformed');
      if (typeof experimentId !== 'string' || !VERSION_ID_RE.test(experimentId)) return fail('experimentId is malformed');
      return done({ versionId, experimentId });
    }
    case 'escalate': {
      if (!hasExactKeys(raw, ['request', 'argument'])) return fail('expected {request, argument}');
      const request = cleanModelText(raw['request'], TEXT.line);
      const argument = cleanModelText(raw['argument'], TEXT.why);
      if (!request || !argument) return fail('request and argument are required');
      return done({ request, argument });
    }
    default:
      return fail('unknown action kind');
  }
}

// ---------------------------------------------------------------------------
// Memo drafts
// ---------------------------------------------------------------------------

/** An action as the model proposed it — class, status and times are decided by leader-apply. */
export interface LeaderActionDraft<K extends LeaderActionKind = LeaderActionKind> {
  kind: K;
  params: LeaderActionParamsMap[K];
  summary: string;
  why: string;
}

export type AnyLeaderActionDraft = { [K in LeaderActionKind]: LeaderActionDraft<K> }[LeaderActionKind];

/** A hypothesis before it has an id and a timestamp. */
export type LeaderHypothesisDraft = Omit<HarnessHypothesis, 'v' | 'id' | 'source' | 'createdAt'>;

/** The validated content of a memo — every field of LeaderMemo the model supplies. */
export interface LeaderMemoDraft {
  bottleneck: NonNullable<LeaderMemo['bottleneck']>;
  move: NonNullable<LeaderMemo['move']>;
  killList: LeaderMemo['killList'];
  goals: LeaderGoalProposal[];
  priorityChanges: LeaderMemo['priorityChanges'];
  standards: LeaderMemo['standards'];
  critiques: LeaderMemo['critiques'];
  seatPlan: LeaderMemo['seatPlan'];
  hypotheses: LeaderHypothesisDraft[];
  questionsForMason: string[];
  actions: AnyLeaderActionDraft[];
  /** Plain sentences about what was dropped or truncated (never model text). */
  notes: string[];
}

export type LeaderMemoParseResult = { ok: true; draft: LeaderMemoDraft } | { ok: false; reason: string };

export interface LeaderMemoParseOptions {
  nowMs: number;
}

function parseExpectedDelta(value: unknown, nowMs: number, notes: string[]): LeaderExpectedDelta | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    notes.push('move.expectedDelta was not an object and was dropped');
    return null;
  }
  const metric = cleanModelText(value['metric'], 80);
  const delta = value['delta'];
  const byDate = value['byDate'];
  if (!metric || !finiteNumber(delta) || !isIsoDate(byDate)) {
    notes.push('move.expectedDelta was malformed and was dropped');
    return null;
  }
  const byMs = Date.parse(byDate);
  if (byMs <= nowMs || byMs > nowMs + LEADER_MEMO_CAPS.maxHorizonDays * 86_400_000) {
    notes.push(`move.expectedDelta.byDate must be within ${LEADER_MEMO_CAPS.maxHorizonDays} days and was dropped`);
    return null;
  }
  if (!isLeaderMetric(metric)) notes.push(`move metric "${metric}" is not measurable; its outcome will be ungradeable`);
  return { metric, delta, byDate: new Date(byMs).toISOString() };
}

function parseHypothesis(value: unknown): LeaderHypothesisDraft | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ['target', 'patch', 'statement', 'metric', 'predictedDelta'])) return null;
  const target = value['target'];
  if (typeof target !== 'string' || !(HARNESS_TARGETS as readonly string[]).includes(target)) return null;
  const patch = parseHarnessPatch(value['patch']);
  const statement = cleanModelText(value['statement'], TEXT.statement);
  const metric = cleanModelText(value['metric'], 80);
  const predicted = value['predictedDelta'];
  if (!patch || !statement || !metric || !finiteNumber(predicted)) return null;
  return { target: target as HarnessTarget, patch, statement, metric, predictedDelta: predicted };
}

function actionKey(draft: { kind: LeaderActionKind; params: unknown }): string {
  return `${draft.kind}\u0000${JSON.stringify(draft.params)}`;
}

function defaultSummary(kind: LeaderActionKind, params: LeaderActionParamsMap[LeaderActionKind]): string {
  const p = params as unknown as Record<string, unknown>;
  switch (kind) {
    case 'goal.focus': return `Focus goal ${String(p['goalId'])}`;
    case 'goal.pause': return `Pause goal ${String(p['goalId'])}`;
    case 'goal.archive': return `Archive goal ${String(p['goalId'])}`;
    case 'goal.reorder': return `Reorder ${(p['goalIds'] as string[]).length} goals`;
    case 'goal.create': return `New goal: ${(p['goal'] as LeaderGoalProposal).objective}`;
    case 'work.dispatch': return `Dispatch: ${(p['task'] as FleetTaskInput).title}`;
    case 'standard.add': return `Add standard: ${String(p['rule'])}`;
    case 'router.tune': return 'Tune dispatch routing weights';
    case 'experiment.start': return `Start experiment for ${String(p['hypothesisId'])}`;
    case 'repo.pause': return `Pause ${String(p['repo'])}`;
    case 'repo.resume': return `Resume ${String(p['repo'])}`;
    case 'pr.close': return `Close ${String(p['repo'])}#${String(p['number'])}`;
    case 'budget.mode': return `Budget mode → ${String(p['to'])}`;
    case 'lanes.grok': return `Grok lanes → ${String(p['slots'])}`;
    case 'lanes.codex': return p['enabled'] === true ? 'Enable Codex lanes' : 'Turn Codex lanes off';
    case 'harness.adopt': return `Adopt harness ${String(p['versionId'])}`;
    case 'escalate': return `Needs Mason: ${String(p['request'])}`;
    default: return kind;
  }
}

function makeDraft<K extends LeaderActionKind>(
  kind: K,
  params: LeaderActionParamsMap[K],
  summary: string | null,
  why: string | null,
): LeaderActionDraft<K> {
  const cleanSummary = summary ?? defaultSummary(kind, params);
  return {
    kind,
    params,
    summary: cleanModelText(cleanSummary, TEXT.short) ?? kind,
    why: why ?? '',
  };
}

/**
 * Parse a model reply into a validated memo draft. Fails closed: anything
 * that is not a single object with a usable bottleneck and move is refused
 * outright, with no actions.
 *
 * Actions come from two places and are merged (deduplicated on kind+params):
 *   1. the model's explicit `actions` list — each validated against its kind;
 *   2. COMPILED from the memo's own sections, so what the memo says and what
 *      the Leader does cannot drift: every `goals` entry becomes goal.create,
 *      every `standards` entry standard.add, every hypothesis experiment.start
 *      (ids assigned by the caller), and every priorityChange of focus /
 *      pause / archive the matching goal action.
 */
export function parseLeaderMemoOutput(raw: string, opts: LeaderMemoParseOptions): LeaderMemoParseResult {
  const obj = extractMemoJson(raw);
  if (!obj) return { ok: false, reason: 'the model reply was not one JSON object' };
  const notes: string[] = [];

  const bottleneckRaw = obj['bottleneck'];
  const moveRaw = obj['move'];
  if (!isRecord(bottleneckRaw)) return { ok: false, reason: 'the memo has no bottleneck' };
  if (!isRecord(moveRaw)) return { ok: false, reason: 'the memo has no move' };
  const bottleneckStatement = cleanModelText(bottleneckRaw['statement'], TEXT.statement);
  const moveStatement = cleanModelText(moveRaw['statement'], TEXT.statement);
  if (!bottleneckStatement) return { ok: false, reason: 'the bottleneck has no statement' };
  if (!moveStatement) return { ok: false, reason: 'the move has no statement' };

  // Arrays that are present must be arrays; a wrong type is a malformed memo.
  for (const key of ['killList', 'goals', 'priorityChanges', 'standards', 'critiques', 'seatPlan', 'hypotheses', 'questionsForMason', 'actions']) {
    if (key in obj && obj[key] !== null && !Array.isArray(obj[key])) {
      return { ok: false, reason: `${key} must be a list` };
    }
  }
  const list = (key: string): unknown[] => (Array.isArray(obj[key]) ? (obj[key] as unknown[]) : []);

  const bottleneck: LeaderMemoDraft['bottleneck'] = {
    statement: bottleneckStatement,
    metric: cleanModelText(bottleneckRaw['metric'], 80),
    evidence: cleanList(bottleneckRaw['evidence'], LEADER_MEMO_CAPS.maxEvidence, TEXT.line),
  };
  const move: LeaderMemoDraft['move'] = {
    statement: moveStatement,
    why: cleanModelText(moveRaw['why'], TEXT.why) ?? '',
    expectedDelta: parseExpectedDelta(moveRaw['expectedDelta'], opts.nowMs, notes),
  };

  const killList: LeaderMemoDraft['killList'] = [];
  for (const entry of list('killList')) {
    if (killList.length >= LEADER_MEMO_CAPS.maxKillList) break;
    if (!isRecord(entry) || !isRecord(entry['target'])) continue;
    const kind = entry['target']['kind'];
    const id = cleanModelText(entry['target']['id'], 200);
    if ((kind !== 'goal' && kind !== 'pr' && kind !== 'lane' && kind !== 'experiment') || !id) continue;
    killList.push({ target: { kind, id }, why: cleanModelText(entry['why'], TEXT.why) ?? '' });
  }

  const goals: LeaderGoalProposal[] = [];
  const rawGoals = list('goals');
  for (const entry of rawGoals) {
    const goal = parseGoalProposal(entry);
    if (!goal) {
      notes.push('a malformed goal proposal was dropped');
      continue;
    }
    if (goals.length >= LEADER_LIMITS.maxGoalsPerMemo) {
      notes.push(`only ${LEADER_LIMITS.maxGoalsPerMemo} goals are allowed per memo; extras were dropped`);
      break;
    }
    goals.push(goal);
  }

  const priorityChanges: LeaderMemoDraft['priorityChanges'] = [];
  for (const entry of list('priorityChanges')) {
    if (priorityChanges.length >= LEADER_MEMO_CAPS.maxPriorityChanges) break;
    if (!isRecord(entry)) continue;
    const goalId = entry['goalId'];
    const action = entry['action'];
    if (typeof goalId !== 'string' || !GOAL_ID_RE.test(goalId)) continue;
    if (action !== 'focus' && action !== 'pause' && action !== 'archive' && action !== 'reorder') continue;
    priorityChanges.push({ goalId, action, why: cleanModelText(entry['why'], TEXT.why) ?? '' });
  }

  const standards: LeaderMemoDraft['standards'] = [];
  for (const entry of list('standards')) {
    if (standards.length >= LEADER_MEMO_CAPS.maxStandards) break;
    if (!isRecord(entry)) continue;
    const rule = cleanModelText(entry['rule'], TEXT.line);
    const appliesTo = cleanModelText(entry['appliesTo'], 80);
    if (!rule || !appliesTo) continue;
    standards.push({ rule, appliesTo, evidence: cleanModelText(entry['evidence'], TEXT.line) });
  }

  const critiques: LeaderMemoDraft['critiques'] = [];
  for (const entry of list('critiques')) {
    if (critiques.length >= LEADER_MEMO_CAPS.maxCritiques) break;
    if (!isRecord(entry)) continue;
    const subject = cleanModelText(entry['subject'], 200);
    const standard = cleanModelText(entry['standard'], TEXT.line);
    const finding = cleanModelText(entry['finding'], TEXT.statement);
    if (!subject || !standard || !finding) continue;
    critiques.push({ subject, standard, finding, evidenceRef: cleanModelText(entry['evidenceRef'], 200) });
  }

  const seatPlan: LeaderMemoDraft['seatPlan'] = [];
  for (const entry of list('seatPlan')) {
    if (seatPlan.length >= LEADER_MEMO_CAPS.maxSeatPlan) break;
    if (!isRecord(entry)) continue;
    const role = entry['role'];
    const seatId = entry['seatId'];
    const share = entry['share'];
    if (role !== 'producer' && role !== 'judge' && role !== 'leader') continue;
    if (typeof seatId !== 'string' || !SEAT_ID_RE.test(seatId)) continue;
    if (!finiteNumber(share) || share < 0 || share > 1) continue;
    seatPlan.push({ role, seatId, share, rationale: cleanModelText(entry['rationale'], TEXT.line) ?? '' });
  }

  const hypotheses: LeaderHypothesisDraft[] = [];
  for (const entry of list('hypotheses')) {
    const hypothesis = parseHypothesis(entry);
    if (!hypothesis) {
      notes.push('a malformed hypothesis was dropped (hypotheses are config-only)');
      continue;
    }
    if (hypotheses.length >= LEADER_LIMITS.maxHypothesesPerMemo) {
      notes.push(`only ${LEADER_LIMITS.maxHypothesesPerMemo} hypotheses are allowed per memo; extras were dropped`);
      break;
    }
    hypotheses.push(hypothesis);
  }

  const questionsForMason = cleanList(obj['questionsForMason'], LEADER_MEMO_CAPS.maxQuestions, TEXT.line);

  // ---- actions: explicit, then compiled from the sections ----------------
  const actions: AnyLeaderActionDraft[] = [];
  const seen = new Set<string>();
  const push = (draft: AnyLeaderActionDraft): void => {
    const key = actionKey(draft);
    if (seen.has(key)) return;
    if (actions.length >= LEADER_MEMO_CAPS.maxActions) {
      if (!notes.includes('action limit reached; extras were dropped')) notes.push('action limit reached; extras were dropped');
      return;
    }
    seen.add(key);
    actions.push(draft);
  };

  let droppedActions = 0;
  for (const entry of list('actions')) {
    if (!isRecord(entry) || typeof entry['kind'] !== 'string' || !(LEADER_ACTION_KINDS as readonly string[]).includes(entry['kind'])) {
      droppedActions += 1;
      continue;
    }
    const kind = entry['kind'] as LeaderActionKind;
    // experiment.start is compiled from the memo's own hypotheses (the model
    // cannot know the ids they will get), so an explicit one is not trusted.
    if (kind === 'experiment.start') {
      droppedActions += 1;
      continue;
    }
    const params = parseActionParams(kind, entry['params']);
    if (!params.ok) {
      droppedActions += 1;
      continue;
    }
    push(makeDraft(kind, params.params, cleanModelText(entry['summary'], TEXT.short), cleanModelText(entry['why'], TEXT.why)) as AnyLeaderActionDraft);
  }
  if (droppedActions > 0) notes.push(`${droppedActions} malformed or unknown action${droppedActions === 1 ? ' was' : 's were'} dropped`);

  for (const change of priorityChanges) {
    if (change.action === 'reorder') continue; // needs a full order — only an explicit goal.reorder action can say it
    const kind = change.action === 'focus' ? 'goal.focus' : change.action === 'pause' ? 'goal.pause' : 'goal.archive';
    const params = kind === 'goal.pause' ? { goalId: change.goalId, until: null } : { goalId: change.goalId };
    push(makeDraft(kind, params as never, null, change.why || null) as AnyLeaderActionDraft);
  }
  for (const goal of goals) push(makeDraft('goal.create', { goal }, null, goal.rationale || null));
  for (const standard of standards) {
    push(makeDraft('standard.add', { rule: standard.rule, appliesTo: standard.appliesTo, evidence: standard.evidence }, null, null));
  }

  return {
    ok: true,
    draft: {
      bottleneck,
      move,
      killList,
      goals,
      priorityChanges,
      standards,
      critiques,
      seatPlan,
      hypotheses,
      questionsForMason,
      actions,
      notes,
    },
  };
}

/** The schema the Leader prompt shows the model — kept next to the parser so they cannot drift. */
export const LEADER_MEMO_SCHEMA_TEXT = `{
  "bottleneck": {"statement": "<THE single constraint>", "metric": "<metric name or null>", "evidence": ["<fact from the data>"]},
  "move": {"statement": "<THE one highest-leverage action>", "why": "<reasoning>",
           "expectedDelta": {"metric": "<one of: ${LEADER_METRICS.join(', ')}>", "delta": <number>, "byDate": "<ISO date within ${LEADER_MEMO_CAPS.maxHorizonDays} days>"}},
  "killList": [{"target": {"kind": "goal|pr|lane|experiment", "id": "<id>"}, "why": "<why stop it>"}],
  "goals": [{"objective": "<specific goal>", "rationale": "<why>", "targetRepo": "<owner/name or null>", "deliverable": "<artifact>", "acceptanceEvidence": ["<executable check>"]}],
  "priorityChanges": [{"goalId": "<existing goal id>", "action": "focus|pause|archive|reorder", "why": "<why>"}],
  "standards": [{"rule": "<quality rule fleet work must meet>", "appliesTo": "producer|judge|<owner/name>|*", "evidence": "<why, or null>"}],
  "critiques": [{"subject": "<run/proposal/model id>", "standard": "<standard>", "finding": "<finding>", "evidenceRef": "<ref or null>"}],
  "seatPlan": [{"role": "producer|judge|leader", "seatId": "<seat id>", "share": <0..1>, "rationale": "<why>"}],
  "hypotheses": [{"target": "prompt|effort|sampling|routing|skill", "patch": <config-only patch, e.g. {"effort": {"local": "high"}} or {"prompts": {"producer": "<text appended to the producer prompt>"}}>, "statement": "<claim>", "metric": "<metric>", "predictedDelta": <number>}],
  "questionsForMason": ["<a genuine strategic fork only Mason can decide>"],
  "actions": [{"kind": "<action kind>", "params": {<exact params for the kind>}, "summary": "<one line>", "why": "<argument>"}]
}`;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

export function newMemoId(nowMs: number): string {
  return `lm-${stamp(nowMs)}-${randomBytes(3).toString('hex')}`;
}

export function hypothesisIdFor(memoId: string, index: number): string {
  return `hyp-${memoId.slice(3)}-${index}`;
}

export function actionIdFor(memoId: string, index: number): string {
  return `la-${memoId.slice(3)}-${index}`;
}

/** Build the typed hypotheses for a memo (ids derived from the memo id, source = leader). */
export function materializeHypotheses(memoId: string, drafts: readonly LeaderHypothesisDraft[], createdAt: string): HarnessHypothesis[] {
  return drafts.map((draft, index) => ({
    v: 1,
    id: hypothesisIdFor(memoId, index),
    source: { kind: 'leader', ref: memoId },
    target: draft.target,
    patch: draft.patch,
    statement: draft.statement,
    metric: draft.metric,
    predictedDelta: draft.predictedDelta,
    createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Newest memos kept on disk. */
export const MEMO_KEEP = 200;
const MAX_MEMO_BYTES = 512 * 1024;
const MEMO_FILE_RE = /^(lm-\d{14}-[a-f0-9]{6})\.json$/;

export function leaderRoot(): string {
  return join(homedir(), '.ashlr', 'vision', 'leader');
}

export function leaderMemosDir(): string {
  return join(leaderRoot(), 'memos');
}

/** Persist a memo (0600 in a 0700 dir) and prune the oldest beyond MEMO_KEEP. Throws on write failure. */
export function writeLeaderMemo(memo: LeaderMemo): void {
  if (!/^lm-\d{14}-[a-f0-9]{6}$/.test(memo.id)) throw new Error('refusing to write a memo with a malformed id');
  const dir = leaderMemosDir();
  ensurePrivateDirectory(leaderRoot());
  ensurePrivateDirectory(dir);
  writePrivateFileAtomic(join(dir, `${memo.id}.json`), `${JSON.stringify(memo, null, 2)}\n`);
  try {
    const files = listMemoIds();
    for (const id of files.slice(MEMO_KEEP)) unlinkSync(join(dir, `${id}.json`));
  } catch {
    // Pruning is housekeeping; a failure leaves extra files, never loses one.
  }
}

/** Memo ids on disk, newest first (ids sort by their timestamp). */
export function listMemoIds(): string[] {
  let names: string[];
  try {
    names = readdirSync(leaderMemosDir());
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    const m = MEMO_FILE_RE.exec(name);
    if (m) ids.push(m[1]!);
  }
  return ids.sort().reverse();
}

function isMemoShape(value: unknown): value is LeaderMemo {
  return isRecord(value)
    && value['v'] === 1
    && typeof value['id'] === 'string'
    && typeof value['at'] === 'string'
    && typeof value['status'] === 'string'
    && Array.isArray(value['actions'])
    && Array.isArray(value['goals']);
}

export function readLeaderMemo(id: string): LeaderMemo | null {
  if (!/^lm-\d{14}-[a-f0-9]{6}$/.test(id)) return null;
  const read = readPrivateFileCapped(join(leaderMemosDir(), `${id}.json`), MAX_MEMO_BYTES);
  if (!read || read.truncated) return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    return isMemoShape(parsed) && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

/** Newest `limit` memos (unreadable files skipped). */
export function readRecentMemos(limit: number): LeaderMemo[] {
  const out: LeaderMemo[] = [];
  for (const id of listMemoIds()) {
    if (out.length >= limit) break;
    const memo = readLeaderMemo(id);
    if (memo) out.push(memo);
  }
  return out;
}

export function summarizeMemo(memo: LeaderMemo, outcome: LeaderOutcomeRecord | null): LeaderMemoSummary {
  return {
    id: memo.id,
    at: memo.at,
    status: memo.status,
    bottleneck: memo.bottleneck?.statement ?? null,
    move: memo.move?.statement ?? null,
    expectedDelta: memo.move?.expectedDelta ?? null,
    outcome,
    actionCount: memo.actions.length,
  };
}

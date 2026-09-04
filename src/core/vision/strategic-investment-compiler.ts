/**
 * Strict strategy-to-investment compiler.
 *
 * This pure boundary joins a validated strategist briefing to caller-supplied
 * numeric investment contracts. It never derives a number from briefing prose
 * and performs no I/O, inference, persistence, dispatch, or authority change.
 */

import { createHash } from 'node:crypto';

import type { StrategicBriefing } from './strategist.js';
import {
  createValueHypothesisV1,
  verifyValueHypothesisV1,
  type ValueHypothesisV1,
} from './value-portfolio.js';

export const STRATEGIC_INVESTMENT_COMPILER_SCHEMA_VERSION = 1 as const;
export const MAX_STRATEGIC_INVESTMENTS = 3;

const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const KEY_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const BRIEFING_KEYS = new Set([
  'generatedAt', 'project', 'currentState', 'gapToVision', 'proposedEvolution',
  'recommendedDirection', 'newProblems', 'questionsForMason', 'proposedGoals',
]);
const GOAL_KEYS = new Set([
  'objective', 'rationale', 'specPriority', 'targetRepo', 'key', 'dependsOn',
  'deliverable', 'acceptanceEvidence', 'riskClass', 'humanGate', 'outcome',
  'missionMetadataInvalid',
]);
const OUTCOME_KEYS = new Set(['desiredOutcome', 'successSignals', 'guardrails']);
const INPUT_KEYS = new Set([
  'schemaVersion', 'briefing', 'briefingSource', 'specDigest', 'missionGraphDigest', 'estimates',
]);
const SOURCE_KEYS = new Set(['complete', 'digest']);
const ESTIMATE_KEYS = new Set([
  'missionNodeKey', 'producerDigest', 'constraints', 'acceptanceContract', 'budget',
  'factors', 'outcomeSource',
]);
const ESTIMATE_CONSTRAINT_KEYS = new Set([
  'dependenciesSatisfied', 'reversible', 'allowedProviders', 'shardable', 'shardPlanDigest',
]);

const PRIVATE_TEXT_RE = /(?:^|[^A-Za-z0-9])(?:\/(?:Users|home|private|var|tmp|etc)\/|~\/|[A-Za-z]:\\)|\b(?:CODEX_HOME|CLAUDE_CONFIG_DIR|identityRef|accountRef|runtimeLocator)\b/i;
const SECRET_TEXT_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|bearer|access[_-]?token)\s*[:=]\s*\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/i;

export interface StrategicInvestmentEstimateV1 {
  missionNodeKey: string;
  producerDigest: string;
  constraints: {
    dependenciesSatisfied: boolean;
    reversible: boolean;
    allowedProviders: Array<'codex' | 'claude' | 'local'>;
    shardable: boolean;
    shardPlanDigest: string | null;
  };
  acceptanceContract: {
    acceptanceContractDigest: string;
    baselineDigest: string;
    metric: string;
    unit: string;
    direction: 'increase' | 'decrease';
    effectiveThreshold: number;
    refutationThreshold: number;
    windowStart: string;
    windowEnd: string;
    minimumCausalGrade: 'observational' | 'quasi-experimental' | 'experimental';
  };
  budget: {
    maxTokens: number;
    maxMinutes: number;
    maxAttempts: number;
    maxInconclusiveWindows: number;
    spentTokens: number;
    spentMinutes: number;
    attempts: number;
    inconclusiveWindows: number;
    deadline: string;
    minimumMarginalValue: number;
  };
  factors: {
    productImpact: number;
    informationGain: number;
    strategicLeverage: number;
    ipLeverage: number;
    dependencyUnlock: number;
    probability: number;
    risk: number;
    uncertainty: number;
    estimatedTokens: number;
    estimatedMinutes: number;
    factorSourceDigest: string;
  };
  outcomeSource: {
    complete: boolean;
    sourceDigest: string;
    evidence: ValueHypothesisV1['outcomeSource']['evidence'];
  };
}

export interface StrategicInvestmentCompilerInputV1 {
  schemaVersion: 1;
  briefing: StrategicBriefing;
  briefingSource: { complete: boolean; digest: string };
  specDigest: string;
  missionGraphDigest: string;
  estimates: readonly StrategicInvestmentEstimateV1[];
}

export type StrategicInvestmentCompilerIssueV1 =
  | 'invalid-input'
  | 'invalid-briefing'
  | 'briefing-source-incomplete'
  | 'briefing-digest-mismatch'
  | 'goal-cap'
  | 'legacy-mission-key'
  | 'human-gate-node'
  | 'invalid-work-goal'
  | 'duplicate-estimate'
  | 'unmatched-estimate'
  | 'missing-estimate'
  | 'invalid-estimate'
  | 'hypothesis-rejected';

export type StrategicInvestmentCompilerResultV1 =
  | { ok: true; hypotheses: ValueHypothesisV1[]; issues: [] }
  | { ok: false; hypotheses: []; issues: StrategicInvestmentCompilerIssueV1[] };

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor || !descriptor.enumerable || !('value' in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clone<T>(value: T): T | null {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return null;
  }
}

function exactKeys(row: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function onlyKnownKeys(row: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(row).every((key) => keys.has(key));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function digest(value: unknown, domain: string): string {
  return createHash('sha256').update(domain, 'utf8').update('\0')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function publicText(value: unknown, maximum = 4_000): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 &&
    value.length <= maximum && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    !PRIVATE_TEXT_RE.test(value) && !SECRET_TEXT_RE.test(value);
}

function publicTextArray(value: unknown, maximumItems: number, maximumText: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems &&
    Object.keys(value).length === value.length && value.every((entry) => publicText(entry, maximumText));
}

function safePublicTree(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  budget.nodes += 1;
  if (budget.nodes > 512 || depth > 8) return false;
  if (typeof value === 'string') return publicText(value);
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 128 && Object.keys(value).length === value.length &&
      value.every((entry) => safePublicTree(entry, depth + 1, budget));
  }
  const row = record(value);
  return row !== null && Object.keys(row).length <= 64 &&
    Object.entries(row).every(([key, entry]) => publicText(key, 128) && safePublicTree(entry, depth + 1, budget));
}

interface NormalizedGoal {
  key: string;
  desiredOutcome: string;
  dependsOn: string[];
  targetRepo: string;
  deliverable: string;
  acceptanceEvidence: string[];
  outcome: {
    desiredOutcome: string;
    successSignals: string[];
    guardrails: string[];
  };
}

function hasDependencyCycle(goals: readonly NormalizedGoal[]): boolean {
  const dependencies = new Map(goals.map((goal) => [goal.key, goal.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return goals.some((goal) => visit(goal.key));
}

function normalizeBriefing(value: unknown): { briefing: StrategicBriefing; goals: NormalizedGoal[] } | null {
  const snapshot = clone(value);
  const briefing = record(snapshot);
  if (!briefing || !exactKeys(briefing, BRIEFING_KEYS) || !timestamp(briefing['generatedAt']) ||
    (briefing['project'] !== null && (!publicText(briefing['project'], 128) ||
      !REPO_RE.test(briefing['project'] as string))) || !publicText(briefing['currentState']) ||
    !publicText(briefing['gapToVision']) || !safePublicTree(briefing['proposedEvolution']) ||
    !publicTextArray(briefing['recommendedDirection'], 8, 1_000) ||
    !publicTextArray(briefing['newProblems'], 16, 1_000) ||
    !publicTextArray(briefing['questionsForMason'], 16, 1_000) ||
    !Array.isArray(briefing['proposedGoals']) ||
    Object.keys(briefing['proposedGoals']).length !== briefing['proposedGoals'].length) return null;

  const goals: NormalizedGoal[] = [];
  const keys = new Set<string>();
  for (const rawGoal of briefing['proposedGoals']) {
    const goal = record(rawGoal);
    if (!goal || !onlyKnownKeys(goal, GOAL_KEYS) || !publicText(goal['objective']) ||
      !publicText(goal['rationale']) || (goal['specPriority'] !== undefined &&
        !publicText(goal['specPriority'], 200)) || typeof goal['targetRepo'] !== 'string' ||
      !REPO_RE.test(goal['targetRepo']) || !publicText(goal['deliverable'], 1_000) ||
      !publicTextArray(goal['acceptanceEvidence'], 8, 500) || goal['acceptanceEvidence'].length === 0 ||
      !['low', 'medium', 'high'].includes(String(goal['riskClass'])) ||
      !Array.isArray(goal['dependsOn']) || goal['dependsOn'].length > 8 ||
      Object.keys(goal['dependsOn']).length !== goal['dependsOn'].length ||
      goal['dependsOn'].some((entry) => typeof entry !== 'string' || !KEY_RE.test(entry)) ||
      new Set(goal['dependsOn']).size !== goal['dependsOn'].length ||
      goal['missionMetadataInvalid'] === true) return null;
    if (typeof goal['key'] !== 'string' || !KEY_RE.test(goal['key'])) return null;
    if (goal['humanGate'] !== false) return null;
    const outcome = record(goal['outcome']);
    if (!outcome || !exactKeys(outcome, OUTCOME_KEYS) || !publicText(outcome['desiredOutcome']) ||
      !publicTextArray(outcome['successSignals'], 8, 500) || outcome['successSignals'].length === 0 ||
      !publicTextArray(outcome['guardrails'], 8, 500) || outcome['guardrails'].length === 0 ||
      keys.has(goal['key'])) return null;
    keys.add(goal['key']);
    goals.push({
      key: goal['key'],
      desiredOutcome: outcome['desiredOutcome'],
      dependsOn: goal['dependsOn'] as string[],
      targetRepo: goal['targetRepo'],
      deliverable: goal['deliverable'],
      acceptanceEvidence: goal['acceptanceEvidence'],
      outcome: {
        desiredOutcome: outcome['desiredOutcome'],
        successSignals: outcome['successSignals'],
        guardrails: outcome['guardrails'],
      },
    });
  }
  if (goals.some((goal) =>
    goal.dependsOn.some((dependency) => dependency === goal.key || !keys.has(dependency))) ||
    hasDependencyCycle(goals)) return null;
  return { briefing: snapshot as StrategicBriefing, goals };
}

export function strategicBriefingDigestV1(value: unknown): string | null {
  const normalized = normalizeBriefing(value);
  return normalized ? digest(normalized.briefing, 'ashlr:strategic-briefing:v1') : null;
}

function fail(issue: StrategicInvestmentCompilerIssueV1): StrategicInvestmentCompilerResultV1 {
  return { ok: false, hypotheses: [], issues: [issue] };
}

export function compileStrategicInvestmentsV1(value: unknown): StrategicInvestmentCompilerResultV1 {
  const snapshot = clone(value);
  const input = record(snapshot);
  if (!input || !exactKeys(input, INPUT_KEYS) || input['schemaVersion'] !== 1 ||
    !SHA256_RE.test(String(input['specDigest'])) || !SHA256_RE.test(String(input['missionGraphDigest'])) ||
    !Array.isArray(input['estimates']) || Object.keys(input['estimates']).length !== input['estimates'].length) {
    return fail('invalid-input');
  }
  const source = record(input['briefingSource']);
  if (!source || !exactKeys(source, SOURCE_KEYS) || typeof source['complete'] !== 'boolean' ||
    !SHA256_RE.test(String(source['digest']))) return fail('invalid-input');
  if (!source['complete']) return fail('briefing-source-incomplete');

  const normalized = normalizeBriefing(input['briefing']);
  if (!normalized) {
    const rawBriefing = record(input['briefing']);
    const rawGoals = rawBriefing?.['proposedGoals'];
    if (Array.isArray(rawGoals) && rawGoals.length > MAX_STRATEGIC_INVESTMENTS) return fail('goal-cap');
    if (Array.isArray(rawGoals) && rawGoals.some((goal) => !KEY_RE.test(String(record(goal)?.['key'] ?? '')))) {
      return fail('legacy-mission-key');
    }
    if (Array.isArray(rawGoals) && rawGoals.some((goal) => record(goal)?.['humanGate'] !== false)) {
      return fail('human-gate-node');
    }
    return fail('invalid-briefing');
  }
  if (normalized.goals.length > MAX_STRATEGIC_INVESTMENTS) return fail('goal-cap');
  const expectedBriefingDigest = digest(normalized.briefing, 'ashlr:strategic-briefing:v1');
  if (source['digest'] !== expectedBriefingDigest) return fail('briefing-digest-mismatch');
  if (input['estimates'].length !== normalized.goals.length) {
    return fail(input['estimates'].length < normalized.goals.length ? 'missing-estimate' : 'unmatched-estimate');
  }

  const estimates = new Map<string, StrategicInvestmentEstimateV1>();
  for (const rawEstimate of input['estimates']) {
    const estimate = record(rawEstimate);
    const constraints = record(estimate?.['constraints']);
    if (!estimate || !exactKeys(estimate, ESTIMATE_KEYS) || !safePublicTree(estimate) ||
      typeof estimate['missionNodeKey'] !== 'string' || !KEY_RE.test(estimate['missionNodeKey']) ||
      !SHA256_RE.test(String(estimate['producerDigest'])) || !constraints ||
      !exactKeys(constraints, ESTIMATE_CONSTRAINT_KEYS)) return fail('invalid-estimate');
    if (estimates.has(estimate['missionNodeKey'])) return fail('duplicate-estimate');
    estimates.set(estimate['missionNodeKey'], estimate as unknown as StrategicInvestmentEstimateV1);
  }
  const goalKeys = new Set(normalized.goals.map((goal) => goal.key));
  if ([...estimates.keys()].some((key) => !goalKeys.has(key))) return fail('unmatched-estimate');

  const hypotheses: ValueHypothesisV1[] = [];
  for (const goal of normalized.goals) {
    const estimate = estimates.get(goal.key);
    if (!estimate) return fail('missing-estimate');
    const provenanceDigest = digest({
      briefingDigest: expectedBriefingDigest,
      specDigest: input['specDigest'],
      missionGraphDigest: input['missionGraphDigest'],
      missionNode: {
        key: goal.key,
        targetRepo: goal.targetRepo,
        dependsOn: goal.dependsOn,
        deliverable: goal.deliverable,
        acceptanceEvidence: goal.acceptanceEvidence,
        outcome: goal.outcome,
      },
    }, 'ashlr:strategic-investment-provenance:v1');
    const hypothesis = createValueHypothesisV1({
      schemaVersion: 1,
      provenanceDigest,
      specDigest: input['specDigest'],
      missionDigest: input['missionGraphDigest'],
      missionNodeKey: goal.key,
      producerDigest: estimate.producerDigest,
      claim: goal.desiredOutcome,
      constraints: {
        dependenciesSatisfied: estimate.constraints.dependenciesSatisfied,
        humanGateRequired: false,
        reversible: estimate.constraints.reversible,
        allowedProviders: estimate.constraints.allowedProviders,
        shardable: estimate.constraints.shardable,
        shardPlanDigest: estimate.constraints.shardPlanDigest,
      },
      frozenOutcome: estimate.acceptanceContract,
      budget: estimate.budget,
      factors: estimate.factors,
      outcomeSource: estimate.outcomeSource,
    });
    if (!hypothesis || !verifyValueHypothesisV1(hypothesis)) return fail('hypothesis-rejected');
    hypotheses.push(hypothesis);
  }
  return { ok: true, hypotheses, issues: [] };
}

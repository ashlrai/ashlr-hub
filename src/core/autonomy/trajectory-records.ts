/**
 * Read-only trajectory records for recursive fleet learning.
 *
 * Dispatch-production rows remain the root signal, but this read model joins
 * existing metadata-only ledgers into one ordered route-to-stop timeline. It
 * never writes state and never returns raw prompts, diffs, stdout/stderr, env,
 * file contents, command output, or full evidence details.
 */

import { createHash } from 'node:crypto';
import { readAgentActions, type AgentActionSourceQuality } from '../fleet/agent-action-ledger.js';
import type { DispatchProductionEvent } from '../fleet/dispatch-production-ledger.js';
import {
  readDispatchProductionEvents,
  readDispatchProductionEventsDetailed,
} from '../fleet/dispatch-production-ledger.js';
import { readSkillUseEvents } from '../fleet/skill-records.js';
import type { GeneratedRepairRouteReason } from '../fleet/router.js';
import { classifyProductionAttemptForLearningWithLabel } from '../learning/attempt-shape.js';
import type { OutcomeRecord, OutcomeRecordDecision, OutcomeRecordEvidence } from './outcome-records.js';
import { listOutcomeRecords } from './outcome-records.js';
import { loadProposal } from '../inbox/store.js';
import { hasRealizedMergeEvidence } from '../inbox/realized-merge.js';
import type {
  EngineId,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  Proposal,
  RouteSnapshot,
  RunEventSummary,
  SkillUseEvent,
  SkillUseMode,
  SkillUseStage,
  WorkSource,
} from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  agentSemanticBoundSubjectRef,
  agentSemanticModelFamily,
  sanitizeAgentSemanticEvents,
} from '../learning/agent-semantic-events.js';

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 200;
const MAX_TRACE_EVENTS = 8;
export const MIN_SKILL_OBSERVED_TRAJECTORIES = 3;

export type TrajectoryTimelineKind = 'dispatch' | 'proposal' | 'evidence' | 'decision' | 'post-merge' | 'agent-action';
export type TrajectoryTerminalOutcome =
  | 'merged'
  | 'rejected'
  | 'handoff'
  | 'pending'
  | 'no-proposal'
  | 'cancelled'
  | 'failed'
  | 'unknown';
export type TrajectoryRealizedOutcome = 'followed-up' | 'reverted' | 'regressed';

export interface TrajectoryRecordCoverage {
  dispatch: boolean;
  proposal: boolean;
  evidence: boolean;
  decision: boolean;
  agentAction: boolean;
  skillUse: boolean;
}

export interface TrajectoryTimelineEvent {
  ts: string;
  kind: TrajectoryTimelineKind;
  outcome: string;
  action?: string;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  repo?: string;
  itemId?: string;
  source?: WorkSource;
  backend?: EngineId | string | null;
  tier?: EngineTier | string | null;
  model?: string | null;
  reason?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  semanticEvents?: OutcomeRecordDecision['semanticEvents'];
  evidence?: {
    target: string;
    trustBasis: string;
    riskClass: string;
    verificationPassed: boolean;
    commandKinds: string[];
    baseBranch?: string;
    baseHead?: string;
    diffHash?: string;
    verifiedAt?: string;
    source?: string;
    policyAllowed?: boolean;
  };
  postMergeEvidence?: {
    basis: string;
    confidence: 'deterministic' | 'heuristic';
    candidateCount?: number;
    commandKinds?: string[];
  };
  proposal?: {
    status: string;
    origin: string;
    kind: string;
    title: string;
    riskClass?: string;
    verifyPassed?: boolean;
    diffHash?: string;
  };
}

export interface TrajectoryRecord {
  version: 1;
  id: string;
  key: string;
  startedAt: string;
  latestAt: string;
  terminalOutcome: TrajectoryTerminalOutcome;
  /** Observation-only real-world result after merge; never changes merge authority. */
  realizedOutcome?: TrajectoryRealizedOutcome;
  repo?: string;
  itemId?: string;
  source?: WorkSource;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  backend?: EngineId | string | null;
  tier?: EngineTier | string | null;
  model?: string | null;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  decisionSourceQuality?: OutcomeRecord['decisionSourceQuality'];
  agentActionSourceQuality?: AgentActionSourceQuality;
  coverage: TrajectoryRecordCoverage;
  timeline: TrajectoryTimelineEvent[];
}

export interface TrajectoryCoverageMetric {
  count: number;
  rate: number;
}

export interface TrajectorySkillObservationSummary {
  eventState: 'none' | 'present';
  sampleState: 'none' | 'unavailable' | 'insufficient-sample' | 'observed';
  joined?: number;
  unjoined?: number;
  conflicting?: number;
  observedTrajectoryCoverage?: TrajectoryCoverageMetric;
  modeCounts?: Record<SkillUseMode, number>;
  stageCounts?: Record<SkillUseStage, number>;
}

export interface TrajectoryRouteDiagnosticSummary {
  trajectories: number;
  reasonCounts: Record<GeneratedRepairRouteReason, number>;
}

type TraceModelFamily = 'codex' | 'claude' | 'kimi' | 'local' | 'other';
type TraceCommandKind = 'typecheck' | 'lint' | 'test' | 'build' | 'security';
type TraceAction = 'created' | 'verified' | 'merged' | 'rejected' | 'handoff' | 'escalated';
type TraceLabelBasis = 'proposal-status' | 'dispatch-outcome' | 'judge-verdict' | 'merge-gate' | 'autonomy-policy' | 'evidence-policy' | 'manual-decision' | 'unknown';
type TraceLearningSource = 'proposal' | 'decision-ledger' | 'daemon-dispatch' | 'agent-action' | 'autonomy-evidence' | 'outcome-record' | 'worked-ledger' | 'unknown';

/** A deliberately narrow, metadata-only event surface for operator traces. */
export interface TrajectoryTraceEvent {
  ts: string;
  kind: TrajectoryTimelineKind;
  outcome: TrajectoryTerminalOutcome | 'passed' | 'failed' | 'unknown';
  action?: TraceAction;
  route?: {
    backend?: EngineId;
    tier?: EngineTier;
    modelFamily?: TraceModelFamily;
    policyVersion?: string;
    learningEpoch?: string;
  };
  evidence?: {
    state: 'passed' | 'failed' | 'unknown';
    trust: 'signed' | 'deterministic' | 'heuristic' | 'unknown';
    commandKinds: TraceCommandKind[];
  };
  labelBasis?: TraceLabelBasis;
  learningSource?: TraceLearningSource;
}

export interface TrajectoryTrace {
  ref: string;
  latestAt: string;
  terminalOutcome: TrajectoryTerminalOutcome;
  realizedOutcome?: TrajectoryRealizedOutcome;
  coverage: PublishedTrajectoryCoverage;
  sourceState: 'complete' | 'incomplete' | 'degraded';
  /** Whether the bounded public event list contains every timeline event. */
  eventState: 'complete' | 'sampled';
  events: TrajectoryTraceEvent[];
}

export interface TrajectoryTraceSummary {
  state: 'available' | 'unavailable' | 'degraded';
  records: TrajectoryTrace[];
}

type TrajectoryTraceReadQuality = {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
};

/** Remove all exact skill metrics when the observation ledger is degraded. */
export function suppressDegradedSkillObservation(
  status: TrajectoryLearningStatus,
  eventState: 'none' | 'present',
): TrajectoryLearningStatus {
  const { skillUse: _skillUseCoverage, ...coverage } = status.coverage;
  return {
    ...status,
    coverage,
    skillObservation: { eventState, sampleState: 'unavailable' },
    ...(status.recent ? { recent: status.recent.map((record) => {
      const { skillUse: _skillUse, ...publicCoverage } = record.coverage;
      return { ...record, coverage: publicCoverage };
    }) } : {}),
  };
}

type PublishedTrajectoryCoverage = Partial<TrajectoryRecordCoverage>;
type PublishedCoverageMetrics = Partial<Record<keyof TrajectoryRecordCoverage, TrajectoryCoverageMetric>>;
export type TrajectoryTerminalOutcomeCounts = Omit<
  Record<TrajectoryTerminalOutcome, number>,
  'cancelled'
> & { cancelled?: number };

export interface TrajectoryLearningStatus {
  version: 1;
  windowHours: number;
  trajectories: number;
  terminalOutcomes?: TrajectoryTerminalOutcomeCounts;
  realizedOutcomes?: Record<TrajectoryRealizedOutcome, number>;
  coverage: PublishedCoverageMetrics;
  routeSpine: Partial<{
    dispatchToDecision: TrajectoryCoverageMetric;
    dispatchToEvidence: TrajectoryCoverageMetric;
    dispatchToMerge: TrajectoryCoverageMetric;
  }>;
  /** Bounded action-only preclaim observations, excluded from learning metrics. */
  routeDiagnostics?: TrajectoryRouteDiagnosticSummary;
  skillObservation: TrajectorySkillObservationSummary;
  /** Capped, opaque, metadata-only route-to-outcome traces for operators. */
  traces: TrajectoryTraceSummary;
  gaps: Array<{ kind: keyof TrajectoryRecordCoverage; count: number; sampleRefs: string[] }>;
  recent?: Array<{
    ref: string;
    latestAt: string;
    terminalOutcome: TrajectoryTerminalOutcome;
    realizedOutcome?: TrajectoryRealizedOutcome;
    backend?: EngineId | string | null;
    source?: WorkSource;
    coverage: PublishedTrajectoryCoverage;
  }>;
}

export interface TrajectoryRecordReadDeps {
  readDispatchProductionEvents?: typeof readDispatchProductionEvents;
  readAgentActions?: typeof readAgentActions;
  readSkillUseEvents?: typeof readSkillUseEvents;
  listOutcomeRecords?: (opts?: { limit?: number }) => OutcomeRecord[];
  loadProposal?: (id: string) => Proposal | null;
}

export interface TrajectoryRecordListOptions {
  windowHours?: number;
  limit?: number;
  deps?: TrajectoryRecordReadDeps;
}

interface MutableTrajectoryRecord extends Omit<TrajectoryRecord, 'timeline'> {
  aliases: Set<string>;
  timeline: TrajectoryTimelineEvent[];
}

interface SkillObservationCounts {
  joined: number;
  unjoined: number;
  conflicting: number;
  modeCounts: Record<SkillUseMode, number>;
  stageCounts: Record<SkillUseStage, number>;
}

const skillObservationByRecords = new WeakMap<TrajectoryRecord[], SkillObservationCounts>();
const dispatchTraceReadStateByRecords = new WeakMap<TrajectoryRecord[], TrajectoryTraceSummary['state']>();
const skillObservationByRecord = new WeakMap<TrajectoryRecord, SkillObservationCounts>();
const skillObservationDiagnosticsByRecord = new WeakMap<
  TrajectoryRecord,
  Pick<SkillObservationCounts, 'unjoined' | 'conflicting'>
>();

function scrubLearningText(value: string): string {
  return scrubSecrets(value)
    .replace(/\bRAW_[A-Z0-9_]*(?:SECRET|CANARY|TOKEN|KEY)[A-Z0-9_]*\b/g, '[REDACTED]')
    .replace(/\b(stdout|stderr|prompt|diff|env|argv|file contents|fileContents)\s+(contained|included)\s+[^,;}\]]+/gi, '$1 $2 [REDACTED]');
}

function sanitizeMetadata<T>(value: T): T {
  if (typeof value === 'string') return scrubLearningText(value) as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeMetadata(entry)) as T;
  if (typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    sanitized[scrubLearningText(key)] = sanitizeMetadata(entry);
  }
  return sanitized as T;
}

function bounded(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const scrubbed = scrubLearningText(value).replace(/\s+/g, ' ').trim();
  if (!scrubbed) return fallback;
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 3)}...` : scrubbed;
}

function safeArray<T>(read: () => T[] | undefined): T[] {
  try {
    const value = read();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function safeValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function eventMs(ts: string | undefined): number {
  const parsed = Date.parse(ts ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function activityTime(...values: Array<string | undefined>): string {
  let newestMs = Number.NEGATIVE_INFINITY;
  let newest = '';
  for (const value of values) {
    const ms = eventMs(value);
    if (ms > newestMs) {
      newestMs = ms;
      newest = value ?? '';
    }
  }
  return newest || new Date(0).toISOString();
}

function firstTime(...values: Array<string | undefined>): string {
  let oldestMs = Number.POSITIVE_INFINITY;
  let oldest = '';
  for (const value of values) {
    const ms = eventMs(value);
    if (ms > 0 && ms < oldestMs) {
      oldestMs = ms;
      oldest = value ?? '';
    }
  }
  return oldest || new Date(0).toISOString();
}

function isDerivedWorkTrajectory(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('work:');
}

function cleanId(value: unknown, max = 240): string | undefined {
  const text = bounded(value, max);
  return text || undefined;
}

function alias(namespace: string, value: string | undefined): string | undefined {
  return value ? `${namespace}:${value}` : undefined;
}

function aliasesFromIds(input: {
  trajectoryId?: string;
  runId?: string;
  proposalId?: string;
}): string[] {
  return [
    !isDerivedWorkTrajectory(input.trajectoryId) ? alias('trajectory', input.trajectoryId) : undefined,
    alias('run', input.runId),
    alias('proposal', input.proposalId),
  ].filter((value): value is string => Boolean(value));
}

function emptySkillObservationCounts(): SkillObservationCounts {
  return {
    joined: 0,
    unjoined: 0,
    conflicting: 0,
    modeCounts: { shadow: 0, active: 0, disabled: 0 },
    stageCounts: { selected: 0, injected: 0, applied: 0, outcome: 0 },
  };
}

function skillSelectionIdentity(event: SkillUseEvent): string {
  return JSON.stringify([
    event.runId ?? '',
    event.stage,
    event.skillId,
    event.skillRevision,
    event.contentHash ?? '',
    event.skillPolicyVersion ?? '',
  ]);
}

function fallbackTrajectoryKey(input: {
  ts?: string;
  repo?: string;
  itemId?: string;
  runId?: string;
  proposalId?: string;
  outcome?: string;
  backend?: string | null;
}): string {
  const hash = createHash('sha256')
    .update([
      input.ts ?? '',
      input.repo ?? '',
      input.itemId ?? '',
      input.runId ?? '',
      input.proposalId ?? '',
      input.outcome ?? '',
      input.backend ?? '',
    ].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `attempt:${hash}`;
}

function timelineRank(kind: TrajectoryTimelineKind): number {
  switch (kind) {
    case 'dispatch': return 10;
    case 'proposal': return 20;
    case 'evidence': return 30;
    case 'decision': return 40;
    case 'post-merge': return 50;
    case 'agent-action': return 60;
  }
}

function betterTerminalOutcome(
  current: TrajectoryTerminalOutcome,
  next: TrajectoryTerminalOutcome,
): TrajectoryTerminalOutcome {
  const rank: Record<TrajectoryTerminalOutcome, number> = {
    unknown: 0,
    cancelled: 1,
    pending: 2,
    failed: 3,
    'no-proposal': 4,
    handoff: 5,
    rejected: 6,
    merged: 7,
  };
  return rank[next] >= rank[current] ? next : current;
}

function betterRealizedOutcome(
  current: TrajectoryRealizedOutcome | undefined,
  next: TrajectoryRealizedOutcome,
): TrajectoryRealizedOutcome {
  const rank: Record<TrajectoryRealizedOutcome, number> = {
    'followed-up': 1,
    regressed: 2,
    reverted: 3,
  };
  return current === undefined || rank[next] >= rank[current] ? next : current;
}

function metric(count: number, denominator: number): TrajectoryCoverageMetric {
  return {
    count,
    rate: denominator > 0 ? count / denominator : 0,
  };
}

function trajectoryRef(record: TrajectoryRecord): string {
  return `trajectory:${createHash('sha256').update(record.id).digest('hex').slice(0, 12)}`;
}

const TRACE_ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi', 'nim', 'opencode', 'grok',
]);
const TRACE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);
const TRACE_COMMAND_KINDS = new Set<TraceCommandKind>([
  'typecheck', 'lint', 'test', 'build', 'security',
]);
const TRACE_ACTIONS = new Set<TraceAction>([
  'created', 'verified', 'merged', 'rejected', 'handoff', 'escalated',
]);
const TRACE_LABEL_BASES = new Set<TraceLabelBasis>([
  'proposal-status', 'dispatch-outcome', 'judge-verdict', 'merge-gate', 'autonomy-policy', 'evidence-policy', 'manual-decision', 'unknown',
]);
const TRACE_LEARNING_SOURCES = new Set<TraceLearningSource>([
  'proposal', 'decision-ledger', 'daemon-dispatch', 'agent-action', 'autonomy-evidence', 'outcome-record', 'worked-ledger', 'unknown',
]);
const TRACE_TERMINAL_OUTCOMES = new Set<TrajectoryTerminalOutcome>([
  'merged', 'rejected', 'handoff', 'pending', 'no-proposal', 'cancelled', 'failed', 'unknown',
]);
const TRACE_POLICY_VERSIONS = new Set(['fleet-router-v1']);

function traceTimestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : 'unknown';
}

function traceEngine(value: unknown): EngineId | undefined {
  return typeof value === 'string' && TRACE_ENGINE_IDS.has(value as EngineId) ? value as EngineId : undefined;
}

function traceTier(value: unknown): EngineTier | undefined {
  return typeof value === 'string' && TRACE_TIERS.has(value as EngineTier) ? value as EngineTier : undefined;
}

function traceModelFamily(value: unknown): TraceModelFamily | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  if (/(^|[/:._-])codex([/:._-]|$)|\bgpt[- ]?\d|\bopenai\b/.test(normalized)) return 'codex';
  if (/(^|[/:._-])claude([/:._-]|$)|\banthropic\b/.test(normalized)) return 'claude';
  if (/(^|[/:._-])kimi([/:._-]|$)|\bmoonshot\b/.test(normalized)) return 'kimi';
  if (/(^|[/:._-])(local|ollama|qwen|llama|deepseek|nim|builtin|ashlrcode|aw|hermes|opencode|grok)([/:._-]|$)/.test(normalized)) return 'local';
  return 'other';
}

function tracePolicyVersion(value: unknown): string | undefined {
  return typeof value === 'string' && TRACE_POLICY_VERSIONS.has(value) ? value : undefined;
}

function traceLearningEpoch(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function traceOutcome(event: TrajectoryTimelineEvent): TrajectoryTraceEvent['outcome'] {
  if (typeof event.outcome === 'string' && TRACE_TERMINAL_OUTCOMES.has(event.outcome as TrajectoryTerminalOutcome)) {
    return event.outcome as TrajectoryTerminalOutcome;
  }
  if (event.outcome === 'passed' || event.outcome === 'failed') return event.outcome;
  if (event.evidence?.verificationPassed === true || event.evidenceOutcome?.verificationPassed === true) return 'passed';
  if (event.evidence?.verificationPassed === false || event.evidenceOutcome?.verificationPassed === false) return 'failed';
  return 'unknown';
}

function traceEvidence(event: TrajectoryTimelineEvent): TrajectoryTraceEvent['evidence'] | undefined {
  const commandKinds = [
    ...(event.evidence?.commandKinds ?? []),
    ...(event.postMergeEvidence?.commandKinds ?? []),
  ].filter((kind): kind is TraceCommandKind =>
    typeof kind === 'string' && TRACE_COMMAND_KINDS.has(kind as TraceCommandKind),
  );
  const verification = event.evidence?.verificationPassed ?? event.evidenceOutcome?.verificationPassed;
  const trustBasis = event.evidence?.trustBasis ?? event.evidenceOutcome?.trustBasis;
  const trust = trustBasis === 'evidence'
    ? 'signed'
    : trustBasis === 'verification'
      ? 'deterministic'
      : trustBasis === 'tier'
        ? 'heuristic'
        : 'unknown';
  if (verification === undefined && commandKinds.length === 0 && trust === 'unknown') return undefined;
  return {
    state: verification === true ? 'passed' : verification === false ? 'failed' : 'unknown',
    trust,
    commandKinds: [...new Set(commandKinds)],
  };
}

function traceSourceState(record: TrajectoryRecord): TrajectoryTrace['sourceState'] {
  const qualities = [record.decisionSourceQuality, record.agentActionSourceQuality];
  if (qualities.some((quality) => quality?.sourceState === 'degraded')) return 'degraded';
  if (qualities.some((quality) => quality && (quality.sourceState === 'missing' || !quality.complete))) return 'incomplete';
  return record.coverage.dispatch && record.coverage.proposal && record.coverage.evidence && record.coverage.decision && record.coverage.agentAction
    ? 'complete'
    : 'incomplete';
}

function projectTrajectoryEvent(event: TrajectoryTimelineEvent): TrajectoryTraceEvent {
  const backend = traceEngine(event.backend ?? event.routeSnapshot?.backend);
  const tier = traceTier(event.tier ?? event.routeSnapshot?.tier);
  const modelFamily = traceModelFamily(event.model ?? event.routeSnapshot?.model);
  const policyVersion = tracePolicyVersion(event.routerPolicyVersion ?? event.routeSnapshot?.routerPolicyVersion);
  const learningEpoch = traceLearningEpoch(event.learningEpoch);
  const route = {
    ...(backend ? { backend } : {}),
    ...(tier ? { tier } : {}),
    ...(modelFamily ? { modelFamily } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(learningEpoch ? { learningEpoch } : {}),
  };
  const evidence = traceEvidence(event);
  const action = typeof event.action === 'string' && TRACE_ACTIONS.has(event.action as TraceAction)
    ? event.action as TraceAction
    : undefined;
  const labelBasis = typeof event.labelBasis === 'string' && TRACE_LABEL_BASES.has(event.labelBasis as TraceLabelBasis)
    ? event.labelBasis as TraceLabelBasis
    : event.labelBasis ? 'unknown' : undefined;
  const learningSource = typeof event.learningSource === 'string' && TRACE_LEARNING_SOURCES.has(event.learningSource as TraceLearningSource)
    ? event.learningSource as TraceLearningSource
    : event.learningSource ? 'unknown' : undefined;
  return {
    ts: traceTimestamp(event.ts),
    kind: event.kind,
    outcome: traceOutcome(event),
    ...(action ? { action } : {}),
    ...(Object.keys(route).length > 0 ? { route } : {}),
    ...(evidence ? { evidence } : {}),
    ...(labelBasis ? { labelBasis } : {}),
    ...(learningSource ? { learningSource } : {}),
  };
}

function projectTrajectoryEvents(
  timeline: readonly TrajectoryTimelineEvent[],
): Pick<TrajectoryTrace, 'eventState' | 'events'> {
  const ordered = [...timeline]
    .sort((left, right) => eventMs(left.ts) - eventMs(right.ts) || timelineRank(left.kind) - timelineRank(right.kind));
  if (ordered.length <= MAX_TRACE_EVENTS) {
    return { eventState: 'complete', events: ordered.map(projectTrajectoryEvent) };
  }

  // Preserve both causal boundaries and the newest observation of each
  // lifecycle stage. Fill any remaining capacity from the newest events, then
  // restore chronological display order. The public surface stays bounded.
  const retained = new Set<number>([0, ordered.length - 1]);
  const latestByKind = new Map<TrajectoryTimelineKind, number>();
  for (let index = 0; index < ordered.length; index++) {
    latestByKind.set(ordered[index]!.kind, index);
  }
  for (const index of latestByKind.values()) retained.add(index);
  for (let index = ordered.length - 1; retained.size < MAX_TRACE_EVENTS && index >= 0; index--) {
    retained.add(index);
  }
  const events = [...retained]
    .sort((left, right) => left - right)
    .slice(0, MAX_TRACE_EVENTS)
    .map((index) => projectTrajectoryEvent(ordered[index]!));
  return { eventState: 'sampled', events };
}

function projectTrajectoryTraces(records: TrajectoryRecord[]): TrajectoryTraceSummary {
  const state = dispatchTraceReadStateByRecords.get(records) ?? 'available';
  // A partial dispatch ledger cannot establish a reliable route-to-outcome
  // population. Preserve the health truth, but do not publish partial traces.
  if (state !== 'available') return { state, records: [] };
  const projected = records
    .filter((record) => record.coverage.dispatch)
    .sort((left, right) => eventMs(right.latestAt) - eventMs(left.latestAt) || trajectoryRef(left).localeCompare(trajectoryRef(right)))
    .slice(0, 5)
    .map((record): TrajectoryTrace => {
      const projectedEvents = projectTrajectoryEvents(record.timeline);
      return {
        ref: trajectoryRef(record),
        latestAt: traceTimestamp(record.latestAt),
        terminalOutcome: record.terminalOutcome,
        ...(record.realizedOutcome ? { realizedOutcome: record.realizedOutcome } : {}),
        coverage: (({ skillUse: _skillUse, ...coverage }) => coverage)(record.coverage),
        sourceState: traceSourceState(record),
        ...projectedEvents,
      };
    });
  return { state: 'available', records: projected };
}

function traceReadState(quality: TrajectoryTraceReadQuality | undefined): TrajectoryTraceSummary['state'] {
  if (!quality) return 'available';
  if (quality.sourceState === 'missing') return 'unavailable';
  return quality.sourceState === 'healthy' && quality.complete ? 'available' : 'degraded';
}

function failedTraceRead(): TrajectoryTraceReadQuality {
  return { sourceState: 'degraded', complete: false };
}

function combinedTraceReadState(...qualities: Array<TrajectoryTraceReadQuality | undefined>): TrajectoryTraceSummary['state'] {
  const states = qualities.map(traceReadState);
  if (states.includes('degraded')) return 'degraded';
  return states.includes('unavailable') ? 'unavailable' : 'available';
}

function generatedRepairRouteReason(value: unknown): GeneratedRepairRouteReason {
  switch (value) {
    case 'feasible':
    case 'provenance-unavailable':
    case 'lifecycle-unavailable':
    case 'editing-backend-unavailable':
    case 'same-tier-backend-unavailable':
    case 'same-tier-alternative-unavailable':
    case 'inspection-unavailable':
    case 'route-capacity-unavailable':
      return value;
    default:
      return 'inspection-unavailable';
  }
}

function emptyRouteReasonCounts(): Record<GeneratedRepairRouteReason, number> {
  return {
    feasible: 0,
    'provenance-unavailable': 0,
    'lifecycle-unavailable': 0,
    'editing-backend-unavailable': 0,
    'same-tier-backend-unavailable': 0,
    'same-tier-alternative-unavailable': 0,
    'inspection-unavailable': 0,
    'route-capacity-unavailable': 0,
  };
}

function isActionOnlyPreclaimRoute(record: TrajectoryRecord): boolean {
  return !record.coverage.dispatch &&
    record.coverage.agentAction &&
    record.labelBasis === 'preclaim-route-feasibility' &&
    record.routeSnapshot?.assignedBy === 'preclaim-route-inspection';
}

function decisionTerminalOutcome(
  action: OutcomeRecordDecision['action'],
  realizedMerge: boolean,
): TrajectoryTerminalOutcome | null {
  if (action === 'merged') return realizedMerge ? 'merged' : null;
  if (action === 'rejected') return 'rejected';
  if (action === 'handoff') return 'handoff';
  if (action === 'escalated') return 'pending';
  return null;
}

function dispatchTerminalOutcome(event: DispatchProductionEvent): TrajectoryTerminalOutcome {
  if (event.proposalCreated) return 'pending';
  const classification = classifyProductionAttemptForLearningWithLabel({
    outcome: event.outcome,
    proposalCreated: event.proposalCreated,
    actionCounts: event.runEventSummary?.actionCounts,
    reason: event.reason ?? event.routeReason,
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  }, event.learningLabel);
  if (classification.kind === 'cancelled') return 'cancelled';
  if (event.outcome === 'empty-diff' || event.outcome === 'proposal-disabled') return 'no-proposal';
  if (
    event.outcome === 'engine-failed' ||
    event.outcome === 'sandbox-failed' ||
    event.outcome === 'gate-blocked' ||
    event.outcome === 'proposal-capture-error'
  ) return 'failed';
  return 'unknown';
}

function outcomeProposalTerminal(status: string, realizedMerge: boolean): TrajectoryTerminalOutcome {
  if (status === 'applied') return realizedMerge ? 'merged' : 'unknown';
  if (status === 'rejected') return 'rejected';
  if (status === 'pending') return 'pending';
  return 'unknown';
}

function makeRecord(id: string, key: string, ts: string): MutableTrajectoryRecord {
  return {
    version: 1,
    id,
    key,
    startedAt: ts,
    latestAt: ts,
    terminalOutcome: 'unknown',
    coverage: {
      dispatch: false,
      proposal: false,
      evidence: false,
      decision: false,
      agentAction: false,
      skillUse: false,
    },
    aliases: new Set([key]),
    timeline: [],
  };
}

function findOrCreateRecord(
  records: Map<string, MutableTrajectoryRecord>,
  aliasToRecord: Map<string, string>,
  aliases: string[],
  fallbackKey: string,
  ts: string,
): MutableTrajectoryRecord | undefined {
  const existingIds = new Set(
    aliases
      .map((candidate) => aliasToRecord.get(candidate))
      .filter((recordId): recordId is string => Boolean(recordId)),
  );
  // A bridge across established trajectories is contradictory evidence. Keep
  // both mappings intact so later joins can detect and quarantine the conflict.
  if (existingIds.size > 1) return undefined;
  const [existingId] = existingIds;
  const id = existingId ?? (aliases[0] ?? fallbackKey);
  let record = records.get(id);
  if (!record) {
    record = makeRecord(id, aliases[0] ?? fallbackKey, ts);
    records.set(id, record);
  }
  const candidates = aliases.length > 0 ? aliases : [fallbackKey];
  for (const candidate of candidates) {
    record.aliases.add(candidate);
    aliasToRecord.set(candidate, record.id);
  }
  return record;
}

function noteTimeline(record: MutableTrajectoryRecord, event: TrajectoryTimelineEvent): void {
  const { semanticEvents: candidateSemanticEvents, ...metadata } = event;
  const semanticSubjectRef = agentSemanticBoundSubjectRef(candidateSemanticEvents, {
    proposalId: event.proposalId,
    runId: event.runId,
    trajectoryId: event.trajectoryId,
  });
  const semanticEvents = semanticSubjectRef
    ? sanitizeAgentSemanticEvents(
        candidateSemanticEvents,
        semanticSubjectRef,
        agentSemanticModelFamily(event.model ?? event.backend),
      )
    : undefined;
  const sanitized = {
    ...sanitizeMetadata(metadata),
    ...(semanticEvents ? { semanticEvents: semanticEvents.map((semanticEvent) => ({ ...semanticEvent })) } : {}),
  } as TrajectoryTimelineEvent;
  record.timeline.push(sanitized);
  record.startedAt = firstTime(record.startedAt, sanitized.ts);
  record.latestAt = activityTime(record.latestAt, sanitized.ts);
}

function decisionSourceQualityRank(
  quality: OutcomeRecord['decisionSourceQuality'],
): number {
  if (!quality) return 0;
  if (quality.sourceState === 'degraded' || !quality.complete) return 3;
  if (quality.sourceState === 'missing') return 2;
  return 1;
}

function fillRecordMetadata(
  record: MutableTrajectoryRecord,
  meta: Partial<Omit<TrajectoryRecord, 'version' | 'id' | 'key' | 'startedAt' | 'latestAt' | 'terminalOutcome' | 'coverage' | 'timeline'>>,
): void {
  if (!record.repo && meta.repo) record.repo = bounded(meta.repo, 500);
  if (!record.itemId && meta.itemId) record.itemId = bounded(meta.itemId, 240);
  if (!record.source && meta.source) record.source = meta.source;
  if (!record.proposalId && meta.proposalId) record.proposalId = bounded(meta.proposalId, 160);
  if (!record.runId && meta.runId) record.runId = bounded(meta.runId, 160);
  if (!record.trajectoryId && meta.trajectoryId && !isDerivedWorkTrajectory(meta.trajectoryId)) {
    record.trajectoryId = bounded(meta.trajectoryId, 240);
  }
  if (record.backend === undefined && meta.backend !== undefined) record.backend = sanitizeMetadata(meta.backend);
  if (record.tier === undefined && meta.tier !== undefined) record.tier = sanitizeMetadata(meta.tier);
  if (record.model === undefined && meta.model !== undefined) record.model = sanitizeMetadata(meta.model);
  if (!record.routeSnapshot && meta.routeSnapshot) record.routeSnapshot = sanitizeMetadata(meta.routeSnapshot);
  if (!record.runEventSummary && meta.runEventSummary) record.runEventSummary = sanitizeMetadata(meta.runEventSummary);
  if (!record.evidenceOutcome && meta.evidenceOutcome) record.evidenceOutcome = sanitizeMetadata(meta.evidenceOutcome);
  if (!record.learningSource && meta.learningSource) record.learningSource = meta.learningSource;
  if (!record.labelBasis && meta.labelBasis) record.labelBasis = meta.labelBasis;
  if (!record.routerPolicyVersion && meta.routerPolicyVersion) record.routerPolicyVersion = bounded(meta.routerPolicyVersion, 120);
  if (!record.learningEpoch && meta.learningEpoch) record.learningEpoch = bounded(meta.learningEpoch, 120);
}

function evidenceEvent(evidence: OutcomeRecordEvidence, proposalId: string, tsFallback: string): TrajectoryTimelineEvent {
  const verification = evidence.verification;
  return {
    ts: evidence.generatedAt || tsFallback,
    kind: 'evidence',
    outcome: verification.passed ? 'passed' : 'failed',
    proposalId,
    ...(evidence.trajectoryId ? { trajectoryId: evidence.trajectoryId } : {}),
    ...(evidence.routeSnapshot ? { routeSnapshot: evidence.routeSnapshot } : {}),
    ...(evidence.runEventSummary ? { runEventSummary: evidence.runEventSummary } : {}),
    ...(evidence.evidenceOutcome ? { evidenceOutcome: evidence.evidenceOutcome } : {}),
    ...(evidence.learningSource ? { learningSource: evidence.learningSource } : {}),
    ...(evidence.labelBasis ? { labelBasis: evidence.labelBasis } : {}),
    ...(evidence.routerPolicyVersion ? { routerPolicyVersion: evidence.routerPolicyVersion } : {}),
    ...(evidence.learningEpoch ? { learningEpoch: evidence.learningEpoch } : {}),
    evidence: {
      target: evidence.target,
      trustBasis: evidence.trustBasis,
      riskClass: evidence.riskClass,
      verificationPassed: verification.passed,
      commandKinds: [...verification.commandKinds],
      ...(verification.baseBranch ? { baseBranch: verification.baseBranch } : {}),
      ...(verification.baseHead ? { baseHead: verification.baseHead } : {}),
      ...(verification.diffHash ? { diffHash: verification.diffHash } : {}),
      ...(verification.verifiedAt ? { verifiedAt: verification.verifiedAt } : {}),
      ...(verification.source ? { source: verification.source } : {}),
      ...(evidence.policy ? { policyAllowed: evidence.policy.allowed } : {}),
    },
  };
}

export function listTrajectoryRecords(opts?: TrajectoryRecordListOptions): TrajectoryRecord[] {
  const windowHours = opts?.windowHours && opts.windowHours > 0 ? opts.windowHours : DEFAULT_WINDOW_HOURS;
  const limit = opts?.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const deps = opts?.deps ?? {};

  const dispatchReadOptions = {
    sinceMs,
    limit: Math.max(limit * 6, 200),
    maxFiles: 3,
  };
  let dispatchReadQuality: TrajectoryTraceReadQuality | undefined;
  let dispatchEvents: DispatchProductionEvent[];
  if (deps.readDispatchProductionEvents) {
    try {
      const read = deps.readDispatchProductionEvents(dispatchReadOptions);
      dispatchEvents = Array.isArray(read) ? read : [];
      dispatchReadQuality = (read as DispatchProductionEvent[] & {
        sourceQuality?: TrajectoryTraceReadQuality;
      }).sourceQuality;
    } catch {
      dispatchEvents = [];
      dispatchReadQuality = failedTraceRead();
    }
  } else {
    try {
      const read = readDispatchProductionEventsDetailed(dispatchReadOptions);
      dispatchReadQuality = read;
      dispatchEvents = read.sourceState === 'healthy' && read.complete ? read.events : [];
    } catch {
      dispatchEvents = [];
      dispatchReadQuality = failedTraceRead();
    }
  }
  const dispatches = dispatchEvents
    .filter((event) =>
      event.basis !== 'repair-lifecycle-candidate' && event.basis !== 'repair-lifecycle-outcome'
    )
    .slice(0, Math.max(limit * 3, 100));
  let outcomeReadQuality: TrajectoryTraceReadQuality | undefined;
  let outcomes: OutcomeRecord[];
  try {
    const read = (deps.listOutcomeRecords ?? listOutcomeRecords)({ limit: Math.max(limit * 3, 100) });
    outcomes = Array.isArray(read) ? read : [];
    outcomeReadQuality = (read as OutcomeRecord[] & { sourceQuality?: TrajectoryTraceReadQuality }).sourceQuality;
  } catch {
    outcomes = [];
    outcomeReadQuality = failedTraceRead();
  }
  let actionReadQuality: TrajectoryTraceReadQuality | undefined;
  let actions: ReturnType<typeof readAgentActions>;
  try {
    const read = deps.readAgentActions
      ? deps.readAgentActions({
        sinceMs,
        limit: Math.max(limit * 4, 200),
        maxFiles: 3,
      })
      : readAgentActions({
        sinceMs,
        limit: Math.max(limit * 4, 200),
        maxFiles: 3,
        requireComplete: true,
      });
    actions = Array.isArray(read) ? read : [];
    actionReadQuality = (read as typeof actions & { sourceQuality?: TrajectoryTraceReadQuality }).sourceQuality;
  } catch {
    actions = [];
    actionReadQuality = failedTraceRead();
  }
  const agentActionSourceQuality = (actions as typeof actions & {
    sourceQuality?: AgentActionSourceQuality;
  }).sourceQuality;
  const skillUses = safeArray(() =>
    (deps.readSkillUseEvents ?? readSkillUseEvents)({
      sinceMs,
      limit: Math.max(limit * 8, 400),
      maxFiles: 3,
    }),
  );

  const records = new Map<string, MutableTrajectoryRecord>();
  const aliasToRecord = new Map<string, string>();

  const processDispatch = (event: DispatchProductionEvent): void => {
    const proposalId = cleanId(event.proposalId, 160);
    const runId = cleanId(event.runId, 160);
    const trajectoryId = cleanId(event.trajectoryId, 240);
    const repo = bounded(event.repo, 500, 'unknown');
    const itemId = bounded(event.itemId, 240, 'unknown');
    const fallbackKey = fallbackTrajectoryKey({
      ts: event.ts,
      repo,
      itemId,
      runId,
      proposalId,
      outcome: event.outcome,
      backend: event.backend,
    });
    const record = findOrCreateRecord(
      records,
      aliasToRecord,
      aliasesFromIds({ trajectoryId, runId, proposalId }),
      fallbackKey,
      event.ts,
    );
    if (!record) return;
    fillRecordMetadata(record, {
      repo,
      itemId,
      source: event.source,
      proposalId,
      runId,
      trajectoryId,
      backend: event.backend,
      tier: event.tier,
      model: event.model,
      routeSnapshot: event.routeSnapshot,
      runEventSummary: event.runEventSummary,
      evidenceOutcome: event.evidenceOutcome,
      learningSource: event.learningSource,
      labelBasis: event.labelBasis,
      routerPolicyVersion: event.routerPolicyVersion,
      learningEpoch: event.learningEpoch,
    });
    record.coverage.dispatch = true;
    record.terminalOutcome = betterTerminalOutcome(record.terminalOutcome, dispatchTerminalOutcome(event));
    noteTimeline(record, {
      ts: event.ts,
      kind: 'dispatch',
      outcome: event.outcome,
      repo,
      itemId,
      source: event.source,
      backend: event.backend,
      tier: event.tier,
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(proposalId ? { proposalId } : {}),
      ...(runId ? { runId } : {}),
      ...(trajectoryId && !isDerivedWorkTrajectory(trajectoryId) ? { trajectoryId } : {}),
      ...(event.reason ? { reason: bounded(event.reason, 180) } : { reason: bounded(event.routeReason, 180) }),
      ...(event.routeSnapshot ? { routeSnapshot: event.routeSnapshot } : {}),
      ...(event.runEventSummary ? { runEventSummary: event.runEventSummary } : {}),
      ...(event.evidenceOutcome ? { evidenceOutcome: event.evidenceOutcome } : {}),
      ...(event.learningSource ? { learningSource: event.learningSource } : {}),
      ...(event.labelBasis ? { labelBasis: event.labelBasis } : {}),
      ...(event.routerPolicyVersion ? { routerPolicyVersion: event.routerPolicyVersion } : {}),
      ...(event.learningEpoch ? { learningEpoch: event.learningEpoch } : {}),
    });
  };

  const processOutcome = (outcome: OutcomeRecord): void => {
    const proposal = outcome.proposal;
    const liveProposal = safeValue(() => (deps.loadProposal ?? loadProposal)(proposal.id));
    const realizedMerge = liveProposal?.id === proposal.id && liveProposal.status === 'applied' &&
      hasRealizedMergeEvidence(liveProposal);
    const aliases = aliasesFromIds({
      trajectoryId: proposal.trajectoryId,
      runId: proposal.runId,
      proposalId: proposal.id,
    });
    const fallbackKey = alias('proposal', proposal.id) ?? `proposal:${proposal.id}`;
    const record = findOrCreateRecord(records, aliasToRecord, aliases, fallbackKey, proposal.createdAt);
    if (!record) return;
    fillRecordMetadata(record, {
      repo: proposal.repo ?? undefined,
      itemId: proposal.workItemId,
      source: proposal.workSource,
      proposalId: proposal.id,
      runId: proposal.runId,
      trajectoryId: proposal.trajectoryId,
      backend: proposal.routeSnapshot?.backend,
      tier: proposal.routeSnapshot?.tier,
      model: proposal.routeSnapshot?.model,
      routeSnapshot: proposal.routeSnapshot,
      runEventSummary: proposal.runEventSummary,
      evidenceOutcome: proposal.evidenceOutcome,
      learningSource: proposal.learningSource,
      labelBasis: proposal.labelBasis,
      routerPolicyVersion: proposal.routerPolicyVersion,
      learningEpoch: proposal.learningEpoch,
    });
    if (outcome.decisionSourceQuality && decisionSourceQualityRank(outcome.decisionSourceQuality) >
      decisionSourceQualityRank(record.decisionSourceQuality)) {
      record.decisionSourceQuality = sanitizeMetadata(outcome.decisionSourceQuality);
    }
    record.coverage.proposal = true;
    record.terminalOutcome = betterTerminalOutcome(
      record.terminalOutcome,
      outcomeProposalTerminal(proposal.status, realizedMerge),
    );
    noteTimeline(record, {
      ts: proposal.createdAt,
      kind: 'proposal',
      outcome: proposal.status,
      proposalId: proposal.id,
      repo: proposal.repo ?? undefined,
      itemId: proposal.workItemId,
      source: proposal.workSource,
      runId: proposal.runId,
      trajectoryId: proposal.trajectoryId,
      routeSnapshot: proposal.routeSnapshot,
      runEventSummary: proposal.runEventSummary,
      evidenceOutcome: proposal.evidenceOutcome,
      learningSource: proposal.learningSource,
      labelBasis: proposal.labelBasis,
      routerPolicyVersion: proposal.routerPolicyVersion,
      learningEpoch: proposal.learningEpoch,
      proposal: {
        status: proposal.status,
        origin: proposal.origin,
        kind: proposal.kind,
        title: bounded(proposal.title, 120, 'untitled'),
        ...(proposal.riskClass ? { riskClass: proposal.riskClass } : {}),
        ...(proposal.verifyResult ? { verifyPassed: proposal.verifyResult.passed } : {}),
        ...(proposal.diffHash ? { diffHash: proposal.diffHash } : {}),
      },
    });

    for (const evidence of outcome.evidencePacks) {
      record.coverage.evidence = true;
      fillRecordMetadata(record, {
        trajectoryId: evidence.trajectoryId,
        routeSnapshot: evidence.routeSnapshot,
        runEventSummary: evidence.runEventSummary,
        evidenceOutcome: evidence.evidenceOutcome,
        learningSource: evidence.learningSource,
        labelBasis: evidence.labelBasis,
        routerPolicyVersion: evidence.routerPolicyVersion,
        learningEpoch: evidence.learningEpoch,
      });
      noteTimeline(record, evidenceEvent(evidence, proposal.id, proposal.createdAt));
    }

    for (const decision of outcome.decisions) {
      record.coverage.decision = true;
      fillRecordMetadata(record, {
        itemId: decision.workItemId,
        source: decision.workSource,
        runId: decision.runId,
        trajectoryId: decision.trajectoryId,
        routeSnapshot: decision.routeSnapshot,
        runEventSummary: decision.runEventSummary,
        evidenceOutcome: decision.evidenceOutcome,
        learningSource: decision.learningSource,
        labelBasis: decision.labelBasis,
        routerPolicyVersion: decision.routerPolicyVersion,
        learningEpoch: decision.learningEpoch,
      });
      const terminal = decisionTerminalOutcome(decision.action, realizedMerge);
      if (terminal) record.terminalOutcome = betterTerminalOutcome(record.terminalOutcome, terminal);
      noteTimeline(record, {
        ts: decision.ts,
        kind: 'decision',
        outcome: decision.verdict ?? decision.action,
        action: decision.action,
        proposalId: proposal.id,
        itemId: decision.workItemId,
        source: decision.workSource,
        runId: decision.runId,
        trajectoryId: decision.trajectoryId,
        ...(decision.reason ? { reason: bounded(decision.reason, 180) } : {}),
        ...(decision.engine ? { backend: decision.engine } : {}),
        ...(decision.model ? { model: decision.model } : {}),
        ...(decision.routeSnapshot ? { routeSnapshot: decision.routeSnapshot } : {}),
        ...(decision.runEventSummary ? { runEventSummary: decision.runEventSummary } : {}),
        ...(decision.evidenceOutcome ? { evidenceOutcome: decision.evidenceOutcome } : {}),
        ...(decision.learningSource ? { learningSource: decision.learningSource } : {}),
        ...(decision.labelBasis ? { labelBasis: decision.labelBasis } : {}),
        ...(decision.routerPolicyVersion ? { routerPolicyVersion: decision.routerPolicyVersion } : {}),
        ...(decision.learningEpoch ? { learningEpoch: decision.learningEpoch } : {}),
        ...(decision.semanticEvents && (
          outcome.decisionSourceQuality === undefined || (
            outcome.decisionSourceQuality.sourceState === 'healthy' &&
            outcome.decisionSourceQuality.complete
          )
        ) ? { semanticEvents: decision.semanticEvents } : {}),
      });
    }

    for (const observation of outcome.postMergeObservations ?? []) {
      if (observation.confidence === 'deterministic') {
        record.realizedOutcome = betterRealizedOutcome(record.realizedOutcome, observation.outcome);
      }
      noteTimeline(record, {
        ts: observation.observedAt,
        kind: 'post-merge',
        outcome: observation.outcome,
        proposalId: proposal.id,
        runId: observation.runId ?? proposal.runId,
        trajectoryId: observation.trajectoryId ?? proposal.trajectoryId,
        repo: observation.repo,
        itemId: observation.workItemId ?? proposal.workItemId,
        learningSource: 'outcome-record',
        labelBasis: observation.labelBasis,
        postMergeEvidence: {
          basis: observation.basis,
          confidence: observation.confidence,
          ...(observation.candidateCount ? { candidateCount: observation.candidateCount } : {}),
          ...(observation.commandKinds ? { commandKinds: observation.commandKinds } : {}),
        },
      });
    }
  };

  const processAction = (action: ReturnType<typeof readAgentActions>[number]): void => {
    const proposalId = cleanId(action.proposalId, 160);
    const runId = cleanId(action.runId, 160);
    const trajectoryId = cleanId(action.trajectoryId, 240);
    const aliases = aliasesFromIds({ trajectoryId, runId, proposalId });
    if (aliases.length === 0) return;
    const fallbackKey = fallbackTrajectoryKey({
      ts: action.ts,
      repo: action.repo,
      itemId: action.itemId,
      runId,
      proposalId,
      outcome: action.outcome,
      backend: action.backend,
    });
    const record = findOrCreateRecord(records, aliasToRecord, aliases, fallbackKey, action.ts);
    if (!record) return;
    fillRecordMetadata(record, {
      repo: action.repo,
      itemId: action.itemId,
      source: action.source,
      proposalId,
      runId,
      trajectoryId,
      backend: action.backend,
      tier: action.tier,
      model: action.model,
      routeSnapshot: action.routeSnapshot,
      runEventSummary: action.runEventSummary,
      evidenceOutcome: action.evidenceOutcome,
      learningSource: action.learningSource,
      labelBasis: action.labelBasis,
      routerPolicyVersion: action.routerPolicyVersion,
      learningEpoch: action.learningEpoch,
    });
    record.coverage.agentAction = true;
    noteTimeline(record, {
      ts: action.ts,
      kind: 'agent-action',
      outcome: action.outcome,
      action: action.action,
      repo: action.repo,
      itemId: action.itemId,
      source: action.source,
      proposalId,
      runId,
      trajectoryId: trajectoryId && !isDerivedWorkTrajectory(trajectoryId) ? trajectoryId : undefined,
      backend: action.backend,
      tier: action.tier,
      model: action.model,
      reason: action.reason ? bounded(action.reason, 180) : bounded(action.summary, 180),
      routeSnapshot: action.routeSnapshot,
      runEventSummary: action.runEventSummary,
      evidenceOutcome: action.evidenceOutcome,
      learningSource: action.learningSource,
      labelBasis: action.labelBasis,
      routerPolicyVersion: action.routerPolicyVersion,
      learningEpoch: action.learningEpoch,
      ...(action.semanticEvents ? { semanticEvents: action.semanticEvents } : {}),
    });
  };

  // The ledgers are independently newest-first. Replay one global causal
  // stream so cross-ledger bridges cannot change meaning with read order.
  const causalEvents = [
    ...dispatches.map((event) => ({ ts: event.ts, rank: 0, apply: () => processDispatch(event) })),
    ...outcomes.map((outcome) => ({
      ts: outcome.proposal.createdAt,
      rank: 1,
      apply: () => processOutcome(outcome),
    })),
    ...actions.map((action) => ({ ts: action.ts, rank: 2, apply: () => processAction(action) })),
  ].sort((a, b) => eventMs(a.ts) - eventMs(b.ts) || a.rank - b.rank);
  for (const event of causalEvents) event.apply();

  const eligibleRecords = [...records.values()]
    .filter((record) => eventMs(record.latestAt) >= sinceMs)
    .sort((a, b) => eventMs(b.latestAt) - eventMs(a.latestAt) || a.id.localeCompare(b.id));
  const productionRecords = eligibleRecords.filter((record) => record.coverage.dispatch).slice(0, limit);
  const productionRecordIds = new Set(productionRecords.map((record) => record.id));
  const remainingCapacity = Math.max(0, limit - productionRecords.length);
  const diagnosticRecords = eligibleRecords
    .filter((record) => !productionRecordIds.has(record.id))
    .slice(0, remainingCapacity);
  const includedRecords = [...productionRecords, ...diagnosticRecords]
    .sort((a, b) => eventMs(b.latestAt) - eventMs(a.latestAt) || a.id.localeCompare(b.id));
  const includedRecordIds = new Set(includedRecords.map((record) => record.id));
  const skillObservation = emptySkillObservationCounts();
  const selectionKeysByRecord = new Map<string, Set<string>>();
  const skillObservationByRecordId = new Map<string, SkillObservationCounts>();
  for (const event of skillUses) {
    const aliases = aliasesFromIds({
      trajectoryId: cleanId(event.trajectoryId, 240),
      runId: cleanId(event.runId, 160),
      proposalId: cleanId(event.proposalId, 160),
    });
    const resolvedRecordIds = new Set(
      aliases
        .map((candidate) => aliasToRecord.get(candidate))
        .filter((recordId): recordId is string => Boolean(recordId)),
    );
    if (resolvedRecordIds.size === 0) {
      skillObservation.unjoined++;
      continue;
    }
    if (resolvedRecordIds.size !== 1) {
      skillObservation.conflicting++;
      continue;
    }
    const [recordId] = resolvedRecordIds;
    const record = recordId && includedRecordIds.has(recordId) ? records.get(recordId) : undefined;
    if (!record) {
      skillObservation.unjoined++;
      continue;
    }
    const selectionIdentity = skillSelectionIdentity(event);
    const selectionKeys = selectionKeysByRecord.get(record.id) ?? new Set<string>();
    if (selectionKeys.has(selectionIdentity)) continue;
    selectionKeys.add(selectionIdentity);
    selectionKeysByRecord.set(record.id, selectionKeys);
    record.coverage.skillUse = true;
    skillObservation.joined++;
    skillObservation.modeCounts[event.mode]++;
    skillObservation.stageCounts[event.stage]++;
    const recordObservation = skillObservationByRecordId.get(record.id) ?? emptySkillObservationCounts();
    recordObservation.joined++;
    recordObservation.modeCounts[event.mode]++;
    recordObservation.stageCounts[event.stage]++;
    skillObservationByRecordId.set(record.id, recordObservation);
  }

  const result = includedRecords
    .map((record): TrajectoryRecord => {
      const timeline = record.timeline
        .sort((a, b) => {
          const time = eventMs(a.ts) - eventMs(b.ts);
          if (time !== 0) return time;
          return timelineRank(a.kind) - timelineRank(b.kind) || a.kind.localeCompare(b.kind);
        })
        .slice(-40);
      const { aliases: _aliases, ...publicRecord } = record;
      const resultRecord: TrajectoryRecord = {
        ...publicRecord,
        ...(agentActionSourceQuality ? { agentActionSourceQuality } : {}),
        timeline,
        terminalOutcome: record.terminalOutcome === 'unknown' && record.coverage.proposal
          ? 'pending'
          : record.terminalOutcome,
      };
      skillObservationByRecord.set(
        resultRecord,
        skillObservationByRecordId.get(record.id) ?? emptySkillObservationCounts(),
      );
      skillObservationDiagnosticsByRecord.set(resultRecord, {
        unjoined: skillObservation.unjoined,
        conflicting: skillObservation.conflicting,
      });
      return resultRecord;
    });
  skillObservationByRecords.set(result, skillObservation);
  dispatchTraceReadStateByRecords.set(
    result,
    combinedTraceReadState(dispatchReadQuality, outcomeReadQuality, actionReadQuality),
  );
  return result;
}

export function summarizeTrajectoryLearning(
  records: TrajectoryRecord[],
  windowHours = DEFAULT_WINDOW_HOURS,
): TrajectoryLearningStatus {
  const productionRecords = records.filter((record) => record.coverage.dispatch);
  const denominator = productionRecords.length;
  const terminalOutcomes: Record<TrajectoryTerminalOutcome, number> = {
    merged: 0,
    rejected: 0,
    handoff: 0,
    pending: 0,
    'no-proposal': 0,
    cancelled: 0,
    failed: 0,
    unknown: 0,
  };
  const realizedOutcomes: Record<TrajectoryRealizedOutcome, number> = {
    'followed-up': 0,
    reverted: 0,
    regressed: 0,
  };
  const coverageCounts: Record<keyof TrajectoryRecordCoverage, number> = {
    dispatch: 0,
    proposal: 0,
    evidence: 0,
    decision: 0,
    agentAction: 0,
    skillUse: 0,
  };
  const gapSamples: Record<keyof TrajectoryRecordCoverage, string[]> = {
    dispatch: [],
    proposal: [],
    evidence: [],
    decision: [],
    agentAction: [],
    skillUse: [],
  };
  let dispatchToDecision = 0;
  let dispatchToEvidence = 0;
  let dispatchToMerge = 0;

  for (const record of productionRecords) {
    terminalOutcomes[record.terminalOutcome]++;
    if (record.realizedOutcome) realizedOutcomes[record.realizedOutcome]++;
    for (const key of Object.keys(coverageCounts) as Array<keyof TrajectoryRecordCoverage>) {
      if (record.coverage[key]) {
        coverageCounts[key]++;
      } else if (gapSamples[key].length < 5) {
        gapSamples[key].push(trajectoryRef(record));
      }
    }
    if (record.coverage.dispatch && record.coverage.decision) dispatchToDecision++;
    if (record.coverage.dispatch && record.coverage.evidence) dispatchToEvidence++;
    if (record.coverage.dispatch && record.terminalOutcome === 'merged') dispatchToMerge++;
  }

  const coverage: Record<keyof TrajectoryRecordCoverage, TrajectoryCoverageMetric> = {
    dispatch: metric(coverageCounts.dispatch, denominator),
    proposal: metric(coverageCounts.proposal, denominator),
    evidence: metric(coverageCounts.evidence, denominator),
    decision: metric(coverageCounts.decision, denominator),
    agentAction: metric(coverageCounts.agentAction, denominator),
    skillUse: metric(coverageCounts.skillUse, denominator),
  };
  const dispatchDenominator = coverageCounts.dispatch;
  const gaps = (Object.keys(coverageCounts) as Array<keyof TrajectoryRecordCoverage>)
    .filter((kind) => kind !== 'skillUse')
    .map((kind) => ({
      kind,
      count: denominator - coverageCounts[kind],
      sampleRefs: gapSamples[kind],
    }))
    .filter((gap) => gap.count > 0)
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const batchObservation = skillObservationByRecords.get(records);
  const recordDiagnostics = records
    .map((record) => skillObservationDiagnosticsByRecord.get(record))
    .find((diagnostics) => diagnostics !== undefined);
  const recordObservations = productionRecords
    .map((record) => skillObservationByRecord.get(record))
    .filter((observation): observation is SkillObservationCounts => Boolean(observation));
  const skillObservation = recordObservations.length > 0
    ? recordObservations.reduce((total, observation) => {
        total.joined += observation.joined;
        for (const mode of Object.keys(total.modeCounts) as SkillUseMode[]) {
          total.modeCounts[mode] += observation.modeCounts[mode];
        }
        for (const stage of Object.keys(total.stageCounts) as SkillUseStage[]) {
          total.stageCounts[stage] += observation.stageCounts[stage];
        }
        return total;
      }, {
        ...emptySkillObservationCounts(),
        unjoined: batchObservation?.unjoined ?? recordDiagnostics?.unjoined ?? 0,
        conflicting: batchObservation?.conflicting ?? recordDiagnostics?.conflicting ?? 0,
      })
    : (batchObservation ?? emptySkillObservationCounts());
  const rawObservedTrajectoryCoverage = metric(coverageCounts.skillUse, denominator);
  const eventState = skillObservation.joined + skillObservation.unjoined + skillObservation.conflicting > 0
    ? 'present'
    : 'none';
  const sampleState = rawObservedTrajectoryCoverage.count === 0
    ? 'none'
    : rawObservedTrajectoryCoverage.count < MIN_SKILL_OBSERVED_TRAJECTORIES
      ? 'insufficient-sample'
      : 'observed';
  const publishSkillMetrics = sampleState === 'observed';
  const observedTrajectoryCoverage = publishSkillMetrics
    ? rawObservedTrajectoryCoverage
    : metric(0, denominator);
  const { skillUse: _privateSkillCoverage, ...publishedCoverage } = coverage;
  const diagnosticRecords = records.filter(isActionOnlyPreclaimRoute);
  const routeReasonCounts = emptyRouteReasonCounts();
  for (const record of diagnosticRecords) {
    routeReasonCounts[generatedRepairRouteReason(record.routeSnapshot?.reason)]++;
  }

  return {
    version: 1,
    windowHours,
    trajectories: denominator,
    terminalOutcomes,
    realizedOutcomes,
    coverage: publishSkillMetrics
      ? coverage
      : publishedCoverage,
    routeSpine: {
      dispatchToDecision: metric(dispatchToDecision, dispatchDenominator),
      dispatchToEvidence: metric(dispatchToEvidence, dispatchDenominator),
      dispatchToMerge: metric(dispatchToMerge, dispatchDenominator),
    },
    ...(diagnosticRecords.length > 0 ? {
      routeDiagnostics: {
        trajectories: diagnosticRecords.length,
        reasonCounts: routeReasonCounts,
      },
    } : {}),
    skillObservation: publishSkillMetrics
      ? {
          joined: skillObservation.joined,
          unjoined: skillObservation.unjoined,
          conflicting: skillObservation.conflicting,
          observedTrajectoryCoverage,
          modeCounts: { ...skillObservation.modeCounts },
          stageCounts: { ...skillObservation.stageCounts },
          eventState,
          sampleState,
        }
      : { eventState, sampleState },
    traces: projectTrajectoryTraces(records),
    gaps,
    recent: productionRecords.slice(0, 8).map((record) => ({
      ref: trajectoryRef(record),
      latestAt: record.latestAt,
      terminalOutcome: record.terminalOutcome,
      ...(record.realizedOutcome ? { realizedOutcome: record.realizedOutcome } : {}),
      ...(record.backend !== undefined ? { backend: record.backend } : {}),
      ...(record.source ? { source: record.source } : {}),
      coverage: publishSkillMetrics
        ? record.coverage
        : (({ skillUse: _skillUse, ...publicCoverage }) => publicCoverage)(record.coverage),
    })),
  };
}

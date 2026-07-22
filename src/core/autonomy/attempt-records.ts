/**
 * Read-only attempt records for privacy-safe fleet learning coverage.
 *
 * Dispatch-production rows are the root. This module joins only by exact
 * causal ids, proposal ids, or a narrow legacy repo+item timestamp fallback.
 * It never persists a new ledger and never returns raw prompts, diffs,
 * stdout/stderr, env, file contents, command argv, judge detail, or evidence
 * detail.
 */

import { createHash } from 'node:crypto';
import type { AgentActionEvent, AgentActionSourceQuality } from '../fleet/agent-action-ledger.js';
import { readAgentActions } from '../fleet/agent-action-ledger.js';
import type { DispatchProductionEvent } from '../fleet/dispatch-production-ledger.js';
import {
  readDispatchProductionEvents,
  readDispatchProductionEventsDetailed,
} from '../fleet/dispatch-production-ledger.js';
import type { OutcomeRecord } from './outcome-records.js';
import { listOutcomeRecords } from './outcome-records.js';
import type { EngineId, EngineTier, Proposal, RunActionCounts, WorkItem } from '../types.js';
import { readDecisions } from '../fleet/decisions-ledger.js';
import { listAutonomyEvidencePacks, readAutonomyEvidencePack, type AutonomyEvidencePack } from './evidence-pack.js';
import { loadProposal } from '../inbox/store.js';
import type { WorkedEvent, WorkedLedger } from '../fleet/worked-ledger.js';
import { loadWorkedLedger } from '../fleet/worked-ledger.js';
import {
  ROUTER_POLICY_VERSION,
  learningEpochFromTimestamp,
  runEventSummary as sanitizeRunEventSummary,
} from '../learning/causal.js';
import {
  addProductionAttemptShape,
  classifyProductionAttemptForLearningWithLabel,
  emptyProductionAttemptShape,
  generatedRepairAttemptKindFromSignals,
  sanitizeProductionAttemptLearningLabel,
  type GeneratedRepairAttemptKind,
  type ProductionAttemptLearningKind,
} from '../learning/attempt-shape.js';
import type { ProductionAttemptShape } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 500;
const JOIN_WINDOW_MS = 10 * 60 * 1000;
const CAUSAL_WEAK_MIN_ATTEMPTS = 3;
const CAUSAL_FOUNDATION_THRESHOLD = 0.95;
const CAUSAL_LABEL_THRESHOLD = 0.8;

export interface AttemptRecordCoverage {
  agentAction: boolean;
  outcomeRecord: boolean;
  decision: boolean;
  evidence: boolean;
  worked: boolean;
}

export interface AttemptCausalCoverage {
  trajectoryId: boolean;
  routeSnapshot: boolean;
  runEventSummary: boolean;
  routerPolicyVersion: boolean;
  currentRouterPolicyVersion: boolean;
  learningEpoch: boolean;
  currentLearningEpoch: boolean;
  labelAuthoritative: boolean;
  currentAuthoritativeLabel: boolean;
}

export interface AttemptRecord {
  version: 1;
  id: string;
  ts: string;
  repo: string;
  itemId: string;
  source: WorkItem['source'];
  title: string;
  outcome: DispatchProductionEvent['outcome'];
  proposalCreated: boolean;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  backend?: EngineId | null;
  tier?: EngineTier | null;
  model?: string | null;
  routeReason: string;
  reason?: string;
  actionCounts?: RunActionCounts;
  attemptShape: ProductionAttemptShape;
  policySuppressed: boolean;
  diagnosticNoProposal: boolean;
  diagnosticAttempt: boolean;
  learningKind: ProductionAttemptLearningKind;
  labelAuthoritative: boolean;
  learningSource?: string;
  labelBasis?: string;
  coverage: AttemptRecordCoverage;
  causalCoverage: AttemptCausalCoverage;
}

export type AttemptCausalGapCause =
  | 'legacy-unlabeled-attempt'
  | 'current-writer-unlabeled-attempt'
  | 'missing-authoritative-label'
  | 'policy-suppressed'
  | 'stale-authoritative-label'
  | 'missing-trajectory-id'
  | 'missing-route-snapshot'
  | 'missing-run-summary'
  | 'missing-router-policy-version'
  | 'stale-router-policy-version'
  | 'missing-learning-epoch'
  | 'stale-learning-epoch';

export interface AttemptCausalGapGroup {
  key: string;
  count: number;
  sampleRefs: string[];
}

export interface AttemptCausalGapDiagnostics {
  blockedCurrentLabels: number;
  causes: Array<{ cause: AttemptCausalGapCause; count: number; sampleRefs: string[] }>;
  actionableCauses: Array<{ cause: AttemptCausalGapCause; count: number; sampleRefs: string[] }>;
  bySource: AttemptCausalGapGroup[];
  byBackend: AttemptCausalGapGroup[];
  byLearningSource: AttemptCausalGapGroup[];
  byLabelBasis: AttemptCausalGapGroup[];
  byLearningKind: AttemptCausalGapGroup[];
}

export interface AttemptCoverageMetric {
  count: number;
  rate: number;
}

export interface AttemptGeneratedRepairSummary {
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  captureRepairs: number;
  diagnosticReslices: number;
  proposalRepairs: number;
}

export interface AttemptCoverageStatus {
  /** Completeness of the agent-action join; independent dispatch facts remain valid when degraded. */
  agentActionSource?: AgentActionSourceQuality;
  windowHours: number;
  attempts: number;
  recent: Array<{
    ref: string;
    ts: string;
    outcome: string;
    backend?: EngineId | null;
    learningKind?: ProductionAttemptLearningKind;
    diagnosticAttempt?: boolean;
    policySuppressed?: boolean;
    labelAuthoritative?: boolean;
    coverage: Partial<AttemptRecordCoverage>;
    causalCoverage: AttemptCausalCoverage;
  }>;
  coverage: Partial<{
    agentAction: AttemptCoverageMetric;
    outcomeRecord: AttemptCoverageMetric;
    decision: AttemptCoverageMetric;
    evidence: AttemptCoverageMetric;
    worked: AttemptCoverageMetric;
  }>;
  causalCoverage: {
    trajectoryId: AttemptCoverageMetric;
    routeSnapshot: AttemptCoverageMetric;
    runEventSummary: AttemptCoverageMetric;
    routerPolicyVersion: AttemptCoverageMetric;
    currentRouterPolicyVersion: AttemptCoverageMetric;
    learningEpoch: AttemptCoverageMetric;
    currentLearningEpoch: AttemptCoverageMetric;
    labelAuthoritative: AttemptCoverageMetric;
    currentAuthoritativeLabel: AttemptCoverageMetric;
  };
  causalWeak: {
    weak: boolean;
    minAttempts: number;
    threshold: number;
    labelThreshold: number;
    reasons: Array<{
      kind: keyof AttemptCausalCoverage;
      count: number;
      rate: number;
      threshold: number;
      denominator?: number;
      sampleRefs: string[];
    }>;
  };
  causalGapDiagnostics: AttemptCausalGapDiagnostics;
  production: {
    attempts: number;
    proposalCreated: number;
    cancelled?: number;
    policySuppressed: number;
    labelAuthoritativeAttempts: number;
    legacyUnversionedAttempts: number;
    diagnosticAttempts: number;
    diagnosticNoProposal: number;
    diagnosticProposalRate: number | null;
    diagnosticNoProposalRate: number | null;
    attemptShape: ProductionAttemptShape;
    generatedRepairAttempts?: AttemptGeneratedRepairSummary;
  };
  gaps: Array<{ kind: keyof AttemptRecordCoverage; count: number; sampleRefs: string[] }>;
  causalGaps: Array<{ kind: keyof AttemptCausalCoverage; count: number; sampleRefs: string[] }>;
}

export interface AttemptRecordReadDeps {
  readDispatchProductionEvents?: typeof readDispatchProductionEvents;
  readAgentActions?: typeof readAgentActions;
  listOutcomeRecords?: (opts?: { limit?: number }) => OutcomeRecord[];
  loadProposal?: (id: string) => Proposal | null;
  readDecisions?: typeof readDecisions;
  listAutonomyEvidencePacks?: typeof listAutonomyEvidencePacks;
  readAutonomyEvidencePack?: (proposalId: string) => AutonomyEvidencePack | null;
  loadWorkedLedger?: () => WorkedLedger;
}

export interface AttemptRecordListOptions {
  windowHours?: number;
  limit?: number;
  deps?: AttemptRecordReadDeps;
  /** Keep production default readers for dependencies not explicitly injected. */
  useDefaultReaders?: boolean;
}

function bounded(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const stripped = scrubSecrets(value)
    .replace(/\bRAW_[A-Z0-9_]*(?:SECRET|CANARY)[A-Z0-9_]*\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return fallback;
  return stripped.length > max ? `${stripped.slice(0, max - 3)}...` : stripped;
}

function eventMs(ts: string | undefined): number | null {
  const parsed = Date.parse(ts ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function safeArray<T>(read: () => T[] | undefined): T[] {
  try {
    const value = read();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function safeValue<T>(read: () => T | null | undefined): T | undefined {
  try {
    const value = read();
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

function safeWorked(read: () => WorkedLedger | undefined): WorkedEvent[] {
  try {
    const value = read();
    return Array.isArray(value?.events) ? value.events : [];
  } catch {
    return [];
  }
}

function mapPush<K, V>(map: Map<K, V[]>, key: K | undefined, value: V): void {
  if (key === undefined || key === null || key === '') return;
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function repoItemKey(repo: string | undefined, itemId: string | undefined): string | undefined {
  return repo && itemId ? `${repo}\0${itemId}` : undefined;
}

function isDerivedWorkTrajectory(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('work:');
}

function attemptId(event: DispatchProductionEvent): string {
  if (event.trajectoryId) return `trajectory:${bounded(event.trajectoryId, 160)}`;
  if (event.runId) return `run:${bounded(event.runId, 160)}`;
  if (event.proposalId) return `proposal:${bounded(event.proposalId, 160)}`;
  const hash = createHash('sha256')
    .update([
      event.ts,
      event.repo,
      event.itemId,
      event.backend ?? '',
      event.model ?? '',
      event.outcome,
    ].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `attempt:${hash}`;
}

function hasTimedFallbackAction(
  event: DispatchProductionEvent,
  actionsByRepoItem: Map<string, AgentActionEvent[]>,
): boolean {
  const key = repoItemKey(event.repo, event.itemId);
  if (!key) return false;
  const attemptTime = eventMs(event.ts);
  if (attemptTime === null) return false;
  return (actionsByRepoItem.get(key) ?? []).some((action) => {
    const actionTime = eventMs(action.ts);
    return actionTime !== null && Math.abs(actionTime - attemptTime) <= JOIN_WINDOW_MS;
  });
}

function hasAgentAction(
  event: DispatchProductionEvent,
  maps: {
    byTrajectory: Map<string, AgentActionEvent[]>;
    byRun: Map<string, AgentActionEvent[]>;
    byProposal: Map<string, AgentActionEvent[]>;
    byRepoItem: Map<string, AgentActionEvent[]>;
  },
): boolean {
  if (event.trajectoryId && !isDerivedWorkTrajectory(event.trajectoryId) && maps.byTrajectory.has(event.trajectoryId)) {
    return true;
  }
  if (event.runId && maps.byRun.has(event.runId)) return true;
  if (event.proposalId && maps.byProposal.has(event.proposalId)) return true;
  return hasTimedFallbackAction(event, maps.byRepoItem);
}

function buildActionMaps(actions: AgentActionEvent[]) {
  const byTrajectory = new Map<string, AgentActionEvent[]>();
  const byRun = new Map<string, AgentActionEvent[]>();
  const byProposal = new Map<string, AgentActionEvent[]>();
  const byRepoItem = new Map<string, AgentActionEvent[]>();
  for (const action of actions) {
    mapPush(byTrajectory, action.trajectoryId, action);
    mapPush(byRun, action.runId, action);
    mapPush(byProposal, action.proposalId, action);
    mapPush(byRepoItem, repoItemKey(action.repo, action.itemId), action);
  }
  return { byTrajectory, byRun, byProposal, byRepoItem };
}

function byProposal<T>(values: T[], readProposalId: (value: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const value of values) mapPush(out, readProposalId(value), value);
  return out;
}

function workedMaps(events: WorkedEvent[]) {
  const byItem = new Map<string, WorkedEvent[]>();
  const byProposal = new Map<string, WorkedEvent[]>();
  for (const event of events) {
    mapPush(byItem, event.itemId, event);
    mapPush(byProposal, event.proposalId, event);
  }
  return { byItem, byProposal };
}

function hasTimedWorkedFallback(
  event: DispatchProductionEvent,
  itemId: string,
  workedByItem: Map<string, WorkedEvent[]>,
): boolean {
  const attemptTime = eventMs(event.ts);
  if (attemptTime === null) return false;
  return (workedByItem.get(itemId) ?? []).some((worked) => {
    const workedTime = eventMs(worked.ts);
    return workedTime !== null && Math.abs(workedTime - attemptTime) <= JOIN_WINDOW_MS;
  });
}

function hasOutcomeRecord(
  proposalId: string,
  outcomesByProposal: Map<string, OutcomeRecord[]>,
  readProposal?: (id: string) => Proposal | null,
): boolean {
  if (!proposalId) return false;
  if (outcomesByProposal.has(proposalId)) return true;
  const proposal = readProposal ? safeValue(() => readProposal(proposalId)) : undefined;
  return proposal?.id === proposalId;
}

function hasDecision(
  proposalId: string,
  decisionsByProposal: Map<string, unknown[]>,
  readDecision?: typeof readDecisions,
): boolean {
  if (!proposalId) return false;
  if (decisionsByProposal.has(proposalId)) return true;
  return readDecision
    ? safeArray(() => readDecision({ proposalId, limit: 1 })).some((decision) => decision.proposalId === proposalId)
    : false;
}

function hasEvidence(
  proposalId: string,
  evidenceByProposal: Map<string, unknown[]>,
  readEvidence?: (proposalId: string) => AutonomyEvidencePack | null,
): boolean {
  if (!proposalId) return false;
  if (evidenceByProposal.has(proposalId)) return true;
  const pack = readEvidence ? safeValue(() => readEvidence(proposalId)) : undefined;
  return pack?.proposal.id === proposalId;
}

function hasUsableTrajectoryId(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '' && !isDerivedWorkTrajectory(value);
}

function hasRouteSnapshot(event: DispatchProductionEvent): boolean {
  const route = event.routeSnapshot;
  return Boolean(route && (
    route.backend !== undefined ||
    route.tier !== undefined ||
    route.model !== undefined ||
    route.assignedBy !== undefined ||
    route.reason !== undefined
  ));
}

function hasRouterPolicyVersion(event: DispatchProductionEvent): boolean {
  return typeof event.routerPolicyVersion === 'string' && event.routerPolicyVersion.trim() !== '';
}

function hasCurrentRouterPolicyVersion(event: DispatchProductionEvent): boolean {
  if (event.routerPolicyVersion !== ROUTER_POLICY_VERSION) return false;
  const routePolicy = event.routeSnapshot?.routerPolicyVersion;
  return routePolicy === undefined || routePolicy === ROUTER_POLICY_VERSION;
}

function hasLearningEpoch(event: DispatchProductionEvent): boolean {
  return typeof event.learningEpoch === 'string' && event.learningEpoch.trim() !== '';
}

function hasCurrentLearningEpoch(event: DispatchProductionEvent): boolean {
  return event.learningEpoch === learningEpochFromTimestamp(event.ts);
}

function attemptRef(record: AttemptRecord): string {
  const hash = createHash('sha256').update(record.id).digest('hex').slice(0, 12);
  return `attempt:${hash}`;
}

function safeGroupKey(value: unknown, fallback = 'unknown'): string {
  return bounded(value, 80, fallback) || fallback;
}

function causalGapCauses(record: AttemptRecord): AttemptCausalGapCause[] {
  const causes: AttemptCausalGapCause[] = [];
  const coverage = record.causalCoverage;
  if (!coverage.trajectoryId) causes.push('missing-trajectory-id');
  if (!coverage.routeSnapshot) causes.push('missing-route-snapshot');
  if (!coverage.runEventSummary) causes.push('missing-run-summary');
  if (!coverage.routerPolicyVersion) causes.push('missing-router-policy-version');
  else if (!coverage.currentRouterPolicyVersion) causes.push('stale-router-policy-version');
  if (!coverage.learningEpoch) causes.push('missing-learning-epoch');
  else if (!coverage.currentLearningEpoch) causes.push('stale-learning-epoch');

  if (record.policySuppressed) {
    causes.push('policy-suppressed');
  } else if (record.learningKind === 'cancelled') {
    // Cancellation is intentionally non-diagnostic and needs no causal label.
  } else if (!coverage.labelAuthoritative) {
    if (!coverage.routerPolicyVersion && !coverage.learningEpoch && !coverage.runEventSummary) {
      causes.push('legacy-unlabeled-attempt');
    } else if (
      coverage.currentRouterPolicyVersion &&
      coverage.currentLearningEpoch &&
      coverage.routeSnapshot &&
      coverage.runEventSummary
    ) {
      causes.push('current-writer-unlabeled-attempt');
    } else {
      causes.push('missing-authoritative-label');
    }
  } else if (!coverage.currentAuthoritativeLabel) {
    causes.push('stale-authoritative-label');
  }

  return causes;
}

const CAUSAL_GAP_CAUSE_PRIORITY: Record<AttemptCausalGapCause, number> = {
  'legacy-unlabeled-attempt': 0,
  'current-writer-unlabeled-attempt': 1,
  'missing-authoritative-label': 2,
  'policy-suppressed': 3,
  'stale-router-policy-version': 4,
  'stale-learning-epoch': 5,
  'stale-authoritative-label': 6,
  'missing-router-policy-version': 7,
  'missing-learning-epoch': 8,
  'missing-route-snapshot': 9,
  'missing-run-summary': 10,
  'missing-trajectory-id': 11,
};

const ACTIONABLE_CAUSAL_GAP_CAUSE_PRIORITY: Record<AttemptCausalGapCause, number> = {
  'current-writer-unlabeled-attempt': 0,
  'stale-router-policy-version': 1,
  'stale-learning-epoch': 2,
  'missing-authoritative-label': 3,
  'stale-authoritative-label': 4,
  'missing-router-policy-version': 5,
  'missing-learning-epoch': 6,
  'missing-route-snapshot': 7,
  'missing-run-summary': 8,
  'missing-trajectory-id': 9,
  'legacy-unlabeled-attempt': 10,
  'policy-suppressed': 99,
};

function addGapGroup(map: Map<string, AttemptCausalGapGroup>, key: string, record: AttemptRecord): void {
  const safeKey = safeGroupKey(key);
  const existing = map.get(safeKey);
  if (existing) {
    existing.count++;
    if (existing.sampleRefs.length < 5) existing.sampleRefs.push(attemptRef(record));
    return;
  }
  map.set(safeKey, { key: safeKey, count: 1, sampleRefs: [attemptRef(record)] });
}

function sortedGapGroups(map: Map<string, AttemptCausalGapGroup>): AttemptCausalGapGroup[] {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 5);
}

function buildCausalGapDiagnostics(records: AttemptRecord[]): AttemptCausalGapDiagnostics {
  const causeMap = new Map<AttemptCausalGapCause, { cause: AttemptCausalGapCause; count: number; sampleRefs: string[] }>();
  const bySource = new Map<string, AttemptCausalGapGroup>();
  const byBackend = new Map<string, AttemptCausalGapGroup>();
  const byLearningSource = new Map<string, AttemptCausalGapGroup>();
  const byLabelBasis = new Map<string, AttemptCausalGapGroup>();
  const byLearningKind = new Map<string, AttemptCausalGapGroup>();
  let blockedCurrentLabels = 0;

  for (const record of records) {
    const causes = causalGapCauses(record);
    if (causes.length === 0) continue;
    if (!record.causalCoverage.currentAuthoritativeLabel) blockedCurrentLabels++;
    for (const cause of causes) {
      const existing = causeMap.get(cause);
      if (existing) {
        existing.count++;
        if (existing.sampleRefs.length < 5) existing.sampleRefs.push(attemptRef(record));
      } else {
        causeMap.set(cause, { cause, count: 1, sampleRefs: [attemptRef(record)] });
      }
    }
    addGapGroup(bySource, record.source, record);
    addGapGroup(byBackend, record.backend ?? 'unknown', record);
    addGapGroup(byLearningSource, record.learningSource ?? 'unknown', record);
    addGapGroup(byLabelBasis, record.labelBasis ?? 'unknown', record);
    addGapGroup(byLearningKind, record.learningKind, record);
  }

  return {
    blockedCurrentLabels,
    causes: [...causeMap.values()]
      .sort((a, b) =>
        b.count - a.count ||
        CAUSAL_GAP_CAUSE_PRIORITY[a.cause] - CAUSAL_GAP_CAUSE_PRIORITY[b.cause] ||
        a.cause.localeCompare(b.cause),
      )
      .slice(0, 8),
    actionableCauses: [...causeMap.values()]
      .filter((cause) => cause.cause !== 'policy-suppressed')
      .sort((a, b) =>
        ACTIONABLE_CAUSAL_GAP_CAUSE_PRIORITY[a.cause] - ACTIONABLE_CAUSAL_GAP_CAUSE_PRIORITY[b.cause] ||
        b.count - a.count ||
        a.cause.localeCompare(b.cause),
      )
      .slice(0, 5),
    bySource: sortedGapGroups(bySource),
    byBackend: sortedGapGroups(byBackend),
    byLearningSource: sortedGapGroups(byLearningSource),
    byLabelBasis: sortedGapGroups(byLabelBasis),
    byLearningKind: sortedGapGroups(byLearningKind),
  };
}

export function listAttemptRecords(opts?: AttemptRecordListOptions): AttemptRecord[] {
  const windowHours = opts?.windowHours && opts.windowHours > 0 ? opts.windowHours : DEFAULT_WINDOW_HOURS;
  const limit = opts?.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const deps = opts?.deps ?? {};
  const useDefaultReaders = opts?.useDefaultReaders ?? opts?.deps === undefined;

  const dispatchReadLimit = Math.max(limit * 3, limit);
  const dispatches = (deps.readDispatchProductionEvents
    ? safeArray(() => deps.readDispatchProductionEvents!({ sinceMs, limit: dispatchReadLimit, maxFiles: 3 }))
    : safeArray(() => {
        const read = readDispatchProductionEventsDetailed({ sinceMs, limit: dispatchReadLimit, maxFiles: 3 });
        return read.sourceState === 'healthy' && read.complete ? read.events : [];
      }))
    .filter((event) =>
      event.basis !== 'repair-lifecycle-candidate' && event.basis !== 'repair-lifecycle-outcome'
    )
    .slice(0, limit);
  const actions = safeArray(() => deps.readAgentActions
    ? deps.readAgentActions({ sinceMs, limit: Math.max(limit * 4, 500), maxFiles: 3 })
    : readAgentActions({
        sinceMs,
        limit: Math.max(limit * 4, 500),
        maxFiles: 3,
        requireComplete: true,
      }));
  const outcomes = safeArray(() =>
    (deps.listOutcomeRecords ?? listOutcomeRecords)({ limit: Math.max(limit * 2, 200) }),
  );
  const decisions = safeArray(() =>
    (deps.readDecisions ?? readDecisions)({ sinceMs, limit: Math.max(limit * 4, 500) }),
  );
  const evidence = safeArray(() =>
    (deps.listAutonomyEvidencePacks ?? listAutonomyEvidencePacks)(Math.max(limit * 2, 200)),
  );
  const worked = safeWorked(() => (deps.loadWorkedLedger ?? loadWorkedLedger)());
  const readProposal = deps.loadProposal ?? (useDefaultReaders ? loadProposal : undefined);
  const readEvidence = deps.readAutonomyEvidencePack ?? (useDefaultReaders ? readAutonomyEvidencePack : undefined);
  const readDecision = deps.readDecisions ?? (useDefaultReaders ? readDecisions : undefined);

  const actionMaps = buildActionMaps(actions);
  const outcomesByProposal = byProposal(outcomes, (record) => record.proposal.id);
  const decisionsByProposal = byProposal(decisions, (decision) => decision.proposalId);
  const evidenceByProposal = byProposal(evidence, (pack) => pack.proposal.id);
  const workedBy = workedMaps(worked);

  return dispatches
    .slice(0, limit)
    .map((event): AttemptRecord => {
      const proposalId = bounded(event.proposalId, 160);
      const itemId = bounded(event.itemId, 240, 'unknown');
      const backend = event.backend === null ? null : bounded(event.backend, 80);
      const tier = event.tier === null ? null : bounded(event.tier, 40);
      const model = event.model === null ? null : bounded(event.model, 160);
      const learningSource = bounded(event.learningSource, 80);
      const labelBasis = bounded(event.labelBasis, 80);
      const runSummary = sanitizeRunEventSummary(event.runEventSummary);
      const actionCounts = runSummary?.actionCounts;
      const learningLabel = sanitizeProductionAttemptLearningLabel(event.learningLabel);
      const classification = classifyProductionAttemptForLearningWithLabel({
        outcome: event.outcome,
        proposalCreated: event.proposalCreated,
        actionCounts,
        reason: event.reason ?? event.routeReason,
        itemId,
        title: event.title,
        source: event.source,
      }, learningLabel);
      const labelAuthoritative = Boolean(learningLabel?.authoritative);
      const coverage: AttemptRecordCoverage = {
        agentAction: hasAgentAction(event, actionMaps),
        outcomeRecord: hasOutcomeRecord(proposalId, outcomesByProposal, readProposal),
        decision: hasDecision(proposalId, decisionsByProposal, readDecision),
        evidence: hasEvidence(proposalId, evidenceByProposal, readEvidence),
        worked: Boolean(
          (proposalId && workedBy.byProposal.has(proposalId)) ||
          hasTimedWorkedFallback(event, itemId, workedBy.byItem),
        ),
      };
      const currentRouterPolicyVersion = hasCurrentRouterPolicyVersion(event);
      const currentLearningEpoch = hasCurrentLearningEpoch(event);
      const currentAuthoritativeLabel =
        labelAuthoritative &&
        !classification.policySuppressed &&
        currentRouterPolicyVersion &&
        currentLearningEpoch;
      const causalCoverage: AttemptCausalCoverage = {
        trajectoryId: hasUsableTrajectoryId(event.trajectoryId),
        routeSnapshot: hasRouteSnapshot(event),
        runEventSummary: runSummary !== undefined,
        routerPolicyVersion: hasRouterPolicyVersion(event),
        currentRouterPolicyVersion,
        learningEpoch: hasLearningEpoch(event),
        currentLearningEpoch,
        labelAuthoritative,
        currentAuthoritativeLabel,
      };
      return {
        version: 1,
        id: attemptId(event),
        ts: event.ts,
        repo: bounded(event.repo, 500, 'unknown'),
        itemId,
        source: bounded(event.source, 80, 'goal') as WorkItem['source'],
        title: bounded(event.title, 120, 'untitled'),
        outcome: event.outcome,
        proposalCreated: event.proposalCreated,
        ...(proposalId ? { proposalId } : {}),
        ...(event.runId ? { runId: bounded(event.runId, 160) } : {}),
        ...(event.trajectoryId ? { trajectoryId: bounded(event.trajectoryId, 160) } : {}),
        backend: backend ? backend as EngineId : null,
        tier: tier ? tier as EngineTier : null,
        ...(model !== undefined ? { model } : {}),
        routeReason: bounded(event.routeReason, 160, 'unknown'),
        ...(event.reason ? { reason: bounded(event.reason, 160) } : {}),
        ...(actionCounts ? { actionCounts } : {}),
        attemptShape: classification.attemptShape,
        policySuppressed: classification.policySuppressed,
        diagnosticNoProposal: classification.diagnosticNoProposal,
        diagnosticAttempt: classification.diagnosticAttempt,
        learningKind: classification.kind,
        labelAuthoritative,
        ...(learningSource ? { learningSource } : {}),
        ...(labelBasis ? { labelBasis } : {}),
        coverage,
        causalCoverage,
      };
    });
}

function metric(records: AttemptRecord[], read: (record: AttemptRecord) => boolean): AttemptCoverageMetric {
  const count = records.filter(read).length;
  return {
    count,
    rate: records.length > 0 ? count / records.length : 0,
  };
}

function emptyAttemptGeneratedRepairSummary(): AttemptGeneratedRepairSummary {
  return {
    attempts: 0,
    proposalsCreated: 0,
    noProposal: 0,
    proposalRate: 0,
    captureRepairs: 0,
    diagnosticReslices: 0,
    proposalRepairs: 0,
  };
}

function addAttemptGeneratedRepair(
  summary: AttemptGeneratedRepairSummary,
  kind: GeneratedRepairAttemptKind | undefined,
  proposalCreated: boolean,
): void {
  if (!kind) return;
  summary.attempts++;
  if (proposalCreated) summary.proposalsCreated++;
  else summary.noProposal++;
  summary.proposalRate = summary.attempts > 0 ? summary.proposalsCreated / summary.attempts : 0;
  if (kind === 'capture-repair') summary.captureRepairs++;
  else if (kind === 'no-diff-reslice') summary.diagnosticReslices++;
  else summary.proposalRepairs++;
}

function hasAttemptGeneratedRepairSummary(summary: AttemptGeneratedRepairSummary): boolean {
  return summary.attempts > 0 ||
    summary.captureRepairs > 0 ||
    summary.diagnosticReslices > 0 ||
    summary.proposalRepairs > 0;
}

export function summarizeAttemptCoverage(
  records: AttemptRecord[],
  windowHours = DEFAULT_WINDOW_HOURS,
): AttemptCoverageStatus {
  const attemptShape = emptyProductionAttemptShape();
  const generatedRepairAttempts = emptyAttemptGeneratedRepairSummary();
  let proposalCreated = 0;
  let cancelled = 0;
  let policySuppressed = 0;
  let labelAuthoritativeAttempts = 0;
  let diagnosticAttempts = 0;
  let diagnosticNoProposal = 0;
  for (const record of records) {
    if (record.proposalCreated) proposalCreated++;
    if (record.learningKind === 'cancelled') cancelled++;
    if (record.policySuppressed) policySuppressed++;
    if (record.labelAuthoritative) labelAuthoritativeAttempts++;
    if (record.diagnosticAttempt) diagnosticAttempts++;
    if (record.diagnosticNoProposal) diagnosticNoProposal++;
    addProductionAttemptShape(attemptShape, record.attemptShape);
    if (record.learningKind !== 'cancelled') {
      addAttemptGeneratedRepair(
        generatedRepairAttempts,
        generatedRepairAttemptKindFromSignals({
          itemId: record.itemId,
          title: record.title,
          source: record.source,
        }),
        record.proposalCreated,
      );
    }
  }
  const coverage = {
    agentAction: metric(records, (record) => record.coverage.agentAction),
    outcomeRecord: metric(records, (record) => record.coverage.outcomeRecord),
    decision: metric(records, (record) => record.coverage.decision),
    evidence: metric(records, (record) => record.coverage.evidence),
    worked: metric(records, (record) => record.coverage.worked),
  };
  const causalCoverage = {
    trajectoryId: metric(records, (record) => record.causalCoverage.trajectoryId),
    routeSnapshot: metric(records, (record) => record.causalCoverage.routeSnapshot),
    runEventSummary: metric(records, (record) => record.causalCoverage.runEventSummary),
    routerPolicyVersion: metric(records, (record) => record.causalCoverage.routerPolicyVersion),
    currentRouterPolicyVersion: metric(records, (record) => record.causalCoverage.currentRouterPolicyVersion),
    learningEpoch: metric(records, (record) => record.causalCoverage.learningEpoch),
    currentLearningEpoch: metric(records, (record) => record.causalCoverage.currentLearningEpoch),
    labelAuthoritative: metric(records, (record) => record.causalCoverage.labelAuthoritative),
    currentAuthoritativeLabel: metric(records, (record) => record.causalCoverage.currentAuthoritativeLabel),
  };
  const gaps = (Object.keys(coverage) as Array<keyof AttemptRecordCoverage>)
    .map((kind) => {
      const missing = records.filter((record) => !record.coverage[kind]);
      return { kind, count: missing.length, sampleRefs: missing.slice(0, 5).map(attemptRef) };
    })
    .filter((gap) => gap.count > 0)
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const causalGaps = (Object.keys(causalCoverage) as Array<keyof AttemptCausalCoverage>)
    .map((kind) => {
      const missing = records.filter((record) => !record.causalCoverage[kind]);
      return { kind, count: missing.length, sampleRefs: missing.slice(0, 5).map(attemptRef) };
    })
    .filter((gap) => gap.count > 0)
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const weakKinds: Array<{ kind: keyof AttemptCausalCoverage; threshold: number }> = [
    { kind: 'trajectoryId', threshold: CAUSAL_FOUNDATION_THRESHOLD },
    { kind: 'routeSnapshot', threshold: CAUSAL_FOUNDATION_THRESHOLD },
    { kind: 'runEventSummary', threshold: CAUSAL_FOUNDATION_THRESHOLD },
    { kind: 'routerPolicyVersion', threshold: CAUSAL_FOUNDATION_THRESHOLD },
    { kind: 'currentRouterPolicyVersion', threshold: CAUSAL_FOUNDATION_THRESHOLD },
    { kind: 'learningEpoch', threshold: CAUSAL_FOUNDATION_THRESHOLD },
    { kind: 'currentLearningEpoch', threshold: CAUSAL_FOUNDATION_THRESHOLD },
    { kind: 'labelAuthoritative', threshold: CAUSAL_LABEL_THRESHOLD },
    { kind: 'currentAuthoritativeLabel', threshold: CAUSAL_LABEL_THRESHOLD },
  ];
  const weakReasons = records.length >= CAUSAL_WEAK_MIN_ATTEMPTS
    ? weakKinds
        .map(({ kind, threshold }) => {
          const causalLabelRecords = kind === 'labelAuthoritative'
            ? records.filter((record) => record.learningKind !== 'cancelled')
            : kind === 'currentAuthoritativeLabel'
              ? records.filter((record) => !record.policySuppressed && record.learningKind !== 'cancelled')
              : null;
          const metricValue = causalLabelRecords
            ? {
                count: causalLabelRecords.filter((record) => record.causalCoverage[kind]).length,
                rate: causalLabelRecords.length > 0
                  ? causalLabelRecords.filter((record) => record.causalCoverage[kind]).length / causalLabelRecords.length
                  : 1,
              }
            : causalCoverage[kind];
          const gap = causalGaps.find((candidate) => candidate.kind === kind);
          const sampleRefs = causalLabelRecords
            ? causalLabelRecords
                .filter((record) => !record.causalCoverage[kind])
                .slice(0, 5)
                .map(attemptRef)
            : gap?.sampleRefs ?? [];
          return {
            kind,
            count: metricValue.count,
            rate: metricValue.rate,
            threshold,
            ...(causalLabelRecords ? { denominator: causalLabelRecords.length } : {}),
            sampleRefs,
          };
        })
        .filter((reason) =>
          (reason.denominator === undefined || reason.denominator >= CAUSAL_WEAK_MIN_ATTEMPTS) &&
          reason.rate < reason.threshold,
        )
    : [];
  const causalGapDiagnostics = buildCausalGapDiagnostics(records);
  return {
    windowHours,
    attempts: records.length,
    recent: records.slice(0, 10).map((record) => ({
      ref: attemptRef(record),
      ts: record.ts,
      outcome: record.outcome,
      backend: record.backend ?? null,
      learningKind: record.learningKind,
      diagnosticAttempt: record.diagnosticAttempt,
      policySuppressed: record.policySuppressed,
      labelAuthoritative: record.labelAuthoritative,
      coverage: record.coverage,
      causalCoverage: record.causalCoverage,
    })),
    coverage,
    causalCoverage,
    causalWeak: {
      weak: weakReasons.length > 0,
      minAttempts: CAUSAL_WEAK_MIN_ATTEMPTS,
      threshold: CAUSAL_FOUNDATION_THRESHOLD,
      labelThreshold: CAUSAL_LABEL_THRESHOLD,
      reasons: weakReasons,
    },
    causalGapDiagnostics,
    production: {
      attempts: records.length,
      proposalCreated,
      cancelled,
      policySuppressed,
      labelAuthoritativeAttempts,
      legacyUnversionedAttempts: records.filter((record) =>
        record.learningKind !== 'cancelled' && !record.labelAuthoritative
      ).length,
      diagnosticAttempts,
      diagnosticNoProposal,
      diagnosticProposalRate: diagnosticAttempts > 0 ? proposalCreated / diagnosticAttempts : null,
      diagnosticNoProposalRate: diagnosticAttempts > 0 ? diagnosticNoProposal / diagnosticAttempts : null,
      attemptShape,
      ...(hasAttemptGeneratedRepairSummary(generatedRepairAttempts) ? { generatedRepairAttempts } : {}),
    },
    gaps,
    causalGaps,
  };
}

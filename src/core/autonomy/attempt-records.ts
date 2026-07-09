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
import type { AgentActionEvent } from '../fleet/agent-action-ledger.js';
import { readAgentActions } from '../fleet/agent-action-ledger.js';
import type { DispatchProductionEvent } from '../fleet/dispatch-production-ledger.js';
import { readDispatchProductionEvents } from '../fleet/dispatch-production-ledger.js';
import type { OutcomeRecord } from './outcome-records.js';
import { listOutcomeRecords } from './outcome-records.js';
import type { EngineId, EngineTier, Proposal, RunActionCounts, WorkItem } from '../types.js';
import { readDecisions } from '../fleet/decisions-ledger.js';
import { listAutonomyEvidencePacks, readAutonomyEvidencePack, type AutonomyEvidencePack } from './evidence-pack.js';
import { loadProposal } from '../inbox/store.js';
import type { WorkedEvent, WorkedLedger } from '../fleet/worked-ledger.js';
import { loadWorkedLedger } from '../fleet/worked-ledger.js';
import { runEventSummary as sanitizeRunEventSummary } from '../learning/causal.js';
import {
  addProductionAttemptShape,
  classifyProductionAttemptForLearningWithLabel,
  emptyProductionAttemptShape,
  sanitizeProductionAttemptLearningLabel,
  type ProductionAttemptLearningKind,
} from '../learning/attempt-shape.js';
import type { ProductionAttemptShape } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 500;
const JOIN_WINDOW_MS = 10 * 60 * 1000;

export interface AttemptRecordCoverage {
  agentAction: boolean;
  outcomeRecord: boolean;
  decision: boolean;
  evidence: boolean;
  worked: boolean;
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
  coverage: AttemptRecordCoverage;
}

export interface AttemptCoverageMetric {
  count: number;
  rate: number;
}

export interface AttemptCoverageStatus {
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
    coverage: AttemptRecordCoverage;
  }>;
  coverage: {
    agentAction: AttemptCoverageMetric;
    outcomeRecord: AttemptCoverageMetric;
    decision: AttemptCoverageMetric;
    evidence: AttemptCoverageMetric;
    worked: AttemptCoverageMetric;
  };
  production: {
    attempts: number;
    proposalCreated: number;
    policySuppressed: number;
    labelAuthoritativeAttempts: number;
    legacyUnversionedAttempts: number;
    diagnosticAttempts: number;
    diagnosticNoProposal: number;
    diagnosticProposalRate: number | null;
    diagnosticNoProposalRate: number | null;
    attemptShape: ProductionAttemptShape;
  };
  gaps: Array<{ kind: keyof AttemptRecordCoverage; count: number; sampleRefs: string[] }>;
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

function attemptRef(record: AttemptRecord): string {
  const hash = createHash('sha256').update(record.id).digest('hex').slice(0, 12);
  return `attempt:${hash}`;
}

export function listAttemptRecords(opts?: AttemptRecordListOptions): AttemptRecord[] {
  const windowHours = opts?.windowHours && opts.windowHours > 0 ? opts.windowHours : DEFAULT_WINDOW_HOURS;
  const limit = opts?.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const deps = opts?.deps ?? {};
  const useDefaultReaders = opts?.deps === undefined;

  const dispatches = safeArray(() =>
    (deps.readDispatchProductionEvents ?? readDispatchProductionEvents)({ sinceMs, limit, maxFiles: 3 }),
  );
  const actions = safeArray(() =>
    (deps.readAgentActions ?? readAgentActions)({ sinceMs, limit: Math.max(limit * 4, 500), maxFiles: 3 }),
  );
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
      const actionCounts = sanitizeRunEventSummary(event.runEventSummary)?.actionCounts;
      const learningLabel = sanitizeProductionAttemptLearningLabel(event.learningLabel);
      const classification = classifyProductionAttemptForLearningWithLabel({
        outcome: event.outcome,
        proposalCreated: event.proposalCreated,
        actionCounts,
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
        coverage,
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

export function summarizeAttemptCoverage(
  records: AttemptRecord[],
  windowHours = DEFAULT_WINDOW_HOURS,
): AttemptCoverageStatus {
  const attemptShape = emptyProductionAttemptShape();
  let proposalCreated = 0;
  let policySuppressed = 0;
  let labelAuthoritativeAttempts = 0;
  let diagnosticAttempts = 0;
  let diagnosticNoProposal = 0;
  for (const record of records) {
    if (record.proposalCreated) proposalCreated++;
    if (record.policySuppressed) policySuppressed++;
    if (record.labelAuthoritative) labelAuthoritativeAttempts++;
    if (record.diagnosticAttempt) diagnosticAttempts++;
    if (record.diagnosticNoProposal) diagnosticNoProposal++;
    addProductionAttemptShape(attemptShape, record.attemptShape);
  }
  const coverage = {
    agentAction: metric(records, (record) => record.coverage.agentAction),
    outcomeRecord: metric(records, (record) => record.coverage.outcomeRecord),
    decision: metric(records, (record) => record.coverage.decision),
    evidence: metric(records, (record) => record.coverage.evidence),
    worked: metric(records, (record) => record.coverage.worked),
  };
  const gaps = (Object.keys(coverage) as Array<keyof AttemptRecordCoverage>)
    .map((kind) => {
      const missing = records.filter((record) => !record.coverage[kind]);
      return { kind, count: missing.length, sampleRefs: missing.slice(0, 5).map(attemptRef) };
    })
    .filter((gap) => gap.count > 0)
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
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
    })),
    coverage,
    production: {
      attempts: records.length,
      proposalCreated,
      policySuppressed,
      labelAuthoritativeAttempts,
      legacyUnversionedAttempts: Math.max(0, records.length - labelAuthoritativeAttempts),
      diagnosticAttempts,
      diagnosticNoProposal,
      diagnosticProposalRate: diagnosticAttempts > 0 ? proposalCreated / diagnosticAttempts : null,
      diagnosticNoProposalRate: diagnosticAttempts > 0 ? diagnosticNoProposal / diagnosticAttempts : null,
      attemptShape,
    },
    gaps,
  };
}

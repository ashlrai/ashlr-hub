/**
 * Read-only outcome records for autonomy learning.
 *
 * This module does not write policy, mutate proposals, or infer new authority.
 * It only joins existing stores into bounded records that downstream learning
 * code can consume without coupling itself to every ledger format.
 */

import type { Proposal } from '../types.js';
import type { DecisionEntry } from '../types.js';
import {
  readPostMergeObservations,
  type PostMergeObservation,
  type PostMergeObservationReadResult,
} from '../fleet/post-merge-observations.js';
import {
  listProposals,
  listProposalsDetailed,
  loadProposal,
  type ProposalsReadResult,
} from '../inbox/store.js';
import type { JudgeTrace, JudgeTracesReadResult } from '../fleet/judge-trace.js';
import { readJudgeTraces, readJudgeTracesDetailed } from '../fleet/judge-trace.js';
import type { WorkedEvent } from '../fleet/worked-ledger.js';
import { loadWorkedLedger } from '../fleet/worked-ledger.js';
import type { RacingStats } from '../fleet/model-racing.js';
import { racingStats } from '../fleet/model-racing.js';
import {
  readDecisions,
  readDecisionsDetailed,
  type DecisionsReadResult,
  type DecisionSourceQuality,
} from '../fleet/decisions-ledger.js';
import {
  agentSemanticProposalSubjectRef,
  agentSemanticModelFamily,
  sanitizeAgentSemanticEvents,
} from '../learning/agent-semantic-events.js';
import type {
  AutonomyEvidencePack,
  AutonomyEvidencePackList,
  AutonomyEvidencePacksReadResult,
  AutonomyEvidenceSourceQuality,
} from './evidence-pack.js';
import {
  evidencePackMatchesLiveProposal,
  listAutonomyEvidencePacks,
  readAutonomyEvidencePacksDetailed,
} from './evidence-pack.js';

const MAX_JOINED_EVENTS_PER_RECORD = 20;

export interface OutcomeRecordProposal {
  id: string;
  repo: string | null;
  origin: Proposal['origin'];
  kind: Proposal['kind'];
  status: Proposal['status'];
  title: string;
  createdAt: string;
  decidedAt?: string;
  engineModel?: string;
  engineTier?: Proposal['engineTier'];
  riskClass?: Proposal['riskClass'];
  verifyResult?: Proposal['verifyResult'];
  diffHash?: string;
  workItemId?: string;
  workSource?: Proposal['workSource'];
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: Proposal['routeSnapshot'];
  runEventSummary?: Proposal['runEventSummary'];
  evidenceOutcome?: Proposal['evidenceOutcome'];
  learningSource?: Proposal['learningSource'];
  labelBasis?: Proposal['labelBasis'];
  routerPolicyVersion?: string;
  learningEpoch?: string;
}

export interface OutcomeRecordDecision {
  ts: string;
  action: DecisionEntry['action'];
  workItemId?: string;
  workSource?: DecisionEntry['workSource'];
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: DecisionEntry['routeSnapshot'];
  runEventSummary?: DecisionEntry['runEventSummary'];
  evidenceOutcome?: DecisionEntry['evidenceOutcome'];
  learningSource?: DecisionEntry['learningSource'];
  labelBasis?: DecisionEntry['labelBasis'];
  routerPolicyVersion?: string;
  learningEpoch?: string;
  semanticEvents?: DecisionEntry['semanticEvents'];
  verdict?: string;
  reason?: string;
  engine?: string;
  model?: string;
}

export interface OutcomeRecordJudgeTrace {
  ts: string;
  judgeEngine: string;
  verdict: JudgeTrace['verdict'];
  scores: JudgeTrace['scores'];
  outcome?: JudgeTrace['outcome'];
  outcomeAt?: string;
}

export interface OutcomeRecordEvidence {
  version: AutonomyEvidencePack['version'];
  generatedAt: string;
  proposalId?: string;
  diffHash?: string;
  target: AutonomyEvidencePack['target'];
  trustBasis: AutonomyEvidencePack['trustBasis'];
  remotePreferred?: boolean;
  riskClass: AutonomyEvidencePack['riskClass'];
  policy?: AutonomyEvidencePack['policy'];
  gates: AutonomyEvidencePack['gates'];
  verification: AutonomyEvidencePack['verification'];
  trajectoryId?: string;
  routeSnapshot?: AutonomyEvidencePack['routeSnapshot'];
  runEventSummary?: AutonomyEvidencePack['runEventSummary'];
  evidenceOutcome?: AutonomyEvidencePack['evidenceOutcome'];
  learningSource?: AutonomyEvidencePack['learningSource'];
  labelBasis?: AutonomyEvidencePack['labelBasis'];
  routerPolicyVersion?: string;
  learningEpoch?: string;
}

export interface OutcomeRecordWorkedEvent {
  itemId: string;
  outcome: WorkedEvent['outcome'];
  ts: string;
}

export interface OutcomeRecord {
  version: 1;
  proposal: OutcomeRecordProposal;
  lastActivityAt: string;
  decisions: OutcomeRecordDecision[];
  judgeTraces: OutcomeRecordJudgeTrace[];
  evidencePacks: OutcomeRecordEvidence[];
  workedEvents: OutcomeRecordWorkedEvent[];
  postMergeObservations?: PostMergeObservation[];
  postMergeObservationSourceQuality?: Omit<PostMergeObservationReadResult, 'observations'>;
  evidenceSourceQuality?: AutonomyEvidenceSourceQuality;
  decisionSourceQuality?: DecisionSourceQuality;
  racing?: RacingStats;
}

export interface OutcomeRecordReadDeps {
  listProposals?: () => Proposal[];
  readDecisions?: () => DecisionEntry[];
  readJudgeTraces?: () => JudgeTrace[];
  loadWorkedLedger?: () => { events: WorkedEvent[] };
  listAutonomyEvidencePacks?: (limit?: number) => AutonomyEvidencePack[];
  racingStats?: () => RacingStats;
  readPostMergeObservations?: typeof readPostMergeObservations;
}

/**
 * Provenance-preserving source qualities for a complete outcome join.
 *
 * This is deliberately separate from the best-effort `listOutcomeRecords()`
 * API. Consumers that would make a scheduling or suppression decision need a
 * clear answer when any ledger could not be read completely.
 */
export interface OutcomeRecordsSourceQuality {
  proposals: Omit<ProposalsReadResult, 'proposals'>;
  decisions: Omit<DecisionsReadResult, 'decisions'>;
  judgeTraces: Omit<JudgeTracesReadResult, 'traces'>;
  evidencePacks: Omit<AutonomyEvidencePacksReadResult, 'packs'>;
  postMergeObservations: Omit<PostMergeObservationReadResult, 'observations'>;
}

export interface OutcomeRecordsReadResult {
  records: OutcomeRecord[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  sourceQuality: OutcomeRecordsSourceQuality;
}

export interface DetailedOutcomeRecordReadDeps {
  listProposalsDetailed?: typeof listProposalsDetailed;
  readDecisionsDetailed?: typeof readDecisionsDetailed;
  readJudgeTracesDetailed?: typeof readJudgeTracesDetailed;
  readAutonomyEvidencePacksDetailed?: typeof readAutonomyEvidencePacksDetailed;
  readPostMergeObservations?: typeof readPostMergeObservations;
}

/** Complete pending-proposal snapshot and source-backed activity timestamps. */
export interface PendingProposalActivityReadResult {
  pendingProposals: Proposal[];
  activityAtByProposalId: ReadonlyMap<string, string>;
  observedAt: string;
  complete: boolean;
  sourceQuality: OutcomeRecordsSourceQuality;
}

export interface PendingProposalActivityReadOptions {
  now?: Date | number | string;
  deps?: DetailedOutcomeRecordReadDeps;
}

export interface ReadyEvidenceOutcomeRecordDeps {
  listAutonomyEvidencePacks?: (limit?: number) => AutonomyEvidencePack[];
  loadProposal?: (id: string) => Proposal | null;
}

function safeArray<T>(read: () => T[] | undefined): T[] {
  try {
    const value = read();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function safeValue<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function boundedLimit(limit: number | undefined): number {
  return Number.isFinite(limit) && limit !== undefined && limit > 0
    ? Math.floor(limit)
    : 50;
}

function activityTime(...values: Array<string | undefined>): string {
  let newestMs = Number.NEGATIVE_INFINITY;
  let newest = '';
  for (const value of values) {
    if (value === undefined) continue;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > newestMs) {
      newestMs = ms;
      newest = value;
    }
  }
  return newest;
}

function withoutRows<T extends object, K extends keyof T>(
  value: T,
  rows: K,
): Omit<T, K> {
  const { [rows]: _rows, ...quality } = value;
  return quality as Omit<T, K>;
}

function completeOutcomeSource(value: { sourceState: 'missing' | 'healthy' | 'degraded'; complete: boolean }): boolean {
  return value.complete && value.sourceState !== 'degraded';
}

function authorityObservedAt(value: Date | number | string | undefined): { ms: number; iso: string } {
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Date.now();
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return { ms: safeMs, iso: new Date(safeMs).toISOString() };
}

function activityTimestampWithinProposalLifetime(
  value: string | undefined,
  createdMs: number,
  observedMs: number,
): string | undefined {
  if (!Number.isFinite(createdMs) || typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < createdMs || ms > observedMs) return undefined;
  return value;
}

function byNewestTs<T>(readTs: (value: T) => string | undefined): (a: T, b: T) => number {
  return (a, b) => {
    const ams = Date.parse(readTs(a) ?? '');
    const bms = Date.parse(readTs(b) ?? '');
    const safeA = Number.isNaN(ams) ? 0 : ams;
    const safeB = Number.isNaN(bms) ? 0 : bms;
    return safeB - safeA;
  };
}

function proposalSnapshot(proposal: Proposal): OutcomeRecordProposal {
  return {
    id: proposal.id,
    repo: proposal.repo,
    origin: proposal.origin,
    kind: proposal.kind,
    status: proposal.status,
    title: proposal.title,
    createdAt: proposal.createdAt,
    ...(proposal.decidedAt ? { decidedAt: proposal.decidedAt } : {}),
    ...(proposal.engineModel ? { engineModel: proposal.engineModel } : {}),
    ...(proposal.engineTier ? { engineTier: proposal.engineTier } : {}),
    ...(proposal.riskClass ? { riskClass: proposal.riskClass } : {}),
    ...(proposal.verifyResult ? { verifyResult: proposal.verifyResult } : {}),
    ...(proposal.diffHash ? { diffHash: proposal.diffHash } : {}),
    ...(proposal.workItemId ? { workItemId: proposal.workItemId } : {}),
    ...(proposal.workSource ? { workSource: proposal.workSource } : {}),
    ...(proposal.runId ? { runId: proposal.runId } : {}),
    ...(proposal.trajectoryId ? { trajectoryId: proposal.trajectoryId } : {}),
    ...(proposal.routeSnapshot ? { routeSnapshot: proposal.routeSnapshot } : {}),
    ...(proposal.runEventSummary ? { runEventSummary: proposal.runEventSummary } : {}),
    ...(proposal.evidenceOutcome ? { evidenceOutcome: proposal.evidenceOutcome } : {}),
    ...(proposal.learningSource ? { learningSource: proposal.learningSource } : {}),
    ...(proposal.labelBasis ? { labelBasis: proposal.labelBasis } : {}),
    ...(proposal.routerPolicyVersion ? { routerPolicyVersion: proposal.routerPolicyVersion } : {}),
    ...(proposal.learningEpoch ? { learningEpoch: proposal.learningEpoch } : {}),
  };
}

function decisionSnapshot(
  decision: DecisionEntry,
  proposalId: string,
  allowSemanticEvents: boolean,
): OutcomeRecordDecision {
  const semanticEvents = allowSemanticEvents
    ? sanitizeAgentSemanticEvents(
        decision.semanticEvents,
        agentSemanticProposalSubjectRef(proposalId),
        agentSemanticModelFamily(decision.model ?? decision.engine),
        { producerRole: 'manager', producerVersion: 'manager-semantic-v1' },
      )
    : undefined;
  return {
    ts: decision.ts,
    action: decision.action,
    ...(decision.workItemId ? { workItemId: decision.workItemId } : {}),
    ...(decision.workSource ? { workSource: decision.workSource } : {}),
    ...(decision.runId ? { runId: decision.runId } : {}),
    ...(decision.trajectoryId ? { trajectoryId: decision.trajectoryId } : {}),
    ...(decision.routeSnapshot ? { routeSnapshot: decision.routeSnapshot } : {}),
    ...(decision.runEventSummary ? { runEventSummary: decision.runEventSummary } : {}),
    ...(decision.evidenceOutcome ? { evidenceOutcome: decision.evidenceOutcome } : {}),
    ...(decision.learningSource ? { learningSource: decision.learningSource } : {}),
    ...(decision.labelBasis ? { labelBasis: decision.labelBasis } : {}),
    ...(decision.routerPolicyVersion ? { routerPolicyVersion: decision.routerPolicyVersion } : {}),
    ...(decision.learningEpoch ? { learningEpoch: decision.learningEpoch } : {}),
    ...(semanticEvents ? { semanticEvents: semanticEvents.map((event) => ({ ...event })) } : {}),
    ...(decision.verdict ? { verdict: decision.verdict } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.engine ? { engine: decision.engine } : {}),
    ...(decision.model ? { model: decision.model } : {}),
  };
}

function judgeTraceSnapshot(trace: JudgeTrace): OutcomeRecordJudgeTrace {
  return {
    ts: trace.ts,
    judgeEngine: trace.judgeEngine,
    verdict: trace.verdict,
    scores: trace.scores,
    ...(trace.outcome ? { outcome: trace.outcome } : {}),
    ...(trace.outcomeAt ? { outcomeAt: trace.outcomeAt } : {}),
  };
}

function evidenceSnapshot(pack: AutonomyEvidencePack): OutcomeRecordEvidence {
  return {
    version: pack.version,
    generatedAt: pack.generatedAt,
    proposalId: pack.proposal.id,
    ...(pack.diff.hash ? { diffHash: pack.diff.hash } : {}),
    target: pack.target,
    trustBasis: pack.trustBasis,
    remotePreferred: pack.remotePreferred,
    riskClass: pack.riskClass,
    ...(pack.policy ? { policy: pack.policy } : {}),
    gates: pack.gates,
    verification: pack.verification,
    ...(pack.trajectoryId ? { trajectoryId: pack.trajectoryId } : {}),
    ...(pack.routeSnapshot ? { routeSnapshot: pack.routeSnapshot } : {}),
    ...(pack.runEventSummary ? { runEventSummary: pack.runEventSummary } : {}),
    ...(pack.evidenceOutcome ? { evidenceOutcome: pack.evidenceOutcome } : {}),
    ...(pack.learningSource ? { learningSource: pack.learningSource } : {}),
    ...(pack.labelBasis ? { labelBasis: pack.labelBasis } : {}),
    ...(pack.routerPolicyVersion ? { routerPolicyVersion: pack.routerPolicyVersion } : {}),
    ...(pack.learningEpoch ? { learningEpoch: pack.learningEpoch } : {}),
  };
}

function workedSnapshot(event: WorkedEvent): OutcomeRecordWorkedEvent {
  return {
    itemId: event.itemId,
    outcome: event.outcome,
    ts: event.ts,
  };
}

/**
 * Return proposal-keyed outcome records, newest-first.
 *
 * Optional stores are best-effort and malformed/corrupt data is skipped by the
 * underlying readers or swallowed here. The returned records are bounded by
 * `limit` after sorting by the latest activity across joined evidence.
 */
export function listOutcomeRecords(
  opts?: { limit?: number; deps?: OutcomeRecordReadDeps },
): OutcomeRecord[] {
  const deps = opts?.deps ?? {};
  const cap = boundedLimit(opts?.limit);

  try {
    const proposals = safeArray(() => (deps.listProposals ?? listProposals)());
    const decisions = safeArray(() => (deps.readDecisions ?? readDecisions)());
    const decisionSourceQuality = (decisions as DecisionEntry[] & {
      sourceQuality?: DecisionSourceQuality;
    }).sourceQuality;
    const decisionSemanticsHealthy = decisionSourceQuality === undefined || (
      decisionSourceQuality.sourceState === 'healthy' && decisionSourceQuality.complete &&
      (decisionSourceQuality.semanticRejectedRows ?? 0) === 0
    );
    const traces = safeArray(() => deps.readJudgeTraces
      ? deps.readJudgeTraces()
      : readJudgeTraces({ requireComplete: true }));
    const evidence = safeArray(() =>
      (deps.listAutonomyEvidencePacks ?? listAutonomyEvidencePacks)(Math.max(cap * 4, 200)),
    );
    const evidenceSourceQuality = (evidence as AutonomyEvidencePackList).sourceQuality;
    const workedEvents = safeValue(() => (deps.loadWorkedLedger ?? loadWorkedLedger)())?.events ?? [];
    const racing = safeValue(() => (deps.racingStats ?? racingStats)());
    const postMergeRead = safeValue(() =>
      (deps.readPostMergeObservations ?? readPostMergeObservations)({ requireComplete: true }));
    const postMergeHealthy = postMergeRead?.sourceState === 'healthy' && postMergeRead.complete === true;
    const postMergeByProposal = new Map<string, PostMergeObservation[]>();
    if (postMergeHealthy) {
      for (const observation of postMergeRead.observations) {
        const rows = postMergeByProposal.get(observation.proposalId) ?? [];
        rows.push(observation);
        postMergeByProposal.set(observation.proposalId, rows);
      }
    }

    const decisionsByProposal = new Map<string, DecisionEntry[]>();
    for (const decision of decisions) {
      if (!decisionsByProposal.has(decision.proposalId)) decisionsByProposal.set(decision.proposalId, []);
      decisionsByProposal.get(decision.proposalId)!.push(decision);
    }

    const tracesByProposal = new Map<string, JudgeTrace[]>();
    for (const trace of traces) {
      if (!tracesByProposal.has(trace.proposalId)) tracesByProposal.set(trace.proposalId, []);
      tracesByProposal.get(trace.proposalId)!.push(trace);
    }

    const evidenceByProposal = new Map<string, AutonomyEvidencePack[]>();
    for (const pack of evidence) {
      if (!evidenceByProposal.has(pack.proposal.id)) evidenceByProposal.set(pack.proposal.id, []);
      evidenceByProposal.get(pack.proposal.id)!.push(pack);
    }

    const workedById = new Map<string, WorkedEvent[]>();
    for (const event of workedEvents) {
      if (!workedById.has(event.itemId)) workedById.set(event.itemId, []);
      workedById.get(event.itemId)!.push(event);
    }

    const records = proposals.map((proposal): OutcomeRecord => {
      const proposalDecisions = (decisionsByProposal.get(proposal.id) ?? [])
        .sort(byNewestTs((d) => d.ts))
        .slice(0, MAX_JOINED_EVENTS_PER_RECORD);
      const proposalTraces = (tracesByProposal.get(proposal.id) ?? [])
        .sort(byNewestTs((t) => t.outcomeAt ?? t.ts))
        .slice(0, MAX_JOINED_EVENTS_PER_RECORD);
      const proposalEvidence = (evidenceByProposal.get(proposal.id) ?? [])
        .sort(byNewestTs((p) => p.generatedAt))
        .slice(0, MAX_JOINED_EVENTS_PER_RECORD);
      const proposalWorkedIds = new Set([proposal.id]);
      if (proposal.workItemId) proposalWorkedIds.add(proposal.workItemId);
      const proposalWorked = [...proposalWorkedIds]
        .flatMap((id) => workedById.get(id) ?? [])
        .sort(byNewestTs((e) => e.ts))
        .slice(0, MAX_JOINED_EVENTS_PER_RECORD);
      const proposalPostMerge = (postMergeByProposal.get(proposal.id) ?? [])
        .sort(byNewestTs((observation) => observation.observedAt))
        .slice(0, MAX_JOINED_EVENTS_PER_RECORD);

      return {
        version: 1,
        proposal: proposalSnapshot(proposal),
        lastActivityAt: activityTime(
          proposal.decidedAt,
          proposal.createdAt,
          proposalDecisions[0]?.ts,
          proposalTraces[0]?.outcomeAt,
          proposalTraces[0]?.ts,
          proposalEvidence[0]?.generatedAt,
          proposalWorked[0]?.ts,
          proposalPostMerge[0]?.observedAt,
        ),
        decisions: proposalDecisions.map((decision) => decisionSnapshot(
          decision, proposal.id, decisionSemanticsHealthy,
        )),
        judgeTraces: proposalTraces.map(judgeTraceSnapshot),
        evidencePacks: proposalEvidence.map(evidenceSnapshot),
        workedEvents: proposalWorked.map(workedSnapshot),
        ...(proposalPostMerge.length > 0 ? { postMergeObservations: proposalPostMerge } : {}),
        ...(postMergeRead
          ? { postMergeObservationSourceQuality: (({ observations: _observations, ...quality }) => quality)(postMergeRead) }
          : {}),
        ...(evidenceSourceQuality ? { evidenceSourceQuality } : {}),
        ...(decisionSourceQuality ? { decisionSourceQuality } : {}),
        ...(racing ? { racing } : {}),
      };
    });

    records.sort((a, b) => {
      const ams = Date.parse(a.lastActivityAt);
      const bms = Date.parse(b.lastActivityAt);
      const safeA = Number.isNaN(ams) ? 0 : ams;
      const safeB = Number.isNaN(bms) ? 0 : bms;
      if (safeA !== safeB) return safeB - safeA;
      return b.proposal.id.localeCompare(a.proposal.id);
    });

    return records.slice(0, cap);
  } catch {
    return [];
  }
}

/**
 * Return source-qualified outcome records for authority-sensitive callers.
 *
 * A missing store is a complete empty source; a degraded or partial store
 * withholds the entire join. Worked-ledger and racing statistics are excluded
 * here because neither has a complete-read contract yet. This prevents an
 * authority caller from treating best-effort operational telemetry as proof
 * that a pending proposal is still active.
 */
export function listOutcomeRecordsDetailed(
  opts?: { limit?: number; deps?: DetailedOutcomeRecordReadDeps },
): OutcomeRecordsReadResult {
  const deps = opts?.deps ?? {};
  const cap = boundedLimit(opts?.limit);
  const proposals = (deps.listProposalsDetailed ?? listProposalsDetailed)();
  const decisions = (deps.readDecisionsDetailed ?? readDecisionsDetailed)({ requireComplete: true });
  const traces = (deps.readJudgeTracesDetailed ?? readJudgeTracesDetailed)({ requireComplete: true });
  const evidence = (deps.readAutonomyEvidencePacksDetailed ?? readAutonomyEvidencePacksDetailed)(Math.max(cap * 4, 200));
  const postMerge = (deps.readPostMergeObservations ?? readPostMergeObservations)({ requireComplete: true });
  const sourceQuality = {
    proposals: withoutRows(proposals, 'proposals'),
    decisions: withoutRows(decisions, 'decisions'),
    judgeTraces: withoutRows(traces, 'traces'),
    evidencePacks: withoutRows(evidence, 'packs'),
    postMergeObservations: withoutRows(postMerge, 'observations'),
  } satisfies OutcomeRecordsSourceQuality;
  const sources = [proposals, decisions, traces, evidence, postMerge];
  const complete = sources.every(completeOutcomeSource);
  const sourceState: OutcomeRecordsReadResult['sourceState'] = !complete
    ? 'degraded'
    : sources.every((source) => source.sourceState === 'missing')
      ? 'missing'
      : 'healthy';
  if (!complete) return { records: [], sourceState, complete: false, sourceQuality };

  const decisionsByProposal = new Map<string, DecisionEntry[]>();
  for (const decision of decisions.decisions) {
    const rows = decisionsByProposal.get(decision.proposalId) ?? [];
    rows.push(decision);
    decisionsByProposal.set(decision.proposalId, rows);
  }
  const tracesByProposal = new Map<string, JudgeTrace[]>();
  for (const trace of traces.traces) {
    const rows = tracesByProposal.get(trace.proposalId) ?? [];
    rows.push(trace);
    tracesByProposal.set(trace.proposalId, rows);
  }
  const evidenceByProposal = new Map<string, AutonomyEvidencePack[]>();
  for (const pack of evidence.packs) {
    const rows = evidenceByProposal.get(pack.proposal.id) ?? [];
    rows.push(pack);
    evidenceByProposal.set(pack.proposal.id, rows);
  }
  const postMergeByProposal = new Map<string, PostMergeObservation[]>();
  for (const observation of postMerge.observations) {
    const rows = postMergeByProposal.get(observation.proposalId) ?? [];
    rows.push(observation);
    postMergeByProposal.set(observation.proposalId, rows);
  }

  const records = proposals.proposals.map((proposal): OutcomeRecord => {
    const proposalDecisions = (decisionsByProposal.get(proposal.id) ?? [])
      .sort(byNewestTs((decision) => decision.ts)).slice(0, MAX_JOINED_EVENTS_PER_RECORD);
    const proposalTraces = (tracesByProposal.get(proposal.id) ?? [])
      .sort(byNewestTs((trace) => trace.outcomeAt ?? trace.ts)).slice(0, MAX_JOINED_EVENTS_PER_RECORD);
    const proposalEvidence = (evidenceByProposal.get(proposal.id) ?? [])
      .sort(byNewestTs((pack) => pack.generatedAt)).slice(0, MAX_JOINED_EVENTS_PER_RECORD);
    const proposalPostMerge = (postMergeByProposal.get(proposal.id) ?? [])
      .sort(byNewestTs((observation) => observation.observedAt)).slice(0, MAX_JOINED_EVENTS_PER_RECORD);
    return {
      version: 1,
      proposal: proposalSnapshot(proposal),
      lastActivityAt: activityTime(
        proposal.decidedAt,
        proposal.createdAt,
        proposalDecisions[0]?.ts,
        proposalTraces[0]?.outcomeAt,
        proposalTraces[0]?.ts,
        proposalEvidence[0]?.generatedAt,
        proposalPostMerge[0]?.observedAt,
      ),
      decisions: proposalDecisions.map((decision) => decisionSnapshot(decision, proposal.id, true)),
      judgeTraces: proposalTraces.map(judgeTraceSnapshot),
      evidencePacks: proposalEvidence.map(evidenceSnapshot),
      workedEvents: [],
      ...(proposalPostMerge.length > 0 ? { postMergeObservations: proposalPostMerge } : {}),
      postMergeObservationSourceQuality: sourceQuality.postMergeObservations,
      evidenceSourceQuality: sourceQuality.evidencePacks,
      decisionSourceQuality: sourceQuality.decisions,
    };
  });
  records.sort((a, b) => {
    const activityOrder = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    return Number.isNaN(activityOrder) || activityOrder === 0
      ? b.proposal.id.localeCompare(a.proposal.id)
      : activityOrder;
  });
  return { records: records.slice(0, cap), sourceState, complete: true, sourceQuality };
}

/**
 * Read one coherent pending-proposal snapshot with activity suitable for
 * duplicate-suppression callers. Unlike generic outcome records, this emits
 * no proposal-local mutable timestamps and only admits evidence that still
 * binds to the live pending proposal at the supplied observation time.
 */
export function readPendingProposalActivityDetailed(
  opts: PendingProposalActivityReadOptions = {},
): PendingProposalActivityReadResult {
  const deps = opts.deps ?? {};
  const observed = authorityObservedAt(opts.now);
  const proposals = (deps.listProposalsDetailed ?? listProposalsDetailed)({
    status: 'pending', requireComplete: true,
  });
  const decisions = (deps.readDecisionsDetailed ?? readDecisionsDetailed)({ requireComplete: true });
  const traces = (deps.readJudgeTracesDetailed ?? readJudgeTracesDetailed)({ requireComplete: true });
  const evidence = (deps.readAutonomyEvidencePacksDetailed ?? readAutonomyEvidencePacksDetailed)(200);
  const postMerge = (deps.readPostMergeObservations ?? readPostMergeObservations)({ requireComplete: true });
  const sourceQuality = {
    proposals: withoutRows(proposals, 'proposals'),
    decisions: withoutRows(decisions, 'decisions'),
    judgeTraces: withoutRows(traces, 'traces'),
    evidencePacks: withoutRows(evidence, 'packs'),
    postMergeObservations: withoutRows(postMerge, 'observations'),
  } satisfies OutcomeRecordsSourceQuality;
  // Proposal membership is the root authority. Auxiliary missing ledgers are
  // complete known-empty sources; a missing proposal snapshot is not.
  const complete = proposals.sourceState === 'healthy' && proposals.complete &&
    [decisions, traces, evidence, postMerge].every(completeOutcomeSource);
  if (!complete) {
    return {
      pendingProposals: [], activityAtByProposalId: new Map(), observedAt: observed.iso,
      complete: false, sourceQuality,
    };
  }

  const byId = new Map(proposals.proposals.map((proposal) => [proposal.id, proposal]));
  const candidateTimes = new Map<string, string[]>();
  const record = (proposalId: string, value: string | undefined): void => {
    const proposal = byId.get(proposalId);
    if (!proposal) return;
    const bounded = activityTimestampWithinProposalLifetime(
      value, Date.parse(proposal.createdAt), observed.ms,
    );
    if (!bounded) return;
    const rows = candidateTimes.get(proposalId) ?? [];
    rows.push(bounded);
    candidateTimes.set(proposalId, rows);
  };
  for (const decision of decisions.decisions) record(decision.proposalId, decision.ts);
  for (const trace of traces.traces) {
    record(trace.proposalId, trace.ts);
    record(trace.proposalId, trace.outcomeAt);
  }
  for (const observation of postMerge.observations) record(observation.proposalId, observation.observedAt);
  for (const pack of evidence.packs) {
    const proposal = byId.get(pack.proposal.id);
    if (proposal && evidencePackMatchesLiveProposal(pack, proposal, { nowMs: observed.ms })) {
      record(proposal.id, pack.generatedAt);
    }
  }
  const activityAtByProposalId = new Map<string, string>();
  for (const [proposalId, values] of candidateTimes) {
    const newest = activityTime(...values);
    if (newest) activityAtByProposalId.set(proposalId, newest);
  }
  return {
    pendingProposals: proposals.proposals.map((proposal) => ({ ...proposal })),
    activityAtByProposalId,
    observedAt: observed.iso,
    complete: true,
    sourceQuality,
  };
}

/**
 * Cheap daemon-facing outcome reader focused only on recent ready evidence.
 *
 * Unlike listOutcomeRecords(), this intentionally avoids decisions, judge traces,
 * worked-ledger joins, and racing stats. It reads bounded evidence packs, resolves
 * their live proposal state, and returns minimal records that are sufficient for
 * resource strategy mode selection.
 */
export function listReadyEvidenceOutcomeRecords(
  opts?: { limit?: number; now?: Date; maxAgeMs?: number; deps?: ReadyEvidenceOutcomeRecordDeps },
): OutcomeRecord[] {
  const deps = opts?.deps ?? {};
  const cap = boundedLimit(opts?.limit);
  const readEvidence = deps.listAutonomyEvidencePacks ?? listAutonomyEvidencePacks;
  const readProposal = deps.loadProposal ?? loadProposal;

  try {
    const evidence = safeArray(() => readEvidence(Math.max(cap * 4, 24)))
      .sort(byNewestTs((pack) => pack.generatedAt));
    const sourceQuality = (evidence as AutonomyEvidencePackList).sourceQuality;
    if (sourceQuality && (sourceQuality.sourceState !== 'healthy' || sourceQuality.complete !== true)) {
      return [];
    }
    const effectiveSourceQuality: AutonomyEvidenceSourceQuality = sourceQuality ?? {
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      filesRead: evidence.length,
      bytesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
      limitExceeded: false,
    };
    const latestByProposal = new Map<string, AutonomyEvidencePack>();
    for (const pack of evidence) {
      if (!latestByProposal.has(pack.proposal.id)) latestByProposal.set(pack.proposal.id, pack);
    }

    const records: OutcomeRecord[] = [];
    for (const pack of latestByProposal.values()) {
      if (records.length >= cap) break;
      const proposal = safeValue(() => readProposal(pack.proposal.id)) ?? null;
      if (!proposal || !evidencePackMatchesLiveProposal(pack, proposal, {
        nowMs: opts?.now?.getTime(),
        maxAgeMs: opts?.maxAgeMs,
      })) continue;
      records.push({
        version: 1,
        proposal: proposalSnapshot(proposal),
        lastActivityAt: activityTime(pack.generatedAt, proposal.createdAt),
        decisions: [],
        judgeTraces: [],
        evidencePacks: [evidenceSnapshot(pack)],
        workedEvents: [],
        evidenceSourceQuality: effectiveSourceQuality,
      });
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Read-only outcome records for autonomy learning.
 *
 * This module does not write policy, mutate proposals, or infer new authority.
 * It only joins existing stores into bounded records that downstream learning
 * code can consume without coupling itself to every ledger format.
 */

import type { Proposal } from '../types.js';
import type { DecisionEntry } from '../types.js';
import { listProposals } from '../inbox/store.js';
import type { JudgeTrace } from '../fleet/judge-trace.js';
import { readJudgeTraces } from '../fleet/judge-trace.js';
import type { WorkedEvent } from '../fleet/worked-ledger.js';
import { loadWorkedLedger } from '../fleet/worked-ledger.js';
import type { RacingStats } from '../fleet/model-racing.js';
import { racingStats } from '../fleet/model-racing.js';
import { readDecisions } from '../fleet/decisions-ledger.js';
import type { AutonomyEvidencePack } from './evidence-pack.js';
import { listAutonomyEvidencePacks } from './evidence-pack.js';

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
}

export interface OutcomeRecordDecision {
  ts: string;
  action: DecisionEntry['action'];
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
  generatedAt: string;
  target: AutonomyEvidencePack['target'];
  trustBasis: AutonomyEvidencePack['trustBasis'];
  riskClass: AutonomyEvidencePack['riskClass'];
  policy?: AutonomyEvidencePack['policy'];
  gates: AutonomyEvidencePack['gates'];
  verification: AutonomyEvidencePack['verification'];
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
  racing?: RacingStats;
}

export interface OutcomeRecordReadDeps {
  listProposals?: () => Proposal[];
  readDecisions?: () => DecisionEntry[];
  readJudgeTraces?: () => JudgeTrace[];
  loadWorkedLedger?: () => { events: WorkedEvent[] };
  listAutonomyEvidencePacks?: () => AutonomyEvidencePack[];
  racingStats?: () => RacingStats;
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
  };
}

function decisionSnapshot(decision: DecisionEntry): OutcomeRecordDecision {
  return {
    ts: decision.ts,
    action: decision.action,
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
    generatedAt: pack.generatedAt,
    target: pack.target,
    trustBasis: pack.trustBasis,
    riskClass: pack.riskClass,
    ...(pack.policy ? { policy: pack.policy } : {}),
    gates: pack.gates,
    verification: pack.verification,
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
    const traces = safeArray(() => (deps.readJudgeTraces ?? readJudgeTraces)());
    const evidence = safeArray(() =>
      (deps.listAutonomyEvidencePacks ?? listAutonomyEvidencePacks)(Math.max(cap * 4, 200)),
    );
    const workedEvents = safeValue(() => (deps.loadWorkedLedger ?? loadWorkedLedger)())?.events ?? [];
    const racing = safeValue(() => (deps.racingStats ?? racingStats)());

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
        ),
        decisions: proposalDecisions.map(decisionSnapshot),
        judgeTraces: proposalTraces.map(judgeTraceSnapshot),
        evidencePacks: proposalEvidence.map(evidenceSnapshot),
        workedEvents: proposalWorked.map(workedSnapshot),
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

import { createHash } from 'node:crypto';
import {
  canonicalDispatchProductionAttempts, isCancelledDispatchProductionEvent,
  readDispatchProductionEventsDetailed,
  type DispatchProductionEvent, type DispatchProductionEventsReadResult,
} from './dispatch-production-ledger.js';
import { isSafeExecutionIdentity } from './attempt-identity.js';
import { listProposalsDetailed } from '../inbox/store.js';
import type { ExecutionFeedbackCase, ExecutionFeedbackView, ExecutionOutcomeCounts, LeaderExecutionFeedback } from './execution-feedback-types.js';

export interface ExecutionProposalJoin {
  id: string;
  runId?: string;
  trajectoryId?: string;
}
export interface ExecutionProposalRead {
  proposals: readonly ExecutionProposalJoin[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
}
/** Private correlation, not part of the public/Leader projection. */
export interface ExecutionFeedbackCorrelation {
  attemptId: string;
  runId: string;
  trajectoryId: string;
  proposalIds: string[];
  /** Unknown proposal inventory cannot prove that a failure has no proposal. */
  proposalJoinComplete: boolean;
  repairRootId?: string;
  repairHandoffId?: string;
  repairGenerationId?: string;
}
export interface ExecutionFeedbackSnapshot {
  view: ExecutionFeedbackView;
  correlations: ReadonlyMap<string, ExecutionFeedbackCorrelation>;
}

function emptyCounts(): ExecutionOutcomeCounts {
  return { 'producer-succeeded': 0, failed: 0, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function executionFeedbackCaseId(attemptId: string): string { return hash(`ashlr:execution-feedback:v1:${attemptId}`); }

function describe(event: DispatchProductionEvent): Pick<ExecutionFeedbackCase, 'outcome' | 'failureKind'> {
  if (isCancelledDispatchProductionEvent(event)) return { outcome: 'cancelled', failureKind: null };
  switch (event.outcome) {
    case 'proposal-created': return { outcome: 'producer-succeeded', failureKind: null };
    case 'engine-failed': return { outcome: 'failed', failureKind: 'engine' };
    case 'sandbox-failed': return { outcome: 'failed', failureKind: 'sandbox' };
    case 'proposal-capture-error': return { outcome: 'failed', failureKind: 'capture' };
    case 'gate-blocked': return { outcome: 'refused', failureKind: null };
    case 'empty-diff': return { outcome: 'empty-diff', failureKind: null };
    case 'proposal-disabled': return { outcome: 'disabled', failureKind: null };
    default: return { outcome: 'unknown', failureKind: null };
  }
}

/** PURE: only current exact writer envelopes count. Torn/conflicting/history gaps stay unknown. */
export function buildExecutionFeedback(
  read: DispatchProductionEventsReadResult,
  opts: { sinceMs: number; nowMs: number; proposals?: ExecutionProposalRead },
): ExecutionFeedbackSnapshot {
  if (!Number.isFinite(opts.sinceMs) || !Number.isFinite(opts.nowMs) || opts.sinceMs > opts.nowMs) throw new Error('Invalid feedback window');
  let invalidTimestamps = (read.invalidReasonCounts ?? []).find((item) => item.reason === 'timestamp-invalid')?.count ?? 0;
  // Validate before the existing sanitizer: Date.parse normalizes impossible
  // calendar dates, which must never turn a torn row into a measured zero.
  const timestampValid = read.events.filter((event) => {
    const at = Date.parse(event.ts);
    const valid = Number.isFinite(at) && new Date(at).toISOString() === event.ts && at <= opts.nowMs;
    if (!valid) invalidTimestamps++;
    return valid;
  });
  const canonical = canonicalDispatchProductionAttempts(timestampValid);
  const cases: ExecutionFeedbackCase[] = [];
  const correlations = new Map<string, ExecutionFeedbackCorrelation>();
  const proposalJoinComplete = !!opts.proposals && (opts.proposals.sourceState === 'healthy' && opts.proposals.complete
    || opts.proposals.sourceState === 'missing' && opts.proposals.proposals.length === 0);
  const joins = new Map<string, Set<string>>();
  for (const proposal of opts.proposals?.proposals ?? []) {
    if (!isSafeExecutionIdentity(proposal.id) || !isSafeExecutionIdentity(proposal.runId) || typeof proposal.trajectoryId !== 'string') continue;
    const key = JSON.stringify([proposal.runId, proposal.trajectoryId]);
    const ids = joins.get(key) ?? new Set<string>();
    ids.add(proposal.id);
    joins.set(key, ids);
  }
  for (const event of canonical.events) {
    const at = Date.parse(event.ts);
    // Canonical ISO, not Date.parse's normalization of malformed calendar input.
    if (!Number.isFinite(at) || new Date(at).toISOString() !== event.ts || at > opts.nowMs) { invalidTimestamps++; continue; }
    if (at < opts.sinceMs) continue;
    const caseId = executionFeedbackCaseId(event.attemptId!);
    const proposalIds = new Set(joins.get(JSON.stringify([event.runId, event.trajectoryId])) ?? []);
    if (event.proposalCreated && event.proposalId) proposalIds.add(event.proposalId);
    cases.push({ caseId, endedAt: event.ts, ...describe(event), proposalRecorded: event.proposalCreated || proposalIds.size > 0 });
    correlations.set(caseId, {
      attemptId: event.attemptId!, runId: event.runId!, trajectoryId: event.trajectoryId!, proposalIds: [...proposalIds].sort(),
      proposalJoinComplete,
      ...(!event.repairLineageInvalid && isSafeExecutionIdentity(event.repairRootId) ? { repairRootId: event.repairRootId } : {}),
      ...(!event.repairLineageInvalid && isSafeExecutionIdentity(event.repairHandoffId) ? { repairHandoffId: event.repairHandoffId } : {}),
      ...(!event.repairLineageInvalid && isSafeExecutionIdentity(event.repairGenerationId) ? { repairGenerationId: event.repairGenerationId } : {}),
    });
  }
  cases.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.caseId.localeCompare(b.caseId));
  const observedCounts = emptyCounts();
  for (const item of cases) observedCounts[item.outcome]++;
  const coverage = {
    legacyRows: canonical.preEnvelopeEvents, invalidAttempts: canonical.invalidAttemptIdentities,
    conflictingAttempts: canonical.conflictingAttemptIdentities, duplicateRows: canonical.duplicateEvents, invalidTimestamps,
    proposalSource: opts.proposals ? opts.proposals.complete || opts.proposals.sourceState === 'missing'
      ? opts.proposals.sourceState : 'degraded' as const : 'unavailable' as const,
  };
  const complete = read.sourceState === 'healthy' && read.complete && read.invalidRows === 0 && read.unreadableFiles === 0
    && coverage.legacyRows === 0 && coverage.invalidAttempts === 0 && coverage.conflictingAttempts === 0 && invalidTimestamps === 0;
  const sourceState = complete ? 'healthy' : read.sourceState === 'missing' ? 'missing' : 'degraded';
  const counts = complete ? { ...observedCounts } : null;
  // Replays are diagnostic, not new evidence. The time of reading is not an event.
  const digest = hash(JSON.stringify({ sourceState, complete, counts, observedCounts, cases,
    coverage: { ...coverage, duplicateRows: 0 } }));
  return { view: { schemaVersion: 1, sourceState, complete,
    window: { since: new Date(opts.sinceMs).toISOString(), through: new Date(opts.nowMs).toISOString() },
    observedThrough: cases[0]?.endedAt ?? null, counts, observedCounts, cases, coverage, digest }, correlations };
}

/** Authorized callers can join only real known attempts; no fabricated run links. */
export function lookupExecutionFeedback(snapshot: ExecutionFeedbackSnapshot, caseId: string): ExecutionFeedbackCorrelation | null {
  return snapshot.correlations.get(caseId) ?? null;
}

export function leaderExecutionFeedback(snapshot: ExecutionFeedbackSnapshot): LeaderExecutionFeedback {
  const { sourceState, complete, observedThrough, counts, observedCounts, coverage, digest } = snapshot.view;
  return { sourceState, complete, observedThrough, counts, observedCounts, coverage: { ...coverage, duplicateRows: 0 }, digest };
}

/** Inspection-only bounded existing readers; never launches, probes, creates directories, or models. */
export function readExecutionFeedbackSnapshot(opts: { sinceMs: number; nowMs: number }): ExecutionFeedbackSnapshot {
  const read = readDispatchProductionEventsDetailed({ sinceMs: opts.sinceMs, inspectionOnly: true, canonicalTimestamps: true });
  const proposals = listProposalsDetailed({ maxFiles: 2_000, maxBytes: 16 * 1024 * 1024 });
  return buildExecutionFeedback(read, { ...opts, proposals });
}

/** Fixed seven-day metadata-only worker projection. Internal identities never cross this boundary. */
export function readExecutionFeedback(): ExecutionFeedbackView {
  const nowMs = Date.now();
  return readExecutionFeedbackSnapshot({ nowMs, sinceMs: nowMs - 7 * 86_400_000 }).view;
}

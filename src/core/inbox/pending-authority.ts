import type { AshlrConfig, Proposal, RunActionCounts, RunEventSummary } from '../types.js';
import { pendingProposalIsStaleForProductionVelocity } from '../fabric/production-velocity-pending.js';
import {
  hashDiff,
  verifyPendingProposalAuthorityV1,
  verifyProvenance,
} from '../foundry/provenance.js';
import { canonicalizeProposalDiff } from '../util/scrub.js';
import { canonicalFilesystemPathIdentity } from '../sandbox/policy.js';
import { runEventSummary as boundedRunEventSummary } from '../learning/causal.js';

type PendingAuthorityConfig = Pick<AshlrConfig, 'foundry'> | undefined;

export interface AuthoritativePendingProposalExpectation {
  id?: string;
  repo: string;
  origin: Proposal['origin'];
  kind: Proposal['kind'];
  diff?: string;
  diffHash?: string;
  provenanceSig?: string;
  sandboxId?: string;
  runId?: string;
  trajectoryId?: string;
  workItemId?: string;
  workItemGenerationId?: string;
  isPartial?: boolean;
}

export interface AuthoritativePendingProposalOptions {
  now?: Date | number | string;
}

function authorityNowMs(now: AuthoritativePendingProposalOptions['now']): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

export function canonicalProposalDiffHash(
  proposal: Pick<Proposal, 'diff' | 'diffHash'>,
): string | null {
  if (
    typeof proposal.diff !== 'string' ||
    proposal.diff.trim().length === 0 ||
    typeof proposal.diffHash !== 'string'
  ) return null;
  try {
    const canonicalDiff = canonicalizeProposalDiff(proposal.diff);
    const recomputed = hashDiff(canonicalDiff);
    return proposal.diff === canonicalDiff && proposal.diffHash === recomputed ? recomputed : null;
  } catch {
    return null;
  }
}

const RUN_SUMMARY_KEYS = new Set<keyof RunEventSummary>([
  'runId', 'status', 'outcome', 'proposalCreated', 'proposalId', 'diffFiles', 'diffLines',
  'tokensIn', 'tokensOut', 'costUsd', 'durationMs', 'cacheHit', 'contextSummary', 'actionCounts',
]);

const ACTION_COUNT_KEYS = new Set<keyof RunActionCounts>([
  'sandboxCreated', 'spawnAttempts', 'transientRetries', 'proposalCaptureAttempts',
  'completenessGateRuns', 'verifyRepairAttempts', 'modelSteps', 'toolSteps', 'totalSteps',
  'diffFiles', 'diffLines', 'proposalCreated', 'proposalBlocked', 'proposalDisabled',
]);

const MAX_AUTHORITY_ACTION_COUNT = 1_000_000_000;

export interface PendingAuthoritySummaryVerdict {
  ok: boolean;
  reason: string;
}

function canonicalComparable(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const entries = value.map(canonicalComparable);
    return entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(',')}]`;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const entries: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = canonicalComparable(record[key]);
    if (encoded === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${entries.join(',')}}`;
}

export function validatePendingAuthorityActionCounts(
  summary: RunEventSummary,
): PendingAuthoritySummaryVerdict {
  const counts = summary.actionCounts;
  if (counts === undefined) return { ok: true, reason: 'action counts absent and signed as absent' };
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return { ok: false, reason: 'action counts are not an object' };
  }
  const raw = counts as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !ACTION_COUNT_KEYS.has(key as keyof RunActionCounts))) {
    return { ok: false, reason: 'action counts contain unknown fields' };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_AUTHORITY_ACTION_COUNT) {
      return { ok: false, reason: `action count ${key} is not a bounded non-negative integer` };
    }
  }

  const created = counts.proposalCreated ?? 0;
  const blocked = counts.proposalBlocked ?? 0;
  const disabled = counts.proposalDisabled ?? 0;
  if (created > 1 || blocked > 1 || disabled > 1 || created + blocked + disabled > 1) {
    return { ok: false, reason: 'created, blocked, and disabled counts are contradictory' };
  }
  if (created !== (summary.proposalCreated === true ? 1 : 0)) {
    return { ok: false, reason: 'proposal-created count contradicts the run summary' };
  }
  if (blocked !== (summary.outcome === 'gate-blocked' ? 1 : 0)) {
    return { ok: false, reason: 'proposal-blocked count contradicts the run outcome' };
  }
  if (disabled !== (summary.outcome === 'proposal-disabled' ? 1 : 0)) {
    return { ok: false, reason: 'proposal-disabled count contradicts the run outcome' };
  }

  const modelSteps = counts.modelSteps ?? 0;
  const toolSteps = counts.toolSteps ?? 0;
  const totalSteps = counts.totalSteps;
  if ((modelSteps > 0 || toolSteps > 0) && totalSteps === undefined) {
    return { ok: false, reason: 'component steps require a total step count' };
  }
  if (totalSteps !== undefined && modelSteps + toolSteps !== totalSteps) {
    return { ok: false, reason: 'total steps do not equal model plus tool steps' };
  }
  if ((counts.transientRetries ?? 0) > (counts.spawnAttempts ?? 0)) {
    return { ok: false, reason: 'transient retries exceed spawn attempts' };
  }
  if (summary.diffFiles !== undefined && counts.diffFiles !== undefined && summary.diffFiles !== counts.diffFiles) {
    return { ok: false, reason: 'diff file counts do not reconcile' };
  }
  if (summary.diffLines !== undefined && counts.diffLines !== undefined && summary.diffLines !== counts.diffLines) {
    return { ok: false, reason: 'diff line counts do not reconcile' };
  }
  return { ok: true, reason: 'action counts are semantically consistent' };
}

/** Validate the exact bounded run truth covered by current pending authority. */
export function validatePendingAuthorityRunSummary(proposal: Proposal): PendingAuthoritySummaryVerdict {
  const runId = proposal.runId;
  const summary = proposal.runEventSummary;
  if (!runId || !summary || summary.runId !== runId) {
    return { ok: false, reason: 'run summary does not match proposal run identity' };
  }
  if (!proposal.producerStatus || summary.status !== proposal.producerStatus) {
    return { ok: false, reason: 'producer status does not match the run summary' };
  }
  if (Object.keys(summary).some((key) => !RUN_SUMMARY_KEYS.has(key as keyof RunEventSummary))) {
    return { ok: false, reason: 'run summary contains unknown fields' };
  }
  const bounded = boundedRunEventSummary(summary);
  if (!bounded || canonicalComparable(summary) !== canonicalComparable(bounded)) {
    return { ok: false, reason: 'run summary is not exact bounded metadata' };
  }

  const actionVerdict = validatePendingAuthorityActionCounts(summary);
  if (!actionVerdict.ok) return actionVerdict;

  if (proposal.isPartial === true) {
    const exact = (summary.status === 'failed' || summary.status === 'aborted') &&
      summary.outcome === 'gate-blocked' &&
      summary.proposalCreated === false &&
      summary.proposalId === undefined;
    return exact
      ? { ok: true, reason: 'partial producer summary is exact' }
      : { ok: false, reason: 'partial producer summary contradicts blocked failure semantics' };
  }

  const exact = summary.status === 'done' &&
    summary.outcome === 'filed' &&
    summary.proposalCreated === true &&
    summary.proposalId === proposal.id;
  return exact
    ? { ok: true, reason: 'filed producer summary is exact' }
    : { ok: false, reason: 'filed producer summary contradicts successful proposal semantics' };
}

/**
 * One fail-closed authority predicate for autonomous pending proposals.
 * Structural inbox readability is insufficient: bytes, provenance, freshness,
 * causal identity, work generation, and filed run truth must all agree.
 */
export function isAuthoritativeDurablePendingProposal(
  proposal: Proposal | null | undefined,
  expected: AuthoritativePendingProposalExpectation,
  cfg?: PendingAuthorityConfig,
  opts: AuthoritativePendingProposalOptions = {},
): proposal is Proposal {
  const expectedRepo = canonicalFilesystemPathIdentity(expected.repo, { foldWindowsCase: false });
  if (
    !proposal ||
    expectedRepo === null ||
    proposal.status !== 'pending' ||
    (expected.id !== undefined && proposal.id !== expected.id) ||
    proposal.repo !== expectedRepo ||
    proposal.origin !== expected.origin ||
    proposal.kind !== expected.kind ||
    proposal.workItemId !== expected.workItemId ||
    proposal.workItemGenerationId !== expected.workItemGenerationId ||
    (expected.sandboxId !== undefined && proposal.sandboxId !== expected.sandboxId) ||
    (expected.runId !== undefined && proposal.runId !== expected.runId) ||
    (expected.trajectoryId !== undefined && proposal.trajectoryId !== expected.trajectoryId) ||
    (expected.provenanceSig !== undefined && proposal.provenanceSig !== expected.provenanceSig) ||
    (expected.isPartial !== undefined && (proposal.isPartial === true) !== expected.isPartial)
  ) return false;

  if (!proposal.runId || proposal.trajectoryId !== `run:${proposal.runId}`) return false;

  const createdAtMs = Date.parse(proposal.createdAt);
  const nowMs = authorityNowMs(opts.now);
  if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs + 60_000) return false;
  if (pendingProposalIsStaleForProductionVelocity(proposal, cfg, { now: nowMs })) return false;

  const durableHash = canonicalProposalDiffHash(proposal);
  if (durableHash === null || !verifyProvenance(proposal).ok) return false;

  if (expected.diff !== undefined) {
    try {
      const expectedDiff = canonicalizeProposalDiff(expected.diff);
      const expectedHash = hashDiff(expectedDiff);
      if (
        expected.diff !== expectedDiff ||
        proposal.diff !== expectedDiff ||
        durableHash !== expectedHash ||
        (expected.diffHash !== undefined && expected.diffHash !== expectedHash)
      ) return false;
    } catch {
      return false;
    }
  } else if (expected.diffHash !== undefined && durableHash !== expected.diffHash) {
    return false;
  }

  if (!validatePendingAuthorityRunSummary(proposal).ok) return false;
  return verifyPendingProposalAuthorityV1(proposal).ok;
}

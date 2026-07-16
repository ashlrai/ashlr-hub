import type { Proposal } from '../types.js';
import { canonicalRealizedMergeIdentity } from './realized-merge.js';
import {
  PROPOSAL_PERSISTENCE_MISMATCH_REASON,
  PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
} from './persistence-mismatch.js';

const REJECTED_PARTIAL_RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1_000;
const PERSISTENCE_MISMATCH_DECISION_WINDOW_MS = 60_000;
const AUTO_DRAIN_REASON_PREFIX = 'auto-drained: permanent readiness blocker persisted';

export type OperationalProposalMembershipClass = 'active' | 'invalid' | 'excluded';

export type OperationalProposalMembershipType =
  | 'lifecycle'
  | 'realized-merge-fanout'
  | 'rejected-partial-recovery';

export type OperationalProposalMembershipReason =
  | 'pending'
  | 'approved'
  | 'awaiting-host-merge'
  | 'partial-active-lifecycle'
  | 'realized-merge-fanout-incomplete'
  | 'realized-merge-fanout-complete'
  | 'realized-merge-missing-or-invalid'
  | 'rejected-partial-recovery'
  | 'rejected-partial-recovery-expired-or-invalid'
  | 'rejected'
  | 'failed';

export interface OperationalProposalMembershipResult {
  class: OperationalProposalMembershipClass;
  type: OperationalProposalMembershipType | null;
  reason: OperationalProposalMembershipReason;
  /** Canonical inclusive expiry for bounded recovery memberships only. */
  expiresAt: string | null;
}

function canonicalTimestampMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function locallyProvenRejectedPartialRecoveryExpiryMs(proposal: Proposal): number | null {
  if (proposal.status !== 'rejected' || proposal.isPartial !== true) return null;
  if (proposal.kind !== 'patch' && proposal.kind !== 'pr') return null;
  if (typeof proposal.repo !== 'string' || proposal.repo.length === 0) return null;
  if (proposal.verifyResult?.source !== 'capture-gate') return null;
  if (proposal.origin !== 'agent' && proposal.origin !== 'swarm') return null;
  if (typeof proposal.diff !== 'string' || proposal.diff.trim().length === 0) return null;
  if (typeof proposal.runId !== 'string' || proposal.runId.length === 0) return null;
  if (proposal.trajectoryId !== `run:${proposal.runId}`) return null;

  const createdAtMs = canonicalTimestampMillis(proposal.createdAt);
  const decidedAtMs = canonicalTimestampMillis(proposal.decidedAt);
  if (createdAtMs === null || decidedAtMs === null || decidedAtMs < createdAtMs) return null;
  const expiresAtMs = createdAtMs + REJECTED_PARTIAL_RECOVERY_WINDOW_MS;
  if (!Number.isSafeInteger(expiresAtMs) || decidedAtMs > expiresAtMs) return null;

  const stuckPassCount = proposal.stuckPassCount;
  const autoDrained =
    typeof proposal.decisionReason === 'string' &&
    proposal.decisionReason.startsWith(AUTO_DRAIN_REASON_PREFIX) &&
    Number.isSafeInteger(stuckPassCount) &&
    Number(stuckPassCount) >= 1;
  const persistenceMismatch =
    proposal.result === PROPOSAL_PERSISTENCE_MISMATCH_RESULT &&
    proposal.decisionReason === PROPOSAL_PERSISTENCE_MISMATCH_REASON &&
    decidedAtMs - createdAtMs <= PERSISTENCE_MISMATCH_DECISION_WINDOW_MS;

  return autoDrained || persistenceMismatch ? expiresAtMs : null;
}

/** Return the canonical inclusive expiry of a locally proven recovery membership. */
export function operationalProposalMembershipExpiresAt(proposal: Proposal): string | null {
  const expiresAtMs = locallyProvenRejectedPartialRecoveryExpiryMs(proposal);
  return expiresAtMs === null ? null : new Date(expiresAtMs).toISOString();
}

/**
 * Classify proposal metadata for operational projection without consulting any
 * mutable side ledger. This function grants no lifecycle or merge authority.
 */
export function classifyOperationalProposalMembership(
  proposal: Proposal,
  now = new Date(),
): OperationalProposalMembershipResult {
  if (proposal.status === 'pending') {
    return { class: 'active', type: 'lifecycle', reason: 'pending', expiresAt: null };
  }

  if (proposal.status === 'approved' || proposal.status === 'awaiting-host-merge') {
    if (proposal.isPartial === true) {
      return {
        class: 'invalid',
        type: 'lifecycle',
        reason: 'partial-active-lifecycle',
        expiresAt: null,
      };
    }
    return {
      class: 'active',
      type: 'lifecycle',
      reason: proposal.status,
      expiresAt: null,
    };
  }

  if (proposal.status === 'applied') {
    if (canonicalRealizedMergeIdentity(proposal) === null) {
      return {
        class: 'excluded',
        type: 'realized-merge-fanout',
        reason: 'realized-merge-missing-or-invalid',
        expiresAt: null,
      };
    }
    if (proposal.realizedMergeFanoutVersion === 3) {
      return {
        class: 'excluded',
        type: 'realized-merge-fanout',
        reason: 'realized-merge-fanout-complete',
        expiresAt: null,
      };
    }
    return {
      class: 'active',
      type: 'realized-merge-fanout',
      reason: 'realized-merge-fanout-incomplete',
      expiresAt: null,
    };
  }

  if (proposal.status === 'rejected') {
    const expiresAtMs = locallyProvenRejectedPartialRecoveryExpiryMs(proposal);
    const nowMs = now.getTime();
    const decidedAtMs = canonicalTimestampMillis(proposal.decidedAt);
    if (
      expiresAtMs !== null &&
      Number.isFinite(nowMs) &&
      decidedAtMs !== null &&
      nowMs >= decidedAtMs &&
      nowMs <= expiresAtMs
    ) {
      return {
        class: 'active',
        type: 'rejected-partial-recovery',
        reason: 'rejected-partial-recovery',
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    }
    return {
      class: 'excluded',
      type: proposal.isPartial === true ? 'rejected-partial-recovery' : null,
      reason: proposal.isPartial === true
        ? 'rejected-partial-recovery-expired-or-invalid'
        : 'rejected',
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    };
  }

  return { class: 'excluded', type: null, reason: 'failed', expiresAt: null };
}

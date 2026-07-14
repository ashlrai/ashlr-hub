/**
 * remote-handoff.ts — reconcile host-owned PR handoffs back into the inbox.
 *
 * Opening a remote PR is not proof of merge. This module reads host state and
 * advances proposals only when the host provides positive outcome evidence.
 */

import { existsSync } from 'node:fs';
import { listProposals, loadProposal, setStatus, updateProposalField } from './store.js';
import type { Proposal, ProposalRemoteHandoff } from '../types.js';
import type { PrView } from '../integrations/github.js';
import { sanitizeGithubMergedAt } from './remote-handoff-time.js';
import { acquireProposalMutationLock, releaseProposalMutationLock } from './proposal-mutation-lock.js';
import {
  verifyRemoteHandoffReconciliation,
  viewPrWithReconciliation,
} from './remote-handoff-attestation.js';

export interface RemoteHandoffReconcileResult {
  checked: number;
  merged: number;
  closed: number;
  open: number;
  unknown: number;
}

function initialResult(): RemoteHandoffReconcileResult {
  return { checked: 0, merged: 0, closed: 0, open: 0, unknown: 0 };
}

function mergeHandoff(
  handoff: ProposalRemoteHandoff,
  patch: Partial<ProposalRemoteHandoff>,
): ProposalRemoteHandoff {
  return {
    ...handoff,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function selectorFor(handoff: ProposalRemoteHandoff): string | null {
  if (handoff.prUrl && handoff.prUrl.trim()) return handoff.prUrl.trim();
  if (handoff.branch && handoff.branch.trim()) return handoff.branch.trim();
  return null;
}

function isMergedState(state: string | undefined): boolean {
  return state?.toLowerCase() === 'merged';
}

function isClosedState(state: string | undefined): boolean {
  return state?.toLowerCase() === 'closed';
}

function hasConflictingIdentity(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  if (handoff.prUrl && pr.url && handoff.prUrl !== pr.url) return true;
  if (handoff.branch && pr.headRefName && handoff.branch !== pr.headRefName) return true;
  if (handoff.base && pr.baseRefName && handoff.base !== pr.baseRefName) return true;
  if (
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() !== pr.headRefOid.toLowerCase()
  ) return true;
  return false;
}

function hasStrongIdentity(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  return Boolean(
    handoff.prUrl && pr.url && handoff.prUrl === pr.url &&
    handoff.branch && pr.headRefName && handoff.branch === pr.headRefName &&
    handoff.base && pr.baseRefName && handoff.base === pr.baseRefName &&
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() === pr.headRefOid.toLowerCase()
  );
}

/** A URL-less durable intent may bind only a complete observation of its exact PR identity. */
function canBindPrUrl(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  return Boolean(
    !handoff.prUrl && pr.url &&
    handoff.branch && pr.headRefName && handoff.branch === pr.headRefName &&
    handoff.base && pr.baseRefName && handoff.base === pr.baseRefName &&
    handoff.expectedHeadOid && pr.headRefOid &&
    handoff.expectedHeadOid.toLowerCase() === pr.headRefOid.toLowerCase()
  );
}

function sameQueryIdentity(left: ProposalRemoteHandoff, right: ProposalRemoteHandoff): boolean {
  return left.provider === right.provider && left.branch === right.branch &&
    left.base === right.base && left.prUrl === right.prUrl &&
    left.expectedHeadOid === right.expectedHeadOid && left.createdAt === right.createdAt;
}

function awaitingHostMerge(proposal: Proposal | null): proposal is Proposal & {
  remoteHandoff: ProposalRemoteHandoff;
} {
  return proposal?.status === 'awaiting-host-merge' &&
    proposal.remoteHandoff?.state === 'awaiting-host-merge';
}

function reconcileOne(proposal: Proposal): RemoteHandoffReconcileResult {
  const result = initialResult();
  const handoff = proposal.remoteHandoff;
  if (!handoff || handoff.provider !== 'github') return result;
  result.checked++;

  const repo = proposal.repo;
  const selector = selectorFor(handoff);
  if (!repo || !existsSync(repo) || !selector) {
    result.unknown++;
    return result;
  }

  const hostRead = viewPrWithReconciliation(repo, selector, proposal.id, handoff);
  if (!hostRead) {
    result.unknown++;
    return result;
  }
  const { pr, reconciliation } = hostRead;
  const mergedAt = sanitizeGithubMergedAt(pr.mergedAt);
  const mergeCommitOid = typeof pr.mergeCommitOid === 'string' && /^[0-9a-f]{40}$/i.test(pr.mergeCommitOid)
    ? pr.mergeCommitOid.toLowerCase()
    : undefined;
  const terminal = Boolean(mergedAt || isMergedState(pr.state) || pr.closed === true || isClosedState(pr.state));

  // A crash may leave a durable pre-create intent without a PR URL. Bind the
  // discovered URL in its own locked persistence step, then require a second
  // host read before any terminal transition can be signed or applied.
  if (!handoff.prUrl) {
    if (!canBindPrUrl(handoff, pr)) {
      result.unknown++;
      return result;
    }
    const mutationLock = acquireProposalMutationLock(proposal.id);
    if (!mutationLock) {
      result.unknown++;
      return result;
    }
    try {
      const current = loadProposal(proposal.id);
      if (!awaitingHostMerge(current) || current.remoteHandoff.provider !== 'github' ||
        !sameQueryIdentity(handoff, current.remoteHandoff) ||
        !canBindPrUrl(current.remoteHandoff, pr)) {
        result.unknown++;
        return result;
      }
      const detail = `remote PR identity bound; awaiting independent host outcome read: ${pr.url}`;
      if (!updateProposalField(proposal.id, {
        remoteHandoff: mergeHandoff(current.remoteHandoff, {
          state: 'awaiting-host-merge',
          prUrl: pr.url,
          detail,
        }),
      }, mutationLock)) {
        result.unknown++;
        return result;
      }
      if (terminal) result.unknown++;
      else result.open++;
    } finally {
      releaseProposalMutationLock(mutationLock);
    }
    return result;
  }

  if (hasConflictingIdentity(handoff, pr)) {
    result.unknown++;
    return result;
  }
  if (terminal && !hasStrongIdentity(handoff, pr)) {
    result.unknown++;
    return result;
  }

  if (mergedAt || isMergedState(pr.state)) {
    // A sparse MERGED state is not enough for durable terminal attribution.
    // Require the complete host tuple and its locally signed reconciliation
    // receipt; otherwise retain the awaiting handoff for a later complete read.
    if (!mergedAt || !mergeCommitOid || !reconciliation) {
      result.unknown++;
      return result;
    }
    const detail = `remote PR merged${mergedAt ? ` at ${mergedAt}` : ''}${pr.url ? `: ${pr.url}` : ''}`;
    const mutationLock = acquireProposalMutationLock(proposal.id);
    if (!mutationLock) {
      result.unknown++;
      return result;
    }
    try {
      const current = loadProposal(proposal.id);
      if (!awaitingHostMerge(current) || current.remoteHandoff.provider !== 'github' ||
        !sameQueryIdentity(handoff, current.remoteHandoff) ||
        (current.remoteHandoff.mergedAt !== undefined && mergedAt !== undefined &&
          current.remoteHandoff.mergedAt !== mergedAt) ||
        (current.remoteHandoff.mergeCommitOid !== undefined && mergeCommitOid !== undefined &&
          current.remoteHandoff.mergeCommitOid !== mergeCommitOid) ||
        hasConflictingIdentity(current.remoteHandoff, pr) || !hasStrongIdentity(current.remoteHandoff, pr)) {
        result.unknown++;
        return result;
      }
      const currentHandoff = current.remoteHandoff;
      const remoteHandoff = mergeHandoff(currentHandoff, {
        state: 'merged',
        ...(pr.url ? { prUrl: pr.url } : {}),
        mergedAt,
        mergeCommitOid,
        reconciliation,
        detail,
      });
      if (!current.repo || !verifyRemoteHandoffReconciliation(proposal.id, current.repo, remoteHandoff)) {
        result.unknown++;
        return result;
      }
      if (!setStatus(proposal.id, 'applied', detail, undefined, mutationLock, { remoteHandoff })) {
        result.unknown++;
        return result;
      }
      result.merged++;
    } finally {
      releaseProposalMutationLock(mutationLock);
    }
    return result;
  }

  if (pr.closed === true || isClosedState(pr.state)) {
    const detail = `remote PR closed without merge${pr.url ? `: ${pr.url}` : ''}`;
    const mutationLock = acquireProposalMutationLock(proposal.id);
    if (!mutationLock) {
      result.unknown++;
      return result;
    }
    try {
      const current = loadProposal(proposal.id);
      if (!awaitingHostMerge(current) || current.remoteHandoff.provider !== 'github' ||
        !sameQueryIdentity(handoff, current.remoteHandoff) || current.remoteHandoff.mergedAt !== undefined ||
        current.remoteHandoff.mergeCommitOid !== undefined ||
        hasConflictingIdentity(current.remoteHandoff, pr) || !hasStrongIdentity(current.remoteHandoff, pr)) {
        result.unknown++;
        return result;
      }
      const currentHandoff = current.remoteHandoff;
      const remoteHandoff = mergeHandoff(currentHandoff, {
        state: 'closed',
        ...(pr.url ? { prUrl: pr.url } : {}),
        detail,
      });
      if (!setStatus(proposal.id, 'rejected', detail, undefined, mutationLock, { remoteHandoff })) {
        result.unknown++;
        return result;
      }
      result.closed++;
    } finally {
      releaseProposalMutationLock(mutationLock);
    }
    return result;
  }

  const mutationLock = acquireProposalMutationLock(proposal.id);
  if (!mutationLock) {
    result.unknown++;
    return result;
  }
  try {
    const current = loadProposal(proposal.id);
    if (!awaitingHostMerge(current) || current.remoteHandoff.provider !== 'github' ||
      !sameQueryIdentity(handoff, current.remoteHandoff) ||
      hasConflictingIdentity(current.remoteHandoff, pr)) {
      result.unknown++;
      return result;
    }
    const currentHandoff = current.remoteHandoff;
    if (pr.url && pr.url !== currentHandoff.prUrl && !updateProposalField(proposal.id, {
      remoteHandoff: mergeHandoff(currentHandoff, {
        state: 'awaiting-host-merge',
        prUrl: pr.url,
        detail: `remote PR still open: ${pr.url}`,
      }),
    }, mutationLock)) {
      result.unknown++;
      return result;
    }
    result.open++;
  } finally {
    releaseProposalMutationLock(mutationLock);
  }
  return result;
}

export function reconcileRemoteHandoffs(): RemoteHandoffReconcileResult {
  const result = initialResult();
  try {
    const proposals = listProposals({ status: 'awaiting-host-merge' });
    for (const proposal of proposals) {
      const one = reconcileOne(proposal);
      result.checked += one.checked;
      result.merged += one.merged;
      result.closed += one.closed;
      result.open += one.open;
      result.unknown += one.unknown;
    }
  } catch {
    // Never throw from daemon maintenance/readiness paths.
  }
  return result;
}

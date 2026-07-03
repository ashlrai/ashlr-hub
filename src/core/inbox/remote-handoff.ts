/**
 * remote-handoff.ts — reconcile host-owned PR handoffs back into the inbox.
 *
 * Opening a remote PR is not proof of merge. This module reads host state and
 * advances proposals only when the host provides positive outcome evidence.
 */

import { existsSync } from 'node:fs';
import { listProposals, setStatus, updateProposalField } from './store.js';
import { viewPr } from '../integrations/github.js';
import type { Proposal, ProposalRemoteHandoff } from '../types.js';
import type { PrView } from '../integrations/github.js';

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
  return false;
}

function hasStrongIdentity(handoff: ProposalRemoteHandoff, pr: PrView): boolean {
  if (handoff.prUrl && pr.url && handoff.prUrl === pr.url) return true;
  return Boolean(
    handoff.branch &&
    handoff.base &&
    pr.headRefName &&
    pr.baseRefName &&
    handoff.branch === pr.headRefName &&
    handoff.base === pr.baseRefName,
  );
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

  const pr = viewPr(repo, selector);
  if (!pr) {
    result.unknown++;
    return result;
  }
  if (hasConflictingIdentity(handoff, pr)) {
    result.unknown++;
    return result;
  }
  const terminal = Boolean(pr.mergedAt || isMergedState(pr.state) || pr.closed === true || isClosedState(pr.state));
  if (terminal && !hasStrongIdentity(handoff, pr)) {
    result.unknown++;
    return result;
  }

  if (pr.mergedAt || isMergedState(pr.state)) {
    result.merged++;
    const detail = `remote PR merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ''}${pr.url ? `: ${pr.url}` : ''}`;
    updateProposalField(proposal.id, {
      remoteHandoff: mergeHandoff(handoff, {
        state: 'merged',
        ...(pr.url ? { prUrl: pr.url } : {}),
        detail,
      }),
    });
    setStatus(proposal.id, 'applied', detail);
    return result;
  }

  if (pr.closed === true || isClosedState(pr.state)) {
    result.closed++;
    const detail = `remote PR closed without merge${pr.url ? `: ${pr.url}` : ''}`;
    updateProposalField(proposal.id, {
      remoteHandoff: mergeHandoff(handoff, {
        state: 'closed',
        ...(pr.url ? { prUrl: pr.url } : {}),
        detail,
      }),
    });
    setStatus(proposal.id, 'rejected', detail);
    return result;
  }

  result.open++;
  if (handoff.state !== 'awaiting-host-merge' || (pr.url && pr.url !== handoff.prUrl)) {
    updateProposalField(proposal.id, {
      remoteHandoff: mergeHandoff(handoff, {
        state: 'awaiting-host-merge',
        ...(pr.url ? { prUrl: pr.url } : {}),
        detail: `remote PR still open${pr.url ? `: ${pr.url}` : ''}`,
      }),
    });
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

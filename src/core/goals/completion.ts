import type { Goal, Milestone, Proposal } from '../types.js';
import { loadProposal } from '../inbox/store.js';
import { hasRealizedMergeEvidence } from '../inbox/realized-merge.js';

/**
 * Goal milestones close only when the linked proposal both landed and carries
 * passing verification evidence. A bare `applied` status is not enough for the
 * autonomous fleet's progress accounting.
 */
export function proposalCompletesGoalMilestone(
  proposal: Pick<Proposal, 'status' | 'verifyResult' | 'realizedMerge'> | null | undefined,
): boolean {
  return proposal?.status === 'applied' && hasRealizedMergeEvidence(proposal) &&
    proposal.verifyResult?.passed === true;
}

/** Build a read-only, fail-closed completion predicate for goal focus consumers. */
export function createProposalMilestoneCompletionPredicate(): (
  milestone: Milestone,
  goal: Goal,
) => boolean {
  const completionByProposalId = new Map<string, boolean>();
  return (milestone): boolean => {
    const proposalId = milestone.proposalId;
    if (!proposalId) return false;
    const cached = completionByProposalId.get(proposalId);
    if (cached !== undefined) return cached;
    let complete = false;
    try {
      const proposal = loadProposal(proposalId);
      complete = proposal?.id === proposalId && proposalCompletesGoalMilestone(proposal);
    } catch {
      complete = false;
    }
    completionByProposalId.set(proposalId, complete);
    return complete;
  };
}

import type { Proposal } from '../types.js';

/**
 * Goal milestones close only when the linked proposal both landed and carries
 * passing verification evidence. A bare `applied` status is not enough for the
 * autonomous fleet's progress accounting.
 */
export function proposalCompletesGoalMilestone(
  proposal: Pick<Proposal, 'status' | 'verifyResult'> | null | undefined,
): boolean {
  return proposal?.status === 'applied' && proposal.verifyResult?.passed === true;
}

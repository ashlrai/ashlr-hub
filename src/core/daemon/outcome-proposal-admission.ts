import { realpathSync } from 'node:fs';
import type { Proposal } from '../types.js';
import { loadProposal } from '../inbox/store.js';
import { loadGoal, isValidGoalOutcomeBinding } from '../goals/store.js';
import { matchesOutcomeGoal, outcomeDirectory } from '../goals/outcome-runtime.js';
import { goalProjectMatchesRepo } from '../goals/project-match.js';
import { OutcomeStore } from '../goals/outcome-store.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';

export type OutcomeProposalAdmission = { state: 'legacy' | 'admitted'; reason: null } |
  { state: 'held'; reason: string };

/** Additional current-scope fence for the existing standing progression gates.
 * The protected selected terminal tuple, rather than planner/request metadata,
 * binds a pending proposal to its active outcome. This grants no authority:
 * existing policy, financial, CI and merge gates must still pass independently. */
export function readOutcomeProposalAdmission(proposal: Proposal): OutcomeProposalAdmission {
  const held = (reason: string): OutcomeProposalAdmission => ({ state: 'held', reason });
  try {
    const persisted = loadProposal(proposal.id);
    const marked = (value: Proposal | null): boolean =>
      typeof value?.workItemId === 'string' && value.workItemId.startsWith('goal:outcome-') ||
      typeof value?.workItemGenerationId === 'string' && value.workItemGenerationId.startsWith('outcome:');
    // A transport copy cannot turn protected outcome work into legacy work by
    // dropping its markers. Genuine legacy proposals retain their old gates.
    if (!marked(proposal) && !marked(persisted)) return { state: 'legacy', reason: null };
    if (!persisted || persisted.status !== 'pending' ||
        (['workItemId', 'workItemGenerationId', 'repo', 'runId', 'trajectoryId'] as const)
          .some(key => persisted[key] !== proposal[key])) return held('Protected outcome proposal identity is unavailable or changed.');
    const match = /^goal:(outcome-[a-f0-9]{64}):(milestone-[a-f0-9]{64})$/.exec(persisted.workItemId ?? '');
    const goal = match ? loadGoal(match[1]!) : null;
    if (!match || !goal || !isValidGoalOutcomeBinding(goal.outcome) || goal.status !== 'active' ||
        !['pending', 'in-progress'].includes(goal.milestones[0]?.status ?? '')) return held('Protected outcome Goal is unavailable or paused.');
    const read = new OutcomeStore(outcomeDirectory(goal.outcome.outcomeId)).read();
    if (read.sourceState !== 'healthy' || read.state.paused || !read.state.activeNodeIds.includes(goal.outcome.nodeId))
      return held('Outcome scope is unavailable, paused or retired.');
    const node = read.state.nodes[goal.outcome.nodeId];
    const attempt = node?.attempts.at(-1);
    if (!node || node.completion || node.basis.definition.kind !== 'work' || !matchesOutcomeGoal(read.state, node, goal) ||
        node.materialization.state !== 'linked' || !attempt || attempt.state !== 'proposed' ||
        attempt.proposalId !== persisted.id || attempt.workItemId !== persisted.workItemId ||
        attempt.generationId !== persisted.workItemGenerationId || attempt.executionRepo !== persisted.repo ||
        attempt.terminalRunId !== persisted.runId || !attempt.providerRunIds.includes(persisted.runId ?? '') ||
        persisted.trajectoryId !== `run:${attempt.terminalRunId}` ||
        realpathSync.native(attempt.executionRepo) !== attempt.executionRepo)
      return held('Proposal is not the current protected selected outcome result.');
    const enrollment = readEnrollmentRegistry();
    if (enrollment.state !== 'ready' || !enrollment.repos.includes(attempt.executionRepo) ||
        !goalProjectMatchesRepo(goal.project, attempt.executionRepo)) return held('Outcome execution repository is no longer enrolled.');
    return { state: 'admitted', reason: null };
  } catch { return held('Outcome proposal sources could not be inspected.'); }
}

/** Re-read before every outward contact, including after awaited gate work. */
export function outcomeProposalStillCurrent(proposal: Proposal): boolean {
  return readOutcomeProposalAdmission(proposal).state !== 'held';
}

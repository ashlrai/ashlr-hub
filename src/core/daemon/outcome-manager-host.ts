/** Host admission shared by manager discovery and the existing resident producer seam. */
import type { OutcomeAdmission } from '../goals/outcome-coordinator.js';
import type { OutcomeManagerAdmission } from '../goals/outcome-manager.js';
import type { OutcomeManagerRoute, OutcomeManagerStage } from '../goals/outcome-manager-types.js';
import type { OutcomeState } from '../goals/outcome-types.js';
import { managerSessionTargetsMatch } from '../verse/manager-scope.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import type { EffectivePolicy } from '../authority/types.js';
import { readOutcomeManagerConversation } from '../verse/manager-conversation.js';
import { readOutcomeManagerSessionMetadata } from '../verse/session-store.js';

export interface ManagerHostSources {
  session: typeof readOutcomeManagerSessionMetadata;
  conversation: typeof readOutcomeManagerConversation;
  enrolled(): readonly string[] | null;
  targetsMatch: typeof managerSessionTargetsMatch;
}
const sources: ManagerHostSources = { session: readOutcomeManagerSessionMetadata, conversation: readOutcomeManagerConversation,
  enrolled: () => { const registry = readEnrollmentRegistry(); return registry.state === 'ready' ? registry.repos : null; },
  targetsMatch: managerSessionTargetsMatch };

/** The saved user conversation is private source material, never a launch instruction or credential. */
export function managerConversation(state: OutcomeState, basis: OutcomeManagerStage['basis'], reads = sources): string | null {
  if (!state.manager?.sessionId) return state.manager?.mode === 'resident' ? '' : null;
  const refs = state.manager.interjections.filter(ref => ref.revision <= basis.conversationRevision);
  if (refs.length !== basis.conversationRevision) return null;
  const saved = reads.conversation(state.manager.sessionId, state.id, refs);
  return saved ? saved.map(message => message.text).join('\n\n') : null;
}

/** Contact permission still comes from the selected live account and existing host queue/Stop fences. */
export function managerHostAdmission(base: OutcomeAdmission, options: {
  routeAllowed(route: OutcomeManagerRoute, executionRepo: string): boolean;
  routeCurrent(route: OutcomeManagerRoute, executionRepo: string): boolean;
  policy(): EffectivePolicy | null;
  repoIdentity(path: string): string | null;
  sources?: ManagerHostSources;
}): OutcomeManagerAdmission {
  const reads = options.sources ?? sources;
  const sessionAllowed: OutcomeManagerAdmission['sessionAllowed'] = (sessionId, state) => {
    const session = reads.session(sessionId);
    const enrolled = reads.enrolled();
    return !!session && enrolled !== null && reads.targetsMatch(session.roots, enrolled, state.scope.targetRepos) &&
      state.scope.targetRepos.every(target => base.executionRepoAllowed(target, target));
  };
  return { ...base, routeAllowed: options.routeAllowed, routeCurrent: options.routeCurrent, sessionAllowed,
    messageExists: (ref, state) => sessionAllowed(ref.sessionId, state) &&
      reads.conversation(ref.sessionId, state.id, [ref])?.length === 1,
    planAllowed: (state, plan) => {
      const policy = options.policy();
      if (!policy || !base.stillAuthorized()) return false;
      const risk = { low: 0, medium: 1, high: 2 };
      return plan.nodes.every(node => {
        const target = node.targetRepo;
        if (node.kind !== 'work' || typeof target !== 'string' || !state.scope.targetRepos.includes(target) ||
            !base.executionRepoAllowed(target, target)) return false;
        const identity = options.repoIdentity(target);
        const granted = identity && policy.repos.find(repo => repo.nameWithOwner.toLowerCase() === identity.toLowerCase());
        return !!granted && risk[node.riskClass] <= risk[granted.maxRisk];
      });
    },
  };
}

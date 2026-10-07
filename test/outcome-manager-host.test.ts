import { describe, expect, it } from 'vitest';
import { managerConversation, managerHostAdmission, type ManagerHostSources } from '../src/core/daemon/outcome-manager-host.js';
import type { OutcomeState } from '../src/core/goals/outcome-types.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { OutcomeManagerStage } from '../src/core/goals/outcome-manager-types.js';
import type { MissionGraphInput } from '../src/core/vision/mission-graph.js';

function fixture() {
  const root = '/fixture/repo';
  const refs = [{ sessionId: 'chat-1', messageId: 'message-1', eventSeq: 8, revision: 1 }];
  const state = { id: 'outcome', scope: { targetRepos: [root] }, manager: { mode: 'interactive', sessionId: 'chat-1', interjections: refs } } as OutcomeState;
  let authorized = true;
  let roots = [root];
  let conversationAvailable = true;
  let enrolled: readonly string[] | null = [root];
  const reads: ManagerHostSources = {
    enrolled: () => enrolled,
    targetsMatch: (roots, enrolled, targets) => roots.length === targets.length && roots.every(path => enrolled.includes(path) && targets.includes(path)),
    session: id => id === 'chat-1' ? { id, roots, engine: 'codex', model: 'test-model', seatId: 'codex-personal', status: 'idle' } : null,
    conversation: (_id, _outcome, references) => conversationAvailable ? references.map(ref => ({ messageId: ref.messageId, eventSeq: ref.eventSeq, text: 'Saved private message' })) : null,
  };
  const policy = { repos: [{ nameWithOwner: 'fixture/repo', maxRisk: 'medium' }] } as EffectivePolicy;
  const admission = managerHostAdmission({ stillAuthorized: () => authorized, executionRepoAllowed: (target, execution) => target === root && execution === root },
    { routeAllowed: () => authorized, routeCurrent: () => authorized, policy: () => policy, repoIdentity: () => 'fixture/repo', sources: reads });
  const plan = { nodes: [{ kind: 'work', targetRepo: root, riskClass: 'low' }] } as MissionGraphInput;
  return { root, state, reads, admission, plan, revoke: () => { authorized = false; },
    loseEnrollment: () => { enrolled = null; },
    addRoot: () => { roots = [...roots, '/fixture/unscoped']; }, loseConversation: () => { conversationAvailable = false; } };
}
describe('manager host source and plan admission', () => {
  it('requires exact saved chat roots and rejects an extra workspace', () => {
    const f = fixture(); expect(f.admission.sessionAllowed('chat-1', f.state)).toBe(true);
    expect(f.admission.sessionAllowed('missing', f.state)).toBe(false);
    f.addRoot(); expect(f.admission.sessionAllowed('chat-1', f.state)).toBe(false);
  });
  it('keeps model-authored work within the current target and risk policy', () => {
    const f = fixture(); expect(f.admission.planAllowed(f.state, f.plan)).toBe(true);
    expect(f.admission.planAllowed(f.state, { ...f.plan, nodes: [{ ...f.plan.nodes[0]!, riskClass: 'high' }] })).toBe(false);
    expect(f.admission.planAllowed(f.state, { ...f.plan, nodes: [{ ...f.plan.nodes[0]!, targetRepo: '/fixture/unscoped' }] })).toBe(false);
    f.revoke(); expect(f.admission.planAllowed(f.state, f.plan)).toBe(false);
  });
  it('does not admit a saved chat from an unavailable current enrollment', () => {
    const f = fixture(); f.loseEnrollment();
    expect(f.admission.sessionAllowed('chat-1', f.state)).toBe(false);
    expect(f.admission.messageExists({ sessionId: 'chat-1', messageId: 'message-1', eventSeq: 8 }, f.state)).toBe(false);
  });
  it('requires the complete saved reference prefix for the actual manager basis', () => {
    const f = fixture(); const basis = { conversationRevision: 1 } as OutcomeManagerStage['basis'];
    expect(managerConversation(f.state, basis, f.reads)).toBe('Saved private message');
    expect(managerConversation(f.state, { ...basis, conversationRevision: 2 }, f.reads)).toBeNull();
    f.loseConversation(); expect(managerConversation(f.state, basis, f.reads)).toBeNull();
    expect(f.admission.messageExists({ sessionId: 'chat-1', messageId: 'message-1', eventSeq: 8 }, f.state)).toBe(false);
  });
});

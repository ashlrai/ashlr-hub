import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { materializeOutcomeIntents, outcomeDirectory } from '../src/core/goals/outcome-runtime.js';
import { loadGoal, saveGoal } from '../src/core/goals/store.js';
import { createProposal, inboxDir } from '../src/core/inbox/store.js';
import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { enroll, unenroll } from '../src/core/sandbox/policy.js';
import { mirrorPathFor } from '../src/core/fleet/mirrors.js';
import { outcomeProposalStillCurrent, readOutcomeProposalAdmission } from '../src/core/daemon/outcome-proposal-admission.js';
import type { Proposal } from '../src/core/types.js';

let fx: H1Fixture;
beforeEach(() => { fx = makeFixture(); });
afterEach(() => fx.cleanup());
function fixture(execution: 'primary' | 'mirror' | 'sibling' = 'primary') {
  const repo = fx.makeRepo(); repo.enroll();
  let executionRepo = repo.dir;
  if (execution !== 'primary') {
    execFileSync('git', ['-C', repo.dir, 'remote', 'add', 'origin', 'https://github.com/fixture/outcome.git']);
    executionRepo = execution === 'mirror' ? mirrorPathFor('fixture/outcome') : join(fx.home, 'sibling');
    mkdirSync(dirname(executionRepo), { recursive: true });
    execFileSync('git', ['clone', '--local', repo.dir, executionRepo], { stdio: 'pipe' });
    execFileSync('git', ['-C', executionRepo, 'remote', 'set-url', 'origin', 'https://github.com/fixture/outcome.git']);
    enroll(executionRepo);
  }
  const store = new OutcomeStore(outcomeDirectory('outcome')); const coordinator = new OutcomeCoordinator(store);
  let seq = 0; const command = () => ({ commandId: `test-${++seq}`, expectedRevision: store.read().state?.revision ?? 0 });
  const scope = { desiredOutcome: 'Ship current approved improvements', targetRepos: [repo.dir], acceptance: ['Verified merge'] };
  expect(coordinator.start(command(), 'outcome', scope).ok).toBe(true);
  expect(coordinator.refinePlan(command(), { missionKey: 'outcome', title: 'Plan', objective: scope.desiredOutcome,
    createdAt: '2026-10-02T00:00:00.000Z', nodes: [{ key: 'a', kind: 'work', title: 'Build A', objective: 'Implement A',
      deliverable: 'Verified A', targetRepo: repo.dir, dependsOn: [], riskClass: 'low', acceptance: ['Meaningful tests pass'] }] },
  { sourceState: 'healthy', complete: true, repos: [repo.dir] }).ok).toBe(true);
  expect(materializeOutcomeIntents('outcome', { stillAuthorized: () => true }).outcomes[0]?.status).toBe('linked');
  const state = store.read().state!; const node = state.nodes[state.activeNodeIds[0]!]!;
  // The sibling case deliberately seeds an adversarial host record: sharing an
  // origin/enrollment alone must not widen the proposal's actual mirror lens.
  const admission = { stillAuthorized: () => true, executionRepoAllowed: () => true };
  expect(coordinator.claimRunReady(command(), node.id, executionRepo, 'run-parent', admission).ok).toBe(true);
  const attempt = store.read().state!.nodes[node.id]!.attempts[0]!;
  expect(coordinator.registerProviderRun(command(), node.id, attempt.id, attempt.generationId, 'run-winner', admission).ok).toBe(true);
  const proposal = createProposal({ repo: executionRepo, origin: 'agent', kind: 'patch', title: 'A', summary: 'Verified current task',
    diff: 'test-only diff', producerStatus: 'done', runId: 'run-winner', trajectoryId: 'run:run-winner',
    workItemId: attempt.workItemId, workItemGenerationId: attempt.generationId });
  expect(coordinator.joinTerminalCurrent('terminal', { nodeId: node.id, attemptId: attempt.id, generationId: attempt.generationId,
    executionRepo, runId: 'run-winner', proposalId: proposal.id, state: 'proposed' }).ok).toBe(true);
  const persist = (value: Proposal) => writeFileSync(join(inboxDir(), `${value.id}.json`), JSON.stringify(value), { mode: 0o600 });
  return { repo, executionRepo, store, coordinator, command, scope, node, attempt, proposal, persist };
}

describe('protected outcome proposal progression admission', () => {
  it('admits the actual protected selected BON result without granting merge authority', () => {
    const f = fixture(); expect(readOutcomeProposalAdmission(f.proposal)).toEqual({ state: 'admitted', reason: null });
    expect(outcomeProposalStillCurrent(f.proposal)).toBe(true);
    expect(f.store.read().state!.nodes[f.node.id]!.completion).toBeNull();
  });
  it('holds an admitted protected outcome at the legacy automatic merge entry point', async () => {
    const f = fixture(); expect(outcomeProposalStillCurrent(f.proposal)).toBe(true);
    const before = f.repo.gitStatus(); const cfg = makeCfg();
    cfg.foundry = { ...cfg.foundry, autoMerge: { ...cfg.foundry?.autoMerge, enabled: true } };
    const result = await autoMergeProposal(f.proposal.id, cfg);
    expect(result).toMatchObject({ ok: false, merged: false,
      reason: 'Outcome proposals require current standing host progression; legacy automatic merge is held' });
    expect(f.repo.gitStatus()).toBe(before);
    expect(f.store.read().state!.nodes[f.node.id]!.completion).toBeNull();
  });
  it.each(['mirror', 'sibling'] as const)('preserves the existing exact Fleet mirror lens for an enrolled %s', execution => {
    const f = fixture(execution);
    expect(outcomeProposalStillCurrent(f.proposal)).toBe(execution === 'mirror');
    unenroll(f.executionRepo); expect(outcomeProposalStillCurrent(f.proposal)).toBe(false);
  });
  it('rechecks pause and edited scope instead of trusting a previous positive result', () => {
    const f = fixture(); expect(outcomeProposalStillCurrent(f.proposal)).toBe(true);
    expect(f.coordinator.setPaused(f.command(), true).ok).toBe(true); expect(outcomeProposalStillCurrent(f.proposal)).toBe(false);
    expect(f.coordinator.setPaused(f.command(), false).ok).toBe(true); expect(outcomeProposalStillCurrent(f.proposal)).toBe(true);
    expect(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['Revised acceptance'] }).ok).toBe(true);
    expect(outcomeProposalStillCurrent(f.proposal)).toBe(false);
  });
  it('holds when the bound Goal is independently paused or the execution root is unenrolled', () => {
    const f = fixture(); const goal = loadGoal(f.node.materialization.goalId)!;
    expect(saveGoal({ ...goal, status: 'paused' })).toBe(true); expect(outcomeProposalStillCurrent(f.proposal)).toBe(false);
    expect(saveGoal({ ...loadGoal(goal.id)!, status: 'active' })).toBe(true); expect(outcomeProposalStillCurrent(f.proposal)).toBe(true);
    unenroll(f.repo.dir); expect(outcomeProposalStillCurrent(f.proposal)).toBe(false);
  });
  it('rejects altered protected causal identities including another registered provider candidate', () => {
    const f = fixture();
    const stripped = { ...f.proposal }; delete stripped.workItemId; delete stripped.workItemGenerationId;
    expect(readOutcomeProposalAdmission(stripped).state).toBe('held');
    const changes: Array<Partial<Proposal>> = [{ runId: 'run-parent', trajectoryId: 'run:run-parent' }, { trajectoryId: 'run:foreign' },
      { workItemGenerationId: `outcome:v1:${'a'.repeat(64)}` }, { workItemId: 'goal:foreign' }, { repo: fx.home }, { status: 'rejected' }];
    for (const change of changes) {
      const altered = { ...f.proposal, ...change }; f.persist(altered);
      expect(outcomeProposalStillCurrent(f.proposal)).toBe(false);
      expect(outcomeProposalStillCurrent(altered)).toBe(false);
    }
    f.persist(f.proposal); expect(outcomeProposalStillCurrent(f.proposal)).toBe(true);
  });
  it('holds unknown outcome records and missing protected proposals', () => {
    const f = fixture();
    expect(outcomeProposalStillCurrent({ ...f.proposal, id: 'missing' })).toBe(false);
    writeFileSync(join(f.store.directory, 'ledger', 'records', 'unknown.json'), '{}', { mode: 0o600 });
    expect(readOutcomeProposalAdmission(f.proposal).state).toBe('held');
  });
  it('leaves legacy proposals unchanged but holds malformed outcome markers', () => {
    const legacy = { id: 'legacy', workItemId: 'goal:ordinary', repo: '/legacy' } as Proposal;
    expect(readOutcomeProposalAdmission(legacy)).toEqual({ state: 'legacy', reason: null });
    expect(outcomeProposalStillCurrent({ ...legacy, workItemId: 'goal:outcome-malformed' })).toBe(false);
    expect(outcomeProposalStillCurrent({ ...legacy, workItemGenerationId: 'outcome:malformed' })).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), proposal: vi.fn() }));
vi.mock('../src/core/goals/outcome-runtime.js', () => ({ readOutcomeWorkItemContext: mocks.context }));
vi.mock('../src/core/inbox/store.js', () => ({ loadProposal: mocks.proposal }));
import { OutcomeDispatch, isOutcomeWorkItem, reconcileOutcomeCompletions } from '../src/core/daemon/outcome-dispatch.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import type { OutcomeGoalContext } from '../src/core/goals/outcome-runtime.js';
import type { WorkItem } from '../src/core/types.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); mocks.context.mockReset(); mocks.proposal.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-dispatch-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const store = new OutcomeStore(join(root, 'outcome')); const coordinator = new OutcomeCoordinator(store);
  const scope = { desiredOutcome: 'Ship reliable automatic work', targetRepos: [repo], acceptance: ['Full acceptance ' + 'x'.repeat(5000)] };
  let seq = 0;
  const command = () => ({ commandId: `c-${++seq}`, expectedRevision: store.read().state?.revision ?? 0 });
  expect(coordinator.start(command(), 'outcome', scope).ok).toBe(true);
  expect(coordinator.refinePlan(command(), { missionKey: 'outcome', title: 'Plan', objective: scope.desiredOutcome,
    createdAt: '2026-10-02T00:00:00.000Z', nodes: [{ kind: 'work', key: 'a', title: 'Build A', objective: 'Implement A',
      deliverable: 'Verified A', riskClass: 'low', targetRepo: repo, dependsOn: [], acceptance: ['A works'] }] },
  { sourceState: 'healthy', complete: true, repos: [repo] }).ok).toBe(true);
  const nodeId = store.read().state!.activeNodeIds[0]!;
  const node = () => store.read().state!.nodes[nodeId]!;
  expect(coordinator.linkMaterialization(command(), nodeId, node().materialization.goalId, node().materialization.milestoneId,
    { stillAuthorized: () => true, matchesPersistedGoal: () => true }).ok).toBe(true);
  const item = { id: `goal:${node().materialization.goalId}:${node().materialization.milestoneId}`, source: 'goal', repo, tags: ['outcome'], detail: 'short' } as WorkItem;
  const context = () => ({ store, state: store.read().state!, node: node(), goal: {} } as OutcomeGoalContext);
  mocks.context.mockImplementation(() => {
    const current = context(); return current.state.paused || !current.state.activeNodeIds.includes(nodeId) ? null : current;
  });
  let authorized = true;
  const admission = { stillAuthorized: () => authorized, executionRepoAllowed: (a: string, b: string) => a === b };
  const dispatch = (runId = 'run-parent') => new OutcomeDispatch(context(), item, runId, admission);
  return { store, coordinator, command, scope, node, item, context, dispatch, revoke: () => { authorized = false; } };
}
describe('actual resident outcome dispatch bridge', () => {
  it('includes full scope acceptance rather than bounded work-item display text', () => {
    const f = fixture(); expect(f.dispatch().prompt()).toContain(f.scope.acceptance[0]);
    expect(f.dispatch().prompt()).toContain('A works'); expect(f.dispatch().prompt().length).toBeGreaterThan(5000);
  });
  it('joins exact generated identity and refuses a restarted duplicate launch', () => {
    const f = fixture(); const first = f.dispatch(); expect(first.begin()).toBe(true);
    expect(f.node().attempts[0]).toMatchObject({ runId: 'run-parent', generationId: first.generationId, state: 'running' });
    expect(f.dispatch().begin()).toBe(false); expect(f.dispatch('run-other').begin()).toBe(false);
    expect(f.node().attempts).toHaveLength(1);
  });
  it('checks pause and current authority after a claim and before every candidate', () => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    expect(dispatch.registerProviderRun('run-candidate')).toBe(true);
    expect(f.coordinator.setPaused(f.command(), true).ok).toBe(true);
    expect(dispatch.stillAuthorized()).toBe(false); expect(dispatch.registerProviderRun('run-late')).toBe(false);
    expect(f.node().attempts[0]!.providerRunIds).toEqual(['run-parent', 'run-candidate']);
  });
  it('refuses revoked initial admission without writing a claim', () => {
    const f = fixture(); f.revoke(); expect(f.dispatch().begin()).toBe(false); expect(f.node().attempts).toEqual([]);
  });
  it('retains retired failed-run history without completing a revised node', () => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    expect(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['New scope'] }).ok).toBe(true);
    expect(dispatch.stillAuthorized()).toBe(false); expect(dispatch.finish(undefined, true)).toBe(true);
    expect(f.node().attempts[0]).toMatchObject({ state: 'aborted', terminalRunId: 'run-parent', proposalId: null });
    expect(f.coordinator.project().complete).toBe(false);
  });
  it('joins the protected proposal to its registered winner, never controller or invented candidate', () => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    expect(dispatch.finish({ outcome: 'proposal-created', runId: 'unregistered', proposalId: 'p' })).toBe(false);
    expect(dispatch.registerProviderRun('winner')).toBe(true);
    mocks.proposal.mockReturnValue({ id: 'p', runId: 'winner', repo: f.item.repo, workItemId: f.item.id,
      workItemGenerationId: dispatch.generationId, trajectoryId: 'run:winner' });
    expect(dispatch.finish({ outcome: 'proposal-created', runId: 'winner', proposalId: 'p' })).toBe(true);
    expect(f.node().attempts[0]).toMatchObject({ state: 'proposed', terminalRunId: 'winner', runId: 'run-parent' });
    expect(reconcileOutcomeCompletions(f.context())).toBe(0); // no authenticated merge evidence
    expect(f.coordinator.project().complete).toBe(false);
  });
  it('keeps the actual terminal result when an operator edit advances revision during its protected proposal read', () => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    mocks.proposal.mockImplementation(() => {
      expect(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['Revised while finishing'] }).ok).toBe(true);
      return { id: 'p', runId: 'run-parent', repo: f.item.repo, workItemId: f.item.id,
        workItemGenerationId: dispatch.generationId, trajectoryId: 'run:run-parent' };
    });
    expect(dispatch.finish({ outcome: 'proposal-created', runId: 'run-parent', proposalId: 'p' })).toBe(true);
    expect(f.node().attempts[0]).toMatchObject({ state: 'proposed', terminalRunId: 'run-parent', proposalId: 'p' });
    expect(f.store.read().state?.scope.acceptance).toEqual(['Revised while finishing']);
    expect(f.coordinator.project().complete).toBe(false);
  });
  it('records synchronous producer cancellation before the watchdog signal has fired', () => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    expect(f.coordinator.setPaused(f.command(), true).ok).toBe(true);
    expect(dispatch.finish({ outcome: 'cancelled', runId: 'run-parent' }, false)).toBe(true);
    expect(f.node().attempts[0]).toMatchObject({ state: 'aborted', proposalId: null });
  });
  it.each(['workItemId', 'workItemGenerationId', 'trajectoryId', 'repo', 'runId'])('does not treat a mismatched %s as a filed outcome proposal', field => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    mocks.proposal.mockReturnValue({ id: 'p', runId: 'run-parent', repo: f.item.repo, workItemId: f.item.id,
      workItemGenerationId: dispatch.generationId, trajectoryId: 'run:run-parent', [field]: 'wrong' });
    expect(dispatch.finish({ outcome: 'proposal-created', runId: 'run-parent', proposalId: 'p' })).toBe(true);
    expect(f.node().attempts[0]).toMatchObject({ state: 'failed', proposalId: null });
  });
  it('identifies a stripped outcome tag by canonical ID, keeping unavailable candidates out of legacy dispatch', () => {
    const f = fixture(); expect(isOutcomeWorkItem({ ...f.item, tags: [] })).toBe(true);
    expect(isOutcomeWorkItem({ id: 'repo:goal:legacy', tags: [] })).toBe(false);
  });
  it('retries actual temporary lock contention with the same protected terminal exactly once', async () => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    mocks.proposal.mockReturnValue({ id: 'p', runId: 'run-parent', repo: f.item.repo, workItemId: f.item.id,
      workItemGenerationId: dispatch.generationId, trajectoryId: 'run:run-parent' });
    const lock = acquireLocalStoreLockWithOutcome(join(f.store.directory, '.outcome.lock'), 0,
      { anchorPath: f.store.directory, exactPrivateStorage: true });
    expect(lock.state).toBe('acquired'); if (lock.state !== 'acquired') throw new Error('Fixture lock unavailable');
    const terminalJoin = vi.spyOn(OutcomeCoordinator.prototype, 'joinTerminalCurrent');
    const timer = setTimeout(() => {
      releaseLocalStoreLock(lock.lock);
      expect(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['Edited while terminal waited'] }).ok).toBe(true);
    }, 15);
    try {
      expect(await dispatch.finishWithRetry({ outcome: 'proposal-created', runId: 'run-parent', proposalId: 'p' })).toBe(true);
      expect(terminalJoin).toHaveBeenCalledTimes(2);
      expect(terminalJoin.mock.calls[1]![0]).toBe(terminalJoin.mock.calls[0]![0]);
      expect(terminalJoin.mock.calls[1]![1]).toBe(terminalJoin.mock.calls[0]![1]);
      expect(mocks.proposal).toHaveBeenCalledTimes(1);
      expect(f.node().attempts[0]).toMatchObject({ state: 'proposed', proposalId: 'p', terminalRunId: 'run-parent' });
      expect(f.store.read().records.filter(record => record.commandId.startsWith('terminal-'))).toHaveLength(1);
      expect(f.coordinator.project().complete).toBe(false);
    } finally { clearTimeout(timer); releaseLocalStoreLock(lock.lock); }
  });
  it.each(['conflict', 'invalid', 'storage-failed', 'held', 'unknown-source'] as const)('does not retry %s or change the running attempt', async reason => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    const join = vi.spyOn(OutcomeCoordinator.prototype, 'joinTerminalCurrent').mockReturnValue({ ok: false, reason });
    expect(await dispatch.finishWithRetry({ outcome: 'cancelled', runId: 'run-parent' })).toBe(false);
    expect(join).toHaveBeenCalledOnce(); expect(f.node().attempts[0]?.state).toBe('running');
  });
  it('bounds persistent lock contention without relaunching or inventing terminal evidence', async () => {
    const f = fixture(); const dispatch = f.dispatch(); expect(dispatch.begin()).toBe(true);
    const lock = acquireLocalStoreLockWithOutcome(join(f.store.directory, '.outcome.lock'), 0,
      { anchorPath: f.store.directory, exactPrivateStorage: true });
    expect(lock.state).toBe('acquired'); if (lock.state !== 'acquired') throw new Error('Fixture lock unavailable');
    const terminalJoin = vi.spyOn(OutcomeCoordinator.prototype, 'joinTerminalCurrent');
    try {
      expect(f.coordinator.setPaused(f.command(), true)).toEqual({ ok: false, reason: 'conflict' });
      expect(await dispatch.finishWithRetry({ outcome: 'cancelled', runId: 'run-parent' })).toBe(false);
      expect(terminalJoin).toHaveBeenCalledTimes(6);
      expect(f.node().attempts).toHaveLength(1); expect(f.node().attempts[0]?.state).toBe('running');
    } finally { releaseLocalStoreLock(lock.lock); }
  });

  it('atomically registers the parent with its claim; an unrelated writer leaves no stranded claim', () => {
    const f = fixture(); const dispatch = f.dispatch();
    const atomic = OutcomeCoordinator.prototype.claimRunReady;
    const oldClaim = vi.spyOn(OutcomeCoordinator.prototype, 'claimReady');
    const oldJoin = vi.spyOn(OutcomeCoordinator.prototype, 'joinRun');
    const claim = vi.spyOn(OutcomeCoordinator.prototype, 'claimRunReady').mockImplementationOnce((command, nodeId, repo, runId, admission) => {
      // Another metadata writer advances the CAS after discovery, before claim.
      expect(f.coordinator.setPaused(f.command(), false).ok).toBe(true);
      return atomic.call(f.coordinator, command, nodeId, repo, runId, admission);
    });
    expect(dispatch.begin()).toBe(false); expect(f.node().attempts).toEqual([]);
    expect(dispatch.begin()).toBe(true);
    expect(claim).toHaveBeenCalledTimes(2); expect(oldClaim).not.toHaveBeenCalled(); expect(oldJoin).not.toHaveBeenCalled();
    expect(f.node().attempts).toHaveLength(1);
    expect(f.node().attempts[0]).toMatchObject({ state: 'running', runId: 'run-parent', providerRunIds: ['run-parent'],
      generationId: dispatch.generationId, terminalRunId: null, proposalId: null });
    expect(f.store.read().records.filter(record => record.commandId === 'dispatch-claim-run-parent')).toHaveLength(1);
    expect(f.dispatch().begin()).toBe(false); // Replay does not launch another run.
  });

});

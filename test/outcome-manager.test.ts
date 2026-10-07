import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutcomeCoordinator, refineOutcomeState } from '../src/core/goals/outcome-coordinator.js';
import { OutcomeManagerCoordinator, projectOutcomeManager, type OutcomeManagerAdmission } from '../src/core/goals/outcome-manager.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { outcomeDigest } from '../src/core/goals/outcome-types.js';
import { outcomeManagerBasis, managerWorkItemId, type OutcomeManagerRoute } from '../src/core/goals/outcome-manager-types.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-manager-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const store = new OutcomeStore(join(root, 'outcome')); const work = new OutcomeCoordinator(store);
  const manager = new OutcomeManagerCoordinator(store);
  const scope = { desiredOutcome: 'Make useful verified progress', targetRepos: [repo], acceptance: ['Actual tests and actual protected merges'] };
  let seq = 0; let authorized = true; let routeAuthorized = true;
  const command = () => ({ commandId: `command-${++seq}`, expectedRevision: store.read().state?.revision ?? 0 });
  const admission: OutcomeManagerAdmission = { stillAuthorized: () => authorized, executionRepoAllowed: (target, execution) => target === execution,
    routeAllowed: () => routeAuthorized, routeCurrent: () => routeAuthorized, sessionAllowed: sessionId => sessionId === 'chat-1', messageExists: () => true, planAllowed: () => true };
  const route: OutcomeManagerRoute = { engine: 'codex', seatId: 'codex-personal', model: 'frontier-test', tier: 'frontier' };
  expect(work.start(command(), 'outcome', scope).ok).toBe(true);
  const configure = (interactive = false) => manager.configure(command(), { mode: interactive ? 'interactive' : 'resident',
    sessionId: interactive ? 'chat-1' : null }, admission);
  const claim = (runId = 'run-manager') => manager.claimRun(command(), manager.project().next!, repo, route, runId, admission);
  const stage = () => store.read().state!.manager!.stages.at(-1)!;
  const plan = () => ({ missionKey: 'outcome', title: 'Actual plan', objective: scope.desiredOutcome, createdAt: '2026-10-07T00:00:00.000Z',
    nodes: [{ kind: 'work' as const, key: 'build', title: 'Build useful change', objective: 'Implement and verify the change',
      deliverable: 'Verified proposal', riskClass: 'low' as const, targetRepo: repo, dependsOn: [], acceptance: ['Regression coverage passes'] }] });
  return { root, repo, store, work, manager, scope, command, admission, route, configure, claim, stage, plan,
    revoke: () => { authorized = false; }, revokeRoute: () => { routeAuthorized = false; } };
}
describe('durable tool-capable outcome manager', () => {
  it('retains exact historical v1 bytes and work semantics on explicit v2 configuration and restart', () => {
    const f = fixture(); const ledger = join(f.store.directory, 'ledger', 'records'); const file = join(ledger, readdirSync(ledger).find(name => name.endsWith('.json'))!); const original = readFileSync(file);
    expect(f.manager.project()).toMatchObject({ enabled: false, next: null });
    expect(f.configure().ok).toBe(true);
    expect(readFileSync(file)).toEqual(original);
    expect(new OutcomeStore(f.store.directory).read()).toMatchObject({ sourceState: 'healthy', state: { schemaVersion: 2, manager: { mode: 'resident' } } });
    expect(f.store.read().records.map(record => record.schemaVersion)).toEqual([1, 2]);
    expect(f.work.project().complete).toBe(false);
  });
  it.each(['authority', 'session', 'route', 'workspace'] as const)('refuses unsupported %s without an execution record', kind => {
    const f = fixture();
    if (kind === 'session') expect(f.manager.configure(f.command(), { mode: 'interactive', sessionId: 'unknown' }, f.admission).ok).toBe(false);
    else {
      expect(f.configure().ok).toBe(true);
      if (kind === 'authority') f.revoke(); if (kind === 'route') f.revokeRoute();
      const repo = kind === 'workspace' ? join(f.root, 'elsewhere') : f.repo;
      if (kind === 'workspace') mkdirSync(repo);
      expect(f.manager.claimRun(f.command(), f.manager.project().next!, repo, f.route, 'run-manager', f.admission).ok).toBe(false);
    }
    expect(f.store.read().state!.manager?.stages ?? []).toEqual([]);
  });
  it('binds saved private interjections to exact session/event references without copying prompt text', () => {
    const f = fixture(); expect(f.configure(true).ok).toBe(true);
    const reference = { sessionId: 'chat-1', messageId: 'message-1', eventSeq: 3 };
    const command = f.command(); expect(f.manager.interject(command, reference, f.admission).ok).toBe(true);
    expect(f.manager.interject(command, reference, f.admission)).toMatchObject({ ok: true, disposition: 'replayed' });
    expect(f.store.read().state!.manager!.interjections).toEqual([{ ...reference, revision: 1 }]);
    expect(f.manager.interject(f.command(), { ...reference, sessionId: 'other' }, f.admission).ok).toBe(false);
    expect(f.manager.interject(f.command(), { ...reference, messageId: 'message-2', eventSeq: 2 }, f.admission).ok).toBe(false);
    expect(f.manager.interject(f.command(), { ...reference, messageId: 'message-2', eventSeq: 4 }, { ...f.admission, messageExists: () => false }).ok).toBe(false);
  });
  it('records a real parent atomically, prevents duplicate claims and never replays a launch', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); const next = f.manager.project().next!; const command = f.command();
    const claimed = f.manager.claimRun(command, next, f.repo, f.route, 'run-manager', f.admission);
    expect(claimed).toMatchObject({ ok: true, disposition: 'recorded' });
    expect(f.manager.claimRun(command, next, f.repo, f.route, 'run-manager', f.admission)).toMatchObject({ ok: true, disposition: 'replayed' });
    expect(f.manager.project()).toMatchObject({ next: null, running: { runId: 'run-manager', providerRunIds: ['run-manager'] } });
    expect(f.manager.claimRun(f.command(), next, f.repo, f.route, 'another-run', f.admission).ok).toBe(false);
    expect(f.store.read().state!.manager!.stages).toHaveLength(1);
  });
  it('requires current route and scope before every candidate and rejects unregistered terminal runs', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); expect(f.claim().ok).toBe(true);
    expect(f.manager.registerProviderRun(f.command(), f.stage().id, 'candidate', f.admission).ok).toBe(true);
    expect(f.manager.finish('terminal-invented', { stageId: f.stage().id, runId: 'invented', state: 'succeeded',
      resultDigest: outcomeDigest('actual result'), proposalId: null, plan: f.plan() }, f.admission).ok).toBe(false);
    f.revokeRoute(); expect(f.manager.inspectStage(f.stage().id, f.admission).admitted).toBe(false);
    expect(f.manager.registerProviderRun(f.command(), f.stage().id, 'late', f.admission).ok).toBe(false);
    expect(f.stage().providerRunIds).toEqual(['run-manager', 'candidate']);
  });
  it('applies a valid manager plan atomically without claiming its work is complete', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); expect(f.claim().ok).toBe(true);
    expect(f.manager.finish('terminal-plan', { stageId: f.stage().id, runId: 'run-manager', state: 'succeeded',
      resultDigest: outcomeDigest('actual result'), proposalId: null, plan: f.plan() }, f.admission).ok).toBe(true);
    expect(f.stage()).toMatchObject({ state: 'succeeded', resultKind: 'plan-applied', appliedPlanRevision: 1 });
    expect(f.store.read().state!.activeNodeIds).toHaveLength(1);
    expect(f.work.project().complete).toBe(false);
    expect(Object.values(f.store.read().state!.nodes).every(node => node.completion === null && node.attempts.length === 0)).toBe(true);
    expect(f.manager.project().next).toBeNull();
  });
  it('holds model-authored risk outside the live policy and keeps original plan untouched', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); expect(f.claim().ok).toBe(true);
    expect(f.manager.finish('terminal-risk', { stageId: f.stage().id, runId: 'run-manager', state: 'succeeded',
      resultDigest: outcomeDigest('actual result'), proposalId: null, plan: f.plan() }, { ...f.admission, planAllowed: () => false }).ok).toBe(true);
    expect(f.store.read().state!.graphDigest).toBeNull(); expect(f.stage()).toMatchObject({ state: 'failed', failureReason: 'plan-refused' });
    expect(f.manager.project().next?.intent).toBe('plan');
  });
  it('rechecks authority at final publication, then truthfully retires the unpublishable result', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); expect(f.claim().ok).toBe(true);
    const admission = { ...f.admission, planAllowed: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) };
    const terminal = { stageId: f.stage().id, runId: 'run-manager', state: 'succeeded' as const,
      resultDigest: outcomeDigest('actual result'), proposalId: null, plan: f.plan() };
    expect(f.manager.finish('terminal-plan', terminal, admission).ok).toBe(false);
    expect(f.store.read().state!.graphDigest).toBeNull(); expect(f.stage().state).toBe('running');
    f.revoke(); expect(f.manager.finish('terminal-plan', terminal, f.admission).ok).toBe(true);
    expect(f.stage().state).toBe('stale'); expect(f.store.read().state!.graphDigest).toBeNull();
  });
  it('retains a stale actual terminal after a saved scope edit without applying its old graph', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); expect(f.claim().ok).toBe(true); const id = f.stage().id;
    expect(f.work.editScope(f.command(), { ...f.scope, acceptance: ['Changed acceptance'] }).ok).toBe(true);
    expect(f.manager.inspectStage(id, f.admission).admitted).toBe(false);
    expect(f.manager.finish('terminal-stale', { stageId: id, runId: 'run-manager', state: 'succeeded',
      resultDigest: outcomeDigest('actual result'), proposalId: null, plan: f.plan() }, f.admission).ok).toBe(true);
    expect(f.stage().state).toBe('stale'); expect(f.store.read().state!.graphDigest).toBeNull();
    expect(f.manager.project().next?.intent).toBe('plan');
  });
  it('uses actual manager failure history to derive a fresh corrective candidate without a fixed retry ceiling', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); const original = f.manager.project().next!.workItemId;
    expect(f.claim().ok).toBe(true);
    expect(f.manager.finish('terminal-failed', { stageId: f.stage().id, runId: 'run-manager', state: 'failed',
      resultDigest: null, proposalId: null }, f.admission).ok).toBe(true);
    expect(f.manager.project().next!.workItemId).not.toBe(original);
    expect(f.claim('corrective-run').ok).toBe(true); expect(f.store.read().state!.manager!.stages).toHaveLength(2);
  });
  it('schedules a fresh same-scope item after a proven stale native binding terminal', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); const original = f.manager.project().next!.workItemId;
    expect(f.claim().ok).toBe(true); f.revokeRoute();
    expect(f.manager.finish('terminal-revoked', { stageId: f.stage().id, runId: 'run-manager', state: 'succeeded',
      resultDigest: outcomeDigest('actual result'), proposalId: null, plan: f.plan() }, f.admission).ok).toBe(true);
    expect(f.stage().state).toBe('stale'); expect(f.manager.project().next?.workItemId).not.toBe(original);
  });
  it('keeps a failed manager refinement schedulable when a work graph already exists', () => {
    const f = fixture(); expect(f.configure().ok).toBe(true); expect(f.claim().ok).toBe(true);
    expect(f.manager.finish('terminal-invalid', { stageId: f.stage().id, runId: 'run-manager', state: 'failed',
      resultDigest: outcomeDigest('actual invalid output'), proposalId: null, failureReason: 'invalid-result' }, f.admission).ok).toBe(true);
    // Pure projection fixture: an existing graph and failed replan at its current plan revision.
    const state = refineOutcomeState(f.store.read().state!, f.plan())!;
    const stage = state.manager!.stages[0]!; state.manager!.stages = [];
    stage.intent = 'replan'; stage.basis = outcomeManagerBasis(state); stage.basisDigest = outcomeDigest(stage.basis);
    stage.workItemId = managerWorkItemId(state.id, stage.basisDigest); state.manager!.stages = [stage];
    expect(projectOutcomeManager(state).next?.intent).toBe('replan');
    expect(state.nodes[state.activeNodeIds[0]!]!.attempts).toEqual([]);
  });
  it('does not admit unvalidated manager metadata in v1 or malformed v2 records', () => {
    const f = fixture();
    expect(f.store.transact('forged-v1', f.store.read().state!.revision, {}, current => ({ ...current!, manager: {} as never })).ok).toBe(false);
    expect(f.store.transact('forged-v2', f.store.read().state!.revision, {}, current => ({ ...current!, schemaVersion: 2, manager: {} as never })).ok).toBe(false);
    expect(f.store.read().records).toHaveLength(1);
  });
});

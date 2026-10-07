import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ directory: vi.fn(), run: vi.fn(), proposal: vi.fn(), enrollment: vi.fn() }));
vi.mock('../src/core/goals/outcome-runtime.js', () => ({ outcomeDirectory: mocks.directory }));
vi.mock('../src/core/run/orchestrator.js', () => ({ loadRun: mocks.run }));
vi.mock('../src/core/inbox/store.js', () => ({ loadProposal: mocks.proposal }));
vi.mock('../src/core/sandbox/policy.js', () => ({ readEnrollmentRegistry: mocks.enrollment }));
import { OutcomeManagerDispatch, outcomeManagerWorkItems, readOutcomeManagerWorkItemContext,
  readOutcomeManagerResult, reconcileOutcomeManagerTerminals, readOutcomeManagerSessionProjection, readOutcomeManagerSession, isOutcomeManagerWorkItem } from '../src/core/daemon/outcome-manager.js';
import { OutcomeManagerCoordinator, type OutcomeManagerAdmission } from '../src/core/goals/outcome-manager.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import type { RunState } from '../src/core/types.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); mocks.directory.mockReset(); mocks.run.mockReset(); mocks.proposal.mockReset(); mocks.enrollment.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(interactive = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-manager-dispatch-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const home = join(root, '.ashlr'); const directory = join(home, 'outcomes');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Match the existing private parent, not a production HOME or provider state.
  mocks.directory.mockImplementation(id => join(directory, id));
  mocks.enrollment.mockReturnValue({ state: 'ready', repos: [repo] });
  const store = new OutcomeStore(join(directory, 'outcome')); const work = new OutcomeCoordinator(store);
  const manager = new OutcomeManagerCoordinator(store); let sequence = 0; let authorized = true;
  const command = () => ({ commandId: `command-${++sequence}`, expectedRevision: store.read().state?.revision ?? 0 });
  const admission: OutcomeManagerAdmission = { stillAuthorized: () => authorized, executionRepoAllowed: (a, b) => a === b,
    routeAllowed: route => route.seatId === 'selected-native-seat' && route.tier === 'frontier',
    routeCurrent: route => route.seatId === 'selected-native-seat' && route.tier === 'frontier',
    sessionAllowed: id => id === 'chat-1', messageExists: () => true, planAllowed: () => true };
  expect(work.start(command(), 'outcome', { desiredOutcome: 'Ship a useful verified improvement', targetRepos: [repo],
    acceptance: ['Actual protected merge and regression verification'] }).ok).toBe(true);
  expect(manager.configure(command(), { mode: interactive ? 'interactive' : 'resident', sessionId: interactive ? 'chat-1' : null }, admission).ok).toBe(true);
  if (interactive) expect(manager.interject(command(), { sessionId: 'chat-1', messageId: 'message-1', eventSeq: 1 }, admission).ok).toBe(true);
  const state = () => store.read().state!;
  const item = outcomeManagerWorkItems([state()], '2026-10-07T00:00:00Z')[0]!;
  const context = readOutcomeManagerWorkItemContext(item)!; expect(context).not.toBeNull();
  const route = { engine: 'codex', seatId: 'selected-native-seat', model: 'actual-frontier-model', tier: 'frontier' as const };
  const planText = `<phantom-manager-result>${JSON.stringify({ kind: 'plan', title: 'Useful plan', nodes: [{ key: 'build', title: 'Build improvement',
    objective: 'Implement useful behavior', deliverable: 'Verified proposal', riskClass: 'low', targetRepo: 'target-1', dependsOn: [],
    acceptance: ['Meaningful tests pass'] }] })}</phantom-manager-result>`;
  let run = { id: 'run-parent', engine: route.engine, engineModel: `${route.engine}:${route.model}`, engineTier: 'frontier',
    trajectoryId: 'run:run-parent', status: 'done', result: planText, proposalOutcome: { kind: 'empty-diff' } } as RunState;
  mocks.run.mockImplementation(id => id === run.id ? run : null);
  const onResult = vi.fn();
  const dispatch = (id = 'run-parent') => { const d = new OutcomeManagerDispatch(context, item, id, admission,
    { conversation: () => 'Actual persisted private message', onResult }); d.bindRoute(route); return d; };
  return { root, repo, directory, store, work, manager, admission, command, state, item, route, planText, dispatch, onResult,
    setRun: (value: RunState) => { run = value; }, run: () => run, revoke: () => { authorized = false; } };
}
describe('actual tool-capable manager host bridge', () => {
  it('discovers exact saved scope and builds tool-capable full-acceptance prompts without launching', () => {
    const f = fixture(); expect(isOutcomeManagerWorkItem(f.item)).toBe(true);
    expect(isOutcomeManagerWorkItem({ id: 'outcome-manager:malformed', tags: [] })).toBe(true);
    expect(readOutcomeManagerWorkItemContext({ ...f.item, id: 'outcome-manager:malformed' })).toBeNull();
    expect(readOutcomeManagerWorkItemContext({ ...f.item, repo: join(f.root, 'other') })).toBeNull();
    const prompt = f.dispatch().prompt(); expect(prompt).toContain('Use native tools');
    expect(prompt).toContain(f.state().scope.acceptance[0]); expect(prompt).toContain('normal captured proposals');
    expect(f.state().manager!.stages).toEqual([]);
  });
  it('records only one parent and refuses replayed or wrong-seat launches', () => {
    const f = fixture(); const first = f.dispatch(); expect(first.begin()).toBe(true);
    expect(f.dispatch().begin()).toBe(false); expect(f.dispatch('other').begin()).toBe(false);
    expect(f.state().manager!.stages).toHaveLength(1);
    const other = fixture(); const wrong = other.dispatch(); wrong.bindRoute({ ...other.route, seatId: 'wrong-account' });
    expect(wrong.begin()).toBe(false); expect(other.state().manager!.stages).toEqual([]);
  });
  it('holds revoked provider registration and never adds an unadmitted candidate', () => {
    const f = fixture(); const d = f.dispatch(); expect(d.begin()).toBe(true); f.revoke();
    expect(d.stillAuthorized()).toBe(false); expect(d.registerProviderRun('late')).toBe(false);
    expect(f.state().manager!.stages[0]!.providerRunIds).toEqual(['run-parent']);
  });
  it('joins actual registered successful output and no-diff capture to a plan, never work completion', async () => {
    const f = fixture(true); const d = f.dispatch(); expect(d.begin()).toBe(true);
    expect(await d.finishWithRetry({ outcome: 'empty-diff', runId: 'run-parent' } as never)).toBe(true);
    const stage = f.state().manager!.stages[0]!; expect(stage).toMatchObject({ state: 'succeeded', resultKind: 'plan-applied', proposalId: null });
    expect(f.work.project().complete).toBe(false); expect(f.onResult).toHaveBeenCalledWith({ outcomeId: 'outcome', stageId: stage.id, sessionId: 'chat-1' });
    expect(readOutcomeManagerResult({ outcomeId: 'outcome', stageId: stage.id, sessionId: 'chat-1' })).toMatchObject({
      text: f.planText, seatId: 'selected-native-seat', engine: 'codex', model: 'actual-frontier-model',
      resultDigest: createHash('sha256').update(f.planText).digest('hex') });
    expect(readOutcomeManagerResult({ outcomeId: 'outcome', stageId: stage.id, sessionId: 'other' })).toBeNull();
    expect(readOutcomeManagerSessionProjection('chat-1', [f.repo])).toMatchObject({ sourceState: 'healthy', association: {
      outcomeId: 'outcome', terminalStageIds: [stage.id] } });
    expect(f.work.setPaused(f.command(), true).ok).toBe(true);
    expect(readOutcomeManagerSession({ outcomeId: 'outcome', sessionId: 'chat-1', roots: [f.repo] })).toBe(false);
    expect(readOutcomeManagerSessionProjection('chat-1', [f.repo])).toMatchObject({ sourceState: 'healthy' });
    f.setRun({ ...f.run(), result: `${f.planText} changed` });
    expect(readOutcomeManagerResult({ outcomeId: 'outcome', stageId: stage.id, sessionId: 'chat-1' })).toBeNull();
  });
  it.each(['engine', 'engineModel', 'engineTier', 'trajectoryId', 'proposalOutcome'] as const)(
    'refuses successful synthesis with mismatched actual %s evidence', async field => {
      const f = fixture(true); const d = f.dispatch(); expect(d.begin()).toBe(true);
      f.setRun({ ...f.run(), [field]: field === 'proposalOutcome' ? undefined : 'different' });
      expect(await d.finishWithRetry()).toBe(true); expect(f.state().manager!.stages[0]!.state).toBe('failed');
      expect(f.state().graphDigest).toBeNull(); expect(f.onResult).not.toHaveBeenCalled();
    });
  it('refuses invented terminal runs and output JSON cannot invent an absolute target or human gate', async () => {
    const f = fixture(); const d = f.dispatch(); expect(d.begin()).toBe(true);
    expect(await d.finishWithRetry({ outcome: 'failed', runId: 'unregistered' })).toBe(false);
    f.setRun({ ...f.run(), result: f.planText.replace('target-1', '/invented/path') });
    expect(await d.finishWithRetry()).toBe(true); expect(f.state().graphDigest).toBeNull();
  });
  it('retains an obsolete actual result without applying a stale graph', async () => {
    const f = fixture(); const d = f.dispatch(); expect(d.begin()).toBe(true);
    expect(f.work.editScope(f.command(), { ...f.state().scope, acceptance: ['Changed acceptance'] }).ok).toBe(true);
    expect(await d.finishWithRetry()).toBe(true); expect(f.state().manager!.stages[0]!.state).toBe('stale');
    expect(f.state().graphDigest).toBeNull();
  });
  it('retains actual revoked cancellation without applying a graph', async () => {
    const cancelled = fixture(); const c = cancelled.dispatch(); expect(c.begin()).toBe(true); cancelled.revoke();
    expect(await c.finishWithRetry(undefined, true)).toBe(true); expect(cancelled.state().manager!.stages[0]!.state).toBe('aborted');
  });
  it('recovers a real terminal after restart without claiming/relaunching a provider', () => {
    const f = fixture(true); const d = f.dispatch(); expect(d.begin()).toBe(true);
    const before = f.state().manager!.stages[0]!.id;
    expect(reconcileOutcomeManagerTerminals(f.store, f.admission)).toBe(1);
    expect(f.state().manager!.stages).toHaveLength(1); expect(f.state().manager!.stages[0]!.id).toBe(before);
    expect(f.state().manager!.stages[0]!.state).toBe('succeeded');
    expect(reconcileOutcomeManagerTerminals(f.store, f.admission)).toBe(0);
    expect(f.work.project().complete).toBe(false);
  });
  it('does not hide a missing/running child behind a cancelled registered parent', () => {
    const f = fixture(); const d = f.dispatch(); expect(d.begin()).toBe(true); expect(d.registerProviderRun('child')).toBe(true);
    f.setRun({ ...f.run(), status: 'aborted' });
    expect(reconcileOutcomeManagerTerminals(f.store, f.admission)).toBe(0);
    mocks.run.mockImplementation(id => id === 'child' ? { ...f.run(), id, status: 'running' } : f.run());
    expect(reconcileOutcomeManagerTerminals(f.store, f.admission)).toBe(0);
    mocks.run.mockImplementation(id => id === 'child' ? { ...f.run(), id, status: 'failed' } : f.run());
    expect(reconcileOutcomeManagerTerminals(f.store, f.admission)).toBe(1);
    expect(f.state().manager!.stages[0]).toMatchObject({ state: 'aborted', terminalRunId: 'run-parent' });
  });
  it('does not require a new contact quota ticket to retain a valid completed plan', async () => {
    const f = fixture(); const d = f.dispatch(); expect(d.begin()).toBe(true);
    f.admission.routeAllowed = () => false; // The actual call used the last allowance in its window.
    expect(d.stillAuthorized()).toBe(false);
    expect(await d.finishWithRetry()).toBe(true);
    expect(f.state().manager!.stages[0]!.state).toBe('succeeded');
    expect(f.manager.project().next).toBeNull();
  });
  it('feeds an actual rejected result and persisted cause into the next corrective manager prompt', async () => {
    const f = fixture(); const d = f.dispatch(); expect(d.begin()).toBe(true);
    f.setRun({ ...f.run(), result: 'Actual malformed manager output' });
    expect(await d.finishWithRetry()).toBe(true);
    const item = outcomeManagerWorkItems([f.state()], '2026-10-07T00:00:01Z')[0]!;
    const context = readOutcomeManagerWorkItemContext(item)!;
    const next = new OutcomeManagerDispatch(context, item, 'corrective-run', f.admission);
    expect(next.prompt()).toContain('invalid-result'); expect(next.prompt()).toContain('Actual malformed manager output');
    f.setRun({ ...f.run(), result: 'Replaced bytes' });
    expect(next.prompt()).not.toContain('Replaced bytes'); expect(next.prompt()).toContain('unavailable');
  });
  it('keeps unknown/degraded and unlinked chat projection distinct without creating missing storage', () => {
    const f = fixture(true);
    expect(readOutcomeManagerSessionProjection('other', [f.repo])).toEqual({ sourceState: 'unlinked', association: null });
    expect(readOutcomeManagerSessionProjection('chat-1', [join(f.root, 'other')])).toEqual({ sourceState: 'degraded', association: null });
    rmSync(f.directory, { recursive: true, force: true });
    expect(readOutcomeManagerSessionProjection('chat-1', [f.repo])).toEqual({ sourceState: 'missing', association: null });
  });
});

import { mkdtempSync, mkdirSync, linkSync, lstatSync, realpathSync, rmSync, readFileSync, readdirSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { OutcomeCoordinator, type OutcomeTerminal } from '../src/core/goals/outcome-coordinator.js';
import { outcomeCanonical, outcomeDigest, outcomeGraphObjective, type OutcomeState, type OutcomeWrite } from '../src/core/goals/outcome-types.js';
import { ecosystemMissionGraphDigest, type MissionGraphInput, type MissionGraphNodeInput } from '../src/core/vision/mission-graph.js';
import { hashDiff, signLocalMergeIntent, signLocalRealizedMergeReceipt } from '../src/core/foundry/provenance.js';
import type { Proposal, ProposalLocalMergeIntent } from '../src/core/types.js';
import * as records from '../src/core/util/immutable-private-record-store.js';
import * as merges from '../src/core/inbox/realized-merge.js';
import * as completion from '../src/core/goals/completion.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function success(result: OutcomeWrite): OutcomeState {
  if (!result.ok) throw new Error(result.reason);
  expect(result.ok).toBe(true);
  return result.state;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-core-')));
  roots.push(root);
  const store = new OutcomeStore(join(root, 'outcome'));
  const coordinator = new OutcomeCoordinator(store);
  const scope = { desiredOutcome: 'Ship useful verified improvements', targetRepos: [join(root, 'repo')],
    acceptance: ['A verified change reaches the default branch'] };
  mkdirSync(scope.targetRepos[0]!);
  const inventory = { sourceState: 'healthy' as const, complete: true, repos: scope.targetRepos };
  const admission = { stillAuthorized: () => true, executionRepoAllowed: (target: string, execution: string) => target === execution };
  let sequence = 0;
  const command = () => ({ commandId: `command-${++sequence}`, expectedRevision: store.read().state?.revision ?? 0 });
  const work = (key: string, deps: string[] = []): MissionGraphNodeInput => ({ kind: 'work', key,
    title: `Build ${key}`, objective: `Implement ${key}`, deliverable: `Verified ${key}`, riskClass: 'low',
    targetRepo: scope.targetRepos[0], dependsOn: deps, acceptance: [`${key} passes meaningful tests`] });
  const plan = (nodes = [work('a'), work('b', ['a'])]): MissionGraphInput => ({ missionKey: 'outcome',
    title: 'Outcome plan', objective: scope.desiredOutcome, createdAt: '2026-10-02T00:00:00.000Z', nodes });
  const start = () => success(coordinator.start(command(), 'outcome', scope));
  const refine = (input = plan()) => success(coordinator.refinePlan(command(), input, inventory));
  const state = () => store.read().state!;
  const nodeId = (key: string) => state().activeNodeIds.find(id => state().nodes[id]!.basis.definition.key === key)!;
  const link = (key = 'a') => {
    const node = state().nodes[nodeId(key)]!;
    return success(coordinator.linkMaterialization(command(), node.id, node.materialization.goalId,
      node.materialization.milestoneId, { stillAuthorized: admission.stillAuthorized, matchesPersistedGoal: () => true }));
  };
  const claimed = () => {
    start(); refine(); link();
    const id = nodeId('a');
    success(coordinator.claimReady(command(), id, scope.targetRepos[0]!, admission));
    const attempt = state().nodes[id]!.attempts.at(-1)!;
    success(coordinator.joinRun(command(), id, attempt.id, 'run-1'));
    const terminal: OutcomeTerminal = { nodeId: id, attemptId: attempt.id, generationId: attempt.generationId,
      executionRepo: attempt.executionRepo, runId: 'run-1', proposalId: 'proposal-1', state: 'proposed' };
    return { id, attempt, terminal };
  };
  return { root, store, coordinator, scope, inventory, admission, command, work, plan, start, refine, state, nodeId, link, claimed };
}

describe('durable outcome core', () => {
  it('observes absent storage without creating anything or claiming completion', () => {
    const f = fixture(); expect(f.coordinator.project()).toMatchObject({ sourceState: 'missing', ready: [], complete: false });
    expect(readdirSync(f.root)).toEqual(['repo']);
  });
  it.each(['Uppercase', 'x'.repeat(81), '../escape'])('uses the same mission identity grammar for %s at start', id => {
    const f = fixture(); expect(f.coordinator.start(f.command(), id, f.scope).ok).toBe(false);
    expect(f.store.read().state).toBeNull();
  });
  it('records private intent once and replays the original command after restart and later edits', () => {
    const f = fixture(); const cmd = f.command(); const first = success(f.coordinator.start(cmd, 'outcome', f.scope));
    success(f.coordinator.setPaused(f.command(), true));
    const resumed = new OutcomeCoordinator(new OutcomeStore(f.store.directory));
    const replay = resumed.start(cmd, 'outcome', f.scope);
    expect(replay).toEqual({ ok: true, disposition: 'replayed', state: first });
    expect(resumed.project().paused).toBe(true);
    expect(f.store.read().records).toHaveLength(2);
    expect(resumed.start(cmd, 'outcome', { ...f.scope, desiredOutcome: 'Different' })).toEqual({ ok: false, reason: 'conflict' });
  });
  it('rejects two writers using the same expected revision without losing the winner', () => {
    const f = fixture(); f.start(); const rev = f.state().revision;
    success(f.coordinator.setPaused({ commandId: 'winner', expectedRevision: rev }, true));
    expect(new OutcomeCoordinator(new OutcomeStore(f.store.directory)).setPaused({ commandId: 'loser', expectedRevision: rev }, false))
      .toEqual({ ok: false, reason: 'conflict' });
    expect(f.state().paused).toBe(true);
  });
  it('records the resident claim and run in one revision while an overlapping writer cannot split them', () => {
    const f = fixture(); f.start(); f.refine(); f.link(); const id = f.nodeId('a'); const cmd = f.command();
    const recordsBefore = f.store.read().records.length;
    const admission = { ...f.admission, stillAuthorized: () => {
      // Both admission checks run under the same outer transaction lock.
      expect(f.coordinator.setPaused({ commandId: 'overlap', expectedRevision: cmd.expectedRevision }, true))
        .toEqual({ ok: false, reason: 'conflict' });
      return true;
    } };
    const result = f.coordinator.claimRunReady(cmd, id, f.scope.targetRepos[0]!, 'resident-run', admission);
    expect(result).toMatchObject({ ok: true, disposition: 'recorded' });
    const attempt = f.state().nodes[id]!.attempts[0]!;
    expect(attempt).toMatchObject({ id: outcomeDigest([id, cmd.commandId]), state: 'running', runId: 'resident-run',
      providerRunIds: ['resident-run'], terminalRunId: null, proposalId: null });
    expect(f.store.read().records).toHaveLength(recordsBefore + 1);
    success(f.coordinator.setPaused(f.command(), true));
    expect(f.state().nodes[id]!.attempts[0]?.runId).toBe('resident-run');
    expect(f.coordinator.inspectClaim(id, attempt.id, attempt.generationId, f.admission).admitted).toBe(false);
  });
  it('never leaves a partial claim when an unrelated writer wins the resident start CAS', () => {
    const f = fixture(); f.start(); f.refine(); f.link(); const id = f.nodeId('a'); const stale = f.command();
    success(f.coordinator.setPaused(f.command(), false));
    expect(f.coordinator.claimRunReady(stale, id, f.scope.targetRepos[0]!, 'resident-run', f.admission))
      .toEqual({ ok: false, reason: 'conflict' });
    expect(f.state().nodes[id]!.attempts).toEqual([]); expect(f.coordinator.project().ready).toContain(id);
    expect(f.coordinator.claimRunReady(f.command(), id, f.scope.targetRepos[0]!, 'resident-run', f.admission))
      .toMatchObject({ ok: true, disposition: 'recorded' });
  });
  it('replays an atomic resident start after restart without authorizing another producer', () => {
    const f = fixture(); f.start(); f.refine(); f.link(); const id = f.nodeId('a'); const cmd = f.command();
    const original = success(f.coordinator.claimRunReady(cmd, id, f.scope.targetRepos[0]!, 'resident-run', f.admission));
    success(f.coordinator.setPaused(f.command(), true));
    const resumed = new OutcomeCoordinator(new OutcomeStore(f.store.directory));
    expect(resumed.claimRunReady(cmd, id, f.scope.targetRepos[0]!, 'resident-run', { ...f.admission, stillAuthorized: () => false }))
      .toEqual({ ok: true, disposition: 'replayed', state: original });
    const attempt = original.nodes[id]!.attempts[0]!;
    expect(resumed.inspectClaim(id, attempt.id, attempt.generationId, f.admission).admitted).toBe(false);
    expect(resumed.claimRunReady(cmd, id, f.scope.targetRepos[0]!, 'another-run', f.admission))
      .toEqual({ ok: false, reason: 'conflict' });
    expect(f.state().nodes[id]!.attempts).toHaveLength(1);
  });
  it.each(['dependency', 'paused', 'duplicate', 'invalid-run', 'wrong-repo', 'revoked', 'revoked-at-publication'] as const)('holds atomic resident start for %s without a partial attempt', kind => {
      const f = fixture(); f.start(); f.refine(); f.link(); let id = f.nodeId('a');
      let repo = f.scope.targetRepos[0]!; let runId = 'resident-run'; let admission = f.admission;
      if (kind === 'dependency') { f.link('b'); id = f.nodeId('b'); }
      if (kind === 'paused') success(f.coordinator.setPaused(f.command(), true));
      if (kind === 'duplicate') success(f.coordinator.claimRunReady(f.command(), id, repo, runId, admission));
      if (kind === 'invalid-run') runId = '../escape';
      if (kind === 'wrong-repo') { repo = join(f.root, 'other'); mkdirSync(repo); }
      if (kind === 'revoked') admission = { ...admission, stillAuthorized: () => false };
      if (kind === 'revoked-at-publication') admission = { ...admission, stillAuthorized: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) };
      const before = f.store.read().records.length;
      expect(f.coordinator.claimRunReady(f.command(), id, repo, runId, admission).ok).toBe(false);
      expect(f.store.read().records).toHaveLength(before);
      expect(f.state().nodes[id]!.attempts).toHaveLength(kind === 'duplicate' ? 1 : 0);
    });
  it('holds an overlapping transaction and rechecks revoked authority before publication', () => {
    const f = fixture(); f.start(); const cmd = f.command(); let authorized = true;
    const result = f.store.transact(cmd.commandId, cmd.expectedRevision, { race: true }, current => {
      expect(f.coordinator.setPaused(f.command(), true)).toEqual({ ok: false, reason: 'conflict' });
      authorized = false;
      return current ? { ...current, paused: true } : null;
    }, () => authorized);
    expect(result).toEqual({ ok: false, reason: 'held' }); expect(f.state().paused).toBe(false);
  });
  it('recovers an already published result even if the writer reports an uncertain failure', () => {
    const f = fixture(); const actual = records.writeImmutablePrivateRecord;
    vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((...args) => { actual(...args); return 'failed'; });
    expect(f.coordinator.start(f.command(), 'outcome', f.scope)).toMatchObject({ ok: true, disposition: 'replayed' });
    expect(f.store.read().records).toHaveLength(1);
  });
  it('holds corrupted, incomplete and unsafe sources instead of projecting ready work', () => {
    const f = fixture(); f.start(); f.refine(); const directory = join(f.store.directory, 'ledger', 'records');
    writeFileSync(join(directory, 'unknown.json'), '{}', { mode: 0o600 });
    expect(f.coordinator.project()).toMatchObject({ sourceState: 'degraded', ready: [], complete: false });
    expect(f.coordinator.setPaused(f.command(), true)).toEqual({ ok: false, reason: 'unknown-source' });
  });
  it('does not follow an outcome directory symlink', () => {
    const f = fixture(); symlinkSync(f.root, f.store.directory);
    expect(f.coordinator.project().sourceState).toBe('degraded');
    expect(f.coordinator.start(f.command(), 'outcome', f.scope).ok).toBe(false);
  });
  it('persists materialization intent before any goal exists and exposes it after a restart', () => {
    const f = fixture(); f.start(); f.refine();
    const fresh = new OutcomeCoordinator(new OutcomeStore(f.store.directory));
    expect(fresh.project().materializationIntents).toHaveLength(2); expect(fresh.project().ready).toEqual([]);
    const id = f.nodeId('a'); const node = f.state().nodes[id]!;
    expect(node.materialization).toMatchObject({ state: 'intent', goalId: `outcome-${id}` });
    expect(f.coordinator.linkMaterialization(f.command(), id, 'wrong', node.materialization.milestoneId, { stillAuthorized: () => true, matchesPersistedGoal: () => true }).ok).toBe(false);
    expect(f.coordinator.linkMaterialization(f.command(), id, node.materialization.goalId, node.materialization.milestoneId,
      { stillAuthorized: () => true, matchesPersistedGoal: () => false }).ok).toBe(false);
    f.link(); expect(fresh.project().ready).toEqual([id]);
  });
  it.each(['missing', 'degraded', 'incomplete', 'unenrolled'])('rejects %s repository inventory', kind => {
    const f = fixture(); f.start(); const inventory = { ...f.inventory };
    if (kind === 'missing' || kind === 'degraded') inventory.sourceState = kind as 'healthy';
    else if (kind === 'incomplete') inventory.complete = false;
    else inventory.repos = [];
    expect(f.coordinator.refinePlan(f.command(), f.plan(), inventory).ok).toBe(false);
    expect(f.state().planRevision).toBe(0);
  });
  it.each(['scope', 'repo', 'cycle', 'oversize'])('refuses a %s violating plan without altering authorized scope', kind => {
    const f = fixture(); f.start(); const plan = f.plan();
    if (kind === 'scope') plan.objective = 'Different objective';
    else if (kind === 'repo') plan.nodes[0]!.targetRepo = '/outside';
    else if (kind === 'cycle') plan.nodes[0]!.dependsOn = ['b'];
    else plan.nodes = Array.from({ length: 25 }, (_, index) => f.work(`node-${index}`));
    expect(f.coordinator.refinePlan(f.command(), plan, f.inventory).ok).toBe(false);
    expect(f.state().scope).toEqual(f.scope); expect(f.state().planRevision).toBe(0);
  });
  it.each([4000, 5000, 20000])('preserves full %s character desired scope across graph compilation and restart', length => {
    const f = fixture(); const desiredOutcome = 'x'.repeat(length - 4) + 'TAIL';
    success(f.coordinator.start(f.command(), 'outcome', { ...f.scope, desiredOutcome }));
    const input = { ...f.plan(), objective: desiredOutcome }; success(f.coordinator.refinePlan(f.command(), input, f.inventory));
    const restarted = new OutcomeStore(f.store.directory).read(); expect(restarted.sourceState).toBe('healthy');
    const state = restarted.state!; expect(state.scope.desiredOutcome).toBe(desiredOutcome);
    expect(state.graph!.objective).toBe(outcomeGraphObjective(state));
    if (length === 4000) expect(state.graph!.objective).toBe(desiredOutcome);
    else { expect(state.graph!.objective.length).toBeLessThan(4000); expect(state.graph!.objective).toContain(state.scopeDigest); }
    expect(input.objective).toBe(desiredOutcome); // Never mutate the caller's input into a summary/reference.
    expect(f.coordinator.refinePlan(f.command(), { ...input, objective: desiredOutcome.slice(0, 3999) }, f.inventory).ok).toBe(false);
    expect(f.coordinator.refinePlan(f.command(), { ...input, objective: state.graph!.objective + 'foreign' }, f.inventory).ok).toBe(false);
  });
  it('preserves full Unicode scope while matching the existing NFC inline wire objective', () => {
    const f = fixture(); const desiredOutcome = 'Cafe\u0301'; success(f.coordinator.start(f.command(), 'outcome', { ...f.scope, desiredOutcome }));
    success(f.coordinator.refinePlan(f.command(), { ...f.plan(), objective: desiredOutcome }, f.inventory));
    expect(f.state().scope.desiredOutcome).toBe(desiredOutcome); expect(f.state().graph!.objective).toBe('Café');
    expect(f.store.read().sourceState).toBe('healthy');
  });
  it('binds long scope suffix edits and rejects a graph reference for another immutable scope', () => {
    const f = fixture(); const desiredOutcome = 'x'.repeat(20000) + 'old';
    success(f.coordinator.start(f.command(), 'outcome', { ...f.scope, desiredOutcome }));
    success(f.coordinator.refinePlan(f.command(), { ...f.plan(), objective: desiredOutcome }, f.inventory));
    const oldId = f.nodeId('a'); const oldReference = f.state().graph!.objective;
    const edited = desiredOutcome.slice(0, -3) + 'new'; success(f.coordinator.editScope(f.command(), { ...f.scope, desiredOutcome: edited }));
    success(f.coordinator.refinePlan(f.command(), { ...f.plan(), objective: edited }, f.inventory));
    expect(f.nodeId('a')).not.toBe(oldId); expect(f.state().graph!.objective).not.toBe(oldReference);
    expect(f.state().nodes[oldId]!.basis.scopeDigest).not.toBe(f.state().scopeDigest);
    const cmd = f.command(); const result = f.store.transact(cmd.commandId, cmd.expectedRevision, { staleReference: true }, current => {
      current!.graph!.objective = oldReference;
      current!.graph!.graphDigest = ecosystemMissionGraphDigest(current!.graph!); current!.graphDigest = current!.graph!.graphDigest;
      return current;
    });
    expect(result.ok).toBe(false); expect(f.store.read().sourceState).toBe('healthy');
    expect(f.state().scope.desiredOutcome).toBe(edited);
  });
  it('preserves node basis and materialization through unrelated automatic graph refinement', () => {
    const f = fixture(); f.start(); f.refine(); f.link(); const old = f.state().nodes[f.nodeId('a')]!;
    f.refine(f.plan([f.work('a'), f.work('b', ['a']), f.work('c')]));
    expect(f.state().planRevision).toBe(2); expect(f.state().nodes[f.nodeId('a')]).toEqual(old);
    expect(f.coordinator.project().ready).toEqual([old.id]);
  });
  it('creates a new immutable identity for changed acceptance and its descendants', () => {
    const f = fixture(); f.start(); f.refine(); const oldA = f.nodeId('a'); const oldB = f.nodeId('b');
    const a = f.work('a'); a.acceptance = ['A stronger acceptance criterion']; f.refine(f.plan([a, f.work('b', ['a'])]));
    expect(f.nodeId('a')).not.toBe(oldA); expect(f.nodeId('b')).not.toBe(oldB);
    expect(f.state().nodes[oldA]).toBeDefined(); expect(f.state().nodes[oldB]).toBeDefined();
  });
  it('retires old active nodes on an operator scope edit without deleting their history', () => {
    const f = fixture(); const { terminal } = f.claimed(); const oldId = f.nodeId('a');
    success(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['New acceptance'] }));
    expect(f.state().scopeRevision).toBe(2); expect(f.state().activeNodeIds).toEqual([]);
    expect(f.state().nodes[oldId]).toBeDefined();
    success(f.coordinator.joinTerminal(f.command(), terminal));
    expect(f.state().nodes[oldId]!.attempts.at(-1)).toMatchObject({ state: 'proposed', terminalRunId: terminal.runId });
    expect(f.state().nodes[oldId]!.completion).toBeNull();
    f.refine(); expect(f.nodeId('a')).not.toBe(oldId);
  });
  it('registers exact BON candidates idempotently and retains the selected winner through restart', () => {
    const f = fixture(); const { id, attempt, terminal } = f.claimed();
    expect(f.state().nodes[id]!.attempts[0]!.providerRunIds).toEqual(['run-1']);
    expect(f.coordinator.inspectProviderRun(id, attempt.id, attempt.generationId, 'candidate-1', f.admission).admitted).toBe(false);
    const cmd = f.command();
    success(f.coordinator.registerProviderRun(cmd, id, attempt.id, attempt.generationId, 'candidate-1', f.admission));
    expect(f.coordinator.registerProviderRun(cmd, id, attempt.id, attempt.generationId, 'candidate-1', f.admission))
      .toMatchObject({ ok: true, disposition: 'replayed' });
    success(f.coordinator.registerProviderRun(f.command(), id, attempt.id, attempt.generationId, 'candidate-1', f.admission));
    success(f.coordinator.registerProviderRun(f.command(), id, attempt.id, attempt.generationId, 'candidate-2', f.admission));
    expect(f.state().nodes[id]!.attempts[0]!.providerRunIds).toEqual(['run-1', 'candidate-1', 'candidate-2']);
    expect(f.coordinator.inspectProviderRun(id, attempt.id, attempt.generationId, 'candidate-1', f.admission).admitted).toBe(true);
    const winner = { ...terminal, runId: 'candidate-1' };
    success(f.coordinator.joinTerminal(f.command(), winner));
    const restarted = new OutcomeCoordinator(new OutcomeStore(f.store.directory));
    expect(restarted.store.read().state!.nodes[id]!.attempts[0]).toMatchObject({ runId: 'run-1', terminalRunId: 'candidate-1' });
    vi.spyOn(completion, 'proposalCompletesGoalMilestone').mockReturnValue(true);
    vi.spyOn(merges, 'canonicalRealizedMergeIdentity').mockReturnValue({ source: 'local-default-branch', repo: attempt.executionRepo,
      base: 'master', mergeCommitOid: 'a'.repeat(40), key: 'authenticated-test-identity' });
    const proposal = { id: terminal.proposalId, repo: attempt.executionRepo, runId: 'candidate-1', trajectoryId: 'run:candidate-1',
      workItemId: attempt.workItemId, workItemGenerationId: attempt.generationId, producerStatus: 'done' } as Proposal;
    // Even a different registered candidate cannot replace the durable selected association.
    expect(restarted.joinCompletion(f.command(), { ...winner, runId: 'candidate-2' },
      { ...proposal, runId: 'candidate-2', trajectoryId: 'run:candidate-2' }).ok).toBe(false);
    expect(restarted.joinCompletion(f.command(), winner, { ...proposal, runId: 'run-1', trajectoryId: 'run:run-1' }).ok).toBe(false);
    success(restarted.joinCompletion(f.command(), winner, proposal));
    f.link('b'); expect(f.coordinator.project().ready).toEqual([f.nodeId('b')]);
  });
  it.each(['revoked', 'paused', 'retired', 'generation', 'execution'])('holds %s candidate registration and final admission', condition => {
    const f = fixture(); const { id, attempt } = f.claimed(); let admission = f.admission; let generation = attempt.generationId;
    if (condition === 'revoked') admission = { ...admission, stillAuthorized: () => false };
    else if (condition === 'paused') success(f.coordinator.setPaused(f.command(), true));
    else if (condition === 'retired') success(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['New scope'] }));
    else if (condition === 'generation') generation = `outcome:v1:${'0'.repeat(64)}`;
    else admission = { ...admission, executionRepoAllowed: () => false };
    expect(f.coordinator.registerProviderRun(f.command(), id, attempt.id, generation, 'candidate', admission).ok).toBe(false);
    expect(f.coordinator.inspectProviderRun(id, attempt.id, generation, 'run-1', admission).admitted).toBe(false);
    expect(f.state().nodes[id]!.attempts[0]!.providerRunIds).toEqual(['run-1']);
  });
  it('does not treat replayed registration as current provider permission', () => {
    const f = fixture(); const { id, attempt } = f.claimed(); const cmd = f.command();
    success(f.coordinator.registerProviderRun(cmd, id, attempt.id, attempt.generationId, 'candidate', f.admission));
    const revoked = { ...f.admission, stillAuthorized: () => false };
    expect(f.coordinator.registerProviderRun(cmd, id, attempt.id, attempt.generationId, 'candidate', revoked))
      .toMatchObject({ ok: true, disposition: 'replayed' });
    expect(f.coordinator.inspectProviderRun(id, attempt.id, attempt.generationId, 'candidate', revoked).admitted).toBe(false);
  });
  it.each(['scope', 'plan'])('records a retired %s terminal without completing it or releasing current dependencies', retirement => {
    const f = fixture(); const { id, attempt, terminal } = f.claimed();
    if (retirement === 'scope') {
      success(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['Changed acceptance'] })); f.refine();
    } else {
      const changed = f.work('a'); changed.acceptance = ['Changed task acceptance']; f.refine(f.plan([changed, f.work('b', ['a'])]));
    }
    success(f.coordinator.joinTerminal(f.command(), terminal));
    expect(f.state().nodes[id]!.attempts[0]).toMatchObject({ state: 'proposed', terminalRunId: 'run-1' });
    const proposal = { id: terminal.proposalId, repo: attempt.executionRepo, runId: terminal.runId, trajectoryId: `run:${terminal.runId}`,
      workItemId: attempt.workItemId, workItemGenerationId: attempt.generationId, producerStatus: 'done' } as Proposal;
    vi.spyOn(completion, 'proposalCompletesGoalMilestone').mockReturnValue(true);
    vi.spyOn(merges, 'canonicalRealizedMergeIdentity').mockReturnValue({ source: 'local-default-branch', repo: attempt.executionRepo,
      base: 'master', mergeCommitOid: 'a'.repeat(40), key: 'authenticated-test-identity' });
    expect(f.coordinator.joinCompletion(f.command(), terminal, proposal).ok).toBe(false);
    expect(f.state().nodes[id]!.completion).toBeNull();
    f.link('b'); expect(f.coordinator.project().ready).not.toContain(f.nodeId('b'));
  });
  it.each(['duplicate', 'foreign-terminal', 'missing-parent', 'missing-fields'])('rejects invalid %s provider lineage before publication', invalid => {
    const f = fixture(); const { id } = f.claimed(); const cmd = f.command();
    const result = f.store.transact(cmd.commandId, cmd.expectedRevision, { invalid }, current => {
      const attempt = current!.nodes[id]!.attempts[0]!;
      if (invalid === 'duplicate') attempt.providerRunIds.push('run-1');
      else if (invalid === 'foreign-terminal') attempt.terminalRunId = 'unregistered';
      else if (invalid === 'missing-parent') attempt.providerRunIds = [];
      else delete (attempt as Partial<typeof attempt>).providerRunIds;
      return current;
    });
    expect(result.ok).toBe(false); expect(f.store.read().sourceState).toBe('healthy');
    expect(f.state().nodes[id]!.attempts[0]!.providerRunIds).toEqual(['run-1']);
  });
  it('holds dependency work, duplicate claims, paused work and revoked authority', () => {
    const f = fixture(); f.start(); f.refine(); f.link('a'); f.link('b');
    const id = f.nodeId('a'); expect(f.coordinator.claimReady(f.command(), f.nodeId('b'), f.scope.targetRepos[0]!, f.admission).ok).toBe(false);
    expect(f.coordinator.claimReady(f.command(), id, f.scope.targetRepos[0]!, { ...f.admission, stillAuthorized: () => false }).ok).toBe(false);
    success(f.coordinator.setPaused(f.command(), true)); expect(f.coordinator.project().ready).toEqual([]);
    expect(f.coordinator.claimReady(f.command(), id, f.scope.targetRepos[0]!, f.admission).ok).toBe(false);
    success(f.coordinator.setPaused(f.command(), false)); success(f.coordinator.claimReady(f.command(), id, f.scope.targetRepos[0]!, f.admission));
    expect(f.coordinator.claimReady(f.command(), id, f.scope.targetRepos[0]!, f.admission).ok).toBe(false);
    expect(f.state().nodes[id]!.attempts[0]!.generationId).toMatch(/^outcome:v1:[a-f0-9]{64}$/);
  });
  it('does not treat asynchronous/truthy host callbacks as synchronous authorization', () => {
    const f = fixture(); f.start(); f.refine(); f.link(); const id = f.nodeId('a');
    expect(f.coordinator.claimReady(f.command(), id, f.scope.targetRepos[0]!, { ...f.admission,
      stillAuthorized: (() => Promise.resolve(true)) as unknown as () => boolean }).ok).toBe(false);
    expect(f.coordinator.claimReady(f.command(), id, f.scope.targetRepos[0]!, { ...f.admission,
      executionRepoAllowed: (() => Promise.resolve(true)) as unknown as (a: string, b: string) => boolean }).ok).toBe(false);
  });
  it('binds an explicitly admitted mirror exactly and never authorizes fuzzy basename matching', () => {
    const f = fixture(); f.start(); f.refine(); f.link(); const id = f.nodeId('a'); const mirror = join(f.root, 'mirror'); mkdirSync(mirror);
    expect(f.coordinator.claimReady(f.command(), id, mirror, f.admission).ok).toBe(false);
    success(f.coordinator.claimReady(f.command(), id, mirror, { ...f.admission,
      executionRepoAllowed: (target, execution) => target === f.scope.targetRepos[0] && execution === mirror }));
    expect(f.state().nodes[id]!.attempts[0]!.executionRepo).toBe(mirror);
  });
  it.each(['attemptId', 'generationId', 'executionRepo', 'runId'])('rejects a foreign %s terminal join', field => {
    const f = fixture(); const { terminal } = f.claimed();
    expect(f.coordinator.joinTerminal(f.command(), { ...terminal, [field]: 'foreign' }).ok).toBe(false);
    expect(f.state().nodes[terminal.nodeId]!.attempts.at(-1)!.state).toBe('running');
  });
  it('joins the exact terminal once but a proposal never unlocks descendants', () => {
    const f = fixture(); const { terminal } = f.claimed(); const cmd = f.command();
    success(f.coordinator.joinTerminal(cmd, terminal));
    expect(f.coordinator.joinTerminal(cmd, terminal)).toMatchObject({ ok: true, disposition: 'replayed' });
    expect(f.coordinator.joinTerminal(f.command(), terminal).ok).toBe(false);
    f.link('b'); expect(f.coordinator.project().ready).toEqual([]); expect(f.coordinator.project().complete).toBe(false);
  });
  it('refuses unauthenticated applied status and producer done', () => {
    const f = fixture(); const { terminal, attempt } = f.claimed(); success(f.coordinator.joinTerminal(f.command(), terminal));
    const proposal = { id: terminal.proposalId, repo: attempt.executionRepo, runId: terminal.runId, workItemId: attempt.workItemId,
      workItemGenerationId: attempt.generationId, trajectoryId: `run:${terminal.runId}`, producerStatus: 'done', kind: 'patch', status: 'applied', verifyResult: { passed: true },
      realizedMerge: { source: 'local-default-branch', mergeCommitOid: 'a'.repeat(40) } } as Proposal;
    expect(f.coordinator.joinCompletion(f.command(), terminal, proposal).ok).toBe(false);
    expect(f.state().nodes[terminal.nodeId]!.completion).toBeNull();
  });
  it('requires both verified completion and authenticated identity, plus exact attempt bindings', () => {
    // Explicit inert witness doubles exercise joins; the previous test uses actual default authentication.
    const f = fixture(); const { terminal, attempt } = f.claimed(); success(f.coordinator.joinTerminal(f.command(), terminal));
    const proposal = { id: terminal.proposalId, repo: attempt.executionRepo, runId: terminal.runId, workItemId: attempt.workItemId,
      workItemGenerationId: attempt.generationId, trajectoryId: `run:${terminal.runId}`, producerStatus: 'done', kind: 'patch', status: 'applied', verifyResult: { passed: true } } as Proposal;
    const verify = vi.spyOn(completion, 'proposalCompletesGoalMilestone').mockReturnValue(true);
    const identity = vi.spyOn(merges, 'canonicalRealizedMergeIdentity').mockReturnValue(null);
    expect(f.coordinator.joinCompletion(f.command(), terminal, proposal).ok).toBe(false);
    identity.mockReturnValue({ source: 'local-default-branch', repo: attempt.executionRepo, base: 'master',
      mergeCommitOid: 'a'.repeat(40), key: 'authenticated-test-identity' });
    for (const field of ['id', 'repo', 'runId', 'workItemId', 'workItemGenerationId', 'trajectoryId']) {
      expect(f.coordinator.joinCompletion(f.command(), terminal, { ...proposal, [field]: 'foreign' }).ok).toBe(false);
    }
    expect(f.coordinator.joinCompletion(f.command(), terminal, { ...proposal, workItemGenerationId: undefined }).ok).toBe(false);
    verify.mockReturnValue(false); expect(f.coordinator.joinCompletion(f.command(), terminal, proposal).ok).toBe(false);
    verify.mockReturnValue(true); const cmd = f.command(); success(f.coordinator.joinCompletion(cmd, terminal, proposal));
    expect(f.coordinator.joinCompletion(cmd, terminal, proposal)).toMatchObject({ ok: true, disposition: 'replayed' });
    f.link('b'); expect(f.coordinator.project().ready).toEqual([f.nodeId('b')]);
    const old = f.state().nodes[f.nodeId('a')]!;
    f.refine(f.plan([f.work('a'), f.work('b', ['a']), f.work('c')]));
    expect(f.state().nodes[f.nodeId('a')]).toEqual(old);
  });
  it('recovers the real linked-stage crash seam before replaying an intent without duplication', () => {
    const f = fixture(); const cmd = f.command(); const state = success(f.coordinator.start(cmd, 'outcome', f.scope));
    const record = f.store.read().records[0]!;
    const target = join(f.store.directory, 'ledger', 'records', '0000000000000001.json');
    linkSync(target, join(f.store.directory, 'ledger', 'staging', `.1.${record.digest}.stage`));
    expect(f.store.read().sourceState).toBe('degraded');
    expect(f.coordinator.start(cmd, 'outcome', f.scope)).toEqual({ ok: true, disposition: 'replayed', state });
    expect(lstatSync(target).nlink).toBe(1); expect(f.store.read().records).toHaveLength(1);
    expect(readdirSync(join(f.store.directory, 'ledger', 'staging'))).toEqual([]);
  });
  it('checks final admission against exact generation, pause, changed scope and live authority', () => {
    const f = fixture(); const { id, attempt } = f.claimed();
    const inspect = () => f.coordinator.inspectClaim(id, attempt.id, attempt.generationId, f.admission);
    expect(inspect().admitted).toBe(true);
    expect(f.coordinator.inspectClaim(id, attempt.id, 'outcome:v1:foreign', f.admission).admitted).toBe(false);
    expect(f.coordinator.inspectClaim(id, attempt.id, attempt.generationId, { ...f.admission, stillAuthorized: () => false }).admitted).toBe(false);
    f.refine(f.plan([f.work('a'), f.work('b', ['a']), f.work('c')])); expect(inspect().admitted).toBe(true);
    success(f.coordinator.setPaused(f.command(), true)); expect(inspect().admitted).toBe(false);
    success(f.coordinator.setPaused(f.command(), false)); expect(inspect().admitted).toBe(true);
    success(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['Different scope'] })); expect(inspect().admitted).toBe(false);
  });
  it('allows an explicit authorized retry of a failed attempt while preserving its immutable identity', () => {
    const f = fixture(); const { id, terminal, attempt } = f.claimed();
    success(f.coordinator.joinTerminal(f.command(), { ...terminal, state: 'failed', proposalId: null }));
    expect(f.coordinator.project().ready).toEqual([]);
    expect(f.coordinator.claimReady(f.command(), id, attempt.executionRepo, f.admission).ok).toBe(false);
    success(f.coordinator.claimReady(f.command(), id, attempt.executionRepo, f.admission, true));
    const attempts = f.state().nodes[id]!.attempts;
    expect(attempts).toHaveLength(2); expect(attempts[0]!.id).toBe(attempt.id); expect(attempts[0]!.state).toBe('failed');
    expect(attempts[1]!.id).not.toBe(attempt.id); expect(attempts[1]!.generationId).not.toBe(attempt.generationId);
  });
  it('does not treat a missing run as proof a claimed attempt never started', () => {
    const f = fixture(); f.start(); f.refine(); f.link(); const id = f.nodeId('a');
    success(f.coordinator.claimReady(f.command(), id, f.scope.targetRepos[0]!, f.admission));
    const attempt = f.state().nodes[id]!.attempts[0]!;
    expect(f.coordinator.cancelUnstartedClaim(f.command(), id, attempt.id, attempt.generationId, () => false).ok).toBe(false);
    success(f.coordinator.cancelUnstartedClaim(f.command(), id, attempt.id, attempt.generationId, () => true));
    expect(f.state().nodes[id]!.attempts[0]!.state).toBe('aborted');
  });
  it('distinguishes an explicit authenticated human gate from routine plan refinement', () => {
    const f = fixture(); f.start();
    const gate: MissionGraphNodeInput = { ...f.work('review'), kind: 'human-gate', targetRepo: null };
    f.refine(f.plan([gate, f.work('a', ['review'])])); f.link(); const id = f.nodeId('review');
    expect(f.coordinator.project().ready).toEqual([]); expect(f.coordinator.project().materializationIntents).toEqual([]);
    expect(f.coordinator.joinHumanApproval(f.command(), id, 'a'.repeat(64), () => false).ok).toBe(false);
    success(f.coordinator.joinHumanApproval(f.command(), id, 'a'.repeat(64), node => node.id === id));
    expect(f.coordinator.project().ready).toEqual([f.nodeId('a')]);
  });
  it('authenticates a hermetic HMAC merge witness with the real verifier before releasing a dependency', () => {
    // The suite isolates homedir() before import. These are test keys and signed synthetic
    // witness fields, never an actual Git merge, production grant or provider operation.
    const f = fixture(); const { id, attempt, terminal } = f.claimed();
    success(f.coordinator.joinTerminal(f.command(), terminal));
    const proposal = { id: terminal.proposalId!, repo: attempt.executionRepo, runId: terminal.runId, workItemId: attempt.workItemId,
      workItemGenerationId: attempt.generationId, trajectoryId: `run:${terminal.runId}`, producerStatus: 'done', kind: 'patch', status: 'applied', diffHash: hashDiff('test-only diff'),
      verifyResult: { passed: true, baseHead: '1'.repeat(40), diffHash: hashDiff('test-only diff') } } as Proposal;
    const at = '2026-01-01T00:00:00.000Z';
    const intent: Omit<ProposalLocalMergeIntent, 'attestation'> = { schemaVersion: 1, branch: 'test/merge', base: 'main',
      baseBeforeOid: '1'.repeat(40), proposalHeadOid: '2'.repeat(40), diffHash: proposal.diffHash!,
      evidencePackDigest: '4'.repeat(64), authorizationId: '5'.repeat(32), authorizedAt: at };
    const intentAttestation = signLocalMergeIntent(proposal.id, attempt.executionRepo, intent);
    expect(intentAttestation).toMatch(/^[a-f0-9]{64}$/);
    proposal.localMergeIntent = { ...intent, attestation: intentAttestation };
    const witness = { schemaVersion: 1 as const, source: 'local-default-branch' as const, base: 'main',
      baseBeforeOid: intent.baseBeforeOid, proposalHeadOid: intent.proposalHeadOid, mergeCommitOid: '3'.repeat(40),
      observedAt: at, proposalId: proposal.id, diffHash: proposal.diffHash!, intentAttestation };
    proposal.realizedMerge = { ...witness, attestation: signLocalRealizedMergeReceipt(proposal.id, attempt.executionRepo, witness) };
    expect(f.coordinator.joinCompletion(f.command(), terminal, { ...proposal,
      realizedMerge: { ...proposal.realizedMerge, proposalHeadOid: '7'.repeat(40) } }).ok).toBe(false);
    success(f.coordinator.joinCompletion(f.command(), terminal, proposal));
    expect(f.state().nodes[id]!.completion?.mergeIdentity).toContain('3'.repeat(40));
    f.link('b'); expect(f.coordinator.project().ready).toEqual([f.nodeId('b')]);
  });
  it('fails closed on modified revision bytes, incomplete chains and non-private records', () => {
    const f = fixture(); f.start(); f.refine(); const directory = join(f.store.directory, 'ledger', 'records');
    const name = readdirSync(directory)[0]!; const path = join(directory, name); const record = JSON.parse(readFileSync(path, 'utf8'));
    record.state.paused = true; writeFileSync(path, outcomeCanonical(record) + '\n');
    expect(f.store.read().sourceState).toBe('degraded');
    const { digest: _digest, ...payload } = record; record.digest = outcomeDigest(payload);
    writeFileSync(path, outcomeCanonical(record) + '\n');
    expect(f.store.read().sourceState).toBe('degraded');
    chmodSync(path, 0o644); expect(f.store.read().sourceState).toBe('degraded');
  });
});

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { outcomeGraphObjective } from '../src/core/goals/outcome-types.js';
import { outcomeDirectory } from '../src/core/goals/outcome-runtime.js';
import { createLeaderOutcomesPort, readOutcomeInventory, type LeaderOutcomesDeps } from '../src/core/vision/leader-outcomes.js';
import { parseActionParams, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import { enactLeaderActions, vetoLeaderAction } from '../src/core/vision/leader-apply.js';
import { buildLeaderPrompt, evidenceDigest, gatherLeaderEvidence, gatherTriggerSignals, leaderRunDue, readLeaderRunState, runLeader,
  type LeaderRunDeps,
  type LeaderEvidenceSources } from '../src/core/vision/leader.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { LeaderSeatDeps } from '../src/core/vision/leader-seat.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat } from '../src/core/routing/headroom.js';
import type { LeaderOutcomeRefinement } from '../src/core/vision/leader-types.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { fleetMirrorsDir } from '../src/core/fleet/repo-identity.js';
import * as records from '../src/core/util/immutable-private-record-store.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
beforeEach(() => { home.setup(); process.env['HOME'] = realpathSync(home.home()); });
afterEach(() => { vi.restoreAllMocks(); home.teardown(); });
function fixture() {
  const root = realpathSync(home.home()); const repo = join(root, 'repo'); mkdirSync(repo);
  const directory = outcomeDirectory('outcome'); const store = new OutcomeStore(directory); const coordinator = new OutcomeCoordinator(store);
  const started = coordinator.start({ commandId: 'start', expectedRevision: 0 }, 'outcome', { desiredOutcome: 'Ship a useful verified improvement',
    targetRepos: [repo], acceptance: ['Meaningful checks pass and an authenticated merge reaches the default branch'] });
  if (!started.ok) throw new Error(started.reason);
  let policy = makePolicy(); let enrolled: LeaderOutcomesDeps['enrollment'] = () => ({ state: 'ready', repos: [repo] });
  const deps: LeaderOutcomesDeps = { now: () => NOW, standingPolicy: () => policy, enrollment: () => enrolled(), identityOfPath: () => 'ashlrai/binshield',
    directory: outcomeDirectory, inventory: () => readOutcomeInventory(dirname(directory)) };
  const port = createLeaderOutcomesPort(deps);
  const params: LeaderOutcomeRefinement = { outcomeId: 'outcome', scopeRevision: started.state.scopeRevision, scopeDigest: started.state.scopeDigest,
    title: 'Verified improvement plan', nodes: [{ kind: 'work', key: 'fix', title: 'Fix the measured defect', objective: 'Implement the defect fix',
      deliverable: 'Verified source change', riskClass: 'low', targetRepo: 'target-1', acceptance: ['A focused regression demonstrates the fix'] }] };
  const source: LeaderEvidenceSources = { outcomes: () => port.evidence(), standingPolicy: () => policy, budgetPolicy: defaultBudgetPolicy,
    capacity: () => null, goals: () => ({ goals: [], complete: true }), readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    holds: () => [], quality7d: () => ({ proposalsCreated: 0, merged: 0, rejected: 0, pending: 0, emptyRate: 0, acceptRate: 0, verifyPassRate: 0 }),
    models: () => [], reasoning: async () => ({ generatedAt: AT, window: { from: AT, to: AT }, totals: { steps: 0, sessions: 0, byEngine: {} }, insights: [], trends: [] }) };
  return { root, repo, directory, store, coordinator, deps, port, params, source,
    policy: () => policy, setPolicy: (next: typeof policy) => { policy = next; }, setEnrollment: (next: typeof enrolled) => { enrolled = next; } };
}
function mustApply(f: ReturnType<typeof fixture>, actionId = 'action-1') {
  const result = f.port.refine(actionId, f.params, AT); if (!result.ok) throw new Error(result.reason); return result.applied;
}

describe('Leader desired outcome planning bridge', () => {
  it('discovers an unplanned durable outcome without requiring an existing Goal', () => {
    const f = fixture(); const read = readOutcomeInventory();
    expect(read).toMatchObject({ sourceState: 'healthy', complete: true, unreadable: 0 });
    expect(read.states).toHaveLength(1); expect(read.states[0]!.graph).toBeNull();
    expect(f.port.evidence().outcomes[0]).toMatchObject({ outcomeId: 'outcome', targets: [{ alias: 'target-1', label: 'repo' }], nodes: [] });
    expect(JSON.stringify(f.port.evidence())).not.toContain(f.root);
  });
  it('observes a genuinely missing inventory without creating private directories', () => {
    const root = realpathSync(home.home());
    expect(readOutcomeInventory()).toMatchObject({ sourceState: 'missing', complete: true, states: [] });
    expect(() => realpathSync(join(root, '.ashlr'))).toThrow();
  });
  it('qualifies default directory resolution failure without throwing into unrelated backlog work', () => {
    const currentHome = process.env['HOME'];
    try {
      process.env['HOME'] = join(home.home(), 'missing-home');
      expect(readOutcomeInventory()).toMatchObject({ sourceState: 'degraded', complete: false, states: [], unreadable: 1 });
    } finally { process.env['HOME'] = currentHome; }
  });
  it.each(['symlink-root', 'symlink-entry', 'unknown-entry', 'wrong-id', 'unsafe-parent'])('qualifies %s as unknown/incomplete', condition => {
    const f = fixture(); const inventoryRoot = dirname(f.directory);
    if (condition === 'symlink-root') {
      const alias = join(f.root, 'alias'); symlinkSync(inventoryRoot, alias); expect(readOutcomeInventory(alias).complete).toBe(false); return;
    }
    if (condition === 'symlink-entry') symlinkSync(f.directory, join(inventoryRoot, 'alias'));
    else if (condition === 'unknown-entry') writeFileSync(join(inventoryRoot, 'unknown.json'), '{}');
    else if (condition === 'wrong-id') {
      const wrong = new OutcomeCoordinator(new OutcomeStore(join(inventoryRoot, 'other')));
      expect(wrong.start({ commandId: 'start', expectedRevision: 0 }, 'different', f.store.read().state!.scope).ok).toBe(true);
    } else { const alias = join(f.root, 'alias'); symlinkSync(join(f.root, '.ashlr'), alias); expect(readOutcomeInventory(join(alias, 'absent')).complete).toBe(false); return; }
    expect(readOutcomeInventory()).toMatchObject({ sourceState: 'degraded', complete: false });
  });
  it('supports the existing mirror lens while refusing another same-origin ordinary checkout', () => {
    const f = fixture(); mkdirSync(join(f.repo, '.git')); writeFileSync(join(f.repo, '.git', 'config'), '[remote "origin"]\nurl = https://github.com/ashlrai/binshield.git\n');
    const mirror = join(fleetMirrorsDir(), 'ashlrai__binshield'); mkdirSync(mirror, { recursive: true });
    f.setEnrollment(() => ({ state: 'ready', repos: [mirror] })); expect(f.port.refine('action-mirror', f.params, AT).ok).toBe(true);
    const ordinary = join(f.root, 'same-origin-checkout'); mkdirSync(join(ordinary, '.git'), { recursive: true });
    writeFileSync(join(ordinary, '.git', 'config'), '[remote "origin"]\nurl = https://github.com/ashlrai/binshield.git\n');
    f.setEnrollment(() => ({ state: 'ready', repos: [ordinary] })); expect(f.port.refine('action-ordinary', f.params, AT).ok).toBe(false);
  });
  it('marks a changed directory traversal incomplete rather than treating its partial list as authority', () => {
    const f = fixture(); const actual = OutcomeStore.prototype.read; let changed = false;
    vi.spyOn(OutcomeStore.prototype, 'read').mockImplementation(function (this: OutcomeStore) {
      const result = actual.call(this);
      if (!changed) {
        changed = true;
        const added = new OutcomeCoordinator(new OutcomeStore(join(dirname(f.directory), 'added')));
        expect(added.start({ commandId: 'add', expectedRevision: 0 }, 'added', f.store.read().state!.scope).ok).toBe(true);
      }
      return result;
    });
    expect(readOutcomeInventory()).toMatchObject({ sourceState: 'degraded', complete: false });
  });
  it('preserves long planning requirements and global acceptance tails while scrubbing private text', () => {
    const f = fixture(); const desiredOutcome = 'Ship measured improvements. '.repeat(800).slice(0, 20000) + 'DESIRED_TAIL';
    const acceptance = 'Run focused regressions. '.repeat(250).slice(0, 5000) + 'ACCEPTANCE_TAIL';
    const edited = f.coordinator.editScope({ commandId: 'scope-edit', expectedRevision: 1 }, { ...f.store.read().state!.scope,
      desiredOutcome: `${desiredOutcome} user@example.com`, acceptance: [acceptance] });
    expect(edited.ok).toBe(true); const evidence = f.port.evidence().outcomes[0]!;
    expect(evidence.desiredOutcome).toContain(desiredOutcome); expect(evidence.desiredOutcome).not.toContain('user@example.com');
    expect(evidence.acceptance).toEqual([acceptance]);
    expect(f.store.read().state!.scope.desiredOutcome).toContain('user@example.com');
  });
  it('preserves requirement tails in the actual Leader prompt when redaction expands text', async () => {
    const f = fixture(); const desiredOutcome = 'Bearer a '.repeat(50) + 'DESIRED_TAIL';
    const acceptance = 'Token x '.repeat(50) + 'ACCEPTANCE_TAIL';
    expect(f.coordinator.editScope({ commandId: 'scope-edit', expectedRevision: 1 },
      { ...f.store.read().state!.scope, desiredOutcome, acceptance: [acceptance] }).ok).toBe(true);
    const evidence = await gatherLeaderEvidence(f.source, NOW, readLeaderRunState(NOW));
    const projected = evidence.outcomes!.outcomes[0]!;
    expect(projected.desiredOutcome).toBe(desiredOutcome.replaceAll('Bearer a', 'Bearer [REDACTED]'));
    expect(projected.acceptance).toEqual([acceptance.replaceAll('Token x', 'Token [REDACTED]')]);
    expect(projected.desiredOutcome.length).toBeGreaterThan(desiredOutcome.length);
    const prompt = buildLeaderPrompt(evidence, { dryRun: false, nowIso: AT });
    expect(prompt).toContain('DESIRED_TAIL'); expect(prompt).toContain('ACCEPTANCE_TAIL');
    expect(prompt).toContain('[REDACTED]'); expect(prompt).not.toContain('Bearer a'); expect(prompt).not.toContain('Token x');
    expect(f.store.read().state!.scope).toMatchObject({ desiredOutcome, acceptance: [acceptance] });
  });
  it('parses exact aliases and rejects cycles, extra scope fields and raw absolute targets', () => {
    const f = fixture(); expect(parseActionParams('outcome.refine', f.params)).toMatchObject({ ok: true });
    for (const params of [{ ...f.params, desiredOutcome: 'Model replacement' }, { ...f.params, scopeRevision: 0 },
      { ...f.params, nodes: [{ ...f.params.nodes[0]!, targetRepo: f.repo }] },
      { ...f.params, nodes: [{ ...f.params.nodes[0]!, dependsOn: ['fix'] }] },
      { ...f.params, nodes: [{ ...f.params.nodes[0]!, acceptance: [] }] },
      { ...f.params, nodes: [{ ...f.params.nodes[0]!, kind: 'human-gate', targetRepo: null }] }]) {
      expect(parseActionParams('outcome.refine', params).ok).toBe(false);
    }
  });
  it('builds the graph using the saved desired outcome and exact approved target, preserving acceptance', () => {
    const f = fixture(); const before = f.store.read().state!; const applied = mustApply(f); const state = f.store.read().state!;
    expect(state.scope).toEqual(before.scope); expect(state.graph!.objective).toBe(before.scope.desiredOutcome);
    expect(state.graph!.nodes[0]!.repo).toBe(f.repo); expect(applied).toMatchObject({ planRevision: 1, scopeDigest: before.scopeDigest });
    expect(state.nodes[state.activeNodeIds[0]!]!.attempts).toEqual([]);
  });
  it.each(['scope', 'paused', 'enrollment', 'grant', 'identity', 'risk', 'unknown-target'])('holds %s violating plans', reason => {
    const f = fixture();
    if (reason === 'scope') f.params.scopeDigest = '0'.repeat(64);
    else if (reason === 'paused') expect(f.coordinator.setPaused({ commandId: 'pause', expectedRevision: 1 }, true).ok).toBe(true);
    else if (reason === 'enrollment') f.setEnrollment(() => ({ state: 'degraded' }));
    else if (reason === 'grant') f.setPolicy({ ...f.policy(), leader: { classes: [], vetoMinutes: 30 } });
    else if (reason === 'identity') f.deps.identityOfPath = () => null;
    else if (reason === 'risk') f.params.nodes[0]!.riskClass = 'high';
    else f.params.nodes[0]!.targetRepo = 'target-2';
    expect(f.port.refine('action-1', f.params, AT).ok).toBe(false); expect(f.store.read().state!.graph).toBeNull();
  });
  it.each(['authority', 'enrollment', 'risk'])('rechecks %s at the actual immutable publication fence', revocation => {
    const f = fixture(); const write = records.writeImmutablePrivateRecord;
    if (revocation === 'risk') { f.params.nodes[0]!.riskClass = 'high'; f.setPolicy({ ...f.policy(), repos: f.policy().repos.map(repo => ({ ...repo, maxRisk: 'high' })) }); }
    vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((...args) => {
      if (revocation === 'enrollment') f.setEnrollment(() => ({ state: 'degraded' }));
      else if (revocation === 'authority') f.setPolicy({ ...f.policy(), switch: 'propose' });
      else f.setPolicy({ ...f.policy(), repos: f.policy().repos.map(repo => ({ ...repo, maxRisk: 'low' })) });
      return write(...args);
    });
    expect(f.port.refine('action-1', f.params, AT).ok).toBe(false); expect(f.store.read().state!.graph).toBeNull();
  });
  it('replays the same stable action without adding another plan revision', () => {
    const f = fixture(); const first = mustApply(f); expect(mustApply(f)).toEqual(first); expect(f.store.read().state!.planRevision).toBe(1);
  });
  it('pauses only the exact applied plan and retains history without claiming exact restoration', () => {
    const f = fixture(); const applied = mustApply(f);
    expect(f.port.pausePlan('action-1', applied)).toMatchObject({ ran: true, detail: expect.stringContaining('not restored') });
    expect(f.store.read().state).toMatchObject({ paused: true, graphDigest: applied.graphDigest });
    expect(f.port.pausePlan('action-1', applied).ran).toBe(false);
  });
  it.each(['scope', 'plan'])('never overwrites a subsequent %s edit during veto', change => {
    const f = fixture(); const applied = mustApply(f);
    if (change === 'scope') expect(f.coordinator.editScope({ commandId: 'edit', expectedRevision: 2 },
      { ...f.store.read().state!.scope, acceptance: ['New acceptance'] }).ok).toBe(true);
    else { f.params.title = 'Updated plan'; mustApply(f, 'action-2'); }
    expect(f.port.pausePlan('action-1', applied).ran).toBe(false); expect(f.store.read().state!.paused).toBe(false);
  });
  it('enacts through the existing signed class A action pipeline, records inverse and supports veto', async () => {
    const f = fixture(); const ledger = fakeLedger(); const { deps } = makeApplyDeps({ ledger, now: () => NOW, policy: f.policy }); deps.outcomes = f.port;
    const drafts = [{ kind: 'outcome.refine', params: f.params, summary: 'Plan desired outcome', why: 'Saved outcome needs tasks' }] as AnyLeaderActionDraft[];
    const actions = await enactLeaderActions(deps, 'memo-outcome', drafts, [], { idFor: () => 'action-1' });
    expect(actions[0]).toMatchObject({ class: 'A', status: 'applied', inverse: { op: 'pause-outcome-plan', outcomeId: 'outcome' } });
    expect(ledger.rows('leader:action').at(-1)).toMatchObject({ status: 'applied' });
    const veto = await vetoLeaderAction(deps, 'action-1', 'Pause this plan');
    expect(veto.records[0]).toMatchObject({ restored: false, detail: expect.stringContaining('not restored') });
    expect(f.store.read().state!.paused).toBe(true);
  });
  it.each([{ length: 100, contextWindow: 65536 }, { length: 5000, contextWindow: 65536 },
    { length: 20000, contextWindow: 65536 }, { length: 20000, contextWindow: 2048 }])('routes a $length character saved scope with $contextWindow measured context through the existing Leader chain', async ({ length, contextWindow }) => {
    const f = fixture(); const desiredOutcome = length === 100 ? f.store.read().state!.scope.desiredOutcome : 'Plan verified improvements. '.repeat(Math.ceil(length / 20)).slice(0, length - 4) + 'TAIL';
    if (length !== 100) {
      const edited = f.coordinator.editScope({ commandId: 'scope-edit', expectedRevision: 1 }, { ...f.store.read().state!.scope, desiredOutcome });
      if (!edited.ok) throw new Error(edited.reason); f.params.scopeRevision = edited.state.scopeRevision; f.params.scopeDigest = edited.state.scopeDigest;
    } const ledger = fakeLedger(); const { deps: apply } = makeApplyDeps({ ledger, now: () => NOW, policy: f.policy }); apply.outcomes = f.port;
    const candidate = { seat: { id: 'local:qwen', engine: 'local' as const, label: 'Qwen', accountId: 'local',
      models: [{ id: 'qwen', label: 'Qwen', contextWindow }], contextWindow,
      health: { state: 'ready' as const, summary: null, windows: [], observedAt: null } }, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' };
    const calls: string[] = [];
    const seat: LeaderSeatDeps = { cfg: {} as AshlrConfig, now: () => NOW, candidates: async () => [candidate], capacitySnapshot: () => null,
      budgetPolicy: defaultBudgetPolicy, standingPolicy: f.policy, clampBudget: policy => policy, route: (req, cap, policy, nowMs) => routeSeat(req, cap, policy, { nowMs }),
      capacityFromSeat: value => capacityFromSeat(value), recordDecision: () => undefined,
      transports: { local: () => async (_system, prompt) => { calls.push(prompt); return JSON.stringify({
        bottleneck: { statement: 'Saved outcome needs tasks', metric: 'active-goals', evidence: ['Unplanned durable outcome'] },
        move: { statement: 'Plan verified work', why: 'Begin useful execution', expectedDelta: null },
        actions: [{ kind: 'outcome.refine', params: f.params, summary: 'Plan saved outcome', why: 'The outcome is unplanned' }],
      }); }, grok: () => async () => { throw new Error('No live providers'); }, claude: () => async () => { throw new Error('No live providers'); } } };
    const deps: LeaderRunDeps = { cfg: {} as AshlrConfig, now: () => NOW, sources: f.source, seat, apply };
    const result = await runLeader(deps, 'outcome-plan-needed');
    if (contextWindow === 2048) {
      expect(result.outcome).toBe('no-seat'); expect(calls).toEqual([]); expect(f.store.read().state!.graph).toBeNull();
      expect(f.store.read().state!.scope.desiredOutcome).toBe(desiredOutcome); return;
    }
    expect(result.outcome).toBe('ok'); expect(result.memo!.actions).toEqual([expect.objectContaining({ kind: 'outcome.refine', class: 'A', status: 'applied' })]);
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('DESIRED OUTCOMES AND SAVED TARGET ALIASES');
    if (length !== 100) { expect(calls[0]).toContain(desiredOutcome); expect(calls[0]).toContain('TAIL'); }
    expect(f.store.read().state!.graph).not.toBeNull(); expect(f.store.read().state!.scope.desiredOutcome).toBe(desiredOutcome);
    expect(f.store.read().state!.graph!.objective).toBe(outcomeGraphObjective(f.store.read().state!));
  });
  it('cannot plan when the existing authority ledger refuses the scheduled action', async () => {
    const f = fixture(); const ledger = fakeLedger(); ledger.failAppends = true;
    const { deps } = makeApplyDeps({ ledger, now: () => NOW, policy: f.policy }); deps.outcomes = f.port;
    const drafts = [{ kind: 'outcome.refine', params: f.params, summary: 'Plan', why: 'Needed' }] as AnyLeaderActionDraft[];
    const actions = await enactLeaderActions(deps, 'memo-outcome', drafts, [], { idFor: () => 'action-1' });
    expect(actions[0]!.status).toBe('refused'); expect(f.store.read().state!.graph).toBeNull();
  });
  it('pauses a plan when the applied action ledger write fails and reports partial inverse truthfully', async () => {
    const f = fixture(); const ledger = fakeLedger(); const append = ledger.append;
    ledger.append = input => input.kind === 'leader:action' && (input.data as { status?: string }).status === 'applied'
      ? { ok: false, reason: 'Applied row unavailable' } : append(input);
    const { deps } = makeApplyDeps({ ledger, now: () => NOW, policy: f.policy }); deps.outcomes = f.port;
    const actions = await enactLeaderActions(deps, 'memo-outcome', [{ kind: 'outcome.refine', params: f.params,
      summary: 'Plan', why: 'Needed' }] as AnyLeaderActionDraft[], [], { idFor: () => 'action-1' });
    expect(actions[0]).toMatchObject({ status: 'failed', statusReason: expect.stringContaining('not restored') });
    expect(f.store.read().state).toMatchObject({ paused: true, planRevision: 1 });
    expect(f.store.read().state!.graph).not.toBeNull();
  });
  it('exposes unplanned outcomes in evidence/digests and an existing cadence trigger', async () => {
    const f = fixture(); const state = readLeaderRunState(NOW); state.lastRun = { at: AT, outcome: 'ok', reason: null, memoId: 'prior', trigger: 'manual' };
    const before = await gatherLeaderEvidence(f.source, NOW, state);
    expect(buildLeaderPrompt(before, { dryRun: false, nowIso: AT })).toContain('DESIRED OUTCOMES AND SAVED TARGET ALIASES');
    const signals = await gatherTriggerSignals(f.source, state, NOW);
    expect(signals.outcomePlanNeeded).toBe(true); expect(leaderRunDue(NOW, state, signals).trigger).toBe('outcome-plan-needed');
    mustApply(f); const after = await gatherLeaderEvidence(f.source, NOW, state);
    expect(evidenceDigest(after)).not.toBe(evidenceDigest(before)); expect((await gatherTriggerSignals(f.source, state, NOW)).outcomePlanNeeded).toBe(false);
    expect(leaderRunDue(NOW, state, signals, { maxRunsPerDay: 0, maxRunsPerDayTotal: 0, checkinHours: 0 } as never).due).toBe(false);
  });
  it('lets recorded failed tasks trigger corrective refinement without automatically replaying them', async () => {
    const f = fixture(); mustApply(f); const state = f.store.read().state!; const id = state.activeNodeIds[0]!; const node = state.nodes[id]!;
    expect(f.coordinator.linkMaterialization({ commandId: 'link', expectedRevision: 2 }, id, node.materialization.goalId, node.materialization.milestoneId,
      { stillAuthorized: () => true, matchesPersistedGoal: () => true }).ok).toBe(true);
    expect(f.coordinator.claimReady({ commandId: 'claim', expectedRevision: 3 }, id, f.repo,
      { stillAuthorized: () => true, executionRepoAllowed: () => true }).ok).toBe(true);
    const attempt = f.store.read().state!.nodes[id]!.attempts[0]!;
    expect(f.coordinator.joinRun({ commandId: 'run', expectedRevision: 4 }, id, attempt.id, 'run-1').ok).toBe(true);
    expect(f.coordinator.joinTerminal({ commandId: 'terminal', expectedRevision: 5 }, { nodeId: id, attemptId: attempt.id,
      generationId: attempt.generationId, executionRepo: f.repo, runId: 'run-1', state: 'failed', proposalId: null }).ok).toBe(true);
    expect((await gatherTriggerSignals(f.source, readLeaderRunState(NOW), NOW)).outcomePlanNeeded).toBe(true);
    expect(f.port.evidence().outcomes[0]!.nodes[0]).toMatchObject({ state: 'failed', terminalRunId: 'run-1' });
    mustApply(f, 'action-identical'); expect(f.coordinator.project().ready).toEqual([]);
    f.params.nodes[0]!.objective = 'Correct the observed failure and implement the fix'; mustApply(f, 'action-corrective');
    expect(f.store.read().state!.nodes[id]!.attempts[0]!.state).toBe('failed');
    expect(f.store.read().state!.activeNodeIds).not.toContain(id);
  });
  it('never triggers automatic planning from a partial, thrown or paused outcome source', async () => {
    const f = fixture(); f.source.outcomes = () => ({ ...f.port.evidence(), sourceState: 'degraded', complete: false });
    expect((await gatherTriggerSignals(f.source, readLeaderRunState(NOW), NOW)).outcomePlanNeeded).toBe(false);
    expect((await gatherLeaderEvidence(f.source, NOW, readLeaderRunState(NOW))).unknown).toContain('outcomes-partial');
    f.source.outcomes = () => { throw new Error('Unavailable'); };
    expect((await gatherTriggerSignals(f.source, readLeaderRunState(NOW), NOW)).outcomePlanNeeded).toBe(false);
    expect((await gatherLeaderEvidence(f.source, NOW, readLeaderRunState(NOW))).unknown).toContain('outcomes');
    f.source.outcomes = () => f.port.evidence(); f.coordinator.setPaused({ commandId: 'pause', expectedRevision: 1 }, true);
    expect((await gatherTriggerSignals(f.source, readLeaderRunState(NOW), NOW)).outcomePlanNeeded).toBe(false);
  });
});

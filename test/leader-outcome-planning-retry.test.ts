import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { outcomeDirectory } from '../src/core/goals/outcome-runtime.js';
import { createLeaderOutcomesPort, outcomePlanningBasis, outcomePlanningProgress, readOutcomeInventory,
  type LeaderOutcomesDeps, type LeaderOutcomeEvidence } from '../src/core/vision/leader-outcomes.js';
import { gatherTriggerSignals, leaderRunDue, leaderStatePath, readLeaderRunState, runLeader,
  type LeaderRunDeps, type LeaderEvidenceSources } from '../src/core/vision/leader.js';
import { resolveLeaderCadence } from '../src/core/vision/leader-cadence.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { LeaderSeatDeps } from '../src/core/vision/leader-seat.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat } from '../src/core/routing/headroom.js';
import type { LeaderOutcomeRefinement } from '../src/core/vision/leader-types.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
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
function runner(f: ReturnType<typeof fixture>, reply: () => unknown, now: () => number = () => NOW) {
 const ledger = fakeLedger(); const { deps: apply } = makeApplyDeps({ ledger, now, policy: f.policy }); apply.outcomes = f.port;
 const candidate = { seat: { id: 'local:qwen', engine: 'local' as const, label: 'Qwen', accountId: 'local',
 models: [{id:'qwen',label:'Qwen',contextWindow:65536}],contextWindow:65536,
 health:{state:'ready' as const,summary:null,windows:[],observedAt:null}},launcher:null,ollamaBaseUrl:'http://127.0.0.1:11434' };
 let contacts=0;
 const seat: LeaderSeatDeps = {cfg:{} as AshlrConfig,now,candidates:async()=>[candidate],capacitySnapshot:()=>null,
 budgetPolicy:defaultBudgetPolicy,standingPolicy:f.policy,clampBudget:policy=>policy,
 route:(req,cap,policy,nowMs)=>routeSeat(req,cap,policy,{nowMs}),capacityFromSeat:value=>capacityFromSeat(value),recordDecision:()=>undefined,
 transports:{local:()=>async()=>{contacts++;return JSON.stringify(reply());},grok:()=>async()=>{throw Error('Live provider prohibited')},claude:()=>async()=>{throw Error('Live provider prohibited')}}};
 const deps: LeaderRunDeps={cfg:{} as AshlrConfig,now,sources:f.source,seat,apply};
 return {deps,contacts:()=>contacts};
}
const memo=(actions: unknown[])=>({bottleneck:{statement:'Saved outcome needs tasks',metric:'active-goals',evidence:['Unplanned outcome']},
move:{statement:'Plan work',why:'Execute desired result',expectedDelta:null},actions});

describe('outcome planning retry and verified progress', () => {
  it.each(['omitted', 'refused'])('backs off %s planning without consuming evidence or repeating contacts', async kind => {
    const f = fixture(); let clock = NOW;
    const actions = kind === 'omitted' ? [] : [{ kind: 'outcome.refine', params: { ...f.params, scopeDigest: '0'.repeat(64) }, summary: 'Plan', why: 'Needed' }];
    const r = runner(f, () => memo(actions), () => clock);
    const first = await runLeader(r.deps, 'outcome-plan-needed');
    expect(first.outcome).toBe('failed');
    if (kind === 'refused') expect(first.memo!.actions[0]!.status).toBe('refused');
    const state = readLeaderRunState(NOW); expect(state.lastEvidenceDigest).toBeNull();
    expect(state.outcomePlanningRetry).toMatchObject({ failures: 1, retryAt: new Date(NOW + 15 * 60000).toISOString() });
    clock += 60000;
    const signals = await gatherTriggerSignals(f.source, state, clock);
    expect(leaderRunDue(clock, state, signals).due).toBe(false);
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged');
    expect(r.contacts()).toBe(1); expect(f.store.read().state!.graph).toBeNull();
    clock = NOW + 15 * 60000;
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('failed');
    expect(r.contacts()).toBe(2); expect(readLeaderRunState(clock).outcomePlanningRetry!.failures).toBe(2);
  });
  it('transport failure obeys the same floor on direct retry and outcome callers', async () => {
    const f = fixture(); let clock = NOW; const r = runner(f, () => { throw Error('Hermetic transport failed'); }, () => clock);
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('failed');
    clock += 60000;
    expect((await runLeader(r.deps, 'retry')).outcome).toBe('skipped-unchanged');
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged'); expect(r.contacts()).toBe(1);
  });
  it('exhaustion holds only the unchanged planning event, preserves daily and manual recovery', async () => {
    const f = fixture(); let clock = NOW; const r = runner(f, () => memo([]), () => clock);
    r.deps.cfg = { foundry: { leaderPreferences: { maxFullRunsPerDay: null, maxTotalRunsPerDay: null } } } as AshlrConfig;
    for (const step of [0, 15, 60, 180]) { clock = NOW + step * 60000; await runLeader(r.deps, 'outcome-plan-needed'); }
    const state = readLeaderRunState(clock); expect(state.outcomePlanningRetry).toMatchObject({ failures: 4, retryAt: null });
    clock += 60000; expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged'); expect(r.contacts()).toBe(4);
    const signals = await gatherTriggerSignals(f.source, state, clock);
    expect(leaderRunDue(clock + 86400000, state, signals, resolveLeaderCadence(r.deps.cfg)).trigger).toBe('schedule');
    expect((await runLeader(r.deps, 'schedule')).outcome).toBe('ok'); expect(readLeaderRunState(clock).outcomePlanningRetry).toBeNull();
    expect((await runLeader(r.deps, 'manual', { force: true })).outcome).toBe('ok'); expect(r.contacts()).toBe(6);
  });
  it('a queued direct retry cannot bypass planning backoff after advisory check-in clears the legacy retry', async () => {
    const f = fixture(); let clock = NOW; const r = runner(f, () => memo([]), () => clock);
    await runLeader(r.deps, 'outcome-plan-needed'); clock += 60000;
    expect((await runLeader(r.deps, 'checkin', { force: true })).outcome).toBe('ok');
    expect(readLeaderRunState(clock).retry).toBeNull(); expect(readLeaderRunState(clock).outcomePlanningRetry).not.toBeNull();
    expect((await runLeader(r.deps, 'retry')).outcome).toBe('skipped-unchanged'); expect(r.contacts()).toBe(2);
  });
  it('a changed saved scope is eligible immediately instead of inheriting old-scope backoff', async () => {
    const f = fixture(); let clock = NOW; const r = runner(f, () => memo([]), () => clock);
    await runLeader(r.deps, 'outcome-plan-needed'); clock += 60000;
    expect(f.coordinator.editScope({ commandId: 'edit', expectedRevision: 1 }, { ...f.store.read().state!.scope, acceptance: ['New saved acceptance'] }).ok).toBe(true);
    const state = readLeaderRunState(clock); const signals = await gatherTriggerSignals(f.source, state, clock);
    expect(leaderRunDue(clock, state, signals).trigger).toBe('outcome-plan-needed');
    await runLeader(r.deps, 'outcome-plan-needed'); expect(r.contacts()).toBe(2); expect(readLeaderRunState(clock).outcomePlanningRetry!.failures).toBe(1);
  });
  it('scheduled transport failure with pending planning binds the same scope backoff', async () => {
    const f = fixture(); let clock = NOW; const r = runner(f, () => { throw Error('Hermetic failure'); }, () => clock);
    expect((await runLeader(r.deps, 'schedule')).outcome).toBe('failed'); clock += 60000;
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged'); expect(r.contacts()).toBe(1);
  });
  it('planning backoff does not suppress unrelated reset, insight or check-in cadence', async () => {
    const f = fixture(); const r = runner(f, () => memo([])); await runLeader(r.deps, 'outcome-plan-needed');
    const state = readLeaderRunState(NOW); const signals = await gatherTriggerSignals(f.source, state, NOW + 60000);
    expect(leaderRunDue(NOW + 60000, state, { ...signals, seatResetSinceLastRun: true }).trigger).toBe('seat-reset');
    expect(leaderRunDue(NOW + 60000, state, { ...signals, highInsightSinceLastRun: true }).trigger).toBe('insight');
    const checkinClock = new Date(NOW); checkinClock.setHours(12, 0, 0, 0);
    state.lastRun = { at: checkinClock.toISOString(), outcome: 'failed', reason: null, memoId: null, trigger: 'outcome-plan-needed' };
    state.retry = null; state.outcomePlanningRetry!.retryAt = new Date(checkinClock.getTime() + 3600000).toISOString();
    state.lastSuccessAt = new Date(checkinClock.getTime() - 3 * 3600000).toISOString();
    expect(leaderRunDue(checkinClock.getTime(), state, signals, resolveLeaderCadence({} as AshlrConfig)).trigger).toBe('checkin');
  });
  it('reapplying the identical failed immutable node is not progress despite an applied action and new plan revision', async () => {
    const f = fixture(); expect(f.port.refine('seed', f.params, AT).ok).toBe(true);
    let state = f.store.read().state!; const nodeId = state.activeNodeIds[0]!; const node = state.nodes[nodeId]!;
    expect(f.coordinator.linkMaterialization({ commandId: 'link', expectedRevision: state.revision }, nodeId,
      node.materialization.goalId, node.materialization.milestoneId, { stillAuthorized: () => true, matchesPersistedGoal: () => true }).ok).toBe(true);
    state = f.store.read().state!;
    expect(f.coordinator.claimRunReady({ commandId: 'claim', expectedRevision: state.revision }, nodeId, f.repo, 'mock-run',
      { stillAuthorized: () => true, executionRepoAllowed: () => true }).ok).toBe(true);
    state = f.store.read().state!; const attempt = state.nodes[nodeId]!.attempts.at(-1)!;
    expect(f.coordinator.joinTerminal({ commandId: 'terminal', expectedRevision: state.revision }, { nodeId, attemptId: attempt.id,
      generationId: attempt.generationId, executionRepo: f.repo, runId: 'mock-run', proposalId: null, state: 'failed' }).ok).toBe(true);
    const before = f.port.evidence(); const r = runner(f, () => memo([{ kind: 'outcome.refine', params: f.params, summary: 'Plan', why: 'Repair failed task' }]));
    const result = await runLeader(r.deps, 'outcome-plan-needed'); expect(result.memo!.actions[0]!.status).toBe('applied');
    expect(result.outcome).toBe('failed'); expect(f.store.read().state!.planRevision).toBe(2);
    expect(outcomePlanningBasis(f.port.evidence())).toBe(outcomePlanningBasis(before)); expect(readLeaderRunState(NOW).lastEvidenceDigest).toBeNull();
  });
  it('keeps unrelated applied action history without treating it as planning progress', async () => {
    const f = fixture(); const r = runner(f, () => memo([{ kind: 'lanes.grok', params: { slots: 1 }, summary: 'Adjust lanes', why: 'Ordinary tuning' }]));
    const result = await runLeader(r.deps, 'outcome-plan-needed'); expect(result.memo!.actions[0]!.status).toBe('applied');
    expect(result.outcome).toBe('failed'); expect(readLeaderRunState(NOW).runDays).toEqual({ '2026-10-02': 1 });
    expect(readLeaderRunState(NOW).lastEvidenceDigest).toBeNull(); expect(f.store.read().state!.graph).toBeNull();
  });
  it('measures planning retry backoff from the completed contact, not its start', async () => {
    const f = fixture(); let clock = NOW; const r = runner(f, () => { clock += 3600000; throw Error('Delayed mock failure'); }, () => clock);
    await runLeader(r.deps, 'outcome-plan-needed');
    expect(readLeaderRunState(clock).outcomePlanningRetry!.retryAt).toBe(new Date(clock + 15 * 60000).toISOString());
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged'); expect(r.contacts()).toBe(1);
  });
  it('successful actual plan readback records progress and clears planning retry state', async () => {
    const f = fixture(); const r = runner(f, () => memo([{ kind: 'outcome.refine', params: f.params, summary: 'Plan', why: 'Needed' }]));
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('ok');
    expect(f.store.read().state!.activeNodeIds).toHaveLength(1); expect(readLeaderRunState(NOW).lastEvidenceDigest).not.toBeNull();
    expect(readLeaderRunState(NOW).outcomePlanningRetry).toBeNull();
  });
  it('operator pause during the model call changes no graph and does not penalize the new state', async () => {
    const f = fixture(); const r = runner(f, () => {
      expect(f.coordinator.setPaused({ commandId: 'pause', expectedRevision: 1 }, true).ok).toBe(true);
      return memo([{ kind: 'outcome.refine', params: f.params, summary: 'Plan', why: 'Needed' }]);
    });
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged');
    expect(f.store.read().state!.graph).toBeNull(); expect(readLeaderRunState(NOW).outcomePlanningRetry).toBeNull();
    expect(readLeaderRunState(NOW).consecutiveFailures).toBeUndefined(); expect(r.contacts()).toBe(1);
  });
  it('scope CAS changes while awaiting the reply leave the new scope unplanned and immediately discoverable', async () => {
    const f = fixture(); const r = runner(f, () => {
      expect(f.coordinator.editScope({ commandId: 'human-edit', expectedRevision: 1 }, { ...f.store.read().state!.scope,
        desiredOutcome: 'Operator changed the desired outcome' }).ok).toBe(true);
      return memo([{ kind: 'outcome.refine', params: f.params, summary: 'Plan old scope', why: 'Needed' }]);
    });
    const result = await runLeader(r.deps, 'outcome-plan-needed'); expect(result.outcome).toBe('skipped-unchanged');
    expect(result.memo!.actions[0]!.status).toBe('refused'); expect(f.store.read().state!.graph).toBeNull();
    const state = readLeaderRunState(NOW); expect(state.outcomePlanningRetry).toBeNull();
    expect((await gatherTriggerSignals(f.source, state, NOW)).outcomePlanNeeded).toBe(true);
  });
  it('unknown fresh readback never claims installed planning progress', async () => {
    const f = fixture(); const r = runner(f, () => {
      f.source.outcomes = () => ({ ...f.port.evidence(), complete: false, sourceState: 'degraded' });
      return memo([{ kind: 'outcome.refine', params: f.params, summary: 'Plan', why: 'Needed' }]);
    });
    const result = await runLeader(r.deps, 'outcome-plan-needed'); expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('unconfirmed'); expect(readLeaderRunState(NOW).lastEvidenceDigest).toBeNull();
  });
  it('dry-run and check-in advice never mark the pending outcome evidence handled', async () => {
    const f = fixture(); f.setPolicy({ ...f.policy(), switch: 'propose' });
    const r = runner(f, () => memo([{ kind: 'outcome.refine', params: f.params, summary: 'Plan', why: 'Needed' }]));
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged');
    expect((await runLeader(r.deps, 'outcome-plan-needed')).outcome).toBe('skipped-unchanged'); expect(r.contacts()).toBe(0);
    expect(f.store.read().state!.graph).toBeNull(); expect(readLeaderRunState(NOW).lastEvidenceDigest).toBeNull();
    expect((await runLeader(r.deps, 'checkin', { force: true })).outcome).toBe('ok');
    expect(readLeaderRunState(NOW).lastEvidenceDigest).toBeNull(); expect(f.store.read().state!.graph).toBeNull();
  });
  it('validates only bounded host retry metadata while retaining old records', async () => {
    const f = fixture(); const r = runner(f, () => memo([])); await runLeader(r.deps, 'outcome-plan-needed');
    const state = readLeaderRunState(NOW); expect(readLeaderRunState(NOW).outcomePlanningRetry).toEqual(state.outcomePlanningRetry);
    for (const value of [{ basis: 'untrusted', failures: 1, retryAt: AT }, { ...state.outcomePlanningRetry, failures: 999 },
      { ...state.outcomePlanningRetry, retryAt: 'not-a-date' }, { ...state.outcomePlanningRetry, extra: true }]) {
      writeFileSync(leaderStatePath(), JSON.stringify({ ...state, outcomePlanningRetry: value }), { mode: 0o600 });
      expect(readLeaderRunState(NOW).outcomePlanningRetry).toBeNull(); expect(readLeaderRunState(NOW).retry).toEqual(state.retry);
    }
    const { outcomePlanningRetry: _oldAbsent, ...old } = state;
    writeFileSync(leaderStatePath(), JSON.stringify(old), { mode: 0o600 }); expect(readLeaderRunState(NOW).retry).toEqual(state.retry);
  });
});

const projection = (): LeaderOutcomeEvidence => ({ sourceState: 'healthy', complete: true, unreadable: 0, limitExceeded: false,
  outcomes: [{ outcomeId: 'one', scopeRevision: 1, scopeDigest: 'a'.repeat(64), planRevision: 1, graphDigest: 'b'.repeat(64), paused: false,
    desiredOutcome: 'Improve', acceptance: ['Verify'], targets: [], nodes: [{ nodeId: 'c'.repeat(64), key: 'fix', kind: 'work', title: 'Fix',
      state: 'failed', attemptId: 'attempt-one', terminalRunId: 'run-one', dependsOn: [], acceptance: ['Verify'] }] }] });
describe('immutable planning basis and substantive graph progress', () => {
  it('ignores plan revision/hash churn and identical failed node reapplication', () => {
    const before = projection(); const after = structuredClone(before); after.outcomes[0]!.planRevision++;
    after.outcomes[0]!.graphDigest = 'd'.repeat(64);
    expect(outcomePlanningBasis(after)).toBe(outcomePlanningBasis(before)); expect(outcomePlanningProgress(before, after)).toBe('unchanged');
    after.outcomes[0]!.nodes[0]!.attemptId = 'new-attempt'; expect(outcomePlanningBasis(after)).not.toBe(outcomePlanningBasis(before));
  });
  it('counts new corrective work without hiding another pending outcome', () => {
    const before = projection(); before.outcomes.push({ ...structuredClone(before.outcomes[0]!), outcomeId: 'two' });
    const after = structuredClone(before); after.outcomes[0]!.nodes.push({ ...after.outcomes[0]!.nodes[0]!, nodeId: 'e'.repeat(64), key: 'repair', state: 'pending' });
    expect(outcomePlanningProgress(before, after)).toBe('progress'); expect(outcomePlanningBasis(after)).not.toBeNull();
    after.outcomes[0]!.paused = true; expect(outcomePlanningProgress(before, after)).toBe('unchanged');
  });
  it.each(['complete', 'failed-dependency', 'human-dependency'])('does not count %s as executable corrective work', condition => {
    const before = projection(); const after = structuredClone(before);
    after.outcomes[0]!.nodes.push({ ...after.outcomes[0]!.nodes[0]!, nodeId: 'e'.repeat(64), key: 'repair', state: condition === 'complete' ? 'complete' : 'pending',
      dependsOn: condition === 'complete' ? [] : ['fix'] });
    if (condition === 'human-dependency') { after.outcomes[0]!.nodes[0]!.kind = 'human-gate'; after.outcomes[0]!.nodes[0]!.state = 'pending'; }
    expect(outcomePlanningProgress(before, after)).toBe('unchanged');
  });
  it('a later memo for an already planned outcome cannot satisfy another pending outcome', () => {
    const before = projection(); const resolved = { ...structuredClone(before.outcomes[0]!), outcomeId: 'resolved' };
    resolved.nodes[0]!.state = 'pending'; before.outcomes.push(resolved);
    const after = structuredClone(before); after.outcomes[1]!.nodes.push({ ...resolved.nodes[0]!, key: 'extra', nodeId: 'e'.repeat(64) });
    expect(outcomePlanningProgress(before, after)).toBe('unchanged');
  });
  it('accepts a shared-dependency DAG but keeps failed shared paths and cycles unexecutable', () => {
    const before = projection(); const template = before.outcomes[0]!.nodes[0]!;
    before.outcomes[0]!.nodes.push(
      { ...template, key: 'shared', nodeId: 'd'.repeat(64), state: 'complete' },
      { ...template, key: 'left', nodeId: 'e'.repeat(64), state: 'complete', dependsOn: ['shared'] },
      { ...template, key: 'right', nodeId: 'f'.repeat(64), state: 'complete', dependsOn: ['shared'] });
    const after = structuredClone(before);
    after.outcomes[0]!.nodes.push({ ...template, key: 'repair', nodeId: '1'.repeat(64), state: 'pending', dependsOn: ['left', 'right'] });
    expect(outcomePlanningProgress(before, after)).toBe('progress');
    after.outcomes[0]!.nodes[1]!.state = 'failed'; expect(outcomePlanningProgress(before, after)).toBe('unchanged');
    after.outcomes[0]!.nodes[1]!.state = 'complete'; after.outcomes[0]!.nodes[1]!.dependsOn = ['left'];
    expect(outcomePlanningProgress(before, after)).toBe('unchanged');
  });
  it('treats partial evidence and changed scopes as unknown/stale, never progress', () => {
    const before = projection(); const after = structuredClone(before); after.complete = false;
    expect(outcomePlanningProgress(before, after)).toBe('unknown'); expect(outcomePlanningBasis(after)).toBeNull();
    expect(outcomePlanningProgress({ ...before, sourceState: 'degraded' }, before)).toBe('unknown');
    after.complete = true; after.outcomes[0]!.scopeRevision++; expect(outcomePlanningProgress(before, after)).toBe('stale');
  });
});

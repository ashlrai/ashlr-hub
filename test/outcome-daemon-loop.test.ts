/** Real tick + protected outcome/Goal stores; only outward producer boundaries
 * and standing capability/config reads are deterministic offline seams. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const mocks = vi.hoisted(() => ({ config: vi.fn(), goal: vi.fn(), swarm: vi.fn(), bon: vi.fn(), backlog: vi.fn(), policy: vi.fn() }));
vi.mock('../src/core/config.js', async original => ({ ...await original<typeof import('../src/core/config.js')>(), loadConfig: (...args: unknown[]) => mocks.config(...args) }));
vi.mock('../src/core/daemon/activation-permit.js', async original => ({ ...await original<typeof import('../src/core/daemon/activation-permit.js')>(),
  consumeDaemonActivationPermit: () => ({ authorized: true, required: false, reason: 'offline fixture' }), isDaemonActivationCapability: () => true }));
vi.mock('../src/core/authority/effective-config.js', async original => ({ ...await original<typeof import('../src/core/authority/effective-config.js')>(), currentStandingPolicy: () => mocks.policy() }));
vi.mock('../src/core/fleet/quota.js', async original => ({ ...await original<typeof import('../src/core/fleet/quota.js')>(),
  withinLimit: () => true, recordUse: () => undefined, reserveFleetQuotaUse: () => ({ kind: 'unlimited', launchAuthorized: true, reservations: [] }),
  reserveFleetQuotaUses: () => ({ kind: 'unlimited', launchAuthorized: true, reservations: [] }) }));
vi.mock('../src/core/run/orchestrator.js', async original => ({ ...await original<typeof import('../src/core/run/orchestrator.js')>(), runGoal: (...args: unknown[]) => mocks.goal(...args) }));
vi.mock('../src/core/swarm/runner.js', () => ({ runSwarm: (...args: unknown[]) => mocks.swarm(...args) }));
vi.mock('../src/core/run/best-of-n.js', async original => ({ ...await original<typeof import('../src/core/run/best-of-n.js')>(), runBestOfN: (...args: unknown[]) => mocks.bon(...args) }));
vi.mock('../src/core/portfolio/backlog.js', async original => ({ ...await original<typeof import('../src/core/portfolio/backlog.js')>(), buildBacklog: (...args: unknown[]) => mocks.backlog(...args) }));
vi.mock('../src/core/fleet/automerge-pass.js', async original => ({ ...await original<typeof import('../src/core/fleet/automerge-pass.js')>(), runAutoMergePass: async () => ({ merged: 0, attempted: 0, judged: 0, judgePerPass: 0 }) }));
import { tick } from '../src/core/daemon/loop.js';
import { writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import { OutcomeManagerCoordinator } from '../src/core/goals/outcome-manager.js';
import { saveRun } from '../src/core/run/orchestrator.js';
import { prepareResourceNativeProfile, resolveNativeSeatLaunch } from '../src/core/resources/native-profile.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { outcomeDirectory, materializeOutcomeIntents } from '../src/core/goals/outcome-runtime.js';
import { scanGoals } from '../src/core/portfolio/scanners.js';
import { loadGoal } from '../src/core/goals/store.js';
import { createProposal, inboxDir, loadProposal } from '../src/core/inbox/store.js';
import { hashDiff, signLocalMergeIntent, signLocalRealizedMergeReceipt } from '../src/core/foundry/provenance.js';
import { mirrorPathFor, runInAutonomousLane } from '../src/core/fleet/mirrors.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { DEFAULT_TICK_HOOKS, type TickHooks } from '../src/core/daemon/tick-hooks.js';
import { savePlaybook, readPlaybookUses } from '../src/core/playbooks/store.js';
import { noteIdFor, knowledgePath, updateKnowledge, readKnowledgeHits } from '../src/core/learn/retro/store.js';
import type { KnowledgeNoteV1 } from '../src/core/learn/retro/types.js';
import { routingRequestFor, ROUTING_SESSION_OVERHEAD_TOKENS } from '../src/core/fleet/dispatch-router.js';
import { routeSeat } from '../src/core/routing/router.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { WorkItem } from '../src/core/types.js';
import type { AshlrConfig, EngineId, RunState, ProposalLocalMergeIntent } from '../src/core/types.js';
import type { DaemonActivationCapability } from '../src/core/daemon/activation-permit.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
let fx: H1Fixture;
const STANDING = { kind: 'resident-standing', permitId: 'fixture' } as unknown as DaemonActivationCapability;
beforeEach(() => {
  fx = makeFixture(); Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.policy.mockReturnValue({ switch: 'autonomous', repos: [{ nameWithOwner: 'fixture/outcome' }] });
  mocks.goal.mockImplementation(async (goal, _cfg, opts) => run(opts.runId, opts.engine, goal));
  mocks.swarm.mockImplementation(async ({ goal }, _cfg, opts) => ({ id: opts.runId, goal, status: 'done', result: '', usage: { totalTokens: 30, estCostUsd: 0, steps: 1 }, proposalOutcome: { kind: 'no-diff' } }));
  mocks.bon.mockRejectedValue(new Error('Unexpected BON contact'));
});
afterEach(() => { vi.restoreAllMocks(); fx.cleanup(); });
function run(id: string, engine: string, goal = ''): RunState {
  return { id, engine, goal, provider: 'offline', status: 'done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    tasks: [], steps: [], budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false }, usage: { tokensIn: 10, tokensOut: 20, steps: 1, estCostUsd: 0 }, proposalOutcome: { kind: 'no-diff', reason: 'fixture no diff' } };
}
async function fixture(engine: EngineId = 'codex') {
  const repo = fx.makeRepo(); repo.enroll();
  execFileSync('git', ['-C', repo.dir, 'remote', 'add', 'origin', 'https://github.com/fixture/outcome.git']);
  const cfg = makeCfg({ daemon: { dailyBudgetUsd: 1, perTickItems: 1, parallel: 1, intervalMs: 20 },
    foundry: { autonomyControlLoop: false, allowedBackends: [engine], goalPlanning: false } } as Partial<AshlrConfig>);
  mocks.config.mockReturnValue(cfg);
  const store = new OutcomeStore(outcomeDirectory('outcome')); const coordinator = new OutcomeCoordinator(store);
  let seq = 0; const command = () => ({ commandId: `fixture-${++seq}`, expectedRevision: store.read().state?.revision ?? 0 });
  const scope = { desiredOutcome: 'Ship actual useful work', targetRepos: [repo.dir], acceptance: ['Full global acceptance ' + 'x'.repeat(5000)] };
  expect(coordinator.start(command(), 'outcome', scope).ok).toBe(true);
  expect(coordinator.refinePlan(command(), { missionKey: 'outcome', title: 'Useful work', objective: scope.desiredOutcome, createdAt: '2026-10-02T00:00:00.000Z',
    nodes: [{ kind: 'work', key: 'a', title: 'Build A', objective: 'Implement A', deliverable: 'Verified A', riskClass: 'low', targetRepo: repo.dir, dependsOn: [], acceptance: ['A passes meaningful tests'] }] },
  { sourceState: 'healthy', complete: true, repos: [repo.dir] }).ok).toBe(true);
  expect(materializeOutcomeIntents('outcome', { stillAuthorized: () => true }).outcomes[0]?.status).toBe('linked');
  const node = () => store.read().state!.nodes[store.read().state!.activeNodeIds[0]!]!;
  const item = (await scanGoals(repo.dir, cfg))[0]!; expect(item).toBeDefined();
  mocks.backlog.mockImplementation(async (opts: { repos: string[] }) => ({ generatedAt: new Date().toISOString(), repos: opts.repos,
    items: (await Promise.all(opts.repos.map(path => scanGoals(path, cfg)))).flat() }));
  const hooks: TickHooks = { effectiveConfig: value => value, route: (value, config) => ({ ...DEFAULT_TICK_HOOKS.route(value, config), backend: engine,
    tier: engine === 'builtin' ? 'local' : 'frontier', model: null, hold: null, seatDecision: null }), seatAllows: () => ({ allowed: true, reason: 'offline seat' }),
    beforeTick: async () => ({ pausedRepos: [], laneCaps: { codex: 1, local: 1 }, holdProduction: null }), afterDispatch: async () => undefined, afterLanding: async () => undefined };
  const drive = () => tick(cfg, { dryRun: false, activationCapability: STANDING, hooks });
  return { repo, cfg, store, coordinator, command, scope, node, item, hooks, drive };
}
describe('durable outcomes through the real resident tick', () => {
  it('direct producer receives exact causal generation/full acceptance/current admission and ordinary failure history once', async () => {
    const f = await fixture();
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      const attempt = f.node().attempts.at(-1)!;
      expect(opts).toMatchObject({ runId: attempt.runId, workItemId: f.item.id, workItemGenerationId: attempt.generationId, cwd: f.repo.dir });
      expect(goal).toContain(f.scope.acceptance[0]); expect(goal).toContain('A passes meaningful tests');
      expect(opts.selectedOutcomeAdmission()).toBe(true);
      expect(loadGoal(f.node().materialization.goalId)?.outcome?.nodeId).toBe(f.node().id);
      return run(opts.runId, opts.engine, goal);
    });
    const first = await f.drive(); expect(first.reason).toBe('ok'); expect(mocks.goal).toHaveBeenCalledTimes(1);
    expect(f.node().attempts).toHaveLength(1); expect(f.node().attempts[0]).toMatchObject({ state: 'failed', proposalId: null });
    mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [f.repo.dir], items: [f.item] });
    await f.drive(); expect(mocks.goal).toHaveBeenCalledTimes(1); expect(f.node().attempts).toHaveLength(1); expect(f.coordinator.project().complete).toBe(false);
  });
  it('passes the original routed Codex identity and refuses same-seat replacement in its live host binding', async () => {
    const f = await fixture();
    const hint = 'a'.repeat(64),seatId = 'codex-original';
    const capacity = (accountHint:string) => ({seatId,engine:'codex' as const,label:'Offline Codex',free:false,windows:[],
      signedOut:false,reachable:null,contextWindow:256000,observedAt:new Date().toISOString(),spentTodayUsd:null,accountHint});
    writeCapacitySnapshot([capacity(hint)]);
    f.hooks.route = () => ({backend:'codex',tier:'frontier',model:null,hold:null,reason:'original offline route',selectedAccountHint:hint,
      seatDecision:{seatId,candidates:[seatId],exclusions:[],why:'offline',summary:'offline',mode:'balanced'}});
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      expect(opts.selectedCodexAccount.accountHint).toBe(hint);
      expect(opts.selectedCodexAccount.admitted()).toBe(true);
      writeCapacitySnapshot([capacity('b'.repeat(64))]);
      expect(opts.selectedCodexAccount.accountHint).toBe(hint);
      expect(opts.selectedCodexAccount.admitted()).toBe(false);
      return run(opts.runId,opts.engine,goal);
    });
    await f.drive();expect(mocks.goal).toHaveBeenCalledTimes(1);
    expect(f.node().attempts[0]).toMatchObject({state:'failed',proposalId:null});
  });
  it('builtin producer receives the same exact generation/full prompt and selected admission', async () => {
    const f = await fixture('builtin');
    mocks.swarm.mockImplementation(async ({ goal }, _cfg, opts) => {
      expect(goal).toContain(f.scope.acceptance[0]); expect(opts.workItemGenerationId).toBe(f.node().attempts[0]?.generationId);
      expect(opts.selectedOutcomeAdmission()).toBe(true);
      return { id: opts.runId, goal, status: 'done', result: '', usage: { totalTokens: 30, estCostUsd: 0, steps: 1 }, proposalOutcome: { kind: 'no-diff' } };
    });
    await f.drive(); expect(mocks.swarm).toHaveBeenCalledTimes(1); expect(mocks.goal).not.toHaveBeenCalled();
    expect(f.node().attempts[0]).toMatchObject({ state: 'failed', proposalId: null });
  });
  it.each(['paused', 'retired'] as const)('refuses a stale %s queued item before any producer', async state => {
    const f = await fixture();
    if (state === 'paused') expect(f.coordinator.setPaused(f.command(), true).ok).toBe(true);
    else expect(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['Revised scope'] }).ok).toBe(true);
    mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [f.repo.dir], items: [f.item] });
    const result = await f.drive(); expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.swarm).not.toHaveBeenCalled();
    expect(result.dispatches?.some(dispatch => dispatch.skipReason === 'outcome-unavailable')).toBe(true);
  });
  it('pause while the ordinary producer waits aborts its actual signal and preserves aborted history', async () => {
    const f = await fixture(); let admission: (() => boolean) | undefined;
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      admission = opts.selectedOutcomeAdmission;
      expect(f.coordinator.setPaused(f.command(), true).ok).toBe(true); expect(admission?.()).toBe(false);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Pause watcher did not abort producer')), 4000);
        opts.signal.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
      return { ...run(opts.runId, opts.engine, goal), status: 'aborted', proposalOutcome: undefined, terminationReason: 'cancelled', result: 'cancelled' };
    });
    await f.drive(); expect(mocks.goal).toHaveBeenCalledTimes(1); expect(admission?.()).toBe(false);
    expect(f.node().attempts[0]).toMatchObject({ state: 'aborted', proposalId: null }); expect(f.coordinator.project().complete).toBe(false);
  });
  it('rechecks enrollment before contact in a mirror and holds a removed execution repo', async () => {
    const f = await fixture();
    const mirror = mirrorPathFor('fixture/outcome'); mkdirSync(dirname(mirror), { recursive: true });
    execFileSync('git', ['clone', '--local', f.repo.dir, mirror], { stdio: 'pipe' });
    execFileSync('git', ['-C', mirror, 'remote', 'set-url', 'origin', 'https://github.com/fixture/outcome.git']); enroll(mirror);
    const mirrorItem = (await scanGoals(mirror, f.cfg))[0]!; expect(mirrorItem).toBeDefined();
    mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [mirror], items: [mirrorItem] });
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      expect(opts.cwd).toBe(mirror); expect(opts.selectedOutcomeAdmission()).toBe(true);
      unenroll(mirror); expect(opts.selectedOutcomeAdmission()).toBe(false); return run(opts.runId, opts.engine, goal);
    });
    await f.drive(); expect(mocks.goal).toHaveBeenCalledTimes(1);
    expect(f.node().attempts[0]?.executionRepo).toBe(mirror); expect(f.coordinator.project().complete).toBe(false);
  });
  it('registers every BON candidate before contact and joins its protected selected winner, preserving controller identity', async () => {
    const f = await fixture(); Object.assign(f.hooks, { bestOfNPlan: () => ({ run: true, candidates: [{ engine: 'codex' }, { engine: 'codex' }] }) });
    let winnerId = '';
    mocks.bon.mockImplementation(async (_item, _cfg, opts) => {
      expect(opts.goal).toContain(f.scope.acceptance[0]);
      expect(opts.goal).toContain('A passes meaningful tests');
      winnerId = `${opts.attemptId}-candidate-1`;
      const loser = `${opts.attemptId}-candidate-0`;
      expect(opts.beforeCandidateProviderDispatch('codex', loser)).toBe(true);
      expect(opts.beforeCandidateProviderDispatch('codex', winnerId)).toBe(true);
      expect(f.node().attempts[0]?.providerRunIds).toEqual([opts.attemptId, loser, winnerId]);
      expect(opts.providerDispatchStillAuthorized()).toBe(true);
      const proposal = createProposal({ repo: f.repo.dir, origin: 'agent', kind: 'patch', title: 'Candidate A', summary: 'Offline selected candidate',
        diff: '', runId: winnerId, workItemId: f.item.id, workItemGenerationId: opts.workItemGenerationId, trajectoryId: `run:${winnerId}`, producerStatus: 'done' });
      expect(loadProposal(proposal.id)?.runId).toBe(winnerId);
      const state = { ...run(winnerId, 'codex'), proposalOutcome: { kind: 'filed' as const, reason: 'Offline filed', proposalId: proposal.id } };
      const candidate = (id: string) => ({ engine: 'codex', runId: id, providerDispatchAttempted: true, outcome: 'done', state: id === winnerId ? state : run(id, 'codex') });
      return { candidates: [candidate(loser), candidate(winnerId)], winner: { ...candidate(winnerId), proposalId: proposal.id, trajectoryId: `run:${winnerId}` }, critique: { billableCostUsd: 0 } };
    });
    await f.drive(); expect(mocks.bon).toHaveBeenCalledTimes(1); expect(mocks.goal).not.toHaveBeenCalled();
    expect(f.node().attempts[0]).toMatchObject({ state: 'proposed', terminalRunId: winnerId });
    expect(f.node().attempts[0]?.runId).not.toBe(winnerId); expect(f.coordinator.project().complete).toBe(false);
  });
  it('preserves an interrupted running claim as unknown and never relaunches from a stale queued candidate', async () => {
    const f = await fixture(); const node = f.node();
    expect(f.coordinator.claimReady(f.command(), node.id, f.repo.dir, { stillAuthorized: () => true, executionRepoAllowed: (a, b) => a === b }).ok).toBe(true);
    const attempt = f.node().attempts[0]!;
    expect(f.coordinator.joinRun(f.command(), node.id, attempt.id, 'interrupted').ok).toBe(true);
    mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [f.repo.dir], items: [f.item] });
    await f.drive(); expect(mocks.goal).not.toHaveBeenCalled(); expect(f.node().attempts).toHaveLength(1);
    expect(f.node().attempts[0]).toMatchObject({ state: 'running', runId: 'interrupted', terminalRunId: null });
  });
  it('ignores computedAt observation jitter but refuses changed effective standing policy before further contact', async () => {
    const f = await fixture();
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      expect(opts.selectedOutcomeAdmission()).toBe(true);
      mocks.policy.mockReturnValue({ switch: 'autonomous', repos: [{ nameWithOwner: 'fixture/outcome' }], computedAt: 'later-observation' });
      expect(opts.selectedOutcomeAdmission()).toBe(true);
      mocks.policy.mockReturnValue({ switch: 'off', repos: [{ nameWithOwner: 'fixture/outcome' }], computedAt: 'later-observation' });
      expect(opts.selectedOutcomeAdmission()).toBe(false);
      return run(opts.runId, opts.engine, goal);
    });
    await f.drive(); expect(mocks.goal).toHaveBeenCalledTimes(1); expect(f.coordinator.project().complete).toBe(false);
  });
  it('on a later tick joins only an authenticated persisted merge witness, never producer done or an applied flag', async () => {
    const f = await fixture(); let proposalId = '';
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      const proposal = createProposal({ repo: f.repo.dir, origin: 'agent', kind: 'patch', title: 'Verified A', summary: 'Offline receipt join',
        runId: opts.runId, workItemId: f.item.id, workItemGenerationId: opts.workItemGenerationId, trajectoryId: `run:${opts.runId}`, producerStatus: 'done' });
      proposalId = proposal.id;
      return { ...run(opts.runId, opts.engine, goal), proposalOutcome: { kind: 'filed', reason: 'Offline proposal', proposalId } };
    });
    await f.drive(); expect(f.node().attempts[0]?.state).toBe('proposed'); expect(f.coordinator.project().complete).toBe(false);
    const proposal = loadProposal(proposalId)!; expect(proposal).not.toBeNull();
    // Signed synthetic fixture receipts exercise the actual offline HMAC verifier.
    // This is not a Git merge or production completion claim.
    proposal.status = 'applied'; proposal.diffHash = hashDiff('test-only diff');
    proposal.verifyResult = { passed: true, baseHead: '1'.repeat(40), diffHash: proposal.diffHash } as typeof proposal.verifyResult;
    writeFileSync(join(inboxDir(), `${proposal.id}.json`), JSON.stringify(proposal), { mode: 0o600 });
    await f.drive(); expect(f.coordinator.project().complete).toBe(false); expect(mocks.goal).toHaveBeenCalledTimes(1);
    const at = '2026-01-01T00:00:00.000Z';
    const intent: Omit<ProposalLocalMergeIntent, 'attestation'> = { schemaVersion: 1, branch: 'test/merge', base: 'main', baseBeforeOid: '1'.repeat(40),
      proposalHeadOid: '2'.repeat(40), diffHash: proposal.diffHash, evidencePackDigest: '4'.repeat(64), authorizationId: '5'.repeat(32), authorizedAt: at };
    const intentAttestation = signLocalMergeIntent(proposal.id, f.repo.dir, intent);
    proposal.localMergeIntent = { ...intent, attestation: intentAttestation };
    const witness = { schemaVersion: 1 as const, source: 'local-default-branch' as const, base: 'main', baseBeforeOid: intent.baseBeforeOid,
      proposalHeadOid: intent.proposalHeadOid, mergeCommitOid: '3'.repeat(40), observedAt: at, proposalId: proposal.id, diffHash: proposal.diffHash, intentAttestation };
    proposal.realizedMerge = { ...witness, attestation: signLocalRealizedMergeReceipt(proposal.id, f.repo.dir, witness) };
    writeFileSync(join(inboxDir(), `${proposal.id}.json`), JSON.stringify(proposal), { mode: 0o600 });
    await f.drive(); expect(f.coordinator.project().complete).toBe(true);
    expect(f.node().completion?.mergeIdentity).toContain('3'.repeat(40)); expect(mocks.goal).toHaveBeenCalledTimes(1);
  });
});


// The real prepared native launch contract requires the same execve-capable
// platforms as resource-native-profile.test.ts; ordinary daemon cases stay portable.
describe.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')('tool-capable shared manager through the real resident tick', () => {
  async function managerFixture() {
    const f = await fixture();
    await f.drive(); // The ordinary no-diff worker remains a failure, never completed work.
    const manager = new OutcomeManagerCoordinator(f.store);
    const admission = { stillAuthorized: () => true, executionRepoAllowed: (target: string, execution: string) => target === execution,
      routeAllowed: () => true, routeCurrent: () => true, sessionAllowed: () => false, messageExists: () => false, planAllowed: () => true };
    expect(manager.configure(f.command(), { mode: 'resident', sessionId: null }, admission).ok).toBe(true);
    expect(manager.project().next?.intent).toBe('replan');
    mocks.policy.mockReturnValue({ switch: 'autonomous', repos: [{ nameWithOwner: 'fixture/outcome', maxRisk: 'medium' }],
      engines: ['codex'], spend: { seats: { 'codex-personal': { enabled: true, roles: ['producer'] } } } });
    f.hooks.route = () => ({ backend: 'codex', tier: 'frontier', model: 'frontier-test', hold: null, reason: 'offline exact manager route', selectedAccountHint:'c'.repeat(64),
      seatDecision: { seatId: 'codex-personal', candidates: ['codex-personal'], exclusions: [], why: 'offline', summary: 'offline', mode: 'balanced' } });
    f.cfg.foundry = { ...f.cfg.foundry, allowedBackends: ['codex'], bestOfN: 3, models: { ...f.cfg.foundry?.models, codex: 'frontier-test' } };
    const profiles = join(fx.ashlrDir, 'native-profiles'); mkdirSync(profiles, { recursive: true, mode: 0o700 });
    const executable = join(fx.home, 'inert-native'); writeFileSync(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const profile = prepareResourceNativeProfile({ provider: 'codex', directory: join(profiles, 'codex-personal'), executable });
    const accountsRoot = join(fx.ashlrDir, 'account-connections'); mkdirSync(accountsRoot, { mode: 0o700 });
    writeFileSync(join(accountsRoot, 'connections.json'), JSON.stringify({ schemaVersion: 1, accounts: [
      { id: 'codex-personal', provider: 'codex', command: profile.command },
    ] }), { mode: 0o600 });
    f.cfg.verse = { ...f.cfg.verse, accountsRoot };
    writeCapacitySnapshot([{seatId:'codex-personal',engine:'codex',label:'Offline Manager',free:false,windows:[],
      signedOut:false,reachable:null,contextWindow:256000,observedAt:new Date().toISOString(),spentTodayUsd:null,accountHint:'c'.repeat(64)}]);
    expect(resolveNativeSeatLaunch({ accountsRoot, provider: 'codex', seatId: 'codex-personal' }).ok).toBe(true);
    mocks.goal.mockClear();
    return { ...f, manager, profile, accountsRoot, admission };
  }
  const managerText = () => '<phantom-manager-result>' + JSON.stringify({ kind: 'plan', title: 'Recover actual useful work', nodes: [{
    key: 'recover', title: 'Recover useful implementation', objective: 'Implement actual fix', deliverable: 'Verified code',
    riskClass: 'low', targetRepo: 'target-1', dependsOn: [], acceptance: ['A meaningful regression passes'],
  }] }) + '</phantom-manager-result>';
  function managerRun(id: string, goal = ''): RunState {
    return { ...run(id, 'codex', goal), result: managerText(), engineModel: 'codex:frontier-test', engineTier: 'frontier',
      trajectoryId: `run:${id}`, proposalOutcome: { kind: 'empty-diff', reason: 'Actual manager plan has no code diff' } };
  }
  function savedTerminal(f: Awaited<ReturnType<typeof managerFixture>>) {
    const next = f.manager.project().next!;
    const route = { engine: 'codex', seatId: 'codex-personal', model: 'frontier-test', tier: 'frontier' as const };
    expect(f.manager.claimRun(f.command(), next, f.repo.dir, route, 'saved-manager', f.admission).ok).toBe(true);
    saveRun(managerRun('saved-manager'));
    expect(f.store.read().state!.manager!.stages.at(-1)?.state).toBe('running');
    // Terminal metadata is not another contact; the exhausted live gate stays shut.
    const contact = vi.fn(() => ({ allowed: false, reason: 'Subscription window is exhausted' }));
    f.hooks.seatAllows = contact;
    return contact;
  }
  it('launches one exact native frontier manager with tools and applies its saved plan without completing work', async () => {
    const f = await managerFixture();
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      const stage = f.store.read().state!.manager!.stages.at(-1)!;
      expect(opts).toMatchObject({ engine: 'codex', seatId: 'codex-personal', model: 'frontier-test', tools: true,
        sandboxEngine: true, requireSandbox: true, workItemId: stage.workItemId, workItemGenerationId: stage.generationId });
      expect(opts.selectedOutcomeAdmission()).toBe(true);
      expect(opts.selectedCodexAccount.accountHint).toBe('c'.repeat(64));
      expect(opts.selectedCodexAccount.admitted()).toBe(true);
      expect(stage.route).toEqual({ engine: 'codex', seatId: 'codex-personal', model: 'frontier-test', tier: 'frontier' });
      expect(goal).toContain('tool-capable manager');
      const result = managerRun(opts.runId, goal);
      saveRun(result); return result;
    });
    await f.drive();
    expect(mocks.goal).toHaveBeenCalledTimes(1); expect(mocks.bon).not.toHaveBeenCalled(); expect(mocks.swarm).not.toHaveBeenCalled();
    const state = f.store.read().state!;
    expect(state.manager!.stages.at(-1)).toMatchObject({ state: 'succeeded', resultKind: 'plan-applied' });
    expect(state.nodes[state.activeNodeIds[0]!]!.basis.definition.key).toBe('recover');
    expect(state.nodes[state.activeNodeIds[0]!]!.completion).toBeNull();
    expect(state.nodes[state.activeNodeIds[0]!]!.attempts).toEqual([]);
  });
  it.each(['codex', 'local-coder'] as const)('plans with %s from the admitted mirror inside the real autonomous lane without changing the saved target', async engine => {
    const f = await managerFixture();
    const model = engine === 'codex' ? 'frontier-test' : 'qualified-local-model';
    const tier = engine === 'codex' ? 'frontier' : 'mid';
    if (engine === 'local-coder') {
      f.cfg.foundry = { ...f.cfg.foundry, allowedBackends: [engine], models: { [engine]: model } };
      mocks.policy.mockReturnValue({ switch: 'autonomous', repos: [{ nameWithOwner: 'fixture/outcome', maxRisk: 'medium' }],
        engines: ['local'], spend: { seats: { local: { enabled: true, roles: ['producer'] } } } });
      f.hooks.route = () => ({ backend: engine, tier, model, hold: null, reason: 'offline exact local manager route',
        seatDecision: { seatId: 'local', candidates: ['local'], exclusions: [], why: 'offline', summary: 'offline', mode: 'balanced' } });
    }
    const mirror = mirrorPathFor('fixture/outcome'); mkdirSync(dirname(mirror), { recursive: true });
    execFileSync('git', ['clone', '--local', f.repo.dir, mirror], { stdio: 'pipe' });
    execFileSync('git', ['-C', mirror, 'remote', 'set-url', 'origin', 'https://github.com/fixture/outcome.git']);
    enroll(mirror);
    const originalScope = JSON.stringify(f.store.read().state!.scope);
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      const stage = f.store.read().state!.manager!.stages.at(-1)!;
      expect(opts.cwd).toBe(mirror); expect(stage.executionRepo).toBe(mirror);
      expect(opts.selectedOutcomeAdmission()).toBe(true);
      expect(JSON.stringify(f.store.read().state!.scope)).toBe(originalScope);
      const result = { ...managerRun(opts.runId, goal), engine, engineModel: `${engine}:${model}`, engineTier: tier } as RunState;
      saveRun(result); return result;
    });
    const result = await runInAutonomousLane(f.drive);
    expect(result.dispatches?.find(dispatch => dispatch.itemId.startsWith('outcome-manager:'))).toMatchObject({
      dispatched: true, backend: engine, production: { outcome: 'empty-diff' },
    });
    expect(mocks.goal).toHaveBeenCalledTimes(1);
    expect(f.store.read().state!.manager!.stages.at(-1)).toMatchObject({ executionRepo: mirror, state: 'succeeded', resultKind: 'plan-applied' });
    expect(JSON.stringify(f.store.read().state!.scope)).toBe(originalScope);
    expect(f.coordinator.project().complete).toBe(false);
  });

  it('does not invent an execution workspace from a foreign enrolled mirror', async () => {
    const f = await managerFixture(); const mirror = mirrorPathFor('fixture/foreign');
    mkdirSync(dirname(mirror), { recursive: true });
    execFileSync('git', ['clone', '--local', f.repo.dir, mirror], { stdio: 'pipe' });
    execFileSync('git', ['-C', mirror, 'remote', 'set-url', 'origin', 'https://github.com/fixture/foreign.git']);
    enroll(mirror); mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [mirror], items: [] });
    const scope = JSON.stringify(f.store.read().state!.scope);
    await runInAutonomousLane(f.drive);
    expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.bon).not.toHaveBeenCalled();
    expect(f.store.read().state!.manager!.stages).toEqual([]);
    expect(JSON.stringify(f.store.read().state!.scope)).toBe(scope);
    expect(f.manager.project().next).not.toBeNull();
  });

  it.each(['enrollment', 'grant', 'Stop'] as const)('refuses %s withdrawn after mirror selection without contacting the Manager', async kind => {
    const f = await managerFixture(); const mirror = mirrorPathFor('fixture/outcome');
    mkdirSync(dirname(mirror), { recursive: true });
    execFileSync('git', ['clone', '--local', f.repo.dir, mirror], { stdio: 'pipe' });
    execFileSync('git', ['-C', mirror, 'remote', 'set-url', 'origin', 'https://github.com/fixture/outcome.git']);
    enroll(mirror); mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [mirror], items: [] });
    const route = f.hooks.route; let changed = false;
    f.hooks.route = (item, cfg) => {
      const selected = route(item, cfg);
      if (!changed && item.id.startsWith('outcome-manager:')) {
        changed = true;
        if (kind === 'enrollment') unenroll(mirror);
        else if (kind === 'grant') mocks.policy.mockReturnValue(null);
        else setKill(true);
      }
      return selected;
    };
    const scope = JSON.stringify(f.store.read().state!.scope);
    await runInAutonomousLane(f.drive);
    expect(changed).toBe(true); expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.bon).not.toHaveBeenCalled();
    expect(f.store.read().state!.manager!.stages).toEqual([]);
    expect(JSON.stringify(f.store.read().state!.scope)).toBe(scope);
  });

  it('routes a real Manager prompt and guidance inside a 64k window while preserving private scope and effort', async () => {
    const f = await managerFixture(); const nativeRoute = f.hooks.route; const note = await managerGuidance();
    const guidance = 'Inspect the named file before editing. ' + 'g'.repeat(2000);
    Object.assign(f.hooks, { dispatchHarness: () => ({ versionId: 'saved-harness', producerPrompt: guidance }) });
    let routedItem: WorkItem | undefined;
    f.hooks.route = (item, config) => {
      routedItem = item;
      const request = routingRequestFor(item);
      const policy = defaultBudgetPolicy();
      policy.seats['codex-personal'] = { seatId: 'codex-personal', enabled: true, reservePercent: 0 };
      const decision = routeSeat(request, [{ seatId: 'codex-personal', engine: 'codex', label: 'Offline native', free: false,
        windows: [{ id: 'primary', usedPercent: 0, resetsAt: null, resetDescription: null, limitReached: false }],
        signedOut: false, reachable: true, contextWindow: 65536, observedAt: new Date().toISOString(), spentTodayUsd: null }],
        policy, { nowMs: Date.now() });
      expect(decision.seatId).toBe('codex-personal');
      return nativeRoute(item, config);
    };
    mocks.goal.mockImplementation(async (goal, _cfg, opts) => {
      expect(routedItem?.effort).toBe(5);
      expect(goal).toContain(f.scope.acceptance[0]); expect(goal).toContain(guidance);
      expect(goal).toContain(note.text); expect(goal).toContain('Keep original scope.');
      expect(routingRequestFor(routedItem!).contextTokens).toBe(Math.ceil(goal.length / 4) + ROUTING_SESSION_OVERHEAD_TOKENS);
      expect(routingRequestFor({ ...routedItem!, tags: routedItem!.tags.filter(tag => !tag.startsWith('context:')) }).contextTokens).toBeGreaterThan(65536);
      expect(JSON.stringify(routedItem)).not.toContain(f.scope.acceptance[0]); expect(JSON.stringify(routedItem)).not.toContain(guidance);
      expect(opts.selectedOutcomeAdmission()).toBe(true);
      const result = managerRun(opts.runId, goal); saveRun(result); return result;
    });
    await f.drive(); expect(mocks.goal).toHaveBeenCalledTimes(1);
    expect(f.store.read().state!.manager!.stages.at(-1)?.state).toBe('succeeded');
    await vi.waitFor(async () => {
      expect([...await readPlaybookUses()].map(([, use]) => use.ref.id)).toEqual(['aaa-manager-guidance']);
      expect((await readKnowledgeHits()).get(note.id)?.hits).toBe(1);
    });
  });
  async function managerGuidance() {
    expect((await savePlaybook([
      '---', 'id: aaa-manager-guidance', 'name: Manager guidance', 'macro: !aaa-manager-guidance',
      'description: Keep manager plans grounded.', 'kinds: [other]', 'repos: []', 'globs: []', 'auto: true',
      'done-when:', '  - The plan retains acceptance.', '---', '', '## Outcome', '', 'Keep original scope.',
      '', '## Procedure', '', '1. Read the named file.', '',
    ].join('\n'))).ok).toBe(true);
    const scope = { repo: null, pathGlobs: [], taskKinds: [] };
    const text = 'Use causal run evidence to replan the unfinished outcome.';
    const note: KnowledgeNoteV1 = { v: 1, id: noteIdFor(text, scope), text, scope, status: 'approved',
      retroId: null, source: 'mason', createdAt: '2026-10-02T00:00:00.000Z', decidedAt: '2026-10-02T00:00:00.000Z',
      edited: false, hits: 0, lastHitAt: null, seen: 1, agentsMdTaskId: null };
    await updateKnowledge(() => ({ notes: [note], result: undefined }));
    expect((await readPlaybookUses()).size).toBe(0);
    expect((await readKnowledgeHits()).size).toBe(0);
    return note;
  }
  it('refuses changed guidance after routing without creating a Manager stage or contacting its provider', async () => {
    const f = await managerFixture(); await managerGuidance();
    let guidance = 'Original adopted guidance';
    Object.assign(f.hooks, { dispatchHarness: () => ({ versionId: 'saved-harness', producerPrompt: guidance }) });
    // The live allowance recheck is after route selection and before execution
    // assembly. A concurrent guidance edit here must remain a refused preview.
    f.hooks.seatAllows = (_engine, options) => {
      if (options?.itemId?.startsWith('outcome-manager:')) guidance = 'Changed guidance ' + 'g'.repeat(3000);
      return { allowed: true, reason: 'offline native allowance' };
    };
    await f.drive(); expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.bon).not.toHaveBeenCalled();
    expect(f.store.read().state!.manager!.stages).toEqual([]);
    expect(f.manager.project().next).not.toBeNull();
    expect((await readPlaybookUses()).size).toBe(0);
    expect((await readKnowledgeHits()).size).toBe(0);
  });
  it('refuses a replaced knowledge identity even when its rendered guidance is unchanged', async () => {
    const f = await managerFixture(); const note = await managerGuidance(); const nativeRoute = f.hooks.route;
    f.hooks.route = (item, config) => {
      const route = nativeRoute(item, config);
      writeFileSync(knowledgePath(), JSON.stringify({ v: 1, notes: [{ ...note, id: 'kn_0123456789abcdef' }] }), { mode: 0o600 });
      return route;
    };
    await f.drive();
    expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.bon).not.toHaveBeenCalled();
    expect(f.store.read().state!.manager!.stages).toEqual([]);
    expect((await readPlaybookUses()).size).toBe(0);
    expect((await readKnowledgeHits()).size).toBe(0);
  });
  it('refuses a revised saved outcome after discovery rather than using its earlier forecast', async () => {
    const f = await managerFixture(); const nativeRoute = f.hooks.route; let edited = false;
    f.hooks.route = (item, config) => {
      const route = nativeRoute(item, config);
      if (!edited) {
        edited = true;
        expect(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['Revised full acceptance ' + 'x'.repeat(90000)] }).ok).toBe(true);
      }
      return route;
    };
    await f.drive(); expect(edited).toBe(true); expect(mocks.goal).not.toHaveBeenCalled();
    expect(f.store.read().state!.manager!.stages).toEqual([]);
    expect(f.store.read().state!.scope.acceptance[0]).toContain('Revised full acceptance');
  });
  it('does not contact a manager provider when selected account allowance is unavailable', async () => {
    const f = await managerFixture(); f.hooks.seatAllows = () => ({ allowed: false, reason: 'Subscription window is exhausted' });
    await f.drive(); expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.bon).not.toHaveBeenCalled();
    expect(f.store.read().state!.manager!.stages).toEqual([]);
  });
  it('recovers a saved real terminal plan after usage is depleted without another provider contact', async () => {
    const f = await managerFixture(); savedTerminal(f);
    await f.drive();
    expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.bon).not.toHaveBeenCalled(); expect(mocks.swarm).not.toHaveBeenCalled();
    const state = f.store.read().state!;
    expect(state.manager!.stages.at(-1)).toMatchObject({ state: 'succeeded', resultKind: 'plan-applied', terminalRunId: 'saved-manager' });
    expect(state.nodes[state.activeNodeIds[0]!]!.basis.definition.key).toBe('recover');
    expect(state.nodes[state.activeNodeIds[0]!]!.completion).toBeNull();
  });
  it('retains a removed-profile terminal as stale without applying its saved plan', async () => {
    const f = await managerFixture(); savedTerminal(f); const before = f.store.read().state!;
    rmSync(f.profile.directory, { recursive: true });
    expect(resolveNativeSeatLaunch({ accountsRoot: f.accountsRoot, provider: 'codex', seatId: 'codex-personal' }).ok).toBe(false);
    await f.drive();
    expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.bon).not.toHaveBeenCalled(); expect(mocks.swarm).not.toHaveBeenCalled();
    const state = f.store.read().state!;
    expect(state.manager!.stages.at(-1)).toMatchObject({ state: 'stale', resultKind: null, terminalRunId: 'saved-manager' });
    expect(state.graphDigest).toBe(before.graphDigest); expect(state.activeNodeIds).toEqual(before.activeNodeIds);
  });
  it('retains a disabled-engine terminal as stale even when its native profile still exists', async () => {
    const f = await managerFixture(); savedTerminal(f); const before = f.store.read().state!;
    f.cfg.foundry = { ...f.cfg.foundry, allowedBackends: ['builtin'] };
    expect(resolveNativeSeatLaunch({ accountsRoot: f.accountsRoot, provider: 'codex', seatId: 'codex-personal' }).ok).toBe(true);
    await f.drive(); expect(mocks.goal).not.toHaveBeenCalled();
    const state = f.store.read().state!;
    expect(state.manager!.stages.at(-1)).toMatchObject({ state: 'stale', resultKind: null, terminalRunId: 'saved-manager' });
    expect(state.graphDigest).toBe(before.graphDigest); expect(state.activeNodeIds).toEqual(before.activeNodeIds);
  });
  it('does not replace a frontier manager with a local execution fallback', async () => {
    const f = await managerFixture(); f.hooks.route = () => ({ backend: 'builtin', tier: 'local', model: null, hold: null,
      reason: 'offline local route', seatDecision: null });
    await f.drive(); expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.swarm).not.toHaveBeenCalled();
    expect(f.store.read().state!.manager!.stages).toEqual([]);
  });
});

/** Real tick + protected outcome/Goal stores; only outward producer boundaries
 * and standing capability/config reads are deterministic offline seams. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { outcomeDirectory, materializeOutcomeIntents } from '../src/core/goals/outcome-runtime.js';
import { scanGoals } from '../src/core/portfolio/scanners.js';
import { loadGoal } from '../src/core/goals/store.js';
import { createProposal, inboxDir, loadProposal } from '../src/core/inbox/store.js';
import { hashDiff, signLocalMergeIntent, signLocalRealizedMergeReceipt } from '../src/core/foundry/provenance.js';
import { mirrorPathFor } from '../src/core/fleet/mirrors.js';
import { enroll, unenroll } from '../src/core/sandbox/policy.js';
import { DEFAULT_TICK_HOOKS, type TickHooks } from '../src/core/daemon/tick-hooks.js';
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

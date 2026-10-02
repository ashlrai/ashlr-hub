import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const planner = vi.hoisted(() => vi.fn());
vi.mock('../src/core/strategy/goal-planner.js', () => ({ expandGoalToMilestones: planner }));
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';
import { outcomeDirectory, materializeOutcomeIntents, readOutcomeGoalForScan, readOutcomeWorkItemContext,
  outcomeGoalBinding } from '../src/core/goals/outcome-runtime.js';
import { createGoalIfAbsent, createOutcomeGoalIfAbsent, goalsDir, isValidGoalRecord, loadGoal, saveGoal } from '../src/core/goals/store.js';
import { scanGoals } from '../src/core/portfolio/scanners.js';
import { isStrictWorkItem } from '../src/core/portfolio/queued-autonomy.js';
import type { MissionGraphInput } from '../src/core/vision/mission-graph.js';
import type { GoalOutcomeBindingV1 } from '../src/core/types.js';
import { outcomeDigest, outcomeGraphObjective, type OutcomeWrite } from '../src/core/goals/outcome-types.js';

const roots: string[] = []; const files: string[] = []; let index = 0;
afterEach(() => { vi.restoreAllMocks(); planner.mockReset(); for (const path of files.splice(0)) rmSync(path, { force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function assertOk(value: OutcomeWrite) { if (!value.ok) throw new Error(value.reason); return value.state; }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'outcome-runtime-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const id = `outcome-test-${++index}`; const directory = outcomeDirectory(id); roots.push(directory);
  const store = new OutcomeStore(directory); const coordinator = new OutcomeCoordinator(store);
  const scope = { desiredOutcome: 'Ship verified useful work', targetRepos: [repo], acceptance: ['Useful change verified and merged'] };
  let seq = 0; const command = () => ({ commandId: `command-${++seq}`, expectedRevision: store.read().state?.revision ?? 0 });
  assertOk(coordinator.start(command(), id, scope));
  const plan: MissionGraphInput = { missionKey: id, title: 'Build outcome', objective: scope.desiredOutcome,
    createdAt: '2026-10-02T00:00:00.000Z', nodes: ['a', 'b'].map(key => ({ kind: 'work', key, title: `Build ${key}`,
      objective: `Implement ${key}`, deliverable: `Verified ${key}`, riskClass: 'low', targetRepo: repo,
      acceptance: [`Tests verify ${key}`], dependsOn: key === 'b' ? ['a'] : [] })) };
  const refine = () => assertOk(coordinator.refinePlan(command(), plan, { sourceState: 'healthy', complete: true, repos: [repo] }));
  refine();
  const state = () => store.read().state!;
  const node = (key = 'a') => state().nodes[state().activeNodeIds.find(nodeId => state().nodes[nodeId]!.basis.definition.key === key)!]!;
  const materialize = (stillAuthorized = () => true) => {
    const result = materializeOutcomeIntents(id, { stillAuthorized, now: '2026-10-02T00:00:00.000Z' });
    for (const entry of Object.values(state().nodes)) files.push(join(goalsDir(), `${entry.materialization.goalId}.json`));
    return result;
  };
  return { root, repo, id, directory, store, coordinator, scope, command, plan, refine, state, node, materialize };
}

describe('outcome Goal materialization and discovery', () => {
  it.each([5000, 20000])('materializes and discovers the full %s character saved scope independently of graph transport', async length => {
    const f = fixture(); const desiredOutcome = 'r'.repeat(length - 4) + 'TAIL';
    assertOk(f.coordinator.editScope(f.command(), { ...f.scope, desiredOutcome })); f.plan.objective = desiredOutcome; f.refine(); f.materialize();
    const items = await scanGoals(f.repo); expect(items).toHaveLength(1);
    const context = readOutcomeWorkItemContext(items[0]!);
    expect(context?.state.scope.desiredOutcome).toBe(desiredOutcome);
    expect(context?.state.graph!.objective).toBe(outcomeGraphObjective(f.state()));
    expect(context?.goal.outcome!.scopeDigest).toBe(outcomeDigest({ ...f.scope, desiredOutcome }));
    expect(context?.node.basis.scopeDigest).toBe(context?.state.scopeDigest);
  });
  it('atomically installs a concrete singleton milestone and detached immutable linkage', () => {
    const f = fixture(); expect(f.materialize().outcomes.map(row => row.status)).toEqual(['linked', 'linked']);
    const node = f.node(); const goal = loadGoal(node.materialization.goalId)!;
    expect(goal.status).toBe('active'); expect(goal.milestones).toHaveLength(1); expect(goal.milestones[0]!.status).toBe('pending');
    expect(goal.milestones[0]!.id).toBe(node.materialization.milestoneId);
    expect(goal.outcome).toEqual(outcomeGoalBinding(f.id, node)); expect(goal.outcome!.nodeBasisDigest).toBe(outcomeDigest(node.basis));
    expect(lstatSync(join(goalsDir(), `${goal.id}.json`)).mode & 0o777).toBe(0o600);
    expect(readdirSync(goalsDir()).some(name => name.includes('.create-'))).toBe(false);
    expect(f.materialize().outcomes).toEqual([]);
  });
  it('holds revoked authority without installing a Goal or acknowledging intent', () => {
    const f = fixture(); const node = f.node(); expect(f.materialize(() => false).outcomes.every(row => row.status === 'held')).toBe(true);
    expect(loadGoal(node.materialization.goalId)).toBeNull(); expect(f.node().materialization.state).toBe('intent');
  });
  it('recovers a crash between Goal creation and acknowledgment without resetting the concrete Goal', () => {
    const f = fixture(); const actual = f.coordinator.linkMaterialization;
    vi.spyOn(OutcomeCoordinator.prototype, 'linkMaterialization').mockReturnValue({ ok: false, reason: 'held' });
    expect(f.materialize().outcomes.every(row => row.status === 'held')).toBe(true);
    const goal = loadGoal(f.node().materialization.goalId)!; const before = readFileSync(join(goalsDir(), `${goal.id}.json`), 'utf8');
    expect(f.node().materialization.state).toBe('intent');
    vi.restoreAllMocks(); expect(OutcomeCoordinator.prototype.linkMaterialization).toBe(actual);
    expect(f.materialize().outcomes.every(row => row.status === 'linked')).toBe(true);
    expect(readFileSync(join(goalsDir(), `${goal.id}.json`), 'utf8')).toBe(before);
  });
  it('detects a conflicting existing Goal rather than overwriting it', () => {
    const f = fixture(); f.materialize(); const node = f.node(); const file = join(goalsDir(), `${node.materialization.goalId}.json`);
    const goal = loadGoal(node.materialization.goalId)!; goal.objective = 'Unrelated objective';
    writeFileSync(file, JSON.stringify(goal), { mode: 0o600 });
    // Recreate the intent acknowledgment seam without changing the old Goal: fresh
    // graph acceptance yields a new id, so this test checks explicit collision at the
    // pure create helper against the same immutable id.
    const result = createOutcomeGoalIfAbsent({ objective: node.basis.definition.objective, project: f.repo,
      mission: goal.mission!, outcome: goal.outcome!, milestone: { title: goal.milestones[0]!.title, detail: goal.milestones[0]!.detail } });
    expect(result.status).toBe('exists'); expect(result.goal.objective).toBe('Unrelated objective');
    expect(readOutcomeGoalForScan(result.goal, f.repo)).toBeNull();
  });
  it('never lazily invokes a planner for a corrupted zero-milestone outcome Goal', async () => {
    const f = fixture(); f.materialize(); const goal = loadGoal(f.node().materialization.goalId)!;
    goal.milestones = []; goal.status = 'planning'; writeFileSync(join(goalsDir(), `${goal.id}.json`), JSON.stringify(goal));
    expect(await scanGoals(f.repo, { foundry: { goalPlanning: true } })).toEqual([]); expect(planner).not.toHaveBeenCalled();
  });
  it('emits the actual canonical claim WorkItem id and no blocked dependency', async () => {
    const f = fixture(); f.materialize(); const items = await scanGoals(f.repo);
    expect(items).toHaveLength(1); const node = f.node(); const item = items[0]!;
    expect(item.id).toBe(`goal:${node.materialization.goalId}:${node.materialization.milestoneId}`);
    expect(item.id.length).toBeLessThanOrEqual(180); expect(isStrictWorkItem(item)).toBe(true);
    expect(item.tags).toContain('outcome'); expect(readOutcomeWorkItemContext(item)?.node.id).toBe(node.id);
    expect(readOutcomeWorkItemContext({ ...item, id: 'repo:goal:legacy-hash' })).toBeNull();
    expect(readOutcomeWorkItemContext({ ...item, repo: join(f.root, 'wrong') })).toBeNull();
    expect(planner).not.toHaveBeenCalled();
  });
  it('does not rediscover a claimed node while permitting exact context reload for its owner', async () => {
    const f = fixture(); f.materialize(); const item = (await scanGoals(f.repo))[0]!; const node = f.node();
    assertOk(f.coordinator.claimReady(f.command(), node.id, f.repo, { stillAuthorized: () => true, executionRepoAllowed: (a, b) => a === b }));
    expect(await scanGoals(f.repo)).toEqual([]); expect(readOutcomeWorkItemContext(item)?.node.id).toBe(node.id);
    const attempt = f.node().attempts.at(-1)!;
    expect(f.coordinator.inspectClaim(node.id, attempt.id, attempt.generationId,
      { stillAuthorized: () => true, executionRepoAllowed: (a, b) => a === b }).admitted).toBe(true);
  });
  it('holds paused and retired outcome nodes even when their local Goal remains active', async () => {
    const f = fixture(); f.materialize(); const item = (await scanGoals(f.repo))[0]!;
    assertOk(f.coordinator.setPaused(f.command(), true)); expect(await scanGoals(f.repo)).toEqual([]);
    expect(readOutcomeWorkItemContext(item)).toBeNull();
    assertOk(f.coordinator.setPaused(f.command(), false));
    assertOk(f.coordinator.editScope(f.command(), { ...f.scope, acceptance: ['New operator scope'] }));
    expect(await scanGoals(f.repo)).toEqual([]); expect(readOutcomeWorkItemContext(item)).toBeNull();
  });
  it.each(['paused', 'done', 'archived'])('holds an already queued item after its Goal becomes %s', status => {
    const f = fixture(); f.materialize(); const node = f.node(); const goal = loadGoal(node.materialization.goalId)!;
    const item = { id: `goal:${goal.id}:${goal.milestones[0]!.id}`, source: 'goal' as const, repo: f.repo };
    expect(readOutcomeWorkItemContext(item)).not.toBeNull();
    goal.status = status as typeof goal.status; expect(saveGoal(goal)).toBe(true);
    expect(readOutcomeWorkItemContext(item)).toBeNull();
  });
  it.each(['done', 'skipped', 'blocked'])('holds an already queued item after its milestone becomes %s', status => {
    const f = fixture(); f.materialize(); const node = f.node(); const goal = loadGoal(node.materialization.goalId)!;
    const item = { id: `goal:${goal.id}:${goal.milestones[0]!.id}`, source: 'goal' as const, repo: f.repo };
    goal.milestones[0]!.status = status as typeof goal.milestones[0]['status']; expect(saveGoal(goal)).toBe(true);
    expect(readOutcomeWorkItemContext(item)).toBeNull();
  });
  it('preserves exact old Goal linkage through unrelated automatic refinement', async () => {
    const f = fixture(); f.materialize(); const before = (await scanGoals(f.repo))[0]!; const old = loadGoal(f.node().materialization.goalId)!;
    f.plan.nodes.push({ ...f.plan.nodes[0]!, key: 'c', title: 'Build c', objective: 'Implement c', dependsOn: [] }); f.refine(); f.materialize();
    expect(loadGoal(old.id)).toEqual(old); expect((await scanGoals(f.repo)).some(item => item.id === before.id)).toBe(true);
  });
  it('treats an incomplete source as unknown and never returns speculative work', async () => {
    const f = fixture(); f.materialize(); const item = (await scanGoals(f.repo))[0]!;
    writeFileSync(join(f.directory, 'ledger', 'records', 'unknown.json'), '{}', { mode: 0o600 });
    expect(await scanGoals(f.repo)).toEqual([]); expect(readOutcomeWorkItemContext(item)).toBeNull();
    expect(materializeOutcomeIntents(f.id, { stillAuthorized: () => true }).sourceState).toBe('degraded');
  });
  it.each(['scopeDigest', 'nodeId', 'nodeBasisDigest', 'scopeRevision', 'outcomeId'])('rejects detached %s binding drift', async field => {
    const f = fixture(); f.materialize(); const goal = loadGoal(f.node().materialization.goalId)!;
    goal.outcome = { ...goal.outcome!, [field]: field === 'scopeRevision' ? 99 : field === 'outcomeId' ? 'other' : '7'.repeat(64) };
    writeFileSync(join(goalsDir(), `${goal.id}.json`), JSON.stringify(goal));
    expect(await scanGoals(f.repo)).toEqual([]);
  });
  it('preserves the immutable outcome binding through ordinary Goal status changes', () => {
    const f = fixture(); f.materialize(); const goal = loadGoal(f.node().materialization.goalId)!;
    const changed = structuredClone(goal); changed.outcome!.nodeBasisDigest = '8'.repeat(64);
    expect(saveGoal(changed)).toBe(false); expect(loadGoal(goal.id)?.outcome).toEqual(goal.outcome);
    const removed = structuredClone(goal); delete removed.outcome; expect(saveGoal(removed)).toBe(false);
    const semantic = structuredClone(goal); semantic.objective = 'Different task'; expect(saveGoal(semantic)).toBe(false);
    const malformed = structuredClone(goal); malformed.milestones = []; expect(saveGoal(malformed)).toBe(false);
    goal.status = 'paused'; expect(saveGoal(goal)).toBe(true); expect(loadGoal(goal.id)?.status).toBe('paused');
  });
  it('keeps legacy planning/hashed WorkItem behavior and does not apply outcome gates to legacy Goals', async () => {
    const f = fixture(); const created = createGoalIfAbsent('Legacy useful task', { project: f.repo });
    files.push(join(goalsDir(), `${created.goal.id}.json`));
    const legacy = created.goal; const milestone = { id: `${legacy.id}-m0`, title: 'Implement legacy', detail: 'Focused legacy task',
      order: 0, status: 'pending' as const, specId: null, swarmId: null, proposalId: null, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt };
    planner.mockResolvedValue({ ...legacy, status: 'active', milestones: [milestone] });
    const items = await scanGoals(f.repo, { foundry: { goalPlanning: true } });
    expect(items).toHaveLength(1); expect(items[0]!.id).toMatch(/^repo:goal:/); expect(planner).toHaveBeenCalledTimes(1);
    expect(readOutcomeWorkItemContext(items[0]!)).toBeNull();
  });
  it('validates every detached binding field and prevents traversal identities', () => {
    const f = fixture(); f.materialize(); const goal = loadGoal(f.node().materialization.goalId)!;
    expect(isValidGoalRecord({ ...goal, outcome: { ...goal.outcome, extra: true } })).toBe(false);
    expect(isValidGoalRecord({ ...goal, outcome: { ...goal.outcome, outcomeId: '../escape' } })).toBe(false);
    expect(() => outcomeDirectory('../escape')).toThrow();
    expect(isValidGoalRecord({ ...goal, outcome: { ...goal.outcome, schemaVersion: 2 } as unknown as GoalOutcomeBindingV1 })).toBe(false);
  });
});

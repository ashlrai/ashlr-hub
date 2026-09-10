/** Private preparation boundaries. Git fixtures are real; no evaluator or worker is executed. */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle } from '../src/core/resources/engineering-preparation.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import * as campaignStore from '../src/core/universe/campaign-store.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (file: string): void => {
    if (!lstatSync(file).isDirectory()) return;
    chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
/** Include directory timestamps to detect temporary create/delete writes; reads may change atime only. */
function tree(root: string): Record<string, unknown> {
  if (!existsSync(root)) return { missing: true };
  const entries: Record<string, unknown> = {};
  const visit = (file: string, path: string): void => {
    const stat = lstatSync(file, { bigint: true });
    expect(stat.isSymbolicLink()).toBe(false);
    entries[path] = { mode: String(stat.mode), inode: String(stat.ino), links: String(stat.nlink),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), ...(stat.isFile() ? { digest: digest(readFileSync(file)) } : {}) };
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name), `${path}/${name}`);
  };
  visit(root, ''); return entries;
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-preparation-boundary-'))); roots.push(base);
  const workspace = join(base, 'project'); const transport = join(base, 'sterile'); const other = join(base, 'other-project');
  for (const path of [workspace, transport, other]) mkdirSync(path, { mode: 0o700 });
  for (const repo of [workspace, transport]) git(repo, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw new Error("Preparation must not run this evaluator");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Preparation Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed seed');
  const revision = git(workspace, 'rev-parse', 'HEAD');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'preparation-pool', workers: [{ id: 'fixture-worker', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'fixture-worker', capacityKey: 'existing-account', kind: 'local-chat',
    endpoint: 'http://127.0.0.1:9/v1' }], pool);
  const poolFile = join(base, 'pool.json'); const bindingsFile = join(base, 'bindings.json');
  const observationsFile = join(base, 'observations.json'); const projectsFile = join(base, 'projects.json');
  const resourceRuntime = join(base, 'runtime.json'); const ledger = join(base, 'shared-ledger'); const output = join(base, 'prepared-plan');
  save(poolFile, pool); save(bindingsFile, bindings); save(observationsFile, [{ workerId: 'fixture-worker', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() }]);
  save(projectsFile, { schemaVersion: 1, projects: [{ id: 'other', label: 'Other project', workspace: other }] });
  const runtime = { schemaVersion: 1, root: ledger, workspace: transport, poolPath: poolFile, bindingsPath: bindingsFile, observationsPath: observationsFile };
  save(resourceRuntime, runtime);
  return { base, workspace, transport, other, revision, pool, bindings, poolFile, bindingsFile, observationsFile, projectsFile, resourceRuntime, runtime, ledger, output };
}
function recipe(f: ReturnType<typeof fixture>): ResourceEngineeringRecipe {
  return { schemaVersion: 1, id: 'boundary-plan', name: 'Private preparation fixture', objective: 'Measure an explicitly bounded value',
    projectId: 'default', seedRevision: f.revision, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 20_000, trialTimeoutMs: 10_000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 40_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 500 },
    generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['fixture-worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Repair the measured value' }] },
    delivery: { branch: 'codex/boundary-preparation', allowInitialRepair: true },
    execution: { maxDurationMs: 60_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 120_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
}
const options = (f: ReturnType<typeof fixture>) => ({ recipe: recipe(f), output: f.output,
  resourceRuntime: f.resourceRuntime, workspace: f.workspace, projectsFile: f.projectsFile });

describe('engineering preparation authority and publication boundaries', () => {
  it('plans repeatedly without writing even transient directories, locks, or shared state', () => {
    const f = fixture(); const before = tree(f.base); const first = checkResourceEngineeringPreparation(options(f));
    expect(first).toMatchObject({ status: 'planned', scope: 'local-preparation-only', enrollmentDigest: null,
      executionStarted: false, providerContacted: false, projectRegistration: 'would-register' });
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(checkResourceEngineeringPreparation(options(f))).toEqual(first);
    expect(tree(f.base)).toEqual(before); expect(existsSync(f.ledger)).toBe(false); expect(existsSync(f.output)).toBe(false);
  });
  it.each(['unknown-field', 'unknown-worker', 'missing-worker', 'unsafe-branch', 'false-repair', 'unbounded-time', 'mutable-evaluator'])('refuses %s without preparing output', (mode) => {
    const f = fixture(); const input = options(f);
    if (mode === 'unknown-field') Object.assign(input.recipe, { rawCommand: 'not an authority source' });
    if (mode === 'unknown-worker') input.recipe.generation.allowedWorkerIds = ['not-enrolled'];
    if (mode === 'missing-worker') input.recipe.generation.allowedWorkerIds = [];
    if (mode === 'unsafe-branch') input.recipe.delivery.branch = 'main';
    if (mode === 'false-repair') Object.assign(input.recipe.delivery, { allowInitialRepair: false });
    if (mode === 'unbounded-time') input.recipe.execution.maxDurationMs = Infinity;
    if (mode === 'mutable-evaluator') input.recipe.generation.files = ['evaluate.mjs'];
    const before = tree(f.base); expect(() => checkResourceEngineeringPreparation(input)).toThrow();
    expect(tree(f.base)).toEqual(before);
  });
  it('rejects recipe getters without invoking them', () => {
    const f = fixture(); const input = options(f); const getter = vi.fn(() => 'hidden objective');
    Object.defineProperty(input.recipe, 'objective', { enumerable: true, get: getter });
    expect(() => checkResourceEngineeringPreparation(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(existsSync(f.output)).toBe(false);
  });
  it.each(['project', 'other-project', 'transport', 'ledger', 'runtime-file'])('refuses output overlapping %s scope', (mode) => {
    const f = fixture(); const input = options(f);
    const targets = { project: join(f.workspace, 'prepared'), 'other-project': join(f.other, 'prepared'), transport: join(f.transport, 'prepared'),
      ledger: join(f.ledger, 'prepared'), 'runtime-file': f.resourceRuntime };
    input.output = targets[mode as keyof typeof targets]; const before = tree(f.base);
    expect(() => checkResourceEngineeringPreparation(input)).toThrow(); expect(tree(f.base)).toEqual(before);
  });
  it('requires the exact checked digest before creating any preparation directory', async () => {
    const f = fixture(); const input = options(f); checkResourceEngineeringPreparation(input); const before = tree(f.base);
    await expect(async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: 'a'.repeat(64) })).rejects.toThrow();
    expect(tree(f.base)).toEqual(before);
  });
  it.each(['runtime', 'pool', 'projects', 'project-directory', 'evaluator-executable'])('rejects %s drift between check and registration', async (mode) => {
    const f = fixture(); const input = options(f);
    const executable = join(f.base, 'never-executed-evaluator');
    if (mode === 'evaluator-executable') {
      writeFileSync(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 }); input.recipe.evaluation.command[0] = executable;
    }
    const plan = checkResourceEngineeringPreparation(input);
    if (mode === 'runtime') save(f.resourceRuntime, { ...f.runtime, capacityWaitMs: 1000 });
    if (mode === 'pool') save(f.poolFile, { ...f.pool, workers: f.pool.workers.map(worker => ({ ...worker, reservePercent: 30 })) });
    if (mode === 'projects') save(f.projectsFile, { schemaVersion: 1, projects: [{ id: 'other', label: 'Changed label', workspace: f.other }] });
    if (mode === 'project-directory') {
      const original = join(f.base, 'original-project'); renameSync(f.workspace, original); cpSync(original, f.workspace, { recursive: true });
    }
    if (mode === 'evaluator-executable') writeFileSync(executable, '#!/bin/sh\nexit 98\n', { mode: 0o700 });
    const changed = tree(f.base);
    await expect(async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(tree(f.base)).toEqual(changed); expect(existsSync(f.output)).toBe(false);
  });
  it('refuses an incomplete final directory without deleting or repairing any retained content', async () => {
    const f = fixture(); const input = options(f); const plan = checkResourceEngineeringPreparation(input);
    mkdirSync(f.output, { mode: 0o700 }); save(join(f.output, 'intent.json'), { incomplete: 'retain this exact evidence' });
    const before = tree(f.base);
    await expect(async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(tree(f.base)).toEqual(before);
  });
  it('retains actual partial registration after campaign publication fails and refuses automatic reconstruction', async () => {
    const f = fixture(); const input = options(f); const plan = checkResourceEngineeringPreparation(input);
    const campaignFailure = vi.spyOn(campaignStore, 'initUniverseCampaign').mockImplementation(() => { throw new Error('fixture publication unavailable'); });
    await expect(async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(campaignFailure).toHaveBeenCalledTimes(1); campaignFailure.mockRestore();
    expect(existsSync(plan.paths.universeRoot)).toBe(true); expect(existsSync(plan.paths.receipt)).toBe(false);
    const partial = tree(f.base);
    await expect(async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(tree(f.base)).toEqual(partial);
  });
  it('prepares a pinned bundle without modifying the project, runtime, accounting, or starting a graph', async () => {
    const f = fixture(); const input = options(f); const plan = checkResourceEngineeringPreparation(input);
    const project = tree(f.workspace); const runtime = readFileSync(f.resourceRuntime, 'utf8');
    const pool = readFileSync(f.poolFile, 'utf8'); const bindings = readFileSync(f.bindingsFile, 'utf8');
    const prepared = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    expect(prepared).toMatchObject({ status: 'prepared', disposition: 'created', planDigest: plan.planDigest,
      executionStarted: false, providerContacted: false });
    expect(prepared.enrollmentDigest).toMatch(/^[a-f0-9]{64}$/); expect(tree(f.workspace)).toEqual(project);
    expect(readFileSync(f.resourceRuntime, 'utf8')).toBe(runtime); expect(readFileSync(f.poolFile, 'utf8')).toBe(pool);
    expect(readFileSync(f.bindingsFile, 'utf8')).toBe(bindings); expect(existsSync(f.ledger)).toBe(false);
    expect(existsSync(join(prepared.paths.graphRoot, 'control-graph'))).toBe(false);
    const campaign = JSON.parse(readFileSync(prepared.paths.campaign, 'utf8'));
    expect(campaign).toMatchObject({ feedback: true, measureSeed: true });
    expect(prepared.consoleArguments.manual).not.toContain('--engineering-supervision');
    expect(prepared.consoleArguments.automatic).toContain('--engineering-supervision');
  });
  it('replays completed registration read-only and refuses a changed generated campaign pin', async () => {
    const f = fixture(); const input = options(f); const plan = checkResourceEngineeringPreparation(input);
    const first = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    const before = tree(f.base); const repeated = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    expect(repeated).toMatchObject({ disposition: 'replayed', enrollmentDigest: first.enrollmentDigest }); expect(tree(f.base)).toEqual(before);
    const campaign = JSON.parse(readFileSync(first.paths.campaign, 'utf8')); campaign.budget.maxModelRequests += 1; save(first.paths.campaign, campaign);
    const changed = tree(f.base);
    await expect(async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(tree(f.base)).toEqual(changed);
  });
  it('does not clear retained account pauses or allocation ceilings while preparing', async () => {
    const f = fixture(); setResourcePoolAllocation(f.ledger, f.pool, f.bindings, 0, 0);
    setResourceWorkerAccess(f.ledger, f.pool, f.bindings, ['fixture-worker'], 0);
    const accounting = tree(f.ledger); const input = options(f); const plan = checkResourceEngineeringPreparation(input);
    const prepared = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    expect(prepared.status).toBe('prepared'); expect(tree(f.ledger)).toEqual(accounting);
    const retained = JSON.parse(readFileSync(join(f.ledger, 'pool-state.json'), 'utf8'));
    expect(retained.allocation.ceilingPercent).toBe(0); expect(retained.workerAccess.pausedWorkerIds).toEqual(['fixture-worker']);
  });
  it('reports the selected project as persisted even when an unrelated project would be newly registered', async () => {
    const f = fixture();
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.workspace, pool: f.pool, bindings: f.bindings,
      projects: [{ id: 'other', label: 'Other project', workspace: f.other }],
      readObservations: () => JSON.parse(readFileSync(f.observationsFile, 'utf8')) });
    await supervisor.close();
    const additional = join(f.base, 'new-project'); mkdirSync(additional, { mode: 0o700 });
    save(f.projectsFile, { schemaVersion: 1, projects: [{ id: 'other', label: 'Other project', workspace: f.other },
      { id: 'additional', label: 'Additional project', workspace: additional }] });
    const before = tree(f.base);
    expect(checkResourceEngineeringPreparation(options(f)).projectRegistration).toBe('persisted');
    expect(tree(f.base)).toEqual(before);
  });
  it('refuses completed replay when its frozen evaluator bytes no longer match the comparator', async () => {
    const f = fixture(); const input = options(f); const plan = checkResourceEngineeringPreparation(input);
    const prepared = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    const evaluator = join(prepared.paths.universeRoot, 'universes', prepared.ids.universeId, 'seed', 'evaluate.mjs');
    chmodSync(evaluator, 0o600); writeFileSync(evaluator, 'throw new Error("Changed frozen evaluator");\n');
    const changed = tree(f.base);
    await expect(async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest })).rejects.toThrow();
    expect(tree(f.base)).toEqual(changed);
  });
  it('registers committed seed bytes without consuming or overwriting dirty working-tree changes', async () => {
    const f = fixture(); const input = options(f); const plan = checkResourceEngineeringPreparation(input);
    writeFileSync(join(f.workspace, 'value.json'), '99\n'); writeFileSync(join(f.workspace, 'evaluate.mjs'), 'throw new Error("Uncommitted evaluator");\n');
    expect(checkResourceEngineeringPreparation(input).planDigest).toBe(plan.planDigest);
    const project = tree(f.workspace); const prepared = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    const seed = join(prepared.paths.universeRoot, 'universes', prepared.ids.universeId, 'seed');
    expect(readFileSync(join(seed, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(seed, 'evaluate.mjs'), 'utf8')).toContain('Preparation must not run this evaluator');
    expect(tree(f.workspace)).toEqual(project);
  });
});

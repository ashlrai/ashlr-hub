/** Actual pinned registration, without starting a worker or evaluator. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, type ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation.js';
import * as commissioning from '../src/core/resources/console-engineering-check.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return;
    chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-core-'))); roots.push(base);
  const workspace = join(base, 'repo'); const transport = join(base, 'transport'); const ledger = join(base, 'ledger');
  for (const dir of [workspace, transport]) { mkdirSync(dir, { mode: 0o700 }); git(dir, 'init', '-q', '--template=', '--initial-branch=main'); }
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("must not execute during preparation");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolPath = join(base, 'pool.json'); const bindingsPath = join(base, 'bindings.json'); const observationsPath = join(base, 'observations.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
  save(observationsPath, [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }]);
  const resourceRuntime = join(base, 'runtime.json'); save(resourceRuntime, { schemaVersion: 1, root: ledger, workspace: transport,
    poolPath, bindingsPath, observationsPath });
  const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'repair', name: 'Bounded repair', objective: 'Improve a measured value', projectId: 'default',
    seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    trialBudget: { maxTrials: 2, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 2, maxStagnantGenerations: 1, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'first', niche: 'value', hypothesis: 'First approach' }, { id: 'second', niche: 'value', hypothesis: 'Second approach' }] },
    delivery: { branch: 'codex/prepared', allowInitialRepair: true }, execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  return { base, ledger, observationsPath, options: { recipe, workspace, resourceRuntime, projectsFile, output: join(base, 'bundle') } };
}
describe('evaluated engineering preparation bridge', () => {
  it('derives multiple confined hypotheses and one measured campaign on the existing ledger', () => {
    const f = fixture(); const plan = checkResourceEngineeringPreparation(f.options);
    const result = prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest });
    const manifest = JSON.parse(readFileSync(result.paths.manifest, 'utf8'));
    expect(manifest.variants).toHaveLength(2);
    for (const variant of manifest.variants) expect(variant.generation).toMatchObject({ kind: 'resource-pool', poolDigest: plan.poolDigest,
      allowedWorkerIds: ['worker'], fileOperations: { schemaVersion: 1, contextFiles: ['evaluate.mjs'] } });
    expect(JSON.parse(readFileSync(result.paths.campaign, 'utf8'))).toMatchObject({ feedback: true, measureSeed: true });
    expect(existsSync(f.ledger)).toBe(false);
    expect(result.consoleArguments.automatic).toEqual([...result.consoleArguments.manual, '--engineering-supervision', result.paths.supervision]);
  });
  it('retains enrollment-level commissioning holds in the bounded prepared report', () => {
    const f = fixture(); const plan = checkResourceEngineeringPreparation(f.options);
    const original = commissioning.checkResourceConsoleEngineering;
    vi.spyOn(commissioning, 'checkResourceConsoleEngineering').mockImplementation(input => {
      const result = original(input); result.status = 'held'; result.reasons = [];
      result.enrollments[0]!.reasons = ['global-kill-active', 'global-kill-active', 'queue-paused']; return result;
    });
    const result = prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest });
    expect(result.commissioning).toEqual({ status: 'held', reasons: ['global-kill-active', 'queue-paused'] });
  });
  it('refuses an occupied delivery branch before creating the output', () => {
    const f = fixture(); git(f.options.workspace, 'branch', 'codex/prepared');
    expect(() => checkResourceEngineeringPreparation(f.options)).toThrow(/branch already exists/);
    expect(existsSync(f.options.output)).toBe(false); expect(existsSync(f.ledger)).toBe(false);
  });
  it('refuses a branch created between plan and prepare without creating the output', () => {
    const f = fixture(); const plan = checkResourceEngineeringPreparation(f.options);
    git(f.options.workspace, 'branch', 'codex/prepared');
    expect(() => prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/branch already exists/);
    expect(existsSync(f.options.output)).toBe(false);
  });
  it('keeps volatile observation refresh outside the durable recipe pin', () => {
    const f = fixture(); const first = checkResourceEngineeringPreparation(f.options);
    const observations = JSON.parse(readFileSync(f.observationsPath, 'utf8')); observations[0].expiresAt = new Date(Date.now() + 120_000).toISOString();
    save(f.observationsPath, observations);
    expect(checkResourceEngineeringPreparation(f.options).planDigest).toBe(first.planDigest);
  });
  it('rejects a seed larger than the artifact byte cap before publishing any output', () => {
    const f = fixture(); writeFileSync(join(f.options.workspace, 'large.bin'), Buffer.alloc(64 * 1024 * 1024));
    git(f.options.workspace, 'add', '.'); git(f.options.workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'large seed');
    f.options.recipe.seedRevision = git(f.options.workspace, 'rev-parse', 'HEAD');
    expect(() => checkResourceEngineeringPreparation(f.options)).toThrow(/artifact bounds/);
    expect(existsSync(f.options.output)).toBe(false); expect(existsSync(f.ledger)).toBe(false);
  });
});

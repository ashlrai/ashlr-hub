/** Real private Git/configuration/registration; no execution owner, evaluator or worker. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceEngineeringPreparationRegistry } from '../src/core/resources/engineering-preparation-registry.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation-types.js';

const roots: string[] = [];
afterEach(() => {
  const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return; chmodSync(file, 0o700);
    for (const name of readdirSync(file)) writable(join(file, name)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))])) };
}
const request = { id: 'objective', profileId: 'profile', name: 'Measured work', objective: 'Improve value under fixed checks.' };
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-registry-boundary-'))); roots.push(base);
  const workspace = join(base, 'repo'); const transport = join(base, 'transport'); const root = join(base, 'ledger'); const outputRoot = join(base, 'prepared');
  for (const dir of [workspace, transport, root, outputRoot]) mkdirSync(dir, { mode: 0o700 });
  const git = (repo: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  for (const dir of [workspace, transport]) git(dir, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Registry inspection must not execute evaluator");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolFile = join(base, 'pool.json'), bindingsFile = join(base, 'bindings.json'), observationsFile = join(base, 'observations.json');
  save(poolFile, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  save(bindingsFile, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]); save(observationsFile, []);
  const resourceRuntime = join(base, 'runtime.json');
  save(resourceRuntime, { schemaVersion: 1, root, workspace: transport, poolPath: poolFile, bindingsPath: bindingsFile, observationsPath: observationsFile });
  const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'template', name: 'Pinned template', objective: 'Fixed objective', projectId: 'default',
    seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Improve value' }] }, delivery: { branch: 'codex/template', allowInitialRepair: true },
    execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot, resourceRuntime,
    profiles: [{ id: 'profile', label: 'Fixed checks', acceptance: 'Change value only.', recipe }] };
  const configFile = join(base, 'profiles.json'); save(configFile, config);
  const options = { configFile, config, root, workspace, projectsFile, poolFile, bindingsFile, observationsFile };
  return { base, root, config, options, registry: createResourceEngineeringPreparationRegistry(options) };
}

describe('owner-independent preparation registry boundaries', () => {
  it('deeply freezes returned configuration and nested objective/plan aliases without freezing caller data', () => {
    const f = fixture(); const before = tree(f.base);
    const expected = f.registry.materialize(request).plan;
    const objective = f.registry.objective(request);
    const plan = f.registry.materialize(request).plan;
    expect(Object.isFrozen(f.config)).toBe(false);
    expect(Object.isFrozen(f.registry.config.profiles[0]!.recipe.generation.files)).toBe(true);
    expect(() => { f.registry.config.outputRoot = join(f.base, 'redirected'); }).toThrow(TypeError);
    expect(() => { objective.profile.recipe.metric.direction = 'minimize'; }).toThrow(TypeError);
    expect(() => { objective.recipe.generation.allowedWorkerIds.push('foreign'); }).toThrow(TypeError);
    expect(() => { plan.files.push('evaluate.mjs'); }).toThrow(TypeError);
    expect(() => { plan.campaignBudget.maxModelRequests = 100; }).toThrow(TypeError);
    f.config.profiles[0]!.recipe.generation.files.push('caller-only');
    expect(f.registry.materialize(request).plan).toEqual(expected);
    expect(tree(f.base)).toEqual(before); expect(f.registry.registrations()).toEqual([]);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  });

  it('rejects foreign-context publication before callbacks or writes and preserves valid canonical registration', () => {
    const f = fixture(); const plan = f.registry.materialize(request).plan;
    const prepared = f.registry.prepare({ ...request, expectedPlanDigest: plan.planDigest }, { beforeNew() {}, beforePublication() {} });
    expect(prepared.disposition).toBe('created');
    const row = f.registry.registrations()[0]!;
    const originalContextDigest = digest(canonical({ outputRoot: f.config.outputRoot, resourceRuntime: f.config.resourceRuntime,
      root: f.options.root, workspace: f.options.workspace, projectsFile: f.options.projectsFile, poolFile: f.options.poolFile,
      bindingsFile: f.options.bindingsFile, observationsFile: f.options.observationsFile, quotaConfigFile: null }));
    const bundleReceipt = JSON.parse(readFileSync(join(f.config.outputRoot, request.id, 'receipt.json'), 'utf8')) as { planDigest: string };
    const originalPlanDigest = digest(canonical({ contextDigest: originalContextDigest, profileDigest: digest(canonical(f.config.profiles[0])),
      request, bundlePlanDigest: bundleReceipt.planDigest }));
    expect(row).toEqual({ schemaVersion: 1, configDigest: originalContextDigest, request, planDigest: originalPlanDigest,
      bundlePlanDigest: bundleReceipt.planDigest, enrollmentDigest: prepared.enrollmentDigest });
    const record = join(f.root, 'console-engineering-preparations', 'records', `${request.id}.json`);
    const bytes = readFileSync(record);
    expect(bytes.toString()).toBe(canonical(row) + '\n'); expect(Object.hasOwn(row, 'source')).toBe(false);
    const before = tree(f.base); const guard = vi.fn();
    expect(() => f.registry.publish({ ...row, configDigest: row.configDigest === 'f'.repeat(64) ? 'a'.repeat(64) : 'f'.repeat(64) }, guard)).toThrow();
    expect(guard).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before); expect(readFileSync(record)).toEqual(bytes);
    const restored = createResourceEngineeringPreparationRegistry(f.options);
    expect(restored.registrations()).toEqual([row]);
    expect(restored.committed(row).report.enrollmentDigest).toBe(prepared.enrollmentDigest);
    const replay = restored.prepare({ ...request, expectedPlanDigest: plan.planDigest }, { beforeNew: vi.fn(() => { throw Error('Must not create'); }), beforePublication() {} });
    expect(replay.disposition).toBe('replayed'); expect(tree(f.base)).toEqual(before);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  });
});

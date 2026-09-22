/** Real private Git/configuration/registration; no execution owner, evaluator or worker. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceEngineeringPreparationRegistry, readResourceEngineeringPreparationRegistrations,
  resourceEngineeringPreparationRegistrationRoot, validateResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/engineering-preparation-registry.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation-types.js';
import * as preparation from '../src/core/resources/engineering-preparation.js';
import * as commissioning from '../src/core/resources/console-engineering-check.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
function fixture(registrationScope?: string) {
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
    ...(registrationScope === undefined ? {} : { registrationScope }),
    profiles: [{ id: 'profile', label: 'Fixed checks', acceptance: 'Change value only.', recipe }] };
  const configFile = join(base, 'profiles.json'); save(configFile, config);
  const options = { configFile, config, root, workspace, projectsFile, poolFile, bindingsFile, observationsFile };
  return { base, root, config, options, registry: createResourceEngineeringPreparationRegistry(options) };
}

describe('owner-independent preparation registry boundaries', () => {
  it('isolates scoped records and exact replay while retaining the shared accounting anchor and legacy path', () => {
    const f = fixture('first');
    const plan = f.registry.materialize(request).plan;
    const prepared = f.registry.prepare({ ...request, expectedPlanDigest: plan.planDigest }, { beforeNew() {}, beforePublication() {} });
    const first = f.registry.registrations()[0]!;
    const firstRoot = resourceEngineeringPreparationRegistrationRoot(f.root, 'first');
    expect(firstRoot).toBe(join(f.root, 'console-engineering-preparations-scope-first'));
    expect(resourceEngineeringPreparationRegistrationRoot(f.root)).toBe(join(f.root, 'console-engineering-preparations'));
    const firstTree = tree(firstRoot);
    const outputRoot = join(f.base, 'prepared-second'); mkdirSync(outputRoot, { mode: 0o700 });
    const config = { ...f.config, outputRoot, registrationScope: 'second' };
    const configFile = join(f.base, 'profiles-second.json'); save(configFile, config);
    const second = createResourceEngineeringPreparationRegistry({ ...f.options, configFile, config });
    expect(second.registrations()).toEqual([]);
    expect(readResourceEngineeringPreparationRegistrations(f.root)).toEqual([]);
    const guard = vi.fn(); const before = tree(f.base);
    expect(() => second.publish(first, guard)).toThrow('context changed');
    expect(guard).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before);
    const secondPlan = second.materialize(request).plan;
    second.prepare({ ...request, expectedPlanDigest: secondPlan.planDigest }, { beforeNew() {}, beforePublication() {} });
    expect(second.registrations()).toHaveLength(1);
    expect(second.registrations()[0]!.configDigest).not.toBe(first.configDigest);
    expect(tree(firstRoot)).toEqual(firstTree);
    const restored = createResourceEngineeringPreparationRegistry(f.options);
    const replayBefore = tree(f.base);
    const replay = restored.prepare({ ...request, expectedPlanDigest: plan.planDigest }, {
      beforeNew() { throw Error('Must not create'); }, beforePublication() {},
    });
    expect(replay.disposition).toBe('replayed'); expect(replay.enrollmentDigest).toBe(prepared.enrollmentDigest);
    expect(tree(f.base)).toEqual(replayBefore);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  }, 30_000);

  it('keeps missing reads side-effect free and binds scope even when every other context field is identical', () => {
    const f = fixture(); const before = tree(f.base);
    expect(readResourceEngineeringPreparationRegistrations(f.root)).toEqual([]);
    expect(readResourceEngineeringPreparationRegistrations(f.root, 'empty')).toEqual([]);
    expect(tree(f.base)).toEqual(before);
    const scoped = createResourceEngineeringPreparationRegistry({ ...f.options, config: { ...f.config, registrationScope: 'scope' } });
    expect(scoped.contextDigest).not.toBe(f.registry.contextDigest);
    expect(scoped.contextDigest).toBe(digest(canonical({ outputRoot: f.config.outputRoot, resourceRuntime: f.config.resourceRuntime,
      root: f.root, workspace: f.options.workspace, projectsFile: f.options.projectsFile, poolFile: f.options.poolFile,
      bindingsFile: f.options.bindingsFile, observationsFile: f.options.observationsFile, quotaConfigFile: null, registrationScope: 'scope' })));
    expect(tree(f.base)).toEqual(before);
  });

  it('rejects malformed scope and accessors before filesystem effects or getter invocation', () => {
    const f = fixture(); const before = tree(f.base); const getter = vi.fn(() => 'scope');
    for (const registrationScope of ['', '.', '..', '../escape', '/absolute', 'a/b', 'UPPER', 'a'.repeat(65), null, 1, {}]) {
      expect(() => resourceEngineeringPreparationRegistrationRoot(f.root, registrationScope as string)).toThrow();
      expect(() => readResourceEngineeringPreparationRegistrations(f.root, registrationScope as string)).toThrow();
      expect(() => validateResourceConsoleEngineeringPreparationConfig({ ...f.config, registrationScope })).toThrow();
    }
    const config = Object.defineProperty({ ...f.config }, 'registrationScope', { enumerable: true, get: getter });
    expect(() => validateResourceConsoleEngineeringPreparationConfig(config)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before);
  });

  it('refuses a live symlink namespace without following it or changing another scope', () => {
    const f = fixture('safe'); const target = join(f.base, 'foreign'); mkdirSync(target, { mode: 0o700 });
    const before = tree(target);
    symlinkSync(target, resourceEngineeringPreparationRegistrationRoot(f.root, 'linked'));
    expect(() => readResourceEngineeringPreparationRegistrations(f.root, 'linked')).toThrow('unavailable');
    expect(readResourceEngineeringPreparationRegistrations(f.root, 'safe')).toEqual([]);
    expect(readResourceEngineeringPreparationRegistrations(f.root)).toEqual([]);
    expect(tree(target)).toEqual(before);
  });

  it.each([undefined, 'dangling'])('refuses dangling namespace links for scope %s without creating the target', registrationScope => {
    const f = fixture(); const target = join(f.base, 'never-created');
    const storeRoot = resourceEngineeringPreparationRegistrationRoot(f.root, registrationScope);
    symlinkSync(target, storeRoot);
    const before = lstatSync(storeRoot, { bigint: true });
    expect(() => readResourceEngineeringPreparationRegistrations(f.root, registrationScope)).toThrow('unavailable');
    expect(lstatSync(storeRoot, { bigint: true })).toEqual(before);
    expect(existsSync(target)).toBe(false);
  });

  it.each([undefined, 'bounded'])('retains the exact 32-record read bound for scope %s independently of other namespaces', registrationScope => {
    const f = fixture(registrationScope);
    const storeRoot = resourceEngineeringPreparationRegistrationRoot(f.root, registrationScope);
    for (const dir of [storeRoot, join(storeRoot, 'records'), join(storeRoot, 'staging')]) mkdirSync(dir, { mode: 0o700 });
    // Synthetic valid-shaped records exercise the real private reader's census,
    // not bundle acceptance: no claim is made that these records have bundles.
    for (let i = 0; i < 32; i++) save(join(storeRoot, 'records', `objective-${i}.json`), {
      schemaVersion: 1, configDigest: f.registry.contextDigest, request: { ...request, id: `objective-${i}` },
      planDigest: 'a'.repeat(64), bundlePlanDigest: 'b'.repeat(64), enrollmentDigest: 'c'.repeat(64),
    });
    expect(f.registry.registrations()).toHaveLength(32);
    expect(readResourceEngineeringPreparationRegistrations(f.root, 'independent')).toEqual([]);
    const plan = f.registry.materialize(request).plan;
    const before = tree(f.base);
    const beforeNew = vi.fn();
    expect(() => f.registry.prepare({ ...request, expectedPlanDigest: plan.planDigest }, { beforeNew, beforePublication() {} }))
      .toThrow('Engineering enrollment capacity reached');
    expect(beforeNew).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before);
    save(join(storeRoot, 'records', 'overflow.json'), { schemaVersion: 1, configDigest: f.registry.contextDigest,
      request: { ...request, id: 'overflow' }, planDigest: 'a'.repeat(64), bundlePlanDigest: 'b'.repeat(64), enrollmentDigest: 'c'.repeat(64) });
    const overflow = tree(f.base);
    expect(() => f.registry.registrations()).toThrow('unavailable');
    expect(readResourceEngineeringPreparationRegistrations(f.root, 'independent')).toEqual([]);
    expect(tree(f.base)).toEqual(overflow);
  });

  it('keeps fresh full bundle evidence at all writer boundaries without repeating unused commissioning reports', () => {
    const f = fixture(); const plan = f.registry.materialize(request).plan;
    const metadata = vi.spyOn(preparation, 'readPreparedResourceEngineeringMetadata');
    const full = vi.spyOn(preparation, 'readPreparedResourceEngineeringBundle');
    const reports = vi.spyOn(commissioning, 'checkResourceConsoleEngineering');
    const guard = vi.fn();
    const prepared = f.registry.prepare({ ...request, expectedPlanDigest: plan.planDigest }, { beforeNew() {}, beforePublication: guard });
    expect(prepared.disposition).toBe('created');
    expect(full).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledTimes(3);
    expect(guard).toHaveBeenCalledTimes(4);
    // Creator and initial committed report remain complete; the three writer
    // gates use the same fresh evidence reader without its diagnostics wrapper.
    expect(reports).toHaveBeenCalledTimes(2);
    const row = f.registry.registrations()[0]!;
    const before = tree(f.base); const verified = f.registry.committed(row);
    expect(verified.report).toHaveProperty('commissioning');
    expect(verified.report).toHaveProperty('consoleArguments');
    expect(verified.report.enrollmentDigest).toBe(prepared.enrollmentDigest);
    expect(tree(f.base)).toEqual(before);
  });

  it.each([1, 2, 3])('refuses receipt drift at fresh writer boundary %i without publishing registration', boundary => {
    const f = fixture(); const plan = f.registry.materialize(request).plan;
    const original = preparation.readPreparedResourceEngineeringMetadata;
    let calls = 0;
    vi.spyOn(preparation, 'readPreparedResourceEngineeringMetadata').mockImplementation(input => {
      if (++calls === boundary) {
        const file = join(input.output, 'receipt.json');
        save(file, { ...JSON.parse(readFileSync(file, 'utf8')), enrollmentDigest: 'f'.repeat(64) });
      }
      return original(input);
    });
    expect(() => f.registry.prepare({ ...request, expectedPlanDigest: plan.planDigest }, { beforeNew() {}, beforePublication() {} }))
      .toThrow('Objective registration incomplete');
    expect(calls).toBe(boundary);
    expect(existsSync(join(f.root, 'console-engineering-preparations', 'records', `${request.id}.json`))).toBe(false);
    // Retain incomplete evidence rather than repairing it or executing work.
    expect(existsSync(join(f.config.outputRoot, request.id, 'receipt.json'))).toBe(true);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  });

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

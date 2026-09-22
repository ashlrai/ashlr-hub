/** Real private Git, preparation, supervisor, and owner boundaries. No evaluator,
 * native client, account, or worker is invoked. */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceConsoleEngineeringPreparation, validateResourceConsoleEngineeringObjective,
  validateResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation-types.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { createResourceConsoleEngineeringOwner, type ResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import * as privateFiles from '../src/core/util/private-file-write.js';

const roots: string[] = []; const owners: ResourceConsoleEngineeringOwner[] = []; const supervisors: ResourcePoolSupervisor[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
  await Promise.allSettled(supervisors.splice(0).map(owner => owner.close()));
  const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return; chmodSync(file, 0o700); for (const name of readdirSync(file)) writable(join(file, name)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))])) };
}
const request = { id: 'objective', profileId: 'pinned', name: 'Measured improvement', objective: 'Increase the value within the fixed checks.' };
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-preparation-boundary-'))); roots.push(base);
  const workspace = join(base, 'repo'); const transport = join(base, 'transport'); const outputRoot = join(base, 'prepared'); const root = join(base, 'ledger');
  mkdirSync(outputRoot, { mode: 0o700 });
  for (const path of [workspace, transport]) { mkdirSync(path, { mode: 0o700 }); git(path, 'init', '-q', '--template=', '--initial-branch=main'); }
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Preparation must not execute evaluator");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolFile = join(base, 'pool.json'); const bindingsFile = join(base, 'bindings.json'); const observationsFile = join(base, 'observations.json');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }], pool);
  save(poolFile, pool); save(bindingsFile, bindings); save(observationsFile, []);
  const resourceRuntime = join(base, 'runtime.json'); const runtime = { schemaVersion: 1, root, workspace: transport,
    poolPath: poolFile, bindingsPath: bindingsFile, observationsPath: observationsFile }; save(resourceRuntime, runtime);
  const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'template', name: 'Pinned template', objective: 'Fixed template objective', projectId: 'default',
    seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Improve value' }] }, delivery: { branch: 'codex/template', allowInitialRepair: true },
    execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot, resourceRuntime,
    profiles: [{ id: 'pinned', label: 'Fixed checks', acceptance: 'Only value may change; fixed evaluator applies.', recipe }] };
  const configFile = join(base, 'preparation.json'); save(configFile, config);
  const supervisor = await createResourcePoolSupervisor({ root, pool, bindings, workspace, projects: [], readObservations: () => [], pollIntervalMs: 60_000 });
  supervisors.push(supervisor);
  const ownerOptions = { root, poolFile, bindingsFile, observationsFile, supervisor, registrationEnabled: true as const };
  const newOwner = () => { const owner = createResourceConsoleEngineeringOwner(ownerOptions); owners.push(owner); return owner; };
  const owner = newOwner();
  const options = { configFile, config, root, workspace, projectsFile, poolFile, bindingsFile, observationsFile, owner };
  const create = () => createResourceConsoleEngineeringPreparation(options);
  return { base, root, workspace, outputRoot, runtime, resourceRuntime, recipe, config, configFile, options, owner, newOwner, create,
    bundle: join(outputRoot, request.id) };
}

describe('pinned console engineering preparation boundaries', () => {
  it('checks bounded public plans without any writes or registration and restores a committed bundle read-only', async () => {
    const f = await fixture(); const before = tree(f.base); const manager = f.create(); const plan = manager.check(request);
    expect(plan).toMatchObject({ status: 'planned', projectId: 'default', branch: 'codex/objective', executionStarted: false, providerContacted: false });
    expect(manager.profiles('default')).toHaveLength(1); expect(manager.profiles('other')).toEqual([]);
    expect(f.owner.catalog()).toEqual([]); expect(tree(f.base)).toEqual(before);
    const prepared = manager.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    expect(prepared.enrollment.id).toBe(request.id); expect(f.owner.snapshot(request.id).launched).toBe(false);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
    const saved = tree(f.base); expect(manager.prepare({ ...request, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
    const restored = f.newOwner(); const second = createResourceConsoleEngineeringPreparation({ ...f.options, owner: restored });
    expect(restored.catalog()).toEqual(f.owner.catalog()); expect(second.check(request)).toEqual(plan); expect(tree(f.base)).toEqual(saved);
    expect(git(f.workspace, 'show-ref', '--heads')).not.toContain('codex/objective');
  });
  it.each([null, {}, { ...request, command: 'forbidden' }, { ...request, id: '../escape' }, { ...request, objective: 'x'.repeat(8193) }])('rejects closed request violations %#', value => {
    expect(() => validateResourceConsoleEngineeringObjective(value)).toThrow();
  });
  it('never invokes request or profile getters', async () => {
    const f = await fixture(); const getter = vi.fn(() => 'secret'); const before = tree(f.base);
    expect(() => validateResourceConsoleEngineeringObjective({ ...request, get objective() { return getter(); } })).toThrow();
    expect(() => validateResourceConsoleEngineeringPreparationConfig({ ...f.config, get outputRoot() { return getter(); } })).toThrow();
    const profile = { ...f.config.profiles[0]!, recipe: { ...f.recipe, get seedRevision() { return getter(); } } };
    expect(() => validateResourceConsoleEngineeringPreparationConfig({ ...f.config, profiles: [profile] })).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before);
  });
  it.each(['config', 'configFile', 'owner'] as const)('rejects constructor option getter %s before reading it', async key => {
    const f = await fixture(); const options = { ...f.options }; const getter = vi.fn(() => f.options[key]);
    Object.defineProperty(options, key, { enumerable: true, get: getter }); const before = tree(f.base);
    expect(() => createResourceConsoleEngineeringPreparation(options)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(tree(f.base)).toEqual(before); expect(f.owner.catalog()).toEqual([]);
  });
  it('isolates captured constructor paths, config and owner from later caller mutation', async () => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request); const replacementOwner = f.newOwner();
    Object.assign(f.options, { configFile: join(f.base, 'redirected-config.json'), root: join(f.base, 'redirected-ledger'),
      workspace: join(f.base, 'redirected-workspace'), projectsFile: join(f.base, 'redirected-projects.json'),
      poolFile: join(f.base, 'redirected-pool.json'), bindingsFile: join(f.base, 'redirected-bindings.json'),
      observationsFile: join(f.base, 'redirected-observations.json'), owner: replacementOwner });
    f.options.config.profiles[0]!.recipe.generation.hypotheses[0]!.hypothesis = 'Mutated caller-only configuration';
    f.options.config.outputRoot = join(f.base, 'redirected-output');
    const before = tree(f.base); expect(manager.check(request)).toEqual(plan); expect(tree(f.base)).toEqual(before);
    expect(manager.prepare({ ...request, expectedPlanDigest: plan.planDigest }).enrollment.id).toBe(request.id);
    expect(f.owner.catalog().map(row => row.id)).toEqual([request.id]); expect(replacementOwner.catalog()).toEqual([]);
    expect(existsSync(f.bundle)).toBe(true); expect(readdirSync(f.base).some(name => name.startsWith('redirected-'))).toBe(false);
  });
  it.each(['extra-config', 'extra-recipe', 'unknown-worker', 'mutable-evaluator', 'unpinned-seed', 'unsafe-root'] as const)('refuses invalid pinned profile/config %s before output', async kind => {
    const f = await fixture();
    if (kind === 'extra-config') Object.assign(f.config, { activate: true });
    if (kind === 'extra-recipe') Object.assign(f.recipe, { execute: true });
    if (kind === 'unknown-worker') f.recipe.generation.allowedWorkerIds = ['missing'];
    if (kind === 'mutable-evaluator') f.recipe.generation.files = ['evaluate.mjs'];
    if (kind === 'unpinned-seed') f.recipe.seedRevision = 'HEAD';
    if (kind === 'unsafe-root') chmodSync(f.outputRoot, 0o755);
    save(f.configFile, f.config); const before = tree(f.base);
    expect(() => f.create()).toThrow(); expect(tree(f.base)).toEqual(before); expect(f.owner.catalog()).toEqual([]);
  });
  it('refuses a different accounting root before generating or enrolling anything', async () => {
    const f = await fixture(); save(f.resourceRuntime, { ...f.runtime, root: join(f.base, 'foreign-ledger') }); const before = tree(f.base);
    expect(() => f.create()).toThrow('this console resource ledger'); expect(tree(f.base)).toEqual(before);
  });
  it('pins live profile bytes and refuses request identity changes after preparation', async () => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request);
    manager.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    const before = tree(f.base);
    expect(() => manager.check({ ...request, objective: 'Changed objective' })).toThrow(); expect(tree(f.base)).toEqual(before);
    f.recipe.generation.hypotheses[0]!.hypothesis = 'Changed host hypothesis'; save(f.configFile, f.config); const changed = tree(f.base);
    expect(() => manager.check(request)).toThrow('profiles changed'); expect(() => f.create()).toThrow(); expect(tree(f.base)).toEqual(changed);
  });
  it('does not substitute a saved request when a prepare replay changes the objective', async () => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request);
    manager.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    const before = tree(f.base); const catalog = f.owner.catalog();
    expect(() => manager.prepare({ ...request, objective: 'A different objective must not reuse the original plan.',
      expectedPlanDigest: plan.planDigest })).toThrow();
    expect(tree(f.base)).toEqual(before); expect(f.owner.catalog()).toEqual(catalog);
    expect(manager.prepare({ ...request, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
    expect(tree(f.base)).toEqual(before);
  });
  it.each(['profile', 'runtime', 'comparator', 'receipt', 'project-directory'] as const)(
    'refuses %s drift after the real registration stage is written, before publication', async kind => {
      const f = await fixture(); const manager = f.create(); const plan = manager.check(request);
      const supervisorBefore = readFileSync(join(f.root, 'resource-console-state.json'));
      const headsBefore = git(f.workspace, 'show-ref', '--heads');
      const register = vi.spyOn(f.owner, 'register');
      const originalWrite = privateFiles.writePrivateFileAtomically;
      const registrationRoot = join(f.root, 'console-engineering-preparations');
      let changes = 0;
      vi.spyOn(privateFiles, 'writePrivateFileAtomically').mockImplementation((...args) => {
        const result = originalWrite(...args);
        if (!changes && args[1].startsWith(join(registrationRoot, 'staging') + '/')) {
          // Inject only after real stage durability, not before the earlier
          // validation callbacks. The actual writer must still veto its link.
          expect(existsSync(args[1])).toBe(true); changes++;
          if (kind === 'profile') {
            f.config.profiles[0]!.acceptance = 'Changed host acceptance'; save(f.configFile, f.config);
          } else if (kind === 'runtime') save(f.resourceRuntime, { ...f.runtime, capacityWaitMs: 1000 });
          else if (kind === 'comparator') {
            const evaluator = join(f.bundle, 'universe', 'universes', request.id, 'seed', 'evaluate.mjs');
            chmodSync(evaluator, 0o600); writeFileSync(evaluator, 'throw Error("Changed frozen comparator");\n');
          } else if (kind === 'receipt') {
            const receipt = join(f.bundle, 'receipt.json');
            save(receipt, { ...JSON.parse(readFileSync(receipt, 'utf8')), enrollmentDigest: 'f'.repeat(64) });
          } else {
            const retained = join(f.base, 'retained-project'); renameSync(f.workspace, retained);
            cpSync(retained, f.workspace, { recursive: true });
          }
        }
        return result;
      });
      expect(() => manager.prepare({ ...request, expectedPlanDigest: plan.planDigest })).toThrow();
      expect(changes).toBe(1); expect(register).not.toHaveBeenCalled(); expect(f.owner.catalog()).toEqual([]);
      expect(existsSync(join(registrationRoot, 'records', `${request.id}.json`))).toBe(false);
      expect(existsSync(join(f.bundle, 'receipt.json'))).toBe(true);
      expect(readFileSync(join(f.root, 'resource-console-state.json'))).toEqual(supervisorBefore);
      expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
      expect(git(f.workspace, 'show-ref', '--heads')).toBe(headsBefore);
    });
  it('preserves incomplete output instead of repairing or registering it', async () => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request);
    mkdirSync(f.bundle, { mode: 0o700 }); writeFileSync(join(f.bundle, 'partial'), 'do not delete', { mode: 0o600 }); const before = tree(f.base);
    expect(() => manager.prepare({ ...request, expectedPlanDigest: plan.planDigest })).toThrow();
    expect(tree(f.base)).toEqual(before); expect(f.owner.catalog()).toEqual([]);
  });
  it.each([null, false])('refuses a present invalid successor source %s in a real committed registration', async source => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request);
    manager.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    const file = join(f.root, 'console-engineering-preparations', 'records', `${request.id}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')); save(file, { ...record, source });
    const restored = f.newOwner(); const before = tree(f.base);
    expect(() => createResourceConsoleEngineeringPreparation({ ...f.options, owner: restored })).toThrow();
    expect(() => manager.check(request)).toThrow(); expect(restored.catalog()).toEqual([]);
    expect(tree(f.base)).toEqual(before);
  });
  it.each(['missing-bundle', 'missing-receipt', 'changed-receipt', 'changed-registry'] as const)('refuses unproven historical registration %s without reconstruction writes', async kind => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request); manager.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    if (kind === 'missing-bundle') renameSync(f.bundle, `${f.bundle}-retained`);
    if (kind === 'missing-receipt') unlinkSync(join(f.bundle, 'receipt.json'));
    if (kind === 'changed-receipt') save(join(f.bundle, 'receipt.json'), { schemaVersion: 1, changed: true });
    if (kind === 'changed-registry') {
      const directory = join(f.root, 'console-engineering-preparations');
      const find = (path: string): string | undefined => { for (const name of readdirSync(path)) { const file = join(path, name);
        if (lstatSync(file).isDirectory()) { const nested = find(file); if (nested) return nested; }
        else if (name === 'objective.json') return file; } };
      const file = find(directory)!; expect(file).toBeDefined(); const record = JSON.parse(readFileSync(file, 'utf8')); record.enrollmentDigest = 'f'.repeat(64); save(file, record);
    }
    const restored = f.newOwner(); const before = tree(f.base);
    expect(() => createResourceConsoleEngineeringPreparation({ ...f.options, owner: restored })).toThrow();
    expect(restored.catalog()).toEqual([]); expect(tree(f.base)).toEqual(before);
  });
});

/** Real private Git/bundle/registration reads. No owner, evaluator or provider executes. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceEngineeringPreparationRegistry } from '../src/core/resources/engineering-preparation-registry.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation-types.js';
import * as preparation from '../src/core/resources/engineering-preparation.js';
import * as commissioning from '../src/core/resources/console-engineering-check.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (file: string): void => {
    if (!lstatSync(file).isDirectory()) return;
    chmodSync(file, 0o700); for (const name of readdirSync(file)) writable(join(file, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))])) };
}
const request = { id: 'objective', profileId: 'profile', name: 'Measured work', objective: 'Change only the pinned value.' };

// Reuses the existing registry acceptance fixture's contracts, kept separate
// from its test module so importing this fixture cannot collect another suite.
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'registry-report-review-'))); roots.push(base);
  const workspace = join(base, 'repo'), transport = join(base, 'transport'), root = join(base, 'ledger'), outputRoot = join(base, 'prepared');
  for (const dir of [workspace, transport, root, outputRoot]) mkdirSync(dir, { mode: 0o700 });
  const git = (repo: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  for (const dir of [workspace, transport]) git(dir, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Report review must never execute evaluator");\n');
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
  const registry = createResourceEngineeringPreparationRegistry(options);
  const plan = registry.materialize(request).plan;
  const input = { ...request, expectedPlanDigest: plan.planDigest };
  const receiptFile = join(outputRoot, request.id, 'receipt.json');
  const registrationFile = join(root, 'console-engineering-preparations', 'records', request.id + '.json');
  const prepare = () => registry.prepare(input, { beforeNew() {}, beforePublication() {} });
  return { base, root, options, registry, input, receiptFile, registrationFile, prepare };
}

describe('independent preparation report boundaries', () => {
  it('keeps committed and public publish reports complete with real inspectors', () => {
    const f = fixture(); const prepared = f.prepare(); const registration = f.registry.registrations()[0]!;
    const recordBytes = readFileSync(f.registrationFile);
    const full = vi.spyOn(preparation, 'readPreparedResourceEngineeringBundle');
    const reports = vi.spyOn(commissioning, 'checkResourceConsoleEngineering');
    const committed = f.registry.committed(registration); const beforePublication = vi.fn();
    const published = f.registry.publish(registration, beforePublication);
    for (const verified of [committed, published]) {
      expect(verified.report).toHaveProperty('commissioning'); expect(verified.report).toHaveProperty('consoleArguments');
      expect(verified.report.enrollmentDigest).toBe(prepared.enrollmentDigest);
      expect(verified.catalog).toEqual(prepared.catalog);
    }
    expect(published.report).toEqual(committed.report);
    expect(full).toHaveBeenCalledTimes(2); expect(reports).toHaveBeenCalledTimes(2);
    expect(beforePublication).toHaveBeenCalled(); expect(readFileSync(f.registrationFile)).toEqual(recordBytes);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  }, 30_000);

  it('uses fresh metadata for read-only replay and refuses subsequent receipt drift', () => {
    const f = fixture(); const prepared = f.prepare(); const restored = createResourceEngineeringPreparationRegistry(f.options);
    const metadata = vi.spyOn(preparation, 'readPreparedResourceEngineeringMetadata');
    const full = vi.spyOn(preparation, 'readPreparedResourceEngineeringBundle');
    const creator = vi.spyOn(preparation, 'prepareResourceEngineeringBundle');
    const beforeNew = vi.fn(() => { throw new Error('Replay must never create'); }); const beforePublication = vi.fn();
    const before = tree(f.base);
    const replay = restored.prepare(f.input, { beforeNew, beforePublication });
    expect(replay).toEqual({ ...prepared, disposition: 'replayed' }); expect(tree(f.base)).toEqual(before);
    expect(metadata).toHaveBeenCalledOnce(); expect(full).not.toHaveBeenCalled(); expect(creator).not.toHaveBeenCalled();
    expect(beforeNew).not.toHaveBeenCalled(); expect(beforePublication).toHaveBeenCalledOnce();
    const receipt = JSON.parse(readFileSync(f.receiptFile, 'utf8')) as object;
    save(f.receiptFile, { ...receipt, enrollmentDigest: 'f'.repeat(64) }); const changed = tree(f.base);
    expect(() => restored.prepare(f.input, { beforeNew, beforePublication })).toThrow('Preparation receipt changed');
    expect(metadata).toHaveBeenCalledTimes(2); expect(tree(f.base)).toEqual(changed);
    expect(beforePublication).toHaveBeenCalledOnce(); expect(creator).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  }, 30_000);

  it('refuses a changed incoming objective before replay callbacks or bundle inspection', () => {
    const f = fixture(); f.prepare(); const before = tree(f.base);
    const metadata = vi.spyOn(preparation, 'readPreparedResourceEngineeringMetadata');
    const full = vi.spyOn(preparation, 'readPreparedResourceEngineeringBundle');
    const beforeNew = vi.fn(); const beforePublication = vi.fn();
    expect(() => f.registry.prepare({ ...f.input, objective: 'Different incoming task under the old identity.' },
      { beforeNew, beforePublication })).toThrow('Objective identity is already in use');
    expect(metadata).not.toHaveBeenCalled(); expect(full).not.toHaveBeenCalled();
    expect(beforeNew).not.toHaveBeenCalled(); expect(beforePublication).not.toHaveBeenCalled();
    expect(tree(f.base)).toEqual(before);
  }, 30_000);

  it('rechecks source evidence after the owner callback before publishing registration', () => {
    const f = fixture(); const metadata = vi.spyOn(preparation, 'readPreparedResourceEngineeringMetadata');
    const beforePublication = vi.fn(() => {
      const receipt = JSON.parse(readFileSync(f.receiptFile, 'utf8')) as object;
      save(f.receiptFile, { ...receipt, enrollmentDigest: 'f'.repeat(64) });
    });
    expect(() => f.registry.prepare(f.input, { beforeNew() {}, beforePublication })).toThrow('Objective registration incomplete');
    expect(beforePublication).toHaveBeenCalledOnce(); expect(metadata).toHaveBeenCalledTimes(2);
    expect(existsSync(f.registrationFile)).toBe(false); expect(f.registry.registrations()).toEqual([]);
    expect(existsSync(f.receiptFile)).toBe(true); // Retained incomplete evidence, never repaired.
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  }, 30_000);
});

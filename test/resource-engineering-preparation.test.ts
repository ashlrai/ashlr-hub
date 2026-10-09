/** Actual pinned registration, without starting a worker or evaluator. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as artifacts from '../src/core/universe/artifacts.js';
import { manifestRecord, universePath } from '../src/core/universe/store.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, type ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation.js';
import * as commissioning from '../src/core/resources/console-engineering-check.js';
import * as poolRuntime from '../src/core/resources/pool-runtime.js';

// Preserve real filesystem IO while exposing configurable exports for call-through observations.
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));

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
function inertEvaluator(f: ReturnType<typeof fixture>) {
  const path = join(f.base, 'never-executed-evaluator'), bytes = Buffer.alloc(600_013, 0x61);
  writeFileSync(path, bytes, { mode: 0o700 });
  fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
  f.options.recipe.evaluation = { command: [path, 'evaluate.mjs'], timeoutMs: 1000 };
  const selected = fs.lstatSync(path, { bigint: true });
  return { path, bytes, selected };
}
function observeEvaluatorReads(evaluator: ReturnType<typeof inertEvaluator>, afterFirstRead?: () => void) {
  const original = fs.readSync, buffers: number[] = []; let starts = 0, acted = false;
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) => {
    const count = Reflect.apply(original, fs, args), opened = fs.fstatSync(args[0], { bigint: true });
    if (opened.dev === evaluator.selected.dev && opened.ino === evaluator.selected.ino) {
      buffers.push(args[1].byteLength);
      if (args[4] === 0 && count > 0) starts++;
      if (!acted && count > 0 && afterFirstRead) { acted = true; afterFirstRead(); }
    }
    return count;
  }) as typeof fs.readSync);
  return { buffers, starts: () => starts, acted: () => acted };
}
describe('evaluated engineering preparation bridge', () => {
  it('refuses a raw built-in evaluator recipe before output creation or worker dispatch', () => {
    const f = fixture();
    const dispatch = vi.spyOn(poolRuntime, 'runResourceTask').mockImplementation(() => { throw new Error('Unexpected worker dispatch during preparation'); });
    // Simulate untyped JSON input; the authored recipe type is command-only.
    const recipe: unknown = { ...f.options.recipe, evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: 1000 } };
    expect(() => checkResourceEngineeringPreparation({ ...f.options, recipe })).toThrow('Preparation recipes require a command evaluator');
    expect(existsSync(f.options.output)).toBe(false); expect(existsSync(f.ledger)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
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
  it('streams each preparation capture and preserves legacy plan and persisted executable digests', () => {
    const f = fixture(), evaluator = inertEvaluator(f), legacyDigest = digest(evaluator.bytes);
    const reads = observeEvaluatorReads(evaluator), wholeFile = vi.spyOn(fs, 'readFileSync');
    const plan = checkResourceEngineeringPreparation(f.options);
    expect(reads.starts()).toBe(2); expect(reads.buffers.length).toBeGreaterThan(0);
    expect(Math.max(...reads.buffers)).toBeLessThanOrEqual(256 * 1024);
    expect(wholeFile.mock.calls.some(call => call[0] === evaluator.path)).toBe(false);
    // The old whole-byte algorithm yields the same pin, without rebuilding the
    // private pins object in this test. This substitution is never production proof.
    const identity = vi.spyOn(artifacts, 'evaluationExecutableDigest').mockImplementation(path => {
      expect(path).toBe(evaluator.path); return legacyDigest;
    });
    expect(checkResourceEngineeringPreparation(f.options).planDigest).toBe(plan.planDigest);
    expect(identity).toHaveBeenCalledTimes(2); identity.mockRestore();
    const prepared = prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest });
    expect(manifestRecord(universePath(prepared.paths.universeRoot, prepared.ids.universeId)).evaluationExecutableDigest).toBe(legacyDigest);
    expect(prepared.planDigest).toBe(plan.planDigest); expect(existsSync(f.ledger)).toBe(false);
    expect(wholeFile.mock.calls.some(call => call[0] === evaluator.path)).toBe(false);
  });
  it('reads changed executable bytes afresh despite retained inode, length and restored mtime', () => {
    const f = fixture(), evaluator = inertEvaluator(f), reads = observeEvaluatorReads(evaluator);
    const before = fs.statSync(evaluator.path), first = checkResourceEngineeringPreparation(f.options);
    expect(reads.starts()).toBe(2);
    writeFileSync(evaluator.path, Buffer.alloc(evaluator.bytes.length, 0x62));
    fs.utimesSync(evaluator.path, before.atime, before.mtime);
    const changed = fs.lstatSync(evaluator.path, { bigint: true });
    expect(changed.ino).toBe(evaluator.selected.ino); expect(changed.size).toBe(evaluator.selected.size);
    expect(changed.mtimeNs).toBe(evaluator.selected.mtimeNs);
    const second = checkResourceEngineeringPreparation(f.options);
    expect(second.planDigest).not.toBe(first.planDigest); expect(reads.starts()).toBe(4);
    expect(existsSync(f.options.output)).toBe(false); expect(existsSync(f.ledger)).toBe(false);
  });
  it('rejects executable mutation during a preparation capture without publishing or dispatching', () => {
    const f = fixture(), evaluator = inertEvaluator(f), before = fs.statSync(evaluator.path);
    const dispatch = vi.spyOn(poolRuntime, 'runResourceTask').mockImplementation(() => { throw new Error('Unexpected dispatch'); });
    const reads = observeEvaluatorReads(evaluator, () => {
      writeFileSync(evaluator.path, Buffer.alloc(evaluator.bytes.length, 0x62));
      fs.utimesSync(evaluator.path, before.atime, before.mtime);
    });
    expect(() => checkResourceEngineeringPreparation(f.options)).toThrow(/executable unavailable or changed/);
    expect(reads.acted()).toBe(true); expect(existsSync(f.options.output)).toBe(false);
    expect(existsSync(f.ledger)).toBe(false); expect(dispatch).not.toHaveBeenCalled();
  });

});

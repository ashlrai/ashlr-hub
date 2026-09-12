/** Real private Git and preparation; installed scoring identity/calibration are
 * explicitly synthetic. No evaluator, model, account or provider is executed. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as registry from '../src/core/universe/builtin-evaluator-registry.js';
import { PREPARATION_CALIBRATION_IMPLEMENTATION_FILES, parsePreparationMeasurementCalibration } from '../src/core/universe/preparation-measurement-calibration.js';
import { PREPARATION_SCENARIO_KEYS } from '../src/core/universe/preparation-measurement-comparison.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, readPreparedResourceEngineeringMetadata,
  type ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation.js';
import * as commissioning from '../src/core/resources/console-engineering-check.js';
import * as runtime from '../src/core/universe/resource-runtime-check.js';
import * as pool from '../src/core/resources/pool-runtime.js';
import * as enrollment from '../src/core/resources/console-engineering.js';
import * as campaigns from '../src/core/universe/campaign-store.js';
import { manifestRecord, universePath } from '../src/core/universe/store.js';

const TARGET = 'src/core/resources/engineering-preparation.ts';
const roots: string[] = [];
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))])) };
}
afterEach(() => {
  vi.restoreAllMocks();
  function writable(file: string) { if (!lstatSync(file).isDirectory()) return;
    chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); }
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-builtin-'))); roots.push(base);
  const workspace = join(base, 'repo'), transport = join(base, 'transport'), ledger = join(base, 'ledger');
  for (const directory of [workspace, transport]) {
    mkdirSync(directory, { mode: 0o700 }); git(directory, 'init', '-q', '--template=', '--initial-branch=main');
  }
  mkdirSync(dirname(join(workspace, TARGET)), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, TARGET), 'export const value = 1;\n', { mode: 0o644 });
  writeFileSync(join(workspace, 'README.md'), 'protected\n', { mode: 0o644 });
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const revision = git(workspace, 'rev-parse', 'HEAD');
  const files = ['README.md', TARGET].map(path => { const bytes = readFileSync(join(workspace, path));
    return { path, executable: false, bytes: bytes.length, sha256: digest(bytes) }; }).sort((a, b) => a.path.localeCompare(b.path));
  const gitPin = { path: '/Library/Developer/CommandLineTools/usr/bin/git', sha256: digest('synthetic Git') };
  const calibration = { schemaVersion: 1, kind: 'preparation-measurement-calibration', scope: 'diagnostic-only', universeId: 'baseline',
    manifestDigest: digest('manifest'), comparatorDigest: digest('comparator'),
    workload: { id: 'preparation-workflows-v2', evaluatorId: 'preparation-measurement-v1', digest: digest('synthetic measurement'),
      files: PREPARATION_CALIBRATION_IMPLEMENTATION_FILES.map(name => ({ name, sha256: digest(name) })),
      node: { path: process.execPath, sha256: digest('synthetic Node') }, tools: [gitPin], git: gitPin },
    baseline: { artifactDigest: digest(canonical(files.map(file => ({ path: file.path, executable: file.executable, size: file.bytes, digest: file.sha256 })))),
      revision, source: { path: TARGET, sha256: files.find(file => file.path === TARGET)!.sha256 }, files },
    provenance: ['a', 'b', 'c'].map(id => ({ captureId: id, intentDigest: digest(`${id} intent`), receiptDigest: digest(`${id} receipt`),
      reportDigest: digest('synthetic report'), reportBytes: 1, startedAt: '2026-09-12T00:00:00.000Z', finishedAt: '2026-09-12T00:00:01.000Z' })),
    scenarios: PREPARATION_SCENARIO_KEYS.map(key => ({ key, processes: 10, blobProcesses: 2 })), totalProcesses: 150 };
  const calibrationFile = join(base, 'calibration.json'); save(calibrationFile, calibration);
  parsePreparationMeasurementCalibration(readFileSync(calibrationFile, 'utf8'));
  const installed: registry.InstalledBuiltinEvaluator = { id: 'preparation-process-score-v1', digest: digest('synthetic installed'),
    executableDigest: digest(readFileSync(process.execPath)), command: [process.execPath, '--experimental-vm-modules', '--no-warnings', join(base, 'never-run.mjs')],
    files: [{ name: 'calibration.json', path: calibrationFile, digest: digest(readFileSync(calibrationFile)) }],
    tools: [{ path: gitPin.path, digest: gitPin.sha256 }], git: { path: gitPin.path, digest: gitPin.sha256 } };
  const resolve = vi.spyOn(registry, 'resolveBuiltinEvaluator').mockImplementation(() => structuredClone(installed));
  const dispatch = vi.spyOn(pool, 'runResourceTask').mockImplementation(() => { throw new Error('Unexpected provider dispatch'); });
  const poolPath = join(base, 'pool.json'), bindingsPath = join(base, 'bindings.json'), observationsPath = join(base, 'observations.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]); save(observationsPath, []);
  const resourceRuntime = join(base, 'runtime.json'); save(resourceRuntime, { schemaVersion: 1, root: ledger, workspace: transport, poolPath, bindingsPath, observationsPath });
  const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'improve', name: 'Improve verification', objective: 'Reduce verified subprocesses', projectId: 'default',
    seedRevision: revision, metric: { name: 'preparation_processes', direction: 'minimize', minImprovement: 1 },
    evaluation: { builtin: 'preparation-process-score-v1', timeoutMs: 1_800_000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 2_700_000, trialTimeoutMs: 2_700_000, workerTimeoutMs: 900_000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 5_400_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
    generation: { files: [TARGET], contextFiles: ['README.md'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'batch', niche: 'verification', hypothesis: 'Reduce repeated Git reads' }] }, delivery: { branch: 'codex/improve' },
    execution: { maxDurationMs: 5_400_000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 5_400_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 1 } };
  const options = { recipe, workspace, resourceRuntime, projectsFile, output: join(base, 'bundle') };
  return { base, options, installed, resolve, dispatch, ledger, calibration, calibrationFile };
}
function replaceCommit(f: ReturnType<typeof fixture>) {
  const repo = f.options.workspace;
  writeFileSync(join(repo, 'README.md'), 'replacement protected bytes\n'); git(repo, 'add', 'README.md');
  const replacement = git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', git(repo, 'write-tree'), '-m', 'private replacement fixture');
  git(repo, 'replace', f.options.recipe.seedRevision, replacement);
  expect(git(repo, 'rev-parse', `${f.options.recipe.seedRevision}^{commit}`)).toBe(f.options.recipe.seedRevision);
  expect(git(repo, 'cat-file', 'blob', `${f.options.recipe.seedRevision}:README.md`)).toBe('replacement protected bytes');
}

describe('closed builtin engineering preparation', () => {
  it('checks and prepares the exact scorer with split budgets, then replays without writes or dispatch', () => {
    const f = fixture(), before = tree(f.base), plan = checkResourceEngineeringPreparation(f.options);
    expect(tree(f.base)).toEqual(before);
    const input = { ...f.options, expectedPlanDigest: plan.planDigest };
    const prepared = prepareResourceEngineeringBundle(input);
    expect(JSON.parse(readFileSync(prepared.paths.manifest, 'utf8'))).toMatchObject({ evaluation: f.options.recipe.evaluation, budget: f.options.recipe.trialBudget });
    expect(JSON.parse(readFileSync(prepared.paths.campaign, 'utf8'))).toMatchObject({ measureSeed: true, feedback: true });
    const after = tree(f.base);
    expect(prepareResourceEngineeringBundle(input)).toEqual({ ...prepared, disposition: 'replayed' });
    expect(readPreparedResourceEngineeringMetadata(input)).toMatchObject({ planDigest: plan.planDigest, disposition: 'replayed' });
    expect(tree(f.base)).toEqual(after); expect(f.dispatch).not.toHaveBeenCalled(); expect(existsSync(f.ledger)).toBe(false);
    expect(f.resolve.mock.calls.every(([id]) => id === 'preparation-process-score-v1')).toBe(true);
  });
  it.each(['diagnostic', 'unknown', 'mixed', 'metric', 'direction', 'fractional-improvement', 'budget', 'target', 'extra-path', 'context'])(
    'refuses %s before creating output', kind => {
      const f = fixture(); const recipe = structuredClone(f.options.recipe);
      if (kind === 'diagnostic') Object.assign(recipe.evaluation, { builtin: 'preparation-measurement-v1' });
      if (kind === 'unknown') Object.assign(recipe.evaluation, { builtin: 'arbitrary-evaluator' });
      if (kind === 'mixed') Object.assign(recipe.evaluation, { command: [process.execPath] });
      if (kind === 'metric') recipe.metric.name = 'other';
      if (kind === 'direction') recipe.metric.direction = 'maximize';
      if (kind === 'fractional-improvement') recipe.metric.minImprovement = 0.5;
      if (kind === 'budget') recipe.trialBudget.workerTimeoutMs = 900_001;
      if (kind === 'target') recipe.generation.files = ['README.md'];
      if (kind === 'extra-path') recipe.generation.files.push('README.md');
      if (kind === 'context') recipe.generation.contextFiles.push('absent.md');
      expect(() => checkResourceEngineeringPreparation({ ...f.options, recipe })).toThrow();
      expect(existsSync(f.options.output)).toBe(false); expect(f.dispatch).not.toHaveBeenCalled();
    });
  it.each(['installed', 'command', 'tool', 'calibration'])( 'pins %s replacement across plan and registration', kind => {
    const f = fixture(), plan = checkResourceEngineeringPreparation(f.options);
    if (kind === 'installed') f.installed.digest = digest('changed');
    if (kind === 'command') f.installed.command.push('changed');
    if (kind === 'tool') f.installed.tools[0]!.digest = digest('changed');
    if (kind === 'calibration') writeFileSync(f.calibrationFile, 'changed');
    expect(() => prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow();
    expect(existsSync(f.options.output)).toBe(false); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('refuses registry absence and builtin drift during the last runtime check', () => {
    const f = fixture(); f.resolve.mockImplementationOnce(() => { throw new Error('Unavailable'); });
    expect(() => checkResourceEngineeringPreparation(f.options)).toThrow();
    const actual = runtime.checkResourceGenerationRuntime;
    vi.spyOn(runtime, 'checkResourceGenerationRuntime').mockImplementation(input => { const result = actual(input); f.installed.digest = digest('drift'); return result; });
    expect(() => checkResourceEngineeringPreparation(f.options)).toThrow(/installed evaluator changed/);
    expect(existsSync(f.options.output)).toBe(false);
  });
  it('refuses a changed installed scorer on committed metadata replay without rewriting it', () => {
    const f = fixture(), plan = checkResourceEngineeringPreparation(f.options), input = { ...f.options, expectedPlanDigest: plan.planDigest };
    prepareResourceEngineeringBundle(input); const before = tree(f.base); f.installed.digest = digest('changed');
    expect(() => readPreparedResourceEngineeringMetadata(input)).toThrow(); expect(tree(f.base)).toEqual(before);
  });
  it('withholds a successful report if the builtin changes during final commissioning', () => {
    const f = fixture(), plan = checkResourceEngineeringPreparation(f.options); const actual = commissioning.checkResourceConsoleEngineering;
    vi.spyOn(commissioning, 'checkResourceConsoleEngineering').mockImplementation(input => { const result = actual(input); f.installed.digest = digest('late'); return result; });
    expect(() => prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/installed evaluator changed/);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(['before-check', 'after-check'])('refuses a genuinely replaced materialized commit %s before campaign or catalog eligibility', when => {
    const f = fixture();
    if (when === 'before-check') replaceCommit(f);
    const plan = checkResourceEngineeringPreparation(f.options);
    if (when === 'after-check') replaceCommit(f);
    const catalog = vi.spyOn(enrollment, 'prepareResourceConsoleEngineeringEnrollments');
    const campaign = vi.spyOn(campaigns, 'initUniverseCampaign');
    expect(() => prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/materialized seed differs/);
    // Prove the real materializer reached the mismatched bytes, not an unrelated
    // refusal: its internally consistent record cannot satisfy calibrated scope.
    const record = manifestRecord(universePath(plan.paths.universeRoot, f.options.recipe.id));
    expect(record.seedArtifact.digest).not.toBe(f.calibration.baseline.artifactDigest);
    expect(readFileSync(join(record.seedArtifact.path, 'README.md'), 'utf8')).toBe('replacement protected bytes\n');
    expect(campaign).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
    expect(existsSync(plan.paths.receipt)).toBe(false); expect(existsSync(plan.paths.engineering)).toBe(false);
    expect(existsSync(join(f.options.output, 'intent.json'))).toBe(true);
    const after = tree(f.base);
    expect(() => prepareResourceEngineeringBundle({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/Incomplete preparation/);
    expect(tree(f.base)).toEqual(after);
  });
  it('replays the original retained seed after a replacement is added without adopting or writing the replacement', () => {
    const f = fixture(), plan = checkResourceEngineeringPreparation(f.options), input = { ...f.options, expectedPlanDigest: plan.planDigest };
    const prepared = prepareResourceEngineeringBundle(input); replaceCommit(f); const before = tree(f.base);
    expect(readPreparedResourceEngineeringMetadata(input)).toMatchObject({ planDigest: plan.planDigest, disposition: 'replayed' });
    expect(prepareResourceEngineeringBundle(input)).toEqual({ ...prepared, disposition: 'replayed' });
    const record = manifestRecord(universePath(plan.paths.universeRoot, f.options.recipe.id));
    expect(record.seedArtifact.digest).toBe(f.calibration.baseline.artifactDigest);
    expect(readFileSync(join(record.seedArtifact.path, 'README.md'), 'utf8')).toBe('protected\n');
    expect(tree(f.base)).toEqual(before); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(['extra-file', 'protected-bytes', 'protected-mode', 'target-mode'])( 'refuses seed %s outside the installed full calibration', kind => {
    const f = fixture();
    if (kind === 'extra-file') writeFileSync(join(f.options.workspace, 'extra.txt'), 'extra');
    if (kind === 'protected-bytes') writeFileSync(join(f.options.workspace, 'README.md'), 'changed');
    if (kind === 'protected-mode') chmodSync(join(f.options.workspace, 'README.md'), 0o755);
    if (kind === 'target-mode') chmodSync(join(f.options.workspace, TARGET), 0o755);
    git(f.options.workspace, 'add', '.'); git(f.options.workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'scope drift');
    f.options.recipe.seedRevision = git(f.options.workspace, 'rev-parse', 'HEAD');
    expect(() => checkResourceEngineeringPreparation(f.options)).toThrow(/installed scoring scope/);
    expect(existsSync(f.options.output)).toBe(false); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('reads the pinned Git seed, ignoring dirty checkout changes while allowing a target-only committed successor', () => {
    const f = fixture(), first = checkResourceEngineeringPreparation(f.options);
    writeFileSync(join(f.options.workspace, 'README.md'), 'uncommitted user changes');
    expect(checkResourceEngineeringPreparation(f.options).planDigest).toBe(first.planDigest);
    writeFileSync(join(f.options.workspace, TARGET), 'export const value = 2;\n'); git(f.options.workspace, 'add', TARGET);
    git(f.options.workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'target only');
    f.options.recipe.seedRevision = git(f.options.workspace, 'rev-parse', 'HEAD');
    const changed = checkResourceEngineeringPreparation(f.options);
    expect(changed.planDigest).not.toBe(first.planDigest);
    const input = { ...f.options, expectedPlanDigest: changed.planDigest };
    const prepared = prepareResourceEngineeringBundle(input);
    expect(readPreparedResourceEngineeringMetadata(input)).toMatchObject({ planDigest: prepared.planDigest });
    const record = manifestRecord(universePath(changed.paths.universeRoot, f.options.recipe.id));
    expect(record.seedArtifact.digest).not.toBe(f.calibration.baseline.artifactDigest);
    expect(readFileSync(join(record.seedArtifact.path, TARGET), 'utf8')).toBe('export const value = 2;\n');
    expect(readFileSync(join(f.options.workspace, 'README.md'), 'utf8')).toBe('uncommitted user changes');
  });
});

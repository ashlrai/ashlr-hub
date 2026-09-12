/** Synthetic private projects only. Most packaging cases mock esbuild; compiled
 * owner cases run the real bounded tiny-project compiler, never the workload. */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { inspectBuiltinEvaluatorBundle, inspectPreparationScoreBundle, PREPARATION_SCORE_FILES } from '../src/core/universe/builtin-evaluator-registry.js';
import { preparationCalibrationWorkload, type PreparationMeasurementCalibration } from '../src/core/universe/preparation-measurement-calibration.js';
import { PREPARATION_SCENARIO_KEYS } from '../src/core/universe/preparation-measurement-comparison.js';
import { parsePreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';
import { buildPreparationScoreBundle, buildPreparationScoringBuiltin } from '../scripts/build-preparation-score.mjs';
import { PREPARATION_TYPECHECK_OPTIONS, type PreparationTypecheckProject } from '../src/core/universe/preparation-typecheck-project.js';

const fake = vi.hoisted(() => ({ build: vi.fn(), calibrate: vi.fn(), author: vi.fn(), git: { path: '/fixed/developer/git', digest: 'e'.repeat(64) } }));
vi.mock('../scripts/evaluators/preparation-verification-native.mjs', () => ({
  resolvePreparationGit: () => ({ ...fake.git }), assertPreparationGit: (value: unknown) => {
    if (JSON.stringify(value) !== JSON.stringify(fake.git)) throw new Error('Invalid fixture Git');
  },
}));
vi.mock('../dist/core/universe/builtin-evaluator-registry.js', async () => import('../src/core/universe/builtin-evaluator-registry.js'));
vi.mock('../dist/core/universe/preparation-measurement-calibration.js', async () => ({
  ...await import('../src/core/universe/preparation-measurement-calibration.js'), calibratePreparationMeasurements: fake.calibrate,
}));
// The new compiled codec is intentionally absent until the parent's shared
// build. Redirect only that trusted module URL to its real source for this suite.
vi.mock('node:url', async original => {
  const actual = await original<typeof import('node:url')>();
  return { ...actual, pathToFileURL: (path: string) => actual.pathToFileURL(path.endsWith('/dist/core/universe/preparation-typecheck-project.js')
    ? path.replace('/dist/core/universe/preparation-typecheck-project.js', '/src/core/universe/preparation-typecheck-project.ts') : path) };
});
vi.mock('../scripts/build-preparation-typecheck.mjs', () => ({ authorPreparationTypecheckProject: fake.author }));
vi.mock('esbuild', () => ({ build: fake.build }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs', 'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs', 'preparation-verification-native.mjs',
  'preparation-verification-protocol.mjs', 'preparation-verification-tool.mjs', 'preparation-verification.mjs'];
const roots: string[] = [];
function write(path: string, bytes: string | Buffer) { fs.writeFileSync(path, bytes, { mode: 0o600 }); }
function changedCompilerReadWhen(enabled: () => boolean) {
  const selected = fs.lstatSync(join(repository, 'src/core/universe/preparation-typecheck.ts'), { bigint: true }), original = fs.readSync;
  return vi.spyOn(fs, 'readSync').mockImplementation(((...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) => {
    const count = Reflect.apply(original, fs, args), stat = fs.fstatSync(args[0], { bigint: true });
    if (enabled() && stat.dev === selected.dev && stat.ino === selected.ino && args[4] === 0 && count > 0) {
      const bytes = args[1] as Buffer; bytes[0] = bytes[0]! ^ 1;
    }
    return count;
  }) as typeof fs.readSync);
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'preparation-score-package-'))); roots.push(root);
  const measurementDirectory = join(root, 'original'), output = join(root, 'score');
  for (const path of [measurementDirectory, output]) fs.mkdirSync(path, { mode: 0o700 });
  const manifest = { schemaVersion: 1, id: 'preparation-measurement-v1', files: files.map(name => {
    const bytes = ['preparation-verification-activity.mjs', 'preparation-verification-native.mjs', 'preparation-verification-protocol.mjs'].includes(name)
      ? fs.readFileSync(join(repository, 'scripts/evaluators', name)) : Buffer.from(`// inert fixture ${name}\n`);
    write(join(measurementDirectory, name), bytes); return { name, digest: digest(bytes) };
  }) };
  // Deliberately noncanonical formatting: relocation must preserve these exact bytes.
  write(join(measurementDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const observed = inspectBuiltinEvaluatorBundle(measurementDirectory);
  const target = 'src/core/resources/engineering-preparation.ts', source = Buffer.from('export const fixture = 1;\n');
  // This is an explicit tiny synthetic compiler project, not the real Hub
  // closure or proof of three genuine baseline capture receipts.
  const typecheckProject: PreparationTypecheckProject = { schemaVersion: 1, kind: 'preparation-typecheck-project',
    compilerVersion: ts.version, baselineSourceSha256: digest(source), rootNames: [target],
    compilerOptions: { ...PREPARATION_TYPECHECK_OPTIONS, lib: ['ES2022'] }, files: [
      { path: 'node_modules/typescript/lib/lib.es2022.d.ts', text: 'interface Array<T> {length:number; [n:number]:T}\n' +
        'interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {} ' +
        'interface IArguments {} interface Number {} interface Object {} interface RegExp {} interface String {}\n' },
      { path: 'package.json', text: '{"type":"module"}' }, { path: target, text: source.toString('utf8') },
    ].sort((a, b) => a.path.localeCompare(b.path)) };
  const scenarios = PREPARATION_SCENARIO_KEYS.map(key => ({ key, processes: 10, blobProcesses: 1 }));
  const calibration: PreparationMeasurementCalibration = { schemaVersion: 1, kind: 'preparation-measurement-calibration', scope: 'diagnostic-only',
    universeId: 'fixture', manifestDigest: '1'.repeat(64), comparatorDigest: '2'.repeat(64),
    baseline: { revision: 'a'.repeat(40), source: { path: target, sha256: digest(source) },
      files: [{ path: target, executable: false, bytes: source.length, sha256: digest(source) }],
      artifactDigest: digest(canonical([{ path: target, executable: false, size: source.length, digest: digest(source) }])) },
    workload: preparationCalibrationWorkload(observed, 'preparation-workflows-v2'),
    provenance: [1, 2, 3].map(index => ({ captureId: `capture-${index}`, intentDigest: String(index).repeat(64), receiptDigest: String(index + 3).repeat(64),
      reportDigest: '9'.repeat(64), reportBytes: 100, startedAt: '2026-09-12T00:00:00.000Z', finishedAt: '2026-09-12T00:01:00.000Z' })),
    scenarios, totalProcesses: 150 };
  const calibrationFile = join(root, 'calibration.json'); write(calibrationFile, JSON.stringify(calibration) + '\n');
  fake.build.mockImplementation(async (options: { entryPoints: string[] }) => options.entryPoints[0]!.endsWith('/preparation-typecheck.mjs')
    ? { outputFiles: [{ contents: Buffer.from('// fixed inert compiler entry\n') }], metafile: {
      inputs: { 'scripts/evaluators/preparation-typecheck.mjs': {}, 'node_modules/typescript/lib/typescript.js': {},
        'src/core/universe/preparation-typecheck.ts': {}, 'src/core/universe/preparation-typecheck-project.ts': {},
        'closed-compiler-debug-support:unavailable': {} }, outputs: { compiler: { imports: [] } } } }
    : { outputFiles: [{ contents: Buffer.from('// fixed inert score entry\n') }], metafile: {
      inputs: { 'scripts/evaluators/preparation-score.mjs': {} }, outputs: { score: { imports: [{ path: './measurement/preparation-verification.mjs', external: true }] } } } });
  return { root, measurementDirectory, output, calibrationFile, calibration, observed, typecheckProject };
}
async function packaged() { const f = fixture(); await buildPreparationScoreBundle({ repository, ...f }); return f; }
function syntheticReport() {
  const methods = { manager: ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
    successor: ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'] };
  const workflows = Object.entries(methods).map(([name, methods]) => ({ name, processes: methods.length * 10, blobProcesses: methods.length,
    requests: methods.map((method, index) => ({ id: index + 1, method, processes: 10, blobProcesses: 1 })) }));
  const metrics: Record<string, number> = { correctness_checks: 23, verification_processes: 40, workflow_processes: 110,
    workflow_blob_processes: 11, fixture_owned_process_groups: 0, qualification_processes: 4, qualification_blob_processes: 0 };
  for (const key of ['files_1_check', 'files_1_metadata', 'files_4_check', 'files_4_metadata']) {
    metrics[`${key}_processes`] = 10; metrics[`${key}_blob_processes`] = 1;
  }
  return parsePreparationMeasurementReport(JSON.stringify({ schemaVersion: 1, kind: 'preparation-verification-measurement',
    workload: 'preparation-workflows-v2', checksPassed: true, metrics, workflows, diagnostics: [],
    qualifications: ['runtime-drift', 'source-drift'].map((name, index) => ({ name, processes: 2, blobProcesses: 0, injections: 1,
      requests: [1, 2].map(id => ({ id, method: index === 0 ? 'metadata' : 'successor-metadata', processes: 1, blobProcesses: 0 })) })) }));
}
async function realEntry(synthetic?: 'settled' | 'unsettled') {
  const native = await vi.importActual<typeof import('../scripts/evaluators/preparation-verification-native.mjs')>('../scripts/evaluators/preparation-verification-native.mjs');
  Object.assign(fake.git, native.resolvePreparationGit());
  const f = fixture(), esbuild = await vi.importActual<typeof import('esbuild')>('esbuild');
  if (synthetic) {
    // Explicit owner-integration stub, NOT evidence that any native correctness check ran.
    const name = 'preparation-verification.mjs';
    write(join(f.measurementDirectory, name), `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
export async function runPreparationWorkload(options) {
  const compiler = JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_BUILTIN_ACTIVITY, 'settled-1.json'), 'utf8'));
  if (compiler.settlement !== 'group-exit-confirmed') throw new Error('Compiler must settle before synthetic workload');
  writeFileSync(join(options.scratchRoot, 'synthetic-workload-invoked'), 'synthetic owner test', {mode:384,flag:'wx'});
  ${synthetic === 'unsettled' ? "options.activity.lifecycle('tool').prepare();" : ''}
  return ${JSON.stringify(syntheticReport())};
}\n`);
    const manifestFile = join(f.measurementDirectory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.files.find((row: { name: string }) => row.name === name).digest = digest(fs.readFileSync(join(f.measurementDirectory, name)));
    write(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    f.observed = inspectBuiltinEvaluatorBundle(f.measurementDirectory);
    f.calibration.workload = preparationCalibrationWorkload(f.observed, 'preparation-workflows-v2');
    write(f.calibrationFile, JSON.stringify(f.calibration) + '\n');
  }
  fake.build.mockImplementation(esbuild.build);
  await buildPreparationScoreBundle({ repository, ...f });
  const entry = await import(pathToFileURL(join(f.output, 'preparation-score.mjs')).href) as {
    runPreparationScore(): Promise<{ passed: boolean; score: number; metrics: Record<string, number>; diagnostics?: Array<{ code: string }> }>;
  };
  return { ...f, entry };
}
function rewriteOuter(output: string) {
  write(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'preparation-process-score-v1',
    files: PREPARATION_SCORE_FILES.map(name => ({ name, digest: digest(fs.readFileSync(join(output, name))) })) }) + '\n');
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); fake.build.mockReset(); fake.calibrate.mockReset(); fake.author.mockReset();
  fake.git.path = '/fixed/developer/git'; fake.git.digest = 'e'.repeat(64);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('explicit nested preparation scoring packaging', () => {
  it.each(['baseline', 'bom', 'ill-typed'] as const)('the real bundled compiler checks a synthetic %s target without emitting files', async kind => {
    const f = await realEntry();
    const source = kind === 'ill-typed' ? 'export const fixture: string = 1;\n' : `${kind === 'bom' ? '\uFEFF' : ''}export const fixture = 1;\n`;
    const project = join(f.output, 'preparation-typecheck-project.json');
    const before = fs.readdirSync(f.output, { recursive: true });
    const result = spawnSync(process.execPath, ['--max-old-space-size=1024', join(f.output, 'preparation-typecheck.mjs'), project], {
      cwd: f.root, env: { HOME: f.root, TMPDIR: f.root, PATH: '/usr/bin:/bin' }, timeout: 10_000, maxBuffer: 8192, encoding: 'utf8',
      input: JSON.stringify({ schemaVersion: 1, source, sourceSha256: digest(source), projectSha256: digest(fs.readFileSync(project)) }),
    });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.signal).toBeNull(); expect(result.stderr).toBe('');
    const checked = JSON.parse(result.stdout);
    expect(checked).toMatchObject({ schemaVersion: 1, kind: 'preparation-typecheck-result', passed: kind !== 'ill-typed',
      sourceSha256: digest(source), projectSha256: digest(fs.readFileSync(project)) });
    if (kind !== 'ill-typed') expect(checked.diagnosticCodes).toEqual([]);
    else expect(checked.diagnosticCodes).toContain(2322);
    expect(fs.readdirSync(f.output, { recursive: true })).toEqual(before);
  });

  it('builds the actual fixed entry and reconstructs the host identity on import without starting a workload', async () => {
    // Real native identity reads only: no Git command, evaluator or candidate is invoked.
    const native = await vi.importActual<typeof import('../scripts/evaluators/preparation-verification-native.mjs')>('../scripts/evaluators/preparation-verification-native.mjs');
    Object.assign(fake.git, native.resolvePreparationGit());
    const f = fixture();
    const esbuild = await vi.importActual<typeof import('esbuild')>('esbuild');
    fake.build.mockImplementation(esbuild.build);
    await buildPreparationScoreBundle({ repository, ...f });
    const compiler = await fake.build.mock.results[1]!.value as import('esbuild').BuildResult;
    expect(Object.values(compiler.metafile!.outputs).flatMap(output => output.imports).every(row => isBuiltin(row.path))).toBe(true);
    expect(Object.keys(compiler.metafile!.inputs)).toContain('node_modules/typescript/lib/typescript.js');
    expect(Object.keys(compiler.metafile!.inputs)).toContain('closed-compiler-debug-support:unavailable');
    const selected = inspectPreparationScoreBundle(f.output);
    const writes = vi.spyOn(process.stdout, 'write');
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const entry = await import(pathToFileURL(join(f.output, 'preparation-score.mjs')).href) as {
      inspectPreparationScoreIdentity(path: string): { digest: string; calibrationJson: string; workload: unknown; git: unknown };
    };
    expect(writes).not.toHaveBeenCalled();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    const identity = entry.inspectPreparationScoreIdentity(f.output);
    expect(identity.digest).toBe(selected.digest);
    expect(identity.workload).toEqual(f.calibration.workload);
    expect(identity.git).toEqual(selected.git);
    expect(identity.calibrationJson).toBe(fs.readFileSync(f.calibrationFile, 'utf8'));
    expect(fs.readdirSync(f.root).sort()).toEqual(['calibration.json', 'original', 'score']);
  });

  it.each(['missing-activity', 'wrong-argv', 'expired', 'completion-failure'] as const)('the compiled entry refuses %s without workload dispatch or leaked listeners/output', async kind => {
    const f = await realEntry(), activityRoot = join(f.root, 'activity'); fs.mkdirSync(activityRoot, { mode: 0o700 });
    write(join(activityRoot, 'owner.json'), JSON.stringify({ schemaVersion: 1, invocationId: 'a'.repeat(64),
      implementationDigest: '0'.repeat(64), deadlineAt: new Date(Date.now() + (kind === 'expired' ? -1000 : 60000)).toISOString() }));
    const priorArgv = process.argv;
    process.argv = [process.execPath, join(f.output, 'preparation-score.mjs'), kind === 'wrong-argv' ? '/wrong' : join(f.output, 'measurement/preparation-bridge.mjs')];
    vi.stubEnv('ASHLR_UNIVERSE_BUILTIN_ACTIVITY', kind === 'missing-activity' ? undefined : activityRoot);
    let injected = false;
    if (kind === 'completion-failure') {
      const original = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
        const observed = Reflect.apply(original, fs, args);
        // Tracker is already constructed when the entry begins its identity check.
        if (!injected && args[0] === f.output) { injected = true; write(join(activityRoot, 'unexpected.json'), '{}'); }
        return observed;
      }) as typeof fs.lstatSync);
    }
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], writes = vi.spyOn(process.stdout, 'write');
    try {
      const result = await f.entry.runPreparationScore();
      expect(result.passed).toBe(false);
      expect(result.diagnostics?.[0]!.code).toBe(kind === 'expired' ? 'PREPARATION_SCORE_CANCELLED_OR_EXPIRED'
        : kind === 'completion-failure' ? 'PROCESS_SETTLEMENT_UNCONFIRMED' : 'PREPARATION_SCORE_INITIALIZATION_FAILED');
      expect(writes).not.toHaveBeenCalled();
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
      expect(fs.readdirSync(activityRoot).some(name => name.startsWith('prepared-') || name.startsWith('spawned-'))).toBe(false);
      if (kind === 'expired') expect(JSON.parse(fs.readFileSync(join(activityRoot, 'complete.json'), 'utf8')).count).toBe(0);
      if (kind === 'completion-failure') { expect(injected).toBe(true); expect(fs.existsSync(join(activityRoot, 'complete.json'))).toBe(false); }
      expect(fs.readdirSync(f.root).some(name => name.startsWith('verification-'))).toBe(false);
    } finally { process.argv = priorArgv; }
  });

  it.each(['settled', 'bom', 'unsettled', 'scope-violation', 'type-error'] as const)('the compiled owner handles a synthetic %s workload without claiming native qualification', async kind => {
    const f = await realEntry(kind === 'unsettled' ? 'unsettled' : 'settled');
    const candidate = join(f.root, 'candidate'), target = join(candidate, f.calibration.baseline.source.path);
    fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); write(target, 'export const fixture = 1;\n');
    if (kind === 'scope-violation') write(join(candidate, 'extra.txt'), 'outside target scope');
    if (kind === 'type-error') write(target, 'export const fixture: string = 1;\n');
    if (kind === 'bom') write(target, '\uFEFFexport const fixture = 1;\n');
    const activityRoot = join(f.root, 'owner'); fs.mkdirSync(activityRoot, { mode: 0o700 });
    const identity = inspectPreparationScoreBundle(f.output);
    const activity = await import(pathToFileURL(join(f.output, 'measurement/preparation-verification-activity.mjs')).href) as {
      initializeBuiltinActivity(root: string, owner: unknown): void;
    };
    activity.initializeBuiltinActivity(activityRoot, { schemaVersion: 1, invocationId: 'c'.repeat(64),
      implementationDigest: identity.digest, deadlineAt: new Date(Date.now() + 60000).toISOString() });
    vi.stubEnv('ASHLR_UNIVERSE_BUILTIN_ACTIVITY', activityRoot);
    vi.stubEnv('ASHLR_UNIVERSE_BUILTIN_GIT', JSON.stringify(identity.git));
    vi.stubEnv('ASHLR_UNIVERSE_CANDIDATE', candidate); vi.stubEnv('HOME', f.root);
    const priorArgv = process.argv;
    process.argv = [process.execPath, join(f.output, 'preparation-score.mjs'), join(f.output, 'measurement/preparation-bridge.mjs')];
    const writes = vi.spyOn(process.stdout, 'write'), publications = vi.spyOn(fs, 'linkSync');
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    try {
      const result = await f.entry.runPreparationScore();
      if (kind === 'settled' || kind === 'bom') {
        expect(result.passed).toBe(true); expect(result.score).toBe(150);
        expect(result.metrics).toMatchObject({ baseline_processes: 150, candidate_processes: 150, process_delta: 0, improved: 0 });
      } else {
        expect(result.passed).toBe(false);
        expect(result.diagnostics?.[0]?.code).toBe(kind === 'unsettled' ? 'PROCESS_SETTLEMENT_UNCONFIRMED'
          : kind === 'type-error' ? 'PREPARATION_SCORE_TYPECHECK_FAILED' : 'PREPARATION_SCORE_SCOPE_FAILED');
      }
      const complete = join(activityRoot, 'complete.json');
      if (kind === 'unsettled') {
        expect(fs.existsSync(complete)).toBe(false); expect(fs.existsSync(join(activityRoot, 'prepared-2.json'))).toBe(true);
      } else {
        expect(JSON.parse(fs.readFileSync(complete, 'utf8')).count).toBe(kind === 'scope-violation' ? 0 : 1);
        expect(publications.mock.calls.filter(([, target]) => target === complete)).toHaveLength(1);
      }
      expect(fs.existsSync(join(f.root, 'synthetic-workload-invoked'))).toBe(['settled', 'bom', 'unsettled'].includes(kind));
      expect(fs.readdirSync(activityRoot).filter(name => name.startsWith('spawned-'))).toHaveLength(kind === 'scope-violation' ? 0 : 1);
      if (kind !== 'scope-violation') expect(JSON.parse(fs.readFileSync(join(activityRoot, 'settled-1.json'), 'utf8')))
        .toMatchObject({ kind: 'tool', phase: 'settled', settlement: 'group-exit-confirmed' });
      expect(writes).not.toHaveBeenCalled();
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
    } finally { process.argv = priorArgv; }
  });

  it('preserves all nine measured files and original manifest while pinning the separate score entry', async () => {
    const f = await packaged(), selected = inspectPreparationScoreBundle(f.output);
    expect(selected.id).toBe('preparation-process-score-v1');
    expect(selected.files.map(row => row.name)).toEqual(PREPARATION_SCORE_FILES);
    expect(selected.command).toEqual([process.execPath, '--experimental-vm-modules', '--no-warnings',
      join(f.output, 'preparation-score.mjs'), join(f.output, 'measurement/preparation-bridge.mjs')]);
    expect(inspectBuiltinEvaluatorBundle(join(f.output, 'measurement')).digest).toBe(f.observed.digest);
    for (const name of [...files, 'manifest.json']) expect(fs.readFileSync(join(f.output, 'measurement', name)))
      .toEqual(fs.readFileSync(join(f.measurementDirectory, name)));
    expect(selected.digest).not.toBe(f.observed.digest);
    expect(fake.build).toHaveBeenCalledTimes(2);
    expect(fake.build.mock.calls[0]![0].entryPoints).toEqual([join(repository, 'scripts/evaluators/preparation-score.mjs')]);
    expect(fake.build.mock.calls[0]![0].external).toEqual(files.map(name => `./measurement/${name}`));
    expect(fake.build.mock.calls[1]![0].entryPoints).toEqual([join(repository, 'scripts/evaluators/preparation-typecheck.mjs')]);
    expect(fake.build.mock.calls[1]![0].external).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(join(f.output, 'preparation-typecheck-project.json'), 'utf8'))).toEqual(f.typecheckProject);
  });

  it('pins exact calibration bytes in the outer identity, never in the original measurement identity', async () => {
    const f = await packaged(), before = inspectPreparationScoreBundle(f.output);
    fs.appendFileSync(join(f.output, 'calibration.json'), ' '); rewriteOuter(f.output);
    expect(inspectPreparationScoreBundle(f.output).digest).not.toBe(before.digest);
    expect(inspectBuiltinEvaluatorBundle(join(f.output, 'measurement')).digest).toBe(f.observed.digest);
  });

  it.each(['missing', 'source-hash', 'source-text', 'compiler-policy'] as const)('refuses invalid type project %s before compilation or publication', async kind => {
    const f = fixture();
    if (kind === 'source-hash') f.typecheckProject.baselineSourceSha256 = 'f'.repeat(64);
    if (kind === 'source-text') f.typecheckProject.files.find(file => file.path === f.calibration.baseline.source.path)!.text = 'export const changed = 1;';
    if (kind === 'compiler-policy') f.typecheckProject.compilerOptions.strict = false;
    await expect(buildPreparationScoreBundle({ repository, ...f,
      typecheckProject: kind === 'missing' ? undefined! : f.typecheckProject })).rejects.toThrow();
    expect(fake.build).not.toHaveBeenCalled(); expect(fs.readdirSync(f.output)).toEqual([]);
  });

  it.each(['missing-child', 'missing-project', 'corrupt-project', 'foreign-source', 'child-bytes', 'project-bytes'] as const)(
    'refuses installed compiler custody %s before dispatch', async kind => {
      const f = await packaged(), child = join(f.output, 'preparation-typecheck.mjs'), project = join(f.output, 'preparation-typecheck-project.json');
      if (kind === 'missing-child') fs.unlinkSync(child);
      if (kind === 'missing-project') fs.unlinkSync(project);
      if (kind === 'corrupt-project') { write(project, '{}'); rewriteOuter(f.output); }
      if (kind === 'foreign-source') {
        const value = JSON.parse(fs.readFileSync(project, 'utf8'));
        const text = 'export const otherBaseline = 2;\n'; value.baselineSourceSha256 = digest(text);
        value.files.find((file: { path: string }) => file.path === f.calibration.baseline.source.path).text = text;
        write(project, JSON.stringify(value)); rewriteOuter(f.output);
      }
      if (kind === 'child-bytes') fs.appendFileSync(child, '// drift');
      if (kind === 'project-bytes') fs.appendFileSync(project, ' ');
      expect(() => inspectPreparationScoreBundle(f.output)).toThrow('Installed built-in evaluator unavailable or changed');
    });

  it('pins compiler entry and project bytes only in the outer identity', async () => {
    const f = await packaged(), before = inspectPreparationScoreBundle(f.output);
    fs.appendFileSync(join(f.output, 'preparation-typecheck.mjs'), '// trusted replacement'); rewriteOuter(f.output);
    const compilerChanged = inspectPreparationScoreBundle(f.output);
    expect(compilerChanged.digest).not.toBe(before.digest);
    fs.appendFileSync(join(f.output, 'preparation-typecheck-project.json'), ' '); rewriteOuter(f.output);
    expect(inspectPreparationScoreBundle(f.output).digest).not.toBe(compilerChanged.digest);
    expect(inspectBuiltinEvaluatorBundle(join(f.output, 'measurement')).digest).toBe(f.observed.digest);
  });

  it.each(['external-package', 'missing-compiler', 'candidate-source'] as const)('refuses a compiler graph with %s before publication', async kind => {
    const f = fixture(), original = fake.build.getMockImplementation()!;
    fake.build.mockImplementation(async (options: { entryPoints: string[] }) => {
      const result = await original(options);
      if (options.entryPoints[0]!.endsWith('/preparation-typecheck.mjs')) {
        if (kind === 'external-package') result.metafile.outputs.compiler.imports.push({ path: 'typescript', external: true });
        if (kind === 'missing-compiler') delete result.metafile.inputs['node_modules/typescript/lib/typescript.js'];
        if (kind === 'candidate-source') result.metafile.inputs['src/core/resources/engineering-preparation.ts'] = {};
      }
      return result;
    });
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(fs.readdirSync(f.output)).toEqual([]);
  });

  it.each(['workload-version', 'aggregate', 'node', 'git', 'file'] as const)('refuses mismatched %s calibration before building or copying', async kind => {
    const f = fixture();
    if (kind === 'workload-version') f.calibration.workload.id = 'preparation-workflows-v1';
    if (kind === 'aggregate') f.calibration.workload.digest = 'a'.repeat(64);
    if (kind === 'node') f.calibration.workload.node.sha256 = 'a'.repeat(64);
    if (kind === 'git') f.calibration.workload.git.sha256 = 'a'.repeat(64);
    if (kind === 'file') f.calibration.workload.files[0]!.sha256 = 'a'.repeat(64);
    write(f.calibrationFile, JSON.stringify(f.calibration));
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(fake.build).not.toHaveBeenCalled(); expect(fs.readdirSync(f.output)).toEqual([]);
  });

  it.each(['file', 'manifest', 'extra', 'symlink', 'hardlink', 'writable', 'calibration', 'row-order'] as const)('refuses changed installed score custody: %s', async kind => {
    const f = await packaged(), target = join(f.output, 'preparation-score.mjs');
    if (kind === 'file') fs.appendFileSync(target, '// changed');
    if (kind === 'manifest') fs.appendFileSync(join(f.output, 'measurement/manifest.json'), ' ');
    if (kind === 'extra') write(join(f.output, 'unlisted'), 'extra');
    if (kind === 'symlink') { fs.renameSync(target, join(f.root, 'outside')); fs.symlinkSync(join(f.root, 'outside'), target); }
    if (kind === 'hardlink') fs.linkSync(target, join(f.root, 'second-link'));
    if (kind === 'writable') fs.chmodSync(target, 0o620);
    if (kind === 'calibration') { f.calibration.workload.digest = 'a'.repeat(64); write(join(f.output, 'calibration.json'), JSON.stringify(f.calibration)); rewriteOuter(f.output); }
    if (kind === 'row-order') { const value = JSON.parse(fs.readFileSync(join(f.output, 'manifest.json'), 'utf8')); value.files.reverse(); write(join(f.output, 'manifest.json'), JSON.stringify(value)); }
    expect(() => inspectPreparationScoreBundle(f.output)).toThrow('Installed built-in evaluator unavailable or changed');
  });

  it('refuses a nonempty output without overwriting an existing file', async () => {
    const f = fixture(); write(join(f.output, 'keep'), 'untouched');
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(fs.readFileSync(join(f.output, 'keep'), 'utf8')).toBe('untouched'); expect(fake.build).not.toHaveBeenCalled();
  });

  it('refuses source drift during the build before publishing a score manifest', async () => {
    const f = fixture(), build = fake.build.getMockImplementation()!;
    fake.build.mockImplementation(async (...args: unknown[]) => { const result = await build(...args); fs.appendFileSync(join(f.measurementDirectory, files[0]!), '// drift'); return result; });
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(fs.readdirSync(f.output)).toEqual([]);
  });

  it('does not authorize an entry substituted after compilation by hashing the changed output', async () => {
    const f = fixture(), original = fs.writeFileSync; let injected = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      const result = Reflect.apply(original, fs, args);
      if (!injected && args[0] === join(f.output, 'preparation-score.mjs')) {
        injected = true; original(join(f.output, 'preparation-score.mjs'), '// substituted after write');
      }
      return result;
    }) as typeof fs.writeFileSync);
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(injected).toBe(true); expect(fs.existsSync(join(f.output, 'manifest.json'))).toBe(false);
  });

  it.each(['after-mkdir', 'between-files'] as const)('refuses a nested-directory symlink replacement %s before writing outside', async moment => {
    const f = fixture(), target = join(f.output, 'measurement'), outside = join(f.root, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 }); let injected = false;
    const swap = () => { injected = true; fs.renameSync(target, join(f.root, 'original-output-directory')); fs.symlinkSync(outside, target); };
    if (moment === 'after-mkdir') {
      const original = fs.mkdirSync;
      vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
        const result = Reflect.apply(original, fs, args);
        if (!injected && args[0] === target) swap();
        return result;
      }) as typeof fs.mkdirSync);
    } else {
      const original = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
        const result = Reflect.apply(original, fs, args);
        if (!injected && args[0] === join(target, 'manifest.json')) swap();
        return result;
      }) as typeof fs.writeFileSync);
    }
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(injected).toBe(true); expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(join(f.output, 'manifest.json'))).toBe(false);
  });

  it('rechecks outer directory identity before the next outer publication', async () => {
    const f = fixture(), outside = join(f.root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
    const original = fs.writeFileSync; let injected = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      const result = Reflect.apply(original, fs, args);
      if (!injected && args[0] === join(f.output, 'preparation-score.mjs')) {
        injected = true; fs.renameSync(f.output, join(f.root, 'original-output-directory')); fs.symlinkSync(outside, f.output);
      }
      return result;
    }) as typeof fs.writeFileSync);
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(injected).toBe(true); expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('production authoring refuses missing actual captures before compilation or installation', async () => {
    fake.calibrate.mockImplementation(() => { throw new Error('No real capture records'); });
    const capture = { root: '/explicit/private', universeId: 'baseline', captureIds: ['a', 'b', 'c'] as [string, string, string], expectedSourceDigest: 'a'.repeat(64) };
    await expect(buildPreparationScoringBuiltin({ measurementDirectory: '/explicit/frozen', capture })).rejects.toThrow('No real capture records');
    expect(fake.calibrate).toHaveBeenCalledExactlyOnceWith(capture); expect(fake.build).not.toHaveBeenCalled();
    expect(fake.author).not.toHaveBeenCalled();
  });

  it('requires a clean real-project authoring result after calibration and before any installation', async () => {
    const f = fixture(); fake.calibrate.mockReturnValue(f.calibration);
    fake.author.mockRejectedValue(new Error('Real project does not compile'));
    const mkdir = vi.spyOn(fs, 'mkdirSync'), capture = { root: '/explicit/private', universeId: 'baseline',
      captureIds: ['a', 'b', 'c'] as [string, string, string], expectedSourceDigest: f.calibration.baseline.source.sha256 };
    await expect(buildPreparationScoringBuiltin({ measurementDirectory: f.measurementDirectory, capture })).rejects.toThrow('Real project does not compile');
    expect(fake.author).toHaveBeenCalledExactlyOnceWith({ repository, expectedSourceSha256: f.calibration.baseline.source.sha256 });
    expect(fake.calibrate.mock.invocationCallOrder[0]).toBeLessThan(fake.author.mock.invocationCallOrder[0]!);
    expect(fake.build).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
  });

  it('refuses compiler source drift after asynchronous compilation without publishing', async () => {
    const f = fixture(), original = fake.build.getMockImplementation()!; let changed = false;
    changedCompilerReadWhen(() => changed);
    fake.build.mockImplementation(async (options: { entryPoints: string[] }) => {
      const result = await original(options); if (options.entryPoints[0]!.endsWith('/preparation-typecheck.mjs')) changed = true; return result;
    });
    await expect(buildPreparationScoreBundle({ repository, ...f })).rejects.toThrow();
    expect(changed).toBe(true); expect(fs.readdirSync(f.output)).toEqual([]);
  });

  it('refuses compiler source drift across real-project authoring before creating installation output', async () => {
    const f = fixture(); fake.calibrate.mockReturnValue(f.calibration); let changed = false;
    changedCompilerReadWhen(() => changed);
    fake.author.mockImplementation(async () => { changed = true; return f.typecheckProject; });
    const mkdir = vi.spyOn(fs, 'mkdirSync'), capture = { root: '/explicit/private', universeId: 'baseline',
      captureIds: ['a', 'b', 'c'] as [string, string, string], expectedSourceDigest: f.calibration.baseline.source.sha256 };
    await expect(buildPreparationScoringBuiltin({ measurementDirectory: f.measurementDirectory, capture })).rejects.toThrow();
    expect(changed).toBe(true); expect(fake.build).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
  });
});

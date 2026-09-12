/** Fixture files only. Git pin and esbuild are mocked; no command or evaluator starts. */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { inspectBuiltinEvaluatorBundle, inspectPreparationScoreBundle, PREPARATION_SCORE_FILES } from '../src/core/universe/builtin-evaluator-registry.js';
import { preparationCalibrationWorkload, type PreparationMeasurementCalibration } from '../src/core/universe/preparation-measurement-calibration.js';
import { PREPARATION_SCENARIO_KEYS } from '../src/core/universe/preparation-measurement-comparison.js';
import { parsePreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';
import { buildPreparationScoreBundle, buildPreparationScoringBuiltin } from '../scripts/build-preparation-score.mjs';

const fake = vi.hoisted(() => ({ build: vi.fn(), calibrate: vi.fn(), git: { path: '/fixed/developer/git', digest: 'e'.repeat(64) } }));
vi.mock('../scripts/evaluators/preparation-verification-native.mjs', () => ({
  resolvePreparationGit: () => ({ ...fake.git }), assertPreparationGit: (value: unknown) => {
    if (JSON.stringify(value) !== JSON.stringify(fake.git)) throw new Error('Invalid fixture Git');
  },
}));
vi.mock('../dist/core/universe/builtin-evaluator-registry.js', async () => import('../src/core/universe/builtin-evaluator-registry.js'));
vi.mock('../dist/core/universe/preparation-measurement-calibration.js', async () => ({
  ...await import('../src/core/universe/preparation-measurement-calibration.js'), calibratePreparationMeasurements: fake.calibrate,
}));
vi.mock('esbuild', () => ({ build: fake.build }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs', 'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs', 'preparation-verification-native.mjs',
  'preparation-verification-protocol.mjs', 'preparation-verification-tool.mjs', 'preparation-verification.mjs'];
const roots: string[] = [];
function write(path: string, bytes: string | Buffer) { fs.writeFileSync(path, bytes, { mode: 0o600 }); }
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
  const target = 'src/core/resources/engineering-preparation.ts', source = Buffer.from('fixture source\n');
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
  fake.build.mockImplementation(async () => ({ outputFiles: [{ contents: Buffer.from('// fixed inert score entry\n') }], metafile: {
    inputs: { 'scripts/evaluators/preparation-score.mjs': {} }, outputs: { score: { imports: [{ path: './measurement/preparation-verification.mjs', external: true }] } },
  } }));
  return { root, measurementDirectory, output, calibrationFile, calibration, observed };
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
    write(join(f.measurementDirectory, name), `import {writeFileSync} from 'node:fs';import {join} from 'node:path';
export async function runPreparationWorkload(options) {
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
  vi.restoreAllMocks(); vi.unstubAllEnvs(); fake.build.mockReset(); fake.calibrate.mockReset();
  fake.git.path = '/fixed/developer/git'; fake.git.digest = 'e'.repeat(64);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('explicit nested preparation scoring packaging', () => {
  it('builds the actual fixed entry and reconstructs the host identity on import without starting a workload', async () => {
    // Real native identity reads only: no Git command, evaluator or candidate is invoked.
    const native = await vi.importActual<typeof import('../scripts/evaluators/preparation-verification-native.mjs')>('../scripts/evaluators/preparation-verification-native.mjs');
    Object.assign(fake.git, native.resolvePreparationGit());
    const f = fixture();
    const esbuild = await vi.importActual<typeof import('esbuild')>('esbuild');
    fake.build.mockImplementation(esbuild.build);
    await buildPreparationScoreBundle({ repository, ...f });
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

  it.each(['settled', 'unsettled', 'scope-violation'] as const)('the compiled owner handles a synthetic %s workload without claiming native qualification', async kind => {
    const f = await realEntry(kind === 'unsettled' ? 'unsettled' : 'settled');
    const candidate = join(f.root, 'candidate'), target = join(candidate, f.calibration.baseline.source.path);
    fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); write(target, 'fixture source\n');
    if (kind === 'scope-violation') write(join(candidate, 'extra.txt'), 'outside target scope');
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
      if (kind === 'settled') {
        expect(result.passed).toBe(true); expect(result.score).toBe(150);
        expect(result.metrics).toMatchObject({ baseline_processes: 150, candidate_processes: 150, process_delta: 0, improved: 0 });
      } else {
        expect(result.passed).toBe(false);
        expect(result.diagnostics?.[0]?.code).toBe(kind === 'unsettled' ? 'PROCESS_SETTLEMENT_UNCONFIRMED' : 'PREPARATION_SCORE_SCOPE_FAILED');
      }
      const complete = join(activityRoot, 'complete.json');
      if (kind === 'unsettled') {
        expect(fs.existsSync(complete)).toBe(false); expect(fs.existsSync(join(activityRoot, 'prepared-1.json'))).toBe(true);
      } else {
        expect(JSON.parse(fs.readFileSync(complete, 'utf8')).count).toBe(0);
        expect(publications.mock.calls.filter(([, target]) => target === complete)).toHaveLength(1);
      }
      expect(fs.existsSync(join(f.root, 'synthetic-workload-invoked'))).toBe(kind !== 'scope-violation');
      expect(fs.readdirSync(activityRoot).some(name => name.startsWith('spawned-'))).toBe(false);
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
    expect(fake.build).toHaveBeenCalledTimes(1);
    expect(fake.build.mock.calls[0]![0].entryPoints).toEqual([join(repository, 'scripts/evaluators/preparation-score.mjs')]);
    expect(fake.build.mock.calls[0]![0].external).toEqual(files.map(name => `./measurement/${name}`));
  });

  it('pins exact calibration bytes in the outer identity, never in the original measurement identity', async () => {
    const f = await packaged(), before = inspectPreparationScoreBundle(f.output);
    fs.appendFileSync(join(f.output, 'calibration.json'), ' '); rewriteOuter(f.output);
    expect(inspectPreparationScoreBundle(f.output).digest).not.toBe(before.digest);
    expect(inspectBuiltinEvaluatorBundle(join(f.output, 'measurement')).digest).toBe(f.observed.digest);
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
  });
});

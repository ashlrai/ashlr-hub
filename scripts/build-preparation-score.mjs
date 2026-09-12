#!/usr/bin/env node
/** Explicit trusted authoring only. Ordinary builds never invent or install a calibration. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { TextDecoder } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Preparation scoring package inputs unavailable or changed'); };
const same = (a, b) => ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => a[key] === b[key]);
const COMPILER_SOURCES = ['scripts/evaluators/preparation-typecheck.mjs', 'src/core/universe/preparation-typecheck.ts',
  'src/core/universe/preparation-typecheck-project.ts', 'node_modules/typescript/lib/typescript.js'];
function read(file, limit) {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit) ||
      (before.mode & 0o022n) !== 0n || realpathSync(file) !== file) fail();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, fstatSync(fd, { bigint: true }))) fail();
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) { const got = readSync(fd, bytes, count, bytes.length - count, count); if (!got) break; count += got; }
    if (count !== Number(before.size) || !same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(file, { bigint: true }))) fail();
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
function directory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o777) !== 0o700 ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail();
}
function captureCompilerSources(repository) {
  return COMPILER_SOURCES.map(name => {
    const path = join(repository, name), stat = lstatSync(path, { bigint: true }), bytes = read(path, 32 * 1024 * 1024);
    if (!same(stat, lstatSync(path, { bigint: true }))) fail();
    return { path, stat, digest: hash(bytes) };
  });
}
function assertCompilerSources(pins) {
  for (const pin of pins) {
    if (!same(pin.stat, lstatSync(pin.path, { bigint: true })) || hash(read(pin.path, 32 * 1024 * 1024)) !== pin.digest ||
        !same(pin.stat, lstatSync(pin.path, { bigint: true }))) fail();
  }
}
async function authoring(repository) {
  // Core is compiled by the ordinary TypeScript build first, never from the candidate.
  const [registry, calibration, typecheck] = await Promise.all([
    import(pathToFileURL(join(repository, 'dist/core/universe/builtin-evaluator-registry.js')).href),
    import(pathToFileURL(join(repository, 'dist/core/universe/preparation-measurement-calibration.js')).href),
    import(pathToFileURL(join(repository, 'dist/core/universe/preparation-typecheck-project.js')).href),
  ]);
  return { registry, calibration, typecheck };
}
async function packageScore({ repository, measurementDirectory, output, typecheckProject, compilerSources }, calibrationBytes) {
  if ([repository, measurementDirectory, output].some(path => typeof path !== 'string' || resolve(path) !== path || realpathSync(path) !== path)) fail();
  directory(output); if (readdirSync(output).length !== 0) fail();
  const outputIdentity = lstatSync(output, { bigint: true });
  const assertOutput = () => {
    directory(output);
    const current = lstatSync(output, { bigint: true });
    if (current.dev !== outputIdentity.dev || current.ino !== outputIdentity.ino || current.mode !== outputIdentity.mode) fail();
  };
  const { registry, calibration, typecheck } = await authoring(repository);
  const descriptor = calibration.parsePreparationMeasurementCalibration(new TextDecoder('utf-8', { fatal: true }).decode(calibrationBytes));
  const project = typecheck.validatePreparationTypecheckProject(typecheckProject);
  if (project.baselineSourceSha256 !== descriptor.baseline.source.sha256) fail();
  const projectBytes = Buffer.from(JSON.stringify(project) + '\n');
  if (projectBytes.length > 32 * 1024 * 1024) fail();
  const observed = registry.inspectBuiltinEvaluatorBundle(measurementDirectory);
  const normalized = calibration.preparationCalibrationWorkload(observed, 'preparation-workflows-v2');
  if (descriptor.workload.id !== 'preparation-workflows-v2' || JSON.stringify(descriptor.workload) !== JSON.stringify(normalized)) fail();
  const compilerPins = compilerSources ?? captureCompilerSources(repository);
  assertCompilerSources(compilerPins);
  const nested = new Map();
  nested.set('manifest.json', read(join(measurementDirectory, 'manifest.json'), 16 * 1024));
  for (const file of observed.files) {
    const bytes = read(file.path, 32 * 1024 * 1024);
    if (hash(bytes) !== file.digest) fail();
    nested.set(file.name, bytes);
  }
  const entry = join(repository, 'scripts/evaluators/preparation-score.mjs');
  const external = observed.files.map(file => `./measurement/${file.name}`);
  const built = await build({ absWorkingDir: repository, entryPoints: [entry], bundle: true, platform: 'node',
    target: 'node24', format: 'esm', write: false, metafile: true, external, logLevel: 'silent' });
  const inputs = Object.keys(built.metafile.inputs).map(file => resolve(repository, file));
  if (!inputs.includes(entry) || inputs.some(file => file.startsWith(join(repository, 'test') + '/') ||
      file === join(repository, 'scripts/evaluators/preparation-workload.mjs') || file === join(repository, 'src/core/resources/engineering-preparation.ts')) ||
      Object.values(built.metafile.outputs).flatMap(row => row.imports).some(row => !isBuiltin(row.path) && !external.includes(row.path))) fail();
  const entryBytes = built.outputFiles[0]?.contents;
  if (!entryBytes || entryBytes.length === 0 || entryBytes.length > 32 * 1024 * 1024 || built.outputFiles.length !== 1) fail();
  const typecheckEntry = join(repository, 'scripts/evaluators/preparation-typecheck.mjs');
  const compiler = await build({ absWorkingDir: repository, entryPoints: [typecheckEntry], bundle: true, platform: 'node',
    target: 'node24', format: 'esm', write: false, metafile: true, logLevel: 'silent',
    banner: { js: "import {createRequire as compilerCreateRequire} from 'node:module'; " +
      "import {fileURLToPath as compilerFileURLToPath} from 'node:url'; import {dirname as compilerDirname} from 'node:path'; " +
      "const require=compilerCreateRequire(import.meta.url); const __filename=compilerFileURLToPath(import.meta.url); const __dirname=compilerDirname(__filename);" },
    plugins: [{ name: 'closed-compiler-debug-support', setup(plugin) {
      // TypeScript catches failure of this optional stack-trace helper. Keep
      // that debug-only path unavailable, rather than resolving a host package.
      plugin.onResolve({ filter: /^source-map-support$/ }, () => ({ path: 'unavailable', namespace: 'closed-compiler-debug-support' }));
      plugin.onLoad({ filter: /^unavailable$/, namespace: 'closed-compiler-debug-support' }, () => ({
        contents: "throw new Error('Optional compiler source-map support is unavailable');", loader: 'js' }));
    } }] });
  const compilerInputs = Object.keys(compiler.metafile.inputs).map(file => file === 'closed-compiler-debug-support:unavailable'
    ? file : resolve(repository, file)).sort();
  const expectedCompilerInputs = [...COMPILER_SOURCES.map(name => join(repository, name)), 'closed-compiler-debug-support:unavailable'].sort();
  if (JSON.stringify(compilerInputs) !== JSON.stringify(expectedCompilerInputs) ||
      Object.values(compiler.metafile.outputs).flatMap(row => row.imports).some(row => !isBuiltin(row.path))) fail();
  const compilerBytes = compiler.outputFiles[0]?.contents;
  if (!compilerBytes || compilerBytes.length === 0 || compilerBytes.length > 32 * 1024 * 1024 || compiler.outputFiles.length !== 1) fail();
  assertCompilerSources(compilerPins);
  if (JSON.stringify(registry.inspectBuiltinEvaluatorBundle(measurementDirectory)) !== JSON.stringify(observed)) fail();
  for (const [name, bytes] of nested) if (!read(join(measurementDirectory, name), 32 * 1024 * 1024).equals(bytes)) fail();
  assertOutput(); if (readdirSync(output).length !== 0) fail();
  const target = join(output, 'measurement'); mkdirSync(target, { mode: 0o700 });
  directory(target);
  const nestedIdentity = lstatSync(target, { bigint: true });
  const assertPublicationRoots = () => {
    assertOutput(); directory(target);
    const current = lstatSync(target, { bigint: true });
    if (current.dev !== nestedIdentity.dev || current.ino !== nestedIdentity.ino || current.mode !== nestedIdentity.mode) fail();
  };
  // Detect replacement between publications. These pathname guards do not
  // promise atomic safety against a hostile same-UID swap at the syscall itself.
  for (const [name, bytes] of nested) {
    assertPublicationRoots();
    writeFileSync(join(target, name), bytes, { mode: 0o600, flag: 'wx' });
  }
  assertPublicationRoots();
  writeFileSync(join(output, 'preparation-score.mjs'), entryBytes, { mode: 0o600, flag: 'wx' });
  assertPublicationRoots();
  writeFileSync(join(output, 'preparation-typecheck.mjs'), compilerBytes, { mode: 0o600, flag: 'wx' });
  assertPublicationRoots();
  writeFileSync(join(output, 'preparation-typecheck-project.json'), projectBytes, { mode: 0o600, flag: 'wx' });
  assertPublicationRoots();
  writeFileSync(join(output, 'calibration.json'), calibrationBytes, { mode: 0o600, flag: 'wx' });
  const expected = new Map([['preparation-score.mjs', Buffer.from(entryBytes)], ['preparation-typecheck.mjs', Buffer.from(compilerBytes)],
    ['preparation-typecheck-project.json', projectBytes], ['calibration.json', calibrationBytes],
    ...[...nested].map(([name, bytes]) => [`measurement/${name}`, bytes])]);
  const manifest = { schemaVersion: 1, id: registry.PREPARATION_PROCESS_SCORE_BUILTIN,
    files: registry.PREPARATION_SCORE_FILES.map(name => {
      const bytes = expected.get(name);
      if (!bytes || !read(join(output, name), 32 * 1024 * 1024).equals(bytes)) fail();
      return { name, digest: hash(bytes) };
    }) };
  assertPublicationRoots();
  // The outer manifest never contains its own digest or renews nested identity.
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest) + '\n', { mode: 0o600, flag: 'wx' });
  registry.inspectPreparationScoreBundle(output);
  return manifest;
}

/** Test/release authoring helper. A supplied descriptor is NOT proof of real calibration provenance. */
export async function buildPreparationScoreBundle({ repository, measurementDirectory, calibrationFile, output, typecheckProject }) {
  return packageScore({ repository, measurementDirectory, output, typecheckProject }, read(calibrationFile, 2 * 1024 * 1024));
}

/** Production authoring requires three actual immutable captures; no default numeric baseline. */
export async function buildPreparationScoringBuiltin({ measurementDirectory, capture }) {
  const { calibration } = await authoring(sourceRoot);
  const descriptor = calibration.calibratePreparationMeasurements(capture);
  const compilerSources = captureCompilerSources(sourceRoot);
  const { authorPreparationTypecheckProject } = await import('./build-preparation-typecheck.mjs');
  const typecheckProject = await authorPreparationTypecheckProject({ repository: sourceRoot,
    expectedSourceSha256: descriptor.baseline.source.sha256 });
  assertCompilerSources(compilerSources);
  const output = join(sourceRoot, 'dist/core/universe/builtins/preparation-score');
  try { lstatSync(output); } catch (error) { if (error?.code !== 'ENOENT') throw error; mkdirSync(output, { mode: 0o700 }); }
  return packageScore({ repository: sourceRoot, measurementDirectory, output, typecheckProject, compilerSources }, Buffer.from(JSON.stringify(descriptor) + '\n'));
}

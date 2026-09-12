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
async function authoring(repository) {
  // Core is compiled by the ordinary TypeScript build first, never from the candidate.
  const [registry, calibration] = await Promise.all([
    import(pathToFileURL(join(repository, 'dist/core/universe/builtin-evaluator-registry.js')).href),
    import(pathToFileURL(join(repository, 'dist/core/universe/preparation-measurement-calibration.js')).href),
  ]);
  return { registry, calibration };
}
async function packageScore({ repository, measurementDirectory, output }, calibrationBytes) {
  if ([repository, measurementDirectory, output].some(path => typeof path !== 'string' || resolve(path) !== path || realpathSync(path) !== path)) fail();
  directory(output); if (readdirSync(output).length !== 0) fail();
  const outputIdentity = lstatSync(output, { bigint: true });
  const assertOutput = () => {
    directory(output);
    const current = lstatSync(output, { bigint: true });
    if (current.dev !== outputIdentity.dev || current.ino !== outputIdentity.ino || current.mode !== outputIdentity.mode) fail();
  };
  const { registry, calibration } = await authoring(repository);
  const descriptor = calibration.parsePreparationMeasurementCalibration(new TextDecoder('utf-8', { fatal: true }).decode(calibrationBytes));
  const observed = registry.inspectBuiltinEvaluatorBundle(measurementDirectory);
  const normalized = calibration.preparationCalibrationWorkload(observed, 'preparation-workflows-v2');
  if (descriptor.workload.id !== 'preparation-workflows-v2' || JSON.stringify(descriptor.workload) !== JSON.stringify(normalized)) fail();
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
  writeFileSync(join(output, 'calibration.json'), calibrationBytes, { mode: 0o600, flag: 'wx' });
  const expected = new Map([['preparation-score.mjs', Buffer.from(entryBytes)], ['calibration.json', calibrationBytes],
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
export async function buildPreparationScoreBundle({ repository, measurementDirectory, calibrationFile, output }) {
  return packageScore({ repository, measurementDirectory, output }, read(calibrationFile, 2 * 1024 * 1024));
}

/** Production authoring requires three actual immutable captures; no default numeric baseline. */
export async function buildPreparationScoringBuiltin({ measurementDirectory, capture }) {
  const { calibration } = await authoring(sourceRoot);
  const descriptor = calibration.calibratePreparationMeasurements(capture);
  const output = join(sourceRoot, 'dist/core/universe/builtins/preparation-score');
  try { lstatSync(output); } catch (error) { if (error?.code !== 'ENOENT') throw error; mkdirSync(output, { mode: 0o700 }); }
  return packageScore({ repository: sourceRoot, measurementDirectory, output }, Buffer.from(JSON.stringify(descriptor) + '\n'));
}

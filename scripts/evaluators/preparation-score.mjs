/** Fixed installed score owner. Candidate code cannot choose calibration, tools,
 * entrypoints or callbacks. Importing this module never starts a workload. */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readArtifactSnapshot } from '../../src/core/universe/artifacts.ts';
import { parsePreparationMeasurementCalibration, preparationCalibrationWorkload } from '../../src/core/universe/preparation-measurement-calibration.ts';
import { scorePreparationProcesses, summarizePreparationProcessArtifact, assertPreparationProcessScope } from '../../src/core/universe/preparation-process-score.ts';
import { parsePreparationTypecheckProject, PREPARATION_TYPECHECK_TARGET } from '../../src/core/universe/preparation-typecheck-project.ts';
import { runVerifySubprocessAsync } from '../../src/core/run/verify-commands.ts';
import { setTimeout, clearTimeout } from 'node:timers';
import { openBuiltinActivityTracker } from './measurement/preparation-verification-activity.mjs';
import { assertPreparationGit } from './measurement/preparation-verification-native.mjs';

const ID = 'preparation-process-score-v1';
const MEASUREMENT_FILES = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs', 'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs', 'preparation-verification-native.mjs',
  'preparation-verification-protocol.mjs', 'preparation-verification-tool.mjs', 'preparation-verification.mjs'];
const SCORE_FILES = ['preparation-score.mjs', 'preparation-typecheck.mjs', 'preparation-typecheck-project.json',
  'calibration.json', 'measurement/manifest.json',
  ...MEASUREMENT_FILES.map(name => `measurement/${name}`)];
const TOOL_PATHS = ['/bin/ls', '/bin/ps', '/usr/bin/sandbox-exec'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('PREPARATION_SCORE_IDENTITY_FAILED'); };
const failed = code => ({ passed: false, score: 0, metrics: {}, diagnostics: [{ code,
  message: 'Installed preparation scoring did not satisfy its fixed verification contract.' }] });
function same(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => a[key] === b[key]);
}
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function readPinnedFile(path, maximum = 32 * 1024 * 1024, system = false) {
  const before = fs.lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(maximum) ||
      (system ? before.nlink < 1n : before.nlink !== 1n) || (before.mode & 0o022n) !== 0n || fs.realpathSync(path) !== path) fail();
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail();
    const storage = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < storage.length) {
      const got = fs.readSync(fd, storage, count, storage.length - count, count);
      if (!got) break;
      count += got;
    }
    const bytes = storage.subarray(0, count);
    if (count !== Number(before.size) || !same(before, fs.fstatSync(fd, { bigint: true })) ||
        !same(before, fs.lstatSync(path, { bigint: true }))) fail();
    return { path, bytes, digest: sha(bytes), stat: before };
  } finally { fs.closeSync(fd); }
}
function directory(path, names) {
  const stat = fs.lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n || fs.realpathSync(path) !== path ||
      JSON.stringify(fs.readdirSync(path).sort()) !== JSON.stringify([...names].sort())) fail();
  return { path, stat };
}
function manifest(file, id, names, files) {
  const value = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
  if (!exact(value, ['schemaVersion', 'id', 'files']) || value.schemaVersion !== 1 || value.id !== id ||
      !Array.isArray(value.files) || value.files.length !== names.length || value.files.some((row, index) =>
        !exact(row, ['name', 'digest']) || row.name !== names[index] || row.digest !== files[index].digest)) fail();
}

/** Reconstruct the same fixed aggregate as the host registry, never trust a
 * descriptor supplied by the candidate. Both owners check it independently. */
export function inspectPreparationScoreIdentity(directoryPath) {
  const root = directory(directoryPath, ['preparation-score.mjs', 'preparation-typecheck.mjs', 'preparation-typecheck-project.json',
    'calibration.json', 'measurement', 'manifest.json']);
  const nested = directory(join(directoryPath, 'measurement'), [...MEASUREMENT_FILES, 'manifest.json']);
  const outerManifest = readPinnedFile(join(directoryPath, 'manifest.json'), 16 * 1024);
  const files = SCORE_FILES.map(name => ({ name, ...readPinnedFile(join(directoryPath, name), name === 'calibration.json' ? 2 * 1024 * 1024 : undefined) }));
  manifest(outerManifest, ID, SCORE_FILES, files);
  const measurementManifest = files[4];
  const measurementFiles = files.slice(5).map((file, index) => ({ ...file, name: MEASUREMENT_FILES[index] }));
  manifest(measurementManifest, 'preparation-measurement-v1', MEASUREMENT_FILES, measurementFiles);
  const calibrationJson = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(files[3].bytes);
  const calibration = parsePreparationMeasurementCalibration(calibrationJson);
  const project = parsePreparationTypecheckProject(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(files[2].bytes));
  if (project.baselineSourceSha256 !== calibration.baseline.source.sha256) fail();
  if (calibration.workload.id !== 'preparation-workflows-v2' || calibration.workload.node.path !== process.execPath) fail();
  const executable = readPinnedFile(process.execPath, 256 * 1024 * 1024);
  const git = { path: calibration.workload.git.path, digest: calibration.workload.git.sha256 };
  assertPreparationGit(git);
  const nativeTools = TOOL_PATHS.map(path => readPinnedFile(path, 256 * 1024 * 1024, true));
  const tools = [{ ...git }, ...nativeTools.map(({ path, digest }) => ({ path, digest }))];
  const aggregate = (id, manifestDigest, rows) => sha(JSON.stringify({ schemaVersion: 1, id, manifestDigest,
    files: rows.map(({ name, digest }) => ({ name, digest })), executable: { path: process.execPath, digest: executable.digest }, tools }));
  const measurement = { id: 'preparation-measurement-v1', digest: aggregate('preparation-measurement-v1', measurementManifest.digest, measurementFiles),
    executableDigest: executable.digest, files: measurementFiles.map(({ name, path, digest }) => ({ name, path, digest })), tools, git,
    command: [process.execPath, '--experimental-vm-modules', '--no-warnings',
      join(nested.path, 'preparation-verification.mjs'), join(nested.path, 'preparation-bridge.mjs')] };
  const workload = preparationCalibrationWorkload(measurement, 'preparation-workflows-v2');
  if (JSON.stringify(workload) !== JSON.stringify(calibration.workload)) fail();
  for (const row of [root, nested, outerManifest, ...files, executable, ...nativeTools]) {
    if (!same(row.stat, fs.lstatSync(row.path, { bigint: true }))) fail();
  }
  assertPreparationGit(git);
  return { digest: aggregate(ID, outerManifest.digest, files), calibrationJson, workload, git,
    typecheckProjectSha256: files[2].digest };
}

export async function runPreparationScore() {
  // Setup, identity verification and artifact walks consume the same allowance.
  const startWall = Date.now(), startMono = performance.now();
  const stop = new globalThis.AbortController(), onStop = () => stop.abort();
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
  let activity, evaluation = failed('PREPARATION_SCORE_INITIALIZATION_FAILED');
  let failureCode = 'PREPARATION_SCORE_INITIALIZATION_FAILED';
  let guard = () => { if (stop.signal.aborted) throw new Error('PREPARATION_SCORE_CANCELLED'); };
  try {
    const base = dirname(fileURLToPath(import.meta.url));
    const bridgePath = join(base, 'measurement/preparation-bridge.mjs');
    if (process.argv.length !== 3 || process.argv[2] !== bridgePath || !process.env.ASHLR_UNIVERSE_BUILTIN_ACTIVITY) fail();
    activity = await openBuiltinActivityTracker(process.env.ASHLR_UNIVERSE_BUILTIN_ACTIVITY, stop.signal);
    const deadlineAt = Date.parse(activity.owner.deadlineAt);
    const deadlineMonotonicMs = startMono + (deadlineAt - startWall);
    guard = () => { if (stop.signal.aborted || !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt ||
      performance.now() >= deadlineMonotonicMs) throw new Error('PREPARATION_SCORE_CANCELLED_OR_EXPIRED'); };
    guard(); failureCode = 'PREPARATION_SCORE_IDENTITY_FAILED';
    const identity = inspectPreparationScoreIdentity(base);
    if (identity.digest !== activity.owner.implementationDigest ||
        process.env.ASHLR_UNIVERSE_BUILTIN_GIT !== JSON.stringify(identity.git)) fail();
    guard(); failureCode = 'PREPARATION_SCORE_SCOPE_FAILED';
    const candidateRoot = process.env.ASHLR_UNIVERSE_CANDIDATE;
    const beforeSnapshot = readArtifactSnapshot(candidateRoot);
    const before = summarizePreparationProcessArtifact(beforeSnapshot);
    assertPreparationProcessScope(identity.calibrationJson, before);
    guard(); failureCode = 'PREPARATION_SCORE_TYPECHECK_FAILED';
    const selected = beforeSnapshot.entries.find(entry => entry.path === PREPARATION_TYPECHECK_TARGET);
    if (!selected) fail();
    const source = new globalThis.TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(selected.data);
    const sourceSha256 = sha(selected.data);
    const input = JSON.stringify({ schemaVersion: 1, source, sourceSha256, projectSha256: identity.typecheckProjectSha256 });
    if (Buffer.byteLength(input) > 1024 * 1024) fail();
    // Compiler input is text only. Its pinned virtual host cannot resolve from
    // the live checkout; this separately owned child never imports a candidate.
    const compilerArgs = [process.execPath, '--max-old-space-size=1024', join(base, 'preparation-typecheck.mjs'),
      join(base, 'preparation-typecheck-project.json')];
    const compilerWallDeadline = Math.min(deadlineAt, Date.now() + 60_000);
    const compilerMonoDeadline = Math.min(deadlineMonotonicMs, performance.now() + 60_000);
    const compilerGuard = () => {
      guard();
      if (Date.now() >= compilerWallDeadline || performance.now() >= compilerMonoDeadline) {
        throw new Error('PREPARATION_SCORE_TYPECHECK_EXPIRED');
      }
    };
    const compilerLifecycle = activity.lifecycle('tool');
    const lifecycle = { prepare() {
      compilerGuard();
      const prepared = compilerLifecycle.prepare();
      // Durable reservation work consumes the original allowance too. A refusal
      // here precedes spawn, so retain an explicit not-started child receipt.
      try { compilerGuard(); } catch (error) { prepared.settled('not-started'); throw error; }
      return prepared;
    } };
    const compilerTimeout = Math.floor(Math.min(compilerWallDeadline - Date.now(), compilerMonoDeadline - performance.now()));
    compilerGuard(); if (compilerTimeout <= 0) fail();
    // The subprocess timer starts after preparation. This outer timer keeps
    // reservation/setup latency inside the original allowance as well.
    const compilerDeadline = setTimeout(() => stop.abort(), compilerTimeout);
    let compiled;
    try {
      compiled = await runVerifySubprocessAsync(compilerArgs, { cwd: process.env.HOME,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, TMPDIR: process.env.HOME,
          LANG: 'C', LC_ALL: 'C' }, input, timeoutMs: compilerTimeout, maxOutputChars: 8192,
        signal: stop.signal, requireProcessGroupExit: true, processGroupLifecycle: lifecycle });
    } finally { clearTimeout(compilerDeadline); }
    compilerGuard();
    if (compiled.exitCode !== 0 || compiled.signal !== null || compiled.error !== undefined || compiled.stderr ||
        compiled.timedOut || compiled.cancelled || compiled.outputTruncated || compiled.processGroupSettlement !== 'group-exit-confirmed') fail();
    const checked = JSON.parse(compiled.stdout);
    if (!exact(checked, ['schemaVersion', 'kind', 'passed', 'sourceSha256', 'projectSha256', 'diagnosticCodes']) ||
        checked.schemaVersion !== 1 || checked.kind !== 'preparation-typecheck-result' || checked.passed !== true ||
        checked.sourceSha256 !== sourceSha256 || checked.projectSha256 !== identity.typecheckProjectSha256 ||
        !Array.isArray(checked.diagnosticCodes) || checked.diagnosticCodes.length !== 0) fail();
    guard();
    if (JSON.stringify(inspectPreparationScoreIdentity(base)) !== JSON.stringify(identity)) fail();
    if (JSON.stringify(summarizePreparationProcessArtifact(readArtifactSnapshot(candidateRoot))) !== JSON.stringify(before)) fail();
    guard(); failureCode = 'PREPARATION_SCORE_WORKLOAD_FAILED';
    const { runPreparationWorkload } = await import('./measurement/preparation-verification.mjs');
    guard();
    const report = await runPreparationWorkload({ mode: 'preparation-workflows-v2', candidateRoot,
      scratchRoot: process.env.HOME, gitPin: identity.git, activity, signal: stop.signal, deadlineAt, deadlineMonotonicMs });
    guard(); failureCode = 'PREPARATION_SCORE_SCOPE_FAILED';
    const after = summarizePreparationProcessArtifact(readArtifactSnapshot(candidateRoot));
    guard(); failureCode = 'PREPARATION_SCORE_IDENTITY_FAILED';
    const finalIdentity = inspectPreparationScoreIdentity(base);
    if (JSON.stringify(finalIdentity) !== JSON.stringify(identity)) fail();
    guard();
    evaluation = scorePreparationProcesses({ calibrationJson: identity.calibrationJson, reportJson: JSON.stringify(report),
      workload: identity.workload, candidateBefore: before, candidateAfter: after });
    guard();
  } catch { evaluation = failed(failureCode); }
  try {
    // Completion can only acknowledge actually settled groups. A provisional
    // passing score must be replaced by failure on any custody uncertainty.
    try { activity?.complete(); }
    catch { evaluation = failed('PROCESS_SETTLEMENT_UNCONFIRMED'); }
    try { guard(); }
    catch { evaluation = failed('PREPARATION_SCORE_CANCELLED_OR_EXPIRED'); }
    return evaluation;
  } finally {
    process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(await runPreparationScore()) + '\n');
}

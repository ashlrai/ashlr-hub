#!/usr/bin/env node
/** Explicit retained v2 calibration authoring, NOT scoring activation.
 * Usage: node run-calibration.mjs --evidence-root <existing-empty-private-root>
 *   --deadline <canonical-ISO-absolute-deadline>
 * Never retries, deletes evidence, changes HOME/KILL, installs or calls models.
 * The deadline is fixed before setup; expiry aborts and awaits active custody.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const target = 'src/core/resources/engineering-preparation.ts';
const universeId = 'preparation-baseline-v2', captureIds = ['baseline-v2-1', 'baseline-v2-2', 'baseline-v2-3'];
const evaluationTimeoutMs = 1_800_000, maximumOverallMs = 6_000_000;
const started = performance.now(), startedWall = Date.now(), controller = new globalThis.AbortController();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let evidenceRoot, rootIdentity, claimedEmptyRoot = false, stage = 'arguments', code = 'CALIBRATION_NOT_CONFIRMED';
let timer, deadlineAt, deadlineMonotonicMs;
const abort = () => controller.abort();
const announce = phase => { stage = phase; console.log(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) })); };
function assertRoot() {
  const stat = lstatSync(evidenceRoot);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(evidenceRoot) === evidenceRoot &&
    stat.dev === rootIdentity.dev && stat.ino === rootIdentity.ino && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid());
}
function save(name, bytes) {
  assertRoot(); assert.match(name, /^[a-z0-9-]+\.json$/);
  const fd = openSync(join(evidenceRoot, name), 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  assertRoot();
  const rootFd = openSync(evidenceRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(rootFd);
    assert.ok(current.isDirectory() && current.dev === rootIdentity.dev && current.ino === rootIdentity.ino);
    fsyncSync(rootFd);
  } finally { closeSync(rootFd); }
  assertRoot();
}
const saveJson = (name, value) => save(name, JSON.stringify(value, null, 2) + '\n');
// Same bounded, byte-and-identity inventory as the retained single-capture driver.
function snapshot(root) {
  let count = 0, bytes = 0;
  function visit(path) {
    assert.ok(++count <= 100_000);
    const before = lstatSync(path, { bigint: true });
    const identity = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    let content;
    if (before.isSymbolicLink()) content = { link: readlinkSync(path) };
    else if (before.isDirectory()) content = Object.fromEntries(readdirSync(path).sort().map(name => [name, visit(join(path, name))]));
    else {
      assert.ok(before.isFile() && before.size <= 64n * 1024n * 1024n);
      bytes += Number(before.size); assert.ok(bytes <= 512 * 1024 * 1024);
      content = sha(readFileSync(path));
    }
    assert.deepEqual(identity(lstatSync(path, { bigint: true })), identity(before));
    return { identity: identity(before), content };
  }
  return sha(JSON.stringify(visit(root)));
}
function timeGuard() {
  if (controller.signal.aborted || Date.now() >= deadlineAt || performance.now() >= deadlineMonotonicMs) {
    code = 'CALIBRATION_STOPPED'; abort(); throw new Error('Calibration stopped');
  }
}

async function main() {
  assert.equal(process.platform, 'darwin'); assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  assert.equal(process.argv.length, 6); assert.equal(process.argv[2], '--evidence-root'); assert.equal(process.argv[4], '--deadline');
  evidenceRoot = process.argv[3]; deadlineAt = Date.parse(process.argv[5]);
  assert.ok(Number.isSafeInteger(deadlineAt) && new Date(deadlineAt).toISOString() === process.argv[5]);
  assert.ok(deadlineAt > startedWall && deadlineAt - startedWall <= maximumOverallMs);
  deadlineMonotonicMs = started + deadlineAt - startedWall;
  assert.ok(isAbsolute(evidenceRoot) && resolve(evidenceRoot) === evidenceRoot && dirname(evidenceRoot) !== evidenceRoot);
  assert.equal(realpathSync(evidenceRoot), evidenceRoot);
  rootIdentity = lstatSync(evidenceRoot); assertRoot(); assert.deepEqual(readdirSync(evidenceRoot), []);
  claimedEmptyRoot = true;
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  timer = setTimeout(abort, Math.max(1, Math.min(deadlineAt - Date.now(), deadlineMonotonicMs - performance.now())));
  const load = file => import(pathToFileURL(join(repository, 'dist', file)).href);
  const { readKillSwitch } = await load('core/sandbox/policy.js');
  const guard = () => {
    timeGuard(); assertRoot();
    const kill = readKillSwitch();
    code = kill.sourceState === 'healthy' && kill.state === 'active' ? 'KILL_SWITCH_ACTIVE' : 'KILL_SWITCH_UNAVAILABLE';
    assert.equal(kill.sourceState, 'healthy'); assert.equal(kill.state, 'inactive');
    code = 'CALIBRATION_NOT_CONFIRMED'; timeGuard();
  };
  announce('kill-switch-preflight'); guard();
  const { resolveBuiltinEvaluator } = await load('core/universe/builtin-evaluator-registry.js');
  const { initUniverse, manifestRecord, parseEvaluation, readRecords, universePath } = await load('core/universe/store.js');
  const { artifactDigest } = await load('core/universe/artifacts.js');
  const { captureUniversePreparationMeasurement, readUniversePreparationMeasurementCapture } = await load('core/universe/preparation-measurement-capture.js');
  const { parsePreparationMeasurementReport } = await load('core/universe/preparation-measurement-report.js');
  const { extractPreparationScenarioVector } = await load('core/universe/preparation-measurement-comparison.js');
  const { calibratePreparationMeasurements, parsePreparationMeasurementCalibration } = await load('core/universe/preparation-measurement-calibration.js');
  const { inspectBuiltinActivity } = await import(pathToFileURL(join(repository, 'scripts/evaluators/preparation-verification-activity.mjs')).href);
  guard(); announce('source-and-runtime-preflight');
  const installed = resolveBuiltinEvaluator('preparation-measurement-v1');
  // Ambient Git overrides can redirect init/add/commit despite -C. Discard all
  // inherited GIT_* settings; real HOME/ASHLR_HOME/KILL remain unchanged.
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const gitEnv = { ...inheritedEnv, PATH: `${dirname(installed.git.path)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const git = (repo, ...args) => {
    guard();
    const value = execFileSync(installed.git.path, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: Math.max(1, Math.floor(Math.min(10_000,
        deadlineAt - Date.now(), deadlineMonotonicMs - performance.now()))), maxBuffer: 4 * 1024 * 1024, env: gitEnv });
    guard(); return value;
  };
  const sourceHead = git(repository, 'rev-parse', 'HEAD').trim(), sourceBlob = git(repository, 'rev-parse', `${sourceHead}:${target}`).trim();
  const source = readFileSync(join(repository, target));
  assert.ok(source.equals(Buffer.from(git(repository, 'cat-file', 'blob', sourceBlob), 'utf8')));
  const fresh = () => {
    guard(); assert.deepEqual(resolveBuiltinEvaluator('preparation-measurement-v1'), installed);
    assert.equal(git(repository, 'rev-parse', 'HEAD').trim(), sourceHead);
    assert.ok(readFileSync(join(repository, target)).equals(source)); guard();
  };
  fresh(); saveJson('source-origin.json', { schemaVersion: 1, repository, sourceHead, target, sourceBlob,
    sourceSha256: sha(source), node: { path: process.execPath, version: process.version }, installed });
  const seedRepo = join(evidenceRoot, 'seed-repository');
  mkdirSync(join(seedRepo, dirname(target)), { recursive: true, mode: 0o700 });
  writeFileSync(join(seedRepo, target), source, { mode: 0o600, flag: 'wx' });
  git(seedRepo, 'init', '-q', '--template=', '--initial-branch=main'); git(seedRepo, 'add', '--', target);
  git(seedRepo, '-c', 'user.name=Diagnostic Fixture', '-c', 'user.email=diagnostic@example.invalid', 'commit', '-qm', 'Unchanged pinned preparation source');
  const revision = git(seedRepo, 'rev-parse', 'HEAD').trim();
  const manifest = { schemaVersion: 1, id: universeId, name: 'Retained unchanged v2 preparation calibration',
    objective: 'Three fixed diagnostics; never execute a variant, score, promote or deliver', seed: { repo: seedRepo, revision },
    metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: evaluationTimeoutMs, trialTimeoutMs: 900_000 },
    evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: evaluationTimeoutMs },
    variants: [{ id: 'never-run', niche: 'verification', hypothesis: 'Diagnostic only', command: [process.execPath, '-e', 'process.exit(91)'] }] };
  saveJson('manifest.json', manifest);
  const root = join(evidenceRoot, 'universe');
  saveJson('invocation.json', { schemaVersion: 1, root, universeId, captureIds, evaluationTimeoutMs,
    deadlineAt: new Date(deadlineAt).toISOString(), maximumOverallMs, automaticRetry: false, noCleanup: true });
  fresh(); initUniverse(manifest, { root });
  const directory = universePath(root, universeId), record = manifestRecord(directory), beforeRecords = readRecords(directory);
  const seedBefore = snapshot(record.seedArtifact.path), repoBefore = snapshot(seedRepo);
  let baselineVector;
  for (const captureId of captureIds) {
    fresh(); announce(captureId);
    const request = { root, universeId, captureId };
    const captured = await captureUniversePreparationMeasurement({ ...request, signal: controller.signal });
    // Preserve returned failure/partial evidence BEFORE checking success or time.
    saveJson(`${captureId}-capture.json`, captured);
    const raw = captured.receipt?.report?.stdout;
    if (raw !== undefined) save(`${captureId}-report.json`, raw);
    assert.equal(captured.state, 'recorded'); assert.equal(captured.disposition, 'created');
    assert.equal(captured.receipt?.outcome, 'captured'); assert.equal(captured.receipt?.identityVerified, true);
    assert.equal(captured.receipt?.processGroupSettlement, 'group-exit-confirmed');
    assert.equal(typeof raw, 'string');
    const report = parsePreparationMeasurementReport(raw), vector = extractPreparationScenarioVector(raw);
    assert.equal(report.workload, 'preparation-workflows-v2'); assert.equal(report.checksPassed, true);
    assert.equal(report.metrics.correctness_checks, 23); assert.deepEqual(report.diagnostics, []);
    assert.deepEqual(report.workflows.map(row => row.name), ['manager', 'successor']);
    assert.deepEqual(report.qualifications.map(row => row.name), ['runtime-drift', 'source-drift']);
    assert.deepEqual(report.qualifications.map(row => row.injections), [1, 1]); assert.equal(vector.length, 15);
    assert.throws(() => parseEvaluation(raw));
    assert.equal(sha(raw), captured.receipt.report.sha256); assert.equal(Buffer.byteLength(raw), captured.receipt.report.bytes);
    assert.deepEqual(captured.intent.evaluator, installed); assert.deepEqual(captured.intent.artifact, record.seedArtifact);
    assert.equal(captured.intent.manifestDigest, record.manifestDigest); assert.equal(captured.intent.comparatorDigest, record.comparatorDigest);
    assert.equal(artifactDigest(record.seedArtifact.path), record.seedArtifact.digest);
    assert.deepEqual(readRecords(directory), beforeRecords); assert.equal(snapshot(record.seedArtifact.path), seedBefore); assert.equal(snapshot(seedRepo), repoBefore);
    const work = join(directory, 'preparation-measurement-work', captureId);
    const roots = readdirSync(work).filter(name => name.startsWith('builtin-activity-')); assert.equal(roots.length, 1);
    const activityRoot = join(work, roots[0]), owner = JSON.parse(readFileSync(join(activityRoot, 'owner.json'), 'utf8'));
    assert.equal(owner.implementationDigest, installed.digest); assert.ok(inspectBuiltinActivity(activityRoot, owner));
    const settled = snapshot(root);
    assert.deepEqual(readUniversePreparationMeasurementCapture(request).receipt, captured.receipt);
    guard();
    const replay = await captureUniversePreparationMeasurement({ ...request, signal: controller.signal });
    assert.equal(replay.disposition, 'replayed'); assert.deepEqual(replay.receipt, captured.receipt); assert.equal(snapshot(root), settled);
    fresh();
    if (baselineVector) assert.deepEqual(vector, baselineVector); else baselineVector = vector;
    saveJson(`${captureId}-verified.json`, { schemaVersion: 1, scope: 'diagnostic-only', checks: 23,
      regions: 15, qualifications: 2, reportSha256: sha(raw), processGroupSettlement: 'group-exit-confirmed', unchangedReplay: true });
  }
  announce('calibration-publication'); fresh();
  const settled = snapshot(root);
  const descriptor = calibratePreparationMeasurements({ root, universeId, captureIds, expectedSourceDigest: sha(source) });
  assert.equal(descriptor.workload.id, 'preparation-workflows-v2'); assert.equal(descriptor.provenance.length, 3);
  assert.deepEqual(descriptor.scenarios, baselineVector); assert.equal(snapshot(root), settled);
  assert.deepEqual(parsePreparationMeasurementCalibration(JSON.stringify(descriptor)), descriptor);
  fresh(); saveJson('calibration.json', descriptor); fresh();
  announce('calibrated-and-retained');
}
try { await main(); }
catch {
  const failure = { schemaVersion: 1, code, phase: stage, elapsedMs: Math.round(performance.now() - started),
    retained: claimedEmptyRoot, automaticRetry: false };
  try { if (claimedEmptyRoot) saveJson('driver-failure.json', failure); } catch { /* Never replace existing or unsafe evidence. */ }
  console.error(JSON.stringify(failure)); process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}

#!/usr/bin/env node
/** Explicit retained local measurement; no cleanup, score, provider or retries. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const target = 'src/core/resources/engineering-preparation.ts';
const universeId = 'preparation-baseline', captureId = 'baseline-v1', timeoutMs = 900_000;
let evidenceRoot, rootIdentity, stage = 'arguments', storeRoot, claimedEmptyRoot = false;
let refusalCode = 'FULL_CAPTURE_NOT_CONFIRMED';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const started = performance.now();
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
}
const saveJson = (name, value) => save(name, JSON.stringify(value, null, 2) + '\n');
function snapshot(root) {
  let count = 0, bytes = 0;
  function visit(path) {
    assert.ok(++count <= 100_000, 'Inventory entry bound exceeded');
    const before = lstatSync(path, { bigint: true });
    const identity = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    let content;
    if (before.isSymbolicLink()) content = { link: readlinkSync(path) };
    else if (before.isDirectory()) content = Object.fromEntries(readdirSync(path).sort().map(name => [name, visit(join(path, name))]));
    else {
      assert.ok(before.isFile() && before.size <= 64n * 1024n * 1024n, 'Unsupported inventory file');
      bytes += Number(before.size); assert.ok(bytes <= 512 * 1024 * 1024, 'Inventory byte bound exceeded');
      content = sha(readFileSync(path));
    }
    assert.deepEqual(identity(lstatSync(path, { bigint: true })), identity(before), 'Inventory changed during observation');
    return { identity: identity(before), content };
  }
  return sha(JSON.stringify(visit(root)));
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Verified local confinement requires macOS');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 or newer is required');
  assert.deepEqual(process.argv.slice(2, 3), ['--evidence-root']); assert.equal(process.argv.length, 4);
  evidenceRoot = process.argv[3];
  assert.ok(isAbsolute(evidenceRoot) && resolve(evidenceRoot) === evidenceRoot && dirname(evidenceRoot) !== evidenceRoot);
  assert.equal(realpathSync(evidenceRoot), evidenceRoot);
  rootIdentity = lstatSync(evidenceRoot); assertRoot();
  assert.deepEqual(readdirSync(evidenceRoot), [], 'Evidence root must already be private and empty');
  claimedEmptyRoot = true;
  announce('preflight');
  const load = file => import(pathToFileURL(join(repository, 'dist', file)).href);
  const { resolveBuiltinEvaluator } = await load('core/universe/builtin-evaluator-registry.js');
  const { initUniverse, manifestRecord, parseEvaluation, readRecords, universePath } = await load('core/universe/store.js');
  const { artifactDigest } = await load('core/universe/artifacts.js');
  const { captureUniversePreparationMeasurement, readUniversePreparationMeasurementCapture } = await load('core/universe/preparation-measurement-capture.js');
  const { parsePreparationMeasurementReport } = await load('core/universe/preparation-measurement-report.js');
  const { inspectBuiltinActivity } = await import(pathToFileURL(join(repository, 'scripts/evaluators/preparation-verification-activity.mjs')).href);
  const { readKillSwitch } = await load('core/sandbox/policy.js');
  announce('kill-switch-preflight');
  refusalCode = 'KILL_SWITCH_UNAVAILABLE';
  const kill = readKillSwitch();
  if (kill.sourceState === 'healthy' && kill.state === 'active') refusalCode = 'KILL_SWITCH_ACTIVE';
  assert.equal(kill.sourceState, 'healthy'); assert.equal(kill.state, 'inactive');
  refusalCode = 'FULL_CAPTURE_NOT_CONFIRMED';
  announce('source-and-runtime-preflight');
  const installed = resolveBuiltinEvaluator('preparation-measurement-v1');
  // Preserve HOME/ASHLR_HOME and the real KILL gate. Only this driver's Git
  // environment is made hermetic; no persistent config or account is changed.
  process.env.PATH = `${dirname(installed.git.path)}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_OPTIONAL_LOCKS = '0'; process.env.GIT_TERMINAL_PROMPT = '0';
  const git = (repo, ...args) => execFileSync(installed.git.path,
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: process.env }).trim();
  const sourceHead = git(repository, 'rev-parse', 'HEAD');
  const sourceBlob = git(repository, 'rev-parse', `${sourceHead}:${target}`);
  const source = readFileSync(join(repository, target));
  const committedSource = execFileSync(installed.git.path,
    ['-c', 'core.hooksPath=/dev/null', '-C', repository, 'cat-file', 'blob', sourceBlob],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: process.env });
  assert.ok(source.equals(committedSource), 'Target differs from recorded source HEAD');
  saveJson('source-origin.json', { schemaVersion: 1, repository, sourceHead, target, sourceBlob, sourceSha256: sha(source),
    node: { path: process.execPath, version: process.version }, installed });
  const seedRepo = join(evidenceRoot, 'seed-repository');
  mkdirSync(join(seedRepo, dirname(target)), { recursive: true, mode: 0o700 });
  writeFileSync(join(seedRepo, target), source, { mode: 0o600, flag: 'wx' });
  git(seedRepo, 'init', '-q', '--template=', '--initial-branch=main'); git(seedRepo, 'add', '--', target);
  git(seedRepo, '-c', 'user.name=Diagnostic Fixture', '-c', 'user.email=diagnostic@example.invalid', 'commit', '-qm', 'Unchanged pinned preparation source');
  const revision = git(seedRepo, 'rev-parse', 'HEAD');
  const manifest = { schemaVersion: 1, id: universeId, name: 'Retained unchanged preparation baseline',
    objective: 'Measure unchanged source with the fixed installed diagnostic; never score or deliver',
    seed: { repo: seedRepo, revision }, metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: timeoutMs, trialTimeoutMs: timeoutMs },
    evaluation: { builtin: 'preparation-measurement-v1', timeoutMs },
    variants: [{ id: 'never-run', niche: 'verification', hypothesis: 'This diagnostic must never execute a variant', command: [process.execPath, '-e', 'process.exit(91)'] }] };
  saveJson('manifest.json', manifest);
  storeRoot = join(evidenceRoot, 'universe');
  initUniverse(manifest, { root: storeRoot });
  const directory = universePath(storeRoot, universeId), record = manifestRecord(directory), beforeRecords = readRecords(directory);
  const seedBefore = snapshot(record.seedArtifact.path), repoBefore = snapshot(seedRepo);
  const captureRequest = { root: storeRoot, universeId, captureId };
  saveJson('invocation.json', { schemaVersion: 1, captureRequest, timeoutMs, layers: ['compiled initUniverse', 'compiled captureUniversePreparationMeasurement',
    'actual compiled CLI report and JSON replay', 'actual compiled CLI inspector'], noCleanup: true });
  announce('native-capture-starting');
  const controller = new globalThis.AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let captured;
  try { captured = await captureUniversePreparationMeasurement({ ...captureRequest, signal: controller.signal }); }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  saveJson('capture-created.json', captured);
  // Retain any valid partial report before checking full-success conditions.
  const raw = captured.receipt?.report?.stdout;
  if (raw !== undefined) save('report.json', raw);
  announce('native-capture-returned');
  assert.equal(captured.state, 'recorded'); assert.equal(captured.disposition, 'created');
  assert.equal(captured.receipt?.outcome, 'captured'); assert.equal(captured.receipt?.identityVerified, true);
  assert.equal(captured.receipt?.processGroupSettlement, 'group-exit-confirmed');
  assert.equal(typeof raw, 'string');
  const report = parsePreparationMeasurementReport(raw);
  assert.equal(report.checksPassed, true); assert.equal(report.metrics.correctness_checks, 19); assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.workflows.map(row => row.name), ['manager', 'successor']);
  assert.deepEqual(report.workflows.map(row => row.requests.map(request => request.method)), [
    ['manager-open', 'bundle', 'manager-check', 'manager-replay', 'manager-check', 'manager-replay', 'manager-close'],
    ['successor-check', 'successor-metadata', 'successor-bundle', 'successor-metadata'],
  ]);
  assert.throws(() => parseEvaluation(raw));
  assert.equal(sha(raw), captured.receipt.report.sha256); assert.equal(Buffer.byteLength(raw), captured.receipt.report.bytes);
  assert.deepEqual(captured.intent.evaluator, installed); assert.deepEqual(captured.intent.artifact, record.seedArtifact);
  assert.equal(captured.intent.manifestDigest, record.manifestDigest); assert.equal(captured.intent.comparatorDigest, record.comparatorDigest);
  assert.equal(artifactDigest(record.seedArtifact.path), record.seedArtifact.digest);
  assert.deepEqual(readRecords(directory), beforeRecords); assert.equal(snapshot(record.seedArtifact.path), seedBefore); assert.equal(snapshot(seedRepo), repoBefore);
  const work = join(directory, 'preparation-measurement-work', captureId);
  const activityRoots = readdirSync(work).filter(name => name.startsWith('builtin-activity-'));
  assert.equal(activityRoots.length, 1);
  const activityRoot = join(work, activityRoots[0]);
  const owner = JSON.parse(readFileSync(join(activityRoot, 'owner.json'), 'utf8'));
  assert.equal(owner.implementationDigest, installed.digest); assert.ok(inspectBuiltinActivity(activityRoot, owner));
  const activities = readdirSync(activityRoot), spawned = activities.filter(name => /^spawned-[1-9][0-9]*\.json$/.test(name));
  assert.ok(spawned.length > 0);
  const settledSnapshot = snapshot(storeRoot);
  announce('cli-replay-and-inspection');
  const cli = args => execFileSync(process.execPath, [join(repository, 'bin/ashlr'), 'universe', ...args],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 128 * 1024, env: process.env });
  const replayArgs = ['preparation-measurement-capture', universeId, '--root', storeRoot, '--capture', captureId];
  const replayReport = cli([...replayArgs, '--report']); assert.equal(replayReport, raw); assert.equal(snapshot(storeRoot), settledSnapshot);
  const replay = JSON.parse(cli([...replayArgs, '--json']));
  assert.equal(replay.disposition, 'replayed'); assert.equal(replay.state, 'recorded');
  saveJson('capture-replayed.json', replay); assert.equal(snapshot(storeRoot), settledSnapshot);
  const inspection = JSON.parse(cli(['preparation-measurement', '--input', join(evidenceRoot, 'report.json'), '--json']));
  assert.equal(inspection.scope, 'diagnostic-only'); assert.equal(inspection.reportedChecksSatisfied, true); assert.equal(inspection.correctnessChecks, 19);
  saveJson('inspection.json', inspection);
  assert.equal(snapshot(storeRoot), settledSnapshot); assert.deepEqual(readUniversePreparationMeasurementCapture(captureRequest).receipt, captured.receipt);
  assert.equal(git(repository, 'rev-parse', 'HEAD'), sourceHead); assert.ok(readFileSync(join(repository, target)).equals(source));
  assert.equal(snapshot(seedRepo), repoBefore); assert.ok(inspectBuiltinActivity(activityRoot, owner));
  saveJson('verification.json', { schemaVersion: 1, scope: 'diagnostic-only', fullChecksSatisfied: true, correctnessChecks: 19,
    workflows: report.workflows.map(row => row.name), reportSha256: sha(raw), activityInvocationId: owner.invocationId,
    activityGroups: spawned.length, processGroupSettlement: 'group-exit-confirmed', exactCliReplay: true,
    unchangedStoreAcrossReplay: true, unchangedUniverseLedger: true, elapsedMs: Math.round(performance.now() - started) });
  announce('verified-and-retained');
}
try { await main(); }
catch {
  const failure = { schemaVersion: 1, code: refusalCode, phase: stage, elapsedMs: Math.round(performance.now() - started),
    retained: claimedEmptyRoot, automaticRetry: false };
  try { if (claimedEmptyRoot) saveJson('driver-failure.json', failure); } catch { /* Never replace existing or unsafe evidence. */ }
  console.error(JSON.stringify(failure)); process.exitCode = 1;
}

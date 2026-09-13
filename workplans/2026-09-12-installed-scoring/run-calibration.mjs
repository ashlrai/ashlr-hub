#!/usr/bin/env node
/** Explicit retained v2 calibration authoring, NOT scoring activation.
 * Usage: node run-calibration.mjs --evidence-root <existing-empty-private-root>
 *   --deadline <canonical-ISO-absolute-deadline>
 *   [--seed source-repository]
 * Default seed is a private one-file repository. The closed optional mode pins
 * this checkout's clean tracked HEAD for eventual delivery to this repository.
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
  readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
let timer, deadlineAt, deadlineMonotonicMs, restorePath;
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
// Retain all evidence: each declared capture gets the single-capture entry
// budget, independently of the seed/journal budget. Bytes remain globally capped.
// A single aggregate 100k cap rejects three otherwise bounded capture trees.
function snapshot(root, captureDirectory) {
  const counts = new Map([[root, 0]]);
  if (captureDirectory !== undefined) {
    const child = relative(root, captureDirectory);
    assert.ok(child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
    for (const id of captureIds) counts.set(join(captureDirectory, 'preparation-measurement-work', id), 0);
  }
  let bytes = 0;
  const limit = (condition, failure) => {
    if (!condition) { code = failure; throw new Error(failure); }
  };
  function visit(path, bucket = root) {
    if (counts.has(path)) bucket = path;
    const count = counts.get(bucket) + 1;
    counts.set(bucket, count);
    limit(count <= 100_000, 'CALIBRATION_SNAPSHOT_ENTRY_LIMIT');
    const before = lstatSync(path, { bigint: true });
    const identity = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    let content;
    if (before.isSymbolicLink()) content = { link: readlinkSync(path) };
    else if (before.isDirectory()) content = Object.fromEntries(readdirSync(path).sort().map(name => [name, visit(join(path, name), bucket)]));
    else {
      assert.ok(before.isFile());
      limit(before.size <= 64n * 1024n * 1024n, 'CALIBRATION_SNAPSHOT_FILE_LIMIT');
      bytes += Number(before.size); limit(bytes <= 512 * 1024 * 1024, 'CALIBRATION_SNAPSHOT_BYTE_LIMIT');
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

function assertSettledCapture(captured, retained) {
  assert.equal(captured.state, 'recorded'); assert.equal(captured.disposition, 'created');
  assert.equal(captured.receipt?.outcome, 'captured'); assert.equal(captured.receipt?.identityVerified, true);
  assert.equal(captured.receipt?.processGroupSettlement, 'group-exit-confirmed');
  if (captured.receipt.custodyDiagnostics !== undefined) assert.equal(captured.receipt.custodyDiagnostics.boundary, 'completed');
  // The fixed evaluator authenticated nested settlement while it held the
  // invocation key. That key is deliberately not retained. Re-reading old
  // process IDs (or asking for that discarded key) cannot re-prove completion.
  // Consume the validated durable receipt, never an unauthenticated journal.
  assert.equal(retained.state, 'recorded');
  assert.deepEqual(retained.intent, captured.intent);
  assert.deepEqual(retained.receipt, captured.receipt);
}

async function main() {
  assert.equal(process.platform, 'darwin'); assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  assert.ok(process.argv.length === 6 || process.argv.length === 8);
  assert.equal(process.argv[2], '--evidence-root'); assert.equal(process.argv[4], '--deadline');
  if (process.argv.length === 8) {
    assert.equal(process.argv[6], '--seed'); assert.equal(process.argv[7], 'source-repository');
  }
  const seedScope = process.argv.length === 8 ? 'source-repository' : 'private-one-file';
  evidenceRoot = process.argv[3]; deadlineAt = Date.parse(process.argv[5]);
  assert.ok(Number.isSafeInteger(deadlineAt) && new Date(deadlineAt).toISOString() === process.argv[5]);
  assert.ok(deadlineAt > startedWall && deadlineAt - startedWall <= maximumOverallMs);
  deadlineMonotonicMs = started + deadlineAt - startedWall;
  assert.ok(isAbsolute(evidenceRoot) && resolve(evidenceRoot) === evidenceRoot && dirname(evidenceRoot) !== evidenceRoot);
  assert.equal(realpathSync(evidenceRoot), evidenceRoot);
  const within = (parent, child) => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
  assert.ok(!within(repository, evidenceRoot) && !within(evidenceRoot, repository));
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
  const { artifactDigest, readArtifactSnapshot, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_ENTRIES } = await load('core/universe/artifacts.js');
  const { captureUniversePreparationMeasurement, readUniversePreparationMeasurementCapture } = await load('core/universe/preparation-measurement-capture.js');
  const { parsePreparationMeasurementReport } = await load('core/universe/preparation-measurement-report.js');
  const { extractPreparationScenarioVector } = await load('core/universe/preparation-measurement-comparison.js');
  const { calibratePreparationMeasurements, parsePreparationMeasurementCalibration } = await load('core/universe/preparation-measurement-calibration.js');
  guard(); announce('source-and-runtime-preflight');
  const installed = resolveBuiltinEvaluator('preparation-measurement-v1');
  // Ambient Git overrides can redirect init/add/commit despite -C. Discard all
  // inherited GIT_* settings; real HOME/ASHLR_HOME/KILL remain unchanged.
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const gitEnv = { ...inheritedEnv, PATH: `${dirname(installed.git.path)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0' };
  const git = (repo, ...args) => {
    guard();
    const value = execFileSync(installed.git.path, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: Math.max(1, Math.floor(Math.min(10_000,
        deadlineAt - Date.now(), deadlineMonotonicMs - performance.now()))), maxBuffer: 4 * 1024 * 1024, env: gitEnv });
    guard(); return value;
  };
  const sourceHead = git(repository, 'rev-parse', 'HEAD').trim(), sourceBlob = git(repository, 'rev-parse', `${sourceHead}:${target}`).trim();
  const sourceTree = git(repository, 'rev-parse', `${sourceHead}^{tree}`).trim();
  const repositoryIdentity = lstatSync(repository);
  const parseEntries = (text, index) => {
    assert.ok(text.endsWith('\0')); const rows = text.slice(0, -1).split('\0');
    assert.ok(rows.length > 0 && rows.length <= MAX_ARTIFACT_ENTRIES);
    const names = new Set();
    return rows.map(row => {
      const match = (index ? /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([^\0]+)$/ :
        /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/).exec(row);
      assert.ok(match); const [, mode, oid, path] = match;
      assert.ok(!isAbsolute(path) && !path.includes('\\') && ![...path].some(character => {
        const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
      }) &&
        path.split('/').every(part => part && part !== '.' && part !== '..' && !['.git', '.ashlr'].includes(part.toLowerCase())) &&
        !names.has(path)); names.add(path);
      return { mode, oid, path };
    }).sort((a, b) => a.path.localeCompare(b.path));
  };
  const sourceEntries = seedScope === 'source-repository' ? parseEntries(git(repository, 'ls-tree', '-rz', '--full-tree', sourceHead), false) : null;
  const assertSourceRepository = () => {
    const current = lstatSync(repository);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && realpathSync(repository) === repository &&
      current.dev === repositoryIdentity.dev && current.ino === repositoryIdentity.ino &&
      current.uid === repositoryIdentity.uid && current.mode === repositoryIdentity.mode);
    assert.equal(git(repository, 'rev-parse', 'HEAD').trim(), sourceHead);
    assert.equal(git(repository, 'rev-parse', `${sourceHead}^{tree}`).trim(), sourceTree);
    // initUniverse's existing Git reader has an independent environment. Refuse
    // object substitution or partial-clone fetch requirements before calling it.
    assert.equal(git(repository, 'for-each-ref', '--format=%(refname)', 'refs/replace'), '');
    // Effective config includes config.worktree overrides. Global/system config
    // remains disabled by gitEnv; local-only inspection would miss those overrides.
    const config = git(repository, 'config', '--includes', '--null', '--list');
    assert.ok(!config.split('\0').filter(Boolean).some(row => {
      const name = row.split('\n', 1)[0].toLowerCase();
      return name === 'extensions.partialclone' || /^remote\..+\.promisor$/.test(name);
    }));
    // Raw stage-zero index tuples and raw file bytes avoid clean/process filters
    // and ignore assume-unchanged/skip-worktree hints. Never walk node_modules,
    // untracked output or Git metadata, and never hash via a Git worktree API.
    const assertIndex = () => assert.deepEqual(parseEntries(git(repository, 'ls-files', '--stage', '-z'), true), sourceEntries);
    assertIndex(); let totalBytes = 0; const observed = [];
    const identity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    for (const entry of sourceEntries) {
      guard(); const path = join(repository, entry.path), before = lstatSync(path, { bigint: true });
      assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && realpathSync(path) === path &&
        before.size >= 0n && before.size <= BigInt(MAX_ARTIFACT_BYTES) &&
        ((before.mode & 0o111n) !== 0n) === (entry.mode === '100755'));
      totalBytes += Number(before.size); assert.ok(totalBytes <= MAX_ARTIFACT_BYTES);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        assert.deepEqual(identity(fstatSync(fd, { bigint: true })), identity(before));
        const hash = createHash(entry.oid.length === 40 ? 'sha1' : 'sha256').update(`blob ${before.size}\0`);
        const chunk = Buffer.alloc(64 * 1024); let bytes = 0;
        while (bytes <= Number(before.size)) {
          guard(); const count = readSync(fd, chunk, 0, Math.min(chunk.length, Number(before.size) + 1 - bytes), bytes);
          if (count === 0) break;
          bytes += count; assert.ok(bytes <= Number(before.size)); hash.update(chunk.subarray(0, count));
        }
        assert.equal(bytes, Number(before.size)); assert.equal(hash.digest('hex'), entry.oid);
        assert.deepEqual(identity(fstatSync(fd, { bigint: true })), identity(before));
        assert.deepEqual(identity(lstatSync(path, { bigint: true })), identity(before)); assert.equal(realpathSync(path), path);
        observed.push({ path, identity: identity(before) });
      } finally { closeSync(fd); }
    }
    for (const entry of observed) {
      guard(); assert.deepEqual(identity(lstatSync(entry.path, { bigint: true })), entry.identity);
      assert.equal(realpathSync(entry.path), entry.path);
    }
    assertIndex();
    const after = lstatSync(repository);
    assert.ok(after.dev === repositoryIdentity.dev && after.ino === repositoryIdentity.ino && realpathSync(repository) === repository);
    assert.equal(git(repository, 'rev-parse', 'HEAD').trim(), sourceHead);
    assert.equal(git(repository, 'rev-parse', `${sourceHead}^{tree}`).trim(), sourceTree);
    guard();
  };
  if (seedScope === 'source-repository') assertSourceRepository();
  const source = readFileSync(join(repository, target));
  assert.ok(source.equals(Buffer.from(git(repository, 'cat-file', 'blob', sourceBlob), 'utf8')));
  const fresh = () => {
    guard(); assert.deepEqual(resolveBuiltinEvaluator('preparation-measurement-v1'), installed);
    assert.equal(git(repository, 'rev-parse', 'HEAD').trim(), sourceHead);
    if (seedScope === 'source-repository') assertSourceRepository();
    assert.ok(readFileSync(join(repository, target)).equals(source)); guard();
  };
  fresh(); saveJson('source-origin.json', { schemaVersion: 1, repository, sourceHead, sourceTree, seedScope, target, sourceBlob,
    sourceSha256: sha(source), node: { path: process.execPath, version: process.version }, installed });
  const seedRepo = seedScope === 'source-repository' ? repository : join(evidenceRoot, 'seed-repository');
  let revision = sourceHead;
  if (seedScope === 'private-one-file') {
    mkdirSync(join(seedRepo, dirname(target)), { recursive: true, mode: 0o700 });
    writeFileSync(join(seedRepo, target), source, { mode: 0o600, flag: 'wx' });
    git(seedRepo, 'init', '-q', '--template=', '--initial-branch=main'); git(seedRepo, 'add', '--', target);
    git(seedRepo, '-c', 'user.name=Diagnostic Fixture', '-c', 'user.email=diagnostic@example.invalid', 'commit', '-qm', 'Unchanged pinned preparation source');
    revision = git(seedRepo, 'rev-parse', 'HEAD').trim();
  }
  const manifest = { schemaVersion: 1, id: universeId, name: 'Retained unchanged v2 preparation calibration',
    objective: 'Three fixed diagnostics; never execute a variant, score, promote or deliver', seed: { repo: seedRepo, revision },
    metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: evaluationTimeoutMs, trialTimeoutMs: 900_000 },
    evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: evaluationTimeoutMs },
    variants: [{ id: 'never-run', niche: 'verification', hypothesis: 'Diagnostic only', command: [process.execPath, '-e', 'process.exit(91)'] }] };
  saveJson('manifest.json', manifest);
  const root = join(evidenceRoot, 'universe');
  saveJson('invocation.json', { schemaVersion: 1, root, universeId, captureIds, seedScope, sourceTree, evaluationTimeoutMs,
    deadlineAt: new Date(deadlineAt).toISOString(), maximumOverallMs, automaticRetry: false, noCleanup: true });
  // Core seed materialization selects Git by PATH. Keep its executable lookup
  // pinned too; HOME, ASHLR_HOME and all real stop settings remain untouched.
  const inheritedPath = process.env.PATH;
  restorePath = () => { if (inheritedPath === undefined) delete process.env.PATH; else process.env.PATH = inheritedPath; };
  process.env.PATH = gitEnv.PATH;
  fresh(); initUniverse(manifest, { root });
  const directory = universePath(root, universeId), record = manifestRecord(directory), beforeRecords = readRecords(directory);
  if (seedScope === 'source-repository') {
    fresh();
    assert.deepEqual(record.manifest.seed, { repo: repository, revision: sourceHead });
    assert.equal(record.seedArtifact.revision, sourceHead);
    const actual = readArtifactSnapshot(record.seedArtifact.path);
    assert.equal(actual.digest, record.seedArtifact.digest);
    const entries = actual.entries.map(entry => {
      guard(); const algorithm = sourceHead.length === 40 ? 'sha1' : 'sha256';
      return { path: entry.path, mode: entry.executable ? '100755' : '100644',
        oid: createHash(algorithm).update(`blob ${entry.data.length}\0`).update(entry.data).digest('hex') };
    }).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(entries, sourceEntries); fresh();
  }
  const seedBefore = snapshot(record.seedArtifact.path), repoBefore = seedScope === 'private-one-file' ? snapshot(seedRepo) : null;
  let baselineVector;
  for (const captureId of captureIds) {
    fresh(); announce(captureId);
    const request = { root, universeId, captureId };
    const captured = await captureUniversePreparationMeasurement({ ...request, signal: controller.signal });
    // Preserve returned failure/partial evidence BEFORE checking success or time.
    saveJson(`${captureId}-capture.json`, captured);
    const raw = captured.receipt?.report?.stdout;
    if (raw !== undefined) save(`${captureId}-report.json`, raw);
    assertSettledCapture(captured, readUniversePreparationMeasurementCapture(request));
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
    assert.deepEqual(readRecords(directory), beforeRecords); assert.equal(snapshot(record.seedArtifact.path), seedBefore);
    if (seedScope === 'private-one-file') assert.equal(snapshot(seedRepo), repoBefore); else assertSourceRepository();
    const settled = snapshot(root, directory);
    assertSettledCapture(captured, readUniversePreparationMeasurementCapture(request));
    guard();
    const replay = await captureUniversePreparationMeasurement({ ...request, signal: controller.signal });
    assert.equal(replay.disposition, 'replayed'); assert.deepEqual(replay.receipt, captured.receipt); assert.equal(snapshot(root, directory), settled);
    fresh();
    if (baselineVector) assert.deepEqual(vector, baselineVector); else baselineVector = vector;
    saveJson(`${captureId}-verified.json`, { schemaVersion: 1, scope: 'diagnostic-only', checks: 23,
      regions: 15, qualifications: 2, reportSha256: sha(raw), processGroupSettlement: 'group-exit-confirmed', unchangedReplay: true });
  }
  announce('calibration-publication'); fresh();
  const settled = snapshot(root, directory);
  const descriptor = calibratePreparationMeasurements({ root, universeId, captureIds, expectedSourceDigest: sha(source) });
  assert.equal(descriptor.workload.id, 'preparation-workflows-v2'); assert.equal(descriptor.provenance.length, 3);
  assert.deepEqual(descriptor.scenarios, baselineVector); assert.equal(snapshot(root, directory), settled);
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
  restorePath?.();
  if (timer) clearTimeout(timer);
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}

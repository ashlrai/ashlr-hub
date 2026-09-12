/** Fixed candidate-linked measurement, not yet a frozen numerical benchmark.
 * node --experimental-vm-modules --no-warnings <this> <fixed-bridge.mjs>
 * Candidate execution is a separate, OS-confined process. Expected results,
 * comparisons, fixture changes and final output remain in this controller.
 * Read-only command counts are controller-observed diagnostics, not a frozen reward.
 * Output deliberately is NOT the Universe passed/score evaluation protocol.
 * Only engineering-preparation.ts is loaded from ASHLR_UNIVERSE_CANDIDATE.
 */
import cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { createHash } from 'node:crypto';
import strictAssert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createPreparationCandidateSession } from './preparation-verification-controller.mjs';
import { createBuiltinActivityTracker } from './preparation-verification-activity.mjs';
import { MAX_SESSION_DURATION_MS } from './preparation-verification-protocol.mjs';
import { resolvePreparationGit, assertPreparationGit } from './preparation-verification-native.mjs';

// Capture the actual checks before any candidate code is evaluated.
const assert = Object.freeze(Object.fromEntries(['ok', 'equal', 'deepEqual', 'throws'].map(key => [key, strictAssert[key].bind(strictAssert)])));

const sha = value => createHash('sha256').update(value).digest('hex');
let failure = 'HARNESS_INITIALIZATION_FAILED';
let checkpoint = 'initialize';
let gitPin;
const stop = new globalThis.AbortController();
const onStop = () => stop.abort();
process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
let activity;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const save = (file, value) => fs.writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function snapshot(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { mode: String(stat.mode), ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isSymbolicLink() ? { symlink: fs.readlinkSync(file) }
      : stat.isDirectory() ? Object.fromEntries(fs.readdirSync(file).sort().map(name => [name, snapshot(path.join(file, name))])) : sha(fs.readFileSync(file)) };
}
// Full reports must observe an uncommissioned home just like the child. Setup
// may have created a private signing identity; never copy that authority into it.
function expectedInEmptyHome(base, read) {
  const home = fs.mkdtempSync(path.join(base, 'expected-home-'));
  const keys = ['HOME', 'USERPROFILE', 'ASHLR_HOME'];
  const prior = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = home;
    return read();
  } finally {
    keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; });
  }
}
function git(repo, ...args) {
  // Trusted fixture setup uses the same developer Git identity as the broker.
  return cp.execFileSync(gitPin.path, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_DATE: '2026-09-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T00:00:00Z' } }).trim();
}
function fixture(base, count) {
  const root = path.join(base, `files-${count}`); fs.mkdirSync(root, { mode: 0o700 });
  const workspace = path.join(root, 'repo'); const transport = path.join(root, 'transport');
  for (const dir of [workspace, transport]) { fs.mkdirSync(dir, { mode: 0o700 }); git(dir, 'init', '-q', '--template=', '--initial-branch=main'); }
  fs.writeFileSync(path.join(workspace, 'value.json'), '0\n');
  const evaluatorFiles = Array.from({ length: count }, (_, index) => `fixed-${index}.mjs`);
  for (const file of evaluatorFiles) fs.writeFileSync(path.join(workspace, file), '// fixed protected evaluator input\n'); // Duplicate object IDs are intentional.
  if (count > 1) fs.chmodSync(path.join(workspace, evaluatorFiles[count - 1]), 0o755);
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed seed');
  const revision = git(workspace, 'rev-parse', 'HEAD');
  // The comparator must come from the commit, never these deliberately dirty bytes.
  for (const file of evaluatorFiles) fs.writeFileSync(path.join(workspace, file), '// dirty checkout must never become comparator\n');
  const poolPath = path.join(root, 'pool.json'); const bindingsPath = path.join(root, 'bindings.json'); const observationsPath = path.join(root, 'observations.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]); save(observationsPath, []);
  const resourceRuntime = path.join(root, 'runtime.json'); const runtime = { schemaVersion: 1, root: path.join(root, 'ledger'), workspace: transport, poolPath, bindingsPath, observationsPath };
  save(resourceRuntime, runtime); const projectsFile = path.join(root, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe = { schemaVersion: 1, id: 'repair', name: 'Fixed verification fixture', objective: 'Measure protected input verification without changing its meaning', projectId: 'default',
    seedRevision: revision, metric: { name: 'value', direction: 'maximize', minImprovement: 1 },
    evaluation: { command: [process.execPath, ...evaluatorFiles], timeoutMs: 2000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 45000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: evaluatorFiles, allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Improve value' }] }, delivery: { branch: 'codex/prepared' },
    execution: { maxDurationMs: 60000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 90000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  return { root, runtime, options: { recipe, workspace, resourceRuntime, projectsFile, output: path.join(root, 'bundle') } };
}
async function evaluate() {
  const metrics = {}; const workflows = []; let checks = 0; let session;
  let workload = 'preparation-leaf-v1';
  try {
    assert.equal(process.argv.length, 3);
    const bridgePath = fileURLToPath(new URL('./preparation-bridge.mjs', import.meta.url));
    assert.equal(process.argv[2], bridgePath);
    if (process.env.ASHLR_UNIVERSE_BUILTIN_ACTIVITY) activity = createBuiltinActivityTracker(process.env.ASHLR_UNIVERSE_BUILTIN_ACTIVITY);
    if (activity) workload = 'preparation-workflows-v1';
    if (activity) {
      const text = process.env.ASHLR_UNIVERSE_BUILTIN_GIT;
      assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 4096);
      gitPin = JSON.parse(text);
    } else gitPin = resolvePreparationGit();
    assertPreparationGit(gitPin);
    const deadlineAt = activity ? Date.parse(activity.owner.deadlineAt) : Infinity;
    const monotonicDeadline = performance.now() + (deadlineAt - Date.now());
    const remaining = () => Math.floor(Math.min(deadlineAt - Date.now(), monotonicDeadline - performance.now()));
    function guard() { if (stop.signal.aborted || remaining() <= 0) throw new Error('MEASUREMENT_CANCELLED_OR_EXPIRED'); }
    const bridge = await import(pathToFileURL(bridgePath).href);
    const candidateRoot = process.env.ASHLR_UNIVERSE_CANDIDATE;
    assert.ok(typeof candidateRoot === 'string' && path.isAbsolute(candidateRoot) && fs.realpathSync(candidateRoot) === candidateRoot);
    failure = 'FIXTURE_SETUP_FAILED';
    const base = fs.mkdtempSync(path.join(process.env.HOME, 'verification-'));
    for (const count of [1, 4]) {
      guard();
      failure = 'FIXTURE_SETUP_FAILED';
      const f = fixture(base, count);
      const poolRuntime = bridge.dependencies['./pool-runtime.js'];
      const pool = JSON.parse(fs.readFileSync(f.runtime.poolPath, 'utf8'));
      const bindings = JSON.parse(fs.readFileSync(f.runtime.bindingsPath, 'utf8'));
      poolRuntime.setResourcePoolAllocation(f.runtime.root, pool, bindings, 40, 0);
      poolRuntime.setResourceWorkerAccess(f.runtime.root, pool, bindings, ['worker'], 0);
      const expectedPlan = bridge.baseline.checkResourceEngineeringPreparation(f.options);
      const input = { ...f.options, expectedPlanDigest: expectedPlan.planDigest };
      const prepared = bridge.baseline.prepareResourceEngineeringBundle(input);
      const metadata = { ...prepared }; delete metadata.commissioning; delete metadata.consoleArguments;
      const expectedMetadata = { ...metadata, disposition: 'replayed' };
      failure = 'CANDIDATE_STARTUP_FAILED';
      guard();
      const beforeStartup = snapshot(f.root);
      const timeoutMs = activity ? Math.min(60000, remaining()) : 60000;
      session = await createPreparationCandidateSession({ bridge, bridgePath, candidateRoot, fixtureRoot: f.root, workRoot: base,
        timeoutMs, signal: stop.signal, activity, gitPin });
      assert.deepEqual(snapshot(f.root), beforeStartup);
      failure = 'CANDIDATE_BEHAVIOR_FAILED';
      for (const [name, options, expected] of [
        ['check', f.options, expectedPlan], ['metadata', input, expectedMetadata],
      ]) {
        const before = snapshot(f.root); const result = await session.call(name, options);
        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, expected); assert.deepEqual(snapshot(f.root), before);
        assert.ok(result.measurement.processes > 0 && result.measurement.blobProcesses > 0);
        metrics[`files_${count}_${name}_processes`] = result.measurement.processes;
        metrics[`files_${count}_${name}_blob_processes`] = result.measurement.blobProcesses;
        checks++;
      }
      // Success never grants reuse after an immutable runtime mutation.
      save(f.options.resourceRuntime, { ...f.runtime, capacityWaitMs: 1000 });
      const before = snapshot(f.root);
      assert.equal((await session.call('metadata', input)).error, 'candidate-threw'); assert.deepEqual(snapshot(f.root), before); checks++;
      // Cross-process JSON cannot convey accessors. Check a genuinely malformed
      // data input; child-reported getter activity would not be independent proof.
      assert.throws(() => bridge.baseline.checkResourceEngineeringPreparation({ recipe: null }));
      assert.equal((await session.call('check', { recipe: null })).error, 'candidate-threw');
      assert.deepEqual(snapshot(f.root), before); checks++;
      failure = 'CANDIDATE_SHUTDOWN_FAILED'; await session.close(); session = undefined;
      assert.deepEqual(snapshot(f.root), before); guard();
    }
    // The installed workload is explicit and versioned. Legacy standalone leaf
    // measurements retain their original operation set and numeric meaning.
    if (activity) {
      const { createPreparationWorkflowFixture } = await import('./preparation-verification-fixtures.mjs');
      metrics.fixture_owned_process_groups = 0;
      for (const kind of ['manager', 'successor']) {
        checkpoint = `${kind}:setup`;
        guard(); failure = 'WORKFLOW_FIXTURE_SETUP_FAILED';
        const fixtureRoot = path.join(base, kind); fs.mkdirSync(fixtureRoot, { mode: 0o700 });
        const setup = await createPreparationWorkflowFixture(kind, fixtureRoot, { activity, signal: stop.signal,
          deadlineAt: new Date(deadlineAt).toISOString() }, gitPin);
        const f = setup.fixture;
        metrics.fixture_owned_process_groups += setup.measurement.processGroups;
        guard();
        const input = kind === 'manager' ? f.bundleInput : { ...f.options, expectedPlanDigest: f.plan.planDigest };
        const full = expectedInEmptyHome(base, () => kind === 'manager'
          ? bridge.baseline.readPreparedResourceEngineeringBundle(input)
          : bridge.baseline.readResourceEngineeringSuccessorBundle(input));
        const healthy = kind === 'manager' ? [
          ['manager-open', f.options, { catalog: f.catalog }],
          ['bundle', input, full], ['manager-check', f.requests[0], f.plans[0]],
          ['manager-replay', { ...f.requests[0], expectedPlanDigest: f.plans[0].planDigest }, { ...f.prepared[0], disposition: 'replayed' }],
        ] : [
          ['successor-check', f.options, f.plan],
          ['successor-metadata', input, { ...Object.fromEntries(Object.entries(f.prepared)
            .filter(([key]) => key !== 'commissioning' && key !== 'consoleArguments')), disposition: 'replayed' }],
          ['successor-bundle', input, full],
        ];
        const before = snapshot(fixtureRoot);
        checkpoint = `${kind}:startup`;
        guard(); failure = 'WORKFLOW_CANDIDATE_STARTUP_FAILED';
        session = await createPreparationCandidateSession({ bridge, bridgePath, candidateRoot, fixtureRoot, workRoot: base,
          timeoutMs: Math.min(MAX_SESSION_DURATION_MS, remaining()), signal: stop.signal, activity, gitPin });
        assert.deepEqual(snapshot(fixtureRoot), before);
        failure = 'WORKFLOW_CANDIDATE_BEHAVIOR_FAILED';
        const observed = [];
        for (const [method, args, expected] of healthy) {
          checkpoint = `${kind}:${method}`;
          guard(); const result = await session.call(method, args);
          assert.equal(result.error, undefined); assert.deepEqual(result.value, expected);
          if (method !== 'manager-close') assert.ok(result.measurement.processes > 0);
          assert.deepEqual(snapshot(fixtureRoot), before);
          observed.push({ method, ...result.measurement }); checks++;
        }
        // Mutations are trusted fixture changes and never candidate work.
        // Keep the manager open: closure must not itself explain a refusal.
        let refusal;
        if (kind === 'manager') {
          save(f.options.config.resourceRuntime, { ...f.runtime, capacityWaitMs: 1000 });
          refusal = [['manager-check', f.requests[0]],
            ['manager-replay', { ...f.requests[0], expectedPlanDigest: f.plans[0].planDigest }]];
        } else {
          assert.equal(f.git('rev-parse', '--verify', 'refs/heads/codex/upstream'), f.receipt.commit);
          f.git('update-ref', 'refs/heads/codex/upstream', f.revision);
          assert.equal(f.git('rev-parse', '--verify', 'refs/heads/codex/upstream'), f.revision);
          refusal = [['successor-metadata', input]];
        }
        const changed = snapshot(fixtureRoot); assert.ok(canonical(changed) !== canonical(before));
        for (const [method, args] of refusal) {
          checkpoint = `${kind}:${method}:changed-evidence`;
          guard(); const result = await session.call(method, args);
          assert.equal(result.error, 'candidate-threw'); assert.equal(Object.hasOwn(result, 'value'), false);
          assert.deepEqual(snapshot(fixtureRoot), changed);
          observed.push({ method, ...result.measurement }); checks++;
        }
        if (kind === 'manager') {
          checkpoint = 'manager:close';
          const result = await session.call('manager-close', null);
          assert.equal(result.error, undefined); assert.equal(result.value, null);
          assert.deepEqual(snapshot(fixtureRoot), changed);
          observed.push({ method: 'manager-close', ...result.measurement }); checks++;
        }
        const ledger = session.measurementLedger();
        assert.deepEqual(ledger.requests, observed.map((row, index) => ({ id: index + 1, ...row })));
        assert.equal(ledger.processes, observed.reduce((sum, row) => sum + row.processes, 0));
        assert.equal(ledger.blobProcesses, observed.reduce((sum, row) => sum + row.blobProcesses, 0));
        checkpoint = `${kind}:shutdown`;
        failure = 'WORKFLOW_CANDIDATE_SHUTDOWN_FAILED'; await session.close(); session = undefined;
        assert.deepEqual(snapshot(fixtureRoot), changed); guard();
        workflows.push({ name: kind, ...ledger });
      }
      metrics.workflow_processes = workflows.reduce((sum, row) => sum + row.processes, 0);
      metrics.workflow_blob_processes = workflows.reduce((sum, row) => sum + row.blobProcesses, 0);
    }
    assertPreparationGit(gitPin);
    metrics.correctness_checks = checks;
    metrics.verification_processes = Object.entries(metrics).filter(([key]) => key.startsWith('files_') && key.endsWith('_processes') && !key.endsWith('_blob_processes')).reduce((sum, [, value]) => sum + value, 0);
    return { schemaVersion: 1, kind: 'preparation-verification-measurement', ...(activity ? { workload, workflows } : {}), checksPassed: true, metrics, diagnostics: [] };
  } catch (error) {
    if (error?.code === 'CANDIDATE_CONFINEMENT_UNAVAILABLE') failure = 'CANDIDATE_CONFINEMENT_UNAVAILABLE';
    if (session) { try { await session.close(); } catch { /* A cleanup failure can never become an accepted measurement. */ } }
    return { schemaVersion: 1, kind: 'preparation-verification-measurement', ...(activity ? { workload, workflows } : {}), checksPassed: false,
      metrics: { correctness_checks: checks }, diagnostics: [{ code: failure, message: activity
        ? `Pinned verification workload did not satisfy its fixed checks at ${checkpoint}.`
        : 'Pinned verification prototype did not satisfy its fixed checks.' }] };
  }
}
const measurement = await evaluate();
try { activity?.complete(); }
catch { measurement.checksPassed = false; measurement.diagnostics = [{ code: 'PROCESS_SETTLEMENT_UNCONFIRMED', message: 'Owned process settlement remains unconfirmed.' }]; }
process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop);
process.stdout.write(JSON.stringify(measurement) + '\n');

/** FIRST-SLICE prototype, not yet a frozen numerical benchmark.
 * node --experimental-vm-modules --no-warnings <this> <fixed-bridge.mjs>
 * Candidate module loading is closed and expected results remain in this module.
 * VM modules are NOT a security sandbox: existing Universe OS confinement is required.
 * Host functions remain reachable through the bridge: this prototype is not a
 * competitive reward authority and does not resist host-function constructor escapes.
 * Output deliberately is NOT the Universe passed/score evaluation protocol.
 * Only engineering-preparation.ts is loaded from ASHLR_UNIVERSE_CANDIDATE.
 */
import cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import { createContext, runInContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createHash } from 'node:crypto';
import strictAssert from 'node:assert/strict';

// Capture the actual checks before any candidate code is evaluated.
const assert = Object.freeze(Object.fromEntries(['ok', 'equal', 'deepEqual', 'throws'].map(key => [key, strictAssert[key].bind(strictAssert)])));

const TARGET = 'src/core/resources/engineering-preparation.ts';
const sha = value => createHash('sha256').update(value).digest('hex');
const original = Object.fromEntries(['execFileSync', 'spawnSync', 'execSync', 'execFile', 'exec', 'spawn', 'fork'].map(key => [key, cp[key]]));
let measuring = false;
let launches = [];
let failure = 'HARNESS_INITIALIZATION_FAILED';
// Installed before importing the bridge so its named builtin bindings are counted too.
// Non-shell synchronous Git/private-storage probes are the only scored process routes.
for (const key of Object.keys(original)) cp[key] = function (...args) {
  if (measuring) {
    const executable = args[0];
    if (!['execFileSync', 'spawnSync'].includes(key) || typeof executable !== 'string' ||
        !['git', 'ls', 'ps'].includes(path.basename(executable))) throw new Error('UNEXPECTED_PROCESS_ROUTE');
    launches.push({ api: key, executable: path.basename(executable), args: args[1] });
  }
  return Reflect.apply(original[key], this, args);
};
syncBuiltinESMExports();
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const save = (file, value) => fs.writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function snapshot(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { mode: String(stat.mode), ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isDirectory() ? Object.fromEntries(fs.readdirSync(file).sort().map(name => [name, snapshot(path.join(file, name))])) : sha(fs.readFileSync(file)) };
}
function git(repo, ...args) {
  return original.execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME,
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
async function candidate(bridge) {
  const root = process.env.ASHLR_UNIVERSE_CANDIDATE;
  assert.ok(typeof root === 'string' && path.isAbsolute(root) && fs.realpathSync(root) === root);
  const target = path.join(root, TARGET); const before = fs.lstatSync(target, { bigint: true });
  assert.ok(before.isFile() && before.nlink === 1n && before.size < 256n * 1024n && fs.realpathSync(target) === target);
  const source = fs.readFileSync(target, 'utf8'); const after = fs.lstatSync(target, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
  const context = createContext({
    process: Object.freeze({ env: Object.freeze({ PATH: process.env.PATH }) }),
    Buffer: Object.freeze(Object.fromEntries(['byteLength', 'from', 'alloc', 'concat', 'isBuffer'].map(key => [key, Buffer[key].bind(Buffer)]))),
  }, { codeGeneration: { strings: false, wasm: false } });
  const objectPrototype = runInContext('Object.prototype', context);
  // Preserve production own-data validation across the separate measurement
  // realm. Accessors and foreign prototypes are never evaluated or laundered.
  function hostData(value, depth = 0) {
    if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
    if (depth > 64) throw new Error('BOUNDARY_DATA_DEPTH');
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== objectPrototype && proto !== Object.prototype && proto !== null) return value;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))) return value;
    if (Array.isArray(value)) return Array.from(value, item => hostData(item, depth + 1));
    return Object.fromEntries(Object.entries(descriptors).map(([key, property]) => [key, hostData(property.value, depth + 1)]));
  }
  const subject = new SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), {
    context, identifier: 'candidate-engineering-preparation', importModuleDynamically: () => { throw new Error('DYNAMIC_IMPORT_REFUSED'); } });
  const builtins = { 'node:child_process': Object.freeze(Object.fromEntries(Object.keys(original).map(key => [key, cp[key]]))), 'node:fs': fs, 'node:path': path };
  await subject.link(specifier => {
    const namespace = Object.hasOwn(builtins, specifier) ? builtins[specifier] : bridge.dependencies[specifier];
    if (!namespace) throw new Error('IMPORT_REFUSED');
    const keys = Object.keys(namespace);
    return new SyntheticModule(keys, function () {
      for (const key of keys) {
        const value = namespace[key];
        this.setExport(key, typeof value === 'function' && !/^class\s/.test(Function.prototype.toString.call(value))
          ? (...args) => value(...args.map(arg => hostData(arg))) : value);
      }
    }, { context });
  });
  await subject.evaluate({ timeout: 1000 });
  return Object.freeze({
    checkResourceEngineeringPreparation: input => hostData(subject.namespace.checkResourceEngineeringPreparation(input)),
    readPreparedResourceEngineeringMetadata: input => hostData(subject.namespace.readPreparedResourceEngineeringMetadata(input)),
  });
}
function scored(action) {
  launches = []; measuring = true;
  try { const value = action(); return { value, launches: [...launches] }; }
  finally { measuring = false; }
}
async function evaluate() {
  const metrics = {}; let checks = 0;
  try {
    assert.equal(process.argv.length, 3);
    const bridgePath = process.argv[2]; assert.ok(path.isAbsolute(bridgePath));
    const bridge = await import(pathToFileURL(bridgePath).href);
    const subject = await candidate(bridge);
    failure = 'FIXTURE_SETUP_FAILED';
    const base = fs.mkdtempSync(path.join(process.env.HOME, 'verification-'));
    for (const count of [1, 4]) {
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
      failure = 'CANDIDATE_BEHAVIOR_FAILED';
      for (const [name, action, expected] of [
        ['check', () => subject.checkResourceEngineeringPreparation(f.options), expectedPlan],
        ['metadata', () => subject.readPreparedResourceEngineeringMetadata(input), expectedMetadata],
      ]) {
        const before = snapshot(f.root); const result = scored(action);
        assert.deepEqual(result.value, expected); assert.deepEqual(snapshot(f.root), before);
        const blobCalls = result.launches.filter(call => call.executable === 'git' && call.args.includes('cat-file')).length;
        assert.ok(result.launches.length > 0 && blobCalls > 0);
        metrics[`files_${count}_${name}_processes`] = result.launches.length;
        metrics[`files_${count}_${name}_blob_processes`] = blobCalls;
        checks++;
      }
      // Success never grants reuse after an immutable runtime mutation.
      save(f.options.resourceRuntime, { ...f.runtime, capacityWaitMs: 1000 });
      const before = snapshot(f.root);
      assert.throws(() => subject.readPreparedResourceEngineeringMetadata(input)); assert.deepEqual(snapshot(f.root), before); checks++;
      let getterCalls = 0;
      assert.throws(() => subject.checkResourceEngineeringPreparation(Object.defineProperty({}, 'recipe', { get() { getterCalls++; return f.options.recipe; } })));
      assert.equal(getterCalls, 0); checks++;
    }
    metrics.correctness_checks = checks;
    metrics.verification_processes = Object.entries(metrics).filter(([key]) => key.endsWith('_processes') && !key.endsWith('_blob_processes')).reduce((sum, [, value]) => sum + value, 0);
    return { schemaVersion: 1, kind: 'preparation-verification-measurement', checksPassed: true, metrics, diagnostics: [] };
  } catch {
    return { schemaVersion: 1, kind: 'preparation-verification-measurement', checksPassed: false,
      metrics: { correctness_checks: checks }, diagnostics: [{ code: failure, message: 'Pinned verification prototype did not satisfy its fixed checks.' }] };
  }
}
process.stdout.write(JSON.stringify(await evaluate()) + '\n');

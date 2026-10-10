/* global process, console */
// Advisory experiment only. This receipt cannot admit a release or reuse results.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { stripVTControlCharacters } from 'node:util';
import { bindSource } from './ci-source-binding.mjs';
import { normalizeReport } from './ci-qualification-lane.mjs';

export const MODULES = Object.freeze(['test/universe-calibrated-campaign.test.ts', 'test/universe-portfolio-controller.test.ts']);
const EXPECTED = JSON.parse(readFileSync(new URL('./ci-realio-worker-shadow-cases.json', import.meta.url), 'utf8'));
const states = Object.freeze({ passed: 0, failed: 1, skipped: 2, todo: 3, pending: 4 });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scalar = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].every((key) => a[key] === b[key]);
// Host point samples, not CPU utilization averages or memory-pressure readings.
const hostSample = () => ({ loadAverage: loadavg(), freeMemoryBytes: freemem() });

function privateBytes(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.size > 32 * 1024 * 1024 || before.mode & 0o7022) throw new Error('Unsafe private evidence');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, fstatSync(fd))) throw new Error('Private evidence identity changed');
    const bytes = readFileSync(fd);
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(path))) throw new Error('Private evidence changed during reading');
    return bytes;
  } finally { closeSync(fd); }
}

// Failure reports use the same occurrence-aware identity as normalizeReport.
// They never carry a provider name, test title, error message or local path out.
export function projectReport(raw, root, expected = EXPECTED) {
  if (!raw || !Array.isArray(raw.testResults) || !raw.testResults.length || raw.testResults.length > MODULES.length) throw new Error('Invalid report');
  if (typeof raw.success !== 'boolean') throw new Error('Invalid report state');
  const seen = new Set();
  const totals = [0, 0, 0, 0, 0];
  const modules = raw.testResults.map((module) => {
    if (!isAbsolute(module.name) || !Array.isArray(module.assertionResults) || module.assertionResults.length > 82 || !Object.hasOwn(states, module.status)) throw new Error('Invalid module');
    // Collection/import failures have no case results. Retain that failed
    // module and any surviving cases without treating an empty module as complete.
    if (!module.assertionResults.length && (raw.success || module.status !== 'failed')) throw new Error('Invalid empty module');
    const file = relative(root, module.name).split('\\').join('/');
    const moduleId = MODULES.indexOf(file);
    if (moduleId < 0 || seen.has(moduleId) || !scalar(module.startTime) || !scalar(module.endTime) || module.endTime < module.startTime) throw new Error('Invalid module identity or duration');
    seen.add(moduleId);
    const occurrences = new Map();
    const cases = module.assertionResults.map((item) => {
      if (typeof item.fullName !== 'string' || !item.fullName || item.fullName.length > 16_384 || !Object.hasOwn(states, item.status) || !(item.duration == null || scalar(item.duration)) || (raw.success && (item.failureMessages?.length ?? 0) !== 0)) throw new Error('Invalid case');
      const occurrence = occurrences.get(item.fullName) ?? 0;
      occurrences.set(item.fullName, occurrence + 1);
      const id = hash(`${file}\0${item.fullName}\0${occurrence}`);
      const state = states[item.status]; totals[state]++;
      return { id, state, durationMs: item.duration ?? null };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (module.status !== 'failed' && cases.some((c) => c.state === states.failed)) throw new Error('Module state disagrees with failed cases');
    const exactInventory = JSON.stringify(cases.map((c) => c.id)) === JSON.stringify(expected.find((m) => m.moduleId === moduleId)?.ids);
    return { moduleId, state: states[module.status], durationMs: module.endTime - module.startTime, startMs: module.startTime, endMs: module.endTime, exactInventory: Number(exactInventory), cases };
  }).sort((a, b) => a.moduleId - b.moduleId);
  if (raw.numTotalTests !== totals.reduce((a, b) => a + b, 0) || raw.numPassedTests !== totals[0] || raw.numFailedTests !== totals[1] || raw.numPendingTests !== totals[2] + totals[4] || raw.numTodoTests !== totals[3]) throw new Error('Report totals disagree');
  const start = Math.min(...modules.map((m) => m.startMs));
  const overlap = modules.length === 2 && Math.max(...modules.map((m) => m.startMs)) < Math.min(...modules.map((m) => m.endMs));
  const complete = modules.length === MODULES.length && modules.every((m) => m.exactInventory === 1);
  // Vitest success excludes failures but can coexist with unfinished pending
  // cases. Project those states first; normalize only a terminal pass candidate.
  const terminalPass = raw.success && complete && totals.slice(1).every((total) => total === 0) && modules.every((m) => m.state === states.passed);
  if (terminalPass) {
    const normalized = normalizeReport(raw, root);
    for (const module of modules) for (const item of module.cases) {
      if (normalized.find((m) => m.file === MODULES[module.moduleId])?.cases.find((c) => c.id === item.id)?.state !== 'passed') throw new Error('Case normalizer disagrees');
    }
  }
  return { complete: Number(complete), pass: Number(terminalPass), totals,
    overlapObserved: Number(overlap), modules: modules.map((m) => ({ ...m, startMs: m.startMs - start, endMs: m.endMs - start })) };
}

export function phaseTimings(log) {
  const line = stripVTControlCharacters(log).split('\n').find((s) => /^\s*Duration\s/.test(s));
  const result = {};
  for (const key of ['transform', 'setup', 'import', 'tests', 'environment']) {
    const match = line?.match(new RegExp(`\\b${key} ([0-9]+(?:\\.[0-9]+)?)(ms|s)\\b`));
    const duration = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : null;
    result[`${key}Ms`] = scalar(duration) ? duration : null;
  }
  return result;
}

export function armArgs(workers, report) {
  if (workers !== 1 && workers !== 2) throw new Error('Unsupported worker count');
  return ['run', 'test:ci', '--', '--project=real-io', ...MODULES, `--maxWorkers=${workers}`, `--fileParallelism=${workers === 2}`, '--bail=1', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
}

export function runShadow({ root, parent, env = process.env, run = spawnSync, now = () => performance.now(), expected = EXPECTED, bind = bindSource } = {}) {
  if (typeof process.getuid !== 'function' || !isAbsolute(root) || root !== realpathSync(root) || !isAbsolute(parent) || parent !== realpathSync(parent)) throw new Error('Canonical POSIX paths required');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REPOSITORY !== 'ashlrai/phantom' || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))) throw new Error('Manual canonical experiment required');
  const source = bind({ root, candidate: env.ASHLR_CANDIDATE_SHA, eventSha: env.GITHUB_SHA });
  const privateDir = realpathSync(mkdtempSync(join(parent, 'phantom-realio-private-'))); chmodSync(privateDir, 0o700);
  const directory = realpathSync(mkdtempSync(join(parent, 'phantom-realio-numeric-'))); chmodSync(directory, 0o700);
  const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(process.version).slice(1).map(Number);
  const receipt = { schemaVersion: 1, qualification: 0, resultReuse: 0, sourceHashes: [source.revision, source.tree, source.eventSha],
    moduleContentHashes: MODULES.map((file, moduleId) => ({ moduleId, sha256: hash(privateBytes(join(root, file))) })),
    run: [Number(env.GITHUB_RUN_ID), Number(env.GITHUB_RUN_ATTEMPT)], nodeVersion: version, host: { cpuCount: cpus().length, totalMemoryBytes: totalmem() }, arms: [], pass: 0 };
  const save = () => writeFileSync(join(directory, 'measurements.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  save();
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `numeric_dir=${directory}\n`);
  const childEnv = { ...env };
  // The unchanged wrapper owns each fresh HOME and watchdog. Strip inherited
  // optional policies so neither arm receives an experimental deadline or shard.
  for (const name of ['ASHLR_VITEST_TEST_TIMEOUT_MS', 'ASHLR_TEST_CI_WEIGHTED_PARTITION', 'ASHLR_TEST_CI_WEIGHTED_HINTS', 'ASHLR_TEST_CI_REPORT_DIRECTORY', 'ASHLR_TEST_CI_TIMEOUT_MS', 'ASHLR_TEST_CI_IDLE_TIMEOUT_MS', 'ASHLR_TEST_CI_TERMINATION_GRACE_MS', 'ASHLR_TEST_CI_HEARTBEAT_MS']) delete childEnv[name];
  for (const workers of [1, 2]) {
    const armDir = join(privateDir, String(workers)); mkdirSync(armDir, { mode: 0o700 });
    const report = join(armDir, 'report.json'); const log = join(armDir, 'console.log');
    const fd = openSync(log, 'wx', 0o600);
    const arm = { workers, status: 1, exitCode: null, wallMs: null, reportState: 0, hostBefore: hostSample() };
    receipt.arms.push(arm); save();
    const started = now();
    try {
      const result = run('npm', armArgs(workers, report), { cwd: root, env: childEnv, stdio: ['ignore', fd, fd] });
      const elapsed = now() - started;
      if (!scalar(elapsed)) throw new Error('Invalid measured duration');
      arm.wallMs = elapsed; arm.exitCode = Number.isInteger(result.status) ? result.status : null;
      arm.processError = Number(Boolean(result.error)); arm.signalled = Number(Boolean(result.signal));
    } catch { arm.processError = 1; }
    finally { closeSync(fd); arm.hostAfter = hostSample(); }
    try {
      const bytes = privateBytes(report);
      arm.reportHash = hash(bytes); arm.report = projectReport(JSON.parse(bytes), root, expected); arm.reportState = 1;
    } catch { arm.reportState = 2; }
    try { arm.phases = phaseTimings(privateBytes(log).toString('utf8')); } catch { arm.phases = phaseTimings(''); }
    try { arm.sourceUnchanged = Number(JSON.stringify(bind({ root, candidate: source.revision, eventSha: source.eventSha })) === JSON.stringify(source)); } catch { arm.sourceUnchanged = 0; }
    arm.status = Number(!(arm.exitCode === 0 && !arm.processError && !arm.signalled && arm.report?.pass === 1 && arm.sourceUnchanged === 1));
    save();
    if (arm.status !== 0) return { directory, pass: false };
  }
  receipt.pass = 1;
  receipt.wallReductionMs = receipt.arms[0].wallMs - receipt.arms[1].wallMs;
  receipt.wallReductionPercent = receipt.arms[0].wallMs > 0 ? 100 * (1 - receipt.arms[1].wallMs / receipt.arms[0].wallMs) : null;
  save();
  return { directory, pass: true };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 || process.platform !== 'darwin' || !process.env.GITHUB_OUTPUT) throw new Error('Manual hosted Mac experiment required');
    const result = runShadow({ root: realpathSync(process.cwd()), parent: realpathSync(process.env.RUNNER_TEMP) });
    console.log(`Advisory worker experiment completed: ${Number(result.pass)}`);
    process.exitCode = result.pass ? 0 : 1;
  } catch { console.error('Advisory worker experiment could not complete; no qualification authority.'); process.exitCode = 1; }
}

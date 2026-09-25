#!/usr/bin/env node
/**
 * scripts/gate.mjs — the fast local release gate.
 *
 *   npm run gate                 static checks + tests RELATED to your change + smoke set
 *   npm run gate -- --base REF   diff against REF instead of the merge-base with origin/master
 *   npm run gate:full            static checks + the complete backend and web suites
 *   npm run gate -- --json       machine-readable result on stdout
 *
 * GitHub Actions is off, so this is what verifies a release (docs/RELEASING-LOCALLY.md).
 *
 * Phase A (parallel): root build, web typecheck, eslint (cached), the real-io lane guard,
 * the docs check. Then the web build + first-paint budget. Then Phase B: backend and web
 * vitest, in parallel.
 *
 * Which tests run. The default mode selects tests through vitest's own import graph — the
 * same mechanism as `vitest --changed <ref>` — but hands vitest the changed-file list
 * itself (`vitest related <files>`). The difference is package.json: vitest treats ANY
 * package.json edit as "rerun everything", and every release bumps the version, which would
 * turn every release gate into the 20-minute full run. So the gate decides instead:
 *   - package-lock.json changed, or a dependency-shaped key of package.json changed
 *     (dependencies, overrides, engines, exports, ...)  → that suite runs in full;
 *   - a vitest/vite config or a vitest setup file changed → that suite runs in full (what
 *     vitest itself would do);
 *   - otherwise → tests whose import graph reaches a changed file, plus the smoke set
 *     (scripts/gate-smoke.json), which always runs.
 * What the import graph cannot see: a test that reads a changed file with fs instead of
 * importing it (fixtures, scripts read as text). `gate:full` covers that.
 *
 * Known failures (scripts/gate-known-failures.json): a failing test FILE listed there is
 * reported as KNOWN and does not fail the gate. Any other failing file, an unhandled error,
 * or vitest failing without naming a file fails it.
 *
 * Writes only to .ashlr-gate/ (logs, eslint cache, tsbuildinfo, the scratch web build,
 * vitest JSON reports), dist/ (the root build, as `npm run build` does) and OS temp (the
 * isolated HOME each test run gets, removed afterwards).
 *
 * Exit: 0 PASS, 1 FAIL, 2 usage error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GATE_DIR = '.ashlr-gate';
export const DEFAULT_BASE_REF = 'origin/master';

const USAGE = `usage: node scripts/gate.mjs [--full] [--base <ref>] [--json] [--fail-fast]
  --full        run the complete backend and web suites (npm run gate:full)
  --base <ref>  select tests changed since the merge-base with <ref> (default ${DEFAULT_BASE_REF})
  --json        print one JSON result object on stdout instead of the table
  --fail-fast   stop after the first phase that fails (default: only a failed build stops the tests)`;

export function parseArgs(argv) {
  const out = { full: false, base: null, json: false, failFast: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') out.full = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--fail-fast') out.failFast = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '--base') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--base needs a ref');
      out.base = value;
      i += 1;
    } else if (arg.startsWith('--base=')) {
      out.base = arg.slice('--base='.length);
      if (!out.base) throw new Error('--base needs a ref');
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (out.full && out.base) throw new Error('--full runs every test; --base has no effect with it');
  return out;
}

// ---------------------------------------------------------------------------
// Test selection (pure)
// ---------------------------------------------------------------------------

/** package.json keys whose change can alter what any module resolves to. */
export const DEPENDENCY_KEYS = Object.freeze([
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'overrides', 'bundleDependencies', 'bundledDependencies', 'engines', 'type', 'exports', 'imports',
]);

/** Dependency-shaped keys that differ between two package.json texts. Unparseable → all. */
export function packageDependencyChanges(baseText, currentText) {
  let before;
  let after;
  try {
    before = baseText == null ? {} : JSON.parse(baseText);
    after = JSON.parse(currentText);
  } catch {
    return [...DEPENDENCY_KEYS];
  }
  return DEPENDENCY_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/**
 * Did package-lock.json change anything but the root package's own version? A release bump
 * rewrites `version` and `packages[""].version`; that cannot change what a test resolves.
 */
export function lockfileDependencyChanged(baseText, currentText) {
  const strip = (text) => {
    const lock = JSON.parse(text);
    delete lock.version;
    if (lock.packages?.['']) delete lock.packages[''].version;
    return JSON.stringify(lock);
  };
  try {
    return baseText == null || strip(baseText) !== strip(currentText);
  } catch {
    return true;
  }
}

/**
 * Extensions no vitest module graph can contain. Deny-list on purpose: an unknown extension is
 * kept and costs a graph walk; wrongly dropping an importable one would skip its tests.
 */
const NON_MODULE_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rs', '.swift', '.toml', '.yml', '.yaml', '.lock', '.sh', '.py', '.plist', '.b64',
]);

function isModuleCandidate(file) {
  const name = basename(file);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a dotfile such as .gitignore
  return !NON_MODULE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** vitest's default forceRerunTriggers glob `**\/{vitest,vite}.config.*`. */
function isVitestConfig(file) {
  return /^(?:vitest|vite)\.config\./.test(basename(file));
}

/** Files that make vitest rerun a whole suite (its forceRerunTriggers incl. setupFiles). */
export const SUITE_TRIGGERS = Object.freeze({
  backend: ['vitest.config.ts', 'test/setup/home.ts', 'test/setup/home-isolation-guard.ts'],
  web: ['src/web-ui/test/setup.ts'],
});

/**
 * Pure: what each suite runs.
 * @param {{ full: boolean, changed: string[], dependencyKeys: string[], lockfileChanged?: boolean,
 *   smoke: {backend: string[], web: string[]} }} input
 *   `changed` are repo-relative POSIX paths; `dependencyKeys` / `lockfileChanged` come from
 *   packageDependencyChanges / lockfileDependencyChanged.
 * @returns {{ backend: SuitePlan, web: SuitePlan }} where SuitePlan is
 *   `{ mode: 'full' | 'related' | 'smoke', reason: string, files: string[] }`. `smoke` means
 *   nothing importable changed, so only the smoke files run, without walking the import graph
 *   of every test (the fixed cost of `vitest related`, ~40 s).
 */
export function planTests({ full, changed, dependencyKeys, lockfileChanged = false, smoke }) {
  const plan = {};
  for (const suite of ['backend', 'web']) {
    let reason = null;
    if (full) reason = 'gate:full';
    else if (lockfileChanged) reason = 'package-lock.json dependencies changed';
    else if (dependencyKeys.length > 0) reason = `package.json ${dependencyKeys.join(', ')} changed`;
    else {
      const trigger = changed.find((file) => isVitestConfig(file) || SUITE_TRIGGERS[suite].includes(file));
      if (trigger) reason = `${trigger} changed`;
    }
    if (reason) {
      plan[suite] = { mode: 'full', reason, files: [] };
      continue;
    }
    // package.json and the lockfile are dropped here: their dependency content was already
    // compared above, and anything else in them (version, scripts, files) cannot change what
    // a test imports — but vitest would rerun everything for any package.json edit.
    const related = changed
      .filter((file) => !['package.json', 'package-lock.json'].includes(basename(file)))
      .filter(isModuleCandidate);
    if (related.length === 0) {
      plan[suite] = { mode: 'smoke', reason: `no importable change; ${smoke[suite].length} smoke`, files: [...smoke[suite]].sort() };
      continue;
    }
    const files = [...new Set([...related, ...smoke[suite]])].sort();
    plan[suite] = { mode: 'related', reason: `${related.length} changed file(s) + ${smoke[suite].length} smoke`, files };
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Result evaluation (pure)
// ---------------------------------------------------------------------------

function toRepoPath(file) {
  const rel = isAbsolute(file) ? relative(repoRoot, file) : file;
  return rel.split(sep).join('/');
}

/**
 * Pure: turn a vitest run into a gate status.
 * @param {{ exitCode: number | null, report: any, log: string, known: Set<string> }} input
 * @returns {{ status: 'pass' | 'known' | 'fail', failedFiles: string[], knownFiles: string[],
 *   tests: { passed: number, failed: number, total: number, files: number } | null, note: string | null }}
 */
export function evaluateVitest({ exitCode, report, log, known }) {
  const unhandled = /Unhandled (?:Errors?|Rejection)/.test(log);
  if (!report || !Array.isArray(report.testResults)) {
    return {
      status: exitCode === 0 && !unhandled ? 'pass' : 'fail',
      failedFiles: [], knownFiles: [], tests: null,
      note: 'no vitest JSON report was written',
    };
  }
  const failed = report.testResults
    .filter((result) => result.status === 'failed')
    .map((result) => toRepoPath(result.name))
    .sort();
  const knownFiles = failed.filter((file) => known.has(file));
  const failedFiles = failed.filter((file) => !known.has(file));
  const tests = {
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    total: report.numTotalTests ?? 0,
    // numTotalTestSuites counts describe blocks, not files.
    files: report.testResults.length,
  };
  let note = null;
  let status = 'pass';
  if (failedFiles.length > 0) status = 'fail';
  else if (unhandled) {
    status = 'fail';
    note = 'vitest reported unhandled errors';
  } else if (exitCode !== 0 && failed.length === 0) {
    status = 'fail';
    note = `vitest exited ${exitCode} without a failing test file`;
  } else if (knownFiles.length > 0) status = 'known';
  return { status, failedFiles, knownFiles, tests, note };
}

export function formatDuration(ms) {
  const seconds = ms / 1000;
  if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}

export function renderTable(steps) {
  const rows = steps.map((step) => [
    step.name,
    step.status.toUpperCase(),
    step.durationMs == null ? '-' : formatDuration(step.durationMs),
    step.detail ?? '',
  ]);
  const header = ['step', 'status', 'duration', 'detail'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

function git(args) {
  const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${(res.stderr || '').trim() || `exit ${res.status}`}`);
  return res.stdout;
}

function lines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function resolveChanges(baseRef) {
  let mergeBase;
  try {
    mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
  } catch {
    throw new Error(`cannot find a merge-base with ${baseRef}. Fetch it (git fetch origin master) or pass --base <ref>.`);
  }
  // `git diff <commit>` compares against the working tree: committed + staged + unstaged.
  const changed = new Set([
    ...lines(git(['diff', '--name-only', mergeBase])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ]);
  const texts = (file) => {
    let baseText = null;
    try { baseText = git(['show', `${mergeBase}:${file}`]); } catch { /* new file */ }
    let currentText = null;
    try { currentText = readFileSync(join(repoRoot, file), 'utf8'); } catch { /* deleted */ }
    return [baseText, currentText];
  };
  const dependencyKeys = changed.has('package.json') ? packageDependencyChanges(...texts('package.json')) : [];
  const lockfileChanged = changed.has('package-lock.json') && lockfileDependencyChanged(...texts('package-lock.json'));
  return { mergeBase, changed: [...changed].sort(), dependencyKeys, lockfileChanged };
}

function loadJson(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
}

export function loadSmoke(data = loadJson('scripts/gate-smoke.json')) {
  return { backend: data.backend.map((entry) => entry.file), web: data.web.map((entry) => entry.file) };
}

export function loadKnownFailures(data = loadJson('scripts/gate-known-failures.json')) {
  return new Map(data.files.map((entry) => [entry.file, entry.reason]));
}

/** Run one command, streaming stdout+stderr into .ashlr-gate/<name>.log. */
function runCommand(name, cmd, args, env = {}) {
  const logPath = join(repoRoot, GATE_DIR, `${name}.log`);
  const log = createWriteStream(logPath);
  log.write(`$ ${[cmd, ...args].join(' ')}\n\n`);
  const started = performance.now();
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let spawnError = null;
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code, signal) => {
      if (spawnError) log.write(`\n[gate] could not start: ${spawnError.message}\n`);
      if (signal) log.write(`\n[gate] killed by ${signal}\n`);
      log.end(() => resolvePromise({
        exitCode: spawnError ? null : code,
        durationMs: performance.now() - started,
        logPath,
      }));
    });
  });
}

function tail(path, count) {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-count).join('\n');
  } catch {
    return '';
  }
}

const node = process.execPath;
const bin = {
  tsc: join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  eslint: join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  vitest: join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Phase A: independent static checks, run in parallel. */
function staticSteps() {
  const gate = (file) => join(GATE_DIR, file);
  // A tsbuildinfo whose outputs are gone would skip re-emitting them; start clean then.
  if (!existsSync(join(repoRoot, 'dist'))) rmSync(join(repoRoot, gate('tsc.tsbuildinfo')), { force: true });
  return [
    { name: 'build', cmd: node, args: [bin.tsc, '-p', 'tsconfig.json', '--incremental', '--tsBuildInfoFile', gate('tsc.tsbuildinfo')] },
    { name: 'typecheck-web', cmd: node, args: [bin.tsc, '--noEmit', '-p', 'src/web-ui/tsconfig.json', '--incremental', '--tsBuildInfoFile', gate('tsc-web.tsbuildinfo')] },
    { name: 'eslint', cmd: node, args: [bin.eslint, '--cache', '--cache-location', gate('eslintcache'), '.'] },
    { name: 'realio-lane', cmd: npm, args: ['run', '--silent', 'lint:realio-lane'] },
    { name: 'docs', cmd: npm, args: ['run', '--silent', 'check:docs'] },
  ];
}

async function runStatic(step) {
  const result = await runCommand(step.name, step.cmd, step.args);
  return {
    name: step.name,
    status: result.exitCode === 0 ? 'pass' : 'fail',
    durationMs: result.durationMs,
    detail: result.exitCode === 0 ? null : `exit ${result.exitCode ?? 'spawn error'} — ${relative(repoRoot, result.logPath)}`,
    logPath: result.logPath,
  };
}

async function runSuite(suite, plan, known, workers) {
  const name = `tests-${suite}`;
  const reportRel = join(GATE_DIR, `${name}.json`);
  const reportPath = join(repoRoot, reportRel);
  rmSync(reportPath, { force: true });
  const args = [bin.vitest];
  if (plan.mode === 'related') args.push('related', ...plan.files);
  else args.push('run', ...plan.files); // smoke: explicit files; full: no files
  args.push('--run', '--passWithNoTests', '--reporter=default', '--reporter=json', `--outputFile.json=${reportRel}`);
  if (suite === 'web') args.push('--config', 'vitest.config.web.ts', `--maxWorkers=${workers}`);
  // Hermetic HOME, as scripts/test-ci.mjs does: nothing a test writes reaches the real ~.
  const home = mkdtempSync(join(tmpdir(), `ashlr-gate-${suite}-home-`));
  let result;
  try {
    result = await runCommand(name, node, args, { HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr') });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  let report = null;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* evaluated as missing */ }
  const verdict = evaluateVitest({ exitCode: result.exitCode, report, log: readFileSync(result.logPath, 'utf8'), known });
  const counts = verdict.tests ? `${verdict.tests.files} files, ${verdict.tests.passed}/${verdict.tests.total} tests` : '';
  // File lists are printed under the table, not in it.
  const detail = [
    `${plan.mode} (${plan.reason})`,
    counts,
    verdict.failedFiles.length ? `${verdict.failedFiles.length} failed file(s)` : '',
    verdict.knownFiles.length ? `${verdict.knownFiles.length} known` : '',
    verdict.note ?? '',
  ].filter(Boolean).join('; ');
  return { name, status: verdict.status, durationMs: result.durationMs, detail, logPath: result.logPath, verdict, plan };
}

function skipped(name, why) {
  return { name, status: 'skipped', durationMs: null, detail: why };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`gate: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const say = args.json ? () => {} : (text) => process.stderr.write(`${text}\n`);
  const started = performance.now();
  mkdirSync(join(repoRoot, GATE_DIR), { recursive: true });

  let smoke;
  let known;
  let changes = { mergeBase: null, changed: [], dependencyKeys: [], lockfileChanged: false };
  const baseRef = args.base ?? DEFAULT_BASE_REF;
  try {
    smoke = loadSmoke();
    known = loadKnownFailures();
    if (!args.full) changes = resolveChanges(baseRef);
  } catch (err) {
    console.error(`gate: ${err.message}`);
    return 2;
  }
  const plan = planTests({ ...changes, full: args.full, smoke });
  say(args.full
    ? 'gate:full — every backend and web test'
    : `gate — base ${baseRef} @ ${changes.mergeBase.slice(0, 10)}, ${changes.changed.length} changed file(s); backend ${plan.backend.mode}, web ${plan.web.mode}`);

  const steps = [];
  const record = (step) => {
    steps.push(step);
    say(`  ${step.status === 'pass' ? '✓' : step.status === 'known' ? '~' : step.status === 'skipped' ? '-' : '✗'} ${step.name} ${step.durationMs == null ? '' : formatDuration(step.durationMs)}`);
    return step;
  };

  say('phase A: build, typecheck-web, eslint, realio-lane, docs (parallel)');
  const phaseA = await Promise.all(staticSteps().map((step) => runStatic(step).then(record)));
  const buildFailed = phaseA.find((step) => step.name === 'build').status === 'fail';
  const phaseAFailed = phaseA.some((step) => step.status === 'fail');

  if (args.failFast && phaseAFailed) {
    record(skipped('first-paint', 'phase A failed (--fail-fast)'));
  } else {
    say('first-paint: web build + budget');
    const scratch = join(GATE_DIR, 'web-dist');
    record(await runStatic({ name: 'first-paint', cmd: npm, args: ['run', '--silent', 'check:first-paint', '--', '--out-dir', scratch] }));
  }

  const failedSoFar = steps.some((step) => step.status === 'fail');
  if (buildFailed || (args.failFast && failedSoFar)) {
    const why = buildFailed ? 'build failed (tests import dist/)' : 'an earlier phase failed (--fail-fast)';
    record(skipped('tests-backend', why));
    record(skipped('tests-web', why));
  } else {
    // Backend projects carry their own worker caps (unit 4, real-io 2; vitest.config.ts).
    // Web gets roughly a third of the machine alongside them.
    const webWorkers = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 3)));
    say(`phase B: backend + web tests (parallel; web maxWorkers=${webWorkers})`);
    await Promise.all([
      runSuite('backend', plan.backend, known, null).then(record),
      runSuite('web', plan.web, known, webWorkers).then(record),
    ]);
  }

  const durationMs = performance.now() - started;
  // A skipped step never passes: it was skipped because something before it failed.
  const ok = steps.every((step) => step.status === 'pass' || step.status === 'known');
  const knownHits = steps.flatMap((step) => step.verdict?.knownFiles ?? []);

  if (args.json) {
    console.log(JSON.stringify({
      ok,
      mode: args.full ? 'full' : 'related',
      base: args.full ? null : { ref: baseRef, mergeBase: changes.mergeBase, changedFiles: changes.changed },
      durationMs: Math.round(durationMs),
      steps: steps.map((step) => ({
        name: step.name,
        status: step.status,
        durationMs: step.durationMs == null ? null : Math.round(step.durationMs),
        detail: step.detail ?? null,
        log: step.logPath ? relative(repoRoot, step.logPath) : null,
        ...(step.verdict ? {
          mode: step.plan.mode,
          reason: step.plan.reason,
          tests: step.verdict.tests,
          failedFiles: step.verdict.failedFiles,
          knownFailures: step.verdict.knownFiles.map((file) => ({ file, reason: known.get(file) })),
        } : {}),
      })),
    }, null, 2));
  } else {
    console.log('');
    console.log(renderTable(steps));
    for (const file of knownHits) console.log(`known failure: ${file} — ${known.get(file)}`);
    for (const step of steps.filter((s) => s.status === 'fail')) {
      if (step.verdict?.failedFiles.length) {
        console.log(`\n── ${step.name}: failing test files (${relative(repoRoot, step.logPath)})`);
        for (const file of step.verdict.failedFiles) console.log(`  ${file}`);
      } else {
        console.log(`\n── ${step.name} (${relative(repoRoot, step.logPath)}), last lines:`);
        console.log(tail(step.logPath, 25));
      }
    }
    console.log(`\nGATE ${ok ? 'PASS' : 'FAIL'} in ${formatDuration(durationMs)} — logs in ${GATE_DIR}/`);
  }
  return ok ? 0 : 1;
}

// Import-safe: tests import the pure helpers without running the gate.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

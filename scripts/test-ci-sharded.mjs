#!/usr/bin/env node
/** Run an exhaustive four-way local partition with two bounded workers.
 * Explicit selectors reuse the same general and isolated membership in CI.
 * Each test-ci wrapper owns a private HOME and its Vitest process tree. Keep
 * at most two shards active, each with one worker, so real-I/O fixtures do not
 * contend with two other local shards for their bounded startup windows.
 */
import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const runner = fileURLToPath(new URL('./test-ci.mjs', import.meta.url));
const shards = [1, 2, 3, 4];
const args = process.argv.slice(2);
const generalSelector = args.length === 1 ? /^--general-shard=([1-4])\/4$/.exec(args[0]) : null;
const isolatedOnly = args.length === 1 && args[0] === '--isolated-only';
if (args.length > 0 && !generalSelector && !isolatedOnly) {
  console.error('Usage: test-ci-sharded.mjs [--general-shard=N/4 | --isolated-only] (N=1..4)');
  process.exit(2);
}
const selectedShard = generalSelector ? Number(generalSelector[1]) : null;
const reportInput = process.env.ASHLR_TEST_CI_REPORT_DIRECTORY;
let reportDirectory = null;
if (reportInput !== undefined) {
  try {
    if (!isAbsolute(reportInput) || realpathSync(reportInput) !== reportInput || typeof process.getuid !== 'function') {
      throw new Error('invalid report directory');
    }
    const before = lstatSync(reportInput);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid() ||
      (before.mode & 0o7777) !== 0o700 || readdirSync(reportInput).length !== 0) {
      throw new Error('invalid report directory');
    }
    const after = lstatSync(reportInput);
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino ||
      before.uid !== after.uid || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || realpathSync(reportInput) !== reportInput) {
      throw new Error('changed report directory');
    }
    reportDirectory = reportInput;
  } catch {
    console.error('Report directory must be empty, canonical, owned, and private (0700) on POSIX.');
    process.exit(2);
  }
}
function reportArgs(name) {
  return reportDirectory === null ? [] : [
    '--reporter=default', '--reporter=json', `--outputFile.json=${join(reportDirectory, name)}`,
  ];
}
// Vitest 4 inline project caps override the root --maxWorkers value. Its
// forwarded fileParallelism override forces each project's workers to one,
// preserving this local runner's intended concurrency in both test lanes.
// These suites exercise real Git, sandbox, ledger, and foreground CLI work with
// bounded deadlines. Running them beside two other real-I/O shards can consume
// those deadlines without testing the behavior the cases are meant to prove.
const isolatedSuites = [
  'test/m342.dispatch-production-ledger.test.ts',
  // Preserve all 200 real journal commits and their deadline without a competing
  // local shard consuming the same filesystem/ACL process capacity.
  'test/m395.effect-terminal-retention.test.ts',
  'test/m446.external-skill-git-capture.test.ts',
  'test/resource-engineering-setup-acceptance.test.ts',
  'test/resource-engineering-supervisor-acceptance.test.ts',
  // Keep all admission/replay/expiry cases and their real Git/delivery work in
  // one isolated local home, preserving every existing bounded deadline.
  'test/resource-engineering-supervisor-admission-acceptance.test.ts',
  // Preserve bounded HTTP admission checks without a competing local shard's
  // Git and private-store filesystem work consuming the request deadlines.
  'test/resource-console-engineering-acceptance.test.ts',
  'test/universe-firm-engineering-control.test.ts',
  // The same real evaluator/Git/delivery recovery path has bounded allowances;
  // preserve all cases without a competing local real-I/O shard.
  'test/universe-engineering-handoff-recovery.test.ts',
  // A concurrent local full run failed a bounded campaign trial; the isolated
  // whole file passed. Retain all 17 cases and deadlines in one fresh home.
  'test/universe-campaign-integration.test.ts',
  // Preserve all successor quota, delivery, accounting and restart cases with
  // their original finite budgets in one fresh home after competing shards.
  'test/resource-engineering-successor-acceptance.test.ts',
  // A concurrent full run withheld delivery; the standalone whole file passed.
  // Retain all 12 supervision cases and deadlines without competing workers.
  'test/universe-supervision-integration.test.ts',
];
const isolatedAcceptance = 'test/universe-hub-marker-campaign.test.ts';
const exclusions = [...isolatedSuites, isolatedAcceptance].map((file) => `--exclude=${file}`);
const isolatedCases = [
  ...isolatedSuites.map((file) => ({ file, label: file })),
  { file: isolatedAcceptance, filter: 'automatic seed measurement: false', label: 'campaign false' },
  { file: isolatedAcceptance, filter: 'automatic seed measurement: true', label: 'campaign true' },
];
// Existing real-I/O acceptance phases describe work within a long-running case;
// enable them without changing the wrapper's child-output idle deadline. Keep
// explicit caller choices, including empty values, and leave the parent alone.
// Acceptance elapsed summaries are buffered until fixture cleanup settles.
const childEnvironment = {
  ...process.env,
  ASHLR_ENGINEERING_SETUP_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SETUP_PHASE_TIMING ?? '1',
  ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING ?? '1',
  ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING: process.env.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING ?? '1',
  ASHLR_ACCEPTANCE_PHASE_TIMING: process.env.ASHLR_ACCEPTANCE_PHASE_TIMING ?? '1',
};
const children = new Map();
let stopping = false;
let failure = 0;

function stopOthers(except) {
  if (stopping) return;
  stopping = true;
  for (const [shard, child] of children) {
    if (shard !== except && child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    failure ||= signal === 'SIGINT' ? 130 : 143;
    stopOthers();
  });
}

function runShard(shard) { return new Promise((resolve) => {
  const child = spawn(process.execPath, [runner, `--shard=${shard}/${shards.length}`, '--maxWorkers=1', '--fileParallelism=false', '--bail=1', ...exclusions,
    ...reportArgs(`general-${shard}-of-4.json`)], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: 'inherit',
  });
  children.set(shard, child);
  console.error(`[test-ci:sharded] started ${shard}/${shards.length} (pid ${child.pid ?? 'unavailable'})`);
  let settled = false;
  const finish = (code, detail) => {
    if (settled) return;
    settled = true;
    console.error(`[test-ci:sharded] ${shard}/${shards.length} ${detail}`);
    if (code !== 0 && !failure) {
      failure = code;
      stopOthers(shard);
    }
    resolve(code);
  };
  child.once('error', (error) => finish(1, `failed to start: ${error.message}`));
  child.once('exit', (code, signal) => finish(code ?? 1, signal ? `exited via ${signal}` : `exited ${code}`));
}); }

// Four smaller deterministic partitions aim to reduce the indivisible final tail.
// Keep exactly two single-worker wrappers active; every general file still runs
// once and all isolated suites retain their separate serial homes.
const expectedShards = isolatedOnly ? [] : selectedShard === null ? shards : [selectedShard];
const pending = [...expectedShards].reverse();
const codes = [];
async function runQueue() {
  while (pending.length && !failure) {
    const shard = pending.shift();
    codes[shard - 1] = await runShard(shard);
  }
}
await Promise.all([runQueue(), runQueue()]);
if (failure || !expectedShards.every((shard) => codes[shard - 1] === 0)) {
  process.exitCode = failure || 1;
  console.error(`[test-ci:sharded] FAIL (${codes.join(', ')})`);
} else if (selectedShard !== null) {
  console.error(`[test-ci:sharded] PASS (general ${selectedShard}/${shards.length})`);
} else {
  // Run slow real-I/O suites after the shards with no competing test workers.
  // Each gets a fresh home. The campaign's two cases also get separate homes
  // so one case's process state cannot exhaust the next delivery.
  const isolatedCodes = [];
  for (const [index, { file, filter, label }] of isolatedCases.entries()) {
    if (failure) break;
    const child = spawn(process.execPath, [runner, file, ...(filter ? ['-t', filter] : []), '--maxWorkers=1', '--fileParallelism=false', '--bail=1',
      ...reportArgs(`isolated-${String(index + 1).padStart(2, '0')}.json`)], {
      cwd: process.cwd(), env: childEnvironment, stdio: 'inherit',
    });
    children.set(`isolated-${label}`, child);
    console.error(`[test-ci:sharded] started isolated acceptance ${label} (pid ${child.pid ?? 'unavailable'})`);
    const isolatedCode = await new Promise((resolve) => {
      child.once('error', (error) => {
        console.error(`[test-ci:sharded] isolated ${label} failed to start: ${error.message}`);
        resolve(1);
      });
      child.once('exit', (code, signal) => {
        console.error(`[test-ci:sharded] isolated ${label} ${signal ? `exited via ${signal}` : `exited ${code}`}`);
        resolve(code ?? 1);
      });
    });
    isolatedCodes.push(isolatedCode);
    if (isolatedCode !== 0) failure = isolatedCode;
  }
  process.exitCode = failure || (isolatedCodes.length === isolatedCases.length ? 0 : 1);
  const prefix = isolatedOnly ? '' : `${codes.join(', ')}, `;
  console.error(`[test-ci:sharded] ${process.exitCode === 0 ? 'PASS' : 'FAIL'} (${prefix}isolated ${isolatedCodes.join(', ')})`);
}

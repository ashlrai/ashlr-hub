#!/usr/bin/env node
/** Run the same exhaustive three-way partition as hosted CI on one Mac.
 * Each test-ci wrapper owns a private HOME and its Vitest process tree. Keep
 * at most two shards active, each with one worker, so real-I/O fixtures do not
 * contend with two other local shards for their bounded startup windows.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const runner = fileURLToPath(new URL('./test-ci.mjs', import.meta.url));
const shards = [1, 2, 3];
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
  // Preserve bounded HTTP admission checks without a competing local shard's
  // Git and private-store filesystem work consuming the request deadlines.
  'test/resource-console-engineering-acceptance.test.ts',
  'test/universe-firm-engineering-control.test.ts',
  // The same real evaluator/Git/delivery recovery path has bounded allowances;
  // preserve all cases without a competing local real-I/O shard.
  'test/universe-engineering-handoff-recovery.test.ts',
];
const isolatedAcceptance = 'test/universe-hub-marker-campaign.test.ts';
const exclusions = [...isolatedSuites, isolatedAcceptance].map((file) => `--exclude=${file}`);
// Existing real-I/O acceptance phases describe work within a long-running case;
// enable them without changing the wrapper's child-output idle deadline. Keep
// explicit caller choices, including empty values, and leave the parent alone.
const childEnvironment = {
  ...process.env,
  ASHLR_ENGINEERING_SETUP_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SETUP_PHASE_TIMING ?? '1',
  ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING: process.env.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING ?? '1',
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
  const child = spawn(process.execPath, [runner, `--shard=${shard}/3`, '--maxWorkers=1', '--fileParallelism=false', '--bail=1', ...exclusions], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: 'inherit',
  });
  children.set(shard, child);
  console.error(`[test-ci:sharded] started ${shard}/3 (pid ${child.pid ?? 'unavailable'})`);
  let settled = false;
  const finish = (code, detail) => {
    if (settled) return;
    settled = true;
    console.error(`[test-ci:sharded] ${shard}/3 ${detail}`);
    if (code !== 0 && !failure) {
      failure = code;
      stopOthers(shard);
    }
    resolve(code);
  };
  child.once('error', (error) => finish(1, `failed to start: ${error.message}`));
  child.once('exit', (code, signal) => finish(code ?? 1, signal ? `exited via ${signal}` : `exited ${code}`));
}); }

// The completed 3.23 release measured shard 3 at 2422s, 2 at 2142s and
// 1 at 1828s. Start the longest partitions first to reduce the serial tail
// while retaining the same exact membership and two single-worker homes.
const pending = [...shards].reverse();
const codes = [];
async function runQueue() {
  while (pending.length && !failure) {
    const shard = pending.shift();
    codes[shard - 1] = await runShard(shard);
  }
}
await Promise.all([runQueue(), runQueue()]);
if (failure || codes.length !== shards.length || !codes.every((code) => code === 0)) {
  process.exitCode = failure || 1;
  console.error(`[test-ci:sharded] FAIL (${codes.join(', ')})`);
} else {
  // Run slow real-I/O suites after the shards with no competing test workers.
  // Each gets a fresh home. The campaign's two cases also get separate homes
  // so one case's process state cannot exhaust the next delivery.
  const isolatedCases = [
    ...isolatedSuites.map((file) => ({ file, label: file })),
    { file: isolatedAcceptance, filter: 'automatic seed measurement: false', label: 'campaign false' },
    { file: isolatedAcceptance, filter: 'automatic seed measurement: true', label: 'campaign true' },
  ];
  const isolatedCodes = [];
  for (const { file, filter, label } of isolatedCases) {
    if (failure) break;
    const child = spawn(process.execPath, [runner, file, ...(filter ? ['-t', filter] : []), '--maxWorkers=1', '--fileParallelism=false', '--bail=1'], {
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
  console.error(`[test-ci:sharded] ${process.exitCode === 0 ? 'PASS' : 'FAIL'} (${codes.join(', ')}, isolated ${isolatedCodes.join(', ')})`);
}

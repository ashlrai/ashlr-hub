#!/usr/bin/env node
/** Run the same exhaustive three-way partition as hosted CI on one Mac.
 * Each test-ci wrapper owns a private HOME and its Vitest process tree. Keep
 * one worker per shard so concurrent real-I/O fixtures do not flood the host.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const runner = fileURLToPath(new URL('./test-ci.mjs', import.meta.url));
const shards = [1, 2, 3];
const isolatedAcceptance = 'test/universe-hub-marker-campaign.test.ts';
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

const results = shards.map((shard) => new Promise((resolve) => {
  const child = spawn(process.execPath, [runner, `--shard=${shard}/3`, '--maxWorkers=1', '--bail=1', `--exclude=${isolatedAcceptance}`], {
    cwd: process.cwd(),
    env: process.env,
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
}));

const codes = await Promise.all(results);
if (failure || !codes.every((code) => code === 0)) {
  process.exitCode = failure || 1;
  console.error(`[test-ci:sharded] FAIL (${codes.join(', ')})`);
} else {
  // This real-I/O campaign performs a full deterministic three-generation
  // delivery. Run its two cases after the shards in separate process homes so
  // host load and one case's process state cannot exhaust the next delivery.
  const isolatedCodes = [];
  for (const measureSeed of ['false', 'true']) {
    if (failure) break;
    const child = spawn(process.execPath, [runner, isolatedAcceptance, '-t', `automatic seed measurement: ${measureSeed}`, '--maxWorkers=1', '--bail=1'], {
      cwd: process.cwd(), env: process.env, stdio: 'inherit',
    });
    children.set(`isolated-${measureSeed}`, child);
    console.error(`[test-ci:sharded] started isolated acceptance ${measureSeed} (pid ${child.pid ?? 'unavailable'})`);
    const isolatedCode = await new Promise((resolve) => {
      child.once('error', (error) => {
        console.error(`[test-ci:sharded] isolated ${measureSeed} failed to start: ${error.message}`);
        resolve(1);
      });
      child.once('exit', (code, signal) => {
        console.error(`[test-ci:sharded] isolated ${measureSeed} ${signal ? `exited via ${signal}` : `exited ${code}`}`);
        resolve(code ?? 1);
      });
    });
    isolatedCodes.push(isolatedCode);
    if (isolatedCode !== 0) failure = isolatedCode;
  }
  process.exitCode = failure || (isolatedCodes.length === 2 ? 0 : 1);
  console.error(`[test-ci:sharded] ${process.exitCode === 0 ? 'PASS' : 'FAIL'} (${codes.join(', ')}, isolated ${isolatedCodes.join(', ')})`);
}

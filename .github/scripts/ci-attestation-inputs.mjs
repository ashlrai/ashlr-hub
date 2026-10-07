/* global process, console */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireProducerEnvironment, requireRepositoryMetadata, requireRepositoryReference } from './github-repository-binding.mjs';
const roles = ['mac-general-1', 'mac-general-2', 'mac-general-3', 'mac-general-4', 'mac-isolated'];
const hash = /^[a-f0-9]{40}$/;
const integer = (value) => { assert.match(value ?? '', /^[1-9][0-9]*$/); const n = Number(value); assert.ok(Number.isSafeInteger(n)); return n; };
const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();

export function artifactNames(run, attempt) {
  return { producer: `ashlr-build-${run}-${attempt}`, lanes: roles.map((role) => ({ role, name: `ashlr-qualification-${role}-${run}-${attempt}` })) };
}

export function copyDataTree(source, destination, budget = { files: 0, bytes: 0, directories: 0 }, depth = 0) {
  assert.ok(depth <= 48 && ++budget.directories <= 1024, 'artifact directory bound exceeded');
  const directory = lstatSync(source);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), 'unsafe artifact directory');
  mkdirSync(destination, { mode: 0o700 });
  for (const name of readdirSync(source).sort()) {
    assert.ok(name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'));
    const from = join(source, name); const to = join(destination, name); const before = lstatSync(from);
    assert.ok(!before.isSymbolicLink(), 'artifact link refused');
    if (before.isDirectory()) copyDataTree(from, to, budget, depth + 1);
    else {
      assert.ok(before.isFile() && before.nlink === 1 && !(before.mode & 0o7000), 'artifact special file refused');
      budget.files++; budget.bytes += before.size;
      assert.ok(budget.files <= 1024 && budget.bytes <= 512 * 1024 * 1024, 'artifact data bound exceeded');
      copyFileSync(from, to, 1); chmodSync(to, 0o600);
      const after = lstatSync(from);
      assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'artifact changed during assembly');
    }
  }
}

export function prepare({ env = process.env, read = api } = {}) {
  const { repository } = requireProducerEnvironment(env);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch'); assert.equal(env.GITHUB_REF, 'refs/heads/master');
  assert.match(env.CANDIDATE_SHA ?? '', hash); assert.match(env.GITHUB_SHA ?? '', hash);
  const run = integer(env.CI_RUN_ID); const attempt = integer(env.CI_RUN_ATTEMPT); const artifactId = integer(env.BUILD_ARTIFACT_ID);
  assert.equal(git('rev-parse', 'HEAD'), env.GITHUB_SHA); assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '');
  const base = `repos/${repository}`;
  requireRepositoryMetadata(repository, read(base));
  const trusted = read(`${base}/git/commits/${env.GITHUB_SHA}`); const candidate = read(`${base}/git/commits/${env.CANDIDATE_SHA}`);
  assert.equal(trusted.sha, env.GITHUB_SHA); assert.equal(candidate.sha, env.CANDIDATE_SHA); assert.equal(trusted.tree.sha, candidate.tree.sha, 'trusted master tree differs from candidate');
  const ci = read(`${base}/actions/runs/${run}/attempts/${attempt}`);
  assert.equal(ci.id, run); assert.equal(ci.run_attempt, attempt); assert.equal(ci.head_sha, env.CANDIDATE_SHA);
  requireRepositoryReference(repository, ci.repository);
  assert.equal(ci.path, '.github/workflows/ci.yml'); assert.equal(ci.status, 'completed'); assert.equal(ci.conclusion, 'success');
  const names = artifactNames(run, attempt); const artifacts = []; let page = 1; let total = null;
  for (;;) {
    const result = read(`${base}/actions/runs/${run}/artifacts?per_page=100&page=${page++}`); assert.ok(Array.isArray(result.artifacts));
    assert.ok(Number.isSafeInteger(result.total_count) && result.total_count >= 0 && result.total_count <= 1000, 'invalid artifact enumeration');
    if (total === null) total = result.total_count; else assert.equal(result.total_count, total, 'artifact inventory changed');
    artifacts.push(...result.artifacts);
    assert.ok(page <= 11, 'artifact enumeration too large'); if (result.artifacts.length < 100) break;
  }
  assert.equal(artifacts.length, total, 'incomplete artifact enumeration');
  const select = (name) => {
    const matches = artifacts.filter((item) => item.name === name); assert.equal(matches.length, 1, 'missing or ambiguous artifact');
    const item = matches[0]; assert.ok(Number.isSafeInteger(item.id) && item.id > 0, 'invalid artifact ID');
    assert.equal(item.expired, false); assert.match(item.digest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.equal(item.workflow_run?.id, run); assert.equal(item.workflow_run?.head_sha, env.CANDIDATE_SHA);
    return { id: item.id, name, digest: item.digest };
  };
  const map = { producer: select(names.producer), lanes: names.lanes.map(({ role, name }) => ({ role, ...select(name) })) };
  assert.equal(map.producer.id, artifactId);
  const parent = realpathSync(env.RUNNER_TEMP); const directory = realpathSync(mkdtempSync(join(parent, 'ashlr-attestation-'))); chmodSync(directory, 0o700);
  mkdirSync(join(directory, 'download'), { mode: 0o700 });
  writeFileSync(join(directory, 'artifact-map.json'), `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  // Fetch source as inert data. All policy code continues to execute from the
  // trusted master checkout, never from this candidate worktree or artifacts.
  git('fetch', '--no-tags', 'origin', env.CANDIDATE_SHA);
  git('worktree', 'add', '--detach', join(directory, 'candidate'), env.CANDIDATE_SHA);
  assert.equal(git('-C', join(directory, 'candidate'), 'rev-parse', 'HEAD^{tree}'), trusted.tree.sha);
  return { directory, map };
}

export function assemble(directory) {
  const mapPath = join(directory, 'artifact-map.json'); const info = lstatSync(mapPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 1024 * 1024);
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.match(map.producer.name, /^ashlr-build-[1-9][0-9]*-[1-9][0-9]*$/);
  assert.deepEqual(map.lanes.map((row) => row.role).sort(), [...roles].sort());
  const bundle = join(directory, 'bundle'); copyDataTree(join(directory, 'download', map.producer.name), bundle);
  const coverage = join(bundle, 'coverage'); const current = lstatSync(coverage); assert.ok(current.isDirectory() && !current.isSymbolicLink());
  for (const { role, name } of map.lanes) {
    assert.ok(roles.includes(role) && /^ashlr-qualification-[a-z0-9-]+$/.test(name));
    copyDataTree(join(directory, 'download', name), join(coverage, role));
  }
  return bundle;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare' && process.argv.length === 3) {
      const { directory, map } = prepare();
      assert.ok(process.env.GITHUB_OUTPUT);
      appendFileSync(process.env.GITHUB_OUTPUT, `directory=${directory}\nartifact_ids=${[map.producer, ...map.lanes].map((item) => item.id).join(',')}\n`);
    } else if (process.argv[2] === 'assemble' && process.argv.length === 4) console.log(assemble(realpathSync(process.argv[3])));
    else throw new Error('Usage: ci-attestation-inputs.mjs prepare|assemble DIRECTORY');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

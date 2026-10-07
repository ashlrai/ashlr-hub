/* global process */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HUB_REPOSITORY_IDENTITY as hub } from '../scripts/github-repository-binding.mjs';
import { artifactNames, assemble, copyDataTree, prepare } from '../scripts/ci-attestation-inputs.mjs';

// Only disposable local Git repositories and injected official-shaped API data.
// No remote service, token, artifact download, package lifecycle, or signer runs.
function fixture(repositoryName = hub.legacyName) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-attestation-input-test-')));
  const root = join(home, 'repo'); const temporary = join(home, 'runner');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--initial-branch=master');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'seed.txt'), 'inert fixture\n'); git('add', 'seed.txt'); git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD'); git('commit', '-qm', 'trusted', '--allow-empty');
  const trusted = git('rev-parse', 'HEAD'); const tree = git('rev-parse', 'HEAD^{tree}');
  git('remote', 'add', 'origin', root); // Fetch can only read this private fixture.
  const names = artifactNames(101, 2);
  const artifacts = [names.producer, ...names.lanes.map(row => row.name)].map((name, index) => ({
    id: 301 + index, name, expired: false, digest: `sha256:${'a'.repeat(64)}`,
    workflow_run: { id: 101, head_sha: candidate },
  }));
  const repository = { full_name: repositoryName, id: hub.repositoryId, node_id: hub.repositoryNodeId, owner: { id: hub.ownerId, login: hub.ownerLogin }, default_branch: hub.defaultBranch, private: false, visibility: 'public' };
  const answers = new Map([
    [`repos/${repositoryName}`, repository],
    [`repos/${repositoryName}/git/commits/${trusted}`, { sha: trusted, tree: { sha: tree } }],
    [`repos/${repositoryName}/git/commits/${candidate}`, { sha: candidate, tree: { sha: tree } }],
    [`repos/${repositoryName}/actions/runs/101/attempts/2`, {
      id: 101, run_attempt: 2, head_sha: candidate, path: '.github/workflows/ci.yml',
      repository: { ...repository }, status: 'completed', conclusion: 'success',
    }],
    [`repos/${repositoryName}/actions/runs/101/artifacts?per_page=100&page=1`, { total_count: artifacts.length, artifacts }],
  ]);
  const inputs = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master', GITHUB_REPOSITORY: repositoryName, GITHUB_REPOSITORY_ID: String(hub.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(hub.ownerId),
    GITHUB_SHA: trusted, CANDIDATE_SHA: candidate, CI_RUN_ID: '101', CI_RUN_ATTEMPT: '2', BUILD_ARTIFACT_ID: '301', RUNNER_TEMP: temporary };
  const read = path => { assert.ok(answers.has(path), `unexpected API lookup: ${path}`); return globalThis.structuredClone(answers.get(path)); };
  return { home, root, temporary, git, inputs, answers, artifacts, read, candidate, trusted, tree };
}
function withFixture(fn, repositoryName) {
  const f = fixture(repositoryName); const cwd = process.cwd();
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'];
  const original = keys.map(key => [key, process.env[key]]);
  try {
    process.chdir(f.root); process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_SYSTEM = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
    return fn(f);
  } finally {
    process.chdir(cwd); for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(f.home, { recursive: true, force: true });
  }
}
function runRecord(f) { return f.answers.get(`repos/${f.inputs.GITHUB_REPOSITORY}/actions/runs/101/attempts/2`); }
function listRecord(f) { return f.answers.get(`repos/${f.inputs.GITHUB_REPOSITORY}/actions/runs/101/artifacts?per_page=100&page=1`); }

// prepare() is POSIX-only in the trusted Ubuntu workflow; Windows portability
// remains in CI rather than simulating POSIX permissions with Windows modes.
test('prepares one exact immutable producer plus all five Mac lanes as inert inputs', { skip: process.platform === 'win32' }, () => withFixture(f => {
  const result = prepare({ env: f.inputs, read: f.read });
  assert.deepEqual(result.map.producer, { id: 301, name: 'ashlr-build-101-2', digest: `sha256:${'a'.repeat(64)}` });
  assert.equal(result.map.lanes.length, 5); assert.equal(new Set(result.map.lanes.map(row => row.id)).size, 5);
  assert.equal(lstatSync(result.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(result.directory, 'artifact-map.json')).mode & 0o777, 0o600);
  assert.equal(f.git('-C', join(result.directory, 'candidate'), 'rev-parse', 'HEAD'), f.candidate);
  assert.equal(readFileSync(join(result.directory, 'candidate', 'seed.txt'), 'utf8'), 'inert fixture\n');
  assert.equal(f.git('rev-parse', 'HEAD'), f.trusted); assert.equal(f.git('status', '--porcelain'), '');
}));

test('trusted preparation binds the renamed namespace to the same numeric repository without old alias reads', { skip: process.platform === 'win32' }, () => withFixture(f => {
  const calls = [];
  const result = prepare({ env: f.inputs, read: path => { calls.push(path); return f.read(path); } });
  assert.equal(result.map.producer.id, 301);
  assert.equal(f.git('-C', join(result.directory, 'candidate'), 'rev-parse', 'HEAD'), f.candidate);
  assert.ok(calls.length > 0 && calls.every(path => path.startsWith(`repos/${hub.renamedName}/`) || path === `repos/${hub.renamedName}`));
}, hub.renamedName));

for (const [key, value] of [
  ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_REF', 'refs/heads/feature'], ['GITHUB_REPOSITORY', 'foreign/repo'],
  ['CI_RUN_ID', '0'], ['CI_RUN_ATTEMPT', '02'], ['BUILD_ARTIFACT_ID', '9007199254740992'], ['CANDIDATE_SHA', 'not-a-sha'],
]) test(`refuses untrusted dispatch input ${key}`, { skip: process.platform === 'win32' }, () => withFixture(f => {
  assert.throws(() => prepare({ env: { ...f.inputs, [key]: value }, read: f.read }));
  assert.deepEqual(readdirSync(f.temporary), []);
}));

for (const [key, value] of [
  ['id', 102], ['run_attempt', 1], ['head_sha', 'b'.repeat(40)], ['path', '.github/workflows/other.yml'],
  ['repository', { full_name: 'foreign/repo' }], ['status', 'in_progress'], ['conclusion', 'failure'],
]) test(`refuses mismatched or unfinished official run ${key}`, { skip: process.platform === 'win32' }, () => withFixture(f => {
  runRecord(f)[key] = value; assert.throws(() => prepare({ env: f.inputs, read: f.read }));
  assert.deepEqual(readdirSync(f.temporary), []);
}));

test('refuses master/candidate tree mismatch and dirty or wrongly checked-out source', { skip: process.platform === 'win32' }, () => withFixture(f => {
  const candidate = f.answers.get(`repos/ashlrai/ashlr-hub/git/commits/${f.candidate}`);
  candidate.tree.sha = 'b'.repeat(40);
  assert.throws(() => prepare({ env: f.inputs, read: f.read }), /tree differs/);
  candidate.tree.sha = f.tree; writeFileSync(join(f.root, 'seed.txt'), 'dirty');
  assert.throws(() => prepare({ env: f.inputs, read: f.read }));
  f.git('checkout', '--', 'seed.txt');
  assert.throws(() => prepare({ env: { ...f.inputs, GITHUB_SHA: f.candidate }, read: f.read }));
  assert.deepEqual(readdirSync(f.temporary), []);
}));

for (const mutation of ['missing', 'duplicate', 'expired', 'digest', 'run', 'head', 'producer-id']) {
  test(`refuses unqualified official artifact ${mutation}`, { skip: process.platform === 'win32' }, () => withFixture(f => {
    const row = listRecord(f).artifacts[0];
    if (mutation === 'missing') listRecord(f).artifacts.shift();
    if (mutation === 'duplicate') listRecord(f).artifacts.push({ ...row, id: 999 });
    if (mutation === 'expired') row.expired = true;
    if (mutation === 'digest') row.digest = 'sha256:unqualified';
    if (mutation === 'run') row.workflow_run.id = 102;
    if (mutation === 'head') row.workflow_run.head_sha = f.trusted;
    if (mutation === 'producer-id') f.inputs.BUILD_ARTIFACT_ID = '999';
    listRecord(f).total_count = listRecord(f).artifacts.length;
    assert.throws(() => prepare({ env: f.inputs, read: f.read })); assert.deepEqual(readdirSync(f.temporary), []);
  }));
}

for (const id of [0, -1, 1.5, '302', Number.MAX_SAFE_INTEGER + 1]) {
  test(`refuses invalid official lane artifact ID ${id}`, { skip: process.platform === 'win32' }, () => withFixture(f => {
    listRecord(f).artifacts[1].id = id;
    assert.throws(() => prepare({ env: f.inputs, read: f.read }), /artifact ID/);
    assert.deepEqual(readdirSync(f.temporary), []);
  }));
}
test('refuses incomplete artifact enumeration even when every expected name appears', { skip: process.platform === 'win32' }, () => withFixture(f => {
  listRecord(f).total_count = f.artifacts.length + 1;
  assert.throws(() => prepare({ env: f.inputs, read: f.read }), /incomplete/);
  assert.deepEqual(readdirSync(f.temporary), []);
}));
test('reads all artifact pages and refuses a duplicated expected name in a later page', { skip: process.platform === 'win32' }, () => withFixture(f => {
  const list = listRecord(f); const producer = list.artifacts[0];
  list.artifacts.push(...Array.from({ length: 94 }, (_, i) => ({ id: 500 + i, name: `unrelated-${i}` })));
  list.total_count = 101;
  f.answers.set('repos/ashlrai/ashlr-hub/actions/runs/101/artifacts?per_page=100&page=2', {
    total_count: 101, artifacts: [{ ...producer, id: 999 }],
  });
  assert.throws(() => prepare({ env: f.inputs, read: f.read }), /ambiguous/);
  assert.deepEqual(readdirSync(f.temporary), []);
}));

function withData(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-attestation-copy-test-')));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('copies inert bytes into independent non-executable files, retaining no hardlinks', () => withData(root => {
  const source = join(root, 'source'); mkdirSync(source); mkdirSync(join(source, 'nested'));
  const input = join(source, 'nested', 'never-execute.sh'); writeFileSync(input, '#!/bin/sh\nexit 99\n'); chmodSync(input, 0o700);
  const out = join(root, 'out'); copyDataTree(source, out);
  const copied = join(out, 'nested', 'never-execute.sh');
  assert.ok(readFileSync(copied).equals(readFileSync(input)));
  assert.notEqual(lstatSync(copied).ino, lstatSync(input).ino); assert.equal(lstatSync(copied).nlink, 1);
  if (process.platform !== 'win32') assert.equal(lstatSync(copied).mode & 0o777, 0o600);
  writeFileSync(copied, 'changed copy'); assert.match(readFileSync(input, 'utf8'), /exit 99/);
}));
for (const kind of ['symbolic-link', 'hardlink', 'existing-destination', 'depth-bound', 'file-bound', 'byte-bound']) {
  test(`refuses unsafe assembly input ${kind}`, { skip: process.platform === 'win32' && kind === 'symbolic-link' }, () => withData(root => {
    const source = join(root, 'source'); mkdirSync(source); const file = join(source, 'input'); writeFileSync(file, 'inert');
    const out = join(root, 'out'); let budget; let depth = 0;
    if (kind === 'symbolic-link') symlinkSync(file, join(source, 'alias'));
    if (kind === 'hardlink') linkSync(file, join(source, 'alias'));
    if (kind === 'existing-destination') { mkdirSync(out); writeFileSync(join(out, 'keep'), 'preserved'); }
    if (kind === 'depth-bound') depth = 49;
    if (kind === 'file-bound') budget = { files: 1024, bytes: 0, directories: 0 };
    if (kind === 'byte-bound') budget = { files: 0, bytes: 512 * 1024 * 1024, directories: 0 };
    assert.throws(() => copyDataTree(source, out, budget, depth));
    assert.equal(readFileSync(file, 'utf8'), 'inert');
    if (kind === 'existing-destination') assert.equal(readFileSync(join(out, 'keep'), 'utf8'), 'preserved');
  }));
}

test('assembles exactly the prepared producer and five named lanes as data', () => withData(root => {
  const map = { producer: { id: 301, name: 'ashlr-build-101-2' }, lanes: artifactNames(101, 2).lanes };
  writeFileSync(join(root, 'artifact-map.json'), JSON.stringify(map));
  mkdirSync(join(root, 'download')); const producer = join(root, 'download', map.producer.name); mkdirSync(producer);
  writeFileSync(join(producer, 'manifest.json'), '{}'); mkdirSync(join(producer, 'coverage')); mkdirSync(join(producer, 'coverage', 'web'));
  for (const { name, role } of map.lanes) { const lane = join(root, 'download', name); mkdirSync(lane); writeFileSync(join(lane, 'lane.json'), JSON.stringify({ role })); }
  const bundle = assemble(root); assert.equal(bundle, join(root, 'bundle'));
  assert.deepEqual(readdirSync(join(bundle, 'coverage')).sort(), ['web', ...map.lanes.map(row => row.role)].sort());
  assert.equal(readFileSync(join(bundle, 'manifest.json'), 'utf8'), '{}');
  assert.throws(() => assemble(root));
}));

test('refuses traversal and linked assembly maps before copying artifact data', () => withData(root => {
  const mapPath = join(root, 'artifact-map.json');
  writeFileSync(mapPath, JSON.stringify({ producer: { name: '../outside' }, lanes: artifactNames(101, 2).lanes }));
  assert.throws(() => assemble(root)); assert.equal(existsSync(join(root, 'bundle')), false);
  if (process.platform !== 'win32') {
    const target = join(root, 'map-target'); writeFileSync(target, '{}'); rmSync(mapPath); symlinkSync(target, mapPath);
    assert.throws(() => assemble(root)); assert.equal(existsSync(join(root, 'bundle')), false);
  }
}));

for (const kind of ['repository ID', 'owner ID', 'current namespace', 'minimal run identity']) {
  test(`trusted preparation refuses ${kind} before fetching candidate data`, { skip: process.platform === 'win32' }, () => withFixture((f) => {
    if (kind === 'repository ID') f.inputs.GITHUB_REPOSITORY_ID = '1';
    if (kind === 'owner ID') f.answers.get(`repos/${hub.legacyName}`).owner.id++;
    if (kind === 'current namespace') f.answers.get(`repos/${hub.legacyName}`).full_name = hub.renamedName;
    if (kind === 'minimal run identity') f.answers.get(`repos/${hub.legacyName}/actions/runs/101/attempts/2`).repository.node_id = 'R_other';
    assert.throws(() => prepare({ env: f.inputs, read: f.read }));
    assert.equal(existsSync(join(f.temporary, 'candidate')), false);
  }));
}

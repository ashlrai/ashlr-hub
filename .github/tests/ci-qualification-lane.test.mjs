/* global process */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { collectLane, normalizeReport, reportNames } from '../scripts/ci-qualification-lane.mjs';
import { bindSource } from '../scripts/ci-source-binding.mjs';

function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ashlr-ci-lane-fixture-')));
  fs.chmodSync(parent, 0o700);
  const root = join(parent, 'source'); fs.mkdirSync(root);
  const home = join(parent, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const previous = new Map();
  for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'no-config'), GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined })) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']);
  fs.writeFileSync(join(root, 'tracked.txt'), 'original\n'); git(['add', '.']);
  const commit = (message, extra = []) => git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message, ...extra]);
  commit('fixture');
  const revision = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  const env = { HOME: home, PATH: process.env.PATH, ASHLR_CI_SOURCE_SHA: revision, ASHLR_CI_EVENT_SHA: revision,
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2', ASHLR_TEST_CI_REPORT_DIRECTORY: 'inherited-must-not-survive' };
  const laneDirs = () => fs.readdirSync(parent).filter((name) => name.startsWith('ashlr-qualification-')).map((name) => join(parent, name));
  const assertNoAcceptedLane = () => assert.equal(laneDirs().some((directory) => fs.existsSync(join(directory, 'lane.json'))), false);
  return { parent, root, git, commit, revision, tree, env, laneDirs, assertNoAcceptedLane };
}

function report(root, states = ['passed', 'skipped', 'todo']) {
  return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: states.length,
    numPassedTests: states.filter((s) => s === 'passed').length,
    numPendingTests: states.filter((s) => s === 'skipped').length, numTodoTests: states.filter((s) => s === 'todo').length,
    testResults: [{ name: join(root, 'test/example.test.ts'), status: 'passed', assertionResults:
      states.map((status, i) => ({ fullName: `suite case ${i}`, status, failureMessages: [] })) }] };
}

// Only the runner seam is simulated. These fixtures do not establish hosted
// coverage: production CI must produce and independently verify real JSON bytes.
function simulatedRun(f, role, mutate) {
  return (command, args, options) => {
    assert.equal(options.cwd, f.root); assert.equal(options.stdio, 'inherit');
    let reports;
    if (role === 'web') {
      assert.equal(command, 'npm');
      reports = dirname(args.find((arg) => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length));
      assert.deepEqual(args, ['run', 'test:web', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${join(reports, 'web.json')}`]);
      assert.equal(Object.hasOwn(options.env, 'ASHLR_TEST_CI_REPORT_DIRECTORY'), false);
    } else {
      assert.equal(command, 'npm'); reports = options.env.ASHLR_TEST_CI_REPORT_DIRECTORY;
      assert.deepEqual(args, ['run', 'test:ci:sharded', '--', role === 'mac-isolated' ? '--isolated-only' : `--general-shard=${role.slice(-1)}/4`]);
    }
    assert.notEqual(reports, f.env.ASHLR_TEST_CI_REPORT_DIRECTORY);
    assert.equal(fs.statSync(reports).mode & 0o7777, 0o700);
    assert.deepEqual(fs.readdirSync(reports), []);
    for (const name of reportNames(role)) fs.writeFileSync(join(reports, name), JSON.stringify(report(f.root)), { mode: 0o600 });
    mutate?.(reports);
    return { status: 0, signal: null };
  };
}

test('source binding checks the real clean candidate and identical event tree', (t) => {
  const f = fixture(t), calls = [];
  const bound = bindSource({ root: f.root, candidate: f.revision, eventSha: f.revision,
    runGit: (args) => { calls.push(args); return f.git(args); } });
  assert.deepEqual(bound, { revision: f.revision, tree: f.tree, eventSha: f.revision });
  assert.equal(calls.some((args) => args[0] === 'fetch'), false);
});

for (const differentTree of [false, true]) {
  test(`different event revision is fetched before tree comparison and ${differentTree ? 'refuses different' : 'accepts identical'} real tree`, (t) => {
    const f = fixture(t);
    if (differentTree) { fs.writeFileSync(join(f.root, 'tracked.txt'), 'event change\n'); f.git(['add', '.']); }
    f.commit('event', differentTree ? [] : ['--allow-empty']);
    const eventSha = f.git(['rev-parse', 'HEAD']);
    const remote = join(f.parent, 'origin.git');
    execFileSync('git', ['clone', '--quiet', '--bare', f.root, remote], { stdio: ['ignore', 'pipe', 'pipe'] });
    f.git(['remote', 'add', 'origin', remote]); f.git(['reset', '--hard', f.revision]);
    const calls = [], options = { root: f.root, candidate: f.revision, eventSha,
      runGit: (args) => { calls.push(args); return f.git(args); } };
    if (differentTree) assert.throws(() => bindSource(options), /tree differs/);
    else assert.deepEqual(bindSource(options), { revision: f.revision, tree: f.tree, eventSha });
    assert.deepEqual(calls[2], ['fetch', '--no-tags', 'origin', eventSha]);
    assert.equal(calls[3][0], 'rev-parse'); assert.equal(calls[4][1], `${eventSha}^{tree}`);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.revision);
  });
}

for (const kind of ['invalid candidate', 'invalid event', 'head mismatch', 'dirty tracked', 'dirty untracked']) {
  test(`source binding refuses ${kind} before fetching`, (t) => {
    const f = fixture(t), calls = [];
    const options = { root: f.root, candidate: f.revision, eventSha: 'a'.repeat(40),
      runGit: (args) => { calls.push(args); return f.git(args); } };
    if (kind === 'invalid candidate') options.candidate = '../source';
    if (kind === 'invalid event') options.eventSha = 'not-a-revision';
    if (kind === 'head mismatch') options.candidate = 'b'.repeat(40);
    if (kind === 'dirty tracked') fs.writeFileSync(join(f.root, 'tracked.txt'), 'dirty');
    if (kind === 'dirty untracked') fs.writeFileSync(join(f.root, 'new.txt'), 'dirty');
    assert.throws(() => bindSource(options)); assert.equal(calls.some((args) => args[0] === 'fetch'), false);
  });
}

test('report normalization preserves passed, skipped and todo with stable file-bound identities', () => {
  const root = '/fixture/source', raw = report(root);
  const normalized = normalizeReport(raw, root);
  assert.equal(normalized[0].file, 'test/example.test.ts');
  assert.deepEqual(normalized[0].cases.map((item) => item.state), ['passed', 'skipped', 'todo']);
  assert.equal(normalized[0].cases[0].id, createHash('sha256').update(`test/example.test.ts\0suite case 0\0${0}`).digest('hex'));
  assert.deepEqual(normalizeReport(raw, root), normalized);
});

test('parameterized duplicate titles preserve every row with ordered occurrence identities', () => {
  const root = '/fixture/source', raw = report(root, ['passed', 'passed', 'skipped']);
  for (const item of raw.testResults[0].assertionResults) item.fullName = 'same parameterized title';
  const rows = normalizeReport(raw, root)[0].cases;
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  for (let occurrence = 0; occurrence < rows.length; occurrence++) {
    assert.equal(rows[occurrence].id, createHash('sha256').update(`test/example.test.ts\0same parameterized title\0${occurrence}`).digest('hex'));
  }
  assert.deepEqual(rows.map((row) => row.state), ['passed', 'passed', 'skipped']);
});

const invalidReports = {
  'failed summary': (r) => { r.success = false; },
  'failed test total': (r) => { r.numFailedTests = 1; },
  'failed suite total': (r) => { r.numFailedTestSuites = 1; },
  'empty modules': (r) => { r.testResults = []; },
  'failed module': (r) => { r.testResults[0].status = 'failed'; },
  'empty cases': (r) => { r.testResults[0].assertionResults = []; },
  'relative module': (r) => { r.testResults[0].name = 'test/example.test.ts'; },
  'path traversal': (r) => { r.testResults[0].name = '/fixture/source/../escape.test.ts'; },
  'prefix sibling': (r) => { r.testResults[0].name = '/fixture/source-other/test.ts'; },
  'duplicate module': (r) => { r.testResults.push(JSON.parse(JSON.stringify(r.testResults[0]))); },
  'unfinished pending case': (r) => { r.testResults[0].assertionResults[1].status = 'pending'; },
  'failed case': (r) => { r.testResults[0].assertionResults[0].status = 'failed'; },
  'unknown case': (r) => { r.testResults[0].assertionResults[0].status = 'not-run'; },
  'failure messages': (r) => { r.testResults[0].assertionResults[0].failureMessages = ['fixture failure']; },
  'empty name': (r) => { r.testResults[0].assertionResults[0].fullName = ''; },
  'total disagreement': (r) => { r.numTotalTests++; },
  'pass disagreement': (r) => { r.numPassedTests++; },
  'pending disagreement': (r) => { r.numPendingTests++; },
  'todo disagreement': (r) => { r.numTodoTests++; },
};
for (const [kind, mutate] of Object.entries(invalidReports)) {
  test(`report normalization rejects ${kind}`, () => { const raw = report('/fixture/source'); mutate(raw); assert.throws(() => normalizeReport(raw, '/fixture/source')); });
}

test('report names are the exact fixed web, four partition and fourteen isolated inventory', () => {
  assert.deepEqual(reportNames('web'), ['web.json']);
  for (let index = 1; index <= 4; index++) assert.deepEqual(reportNames(`mac-general-${index}`), [`general-${index}-of-4.json`]);
  assert.deepEqual(reportNames('mac-isolated'), Array.from({ length: 14 }, (_, index) => `isolated-${String(index + 1).padStart(2, '0')}.json`));
});

for (const role of ['web', 'mac-general-1', 'mac-general-2', 'mac-general-3', 'mac-general-4', 'mac-isolated']) {
  test(`lane ${role} uses fixed arguments and private immutable report output`, { skip: typeof process.getuid !== 'function' }, (t) => {
    const f = fixture(t), before = f.git(['status', '--porcelain']); let calls = 0;
    const run = simulatedRun(f, role); const directory = collectLane({ role, root: f.root, parent: f.parent, env: f.env,
      run: (...args) => { calls++; return run(...args); }, now: () => '2026-10-06T00:00:00.000Z' });
    const path = join(directory, 'lane.json'), lane = JSON.parse(fs.readFileSync(path));
    assert.equal(calls, 1); assert.equal(fs.statSync(directory).mode & 0o7777, 0o700); assert.equal(fs.statSync(path).mode & 0o7777, 0o600);
    assert.equal(lane.role, role); assert.deepEqual(lane.source, { revision: f.revision, tree: f.tree, eventSha: f.revision });
    assert.deepEqual(lane.run, { id: '100', attempt: '2' }); assert.equal(lane.exitCode, 0);
    assert.deepEqual(lane.reports.map((item) => item.file), reportNames(role));
    for (const item of lane.reports) {
      const bytes = fs.readFileSync(join(directory, 'reports', item.file));
      assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(item.bytes, bytes.length);
      assert.deepEqual(item.modules[0].cases.map((c) => c.state), ['passed', 'skipped', 'todo']);
    }
    assert.equal(f.git(['status', '--porcelain']), before); assert.equal(f.git(['rev-parse', 'HEAD']), f.revision);
    assert.equal(fs.readFileSync(join(f.root, 'tracked.txt'), 'utf8'), 'original\n');
  });
}

// Real npm supplies launch metadata; this inert script never discovers or runs
// repository tests. Its synthetic report proves only the collector boundary.
test('Mac collector uses real npm script metadata from the active Node toolchain', { skip: typeof process.getuid !== 'function' }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, 'package.json'), JSON.stringify({ private: true, scripts: { 'test:ci:sharded': 'node launch.mjs' } }));
  fs.writeFileSync(join(f.root, 'launch.mjs'), `import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
const reports = process.env.ASHLR_TEST_CI_REPORT_DIRECTORY;
fs.writeFileSync(join(dirname(reports), 'npm-context.json'), JSON.stringify({
  args: process.argv.slice(2), npm: fs.realpathSync(process.env.npm_execpath),
  node: fs.realpathSync(process.execPath), npmNode: fs.realpathSync(process.env.npm_node_execpath),
  lifecycle: process.env.npm_lifecycle_event, reports
}), { mode: 0o600 });
fs.writeFileSync(join(reports, 'general-3-of-4.json'), ${JSON.stringify(JSON.stringify(report(f.root)))}, { mode: 0o600 });
`);
  f.git(['add', '.']); f.commit('inert npm fixture');
  const revision = f.git(['rev-parse', 'HEAD']), tree = f.git(['rev-parse', 'HEAD^{tree}']);
  const env = { ...f.env, ASHLR_CI_SOURCE_SHA: revision, ASHLR_CI_EVENT_SHA: revision,
    npm_config_cache: join(f.parent, 'npm-cache'), npm_config_userconfig: join(f.parent, 'no-npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  assert.equal(Object.hasOwn(env, 'npm_execpath'), false);
  assert.equal(Object.hasOwn(env, 'npm_node_execpath'), false);
  const npmPath = process.env.PATH.split(delimiter).map((entry) => join(entry, 'npm')).find((path) => fs.existsSync(path));
  assert.ok(npmPath, 'installed npm is required for this launch boundary');
  const directory = collectLane({ role: 'mac-general-3', root: f.root, parent: f.parent, env });
  const context = JSON.parse(fs.readFileSync(join(directory, 'npm-context.json')));
  assert.deepEqual(context.args, ['--general-shard=3/4']);
  assert.equal(context.lifecycle, 'test:ci:sharded');
  assert.equal(context.npm, fs.realpathSync(npmPath));
  assert.match(context.npm, /[/\\]npm[/\\]bin[/\\]npm-cli\.js$/);
  assert.equal(context.node, fs.realpathSync(process.execPath));
  assert.equal(context.npmNode, fs.realpathSync(process.execPath));
  assert.equal(context.reports, join(directory, 'reports'));
  assert.notEqual(context.reports, f.env.ASHLR_TEST_CI_REPORT_DIRECTORY);
  const lane = JSON.parse(fs.readFileSync(join(directory, 'lane.json')));
  assert.deepEqual(lane.source, { revision, tree, eventSha: revision });
  assert.deepEqual(lane.reports.map((item) => item.file), ['general-3-of-4.json']);
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(f.git(['rev-parse', 'HEAD']), revision);
});

for (const role of ['mac-general-0', 'mac-general-5', 'mac-general-1/4', '../web', 'web --filter']) {
  test(`unknown role ${role} refuses before any child or output`, (t) => {
    const f = fixture(t); let calls = 0;
    assert.throws(() => collectLane({ role, root: f.root, parent: f.parent, env: f.env, run: () => { calls++; } }), /Unknown qualification lane/);
    assert.equal(calls, 0); assert.deepEqual(f.laneDirs(), []);
  });
}

for (const kind of ['wrong source', 'invalid event', 'missing run', 'invalid attempt', 'dirty source', 'noncanonical root']) {
  test(`lane refuses ${kind} before running a child`, { skip: typeof process.getuid !== 'function' }, (t) => {
    const f = fixture(t), options = { role: 'web', root: f.root, parent: f.parent, env: { ...f.env } }; let calls = 0;
    if (kind === 'wrong source') options.env.ASHLR_CI_SOURCE_SHA = 'a'.repeat(40);
    if (kind === 'invalid event') options.env.ASHLR_CI_EVENT_SHA = 'invalid';
    if (kind === 'missing run') delete options.env.GITHUB_RUN_ID;
    if (kind === 'invalid attempt') options.env.GITHUB_RUN_ATTEMPT = '0';
    if (kind === 'dirty source') fs.writeFileSync(join(f.root, 'tracked.txt'), 'changed');
    if (kind === 'noncanonical root') options.root = `${f.root}/.`;
    assert.throws(() => collectLane({ ...options, run: () => { calls++; } }));
    assert.equal(calls, 0); f.assertNoAcceptedLane();
  });
}

for (const result of [{ status: 7 }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('synthetic startup error') }]) {
  test(`failed child ${result.status ?? result.signal ?? 'startup'} cannot publish an accepted lane`, { skip: typeof process.getuid !== 'function' }, (t) => {
    const f = fixture(t); const run = simulatedRun(f, 'web');
    assert.throws(() => collectLane({ role: 'web', root: f.root, parent: f.parent, env: f.env, run: (...args) => { run(...args); return result; } }), /Qualification command failed/);
    f.assertNoAcceptedLane(); assert.equal(f.git(['status', '--porcelain']), ''); assert.equal(f.git(['rev-parse', 'HEAD']), f.revision);
  });
}

for (const kind of ['missing', 'extra', 'symlink', 'hardlink', 'special bits', 'oversized', 'failed report', 'source mutation']) {
  test(`lane refuses ${kind} after child success without an accepted record`, { skip: typeof process.getuid !== 'function' }, (t) => {
    const f = fixture(t), run = simulatedRun(f, 'web', (reports) => {
      const path = join(reports, 'web.json');
      if (kind === 'missing') fs.unlinkSync(path);
      if (kind === 'extra') fs.writeFileSync(join(reports, 'extra.json'), '{}');
      if (kind === 'symlink') { fs.unlinkSync(path); fs.symlinkSync(join(f.root, 'tracked.txt'), path); }
      if (kind === 'hardlink') fs.linkSync(path, join(f.parent, 'linked.json'));
      if (kind === 'special bits') fs.chmodSync(path, 0o1600);
      if (kind === 'oversized') fs.truncateSync(path, 64 * 1024 * 1024 + 1);
      if (kind === 'failed report') fs.writeFileSync(path, JSON.stringify({ ...report(f.root), success: false }));
      if (kind === 'source mutation') fs.writeFileSync(join(f.root, 'tracked.txt'), 'changed by simulated child');
    });
    assert.throws(() => collectLane({ role: 'web', root: f.root, parent: f.parent, env: f.env, run }));
    f.assertNoAcceptedLane();
    if (kind !== 'source mutation') assert.equal(f.git(['status', '--porcelain']), '');
    else assert.equal(fs.readFileSync(join(f.root, 'tracked.txt'), 'utf8'), 'changed by simulated child');
  });
}

// Pin reporter semantics to the installed CLI using one private inert file,
// never the repository's test discovery or an accepted qualification lane.
test('installed Vitest JSON preserves duplicate titles, skips and todos in normalization', (t) => {
  const f = fixture(t), directory = join(f.parent, 'vitest-format'); fs.mkdirSync(directory, { mode: 0o700 });
  const installed = fs.realpathSync(fileURLToPath(new URL('../../node_modules', import.meta.url)));
  fs.symlinkSync(installed, join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const path = join(directory, 'format.test.mjs');
  fs.writeFileSync(path, "import { it, expect } from 'vitest';\nit.each([1, 2])('duplicate title', () => expect(true).toBe(true));\nit('passed', () => expect(true).toBe(true));\nit.skip('skipped', () => expect(false).toBe(true));\nit.todo('todo');\n");
  const config = join(directory, 'vitest.config.mjs');
  fs.writeFileSync(config, `export default ${JSON.stringify({ test: { root: directory, include: ['format.test.mjs'], exclude: [], environment: 'node', globals: false, pool: 'forks', maxWorkers: 1, fileParallelism: false, watch: false } })};\n`);
  const output = join(directory, 'report.json');
  const child = spawnSync(process.execPath, [join(installed, 'vitest/vitest.mjs'), 'run', '--root', directory,
    '--config', config, '--maxWorkers=1', '--fileParallelism=false', '--reporter=json', `--outputFile.json=${output}`],
  { cwd: directory, env: { ...process.env, CI: 'true' }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  const raw = JSON.parse(fs.readFileSync(output)); const modules = normalizeReport(raw, directory);
  assert.equal(raw.numTotalTests, 5); assert.equal(raw.numPassedTests, 3); assert.equal(raw.numPendingTests, 1); assert.equal(raw.numTodoTests, 1);
  assert.deepEqual(modules.map((module) => module.file), ['format.test.mjs']);
  assert.deepEqual(modules[0].cases.map((row) => row.state), ['passed', 'passed', 'passed', 'skipped', 'todo']);
  const repeated = modules[0].cases.filter((row) => row.name.endsWith('duplicate title'));
  assert.equal(repeated.length, 2); assert.notEqual(repeated[0].id, repeated[1].id);
  assert.equal(f.git(['status', '--porcelain']), ''); assert.equal(f.git(['rev-parse', 'HEAD']), f.revision);
});

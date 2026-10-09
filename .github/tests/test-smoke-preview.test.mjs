/* global process */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { parseArguments, previewSmoke } from '../../scripts/test-smoke-preview.mjs';

const cli = fileURLToPath(new URL('../../scripts/test-smoke-preview.mjs', import.meta.url));

function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phantom-smoke-fixture-')));
  const root = join(parent, 'source'); const home = join(parent, 'home'); fs.mkdirSync(root); fs.mkdirSync(home);
  const previous = new Map();
  for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none'),
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined })) {
    previous.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(parent, { recursive: true, force: true }); });
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { fs.mkdirSync(dirname(join(root, path)), { recursive: true }); fs.writeFileSync(join(root, path), text); };
  const commit = () => { git(['add', '.']); git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  git(['init', '--quiet']);
  put('package.json', '{"name":"offline-fixture","version":"1.0.0"}\n');
  put('src/core/model-catalog.ts', 'export const model = 1; throw new Error("candidate must never execute");\n');
  put('src/core/dispatch-router.ts', "import { model } from './model-catalog.js'; export const selected = model;\n");
  put('src/core/tick-hooks-live.ts', "import { selected } from './dispatch-router.js'; export const tick = selected;\n");
  put('test/standing-wiring-310b.test.ts', "import { tick } from '../src/core/tick-hooks-live.js'; export const observed = tick;\n");
  put('test/dispatch-router-310b.test.ts', "import { selected } from '../src/core/dispatch-router.js'; export const observed = selected;\n");
  put('src/web-ui/preview.test.tsx', "import { model } from '../core/model-catalog.js'; export const rendered = <div>{model}</div>;\n");
  const base = commit();
  const preview = (paths, revision = git(['rev-parse', 'HEAD'])) => previewSmoke({ root, baseRevision: base, revision, changedPaths: paths });
  return { root, parent, put, git, commit, base, preview };
}

test('catalog and router changes suggest whole standing-wiring through real immutable source imports without execution', (t) => {
  const f = fixture(t);
  f.put('src/core/model-catalog.ts', 'export const model = 2; throw new Error("candidate must never execute");\n');
  f.put('src/core/dispatch-router.ts', "import { model } from './model-catalog.js'; export const selected = model + 1;\n"); f.commit();
  const before = f.git(['status', '--porcelain']); const report = f.preview(['src/core/dispatch-router.ts', 'src/core/model-catalog.ts']);
  const standing = report.suggestedWholeModules.find((row) => row.module === 'test/standing-wiring-310b.test.ts');
  assert.equal(standing.runScope, 'whole-module'); assert.equal(standing.directlyChanged, false);
  assert.ok(standing.witnesses.some((row) => row.side === 'head' && row.changedPath === 'src/core/model-catalog.ts' &&
    row.importChain.join(' -> ') === 'test/standing-wiring-310b.test.ts -> src/core/tick-hooks-live.ts -> src/core/dispatch-router.ts -> src/core/model-catalog.ts'));
  assert.ok(report.suggestedWholeModules.some((row) => row.module === 'src/web-ui/preview.test.tsx'));
  assert.equal(report.advisoryOnly, true); assert.equal(report.activationEnabled, false);
  assert.equal(report.qualification.executedCases, null); assert.equal(report.qualification.inheritedCases, 0);
  assert.equal(report.qualification.fullCoverage, 'unobserved'); assert.equal(report.qualification.fullExecutionRequired, true);
  assert.ok(report.suggestedWholeModules.every((row) => row.cases === null && row.result === 'unobserved' && row.membership === 'unobserved'));
  assert.ok(report.warnings.some((row) => row.code === 'full-qualification-domain-changed'));
  assert.ok(report.warnings.some((row) => row.code === 'multiple-test-importers'));
  assert.equal(f.git(['status', '--porcelain']), before);
});

test('removed import edges retain base witnesses without constructing a mixed-revision path', (t) => {
  const f = fixture(t); f.put('src/core/tick-hooks-live.ts', 'export const tick = 2;\n');
  f.put('src/core/model-catalog.ts', 'export const model = 3;\n'); f.commit();
  const report = f.preview(['src/core/tick-hooks-live.ts', 'src/core/model-catalog.ts']);
  const standing = report.suggestedWholeModules.find((row) => row.module === 'test/standing-wiring-310b.test.ts');
  assert.ok(standing.witnesses.some((row) => row.changedPath === 'src/core/model-catalog.ts' && row.side === 'base'));
  assert.ok(!standing.witnesses.some((row) => row.changedPath === 'src/core/model-catalog.ts' && row.side === 'head'));
  assert.equal(standing.directlyChanged, false);
});

test('direct Node tests are whole suggestions while deleted tests are not runnable', (t) => {
  const f = fixture(t); f.put('.github/tests/offline.test.mjs', 'throw new Error("must not execute a changed test");\n');
  fs.unlinkSync(join(f.root, 'test/dispatch-router-310b.test.ts')); f.commit();
  const report = f.preview(['.github/tests/offline.test.mjs', 'test/dispatch-router-310b.test.ts']);
  const direct = report.suggestedWholeModules.find((row) => row.module === '.github/tests/offline.test.mjs');
  assert.equal(direct.directlyChanged, true); assert.equal(direct.suggestionBasis, 'direct-change-only');
  assert.deepEqual(direct.witnesses, []); assert.equal(direct.runScope, 'whole-module');
  assert.ok(!report.suggestedWholeModules.some((row) => row.module === 'test/dispatch-router-310b.test.ts'));
  assert.ok(report.warnings.find((row) => row.code === 'deleted-tests-are-not-runnable-suggestions').paths.includes('test/dispatch-router-310b.test.ts'));
});

test('computed imports, data and unreferenced changes warn rather than becoming safe or covered', (t) => {
  const f = fixture(t);
  f.put('test/standing-wiring-310b.test.ts', "import { tick } from '../src/core/tick-hooks-live.js'; import(target); export const observed = tick;\n");
  f.put('README.md', 'unreferenced data\n'); f.put('package.json', '{"name":"offline-fixture","version":"1.0.1"}\n'); f.commit();
  const report = f.preview(['test/standing-wiring-310b.test.ts', 'README.md', 'package.json']);
  assert.ok(report.warnings.find((row) => row.code === 'unresolved-source-inputs').domains.some((row) => row.reason === 'computed-import-or-mock' && row.headSourceNodes === 1));
  assert.ok(report.warnings.find((row) => row.code === 'changed-paths-without-resolved-test-suggestion').paths.includes('README.md'));
  assert.ok(report.warnings.find((row) => row.code === 'full-qualification-domain-changed').changes.some((row) => row.path === 'package.json' && row.reason === 'package-or-version-change'));
  assert.equal(report.qualification.fullExecutionRequired, true);
});

test('empty exact diff remains advisory and does not establish full coverage', (t) => {
  const f = fixture(t); const report = f.preview([]);
  assert.deepEqual(report.changes, []); assert.deepEqual(report.suggestedWholeModules, []);
  assert.equal(report.qualification.fullCoverage, 'unobserved'); assert.equal(report.qualification.fullExecutionRequired, true);
  assert.ok(report.warnings.find((row) => row.code === 'global-inputs-unavailable').missing.head.includes('vitest.config.ts'));
});

test('unavailable global inputs retain separate base and head observations', (t) => {
  const f = fixture(t); f.put('vitest.config.ts', 'export default {};\n'); f.commit();
  const report = f.preview(['vitest.config.ts']);
  const missing = report.warnings.find((row) => row.code === 'global-inputs-unavailable').missing;
  assert.ok(missing.base.includes('vitest.config.ts')); assert.ok(!missing.head.includes('vitest.config.ts'));
  assert.ok(missing.head.includes('test/setup/home.ts'));
  assert.equal(report.qualification.fullCoverage, 'unobserved');
});

test('a former regular test replaced by a symlink is not revived by a base reverse witness', (t) => {
  const f = fixture(t); fs.unlinkSync(join(f.root, 'test/standing-wiring-310b.test.ts'));
  fs.symlinkSync('../src/core/model-catalog.ts', join(f.root, 'test/standing-wiring-310b.test.ts'));
  f.put('src/core/model-catalog.ts', 'export const model = 3;\n'); f.commit();
  const report = f.preview(['test/standing-wiring-310b.test.ts', 'src/core/model-catalog.ts']);
  assert.ok(!report.suggestedWholeModules.some((row) => row.module === 'test/standing-wiring-310b.test.ts'));
  assert.ok(report.suggestedWholeModules.some((row) => row.module === 'test/dispatch-router-310b.test.ts'));
  assert.ok(report.warnings.find((row) => row.code === 'changed-tests-are-not-regular-modules').paths.includes('test/standing-wiring-310b.test.ts'));
  assert.ok(report.warnings.find((row) => row.code === 'unresolved-source-inputs').domains.some((row) => row.reason === 'nonmodule-or-link-input'));
});

for (const kind of ['duplicate', 'omitted', 'extra', 'unsafe', 'symbolic-head', 'symbolic-base', 'missing-base', 'nonancestor', 'dirty', 'hidden-index']) {
  test(`refuses ${kind} rather than returning a successful incomplete preview`, (t) => {
    const f = fixture(t); f.put('src/core/model-catalog.ts', 'export const model = 3;\n'); const revision = f.commit();
    const options = { root: f.root, baseRevision: f.base, revision, changedPaths: ['src/core/model-catalog.ts'] };
    if (kind === 'duplicate') options.changedPaths.push('src/core/model-catalog.ts');
    if (kind === 'omitted') options.changedPaths = [];
    if (kind === 'extra') options.changedPaths.push('src/absent.ts');
    if (kind === 'unsafe') options.changedPaths.push('../outside.ts');
    if (kind === 'symbolic-head') options.revision = 'HEAD';
    if (kind === 'symbolic-base') options.baseRevision = 'HEAD~1';
    if (kind === 'missing-base') options.baseRevision = 'f'.repeat(40);
    if (kind === 'nonancestor') { options.baseRevision = revision; options.revision = f.base; f.git(['reset', '--hard', f.base]); options.changedPaths = []; }
    if (kind === 'dirty') f.put('README.md', 'untracked dirt\n');
    if (kind === 'hidden-index') f.git(['update-index', '--assume-unchanged', 'src/core/model-catalog.ts']);
    assert.throws(() => previewSmoke(options));
  });
}

test('CLI requires explicit inputs, writes JSON only on stdout and never touches CI output paths', (t) => {
  const f = fixture(t); const output = join(f.parent, 'github-output');
  const args = [cli, '--root', f.root, '--base', f.base, '--head', f.base, '--changed'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: output } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).schema, 'phantom-local-smoke-preview/v1');
  assert.equal(fs.existsSync(output), false);
  const refused = spawnSync(process.execPath, [cli, '--root', f.root, '--base', 'HEAD', '--head', f.base, '--changed'], { encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /full qualification remains required/);
  assert.throws(() => parseArguments(['--root', f.root]), /Usage:/);
});

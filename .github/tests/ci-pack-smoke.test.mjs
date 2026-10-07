/* global process, Buffer */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBuild, cleanupSnapshot, observeBuild, packBuild, validateBuild, validatePackReport } from '../scripts/ci-pack-smoke.mjs';

const hash = (bytes, algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const VERSION = '3.24.2';
function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-pack-fixture-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const home = join(parent, 'home'); mkdirSync(home);
  const template = join(parent, 'template'); mkdirSync(template);
  const previous = new Map();
  const env = { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: join(home, 'no-system'), GIT_CONFIG_GLOBAL: join(home, 'no-global'),
    GIT_TEMPLATE_DIR: template, GIT_CONFIG_COUNT: '0', GIT_DIR: undefined,
    GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined,
    ASHLR_REPRODUCIBLE_PACKAGE: undefined };
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const root = join(parent, 'source'); mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/hub', version: VERSION }));
  git('add', '.');
  git('-c', 'user.name=Pack fixture', '-c', 'user.email=pack@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'fixture');
  const eventSha = git('rev-parse', 'HEAD');
  const identity = { schemaVersion: 1, packageVersion: VERSION, revision: eventSha, dirty: false, provenance: 'git' };
  const write = (path, bytes) => { const full = join(root, 'dist', path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, bytes); };
  write('build-identity.json', JSON.stringify(identity));
  for (const path of ['authority-surface.json', 'release-dependency-inventory.json', 'cli/index.js',
    'api/core.js', 'api/types.js', 'core/sandbox/claude-broker-tool-worker.js',
    'core/sandbox/claude-broker-tool-invocation.js', 'core/web/public/assets/current.js']) write(path, `built:${path}`);
  const options = { root, eventSha, parent };
  const snapshotPath = captureBuild(options);
  return { ...options, snapshotPath, identity, git, write };
}
function report(destination, overrides = {}) {
  const bytes = Buffer.from('synthetic tarball fixture, never installed or executed');
  const filename = `ashlr-hub-${VERSION}.tgz`;
  writeFileSync(join(destination, filename), bytes);
  return JSON.stringify([{ name: '@ashlr/hub', version: VERSION, filename,
    size: bytes.length, shasum: hash(bytes, 'sha1'), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
    ...overrides }]);
}

test('capture records all build bytes and modes; pack uses exactly one lifecycle-off command', (t) => {
  const f = fixture(t); const calls = [];
  const path = packBuild({ ...f, runNpm: (bin, args, options) => {
    calls.push({ bin, args, options });
    assert.deepEqual(args.slice(0, 4), ['pack', '--ignore-scripts', '--json', '--pack-destination']);
    assert.equal(options.cwd, f.root);
    return report(args[4]);
  } });
  assert.equal(calls.length, 1); assert.equal(calls[0].bin, 'npm');
  assert.ok(path.startsWith(`${f.parent}/ashlr-pack-tarball-`));
  assert.equal(readFileSync(path, 'utf8'), 'synthetic tarball fixture, never installed or executed');
  const observed = JSON.parse(readFileSync(f.snapshotPath, 'utf8'));
  assert.equal(observed.dist.filter((entry) => entry.type === 'file').length, 9);
  assert.ok(observed.dist.some((entry) => entry.path === 'core/web/public/assets/current.js' && entry.sha256));
});

for (const kind of ['changed bytes', 'deleted file', 'new file', 'mode change', 'special file bits', 'special directory bits', 'symlink replacement']) {
  test(`refuses ${kind} after successful build before any npm contact`, (t) => {
    const f = fixture(t); const path = join(f.root, 'dist/api/core.js');
    if (kind === 'changed bytes') f.write('api/core.js', 'tampered');
    if (kind === 'deleted file') rmSync(path);
    if (kind === 'new file') f.write('new-generated.js', 'unexpected');
    if (kind === 'mode change') chmodSync(path, 0o700);
    if (kind === 'special file bits') chmodSync(path, (lstatSync(path).mode & 0o777) | 0o4000);
    if (kind === 'special directory bits') {
      const directory = join(f.root, 'dist/api');
      const ordinaryMode = lstatSync(directory).mode & 0o777;
      // Setgid can be stripped when a private temp dir inherits a group the
      // owner does not belong to. The sticky bit is owner-permitted on POSIX.
      chmodSync(directory, ordinaryMode | 0o1000);
      assert.equal(lstatSync(directory).mode & 0o777, ordinaryMode);
      assert.equal(lstatSync(directory).mode & 0o7000, 0o1000);
    }
    if (kind === 'symlink replacement') { rmSync(path); symlinkSync(join(f.root, 'package.json'), path); }
    let calls = 0;
    assert.throws(() => packBuild({ ...f, runNpm: () => { calls++; return ''; } }));
    assert.equal(calls, 0);
  });
}

test('refuses a matching version with stale event/build revision or dirty source', (t) => {
  const f = fixture(t);
  assert.throws(() => validateBuild({ ...f, eventSha: 'a'.repeat(40) }), /checkout differs/);
  f.write('build-identity.json', JSON.stringify({ ...f.identity, revision: 'b'.repeat(40) }));
  assert.throws(() => observeBuild(f.root, f.eventSha), /build identity/);
  f.write('build-identity.json', JSON.stringify(f.identity));
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: '@ashlr/hub', version: '3.24.3' }));
  assert.throws(() => observeBuild(f.root, f.eventSha), /source changed/);
});

test('refuses missing event identity, missing worker closure and malformed snapshot', (t) => {
  const f = fixture(t);
  assert.throws(() => observeBuild(f.root, undefined), /event SHA/);
  rmSync(join(f.root, 'dist/core/sandbox/claude-broker-tool-worker.js'));
  assert.throws(() => observeBuild(f.root, f.eventSha), /missing built artifact/);
  f.write('core/sandbox/claude-broker-tool-worker.js', 'restored');
  chmodSync(f.snapshotPath, 0o600); writeFileSync(f.snapshotPath, '{"schemaVersion":1,"dist":[]}');
  assert.throws(() => validateBuild(f));
});

test('capture never overwrites a previous same-job receipt', (t) => {
  const f = fixture(t); const prior = readFileSync(f.snapshotPath);
  const next = captureBuild(f);
  assert.notEqual(next, f.snapshotPath); assert.deepEqual(readFileSync(f.snapshotPath), prior);
});

test('detects output modified during npm pack without rebuilding or returning a tarball', (t) => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => packBuild({ ...f, runNpm: (_bin, args) => {
    calls++; f.write('api/core.js', 'pack-time mutation'); return report(args[4]);
  } }), /build output differs/);
  assert.equal(calls, 1);
});

for (const [name, overrides] of [
  ['wrong package', { name: '@other/hub' }], ['wrong version', { version: '3.24.1' }],
  ['path traversal', { filename: '../ashlr-hub-3.24.2.tgz' }],
  ['wrong size', { size: 1 }], ['wrong hash', { shasum: 'a'.repeat(40) }],
  ['wrong integrity', { integrity: 'sha512-wrong' }],
]) test(`rejects npm report ${name}`, (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'ashlr-pack-report-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText: report(parent, overrides) }));
});

test('rejects ambiguous pack results, extra files and symlink tarballs', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'ashlr-pack-report-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const reportText = report(parent); const parsed = JSON.parse(reportText);
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText: JSON.stringify([...parsed, ...parsed]) }));
  writeFileSync(join(parent, 'unrelated.tgz'), 'old');
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText }), /unexpected files/);
  rmSync(join(parent, 'unrelated.tgz'));
  const path = join(parent, parsed[0].filename); rmSync(path); symlinkSync(join(parent, 'outside'), path);
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText }));
  assert.ok(existsSync(parent)); assert.equal(readdirSync(parent).length, 1);
});

test('cleanup removes only the privately captured snapshot and refuses unrelated directories', (t) => {
  const f = fixture(t);
  assert.throws(() => cleanupSnapshot(join(f.root, 'package.json')));
  assert.ok(existsSync(join(f.root, 'package.json')));
  cleanupSnapshot(f.snapshotPath);
  assert.equal(existsSync(join(f.snapshotPath, '..')), false);
});

for (const reportText of ['', '{}', '[]', '[null]']) test(`refuses malformed pack JSON ${JSON.stringify(reportText)}`, (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'ashlr-pack-invalid-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText }));
});

test('rejects missing, empty or multiply linked tarballs', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'ashlr-pack-invalid-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const reportText = report(parent); const path = join(parent, `ashlr-hub-${VERSION}.tgz`);
  rmSync(path);
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText }));
  writeFileSync(path, '');
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText }), /empty tarball/);
  rmSync(path); report(parent);
  linkSync(path, join(parent, '..', `${parent.split(/[\\/]/).at(-1)}-hardlink`));
  const linked = join(parent, '..', `${parent.split(/[\\/]/).at(-1)}-hardlink`);
  t.after(() => rmSync(linked, { force: true }));
  assert.throws(() => validatePackReport({ destination: parent, version: VERSION, reportText }), /singly linked/);
});

/* global process, Buffer */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { captureBuild, cleanupSnapshot, observeBuild, packBuild, preparePack, reusePack, validateBuild, validatePackReport, sourceDesktopUpdateProfile } from '../scripts/ci-pack-smoke.mjs';

const hash = (bytes, algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const VERSION = '3.24.2';
function fixture(t, packageName = '@ashlr/hub') {
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
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: packageName, version: VERSION }));
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

function realTar(rows) {
  return gzipSync(Buffer.concat([...rows.flatMap(({ path, bytes = Buffer.alloc(0), mode = 0o644, type = 'File' }) => {
    const block = Buffer.alloc(512);
    new Header({ path, size: bytes.length, mode, uid: 0, gid: 0, mtime: new Date(0), type }).encode(block);
    return [block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
  }), Buffer.alloc(1024)]));
}

function runtimeFixture(t, behavior = '', packageName = '@ashlr/hub') {
  const f = fixture(t, packageName);
  cleanupSnapshot(f.snapshotPath);
  const pkg = { name: packageName, version: VERSION, type: 'module', bin: { ashlr: 'bin/ashlr' }, files: ['bin', 'dist'] };
  writeFileSync(join(f.root, 'package.json'), JSON.stringify(pkg));
  mkdirSync(join(f.root, 'bin'));
  writeFileSync(join(f.root, 'bin/ashlr'), '#!/usr/bin/env node\nthrow new Error("Inert archive launcher must never execute");\n', { mode: 0o755 });
  f.git('add', '.');
  f.git('-c', 'user.name=Pack fixture', '-c', 'user.email=pack@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'runtime fixture');
  const eventSha = f.git('rev-parse', 'HEAD');
  const identity = { ...f.identity, revision: eventSha };
  f.write('build-identity.json', JSON.stringify(identity));
  const reader = fileURLToPath(new URL('../../dist/core/local-runtime/archive.js', import.meta.url));
  assert.ok(existsSync(reader), 'build the actual core source before the pack-smoke module');
  const trigger = join(f.parent, 'trigger');
  const calls = join(f.parent, 'reader-calls');
  f.write('core/local-runtime/archive.js', `import {readPinnedRuntimeArchive as read} from ${JSON.stringify(pathToFileURL(reader).href)};
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
export async function readPinnedRuntimeArchive(pins) {
  const result = await read(pins);
  appendFileSync(${JSON.stringify(calls)}, 'read\\n');
  if (existsSync(${JSON.stringify(trigger)})) {
    ${behavior === 'source' ? `writeFileSync(${JSON.stringify(join(f.root, 'dist/api/core.js'))}, 'changed while preflight awaited');` : ''}
    ${behavior === 'archive' ? "appendFileSync(pins.artifactPath, 'changed while preflight awaited');" : ''}
  }
  return result;
}
`);
  f.write('core/universe/index.js', 'export const inert = true;\n');
  const snapshotPath = captureBuild({ ...f, eventSha });
  const recordPath = join(dirname(snapshotPath), 'original-pack.json');
  const rows = [
    { path: 'package/package.json', bytes: Buffer.from(JSON.stringify(pkg)) },
    { path: 'package/dist/build-identity.json', bytes: Buffer.from(JSON.stringify(identity)) },
    { path: 'package/bin/ashlr', bytes: readFileSync(join(f.root, 'bin/ashlr')), mode: 0o755 },
    { path: 'package/dist/cli/index.js', bytes: Buffer.from('export const inert = true;\n') },
    { path: 'package/dist/core/universe/index.js', bytes: Buffer.from('export const inert = true;\n') },
  ];
  return { ...f, eventSha, identity, snapshotPath, recordPath, rows, calls, trigger, profile: sourceDesktopUpdateProfile(packageName) };
}

function realReport(destination, rows, packageName = '@ashlr/hub') {
  const profile = sourceDesktopUpdateProfile(packageName);
  const bytes = realTar(rows);
  const filename = `${profile.archivePrefix}-${VERSION}.tgz`;
  writeFileSync(join(destination, filename), bytes);
  return JSON.stringify([{ name: profile.packageName, version: VERSION, filename, size: bytes.length,
    shasum: hash(bytes, 'sha1'), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}` }]);
}

async function prepared(t, behavior) {
  const f = runtimeFixture(t, behavior);
  let npmCalls = 0;
  const recordSha256 = await preparePack({ ...f, runNpm: (_bin, args) => {
    npmCalls++; return realReport(args[4], f.rows);
  } });
  const record = JSON.parse(readFileSync(f.recordPath));
  const path = join(dirname(f.snapshotPath), record.directory, record.filename);
  return { ...f, recordSha256, record, path, npmCalls };
}

test('early pack refuses an owned snapshot inside source before invoking npm', async (t) => {
  const f = runtimeFixture(t);
  const destination = join(f.root, '.git', basename(dirname(f.snapshotPath)));
  renameSync(dirname(f.snapshotPath), destination);
  let npmCalls = 0;
  await assert.rejects(preparePack({ ...f, snapshotPath: join(destination, 'snapshot.json'),
    runNpm: () => { npmCalls++; throw new Error('must not pack inside source'); } }), /outside source/);
  assert.equal(npmCalls, 0);
  assert.deepEqual(readdirSync(destination), ['snapshot.json']);
});

test('early original npm pack uses the actual compiled reader and late reuse never repacks', async (t) => {
  const f = runtimeFixture(t); let npmCalls = 0;
  const userConfig = join(f.parent, 'empty-user-npmrc'); writeFileSync(userConfig, '');
  const globalConfig = join(f.parent, 'empty-global-npmrc'); writeFileSync(globalConfig, '');
  const recordSha256 = await preparePack({ ...f, runNpm: (bin, args, options) => {
    npmCalls++;
    // Real local npm pack with lifecycle/network off and empty task-owned config.
    return execFileSync(bin, args, { ...options, env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      HOME: join(f.parent, 'home'), USERPROFILE: join(f.parent, 'home'), LANG: 'C', LC_ALL: 'C',
      NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(f.parent, 'npm-cache'), NPM_CONFIG_OFFLINE: 'true' } });
  } });
  const path = await reusePack({ ...f, recordSha256 }); const before = readFileSync(path);
  assert.equal(await reusePack({ ...f, recordSha256 }), path);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(npmCalls, 1);
  assert.equal(readFileSync(f.calls, 'utf8').split('\n').filter(Boolean).length, 3);
  assert.equal(lstatSync(f.recordPath).mode & 0o777, 0o400);
  await assert.rejects(preparePack({ ...f, runNpm: () => { npmCalls++; throw new Error('must never pack twice'); } }), /already exists/);
  assert.equal(npmCalls, 1);
  const prior = process.env.ASHLR_PACK_SMOKE_RECORD_SHA256;
  process.env.ASHLR_PACK_SMOKE_RECORD_SHA256 = recordSha256;
  try { cleanupSnapshot(f.snapshotPath); } finally {
    if (prior === undefined) delete process.env.ASHLR_PACK_SMOKE_RECORD_SHA256;
    else process.env.ASHLR_PACK_SMOKE_RECORD_SHA256 = prior;
  }
  assert.equal(existsSync(dirname(f.snapshotPath)), false);
});

test('sealed cleanup refuses a replaced tarball and preserves its bytes', async (t) => {
  const f = await prepared(t);
  const replacement = join(f.parent, 'replacement');
  const bytes = readFileSync(f.path); writeFileSync(replacement, bytes); renameSync(replacement, f.path);
  const identity = lstatSync(f.path).ino;
  const prior = process.env.ASHLR_PACK_SMOKE_RECORD_SHA256;
  process.env.ASHLR_PACK_SMOKE_RECORD_SHA256 = f.recordSha256;
  try { assert.throws(() => cleanupSnapshot(f.snapshotPath), /identity changed/); } finally {
    if (prior === undefined) delete process.env.ASHLR_PACK_SMOKE_RECORD_SHA256;
    else process.env.ASHLR_PACK_SMOKE_RECORD_SHA256 = prior;
  }
  assert.equal(lstatSync(f.path).ino, identity);
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(existsSync(f.snapshotPath), true);
  assert.equal(existsSync(f.recordPath), true);
});

for (const kind of ['changed', 'truncated', 'missing', 'new inode', 'symlink', 'hardlink', 'mode', 'directory swap']) {
  test(`late reuse refuses ${kind} original tarball without fallback`, async (t) => {
    const f = await prepared(t);
    if (kind === 'changed') writeFileSync(f.path, Buffer.concat([readFileSync(f.path), Buffer.from('changed')]));
    if (kind === 'truncated') writeFileSync(f.path, readFileSync(f.path).subarray(0, 32));
    if (kind === 'missing') rmSync(f.path);
    if (kind === 'new inode') { const copy = join(f.parent, 'replacement'); writeFileSync(copy, readFileSync(f.path)); renameSync(copy, f.path); }
    if (kind === 'symlink') { const copy = join(f.parent, 'original'); renameSync(f.path, copy); symlinkSync(copy, f.path); }
    if (kind === 'hardlink') linkSync(f.path, join(f.parent, 'linked'));
    if (kind === 'mode') chmodSync(f.path, 0o700);
    if (kind === 'directory swap') {
      const before = lstatSync(f.path).ino; const old = join(f.parent, 'old-pack');
      renameSync(dirname(f.path), old); mkdirSync(dirname(f.path), { mode: 0o700 });
      renameSync(join(old, f.record.filename), f.path); assert.equal(lstatSync(f.path).ino, before);
    }
    await assert.rejects(reusePack(f), kind === 'directory swap' ? /pack directory changed/ : undefined);
    assert.equal(f.npmCalls, 1);
    assert.equal(readFileSync(f.calls, 'utf8'), 'read\n');
  });
}

for (const kind of ['record digest', 'record path', 'record root', 'extra field', 'missing digest', 'source', 'snapshot', 'snapshot directory']) {
  test(`late reuse refuses ${kind} binding changes`, async (t) => {
    const f = await prepared(t);
    if (['record digest', 'record path', 'record root', 'extra field'].includes(kind)) {
      const record = { ...f.record };
      if (kind === 'record digest') record.size++;
      if (kind === 'record path') record.directory = '../source';
      if (kind === 'record root') record.root = f.parent;
      if (kind === 'extra field') record.unbound = true;
      chmodSync(f.recordPath, 0o600); const bytes = Buffer.from(JSON.stringify(record));
      writeFileSync(f.recordPath, bytes); chmodSync(f.recordPath, 0o400);
      if (kind !== 'record digest') f.recordSha256 = hash(bytes, 'sha256');
    }
    if (kind === 'missing digest') f.recordSha256 = undefined;
    if (kind === 'source') writeFileSync(join(f.root, 'package.json'), '{}');
    if (kind === 'snapshot') { chmodSync(f.snapshotPath, 0o600); writeFileSync(f.snapshotPath, '{}'); chmodSync(f.snapshotPath, 0o400); }
    if (kind === 'snapshot directory') {
      const directory = dirname(f.snapshotPath), old = join(f.parent, 'old-snapshot');
      renameSync(directory, old); mkdirSync(directory, { mode: 0o700 });
      for (const name of readdirSync(old)) renameSync(join(old, name), join(directory, name));
    }
    await assert.rejects(reusePack(f));
    assert.equal(f.npmCalls, 1);
    assert.deepEqual(readFileSync(f.path), realTar(f.rows));
  });
}

for (const when of ['early', 'late']) for (const behavior of ['source', 'archive']) {
  test(`${when} preflight refuses ${behavior} drift across the actual reader await`, async (t) => {
    if (when === 'late') {
      const f = await prepared(t, behavior); writeFileSync(f.trigger, 'drift');
      await assert.rejects(reusePack(f)); assert.equal(f.npmCalls, 1);
    } else {
      const f = runtimeFixture(t, behavior); writeFileSync(f.trigger, 'drift'); let calls = 0;
      await assert.rejects(preparePack({ ...f, runNpm: (_bin, args) => { calls++; return realReport(args[4], f.rows); } }));
      assert.equal(calls, 1); assert.equal(existsSync(f.recordPath), false);
      assert.deepEqual(readdirSync(dirname(f.snapshotPath)), ['snapshot.json']);
    }
  });
}

for (const kind of ['too many entries', 'non-file', 'reader export', 'missing record']) {
  test(`real early preflight refuses ${kind} without publishing a record or retry`, async (t) => {
    const f = runtimeFixture(t); let calls = 0;
    if (kind === 'missing record') {
      await assert.rejects(reusePack({ ...f, recordSha256: 'a'.repeat(64) }));
    } else {
      if (kind === 'reader export') {
        f.write('core/local-runtime/archive.js', 'export const wrong = true;');
        cleanupSnapshot(f.snapshotPath); f.snapshotPath = captureBuild(f);
        f.recordPath = join(dirname(f.snapshotPath), 'original-pack.json');
      }
      const rows = [...f.rows];
      if (kind === 'too many entries') for (let i = rows.length; i <= 20_000; i++) rows.push({ path: `package/files/${i}.bin` });
      if (kind === 'non-file') rows[0] = { ...rows[0], type: 'Directory' };
      await assert.rejects(preparePack({ ...f, runNpm: (_bin, args) => {
        calls++; return realReport(args[4], rows);
      } }), kind === 'too many entries' ? /entry count/ : undefined);
      assert.equal(calls, 1);
    }
    assert.equal(existsSync(f.recordPath), false);
  });
}

test('workflow packs once before complete suites and retains exact late consumer/capture gates', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const early = workflow.match(/- name: Capture pack smoke build snapshot[\s\S]*?(?=\n {6}- name:)/)[0];
  const late = workflow.match(/- name: Pack smoke \(exports map\)[\s\S]*?(?=\n {6}- name:)/)[0];
  assert.ok(early.includes("if: matrix.label == 'ubuntu, authority 1/3'"));
  assert.ok(early.includes('ci-pack-smoke.mjs prepare "$snapshot"'));
  assert.ok(early.includes('ASHLR_PACK_SMOKE_RECORD_SHA256'));
  assert.ok(workflow.indexOf('ci-pack-smoke.mjs prepare') < workflow.indexOf('- name: Test web operator console'));
  assert.ok(workflow.indexOf('ci-pack-smoke.mjs prepare') < workflow.indexOf('- name: Test (hermetic)'));
  assert.ok(!/ci-pack-smoke\.mjs pack\b|npm pack/.test(late.replace(/#.*/g, '')));
  assert.equal((late.match(/ci-pack-smoke\.mjs reuse/g) ?? []).length, 2);
  for (const contract of ['npm install "$TARBALL"', './node_modules/.bin/ashlr help', "import('@ashlr/hub/types')",
    "import('@ashlr/hub/core')", 'ci-pack-smoke.mjs verify "$ASHLR_PACK_SMOKE_SNAPSHOT"',
    '--package-tarball "$TARBALL"', '--reports "${{ steps.web.outputs.lane_dir }}"']) assert.ok(late.includes(contract));
});


test('source bootstrap profiles exactly match the qualified compiled descriptor and reject other identities', async () => {
  const core = await import(new URL('../../dist/core/desktop/update-manifest.js', import.meta.url));
  for (const name of ['@ashlr/hub', '@ashlr/phantom']) {
    assert.deepEqual(sourceDesktopUpdateProfile(name), core.desktopUpdateProfileForPackage(name));
    assert.equal(Object.isFrozen(sourceDesktopUpdateProfile(name)), true);
  }
  for (const name of [undefined, null, {}, 'constructor', '@other/phantom', '@ashlr/phantom-beta']) assert.throws(() => sourceDesktopUpdateProfile(name));
});

test('canonical clean source prepares and reuses the same real archive with the canonical compiled reader profile', async t => {
  const f = runtimeFixture(t, '', '@ashlr/phantom'); let calls = 0;
  const recordSha256 = await preparePack({...f, runNpm: (_bin, args) => {calls++; return realReport(args[4], f.rows, '@ashlr/phantom');}});
  const record = JSON.parse(readFileSync(f.recordPath)), original = readFileSync(join(dirname(f.snapshotPath), record.directory, record.filename));
  assert.equal(record.filename, `ashlr-phantom-${VERSION}.tgz`);
  assert.equal(record.source.packageSha256, hash(readFileSync(join(f.root, 'package.json')), 'sha256'));
  assert.deepEqual(Object.keys(record.source).sort(), ['identity', 'packageSha256']);
  const path = await reusePack({...f, recordSha256});
  assert.deepEqual(readFileSync(path), original); assert.equal(calls, 1); assert.equal(readFileSync(f.calls, 'utf8'), 'read\nread\n');
});

for (const packageName of ['@ashlr/hub', '@ashlr/phantom']) test(`pack refuses the other identity tuple for source ${packageName} without sealing/repacking`, async t => {
  const f = runtimeFixture(t, '', packageName); let calls = 0;
  const other = packageName === '@ashlr/hub' ? '@ashlr/phantom' : '@ashlr/hub';
  await assert.rejects(preparePack({...f, runNpm: (_bin, args) => {calls++; return realReport(args[4], f.rows, other);}}));
  assert.equal(calls, 1); assert.equal(existsSync(f.recordPath), false); assert.equal(existsSync(f.calls), false);
});

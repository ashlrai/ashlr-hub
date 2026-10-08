#!/usr/bin/env node
/* global process, console */
// Same-job pack smoke only: observe the successful build before tests, then
// refuse stale/mutated output rather than invoke prepack's second whole build.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuildIdentity } from '../../scripts/build-identity.mjs';

const REQUIRED = [
  'build-identity.json', 'authority-surface.json', 'release-dependency-inventory.json',
  'cli/index.js', 'api/core.js', 'api/types.js',
  'core/sandbox/claude-broker-tool-worker.js', 'core/sandbox/claude-broker-tool-invocation.js',
];
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

function regular(path, maxBytes) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= maxBytes,
    `expected bounded regular, singly linked file: ${path}`);
  return stat;
}

function source(root, eventSha) {
  assert.match(eventSha ?? '', /^[a-f0-9]{40}$/, 'missing exact event SHA');
  const identity = createBuildIdentity({ repoRoot: root });
  assert.equal(identity.provenance, 'git');
  assert.equal(identity.revision, eventSha, 'checkout differs from event SHA');
  assert.equal(identity.dirty, false, 'source changed after build');
  regular(join(root, 'package.json'), 1024 * 1024);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@ashlr/hub');
  assert.equal(identity.packageVersion, pkg.version);
  regular(join(root, 'dist/build-identity.json'), 1024 * 1024);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'dist/build-identity.json'), 'utf8')),
    identity, 'build identity is stale or uncommissioned');
  return { identity, packageSha256: digest(readFileSync(join(root, 'package.json'))) };
}

export function observeBuild(root, eventSha) {
  root = realpathSync(root);
  const binding = source(root, eventSha);
  const dist = join(root, 'dist');
  assert.equal(realpathSync(dist), dist, 'dist must be canonical');
  const entries = [];
  let bytes = 0;
  function walk(path, relative, depth) {
    assert.ok(depth <= 48 && entries.length < 100_000, 'build snapshot traversal exceeds bounds');
    const before = lstatSync(path);
    if (before.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode: before.mode & 0o7777 });
      for (const name of readdirSync(path).sort()) walk(join(path, name), relative ? `${relative}/${name}` : name, depth + 1);
    } else {
      regular(path, 128 * 1024 * 1024);
      const content = readFileSync(path);
      bytes += content.length;
      assert.ok(bytes <= 512 * 1024 * 1024, 'build snapshot exceeds byte bound');
      entries.push({ path: relative, type: 'file', mode: before.mode & 0o7777,
        bytes: content.length, sha256: digest(content) });
    }
    const after = lstatSync(path);
    assert.ok(before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
      before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    'build output changed while observed');
  }
  walk(dist, '', 0);
  for (const path of REQUIRED) assert.ok(entries.some((entry) => entry.path === path && entry.type === 'file'),
    `missing built artifact: ${path}`);
  assert.deepEqual(source(root, eventSha), binding, 'source changed while observed');
  return { schemaVersion: 1, root, source: binding, dist: entries };
}

export function captureBuild({ root, eventSha, parent }) {
  const observed = observeBuild(root, eventSha);
  const owned = mkdtempSync(join(realpathSync(parent), 'ashlr-pack-build-'));
  const path = join(owned, 'snapshot.json');
  writeFileSync(path, `${JSON.stringify(observed)}\n`, { flag: 'wx', mode: 0o400 });
  return path;
}

export function cleanupSnapshot(snapshotPath) {
  const parent = resolve(snapshotPath, '..');
  const before = lstatSync(parent);
  assert.ok(before.isDirectory() && !before.isSymbolicLink() && (before.mode & 0o777) === 0o700);
  assert.ok(basename(parent).startsWith('ashlr-pack-build-'));
  assert.equal(realpathSync(parent), parent);
  assert.equal(basename(snapshotPath), 'snapshot.json');
  const names = readdirSync(parent).sort();
  if (names.includes('original-pack.json')) {
    const { record } = readPackRecord(snapshotPath, process.env.ASHLR_PACK_SMOKE_RECORD_SHA256);
    const destination = packDirectory(parent, record.directory);
    assert.deepEqual(directoryIdentity(privateDirectory(destination)), record.directoryIdentity, 'original pack directory changed');
    assert.deepEqual(names, [record.directory, 'original-pack.json', 'snapshot.json'].sort());
    assert.deepEqual(readdirSync(destination), [record.filename]);
    readRecordedPack(join(destination, record.filename), record);
  } else assert.deepEqual(names, ['snapshot.json']);
  regular(snapshotPath, 32 * 1024 * 1024);
  const after = lstatSync(parent);
  assert.ok(before.dev === after.dev && before.ino === after.ino && before.uid === after.uid);
  rmSync(parent, { recursive: true });
}

export function validateBuild({ root, eventSha, snapshotPath }) {
  regular(snapshotPath, 32 * 1024 * 1024);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(Object.keys(snapshot).sort(), ['dist', 'root', 'schemaVersion', 'source']);
  assert.equal(snapshot.schemaVersion, 1);
  const observed = observeBuild(root, eventSha);
  assert.deepEqual(snapshot, observed, 'build output differs from successful same-job build');
  return observed;
}

export function validatePackReport({ reportText, destination, version }) {
  const report = JSON.parse(reportText);
  assert.ok(Array.isArray(report) && report.length === 1, 'expected one npm pack result');
  const row = report[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row), 'invalid npm pack record');
  assert.equal(row.name, '@ashlr/hub');
  assert.equal(row.version, version);
  assert.equal(typeof row.filename, 'string');
  assert.equal(row.filename, `ashlr-hub-${version}.tgz`);
  assert.equal(basename(row.filename), row.filename, 'tarball filename must be a basename');
  assert.ok(!row.filename.includes('/') && !row.filename.includes('\\') && !row.filename.includes('\0'));
  destination = realpathSync(destination);
  assert.deepEqual(readdirSync(destination), [row.filename], 'pack destination contains unexpected files');
  const path = join(destination, row.filename);
  const stat = regular(path, 128 * 1024 * 1024);
  assert.equal(realpathSync(path), path);
  assert.ok(stat.size > 0, 'empty tarball');
  assert.equal(stat.size, row.size);
  const bytes = readFileSync(path);
  assert.equal(digest(bytes, 'sha1'), row.shasum);
  assert.equal(`sha512-${digest(bytes, 'sha512', 'base64')}`, row.integrity);
  return path;
}

function packObserved({ root, eventSha, snapshotPath, runNpm = execFileSync }, observed, destination) {
  const reportText = runNpm('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const path = validatePackReport({ reportText, destination, version: observed.source.identity.packageVersion });
  validateBuild({ root, eventSha, snapshotPath });
  return path;
}

export function packBuild({ root, eventSha, snapshotPath, parent, runNpm = execFileSync }) {
  root = realpathSync(root);
  const observed = validateBuild({ root, eventSha, snapshotPath });
  // Newly owned/private destination is outside the source tree. No wildcard,
  // old tarball, user-provided report path or lifecycle execution is admitted.
  const destination = mkdtempSync(join(realpathSync(parent), 'ashlr-pack-tarball-'));
  assert.ok(!destination.startsWith(`${root}${sep}`), 'pack destination must be outside source');
  return packObserved({ root, eventSha, snapshotPath, runNpm }, observed, destination);
}

const HASH = /^[a-f0-9]{64}$/;
const sameFile = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
  .every((key) => a[key] === b[key]);
const fileIdentity = (stat) => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
  .map((key) => [key, stat[key].toString()]));
const directoryIdentity = (stat) => Object.fromEntries(['dev', 'ino', 'uid', 'mode']
  .map((key) => [key, stat[key].toString()]));

function privateDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && typeof process.getuid === 'function' &&
    stat.uid === BigInt(process.getuid()) && (stat.mode & 0o7777n) === 0o700n, 'expected owned private directory');
  assert.equal(realpathSync(path), path, 'private directory is not canonical');
  return stat;
}

function readStable(path, limit, mode) {
  assert.equal(realpathSync(path), path, 'file path is not canonical');
  const before = lstatSync(path, { bigint: true });
  assert.ok(before.isFile() && before.nlink === 1n && typeof process.getuid === 'function' &&
    before.uid === BigInt(process.getuid()) && before.size > 0n && before.size <= BigInt(limit), 'unsafe original pack file');
  if (mode !== undefined) assert.equal(before.mode & 0o7777n, BigInt(mode), 'private file mode differs');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.ok(sameFile(before, fstatSync(fd, { bigint: true })), 'file changed before opened');
    const bytes = readFileSync(fd);
    assert.equal(BigInt(bytes.length), before.size);
    assert.ok(sameFile(before, fstatSync(fd, { bigint: true })) && sameFile(before, lstatSync(path, { bigint: true })),
      'file changed while read');
    return { bytes, identity: fileIdentity(before) };
  } finally { closeSync(fd); }
}

function ownedSnapshot(snapshotPath) {
  assert.equal(basename(snapshotPath), 'snapshot.json');
  const parent = dirname(snapshotPath);
  assert.ok(basename(parent).startsWith('ashlr-pack-build-'));
  privateDirectory(parent);
  return { parent, identity: directoryIdentity(privateDirectory(parent)), snapshot: readStable(snapshotPath, 32 * 1024 * 1024, 0o400) };
}

function packDirectory(parent, name) {
  assert.match(name, /^ashlr-pack-tarball-[a-zA-Z0-9]{6}$/);
  const path = join(parent, name);
  privateDirectory(path);
  return path;
}

function readPackRecord(snapshotPath, expectedSha256) {
  assert.match(expectedSha256 ?? '', HASH, 'missing original pack record digest');
  const { parent, identity, snapshot } = ownedSnapshot(snapshotPath);
  const { bytes } = readStable(join(parent, 'original-pack.json'), 64 * 1024, 0o400);
  assert.equal(digest(bytes), expectedSha256, 'original pack record changed');
  const record = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['directory', 'directoryIdentity', 'fileIdentity', 'filename', 'integrity', 'root',
    'schemaVersion', 'sha256', 'size', 'snapshotDirectoryIdentity', 'snapshotSha256', 'source'].sort());
  assert.equal(record.schemaVersion, 1);
  assert.deepEqual(record.snapshotDirectoryIdentity, identity, 'original snapshot directory changed');
  assert.equal(record.snapshotSha256, digest(snapshot.bytes), 'original build snapshot changed');
  assert.match(record.sha256, HASH);
  assert.ok(Number.isSafeInteger(record.size) && record.size > 0 && record.size <= 64 * 1024 * 1024);
  assert.equal(record.filename, `ashlr-hub-${record.source.identity.packageVersion}.tgz`);
  assert.equal(basename(record.filename), record.filename);
  assert.deepEqual(readdirSync(parent).sort(), [record.directory, 'original-pack.json', 'snapshot.json'].sort());
  return { parent, record };
}

function readRecordedPack(path, record) {
  const captured = readStable(path, 64 * 1024 * 1024);
  assert.deepEqual(captured.identity, record.fileIdentity, 'original tarball identity changed');
  assert.equal(captured.bytes.length, record.size);
  assert.equal(digest(captured.bytes), record.sha256, 'original tarball bytes changed');
  assert.equal(`sha512-${digest(captured.bytes, 'sha512', 'base64')}`, record.integrity);
  return captured;
}

async function validateRuntimePackage(options, observed, path, captured) {
  const readerPath = 'core/local-runtime/archive.js';
  assert.ok(observed.dist.some((entry) => entry.path === readerPath && entry.type === 'file'), 'compiled runtime archive reader is missing');
  // This is the already-built producer checkout, never an attestor/candidate-package import.
  const module = await import(pathToFileURL(join(options.root, 'dist', readerPath)).href);
  validateBuild(options);
  assert.equal(typeof module.readPinnedRuntimeArchive, 'function', 'compiled runtime archive reader export is missing');
  const pins = { artifactPath: path, sha256: digest(captured.bytes),
    revision: observed.source.identity.revision, version: observed.source.identity.packageVersion };
  const archive = await module.readPinnedRuntimeArchive(pins);
  assert.equal(archive.pins.sha256, pins.sha256);
  assert.equal(archive.pins.size, captured.bytes.length);
  assert.equal(archive.pins.revision, pins.revision);
  assert.equal(archive.pins.version, pins.version);
  validateBuild(options);
  assert.deepEqual(readStable(path, 64 * 1024 * 1024), captured, 'original tarball changed during archive preflight');
}

/** One lifecycle-off original pack before expensive tests; no serialized authority proof. */
export async function preparePack({ root, eventSha, snapshotPath, runNpm = execFileSync }) {
  root = realpathSync(root);
  const options = { root, eventSha, snapshotPath };
  const observed = validateBuild(options);
  const { parent, identity, snapshot } = ownedSnapshot(snapshotPath);
  assert.ok(parent !== root && !parent.startsWith(`${root}${sep}`), 'pack destination must be outside source');
  assert.deepEqual(readdirSync(parent), ['snapshot.json'], 'original pack already exists or snapshot directory changed');
  const destination = mkdtempSync(join(parent, 'ashlr-pack-tarball-'));
  const owned = privateDirectory(destination);
  try {
    const path = packObserved({ ...options, runNpm }, observed, destination);
    const captured = readStable(path, 64 * 1024 * 1024);
    await validateRuntimePackage(options, observed, path, captured);
    assert.deepEqual(readStable(snapshotPath, 32 * 1024 * 1024, 0o400), snapshot, 'snapshot changed during preflight');
    assert.deepEqual(directoryIdentity(privateDirectory(parent)), identity, 'snapshot directory changed during preflight');
    assert.deepEqual(directoryIdentity(privateDirectory(destination)), directoryIdentity(owned), 'pack directory changed during preflight');
    const record = { schemaVersion: 1, root, snapshotDirectoryIdentity: identity, snapshotSha256: digest(snapshot.bytes), source: observed.source,
      directory: basename(destination), directoryIdentity: directoryIdentity(owned), filename: basename(path), size: captured.bytes.length,
      sha256: digest(captured.bytes), integrity: `sha512-${digest(captured.bytes, 'sha512', 'base64')}`,
      fileIdentity: captured.identity };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    writeFileSync(join(parent, 'original-pack.json'), bytes, { flag: 'wx', mode: 0o400 });
    return digest(bytes);
  } catch (error) {
    // Remove only this still-owned exact directory, never a substituted path.
    const current = privateDirectory(destination);
    assert.ok(current.dev === owned.dev && current.ino === owned.ino, 'failed pack directory was replaced');
    assert.ok(readdirSync(destination).every((name) => name === `ashlr-hub-${observed.source.identity.packageVersion}.tgz`),
      'failed pack directory contains unrelated files');
    rmSync(destination, { recursive: true });
    throw error;
  }
}

/** Fresh same-job validation; never repack or substitute another archive on refusal. */
export async function reusePack({ root, eventSha, snapshotPath, recordSha256 }) {
  root = realpathSync(root);
  const options = { root, eventSha, snapshotPath };
  const observed = validateBuild(options);
  const { parent, record } = readPackRecord(snapshotPath, recordSha256);
  assert.ok(parent !== root && !parent.startsWith(`${root}${sep}`), 'pack destination must be outside source');
  assert.equal(record.root, root);
  assert.deepEqual(record.source, observed.source, 'original pack source differs');
  const destination = packDirectory(parent, record.directory);
  assert.deepEqual(directoryIdentity(privateDirectory(destination)), record.directoryIdentity, 'original pack directory changed');
  assert.deepEqual(readdirSync(destination), [record.filename]);
  const path = join(destination, record.filename);
  const captured = readRecordedPack(path, record);
  await validateRuntimePackage(options, observed, path, captured);
  readPackRecord(snapshotPath, recordSha256);
  assert.deepEqual(directoryIdentity(privateDirectory(destination)), record.directoryIdentity, 'original pack directory changed during preflight');
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, operand, extra] = process.argv.slice(2);
    assert.equal(extra, undefined, 'unexpected operand');
    assert.ok(operand, 'missing operand');
    const options = { root: process.cwd(), eventSha: process.env.ASHLR_CI_SOURCE_SHA ?? process.env.GITHUB_SHA };
    let path;
    if (command === 'capture') path = captureBuild({ ...options, parent: operand });
    else if (command === 'pack') path = packBuild({ ...options, snapshotPath: operand, parent: process.env.RUNNER_TEMP });
    else if (command === 'prepare') path = await preparePack({ ...options, snapshotPath: operand });
    else if (command === 'reuse') path = await reusePack({ ...options, snapshotPath: operand,
      recordSha256: process.env.ASHLR_PACK_SMOKE_RECORD_SHA256 });
    else if (command === 'verify') {
      validateBuild({ ...options, snapshotPath: operand });
      path = 'same-job build unchanged';
    } else if (command === 'cleanup') {
      cleanupSnapshot(operand);
      path = 'owned build snapshot removed';
    } else assert.fail('expected capture, prepare, reuse, pack, verify or cleanup');
    console.log(path);
  } catch (error) {
    console.error(`pack smoke refused: ${error.message}`);
    process.exitCode = 1;
  }
}

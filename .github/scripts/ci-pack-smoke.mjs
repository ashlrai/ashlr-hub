#!/usr/bin/env node
/* global process, console */
// Same-job pack smoke only: observe the successful build before tests, then
// refuse stale/mutated output rather than invoke prepack's second whole build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  assert.deepEqual(readdirSync(parent), ['snapshot.json']);
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

export function packBuild({ root, eventSha, snapshotPath, parent, runNpm = execFileSync }) {
  root = realpathSync(root);
  const observed = validateBuild({ root, eventSha, snapshotPath });
  // Newly owned/private destination is outside the source tree. No wildcard,
  // old tarball, user-provided report path or lifecycle execution is admitted.
  const destination = mkdtempSync(join(realpathSync(parent), 'ashlr-pack-tarball-'));
  assert.ok(!destination.startsWith(`${root}${sep}`), 'pack destination must be outside source');
  const reportText = runNpm('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const path = validatePackReport({ reportText, destination, version: observed.source.identity.packageVersion });
  validateBuild({ root, eventSha, snapshotPath });
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
    else if (command === 'verify') {
      validateBuild({ ...options, snapshotPath: operand });
      path = 'same-job build unchanged';
    } else if (command === 'cleanup') {
      cleanupSnapshot(operand);
      path = 'owned build snapshot removed';
    } else assert.fail('expected capture, pack, verify or cleanup');
    console.log(path);
  } catch (error) {
    console.error(`pack smoke refused: ${error.message}`);
    process.exitCode = 1;
  }
}

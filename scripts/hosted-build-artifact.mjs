#!/usr/bin/env node
// This is an artifact transport, not native/signing authority. A local full
// release remains the fallback whenever hosted provenance or coverage refuses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { observeBuild, validateBuild, sourceDesktopUpdateProfile } from '../.github/scripts/ci-pack-smoke.mjs';
import { requireProducerEnvironment, requireManifestProducer, requireRepositoryMetadata, requireRepositoryReference } from '../.github/scripts/github-repository-binding.mjs';
import { readBoundedJson } from './verify-npm-release-provenance.mjs';

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE = MAX_BYTES + 100_000 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const admissions = new WeakMap();
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((k) => a[k] === b[k]);
const command = (bin, args, cwd) => execFileSync(bin, args, { cwd, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
const git = (root, args) => command('git', args, root).trim();

function regular(path, max = MAX_ARCHIVE) {
  const stat = fs.lstatSync(path);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= max, 'expected bounded, singly linked regular file');
  return stat;
}
function boundedBytes(path, max = MAX_ARCHIVE) {
  assert.equal(fs.realpathSync(path), resolve(path), 'file path contains a symlink');
  const before = regular(path, max);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    assert.ok(same(before, fs.fstatSync(fd)), 'file changed before opened');
    const bytes = fs.readFileSync(fd);
    assert.ok(bytes.length === before.size && same(before, fs.fstatSync(fd)) && same(before, regular(path, max)), 'file changed during read');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function safePath(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 255 &&
    !/[\\:]/.test(path) && ![...path].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127) && !path.startsWith('/') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..'), 'unsafe archive path');
  return path;
}
function safeMode(mode, type) {
  assert.ok(Number.isInteger(mode) && mode >= 0 && mode <= 0o777 && (mode & 0o022) === 0,
    'unsafe build mode');
  assert.ok(type === 'file' || type === 'directory', 'unsupported entry type');
}

/** Every tracked blob/mode is bound by Git; explicit SHA256 rows make drift
 * diagnostics readable without treating a hand-picked closure as full source. */
export function sourceBinding(root, expectedSha) {
  root = fs.realpathSync(root);
  assert.match(expectedSha, SHA);
  assert.equal(git(root, ['rev-parse', 'HEAD']), expectedSha, 'source revision differs');
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=normal']), '', 'source is dirty');
  assert.ok(git(root, ['ls-files', '-v', '-z']).split('\0').filter(Boolean).every((row) => row.startsWith('H ')), 'hidden index/worktree changes refused');
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']); assert.match(tree, SHA);
  const tracked = git(root, ['ls-tree', '-rz', '--full-tree', 'HEAD']).split('\0').filter(Boolean).map((row) => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/s.exec(row);
    assert.ok(match && match[2] === 'blob', 'submodules are not admitted');
    return { path: match[4], mode: match[1], blob: match[3] };
  });
  const inputs = tracked.filter(({ path }) => path === 'package.json' || /(?:^|\/)(?:package-lock\.json|.*\.lock|.*config\.[^/]+|tier1-closure\.json)$/.test(path) ||
    path.startsWith('.github/workflows/') || path.startsWith('scripts/') || path.startsWith('.github/scripts/'))
    .map((row) => ({ ...row, sha256: sha(boundedBytes(join(root, row.path), 32 * 1024 * 1024)) }));
  return { revision: expectedSha, tree, tracked, inputs };
}

function header(entry) {
  const out = Buffer.alloc(512); const path = safePath(entry.path);
  let name = path, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const splits = [...path.matchAll(/\//g)].map((m) => m.index).reverse();
    const at = splits.find((i) => Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100);
    assert.ok(at !== undefined, 'path does not fit canonical USTAR'); prefix = path.slice(0, at); name = path.slice(at + 1);
  }
  const put = (value, at, length) => { assert.ok(Buffer.byteLength(value) <= length); out.write(value, at, length, 'utf8'); };
  const octal = (n, width) => { const s = n.toString(8); assert.ok(s.length < width); return `${s.padStart(width - 1, '0')}\0`; };
  put(name, 0, 100); put(octal(entry.mode, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(entry.bytes ?? 0, 12), 124, 12); put(octal(0, 12), 136, 12); out.fill(32, 148, 156);
  out[156] = entry.type === 'directory' ? 53 : 48; put('ustar\0', 257, 6); put('00', 263, 2); put(prefix, 345, 155);
  const sum = out.reduce((a, b) => a + b, 0); put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return out;
}

/** Strict producer-owned USTAR only: no PAX, links, devices, sparse files or
 * system tar extraction. Header canonicality closes alternate-name encodings. */
export function inspectTar(bytes, expected, visit) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= MAX_ARCHIVE && bytes.length % 512 === 0, 'invalid archive size');
  const entries = []; const names = new Set(); let at = 0, total = 0;
  const text = (b, start, end) => b.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
  while (at + 512 <= bytes.length) {
    const h = bytes.subarray(at, at + 512); at += 512;
    if (h.every((n) => n === 0)) { assert.ok(bytes.length - at >= 512 && bytes.subarray(at).every((n) => n === 0), 'invalid archive terminator'); break; }
    assert.ok(entries.length < 100_000, 'too many archive entries');
    const name = text(h, 0, 100), prefix = text(h, 345, 500); const path = safePath(prefix ? `${prefix}/${name}` : name);
    assert.ok(!names.has(path), 'duplicate archive member'); names.add(path);
    const type = h[156] === 48 ? 'file' : h[156] === 53 ? 'directory' : null;
    const modeText = text(h, 100, 108), sizeText = text(h, 124, 136);
    assert.match(modeText, /^[0-7]{7}$/); assert.match(sizeText, /^[0-7]{11}$/);
    const mode = Number.parseInt(modeText, 8), size = Number.parseInt(sizeText, 8); safeMode(mode, type);
    assert.ok(size <= MAX_BYTES && (type !== 'directory' || size === 0) && at + size <= bytes.length, 'invalid member size');
    const data = bytes.subarray(at, at + size); total += size; assert.ok(total <= MAX_BYTES, 'archive byte bound exceeded');
    const entry = { path, type, mode, ...(type === 'file' ? { bytes: size, sha256: sha(data) } : {}) };
    assert.ok(header(entry).equals(h), 'noncanonical or corrupt archive header');
    const padded = Math.ceil(size / 512) * 512;
    assert.ok(bytes.subarray(at + size, at + padded).every((n) => n === 0), 'nonzero member padding'); at += padded;
    entries.push(entry); if (visit) visit(entry, data);
  }
  assert.ok(at < bytes.length && entries.length > 0, 'missing archive terminator');
  if (expected) assert.deepEqual(entries, expected, 'archive membership/bytes/modes differ');
  return entries;
}

function npmMembers(path) {
  // npm owns this archive format; inspect only (never extract/execute it).
  const bytes = gunzipSync(boundedBytes(path, 128 * 1024 * 1024), { maxOutputLength: MAX_ARCHIVE });
  const entries = []; let at = 0, extendedPath = null, terminated = false; const names = new Set();
  const text = (b, s, e) => b.subarray(s, e).toString('utf8').replace(/\0.*$/s, '');
  while (at + 512 <= bytes.length) {
    const h = bytes.subarray(at, at + 512); at += 512; if (h.every((b) => b === 0)) { terminated = true; break; }
    const recorded = Number.parseInt(text(h, 148, 156).trim(), 8); const check = Buffer.from(h); check.fill(32, 148, 156);
    assert.equal(check.reduce((a, b) => a + b, 0), recorded, 'npm tar header checksum mismatch');
    const mode = Number.parseInt(text(h, 100, 108), 8), size = Number.parseInt(text(h, 124, 136), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && at + size <= bytes.length, 'invalid npm member size');
    if (h[156] === 120) {
      assert.ok(extendedPath === null && size <= 16 * 1024, 'nested/oversized npm PAX metadata');
      const payload = bytes.subarray(at, at + size); let offset = 0;
      while (offset < payload.length) {
        const space = payload.indexOf(32, offset); assert.ok(space > offset);
        const lengthText = payload.subarray(offset, space).toString(); assert.match(lengthText, /^[1-9][0-9]*$/);
        const length = Number(lengthText); assert.ok(length <= 8192 && offset + length <= payload.length && payload[offset + length - 1] === 10);
        const record = payload.subarray(space + 1, offset + length - 1).toString('utf8'); const eq = record.indexOf('=');
        assert.ok(eq > 0); const key = record.slice(0, eq), value = record.slice(eq + 1);
        assert.ok(['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'SCHILY.dev', 'SCHILY.ino', 'SCHILY.nlink'].includes(key), 'unsupported npm PAX field');
        if (key === 'path') { assert.equal(extendedPath, null, 'duplicate npm PAX path'); extendedPath = safePath(value); }
        offset += length;
      }
      at += Math.ceil(size / 512) * 512; continue;
    }
    const prefix = text(h, 345, 500), name = text(h, 0, 100);
    const path = extendedPath ?? safePath((prefix ? `${prefix}/` : '') + name.replace(/\/$/, '')); extendedPath = null;
    assert.ok(path.startsWith('package/') && !names.has(path), 'unexpected npm member'); names.add(path);
    const type = h[156] === 48 || h[156] === 0 ? 'file' : h[156] === 53 ? 'directory' : null; safeMode(mode, type);
    assert.ok(type !== 'directory' || size === 0, 'npm directory contains payload');
    assert.ok(Number.isSafeInteger(size) && size >= 0 && at + size <= bytes.length && entries.length < 100_000, 'invalid npm member');
    const data = bytes.subarray(at, at + size); entries.push({ path, type, mode, ...(type === 'file' ? { bytes: size, sha256: sha(data) } : {}) });
    at += Math.ceil(size / 512) * 512;
  }
  assert.ok(entries.length && terminated && bytes.length - at >= 512 && extendedPath === null && bytes.subarray(at).every((b) => b === 0), 'invalid npm tar termination');
  return entries;
}

function matchPackage(root, entries, dist) {
  const files = new Map(entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
  assert.equal(files.get('package/package.json')?.sha256, sha(boundedBytes(join(root, 'package.json'), 1024 * 1024)), 'package source identity differs');
  for (const entry of dist.filter((entry) => entry.type === 'file')) {
    const packaged = files.get(`package/${entry.path}`);
    assert.ok(packaged && ['bytes', 'sha256', 'mode'].every((key) => packaged[key] === entry[key]), 'package/build bytes or modes differ');
  }
  for (const entry of files.values()) if (entry.path.startsWith('package/dist/')) {
    assert.ok(dist.some((row) => `package/${row.path}` === entry.path && row.type === 'file'), 'package has unexpected built file');
  }
}

export function npmCliPath() {
  const base = dirname(fs.realpathSync(process.execPath));
  const candidates = [process.env.npm_execpath, join(base, '../lib/node_modules/npm/bin/npm-cli.js'), join(base, 'node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const path = candidates.find((candidate) => fs.existsSync(candidate) && candidate.replace(/\\/g, '/').endsWith('/npm/bin/npm-cli.js'));
  assert.ok(path, 'cannot bind the actual npm CLI'); return fs.realpathSync(path);
}
function toolBinding(root) {
  const executable = fs.realpathSync(process.execPath);
  const npm = npmCliPath();
  const graph = JSON.parse(command(process.execPath, [npm, 'ls', '--all', '--json'], root));
  const pkg = JSON.parse(boundedBytes(join(root, 'package.json'), 1024 * 1024));
  assert.equal(graph.name, pkg.name); assert.equal(graph.version, pkg.version);
  assert.ok(!graph.problems?.length && !graph.error, 'installed npm dependency graph is invalid');
  return { node: { version: process.version, sha256: sha(boundedBytes(executable, 256 * 1024 * 1024)) },
    npm: { version: command(process.execPath, [npm, '--version']).trim(), sha256: sha(boundedBytes(npm, 8 * 1024 * 1024)) },
    platform: process.platform, arch: process.arch, dependencyGraph: { sha256: sha(Buffer.from(JSON.stringify(graph))), graph } };
}
function verifyToolRecord(root, tools) {
  const version = /^v22\.(\d+)\.(\d+)$/.exec(tools?.node?.version ?? ''); assert.ok(version && Number(version[1]) >= 15, 'unsupported producer Node');
  assert.match(tools.node.sha256 ?? '', HASH); assert.match(tools.npm?.version ?? '', /^\d+\.\d+\.\d+$/); assert.match(tools.npm.sha256 ?? '', HASH);
  assert.ok(['linux', 'darwin'].includes(tools.platform) && ['x64', 'arm64'].includes(tools.arch), 'unsupported producer platform');
  const pkg = JSON.parse(boundedBytes(join(root, 'package.json'), 1024 * 1024)); const graph = tools.dependencyGraph?.graph;
  assert.equal(graph?.name, pkg.name); assert.equal(graph?.version, pkg.version); assert.ok(!graph.problems?.length && !graph.error);
  assert.equal(sha(Buffer.from(JSON.stringify(graph))), tools.dependencyGraph.sha256, 'dependency graph digest differs');
}

export function captureArtifact({ root, sha: revision, out, snapshot, packageTarball, reports = [], tools = toolBinding }) {
  root = fs.realpathSync(root); out = resolve(out);
  assert.ok(!fs.existsSync(out), 'artifact output already exists');
  const binding = sourceBinding(root, revision);
  const observed = validateBuild({ root, eventSha: revision, snapshotPath: snapshot });
  const packageSource = boundedBytes(join(root, 'package.json'), 1024 * 1024);
  assert.equal(sha(packageSource), observed.source.packageSha256, 'source package changed');
  const profile = sourceDesktopUpdateProfile(JSON.parse(packageSource).name);
  const producer = { ...requireProducerEnvironment(process.env), runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB,
    eventSha: process.env.ASHLR_CI_EVENT_SHA ?? process.env.GITHUB_SHA };
  assert.equal(producer.repository, profile.repository, 'source package and producer repository differ');
  for (const field of ['runId', 'runAttempt']) assert.match(producer[field] ?? '', /^[1-9][0-9]*$/);
  assert.match(producer.repository ?? '', /^[\w.-]+\/[\w.-]+$/); assert.match(producer.eventSha ?? '', SHA);
  assert.ok(producer.job && (process.env.ASHLR_CI_SOURCE_SHA ?? process.env.GITHUB_SHA) === revision, 'capture requires exact CI checkout identity');
  const entries = observed.dist.map((entry) => ({ ...entry, path: entry.path ? `dist/${entry.path}` : 'dist' }));
  for (const entry of entries) { safePath(entry.path); safeMode(entry.mode, entry.type); }
  const tarParts = [];
  for (const entry of entries) {
    tarParts.push(header(entry));
    if (entry.type === 'file') {
      const bytes = boundedBytes(join(root, entry.path), 128 * 1024 * 1024);
      assert.equal(sha(bytes), entry.sha256); tarParts.push(bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
  }
  tarParts.push(Buffer.alloc(1024)); const archive = Buffer.concat(tarParts);
  inspectTar(archive, entries);
  const packageBytes = boundedBytes(packageTarball, 128 * 1024 * 1024);
  const packageEntries = npmMembers(packageTarball); matchPackage(root, packageEntries, entries);
  const coverageFiles = [];
  for (const path of reports) {
    const lane = readBoundedJson(path); assert.equal(lane.role, 'web', 'producer embeds web lane only');
    coverageFiles.push({ path: 'coverage/web/lane.json', data: boundedBytes(path, 32 * 1024 * 1024) });
    for (const report of lane.reports) {
      assert.equal(report.file, 'web.json'); const data = boundedBytes(join(dirname(path), 'reports', report.file), 32 * 1024 * 1024);
      assert.equal(sha(data), report.sha256); assert.equal(data.length, report.bytes);
      coverageFiles.push({ path: `coverage/web/reports/${report.file}`, data });
    }
  }
  assert.equal(new Set(coverageFiles.map((file) => file.path)).size, coverageFiles.length, 'duplicate coverage files');
  const manifest = { schemaVersion: 2, source: binding, producer, tools: tools(root),
    buildIdentity: observed.source.identity, archive: { filename: 'dist.tar', bytes: archive.length, sha256: sha(archive), entries },
    package: { filename: `${profile.archivePrefix}-${observed.source.identity.packageVersion}.tgz`, bytes: packageBytes.length,
      sha256: sha(packageBytes), entries: packageEntries },
    coverage: coverageFiles.map((file) => ({ path: file.path, sha256: sha(file.data), bytes: file.data.length })) };
  assert.deepEqual(observeBuild(root, revision), observed); assert.deepEqual(sourceBinding(root, revision), binding);
  fs.mkdirSync(out, { mode: 0o700 });
  try {
    fs.writeFileSync(join(out, 'dist.tar'), archive, { flag: 'wx', mode: 0o400 });
    fs.writeFileSync(join(out, manifest.package.filename), packageBytes, { flag: 'wx', mode: 0o400 });
    for (const file of coverageFiles) { fs.mkdirSync(dirname(join(out, file.path)), { recursive: true, mode: 0o700 }); fs.writeFileSync(join(out, file.path), file.data, { flag: 'wx', mode: 0o400 }); }
    fs.writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o400 });
    return manifest;
  } catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
}

/** API evidence is freshly fetched by this function. Test seams can provide
 * official-shaped responses; the CLI never accepts a saved PASS JSON as proof. */
export function auditGithub({ repository, revision, runId, runAttempt, artifactId, artifactName, requiredJobs,
  eventSha, read = (endpoint) => JSON.parse(command('gh', ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', endpoint])) }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/); assert.match(revision, SHA); assert.match(eventSha, SHA);
  for (const id of [runId, runAttempt, artifactId]) assert.ok(Number.isSafeInteger(id) && id > 0);
  assert.ok(Array.isArray(requiredJobs) && requiredJobs.length > 0, 'missing source-owned job policy');
  assert.equal(new Set(requiredJobs.map((job) => job.name)).size, requiredJobs.length, 'duplicate required job');
  const base = `repos/${repository}`;
  requireRepositoryMetadata(repository, read(base));
  const run = read(`${base}/actions/runs/${runId}/attempts/${runAttempt}`);
  requireRepositoryReference(repository, run.repository);
  assert.equal(run.id, runId); assert.equal(run.run_attempt, runAttempt); assert.equal(run.repository?.full_name, repository);
  assert.equal(run.path, '.github/workflows/ci.yml', 'unexpected producer workflow');
  assert.equal(run.head_sha, revision); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.ok(['push', 'pull_request', 'workflow_dispatch'].includes(run.event), 'unexpected CI event');
  const commit = read(`${base}/git/commits/${eventSha}`); assert.equal(commit.sha, eventSha);
  const candidate = read(`${base}/git/commits/${revision}`); assert.equal(candidate.sha, revision);
  assert.equal(commit.tree?.sha, candidate.tree?.sha, 'event merge tree differs from candidate');
  const artifact = read(`${base}/actions/artifacts/${artifactId}`);
  assert.equal(artifact.id, artifactId); assert.equal(artifact.name, artifactName); assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.id, runId); assert.equal(artifact.workflow_run?.head_sha, revision);
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const response = read(`${base}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`);
    assert.ok(Array.isArray(response.jobs) && response.total_count <= 1000); jobs.push(...response.jobs);
    if (jobs.length === response.total_count) break; assert.ok(page < 10 && response.jobs.length === 100, 'incomplete job pagination');
  }
  for (const required of requiredJobs) {
    assert.ok(required.steps?.length > 0); const matches = jobs.filter((job) => job.name === required.name);
    assert.equal(matches.length, 1, 'required job missing or ambiguous'); const job = matches[0];
    assert.equal(job.run_id, runId); assert.equal(job.head_sha, revision);
    assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
    assert.ok(required.labels?.length > 0 && required.labels.every((label) => job.labels?.includes(label)) &&
      !job.labels.includes('self-hosted'), 'unexpected runner labels');
    for (const name of required.steps) {
      const steps = job.steps.filter((step) => step.name === name); assert.equal(steps.length, 1, 'required step missing/ambiguous');
      assert.equal(steps[0].status, 'completed'); assert.equal(steps[0].conclusion, 'success');
    }
  }
  return { runId, runAttempt, revision, tree: candidate.tree.sha, eventSha, artifactId, artifactDigest: artifact.digest,
    jobs: requiredJobs.map((required) => ({ name: required.name, id: jobs.find((job) => job.name === required.name).id })) };
}

export function verifyAttestation({ path, repository, attestorSha, attestorRun, attestorAttempt,
  run = command }) {
  assert.match(attestorSha, SHA);
  assert.ok(Number.isSafeInteger(attestorRun) && attestorRun > 0 && Number.isSafeInteger(attestorAttempt) && attestorAttempt > 0);
  const workflow = '.github/workflows/attest-ci-build.yml';
  const bytes = boundedBytes(path);
  const result = JSON.parse(run('gh', ['attestation', 'verify', path, '--repo', repository,
    '--hostname', 'github.com', '--signer-workflow', `${repository}/${workflow}`,
    '--source-digest', attestorSha, '--source-ref', 'refs/heads/master',
    '--deny-self-hosted-runners', '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json']));
  assert.ok(Array.isArray(result) && result.length > 0 && result.length <= 100, 'no verified attestation');
  const expectedInvocation = `https://github.com/${repository}/actions/runs/${attestorRun}/attempts/${attestorAttempt}`;
  const matches = result.map((row) => row.verificationResult?.statement).filter((statement) =>
    statement?._type === 'https://in-toto.io/Statement/v1' && statement.predicateType === 'https://slsa.dev/provenance/v1' &&
    statement.subject?.some((subject) => subject.digest?.sha256 === sha(bytes)) &&
    statement.predicate?.runDetails?.metadata?.invocationId === expectedInvocation);
  assert.ok(matches.length > 0, 'attestation does not bind expected subject/run/attempt');
  assert.ok(boundedBytes(path).equals(bytes), 'attested file changed during verification');
  return { sha256: sha(bytes), invocation: expectedInvocation };
}

const ROLES = ['web', 'mac-general-1', 'mac-general-2', 'mac-general-3', 'mac-general-4', 'mac-isolated'];
export function requiredJobPolicy(root) {
  const workflow = boundedBytes(join(root, '.github/workflows/ci.yml'), 1024 * 1024).toString();
  const jobs = [];
  for (const [label, os] of [
    ['ubuntu, authority 1/3', 'ubuntu-latest'], ['ubuntu, authority 2/3', 'ubuntu-latest'], ['ubuntu, authority 3/3', 'ubuntu-latest'],
    ['windows, portability 1/3', 'windows-latest'], ['windows, portability 2/3', 'windows-latest'],
    ['windows, portability 3/3', 'windows-latest'], ['windows, portability overflow', 'windows-latest'],
    ['macos, shared queue authority', 'macos-latest'],
  ]) {
    assert.ok(workflow.includes(`label: ${label}`), 'required matrix role removed');
    const steps = ['Bind candidate source', 'Install dependencies', 'Check generated authority ownership (hermetic)', 'Build', 'Test (hermetic)'];
    if (label === 'ubuntu, authority 1/3') steps.push('Capture pack smoke build snapshot', 'Test web operator console', 'Pack smoke (exports map)', 'Upload qualified build handoff');
    if (label === 'ubuntu, authority 3/3') steps.push('Typecheck', 'Lint', 'Check documentation', 'Test complete dispatch production ledger (hermetic)');
    if (label === 'windows, portability 2/3') steps.push('Test native alias authority (hermetic)');
    if (label === 'windows, portability 1/3') steps.push('Test native path and lifecycle authority (hermetic)');
    if (label === 'windows, portability overflow') steps.push('Test native ACL enrollment fences (hermetic)');
    if (label === 'macos, shared queue authority') steps.push('Test native alias authority (hermetic)', 'Test npm runtime snapshot authority (hermetic)', 'Clean disposable native launchd fixture');
    jobs.push({ name: `CI (Node 22, ${label})`, labels: [os], steps });
  }
  for (let shard = 1; shard <= 4; shard++) jobs.push({ name: `Mac exhaustive (${shard}/4)`, labels: ['macos-15'], steps:
    ['Bind candidate source', 'Install dependencies', 'Build', 'Test complete Mac general partition', 'Upload Mac qualification'] });
  jobs.push({ name: 'Mac exhaustive (isolated)', labels: ['macos-15'], steps:
    ['Bind candidate source', 'Install dependencies', 'Build', 'Test complete Mac isolated suites', 'Upload Mac qualification'] });
  jobs.push({ name: 'Native macOS broker foundation (Rust 1.97.1)', labels: ['macos-latest'], steps:
    ['Bind candidate source', 'Check native broker formatting', 'Check native broker library', 'Lint native broker library', 'Test native broker library', 'Remove disposable Tauri sidecar fixture'] });
  jobs.push({ name: 'Windows service authority (Server 2022)', labels: ['windows-2022'], steps:
    ['Bind candidate source', 'Install dependencies', 'Build hardened inventory', 'Test npm runtime snapshot authority (hermetic)', 'Test native Windows service authority (hermetic)'] });
  for (const step of new Set(jobs.flatMap((job) => job.steps))) assert.ok(workflow.includes(`name: ${step}\n`), 'required workflow step removed');
  return jobs;
}

function officialArtifact(read, repository, runId, revision, expectedName, ref) {
  assert.ok(Number.isSafeInteger(ref.id) && ref.id > 0);
  const actual = read(`repos/${repository}/actions/artifacts/${ref.id}`);
  assert.equal(actual.id, ref.id); assert.equal(actual.name, expectedName); assert.equal(ref.name, expectedName);
  assert.equal(actual.digest, ref.digest); assert.match(actual.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(actual.expired, false); assert.equal(actual.workflow_run?.id, runId); assert.equal(actual.workflow_run?.head_sha, revision);
  return { artifactId: actual.id, artifactDigest: actual.digest };
}

export function qualifyArtifact({ root, revision, bundle, artifactMap, runId: requestedRun, runAttempt: requestedAttempt, read = (endpoint) => JSON.parse(command('gh', ['api', '--hostname', 'github.com', endpoint])) }) {
  root = fs.realpathSync(root); bundle = fs.realpathSync(bundle);
  assert.ok(!fs.existsSync(join(bundle, 'qualification.json')), 'qualification already exists');
  const manifestPath = join(bundle, 'manifest.json'); const manifest = readBoundedJson(manifestPath);
  safePath(manifest.package.filename); assert.ok(!manifest.package.filename.includes('/'), 'package filename must be basename');
  const source = sourceBinding(root, revision); assert.deepEqual(manifest.source, source);
  verifyToolRecord(root, manifest.tools);
  const producer = manifest.producer; requireManifestProducer(manifest.schemaVersion, producer);
  const repositoryBinding = requireRepositoryMetadata(producer.repository, read(`repos/${producer.repository}`));
  const runId = Number(producer.runId), runAttempt = Number(producer.runAttempt);
  assert.equal(runId, requestedRun); assert.equal(runAttempt, requestedAttempt);
  const expectedName = `ashlr-build-${runId}-${runAttempt}`;
  const producerArtifact = officialArtifact(read, producer.repository, runId, revision, expectedName, artifactMap.producer);
  const official = auditGithub({ repository: producer.repository, revision, eventSha: producer.eventSha, runId, runAttempt,
    artifactId: producerArtifact.artifactId, artifactName: expectedName, requiredJobs: requiredJobPolicy(root), read });
  assert.equal(official.tree, source.tree);
  assert.deepEqual(artifactMap.lanes.map((r) => r.role).sort(), ROLES.filter((role) => role !== 'web').sort());
  const lanes = ROLES.map((role) => {
    const path = `coverage/${role}/lane.json`; const bytes = boundedBytes(join(bundle, path), 32 * 1024 * 1024);
    const ref = role === 'web' ? producerArtifact : officialArtifact(read, producer.repository, runId, revision,
      `ashlr-qualification-${role}-${runId}-${runAttempt}`, artifactMap.lanes.find((row) => row.role === role));
    return { role, ...ref, path, sha256: sha(bytes), bytes: bytes.length };
  });
  const closure = validateCoverage({ root, bundle, source, producer, lanes });
  for (const file of manifest.coverage) assert.ok(closure.some((row) => row.path === file.path && row.sha256 === file.sha256 && row.bytes === file.bytes), 'producer coverage differs');
  const archive = boundedBytes(join(bundle, 'dist.tar')); assert.equal(sha(archive), manifest.archive.sha256); inspectTar(archive, manifest.archive.entries);
  const tgz = boundedBytes(join(bundle, manifest.package.filename), 128 * 1024 * 1024); assert.equal(sha(tgz), manifest.package.sha256);
  assert.deepEqual(npmMembers(join(bundle, manifest.package.filename)), manifest.package.entries); matchPackage(root, manifest.package.entries, manifest.archive.entries);
  const qualification = { schemaVersion: manifest.schemaVersion, ...(manifest.schemaVersion === 2 ? { repositoryBinding } : {}), candidate: { revision, tree: source.tree }, producer: { runId, runAttempt, eventSha: producer.eventSha, ...producerArtifact },
    subjects: { manifestSha256: sha(boundedBytes(manifestPath)), archiveSha256: sha(archive), packageSha256: sha(tgz) }, lanes, closure, official };
  assert.deepEqual(sourceBinding(root, revision), source);
  assert.deepEqual(requireRepositoryMetadata(producer.repository, read(`repos/${producer.repository}`)), repositoryBinding, 'repository identity changed during qualification');
  fs.writeFileSync(join(bundle, 'qualification.json'), `${JSON.stringify(qualification)}\n`, { flag: 'wx', mode: 0o400 });
  return qualification;
}
export function isolatedScope(root) {
  const source = boundedBytes(join(root, 'scripts/test-ci-sharded.mjs'), 1024 * 1024).toString();
  const body = /const isolatedSuites = \[([\s\S]*?)\];/.exec(source)?.[1]; assert.ok(body, 'missing literal isolation list');
  const literal = body.replace(/\/\/[^\n]*/g, '').replace(/\s/g, '');
  assert.match(literal, /^(?:'test\/[\w./-]+\.test\.ts',)+$/, 'isolation list is not literal');
  const suites = [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const marker = /const isolatedAcceptance = '(test\/[\w./-]+\.test\.ts)';/.exec(source)?.[1];
  assert.ok(marker && suites.length === 12 && new Set(suites).size === suites.length);
  return { suites, marker };
}

/** Compare the actual Vitest JSON to the small lane projection. This does not
 * pretend to independently recollect cases: trusted fixed source invocations,
 * whole module inventory, and raw counters are the collection authority. */
export function validateCoverage({ root, bundle, source, producer, lanes }) {
  assert.equal(lanes.length, ROLES.length); assert.deepEqual(lanes.map((lane) => lane.role).sort(), [...ROLES].sort());
  const { suites, marker } = isolatedScope(root); const excluded = new Set([...suites, marker]);
  const generalFiles = new Set(); const webFiles = new Set(); const markerReports = []; const closure = [];
  for (const ref of lanes) {
    const expectedPath = `coverage/${ref.role}/lane.json`; assert.equal(ref.path, expectedPath); safePath(ref.path);
    const laneBytes = boundedBytes(join(bundle, ref.path), 32 * 1024 * 1024);
    assert.equal(sha(laneBytes), ref.sha256); assert.equal(laneBytes.length, ref.bytes);
    const lane = readBoundedJson(join(bundle, ref.path)); assert.equal(lane.schemaVersion, 1); assert.equal(lane.role, ref.role);
    assert.deepEqual(lane.source, { revision: source.revision, tree: source.tree, eventSha: producer.eventSha });
    assert.equal(Number(lane.run?.id), Number(producer.runId)); assert.equal(Number(lane.run?.attempt), Number(producer.runAttempt));
    assert.match(lane.nodeVersion ?? '', /^v22\./); assert.equal(lane.exitCode, 0);
    assert.ok(Number.isFinite(Date.parse(lane.startedAt)) && Date.parse(lane.finishedAt) >= Date.parse(lane.startedAt));
    const expectedFiles = ref.role === 'web' ? ['web.json'] : ref.role === 'mac-isolated' ?
      Array.from({ length: 14 }, (_, i) => `isolated-${String(i + 1).padStart(2, '0')}.json`) : [`general-${ref.role.at(-1)}-of-4.json`];
    assert.deepEqual(lane.reports.map((r) => r.file), expectedFiles);
    const laneModules = [];
    for (const report of lane.reports) {
      const path = `coverage/${ref.role}/reports/${report.file}`;
      const rawBytes = boundedBytes(join(bundle, path), 32 * 1024 * 1024);
      assert.equal(sha(rawBytes), report.sha256); assert.equal(rawBytes.length, report.bytes);
      const raw = readBoundedJson(join(bundle, path)); assert.equal(raw.success, true); assert.equal(raw.numFailedTests, 0); assert.equal(raw.numFailedTestSuites, 0);
      assert.ok(Array.isArray(raw.testResults) && raw.testResults.length > 0 && report.modules.length > 0);
      const actual = raw.testResults.map((module) => {
        assert.ok(!module.message && module.status === 'passed', 'failed Vitest module');
        const matches = report.modules.filter((m) => module.name === m.file || module.name.replace(/\\/g, '/').endsWith(`/${m.file}`));
        assert.equal(matches.length, 1, 'raw module has no unique source-relative binding'); const file = safePath(matches[0].file);
        assert.ok(source.tracked.some((entry) => entry.path === file), 'module not in candidate source');
        assert.ok(module.assertionResults.length > 0);
        const occurrences = new Map();
        const cases = module.assertionResults.map((row) => {
          assert.ok(typeof row.fullName === 'string' && row.fullName.length && ['passed', 'skipped', 'todo'].includes(row.status) && !(row.failureMessages?.length), 'failed/invalid raw case');
          const occurrence = occurrences.get(row.fullName) ?? 0; occurrences.set(row.fullName, occurrence + 1);
          return { id: sha(Buffer.from(`${file}\0${row.fullName}\0${occurrence}`)), name: row.fullName, state: row.status };
        });
        assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'duplicate case ID');
        return { file, cases };
      });
      assert.deepEqual(actual, report.modules, 'lane case projection differs from actual report');
      const cases = actual.flatMap((m) => m.cases); assert.equal(cases.length, raw.numTotalTests);
      assert.equal(cases.filter((c) => c.state === 'passed').length, raw.numPassedTests);
      assert.equal(cases.filter((c) => c.state === 'skipped').length, raw.numPendingTests);
      assert.equal(cases.filter((c) => c.state === 'todo').length, raw.numTodoTests ?? 0);
      assert.ok(cases.some((c) => c.state === 'passed'), 'zero successful cases');
      if (ref.role === 'mac-isolated') {
        const index = lane.reports.indexOf(report); const expected = index < suites.length ? suites[index] : marker;
        assert.deepEqual(actual.map((m) => m.file), [expected]); if (expected === marker) markerReports.push(actual[0]);
      }
      if (ref.role.startsWith('mac-general-')) for (const module of actual) {
        assert.ok(!excluded.has(module.file) && !generalFiles.has(module.file), 'duplicate or isolated general module'); generalFiles.add(module.file);
      }
      if (ref.role === 'web') for (const module of actual) { assert.ok(!webFiles.has(module.file), 'duplicate web module'); webFiles.add(module.file); }
      laneModules.push(...actual); closure.push({ path, bytes: report.bytes, sha256: report.sha256 });
    }
    assert.ok(laneModules.length > 0); closure.push({ path: expectedPath, bytes: ref.bytes, sha256: ref.sha256 });
  }
  assert.equal(markerReports.length, 2);
  const config = boundedBytes(join(root, 'vitest.config.ts'), 1024 * 1024).toString();
  assert.ok(config.includes("include: ['test/**/*.test.ts']"), 'backend collection contract changed');
  const base = /const BASE_EXCLUDE = \[([\s\S]*?)\];/.exec(config)?.[1]?.replace(/\/\/[^\n]*/g, '').replace(/\s/g, '');
  assert.equal(base, "'**/node_modules/**','**/dist/**','myapp/**','**/.ashlrcode/**',", 'backend exclusion contract changed');
  const expectedGeneral = source.tracked.map((entry) => entry.path).filter((path) => /^test\/.*\.test\.ts$/.test(path) &&
    !/(?:^|\/)(?:node_modules|dist|\.ashlrcode)\//.test(path) && !excluded.has(path)).sort();
  assert.deepEqual([...generalFiles].sort(), expectedGeneral, 'Mac full module inventory incomplete');
  const webConfig = boundedBytes(join(root, 'vitest.config.web.ts'), 1024 * 1024).toString();
  assert.ok(webConfig.includes("include: ['src/web-ui/**/*.test.{ts,tsx}']"), 'web collection contract changed');
  const expectedWeb = source.tracked.map((entry) => entry.path).filter((path) => /^src\/web-ui\/.*\.test\.(?:ts|tsx)$/.test(path) &&
    !/(?:^|\/)(?:node_modules|dist)\//.test(path)).sort();
  assert.deepEqual([...webFiles].sort(), expectedWeb, 'web full module inventory incomplete');
  assert.deepEqual(markerReports[0].cases.map(({ id, name }) => ({ id, name })), markerReports[1].cases.map(({ id, name }) => ({ id, name })), 'marker case inventory differs');
  const markerPassed = new Set(); for (const report of markerReports) for (const c of report.cases) if (c.state === 'passed') {
    assert.ok(!markerPassed.has(c.id), 'marker case executed twice'); markerPassed.add(c.id);
  }
  return closure;
}

/** Verification returns an in-process capability; serialized receipts cannot
 * authorize adoption. The committed caller owns the required-job policy. */
function verifyArtifactBody({ root, revision, bundle, policy, githubRead, attestRun }, checkMaster) {
  root = fs.realpathSync(root); bundle = fs.realpathSync(bundle);
  const manifestPath = join(bundle, 'manifest.json'); const manifestBytes = boundedBytes(manifestPath, 32 * 1024 * 1024);
  const qualificationPath = join(bundle, 'qualification.json'); const qualificationBytes = boundedBytes(qualificationPath, 32 * 1024 * 1024);
  const manifest = JSON.parse(manifestBytes.toString('utf8')); const qualification = JSON.parse(qualificationBytes.toString('utf8'));
  requireManifestProducer(manifest.schemaVersion, manifest.producer);
  assert.equal(qualification.schemaVersion, manifest.schemaVersion, 'mixed hosted artifact schemas refused');
  assert.deepEqual(qualification.candidate, { revision, tree: manifest.source.tree });
  const source = sourceBinding(root, revision); assert.deepEqual(manifest.source, source, 'artifact source differs from local checkout');
  verifyToolRecord(root, manifest.tools);
  assert.deepEqual(manifest.buildIdentity, { schemaVersion: 1, packageVersion: JSON.parse(boundedBytes(join(root, 'package.json'))).version,
    revision, dirty: false, provenance: 'git' }, 'build identity differs');
  assert.match(manifest.archive?.sha256 ?? '', HASH); assert.equal(manifest.archive.filename, 'dist.tar');
  const archive = boundedBytes(join(bundle, 'dist.tar')); assert.equal(sha(archive), manifest.archive.sha256); assert.equal(archive.length, manifest.archive.bytes);
  const entries = inspectTar(archive, manifest.archive.entries);
  assert.ok(entries.every((entry) => entry.path === 'dist' || entry.path.startsWith('dist/')), 'archive escapes dist');
  assert.equal(entries[0].path, 'dist'); assert.equal(entries[0].type, 'directory');
  const identities = [];
  inspectTar(archive, entries, (entry, data) => { if (entry.path === 'dist/build-identity.json') identities.push(JSON.parse(data)); });
  assert.deepEqual(identities, [manifest.buildIdentity], 'archive build identity differs');
  safePath(manifest.package.filename); assert.ok(!manifest.package.filename.includes('/'), 'package filename must be basename');
  const tgz = boundedBytes(join(bundle, manifest.package.filename), 128 * 1024 * 1024);
  assert.equal(sha(tgz), manifest.package.sha256); assert.equal(tgz.length, manifest.package.bytes);
  assert.deepEqual(npmMembers(join(bundle, manifest.package.filename)), manifest.package.entries);
  matchPackage(root, manifest.package.entries, entries);
  assert.ok(policy && policy.runId === qualification.producer.runId && policy.runAttempt === qualification.producer.runAttempt, 'unexpected CI identity');
  assert.deepEqual(qualification.subjects, { manifestSha256: sha(boundedBytes(manifestPath)), archiveSha256: sha(archive), packageSha256: sha(tgz) });
  const producer = manifest.producer;
  const read = githubRead ?? ((endpoint) => JSON.parse(command('gh', ['api', '--hostname', 'github.com', endpoint])));
  const repositoryBinding = requireRepositoryMetadata(producer.repository, read(`repos/${producer.repository}`));
  if (manifest.schemaVersion === 2) assert.deepEqual(qualification.repositoryBinding, repositoryBinding, 'qualified repository binding differs');
  assert.equal(Number(producer.runId), policy.runId); assert.equal(Number(producer.runAttempt), policy.runAttempt);
  assert.equal(producer.eventSha, qualification.producer.eventSha);
  const closure = validateCoverage({ root, bundle, source, producer, lanes: qualification.lanes });
  assert.deepEqual(closure, qualification.closure);
  for (const file of manifest.coverage) assert.ok(closure.some((row) => row.path === file.path && row.sha256 === file.sha256 && row.bytes === file.bytes));
  const official = auditGithub({ repository: producer.repository, revision, eventSha: producer.eventSha,
    runId: policy.runId, runAttempt: policy.runAttempt, artifactId: qualification.producer.artifactId,
    artifactName: `ashlr-build-${policy.runId}-${policy.runAttempt}`, requiredJobs: requiredJobPolicy(root), ...(githubRead ? { read: githubRead } : {}) });
  assert.deepEqual(official, qualification.official);
  assert.equal(official.tree, source.tree);
  const base = `repos/${producer.repository}`;
  for (const lane of qualification.lanes) {
    const name = lane.role === 'web' ? `ashlr-build-${policy.runId}-${policy.runAttempt}` : `ashlr-qualification-${lane.role}-${policy.runId}-${policy.runAttempt}`;
    officialArtifact(read, producer.repository, policy.runId, revision, name, { id: lane.artifactId, name, digest: lane.artifactDigest });
  }
  const master = read(`${base}/branches/master`); checkMaster(master, policy);
  const attestorCommit = read(`${base}/git/commits/${policy.attestorSha}`);
  assert.equal(attestorCommit.tree?.sha, source.tree, 'master/candidate tree differs');
  const attestor = read(`${base}/actions/runs/${policy.attestorRun}/attempts/${policy.attestorAttempt}`);
  assert.equal(attestor.id, policy.attestorRun); assert.equal(attestor.run_attempt, policy.attestorAttempt);
  requireRepositoryReference(producer.repository, attestor.repository); assert.equal(attestor.head_sha, policy.attestorSha);
  assert.equal(attestor.event, 'workflow_dispatch'); assert.equal(attestor.path, '.github/workflows/attest-ci-build.yml');
  assert.equal(attestor.status, 'completed'); assert.equal(attestor.conclusion, 'success');
  // Parsed policy and the signer must bind the same initial subject bytes;
  // neither a callback nor the final metadata observation may substitute JSON.
  const subjects = [[join(bundle, 'dist.tar'), sha(archive)], [manifestPath, sha(manifestBytes)], [qualificationPath, sha(qualificationBytes)]];
  const verified = subjects.map(([path, expectedHash]) => {
    const attestation = verifyAttestation({ path, repository: producer.repository,
      attestorSha: policy.attestorSha, attestorRun: policy.attestorRun, attestorAttempt: policy.attestorAttempt, ...(attestRun ? { run: attestRun } : {}) });
    assert.equal(attestation.sha256, expectedHash, 'signed subject differs from initially validated bytes');
    return [path, attestation.sha256];
  });
  assert.deepEqual(requireRepositoryMetadata(producer.repository, read(base)), repositoryBinding, 'repository identity changed during signature verification');
  assert.deepEqual(sourceBinding(root, revision), source);
  for (const [path, verifiedHash] of verified) assert.equal(sha(boundedBytes(path, path === manifestPath || path === qualificationPath ? 32 * 1024 * 1024 : MAX_ARCHIVE)), verifiedHash, 'signed subject changed after verification');
  assert.equal(sha(boundedBytes(join(bundle, manifest.package.filename), 128 * 1024 * 1024)), manifest.package.sha256, 'package changed after verification');
  const receipt = { schemaVersion: manifest.schemaVersion, ...(manifest.schemaVersion === 2 ? { repositoryBinding } : {}), source: { revision, tree: source.tree }, official,
    archiveSha256: verified[0][1], manifestSha256: verified[1][1], qualificationSha256: verified[2][1], packageSha256: manifest.package.sha256,
    attestor: { revision: policy.attestorSha, runId: policy.attestorRun, runAttempt: policy.attestorAttempt } };
  const expected = { manifest: receipt.manifestSha256, qualification: receipt.qualificationSha256, package: receipt.packageSha256 };
  return { receipt: freeze(receipt), admission: { root, source, archive, entries, revision, bundle, manifest, expected } };
}


export function verifyArtifact(input) {
  const { receipt, admission } = verifyArtifactBody(input, (master, policy) => assert.equal(master.commit?.sha, policy.attestorSha, 'attestor is not current trusted master'));
  admissions.set(receipt, admission); return receipt;
}

// Published-manual admission is intentionally separate from hosted adoption.
// Only this fixed implementation can turn a verified public envelope into the
// one-use input below; neither a receipt nor a caller-provided verifier can.
const publications = new WeakMap();
const IMPLEMENTATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function pagedPublicationRead(read, endpoint) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const next = read(`${endpoint}?per_page=100&page=${page}`);
    assert.ok(Array.isArray(next) && next.length <= 100, 'incomplete bounded publication metadata');
    rows.push(...next);
    if (next.length < 100) return rows;
  }
  assert.fail('publication metadata pagination limit');
}

/** These pure assertions do not issue an admission capability. */
export function assertEffectiveManualProtection(repository, branch, rules) {
  assert.equal(branch?.name, 'master'); assert.equal(branch.protected, true);
  assert.match(branch.commit?.sha ?? '', SHA);
  assert.ok(Array.isArray(rules) && rules.length > 0 && rules.length <= 1000, 'effective protection unavailable');
  const required = new Set(['pull_request', 'non_fast_forward', 'deletion']);
  const known = new Set(['creation', 'update', 'deletion', 'required_linear_history', 'required_deployments', 'required_signatures', 'pull_request', 'required_status_checks', 'non_fast_forward', 'commit_message_pattern', 'commit_author_email_pattern', 'committer_email_pattern', 'branch_name_pattern', 'tag_name_pattern', 'file_path_restriction', 'max_file_path_length', 'file_extension_restriction', 'max_file_size', 'required_code_scanning', 'required_workflows', 'merge_queue']);
  const byType = new Map();
  for (const row of rules) {
    assert.ok(row && known.has(row.type) && Number.isSafeInteger(row.ruleset_id) && row.ruleset_id > 0, 'malformed effective rule');
    assert.ok((row.ruleset_source_type === 'Repository' && row.ruleset_source === repository) ||
      (row.ruleset_source_type === 'Organization' && row.ruleset_source === repository.split('/')[0]), 'foreign effective rule');
    if (row.type === 'pull_request') {
      const p = row.parameters;
      assert.ok(p && Number.isSafeInteger(p.required_approving_review_count) && p.required_approving_review_count >= 0 && p.required_approving_review_count <= 100, 'malformed pull request rule');
      for (const key of ['dismiss_stale_reviews_on_push', 'require_code_owner_review', 'require_last_push_approval', 'required_review_thread_resolution']) assert.equal(typeof p[key], 'boolean', 'malformed pull request rule');
      if (p.allowed_merge_methods !== undefined) assert.ok(Array.isArray(p.allowed_merge_methods) && p.allowed_merge_methods.length > 0 &&
        new Set(p.allowed_merge_methods).size === p.allowed_merge_methods.length && p.allowed_merge_methods.every(v => ['merge', 'squash', 'rebase'].includes(v)), 'malformed merge methods');
    }
    if (byType.has(row.type)) assert.deepEqual(row.parameters ?? {}, byType.get(row.type), 'conflicting effective rules');
    else byType.set(row.type, row.parameters ?? {});
    required.delete(row.type);
  }
  assert.equal(required.size, 0, 'insufficient effective protection');
  return branch.commit.sha;
}

export function assertManualAttestorAncestry(attestor, master, comparison) {
  assert.match(attestor, SHA); assert.match(master, SHA);
  assert.equal(comparison?.base_commit?.sha, attestor, 'comparison base differs');
  assert.equal(comparison.merge_base_commit?.sha, attestor, 'attestor is not an ancestor');
  assert.equal(comparison.behind_by, 0, 'master behind attestor');
  assert.ok(Number.isSafeInteger(comparison.ahead_by) && comparison.ahead_by >= 0 && comparison.total_commits === comparison.ahead_by, 'malformed comparison counts');
  if (attestor === master) assert.ok(comparison.status === 'identical' && comparison.ahead_by === 0, 'nonidentical comparison');
  else assert.ok(comparison.status === 'ahead' && comparison.ahead_by > 0, 'nonancestor master');
}

function publicationObservation(manifest, read) {
  const repository = manifest.repository.nameWithOwner, base = `repos/${repository}`, version = manifest.version;
  const identity = requireRepositoryMetadata(repository, read(base));
  const branch = read(`${base}/branches/master`);
  const rules = pagedPublicationRead(read, `${base}/rules/branches/master`);
  const master = assertEffectiveManualProtection(repository, branch, rules);
  const current = read(`${base}/git/commits/${master}`);
  assert.equal(current.sha, master); assert.match(current.tree?.sha ?? '', SHA);
  assertManualAttestorAncestry(manifest.qualification.attestor.revision, master,
    read(`${base}/compare/${manifest.qualification.attestor.revision}...${master}`));
  const release = read(`${base}/releases/tags/v${version}`);
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0 && release.draft === false && release.prerelease === false &&
    release.tag_name === `v${version}` && typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)), 'release is not published stable');
  const allAssets = pagedPublicationRead(read, `${base}/releases/${release.id}/assets`);
  assert.ok(allAssets.every(a => a && Number.isSafeInteger(a.id) && a.id > 0) && new Set(allAssets.map(a => a.id)).size === allAssets.length, 'invalid or duplicate public asset identities');
  const assets = ['manifest.json', 'manifest.json.sig', manifest.app.filename, manifest.cli.filename].map(name => {
    const matches = allAssets.filter(a => a.name === name); assert.equal(matches.length, 1, 'public asset absent or ambiguous');
    const a = matches[0];
    assert.ok(Number.isSafeInteger(a.id) && a.id > 0 && a.state === 'uploaded' && Number.isSafeInteger(a.size) && a.size > 0, 'invalid uploaded asset');
    assert.match(a.digest ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.equal(a.browser_download_url, `https://github.com/${repository}/releases/download/v${version}/${name}`, 'public asset URL differs');
    const artifact = name === manifest.app.filename ? manifest.app : name === manifest.cli.filename ? manifest.cli : null;
    if (artifact) { assert.equal(a.size, artifact.bytes); assert.equal(a.digest, `sha256:${artifact.sha256}`); }
    return { id: a.id, name, size: a.size, digest: a.digest, url: a.browser_download_url };
  });
  const ref = read(`${base}/git/ref/tags/v${version}`); assert.equal(ref.ref, `refs/tags/v${version}`);
  let object = ref.object; const seen = new Set();
  for (let depth = 0; object?.type === 'tag'; depth++) {
    assert.ok(depth < 4 && SHA.test(object.sha) && !seen.has(object.sha), 'invalid release tag chain'); seen.add(object.sha);
    const tag = read(`${base}/git/tags/${object.sha}`); assert.equal(tag.sha, object.sha); object = tag.object;
  }
  assert.ok(object?.type === 'commit' && object.sha === manifest.source.revision, 'published tag differs from signed candidate');
  const commit = read(`${base}/git/commits/${object.sha}`);
  assert.equal(commit.sha, object.sha); assert.equal(commit.tree?.sha, manifest.source.tree, 'published candidate tree differs');
  return JSON.parse(JSON.stringify({ identity, branch, rules, current, release: { id: release.id, tag: release.tag_name, publishedAt: release.published_at }, assets, tag: object.sha }));
}

async function publicationImplementation() {
  const revision = git(IMPLEMENTATION_ROOT, ['rev-parse', 'HEAD']);
  const snapshot = () => ({ source: sourceBinding(IMPLEMENTATION_ROOT, revision), build: observeBuild(IMPLEMENTATION_ROOT, revision) });
  const initial = snapshot();
  const { computeAuthoritySurface } = await import('./authority-surface.mjs');
  const surface = await computeAuthoritySurface({ packageRoot: IMPLEMENTATION_ROOT });
  assert.deepEqual(JSON.parse(boundedBytes(join(IMPLEMENTATION_ROOT, 'dist/authority-surface.json'), 32 * 1024 * 1024)), surface, 'manual verifier compiled authority closure differs');
  const [parser, trust, download] = await Promise.all([
    import('../dist/core/desktop/update-manifest.js'), import('../dist/core/desktop/update-trust.js'), import('../dist/core/desktop/qualified-update.js')]);
  const unchanged = () => assert.deepEqual(snapshot(), initial, 'manual verifier implementation changed');
  unchanged(); return { parser, trust: trust.getDesktopUpdateTrust(), download: download.downloadQualifiedUpdateArtifact, unchanged };
}

/** Fixed own-code loader; only transport reads can be inert in tests. Keys,
 * parsers, profile selection and closure admission are never caller inputs. */
export async function inspectCommissionedManualPublication({ manifestText, signature, githubRead, downloadRead }) {
  assert.ok(typeof manifestText === 'string' && Buffer.byteLength(manifestText) <= 65536 && typeof signature === 'string' && Buffer.byteLength(signature) <= 8192, 'invalid publication envelope');
  const own = await publicationImplementation();
  const verified = own.parser.verifyCompatibleUpdateManifest({ manifestText, signature }, own.trust), manifest = verified.manifest;
  const read = githubRead ?? ((endpoint) => JSON.parse(command('gh', ['api', '--hostname', 'github.com', endpoint])));
  const before = publicationObservation(manifest, read);
  const download = downloadRead ?? own.download;
  for (const [name, expected, maximum] of [['manifest.json', manifestText, 65536], ['manifest.json.sig', signature, 8192]]) {
    const asset = before.assets.find(a => a.name === name), bytes = Buffer.from(await download(asset.url, maximum)); own.unchanged();
    assert.ok(bytes.length <= maximum && bytes.equals(Buffer.from(expected)), 'public envelope differs from local original');
    assert.equal(bytes.length, asset.size); assert.equal(`sha256:${sha(bytes)}`, asset.digest);
  }
  own.parser.verifyCompatibleUpdateManifest({ manifestText, signature }, own.trust);
  assert.deepEqual(publicationObservation(manifest, read), before, 'publication or protection changed during observation'); own.unchanged();
  const capability = Object.freeze({});
  publications.set(capability, { manifest, digest: verified.digest, before, read, unchanged: own.unchanged });
  return capability;
}

export function verifyPublishedManualArtifact(input, capability) {
  const publication = publications.get(capability);
  assert.ok(publication, 'published manual verification requires fresh commissioned capability'); publications.delete(capability);
  const { manifest, before, read, unchanged } = publication, q = manifest.qualification;
  assert.equal(input.revision, manifest.source.revision);
  assert.deepEqual(input.policy, { runId: q.producer.runId, runAttempt: q.producer.runAttempt, attestorSha: q.attestor.revision, attestorRun: q.attestor.runId, attestorAttempt: q.attestor.runAttempt });
  // All original coverage, artifact expiry, attempt and attestation checks run.
  // The sole changed check is the current-master historical relation above.
  const { receipt, admission } = verifyArtifactBody({ ...input, githubRead: read }, master => assert.deepEqual(master, before.branch, 'master moved before original proof'));
  assert.deepEqual(receipt.source, manifest.source);
  for (const key of ['manifestSha256', 'qualificationSha256', 'archiveSha256', 'packageSha256']) assert.equal(receipt[key], q[key], 'published qualification subject differs');
  assert.deepEqual({ runId: receipt.official.runId, runAttempt: receipt.official.runAttempt, eventSha: receipt.official.eventSha }, q.producer);
  assert.equal(admission.manifest.producer.repository, manifest.repository.nameWithOwner);
  assert.deepEqual(publicationObservation(manifest, read), before, 'publication or protection changed during original proof'); unchanged();
  // No hosted admission is registered. Mutable master anchors stay out of the
  // comparable proof so a later coherent descendant observation can succeed.
  return freeze({ ...receipt, publication: { digest: publication.digest, release: before.release, assets: before.assets, tag: before.tag } });
}

function unchangedBundle(admitted) {
  const { bundle, archive, manifest, expected } = admitted;
  assert.ok(boundedBytes(join(bundle, 'dist.tar')).equals(archive));
  assert.equal(sha(boundedBytes(join(bundle, 'manifest.json'))), expected.manifest);
  assert.equal(sha(boundedBytes(join(bundle, 'qualification.json'))), expected.qualification);
  assert.equal(sha(boundedBytes(join(bundle, manifest.package.filename))), expected.package);
}

/** Native compilation may reuse only the exact already-adopted JS bytes after
 * a fresh hosted verification. No saved JSON or unchecked skip-build switch. */
export function validateAdoptedArtifact(receipt) {
  const admitted = admissions.get(receipt); assert.ok(admitted, 'validation requires live verified capability'); admissions.delete(receipt);
  const observed = observeBuild(admitted.root, admitted.revision);
  assert.deepEqual(sourceBinding(admitted.root, admitted.revision), admitted.source);
  assert.deepEqual(observed.source.identity, admitted.manifest.buildIdentity);
  assert.deepEqual(observed.dist.map((entry) => ({ ...entry, path: entry.path ? `dist/${entry.path}` : 'dist' })), admitted.entries, 'adopted build bytes/modes differ');
  unchangedBundle(admitted); return receipt;
}

export function adoptArtifact(receipt) {
  const admitted = admissions.get(receipt); assert.ok(admitted, 'adoption requires live verified capability'); admissions.delete(receipt);
  const { root, source, archive, entries, revision } = admitted;
  assert.ok(!fs.existsSync(join(root, 'dist')), 'dist already exists; local fallback remains untouched');
  const rootBefore = fs.lstatSync(root); assert.ok(rootBefore.isDirectory() && rootBefore.uid === process.getuid() && (rootBefore.mode & 0o022) === 0, 'unsafe source root');
  const stage = fs.mkdtempSync(join(root, '.ashlr-hosted-stage-')); fs.chmodSync(stage, 0o700);
  try {
    inspectTar(archive, entries, (entry, bytes) => {
      const path = join(stage, entry.path);
      if (entry.type === 'directory') fs.mkdirSync(path, { mode: 0o700 });
      else {
        const parent = fs.lstatSync(dirname(path)); assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), 'unsafe staging parent');
        fs.writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); fs.chmodSync(path, entry.mode);
      }
    });
    for (const entry of [...entries].reverse()) if (entry.type === 'directory') fs.chmodSync(join(stage, entry.path), entry.mode);
    const staged = [];
    function observe(path, relative) {
      const stat = fs.lstatSync(path); assert.ok(stat.uid === process.getuid(), 'staging owner differs');
      if (stat.isDirectory()) {
        staged.push({ path: relative, type: 'directory', mode: stat.mode & 0o7777 });
        for (const name of fs.readdirSync(path).sort()) observe(join(path, name), `${relative}/${name}`);
      } else {
        const bytes = boundedBytes(path, 128 * 1024 * 1024);
        staged.push({ path: relative, type: 'file', mode: stat.mode & 0o7777, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
    observe(join(stage, 'dist'), 'dist'); assert.deepEqual(staged, entries, 'staged membership/bytes/modes changed');
    // The owned staging directory is the only permitted temporary dirty path.
    const status = git(root, ['status', '--porcelain', '--untracked-files=normal']);
    assert.ok(status === '' || status === `?? ${stage.slice(root.length + 1)}/`, 'source changed before adoption');
    const trackedStatus = git(root, ['diff', 'HEAD', '--name-only']); assert.equal(trackedStatus, '');
    assert.equal(git(root, ['rev-parse', 'HEAD']), revision); assert.equal(git(root, ['rev-parse', 'HEAD^{tree}']), source.tree);
    unchangedBundle(admitted);
    const rootAfter = fs.lstatSync(root); assert.ok(rootBefore.dev === rootAfter.dev && rootBefore.ino === rootAfter.ino && rootBefore.uid === rootAfter.uid && rootBefore.mode === rootAfter.mode, 'source root changed');
    assert.ok(!fs.existsSync(join(root, 'dist')), 'dist appeared before adoption');
    fs.renameSync(join(stage, 'dist'), join(root, 'dist'));
    return receipt;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [verb, ...argv] = process.argv.slice(2); assert.ok(['capture', 'qualify', 'verify', 'adopt'].includes(verb), 'unknown command');
    const flags = {}; for (let i = 0; i < argv.length; i += 2) {
      assert.ok(['--root', '--sha', '--out', '--snapshot', '--package-tarball', '--reports', '--bundle', '--run', '--attempt', '--artifact-map', '--attestor-sha', '--attestor-run', '--attestor-attempt'].includes(argv[i]) && argv[i + 1] && !flags[argv[i]], 'invalid/duplicate arguments'); flags[argv[i]] = argv[i + 1];
    }
    for (const key of ['--root', '--sha']) assert.ok(flags[key], `missing ${key}`);
    if (verb === 'capture') {
      for (const key of ['--out', '--snapshot', '--package-tarball', '--reports']) assert.ok(flags[key], `missing ${key}`);
      captureArtifact({ root: flags['--root'], sha: flags['--sha'], out: flags['--out'], snapshot: flags['--snapshot'], packageTarball: flags['--package-tarball'], reports: [join(flags['--reports'], 'lane.json')] });
      console.log('hosted build captured; coverage/provenance admission remains separate');
    } else {
      for (const key of ['--bundle', '--run', '--attempt']) assert.ok(flags[key], `missing ${key}`);
      const options = { root: flags['--root'], revision: flags['--sha'], bundle: flags['--bundle'], runId: Number(flags['--run']), runAttempt: Number(flags['--attempt']) };
      if (verb === 'qualify') {
        assert.ok(flags['--artifact-map']); qualifyArtifact({ ...options, artifactMap: readBoundedJson(flags['--artifact-map']) });
        console.log('coverage qualified; signatures and local adoption remain separate');
      } else {
        for (const key of ['--attestor-sha', '--attestor-run', '--attestor-attempt']) assert.ok(flags[key], `missing ${key}`);
        const receipt = verifyArtifact({ ...options, policy: { runId: options.runId, runAttempt: options.runAttempt,
          attestorSha: flags['--attestor-sha'], attestorRun: Number(flags['--attestor-run']), attestorAttempt: Number(flags['--attestor-attempt']) } });
        if (verb === 'adopt') adoptArtifact(receipt); console.log(JSON.stringify(receipt));
      }
    }
  } catch (error) { console.error(`hosted artifact refused: ${error.message}`); process.exitCode = 1; }
}

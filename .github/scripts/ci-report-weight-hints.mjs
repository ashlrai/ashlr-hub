/* global process, console, Buffer */
// Offline scheduling diagnostics only. Saved responses are not release authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { auditGithub, sourceBinding, requiredJobPolicy, validateCoverage } from '../../scripts/hosted-build-artifact.mjs';

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const filePath = value => typeof value === 'string' && /^test\/[A-Za-z0-9_./-]+\.test\.ts$/.test(value) &&
  value.length <= 512 && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Fixed, bounded regular data; no module loading from the evidence checkout. */
function reader() {
  const seen = new Map(); let total = 0;
  const read = (path, max = 32 * 1024 * 1024) => {
    assert.equal(realpathSync(path), resolve(path), 'noncanonical evidence file');
    const before = lstatSync(path);
    assert.ok(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= max, 'unsafe evidence file');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      assert.ok(same(before, fstatSync(fd)), 'evidence changed before read');
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        assert.ok(count > 0, 'evidence truncated during read'); offset += count;
      }
      assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, offset), 0, 'evidence grew during read');
      assert.ok(same(before, fstatSync(fd)) && same(before, lstatSync(path)), 'evidence changed during read');
      const sha256 = digest(bytes); const prior = seen.get(path);
      if (prior) assert.equal(prior.sha256, sha256, 'evidence changed between reads');
      else { total += bytes.length; assert.ok(total <= 256 * 1024 * 1024, 'evidence aggregate too large'); }
      seen.set(path, { sha256, bytes: bytes.length }); return bytes;
    } finally { closeSync(fd); }
  };
  return { read, json: (path, max) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(path, max))),
    finish: () => { for (const [path, record] of seen) assert.equal(digest(read(path)), record.sha256); }, seen };
}

function literalList(text, declaration, pathList) {
  const body = declaration.exec(text)?.[1]; assert.ok(body, 'missing original calibration declaration');
  const literal = body.replace(/\/\/[^\n]*/g, '').replace(/\s/g, '');
  assert.match(literal, /^'[A-Za-z0-9_./-]+'(?:,'[A-Za-z0-9_./-]+')*,?$/, 'unsupported calibration declaration');
  const rows = [...literal.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.equal(new Set(rows).size, rows.length, 'duplicate calibration inputs');
  assert.ok(rows.length > 0 && rows.length <= 20_000 && rows.every(pathList), 'invalid calibration path');
  return rows;
}

export function convertOriginalReportHints(request) {
  assert.ok(exact(request, ['schema', 'root', 'bundle', 'source', 'run', 'manifestSha256', 'qualificationSha256', 'githubSnapshot']), 'invalid conversion request');
  assert.equal(request.schema, 'phantom-original-report-conversion/v1');
  assert.ok(exact(request.source, ['revision', 'tree']) && SHA.test(request.source.revision) && SHA.test(request.source.tree), 'invalid expected source');
  assert.ok(exact(request.run, ['id', 'attempt']) && positive(request.run.id) && positive(request.run.attempt), 'invalid expected run');
  assert.ok(HASH.test(request.manifestSha256) && HASH.test(request.qualificationSha256) &&
    exact(request.githubSnapshot, ['path', 'sha256']) && HASH.test(request.githubSnapshot.sha256), 'missing original evidence pins');
  const root = realpathSync(request.root), bundle = realpathSync(request.bundle);
  assert.equal(root, resolve(request.root)); assert.equal(bundle, resolve(request.bundle));
  const data = reader(); const path = name => join(bundle, name);
  const manifestBytes = data.read(path('manifest.json'));
  const qualificationBytes = data.read(path('qualification.json'));
  assert.equal(digest(manifestBytes), request.manifestSha256, 'manifest pin differs');
  assert.equal(digest(qualificationBytes), request.qualificationSha256, 'qualification pin differs');
  const manifest = JSON.parse(manifestBytes.toString('utf8')), qualification = JSON.parse(qualificationBytes.toString('utf8'));
  const source = sourceBinding(root, request.source.revision);
  assert.equal(source.tree, request.source.tree, 'expected source tree differs');
  assert.deepEqual(manifest.source, source, 'original manifest source differs');
  assert.deepEqual(qualification.candidate, request.source, 'qualification source differs');
  assert.equal(qualification.schemaVersion, manifest.schemaVersion, 'mixed qualification schema');
  assert.equal(qualification.producer.runId, request.run.id); assert.equal(qualification.producer.runAttempt, request.run.attempt);
  assert.equal(Number(manifest.producer.runId), request.run.id); assert.equal(Number(manifest.producer.runAttempt), request.run.attempt);
  assert.equal(qualification.producer.eventSha, manifest.producer.eventSha);
  assert.deepEqual(qualification.subjects, { manifestSha256: request.manifestSha256,
    archiveSha256: manifest.archive.sha256, packageSha256: manifest.package.sha256 }, 'qualification subjects differ');
  assert.ok(HASH.test(manifest.archive.sha256) && HASH.test(manifest.package.sha256));
  const snapshotBytes = data.read(request.githubSnapshot.path, 16 * 1024 * 1024);
  assert.equal(digest(snapshotBytes), request.githubSnapshot.sha256, 'saved GitHub snapshot pin differs');
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  assert.ok(exact(snapshot, ['schema', 'observedAt', 'responses']) && snapshot.schema === 'phantom-recorded-github-api/v1' &&
    iso(snapshot.observedAt) && snapshot.responses && typeof snapshot.responses === 'object' && !Array.isArray(snapshot.responses) &&
    Object.keys(snapshot.responses).length <= 64, 'invalid saved GitHub snapshot');
  const read = endpoint => { assert.ok(Object.hasOwn(snapshot.responses, endpoint), 'saved original API response missing'); return snapshot.responses[endpoint]; };
  const { repository } = manifest.producer;
  const official = auditGithub({ repository, revision: source.revision, eventSha: manifest.producer.eventSha,
    runId: request.run.id, runAttempt: request.run.attempt, artifactId: qualification.producer.artifactId,
    artifactName: `ashlr-build-${request.run.id}-${request.run.attempt}`, requiredJobs: requiredJobPolicy(root), read });
  assert.deepEqual(official, qualification.official, 'saved original official closure differs');
  assert.ok(Array.isArray(qualification.lanes) && new Set(qualification.lanes.map(lane => lane.artifactId)).size === 6, 'original artifact identities not unique');
  for (const ref of qualification.lanes) {
    const artifact = read(`repos/${repository}/actions/artifacts/${ref.artifactId}`);
    const name = ref.role === 'web' ? `ashlr-build-${request.run.id}-${request.run.attempt}` : `ashlr-qualification-${ref.role}-${request.run.id}-${request.run.attempt}`;
    assert.equal(artifact.id, ref.artifactId); assert.equal(artifact.name, name); assert.equal(artifact.digest, ref.artifactDigest);
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(artifact.expired, false); assert.equal(artifact.workflow_run?.id, request.run.id); assert.equal(artifact.workflow_run?.head_sha, source.revision);
  }
  const closure = validateCoverage({ root, bundle, source, producer: manifest.producer, lanes: qualification.lanes });
  assert.deepEqual(closure, qualification.closure, 'original report closure differs');
  for (const file of manifest.coverage) assert.ok(closure.some(row => row.path === file.path && row.bytes === file.bytes && row.sha256 === file.sha256), 'producer report closure differs');
  // Coverage uses the existing fixed reader; now independently pin every original
  // closure byte for conversion-time stability before extracting timing fields.
  for (const file of closure) assert.equal(digest(data.read(path(file.path))), file.sha256);
  const calibrationFiles = literalList(data.read(join(root, 'test/config/weighted-sequencer.mjs')).toString('utf8'),
    /export const CALIBRATION_INPUTS = Object\.freeze\(\[([\s\S]*?)\]\);/, file =>
      file.length <= 255 && !file.startsWith('/') && file.split('/').every(part => part && part !== '.' && part !== '..'));
  assert.ok(calibrationFiles.includes('package-lock.json') && calibrationFiles.includes('test/config/weighted-sequencer.mjs') &&
    calibrationFiles.includes('test/config/realio-lane-membership.mjs'), 'incomplete original calibration inputs');
  for (const file of calibrationFiles) assert.ok(source.tracked.some(row => row.path === file && ['100644', '100755'].includes(row.mode)), 'untracked calibration input');
  const configInputs = calibrationFiles.map(file => [file, digest(data.read(join(root, file)))]);
  const configSha256 = digest(JSON.stringify(configInputs));
  const lock = data.json(join(root, 'package-lock.json'));
  assert.equal(lock.packages?.['node_modules/vitest']?.version, '4.1.11', 'unsupported original locked Vitest');
  const realIO = new Set(literalList(data.read(join(root, 'test/config/realio-lane-membership.mjs')).toString('utf8'),
    /export const REAL_IO_TEST_FILES = \[([\s\S]*?)\];/, filePath));
  const modules = []; const environments = []; let total = 0; let finished = 0;
  for (const ref of qualification.lanes.filter(lane => lane.role.startsWith('mac-general-'))) {
    const lane = data.json(path(ref.path));
    assert.equal(lane.nodeVersion, 'v22.22.3', 'unsupported original Mac Node');
    const start = Date.parse(lane.startedAt), end = Date.parse(lane.finishedAt);
    assert.ok(end <= Date.parse(snapshot.observedAt), 'snapshot predates original lane completion');
    finished = Math.max(finished, end);
    environments.push({ role: ref.role, nodeVersion: lane.nodeVersion, requiredRunnerLabels: ['macos-15'],
      imageVersion: null, hardwareIdentity: null, laneSha256: ref.sha256 });
    for (const report of lane.reports) {
      const raw = data.json(path(`coverage/${ref.role}/reports/${report.file}`));
      for (const module of raw.testResults) {
        const matched = report.modules.filter(row => module.name === row.file || module.name.replaceAll('\\', '/').endsWith(`/${row.file}`));
        assert.equal(matched.length, 1); const file = matched[0].file;
        assert.ok(filePath(file) && source.tracked.some(row => row.path === file && ['100644', '100755'].includes(row.mode)), 'unsupported timing module');
        assert.ok(Number.isFinite(module.startTime) && Number.isFinite(module.endTime) && module.startTime >= start &&
          module.endTime >= module.startTime && module.endTime <= end, 'invalid original reporter span');
        const elapsedMs = Math.ceil(module.endTime - module.startTime);
        assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0, 'unsafe reporter span');
        total += elapsedMs; assert.ok(Number.isSafeInteger(total), 'reporter span sum overflow');
        modules.push({ file, project: realIO.has(file) ? 'real-io' : 'unit', sha256: digest(data.read(join(root, file))), elapsedMs,
          provenance: { role: ref.role, reportSha256: report.sha256, laneSha256: ref.sha256,
            caseInventorySha256: digest(JSON.stringify(matched[0].cases)) } });
      }
    }
  }
  modules.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  assert.ok(modules.length > 0 && modules.length <= 20_000 && new Set(modules.map(row => row.file)).size === modules.length);
  data.finish(); assert.deepEqual(sourceBinding(root, source.revision), source, 'calibration source changed');
  const provenance = { scope: 'validated-recorded-inputs-only', cryptographicReauthentication: false,
    manifestSha256: request.manifestSha256, qualificationSha256: request.qualificationSha256,
    githubSnapshotSha256: request.githubSnapshot.sha256, githubSnapshotObservedAt: snapshot.observedAt,
    configInputs, environments, coverageClosure: closure,
    limitations: ['Saved API responses require an independently accepted original capture; this converter does not authenticate GitHub.',
      'Archive/package subjects are retained pins; no installation or release admission is granted.',
      'Reporter spans are historical elapsed intervals, not CPU, queue or measured speedup.',
      'Runner hardware/image are not recorded by the original lane format; these remain unknown.'] };
  return { schema: 'phantom-partition-hints/v1', source: request.source,
    runtime: { platform: 'darwin', nodeVersion: 'v22.22.3', vitestVersion: '4.1.11', configSha256 },
    evidenceSha256: digest(JSON.stringify(provenance)), run: { id: String(request.run.id), attempt: request.run.attempt },
    recordedAt: new Date(finished).toISOString(), modules, provenance };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: ci-report-weight-hints.mjs CONVERSION-REQUEST.json');
    const input = reader(); const request = input.json(resolve(process.argv[2]), 64 * 1024);
    const hints = convertOriginalReportHints(request); input.finish(); console.log(JSON.stringify(hints, null, 2));
  } catch { console.error('Offline original timing conversion refused; no scheduling hints produced.'); process.exitCode = 1; }
}

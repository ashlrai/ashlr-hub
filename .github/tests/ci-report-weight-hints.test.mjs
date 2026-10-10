/* global process, URL, structuredClone */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { convertOriginalReportHints } from '../scripts/ci-report-weight-hints.mjs';
import { comparePartitions } from '../scripts/ci-partition-shadow.mjs';
import { qualifiedFixture, digest } from './helpers/hosted-artifact-fixture.mjs';

const readOwn = file => readFileSync(new URL(`../../${file}`, import.meta.url));
const inputs = ['package-lock.json', 'vitest.config.ts', 'test/config/realio-lane-membership.mjs',
  'vitest.config.mock-compat.ts', 'test/setup/home.ts', 'test/setup/home-isolation-guard.ts', 'scripts/test-ci.mjs', 'scripts/test-ci-sharded.mjs',
  'test/config/weighted-sequencer.mjs', '.github/scripts/ci-partition-shadow.mjs'];
const sourceFiles = () => Object.fromEntries(inputs.filter(file => !['vitest.config.ts', 'scripts/test-ci-sharded.mjs'].includes(file))
  .map(file => [file, file === 'package-lock.json' ? JSON.stringify({ packages: { 'node_modules/vitest': { version: '4.1.11' } } }) :
    file === 'test/config/realio-lane-membership.mjs' ? "export const REAL_IO_TEST_FILES = ['test/general-1.test.ts'];\n" : readOwn(file)]));

function original(t, overrides = {}) {
  const f = qualifiedFixture(t, { sourceFiles: { ...sourceFiles(), ...overrides }, timings: true });
  const manifest = JSON.parse(readFileSync(join(f.out, 'manifest.json')));
  const repo = manifest.producer.repository, base = `repos/${repo}`;
  const endpoints = [base, `${base}/actions/runs/100/attempts/1`, `${base}/git/commits/${f.sha}`,
    `${base}/git/commits/${manifest.producer.eventSha}`, `${base}/actions/runs/100/attempts/1/jobs?per_page=100&page=1`,
    ...[200, 201, 202, 203, 204, 205].map(id => `${base}/actions/artifacts/${id}`)];
  const snapshot = { schema: 'phantom-recorded-github-api/v1', observedAt: '2026-10-06T00:00:02.000Z',
    responses: Object.fromEntries(endpoints.map(endpoint => [endpoint, structuredClone(f.read(endpoint))])) };
  const snapshotPath = join(f.parent, 'recorded-api.json'); writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const request = { schema: 'phantom-original-report-conversion/v1', root: f.root, bundle: f.out,
    source: f.qualification.candidate, run: { id: 100, attempt: 1 },
    manifestSha256: digest(readFileSync(join(f.out, 'manifest.json'))), qualificationSha256: digest(readFileSync(join(f.out, 'qualification.json'))),
    githubSnapshot: { path: snapshotPath, sha256: digest(readFileSync(snapshotPath)) } };
  const saveSnapshot = () => { writeFileSync(snapshotPath, JSON.stringify(snapshot)); request.githubSnapshot.sha256 = digest(readFileSync(snapshotPath)); };
  // A modified timing-only raw report must still pass the original raw/case
  // closure before reaching span validation; reseal these synthetic data pins.
  const changeReport = mutate => {
    const laneRef = f.qualification.lanes.find(row => row.role === 'mac-general-1');
    const lanePath = join(f.out, laneRef.path), lane = JSON.parse(readFileSync(lanePath));
    const report = lane.reports[0], rawPath = join(f.out, 'coverage/mac-general-1/reports', report.file);
    const raw = JSON.parse(readFileSync(rawPath)); mutate(raw, lane);
    const rewrite = (path, value) => { chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(value)); return readFileSync(path); };
    const rawBytes = rewrite(rawPath, raw); report.bytes = rawBytes.length; report.sha256 = digest(rawBytes);
    const laneBytes = rewrite(lanePath, lane); laneRef.bytes = laneBytes.length; laneRef.sha256 = digest(laneBytes);
    for (const row of f.qualification.closure) {
      if (row.path === laneRef.path) { row.bytes = laneRef.bytes; row.sha256 = laneRef.sha256; }
      if (row.path === `coverage/mac-general-1/reports/${report.file}`) { row.bytes = report.bytes; row.sha256 = report.sha256; }
    }
    request.qualificationSha256 = digest(rewrite(join(f.out, 'qualification.json'), f.qualification));
  };
  return { ...f, request, snapshot, snapshotPath, base, saveSnapshot, changeReport };
}

test('successful original closure produces deterministic complete source-bound historical weights', t => {
  const f = original(t), before = readFileSync(f.snapshotPath);
  const hints = convertOriginalReportHints(f.request);
  assert.deepEqual(convertOriginalReportHints(f.request), hints);
  assert.deepEqual(hints.source, f.qualification.candidate);
  assert.deepEqual(hints.run, { id: '100', attempt: 1 });
  assert.equal(hints.recordedAt, '2026-10-06T00:00:01.000Z');
  assert.deepEqual(hints.modules.map(({ file, project, elapsedMs }) => ({ file, project, elapsedMs })),
    [1, 2, 3, 4].map(n => ({ file: `test/general-${n}.test.ts`, project: n === 1 ? 'real-io' : 'unit', elapsedMs: 101 })));
  assert.equal(hints.runtime.configSha256, digest(JSON.stringify(inputs.map(file => [file, digest(readFileSync(join(f.root, file)))]))));
  assert.equal(hints.provenance.cryptographicReauthentication, false);
  assert.equal(hints.provenance.environments.length, 4);
  assert.ok(hints.provenance.environments.every(row => row.imageVersion === null && row.hardwareIdentity === null));
  assert.deepEqual(hints.provenance.coverageClosure, f.qualification.closure);
  const inventory = { schema: 'phantom-partition-inventory/v1', source: hints.source, collectionSource: hints.source,
    collectionState: 'observed', runtime: hints.runtime, modules: hints.modules.map(({ file, project, sha256 }) => ({ file, project, sha256 })) };
  const out = comparePartitions(inventory, hints);
  assert.equal(out.report.fallbackReason, null); assert.equal(out.report.diagnostics.matchedTestBytes, 4);
  for (const bins of [out.baseline, out.proposed]) assert.deepEqual(bins.flat().map(row => row.file).sort(), inventory.modules.map(row => row.file).sort());
  assert.equal(out.report.activationEnabled, false); assert.equal(out.report.resultReuseEnabled, false); assert.equal(out.report.measuredSpeedup, null);
  assert.deepEqual(readFileSync(f.snapshotPath), before); assert.equal(f.git('status', '--porcelain'), '');
});

test('failed, canceled, pending and wrong-attempt original runs refuse even with freshly pinned saved data', t => {
  const f = original(t), endpoint = `${f.base}/actions/runs/100/attempts/1`, baseline = structuredClone(f.snapshot.responses[endpoint]);
  for (const mutate of [row => { row.conclusion = 'failure'; }, row => { row.conclusion = 'cancelled'; },
    row => { row.status = 'in_progress'; }, row => { row.run_attempt = 2; }, row => { row.head_sha = 'a'.repeat(40); }]) {
    f.snapshot.responses[endpoint] = structuredClone(baseline); mutate(f.snapshot.responses[endpoint]); f.saveSnapshot();
    assert.throws(() => convertOriginalReportHints(f.request));
  }
});

test('incomplete jobs, wrong source trees, missing required steps and self-hosted substitutions refuse', t => {
  const f = original(t), jobsEndpoint = `${f.base}/actions/runs/100/attempts/1/jobs?per_page=100&page=1`;
  const baseline = structuredClone(f.snapshot);
  const mutations = [s => { s.responses[jobsEndpoint].jobs.pop(); }, s => { s.responses[jobsEndpoint].jobs[0].steps.pop(); },
    s => { s.responses[jobsEndpoint].jobs[0].conclusion = 'failure'; },
    s => { s.responses[jobsEndpoint].jobs[0].labels.push('self-hosted'); },
    s => { s.responses[`${f.base}/git/commits/${'b'.repeat(40)}`].tree.sha = 'a'.repeat(40); },
    s => { delete s.responses[jobsEndpoint]; }];
  for (const mutate of mutations) { Object.assign(f.snapshot, structuredClone(baseline)); mutate(f.snapshot); f.saveSnapshot(); assert.throws(() => convertOriginalReportHints(f.request)); }
});

test('original artifact identity, expiry, attempt pins and stable raw bytes remain required', t => {
  const f = original(t), endpoint = `${f.base}/actions/artifacts/201`, baseline = structuredClone(f.snapshot.responses[endpoint]);
  for (const mutate of [row => { row.expired = true; }, row => { row.name = 'ashlr-qualification-mac-general-1-100-2'; },
    row => { row.workflow_run.id = 101; }, row => { row.digest = `sha256:${'0'.repeat(64)}`; }]) {
    f.snapshot.responses[endpoint] = structuredClone(baseline); mutate(f.snapshot.responses[endpoint]); f.saveSnapshot(); assert.throws(() => convertOriginalReportHints(f.request));
  }
  f.snapshot.responses[endpoint] = baseline; f.saveSnapshot();
  assert.throws(() => convertOriginalReportHints({ ...f.request, run: { id: 100, attempt: 2 } }));
  const raw = join(f.out, 'coverage/mac-general-1/reports/general-1-of-4.json'); chmodSync(raw, 0o600); writeFileSync(raw, '{}');
  assert.throws(() => convertOriginalReportHints(f.request));
});

test('raw reporter spans are checked after valid complete case closure, without inferring case duration', t => {
  const f = original(t), originalRaw = JSON.parse(readFileSync(join(f.out, 'coverage/mac-general-1/reports/general-1-of-4.json')));
  for (const mutate of [m => { delete m.startTime; }, m => { m.endTime = null; }, m => { m.endTime = m.startTime - 1; },
    m => { m.startTime = Date.parse('2026-10-05T23:59:59.000Z'); }, m => { m.endTime = Date.parse('2026-10-06T00:00:02.000Z'); }]) {
    f.changeReport(raw => { raw.testResults = structuredClone(originalRaw.testResults); mutate(raw.testResults[0]); });
    assert.throws(() => convertOriginalReportHints(f.request), /invalid original reporter span/);
  }
  f.changeReport(raw => { raw.testResults = structuredClone(originalRaw.testResults); raw.testResults[0].endTime = raw.testResults[0].startTime; });
  assert.equal(convertOriginalReportHints(f.request).modules[0].elapsedMs, 0);
});

test('a failed case cannot become a timing hint by resealing its raw byte digest', t => {
  const f = original(t); f.changeReport(raw => { raw.success = false; raw.numFailedTests = 1; raw.numPassedTests = 1;
    raw.testResults[0].assertionResults[0].status = 'failed'; raw.testResults[0].assertionResults[0].failureMessages = ['synthetic failure']; });
  assert.throws(() => convertOriginalReportHints(f.request));
});

test('missing historical calibration declaration is refused rather than filled from current converter source', t => {
  const f = original(t, { 'test/config/weighted-sequencer.mjs': '// original source predates calibration adapter\n' });
  assert.throws(() => convertOriginalReportHints(f.request), /missing original calibration declaration/);
});

test('unsupported original Vitest and nonliteral calibration configuration refuse', t => {
  const f = original(t, { 'package-lock.json': JSON.stringify({ packages: { 'node_modules/vitest': { version: '4.1.10' } } }) });
  assert.throws(() => convertOriginalReportHints(f.request), /unsupported original locked Vitest/);
});

test('calibration inputs must be a literal comma-separated list, not executable expressions', t => {
  const f = original(t, { 'test/config/weighted-sequencer.mjs': "export const CALIBRATION_INPUTS = Object.freeze(['package-lock.json''test/config/weighted-sequencer.mjs']);\n" });
  assert.throws(() => convertOriginalReportHints(f.request), /unsupported calibration declaration/);
});

test('wrong caller pins, dirty source, precompletion capture and symlink evidence refuse', t => {
  const f = original(t);
  assert.throws(() => convertOriginalReportHints({ ...f.request, manifestSha256: 'a'.repeat(64) }));
  f.snapshot.observedAt = '2026-10-06T00:00:00.000Z'; f.saveSnapshot();
  assert.throws(() => convertOriginalReportHints(f.request), /snapshot predates/);
  f.snapshot.observedAt = '2026-10-06T00:00:02.000Z'; f.saveSnapshot();
  const alias = join(f.parent, 'snapshot-alias.json'); symlinkSync(f.snapshotPath, alias);
  assert.throws(() => convertOriginalReportHints({ ...f.request, githubSnapshot: { ...f.request.githubSnapshot, path: alias } }), /noncanonical/);
  writeFileSync(join(f.root, 'test/general-1.test.ts'), '// dirty\n'); assert.throws(() => convertOriginalReportHints(f.request));
});

test('CLI consumes one pinned request offline and emits closed refusal without evidence contents', t => {
  const f = original(t), requestPath = join(f.parent, 'request.json'); writeFileSync(requestPath, JSON.stringify(f.request));
  const script = new URL('../scripts/ci-report-weight-hints.mjs', import.meta.url);
  const success = spawnSync(process.execPath, [script.pathname, requestPath], { encoding: 'utf8' });
  assert.equal(success.status, 0); assert.equal(success.stderr, '');
  assert.deepEqual(JSON.parse(success.stdout), convertOriginalReportHints(f.request));
  const result = spawnSync(process.execPath, [script.pathname, requestPath], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
  // git is a source metadata dependency; a missing PATH must refuse, not fetch.
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Offline original timing conversion refused; no scheduling hints produced.\n');
  assert.ok(!result.stderr.includes(f.parent));
});

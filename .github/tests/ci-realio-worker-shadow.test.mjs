/* global structuredClone */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { parse } from 'yaml';
import { MODULES, armArgs, phaseTimings, projectReport, runShadow } from '../scripts/ci-realio-worker-shadow.mjs';
import { normalizeReport } from '../scripts/ci-qualification-lane.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function report(root, overlap = false, failed = false) {
  const raw = { success: !failed, numTotalTests: 4, numPassedTests: failed ? 3 : 4, numFailedTests: Number(failed), numPendingTests: 0, numTodoTests: 0,
    numFailedTestSuites: Number(failed), testResults: MODULES.map((file, moduleId) => ({ name: join(root, file), status: failed && moduleId === 0 ? 'failed' : 'passed',
      startTime: 1000 + (moduleId === 1 ? (overlap ? 10 : 100) : 0), endTime: 1050 + (moduleId === 1 ? (overlap ? 10 : 100) : 0),
      assertionResults: [0, 1].map((i) => ({ fullName: 'same parameterized title', duration: 10 + i, status: failed && moduleId === 0 && i === 0 ? 'failed' : 'passed', failureMessages: failed ? ['SECRET /private/credential'] : [] })) })) };
  const expected = MODULES.map((file, moduleId) => ({ moduleId, ids: [0, 1].map((i) => hash(`${file}\0same parameterized title\0${i}`)).sort() }));
  return { raw, expected };
}
function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-worker-shadow-test-'))); chmodSync(parent, 0o700);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = parent;
  mkdirSync(join(root, 'test'));
  MODULES.forEach((file, i) => writeFileSync(join(root, file), `source module ${i}\n`, { mode: 0o600 }));
  const { expected } = report(root);
  const source = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), eventSha: 'a'.repeat(40) };
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'ashlrai/phantom', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', ASHLR_CANDIDATE_SHA: source.revision, GITHUB_SHA: source.eventSha,
    ASHLR_VITEST_TEST_TIMEOUT_MS: '1', ASHLR_TEST_CI_TIMEOUT_MS: '1', ASHLR_TEST_CI_WEIGHTED_PARTITION: '1', ASHLR_TEST_CI_REPORT_DIRECTORY: 'do-not-inherit', GITHUB_OUTPUT: join(parent, 'outputs') };
  let clock = 0;
  return { root, parent, env, expected, bind: () => source, now: () => (clock += 100), source };
}
function runner(f, mutate = () => {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const workers = Number(args.find((arg) => arg.startsWith('--maxWorkers=')).split('=')[1]);
    const path = args.find((arg) => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
    assert.deepEqual(args, armArgs(workers, path)); assert.equal(command, 'npm'); assert.equal(options.cwd, f.root);
    assert.equal(options.stdio[0], 'ignore'); assert.equal(options.stdio[1], options.stdio[2]);
    for (const key of ['ASHLR_VITEST_TEST_TIMEOUT_MS', 'ASHLR_TEST_CI_TIMEOUT_MS', 'ASHLR_TEST_CI_WEIGHTED_PARTITION', 'ASHLR_TEST_CI_REPORT_DIRECTORY']) assert.equal(Object.hasOwn(options.env, key), false);
    const raw = report(f.root, workers === 2).raw;
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    writeFileSync(options.stdio[1], 'SECRET console path\n Duration 0.1s (transform 20ms, setup 0.01s, import 15ms, tests 40ms, environment 0ms)\n');
    return mutate({ path, raw, workers, options }) ?? { status: 0, signal: null };
  };
  return { run, calls };
}
function readReceipt(result) { return JSON.parse(readFileSync(join(result.directory, 'measurements.json'), 'utf8')); }
function assertNumericOnly(value) {
  if (value === null || typeof value === 'number') { assert.ok(value === null || Number.isFinite(value)); return; }
  if (typeof value === 'string') { assert.match(value, /^[a-f0-9]{40}$|^[a-f0-9]{64}$/); return; }
  if (Array.isArray(value)) { value.forEach(assertNumericOnly); return; }
  assert.equal(typeof value, 'object'); Object.values(value).forEach(assertNumericOnly);
}

test('fixed inventory has exactly 82 distinct opaque cases in the two whole modules', () => {
  const inventory = JSON.parse(readFileSync(new URL('../scripts/ci-realio-worker-shadow-cases.json', import.meta.url), 'utf8'));
  assert.deepEqual(inventory.map((m) => [m.moduleId, m.ids.length]), [[0, 22], [1, 60]]);
  const ids = inventory.flatMap((m) => m.ids); assert.equal(new Set(ids).size, 82);
  ids.forEach((id) => assert.match(id, /^[a-f0-9]{64}$/));
});
test('projection agrees with existing occurrence-aware normalizer and measures observed overlap', () => {
  const { raw, expected } = report('/source');
  const projected = projectReport(raw, '/source', expected);
  const normalized = normalizeReport(raw, '/source');
  assert.deepEqual(projected.modules.map((m) => m.cases.map((c) => c.id)), normalized.map((m) => m.cases.map((c) => c.id).sort()));
  assert.equal(projected.pass, 1); assert.equal(projected.overlapObserved, 0);
  assert.equal(projectReport(report('/source', true).raw, '/source', expected).overlapObserved, 1);
  assertNumericOnly(projected);
});
test('failed reports retain identities and failure states without secret failure messages', () => {
  const { raw, expected } = report('/source', true, true);
  const projected = projectReport(raw, '/source', expected);
  assert.equal(projected.pass, 0); assert.equal(projected.complete, 1); assert.deepEqual(projected.totals, [3, 1, 0, 0, 0]);
  assertNumericOnly(projected); assert.equal(JSON.stringify(projected).includes('SECRET'), false);
});
test('unfinished pending cases retain a separate numeric state and never count as passed', () => {
  const { raw, expected } = report('/source', false, true);
  raw.testResults[0].assertionResults[1].status = 'pending'; raw.numPassedTests = 2; raw.numPendingTests = 1;
  const projected = projectReport(raw, '/source', expected);
  assert.deepEqual(projected.totals, [2, 1, 0, 0, 1]); assert.equal(projected.pass, 0);
  assert.equal(projected.modules[0].cases.some((c) => c.state === 4), true);
});
test('Vitest success true with 81 passing and 1 pending case retains all 82 states and stops before arm two', (t) => {
  const f = fixture(t); const raw = report(f.root).raw;
  raw.testResults.forEach((module, moduleId) => {
    module.assertionResults = Array.from({ length: moduleId === 0 ? 22 : 60 }, (_, i) => ({ fullName: `module ${moduleId} case ${i}`, status: 'passed', duration: 10, failureMessages: [] }));
  });
  raw.numTotalTests = raw.numPassedTests = 82;
  const expected = MODULES.map((file, moduleId) => ({ moduleId, ids: raw.testResults[moduleId].assertionResults.map((item) => hash(`${file}\0${item.fullName}\0${0}`)).sort() }));
  const terminal = projectReport(raw, f.root, expected);
  raw.testResults[0].assertionResults[0].status = 'pending';
  delete raw.testResults[0].assertionResults[0].duration;
  raw.numPassedTests = 81; raw.numPendingTests = 1;
  const projected = projectReport(raw, f.root, expected);
  assert.equal(projected.complete, 1); assert.equal(projected.pass, 0);
  assert.deepEqual(projected.totals, [81, 0, 0, 0, 1]);
  assert.deepEqual(projected.modules.map((m) => m.cases.map((c) => c.id)), terminal.modules.map((m) => m.cases.map((c) => c.id)));
  assert.equal(projected.modules.every((m) => m.state === 0), true);
  assert.equal(projected.modules.flatMap((m) => m.cases).filter((c) => c.state === 4).length, 1);
  assertNumericOnly(projected);
  const r = runner(f, ({ path }) => { writeFileSync(path, JSON.stringify(raw), { mode: 0o600 }); return { status: 0, signal: null }; });
  const result = runShadow({ ...f, expected, run: r.run }); const receipt = readReceipt(result);
  assert.equal(result.pass, false); assert.equal(r.calls.length, 1); assert.equal(receipt.arms[0].reportState, 1);
  assert.deepEqual(receipt.arms[0].report.modules, projected.modules); assertNumericOnly(receipt);
  for (const mutate of [r => { r.numPendingTests = 0; }, r => { r.testResults[0].assertionResults[0].status = 'unknown'; }, r => { r.success = false; r.numPendingTests = 0; r.numPassedTests = 81; r.numFailedTests = 1; r.testResults[0].assertionResults[0].status = 'failed'; }]) {
    const invalid = structuredClone(raw); mutate(invalid); assert.throws(() => projectReport(invalid, f.root, expected));
  }
});
test('unknown cases, missing modules and skipped cases never become a successful pair', () => {
  const { raw, expected } = report('/source');
  raw.testResults[0].assertionResults[0].fullName = 'changed';
  assert.equal(projectReport(raw, '/source', expected).pass, 0);
  const missing = report('/source'); missing.raw.testResults.pop(); missing.raw.numTotalTests = missing.raw.numPassedTests = 2;
  assert.equal(projectReport(missing.raw, '/source', missing.expected).complete, 0);
  const skipped = report('/source'); skipped.raw.testResults[0].assertionResults[0].status = 'skipped'; skipped.raw.numPassedTests = 3; skipped.raw.numPendingTests = 1;
  assert.equal(projectReport(skipped.raw, '/source', skipped.expected).pass, 0);
});
test('unsafe report identity, counts and non-finite durations are refused', () => {
  for (const mutate of [r => { r.numTotalTests++; }, r => { r.testResults[0].name = '/elsewhere/test.ts'; }, r => { r.testResults[1].name = r.testResults[0].name; }, r => { r.testResults[0].endTime = Infinity; }, r => { r.testResults[0].assertionResults[0].duration = -1; }]) {
    const { raw, expected } = report('/source'); mutate(raw); assert.throws(() => projectReport(raw, '/source', expected));
  }
});
test('phase timings publish scalars only and leave unavailable phases null', () => {
  assert.deepEqual(phaseTimings('SECRET\n Duration 2s (transform 1.2s, setup 12ms, import 3ms, tests 2s, environment 0ms)'), { transformMs: 1200, setupMs: 12, importMs: 3, testsMs: 2000, environmentMs: 0 });
  assert.deepEqual(phaseTimings('no summary'), { transformMs: null, setupMs: null, importMs: null, testsMs: null, environmentMs: null });
  assert.equal(phaseTimings(` Duration 2s (transform ${'9'.repeat(400)}s)`).transformMs, null);
});
test('one sequential pair uses existing wrapper boundaries and uploads only projected evidence', (t) => {
  const f = fixture(t); const r = runner(f); const result = runShadow({ ...f, run: r.run });
  assert.equal(result.pass, true); assert.equal(r.calls.length, 2);
  assert.notEqual(r.calls[0].args.at(-1), r.calls[1].args.at(-1));
  const receipt = readReceipt(result); assertNumericOnly(receipt);
  assert.deepEqual(receipt.arms.map((a) => [a.workers, a.report.overlapObserved, a.status]), [[1, 0, 0], [2, 1, 0]]);
  assert.deepEqual(readdirSync(result.directory), ['measurements.json']); assert.equal(lstatSync(result.directory).mode & 0o777, 0o700);
  assert.equal(receipt.qualification, 0); assert.equal(receipt.resultReuse, 0);
  assert.deepEqual(receipt.moduleContentHashes, MODULES.map((_file, moduleId) => ({ moduleId, sha256: hash(`source module ${moduleId}\n`) })));
  for (const arm of receipt.arms) for (const sample of [arm.hostBefore, arm.hostAfter]) {
    assert.equal(sample.loadAverage.length, 3); assert.ok(sample.freeMemoryBytes >= 0); sample.loadAverage.forEach((value) => assert.ok(value >= 0));
  }
  assert.equal(readFileSync(join(f.parent, 'outputs'), 'utf8'), `numeric_dir=${result.directory}\n`);
});
test('first failure is preserved and prevents retries, fallback or a second arm', (t) => {
  const f = fixture(t); const r = runner(f, ({ path }) => { writeFileSync(path, JSON.stringify(report(f.root, false, true).raw), { mode: 0o600 }); return { status: 1, signal: null }; });
  const result = runShadow({ ...f, run: r.run }); const receipt = readReceipt(result);
  assert.equal(result.pass, false); assert.equal(r.calls.length, 1); assert.equal(receipt.arms[0].report.totals[1], 1); assert.equal(receipt.arms[0].exitCode, 1); assertNumericOnly(receipt);
});
test('collection failure retains surviving case evidence and stops before arm two', (t) => {
  const f = fixture(t);
  const surviving = report(f.root).raw.testResults[1];
  const failure = report(f.root, false, true).raw;
  failure.testResults[0].assertionResults = [];
  failure.testResults[0].message = 'SECRET import failure /private/credential';
  failure.testResults[1] = surviving;
  failure.numTotalTests = failure.numPassedTests = 2;
  failure.numFailedTests = 0;
  const expectedSurvivors = projectReport(report(f.root).raw, f.root, f.expected).modules[1];
  const projected = projectReport(failure, f.root, f.expected);
  assert.equal(projected.complete, 0); assert.equal(projected.pass, 0);
  assert.deepEqual(projected.modules[0], { moduleId: 0, state: 1, durationMs: 50, startMs: 0, endMs: 50, exactInventory: 0, cases: [] });
  assert.deepEqual(projected.modules[1], expectedSurvivors);
  assertNumericOnly(projected); assert.equal(JSON.stringify(projected).includes('SECRET'), false);
  const r = runner(f, ({ path }) => { writeFileSync(path, JSON.stringify(failure), { mode: 0o600 }); return { status: 1, signal: null }; });
  const result = runShadow({ ...f, run: r.run }); const receipt = readReceipt(result);
  assert.equal(result.pass, false); assert.equal(r.calls.length, 1); assert.equal(receipt.arms[0].reportState, 1);
  assert.deepEqual(receipt.arms[0].report.modules, projected.modules);
  assertNumericOnly(receipt);
  for (const success of [false, true]) {
    const empty = structuredClone(failure); empty.success = success; empty.testResults[0].status = 'passed';
    assert.throws(() => projectReport(empty, f.root, f.expected));
  }
  const successfulEmpty = structuredClone(failure); successfulEmpty.success = true; successfulEmpty.numFailedTestSuites = 0;
  assert.throws(() => projectReport(successfulEmpty, f.root, f.expected));
});
test('missing and symlink reports are numeric refusals with no second attempt', (t) => {
  for (const symlink of [false, true]) {
    const f = fixture(t); const r = runner(f, ({ path }) => { rmSync(path); if (symlink) symlinkSync(join(f.parent, 'outputs'), path); return { status: 0, signal: null }; });
    const result = runShadow({ ...f, run: r.run }); assert.equal(result.pass, false); assert.equal(r.calls.length, 1); assert.equal(readReceipt(result).arms[0].reportState, 2);
  }
});
test('thrown child error and source changes preserve first receipt without raw diagnostic', (t) => {
  for (const change of [false, true]) {
    const f = fixture(t); const r = runner(f, () => { if (!change) throw new Error('SECRET credential'); });
    let binds = 0;
    const result = runShadow({ ...f, run: r.run, bind: () => { if (change && binds++ > 0) throw new Error('source changed'); return f.source; } });
    assert.equal(result.pass, false); assert.equal(r.calls.length, 1); assertNumericOnly(readReceipt(result));
  }
});
test('non-manual or other-repository event cannot invoke any tests', (t) => {
  const f = fixture(t); let called = false;
  for (const update of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_RUN_ID: '0' }]) {
    assert.throws(() => runShadow({ ...f, env: { ...f.env, ...update }, run: () => { called = true; } }));
  }
  assert.equal(called, false);
});
test('manual workflow preserves immutable actions and avoids release or matrix authority', () => {
  const workflow = readFileSync(new URL('../workflows/realio-worker-shadow.yml', import.meta.url), 'utf8');
  const config = parse(workflow);
  assert.deepEqual(config.on, { workflow_dispatch: null }); assert.deepEqual(config.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(config.jobs), ['measure']); assert.equal(config.jobs.measure.steps.length, 8);
  const events = workflow.split('on:\n')[1].split('\npermissions:')[0]; assert.equal(events.trim(), 'workflow_dispatch:');
  assert.match(workflow, /permissions:\n {2}contents: read\n/); assert.doesNotMatch(workflow, /id-token:|secrets\.|workflow_call:|pull_request:|push:|strategy:|matrix:|continue-on-error|--retry|gh workflow/);
  assert.match(workflow, /runs-on: macos-15/); assert.match(workflow, /node-version: "22\.22\.3"/);
  assert.equal((workflow.match(/npm run build/g) ?? []).length, 1); assert.equal((workflow.match(/npm ci/g) ?? []).length, 1);
  assert.match(workflow, /cancel-in-progress: false/); assert.match(workflow, /outputs\.numeric_dir }}\/measurements\.json/);
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a']);
  const wrapper = readFileSync(new URL('../../scripts/test-ci.mjs', import.meta.url), 'utf8');
  assert.match(wrapper, /mkdtempSync\(join\(tmpdir\(\), 'ashlr-test-ci-home-'\)\)/); assert.match(wrapper, /HOME: home/);
  assert.throws(() => armArgs(3, '/report'));
});

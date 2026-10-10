/* global process, Buffer */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { analyzeModule, collectShadow } from '../scripts/ci-impact-shadow.mjs';
import { normalizeReport, reportNames } from '../scripts/ci-qualification-lane.mjs';
import { auditGithub } from '../../scripts/hosted-build-artifact.mjs';
import { artifactNames, prepare } from '../scripts/ci-attestation-inputs.mjs';
import { HUB_REPOSITORY_IDENTITY as hub } from '../scripts/github-repository-binding.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');

// Actual isolated Git objects; reports are synthetic data, never hosted proof.
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phantom-impact-fixture-')));
  const root = join(parent, 'source'); fs.mkdirSync(root); const home = join(parent, 'home'); fs.mkdirSync(home);
  const previous = new Map();
  for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none'),
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined })) {
    previous.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(parent, { recursive: true, force: true }); });
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (file, text) => { fs.mkdirSync(dirname(join(root, file)), { recursive: true }); fs.writeFileSync(join(root, file), text); };
  const commit = () => { git(['add', '.']); git(['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  git(['init', '--quiet']);
  put('test/example.test.ts', "import { value } from '../src/value.js'; export const input = value;\n");
  put('src/value.ts', 'export const value = 0;\n'); put('README.md', 'original docs\n');
  put('package.json', '{"name":"fixture","version":"1.0.0"}\n');
  const base = commit();
  const makeLane = (role = 'web') => {
    const revision = git(['rev-parse', 'HEAD']); const tree = git(['rev-parse', 'HEAD^{tree}']);
    const env = { ASHLR_CI_EVENT_SHA: revision, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2' };
    const directory = fs.mkdtempSync(join(parent, 'lane-')); fs.mkdirSync(join(directory, 'reports'));
    const reports = reportNames(role).map((file) => {
      const raw = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 3, numPassedTests: 1, numPendingTests: 1, numTodoTests: 1,
        testResults: [{ name: join(root, 'test/example.test.ts'), status: 'passed', assertionResults:
          ['passed', 'skipped', 'todo'].map((status) => ({ fullName: 'same parameterized title', status, failureMessages: [] })) }] };
      const data = JSON.stringify(raw); fs.writeFileSync(join(directory, 'reports', file), data);
      return { file, bytes: Buffer.byteLength(data), sha256: hash(data), modules: normalizeReport(raw, root) };
    });
    const lane = { schemaVersion: 1, role, source: { revision, tree, eventSha: revision }, run: { id: '100', attempt: '2' }, nodeVersion: 'v22.22.3',
      startedAt: '2026-10-08T01:00:00.000Z', finishedAt: '2026-10-08T01:01:00.000Z', exitCode: 0, reports };
    fs.writeFileSync(join(directory, 'lane.json'), JSON.stringify(lane));
    return { options: { root, revision, baseRevision: base, role, laneDirectory: directory, env }, lane, directory };
  };
  return { root, parent, put, git, commit, base, makeLane };
}

function rewriteRawReport(lane, file, mutate) {
  const path = join(lane.directory, 'reports', file); const raw = JSON.parse(fs.readFileSync(path));
  mutate(raw); const data = JSON.stringify(raw); fs.writeFileSync(path, data);
  const record = lane.lane.reports.find((row) => row.file === file);
  record.sha256 = hash(data); record.bytes = Buffer.byteLength(data);
  record.modules = normalizeReport(raw, lane.options.root);
  fs.writeFileSync(join(lane.directory, 'lane.json'), JSON.stringify(lane.lane));
}

test('observes exact source and duplicate occurrence/skip/todo results without inheriting or rewriting reports', (t) => {
  const f = fixture(t); f.put('README.md', 'copy change\n'); f.commit(); const lane = f.makeLane();
  const paths = [join(lane.directory, 'lane.json'), join(lane.directory, 'reports', 'web.json')]; const original = paths.map((path) => hash(fs.readFileSync(path)));
  const report = collectShadow({ ...lane.options, complete: true, baseline: { passed: true } });
  assert.equal(report.advisoryOnly, true); assert.equal(report.activationEnabled, false);
  assert.equal(report.base.sourceState, 'observed'); assert.equal(report.base.evidenceState, 'unavailable'); assert.equal(report.base.caseInventory, null);
  assert.deepEqual(report.changes.map((row) => row.path), ['README.md']);
  assert.equal(report.descriptors[0].inputComparison, 'observed-inputs-unchanged'); assert.equal(report.descriptors[0].complete, false);
  assert.ok(report.inputs.head.find((node) => node.path === 'test/example.test.ts').imports.some((edge) => edge.target === 'src/value.ts'));
  assert.equal(report.summary.eligibleModules, 0); assert.equal(report.summary.inheritedCases, 0); assert.equal(report.summary.baseCaseOccurrences, null);
  assert.equal(report.summary.headCaseOccurrences, 3); assert.equal(report.summary.headSkippedOccurrences, 1); assert.equal(report.summary.headTodoOccurrences, 1);
  assert.equal(report.timing.moduleTimingCoverage, 'unknown'); assert.equal(report.timing.testSpanSumMs, null);
  const cases = report.head.reports[0].modules[0].cases; assert.equal(new Set(cases.map((row) => row.id)).size, 3);
  assert.deepEqual(cases.map((row) => row.state), ['passed', 'skipped', 'todo']);
  assert.deepEqual(paths.map((path) => hash(fs.readFileSync(path))), original);
  assert.equal(JSON.stringify(report).includes('adoptionToken'), false);
});

test('records changed transitive source and unknown data rather than claiming docs and unimported files safe', (t) => {
  const f = fixture(t); f.put('src/value.ts', "import { readFileSync } from 'node:fs'; export const value = readFileSync('README.md');\n"); f.commit();
  const report = collectShadow(f.makeLane().options);
  assert.equal(report.descriptors[0].inputComparison, 'observed-inputs-changed');
  assert.ok(report.descriptors[0].reasons.includes('filesystem-or-data-domain'));
  assert.equal(report.descriptors[0].decision, 'full-required');
});

test('source-only dry observation has unknown outcomes and membership, never zero successful cases', (t) => {
  const f = fixture(t);
  const report = collectShadow({ root: f.root, revision: f.base, baseRevision: f.base, role: 'mac-general-1', sourceOnly: true });
  assert.equal(report.head.outcome, 'unobserved'); assert.equal(report.head.reports, null); assert.equal(report.head.run, null);
  assert.equal(report.timing.moduleTimingCoverage, 'unobserved'); assert.equal(report.timing.moduleOccurrences, null);
  assert.equal(report.timing.laneElapsedMs, null); assert.equal(report.timing.testSpanSumMs, null);
  assert.equal(report.summary.observedModules, null); assert.equal(report.summary.sourceCandidateModules, 1);
  assert.equal(report.summary.headCaseOccurrences, null); assert.equal(report.summary.headPassedOccurrences, null);
  assert.equal(report.descriptors[0].roleMembership, 'unobserved-source-candidate'); assert.equal(report.summary.eligibleModules, 0);
});

for (const [file, text, reason] of [
  ['package.json', '{"name":"fixture","version":"1.0.1"}\n', 'package-or-version-change'],
  ['package-lock.json', '{"lockfileVersion":3}\n', 'package-or-version-change'],
  ['test/setup/home.ts', 'export const setup = true;\n', 'test-or-setup-change'],
  ['vitest.config.mock-compat.ts', 'export const compat = true;\n', 'test-or-setup-change'],
  ['.github/workflows/ci.yml', 'name: changed\n', 'workflow-or-policy-or-tool-change'],
]) {
  test(`forces full for ${file} including a version-only edit`, (t) => {
    const f = fixture(t); f.put(file, text); f.commit(); const report = collectShadow(f.makeLane().options);
    assert.ok(report.descriptors[0].reasons.includes(reason)); assert.equal(report.summary.eligibleModules, 0);
  });
}

test('binds mode changes and both sides of deletion/addition without rename guessing', (t) => {
  const f = fixture(t); fs.chmodSync(join(f.root, 'src/value.ts'), 0o755); f.git(['mv', 'README.md', 'RENAMED.md']); f.commit();
  const report = collectShadow(f.makeLane().options);
  assert.deepEqual(report.changes.map((row) => row.path), ['README.md', 'RENAMED.md', 'src/value.ts']);
  assert.equal(report.changes[2].base.mode, '100644'); assert.equal(report.changes[2].head.mode, '100755');
  assert.equal(report.descriptors[0].inputComparison, 'observed-inputs-changed');
});

test('correctly parses TSX, literal mocks and computed requires/imports without executing source', () => {
  const analysis = analyzeModule('test/example.test.tsx', "import type { A } from './type'; vi.mock('./mock'); const jsx = <div />; require(name); import(target); import.meta.glob('./*.json'); process.env.VALUE;\n");
  assert.deepEqual(analysis.imports, ['./mock', './type']);
  assert.ok(analysis.unknown.includes('computed-import-or-mock')); assert.ok(analysis.unknown.includes('computed-discovery-or-resolution'));
  assert.ok(analysis.unknown.includes('environment-or-source-identity')); assert.ok(!analysis.unknown.includes('source-parse-unresolved'));
  assert.ok(analyzeModule('src/child.ts', "import { spawn } from 'node:child_process';").unknown.includes('child-command-domain'));
});

for (const baseKind of ['missing', 'absent', 'nonancestor']) {
  test(`missing qualified bootstrap and ${baseKind} source remain unknown/full`, (t) => {
    const f = fixture(t); const lane = f.makeLane();
    if (baseKind === 'missing') lane.options.baseRevision = null;
    if (baseKind === 'absent') lane.options.baseRevision = 'f'.repeat(40);
    if (baseKind === 'nonancestor') {
      f.put('README.md', 'future\n'); lane.options.baseRevision = f.commit(); f.git(['reset', '--hard', f.base]);
    }
    const report = collectShadow(lane.options); assert.equal(report.base.sourceState, 'unavailable');
    assert.equal(report.changes, null); assert.equal(report.descriptors[0].inputComparison, 'unknown'); assert.equal(report.summary.eligibleModules, 0);
  });
}

for (const kind of ['dirty', 'hidden-index', 'wrong-attempt', 'raw-drift', 'relabeled-source', 'failed-raw', 'unsupported-role']) {
  test(`refuses ${kind} rather than emitting a successful diagnostic`, (t) => {
    const f = fixture(t); const lane = f.makeLane();
    if (kind === 'dirty') f.put('README.md', 'dirty\n');
    if (kind === 'hidden-index') f.git(['update-index', '--assume-unchanged', 'README.md']);
    if (kind === 'wrong-attempt') lane.options.env.GITHUB_RUN_ATTEMPT = '3';
    if (kind === 'raw-drift') fs.appendFileSync(join(lane.directory, 'reports', 'web.json'), ' ');
    if (kind === 'relabeled-source') { lane.lane.source.revision = 'f'.repeat(40); fs.writeFileSync(join(lane.directory, 'lane.json'), JSON.stringify(lane.lane)); }
    if (kind === 'failed-raw') { const file = join(lane.directory, 'reports', 'web.json'); const raw = JSON.parse(fs.readFileSync(file)); raw.success = false; const data = JSON.stringify(raw); fs.writeFileSync(file, data); lane.lane.reports[0].sha256 = hash(data); lane.lane.reports[0].bytes = Buffer.byteLength(data); fs.writeFileSync(join(lane.directory, 'lane.json'), JSON.stringify(lane.lane)); }
    if (kind === 'unsupported-role') lane.options.role = 'linux';
    assert.throws(() => collectShadow(lane.options));
  });
}

test('keeps platform roles and filtered report occurrences distinct', (t) => {
  const f = fixture(t); const report = collectShadow(f.makeLane('mac-isolated').options);
  assert.equal(report.role, 'mac-isolated'); assert.equal(report.head.reports.length, 14);
  assert.equal(report.summary.headCaseOccurrences, 42); assert.equal(report.summary.headPassedOccurrences, 14);
  assert.equal(report.descriptors[0].role, 'mac-isolated');
  // These are report occurrences, never claimed as an authoritative unique union.
  assert.equal(report.summary.eligibleModules, 0);
});

test('ranks actual reporter spans without changing qualification or claiming unchanged inputs reusable', (t) => {
  const f = fixture(t); f.put('README.md', 'copy change\n'); f.commit(); const lane = f.makeLane();
  const start = Date.parse(lane.lane.startedAt) + 100;
  rewriteRawReport(lane, 'web.json', (raw) => {
    raw.testResults[0].startTime = start; raw.testResults[0].endTime = start + 1250.5;
    raw.testResults[0].arbitraryMetadata = 'RAW_DIAGNOSTIC_MUST_NOT_ESCAPE';
  });
  const paths = [join(lane.directory, 'lane.json'), join(lane.directory, 'reports', 'web.json')];
  const original = paths.map((path) => hash(fs.readFileSync(path)));
  const report = collectShadow(lane.options);
  assert.deepEqual(report.timing, { scope: 'reporter-test-spans', moduleTimingCoverage: 'complete', laneElapsedMs: 60_000,
    moduleOccurrences: 1, measuredModuleOccurrences: 1, unknownModuleOccurrences: 0, testSpanSumMs: 1250.5,
    measuredUnchangedModuleOccurrences: 1, observedUnchangedTestSpanSumMs: 1250.5, rankedModules: [
      { report: 'web.json', module: 'test/example.test.ts', executedCases: 1, testSpanMs: 1250.5, unknownReason: null,
        inputComparison: 'observed-inputs-unchanged' },
    ] });
  assert.equal(report.descriptors[0].decision, 'full-required'); assert.equal(report.descriptors[0].complete, false);
  assert.equal(report.summary.eligibleModules, 0); assert.equal(report.summary.inheritedCases, 0);
  assert.deepEqual(paths.map((path) => hash(fs.readFileSync(path))), original);
  assert.equal(JSON.stringify(report).includes('RAW_DIAGNOSTIC_MUST_NOT_ESCAPE'), false);
});

for (const kind of ['missing', 'null', 'string', 'negative', 'reversed', 'before-lane', 'after-lane', 'no-executed-cases']) {
  test(`keeps ${kind} reporter timing unknown without changing case evidence`, (t) => {
    const f = fixture(t); const lane = f.makeLane(); const start = Date.parse(lane.lane.startedAt);
    rewriteRawReport(lane, 'web.json', (raw) => {
      const module = raw.testResults[0]; module.startTime = start + 1; module.endTime = start + 10;
      if (kind === 'missing') delete module.endTime;
      if (kind === 'null') module.endTime = null;
      if (kind === 'string') module.startTime = String(start);
      if (kind === 'negative') module.startTime = -1;
      if (kind === 'reversed') module.endTime = start;
      if (kind === 'before-lane') module.startTime = start - 1;
      if (kind === 'after-lane') module.endTime = Date.parse(lane.lane.finishedAt) + 1;
      if (kind === 'no-executed-cases') {
        module.assertionResults[0].status = 'skipped'; raw.numPassedTests = 0; raw.numPendingTests = 2;
      }
    });
    const report = collectShadow(lane.options);
    assert.equal(report.timing.moduleTimingCoverage, 'unknown'); assert.equal(report.timing.measuredModuleOccurrences, 0);
    assert.equal(report.timing.unknownModuleOccurrences, 1); assert.equal(report.timing.testSpanSumMs, null);
    assert.equal(report.head.reports[0].timings[0].testSpanMs, null);
    assert.ok(report.head.reports[0].timings[0].unknownReason);
    assert.equal(report.summary.headCaseOccurrences, 3); assert.equal(report.summary.eligibleModules, 0);
    assert.equal(report.descriptors[0].decision, 'full-required');
  });
}

test('keeps changed and missing-base comparison separate from measured timing', (t) => {
  const f = fixture(t); f.put('src/value.ts', 'export const value = 1;\n'); f.commit(); const lane = f.makeLane();
  const start = Date.parse(lane.lane.startedAt);
  rewriteRawReport(lane, 'web.json', (raw) => { raw.testResults[0].startTime = start; raw.testResults[0].endTime = start + 100; });
  const changed = collectShadow(lane.options);
  assert.equal(changed.timing.rankedModules[0].inputComparison, 'observed-inputs-changed');
  assert.equal(changed.timing.measuredUnchangedModuleOccurrences, 0); assert.equal(changed.timing.observedUnchangedTestSpanSumMs, null);
  const unavailable = collectShadow({ ...lane.options, baseRevision: null });
  assert.equal(unavailable.timing.rankedModules[0].inputComparison, 'unknown'); assert.equal(unavailable.timing.testSpanSumMs, 100);
  assert.equal(unavailable.summary.eligibleModules, 0);
});

test('bounds ranking and preserves filtered occurrences, partial coverage and overlapping spans', (t) => {
  const f = fixture(t); f.put('test/other.test.ts', "import { value } from '../src/value.js'; export const input = value;\n"); f.commit();
  const lane = f.makeLane('mac-isolated'); const start = Date.parse(lane.lane.startedAt);
  for (const [index, record] of lane.lane.reports.entries()) {
    rewriteRawReport(lane, record.file, (raw) => {
      const first = raw.testResults[0]; first.startTime = start + 1; first.endTime = start + 50_001;
      const other = { ...first, name: join(f.root, 'test/other.test.ts'), endTime: start + 100 + index };
      if (index === 0) delete other.startTime;
      raw.testResults.push(other); raw.numTotalTests *= 2; raw.numPassedTests *= 2; raw.numPendingTests *= 2; raw.numTodoTests *= 2;
    });
  }
  const report = collectShadow(lane.options);
  assert.equal(report.timing.moduleTimingCoverage, 'partial'); assert.equal(report.timing.moduleOccurrences, 28);
  assert.equal(report.timing.measuredModuleOccurrences, 27); assert.equal(report.timing.unknownModuleOccurrences, 1);
  assert.equal(report.timing.rankedModules.length, 20);
  const repeated = report.timing.rankedModules.filter((row) => row.module === 'test/example.test.ts');
  assert.equal(repeated.length, 14); assert.deepEqual(repeated.map((row) => row.report), reportNames('mac-isolated'));
  assert.ok(report.timing.testSpanSumMs > report.timing.laneElapsedMs, 'overlapping sums must not be clamped or presented as lane wall time');
  assert.equal(report.summary.headCaseOccurrences, 84); assert.equal(report.summary.eligibleModules, 0);
});

const repositoryMetadata = () => ({ full_name: hub.legacyName, id: hub.repositoryId, node_id: hub.repositoryNodeId,
  owner: { id: hub.ownerId, login: hub.ownerLogin }, default_branch: hub.defaultBranch, private: false, visibility: 'public' });

test('unchanged official job parser ignores advisory failure but still refuses failed required execution', () => {
  const revision = 'a'.repeat(40); const tree = 'b'.repeat(40);
  const job = { id: 5, run_id: 100, head_sha: revision, name: 'Mac exhaustive (1/4)', status: 'completed', conclusion: 'success', labels: ['macos-15'],
    steps: [{ name: 'Test complete partition', status: 'completed', conclusion: 'success' }, { name: 'Observe advisory Mac impact shadow', status: 'completed', conclusion: 'failure' }] };
  const artifact = { id: 200, name: 'qualified-build', expired: false, digest: `sha256:${'d'.repeat(64)}`, workflow_run: { id: 100, head_sha: revision } };
  const run = { id: 100, run_attempt: 1, repository: repositoryMetadata(), head_sha: revision, event: 'pull_request', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
  const options = { repository: hub.legacyName, revision, eventSha: revision, runId: 100, runAttempt: 1, artifactId: 200, artifactName: artifact.name,
    requiredJobs: [{ name: job.name, labels: ['macos-15'], steps: ['Test complete partition'] }],
    read: (endpoint) => endpoint === `repos/${hub.legacyName}` ? repositoryMetadata() : endpoint.includes('/jobs?') ? { total_count: 1, jobs: [job] } : endpoint.includes('/git/commits/') ? { sha: revision, tree: { sha: tree } } : endpoint.includes('/artifacts/') ? artifact : run };
  assert.equal(auditGithub(options).jobs[0].id, 5);
  job.steps[0].conclusion = 'failure'; assert.throws(() => auditGithub(options));
});

test('unchanged attestation selector excludes separately named shadow artifacts from accepted inputs', (t) => {
  const f = fixture(t); f.git(['remote', 'add', 'origin', f.root]);
  const revision = f.base; const tree = f.git(['rev-parse', 'HEAD^{tree}']); const names = artifactNames(100, 2);
  const artifacts = [names.producer, ...names.lanes.map((row) => row.name), 'phantom-impact-shadow-web-100-2'].map((name, index) => ({
    id: 301 + index, name, expired: false, digest: `sha256:${'a'.repeat(64)}`, workflow_run: { id: 100, head_sha: revision } }));
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master', GITHUB_REPOSITORY: hub.legacyName,
    GITHUB_REPOSITORY_ID: String(hub.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(hub.ownerId), GITHUB_SHA: revision,
    CANDIDATE_SHA: revision, CI_RUN_ID: '100', CI_RUN_ATTEMPT: '2', BUILD_ARTIFACT_ID: '301', RUNNER_TEMP: f.parent };
  const cwd = process.cwd();
  try {
    process.chdir(f.root);
    const result = prepare({ env, read: (endpoint) => {
      if (endpoint === `repos/${hub.legacyName}`) return repositoryMetadata();
      if (endpoint.includes('/git/commits/')) return { sha: revision, tree: { sha: tree } };
      if (endpoint.includes('/artifacts?')) return { total_count: artifacts.length, artifacts };
      if (endpoint.includes('/attempts/')) return { id: 100, run_attempt: 2, head_sha: revision, repository: repositoryMetadata(), path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
      throw new Error('Unexpected API lookup');
    } });
    assert.equal(result.map.lanes.length, 5); assert.equal(result.map.producer.id, 301);
    assert.equal(JSON.stringify(result.map).includes('phantom-impact-shadow'), false);
  } finally { process.chdir(cwd); }
});

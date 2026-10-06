/* global process, Buffer */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { URL } from 'node:url';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBuild, packBuild } from '../scripts/ci-pack-smoke.mjs';
import { auditGithub, captureArtifact, inspectTar, sourceBinding, isolatedScope, requiredJobPolicy, qualifyArtifact, verifyArtifact, adoptArtifact, validateAdoptedArtifact, verifyAttestation, npmCliPath } from '../../scripts/hosted-build-artifact.mjs';

const digest = (b) => createHash('sha256').update(b).digest('hex');
function tinyTar(path, data) {
  const h = Buffer.alloc(512); h.write(path); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
  h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0', 257); h.write('00', 263);
  h.write(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]);
}
function fixture(t, complete = false) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ashlr-hosted-artifact-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'root'); fs.mkdirSync(root);
  const previous = new Map(); const home = join(parent, 'home'); fs.mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'no-git'),
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, ASHLR_REPRODUCIBLE_PACKAGE: undefined,
    GITHUB_REPOSITORY: 'ashlrai/ashlr-hub', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'ci',
    GITHUB_SHA: undefined, ASHLR_CI_SOURCE_SHA: undefined, ASHLR_CI_EVENT_SHA: 'b'.repeat(40) };
  for (const [key, value] of Object.entries(env)) { previous.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet'); fs.writeFileSync(join(root, '.gitignore'), 'dist/\n');
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/hub', version: '3.24.3', files: ['dist'] }));
  fs.writeFileSync(join(root, 'package-lock.json'), '{}'); git('add', '.');
  if (complete) {
    for (const p of ['.github/workflows/ci.yml', 'scripts/test-ci-sharded.mjs', 'vitest.config.ts', 'vitest.config.web.ts']) {
      fs.mkdirSync(join(root, p, '..'), { recursive: true }); fs.copyFileSync(new URL(`../../${p}`, import.meta.url), join(root, p));
    }
    const { suites, marker } = isolatedScope(root);
    for (const p of [...suites, marker, 'src/web-ui/example.test.tsx', ...[1, 2, 3, 4].map((n) => `test/general-${n}.test.ts`)]) {
      fs.mkdirSync(join(root, p, '..'), { recursive: true }); fs.writeFileSync(join(root, p), '// synthetic fixture; never executed\n');
    }
    git('add', '.');
  }
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic');
  const revision = git('rev-parse', 'HEAD'); process.env.ASHLR_CI_SOURCE_SHA = revision;
  const write = (path, bytes) => { const full = join(root, 'dist', path); fs.mkdirSync(join(full, '..'), { recursive: true }); fs.writeFileSync(full, bytes); };
  write('build-identity.json', JSON.stringify({ schemaVersion: 1, packageVersion: '3.24.3', revision, dirty: false, provenance: 'git' }));
  for (const p of ['authority-surface.json', 'release-dependency-inventory.json', 'cli/index.js', 'api/core.js', 'api/types.js',
    'core/sandbox/claude-broker-tool-worker.js', 'core/sandbox/claude-broker-tool-invocation.js', 'core/web/public/next/.vite/manifest.json']) write(p, `built:${p}`);
  const snapshot = captureBuild({ root, eventSha: revision, parent });
  const packageTarball = join(parent, 'package.tgz');
  const packaged = [tinyTar('package/package.json', fs.readFileSync(join(root, 'package.json'))).subarray(0, -1024)];
  for (const entry of JSON.parse(fs.readFileSync(snapshot)).dist.filter((row) => row.type === 'file')) {
    packaged.push(tinyTar(`package/dist/${entry.path}`, fs.readFileSync(join(root, 'dist', entry.path))).subarray(0, -1024));
  }
  fs.writeFileSync(packageTarball, gzipSync(Buffer.concat([...packaged, Buffer.alloc(1024)])));
  const out = join(parent, 'artifact');
  const graph = { name: '@ashlr/hub', version: '3.24.3' };
  const options = { root, sha: revision, snapshot, packageTarball, out, tools: () => ({ node: { version: 'v22.22.3', sha256: 'a'.repeat(64) },
    npm: { version: '11.15.0', sha256: 'b'.repeat(64) }, platform: 'linux', arch: 'x64', dependencyGraph: { graph, sha256: digest(JSON.stringify(graph)) } }) };
  return { ...options, options, write, git, parent };
}

function laneFiles(f, role, directory) {
  fs.mkdirSync(join(directory, 'reports'), { recursive: true });
  const scope = isolatedScope(f.root);
  const files = role === 'web' ? [{ file: 'web.json', module: 'src/web-ui/example.test.tsx' }] : role === 'mac-isolated' ?
    [...scope.suites, scope.marker, scope.marker].map((module, i) => ({ file: `isolated-${String(i + 1).padStart(2, '0')}.json`, module })) :
    [{ file: `general-${role.at(-1)}-of-4.json`, module: `test/general-${role.at(-1)}.test.ts` }];
  const reports = files.map(({ file, module }, index) => {
    const rows = module === scope.marker ? ['automatic seed measurement: false', 'automatic seed measurement: true'].map((fullName, j) =>
      ({ fullName, status: j === index - 12 ? 'passed' : 'skipped', failureMessages: [] })) :
      [{ fullName: 'parameterized case', status: 'passed', failureMessages: [] }, { fullName: 'parameterized case', status: 'passed', failureMessages: [] }];
    const raw = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: rows.length, numPassedTests: rows.filter((r) => r.status === 'passed').length,
      numPendingTests: rows.filter((r) => r.status === 'skipped').length, numTodoTests: 0,
      testResults: [{ name: join(f.root, module), status: 'passed', message: '', assertionResults: rows }] };
    const bytes = Buffer.from(JSON.stringify(raw)); fs.writeFileSync(join(directory, 'reports', file), bytes);
    const occurrences = new Map();
    return { file, bytes: bytes.length, sha256: digest(bytes), modules: [{ file: module, cases: rows.map((row) => {
      const occurrence = occurrences.get(row.fullName) ?? 0; occurrences.set(row.fullName, occurrence + 1);
      return { id: digest(`${module}\0${row.fullName}\0${occurrence}`), name: row.fullName, state: row.status };
    }) }] };
  });
  const lane = { schemaVersion: 1, role, source: { revision: f.sha, tree: f.git('rev-parse', 'HEAD^{tree}'), eventSha: 'b'.repeat(40) }, run: { id: '100', attempt: '1' },
    nodeVersion: 'v22.22.3', startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:00:01Z', exitCode: 0, reports };
  fs.writeFileSync(join(directory, 'lane.json'), JSON.stringify(lane)); return directory;
}
function qualifiedFixture(t) {
  const f = fixture(t, true); const web = laneFiles(f, 'web', join(f.parent, 'web')); f.options.reports = [join(web, 'lane.json')];
  captureArtifact(f.options);
  const repository = 'ashlrai/ashlr-hub', tree = f.git('rev-parse', 'HEAD^{tree}'), attestorSha = 'c'.repeat(40);
  const roles = ['mac-general-1', 'mac-general-2', 'mac-general-3', 'mac-general-4', 'mac-isolated'];
  const artifactMap = { producer: { id: 200, name: 'ashlr-build-100-1', digest: `sha256:${'d'.repeat(64)}` }, lanes: roles.map((role, i) =>
    ({ role, id: 201 + i, name: `ashlr-qualification-${role}-100-1`, digest: `sha256:${String(i + 1).repeat(64)}` })) };
  for (const role of roles) laneFiles(f, role, join(f.out, 'coverage', role));
  const jobs = requiredJobPolicy(f.root).map((required, index) => ({ id: index + 10, run_id: 100, head_sha: f.sha, name: required.name, labels: required.labels,
    status: 'completed', conclusion: 'success', steps: required.steps.map((name) => ({ name, status: 'completed', conclusion: 'success' })) }));
  const read = (endpoint) => {
    if (endpoint.includes('/git/commits/')) return { sha: endpoint.split('/').at(-1), tree: { sha: tree } };
    if (endpoint.endsWith('/branches/master')) return { commit: { sha: attestorSha } };
    if (endpoint.includes('/jobs?')) return { total_count: jobs.length, jobs };
    if (endpoint.includes('/artifacts/')) {
      const ref = [artifactMap.producer, ...artifactMap.lanes].find((r) => r.id === Number(endpoint.split('/').at(-1)));
      return { ...ref, expired: false, workflow_run: { id: 100, head_sha: f.sha } };
    }
    const attestor = endpoint.includes('/runs/300/');
    return { id: attestor ? 300 : 100, run_attempt: 1, repository: { full_name: repository }, head_sha: attestor ? attestorSha : f.sha,
      event: attestor ? 'workflow_dispatch' : 'pull_request', path: attestor ? '.github/workflows/attest-ci-build.yml' : '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
  };
  const qualification = qualifyArtifact({ root: f.root, revision: f.sha, bundle: f.out, artifactMap, runId: 100, runAttempt: 1, read });
  const calls = [];
  const attestRun = (bin, args) => {
    assert.equal(bin, 'gh'); assert.ok(args.includes('--deny-self-hosted-runners')); assert.ok(args.includes('--source-digest'));
    calls.push(args);
    return JSON.stringify([{ verificationResult: { statement: { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ digest: { sha256: digest(fs.readFileSync(args[2])) } }], predicate: { runDetails: { metadata: { invocationId: `https://github.com/${repository}/actions/runs/300/attempts/1` } } } } } }]);
  };
  const options = { root: f.root, revision: f.sha, bundle: f.out, githubRead: read, attestRun,
    policy: { runId: 100, runAttempt: 1, attestorSha, attestorRun: 300, attestorAttempt: 1 } };
  return { ...f, options, qualification, jobs, calls };
}

test('complete official coverage and three signed subjects permit exact transactional adoption; JSON cannot authorize', (t) => {
  const f = qualifiedFixture(t); const receipt = verifyArtifact(f.options); assert.equal(f.calls.length, 3);
  assert.throws(() => adoptArtifact(JSON.parse(JSON.stringify(receipt))), /live verified/);
  fs.rmSync(join(f.root, 'dist'), { recursive: true }); adoptArtifact(receipt);
  assert.equal(fs.readFileSync(join(f.root, 'dist/api/core.js'), 'utf8'), 'built:api/core.js');
  assert.equal(f.git('status', '--porcelain'), ''); assert.throws(() => adoptArtifact(receipt), /live verified/);
});
for (const kind of ['failed official job', 'raw report changed', 'qualification changed', 'source changed', 'signature refused']) {
  test(`complete verification refuses ${kind}`, (t) => {
    const f = qualifiedFixture(t);
    if (kind === 'failed official job') f.jobs[0].conclusion = 'failure';
    if (kind === 'raw report changed') fs.appendFileSync(join(f.out, 'coverage/mac-general-1/reports/general-1-of-4.json'), ' ');
    if (kind === 'qualification changed') { const q = { ...f.qualification, subjects: { ...f.qualification.subjects, packageSha256: '0'.repeat(64) } }; fs.chmodSync(join(f.out, 'qualification.json'), 0o600); fs.writeFileSync(join(f.out, 'qualification.json'), JSON.stringify(q)); }
    if (kind === 'source changed') fs.writeFileSync(join(f.root, 'package-lock.json'), 'changed');
    if (kind === 'signature refused') f.options.attestRun = () => { throw new Error('signature unavailable'); };
    assert.throws(() => verifyArtifact(f.options)); assert.ok(fs.existsSync(join(f.root, 'dist')));
  });
}
test('adoption refuses changed source or appearing dist and leaves original output intact', (t) => {
  const f = qualifiedFixture(t); const receipt = verifyArtifact(f.options);
  assert.throws(() => adoptArtifact(receipt), /already exists/); assert.equal(fs.readFileSync(join(f.root, 'dist/api/core.js'), 'utf8'), 'built:api/core.js');
  const fresh = verifyArtifact(f.options); fs.rmSync(join(f.root, 'dist'), { recursive: true }); fs.writeFileSync(join(f.root, 'package-lock.json'), 'changed');
  assert.throws(() => adoptArtifact(fresh), /source changed/); assert.equal(fs.existsSync(join(f.root, 'dist')), false);
  assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('.ashlr-hosted-stage-')), false);
});
test('native reuse validates actual dist against live hosted proof and refuses tampered bytes or saved receipts', (t) => {
  const f = qualifiedFixture(t); const receipt = verifyArtifact(f.options);
  assert.equal(validateAdoptedArtifact(receipt), receipt);
  assert.throws(() => validateAdoptedArtifact(receipt), /live verified/);
  assert.throws(() => validateAdoptedArtifact(JSON.parse(JSON.stringify(receipt))), /live verified/);
  const fresh = verifyArtifact(f.options); f.write('api/core.js', 'tampered built bytes');
  assert.throws(() => validateAdoptedArtifact(fresh), /differ/);
});
test('verified receipt hashes and nested official proof cannot be mutated to admit changed bundle bytes', (t) => {
  const f = qualifiedFixture(t); const receipt = verifyArtifact(f.options);
  assert.throws(() => { receipt.packageSha256 = '0'.repeat(64); }, TypeError);
  assert.throws(() => { receipt.official.jobs[0].id = 1; }, TypeError);
  fs.chmodSync(join(f.out, 'manifest.json'), 0o600); fs.appendFileSync(join(f.out, 'manifest.json'), ' ');
  fs.rmSync(join(f.root, 'dist'), { recursive: true }); assert.throws(() => adoptArtifact(receipt));
  assert.equal(fs.existsSync(join(f.root, 'dist')), false);
});
test('attestation proof binds exact signed invocation, not another successful run', (t) => {
  const f = fixture(t); const path = f.packageTarball;
  assert.throws(() => verifyAttestation({ path, repository: 'ashlrai/ashlr-hub', attestorSha: 'a'.repeat(40), attestorRun: 300, attestorAttempt: 1,
    run: () => JSON.stringify([{ verificationResult: { statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ digest: { sha256: digest(fs.readFileSync(path)) } }], predicate: {} } } }]) }), /expected subject/);
});

test('capture preserves hidden build files, exact bytes and modes, candidate identity and immutable output', (t) => {
  const f = fixture(t); const manifest = captureArtifact(f.options);
  assert.equal(manifest.source.revision, f.sha); assert.equal(manifest.producer.eventSha, 'b'.repeat(40));
  assert.equal(manifest.archive.sha256, digest(fs.readFileSync(join(f.out, 'dist.tar'))));
  assert.ok(manifest.archive.entries.some((r) => r.path.endsWith('/.vite/manifest.json')));
  assert.equal(manifest.package.sha256, digest(fs.readFileSync(f.packageTarball)));
  assert.ok(manifest.package.entries.some((r) => r.path === 'package/dist/build-identity.json'));
  assert.throws(() => captureArtifact(f.options), /already exists/);
});

for (const kind of ['changed build', 'dirty source', 'source revision', 'build symlink', 'special bits']) {
  test(`capture refuses ${kind} without creating output`, (t) => {
    const f = fixture(t);
    if (kind === 'changed build') f.write('api/core.js', 'changed');
    if (kind === 'dirty source') fs.writeFileSync(join(f.root, 'package-lock.json'), '{"changed":true}');
    if (kind === 'source revision') f.options.sha = 'a'.repeat(40);
    if (kind === 'build symlink') { fs.rmSync(join(f.root, 'dist/api/core.js')); fs.symlinkSync(join(f.root, 'package.json'), join(f.root, 'dist/api/core.js')); }
    if (kind === 'special bits') fs.chmodSync(join(f.root, 'dist/api/core.js'), 0o1644);
    assert.throws(() => captureArtifact(f.options)); assert.equal(fs.existsSync(f.out), false);
  });
}

for (const path of ['../escape', '/absolute', 'dist/../escape', 'dist//file', 'dist/back\\slash']) {
  test(`archive refuses path ${path}`, () => assert.throws(() => inspectTar(tinyTar(path, Buffer.from('x'))), /unsafe/));
}
test('archive refuses duplicate entries, links, checksum corruption and wrong bytes before extraction', () => {
  const bytes = tinyTar('dist/file', Buffer.from('x')); const entries = inspectTar(bytes);
  assert.throws(() => inspectTar(Buffer.concat([bytes.subarray(0, 1024), bytes])), /duplicate/);
  const link = Buffer.from(bytes); link[156] = 50; assert.throws(() => inspectTar(link));
  const corrupt = Buffer.from(bytes); corrupt[0] ^= 1; assert.throws(() => inspectTar(corrupt), /corrupt/);
  const changed = Buffer.from(bytes); changed[512] = 121; assert.throws(() => inspectTar(changed, entries), /differ/);
});

function official() {
  const revision = 'a'.repeat(40), eventSha = 'b'.repeat(40), tree = 'c'.repeat(40);
  const job = { id: 5, run_id: 100, head_sha: revision, name: 'Mac exhaustive (1/4)', status: 'completed', conclusion: 'success',
    labels: ['macos-15'], steps: [{ name: 'Test complete partition', status: 'completed', conclusion: 'success' }] };
  const run = { id: 100, run_attempt: 1, repository: { full_name: 'ashlrai/ashlr-hub' }, head_sha: revision, event: 'pull_request', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
  const artifact = { id: 200, name: 'qualified-build', expired: false, digest: `sha256:${'d'.repeat(64)}`, workflow_run: { id: 100, head_sha: revision } };
  const input = { repository: 'ashlrai/ashlr-hub', revision, eventSha, runId: 100, runAttempt: 1, artifactId: 200, artifactName: artifact.name,
    requiredJobs: [{ name: job.name, labels: ['macos-15'], steps: ['Test complete partition'] }],
    read: (endpoint) => endpoint.includes('/jobs?') ? { total_count: 1, jobs: [job] } : endpoint.includes('/git/commits/') ? { sha: endpoint.split('/').at(-1), tree: { sha: tree } } : endpoint.includes('/artifacts/') ? artifact : run };
  return { input, job, run, artifact };
}
test('GitHub audit uses exact official run attempt, merge-tree and required successful job/step', () => {
  const f = official(); assert.equal(auditGithub(f.input).jobs[0].id, 5);
});
for (const kind of ['failed run', 'wrong attempt', 'expired artifact', 'wrong artifact source', 'skipped step', 'self hosted', 'missing job']) {
  test(`GitHub audit refuses ${kind}`, () => {
    const f = official();
    if (kind === 'failed run') f.run.conclusion = 'failure';
    if (kind === 'wrong attempt') f.run.run_attempt = 2;
    if (kind === 'expired artifact') f.artifact.expired = true;
    if (kind === 'wrong artifact source') f.artifact.workflow_run.head_sha = 'c'.repeat(40);
    if (kind === 'skipped step') f.job.steps[0].conclusion = 'skipped';
    if (kind === 'self hosted') f.job.labels.push('self-hosted');
    if (kind === 'missing job') f.job.name = 'other';
    assert.throws(() => auditGithub(f.input));
  });
}
test('source binding changes on tracked lock/config drift', (t) => {
  const f = fixture(t); const before = sourceBinding(f.root, f.sha);
  assert.ok(before.inputs.some((r) => r.path === 'package-lock.json'));
  fs.writeFileSync(join(f.root, 'package-lock.json'), 'changed'); assert.throws(() => sourceBinding(f.root, f.sha));
});

test('actual lifecycle-off npm pack preserves the admitted complete build, including long paths and hidden manifest', (t) => {
  const f = fixture(t);
  f.write(`core/${'long-directory-'.repeat(6)}/nested/${'long-file-'.repeat(5)}.js`, 'long-path bytes');
  const snapshot = captureBuild({ root: f.root, eventSha: f.sha, parent: f.parent });
  const npm = npmCliPath();
  const tarball = packBuild({ root: f.root, eventSha: f.sha, snapshotPath: snapshot, parent: f.parent,
    runNpm: (_bin, args, options) => execFileSync(process.execPath, [npm, ...args], { ...options,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: join(f.parent, 'no-global-npm'), NPM_CONFIG_CACHE: join(f.parent, 'npm-cache'),
        NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' } }) });
  const manifest = captureArtifact({ ...f.options, snapshot, packageTarball: tarball, tools: undefined });
  assert.equal(manifest.tools.dependencyGraph.graph.name, '@ashlr/hub');
  assert.equal(manifest.tools.dependencyGraph.sha256, digest(JSON.stringify(manifest.tools.dependencyGraph.graph)));
  assert.ok(manifest.package.entries.some((entry) => entry.path.includes('long-directory-')));
  assert.ok(manifest.package.entries.some((entry) => entry.path.endsWith('/.vite/manifest.json')));
});

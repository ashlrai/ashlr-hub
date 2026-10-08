/* global process, Buffer */
// Shared inert fixture builders only; importing this file registers no tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { URL } from 'node:url';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUB_REPOSITORY_IDENTITY as hub } from '../../scripts/github-repository-binding.mjs';
import { captureBuild } from '../../scripts/ci-pack-smoke.mjs';
import { captureArtifact, isolatedScope, requiredJobPolicy, qualifyArtifact } from '../../../scripts/hosted-build-artifact.mjs';

export const metadata = (repository = hub.legacyName) => ({ full_name: repository, id: hub.repositoryId, node_id: hub.repositoryNodeId,
  owner: { id: hub.ownerId, login: hub.ownerLogin }, default_branch: hub.defaultBranch, private: false, visibility: 'public' });

export const digest = (b) => createHash('sha256').update(b).digest('hex');
export function tinyTar(path, data) {
  const h = Buffer.alloc(512); h.write(path); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
  h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0', 257); h.write('00', 263);
  h.write(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]);
}
export function fixture(t, complete = false, repository = hub.legacyName, packageName = repository === hub.renamedName ? '@ashlr/phantom' : '@ashlr/hub') {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ashlr-hosted-artifact-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'root'); fs.mkdirSync(root);
  const previous = new Map(); const home = join(parent, 'home'); fs.mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'no-git'),
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, ASHLR_REPRODUCIBLE_PACKAGE: undefined,
    GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: String(hub.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(hub.ownerId), GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'ci',
    GITHUB_SHA: undefined, ASHLR_CI_SOURCE_SHA: undefined, ASHLR_CI_EVENT_SHA: 'b'.repeat(40) };
  for (const [key, value] of Object.entries(env)) { previous.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet'); fs.writeFileSync(join(root, '.gitignore'), 'dist/\n');
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: packageName, version: '3.24.3', files: ['dist'] }));
  fs.writeFileSync(join(root, 'package-lock.json'), '{}'); git('add', '.');
  if (complete) {
    for (const p of ['.github/workflows/ci.yml', 'scripts/test-ci-sharded.mjs', 'vitest.config.ts', 'vitest.config.web.ts']) {
      fs.mkdirSync(join(root, p, '..'), { recursive: true }); fs.copyFileSync(new URL(`../../../${p}`, import.meta.url), join(root, p));
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
  const graph = { name: packageName, version: '3.24.3' };
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
export function qualifiedFixture(t, { repository = hub.legacyName, schemaVersion = 2 } = {}) {
  const f = fixture(t, true, repository); const web = laneFiles(f, 'web', join(f.parent, 'web')); f.options.reports = [join(web, 'lane.json')];
  captureArtifact(f.options);
  if (schemaVersion === 1) {
    const path = join(f.out, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(path));
    manifest.schemaVersion = 1; delete manifest.producer.repositoryId; delete manifest.producer.ownerId;
    fs.chmodSync(path, 0o600); fs.writeFileSync(path, `${JSON.stringify(manifest)}\n`);
  }
  const tree = f.git('rev-parse', 'HEAD^{tree}'), attestorSha = 'c'.repeat(40);
  const roles = ['mac-general-1', 'mac-general-2', 'mac-general-3', 'mac-general-4', 'mac-isolated'];
  const artifactMap = { producer: { id: 200, name: 'ashlr-build-100-1', digest: `sha256:${'d'.repeat(64)}` }, lanes: roles.map((role, i) =>
    ({ role, id: 201 + i, name: `ashlr-qualification-${role}-100-1`, digest: `sha256:${String(i + 1).repeat(64)}` })) };
  for (const role of roles) laneFiles(f, role, join(f.out, 'coverage', role));
  const jobs = requiredJobPolicy(f.root).map((required, index) => ({ id: index + 10, run_id: 100, head_sha: f.sha, name: required.name, labels: required.labels,
    status: 'completed', conclusion: 'success', steps: required.steps.map((name) => ({ name, status: 'completed', conclusion: 'success' })) }));
  const api = { metadata: metadata(repository), producerRepo: metadata(repository), attestorRepo: metadata(repository) };
  const read = (endpoint) => {
    if (endpoint === `repos/${repository}`) return api.metadata;
    if (endpoint.includes('/git/commits/')) return { sha: endpoint.split('/').at(-1), tree: { sha: tree } };
    if (endpoint.endsWith('/branches/master')) return { commit: { sha: attestorSha } };
    if (endpoint.includes('/jobs?')) return { total_count: jobs.length, jobs };
    if (endpoint.includes('/artifacts/')) {
      const ref = [artifactMap.producer, ...artifactMap.lanes].find((r) => r.id === Number(endpoint.split('/').at(-1)));
      return { ...ref, expired: false, workflow_run: { id: 100, head_sha: f.sha } };
    }
    const attestor = endpoint.includes('/runs/300/');
    return { id: attestor ? 300 : 100, run_attempt: 1, repository: attestor ? api.attestorRepo : api.producerRepo, head_sha: attestor ? attestorSha : f.sha,
      event: attestor ? 'workflow_dispatch' : 'pull_request', path: attestor ? '.github/workflows/attest-ci-build.yml' : '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
  };
  const qualification = qualifyArtifact({ root: f.root, revision: f.sha, bundle: f.out, artifactMap, runId: 100, runAttempt: 1, read });
  const calls = [];
  const attestRun = (bin, args) => {
    assert.equal(bin, 'gh'); assert.equal(args[args.indexOf('--repo') + 1], repository);
    assert.equal(args[args.indexOf('--signer-workflow') + 1], `${repository}/.github/workflows/attest-ci-build.yml`);
    assert.ok(args.includes('--deny-self-hosted-runners')); assert.ok(args.includes('--source-digest'));
    calls.push(args);
    return JSON.stringify([{ verificationResult: { statement: { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ digest: { sha256: digest(fs.readFileSync(args[2])) } }], predicate: { runDetails: { metadata: { invocationId: `https://github.com/${repository}/actions/runs/300/attempts/1` } } } } } }]);
  };
  const options = { root: f.root, revision: f.sha, bundle: f.out, githubRead: read, attestRun,
    policy: { runId: 100, runAttempt: 1, attestorSha, attestorRun: 300, attestorAttempt: 1 } };
  return { ...f, options, qualification, jobs, calls, api };
}


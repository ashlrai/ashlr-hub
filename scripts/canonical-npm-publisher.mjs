#!/usr/bin/env node
/* global fetch, AbortSignal, setTimeout */
// Executed only from protected master. Candidate source and archives are data;
// admission never runs their build, installation or lifecycle scripts.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyArtifact, assertEffectiveManualProtection} from './hosted-build-artifact.mjs';
import {requireProducerEnvironment, requireRepositoryMetadata, requireRepositoryReference} from '../.github/scripts/github-repository-binding.mjs';
import {readBoundedJson, verifyNpmReleaseProvenance} from './verify-npm-release-provenance.mjs';
import {verifyUpdateAudit} from './finalize-desktop-update.mjs';

const REPO = 'ashlrai/phantom';
const PACKAGE = '@ashlr/phantom';
const sha = value => createHash('sha256').update(value).digest('hex');
const integer = value => {assert.match(value ?? '', /^[1-9][0-9]*$/); const n = Number(value); assert.ok(Number.isSafeInteger(n)); return n;};
const git = (...args) => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}).trim();
const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}));

export function publisherInput(env) {
  assert.equal(requireProducerEnvironment(env).repository, REPO);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/master');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.CANDIDATE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.VERSION ?? '', /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  return {revision: env.CANDIDATE_SHA, version: env.VERSION,
    runId: integer(env.CI_RUN_ID), runAttempt: integer(env.CI_RUN_ATTEMPT),
    attestorSha: env.GITHUB_SHA, attestorRun: integer(env.ATTESTOR_RUN_ID),
    attestorAttempt: integer(env.ATTESTOR_RUN_ATTEMPT), artifactId: integer(env.ATTESTED_ARTIFACT_ID),
    auditRun: integer(env.AUDIT_RUN_ID), auditAttempt: integer(env.AUDIT_RUN_ATTEMPT)};
}

export function bindAttestedArtifact(input, run, artifact) {
  requireRepositoryReference(REPO, run.repository);
  assert.equal(run.id, input.attestorRun); assert.equal(run.run_attempt, input.attestorAttempt);
  assert.equal(run.head_sha, input.attestorSha); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.path, '.github/workflows/attest-ci-build.yml');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(artifact.id, input.artifactId); assert.equal(artifact.expired, false);
  assert.equal(artifact.name, `ashlr-attested-${input.runId}-${input.runAttempt}-${input.attestorRun}-${input.attestorAttempt}`);
  assert.equal(artifact.workflow_run?.id, input.attestorRun);
  assert.equal(artifact.workflow_run?.head_sha, input.attestorSha);
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  return artifact;
}

export function prepare(env = process.env, read = api) {
  const input = publisherInput(env);
  assert.equal(git('rev-parse', 'HEAD'), input.attestorSha);
  assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '');
  requireRepositoryMetadata(REPO, read(`repos/${REPO}`));
  assert.equal(assertEffectiveManualProtection(REPO, read(`repos/${REPO}/branches/master`), read(`repos/${REPO}/rules/branches/master`)), input.attestorSha);
  bindAttestedArtifact(input, read(`repos/${REPO}/actions/runs/${input.attestorRun}/attempts/${input.attestorAttempt}`), read(`repos/${REPO}/actions/artifacts/${input.artifactId}`));
  const directory = fs.mkdtempSync(join(fs.realpathSync(env.RUNNER_TEMP), 'phantom-npm-')); fs.chmodSync(directory, 0o700);
  git('fetch', '--no-tags', 'origin', input.revision);
  git('worktree', 'add', '--detach', join(directory, 'candidate'), input.revision);
  fs.writeFileSync(join(directory, 'input.json'), JSON.stringify(input), {mode: 0o600, flag: 'wx'});
  fs.appendFileSync(env.GITHUB_OUTPUT, `directory=${directory}\nartifact_id=${input.artifactId}\n`);
  return directory;
}

export function acceptPackageIdentity(input, pkg, receipt, bytes) {
  assert.equal(pkg.name, PACKAGE); assert.equal(pkg.version, input.version);
  assert.equal(pkg.repository?.url, 'git+https://github.com/ashlrai/phantom.git');
  assert.equal(receipt.source.revision, input.revision);
  assert.equal(sha(bytes), receipt.packageSha256);
  return {schemaVersion: 1, name: PACKAGE, version: input.version,
    filename: `ashlr-phantom-${input.version}.tgz`, sha256: sha(bytes),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    candidateRevision: input.revision, attestor: receipt.attestor,
    producer: {runId: input.runId, runAttempt: input.runAttempt}};
}

export function admit(directory, env = process.env) {
  const input = readBoundedJson(join(directory, 'input.json'));
  assert.deepEqual(input, publisherInput(env));
  const root = join(directory, 'candidate'), bundle = join(directory, 'bundle');
  const receipt = verifyArtifact({root, revision: input.revision, bundle, policy: input});
  verifyUpdateAudit({root, repository: REPO, revision: input.revision, runId: input.auditRun, runAttempt: input.auditAttempt, read: api});
  const manifest = readBoundedJson(join(bundle, 'manifest.json'));
  assert.equal(manifest.package.filename, `ashlr-phantom-${input.version}.tgz`);
  const bytes = fs.readFileSync(join(bundle, manifest.package.filename));
  const accepted = acceptPackageIdentity(input, readBoundedJson(join(root, 'package.json')), receipt, bytes);
  const out = join(directory, 'accepted'); fs.mkdirSync(out, {mode: 0o700});
  fs.writeFileSync(join(out, accepted.filename), bytes, {flag: 'wx', mode: 0o600});
  const admission = Buffer.from(JSON.stringify(accepted));
  fs.writeFileSync(join(out, 'admission.json'), admission, {flag: 'wx', mode: 0o600});
  fs.appendFileSync(env.GITHUB_OUTPUT, `directory=${out}\nadmission_sha256=${sha(admission)}\npackage_sha256=${accepted.sha256}\n`);
  return accepted;
}

export function verifyHandoff(directory, expectedAdmissionHash, expectedPackageHash) {
  assert.match(expectedAdmissionHash, /^[a-f0-9]{64}$/); assert.match(expectedPackageHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readdirSync(directory).sort().filter(name => name !== 'admission.json').length, 1);
  const manifestPath = join(directory, 'admission.json');
  const record = readBoundedJson(manifestPath);
  assert.equal(sha(fs.readFileSync(manifestPath)), expectedAdmissionHash);
  assert.equal(record.schemaVersion, 1); assert.equal(record.name, PACKAGE);
  assert.match(record.version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.equal(record.filename, `ashlr-phantom-${record.version}.tgz`);
  const path = join(directory, record.filename); const stat = fs.lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 128 * 1024 * 1024);
  const data = fs.readFileSync(path);
  assert.equal(sha(data), expectedPackageHash); assert.equal(record.sha256, expectedPackageHash);
  assert.equal(record.integrity, `sha512-${createHash('sha512').update(data).digest('base64')}`);
  return record;
}

export function assertRegistryPackage(record, metadata, bytes) {
  assert.equal(metadata.name, record.name); assert.equal(metadata.version, record.version);
  assert.equal(metadata.dist?.integrity, record.integrity);
  assert.equal(metadata.dist?.attestations?.provenance?.predicateType, 'https://slsa.dev/provenance/v1');
  assert.equal(sha(bytes), record.sha256);
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, record.integrity);
  return true;
}

export function assertLatestPromotion(version, latest) {
  const parts = value => {
    assert.match(value ?? '', /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
    const result = value.split('.').map(Number); assert.ok(result.every(Number.isSafeInteger)); return result;
  };
  const next = parts(version), current = parts(latest);
  for (let i = 0; i < 3; i++) {if (next[i] > current[i]) return; assert.ok(next[i] === current[i], 'refusing latest downgrade');}
}

/** Derive the real prior invocation only from a signature-audited subject, then
 * bind it to fresh official workflow metadata. A rerun cannot rewrite history. */
export function verifyCanonicalProvenance(record, audit, revision, currentRun, currentAttempt, read = api) {
  assert.ok(Array.isArray(audit?.verified));
  const invocations = new Set();
  for (const item of audit.verified) {
    if (item.name !== record.name || item.version !== record.version) continue;
    for (const bundle of item.attestationBundles ?? []) {
      if (bundle.predicateType !== 'https://slsa.dev/provenance/v1') continue;
      const payload = bundle.bundle?.dsseEnvelope?.payload;
      assert.equal(typeof payload, 'string'); assert.ok(payload.length <= 32 * 1024 * 1024);
      const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      const uri = statement.predicate?.runDetails?.metadata?.invocationId;
      assert.match(uri ?? '', /^https:\/\/github\.com\/ashlrai\/phantom\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/);
      invocations.add(uri);
    }
  }
  assert.equal(invocations.size, 1, 'ambiguous npm publisher invocation');
  const uri = [...invocations][0], match = /\/runs\/(\d+)\/attempts\/(\d+)$/.exec(uri);
  const runId = match[1], runAttempt = match[2]; integer(runId); integer(runAttempt);
  verifyNpmReleaseProvenance({audit, packageName: record.name, version: record.version, integrity: record.integrity,
    repository: 'https://github.com/ashlrai/phantom', workflowPath: '.github/workflows/publish-canonical-npm.yml',
    ref: 'refs/heads/master', revision, runId, runAttempt, eventName: 'workflow_dispatch'});
  const base = `repos/${REPO}`;
  requireRepositoryMetadata(REPO, read(base));
  const observed = read(`${base}/actions/runs/${runId}/attempts/${runAttempt}`);
  requireRepositoryReference(REPO, observed.repository);
  assert.equal(observed.id, Number(runId)); assert.equal(observed.run_attempt, Number(runAttempt));
  assert.equal(observed.head_sha, revision); assert.equal(observed.head_branch, 'master');
  assert.equal(observed.path, '.github/workflows/publish-canonical-npm.yml'); assert.equal(observed.event, 'workflow_dispatch');
  if (runId !== currentRun || runAttempt !== currentAttempt) assert.equal(observed.status, 'completed');
  const jobs = read(`${base}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`);
  assert.ok(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length <= 100);
  const admissions = jobs.jobs.filter(job => job.name === 'admit');
  assert.equal(admissions.length, 1); assert.equal(admissions[0].conclusion, 'success');
  assert.equal(admissions[0].head_sha, revision);
  return {runId, runAttempt};
}

class RegistryReadPending extends Error {}
async function registryFetch(url, timeoutMs = 30_000) {
  let response;
  try {response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});}
  catch {throw new RegistryReadPending('Public registry read unavailable');}
  if ([404, 408, 429].includes(response.status) || response.status >= 500) {
    throw new RegistryReadPending('Public registry is still processing or unavailable');
  }
  assert.equal(response.status, 200);
  return response;
}

async function registry(record, directory) {
  const response = await registryFetch(`https://registry.npmjs.org/@ashlr%2Fphantom/${record.version}`);
  const metadata = await response.json();
  const url = new URL(metadata.dist?.tarball);
  assert.equal(url.origin, 'https://registry.npmjs.org');
  assert.equal(url.pathname, `/@ashlr/phantom/-/phantom-${record.version}.tgz`);
  const archive = await registryFetch(url);
  const bytes = Buffer.from(await archive.arrayBuffer());
  assertRegistryPackage(record, metadata, bytes);
  fs.writeFileSync(join(directory, 'registry-metadata.json'), JSON.stringify(metadata), {mode: 0o600});
}

/** Wait only for transient public reads; substituted bytes or metadata hold immediately. */
export async function reconcileRegistry(record, directory) {
  // npm may accept HTTP 202 well before public visibility. This never republishes.
  const deadline = Date.now() + 15 * 60_000;
  let delay = 2000;
  for (;;) {
    try {await registry(record, directory); return;}
    catch (error) {
      const remaining = deadline - Date.now();
      if (!(error instanceof RegistryReadPending) || remaining <= 0) throw error;
      await new Promise(done => setTimeout(done, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/** Read back one completed promotion; never repeats a publication or tag write. */
export async function reconcileLatest(record) {
  assert.equal(record.name, PACKAGE);
  assertLatestPromotion(record.version, record.version);
  const deadline = Date.now() + 2 * 60_000;
  let delay = 2000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RegistryReadPending('Latest promotion not confirmed; reconcile public state before any new mutation');
    try {
      const response = await registryFetch('https://registry.npmjs.org/@ashlr%2Fphantom', Math.min(30_000, remaining));
      const packument = await response.json();
      assert.equal(packument.name, PACKAGE);
      const latest = packument['dist-tags']?.latest;
      // A later stable version is not stale success and must never be overwritten.
      assertLatestPromotion(record.version, latest);
      if (latest === record.version) return packument;
      throw new RegistryReadPending('Public latest still precedes the admitted version');
    } catch (error) {
      const waitRemaining = deadline - Date.now();
      if (!(error instanceof RegistryReadPending) || waitRemaining <= 0) throw error;
      await new Promise(done => setTimeout(done, Math.min(delay, waitRemaining)));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory] = process.argv.slice(2);
  if (command === 'prepare') prepare();
  else if (command === 'admit') admit(directory);
  else if (command === 'handoff') {
    const record = verifyHandoff(directory, process.env.ADMISSION_SHA256, process.env.PACKAGE_SHA256);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${record.version}\nfilename=${record.filename}\nintegrity=${record.integrity}\n`);
  } else if (command === 'registry') {
    const record = verifyHandoff(directory, process.env.ADMISSION_SHA256, process.env.PACKAGE_SHA256);
    await reconcileRegistry(record, process.env.RUNNER_TEMP);
  } else if (command === 'provenance') {
    const record = verifyHandoff(directory, process.env.ADMISSION_SHA256, process.env.PACKAGE_SHA256);
    console.log(JSON.stringify(verifyCanonicalProvenance(record, readBoundedJson(join(process.env.RUNNER_TEMP, 'phantom-signatures.json')), process.env.GITHUB_SHA, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT)));
  } else if (command === 'latest') {
    const record = verifyHandoff(directory, process.env.ADMISSION_SHA256, process.env.PACKAGE_SHA256);
    const packument = readBoundedJson(join(process.env.RUNNER_TEMP, 'phantom-packument.json'));
    assertLatestPromotion(record.version, packument['dist-tags']?.latest);
  } else if (command === 'latest-readback') {
    const record = verifyHandoff(directory, process.env.ADMISSION_SHA256, process.env.PACKAGE_SHA256);
    const packument = await reconcileLatest(record);
    fs.writeFileSync(join(process.env.RUNNER_TEMP, 'phantom-packument-after.json'), JSON.stringify(packument), {mode: 0o600});
  } else throw new Error('unknown canonical publisher command');
}

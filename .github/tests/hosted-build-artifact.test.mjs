/* global process, Buffer, structuredClone */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';
import * as fs from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { HUB_REPOSITORY_IDENTITY as hub, requireRepositoryMetadata, requireRepositoryReference, requireProducerEnvironment, requireManifestProducer } from '../scripts/github-repository-binding.mjs';
import { captureBuild, packBuild } from '../scripts/ci-pack-smoke.mjs';
import { auditGithub, captureArtifact, inspectTar, sourceBinding, verifyArtifact, adoptArtifact, validateAdoptedArtifact, verifyAttestation, npmCliPath, assertEffectiveManualProtection, assertManualAttestorAncestry, verifyPublishedManualArtifact } from '../../scripts/hosted-build-artifact.mjs';

import { metadata, digest, tinyTar, fixture, qualifiedFixture } from './helpers/hosted-artifact-fixture.mjs';

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
  const run = { id: 100, run_attempt: 1, repository: metadata(), head_sha: revision, event: 'pull_request', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success' };
  const artifact = { id: 200, name: 'qualified-build', expired: false, digest: `sha256:${'d'.repeat(64)}`, workflow_run: { id: 100, head_sha: revision } };
  const input = { repository: 'ashlrai/ashlr-hub', revision, eventSha, runId: 100, runAttempt: 1, artifactId: 200, artifactName: artifact.name,
    requiredJobs: [{ name: job.name, labels: ['macos-15'], steps: ['Test complete partition'] }],
    read: (endpoint) => endpoint === `repos/${hub.legacyName}` ? metadata() : endpoint.includes('/jobs?') ? { total_count: 1, jobs: [job] } : endpoint.includes('/git/commits/') ? { sha: endpoint.split('/').at(-1), tree: { sha: tree } } : endpoint.includes('/artifacts/') ? artifact : run };
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


test('trusted bootstrap identity constants match the protected TypeScript contract', () => {
  const source = ts.createSourceFile('repository-binding.ts', fs.readFileSync(new URL('../../src/core/authority/repository-binding.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true);
  let properties;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'HUB_REPOSITORY_IDENTITY') {
      assert.ok(ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'Object.freeze');
      const object = node.initializer.arguments[0]; assert.ok(ts.isObjectLiteralExpression(object));
      properties = object.properties.map((entry) => {
        assert.ok(ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name));
        assert.ok(ts.isStringLiteral(entry.initializer) || ts.isNumericLiteral(entry.initializer));
        return [entry.name.text, ts.isNumericLiteral(entry.initializer) ? Number(entry.initializer.text) : entry.initializer.text];
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(properties); assert.equal(new Set(properties.map(([key]) => key)).size, properties.length);
  assert.deepEqual(Object.fromEntries(properties), hub);
});

test('minimal run references never acquire synthetic full metadata defaults', () => {
  const reference = metadata(); delete reference.default_branch; delete reference.private; delete reference.visibility;
  assert.equal(requireRepositoryReference(hub.legacyName, reference).repositoryId, hub.repositoryId);
  assert.throws(() => requireRepositoryMetadata(hub.legacyName, reference));
  assert.throws(() => requireRepositoryReference(hub.legacyName, { ...reference, full_name: hub.renamedName }));
  assert.throws(() => requireManifestProducer(1, { repository: hub.renamedName }));
});

for (const key of ['GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID']) {
  for (const value of [undefined, '1', '1263526319x']) {
    test(`capture refuses invalid event ${key}=${value} before output exists`, (t) => {
      const f = fixture(t); if (value === undefined) delete process.env[key]; else process.env[key] = value;
      assert.throws(() => captureArtifact(f.options)); assert.equal(fs.existsSync(f.out), false);
    });
  }
}
for (const repository of [hub.legacyName, hub.renamedName]) {
  test(`new event IDs are capture data for one exact namespace: ${repository}`, () => {
    assert.deepEqual(requireProducerEnvironment({ GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: String(hub.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(hub.ownerId) }), { repository, repositoryId: hub.repositoryId, ownerId: hub.ownerId });
  });
}
test('version2 renamed artifacts verify one exact signer namespace and live adoption capability', (t) => {
  const f = qualifiedFixture(t, { repository: hub.renamedName }); const receipt = verifyArtifact(f.options);
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.repositoryBinding.nameWithOwner, hub.renamedName);
  assert.equal(f.calls.length, 3); fs.rmSync(join(f.root, 'dist'), { recursive: true }); adoptArtifact(receipt);
  assert.throws(() => adoptArtifact(JSON.parse(JSON.stringify(receipt))), /live verified/);
});
test('version1 historical signed subjects stay byte-identical and require their exact old namespace', (t) => {
  const f = qualifiedFixture(t, { schemaVersion: 1 });
  const paths = ['manifest.json', 'qualification.json', 'dist.tar'].map((path) => join(f.out, path));
  const bytes = paths.map((path) => fs.readFileSync(path));
  assert.equal(verifyArtifact(f.options).schemaVersion, 1);
  f.api.metadata.full_name = hub.renamedName;
  assert.throws(() => verifyArtifact(f.options), /exact identity/);
  f.api.metadata.full_name = hub.legacyName; f.api.metadata.id++;
  assert.throws(() => verifyArtifact(f.options), /exact identity/);
  paths.forEach((path, i) => assert.ok(fs.readFileSync(path).equals(bytes[i])));
});
for (const kind of ['mixed schemas', 'unknown schemas', 'manifest IDs', 'qualified binding', 'current repository ID', 'producer reference', 'attestor reference', 'current namespace']) {
  test(`artifact admission refuses ${kind} without minting a capability`, (t) => {
    const f = qualifiedFixture(t);
    if (kind === 'mixed schemas' || kind === 'qualified binding') {
      const q = JSON.parse(fs.readFileSync(join(f.out, 'qualification.json')));
      if (kind === 'mixed schemas') q.schemaVersion = 1; else q.repositoryBinding.repositoryId++;
      fs.chmodSync(join(f.out, 'qualification.json'), 0o600); fs.writeFileSync(join(f.out, 'qualification.json'), JSON.stringify(q));
    }
    if (kind === 'manifest IDs') {
      const path = join(f.out, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(path)); manifest.producer.repositoryId++;
      fs.chmodSync(path, 0o600); fs.writeFileSync(path, JSON.stringify(manifest));
    }
    if (kind === 'unknown schemas') {
      for (const name of ['manifest.json', 'qualification.json']) {
        const path = join(f.out, name); const record = JSON.parse(fs.readFileSync(path)); record.schemaVersion = 3;
        fs.chmodSync(path, 0o600); fs.writeFileSync(path, JSON.stringify(record));
      }
    }
    if (kind === 'current repository ID') f.api.metadata.id++;
    if (kind === 'producer reference') f.api.producerRepo.owner.id++;
    if (kind === 'attestor reference') f.api.attestorRepo.node_id = 'R_other';
    if (kind === 'current namespace') f.api.metadata.full_name = hub.renamedName;
    assert.throws(() => verifyArtifact(f.options)); assert.equal(f.calls.length, 0);
    assert.ok(fs.existsSync(join(f.root, 'dist')));
  });
}


test('identity changing during signature verification cannot mint a live admission capability', (t) => {
  const f = qualifiedFixture(t); const attest = f.options.attestRun;
  f.options.attestRun = (...args) => { const result = attest(...args); f.api.metadata.full_name = hub.renamedName; return result; };
  assert.throws(() => verifyArtifact(f.options), /exact identity/);
  assert.equal(f.calls.length, 3); assert.ok(fs.existsSync(join(f.root, 'dist')));
});

for (const name of ['manifest.json', 'qualification.json', 'dist.tar', 'package']) {
  test(`final repository observation cannot substitute verified ${name} bytes`, (t) => {
    const f = qualifiedFixture(t); const read = f.options.githubRead;
    const packageName = JSON.parse(fs.readFileSync(join(f.out, 'manifest.json'))).package.filename;
    const path = join(f.out, name === 'package' ? packageName : name); let changed = false;
    f.options.githubRead = endpoint => {
      const result = read(endpoint);
      if (endpoint === `repos/${hub.legacyName}` && f.calls.length === 3) {
        changed = true; fs.chmodSync(path, 0o600); fs.appendFileSync(path, ' ');
      }
      return result;
    };
    assert.throws(() => verifyArtifact(f.options), /changed after verification/);
    assert.equal(changed, true); assert.equal(f.calls.length, 3);
    assert.equal(fs.readFileSync(join(f.root, 'dist/api/core.js'), 'utf8'), 'built:api/core.js');
  });
}
for (const name of ['manifest.json', 'qualification.json']) {
  test(`a signed replacement ${name} must still match the initially parsed bytes`, (t) => {
    const f = qualifiedFixture(t); const read = f.options.githubRead; let changed = false;
    f.options.githubRead = endpoint => {
      const result = read(endpoint);
      if (endpoint.includes('/runs/300/')) {
        const path = join(f.out, name); changed = true; fs.chmodSync(path, 0o600); fs.appendFileSync(path, ' ');
      }
      return result;
    };
    assert.throws(() => verifyArtifact(f.options), /signed subject differs from initially validated bytes/);
    assert.equal(changed, true); assert.equal(f.calls.length, name === 'manifest.json' ? 2 : 3);
    assert.ok(fs.existsSync(join(f.root, 'dist')));
  });
}
test('final repository observation cannot change candidate source before admission', (t) => {
  const f = qualifiedFixture(t); const read = f.options.githubRead; let changed = false;
  f.options.githubRead = endpoint => {
    const result = read(endpoint);
    if (endpoint === `repos/${hub.legacyName}` && f.calls.length === 3) {
      changed = true; fs.writeFileSync(join(f.root, 'package-lock.json'), 'changed source');
    }
    return result;
  };
  assert.throws(() => verifyArtifact(f.options), /source is dirty/);
  assert.equal(changed, true); assert.equal(f.calls.length, 3); assert.ok(fs.existsSync(join(f.root, 'dist')));
});


for (const [repository, packageName, filename] of [
  [hub.legacyName, '@ashlr/hub', 'ashlr-hub-3.24.3.tgz'],
  [hub.renamedName, '@ashlr/phantom', 'ashlr-phantom-3.24.3.tgz'],
]) test(`capture binds original source package and exact producer namespace ${repository}`, t => {
  const f = fixture(t, false, repository, packageName), before = fs.readFileSync(f.packageTarball);
  const captured = captureArtifact(f.options);
  assert.equal(captured.package.filename, filename); assert.equal(captured.producer.repository, repository);
  assert.deepEqual(fs.readFileSync(join(f.out, filename)), before);
  assert.equal(captured.schemaVersion, 2); // Hosted transport schema is independent from the signed updater profile.
});
for (const [repository, packageName] of [[hub.legacyName, '@ashlr/phantom'], [hub.renamedName, '@ashlr/hub']]) {
  test(`capture refuses mixed source/producer ${repository} ${packageName} before output`, t => {
    const f = fixture(t, false, repository, packageName);
    assert.throws(() => captureArtifact(f.options), /source package and producer repository differ/);
    assert.equal(fs.existsSync(f.out), false);
  });
}

const manualBranch = { name: 'master', protected: true, commit: { sha: 'a'.repeat(40) } };
const manualRules = ['pull_request', 'non_fast_forward', 'deletion'].map(type => ({ type, ruleset_id: 1,
  ruleset_source_type: 'Repository', ruleset_source: hub.renamedName, ...(type === 'pull_request' ? { parameters: {
    required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_code_owner_review: true,
    require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['merge', 'squash', 'rebase'] } } : {}) }));
test('published manual protection requires active effective PR, non-fast-forward and deletion rules, without inventing an approval count', () => {
  assert.equal(assertEffectiveManualProtection(hub.renamedName, manualBranch, manualRules), manualBranch.commit.sha);
  assert.equal(assertEffectiveManualProtection(hub.renamedName, manualBranch, [...manualRules, {...structuredClone(manualRules[0]), ruleset_id:2}]), manualBranch.commit.sha);
  const conflict=structuredClone(manualRules[0]);conflict.parameters.required_approving_review_count=1;
  assert.throws(()=>assertEffectiveManualProtection(hub.renamedName, manualBranch, [...manualRules,conflict]), /conflicting effective rules/);
  for (const mutate of [rules => rules.pop(), rules => {rules[0].parameters.require_code_owner_review = 'true';},
    rules => {rules[0].ruleset_source = 'foreign/repository';}, rules => {rules[0].type = 'future_unknown_rule';},
    rules => {rules[0].ruleset_id = 0;}]) {
    const rules = structuredClone(manualRules); mutate(rules); assert.throws(() => assertEffectiveManualProtection(hub.renamedName, manualBranch, rules));
  }
  assert.throws(() => assertEffectiveManualProtection(hub.renamedName, {...manualBranch, protected: false}, manualRules));
  assert.throws(() => assertEffectiveManualProtection(hub.renamedName, manualBranch, []));
});
test('historical ancestry anchors the original attestor, including a squash-bound candidate, not a commits-list guess', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), good = {base_commit:{sha:a},merge_base_commit:{sha:a},status:'ahead',behind_by:0,ahead_by:300,total_commits:300,commits:[]};
  assertManualAttestorAncestry(a,b,good);
  assertManualAttestorAncestry(a,a,{...good,status:'identical',ahead_by:0,total_commits:0});
  for(const bad of [{...good,status:'diverged'},{...good,behind_by:1},{...good,base_commit:{sha:b}},
    {...good,merge_base_commit:{sha:b}},{...good,total_commits:1},{...good,ahead_by:NaN}]) assert.throws(()=>assertManualAttestorAncestry(a,b,bad));
});
test('published mode never accepts a serialized capability or silently widens default hosted verification', t => {
  assert.throws(()=>verifyPublishedManualArtifact({},{}), /fresh commissioned capability/);
  const f = qualifiedFixture(t), read=f.options.githubRead;
  f.options.githubRead=endpoint=>endpoint.endsWith('/branches/master')?{commit:{sha:'d'.repeat(40)}}:read(endpoint);
  assert.throws(()=>verifyArtifact(f.options), /not current trusted master/);
});

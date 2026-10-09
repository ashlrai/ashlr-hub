import {describe, it, expect} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {publisherInput, bindAttestedArtifact, acceptPackageIdentity, verifyHandoff, assertRegistryPackage, assertLatestPromotion, verifyCanonicalProvenance} from '../scripts/canonical-npm-publisher.mjs';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const env = {GITHUB_REPOSITORY: 'ashlrai/phantom', GITHUB_REPOSITORY_ID: '1263526319', GITHUB_REPOSITORY_OWNER_ID: '258113726',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: '1'.repeat(40), CANDIDATE_SHA: '2'.repeat(40),
  VERSION: '3.27.0', CI_RUN_ID: '4', CI_RUN_ATTEMPT: '1', ATTESTOR_RUN_ID: '5', ATTESTOR_RUN_ATTEMPT: '1', ATTESTED_ARTIFACT_ID: '6', AUDIT_RUN_ID: '7', AUDIT_RUN_ATTEMPT: '1'};
const repo = {id: 1263526319, node_id: 'R_kgDOS0_hrw', full_name: 'ashlrai/phantom', owner: {id: 258113726, login: 'ashlrai'}};
const run = {repository: repo, id: 5, run_attempt: 1, head_sha: env.GITHUB_SHA, event: 'workflow_dispatch', path: '.github/workflows/attest-ci-build.yml', status: 'completed', conclusion: 'success'};
const artifact = {id: 6, expired: false, name: 'ashlr-attested-4-1-5-1', digest: `sha256:${'3'.repeat(64)}`, workflow_run: {id: 5, head_sha: env.GITHUB_SHA}};
const bytes = Buffer.from('original archive fixture');
const input = publisherInput(env);
const pkg = {name: '@ashlr/phantom', version: '3.27.0', repository: {url: 'git+https://github.com/ashlrai/phantom.git'}};
const receipt = {source: {revision: input.revision}, packageSha256: hash(bytes), attestor: {revision: input.attestorSha, runId: 5, runAttempt: 1}};

describe('canonical npm publication admission', () => {
  it('binds exact source, numeric repository and original package identity', () => {
    expect(bindAttestedArtifact(input, run, artifact)).toEqual(artifact);
    expect(acceptPackageIdentity(input, pkg, receipt, bytes).sha256).toBe(hash(bytes));
  });
  it.each([{GITHUB_REF: 'refs/heads/worker'}, {GITHUB_REPOSITORY: 'attacker/phantom'}, {GITHUB_REPOSITORY_ID: '1'}, {VERSION: '3.27.0;echo bad'}, {CI_RUN_ATTEMPT: '0'}, {GITHUB_EVENT_NAME: 'pull_request'}, {AUDIT_RUN_ID: ''}])('refuses invalid caller inputs %j', patch => {
    expect(() => publisherInput({...env, ...patch})).toThrow();
  });
  it.each([{expired: true}, {id: 8}, {name: 'ashlr-attested-4-2-5-1'}, {workflow_run: {id: 6, head_sha: env.GITHUB_SHA}}, {digest: ''}])('refuses wrong or expired artifact %j', patch => {
    expect(() => bindAttestedArtifact(input, run, {...artifact, ...patch})).toThrow();
  });
  it.each([{conclusion: 'failure'}, {head_sha: '3'.repeat(40)}, {path: '.github/workflows/worker.yml'}, {repository: {...repo, id: 1}}])('refuses wrong attestor %j', patch => {
    expect(() => bindAttestedArtifact(input, {...run, ...patch}, artifact)).toThrow();
  });
  it('refuses archive substitution and noncanonical repository metadata', () => {
    expect(() => acceptPackageIdentity(input, pkg, receipt, Buffer.from('changed'))).toThrow();
    expect(() => acceptPackageIdentity(input, {...pkg, repository: {url: 'git+https://github.com/attacker/phantom.git'}}, receipt, bytes)).toThrow();
  });
  it('rehashes real transferred files and refuses symlink or modified handoffs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-publish-test-'));
    try {
      const accepted = acceptPackageIdentity(input, pkg, receipt, bytes);
      const admission = Buffer.from(JSON.stringify(accepted));
      writeFileSync(join(dir, 'admission.json'), admission); writeFileSync(join(dir, accepted.filename), bytes);
      expect(verifyHandoff(dir, hash(admission), hash(bytes))).toEqual(accepted);
      writeFileSync(join(dir, accepted.filename), 'changed');
      expect(() => verifyHandoff(dir, hash(admission), hash(bytes))).toThrow();
      rmSync(join(dir, accepted.filename)); symlinkSync(join(dir, 'admission.json'), join(dir, accepted.filename));
      expect(() => verifyHandoff(dir, hash(admission), hash(bytes))).toThrow();
    } finally {rmSync(dir, {recursive: true, force: true});}
  });
  it('accepts only exact public archive bytes with provenance present', () => {
    const accepted = acceptPackageIdentity(input, pkg, receipt, bytes);
    const metadata = {name: accepted.name, version: accepted.version, dist: {integrity: accepted.integrity, attestations: {provenance: {predicateType: 'https://slsa.dev/provenance/v1'}}}};
    expect(assertRegistryPackage(accepted, metadata, bytes)).toBe(true);
    expect(() => assertRegistryPackage(accepted, metadata, Buffer.from('other'))).toThrow();
    expect(() => assertRegistryPackage(accepted, {...metadata, version: '3.26.0'}, bytes)).toThrow();
  });
  it('keeps publication after read-only admission and consumer acceptance before stable promotion', () => {
    const raw = readFileSync(new URL('../.github/workflows/publish-canonical-npm.yml', import.meta.url), 'utf8');
    const workflow = parse(raw);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.admit.permissions['id-token']).toBeUndefined();
    expect(workflow.jobs.publish.needs).toBe('admit');
    expect(workflow.jobs.publish.permissions['id-token']).toBe('write');
    expect(workflow.jobs.publish.environment).toBe('phantom-npm');
    expect(workflow.jobs.consumer.permissions['id-token']).toBeUndefined();
    expect(workflow.jobs.promote.needs).toContain('consumer');
    expect(workflow.jobs.publish.steps.map((step: {run?: string}) => step.run ?? '').join('\n')).not.toContain('bin/ashlr');
    expect(workflow.jobs.consumer.steps.some((step: {name?: string}) => step.name === 'Verify isolated public installed CLI')).toBe(true);
    expect(raw).toContain('--tag "qualified-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"');
    expect(raw).not.toMatch(/\bnpm pack(?:\s|$)/);
    expect(raw).not.toContain('workflow_call');
    expect(workflow.jobs.publish.env.NODE_AUTH_TOKEN).toBe('');
  });
});

describe('canonical publication recovery', () => {
  it('allows equal or newer stable versions and rejects downgrades or unknown numeric versions', () => {
    for (const [version, latest] of [['3.27.0', '3.26.1'], ['3.27.0', '3.27.0'], ['4.0.0', '3.99.99']]) expect(() => assertLatestPromotion(version, latest)).not.toThrow();
    for (const [version, latest] of [['3.26.1', '3.27.0'], ['3.27.0', '4.0.0'], ['3.27.0', 'unknown'], ['3.27.0', '9007199254740992.0.0'], ['3.27.0-beta', '3.26.1']]) expect(() => assertLatestPromotion(version, latest)).toThrow();
  });
  it('reconciles original first-attempt provenance during a later rerun using fresh official admission', () => {
    const accepted = acceptPackageIdentity(input, pkg, receipt, bytes);
    const repository = 'https://github.com/ashlrai/phantom';
    const statement = {_type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{name: 'pkg:npm/%40ashlr/phantom@3.27.0', digest: {sha512: createHash('sha512').update(bytes).digest('hex')}}],
      predicate: {buildDefinition: {buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {workflow: {repository, path: '.github/workflows/publish-canonical-npm.yml', ref: 'refs/heads/master'}},
        internalParameters: {github: {event_name: 'workflow_dispatch'}}, resolvedDependencies: [{uri: `git+${repository}@refs/heads/master`, digest: {gitCommit: env.GITHUB_SHA}}]},
      runDetails: {builder: {id: 'https://github.com/actions/runner/github-hosted'}, metadata: {invocationId: `${repository}/actions/runs/9/attempts/1`}}}};
    const audit = {invalid: [], missing: [], verified: [{name: accepted.name, version: accepted.version, location: 'node_modules/@ashlr/phantom', attestationBundles: [{predicateType: statement.predicateType, bundle: {dsseEnvelope: {payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64')}}}]}]};
    const read = (endpoint: string) => endpoint.endsWith('/jobs?per_page=100') ? {total_count: 1, jobs: [{name: 'admit', conclusion: 'success', head_sha: env.GITHUB_SHA}]} : endpoint.endsWith('/attempts/1') ? {...run, id: 9, path: '.github/workflows/publish-canonical-npm.yml', head_branch: 'master', conclusion: 'failure'} : {...repo, default_branch: 'master', private: false, visibility: 'public'};
    expect(verifyCanonicalProvenance(accepted, audit, env.GITHUB_SHA, '9', '2', read)).toEqual({runId: '9', runAttempt: '1'});
    expect(() => verifyCanonicalProvenance(accepted, audit, '3'.repeat(40), '9', '2', read)).toThrow();
    const failedAdmission = (endpoint: string) => endpoint.endsWith('/jobs?per_page=100') ? {total_count: 1, jobs: [{name: 'admit', conclusion: 'failure', head_sha: env.GITHUB_SHA}]} : read(endpoint);
    expect(() => verifyCanonicalProvenance(accepted, audit, env.GITHUB_SHA, '9', '2', failedAdmission)).toThrow();
  });
});

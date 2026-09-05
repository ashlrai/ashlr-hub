/**
 * M523 — parsed policy for the one-shot GitHub stable-release finalizer.
 *
 * These tests are filesystem-only. They do not call GitHub, npm, mutate a
 * release, configure an environment, or dispatch a workflow.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type Job = {
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  ['runs-on']?: string;
  ['timeout-minutes']?: number;
};

type Workflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> } };
  permissions?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  env?: Record<string, unknown>;
  jobs?: Record<string, Job>;
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowText = readFileSync(
  join(root, '.github/workflows/finalize-github-release.yml'),
  'utf8',
);
const releasing = readFileSync(join(root, 'docs/RELEASING.md'), 'utf8');
const contract = readFileSync(join(root, 'docs/contracts/CONTRACT-M523.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const workflow = parse(workflowText) as Workflow;
const verifyJob = workflow.jobs?.verify ?? {};
const finalizationJob = workflow.jobs?.finalize ?? {};
const verificationSteps = verifyJob.steps ?? [];
const finalizationSteps = finalizationJob.steps ?? [];
const verification = verificationSteps.find((step) =>
  step.name === 'Verify exact immutable and public-channel evidence');
const effect = finalizationSteps.find((step) =>
  step.name === 'Reverify live state, perform one PATCH, and postverify');

const SOURCE_SHA = '2971c9f767c934e12fd056bf8c6dca5164ffe7d2';
const SRI = 'sha512-674ZY76hBxks8j9JR5QifoyMn6uxmRx6dhbgiYAuWRyrnB4Zeuo/H+rgQ1mQ/mNYf62s1ORnJcvTxbxHZFuqTA==';
const BODY_SHA256 = 'f7b2dc191b3491ce29da3b31a6afb6703d9403f4c5ef3b0066ca0bed5a647ba5';
const ASSETS_SHA256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const ADMISSION_ARTIFACT_SHA256 = '223193104d72509f481907e920a5fda586db055d9efaf3e846dd85c2c835953b';
const ADMISSION_RECEIPT_SHA256 = '0b3552324284856423356d12e7b04334c530ea5471666f3fc82647426a57b86d';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function changelogBody(version: string): string {
  const heading = `## [${version}]`;
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} — `));
  expect(start).toBeGreaterThanOrEqual(0);
  const remainder = lines.slice(start + 1);
  const next = remainder.findIndex((line) => line.startsWith('## ['));
  return `${remainder.slice(0, next === -1 ? undefined : next).join('\n').trim()}\n`;
}

function executableGithubWrites(text: string): string[] {
  const executableText = text.replace(/\\\r?\n[ \t]*/gu, ' ');
  return executableText.split('\n').filter((line) =>
    /^\s*gh\s+api\b/u.test(line) &&
    /(?:--method\s+(?:POST|PUT|PATCH|DELETE)|-[Xx](?:POST|PUT|PATCH|DELETE)|--input\b|-f\s|-F\s|--field\b|--raw-field\b)/u.test(line))
    .map((line) => line.trim());
}

function requiredVerificationFragments(text: string): string[] {
  const required = [
    '"$GITHUB_EVENT_NAME" != "workflow_dispatch"',
    '"$GITHUB_REF_NAME" != "master"',
    '"$CONFIRM_STABLE_FINALIZATION" != "true"',
    '"$RELEASE_RUN_ID_INPUT" != "$REQUIRED_RELEASE_RUN_ID"',
    '"$ADMISSION_RUN_ID_INPUT" != "$REQUIRED_ADMISSION_RUN_ID"',
    '"$CANDIDATE_INTEGRITY_INPUT" != "$REQUIRED_CANDIDATE_INTEGRITY"',
    '.protected == true and .commit.sha == $sha',
    '.object.type == "commit" and .object.sha == $sha',
    '.path == ".github/workflows/release.yml"',
    '.path == ".github/workflows/promote.yml"',
    '.artifacts[0].digest == $digest',
    '"$observed_admission_sha256" == "$REQUIRED_ADMISSION_RECEIPT_SHA256"',
    'scripts/verify-npm-release-provenance.mjs',
    '.["dist-tags"].latest == $version',
    '.["dist-tags"].candidate == $version',
    '.versions[$version].dist.integrity == $integrity',
    '.prerelease == true',
    '"$before_body_sha256" == "$REQUIRED_RELEASE_BODY_SHA256"',
    '"$before_assets_sha256" == "$REQUIRED_RELEASE_ASSETS_SHA256"',
    'githubReleaseMutationExecuted:false',
    'npmMutationAuthority:false',
    'activationAuthority:false',
  ];
  return required.filter((fragment) => !text.includes(fragment));
}

function requiredEffectFragments(text: string): string[] {
  const required = [
    '"$GITHUB_EVENT_NAME" != "workflow_dispatch"',
    '"$GITHUB_REF_NAME" != "master"',
    '"$CONFIRM_STABLE_FINALIZATION" != "true"',
    '"$observed_preflight_sha256" == "$EXPECTED_PREFLIGHT_RECEIPT_SHA256"',
    '.admission == "github-release-stable-finalization-preflight"',
    '.npm.provenanceVerified == true',
    '.can_admins_bypass == false',
    '.protected == true and .commit.sha == $sha',
    '.path == ".github/workflows/release.yml"',
    '.path == ".github/workflows/promote.yml"',
    '.object.type == "commit" and .object.sha == $sha',
    '.["dist-tags"].latest == $version',
    '.["dist-tags"].candidate == $version',
    '.versions[$version].dist.integrity == $integrity',
    '.prerelease == true',
    '.prerelease == false',
    '"$before_body_sha256" == "$REQUIRED_RELEASE_BODY_SHA256"',
    '"$before_assets_sha256" == "$REQUIRED_RELEASE_ASSETS_SHA256"',
    '"$after_body_sha256" == "$REQUIRED_RELEASE_BODY_SHA256"',
    '"$after_assets_sha256" == "$REQUIRED_RELEASE_ASSETS_SHA256"',
    "jq -cn '{prerelease:false, make_latest:\"true\"}'",
    'githubReleaseMutationExecuted:true',
    'mutation:{method:"PATCH", count:1',
    'npmMutationAuthority:false',
    'activationAuthority:false',
  ];
  return required.filter((fragment) => !text.includes(fragment));
}

describe('M523 — GitHub stable-release finalization', () => {
  it('is a separate manual, serialized, environment-gated one-shot lane', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toEqual({
      group: 'github-stable-release-finalization-v3.3.2',
      'cancel-in-progress': false,
    });
    expect(Object.keys(workflow.jobs ?? {})).toEqual(['verify', 'finalize']);
    expect(verifyJob).toMatchObject({
      permissions: { actions: 'read', contents: 'read' },
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 12,
    });
    expect(verifyJob.environment).toBeUndefined();
    expect(finalizationJob).toMatchObject({
      environment: 'github-stable-release-finalization',
      permissions: { actions: 'read', contents: 'write' },
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
      needs: 'verify',
    });
    expect(workflowText).not.toContain('.github/workflows/promote.yml —');
    expect(releasing).toContain('Do not repurpose\nthe observation-only `promote.yml`');
  });

  it('requires exact caller-supplied evidence and explicit confirmation', () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual([
      'release_run_id',
      'admission_run_id',
      'candidate_integrity',
      'confirm_stable_finalization',
    ]);
    expect(inputs.confirm_stable_finalization).toEqual({
      description: 'Confirm npm production is accepted and GitHub v3.3.2 should become stable/latest',
      required: true,
      default: false,
      type: 'boolean',
    });
    expect(requiredVerificationFragments(verification?.run ?? '')).toEqual([]);
    expect(requiredEffectFragments(effect?.run ?? '')).toEqual([]);
  });

  it('pins every immutable release, evidence, and rollback identity', () => {
    expect(workflow.env).toEqual({
      PACKAGE_NAME: '@ashlr/hub',
      RELEASE_VERSION: '3.3.2',
      RELEASE_TAG: 'v3.3.2',
      RELEASE_SOURCE_SHA: SOURCE_SHA,
      REQUIRED_ROLLBACK_REVISION: 'd6c1a5ec3626f715018a8ffb929906ac0f52f5c9',
      REQUIRED_RELEASE_RUN_ID: '33932333902',
      REQUIRED_RELEASE_RUN_ATTEMPT: '1',
      REQUIRED_ADMISSION_RUN_ID: '33933861238',
      REQUIRED_ADMISSION_RUN_ATTEMPT: '1',
      REQUIRED_ADMISSION_ARTIFACT_ID: '9959487443',
      REQUIRED_ADMISSION_ARTIFACT_NAME: 'npm-production-promotion-admission-33933861238-1',
      REQUIRED_ADMISSION_ARTIFACT_SHA256: ADMISSION_ARTIFACT_SHA256,
      REQUIRED_ADMISSION_RECEIPT_SHA256: ADMISSION_RECEIPT_SHA256,
      REQUIRED_CANDIDATE_INTEGRITY: SRI,
      REQUIRED_RELEASE_ID: '383083121',
      REQUIRED_RELEASE_NAME: 'v3.3.2',
      REQUIRED_RELEASE_BODY_SHA256: BODY_SHA256,
      REQUIRED_RELEASE_ASSETS_SHA256: ASSETS_SHA256,
      PRIOR_LATEST_RELEASE_ID: '341086222',
      PRIOR_LATEST_RELEASE_TAG: 'v3.0.0',
      REQUIRED_FINALIZATION_APPROVER: 'masonwyatt23',
      FINALIZATION_ENVIRONMENT: 'github-stable-release-finalization',
    });
    expect(sha256(changelogBody('3.3.2'))).toBe(BODY_SHA256);
    expect(sha256('[]')).toBe(ASSETS_SHA256);
  });

  it('verifies the exact protected environment policy in executable code', () => {
    const run = effect?.run ?? '';
    for (const fragment of [
      '.can_admins_bypass == false',
      '.deployment_branch_policy.protected_branches == true',
      '.deployment_branch_policy.custom_branch_policies == false',
      '($rules | length) == 1',
      '$rules[0].prevent_self_review == false',
      '($rules[0].reviewers | type == "array" and length == 1)',
      '$rules[0].reviewers[0].type == "User"',
      '$rules[0].reviewers[0].reviewer.login == $approver',
    ]) expect(run).toContain(fragment);
  });

  it('uses only pinned actions and binds download to the exact prior run', () => {
    expect([
      ...verificationSteps.flatMap((step) => step.uses ? [step.uses] : []),
      ...finalizationSteps.flatMap((step) => step.uses ? [step.uses] : []),
    ]).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]);
    const download = verificationSteps.find((step) =>
      step.name === 'Download exact promotion-admission artifact');
    expect(download?.with).toMatchObject({
      'artifact-ids': '${{ env.REQUIRED_ADMISSION_ARTIFACT_ID }}',
      'github-token': '${{ github.token }}',
      repository: '${{ github.repository }}',
      'run-id': '${{ env.REQUIRED_ADMISSION_RUN_ID }}',
      'digest-mismatch': 'error',
    });
  });

  it('contains exactly one external mutation and it is the fixed release PATCH', () => {
    const writes = executableGithubWrites(workflowText);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('gh api --method PATCH');
    expect(writes[0]).toContain('repos/${GITHUB_REPOSITORY}/releases/${REQUIRED_RELEASE_ID}');
    expect(writes[0]).toContain('--input "$patch_payload"');
    expect(effect?.run).toContain(
      '"repos/${GITHUB_REPOSITORY}/releases/${REQUIRED_RELEASE_ID}"',
    );
    expect(effect?.run?.match(/\bgh api --method PATCH\b/gu)).toHaveLength(1);
    expect(workflowText).not.toMatch(/\bnpm\s+(?:publish|dist-tag|unpublish|deprecate)\b/u);
    expect(workflowText).not.toMatch(/\bgh\s+(?:release\s+(?:create|delete|edit)|api\s+--method\s+(?:POST|PUT|DELETE))\b/u);
    expect(workflowText).not.toMatch(/\bcurl\b[^\n]*(?:--request|-X)\s*(?:POST|PUT|PATCH|DELETE)\b/u);
    expect(workflowText).not.toMatch(/\bcurl\b[^\n]*(?:--data|--form|--upload-file|--json)\b/u);
    expect(workflowText).not.toMatch(/\bid-token\s*:/u);
    expect(workflowText).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|\$\{\{\s*secrets\./u);
    expect(finalizationSteps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false);
    expect(effect?.run).not.toMatch(/\bnpm\s|verify-npm-release-provenance/u);
  });

  it('fails policy when any critical pre/postcondition is removed', () => {
    const verifyRun = verification?.run ?? '';
    const run = effect?.run ?? '';
    expect(requiredVerificationFragments(verifyRun)).toEqual([]);
    expect(requiredEffectFragments(run)).toEqual([]);
    for (const fragment of [
      '.path == ".github/workflows/release.yml"',
      '.path == ".github/workflows/promote.yml"',
      '.object.type == "commit" and .object.sha == $sha',
      '.["dist-tags"].latest == $version',
      '"$after_body_sha256" == "$REQUIRED_RELEASE_BODY_SHA256"',
      '"$after_assets_sha256" == "$REQUIRED_RELEASE_ASSETS_SHA256"',
      'githubReleaseMutationExecuted:true',
    ]) {
      const mutated = run.replaceAll(fragment, 'true');
      expect(mutated).not.toBe(run);
      expect(requiredEffectFragments(mutated)).not.toEqual([]);
    }
  });

  it('documents exact one-shot authority and inverse rollback without granting it', () => {
    for (const text of [contract, releasing]) {
      expect(text).toContain('github-stable-release-finalization');
      expect(text).toContain('33932333902');
      expect(text).toContain('33933861238');
      expect(text).toContain(SOURCE_SHA);
    }
    expect(contract).toContain('{"prerelease":false,"make_latest":"true"}');
    expect(contract).toContain('{"prerelease":true,"make_latest":"false"}');
    expect(contract).toContain('Rollback is never automatic');
    expect(contract).toContain('does not change npm');
    expect(contract).toContain('M523 grants no such authority');
    expect(workflowText).toContain('requiresFreshProtectedReviewAndEnvironmentApproval:true');
    expect(workflowText).toContain('automatic:false');
  });
});

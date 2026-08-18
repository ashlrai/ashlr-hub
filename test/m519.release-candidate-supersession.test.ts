import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  name?: string;
  run?: string;
}

interface Job {
  steps?: Step[];
}

interface Workflow {
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowText = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
const workflow = parse(workflowText) as Workflow;
const publishSteps = workflow.jobs?.publish?.steps ?? [];
const verifySteps = workflow.jobs?.verify_publish?.steps ?? [];
const admission = publishSteps.find((step) =>
  step.name === 'Admit exact candidate channel state immediately before publish');
const publish = publishSteps.find((step) => step.name === 'Publish to npm (provenance)');
const verify = verifySteps.find((step) =>
  step.name === 'Verify immutable candidate and preserved dist-tags');

const expectedEnv = {
  RELEASE_VERSION: '3.3.1',
  RELEASE_DIST_TAG: 'candidate',
  BASELINE_LATEST_VERSION: '3.0.1',
  PREVIOUS_CANDIDATE_VERSION: '3.3.0',
  PREVIOUS_CANDIDATE_INTEGRITY:
    'sha512-mYVuJZyoXeSnnqivoLzyZggNgpJoWM8glTI7CW0oBfQ0RCHx0xueTrLwLTZBg5W+E4zPOJNbckptYeb5YsdOHw==',
  PREVIOUS_CANDIDATE_TAG_SHA: 'd07f6a96eda664d865b9255f71c6f56e8cd9d7c7',
  REQUIRED_ROLLBACK_REVISION: '31aa0467f66af1fe4c66d1664f65e6fd3e4ba61b',
};

function supersessionViolations(candidate: Workflow): string[] {
  const violations: string[] = [];
  const candidatePublishSteps = candidate.jobs?.publish?.steps ?? [];
  const candidateVerifySteps = candidate.jobs?.verify_publish?.steps ?? [];
  const candidateAdmission = candidatePublishSteps.find((step) =>
    step.name === 'Admit exact candidate channel state immediately before publish');
  const candidatePublish = candidatePublishSteps.find((step) =>
    step.name === 'Publish to npm (provenance)');
  const candidateVerify = candidateVerifySteps.find((step) =>
    step.name === 'Verify immutable candidate and preserved dist-tags');
  const admissionRun = candidateAdmission?.run ?? '';
  const publishRun = candidatePublish?.run ?? '';
  const verifyRun = candidateVerify?.run ?? '';
  const allRuns = Object.values(candidate.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).map((step) => step.run ?? '')).join('\n');

  if (JSON.stringify(candidate.env) !== JSON.stringify(expectedEnv)) {
    violations.push('release or predecessor identity changed');
  }
  for (const required of [
    '.["dist-tags"].latest == $latest',
    '.["dist-tags"][$candidate] == $previousVersion',
    '.versions[$previousVersion].version == $previousVersion',
    '.versions[$previousVersion].dist.integrity == $previousIntegrity',
    '(.versions[$version] == null)',
    'git/ref/tags/v${PREVIOUS_CANDIDATE_VERSION}',
    '.object.type == "commit" and .object.sha == $sha',
  ]) {
    if (!admissionRun.includes(required)) violations.push(`missing admission: ${required}`);
  }
  for (const required of [
    '.latest == $latest and .[$candidate] == $previousVersion',
    '.["dist-tags"][$candidate] == $version',
    '.versions[$previousVersion].dist.integrity == $previousIntegrity',
    "'del(.[$candidate])' \"$RUNNER_TEMP/npm-dist-tags-before-raw.json\"",
    "'.[\"dist-tags\"] | del(.[$candidate])' \"$packument\"",
    'cmp --silent',
    'npm-dist-tags-before.json',
    'npm-dist-tags-after.json',
  ]) {
    if (!verifyRun.includes(required)) violations.push(`missing verification: ${required}`);
  }
  if ((allRuns.match(/npm publish "\$TARBALL"/g) ?? []).length !== 1 ||
      !publishRun.includes('--tag "$RELEASE_DIST_TAG"')) {
    violations.push('publication is not the sole candidate publish');
  }
  if (/npm (?:dist-tag|unpublish|deprecate)\b|\bgit tag\b/u.test(allRuns)) {
    violations.push('workflow contains forbidden registry or git tag mutation');
  }
  const admissionIndex = candidatePublishSteps.indexOf(candidateAdmission ?? {});
  const publishIndex = candidatePublishSteps.indexOf(candidatePublish ?? {});
  if (admissionIndex < 0 || publishIndex !== admissionIndex + 1) {
    violations.push('live admission is not adjacent to publish');
  }
  return violations;
}

describe('M519 — immutable npm candidate supersession', () => {
  it('binds exact predecessor registry and lightweight-tag identity before publication', () => {
    expect(workflow.env).toEqual(expectedEnv);
    expect(admission).toBeDefined();
    expect(supersessionViolations(workflow)).toEqual([]);
  });

  it('allows one candidate publish and no tag-edit, unpublish, or deprecation effect', () => {
    const allRuns = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).map((step) => step.run ?? '')).join('\n');
    expect(allRuns.match(/npm publish "\$TARBALL"/g)).toHaveLength(1);
    expect(publish?.run).toContain('--ignore-scripts');
    expect(publish?.run).toContain('--provenance');
    expect(publish?.run).toContain('--tag "$RELEASE_DIST_TAG"');
    expect(allRuns).not.toMatch(/npm (?:dist-tag|unpublish|deprecate)\b|\bgit tag\b/u);
  });

  it('compares canonical before and after maps only after deleting candidate from both', () => {
    const run = verify?.run ?? '';
    const beforeDelete = run.indexOf(
      "'del(.[$candidate])' \"$RUNNER_TEMP/npm-dist-tags-before-raw.json\"",
    );
    const afterDelete = run.indexOf(
      "'.[\"dist-tags\"] | del(.[$candidate])' \"$packument\"",
    );
    const compare = run.indexOf('cmp --silent');
    expect(beforeDelete).toBeGreaterThan(-1);
    expect(afterDelete).toBeGreaterThan(beforeDelete);
    expect(compare).toBeGreaterThan(afterDelete);
  });

  it.each([
    ['candidate predecessor', '.["dist-tags"][$candidate] == $previousVersion'],
    ['predecessor integrity', '.versions[$previousVersion].dist.integrity == $previousIntegrity'],
    ['new-version absence', '(.versions[$version] == null)'],
    ['lightweight predecessor tag', 'git/ref/tags/v${PREVIOUS_CANDIDATE_VERSION}'],
  ])('fails policy when %s admission is removed', (_label, fragment) => {
    const mutated = structuredClone(workflow);
    const step = mutated.jobs?.publish?.steps?.find((entry) => entry.name === admission?.name);
    expect(step?.run).toContain(fragment);
    step!.run = step!.run!.replace(fragment, 'true');
    expect(supersessionViolations(mutated)).not.toEqual([]);
  });

  it.each([
    ['old-version postcondition', '.versions[$previousVersion].dist.integrity == $previousIntegrity'],
    ['before-map candidate deletion', "'del(.[$candidate])' \"$RUNNER_TEMP/npm-dist-tags-before-raw.json\""],
    ['after-map candidate deletion', "'.[\"dist-tags\"] | del(.[$candidate])' \"$packument\""],
  ])('fails policy when %s is removed', (_label, fragment) => {
    const mutated = structuredClone(workflow);
    const step = mutated.jobs?.verify_publish?.steps?.find((entry) => entry.name === verify?.name);
    expect(step?.run).toContain(fragment);
    step!.run = step!.run!.replace(fragment, 'true');
    expect(supersessionViolations(mutated)).not.toEqual([]);
  });
});

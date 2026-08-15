/**
 * M479 - npm release workflow supply-chain admission.
 *
 * Pure workflow assertions: no network, credentials, tags, releases, or
 * publishing. The workflow itself remains dormant until an explicit tag push.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflowText = readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8');
const releaseDocs = readFileSync(resolve(repoRoot, 'docs/RELEASING.md'), 'utf8');
const workflow = parse(workflowText) as Record<string, unknown>;
const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
const releaseCanary = jobs.release_canary;
const prepare = jobs.prepare;
const publish = jobs.publish;
const verifyPublish = jobs.verify_publish;
const release = jobs.release;
const jobSteps = (job: Record<string, unknown>): Array<Record<string, unknown>> =>
  job.steps as Array<Record<string, unknown>>;
const releaseCanarySteps = jobSteps(releaseCanary);
const prepareSteps = jobSteps(prepare);
const publishSteps = jobSteps(publish);
const verifyPublishSteps = jobSteps(verifyPublish);
const releaseSteps = jobSteps(release);
const checkout = prepareSteps[0]!;
const admission = prepareSteps[1]!;
const actionRefs = [
  ...releaseCanarySteps,
  ...prepareSteps,
  ...publishSteps,
  ...verifyPublishSteps,
  ...releaseSteps,
].flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : []));

describe('M479 npm release workflow supply-chain admission', () => {
  it('pins every third-party action to a reviewed immutable commit', () => {
    expect(actionRefs).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    ]);

    for (const ref of actionRefs) {
      expect(ref, `mutable action ref: ${ref}`).toMatch(
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i,
      );
    }

    expect(workflowText).toContain(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    );
    expect(workflowText).toContain(
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
    );
    expect(workflowText).toContain(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
    );
    expect(workflowText).toContain(
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
    );
  });

  it('checks out the immutable event SHA only before the OIDC boundary', () => {
    expect(checkout).toEqual({
      name: 'Checkout the immutable tag target',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
        ref: '${{ github.sha }}',
      },
    });
    expect(publishSteps.some((step) => String(step.uses ?? '').startsWith('actions/checkout@')))
      .toBe(false);
  });

  it('fails closed unless the exact event commit is in protected master history', () => {
    expect(admission.name).toBe('Admit only commits from protected master history');
    expect(admission.shell).toBe('bash');
    expect(admission.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(admission).not.toHaveProperty('continue-on-error');

    const run = String(admission.run);
    expect(run).toContain('set -euo pipefail');
    expect(run).toContain('git rev-parse --verify "HEAD^{commit}"');
    expect(run).toContain('"$head_commit" != "$GITHUB_SHA"');
    expect(run).toContain('gh api --fail "repos/${GITHUB_REPOSITORY}/branches/master"');
    expect(run).toContain("jq -r '.protected // false'");
    expect(run).toContain("jq -r '.commit.sha // empty'");
    expect(run).toContain('"repos/${GITHUB_REPOSITORY}/compare/${GITHUB_SHA}...${master_commit}"');
    expect(run).toContain('[[ "$comparison" != "ahead" && "$comparison" != "identical" ]]');
    expect(run.match(/\bexit 1\b/g)).toHaveLength(3);
  });

  it('prepares before the minimal publish effect and verifies before GitHub release', () => {
    const installIndex = prepareSteps.findIndex((step) => step.run === 'npm ci');
    const packIndex = prepareSteps.findIndex((step) =>
      String(step.run ?? '').includes('npm pack --json --ignore-scripts'));
    const artifactIndex = prepareSteps.findIndex((step) =>
      step.name === 'Upload bounded npm candidate handoff');
    const preparedVerifyIndex = publishSteps.findIndex((step) =>
      step.name === 'Verify bounded prepared candidate without executing it');
    const liveAdmissionIndex = publishSteps.findIndex((step) =>
      step.name === 'Admit exact candidate channel state immediately before publish');
    const publishIndex = publishSteps.findIndex((step) =>
      String(step.run ?? '').includes('npm publish "$TARBALL"'));
    const releaseIndex = releaseSteps.findIndex((step) =>
      String(step.run ?? '').includes('gh release create'));

    expect(prepareSteps.indexOf(admission)).toBe(1);
    expect(installIndex).toBeGreaterThan(prepareSteps.indexOf(admission));
    expect(packIndex).toBeGreaterThan(installIndex);
    expect(artifactIndex).toBeGreaterThan(packIndex);
    expect(preparedVerifyIndex).toBeGreaterThan(-1);
    expect(liveAdmissionIndex).toBe(preparedVerifyIndex + 1);
    expect(publishIndex).toBe(liveAdmissionIndex + 1);
    expect(verifyPublish.needs).toEqual(['prepare', 'publish']);
    expect(release.needs).toEqual(['prepare', 'verify_publish']);
    expect(releaseIndex).toBeGreaterThan(-1);
  });

  it('preserves explicit tag activation, native CI, provenance, and version gates', () => {
    expect(workflowText).toContain('tags: ["v*"]');
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toEqual({
      group: 'npm-candidate-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    expect(jobs.verify).toMatchObject({
      uses: './.github/workflows/ci.yml',
      permissions: { contents: 'read' },
    });
    expect(releaseCanary.needs).toBe('verify');
    expect(prepare.needs).toEqual(['verify', 'release_canary']);
    expect(prepare.permissions).toEqual({ contents: 'read' });
    expect(prepare).not.toHaveProperty('environment');
    expect(publish.needs).toBe('prepare');
    expect(publish['timeout-minutes']).toBe(15);
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(publish.outputs).toMatchObject({
      publication_run_attempt: '${{ steps.admission.outputs.publication_run_attempt }}',
    });
    expect(verifyPublish.permissions).toEqual({ contents: 'read' });
    expect(verifyPublish).not.toHaveProperty('environment');
    expect(release.permissions).toEqual({ contents: 'write' });
    expect(workflowText).toContain('node scripts/check-version.mjs');
    expect(workflowText).toContain(
      'node scripts/extract-changelog.mjs > "$RUNNER_TEMP/release-notes.md"',
    );
    expect(workflow.env).toEqual({
      RELEASE_VERSION: '3.2.0',
      RELEASE_DIST_TAG: 'candidate',
      BASELINE_LATEST_VERSION: '3.0.1',
    });
    expect(workflowText).toContain('npm publish "$TARBALL"');
    expect(workflowText).toContain('--tag "$RELEASE_DIST_TAG"');
    expect(workflowText).toContain('npm audit signatures --json --include-attestations');
    expect(workflowText).toContain('verify-npm-release-provenance.mjs');
    expect(workflowText).toContain('if ! version_status="$(curl');
    expect(workflowText).toContain('if ! packument_status="$(curl');
    expect(workflowText).toContain(
      'npm install --ignore-scripts --no-audit --no-fund --save-exact',
    );
    expect(workflowText).not.toContain('npm install --package-lock-only');
    expect(workflowText).toContain('test "$installed_version" = "$RELEASE_VERSION"');
    expect(workflowText).toContain('dist/build-identity.json');
    expect(workflowText).toContain('.revision == $revision');
    expect(workflowText).toContain('.dirty == false');
    expect(workflowText).toContain('.object.type == "commit"');
    expect(workflowText).toContain('.object.sha == $sha');
    expect(workflowText).toContain(
      'PUBLICATION_RUN_ATTEMPT: ${{ needs.publish.outputs.publication_run_attempt }}',
    );
    expect(workflowText).toContain('"$PUBLICATION_RUN_ATTEMPT"');
    expect(workflowText).toContain('count > 10000');
    expect(workflowText).toContain('total > 67108864');
    expect(workflowText).toContain('maximum > 8388608');
    expect(workflowText).toContain(
      'gzip --decompress --stdout -- "$tarball" | head -c 134217729',
    );
    expect(workflowText).toContain('cmp --silent "$expected_members" "$actual_members"');
    expect(workflowText).toContain(
      '["package/\\(.path)", (.mode | tostring), (.size | tostring)] | @tsv',
    );
    expect(workflowText).toContain('head -c 1048577');
    expect(workflowText).toContain('head -c 8193');
    expect(workflowText).toContain('npm-dist-tags-before.json');
    expect(workflowText).toContain('npm-dist-tags-after.json');
    expect(workflowText).toContain('gh release create "$tag"');
    const releaseRun = releaseSteps.map((step) => String(step.run ?? '')).join('\n');
    expect(releaseRun.indexOf('"repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"'))
      .toBeLessThan(releaseRun.indexOf('gh release create "$tag"'));
    expect(releaseRun.indexOf('compare/${GITHUB_SHA}...${tag}'))
      .toBeGreaterThan(releaseRun.indexOf('gh release create "$tag"'));
    expect(workflowText).toContain('--prerelease --latest=false');
  });

  it('documents manual release recovery without retrying an accepted npm version', () => {
    expect(releaseDocs).toContain('npm accepted the version but the `publish` job later concluded failed');
    expect(releaseDocs).toContain('Do not use **Re-run failed jobs**');
    expect(releaseDocs).toContain('After the integrity and provenance checks above');
    expect(releaseDocs).toContain('clean checkout of the exact tag and its exact extracted');
    expect(releaseDocs).toContain('even when the seven-day handoff\n   artifact has not expired');
    expect(releaseDocs).toContain('set -euo pipefail\n   version=3.2.0\n   release_tag="v${version}"');
    expect(releaseDocs).toContain('git rev-list -n 1 "$release_tag"');
    expect(releaseDocs).toContain(
      'gh release create "$release_tag" --verify-tag --title "$release_tag"',
    );
    expect(releaseDocs).toContain('--notes-file "$release_notes" --prerelease --latest=false');
    expect(releaseDocs).toContain('Promotion is a separate explicit');
    expect(releaseDocs).not.toContain('npm install --package-lock-only');
  });
});

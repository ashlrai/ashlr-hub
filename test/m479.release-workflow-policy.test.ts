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
const publish = jobs.publish;
const steps = publish.steps as Array<Record<string, unknown>>;
const release = jobs.release;
const releaseSteps = release.steps as Array<Record<string, unknown>>;
const checkout = steps[0]!;
const admission = steps[1]!;
const actionRefs = [...steps, ...releaseSteps]
  .flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : []));

describe('M479 npm release workflow supply-chain admission', () => {
  it('pins every third-party action to a reviewed immutable commit', () => {
    expect(actionRefs).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
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

  it('checks out the immutable event SHA without retaining write credentials', () => {
    expect(checkout).toEqual({
      name: 'Checkout the immutable tag target',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
        ref: '${{ github.sha }}',
      },
    });
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

  it('runs admission before dependency install and npm publish, then releases in a dependent job', () => {
    const admissionIndex = steps.indexOf(admission);
    const installIndex = steps.findIndex((step) => step.run === 'npm ci');
    const publishIndex = steps.findIndex((step) =>
      String(step.run ?? '').includes('npm publish "$RUNNER_TEMP/$filename"'),
    );
    const releaseIndex = releaseSteps.findIndex((step) =>
      String(step.run ?? '').includes('gh release create'),
    );

    expect(admissionIndex).toBe(1);
    expect(installIndex).toBeGreaterThan(admissionIndex);
    expect(publishIndex).toBeGreaterThan(installIndex);
    expect(release.needs).toBe('publish');
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(String(admission.run)).not.toMatch(/npm publish|gh release create|NPM_TOKEN/);
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
    expect(publish.needs).toBe('verify');
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
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
    expect(workflowText).toContain('npm publish "$RUNNER_TEMP/$filename"');
    expect(workflowText).toContain('--tag "$RELEASE_DIST_TAG"');
    expect(workflowText).toContain('npm audit signatures');
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
    expect(workflowText).toContain('npm-dist-tags-before.json');
    expect(workflowText).toContain('npm-dist-tags-after.json');
    expect(workflowText).toContain('gh release create "$tag"');
    expect(workflowText).toContain('--prerelease --latest=false');

    const candidateAdmissionIndex = steps.findIndex((step) =>
      step.name === 'Admit exact candidate channel state immediately before publish');
    const handoffIndex = steps.findIndex((step) =>
      step.name === 'Upload bounded GitHub release handoff');
    const publishEffectIndex = steps.findIndex((step) =>
      step.name === 'Publish to npm (provenance)');
    expect(candidateAdmissionIndex).toBe(handoffIndex + 1);
    expect(publishEffectIndex).toBe(candidateAdmissionIndex + 1);
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

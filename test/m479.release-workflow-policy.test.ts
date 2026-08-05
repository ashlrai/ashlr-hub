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
const workflow = parse(workflowText) as Record<string, unknown>;
const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
const publish = jobs.publish;
const steps = publish.steps as Array<Record<string, unknown>>;
const checkout = steps[0]!;
const admission = steps[1]!;
const actionRefs = steps.flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : []));

describe('M479 npm release workflow supply-chain admission', () => {
  it('pins every third-party action to a reviewed immutable commit', () => {
    expect(actionRefs).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
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
  });

  it('checks out the exact tag target without retaining write credentials', () => {
    expect(checkout).toEqual({
      name: 'Checkout the immutable tag target',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
        ref: '${{ github.ref }}',
      },
    });
  });

  it('fails closed unless the peeled tag commit is in protected master history', () => {
    expect(admission.name).toBe('Admit only commits from protected master history');
    expect(admission.shell).toBe('bash');
    expect(admission.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(admission).not.toHaveProperty('continue-on-error');

    const run = String(admission.run);
    expect(run).toContain('set -euo pipefail');
    expect(run).toContain('git rev-parse --verify "${GITHUB_REF}^{commit}"');
    expect(run).toContain('git rev-parse --verify "HEAD^{commit}"');
    expect(run).toContain('[[ "$tag_commit" != "$head_commit" ]]');
    expect(run).toContain('gh api --fail "repos/${GITHUB_REPOSITORY}/branches/master"');
    expect(run).toContain("jq -r '.protected // false'");
    expect(run).toContain("jq -r '.commit.sha // empty'");
    expect(run).toContain('"repos/${GITHUB_REPOSITORY}/compare/${tag_commit}...${master_commit}"');
    expect(run).toContain('[[ "$comparison" != "ahead" && "$comparison" != "identical" ]]');
    expect(run.match(/\bexit 1\b/g)).toHaveLength(3);
  });

  it('runs admission before dependency install and every release side effect', () => {
    const admissionIndex = steps.indexOf(admission);
    const installIndex = steps.findIndex((step) => step.run === 'npm ci');
    const publishIndex = steps.findIndex((step) =>
      String(step.run ?? '').includes('npm publish --provenance'),
    );
    const releaseIndex = steps.findIndex((step) =>
      String(step.run ?? '').includes('gh release create'),
    );

    expect(admissionIndex).toBe(1);
    expect(installIndex).toBeGreaterThan(admissionIndex);
    expect(publishIndex).toBeGreaterThan(installIndex);
    expect(releaseIndex).toBeGreaterThan(publishIndex);
    expect(String(admission.run)).not.toMatch(/npm publish|gh release create|NPM_TOKEN/);
  });

  it('preserves explicit tag activation, native CI, provenance, and version gates', () => {
    expect(workflowText).toContain('tags: ["v*"]');
    expect(jobs.verify).toMatchObject({ uses: './.github/workflows/ci.yml' });
    expect(publish.needs).toBe('verify');
    expect(publish.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    expect(workflowText).toContain('node scripts/check-version.mjs');
    expect(workflowText).toContain('node scripts/extract-changelog.mjs > release-notes.md');
    expect(workflowText).toContain('npm publish --provenance --access public');
    expect(workflowText).toContain('gh release create "$GITHUB_REF_NAME"');
  });
});

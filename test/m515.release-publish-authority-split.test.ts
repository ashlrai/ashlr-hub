import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
}

interface Job {
  environment?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
  'timeout-minutes'?: number;
}

interface Workflow {
  jobs: Record<string, Job>;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowText = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
const workflow = parse(workflowText) as Workflow;

function cloneWorkflow(): Workflow {
  return structuredClone(workflow);
}

function releaseAuthorityViolations(candidate: Workflow): string[] {
  const violations: string[] = [];
  const jobs = candidate.jobs;
  const prepare = jobs.prepare ?? {};
  const publish = jobs.publish ?? {};
  const verifyPublish = jobs.verify_publish ?? {};
  const release = jobs.release ?? {};
  const privilegedJobs = Object.entries(jobs).filter(([, job]) =>
    job.environment === 'npm-release' || job.permissions?.['id-token'] === 'write');

  if (privilegedJobs.length !== 1 || privilegedJobs[0]?.[0] !== 'publish') {
    violations.push('only publish may hold npm-release or id-token authority');
  }
  if (publish['timeout-minutes'] !== 15) {
    violations.push('publish does not have the exact bounded execution timeout');
  }
  if (prepare.environment !== undefined || prepare.permissions?.['id-token'] !== undefined) {
    violations.push('prepare must have no environment or OIDC permission');
  }
  if (prepare.outputs?.candidate_artifact_name !==
        '${{ steps.artifact_names.outputs.candidate_artifact_name }}' ||
      prepare.outputs?.release_artifact_name !==
        '${{ steps.artifact_names.outputs.release_artifact_name }}') {
    violations.push('prepare does not export its exact attempt-specific artifact names');
  }
  if (JSON.stringify(prepare).match(/id-token|secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/)) {
    violations.push('prepare contains a credential or privileged environment reference');
  }

  const publishSteps = publish.steps ?? [];
  const publishActions = publishSteps.flatMap((step) => step.uses ? [step.uses] : []);
  if (publishActions.some((ref) => ref.startsWith('actions/checkout@'))) {
    violations.push('publish checks out candidate repository code');
  }
  const publishRuns = publishSteps.map((step) => step.run ?? '').join('\n');
  if (/\bnpm\s+(?:ci|run|pack)\b|\bnode\s+(?:\.\/)?scripts\/|prepublishOnly|GITHUB_WORKSPACE/.test(
    publishRuns,
  )) {
    violations.push('publish builds, packs, or runs candidate repository code');
  }
  const installCommands = publishRuns.match(/^\s*npm install .*$/gm) ?? [];
  if (installCommands.length !== 1 ||
      !installCommands[0]?.includes('--global npm@11.19.0 --ignore-scripts')) {
    violations.push('publish installs something other than the pinned npm client');
  }
  if ((publishRuns.match(/\bnpm publish\b/g) ?? []).length !== 1 ||
      !publishRuns.includes('npm publish "$TARBALL"') ||
      !publishRuns.includes('--ignore-scripts') ||
      !publishRuns.includes('--registry https://registry.npmjs.org')) {
    violations.push('publish effect is not one ignore-scripts tarball publication');
  }
  if (publish.outputs?.publication_run_attempt !==
        '${{ steps.admission.outputs.publication_run_attempt }}' ||
      !publishRuns.includes(
        "printf 'publication_run_attempt=%s\\n' \"$GITHUB_RUN_ATTEMPT\" >> \"$GITHUB_OUTPUT\"",
      )) {
    violations.push('publish does not export its successful publication attempt');
  }
  for (const [jobName, job] of [
    ['publish', publish], ['verify_publish', verifyPublish], ['release', release],
  ] as const) {
    const serialized = JSON.stringify(job);
    if (serialized.includes('${{ github.run_attempt }}')) {
      violations.push(`${jobName} recomputes artifact identity from a rerun attempt`);
    }
  }
  const publishDownload = publishSteps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'));
  const verifyDownload = (verifyPublish.steps ?? []).find((step) =>
    step.uses?.startsWith('actions/download-artifact@'));
  const releaseDownload = (release.steps ?? []).find((step) =>
    step.uses?.startsWith('actions/download-artifact@'));
  if (!(JSON.stringify(publishDownload) ?? '').includes(
    '${{ needs.prepare.outputs.candidate_artifact_name }}',
  ) || !(JSON.stringify(verifyDownload) ?? '').includes(
    '${{ needs.prepare.outputs.candidate_artifact_name }}',
  ) || !(JSON.stringify(releaseDownload) ?? '').includes(
    '${{ needs.prepare.outputs.release_artifact_name }}',
  )) {
    violations.push('downstream jobs do not consume prepare-owned artifact identity');
  }
  if (!publishRuns.includes('EXPECTED_MANIFEST_SHA256') ||
      !publishRuns.includes('sha256sum "$manifest"') ||
      !publishRuns.includes('computed_integrity="sha512-$(openssl dgst -sha512 -binary "$tarball"') ||
      !publishRuns.includes('TAR_OPTIONS= tar -xOf "$archive" package/dist/build-identity.json') ||
      !publishRuns.includes('gzip --decompress --stdout -- "$tarball" | head -c 134217729') ||
      !publishRuns.includes('archive_bytes > 134217728') ||
      !publishRuns.includes('cmp --silent "$expected_members" "$actual_members"') ||
      !publishRuns.includes('["package/\\(.path)", (.mode | tostring), (.size | tostring)] | @tsv') ||
      !publishRuns.includes('(map(.path) | length == (unique | length))') ||
      !publishRuns.includes('all(.[].path | split("/")') ||
      !publishRuns.includes('. != "." and . != ".."') ||
      !publishRuns.includes('(. == 420 or . == 493)') ||
      (publishRuns.match(/--absolute-names/g) ?? []).length !== 2 ||
      !publishRuns.includes('count > 10000') ||
      !publishRuns.includes('total > 67108864') ||
      !publishRuns.includes('maximum > 8388608') ||
      !publishRuns.includes('head -c 1048577') ||
      !publishRuns.includes('head -c 8193')) {
    violations.push('publish does not bind and inspect the prepared bytes');
  }

  if (verifyPublish.environment !== undefined || verifyPublish.permissions?.['id-token'] !== undefined) {
    violations.push('post-publication verification must not retain publish authority');
  }
  const verifyRuns = (verifyPublish.steps ?? []).map((step) => step.run ?? '').join('\n');
  if (!verifyRuns.includes('npm audit signatures --json --include-attestations') ||
      !verifyRuns.includes('verify-npm-release-provenance.mjs')) {
    violations.push('signature and provenance verification escaped the unprivileged verifier');
  }
  const verifyEnvironment = (verifyPublish.steps ?? [])
    .find((step) => step.name === 'Verify immutable candidate and preserved dist-tags') as
      (Step & { env?: Record<string, string> }) | undefined;
  if (verifyEnvironment?.env?.PUBLICATION_RUN_ATTEMPT !==
        '${{ needs.publish.outputs.publication_run_attempt }}' ||
      !verifyRuns.includes('"$PUBLICATION_RUN_ATTEMPT"') ||
      verifyRuns.includes('"$GITHUB_RUN_ATTEMPT"')) {
    violations.push('verifier does not bind provenance to the successful publisher attempt');
  }
  if (!Array.isArray(release.needs) || !release.needs.includes('verify_publish')) {
    violations.push('GitHub release is not gated by publication verification');
  }
  const releaseRuns = (release.steps ?? []).map((step) => step.run ?? '').join('\n');
  const liveTagIndex = releaseRuns.indexOf('"repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"');
  const createReleaseIndex = releaseRuns.indexOf('gh release create "$tag"');
  const releasePostconditionIndex = releaseRuns.indexOf('compare/${GITHUB_SHA}...${tag}');
  if (liveTagIndex < 0 || createReleaseIndex <= liveTagIndex ||
      releasePostconditionIndex <= createReleaseIndex ||
      !releaseRuns.slice(liveTagIndex, createReleaseIndex).includes('.object.sha == $sha')) {
    violations.push('GitHub release creation is not enclosed by exact live-tag gates');
  }
  return violations;
}

describe('release publish authority split', () => {
  it('keeps all candidate execution outside the only OIDC-capable job', () => {
    expect(releaseAuthorityViolations(workflow)).toEqual([]);

    const prepareRuns = (workflow.jobs.prepare?.steps ?? [])
      .map((step) => step.run ?? '').join('\n');
    expect(prepareRuns).toContain('npm ci');
    expect(prepareRuns).toContain('npm run build');
    expect(prepareRuns).toContain('npm run prepublishOnly');
    expect(prepareRuns).toContain('npm pack --json --ignore-scripts');

    expect(workflow.jobs.publish).toMatchObject({
      needs: 'prepare',
      environment: 'npm-release',
      permissions: { contents: 'read', 'id-token': 'write' },
    });
    expect(workflow.jobs.verify_publish).toMatchObject({
      needs: ['prepare', 'publish'],
      permissions: { contents: 'read' },
    });
  });

  it.each([
    ['OIDC on prepare', (mutated: Workflow) => {
      mutated.jobs.prepare!.permissions!['id-token'] = 'write';
    }],
    ['checkout in publish', (mutated: Workflow) => {
      mutated.jobs.publish!.steps!.unshift({ uses: 'actions/checkout@' + '1'.repeat(40) });
    }],
    ['candidate install in publish', (mutated: Workflow) => {
      mutated.jobs.publish!.steps!.push({ run: 'npm ci' });
    }],
    ['candidate build in publish', (mutated: Workflow) => {
      mutated.jobs.publish!.steps!.push({ run: 'npm run build' });
    }],
    ['candidate script in publish', (mutated: Workflow) => {
      mutated.jobs.publish!.steps!.push({ run: 'node scripts/check-version.mjs' });
    }],
    ['candidate pack in publish', (mutated: Workflow) => {
      mutated.jobs.publish!.steps!.push({ run: 'npm pack --json' });
    }],
    ['second install in publish', (mutated: Workflow) => {
      mutated.jobs.publish!.steps!.push({ run: 'npm install @ashlr/hub@3.2.0' });
    }],
    ['unbounded publisher duration', (mutated: Workflow) => {
      delete mutated.jobs.publish!['timeout-minutes'];
    }],
    ['selected member extraction loses stream cap', (mutated: Workflow) => {
      const verify = mutated.jobs.publish!.steps!.find((step) =>
        step.name === 'Verify bounded prepared candidate without executing it')!;
      verify.run = verify.run!.replace(' | head -c 1048577', '');
    }],
    ['gzip global expansion cap removed', (mutated: Workflow) => {
      const verify = mutated.jobs.publish!.steps!.find((step) =>
        step.name === 'Verify bounded prepared candidate without executing it')!;
      verify.run = verify.run!.replace(' | head -c 134217729', '');
    }],
    ['canonical member comparison removed', (mutated: Workflow) => {
      const verify = mutated.jobs.publish!.steps!.find((step) =>
        step.name === 'Verify bounded prepared candidate without executing it')!;
      verify.run = verify.run!.replace(
        'cmp --silent "$expected_members" "$actual_members"',
        'true',
      );
    }],
    ['pack path normalization removed', (mutated: Workflow) => {
      const verify = mutated.jobs.publish!.steps!.find((step) =>
        step.name === 'Verify bounded prepared candidate without executing it')!;
      verify.run = verify.run!.replace('. != "." and . != ".."', 'true');
    }],
    ['archive expanded-size cap removed', (mutated: Workflow) => {
      const verify = mutated.jobs.publish!.steps!.find((step) =>
        step.name === 'Verify bounded prepared candidate without executing it')!;
      verify.run = verify.run!.replace('total > 67108864', 'total > 999999999');
    }],
    ['verifier uses its rerun attempt', (mutated: Workflow) => {
      const verify = mutated.jobs.verify_publish!.steps!.find((step) =>
        step.name === 'Verify immutable candidate and preserved dist-tags')!;
      verify.run = verify.run!.replace('$PUBLICATION_RUN_ATTEMPT', '$GITHUB_RUN_ATTEMPT');
    }],
    ['provenance verifier removed', (mutated: Workflow) => {
      mutated.jobs.verify_publish!.steps = [];
    }],
    ['GitHub release bypasses verification', (mutated: Workflow) => {
      mutated.jobs.release!.needs = 'publish';
    }],
    ['GitHub release loses immediate live-tag gate', (mutated: Workflow) => {
      const create = mutated.jobs.release!.steps!.find((step) =>
        step.name === 'Create or verify the exact GitHub release')!;
      create.run = create.run!.replace(
        '"repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"',
        '"repos/${GITHUB_REPOSITORY}/git/ref/tags/stale"',
      );
    }],
    ['rerun recomputes candidate artifact name', (mutated: Workflow) => {
      const download = mutated.jobs.publish!.steps!.find((step) =>
        step.uses?.startsWith('actions/download-artifact@'))! as Step & { with: Record<string, string> };
      download.with.name = 'npm-publish-candidate-${{ github.run_id }}-${{ github.run_attempt }}';
    }],
  ] as const)('rejects hostile policy mutation: %s', (_label, mutate) => {
    const mutated = cloneWorkflow();
    mutate(mutated);
    expect(releaseAuthorityViolations(mutated)).not.toEqual([]);
  });

  it('keeps publisher attempt one when verification is rerun as attempt two', () => {
    const publish = workflow.jobs.publish!;
    const verifyStep = workflow.jobs.verify_publish!.steps!.find((step) =>
      step.name === 'Verify immutable candidate and preserved dist-tags') as
        Step & { env: Record<string, string> };
    const publisherContext = { GITHUB_RUN_ATTEMPT: '1' };
    const verifierContext = { GITHUB_RUN_ATTEMPT: '2' };
    const publishedOutputs = {
      publication_run_attempt: publish.outputs?.publication_run_attempt ===
        '${{ steps.admission.outputs.publication_run_attempt }}'
        ? publisherContext.GITHUB_RUN_ATTEMPT
        : '',
    };
    const verifierInput = verifyStep.env.PUBLICATION_RUN_ATTEMPT ===
      '${{ needs.publish.outputs.publication_run_attempt }}'
      ? publishedOutputs.publication_run_attempt
      : verifierContext.GITHUB_RUN_ATTEMPT;

    expect(verifierContext.GITHUB_RUN_ATTEMPT).toBe('2');
    expect(verifierInput).toBe('1');
    expect(verifyStep.run).toContain('"$PUBLICATION_RUN_ATTEMPT"');
    expect(verifyStep.run).not.toContain('"$GITHUB_RUN_ATTEMPT"');
  });

  it('rejects member swaps, traversal, and privilege-mode drift from the pack report', () => {
    const expected: Array<[string, number, number]> = [
      ['package/package.json', 420, 100],
      ['package/dist/build-identity.json', 420, 80],
      ['package/dist/cli.js', 493, 200],
    ];
    const canonical = (members: Array<[string, number, number]>): string =>
      members.map((member) => member.join('\t')).sort().join('\n');

    expect(canonical(expected)).not.toBe(canonical([
      ['package/package.json', 420, 200],
      ['package/dist/build-identity.json', 420, 80],
      ['package/dist/cli.js', 493, 100],
    ]));
    expect(canonical(expected)).not.toBe(canonical([
      ['package/package.json', 420, 100],
      ['package/../outside', 420, 80],
      ['package/dist/cli.js', 493, 200],
    ]));
    expect(canonical(expected)).not.toBe(canonical([
      ['package/package.json', 420, 100],
      ['package/dist/build-identity.json', 420, 80],
      ['package/dist/cli.js', 511, 200],
    ]));
  });

  it('documents the remaining same-workflow artifact trust boundary', () => {
    const docs = readFileSync(join(repoRoot, 'docs/RELEASING.md'), 'utf8');
    expect(docs).toContain('Candidate-controlled lifecycle and repository code');
    expect(docs).toMatch(/execute\s+only\s+in this unprivileged job/);
    expect(docs).toMatch(/does\s+not check out the repository/);
    expect(docs).toContain('never executes the candidate');
    expect(docs).toContain('not an independently reproduced\nbuild or separate release authority');
  });
});

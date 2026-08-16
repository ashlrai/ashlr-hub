/**
 * M33 — distribution metadata: package.json publish shape, the exports map,
 * the release scripts (check-version / extract-changelog), and the release
 * workflow's gates. Pure filesystem reads + child-process runs of the
 * scripts; no network, no HOME mutation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  readBoundedJson,
  verifyNpmReleaseProvenance,
} from '../scripts/verify-npm-release-provenance.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  expect.hasAssertions();
});

describe('package.json publish shape', () => {
  it('is the public scoped package with provenance', () => {
    expect(pkg['name']).toBe('@ashlr/hub');
    expect(pkg['private']).toBeUndefined();
    expect((pkg['publishConfig'] as Record<string, unknown>)['access']).toBe('public');
    expect((pkg['publishConfig'] as Record<string, unknown>)['provenance']).toBe(true);
  });

  it('gates publish behind the full verification suite', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['prepublishOnly']).toContain('typecheck');
    expect(scripts['prepublishOnly']).toContain('test');
    expect(scripts['prepare']).toBeUndefined();
    expect(scripts['prepack']).toContain('build');
  });

  it('exports map covers ., ./core, ./types, ./plugin with types conditions', () => {
    const exports = pkg['exports'] as Record<string, Record<string, string> | string>;
    for (const entry of ['.', './core', './types', './plugin']) {
      const e = exports[entry];
      expect(e, `missing exports["${entry}"]`).toBeTruthy();
      expect((e as Record<string, string>)['types']).toMatch(/^\.\/dist\/api\/.+\.d\.ts$/);
      expect((e as Record<string, string>)['import']).toMatch(/^\.\/dist\/api\/.+\.js$/);
    }
    expect(exports['./package.json']).toBe('./package.json');
  });

  it('the api source files behind the exports map exist', () => {
    for (const f of ['index.ts', 'core.ts', 'types.ts', 'plugin.ts']) {
      expect(existsSync(join(REPO_ROOT, 'src', 'api', f)), `src/api/${f} missing`).toBe(true);
    }
  });
});

describe('release scripts', () => {
  it('check-version passes on a matching tag and fails on a mismatch', () => {
    const version = pkg['version'] as string;
    const ok = execFileSync('node', [join(REPO_ROOT, 'scripts/check-version.mjs'), `v${version}`], {
      encoding: 'utf8',
    });
    expect(ok).toContain('ok');

    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/check-version.mjs'), 'v0.0.1-nope'], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('extract-changelog prints the current version section and fails on unknown versions', () => {
    const version = pkg['version'] as string;
    const body = execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), version], {
      encoding: 'utf8',
    });
    expect(body.trim().length).toBeGreaterThan(50);
    const implicitBody = execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs')], {
      encoding: 'utf8',
    });
    expect(implicitBody).toBe(body);

    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), '0.0.1'], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });

  it.each([
    '3.2.0.*',
    '3.2.0[abc]',
    '3.2.0\\',
    '3.2.0/../3.1.0',
    '3.2.0\n## [3.1.0]',
    '03.2.0',
    '3.02.0',
    '3.2.00',
    'v3.2.0',
    '3.2',
    '3.2.0-beta.1',
    '3.2.0+build',
    '1'.repeat(65),
    '',
  ])('extract-changelog rejects noncanonical argv %j without regex interpretation', (version) => {
    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), version], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('extract-changelog never compiles release argv as a regular expression', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/extract-changelog.mjs'), 'utf8');
    expect(source).not.toContain('new RegExp');
    expect(source).toContain('canonicalVersionRe');
    expect(source).toContain('line.startsWith(`${heading} — `)');
  });
});

describe('release workflow', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
  const ciWorkflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const releaseDocs = readFileSync(join(REPO_ROOT, 'docs/RELEASING.md'), 'utf8');
  interface WorkflowStep {
    name?: string;
    uses?: string;
    run?: string;
    env?: Record<string, unknown>;
    with?: Record<string, unknown>;
  }
  interface WorkflowJob {
    uses?: string;
    needs?: string | string[];
    environment?: string;
    env?: Record<string, unknown>;
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    steps?: WorkflowStep[];
    'runs-on'?: string;
    'timeout-minutes'?: number;
  }
  interface ReleaseWorkflow {
    on?: { push?: { tags?: string[] } };
    concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
    env?: Record<string, string>;
    permissions?: Record<string, string>;
    jobs?: Record<string, WorkflowJob>;
  }
  const parsed = parseYaml(workflow) as ReleaseWorkflow;
  const jobs = parsed.jobs ?? {};
  const verifyJob = jobs['verify'] ?? {};
  const releaseCanaryJob = jobs['release_canary'] ?? {};
  const prepareJob = jobs['prepare'] ?? {};
  const publishJob = jobs['publish'] ?? {};
  const verifyPublishJob = jobs['verify_publish'] ?? {};
  const releaseJob = jobs['release'] ?? {};
  const steps = (job: WorkflowJob): WorkflowStep[] => job.steps ?? [];
  const runText = (job: WorkflowJob): string => steps(job).map((step) => step.run ?? '').join('\n');
  const action = (job: WorkflowJob, prefix: string): WorkflowStep | undefined =>
    steps(job).find((step) => step.uses?.startsWith(prefix));

  it('is tag-triggered and reuses the exact native CI gate before publish', () => {
    expect(parsed.on?.push?.tags).toEqual(['v*']);
    expect(parsed.env).toEqual({
      RELEASE_VERSION: '3.2.5',
      RELEASE_DIST_TAG: 'candidate',
      BASELINE_LATEST_VERSION: '3.0.1',
    });
    expect(parsed.concurrency).toEqual({
      group: 'npm-candidate-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    expect(parsed.permissions).toEqual({});
    expect(Object.keys(jobs)).toEqual([
      'verify', 'release_canary', 'prepare', 'publish', 'verify_publish', 'release',
    ]);
    expect(verifyJob.uses).toBe('./.github/workflows/ci.yml');
    expect(verifyJob.permissions).toEqual({ contents: 'read' });
    expect(ciWorkflow).toMatch(/(?:^|\n)\s{2}workflow_call:\s*(?:\n|$)/);
    const parsedCi = parseYaml(ciWorkflow) as {
      jobs?: {
        ci?: {
          strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
          steps?: Array<{ name?: string; run?: string }>;
        };
      };
    };
    const ciJob = parsedCi.jobs?.ci;
    const exhaustiveUbuntu = (ciJob?.strategy?.matrix?.include ?? [])
      .filter((entry) => entry['os'] === 'ubuntu-latest')
      .map((entry) => ({ label: entry['label'], test_args: entry['test_args'] }));
    expect(exhaustiveUbuntu).toEqual([
      { label: 'ubuntu, authority 1/3', test_args: '--shard=1/3' },
      { label: 'ubuntu, authority 2/3', test_args: '--shard=2/3' },
      { label: 'ubuntu, authority 3/3', test_args: '--shard=3/3' },
    ]);
    const ciSteps = ciJob?.steps ?? [];
    expect(ciSteps.find((step) => step.name === 'Typecheck')?.run).toBe('npm run typecheck');
    expect(ciSteps.find((step) => step.name === 'Lint')?.run).toBe('npm run lint');
    expect(ciSteps.find((step) => step.name === 'Build')?.run).toBe('npm run build');
    expect(ciSteps.find((step) => step.name === 'Test (hermetic)')?.run)
      .toBe('npm run test:ci -- ${{ matrix.test_args }}');
    expect(verifyJob['runs-on']).toBeUndefined();
    expect(verifyJob.steps).toBeUndefined();
    expect(verifyJob.environment).toBeUndefined();
    expect(releaseCanaryJob.needs).toBe('verify');
    expect(prepareJob.needs).toEqual(['verify', 'release_canary']);
    expect(publishJob.needs).toBe('prepare');
    expect(verifyPublishJob.needs).toEqual(['prepare', 'publish']);
    expect(releaseJob.needs).toEqual(['prepare', 'verify_publish']);
    expect(ciWorkflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ciWorkflow).not.toMatch(/^\s+environment:/m);
  });

  it('uses exact job-scoped trusted-publishing authority and pinned tooling', () => {
    expect(prepareJob.environment).toBeUndefined();
    expect(prepareJob.permissions).toEqual({ contents: 'read' });
    expect(prepareJob.outputs).toEqual({
      candidate_artifact_name: '${{ steps.artifact_names.outputs.candidate_artifact_name }}',
      manifest_sha256: '${{ steps.candidate.outputs.manifest_sha256 }}',
      release_artifact_name: '${{ steps.artifact_names.outputs.release_artifact_name }}',
    });
    const checkout = action(prepareJob, 'actions/checkout@');
    expect(checkout?.uses).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 0,
      'persist-credentials': false,
      ref: '${{ github.sha }}',
    });
    const prepareRun = runText(prepareJob);
    expect(prepareRun).toContain('node "$ASHLR_RELEASE_NPM_CLI" ci');
    expect(prepareRun).toContain('node "$ASHLR_RELEASE_NPM_CLI" run build');
    expect(prepareRun).toContain('scripts/check-version.mjs');
    expect(prepareRun).toContain('scripts/extract-changelog.mjs');
    expect(prepareRun).not.toContain('prepublishOnly');
    expect(prepareRun).not.toContain('test:ci');
    expect(prepareRun).toContain(
      'node "$ASHLR_RELEASE_NPM_CLI" pack --json --ignore-scripts',
    );
    expect(prepareRun).toContain('dist/build-identity.json');
    expect(prepareRun).toContain('.revision == $revision');
    expect(prepareRun).toContain('.dirty == false');
    expect(prepareRun).toContain('test -z "$(git status --porcelain --untracked-files=normal)"');

    expect(publishJob['runs-on']).toBe('ubuntu-latest');
    expect(publishJob['timeout-minutes']).toBe(15);
    expect(publishJob.environment).toBe('npm-release');
    expect(publishJob.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(publishJob.outputs).toEqual({
      dist_tags_before_b64: '${{ steps.admission.outputs.dist_tags_before_b64 }}',
      publication_run_attempt: '${{ steps.admission.outputs.publication_run_attempt }}',
    });
    expect(action(publishJob, 'actions/checkout@')).toBeUndefined();
    const setupNode = action(publishJob, 'actions/setup-node@');
    expect(setupNode?.uses).toBe('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
    expect(setupNode?.with).toEqual({
      'node-version': '24.19.0',
      'registry-url': 'https://registry.npmjs.org',
      'package-manager-cache': false,
    });
    const publishRun = runText(publishJob);
    expect(publishRun).toContain('npm install --global npm@11.19.0');
    expect(publishRun).toContain('test "$(npm --version)" = "11.19.0"');
    expect(publishRun.match(/npm publish "\$TARBALL"/g)).toHaveLength(1);
    expect(publishRun).toContain('--ignore-scripts');
    expect(publishRun).toContain('--provenance');
    expect(publishRun).toContain('--access public');
    expect(publishRun).toContain('--tag "$RELEASE_DIST_TAG"');
    expect(publishRun).not.toMatch(/npm publish --provenance --access public(?:\s|$)/);
    expect(publishRun).not.toMatch(
      /(?:npm|node "\$ASHLR_RELEASE_NPM_CLI") (?:ci|run|pack)\b|node scripts\//,
    );

    expect(verifyPublishJob.environment).toBeUndefined();
    expect(verifyPublishJob.permissions).toEqual({ contents: 'read' });
    const postPublish = steps(verifyPublishJob).at(-1);
    expect(postPublish?.name).toBe('Verify immutable candidate and preserved dist-tags');
    expect(postPublish?.run).toContain('.dist.integrity == $integrity');
    expect(postPublish?.run).toContain('https://slsa.dev/provenance/v1');
    expect(postPublish?.run).toContain('npm audit signatures');
    expect(postPublish?.run).toContain('npm-dist-tags-before.json');
    expect(postPublish?.run).toContain('npm-dist-tags-after.json');
    expect(postPublish?.run).toContain(
      'npm install --ignore-scripts --no-audit --no-fund --save-exact',
    );
    expect(postPublish?.run).not.toContain('--package-lock-only');
    expect(postPublish?.run).toContain(
      'require(\'./node_modules/@ashlr/hub/package.json\').version',
    );
    expect(postPublish?.run).toContain('test "$installed_version" = "$RELEASE_VERSION"');
    expect(postPublish?.run).toContain('npm audit signatures --json --include-attestations');
    expect(postPublish?.run).toContain('verify-npm-release-provenance.mjs');
    expect(postPublish?.env).toMatchObject({
      PUBLICATION_RUN_ATTEMPT: '${{ needs.publish.outputs.publication_run_attempt }}',
    });
    expect(postPublish?.run).toContain('"$PUBLICATION_RUN_ATTEMPT"');
    expect(postPublish?.run).not.toContain('"$GITHUB_RUN_ATTEMPT"');
    expect(postPublish?.run).toContain('if ! version_status="$(curl');
    expect(postPublish?.run).toContain('if ! packument_status="$(curl');
    expect(postPublish?.run).toContain('version_status=000');
    expect(postPublish?.run).toContain('packument_status=000');

    const candidateAdmissionIndex = steps(publishJob).findIndex((step) =>
      step.name === 'Admit exact candidate channel state immediately before publish');
    const preparedIndex = steps(publishJob).findIndex((step) =>
      step.name === 'Verify bounded prepared candidate without executing it');
    const publishIndex = steps(publishJob).findIndex((step) =>
      step.name === 'Publish to npm (provenance)');
    expect(candidateAdmissionIndex).toBe(preparedIndex + 1);
    expect(publishIndex).toBe(candidateAdmissionIndex + 1);
    const candidateAdmission = steps(publishJob)[candidateAdmissionIndex];
    expect(candidateAdmission?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(candidateAdmission?.run).toContain('.object.type == "commit"');
    expect(candidateAdmission?.run).toContain('.object.sha == $sha');
    expect(candidateAdmission?.run).toContain(
      "printf 'publication_run_attempt=%s\\n' \"$GITHUB_RUN_ATTEMPT\" >> \"$GITHUB_OUTPUT\"",
    );
    const preparedVerification = steps(publishJob)[preparedIndex]?.run ?? '';
    expect(preparedVerification).toContain('.unpackedSize == $unpackedBytes');
    expect(preparedVerification).toContain('count > 10000');
    expect(preparedVerification).toContain('total > 67108864');
    expect(preparedVerification).toContain('maximum > 8388608');
    expect(preparedVerification).toContain(
      'gzip --decompress --stdout -- "$tarball" | head -c 134217729',
    );
    expect(preparedVerification).toContain('archive_bytes > 134217728');
    expect(preparedVerification).toContain(
      '["package/\\(.path)", (.mode | tostring), (.size | tostring)] | @tsv',
    );
    expect(preparedVerification).toContain('cmp --silent "$expected_members" "$actual_members"');
    expect(preparedVerification).toContain('head -c 1048577');
    expect(preparedVerification).toContain('head -c 8193');

    const structuredWorkflow = JSON.stringify(parsed);
    expect(structuredWorkflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.NPM_TOKEN/);
    for (const job of Object.values(jobs)) {
      for (const step of steps(job)) {
        expect(Object.keys(step.env ?? {})).not.toContain('NODE_AUTH_TOKEN');
        expect(Object.keys(step.env ?? {})).not.toContain('NPM_TOKEN');
      }
    }
  });

  it('hands only bounded public notes to a separate non-publishing release job', () => {
    const upload = steps(prepareJob).find((step) =>
      step.name === 'Upload bounded GitHub release handoff');
    expect(upload?.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(upload?.with).toEqual({
      name: '${{ steps.artifact_names.outputs.release_artifact_name }}',
      path: '${{ steps.candidate.outputs.notes }}\n${{ steps.candidate.outputs.manifest }}\n',
      'if-no-files-found': 'error',
      'retention-days': 7,
      'compression-level': 9,
      overwrite: false,
      'include-hidden-files': false,
    });
    expect(runText(prepareJob)).toContain('notes_bytes > 65536');

    expect(releaseJob['runs-on']).toBe('ubuntu-latest');
    expect(releaseJob.environment).toBeUndefined();
    expect(releaseJob.permissions).toEqual({ contents: 'write' });
    expect(releaseJob.env).toEqual({ GH_REPO: '${{ github.repository }}' });
    const download = action(releaseJob, 'actions/download-artifact@');
    expect(download?.uses).toBe('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
    expect(download?.with).toEqual({
      name: '${{ needs.prepare.outputs.release_artifact_name }}',
      path: 'release-handoff',
      'digest-mismatch': 'error',
    });
    const releaseRun = runText(releaseJob);
    expect(releaseRun).toContain('entry_count');
    expect(releaseRun).toContain('file_count');
    expect(releaseRun).toContain('EXPECTED_MANIFEST_SHA256');
    expect(releaseRun).toContain('notes_bytes');
    expect(releaseRun).toContain('gh release create "$tag" --verify-tag');
    expect(releaseRun).toContain('--prerelease --latest=false');
    expect(releaseRun).toContain("'.tagName == $tag and .name == $tag");
    expect(releaseRun).toContain('.isPrerelease == true');
    expect(releaseRun).toContain("jq -rj '.body'");
    expect(releaseRun).not.toContain("--jq '.body'");
    expect(releaseRun).toContain('compare/${GITHUB_SHA}...${tag}');
    const createIndex = releaseRun.indexOf('gh release create "$tag"');
    const liveTagIndex = releaseRun.indexOf(
      '"repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"',
    );
    const postconditionIndex = releaseRun.indexOf('compare/${GITHUB_SHA}...${tag}');
    expect(liveTagIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(liveTagIndex);
    expect(postconditionIndex).toBeGreaterThan(createIndex);
    expect(releaseRun.slice(liveTagIndex, createIndex)).toContain('.object.type == "commit"');
    expect(releaseRun.slice(liveTagIndex, createIndex)).toContain('.object.sha == $sha');
    expect(releaseRun).not.toMatch(/npm (?:publish|install|ci|run)|setup-node|id-token/);
  });

  it('documents the exact external trusted-publisher activation boundary', () => {
    expect(releaseDocs).toContain('npm trust github @ashlr/hub');
    expect(releaseDocs).toContain('--repo ashlrai/ashlr-hub');
    expect(releaseDocs).toContain('--file release.yml');
    expect(releaseDocs).toContain('--environment npm-release');
    expect(releaseDocs).toContain('--allow-publish');
    expect(releaseDocs).toContain('npm trust list @ashlr/hub');
    expect(releaseDocs).toMatch(/requires an authenticated\s+maintainer/);
    expect(releaseDocs).toContain('**not** independent two-person approval');
    expect(releaseDocs).toContain('does not inject `NODE_AUTH_TOKEN`');
    expect(releaseDocs).toContain('Re-run failed jobs');
    expect(releaseDocs).toMatch(/never\s+invoke publish again/);
    expect(releaseDocs).toContain("process.versions.node.split(\".\")[0]");
    expect(releaseDocs).toContain('npm@11.19.0');
    expect(releaseDocs).toContain('git status --porcelain --untracked-files=all');
    expect(releaseDocs).toContain('npm provenance attestation');
    expect(releaseDocs).toContain('.github/workflows/release.yml');
    expect(releaseDocs).toContain('the exact\n   tag commit');
    expect(releaseDocs).toContain('Do not use **Re-run failed jobs**');
    expect(releaseDocs).toContain('even when the seven-day handoff\n   artifact has not expired');
    expect(releaseDocs).toContain('set -euo pipefail\n   version=3.2.5\n   release_tag="v${version}"');
    expect(releaseDocs).toContain('git rev-list -n 1 "$release_tag"');
    expect(releaseDocs).toContain('node scripts/extract-changelog.mjs "$version" > "$release_notes"');
    expect(releaseDocs).toContain(
      'gh release create "$release_tag" --verify-tag --title "$release_tag"',
    );
    expect(releaseDocs).toContain('--notes-file "$release_notes" --prerelease --latest=false');
    expect(releaseDocs).toMatch(/npm `latest`\s+to equal `3\.0\.1`/);
    expect(releaseDocs).toContain('node "$npm_cli" audit signatures');
    expect(releaseDocs).toContain(
      'node "$npm_cli" install --ignore-scripts --no-audit --no-fund --save-exact',
    );
    expect(releaseDocs).not.toContain('npm install --package-lock-only');
    expect(releaseDocs).toContain('Promotion is a separate explicit');
    expect(releaseDocs).toContain('npm dist-tags do not offer a\ncompare-and-swap operation');
    expect(releaseDocs).not.toContain('gh secret set NPM_TOKEN');
  });

  it.skipIf(process.platform === 'win32')('retries post-publish transport failures under set -e', () => {
    const postPublish = steps(verifyPublishJob).find((step) =>
      step.name === 'Verify immutable candidate and preserved dist-tags');
    const run = postPublish?.run ?? '';
    const start = run.indexOf('version_metadata=');
    const end = run.indexOf('if [[ "$observed" != "true" ]]');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const root = mkdtempSync(join(tmpdir(), 'ashlr-release-retry-'));
    try {
      const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
      writeFileSync(join(root, 'npm-dist-tags-before.json'), '{"latest":"3.0.1"}\n');
      writeFileSync(join(root, 'version.json'), JSON.stringify({
        name: '@ashlr/hub',
        version: '3.2.0',
        dist: {
          integrity,
          attestations: {
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
            url: 'https://registry.npmjs.org/-/npm/v1/attestations/@ashlr%2Fhub@3.2.0',
          },
        },
      }));
      writeFileSync(join(root, 'packument.json'), JSON.stringify({
        'dist-tags': { latest: '3.0.1', candidate: '3.2.0' },
      }));
      writeFileSync(join(root, 'curl-count'), '0\n');

      const retryBlock = run.slice(start, end).replace('sleep 5', 'sleep 0');
      const script = `
        set -euo pipefail
        expected_integrity="$EXPECTED_INTEGRITY"
        curl() {
          local output='' previous='' url='' count
          for argument in "$@"; do
            if [[ "$previous" == '--output' ]]; then output="$argument"; fi
            previous="$argument"
            url="$argument"
          done
          count="$(<"$RUNNER_TEMP/curl-count")"
          count=$((count + 1))
          printf '%s\\n' "$count" > "$RUNNER_TEMP/curl-count"
          if (( count <= 2 )); then return 7; fi
          if [[ "$url" == */3.2.0 ]]; then
            cp "$VERSION_FIXTURE" "$output"
          else
            cp "$PACKUMENT_FIXTURE" "$output"
          fi
          printf '200'
        }
        ${retryBlock}
        test "$observed" = true
        test "$(<"$RUNNER_TEMP/curl-count")" = 4
      `;
      execFileSync('/bin/bash', ['-c', script], {
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          RELEASE_VERSION: '3.2.0',
          RELEASE_DIST_TAG: 'candidate',
          BASELINE_LATEST_VERSION: '3.0.1',
          EXPECTED_INTEGRITY: integrity,
          VERSION_FIXTURE: join(root, 'version.json'),
          PACKUMENT_FIXTURE: join(root, 'packument.json'),
        },
        stdio: 'pipe',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a rewritten or annotated remote tag immediately before publish',
    () => {
      const admission = steps(publishJob).find((step) =>
        step.name === 'Admit exact candidate channel state immediately before publish');
      const run = admission?.run ?? '';
      const start = run.indexOf('tag_ref_json=');
      expect(start).toBeGreaterThan(-1);
      const remoteTagGate = run.slice(start);
      const eventSha = '1'.repeat(40);
      const script = `
        set -euo pipefail
        gh() {
          printf '{"ref":"%s","object":{"type":"%s","sha":"%s"}}\\n' \\
            "$GITHUB_REF" "$MOCK_TAG_TYPE" "$MOCK_TAG_SHA"
        }
        ${remoteTagGate}
      `;
      const execute = (tagSha: string, tagType: string) => execFileSync('/bin/bash', ['-c', script], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'ashlrai/ashlr-hub',
          GITHUB_REF: 'refs/tags/v3.2.0',
          GITHUB_REF_NAME: 'v3.2.0',
          GITHUB_SHA: eventSha,
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_OUTPUT: '/dev/null',
          MOCK_TAG_SHA: tagSha,
          MOCK_TAG_TYPE: tagType,
        },
        stdio: 'pipe',
      });

      expect(() => execute(eventSha, 'commit')).not.toThrow();
      expect(() => execute('2'.repeat(40), 'commit')).toThrow();
      expect(() => execute(eventSha, 'tag')).toThrow();
    },
  );
});

describe('exact npm release provenance', () => {
  const digest = 'ab'.repeat(64);
  const integrity = `sha512-${Buffer.from(digest, 'hex').toString('base64')}`;
  const release = {
    packageName: '@ashlr/hub',
    version: '3.2.0',
    integrity,
    repository: 'https://github.com/ashlrai/ashlr-hub',
    workflowPath: '.github/workflows/release.yml',
    ref: 'refs/tags/v3.2.0',
    revision: '1'.repeat(40),
    runId: '31870000000',
    runAttempt: '1',
  };

  function audit(
    overrides: Record<string, unknown> = {},
    identityOverrides: Partial<typeof release> = {},
  ) {
    const identity = { ...release, ...identityOverrides };
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'pkg:npm/%40ashlr/hub@3.2.0', digest: { sha512: digest } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
          externalParameters: { workflow: {
            ref: identity.ref, repository: identity.repository, path: identity.workflowPath,
          } },
          internalParameters: { github: { event_name: 'push' } },
          resolvedDependencies: [{
            uri: `git+${identity.repository}@${identity.ref}`,
            digest: { gitCommit: identity.revision },
          }],
        },
        runDetails: {
          builder: { id: 'https://github.com/actions/runner/github-hosted' },
          metadata: {
            invocationId:
              `${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
          },
        },
      },
      ...overrides,
    };
    return {
      invalid: [],
      missing: [],
      verified: [{
        name: release.packageName,
        version: release.version,
        location: `node_modules/${release.packageName}`,
        attestationBundles: [{
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: { dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          } },
        }],
      }],
    };
  }

  it('accepts the exact package, workflow, tag, revision, builder, and run', () => {
    expect(verifyNpmReleaseProvenance({ audit: audit(), ...release })).toBe(true);
  });

  it.each([
    ['wrong subject digest', { subject: [{
      name: 'pkg:npm/%40ashlr/hub@3.2.0', digest: { sha512: 'cd'.repeat(64) },
    }] }],
    ['wrong statement type', { _type: 'https://in-toto.io/Statement/v0.1' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => verifyNpmReleaseProvenance({ audit: audit(overrides), ...release })).toThrow();
  });

  it.each([
    ['repository', { repository: 'https://github.com/attacker/fork' }],
    ['workflow path', { workflowPath: '.github/workflows/other.yml' }],
    ['tag ref', { ref: 'refs/tags/v3.2.0-forged' }],
    ['Git revision', { revision: '2'.repeat(40) }],
    ['workflow run', { runId: '31870000001' }],
    ['workflow run attempt', { runAttempt: '2' }],
  ])('rejects a coherently wrong %s identity', (_label, identityOverrides) => {
    expect(() => verifyNpmReleaseProvenance({
      audit: audit({}, identityOverrides),
      ...release,
    })).toThrow();
  });

  it('reads only a stable descriptor-bound audit snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-read-'));
    try {
      const auditPath = join(root, 'audit.json');
      writeFileSync(auditPath, '{"verified":[]}\n');
      expect(readBoundedJson(auditPath)).toEqual({ verified: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic and hard-linked audit inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-links-'));
    try {
      const source = join(root, 'source.json');
      const symbolic = join(root, 'symbolic.json');
      const hard = join(root, 'hard.json');
      writeFileSync(source, '{"verified":[]}\n');
      symlinkSync(source, symbolic);
      linkSync(source, hard);

      expect(() => readBoundedJson(symbolic)).toThrow();
      expect(() => readBoundedJson(hard)).toThrow(/single-link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a path swap after opening the audit descriptor', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-swap-'));
    try {
      const auditPath = join(root, 'audit.json');
      const replacement = join(root, 'replacement.json');
      const displaced = join(root, 'displaced.json');
      writeFileSync(auditPath, '{"verified":[]}\n');
      writeFileSync(replacement, '{"invalid":[]}\n');
      let swapped = false;
      const fs = {
        ...nodeFs,
        readSync(...args: Parameters<typeof nodeFs.readSync>) {
          if (!swapped) {
            swapped = true;
            renameSync(auditPath, displaced);
            renameSync(replacement, auditPath);
          }
          return nodeFs.readSync(...args);
        },
      };

      expect(() => readBoundedJson(auditPath, fs)).toThrow(/changed during read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects audit growth while reading', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-growth-'));
    try {
      const auditPath = join(root, 'audit.json');
      writeFileSync(auditPath, '{"verified":[]}\n');
      let grown = false;
      const fs = {
        ...nodeFs,
        readSync(...args: Parameters<typeof nodeFs.readSync>) {
          if (!grown) {
            grown = true;
            appendFileSync(auditPath, '{}');
          }
          return nodeFs.readSync(...args);
        },
      };

      expect(() => readBoundedJson(auditPath, fs)).toThrow(/grew during read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

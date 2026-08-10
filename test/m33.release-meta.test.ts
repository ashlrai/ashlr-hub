/**
 * M33 — distribution metadata: package.json publish shape, the exports map,
 * the release scripts (check-version / extract-changelog), and the release
 * workflow's gates. Pure filesystem reads + child-process runs of the
 * scripts; no network, no HOME mutation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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

    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), '0.0.1-nope'], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
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
  }
  interface ReleaseWorkflow {
    on?: { push?: { tags?: string[] } };
    jobs?: Record<string, WorkflowJob>;
  }
  const parsed = parseYaml(workflow) as ReleaseWorkflow;
  const jobs = parsed.jobs ?? {};
  const verifyJob = jobs['verify'] ?? {};
  const publishJob = jobs['publish'] ?? {};
  const releaseJob = jobs['release'] ?? {};
  const steps = (job: WorkflowJob): WorkflowStep[] => job.steps ?? [];
  const runText = (job: WorkflowJob): string => steps(job).map((step) => step.run ?? '').join('\n');
  const action = (job: WorkflowJob, prefix: string): WorkflowStep | undefined =>
    steps(job).find((step) => step.uses?.startsWith(prefix));

  it('is tag-triggered and reuses the exact native CI gate before publish', () => {
    expect(parsed.on?.push?.tags).toEqual(['v*']);
    expect(Object.keys(jobs)).toEqual(['verify', 'publish', 'release']);
    expect(verifyJob.uses).toBe('./.github/workflows/ci.yml');
    expect(ciWorkflow).toMatch(/(?:^|\n)\s{2}workflow_call:\s*(?:\n|$)/);
    expect(verifyJob['runs-on']).toBeUndefined();
    expect(verifyJob.steps).toBeUndefined();
    expect(verifyJob.environment).toBeUndefined();
    expect(publishJob.needs).toBe('verify');
    expect(releaseJob.needs).toBe('publish');
    expect(ciWorkflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ciWorkflow).not.toMatch(/^\s+environment:/m);
  });

  it('uses exact job-scoped trusted-publishing authority and pinned tooling', () => {
    expect(publishJob['runs-on']).toBe('ubuntu-latest');
    expect(publishJob.environment).toBe('npm-release');
    expect(publishJob.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(publishJob.outputs).toBeUndefined();
    const checkout = action(publishJob, 'actions/checkout@');
    expect(checkout?.uses).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 0,
      'persist-credentials': false,
      ref: '${{ github.ref }}',
    });
    const setupNode = action(publishJob, 'actions/setup-node@');
    expect(setupNode?.uses).toBe('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
    expect(setupNode?.with).toEqual({
      'node-version': '24',
      'registry-url': 'https://registry.npmjs.org',
      'package-manager-cache': false,
    });
    const publishRun = runText(publishJob);
    expect(publishRun).toContain('npm install --global npm@11.19.0');
    expect(publishRun).toContain('test "$(npm --version)" = "11.19.0"');
    expect(publishRun).toContain('scripts/check-version.mjs');
    expect(publishRun).toContain('scripts/extract-changelog.mjs');
    expect(publishRun).toContain('> "$RUNNER_TEMP/release-notes.md"');
    expect(publishRun).not.toMatch(/>\s*release-notes\.md/);
    expect(publishRun.match(/npm publish --provenance --access public/g)).toHaveLength(1);
    expect(steps(publishJob).at(-1)?.run?.trim()).toBe('npm publish --provenance --access public');

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
    const upload = action(publishJob, 'actions/upload-artifact@');
    expect(upload?.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(upload?.with).toEqual({
      name: 'npm-release-handoff-${{ github.run_id }}',
      path: '${{ runner.temp }}/release-notes.md',
      'if-no-files-found': 'error',
      'retention-days': 7,
      'compression-level': 9,
      overwrite: true,
      'include-hidden-files': false,
    });
    expect(runText(publishJob)).toContain('notes_bytes > 65536');

    expect(releaseJob['runs-on']).toBe('ubuntu-latest');
    expect(releaseJob.environment).toBeUndefined();
    expect(releaseJob.permissions).toEqual({ contents: 'write' });
    expect(releaseJob.env).toEqual({ GH_REPO: '${{ github.repository }}' });
    const download = action(releaseJob, 'actions/download-artifact@');
    expect(download?.uses).toBe('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
    expect(download?.with).toEqual({
      name: 'npm-release-handoff-${{ github.run_id }}',
      path: 'release-handoff',
      'digest-mismatch': 'error',
    });
    const releaseRun = runText(releaseJob);
    expect(releaseRun).toContain('entry_count');
    expect(releaseRun).toContain('notes_bytes');
    expect(releaseRun).toContain('gh release create "$tag" --verify-tag');
    expect(releaseRun).toContain("'.tagName == $tag and .name == $tag");
    expect(releaseRun).toContain("jq -rj '.body'");
    expect(releaseRun).not.toContain("--jq '.body'");
    expect(releaseRun).toContain('compare/${GITHUB_SHA}...${tag}');
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
    expect(releaseDocs).not.toContain('gh secret set NPM_TOKEN');
  });
});

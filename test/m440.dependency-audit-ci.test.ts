/**
 * M440 DEPENDENCY AUDIT CI -- parsed workflow authority contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflowText = readFileSync(
  resolve(repoRoot, '.github/workflows/dependency-audit.yml'),
  'utf8',
);
const dependabotText = readFileSync(resolve(repoRoot, '.github/dependabot.yml'), 'utf8');
const workflow = parse(workflowText) as Record<string, unknown>;
const dependabot = parse(dependabotText) as Record<string, unknown>;
const events = workflow.on as Record<string, Record<string, unknown> | null>;
const audit = (workflow.jobs as Record<string, Record<string, unknown>>).audit;
const steps = audit.steps as Array<Record<string, unknown>>;

const authorityPaths = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  'src/raycast/package.json',
  'src/raycast/package-lock.json',
  'src/raycast/npm-shrinkwrap.json',
  'src/raycast/.npmrc',
  '.github/dependabot.yml',
  '.github/workflows/dependency-audit.yml',
];

describe('M440 dependency audit CI', () => {
  it('matches the complete closed workflow authority document', () => {
    expect(workflow).toEqual({
      name: 'Dependency Audit',
      on: {
        push: { branches: ['master'], paths: authorityPaths },
        pull_request: { branches: ['**'] },
        schedule: [{ cron: '17 9 * * 1' }],
        workflow_dispatch: null,
      },
      permissions: { contents: 'read' },
      concurrency: {
        group: 'dependency-audit-${{ github.event.pull_request.number || github.ref }}',
        'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
      },
      jobs: {
        audit: {
          name: 'Dependency audit (root + Raycast)',
          'runs-on': 'ubuntu-latest',
          'timeout-minutes': 15,
          env: { NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' },
          steps: [
            {
              name: 'Checkout',
              uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
              with: {
                'persist-credentials': false,
                ref: '${{ github.event.pull_request.head.sha || github.sha }}',
              },
            },
            {
              name: 'Set up Node.js 22',
              uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
              with: { 'node-version': '22' },
            },
            {
              name: 'Verify root dependency graph installs',
              run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
            },
            {
              name: 'Verify Raycast dependency graph installs',
              'working-directory': 'src/raycast',
              run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
            },
            {
              name: 'Audit root dependencies',
              run: 'npm audit --package-lock-only --ignore-scripts --audit-level=low',
            },
            {
              name: 'Audit root production dependencies',
              run: 'npm audit --package-lock-only --ignore-scripts --omit=dev --audit-level=low',
            },
            {
              name: 'Audit Raycast dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --package-lock-only --ignore-scripts --audit-level=low',
            },
            {
              name: 'Audit Raycast production dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --package-lock-only --ignore-scripts --omit=dev --audit-level=low',
            },
          ],
        },
      },
    });
  });

  it('runs on every pull request exact head, dependency pushes, weekly drift, and manual dispatch', () => {
    expect(events.push).toEqual({ branches: ['master'], paths: authorityPaths });
    expect(events.pull_request).toEqual({ branches: ['**'] });
    expect(events.pull_request).not.toHaveProperty('paths');
    expect(events.pull_request).not.toHaveProperty('paths-ignore');
    expect(events.schedule).toEqual([{ cron: '17 9 * * 1' }]);
    expect(events.workflow_dispatch).toBeNull();
  });

  it('uses read-only authority, bounded concurrency, and a hard timeout', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({
      group: 'dependency-audit-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
    expect(audit['runs-on']).toBe('ubuntu-latest');
    expect(audit['timeout-minutes']).toBe(15);
    expect(audit.env).toEqual({ NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' });
    expect(audit.permissions).toBeUndefined();
  });

  it('uses only approved actions with bounded checkout authority', () => {
    expect(steps).toHaveLength(8);
    expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    ]);
    expect(steps[0]).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'persist-credentials': false,
        ref: '${{ github.event.pull_request.head.sha || github.sha }}',
      },
    });
    expect(steps[1]).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '22' },
    });
  });

  it('fail-closes on clean installs before auditing full and production lockfile graphs', () => {
    expect(steps.slice(2).map(({ run, ['working-directory']: cwd }) => ({ run, cwd }))).toEqual([
      {
        run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
        cwd: undefined,
      },
      {
        run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
        cwd: 'src/raycast',
      },
      {
        run: 'npm audit --package-lock-only --ignore-scripts --audit-level=low',
        cwd: undefined,
      },
      {
        run: 'npm audit --package-lock-only --ignore-scripts --omit=dev --audit-level=low',
        cwd: undefined,
      },
      {
        run: 'npm audit --package-lock-only --ignore-scripts --audit-level=low',
        cwd: 'src/raycast',
      },
      {
        run: 'npm audit --package-lock-only --ignore-scripts --omit=dev --audit-level=low',
        cwd: 'src/raycast',
      },
    ]);
    expect(steps.some((step) => step['continue-on-error'] === true)).toBe(false);
    const installIndexes = steps
      .map((step, index) => ({ index, run: String(step.run ?? '') }))
      .filter(({ run }) => run.startsWith('npm ci'))
      .map(({ index }) => index);
    const firstAuditIndex = steps.findIndex((step) => String(step.run ?? '').startsWith('npm audit'));
    expect(installIndexes).toEqual([2, 3]);
    expect(Math.max(...installIndexes)).toBeLessThan(firstAuditIndex);
    for (const index of installIndexes) {
      const command = String(steps[index]?.run ?? '');
      expect(command).toContain('--force=false');
      expect(command).toContain('--legacy-peer-deps=false');
      expect(command).toContain('--strict-peer-deps');
    }
    expect(steps[1]?.with).not.toHaveProperty('cache');
  });

  it('cannot publish, deploy, mutate settings, or consume secrets', () => {
    const runCommands = steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : []));
    expect(runCommands.join('\n')).not.toMatch(/\b(npm publish|deploy|release|dependabot)\b/i);
    expect(workflowText).not.toMatch(/secrets\.|contents: write|id-token: write/i);
    expect(workflow).not.toHaveProperty('on.pull_request_target');
  });

  it('covers both npm manifests with bounded grouped Dependabot updates', () => {
    const commonUpdate = {
      'package-ecosystem': 'npm',
      schedule: {
        interval: 'weekly',
        day: 'monday',
        time: '09:17',
        timezone: 'America/New_York',
      },
      'open-pull-requests-limit': 5,
      groups: {
        'production-dependencies': { 'dependency-type': 'production' },
        'development-dependencies': { 'dependency-type': 'development' },
      },
    };

    expect(dependabot).toEqual({
      version: 2,
      updates: [
        { ...commonUpdate, directory: '/' },
        { ...commonUpdate, directory: '/src/raycast' },
      ],
    });
    expect(dependabotText).not.toMatch(/password|token|secret|credential/i);
    expect(dependabotText).not.toMatch(/registries:|insecure-external-code-execution/i);
  });
});

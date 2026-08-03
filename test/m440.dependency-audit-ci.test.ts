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
          steps: [
            {
              name: 'Checkout',
              uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
              with: {
                'persist-credentials': false,
                ref: '${{ github.event.pull_request.head.sha || github.sha }}',
              },
            },
            {
              name: 'Set up Node.js 22',
              uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
              with: {
                'node-version': '22',
                cache: 'npm',
                'cache-dependency-path': 'package-lock.json\nsrc/raycast/package-lock.json\n',
              },
            },
            { name: 'Install root dependencies', run: 'npm ci --ignore-scripts --no-audit' },
            { name: 'Audit root dependencies', run: 'npm audit --audit-level=high' },
            {
              name: 'Audit root production dependencies',
              run: 'npm audit --omit=dev --audit-level=high',
            },
            {
              name: 'Install Raycast dependencies',
              'working-directory': 'src/raycast',
              run: 'npm ci --ignore-scripts --no-audit',
            },
            {
              name: 'Audit Raycast dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --audit-level=high',
            },
            {
              name: 'Audit Raycast production dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --omit=dev --audit-level=high',
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
    expect(audit.permissions).toBeUndefined();
  });

  it('uses only approved actions with bounded checkout authority', () => {
    expect(steps).toHaveLength(8);
    expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
      'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    ]);
    expect(steps[0]).toMatchObject({
      uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      with: {
        'persist-credentials': false,
        ref: '${{ github.event.pull_request.head.sha || github.sha }}',
      },
    });
    expect(steps[1]).toMatchObject({
      uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      with: {
        'node-version': '22',
        cache: 'npm',
        'cache-dependency-path': 'package-lock.json\nsrc/raycast/package-lock.json\n',
      },
    });
  });

  it('reproducibly installs and audits full and production dependency graphs', () => {
    expect(steps.slice(2).map(({ run, ['working-directory']: cwd }) => ({ run, cwd }))).toEqual([
      { run: 'npm ci --ignore-scripts --no-audit', cwd: undefined },
      { run: 'npm audit --audit-level=high', cwd: undefined },
      { run: 'npm audit --omit=dev --audit-level=high', cwd: undefined },
      { run: 'npm ci --ignore-scripts --no-audit', cwd: 'src/raycast' },
      { run: 'npm audit --audit-level=high', cwd: 'src/raycast' },
      { run: 'npm audit --omit=dev --audit-level=high', cwd: 'src/raycast' },
    ]);
    expect(steps.some((step) => step['continue-on-error'] === true)).toBe(false);
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
      labels: ['dependencies'],
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

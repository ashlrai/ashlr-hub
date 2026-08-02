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
const workflow = parse(workflowText) as Record<string, unknown>;
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
  '.github/workflows/dependency-audit.yml',
];

describe('M440 dependency audit CI', () => {
  it('matches the complete closed workflow authority document', () => {
    expect(workflow).toEqual({
      name: 'Dependency Audit',
      on: {
        push: { branches: ['master'], paths: authorityPaths },
        pull_request: { branches: ['**'], paths: authorityPaths },
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
              with: { 'persist-credentials': false },
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
            { name: 'Audit root dependencies', run: 'npm audit --audit-level=low' },
            {
              name: 'Audit root production dependencies',
              run: 'npm audit --omit=dev --audit-level=low',
            },
            {
              name: 'Install Raycast dependencies',
              'working-directory': 'src/raycast',
              run: 'npm ci --ignore-scripts --no-audit',
            },
            {
              name: 'Audit Raycast dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --audit-level=low',
            },
            {
              name: 'Audit Raycast production dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --omit=dev --audit-level=low',
            },
          ],
        },
      },
    });
  });

  it('runs for dependency authority changes, weekly drift checks, and manual dispatch', () => {
    expect(events.push).toEqual({ branches: ['master'], paths: authorityPaths });
    expect(events.pull_request).toEqual({ branches: ['**'], paths: authorityPaths });
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
      with: { 'persist-credentials': false },
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
      { run: 'npm audit --audit-level=low', cwd: undefined },
      { run: 'npm audit --omit=dev --audit-level=low', cwd: undefined },
      { run: 'npm ci --ignore-scripts --no-audit', cwd: 'src/raycast' },
      { run: 'npm audit --audit-level=low', cwd: 'src/raycast' },
      { run: 'npm audit --omit=dev --audit-level=low', cwd: 'src/raycast' },
    ]);
    expect(steps.some((step) => step['continue-on-error'] === true)).toBe(false);
  });

  it('cannot publish, deploy, mutate settings, or consume secrets', () => {
    expect(workflowText).not.toMatch(/\b(npm publish|deploy|release|dependabot)\b/i);
    expect(workflowText).not.toMatch(/secrets\.|contents: write|id-token: write/i);
  });
});

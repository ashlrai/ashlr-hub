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
const dependencySecurityPolicy = readFileSync(
  resolve(repoRoot, 'docs/DEPENDENCY-SECURITY.md'),
  'utf8',
);
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
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  'docs/DEPENDENCY-SECURITY.md',
  '.github/dependabot.yml',
  '.github/workflows/dependency-audit.yml',
];

const npmInstallCommand = `npm install --global "npm@\${NPM_VERSION}" --ignore-scripts --no-audit --no-fund
test "$(npm --version)" = "\${NPM_VERSION}"
`;

const cargoAuditInstallCommand = `set -euo pipefail
archive="\${RUNNER_TEMP}/cargo-audit.tgz"
extract_dir="\${RUNNER_TEMP}/cargo-audit-extract"
bin_dir="\${RUNNER_TEMP}/cargo-audit-bin"
url="https://github.com/rustsec/rustsec/releases/download/cargo-audit/v\${CARGO_AUDIT_VERSION}/cargo-audit-\${CARGO_AUDIT_TARGET}-v\${CARGO_AUDIT_VERSION}.tgz"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \\
  --retry 3 --retry-all-errors --output "\${archive}" "\${url}"
echo "\${CARGO_AUDIT_SHA256}  \${archive}" | sha256sum --check --strict
mkdir --parents "\${extract_dir}" "\${bin_dir}"
tar --extract --gzip --file "\${archive}" --directory "\${extract_dir}" \\
  --strip-components=1
install --mode 0755 "\${extract_dir}/cargo-audit" "\${bin_dir}/cargo-audit"
echo "\${bin_dir}" >> "\${GITHUB_PATH}"
"\${bin_dir}/cargo-audit" --version
`;

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
          'timeout-minutes': 20,
          env: {
            NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
            NPM_VERSION: '11.6.0',
            CARGO_AUDIT_VERSION: '0.22.2',
            CARGO_AUDIT_TARGET: 'x86_64-unknown-linux-gnu',
            CARGO_AUDIT_SHA256:
              'ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39',
          },
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
              name: 'Install pinned npm',
              run: npmInstallCommand,
            },
            {
              name: 'Install pinned cargo-audit',
              shell: 'bash',
              run: cargoAuditInstallCommand,
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
              run: 'npm audit --ignore-scripts --audit-level=low',
            },
            {
              name: 'Audit root production dependencies',
              run: 'npm audit --ignore-scripts --omit=dev --audit-level=low',
            },
            {
              name: 'Audit Raycast dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --ignore-scripts --audit-level=low',
            },
            {
              name: 'Audit Raycast production dependencies',
              'working-directory': 'src/raycast',
              run: 'npm audit --ignore-scripts --omit=dev --audit-level=low',
            },
            {
              name: 'Audit desktop Cargo dependencies',
              run: 'cargo-audit audit --file desktop/src-tauri/Cargo.lock --ignore RUSTSEC-2024-0429',
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
    expect(audit['timeout-minutes']).toBe(20);
    expect(audit.env).toEqual({
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
      NPM_VERSION: '11.6.0',
      CARGO_AUDIT_VERSION: '0.22.2',
      CARGO_AUDIT_TARGET: 'x86_64-unknown-linux-gnu',
      CARGO_AUDIT_SHA256:
        'ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39',
    });
    expect(audit.permissions).toBeUndefined();
  });

  it('preserves the exact protected required-check context while extending its audit', () => {
    expect(Object.keys(workflow.jobs as Record<string, unknown>)).toEqual(['audit']);
    expect(audit.name).toBe('Dependency audit (root + Raycast)');
  });

  it('uses only approved actions with bounded checkout authority', () => {
    expect(steps).toHaveLength(11);
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

  it('pins npm and fail-closes on clean installs before auditing their full and production graphs', () => {
    expect(steps[2]).toEqual({
      name: 'Install pinned npm',
      run: npmInstallCommand,
    });
    expect(steps.slice(4, 10).map(({ run, ['working-directory']: cwd }) => ({ run, cwd }))).toEqual([
      {
        run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
        cwd: undefined,
      },
      {
        run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
        cwd: 'src/raycast',
      },
      {
        run: 'npm audit --ignore-scripts --audit-level=low',
        cwd: undefined,
      },
      {
        run: 'npm audit --ignore-scripts --omit=dev --audit-level=low',
        cwd: undefined,
      },
      {
        run: 'npm audit --ignore-scripts --audit-level=low',
        cwd: 'src/raycast',
      },
      {
        run: 'npm audit --ignore-scripts --omit=dev --audit-level=low',
        cwd: 'src/raycast',
      },
    ]);
    expect(steps.some((step) => step['continue-on-error'] === true)).toBe(false);
    const installIndexes = steps
      .map((step, index) => ({ index, run: String(step.run ?? '') }))
      .filter(({ run }) => run.startsWith('npm ci'))
      .map(({ index }) => index);
    const firstAuditIndex = steps.findIndex((step) => String(step.run ?? '').startsWith('npm audit'));
    expect(installIndexes).toEqual([4, 5]);
    expect(Math.max(...installIndexes)).toBeLessThan(firstAuditIndex);
    for (const index of installIndexes) {
      const command = String(steps[index]?.run ?? '');
      expect(command).toContain('--force=false');
      expect(command).toContain('--legacy-peer-deps=false');
      expect(command).toContain('--strict-peer-deps');
    }
    expect(steps[1]?.with).not.toHaveProperty('cache');
  });

  it('pins RustSec tooling and fails on every vulnerability except the open GLib quarantine', () => {
    expect(steps[3]).toEqual({
      name: 'Install pinned cargo-audit',
      shell: 'bash',
      run: cargoAuditInstallCommand,
    });
    expect(cargoAuditInstallCommand).toContain('--proto \'=https\' --tlsv1.2');
    expect(cargoAuditInstallCommand).toContain('sha256sum --check --strict');
    expect(cargoAuditInstallCommand).not.toMatch(/cargo install|latest|stable/);

    expect(steps[10]).toEqual({
      name: 'Audit desktop Cargo dependencies',
      run: 'cargo-audit audit --file desktop/src-tauri/Cargo.lock --ignore RUSTSEC-2024-0429',
    });
    expect(String(steps[10]?.run).match(/--ignore\s+RUSTSEC-/g)).toHaveLength(1);
    expect(String(steps[10]?.run)).not.toMatch(/continue|allow|deny warnings/i);
    expect(steps.some((step) => step['continue-on-error'] === true)).toBe(false);
  });

  it('cannot publish, deploy, mutate settings, or consume secrets', () => {
    const runCommands = steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : []));
    expect(runCommands.join('\n')).not.toMatch(/\b(npm publish|deploy|release|dependabot)\b/i);
    expect(workflowText).not.toMatch(/secrets\.|contents: write|id-token: write/i);
    expect(workflow).not.toHaveProperty('on.pull_request_target');
  });

  it('covers both npm manifests and desktop Cargo with bounded reviewed cooldowns', () => {
    const cooldown = {
      'default-days': 5,
      'semver-major-days': 30,
      'semver-minor-days': 7,
      'semver-patch-days': 3,
    };
    const commonUpdate = {
      'package-ecosystem': 'npm',
      schedule: {
        interval: 'weekly',
        day: 'monday',
        time: '09:17',
        timezone: 'America/New_York',
      },
      'open-pull-requests-limit': 5,
      cooldown,
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
        {
          'package-ecosystem': 'cargo',
          directory: '/desktop/src-tauri',
          schedule: {
            interval: 'weekly',
            day: 'monday',
            time: '09:17',
            timezone: 'America/New_York',
          },
          'open-pull-requests-limit': 3,
          cooldown,
        },
      ],
    });
    expect(dependabotText).not.toMatch(/password|token|secret|credential/i);
    expect(dependabotText).not.toMatch(/registries:|insecure-external-code-execution/i);
    expect(dependabotText).not.toMatch(/^\s+(?:ignore|exclude):/m);
    expect(dependencySecurityPolicy).toContain(
      'GitHub applies `cooldown` only to version updates',
    );
    expect(dependencySecurityPolicy).toMatch(
      /Security advisories need no override because they already bypass\s+the cooldown\./,
    );
    expect(dependencySecurityPolicy).toMatch(/Wildcard exclusions are\s+not permitted\./);
  });
});

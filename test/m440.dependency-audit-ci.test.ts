/**
 * M440 DEPENDENCY AUDIT CI -- parsed workflow authority contract.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
const npmAuditFallbackText = readFileSync(
  resolve(repoRoot, 'scripts/npm-audit-with-osv-fallback.sh'),
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
  'scripts/npm-audit-with-osv-fallback.sh',
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  'docs/DEPENDENCY-SECURITY.md',
  '.github/dependabot.yml',
  '.github/workflows/dependency-audit.yml',
];

const npmInstallCommand = `npm install --global "npm@\${NPM_VERSION}" --ignore-scripts --no-audit --no-fund
test "$(npm --version)" = "\${NPM_VERSION}"
`;

const osvScannerInstallCommand = `set -euo pipefail
binary="\${RUNNER_TEMP}/osv-scanner-download"
bin_dir="\${RUNNER_TEMP}/osv-scanner-bin"
url="https://github.com/google/osv-scanner/releases/download/v\${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \\
  --retry 3 --retry-all-errors --output "\${binary}" "\${url}"
echo "\${OSV_SCANNER_SHA256}  \${binary}" | sha256sum --check --strict
mkdir --parents "\${bin_dir}"
install --mode 0755 "\${binary}" "\${bin_dir}/osv-scanner"
echo "\${bin_dir}" >> "\${GITHUB_PATH}"
"\${bin_dir}/osv-scanner" --version
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
            OSV_SCANNER_VERSION: '2.5.1',
            OSV_SCANNER_SHA256:
              'f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be',
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
              name: 'Install pinned OSV-Scanner',
              shell: 'bash',
              run: osvScannerInstallCommand,
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
              run: 'bash scripts/npm-audit-with-osv-fallback.sh "root full graph" package-lock.json',
            },
            {
              name: 'Audit root production dependencies',
              run: 'bash scripts/npm-audit-with-osv-fallback.sh "root production graph" package-lock.json --omit=dev',
            },
            {
              name: 'Audit Raycast dependencies',
              'working-directory': 'src/raycast',
              run: 'bash ../../scripts/npm-audit-with-osv-fallback.sh "Raycast full graph" package-lock.json',
            },
            {
              name: 'Audit Raycast production dependencies',
              'working-directory': 'src/raycast',
              run: 'bash ../../scripts/npm-audit-with-osv-fallback.sh "Raycast production graph" package-lock.json --omit=dev',
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
      OSV_SCANNER_VERSION: '2.5.1',
      OSV_SCANNER_SHA256:
        'f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be',
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
    expect(steps).toHaveLength(12);
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

  it('pins npm and fail-closes on clean installs before auditing complete lockfile graphs', () => {
    expect(steps[2]).toEqual({
      name: 'Install pinned npm',
      run: npmInstallCommand,
    });
    expect(steps[3]).toEqual({
      name: 'Install pinned OSV-Scanner',
      shell: 'bash',
      run: osvScannerInstallCommand,
    });
    expect(steps.slice(5, 11).map(({ run, ['working-directory']: cwd }) => ({ run, cwd }))).toEqual([
      {
        run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
        cwd: undefined,
      },
      {
        run: 'npm ci --ignore-scripts --no-audit --no-fund --force=false --legacy-peer-deps=false --strict-peer-deps',
        cwd: 'src/raycast',
      },
      {
        run: 'bash scripts/npm-audit-with-osv-fallback.sh "root full graph" package-lock.json',
        cwd: undefined,
      },
      {
        run: 'bash scripts/npm-audit-with-osv-fallback.sh "root production graph" package-lock.json --omit=dev',
        cwd: undefined,
      },
      {
        run: 'bash ../../scripts/npm-audit-with-osv-fallback.sh "Raycast full graph" package-lock.json',
        cwd: 'src/raycast',
      },
      {
        run: 'bash ../../scripts/npm-audit-with-osv-fallback.sh "Raycast production graph" package-lock.json --omit=dev',
        cwd: 'src/raycast',
      },
    ]);
    expect(steps.some((step) => step['continue-on-error'] === true)).toBe(false);
    const installIndexes = steps
      .map((step, index) => ({ index, run: String(step.run ?? '') }))
      .filter(({ run }) => run.startsWith('npm ci'))
      .map(({ index }) => index);
    const firstAuditIndex = steps.findIndex((step) =>
      String(step.run ?? '').includes('npm-audit-with-osv-fallback.sh'),
    );
    expect(installIndexes).toEqual([5, 6]);
    expect(Math.max(...installIndexes)).toBeLessThan(firstAuditIndex);
    for (const index of installIndexes) {
      const command = String(steps[index]?.run ?? '');
      expect(command).toContain('--force=false');
      expect(command).toContain('--legacy-peer-deps=false');
      expect(command).toContain('--strict-peer-deps');
    }
    expect(steps[1]?.with).not.toHaveProperty('cache');
    expect(osvScannerInstallCommand).toContain('--proto \'=https\' --tlsv1.2');
    expect(osvScannerInstallCommand).toContain('sha256sum --check --strict');
    expect(npmAuditFallbackText).toContain('for attempt in 1 2 3');
    expect(npmAuditFallbackText).toContain('--fetch-retries=0 --fetch-timeout=30000');
    expect(npmAuditFallbackText).toContain('"${npm_bin}" "${npm_args[@]}"');
    expect(npmAuditFallbackText).toContain('if is_valid_npm_report "${stdout_file}"; then');
    expect(npmAuditFallbackText).toContain('if ! is_clean_npm_report "${stdout_file}"; then');
    expect(npmAuditFallbackText).toContain('fallback was not authorized');
    expect(npmAuditFallbackText).toContain(
      'audit_tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ashlr-npm-audit.XXXXXX")',
    );
    expect(npmAuditFallbackText).toContain(': > "${osv_config}"');
    expect(npmAuditFallbackText).toContain('chmod 0600 "${osv_config}"');
    expect(npmAuditFallbackText).toContain(
      '"${osv_bin}" scan source --config "${osv_config}" --lockfile "${lockfile}"',
    );
    expect(npmAuditFallbackText).toContain('no provider returned a clean result');
    expect(npmAuditFallbackText).toContain('GITHUB_STEP_SUMMARY');
    expect(npmAuditFallbackText).not.toMatch(
      /\|\|\s*true|continue-on-error|--allow-no-lockfiles/,
    );
  });

  it('fail-closes inconsistent npm success and isolates OSV from repository ignore policy', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ashlr-m440-audit-'));
    try {
      const binDir = resolve(fixtureRoot, 'bin');
      const lockfile = resolve(fixtureRoot, 'package-lock.json');
      const countFile = resolve(fixtureRoot, 'npm-count');
      const markerFile = resolve(fixtureRoot, 'osv-called');
      const summaryFile = resolve(fixtureRoot, 'summary.md');
      const repositoryConfig = resolve(fixtureRoot, 'osv-scanner.toml');
      const script = resolve(repoRoot, 'scripts/npm-audit-with-osv-fallback.sh');
      writeFileSync(lockfile, '{}\n');
      writeFileSync(countFile, '0\n');
      writeFileSync(
        repositoryConfig,
        '[[PackageOverrides]]\nname = ".*"\nnameIsRegex = true\nignore = true\n',
      );
      mkdirSync(binDir);

      const writeExecutable = (name: string, content: string) => {
        const file = resolve(binDir, name);
        writeFileSync(file, content);
        chmodSync(file, 0o755);
      };
      writeExecutable(
        'timeout',
        '#!/usr/bin/env bash\nshift 3\nexec "$@"\n',
      );
      writeExecutable('sleep', '#!/usr/bin/env bash\nexit 0\n');
      writeExecutable(
        'npm',
        `#!/usr/bin/env bash
count=$(cat "$TEST_COUNT_FILE")
count=$((count + 1))
printf '%s\n' "$count" > "$TEST_COUNT_FILE"
case "$TEST_MODE" in
  success)
    printf '%s\n' '{"auditReportVersion":2,"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}}'
    exit 0
    ;;
  vulnerability)
    printf '%s\n' '{"auditReportVersion":2,"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":1,"critical":0,"total":1}}}'
    exit 1
    ;;
  false-clean)
    printf '%s\n' '{"auditReportVersion":2,"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":1,"critical":0,"total":1}}}'
    exit 0
    ;;
  transport)
    printf '%s\n' '{"message":"network timeout","error":{"summary":"","detail":""}}'
    echo 'npm error audit endpoint returned an error: network timeout' >&2
    exit 1
    ;;
  *)
    echo 'npm failed for an invalid package tree' >&2
    exit 2
    ;;
esac
`,
      );
      writeExecutable(
        'osv-scanner',
        `#!/usr/bin/env bash
config_path=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '--config' ]]; then
    shift
    config_path="\${1:-}"
    break
  fi
  shift
done
[[ -n "$config_path" ]]
[[ "$config_path" != "$TEST_REPO_CONFIG" ]]
[[ -f "$config_path" && ! -s "$config_path" ]]
permissions=$(stat -f '%Lp' "$config_path" 2>/dev/null || stat -c '%a' "$config_path")
[[ "$permissions" == '600' ]]
printf '%s\n' "$config_path" > "$TEST_OSV_MARKER"
exit "\${TEST_OSV_RC:-0}"
`,
      );

      const runScenario = (mode: string, osvRc = '0') => {
        writeFileSync(countFile, '0\n');
        writeFileSync(summaryFile, '');
        rmSync(markerFile, { force: true });
        const result = spawnSync('bash', [script, 'fixture graph', lockfile], {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            TEST_COUNT_FILE: countFile,
            TEST_OSV_MARKER: markerFile,
            TEST_REPO_CONFIG: repositoryConfig,
            TEST_OSV_RC: osvRc,
            TEST_MODE: mode,
            GITHUB_STEP_SUMMARY: summaryFile,
          },
        });
        return {
          ...result,
          count: Number(readFileSync(countFile, 'utf8').trim()),
          fallbackCalled: existsSync(markerFile),
          summary: readFileSync(summaryFile, 'utf8'),
        };
      };

      const success = runScenario('success');
      expect(success.status).toBe(0);
      expect(success.count).toBe(1);
      expect(success.fallbackCalled).toBe(false);
      expect(success.summary).toContain('primary npm audit passed with a valid audit v2 report');

      const vulnerability = runScenario('vulnerability');
      expect(vulnerability.status).toBe(1);
      expect(vulnerability.count).toBe(1);
      expect(vulnerability.fallbackCalled).toBe(false);
      expect(vulnerability.summary).toContain('primary npm audit reported vulnerabilities');

      const falseClean = runScenario('false-clean');
      expect(falseClean.status).toBe(1);
      expect(falseClean.count).toBe(1);
      expect(falseClean.fallbackCalled).toBe(false);
      expect(falseClean.summary).toContain(
        'npm returned success with nonzero vulnerability counts',
      );

      const nonTransport = runScenario('non-transport');
      expect(nonTransport.status).toBe(2);
      expect(nonTransport.count).toBe(1);
      expect(nonTransport.fallbackCalled).toBe(false);
      expect(nonTransport.summary).toContain('fallback was not authorized');

      const transport = runScenario('transport');
      expect(transport.status).toBe(0);
      expect(transport.count).toBe(3);
      expect(transport.fallbackCalled).toBe(true);
      expect(readFileSync(markerFile, 'utf8').trim()).not.toBe(repositoryConfig);
      expect(transport.summary).toContain('npm transport failed after 3 bounded attempts');
      expect(transport.summary).toContain('pinned OSV-Scanner fallback passed');

      const unavailable = runScenario('transport', '7');
      expect(unavailable.status).toBe(7);
      expect(unavailable.count).toBe(3);
      expect(unavailable.fallbackCalled).toBe(true);
      expect(unavailable.summary).toContain('no provider returned a clean result');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('pins RustSec tooling and fails on every vulnerability except the open GLib quarantine', () => {
    expect(steps[4]).toEqual({
      name: 'Install pinned cargo-audit',
      shell: 'bash',
      run: cargoAuditInstallCommand,
    });
    expect(cargoAuditInstallCommand).toContain('--proto \'=https\' --tlsv1.2');
    expect(cargoAuditInstallCommand).toContain('sha256sum --check --strict');
    expect(cargoAuditInstallCommand).not.toMatch(/cargo install|latest|stable/);

    expect(steps[11]).toEqual({
      name: 'Audit desktop Cargo dependencies',
      run: 'cargo-audit audit --file desktop/src-tauri/Cargo.lock --ignore RUSTSEC-2024-0429',
    });
    expect(String(steps[11]?.run).match(/--ignore\s+RUSTSEC-/g)).toHaveLength(1);
    expect(String(steps[11]?.run)).not.toMatch(/continue|allow|deny warnings/i);
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

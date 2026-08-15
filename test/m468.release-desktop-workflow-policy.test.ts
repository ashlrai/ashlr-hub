/**
 * M468 - desktop release workflow supply-chain policy.
 *
 * Pure filesystem assertions: no network, credentials, release, or workflow
 * execution. These checks keep every downloaded action immutable and keep the
 * release job's GitHub token at the minimum authority its upload step needs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(
  join(REPO_ROOT, '.github/workflows/release-desktop.yml'),
  'utf8',
);
const buildScript = readFileSync(join(REPO_ROOT, 'desktop/src-tauri/build.rs'), 'utf8');
const cargoManifest = readFileSync(join(REPO_ROOT, 'desktop/src-tauri/Cargo.toml'), 'utf8');
const tauriConfig = JSON.parse(
  readFileSync(join(REPO_ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8'),
) as { build?: { beforeBundleCommand?: string }; bundle?: { active?: boolean } };
const linuxTauriConfig = JSON.parse(
  readFileSync(join(REPO_ROOT, 'desktop/src-tauri/tauri.linux.conf.json'), 'utf8'),
) as { bundle?: { active?: boolean } };
const bundlePolicyPath = join(REPO_ROOT, 'desktop/scripts/assert-desktop-bundle-policy.mjs');
const bundlePolicy = readFileSync(bundlePolicyPath, 'utf8');
const desktopPackage = JSON.parse(
  readFileSync(join(REPO_ROOT, 'desktop/package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const desktopReadme = readFileSync(join(REPO_ROOT, 'desktop/README.md'), 'utf8');
const quickstart = readFileSync(join(REPO_ROOT, 'docs/QUICKSTART.md'), 'utf8');
const desktopPointer = readFileSync(join(REPO_ROOT, 'DESKTOP.md'), 'utf8');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface DesktopMatrixRow {
  os: string;
  rust_targets: string;
  tauri_args: string;
  artifact_label: string;
}

interface BuildJob {
  permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix?: { include?: DesktopMatrixRow[] } };
  steps?: WorkflowStep[];
}

interface ReleaseWorkflow {
  on?: {
    push?: { tags?: string[]; branches?: string[] };
    workflow_dispatch?: unknown;
  };
  jobs?: Record<string, BuildJob>;
}

const parsedWorkflow = parse(workflow) as ReleaseWorkflow;
const releaseTriggers = parsedWorkflow.on ?? {};
const buildJob = parsedWorkflow.jobs?.build ?? {};
const buildMatrix = buildJob.strategy?.matrix?.include ?? [];
const buildSteps = buildJob.steps ?? [];

const actionRefs = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
  (match) => match[1]!,
);

describe('M468 desktop release workflow supply-chain policy', () => {
  it('pins every third-party action to a full immutable commit', () => {
    expect(actionRefs).toHaveLength(6);
    for (const ref of actionRefs) {
      expect(ref, `mutable action ref: ${ref}`).toMatch(
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i,
      );
    }

    expect(actionRefs).toEqual([
      'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4',
      'actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809',
      'tauri-apps/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5',
    ]);
  });

  it('pins every downloaded tool and avoids floating package acquisition', () => {
    expect(workflow).toMatch(/^ {2}RUST_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toMatch(/^ {2}NODE_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toMatch(/^ {2}BUN_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toMatch(/^ {2}TAURI_CLI_VERSION: "\d+\.\d+\.\d+"$/m);
    expect(workflow).toContain('run: npm ci');
    expect(workflow).toContain(
      'npm install --global @tauri-apps/cli@${{ env.TAURI_CLI_VERSION }}',
    );
    expect(workflow).toContain('tauriScript: tauri');
    expect(workflow).not.toMatch(/bun-version:\s*latest/);
    expect(workflow).not.toMatch(/RUST_VERSION:\s*["']?stable/);
    expect(workflow).not.toMatch(/bunx\s+@tauri-apps\/cli@/);
    expect(workflow).not.toMatch(/@tauri-apps\/cli@[~^*]/);
    expect(workflow).not.toContain('bun install');
  });

  it('limits token authority and does not persist checkout credentials', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toMatch(
      /^ {4}permissions:\n {6}contents: write\s+# create the draft release and upload assets$/m,
    );
    expect(workflow).not.toMatch(/^\s+(?:id-token|actions|checks|deployments|packages):\s*write/m);
    expect(workflow).toContain('persist-credentials: false');
  });

  it('blocks every Linux desktop Cargo path before Tauri build logic without an override', () => {
    const guardIndex = buildScript.indexOf('CARGO_CFG_TARGET_OS');
    const panicIndex = buildScript.indexOf('panic!');
    const tauriBuildIndex = buildScript.indexOf('tauri_build::build()');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(buildScript).toContain(
      'std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")',
    );
    expect(buildScript).toContain('RUSTSEC-2024-0429');
    expect(buildScript).toContain('GHSA-wrw7-89jp-8q8g');
    expect(buildScript).toContain('glib 0.18.5');
    expect(buildScript.match(/std::env::var\(/g)).toHaveLength(1);
    expect(buildScript).not.toMatch(/option_env!|var_os|ALLOW|BYPASS|OVERRIDE/);
    expect(panicIndex).toBeGreaterThan(guardIndex);
    expect(tauriBuildIndex).toBeGreaterThan(panicIndex);

    expect(desktopPackage.scripts['dev']).toBe('cargo tauri dev');
    expect(desktopPackage.scripts['build']).toBe('cargo tauri build');
    expect(desktopPackage.scripts['build:debug']).toBe('cargo tauri build --debug');
  });

  it('binds Cargo to the guard and fails closed across default Tauri bundle paths', () => {
    const packageSection = cargoManifest.match(/^\[package\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? '';
    expect(packageSection.match(/^build\s*=\s*"build\.rs"$/gm)).toHaveLength(1);
    expect(packageSection).not.toMatch(/^links\s*=/m);

    expect(tauriConfig.build?.beforeBundleCommand).toBe(
      'node scripts/assert-desktop-bundle-policy.mjs',
    );
    expect(tauriConfig.bundle?.active).toBe(true);
    expect(linuxTauriConfig.bundle?.active).toBe(false);

    expect(bundlePolicy).toContain("process.platform === 'linux'");
    expect(bundlePolicy).toContain("process.env.TAURI_ENV_PLATFORM === 'linux'");
    expect(bundlePolicy).toContain('ASHLR_LINUX_DESKTOP_BUNDLE_QUARANTINED');
    expect(bundlePolicy).toContain('process.exitCode = 1');
    expect(bundlePolicy.match(/process\.env\./g)).toHaveLength(1);
    expect(bundlePolicy).not.toMatch(/ALLOW|BYPASS|OVERRIDE/);

    const hostPolicyEnv = { ...process.env };
    delete hostPolicyEnv.TAURI_ENV_PLATFORM;
    const hostPolicy = spawnSync(process.execPath, [bundlePolicyPath], {
      encoding: 'utf8',
      env: hostPolicyEnv,
      timeout: 5_000,
    });
    if (process.platform === 'linux') {
      expect(hostPolicy.status).toBe(1);
      expect(hostPolicy.stderr).toContain('ASHLR_LINUX_DESKTOP_BUNDLE_QUARANTINED');
    } else {
      expect(hostPolicy.status).toBe(0);
      expect(hostPolicy.stderr).toBe('');
    }

    const linuxTargetPolicy = spawnSync(process.execPath, [bundlePolicyPath], {
      encoding: 'utf8',
      env: { ...process.env, TAURI_ENV_PLATFORM: 'linux' },
      timeout: 5_000,
    });
    expect(linuxTargetPolicy.status).toBe(1);
    expect(linuxTargetPolicy.stderr).toContain('ASHLR_LINUX_DESKTOP_BUNDLE_QUARANTINED');
  });

  it('publishes only independently admitted macOS and Windows matrix artifacts', () => {
    expect(releaseTriggers).toEqual({ push: { tags: ['desktop-v*'] } });
    expect(releaseTriggers.push?.branches).toBeUndefined();
    expect(releaseTriggers.workflow_dispatch).toBeUndefined();
    expect(workflow).not.toContain('workflow_dispatch:');
    expect(workflow).not.toContain('inputs.tag');
    expect(workflow).toContain('tagName: ${{ github.ref_name }}');
    expect(workflow).toContain('releaseName: "Ashlr Desktop ${{ github.ref_name }}"');
    expect(workflow).not.toContain('github.ref_name ||');
    expect(workflow).toContain('workflow 301689703 must remain externally');
    expect(workflow).toContain('disabled_manually');
    expect(workflow).toContain('Tag protection for `refs/tags/desktop-v*` is necessary but not sufficient');
    expect(workflow).toContain('historical commit whose workflow predates');
    expect(buildJob.strategy?.['fail-fast']).toBe(false);
    expect(Object.keys(parsedWorkflow.jobs ?? {})).toEqual(['build']);
    expect(buildMatrix).toEqual([
      {
        os: 'macos-latest',
        rust_targets: '',
        tauri_args: '',
        artifact_label: 'macos',
      },
      {
        os: 'windows-latest',
        rust_targets: '',
        tauri_args: '',
        artifact_label: 'windows',
      },
    ]);
    expect(workflow).toContain('projectPath: desktop');
    expect(workflow).toContain('releaseDraft: true');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).not.toMatch(/ubuntu-latest|APPIMAGE_EXTRACT_AND_RUN|--bundles deb/);
    expect(workflow).not.toMatch(/apt-get|libwebkit2gtk|libgtk-3-dev|\.AppImage|`\.deb`/);

    const releaseStep = buildSteps.find((step) => step.uses?.startsWith('tauri-apps/tauri-action@'));
    const releaseBody = String(releaseStep?.with?.['releaseBody'] ?? '');
    expect(releaseBody).toContain('| Linux | Not published |');
    expect(releaseBody).toContain('GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429');
    expect(releaseBody).not.toMatch(/\.AppImage|\.deb/);
  });

  it('documents the exact quarantine and deliberate re-enable criteria', () => {
    for (const doc of [desktopReadme, quickstart, desktopPointer]) {
      expect(doc).toContain('GHSA-wrw7-89jp-8q8g');
      expect(doc).toContain('RUSTSEC-2024-0429');
      expect(doc).toMatch(/Linux/i);
      expect(doc).toMatch(/quarantin/i);
    }

    expect(desktopReadme).toContain('Linux | Not produced while quarantined');
    expect(desktopReadme).not.toContain('Linux | `.deb`');
    expect(desktopReadme).not.toContain('builds all three platforms');
    expect(desktopReadme).toContain('Tauri v3');
    expect(desktopReadme).toContain('GTK4');
    expect(desktopReadme).toContain('glib >=0.20');
    expect(desktopReadme).toContain('full native build, install, launch');
    expect(desktopReadme).toContain('independent security review');
    expect(desktopReadme).toContain('hostile `--config`');
    expect(desktopReadme).toContain('official workflow, default Tauri configuration, and fresh builds');
    expect(desktopReadme).toContain('Public desktop releases and installers: none');
    expect(desktopReadme).toContain('workflow 301689703 must remain externally `disabled_manually`');
    expect(desktopReadme).toContain('workflow output is draft-only');
    expect(desktopReadme).toContain('Tag protection is necessary but not sufficient');
    expect(desktopReadme).toContain('historical commit whose workflow predates');
    expect(desktopReadme).not.toContain('Download the latest installer');

    expect(quickstart).toContain('Linux remains supported through npm/CLI and the web dashboard');
    expect(quickstart).toContain('hostile `--config`');
    expect(quickstart).toContain('fresh source builds');
    expect(quickstart).toContain('No public desktop release or installer is currently available');
    expect(quickstart).toContain('workflow 301689703 must remain\n> externally `disabled_manually`');
    expect(quickstart).toContain('configured output is draft-only');
    expect(quickstart).toContain('protection is necessary, not sufficient');
    expect(desktopPointer).toContain('The root Linux CLI, Bun sidecar,\nand web dashboard remain supported');
    expect(desktopPointer).toContain('Tauri v3/GTK4');
    expect(desktopPointer).toContain('glib >=0.20');
    expect(desktopPointer).toContain('hostile `--config`');
    expect(desktopPointer).toContain('fresh source builds');
    expect(desktopPointer).toContain('No public desktop release or installer is currently available');
    expect(desktopPointer).toContain('workflow 301689703 must remain\nexternally `disabled_manually`');
    expect(desktopPointer).toContain('configured output is draft-only');
    expect(desktopPointer).toContain('protection is necessary but not sufficient');
  });
});

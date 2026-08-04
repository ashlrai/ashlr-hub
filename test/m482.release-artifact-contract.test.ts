import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNpmCliLaunch } from '../scripts/build-release-dependency-inventory.mjs';
import {
  buildRuntimeReleaseDependencyInventory,
  observeInstalledRuntimeDependencies,
  parseRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';
import {
  buildUnsignedRuntimeReleaseManifest,
  parseUnsignedRuntimeReleaseManifest,
  verifyUnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';

const tempDirs: string[] = [];
const REVISION = 'b'.repeat(40);

interface ContractFixture {
  dependencyRoot: string;
  inventoryPath: string;
  interpreterPath: string;
  packageRoot: string;
}

function write(path: string, value: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode });
}

function runNpm(args: string[], cwd?: string) {
  const launch = resolveNpmCliLaunch();
  return spawnSync(launch.command, [launch.npmCliPath, ...args], {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fixture(): ContractFixture {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-release-contract-')));
  tempDirs.push(packageRoot);
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@fixture/release',
    version: '1.2.3',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    files: ['bin', 'dist', 'scripts/run-verify-command.mjs'],
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  }, null, 2)}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@fixture/release',
    version: '1.2.3',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@fixture/release',
        version: '1.2.3',
        bin: { ashlr: 'bin/ashlr' },
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': { version: '1.0.0' },
    },
  }, null, 2)}\n`);
  write(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\n', 0o755);
  write(join(packageRoot, 'dist', 'cli', 'index.js'), 'export const runtime = true;\n');
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const verify = true;\n');
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example', 'package.json'), `${JSON.stringify({
    name: 'example',
    version: '1.0.0',
    main: 'index.js',
    files: ['index.js'],
  })}\n`);
  write(join(dependencyRoot, 'example', 'index.js'), 'module.exports = 42;\n');
  write(join(dependencyRoot, 'example', 'CHANGELOG.md'), 'source-only release notes\n');
  const dryRun = runNpm(['pack', '--dry-run', '--ignore-scripts', '--json'], packageRoot);
  if (dryRun.status !== 0) throw new Error(dryRun.stderr);
  const report = JSON.parse(dryRun.stdout) as Array<{ files: Array<{ path: string }> }>;
  const packagedFiles = report[0]!.files.map((entry) => entry.path);
  if (packagedFiles.includes('node_modules/example/CHANGELOG.md')) {
    throw new Error('fixture dependency CHANGELOG was unexpectedly packaged');
  }
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot, {
    packagedFiles,
  });
  if (!inventory.ok) throw new Error(inventory.reason);
  rmSync(join(dependencyRoot, 'example', 'CHANGELOG.md'));
  const inventoryPath = join(
    packageRoot,
    ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/'),
  );
  write(inventoryPath, inventory.canonicalJson);
  const interpreterPath = join(packageRoot, 'fixture-node');
  write(interpreterPath, 'fixture node bytes\n', 0o755);
  return { dependencyRoot, inventoryPath, interpreterPath, packageRoot };
}

function parsedInventory(input: ContractFixture) {
  const parsed = parseRuntimeReleaseDependencyInventory(readFileSync(input.inventoryPath));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.inventory;
}

function observe(input: ContractFixture) {
  return observeInstalledRuntimeDependencies({
    dependencyRoot: input.dependencyRoot,
    inventory: parsedInventory(input),
    expectedPackageName: '@fixture/release',
    expectedPackageVersion: '1.2.3',
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release artifact contract v1', () => {
  it('uses a shell-free Node launch for a strictly validated npm CLI path', () => {
    const launch = resolveNpmCliLaunch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.npmCliPath).toBe(realpathSync(process.env['npm_execpath']!));

    const maliciousRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-malicious-npm-')));
    tempDirs.push(maliciousRoot);
    const maliciousCli = join(maliciousRoot, 'bin', 'npm-cli.js');
    write(maliciousCli, 'process.exit(0);\n');
    write(join(maliciousRoot, 'package.json'), '{"name":"not-npm","version":"1.0.0"}\n');
    expect(() => resolveNpmCliLaunch({ npm_execpath: maliciousCli }))
      .toThrow('npm_execpath is not rooted in an npm package');
    expect(() => resolveNpmCliLaunch({ npm_execpath: 'npm-cli.js' }))
      .toThrow('npm_execpath is missing or invalid');
    expect(() => resolveNpmCliLaunch({ npm_execpath: `${maliciousCli}\n--eval` }))
      .toThrow('npm_execpath is missing or invalid');
  });

  it('packs and installs the inventory plus exact bundled dependency bytes without package-lock', () => {
    const release = fixture();
    const packDestination = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-release-pack-')));
    const installRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-release-install-')));
    tempDirs.push(packDestination, installRoot);
    const packed = runNpm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDestination],
      release.packageRoot,
    );
    expect(packed.status, packed.stderr).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    const paths = report[0]!.files.map((entry) => entry.path);
    expect(paths).toContain(RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH);
    expect(paths).toContain('node_modules/example/package.json');
    expect(paths).toContain('node_modules/example/index.js');
    expect(paths).not.toContain('node_modules/example/CHANGELOG.md');
    expect(paths).not.toContain('package-lock.json');

    const installed = runNpm(
      [
        'install',
        join(packDestination, report[0]!.filename),
        '--prefix',
        installRoot,
        '--ignore-scripts',
        '--omit=dev',
        '--offline',
        '--no-audit',
        '--no-fund',
      ],
    );
    expect(installed.status, installed.stderr).toBe(0);
    const installedPackage = join(installRoot, 'node_modules', '@fixture', 'release');
    const installedInventory = parseRuntimeReleaseDependencyInventory(readFileSync(join(
      installedPackage,
      ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/'),
    )));
    expect(installedInventory.ok).toBe(true);
    if (!installedInventory.ok) return;
    expect(observeInstalledRuntimeDependencies({
      dependencyRoot: join(installedPackage, 'node_modules'),
      inventory: installedInventory.inventory,
      expectedPackageName: '@fixture/release',
      expectedPackageVersion: '1.2.3',
    })).toMatchObject({ ok: true, packageCount: 1 });
    const installedInterpreter = join(installRoot, 'fixture-node');
    write(installedInterpreter, 'installed fixture node bytes\n', 0o755);
    expect(buildUnsignedRuntimeReleaseManifest({
      packageRoot: installedPackage,
      dependencyRoot: join(installedPackage, 'node_modules'),
      declaredInterpreterPath: installedInterpreter,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      expectedPackageName: '@fixture/release',
    })).toMatchObject({
      ok: true,
      manifest: {
        dependencyInventory: { packageCount: 1 },
        schemaVersion: 2,
      },
    });
  }, 30_000);

  it('rejects dependency byte tampering and missing or extra files and packages', () => {
    const tampered = fixture();
    writeFileSync(join(tampered.dependencyRoot, 'example', 'index.js'), 'module.exports = 7;\n');
    expect(observe(tampered)).toEqual({
      ok: false,
      reason: 'installed dependency example bytes do not match inventory',
    });

    const missingFile = fixture();
    rmSync(join(missingFile.dependencyRoot, 'example', 'index.js'));
    expect(observe(missingFile)).toEqual({
      ok: false,
      reason: 'installed dependency example bytes do not match inventory',
    });

    const extraFile = fixture();
    write(join(extraFile.dependencyRoot, 'example', 'unexpected.js'), 'unexpected bytes\n');
    expect(observe(extraFile)).toEqual({
      ok: false,
      reason: 'installed dependency example bytes do not match inventory',
    });

    const missing = fixture();
    rmSync(join(missing.dependencyRoot, 'example'), { recursive: true });
    expect(observe(missing)).toEqual({
      ok: false,
      reason: 'installed dependency package set does not match inventory',
    });

    const extra = fixture();
    write(join(extra.dependencyRoot, 'unexpected', 'package.json'),
      '{"name":"unexpected","version":"1.0.0"}\n');
    expect(observe(extra)).toEqual({
      ok: false,
      reason: 'installed dependency package set does not match inventory',
    });
  });

  it('fails closed when an installed dependency has a mixed version', () => {
    const release = fixture();
    const packageJsonPath = join(release.dependencyRoot, 'example', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, version: '2.0.0' })}\n`);
    expect(observe(release)).toEqual({
      ok: false,
      reason: 'runtime dependency example identity does not match inventory',
    });
  });

  it('rejects a package-directory replacement at the post-traversal checkpoint', () => {
    const release = fixture();
    const packagePath = join(release.dependencyRoot, 'example');
    const replacement = join(release.packageRoot, 'replacement-example');
    const displaced = join(release.packageRoot, 'displaced-example');
    write(join(replacement, 'package.json'), '{"name":"example","version":"1.0.0"}\n');
    write(join(replacement, 'index.js'), 'module.exports = "UNSIGNED-B";\n');
    let swapped = false;
    const result = observeInstalledRuntimeDependencies({
      checkpoint: (phase) => {
        if (phase !== 'after-package-traversal' || swapped) return;
        swapped = true;
        renameSync(packagePath, displaced);
        renameSync(replacement, packagePath);
      },
      dependencyRoot: release.dependencyRoot,
      inventory: parsedInventory(release),
      expectedPackageName: '@fixture/release',
      expectedPackageVersion: '1.2.3',
    });
    expect(swapped).toBe(true);
    expect(result).toEqual({
      ok: false,
      reason: 'runtime dependency example root changed during scan',
    });
  });

  function expectCompleteRootMutationRejected(
    release: ContractFixture,
    mutate: (input: ContractFixture) => void,
  ): void {
    const built = buildUnsignedRuntimeReleaseManifest({
      packageRoot: release.packageRoot,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      expectedPackageName: '@fixture/release',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    mutate(release);
    expect(verifyUnsignedRuntimeReleaseManifest({
      packageRoot: release.packageRoot,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      expectedPackageName: '@fixture/release',
      expectedManifestDigest: built.manifest.manifestDigest,
      manifest: built.canonicalJson,
    })).toMatchObject({ ok: false });
  }

  it('binds the complete dependency root against a .bin executable injection', () => {
    expectCompleteRootMutationRejected(fixture(), (release) => {
      write(join(release.dependencyRoot, '.bin', 'injected'), '#!/usr/bin/env node\n', 0o755);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'binds the complete dependency root against an executable-mode change',
    () => {
      expectCompleteRootMutationRejected(fixture(), (release) => {
        chmodSync(join(release.dependencyRoot, 'example', 'index.js'), 0o755);
      });
    },
  );

  it('rejects external hardlink aliases in installed dependency bytes', () => {
    const release = fixture();
    linkSync(
      join(release.dependencyRoot, 'example', 'index.js'),
      join(release.packageRoot, 'external-hardlink'),
    );
    expect(observe(release)).toEqual({
      ok: false,
      reason: 'runtime dependency file has multiple hard links',
    });
  });

  it('rejects packaged dependency bytes outside the build lock closure', () => {
    const release = fixture();
    expect(buildRuntimeReleaseDependencyInventory(release.packageRoot, {
      packagedFiles: [
        'node_modules/example/index.js',
        'node_modules/example/package.json',
        'node_modules/unowned/index.js',
      ],
    })).toEqual({
      ok: false,
      reason: 'npm pack contains a runtime dependency outside the lock closure',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks anywhere in dependency package bytes', () => {
    const release = fixture();
    symlinkSync(
      join(release.dependencyRoot, 'example', 'index.js'),
      join(release.dependencyRoot, 'example', 'linked.js'),
    );
    expect(observe(release)).toEqual({
      ok: false,
      reason: 'runtime dependency tree contains a symlink',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'binds canonical npm .bin links and rejects targets outside the dependency root',
    () => {
      const release = fixture();
      mkdirSync(join(release.dependencyRoot, '.bin'));
      symlinkSync('../example/index.js', join(release.dependencyRoot, '.bin', 'example'));
      expect(observe(release)).toMatchObject({ ok: true, packageCount: 1 });

      const escaped = fixture();
      const outside = join(escaped.packageRoot, 'outside-bin-target');
      write(outside, '#!/usr/bin/env node\n', 0o755);
      mkdirSync(join(escaped.dependencyRoot, '.bin'));
      symlinkSync('../../outside-bin-target', join(escaped.dependencyRoot, '.bin', 'escape'));
      expect(observe(escaped)).toEqual({
        ok: false,
        reason: 'installed dependency bin link escapes dependency root',
      });
    },
  );

  it.each([
    ['os constraint', { os: ['darwin'] }, undefined],
    ['cpu constraint', { cpu: ['arm64'] }, undefined],
    ['libc constraint', { libc: ['glibc'] }, undefined],
    ['optional dependency', { optionalDependencies: { optional: '1.0.0' } }, undefined],
    ['preinstall script', { scripts: { preinstall: 'node preinstall.js' } }, undefined],
    ['install script', { scripts: { install: 'node install.js' } }, undefined],
    ['postinstall script', { scripts: { postinstall: 'node postinstall.js' } }, undefined],
    ['native package metadata', { gypfile: true }, undefined],
    ['native addon', {}, 'binding.node'],
    ['mixed-case native addon', {}, 'binding.NODE'],
  ])('refuses %s instead of claiming platform-independent bytes', (_label, additions, nativeFile) => {
    const release = fixture();
    const packagePath = join(release.dependencyRoot, 'example', 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({ ...packageJson, ...additions })}\n`);
    if (nativeFile) write(join(release.dependencyRoot, 'example', nativeFile), 'native bytes');
    const rebuilt = buildRuntimeReleaseDependencyInventory(release.packageRoot);
    expect(rebuilt.ok).toBe(false);
    if (rebuilt.ok) return;
    expect(rebuilt.reason).toMatch(/platform-variant|install lifecycle|native install variance/u);
  });

  it.each([
    ['root os constraint', { os: ['darwin'] }],
    ['root cpu constraint', { cpu: ['arm64'] }],
    ['root libc constraint', { libc: ['glibc'] }],
    ['root optional dependency', { optionalDependencies: { optional: '1.0.0' } }],
    ['root preinstall script', { scripts: { preinstall: 'node preinstall.js' } }],
    ['root install script', { scripts: { install: 'node install.js' } }],
    ['root postinstall script', { scripts: { postinstall: 'node postinstall.js' } }],
    ['root native package', { gypfile: true }],
  ])('refuses %s instead of claiming portable root bytes', (_label, additions) => {
    const release = fixture();
    const packagePath = join(release.packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({ ...packageJson, ...additions })}\n`);
    const rebuilt = buildRuntimeReleaseDependencyInventory(release.packageRoot);
    expect(rebuilt.ok).toBe(false);
    if (rebuilt.ok) return;
    expect(rebuilt.reason).toMatch(/platform-variant|install lifecycle|native install variance/u);
  });

  it('refuses a root files declaration that omits required runtime entries', () => {
    const release = fixture();
    const packagePath = join(release.packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({ ...packageJson, files: ['dist'] })}\n`);
    expect(buildRuntimeReleaseDependencyInventory(release.packageRoot)).toEqual({
      ok: false,
      reason: 'release package files declaration is not portable',
    });
  });

  it.each([
    ['install lifecycle script', { scripts: { install: 'node install.js' } }, undefined],
    ['os constraint', { os: ['darwin'] }, undefined],
    ['cpu constraint', { cpu: ['arm64'] }, undefined],
    ['libc constraint', { libc: ['glibc'] }, undefined],
    ['optional dependency', { optionalDependencies: { optional: '1.0.0' } }, undefined],
    ['preinstall lifecycle script', { scripts: { preinstall: 'node preinstall.js' } }, undefined],
    ['postinstall lifecycle script', { scripts: { postinstall: 'node postinstall.js' } }, undefined],
    ['native package metadata', { gypfile: true }, undefined],
    ['mixed-case native addon bytes', {}, 'bin/helper.NODE'],
  ])(
    'revalidates root %s after inventory generation during every complete manifest scan',
    (_label, additions, nativeFile) => {
      const release = fixture();
      const packagePath = join(release.packageRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
      writeFileSync(packagePath, `${JSON.stringify({ ...packageJson, ...additions })}\n`);
      if (nativeFile) write(join(release.packageRoot, nativeFile), 'native bytes');

      const built = buildUnsignedRuntimeReleaseManifest({
        packageRoot: release.packageRoot,
        dependencyRoot: release.dependencyRoot,
        declaredInterpreterPath: release.interpreterPath,
        declaredInterpreterVersion: 'v22.0.0',
        expectedRevision: REVISION,
        expectedPackageName: '@fixture/release',
      });
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.reason).toMatch(/platform-variant|install lifecycle|native install variance/u);
    },
  );

  it('revalidates injected install lifecycle metadata during the second complete scan', () => {
    const release = fixture();
    const packagePath = join(release.packageRoot, 'package.json');
    const options = {
      packageRoot: release.packageRoot,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      expectedPackageName: '@fixture/release',
      __testHooks: {
        afterFirstCompleteScan: () => {
          const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
          writeFileSync(packagePath, `${JSON.stringify({
            ...packageJson,
            scripts: { install: 'node install.js' },
          })}\n`);
        },
      },
    } as Parameters<typeof buildUnsignedRuntimeReleaseManifest>[0];

    expect(buildUnsignedRuntimeReleaseManifest(options)).toEqual({
      ok: false,
      reason: 'release package has an install lifecycle script',
    });
  });

  it('fails closed on old manifest and inventory schemas and forged inventory digests', () => {
    const release = fixture();
    const built = buildUnsignedRuntimeReleaseManifest({
      packageRoot: release.packageRoot,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      expectedPackageName: '@fixture/release',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const oldManifest = JSON.parse(built.canonicalJson) as Record<string, unknown>;
    oldManifest['schemaVersion'] = 1;
    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(oldManifest)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest has an unsupported schema',
    });

    const oldInventory = JSON.parse(readFileSync(release.inventoryPath, 'utf8')) as Record<string, unknown>;
    oldInventory['schemaVersion'] = 1;
    delete (oldInventory['package'] as Record<string, unknown>)['manifestSha256'];
    expect(parseRuntimeReleaseDependencyInventory(`${JSON.stringify(oldInventory)}\n`)).toEqual({
      ok: false,
      reason: 'runtime dependency inventory schema is unsupported',
    });

    const forged = JSON.parse(readFileSync(release.inventoryPath, 'utf8')) as Record<string, unknown>;
    forged['inventoryDigest'] = createHash('sha256').update('forged').digest('hex');
    expect(parseRuntimeReleaseDependencyInventory(`${JSON.stringify(forged)}\n`)).toEqual({
      ok: false,
      reason: 'runtime dependency inventory digest mismatch',
    });
  });
});

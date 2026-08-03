import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeReleaseDependencyInventory,
  observeInstalledRuntimeDependencies,
  parseRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';
import {
  buildUnsignedRuntimeReleaseManifest,
  parseUnsignedRuntimeReleaseManifest,
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
  const dryRun = spawnSync(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
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
  it('packs and installs the inventory plus exact bundled dependency bytes without package-lock', () => {
    const release = fixture();
    const packDestination = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-release-pack-')));
    const installRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-release-install-')));
    tempDirs.push(packDestination, installRoot);
    const packed = spawnSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDestination],
      { cwd: release.packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
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

    const installed = spawnSync(
      'npm',
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
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
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

  it.each([
    ['os constraint', { os: ['darwin'] }, undefined],
    ['cpu constraint', { cpu: ['arm64'] }, undefined],
    ['optional dependency', { optionalDependencies: { optional: '1.0.0' } }, undefined],
    ['install script', { scripts: { install: 'node install.js' } }, undefined],
    ['native addon', {}, 'binding.node'],
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
    oldInventory['schemaVersion'] = 0;
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

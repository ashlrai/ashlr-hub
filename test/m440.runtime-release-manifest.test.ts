import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUnsignedRuntimeReleaseManifest,
  parseUnsignedRuntimeReleaseManifest,
  verifyUnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';
import {
  buildRuntimeReleaseDependencyInventory,
  parseRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';
import { buildLegacyRuntimeReleaseManifestV2 } from './helpers/runtime-release-legacy-v2.js';

const tempDirs: string[] = [];
const REVISION = 'a'.repeat(40);

interface ReleaseFixture {
  dependencyRoot: string;
  interpreterPath: string;
  packageRoot: string;
}

function write(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
}

function fixture(options: { legacyV2?: boolean } = {}): ReleaseFixture {
  const legacyV2 = options.legacyV2 === true;
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-runtime-release-')));
  tempDirs.push(packageRoot);
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: legacyV2 ? '3.3.2' : '3.4.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    files: [
      'bin',
      'dist',
      'schema',
      'scripts/run-verify-command.mjs',
      ...(legacyV2 ? [] : ['scripts/scorecard-history-worker.mjs']),
    ],
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  }, null, 2)}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: legacyV2 ? '3.3.2' : '3.4.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@ashlr/hub',
        version: legacyV2 ? '3.3.2' : '3.4.0',
        bin: { ashlr: 'bin/ashlr' },
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': { version: '1.0.0' },
    },
  }, null, 2)}\n`);
  write(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\nimport("../dist/cli/index.js");\n', 0o755);
  write(join(packageRoot, 'dist', 'cli', 'index.js'), 'export const runtime = true;\n');
  write(join(packageRoot, 'dist', 'core', 'worker.js'), 'export const worker = true;\n');
  write(join(packageRoot, 'schema', 'config.schema.json'), '{"type":"object"}\n');
  if (!legacyV2) {
    write(join(packageRoot, 'scripts', 'scorecard-history-worker.mjs'), 'export const worker = true;\n');
  }
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example', 'package.json'), `${JSON.stringify({
    name: 'example',
    version: '1.0.0',
  })}\n`);
  write(join(dependencyRoot, 'example', 'index.js'), 'export const example = true;\n');
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
    inventory.canonicalJson);
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const run = true;\n');
  const interpreterPath = join(packageRoot, 'fixture-node');
  write(interpreterPath, 'fixture node binary\n', 0o755);
  return { dependencyRoot, interpreterPath, packageRoot };
}

function build(
  input: ReleaseFixture,
  declaredRollbackTargetDigest?: string,
  declaredInterpreterVersion = 'v22.0.0',
  expectedRevision = REVISION,
) {
  return buildUnsignedRuntimeReleaseManifest({
    packageRoot: input.packageRoot,
    dependencyRoot: input.dependencyRoot,
    declaredInterpreterPath: input.interpreterPath,
    declaredInterpreterVersion,
    expectedRevision,
    ...(declaredRollbackTargetDigest ? { declaredRollbackTargetDigest } : {}),
  });
}

function verify(
  input: ReleaseFixture,
  manifest: string | Buffer,
  options: {
    declaredInterpreterVersion?: string;
    declaredRollbackTargetDigest?: string;
    expectedManifestDigest?: string;
    expectedRevision?: string;
  } = {},
) {
  return verifyUnsignedRuntimeReleaseManifest({
    packageRoot: input.packageRoot,
    dependencyRoot: input.dependencyRoot,
    declaredInterpreterPath: input.interpreterPath,
    declaredInterpreterVersion: options.declaredInterpreterVersion ?? 'v22.0.0',
    expectedRevision: options.expectedRevision ?? REVISION,
    manifest,
    ...(options.declaredRollbackTargetDigest
      ? { declaredRollbackTargetDigest: options.declaredRollbackTargetDigest }
      : {}),
    ...(options.expectedManifestDigest
      ? { expectedManifestDigest: options.expectedManifestDigest }
      : {}),
  });
}

function jsonObject(canonical: string): Record<string, unknown> {
  return JSON.parse(canonical) as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('unsigned runtime release manifest', () => {
  it('builds deterministic canonical identity with explicit observation coverage', () => {
    const release = fixture();
    const rollbackTargetDigest = createHash('sha256').update('previous release').digest('hex');
    const first = build(release, rollbackTargetDigest);
    const second = build(release, rollbackTargetDigest);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.canonicalJson.endsWith('\n')).toBe(true);
    expect(first.manifest).toMatchObject({
      algorithm: 'sha256',
      assurance: 'unsigned-observation-only',
      expectedRevision: REVISION,
      schemaVersion: 3,
      coverage: {
        artifactCoherence: 'two-complete-scans',
        authenticity: 'unsigned',
        configuration: 'excluded',
        installedDependencies: 'packaged-byte-inventory-and-installed-tree',
        rollback: 'unresolved-caller-declared-reference',
        serviceInvocation: 'unbound',
      },
      package: {
        binName: 'ashlr',
        manifestPath: 'package.json',
        name: '@ashlr/hub',
        version: '3.4.0',
      },
      dependencyInventory: {
        packageCount: 1,
        path: RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
      },
      entrypoints: {
        launcher: 'bin/ashlr',
        runtime: 'dist/cli/index.js',
        verifierRunner: 'scripts/run-verify-command.mjs',
      },
      interpreterDeclaration: {
        source: 'caller-declared',
        kind: 'node',
        declaredPath: release.interpreterPath,
        claimedVersion: 'v22.0.0',
        observedResolvedPath: release.interpreterPath,
      },
      rollbackDeclaration: {
        resolution: 'unresolved',
        source: 'caller-declared',
        targetManifestDigest: rollbackTargetDigest,
      },
    });
    expect(first.manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      'bin/ashlr',
      'dist/cli/index.js',
      'dist/core/worker.js',
      RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
      'package.json',
      'schema/config.schema.json',
      'scripts/run-verify-command.mjs',
      'scripts/scorecard-history-worker.mjs',
    ]);
    expect(parseUnsignedRuntimeReleaseManifest(first.canonicalJson)).toEqual({
      ok: true,
      manifest: first.manifest,
      canonicalJson: first.canonicalJson,
    });
  });

  it('verifies matching bytes without elevating the unsigned assurance level', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(verify(release, built.canonicalJson, {
      expectedManifestDigest: built.manifest.manifestDigest,
    })).toEqual({
      ok: true,
      assurance: 'unsigned-observation-only',
      manifestDigest: built.manifest.manifestDigest,
    });
  });

  it('verifies a genuine pre-worker schema-v2 rollback package while current builds require v3', () => {
    const release = fixture({ legacyV2: true });
    const legacyManifest = buildLegacyRuntimeReleaseManifestV2({
      artifactPaths: [
        'bin/ashlr',
        'dist/cli/index.js',
        'dist/core/worker.js',
        RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
        'package.json',
        'schema/config.schema.json',
        'scripts/run-verify-command.mjs',
      ],
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedPackageName: '@ashlr/hub',
      expectedRevision: REVISION,
      packageRoot: release.packageRoot,
    });
    const parsed = parseUnsignedRuntimeReleaseManifest(legacyManifest);

    expect(parsed).toMatchObject({
      ok: true,
      manifest: {
        package: { version: '3.3.2' },
        schemaVersion: 2,
      },
    });
    if (!parsed.ok) return;
    expect(parsed.manifest.artifacts.map((artifact) => artifact.path))
      .not.toContain('scripts/scorecard-history-worker.mjs');
    expect(verify(release, legacyManifest, {
      expectedManifestDigest: parsed.manifest.manifestDigest,
    })).toEqual({
      ok: true,
      assurance: 'unsigned-observation-only',
      manifestDigest: parsed.manifest.manifestDigest,
    });
    const currentBuild = build(release);
    expect(currentBuild.ok).toBe(false);
    if (currentBuild.ok) return;
    expect(currentBuild.reason).toContain('scorecard-history-worker.mjs');
  });

  it('does not let schema v2 omit a scorecard worker that is present and declared', () => {
    const release = fixture();
    const incompleteLegacyManifest = buildLegacyRuntimeReleaseManifestV2({
      artifactPaths: [
        'bin/ashlr',
        'dist/cli/index.js',
        'dist/core/worker.js',
        RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
        'package.json',
        'schema/config.schema.json',
        'scripts/run-verify-command.mjs',
      ],
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedPackageName: '@ashlr/hub',
      expectedRevision: REVISION,
      packageRoot: release.packageRoot,
    });

    expect(parseUnsignedRuntimeReleaseManifest(incompleteLegacyManifest))
      .toMatchObject({ ok: true, manifest: { schemaVersion: 2 } });
    expect(verify(release, incompleteLegacyManifest)).toEqual({
      ok: false,
      reason: 'runtime release contents do not match manifest',
    });
  });

  it('requires current schema-v3 packages to declare the scorecard worker', () => {
    const release = fixture();
    const packagePath = join(release.packageRoot, 'package.json');
    const packageJson = jsonObject(readFileSync(packagePath, 'utf8'));
    packageJson['files'] = ['bin', 'dist', 'schema', 'scripts/run-verify-command.mjs'];
    writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);

    expect(build(release)).toEqual({
      ok: false,
      reason: 'schema-v3 release package does not declare the scorecard history worker',
    });
  });

  it('rejects a schema-v3 manifest that omits the scorecard worker artifact', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const incomplete = jsonObject(built.canonicalJson);
    incomplete['artifacts'] = (incomplete['artifacts'] as Array<Record<string, unknown>>)
      .filter((artifact) => artifact['path'] !== 'scripts/scorecard-history-worker.mjs');

    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(incomplete)}\n`)).toEqual({
      ok: false,
      reason: 'required release artifact is missing: scripts/scorecard-history-worker.mjs',
    });
  });

  it('domain-separates schema-v3 candidate digests from the legacy v2 contract', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const downgraded = jsonObject(built.canonicalJson);
    downgraded['schemaVersion'] = 2;

    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(downgraded)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest digest mismatch',
    });
  });

  it('binds the expected revision into the manifest digest', () => {
    const release = fixture();
    const first = build(release);
    const second = build(release, undefined, 'v22.0.0', 'b'.repeat(40));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.manifest.manifestDigest).not.toBe(second.manifest.manifestDigest);
    expect(first.manifest.expectedRevision).toBe(REVISION);
    expect(second.manifest.expectedRevision).toBe('b'.repeat(40));

    const relocated = jsonObject(first.canonicalJson);
    relocated['expectedRevision'] = 'b'.repeat(40);
    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(relocated)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest digest mismatch',
    });
  });

  it('rejects a release that changes between its two complete scans', () => {
    const release = fixture();
    const options = {
      packageRoot: release.packageRoot,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      __testHooks: {
        afterFirstCompleteScan: () => {
          writeFileSync(join(release.packageRoot, 'dist', 'core', 'worker.js'), 'second scan bytes\n');
        },
      },
    } as Parameters<typeof buildUnsignedRuntimeReleaseManifest>[0];

    expect(buildUnsignedRuntimeReleaseManifest(options)).toEqual({
      ok: false,
      reason: 'release changed between complete scans',
    });
  });

  it('expires the shared monotonic budget during the first manifest scan', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    let monotonicMs = 0;
    const options = {
      packageRoot: release.packageRoot,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      manifest: built.canonicalJson,
      __testHooks: {
        afterReleaseLayoutDiscovery: (scan: 'first' | 'second') => {
          if (scan === 'first') monotonicMs = 101;
        },
      },
    } as Parameters<typeof verifyUnsignedRuntimeReleaseManifest>[0];

    expect(verifyUnsignedRuntimeReleaseManifest(options, {
      deadline: 100,
      now: () => monotonicMs,
    })).toEqual({
      ok: false,
      reason: 'runtime release manifest scan observation deadline exceeded',
    });
  });

  it('expires the same monotonic budget before the second manifest scan', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    let monotonicMs = 0;
    const options = {
      packageRoot: release.packageRoot,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
      manifest: built.canonicalJson,
      __testHooks: {
        afterFirstCompleteScan: () => {
          monotonicMs = 101;
        },
      },
    } as Parameters<typeof verifyUnsignedRuntimeReleaseManifest>[0];

    expect(verifyUnsignedRuntimeReleaseManifest(options, {
      deadline: 100,
      now: () => monotonicMs,
    })).toEqual({
      ok: false,
      reason: 'runtime release manifest second scan observation deadline exceeded',
    });
  });

  it('labels arbitrary interpreter and rollback values as caller-declared and unresolved', () => {
    const release = fixture();
    const rollback = createHash('sha256').update('unresolved target').digest('hex');
    const built = build(release, rollback, 'v999.1.2');
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.manifest.interpreterDeclaration).toMatchObject({
      source: 'caller-declared',
      kind: 'node',
      claimedVersion: 'v999.1.2',
    });
    expect(built.manifest.rollbackDeclaration).toEqual({
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: rollback,
    });
    expect(verify(release, built.canonicalJson, {
      declaredInterpreterVersion: 'v999.1.2',
      declaredRollbackTargetDigest: rollback,
    })).toMatchObject({ ok: true, assurance: 'unsigned-observation-only' });
    expect(verify(release, built.canonicalJson, {
      declaredInterpreterVersion: 'v999.1.2',
    })).toEqual({ ok: false, reason: 'runtime release contents do not match manifest' });

    const falselyResolved = jsonObject(built.canonicalJson);
    (falselyResolved['rollbackDeclaration'] as Record<string, unknown>)['resolution'] = 'resolved';
    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(falselyResolved)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest rollback declaration is invalid',
    });
  });

  it('binds installed dependency bytes while continuing to exclude configuration', () => {
    const release = fixture();
    const dependency = join(release.dependencyRoot, 'example', 'index.js');
    const configuration = join(release.packageRoot, 'config', 'runtime.json');
    write(configuration, '{"enabled":true}\n');
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.manifest.dependencyInventory.packageCount).toBe(1);
    expect(built.manifest.artifacts.some((artifact) => artifact.path.startsWith('node_modules/'))).toBe(false);
    expect(built.manifest.artifacts.some((artifact) => artifact.path.startsWith('config/'))).toBe(false);
    writeFileSync(configuration, '{"enabled":false}\n');
    expect(verify(release, built.canonicalJson)).toMatchObject({
      ok: true,
      assurance: 'unsigned-observation-only',
    });
    writeFileSync(dependency, 'export const dependency = 2;\n');
    expect(verify(release, built.canonicalJson)).toEqual({
      ok: false,
      reason: 'installed dependency example bytes do not match inventory',
    });

    const overclaim = jsonObject(built.canonicalJson);
    const artifacts = overclaim['artifacts'] as Array<Record<string, unknown>>;
    artifacts[1]!['path'] = 'node_modules/example/index.js';
    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(overclaim)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest contains an invalid artifact',
    });
  });

  it.each([
    ['launcher', 'bin/ashlr'],
    ['runtime entry', 'dist/cli/index.js'],
    ['nested runtime', 'dist/core/worker.js'],
    ['package metadata', 'package.json'],
    ['dependency inventory', RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH],
    ['verifier runner', 'scripts/run-verify-command.mjs'],
    ['scorecard worker', 'scripts/scorecard-history-worker.mjs'],
  ])('rejects %s byte drift', (_label, relativePath) => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    writeFileSync(join(release.packageRoot, ...relativePath.split('/')), '\n// changed\n', { flag: 'a' });

    expect(verify(release, built.canonicalJson)).toMatchObject({ ok: false });
  });

  it('rejects interpreter drift and an unexpected interpreter identity', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    writeFileSync(release.interpreterPath, 'changed interpreter\n');

    expect(verify(release, built.canonicalJson))
      .toEqual({ ok: false, reason: 'runtime release contents do not match manifest' });
    expect(verify(release, built.canonicalJson, { declaredInterpreterVersion: 'v23.0.0' }))
      .toEqual({ ok: false, reason: 'runtime release contents do not match manifest' });
  });

  it('rejects extra executed runtime files that are absent from the manifest', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    write(join(release.packageRoot, 'dist', 'injected.js'), 'injected();\n');

    expect(verify(release, built.canonicalJson))
      .toEqual({ ok: false, reason: 'runtime release contents do not match manifest' });
  });

  it('fails generation when package and packaged inventory identities do not agree', () => {
    const packageMismatch = fixture();
    const packageJson = JSON.parse(readFileSync(join(packageMismatch.packageRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    packageJson.bin.ashlr = 'bin/other';
    writeFileSync(join(packageMismatch.packageRoot, 'package.json'), JSON.stringify(packageJson));
    expect(build(packageMismatch)).toEqual({
      ok: false,
      reason: 'package launcher does not match bin/ashlr',
    });

    const inventoryMismatch = fixture();
    const mismatchedPackageJson = JSON.parse(
      readFileSync(join(inventoryMismatch.packageRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    mismatchedPackageJson.version = '9.9.9';
    writeFileSync(
      join(inventoryMismatch.packageRoot, 'package.json'),
      JSON.stringify(mismatchedPackageJson),
    );
    expect(build(inventoryMismatch)).toEqual({
      ok: false,
      reason: 'runtime dependency inventory package manifest mismatch',
    });
  });

  it('rejects unknown fields, unsafe artifact paths, and noncanonical JSON', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const unknown = jsonObject(built.canonicalJson);
    unknown['authorityGranted'] = true;
    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(unknown)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest has an invalid top-level shape',
    });

    for (const unsafePath of ['../outside', '/absolute', 'C:\\outside', 'C:outside', 'dist\\escape.js']) {
      const unsafe = jsonObject(built.canonicalJson);
      const artifacts = unsafe['artifacts'] as Array<Record<string, unknown>>;
      artifacts[0]!['path'] = unsafePath;
      expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(unsafe)}\n`)).toEqual({
        ok: false,
        reason: 'runtime release manifest contains an invalid artifact',
      });
    }

    expect(parseUnsignedRuntimeReleaseManifest(JSON.stringify(jsonObject(built.canonicalJson), null, 2)))
      .toEqual({
        ok: false,
        reason: 'runtime release manifest encoding is not canonical',
      });

    const falseCoverage = jsonObject(built.canonicalJson);
    (falseCoverage['coverage'] as Record<string, unknown>)['authenticity'] = 'signed';
    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(falseCoverage)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest coverage is invalid',
    });
  });

  it('rejects invalid UTF-8 and duplicate-key noncanonical encodings', () => {
    expect(parseUnsignedRuntimeReleaseManifest(Buffer.from([0xff]))).toEqual({
      ok: false,
      reason: 'runtime release manifest is not valid UTF-8',
    });

    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const duplicate = built.canonicalJson.replace(
      '"algorithm":"sha256"',
      '"algorithm":"sha256","algorithm":"sha256"',
    );
    expect(parseUnsignedRuntimeReleaseManifest(duplicate)).toEqual({
      ok: false,
      reason: 'runtime release manifest encoding is not canonical',
    });

    const invalidPackage = fixture();
    writeFileSync(join(invalidPackage.packageRoot, 'package.json'), Buffer.from([0xff]));
    expect(build(invalidPackage)).toEqual({
      ok: false,
      reason: 'package.json is not valid UTF-8',
    });
  });

  it('rejects duplicate keys in package and dependency inventory identity files', () => {
    const duplicatePackage = fixture();
    write(join(duplicatePackage.packageRoot, 'package.json'), [
      '{',
      '  "name": "attacker/package",',
      '  "name": "@ashlr/hub",',
      '  "version": "3.1.0",',
      '  "bin": { "ashlr": "bin/ashlr" }',
      '}',
      '',
    ].join('\n'));
    expect(build(duplicatePackage)).toEqual({
      ok: false,
      reason: 'package.json contains duplicate object keys',
    });

    const duplicateInventory = fixture();
    const inventoryBytes = readFileSync(
      join(duplicateInventory.packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
      'utf8',
    );
    expect(parseRuntimeReleaseDependencyInventory(inventoryBytes.replace(
      '"algorithm":"sha256"',
      '"algorithm":"sha256","algorithm":"sha256"',
    ))).toEqual({
      ok: false,
      reason: 'runtime dependency inventory encoding is not canonical',
    });
  });

  it('enforces focused package and dependency inventory byte limits before parsing', () => {
    const oversizedPackage = fixture();
    truncateSync(join(oversizedPackage.packageRoot, 'package.json'), 1024 * 1024 + 1);
    expect(build(oversizedPackage)).toEqual({
      ok: false,
      reason: 'package.json exceeds byte limit',
    });

    const oversizedInventory = fixture();
    truncateSync(
      join(oversizedInventory.packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
      512 * 1024 + 1,
    );
    expect(build(oversizedInventory)).toEqual({
      ok: false,
      reason: `${RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH} exceeds byte limit`,
    });
  });

  it('enforces traversal depth and per-directory entry limits during discovery', () => {
    const deep = fixture();
    let directory = join(deep.packageRoot, 'dist');
    for (let index = 0; index < 33; index += 1) directory = join(directory, `d${index}`);
    write(join(directory, 'deep.js'), 'deep();\n');
    expect(build(deep)).toEqual({
      ok: false,
      reason: 'runtime traversal depth exceeds limit',
    });

    const wide = fixture();
    for (let index = 0; index < 1_025; index += 1) {
      write(join(wide.packageRoot, 'dist', 'wide', `f-${index}.js`), '');
    }
    expect(build(wide)).toEqual({
      ok: false,
      reason: 'runtime directory entry count exceeds limit',
    });
  }, 30_000);

  it('enforces artifact-count and cumulative-byte limits during discovery', () => {
    const many = fixture();
    for (let index = 0; index < 2_043; index += 1) {
      write(join(many.packageRoot, 'dist', `bucket-${index % 3}`, `f-${index}.js`), '');
    }
    expect(build(many)).toEqual({
      ok: false,
      reason: 'release artifact count exceeds limit',
    });

    const large = fixture();
    for (let index = 0; index < 3; index += 1) {
      const path = join(large.packageRoot, 'dist', `large-${index}.bin`);
      write(path, '');
      truncateSync(path, 100 * 1024 * 1024);
    }
    expect(build(large)).toEqual({
      ok: false,
      reason: 'release artifacts exceed total byte limit',
    });
  }, 30_000);

  it('rejects generated canonical JSON that exceeds the manifest byte limit', () => {
    const release = fixture();
    const longName = 'x'.repeat(220);
    for (let index = 0; index < 2_000; index += 1) {
      write(
        join(release.packageRoot, 'dist', `bucket-${index % 2}`, `${index}-${longName}.js`),
        '',
      );
    }
    expect(build(release)).toEqual({
      ok: false,
      reason: 'generated runtime release manifest exceeds byte limit',
    });
  }, 30_000);

  it('rejects manifest digest changes and caller-pinned digest mismatches', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const changed = jsonObject(built.canonicalJson);
    changed['manifestDigest'] = createHash('sha256').update('different').digest('hex');

    expect(parseUnsignedRuntimeReleaseManifest(`${JSON.stringify(changed)}\n`)).toEqual({
      ok: false,
      reason: 'runtime release manifest digest mismatch',
    });
    expect(verify(release, built.canonicalJson, {
      expectedManifestDigest: createHash('sha256').update('other expected release').digest('hex'),
    })).toEqual({
      ok: false,
      reason: 'runtime release manifest does not match expected digest',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks in the executed runtime tree', () => {
    const release = fixture();
    const outside = join(release.packageRoot, 'outside.js');
    write(outside, 'outside();\n');
    symlinkSync(outside, join(release.packageRoot, 'dist', 'linked.js'));

    expect(build(release)).toEqual({
      ok: false,
      reason: 'runtime tree contains a symlink',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a dangling schema symlink instead of skipping it', () => {
    const release = fixture();
    rmSync(join(release.packageRoot, 'schema'), { recursive: true });
    symlinkSync('missing-schema', join(release.packageRoot, 'schema'));

    expect(build(release)).toEqual({
      ok: false,
      reason: 'release tree contains an unsafe directory',
    });
  });

  it('rejects a matching dependency tree outside the admitted package root', () => {
    const release = fixture();
    const decoy = fixture();
    expect(buildUnsignedRuntimeReleaseManifest({
      packageRoot: release.packageRoot,
      dependencyRoot: decoy.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
    })).toEqual({
      ok: false,
      reason: 'dependency root is not bound to package root',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked package dependency root', () => {
    const release = fixture();
    const dependencyTarget = join(release.packageRoot, 'dependency-target');
    renameSync(release.dependencyRoot, dependencyTarget);
    symlinkSync(dependencyTarget, release.dependencyRoot, 'dir');
    expect(build(release)).toEqual({
      ok: false,
      reason: 'dependency root is not a canonical directory',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked package root', () => {
    const release = fixture();
    const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-runtime-release-alias-')));
    tempDirs.push(aliasParent);
    const alias = join(aliasParent, 'release');
    symlinkSync(release.packageRoot, alias, 'dir');
    expect(buildUnsignedRuntimeReleaseManifest({
      packageRoot: alias,
      dependencyRoot: release.dependencyRoot,
      declaredInterpreterPath: release.interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedRevision: REVISION,
    })).toEqual({
      ok: false,
      reason: 'package root is not a canonical directory',
    });
  });

  it('binds executable mode on platforms that expose POSIX mode bits', () => {
    const release = fixture();
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    if (process.platform === 'win32') return;
    chmodSync(join(release.packageRoot, 'bin', 'ashlr'), 0o644);

    expect(verify(release, built.canonicalJson))
      .toEqual({ ok: false, reason: 'runtime release contents do not match manifest' });
  });
});

import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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

const tempDirs: string[] = [];
const REVISION = 'a'.repeat(40);

interface ReleaseFixture {
  interpreterPath: string;
  packageRoot: string;
}

function write(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
}

function fixture(): ReleaseFixture {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-runtime-release-')));
  tempDirs.push(packageRoot);
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
  }, null, 2)}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@ashlr/hub',
        version: '3.1.0',
        bin: { ashlr: 'bin/ashlr' },
      },
    },
  }, null, 2)}\n`);
  write(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\nimport("../dist/cli/index.js");\n', 0o755);
  write(join(packageRoot, 'dist', 'cli', 'index.js'), 'export const runtime = true;\n');
  write(join(packageRoot, 'dist', 'core', 'worker.js'), 'export const worker = true;\n');
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const run = true;\n');
  const interpreterPath = join(packageRoot, 'fixture-node');
  write(interpreterPath, 'fixture node binary\n', 0o755);
  return { interpreterPath, packageRoot };
}

function build(
  input: ReleaseFixture,
  declaredRollbackTargetDigest?: string,
  declaredInterpreterVersion = 'v22.0.0',
  expectedRevision = REVISION,
) {
  return buildUnsignedRuntimeReleaseManifest({
    packageRoot: input.packageRoot,
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
      schemaVersion: 1,
      coverage: {
        artifactCoherence: 'two-complete-scans',
        authenticity: 'unsigned',
        configuration: 'excluded',
        installedDependencies: 'lockfile-only',
        rollback: 'unresolved-caller-declared-reference',
        serviceInvocation: 'unbound',
      },
      package: {
        binName: 'ashlr',
        manifestPath: 'package.json',
        name: '@ashlr/hub',
        version: '3.1.0',
      },
      lockfile: {
        lockfileVersion: 3,
        path: 'package-lock.json',
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
      'package-lock.json',
      'package.json',
      'scripts/run-verify-command.mjs',
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

  it('excludes installed dependencies and configuration exactly as declared by coverage', () => {
    const release = fixture();
    const dependency = join(release.packageRoot, 'node_modules', 'example', 'index.js');
    const configuration = join(release.packageRoot, 'config', 'runtime.json');
    write(dependency, 'export const dependency = 1;\n');
    write(configuration, '{"enabled":true}\n');
    const built = build(release);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.manifest.artifacts.some((artifact) => artifact.path.startsWith('node_modules/'))).toBe(false);
    expect(built.manifest.artifacts.some((artifact) => artifact.path.startsWith('config/'))).toBe(false);
    writeFileSync(dependency, 'export const dependency = 2;\n');
    writeFileSync(configuration, '{"enabled":false}\n');
    expect(verify(release, built.canonicalJson)).toMatchObject({
      ok: true,
      assurance: 'unsigned-observation-only',
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
    ['dependency lock', 'package-lock.json'],
    ['verifier runner', 'scripts/run-verify-command.mjs'],
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

  it('fails generation when package and lock identities do not agree', () => {
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

    const lockMismatch = fixture();
    const lockJson = JSON.parse(readFileSync(join(lockMismatch.packageRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string }>;
    };
    lockJson.packages['']!.version = '9.9.9';
    writeFileSync(join(lockMismatch.packageRoot, 'package-lock.json'), JSON.stringify(lockJson));
    expect(build(lockMismatch)).toEqual({
      ok: false,
      reason: 'package lock root identity does not match package.json',
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

  it('enforces focused package and lockfile byte limits before parsing', () => {
    const oversizedPackage = fixture();
    truncateSync(join(oversizedPackage.packageRoot, 'package.json'), 1024 * 1024 + 1);
    expect(build(oversizedPackage)).toEqual({
      ok: false,
      reason: 'package.json exceeds byte limit',
    });

    const oversizedLock = fixture();
    truncateSync(join(oversizedLock.packageRoot, 'package-lock.json'), 16 * 1024 * 1024 + 1);
    expect(build(oversizedLock)).toEqual({
      ok: false,
      reason: 'package-lock.json exceeds byte limit',
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

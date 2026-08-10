import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspectProductionActivationReadinessV1 } from
  '../src/core/daemon/production-activation-readiness.js';
import { observeProductionArtifactPackagingV1 } from
  '../src/core/daemon/production-activation-observations.js';
import {
  buildRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';
import {
  buildRuntimeReleaseEvidenceTrustRoot,
  signRuntimeReleaseEvidenceEnvelope,
} from '../src/core/daemon/runtime-release-evidence-envelope.js';
import {
  observeRuntimeReleaseImmutableStagedTree,
  runtimeReleaseEnvelopeCanonicalSha256,
  runtimeReleasePolicyId,
  runtimeReleaseServiceInvocationDigest,
  runtimeReleaseTrustRootCanonicalSha256,
} from '../src/core/daemon/runtime-release-launch-revalidation.js';
import { buildUnsignedRuntimeReleaseManifest } from
  '../src/core/daemon/runtime-release-manifest.js';

const REVISION = 'd'.repeat(40);
const NOW = '2026-08-03T18:05:00.000Z';
const ISSUED_AT = '2026-08-03T18:00:00.000Z';
const EXPIRES_AT = '2026-08-03T18:10:00.000Z';
const POLICY = '{"policyVersion":1,"scope":"release-launch"}\n';
const roots: string[] = [];

interface CompatibleRelease {
  launchObservation: Parameters<typeof inspectProductionActivationReadinessV1>[0]['launchObservation'];
  packageRoot: string;
  parent: string;
}

function write(path: string, value: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode });
}

function chmodTree(path: string, frozen: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, frozen ? 0o555 : 0o755);
    for (const name of readdirSync(path)) chmodTree(join(path, name), frozen);
    return;
  }
  const executable = (stat.mode & 0o111) !== 0;
  chmodSync(path, frozen ? (executable ? 0o555 : 0o444) : (executable ? 0o755 : 0o644));
}

function createCompatibleRelease(): CompatibleRelease {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-release-activation-v2-')));
  roots.push(parent);
  const packageRoot = join(parent, REVISION);
  mkdirSync(packageRoot);
  const packageJson = {
    name: '@ashlr/hub',
    version: '3.1.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    files: ['bin', 'dist', 'scripts/run-verify-command.mjs'],
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  };
  write(join(packageRoot, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@ashlr/hub',
        version: '3.1.0',
        bin: { ashlr: 'bin/ashlr' },
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': { version: '1.0.0' },
    },
  })}\n`);
  write(join(packageRoot, 'bin/ashlr'), '#!/usr/bin/env node\n', 0o755);
  write(join(packageRoot, 'dist/cli/index.js'), 'export const runtime = true;\n');
  write(join(packageRoot, 'dist/core/worker.js'), 'export const worker = true;\n');
  write(join(packageRoot, 'scripts/run-verify-command.mjs'), 'export const run = true;\n');
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example/package.json'), '{"name":"example","version":"1.0.0"}\n');
  write(join(dependencyRoot, 'example/index.js'), 'export const example = true;\n');

  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(
    join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
    inventory.canonicalJson,
  );
  const interpreterPath = join(parent, 'node');
  write(interpreterPath, 'fixture node binary\n', 0o755);
  const manifest = buildUnsignedRuntimeReleaseManifest({
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot,
    expectedRevision: REVISION,
    packageRoot,
  });
  if (!manifest.ok) throw new Error(manifest.reason);
  const keys = generateKeyPairSync('ed25519');
  const envelope = signRuntimeReleaseEvidenceEnvelope({
    expiresAt: EXPIRES_AT,
    issuedAt: ISSUED_AT,
    manifest: manifest.canonicalJson,
    privateKey: keys.privateKey,
  });
  if (!envelope.ok) throw new Error(envelope.reason);
  const trustRoot = buildRuntimeReleaseEvidenceTrustRoot({
    keys: [{
      publicKey: keys.publicKey,
      validFrom: '2026-08-03T17:00:00.000Z',
      validUntil: '2026-08-03T19:00:00.000Z',
    }],
  });
  if (!trustRoot.ok) throw new Error(trustRoot.reason);
  chmodTree(packageRoot, true);
  chmodTree(interpreterPath, true);
  const staged = observeRuntimeReleaseImmutableStagedTree({
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot,
    expectedManifestDigest: manifest.manifest.manifestDigest,
    expectedPackageName: '@ashlr/hub',
    expectedRevision: REVISION,
    manifest: manifest.canonicalJson,
    packageRoot,
  });
  if (!staged.ok) throw new Error(staged.reason);
  const argv = [join(packageRoot, 'bin/ashlr'), 'daemon', 'start'];
  const invocationDigest = runtimeReleaseServiceInvocationDigest(interpreterPath, argv);
  const policyId = runtimeReleasePolicyId(POLICY);
  const envelopeDigest = runtimeReleaseEnvelopeCanonicalSha256(envelope.canonicalJson);
  const trustRootDigest = runtimeReleaseTrustRootCanonicalSha256(trustRoot.canonicalJson);
  if (!invocationDigest || !policyId || !envelopeDigest || !trustRootDigest) {
    throw new Error('release launch pins are invalid');
  }
  return {
    packageRoot,
    parent,
    launchObservation: {
      argv,
      declaredInterpreterPath: interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      dependencyRoot,
      envelope: envelope.canonicalJson,
      executablePath: interpreterPath,
      expectedEnvelopeCanonicalSha256: envelopeDigest,
      expectedKeyId: envelope.keyId,
      expectedManifestDigest: manifest.manifest.manifestDigest,
      expectedPackageName: '@ashlr/hub',
      expectedPolicyId: policyId,
      expectedRevision: REVISION,
      expectedServiceInvocationDigest: invocationDigest,
      expectedStagedTreeIdentity: staged.receipt.stagedTreeIdentity,
      expectedTrustRootCanonicalSha256: trustRootDigest,
      manifest: manifest.canonicalJson,
      packageRoot,
      policy: POLICY,
      trustRoot: trustRoot.canonicalJson,
    },
  };
}

function inspect(release: CompatibleRelease) {
  return inspectProductionActivationReadinessV1({
    packageRoot: release.packageRoot,
    launchObservation: release.launchObservation,
    residentServiceDiagnostic: { diagnosticStatus: 'blocked', findings: [] },
    releaseTipObservation: { sourceState: 'healthy', complete: true, stopReasons: [] },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    try {
      chmodTree(root, false);
    } catch {
      // Hostile fixtures can intentionally alter the tree.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release V2 to production activation compatibility', () => {
  it('consumes one real V2 artifact graph while preserving zero operational authority', () => {
    const release = createCompatibleRelease();
    const packaging = observeProductionArtifactPackagingV1(release.packageRoot);
    const report = inspect(release);

    expect(packaging).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      packageCount: 1,
      expectation: { schemaVersion: 2 },
    });
    expect(report.sourceQuality).toEqual({ sourceState: 'healthy', complete: true, reasons: [] });
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      state: 'observed-blocked',
    });
    expect(report.authorityFlags).toEqual({
      admissionPermitted: false,
      activationPermitted: false,
      deployPermitted: false,
      installPermitted: false,
      launchPermitted: false,
      lifecycleMutationPermitted: false,
      releaseSettlementPermitted: false,
      rollbackPermitted: false,
      startPermitted: false,
    });
  });

  it('rejects package lifecycle and case-insensitive native variance after inventory capture', () => {
    for (const mutation of ['install', 'native'] as const) {
      const release = createCompatibleRelease();
      chmodTree(release.packageRoot, false);
      if (mutation === 'install') {
        const packagePath = join(release.packageRoot, 'package.json');
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
        packageJson['scripts'] = { install: 'node install.js' };
        writeFileSync(packagePath, `${JSON.stringify(packageJson)}\n`);
      } else {
        write(join(release.packageRoot, 'dist/native.NODE'), 'native bytes\n');
      }
      chmodTree(release.packageRoot, true);

      expect(observeProductionArtifactPackagingV1(release.packageRoot)).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        dependencyInventory: 'mismatch',
      });
      expect(inspect(release).authorityFlags.activationPermitted).toBe(false);
    }
  });

  it('rejects writable, hard-linked, and untrusted-owner staged artifacts', () => {
    const writable = createCompatibleRelease();
    chmodSync(join(writable.packageRoot, 'bin/ashlr'), 0o777);
    expect(inspect(writable).observations.launchAdmission.complete).toBe(false);

    const hardLinked = createCompatibleRelease();
    linkSync(join(hardLinked.packageRoot, 'bin/ashlr'), join(hardLinked.parent, 'launcher-alias'));
    expect(inspect(hardLinked).observations.launchAdmission.complete).toBe(false);

    if (typeof process.getuid === 'function') {
      const ownerMismatch = createCompatibleRelease();
      const getuid = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
      try {
        expect(inspect(ownerMismatch).observations.launchAdmission.complete).toBe(false);
      } finally {
        getuid.mockRestore();
      }
    }
  });
});

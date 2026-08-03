import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeReleaseEvidenceTrustRoot,
  runtimeReleaseEvidenceKeyId,
  signRuntimeReleaseEvidenceEnvelope,
} from '../src/core/daemon/runtime-release-evidence-envelope.js';
import {
  observeRuntimeReleaseImmutableStagedTree,
  observeRuntimeReleaseLaunchInputs,
  runtimeReleaseEnvelopeCanonicalSha256,
  runtimeReleasePolicyId,
  runtimeReleaseServiceInvocationDigest,
  runtimeReleaseTrustRootCanonicalSha256,
  type RuntimeReleaseLaunchObservationOptions,
} from '../src/core/daemon/runtime-release-launch-revalidation.js';
import {
  buildUnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';
import {
  buildRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';

const REVISION = 'a'.repeat(40);
const POLICY = '{"policyVersion":1,"scope":"release-launch"}\n';
const ISSUED_AT = '2026-07-29T12:00:00.000Z';
const NOW = '2026-07-29T12:05:00.000Z';
const EXPIRES_AT = '2026-07-29T12:10:00.000Z';
const KEY_VALID_FROM = '2026-07-29T11:00:00.000Z';
const KEY_VALID_UNTIL = '2026-07-29T13:00:00.000Z';
const tempDirs: string[] = [];

interface Fixture {
  argv: string[];
  dependencyRoot: string;
  envelope: string;
  executablePath: string;
  expectedKeyId: string;
  expectedManifestDigest: string;
  interpreterPath: string;
  manifest: string;
  packageRoot: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  trustRoot: string;
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
    for (const entry of readFileNames(path)) chmodTree(join(path, entry), frozen);
    return;
  }
  const executable = (stat.mode & 0o111) !== 0;
  chmodSync(path, frozen ? (executable ? 0o555 : 0o444) : (executable ? 0o755 : 0o644));
}

function readFileNames(path: string): string[] {
  return readdirSync(path);
}

function fixture(declaredRollbackTargetDigest?: string): Fixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-launch-revalidation-')));
  tempDirs.push(parent);
  const packageRoot = join(parent, REVISION);
  mkdirSync(packageRoot);
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  })}\n`);
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
  write(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\n', 0o755);
  write(join(packageRoot, 'dist', 'cli', 'index.js'), 'export const runtime = true;\n');
  write(join(packageRoot, 'dist', 'core', 'worker.js'), 'export const worker = true;\n');
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const run = true;\n');
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example', 'package.json'), '{"name":"example","version":"1.0.0"}\n');
  write(join(dependencyRoot, 'example', 'index.js'), 'export const dependency = true;\n');
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(
    join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
    inventory.canonicalJson,
  );
  const interpreterPath = join(parent, 'node');
  write(interpreterPath, 'fixture node binary\n', 0o755);

  const manifestResult = buildUnsignedRuntimeReleaseManifest({
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot,
    expectedRevision: REVISION,
    packageRoot,
    ...(declaredRollbackTargetDigest ? { declaredRollbackTargetDigest } : {}),
  });
  if (!manifestResult.ok) throw new Error(manifestResult.reason);
  const keys = generateKeyPairSync('ed25519');
  const envelopeResult = signRuntimeReleaseEvidenceEnvelope({
    expiresAt: EXPIRES_AT,
    issuedAt: ISSUED_AT,
    manifest: manifestResult.canonicalJson,
    privateKey: keys.privateKey,
  });
  if (!envelopeResult.ok) throw new Error(envelopeResult.reason);
  const rootResult = buildRuntimeReleaseEvidenceTrustRoot({
    keys: [{
      publicKey: keys.publicKey,
      validFrom: KEY_VALID_FROM,
      validUntil: KEY_VALID_UNTIL,
    }],
  });
  if (!rootResult.ok) throw new Error(rootResult.reason);
  chmodTree(packageRoot, true);
  chmodTree(interpreterPath, true);
  const executablePath = interpreterPath;
  const argv = [join(packageRoot, 'bin', 'ashlr'), 'daemon', 'start'];
  return {
    argv,
    dependencyRoot,
    envelope: envelopeResult.canonicalJson,
    executablePath,
    expectedKeyId: envelopeResult.keyId,
    expectedManifestDigest: manifestResult.manifest.manifestDigest,
    interpreterPath,
    manifest: manifestResult.canonicalJson,
    packageRoot,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    trustRoot: rootResult.canonicalJson,
  };
}

function stageOptions(input: Fixture) {
  return {
    declaredInterpreterPath: input.interpreterPath,
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot: input.dependencyRoot,
    expectedManifestDigest: input.expectedManifestDigest,
    expectedRevision: REVISION,
    manifest: input.manifest,
    packageRoot: input.packageRoot,
  };
}

function launchOptions(
  input: Fixture,
  overrides: Partial<RuntimeReleaseLaunchObservationOptions> = {},
): RuntimeReleaseLaunchObservationOptions {
  const observed = observeRuntimeReleaseImmutableStagedTree(stageOptions(input));
  if (!observed.ok) throw new Error(observed.reason);
  const digest = runtimeReleaseServiceInvocationDigest(input.executablePath, input.argv);
  if (!digest) throw new Error('fixture invocation was invalid');
  const policyId = runtimeReleasePolicyId(POLICY);
  if (!policyId) throw new Error('fixture policy was invalid');
  const envelopeCanonicalSha256 =
    runtimeReleaseEnvelopeCanonicalSha256(input.envelope);
  const trustRootCanonicalSha256 =
    runtimeReleaseTrustRootCanonicalSha256(input.trustRoot);
  if (!envelopeCanonicalSha256 || !trustRootCanonicalSha256) {
    throw new Error('fixture signed evidence was invalid');
  }
  return {
    ...stageOptions(input),
    argv: input.argv,
    envelope: input.envelope,
    executablePath: input.executablePath,
    expectedEnvelopeCanonicalSha256: envelopeCanonicalSha256,
    expectedKeyId: input.expectedKeyId,
    expectedPolicyId: policyId,
    expectedServiceInvocationDigest: digest,
    expectedStagedTreeIdentity: observed.receipt.stagedTreeIdentity,
    expectedTrustRootCanonicalSha256: trustRootCanonicalSha256,
    policy: POLICY,
    trustRoot: input.trustRoot,
    ...overrides,
  };
}

function observeLaunch(
  options: RuntimeReleaseLaunchObservationOptions,
  now = NOW,
) {
  vi.setSystemTime(now);
  return observeRuntimeReleaseLaunchInputs(options);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    try {
      chmodTree(directory, false);
    } catch {
      // A race test may have replaced part of the fixture.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime release closed launch-input observation', () => {
  it('binds immutable roots, signed release, exact invocation, and stable identity without authority', () => {
    const release = fixture();
    const options = launchOptions(release);
    const result = observeLaunch(options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({
      assurance: 'closed-byte-observation-only',
      authority: {
        deployPermitted: false,
        installPermitted: false,
        launchPermitted: false,
        rollbackPermitted: false,
        startPermitted: false,
      },
      coverage: {
        atomicLaunchHandoff: 'absent-descriptors-closed',
        descriptorLifetime: 'closed-after-each-read',
        artifacts: 'complete-manifest-artifact-root',
        dependencies: 'complete-staged-dependency-tree',
        envelope: 'signed-release-observation-revalidated',
        interpreter: 'complete-declared-interpreter-artifact',
        invocation: 'exact-executable-and-argv-digest',
        launchConsumer: 'absent',
        mutationAfterReceipt: 'not-prevented',
        replayPrevention: 'absent-no-durable-consumption-store',
      },
      hostPlatform: process.platform,
      schemaVersion: 2,
      time: {
        completedAtMs: Date.parse(NOW),
        movement: 'nondecreasing-observed',
        source: 'host-Date.now',
        verifiedAtMs: Date.parse(NOW),
      },
      expectedRevision: REVISION,
      invocation: {
        argumentCount: release.argv.length,
        executablePath: release.executablePath,
        serviceInvocationDigest: options.expectedServiceInvocationDigest,
      },
      policy: {
        policyId: runtimeReleasePolicyId(POLICY),
        source: 'caller-pinned-unsigned',
      },
      release: {
        expiresAt: EXPIRES_AT,
        issuedAt: ISSUED_AT,
        keyId: release.expectedKeyId,
        manifestDigest: release.expectedManifestDigest,
        expectedRevision: REVISION,
        rollbackTargetManifestDigest: null,
      },
    });
    expect(result.receipt.roots.artifactRootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.roots.dependencyRootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.roots.interpreterRootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.stableIdentity.beforeSha256)
      .toBe(result.receipt.stableIdentity.afterSha256);
    expect(result.canonicalJson).toBe(`${JSON.stringify(result.receipt)}\n`);
    expect(result.receipt.release.envelopeCanonicalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.release.manifestCanonicalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.release.trustRootCanonicalSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['artifact', 'dist/core/worker.js'],
    ['dependency', 'node_modules/example/index.js'],
  ])('rejects %s mutation after the staged identity was pinned', (_label, relativePath) => {
    const release = fixture();
    const options = launchOptions(release);
    const path = join(release.packageRoot, ...relativePath.split('/'));
    chmodSync(path, 0o644);
    writeFileSync(path, 'mutated\n');
    chmodSync(path, 0o444);

    expect(observeLaunch(options)).toMatchObject({ ok: false });
  });

  it('rejects interpreter and service invocation mismatches', () => {
    const release = fixture();
    const options = launchOptions(release);
    const otherInterpreter = join(dirname(release.packageRoot), 'other-node');
    write(otherInterpreter, 'fixture node binary\n', 0o555);
    expect(observeLaunch({
      ...options,
      executablePath: otherInterpreter,
      expectedServiceInvocationDigest:
        runtimeReleaseServiceInvocationDigest(otherInterpreter, release.argv)!,
    })).toEqual({
      ok: false,
      reason: 'runtime release service invocation is not the staged launcher',
    });

    expect(observeLaunch({
      ...options,
      argv: [...release.argv, '--budget', '10'],
    })).toEqual({
      ok: false,
      reason: 'runtime release service invocation digest mismatch',
    });
  });

  it('rejects stale signatures and unknown signing keys', () => {
    const release = fixture();
    expect(observeLaunch(launchOptions(release), EXPIRES_AT)).toEqual({
      ok: false,
      reason: 'runtime release evidence is stale',
    });

    expect(observeLaunch(launchOptions(release, {
      expectedKeyId: `ed25519-sha256:${'0'.repeat(64)}`,
    }))).toEqual({
      ok: false,
      reason: 'runtime release signing key does not match expected key id',
    });
  });

  it('revalidates a non-null signed rollback declaration end to end', () => {
    const rollbackTarget = 'f'.repeat(64);
    const release = fixture(rollbackTarget);
    const result = observeLaunch(launchOptions(release));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.release.rollbackTargetManifestDigest).toBe(rollbackTarget);
    expect(result.receipt.authority.rollbackPermitted).toBe(false);
    expect(result.receipt.coverage.replayPrevention)
      .toBe('absent-no-durable-consumption-store');
  });

  it('makes post-observation mutation explicit instead of claiming pre-exec authority', () => {
    const release = fixture();
    const result = observeLaunch(launchOptions(release));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const launcher = join(release.packageRoot, 'bin', 'ashlr');
    chmodSync(launcher, 0o755);
    writeFileSync(launcher, '#!/bin/sh\nexit 1\n');

    expect(result.receipt.assurance).toBe('closed-byte-observation-only');
    expect(result.receipt.coverage.atomicLaunchHandoff)
      .toBe('absent-descriptors-closed');
    expect(result.receipt.coverage.mutationAfterReceipt).toBe('not-prevented');
    expect(result.receipt.authority.launchPermitted).toBe(false);
    expect(result.receipt.authority.startPermitted).toBe(false);
  });

  it('refuses evidence that expires during the final staged-tree observation', () => {
    const release = fixture();
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterBeforeObservation?: () => void };
    };
    options.__testHooks = {
      afterBeforeObservation: () => vi.setSystemTime(EXPIRES_AT),
    };
    const result = observeLaunch(options);

    expect(result).toEqual({
      ok: false,
      reason: 'runtime release evidence expired during launch revalidation',
    });
  });

  it('rejects a backward host clock movement during observation', () => {
    const release = fixture();
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterBeforeObservation?: () => void };
    };
    options.__testHooks = {
      afterBeforeObservation: () => vi.setSystemTime('2026-07-29T12:04:59.999Z'),
    };

    expect(observeLaunch(options)).toEqual({
      ok: false,
      reason: 'runtime release host clock moved backward during observation',
    });
  });

  it('rejects a signature from a key absent from the trust root', () => {
    const release = fixture();
    const other = generateKeyPairSync('ed25519');
    const otherRoot = buildRuntimeReleaseEvidenceTrustRoot({
      keys: [{
        publicKey: other.publicKey,
        validFrom: KEY_VALID_FROM,
        validUntil: KEY_VALID_UNTIL,
      }],
    });
    if (!otherRoot.ok) throw new Error(otherRoot.reason);
    const otherRootDigest =
      runtimeReleaseTrustRootCanonicalSha256(otherRoot.canonicalJson);
    if (!otherRootDigest) throw new Error('other trust root was invalid');
    expect(observeLaunch(launchOptions(release, {
      expectedTrustRootCanonicalSha256: otherRootDigest,
      trustRoot: otherRoot.canonicalJson,
    }))).toEqual({
      ok: false,
      reason: 'runtime release evidence signing key is unknown',
    });
  });

  it('rejects same-key envelope and trust-root substitutions before verification', () => {
    const release = fixture();
    const options = launchOptions(release);
    const substitutedEnvelope = signRuntimeReleaseEvidenceEnvelope({
      expiresAt: '2026-07-29T12:11:00.000Z',
      issuedAt: ISSUED_AT,
      manifest: release.manifest,
      privateKey: release.privateKey,
    });
    if (!substitutedEnvelope.ok) throw new Error(substitutedEnvelope.reason);
    expect(observeLaunch({
      ...options,
      envelope: substitutedEnvelope.canonicalJson,
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence envelope identity mismatch',
    });

    const substitutedRoot = buildRuntimeReleaseEvidenceTrustRoot({
      keys: [{
        publicKey: release.publicKey,
        validFrom: '2026-07-29T10:00:00.000Z',
        validUntil: '2026-07-29T14:00:00.000Z',
      }],
    });
    if (!substitutedRoot.ok) throw new Error(substitutedRoot.reason);
    expect(observeLaunch({
      ...options,
      trustRoot: substitutedRoot.canonicalJson,
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence trust root identity mismatch',
    });
  });

  it('rejects dependency symlinks, writable stages, and missing dependency coverage', () => {
    if (process.platform !== 'win32') {
      const linked = fixture();
      chmodTree(linked.packageRoot, false);
      symlinkSync(
        join(linked.dependencyRoot, 'example', 'index.js'),
        join(linked.dependencyRoot, 'linked.js'),
      );
      chmodTree(linked.packageRoot, true);
      expect(observeRuntimeReleaseImmutableStagedTree(stageOptions(linked))).toEqual({
        ok: false,
        reason: 'installed dependency tree contains a symlink',
      });
    }

    const writable = fixture();
    chmodSync(writable.packageRoot, 0o755);
    expect(observeRuntimeReleaseImmutableStagedTree(stageOptions(writable))).toEqual({
      ok: false,
      reason: 'runtime release package root is writable',
    });

    const writableArtifactDirectory = fixture();
    chmodSync(join(writableArtifactDirectory.packageRoot, 'dist'), 0o755);
    expect(observeRuntimeReleaseImmutableStagedTree(
      stageOptions(writableArtifactDirectory),
    )).toEqual({
      ok: false,
      reason: 'runtime release artifact directory is writable',
    });

    if (process.platform !== 'win32') {
      const linkedInode = fixture();
      linkSync(
        join(linkedInode.dependencyRoot, 'example', 'index.js'),
        join(dirname(linkedInode.packageRoot), 'external-dependency-link.js'),
      );
      expect(observeRuntimeReleaseImmutableStagedTree(stageOptions(linkedInode))).toEqual({
        ok: false,
        reason: 'runtime release dependency root has multiple hard links',
      });
    }

    const absent = fixture();
    chmodTree(absent.packageRoot, false);
    rmSync(absent.dependencyRoot, { recursive: true });
    chmodTree(absent.packageRoot, true);
    expect(observeRuntimeReleaseImmutableStagedTree(stageOptions(absent))).toMatchObject({
      ok: false,
    });
  });

  it('fails closed on an unlisted extra dependency directory', () => {
    const release = fixture();
    chmodTree(release.packageRoot, false);
    const overflow = join(release.dependencyRoot, 'overflow');
    mkdirSync(overflow);
    for (let index = 0; index <= 1_024; index += 1) {
      write(join(overflow, `entry-${String(index).padStart(4, '0')}.js`), 'export {};\n');
    }
    chmodTree(release.packageRoot, true);

    expect(observeRuntimeReleaseImmutableStagedTree(stageOptions(release))).toEqual({
      ok: false,
      reason: 'installed dependency package set does not match inventory',
    });
  });

  it('rejects same-content replacement after bounded enumeration and before processing', () => {
    const release = fixture();
    const dependencyDirectory = join(release.dependencyRoot, 'example');
    const dependencyPath = join(dependencyDirectory, 'index.js');
    const displacedPath = join(dirname(release.packageRoot), 'displaced-dependency.js');
    let replaced = false;
    const options = stageOptions(release) as ReturnType<typeof stageOptions> & {
      __testHooks: {
        afterDirectoryEntriesRead: (path: string, label: string) => void;
      };
    };
    options.__testHooks = {
      afterDirectoryEntriesRead: (path, label) => {
        if (replaced || path !== release.dependencyRoot ||
          label !== 'runtime release dependency root') return;
        replaced = true;
        chmodSync(dependencyDirectory, 0o755);
        renameSync(dependencyPath, displacedPath);
        write(dependencyPath, 'export const dependency = true;\n');
        chmodSync(dependencyPath, 0o444);
        chmodSync(dependencyDirectory, 0o555);
      },
    };

    expect(observeRuntimeReleaseImmutableStagedTree(options)).toEqual({
      ok: false,
      reason: 'runtime release dependency root changed before traversal',
    });
    expect(replaced).toBe(true);
  });

  it('expires the launch budget after manifest verification and before artifact traversal', () => {
    const release = fixture();
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterManifestVerification?: () => void };
    };
    let monotonicMs = 0;
    options.__testHooks = {
      afterManifestVerification: () => {
        monotonicMs = 120_001;
      },
    };
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
    try {
      expect(observeLaunch(options)).toEqual({
        ok: false,
        reason: 'runtime release artifact root observation deadline exceeded',
      });
    } finally {
      monotonicNow.mockRestore();
    }
  });

  it('fails closed at the exact deadline after final staged-tree digest construction', () => {
    const release = fixture();
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterStageDigestConstruction?: () => void };
    };
    let digestPasses = 0;
    let monotonicMs = 0;
    options.__testHooks = {
      afterStageDigestConstruction: () => {
        digestPasses += 1;
        if (digestPasses === 2) monotonicMs = 120_000;
      },
    };
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
    try {
      expect(observeLaunch(options)).toEqual({
        ok: false,
        reason: 'runtime release staged tree digest observation deadline exceeded',
      });
      expect(digestPasses).toBe(2);
    } finally {
      monotonicNow.mockRestore();
    }
  });

  it('fails closed at the exact deadline immediately after the second observation', () => {
    const release = fixture();
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterSecondObservation?: () => void };
    };
    let monotonicMs = 0;
    options.__testHooks = {
      afterSecondObservation: () => {
        monotonicMs = 120_000;
      },
    };
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
    try {
      expect(observeLaunch(options)).toEqual({
        ok: false,
        reason: 'runtime release launch inputs observation deadline exceeded',
      });
    } finally {
      monotonicNow.mockRestore();
    }
  });

  it('fails closed at the exact deadline after final receipt construction', () => {
    const release = fixture();
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterLaunchReceiptConstruction?: () => void };
    };
    let monotonicMs = 0;
    options.__testHooks = {
      afterLaunchReceiptConstruction: () => {
        monotonicMs = 120_000;
      },
    };
    const monotonicNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
    try {
      expect(observeLaunch(options)).toEqual({
        ok: false,
        reason: 'runtime release launch receipt observation deadline exceeded',
      });
    } finally {
      monotonicNow.mockRestore();
    }
  });

  it('detects same-content path replacement between final observations', () => {
    const release = fixture();
    const launcher = join(release.packageRoot, 'bin', 'ashlr');
    const bytes = readFileSync(launcher);
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterBeforeObservation?: () => void };
    };
    options.__testHooks = {
      afterBeforeObservation: () => {
        chmodSync(join(release.packageRoot, 'bin'), 0o755);
        unlinkSync(launcher);
        writeFileSync(launcher, bytes, { mode: 0o555 });
        chmodSync(join(release.packageRoot, 'bin'), 0o555);
      },
    };

    expect(observeLaunch(options)).toEqual({
      ok: false,
      reason: 'runtime release staged tree identity changed during launch revalidation',
    });
  });

  it('detects staged-root replacement races and revision path mismatch', () => {
    const release = fixture();
    const options = launchOptions(release) as RuntimeReleaseLaunchObservationOptions & {
      __testHooks?: { afterBeforeObservation?: () => void };
    };
    const original = `${release.packageRoot}-old`;
    options.__testHooks = {
      afterBeforeObservation: () => {
        renameSync(release.packageRoot, original);
        cpSync(original, release.packageRoot, { recursive: true, preserveTimestamps: true });
      },
    };
    expect(observeLaunch(options)).toMatchObject({ ok: false });

    const wrongRevision = fixture();
    expect(observeRuntimeReleaseImmutableStagedTree({
      ...stageOptions(wrongRevision),
      expectedRevision: 'b'.repeat(40),
    })).toEqual({
      ok: false,
      reason: 'runtime release staged path does not match expected revision',
    });
  });

  it('rejects identical signed bytes relocated beneath another revision', () => {
    const release = fixture();
    const relocatedRevision = 'b'.repeat(40);
    const relocatedRoot = join(dirname(release.packageRoot), relocatedRevision);
    renameSync(release.packageRoot, relocatedRoot);

    expect(observeRuntimeReleaseImmutableStagedTree({
      ...stageOptions(release),
      dependencyRoot: join(relocatedRoot, 'node_modules'),
      expectedRevision: relocatedRevision,
      packageRoot: relocatedRoot,
    })).toEqual({
      ok: false,
      reason: 'runtime release manifest revision does not match expected revision',
    });
  });

  it.each(['writable mode', 'hard-link count'] as const)(
    'rejects a %s race between path snapshot and descriptor open',
    (mutation) => {
    const release = fixture();
    const target = join(release.packageRoot, 'package.json');
    let mutated = false;
    const options = stageOptions(release) as ReturnType<typeof stageOptions> & {
      __testHooks?: {
        afterFilePathSnapshotBeforeOpen?: (path: string) => void;
      };
    };
    options.__testHooks = {
      afterFilePathSnapshotBeforeOpen: (path) => {
        if (path !== target || mutated) return;
        mutated = true;
        if (mutation === 'writable mode') chmodSync(path, 0o644);
        else linkSync(path, join(dirname(release.packageRoot), 'race-hard-link'));
      },
    };

    expect(observeRuntimeReleaseImmutableStagedTree(options)).toEqual({
      ok: false,
      reason: 'runtime release artifact changed before read',
    });
    expect(mutated).toBe(true);
    },
  );

  it('requires caller-pinned staged, policy, key, and invocation identities', () => {
    const release = fixture();
    const options = launchOptions(release);
    expect(observeLaunch({
      ...options,
      expectedStagedTreeIdentity: '0'.repeat(64),
    })).toEqual({
      ok: false,
      reason: 'runtime release staged tree identity does not match expected',
    });
    expect(observeLaunch({
      ...options,
      expectedPolicyId: 'bad policy',
    })).toEqual({
      ok: false,
      reason: 'runtime release expected policy id is invalid',
    });
    expect(observeLaunch({
      ...options,
      expectedPolicyId: `sha256:${'0'.repeat(64)}`,
    })).toEqual({
      ok: false,
      reason: 'runtime release launch policy identity mismatch',
    });
    expect(observeLaunch({
      ...options,
      policy: '{\n  "scope": "release-launch",\n  "policyVersion": 1\n}\n',
    })).toEqual({
      ok: false,
      reason: 'runtime release launch policy encoding is not canonical',
    });
    expect(runtimeReleaseServiceInvocationDigest('relative', release.argv)).toBeNull();
    expect(runtimeReleaseEvidenceKeyId(generateKeyPairSync('ed25519').publicKey))
      .not.toBe(release.expectedKeyId);
  });

  it.skipIf(process.platform === 'win32')(
    'ignores a caller platform spoof instead of minting a durability claim',
    () => {
      const release = fixture();
      const spoofed = { ...stageOptions(release), platform: 'win32' };
      const result = observeRuntimeReleaseImmutableStagedTree(spoofed);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.receipt.hostPlatform).toBe(process.platform);
      expect(result.receipt.hostPlatform).not.toBe(spoofed.platform);
      expect(result.receipt.schemaVersion).toBe(2);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'fails closed on a Windows host when directory durability is unavailable',
    () => {
      const release = fixture();
      expect(observeRuntimeReleaseImmutableStagedTree(stageOptions(release))).toEqual({
        ok: false,
        reason: 'runtime release launch revalidation requires available directory durability',
      });
    },
  );
});

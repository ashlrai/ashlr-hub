import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimeReleaseLaunchRevalidationOptions,
  RuntimeReleaseLaunchRevalidationReceiptV1,
} from '../src/core/daemon/runtime-release-launch-revalidation.js';
import type {
  UnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';

const mocks = vi.hoisted(() => ({
  parseManifest: vi.fn(),
  revalidateLaunch: vi.fn(),
}));

vi.mock('../src/core/daemon/runtime-release-launch-revalidation.js', () => ({
  revalidateRuntimeReleaseLaunch: mocks.revalidateLaunch,
}));

vi.mock('../src/core/daemon/runtime-release-manifest.js', () => ({
  parseUnsignedRuntimeReleaseManifest: mocks.parseManifest,
}));

import {
  evaluateRuntimeReleaseLaunchAdmission,
} from '../src/core/daemon/runtime-release-launch-admission.js';

const MANIFEST_DIGEST = 'a'.repeat(64);
const STAGED_TREE_IDENTITY = 'b'.repeat(64);
const RECEIPT = {
  expectedRevision: 'c'.repeat(40),
  release: { manifestDigest: MANIFEST_DIGEST },
  stableIdentity: {
    afterSha256: 'd'.repeat(64),
    beforeSha256: 'd'.repeat(64),
  },
  stagedTreeIdentity: STAGED_TREE_IDENTITY,
} as RuntimeReleaseLaunchRevalidationReceiptV1;

function options(): RuntimeReleaseLaunchRevalidationOptions {
  return {
    argv: ['/release/bin/ashlr', 'daemon', 'start'],
    declaredInterpreterPath: '/release/node',
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot: '/release/node_modules',
    envelope: Buffer.from('signed-envelope'),
    executablePath: '/release/node',
    expectedEnvelopeCanonicalSha256: 'e'.repeat(64),
    expectedKeyId: `ed25519-sha256:${'f'.repeat(64)}`,
    expectedManifestDigest: MANIFEST_DIGEST,
    expectedPolicyId: `sha256:${'1'.repeat(64)}`,
    expectedRevision: 'c'.repeat(40),
    expectedServiceInvocationDigest: '2'.repeat(64),
    expectedStagedTreeIdentity: STAGED_TREE_IDENTITY,
    expectedTrustRootCanonicalSha256: '3'.repeat(64),
    manifest: Buffer.from('manifest'),
    now: '2026-07-29T12:05:00.000Z',
    packageRoot: '/release',
    policy: Buffer.from('policy'),
    trustRoot: Buffer.from('trust-root'),
  };
}

function manifest(targetManifestDigest: string | null): UnsignedRuntimeReleaseManifest {
  return {
    manifestDigest: MANIFEST_DIGEST,
    rollbackDeclaration: {
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest,
    },
  } as UnsignedRuntimeReleaseManifest;
}

function successfulRevalidation(): void {
  mocks.revalidateLaunch.mockReturnValue({
    ok: true,
    canonicalJson: '{"receipt":"canonical"}\n',
    receipt: RECEIPT,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runtime release launch admission', () => {
  it('revalidates pinned inputs and explicitly refuses an unresolved rollback', () => {
    successfulRevalidation();
    mocks.parseManifest.mockReturnValue({
      ok: true,
      canonicalJson: '{}\n',
      manifest: manifest(null),
    });
    const input = options();

    const decision = evaluateRuntimeReleaseLaunchAdmission(input);

    expect(decision).toMatchObject({
      authority: 'observation-only',
      verdict: 'blocked',
      admissionPermitted: false,
      deployPermitted: false,
      installPermitted: false,
      launchPermitted: false,
      rollbackPermitted: false,
      startPermitted: false,
      blocker: {
        code: 'rollback-unresolved',
        detail: 'The signed release has no resolved rollback target.',
      },
      evidence: {
        callerPinnedEnvelope: 'canonical-digest-and-key-id',
        contentAddressedRelease: 'caller-pinned-staged-tree-identity',
        launchRevalidation: 'passed',
        manifestDigest: MANIFEST_DIGEST,
        secondByteIdentityObservation: 'before-after-equal',
        stagedTreeIdentity: STAGED_TREE_IDENTITY,
      },
      rollback: {
        resolution: 'unresolved',
        source: 'caller-declared',
        targetManifestDigest: null,
      },
      schemaVersion: 1,
    });
    expect(decision.evidence.launchRevalidationReceiptSha256)
      .toMatch(/^[a-f0-9]{64}$/);

    const pinned = mocks.revalidateLaunch.mock.calls[0]![0] as
      RuntimeReleaseLaunchRevalidationOptions;
    expect(pinned.argv).toEqual(input.argv);
    expect(pinned.argv).not.toBe(input.argv);
    for (const field of ['envelope', 'manifest', 'policy', 'trustRoot'] as const) {
      expect(pinned[field]).toEqual(input[field]);
      expect(pinned[field]).not.toBe(input[field]);
    }
    expect(mocks.parseManifest).toHaveBeenCalledWith(pinned.manifest);
  });

  it('does not treat a caller-declared rollback digest as resolved', () => {
    successfulRevalidation();
    const target = '4'.repeat(64);
    mocks.parseManifest.mockReturnValue({
      ok: true,
      canonicalJson: '{}\n',
      manifest: manifest(target),
    });

    const decision = evaluateRuntimeReleaseLaunchAdmission(options());

    expect(decision.blocker).toEqual({
      code: 'rollback-unresolved',
      detail: 'The signed release names a rollback target but does not validate or resolve it.',
    });
    expect(decision.rollback).toEqual({
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: target,
    });
    expect(decision.admissionPermitted).toBe(false);
    expect(decision.installPermitted).toBe(false);
    expect(decision.startPermitted).toBe(false);
  });

  it('fails closed before rollback inspection when launch revalidation fails', () => {
    mocks.revalidateLaunch.mockReturnValue({
      ok: false,
      reason: 'runtime release evidence envelope identity mismatch',
    });

    const decision = evaluateRuntimeReleaseLaunchAdmission(options());

    expect(decision).toMatchObject({
      blocker: {
        code: 'launch-revalidation-failed',
        detail: 'runtime release evidence envelope identity mismatch',
      },
      evidence: {
        launchRevalidation: 'failed',
        launchRevalidationReceiptSha256: null,
        manifestDigest: null,
        secondByteIdentityObservation: 'not-completed',
        stagedTreeIdentity: null,
      },
      rollback: {
        resolution: 'unobserved',
        source: 'unobserved',
        targetManifestDigest: null,
      },
      admissionPermitted: false,
      deployPermitted: false,
      installPermitted: false,
      launchPermitted: false,
      rollbackPermitted: false,
      startPermitted: false,
    });
    expect(mocks.parseManifest).not.toHaveBeenCalled();
  });

  it('withholds authority when a successful receipt is incoherent with the manifest', () => {
    successfulRevalidation();
    mocks.parseManifest.mockReturnValue({
      ok: true,
      canonicalJson: '{}\n',
      manifest: {
        ...manifest(null),
        manifestDigest: '5'.repeat(64),
      },
    });

    const decision = evaluateRuntimeReleaseLaunchAdmission(options());

    expect(decision.blocker).toEqual({
      code: 'release-manifest-incoherent',
      detail: 'Revalidated release receipt does not match the pinned manifest.',
    });
    expect(decision.evidence.launchRevalidation).toBe('passed');
    expect(decision.rollback.resolution).toBe('unobserved');
    expect(decision.installPermitted).toBe(false);
    expect(decision.startPermitted).toBe(false);
  });
});

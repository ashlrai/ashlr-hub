import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RuntimeReleaseLaunchObservationOptions,
  RuntimeReleaseLaunchObservationReceiptV2,
} from '../src/core/daemon/runtime-release-launch-revalidation.js';
import type {
  UnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';

const mocks = vi.hoisted(() => ({
  observeLaunch: vi.fn(),
  parseManifest: vi.fn(),
}));

vi.mock('../src/core/daemon/runtime-release-launch-revalidation.js', () => ({
  observeRuntimeReleaseLaunchInputs: mocks.observeLaunch,
}));

vi.mock('../src/core/daemon/runtime-release-manifest.js', () => ({
  parseUnsignedRuntimeReleaseManifest: mocks.parseManifest,
}));

import {
  evaluateRuntimeReleaseLaunchAdmission,
} from '../src/core/daemon/runtime-release-launch-admission.js';

const MANIFEST_DIGEST = 'a'.repeat(64);
const STAGED_TREE_IDENTITY = 'b'.repeat(64);
const REVISION = 'c'.repeat(40);
const PERMANENT_BLOCKERS = [
  'atomic-launch-handoff-absent',
  'durable-replay-consumption-absent',
  'rollback-unresolved',
  'revision-provenance-unresolved',
  'trusted-activation-root-absent',
  'trusted-policy-authority-absent',
];
const RECEIPT = {
  assurance: 'closed-byte-observation-only',
  expectedRevision: REVISION,
  release: {
    expectedRevision: REVISION,
    manifestDigest: MANIFEST_DIGEST,
    rollbackTargetManifestDigest: null,
  },
  stableIdentity: {
    afterSha256: 'd'.repeat(64),
    beforeSha256: 'd'.repeat(64),
  },
  stagedTreeIdentity: STAGED_TREE_IDENTITY,
} as RuntimeReleaseLaunchObservationReceiptV2;

function options(): RuntimeReleaseLaunchObservationOptions {
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
    expectedRevision: REVISION,
    expectedServiceInvocationDigest: '2'.repeat(64),
    expectedStagedTreeIdentity: STAGED_TREE_IDENTITY,
    expectedTrustRootCanonicalSha256: '3'.repeat(64),
    manifest: Buffer.from('manifest'),
    packageRoot: '/release',
    policy: Buffer.from('policy'),
    trustRoot: Buffer.from('trust-root'),
  };
}

function manifest(targetManifestDigest: string | null): UnsignedRuntimeReleaseManifest {
  return {
    manifestDigest: MANIFEST_DIGEST,
    expectedRevision: REVISION,
    rollbackDeclaration: {
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest,
    },
  } as UnsignedRuntimeReleaseManifest;
}

function successfulObservation(targetManifestDigest: string | null = null): void {
  mocks.observeLaunch.mockReturnValue({
    ok: true,
    canonicalJson: '{"receipt":"canonical"}\n',
    receipt: {
      ...RECEIPT,
      release: {
        ...RECEIPT.release,
        rollbackTargetManifestDigest: targetManifestDigest,
      },
    },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runtime release launch admission', () => {
  it('enumerates every missing authority primitive after a closed observation', () => {
    successfulObservation();
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
      evidence: {
        atomicLaunchHandoff: 'absent-descriptors-closed',
        closedByteIdentityObservation: 'before-after-equal',
        launchConsumer: 'absent',
        launchObservation: 'passed-closed-observation-only',
        manifestDigest: MANIFEST_DIGEST,
        mutationAfterObservation: 'not-prevented',
        replayPrevention: 'absent-no-durable-consumption-store',
        revisionBinding: 'manifest-and-envelope-bound-declaration-only',
        stagedTreeIdentity: STAGED_TREE_IDENTITY,
      },
      rollback: {
        resolution: 'unresolved',
        source: 'caller-declared',
        targetManifestDigest: null,
      },
      schemaVersion: 2,
    });
    expect(decision.blockers.map(({ code }) => code)).toEqual(PERMANENT_BLOCKERS);
    expect(decision.evidence.launchObservationReceiptSha256)
      .toMatch(/^[a-f0-9]{64}$/);

    const pinned = mocks.observeLaunch.mock.calls[0]![0] as
      RuntimeReleaseLaunchObservationOptions;
    expect(pinned.argv).toEqual(input.argv);
    expect(pinned.argv).not.toBe(input.argv);
    for (const field of ['envelope', 'manifest', 'policy', 'trustRoot'] as const) {
      expect(pinned[field]).toEqual(input[field]);
      expect(pinned[field]).not.toBe(input[field]);
    }
    expect(mocks.parseManifest).toHaveBeenCalledWith(pinned.manifest);
  });

  it('does not treat a caller-declared rollback digest as resolved', () => {
    const target = '4'.repeat(64);
    successfulObservation(target);
    mocks.parseManifest.mockReturnValue({
      ok: true,
      canonicalJson: '{}\n',
      manifest: manifest(target),
    });

    const decision = evaluateRuntimeReleaseLaunchAdmission(options());

    expect(decision.blockers.find(({ code }) => code === 'rollback-unresolved')).toEqual({
      code: 'rollback-unresolved',
      detail: 'The signed release names a rollback target but does not validate or resolve it.',
    });
    expect(decision.rollback).toEqual({
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: target,
    });
    expect(decision.admissionPermitted).toBe(false);
  });

  it('retains permanent blockers when the closed observation fails', () => {
    mocks.observeLaunch.mockReturnValue({
      ok: false,
      reason: 'runtime release evidence envelope identity mismatch',
    });

    const decision = evaluateRuntimeReleaseLaunchAdmission(options());

    expect(decision.blockers.map(({ code }) => code)).toEqual([
      'launch-observation-failed',
      ...PERMANENT_BLOCKERS,
    ]);
    expect(decision.evidence).toMatchObject({
      launchObservation: 'failed',
      launchObservationReceiptSha256: null,
      closedByteIdentityObservation: 'not-completed',
      mutationAfterObservation: 'not-prevented',
    });
    expect(decision.rollback.resolution).toBe('unobserved');
    expect(decision.launchPermitted).toBe(false);
    expect(mocks.parseManifest).not.toHaveBeenCalled();
  });

  it('adds manifest incoherence without hiding permanent authority gaps', () => {
    successfulObservation();
    mocks.parseManifest.mockReturnValue({
      ok: true,
      canonicalJson: '{}\n',
      manifest: { ...manifest(null), manifestDigest: '5'.repeat(64) },
    });

    const decision = evaluateRuntimeReleaseLaunchAdmission(options());

    expect(decision.blockers.map(({ code }) => code)).toEqual([
      'release-manifest-incoherent',
      ...PERMANENT_BLOCKERS,
    ]);
    expect(decision.blockers[0]?.detail)
      .toBe('Closed release observation does not match the pinned manifest.');
    expect(decision.evidence.launchObservation).toBe('passed-closed-observation-only');
    expect(decision.rollback.resolution).toBe('unobserved');
    expect(decision.startPermitted).toBe(false);
  });
});

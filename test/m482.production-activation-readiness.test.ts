import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectArtifactPackaging,
  inspectProductionActivationReadinessV1,
  type ProductionActivationReadinessDependenciesV1,
  type ProductionArtifactPackagingObservationV1,
} from '../src/core/daemon/production-activation-readiness.js';
import type { DaemonActivationReadiness } from '../src/core/daemon/activation-permit.js';
import type { ReleaseTipSettlementReadResult } from '../src/core/daemon/release-current-tip-store.js';
import type { ResidentServiceDiagnostic } from '../src/core/daemon/resident-service-readiness.js';
import type { RuntimeReleaseLaunchAdmissionDecision } from '../src/core/daemon/runtime-release-launch-admission.js';
import type { RuntimeReleaseLaunchObservationOptions } from '../src/core/daemon/runtime-release-launch-revalidation.js';
import type { UnsignedRuntimeReleaseManifest } from '../src/core/daemon/runtime-release-manifest.js';
import type { AshlrConfig } from '../src/core/types.js';

const MANIFEST_DIGEST = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);
const roots: string[] = [];

const compatiblePackaging: ProductionArtifactPackagingObservationV1 = {
  state: 'compatible',
  packageManifestPresent: true,
  sourceLockfilePresent: true,
  publishableLockfilePresent: true,
  installedDependencyTreePresent: true,
  packedLockfileEvidence: 'present',
  packedDependencyEvidence: 'complete',
  reason: 'fixture packaging evidence is complete',
};

function launchInput(): RuntimeReleaseLaunchObservationOptions {
  return {
    argv: ['/release/bin/ashlr', 'daemon', 'start'],
    declaredInterpreterPath: '/release/node',
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot: '/release/node_modules',
    envelope: Buffer.from('envelope'),
    executablePath: '/release/node',
    expectedEnvelopeCanonicalSha256: 'c'.repeat(64),
    expectedKeyId: `ed25519-sha256:${'d'.repeat(64)}`,
    expectedManifestDigest: MANIFEST_DIGEST,
    expectedPolicyId: `sha256:${'e'.repeat(64)}`,
    expectedRevision: REVISION,
    expectedServiceInvocationDigest: 'f'.repeat(64),
    expectedStagedTreeIdentity: '1'.repeat(64),
    expectedTrustRootCanonicalSha256: '2'.repeat(64),
    manifest: Buffer.from('manifest'),
    packageRoot: '/release',
    policy: Buffer.from('policy'),
    trustRoot: Buffer.from('trust-root'),
  };
}

function manifest(): UnsignedRuntimeReleaseManifest {
  return {
    manifestDigest: MANIFEST_DIGEST,
    expectedRevision: REVISION,
    rollbackDeclaration: {
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: null,
    },
  } as UnsignedRuntimeReleaseManifest;
}

function launchDecision(
  code = 'atomic-launch-handoff-absent',
  detail = 'atomic launch handoff is absent',
): RuntimeReleaseLaunchAdmissionDecision {
  return {
    schemaVersion: 2,
    authority: 'observation-only',
    verdict: 'blocked',
    admissionPermitted: false,
    deployPermitted: false,
    installPermitted: false,
    launchPermitted: false,
    rollbackPermitted: false,
    startPermitted: false,
    blockers: [{ code, detail }] as RuntimeReleaseLaunchAdmissionDecision['blockers'],
    evidence: {
      atomicLaunchHandoff: 'absent-descriptors-closed',
      callerPinnedEnvelope: 'canonical-digest-and-key-id',
      closedByteIdentityObservation: 'not-completed',
      contentAddressedRelease: 'caller-pinned-staged-tree-identity',
      launchConsumer: 'absent',
      launchObservation: 'failed',
      launchObservationReceiptSha256: null,
      manifestDigest: null,
      mutationAfterObservation: 'not-prevented',
      policyAuthority: 'caller-pinned-unsigned',
      replayPrevention: 'absent-no-durable-consumption-store',
      revisionBinding: 'unobserved',
      stagedTreeIdentity: null,
      trustRootAuthority: 'caller-provided-not-activation-root',
    },
    rollback: { resolution: 'unobserved', source: 'unobserved', targetManifestDigest: null },
  };
}

function activation(state: 'ready' | 'blocked' | 'degraded' = 'blocked'): DaemonActivationReadiness {
  return {
    schemaVersion: 1,
    policyVersion: 'm461-proposal-once-v1',
    authority: 'observation-only',
    sourceState: state === 'degraded' ? 'degraded' : 'healthy',
    state,
    commandEligible: state === 'ready',
    requestedShape: 'proposal-once',
    trustRootCount: state === 'ready' ? 1 : 0,
    residentAuthorized: false,
    installAuthorized: false,
    repairAuthorized: false,
    reason: state === 'ready' ? 'valid-proposal-once-permit' : 'no-trusted-activation-roots',
  };
}

function resident(): ResidentServiceDiagnostic {
  return {
    schemaVersion: 5,
    scope: 'observation-only-diagnostic',
    diagnosticStatus: 'blocked',
    lifecycleAuthority: 'none',
    operationalAuthority: false,
    serviceLabel: 'ai.ashlr.daemon',
    declaredReleaseIdentity: REVISION,
    localChecks: {} as ResidentServiceDiagnostic['localChecks'],
    findings: [],
  };
}

function releaseTip(): ReleaseTipSettlementReadResult {
  return {
    settlements: [],
    currentTip: null,
    sourceState: 'healthy',
    availability: 'available',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesRead: 1,
    bytesRead: 100,
    invalidFiles: 0,
    limitExceeded: false,
    authority: 'observation-only',
    sameUserTamperResistant: false,
    transparencyAuthority: false,
    rollbackProtected: false,
    currentTipAuthority: false,
    continuityAuthority: false,
    durableCompareAndSwapVerified: false,
    bootstrapContinuityVerified: false,
    releaseAuthority: false,
    mergePermitted: false,
    deployPermitted: false,
    installPermitted: false,
    startPermitted: false,
    activationPermitted: false,
    rollbackPermitted: false,
  };
}

function dependencies(
  overrides: Partial<ProductionActivationReadinessDependenciesV1> = {},
): ProductionActivationReadinessDependenciesV1 {
  return {
    inspectArtifactPackaging: vi.fn(() => compatiblePackaging),
    parseManifest: vi.fn(() => ({ ok: true, manifest: manifest(), canonicalJson: '{}\n' })),
    verifyReleaseEvidence: vi.fn(() => ({
      ok: true,
      assurance: 'signed-observation-only',
      expiresAt: '2026-08-03T01:00:00.000Z',
      issuedAt: '2026-08-03T00:00:00.000Z',
      keyId: `ed25519-sha256:${'d'.repeat(64)}`,
      manifestDigest: MANIFEST_DIGEST,
      expectedRevision: REVISION,
      rollbackTargetManifestDigest: null,
      verifiedAtMs: 1,
    })),
    evaluateLaunchAdmission: vi.fn(() => launchDecision()),
    inspectResidentService: vi.fn(() => resident()),
    inspectActivation: vi.fn(() => activation()),
    readReleaseTip: vi.fn(() => releaseTip()),
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Production Activation Readiness V1', () => {
  it('reports the npm packaging incompatibility before any authority claim', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-production-packaging-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/hub', files: ['dist', 'bin'] }));
    writeFileSync(join(root, 'package-lock.json'), '{}\n');
    mkdirSync(join(root, 'node_modules'));

    const packaging = inspectArtifactPackaging(root);
    const report = inspectProductionActivationReadinessV1({ packageRoot: root }, dependencies({
      inspectArtifactPackaging: () => packaging,
    }));

    expect(packaging).toMatchObject({
      state: 'incompatible',
      sourceLockfilePresent: true,
      installedDependencyTreePresent: true,
      packedLockfileEvidence: 'missing',
      packedDependencyEvidence: 'missing',
    });
    expect(report.topBlocker.code).toBe('artifact-packaging-incompatible');
    expect(report.topBlocker.detail).toContain('npm published artifacts exclude package-lock.json');
    expect(Object.values(report.authorityFlags).every((value) => value === false)).toBe(true);
  });

  it('fails closed when a caller-rooted release signature is forged', () => {
    const deps = dependencies({
      verifyReleaseEvidence: vi.fn(() => ({ ok: false, reason: 'runtime release evidence signature invalid' })),
    });

    const report = inspectProductionActivationReadinessV1({
      config: {} as AshlrConfig,
      launchObservation: launchInput(),
      residentService: {} as never,
    }, deps);

    expect(report.topBlocker).toMatchObject({ code: 'release-evidence-invalid', source: 'release' });
    expect(report.observations.releaseEvidence).toEqual({
      state: 'invalid',
      keyId: null,
      reason: 'runtime release evidence signature invalid',
    });
    expect(report.verdict).toBe('blocked');
    expect(report.authorityFlags.activationPermitted).toBe(false);
  });

  it('preserves replacement detection from closed launch revalidation', () => {
    const report = inspectProductionActivationReadinessV1({
      config: {} as AshlrConfig,
      launchObservation: launchInput(),
      releaseScopeDigest: MANIFEST_DIGEST,
      residentService: {} as never,
    }, dependencies({
      evaluateLaunchAdmission: vi.fn(() => launchDecision(
        'launch-observation-failed',
        'runtime release staged tree identity changed during launch revalidation',
      )),
    }));

    expect(report.topBlocker.code).toBe('launch-admission-blocked');
    expect(report.observations.launchAdmission).toMatchObject({
      state: 'observed-blocked',
      blockerCodes: ['launch-observation-failed'],
    });
    expect(report.observations.launchAdmission.reason).toContain('identity changed');
    expect(Object.values(report.authorityFlags)).toEqual(expect.not.arrayContaining([true]));
  });

  it('does not promote optimistic advisory inputs into lifecycle authority', () => {
    const report = inspectProductionActivationReadinessV1({
      config: {} as AshlrConfig,
      launchObservation: launchInput(),
      releaseScopeDigest: MANIFEST_DIGEST,
      residentService: {} as never,
    }, dependencies({ inspectActivation: vi.fn(() => activation('ready')) }));

    expect(report.observations.activationPermit).toMatchObject({
      state: 'blocked',
      trustRootCount: 1,
    });
    expect(report.observations.releaseTip.state).toBe('observed-untrusted');
    expect(report.blockers.map(({ code }) => code)).toContain('production-authority-chain-absent');
    expect(report.verdict).toBe('blocked');
    expect(Object.values(report.authorityFlags).every((value) => value === false)).toBe(true);
  });

  it('reports missing inputs without invoking unavailable observers', () => {
    const deps = dependencies();
    const report = inspectProductionActivationReadinessV1({}, deps);

    expect(report.topBlocker.code).toBe('release-manifest-unavailable');
    expect(deps.parseManifest).not.toHaveBeenCalled();
    expect(deps.verifyReleaseEvidence).not.toHaveBeenCalled();
    expect(deps.evaluateLaunchAdmission).not.toHaveBeenCalled();
    expect(deps.inspectResidentService).not.toHaveBeenCalled();
    expect(deps.inspectActivation).not.toHaveBeenCalled();
    expect(deps.readReleaseTip).not.toHaveBeenCalled();
    expect(report.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
  });

  it('has a static read-only import and call boundary', () => {
    const source = readFileSync(
      new URL('../src/core/daemon/production-activation-readiness.ts', import.meta.url),
      'utf8',
    );
    const forbidden = [
      "from './service.js'",
      'ensureRunning(',
      'install(',
      'consumeDaemonActivationPermit(',
      'consumeDaemonActivationPermitForVerification(',
      'recordReleaseTipSettlement(',
      'bootstrapReleaseTipSettlement(',
      'createReleaseTipSettlement(',
    ];
    for (const token of forbidden) expect(source).not.toContain(token);
    expect(source).toContain('inspectDaemonActivationPermit');
    expect(source).toContain('readReleaseTipSettlements');
    expect(source).toContain('observeResidentServiceDiagnostic');
    expect(source).toContain('evaluateRuntimeReleaseLaunchAdmission');
  });
});

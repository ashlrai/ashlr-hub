/**
 * Mutation-free production activation readiness composition.
 *
 * Inputs are bounded observations, not authority callbacks. Every policy and
 * lifecycle flag remains false regardless of caller-provided evidence.
 */

import {
  observeProductionActivationPolicyV1,
  observeProductionArtifactPackagingV1,
  projectReleaseTipObservationV1,
  projectResidentServiceDiagnosticV1,
  type ProductionActivationPolicyObservationV1,
  type ProductionArtifactPackagingObservationV1,
  type ProductionObservationSourceStateV1,
  type ProductionReleaseTipObservationV1,
  type ProductionResidentServiceObservationV1,
  type ReleaseTipProjectionInputV1,
  type ResidentServiceDiagnosticProjectionInputV1,
} from './production-activation-observations.js';
import { verifyRuntimeReleaseEvidenceEnvelope } from './runtime-release-evidence-envelope.js';
import { evaluateRuntimeReleaseLaunchAdmission } from './runtime-release-launch-admission.js';
import type { RuntimeReleaseLaunchObservationOptions } from './runtime-release-launch-revalidation.js';
import { parseUnsignedRuntimeReleaseManifest } from './runtime-release-manifest.js';

export const PRODUCTION_ACTIVATION_READINESS_SCHEMA_VERSION = 1 as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const KEY_ID_RE = /^ed25519-sha256:[a-f0-9]{64}$/;
const LAUNCH_BLOCKER_CODES = new Set([
  'launch-observation-failed',
  'release-manifest-incoherent',
  'atomic-launch-handoff-absent',
  'durable-replay-consumption-absent',
  'rollback-unresolved',
  'revision-provenance-unresolved',
  'trusted-activation-root-absent',
  'trusted-policy-authority-absent',
]);

export type ProductionActivationReadinessBlockerCodeV1 =
  | 'artifact-packaging-incompatible'
  | 'artifact-packaging-unavailable'
  | 'release-manifest-unavailable'
  | 'release-manifest-invalid'
  | 'release-evidence-unavailable'
  | 'release-evidence-invalid'
  | 'launch-admission-unavailable'
  | 'launch-admission-blocked'
  | 'resident-service-diagnostic-unavailable'
  | 'resident-service-diagnostic-blocked'
  | 'activation-inspection-unavailable'
  | 'activation-permit-blocked'
  | 'release-tip-unavailable'
  | 'release-tip-untrusted'
  | 'production-authority-chain-absent';

export interface ProductionActivationReadinessBlockerV1 {
  code: ProductionActivationReadinessBlockerCodeV1;
  detail: string;
  source: 'artifact' | 'release' | 'launch' | 'service' | 'activation' | 'rollback';
}

interface SourceObservationV1 {
  sourceState: ProductionObservationSourceStateV1;
  complete: boolean;
  reasonCode: string;
}

export interface ProductionActivationReadinessV1 {
  schemaVersion: typeof PRODUCTION_ACTIVATION_READINESS_SCHEMA_VERSION;
  authority: 'observation-only';
  verdict: 'blocked';
  topBlocker: ProductionActivationReadinessBlockerV1;
  blockers: ProductionActivationReadinessBlockerV1[];
  authorityFlags: {
    admissionPermitted: false;
    activationPermitted: false;
    deployPermitted: false;
    installPermitted: false;
    launchPermitted: false;
    lifecycleMutationPermitted: false;
    releaseSettlementPermitted: false;
    rollbackPermitted: false;
    startPermitted: false;
  };
  sourceQuality: {
    sourceState: 'healthy' | 'degraded';
    complete: boolean;
    reasons: string[];
  };
  observations: {
    artifactPackaging: ProductionArtifactPackagingObservationV1;
    releaseManifest: SourceObservationV1 & {
      state: 'observed' | 'invalid' | 'unavailable';
      manifestDigest: string | null;
    };
    releaseEvidence: SourceObservationV1 & {
      state: 'verified-observation-only' | 'invalid' | 'unavailable';
      keyId: string | null;
    };
    launchAdmission: SourceObservationV1 & {
      state: 'observed-blocked' | 'unavailable';
      blockerCodes: string[];
    };
    residentService: ProductionResidentServiceObservationV1;
    activationPermit: ProductionActivationPolicyObservationV1;
    releaseTip: ProductionReleaseTipObservationV1;
  };
}

export interface InspectProductionActivationReadinessInputV1 {
  launchObservation?: RuntimeReleaseLaunchObservationOptions;
  packageRoot?: string;
  releaseTipObservation?: ReleaseTipProjectionInputV1;
  residentServiceDiagnostic?: ResidentServiceDiagnosticProjectionInputV1;
}

const AUTHORITY_FLAGS = Object.freeze({
  admissionPermitted: false as const,
  activationPermitted: false as const,
  deployPermitted: false as const,
  installPermitted: false as const,
  launchPermitted: false as const,
  lifecycleMutationPermitted: false as const,
  releaseSettlementPermitted: false as const,
  rollbackPermitted: false as const,
  startPermitted: false as const,
});

const BLOCKER_DETAILS: Readonly<Record<ProductionActivationReadinessBlockerCodeV1, string>> = {
  'artifact-packaging-incompatible': 'The observed runtime tree lacks required lockfile or installed dependency evidence.',
  'artifact-packaging-unavailable': 'Runtime artifact packaging evidence is unavailable or incomplete.',
  'release-manifest-unavailable': 'Runtime release manifest evidence is unavailable.',
  'release-manifest-invalid': 'Runtime release manifest evidence is invalid.',
  'release-evidence-unavailable': 'Signed runtime release evidence is unavailable.',
  'release-evidence-invalid': 'Signed runtime release evidence is invalid.',
  'launch-admission-unavailable': 'Closed launch admission evidence is unavailable.',
  'launch-admission-blocked': 'Closed launch admission remains observation-only and blocked.',
  'resident-service-diagnostic-unavailable': 'Resident service diagnostic evidence is unavailable.',
  'resident-service-diagnostic-blocked': 'Resident service diagnostic remains observation-only and blocked.',
  'activation-inspection-unavailable': 'Activation permit inspection is unavailable without loading mutation capability.',
  'activation-permit-blocked': 'Production activation authority is blocked by immutable trust-root policy.',
  'release-tip-unavailable': 'Release-tip continuity evidence is unavailable.',
  'release-tip-untrusted': 'Host-local release-tip continuity is not rollback or activation authority.',
  'production-authority-chain-absent': 'Trusted release, policy, replay, rollback, atomic launch, and post-start authority are not connected to a lifecycle consumer.',
};

function blocker(
  code: ProductionActivationReadinessBlockerCodeV1,
  source: ProductionActivationReadinessBlockerV1['source'],
): ProductionActivationReadinessBlockerV1 {
  return { code, source, detail: BLOCKER_DETAILS[code] };
}

function safeCodes(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string'
      && LAUNCH_BLOCKER_CODES.has(value))
    .slice(0, 32))];
}

function unavailableSource(reasonCode: string): SourceObservationV1 {
  return { sourceState: 'missing', complete: false, reasonCode };
}

/** Compose production observations without importing or acquiring mutation capability. */
export function inspectProductionActivationReadinessV1(
  input: InspectProductionActivationReadinessInputV1 = {},
): ProductionActivationReadinessV1 {
  const blockers: ProductionActivationReadinessBlockerV1[] = [];
  const artifactPackaging = observeProductionArtifactPackagingV1(input.packageRoot);
  if (artifactPackaging.state !== 'requirements-present') {
    blockers.push(blocker(
      artifactPackaging.state === 'requirements-missing'
        ? 'artifact-packaging-incompatible'
        : 'artifact-packaging-unavailable',
      'artifact',
    ));
  }

  let releaseManifest: ProductionActivationReadinessV1['observations']['releaseManifest'] = {
    ...unavailableSource('manifest-unavailable'),
    state: 'unavailable',
    manifestDigest: null,
  };
  let releaseEvidence: ProductionActivationReadinessV1['observations']['releaseEvidence'] = {
    ...unavailableSource('release-evidence-unavailable'),
    state: 'unavailable',
    keyId: null,
  };
  let launchAdmission: ProductionActivationReadinessV1['observations']['launchAdmission'] = {
    ...unavailableSource('launch-admission-unavailable'),
    state: 'unavailable',
    blockerCodes: [],
  };

  if (input.launchObservation) {
    try {
      const parsed = parseUnsignedRuntimeReleaseManifest(input.launchObservation.manifest);
      releaseManifest = parsed.ok && SHA256_RE.test(parsed.manifest.manifestDigest)
        ? {
          sourceState: 'healthy',
          complete: true,
          reasonCode: 'manifest-observed',
          state: 'observed',
          manifestDigest: parsed.manifest.manifestDigest,
        }
        : {
          sourceState: 'degraded',
          complete: false,
          reasonCode: 'manifest-invalid',
          state: 'invalid',
          manifestDigest: null,
        };
    } catch {
      releaseManifest = {
        sourceState: 'degraded',
        complete: false,
        reasonCode: 'manifest-inspection-failed',
        state: 'invalid',
        manifestDigest: null,
      };
    }
    try {
      const verified = verifyRuntimeReleaseEvidenceEnvelope({
        envelope: input.launchObservation.envelope,
        manifest: input.launchObservation.manifest,
        trustRoot: input.launchObservation.trustRoot,
      });
      releaseEvidence = verified.ok && KEY_ID_RE.test(verified.keyId)
        ? {
          sourceState: 'healthy',
          complete: true,
          reasonCode: 'release-evidence-observed',
          state: 'verified-observation-only',
          keyId: verified.keyId,
        }
        : {
          sourceState: 'degraded',
          complete: false,
          reasonCode: 'release-evidence-invalid',
          state: 'invalid',
          keyId: null,
        };
    } catch {
      releaseEvidence = {
        sourceState: 'degraded',
        complete: false,
        reasonCode: 'release-evidence-inspection-failed',
        state: 'invalid',
        keyId: null,
      };
    }
    try {
      const decision = evaluateRuntimeReleaseLaunchAdmission(input.launchObservation);
      launchAdmission = {
        sourceState: 'healthy',
        complete: true,
        reasonCode: 'launch-admission-observed',
        state: 'observed-blocked',
        blockerCodes: safeCodes(decision.blockers.map(({ code }) => code)),
      };
    } catch {
      launchAdmission = {
        sourceState: 'degraded',
        complete: false,
        reasonCode: 'launch-admission-inspection-failed',
        state: 'unavailable',
        blockerCodes: [],
      };
    }
  }

  if (releaseManifest.state !== 'observed') {
    blockers.push(blocker(
      releaseManifest.state === 'invalid' ? 'release-manifest-invalid' : 'release-manifest-unavailable',
      'release',
    ));
  }
  if (releaseEvidence.state !== 'verified-observation-only') {
    blockers.push(blocker(
      releaseEvidence.state === 'invalid' ? 'release-evidence-invalid' : 'release-evidence-unavailable',
      'release',
    ));
  }
  blockers.push(blocker(
    launchAdmission.state === 'observed-blocked'
      ? 'launch-admission-blocked'
      : 'launch-admission-unavailable',
    'launch',
  ));

  const residentService = projectResidentServiceDiagnosticV1(input.residentServiceDiagnostic);
  blockers.push(blocker(
    residentService.state === 'observed-blocked'
      ? 'resident-service-diagnostic-blocked'
      : 'resident-service-diagnostic-unavailable',
    'service',
  ));

  const activationPermit = observeProductionActivationPolicyV1();
  blockers.push(blocker(
    activationPermit.state === 'blocked'
      ? 'activation-permit-blocked'
      : 'activation-inspection-unavailable',
    'activation',
  ));

  const releaseTip = projectReleaseTipObservationV1(input.releaseTipObservation);
  blockers.push(blocker(
    releaseTip.state === 'observed-untrusted'
      ? 'release-tip-untrusted'
      : 'release-tip-unavailable',
    'rollback',
  ));
  blockers.push(blocker('production-authority-chain-absent', 'activation'));

  const sourceObservations: Array<[string, SourceObservationV1]> = [
    ['artifact-packaging', artifactPackaging],
    ['release-manifest', releaseManifest],
    ['release-evidence', releaseEvidence],
    ['launch-admission', launchAdmission],
    ['resident-service', residentService],
    ['activation-permit', activationPermit],
    ['release-tip', releaseTip],
  ];
  const incompleteSources = sourceObservations
    .filter(([, observation]) => !observation.complete || observation.sourceState !== 'healthy')
    .map(([name]) => name);

  return {
    schemaVersion: PRODUCTION_ACTIVATION_READINESS_SCHEMA_VERSION,
    authority: 'observation-only',
    verdict: 'blocked',
    topBlocker: blockers[0]!,
    blockers,
    authorityFlags: { ...AUTHORITY_FLAGS },
    sourceQuality: {
      sourceState: incompleteSources.length === 0 ? 'healthy' : 'degraded',
      complete: incompleteSources.length === 0,
      reasons: incompleteSources,
    },
    observations: {
      artifactPackaging,
      releaseManifest,
      releaseEvidence,
      launchAdmission,
      residentService,
      activationPermit,
      releaseTip,
    },
  };
}

export type {
  ProductionArtifactPackagingObservationV1,
  ProductionReleaseTipObservationV1,
  ProductionResidentServiceObservationV1,
  ReleaseTipProjectionInputV1,
  ResidentServiceDiagnosticProjectionInputV1,
} from './production-activation-observations.js';

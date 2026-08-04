/**
 * Mutation-free production activation readiness composition.
 *
 * Inputs are bounded observations, not authority callbacks. Every policy and
 * lifecycle flag remains false regardless of caller-provided evidence.
 */

import { isProxy } from 'node:util/types';

import {
  observeProductionActivationPolicyV1,
  productionRuntimePackageRoot,
  projectProductionArtifactPackagingV1,
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
import {
  observeRuntimeReleaseLaunchReadinessV1,
  type RuntimeReleaseLaunchReadinessInputV1,
} from './runtime-release-launch-readiness.js';
import { observeRuntimeReleasePackagingReadinessV1 } from
  './runtime-release-packaging-readiness.js';

export const PRODUCTION_ACTIVATION_READINESS_SCHEMA_VERSION = 1 as const;

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
const LAUNCH_STRING_FIELDS = [
  'declaredInterpreterPath',
  'declaredInterpreterVersion',
  'dependencyRoot',
  'executablePath',
  'expectedEnvelopeCanonicalSha256',
  'expectedKeyId',
  'expectedManifestDigest',
  'expectedPolicyId',
  'expectedRevision',
  'expectedServiceInvocationDigest',
  'expectedStagedTreeIdentity',
  'expectedTrustRootCanonicalSha256',
  'packageRoot',
] as const;
const LAUNCH_BYTE_FIELDS = ['envelope', 'manifest', 'policy', 'trustRoot'] as const;
const MAX_LAUNCH_ARGUMENTS = 128;

type OwnDescriptorMap = Record<string, PropertyDescriptor | undefined>;

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
  launchObservation?: RuntimeReleaseLaunchReadinessInputV1;
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
  'artifact-packaging-incompatible': 'The runtime package lacks canonical dependency inventory or matching installed package bytes.',
  'artifact-packaging-unavailable': 'Runtime artifact packaging evidence is unavailable or incomplete.',
  'release-manifest-unavailable': 'Runtime release manifest evidence is unavailable.',
  'release-manifest-invalid': 'Runtime release manifest evidence is invalid.',
  'release-evidence-unavailable': 'Signed runtime release evidence is unavailable.',
  'release-evidence-invalid': 'Signed runtime release evidence is invalid.',
  'launch-admission-unavailable': 'Read-only launch readiness evidence is unavailable or incomplete.',
  'launch-admission-blocked': 'Read-only launch readiness is complete but provides no launch authority.',
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

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry, seen);
  }
  return Object.freeze(value);
}

function ownDataDescriptors(value: unknown): OwnDescriptorMap | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return Object.getOwnPropertyDescriptors(value) as OwnDescriptorMap;
  } catch {
    return null;
  }
}

function ownDataValue(
  descriptors: OwnDescriptorMap,
  key: string,
): { ok: true; value: unknown } | { ok: false } {
  const descriptor = descriptors[key];
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { ok: false };
  return { ok: true, value: descriptor.value };
}

function copyArgv(value: unknown): string[] | null {
  if (!Array.isArray(value) || isProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as OwnDescriptorMap;
    const length = descriptors['length']?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_LAUNCH_ARGUMENTS) return null;
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = ownDataValue(descriptors, String(index));
      if (!item.ok || typeof item.value !== 'string') return null;
      result.push(item.value);
    }
    return result;
  } catch {
    return null;
  }
}

function copyBytes(value: unknown): string | Buffer | null {
  if (value !== null && typeof value === 'object' && isProxy(value)) return null;
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? Buffer.from(value) : null;
}

function isolateLaunchObservation(
  value: unknown,
): RuntimeReleaseLaunchReadinessInputV1 | null {
  const descriptors = ownDataDescriptors(value);
  if (!descriptors) return null;
  const rawArgv = ownDataValue(descriptors, 'argv');
  const argv = rawArgv.ok ? copyArgv(rawArgv.value) : null;
  if (!argv) return null;

  const strings: Record<(typeof LAUNCH_STRING_FIELDS)[number], string> = {} as never;
  for (const field of LAUNCH_STRING_FIELDS) {
    const candidate = ownDataValue(descriptors, field);
    if (!candidate.ok || typeof candidate.value !== 'string') return null;
    strings[field] = candidate.value;
  }
  const bytes: Record<(typeof LAUNCH_BYTE_FIELDS)[number], string | Buffer> = {} as never;
  for (const field of LAUNCH_BYTE_FIELDS) {
    const candidate = ownDataValue(descriptors, field);
    const copied = candidate.ok ? copyBytes(candidate.value) : null;
    if (copied === null) return null;
    bytes[field] = copied;
  }
  const rawExpectedPackageName = descriptors['expectedPackageName'];
  if (rawExpectedPackageName &&
    (!Object.hasOwn(rawExpectedPackageName, 'value') ||
      typeof rawExpectedPackageName.value !== 'string')) {
    return null;
  }

  return {
    argv,
    declaredInterpreterPath: strings.declaredInterpreterPath,
    declaredInterpreterVersion: strings.declaredInterpreterVersion,
    dependencyRoot: strings.dependencyRoot,
    envelope: bytes.envelope,
    executablePath: strings.executablePath,
    expectedEnvelopeCanonicalSha256: strings.expectedEnvelopeCanonicalSha256,
    expectedKeyId: strings.expectedKeyId,
    expectedManifestDigest: strings.expectedManifestDigest,
    ...(rawExpectedPackageName ? { expectedPackageName: rawExpectedPackageName.value } : {}),
    expectedPolicyId: strings.expectedPolicyId,
    expectedRevision: strings.expectedRevision,
    expectedServiceInvocationDigest: strings.expectedServiceInvocationDigest,
    expectedStagedTreeIdentity: strings.expectedStagedTreeIdentity,
    expectedTrustRootCanonicalSha256: strings.expectedTrustRootCanonicalSha256,
    manifest: bytes.manifest,
    packageRoot: strings.packageRoot,
    policy: bytes.policy,
    trustRoot: bytes.trustRoot,
  };
}

interface IsolatedReadinessInputV1 {
  valid: boolean;
  launchDeclared: boolean;
  launchObservation: RuntimeReleaseLaunchReadinessInputV1 | null;
  packageRoot?: string;
  releaseTipObservation?: ReleaseTipProjectionInputV1;
  residentServiceDiagnostic?: ResidentServiceDiagnosticProjectionInputV1;
}

const READINESS_INPUT_KEYS = new Set([
  'launchObservation',
  'packageRoot',
  'releaseTipObservation',
  'residentServiceDiagnostic',
]);

function isolateReadinessInput(value: unknown): IsolatedReadinessInputV1 {
  const descriptors = ownDataDescriptors(value);
  if (!descriptors || Object.keys(descriptors).some((key) => !READINESS_INPUT_KEYS.has(key))) {
    return { valid: false, launchDeclared: false, launchObservation: null };
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return { valid: false, launchDeclared: false, launchObservation: null };
    }
  }
  const packageRootValue = ownDataValue(descriptors, 'packageRoot');
  if (packageRootValue.ok && typeof packageRootValue.value !== 'string') {
    return { valid: false, launchDeclared: false, launchObservation: null };
  }
  const packageRoot = packageRootValue.ok && typeof packageRootValue.value === 'string'
    ? packageRootValue.value
    : undefined;
  const launchValue = ownDataValue(descriptors, 'launchObservation');
  const launchObservation = launchValue.ok ? isolateLaunchObservation(launchValue.value) : null;
  const releaseTip = ownDataValue(descriptors, 'releaseTipObservation');
  const resident = ownDataValue(descriptors, 'residentServiceDiagnostic');
  return {
    valid: !launchValue.ok || launchObservation !== null,
    launchDeclared: launchValue.ok,
    launchObservation,
    ...(packageRoot !== undefined ? { packageRoot } : {}),
    ...(releaseTip.ok
      ? { releaseTipObservation: releaseTip.value as ReleaseTipProjectionInputV1 }
      : {}),
    ...(resident.ok
      ? { residentServiceDiagnostic: resident.value as ResidentServiceDiagnosticProjectionInputV1 }
      : {}),
  };
}

/** Compose production observations without importing or acquiring mutation capability. */
export function inspectProductionActivationReadinessV1(
  input: InspectProductionActivationReadinessInputV1 = {},
): ProductionActivationReadinessV1 {
  const isolatedInput = isolateReadinessInput(input);
  const blockers: ProductionActivationReadinessBlockerV1[] = [];
  const packagingResult = observeRuntimeReleasePackagingReadinessV1(
    isolatedInput.packageRoot ?? productionRuntimePackageRoot(),
  );
  const artifactPackaging = projectProductionArtifactPackagingV1(packagingResult);
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

  const launchObservation = isolatedInput.launchObservation;
  if (!isolatedInput.valid || (isolatedInput.launchDeclared && !launchObservation)) {
    releaseManifest = {
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'manifest-invalid',
      state: 'invalid',
      manifestDigest: null,
    };
    releaseEvidence = {
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'release-evidence-invalid',
      state: 'invalid',
      keyId: null,
    };
    launchAdmission = {
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'launch-admission-inspection-failed',
      state: 'unavailable',
      blockerCodes: [],
    };
  } else if (launchObservation) {
    const observed = observeRuntimeReleaseLaunchReadinessV1(
      launchObservation,
      packagingResult,
    );
    releaseManifest = observed.releaseManifest;
    releaseEvidence = observed.releaseEvidence;
    launchAdmission = {
      ...observed.launchAdmission,
      blockerCodes: safeCodes(observed.launchAdmission.blockerCodes),
    };
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

  const residentService = projectResidentServiceDiagnosticV1(
    isolatedInput.residentServiceDiagnostic,
  );
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

  const releaseTip = projectReleaseTipObservationV1(isolatedInput.releaseTipObservation);
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

  return deepFreeze({
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
  });
}

export type {
  ProductionArtifactPackagingObservationV1,
  ProductionReleaseTipObservationV1,
  ProductionResidentServiceObservationV1,
  ReleaseTipProjectionInputV1,
  ResidentServiceDiagnosticProjectionInputV1,
} from './production-activation-observations.js';

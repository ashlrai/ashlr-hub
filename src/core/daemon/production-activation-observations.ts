/** Bounded, mutation-free observations used by production readiness. */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProxy } from 'node:util/types';

import { DAEMON_ACTIVATION_TRUST_ROOTS } from './activation-trust-roots.js';
import {
  observeRuntimeReleasePackagingReadinessV1,
  RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1,
  type RuntimeReleasePackagingReadinessResultV1,
} from './runtime-release-packaging-readiness.js';

const MAX_PROJECTED_CODES = 32;
const RESIDENT_FINDING_CODES = new Set([
  'trusted-signed-release-evidence-missing',
  'trusted-signed-interpreter-evidence-missing',
  'immutable-release-trust-root-missing',
  'signed-release-manifest-invalid',
  'signed-release-manifest-stale',
  'signed-release-manifest-mismatch',
  'home-directory-identity-unbound',
  'home-directory-identity-unavailable',
  'installed-service-environment-absent',
  'installed-service-environment-unavailable',
  'loaded-service-environment-absent',
  'loaded-service-environment-unavailable',
  'service-environment-mismatch',
  'service-environment-unsafe',
  'service-invocation-unsafe',
  'exact-loaded-definition-binding-missing',
  'atomic-activation-handoff-missing',
  'hard-deadline-worker-missing',
  'native-consumer-evidence-missing',
  'unsupported-platform',
  'release-declaration-invalid',
  'release-binding-unavailable',
  'release-binding-mismatch',
  'interpreter-declaration-invalid',
  'interpreter-binding-unavailable',
  'interpreter-binding-mismatch',
  'service-definition-unavailable',
  'service-label-mismatch',
  'service-invocation-mismatch',
  'restart-policy-mismatch',
  'service-not-loaded',
  'service-not-running',
  'service-state-unavailable',
  'service-disabled',
  'service-enable-state-unavailable',
  'kill-switch-present',
  'kill-switch-state-unavailable',
  'observation-deadline-exceeded',
  'observation-changed',
]);
const RELEASE_TIP_STOP_REASONS = new Set([
  'codec-unavailable',
  'unsafe-storage',
  'invalid-options',
  'file-limit',
  'byte-limit',
  'invalid-file',
  'source-mutated',
  'io-error',
  'platform-unsupported',
  'bootstrap-required',
  'duplicate-sequence',
  'out-of-order-sequence',
  'sequence-gap',
  'broken-predecessor',
]);

type OwnDescriptorMap = Record<string, PropertyDescriptor | undefined>;

export type ProductionObservationSourceStateV1 = 'healthy' | 'missing' | 'degraded';

export interface ProductionArtifactPackagingObservationV1 {
  sourceState: ProductionObservationSourceStateV1;
  complete: boolean;
  state: 'requirements-present' | 'requirements-missing' | 'unavailable';
  packageManifest: 'present' | 'missing' | 'unreadable';
  dependencyInventory: 'canonical-package-bytes-matched' | 'missing' | 'unreadable' | 'mismatch';
  installedDependencyTree: 'inventory-matched-unsealed-root' | 'missing' | 'unreadable' | 'mismatch';
  inventoryDigest: string | null;
  installedTreeSha256: string | null;
  packageCount: number | null;
  packageName: string | null;
  packageVersion: string | null;
  expectation: typeof RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1;
  reasonCode:
    | 'observed'
    | 'artifact-root-unavailable'
    | 'package-manifest-missing'
    | 'package-manifest-unreadable'
    | 'dependency-inventory-missing'
    | 'dependency-inventory-unreadable'
    | 'dependency-inventory-mismatch'
    | 'dependency-tree-missing'
    | 'dependency-tree-unreadable'
    | 'dependency-tree-mismatch';
}

export interface ProductionActivationPolicyObservationV1 {
  sourceState: ProductionObservationSourceStateV1;
  complete: boolean;
  state: 'blocked' | 'inspection-unavailable';
  trustRootCount: number;
  reasonCode: 'no-trusted-activation-roots' | 'permit-inspection-isolated';
}

export interface ProductionResidentServiceObservationV1 {
  sourceState: ProductionObservationSourceStateV1;
  complete: boolean;
  state: 'observed-blocked' | 'invalid' | 'unavailable';
  findingCodes: string[];
  reasonCode: 'diagnostic-observed' | 'diagnostic-unavailable' | 'diagnostic-invalid';
}

export interface ProductionReleaseTipObservationV1 {
  sourceState: ProductionObservationSourceStateV1;
  complete: boolean;
  state: 'observed-untrusted' | 'invalid' | 'unavailable';
  stopReasons: string[];
  reasonCode: 'tip-observed-untrusted' | 'tip-unavailable' | 'tip-invalid';
}

export interface ResidentServiceDiagnosticProjectionInputV1 {
  diagnosticStatus: 'blocked';
  findings: Array<{ code: unknown; detail?: unknown }>;
}

export interface ReleaseTipProjectionInputV1 {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  stopReasons: unknown[];
}

export function productionRuntimePackageRoot(): string {
  return resolve(fileURLToPath(new URL('../../../', import.meta.url)));
}

/** Observe the actual runtime tree; do not infer npm packing behavior. */
export function observeProductionArtifactPackagingV1(
  rawPackageRoot: string = productionRuntimePackageRoot(),
): ProductionArtifactPackagingObservationV1 {
  return projectProductionArtifactPackagingV1(
    observeRuntimeReleasePackagingReadinessV1(rawPackageRoot),
  );
}

export function projectProductionArtifactPackagingV1(
  result: RuntimeReleasePackagingReadinessResultV1,
): ProductionArtifactPackagingObservationV1 {
  if (result.ok) return {
    sourceState: 'healthy',
    complete: true,
    state: 'requirements-present',
    packageManifest: 'present',
    dependencyInventory: 'canonical-package-bytes-matched',
    installedDependencyTree: 'inventory-matched-unsealed-root',
    inventoryDigest: result.inventoryDigest,
    installedTreeSha256: result.installedTreeSha256,
    packageCount: result.packageCount,
    packageName: result.packageName,
    packageVersion: result.packageVersion,
    expectation: RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1,
    reasonCode: 'observed',
  };

  const missing = result.kind === 'missing';
  const packageManifest = result.subject === 'package-manifest'
    ? missing ? 'missing' as const : 'unreadable' as const
    : 'present' as const;
  const dependencyInventory = result.subject === 'dependency-inventory'
    ? result.kind
    : result.subject === 'package-manifest'
      ? 'missing' as const
      : 'canonical-package-bytes-matched' as const;
  const installedDependencyTree = result.subject === 'dependency-tree'
    ? result.kind
    : 'missing' as const;
  const reasonCode = result.subject === 'package-manifest'
    ? missing ? 'package-manifest-missing' as const : 'package-manifest-unreadable' as const
    : result.subject === 'dependency-inventory'
      ? result.kind === 'missing'
        ? 'dependency-inventory-missing' as const
        : result.kind === 'mismatch'
          ? 'dependency-inventory-mismatch' as const
          : 'dependency-inventory-unreadable' as const
      : result.kind === 'missing'
        ? 'dependency-tree-missing' as const
        : result.kind === 'mismatch'
          ? 'dependency-tree-mismatch' as const
          : 'dependency-tree-unreadable' as const;
  return {
    sourceState: missing ? 'missing' : 'degraded',
    complete: false,
    state: missing ? 'requirements-missing' : 'unavailable',
    packageManifest,
    dependencyInventory,
    installedDependencyTree,
    inventoryDigest: null,
    installedTreeSha256: null,
    packageCount: null,
    packageName: null,
    packageVersion: null,
    expectation: RUNTIME_RELEASE_PACKAGING_READINESS_EXPECTATION_V1,
    reasonCode,
  };
}

/** Observe immutable activation-root configuration without loading permit consumers. */
export function observeProductionActivationPolicyV1():
ProductionActivationPolicyObservationV1 {
  const trustRootCount = DAEMON_ACTIVATION_TRUST_ROOTS.length;
  return trustRootCount === 0
    ? {
      sourceState: 'healthy',
      complete: true,
      state: 'blocked',
      trustRootCount: 0,
      reasonCode: 'no-trusted-activation-roots',
    }
    : {
      sourceState: 'missing',
      complete: false,
      state: 'inspection-unavailable',
      trustRootCount,
      reasonCode: 'permit-inspection-isolated',
    };
}

function allowlistedCodes(values: readonly unknown[], allowed: ReadonlySet<string>): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string' && allowed.has(value))
    .slice(0, MAX_PROJECTED_CODES))];
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

function ownDenseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || isProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as OwnDescriptorMap;
    const length = descriptors['length']?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROJECTED_CODES) {
      return null;
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const item = ownDataValue(descriptors, String(index));
      if (!item.ok) return null;
      result.push(item.value);
    }
    return result;
  } catch {
    return null;
  }
}

function invalidResidentServiceObservation(): ProductionResidentServiceObservationV1 {
  return {
    sourceState: 'degraded',
    complete: false,
    state: 'invalid',
    findingCodes: [],
    reasonCode: 'diagnostic-invalid',
  };
}

function invalidReleaseTipObservation(): ProductionReleaseTipObservationV1 {
  return {
    sourceState: 'degraded',
    complete: false,
    state: 'invalid',
    stopReasons: [],
    reasonCode: 'tip-invalid',
  };
}

/** Strip resident diagnostic details, retaining bounded enum-like codes only. */
export function projectResidentServiceDiagnosticV1(
  input: ResidentServiceDiagnosticProjectionInputV1 | undefined,
): ProductionResidentServiceObservationV1 {
  if (!input) {
    return {
      sourceState: 'missing',
      complete: false,
      state: 'unavailable',
      findingCodes: [],
      reasonCode: 'diagnostic-unavailable',
    };
  }
  const descriptors = ownDataDescriptors(input);
  if (!descriptors) return invalidResidentServiceObservation();
  const diagnosticStatus = ownDataValue(descriptors, 'diagnosticStatus');
  const rawFindings = ownDataValue(descriptors, 'findings');
  const findings = rawFindings.ok ? ownDenseArray(rawFindings.value) : null;
  if (!diagnosticStatus.ok || diagnosticStatus.value !== 'blocked' || !findings) {
    return invalidResidentServiceObservation();
  }
  const findingCodes: unknown[] = [];
  for (const finding of findings) {
    const findingDescriptors = ownDataDescriptors(finding);
    if (!findingDescriptors) return invalidResidentServiceObservation();
    const code = ownDataValue(findingDescriptors, 'code');
    if (!code.ok) return invalidResidentServiceObservation();
    findingCodes.push(code.value);
  }
  return {
    sourceState: 'healthy',
    complete: true,
    state: 'observed-blocked',
    findingCodes: allowlistedCodes(findingCodes, RESIDENT_FINDING_CODES),
    reasonCode: 'diagnostic-observed',
  };
}

/** Strip release-tip records and metadata, retaining bounded source codes only. */
export function projectReleaseTipObservationV1(
  input: ReleaseTipProjectionInputV1 | undefined,
): ProductionReleaseTipObservationV1 {
  if (!input) {
    return {
      sourceState: 'missing',
      complete: false,
      state: 'unavailable',
      stopReasons: [],
      reasonCode: 'tip-unavailable',
    };
  }
  const descriptors = ownDataDescriptors(input);
  if (!descriptors) return invalidReleaseTipObservation();
  const rawSourceState = ownDataValue(descriptors, 'sourceState');
  const rawComplete = ownDataValue(descriptors, 'complete');
  const rawStopReasons = ownDataValue(descriptors, 'stopReasons');
  const stopReasons = rawStopReasons.ok ? ownDenseArray(rawStopReasons.value) : null;
  if (!rawSourceState.ok ||
    (rawSourceState.value !== 'healthy' &&
      rawSourceState.value !== 'missing' &&
      rawSourceState.value !== 'degraded') ||
    !rawComplete.ok ||
    typeof rawComplete.value !== 'boolean' ||
    !stopReasons) {
    return invalidReleaseTipObservation();
  }
  if (!rawComplete.value || rawSourceState.value !== 'healthy') {
    return {
      sourceState: rawSourceState.value === 'healthy' ? 'degraded' : rawSourceState.value,
      complete: false,
      state: 'unavailable',
      stopReasons: allowlistedCodes(stopReasons, RELEASE_TIP_STOP_REASONS),
      reasonCode: 'tip-unavailable',
    };
  }
  return {
    sourceState: 'healthy',
    complete: true,
    state: 'observed-untrusted',
    stopReasons: allowlistedCodes(stopReasons, RELEASE_TIP_STOP_REASONS),
    reasonCode: 'tip-observed-untrusted',
  };
}

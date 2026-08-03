/** Bounded, mutation-free observations used by production readiness. */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DAEMON_ACTIVATION_TRUST_ROOTS } from './activation-trust-roots.js';
import { RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1 } from './runtime-release-manifest.js';

const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
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

export type ProductionObservationSourceStateV1 = 'healthy' | 'missing' | 'degraded';

export interface ProductionArtifactPackagingObservationV1 {
  sourceState: ProductionObservationSourceStateV1;
  complete: boolean;
  state: 'requirements-present' | 'requirements-missing' | 'unavailable';
  packageManifest: 'present' | 'missing' | 'unreadable';
  lockfileEvidence: 'package-lock' | 'missing' | 'unreadable';
  installedDependencyTree: 'present-unattested' | 'missing' | 'unreadable';
  expectation: typeof RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1;
  reasonCode:
    | 'observed'
    | 'artifact-root-unavailable'
    | 'package-manifest-missing'
    | 'package-manifest-unreadable'
    | 'lockfile-missing'
    | 'lockfile-unreadable'
    | 'dependency-tree-missing'
    | 'dependency-tree-unreadable';
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
  state: 'observed-blocked' | 'unavailable';
  findingCodes: string[];
  reasonCode: 'diagnostic-observed' | 'diagnostic-unavailable';
}

export interface ProductionReleaseTipObservationV1 {
  sourceState: ProductionObservationSourceStateV1;
  complete: boolean;
  state: 'observed-untrusted' | 'unavailable';
  stopReasons: string[];
  reasonCode: 'tip-observed-untrusted' | 'tip-unavailable';
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

function safeEntry(path: string, kind: 'file' | 'directory', maxBytes?: number):
  'present' | 'missing' | 'unreadable' {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) return 'unreadable';
    if (kind === 'file' && !stat.isFile()) return 'unreadable';
    if (kind === 'directory' && !stat.isDirectory()) return 'unreadable';
    if (realpathSync(path) !== resolve(path)) return 'unreadable';
    if (maxBytes !== undefined && (stat.size < 0n || stat.size > BigInt(maxBytes))) {
      return 'unreadable';
    }
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/** Observe the actual runtime tree; do not infer npm packing behavior. */
export function observeProductionArtifactPackagingV1(
  rawPackageRoot: string = productionRuntimePackageRoot(),
): ProductionArtifactPackagingObservationV1 {
  let packageRoot: string;
  try {
    packageRoot = realpathSync(resolve(rawPackageRoot));
    if (safeEntry(packageRoot, 'directory') !== 'present') throw new Error('invalid root');
  } catch {
    return {
      sourceState: 'missing',
      complete: false,
      state: 'unavailable',
      packageManifest: 'missing',
      lockfileEvidence: 'missing',
      installedDependencyTree: 'missing',
      expectation: RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1,
      reasonCode: 'artifact-root-unavailable',
    };
  }

  const packagePath = join(packageRoot, 'package.json');
  const packageState = safeEntry(packagePath, 'file', MAX_PACKAGE_MANIFEST_BYTES);
  if (packageState !== 'present') {
    return {
      sourceState: packageState === 'missing' ? 'missing' : 'degraded',
      complete: false,
      state: packageState === 'missing' ? 'requirements-missing' : 'unavailable',
      packageManifest: packageState,
      lockfileEvidence: 'missing',
      installedDependencyTree: 'missing',
      expectation: RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1,
      reasonCode: packageState === 'missing'
        ? 'package-manifest-missing'
        : 'package-manifest-unreadable',
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid package manifest');
    }
  } catch {
    return {
      sourceState: 'degraded',
      complete: false,
      state: 'unavailable',
      packageManifest: 'unreadable',
      lockfileEvidence: 'unreadable',
      installedDependencyTree: 'unreadable',
      expectation: RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1,
      reasonCode: 'package-manifest-unreadable',
    };
  }

  const lockfileState = safeEntry(
    join(packageRoot, RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1.lockfilePath),
    'file',
    MAX_LOCKFILE_BYTES,
  );
  const lockfileEvidence = lockfileState === 'present'
    ? 'package-lock' as const
    : lockfileState;
  const dependencyState = safeEntry(
    join(packageRoot, RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1.installedDependencyRootPath),
    'directory',
  );
  const installedDependencyTree = dependencyState === 'present'
    ? 'present-unattested' as const
    : dependencyState;

  if (lockfileEvidence === 'missing' || dependencyState === 'missing') {
    return {
      sourceState: 'missing',
      complete: false,
      state: 'requirements-missing',
      packageManifest: 'present',
      lockfileEvidence,
      installedDependencyTree,
      expectation: RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1,
      reasonCode: lockfileEvidence === 'missing'
        ? 'lockfile-missing'
        : 'dependency-tree-missing',
    };
  }
  if (lockfileEvidence === 'unreadable' || dependencyState === 'unreadable') {
    return {
      sourceState: 'degraded',
      complete: false,
      state: 'unavailable',
      packageManifest: 'present',
      lockfileEvidence,
      installedDependencyTree,
      expectation: RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1,
      reasonCode: lockfileEvidence === 'unreadable'
        ? 'lockfile-unreadable'
        : 'dependency-tree-unreadable',
    };
  }
  return {
    sourceState: 'healthy',
    complete: true,
    state: 'requirements-present',
    packageManifest: 'present',
    lockfileEvidence,
    installedDependencyTree,
    expectation: RUNTIME_RELEASE_PACKAGING_EXPECTATION_V1,
    reasonCode: 'observed',
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
    .slice(0, 32))];
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
  return {
    sourceState: 'healthy',
    complete: true,
    state: 'observed-blocked',
    findingCodes: allowlistedCodes(
      input.findings.map(({ code }) => code),
      RESIDENT_FINDING_CODES,
    ),
    reasonCode: 'diagnostic-observed',
  };
}

/** Strip release-tip records and metadata, retaining bounded source codes only. */
export function projectReleaseTipObservationV1(
  input: ReleaseTipProjectionInputV1 | undefined,
): ProductionReleaseTipObservationV1 {
  if (!input || !input.complete || input.sourceState !== 'healthy') {
    return {
      sourceState: input?.sourceState ?? 'missing',
      complete: false,
      state: 'unavailable',
      stopReasons: allowlistedCodes(input?.stopReasons ?? [], RELEASE_TIP_STOP_REASONS),
      reasonCode: 'tip-unavailable',
    };
  }
  return {
    sourceState: 'healthy',
    complete: true,
    state: 'observed-untrusted',
    stopReasons: allowlistedCodes(input.stopReasons, RELEASE_TIP_STOP_REASONS),
    reasonCode: 'tip-observed-untrusted',
  };
}

/**
 * Read-only production activation readiness composition.
 *
 * This module joins dormant release and service observations into one
 * operator-facing verdict. It cannot install, start, consume activation
 * permits, settle release state, or grant lifecycle authority.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AshlrConfig } from '../types.js';
import {
  inspectDaemonActivationPermit,
  type DaemonActivationReadiness,
} from './activation-permit.js';
import {
  readReleaseTipSettlements,
  type ReleaseTipSettlementReadResult,
} from './release-current-tip-store.js';
import {
  observeResidentServiceDiagnostic,
  type ResidentServiceDiagnostic,
  type ResidentServiceDiagnosticOptions,
} from './resident-service-readiness.js';
import {
  verifyRuntimeReleaseEvidenceEnvelope,
} from './runtime-release-evidence-envelope.js';
import {
  evaluateRuntimeReleaseLaunchAdmission,
  type RuntimeReleaseLaunchAdmissionDecision,
} from './runtime-release-launch-admission.js';
import type {
  RuntimeReleaseLaunchObservationOptions,
} from './runtime-release-launch-revalidation.js';
import {
  parseUnsignedRuntimeReleaseManifest,
} from './runtime-release-manifest.js';

export const PRODUCTION_ACTIVATION_READINESS_SCHEMA_VERSION = 1 as const;

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

export interface ProductionArtifactPackagingObservationV1 {
  state: 'compatible' | 'incompatible' | 'unavailable';
  packageManifestPresent: boolean;
  sourceLockfilePresent: boolean;
  publishableLockfilePresent: boolean;
  installedDependencyTreePresent: boolean;
  packedLockfileEvidence: 'present' | 'missing' | 'unknown';
  packedDependencyEvidence: 'complete' | 'missing' | 'unknown';
  reason: string;
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
    sourceState: 'degraded';
    complete: false;
    reasons: string[];
  };
  observations: {
    artifactPackaging: ProductionArtifactPackagingObservationV1;
    releaseManifest: {
      state: 'observed' | 'invalid' | 'unavailable';
      manifestDigest: string | null;
      reason: string;
    };
    releaseEvidence: {
      state: 'verified-observation-only' | 'invalid' | 'unavailable';
      keyId: string | null;
      reason: string;
    };
    launchAdmission: {
      state: 'observed-blocked' | 'unavailable';
      blockerCodes: string[];
      reason: string;
    };
    residentService: {
      state: 'observed-blocked' | 'unavailable';
      findingCodes: string[];
      reason: string;
    };
    activationPermit: {
      state: 'blocked' | 'degraded' | 'unavailable';
      trustRootCount: number;
      reason: string;
    };
    releaseTip: {
      state: 'observed-untrusted' | 'unavailable';
      sourceState: 'missing' | 'healthy' | 'degraded' | 'unavailable';
      complete: boolean;
      stopReasons: string[];
      reason: string;
    };
  };
}

export interface InspectProductionActivationReadinessInputV1 {
  config?: AshlrConfig;
  launchObservation?: RuntimeReleaseLaunchObservationOptions;
  packageRoot?: string;
  releaseScopeDigest?: string;
  residentService?: ResidentServiceDiagnosticOptions;
}

export interface ProductionActivationReadinessDependenciesV1 {
  inspectActivation: typeof inspectDaemonActivationPermit;
  inspectArtifactPackaging: (packageRoot: string) => ProductionArtifactPackagingObservationV1;
  inspectResidentService: typeof observeResidentServiceDiagnostic;
  parseManifest: typeof parseUnsignedRuntimeReleaseManifest;
  readReleaseTip: typeof readReleaseTipSettlements;
  verifyReleaseEvidence: typeof verifyRuntimeReleaseEvidenceEnvelope;
  evaluateLaunchAdmission: typeof evaluateRuntimeReleaseLaunchAdmission;
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

const DEFAULT_DEPENDENCIES: ProductionActivationReadinessDependenciesV1 = {
  inspectActivation: inspectDaemonActivationPermit,
  inspectArtifactPackaging,
  inspectResidentService: observeResidentServiceDiagnostic,
  parseManifest: parseUnsignedRuntimeReleaseManifest,
  readReleaseTip: readReleaseTipSettlements,
  verifyReleaseEvidence: verifyRuntimeReleaseEvidenceEnvelope,
  evaluateLaunchAdmission: evaluateRuntimeReleaseLaunchAdmission,
};

function defaultPackageRoot(): string {
  return resolve(fileURLToPath(new URL('../../../', import.meta.url)));
}

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile() && realpathSync(path) === resolve(path);
  } catch {
    return false;
  }
}

function directory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && realpathSync(path) === resolve(path);
  } catch {
    return false;
  }
}

/**
 * Inspect whether the npm artifact can satisfy the current runtime manifest.
 * npm excludes package-lock.json from published packages and node_modules is
 * not release evidence; the current package therefore cannot satisfy the
 * manifest's required lockfile plus complete installed dependency identity.
 */
export function inspectArtifactPackaging(
  packageRoot: string,
): ProductionArtifactPackagingObservationV1 {
  try {
    const root = realpathSync(resolve(packageRoot));
    const packagePath = resolve(root, 'package.json');
    const packageManifestPresent = regularFile(packagePath);
    if (!packageManifestPresent) {
      return {
        state: 'unavailable',
        packageManifestPresent: false,
        sourceLockfilePresent: false,
        publishableLockfilePresent: false,
        installedDependencyTreePresent: false,
        packedLockfileEvidence: 'unknown',
        packedDependencyEvidence: 'unknown',
        reason: 'runtime package manifest is unavailable',
      };
    }
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid package manifest');
    }
    const sourceLockfilePresent = regularFile(resolve(root, 'package-lock.json'));
    const publishableLockfilePresent = regularFile(resolve(root, 'npm-shrinkwrap.json'));
    const installedDependencyTreePresent = directory(resolve(root, 'node_modules'));
    return {
      state: 'incompatible',
      packageManifestPresent: true,
      sourceLockfilePresent,
      publishableLockfilePresent,
      installedDependencyTreePresent,
      packedLockfileEvidence: 'missing',
      packedDependencyEvidence: 'missing',
      reason: 'the runtime manifest requires package-lock.json, but npm published artifacts exclude package-lock.json and do not carry complete installed dependency bytes',
    };
  } catch {
    return {
      state: 'unavailable',
      packageManifestPresent: existsSync(resolve(packageRoot, 'package.json')),
      sourceLockfilePresent: false,
      publishableLockfilePresent: false,
      installedDependencyTreePresent: false,
      packedLockfileEvidence: 'unknown',
      packedDependencyEvidence: 'unknown',
      reason: 'runtime artifact packaging could not be inspected',
    };
  }
}

function pushBlocker(
  blockers: ProductionActivationReadinessBlockerV1[],
  code: ProductionActivationReadinessBlockerCodeV1,
  source: ProductionActivationReadinessBlockerV1['source'],
  detail: string,
): void {
  blockers.push({ code, source, detail });
}

function unavailableActivation(reason: string): DaemonActivationReadiness {
  return {
    schemaVersion: 1,
    policyVersion: 'm461-proposal-once-v1',
    authority: 'observation-only',
    sourceState: 'degraded',
    state: 'degraded',
    commandEligible: false,
    requestedShape: 'proposal-once',
    trustRootCount: 0,
    residentAuthorized: false,
    installAuthorized: false,
    repairAuthorized: false,
    reason,
  };
}

/** Compose production observations without acquiring or consuming authority. */
export function inspectProductionActivationReadinessV1(
  input: InspectProductionActivationReadinessInputV1 = {},
  dependencies: ProductionActivationReadinessDependenciesV1 = DEFAULT_DEPENDENCIES,
): ProductionActivationReadinessV1 {
  const blockers: ProductionActivationReadinessBlockerV1[] = [];
  const packageRoot = input.packageRoot ?? defaultPackageRoot();
  let packaging: ProductionArtifactPackagingObservationV1;
  try {
    packaging = dependencies.inspectArtifactPackaging(packageRoot);
  } catch {
    packaging = {
      state: 'unavailable',
      packageManifestPresent: false,
      sourceLockfilePresent: false,
      publishableLockfilePresent: false,
      installedDependencyTreePresent: false,
      packedLockfileEvidence: 'unknown',
      packedDependencyEvidence: 'unknown',
      reason: 'runtime artifact packaging inspection failed',
    };
  }
  if (packaging.state !== 'compatible') {
    pushBlocker(
      blockers,
      packaging.state === 'incompatible'
        ? 'artifact-packaging-incompatible'
        : 'artifact-packaging-unavailable',
      'artifact',
      packaging.reason,
    );
  }

  let manifestState: ProductionActivationReadinessV1['observations']['releaseManifest'] = {
    state: 'unavailable', manifestDigest: null, reason: 'runtime release manifest input is unavailable',
  };
  let evidenceState: ProductionActivationReadinessV1['observations']['releaseEvidence'] = {
    state: 'unavailable', keyId: null, reason: 'signed runtime release evidence is unavailable',
  };
  let launchState: ProductionActivationReadinessV1['observations']['launchAdmission'] = {
    state: 'unavailable', blockerCodes: [], reason: 'closed launch observation inputs are unavailable',
  };
  let launchDecision: RuntimeReleaseLaunchAdmissionDecision | undefined;
  let parsedManifestDigest: string | undefined;
  if (input.launchObservation) {
    try {
      const manifest = dependencies.parseManifest(input.launchObservation.manifest);
      if (manifest.ok) {
        parsedManifestDigest = manifest.manifest.manifestDigest;
        manifestState = {
          state: 'observed',
          manifestDigest: manifest.manifest.manifestDigest,
          reason: 'unsigned manifest parsed for observation only',
        };
      } else {
        manifestState = { state: 'invalid', manifestDigest: null, reason: manifest.reason };
      }
    } catch {
      manifestState = { state: 'invalid', manifestDigest: null, reason: 'runtime release manifest inspection failed' };
    }
    try {
      const evidence = dependencies.verifyReleaseEvidence({
        envelope: input.launchObservation.envelope,
        manifest: input.launchObservation.manifest,
        trustRoot: input.launchObservation.trustRoot,
      });
      evidenceState = evidence.ok
        ? { state: 'verified-observation-only', keyId: evidence.keyId, reason: 'caller-rooted release signature verified for observation only' }
        : { state: 'invalid', keyId: null, reason: evidence.reason };
    } catch {
      evidenceState = { state: 'invalid', keyId: null, reason: 'runtime release evidence inspection failed' };
    }
    try {
      launchDecision = dependencies.evaluateLaunchAdmission(input.launchObservation);
      launchState = {
        state: 'observed-blocked',
        blockerCodes: launchDecision.blockers.map(({ code }) => code),
        reason: launchDecision.blockers[0]?.detail ?? 'runtime release launch admission is blocked',
      };
    } catch {
      launchState = { state: 'unavailable', blockerCodes: [], reason: 'runtime release launch admission inspection failed' };
    }
  }
  if (manifestState.state !== 'observed') {
    pushBlocker(blockers, manifestState.state === 'invalid' ? 'release-manifest-invalid' : 'release-manifest-unavailable', 'release', manifestState.reason);
  }
  if (evidenceState.state !== 'verified-observation-only') {
    pushBlocker(blockers, evidenceState.state === 'invalid' ? 'release-evidence-invalid' : 'release-evidence-unavailable', 'release', evidenceState.reason);
  }
  pushBlocker(blockers, launchDecision ? 'launch-admission-blocked' : 'launch-admission-unavailable', 'launch', launchState.reason);

  let residentState: ProductionActivationReadinessV1['observations']['residentService'] = {
    state: 'unavailable', findingCodes: [], reason: 'resident service declaration is unavailable',
  };
  let resident: ResidentServiceDiagnostic | undefined;
  if (input.residentService) {
    try {
      resident = dependencies.inspectResidentService(input.residentService);
      residentState = {
        state: 'observed-blocked',
        findingCodes: resident.findings.map(({ code }) => code),
        reason: resident.findings[0]?.detail ?? 'resident service diagnostic is blocked',
      };
    } catch {
      residentState = { state: 'unavailable', findingCodes: [], reason: 'resident service diagnostic failed' };
    }
  }
  pushBlocker(blockers, resident ? 'resident-service-diagnostic-blocked' : 'resident-service-diagnostic-unavailable', 'service', residentState.reason);

  let activation = unavailableActivation('activation-config-unavailable');
  if (input.config) {
    try {
      activation = dependencies.inspectActivation(input.config, { once: true, dryRun: false });
    } catch {
      activation = unavailableActivation('activation-inspection-failed');
    }
  }
  pushBlocker(
    blockers,
    input.config ? 'activation-permit-blocked' : 'activation-inspection-unavailable',
    'activation',
    activation.state === 'ready'
      ? 'an advisory permit observation cannot authorize production lifecycle mutation'
      : activation.reason,
  );

  const releaseScopeDigest = input.releaseScopeDigest ?? parsedManifestDigest;
  let releaseTip: ReleaseTipSettlementReadResult | undefined;
  let releaseTipState: ProductionActivationReadinessV1['observations']['releaseTip'] = {
    state: 'unavailable', sourceState: 'unavailable', complete: false, stopReasons: [], reason: 'release-tip scope is unavailable',
  };
  if (releaseScopeDigest) {
    try {
      releaseTip = dependencies.readReleaseTip(releaseScopeDigest, { requireComplete: true });
      releaseTipState = {
        state: releaseTip.complete ? 'observed-untrusted' : 'unavailable',
        sourceState: releaseTip.sourceState,
        complete: releaseTip.complete,
        stopReasons: [...releaseTip.stopReasons],
        reason: releaseTip.complete
          ? 'host-local release-tip continuity is observation-only and cannot authorize rollback or activation'
          : `release-tip observation unavailable: ${releaseTip.stopReasons.join(', ') || releaseTip.sourceState}`,
      };
    } catch {
      releaseTipState = { state: 'unavailable', sourceState: 'degraded', complete: false, stopReasons: ['inspection-failed'], reason: 'release-tip observation failed' };
    }
  }
  pushBlocker(blockers, releaseTip?.complete ? 'release-tip-untrusted' : 'release-tip-unavailable', 'rollback', releaseTipState.reason);
  pushBlocker(
    blockers,
    'production-authority-chain-absent',
    'activation',
    'trusted release, policy, activation, replay, rollback, atomic launch, and post-start attestation authority are not connected to a lifecycle consumer',
  );

  return {
    schemaVersion: PRODUCTION_ACTIVATION_READINESS_SCHEMA_VERSION,
    authority: 'observation-only',
    verdict: 'blocked',
    topBlocker: blockers[0]!,
    blockers,
    authorityFlags: { ...AUTHORITY_FLAGS },
    sourceQuality: {
      sourceState: 'degraded',
      complete: false,
      reasons: blockers.map(({ code }) => code),
    },
    observations: {
      artifactPackaging: packaging,
      releaseManifest: manifestState,
      releaseEvidence: evidenceState,
      launchAdmission: launchState,
      residentService: residentState,
      activationPermit: {
        state: activation.state === 'ready' ? 'blocked' : activation.state,
        trustRootCount: activation.trustRootCount,
        reason: activation.state === 'ready'
          ? 'an advisory permit observation cannot authorize production lifecycle mutation'
          : activation.reason,
      },
      releaseTip: releaseTipState,
    },
  };
}

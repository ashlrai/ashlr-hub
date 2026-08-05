import { createHash } from 'node:crypto';
import {
  observeRuntimeReleaseLaunchInputs,
  type RuntimeReleaseLaunchObservationOptions,
} from './runtime-release-launch-revalidation.js';
import { parseUnsignedRuntimeReleaseManifest } from './runtime-release-manifest.js';

export const RUNTIME_RELEASE_LAUNCH_ADMISSION_SCHEMA_VERSION = 2 as const;
export const RUNTIME_RELEASE_LAUNCH_ADMISSION_AUTHORITY = 'observation-only' as const;

const RECEIPT_DIGEST_DOMAIN =
  'ashlr:runtime-release-launch-admission-observation-receipt:v2';

export type RuntimeReleaseLaunchAdmissionBlockerCode =
  | 'launch-observation-failed'
  | 'release-manifest-incoherent'
  | 'atomic-launch-handoff-absent'
  | 'durable-replay-consumption-absent'
  | 'rollback-unresolved'
  | 'revision-provenance-unresolved'
  | 'trusted-activation-root-absent'
  | 'trusted-policy-authority-absent';

export interface RuntimeReleaseLaunchAdmissionBlocker {
  code: RuntimeReleaseLaunchAdmissionBlockerCode;
  detail: string;
}

export interface RuntimeReleaseLaunchAdmissionDecision {
  schemaVersion: typeof RUNTIME_RELEASE_LAUNCH_ADMISSION_SCHEMA_VERSION;
  authority: typeof RUNTIME_RELEASE_LAUNCH_ADMISSION_AUTHORITY;
  verdict: 'blocked';
  admissionPermitted: false;
  deployPermitted: false;
  installPermitted: false;
  launchPermitted: false;
  rollbackPermitted: false;
  startPermitted: false;
  blockers: RuntimeReleaseLaunchAdmissionBlocker[];
  evidence: {
    atomicLaunchHandoff: 'absent-descriptors-closed';
    callerPinnedEnvelope: 'canonical-digest-and-key-id';
    closedByteIdentityObservation: 'not-completed' | 'before-after-equal';
    contentAddressedRelease: 'caller-pinned-staged-tree-identity';
    launchConsumer: 'absent';
    launchObservation: 'failed' | 'passed-closed-observation-only';
    launchObservationReceiptSha256: string | null;
    manifestDigest: string | null;
    mutationAfterObservation: 'not-prevented';
    policyAuthority: 'caller-pinned-unsigned';
    replayPrevention: 'absent-no-durable-consumption-store';
    revisionBinding: 'unobserved' | 'manifest-and-envelope-bound-declaration-only';
    stagedTreeIdentity: string | null;
    trustRootAuthority: 'caller-provided-not-activation-root';
  };
  rollback: {
    resolution: 'unobserved' | 'unresolved';
    source: 'unobserved' | 'caller-declared';
    targetManifestDigest: string | null;
  };
}

function copyBytes(value: string | Buffer): string | Buffer {
  return Buffer.isBuffer(value) ? Buffer.from(value) : value;
}

function pinInputs(
  options: RuntimeReleaseLaunchObservationOptions,
): RuntimeReleaseLaunchObservationOptions {
  return {
    ...options,
    argv: [...options.argv],
    envelope: copyBytes(options.envelope),
    manifest: copyBytes(options.manifest),
    policy: copyBytes(options.policy),
    trustRoot: copyBytes(options.trustRoot),
  };
}

function receiptDigest(canonicalJson: string): string {
  return createHash('sha256')
    .update(RECEIPT_DIGEST_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson, 'utf8')
    .digest('hex');
}

function permanentAuthorityBlockers(
  targetManifestDigest: string | null,
): RuntimeReleaseLaunchAdmissionBlocker[] {
  return [
    {
      code: 'atomic-launch-handoff-absent',
      detail: 'Observed descriptors are closed and no descriptor-bound launch consumer exists.',
    },
    {
      code: 'durable-replay-consumption-absent',
      detail: 'No durable single-consumption store prevents evidence replay.',
    },
    {
      code: 'rollback-unresolved',
      detail: targetManifestDigest === null
        ? 'The signed release has no resolved rollback target or rollback consumer.'
        : 'The signed release names a rollback target but does not validate or resolve it.',
    },
    {
      code: 'revision-provenance-unresolved',
      detail: 'The signed revision is a bound declaration, not a proven repository object identity.',
    },
    {
      code: 'trusted-activation-root-absent',
      detail: 'The caller-provided trust root is not bound to configured activation authority.',
    },
    {
      code: 'trusted-policy-authority-absent',
      detail: 'The caller-pinned policy is unsigned and has no configured authority binding.',
    },
  ];
}

function blocked(
  blockers: RuntimeReleaseLaunchAdmissionBlocker[],
  evidence: RuntimeReleaseLaunchAdmissionDecision['evidence'],
  rollback: RuntimeReleaseLaunchAdmissionDecision['rollback'],
): RuntimeReleaseLaunchAdmissionDecision {
  return {
    schemaVersion: RUNTIME_RELEASE_LAUNCH_ADMISSION_SCHEMA_VERSION,
    authority: RUNTIME_RELEASE_LAUNCH_ADMISSION_AUTHORITY,
    verdict: 'blocked',
    admissionPermitted: false,
    deployPermitted: false,
    installPermitted: false,
    launchPermitted: false,
    rollbackPermitted: false,
    startPermitted: false,
    blockers,
    evidence,
    rollback,
  };
}

function unavailableEvidence(
  launchObservation: 'failed',
): RuntimeReleaseLaunchAdmissionDecision['evidence'] {
  return {
    atomicLaunchHandoff: 'absent-descriptors-closed',
    callerPinnedEnvelope: 'canonical-digest-and-key-id',
    closedByteIdentityObservation: 'not-completed',
    contentAddressedRelease: 'caller-pinned-staged-tree-identity',
    launchConsumer: 'absent',
    launchObservation,
    launchObservationReceiptSha256: null,
    manifestDigest: null,
    mutationAfterObservation: 'not-prevented',
    policyAuthority: 'caller-pinned-unsigned',
    replayPrevention: 'absent-no-durable-consumption-store',
    revisionBinding: 'unobserved',
    stagedTreeIdentity: null,
    trustRootAuthority: 'caller-provided-not-activation-root',
  };
}

/**
 * Evaluate closed byte observations without granting service authority. A
 * successful observation cannot become launch authority until a descriptor-
 * bound consumer, durable replay consumption, trusted activation roots and
 * policy, revision provenance, and rollback resolution are implemented.
 */
export function evaluateRuntimeReleaseLaunchAdmission(
  options: RuntimeReleaseLaunchObservationOptions,
): RuntimeReleaseLaunchAdmissionDecision {
  const pinned = pinInputs(options);
  const observed = observeRuntimeReleaseLaunchInputs(pinned);
  if (!observed.ok) {
    return blocked(
      [{ code: 'launch-observation-failed', detail: observed.reason },
        ...permanentAuthorityBlockers(null)],
      unavailableEvidence('failed'),
      { resolution: 'unobserved', source: 'unobserved', targetManifestDigest: null },
    );
  }

  const evidence: RuntimeReleaseLaunchAdmissionDecision['evidence'] = {
    atomicLaunchHandoff: 'absent-descriptors-closed',
    callerPinnedEnvelope: 'canonical-digest-and-key-id',
    closedByteIdentityObservation: 'before-after-equal',
    contentAddressedRelease: 'caller-pinned-staged-tree-identity',
    launchConsumer: 'absent',
    launchObservation: 'passed-closed-observation-only',
    launchObservationReceiptSha256: receiptDigest(observed.canonicalJson),
    manifestDigest: observed.receipt.release.manifestDigest,
    mutationAfterObservation: 'not-prevented',
    policyAuthority: 'caller-pinned-unsigned',
    replayPrevention: 'absent-no-durable-consumption-store',
    revisionBinding: 'manifest-and-envelope-bound-declaration-only',
    stagedTreeIdentity: observed.receipt.stagedTreeIdentity,
    trustRootAuthority: 'caller-provided-not-activation-root',
  };
  const manifest = parseUnsignedRuntimeReleaseManifest(pinned.manifest);
  if (!manifest.ok ||
    manifest.manifest.manifestDigest !== observed.receipt.release.manifestDigest ||
    manifest.manifest.expectedRevision !== observed.receipt.release.expectedRevision ||
    manifest.manifest.rollbackDeclaration.targetManifestDigest !==
      observed.receipt.release.rollbackTargetManifestDigest) {
    return blocked(
      [{
        code: 'release-manifest-incoherent',
        detail: manifest.ok
          ? 'Closed release observation does not match the pinned manifest.'
          : manifest.reason,
      }, ...permanentAuthorityBlockers(null)],
      evidence,
      { resolution: 'unobserved', source: 'unobserved', targetManifestDigest: null },
    );
  }

  const rollbackTarget = manifest.manifest.rollbackDeclaration.targetManifestDigest;
  return blocked(
    permanentAuthorityBlockers(rollbackTarget),
    evidence,
    {
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: rollbackTarget,
    },
  );
}

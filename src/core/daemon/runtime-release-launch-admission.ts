import { createHash } from 'node:crypto';
import {
  revalidateRuntimeReleaseLaunch,
  type RuntimeReleaseLaunchRevalidationDependencies,
  type RuntimeReleaseLaunchRevalidationOptions,
} from './runtime-release-launch-revalidation.js';
import { parseUnsignedRuntimeReleaseManifest } from './runtime-release-manifest.js';

export const RUNTIME_RELEASE_LAUNCH_ADMISSION_SCHEMA_VERSION = 1 as const;
export const RUNTIME_RELEASE_LAUNCH_ADMISSION_AUTHORITY = 'observation-only' as const;

const RECEIPT_DIGEST_DOMAIN =
  'ashlr:runtime-release-launch-admission-revalidation-receipt:v1';

export type RuntimeReleaseLaunchAdmissionBlockerCode =
  | 'launch-revalidation-failed'
  | 'release-manifest-incoherent'
  | 'rollback-unresolved';

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
  blocker: RuntimeReleaseLaunchAdmissionBlocker;
  evidence: {
    callerPinnedEnvelope: 'canonical-digest-and-key-id';
    contentAddressedRelease: 'caller-pinned-staged-tree-identity';
    launchRevalidation: 'failed' | 'passed';
    launchRevalidationReceiptSha256: string | null;
    manifestDigest: string | null;
    replayPrevention: 'absent-no-durable-consumption-store';
    secondByteIdentityObservation: 'not-completed' | 'before-after-equal';
    signedRevision: 'unobserved' | 'manifest-and-envelope-bound';
    stagedTreeIdentity: string | null;
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
  options: RuntimeReleaseLaunchRevalidationOptions,
): RuntimeReleaseLaunchRevalidationOptions {
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

function blocked(
  blocker: RuntimeReleaseLaunchAdmissionBlocker,
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
    blocker,
    evidence,
    rollback,
  };
}

/**
 * Observe launch readiness without granting service authority. The signed
 * envelope, trust root, policy, invocation, and staged identity are caller
 * pinned and revalidated against bounded reads. Rollback resolution, durable
 * anti-replay consumption, and a launch consumer remain absent, so even
 * complete evidence is refused.
 */
export function evaluateRuntimeReleaseLaunchAdmission(
  options: RuntimeReleaseLaunchRevalidationOptions,
  dependencies: RuntimeReleaseLaunchRevalidationDependencies = {},
): RuntimeReleaseLaunchAdmissionDecision {
  const pinned = pinInputs(options);
  const revalidated = revalidateRuntimeReleaseLaunch(pinned, dependencies);
  if (!revalidated.ok) {
    return blocked(
      {
        code: 'launch-revalidation-failed',
        detail: revalidated.reason,
      },
      {
        callerPinnedEnvelope: 'canonical-digest-and-key-id',
        contentAddressedRelease: 'caller-pinned-staged-tree-identity',
        launchRevalidation: 'failed',
        launchRevalidationReceiptSha256: null,
        manifestDigest: null,
        replayPrevention: 'absent-no-durable-consumption-store',
        secondByteIdentityObservation: 'not-completed',
        signedRevision: 'unobserved',
        stagedTreeIdentity: null,
      },
      {
        resolution: 'unobserved',
        source: 'unobserved',
        targetManifestDigest: null,
      },
    );
  }

  const manifest = parseUnsignedRuntimeReleaseManifest(pinned.manifest);
  if (!manifest.ok ||
    manifest.manifest.manifestDigest !== revalidated.receipt.release.manifestDigest ||
    manifest.manifest.expectedRevision !== revalidated.receipt.release.expectedRevision ||
    manifest.manifest.rollbackDeclaration.targetManifestDigest !==
      revalidated.receipt.release.rollbackTargetManifestDigest) {
    return blocked(
      {
        code: 'release-manifest-incoherent',
        detail: manifest.ok
          ? 'Revalidated release receipt does not match the pinned manifest.'
          : manifest.reason,
      },
      {
        callerPinnedEnvelope: 'canonical-digest-and-key-id',
        contentAddressedRelease: 'caller-pinned-staged-tree-identity',
        launchRevalidation: 'passed',
        launchRevalidationReceiptSha256: receiptDigest(revalidated.canonicalJson),
        manifestDigest: revalidated.receipt.release.manifestDigest,
        replayPrevention: 'absent-no-durable-consumption-store',
        secondByteIdentityObservation: 'before-after-equal',
        signedRevision: 'manifest-and-envelope-bound',
        stagedTreeIdentity: revalidated.receipt.stagedTreeIdentity,
      },
      {
        resolution: 'unobserved',
        source: 'unobserved',
        targetManifestDigest: null,
      },
    );
  }

  return blocked(
    {
      code: 'rollback-unresolved',
      detail: manifest.manifest.rollbackDeclaration.targetManifestDigest === null
        ? 'The signed release has no resolved rollback target.'
        : 'The signed release names a rollback target but does not validate or resolve it.',
    },
    {
      callerPinnedEnvelope: 'canonical-digest-and-key-id',
      contentAddressedRelease: 'caller-pinned-staged-tree-identity',
      launchRevalidation: 'passed',
      launchRevalidationReceiptSha256: receiptDigest(revalidated.canonicalJson),
      manifestDigest: revalidated.receipt.release.manifestDigest,
      replayPrevention: 'absent-no-durable-consumption-store',
      secondByteIdentityObservation: 'before-after-equal',
      signedRevision: 'manifest-and-envelope-bound',
      stagedTreeIdentity: revalidated.receipt.stagedTreeIdentity,
    },
    {
      resolution: 'unresolved',
      source: 'caller-declared',
      targetManifestDigest: manifest.manifest.rollbackDeclaration.targetManifestDigest,
    },
  );
}

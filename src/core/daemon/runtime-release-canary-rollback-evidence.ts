import { createHash, timingSafeEqual } from 'node:crypto';

import {
  verifyRuntimeReleaseEvidenceEnvelope,
  type VerifyRuntimeReleaseEvidenceEnvelopeResult,
} from './runtime-release-evidence-envelope.js';
import { parseUnsignedRuntimeReleaseManifest } from './runtime-release-manifest.js';

export const RUNTIME_RELEASE_CANARY_ROLLBACK_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const RUNTIME_RELEASE_CANARY_ROLLBACK_EVIDENCE_AUTHORITY =
  'observation-only' as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;

export type RuntimeReleaseCanaryRollbackEvidenceBlockerCode =
  | 'observation-disabled'
  | 'expected-binding-invalid'
  | 'candidate-envelope-identity-mismatch'
  | 'rollback-envelope-identity-mismatch'
  | 'trust-root-identity-mismatch'
  | 'trust-root-pair-mismatch'
  | 'candidate-signature-invalid'
  | 'candidate-manifest-schema-unsupported'
  | 'rollback-signature-invalid'
  | 'candidate-release-identity-mismatch'
  | 'rollback-release-identity-mismatch'
  | 'rollback-target-missing'
  | 'rollback-target-mismatch'
  | 'rollback-self-reference';

export interface RuntimeReleaseCanaryRollbackEvidenceBlocker {
  code: RuntimeReleaseCanaryRollbackEvidenceBlockerCode;
  detail: string;
}

export interface RuntimeReleaseCanaryRollbackEvidenceArtifact {
  envelope: string | Buffer;
  manifest: string | Buffer;
  trustRoot: string | Buffer;
}

export interface RuntimeReleaseCanaryRollbackExpectedBindings {
  candidateEnvelopeSha256: string;
  candidateManifestDigest: string;
  candidateRevision: string;
  rollbackEnvelopeSha256: string;
  rollbackManifestDigest: string;
  rollbackRevision: string;
  trustRootSha256: string;
}

export interface RuntimeReleaseCanaryRollbackEvidenceInput {
  /** Enables observation only. Omission and false both fail closed. */
  observationEnabled?: boolean;
  candidate: RuntimeReleaseCanaryRollbackEvidenceArtifact;
  rollback: RuntimeReleaseCanaryRollbackEvidenceArtifact;
  expected: RuntimeReleaseCanaryRollbackExpectedBindings;
}

export interface RuntimeReleaseCanaryRollbackVerifiedRelease {
  envelopeSha256: string;
  expiresAt: string;
  issuedAt: string;
  keyId: string;
  manifestDigest: string;
  revision: string;
  signatureVerified: true;
}

export interface RuntimeReleaseCanaryRollbackEvidenceDecision {
  schemaVersion: typeof RUNTIME_RELEASE_CANARY_ROLLBACK_EVIDENCE_SCHEMA_VERSION;
  authority: typeof RUNTIME_RELEASE_CANARY_ROLLBACK_EVIDENCE_AUTHORITY;
  verdict: 'disabled' | 'blocked' | 'release-pair-verified';
  /** Never true here: this primitive does not bind the fleet admission evidence. */
  evidenceReady: false;
  releasePairVerified: boolean;
  observationEnabled: boolean;
  deployCanaryPermitted: false;
  rollbackPermitted: false;
  activationPermitted: false;
  executionPerformed: false;
  immutableBindings: {
    candidateEnvelopeSha256: string | null;
    rollbackEnvelopeSha256: string | null;
    trustRootSha256: string | null;
    exactBytesPinned: boolean;
  };
  candidate: RuntimeReleaseCanaryRollbackVerifiedRelease | null;
  rollback: RuntimeReleaseCanaryRollbackVerifiedRelease | null;
  rollbackTarget: {
    declaredManifestDigest: string | null;
    verifiedManifestDigest: string | null;
    matched: boolean;
  };
  admissionBoundary: {
    protectedRemotePr: {
      bound: false;
      branchProtectionBound: false;
      localFallbackDisabled: false;
      selfTargetExcluded: false;
    };
    signedSourceAndDiff: {
      bound: false;
      current: false;
    };
    verification: {
      commandsBound: false;
      commandCount: 0;
    };
    activationScopeCaps: {
      bound: false;
      maxFiles: null;
      maxLines: null;
    };
    postMergeObservations: {
      bound: false;
      fresh: false;
    };
  };
  blockers: RuntimeReleaseCanaryRollbackEvidenceBlocker[];
  authorityBlockers: readonly [
    'protected-remote-pr-unbound',
    'signed-source-and-diff-unbound',
    'verification-commands-unbound',
    'activation-scope-caps-unbound',
    'post-merge-observations-unbound',
    'deployment-consumer-absent',
    'rollback-consumer-absent',
    'activation-authority-unbound',
  ];
}

interface PinnedEvidenceArtifact {
  envelope: Buffer;
  manifest: Buffer;
  trustRoot: Buffer;
}

function bytes(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
}

function pinArtifact(
  artifact: RuntimeReleaseCanaryRollbackEvidenceArtifact,
): PinnedEvidenceArtifact {
  return {
    envelope: bytes(artifact.envelope),
    manifest: bytes(artifact.manifest),
    trustRoot: bytes(artifact.trustRoot),
  };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function blocker(
  code: RuntimeReleaseCanaryRollbackEvidenceBlockerCode,
  detail: string,
): RuntimeReleaseCanaryRollbackEvidenceBlocker {
  return { code, detail };
}

function verifiedRelease(
  result: Extract<VerifyRuntimeReleaseEvidenceEnvelopeResult, { ok: true }>,
  envelopeSha256: string,
): RuntimeReleaseCanaryRollbackVerifiedRelease {
  return {
    envelopeSha256,
    expiresAt: result.expiresAt,
    issuedAt: result.issuedAt,
    keyId: result.keyId,
    manifestDigest: result.manifestDigest,
    revision: result.expectedRevision,
    signatureVerified: true,
  };
}

function decision(
  verdict: RuntimeReleaseCanaryRollbackEvidenceDecision['verdict'],
  blockers: RuntimeReleaseCanaryRollbackEvidenceBlocker[],
  bindings: RuntimeReleaseCanaryRollbackEvidenceDecision['immutableBindings'],
  candidate: RuntimeReleaseCanaryRollbackVerifiedRelease | null,
  rollback: RuntimeReleaseCanaryRollbackVerifiedRelease | null,
  declaredManifestDigest: string | null,
): RuntimeReleaseCanaryRollbackEvidenceDecision {
  const releasePairVerified = verdict === 'release-pair-verified';
  return {
    schemaVersion: RUNTIME_RELEASE_CANARY_ROLLBACK_EVIDENCE_SCHEMA_VERSION,
    authority: RUNTIME_RELEASE_CANARY_ROLLBACK_EVIDENCE_AUTHORITY,
    verdict,
    evidenceReady: false,
    releasePairVerified,
    observationEnabled: verdict !== 'disabled',
    deployCanaryPermitted: false,
    rollbackPermitted: false,
    activationPermitted: false,
    executionPerformed: false,
    immutableBindings: bindings,
    candidate,
    rollback,
    rollbackTarget: {
      declaredManifestDigest,
      verifiedManifestDigest: rollback?.manifestDigest ?? null,
      matched: releasePairVerified,
    },
    admissionBoundary: {
      protectedRemotePr: {
        bound: false,
        branchProtectionBound: false,
        localFallbackDisabled: false,
        selfTargetExcluded: false,
      },
      signedSourceAndDiff: { bound: false, current: false },
      verification: { commandsBound: false, commandCount: 0 },
      activationScopeCaps: { bound: false, maxFiles: null, maxLines: null },
      postMergeObservations: { bound: false, fresh: false },
    },
    blockers,
    authorityBlockers: [
      'protected-remote-pr-unbound',
      'signed-source-and-diff-unbound',
      'verification-commands-unbound',
      'activation-scope-caps-unbound',
      'post-merge-observations-unbound',
      'deployment-consumer-absent',
      'rollback-consumer-absent',
      'activation-authority-unbound',
    ],
  };
}

/**
 * Verify a candidate release and its rollback target as one immutable release
 * pair. This observer intentionally does not claim fleet evidence readiness:
 * protected PR identity, source/diff freshness, verification commands, scope
 * caps, and post-merge health must be bound by a separate admission protocol.
 */
export function evaluateRuntimeReleaseCanaryRollbackEvidence(
  input: RuntimeReleaseCanaryRollbackEvidenceInput,
): RuntimeReleaseCanaryRollbackEvidenceDecision {
  if (input.observationEnabled !== true) {
    return decision(
      'disabled',
      [blocker('observation-disabled', 'Canary and rollback evidence observation is disabled.')],
      {
        candidateEnvelopeSha256: null,
        rollbackEnvelopeSha256: null,
        trustRootSha256: null,
        exactBytesPinned: false,
      },
      null,
      null,
      null,
    );
  }

  const candidate = pinArtifact(input.candidate);
  const rollback = pinArtifact(input.rollback);
  const candidateEnvelopeSha256 = sha256(candidate.envelope);
  const rollbackEnvelopeSha256 = sha256(rollback.envelope);
  const candidateTrustRootSha256 = sha256(candidate.trustRoot);
  const rollbackTrustRootSha256 = sha256(rollback.trustRoot);
  const bindings = {
    candidateEnvelopeSha256,
    rollbackEnvelopeSha256,
    trustRootSha256: candidateTrustRootSha256,
    exactBytesPinned: false,
  };
  const blockers: RuntimeReleaseCanaryRollbackEvidenceBlocker[] = [];
  const expected = input.expected;
  const expectedBindingsValid =
    SHA256_RE.test(expected.candidateEnvelopeSha256) &&
    SHA256_RE.test(expected.candidateManifestDigest) &&
    REVISION_RE.test(expected.candidateRevision) &&
    SHA256_RE.test(expected.rollbackEnvelopeSha256) &&
    SHA256_RE.test(expected.rollbackManifestDigest) &&
    REVISION_RE.test(expected.rollbackRevision) &&
    SHA256_RE.test(expected.trustRootSha256);
  if (!expectedBindingsValid) {
    blockers.push(blocker(
      'expected-binding-invalid',
      'One or more caller-pinned release evidence identities are invalid.',
    ));
  }
  if (expectedBindingsValid &&
    !equalDigest(candidateEnvelopeSha256, expected.candidateEnvelopeSha256)) {
    blockers.push(blocker(
      'candidate-envelope-identity-mismatch',
      'Candidate envelope bytes do not match the caller-pinned digest.',
    ));
  }
  if (expectedBindingsValid &&
    !equalDigest(rollbackEnvelopeSha256, expected.rollbackEnvelopeSha256)) {
    blockers.push(blocker(
      'rollback-envelope-identity-mismatch',
      'Rollback envelope bytes do not match the caller-pinned digest.',
    ));
  }
  if (expectedBindingsValid &&
    (!equalDigest(candidateTrustRootSha256, expected.trustRootSha256) ||
      !equalDigest(rollbackTrustRootSha256, expected.trustRootSha256))) {
    blockers.push(blocker(
      'trust-root-identity-mismatch',
      'Release trust-root bytes do not match the caller-pinned digest.',
    ));
  }
  if (!equalDigest(candidateTrustRootSha256, rollbackTrustRootSha256)) {
    blockers.push(blocker(
      'trust-root-pair-mismatch',
      'Candidate and rollback evidence do not use the same canonical trust root.',
    ));
  }
  bindings.exactBytesPinned = blockers.length === 0;

  const candidateVerification = verifyRuntimeReleaseEvidenceEnvelope({
    envelope: candidate.envelope,
    manifest: candidate.manifest,
    trustRoot: candidate.trustRoot,
  });
  const rollbackVerification = verifyRuntimeReleaseEvidenceEnvelope({
    envelope: rollback.envelope,
    manifest: rollback.manifest,
    trustRoot: rollback.trustRoot,
  });
  const candidateManifest = parseUnsignedRuntimeReleaseManifest(candidate.manifest);
  if (candidateManifest.ok && candidateManifest.manifest.schemaVersion !== 3) {
    blockers.push(blocker(
      'candidate-manifest-schema-unsupported',
      'The candidate must use current runtime release manifest schema v3.',
    ));
  }
  if (!candidateVerification.ok) {
    blockers.push(blocker(
      'candidate-signature-invalid',
      `Candidate signed release evidence is invalid: ${candidateVerification.reason}`,
    ));
  }
  if (!rollbackVerification.ok) {
    blockers.push(blocker(
      'rollback-signature-invalid',
      `Rollback signed release evidence is invalid: ${rollbackVerification.reason}`,
    ));
  }

  const verifiedCandidate = candidateVerification.ok
    ? verifiedRelease(candidateVerification, candidateEnvelopeSha256)
    : null;
  const verifiedRollback = rollbackVerification.ok
    ? verifiedRelease(rollbackVerification, rollbackEnvelopeSha256)
    : null;
  const declaredTarget = candidateVerification.ok
    ? candidateVerification.rollbackTargetManifestDigest
    : null;

  if (expectedBindingsValid && candidateVerification.ok &&
    (candidateVerification.manifestDigest !== expected.candidateManifestDigest ||
      candidateVerification.expectedRevision !== expected.candidateRevision)) {
    blockers.push(blocker(
      'candidate-release-identity-mismatch',
      'Verified candidate release identity does not match the caller-pinned manifest and revision.',
    ));
  }
  if (expectedBindingsValid && rollbackVerification.ok &&
    (rollbackVerification.manifestDigest !== expected.rollbackManifestDigest ||
      rollbackVerification.expectedRevision !== expected.rollbackRevision)) {
    blockers.push(blocker(
      'rollback-release-identity-mismatch',
      'Verified rollback release identity does not match the caller-pinned manifest and revision.',
    ));
  }
  if (candidateVerification.ok && declaredTarget === null) {
    blockers.push(blocker(
      'rollback-target-missing',
      'The signed candidate manifest does not declare a rollback target.',
    ));
  }
  if (candidateVerification.ok && rollbackVerification.ok &&
    declaredTarget !== null &&
    declaredTarget !== rollbackVerification.manifestDigest) {
    blockers.push(blocker(
      'rollback-target-mismatch',
      'The signed candidate rollback target does not match the verified rollback manifest.',
    ));
  }
  if (candidateVerification.ok && rollbackVerification.ok &&
    (candidateVerification.manifestDigest === rollbackVerification.manifestDigest ||
      candidateVerification.expectedRevision === rollbackVerification.expectedRevision)) {
    blockers.push(blocker(
      'rollback-self-reference',
      'Candidate and rollback evidence must identify distinct releases and revisions.',
    ));
  }

  return decision(
    blockers.length === 0 ? 'release-pair-verified' : 'blocked',
    blockers,
    bindings,
    verifiedCandidate,
    verifiedRollback,
    declaredTarget,
  );
}

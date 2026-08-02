import {
  MAX_AUTOMERGE_POLICY_FILES,
  MAX_AUTOMERGE_POLICY_LINES,
  resolveAutoMergeScopePolicy,
} from '../foundry/automerge-scope-policy.js';

export const AUTOMERGE_CANARY_PROMOTION_READINESS_SCHEMA_VERSION = 2 as const;
export const AUTOMERGE_CANARY_PROMOTION_AUTHORITY = 'observation-only' as const;

const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_REMOTE_PROTECTION_AGE_MS = 10 * 60_000;
const MAX_SCOPE_IDENTITY_AGE_MS = 10 * 60_000;
const MAX_POST_MERGE_COHORT_AGE_MS = 30 * 24 * 60 * 60_000;
const DIGEST_RE = /^[a-f0-9]{64}$/;

export type AutoMergeCanaryPromotionBlockerCode =
  | 'invalid-observation-time'
  | 'canary-source-unhealthy'
  | 'canary-state-ineligible'
  | 'canary-observation-incomplete'
  | 'canary-sample-insufficient'
  | 'canary-binding-mismatch'
  | 'canary-inspection-error'
  | 'remote-protection-unavailable'
  | 'verification-coverage-incomplete'
  | 'evidence-signing-unavailable'
  | 'release-evidence-incomplete'
  | 'rollback-evidence-unavailable'
  | 'post-merge-source-unhealthy'
  | 'post-merge-cohort-insufficient'
  | 'post-merge-adverse-observed'
  | 'scope-caps-unavailable'
  | 'scope-caps-exceed-policy'
  | 'scope-identity-unavailable'
  | 'scope-identity-mismatch'
  | 'scope-identity-stale'
  | 'unsafe-merge-policy'
  | 'enforcement-unsupported';

export interface AutoMergeCanaryPromotionBlocker {
  code: AutoMergeCanaryPromotionBlockerCode;
  severity: 'critical' | 'high';
  detail: string;
}

export interface AutoMergeCanaryPromotionReadinessInput {
  observedAtMs: number;
  canary: {
    sourceState: 'missing' | 'healthy' | 'degraded';
    active: boolean;
    state: 'shadow' | 'halt-requested' | 'halted' | 'critical' | 'inactive';
    observationCompletedAt: string | null;
    attempts: number;
    eligible: number;
    rejected: number;
    requiredAttempts: number;
    requiredEligible: number;
    requirementsBound: boolean;
    bindingMismatches: number;
    inspectionErrors: number;
  };
  remoteProtection: {
    configured: 'exact' | 'partial' | 'missing';
    live: 'protected' | 'unprotected' | 'unavailable';
    coverage: 'complete' | 'partial' | 'none';
    observedAt: string | null;
  };
  verification: {
    sourceState: 'missing' | 'healthy' | 'degraded';
    enrolledRepos: number;
    mergeGradeRepos: number;
    noCommandRepos: number;
  };
  evidenceSigning: {
    sourceState: 'missing' | 'healthy' | 'degraded';
    signed: boolean;
    writable: boolean;
    expiresAt: string | null;
  };
  release: {
    sourceState: 'missing' | 'healthy' | 'degraded';
    signatureVerified: boolean;
    manifestComplete: boolean;
    artifactBound: boolean;
    serviceInvocationBound: boolean;
    configurationBound: boolean;
    expiresAt: string | null;
    rollbackBound: boolean;
  };
  postMerge: {
    sourceState: 'missing' | 'healthy' | 'degraded';
    complete: boolean;
    denominatorComplete: boolean;
    releasedCohorts: number;
    adverseObservations: number;
    latestCompletedAt: string | null;
  };
  policy: {
    allowSelfMerge: boolean;
    allowWithoutVerification: boolean;
    localMergeFallback: boolean;
    maxAutomergeFiles: number | null;
    maxAutomergeLines: number | null;
  };
  scopeIdentity: {
    sourceState: 'missing' | 'healthy' | 'degraded';
    expectedPolicyDigest: string | null;
    expectedConfigDigest: string | null;
    evidencePolicyDigest: string | null;
    evidenceConfigDigest: string | null;
    currentPolicyDigest: string | null;
    currentConfigDigest: string | null;
    currentScopePolicyDigest: string | null;
    observedAt: string | null;
  };
}

export interface AutoMergeCanaryPromotionReadiness {
  schemaVersion: typeof AUTOMERGE_CANARY_PROMOTION_READINESS_SCHEMA_VERSION;
  authority: typeof AUTOMERGE_CANARY_PROMOTION_AUTHORITY;
  observedAt: string | null;
  verdict: 'blocked' | 'evidence-ready';
  evidenceReady: boolean;
  activationPermitted: false;
  scopeCaps: {
    maxFiles: number | null;
    maxLines: number | null;
    policyMaxFiles: number;
    policyMaxLines: number;
    source: 'explicit-config' | 'default-config' | 'mixed-config' | 'invalid-config';
    scopePolicyDigest: string | null;
  };
  scopeIdentity: {
    state: 'matched' | 'mismatched' | 'stale' | 'unavailable';
    source: 'controller-attested-canary-store' | 'unavailable';
    observedAt: string | null;
    policyDigest: string | null;
    configDigest: string | null;
  };
  blockers: AutoMergeCanaryPromotionBlocker[];
  authorityBlockers: AutoMergeCanaryPromotionBlocker[];
  primaryBlocker: AutoMergeCanaryPromotionBlocker;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalEpochTime(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function canonicalTime(value: string | null): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function freshTime(value: string | null, nowMs: number, maxAgeMs: number): boolean {
  const parsed = canonicalTime(value);
  return parsed !== null &&
    parsed <= nowMs + MAX_FUTURE_SKEW_MS &&
    nowMs - parsed <= maxAgeMs;
}

function unexpired(value: string | null, nowMs: number): boolean {
  const parsed = canonicalTime(value);
  return parsed !== null &&
    parsed <= nowMs + 366 * 24 * 60 * 60_000 &&
    parsed > nowMs;
}

function blocker(
  code: AutoMergeCanaryPromotionBlockerCode,
  severity: AutoMergeCanaryPromotionBlocker['severity'],
  detail: string,
): AutoMergeCanaryPromotionBlocker {
  return { code, severity, detail };
}

/**
 * Explain whether bounded evidence is complete enough to consider a future
 * promotion. This contract never grants activation, merge, deploy, or rollback
 * authority, even when every observational prerequisite is present.
 */
export function evaluateAutoMergeCanaryPromotionReadiness(
  input: AutoMergeCanaryPromotionReadinessInput,
): AutoMergeCanaryPromotionReadiness {
  const blockers: AutoMergeCanaryPromotionBlocker[] = [];
  const observedAt = canonicalEpochTime(input.observedAtMs);
  const validNow = observedAt !== null;

  if (!validNow) {
    blockers.push(blocker(
      'invalid-observation-time',
      'critical',
      'The promotion observation time is invalid.',
    ));
  }

  const nowMs = validNow ? input.observedAtMs : 0;
  const canaryCountsValid = [
    input.canary.attempts,
    input.canary.eligible,
    input.canary.rejected,
    input.canary.requiredAttempts,
    input.canary.requiredEligible,
    input.canary.bindingMismatches,
    input.canary.inspectionErrors,
  ].every(nonNegativeInteger);
  const observedOutcomeCount = input.canary.eligible +
    input.canary.rejected +
    input.canary.bindingMismatches +
    input.canary.inspectionErrors;
  const canaryCountsCoherent = canaryCountsValid &&
    Number.isSafeInteger(observedOutcomeCount) &&
    input.canary.attempts === observedOutcomeCount &&
    input.canary.requiredEligible <= input.canary.requiredAttempts;

  if (input.canary.sourceState !== 'healthy') {
    blockers.push(blocker(
      'canary-source-unhealthy',
      'critical',
      'The shadow canary source is missing or degraded.',
    ));
  }
  if (input.canary.active !== true || input.canary.state !== 'shadow') {
    blockers.push(blocker(
      'canary-state-ineligible',
      'critical',
      'The shadow canary is not active in its bounded observation state.',
    ));
  }
  if (!validNow || !freshTime(
    input.canary.observationCompletedAt,
    nowMs,
    MAX_POST_MERGE_COHORT_AGE_MS,
  )) {
    blockers.push(blocker(
      'canary-observation-incomplete',
      'high',
      'The bounded shadow observation has not completed with fresh evidence.',
    ));
  }
  if (
    !canaryCountsCoherent ||
    input.canary.requirementsBound !== true ||
    input.canary.requiredAttempts < 1 ||
    input.canary.requiredEligible < 1 ||
    input.canary.attempts < input.canary.requiredAttempts ||
    input.canary.eligible < input.canary.requiredEligible
  ) {
    blockers.push(blocker(
      'canary-sample-insufficient',
      'high',
      'The shadow canary has no eligible observed attempt.',
    ));
  }
  if (!canaryCountsCoherent || input.canary.bindingMismatches !== 0) {
    blockers.push(blocker(
      'canary-binding-mismatch',
      'critical',
      'The shadow canary observed repository or policy binding mismatches.',
    ));
  }
  if (!canaryCountsCoherent || input.canary.inspectionErrors !== 0) {
    blockers.push(blocker(
      'canary-inspection-error',
      'critical',
      'The shadow canary observed classifier inspection errors.',
    ));
  }

  if (
    input.remoteProtection.configured !== 'exact' ||
    input.remoteProtection.live !== 'protected' ||
    input.remoteProtection.coverage !== 'complete' ||
    !validNow ||
    !freshTime(input.remoteProtection.observedAt, nowMs, MAX_REMOTE_PROTECTION_AGE_MS)
  ) {
    blockers.push(blocker(
      'remote-protection-unavailable',
      'critical',
      'Exact, complete, and fresh protected-remote evidence is unavailable.',
    ));
  }

  const verificationCountsValid = [
    input.verification.enrolledRepos,
    input.verification.mergeGradeRepos,
    input.verification.noCommandRepos,
  ].every(nonNegativeInteger);
  if (
    input.verification.sourceState !== 'healthy' ||
    !verificationCountsValid ||
    input.verification.enrolledRepos < 1 ||
    input.verification.mergeGradeRepos !== input.verification.enrolledRepos ||
    input.verification.noCommandRepos !== 0
  ) {
    blockers.push(blocker(
      'verification-coverage-incomplete',
      'critical',
      'Every enrolled repository must have healthy nonempty merge-grade verification.',
    ));
  }

  if (
    input.evidenceSigning.sourceState !== 'healthy' ||
    input.evidenceSigning.signed !== true ||
    input.evidenceSigning.writable !== true ||
    !validNow ||
    !unexpired(input.evidenceSigning.expiresAt, nowMs)
  ) {
    blockers.push(blocker(
      'evidence-signing-unavailable',
      'critical',
      'Writable, signed, unexpired evidence is unavailable.',
    ));
  }

  if (
    input.release.sourceState !== 'healthy' ||
    input.release.signatureVerified !== true ||
    input.release.manifestComplete !== true ||
    input.release.artifactBound !== true ||
    input.release.serviceInvocationBound !== true ||
    input.release.configurationBound !== true ||
    !validNow ||
    !unexpired(input.release.expiresAt, nowMs)
  ) {
    blockers.push(blocker(
      'release-evidence-incomplete',
      'critical',
      'Signed release evidence does not bind the complete runtime and invocation.',
    ));
  }
  if (input.release.rollbackBound !== true) {
    blockers.push(blocker(
      'rollback-evidence-unavailable',
      'critical',
      'No validated rollback target is bound to the release evidence.',
    ));
  }

  const postMergeCountsValid = [
    input.postMerge.releasedCohorts,
    input.postMerge.adverseObservations,
  ].every(nonNegativeInteger);
  if (
    input.postMerge.sourceState !== 'healthy' ||
    input.postMerge.complete !== true ||
    input.postMerge.denominatorComplete !== true ||
    !postMergeCountsValid
  ) {
    blockers.push(blocker(
      'post-merge-source-unhealthy',
      'critical',
      'Post-merge evidence is missing, degraded, incomplete, or malformed.',
    ));
  }
  if (
    !postMergeCountsValid ||
    input.postMerge.releasedCohorts < 1 ||
    !validNow ||
    !freshTime(input.postMerge.latestCompletedAt, nowMs, MAX_POST_MERGE_COHORT_AGE_MS)
  ) {
    blockers.push(blocker(
      'post-merge-cohort-insufficient',
      'high',
      'No fresh released post-merge stability cohort is available.',
    ));
  }
  if (!postMergeCountsValid || input.postMerge.adverseObservations !== 0) {
    blockers.push(blocker(
      'post-merge-adverse-observed',
      'critical',
      'The bounded post-merge evidence contains an adverse observation.',
    ));
  }

  const scopePolicy = resolveAutoMergeScopePolicy({
    maxAutomergeFiles: input.policy.maxAutomergeFiles,
    maxAutomergeLines: input.policy.maxAutomergeLines,
  });
  const maxFiles = scopePolicy.ok ? scopePolicy.policy.maxFiles : null;
  const maxLines = scopePolicy.ok ? scopePolicy.policy.maxLines : null;
  const scopeSource = !scopePolicy.ok
    ? 'invalid-config' as const
    : scopePolicy.policy.source === 'explicit'
      ? 'explicit-config' as const
      : scopePolicy.policy.source === 'default' ? 'default-config' as const : 'mixed-config' as const;
  if (!scopePolicy.ok || scopePolicy.policy.source !== 'explicit') {
    blockers.push(blocker(
      'scope-caps-unavailable',
      'critical',
      'Explicit canonical file and line scope caps are required for promotion evidence.',
    ));
  }
  if (!scopePolicy.ok && scopePolicy.reasons.some((reason) => reason.endsWith('exceeds-policy'))) {
    blockers.push(blocker(
      'scope-caps-exceed-policy',
      'critical',
      'Configured scope caps exceed the conservative auto-merge policy maximum.',
    ));
  }

  const identity = input.scopeIdentity ?? {
    sourceState: 'missing' as const,
    expectedPolicyDigest: null,
    expectedConfigDigest: null,
    evidencePolicyDigest: null,
    evidenceConfigDigest: null,
    currentPolicyDigest: null,
    currentConfigDigest: null,
    currentScopePolicyDigest: null,
    observedAt: null,
  };
  const identityDigests = [
    identity.expectedPolicyDigest,
    identity.expectedConfigDigest,
    identity.evidencePolicyDigest,
    identity.evidenceConfigDigest,
    identity.currentPolicyDigest,
    identity.currentConfigDigest,
    identity.currentScopePolicyDigest,
  ];
  const identityAvailable = identity.sourceState === 'healthy' &&
    identityDigests.every((value) => typeof value === 'string' && DIGEST_RE.test(value));
  const identityMatched = identityAvailable &&
    identity.expectedPolicyDigest === identity.evidencePolicyDigest &&
    identity.expectedPolicyDigest === identity.currentPolicyDigest &&
    identity.expectedConfigDigest === identity.evidenceConfigDigest &&
    identity.expectedConfigDigest === identity.currentConfigDigest &&
    scopePolicy.ok && identity.currentScopePolicyDigest === scopePolicy.policy.digest;
  const identityFresh = identityAvailable && validNow &&
    freshTime(identity.observedAt, nowMs, MAX_SCOPE_IDENTITY_AGE_MS);
  const identityState = !identityAvailable
    ? 'unavailable' as const
    : !identityMatched ? 'mismatched' as const : !identityFresh ? 'stale' as const : 'matched' as const;
  if (!identityAvailable) {
    blockers.push(blocker(
      'scope-identity-unavailable',
      'critical',
      'Attested canary policy and configuration identity evidence is unavailable.',
    ));
  } else if (!identityMatched) {
    blockers.push(blocker(
      'scope-identity-mismatch',
      'critical',
      'Current scope policy does not match the exact canary state and evidence identity.',
    ));
  } else if (!identityFresh && validNow) {
    blockers.push(blocker(
      'scope-identity-stale',
      'critical',
      'The matching canary scope-policy identity evidence is stale.',
    ));
  }

  if (
    input.policy.allowSelfMerge !== false ||
    input.policy.allowWithoutVerification !== false ||
    input.policy.localMergeFallback !== false
  ) {
    blockers.push(blocker(
      'unsafe-merge-policy',
      'critical',
      'Self-merge, verification bypass, and local merge fallback must remain disabled.',
    ));
  }

  const authorityBlockers = [blocker(
    'enforcement-unsupported',
    'critical',
    'Enforcement remains unsupported and requires a separately reviewed authority protocol.',
  )];
  const evidenceReady = blockers.length === 0;
  return {
    schemaVersion: AUTOMERGE_CANARY_PROMOTION_READINESS_SCHEMA_VERSION,
    authority: AUTOMERGE_CANARY_PROMOTION_AUTHORITY,
    observedAt,
    verdict: evidenceReady ? 'evidence-ready' : 'blocked',
    evidenceReady,
    activationPermitted: false,
    scopeCaps: {
      maxFiles,
      maxLines,
      policyMaxFiles: MAX_AUTOMERGE_POLICY_FILES,
      policyMaxLines: MAX_AUTOMERGE_POLICY_LINES,
      source: scopeSource,
      scopePolicyDigest: scopePolicy.ok ? scopePolicy.policy.digest : null,
    },
    scopeIdentity: {
      state: identityState,
      source: identityAvailable ? 'controller-attested-canary-store' : 'unavailable',
      observedAt: canonicalTime(identity.observedAt) === null ? null : identity.observedAt,
      policyDigest: identityAvailable ? identity.currentPolicyDigest : null,
      configDigest: identityAvailable ? identity.currentConfigDigest : null,
    },
    blockers,
    authorityBlockers,
    primaryBlocker: blockers[0] ?? authorityBlockers[0]!,
  };
}

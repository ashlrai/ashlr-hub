/** Opaque, bounded identities for outer attempts and their child candidates. */

import { createHash, randomUUID } from 'node:crypto';

const OUTER_ATTEMPT_ID_RE = /^attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANDIDATE_ATTEMPT_ID_RE = /^attempt-[a-f0-9]{32}$/;
const CANDIDATE_DERIVATION_DOMAIN = 'ashlr:attempt-candidate:v1';
const SAFE_EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

export type OuterAttemptIdentity = `attempt-${string}`;
export type CandidateAttemptIdentity = `attempt-${string}`;

export function isOuterAttemptIdentity(value: unknown): value is OuterAttemptIdentity {
  return typeof value === 'string' && OUTER_ATTEMPT_ID_RE.test(value);
}

export function isCandidateAttemptIdentity(value: unknown): value is CandidateAttemptIdentity {
  return typeof value === 'string' && CANDIDATE_ATTEMPT_ID_RE.test(value);
}

export function isSafeExecutionIdentity(value: unknown): value is string {
  return typeof value === 'string' && SAFE_EXECUTION_ID_RE.test(value);
}

/** Validate caller-supplied ids before they reach run-state or log filenames. */
export function assertSafeExecutionIdentity(value: string): string {
  if (!isSafeExecutionIdentity(value)) {
    throw new TypeError('execution identity must be 1-160 path-safe characters');
  }
  return value;
}

/**
 * Allocate an identity before any attempt work begins. The value contains only
 * cryptographic randomness, so no repo, prompt, goal, or work-item text leaks.
 */
export function createOuterAttemptIdentity(): OuterAttemptIdentity {
  return `attempt-${randomUUID()}`;
}

/**
 * Derive a stable child identity from an outer attempt and zero-based ordinal.
 * Domain-separated structured hashing keeps this derivation unambiguous.
 */
export function deriveCandidateAttemptIdentity(
  outerAttemptIdentity: string,
  candidateIndex: number,
): CandidateAttemptIdentity {
  if (!isOuterAttemptIdentity(outerAttemptIdentity)) {
    throw new TypeError('outer attempt identity must be a valid generated attempt id');
  }
  if (
    !Number.isSafeInteger(candidateIndex) ||
    candidateIndex < 0
  ) {
    throw new RangeError('candidate index must be a non-negative safe integer');
  }

  const digest = createHash('sha256')
    .update(JSON.stringify([
      CANDIDATE_DERIVATION_DOMAIN,
      outerAttemptIdentity,
      candidateIndex,
    ]))
    .digest('hex')
    .slice(0, 32);
  return `attempt-${digest}`;
}

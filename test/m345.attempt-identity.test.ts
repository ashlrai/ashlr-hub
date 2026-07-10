import { describe, expect, it } from 'vitest';
import {
  assertSafeExecutionIdentity,
  createOuterAttemptIdentity,
  deriveCandidateAttemptIdentity,
  isCandidateAttemptIdentity,
  isOuterAttemptIdentity,
} from '../src/core/fleet/attempt-identity.js';

const outerAttemptIdentity = 'attempt-018f6d2e-7c50-4f15-8a2c-6efc97fb87a1';

describe('attempt identity', () => {
  it('creates opaque strong outer identities with a bounded durable format', () => {
    const first = createOuterAttemptIdentity();
    const second = createOuterAttemptIdentity();

    expect(isOuterAttemptIdentity(first)).toBe(true);
    expect(isOuterAttemptIdentity(second)).toBe(true);
    expect(first).not.toBe(second);
    expect(first.length).toBe(44);
  });

  it('derives stable, distinct candidate identities from only parent and ordinal', () => {
    const first = deriveCandidateAttemptIdentity(outerAttemptIdentity, 0);
    const replay = deriveCandidateAttemptIdentity(outerAttemptIdentity, 0);
    const sibling = deriveCandidateAttemptIdentity(outerAttemptIdentity, 1);
    const otherParent = deriveCandidateAttemptIdentity(
      'attempt-b4d57ea2-3be5-4fa1-a22a-d769bc97bd31',
      0,
    );

    expect(first).toBe('attempt-1a45bb1ab0c7ea8f1975ba8258a6119c');
    expect(replay).toBe(first);
    expect(sibling).not.toBe(first);
    expect(otherParent).not.toBe(first);
    expect(isCandidateAttemptIdentity(first)).toBe(true);
    expect(first.length).toBe(40);
  });

  it('validates outer and candidate namespaces explicitly', () => {
    expect(isOuterAttemptIdentity(outerAttemptIdentity)).toBe(true);
    expect(isOuterAttemptIdentity('attempt-91bf1add23a49fa052f1f3e7bba3e16c')).toBe(false);
    expect(isOuterAttemptIdentity('work:item-1')).toBe(false);
    expect(isOuterAttemptIdentity('/private/repo')).toBe(false);
    expect(isCandidateAttemptIdentity('attempt-91bf1add23a49fa052f1f3e7bba3e16c')).toBe(true);
    expect(isCandidateAttemptIdentity(outerAttemptIdentity)).toBe(false);
  });

  it('rejects malformed parents and every unbounded candidate ordinal', () => {
    const invalidIndexes = [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    expect(() => deriveCandidateAttemptIdentity('/private/repo/RAW_WORK_ITEM', 0))
      .toThrow('outer attempt identity must be a valid generated attempt id');
    for (const index of invalidIndexes) {
      expect(() => deriveCandidateAttemptIdentity(outerAttemptIdentity, index))
        .toThrow('candidate index must be a non-negative safe integer');
    }
    expect(() => deriveCandidateAttemptIdentity(outerAttemptIdentity, Number.MAX_SAFE_INTEGER))
      .not.toThrow();
  });

  it('never returns or reports sensitive caller text', () => {
    const sensitive = '/Users/private/repo RAW_PROMPT secret goal raw work item';
    let message = '';
    try {
      deriveCandidateAttemptIdentity(sensitive, 0);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(sensitive);
    expect(createOuterAttemptIdentity()).not.toContain(sensitive);
    expect(deriveCandidateAttemptIdentity(outerAttemptIdentity, 2)).not.toContain(sensitive);
  });

  it('rejects path-like, control-character, and oversized execution ids', () => {
    expect(assertSafeExecutionIdentity(outerAttemptIdentity)).toBe(outerAttemptIdentity);
    for (const invalid of ['../escape', '/absolute', 'bad/id', 'bad\nline', '', 'x'.repeat(161)]) {
      expect(() => assertSafeExecutionIdentity(invalid))
        .toThrow('execution identity must be 1-160 path-safe characters');
    }
  });
});

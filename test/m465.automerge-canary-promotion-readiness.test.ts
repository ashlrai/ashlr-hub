import { describe, expect, it } from 'vitest';

import {
  evaluateAutoMergeCanaryPromotionReadiness,
  type AutoMergeCanaryPromotionReadinessInput,
} from '../src/core/fleet/automerge-canary-promotion-readiness.js';

const NOW = Date.parse('2026-07-29T02:00:00.000Z');

function readyInput(): AutoMergeCanaryPromotionReadinessInput {
  return {
    observedAtMs: NOW,
    canary: {
      sourceState: 'healthy',
      active: true,
      state: 'shadow',
      observationCompletedAt: '2026-07-29T01:55:00.000Z',
      attempts: 12,
      eligible: 4,
      rejected: 8,
      requiredAttempts: 10,
      requiredEligible: 3,
      requirementsBound: true,
      bindingMismatches: 0,
      inspectionErrors: 0,
    },
    remoteProtection: {
      configured: 'exact',
      live: 'protected',
      coverage: 'complete',
      observedAt: '2026-07-29T01:58:00.000Z',
    },
    verification: {
      sourceState: 'healthy',
      enrolledRepos: 25,
      mergeGradeRepos: 25,
      noCommandRepos: 0,
    },
    evidenceSigning: {
      sourceState: 'healthy',
      signed: true,
      writable: true,
      expiresAt: '2026-07-29T03:00:00.000Z',
    },
    release: {
      sourceState: 'healthy',
      signatureVerified: true,
      manifestComplete: true,
      artifactBound: true,
      serviceInvocationBound: true,
      configurationBound: true,
      expiresAt: '2026-07-29T03:00:00.000Z',
      rollbackBound: true,
    },
    postMerge: {
      sourceState: 'healthy',
      complete: true,
      denominatorComplete: true,
      releasedCohorts: 2,
      adverseObservations: 0,
      latestCompletedAt: '2026-07-28T02:00:00.000Z',
    },
    policy: {
      allowSelfMerge: false,
      allowWithoutVerification: false,
      localMergeFallback: false,
      maxAutomergeFiles: 4,
      maxAutomergeLines: 150,
    },
  };
}

describe('M465 auto-merge canary promotion readiness', () => {
  it('reports complete evidence without ever granting activation authority', () => {
    const result = evaluateAutoMergeCanaryPromotionReadiness(readyInput());

    expect(result).toEqual({
      schemaVersion: 2,
      authority: 'observation-only',
      observedAt: '2026-07-29T02:00:00.000Z',
      verdict: 'evidence-ready',
      evidenceReady: true,
      activationPermitted: false,
      scopeCaps: { maxFiles: 4, maxLines: 150 },
      blockers: [],
      authorityBlockers: [{
        code: 'enforcement-unsupported',
        severity: 'critical',
        detail: 'Enforcement remains unsupported and requires a separately reviewed authority protocol.',
      }],
      primaryBlocker: {
        code: 'enforcement-unsupported',
        severity: 'critical',
        detail: 'Enforcement remains unsupported and requires a separately reviewed authority protocol.',
      },
    });
  });

  it('fails closed on incomplete verification, release, rollback, and post-merge evidence', () => {
    const input = readyInput();
    input.verification.mergeGradeRepos = 24;
    input.verification.noCommandRepos = 1;
    input.release.signatureVerified = false;
    input.release.serviceInvocationBound = false;
    input.release.rollbackBound = false;
    input.postMerge.sourceState = 'degraded';
    input.postMerge.complete = false;
    input.postMerge.releasedCohorts = 0;

    const result = evaluateAutoMergeCanaryPromotionReadiness(input);

    expect(result.verdict).toBe('blocked');
    expect(result.evidenceReady).toBe(false);
    expect(result.activationPermitted).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'verification-coverage-incomplete',
      'release-evidence-incomplete',
      'rollback-evidence-unavailable',
      'post-merge-source-unhealthy',
      'post-merge-cohort-insufficient',
    ]);
  });

  it('rejects stale protection, expired signatures, and unsafe merge policy', () => {
    const input = readyInput();
    input.remoteProtection.observedAt = '2026-07-29T01:49:59.999Z';
    input.evidenceSigning.expiresAt = '2026-07-29T02:00:00.000Z';
    input.release.expiresAt = 'not-a-time';
    input.policy.allowSelfMerge = true;
    input.policy.allowWithoutVerification = true;
    input.policy.localMergeFallback = true;

    const result = evaluateAutoMergeCanaryPromotionReadiness(input);

    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'remote-protection-unavailable',
      'evidence-signing-unavailable',
      'release-evidence-incomplete',
      'unsafe-merge-policy',
    ]);
    expect(result.activationPermitted).toBe(false);
  });

  it('fails closed when explicit scope caps are missing or malformed', () => {
    const missing = readyInput() as unknown as Record<string, Record<string, unknown>>;
    delete missing['policy']!['maxAutomergeFiles'];
    delete missing['policy']!['maxAutomergeLines'];

    const missingResult = evaluateAutoMergeCanaryPromotionReadiness(
      missing as unknown as AutoMergeCanaryPromotionReadinessInput,
    );
    expect(missingResult).toMatchObject({
      evidenceReady: false,
      activationPermitted: false,
      scopeCaps: { maxFiles: null, maxLines: null },
      blockers: [{ code: 'scope-caps-unavailable', severity: 'critical' }],
    });

    const malformed = readyInput();
    malformed.policy.maxAutomergeFiles = 1.5;
    malformed.policy.maxAutomergeLines = Number.POSITIVE_INFINITY;
    const malformedResult = evaluateAutoMergeCanaryPromotionReadiness(malformed);
    expect(malformedResult.scopeCaps).toEqual({ maxFiles: null, maxLines: null });
    expect(malformedResult.blockers.map((entry) => entry.code)).toEqual([
      'scope-caps-unavailable',
    ]);
  });

  it('withholds readiness for canary mismatches, inspection errors, and adverse outcomes', () => {
    const input = readyInput();
    input.canary.bindingMismatches = 1;
    input.canary.inspectionErrors = 1;
    input.canary.rejected = 6;
    input.postMerge.adverseObservations = 1;

    const result = evaluateAutoMergeCanaryPromotionReadiness(input);

    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'canary-binding-mismatch',
      'canary-inspection-error',
      'post-merge-adverse-observed',
    ]);
    expect(result.primaryBlocker.code).toBe('canary-binding-mismatch');
  });

  it('requires policy-bound sample thresholds and enough observed outcomes', () => {
    const input = readyInput();
    input.canary.requirementsBound = false;
    input.canary.requiredAttempts = 20;
    input.canary.requiredEligible = 5;

    expect(evaluateAutoMergeCanaryPromotionReadiness(input).blockers.map(
      (entry) => entry.code,
    )).toEqual(['canary-sample-insufficient']);

    input.canary.requirementsBound = true;
    input.canary.attempts = 20;
    input.canary.eligible = 5;
    input.canary.rejected = 15;
    expect(evaluateAutoMergeCanaryPromotionReadiness(input).evidenceReady).toBe(true);
  });

  it('fails closed on incoherent canary aggregates and threshold relationships', () => {
    const input = readyInput();
    input.canary.attempts = 2;
    input.canary.eligible = 3;
    input.canary.rejected = 0;
    input.canary.requiredAttempts = 1;
    input.canary.requiredEligible = 2;

    const result = evaluateAutoMergeCanaryPromotionReadiness(input);

    expect(result.evidenceReady).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'canary-sample-insufficient',
      'canary-binding-mismatch',
      'canary-inspection-error',
    ]);
  });

  it('requires a complete post-merge eligible denominator', () => {
    const input = readyInput();
    input.postMerge.denominatorComplete = false;

    const result = evaluateAutoMergeCanaryPromotionReadiness(input);

    expect(result.evidenceReady).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'post-merge-source-unhealthy',
    ]);
  });

  it('rejects truthy malformed booleans instead of treating them as evidence', () => {
    const input = readyInput() as unknown as Record<string, Record<string, unknown>>;
    input['canary']!['active'] = 'false';
    input['canary']!['requirementsBound'] = 'yes';
    input['evidenceSigning']!['signed'] = 'false';
    input['release']!['signatureVerified'] = 'yes';
    input['postMerge']!['complete'] = 'yes';
    input['policy']!['allowSelfMerge'] = 0;

    const result = evaluateAutoMergeCanaryPromotionReadiness(
      input as unknown as AutoMergeCanaryPromotionReadinessInput,
    );

    expect(result.evidenceReady).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'canary-state-ineligible',
      'canary-sample-insufficient',
      'evidence-signing-unavailable',
      'release-evidence-incomplete',
      'post-merge-source-unhealthy',
      'unsafe-merge-policy',
    ]);
  });

  it('does not echo raw repositories, paths, prompts, or evidence payloads', () => {
    const input = {
      ...readyInput(),
      rawRepo: '/private/customer/repository',
      rawPrompt: 'private prompt canary',
      rawDiff: 'secret diff canary',
      stdout: 'token stdout canary',
    };
    const serialized = JSON.stringify(evaluateAutoMergeCanaryPromotionReadiness(input));

    for (const forbidden of [
      '/private/customer/repository',
      'private prompt canary',
      'secret diff canary',
      'token stdout canary',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns deterministic critical blockers for malformed counts and time', () => {
    const input = readyInput();
    input.observedAtMs = Number.NaN;
    input.canary.attempts = -1;
    input.verification.enrolledRepos = Number.POSITIVE_INFINITY;
    input.postMerge.adverseObservations = -1;

    const result = evaluateAutoMergeCanaryPromotionReadiness(input);

    expect(result.observedAt).toBeNull();
    expect(result.activationPermitted).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'invalid-observation-time',
      'canary-observation-incomplete',
      'canary-sample-insufficient',
      'canary-binding-mismatch',
      'canary-inspection-error',
      'remote-protection-unavailable',
      'verification-coverage-incomplete',
      'evidence-signing-unavailable',
      'release-evidence-incomplete',
      'post-merge-source-unhealthy',
      'post-merge-cohort-insufficient',
      'post-merge-adverse-observed',
    ]);
  });

  it('fails closed instead of throwing for epoch values outside the Date range', () => {
    const input = readyInput();
    input.observedAtMs = Number.MAX_SAFE_INTEGER;

    expect(() => evaluateAutoMergeCanaryPromotionReadiness(input)).not.toThrow();
    expect(evaluateAutoMergeCanaryPromotionReadiness(input)).toMatchObject({
      observedAt: null,
      evidenceReady: false,
      activationPermitted: false,
      primaryBlocker: { code: 'invalid-observation-time' },
    });
  });
});

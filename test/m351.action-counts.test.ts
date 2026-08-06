import { describe, expect, it } from 'vitest';
import { runEventSummary } from '../src/core/learning/causal.js';

const FIXED_ACTION_COUNT_KEYS = [
  'sandboxCreated',
  'spawnAttempts',
  'transientRetries',
  'proposalCaptureAttempts',
  'completenessGateRuns',
  'verifyRepairAttempts',
  'modelSteps',
  'toolSteps',
  'totalSteps',
  'diffFiles',
  'diffLines',
  'proposalCreated',
  'proposalBlocked',
  'proposalDisabled',
] as const;

describe('M351 run actionCounts metadata', () => {
  it('preserves a bounded metadata-only producer failure code', () => {
    const summary = runEventSummary({
      status: 'failed',
      outcome: 'engine-failed',
      failureCode: 'engine-command-missing',
    });

    expect(summary?.outcome).toBe('engine-failed');
    expect(summary?.failureCode).toBe('engine-command-missing');
  });

  it('drops secret-bearing or free-form failure text', () => {
    expect(runEventSummary({
      status: 'failed',
      outcome: 'engine-failed',
      failureCode: `engine-command-missing Authorization: Bearer sk-${'a'.repeat(80)}`,
    })).not.toHaveProperty('failureCode');
  });

  it('drops a failure code from a successful summary', () => {
    expect(runEventSummary({
      status: 'done',
      outcome: 'proposal-created',
      failureCode: 'contradictory-failure',
      proposalCreated: true,
    })).not.toHaveProperty('failureCode');
  });

  it.each([
    ['unknown code', 'failed', 'engine-failed', 'customer-acme-private-roadmap'],
    ['wrong outcome', 'failed', 'proposal-created', 'engine-command-missing'],
    ['wrong status', 'done', 'engine-failed', 'engine-command-missing'],
  ])('drops an authority-incoherent failure code: %s', (_case, status, outcome, failureCode) => {
    expect(runEventSummary({ status, outcome, failureCode })).not.toHaveProperty('failureCode');
  });

  it('sanitizes fixed actionCounts keys and drops unknown keys', () => {
    const summary = runEventSummary({
      runId: 'run-actions',
      actionCounts: {
        sandboxCreated: 1.9,
        spawnAttempts: -3,
        transientRetries: Number.POSITIVE_INFINITY,
        proposalCaptureAttempts: 2,
        completenessGateRuns: Number.NaN,
        verifyRepairAttempts: 4.8,
        modelSteps: 5,
        toolSteps: 'not-a-number',
        totalSteps: 9,
        diffFiles: 3,
        diffLines: 12.7,
        proposalCreated: 1,
        proposalBlocked: 0,
        proposalDisabled: 0,
        promptText: 'do not persist me',
      } as unknown as NonNullable<Parameters<typeof runEventSummary>[0]>['actionCounts'],
    });

    expect(summary?.actionCounts).toMatchObject({
      sandboxCreated: 1,
      spawnAttempts: 0,
      proposalCaptureAttempts: 2,
      verifyRepairAttempts: 4,
      modelSteps: 5,
      totalSteps: 9,
      diffFiles: 3,
      diffLines: 12,
      proposalCreated: 1,
      proposalBlocked: 0,
      proposalDisabled: 0,
    });
    expect(Object.keys(summary?.actionCounts ?? {}).every((key) =>
      (FIXED_ACTION_COUNT_KEYS as readonly string[]).includes(key)
    )).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('do not persist me');
    expect(summary?.actionCounts).not.toHaveProperty('promptText');
    expect(summary?.actionCounts).not.toHaveProperty('transientRetries');
    expect(summary?.actionCounts).not.toHaveProperty('completenessGateRuns');
    expect(summary?.actionCounts).not.toHaveProperty('toolSteps');
  });
});

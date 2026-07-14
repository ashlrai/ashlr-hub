import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  projectAutoMergeCanaryStatus,
} from '../src/core/fleet/status.js';
import type {
  AutoMergeCanaryReadResult,
  AutoMergeCanaryStateV1,
} from '../src/core/fleet/automerge-canary-store.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function observedState(): AutoMergeCanaryStateV1 {
  return {
    schemaVersion: 1,
    epochId: '22222222-2222-4222-8222-222222222222',
    revision: 5,
    previousAttestation: digest('previous'),
    mode: 'shadow',
    state: 'shadow',
    repository: {
      repositoryId: digest('private-repository'),
      fetchDestinationDigest: digest('private-fetch'),
      pushDestinationDigest: digest('private-push'),
      baseRefDigest: digest('private-base-ref'),
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
    },
    policyDigest: digest('private-policy'),
    configDigest: digest('private-config'),
    classifierDigest: digest('private-classifier'),
    pathDigest: digest('private-paths'),
    budgets: {
      maxAdmissions: 1,
      maxMerges: 1,
      maxInFlight: 1,
      minMergeIntervalMs: 86_400_000,
      leaseDurationMs: 600_000,
      observationDurationMs: 7_200_000,
    },
    counters: { admissions: 0, merges: 0, inFlight: 0, rollbacks: 0 },
    shadowCounters: {
      attempts: 4,
      eligible: 2,
      rejected: 1,
      bindingMismatches: 0,
      inspectionErrors: 1,
      casRetries: 1,
    },
    lastShadowEvidence: {
      observationDigest: digest('private-observation'),
      observedAt: '2026-07-14T12:15:00.000Z',
      outcome: 'inspection-error',
      mismatchFields: [],
      baseOid: null,
      headOid: null,
      treeOid: null,
      fileCount: 0,
      lineCount: 0,
      reasonDigest: digest('private-reason'),
      pathDigest: digest('private-paths'),
    },
    lease: { holderDigest: null, acquiredAt: null, expiresAt: null },
    observation: {
      startedAt: '2026-07-14T12:00:00.000Z',
      deadlineAt: '2026-07-14T13:00:00.000Z',
      completedAt: null,
    },
    activatedAt: '2026-07-14T11:00:00.000Z',
    updatedAt: '2026-07-14T12:15:00.000Z',
    clockHighWater: '2026-07-14T12:15:00.000Z',
    pendingEffect: null,
    blocker: null,
    attestation: digest('private-attestation'),
  };
}

function readResult(
  overrides: Partial<AutoMergeCanaryReadResult> = {},
): AutoMergeCanaryReadResult {
  return {
    enforceSupported: false,
    sourceState: 'missing',
    severity: 'none',
    status: 'inactive',
    active: false,
    state: null,
    revisions: [],
    terminalEpochs: [],
    diagnostics: [],
    limitExceeded: false,
    ...overrides,
  };
}

describe('M401 auto-merge canary Fleet OS projection', () => {
  it('is concise, explicitly non-authoritative, and preserves missing truth', () => {
    const projected = projectAutoMergeCanaryStatus(readResult());

    expect(projected).toEqual({
      authority: 'observation-only',
      policyEligible: false,
      enforceSupported: false,
      hostCancellationProven: false,
      sourceState: 'missing',
      severity: 'none',
      status: 'inactive',
      active: false,
      current: null,
      telemetry: {
        shadowCounters: null,
        outcomeRates: {
          eligible: null,
          rejected: null,
          bindingMismatch: null,
          inspectionError: null,
        },
        casRetries: null,
        revisionCapacity: {
          maximum: 64, used: null, remaining: null,
          reservedForTerminal: 1, observationWritesRemaining: null,
        },
        epochAgeMs: null,
        observationDeadlineRemainingMs: null,
        lastShadowEvidence: null,
      },
      revisionCount: null,
      terminalEpochCount: null,
      diagnostics: [],
      limitExceeded: false,
    });
    expect(projected).not.toHaveProperty('revisions');
    expect(projected).not.toHaveProperty('terminalEpochs');
  });

  it('projects bounded soak rates, timing, and a digest-free last-observation summary', () => {
    const state = observedState();
    const projected = projectAutoMergeCanaryStatus(readResult({
      sourceState: 'healthy',
      status: 'shadow',
      active: true,
      state,
      revisions: [state],
    }), new Date('2026-07-14T12:30:00.000Z'));

    expect(projected).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      enforceSupported: false,
      hostCancellationProven: false,
      current: {
        epochId: state.epochId,
        revision: 5,
        state: 'shadow',
      },
      telemetry: {
        shadowCounters: {
          attempts: 4,
          eligible: 2,
          rejected: 1,
          bindingMismatches: 0,
          inspectionErrors: 1,
          casRetries: 1,
        },
        outcomeRates: {
          eligible: 0.5,
          rejected: 0.25,
          bindingMismatch: 0,
          inspectionError: 0.25,
        },
        casRetries: 1,
        revisionCapacity: {
          maximum: 64, used: 5, remaining: 59,
          reservedForTerminal: 1, observationWritesRemaining: 58,
        },
        epochAgeMs: 5_400_000,
        observationDeadlineRemainingMs: 1_800_000,
        lastShadowEvidence: {
          observedAt: '2026-07-14T12:15:00.000Z',
          outcome: 'inspection-error',
          mismatchFields: [],
          fileCount: 0,
          lineCount: 0,
        },
      },
    });
    const serialized = JSON.stringify(projected);
    for (const privateValue of [
      state.repository.repositoryId,
      state.repository.baseOid,
      state.repository.headOid,
      state.policyDigest,
      state.configDigest,
      state.classifierDigest,
      state.pathDigest,
      state.attestation,
      state.lastShadowEvidence!.observationDigest,
      state.lastShadowEvidence!.reasonDigest,
    ]) expect(serialized).not.toContain(privateValue);
    expect(projected.current).not.toHaveProperty('repository');
    expect(projected.current).not.toHaveProperty('policyDigest');
    expect(projected.current).not.toHaveProperty('attestation');
  });

  it('never renders degraded controller evidence as healthy inactivity', () => {
    const state = observedState();
    expect(projectAutoMergeCanaryStatus(readResult({
      sourceState: 'degraded',
      severity: 'critical',
      status: 'critical',
      state,
      revisions: [state],
      diagnostics: ['chain-broken', 'future-time'],
      limitExceeded: true,
    }))).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      sourceState: 'degraded',
      severity: 'critical',
      status: 'critical',
      hostCancellationProven: false,
      current: null,
      revisionCount: null,
      terminalEpochCount: null,
      telemetry: {
        shadowCounters: null,
        outcomeRates: { eligible: null, rejected: null },
        casRetries: null,
      },
      diagnostics: ['chain-broken', 'future-time'],
      limitExceeded: true,
    });
  });

  it('preserves observation-cap exhaustion as a critical visible controller state', () => {
    const state = { ...observedState(), revision: 63 };
    expect(projectAutoMergeCanaryStatus(readResult({
      sourceState: 'healthy',
      severity: 'critical',
      status: 'critical',
      active: true,
      state,
      revisions: [state],
      diagnostics: ['capacity-exceeded'],
      limitExceeded: true,
    }))).toMatchObject({
      sourceState: 'healthy',
      severity: 'critical',
      status: 'critical',
      active: true,
      current: { revision: 63, state: 'shadow' },
      telemetry: {
        revisionCapacity: {
          remaining: 1,
          reservedForTerminal: 1,
          observationWritesRemaining: 0,
        },
      },
      diagnostics: ['capacity-exceeded'],
      limitExceeded: true,
    });
  });

  it('attaches the projection only after all authority-bearing status decisions', () => {
    const source = readFileSync('src/core/fleet/status.ts', 'utf8');
    const mission = source.lastIndexOf('status.missionBrief = buildMissionBrief(status)');
    const readiness = source.lastIndexOf('status.autonomousShipReadiness = buildAutonomousShipReadiness');
    const canary = source.lastIndexOf('status.autoMergeCanary = projectAutoMergeCanaryStatus');
    const statusReturn = source.indexOf('return status;', canary);

    expect(mission).toBeGreaterThan(readiness);
    expect(canary).toBeGreaterThan(mission);
    expect(statusReturn).toBeGreaterThan(canary);
    expect(source.slice(canary, statusReturn)).not.toMatch(
      /buildMissionBrief|buildAutonomousShipReadiness|buildNextActions/,
    );
  });
});

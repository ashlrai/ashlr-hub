import { describe, expect, it } from 'vitest';
import {
  CUTOFF_CHECKPOINT_STALE_MS,
  projectCutoffCheckpointStatus,
} from '../src/core/fleet/cutoff-observation-status.js';
import type { CutoffObservationCheckpointReadResult } from '../src/core/fleet/cutoff-observation-checkpoints.js';

function readFixture(
  overrides: Partial<CutoffObservationCheckpointReadResult> = {},
): CutoffObservationCheckpointReadResult {
  const latestCapturedAt = overrides.latestCapturedAt === undefined
    ? '2026-07-12T10:00:00.000Z'
    : overrides.latestCapturedAt;
  const checkpoints = overrides.checkpoints ?? (latestCapturedAt === null ? [] : [{
    snapshot: { capturedAt: latestCapturedAt },
  } as CutoffObservationCheckpointReadResult['checkpoints'][number]]);
  return {
    root: null,
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    physicalRows: 1,
    releasedRows: 1,
    unreleasedRows: 0,
    bytesRead: 1024,
    cutoffAuthority: false,
    denominatorComplete: false,
    policyEligible: false,
    rollbackProtected: false,
    historicalAuthority: false,
    ...overrides,
    checkpoints,
    latestCapturedAt,
  };
}

describe('M384 cutoff observation status projection', () => {
  it('uses the signed capture time for fresh and exact stale-boundary status', () => {
    const fresh = projectCutoffCheckpointStatus(
      readFixture(),
      new Date(Date.parse('2026-07-12T10:00:00.000Z') + CUTOFF_CHECKPOINT_STALE_MS).toISOString(),
    );
    expect(fresh).toMatchObject({
      state: 'available', freshness: 'fresh', ageMs: CUTOFF_CHECKPOINT_STALE_MS,
      latestCapturedAt: '2026-07-12T10:00:00.000Z', releasedCheckpoints: 1,
    });

    const stale = projectCutoffCheckpointStatus(
      readFixture(),
      new Date(Date.parse('2026-07-12T10:00:00.000Z') + CUTOFF_CHECKPOINT_STALE_MS + 1).toISOString(),
    );
    expect(stale).toMatchObject({ state: 'available', freshness: 'stale' });
  });

  it('distinguishes missing, degraded, future, and unsupported observations', () => {
    expect(projectCutoffCheckpointStatus(readFixture({
      sourceState: 'missing', sourcePresent: false, physicalRows: 0, releasedRows: 0,
      bytesRead: 0, latestCapturedAt: null,
    }), '2026-07-12T10:00:00.000Z')).toMatchObject({
      state: 'missing', freshness: 'unknown', complete: true,
    });

    expect(projectCutoffCheckpointStatus(readFixture({
      sourceState: 'degraded', complete: false, unreleasedRows: 1,
      stopReasons: ['unreleased-tail'],
    }), '2026-07-12T10:01:00.000Z')).toMatchObject({
      state: 'degraded', freshness: 'fresh', complete: false,
      stopReasons: ['unreleased-tail'],
    });

    expect(projectCutoffCheckpointStatus(
      readFixture({ latestCapturedAt: '2026-07-12T10:00:06.000Z' }),
      '2026-07-12T10:00:00.000Z',
    )).toMatchObject({
      state: 'degraded', freshness: 'unknown', latestCapturedAt: null,
      stopReasons: ['invalid-observation-time'],
    });

    expect(projectCutoffCheckpointStatus(
      readFixture(),
      '2026-07-12T10:00:00.000Z',
      'win32',
    )).toMatchObject({
      state: 'unsupported', freshness: 'unsupported', stopReasons: ['platform-unsupported'],
    });
  });

  it('uses the newest released capture rather than append order and detects hidden future rows', () => {
    const checkpoint = (capturedAt: string) => ({
      snapshot: { capturedAt },
    } as CutoffObservationCheckpointReadResult['checkpoints'][number]);
    const outOfOrder = readFixture({
      checkpoints: [checkpoint('2026-07-12T10:29:00.000Z'), checkpoint('2026-07-12T09:00:00.000Z')],
      releasedRows: 2,
      physicalRows: 2,
      latestCapturedAt: '2026-07-12T09:00:00.000Z',
    });
    expect(projectCutoffCheckpointStatus(outOfOrder, '2026-07-12T10:30:00.000Z')).toMatchObject({
      state: 'available', freshness: 'fresh', latestCapturedAt: '2026-07-12T10:29:00.000Z',
      ageMs: 60_000,
    });

    const hiddenFuture = readFixture({
      checkpoints: [checkpoint('2026-07-12T10:30:06.000Z'), checkpoint('2026-07-12T10:29:00.000Z')],
      releasedRows: 2,
      physicalRows: 2,
      latestCapturedAt: '2026-07-12T10:29:00.000Z',
    });
    expect(projectCutoffCheckpointStatus(hiddenFuture, '2026-07-12T10:30:00.000Z')).toMatchObject({
      state: 'degraded', freshness: 'fresh', latestCapturedAt: '2026-07-12T10:29:00.000Z',
      stopReasons: ['invalid-observation-time'],
    });
  });

  it('rejects healthy-zero ambiguity and fixes every authority field false', () => {
    const status = projectCutoffCheckpointStatus(readFixture({
      physicalRows: 0, releasedRows: 0, latestCapturedAt: null,
    }), '2026-07-12T10:00:00.000Z');
    expect(status).toMatchObject({
      authority: 'observation-only', evidenceRole: 'forensics', eligibility: 'observational',
      state: 'degraded', complete: false, stopReasons: ['healthy-zero-invalid'],
      cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
      rollbackProtected: false, historicalAuthority: false,
    });
  });
});

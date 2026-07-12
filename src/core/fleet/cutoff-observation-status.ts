import {
  readCutoffObservationCheckpointsSnapshot,
  type CutoffObservationCheckpointReadResult,
} from './cutoff-observation-checkpoints.js';

export const CUTOFF_CHECKPOINT_STALE_MS = 30 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5_000;

export interface FleetCutoffCheckpointStatus {
  version: 1;
  authority: 'observation-only';
  evidenceRole: 'forensics';
  eligibility: 'observational';
  state: 'available' | 'missing' | 'degraded' | 'unsupported';
  freshness: 'fresh' | 'stale' | 'unknown' | 'unsupported';
  latestCapturedAt: string | null;
  ageMs: number | null;
  staleAfterMs: number;
  releasedCheckpoints: number;
  physicalRows: number;
  unreleasedRows: number;
  complete: boolean;
  stopReasons: readonly string[];
  cutoffAuthority: false;
  denominatorComplete: false;
  policyEligible: false;
  rollbackProtected: false;
  historicalAuthority: false;
}

const AUTHORITY_BOUNDARY = {
  version: 1 as const,
  authority: 'observation-only' as const,
  evidenceRole: 'forensics' as const,
  eligibility: 'observational' as const,
  cutoffAuthority: false as const,
  denominatorComplete: false as const,
  policyEligible: false as const,
  rollbackProtected: false as const,
  historicalAuthority: false as const,
};

export function projectCutoffCheckpointStatus(
  read: CutoffObservationCheckpointReadResult,
  generatedAt: string,
  platform = process.platform,
): FleetCutoffCheckpointStatus {
  if (platform === 'win32') {
    return {
      ...AUTHORITY_BOUNDARY,
      state: 'unsupported',
      freshness: 'unsupported',
      latestCapturedAt: null,
      ageMs: null,
      staleAfterMs: CUTOFF_CHECKPOINT_STALE_MS,
      releasedCheckpoints: 0,
      physicalRows: 0,
      unreleasedRows: 0,
      complete: false,
      stopReasons: ['platform-unsupported'],
    };
  }

  const generatedMs = Date.parse(generatedAt);
  const releasedTimes = read.checkpoints.slice(0, read.releasedRows).map((checkpoint) => ({
    capturedAt: checkpoint.snapshot.capturedAt,
    capturedMs: Date.parse(checkpoint.snapshot.capturedAt),
  }));
  const invalidObservationTime = !Number.isFinite(generatedMs) || releasedTimes.some((row) =>
    !Number.isFinite(row.capturedMs) || row.capturedMs > generatedMs + FUTURE_TOLERANCE_MS);
  const validReleasedTimes = releasedTimes
    .filter((row) => Number.isFinite(row.capturedMs) && row.capturedMs <= generatedMs + FUTURE_TOLERANCE_MS)
    .sort((left, right) => right.capturedMs - left.capturedMs);
  const latest = validReleasedTimes[0] ?? null;
  const ageMs = latest && Number.isFinite(generatedMs)
    ? Math.max(0, generatedMs - latest.capturedMs)
    : null;
  const freshness = ageMs === null
    ? 'unknown'
    : ageMs > CUTOFF_CHECKPOINT_STALE_MS ? 'stale' : 'fresh';
  const impossibleHealthyZero = read.sourceState === 'healthy' && read.releasedRows === 0;
  const available = read.sourceState === 'healthy' && read.complete && read.releasedRows > 0 &&
    latest !== null && !invalidObservationTime;
  const missing = read.sourceState === 'missing' && read.releasedRows === 0 && read.physicalRows === 0;

  return {
    ...AUTHORITY_BOUNDARY,
    state: available ? 'available' : missing ? 'missing' : 'degraded',
    freshness,
    latestCapturedAt: latest?.capturedAt ?? null,
    ageMs,
    staleAfterMs: CUTOFF_CHECKPOINT_STALE_MS,
    releasedCheckpoints: read.releasedRows,
    physicalRows: read.physicalRows,
    unreleasedRows: read.unreleasedRows,
    complete: read.complete && !impossibleHealthyZero,
    stopReasons: [
      ...read.stopReasons,
      ...(invalidObservationTime && read.releasedRows > 0 ? ['invalid-observation-time'] : []),
      ...(impossibleHealthyZero ? ['healthy-zero-invalid'] : []),
    ],
  };
}

export function readFleetCutoffCheckpointStatus(
  generatedAt: string,
  platform = process.platform,
): FleetCutoffCheckpointStatus {
  if (platform === 'win32') {
    return projectCutoffCheckpointStatus({} as CutoffObservationCheckpointReadResult, generatedAt, platform);
  }
  try {
    return projectCutoffCheckpointStatus(readCutoffObservationCheckpointsSnapshot(), generatedAt, platform);
  } catch {
    return {
      ...AUTHORITY_BOUNDARY,
      state: 'degraded',
      freshness: 'unknown',
      latestCapturedAt: null,
      ageMs: null,
      staleAfterMs: CUTOFF_CHECKPOINT_STALE_MS,
      releasedCheckpoints: 0,
      physicalRows: 0,
      unreleasedRows: 0,
      complete: false,
      stopReasons: ['io-error'],
    };
  }
}

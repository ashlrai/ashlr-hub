/**
 * Bounded freshness metadata for post-merge forensic evidence.
 *
 * This is intentionally observational: it composes already-validated ledger
 * reads without exposing rows or participating in merge, routing, or policy
 * authority.
 */

import {
  readPostMergeObservations,
  type PostMergeObservationReadResult,
} from './post-merge-observations.js';
import {
  readPostMergeStabilityDetailed,
  type PostMergeStabilityReadResult,
} from './post-merge-stability.js';

export interface PostMergeForensicEvidenceSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  /** Ledger-specific bounded-read failure codes, never raw source content. */
  stopReasons: string[];
  filesRead: number;
  bytesRead: number;
  physicalRows: number;
  invalidRows: number;
  limitExceeded: boolean;
}

export interface PostMergeForensicEvidenceLatestObservation {
  /** Present only when both bounded, validated sources are complete. */
  latestAt?: string;
  observations: PostMergeForensicEvidenceSourceQuality;
  stability: PostMergeForensicEvidenceSourceQuality;
}

function observationQuality(
  source: PostMergeObservationReadResult,
): PostMergeForensicEvidenceSourceQuality {
  const {
    sourceState, sourcePresent, complete, stopReasons, filesRead, bytesRead,
    physicalRows, invalidRows, limitExceeded,
  } = source;
  return {
    sourceState, sourcePresent, complete, stopReasons, filesRead, bytesRead,
    physicalRows, invalidRows, limitExceeded,
  };
}

function stabilityQuality(
  source: PostMergeStabilityReadResult,
): PostMergeForensicEvidenceSourceQuality {
  const {
    sourceState, sourcePresent, complete, stopReasons, filesRead, bytesRead,
    physicalRows, invalidRows, limitExceeded,
  } = source;
  return {
    sourceState, sourcePresent, complete, stopReasons, filesRead, bytesRead,
    physicalRows, invalidRows, limitExceeded,
  };
}

/**
 * Reads bounded forensic ledgers and returns the newest validated observation
 * timestamp. A partial source is never allowed to make forensic evidence look
 * fresh, even when the other source is complete.
 */
export function readPostMergeForensicLatestObservation(): PostMergeForensicEvidenceLatestObservation {
  const observationRead = readPostMergeObservations();
  const stabilityRead = readPostMergeStabilityDetailed();
  const observations = observationQuality(observationRead);
  const stability = stabilityQuality(stabilityRead);

  if (
    observations.sourceState === 'degraded' || !observations.complete ||
    stability.sourceState === 'degraded' || !stability.complete
  ) return { observations, stability };

  let latestAt: string | undefined;
  for (const observation of observationRead.observations) {
    if (latestAt === undefined || Date.parse(observation.observedAt) > Date.parse(latestAt)) {
      latestAt = observation.observedAt;
    }
  }
  for (const witness of stabilityRead.witnesses) {
    if (latestAt === undefined || Date.parse(witness.stableAt) > Date.parse(latestAt)) {
      latestAt = witness.stableAt;
    }
  }
  return { ...(latestAt === undefined ? {} : { latestAt }), observations, stability };
}

import type {
  DispatchProductionEvent,
  DispatchProductionReadStopReason,
  DispatchProductionSourceQuality,
} from './dispatch-production-ledger.js';
import {
  canonicalDispatchProductionAttempts,
  isCancelledDispatchProductionEvent,
} from './dispatch-production-ledger.js';

export type ProposalFunnelWithheldReason =
  | 'source-missing'
  | 'source-degraded'
  | 'sample-limit-exceeded'
  | 'attempt-identity-unavailable'
  | 'attempt-identity-conflict'
  | 'snapshot-unstable'
  | 'insufficient-sample';

export type ProposalFunnelBlocker =
  | 'none'
  | 'insufficient-sample'
  | 'capture-errors'
  | 'gate-blocking'
  | 'empty-attempts'
  | 'policy-suppression'
  | 'other-failures'
  | 'source-unavailable'
  | 'sample-incomplete'
  | 'identity-unavailable'
  | 'identity-conflict';

export type ProposalFunnelDiagnosticHint =
  | 'keep-routing'
  | 'collect-attempts'
  | 'repair-proposal-capture'
  | 'inspect-verification-gates'
  | 'reslice-empty-attempts'
  | 'review-proposal-policy'
  | 'inspect-other-failures'
  | 'repair-telemetry-source'
  | 'increase-or-narrow-sample-window'
  | 'repair-attempt-identity'
  | 'inspect-attempt-identity-conflicts';

export interface ProposalFunnelRate {
  count: number;
  rate: number;
}

export interface ProposalFunnelMetrics {
  attempts: number;
  reportedProposalCreatedOutcomes: ProposalFunnelRate;
  observedProposalReferences: ProposalFunnelRate;
  captureErrors: ProposalFunnelRate;
  policySuppressions: ProposalFunnelRate;
  gateBlocked: ProposalFunnelRate;
  emptyAttempts: ProposalFunnelRate;
  otherAttempts: ProposalFunnelRate;
}

export interface ProposalFunnelObservability {
  schemaVersion: 5;
  state: 'observational' | 'withheld';
  authority: {
    integrityClass: 'owner-writable-local';
    cryptographicallyAuthenticated: false;
    rollbackProtected: false;
    readinessEligible: false;
    learningEligible: false;
  };
  source: {
    sourceState: DispatchProductionSourceQuality['sourceState'];
    complete: boolean;
    stopReasons: DispatchProductionReadStopReason[];
  };
  sample: {
    requestedWindowMs: number;
    requestedWindowHours: number;
    eventLimit: number;
    observedEvents: number;
    includedAttempts: number;
    excludedLifecycleEvents: number;
    cancelledEvents: number;
    preEnvelopeEvents: number;
    duplicateEvents: number;
    invalidAttemptIdentities: number;
    conflictingAttemptIdentities: number;
    observedFrom?: string;
    observedThrough?: string;
  };
  metrics?: ProposalFunnelMetrics;
  withheldReason?: ProposalFunnelWithheldReason;
  primaryBlocker: ProposalFunnelBlocker;
  /** Display-only diagnostic vocabulary; never an executable or readiness action. */
  diagnosticHint: ProposalFunnelDiagnosticHint;
}

export interface BuildProposalFunnelObservabilityInput {
  events: readonly DispatchProductionEvent[];
  sourceQuality: DispatchProductionSourceQuality;
  windowMs: number;
  eventLimit: number;
}

function boundedPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
}

function rate(count: number, attempts: number): ProposalFunnelRate {
  return { count, rate: attempts > 0 ? count / attempts : 0 };
}

function isLifecycleBookkeeping(event: DispatchProductionEvent): boolean {
  return event.basis === 'repair-lifecycle-candidate' || event.basis === 'repair-lifecycle-outcome';
}

const OBSERVATIONAL_AUTHORITY = {
  integrityClass: 'owner-writable-local',
  cryptographicallyAuthenticated: false,
  rollbackProtected: false,
  readinessEligible: false,
  learningEligible: false,
} as const;

function observationBounds(events: readonly DispatchProductionEvent[]): {
  observedFrom?: string;
  observedThrough?: string;
} {
  const timestamps = events
    .map((event) => event.ts)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right) || left.localeCompare(right));
  if (timestamps.length === 0) return {};
  return {
    observedFrom: timestamps[0],
    observedThrough: timestamps[timestamps.length - 1],
  };
}

function dominantBlocker(metrics: ProposalFunnelMetrics): {
  primaryBlocker: ProposalFunnelBlocker;
  diagnosticHint: ProposalFunnelDiagnosticHint;
} {
  if (metrics.attempts === 0) {
    return { primaryBlocker: 'insufficient-sample', diagnosticHint: 'collect-attempts' };
  }
  const candidates = [
    ['capture-errors', 'repair-proposal-capture', metrics.captureErrors.count],
    ['gate-blocking', 'inspect-verification-gates', metrics.gateBlocked.count],
    ['empty-attempts', 'reslice-empty-attempts', metrics.emptyAttempts.count],
    ['policy-suppression', 'review-proposal-policy', metrics.policySuppressions.count],
    ['other-failures', 'inspect-other-failures', metrics.otherAttempts.count],
  ] as const;
  const dominant = candidates.reduce((best, candidate) => candidate[2] > best[2] ? candidate : best);
  if (dominant[2] === 0) return { primaryBlocker: 'none', diagnosticHint: 'keep-routing' };
  return { primaryBlocker: dominant[0], diagnosticHint: dominant[1] };
}

/**
 * Projects fixed metadata fields from a bounded dispatch snapshot. Raw agent
 * text and execution output are neither accepted nor copied into the result.
 */
export function buildProposalFunnelObservability(
  input: BuildProposalFunnelObservabilityInput,
): ProposalFunnelObservability {
  const windowMs = boundedPositiveInteger(input.windowMs, 24 * 60 * 60 * 1000);
  const eventLimit = boundedPositiveInteger(input.eventLimit, 1_200);
  const sampledEvents = input.events.slice(0, eventLimit);
  const excludedLifecycleEvents = sampledEvents.filter(isLifecycleBookkeeping).length;
  const canonical = canonicalDispatchProductionAttempts(
    sampledEvents.filter((event) => !isLifecycleBookkeeping(event)),
  );
  const cancelledEvents = canonical.events.filter(isCancelledDispatchProductionEvent).length;
  const attempts = canonical.events.filter((event) => !isCancelledDispatchProductionEvent(event));
  const sample = {
    requestedWindowMs: windowMs,
    requestedWindowHours: windowMs / (60 * 60 * 1000),
    eventLimit,
    observedEvents: sampledEvents.length,
    includedAttempts: attempts.length,
    excludedLifecycleEvents,
    cancelledEvents,
    preEnvelopeEvents: canonical.preEnvelopeEvents,
    duplicateEvents: canonical.duplicateEvents,
    invalidAttemptIdentities: canonical.invalidAttemptIdentities,
    conflictingAttemptIdentities: canonical.conflictingAttemptIdentities,
    ...observationBounds(sampledEvents),
  };
  const source = {
    sourceState: input.sourceQuality.sourceState,
    complete: input.sourceQuality.complete,
    stopReasons: [...input.sourceQuality.stopReasons],
  };

  if (input.events.length > eventLimit) {
    return {
      schemaVersion: 5,
      state: 'withheld',
      authority: OBSERVATIONAL_AUTHORITY,
      source,
      sample,
      withheldReason: 'sample-limit-exceeded',
      primaryBlocker: 'sample-incomplete',
      diagnosticHint: 'increase-or-narrow-sample-window',
    };
  }
  if (input.sourceQuality.sourceState !== 'healthy' || !input.sourceQuality.complete) {
    return {
      schemaVersion: 5,
      state: 'withheld',
      authority: OBSERVATIONAL_AUTHORITY,
      source,
      sample,
      withheldReason: input.sourceQuality.sourceState === 'missing'
        ? 'source-missing'
        : 'source-degraded',
      primaryBlocker: 'source-unavailable',
      diagnosticHint: 'repair-telemetry-source',
    };
  }

  if (canonical.invalidAttemptIdentities > 0) {
    return {
      schemaVersion: 5,
      state: 'withheld',
      authority: OBSERVATIONAL_AUTHORITY,
      source,
      sample,
      withheldReason: 'attempt-identity-unavailable',
      primaryBlocker: 'identity-unavailable',
      diagnosticHint: 'repair-attempt-identity',
    };
  }

  if (canonical.conflictingAttemptIdentities > 0) {
    return {
      schemaVersion: 5,
      state: 'withheld',
      authority: OBSERVATIONAL_AUTHORITY,
      source,
      sample,
      withheldReason: 'attempt-identity-conflict',
      primaryBlocker: 'identity-conflict',
      diagnosticHint: 'inspect-attempt-identity-conflicts',
    };
  }

  if (attempts.length === 0) {
    return {
      schemaVersion: 5,
      state: 'withheld',
      authority: OBSERVATIONAL_AUTHORITY,
      source,
      sample,
      withheldReason: 'insufficient-sample',
      primaryBlocker: 'insufficient-sample',
      diagnosticHint: 'collect-attempts',
    };
  }

  let reportedProposalCreatedOutcomes = 0;
  let observedProposalReferences = 0;
  let captureErrors = 0;
  let policySuppressions = 0;
  let gateBlocked = 0;
  let emptyAttempts = 0;
  let otherAttempts = 0;
  for (const event of attempts) {
    const reportedProposalCreated = event.outcome === 'proposal-created' && event.proposalCreated === true;
    if (reportedProposalCreated) reportedProposalCreatedOutcomes++;
    if (typeof event.proposalId === 'string' && event.proposalId.length > 0) {
      observedProposalReferences++;
    }
    if (reportedProposalCreated) continue;
    if (event.outcome === 'proposal-capture-error') captureErrors++;
    else if (event.outcome === 'proposal-disabled') policySuppressions++;
    else if (event.outcome === 'gate-blocked') gateBlocked++;
    else if (event.outcome === 'empty-diff') emptyAttempts++;
    else otherAttempts++;
  }

  const metrics: ProposalFunnelMetrics = {
    attempts: attempts.length,
    reportedProposalCreatedOutcomes: rate(reportedProposalCreatedOutcomes, attempts.length),
    observedProposalReferences: rate(observedProposalReferences, attempts.length),
    captureErrors: rate(captureErrors, attempts.length),
    policySuppressions: rate(policySuppressions, attempts.length),
    gateBlocked: rate(gateBlocked, attempts.length),
    emptyAttempts: rate(emptyAttempts, attempts.length),
    otherAttempts: rate(otherAttempts, attempts.length),
  };
  return {
    schemaVersion: 5,
    state: 'observational',
    authority: OBSERVATIONAL_AUTHORITY,
    source,
    sample,
    metrics,
    ...dominantBlocker(metrics),
  };
}

export function withholdProposalFunnelForUnstableSnapshot(
  observation: ProposalFunnelObservability,
  invalidatingSource?: DispatchProductionSourceQuality,
): ProposalFunnelObservability {
  const { metrics: _metrics, ...withoutMetrics } = observation;
  const source = invalidatingSource
    ? {
        sourceState: invalidatingSource.sourceState === 'missing' ? 'missing' as const : 'degraded' as const,
        complete: false,
        stopReasons: [...invalidatingSource.stopReasons],
      }
    : {
        ...observation.source,
        sourceState: observation.source.sourceState === 'missing' ? 'missing' as const : 'degraded' as const,
        complete: false,
      };
  return {
    ...withoutMetrics,
    schemaVersion: 5,
    state: 'withheld',
    source,
    withheldReason: 'snapshot-unstable',
    primaryBlocker: 'source-unavailable',
    diagnosticHint: 'repair-telemetry-source',
  };
}

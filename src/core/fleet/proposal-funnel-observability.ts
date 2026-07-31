import type {
  DispatchProductionEvent,
  DispatchProductionReadStopReason,
  DispatchProductionSourceQuality,
} from './dispatch-production-ledger.js';

export type ProposalFunnelWithheldReason =
  | 'source-missing'
  | 'source-degraded'
  | 'sample-limit-exceeded';

export type ProposalFunnelBlocker =
  | 'none'
  | 'insufficient-sample'
  | 'capture-errors'
  | 'gate-blocking'
  | 'empty-attempts'
  | 'policy-suppression'
  | 'other-failures'
  | 'source-unavailable'
  | 'sample-incomplete';

export type ProposalFunnelAction =
  | 'keep-routing'
  | 'collect-attempts'
  | 'repair-proposal-capture'
  | 'inspect-verification-gates'
  | 'reslice-empty-attempts'
  | 'review-proposal-policy'
  | 'inspect-other-failures'
  | 'repair-telemetry-source'
  | 'increase-or-narrow-sample-window';

export interface ProposalFunnelRate {
  count: number;
  rate: number;
}

export interface ProposalFunnelMetrics {
  attempts: number;
  mergeGradeProposals: ProposalFunnelRate;
  anyDurableArtifact: ProposalFunnelRate;
  captureErrors: ProposalFunnelRate;
  policySuppressions: ProposalFunnelRate;
  gateBlocked: ProposalFunnelRate;
  emptyAttempts: ProposalFunnelRate;
  otherAttempts: ProposalFunnelRate;
}

export interface ProposalFunnelObservability {
  schemaVersion: 1;
  state: 'available' | 'withheld';
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
    observedFrom?: string;
    observedThrough?: string;
  };
  metrics?: ProposalFunnelMetrics;
  withheldReason?: ProposalFunnelWithheldReason;
  primaryBlocker: ProposalFunnelBlocker;
  primaryAction: ProposalFunnelAction;
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
  primaryAction: ProposalFunnelAction;
} {
  if (metrics.attempts === 0) {
    return { primaryBlocker: 'insufficient-sample', primaryAction: 'collect-attempts' };
  }
  const candidates = [
    ['capture-errors', 'repair-proposal-capture', metrics.captureErrors.count],
    ['gate-blocking', 'inspect-verification-gates', metrics.gateBlocked.count],
    ['empty-attempts', 'reslice-empty-attempts', metrics.emptyAttempts.count],
    ['policy-suppression', 'review-proposal-policy', metrics.policySuppressions.count],
    ['other-failures', 'inspect-other-failures', metrics.otherAttempts.count],
  ] as const;
  const dominant = candidates.reduce((best, candidate) => candidate[2] > best[2] ? candidate : best);
  if (dominant[2] === 0) return { primaryBlocker: 'none', primaryAction: 'keep-routing' };
  return { primaryBlocker: dominant[0], primaryAction: dominant[1] };
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
  const cancelledEvents = sampledEvents.filter((event) =>
    !isLifecycleBookkeeping(event) && event.outcome === 'cancelled'
  ).length;
  const attempts = sampledEvents.filter((event) =>
    !isLifecycleBookkeeping(event) && event.outcome !== 'cancelled'
  );
  const sample = {
    requestedWindowMs: windowMs,
    requestedWindowHours: windowMs / (60 * 60 * 1000),
    eventLimit,
    observedEvents: sampledEvents.length,
    includedAttempts: attempts.length,
    excludedLifecycleEvents,
    cancelledEvents,
    ...observationBounds(sampledEvents),
  };
  const source = {
    sourceState: input.sourceQuality.sourceState,
    complete: input.sourceQuality.complete,
    stopReasons: [...input.sourceQuality.stopReasons],
  };

  if (input.events.length > eventLimit) {
    return {
      schemaVersion: 1,
      state: 'withheld',
      source,
      sample,
      withheldReason: 'sample-limit-exceeded',
      primaryBlocker: 'sample-incomplete',
      primaryAction: 'increase-or-narrow-sample-window',
    };
  }
  if (input.sourceQuality.sourceState !== 'healthy' || !input.sourceQuality.complete) {
    return {
      schemaVersion: 1,
      state: 'withheld',
      source,
      sample,
      withheldReason: input.sourceQuality.sourceState === 'missing'
        ? 'source-missing'
        : 'source-degraded',
      primaryBlocker: 'source-unavailable',
      primaryAction: 'repair-telemetry-source',
    };
  }

  let mergeGradeProposals = 0;
  let anyDurableArtifact = 0;
  let captureErrors = 0;
  let policySuppressions = 0;
  let gateBlocked = 0;
  let emptyAttempts = 0;
  let otherAttempts = 0;
  for (const event of attempts) {
    const mergeGrade = event.outcome === 'proposal-created' && event.proposalCreated === true;
    if (mergeGrade) mergeGradeProposals++;
    if (mergeGrade || (typeof event.proposalId === 'string' && event.proposalId.length > 0)) {
      anyDurableArtifact++;
    }
    if (mergeGrade) continue;
    if (event.outcome === 'proposal-capture-error') captureErrors++;
    else if (event.outcome === 'proposal-disabled') policySuppressions++;
    else if (event.outcome === 'gate-blocked') gateBlocked++;
    else if (event.outcome === 'empty-diff') emptyAttempts++;
    else otherAttempts++;
  }

  const metrics: ProposalFunnelMetrics = {
    attempts: attempts.length,
    mergeGradeProposals: rate(mergeGradeProposals, attempts.length),
    anyDurableArtifact: rate(anyDurableArtifact, attempts.length),
    captureErrors: rate(captureErrors, attempts.length),
    policySuppressions: rate(policySuppressions, attempts.length),
    gateBlocked: rate(gateBlocked, attempts.length),
    emptyAttempts: rate(emptyAttempts, attempts.length),
    otherAttempts: rate(otherAttempts, attempts.length),
  };
  return {
    schemaVersion: 1,
    state: 'available',
    source,
    sample,
    metrics,
    ...dominantBlocker(metrics),
  };
}

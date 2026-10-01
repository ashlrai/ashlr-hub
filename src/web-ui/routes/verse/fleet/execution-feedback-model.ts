import type { ExecutionFeedbackRead } from '../../../../core/verse/execution-feedback-api-types.js';
import type { ExecutionFeedbackOutcome } from '../../../../core/fleet/execution-feedback-types.js';

export const OUTCOME_LABELS: Record<ExecutionFeedbackOutcome, string> = {
  'producer-succeeded': 'Produced proposal', failed: 'Failed', cancelled: 'Cancelled',
  refused: 'Held', 'empty-diff': 'No changes', disabled: 'Disabled', unknown: 'Unclassified',
};
const outcomes = Object.keys(OUTCOME_LABELS);
const hash = /^h:(?:[a-f0-9]{16}:){3}[a-f0-9]{16}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}
function counts(value: unknown): boolean {
  return record(value) && outcomes.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}

/** Refuse an incompatible server response before rendering counts or cases. */
export function narrowExecutionFeedbackRead(raw: unknown): ExecutionFeedbackRead | null {
  if (!record(raw) || raw.v !== 1 || !['warming', 'current', 'stale', 'unavailable'].includes(String(raw.state)) ||
      raw.refreshedAt !== null && !timestamp(raw.refreshedAt)) return null;
  if (raw.feedback === null) {
    return ['warming', 'unavailable'].includes(String(raw.state)) ? raw as unknown as ExecutionFeedbackRead : null;
  }
  const value = raw.feedback;
  if (!record(value) || value.schemaVersion !== 1 || !['missing', 'healthy', 'degraded'].includes(String(value.sourceState)) ||
      typeof value.complete !== 'boolean' || !record(value.window) || !timestamp(value.window.since) || !timestamp(value.window.through) ||
      value.observedThrough !== null && !timestamp(value.observedThrough) || !counts(value.observedCounts) ||
      value.counts !== null && !counts(value.counts) || value.complete !== (value.counts !== null) ||
      value.complete !== (value.sourceState === 'healthy') ||
      !Array.isArray(value.cases) || typeof value.digest !== 'string' || !hash.test(value.digest) || !record(value.coverage)) return null;
  const coverage = value.coverage;
  if (Date.parse(value.window.since as string) > Date.parse(value.window.through as string) ||
      !['missing', 'healthy', 'degraded', 'unavailable'].includes(String(coverage.proposalSource)) ||
      !['legacyRows', 'invalidAttempts', 'conflictingAttempts', 'duplicateRows', 'invalidTimestamps'].every((key) =>
        Number.isSafeInteger(coverage[key]) && (coverage[key] as number) >= 0)) return null;
  if (!value.cases.every((row) => record(row) && typeof row.caseId === 'string' && hash.test(row.caseId) && timestamp(row.endedAt) &&
      typeof row.outcome === 'string' && Object.hasOwn(OUTCOME_LABELS, row.outcome) &&
      (row.failureKind === null || ['engine', 'sandbox', 'capture'].includes(String(row.failureKind))) && typeof row.proposalRecorded === 'boolean')) return null;
  return raw as unknown as ExecutionFeedbackRead;
}

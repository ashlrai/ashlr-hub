import type { ExecutionFeedbackCaseRead } from '../../../../core/verse/execution-feedback-api-types.js';
import type { ExecutionCaseStage, ExecutionCaseTimelineEntry } from '../../../../core/fleet/execution-feedback-case-types.js';
import { OUTCOME_LABELS } from './execution-feedback-model.js';

export const EXECUTION_CASE_ID = /^h:(?:[a-f0-9]{16}:){3}[a-f0-9]{16}$/;
export const CASE_STAGE_LABELS: Record<ExecutionCaseStage, string> = {
  produced: 'Execution recorded', verified: 'Verification', 'pr-opened': 'Pull request opened',
  merged: 'Merged', 'post-merge': 'After merge', reverted: 'Reverted',
};
export const CASE_BASIS_LABELS: Record<ExecutionCaseTimelineEntry['basis'], string> = {
  'dispatch-final': 'Completed attempt', 'proposal-verification': 'Proposal verification record',
  'authority-ledger': 'Recorded fleet action', 'authenticated-host': 'Confirmed GitHub merge',
  'authenticated-local': 'Confirmed local merge',
};
export const CASE_RESULT_LABELS: Record<ExecutionCaseTimelineEntry['result'], string> = {
  recorded: 'Recorded', passed: 'Passed', failed: 'Failed', unbound: 'Not bound to this change',
  'host-merged': 'GitHub merge recorded', 'local-merged': 'Local merge recorded',
  green: 'Green result recorded', red: 'Red result recorded', reverted: 'Revert recorded',
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
      typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function instant(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function member(value: unknown, options: readonly string[]): value is string { return typeof value === 'string' && options.includes(value); }
/** Fixed recorded links only; no credentials, redirect host, query or arbitrary browser URL. */
export function safeExecutionCaseHref(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^\/(?:inbox|work\/runs)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)) return true;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/pull\/([1-9][0-9]*)$/.exec(value);
  return !!match && Number.isSafeInteger(Number(match[3]));
}
/** The response must match the selected case, including when requests finish out of order. */
export function narrowExecutionCaseRead(raw: unknown, selectedCaseId: string): ExecutionFeedbackCaseRead | null {
  try {
    if (!EXECUTION_CASE_ID.test(selectedCaseId) || !record(raw) || raw.v !== 1 ||
      !member(raw.state, ['warming', 'current', 'stale', 'unavailable']) || raw.refreshedAt !== null && !instant(raw.refreshedAt)) return null;
    if (raw.detail === null) return member(raw.state, ['warming', 'unavailable']) ? raw as unknown as ExecutionFeedbackCaseRead : null;
    const d = raw.detail;
    if (!record(d) || d.schemaVersion !== 1 || d.caseId !== selectedCaseId || typeof d.digest !== 'string' ||
      !EXECUTION_CASE_ID.test(d.digest) || !instant(d.endedAt) || typeof d.outcome !== 'string' ||
      !Object.hasOwn(OUTCOME_LABELS, d.outcome) || d.shipping !== 'not-recorded' || !record(d.coverage) ||
      !Array.isArray(d.timeline) || !member(raw.state, ['current', 'stale'])) return null;
    const c = d.coverage;
    if (!member(c.dispatch, ['healthy', 'degraded', 'missing']) || !member(c.proposals, ['healthy', 'degraded', 'missing']) ||
      !member(c.ledger, ['healthy', 'missing', 'broken', 'unavailable']) ||
      !['invalidRecords', 'conflictingRecords'].every(k => Number.isSafeInteger(c[k]) && (c[k] as number) >= 0)) return null;
    for (let index = 0; index < d.timeline.length; index++) {
      if (!Object.hasOwn(d.timeline, index)) return null;
      const row = d.timeline[index];
      if (!record(row) || typeof row.stage !== 'string' || !Object.hasOwn(CASE_STAGE_LABELS, row.stage) ||
        typeof row.result !== 'string' || !Object.hasOwn(CASE_RESULT_LABELS, row.result) ||
        typeof row.basis !== 'string' || !Object.hasOwn(CASE_BASIS_LABELS, row.basis) ||
        row.at !== null && !instant(row.at) || row.href !== undefined && !safeExecutionCaseHref(row.href) ||
        row.ci !== undefined && !member(row.ci, ['green', 'red', 'none', 'unknown']) ||
        row.suite !== undefined && !member(row.suite, ['pass', 'fail', 'not-run'])) return null;
      const supported = row.stage === 'produced' ? row.result === 'recorded' && row.basis === 'dispatch-final'
        : row.stage === 'verified' ? member(row.result, ['passed', 'failed', 'unbound']) && row.basis === 'proposal-verification'
        : row.stage === 'pr-opened' ? row.result === 'recorded' && row.basis === 'authority-ledger'
        : row.stage === 'merged' ? row.result === 'host-merged' && member(row.basis, ['authenticated-host', 'authority-ledger']) ||
          row.result === 'local-merged' && row.basis === 'authenticated-local'
        : row.stage === 'post-merge' ? member(row.result, ['green', 'red']) && row.basis === 'authority-ledger'
        : row.result === 'reverted' && row.basis === 'authority-ledger';
      if (!supported || row.stage !== 'post-merge' && (row.ci !== undefined || row.suite !== undefined) ||
        row.stage === 'verified' && row.result !== 'unbound' && row.at === null) return null;
    }
    return raw as unknown as ExecutionFeedbackCaseRead;
  } catch { return null; }
}

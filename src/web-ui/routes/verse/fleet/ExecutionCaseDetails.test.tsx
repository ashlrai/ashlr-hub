import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExecutionFeedback } from './ExecutionFeedback.js';
import { ExecutionCaseDetails } from './ExecutionCaseDetails.js';
import { narrowExecutionCaseRead, safeExecutionCaseHref } from './execution-case-model.js';
import { EXECUTION_FEEDBACK_CASE_PATH, EXECUTION_FEEDBACK_PATH, type ExecutionFeedbackCaseRead, type ExecutionFeedbackRead } from '../../../../core/verse/execution-feedback-api-types.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';

const id = `h:${Array(4).fill('a'.repeat(16)).join(':')}`;
const other = `h:${Array(4).fill('b'.repeat(16)).join(':')}`;
const at = '2026-10-01T08:00:00.000Z';
const path = (caseId: string) => `${EXECUTION_FEEDBACK_CASE_PATH}${encodeURIComponent(caseId)}`;
function detail(caseId = id): ExecutionFeedbackCaseRead {
  return { v: 1, state: 'current', refreshedAt: at, detail: { schemaVersion: 1, caseId, outcome: 'producer-succeeded', endedAt: at,
    coverage: { dispatch: 'healthy', proposals: 'healthy', ledger: 'missing', invalidRecords: 0, conflictingRecords: 0 },
    timeline: [{ stage: 'produced', at, result: 'recorded', basis: 'dispatch-final', href: '/work/runs/sample-run' },
      { stage: 'verified', at, result: 'unbound', basis: 'proposal-verification', href: '/inbox/sample-proposal' },
      { stage: 'merged', at, result: 'host-merged', basis: 'authenticated-host', href: 'https://github.com/example/workbench/pull/23' },
      { stage: 'post-merge', at, result: 'red', basis: 'authority-ledger', ci: 'red', suite: 'not-run' }], shipping: 'not-recorded', digest: id } };
}
function aggregate(): ExecutionFeedbackRead {
  return { v: 1, state: 'current', refreshedAt: at, feedback: { schemaVersion: 1, sourceState: 'healthy', complete: true,
    window: { since: '2026-09-24T08:00:00.000Z', through: at }, observedThrough: at,
    counts: { 'producer-succeeded': 2, failed: 0, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 },
    observedCounts: { 'producer-succeeded': 2, failed: 0, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 },
    cases: [id, other].map(caseId => ({ caseId, endedAt: at, outcome: 'producer-succeeded', failureKind: null, proposalRecorded: true })),
    coverage: { legacyRows: 0, invalidAttempts: 0, conflictingAttempts: 0, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'healthy' }, digest: id } };
}
beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());
describe('Recorded execution timeline', () => {
  it('fetches only one selected case after both disclosures, switches cases and stops mounting on collapse', async () => {
    const { fetchMock, posted } = stubSurfaceFetch({ routes: { [EXECUTION_FEEDBACK_PATH]: aggregate(), [path(id)]: detail(), [path(other)]: detail(other) } });
    const user = userEvent.setup(); render(<ExecutionFeedback />);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByText('Execution feedback'));
    await user.click(await screen.findByText('Inspect 2 recorded outcomes'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getAllByRole('button', { name: 'View timeline' })[0]!);
    const selectedTimeline = await screen.findByRole('region', { name: 'Selected execution timeline' });
    expect(selectedTimeline.closest('li')).toContainElement(screen.getByRole('button', { name: 'Hide timeline' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'View timeline' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.includes('/cases/'))).toEqual([path(id), path(other)]);
    expect(screen.getAllByRole('region', { name: 'Selected execution timeline' })).toHaveLength(1);
    await user.click(screen.getByText('Inspect 2 recorded outcomes'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected execution timeline' })).toBeNull());
    expect(posted).toEqual([]);
  });
  it('qualifies partial verification, actual GitHub links, failed post-merge checks and unknown shipping', async () => {
    stubSurfaceFetch({ routes: { [path(id)]: detail() } }); render(<ExecutionCaseDetails caseId={id} />);
    await screen.findByText('Partial evidence. Unrecorded stages remain unknown.');
    expect(screen.getByText('Not bound to this change')).toBeVisible();
    expect(screen.getByText('Red result recorded')).toBeVisible();
    expect(screen.getByText('CI: red · Local verification: not run')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open GitHub pull request' })).toHaveAttribute('href', 'https://github.com/example/workbench/pull/23');
    expect(screen.getByText(/Release and deployment are not recorded/)).toBeVisible();
  });
  it('rejects response identity races instead of showing a different run', () => {
    expect(narrowExecutionCaseRead(detail(), id)).not.toBeNull();
    expect(narrowExecutionCaseRead(detail(other), id)).toBeNull();
    const row = detail(); row.detail!.endedAt = '2026-02-30T08:00:00.000Z';
    expect(narrowExecutionCaseRead(row, id)).toBeNull();
  });
  it('refuses stage/result and evidence-source contradictions instead of promoting them', () => {
    const forged = detail(); forged.detail!.timeline[0]!.result = 'passed';
    expect(narrowExecutionCaseRead(forged, id)).toBeNull();
    const unbound = detail(); unbound.detail!.timeline[1]!.result = 'passed'; unbound.detail!.timeline[1]!.at = null;
    expect(narrowExecutionCaseRead(unbound, id)).toBeNull();
    const merge = detail(); merge.detail!.timeline[2]!.basis = 'dispatch-final';
    expect(narrowExecutionCaseRead(merge, id)).toBeNull();
  });
  it('rejects scripts, redirect URLs, traversals, unsafe PR numbers and prototype accessors', () => {
    expect(safeExecutionCaseHref(`/work/runs/${'a'.repeat(160)}`)).toBe(true);
    expect(safeExecutionCaseHref(`/inbox/${'a'.repeat(160)}`)).toBe(true);
    expect(safeExecutionCaseHref(`/inbox/${'a'.repeat(161)}`)).toBe(false);
    for (const href of ['javascript:alert(1)', 'https://github.com.evil.test/o/r/pull/1', 'https://github.com/o/r/pull/1?redirect=evil',
      '/inbox/../secret', '/inbox/sample%2Fsecret', 'https://github.com/o/r/pull/9007199254740993']) expect(safeExecutionCaseHref(href)).toBe(false);
    const value = detail(); value.detail!.timeline[0]!.href = 'javascript:alert(1)';
    expect(narrowExecutionCaseRead(value, id)).toBeNull();
    const getter = vi.fn(); const raw = { ...detail() }; Object.defineProperty(raw, 'detail', { get: getter });
    expect(narrowExecutionCaseRead(raw, id)).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });
  it('handles missing detail with unknown evidence and no fabricated zero or success', async () => {
    const { posted } = stubSurfaceFetch({ routes: { [path(id)]: { v: 1, state: 'unavailable', refreshedAt: at, detail: null } } });
    render(<ExecutionCaseDetails caseId={id} />);
    await screen.findByText(/Missing evidence does not mean no work shipped/);
    expect(screen.queryByRole('list')).toBeNull(); expect(posted).toEqual([]);
  });
  it('handles offline or old servers without launching work', async () => {
    const { posted } = stubSurfaceFetch({ routes: { [path(id)]: null } });
    render(<ExecutionCaseDetails caseId={id} />);
    await screen.findByText(/not in this build yet/); expect(posted).toEqual([]);
  });
});

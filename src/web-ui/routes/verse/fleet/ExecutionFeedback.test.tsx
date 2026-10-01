import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExecutionFeedback } from './ExecutionFeedback.js';
import { narrowExecutionFeedbackRead } from './execution-feedback-model.js';
import { EXECUTION_FEEDBACK_PATH, type ExecutionFeedbackRead } from '../../../../core/verse/execution-feedback-api-types.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';

function fixture(): ExecutionFeedbackRead {
  return { v: 1, state: 'current', refreshedAt: '2026-10-01T08:00:00.000Z', feedback: {
    schemaVersion: 1, sourceState: 'degraded', complete: false, window: { since: '2026-09-24T08:00:00.000Z', through: '2026-10-01T08:00:00.000Z' },
    observedThrough: null, counts: null, observedCounts: { 'producer-succeeded': 0, failed: 2, cancelled: 1, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 },
    cases: [], coverage: { legacyRows: 1, invalidAttempts: 0, conflictingAttempts: 0, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'unavailable' }, digest: `h:${Array(4).fill('a'.repeat(16)).join(':')}`,
  } };
}
beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Execution feedback disclosure', () => {
  it('does no read while closed and opens only a GET, keeping incomplete counts explicit', async () => {
    const { fetchMock, posted } = stubSurfaceFetch({ routes: { [EXECUTION_FEEDBACK_PATH]: fixture() } });
    const user = userEvent.setup(); render(<ExecutionFeedback />);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByText('Execution feedback'));
    await screen.findByText(/Partial history/);
    expect(screen.getAllByRole('definition')).toHaveLength(7);
    expect(screen.getByText('≥ 2')).toBeInTheDocument();
    expect(screen.getByText(/separately from verification and shipping/)).toBeInTheDocument();
    expect(posted).toEqual([]);
    expect(fetchMock.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
  });
  it('mounts the full outcome list only while Inspect is open without rereading or hiding counts', async () => {
    const value = fixture();
    value.feedback!.cases = ['b', 'c', 'd'].map((char, index) => ({
      caseId: `h:${Array(4).fill(char.repeat(16)).join(':')}`,
      endedAt: '2026-10-01T07:00:00.000Z', outcome: index === 2 ? 'cancelled' : 'failed',
      failureKind: index === 2 ? null : 'engine', proposalRecorded: false,
    }));
    const { fetchMock, posted } = stubSurfaceFetch({ routes: { [EXECUTION_FEEDBACK_PATH]: value } });
    const user = userEvent.setup();
    render(<ExecutionFeedback />);
    await user.click(screen.getByText('Execution feedback'));
    const inspect = await screen.findByText('Inspect 3 recorded outcomes');
    expect(screen.getByText('≥ 2')).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
    await user.click(inspect);
    const list = await screen.findByRole('list');
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('≥ 2')).toBeVisible();
    await user.click(inspect);
    await waitFor(() => expect(screen.queryByRole('list')).toBeNull());
    expect(screen.getByText('≥ 2')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });

  it('renders missing history as unknown rather than seven measured zero totals', async () => {
    const value = fixture(); value.feedback!.sourceState = 'missing';
    stubSurfaceFetch({ routes: { [EXECUTION_FEEDBACK_PATH]: value } });
    render(<ExecutionFeedback />);
    await userEvent.setup().click(screen.getByText('Execution feedback'));
    await screen.findByText(/Totals are unknown/);
    expect(screen.queryByRole('definition')).not.toBeInTheDocument();
  });
  it('handles an older server’s absent route with no mutation', async () => {
    const { posted } = stubSurfaceFetch({ routes: { [EXECUTION_FEEDBACK_PATH]: null } });
    render(<ExecutionFeedback />);
    await userEvent.setup().click(screen.getByText('Execution feedback'));
    await waitFor(() => expect(screen.getByText(/not in this build yet/)).toBeInTheDocument());
    expect(posted).toEqual([]);
  });
  it('rejects incomplete data presented as exact totals and malformed count or case fields', () => {
    expect(narrowExecutionFeedbackRead(fixture())).not.toBeNull();
    const value = fixture(); value.feedback!.counts = value.feedback!.observedCounts;
    expect(narrowExecutionFeedbackRead(value)).toBeNull();
    value.feedback!.counts = null; value.feedback!.observedCounts.failed = NaN;
    expect(narrowExecutionFeedbackRead(value)).toBeNull();
    expect(narrowExecutionFeedbackRead({ v: 1, state: 'current', feedback: null, refreshedAt: null })).toBeNull();
  });
  it('catches up a cold worker promptly and stops requests when closed', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubSurfaceFetch({ routes: { [EXECUTION_FEEDBACK_PATH]: { v: 1, state: 'warming', feedback: null, refreshedAt: null } } });
    render(<ExecutionFeedback />);
    fireEvent.click(screen.getByText('Execution feedback'));
    // jsdom emits the native disclosure toggle asynchronously.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('Execution feedback'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

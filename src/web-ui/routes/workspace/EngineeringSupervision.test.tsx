import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineeringSupervision } from './EngineeringSupervision.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../../core/resources/console-engineering-supervisor-types.js';
import { engineeringEnrollment } from './engineering-fixture.test-support.js';
import type { ResourceEngineeringAutomaticAdmissionStatus as Recovery } from '../../../core/resources/engineering-automatic-admission.js';
let value: Snapshot;
let writes: RequestInit[];
beforeEach(() => {
  writes = []; setMutationToken('a'.repeat(64));
  value = { schemaVersion: 1, configId: 'fleet', configDigest: 'b'.repeat(64), sourceState: 'healthy', state: 'idle',
    deadlineAt: '2026-09-11T00:00:00.000Z', paused: false, revision: 0,
    entries: [{ enrollmentId: 'hub-repair', enrollmentDigest: 'c'.repeat(64), state: 'held', reasons: ['unchanged-evidence'], attempts: 1 }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      writes.push(init); const body = JSON.parse(init.body as string);
      if (url.endsWith('/admit')) value = { ...value, revision: value.revision + 1,
        admission: { ...value.admission!, remainingEnrollments: value.admission!.remainingEnrollments - body.enrollments.length },
        entries: [...value.entries, ...body.enrollments.map((row: { enrollmentId: string; expectedEnrollmentDigest: string }) => ({
          enrollmentId: row.enrollmentId, enrollmentDigest: row.expectedEnrollmentDigest, state: 'waiting', reasons: ['waiting-for-readiness'], attempts: 0 }))] };
      else value = { ...value, paused: body.paused, revision: value.revision + 1, state: body.paused ? 'paused' : 'idle' };
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

describe('automatic admission recovery observation', () => {
  it('retains supervision evidence without mutation controls when the component closes', async () => {
    render(<EngineeringSupervision available unlocked controlsAvailable={false} />);
    await screen.findByText('hub-repair');
    const pause = screen.getByRole('button', { name: 'Pause automatic launches' });
    expect(pause).toBeDisabled(); expect(screen.getByRole('button', { name: 'Refresh supervision' })).toBeEnabled();
    fireEvent.click(pause); expect(writes).toHaveLength(0);
  });
  function setup() {
    value.deadlineAt = new Date(Date.now() + 60_000).toISOString();
    value.admission = { maxEnrollments: 3, remainingEnrollments: 2, autoAdmitPrepared: true };
    const report: Recovery = { schemaVersion: 1, supervisionId: value.configId, configDigest: value.configDigest,
      deadlineAt: value.deadlineAt, sampledAt: new Date(Date.now() - 10_000).toISOString(), state: 'held', reason: null,
      pending: [{ enrollmentId: 'pending-plan', enrollmentDigest: 'd'.repeat(64), reason: 'verification-pending' }] };
    const ordinaryFetch = globalThis.fetch;
    const recoveryRead = vi.fn<() => Promise<Response>>().mockImplementation(async () => new Response(JSON.stringify(report)));
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/automatic-admission')) { signals.push(init!.signal!); return recoveryRead(); }
      return ordinaryFetch(url, init);
    }));
    return { report, recoveryRead, signals };
  }
  it('does not request recovery when automatic preparation admission is not enabled', async () => {
    render(<EngineeringSupervision available unlocked />);
    await screen.findByText('hub-repair');
    expect(screen.queryByRole('region', { name: 'Automatic admission recovery' })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/automatic-admission'))).toBe(false);
    expect(writes).toHaveLength(0);
  });
  it('renders bounded hold descriptions and original sample without implying worker health or execution', async () => {
    const { report } = setup();
    report.pending = ['binding-changed', 'evidence-unavailable', 'verification-pending', 'capacity', 'admission-unavailable'].map((reason, index) => ({
      enrollmentId: `pending-${index}`, enrollmentDigest: 'd'.repeat(64), reason: reason as Recovery['pending'][number]['reason'],
    }));
    render(<EngineeringSupervision available unlocked />);
    await screen.findByText('Recovery held');
    const disclosure = screen.getByText('Review 5 pending registrations');
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(disclosure); expect(disclosure.closest('details')).toHaveAttribute('open');
    for (const text of ['Original queue binding changed.', 'Registration evidence unavailable.', 'Awaiting fresh verification.', 'Lifetime enrollment cap reached.', 'Queue admission was not confirmed.']) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText('Last recovery sample').nextElementSibling?.querySelector('time')).toHaveAttribute('dateTime', report.sampledAt);
    expect(screen.getByText(/This report is not worker health/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeEnabled(); expect(writes).toHaveLength(0);
  });
  it('publishes supervision before a slow recovery read and rejects its late reply after pause', async () => {
    const { report, recoveryRead } = setup(); let resolve!: (response: Response) => void;
    recoveryRead.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<EngineeringSupervision available unlocked />);
    const pause = await screen.findByRole('button', { name: 'Pause automatic launches' });
    await waitFor(() => expect(pause).toBeEnabled());
    expect(screen.getByText('Reading recovery report')).toBeInTheDocument();
    fireEvent.click(pause); await screen.findByRole('button', { name: 'Resume automatic launches' });
    await act(async () => resolve(new Response(JSON.stringify(report))));
    expect(screen.queryByText('pending-plan')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume automatic launches' })).toBeEnabled(); expect(writes).toHaveLength(1);
  });
  it('keeps pause usable and redacts recovery failures', async () => {
    const { recoveryRead } = setup(); recoveryRead.mockRejectedValue(new Error('/private/SECRET recovery failed'));
    render(<EngineeringSupervision available unlocked />);
    await screen.findByText('Recovery unavailable');
    expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeEnabled();
    expect(screen.getByText(/Automatic admission recovery could not be verified/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it('uses the same non-overlapping poll and retains historical details through failure, then recovers', async () => {
    vi.useFakeTimers();
    try {
      const { report, recoveryRead } = setup();
      const view = render(<EngineeringSupervision available unlocked />);
      await act(async () => {}); expect(recoveryRead).toHaveBeenCalledTimes(1);
      recoveryRead.mockRejectedValueOnce(new Error('private failure'));
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(recoveryRead).toHaveBeenCalledTimes(2); expect(screen.getByText('Historical recovery report')).toBeInTheDocument();
      expect(screen.getByText('pending-plan')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeEnabled();
      report.state = 'ready'; report.pending = [];
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(recoveryRead).toHaveBeenCalledTimes(3); expect(screen.getByText('Last pass clear')).toBeInTheDocument();
      expect(screen.queryByText('pending-plan')).not.toBeInTheDocument(); expect(screen.queryByText(/could not be verified/)).not.toBeInTheDocument();
      expect(writes).toHaveLength(0); view.unmount();
    } finally { vi.useRealTimers(); }
  });
  it('aborts and clears recovery across selected project changes and disconnect', async () => {
    const { report, recoveryRead, signals } = setup(); const selected = engineeringEnrollment();
    let resolve!: (response: Response) => void;
    recoveryRead.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<EngineeringSupervision available unlocked selectedPlan={selected} />);
    await waitFor(() => expect(recoveryRead).toHaveBeenCalledOnce());
    recoveryRead.mockResolvedValue(new Response(JSON.stringify({ ...report, pending: [], state: 'idle', sampledAt: null })));
    view.rerender(<EngineeringSupervision available unlocked selectedPlan={{ ...selected, projectId: 'another-project' }} />);
    await screen.findByText('Not sampled'); expect(signals[0]!.aborted).toBe(true);
    await act(async () => resolve(new Response(JSON.stringify(report))));
    expect(screen.queryByText('pending-plan')).not.toBeInTheDocument();
    view.rerender(<EngineeringSupervision available={false} unlocked selectedPlan={{ ...selected, projectId: 'another-project' }} />);
    expect(screen.getByText('Historical recovery report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeDisabled();
    view.unmount(); expect(writes).toHaveLength(0);
  });
  it('removes foreign queue details before waiting for its new bound report', async () => {
    vi.useFakeTimers();
    try {
      const { recoveryRead } = setup();
      const view = render(<EngineeringSupervision available unlocked />); await act(async () => {});
      expect(screen.getByText('pending-plan')).toBeInTheDocument();
      value = { ...value, configId: 'another-queue', configDigest: 'e'.repeat(64) };
      recoveryRead.mockImplementationOnce(() => new Promise(() => {}));
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(screen.queryByText('pending-plan')).not.toBeInTheDocument(); expect(screen.getByText('Reading recovery report')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeEnabled();
      view.unmount();
    } finally { vi.useRealTimers(); }
  });
  it('does not interpret an empty capacity report as no pending work and identifies retained reconciling samples', async () => {
    const { report } = setup(); report.pending = []; report.reason = 'capacity'; report.state = 'reconciling';
    const view = render(<EngineeringSupervision available unlocked />);
    await screen.findByText('Checking pending registrations');
    expect(screen.getByText(/its sample and holds are from the preceding report/)).toBeInTheDocument();
    expect(screen.getByText(/does not establish that no registrations remain pending/)).toBeInTheDocument();
    view.rerender(<EngineeringSupervision available={false} unlocked />);
    expect(screen.getByText('Historical recovery report')).toBeInTheDocument();
    expect(screen.getByText(/The last report recorded a recovery pass in progress/)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it('bounds a hung recovery read without overlapping polls, and aborts on unmount', async () => {
    vi.useFakeTimers();
    try {
      const { recoveryRead, signals } = setup();
      recoveryRead.mockImplementation(() => new Promise(() => {}));
      const view = render(<EngineeringSupervision available unlocked />); await act(async () => {});
      expect(recoveryRead).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeEnabled();
      await act(async () => vi.advanceTimersByTimeAsync(4999));
      expect(recoveryRead).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(signals[0]!.aborted).toBe(true); expect(screen.getByText('Recovery unavailable')).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(recoveryRead).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeEnabled();
      view.unmount(); expect(signals[1]!.aborted).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(recoveryRead).toHaveBeenCalledTimes(2); expect(writes).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('automatic engineering operating panel', () => {
  it('notifies selected evidence changes once without launching work or reacting to foreign rows', async () => {
    vi.useFakeTimers();
    try {
      const selected = engineeringEnrollment(); const changed = vi.fn();
      value.entries = [{ enrollmentId: selected.id, enrollmentDigest: selected.enrollmentDigest, state: 'waiting', reasons: ['not-started'], attempts: 0 }];
      const view = render(<EngineeringSupervision available unlocked selectedPlan={selected} onSelectedEvidenceChange={changed} />);
      await act(async () => {}); expect(changed).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(changed).toHaveBeenCalledOnce();
      value.entries[0] = { ...value.entries[0]!, state: 'running', reasons: ['running'], attempts: 1 };
      await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(changed).toHaveBeenCalledTimes(2);
      value.entries.push({ enrollmentId: 'foreign', enrollmentDigest: 'f'.repeat(64), state: 'completed', reasons: ['completed'], attempts: 1 });
      await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(changed).toHaveBeenCalledTimes(2);
      value.entries[0] = { ...value.entries[0]!, state: 'completed', reasons: ['completed'] };
      await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(changed).toHaveBeenCalledTimes(3);
      expect(writes).toHaveLength(0); view.unmount();
    } finally { vi.useRealTimers(); }
  });
  it('never refreshes a selected plan from a same-ID different-digest queue entry', async () => {
    const selected = engineeringEnrollment(); const changed = vi.fn();
    value.entries = [{ enrollmentId: selected.id, enrollmentDigest: 'f'.repeat(64), state: 'running', reasons: ['running'], attempts: 1 }];
    render(<EngineeringSupervision available unlocked selectedPlan={selected} onSelectedEvidenceChange={changed} />);
    await screen.findByText(selected.id); expect(changed).not.toHaveBeenCalled(); expect(writes).toHaveLength(0);
  });
  const dynamic = () => { value.deadlineAt = new Date(Date.now() + 60_000).toISOString(); value.admission = { maxEnrollments: 3, remainingEnrollments: 2, autoAdmitPrepared: false }; };
  it('admits the selected plan only on click and preserves a paused queue', async () => {
    dynamic(); value.paused = true; value.state = 'paused'; const selected = engineeringEnrollment();
    render(<EngineeringSupervision available unlocked selectedPlan={selected} />);
    const button = await screen.findByRole('button', { name: 'Add plan to automatic work' }); expect(button).toBeEnabled(); expect(writes).toHaveLength(0);
    expect(screen.getByText(/Adding a plan authorizes automatic execution/)).toBeInTheDocument();
    fireEvent.click(button); await screen.findByText('Plan added. Automatic launches remain paused.');
    expect(writes).toHaveLength(1); expect(JSON.parse(String(writes[0]!.body))).toEqual({ enrollments: [{ enrollmentId: selected.id, expectedEnrollmentDigest: selected.enrollmentDigest }], expectedRevision: 0 });
    expect(value.paused).toBe(true); expect(button).toBeDisabled(); expect(screen.getByText('This plan is already in the automatic queue.')).toBeInTheDocument();
  });
  it('allows an opted-in completed queue to accept new work before its original deadline', async () => {
    dynamic(); value.state = 'completed'; value.entries[0]!.state = 'completed';
    render(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment()} />);
    expect(await screen.findByRole('button', { name: 'Add plan to automatic work' })).toBeEnabled(); expect(writes).toHaveLength(0);
  });
  it.each(['empty', 'all-completed'])('labels the running appendable %s queue as waiting, not active workers', async condition => {
    dynamic(); value.state = 'running';
    if (condition === 'empty') { value.entries = []; value.admission!.remainingEnrollments = 3; }
    else value.entries[0]!.state = 'completed';
    render(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment()} />);
    await screen.findByText('Waiting for new plans');
    expect(screen.getByText(/No engineering plan in this queue is active/)).toHaveTextContent('not running workers');
    expect(writes).toHaveLength(0);
  });
  it('does not label a queue with active work as waiting for new plans', async () => {
    dynamic(); value.state = 'running'; value.entries[0]!.state = 'running';
    render(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment()} />);
    await screen.findByText('hub-repair'); expect(screen.queryByText('Waiting for new plans')).not.toBeInTheDocument();
  });
  it.each(['running', 'completed'] as const)('labels the full %s queue with completed work as admission limit reached', async state => {
    dynamic(); value.state = state; value.entries[0]!.state = 'completed';
    value.admission = { maxEnrollments: 1, remainingEnrollments: 0, autoAdmitPrepared: false };
    const deadline = value.deadlineAt;
    render(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment()} />);
    await screen.findByText('Admission limit reached');
    expect(screen.getByText(/All current work is complete/)).toHaveTextContent('The lifetime enrollment cap is exhausted');
    expect(screen.getByText(/All current work is complete/)).toHaveTextContent('the original deadline is not renewed');
    expect(screen.queryByText('Waiting for new plans')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add plan to automatic work' })).toBeDisabled();
    expect(value.deadlineAt).toBe(deadline); expect(writes).toHaveLength(0);
  });
  it('opens existing unlock flow without making an admission request', async () => {
    dynamic(); const onUnlock = vi.fn();
    render(<EngineeringSupervision available unlocked={false} onUnlock={onUnlock} selectedPlan={engineeringEnrollment()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock to add plan' }));
    expect(onUnlock).toHaveBeenCalledOnce(); expect(writes).toHaveLength(0);
  });
  it.each(['full', 'closed', 'timed-out', 'unavailable', 'expired'])('disables %s admission', async condition => {
    dynamic();
    if (condition === 'full') value.admission = { maxEnrollments: 1, remainingEnrollments: 0, autoAdmitPrepared: false };
    else if (condition === 'expired') value.deadlineAt = '2020-01-01T00:00:00.000Z';
    else value.state = condition as Snapshot['state'];
    render(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment()} />);
    expect(await screen.findByRole('button', { name: 'Add plan to automatic work' })).toBeDisabled(); expect(writes).toHaveLength(0);
  });
  it('keeps uncertain admission blocked until an explicit refresh', async () => {
    dynamic(); const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, options) => options?.method === 'POST' ? new Response('{}', { status: 409 }) : original(input, options));
    render(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add plan to automatic work' })); await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Add plan to automatic work' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh supervision' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('ignores a late admission response after the selected project changes', async () => {
    dynamic(); let resolve!: (value: Response) => void; const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, options) => options?.method === 'POST' ? new Promise<Response>(r => { resolve = r; }) : original(input, options));
    const view = render(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add plan to automatic work' }));
    view.rerender(<EngineeringSupervision available unlocked selectedPlan={engineeringEnrollment('other')} />);
    await act(async () => resolve(new Response(JSON.stringify(value), { status: 200 })));
    expect(screen.queryByText(/Plan added/)).not.toBeInTheDocument();
    expect(screen.getByText('Selected plan: other-build')).toBeInTheDocument();
  });
  it('shows held evidence and scope, then pauses and resumes only on explicit clicks', async () => {
    render(<EngineeringSupervision available unlocked />);
    await screen.findByText('hub-repair');
    expect(screen.getByText(/Unresolved evidence has not changed/)).toBeInTheDocument();
    expect(screen.getByText(/Pause affects new automatic launches across all projects/)).toBeInTheDocument();
    expect(screen.getByText(/1 graph invocations; not model-request usage/)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic launches' }));
    await screen.findByRole('button', { name: 'Resume automatic launches' });
    expect(writes).toHaveLength(1); expect(JSON.parse(writes[0]!.body as string)).toEqual({ paused: true, expectedRevision: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Resume automatic launches' }));
    await screen.findByRole('button', { name: 'Pause automatic launches' }); expect(writes).toHaveLength(2);
  });
  it('keeps control disabled while locked or disconnected and marks prior evidence stale', async () => {
    const view = render(<EngineeringSupervision available unlocked={false} />); await screen.findByText('hub-repair');
    expect(screen.getByRole('button', { name: 'Unlock supervision controls' })).toBeDisabled();
    view.rerender(<EngineeringSupervision available={false} unlocked />);
    expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeDisabled();
    expect(screen.getByText(/Displayed evidence may be stale/)).toBeInTheDocument(); expect(writes).toHaveLength(0);
  });
  it('does not turn an expired budget into a resume action', async () => {
    value = { ...value, state: 'timed-out', paused: true };
    render(<EngineeringSupervision available unlocked />); await screen.findByText('timed-out');
    expect(screen.getByRole('button', { name: 'Resume automatic launches' })).toBeDisabled(); expect(writes).toHaveLength(0);
  });
  it('holds controls when backend evidence is malformed', async () => {
    value = { ...value, configDigest: 'not-a-digest' };
    render(<EngineeringSupervision available unlocked />); await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Pause automatic launches' })).toBeDisabled(); expect(writes).toHaveLength(0);
  });
});

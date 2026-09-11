import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineeringSupervision } from './EngineeringSupervision.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../../core/resources/console-engineering-supervisor-types.js';
import { engineeringEnrollment } from './engineering-fixture.test-support.js';
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
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('automatic engineering operating panel', () => {
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

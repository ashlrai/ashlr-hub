import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceEngineeringSuccessorCoordinatorSnapshot as Snapshot } from '../../../core/resources/engineering-successor-coordinator-types.js';
import { readEngineeringSuccessors } from '../../data/engineering-successors.js';
import { EngineeringSuccessors } from './EngineeringSuccessors.js';
import { engineeringEnrollment } from './engineering-fixture.test-support.js';

vi.mock('../../data/engineering-successors.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../data/engineering-successors.js')>(), readEngineeringSuccessors: vi.fn(),
}));
const read = vi.mocked(readEngineeringSuccessors);
const key = 'a'.repeat(48); const next = `successor-${key}`;
const entry = (state: Snapshot['entries'][number]['state'] = 'proposing'): Snapshot['entries'][number] => ({
  sourceEnrollmentId: 'source', proposalTaskId: `proposal-${key}`, successorId: next, state, reason: null,
});
const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({ schemaVersion: 1, supervisionId: 'queue', profileId: 'fixed-checks',
  configDigest: 'b'.repeat(64), deadlineAt: '2026-09-20T00:00:00.000Z', state: 'running', maxSuccessors: 4, entries: [entry()], ...patch });
const journal = (state: Snapshot['entries'][number]['state'] = 'intent-recorded'): Snapshot => snapshot({ state: 'observing', entries: [entry(state)],
  observation: { kind: 'durable-journal', sampledAt: '2026-09-19T00:00:00.000Z', recordsDigest: 'd'.repeat(64), workerState: 'connected' } });
const plan = (id: string, projectId = 'default') => ({ ...engineeringEnrollment(projectId), id });
const props = () => ({ available: true, projectId: 'default', catalog: [plan('source')],
  onInspectEnrollment: vi.fn(), onRegisteredEnrollments: vi.fn() });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const tick = async (ms = 3000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.useFakeTimers(); read.mockReset().mockResolvedValue(snapshot()); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('successor planning observation panel', () => {
  it('distinguishes verified journal milestones from worker activity and downstream proof', async () => {
    read.mockResolvedValue(journal()); const input = props(); render(<EngineeringSuccessors {...input} />); await flush();
    expect(screen.getByText('Verified journal')).toBeInTheDocument(); expect(screen.getByText('Worker connected')).toBeInTheDocument();
    expect(screen.getByText('Proposal intent recorded')).toBeInTheDocument(); expect(screen.getByText('Reserved successor ID')).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-09-19T00:00:00.000Z"]')).toBeInTheDocument();
    expect(screen.getByText(/connected worker does not mean work is executing/)).toBeInTheDocument();
    expect(screen.getByText(/does not reverify worker accounting or local delivery/)).toBeInTheDocument();
    expect(screen.getByText(/does not establish that a request is running or held/)).toBeInTheDocument();
    expect(screen.queryByText('Coordinator running')).not.toBeInTheDocument(); expect(screen.queryByText('Requesting proposal')).not.toBeInTheDocument();
    expect(input.onRegisteredEnrollments).not.toHaveBeenCalled(); expect(input.onInspectEnrollment).not.toHaveBeenCalled();
  });
  it.each(['proposed', 'stopped', 'prepared', 'admitted'] as const)('uses only recorded %s evidence for catalog refresh', async state => {
    read.mockResolvedValue(journal(state)); const input = props(); render(<EngineeringSuccessors {...input} />); await flush();
    if (state === 'prepared' || state === 'admitted') expect(input.onRegisteredEnrollments).toHaveBeenCalledExactlyOnceWith([next]);
    else expect(input.onRegisteredEnrollments).not.toHaveBeenCalled();
    if (state === 'admitted') expect(screen.getByText(/Admission is not execution, evaluation, or delivery/)).toBeInTheDocument();
    expect(screen.queryByText('Preparing plan')).not.toBeInTheDocument(); expect(screen.queryByText('Queue admission in progress')).not.toBeInTheDocument();
  });
  it('accepts new journal samples without changing identity, then retains them as stale on disconnect', async () => {
    read.mockResolvedValue(journal('proposed')); const input = props(); const view = render(<EngineeringSuccessors {...input} />); await flush();
    const later = journal('prepared'); later.observation = { ...later.observation!, sampledAt: '2026-09-19T00:01:00.000Z', recordsDigest: 'e'.repeat(64) };
    read.mockResolvedValue(later); await tick(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input.onRegisteredEnrollments).toHaveBeenCalledExactlyOnceWith([next]);
    expect(document.querySelector('time[datetime="2026-09-19T00:01:00.000Z"]')).toBeInTheDocument();
    view.rerender(<EngineeringSuccessors {...input} available={false} />);
    expect(screen.getByText('Plan prepared')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Inspect source' })).toBeDisabled();
    expect(screen.getByText(/Displayed evidence may be stale/)).toBeInTheDocument();
  });
  it.each(['exited', 'faulted'] as const)('does not promote prepared observations from an %s worker to catalog refresh', async workerState => {
    const value = journal('prepared'); value.state = 'unavailable'; value.observation!.workerState = workerState;
    read.mockResolvedValue(value); const input = props(); render(<EngineeringSuccessors {...input} />); await flush();
    expect(screen.getByRole('button', { name: 'Inspect source' })).toBeDisabled(); expect(input.onRegisteredEnrollments).not.toHaveBeenCalled();
    expect(screen.getByText(workerState === 'exited' ? 'Worker exited' : 'Worker unavailable')).toBeInTheDocument();
  });
  it('shows original limits and an honest empty coordinator without mutation callbacks', async () => {
    read.mockResolvedValue(snapshot({ entries: [] })); const input = props();
    render(<EngineeringSuccessors {...input} />); await flush();
    expect(screen.getByRole('region', { name: 'Successor planning' })).toBeInTheDocument();
    expect(screen.getByText('No successor intent recorded.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('0 / 4')).toBeInTheDocument(); expect(screen.getByText('fixed-checks')).toBeInTheDocument();
    expect(screen.getByText('Coordinator running')).toBeInTheDocument();
    expect(document.querySelector('time')?.dateTime).toBe('2026-09-20T00:00:00.000Z');
    expect(input.onInspectEnrollment).not.toHaveBeenCalled(); expect(input.onRegisteredEnrollments).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it.each([
    ['proposing', 'Requesting proposal'], ['waiting-for-capacity', 'Waiting for shared capacity'], ['preparing', 'Preparing plan'],
    ['admitting', 'Queue admission in progress'], ['held', 'Held for inspection'], ['proposed', 'Proposal recorded'],
    ['prepared', 'Plan prepared'], ['admitted', 'Queued'], ['stopped', 'No successor proposed'],
  ] as const)('renders %s as %s, never as delivery success', async (state, label) => {
    read.mockResolvedValue(snapshot({ entries: [entry(state)] })); const input = props(); render(<EngineeringSuccessors {...input} />); await flush();
    expect(screen.getByText(label)).toBeInTheDocument(); expect(screen.getByText(`proposal-${key}`)).toBeInTheDocument();
    expect(screen.getByText(next)).toBeInTheDocument(); expect(screen.getByText('1 / 4')).toBeInTheDocument();
    expect(screen.queryByText('Delivery recorded')).not.toBeInTheDocument(); expect(screen.queryByText('Recorded delivery')).not.toBeInTheDocument();
    if (state === 'prepared' || state === 'admitted') expect(input.onRegisteredEnrollments).toHaveBeenCalledExactlyOnceWith([next]);
    else expect(input.onRegisteredEnrollments).not.toHaveBeenCalled();
    if (state === 'admitted') expect(screen.getByText(/Admission is not execution, evaluation, or delivery/)).toBeInTheDocument();
    if (state === 'stopped') expect(screen.getByText(/does not cancel other engineering work/)).toBeInTheDocument();
    if (!['prepared', 'admitted', 'admitting'].includes(state)) expect(screen.getByText('Reserved successor ID')).toBeInTheDocument();
  });
  it('reports newly registered descendants once, without selecting them or restarting polling on callback changes', async () => {
    const input = props(); const view = render(<EngineeringSuccessors {...input} />); await flush();
    expect(input.onRegisteredEnrollments).not.toHaveBeenCalled();
    read.mockResolvedValue(snapshot({ entries: [entry('prepared')] })); await tick();
    expect(input.onRegisteredEnrollments).toHaveBeenCalledExactlyOnceWith([next]);
    const latest = vi.fn(); view.rerender(<EngineeringSuccessors {...input} onRegisteredEnrollments={latest} />); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(snapshot({ entries: [entry('admitted')] })); await tick(); expect(latest).not.toHaveBeenCalled();
    const second = { ...entry('prepared'), sourceEnrollmentId: next, successorId: `successor-${'c'.repeat(48)}`, proposalTaskId: `proposal-${'c'.repeat(48)}` };
    read.mockResolvedValue(snapshot({ entries: [entry('admitted'), second] })); await tick();
    expect(latest).toHaveBeenCalledExactlyOnceWith([second.successorId]); expect(input.onInspectEnrollment).not.toHaveBeenCalled();
  });
  it('resolves inspection from the current project catalog only and exposes no execution control', async () => {
    read.mockResolvedValue(snapshot({ entries: [entry('admitted')] })); const input = props();
    const view = render(<EngineeringSuccessors {...input} catalog={[plan('source'), plan(next, 'other')]} />); await flush();
    expect(screen.getByText('Another project')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: `Inspect ${next}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect source' })); expect(input.onInspectEnrollment).toHaveBeenCalledExactlyOnceWith('source');
    view.rerender(<EngineeringSuccessors {...input} catalog={[plan('source'), plan(next)]} />);
    fireEvent.click(screen.getByRole('button', { name: `Inspect ${next}` })); expect(input.onInspectEnrollment).toHaveBeenLastCalledWith(next);
    expect(screen.queryByRole('button', { name: /run|pause|admit|unlock|prepare|cancel/i })).not.toBeInTheDocument();
    view.rerender(<EngineeringSuccessors {...input} projectId="other" catalog={[plan('source'), plan(next)]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('waits for a slow read to settle before starting the three-second polling delay', async () => {
    const pending = deferred<Snapshot>(); read.mockReturnValueOnce(pending.promise);
    render(<EngineeringSuccessors {...props()} />); await tick(30_000); expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(snapshot()); }); await tick(2999); expect(read).toHaveBeenCalledTimes(1);
    await tick(1); expect(read).toHaveBeenCalledTimes(2);
  });
  it('aborts and ignores an outstanding response on unmount', async () => {
    const pending = deferred<Snapshot>(); read.mockReturnValueOnce(pending.promise); const input = props();
    const view = render(<EngineeringSuccessors {...input} />); const signal = read.mock.calls[0]![0]!; view.unmount();
    expect(signal.aborted).toBe(true); await act(async () => { pending.resolve(snapshot({ entries: [entry('prepared')] })); });
    expect(input.onRegisteredEnrollments).not.toHaveBeenCalled(); await tick(30_000); expect(read).toHaveBeenCalledTimes(1);
  });
  it('retains stale evidence on read failure, hides raw errors, then recovers through a fresh read', async () => {
    const input = props(); render(<EngineeringSuccessors {...input} />); await flush();
    read.mockRejectedValueOnce(Error('/private/secret-file: sensitive backend failure')); await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Retained status may be stale');
    expect(screen.getByText('source')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Inspect source' })).toBeDisabled();
    expect(document.body).not.toHaveTextContent('secret-file'); expect(document.body).not.toHaveTextContent('sensitive backend');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect source' })); expect(input.onInspectEnrollment).not.toHaveBeenCalled();
    await tick(); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Inspect source' })).toBeEnabled();
  });
  it('aborts on disconnect and never consumes a late prepared identity from the old read', async () => {
    const input = props(); const view = render(<EngineeringSuccessors {...input} />); await flush();
    const pending = deferred<Snapshot>(); read.mockReturnValueOnce(pending.promise); await tick();
    const signal = read.mock.calls[1]![0]!; view.rerender(<EngineeringSuccessors {...input} available={false} />);
    expect(signal.aborted).toBe(true); expect(screen.getByText(/Displayed evidence may be stale/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect source' })).toBeDisabled();
    await act(async () => { pending.resolve(snapshot({ entries: [entry('prepared')] })); });
    expect(input.onRegisteredEnrollments).not.toHaveBeenCalled(); await tick(30_000); expect(read).toHaveBeenCalledTimes(2);
    view.rerender(<EngineeringSuccessors {...input} />); await flush(); expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Inspect source' })).toBeEnabled();
  });
  it.each([
    { supervisionId: 'other' }, { profileId: 'other' }, { configDigest: 'f'.repeat(64) },
    { deadlineAt: '2026-09-21T00:00:00.000Z' }, { maxSuccessors: 5 },
  ])('latches changed coordinator identity %j until remount rather than consuming its entries', async patch => {
    const input = props(); render(<EngineeringSuccessors {...input} />); await flush();
    read.mockResolvedValue(snapshot({ ...patch, entries: [entry('prepared')] })); await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('Coordinator identity changed');
    expect(input.onRegisteredEnrollments).not.toHaveBeenCalled(); expect(screen.getByText('Reserved successor ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect source' })).toBeDisabled(); await tick(30_000); expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not inspect or notify from unavailable coordinator evidence', async () => {
    read.mockResolvedValue(snapshot({ state: 'unavailable', entries: [entry('prepared')] })); const input = props();
    render(<EngineeringSuccessors {...input} />); await flush(); expect(screen.getByText('Coordinator unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect source' })).toBeDisabled(); expect(input.onRegisteredEnrollments).not.toHaveBeenCalled();
  });
  it('renders only fixed reason descriptions even if a caller supplies an unknown private reason', async () => {
    read.mockResolvedValue(snapshot({ entries: [{ ...entry('held'), reason: '/private/path secret' }] }));
    render(<EngineeringSuccessors {...props()} />); await flush();
    expect(screen.getByText('Recorded evidence needs inspection.')).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('/private/path');
  });
  it('performs no reads while unavailable before the first sample', async () => {
    render(<EngineeringSuccessors {...props()} available={false} />); await tick(30_000); expect(read).not.toHaveBeenCalled();
    expect(screen.getByText('Connection unavailable')).toBeInTheDocument();
  });
});

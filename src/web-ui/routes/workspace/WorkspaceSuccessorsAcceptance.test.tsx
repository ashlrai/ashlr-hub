import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceEngineering } from './WorkspaceEngineering.js';
import { engineeringEnrollment, engineeringJob, engineeringReadiness } from './engineering-fixture.test-support.js';
import type { ResourceEngineeringSuccessorCoordinatorSnapshot as Snapshot } from '../../../core/resources/engineering-successor-coordinator-types.js';

const suffix = 'b'.repeat(48);
const successorId = `successor-${suffix}`;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(projectId = 'default') {
  const source = engineeringEnrollment();
  const descendant = { ...engineeringEnrollment(projectId), id: successorId, objective: 'Improve the delivered candidate' };
  let registered = false;
  const snapshot: Snapshot = { schemaVersion: 1, supervisionId: 'queue', profileId: 'fixed-evaluator', configDigest: 'a'.repeat(64),
    deadlineAt: '2026-09-12T00:00:00.000Z', state: 'running', maxSuccessors: 2,
    entries: [{ sourceEnrollmentId: source.id, proposalTaskId: `proposal-${suffix}`, successorId, state: 'proposing', reason: null }] };
  const request = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method !== 'GET') throw new Error('Fixture forbids writes');
    if (url === '/api/resources/engineering-successors') return json(snapshot);
    if (url === '/api/resources/engineering') return json(registered ? [descendant, source] : [source]);
    const row = url.includes(successorId) ? descendant : source;
    if (url.endsWith('/readiness')) return json(engineeringReadiness(row));
    if (url === `/api/resources/engineering/${row.id}`) return json(engineeringJob(row));
    throw new Error('Unexpected fixture read');
  });
  vi.stubGlobal('fetch', request);
  const props = { projectId: 'default', projectName: 'Hub', available: true, canStart: true, canStop: true,
    unlocked: false, onUnlock: vi.fn(), successorsSupported: true };
  return { props, request, snapshot, register: () => { registered = true; snapshot.entries[0]!.state = 'admitted'; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('successor observation in the project workspace', () => {
  it.each(['default', 'foreign'])('refreshes a newly registered %s descendant once and preserves selection', async projectId => {
    const f = fixture(projectId); const view = render(<WorkspaceEngineering {...f.props} />);
    await act(async () => {});
    expect(screen.getByRole('combobox', { name: 'Enrolled engineering plan' })).toHaveValue('default-build');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    f.register(); await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('combobox', { name: 'Enrolled engineering plan' })).toHaveValue('default-build');
    expect(screen.getAllByRole('option')).toHaveLength(projectId === 'default' ? 2 : 1);
    const catalogReads = () => f.request.mock.calls.filter(([url]) => url === '/api/resources/engineering').length;
    const count = catalogReads(); expect(count).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(catalogReads()).toBe(count);
    expect(screen.queryByText('Recorded delivery')).not.toBeInTheDocument();
    if (projectId === 'default') {
      fireEvent.change(screen.getByRole('combobox', { name: 'Enrolled engineering plan' }), { target: { value: successorId } });
      await act(async () => {}); expect(screen.getByRole('combobox')).toHaveValue(successorId);
      expect(screen.getByRole('heading', { name: 'Improve the delivered candidate' })).toBeInTheDocument();
    } else expect(screen.queryByText('Improve the delivered candidate')).not.toBeInTheDocument();
    expect(f.request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true); view.unmount();
  });
  it('never reads successor status when the host capability is absent', async () => {
    const f = fixture(); const view = render(<WorkspaceEngineering {...f.props} successorsSupported={false} />);
    await act(async () => {}); await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(f.request.mock.calls.some(([url]) => url === '/api/resources/engineering-successors')).toBe(false); view.unmount();
  });
  it('withholds automatic catalog refresh on connection loss and recovers by read only', async () => {
    const f = fixture(); const view = render(<WorkspaceEngineering {...f.props} />); await act(async () => {});
    view.rerender(<WorkspaceEngineering {...f.props} available={false} />); f.register();
    const count = f.request.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(f.request).toHaveBeenCalledTimes(count);
    view.rerender(<WorkspaceEngineering {...f.props} />); await act(async () => {});
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('combobox')).toHaveValue('default-build');
    expect(f.request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true); view.unmount();
  });
});

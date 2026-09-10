import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';
import { engineeringEnrollment, engineeringJob, engineeringReadiness } from './engineering-fixture.test-support.js';
const token = 'b'.repeat(64);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function props(): WorkspaceViewProps {
  const fixture = resourceFixture(); fixture.scope.engineeringSupported = true; fixture.scope.defaultProjectId = 'default';
  fixture.scope.projects = [{ id: 'default', label: 'Hub', workspace: fixture.scope.workspace!, enabled: true },
    { id: 'notes', label: 'Notes', workspace: '/fixture/notes', enabled: true }];
  return { ...fixture, historical: false, enabled: true, stopEnabled: true, busy: false, unlocked: true,
    onUnlock: vi.fn(), onSubmit: vi.fn(async () => true), onCancel: vi.fn() };
}
const workspace = () => within(screen.getByRole('region', { name: 'Project task workspace' }));
const enter = () => fireEvent.click(workspace().getByRole('button', { name: 'Engineering runs' }));
function transport() {
  const row = engineeringEnrollment(); let launched = false;
  const request = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/resources/engineering' && options?.method === 'GET') return json([row]);
    if (url === '/api/resources/engineering/default-build/readiness') return json(engineeringReadiness(row, launched ? { status: 'not-applicable', action: 'none', reasons: ['already-completed'] } : {}));
    if (url === '/api/resources/engineering/start') {
      expect(options?.headers).toMatchObject({ 'x-ashlr-token': token });
      expect(JSON.parse(String(options?.body))).toEqual({ enrollmentId: row.id, expectedEnrollmentDigest: row.enrollmentDigest }); launched = true;
    }
    if (url === '/api/resources/engineering/default-build' || url === '/api/resources/engineering/start') return json(engineeringJob(row, launched ? {
      state: 'completed', sourceState: 'healthy', launched: true, definitionDigest: 'd'.repeat(64), deadlineAt: '2026-09-10T10:00:00.000Z',
      nodes: [{ id: 'deliver', kind: 'deliver', state: 'completed', artifactDigest: 'f'.repeat(64) }],
    } : {}));
    throw new Error(`Unexpected fixture request ${url}`);
  }); vi.stubGlobal('fetch', request); return request;
}
beforeEach(() => { setMutationToken(token); });
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('workspace engineering operating surface', () => {
  it('withholds new engineering while the ordinary task queue is paused', async () => {
    transport(); const input = props(); input.snapshot.supervisor!.paused = true;
    render(<WorkspaceView {...input} />); enter(); const run = await screen.findByRole('button', { name: 'Run enrolled plan' });
    await screen.findByText('Not started'); expect(run).toBeDisabled();
    expect(screen.getByText(/active engineering runs are not stopped/)).toBeInTheDocument();
  });
  it('opens a real validated enrollment projection, sends ID/digest only, and separates delivery from chat', async () => {
    const request = transport(); const input = props(); render(<WorkspaceView {...input} />); expect(request).not.toHaveBeenCalled(); enter();
    const run = await screen.findByRole('button', { name: 'Run enrolled plan' });
    await vi.waitFor(() => expect(run).toBeEnabled());
    expect(screen.getByText('codex/verified-integer')).toBeInTheDocument(); expect(screen.getByText('9,000')).toBeInTheDocument();
    expect(request.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
    await act(async () => fireEvent.click(run));
    await screen.findByText('Recorded delivery'); expect(screen.getByText(/not a deployment/)).toBeInTheDocument();
    expect(input.onSubmit).not.toHaveBeenCalled(); expect(request.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Run enrolled plan' })).toBeDisabled();
  });
  it('preserves chat drafts across engineering and project selection without leaking another project enrollment', async () => {
    const request = transport(); render(<WorkspaceView {...props()} />);
    fireEvent.change(workspace().getByLabelText('Task prompt'), { target: { value: 'Keep my Hub draft' } }); enter(); await screen.findByText('Improve the integer evaluator');
    fireEvent.click(workspace().getByRole('button', { name: 'Switch to Notes' })); enter(); await screen.findByText('No engineering plan enrolled for this project.');
    expect(screen.queryByText('Improve the integer evaluator')).not.toBeInTheDocument();
    fireEvent.click(workspace().getByRole('button', { name: 'Switch to Hub' })); fireEvent.click(workspace().getByRole('button', { name: '+ New task' }));
    expect(workspace().getByLabelText('Task prompt')).toHaveValue('Keep my Hub draft');
    expect(request.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });
  it('offers unlock without dispatching, and absent capability keeps the legacy workspace unchanged', async () => {
    const request = transport(); const input = props(); const view = render(<WorkspaceView {...input} unlocked={false} />); enter();
    const unlock = await screen.findByRole('button', { name: 'Unlock to run' }); await vi.waitFor(() => expect(unlock).toBeEnabled()); fireEvent.click(unlock);
    expect(input.onUnlock).toHaveBeenCalledOnce(); expect(request.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
    const scope = { ...input.scope }; delete scope.engineeringSupported; view.rerender(<WorkspaceView {...input} scope={scope} />);
    expect(screen.queryByRole('button', { name: 'Engineering runs' })).not.toBeInTheDocument();
    expect(workspace().getByLabelText('Task prompt')).toBeInTheDocument();
  });
});

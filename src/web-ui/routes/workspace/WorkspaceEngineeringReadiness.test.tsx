import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { WorkspaceEngineering } from './WorkspaceEngineering.js';
import { engineeringEnrollment, engineeringJob, engineeringReadiness } from './engineering-fixture.test-support.js';

const row = engineeringEnrollment();
const props = { projectId: 'default', projectName: 'Hub', available: true, canStart: true, canStop: true, unlocked: true, onUnlock: vi.fn() };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const panel = () => within(screen.getByRole('region', { name: 'Local launch checks' }));
function transport(initial = engineeringReadiness(), initialJob = engineeringJob()) {
  let readiness: unknown = initial; let job = initialJob; let failure = false;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/resources/engineering') return json([row]);
    if (url.endsWith('/readiness')) return failure ? json({ error: 'unavailable' }, 503) : json(readiness);
    if (options?.method === 'POST') return json(job);
    if (url === `/api/resources/engineering/${row.id}`) return json(job);
    throw new Error(`Unexpected fixture route ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, setReadiness: (v: unknown) => { readiness = v; }, setJob: (v: typeof job) => { job = v; }, fail: () => { failure = true; },
    posts: () => fetcher.mock.calls.filter(([, options]) => options?.method === 'POST') };
}
beforeEach(() => { setMutationToken('b'.repeat(64)); });
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('engineering local admission UX', () => {
  it('explains a stop hold, then requires explicit refresh and explicit launch after it clears', async () => {
    const f = transport(engineeringReadiness(row, { status: 'blocked', action: 'none', reasons: ['global-kill-active'] }));
    render(<WorkspaceEngineering {...props} />);
    await screen.findByText('Launch held');
    expect(panel().getByText(/host stop switch is active/)).toBeInTheDocument();
    expect(panel().getByText(/No worker contacted and no quota reserved/)).toBeInTheDocument();
    const run = screen.getByRole('button', { name: 'Run enrolled plan' }); expect(run).toBeDisabled();
    f.setReadiness(engineeringReadiness()); expect(run).toBeDisabled(); expect(f.posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }));
    await panel().findByText('Local checks passed'); await vi.waitFor(() => expect(run).toBeEnabled());
    expect(f.posts()).toHaveLength(0); fireEvent.click(run); await vi.waitFor(() => expect(f.posts()).toHaveLength(1));
  });

  it('keeps owned stop available when admission cannot be read', async () => {
    const f = transport(engineeringReadiness(), engineeringJob(row, { state: 'running', launched: true, cancellable: true })); f.fail();
    render(<WorkspaceEngineering {...props} />); await screen.findByText('Check unavailable');
    expect(panel().getByRole('alert')).toHaveTextContent('Recorded runs can still be stopped');
    expect(screen.getByRole('button', { name: 'Run enrolled plan' })).toBeDisabled();
    const stop = screen.getByRole('button', { name: 'Stop engineering run' }); expect(stop).toBeEnabled(); fireEvent.click(stop);
    await vi.waitFor(() => expect(f.posts()).toHaveLength(1)); expect(f.posts()[0]![0]).toBe(`/api/resources/engineering/${row.id}/cancel`);
  });

  it('rejects a mismatched admission response while preserving recorded job evidence', async () => {
    const f = transport(); f.setReadiness({ ...engineeringReadiness(), enrollmentDigest: 'e'.repeat(64) });
    render(<WorkspaceEngineering {...props} />); await screen.findByText('Check unavailable');
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run enrolled plan' })).toBeDisabled(); expect(f.posts()).toHaveLength(0);
  });

  it('does not treat launch readiness as permission to reconcile or replay', async () => {
    const f = transport(engineeringReadiness(), engineeringJob(row, { state: 'incomplete', launched: true,
      nodes: [{ id: 'deliver', kind: 'deliver', state: 'unresolved', artifactDigest: null }] }));
    render(<WorkspaceEngineering {...props} />); await screen.findByText('Local checks passed');
    const reconcile = screen.getByRole('button', { name: 'Reconcile completed work' }); expect(reconcile).toBeDisabled();
    f.setReadiness(engineeringReadiness(row, { action: 'reconcile' })); fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }));
    await panel().findByText('Reconciliation checks passed'); await vi.waitFor(() => expect(reconcile).toBeEnabled());
    expect(f.posts()).toHaveLength(0);
  });

  it('removes permission to launch on connection loss even with a previously passing sample', async () => {
    const f = transport(); const view = render(<WorkspaceEngineering {...props} />); await screen.findByText('Local checks passed');
    view.rerender(<WorkspaceEngineering {...props} available={false} />);
    expect(panel().getByText('Connection unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run enrolled plan' })).toBeDisabled(); expect(f.posts()).toHaveLength(0);
  });
});

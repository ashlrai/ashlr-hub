import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { ResourcePoolView } from './ResourcePoolView.js';
import { WorkerAccessControl, type WorkerAccessSnapshot } from './WorkerAccessControl.js';
import { resourceFixture } from './fixtures.test-support.js';

const NOW = '2026-09-08T12:00:00.000Z';
const OPEN: WorkerAccessSnapshot = { pausedWorkerIds: [], revision: 0, updatedAt: null };
const PAUSED: WorkerAccessSnapshot = { pausedWorkerIds: ['codex-a'], revision: 1, updatedAt: NOW };
const workers = resourceFixture().snapshot.pool.workers;
const checkbox = (id = 'codex-a') => screen.getByRole('checkbox', { name: `Allow ${id} for fleet work` });
const saveButton = () => screen.getByRole('button', { name: 'Save account access' });

describe('fleet account access control', () => {
  it('omits legacy snapshots with no worker access contract', () => {
    const { container } = render(<WorkerAccessControl workers={workers} policy={undefined} writable onSave={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('reflects saved personal-account pause without hiding other workers or implying task readiness', () => {
    render(<WorkerAccessControl workers={workers} policy={PAUSED} writable onSave={vi.fn()} />);
    expect(checkbox()).not.toBeChecked(); expect(checkbox('local-a')).toBeChecked();
    expect(screen.getByText('Saved: Paused for fleet')).toBeVisible();
    expect(screen.getAllByRole('checkbox')).toHaveLength(workers.length);
    expect(screen.getByText(/does not sign you out, change your usage ceiling, or hide connection and usage data/)).toBeVisible();
    expect(screen.getByText(/Running tasks are not stopped/)).toBeVisible();
    expect(saveButton()).toBeDisabled();
  });
  it('requires explicit save and retains a rejected draft and its original revision', async () => {
    const save = vi.fn().mockResolvedValue(false);
    render(<WorkerAccessControl workers={workers} policy={OPEN} writable onSave={save} />);
    fireEvent.click(checkbox('codex-alias')); fireEvent.click(checkbox());
    expect(save).not.toHaveBeenCalled(); expect(screen.getByText('Unsaved access changes')).toBeVisible();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(['codex-a', 'codex-alias'], 0));
    expect(checkbox()).not.toBeChecked(); expect(checkbox('codex-alias')).not.toBeChecked();
    expect(screen.queryByText('Saved: Paused for fleet')).not.toBeInTheDocument();
  });
  it('allows a saved paused account to be restored explicitly', async () => {
    const save = vi.fn().mockResolvedValue(false);
    render(<WorkerAccessControl workers={workers} policy={PAUSED} writable onSave={save} />);
    fireEvent.click(checkbox()); fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith([], 1));
  });
  it('keeps a draft when the policy changes until the operator takes the latest revision', () => {
    const save = vi.fn();
    const { rerender } = render(<WorkerAccessControl workers={workers} policy={OPEN} writable onSave={save} />);
    fireEvent.click(checkbox('local-a'));
    rerender(<WorkerAccessControl workers={workers} policy={PAUSED} writable onSave={save} />);
    expect(screen.getByRole('alert')).toHaveTextContent('changed while you were editing');
    expect(checkbox('local-a')).not.toBeChecked(); expect(checkbox()).toBeChecked(); expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use latest account access' }));
    expect(checkbox('local-a')).toBeChecked(); expect(checkbox()).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it('updates saved state from polling without manufacturing a draft conflict', () => {
    const { rerender } = render(<WorkerAccessControl workers={workers} policy={OPEN} writable onSave={vi.fn()} />);
    rerender(<WorkerAccessControl workers={workers} policy={PAUSED} writable onSave={vi.fn()} />);
    expect(checkbox()).not.toBeChecked(); expect(saveButton()).toBeDisabled(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each([{ disabled: true }, { busy: true }])('blocks editing and saves while unavailable %#', (props) => {
    render(<WorkerAccessControl workers={workers} policy={OPEN} writable onSave={vi.fn()} {...props} />);
    expect(checkbox()).toBeDisabled(); expect(screen.getByRole('button')).toBeDisabled();
  });
  it('shows saved access without write controls when policy authority is disabled', () => {
    render(<WorkerAccessControl workers={workers} policy={PAUSED} writable={false} onSave={vi.fn()} />);
    expect(checkbox()).toBeDisabled(); expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Account access changes are not enabled for this console.')).toBeVisible();
  });
  it('labels historical access and exposes distinct save errors', () => {
    render(<WorkerAccessControl workers={workers} policy={PAUSED} writable historical error="Account access save failed."
      onSave={vi.fn()} />);
    expect(screen.getByText(/Last reported access/)).toBeVisible();
    expect(screen.getByText('Last reported: Paused for fleet')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Account access save failed.'); expect(checkbox()).toBeDisabled();
  });
});

describe('account-access-only resource desk integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/resources/'); evictAll(); clearMutationToken();
    vi.stubGlobal('EventSource', vi.fn()); markCheckComplete(true);
  });
  afterEach(() => {
    act(() => { clearMutationToken(); markCheckComplete(false); }); vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });
  function setup() {
    const fixture = resourceFixture();
    fixture.scope.readOnly = true; fixture.scope.allocationWritable = true; fixture.scope.workspace = null;
    fixture.snapshot.supervisor = null; fixture.snapshot.workerAccess = OPEN;
    fixture.snapshot.allocation = { ceilingPercent: 75, revision: 3, updatedAt: NOW };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/resources' && init?.method === 'GET') return new Response(JSON.stringify(fixture.snapshot));
      if (path === '/api/resources/worker-access' && init?.method === 'POST') {
        const input = JSON.parse(init.body as string);
        fixture.snapshot.workerAccess = { pausedWorkerIds: input.pausedWorkerIds, revision: input.expectedRevision + 1, updatedAt: NOW };
        return new Response(JSON.stringify({ workerAccess: fixture.snapshot.workerAccess }));
      }
      throw new Error('Unexpected fixture request');
    });
    vi.stubGlobal('fetch', request);
    return { ...fixture, request };
  }
  it('pauses account admission through the separate authenticated policy route without task authority', async () => {
    const f = setup(); setMutationToken('a'.repeat(64)); render(<ResourcePoolView scope={f.scope} />);
    const panel = await screen.findByRole('region', { name: 'Fleet account access' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Allow codex-a for fleet work' }));
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    fireEvent.click(saveButton());
    await screen.findByText('Saved: Paused for fleet');
    const posts = f.request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1); expect(posts[0]![0]).toBe('/api/resources/worker-access');
    expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ pausedWorkerIds: ['codex-a'], expectedRevision: 0 });
    expect(posts[0]![1]!.headers).toMatchObject({ 'x-ashlr-token': 'a'.repeat(64) });
    expect(screen.getByText('Saved ceiling: 75%')).toBeVisible(); expect(screen.getByText('Observation only')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Inspect map worker codex-a' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume queue' })).not.toBeInTheDocument();
  });
  it('opens the existing token dialog without writing or dropping the draft', async () => {
    const f = setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('region', { name: 'Fleet account access' }); fireEvent.click(checkbox()); fireEvent.click(saveButton());
    expect(await screen.findByRole('dialog')).toHaveTextContent('allocation and fleet account access changes only. Task execution remains disabled');
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(checkbox()).not.toBeChecked();
  });
  it('refreshes a conflicting policy without silently resubmitting the draft', async () => {
    const f = setup(); setMutationToken('a'.repeat(64));
    f.request.mockImplementation(async (path, init) => {
      if (path === '/api/resources/worker-access') {
        f.snapshot.workerAccess = { pausedWorkerIds: ['local-a'], revision: 1, updatedAt: NOW };
        return new Response(JSON.stringify({ error: 'PRIVATE_SERVER_DETAIL' }), { status: 409 });
      }
      if (init?.method === 'GET') return new Response(JSON.stringify(f.snapshot));
      throw new Error('Unexpected fixture request');
    });
    const { container } = render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('region', { name: 'Fleet account access' }); fireEvent.click(checkbox()); fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Use latest account access' });
    expect(checkbox()).not.toBeChecked(); expect(checkbox('local-a')).toBeChecked(); expect(saveButton()).toBeDisabled();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(container.innerHTML).not.toContain('PRIVATE_SERVER_DETAIL'); expect(screen.getByText('Saved ceiling: 75%')).toBeVisible();
  });
  it('retains the draft but blocks policy writes when the current snapshot fails', async () => {
    const f = setup(); setMutationToken('a'.repeat(64)); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('region', { name: 'Fleet account access' }); fireEvent.click(checkbox());
    f.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('A fresh, valid pool snapshot is required before account access changes.');
    expect(checkbox()).not.toBeChecked(); expect(checkbox()).toBeDisabled(); expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/Last reported access/)).toBeVisible();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
});

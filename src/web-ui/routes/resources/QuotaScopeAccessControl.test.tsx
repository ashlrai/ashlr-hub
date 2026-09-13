import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { ResourcePoolView } from './ResourcePoolView.js';
import { QuotaScopeAccessControl, type QuotaScopeAccessSnapshot } from './QuotaScopeAccessControl.js';
import { resourceFixture } from './fixtures.test-support.js';

const NOW = '2026-09-08T12:00:00.000Z';
const OPEN: QuotaScopeAccessSnapshot = { exclusions: [], revision: 0, updatedAt: null };
const GENERAL = { capacityKey: 'codex-account', quotaScope: 'codex-general-v1' } as const;
const RESERVED: QuotaScopeAccessSnapshot = { exclusions: [GENERAL], revision: 1, updatedAt: NOW };
const ACCOUNT = { pausedWorkerIds: ['codex-a'], revision: 3, updatedAt: NOW };
function fixture() {
  const f = resourceFixture();
  Object.assign(f.snapshot.pool.workers[0]!, { quotaScope: 'codex-general-v1', model: 'gpt-6-astra' });
  Object.assign(f.snapshot.pool.workers[1]!, { quotaScope: 'codex-spark-v1', model: 'gpt-5.3-codex-spark' });
  f.snapshot.quotaScopeAccess = structuredClone(OPEN); f.snapshot.workerAccess = structuredClone(ACCOUNT);
  return f;
}
const checkbox = (scope = 'General') => screen.getByRole('checkbox', { name: `Reserve ${scope} on codex-account for your work` });
const saveButton = () => screen.getByRole('button', { name: 'Save quota reservations' });

describe('quota scope reservations', () => {
  it('omits legacy policy and never derives quota pins from model names', () => {
    const f = fixture(); const save = vi.fn();
    const { rerender, container } = render(<QuotaScopeAccessControl workers={f.snapshot.pool.workers} policy={undefined}
      accountPolicy={ACCOUNT} writable onSave={save} />);
    expect(container).toBeEmptyDOMElement();
    const unpinned = f.snapshot.pool.workers.map(({ quotaScope: _scope, ...worker }) => worker);
    rerender(<QuotaScopeAccessControl workers={unpinned} policy={OPEN} accountPolicy={ACCOUNT} writable onSave={save} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/No General or Spark quota scopes are explicitly enrolled/)).toBeVisible();
  });
  it('groups aliases by exact scope and separates saved reservations from effective account pause', () => {
    const f = fixture(); const workers = [...f.snapshot.pool.workers, { ...f.snapshot.pool.workers[0]!, id: 'general-alias' }];
    render(<QuotaScopeAccessControl workers={workers} policy={RESERVED} accountPolicy={ACCOUNT} writable onSave={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2); expect(checkbox()).toBeChecked(); expect(checkbox('Spark')).not.toBeChecked();
    expect(screen.getByText('Saved: Reserved for your work')).toBeVisible();
    expect(screen.getByText('Saved: Not reserved by this setting')).toBeVisible();
    expect(screen.getAllByText('Whole-account pause still blocks this scope')).toHaveLength(2);
    expect(screen.getByText(/Save the General reservation first/)).toBeVisible();
    expect(screen.getByText(/Unmapped models on a reserved account remain blocked/)).toBeVisible();
  });
  it('saves only the selected scope at its independent revision and preserves rejected draft', async () => {
    const f = fixture(); const save = vi.fn().mockResolvedValue(false);
    render(<QuotaScopeAccessControl workers={f.snapshot.pool.workers} policy={OPEN} accountPolicy={ACCOUNT} writable onSave={save} />);
    fireEvent.click(checkbox()); expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved: Reserved for your work')).not.toBeInTheDocument();
    fireEvent.click(saveButton()); await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith([GENERAL], 0));
    expect(checkbox()).toBeChecked(); expect(ACCOUNT.pausedWorkerIds).toEqual(['codex-a']); expect(OPEN.exclusions).toEqual([]);
  });
  it('requires explicit save to release a reservation', async () => {
    const save = vi.fn().mockResolvedValue(false);
    render(<QuotaScopeAccessControl workers={fixture().snapshot.pool.workers} policy={RESERVED} accountPolicy={ACCOUNT} writable onSave={save} />);
    fireEvent.click(checkbox()); fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith([], 1));
  });
  it('holds conflicting drafts until latest policy is explicitly selected', () => {
    const props = { workers: fixture().snapshot.pool.workers, accountPolicy: ACCOUNT, writable: true, onSave: vi.fn() };
    const { rerender } = render(<QuotaScopeAccessControl {...props} policy={OPEN} />);
    fireEvent.click(checkbox('Spark')); rerender(<QuotaScopeAccessControl {...props} policy={RESERVED} />);
    expect(screen.getByRole('alert')).toHaveTextContent('changed while you were editing'); expect(saveButton()).toBeDisabled();
    expect(checkbox('Spark')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Use latest quota reservations' }));
    expect(checkbox()).toBeChecked(); expect(checkbox('Spark')).not.toBeChecked(); expect(props.onSave).not.toHaveBeenCalled();
  });
  it.each([{ disabled: true }, { historical: true }, { busy: true }, { writable: false }])('refuses unavailable editing %#', (options) => {
    render(<QuotaScopeAccessControl workers={fixture().snapshot.pool.workers} policy={RESERVED} accountPolicy={ACCOUNT}
      writable onSave={vi.fn()} {...options} />);
    expect(checkbox()).toBeDisabled();
    if (options.writable !== false) expect(screen.getByRole('button')).toBeDisabled();
    else expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('quota reservation desk integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/resources/'); evictAll(); clearMutationToken();
    vi.stubGlobal('EventSource', vi.fn()); markCheckComplete(true);
  });
  afterEach(() => {
    act(() => { clearMutationToken(); markCheckComplete(false); }); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/');
  });
  function setup() {
    const f = fixture(); f.scope.readOnly = true; f.scope.allocationWritable = true; f.scope.workspace = null;
    f.snapshot.supervisor = null; f.snapshot.allocation = { ceilingPercent: 75, revision: 4, updatedAt: NOW };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/resources' && init?.method === 'GET') return new Response(JSON.stringify(f.snapshot));
      if (path === '/api/resources/quota-scope-access' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        f.snapshot.quotaScopeAccess = { exclusions: body.exclusions, revision: body.expectedRevision + 1, updatedAt: NOW };
        return new Response(JSON.stringify({ quotaScopeAccess: f.snapshot.quotaScopeAccess }));
      }
      if (path === '/api/resources/worker-access' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        f.snapshot.workerAccess = { pausedWorkerIds: body.pausedWorkerIds, revision: body.expectedRevision + 1, updatedAt: NOW };
        return new Response(JSON.stringify({ workerAccess: f.snapshot.workerAccess }));
      }
      throw new Error('Unexpected fixture request');
    });
    vi.stubGlobal('fetch', request); return { ...f, request };
  }
  it('saves General only without account, allocation or task writes', async () => {
    const f = setup(); setMutationToken('a'.repeat(64)); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('region', { name: 'Quota reservations' }); fireEvent.click(checkbox()); fireEvent.click(saveButton());
    await screen.findByText('Saved: Reserved for your work');
    const posts = f.request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1); expect(posts[0]![0]).toBe('/api/resources/quota-scope-access');
    expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ exclusions: [GENERAL], expectedRevision: 0 });
    expect(posts[0]![1]!.headers).toMatchObject({ 'x-ashlr-token': 'a'.repeat(64) });
    expect(f.snapshot.workerAccess).toEqual(ACCOUNT); expect(f.snapshot.allocation?.ceilingPercent).toBe(75);
    expect(screen.getAllByText('Whole-account pause still blocks this scope')).toHaveLength(2);
  });
  it('unlocks through the existing dialog without losing the draft or writing', async () => {
    const f = setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('region', { name: 'Quota reservations' }); fireEvent.click(checkbox()); fireEvent.click(saveButton());
    expect(await screen.findByRole('dialog')).toHaveTextContent('quota reservations, without clearing account pauses');
    expect(checkbox()).toBeChecked(); expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('keeps General reserved when the operator separately releases the shared-account pause', async () => {
    const f = setup(); setMutationToken('a'.repeat(64)); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('region', { name: 'Quota reservations' }); fireEvent.click(checkbox()); fireEvent.click(saveButton());
    await screen.findByText('Saved: Reserved for your work');
    expect(f.snapshot.workerAccess).toEqual(ACCOUNT);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow codex-a for fleet work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save account access' }));
    await waitFor(() => expect(screen.queryByText('Whole-account pause still blocks this scope')).not.toBeInTheDocument());
    expect(checkbox()).toBeChecked(); expect(checkbox('Spark')).not.toBeChecked();
    expect(f.snapshot.quotaScopeAccess).toEqual(RESERVED);
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path, init]) => [path, JSON.parse(init!.body as string)]))
      .toEqual([['/api/resources/quota-scope-access', { exclusions: [GENERAL], expectedRevision: 0 }],
        ['/api/resources/worker-access', { pausedWorkerIds: [], expectedRevision: 3 }]]);
  });
  it('holds reservation changes on stale evidence without discarding the last saved state', async () => {
    const f = setup(); setMutationToken('a'.repeat(64)); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('region', { name: 'Quota reservations' });
    f.request.mockRejectedValue(new Error('PRIVATE_OFFLINE_DETAIL'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText(/Last reported reservations/);
    expect(checkbox()).toBeDisabled(); expect(saveButton()).toBeDisabled();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('refreshes a CAS conflict without replaying or displaying private server details', async () => {
    const f = setup(); setMutationToken('a'.repeat(64));
    f.request.mockImplementation(async (path, init) => {
      if (path === '/api/resources/quota-scope-access') {
        f.snapshot.quotaScopeAccess = { exclusions: [], revision: 1, updatedAt: NOW };
        return new Response(JSON.stringify({ error: 'PRIVATE_SERVER_DETAIL' }), { status: 409 });
      }
      if (init?.method === 'GET') return new Response(JSON.stringify(f.snapshot));
      throw new Error('Unexpected fixture request');
    });
    const { container } = render(<ResourcePoolView scope={f.scope} />);
    const panel = await screen.findByRole('region', { name: 'Quota reservations' }); fireEvent.click(checkbox()); fireEvent.click(saveButton());
    await screen.findByRole('button', { name: 'Use latest quota reservations' });
    expect(within(panel).getByRole('checkbox', { name: /Reserve General/ })).toBeChecked(); expect(saveButton()).toBeDisabled();
    expect(container).not.toHaveTextContent('PRIVATE_SERVER_DETAIL');
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});

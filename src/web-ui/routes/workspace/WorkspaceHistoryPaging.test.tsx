import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { ResourcePoolView } from '../resources/ResourcePoolView.js';
import { evictAll, runQuery } from '../../data/cache.js';
import { resourceConsoleSnapshotQuery } from '../../data/resource-pool-queries.js';

const json = (value: unknown) => new Response(JSON.stringify(value));
function fixture() {
  const f = resourceFixture(); f.scope.historySupported = true;
  f.snapshot.supervisor!.jobWindow = { totalJobs: 300, visibleJobs: 3, omittedJobs: 297 };
  const job = { ...f.snapshot.supervisor!.jobs.find(row => row.id === 'done-task')!, id: 'archive-task',
    enqueuedAt: '2026-09-06T12:00:00.000Z', historyAvailable: true as const, outputAvailable: false };
  const props: WorkspaceViewProps = { ...f, historical: false, enabled: true, stopEnabled: true, busy: false, unlocked: true,
    onUnlock: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onDeleteHistory: vi.fn() };
  let detailFails = false;
  const request = vi.fn(async (path: string) => {
    if (path === '/api/resources') return json(f.snapshot);
    if (path.startsWith('/api/resources/tasks?')) return json({ items: [job], totalJobs: 300, nextBefore: null });
    if (path === '/api/resources/tasks/archive-task/history') return json({ id: job.id, prompt: 'Retained private prompt',
      output: { text: 'Retained private response', truncated: false }, retention: 'local-until-deleted' });
    if (path === '/api/resources/tasks/archive-task') {
      if (detailFails) return new Response('PRIVATE ERROR', { status: 503 });
      const { jobs: _jobs, ...supervisor } = f.snapshot.supervisor!;
      return json({ supervisor, job });
    }
    throw new Error(`Unexpected fixture request ${path}`);
  });
  vi.stubGlobal('fetch', request);
  return { ...f, props, job, request, failDetail: () => { detailFails = true; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); evictAll(); window.history.replaceState(null, '', '/'); });
describe('bounded history browsing', () => {
  it('loads an older job and preserves its selected transcript through refresh and latest-window navigation', async () => {
    const f = fixture(); const view = render(<WorkspaceView {...f.props} />);
    expect(screen.getByText(/297 older tasks omitted/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    fireEvent.click(await screen.findByRole('button', { name: /archive-task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
    expect(await screen.findByText('Retained private response')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Latest tasks' }));
    view.rerender(<WorkspaceView {...f.props} snapshot={structuredClone(f.snapshot)} />);
    expect(screen.getByText('Retained private response')).toBeVisible();
    expect(screen.getByRole('button', { name: /archive-task/ })).toHaveAttribute('aria-current', 'true');
    await act(async () => {});
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/history'))).toHaveLength(1);
  });
  it('first browse skips visible terminal work without using the older active-task boundary', async () => {
    const f = fixture();
    f.snapshot.supervisor!.jobs.find(row => row.id === 'owned-task')!.enqueuedAt = '2026-08-01T00:00:00.000Z';
    const terminal = f.snapshot.supervisor!.jobs.find(row => row.id === 'done-task')!;
    render(<WorkspaceView {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    expect(await screen.findByRole('button', { name: /archive-task/ })).toBeVisible();
    const pages = f.request.mock.calls.filter(([path]) => path.startsWith('/api/resources/tasks?'));
    expect(pages).toHaveLength(1);
    const params = new URL(pages[0]![0], 'http://localhost').searchParams;
    expect(params.get('before')).toBe(terminal.enqueuedAt); expect(params.get('beforeId')).toBe(terminal.id);
    expect(screen.getByRole('button', { name: /owned-task/ })).toBeVisible();
  });
  it('starts from newest when the live window contains no terminal task', async () => {
    const f = fixture(); f.snapshot.supervisor!.jobs = f.snapshot.supervisor!.jobs.filter(row => row.state !== 'settled');
    f.snapshot.supervisor!.jobWindow = { totalJobs: 300, visibleJobs: 2, omittedJobs: 298 };
    render(<WorkspaceView {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    expect(await screen.findByRole('button', { name: /archive-task/ })).toBeVisible();
    const path = f.request.mock.calls.find(([value]) => value.startsWith('/api/resources/tasks?'))![0];
    expect(new URL(path, 'http://localhost').searchParams.has('before')).toBe(false);
  });
  it('preserves selection on detail failure, discloses stale metadata and pauses deletion', async () => {
    const f = fixture(); const view = render(<WorkspaceView {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    fireEvent.click(await screen.findByRole('button', { name: /archive-task/ }));
    await act(async () => {}); f.failDetail();
    view.rerender(<WorkspaceView {...f.props} snapshot={structuredClone(f.snapshot)} />);
    expect(await screen.findByText(/Selected task metadata could not be refreshed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete transcript' })).toBeDisabled();
    expect(screen.queryByText('PRIVATE ERROR')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /archive-task/ })).toHaveAttribute('aria-current', 'true');
  });
  it('does not read while hidden and discards prior-session archived rows', async () => {
    const f = fixture(); const view = render(<WorkspaceView {...f.props} surfaceActive={false} />);
    expect(screen.getByRole('button', { name: 'Browse task history' })).toBeDisabled(); expect(f.request).not.toHaveBeenCalled();
    view.rerender(<WorkspaceView {...f.props} />); fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    await screen.findByRole('button', { name: /archive-task/ });
    const next = structuredClone(f.snapshot); next.supervisor!.instanceId = 'new-session';
    view.rerender(<WorkspaceView {...f.props} snapshot={next} />);
    expect(screen.queryByRole('button', { name: /archive-task/ })).not.toBeInTheDocument();
  });
  it('does not resurrect a stale nonterminal assignment from a history page', async () => {
    const f = fixture(); Object.assign(f.job, { state: 'dispatching', outcome: null, cancellable: true });
    render(<WorkspaceView {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    await screen.findByRole('button', { name: 'Latest tasks' });
    expect(screen.queryByRole('button', { name: /archive-task/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /owned-task/ })).toBeVisible();
  });
  it('retains an archived Fleet selection across a fresh bounded snapshot', async () => {
    const f = fixture(); render(<ResourcePoolView scope={f.scope} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse task history' }));
    fireEvent.click(await screen.findByRole('button', { name: /archive-task/ }));
    expect(await screen.findByRole('region', { name: 'Task archive-task' })).toBeVisible();
    const definition = resourceConsoleSnapshotQuery(f.scope.poolId);
    await act(async () => { await runQuery(definition.key, definition.fetch); });
    expect(within(screen.getByRole('region', { name: 'Task archive-task' })).getByRole('heading', { name: 'archive-task' })).toBeVisible();
  });
  it('advances the exact older cursor while retaining the selected task outside the new page', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    const nextJob = { ...f.job, id: 'earlier-task', enqueuedAt: '2026-09-05T12:00:00.000Z' };
    f.request.mockImplementation(async path => {
      if (path.startsWith('/api/resources/tasks?')) return new URL(path, 'http://localhost').searchParams.get('beforeId') === f.job.id
        ? json({ items: [nextJob], totalJobs: 300, nextBefore: null })
        : json({ items: [f.job], totalJobs: 300, nextBefore: { id: f.job.id, enqueuedAt: f.job.enqueuedAt } });
      return original(path);
    });
    render(<WorkspaceView {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    fireEvent.click(await screen.findByRole('button', { name: /archive-task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
    await screen.findByText('Retained private response');
    fireEvent.click(screen.getByRole('button', { name: 'Older tasks' }));
    expect(await screen.findByRole('button', { name: /earlier-task/ })).toBeVisible();
    expect(screen.getByText('Retained private response')).toBeVisible();
    expect(screen.getByRole('button', { name: /archive-task/ })).toHaveAttribute('aria-current', 'true');
    const path = f.request.mock.calls.map(([value]) => value).filter(value => value.startsWith('/api/resources/tasks?')).at(-1)!;
    const params = new URL(path, 'http://localhost').searchParams;
    expect(params.get('before')).toBe(f.job.enqueuedAt); expect(params.get('beforeId')).toBe(f.job.id);
    expect(screen.getByRole('button', { name: 'Older tasks' })).toBeDisabled();
  });
  it('clears selected private text when fresh archived metadata reports deletion', async () => {
    const f = fixture(); const view = render(<WorkspaceView {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    fireEvent.click(await screen.findByRole('button', { name: /archive-task/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
    await screen.findByText('Retained private response');
    Reflect.deleteProperty(f.job, 'historyAvailable');
    await act(async () => { view.rerender(<WorkspaceView {...f.props} snapshot={structuredClone(f.snapshot)} />); });
    expect(screen.queryByText('Retained private response')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read transcript' })).not.toBeInTheDocument();
  });
  it('aborts selected metadata reads on project change and ignores the late response', async () => {
    const f = fixture(); f.scope.projects = [
      { id: 'default', label: 'Default workspace', workspace: f.scope.workspace!, enabled: true },
      { id: 'other', label: 'Other project', workspace: '/private/other', enabled: true },
    ]; f.scope.defaultProjectId = 'default';
    const original = f.request.getMockImplementation()!;
    let finish!: (response: Response) => void; let signal: AbortSignal | undefined;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    let first = true;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/resources/tasks/archive-task' && first) { first = false; signal = init?.signal as AbortSignal; return pending; }
      return original(path);
    });
    vi.stubGlobal('fetch', request); render(<WorkspaceView {...f.props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse task history' }));
    fireEvent.click(await screen.findByRole('button', { name: /archive-task/ }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Other project' }));
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish(json({ supervisor: { instanceId: 'wrong-session' }, job: { ...f.job, projectId: 'other' } })); await pending; });
    expect(screen.queryByRole('button', { name: /archive-task/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Selected task metadata could not be refreshed/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to project' }));
    expect(await screen.findByRole('button', { name: /archive-task/ })).toHaveAttribute('aria-current', 'true');
  });
});

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import { clearMutationToken, markCheckComplete } from '../../data/auth-store.js';
import { evictAll, runQuery } from '../../data/cache.js';
import { resourceConsoleSnapshotQuery } from '../../data/resource-pool-queries.js';
import { ResourcePoolView } from '../resources/ResourcePoolView.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const json = (value: unknown) => new Response(JSON.stringify(value));
function selectWorkspaceTask(id: string) {
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Project and tasks' }))
    .getByRole('button', { name: new RegExp(id) }));
}
beforeEach(() => {
  window.history.replaceState(null, '', '/resources/');
  evictAll(); clearMutationToken(); markCheckComplete(true);
});
afterEach(() => {
  act(() => { clearMutationToken(); markCheckComplete(false); });
  evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/');
});

describe('independent retained transcript UI acceptance', () => {
  it('purges the submitted prompt after successful deletion even when another task was selected meanwhile', async () => {
    const f = resourceFixture(); f.scope.historySupported = true;
    const deletion = deferred<boolean>(); const onSubmit = vi.fn(async (_input: ResourceConsoleTaskInput) => true);
    const input: WorkspaceViewProps = { ...f, historical: false, enabled: true, stopEnabled: true,
      busy: false, unlocked: true, onUnlock: vi.fn(), onCancel: vi.fn(), onSubmit,
      onDeleteHistory: vi.fn(() => deletion.promise) };
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const view = render(<WorkspaceView {...input} />);
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'PRIVATE PROMPT TO DELETE' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Task worker' }), { target: { value: 'local-a' } });
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' })); });
    const sent = onSubmit.mock.calls[0]![0];
    const template = f.snapshot.supervisor!.jobs.find((job) => job.id === 'done-task')!;
    const snapshot = { ...f.snapshot, supervisor: { ...f.snapshot.supervisor!, jobs: [
      ...f.snapshot.supervisor!.jobs, { ...template, id: sent.id, historyAvailable: true as const },
    ] } };
    view.rerender(<WorkspaceView {...input} snapshot={snapshot} />);
    expect(screen.getByText('PRIVATE PROMPT TO DELETE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete transcript' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete transcript' }));
    expect(input.onDeleteHistory).toHaveBeenCalledExactlyOnceWith(sent.id);
    selectWorkspaceTask('owned-task');
    await act(async () => { deletion.resolve(true); await deletion.promise; });
    selectWorkspaceTask(sent.id);
    expect(screen.queryByText('PRIVATE PROMPT TO DELETE')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your task' })).not.toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled();
  });

  it.each(['loaded', 'in-flight'] as const)('removes %s legacy inspector output when retained-history metadata disappears', async (phase) => {
    const f = resourceFixture(); f.scope.historySupported = true;
    const job = f.snapshot.supervisor!.jobs.find((row) => row.id === 'done-task')!; job.historyAvailable = true;
    const output = deferred<Response>();
    const request = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
      if (path === '/api/resources' && init?.method === 'GET') return json(f.snapshot);
      if (path === '/api/resources/tasks/done-task/output') return output.promise;
      throw new Error(`Unexpected history acceptance request ${path}`);
    });
    vi.stubGlobal('fetch', request);
    render(<ResourcePoolView scope={f.scope} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect map task done-task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read task output' }));
    const response = () => json({ id: 'done-task', text: 'PRIVATE LEGACY RESPONSE', truncated: false,
      retention: 'this-console-session' });
    if (phase === 'loaded') {
      await act(async () => { output.resolve(response()); await output.promise; });
      expect(await screen.findByText('PRIVATE LEGACY RESPONSE')).toBeInTheDocument();
    }
    // Even a partially refreshed projection must invalidate old retained text.
    // Leave outputAvailable true to test history identity independently.
    delete job.historyAvailable;
    const query = resourceConsoleSnapshotQuery(f.scope.poolId);
    await act(async () => { await runQuery(query.key, query.fetch); });
    if (phase === 'in-flight') {
      await act(async () => { output.resolve(response()); await output.promise; });
    }
    expect(screen.queryByText('PRIVATE LEGACY RESPONSE')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Loading output…' })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/output'))).toHaveLength(1);
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it.each(['loaded', 'in-flight'] as const)('removes %s workspace output when retained-history metadata disappears', async (phase) => {
    const f = resourceFixture(); f.scope.historySupported = true;
    f.snapshot.supervisor!.jobs.find((row) => row.id === 'done-task')!.historyAvailable = true;
    const input: WorkspaceViewProps = { ...f, historical: false, enabled: true, stopEnabled: true,
      busy: false, unlocked: true, onUnlock: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(async () => true) };
    const output = deferred<Response>(); const request = vi.fn(() => output.promise); vi.stubGlobal('fetch', request);
    const view = render(<WorkspaceView {...input} />); selectWorkspaceTask('done-task');
    fireEvent.click(screen.getByRole('button', { name: 'Read response' }));
    const response = () => json({ id: 'done-task', text: 'PRIVATE WORKSPACE RESPONSE', truncated: false,
      retention: 'this-console-session' });
    if (phase === 'loaded') {
      await act(async () => { output.resolve(response()); await output.promise; });
      expect(await screen.findByText('PRIVATE WORKSPACE RESPONSE')).toBeInTheDocument();
    }
    const snapshot = structuredClone(f.snapshot);
    delete snapshot.supervisor!.jobs.find((row) => row.id === 'done-task')!.historyAvailable;
    view.rerender(<WorkspaceView {...input} snapshot={snapshot} />);
    if (phase === 'in-flight') await act(async () => { output.resolve(response()); await output.promise; });
    expect(screen.queryByText('PRIVATE WORKSPACE RESPONSE')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reading response…' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce(); expect(input.onSubmit).not.toHaveBeenCalled();
  });
});

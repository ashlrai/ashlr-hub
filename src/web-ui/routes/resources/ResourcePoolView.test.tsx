import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { resourceFixture } from './fixtures.test-support.js';
import { ResourcePoolView } from './ResourcePoolView.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  window.history.replaceState(null, '', '/resources/'); evictAll(); clearMutationToken();
  vi.stubGlobal('EventSource', vi.fn()); markCheckComplete(true);
});
afterEach(() => {
  act(() => { clearMutationToken(); markCheckComplete(false); }); vi.useRealTimers(); vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function setup() {
  const { scope, snapshot } = resourceFixture();
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/resources' && init?.method === 'GET') return json(snapshot);
    if (path === '/api/resources/tasks' && init?.method === 'POST') {
      const task = JSON.parse(init.body as string); const job = { ...snapshot.supervisor!.jobs[0]!, id: task.id, allowedWorkerIds: task.allowedWorkerIds };
      snapshot.supervisor!.jobs.push(job); snapshot.supervisor!.queuedCount += 1; return json({ job });
    }
    if (path === '/api/resources/queue') { snapshot.supervisor!.paused = JSON.parse(init!.body as string).paused; return json({ supervisor: snapshot.supervisor }); }
    if (path.endsWith('/cancel')) return json({ job: snapshot.supervisor!.jobs[0] });
    if (path.endsWith('/output')) return json({ id: 'done-task', text: '<script>not executable</script>\nfixture output', truncated: true, retention: 'this-console-session' });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', request);
  return { scope, snapshot, request };
}

describe('resource dispatch desk', () => {
  it('opens focused inspection from the map and preserves an unsent draft', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await user.type(await screen.findByLabelText('What should this task do?'), 'Preserve this design investigation.');
    await user.click(screen.getByRole('button', { name: 'Inspect map worker local-a' }));
    expect(within(screen.getByRole('region', { name: 'Worker local-a' })).getByRole('heading', { name: 'local-a' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back to fleet map' }));
    expect(screen.getByRole('heading', { name: 'Fleet map' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Compose task' }));
    expect(screen.getByLabelText('What should this task do?')).toHaveValue('Preserve this design investigation.');
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('explains a blocked queued task without inventing a worker assignment', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await user.click(await screen.findByRole('button', { name: 'Inspect map task queued-task' }));
    const inspector = within(screen.getByRole('region', { name: 'Task queued-task' }));
    expect(inspector.getByRole('heading', { name: 'queued-task' })).toHaveFocus();
    expect(inspector.getByText('No confirmed assignment')).toBeInTheDocument();
    expect(inspector.getByText(/no eligible allowed workers; Quota reserve reached/i)).toBeInTheDocument();
    expect(inspector.getByRole('button', { name: 'Cancel queued task' })).toBeInTheDocument();
  });

  it.each(['pending', 'conflict'] as const)('keeps map, activity and inspector consistent when assignment is %s', async (kind) => {
    const f = setup(); const job = f.snapshot.supervisor!.jobs.find((row) => row.id === 'owned-task')!;
    job.workerId = kind === 'pending' ? null : 'codex-a';
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    const node = await screen.findByRole('button', { name: 'Inspect map task owned-task' });
    expect(within(screen.getByRole('region', { name: 'Unassigned or unresolved placement' })).getByRole('button', { name: 'Inspect map task owned-task' })).toBe(node);
    const strip = screen.getByRole('button', { name: 'Inspect owned dispatch owned-task' });
    expect(strip).toHaveTextContent(kind === 'pending' ? 'Assignment pending' : 'Assignment evidence conflicts');
    await user.click(node);
    const inspector = within(screen.getByRole('region', { name: 'Task owned-task' }));
    expect(inspector.getByText('No confirmed assignment')).toBeInTheDocument();
    expect(inspector.getByText('Supervisor worker record')).toBeInTheDocument();
    expect(inspector.getByText('Receipt worker record')).toBeInTheDocument();
    expect(inspector.getByRole('button', { name: 'Cancel owned task' })).toBeInTheDocument();
  });

  it.each(['supervisor', 'receipt'] as const)('preserves visible occupancy when the %s settles before the other sample', async (settledSource) => {
    const f = setup(); const job = f.snapshot.supervisor!.jobs.find((row) => row.id === 'owned-task')!;
    const receipt = f.snapshot.activeAttempts.find((row) => row.id === 'owned-task')!;
    if (settledSource === 'supervisor') { job.state = 'settled'; job.outcome = 'completed'; job.cancellable = false; }
    else { receipt.status = 'completed'; receipt.finishedAt = f.snapshot.sampledAt; }
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await user.selectOptions(await screen.findByLabelText('Task activity filter'), 'active');
    expect(screen.getByRole('button', { name: /^owned-task/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Inspect map task owned-task' }));
    const inspector = within(screen.getByRole('region', { name: 'Task owned-task' }));
    expect(inspector.getByText(/Supervisor and receipt states differ in this snapshot/)).toBeInTheDocument();
    expect(inspector.getByText('Receipt state').nextElementSibling).toHaveTextContent(receipt.status);
  });

  it('groups aliases, explains preview and reports real ownership/coverage without fabricated acceptance', async () => {
    const f = setup(); render(<ResourcePoolView scope={f.scope} />);
    const group = await screen.findByRole('region', { name: 'Capacity group codex-account' });
    expect(within(group).getByRole('button', { name: /codex-a configured|codex-a Not eligible/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /codex-alias/ })).toBeInTheDocument();
    expect(screen.getByText('All-enrolled preview, not a reserved assignment')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^owned-task/ })).getByText('Console-owned dispatch')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^external-task/ })).getByText('Unresolved external reservation')).toBeInTheDocument();
    expect(screen.getByText(/Reported subtotal, not total consumption/)).toBeInTheDocument();
    expect(screen.getByText(/Completed tasks are not verified accepted changes/)).toBeInTheDocument();
    expect(EventSource).not.toHaveBeenCalled();
  });

  it('shows every quota window, legitimate zero, unknown and oldest versus latest capture', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: /^codex-a Not eligible/ }));
    const inspector = screen.getByRole('region', { name: 'Worker codex-a' });
    expect(within(inspector).getByText('0% reported used')).toBeInTheDocument();
    expect(within(inspector).getByText('92% reported used')).toBeInTheDocument();
    expect(within(inspector).getByLabelText('Utilization unknown')).toBeInTheDocument();
    expect(within(inspector).getByText('Oldest retained capture')).toBeInTheDocument();
    expect(within(inspector).getByText('Latest partial capture')).toBeInTheDocument();
    expect(within(inspector).getByRole('list', { name: 'codex-a quota windows' }).children).toHaveLength(3);
  });

  it('marks stale evidence and unknown-quota operator routing without drawing unknown as zero', async () => {
    const f = setup(); f.snapshot.observations[0]!.expiresAt = '2026-09-07T11:59:59.000Z';
    f.snapshot.plan!.candidates.push({ ...f.snapshot.plan!.candidates[0]!, workerId: 'codex-a', provider: 'codex', reason: 'operator-capped-unknown-quota' });
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: /^codex-a Eligible/ }));
    expect(screen.getByText('Stale observation')).toBeInTheDocument();
    expect(screen.getByText('Eligible under operator caps only. Provider quota is unknown.')).toBeInTheDocument();
  });

  it('requires a separate control token, never auto-submits on unlock, then queues exact task fields', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: 'Unlock controls' }));
    await user.type(screen.getByLabelText('Control token'), 'd'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    await user.clear(screen.getByLabelText('Task ID')); await user.type(screen.getByLabelText('Task ID'), 'build-helper');
    await user.type(screen.getByLabelText('What should this task do?'), 'Inspect the parser and propose a bounded fix.');
    await user.click(screen.getByLabelText('codex-alias')); await user.click(screen.getByLabelText('codex-a'));
    await user.selectOptions(screen.getByLabelText('Workspace access'), 'workspace-write');
    await user.click(screen.getByRole('button', { name: 'Queue task' }));
    await screen.findByRole('status');
    const sent = f.request.mock.calls.find(([path]) => path === '/api/resources/tasks');
    expect(sent?.[1]?.headers).toMatchObject({ 'x-ashlr-token': 'd'.repeat(64) });
    expect(JSON.parse(sent![1]!.body as string)).toEqual({ id: 'build-helper', prompt: 'Inspect the parser and propose a bounded fix.',
      allowedWorkerIds: ['local-a'], mode: 'workspace-write', timeoutMs: 300_000, maxOutputTokens: 4096 });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'build-helper' })).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Inspect selection' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('What should this task do?')).toHaveValue('');
    expect(Object.values(sessionStorage)).not.toContain('d'.repeat(64)); expect(Object.values(localStorage)).not.toContain('d'.repeat(64));
  });

  it('pauses/resumes the queue and cancels only a supervisor-owned or queued task', async () => {
    const f = setup(); setMutationToken('d'.repeat(64)); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: 'Pause queue' }));
    await screen.findByRole('button', { name: 'Resume queue' });
    await user.click(screen.getByRole('button', { name: 'Resume queue' }));
    await screen.findByRole('button', { name: 'Pause queue' });
    await user.click(screen.getByRole('button', { name: /^owned-task/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel owned task' }));
    await waitFor(() => expect(f.request.mock.calls.some(([path]) => path === '/api/resources/tasks/owned-task/cancel')).toBe(true));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'owned-task' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: /^external-task/ }));
    expect(screen.queryByRole('button', { name: /Cancel .*task/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Task external-task' })).getByText(/not a process heartbeat/)).toBeInTheDocument();
  });

  it('loads output only on demand and renders provider text without HTML execution', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: /^done-task/ }));
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/output'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Read task output' }));
    const output = await screen.findByLabelText('Task output');
    expect(output).toHaveTextContent('<script>not executable</script>'); expect(output.querySelector('script')).toBeNull();
    expect(screen.getByText(/Output truncated to the session limit/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^external-task/ }));
    expect(screen.queryByLabelText('Task output')).not.toBeInTheDocument();
  });

  it.each(['worker', 'compose', 'map'] as const)('does not steal focus from %s after delayed cancellation', async (destination) => {
    const f = setup(); setMutationToken('d'.repeat(64));
    let settle!: (response: Response) => void;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((path, init) => path.endsWith('/cancel')
      ? new Promise<Response>((resolve) => { settle = resolve; }) : original(path, init));
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await user.click(await screen.findByRole('button', { name: 'Inspect map task owned-task' }));
    await user.click(screen.getByRole('button', { name: 'Cancel owned task' }));
    if (destination === 'worker') await user.click(screen.getByRole('button', { name: 'Inspect map worker local-a' }));
    else await user.click(screen.getByRole('button', { name: destination === 'compose' ? 'Compose task' : 'Back to fleet map' }));
    const intendedFocus = document.activeElement;
    await act(async () => { settle(json({ job: f.snapshot.supervisor!.jobs[1] })); });
    await screen.findByText('Cancellation requested for owned-task.');
    expect(document.activeElement).toBe(intendedFocus);
    if (destination === 'worker') expect(screen.getByRole('region', { name: 'Worker local-a' })).toBeInTheDocument();
    if (destination === 'compose') expect(screen.getByRole('button', { name: 'Compose task' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps a newer inspection when task submission finishes later', async () => {
    const f = setup(); setMutationToken('d'.repeat(64));
    let settle!: (response: Response) => void;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((path, init) => path === '/api/resources/tasks' && init?.method === 'POST'
      ? new Promise<Response>((resolve) => { settle = resolve; }) : original(path, init));
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await user.type(await screen.findByLabelText('What should this task do?'), 'Inspect the parser.');
    await user.click(screen.getByRole('button', { name: 'Queue task' }));
    await user.click(screen.getByRole('button', { name: 'Inspect map worker local-a' }));
    const intendedFocus = document.activeElement;
    await act(async () => { settle(json({ job: f.snapshot.supervisor!.jobs[0] })); });
    await screen.findByText(/queued. The supervisor will recheck capacity before dispatch/);
    expect(document.activeElement).toBe(intendedFocus);
    expect(screen.getByRole('region', { name: 'Worker local-a' })).toBeInTheDocument();
  });

  it('keeps previous data on failed refresh and withholds new work without disabling stop controls', async () => {
    const f = setup(); setMutationToken('d'.repeat(64)); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    f.request.mockResolvedValueOnce(json({ error: 'unavailable' }, 503));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('last successful read');
    expect(screen.getByRole('heading', { name: 'Routing board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause queue' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Queue task' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^owned-task/ }));
    expect(screen.getByRole('button', { name: 'Cancel owned task' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Pause queue' })).toBeEnabled();
  });

  it('permits pause and owned cancellation while evidence is degraded, but withholds resume', async () => {
    const f = setup(); f.snapshot.sourceState = 'degraded'; f.snapshot.plan = null;
    setMutationToken('d'.repeat(64)); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: 'Pause queue' }));
    expect(await screen.findByRole('button', { name: 'Resume queue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^owned-task/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel owned task' }));
    await waitFor(() => expect(f.request.mock.calls.some(([path]) => path.endsWith('/owned-task/cancel'))).toBe(true));
  });

  it.each([false, true])('keeps failed-read gates and historical labels during a pending retry (paused=%s)', async (paused) => {
    const f = setup(); f.snapshot.supervisor!.paused = paused; setMutationToken('d'.repeat(64));
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    f.request.mockResolvedValueOnce(json({ error: 'unavailable' }, 503));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('last successful read');
    let finishRetry!: (response: Response) => void;
    f.request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRetry = resolve; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('last successful read');
    expect(screen.getByText('Last observed preview:')).toBeInTheDocument();
    expect(screen.queryByText('Next eligible worker:')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue task' })).toBeDisabled();
    if (paused) expect(screen.getByRole('button', { name: 'Resume queue' })).toBeDisabled();
    else expect(screen.getByRole('button', { name: 'Pause queue' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /^local-a Previously eligible/ }));
    expect(screen.getByText(/do not establish current eligibility/)).toBeInTheDocument();
    expect(screen.getByText('Evidence at last successful read')).toBeInTheDocument();
    expect(screen.queryByText('Fresh observation')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^owned-task/ }));
    expect(screen.getByRole('button', { name: 'Cancel owned task' })).toBeEnabled();
    await act(async () => { finishRetry(json(f.snapshot)); });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    if (paused) expect(screen.getByRole('button', { name: 'Resume queue' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Compose task' }));
    expect(screen.getByRole('button', { name: 'Queue task' })).toBeEnabled();
  });

  it('focuses explicit keyboard inspections, preserves the draft and leaves focus alone on a visible-tab refresh', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.type(screen.getByLabelText('What should this task do?'), 'Keep this unsent investigation.');
    const worker = screen.getByRole('button', { name: /^codex-a Not eligible/ });
    worker.focus(); await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'codex-a' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Compose task' }));
    const draft = screen.getByLabelText('What should this task do?');
    expect(draft).toHaveValue('Keep this unsent investigation.'); draft.focus();
    const previousReads = f.request.mock.calls.length;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(f.request.mock.calls.length).toBeGreaterThan(previousReads));
    expect(draft).toHaveFocus(); expect(draft).toHaveValue('Keep this unsent investigation.');
    expect(f.request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('names a selected task that leaves the retained snapshot without inventing an outcome', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: /^done-task/ }));
    f.snapshot.recentAttempts = []; f.snapshot.supervisor!.jobs = f.snapshot.supervisor!.jobs.filter((job) => job.id !== 'done-task');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: 'Task done-task is not in this snapshot' })).toBeInTheDocument();
    expect(screen.getByText(/no outcome is inferred/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveFocus();
  });

  it('labels retained output after a failed reload and clears it when the supervisor session changes', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' }); await user.click(screen.getByRole('button', { name: /^done-task/ }));
    await user.click(screen.getByRole('button', { name: 'Read task output' }));
    expect(await screen.findByLabelText('Task output')).toHaveTextContent('fixture output');
    expect(screen.getByText(/Output snapshot, not a live stream/)).toBeInTheDocument();
    f.request.mockResolvedValueOnce(json({ error: 'unavailable' }, 503));
    await user.click(screen.getByRole('button', { name: 'Reload output' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Output is unavailable');
    expect(screen.getByText(/Previous output from the last successful read/)).toBeInTheDocument();
    expect(screen.getByLabelText('Task output')).toHaveTextContent('fixture output');
    const reads = f.request.mock.calls.filter(([path]) => path.endsWith('/output')).length;
    f.snapshot.supervisor!.instanceId = 'replacement-console-instance';
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByLabelText('Task output')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read task output' })).toBeInTheDocument();
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/output'))).toHaveLength(reads);
  });

  it.each(['read-only', 'degraded', 'closing'] as const)('withholds execution when %s', async (kind) => {
    const f = setup(); if (kind === 'read-only') { f.scope.readOnly = true; f.scope.workspace = null; }
    if (kind === 'degraded') { f.snapshot.sourceState = 'degraded'; f.snapshot.plan = null; }
    if (kind === 'closing') f.snapshot.supervisor!.closing = true;
    setMutationToken('d'.repeat(64)); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    expect(screen.getByRole('button', { name: 'Queue task' })).toBeDisabled();
    expect(f.request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('validates task limits and allowlist before sending a control request', async () => {
    const f = setup(); setMutationToken('d'.repeat(64)); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.type(screen.getByLabelText('What should this task do?'), 'Task');
    await user.clear(screen.getByLabelText('Max output tokens')); await user.type(screen.getByLabelText('Max output tokens'), '16385');
    await user.click(screen.getByRole('button', { name: 'Queue task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('16,384');
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('renders a truthful empty state and filters recorded activity without losing occupied rows', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.selectOptions(screen.getByLabelText('Task activity filter'), 'completed');
    expect(screen.getByRole('button', { name: /^done-task/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^external-task/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Task activity filter'), 'active');
    expect(screen.getByRole('button', { name: /^external-task/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^done-task/ })).not.toBeInTheDocument();
    f.snapshot.activeAttempts = []; f.snapshot.recentAttempts = []; f.snapshot.supervisor!.jobs = [];
    await user.selectOptions(screen.getByLabelText('Task activity filter'), 'all');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: 'No recorded tasks yet' })).toBeInTheDocument();
  });

  it('polls while visible, resumes on visibility, and removes timers on unmount without an event stream', async () => {
    const f = setup(); const view = render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    // Re-mount after enabling fake timers so the owned polling timer is deterministic.
    view.unmount(); vi.useFakeTimers();
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const mounted = render(<ResourcePoolView scope={f.scope} />);
    await act(async () => { await Promise.resolve(); });
    const before = f.request.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(f.request.mock.calls.length).toBe(before + 1);
    visible.mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(f.request.mock.calls.length).toBe(before + 1);
    visible.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    expect(f.request.mock.calls.length).toBe(before + 2);
    mounted.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(f.request.mock.calls.length).toBe(before + 2); expect(EventSource).not.toHaveBeenCalled();
  });

  it.each([401, 403])('handles a rejected control request HTTP%s without retrying or printing the token', async (status) => {
    const f = setup(); setMutationToken('d'.repeat(64)); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    f.request.mockResolvedValueOnce(json({ error: 'denied' }, status));
    await user.click(screen.getByRole('button', { name: 'Pause queue' }));
    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent(status === 401 ? 'Control token rejected' : 'execution is disabled');
    expect(message).not.toHaveTextContent('d'.repeat(64));
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    if (status === 401) expect(screen.getByRole('button', { name: 'Unlock controls' })).toBeInTheDocument();
  });

  it('can cancel a queued task and does not fetch any output as a side effect', async () => {
    const f = setup(); setMutationToken('d'.repeat(64)); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    await user.click(screen.getByRole('button', { name: /^queued-task/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel queued task' }));
    await waitFor(() => expect(f.request.mock.calls.some(([path]) => path === '/api/resources/tasks/queued-task/cancel')).toBe(true));
    expect(f.request.mock.calls.some(([path]) => path.endsWith('/output'))).toBe(false);
  });

  it('rejects oversized multibyte output rather than displaying partial unvalidated text', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' }); await user.click(screen.getByRole('button', { name: /^done-task/ }));
    f.request.mockResolvedValueOnce(json({ id: 'done-task', text: '界'.repeat(90_000), truncated: false, retention: 'this-console-session' }));
    await user.click(screen.getByRole('button', { name: 'Read task output' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Output is unavailable');
    expect(screen.queryByLabelText('Task output')).not.toBeInTheDocument();
  });

  it('exposes current owned assignments beside supervisor controls with keyboard selection', async () => {
    const f = setup(); const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    const supervisor = await screen.findByRole('region', { name: 'Foreground supervisor' });
    const strip = within(supervisor).getByRole('region', { name: 'Owned task dispatches' });
    const owned = within(strip).getByRole('button', { name: 'Inspect owned dispatch owned-task' });
    expect(owned).toHaveTextContent('local-a'); expect(owned).toHaveTextContent('dispatching');
    expect(within(strip).queryByText('external-task')).not.toBeInTheDocument();
    expect(within(strip).queryByText('queued-task')).not.toBeInTheDocument();
    owned.focus(); await user.keyboard('{Enter}');
    expect(owned).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Task owned-task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel owned task' })).toBeInTheDocument();
  });

  it('bounds the owned strip to four assignments with an explicit remaining count and expansion', async () => {
    const f = setup(); const base = f.snapshot.supervisor!.jobs.find((job) => job.id === 'owned-task')!;
    for (let index = 2; index <= 6; index++) f.snapshot.supervisor!.jobs.push({ ...base, id: `owned-${index}` });
    f.snapshot.supervisor!.activeCount = 6;
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    const strip = await screen.findByRole('region', { name: 'Owned task dispatches' });
    expect(within(strip).getAllByRole('button', { name: /^Inspect owned dispatch/ })).toHaveLength(4);
    await user.click(within(strip).getByRole('button', { name: 'Show 2 more owned dispatches' }));
    expect(within(strip).getAllByRole('button', { name: /^Inspect owned dispatch/ })).toHaveLength(6);
    await user.click(within(strip).getByRole('button', { name: 'Show first 4' }));
    expect(within(strip).getAllByRole('button', { name: /^Inspect owned dispatch/ })).toHaveLength(4);
  });

  it('does not render an empty owned-task box or mislabel external reservations as owned', async () => {
    const f = setup(); f.snapshot.supervisor!.jobs = f.snapshot.supervisor!.jobs.filter((job) => job.state !== 'dispatching');
    f.snapshot.supervisor!.activeCount = 0; render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' });
    expect(screen.queryByRole('region', { name: 'Owned task dispatches' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^external-task/ })).getByText('Unresolved external reservation')).toBeInTheDocument();
  });

  it('does not invent quota overflow when ready health is blocked by an actual quota reserve', async () => {
    const f = setup(); const observed = f.snapshot.observations[0]!;
    observed.windows = [{ id: 'five_hour', usedPercent: 94, resetsAt: '2026-09-07T16:00:00.000Z' },
      { id: 'seven_day', usedPercent: 66, resetsAt: '2026-09-12T00:00:00.000Z' }];
    f.snapshot.plan!.exclusions[0]!.reasons = ['worker-unavailable', 'quota-reserve-reached'];
    const user = userEvent.setup(); render(<ResourcePoolView scope={f.scope} />);
    await screen.findByRole('heading', { name: 'Routing board' }); await user.click(screen.getByRole('button', { name: /^codex-a Not eligible/ }));
    const inspector = screen.getByRole('region', { name: 'Worker codex-a' });
    expect(within(inspector).getByText('Fresh observation')).toBeInTheDocument();
    expect(within(inspector).getByText('Shared capacity is unavailable')).toBeInTheDocument();
    expect(within(inspector).getByText('Quota reserve reached')).toBeInTheDocument();
    expect(within(inspector).queryByText(/overflow/i)).not.toBeInTheDocument();
  });
});

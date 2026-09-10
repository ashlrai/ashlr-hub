import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UniverseControllerInspector } from './UniverseControllerInspector.js';

const at = '2026-09-09T10:00:00.000Z';
const report = { schemaVersion: 1, controllerId: 'fleet', sourceState: 'healthy', status: 'incomplete',
  createdAt: at, deadlineAt: '2026-09-10T10:00:00.000Z', observedAt: at, reasons: [],
  outcomes: [{ campaignId: 'build', state: 'held', attempted: false, reasonCode: 'owner-paused' }] };
const json = (value: unknown) => new Response(JSON.stringify(value));
async function submit(id = 'fleet') {
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('Controller ID'));
  await user.type(screen.getByLabelText('Controller ID'), id);
  await user.click(screen.getByRole('button', { name: 'Inspect controller' }));
  return user;
}

describe('scoped named controller inspector', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('keeps historical selection while navigating locally without new requests', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(report)).mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); await screen.findByRole('table');
    await user.type(screen.getByRole('searchbox', { name: 'Search campaigns' }), 'no-match');
    expect(within(screen.getByRole('region', { name: 'Selected campaign detail' })).getByRole('heading', { name: 'build' })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Refresh controller' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('status')).toHaveTextContent('Historical observation');
    await user.clear(screen.getByRole('searchbox', { name: 'Search campaigns' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search campaigns' }), 'owner-paused');
    await user.click(screen.getByRole('button', { name: 'Select campaign build' }));
    expect(screen.getByRole('status')).toHaveTextContent('Historical observation');
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /^Run|^Drain|^Resume/ })).not.toBeInTheDocument();
  });
  it('resets local campaign navigation when inspecting a different controller', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(report)).mockResolvedValueOnce(json({ ...report, controllerId: 'other' }));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); await screen.findByRole('table');
    await user.type(screen.getByRole('searchbox', { name: 'Search campaigns' }), 'build');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Recorded state' }), 'held');
    await submit('other'); await screen.findByRole('table');
    expect(screen.getByRole('searchbox', { name: 'Search campaigns' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Recorded state' })).toHaveValue('all');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not query on mount or edit, rejects bad IDs, and observes only on explicit submit/refresh', async () => {
    const request = vi.fn(async () => json(report)); vi.stubGlobal('fetch', request);
    render(<UniverseControllerInspector />);
    expect(request).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Controller ID'), '../fleet');
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Inspect controller' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter 1–64');
    expect(request).not.toHaveBeenCalled();
    await submit();
    await screen.findByRole('table', { name: 'Recorded campaign outcomes' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Recorded snapshot.');
    expect(screen.queryByRole('button', { name: /^Drain|^Resume|^Run/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh controller' }));
    await screen.findByText(/Recorded snapshot\./);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('labels edited input separately and preserves historical evidence after a failed refresh', async () => {
    const request = vi.fn().mockResolvedValueOnce(json(report)).mockRejectedValue(new Error('/private/secret'));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); expect(within(await screen.findByRole('table')).getByText('owner-paused')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Controller ID')); await user.type(screen.getByLabelText('Controller ID'), 'other');
    expect(screen.getByRole('heading', { name: 'Evidence for fleet' })).toBeInTheDocument();
    expect(screen.getByText(/form has changed/)).toHaveTextContent('still belongs to fleet');
    await user.click(screen.getByRole('button', { name: 'Refresh controller' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Observation failed');
    expect(screen.getByRole('status')).toHaveTextContent('Historical observation');
    expect(within(screen.getByRole('table')).getByText('owner-paused')).toBeInTheDocument();
    expect(screen.queryByText('/private/secret')).not.toBeInTheDocument();
    expect(request.mock.calls[1][0]).toBe('/api/universe/controller-status?controllerId=fleet');
  });
  it('ignores a late response for a previous submitted ID even if fetch ignores abort', async () => {
    let finish!: (value: Response) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(json({ ...report, controllerId: 'other', outcomes: [] }));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    await submit('fleet'); await submit('other'); await screen.findByText(/Recorded snapshot\./);
    await act(async () => { finish(json(report)); });
    expect(screen.getByRole('heading', { name: 'Evidence for other' })).toBeInTheDocument();
    expect(screen.queryByText('owner-paused')).not.toBeInTheDocument();
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('removes old evidence on switching IDs and rejects mismatched returned identity', async () => {
    const request = vi.fn(async () => json(report)); vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    await submit(); await screen.findByRole('table'); await submit('other');
    await screen.findByRole('alert');
    expect(screen.queryByText('owner-paused')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Evidence for other' })).toBeInTheDocument();
    expect(screen.queryByText(/Historical observation/)).not.toBeInTheDocument();
  });
  it.each(['missing', 'degraded'])('distinguishes %s evidence without inferring execution', async (sourceState) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...report, sourceState, status: 'unavailable', createdAt: null, deadlineAt: null, outcomes: [] })));
    render(<UniverseControllerInspector />); await submit(); await screen.findByText(/Recorded snapshot\./);
    expect(screen.getByText(sourceState)).toBeInTheDocument();
    expect(screen.getByText(sourceState === 'missing' ? /No controller registration/ : /Evidence could not be fully verified/)).toBeInTheDocument();
  });
  it.each(['completed', 'timed-out', 'drained'])('shows acknowledged drain separately from %s status', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...report, status, control: { mode: 'drain', sequence: 4, requestedAt: at, acknowledgedAt: at } })));
    render(<UniverseControllerInspector />); await submit();
    expect(await screen.findByRole('heading', { name: 'Drain acknowledged' })).toBeInTheDocument();
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(screen.getByText('Sequence 4')).toBeInTheDocument();
    expect(screen.getByText(/already-admitted work can continue/)).toBeInTheDocument();
  });
  it('keeps an unresolved intent unacknowledged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...report, status: 'draining', outcomes: [{ ...report.outcomes[0], state: 'in-flight' }],
      control: { mode: 'drain', sequence: 2, requestedAt: at, acknowledgedAt: null } })));
    render(<UniverseControllerInspector />); await submit();
    expect(await screen.findByRole('heading', { name: 'Drain awaiting acknowledgement' })).toBeInTheDocument();
    expect(screen.getByText('Acknowledgement not recorded')).toBeInTheDocument();
    expect(screen.getByText(/“In-flight” means/)).toHaveTextContent('not proof of a live worker');
  });
  it('distinguishes a recorded campaign intent from a proven skipped worker call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...report, outcomes: [{ ...report.outcomes[0], attempted: true, reasonCode: 'dispatch-not-started' }] })));
    render(<UniverseControllerInspector />); await submit();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('dispatch-not-started')).toBeInTheDocument();
    expect(within(table).getByText('held')).toBeInTheDocument();
    expect(within(table).getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText(/Campaign attempted records a call intent/)).toHaveTextContent('not proof of worker execution');
    expect(screen.getByText(/does not authorize a retry/)).toBeInTheDocument();
  });
  it('shows resumed admission without claiming no later run; delivery-only intent does not become an attempted campaign', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...report, outcomes: [{ ...report.outcomes[0], state: 'in-flight', reasonCode: 'delivery-pending' }],
      control: { mode: 'open', sequence: 6, requestedAt: at, acknowledgedAt: null } })));
    render(<UniverseControllerInspector />); await submit();
    expect(await screen.findByRole('heading', { name: 'Admission reopened' })).toBeInTheDocument();
    expect(screen.getByText('Resume did not start work')).toBeInTheDocument();
    expect(screen.queryByText('Explicit run still required')).not.toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Campaign attempted' })).toBeInTheDocument();
    expect(within(table).getByText('No')).toBeInTheDocument();
  });
});

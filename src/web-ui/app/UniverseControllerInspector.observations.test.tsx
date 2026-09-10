import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UniverseControllerInspector } from './UniverseControllerInspector.js';

const report = (reasonCode: string, minute: number, controllerId = 'fleet') => ({
  schemaVersion: 1, controllerId, sourceState: 'healthy', status: 'incomplete',
  createdAt: '2026-09-09T09:00:00.000Z', deadlineAt: '2026-09-09T11:00:00.000Z',
  observedAt: `2026-09-09T10:0${minute}:00.000Z`, reasons: [],
  outcomes: [{ campaignId: 'build', state: 'held', attempted: false, reasonCode }],
});
const json = (value: unknown) => new Response(JSON.stringify(value));
const changes = () => screen.getByRole('region', { name: 'Changes between observations' });
async function submit(id = 'fleet') {
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('Controller ID'));
  await user.type(screen.getByLabelText('Controller ID'), id);
  await user.click(screen.getByRole('button', { name: 'Inspect controller' }));
  return user;
}
async function settled() { await screen.findByText(/^Recorded snapshot\./); }

describe('controller accepted observation pair', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('compares consecutive accepted reads and advances the baseline even when unchanged', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json(report('owner-paused', 0)))
      .mockResolvedValueOnce(json(report('quota-wait', 1)))
      .mockResolvedValueOnce(json(report('quota-wait', 2)));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); await settled();
    expect(changes()).not.toHaveTextContent('owner-paused');
    await user.click(screen.getByRole('button', { name: 'Refresh controller' })); await settled();
    expect(changes()).toHaveTextContent('owner-paused');
    expect(changes()).toHaveTextContent('quota-wait');
    await user.click(screen.getByRole('button', { name: 'Refresh controller' })); await settled();
    expect(changes()).not.toHaveTextContent('owner-paused');
    expect(changes().querySelectorAll('time')[0]).toHaveAttribute('datetime', report('', 1).observedAt);
    expect(changes().querySelectorAll('time')[1]).toHaveAttribute('datetime', report('', 2).observedAt);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('retains both observations on failure and recovers from the last accepted read', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json(report('owner-paused', 0)))
      .mockResolvedValueOnce(json(report('quota-wait', 1)))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json(report('resource-busy', 3)));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); await settled();
    await user.click(screen.getByRole('button', { name: 'Refresh controller' })); await settled();
    await user.click(screen.getByRole('button', { name: 'Refresh controller' })); await screen.findByRole('alert');
    expect(screen.getByRole('status')).toHaveTextContent('Historical observation');
    expect(changes()).toHaveTextContent(/historical/i);
    expect(changes()).toHaveTextContent('owner-paused');
    expect(changes()).toHaveTextContent('quota-wait');
    await user.click(screen.getByRole('button', { name: 'Refresh controller' })); await settled();
    expect(changes()).not.toHaveTextContent('owner-paused');
    expect(changes()).toHaveTextContent('quota-wait');
    expect(changes()).toHaveTextContent('resource-busy');
    expect(changes().querySelectorAll('time')[0]).toHaveAttribute('datetime', report('', 1).observedAt);
  });

  it('clears the pair on submitted identity change but not editing or invalid submission', async () => {
    let finish!: (value: Response) => void;
    const request = vi.fn()
      .mockResolvedValueOnce(json(report('owner-paused', 0)))
      .mockResolvedValueOnce(json(report('quota-wait', 1)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); await settled();
    await user.click(screen.getByRole('button', { name: 'Refresh controller' })); await settled();
    await submit('../invalid');
    expect(changes()).toHaveTextContent('owner-paused');
    expect(request).toHaveBeenCalledTimes(2);
    await submit('other');
    expect(screen.queryByRole('region', { name: 'Changes between observations' })).not.toBeInTheDocument();
    await act(async () => { finish(json(report('resource-busy', 2, 'other'))); }); await settled();
    expect(changes()).not.toHaveTextContent('quota-wait');
    expect(changes()).not.toHaveTextContent('resource-busy');
    expect(within(screen.getByRole('table')).getByText('resource-busy')).toBeInTheDocument();
  });

  it('never lets a superseded same-controller response advance the comparison', async () => {
    let finish!: (value: Response) => void;
    const request = vi.fn()
      .mockResolvedValueOnce(json(report('owner-paused', 0)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(json(report('resource-busy', 2)))
      .mockResolvedValueOnce(json(report('quota-wait', 3)));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); await settled();
    await user.click(screen.getByRole('button', { name: 'Inspect controller' }));
    expect(changes()).toHaveTextContent(/reading|refresh/i);
    await user.click(screen.getByRole('button', { name: 'Inspect controller' })); await settled();
    await act(async () => { finish(json(report('late-result', 1))); });
    expect(changes()).toHaveTextContent('owner-paused');
    expect(changes()).toHaveTextContent('resource-busy');
    expect(changes()).not.toHaveTextContent('late-result');
    await user.click(screen.getByRole('button', { name: 'Refresh controller' })); await settled();
    expect(changes()).not.toHaveTextContent('owner-paused');
    expect(changes()).toHaveTextContent('resource-busy');
    expect(changes()).toHaveTextContent('quota-wait');
    expect(request.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it('ignores a superseded rejection without marking accepted evidence historical', async () => {
    let rejectLate!: (reason: Error) => void;
    const request = vi.fn()
      .mockResolvedValueOnce(json(report('owner-paused', 0)))
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectLate = reject; }))
      .mockResolvedValueOnce(json(report('quota-wait', 2)));
    vi.stubGlobal('fetch', request); render(<UniverseControllerInspector />);
    const user = await submit(); await settled();
    await user.click(screen.getByRole('button', { name: 'Inspect controller' }));
    await user.click(screen.getByRole('button', { name: 'Inspect controller' })); await settled();
    await act(async () => { rejectLate(new Error('superseded request failed')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Recorded snapshot');
    expect(changes()).not.toHaveTextContent(/historical/i);
    expect(changes()).toHaveTextContent('owner-paused');
    expect(changes()).toHaveTextContent('quota-wait');
  });
});

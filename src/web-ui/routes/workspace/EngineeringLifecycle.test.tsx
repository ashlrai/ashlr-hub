import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { closeResourceEngineering, readResourceEngineeringLifecycle } from '../../data/resource-pool-queries.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { EngineeringLifecycle } from './EngineeringLifecycle.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture() {
  const scope = { ...resourceFixture().scope, engineeringSupported: true as const, engineeringLifecycle: 'running' as const,
    defaultProjectId: 'default' as const, projects: [{ id: 'default', label: 'Hub', workspace: '/private/project', enabled: true }] };
  let state: unknown = 'running'; let fail = false;
  const close = vi.fn(async () => { state = 'closed'; return json({ engineeringLifecycle: 'closed' }); });
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return close();
    return fail ? json({}, 503) : json({ ...scope, engineeringLifecycle: state });
  });
  vi.stubGlobal('fetch', fetcher);
  return { scope, fetcher, close, setState: (value: unknown) => { state = value; }, fail: () => { fail = true; } };
}
beforeEach(() => { setMutationToken('a'.repeat(64)); });
afterEach(() => { act(() => clearMutationToken()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('engineering component lifecycle controls', () => {
  it('reads status without mutations and requires a separate click after unlocking', async () => {
    const f = fixture(); const onUnlock = vi.fn(); const onReadyChange = vi.fn();
    const view = render(<EngineeringLifecycle scope={f.scope} unlocked={false} onUnlock={onUnlock} onReadyChange={onReadyChange} />);
    await screen.findByText('Running'); expect(f.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock to close engineering' })); expect(onUnlock).toHaveBeenCalledOnce();
    view.rerender(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={onUnlock} onReadyChange={onReadyChange} />);
    expect(f.close).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
    await screen.findByText('Closed'); expect(f.close).toHaveBeenCalledOnce(); expect(onReadyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Close engineering' })).toBeDisabled();
    expect(f.fetcher.mock.calls.find(([, options]) => options?.method === 'POST')?.[0]).toBe('/api/resources/engineering-runtime/close');
  });
  it('does not infer closure from an in-flight request or allow duplicate close clicks', async () => {
    const f = fixture(); let finish!: (value: Response) => void;
    f.close.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={vi.fn()} />);
    await screen.findByText('Running'); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
    expect(screen.getByText('Closing')).toBeInTheDocument(); expect(screen.queryByText('Closed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Closing engineering…' })); expect(f.close).toHaveBeenCalledOnce();
    f.setState('closed'); await act(async () => finish(json({ engineeringLifecycle: 'closed' })));
    await screen.findByText('Closed');
  });
  it('withholds engineering on unknown reads while leaving an explicit close available', async () => {
    const f = fixture(); f.fail(); const ready = vi.fn();
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
    await screen.findByText('Unknown'); expect(ready).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Close engineering' })).toBeEnabled(); expect(f.close).not.toHaveBeenCalled();
  });
  it('shows a held shutdown without claiming worker exit or retrying effects', async () => {
    const f = fixture(); f.setState('held');
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={vi.fn()} />);
    await screen.findByText('Held'); expect(screen.getByRole('alert')).toHaveTextContent('Shutdown remains unresolved');
    expect(screen.getByRole('button', { name: 'Close engineering' })).toBeDisabled(); expect(f.close).not.toHaveBeenCalled();
  });
  it('reconciles lost close output through reads, never automatic mutation replay', async () => {
    const f = fixture(); f.close.mockImplementation(async () => { f.setState('held'); throw new Error('PRIVATE_TRANSPORT'); });
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={vi.fn()} />);
    await screen.findByText('Running'); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
    await screen.findByText('Held'); expect(screen.getByText(/Close was not confirmed/)).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE_TRANSPORT/)).not.toBeInTheDocument(); expect(f.close).toHaveBeenCalledOnce();
  });
  it('never restores engineering mutation access from a running sample after an uncertain close', async () => {
    const f = fixture(); const ready = vi.fn();
    f.close.mockRejectedValue(new Error('lost response'));
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
    await screen.findByText('Running'); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
    await screen.findByText(/console still reports running after a close attempt/);
    expect(ready).toHaveBeenLastCalledWith(false); expect(f.close).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Check engineering status' }));
    await act(async () => {}); expect(ready).toHaveBeenLastCalledWith(false); expect(f.close).toHaveBeenCalledOnce();
  });
  it('aborts pending reads and removes polling on unmount without writing', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let finish!: (value: Response) => void;
      f.fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const ready = vi.fn();
      const view = render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
      expect(f.fetcher).toHaveBeenCalledOnce();
      const signal = f.fetcher.mock.calls[0]![1]!.signal!;
      view.unmount(); expect(signal.aborted).toBe(true); ready.mockClear();
      await act(async () => finish(json({ ...f.scope, engineeringLifecycle: 'running' })));
      await act(async () => vi.advanceTimersByTimeAsync(9000));
      expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('expires a stalled running read and rejects its late response', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const ready = vi.fn();
      const view = render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
      await act(async () => {}); expect(ready).toHaveBeenLastCalledWith(true);
      let finish!: (value: Response) => void;
      f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      const signal = f.fetcher.mock.calls[1]![1]!.signal!;
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(signal.aborted).toBe(true); expect(screen.getByText('Unknown')).toBeInTheDocument();
      expect(ready).toHaveBeenLastCalledWith(false);
      await act(async () => finish(json({ ...f.scope, engineeringLifecycle: 'running' })));
      expect(ready).toHaveBeenLastCalledWith(false); expect(f.close).not.toHaveBeenCalled(); view.unmount();
    } finally { vi.useRealTimers(); }
  });
  it.each(['root', 'poolId', 'workspace'] as const)('rejects changed %s scope in lifecycle reads', async key => {
    const f = fixture(); await expect(readResourceEngineeringLifecycle({ ...f.scope, [key]: '/changed' })).rejects.toThrow('scope');
  });
  it.each([{}, { engineeringLifecycle: 'held' }, { engineeringLifecycle: 'closed', extra: true }])('rejects unverified close acknowledgment %#', async value => {
    const f = fixture(); f.close.mockResolvedValue(json(value)); await expect(closeResourceEngineering()).rejects.toThrow('not confirmed');
    expect(f.close).toHaveBeenCalledOnce();
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { closeResourceEngineering, readResourceEngineeringLifecycle } from '../../data/resource-pool-queries.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { EngineeringLifecycle } from './EngineeringLifecycle.js';
import type { ResourceConsoleScope } from '../../../core/resources/console-types.js';

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
function attachmentFixture(id: string | null = 'a'.repeat(32)) {
  const f = fixture();
  const scope: ResourceConsoleScope = { ...f.scope, engineeringAttachmentSupported: true as const,
    ...(id ? { engineeringAttachmentId: id } : { engineeringSupported: undefined, engineeringLifecycle: undefined }) };
  let sample = { ...scope };
  f.fetcher.mockImplementation(async (_url, options) => options?.method === 'POST' ? f.close() : json(sample));
  f.close.mockImplementation(async () => {
    sample = { ...sample, engineeringLifecycle: 'closed' };
    return json({ engineeringLifecycle: 'closed', engineeringAttachmentId: sample.engineeringAttachmentId });
  });
  return { ...f, scope, replace: (next: string) => { sample = { ...f.scope, engineeringAttachmentSupported: true,
    engineeringAttachmentId: next, engineeringLifecycle: 'running' }; },
    sample: () => sample, setSample: (next: typeof sample) => { sample = next; } };
}
beforeEach(() => { setMutationToken('a'.repeat(64)); });
afterEach(() => { act(() => clearMutationToken()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('engineering component lifecycle controls', () => {
  it('keeps managed scope observation without offering a misleading scope-close action', async () => {
    const f = attachmentFixture(), ready = vi.fn();
    render(<EngineeringLifecycle scope={{ ...f.scope, engineeringMissionSupported: true }} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
    await screen.findByText('Current mission scope');
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true, 'a'.repeat(32)));
    expect(screen.queryByRole('button', { name: 'Close engineering' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check engineering status' })).toBeEnabled(); expect(f.close).not.toHaveBeenCalled();
  });
  it('discovers host attachment without any mutation and publishes its capabilities', async () => {
    const f = attachmentFixture(null), ready = vi.fn(), changed = vi.fn();
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} onScopeChange={changed} />);
    await screen.findByText('Not attached'); expect(screen.getByRole('button', { name: 'Close engineering' })).toBeDisabled();
    f.replace('b'.repeat(32)); fireEvent.click(screen.getByRole('button', { name: 'Check engineering status' }));
    await screen.findByText('Running'); await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true, 'b'.repeat(32)));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ engineeringAttachmentId: 'b'.repeat(32), engineeringSupported: true }));
    expect(f.close).not.toHaveBeenCalled();
  });
  it('reopens controls only for a verified replacement and pins each close to its own identity', async () => {
    const f = attachmentFixture(), ready = vi.fn();
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
    await screen.findByText('Running'); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
    await screen.findByText('Closed'); f.replace('b'.repeat(32));
    fireEvent.click(screen.getByRole('button', { name: 'Check engineering status' }));
    await screen.findByText('Running'); await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true, 'b'.repeat(32)));
    expect(screen.queryByText(/still reports running after a close attempt/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close engineering' })); await screen.findByText('Closed');
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual([{ expectedAttachmentId: 'a'.repeat(32) }, { expectedAttachmentId: 'b'.repeat(32) }]);
  });
  it('rejects late close acknowledgment after observing a replacement without blocking its controls', async () => {
    vi.useFakeTimers();
    try {
      const f = attachmentFixture(), ready = vi.fn(); let finish!: (value: Response) => void;
      f.close.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const view = render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
      await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
      const signal = f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.signal!;
      f.replace('b'.repeat(32)); await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(signal.aborted).toBe(true); expect(screen.getByText('Running')).toBeInTheDocument();
      expect(ready).toHaveBeenLastCalledWith(true, 'b'.repeat(32));
      await act(async () => finish(json({ engineeringLifecycle: 'closed', engineeringAttachmentId: 'a'.repeat(32) })));
      expect(screen.getByText('Running')).toBeInTheDocument(); expect(screen.queryByText(/Close was not confirmed/)).not.toBeInTheDocument();
      expect(ready).toHaveBeenLastCalledWith(true, 'b'.repeat(32)); view.unmount();
    } finally { vi.useRealTimers(); }
  });
  it('withholds a missing attachment identity instead of forgetting an uncertain close', async () => {
    const f = attachmentFixture(), ready = vi.fn(); f.close.mockRejectedValue(new Error('lost reply'));
    render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
    await screen.findByText('Running'); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
    await screen.findByText(/still reports running after a close attempt/);
    f.setSample({ ...f.sample(), engineeringSupported: undefined, engineeringLifecycle: undefined, engineeringAttachmentId: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Check engineering status' }));
    await screen.findByText('Unknown'); expect(ready).toHaveBeenLastCalledWith(false, 'a'.repeat(32)); expect(f.close).toHaveBeenCalledOnce();
  });
  it('rejects a pinned acknowledgment for another attachment', async () => {
    const f = attachmentFixture(); f.close.mockResolvedValue(json({ engineeringLifecycle: 'closed', engineeringAttachmentId: 'b'.repeat(32) }));
    await expect(closeResourceEngineering('a'.repeat(32))).rejects.toThrow('not confirmed');
  });
  it('bounds a stalled close without replaying it or restoring the same attachment', async () => {
    vi.useFakeTimers();
    try {
      const f = attachmentFixture(), ready = vi.fn(); let signal: AbortSignal | null = null;
      f.fetcher.mockImplementation(async (_url, init) => {
        if (init?.method !== 'POST') return json(f.sample());
        signal = init.signal!;
        return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      });
      const view = render(<EngineeringLifecycle scope={f.scope} unlocked onUnlock={vi.fn()} onReadyChange={ready} />);
      await act(async () => {}); fireEvent.click(screen.getByRole('button', { name: 'Close engineering' }));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect((signal as AbortSignal | null)?.aborted).toBe(true);
      expect(screen.getByText(/Close was not confirmed/)).toBeInTheDocument();
      expect(ready).toHaveBeenLastCalledWith(false, 'a'.repeat(32));
      expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); view.unmount();
    } finally { vi.useRealTimers(); }
  });
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

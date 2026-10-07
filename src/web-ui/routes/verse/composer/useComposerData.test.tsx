import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseSessionControlsResponse } from '../../../../core/verse/workbench-types.js';
import { ApiError } from '../../../data/client.js';
import { fetchSessionControls, updateSessionControls } from './composer-queries.js';
import { useSessionControls, type GateRun } from './useComposerData.js';

vi.mock('./composer-queries.js', () => ({ fetchSessionControls: vi.fn(), updateSessionControls: vi.fn() }));
const read = vi.mocked(fetchSessionControls);
const write = vi.mocked(updateSessionControls);
const view = (model = 'old'): VerseSessionControlsResponse => ({
  sessionId: 'chat', controls: { model, effort: null, permissionMode: 'plan' }, appliesNextTurn: false,
  options: { models: [], efforts: [], permissionModes: [] },
});
const run: GateRun = (_reason, action) => action();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { read.mockReset(); write.mockReset(); });

describe('chat settings reads and acknowledgements', () => {
  it('shows initial loading, reports failure, and retries only when asked', async () => {
    const reply = deferred<VerseSessionControlsResponse>();
    read.mockReturnValueOnce(reply.promise).mockResolvedValueOnce(view());
    const { result } = renderHook(() => useSessionControls('chat', false, run));
    expect(result.current.loading).toBe(true);
    await act(async () => reply.reject(new Error('Network unavailable')));
    expect(result.current.view).toBeNull();
    expect(result.current.error).toBe('Network unavailable');
    expect(result.current.loading).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.view?.controls.model).toBe('old'));
    expect(result.current.error).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps warm controls through a failed refresh and the next retry', async () => {
    const refresh = deferred<VerseSessionControlsResponse>();
    read.mockResolvedValueOnce(view()).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(view('new'));
    const { result, rerender } = renderHook(({ running }) => useSessionControls('chat', running, run), { initialProps: { running: false } });
    await waitFor(() => expect(result.current.view).not.toBeNull());
    rerender({ running: true });
    expect(result.current.loading).toBe(true);
    expect(result.current.view?.controls.model).toBe('old');
    await act(async () => refresh.reject(new Error('Offline')));
    expect(result.current.view?.controls.model).toBe('old');
    act(() => result.current.retry());
    expect(result.current.view?.controls.model).toBe('old');
    await waitFor(() => expect(result.current.view?.controls.model).toBe('new'));
  });

  it.each([
    [new ApiError('No route', 404, '/controls'), true, null],
    [new ApiError('Missing', 404, '/controls', null, 'VERSE_SESSION_NOT_FOUND'), false, 'This chat no longer exists'],
    [new ApiError('Expired', 401, '/controls'), false, 'The read session expired'],
  ])('classifies typed read refusal %s without asking for a mutation token', async (error, unsupported, message) => {
    read.mockRejectedValueOnce(error);
    const { result } = renderHook(() => useSessionControls('chat', false, run));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unsupported).toBe(unsupported);
    if (message) expect(result.current.error).toContain(message);
    else expect(result.current.error).toBeNull();
    expect(result.current.error ?? '').not.toContain('mutation token');
  });

  it('ignores a late reply after its read was aborted', async () => {
    const first = deferred<VerseSessionControlsResponse>();
    read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(view('current'));
    const { result, rerender } = renderHook(({ running }) => useSessionControls('chat', running, run), { initialProps: { running: false } });
    const signal = read.mock.calls[0]![1]!;
    rerender({ running: true });
    await waitFor(() => expect(result.current.view?.controls.model).toBe('current'));
    expect(signal.aborted).toBe(true);
    await act(async () => first.resolve(view('obsolete')));
    expect(result.current.view?.controls.model).toBe('current');
  });

  it('a pending write preserves controls and neither pre-write nor in-flight reads overwrite its acknowledgement', async () => {
    const beforeWrite = deferred<VerseSessionControlsResponse>();
    const duringWrite = deferred<VerseSessionControlsResponse>();
    const acknowledgement = deferred<VerseSessionControlsResponse>();
    read.mockResolvedValueOnce(view()).mockReturnValueOnce(beforeWrite.promise).mockReturnValueOnce(duringWrite.promise);
    write.mockReturnValueOnce(acknowledgement.promise);
    const { result, rerender } = renderHook(({ running }) => useSessionControls('chat', running, run), { initialProps: { running: false } });
    await waitFor(() => expect(result.current.view).not.toBeNull());
    rerender({ running: true });
    let updating!: Promise<boolean>;
    act(() => { updating = result.current.update({ model: 'new' }, 'Change model'); });
    expect(result.current.pending).toBe(true);
    expect(result.current.view?.controls.model).toBe('old');
    rerender({ running: false });
    await act(async () => acknowledgement.resolve(view('new')));
    expect(await updating).toBe(true);
    expect(result.current.pending).toBe(false);
    await act(async () => { beforeWrite.resolve(view('before')); duringWrite.resolve(view('during')); });
    expect(result.current.view?.controls.model).toBe('new');
    expect(result.current.loading).toBe(false);
  });

  it('dismissed unlock retains controls and is not reported as saved or failed', async () => {
    read.mockResolvedValue(view());
    const cancel: GateRun = async () => null;
    const { result } = renderHook(() => useSessionControls('chat', false, cancel));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    await act(async () => { expect(await result.current.update({ model: 'new' }, 'Change model')).toBe(false); });
    expect(result.current.view?.controls.model).toBe('old');
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it('disabling a chat discards late settings acknowledgements and releases pending feedback', async () => {
    const acknowledgement = deferred<VerseSessionControlsResponse>();
    read.mockResolvedValue(view());
    write.mockReturnValueOnce(acknowledgement.promise);
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useSessionControls(id, false, run), { initialProps: { id: 'chat' as string | null } });
    await waitFor(() => expect(result.current.view).not.toBeNull());
    let updating!: Promise<boolean>;
    act(() => { updating = result.current.update({ model: 'new' }, 'Change model'); });
    rerender({ id: null });
    expect(result.current.view).toBeNull();
    expect(result.current.pending).toBe(false);
    rerender({ id: 'chat' });
    await waitFor(() => expect(result.current.view?.controls.model).toBe('old'));
    await act(async () => acknowledgement.resolve(view('new')));
    expect(await updating).toBe(false);
    expect(result.current.view?.controls.model).toBe('old');
    expect(result.current.pending).toBe(false);
  });

  it('an unlock completed after unmount does not submit the old chat settings', async () => {
    read.mockResolvedValue(view());
    let unlock!: () => Promise<unknown>;
    const gate: GateRun = (_reason, action) => new Promise((resolve) => { unlock = async () => { const value = await action(); resolve(value); return value; }; });
    const { result, unmount } = renderHook(() => useSessionControls('chat', false, gate));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    let updating!: Promise<boolean>;
    act(() => { updating = result.current.update({ model: 'new' }, 'Change model'); });
    unmount();
    await act(async () => { await unlock(); expect(await updating).toBe(false); });
    expect(write).not.toHaveBeenCalled();
  });

});

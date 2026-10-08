import { readFileSync } from 'node:fs';
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDesktopUpdateState, isDesktopUpdateState, refreshDesktopUpdates, resetDesktopUpdatesForTests, useDesktopUpdates } from './desktop-updates.js';
const state = { phase: 'downloading', enabled: true, version: '3.25.2', bytesReceived: 1024, bytesTotal: 4096, reason: null };
afterEach(() => { resetDesktopUpdatesForTests(); delete (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__']; vi.unstubAllGlobals(); });
describe('native update observation boundary', () => {
  it('does not create browser update controls or authority', () => { expect(getDesktopUpdateState()).toBeNull(); expect(refreshDesktopUpdates()).toBe(false); });
  it.each([
    { phase: 'install-now' }, { enabled: 1 }, { version: '3.2.1/unsafe' }, { version: '03.2.1' }, { bytesReceived: -1 },
    { bytesReceived: 4097 }, { bytesTotal: 0 }, { bytesTotal: 536870913 }, { reason: '/private/raw-error' },
  ])('rejects malformed observations %j', (patch) => { expect(isDesktopUpdateState({ ...state, ...patch })).toBe(false); });
  it('renders only accepted native observations with stable snapshots', () => {
    (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'] = { updates: { getState: () => ({ ...state }) } };
    const { result } = renderHook(() => useDesktopUpdates());
    const first = result.current; expect(getDesktopUpdateState()).toBe(first);
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:update-state', { detail: { ...state, bytesReceived: 5000 } })); });
    expect(result.current).toBe(first);
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:update-state', { detail: { ...state, phase: 'staged', bytesReceived: 4096 } })); });
    expect(result.current?.phase).toBe('staged');
  });
  it('the real injected shell exposes status-only refresh and isolated snapshots', () => {
    const invoke = vi.fn();
    const nativeWindow = { location: { origin: 'http://localhost:7838' }, __TAURI_INTERNALS__: { invoke }, dispatchEvent: vi.fn() } as unknown as Record<string, unknown>;
    const source = readFileSync('desktop/src-tauri/src/shell_contract.js', 'utf8');
    const cfg = { origin: 'http://localhost:7838', platform: 'macos', titlebarHeight: 28, trafficLightInset: 72 };
    const run = new Function('window', '__ASHLR_SHELL_CONFIG', source);
    run(nativeWindow, cfg);
    const callback = nativeWindow['__ASHLR_UPDATE_STATE__'] as (value: unknown) => void;
    callback(state);
    const desktop = nativeWindow['__ASHLR_DESKTOP__'] as { updates: { getState: () => typeof state; refresh: () => boolean }; setPreference: (name: string, value: boolean) => boolean };
    const snapshot = desktop.updates.getState(); snapshot.phase = 'installed';
    expect(desktop.updates.getState().phase).toBe('downloading');
    invoke.mockClear(); expect(desktop.updates.refresh()).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:event|emit', { event: 'shell-update', payload: { op: 'status' } });
    expect(Object.keys(desktop.updates).sort()).toEqual(['getState', 'refresh']);
    expect(Object.getOwnPropertyDescriptor(nativeWindow, '__ASHLR_UPDATE_STATE__')?.writable).toBe(false);
    expect(desktop.setPreference('automaticUpdates', false)).toBe(true);
    expect(desktop.setPreference('installUpdate', true)).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findCommand, formatChord } from '../routes/verse/shell/command-catalog.js';
import {
  getDesktopState,
  isDesktopShell,
  isDesktopState,
  reportThemeToShell,
  resetDesktopStateForTests,
  resolveTheme,
  setDesktopPreference,
  subscribeDesktopCommands,
  subscribeDesktopState,
  subscribeShellCommands,
  useDesktopState,
  type DesktopCommand,
  type DesktopState,
} from './desktop-shell.js';

type Bridge = {
  reportTheme?: (theme: 'light' | 'dark') => void;
  getState?: () => unknown;
  setPreference?: (name: string, value: boolean) => boolean;
};
type ShellWindow = {
  __ASHLR_DESKTOP__?: Bridge;
  __ASHLR_DESKTOP_STATE__?: (next: unknown) => void;
  __ASHLR_DESKTOP_COMMAND__?: (command: string) => void;
  __ASHLR_TOKENS__?: unknown;
  __TAURI_INTERNALS__?: { invoke: (command: string, args: unknown) => void };
};
const win = window as unknown as ShellWindow;

afterEach(() => {
  const root = document.documentElement;
  for (const attr of ['data-app-shell', 'data-app-platform']) root.removeAttribute(attr);
  root.style.removeProperty('--app-titlebar-height');
  root.style.removeProperty('--app-traffic-light-inset');
  delete win.__ASHLR_DESKTOP__;
  delete win.__ASHLR_DESKTOP_STATE__;
  delete win.__ASHLR_DESKTOP_COMMAND__;
  delete win.__ASHLR_TOKENS__;
  delete win.__TAURI_INTERNALS__;
  resetDesktopStateForTests();
  vi.unstubAllGlobals();
});

const STATE: DesktopState = {
  hotkey: { enabled: false, registered: false, accelerator: '⌃⌥Space', error: null },
  notifications: { enabled: true, delivery: 'script' },
};

describe('isDesktopShell', () => {
  it('is false in a browser, where the native side stamps no marker', () => {
    expect(isDesktopShell()).toBe(false);
  });

  it('is true only for the exact marker the shell contract stamps', () => {
    document.documentElement.setAttribute('data-app-shell', 'desktop');
    expect(isDesktopShell()).toBe(true);
    document.documentElement.setAttribute('data-app-shell', 'web');
    expect(isDesktopShell()).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('passes an explicit preference straight through', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('resolves "system" against the OS, because the native side needs a real colour', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark') }));
    expect(resolveTheme('system')).toBe('dark');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('reportThemeToShell', () => {
  it('does nothing, and does not throw, when there is no desktop bridge', () => {
    expect(() => reportThemeToShell('dark')).not.toThrow();
  });

  it('reports the RESOLVED theme, never the raw "system" preference', () => {
    const reportTheme = vi.fn();
    win.__ASHLR_DESKTOP__ = { reportTheme };
    vi.stubGlobal('matchMedia', () => ({ matches: true }));

    reportThemeToShell('system');

    expect(reportTheme).toHaveBeenCalledWith('dark');
    expect(reportTheme).not.toHaveBeenCalledWith('system');
  });

  it('swallows a throwing bridge — the shell is an enhancement, not a dependency', () => {
    win.__ASHLR_DESKTOP__ = {
      reportTheme: () => {
        throw new Error('ipc gone');
      },
    };
    expect(() => reportThemeToShell('light')).not.toThrow();
  });
});

describe('subscribeDesktopCommands', () => {
  function dispatch(command: unknown): void {
    window.dispatchEvent(new CustomEvent('ashlr:desktop-command', { detail: { command } }));
  }

  it('delivers the two commands the native menu bar sends', () => {
    const seen: DesktopCommand[] = [];
    const off = subscribeDesktopCommands((c) => seen.push(c));

    dispatch('open-settings');
    dispatch('toggle-theme');

    expect(seen).toEqual(['open-settings', 'toggle-theme']);
    off();
  });

  it('ignores an unknown command rather than forwarding it', () => {
    const handler = vi.fn();
    const off = subscribeDesktopCommands(handler);

    dispatch('quit-everything');
    dispatch(undefined);
    window.dispatchEvent(new CustomEvent('ashlr:desktop-command'));

    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it('stops listening after unsubscribe', () => {
    const handler = vi.fn();
    subscribeDesktopCommands(handler)();

    dispatch('open-settings');

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('subscribeShellCommands', () => {
  function dispatch(command: unknown): void {
    window.dispatchEvent(new CustomEvent('ashlr:desktop-command', { detail: { command } }));
  }

  it('delivers every command the tray, a notification and the hotkey send, parsed by the catalog', () => {
    const seen: unknown[] = [];
    const off = subscribeShellCommands((c) => seen.push(c));

    dispatch('open-needs-you');
    dispatch('new-chat');
    dispatch('focus-composer');
    dispatch('open-session:vs_01J9-abc.def');
    dispatch('open-settings');

    expect(seen).toEqual([
      { kind: 'command', name: 'open-needs-you', commandId: 'needs-you.open' },
      { kind: 'command', name: 'new-chat', commandId: 'chat.new' },
      { kind: 'command', name: 'focus-composer', commandId: 'app.summon' },
      { kind: 'open-session', sessionId: 'vs_01J9-abc.def' },
      { kind: 'command', name: 'open-settings', commandId: 'section.settings' },
    ]);
    off();
  });

  it('drops junk, never guesses, and stops after unsubscribe', () => {
    const handler = vi.fn();
    const off = subscribeShellCommands(handler);
    for (const junk of ['open-session:', 'open-session:a b', 'open-session:x\nopen-settings', 'quit', 42, undefined]) dispatch(junk);
    window.dispatchEvent(new CustomEvent('ashlr:desktop-command'));
    expect(handler).not.toHaveBeenCalled();
    off();
    dispatch('new-chat');
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves the 3.9 menu-only subscription unchanged (it never sees tray commands)', () => {
    const legacy = vi.fn();
    const off = subscribeDesktopCommands(legacy);
    dispatch('open-needs-you');
    dispatch('open-session:vs_1');
    expect(legacy).not.toHaveBeenCalled();
    off();
  });
});

describe('desktop state — in a browser the bridge does nothing', () => {
  it('reports no state, sends no preference and never throws', () => {
    expect(getDesktopState()).toBeNull();
    expect(setDesktopPreference('globalHotkey', true)).toBe(false);
    expect(setDesktopPreference('notifications', false)).toBe(false);
    const { result } = renderHook(() => useDesktopState());
    expect(result.current).toBeNull();
  });

  it('ignores a desktop-state event whose shape is wrong', () => {
    const handler = vi.fn();
    subscribeDesktopState(handler);
    for (const bad of [
      null,
      {},
      { hotkey: STATE.hotkey },
      { ...STATE, notifications: { enabled: true, delivery: 'push' } },
      { ...STATE, hotkey: { ...STATE.hotkey, registered: 'yes' } },
      { ...STATE, hotkey: { ...STATE.hotkey, accelerator: 'x'.repeat(33) } },
      { ...STATE, hotkey: { ...STATE.hotkey, error: 'x'.repeat(301) } },
    ]) {
      window.dispatchEvent(new CustomEvent('ashlr:desktop-state', { detail: bad }));
      expect(isDesktopState(bad)).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(getDesktopState()).toBeNull();
  });
});

describe('desktop state — with a bridge', () => {
  it('reads the bridge, forwards only known boolean preferences, and survives a throwing bridge', () => {
    const setPreference = vi.fn(() => true);
    win.__ASHLR_DESKTOP__ = { getState: () => STATE, setPreference };
    expect(getDesktopState()).toEqual(STATE);

    expect(setDesktopPreference('globalHotkey', true)).toBe(true);
    expect(setPreference).toHaveBeenCalledWith('globalHotkey', true);
    expect(setDesktopPreference('accelerator' as never, true)).toBe(false);
    expect(setDesktopPreference('notifications', 'yes' as never)).toBe(false);
    expect(setPreference).toHaveBeenCalledTimes(1);

    win.__ASHLR_DESKTOP__ = {
      setPreference: () => {
        throw new Error('ipc gone');
      },
    };
    expect(setDesktopPreference('notifications', false)).toBe(false);
  });

  it('re-renders the hook when native pushes a new state', () => {
    win.__ASHLR_DESKTOP__ = { getState: () => STATE };
    const { result } = renderHook(() => useDesktopState());
    expect(result.current?.hotkey.enabled).toBe(false);

    const taken: DesktopState = {
      ...STATE,
      hotkey: { enabled: true, registered: false, accelerator: '⌃⌥Space', error: 'Another app is already using ⌃⌥Space.' },
    };
    act(() => {
      window.dispatchEvent(new CustomEvent('ashlr:desktop-state', { detail: taken }));
    });
    expect(result.current).toEqual(taken);
    // A stable snapshot: reading again returns the same object.
    expect(getDesktopState()).toBe(result.current);
  });
});

/**
 * The REAL injected script (desktop/src-tauri/src/shell_contract.js), run in
 * jsdom with a fake Tauri IPC. Proves the page half above and the native half
 * agree on names, payloads and events — not just that each half is
 * self-consistent.
 */
describe('shell_contract.js ⇄ desktop-shell.ts', () => {
  const SHELL_JS = readFileSync(resolve(process.cwd(), 'desktop/src-tauri/src/shell_contract.js'), 'utf8');

  function inject(desktop: DesktopState | null): ReturnType<typeof vi.fn> {
    const invoke = vi.fn();
    win.__TAURI_INTERNALS__ = { invoke };
    const cfg = {
      origin: window.location.origin,
      platform: 'macos',
      version: '0.1.0',
      titlebarHeight: 48,
      trafficLightInset: 92,
      tokens: null,
      desktop,
    };
    new Function(`var __ASHLR_SHELL_CONFIG = ${JSON.stringify(cfg)};\n${SHELL_JS}`)();
    return invoke;
  }

  it('asks native for fresh state on load and exposes the creation-time copy', () => {
    const invoke = inject(STATE);
    expect(invoke).toHaveBeenCalledWith('plugin:event|emit', { event: 'shell-state-request', payload: null });
    expect(isDesktopShell()).toBe(true);
    expect(getDesktopState()).toEqual(STATE);
  });

  it('sends a preference as the strict shell-prefs payload native parses', () => {
    const invoke = inject(STATE);
    invoke.mockClear();
    expect(setDesktopPreference('globalHotkey', true)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:event|emit', { event: 'shell-prefs', payload: { globalHotkey: true } });
    invoke.mockClear();
    // The injected half refuses what the Rust parser would refuse, too.
    const bridge = win.__ASHLR_DESKTOP__!;
    expect(bridge.setPreference!('accelerator', true)).toBe(false);
    expect(bridge.setPreference!('notifications', 'no' as never)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('delivers a native state push to the hook, as a copy the page cannot edit', () => {
    inject(null);
    const { result } = renderHook(() => useDesktopState());
    expect(result.current).toBeNull();
    const next: DesktopState = { ...STATE, notifications: { enabled: false, delivery: 'native' } };
    act(() => win.__ASHLR_DESKTOP_STATE__!(next));
    expect(result.current).toEqual(next);
    (win.__ASHLR_DESKTOP__!.getState!() as DesktopState).notifications.enabled = true;
    expect((win.__ASHLR_DESKTOP__!.getState!() as DesktopState).notifications.enabled).toBe(false);
  });

  it('routes a native command (what the tray and a clicked banner eval) to subscribeShellCommands', () => {
    inject(null);
    const seen: unknown[] = [];
    const off = subscribeShellCommands((c) => seen.push(c));
    win.__ASHLR_DESKTOP_COMMAND__!('open-session:vs_42');
    win.__ASHLR_DESKTOP_COMMAND__!('open-needs-you');
    expect(seen).toEqual([
      { kind: 'open-session', sessionId: 'vs_42' },
      { kind: 'command', name: 'open-needs-you', commandId: 'needs-you.open' },
    ]);
    off();
  });

  it('does nothing on any other origin', () => {
    const invoke = vi.fn();
    win.__TAURI_INTERNALS__ = { invoke };
    const cfg = { origin: 'http://127.0.0.1:1', platform: 'macos', version: '0', titlebarHeight: 48, trafficLightInset: 92, tokens: null, desktop: STATE };
    new Function(`var __ASHLR_SHELL_CONFIG = ${JSON.stringify(cfg)};\n${SHELL_JS}`)();
    expect(win.__ASHLR_DESKTOP__).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the global hotkey agrees across native and the catalog', () => {
  const HOTKEY_RS = readFileSync(resolve(process.cwd(), 'desktop/src-tauri/src/hotkey.rs'), 'utf8');
  const constant = (name: string): string | undefined =>
    new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(HOTKEY_RS)?.[1];

  it('registers exactly the chord app.summon declares, and prints it the same way', () => {
    const summon = findCommand('app.summon')!;
    expect(summon.native?.kind).toBe('global-hotkey');
    expect(constant('SUMMON_ACCELERATOR')).toBe(summon.native!.accelerator);
    expect(constant('SUMMON_DISPLAY')).toBe(formatChord(summon.keys[0]!, 'mac'));
  });
});

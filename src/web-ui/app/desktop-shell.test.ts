import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDesktopShell,
  reportThemeToShell,
  resolveTheme,
  subscribeDesktopCommands,
  type DesktopCommand,
} from './desktop-shell.js';

type Bridge = { reportTheme?: (theme: 'light' | 'dark') => void };
const win = window as unknown as { __ASHLR_DESKTOP__?: Bridge };

afterEach(() => {
  document.documentElement.removeAttribute('data-app-shell');
  delete win.__ASHLR_DESKTOP__;
  vi.unstubAllGlobals();
});

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

/**
 * Tests for src/cli/open.ts
 *
 * Focus: the editor deep-link URL must be properly percent-encoded so paths
 * containing spaces and reserved URI characters (e.g. "Keys & Recovery",
 * "Rent Application.pdf") produce a valid URL rather than a garbled one — and
 * it must do so identically on any host OS.
 *
 * The pure deep-link cases are platform-agnostic. Launcher-shape cases fully
 * mock child_process so no application is opened while the Windows shell-free
 * boundary is exercised on every CI host.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launcherMocks = vi.hoisted(() => ({
  once: vi.fn(),
  spawn: vi.fn(),
  unref: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({
  realpathNative: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: launcherMocks.spawn,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mockedRealpathSync = Object.assign(
    (...args: unknown[]) => fsMocks.realpathNative(...args),
    { native: fsMocks.realpathNative },
  );
  return {
    ...actual,
    realpathSync: mockedRealpathSync,
    statSync: fsMocks.statSync,
  };
});

import {
  editorDeepLink,
  openInEditor,
  openInFinder,
  openInTerminal,
} from '../src/cli/open.js';
import type { AshlrConfig } from '../src/core/types.js';
import { withPlatform } from './helpers/platform.js';

type MockFsKind = 'directory' | 'file' | 'other';
type ChildEvent = 'error' | 'spawn';
let childListeners: Partial<Record<ChildEvent, (...args: unknown[]) => void>> = {};
let childMock: { once: typeof launcherMocks.once; unref: typeof launcherMocks.unref };

function installWindowsFs(extra: Record<string, MockFsKind> = {}): void {
  const entries = new Map<string, MockFsKind>(Object.entries({
    'C:\\Windows': 'directory' as const,
    'C:\\Windows\\explorer.exe': 'file' as const,
    'C:\\Windows\\System32\\cmd.exe': 'file' as const,
    'C:\\Windows\\System32\\rundll32.exe': 'file' as const,
    'C:\\Windows\\System32\\url.dll': 'file' as const,
    ...extra,
  }).map(([path, kind]) => [path.toLowerCase(), kind]));

  fsMocks.realpathNative.mockImplementation((path: unknown) => {
    const value = String(path).replace(/\//g, '\\');
    if (!entries.has(value.toLowerCase())) throw new Error('ENOENT');
    return value;
  });
  fsMocks.statSync.mockImplementation((path: unknown) => {
    const kind = entries.get(String(path).replace(/\//g, '\\').toLowerCase());
    if (!kind) throw new Error('ENOENT');
    return {
      isDirectory: () => kind === 'directory',
      isFile: () => kind === 'file',
    };
  });
}

function withSystemRoot<T>(value: string | undefined, fn: () => T): T {
  const original = process.env['SystemRoot'];
  if (value === undefined) delete process.env['SystemRoot'];
  else process.env['SystemRoot'] = value;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (original === undefined) delete process.env['SystemRoot'];
    else process.env['SystemRoot'] = original;
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

beforeEach(() => {
  launcherMocks.once.mockReset();
  launcherMocks.spawn.mockReset();
  launcherMocks.unref.mockReset();
  fsMocks.realpathNative.mockReset();
  fsMocks.statSync.mockReset();
  childListeners = {};
  childMock = {
    once: launcherMocks.once,
    unref: launcherMocks.unref,
  };
  launcherMocks.once.mockImplementation((event: ChildEvent, listener: (...args: unknown[]) => void) => {
    childListeners[event] = listener;
    return childMock;
  });
  launcherMocks.spawn.mockImplementation(() => {
    queueMicrotask(() => childListeners.spawn?.());
    return childMock;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('editorDeepLink — deep link URL encoding', () => {
  it('percent-encodes spaces in the path (cursor)', () => {
    const url = editorDeepLink('/Users/m/Desktop/Rent Application.pdf', 'cursor');
    expect(url).toBe('cursor://file/Users/m/Desktop/Rent%20Application.pdf');
    expect(url).not.toContain(' ');
  });

  it('percent-encodes ampersands and spaces (cursor)', () => {
    const url = editorDeepLink('/Users/m/Desktop/Keys & Recovery', 'cursor');
    expect(url).toBe('cursor://file/Users/m/Desktop/Keys%20%26%20Recovery');
    expect(url).not.toContain(' ');
    // The reserved '&' must be escaped.
    expect(url).not.toMatch(/[^%]&/);
  });

  it('percent-encodes for vscode too and preserves path separators', () => {
    const url = editorDeepLink('/Users/m/Desktop/tts agents', 'vscode');
    expect(url).toBe('vscode://file/Users/m/Desktop/tts%20agents');
    expect(url.startsWith('vscode://file/Users/m/Desktop/')).toBe(true);
  });

  it('leaves a plain path with no special chars unchanged in shape', () => {
    const url = editorDeepLink('/Users/m/Desktop/github/dev-tools/ashlr-hub', 'cursor');
    expect(url).toBe('cursor://file/Users/m/Desktop/github/dev-tools/ashlr-hub');
  });

  it('builds a valid URL from a Windows path: backslashes → slashes, drive colon preserved', () => {
    const url = editorDeepLink('C:\\Users\\m\\Desktop\\Rent Application.pdf', 'vscode');
    // Leading slash before the drive, literal "C:", encoded space, no backslashes.
    expect(url).toBe('vscode://file/C:/Users/m/Desktop/Rent%20Application.pdf');
    expect(url).not.toContain('\\');
    expect(url).not.toContain('%5C');
    expect(url).not.toContain('%3A'); // drive colon must stay literal
  });

  it('encodes reserved chars in a Windows path segment', () => {
    const url = editorDeepLink('C:\\Users\\m\\Keys & Recovery', 'cursor');
    expect(url).toBe('cursor://file/C:/Users/m/Keys%20%26%20Recovery');
  });

  it('encodes shell metacharacters that are not valid URI path data', () => {
    const url = editorDeepLink('C:\\repo\\quote"&|<>^% value', 'vscode');
    expect(url).toBe('vscode://file/C:/repo/quote%22%26%7C%3C%3E%5E%25%20value');
    expect(url).not.toMatch(/["&|<>^ ]/);
  });
});

describe('Windows launcher command shapes', () => {
  const cfg = { editor: 'cursor' } as AshlrConfig;

  it('opens an encoded editor URI through a fixed handler without cmd.exe or a shell', async () => {
    installWindowsFs();
    const dispatched = await withPlatform('win32', () => {
      return withSystemRoot('C:\\Windows', () =>
        openInEditor('C:\\repo\\quote" & calc & file.ts', cfg));
    });

    expect(dispatched).toBe(true);
    expect(launcherMocks.spawn).toHaveBeenCalledOnce();
    expect(launcherMocks.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\rundll32.exe',
      [
        'C:\\Windows\\System32\\url.dll,FileProtocolHandler',
        'cursor://file/C:/repo/quote%22%20%26%20calc%20%26%20file.ts',
      ],
      { detached: true, shell: false, stdio: 'ignore' },
    );
    expect(launcherMocks.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(launcherMocks.unref).toHaveBeenCalledOnce();
  });

  it('passes a Finder target as one inert Explorer argv value', async () => {
    installWindowsFs();
    const target = 'C:\\repo\\safe & inert';
    const dispatched = await withPlatform('win32', () => {
      return withSystemRoot('C:\\Windows', () => openInFinder(target));
    });

    expect(dispatched).toBe(true);
    expect(launcherMocks.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\explorer.exe',
      [target],
      { detached: true, shell: false, stdio: 'ignore' },
    );
  });

  it('sets terminal cwd structurally and never interpolates the path into cmd input', async () => {
    const target = 'C:\\repo\\safe & inert';
    installWindowsFs({ [target]: 'directory' });
    const dispatched = await withPlatform('win32', () => {
      return withSystemRoot('C:\\Windows', () => openInTerminal(target));
    });

    expect(dispatched).toBe(true);
    expect(launcherMocks.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/v:off', '/s', '/c', 'start "" "C:\\Windows\\System32\\cmd.exe" /d /k'],
      { cwd: target, detached: true, shell: false, stdio: 'ignore' },
    );
    const [, args, options] = launcherMocks.spawn.mock.calls[0] ?? [];
    expect(args).not.toContain(target);
    expect(options).toMatchObject({ cwd: target });
  });

  it('uses the canonical parent directory for an existing file named cmd.exe', async () => {
    const planted = 'C:\\repo\\cmd.exe';
    installWindowsFs({
      'C:\\repo': 'directory',
      [planted]: 'file',
    });

    const dispatched = await withPlatform('win32', () =>
      withSystemRoot('C:\\Windows', () => openInTerminal(planted)));

    expect(dispatched).toBe(true);
    expect(launcherMocks.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/v:off', '/s', '/c', 'start "" "C:\\Windows\\System32\\cmd.exe" /d /k'],
      { cwd: 'C:\\repo', detached: true, shell: false, stdio: 'ignore' },
    );
  });

  it.each([
    undefined,
    'Windows',
    '\\Windows',
    '\\\\server\\Windows',
    ' C:\\Windows',
    'C:\\Temp',
    'C:\\foo%PATH%\\Windows',
    'C:\\Windows\\..\\Windows',
  ])('fails closed for a missing or malformed SystemRoot: %s', async (systemRoot) => {
    installWindowsFs();
    const dispatched = await withPlatform('win32', () =>
      withSystemRoot(systemRoot, () => openInEditor('C:\\repo\\file.ts', cfg)));

    expect(dispatched).toBe(false);
    expect(launcherMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects an absolute nested Windows SystemRoot even when a full fake tree exists', async () => {
    installWindowsFs({
      'C:\\repo\\Windows': 'directory',
      'C:\\repo\\Windows\\explorer.exe': 'file',
      'C:\\repo\\Windows\\System32\\cmd.exe': 'file',
      'C:\\repo\\Windows\\System32\\rundll32.exe': 'file',
      'C:\\repo\\Windows\\System32\\url.dll': 'file',
    });
    const dispatched = await withPlatform('win32', () =>
      withSystemRoot('C:\\repo\\Windows', () => openInFinder('C:\\repo')));

    expect(dispatched).toBe(false);
    expect(launcherMocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['C:\\repo\\missing', {}],
    ['C:\\repo\\device', { 'C:\\repo\\device': 'other' as const }],
    ['\\repo\\root-relative', { '\\repo\\root-relative': 'directory' as const }],
  ])('refuses a terminal target without an existing canonical directory: %s', async (target, extra) => {
    installWindowsFs(extra);
    const dispatched = await withPlatform('win32', () =>
      withSystemRoot('C:\\Windows', () => openInTerminal(target)));

    expect(dispatched).toBe(false);
    expect(launcherMocks.spawn).not.toHaveBeenCalled();
  });

  it('returns false when spawn throws synchronously', async () => {
    installWindowsFs();
    launcherMocks.spawn.mockImplementationOnce(() => { throw new Error('ENOENT'); });

    const dispatched = await withPlatform('win32', () =>
      withSystemRoot('C:\\Windows', () => openInEditor('C:\\repo\\file.ts', cfg)));

    expect(dispatched).toBe(false);
  });

  it('returns false when error arrives before spawn', async () => {
    installWindowsFs();
    launcherMocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        childListeners.error?.(new Error('ENOENT'));
        childListeners.spawn?.();
      });
      return childMock;
    });

    const dispatched = await withPlatform('win32', () =>
      withSystemRoot('C:\\Windows', () => openInEditor('C:\\repo\\file.ts', cfg)));

    expect(dispatched).toBe(false);
  });

  it('settles true once when spawn arrives before a later error', async () => {
    installWindowsFs();
    launcherMocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        childListeners.spawn?.();
        childListeners.error?.(new Error('late failure'));
      });
      return childMock;
    });

    const dispatched = await withPlatform('win32', () =>
      withSystemRoot('C:\\Windows', () => openInEditor('C:\\repo\\file.ts', cfg)));

    expect(dispatched).toBe(true);
  });
});

/**
 * folder-picker.test.ts — the picker degrades honestly.
 *
 * The bundle that runs inside the Tauri shell is the SAME bundle `ashlr verse`
 * serves to a plain browser, so the two cases that matter most are "no shell
 * at all" and "shell present but the answer is junk". Both must end in `null`
 * and neither may throw: NewChatDialog falls back to its text input on `null`,
 * and an exception would take the dialog down with it.
 *
 * The Tauri IPC *global* is stubbed here, not the plugin module — there is no
 * plugin module to stub (the web UI calls `plugin:dialog|open` directly), and
 * stubbing at the global keeps the normalisation in folder-picker.ts inside the
 * test rather than outside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativePickerAvailable, pickDirectory } from './folder-picker.js';

type InvokeStub = (command: string, args?: unknown) => unknown;

interface StubbedGlobals {
  __TAURI_INTERNALS__?: { invoke?: unknown };
  __TAURI__?: { core?: { invoke?: unknown } };
}

function globals(): StubbedGlobals {
  return globalThis as unknown as StubbedGlobals;
}

/** Pretend we are inside the Tauri shell, with `invoke` answering `answer`. */
function installShell(invoke: InvokeStub): void {
  globals().__TAURI_INTERNALS__ = { invoke };
}

/** Pretend the shell returns exactly this value from `plugin:dialog|open`. */
function shellReturning(answer: unknown) {
  const invoke = vi.fn((_command: string, _args?: unknown): unknown => Promise.resolve(answer));
  installShell(invoke);
  return invoke;
}

afterEach(() => {
  delete globals().__TAURI_INTERNALS__;
  delete globals().__TAURI__;
});

describe('outside the Tauri shell', () => {
  it('reports no native picker and resolves null without throwing', async () => {
    // jsdom has no Tauri globals — this is the plain-browser case verbatim.
    expect(globals().__TAURI_INTERNALS__).toBeUndefined();
    expect(nativePickerAvailable()).toBe(false);
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it('is not fooled by a global that exists but carries no invoke', () => {
    globals().__TAURI_INTERNALS__ = {};
    expect(nativePickerAvailable()).toBe(false);

    globals().__TAURI_INTERNALS__ = { invoke: 'not a function' };
    expect(nativePickerAvailable()).toBe(false);
  });

  it('probes at call time, so a late-injected shell is still found', () => {
    expect(nativePickerAvailable()).toBe(false);
    shellReturning('/Users/me/project');
    expect(nativePickerAvailable()).toBe(true);
  });
});

describe('inside the Tauri shell', () => {
  it('asks the dialog plugin for a single directory', async () => {
    const invoke = shellReturning('/Users/me/project');
    expect(nativePickerAvailable()).toBe(true);
    await expect(pickDirectory()).resolves.toBe('/Users/me/project');

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe('plugin:dialog|open');
    const options = (args as { options: Record<string, unknown> }).options;
    expect(options.directory).toBe(true);
    expect(options.multiple).toBe(false);
  });

  it('treats a cancelled chooser as null', async () => {
    shellReturning(null);
    await expect(pickDirectory()).resolves.toBeNull();
    shellReturning(undefined);
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it('falls back to the caller when the shell rejects the command', async () => {
    // What an ungranted `dialog:allow-open` looks like from the page.
    installShell(() => Promise.reject(new Error('dialog.open not allowed')));
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it('survives an invoke that throws synchronously', async () => {
    installShell(() => {
      throw new Error('bridge torn down');
    });
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it('works through the withGlobalTauri bridge too', async () => {
    globals().__TAURI__ = { core: { invoke: () => Promise.resolve('/srv/app') } };
    expect(nativePickerAvailable()).toBe(true);
    await expect(pickDirectory()).resolves.toBe('/srv/app');
  });
});

describe('normalising what the plugin returns', () => {
  it('unwraps an array even though multiple is false', async () => {
    shellReturning(['/Users/me/project', '/Users/me/other']);
    await expect(pickDirectory()).resolves.toBe('/Users/me/project');
  });

  it('unwraps a FileResponse-style object', async () => {
    shellReturning({ path: '/Users/me/project' });
    await expect(pickDirectory()).resolves.toBe('/Users/me/project');

    shellReturning([{ path: '/Users/me/project' }]);
    await expect(pickDirectory()).resolves.toBe('/Users/me/project');
  });

  it('decodes a file:// URL into a plain path', async () => {
    shellReturning('file:///Users/me/my%20project');
    await expect(pickDirectory()).resolves.toBe('/Users/me/my project');
  });

  it('keeps Windows paths absolute, from a drive letter or a file URL', async () => {
    shellReturning('C:\\Users\\me\\project');
    await expect(pickDirectory()).resolves.toBe('C:\\Users\\me\\project');

    shellReturning('file:///C:/Users/me/project');
    await expect(pickDirectory()).resolves.toBe('C:/Users/me/project');

    shellReturning('\\\\server\\share\\project');
    await expect(pickDirectory()).resolves.toBe('\\\\server\\share\\project');
  });

  it('trims surrounding whitespace', async () => {
    shellReturning('  /Users/me/project  ');
    await expect(pickDirectory()).resolves.toBe('/Users/me/project');
  });

  it('rejects malformed answers rather than handing back half a path', async () => {
    const malformed: unknown[] = [
      42, // not a path at all
      true,
      [], // an empty array is not a selection
      {}, // an object with no path
      { path: 7 },
      '', // an empty string
      '   ',
      'relative/path', // not absolute — would resolve against the server's cwd
      './project',
      '~/project', // the shell does not expand this for us
      'https://example.com/project', // a URL, but not a local folder
      'file:///bad/%zz/escape', // a malformed percent-escape
      '/Users/me/pro\0ject', // a NUL would truncate the path downstream
      [[[[['/Users/me/too/deep']]]]], // beyond the unwrap depth cap
    ];

    for (const answer of malformed) {
      shellReturning(answer);
      await expect(pickDirectory()).resolves.toBeNull();
    }
  });
});

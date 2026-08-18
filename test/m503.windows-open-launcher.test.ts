/**
 * M503 — Windows desktop launcher trust boundary.
 *
 * Runs only on a real Windows host. Graphical child_process calls are mocked,
 * while one bounded noninteractive cmd.exe case exercises the exact hosted
 * parser shape selected by diagnostic evidence. The suite verifies the host's
 * actual SystemRoot files, canonical target resolution, and shell-free spawn
 * boundary without opening a GUI. Manual GUI acceptance on a supported Windows
 * desktop remains required before claiming the terminal experience is usable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';

const launcherMocks = vi.hoisted(() => ({
  once: vi.fn(),
  realSpawn: undefined as typeof import('node:child_process').spawn | undefined,
  spawn: vi.fn(),
  unref: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  launcherMocks.realSpawn = actual.spawn;
  return { ...actual, spawn: launcherMocks.spawn };
});

import { openInEditor, openInTerminal } from '../src/cli/open.js';
import type { AshlrConfig } from '../src/core/types.js';

const onWindows = process.platform === 'win32';
const suite = describe.runIf(onWindows);
const SELECTED_SHAPE_LIMIT_MS = 4_000;
const EXACT_KILL_LIMIT_MS = 1_000;
let fixtureDir = '';
let plantedFile = '';
let childListeners: Partial<Record<'error' | 'spawn', (...args: unknown[]) => void>> = {};

function childClosed(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopExactChild(child: ChildProcess): Promise<void> {
  if (childClosed(child)) return;
  const closed = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), EXACT_KILL_LIMIT_MS);
    child.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  child.kill();
  if (!(await closed) && !childClosed(child)) {
    throw new Error(`selected-shape outer cmd PID ${child.pid ?? 'unknown'} did not close`);
  }
}

suite('real Windows launcher resolution', () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'ashlr-win-open-'));
    plantedFile = join(fixtureDir, 'cmd.exe');
    writeFileSync(plantedFile, 'not a launcher', { encoding: 'utf8', mode: 0o600 });
  });

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    launcherMocks.once.mockReset();
    launcherMocks.spawn.mockReset();
    launcherMocks.unref.mockReset();
    childListeners = {};
    const child = {
      once: launcherMocks.once,
      unref: launcherMocks.unref,
    };
    launcherMocks.once.mockImplementation((event, listener) => {
      childListeners[event as 'error' | 'spawn'] = listener;
      return child;
    });
    launcherMocks.spawn.mockImplementation(() => {
      queueMicrotask(() => childListeners.spawn?.());
      return child;
    });
  });

  it('resolves the URL launcher and handler from the host SystemRoot', async () => {
    const systemRoot = realpathSync.native(process.env['SystemRoot'] ?? '');
    const expectedRundll32 = realpathSync.native(join(systemRoot, 'System32', 'rundll32.exe'));
    const expectedUrlDll = realpathSync.native(join(systemRoot, 'System32', 'url.dll'));

    const dispatched = await openInEditor(fixtureDir, { editor: 'cursor' } as AshlrConfig);

    expect(dispatched).toBe(true);
    const [executable, args, options] = launcherMocks.spawn.mock.calls[0] ?? [];
    expect(String(executable).toLowerCase()).toBe(expectedRundll32.toLowerCase());
    expect(args?.[0]?.toLowerCase()).toBe(`${expectedUrlDll},FileProtocolHandler`.toLowerCase());
    expect(win32.isAbsolute(String(executable))).toBe(true);
    expect(options).toMatchObject({ detached: true, shell: false, stdio: 'ignore' });
  });

  it('uses the canonical parent of a planted cmd.exe only as cwd', async () => {
    const systemRoot = realpathSync.native(process.env['SystemRoot'] ?? '');
    const expectedCmd = realpathSync.native(join(systemRoot, 'System32', 'cmd.exe'));
    const expectedCwd = realpathSync.native(fixtureDir);

    const dispatched = await openInTerminal(plantedFile);

    expect(dispatched).toBe(true);
    expect(launcherMocks.spawn).toHaveBeenCalledWith(
      expectedCmd,
      ['/d', '/v:off', '/s', '/c', `"start "" "${expectedCmd}" /d /k"`],
      {
        cwd: expectedCwd,
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      },
    );
    expect(JSON.stringify(launcherMocks.spawn.mock.calls[0]?.[1])).not.toContain(plantedFile);
  });

  it(
    'parses the selected explicit outer-quoted START shape without opening a GUI',
    async () => {
      const id = randomUUID();
      const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), `ashlr-m503-selected-${id}-`)));
      const sentinelName = 'node-canonical.txt';
      const sentinelPath = join(cwd, sentinelName);
      let child: ChildProcess | undefined;
      let primaryFailure: unknown;
      let cleanupFailure: unknown;

      try {
        const realSpawn = launcherMocks.realSpawn;
        if (!realSpawn) throw new Error('real child_process.spawn was not captured');
        const systemRoot = realpathSync.native(process.env['SystemRoot'] ?? '');
        const cmd = realpathSync.native(join(systemRoot, 'System32', 'cmd.exe'));
        const startCommand = `start "" /b "${cmd}" /d /c "echo ${id}>${sentinelName}"`;

        child = realSpawn(cmd, ['/d', '/v:off', '/s', '/c', `"${startCommand}"`], {
          cwd,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        const closeCode = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('selected-shape parser acceptance timed out')),
            SELECTED_SHAPE_LIMIT_MS,
          );
          child?.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child?.once('close', (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });

        expect(closeCode).toBe(0);
        expect(readFileSync(sentinelPath, 'utf8').trim()).toBe(id);
      } catch (error) {
        primaryFailure = error;
      } finally {
        try {
          if (child) await stopExactChild(child);
        } catch (error) {
          cleanupFailure = error;
        }
        try {
          rmSync(cwd, { recursive: true, force: true });
          if (existsSync(cwd) && cleanupFailure === undefined) {
            cleanupFailure = new Error('selected-shape cwd still exists after cleanup');
          }
        } catch (error) {
          if (cleanupFailure === undefined) cleanupFailure = error;
        }
      }

      if (primaryFailure !== undefined) {
        if (primaryFailure instanceof Error && cleanupFailure !== undefined) {
          Object.defineProperty(primaryFailure, 'cleanupError', {
            configurable: true,
            enumerable: false,
            value: cleanupFailure,
          });
        }
        throw primaryFailure;
      }
      if (cleanupFailure !== undefined) throw cleanupFailure;
    },
    SELECTED_SHAPE_LIMIT_MS + EXACT_KILL_LIMIT_MS + 1_000,
  );

  it('fails closed for a nonexistent terminal target', async () => {
    expect(await openInTerminal(join(fixtureDir, 'missing'))).toBe(false);
    expect(launcherMocks.spawn).not.toHaveBeenCalled();
  });
});

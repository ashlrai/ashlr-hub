/**
 * M503 — Windows desktop launcher trust boundary.
 *
 * Runs only on a real Windows host. child_process is mocked, so CI never opens
 * an interactive application; the suite verifies the host's actual SystemRoot
 * files, canonical target resolution, and exact shell-free spawn boundary.
 * UI activation itself is intentionally not claimed by M503. Manual GUI
 * acceptance on a supported Windows desktop remains required before claiming
 * the interactive terminal experience is usable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const launcherMocks = vi.hoisted(() => ({
  once: vi.fn(),
  spawn: vi.fn(),
  unref: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: launcherMocks.spawn };
});

import { openInEditor, openInTerminal } from '../src/cli/open.js';
import type { AshlrConfig } from '../src/core/types.js';

const onWindows = process.platform === 'win32';
const suite = describe.runIf(onWindows);
let fixtureDir = '';
let plantedFile = '';
let childListeners: Partial<Record<'error' | 'spawn', (...args: unknown[]) => void>> = {};

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
      ['/d', '/v:off', '/s', '/c', `start "" "${expectedCmd}" /d /k`],
      { cwd: expectedCwd, detached: true, shell: false, stdio: 'ignore' },
    );
    expect(JSON.stringify(launcherMocks.spawn.mock.calls[0]?.[1])).not.toContain(plantedFile);
  });

  it('fails closed for a nonexistent terminal target', async () => {
    expect(await openInTerminal(join(fixtureDir, 'missing'))).toBe(false);
    expect(launcherMocks.spawn).not.toHaveBeenCalled();
  });

  it('probes the real cmd/start argv parser without opening an interactive window', async () => {
    const systemRoot = realpathSync.native(process.env['SystemRoot'] ?? '');
    const expectedCmd = realpathSync.native(join(systemRoot, 'System32', 'cmd.exe'));
    const sentinelName = 'm503-parser-sentinel.txt';
    const sentinelPath = join(fixtureDir, sentinelName);
    const sentinelContent = 'ashlr-m503-parser-ok';
    rmSync(sentinelPath, { force: true });

    // Keep the production parser boundary (`start "" "<canonical cmd>" /d`)
    // while replacing its persistent `/k` child with a bounded `/c` command.
    // `/wait` is deliberately absent: hosted cmd.exe can retain the nested
    // console lifecycle indefinitely. The fixed relative sentinel proves the
    // nested child actually parsed and ran; no fixture path enters command text.
    const probe = `start "" /b "${expectedCmd}" /d /c "echo ${sentinelContent}>${sentinelName}"`;

    const result = spawnSync(
      expectedCmd,
      ['/d', '/v:off', '/s', '/c', probe],
      {
        cwd: realpathSync.native(fixtureDir),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    const deadline = Date.now() + 5_000;
    let observedContent = '';
    while (observedContent !== sentinelContent && Date.now() < deadline) {
      try {
        observedContent = readFileSync(sentinelPath, 'utf8').trim();
      } catch {
        observedContent = '';
      }
      if (observedContent === sentinelContent) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(observedContent).toBe(sentinelContent);
  });
});

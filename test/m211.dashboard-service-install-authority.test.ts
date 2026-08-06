import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-dashboard-authority-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('dashboard resident service production authority', () => {
  it('refuses direct installation before filesystem or launchctl effects', async () => {
    const runCmd = vi.fn();
    const { installServeAgent } = await import('../src/cli/dashboard.js');

    expect(() => installServeAgent({ homeDir: home, _runCmd: runCmd }))
      .toThrow('resident service install/reinstall/repair/restart authority is unavailable');
    expect(runCmd).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses the default macOS dashboard path before install or browser effects', async () => {
    if (process.platform !== 'darwin') return;
    const runCmd = vi.fn();
    const openBrowser = vi.fn(async () => {});
    const { cmdDashboard, plistPath } = await import('../src/cli/dashboard.js');
    const code = await cmdDashboard([], {
      _runCmd: runCmd,
      _openBrowser: openBrowser,
      _queryServeService: () => ({
        registrationState: 'absent',
        installed: false,
        running: false,
        plistPath: plistPath(home),
      }),
    });

    expect(code).toBe(1);
    expect(runCmd).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import * as childProcess from 'node:child_process';
import * as service from '../src/core/daemon/service.js';

const execFileSyncMock = childProcess.execFileSync as ReturnType<typeof vi.fn>;
const spawnSyncMock = childProcess.spawnSync as ReturnType<typeof vi.fn>;
let home: string;

beforeEach(() => {
  vi.clearAllMocks();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-service-install-authority-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('daemon service production install authority', () => {
  it.each([
    { platform: 'darwin' as const, autostart: true },
    { platform: 'darwin' as const, autostart: false },
    { platform: 'linux' as const, autostart: true },
    { platform: 'linux' as const, autostart: false },
    { platform: 'win32' as const, autostart: true },
    { platform: 'win32' as const, autostart: false },
  ])('refuses $platform autostart=$autostart before any mutation', async ({ platform, autostart }) => {
    await expect(service.install({
      platform,
      autostart,
      homeDir: home,
      nodePath: process.execPath,
      binPath: path.join(home, 'bin', 'ashlr'),
    })).rejects.toThrow(
      'resident service install/reinstall/repair/restart authority is unavailable',
    );

    expect(fs.readdirSync(home)).toEqual([]);
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not export a production-callable install bypass', () => {
    expect(Object.keys(service).filter((name) => /install.*verification|verification.*install/iu.test(name)))
      .toEqual([]);
  });

  it.each(['darwin', 'linux', 'win32'] as const)(
    'refuses ensureRunning on %s before status, locks, or process effects',
    async (platform) => {
      await expect(service.ensureRunning({
        platform,
        homeDir: home,
        nodePath: process.execPath,
        binPath: path.join(home, 'bin', 'ashlr'),
      })).rejects.toThrow(
        'resident service install/reinstall/repair/restart authority is unavailable',
      );

      expect(fs.readdirSync(home)).toEqual([]);
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    },
  );

  it('keeps serviceStatus available with the real deny-only authority module', () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('is-active')) {
        return { status: 1, stdout: 'inactive\n', stderr: '', error: undefined };
      }
      if (args.includes('is-enabled')) {
        return { status: 1, stdout: 'not-found\n', stderr: '', error: undefined };
      }
      return { status: 1, stdout: '', stderr: 'unexpected query', error: undefined };
    });

    expect(service.serviceStatus({ platform: 'linux', homeDir: home })).toMatchObject({
      registrationState: 'absent',
      installed: false,
      running: false,
      platformSpec: 'systemd',
    });
  });

  it('keeps uninstall available with the real deny-only authority module', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('is-active')) {
        return { status: 1, stdout: 'inactive\n', stderr: '', error: undefined };
      }
      if (args.includes('is-enabled')) {
        return { status: 1, stdout: 'not-found\n', stderr: '', error: undefined };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });

    await expect(service.uninstall({ platform: 'linux', homeDir: home })).resolves.toBeUndefined();
  });
});

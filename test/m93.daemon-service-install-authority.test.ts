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
// M470: assertResidentServiceInstallAuthorized() now consults an operator-owned
// authority store under the real os.homedir(). Isolate HOME/USERPROFILE for
// every test in this file so "no authority granted" stays the actual default
// under test, independent of whatever real trust roots/grants this machine's
// operator may have registered via `ashlr activation init` / `grant install`.
const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];

beforeEach(() => {
  vi.clearAllMocks();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-service-install-authority-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * M470: assertResidentServiceInstallAuthorized() now writes an audit row on
 * every denial (that's the whole point — an operator must be able to answer
 * "who tried this, when"). So a refusal legitimately creates ~/.ashlr/audit/.
 * This asserts NO service/config/daemon state was touched — only the audit
 * trail — which is a strictly more precise check than "nothing at all".
 */
function expectOnlyAuditTrailWritten(homeDir: string): void {
  const entries = fs.readdirSync(homeDir);
  expect(entries.filter((e) => e !== '.ashlr')).toEqual([]);
  if (!entries.includes('.ashlr')) return;
  expect(fs.readdirSync(path.join(homeDir, '.ashlr'))).toEqual(['audit']);
}

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

    expectOnlyAuditTrailWritten(home);
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
      }      )).rejects.toThrow(
        'resident service install/reinstall/repair/restart authority is unavailable',
      );

      expectOnlyAuditTrailWritten(home);
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

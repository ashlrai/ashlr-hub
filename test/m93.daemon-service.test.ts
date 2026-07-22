/**
 * M93 — DaemonServiceManager tests
 *
 * WHAT IS TESTED (pure/generation layer only — no real OS side effects):
 *  1. generateServiceDefinition() — launchd plist XML structure
 *  2. generateServiceDefinition() — systemd unit file structure
 *  3. generateServiceDefinition() — schtasks command string structure
 *  4. install() / uninstall() — child_process mock assertions per platform
 *  5. serviceStatus() — mocked spawnSync output parsed correctly, never throws
 *
 * SAFETY:
 *  - HOME is redirected to a tmp dir so no real ~/.ashlr or LaunchAgents are touched.
 *  - spawnSync is mocked at the module level — no real OS commands run.
 *  - fs.writeFileSync / fs.mkdirSync / fs.existsSync / fs.copyFileSync / fs.unlinkSync
 *    are stubbed in install/uninstall tests to prevent disk side effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

const installLaunchdPlistTransactionMock = vi.hoisted(() => vi.fn());
const removeLaunchdPlistTransactionMock = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// We import the module AFTER setting up vi.mock so spawnSync is interceptable
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('../src/core/daemon/launchd-plist-transaction.js', () => ({
  installLaunchdPlistTransaction: installLaunchdPlistTransactionMock,
  removeLaunchdPlistTransaction: removeLaunchdPlistTransactionMock,
}));

import * as cp from 'node:child_process';
import {
  ensureRunning,
  generateServiceDefinition,
  install,
  uninstall,
  serviceStatus,
} from '../src/core/daemon/service.js';
import { daemonServiceInstallOptions } from '../src/core/daemon/service-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_HOME = '/tmp/ashlr-test-home';
const FAKE_NODE = '/usr/local/bin/node';
const FAKE_BIN = '/home/user/ashlr-hub/bin/ashlr';

function baseOpts(platform: 'darwin' | 'linux' | 'win32') {
  return {
    platform,
    homeDir: FAKE_HOME,
    nodePath: FAKE_NODE,
    binPath: FAKE_BIN,
    budget: 5,
    intervalMs: 1_800_000,
    parallel: 1,
  };
}

function useSuccessfulLaunchdTransactionMock(): void {
  installLaunchdPlistTransactionMock.mockImplementation((options: {
    unload: () => unknown;
    load: () => { ok: boolean; stderr: string };
  }) => {
    options.unload();
    const loaded = options.load();
    if (!loaded.ok) throw new Error(`launchctl load failed: ${loaded.stderr}`);
  });
}

describe('daemonServiceInstallOptions', () => {
  it('uses responsive effective daemon defaults when config omits interval and parallel', () => {
    expect(daemonServiceInstallOptions({ daemon: { dailyBudgetUsd: 5 } })).toMatchObject({
      budget: 5,
      intervalMs: 300_000,
      parallel: 1,
    });
  });

  it('honors configured daemon budget, interval, and parallelism', () => {
    expect(daemonServiceInstallOptions({
      daemon: {
        dailyBudgetUsd: 7,
        intervalMs: 45_000,
        parallel: 3,
      },
    })).toMatchObject({
      budget: 7,
      intervalMs: 45_000,
      parallel: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// 1. launchd plist generation
// ---------------------------------------------------------------------------

describe('generateServiceDefinition — darwin (launchd)', () => {
  it('produces a valid plist file path under ~/Library/LaunchAgents', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.filePath).toBe(
      path.join(FAKE_HOME, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist'),
    );
  });

  it('plist content is well-formed XML with correct Label', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.content).toContain('<?xml version="1.0"');
    expect(def.content).toContain('<!DOCTYPE plist');
    expect(def.content).toContain('<string>ai.ashlr.daemon</string>');
  });

  it('plist contains node executable path', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.content).toContain(`<string>${FAKE_NODE}</string>`);
  });

  it('plist contains bin/ashlr path', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.content).toContain(`<string>${FAKE_BIN}</string>`);
  });

  it('plist contains daemon start args', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.content).toContain('<string>daemon</string>');
    expect(def.content).toContain('<string>start</string>');
    expect(def.content).toContain('<string>--budget</string>');
    expect(def.content).toContain('<string>5</string>');
    expect(def.content).toContain('<string>--interval</string>');
    expect(def.content).toContain('<string>1800000</string>');
    expect(def.content).toContain('<string>--parallel</string>');
    expect(def.content).toContain('<string>1</string>');
  });

  it('plist contains log paths under CONFIG_DIR', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    const configDir = path.join(FAKE_HOME, '.ashlr');
    expect(def.content).toContain(path.join(configDir, 'daemon.launchd.out.log'));
    expect(def.content).toContain(path.join(configDir, 'daemon.launchd.err.log'));
  });

  it('plist has RunAtLoad true and KeepAlive with SuccessfulExit false', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.content).toContain('<key>RunAtLoad</key>');
    expect(def.content).toContain('<true/>');
    expect(def.content).toContain('<key>KeepAlive</key>');
    expect(def.content).toContain('<key>SuccessfulExit</key>');
    expect(def.content).toContain('<false/>');
  });

  it('plist crash restart throttle is independent from daemon work interval', () => {
    const def = generateServiceDefinition({
      ...baseOpts('darwin'),
      intervalMs: 1_800_000,
    });
    expect(def.content).toContain('<key>ThrottleInterval</key>');
    expect(def.content).toContain('<integer>30</integer>');
    expect(def.content).toContain('<string>1800000</string>');
    expect(def.content).not.toContain('<integer>1800</integer>');
  });

  it('plist honors custom restartSec with a 5s minimum', () => {
    const custom = generateServiceDefinition({ ...baseOpts('darwin'), restartSec: 12 });
    expect(custom.content).toContain('<integer>12</integer>');

    const clamped = generateServiceDefinition({ ...baseOpts('darwin'), restartSec: 1 });
    expect(clamped.content).toContain('<integer>5</integer>');
  });

  it('plist PATH env includes common developer tool bins', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.content).toContain(path.join(FAKE_HOME, '.local', 'bin'));
    expect(def.content).toContain(path.join(FAKE_HOME, '.cargo', 'bin'));
    expect(def.content).toContain(path.join(FAKE_HOME, '.bun', 'bin'));
    expect(def.content).toContain('/opt/homebrew/bin');
  });

  it('registerArgs uses launchctl load', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.registerArgs[0]).toBe('launchctl');
    expect(def.registerArgs[1]).toBe('load');
    expect(def.registerArgs[2]).toBe(def.filePath);
  });

  it('unregisterArgs uses launchctl unload', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.unregisterArgs[0]).toBe('launchctl');
    expect(def.unregisterArgs[1]).toBe('unload');
  });
});

// ---------------------------------------------------------------------------
// 2. systemd unit generation
// ---------------------------------------------------------------------------

describe('generateServiceDefinition — linux (systemd)', () => {
  it('produces a valid unit file path under ~/.config/systemd/user/', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.filePath).toBe(
      path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service'),
    );
  });

  it('unit has [Unit], [Service], [Install] sections', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.content).toContain('[Unit]');
    expect(def.content).toContain('[Service]');
    expect(def.content).toContain('[Install]');
  });

  it('unit ExecStart contains node path + bin/ashlr + daemon start args', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.content).toContain(`ExecStart=${FAKE_NODE} ${FAKE_BIN} daemon start`);
    expect(def.content).toContain('--budget 5');
    expect(def.content).toContain('--interval 1800000');
    expect(def.content).toContain('--parallel 1');
  });

  it('unit has Restart=always', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.content).toContain('Restart=always');
  });

  it('unit RestartSec is independent from daemon work interval', () => {
    const def = generateServiceDefinition({
      ...baseOpts('linux'),
      intervalMs: 1_800_000,
    });
    expect(def.content).toContain('RestartSec=30');
    expect(def.content).toContain('--interval 1800000');
    expect(def.content).not.toContain('RestartSec=1800');
  });

  it('unit honors custom restartSec with a 5s minimum', () => {
    const custom = generateServiceDefinition({ ...baseOpts('linux'), restartSec: 9 });
    expect(custom.content).toContain('RestartSec=9');

    const clamped = generateServiceDefinition({ ...baseOpts('linux'), restartSec: 0 });
    expect(clamped.content).toContain('RestartSec=5');
  });

  it('unit WantedBy=default.target', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.content).toContain('WantedBy=default.target');
  });

  it('unit HOME env is set', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.content).toContain(`Environment=HOME=${FAKE_HOME}`);
  });

  it('unit PATH env includes common developer tool bins', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.content).toContain(`Environment=PATH=${path.join(FAKE_HOME, '.local', 'bin')}`);
    expect(def.content).toContain(path.join(FAKE_HOME, '.cargo', 'bin'));
    expect(def.content).toContain(path.join(FAKE_HOME, '.bun', 'bin'));
    expect(def.content).toContain('/opt/homebrew/bin');
  });

  it('unit log path under CONFIG_DIR', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    const configDir = path.join(FAKE_HOME, '.ashlr');
    expect(def.content).toContain(path.join(configDir, 'daemon.systemd.log'));
  });

  it('registerArgs uses systemctl --user enable --now', () => {
    const def = generateServiceDefinition(baseOpts('linux'));
    expect(def.registerArgs).toContain('systemctl');
    expect(def.registerArgs).toContain('--user');
    expect(def.registerArgs).toContain('enable');
    expect(def.registerArgs).toContain('--now');
    expect(def.registerArgs).toContain('ashlr-daemon');
  });
});

// ---------------------------------------------------------------------------
// 3. schtasks generation
// ---------------------------------------------------------------------------

describe('generateServiceDefinition — win32 (schtasks)', () => {
  it('produces a file path in AppData/Roaming Startup folder', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    expect(def.filePath).toContain('AppData');
    expect(def.filePath).toContain('Startup');
    expect(def.filePath.endsWith('ashlr-daemon.cmd')).toBe(true);
  });

  it('cmd content contains node path + bin/ashlr + daemon start args', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    expect(def.content).toContain(FAKE_NODE);
    expect(def.content).toContain(FAKE_BIN);
    expect(def.content).toContain('daemon start');
    expect(def.content).toContain('--budget 5');
    expect(def.content).toContain('--interval 1800000');
    expect(def.content).toContain('--parallel 1');
  });

  it('registerArgs uses schtasks /Create with /TN AshlrDaemon', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    expect(def.registerArgs[0]).toBe('schtasks');
    expect(def.registerArgs).toContain('/Create');
    expect(def.registerArgs).toContain('AshlrDaemon');
    expect(def.registerArgs).toContain('ONLOGON');
  });

  it('registerArgs TR contains node path + bin + daemon start', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    const trIdx = def.registerArgs.indexOf('/TR');
    expect(trIdx).toBeGreaterThan(-1);
    const tr = def.registerArgs[trIdx + 1];
    expect(tr).toContain(FAKE_NODE);
    expect(tr).toContain(FAKE_BIN);
    expect(tr).toContain('daemon start');
  });

  it('unregisterArgs uses schtasks /Delete /TN AshlrDaemon', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    expect(def.unregisterArgs[0]).toBe('schtasks');
    expect(def.unregisterArgs).toContain('/Delete');
    expect(def.unregisterArgs).toContain('AshlrDaemon');
  });
});

// ---------------------------------------------------------------------------
// 4. install() — child_process mock assertions
// ---------------------------------------------------------------------------

describe('install() — mocked spawnSync', () => {
  const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
  const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    useSuccessfulLaunchdTransactionMock();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '', error: undefined });
    existsSyncMock.mockReturnValue(false);
  });

  it('darwin: calls launchctl unload then launchctl load', async () => {
    await install(baseOpts('darwin'));
    const calls = spawnSyncMock.mock.calls.map((c: string[]) => c[0] + ' ' + (c[1] as string[]).join(' '));
    const hasUnload = calls.some((c: string) => c.includes('launchctl') && c.includes('unload'));
    const hasLoad = calls.some((c: string) => c.includes('launchctl') && c.includes('load'));
    expect(hasUnload).toBe(true);
    expect(hasLoad).toBe(true);
  });

  it('darwin: enables the launchd label before loading an autostart service', async () => {
    await install(baseOpts('darwin'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('enable'))).toBe(true);
  });

  it('darwin: launchctl load receives the plist file path', async () => {
    await install(baseOpts('darwin'));
    const loadCall = spawnSyncMock.mock.calls.find(
      (c: [string, string[]]) => c[0] === 'launchctl' && (c[1] as string[]).includes('load'),
    );
    expect(loadCall).toBeDefined();
    const plistPath = path.join(FAKE_HOME, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist');
    expect((loadCall as [string, string[]])[1]).toContain(plistPath);
  });

  it('darwin: autostart false unloads an existing job without loading the replacement', async () => {
    await install({ ...baseOpts('darwin'), autostart: false });
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('unload'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('disable'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('load'))).toBe(false);
  });

  it('darwin: treats launchctl zero-exit error output as a load failure', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('load')
        ? { status: 0, stdout: '', stderr: 'Load failed: 5: Input/output error', error: undefined }
        : { status: 0, stdout: '', stderr: '', error: undefined });

    await expect(install(baseOpts('darwin'))).rejects.toThrow(
      'launchctl load failed: Load failed: 5: Input/output error',
    );
  });

  it('linux: calls systemctl --user daemon-reload then enable --now', async () => {
    await install(baseOpts('linux'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasReload = calls.some((c) => c[0] === 'systemctl' && c[1].includes('daemon-reload'));
    const hasEnable = calls.some((c) => c[0] === 'systemctl' && c[1].includes('enable'));
    expect(hasReload).toBe(true);
    expect(hasEnable).toBe(true);
  });

  it('linux: does not throw when systemctl returns non-zero (best-effort)', async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', error: undefined });
    await expect(install(baseOpts('linux'))).resolves.not.toThrow();
  });

  it('linux: autostart false disables an existing unit without enabling it', async () => {
    await install({ ...baseOpts('linux'), autostart: false });
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) => cmd === 'systemctl' && args.includes('disable') && args.includes('--now'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'systemctl' && args.includes('enable'))).toBe(false);
  });

  it('win32: calls schtasks /Create', async () => {
    await install(baseOpts('win32'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasCreate = calls.some((c) => c[0] === 'schtasks' && c[1].includes('/Create'));
    expect(hasCreate).toBe(true);
  });

  it('win32: does not throw when schtasks returns non-zero (best-effort)', async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'access denied', error: undefined });
    await expect(install(baseOpts('win32'))).resolves.not.toThrow();
  });

  it('win32: autostart false deletes an existing task without creating one', async () => {
    await install({ ...baseOpts('win32'), autostart: false });
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) => cmd === 'schtasks' && args.includes('/Delete'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'schtasks' && args.includes('/Create'))).toBe(false);
  });
});

describe('install() — transactional launchd plist', () => {
  it('delegates the daemon plist and private lock directory to the shared transaction', async () => {
    const home = '/tmp/ashlr-launchd-transaction';
    useSuccessfulLaunchdTransactionMock();
    (cp.spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({ status: 0, stdout: '', stderr: '' });

    await install({ ...baseOpts('darwin'), homeDir: home });

    expect(installLaunchdPlistTransactionMock).toHaveBeenCalledWith(expect.objectContaining({
      plistPath: path.join(home, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist'),
      lockDir: path.join(home, '.ashlr', 'locks'),
      content: expect.stringContaining('<string>ai.ashlr.daemon</string>'),
      unload: expect.any(Function),
      load: expect.any(Function),
    }));
  });
});

// ---------------------------------------------------------------------------
// 5. uninstall() — child_process mock assertions
// ---------------------------------------------------------------------------

describe('uninstall() — mocked spawnSync', () => {
  const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
  const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '', error: undefined });
    existsSyncMock.mockReturnValue(true);
    removeLaunchdPlistTransactionMock.mockImplementation((options: {
      unload: () => { ok: boolean };
      plistPath: string;
    }) => {
      const unloaded = options.unload();
      if (!unloaded.ok) throw new Error('unload failed; plist retained');
      fs.unlinkSync(options.plistPath);
    });
  });

  it('darwin: calls launchctl unload', async () => {
    await uninstall(baseOpts('darwin'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasUnload = calls.some((c) => c[0] === 'launchctl' && c[1].includes('unload'));
    expect(hasUnload).toBe(true);
  });

  it('linux: calls systemctl --user disable --now', async () => {
    await uninstall(baseOpts('linux'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasDisable = calls.some((c) => c[0] === 'systemctl' && c[1].includes('disable'));
    expect(hasDisable).toBe(true);
  });

  it('win32: calls schtasks /Delete /TN AshlrDaemon', async () => {
    await uninstall(baseOpts('win32'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasDelete = calls.some((c) => c[0] === 'schtasks' && c[1].includes('/Delete'));
    expect(hasDelete).toBe(true);
  });

  it('removes the service file when it exists', async () => {
    const unlinkMock = fs.unlinkSync as ReturnType<typeof vi.fn>;
    await uninstall(baseOpts('darwin'));
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('darwin: retains the service file after a false-zero unload failure', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('unload')
        ? { status: 0, stdout: '', stderr: 'Unload failed: 5: Input/output error', error: undefined }
        : { status: 0, stdout: '', stderr: '', error: undefined });
    const unlinkMock = fs.unlinkSync as ReturnType<typeof vi.fn>;

    await expect(uninstall(baseOpts('darwin'))).resolves.toBeUndefined();
    expect(unlinkMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. serviceStatus() — mocked spawnSync output parsing, never throws
// ---------------------------------------------------------------------------

describe('serviceStatus() — mocked OS query output', () => {
  const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
  const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('darwin: running=true when launchctl list returns PID', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '{\n\t"PID" = 12345;\n\t"Label" = "ai.ashlr.daemon";\n}',
      stderr: '',
    });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.installed).toBe(true);
    expect(s.running).toBe(true);
    expect(s.platformSpec).toBe('launchd');
  });

  it('darwin: running=false when launchctl list shows PID = 0', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '{\n\t"PID" = 0;\n}',
      stderr: '',
    });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.running).toBe(false);
    expect(s.platformSpec).toBe('launchd');
  });

  it('darwin: running=false when launchctl list has no PID after a clean exit', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '{\n\t"Label" = "ai.ashlr.daemon";\n\t"LastExitStatus" = 0;\n}',
      stderr: '',
    });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.running).toBe(false);
    expect(s.platformSpec).toBe('launchd');
  });

  it('darwin: running=false when launchctl exits non-zero', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'Could not find service' });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.running).toBe(false);
    expect(s.installed).toBe(false);
  });

  it('linux: running=true when systemctl is-active returns "active"', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'active\n', stderr: '' });
    const s = serviceStatus(baseOpts('linux'));
    expect(s.running).toBe(true);
    expect(s.platformSpec).toBe('systemd');
  });

  it('linux: running=false when systemctl is-active returns "inactive"', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 3, stdout: 'inactive\n', stderr: '' });
    const s = serviceStatus(baseOpts('linux'));
    expect(s.running).toBe(false);
    expect(s.platformSpec).toBe('systemd');
  });

  it('win32: running=true when schtasks /Query output contains AshlrDaemon', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '"AshlrDaemon","Ready","N/A"\r\n',
      stderr: '',
    });
    const s = serviceStatus(baseOpts('win32'));
    expect(s.running).toBe(true);
    expect(s.platformSpec).toBe('schtasks');
  });

  it('win32: running=false when schtasks /Query exits non-zero', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'ERROR: not found' });
    const s = serviceStatus(baseOpts('win32'));
    expect(s.running).toBe(false);
    expect(s.installed).toBe(false);
  });

  it('never throws when spawnSync throws', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockImplementation(() => { throw new Error('spawn failed'); });
    expect(() => serviceStatus(baseOpts('darwin'))).not.toThrow();
    expect(() => serviceStatus(baseOpts('linux'))).not.toThrow();
    expect(() => serviceStatus(baseOpts('win32'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. ensureRunning() — installed service activation without reinstalling
// ---------------------------------------------------------------------------

describe('ensureRunning() — mocked OS activation', () => {
  const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
  const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  it('darwin: kickstarts an installed launchd job that has no PID', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: '{\n\t"Label" = "ai.ashlr.daemon";\n\t"LastExitStatus" = 0;\n}',
        stderr: '',
      })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: '{\n\t"PID" = 12345;\n\t"Label" = "ai.ashlr.daemon";\n}',
        stderr: '',
      });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status.running).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'launchctl',
      ['kickstart', '-k', expect.stringMatching(/^gui\/\d+\/ai\.ashlr\.daemon$/)],
      expect.objectContaining({ encoding: 'utf8', timeout: 15_000 }),
    );
  });

  it('darwin: does not kickstart when launchd already has a PID', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: '{\n\t"PID" = 12345;\n\t"Label" = "ai.ashlr.daemon";\n}',
      stderr: '',
    });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status.running).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('linux: starts an inactive installed user unit', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 3, stdout: 'inactive\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'active\n', stderr: '' });

    const status = await ensureRunning(baseOpts('linux'));

    expect(status.running).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'start', 'ashlr-daemon'],
      expect.objectContaining({ encoding: 'utf8', timeout: 15_000 }),
    );
  });

  it('win32: runs an installed scheduled task when stopped', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not running' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '"AshlrDaemon","Ready","N/A"\r\n', stderr: '' });

    const status = await ensureRunning(baseOpts('win32'));

    expect(status.running).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'schtasks',
      ['/Run', '/TN', 'AshlrDaemon'],
      expect.objectContaining({ encoding: 'utf8', timeout: 15_000 }),
    );
  });

  it('does not start when the service is not installed', async () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'Could not find service' });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});

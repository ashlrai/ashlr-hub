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
const withServiceFileTransactionLockMock = vi.hoisted(() =>
  vi.fn((_options: unknown, action: () => unknown) => action()));

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
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(() => 99),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('../src/core/daemon/launchd-plist-transaction.js', () => ({
  installLaunchdPlistTransaction: installLaunchdPlistTransactionMock,
  removeLaunchdPlistTransaction: removeLaunchdPlistTransactionMock,
  withServiceFileTransactionLock: withServiceFileTransactionLockMock,
}));

vi.mock('../src/core/util/durability.js', () => ({
  fsyncDirectory: vi.fn(),
}));

vi.mock('../src/core/daemon/service-install-authority.js', () => ({
  assertResidentServiceInstallAuthorized: vi.fn(),
}));

import * as cp from 'node:child_process';
import {
  ensureRunning,
  generateServiceDefinition,
  install,
  uninstall,
  serviceStatus,
} from '../src/core/daemon/service.js';
import { fsyncDirectory } from '../src/core/util/durability.js';
import { daemonServiceInstallOptions } from '../src/core/daemon/service-config.js';
import {
  buildWindowsTaskCreateScript,
  buildWindowsTaskRestoreScript,
  buildWindowsTaskRunScript,
  buildWindowsTaskSnapshotScript,
  buildWindowsTaskStopDeleteScript,
  windowsPowerShellPath,
} from '../src/core/daemon/windows-task-scripts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_HOME = '/tmp/ashlr-test-home';
const FAKE_NODE = '/usr/local/bin/node';
const FAKE_BIN = '/home/user/ashlr-hub/bin/ashlr';

function isWindowsPowerShellCommand(command: string): boolean {
  return command === windowsPowerShellPath();
}

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
    operationLabel?: string;
    preflight?: (state: { hasPrior: boolean }) => { ok: boolean; stderr: string };
    unload: () => { ok: boolean; stderr: string };
    load: () => { ok: boolean; stderr: string };
    verify?: () => { ok: boolean; stderr: string };
  }) => {
    const unloadLabel = options.operationLabel ? `${options.operationLabel} transaction unload` : 'launchctl unload';
    const loadLabel = options.operationLabel ? `${options.operationLabel} transaction activation` : 'launchctl load';
    const preflight = options.preflight?.({ hasPrior: true });
    if (preflight && !preflight.ok) throw new Error(`launchd transaction preflight failed: ${preflight.stderr}`);
    const unloaded = options.unload();
    if (!unloaded.ok) throw new Error(`${unloadLabel} failed: ${unloaded.stderr}`);
    const loaded = options.load();
    if (!loaded.ok) throw new Error(`${loadLabel} failed: ${loaded.stderr}`);
    const verified = options.verify?.();
    if (verified && !verified.ok) throw new Error(`service final verification failed: ${verified.stderr}`);
  });
}

function launchctlPrintDisabledFixture(disabled: boolean): string {
  return [
    '',
    '\tdisabled services = {',
    '\t\t"com.docker.helper" => enabled',
    '\t\t"ai.ashlr.fleet" => disabled',
    `\t\t"ai.ashlr.daemon" => ${disabled ? 'disabled' : 'enabled'}`,
    '\t}',
    '',
  ].join('\n');
}

function windowsTaskSnapshotFixture(state: string): string {
  return JSON.stringify({
    state,
    taskXmlBase64: Buffer.from('<Task version="1.4">prior</Task>', 'utf8').toString('base64'),
    taskSecurityDescriptorBase64: Buffer.from('D:P(A;;FA;;;SY)', 'utf8').toString('base64'),
  });
}

function successfulServiceCommands() {
  let launchdLoaded = true;
  let launchdDisabled = false;
  let systemdActive = false;
  let systemdEnabled = false;
  let windowsTaskExists = false;
  let windowsTaskState = '3';
  return (cmd: string, args: string[]) => {
    if (cmd === 'launchctl') {
      if (args[0] === 'print-disabled') {
        return {
          status: 0,
          stdout: launchctlPrintDisabledFixture(launchdDisabled),
          stderr: '',
          error: undefined,
        };
      }
      if (args[0] === 'print') {
        return launchdLoaded
          ? { status: 0, stdout: '{ "PID" = 123; }', stderr: '', error: undefined }
          : { status: 113, stdout: '', stderr: 'Could not find service', error: undefined };
      }
      if (args[0] === 'bootout') launchdLoaded = false;
      if (args[0] === 'bootstrap') launchdLoaded = true;
      if (args[0] === 'disable') launchdDisabled = true;
      if (args[0] === 'enable') launchdDisabled = false;
      return { status: 0, stdout: '', stderr: '', error: undefined };
    }
    if (cmd === '/bin/kill') {
      return { status: 1, stdout: '', stderr: 'kill: 123: No such process', error: undefined };
    }
    if (cmd === 'systemctl') {
      if (args.includes('enable')) { systemdEnabled = true; systemdActive = true; }
      if (args.includes('disable')) { systemdEnabled = false; systemdActive = false; }
      if (args.includes('is-active')) {
        return systemdActive
          ? { status: 0, stdout: 'active\n', stderr: '', error: undefined }
          : { status: 3, stdout: 'inactive\n', stderr: '', error: undefined };
      }
      if (args.includes('is-enabled')) {
        return systemdEnabled
          ? { status: 0, stdout: 'enabled\n', stderr: '', error: undefined }
          : { status: 1, stdout: 'disabled\n', stderr: '', error: undefined };
      }
      if (args.includes('show')) {
        return {
          status: 0,
          stdout: `${path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service')}\n`,
          stderr: '',
          error: undefined,
        };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    }
    if (isWindowsPowerShellCommand(cmd)) {
      if (args.join(' ').includes('$folder.RegisterTaskDefinition($taskName,$definition')) {
        windowsTaskExists = true;
        windowsTaskState = '3';
        return { status: 0, stdout: 'created', stderr: '', error: undefined };
      }
      if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
        windowsTaskExists = false;
        return { status: 0, stdout: 'deleted', stderr: '', error: undefined };
      }
      if (args.join(' ').includes('$registered.Run($null)')) {
        windowsTaskState = '4';
        return { status: 0, stdout: 'started', stderr: '', error: undefined };
      }
      if (args.join(' ').includes(".RegisterTask('AshlrDaemon'")) {
        windowsTaskExists = true;
        windowsTaskState = '3';
        return { status: 0, stdout: 'restored', stderr: '', error: undefined };
      }
      return {
        status: 0,
        stdout: windowsTaskExists
          ? (args.join(' ').includes('GetSecurityDescriptor(7)')
              ? windowsTaskSnapshotFixture(windowsTaskState)
              : windowsTaskState)
          : 'absent',
        stderr: '',
        error: undefined,
      };
    }
    if (cmd === 'schtasks') {
      if (args.includes('/Create')) { windowsTaskExists = true; windowsTaskState = '3'; }
      if (args.includes('/Run')) windowsTaskState = '4';
      if (args.includes('/End')) windowsTaskState = '3';
      if (args.includes('/DISABLE')) windowsTaskState = '1';
      if (args.includes('/Delete')) windowsTaskExists = false;
      return { status: 0, stdout: '', stderr: '', error: undefined };
    }
    return { status: 0, stdout: '', stderr: '', error: undefined };
  };
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

describe('strict Windows Task Scheduler scripts', () => {
  const taskName = 'AshlrM93Integration-deadbeef';

  it('creates a non-overwriting, unlimited, single-instance task with a protected DACL', () => {
    const script = buildWindowsTaskCreateScript(taskName);

    expect(script).toContain("$trigger.ExecutionTimeLimit='PT0S'");
    expect(script).toContain("$settings.ExecutionTimeLimit='PT0S'");
    expect(script).toContain('$settings.MultipleInstances=2');
    expect(script).toContain('$settings.AllowDemandStart=$true');
    expect(script).toContain('$settings.DisallowStartIfOnBatteries=$false');
    expect(script).toContain('$settings.StopIfGoingOnBatteries=$false');
    expect(script).toContain("$settings.IdleSettings.IdleDuration='PT10M'");
    expect(script).toContain("$settings.IdleSettings.WaitTimeout='PT1H'");
    expect(script).toContain('$definition.RegistrationInfo.SecurityDescriptor=$sddl');
    expect(script).toContain('$flags=2 -bor 16 -bor 32');
    expect(script).toContain('D:P(A;;FA;;;SY)(A;;FA;;;BA)');
    expect(script).not.toContain('/F');
  });

  it('applies exact XML and DACL admission to every task lifecycle operation', () => {
    const scripts = [
      buildWindowsTaskCreateScript(taskName),
      buildWindowsTaskSnapshotScript(taskName),
      buildWindowsTaskRestoreScript(taskName),
      buildWindowsTaskStopDeleteScript(taskName),
      buildWindowsTaskRunScript(taskName),
    ];

    for (const script of scripts) {
      expect(script).toContain('Assert-AshlrTaskXml $definition');
      expect(script).toContain('Assert-AshlrTaskSecurityDescriptor');
      expect(script).toContain('Assert-AshlrTaskSecurityBinding');
      expect(script).toContain("task multiple-instance policy is not IgnoreNew");
      expect(script).toContain("task execution limit is not unlimited");
      expect(script).toContain("task idle defaults are not exact");
      expect(script).toContain("task failure restart policy is not exact");
      expect(script).toContain("RestartCount -ne 3");
      expect(script).toContain("RestartInterval -cne 'PT1M'");
      expect(script).toContain('task registration security descriptor');
      expect(script).toContain("untrusted identity can modify the task");
      expect(script).not.toContain('/Task/Principals/Principal/RequiredPrivileges');
      expect(script).not.toContain('/Task/Principals/Principal/ProcessTokenSidType');
    }
  });

  it('rejects task names outside production and the disposable native-test namespace', () => {
    expect(() => buildWindowsTaskCreateScript('AshlrDaemon')).not.toThrow();
    expect(() => buildWindowsTaskCreateScript('OtherTask')).toThrow(
      'unsupported Task Scheduler task name',
    );
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
    expect(def.launchdRuntime).toMatchObject({
      program: FAKE_NODE,
      arguments: [
        FAKE_NODE,
        FAKE_BIN,
        'daemon',
        'start',
        '--budget',
        '5',
        '--interval',
        '1800000',
        '--parallel',
        '1',
      ],
      environment: { HOME: FAKE_HOME },
      supervisor: {
        runAtLoad: true,
        keepAliveSuccessfulExit: false,
        throttleIntervalSec: 30,
      },
    });
    expect(Object.keys(def.launchdRuntime!.environment).sort()).toEqual(['HOME', 'PATH']);
    expect(def.launchdRuntime!.supervisor).toEqual({
      processType: 'Background',
      runAtLoad: true,
      keepAliveSuccessfulExit: false,
      throttleIntervalSec: 30,
      standardOutPath: path.join(FAKE_HOME, '.ashlr', 'daemon.launchd.out.log'),
      standardErrorPath: path.join(FAKE_HOME, '.ashlr', 'daemon.launchd.err.log'),
    });
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

  it('binds keepAwake launchd authority to caffeinate and the complete argv', () => {
    const def = generateServiceDefinition({ ...baseOpts('darwin'), keepAwake: true });
    expect(def.launchdRuntime).toMatchObject({
      program: 'caffeinate',
      arguments: [
        'caffeinate',
        '-i',
        '-s',
        FAKE_NODE,
        FAKE_BIN,
        'daemon',
        'start',
        '--budget',
        '5',
        '--interval',
        '1800000',
        '--parallel',
        '1',
      ],
      environment: { HOME: FAKE_HOME },
      supervisor: {
        runAtLoad: true,
        keepAliveSuccessfulExit: false,
        throttleIntervalSec: 30,
      },
    });
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

  it('plist honors custom restartSec within the 5s to 1h supervisor bound', () => {
    const custom = generateServiceDefinition({ ...baseOpts('darwin'), restartSec: 12 });
    expect(custom.content).toContain('<integer>12</integer>');

    const clamped = generateServiceDefinition({ ...baseOpts('darwin'), restartSec: 1 });
    expect(clamped.content).toContain('<integer>5</integer>');

    const bounded = generateServiceDefinition({ ...baseOpts('darwin'), restartSec: 10_000 });
    expect(bounded.content).toContain('<integer>3600</integer>');
    expect(bounded.launchdRuntime?.supervisor.throttleIntervalSec).toBe(3_600);
  });

  it('plist PATH env includes common developer tool bins', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.content).toContain(path.join(FAKE_HOME, '.local', 'bin'));
    expect(def.content).toContain(path.join(FAKE_HOME, '.cargo', 'bin'));
    expect(def.content).toContain(path.join(FAKE_HOME, '.bun', 'bin'));
    expect(def.content).toContain('/opt/homebrew/bin');
  });

  it('registerArgs uses launchctl bootstrap with an argv-only plist path', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.registerArgs[0]).toBe('launchctl');
    expect(def.registerArgs[1]).toBe('bootstrap');
    expect(def.registerArgs.at(-1)).toBe(def.filePath);
  });

  it('unregisterArgs uses launchctl bootout', () => {
    const def = generateServiceDefinition(baseOpts('darwin'));
    expect(def.unregisterArgs[0]).toBe('launchctl');
    expect(def.unregisterArgs[1]).toBe('bootout');
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
  it('keeps the launcher outside the Windows Startup folder', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    expect(def.filePath).toBe(path.join(FAKE_HOME, '.ashlr', 'services', 'ashlr-daemon.cmd'));
    expect(def.filePath).not.toContain('Startup');
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
    expect(def.registerArgs).toContain('/IT');
    expect(def.registerArgs).not.toContain('/F');
  });

  it('registerArgs TR invokes the launcher outside Startup', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    const trIdx = def.registerArgs.indexOf('/TR');
    expect(trIdx).toBeGreaterThan(-1);
    const tr = def.registerArgs[trIdx + 1];
    expect(tr).toBe(`"${path.join(FAKE_HOME, '.ashlr', 'services', 'ashlr-daemon.cmd')}"`);
    expect(tr).not.toContain('Startup');
  });

  it('uses a bounded Task Scheduler failure restart policy', () => {
    const script = buildWindowsTaskCreateScript('AshlrDaemon');
    expect(script).toContain('$settings.RestartCount=3');
    expect(script).toContain("$settings.RestartInterval='PT1M'");
    expect(script).not.toContain('$settings.RestartCount=0');
  });

  it('unregisterArgs uses schtasks /Delete /TN AshlrDaemon', () => {
    const def = generateServiceDefinition(baseOpts('win32'));
    expect(def.unregisterArgs[0]).toBe('schtasks');
    expect(def.unregisterArgs).toContain('/Delete');
    expect(def.unregisterArgs).toContain('AshlrDaemon');
  });
});

// ---------------------------------------------------------------------------
// 4. install transaction — child_process mock assertions
// ---------------------------------------------------------------------------

describe('install() — mocked spawnSync', () => {
  const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
  const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    useSuccessfulLaunchdTransactionMock();
    spawnSyncMock.mockImplementation(successfulServiceCommands());
    existsSyncMock.mockReturnValue(false);
    (fs.lstatSync as ReturnType<typeof vi.fn>).mockImplementation((candidate: fs.PathLike) => {
      const value = candidate.toString();
      if (value.endsWith('ashlr-daemon.cmd') || value.endsWith('ashlr-daemon.startup-legacy.cmd.disabled')) {
        throw Object.assign(new Error(`ENOENT: ${value}`), { code: 'ENOENT' });
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
        mode: 0o700,
        dev: 1,
        ino: 1,
        uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      } as fs.Stats;
    });
  });

  it('darwin: bootouts the old job then bootstraps the replacement', async () => {
    await install(baseOpts('darwin'));
    const calls = spawnSyncMock.mock.calls.map((c: string[]) => c[0] + ' ' + (c[1] as string[]).join(' '));
    const hasUnload = calls.some((c: string) => c.includes('launchctl') && c.includes('bootout'));
    const hasLoad = calls.some((c: string) => c.includes('launchctl') && c.includes('bootstrap'));
    expect(hasUnload).toBe(true);
    expect(hasLoad).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'launchctl',
      ['bootout', '--wait', expect.stringMatching(/^gui\/\d+\/ai\.ashlr\.daemon$/)],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/bin/kill',
      ['-0', '123'],
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('darwin: enables the launchd label before loading an autostart service', async () => {
    await install(baseOpts('darwin'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('enable'))).toBe(true);
  });

  it.each([
    ['fictional boolean', 'disabled services = {\n\t"ai.ashlr.daemon" => true\n}'],
    ['unknown token', 'disabled services = {\n\t"ai.ashlr.daemon" => maybe\n}'],
    ['missing label', 'disabled services = {\n\t"another.service" => enabled\n}'],
    ['duplicate label', 'disabled services = {\n\t"ai.ashlr.daemon" => enabled\n\t"ai.ashlr.daemon" => disabled\n}'],
  ])('darwin: print-disabled fails closed for %s output', async (_case, stdout) => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === 'launchctl' && args[0] === 'print-disabled'
        ? { status: 0, stdout, stderr: '', error: undefined }
        : normal(cmd, args));

    await expect(install(baseOpts('darwin'))).rejects.toThrow(
      'did not contain exactly one native state',
    );
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) => args.includes('bootout'))).toBe(false);
  });

  it('darwin: launchctl bootstrap receives the domain and plist path', async () => {
    await install(baseOpts('darwin'));
    const loadCall = spawnSyncMock.mock.calls.find(
      (c: [string, string[]]) => c[0] === 'launchctl' && (c[1] as string[]).includes('bootstrap'),
    );
    expect(loadCall).toBeDefined();
    const plistPath = path.join(FAKE_HOME, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist');
    expect((loadCall as [string, string[]])[1]).toContain(plistPath);
  });

  it('darwin: autostart false unloads an existing job without loading the replacement', async () => {
    await install({ ...baseOpts('darwin'), autostart: false });
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('bootout'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('disable'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('bootstrap'))).toBe(false);
    expect(calls.filter(([cmd, args]) => cmd === 'launchctl' && args.includes('print')).at(-1)?.[1]).toContain('print');
  });

  it('darwin: final no-autostart verification rejects a concurrent bootstrap', async () => {
    installLaunchdPlistTransactionMock.mockImplementation((options: {
      preflight: (state: { hasPrior: boolean }) => { ok: boolean };
      unload: () => { ok: boolean };
      load: () => { ok: boolean };
      verify: () => { ok: boolean; stderr: string };
      rollback: () => { ok: boolean };
    }) => {
      expect(options.preflight({ hasPrior: true }).ok).toBe(true);
      expect(options.unload().ok).toBe(true);
      expect(options.load().ok).toBe(true);
      spawnSyncMock('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, 'interloper.plist']);
      const verified = options.verify();
      expect(verified.ok).toBe(false);
      expect(verified.stderr).toContain('expected loaded=false disabled=true');
      expect(options.rollback().ok).toBe(true);
      throw new Error('service final verification failed; rollback complete');
    });
    spawnSyncMock.mockImplementation(successfulServiceCommands());

    await expect(install({ ...baseOpts('darwin'), autostart: false })).rejects.toThrow(
      'service final verification failed; rollback complete',
    );
  });

  it('darwin: accepts only an explicit absent result when bootout is idempotent', async () => {
    let disabled = false;
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'print-disabled') {
        return {
          status: 0,
          stdout: launchctlPrintDisabledFixture(disabled),
          stderr: '',
          error: undefined,
        };
      }
      if (args[0] === 'disable') {
        disabled = true;
        return { status: 0, stdout: '', stderr: '', error: undefined };
      }
      if (args[0] === 'bootout' || args[0] === 'print') {
        return { status: 113, stdout: '', stderr: 'Could not find service', error: undefined };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });

    await expect(install({ ...baseOpts('darwin'), autostart: false })).resolves.toBeUndefined();
  });

  it('darwin: treats launchctl zero-exit error output as a bootstrap failure', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      args.includes('bootstrap')
        ? { status: 0, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error', error: undefined }
        : normal(cmd, args));

    await expect(install(baseOpts('darwin'))).rejects.toThrow(
      'launchctl load failed: Bootstrap failed: 5: Input/output error',
    );
  });

  it('darwin: fails closed when bootout cannot prove the old job stopped', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      args.includes('bootout')
        ? { status: 5, stdout: '', stderr: 'Boot-out failed: permission denied', error: undefined }
        : normal(cmd, args));

    await expect(install(baseOpts('darwin'))).rejects.toThrow('launchctl unload failed');
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) => args.includes('bootstrap'))).toBe(false);
  });

  it('darwin: refuses bootstrap while the snapshotted PID is still alive', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === '/bin/kill'
        ? { status: 0, stdout: '', stderr: '', error: undefined }
        : normal(cmd, args));

    await expect(install(baseOpts('darwin'))).rejects.toThrow('prior launchd PID 123 remains alive');
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) => args.includes('bootstrap'))).toBe(false);
  });

  it('darwin: fails closed when bounded bootout --wait times out', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === 'launchctl' && args.includes('bootout')
        ? {
            status: null,
            stdout: '',
            stderr: '',
            error: Object.assign(new Error('spawnSync launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          }
        : normal(cmd, args));

    await expect(install(baseOpts('darwin'))).rejects.toThrow('ETIMEDOUT');
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) => args.includes('bootstrap'))).toBe(false);
  });

  it('darwin: rejects a loaded service without a trusted prior plist before mutation', async () => {
    installLaunchdPlistTransactionMock.mockImplementation((options: {
      preflight: (state: { hasPrior: boolean }) => { ok: boolean; stderr: string };
      unload: () => unknown;
      load: () => unknown;
    }) => {
      const preflight = options.preflight({ hasPrior: false });
      if (!preflight.ok) throw new Error(`launchd transaction preflight failed: ${preflight.stderr}`);
      options.unload();
      options.load();
    });

    await expect(install(baseOpts('darwin'))).rejects.toThrow(
      'without a trusted prior plist',
    );
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) => args.includes('bootout'))).toBe(false);
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) => args.includes('bootstrap'))).toBe(false);
  });

  it('darwin: rollback restores the prior loaded and disabled states exactly', async () => {
    installLaunchdPlistTransactionMock.mockImplementation((options: {
      preflight: (state: { hasPrior: boolean }) => { ok: boolean; stderr: string };
      unload: () => { ok: boolean; stderr: string };
      load: () => { ok: boolean; stderr: string };
      rollback: () => { ok: boolean; stderr: string };
    }) => {
      expect(options.preflight({ hasPrior: true }).ok).toBe(true);
      expect(options.unload().ok).toBe(true);
      expect(options.load().ok).toBe(false);
      expect(options.rollback().ok).toBe(true);
      throw new Error('replacement activation failed; rollback complete');
    });
    let loaded = true;
    let disabled = true;
    let bootstrapCount = 0;
    const activationCalls: string[] = [];
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'print') {
        return loaded
          ? { status: 0, stdout: '{ "PID" = 123; }', stderr: '', error: undefined }
          : { status: 113, stdout: '', stderr: 'Could not find service', error: undefined };
      }
      if (args[0] === 'print-disabled') {
        return {
          status: 0,
          stdout: launchctlPrintDisabledFixture(disabled),
          stderr: '',
          error: undefined,
        };
      }
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'enable') { disabled = false; activationCalls.push('enable'); }
      if (args[0] === 'disable') { disabled = true; activationCalls.push('disable'); }
      if (args[0] === 'bootstrap') {
        activationCalls.push('bootstrap');
        bootstrapCount++;
        if (bootstrapCount === 1) {
          return { status: 5, stdout: '', stderr: 'new plist rejected', error: undefined };
        }
        loaded = true;
      }
      if (cmd === '/bin/kill') {
        return { status: 1, stdout: '', stderr: 'No such process', error: undefined };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });

    await expect(install(baseOpts('darwin'))).rejects.toThrow('rollback complete');
    expect(loaded).toBe(true);
    expect(disabled).toBe(true);
    expect(bootstrapCount).toBe(2);
    expect(activationCalls).toEqual(['enable', 'bootstrap', 'enable', 'bootstrap', 'disable']);
  });

  it('darwin: restart recovery restores the persisted activation state, not process memory', async () => {
    installLaunchdPlistTransactionMock.mockImplementation((options: {
      preflight: (state: { hasPrior: boolean }) => {
        ok: boolean;
        stderr: string;
        recoveryState?: unknown;
      };
      recover: (state: unknown) => { ok: boolean; stderr: string };
    }) => {
      const preflight = options.preflight({ hasPrior: true });
      expect(preflight.recoveryState).toEqual({ loaded: true, disabled: false });
      expect(options.recover({ loaded: false, disabled: true }).ok).toBe(true);
      throw new Error('restart recovery complete');
    });

    await expect(install(baseOpts('darwin'))).rejects.toThrow('restart recovery complete');
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('disable'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('bootstrap'))).toBe(false);
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args.includes('bootout'))).toBe(true);
  });

  it('linux: calls systemctl --user daemon-reload then enable --now', async () => {
    await install(baseOpts('linux'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasReload = calls.some((c) => c[0] === 'systemctl' && c[1].includes('daemon-reload'));
    const hasEnable = calls.some((c) => c[0] === 'systemctl' && c[1].includes('enable'));
    expect(hasReload).toBe(true);
    expect(hasEnable).toBe(true);
  });

  it('linux: fails closed when daemon-reload fails', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === 'systemctl' && args.includes('daemon-reload')
        ? { status: 1, stdout: '', stderr: 'not found', error: undefined }
        : normal(cmd, args));
    await expect(install(baseOpts('linux'))).rejects.toThrow('systemd transaction activation failed: not found');
  });

  it('linux: autostart false disables an existing unit without enabling it', async () => {
    await install({ ...baseOpts('linux'), autostart: false });
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) => cmd === 'systemctl' && args.includes('disable') && args.includes('--now'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'systemctl' && args.includes('enable'))).toBe(false);
  });

  it('linux: fails closed when disable --now fails', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === 'systemctl' && args.includes('disable')
        ? { status: 1, stdout: '', stderr: 'access denied', error: undefined }
        : normal(cmd, args));

    await expect(install({ ...baseOpts('linux'), autostart: false })).rejects.toThrow(
      'systemd transaction unload failed: access denied',
    );
  });

  it('linux: rejects a false stopped postcondition', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === 'systemctl' && args.includes('is-active')
        ? { status: 0, stdout: 'active\n', stderr: '', error: undefined }
        : normal(cmd, args));

    await expect(install({ ...baseOpts('linux'), autostart: false })).rejects.toThrow(
      'systemd transaction unload failed: state=',
    );
  });

  it('linux: rejects a false disabled postcondition', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === 'systemctl' && args.includes('is-enabled')
        ? { status: 0, stdout: 'enabled\n', stderr: '', error: undefined }
        : normal(cmd, args));

    await expect(install({ ...baseOpts('linux'), autostart: false })).rejects.toThrow(
      'systemd transaction unload failed: state=',
    );
  });

  it('win32: creates the strict Task Scheduler definition through PowerShell', async () => {
    await install(baseOpts('win32'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasCreate = calls.some(([cmd, args]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$folder.RegisterTaskDefinition($taskName,$definition'));
    expect(hasCreate).toBe(true);
  });

  it('win32: ignores hostile PATH when selecting Windows PowerShell', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = String.raw`C:\hostile-path`;
    try {
      await install(baseOpts('win32'));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    const powershellCalls = (spawnSyncMock.mock.calls as [string, string[]][])
      .filter(([, args]) => args.includes('-NoProfile') && args.includes('-Command'));
    expect(powershellCalls.length).toBeGreaterThan(0);
    expect(powershellCalls.every(([command]) =>
      isWindowsPowerShellCommand(command))).toBe(true);
    expect(powershellCalls.some(([command]) => command === 'powershell.exe')).toBe(false);
  });

  it('win32: fails closed when task creation is denied', async () => {
    const normal = successfulServiceCommands();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$folder.RegisterTaskDefinition($taskName,$definition')
        ? { status: 1, stdout: '', stderr: 'access denied', error: undefined }
        : normal(cmd, args));
    await expect(install(baseOpts('win32'))).rejects.toThrow('Task Scheduler transaction activation failed: access denied');
  });

  it('win32: autostart false deletes an authority-bound task without creating one', async () => {
    let exists = true;
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          exists = false;
          return { status: 0, stdout: 'deleted', stderr: '', error: undefined };
        }
        return {
          status: 0,
          stdout: exists
            ? (args.join(' ').includes('GetSecurityDescriptor(7)') ? windowsTaskSnapshotFixture('3') : '3')
            : 'absent',
          stderr: '',
          error: undefined,
        };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    await install({ ...baseOpts('win32'), autostart: false });
    const calls = spawnSyncMock.mock.calls as [string, string[]][];

    expect(calls.some(([cmd, args]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$folder.DeleteTask($taskName,0)'))).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'schtasks' && args.includes('/Create'))).toBe(false);
    expect(calls.filter(([cmd]) => cmd === 'schtasks')).toEqual([]);
  });

  it('win32: refuses access-denied authority-bound task deletion', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.', error: undefined };
        }
        return {
          status: 0,
          stdout: args.join(' ').includes('GetSecurityDescriptor(7)') ? windowsTaskSnapshotFixture('3') : '3',
          stderr: '',
          error: undefined,
        };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });

    await expect(install({ ...baseOpts('win32'), autostart: false })).rejects.toThrow(
      'Task Scheduler transaction unload failed: ERROR: Access is denied.',
    );
  });

  it('win32: refuses authority-bound stop/delete script failure', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.', error: undefined };
        }
        return {
          status: 0,
          stdout: args.join(' ').includes('GetSecurityDescriptor(7)') ? windowsTaskSnapshotFixture('4') : '4',
          stderr: '',
          error: undefined,
        };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });

    await expect(install({ ...baseOpts('win32'), autostart: false })).rejects.toThrow(
      'Task Scheduler transaction unload failed: ERROR: Access is denied.',
    );
    expect(spawnSyncMock.mock.calls.some(([cmd, args]: [string, string[]]) =>
      cmd === 'schtasks' && args.includes('/Delete'))).toBe(false);
  });

  it('win32: rejects noncanonical success from authority-bound deletion', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (!isWindowsPowerShellCommand(cmd)) {
        return { status: 0, stdout: '', stderr: '', error: undefined };
      }
      if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
        return { status: 0, stdout: '', stderr: '', error: undefined };
      }
      return {
        status: 0,
        stdout: args.join(' ').includes('GetSecurityDescriptor(7)') ? windowsTaskSnapshotFixture('3') : '3',
        stderr: '',
        error: undefined,
      };
    });

    await expect(install({ ...baseOpts('win32'), autostart: false })).rejects.toThrow(
      'Task Scheduler authority-bound removal failed',
    );
  });

  it('win32: archives a safe legacy Startup launcher outside Startup', async () => {
    const exactIdentity = 2n ** 54n + 1n;
    const legacy = path.join(
      FAKE_HOME,
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      'ashlr-daemon.cmd',
    );
    const archivedPath = path.join(
      FAKE_HOME,
      '.ashlr',
      'services',
      'ashlr-daemon.startup-legacy.cmd.disabled',
    );
    let archived = false;
    (fs.renameSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      archived = true;
    });
    (fs.lstatSync as ReturnType<typeof vi.fn>).mockImplementation((
      candidate: fs.PathLike,
      options?: { bigint?: boolean },
    ) => {
      const value = candidate.toString();
      if (options?.bigint) {
        return {
          isSymbolicLink: () => false,
          isDirectory: () => true,
          mode: 0o700n,
          dev: exactIdentity,
          ino: exactIdentity + (value.includes('Startup') ? 1n : 2n),
          uid: BigInt(typeof process.getuid === 'function' ? process.getuid() : 0),
        } as fs.BigIntStats;
      }
      if ((value === legacy && !archived) || (value === archivedPath && archived)) {
        return {
            isSymbolicLink: () => false,
            isFile: () => true,
            nlink: 1,
            uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          } as fs.Stats;
      }
      if (value === legacy || value === archivedPath) {
        throw Object.assign(new Error(`ENOENT: ${value}`), { code: 'ENOENT' });
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
        mode: 0o700,
        dev: 1,
        ino: 1,
        uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      } as fs.Stats;
    });

    await install(baseOpts('win32'));

    expect(fs.renameSync).toHaveBeenCalledWith(
      legacy,
      archivedPath,
    );
    expect(fsyncDirectory).toHaveBeenCalledWith(path.dirname(legacy), {
      expectedIdentity: { dev: exactIdentity, ino: exactIdentity + 1n },
    });
    expect(fsyncDirectory).toHaveBeenCalledWith(path.dirname(archivedPath), {
      expectedIdentity: { dev: exactIdentity, ino: exactIdentity + 2n },
    });
  });

  it('win32: refuses to follow a symlinked legacy Startup launcher', async () => {
    const legacy = path.join(
      FAKE_HOME,
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      'ashlr-daemon.cmd',
    );
    const archived = path.join(
      FAKE_HOME,
      '.ashlr', 'services', 'ashlr-daemon.startup-legacy.cmd.disabled',
    );
    existsSyncMock.mockImplementation((candidate: fs.PathLike) => candidate.toString() === legacy);
    (fs.lstatSync as ReturnType<typeof vi.fn>).mockImplementation((candidate: fs.PathLike) => {
      const value = candidate.toString();
      if (value === archived) {
        throw Object.assign(new Error(`ENOENT: ${value}`), { code: 'ENOENT' });
      }
      return value === legacy
        ? {
            isSymbolicLink: () => true,
            isFile: () => false,
            nlink: 1,
            uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          } as fs.Stats
        : {
            isSymbolicLink: () => false,
            isDirectory: () => true,
            mode: 0o700,
            dev: 1,
            ino: 1,
            uid: typeof process.getuid === 'function' ? process.getuid() : 0,
          } as fs.Stats;
    });

    await expect(install(baseOpts('win32'))).rejects.toThrow('unsafe legacy Windows launcher');
    expect(fs.renameSync).not.toHaveBeenCalled();
  });
});

describe('install() — transactional launchd plist', () => {
  it('delegates the daemon plist and private lock directory to the shared transaction', async () => {
    const home = '/tmp/ashlr-launchd-transaction';
    useSuccessfulLaunchdTransactionMock();
    (cp.spawnSync as ReturnType<typeof vi.fn>).mockImplementation(successfulServiceCommands());

    await install({ ...baseOpts('darwin'), homeDir: home });

    expect(installLaunchdPlistTransactionMock).toHaveBeenCalledWith(expect.objectContaining({
      plistPath: path.join(home, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist'),
      lockDir: path.join(home, '.ashlr', 'locks'),
      content: expect.stringContaining('<string>ai.ashlr.daemon</string>'),
      unload: expect.any(Function),
      load: expect.any(Function),
      rollback: expect.any(Function),
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
      preflight?: (state: { hasPrior: boolean }) => { ok: boolean; stderr?: string };
      unload: () => { ok: boolean };
      plistPath: string;
    }) => {
      const preflight = options.preflight?.({ hasPrior: true });
      if (preflight && !preflight.ok) {
        throw new Error(preflight.stderr || 'preflight failed');
      }
      const unloaded = options.unload();
      if (!unloaded.ok) throw new Error('unload failed; plist retained');
      fs.unlinkSync(options.plistPath);
    });
  });

  it('darwin: bootouts and verifies the launchd job is absent', async () => {
    spawnSyncMock.mockImplementation(successfulServiceCommands());
    await uninstall(baseOpts('darwin'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasUnload = calls.some((c) => c[0] === 'launchctl' && c[1].includes('bootout'));
    expect(hasUnload).toBe(true);
    expect(calls.some((c) => c[0] === 'launchctl' && c[1].includes('print'))).toBe(true);
  });

  it('linux: calls systemctl --user disable --now', async () => {
    spawnSyncMock.mockImplementation(successfulServiceCommands());
    await uninstall(baseOpts('linux'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasDisable = calls.some((c) => c[0] === 'systemctl' && c[1].includes('disable'));
    expect(hasDisable).toBe(true);
    expect(removeLaunchdPlistTransactionMock).toHaveBeenCalledWith(expect.objectContaining({
      plistPath: path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service'),
      trustedRoot: FAKE_HOME,
      lockDir: path.join(FAKE_HOME, '.ashlr', 'locks'),
      unload: expect.any(Function),
      afterRemove: expect.any(Function),
      recoverAfterFailedRemove: expect.any(Function),
      preflight: expect.any(Function),
      recover: expect.any(Function),
      validateRecovery: expect.any(Function),
    }));
  });

  it('linux: reloads and verifies both removed and restored manager states', async () => {
    let managerPresent = true;
    let reloadState: 'removed' | 'restored' = 'removed';
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'systemctl') {
        return { status: 0, stdout: '', stderr: '', error: undefined };
      }
      if (args.includes('daemon-reload')) {
        managerPresent = reloadState === 'restored';
        return { status: 0, stdout: '', stderr: '', error: undefined };
      }
      if (args.includes('is-active')) {
        return { status: 3, stdout: 'inactive\n', stderr: '', error: undefined };
      }
      if (args.includes('is-enabled')) {
        return managerPresent
          ? { status: 1, stdout: 'disabled\n', stderr: '', error: undefined }
          : { status: 1, stdout: 'not-found\n', stderr: '', error: undefined };
      }
      if (args.includes('show')) {
        return {
          status: 0,
          stdout: `${path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service')}\n`,
          stderr: '',
          error: undefined,
        };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });

    await uninstall(baseOpts('linux'));
    const callbacks = removeLaunchdPlistTransactionMock.mock.calls[0]![0] as {
      afterRemove: () => { ok: boolean };
      recoverAfterFailedRemove: () => { ok: boolean };
    };

    expect(callbacks.afterRemove()).toMatchObject({ ok: true });
    reloadState = 'restored';
    expect(callbacks.recoverAfterFailedRemove()).toMatchObject({ ok: true });
  });

  it('win32: calls the authority-bound Task Scheduler delete script', async () => {
    let present = true;
    const lstatSyncMock = fs.lstatSync as ReturnType<typeof vi.fn>;
    const priorLstat = lstatSyncMock.getMockImplementation();
    lstatSyncMock.mockImplementation((candidate: fs.PathLike) => {
      const value = String(candidate);
      if (value.includes(`${path.sep}Startup${path.sep}`) || value.endsWith('.disabled')) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return priorLstat!(candidate);
    });
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          present = false;
          return {
            status: 0,
            stdout: 'deleted',
            stderr: '',
            error: undefined,
          };
        }
        return {
          status: 0,
          stdout: present
            ? (args.join(' ').includes('GetSecurityDescriptor(7)')
                ? windowsTaskSnapshotFixture('3')
                : '3')
            : 'absent',
          stderr: '',
          error: undefined,
        };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    await uninstall(baseOpts('win32'));
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const hasDelete = calls.some(([cmd, args]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$folder.DeleteTask($taskName,0)'));
    expect(hasDelete).toBe(true);
  });

  it('removes the service file when it exists', async () => {
    const unlinkMock = fs.unlinkSync as ReturnType<typeof vi.fn>;
    spawnSyncMock.mockImplementation(successfulServiceCommands());
    await uninstall(baseOpts('darwin'));
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('darwin: retains the service file after a false-zero unload failure', async () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes('print-disabled')
        ? {
            status: 0,
            stdout: launchctlPrintDisabledFixture(false),
            stderr: '',
            error: undefined,
          }
        : args.includes('bootout')
        ? { status: 0, stdout: '', stderr: 'Boot-out failed: 5: Input/output error', error: undefined }
        : args.includes('print')
          ? { status: 0, stdout: '{ "PID" = 123; }', stderr: '', error: undefined }
          : { status: 0, stdout: '', stderr: '', error: undefined });
    const unlinkMock = fs.unlinkSync as ReturnType<typeof vi.fn>;

    await expect(uninstall(baseOpts('darwin'))).rejects.toThrow('unload failed; plist retained');
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('linux: does not unregister or unlink when the lifecycle lock is unavailable', async () => {
    removeLaunchdPlistTransactionMock.mockImplementationOnce(() => {
      throw new Error('lock unavailable');
    });
    const unlinkMock = fs.unlinkSync as ReturnType<typeof vi.fn>;

    await expect(uninstall(baseOpts('linux'))).rejects.toThrow('lock unavailable');

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. serviceStatus() — mocked spawnSync output parsing, never throws
// ---------------------------------------------------------------------------

describe('serviceStatus() — mocked OS query output', () => {
  const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
  const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;
  const launchdTarget = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}/ai.ashlr.daemon`;
  const launchdPlist = path.join(FAKE_HOME, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist');
  const launchdArguments = [
    FAKE_NODE, FAKE_BIN, 'daemon', 'start', '--budget', '5',
    '--interval', '1800000', '--parallel', '1',
  ];
  const systemdFile = path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service');
  const launchdPrint = (state: string, pid?: number): string => `${[
    `${launchdTarget} = {`,
    `\tpath = ${launchdPlist}`,
    `\tstate = ${state}`,
    `\tprogram = ${FAKE_NODE}`,
    '\targuments = {',
    ...launchdArguments.map((argument) => `\t\t${argument}`),
    '\t}',
    ...(pid === undefined ? [] : [`\tpid = ${pid}`]),
    '}',
  ].join('\n')}\n`;
  const mockSystemdState = (state: 'active' | 'inactive' | 'absent'): void => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('is-active')) {
        return state === 'active'
          ? { status: 0, stdout: 'active\n', stderr: '' }
          : { status: 3, stdout: 'inactive\n', stderr: '' };
      }
      if (args.includes('is-enabled')) {
        return state === 'absent'
          ? { status: 1, stdout: 'not-found\n', stderr: '' }
          : { status: 0, stdout: 'enabled\n', stderr: '' };
      }
      if (args.includes('--property=FragmentPath')) {
        return { status: 0, stdout: `${systemdFile}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected systemctl query' };
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('darwin: running=true for an exact native running state and PID', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: launchdPrint('running', 12345),
      stderr: '',
    });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.installed).toBe(true);
    expect(s.running).toBe(true);
    expect(s.runtimeState).toBe('running');
    expect(s.platformSpec).toBe('launchd');
    expect(s.registrationState).toBe('present');
  });

  it('darwin: runtime is unknown when native running state has PID zero', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: launchdPrint('running', 0),
      stderr: '',
    });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.running).toBe(false);
    expect(s.runtimeState).toBe('unknown');
    expect(s.platformSpec).toBe('launchd');
    expect(s.registrationState).toBe('present');
  });

  it('darwin: definition mismatch preserves native registration presence', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: launchdPrint('waiting').replace(`path = ${launchdPlist}`, 'path = /tmp/untrusted.plist'),
      stderr: '',
    });

    expect(serviceStatus(baseOpts('darwin'))).toMatchObject({
      registrationState: 'present',
      installed: true,
      running: false,
      runtimeState: 'unknown',
    });
  });

  it('darwin: exact loaded waiting state is ready without being running', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: launchdPrint('waiting'),
      stderr: '',
    });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.running).toBe(false);
    expect(s.runtimeState).toBe('ready');
    expect(s.platformSpec).toBe('launchd');
    expect(s.registrationState).toBe('present');
  });

  it('darwin: proven absent launchd job is stopped', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'Could not find service' });
    const s = serviceStatus(baseOpts('darwin'));
    expect(s.running).toBe(false);
    expect(s.installed).toBe(false);
    expect(s.runtimeState).toBe('stopped');
    expect(s.registrationState).toBe('absent');
  });

  it('darwin: missing expected file does not hide native registration', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: launchdPrint('waiting'), stderr: '' });

    expect(serviceStatus(baseOpts('darwin'))).toMatchObject({
      registrationState: 'present',
      installed: true,
      running: false,
    });
  });

  it('linux: running=true when systemctl is-active returns "active"', () => {
    existsSyncMock.mockReturnValue(true);
    mockSystemdState('active');
    const s = serviceStatus(baseOpts('linux'));
    expect(s.running).toBe(true);
    expect(s.platformSpec).toBe('systemd');
    expect(s.registrationState).toBe('present');
  });

  it('linux: running=false when systemctl is-active returns "inactive"', () => {
    existsSyncMock.mockReturnValue(true);
    mockSystemdState('inactive');
    const s = serviceStatus(baseOpts('linux'));
    expect(s.running).toBe(false);
    expect(s.platformSpec).toBe('systemd');
    expect(s.registrationState).toBe('present');
  });

  it('linux: missing expected file does not hide native registration', () => {
    existsSyncMock.mockReturnValue(false);
    mockSystemdState('inactive');

    expect(serviceStatus(baseOpts('linux'))).toMatchObject({
      registrationState: 'present',
      installed: true,
      running: false,
    });
  });

  it('linux: missing file plus native absence is proven absent', () => {
    existsSyncMock.mockReturnValue(false);
    mockSystemdState('absent');

    expect(serviceStatus(baseOpts('linux'))).toMatchObject({
      registrationState: 'absent',
      installed: false,
      running: false,
    });
  });

  it('linux: missing file plus ambiguous manager evidence is unknown', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'manager unavailable' });

    expect(serviceStatus(baseOpts('linux'))).toMatchObject({
      registrationState: 'unknown',
      installed: false,
      running: false,
      runtimeState: 'unknown',
    });
  });

  it('win32: Ready means registered but not running', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '3',
      stderr: '',
    });
    const s = serviceStatus(baseOpts('win32'));
    expect(s.running).toBe(false);
    expect(s.platformSpec).toBe('schtasks');
    expect(s.registrationState).toBe('present');
  });

  it('win32: missing expected file does not hide native registration', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '3', stderr: '' });

    expect(serviceStatus(baseOpts('win32'))).toMatchObject({
      registrationState: 'present',
      installed: true,
      running: false,
    });
  });

  it('win32: missing file plus native absence is proven absent', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'absent', stderr: '' });

    expect(serviceStatus(baseOpts('win32'))).toMatchObject({
      registrationState: 'absent',
      installed: false,
      running: false,
    });
  });

  it('win32: Running preserves scheduler activity without claiming daemon liveness', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '4',
      stderr: '',
    });
    expect(serviceStatus(baseOpts('win32'))).toMatchObject({
      running: false,
      runtimeState: 'running',
    });
  });

  it('win32: Queued preserves scheduler activity without claiming daemon liveness', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '2',
      stderr: '',
    });
    expect(serviceStatus(baseOpts('win32'))).toMatchObject({
      running: false,
      runtimeState: 'queued',
    });
  });

  it.each(['0', 'Running', '3\n4', '', '5'])('win32: malformed or unknown authority is distinct (%s)', (stdout) => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 0, stdout, stderr: '' });
    expect(serviceStatus(baseOpts('win32'))).toMatchObject({
      registrationState: 'unknown',
      running: false,
      runtimeState: 'unknown',
    });
  });

  it('win32: runtime is unknown when the PowerShell authority exits non-zero', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'ERROR: not found' });
    const s = serviceStatus(baseOpts('win32'));
    expect(s.running).toBe(false);
    expect(s.runtimeState).toBe('unknown');
    expect(s.installed).toBe(false);
    expect(s.registrationState).toBe('unknown');
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
  const lstatSyncMock = fs.lstatSync as ReturnType<typeof vi.fn>;
  const launchdTarget = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}/ai.ashlr.daemon`;
  const launchdPlist = path.join(FAKE_HOME, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist');
  const launchdArguments = [
    FAKE_NODE, FAKE_BIN, 'daemon', 'start', '--budget', '5',
    '--interval', '1800000', '--parallel', '1',
  ];
  const launchdPrint = (
    state: 'running' | 'waiting' | 'not running' | 'exited' | 'stopped',
    options: {
      path?: string;
      program?: string;
      arguments?: string[];
      pid?: number;
      extra?: string[];
    } = {},
  ): string => `${[
    `${launchdTarget} = {`,
    `\tpath = ${options.path ?? launchdPlist}`,
    `\tstate = ${state}`,
    `\tprogram = ${options.program ?? FAKE_NODE}`,
    '\targuments = {',
    ...(options.arguments ?? launchdArguments).map((argument) => `\t\t${argument}`),
    '\t}',
    ...(options.pid === undefined ? [] : [`\tpid = ${options.pid}`]),
    ...(options.extra ?? []),
    '}',
  ].join('\n')}\n`;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    withServiceFileTransactionLockMock.mockReset();
    withServiceFileTransactionLockMock.mockImplementation(
      (_options: unknown, action: () => unknown) => action(),
    );
    lstatSyncMock.mockImplementation((filePath: fs.PathLike) => {
      const isLauncher = String(filePath).endsWith('ashlr-daemon.cmd');
      return {
        dev: 1,
        ino: isLauncher ? 2 : 1,
        uid: typeof process.getuid === 'function' ? process.getuid() : 0,
        mode: isLauncher ? 0o100600 : 0o40700,
        nlink: 1,
        isSymbolicLink: () => false,
        isFile: () => isLauncher,
        isDirectory: () => !isLauncher,
      } as fs.Stats;
    });
  });

  it('darwin: kickstarts an installed launchd job that has no PID', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: launchdPrint('waiting'),
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: launchdPrint('waiting'),
        stderr: '',
      })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: launchdPrint('running', { pid: 12345 }),
        stderr: '',
      });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status.running).toBe(true);
    expect(withServiceFileTransactionLockMock).toHaveBeenCalledWith({
      filePath: path.join(FAKE_HOME, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist'),
      trustedRoot: FAKE_HOME,
      lockDir: path.join(FAKE_HOME, '.ashlr', 'locks'),
    }, expect.any(Function));
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'launchctl',
      ['kickstart', expect.stringMatching(/^gui\/\d+\/ai\.ashlr\.daemon$/)],
      expect.objectContaining({ encoding: 'utf8', timeout: 15_000 }),
    );
  });

  it('darwin: does not kickstart when launchd already has a PID', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: launchdPrint('running', { pid: 12345 }),
      stderr: '',
    });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status.running).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('darwin: locked recheck suppresses activation when another caller started the job', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: launchdPrint('waiting'),
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: launchdPrint('running', { pid: 12345 }),
        stderr: '',
      });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status.running).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) =>
      args.includes('kickstart'))).toBe(false);
  });

  it.each([
    {
      name: 'access denial',
      response: { status: 1, stdout: '', stderr: 'Operation not permitted' },
    },
    {
      name: 'process error',
      response: { status: null, stdout: '', stderr: '', error: new Error('spawn timeout') },
    },
    {
      name: 'malformed success output',
      response: { status: 0, stdout: 'unexpected output', stderr: '' },
    },
    {
      name: 'familiar but invalid native state',
      response: {
        status: 0,
        stdout: launchdPrint('waiting').replace('state = waiting', 'state = garbage'),
        stderr: '',
      },
    },
    {
      name: 'wrong plist authority',
      response: {
        status: 0,
        stdout: launchdPrint('waiting', { path: '/tmp/replaced.plist' }),
        stderr: '',
      },
    },
    {
      name: 'wrong cached program',
      response: {
        status: 0,
        stdout: launchdPrint('waiting', { program: '/tmp/replaced-node' }),
        stderr: '',
      },
    },
    {
      name: 'wrong cached arguments',
      response: {
        status: 0,
        stdout: launchdPrint('waiting', {
          arguments: [FAKE_NODE, '/tmp/replaced-bin', 'daemon', 'start'],
        }),
        stderr: '',
      },
    },
    {
      name: 'duplicate native state',
      response: {
        status: 0,
        stdout: launchdPrint('waiting', { extra: ['\tstate = running'] }),
        stderr: '',
      },
    },
    {
      name: 'duplicate native arguments block',
      response: {
        status: 0,
        stdout: launchdPrint('waiting', {
          extra: [
            '\targuments = {',
            ...launchdArguments.map((argument) => `\t\t${argument}`),
            '\t}',
          ],
        }),
        stderr: '',
      },
    },
    {
      name: 'contradictory success stderr',
      response: {
        status: 0,
        stdout: launchdPrint('waiting'),
        stderr: 'Operation not permitted',
      },
    },
    {
      name: 'zero running PID',
      response: {
        status: 0,
        stdout: launchdPrint('running', { pid: 0 }),
        stderr: '',
      },
    },
  ])('darwin: treats $name as unknown and never kickstarts', async ({ response }) => {
    spawnSyncMock.mockReturnValueOnce(response);

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status).toMatchObject({ running: false, runtimeState: 'unknown' });
    expect(withServiceFileTransactionLockMock).not.toHaveBeenCalled();
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) =>
      args.includes('kickstart'))).toBe(false);
  });

  it('darwin: treats an ambiguous locked recheck as unknown and never kickstarts', async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: launchdPrint('waiting'),
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Operation not permitted',
      });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status).toMatchObject({ running: false, runtimeState: 'unknown' });
    expect(withServiceFileTransactionLockMock).toHaveBeenCalledOnce();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) =>
      args.includes('kickstart'))).toBe(false);
  });

  it('darwin: keeps a failed non-forcing kickstart fail-closed', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: launchdPrint('waiting'), stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: launchdPrint('waiting'), stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'service changed state' });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status).toMatchObject({ running: false, runtimeState: 'ready' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    const kickstart = spawnSyncMock.mock.calls[2] as [string, string[]];
    expect(kickstart[1]).toEqual(['kickstart', launchdTarget]);
    expect(kickstart[1]).not.toContain('-k');
  });

  it('darwin: withholds malformed post-kickstart state without retrying', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: launchdPrint('waiting'), stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: launchdPrint('waiting'), stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'truncated', stderr: '' });

    const status = await ensureRunning(baseOpts('darwin'));

    expect(status).toMatchObject({ running: false, runtimeState: 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(4);
    expect(spawnSyncMock.mock.calls.filter(([, args]: [string, string[]]) =>
      args.includes('kickstart'))).toHaveLength(1);
  });

  it('linux: starts an inactive installed user unit', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 3, stdout: 'inactive\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: 'disabled\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service')}\n`,
        stderr: '',
      })
      .mockReturnValueOnce({ status: 3, stdout: 'inactive\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: 'disabled\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service')}\n`,
        stderr: '',
      })
      .mockReturnValueOnce({ status: 3, stdout: 'inactive\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: 'disabled\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service')}\n`,
        stderr: '',
      })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'active\n', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: 'enabled\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${path.join(FAKE_HOME, '.config', 'systemd', 'user', 'ashlr-daemon.service')}\n`,
        stderr: '',
      });

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
      .mockReturnValueOnce({ status: 0, stdout: '3', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '3', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'started',
        stderr: '',
      })
      .mockReturnValueOnce({ status: 0, stdout: '4', stderr: '' });

    const status = await ensureRunning(baseOpts('win32'));

    expect(status).toMatchObject({ running: false, runtimeState: 'running' });
    const runIndex = spawnSyncMock.mock.calls.findIndex(
      ([cmd, args]: [string, string[]]) =>
        isWindowsPowerShellCommand(cmd) &&
        args.join(' ').includes('$registered.Run($null)'),
    );
    expect(runIndex).toBe(2);
    const runCall = spawnSyncMock.mock.calls[runIndex] as [
      string,
      string[],
      { input?: string },
    ];
    const launcherPath = path.join(FAKE_HOME, '.ashlr', 'services', 'ashlr-daemon.cmd');
    expect(runCall[1].join(' ')).toContain('Assert-AshlrTaskDefinition');
    expect(runCall[1].join(' ')).not.toContain(launcherPath);
    expect(runCall[2].input).toBe(JSON.stringify({ expectedLauncherPath: launcherPath }));
  });

  it('win32: treats malformed state as unknown and does not mutate it', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: 'not-a-state', stderr: '' });

    const status = await ensureRunning(baseOpts('win32'));

    expect(status).toMatchObject({ running: false, runtimeState: 'unknown' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('win32: does not run an already Running scheduled task', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: '4',
      stderr: '',
    });

    const status = await ensureRunning(baseOpts('win32'));
    expect(status).toMatchObject({ running: false, runtimeState: 'running' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('win32: does not run an already Queued scheduled task', async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: '2',
      stderr: '',
    });

    const status = await ensureRunning(baseOpts('win32'));
    expect(status).toMatchObject({ running: false, runtimeState: 'queued' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
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

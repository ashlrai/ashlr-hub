import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('../src/core/daemon/service-install-authority.js', () => ({
  assertResidentServiceInstallAuthorized: vi.fn(),
}));

import * as cp from 'node:child_process';
import {
  ensureRunning,
  generateServiceDefinition,
  install,
  serviceStatus,
  uninstall,
} from '../src/core/daemon/service.js';
import { windowsPowerShellPath } from '../src/core/daemon/windows-task-scripts.js';

const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
let home: string;

function isWindowsPowerShellCommand(command: string): boolean {
  return command === windowsPowerShellPath();
}

function opts(platform: 'linux' | 'win32') {
  return {
    platform,
    homeDir: home,
    nodePath: process.execPath,
    binPath: path.join(home, 'bin', 'ashlr'),
  } as const;
}

function result(status = 0, stdout = '', stderr = '') {
  return { status, stdout, stderr, error: undefined };
}

function windowsTaskSnapshotFixture(state: string): string {
  return JSON.stringify({
    state,
    taskXmlBase64: Buffer.from('<Task version="1.4">prior-custom</Task>', 'utf8').toString('base64'),
    taskSecurityDescriptorBase64: Buffer.from('D:P(A;;FA;;;SY)', 'utf8').toString('base64'),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-service-transaction-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('daemon service file authority', () => {
  it('rejects a Linux symlink target without touching its referent', async () => {
    const def = generateServiceDefinition(opts('linux'));
    const outside = path.join(home, 'outside.service');
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, def.filePath);

    await expect(install(opts('linux'))).rejects.toThrow('unsafe active plist');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a Windows hardlink target without touching its referent', async () => {
    const def = generateServiceDefinition(opts('win32'));
    const outside = path.join(home, 'outside.cmd');
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outside, 'outside');
    fs.linkSync(outside, def.filePath);

    await expect(install(opts('win32'))).rejects.toThrow('regular, singly-linked file');
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a world-writable Windows service parent', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(def.filePath), 0o777);

    await expect(install(opts('win32'))).rejects.toThrow('unsafe launchd plist parent component');
    expect(fs.existsSync(def.filePath)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('rejects a symlinked legacy Startup parent without moving its launcher', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    const outside = path.join(home, 'outside-app-data');
    const legacy = path.join(
      outside,
      'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      'ashlr-daemon.cmd',
    );
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacy, 'legacy');
    fs.symlinkSync(outside, path.join(home, 'AppData'));
    spawnSyncMock.mockReturnValue(result(0, 'absent'));

    await expect(install(opts('win32'))).rejects.toThrow('unsafe legacy Windows launcher parent component');
    expect(fs.readFileSync(legacy, 'utf8')).toBe('legacy');
    expect(fs.existsSync(path.join(path.dirname(def.filePath), 'ashlr-daemon.startup-legacy.cmd.disabled'))).toBe(false);
  });

  it('rejects a dangling legacy Startup launcher without following it', async () => {
    const legacy = path.join(
      home,
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      'ashlr-daemon.cmd',
    );
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(home, 'missing-target.cmd'), legacy);
    spawnSyncMock.mockReturnValue(result(0, 'absent'));

    await expect(install(opts('win32'))).rejects.toThrow('unsafe legacy Windows launcher');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(spawnSyncMock.mock.calls.some(([cmd]: [string]) => cmd === 'schtasks')).toBe(false);
  });

  it('rejects a dangling symlink ancestor even when the legacy launcher leaf is absent', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(home, 'missing-app-data'), path.join(home, 'AppData'));
    spawnSyncMock.mockReturnValue(result(0, 'absent'));

    await expect(install(opts('win32'))).rejects.toThrow(
      'unsafe legacy Windows launcher parent component',
    );
    expect(spawnSyncMock.mock.calls.some(([cmd]: [string]) => cmd === 'schtasks')).toBe(false);
  });

  it('fails closed when a legacy Startup launcher appears during final verification', async () => {
    const def = generateServiceDefinition(opts('win32'));
    const legacy = path.join(
      home,
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      'ashlr-daemon.cmd',
    );
    let powershellCalls = 0;
    spawnSyncMock.mockImplementation((cmd: string) => {
      if (isWindowsPowerShellCommand(cmd)) {
        powershellCalls++;
        if (powershellCalls === 4) {
          fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
          fs.writeFileSync(legacy, 'interloper', { mode: 0o600 });
        }
        return result(0, 'absent');
      }
      return result();
    });

    await expect(install({ ...opts('win32'), autostart: false })).rejects.toThrow(
      'legacy Windows Startup launcher remains present',
    );
    expect(fs.readFileSync(legacy, 'utf8')).toBe('interloper');
    expect(fs.existsSync(def.filePath)).toBe(true);
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
      .filter((name) => name.endsWith('.journal.json'))).toHaveLength(1);
  });

  it('rejects a malformed Windows task snapshot before deleting the task', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-launcher', { mode: 0o600 });
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd) &&
        args.join(' ').includes('GetSecurityDescriptor(7)')) {
        return result(0, JSON.stringify({
          state: '3',
          taskXmlBase64: 'not-base64',
          taskSecurityDescriptorBase64: Buffer.from('D:P(A;;FA;;;SY)', 'utf8').toString('base64'),
        }));
      }
      return result(0, '3');
    });

    await expect(install(opts('win32'))).rejects.toThrow('invalid Task Scheduler XML snapshot');
    expect(spawnSyncMock.mock.calls.some(([cmd, args]: [string, string[]]) =>
      cmd === 'schtasks' && args.includes('/Delete'))).toBe(false);
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-launcher');
  });

  it.each([
    ['manager reports the trusted unit missing', 'not-found', ''],
    ['manager resolves a different fragment', 'disabled', 'mismatch'],
  ])('rejects systemd authority when %s', async (_case, enabledState, fragmentPath) => {
    const def = generateServiceDefinition(opts('linux'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-unit', { mode: 0o600 });
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'systemctl') return result();
      if (args.includes('is-active')) return result(3, 'inactive\n');
      if (args.includes('is-enabled')) {
        return enabledState === 'not-found'
          ? result(1, 'not-found\n')
          : result(1, 'disabled\n');
      }
      if (args.includes('show')) {
        return result(0, `${fragmentPath === 'mismatch' ? path.join(home, 'other.service') : fragmentPath}\n`);
      }
      return result();
    });

    await expect(install(opts('linux'))).rejects.toThrow(
      enabledState === 'not-found'
        ? 'systemd manager and trusted service-file presence disagree'
        : 'systemd FragmentPath does not match the trusted service file',
    );
    expect(spawnSyncMock.mock.calls.some(([, args]: [string, string[]]) =>
      args.includes('disable'))).toBe(false);
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-unit');
  });
});

describe('daemon service rollback', () => {
  it('restores Linux bytes and active/enabled state after replacement activation fails', async () => {
    const def = generateServiceDefinition(opts('linux'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-unit', { mode: 0o600 });
    const state = { active: true, enabled: true };
    let reloads = 0;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'systemctl') return result();
      if (args.includes('is-active')) return state.active ? result(0, 'active\n') : result(3, 'inactive\n');
      if (args.includes('is-enabled')) return state.enabled ? result(0, 'enabled\n') : result(1, 'disabled\n');
      if (args.includes('show')) return result(0, `${def.filePath}\n`);
      if (args.includes('daemon-reload')) return ++reloads === 1 ? result(1, '', 'reload denied') : result();
      if (args.includes('disable')) state.enabled = false;
      if (args.includes('enable')) state.enabled = true;
      if (args.includes('stop') || args.includes('--now') && args.includes('disable')) state.active = false;
      if (args.includes('start') || args.includes('--now') && args.includes('enable')) state.active = true;
      return result();
    });

    await expect(install(opts('linux'))).rejects.toThrow('systemd transaction activation failed: reload denied');
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-unit');
    expect(state).toEqual({ active: true, enabled: true });
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });

  it('restores Windows launcher, task state, and legacy launcher after task creation fails', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-launcher', { mode: 0o600 });
    const legacy = path.join(
      home,
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
      'ashlr-daemon.cmd',
    );
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacy, 'legacy', { mode: 0o600 });
    let taskState: 'absent' | 'ready' = 'ready';
    let creates = 0;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.RegisterTaskDefinition($taskName,$definition')) {
          if (++creates === 1) return result(1, '', 'creation denied');
          taskState = 'ready';
          return result(0, 'created');
        }
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          taskState = 'absent';
          return result(0, 'deleted');
        }
        if (args.join(' ').includes(".RegisterTask('AshlrDaemon'")) {
          taskState = 'ready';
          return result(0, 'restored');
        }
        return result(
          0,
          taskState === 'ready'
            ? (args.join(' ').includes('GetSecurityDescriptor(7)') ? windowsTaskSnapshotFixture('3') : '3')
            : 'absent',
        );
      }
      if (cmd !== 'schtasks') return result();
      return result();
    });

    await expect(install(opts('win32'))).rejects.toThrow(
      'Task Scheduler transaction activation failed: creation denied',
    );
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-launcher');
    expect(fs.readFileSync(legacy, 'utf8')).toBe('legacy');
    expect(fs.existsSync(path.join(path.dirname(def.filePath), 'ashlr-daemon.startup-legacy.cmd.disabled'))).toBe(false);
    expect(taskState).toBe('ready');
    const restoreCall = spawnSyncMock.mock.calls.find(
      ([cmd, args]: [string, string[]]) =>
        isWindowsPowerShellCommand(cmd) &&
        args.join(' ').includes(".RegisterTask('AshlrDaemon'"),
    ) as [string, string[], { input?: string }] | undefined;
    expect(restoreCall).toBeDefined();
    expect(restoreCall![1].join(' ')).not.toContain('prior-custom');
    expect(restoreCall![1].join(' ')).toContain('$flags=2 -bor 16 -bor 32');
    expect(restoreCall![1].join(' ')).toContain(".RegisterTask('AshlrDaemon'");
    expect(restoreCall![1].join(' ')).not.toContain('SetSecurityDescriptor');
    const snapshotCall = spawnSyncMock.mock.calls.find(
      ([cmd, args]: [string, string[]]) =>
        isWindowsPowerShellCommand(cmd) &&
        args.join(' ').includes('GetSecurityDescriptor(7)'),
    ) as [string, string[], { input?: string }] | undefined;
    expect(snapshotCall![1].join(' ')).toContain('[int]$action.Type -ne 0');
    expect(snapshotCall![1].join(' ')).toContain('[int]$trigger.Type -ne 9');
    expect(snapshotCall![1].join(' ')).toContain('[int]$principal.LogonType -ne 3');
    expect(snapshotCall![1].join(' ')).toContain('task principal is not the current user');
    expect(snapshotCall![1].join(' ')).toContain('GetSecurityDescriptor(7)');
    expect(snapshotCall![1].join(' ')).not.toContain(def.filePath);
    expect(snapshotCall![2].input).toBe(JSON.stringify({ expectedLauncherPath: def.filePath }));
    expect(restoreCall![2].input).toBe(JSON.stringify({
      expectedLauncherPath: def.filePath,
      taskXmlBase64: Buffer.from('<Task version="1.4">prior-custom</Task>', 'utf8').toString('base64'),
      taskSecurityDescriptorBase64: Buffer.from('D:P(A;;FA;;;SY)', 'utf8').toString('base64'),
    }));
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });

  it('retains recovery evidence when re-exported Windows task XML does not match', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-launcher', { mode: 0o600 });
    fs.mkdirSync(path.join(
      home,
      'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    ), { recursive: true, mode: 0o700 });
    let taskState: 'absent' | 'ready' = 'ready';
    let snapshotReads = 0;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.RegisterTaskDefinition($taskName,$definition')) {
          return result(1, '', 'creation denied');
        }
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          taskState = 'absent';
          return result(0, 'deleted');
        }
        if (args.join(' ').includes(".RegisterTask('AshlrDaemon'")) {
          taskState = 'ready';
          return result(0, 'restored');
        }
        if (taskState === 'absent') return result(0, 'absent');
        if (args.join(' ').includes('GetSecurityDescriptor(7)')) {
          snapshotReads++;
          return result(0, snapshotReads === 1
            ? windowsTaskSnapshotFixture('3')
            : JSON.stringify({
                state: '3',
                taskXmlBase64: Buffer.from('<Task>interleaved</Task>', 'utf8').toString('base64'),
                taskSecurityDescriptorBase64: Buffer.from('D:P(A;;FA;;;SY)', 'utf8').toString('base64'),
              }));
        }
        return result(0, '3');
      }
      if (cmd !== 'schtasks') return result();
      return result();
    });

    await expect(install(opts('win32'))).rejects.toThrow(
      'Task Scheduler definition snapshot mismatch',
    );
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-launcher');
    expect(taskState).toBe('ready');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
      .filter((name) => name.endsWith('.journal.json'))).toHaveLength(1);
  });

  it('does not report a formerly running Windows task restored while it remains queued', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-launcher', { mode: 0o600 });
    let taskState: 'absent' | 'ready' | 'running' | 'queued' = 'running';
    const token = () => ({
      ready: '3',
      running: '4',
      queued: '2',
    } as const)[taskState as Exclude<typeof taskState, 'absent'>];

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.RegisterTaskDefinition($taskName,$definition')) {
          return result(1, '', 'creation denied');
        }
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          taskState = 'absent';
          return result(0, 'deleted');
        }
        if (args.join(' ').includes('$registered.Run($null)')) {
          taskState = 'queued';
          return result(0, 'started');
        }
        if (args.join(' ').includes(".RegisterTask('AshlrDaemon'")) {
          taskState = 'ready';
          return result(0, 'restored');
        }
        if (taskState === 'absent') return result(0, 'absent');
        return result(
          0,
          args.join(' ').includes('GetSecurityDescriptor(7)')
            ? windowsTaskSnapshotFixture(token())
            : token(),
        );
      }
      if (cmd !== 'schtasks') return result();
      return result();
    });

    await expect(install(opts('win32'))).rejects.toThrow(
      'Task Scheduler state=queued; expected running',
    );
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-launcher');
    expect(taskState).toBe('queued');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
      .filter((name) => name.endsWith('.journal.json'))).toHaveLength(1);
  });
});

describe('daemon service uninstall authority', () => {
  it('restores launchd loaded and disabled state after a mutating false-zero bootout', async () => {
    const options = {
      platform: 'darwin' as const,
      homeDir: home,
      nodePath: process.execPath,
      binPath: path.join(home, 'bin', 'ashlr'),
    };
    const def = generateServiceDefinition(options);
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'trusted-plist', { mode: 0o600 });
    const original = fs.lstatSync(def.filePath);
    let loaded = true;
    let disabled = false;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'launchctl') return result();
      if (args[0] === 'print') {
        return loaded
          ? result(0, '{ "pid" = 123; }')
          : result(113, '', 'Could not find service');
      }
      if (args[0] === 'print-disabled') {
        return result(
          0,
          `disabled services = {\n\t"ai.ashlr.daemon" => ${disabled ? 'disabled' : 'enabled'}\n}\n`,
        );
      }
      if (args[0] === 'bootout') {
        loaded = false;
        return result(0, '', 'Boot-out failed: 5: Input/output error');
      }
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'disable') disabled = true;
      if (args[0] === 'enable') disabled = false;
      return result();
    });

    await expect(uninstall(options)).rejects.toThrow(
      'launchd unload failed: Boot-out failed: 5: Input/output error; ' +
      'prior service file and manager state were restored',
    );

    const restored = fs.lstatSync(def.filePath);
    expect({ dev: restored.dev, ino: restored.ino }).toEqual({
      dev: original.dev,
      ino: original.ino,
    });
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('trusted-plist');
    expect({ loaded, disabled }).toEqual({ loaded: true, disabled: false });
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
      .filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });

  it('restores the exact Linux activation state when final daemon-reload fails', async () => {
    const def = generateServiceDefinition(opts('linux'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'trusted-unit', { mode: 0o600 });
    const state = { active: true, enabled: true };
    let reloads = 0;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'systemctl') return result();
      if (args.includes('is-active')) {
        return state.active ? result(0, 'active\n') : result(3, 'inactive\n');
      }
      if (args.includes('is-enabled')) {
        return state.enabled ? result(0, 'enabled\n') : result(1, 'disabled\n');
      }
      if (args.includes('show')) return result(0, `${def.filePath}\n`);
      if (args.includes('daemon-reload')) {
        reloads++;
        return reloads === 1 ? result(1, '', 'reload denied') : result();
      }
      if (args.includes('disable')) state.enabled = false;
      if (args.includes('enable')) state.enabled = true;
      if (args.includes('stop') || args.includes('--now') && args.includes('disable')) {
        state.active = false;
      }
      if (args.includes('start')) state.active = true;
      return result();
    });

    await expect(uninstall(opts('linux'))).rejects.toThrow(
      'service removal finalization failed: reload denied; ' +
      'prior service file and manager state were restored',
    );

    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('trusted-unit');
    expect(fs.statSync(def.filePath).mode & 0o777).toBe(0o600);
    expect(state).toEqual({ active: true, enabled: true });
    expect(reloads).toBe(2);
  });

  it('restores Linux activation when disable mutates state before verification fails', async () => {
    const def = generateServiceDefinition(opts('linux'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'trusted-unit', { mode: 0o600 });
    const state = { active: true, enabled: true };
    let poisonPostDisableVerification = false;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'systemctl') return result();
      if (args.includes('is-active')) {
        return state.active ? result(0, 'active\n') : result(3, 'inactive\n');
      }
      if (args.includes('is-enabled')) {
        if (poisonPostDisableVerification) {
          poisonPostDisableVerification = false;
          return result(0, 'enabled\n');
        }
        return state.enabled ? result(0, 'enabled\n') : result(1, 'disabled\n');
      }
      if (args.includes('show')) return result(0, `${def.filePath}\n`);
      if (args.includes('disable')) {
        state.enabled = false;
        state.active = false;
        poisonPostDisableVerification = true;
      }
      if (args.includes('enable')) state.enabled = true;
      if (args.includes('start')) state.active = true;
      return result();
    });

    await expect(uninstall(opts('linux'))).rejects.toThrow(
      'systemd unload failed: state=',
    );

    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('trusted-unit');
    expect(state).toEqual({ active: true, enabled: true });
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
      .filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });

  it.each([
    ['delete exits non-zero', false],
    ['delete reports success but the task remains present', true],
  ])('retains the Windows launcher when %s', async (_case, falseZero) => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'trusted-launcher', { mode: 0o600 });
    let snapshotRead = false;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          return falseZero
            ? result(0, '')
            : result(1, '', 'Access is denied');
        }
        if (args.join(' ').includes('GetSecurityDescriptor(7)')) {
          snapshotRead = true;
          return result(0, windowsTaskSnapshotFixture('3'));
        }
        return result(0, '3');
      }
      return result();
    });

    await expect(uninstall(opts('win32'))).rejects.toThrow(
      'prior service file and manager state were restored',
    );

    expect(snapshotRead).toBe(true);
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('trusted-launcher');
    expect(spawnSyncMock.mock.calls.filter(([cmd, args]: [string, string[]]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$folder.DeleteTask($taskName,0)'))).toHaveLength(1);
  });

  it('retains the Windows launcher when a running task cannot be stopped', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'trusted-launcher', { mode: 0o600 });

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
        if (args.join(' ').includes('$folder.DeleteTask($taskName,0)')) {
          return result(1, '', 'Access is denied');
        }
        return result(
          0,
          args.join(' ').includes('GetSecurityDescriptor(7)')
            ? windowsTaskSnapshotFixture('4')
            : '4',
        );
      }
      return result();
    });

    await expect(uninstall(opts('win32'))).rejects.toThrow(
      'prior service file and manager state were restored',
    );

    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('trusted-launcher');
    expect(spawnSyncMock.mock.calls.some(([cmd, args]: [string, string[]]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$folder.DeleteTask($taskName,0)'))).toBe(true);
  });

  it('restarts an exact Windows task when stop succeeds before delete fails', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'trusted-launcher', { mode: 0o600 });
    let taskState = '4';
    let starts = 0;

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (!isWindowsPowerShellCommand(cmd)) return result();
      const script = args.join(' ');
      if (script.includes('$folder.DeleteTask($taskName,0)')) {
        taskState = '3';
        return result(1, '', 'Access is denied after stop');
      }
      if (script.includes('$registered.Run($null)')) {
        starts++;
        taskState = '4';
        return result(0, 'started');
      }
      return result(
        0,
        script.includes('GetSecurityDescriptor(7)')
          ? windowsTaskSnapshotFixture(taskState)
          : taskState,
      );
    });

    await expect(uninstall(opts('win32'))).rejects.toThrow(
      'Task Scheduler unload failed: Access is denied after stop; ' +
      'prior service file and manager state were restored',
    );

    expect(starts).toBe(1);
    expect(taskState).toBe('4');
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('trusted-launcher');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
      .filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });
});

describe('Windows runtime authority', () => {
  it('publishes localized state as unknown and refuses to start it', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'launcher', { mode: 0o600 });
    spawnSyncMock.mockReturnValue(result(0, 'Bereit'));

    expect(serviceStatus(opts('win32'))).toMatchObject({ running: false, runtimeState: 'unknown' });
    await expect(ensureRunning(opts('win32'))).resolves.toMatchObject({ running: false, runtimeState: 'unknown' });
    expect(spawnSyncMock.mock.calls.every(([cmd]) =>
      isWindowsPowerShellCommand(cmd))).toBe(true);
  });

  it('refuses to run a ready task when its authority snapshot fails', async () => {
    const def = generateServiceDefinition(opts('win32'));
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'launcher', { mode: 0o600 });
    let stateReads = 0;
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (!isWindowsPowerShellCommand(cmd)) return result();
      if (args.join(' ').includes('$registered.Run($null)')) {
        return result(1, '', 'task action does not match trusted Ashlr launcher');
      }
      stateReads++;
      return result(0, '3');
    });

    await expect(ensureRunning(opts('win32'))).resolves.toMatchObject({
      running: false,
      runtimeState: 'ready',
    });

    expect(stateReads).toBe(2);
    const activationCall = spawnSyncMock.mock.calls.find(([cmd, args]: [string, string[]]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$registered.Run($null)'));
    expect(activationCall).toBeDefined();
    const activationScript = activationCall![1].join(' ');
    expect(activationScript.indexOf('Assert-AshlrTaskDefinition $definition $expectedLauncher'))
      .toBeLessThan(activationScript.indexOf('$registered.Run($null)'));
    expect(spawnSyncMock.mock.calls.some(([cmd]: [string]) => cmd === 'schtasks')).toBe(false);
  });

  it('refuses to run through a hardlinked Windows launcher', async () => {
    const def = generateServiceDefinition(opts('win32'));
    const outside = path.join(home, 'outside.cmd');
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outside, 'outside', { mode: 0o600 });
    fs.linkSync(outside, def.filePath);
    spawnSyncMock.mockReturnValue(result(0, '3'));

    await expect(ensureRunning(opts('win32'))).resolves.toMatchObject({
      running: false,
      runtimeState: 'ready',
    });

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    expect(spawnSyncMock.mock.calls.some(([cmd, args]: [string, string[]]) =>
      isWindowsPowerShellCommand(cmd) &&
      args.join(' ').includes('$registered.Run($null)'))).toBe(false);
  });
});

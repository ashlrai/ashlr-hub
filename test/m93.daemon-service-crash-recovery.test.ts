import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const crashControl = vi.hoisted(() => ({
  at: null as string | null,
  preflightStates: [] as unknown[],
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('../src/core/daemon/launchd-plist-transaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/launchd-plist-transaction.js')>();
  return {
    ...actual,
    installLaunchdPlistTransaction: (
      options: Parameters<typeof actual.installLaunchdPlistTransaction>[0],
    ) => actual.installLaunchdPlistTransaction({
      ...options,
      preflight: options.preflight
        ? (state) => {
            const result = options.preflight!(state);
            crashControl.preflightStates.push(result.recoveryState);
            return result;
          }
        : undefined,
      checkpointHook: (checkpoint) => {
        if (checkpoint === crashControl.at) throw new Error(`simulated crash at ${checkpoint}`);
      },
    }),
  };
});

import * as cp from 'node:child_process';
import { generateServiceDefinition, install } from '../src/core/daemon/service.js';
import type { LaunchdInstallCheckpoint } from '../src/core/daemon/launchd-plist-transaction.js';
import { windowsPowerShellPath } from '../src/core/daemon/windows-task-scripts.js';

const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
const checkpoints: LaunchdInstallCheckpoint[] = [
  'journal-prepared',
  'service-stopped',
  'journal-stopped',
  'plist-replaced',
  'journal-replaced',
  'service-activated',
  'journal-activated',
];
let home: string;

function isWindowsPowerShellCommand(command: string): boolean {
  return command === windowsPowerShellPath();
}

function result(status = 0, stdout = '', stderr = '') {
  return { status, stdout, stderr, error: undefined };
}

function windowsTaskSnapshotFixture(state: string): string {
  return JSON.stringify({
    state,
    taskXmlBase64: Buffer.from('<Task version="1.4">prior-crash</Task>', 'utf8').toString('base64'),
    taskSecurityDescriptorBase64: Buffer.from('D:P(A;;FA;;;SY)', 'utf8').toString('base64'),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  crashControl.at = null;
  crashControl.preflightStates = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-service-crash-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('platform service crash recovery', () => {
  it.each(checkpoints)('restores persisted systemd state before new work after %s', async (checkpoint) => {
    const options = {
      platform: 'linux' as const,
      homeDir: home,
      nodePath: process.execPath,
      binPath: path.join(home, 'bin', 'ashlr'),
      autostart: false,
    };
    const def = generateServiceDefinition(options);
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-unit', { mode: 0o600 });
    const state = { active: true, enabled: true };

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'systemctl') return result();
      if (args.includes('is-active')) return state.active ? result(0, 'active\n') : result(3, 'inactive\n');
      if (args.includes('is-enabled')) return state.enabled ? result(0, 'enabled\n') : result(1, 'disabled\n');
      if (args.includes('show')) return result(0, `${def.filePath}\n`);
      if (args.includes('disable')) state.enabled = false;
      if (args.includes('enable')) state.enabled = true;
      if (args.includes('stop') || args.includes('--now') && args.includes('disable')) state.active = false;
      if (args.includes('start') || args.includes('--now') && args.includes('enable')) state.active = true;
      return result();
    });

    crashControl.at = checkpoint;
    await expect(install(options)).rejects.toThrow(`simulated crash at ${checkpoint}`);
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json')))
      .toHaveLength(1);

    crashControl.at = null;
    await install(options);

    expect(crashControl.preflightStates.at(-1)).toEqual({
      present: true,
      active: true,
      enabled: true,
      fragmentPath: def.filePath,
    });
    expect(state).toEqual({ active: false, enabled: false });
    expect(fs.readFileSync(def.filePath, 'utf8')).toContain('Description=ashlr autonomous daemon');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });

  it.each(checkpoints)('restores persisted Windows state and legacy launcher before new work after %s', async (checkpoint) => {
    const options = {
      platform: 'win32' as const,
      homeDir: home,
      nodePath: process.execPath,
      binPath: path.join(home, 'bin', 'ashlr'),
      autostart: false,
    };
    const def = generateServiceDefinition(options);
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

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (isWindowsPowerShellCommand(cmd)) {
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
      if (args.includes('/Create')) taskState = 'ready';
      return result();
    });

    crashControl.at = checkpoint;
    await expect(install(options)).rejects.toThrow(`simulated crash at ${checkpoint}`);
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json')))
      .toHaveLength(1);

    crashControl.at = null;
    await install(options);

    expect(crashControl.preflightStates.at(-1)).toMatchObject({
      present: true,
      state: 'ready',
      legacyLauncher: true,
      taskXmlBase64: expect.any(String),
      taskXmlSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      taskSecurityDescriptorBase64: expect.any(String),
      taskSecurityDescriptorSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(taskState).toBe('absent');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(
      path.join(path.dirname(def.filePath), 'ashlr-daemon.startup-legacy.cmd.disabled'),
      'utf8',
    )).toBe('legacy');
    expect(fs.readFileSync(def.filePath, 'utf8')).toContain('daemon start');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });

  it.each(['missing', 'duplicated', 'dangling'] as const)(
    'rejects %s persisted Windows legacy evidence before task mutation',
    async (failure) => {
      const options = {
        platform: 'win32' as const,
        homeDir: home,
        nodePath: process.execPath,
        binPath: path.join(home, 'bin', 'ashlr'),
        autostart: false,
      };
      const def = generateServiceDefinition(options);
      fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(def.filePath, 'prior-launcher', { mode: 0o600 });
      const legacy = path.join(
        home,
        'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
        'ashlr-daemon.cmd',
      );
      const archived = path.join(
        path.dirname(def.filePath),
        'ashlr-daemon.startup-legacy.cmd.disabled',
      );
      fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
      fs.writeFileSync(legacy, 'legacy', { mode: 0o600 });

      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (!isWindowsPowerShellCommand(cmd)) return result();
        return result(
          0,
          args.join(' ').includes('GetSecurityDescriptor(7)')
            ? windowsTaskSnapshotFixture('3')
            : '3',
        );
      });

      crashControl.at = 'journal-prepared';
      await expect(install(options)).rejects.toThrow('simulated crash at journal-prepared');
      expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
        .filter((name) => name.endsWith('.journal.json'))).toHaveLength(1);

      let duplicateIdentity: {
        legacy: { dev: number; ino: number };
        archived: { dev: number; ino: number };
      } | undefined;
      if (failure === 'missing') {
        fs.unlinkSync(legacy);
      } else if (failure === 'duplicated') {
        fs.copyFileSync(legacy, archived);
        const legacyStat = fs.lstatSync(legacy);
        const archivedStat = fs.lstatSync(archived);
        duplicateIdentity = {
          legacy: { dev: legacyStat.dev, ino: legacyStat.ino },
          archived: { dev: archivedStat.dev, ino: archivedStat.ino },
        };
      } else {
        fs.unlinkSync(legacy);
        fs.symlinkSync(path.join(home, 'missing-legacy.cmd'), legacy);
      }
      crashControl.at = null;
      spawnSyncMock.mockClear();

      await expect(install(options)).rejects.toThrow(
        'Task Scheduler transaction recovery rejected persisted activation state: ' +
          (failure === 'dangling'
            ? 'unsafe legacy Windows launcher'
            : 'recovery requires exactly one trusted legacy Windows launcher'),
      );

      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-launcher');
      if (duplicateIdentity) {
        const legacyAfter = fs.lstatSync(legacy);
        const archivedAfter = fs.lstatSync(archived);
        expect({
          legacy: { dev: legacyAfter.dev, ino: legacyAfter.ino },
          archived: { dev: archivedAfter.dev, ino: archivedAfter.ino },
        }).toEqual(duplicateIdentity);
        expect(fs.readFileSync(legacy, 'utf8')).toBe('legacy');
        expect(fs.readFileSync(archived, 'utf8')).toBe('legacy');
      }
      if (failure === 'dangling') expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
        .filter((name) => name.endsWith('.journal.json'))).toHaveLength(1);
    },
  );

  it('rejects an unexpected legacy archive when persisted Windows state recorded none', async () => {
    const options = {
      platform: 'win32' as const,
      homeDir: home,
      nodePath: process.execPath,
      binPath: path.join(home, 'bin', 'ashlr'),
      autostart: false,
    };
    const def = generateServiceDefinition(options);
    fs.mkdirSync(path.dirname(def.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(def.filePath, 'prior-launcher', { mode: 0o600 });
    const archived = path.join(
      path.dirname(def.filePath),
      'ashlr-daemon.startup-legacy.cmd.disabled',
    );

    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (!isWindowsPowerShellCommand(cmd)) return result();
      return result(
        0,
        args.join(' ').includes('GetSecurityDescriptor(7)')
          ? windowsTaskSnapshotFixture('3')
          : '3',
      );
    });

    crashControl.at = 'journal-prepared';
    await expect(install(options)).rejects.toThrow('simulated crash at journal-prepared');
    fs.writeFileSync(archived, 'unexpected-archive', { mode: 0o600 });
    const archiveIdentity = fs.lstatSync(archived);
    crashControl.at = null;
    spawnSyncMock.mockClear();

    await expect(install(options)).rejects.toThrow(
      'Task Scheduler transaction recovery rejected persisted activation state: ' +
        'unexpected legacy Windows launcher exists during recovery',
    );

    expect(spawnSyncMock).not.toHaveBeenCalled();
    const after = fs.lstatSync(archived);
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: archiveIdentity.dev,
      ino: archiveIdentity.ino,
    });
    expect(fs.readFileSync(archived, 'utf8')).toBe('unexpected-archive');
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-launcher');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks'))
      .filter((name) => name.endsWith('.journal.json'))).toHaveLength(1);
  });
});

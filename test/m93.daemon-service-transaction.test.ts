import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));

import * as cp from 'node:child_process';
import { ensureRunning, generateServiceDefinition, install, serviceStatus } from '../src/core/daemon/service.js';

const spawnSyncMock = cp.spawnSync as ReturnType<typeof vi.fn>;
let home: string;

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
      if (cmd === 'powershell.exe') return result(0, taskState === 'ready' ? '3' : 'absent');
      if (cmd !== 'schtasks') return result();
      if (args.includes('/Delete')) taskState = 'absent';
      if (args.includes('/Create')) {
        if (++creates === 1) return result(1, '', 'creation denied');
        taskState = 'ready';
      }
      return result();
    });

    await expect(install(opts('win32'))).rejects.toThrow(
      'Task Scheduler transaction activation failed: creation denied',
    );
    expect(fs.readFileSync(def.filePath, 'utf8')).toBe('prior-launcher');
    expect(fs.readFileSync(legacy, 'utf8')).toBe('legacy');
    expect(fs.existsSync(path.join(path.dirname(def.filePath), 'ashlr-daemon.startup-legacy.cmd.disabled'))).toBe(false);
    expect(taskState).toBe('ready');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json'))).toEqual([]);
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
    expect(spawnSyncMock.mock.calls.every(([cmd]) => cmd === 'powershell.exe')).toBe(true);
  });
});

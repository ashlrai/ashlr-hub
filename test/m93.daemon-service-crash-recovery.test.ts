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

function result(status = 0, stdout = '', stderr = '') {
  return { status, stdout, stderr, error: undefined };
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

    expect(crashControl.preflightStates.at(-1)).toEqual({ present: true, active: true, enabled: true });
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
      if (cmd === 'powershell.exe') return result(0, taskState === 'ready' ? '3' : 'absent');
      if (cmd !== 'schtasks') return result();
      if (args.includes('/Delete')) taskState = 'absent';
      if (args.includes('/Create')) taskState = 'ready';
      return result();
    });

    crashControl.at = checkpoint;
    await expect(install(options)).rejects.toThrow(`simulated crash at ${checkpoint}`);
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json')))
      .toHaveLength(1);

    crashControl.at = null;
    await install(options);

    expect(crashControl.preflightStates.at(-1)).toEqual({ present: true, state: 'ready', legacyLauncher: true });
    expect(taskState).toBe('absent');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(
      path.join(path.dirname(def.filePath), 'ashlr-daemon.startup-legacy.cmd.disabled'),
      'utf8',
    )).toBe('legacy');
    expect(fs.readFileSync(def.filePath, 'utf8')).toContain('daemon start');
    expect(fs.readdirSync(path.join(home, '.ashlr', 'locks')).filter((name) => name.endsWith('.journal.json'))).toEqual([]);
  });
});

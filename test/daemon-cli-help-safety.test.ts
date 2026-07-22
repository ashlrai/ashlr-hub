import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const effects = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runDaemon: vi.fn(),
  stopDaemon: vi.fn(),
  loadDaemonState: vi.fn(),
  pendingCount: vi.fn(),
  diagnoseGuardHealth: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  ensureRunning: vi.fn(),
  serviceStatus: vi.fn(),
  serviceOptions: vi.fn(),
}));

const moduleLoads = vi.hoisted(() => ({
  config: 0,
  loop: 0,
  state: 0,
  inbox: 0,
  guardHealth: 0,
  service: 0,
  serviceConfig: 0,
}));

vi.mock('../src/core/config.js', () => {
  moduleLoads.config++;
  return { loadConfig: effects.loadConfig };
});

vi.mock('../src/core/daemon/loop.js', () => {
  moduleLoads.loop++;
  return { runDaemon: effects.runDaemon, stopDaemon: effects.stopDaemon };
});

vi.mock('../src/core/daemon/state.js', () => {
  moduleLoads.state++;
  return { loadDaemonState: effects.loadDaemonState };
});

vi.mock('../src/core/inbox/store.js', () => {
  moduleLoads.inbox++;
  return { pendingCount: effects.pendingCount };
});

vi.mock('../src/core/daemon/guard-health.js', () => {
  moduleLoads.guardHealth++;
  return { diagnoseGuardHealth: effects.diagnoseGuardHealth };
});

vi.mock('../src/core/daemon/service.js', () => {
  moduleLoads.service++;
  return {
    install: effects.install,
    uninstall: effects.uninstall,
    ensureRunning: effects.ensureRunning,
    serviceStatus: effects.serviceStatus,
  };
});

vi.mock('../src/core/daemon/service-config.js', () => {
  moduleLoads.serviceConfig++;
  return { daemonServiceInstallOptions: effects.serviceOptions };
});

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const originalInDaemon = process.env['ASHLR_IN_DAEMON'];
const originalInSwarm = process.env['ASHLR_IN_SWARM'];

let tmpHome: string;
let cmdDaemon: (args: string[]) => Promise<number>;

const daemonState = {
  running: false,
  pid: null,
  startedAt: null,
  lastTickAt: null,
  todayDate: '2026-07-21',
  todaySpentUsd: 0,
  itemsProcessed: 0,
  ticks: [],
};

const serviceStatus = {
  installed: true,
  running: false,
  platformSpec: 'launchd',
  serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
};

async function capture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '));
  });
  try {
    return { code: await cmdDaemon(args), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function expectNoEffectModulesOrCalls(): void {
  expect(moduleLoads).toEqual({
    config: 0,
    loop: 0,
    state: 0,
    inbox: 0,
    guardHealth: 0,
    service: 0,
    serviceConfig: 0,
  });
  for (const effect of Object.values(effects)) {
    expect(effect).not.toHaveBeenCalled();
  }
  expect(fs.readdirSync(tmpHome)).toEqual([]);
}

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-daemon-cli-safety-'));
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
  delete process.env['ASHLR_IN_DAEMON'];
  delete process.env['ASHLR_IN_SWARM'];

  vi.resetModules();
  vi.clearAllMocks();
  for (const key of Object.keys(moduleLoads) as Array<keyof typeof moduleLoads>) {
    moduleLoads[key] = 0;
  }

  effects.loadConfig.mockReturnValue({ daemon: { dailyBudgetUsd: 5, intervalMs: 300_000, parallel: 1 } });
  effects.runDaemon.mockResolvedValue(daemonState);
  effects.loadDaemonState.mockReturnValue(daemonState);
  effects.pendingCount.mockReturnValue(0);
  effects.diagnoseGuardHealth.mockReturnValue({
    generatedAt: '2026-07-21T00:00:00.000Z',
    blocked: false,
    blocks: [],
  });
  effects.serviceStatus.mockReturnValue(serviceStatus);
  effects.ensureRunning.mockResolvedValue({ ...serviceStatus, running: true });
  effects.serviceOptions.mockImplementation((_cfg: unknown, extras: Record<string, unknown> = {}) => ({
    budget: 5,
    intervalMs: 300_000,
    parallel: 1,
    ...extras,
  }));

  ({ cmdDaemon } = await import('../src/cli/daemon.js'));
});

afterEach(() => {
  restoreEnv('HOME', originalHome);
  restoreEnv('USERPROFILE', originalUserProfile);
  restoreEnv('ASHLR_IN_DAEMON', originalInDaemon);
  restoreEnv('ASHLR_IN_SWARM', originalInSwarm);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('daemon help is read-only', () => {
  it.each([
    { args: ['--help'], usage: 'Usage: ashlr daemon [subcommand] [flags]' },
    { args: ['-h'], usage: 'Usage: ashlr daemon [subcommand] [flags]' },
    { args: ['start', '--help'], usage: 'Usage: ashlr daemon start' },
    { args: ['start', '-h'], usage: 'Usage: ashlr daemon start' },
    { args: ['stop', '--help'], usage: 'Usage: ashlr daemon stop' },
    { args: ['stop', '-h'], usage: 'Usage: ashlr daemon stop' },
    { args: ['status', '--help'], usage: 'Usage: ashlr daemon status' },
    { args: ['status', '-h'], usage: 'Usage: ashlr daemon status' },
    { args: ['install', '--help'], usage: 'Usage: ashlr daemon install' },
    { args: ['install', '-h'], usage: 'Usage: ashlr daemon install' },
    { args: ['uninstall', '--help'], usage: 'Usage: ashlr daemon uninstall' },
    { args: ['uninstall', '-h'], usage: 'Usage: ashlr daemon uninstall' },
    { args: ['service-status', '--help'], usage: 'Usage: ashlr daemon service-status' },
    { args: ['service-status', '-h'], usage: 'Usage: ashlr daemon service-status' },
  ])('$args prints usage without loading effect modules', async ({ args, usage }) => {
    const result = await capture(args);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(usage);
    expect(result.stderr).toBe('');
    expectNoEffectModulesOrCalls();
  });

  it('prioritizes help over other subcommand arguments without dispatching', async () => {
    const result = await capture(['install', '--unknown', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: ashlr daemon install');
    expectNoEffectModulesOrCalls();
  });
});

describe('daemon unknown flags fail before effects', () => {
  it.each([
    ['--unknown'],
    ['start', '--unknown'],
    ['stop', '--unknown'],
    ['status', '--unknown'],
    ['install', '--unknown'],
    ['uninstall', '--unknown'],
    ['service-status', '--unknown'],
  ])('%j is a usage error with no imports, calls, or writes', async (...args) => {
    const result = await capture(args);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown flag: --unknown');
    expect(result.stderr).toContain('Usage: ashlr daemon');
    expectNoEffectModulesOrCalls();
  });
});

describe('daemon valid flags remain supported', () => {
  it('preserves install --no-autostart without starting the service', async () => {
    const result = await capture(['install', '--no-autostart']);

    expect(result.code).toBe(0);
    expect(effects.install).toHaveBeenCalledWith(expect.objectContaining({ autostart: false }));
    expect(effects.serviceStatus).toHaveBeenCalledOnce();
    expect(effects.ensureRunning).not.toHaveBeenCalled();
  });

  it('preserves status --json', async () => {
    const result = await capture(['status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ running: false, pendingProposals: 0 });
    expect(effects.loadDaemonState).toHaveBeenCalledOnce();
  });

  it('preserves service-status --json', async () => {
    const result = await capture(['service-status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(serviceStatus);
    expect(effects.serviceStatus).toHaveBeenCalledOnce();
  });

  it('preserves all start flags and config overrides', async () => {
    const result = await capture([
      'start',
      '--once',
      '--dry-run',
      '--drain',
      'diagnostic-reslices',
      '--limit',
      '4',
      '--budget',
      '7.5',
      '--interval',
      '45000',
      '--parallel',
      '3',
    ]);

    expect(result.code).toBe(0);
    expect(effects.runDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        daemon: expect.objectContaining({ dailyBudgetUsd: 7.5, intervalMs: 45_000, parallel: 3 }),
      }),
      { once: true, dryRun: true, drain: 'diagnostic-reslices', drainLimit: 4 },
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const effects = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadConfigReadOnly: vi.fn(),
  loadConfigReadOnlyStrict: vi.fn(),
  runDaemon: vi.fn(),
  stopDaemon: vi.fn(),
  loadDaemonState: vi.fn(),
  loadDaemonStateStrict: vi.fn(),
  pendingCount: vi.fn(),
  diagnoseGuardHealth: vi.fn(),
  inspectProductionActivationReadiness: vi.fn(),
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
  productionActivationReadiness: 0,
  service: 0,
  serviceConfig: 0,
}));

vi.mock('../src/core/config.js', () => {
  moduleLoads.config++;
  return {
    loadConfig: effects.loadConfig,
    loadConfigReadOnly: effects.loadConfigReadOnly,
    loadConfigReadOnlyStrict: effects.loadConfigReadOnlyStrict,
  };
});

vi.mock('../src/core/daemon/loop.js', () => {
  moduleLoads.loop++;
  return { runDaemon: effects.runDaemon, stopDaemon: effects.stopDaemon };
});

vi.mock('../src/core/daemon/state.js', () => {
  moduleLoads.state++;
  return {
    loadDaemonState: effects.loadDaemonState,
    loadDaemonStateStrict: effects.loadDaemonStateStrict,
  };
});

vi.mock('../src/core/inbox/store.js', () => {
  moduleLoads.inbox++;
  return { pendingCount: effects.pendingCount };
});

vi.mock('../src/core/daemon/guard-health.js', () => {
  moduleLoads.guardHealth++;
  return { diagnoseGuardHealth: effects.diagnoseGuardHealth };
});

vi.mock('../src/core/daemon/production-activation-readiness.js', () => {
  moduleLoads.productionActivationReadiness++;
  return {
    inspectProductionActivationReadinessV1: effects.inspectProductionActivationReadiness,
  };
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
  registrationState: 'present' as const,
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
    productionActivationReadiness: 0,
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
  effects.loadConfigReadOnly.mockReturnValue({ daemon: { dailyBudgetUsd: 5, intervalMs: 300_000, parallel: 1 } });
  effects.loadConfigReadOnlyStrict.mockReturnValue({ daemon: { dailyBudgetUsd: 5, intervalMs: 300_000, parallel: 1 } });
  effects.runDaemon.mockResolvedValue(daemonState);
  effects.loadDaemonState.mockReturnValue(daemonState);
  effects.loadDaemonStateStrict.mockReturnValue({ ok: true, state: daemonState, fresh: false });
  effects.pendingCount.mockReturnValue(0);
  effects.diagnoseGuardHealth.mockReturnValue({
    generatedAt: '2026-07-21T00:00:00.000Z',
    blocked: false,
    blocks: [],
  });
  effects.inspectProductionActivationReadiness.mockReturnValue({
    schemaVersion: 1,
    authority: 'observation-only',
    verdict: 'blocked',
    topBlocker: {
      code: 'artifact-packaging-incompatible',
      source: 'artifact',
      detail: 'published artifact lacks required lockfile evidence',
    },
    authorityFlags: {
      admissionPermitted: false,
      activationPermitted: false,
      deployPermitted: false,
      installPermitted: false,
      launchPermitted: false,
      lifecycleMutationPermitted: false,
      releaseSettlementPermitted: false,
      rollbackPermitted: false,
      startPermitted: false,
    },
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

  it('marks resident service installation unavailable without loading effect modules', async () => {
    const result = await capture(['install', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('temporarily unavailable');
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
  it('preserves status --json', async () => {
    const result = await capture(['status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      running: false,
      pendingProposals: 0,
      productionActivationReadiness: {
        schemaVersion: 1,
        verdict: 'blocked',
        topBlocker: { code: 'artifact-packaging-incompatible' },
        authorityFlags: {
          activationPermitted: false,
          lifecycleMutationPermitted: false,
          startPermitted: false,
        },
      },
    });
    expect(effects.loadDaemonStateStrict).toHaveBeenCalledOnce();
    expect(effects.loadDaemonState).not.toHaveBeenCalled();
    expect(effects.inspectProductionActivationReadiness).toHaveBeenCalledWith();
  });

  it('keeps a blocked production verdict when readiness inspection fails', async () => {
    effects.inspectProductionActivationReadiness.mockImplementationOnce(() => {
      throw new Error('inspection unavailable');
    });

    const result = await capture(['status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      productionActivationReadiness: {
        schemaVersion: 1,
        authority: 'observation-only',
        verdict: 'blocked',
        topBlocker: { code: 'production-authority-chain-absent' },
        sourceQuality: { sourceState: 'degraded', complete: false },
        authorityFlags: {
          activationPermitted: false,
          lifecycleMutationPermitted: false,
          startPermitted: false,
        },
      },
    });
  });

  it('preserves service-status --json', async () => {
    const result = await capture(['service-status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ...serviceStatus,
      activity: 'inactive',
    });
    expect(effects.serviceStatus).toHaveBeenCalledOnce();
  });

  it('does not recommend the unavailable install command when no service is present', async () => {
    effects.serviceStatus.mockReturnValue({
      registrationState: 'absent',
      installed: false,
      running: false,
      platformSpec: 'launchd',
      serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
    });

    const result = await capture(['service-status']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Resident service installation is temporarily unavailable');
    expect(result.stdout).toContain('One-shot admitted workflows remain available');
    expect(result.stdout).not.toContain('Run `ashlr daemon install`');
  });

  it.each(['running', 'queued'] as const)(
    'reports scheduler %s without claiming the daemon is running or stopped',
    async (runtimeState) => {
      effects.serviceStatus.mockReturnValue({
        registrationState: 'present',
        installed: true,
        running: false,
        runtimeState,
        platformSpec: 'schtasks',
        serviceFilePath: 'C:\\Users\\worker\\.ashlr\\services\\ashlr-daemon.cmd',
      });

      const result = await capture(['service-status']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`unverified (scheduler ${runtimeState})`);
      expect(result.stdout).not.toContain('running:    no');
    },
  );

  it('includes the bounded scheduler activity distinction in JSON status', async () => {
    effects.serviceStatus.mockReturnValue({
      registrationState: 'present',
      installed: true,
      running: false,
      runtimeState: 'queued',
      platformSpec: 'schtasks',
      serviceFilePath: 'C:\\Users\\worker\\.ashlr\\services\\ashlr-daemon.cmd',
    });

    const result = await capture(['service-status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      running: false,
      runtimeState: 'queued',
      activity: 'scheduler-active-unverified',
    });
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

  it('returns nonzero and surfaces a structured activation refusal', async () => {
    effects.runDaemon.mockResolvedValue({
      ...daemonState,
      startRefusal: 'activation trust roots unavailable',
    });

    const result = await capture(['start', '--once']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'daemon start refused: activation trust roots unavailable',
    );
  });

  it('refuses start before the daemon loop when strict config loading fails', async () => {
    effects.loadConfigReadOnlyStrict.mockImplementationOnce(() => {
      throw new Error('config is not valid JSON');
    });

    const result = await capture(['start', '--once']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Failed to load config: config is not valid JSON');
    expect(effects.runDaemon).not.toHaveBeenCalled();
  });
});

describe('daemon install authority boundary', () => {
  it.each([
    { args: ['install'], autostart: true },
    { args: ['install', '--no-autostart'], autostart: false },
  ])('reports the shared service refusal for $args', async ({ args }) => {
    const result = await capture(args);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'daemon service installation is temporarily unavailable: '
      + 'resident service install/reinstall/repair/restart authority is unavailable',
    );
    expect(result.stderr).toContain('No config or service state was inspected or changed');
    expect(moduleLoads.config).toBe(0);
    expect(moduleLoads.service).toBe(0);
    expect(moduleLoads.serviceConfig).toBe(0);
    expect(effects.loadConfig).not.toHaveBeenCalled();
    expect(effects.loadConfigReadOnly).not.toHaveBeenCalled();
    expect(effects.loadConfigReadOnlyStrict).not.toHaveBeenCalled();
    expect(effects.serviceOptions).not.toHaveBeenCalled();
    expect(effects.install).not.toHaveBeenCalled();
    expect(effects.ensureRunning).not.toHaveBeenCalled();
    expect(effects.serviceStatus).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpHome)).toEqual([]);
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  activationTransaction: 0,
}));

const activationControl = vi.hoisted(() => ({
  result: null as null | Record<string, unknown>,
}));

vi.mock('../src/core/daemon/runtime-activation-transaction.js', async (importOriginal) => {
  moduleLoads.activationTransaction++;
  const original = await importOriginal<typeof import(
    '../src/core/daemon/runtime-activation-transaction.js'
  )>();
  return {
    ...original,
    activateRuntimeRelease: async (input: Parameters<typeof original.activateRuntimeRelease>[0]) =>
      activationControl.result ?? original.activateRuntimeRelease(input),
  };
});

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
    service: 0,
    serviceConfig: 0,
    activationTransaction: 0,
  });
  for (const effect of Object.values(effects)) {
    expect(effect).not.toHaveBeenCalled();
  }
  expect(fs.readdirSync(tmpHome)).toEqual([]);
}

beforeAll(async () => {
  // Warm the static ESM import graph once, before any per-test module-load
  // counting begins.
  //
  // `assertResidentServiceInstallAuthorized` (used by the `install`
  // subcommand) is imported statically at the top of src/cli/daemon.ts, and
  // it statically imports service-install-authority.js -> activation-permit.js
  // -> guard-health.js (guard-health-healthy is one of the authority
  // preconditions). Static ES module imports are linked and executed the
  // FIRST time anything in this worker imports daemon.js, regardless of
  // which subcommand is actually requested — including `--help`. That one-
  // time link cost is not undone by vi.resetModules() (it clears vitest's
  // mock/import registry for subsequent dynamic imports, not an
  // already-linked static graph). Importing daemon.js here, before the real
  // tests' `moduleLoads` counters start getting asserted on, absorbs that
  // unavoidable one-time cost so every real test sees a clean count.
  await import('../src/cli/daemon.js');
});

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-daemon-cli-safety-'));
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
  delete process.env['ASHLR_IN_DAEMON'];
  delete process.env['ASHLR_IN_SWARM'];

  vi.resetModules();
  vi.clearAllMocks();
  activationControl.result = null;
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
    { args: ['activation-preflight', '--help'], usage: 'Usage: ashlr daemon activation-preflight' },
    { args: ['activation-preflight', '-h'], usage: 'Usage: ashlr daemon activation-preflight' },
    { args: ['activate', '--help'], usage: 'Usage: ashlr daemon activate' },
    { args: ['activate', '-h'], usage: 'Usage: ashlr daemon activate' },
    { args: ['recover-state', '--help'], usage: 'Usage: ashlr daemon recover-state' },
    { args: ['recover-state', '-h'], usage: 'Usage: ashlr daemon recover-state' },
    { args: ['resolve-state', '--help'], usage: 'Usage: ashlr daemon resolve-state' },
    { args: ['resolve-state', '-h'], usage: 'Usage: ashlr daemon resolve-state' },
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
    ['activation-preflight', '--unknown'],
    ['activate', '--unknown'],
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
  it.skipIf(process.platform !== 'darwin')('keeps explicit activation read-only when HOME is poisoned', async () => {
    const result = await capture([
      'activate',
      '--request',
      '/definitely/not-read/activation-plan.json',
      '--authorize',
      'a'.repeat(64),
      '--confirm',
      'a'.repeat(64),
      '--json',
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      activated: false,
      phase: 'blocked',
      reason: 'runtime activation HOME does not match the operating-system account home',
      rollbackRestored: false,
    });
    expect(result.stderr).toBe('');
    expect(moduleLoads).toMatchObject({
      config: 0,
      loop: 0,
      state: 0,
      inbox: 0,
      service: 0,
      serviceConfig: 0,
      activationTransaction: 1,
    });
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpHome)).toEqual([]);
  });

  it.each([
    {
      name: 'pre-journal refusal',
      result: { activated: false, durableOutcome: 'none', recoveryJournalRetained: false },
      message: 'refused before a transaction journal was retained',
    },
    {
      name: 'retained recovery journal',
      result: { activated: false, durableOutcome: 'none', recoveryJournalRetained: true },
      message: 'authenticated recovery journal retained; reconciliation required',
    },
    {
      name: 'restored prior state',
      result: { activated: false, durableOutcome: 'restored-prior', recoveryJournalRetained: false },
      message: 'exact prior stopped state restored; recovery journal removed',
    },
    {
      name: 'receipt-settled candidate with removed journal',
      result: { activated: true, durableOutcome: 'settled-candidate', recoveryJournalRetained: false },
      message: 'durable receipt committed the candidate stopped release; recovery journal removed',
    },
  ])('reports the actual $name outcome', async ({ result, message }) => {
    activationControl.result = {
      admissionDigest: 'a'.repeat(64),
      activationId: '123e4567-e89b-42d3-a456-426614174520',
      candidateLaunchReceiptSha256: null,
      candidateRevision: 'b'.repeat(40),
      canonicalRequestSha256: null,
      phase: result.activated ? 'activated-stopped' : 'blocked',
      planDigest: 'c'.repeat(64),
      reason: 'fixture outcome',
      rollbackLaunchReceiptSha256: null,
      rollbackRestored: result.durableOutcome === 'restored-prior',
      serviceEnabledChanged: false,
      serviceStarted: false,
      trustRootCanonicalSha256: null,
      ...result,
    };
    const observed = await capture([
      'activate',
      '--request',
      '/absolute/fixture-plan.json',
      '--authorize',
      'a'.repeat(64),
      '--confirm',
      'a'.repeat(64),
    ]);
    expect(observed.stdout).toContain(message);
    expect(observed.stdout).not.toContain(
      message === 'refused before a transaction journal was retained'
        ? 'authenticated recovery journal retained; reconciliation required'
        : 'refused before a transaction journal was retained',
    );
    expect(observed.code).toBe(result.activated ? 0 : 1);
  });

  it('reports settled journal-B identity without inheriting concurrent plan-A evidence', async () => {
    activationControl.result = {
      admissionDigest: 'b'.repeat(64),
      activationId: '223e4567-e89b-42d3-a456-426614174520',
      activated: true,
      candidateLaunchReceiptSha256: null,
      candidateRevision: 'c'.repeat(40),
      canonicalRequestSha256: null,
      durableOutcome: 'settled-candidate',
      phase: 'activated-stopped',
      planDigest: 'd'.repeat(64),
      reason: 'authenticated raced stopped-release receipt settled',
      recoveryJournalRetained: false,
      rollbackLaunchReceiptSha256: null,
      rollbackRestored: false,
      serviceEnabledChanged: false,
      serviceStarted: false,
      trustRootCanonicalSha256: null,
    };
    const observed = await capture([
      'activate',
      '--request',
      '/absolute/concurrent-plan-a.json',
      '--authorize',
      'a'.repeat(64),
      '--confirm',
      'a'.repeat(64),
      '--json',
    ]);
    expect(observed.code).toBe(0);
    expect(JSON.parse(observed.stdout)).toMatchObject({
      activationId: '223e4567-e89b-42d3-a456-426614174520',
      candidateRevision: 'c'.repeat(40),
      admissionDigest: 'b'.repeat(64),
      planDigest: 'd'.repeat(64),
      canonicalRequestSha256: null,
      trustRootCanonicalSha256: null,
      candidateLaunchReceiptSha256: null,
      rollbackLaunchReceiptSha256: null,
      activated: true,
      durableOutcome: 'settled-candidate',
    });
  });

  it('keeps all identity unknown for an unauthenticated retained journal-B race', async () => {
    activationControl.result = {
      admissionDigest: null,
      activationId: null,
      activated: false,
      candidateLaunchReceiptSha256: null,
      candidateRevision: null,
      canonicalRequestSha256: null,
      durableOutcome: 'none',
      phase: 'blocked',
      planDigest: null,
      reason: 'runtime activation recovery journal authentication failed',
      recoveryJournalRetained: true,
      rollbackLaunchReceiptSha256: null,
      rollbackRestored: false,
      serviceEnabledChanged: false,
      serviceStarted: false,
      trustRootCanonicalSha256: null,
    };
    const observed = await capture([
      'activate',
      '--request',
      '/absolute/concurrent-plan-a.json',
      '--authorize',
      'a'.repeat(64),
      '--confirm',
      'a'.repeat(64),
      '--json',
    ]);
    expect(observed.code).toBe(1);
    expect(JSON.parse(observed.stdout)).toMatchObject({
      activationId: null,
      candidateRevision: null,
      admissionDigest: null,
      planDigest: null,
      canonicalRequestSha256: null,
      trustRootCanonicalSha256: null,
      candidateLaunchReceiptSha256: null,
      rollbackLaunchReceiptSha256: null,
      activated: false,
      recoveryJournalRetained: true,
    });
  });

  it('preserves status --json', async () => {
    const result = await capture(['status', '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ running: false, pendingProposals: 0 });
    expect(effects.loadDaemonStateStrict).toHaveBeenCalledOnce();
    expect(effects.loadDaemonState).not.toHaveBeenCalled();
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

  it('returns nonzero so the resident service restarts after a terminal persistence failure', async () => {
    effects.runDaemon.mockResolvedValue({
      ...daemonState,
      terminalFailure: 'daemon-state-persistence-failed',
    });

    const result = await capture(['start']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'daemon stopped after terminal failure: daemon-state-persistence-failed',
    );
  });

  it('keeps an ordinary operator-requested stop successful', async () => {
    effects.runDaemon.mockResolvedValue({ ...daemonState });

    const result = await capture(['start']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
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
    // The refused authority check itself is audited (M21 append-only audit
    // trail — every daemon-activation:install-check is logged, granted or
    // denied). That is the ONLY footprint a refusal may leave: no config,
    // no daemon state, no service/control files. Assert the shape precisely
    // rather than allowing an empty-HOME check to silently accept a future
    // regression that starts touching real state.
    expect(fs.readdirSync(tmpHome)).toEqual(['.ashlr']);
    expect(fs.readdirSync(path.join(tmpHome, '.ashlr'))).toEqual(['audit']);
    const auditFiles = fs.readdirSync(path.join(tmpHome, '.ashlr', 'audit'));
    expect(auditFiles).toHaveLength(1);
    expect(auditFiles[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
  });
});

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  loadAuthority: vi.fn(),
  runController: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: mocks.fork };
});

vi.mock('../src/core/daemon/launchd-retry-transport.js', () => ({
  loadLaunchdRetryExternalAuthority: mocks.loadAuthority,
}));

vi.mock('../src/core/daemon/launchd-retry-controller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/launchd-retry-controller.js')>();
  return { ...actual, runLaunchdRetryController: mocks.runController };
});

import { runLaunchdSupervisorBootstrap } from '../src/core/daemon/launchd-supervisor-bootstrap.js';
import { runLaunchdSupervisor } from '../src/core/daemon/launchd-supervisor-runtime.js';

const RELEASE = 'a'.repeat(40);
const NODE = '/opt/ashlr/node';
const CHILD = '/opt/ashlr/dist/cli/launchd-daemon-child.js';
const VALID_ARGS = [
  '--release', RELEASE,
  '--node', NODE,
  '--child', CHILD,
  '--budget', '5',
  '--interval', '300000',
  '--parallel', '1',
] as const;

function controllerResult(reason: 'daemon-disposition-invalid' | 'healthy-completion') {
  return {
    exitCode: 0 as const,
    reason,
    daemonInvoked: true,
    claimNumber: 1,
    attemptsRemaining: reason === 'healthy-completion' ? 3 : 2,
    externalAuthority: 'verified' as const,
  };
}

function terminalDisposition() {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
    termination: {
      reason: 'clean-completion' as const,
      retryable: false,
      exitCode: 0 as const,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAuthority.mockResolvedValue({ currentReceipt: {}, compareAndSwap: vi.fn() });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('M471 one-shot launchd supervisor', () => {
  it('settles invalid supervisor argv without loading authority or spawning', async () => {
    expect(await runLaunchdSupervisor(['--release', RELEASE])).toEqual({
      exitCode: 0,
      reason: 'invalid-supervisor-argv',
    });
    expect(mocks.loadAuthority).not.toHaveBeenCalled();
    expect(mocks.runController).not.toHaveBeenCalled();
    expect(mocks.fork).not.toHaveBeenCalled();
  });

  it('settles bootstrap import and preload failures at zero', async () => {
    const loader = vi.fn(async () => {
      throw new Error('supervisor runtime unavailable');
    });
    expect(await runLaunchdSupervisorBootstrap(VALID_ARGS, loader)).toBe(0);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('leaves a missing supervisor entrypoint as a single failed process', async () => {
    const childProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const result = childProcess.spawnSync(process.execPath, [
      '/definitely-missing/ashlr-launchd-supervisor.js',
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MODULE_NOT_FOUND');
  });

  it('ships with no production external CAS transport', async () => {
    const actual = await vi.importActual<
      typeof import('../src/core/daemon/launchd-retry-transport.js')
    >('../src/core/daemon/launchd-retry-transport.js');
    await expect(actual.loadLaunchdRetryExternalAuthority()).resolves.toBeUndefined();
  });

  it('turns child spawn failure into a terminal controller disposition', async () => {
    mocks.fork.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    mocks.runController.mockImplementation(async (options: { runDaemon: () => Promise<unknown> }) => {
      await expect(options.runDaemon()).rejects.toThrow('launchd daemon child spawn failed');
      return controllerResult('daemon-disposition-invalid');
    });

    expect(await runLaunchdSupervisor(VALID_ARGS)).toMatchObject({
      exitCode: 0,
      reason: 'controller-settled',
      controller: { reason: 'daemon-disposition-invalid' },
    });
    expect(mocks.fork).toHaveBeenCalledOnce();
  });

  it('turns missing child module or preload result into a terminal disposition', async () => {
    const child = new EventEmitter();
    mocks.fork.mockReturnValue(child);
    mocks.runController.mockImplementation(async (options: { runDaemon: () => Promise<unknown> }) => {
      const pending = options.runDaemon();
      queueMicrotask(() => child.emit('exit', 1, null));
      await expect(pending).rejects.toThrow('launchd daemon child disposition unavailable');
      return controllerResult('daemon-disposition-invalid');
    });

    expect(await runLaunchdSupervisor(VALID_ARGS)).toMatchObject({
      exitCode: 0,
      controller: { reason: 'daemon-disposition-invalid' },
    });
  });

  it('forks only the exact child entrypoint and accepts one exact disposition', async () => {
    const child = new EventEmitter();
    mocks.fork.mockReturnValue(child);
    vi.stubEnv('NODE_OPTIONS', '--require=/tmp/attacker.js');
    vi.stubEnv('DYLD_INSERT_LIBRARIES', '/tmp/attacker.dylib');
    mocks.runController.mockImplementation(async (options: { runDaemon: () => Promise<unknown> }) => {
      const pending = options.runDaemon();
      queueMicrotask(() => {
        child.emit('message', {
          protocol: 'ashlr-launchd-daemon-child-result-v1',
          result: terminalDisposition(),
        });
        child.emit('exit', 0, null);
      });
      await expect(pending).resolves.toMatchObject({
        termination: { reason: 'clean-completion', exitCode: 0 },
      });
      return controllerResult('healthy-completion');
    });

    await expect(runLaunchdSupervisor(VALID_ARGS)).resolves.toMatchObject({
      exitCode: 0,
      controller: { reason: 'healthy-completion' },
    });
    expect(mocks.fork).toHaveBeenCalledWith(CHILD, [
      '--release', RELEASE,
      '--budget', '5',
      '--interval', '300000',
      '--parallel', '1',
    ], expect.objectContaining({
      execPath: NODE,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: expect.objectContaining({ ASHLR_LAUNCHD_SUPERVISOR: '1' }),
    }));
    const childEnv = mocks.fork.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(childEnv).not.toHaveProperty('NODE_OPTIONS');
    expect(childEnv).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
  });

  it('keeps the executable entrypoint free of static project imports', () => {
    const path = fileURLToPath(new URL('../src/cli/launchd-supervisor.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/^import\s.+from\s/m);
    expect(source).toContain("await import('../core/daemon/launchd-supervisor-bootstrap.js')");
    expect(source).toContain('process.exitCode = 0');
  });
});

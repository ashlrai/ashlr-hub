/**
 * V3.10 Track B (U5): the daemon CLI surface this unit adds.
 *
 *  - `daemon start --until <HH:MM|ISO> | --iterations <n> | --until-paused`
 *    reaches runDaemon as a validated run window, and every bad stop rule is
 *    refused at parse time — BEFORE config or the loop load (nothing starts).
 *  - `daemon doctor [--clear-stale] [--json]` proves liveness instead of
 *    repeating daemon.json's claim (the pid-850 reading).
 *  - `daemon status --json` carries `runningVerified` + `liveness`.
 *
 * runDaemon is a mock: no daemon is ever started. State files are written
 * only under the per-worker tmp HOME (test/setup/home.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const effects = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  runDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));

vi.mock('../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/config.js')>();
  return {
    ...actual,
    loadConfig: effects.loadConfig,
    loadConfigReadOnly: effects.loadConfig,
    loadConfigReadOnlyStrict: effects.loadConfig,
  };
});

vi.mock('../src/core/daemon/loop.js', () => ({ runDaemon: effects.runDaemon, stopDaemon: effects.stopDaemon }));

import { cmdDaemon } from '../src/cli/daemon.js';
import { daemonLockPath, loadDaemonStateStrict, saveDaemonState } from '../src/core/daemon/state.js';
import { resetDaemonLivenessCache } from '../src/core/daemon/liveness.js';
import type { DaemonState } from '../src/core/types.js';

/** Out of every platform's pid range: kill(pid, 0) is ESRCH for real. */
const DEAD_PID = 9_999_999;
/**
 * The real pid-850 shape: after a reboot the recorded pid belonged to a ROOT
 * process, so kill(pid, 0) answered EPERM and master's reconcile kept
 * `running: true` ("conservatively alive"). pid 1 (launchd / init) is root on
 * every host this runs on — signal 0 sends nothing. Under a root test runner
 * EPERM cannot happen, so those cases are skipped there.
 */
const FOREIGN_PID = 1;
const runnerIsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const idleState: DaemonState = {
  running: false,
  pid: null,
  startedAt: null,
  lastTickAt: null,
  todayDate: '2026-09-24',
  todaySpentUsd: 0,
  itemsProcessed: 0,
  ticks: [],
} as DaemonState;

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...v: unknown[]) => { out.push(v.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...v: unknown[]) => { err.push(v.map(String).join(' ')); });
  try {
    return { code: await cmdDaemon(args), stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

function writeRecord(over: Partial<DaemonState>): void {
  saveDaemonState({ ...idleState, startedAt: '2026-08-21T01:36:00.000Z', lastTickAt: '2026-09-01T19:10:00.000Z', ...over } as DaemonState);
}

function writeLock(pid: number, heartbeatAt: string): void {
  const path = daemonLockPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ pid, token: 't'.repeat(32), hostname: 'test', acquiredAt: heartbeatAt, heartbeatAt }), { mode: 0o600 });
}

const savedInDaemon = process.env['ASHLR_IN_DAEMON'];
const savedInSwarm = process.env['ASHLR_IN_SWARM'];

beforeEach(() => {
  delete process.env['ASHLR_IN_DAEMON'];
  delete process.env['ASHLR_IN_SWARM'];
  effects.loadConfig.mockReset();
  effects.runDaemon.mockReset();
  effects.stopDaemon.mockReset();
  effects.loadConfig.mockReturnValue({ daemon: { dailyBudgetUsd: 5, intervalMs: 300_000, parallel: 1 } });
  effects.runDaemon.mockResolvedValue(idleState);
  resetDaemonLivenessCache();
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

afterEach(() => {
  if (savedInDaemon === undefined) delete process.env['ASHLR_IN_DAEMON'];
  else process.env['ASHLR_IN_DAEMON'] = savedInDaemon;
  if (savedInSwarm === undefined) delete process.env['ASHLR_IN_SWARM'];
  else process.env['ASHLR_IN_SWARM'] = savedInSwarm;
  resetDaemonLivenessCache();
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('daemon start: bounded runs', () => {
  it('--iterations n reaches runDaemon as an after-iterations window', async () => {
    const result = await run(['start', '--iterations', '3']);
    expect(result.code).toBe(0);
    expect(effects.runDaemon).toHaveBeenCalledTimes(1);
    expect(effects.runDaemon.mock.calls[0]![1]).toMatchObject({ once: false, dryRun: false, runWindow: { kind: 'after-iterations', iterations: 3 } });
    expect(result.stdout).toMatch(/run window: .*ends by pausing, never by the kill switch/);
  });

  it('--until-paused and --until <ISO> reach runDaemon unchanged', async () => {
    expect((await run(['start', '--until-paused'])).code).toBe(0);
    expect(effects.runDaemon.mock.calls[0]![1]).toMatchObject({ runWindow: { kind: 'until-paused' } });
    const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect((await run(['start', '--until', at])).code).toBe(0);
    expect(effects.runDaemon.mock.calls[1]![1]).toMatchObject({ runWindow: { kind: 'at-time', at } });
  });

  it('--until HH:MM resolves to the next occurrence of that wall-clock time', async () => {
    const soon = new Date(Date.now() + 90 * 60_000);
    const hhmm = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
    expect((await run(['start', '--until', hhmm])).code).toBe(0);
    const window = (effects.runDaemon.mock.calls[0]![1] as { runWindow: { kind: string; at: string } }).runWindow;
    expect(window.kind).toBe('at-time');
    const atMs = Date.parse(window.at);
    expect(atMs).toBeGreaterThan(Date.now());
    expect(atMs).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
  });

  it.each([
    { args: ['--iterations', '0'], message: /--iterations requires a whole number from 1 to 500/ },
    { args: ['--iterations', '501'], message: /--iterations requires a whole number from 1 to 500/ },
    { args: ['--iterations', 'lots'], message: /--iterations requires a whole number/ },
    { args: ['--iterations'], message: /--iterations requires a whole number/ },
    { args: ['--until'], message: /--until requires a time/ },
    { args: ['--until', '25:00'], message: /HH:MM/ },
    { args: ['--until', 'tomorrow'], message: /neither HH:MM nor an ISO-8601 instant/ },
    { args: ['--until', new Date(Date.now() - 3_600_000).toISOString()], message: /in the past/ },
    { args: ['--iterations', '2', '--until-paused'], message: /choose one stop rule/ },
    { args: ['--until-paused', '--until-paused'], message: /choose one stop rule/ },
    { args: ['--once', '--iterations', '2'], message: /cannot be combined with --once/ },
    { args: ['--dry-run', '--until-paused'], message: /cannot be combined with --dry-run/ },
  ])('refuses $args at parse time, before config loads or the loop runs', async ({ args, message }) => {
    const result = await run(['start', ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(effects.runDaemon).not.toHaveBeenCalled();
    expect(effects.loadConfig).not.toHaveBeenCalled();
  });

  it('documents the stop rules in `start --help` without loading anything', async () => {
    const result = await run(['start', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--until <HH:MM\|ISO instant> \| --iterations <n> \| --until-paused/);
    expect(effects.runDaemon).not.toHaveBeenCalled();
  });
});

describe('daemon doctor', () => {
  it('reports the pid-850 reading as stale, NOT running, and exits 1', async () => {
    writeRecord({ running: true, pid: DEAD_PID });
    writeLock(DEAD_PID, '2026-09-01T19:10:00.000Z');
    const result = await run(['doctor', '--json']);
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as { liveness: { state: string; alive: boolean | null; staleRecord: boolean }; cleared: unknown };
    expect(body.liveness).toMatchObject({ state: 'stale', alive: false, staleRecord: true });
    expect(body.cleared).toBeNull();
    // Read-only without --clear-stale.
    const loaded = loadDaemonStateStrict({ preserveOwnerIdentity: true });
    expect(loaded.ok && loaded.state.running).toBe(true);
  });

  it('--clear-stale rewrites the provably stale record and exits 0', async () => {
    writeRecord({ running: true, pid: DEAD_PID });
    writeLock(DEAD_PID, '2026-09-01T19:10:00.000Z');
    const result = await run(['doctor', '--clear-stale']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/running: +no/);
    const loaded = loadDaemonStateStrict({ preserveOwnerIdentity: true });
    expect(loaded.ok && loaded.state.running).toBe(false);
    expect(loaded.ok && loaded.state.pid).toBeNull();
  });

  it.skipIf(runnerIsRoot)('sees through a recorded pid now owned by a root process (EPERM)', async () => {
    writeRecord({ running: true, pid: FOREIGN_PID });
    writeLock(FOREIGN_PID, '2026-09-01T19:10:00.000Z');
    const result = await run(['doctor', '--json']);
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as { liveness: { state: string; reason: string } };
    expect(body.liveness.state).toBe('stale');
    expect(body.liveness.reason).toMatch(/another user's process/);
  });

  it('a stopped daemon is healthy: exit 0, nothing to clear', async () => {
    writeRecord({ running: false, pid: null });
    const result = await run(['doctor']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/record: +says not running/);
    expect(result.stdout).not.toMatch(/--clear-stale/);
  });

  it('refuses unknown flags before doing anything', async () => {
    const result = await run(['doctor', '--fix']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown flag: --fix|--fix/);
  });
});

describe('daemon status --json', () => {
  it.skipIf(runnerIsRoot)('says what liveness PROVES next to what daemon.json claims (pid reused by a root process)', async () => {
    writeRecord({ running: true, pid: FOREIGN_PID });
    writeLock(FOREIGN_PID, '2026-09-01T19:10:00.000Z');
    const result = await run(['status', '--json']);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { running: boolean | null; runningVerified: boolean | null; liveness: { state: string; staleRecord: boolean } | null };
    // master's reconcile keeps the claim on EPERM …
    expect(body.running).toBe(true);
    // … liveness does not.
    expect(body.runningVerified).toBe(false);
    expect(body.liveness).toMatchObject({ state: 'stale', staleRecord: true });
  });

  it.skipIf(runnerIsRoot)('prints the stale record and the fix in the human view', async () => {
    writeRecord({ running: true, pid: FOREIGN_PID });
    writeLock(FOREIGN_PID, '2026-09-01T19:10:00.000Z');
    const result = await run(['status']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/running: +no — stale record: /);
    expect(result.stdout).toMatch(/ashlr daemon doctor --clear-stale/);
  });

  it('an idle daemon reads as idle, with liveness agreeing', async () => {
    writeRecord({ running: false, pid: null });
    const result = await run(['status', '--json']);
    const body = JSON.parse(result.stdout) as { running: boolean | null; runningVerified: boolean | null; liveness: { state: string } | null };
    expect(body).toMatchObject({ running: false, runningVerified: false, liveness: { state: 'stopped' } });
  });
});

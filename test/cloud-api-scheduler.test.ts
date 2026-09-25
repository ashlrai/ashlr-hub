/**
 * 3.11 cloud lane, unit C2 — the background scheduler in cloud-api.ts.
 *
 * Fake timers and injected jobs: nothing here refreshes from GitHub or
 * launches a cloud session. The cloud core is module-mocked so importing
 * cloud-api.ts pulls in no real store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const core = vi.hoisted(() => ({ refreshCloudTasks: vi.fn(), runSelfImprove: vi.fn() }));

vi.mock('../src/core/cloud/service.js', () => ({
  cloudOverview: vi.fn(),
  launchCloudTask: vi.fn(),
  runSelfImprove: core.runSelfImprove,
}));
vi.mock('../src/core/cloud/store.js', () => ({
  listCloudTasks: () => [],
  readCloudTask: () => null,
  writeCloudTask: vi.fn(),
  updateCloudBudget: vi.fn(),
}));
vi.mock('../src/core/cloud/tracker.js', () => ({ refreshCloudTasks: core.refreshCloudTasks }));
vi.mock('../src/core/cloud/budget.js', () => ({ cloudBudgetView: vi.fn() }));

const {
  CLOUD_IMPROVE_EVERY_MS,
  CLOUD_IMPROVE_FIRST_DELAY_MS,
  CLOUD_REFRESH_EVERY_MS,
  cloudSchedulerRefusal,
  cloudSchedulerRunning,
  startCloudScheduler,
  stopCloudScheduler,
} = await import('../src/core/cloud/cloud-api.js');

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-cloud-sched-'));
  process.env['HOME'] = home;
  core.refreshCloudTasks.mockReset();
  core.runSelfImprove.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  stopCloudScheduler();
  vi.useRealTimers();
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('cloudSchedulerRefusal', () => {
  it('refuses under a test runner', () => {
    expect(cloudSchedulerRefusal({ VITEST: 'true' })).toBe('test process');
    expect(cloudSchedulerRefusal({ NODE_ENV: 'test' })).toBe('test process');
  });

  it('refuses when ASHLR_CLOUD_AUTO=0', () => {
    expect(cloudSchedulerRefusal({ ASHLR_CLOUD_AUTO: '0' })).toBe('disabled by ASHLR_CLOUD_AUTO=0');
  });

  it('allows a normal server process', () => {
    expect(cloudSchedulerRefusal({})).toBeNull();
    expect(cloudSchedulerRefusal({ ASHLR_CLOUD_AUTO: '1' })).toBeNull();
  });

  it('did not start on module load in this test process', () => {
    expect(cloudSchedulerRunning()).toBe(false);
  });

  it('startCloudScheduler honours the refusal', () => {
    const refresh = vi.fn(async () => undefined);
    expect(startCloudScheduler({ ASHLR_CLOUD_AUTO: '0' }, { refresh, improve: refresh })).toBe(false);
    expect(startCloudScheduler({ VITEST: 'true' }, { refresh, improve: refresh })).toBe(false);
    expect(cloudSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('cadence', () => {
  it('refreshes every 10 min; self-improves 2 min after start, then hourly', async () => {
    const refresh = vi.fn(async () => undefined);
    const improve = vi.fn(async () => undefined);
    expect(startCloudScheduler({}, { refresh, improve, log: () => undefined })).toBe(true);
    expect(cloudSchedulerRunning()).toBe(true);
    // Idempotent: a second start adds no timers.
    const timers = vi.getTimerCount();
    expect(startCloudScheduler({}, { refresh, improve })).toBe(true);
    expect(vi.getTimerCount()).toBe(timers);

    await vi.advanceTimersByTimeAsync(CLOUD_IMPROVE_FIRST_DELAY_MS - 1);
    expect(improve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(improve).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS - CLOUD_IMPROVE_FIRST_DELAY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(6); // at 60 min
    expect(improve).toHaveBeenCalledTimes(2); // 2 min, 60 min
    await vi.advanceTimersByTimeAsync(CLOUD_IMPROVE_EVERY_MS);
    expect(improve).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(12);
  });

  it('the default jobs are the tracker refresh and the auto self-improve path', async () => {
    core.refreshCloudTasks.mockResolvedValue({ checked: 0, updated: 0 });
    core.runSelfImprove.mockResolvedValue({ launched: [], skipped: [] });
    startCloudScheduler({}, { log: () => undefined });
    await vi.advanceTimersByTimeAsync(CLOUD_IMPROVE_FIRST_DELAY_MS);
    expect(core.runSelfImprove).toHaveBeenCalledWith({ count: 1, auto: true });
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS);
    expect(core.refreshCloudTasks).toHaveBeenCalledTimes(1);
  });

  it('stop clears every timer', () => {
    startCloudScheduler({}, { refresh: async () => undefined, improve: async () => undefined });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stopCloudScheduler();
    expect(vi.getTimerCount()).toBe(0);
    expect(cloudSchedulerRunning()).toBe(false);
  });
});

describe('overlap guard', () => {
  it('skips a tick while the previous run of the same job is still going', async () => {
    let release!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    startCloudScheduler({}, { refresh, improve: async () => undefined, log: () => undefined });
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a synchronous throw still releases the guard', async () => {
    const refresh = vi.fn(() => { throw new Error('boom'); });
    startCloudScheduler({}, { refresh, improve: async () => undefined, log: () => undefined });
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('failure logging', () => {
  it('logs once per distinct error, again when it changes, and again after a recovery', async () => {
    const log = vi.fn();
    const errors = ['gh: not logged in', 'gh: not logged in', 'network down', null, 'network down'];
    let i = 0;
    const refresh = vi.fn(async () => {
      const e = errors[i++];
      if (e) throw new Error(e);
    });
    startCloudScheduler({}, { refresh, improve: async () => undefined, log });
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'cloud refresh failed (gh: not logged in); retrying on the next tick',
      'cloud refresh failed (network down); retrying on the next tick',
      'cloud refresh failed (network down); retrying on the next tick',
    ]);
  });

  it('tracks each job separately and scrubs secrets from the line', async () => {
    const log = vi.fn();
    const refresh = async (): Promise<void> => { throw new Error('boom'); };
    const improve = async (): Promise<void> => { throw new Error('push to https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com failed'); };
    startCloudScheduler({}, { refresh, improve, log });
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith('cloud refresh failed (boom)'))).toBe(true);
    const improveLine = lines.find((l) => l.startsWith('cloud improve failed'));
    expect(improveLine).toBeDefined();
    expect(improveLine).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('a logger that throws never breaks the scheduler', async () => {
    const refresh = vi.fn(async () => { throw new Error('x'); });
    startCloudScheduler({}, { refresh, improve: async () => undefined, log: () => { throw new Error('log down'); } });
    await vi.advanceTimersByTimeAsync(CLOUD_REFRESH_EVERY_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

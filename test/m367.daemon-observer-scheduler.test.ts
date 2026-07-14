import { EventEmitter } from 'node:events';
import { spawnSync, type SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { Backlog } from '../src/core/types.js';
import {
  durableBacklogReadyForTick,
  scheduleResolutionObserverChild,
} from '../src/core/daemon/resolution-observer-scheduler.js';
import { runResolutionObserverChild } from '../src/core/daemon/resolution-observer-child.js';
import {
  resolutionObserverRunStatePath,
  runResolutionObserver,
  type ResolutionObserverOutcome,
  type ResolutionObserverRunSummary,
} from '../src/core/fleet/resolution-observer.js';
import {
  cancelResolutionObserverBeforeShutdown,
  scheduleResolutionObserverAfterTick,
} from '../src/core/daemon/loop.js';

const TICK_AT = '2026-07-11T12:00:00.000Z';
const SNAPSHOT_AT = '2026-07-11T12:00:00.500Z';
const SNAPSHOT_ID = 'a'.repeat(32);
const NOW = Date.parse('2026-07-11T12:00:01.000Z');
const tsxImportUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function backlog(generatedAt = '2026-07-11T12:00:00.500Z'): Backlog {
  return { generatedAt, snapshotId: SNAPSHOT_ID, repos: [], items: [] };
}

function observerRun(outcome: ResolutionObserverOutcome): ResolutionObserverRunSummary {
  return {
    observerRunId: `resolution-observer:${SNAPSHOT_AT}`,
    startedAt: TICK_AT,
    completedAt: SNAPSHOT_AT,
    outcome,
    backlogGeneratedAt: SNAPSHOT_AT,
    reposObserved: 0,
    pendingObjectives: 0,
    transitionsMatched: 0,
    recorded: 0,
    replayed: 0,
    conflicted: 0,
    invalid: 0,
    failed: outcome === 'write-failed' ? 1 : 0,
  };
}

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);
}

function spawnHarness() {
  const child = new FakeChild();
  const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child);
  return { child, spawn };
}

describe('daemon resolution observer child scheduling', () => {
  it('runs through a filesystem alias and preserves the KILL refusal exit', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-observer-entrypoint-'));
    try {
      const home = join(root, 'home');
      const ashlrHome = join(home, '.ashlr');
      const daemonAlias = join(root, 'daemon-alias');
      mkdirSync(ashlrHome, { recursive: true });
      writeFileSync(join(ashlrHome, 'KILL'), 'kill switch active\n', { mode: 0o600 });
      symlinkSync(
        fileURLToPath(new URL('../src/core/daemon/', import.meta.url)),
        daemonAlias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          tsxImportUrl,
          join(daemonAlias, 'resolution-observer-child.ts'),
          '25',
          '1',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            ASHLR_HOME: ashlrHome,
          },
          timeout: 15_000,
          windowsHide: true,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('refuses KILL before admission and immediately before spawn', async () => {
    const spawn = vi.fn();
    const killed = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { spawn, killSwitchOn: () => true },
    });
    expect(killed.disposition).toBe('not-ready');
    await expect(killed.completion).resolves.toMatchObject({ outcome: 'cancelled' });

    const killSwitchOn = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const raced = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { spawn, loadBacklog: () => backlog(), now: () => NOW, killSwitchOn },
    });
    expect(raced.disposition).toBe('not-ready');
    await expect(raced.completion).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(killSwitchOn).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('holds child authority through every guarded observer write and releases last', () => {
    const fence = {} as never;
    const events: string[] = [];
    const writeCheckpoint = vi.fn(() => { events.push('checkpoint'); return true; });
    const recordWitness = vi.fn(() => {
      events.push('witness');
      return { attempted: 1, recorded: 1, replayed: 0, conflicted: 0, invalid: 0, failed: 0 };
    });
    const writeRunSummary = vi.fn(() => { events.push('summary'); return true; });

    const exitCode = runResolutionObserverChild(['250', '24', SNAPSHOT_AT, SNAPSHOT_ID], {
      acquireFence: () => { events.push('acquire'); return fence; },
      ownsFence: (candidate) => { events.push('owns'); return candidate === fence; },
      killSwitchOn: () => { events.push('kill'); return false; },
      releaseFence: (candidate) => { expect(candidate).toBe(fence); events.push('release'); },
      writeCheckpoint,
      recordWitness,
      writeRunSummary,
      runObserver: (options) => {
        events.push('run');
        expect(options.deps?.writeCheckpoint?.({} as never)).toBe(true);
        expect(options.deps?.recordWitness?.({} as never)).toMatchObject({ recorded: 1 });
        expect(options.deps?.writeRunSummary?.({} as never)).toBe(true);
        return observerRun('completed');
      },
    });

    expect(exitCode).toBe(0);
    expect(writeCheckpoint).toHaveBeenCalledOnce();
    expect(recordWitness).toHaveBeenCalledOnce();
    expect(writeRunSummary).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe('release');
    expect(events.filter((event) => event === 'owns')).toHaveLength(5);
    expect(events.filter((event) => event === 'kill')).toHaveLength(5);
    for (const writeEvent of ['checkpoint', 'witness', 'summary']) {
      const writeAt = events.indexOf(writeEvent);
      expect(events.slice(writeAt - 2, writeAt)).toEqual(['owns', 'kill']);
    }
  });

  it('exits nonzero for every non-success observer outcome', () => {
    const fence = {} as never;
    const failures: ResolutionObserverOutcome[] = [
      'source-unavailable',
      'cancelled',
      'deadline-exceeded',
      'capacity-exceeded',
      'write-failed',
    ];

    for (const outcome of failures) {
      expect(runResolutionObserverChild([], {
        acquireFence: () => fence,
        ownsFence: (candidate) => candidate === fence,
        killSwitchOn: () => false,
        releaseFence: () => {},
        runObserver: () => observerRun(outcome),
      }), outcome).toBe(1);
    }
  });

  it('exits nonzero when the production observer native run-summary writer fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-observer-native-write-'));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousAshlrHome = process.env.ASHLR_HOME;
    try {
      const home = join(root, 'home');
      const ashlrHome = join(home, '.ashlr');
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.ASHLR_HOME = ashlrHome;
      const runStatePath = resolutionObserverRunStatePath();
      mkdirSync(dirname(runStatePath), { recursive: true, mode: 0o700 });
      mkdirSync(runStatePath, { mode: 0o700 });

      expect(runResolutionObserver()).toMatchObject({ outcome: 'write-failed', failed: 1 });

      const fence = {} as never;
      const releaseFence = vi.fn();
      expect(runResolutionObserverChild(['250', '24'], {
        acquireFence: () => fence,
        ownsFence: (candidate) => candidate === fence,
        killSwitchOn: () => false,
        releaseFence,
      })).toBe(1);
      expect(releaseFence).toHaveBeenCalledWith(fence);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previousAshlrHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses child work without owned authority or when KILL follows acquisition', () => {
    const runObserver = vi.fn(() => ({} as never));
    const releaseFence = vi.fn();
    expect(runResolutionObserverChild([], {
      acquireFence: () => null,
      ownsFence: () => false,
      releaseFence,
      runObserver,
    })).toBe(1);
    expect(releaseFence).toHaveBeenCalledWith(null);

    const fence = {} as never;
    expect(runResolutionObserverChild([], {
      acquireFence: () => fence,
      ownsFence: (candidate) => candidate === fence,
      killSwitchOn: () => true,
      releaseFence,
      runObserver,
    })).toBe(1);
    expect(releaseFence).toHaveBeenLastCalledWith(fence);
    expect(runObserver).not.toHaveBeenCalled();
  });

  it('returns immediately and launches with no inherited stdio', async () => {
    const { child, spawn } = spawnHarness();
    let settled = false;
    const scheduled = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { spawn, loadBacklog: () => backlog(), now: () => NOW },
    });
    void scheduled.completion.then(() => { settled = true; });

    expect(scheduled.disposition).toBe('scheduled');
    expect(settled).toBe(false);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringContaining('resolution-observer-child'),
        SNAPSHOT_AT,
        SNAPSHOT_ID,
      ]),
      expect.objectContaining({ stdio: 'ignore', windowsHide: true }),
    );
    const overlapping = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { spawn, loadBacklog: () => backlog(), now: () => NOW },
    });
    expect(overlapping.disposition).toBe('overlap-suppressed');
    expect(overlapping.completion).toBe(scheduled.completion);
    expect(spawn).toHaveBeenCalledTimes(1);

    child.emit('close', 0, null);
    await expect(scheduled.completion).resolves.toEqual({ outcome: 'completed', code: 0, signal: null });
  });

  it('cannot report a nonzero child exit as completed', async () => {
    const { child, spawn } = spawnHarness();
    const scheduled = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { spawn, loadBacklog: () => backlog(), now: () => NOW },
    });

    child.emit('close', 1, null);

    await expect(scheduled.completion).resolves.toEqual({ outcome: 'failed', code: 1, signal: null });
  });

  it('enforces the parent timeout with SIGKILL', async () => {
    const { child, spawn } = spawnHarness();
    let timeoutCallback: (() => void) | undefined;
    const writeRunSummary = vi.fn(() => true);
    const fence = {} as never;
    const releaseFence = vi.fn();
    const scheduled = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      parentTimeoutMs: 17,
      deps: {
        spawn,
        loadBacklog: () => backlog(),
        now: () => NOW,
        readCheckpoint: () => ({
          sourceState: 'healthy',
          checkpoint: {
            schemaVersion: 1,
            backlogGeneratedAt: TICK_AT,
            updatedAt: TICK_AT,
            pending: [{} as never, {} as never],
            lastRun: {} as never,
          },
        }),
        writeRunSummary,
        killSwitchOn: () => false,
        acquireFence: () => fence,
        ownsFence: (candidate) => candidate === fence,
        releaseFence,
        setTimeout: (callback) => { timeoutCallback = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
        clearTimeout: () => {},
      },
    });

    timeoutCallback?.();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(writeRunSummary).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');
    expect(writeRunSummary).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'deadline-exceeded',
      backlogGeneratedAt: '2026-07-11T12:00:00.500Z',
      reposObserved: 0,
      pendingObjectives: 2,
      failed: 1,
    }));
    expect(releaseFence).toHaveBeenCalledWith(fence);
    await expect(scheduled.completion).resolves.toEqual({
      outcome: 'timed-out',
      code: null,
      signal: 'SIGKILL',
      deadlineSummaryPersisted: true,
    });
  });

  it('exposes idempotent cancellation that kills the child', async () => {
    const { child, spawn } = spawnHarness();
    const scheduled = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { spawn, loadBacklog: () => backlog(), now: () => NOW },
    });

    scheduled.cancel();
    scheduled.cancel();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(scheduled.completion).resolves.toEqual({ outcome: 'cancelled', code: null, signal: 'SIGKILL' });
  });

  it('releases the process-local guard after bounded kill confirmation fails', async () => {
    const first = spawnHarness();
    const callbacks: Array<() => void> = [];
    const timerDeps = {
      loadBacklog: () => backlog(),
      now: () => NOW,
      setTimeout: (callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    };
    const scheduled = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { ...timerDeps, spawn: first.spawn },
    });

    scheduled.cancel();
    callbacks[1]?.();
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'failed' });

    const second = spawnHarness();
    const next = scheduleResolutionObserverChild({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
      deps: { ...timerDeps, spawn: second.spawn },
    });
    expect(next.disposition).toBe('scheduled');
    second.child.emit('close', 0, null);
    await next.completion;
  });

  it('fails closed without spawning for missing or stale durable snapshots', async () => {
    const spawn = vi.fn();
    expect(durableBacklogReadyForTick(TICK_AT, SNAPSHOT_AT, SNAPSHOT_ID, { loadBacklog: () => null, now: () => NOW })).toBe(false);
    expect(durableBacklogReadyForTick(TICK_AT, SNAPSHOT_AT, SNAPSHOT_ID, {
      loadBacklog: () => backlog('2026-07-11T11:59:59.999Z'),
      now: () => NOW,
    })).toBe(false);

    for (const loadBacklog of [() => null, () => backlog('2026-07-11T11:59:59.999Z')]) {
      const scheduled = scheduleResolutionObserverChild({
        completedTickAt: TICK_AT,
        expectedBacklogGeneratedAt: SNAPSHOT_AT,
        expectedBacklogSnapshotId: SNAPSHOT_ID,
        deps: { spawn, loadBacklog, now: () => NOW },
      });
      expect(scheduled.disposition).toBe('not-ready');
      await scheduled.completion;
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('gates dry-run, once, and persistence-failed ticks before invoking the scheduler', () => {
    const schedule = vi.fn();
    const tick = {
      ts: TICK_AT,
      backlogSnapshotAt: SNAPSHOT_AT,
      backlogSnapshotId: SNAPSHOT_ID,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
    };

    expect(scheduleResolutionObserverAfterTick(tick, { dryRun: true, once: false }, schedule)).toBeNull();
    expect(scheduleResolutionObserverAfterTick(tick, { dryRun: false, once: true }, schedule)).toBeNull();
    expect(scheduleResolutionObserverAfterTick(
      tick,
      { dryRun: false, once: false },
      schedule,
      () => true,
    )).toBeNull();
    expect(scheduleResolutionObserverAfterTick(
      { ...tick, reason: 'state-persistence-failed' },
      { dryRun: false, once: false },
      schedule,
    )).toBeNull();
    expect(schedule).not.toHaveBeenCalled();

    const handle = {
      disposition: 'scheduled' as const,
      cancel: () => {},
      completion: Promise.resolve({ outcome: 'completed' as const, code: 0, signal: null }),
    };
    schedule.mockReturnValue(handle);
    expect(scheduleResolutionObserverAfterTick(tick, { dryRun: false, once: false }, schedule)).toBe(handle);
    expect(schedule).toHaveBeenCalledWith({
      completedTickAt: TICK_AT,
      expectedBacklogGeneratedAt: SNAPSHOT_AT,
      expectedBacklogSnapshotId: SNAPSHOT_ID,
    });
  });

  it('cancels and awaits observer completion during daemon shutdown', async () => {
    const events: string[] = [];
    let finish!: () => void;
    const completion = new Promise<never>((resolve) => { finish = resolve; });
    const shutdown = cancelResolutionObserverBeforeShutdown({
      disposition: 'scheduled',
      cancel: () => { events.push('cancel'); finish(); },
      completion,
    }).then(() => { events.push('shutdown-complete'); });

    expect(events).toEqual(['cancel']);
    await shutdown;
    expect(events).toEqual(['cancel', 'shutdown-complete']);
  });
});

import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import type { Backlog } from '../src/core/types.js';
import {
  durableBacklogReadyForTick,
  scheduleResolutionObserverChild,
} from '../src/core/daemon/resolution-observer-scheduler.js';
import {
  cancelResolutionObserverBeforeShutdown,
  scheduleResolutionObserverAfterTick,
} from '../src/core/daemon/loop.js';

const TICK_AT = '2026-07-11T12:00:00.000Z';
const SNAPSHOT_AT = '2026-07-11T12:00:00.500Z';
const SNAPSHOT_ID = 'a'.repeat(32);
const NOW = Date.parse('2026-07-11T12:00:01.000Z');

function backlog(generatedAt = '2026-07-11T12:00:00.500Z'): Backlog {
  return { generatedAt, snapshotId: SNAPSHOT_ID, repos: [], items: [] };
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

  it('enforces the parent timeout with SIGKILL', async () => {
    const { child, spawn } = spawnHarness();
    let timeoutCallback: (() => void) | undefined;
    const writeRunSummary = vi.fn(() => true);
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

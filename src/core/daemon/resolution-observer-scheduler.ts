import { spawn, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBacklog } from '../portfolio/backlog.js';
import type { Backlog } from '../types.js';
import {
  readResolutionObserverCheckpoint,
  writeResolutionObserverRunSummary,
  type ResolutionObserverReadResult,
  type ResolutionObserverRunSummary,
} from '../fleet/resolution-observer.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { killSwitchOn } from '../sandbox/policy.js';

const DEFAULT_PARENT_TIMEOUT_MS = 500;
const DEFAULT_KILL_CONFIRM_TIMEOUT_MS = 1_000;
const DEFAULT_OBSERVER_DEADLINE_MS = 250;
const DEFAULT_MAX_REPOS = 24;

export type ResolutionObserverChildOutcome =
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'cancelled';

export interface ResolutionObserverChildResult {
  outcome: ResolutionObserverChildOutcome;
  code: number | null;
  signal: NodeJS.Signals | null;
  deadlineSummaryPersisted?: boolean;
}

export interface ScheduledResolutionObserverChild {
  disposition: 'scheduled' | 'overlap-suppressed' | 'not-ready' | 'spawn-failed';
  completion: Promise<ResolutionObserverChildResult>;
  cancel: () => void;
}

interface ChildHandle {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ScheduleResolutionObserverChildOptions {
  completedTickAt: string;
  expectedBacklogGeneratedAt: string;
  expectedBacklogSnapshotId: string;
  parentTimeoutMs?: number;
  killConfirmTimeoutMs?: number;
  observerDeadlineMs?: number;
  maxRepos?: number;
  deps?: {
    spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildHandle;
    setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
    loadBacklog?: () => Backlog | null;
    now?: () => number;
    readCheckpoint?: () => ResolutionObserverReadResult;
    writeRunSummary?: (summary: ResolutionObserverRunSummary) => boolean;
    killSwitchOn?: () => boolean;
    acquireFence?: typeof acquireOutwardMutationFence;
    ownsFence?: typeof ownsOutwardMutationFence;
    releaseFence?: typeof releaseOutwardMutationFence;
  };
}

let active: ScheduledResolutionObserverChild | null = null;

/** Require the durable snapshot written by this tick, not an older readable file. */
export function durableBacklogReadyForTick(
  completedTickAt: string,
  expectedBacklogGeneratedAt: string,
  expectedBacklogSnapshotId: string,
  deps: { loadBacklog?: () => Backlog | null; now?: () => number } = {},
): boolean {
  const backlog = (deps.loadBacklog ?? loadBacklog)();
  return durableBacklogSnapshotReady(
    completedTickAt,
    expectedBacklogGeneratedAt,
    expectedBacklogSnapshotId,
    backlog,
    (deps.now ?? Date.now)(),
  );
}

function durableBacklogSnapshotReady(
  completedTickAt: string,
  expectedBacklogGeneratedAt: string,
  expectedBacklogSnapshotId: string,
  backlog: Backlog | null,
  nowMs: number,
): backlog is Backlog {
  const tickMs = Date.parse(completedTickAt);
  if (!Number.isFinite(tickMs) || !Number.isFinite(nowMs) || tickMs > nowMs + 5_000) return false;
  if (!backlog) return false;
  const backlogMs = Date.parse(backlog.generatedAt);
  return Number.isFinite(backlogMs) && backlog.generatedAt === expectedBacklogGeneratedAt &&
    backlog.snapshotId === expectedBacklogSnapshotId &&
    backlogMs >= tickMs && backlogMs <= nowMs + 5_000;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function recordParentDeadlineExceeded(
  options: ScheduleResolutionObserverChildOptions,
  startedAt: string,
  snapshot: { backlogGeneratedAt: string; reposObserved: number; pendingObjectives: number },
): boolean {
  const acquireFence = options.deps?.acquireFence ?? acquireOutwardMutationFence;
  const ownsFence = options.deps?.ownsFence ?? ownsOutwardMutationFence;
  const releaseFence = options.deps?.releaseFence ?? releaseOutwardMutationFence;
  const killIsOn = options.deps?.killSwitchOn ?? killSwitchOn;
  let fence: ReturnType<typeof acquireOutwardMutationFence> = null;
  try {
    fence = acquireFence();
    if (!ownsFence(fence) || killIsOn()) return false;
    const now = options.deps?.now ?? Date.now;
    const completedAt = new Date(now()).toISOString();
    const summary: ResolutionObserverRunSummary = {
      observerRunId: `resolution-observer:parent-timeout:${process.pid}:${Date.parse(startedAt)}`,
      startedAt,
      completedAt,
      outcome: 'deadline-exceeded',
      backlogGeneratedAt: snapshot.backlogGeneratedAt,
      reposObserved: snapshot.reposObserved,
      pendingObjectives: snapshot.pendingObjectives,
      transitionsMatched: 0,
      recorded: 0,
      replayed: 0,
      conflicted: 0,
      invalid: 0,
      failed: 1,
    };
    const write = options.deps?.writeRunSummary ?? ((value: ResolutionObserverRunSummary) =>
      writeResolutionObserverRunSummary(value, { lockWaitMs: 20 }));
    if (!ownsFence(fence) || killIsOn()) return false;
    return write(summary);
  } catch {
    return false;
  } finally {
    releaseFence(fence);
  }
}

function childRuntimeArgs(): string[] {
  if (!import.meta.url.endsWith('.ts')) return [];
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index]!;
    if (arg.startsWith('--import=') || arg.startsWith('--require=')) {
      args.push(arg);
    } else if (arg === '--import' || arg === '--require') {
      const value = process.execArgv[index + 1];
      if (value) args.push(arg, value);
      index++;
    }
  }
  return args;
}

/** Launch the advisory observer outside the daemon process without waiting for it. */
export function scheduleResolutionObserverChild(
  options: ScheduleResolutionObserverChildOptions,
): ScheduledResolutionObserverChild {
  const killIsOn = options.deps?.killSwitchOn ?? killSwitchOn;
  if (killIsOn()) {
    return {
      disposition: 'not-ready',
      completion: Promise.resolve({ outcome: 'cancelled', code: null, signal: null }),
      cancel: () => {},
    };
  }
  if (active) {
    return {
      disposition: 'overlap-suppressed',
      completion: active.completion,
      cancel: active.cancel,
    };
  }

  const spawnChild = options.deps?.spawn ?? ((command, args, spawnOptions) =>
    spawn(command, args, spawnOptions));
  const scheduleTimeout = options.deps?.setTimeout ?? setTimeout;
  const cancelTimeout = options.deps?.clearTimeout ?? clearTimeout;
  const parentTimeoutMs = positiveInteger(options.parentTimeoutMs, DEFAULT_PARENT_TIMEOUT_MS);
  const killConfirmTimeoutMs = positiveInteger(options.killConfirmTimeoutMs, DEFAULT_KILL_CONFIRM_TIMEOUT_MS);
  const observerDeadlineMs = positiveInteger(options.observerDeadlineMs, DEFAULT_OBSERVER_DEADLINE_MS);
  const maxRepos = positiveInteger(options.maxRepos, DEFAULT_MAX_REPOS);
  const nowMs = (options.deps?.now ?? Date.now)();
  const startedAt = new Date(nowMs).toISOString();
  const invocationBacklog = (options.deps?.loadBacklog ?? loadBacklog)();

  if (!durableBacklogSnapshotReady(
    options.completedTickAt,
    options.expectedBacklogGeneratedAt,
    options.expectedBacklogSnapshotId,
    invocationBacklog,
    nowMs,
  )) {
    return {
      disposition: 'not-ready',
      completion: Promise.resolve({ outcome: 'failed', code: null, signal: null }),
      cancel: () => {},
    };
  }

  let settle!: (result: ResolutionObserverChildResult) => void;
  let settled = false;
  let timeout = undefined as ReturnType<typeof setTimeout> | undefined;
  let killConfirmationTimeout = undefined as ReturnType<typeof setTimeout> | undefined;
  let child: ChildHandle;
  let terminationRequested: 'cancelled' | 'timed-out' | null = null;
  let killRequested = false;
  const invocationCheckpoint = (options.deps?.readCheckpoint ?? readResolutionObserverCheckpoint)();
  const invocationSnapshot = {
    backlogGeneratedAt: options.expectedBacklogGeneratedAt,
    reposObserved: invocationBacklog?.repos.length ?? 0,
    pendingObjectives: invocationCheckpoint.checkpoint?.pending.length ?? 0,
  };
  const completion = new Promise<ResolutionObserverChildResult>((resolve) => { settle = resolve; });
  const finish = (result: ResolutionObserverChildResult): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) cancelTimeout(timeout);
    if (killConfirmationTimeout !== undefined) cancelTimeout(killConfirmationTimeout);
    settle(result);
  };

  if (killIsOn()) {
    return {
      disposition: 'not-ready',
      completion: Promise.resolve({ outcome: 'cancelled', code: null, signal: null }),
      cancel: () => {},
    };
  }

  try {
    const entryName = import.meta.url.endsWith('.ts')
      ? './resolution-observer-child.ts'
      : './resolution-observer-child.js';
    const entry = fileURLToPath(new URL(entryName, import.meta.url));
    child = spawnChild(
      process.execPath,
      [
        ...childRuntimeArgs(),
        entry,
        String(observerDeadlineMs),
        String(maxRepos),
        options.expectedBacklogGeneratedAt,
        options.expectedBacklogSnapshotId,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch {
    const failed: ScheduledResolutionObserverChild = {
      disposition: 'spawn-failed',
      completion: Promise.resolve({ outcome: 'failed', code: null, signal: null }),
      cancel: () => {},
    };
    return failed;
  }

  const scheduled: ScheduledResolutionObserverChild = {
    disposition: 'scheduled',
    completion,
    cancel: () => {
      if (settled) return;
      if (killRequested) return;
      killRequested = true;
      if (child.kill('SIGKILL')) terminationRequested = 'cancelled';
      killConfirmationTimeout = scheduleTimeout(() => {
        if (active === scheduled) active = null;
        finish({ outcome: 'failed', code: null, signal: null });
      }, killConfirmTimeoutMs);
    },
  };
  active = scheduled;

  child.once('error', () => {
    if (active === scheduled) active = null;
    finish({ outcome: 'failed', code: null, signal: null });
  });
  child.once('close', (code, signal) => {
    if (active === scheduled) active = null;
    if (terminationRequested === 'cancelled') {
      finish({ outcome: 'cancelled', code, signal });
      return;
    }
    if (terminationRequested === 'timed-out') {
      const deadlineSummaryPersisted = recordParentDeadlineExceeded(options, startedAt, invocationSnapshot);
      finish({ outcome: 'timed-out', code, signal, deadlineSummaryPersisted });
      return;
    }
    finish({ outcome: code === 0 ? 'completed' : 'failed', code, signal });
  });
  timeout = scheduleTimeout(() => {
    if (settled || killRequested) return;
    killRequested = true;
    if (child.kill('SIGKILL')) terminationRequested = 'timed-out';
    killConfirmationTimeout = scheduleTimeout(() => {
      if (active === scheduled) active = null;
      finish({ outcome: 'failed', code: null, signal: null });
    }, killConfirmTimeoutMs);
  }, parentTimeoutMs);

  return scheduled;
}

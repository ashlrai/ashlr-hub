import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUTOFF_CAPTURE_DEADLINE_MS,
  CUTOFF_CAPTURE_FAILURE_RETRY_MS,
  CUTOFF_CAPTURE_SUCCESS_CADENCE_MS,
  bindCutoffCaptureSupervisor,
  completeCutoffCaptureAttempt,
  cutoffCaptureChildEnvironment,
  cutoffCaptureSchedulerStatePath,
  decideCutoffCaptureSchedule,
  readCutoffCaptureSchedulerState,
  reserveCutoffCaptureAttempt,
  scheduleCutoffCheckpointCapture,
  type CutoffCaptureSchedulerReadResult,
  type CutoffCaptureSchedulerState,
} from '../src/core/daemon/cutoff-checkpoint-scheduler.js';
import { runCutoffCheckpointWorker } from '../src/core/daemon/cutoff-checkpoint-worker.js';
import { runCutoffCheckpointSupervisor } from '../src/core/daemon/cutoff-checkpoint-child.js';
import { killSwitchOn, setKill } from '../src/core/sandbox/policy.js';
import {
  cancelDaemonPostTickChildren,
  scheduleCutoffCheckpointAfterTick,
} from '../src/core/daemon/loop.js';
import type { DaemonTick } from '../src/core/types.js';

const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const posixIt = it.skipIf(process.platform === 'win32');
let home = '';
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;

class FakeChild extends EventEmitter {
  pid = 1234;
  kill = vi.fn(() => true);
  unref = vi.fn();
}

function healthy(state: CutoffCaptureSchedulerState): CutoffCaptureSchedulerReadResult {
  return { sourceState: 'healthy', state, stopReasons: [] };
}

function state(overrides: Partial<CutoffCaptureSchedulerState> = {}): CutoffCaptureSchedulerState {
  return {
    schemaVersion: 1,
    active: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextEligibleAt: null,
    lastOutcome: null,
    lastReason: null,
    ...overrides,
  };
}

function tick(overrides: Partial<DaemonTick> = {}): DaemonTick {
  return {
    ts: '2026-07-12T12:00:00.000Z',
    backlogSnapshotAt: '2026-07-12T12:00:00.000Z',
    backlogSnapshotId: 'a'.repeat(32),
    itemsConsidered: 0,
    proposalsCreated: 0,
    spentUsd: 0,
    ...overrides,
  };
}

beforeEach(() => {
  oldHome = process.env['HOME'];
  oldAshlrHome = process.env['ASHLR_HOME'];
  home = resolve(mkdtempSync(join(tmpdir(), 'ashlr-m385-')));
  process.env['HOME'] = home;
  process.env['ASHLR_HOME'] = join(home, '.ashlr');
  expect(setKill(false, { waitMs: 500 }).ok).toBe(true);
});

afterEach(() => {
  try { setKill(false, { waitMs: 500 }); } catch { /* best effort */ }
  if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome;
  if (oldAshlrHome === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = oldAshlrHome;
  try { chmodSync(join(home, '.ashlr', 'fleet'), 0o700); } catch { /* absent */ }
  rmSync(home, { recursive: true, force: true });
});

describe('M385 cutoff checkpoint cadence state', () => {
  it('uses exact success/failure cadence boundaries and fails closed on bad time/state', () => {
    expect(decideCutoffCaptureSchedule(
      { sourceState: 'missing', state: null, stopReasons: [] }, NOW, 'linux',
    ).due).toBe(true);
    expect(decideCutoffCaptureSchedule(
      { sourceState: 'degraded', state: null, stopReasons: ['io-error'] }, NOW, 'linux',
    ))
      .toMatchObject({ due: false, reason: 'state-degraded' });
    expect(decideCutoffCaptureSchedule({ sourceState: 'unsupported', state: null, stopReasons: [] }, NOW, 'win32'))
      .toMatchObject({ due: false, reason: 'platform-unsupported' });

    const successAt = new Date(NOW).toISOString();
    const successDue = new Date(NOW + CUTOFF_CAPTURE_SUCCESS_CADENCE_MS).toISOString();
    const successful = healthy(state({
      lastAttemptAt: successAt, lastSuccessAt: successAt, nextEligibleAt: successDue,
      lastOutcome: 'success', lastReason: 'recorded',
    }));
    expect(decideCutoffCaptureSchedule(
      successful, NOW + CUTOFF_CAPTURE_SUCCESS_CADENCE_MS - 1, 'linux',
    ).due).toBe(false);
    expect(decideCutoffCaptureSchedule(
      successful, NOW + CUTOFF_CAPTURE_SUCCESS_CADENCE_MS, 'linux',
    ).due).toBe(true);

    const failureDue = new Date(NOW + CUTOFF_CAPTURE_FAILURE_RETRY_MS).toISOString();
    const failed = healthy(state({
      lastAttemptAt: successAt, lastFailureAt: successAt, nextEligibleAt: failureDue,
      lastOutcome: 'failure', lastReason: 'worker-failed',
    }));
    expect(decideCutoffCaptureSchedule(
      failed, NOW + CUTOFF_CAPTURE_FAILURE_RETRY_MS - 1, 'linux',
    ).due).toBe(false);
    expect(decideCutoffCaptureSchedule(
      failed, NOW + CUTOFF_CAPTURE_FAILURE_RETRY_MS, 'linux',
    ).due).toBe(true);
    expect(decideCutoffCaptureSchedule(successful, Number.NaN, 'linux').reason).toBe('invalid-time');
    expect(decideCutoffCaptureSchedule(healthy(state({
      lastAttemptAt: new Date(NOW + 6_000).toISOString(), lastOutcome: 'failure', lastReason: 'timeout',
    })), NOW, 'linux').reason).toBe('state-degraded');
  });

  posixIt('persists a private reservation and token-CAS terminal outcome across restart', () => {
    const reservation = reserveCutoffCaptureAttempt(NOW);
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) return;
    expect(readCutoffCaptureSchedulerState()).toMatchObject({
      sourceState: 'healthy',
      state: { active: { attemptId: reservation.attemptId }, lastOutcome: 'running' },
    });
    expect(statSync(join(home, '.ashlr')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, '.ashlr', 'fleet')).mode & 0o777).toBe(0o700);
    expect(statSync(cutoffCaptureSchedulerStatePath()).mode & 0o777).toBe(0o600);
    expect(reserveCutoffCaptureAttempt(NOW + 1)).toMatchObject({ reserved: false, reason: 'active' });
    expect(completeCutoffCaptureAttempt('0'.repeat(36), 'success', 'recorded', NOW + 2)).toBe(false);
    expect(completeCutoffCaptureAttempt(reservation.attemptId, 'success', 'recorded', NOW + 2)).toBe(true);
    expect(readCutoffCaptureSchedulerState()).toMatchObject({
      sourceState: 'healthy', state: { active: null, lastOutcome: 'success', lastReason: 'recorded' },
    });
  });

  posixIt('does not recover an expired attempt while its bound process group is alive', () => {
    const reservation = reserveCutoffCaptureAttempt(NOW);
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) return;
    expect(bindCutoffCaptureSupervisor(reservation.attemptId, reservation.deadlineAt, 9999)).toBe(true);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      expect(reserveCutoffCaptureAttempt(NOW + CUTOFF_CAPTURE_DEADLINE_MS + 1))
        .toMatchObject({ reserved: false, reason: 'active' });
      expect(kill).toHaveBeenCalledWith(-9999, 0);
    } finally {
      kill.mockRestore();
    }
  });

  posixIt('suppresses malformed, hardlinked, and unsafe scheduler state', () => {
    mkdirSync(join(home, '.ashlr', 'fleet'), { recursive: true, mode: 0o700 });
    writeFileSync(cutoffCaptureSchedulerStatePath(), '{broken', { mode: 0o600 });
    expect(readCutoffCaptureSchedulerState().sourceState).toBe('degraded');
    expect(reserveCutoffCaptureAttempt(NOW)).toMatchObject({ reserved: false, reason: 'state-degraded' });
    expect(readFileSync(cutoffCaptureSchedulerStatePath(), 'utf8')).toBe('{broken');
    chmodSync(join(home, '.ashlr', 'fleet'), 0o755);
    expect(readCutoffCaptureSchedulerState().sourceState).toBe('degraded');
  });
});

describe('M385 detached supervisor scheduling', () => {
  it('spawns once, detached and unrefed, with an allowlisted secret-free environment', async () => {
    const child = new FakeChild();
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child);
    const complete = vi.fn(() => true);
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const scheduled = scheduleCutoffCheckpointCapture({
      platform: 'linux',
      deps: {
        now: () => NOW,
        killSwitchOn: () => false,
        reserve: () => ({ reserved: true, attemptId, deadlineAt: new Date(NOW + 30_000).toISOString() }),
        complete,
        cancelAttempt: () => 'cancelled',
        spawn,
        invocation: () => ({ command: '/node', args: ['/ashlr', '--_cutoff-checkpoint-supervisor', attemptId] }),
      },
    });
    expect(scheduled.disposition).toBe('scheduled');
    expect(child.unref).toHaveBeenCalledOnce();
    const options = spawn.mock.calls[0]![2] as SpawnOptions;
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    const overlap = scheduleCutoffCheckpointCapture({ platform: 'linux', deps: { killSwitchOn: () => false } });
    expect(overlap.disposition).toBe('overlap-suppressed');
    scheduled.cancel();
    child.emit('close', null, 'SIGKILL');
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it('does not revoke or kill an attempt after it has claimed the commit phase', async () => {
    const child = new FakeChild();
    const scheduled = scheduleCutoffCheckpointCapture({
      platform: 'linux',
      deps: {
        now: () => NOW,
        killSwitchOn: () => false,
        reserve: () => ({
          reserved: true,
          attemptId: '55555555-5555-4555-8555-555555555555',
          deadlineAt: new Date(NOW + 30_000).toISOString(),
        }),
        cancelAttempt: () => 'commit-in-progress',
        spawn: () => child,
        invocation: () => ({ command: '/node', args: [] }),
      },
    });
    scheduled.cancel();
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 1, null);
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('revokes capture and kills the detached process group at the parent deadline', async () => {
    const child = new FakeChild();
    const callbacks: Array<() => void> = [];
    const processKill = vi.fn();
    const complete = vi.fn(() => true);
    const cancelAttempt = vi.fn(() => 'cancelled' as const);
    const scheduled = scheduleCutoffCheckpointCapture({
      platform: 'linux',
      deps: {
        now: () => NOW,
        killSwitchOn: () => false,
        reserve: () => ({
          reserved: true,
          attemptId: '22222222-2222-4222-8222-222222222222',
          deadlineAt: new Date(NOW + CUTOFF_CAPTURE_DEADLINE_MS).toISOString(),
        }),
        complete,
        cancelAttempt,
        spawn: () => child,
        invocation: () => ({ command: '/node', args: [] }),
        processKill,
        setTimeout: (callback) => { callbacks.push(callback); return callbacks.length as never; },
        clearTimeout: () => {},
      },
    });
    callbacks[0]?.();
    expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(cancelAttempt).toHaveBeenCalledWith(expect.any(String), NOW, 'failure', 'timeout');
    expect(complete).not.toHaveBeenCalledWith(expect.any(String), 'failure', 'timeout', NOW);
    child.emit('close', null, 'SIGKILL');
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'timed-out' });
  });

  it('reconciles a released checkpoint after killing a commit at the deadline', async () => {
    const child = new FakeChild();
    const callbacks: Array<() => void> = [];
    const processKill = vi.fn();
    const complete = vi.fn(() => true);
    const scheduled = scheduleCutoffCheckpointCapture({
      platform: 'linux',
      deps: {
        now: () => NOW,
        killSwitchOn: () => false,
        reserve: () => ({
          reserved: true,
          attemptId: '88888888-8888-4888-8888-888888888888',
          deadlineAt: new Date(NOW + CUTOFF_CAPTURE_DEADLINE_MS).toISOString(),
        }),
        cancelAttempt: () => 'commit-in-progress',
        attemptReleased: () => true,
        complete,
        spawn: () => child,
        invocation: () => ({ command: '/node', args: [] }),
        processKill,
        setTimeout: (callback) => { callbacks.push(callback); return callbacks.length as never; },
        clearTimeout: () => {},
      },
    });
    callbacks[0]?.();
    expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'timed-out' });
    expect(complete).toHaveBeenCalledWith(expect.any(String), 'success', 'released-before-exit', NOW);
  });

  it('does not claim cancellation when durable revocation fails', async () => {
    const child = new FakeChild();
    const scheduled = scheduleCutoffCheckpointCapture({
      platform: 'linux',
      deps: {
        now: () => NOW,
        killSwitchOn: () => false,
        reserve: () => ({
          reserved: true,
          attemptId: '77777777-7777-4777-8777-777777777777',
          deadlineAt: new Date(NOW + 30_000).toISOString(),
        }),
        cancelAttempt: () => 'failed',
        spawn: () => child,
        invocation: () => ({ command: '/node', args: [] }),
      },
    });
    scheduled.cancel();
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 1, null);
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('refuses Windows, kill state, and unsafe inherited home values before spawn', () => {
    expect(scheduleCutoffCheckpointCapture({ platform: 'win32' }).disposition).toBe('unsupported');
    expect(scheduleCutoffCheckpointCapture({ platform: 'linux', deps: { killSwitchOn: () => true } }).reason)
      .toBe('kill-switch');
    expect(cutoffCaptureChildEnvironment({
      HOME: 'relative', ASHLR_HOME: '../unsafe', PATH: '/bin', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--import=x',
    })).toEqual({ PATH: '/bin' });
  });
});

describe('M385 supervisor and worker commands', () => {
  it('refuses capture when child authority is unavailable or KILL is armed after acquisition', () => {
    const capture = vi.fn();
    const releaseFence = vi.fn();
    expect(runCutoffCheckpointWorker('ignored', new Date(NOW + 30_000).toISOString(), {
      acquireFence: () => null,
      ownsFence: () => false,
      releaseFence,
      capture,
    })).toBe(1);
    expect(capture).not.toHaveBeenCalled();
    expect(releaseFence).toHaveBeenCalledWith(null);

    const fence = {} as never;
    const authorityEvents: string[] = [];
    const killAfterAcquire = vi.fn(() => { authorityEvents.push('kill'); return true; });
    releaseFence.mockClear();
    expect(runCutoffCheckpointWorker('ignored', new Date(NOW + 30_000).toISOString(), {
      acquireFence: () => { authorityEvents.push('acquire'); return fence; },
      ownsFence: (candidate) => { authorityEvents.push('owns'); return candidate === fence; },
      releaseFence: (candidate) => { authorityEvents.push('release'); releaseFence(candidate); },
      killSwitchOn: killAfterAcquire,
      capture,
    })).toBe(1);
    expect(authorityEvents).toEqual(['acquire', 'owns', 'kill', 'release']);
    expect(killAfterAcquire).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(releaseFence).toHaveBeenCalledWith(fence);
  });

  it('worker succeeds only after durable record/replay and rechecks kill state', () => {
    const attemptId = '33333333-3333-4333-8333-333333333333';
    const deadlineAt = new Date(NOW + 30_000).toISOString();
    const readState = () => healthy(state({
      active: { attemptId, startedAt: new Date(NOW).toISOString(), deadlineAt, phase: 'capturing' },
      lastAttemptAt: new Date(NOW).toISOString(), lastOutcome: 'running',
    }));
    const snapshot = {} as never;
    expect(runCutoffCheckpointWorker(attemptId, deadlineAt, {
      now: () => NOW, killSwitchOn: () => false, readState,
      capture: () => ({ ok: true, snapshot }),
      beginCommit: () => true,
      record: () => ({ attempted: 1, recorded: 1, replayed: 0, recoveredRows: 0, invalid: 0, failed: 0 }),
    })).toBe(0);
    expect(runCutoffCheckpointWorker(attemptId, deadlineAt, {
      now: () => NOW, killSwitchOn: () => false, readState,
      capture: () => ({ ok: true, snapshot }),
      beginCommit: () => true,
      record: () => ({ attempted: 1, recorded: 0, replayed: 1, recoveredRows: 0, invalid: 0, failed: 0 }),
    })).toBe(0);
    expect(runCutoffCheckpointWorker(attemptId, deadlineAt, {
      now: () => NOW, killSwitchOn: () => true, readState,
    })).toBe(1);
  });

  it('keeps pause non-quiesced from beginCommit through the final worker commit', () => {
    const attemptId = '99999999-9999-4999-8999-999999999999';
    const deadlineAt = new Date(NOW + 30_000).toISOString();
    const readState = () => healthy(state({
      active: { attemptId, startedAt: new Date(NOW).toISOString(), deadlineAt, phase: 'capturing' },
      lastAttemptAt: new Date(NOW).toISOString(), lastOutcome: 'running',
    }));
    let commitClaimed = false;
    let pauseDuringCommit: ReturnType<typeof setKill> | undefined;

    const exitCode = runCutoffCheckpointWorker(attemptId, deadlineAt, {
      now: () => NOW,
      readState,
      capture: () => ({ ok: true, snapshot: {} as never }),
      beginCommit: () => { commitClaimed = true; return true; },
      record: () => {
        expect(commitClaimed).toBe(true);
        pauseDuringCommit = setKill(true, { waitMs: 25 });
        return { attempted: 1, recorded: 1, replayed: 0, recoveredRows: 0, invalid: 0, failed: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(pauseDuringCommit).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({
      ok: true,
      changed: false,
      quiesced: true,
    });
  });

  it('supervisor commits success only for a zero worker exit', async () => {
    const child = new FakeChild();
    const complete = vi.fn(() => true);
    const attemptId = '44444444-4444-4444-8444-444444444444';
    const deadlineAt = new Date(NOW + 30_000).toISOString();
    const result = runCutoffCheckpointSupervisor(attemptId, deadlineAt, {
      now: () => NOW,
      readState: () => healthy(state({
        active: { attemptId, startedAt: new Date(NOW).toISOString(), deadlineAt, phase: 'capturing' },
        lastAttemptAt: new Date(NOW).toISOString(), lastOutcome: 'running',
      })),
      spawn: () => child,
      invocation: () => ({ command: '/node', args: [] }),
      bindSupervisor: () => true,
      complete,
    });
    child.emit('close', 0, null);
    await expect(result).resolves.toBe(0);
    expect(complete).toHaveBeenCalledWith(attemptId, 'success', 'recorded', NOW);
  });

  it('supervisor fallback deadline kills its entire detached process group', async () => {
    const child = new FakeChild();
    const processKill = vi.fn();
    let deadline!: () => void;
    const attemptId = '66666666-6666-4666-8666-666666666666';
    const deadlineAt = new Date(NOW + 30_000).toISOString();
    const result = runCutoffCheckpointSupervisor(attemptId, deadlineAt, {
      now: () => NOW,
      readState: () => healthy(state({
        active: {
          attemptId, startedAt: new Date(NOW).toISOString(), deadlineAt, phase: 'capturing',
        },
        lastAttemptAt: new Date(NOW).toISOString(), lastOutcome: 'running',
      })),
      spawn: () => child,
      invocation: () => ({ command: '/node', args: [] }),
      bindSupervisor: () => true,
      complete: () => true,
      processKill,
      setTimeout: (callback) => { deadline = callback; return 1 as never; },
      clearTimeout: () => {},
    });
    deadline();
    expect(processKill).toHaveBeenCalledWith(-process.pid, 'SIGKILL');
    await expect(result).resolves.toBe(1);
  });
});

describe('M385 daemon lifecycle wiring', () => {
  it('gates non-durable modes and cancels all children before awaiting shutdown', async () => {
    const schedule = vi.fn(() => ({
      disposition: 'scheduled' as const, reason: 'due', cancel: () => {},
      completion: Promise.resolve({ outcome: 'completed' as const, code: 0, signal: null }),
    }));
    expect(scheduleCutoffCheckpointAfterTick(tick(), { dryRun: true, once: false }, schedule)).toBeNull();
    expect(scheduleCutoffCheckpointAfterTick(tick(), { dryRun: false, once: true }, schedule)).toBeNull();
    expect(scheduleCutoffCheckpointAfterTick(tick({ reason: 'state-persistence-failed' }),
      { dryRun: false, once: false }, schedule)).toBeNull();
    expect(schedule).not.toHaveBeenCalled();

    const events: string[] = [];
    const handle = (name: string) => ({
      disposition: 'scheduled' as const,
      reason: 'due',
      cancel: () => { events.push(`cancel-${name}`); },
      completion: Promise.resolve().then(() => { events.push(`complete-${name}`); return {
        outcome: 'completed' as const, code: 0, signal: null,
      }; }),
    });
    await cancelDaemonPostTickChildren(handle('observer') as never, handle('cutoff'));
    expect(events.slice(0, 2)).toEqual(['cancel-observer', 'cancel-cutoff']);
  });

  it('keeps hidden commands packaged and scheduler imports outside authority modules', () => {
    const cli = readFileSync(join(process.cwd(), 'src/cli/index.ts'), 'utf8');
    const scheduler = readFileSync(join(process.cwd(), 'src/core/daemon/cutoff-checkpoint-scheduler.ts'), 'utf8');
    expect(cli).toContain("argv[0] === '--_cutoff-checkpoint-supervisor'");
    expect(cli).toContain("argv[0] === '--_cutoff-checkpoint-worker'");
    for (const forbidden of ['automerge', 'post-merge-population', 'resource-strategy', 'router.js', 'inbox/store']) {
      expect(scheduler).not.toContain(forbidden);
    }
  });
});

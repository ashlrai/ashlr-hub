import { spawn, type SpawnOptions } from 'node:child_process';
import {
  bindCutoffCaptureSupervisor,
  completeCutoffCaptureAttempt,
  cutoffCaptureChildEnvironment,
  cutoffCaptureCliInvocation,
  readCutoffCaptureSchedulerState,
} from './cutoff-checkpoint-scheduler.js';

interface ChildHandle {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface CutoffCheckpointSupervisorDependencies {
  now?: () => number;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildHandle;
  invocation?: (flag: string, args: readonly string[]) => { command: string; args: string[] };
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readState?: typeof readCutoffCaptureSchedulerState;
  complete?: typeof completeCutoffCaptureAttempt;
  bindSupervisor?: typeof bindCutoffCaptureSupervisor;
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
}

export async function runCutoffCheckpointSupervisor(
  attemptId: string | undefined,
  deadlineAt: string | undefined,
  deps: CutoffCheckpointSupervisorDependencies = {},
): Promise<number> {
  const now = deps.now ?? Date.now;
  const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : NaN;
  const read = (deps.readState ?? readCutoffCaptureSchedulerState)();
  if (!attemptId || !Number.isFinite(deadlineMs) || now() >= deadlineMs ||
    read.sourceState !== 'healthy' || read.state?.active?.attemptId !== attemptId ||
    read.state.active.deadlineAt !== deadlineAt) return 1;
  if (!(deps.bindSupervisor ?? bindCutoffCaptureSupervisor)(attemptId, deadlineAt!, process.pid)) return 1;
  const complete = deps.complete ?? completeCutoffCaptureAttempt;
  const invoke = (deps.invocation ?? cutoffCaptureCliInvocation)(
    '--_cutoff-checkpoint-worker', [attemptId, deadlineAt!],
  );
  let child: ChildHandle;
  try {
    child = (deps.spawn ?? ((command, args, options) => spawn(command, args, options)))(
      invoke.command, invoke.args, { detached: false, stdio: 'ignore', windowsHide: true, env: cutoffCaptureChildEnvironment() },
    );
  } catch {
    complete(attemptId, 'failure', 'worker-spawn-failed', now());
    return 1;
  }
  const scheduleTimeout = deps.setTimeout ?? setTimeout;
  const clearScheduledTimeout = deps.clearTimeout ?? clearTimeout;
  return await new Promise<number>((resolve) => {
    let settled = false;
    let timedOut = false;
    const timer = scheduleTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        (deps.processKill ?? ((pid, signal) => { process.kill(pid, signal); }))(-process.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
      settled = true;
      resolve(1);
    }, Math.max(1, deadlineMs - now()));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearScheduledTimeout(timer);
      complete(attemptId, 'failure', 'worker-error', now());
      resolve(1);
    });
    child.once('close', (code) => {
      if (settled || timedOut) return;
      settled = true;
      clearScheduledTimeout(timer);
      const ok = code === 0 && complete(attemptId, 'success', 'recorded', now());
      if (!ok) complete(attemptId, 'failure', 'worker-failed', now());
      resolve(ok ? 0 : 1);
    });
  });
}

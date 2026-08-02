import { fork } from 'node:child_process';
import type { DaemonRunResult } from './loop.js';
import {
  runLaunchdRetryController,
  type LaunchdRetryControllerResult,
} from './launchd-retry-controller.js';
import {
  isLaunchdReleaseObservation,
  observeLaunchdRelease,
  type LaunchdReleaseObservation,
} from './launchd-release-observation.js';

const CHILD_RESULT_PROTOCOL = 'ashlr-launchd-daemon-child-result-v1' as const;

interface LaunchdSupervisorSpec {
  budget: number;
  intervalMs: number;
  parallel: number;
}

export interface LaunchdSupervisorResult {
  exitCode: 0;
  reason:
    | 'controller-settled'
    | 'invalid-supervisor-argv'
    | 'release-observation-invalid'
    | 'supervisor-failure';
  controller?: LaunchdRetryControllerResult;
}

function positiveNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSupervisorArgs(args: readonly string[]): LaunchdSupervisorSpec | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || value === undefined || values.has(flag) ||
      !new Set(['--budget', '--interval', '--parallel']).has(flag)) return null;
    values.set(flag, value);
  }
  if (values.size !== 3) return null;
  const budget = positiveNumber(values.get('--budget'));
  const intervalMs = positiveNumber(values.get('--interval'));
  const parallelRaw = positiveNumber(values.get('--parallel'));
  if (budget === null || intervalMs === null || parallelRaw === null ||
    !Number.isSafeInteger(parallelRaw)) return null;

  return { budget, intervalMs, parallel: parallelRaw };
}

function daemonChildArgs(spec: LaunchdSupervisorSpec, release: LaunchdReleaseObservation): string[] {
  return [
    '--release', release.releaseRevision,
    '--observation', release.observationDigest,
    '--budget', String(spec.budget),
    '--interval', String(spec.intervalMs),
    '--parallel', String(spec.parallel),
  ];
}

function daemonChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ASHLR_LAUNCHD_SUPERVISOR: '1' };
  for (const key of [
    'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS',
    'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  ]) {
    delete env[key];
  }
  return env;
}

function exactChildMessage(value: unknown): value is {
  protocol: typeof CHILD_RESULT_PROTOCOL;
  result: DaemonRunResult;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    record['protocol'] === CHILD_RESULT_PROTOCOL &&
    typeof record['result'] === 'object' && record['result'] !== null &&
    !Array.isArray(record['result']);
}

function runDaemonChild(
  spec: LaunchdSupervisorSpec,
  release: LaunchdReleaseObservation,
): Promise<DaemonRunResult> {
  return new Promise((resolve, reject) => {
    let current: LaunchdReleaseObservation;
    try {
      current = observeLaunchdRelease('supervisor');
    } catch {
      reject(new Error('launchd release changed before child spawn'));
      return;
    }
    if (!isLaunchdReleaseObservation(current) || current.observationDigest !== release.observationDigest) {
      reject(new Error('launchd release changed before child spawn'));
      return;
    }
    let child: ReturnType<typeof fork>;
    try {
      child = fork(release.child.path, daemonChildArgs(spec, release), {
        execPath: release.node.path,
        env: daemonChildEnvironment(),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch {
      reject(new Error('launchd daemon child spawn failed'));
      return;
    }

    let settled = false;
    let message: DaemonRunResult | undefined;
    let invalidMessage = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error('launchd daemon child disposition unavailable'));
    };

    child.on('message', (value: unknown) => {
      if (message || !exactChildMessage(value)) {
        invalidMessage = true;
        return;
      }
      message = value.result;
    });
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (invalidMessage || signal !== null || !message ||
        (code !== 0 && code !== 1) || code !== message.termination?.exitCode) {
        fail();
        return;
      }
      settled = true;
      resolve(message);
    });
  });
}

export async function runLaunchdSupervisor(args: readonly string[]): Promise<LaunchdSupervisorResult> {
  const spec = parseSupervisorArgs(args);
  if (!spec) return { exitCode: 0, reason: 'invalid-supervisor-argv' };

  let release: LaunchdReleaseObservation;
  try {
    release = observeLaunchdRelease('supervisor');
  } catch {
    return { exitCode: 0, reason: 'release-observation-invalid' };
  }
  if (!isLaunchdReleaseObservation(release)) {
    return { exitCode: 0, reason: 'release-observation-invalid' };
  }

  try {
    const { loadLaunchdRetryExternalAuthority } = await import('./launchd-retry-transport.js');
    const externalAuthority = await loadLaunchdRetryExternalAuthority(release);
    const controller = await runLaunchdRetryController({
      externalAuthority,
      runDaemon: () => runDaemonChild(spec, release),
    });
    return { exitCode: 0, reason: 'controller-settled', controller };
  } catch {
    return { exitCode: 0, reason: 'supervisor-failure' };
  }
}

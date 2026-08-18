import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { readDaemonActivity, type DaemonActivityReadResult } from './activity.js';
import { diagnoseGuardHealth } from './guard-health.js';
import {
  acquireDaemonServiceLifecycleFence,
  ownsDaemonServiceLifecycleFence,
  releaseDaemonServiceLifecycleFence,
} from './service-lifecycle-fence.js';
import { loadDaemonStateStrict } from './state.js';
import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { readKillSwitch } from '../sandbox/policy.js';

const SAFE_LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface RuntimeActivationStoppedConsumerTrustRoot {
  algorithm: 'ed25519';
  keyId: string;
  publicKeySpki: string;
  validFrom: string;
  validUntil: string;
}

export interface RuntimeActivationStoppedLaunchdState {
  loaded: false;
  disabled: boolean;
}

export interface RuntimeActivationStoppedMaintenanceObservation {
  ok: boolean;
  reason: string;
  daemonRoots: number;
  daemonDescendants: number;
}

/** Provisioning requires a reviewed source change. Runtime input cannot add roots. */
export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_TRUST_ROOTS:
readonly Readonly<RuntimeActivationStoppedConsumerTrustRoot>[] = Object.freeze([]);

export function activityAllowsStoppedRecovery(activity: DaemonActivityReadResult): boolean {
  if (activity.sourceState === 'degraded') return false;
  if (activity.activity === null) return activity.sourceState === 'missing';
  return ['dead', 'reused'].includes(activity.ownerState) &&
    activity.activity.phase === 'post-tick' &&
    activity.activity.activeChildren === 0 &&
    activity.freshness !== 'future';
}

function launchdCommand(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('/bin/launchctl', args, {
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    env: { HOME: userInfo().homedir, PATH: SAFE_LAUNCHD_PATH },
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function launchdAbsent(output: string): boolean {
  return /(?:could not find (?:specified )?service|service .* not found|no such process|not loaded)/iu.test(output);
}

export function observeLaunchdStopped(): RuntimeActivationStoppedLaunchdState {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  const domain = `gui/${uid}`;
  const loaded = launchdCommand(['print', `${domain}/ai.ashlr.daemon`]);
  if (loaded.ok || !launchdAbsent(`${loaded.stdout}\n${loaded.stderr}`)) {
    throw new Error('runtime activation requires launchd service loaded=false');
  }
  const disabled = launchdCommand(['print-disabled', domain]);
  if (!disabled.ok || disabled.stderr.trim() !== '') throw new Error('runtime activation launchd disabled state is unavailable');
  const matches = [...disabled.stdout.matchAll(/"ai\.ashlr\.daemon"\s*=>\s*(enabled|disabled)(?:\s|$)/gu)];
  if (matches.length !== 1 || !matches[0]?.[1]) throw new Error('runtime activation launchd disabled state is ambiguous');
  return { loaded: false, disabled: matches[0][1] === 'disabled' };
}

export function observeMaintenanceDefault(homePath: string): RuntimeActivationStoppedMaintenanceObservation {
  const expectedAshlrHome = join(homePath, '.ashlr');
  const configuredAshlrHome = process.env['ASHLR_HOME'];
  if (configuredAshlrHome !== undefined && configuredAshlrHome !== expectedAshlrHome) {
    return {
      ok: false,
      reason: 'maintenance ASHLR_HOME does not match the operating-system account home',
      daemonRoots: 0,
      daemonDescendants: 1,
    };
  }
  const kill = readKillSwitch();
  if (kill.sourceState !== 'healthy' || kill.state !== 'active' || kill.reason !== 'present') {
    return { ok: false, reason: 'maintenance requires a healthy explicitly engaged kill switch', daemonRoots: 0, daemonDescendants: 0 };
  }
  const health = diagnoseGuardHealth();
  const nonMaintenanceBlocks = health.blocks.filter((entry) => entry.id !== 'kill-switch');
  if (health.sourceQuality?.complete !== true || nonMaintenanceBlocks.length !== 0) {
    return { ok: false, reason: 'maintenance guard sources are degraded or active work remains', daemonRoots: 0, daemonDescendants: 0 };
  }
  const state = loadDaemonStateStrict();
  if (!state.ok || state.state.running !== false || state.state.pid !== null) {
    return { ok: false, reason: 'maintenance requires daemon running=false and pid=null', daemonRoots: 1, daemonDescendants: 0 };
  }
  const activity = readDaemonActivity();
  if (!activityAllowsStoppedRecovery(activity)) {
    return {
      ok: false,
      reason: 'maintenance cannot prove daemon activity is quiescent',
      daemonRoots: activity.activity && !['dead', 'reused'].includes(activity.ownerState) ? 1 : 0,
      daemonDescendants: activity.activity?.activeChildren ?? (activity.activity ? 1 : 0),
    };
  }
  const processes = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8', shell: false, timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
    env: { HOME: userInfo().homedir, PATH: SAFE_LAUNCHD_PATH },
  });
  if (processes.status !== 0 || processes.error || processes.stderr.trim() !== '') {
    return { ok: false, reason: 'maintenance process observation is unavailable', daemonRoots: 0, daemonDescendants: 0 };
  }
  const processRows = processes.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match?.[1] && match[2] && match[3]
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
      : [];
  });
  const rootPids = new Set(processRows.filter(({ command }) =>
    /(?:^|\s)(?:\S*ashlr)(?:\s+)daemon(?:\s+)start(?:\s|$)/u.test(command),
  ).map(({ pid }) => pid));
  const descendantPids = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processRows) {
      if (!rootPids.has(row.pid) && !descendantPids.has(row.pid) &&
        (rootPids.has(row.ppid) || descendantPids.has(row.ppid))) {
        descendantPids.add(row.pid);
        changed = true;
      }
    }
  }
  const daemonRoots = rootPids.size;
  const daemonDescendants = descendantPids.size;
  return daemonRoots === 0 && daemonDescendants === 0
    ? { ok: true, reason: 'healthy engaged kill and zero daemon descendants', daemonRoots: 0, daemonDescendants: 0 }
    : { ok: false, reason: 'maintenance requires zero daemon roots and descendants', daemonRoots, daemonDescendants };
}

export const runtimeActivationStoppedRuntime = Object.freeze({
  roots: RUNTIME_ACTIVATION_STOPPED_CONSUMER_TRUST_ROOTS,
  nowMs: (): number => Date.now(),
  journalKey: (): Buffer | null => loadExistingProvenanceKeyReadOnly(),
  observeLaunchd: (): RuntimeActivationStoppedLaunchdState => observeLaunchdStopped(),
  observeMaintenance: (homePath: string): RuntimeActivationStoppedMaintenanceObservation =>
    observeMaintenanceDefault(homePath),
  acquireOutward: (): object | null => acquireOutwardMutationFence(),
  ownsOutward: (fence: object | null): boolean => ownsOutwardMutationFence(fence as never),
  releaseOutward: (fence: object | null): void => releaseOutwardMutationFence(fence as never),
  acquireLifecycle: (homePath: string): object | null => acquireDaemonServiceLifecycleFence(homePath),
  ownsLifecycle: (fence: object | null): boolean => ownsDaemonServiceLifecycleFence(fence as never),
  releaseLifecycle: (fence: object | null): boolean => releaseDaemonServiceLifecycleFence(fence as never),
});

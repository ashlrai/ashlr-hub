import type { DaemonTick } from '../types.js';
import type { FleetStatus } from '../fleet/status.js';
import { loadDaemonStateStrict } from './state.js';

export type DaemonSourceQuality = NonNullable<FleetStatus['daemon']['sourceQuality']>;

export interface PublicDaemonObservation {
  observedAt: string;
  runtimeState: 'running' | 'stopped' | 'unknown';
  sourceQuality: DaemonSourceQuality;
  running: boolean | null;
  pid: number | null;
  startedAt: string | null;
  lastTickAt: string | null;
  todayDate: string | null;
  todaySpentUsd: number | null;
  itemsProcessed: number | null;
  ticks: DaemonTick[] | null;
  automaticDrainOrdinaryTurnDue?: boolean;
  lastPulseExportAt?: string;
}

function unknownObservation(
  reason: DaemonSourceQuality['reason'],
): PublicDaemonObservation {
  return {
    observedAt: new Date().toISOString(),
    runtimeState: 'unknown',
    sourceQuality: {
      sourceState: 'degraded',
      complete: false,
      reason,
    },
    running: null,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: null,
    itemsProcessed: null,
    ticks: null,
  };
}

/**
 * Combine the strict daemon ledger with FleetStatus's live lock/activity
 * consistency verdict. Operational values are exposed only when both sources
 * describe the same daemon generation.
 */
export function readPublicDaemonObservation(
  fleetDaemon: FleetStatus['daemon'] | undefined,
): PublicDaemonObservation {
  try {
    if (!fleetDaemon) return unknownObservation('unavailable');
    const fleetQuality = fleetDaemon.sourceQuality;
    if (!fleetQuality) return unknownObservation('unavailable');
    if (
      fleetQuality.sourceState !== 'healthy' ||
      fleetQuality.complete !== true
    ) {
      return unknownObservation(fleetQuality.reason);
    }

    const read = loadDaemonStateStrict();
    if (!read.ok) return unknownObservation(read.reason);

    const state = read.state;
    const strictReason = read.fresh ? 'missing' : 'healthy';
    if (fleetDaemon.pid === undefined || fleetDaemon.startedAt === undefined) {
      return unknownObservation('inconsistent');
    }
    const sameGeneration =
      fleetDaemon.running === (state.running === true) &&
      (fleetDaemon.pid ?? null) === (state.pid ?? null) &&
      (fleetDaemon.startedAt ?? null) === (state.startedAt ?? null) &&
      fleetDaemon.lastTickAt === (state.lastTickAt ?? null) &&
      fleetDaemon.todaySpentUsd === state.todaySpentUsd &&
      fleetQuality.reason === strictReason;
    if (!sameGeneration) return unknownObservation('inconsistent');

    return {
      ...state,
      observedAt: new Date().toISOString(),
      runtimeState: state.running ? 'running' : 'stopped',
      sourceQuality: fleetQuality,
    };
  } catch {
    return unknownObservation('unavailable');
  }
}

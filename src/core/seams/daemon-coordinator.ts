/**
 * core/seams/daemon-coordinator.ts — DaemonCoordinator seam (M30).
 *
 * SEAM over core/daemon/state.ts (loadDaemonState / saveDaemonState).
 *
 * LOCAL = single-machine coordination (the current behavior): the daemon owns
 * its own ~/.ashlr/daemon.json; there is no cross-machine lease/lock because
 * there is exactly one machine. The seam also exposes a no-op lease pair so a
 * future multi-machine coordinator is a drop-in.
 *
 *   (a) DaemonCoordinator        — the interface.
 *   (b) LocalDaemonCoordinator   — DEFAULT. Behavior-preserving adapter over
 *                                  core/daemon/state.ts. acquireLease/releaseLease
 *                                  are LOCAL no-ops (single machine => always
 *                                  holds its own lease). ZERO behavior change.
 *   (c) CloudDaemonCoordinator   — GATED stub. A multi-machine lease/lock WOULD
 *                                  live here; every method throws before any I/O.
 *   (d) selectDaemonCoordinator  — local by default; gated stub ONLY when an
 *                                  endpoint is explicitly configured (refuses).
 *
 * HARD SAFETY: local-first + self-hostable + cloud-gated. No new deps.
 */

import { loadDaemonState, saveDaemonState } from '../daemon/state.js';
import type { AshlrConfig, DaemonState } from '../types.js';
import { seamEndpoint } from './registry.js';
import { cloudGatedError } from './types.js';

export const DAEMON_COORDINATOR_SEAM = {
  id: 'daemonCoordinator' as const,
  name: 'DaemonCoordinator',
  delegatesTo: 'core/daemon/state.ts',
  summary: 'Daemon state + coordination (LOCAL = single-machine; cloud = multi-machine lease, gated).',
};

/**
 * Daemon state persistence + (future) cross-machine coordination.
 *
 * `acquireLease` returns whether this process holds the operator lease. On the
 * LOCAL single-machine path this is always true (no contention). A cloud impl
 * WOULD implement a real distributed lease — but that is gated and throws.
 */
export interface DaemonCoordinator {
  /** Load the daemon state (zeroed default on missing/corrupt). */
  load(): DaemonState;
  /** Persist the daemon state atomically. */
  save(s: DaemonState): void;
  /**
   * Acquire the operator lease. LOCAL: always true (single machine, no
   * contention). Cloud: a real distributed lease — gated (throws).
   */
  acquireLease(): boolean;
  /** Release the operator lease. LOCAL: no-op (single machine). */
  releaseLease(): void;
}

/**
 * DEFAULT local impl — single-machine coordination. State methods pass through
 * to core/daemon/state.ts unchanged; the lease pair is a no-op because there is
 * exactly one machine (this preserves the current single-machine semantics).
 */
export class LocalDaemonCoordinator implements DaemonCoordinator {
  load(): DaemonState {
    return loadDaemonState();
  }
  save(s: DaemonState): void {
    saveDaemonState(s);
  }
  acquireLease(): boolean {
    // Single machine — this process always holds its own lease.
    return true;
  }
  releaseLease(): void {
    // Single machine — nothing to release.
  }
}

/**
 * GATED cloud stub — a multi-machine lease/lock coordinator WOULD live here.
 * Every method THROWS first, before any I/O. No socket, no fetch, no disk.
 */
export class CloudDaemonCoordinator implements DaemonCoordinator {
  load(): DaemonState {
    throw cloudGatedError(DAEMON_COORDINATOR_SEAM.name, 'load');
  }
  save(_s: DaemonState): void {
    throw cloudGatedError(DAEMON_COORDINATOR_SEAM.name, 'save');
  }
  acquireLease(): boolean {
    throw cloudGatedError(DAEMON_COORDINATOR_SEAM.name, 'acquireLease');
  }
  releaseLease(): void {
    throw cloudGatedError(DAEMON_COORDINATOR_SEAM.name, 'releaseLease');
  }
}

/** Local by default; gated stub only when an endpoint is configured (refuses). */
export function selectDaemonCoordinator(cfg: AshlrConfig): DaemonCoordinator {
  return seamEndpoint(cfg, 'daemonCoordinator')
    ? new CloudDaemonCoordinator()
    : new LocalDaemonCoordinator();
}

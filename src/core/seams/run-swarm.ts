/**
 * core/seams/run-swarm.ts — RunSwarmStore seam (M30).
 *
 * SEAM over core/swarm/store.ts (listSwarms / loadSwarm / saveSwarm).
 *
 * Shape (mirrors the canonical telemetry-sink seam):
 *   (a) RunSwarmStore        — the interface.
 *   (b) LocalRunSwarmStore   — DEFAULT. A thin, behavior-preserving adapter that
 *                              delegates 1:1 to the existing exported functions.
 *                              ZERO behavior change, identical signatures.
 *   (c) CloudRunSwarmStore   — GATED stub. Every method THROWS the canonical
 *                              gated error as its FIRST statement, before any
 *                              I/O. It performs NO fetch/http and touches NO
 *                              disk/network — it only refuses.
 *   (d) selectRunSwarmStore  — returns LocalRunSwarmStore by default; returns
 *                              the gated stub ONLY when a cloud endpoint is
 *                              explicitly configured for this seam (and that
 *                              stub still refuses). There is NO activation path.
 *
 * HARD SAFETY: local-first + self-hostable + cloud-gated. No new deps.
 */

import { listSwarms, loadSwarm, saveSwarm } from '../swarm/store.js';
import type { AshlrConfig, SwarmRun } from '../types.js';
import { seamEndpoint } from './registry.js';
import { cloudGatedError } from './types.js';

/** The display name + delegate path for diagnostics. */
export const RUN_SWARM_SEAM = {
  id: 'runSwarm' as const,
  name: 'RunSwarmStore',
  delegatesTo: 'core/swarm/store.ts',
  summary: 'Persist + list autonomous run/swarm records (~/.ashlr/swarms/).',
};

/** Persistence + listing of SwarmRun records. */
export interface RunSwarmStore {
  /** List all persisted swarm runs, most-recent first. */
  list(): SwarmRun[];
  /** Load a single swarm run by id, or null when absent/corrupt. */
  load(id: string): SwarmRun | null;
  /** Persist a swarm run record. */
  save(s: SwarmRun): void;
}

/**
 * DEFAULT local impl — a behavior-preserving adapter over core/swarm/store.ts.
 * Each method is a direct pass-through; no logic is added or changed.
 */
export class LocalRunSwarmStore implements RunSwarmStore {
  list(): SwarmRun[] {
    return listSwarms();
  }
  load(id: string): SwarmRun | null {
    return loadSwarm(id);
  }
  save(s: SwarmRun): void {
    saveSwarm(s);
  }
}

/**
 * GATED cloud stub — a multi-machine/team swarm registry WOULD live here.
 * Every method THROWS the canonical gated error FIRST, before any I/O. It never
 * opens a socket, never calls fetch, never touches disk. Referenceable, inert.
 */
export class CloudRunSwarmStore implements RunSwarmStore {
  list(): SwarmRun[] {
    throw cloudGatedError(RUN_SWARM_SEAM.name, 'list');
  }
  load(_id: string): SwarmRun | null {
    throw cloudGatedError(RUN_SWARM_SEAM.name, 'load');
  }
  save(_s: SwarmRun): void {
    throw cloudGatedError(RUN_SWARM_SEAM.name, 'save');
  }
}

/**
 * Select the active RunSwarmStore for a config.
 *  - LocalRunSwarmStore by DEFAULT (no endpoint configured) — the only path the
 *    autonomous loop/daemon can ever reach.
 *  - CloudRunSwarmStore ONLY when a cloud endpoint is explicitly configured for
 *    this seam — and that impl REFUSES (throws) on every method. There is no
 *    way to flip to a functional cloud backbone.
 */
export function selectRunSwarmStore(cfg: AshlrConfig): RunSwarmStore {
  return seamEndpoint(cfg, 'runSwarm') ? new CloudRunSwarmStore() : new LocalRunSwarmStore();
}

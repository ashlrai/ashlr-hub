/**
 * core/seams/work-queue-coordinator.ts — WorkQueueCoordinator seam (M111).
 *
 * SEAM over the per-item claim/skip decision in the daemon fleet loop.
 *
 * LOCAL = single-machine coordination (current behavior, zero change):
 *   claimItems = top-`count` candidates (no real claim needed, no contention);
 *   shouldSkip = per-machine worked-ledger `recentlyDeclined`;
 *   recordOutcome = per-machine worked-ledger.
 *
 * SHARED = multi-machine fleet (filesystem-backed SharedStore):
 *   claimItems atomically claims up to `count` UNCLAIMED (or expired) candidates;
 *   shouldSkip = GLOBAL cooldown from the shared worked ledger;
 *   recordOutcome writes to the shared worked ledger + releases the claim.
 *   No two machines ever receive the same item for the same tick.
 *
 *   (a) WorkQueueCoordinator         — the interface.
 *   (b) LocalWorkQueueCoordinator    — DEFAULT. Current single-machine semantics.
 *   (c) SharedWorkQueueCoordinator   — Multi-machine. Requires a SharedStore.
 *   (d) selectWorkQueueCoordinator   — Shared when cfg.fleet.sharedQueue.mode
 *                                      is 'filesystem' + path is set; else Local.
 *
 * HARD SAFETY: local-first + self-hostable. No new runtime deps. Never throws.
 */

import type { AshlrConfig, WorkItem } from '../types.js';
import {
  loadWorkedLedger,
  recordOutcome as localRecord,
  recentlyDeclined as localRecentlyDeclined,
} from '../fleet/worked-ledger.js';
import { SharedStore } from '../fleet/shared-store.js';
import type { WorkedEvent, WorkedOutcome } from '../fleet/worked-ledger.js';
import { hostname } from 'node:os';

export const WORK_QUEUE_COORDINATOR_SEAM = {
  id: 'workQueueCoordinator' as const,
  name: 'WorkQueueCoordinator',
  delegatesTo: 'core/fleet/worked-ledger.ts + core/fleet/shared-store.ts',
  summary: 'Work-item claim/skip coordination (LOCAL = per-machine; SHARED = multi-machine filesystem lease).',
};

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Coordinates which WorkItems a machine picks up and records outcomes.
 *
 * `claimItems`:    Given a scored candidate list, return up to `count` items
 *                  this machine should process (atomically claimed in multi-
 *                  machine mode; top-K pass-through in single-machine mode).
 * `renew`:         Extend leases for in-flight shared claims during long runs.
 * `release`:       Release uncompleted claims (e.g. on clean shutdown).
 * `recordOutcome`: Write the work result + release the claim.
 * `shouldSkip`:    Returns true when the item should be skipped due to a recent
 *                  'empty' outcome within cooldownMs.
 */
export interface WorkQueueCoordinator {
  claimItems(candidates: WorkItem[], count: number, machineId: string): WorkItem[];
  renew(itemIds: string[], machineId: string): string[];
  release(itemIds: string[], machineId: string): void;
  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean;
  shouldSkip(itemId: string, cooldownMs: number): boolean;
  readWorkedEvents(): WorkedEvent[];
}

// ---------------------------------------------------------------------------
// LocalWorkQueueCoordinator — single-machine, current behavior
// ---------------------------------------------------------------------------

/**
 * DEFAULT single-machine coordinator. Behavior-preserving:
 *  - claimItems: returns the first `count` candidates (no real claim; no
 *    contention on a single machine). Candidates are pre-filtered by the caller
 *    (daemon loop) for cooldown — but shouldSkip is also provided for seam parity.
 *  - shouldSkip: delegates to the LOCAL per-machine worked-ledger.
 *  - recordOutcome: writes to the LOCAL per-machine worked-ledger.
 *  - release: no-op (single machine never needs to un-claim).
 *
 * ZERO behavior change vs. today.
 */
export class LocalWorkQueueCoordinator implements WorkQueueCoordinator {
  claimItems(candidates: WorkItem[], count: number, _machineId: string): WorkItem[] {
    return candidates.slice(0, count);
  }

  release(_itemIds: string[], _machineId: string): void {
    // Single machine — no cross-machine claim to release.
  }

  renew(_itemIds: string[], _machineId: string): string[] {
    // Single machine — no cross-machine lease to renew.
    return [];
  }

  recordOutcome(itemId: string, outcome: WorkedOutcome, _machineId: string): boolean {
    return localRecord(itemId, outcome);
  }

  shouldSkip(itemId: string, cooldownMs: number): boolean {
    return localRecentlyDeclined(itemId, cooldownMs);
  }

  readWorkedEvents(): WorkedEvent[] {
    return loadWorkedLedger().events;
  }
}

// ---------------------------------------------------------------------------
// SharedWorkQueueCoordinator — multi-machine fleet
// ---------------------------------------------------------------------------

/**
 * Multi-machine coordinator backed by a SharedStore.
 *
 *  - claimItems: atomically claims up to `count` candidates not already claimed
 *    by another machine (or with an expired lease → failover path). Items where
 *    shouldSkip returns true are filtered out before claiming.
 *  - shouldSkip: checks the GLOBAL cross-machine worked ledger cooldown.
 *  - recordOutcome: writes to the global ledger and releases the claim.
 *  - release: releases all named claims from this machine.
 *
 * Atomicity: the SharedStore's withLock gate (O_EXCL sentinel) ensures two
 * machines that call claimItems concurrently receive DISJOINT items. Expired
 * leases (older than leaseMs) are reclaimable — a crashed machine's items
 * become available after the lease window.
 */
export class SharedWorkQueueCoordinator implements WorkQueueCoordinator {
  private readonly store: SharedStore;

  constructor(store: SharedStore, _machineId: string, _leaseMs: number) {
    this.store = store;
  }

  claimItems(candidates: WorkItem[], count: number, machineId: string): WorkItem[] {
    const claimedIds = this.store.claimItems(
      candidates.map((i) => i.id),
      count,
      machineId,
    );
    const claimedSet = new Set(claimedIds);
    return candidates.filter((item) => claimedSet.has(item.id));
  }

  release(itemIds: string[], machineId: string): void {
    this.store.releaseItems(itemIds, machineId);
  }

  renew(itemIds: string[], machineId: string): string[] {
    return this.store.renewItems(itemIds, machineId);
  }

  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean {
    return this.store.recordOutcome(itemId, outcome, machineId);
  }

  shouldSkip(itemId: string, cooldownMs: number): boolean {
    return this.store.recentlyDeclined(itemId, cooldownMs);
  }

  readWorkedEvents(): WorkedEvent[] {
    return this.store.readSnapshot().worked;
  }
}

// ---------------------------------------------------------------------------
// selectWorkQueueCoordinator — the seam selector
// ---------------------------------------------------------------------------

/**
 * Return the appropriate WorkQueueCoordinator for the given config:
 *  - `cfg.fleet.sharedQueue.mode === 'filesystem'` AND a path is set
 *    → SharedWorkQueueCoordinator (multi-machine)
 *  - Otherwise → LocalWorkQueueCoordinator (single-machine, default)
 *
 * Single computer: Local (default) — zero behavior change.
 * Many computers:  Shared — atomic no-duplicate claims.
 */
export function selectWorkQueueCoordinator(cfg: AshlrConfig): WorkQueueCoordinator {
  const sq = cfg.fleet?.sharedQueue;
  if (sq?.mode === 'filesystem' && sq.path && sq.path.trim().length > 0) {
    const leaseMs = sq.leaseMs ?? 5 * 60 * 1000;
    const machineId = sq.machineId ?? hostname();
    const store = new SharedStore(sq.path, leaseMs);
    return new SharedWorkQueueCoordinator(store, machineId, leaseMs);
  }
  return new LocalWorkQueueCoordinator();
}

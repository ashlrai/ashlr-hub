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
 *   claimItems atomically claims up to `count` UNCLAIMED (or safely expired) candidates;
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
import type { QueueClaimCooldownPolicy, QueueClaimRef } from '../fleet/shared-store.js';
import type { WorkedEvent, WorkedOutcome } from '../fleet/worked-ledger.js';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const WORK_QUEUE_COORDINATOR_SEAM = {
  id: 'workQueueCoordinator' as const,
  name: 'WorkQueueCoordinator',
  delegatesTo: 'core/fleet/worked-ledger.ts + core/fleet/shared-store.ts',
  summary: 'Work-item claim/skip coordination (LOCAL = per-machine; SHARED = multi-machine filesystem lease).',
};

export interface QueueClaimGeneration {
  readonly itemId: string;
  readonly generationId: string;
}

export interface ClaimedWorkItem {
  readonly item: WorkItem;
  readonly claim: QueueClaimGeneration;
}

function queueClaimGenerationId(ref: QueueClaimRef): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:queue-claim-generation:v1',
    ref.queueId,
    ref.itemId,
    ref.machineId,
    ref.ownerToken,
    ref.epoch,
  ]), 'utf8').digest('hex');
}

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
 * `beginExecution`: Durably cross the shared pre-effect boundary.
 * `release`:       Release uncompleted claims (e.g. on clean shutdown).
 * `recordOutcome`: Write the work result + release the claim.
 * `recordClaimOutcome`: Atomically complete one exact claimed generation.
 * `shouldSkip`:    Returns true when the item should be skipped due to a recent
 *                  'empty' outcome within cooldownMs.
 */
export interface WorkQueueCoordinator {
  claimItems(candidates: WorkItem[], count: number, machineId: string): WorkItem[];
  claimItemsWithGenerations(
    candidates: WorkItem[],
    count: number,
    machineId: string,
  ): ClaimedWorkItem[];
  claimItemsByLane(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): WorkItem[];
  claimItemsByLaneWithGenerations(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): ClaimedWorkItem[];
  renew(itemIds: string[], machineId: string): string[];
  /** Return every item whose current claim still authorizes this coordinator. */
  fence(itemIds: string[], machineId: string): string[];
  /** Fence only the exact claim generations supplied by the selection call. */
  fenceClaimGenerations(
    expected: readonly QueueClaimGeneration[],
    machineId: string,
  ): QueueClaimGeneration[];
  /** Release only exact claimed generations; executing generations are retained. */
  releaseClaimGenerations(expected: readonly QueueClaimGeneration[], machineId: string): void;
  /** Cross the pre-effect boundary for one exact selected generation. */
  beginClaimGenerationExecution(expected: QueueClaimGeneration, machineId: string): boolean;
  beginExecution(itemId: string, machineId: string): boolean;
  /** Clear an exact executing claim after a terminal result with no cooldown. */
  settleClaim(claimItemId: string, machineId: string): boolean;
  release(itemIds: string[], machineId: string): void;
  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean;
  recordClaimOutcome(
    claimItemId: string,
    workedItemId: string,
    outcome: WorkedOutcome,
    machineId: string,
  ): boolean;
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
 *  - release: clears only the in-memory evidence generation; there is no
 *    cross-machine claim to mutate.
 *
 * ZERO behavior change vs. today.
 */
export class LocalWorkQueueCoordinator implements WorkQueueCoordinator {
  private readonly claimGenerations = new Map<string, {
    machineId: string;
    generationId: string;
    phase: 'claimed' | 'executing';
  }>();

  private retainClaimGenerations(items: WorkItem[], machineId: string): WorkItem[] {
    for (const item of items) {
      if (this.claimGenerations.has(item.id)) continue;
      this.claimGenerations.set(item.id, {
        machineId,
        generationId: createHash('sha256').update(JSON.stringify([
          'ashlr:local-queue-claim-generation:v1',
          item.id,
          machineId,
          randomUUID(),
        ]), 'utf8').digest('hex'),
        phase: 'claimed',
      });
    }
    return items;
  }

  claimItems(candidates: WorkItem[], count: number, machineId: string): WorkItem[] {
    return this.retainClaimGenerations(candidates.slice(0, count), machineId);
  }

  claimItemsWithGenerations(
    candidates: WorkItem[],
    count: number,
    machineId: string,
  ): ClaimedWorkItem[] {
    const items = this.claimItems(candidates, count, machineId);
    return items.flatMap((item) => {
      const claim = this.claimGenerations.get(item.id);
      return claim?.machineId === machineId
        ? [{ item, claim: { itemId: item.id, generationId: claim.generationId } }]
        : [];
    });
  }

  claimItemsByLane(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    _cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): WorkItem[] {
    const claimed: WorkItem[] = [];
    const seen = new Set<string>();
    for (const lane of lanes) {
      let laneClaims = 0;
      for (const item of lane.candidates) {
        if (claimed.length >= count || laneClaims >= Math.max(0, Math.floor(lane.limit))) break;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        claimed.push(item);
        laneClaims++;
      }
      if (claimed.length >= count) break;
    }
    return this.retainClaimGenerations(claimed, machineId);
  }

  claimItemsByLaneWithGenerations(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): ClaimedWorkItem[] {
    const items = this.claimItemsByLane(lanes, count, machineId, cooldownPolicies);
    return items.flatMap((item) => {
      const claim = this.claimGenerations.get(item.id);
      return claim?.machineId === machineId
        ? [{ item, claim: { itemId: item.id, generationId: claim.generationId } }]
        : [];
    });
  }

  release(itemIds: string[], machineId: string): void {
    for (const itemId of itemIds) {
      if (this.claimGenerations.get(itemId)?.machineId === machineId) {
        this.claimGenerations.delete(itemId);
      }
    }
  }

  renew(_itemIds: string[], _machineId: string): string[] {
    // Single machine — no cross-machine lease to renew.
    return [];
  }

  fence(itemIds: string[], _machineId: string): string[] {
    return [...itemIds];
  }

  fenceClaimGenerations(
    expected: readonly QueueClaimGeneration[],
    machineId: string,
  ): QueueClaimGeneration[] {
    return expected.flatMap((claim) => {
      const generation = this.claimGenerations.get(claim.itemId);
      return generation?.machineId === machineId &&
        generation.phase === 'claimed' &&
        generation.generationId === claim.generationId
        ? [claim]
        : [];
    });
  }

  releaseClaimGenerations(
    expected: readonly QueueClaimGeneration[],
    machineId: string,
  ): void {
    for (const claim of expected) {
      const generation = this.claimGenerations.get(claim.itemId);
      if (
        generation?.machineId === machineId &&
        generation.phase === 'claimed' &&
        generation.generationId === claim.generationId
      ) this.claimGenerations.delete(claim.itemId);
    }
  }

  beginClaimGenerationExecution(expected: QueueClaimGeneration, machineId: string): boolean {
    const generation = this.claimGenerations.get(expected.itemId);
    if (
      generation?.machineId !== machineId ||
      generation.phase !== 'claimed' ||
      generation.generationId !== expected.generationId
    ) return false;
    generation.phase = 'executing';
    return true;
  }

  beginExecution(itemId: string, machineId: string): boolean {
    const generation = this.claimGenerations.get(itemId);
    if (!generation) return true;
    return this.beginClaimGenerationExecution({
      itemId,
      generationId: generation.generationId,
    }, machineId);
  }

  settleClaim(claimItemId: string, machineId: string): boolean {
    this.release([claimItemId], machineId);
    return true;
  }

  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean {
    const recorded = localRecord(itemId, outcome);
    if (recorded) this.release([itemId], machineId);
    return recorded;
  }

  recordClaimOutcome(
    _claimItemId: string,
    workedItemId: string,
    outcome: WorkedOutcome,
    machineId: string,
  ): boolean {
    const recorded = localRecord(workedItemId, outcome);
    if (recorded) this.release([_claimItemId], machineId);
    return recorded;
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
 *    by another machine. Daemon cooldown policies are rechecked under the claim
 *    lock so a concurrent completion cannot be reclaimed from a stale selection.
 *  - shouldSkip: checks the GLOBAL cross-machine worked ledger cooldown.
 *  - recordOutcome: writes to the global ledger and releases the claim.
 *  - release: releases all named claims from this machine.
 *
 * Atomicity: the SharedStore's withLock gate (O_EXCL sentinel) ensures two
 * machines that call claimItems concurrently receive DISJOINT items. Only an
 * expired modern `claimed` lease is reclaimable. Executing and phase-unknown
 * legacy work remains ambiguous until explicit reconciliation.
 */
export class SharedWorkQueueCoordinator implements WorkQueueCoordinator {
  private readonly store: SharedStore;
  private readonly claims = new Map<string, QueueClaimRef>();
  private readonly claimWorkedItemIds = new Map<string, string>();
  private readonly authorityEnabled: boolean;
  private readonly leaseMs: number;

  constructor(store: SharedStore, _machineId: string, leaseMs: number, authorityEnabled = false) {
    this.store = store;
    this.authorityEnabled = authorityEnabled;
    this.leaseMs = leaseMs;
  }

  private mutationDeadline(): number {
    return Date.now() + Math.min(30_000, Math.max(1_000, this.leaseMs));
  }

  private refreshClaim(ref: QueueClaimRef): QueueClaimRef | null {
    const [renewed] = this.store.renewClaims([ref]);
    if (renewed) return renewed;
    return this.store.validateClaims([ref])[0] ?? null;
  }

  claimItems(candidates: WorkItem[], count: number, machineId: string): WorkItem[] {
    if (!this.authorityEnabled) return [];
    const claimedRefs = this.store.claimLeases(
      candidates.map((i) => i.id),
      count,
      machineId,
    );
    for (const ref of claimedRefs) {
      this.claims.set(ref.itemId, ref);
      this.claimWorkedItemIds.set(ref.itemId, ref.itemId);
    }
    const claimedIds = claimedRefs.map((ref) => ref.itemId);
    const claimedSet = new Set(claimedIds);
    return candidates.filter((item) => claimedSet.has(item.id));
  }

  claimItemsWithGenerations(
    candidates: WorkItem[],
    count: number,
    machineId: string,
  ): ClaimedWorkItem[] {
    const items = this.claimItems(candidates, count, machineId);
    return items.flatMap((item) => {
      const ref = this.claims.get(item.id);
      return ref?.machineId === machineId
        ? [{ item, claim: { itemId: item.id, generationId: queueClaimGenerationId(ref) } }]
        : [];
    });
  }

  claimItemsByLane(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): WorkItem[] {
    if (!this.authorityEnabled) return [];
    const claimedRefs = this.store.claimLeasesByLane(
      lanes.map((lane) => ({ candidateIds: lane.candidates.map((item) => item.id), limit: lane.limit })),
      count,
      machineId,
      cooldownPolicies,
    );
    for (const ref of claimedRefs) {
      this.claims.set(ref.itemId, ref);
      this.claimWorkedItemIds.set(
        ref.itemId,
        cooldownPolicies?.get(ref.itemId)?.itemIds[0] ?? ref.itemId,
      );
    }
    const claimedIds = claimedRefs.map((ref) => ref.itemId);
    const byId = new Map(lanes.flatMap((lane) => lane.candidates).map((item) => [item.id, item]));
    return claimedIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }

  claimItemsByLaneWithGenerations(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): ClaimedWorkItem[] {
    const items = this.claimItemsByLane(
      lanes,
      count,
      machineId,
      cooldownPolicies,
    );
    return items.flatMap((item) => {
      const ref = this.claims.get(item.id);
      return ref?.machineId === machineId
        ? [{ item, claim: { itemId: item.id, generationId: queueClaimGenerationId(ref) } }]
        : [];
    });
  }

  release(itemIds: string[], machineId: string): void {
    if (!this.authorityEnabled) return;
    const refs = itemIds.flatMap((id) => {
      const ref = this.claims.get(id);
      return ref?.machineId === machineId ? [ref] : [];
    });
    for (const id of this.store.releaseClaims(refs)) {
      this.claims.delete(id);
      this.claimWorkedItemIds.delete(id);
    }
  }

  renew(itemIds: string[], machineId: string): string[] {
    if (!this.authorityEnabled) return [];
    const refs = itemIds.flatMap((id) => {
      const ref = this.claims.get(id);
      return ref?.machineId === machineId ? [ref] : [];
    });
    const renewed = this.store.renewClaims(refs);
    const renewedIds = new Set(renewed.map((ref) => ref.itemId));
    const validated = this.store.validateClaims(
      refs.filter((ref) => !renewedIds.has(ref.itemId)),
    );
    const authoritative = [...renewed, ...validated];
    for (const ref of authoritative) this.claims.set(ref.itemId, ref);
    return authoritative.map((ref) => ref.itemId);
  }

  fence(itemIds: string[], machineId: string): string[] {
    return this.renew(itemIds, machineId);
  }

  fenceClaimGenerations(
    expected: readonly QueueClaimGeneration[],
    machineId: string,
  ): QueueClaimGeneration[] {
    const refs = expected.flatMap((claim) => {
      const ref = this.claims.get(claim.itemId);
      return ref?.machineId === machineId &&
        ref.phase === 'claimed' &&
        queueClaimGenerationId(ref) === claim.generationId
        ? [ref]
        : [];
    });
    const renewed = this.store.renewClaims(refs);
    const renewedIds = new Set(renewed.map((ref) => ref.itemId));
    const validated = this.store.validateClaims(
      refs.filter((ref) => !renewedIds.has(ref.itemId)),
    ).filter((ref) => ref.phase === 'claimed');
    const authoritative = [...renewed, ...validated];
    for (const ref of authoritative) this.claims.set(ref.itemId, ref);
    return authoritative.map((ref) => ({
      itemId: ref.itemId,
      generationId: queueClaimGenerationId(ref),
    }));
  }

  releaseClaimGenerations(
    expected: readonly QueueClaimGeneration[],
    machineId: string,
  ): void {
    if (!this.authorityEnabled) return;
    const refs = expected.flatMap((claim) => {
      const ref = this.claims.get(claim.itemId);
      return ref?.machineId === machineId &&
        ref.phase === 'claimed' &&
        queueClaimGenerationId(ref) === claim.generationId
        ? [ref]
        : [];
    });
    for (const itemId of this.store.releaseClaims(refs)) {
      this.claims.delete(itemId);
      this.claimWorkedItemIds.delete(itemId);
    }
  }

  beginClaimGenerationExecution(
    expected: QueueClaimGeneration,
    machineId: string,
  ): boolean {
    if (!this.authorityEnabled) return false;
    let ref = this.claims.get(expected.itemId);
    if (
      !ref ||
      ref.machineId !== machineId ||
      ref.phase !== 'claimed' ||
      queueClaimGenerationId(ref) !== expected.generationId
    ) return false;
    const deadline = this.mutationDeadline();
    for (;;) {
      const result = this.store.beginClaimExecutionResult(ref);
      if (result.status === 'success') {
        this.claims.set(expected.itemId, result.value);
        return true;
      }
      if (result.status === 'authority-lost' || Date.now() >= deadline) return false;
      const refreshed = this.refreshClaim(ref);
      if (
        !refreshed ||
        refreshed.phase !== 'claimed' ||
        queueClaimGenerationId(refreshed) !== expected.generationId
      ) return false;
      ref = refreshed;
      this.claims.set(expected.itemId, ref);
    }
  }

  beginExecution(itemId: string, machineId: string): boolean {
    const ref = this.claims.get(itemId);
    return ref?.machineId === machineId
      ? this.beginClaimGenerationExecution({
          itemId,
          generationId: queueClaimGenerationId(ref),
        }, machineId)
      : false;
  }

  settleClaim(claimItemId: string, machineId: string): boolean {
    if (!this.authorityEnabled) return false;
    let ref = this.claims.get(claimItemId);
    if (!ref || ref.machineId !== machineId) return false;
    const deadline = this.mutationDeadline();
    for (;;) {
      const result = this.store.settleClaimResult(ref);
      if (result.status === 'success') {
        this.claims.delete(claimItemId);
        this.claimWorkedItemIds.delete(claimItemId);
        return true;
      }
      if (result.status === 'authority-lost' || Date.now() >= deadline) return false;
      const refreshed = this.refreshClaim(ref);
      if (!refreshed) return false;
      ref = refreshed;
      this.claims.set(claimItemId, ref);
    }
  }

  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean {
    if (!this.authorityEnabled) return false;
    if (this.claims.has(itemId)) {
      return this.recordClaimOutcome(itemId, itemId, outcome, machineId);
    }
    return this.store.recordOutcome(itemId, outcome, machineId);
  }

  recordClaimOutcome(
    claimItemId: string,
    workedItemId: string,
    outcome: WorkedOutcome,
    machineId: string,
  ): boolean {
    if (!this.authorityEnabled) return false;
    let ref = this.claims.get(claimItemId);
    if (!ref || ref.machineId !== machineId) return false;
    const completionId = randomUUID();
    const deadline = this.mutationDeadline();
    for (;;) {
      const frozenWorkedItemId = this.claimWorkedItemIds.get(claimItemId) ?? workedItemId;
      const result = this.store.completeClaimResult(ref, frozenWorkedItemId, outcome, completionId);
      if (result.status === 'success') {
        this.claims.delete(claimItemId);
        this.claimWorkedItemIds.delete(claimItemId);
        return true;
      }
      if (result.status === 'authority-lost' || Date.now() >= deadline) return false;
      const refreshed = this.refreshClaim(ref);
      if (!refreshed) return false;
      ref = refreshed;
      this.claims.set(claimItemId, ref);
    }
  }

  shouldSkip(itemId: string, cooldownMs: number): boolean {
    if (!this.authorityEnabled) return false;
    return this.store.recentlyDeclined(itemId, cooldownMs);
  }

  readWorkedEvents(): WorkedEvent[] {
    if (!this.authorityEnabled) return [];
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
    return new SharedWorkQueueCoordinator(
      store,
      machineId,
      leaseMs,
      sq.trustedCoherentStorage === true,
    );
  }
  return new LocalWorkQueueCoordinator();
}

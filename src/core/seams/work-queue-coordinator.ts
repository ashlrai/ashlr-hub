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
  recordOutcomeWithKey as localRecordWithKey,
  recentlyDeclined as localRecentlyDeclined,
} from '../fleet/worked-ledger.js';
import { SharedStore } from '../fleet/shared-store.js';
import type { QueueClaimCooldownPolicy, QueueClaimRef, SelectionReceiptBindingV2 } from '../fleet/shared-store.js';
import type { WorkedEvent, WorkedOutcome } from '../fleet/worked-ledger.js';
import { workItemCoverageKey, workItemExecutionKey } from '../fleet/proposal-matching.js';
import {
  readCoordinatorSelectionStartReceiptV2,
  receiptDigestV2,
  rootDigestV2,
  selectionDigestV2,
  writeCoordinatorSelectionStartReceiptV2,
} from '../fleet/selection-start-receipt.js';
import type {
  SelectionStartReceiptRoot,
} from '../fleet/selection-start-receipt.js';
import type { DispatchSelectionObservationV1 } from '../fleet/dispatch-production-ledger.js';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const WORK_QUEUE_COORDINATOR_SEAM = {
  id: 'workQueueCoordinator' as const,
  name: 'WorkQueueCoordinator',
  delegatesTo: 'core/fleet/worked-ledger.ts + core/fleet/shared-store.ts',
  summary: 'Work-item claim/skip coordination (LOCAL = per-machine; SHARED = multi-machine filesystem lease).',
};

/**
 * A non-capability projection of the exact authority that crossed the durable
 * pre-effect boundary. It intentionally omits owner tokens and item identity.
 */
export type ExecutionAuthority =
  | { kind: 'local' }
  | {
      kind: 'shared-queue-v1';
      queueId: string;
      claimEpoch: number;
      claimBindingDigest: string;
    };

export interface RecordSelectionStartReceiptV2Input {
  root: SelectionStartReceiptRoot;
  selectionObservation: DispatchSelectionObservationV1;
  ts: string;
}

export type RecordSelectionStartReceiptV2Result =
  | { status: 'recorded' | 'replayed'; receiptId: string }
  | { status: 'authority-lost' | 'contended' | 'conflicted' | 'unavailable' | 'degraded'; reason: string };

const mintedExecutionAuthorities = new WeakSet<object>();

function mintExecutionAuthority(authority: ExecutionAuthority): ExecutionAuthority {
  const minted = Object.freeze({ ...authority }) as ExecutionAuthority;
  mintedExecutionAuthorities.add(minted);
  return minted;
}

/**
 * Runtime-only proof that an authority came from this coordinator's successful
 * pre-effect transition. This is deliberately process-bound and not durable;
 * a future receipt protocol must consume it before persisting any projection.
 */
export function isMintedExecutionAuthority(value: unknown): value is ExecutionAuthority {
  return !!value && typeof value === 'object' && mintedExecutionAuthorities.has(value);
}

function executionAuthority(ref: QueueClaimRef): ExecutionAuthority {
  return mintExecutionAuthority({
    kind: 'shared-queue-v1',
    queueId: ref.queueId,
    claimEpoch: ref.epoch,
    claimBindingDigest: createHash('sha256')
      .update(`ashlr:execution-authority:v1\0${ref.queueId}\0${ref.epoch}\0${ref.ownerKey}`)
      .digest('hex'),
  });
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
  claimItemsByLane(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): WorkItem[];
  renew(items: WorkItem[], machineId: string): WorkItem[];
  /** Return every item whose current claim still authorizes this coordinator. */
  fence(items: WorkItem[], machineId: string): WorkItem[];
  beginExecution(item: WorkItem, machineId: string): ExecutionAuthority | null;
  /** Clear an exact executing claim after a terminal result with no cooldown. */
  settleClaim(claimItem: WorkItem, machineId: string): boolean;
  release(items: WorkItem[], machineId: string): void;
  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean;
  recordClaimOutcome(
    claimItem: WorkItem,
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
 *  - release: no-op (single machine never needs to un-claim).
 *
 * ZERO behavior change vs. today.
 */
export class LocalWorkQueueCoordinator implements WorkQueueCoordinator {
  claimItems(candidates: WorkItem[], count: number, _machineId: string): WorkItem[] {
    return candidates.slice(0, count);
  }

  claimItemsByLane(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    _machineId: string,
    _cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): WorkItem[] {
    const claimed: WorkItem[] = [];
    // Queue lanes can contain equal scanner IDs from distinct repositories.
    // Keep the same canonical identity used by pending-proposal coverage so a
    // local fleet never silently drops the second repository's work.
    const seen = new Set<string>();
    for (const lane of lanes) {
      let laneClaims = 0;
      for (const item of lane.candidates) {
        if (claimed.length >= count || laneClaims >= Math.max(0, Math.floor(lane.limit))) break;
        const identity = workItemCoverageKey(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        claimed.push(item);
        laneClaims++;
      }
      if (claimed.length >= count) break;
    }
    return claimed;
  }

  release(_items: WorkItem[], _machineId: string): void {
    // Single machine — no cross-machine claim to release.
  }

  renew(_items: WorkItem[], _machineId: string): WorkItem[] {
    // Single machine — no cross-machine lease to renew.
    return [];
  }

  fence(items: WorkItem[], _machineId: string): WorkItem[] {
    return [...items];
  }

  beginExecution(_item: WorkItem, _machineId: string): ExecutionAuthority {
    return mintExecutionAuthority({ kind: 'local' });
  }

  settleClaim(_claimItem: WorkItem, _machineId: string): boolean {
    return true;
  }

  recordOutcome(itemId: string, outcome: WorkedOutcome, _machineId: string): boolean {
    return localRecord(itemId, outcome);
  }

  recordClaimOutcome(
    claimItem: WorkItem,
    workedItemId: string,
    outcome: WorkedOutcome,
    _machineId: string,
  ): boolean {
    return localRecordWithKey(claimItem.id, workedItemId, outcome);
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
  private readonly authorityRefs = new WeakMap<object, QueueClaimRef>();
  private readonly authoritiesByClaim = new Map<string, ExecutionAuthority>();
  private readonly receiptIntentByAuthority = new WeakMap<object, string>();
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

  private executionKey(item: WorkItem): string | null {
    return workItemExecutionKey(item);
  }

  private clearExecutionAuthority(key: string): void {
    const authority = this.authoritiesByClaim.get(key);
    if (authority) {
      this.authorityRefs.delete(authority);
      this.receiptIntentByAuthority.delete(authority);
    }
    this.authoritiesByClaim.delete(key);
  }

  private cacheExecutionAuthority(key: string, ref: QueueClaimRef): ExecutionAuthority {
    const existing = this.authoritiesByClaim.get(key);
    if (existing && this.authorityRefs.has(existing)) {
      this.authorityRefs.set(existing, ref);
      return existing;
    }
    const authority = executionAuthority(ref);
    this.authoritiesByClaim.set(key, authority);
    this.authorityRefs.set(authority, ref);
    return authority;
  }

  private reserveReceiptIntent(
    authority: ExecutionAuthority,
    input: RecordSelectionStartReceiptV2Input,
  ): 'reserved' | 'replay' | 'invalid' | 'conflicted' {
    const rootDigest = rootDigestV2(input.root);
    const selectionDigest = selectionDigestV2(input.selectionObservation);
    if (!rootDigest || !selectionDigest || !Number.isFinite(Date.parse(input.ts))) return 'invalid';
    const intent = createHash('sha256').update(JSON.stringify([
      'ashlr:selection-start-receipt-intent:v2', rootDigest, selectionDigest, input.ts,
    ]), 'utf8').digest('hex');
    const existing = this.receiptIntentByAuthority.get(authority);
    if (existing) return existing === intent ? 'replay' : 'conflicted';
    this.receiptIntentByAuthority.set(authority, intent);
    return 'reserved';
  }

  claimItems(candidates: WorkItem[], count: number, machineId: string): WorkItem[] {
    if (!this.authorityEnabled) return [];
    const candidatesByKey = new Map<string, WorkItem>();
    for (const item of candidates) {
      const key = this.executionKey(item);
      if (key === null) return [];
      if (candidatesByKey.has(key)) continue;
      candidatesByKey.set(key, item);
    }
    const defaultPolicies = new Map<string, QueueClaimCooldownPolicy>(
      [...candidatesByKey].map(([key, item]) => [
        key,
        { itemIds: [item.id], cooldownMs: 6 * 60 * 60 * 1000 },
      ]),
    );
    const claimedRefs = this.store.claimLeases(
      [...candidatesByKey.keys()],
      count,
      machineId,
      defaultPolicies,
    );
    for (const ref of claimedRefs) {
      this.claims.set(ref.itemId, ref);
      this.claimWorkedItemIds.set(ref.itemId, workItemCoverageKey(candidatesByKey.get(ref.itemId)!));
    }
    const claimedIds = claimedRefs.map((ref) => ref.itemId);
    const claimedSet = new Set(claimedIds);
    const returnedKeys = new Set<string>();
    return candidates.filter((item) => {
      const key = this.executionKey(item);
      if (key === null || returnedKeys.has(key) || !claimedSet.has(key)) return false;
      returnedKeys.add(key);
      return true;
    });
  }

  claimItemsByLane(
    lanes: Array<{ candidates: WorkItem[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): WorkItem[] {
    if (!this.authorityEnabled) return [];
    const byKey = new Map<string, WorkItem>();
    const sharedLanes = lanes.map((lane) => {
      const candidateIds: string[] = [];
      for (const item of lane.candidates) {
        const key = this.executionKey(item);
        if (key === null) return null;
        if (!byKey.has(key)) byKey.set(key, item);
        candidateIds.push(key);
      }
      return { candidateIds, limit: lane.limit };
    });
    if (sharedLanes.some((lane) => lane === null)) return [];
    const claimedRefs = this.store.claimLeasesByLane(
      sharedLanes as Array<{ candidateIds: string[]; limit: number }>,
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
    return claimedIds.flatMap((id) => {
      const item = byKey.get(id);
      return item ? [item] : [];
    });
  }

  release(items: WorkItem[], machineId: string): void {
    if (!this.authorityEnabled) return;
    const refs = items.flatMap((item) => {
      const key = this.executionKey(item);
      const ref = key === null ? undefined : this.claims.get(key);
      return ref?.machineId === machineId ? [ref] : [];
    });
    for (const id of this.store.releaseClaims(refs)) {
      this.claims.delete(id);
      this.claimWorkedItemIds.delete(id);
      this.clearExecutionAuthority(id);
    }
  }

  renew(items: WorkItem[], machineId: string): WorkItem[] {
    if (!this.authorityEnabled) return [];
    const itemsByKey = new Map(items.flatMap((item) => {
      const key = this.executionKey(item);
      return key === null ? [] : [[key, item] as const];
    }));
    const refs = [...itemsByKey.keys()].flatMap((key) => {
      const ref = this.claims.get(key);
      return ref?.machineId === machineId ? [ref] : [];
    });
    const renewed = this.store.renewClaims(refs);
    const renewedIds = new Set(renewed.map((ref) => ref.itemId));
    const validated = this.store.validateClaims(
      refs.filter((ref) => !renewedIds.has(ref.itemId)),
    );
    const authoritative = [...renewed, ...validated];
    for (const ref of authoritative) {
      this.claims.set(ref.itemId, ref);
      const authority = this.authoritiesByClaim.get(ref.itemId);
      if (authority) this.authorityRefs.set(authority, ref);
    }
    return authoritative.flatMap((ref) => {
      const item = itemsByKey.get(ref.itemId);
      return item ? [item] : [];
    });
  }

  fence(items: WorkItem[], machineId: string): WorkItem[] {
    return this.renew(items, machineId);
  }

  beginExecution(item: WorkItem, machineId: string): ExecutionAuthority | null {
    if (!this.authorityEnabled) return null;
    const key = this.executionKey(item);
    if (key === null) return null;
    let ref = this.claims.get(key);
    if (!ref || ref.machineId !== machineId) return null;
    const deadline = this.mutationDeadline();
    for (;;) {
      const result = this.store.beginClaimExecutionResult(ref);
      if (result.status === 'success') {
        this.claims.set(key, result.value);
        return this.cacheExecutionAuthority(key, result.value);
      }
      if (result.status === 'authority-lost' || Date.now() >= deadline) return null;
      const refreshed = this.refreshClaim(ref);
      if (!refreshed) return null;
      ref = refreshed;
      this.claims.set(key, ref);
    }
  }

  /**
   * Join one exact process-minted execution authority to a durable V2 receipt.
   * This is deliberately inert until a future daemon producer can supply a
   * canonical eligible selection observation at the external-engine boundary.
   */
  recordSelectionStartReceiptV2(
    authority: ExecutionAuthority,
    input: RecordSelectionStartReceiptV2Input,
  ): RecordSelectionStartReceiptV2Result {
    if (!isMintedExecutionAuthority(authority) || authority.kind !== 'shared-queue-v1') {
      return { status: 'authority-lost', reason: 'unminted-or-local-authority' };
    }
    const ref = this.authorityRefs.get(authority);
    if (!ref || ref.phase !== 'executing') return { status: 'authority-lost', reason: 'foreign-or-settled-authority' };
    const intent = this.reserveReceiptIntent(authority, input);
    if (intent === 'invalid') return { status: 'unavailable', reason: 'invalid-receipt-input' };
    if (intent === 'conflicted') return { status: 'conflicted', reason: 'authority-already-bound-to-different-receipt' };
    const local = writeCoordinatorSelectionStartReceiptV2({
      ...input,
      claim: {
        queueId: ref.queueId,
        claimEpoch: ref.epoch,
        claimBindingDigest: createHash('sha256')
          .update(`ashlr:execution-authority:v1\0${ref.queueId}\0${ref.epoch}\0${ref.ownerKey}`)
          .digest('hex'),
      },
    });
    if ('reason' in local) {
      return { status: local.status, reason: local.reason };
    }
    const persisted = readCoordinatorSelectionStartReceiptV2(local.receipt.receiptId);
    if (persisted.status !== 'found') return { status: 'degraded', reason: 'receipt-readback-failed' };
    const receiptDigest = receiptDigestV2(persisted.receipt);
    const rootDigest = rootDigestV2(persisted.receipt.root);
    const selectionDigest = selectionDigestV2(persisted.receipt.selectionObservation);
    if (!receiptDigest || !rootDigest || !selectionDigest) {
      return { status: 'degraded', reason: 'receipt-digest-invalid' };
    }
    const binding: SelectionReceiptBindingV2 = {
      schemaVersion: 2,
      receiptId: persisted.receipt.receiptId,
      receiptDigest,
      queueId: ref.queueId,
      claimEpoch: ref.epoch,
      claimBindingDigest: persisted.receipt.claim.claimBindingDigest,
      rootDigest,
      selectionDigest,
      committedAt: persisted.receipt.ts,
    };
    const bound = this.store.bindSelectionReceipt(ref, binding);
    if (bound.status !== 'success') {
      if (bound.status === 'authority-lost') this.clearExecutionAuthority(ref.itemId);
      return bound.status === 'contended'
        ? { status: 'contended', reason: 'binding-contended' }
        : { status: 'authority-lost', reason: 'binding-authority-lost' };
    }
    const rereadReceipt = readCoordinatorSelectionStartReceiptV2(persisted.receipt.receiptId);
    const rereadBinding = this.store.readSelectionReceiptBinding(persisted.receipt.receiptId);
    if (
      rereadReceipt.status !== 'found' || rereadBinding.status !== 'found' ||
      JSON.stringify(rereadReceipt.receipt) !== JSON.stringify(persisted.receipt) ||
      JSON.stringify(rereadBinding.binding) !== JSON.stringify(binding)
    ) return { status: 'degraded', reason: 'receipt-binding-readback-failed' };
    return { status: local.status, receiptId: persisted.receipt.receiptId };
  }

  settleClaim(claimItem: WorkItem, machineId: string): boolean {
    if (!this.authorityEnabled) return false;
    const key = this.executionKey(claimItem);
    if (key === null) return false;
    let ref = this.claims.get(key);
    if (!ref || ref.machineId !== machineId) return false;
    const deadline = this.mutationDeadline();
    for (;;) {
      const result = this.store.settleClaimResult(ref);
      if (result.status === 'success') {
        this.claims.delete(key);
        this.claimWorkedItemIds.delete(key);
        this.clearExecutionAuthority(key);
        return true;
      }
      if (result.status === 'authority-lost' || Date.now() >= deadline) return false;
      const refreshed = this.refreshClaim(ref);
      if (!refreshed) return false;
      ref = refreshed;
      this.claims.set(key, ref);
    }
  }

  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean {
    if (!this.authorityEnabled) return false;
    return this.store.recordOutcome(itemId, outcome, machineId);
  }

  recordClaimOutcome(
    claimItem: WorkItem,
    workedItemId: string,
    outcome: WorkedOutcome,
    machineId: string,
  ): boolean {
    if (!this.authorityEnabled) return false;
    const key = this.executionKey(claimItem);
    if (key === null) return false;
    let ref = this.claims.get(key);
    if (!ref || ref.machineId !== machineId) return false;
    const completionId = randomUUID();
    const deadline = this.mutationDeadline();
    for (;;) {
      const frozenWorkedItemId = this.claimWorkedItemIds.get(key) ?? workedItemId;
      const result = this.store.completeClaimResult(ref, frozenWorkedItemId, outcome, completionId);
      if (result.status === 'success') {
        this.claims.delete(key);
        this.claimWorkedItemIds.delete(key);
        this.clearExecutionAuthority(key);
        return true;
      }
      if (result.status === 'authority-lost' || Date.now() >= deadline) return false;
      const refreshed = this.refreshClaim(ref);
      if (!refreshed) return false;
      ref = refreshed;
      this.claims.set(key, ref);
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

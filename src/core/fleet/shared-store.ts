/**
 * core/fleet/shared-store.ts — M111: atomic shared state store for multi-machine fleets.
 *
 * Backs the SharedWorkQueueCoordinator. A single JSON file on a coherent shared
 * filesystem serves as the rendezvous point. Replicated sync folders such as
 * iCloud Drive and Dropbox are not linearizable stores and are not suitable for
 * the strong execution-authority contract in this module.
 *
 * Atomicity + locking
 * -------------------
 *  - Writes: tmp-file + POSIX rename (O_EXCL-safe; avoids torn reads).
 *  - Claims: a tokenized `.lock` sentinel created with O_EXCL. Exact inode/token
 *    ownership is revalidated before writes and release. Stale reclamation pins
 *    the exact inode with a hard link so a delayed owner cannot delete a successor.
 *
 * Never-throws contract
 * ---------------------
 *  EVERY public method is try/catch-wrapped and returns a safe default on any
 *  error (missing path, permission denied, corrupt JSON, lock contention).
 *  The local fleet MUST keep working even when the shared folder is unavailable.
 */

import {
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  linkSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  constants,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';
import {
  isSuppressibleWorkedOutcome,
  isWorkedOutcome,
  latestWorkedEventForKeys,
  workedEventIsCooling,
} from './worked-ledger.js';
import type { WorkedOutcome, WorkedEvent } from './worked-ledger.js';

// ---------------------------------------------------------------------------
// Shared store schema
// ---------------------------------------------------------------------------

/** One active claim (lease) held by a machine on an item. */
export interface ItemClaim {
  /**
   * On disk this is either a legacy logical machine id or a versioned owner key.
   * Modern owner keys embed the logical machine, acquisition token/epoch, and
   * claimed/executing phase so downgrade readers preserve authority verbatim.
   */
  machineId: string;
  /** Absolute epoch ms when this lease expires; expired = reclaimable. */
  leaseUntil: number;
}

export type QueueClaimPhase = 'claimed' | 'executing';

/** Opaque exact-generation authority returned only to the claiming process. */
export interface QueueClaimRef {
  itemId: string;
  machineId: string;
  ownerKey: string;
  ownerToken: string;
  queueId: string;
  epoch: number;
  phase: QueueClaimPhase;
  leaseUntil: number;
}

export type QueueClaimMutationResult<T> =
  | { status: 'success'; value: T }
  | { status: 'contended' }
  | { status: 'authority-lost' };

/** Cooldown evidence that must still be clear when the claim lock is held. */
export interface QueueClaimCooldownPolicy {
  itemIds: readonly string[];
  cooldownMs: number;
  outcomeCooldownMs?: Readonly<Partial<Record<WorkedOutcome, number>>>;
}

/** Cross-machine subscription/usage ledger entry (M114: cross-machine throttle). */
export interface UsageEntry {
  machineId: string;
  engine: string;
  ts: string;
  /** 0–100 subscription window utilisation at time of publish (M114). */
  usedPercent?: number;
  /** Human-readable window label, e.g. "5h", "7d" (M114). */
  windowLabel?: string;
  /** Unix epoch seconds when the window resets (M114). */
  resetsAt?: number;
}

/** The on-disk JSON schema for the shared fleet queue. */
export interface SharedFleetQueue {
  /** Present once modern fenced claims have been created. */
  schemaVersion?: 2;
  /** Queue-incarnation fence; changing/missing metadata invalidates old refs. */
  queueId?: string;
  /** Next queue-wide claim epoch. */
  nextClaimEpoch?: number;
  /** Active claims: itemId → claim. Expired claims are reclaimable. */
  claims: Record<string, ItemClaim>;
  /** Global worked outcomes — cross-machine cooldown. Bounded to ~2000 entries. */
  worked: WorkedEvent[];
  /** Cross-machine subscription/usage ledger. */
  usage: UsageEntry[];
}

/** Per-machine claim counts for read-only queue health surfaces. */
export interface SharedQueueMachineHealth {
  machineId: string;
  active: number;
  expired: number;
  executing?: number;
  ambiguous?: number;
}

/** Bounded item-level lease sample for read-only operator/debug surfaces. */
export interface SharedQueueClaimSample {
  itemId: string;
  machineId: string;
  leaseUntil: string | null;
  state: 'active' | 'reclaimable' | 'executing' | 'ambiguous';
  phase?: QueueClaimPhase;
  owned: boolean;
}

/** Read-only health summary of the shared filesystem queue. */
export interface SharedQueueHealth {
  /** Shared directory path backing the queue. */
  path: string;
  /** Lease duration used by this store instance. */
  leaseMs: number;
  /** True when the queue file is absent or readable/parseable. */
  readable: boolean;
  /** Local primitive probe only; never proof of cross-host linearizability. */
  capability: {
    scope: 'local-primitives-only';
    durabilityPolicy: 'posix-file-and-directory-fsync' | 'windows-file-fsync-atomic-rename';
    checked: boolean;
    verified: boolean;
    failure: string | null;
  };
  /** Active, non-expired claims across all machines. */
  activeClaims: number;
  /** Active claims currently owned by the requested machine. */
  ownedClaims: number;
  /** Expired claims that can be reclaimed by another machine. */
  expiredClaims: number;
  /** Alias for expiredClaims, named for operator-facing status surfaces. */
  reclaimableClaims: number;
  /** Claims that have crossed the durable pre-effect boundary. */
  executingClaims?: number;
  /** Expired executing claims that require reconciliation, never takeover. */
  ambiguousClaims?: number;
  /** Claim counts grouped by machine id. */
  claimsByMachine: SharedQueueMachineHealth[];
  /** Bounded item-level lease samples; metadata only, never item prompts/details. */
  claimSamples: SharedQueueClaimSample[];
  /** ISO timestamp of the soonest active lease expiry, or null when none. */
  nextLeaseExpiryAt: string | null;
  /** Age in ms of the oldest expired claim, or null when none. */
  oldestExpiredMs: number | null;
  /** Total bounded worked-ledger events currently retained. */
  workedEvents: number;
  /** Unique items currently in the shared empty-result cooldown window. */
  cooldownItems: number;
  /** Total shared subscription usage entries currently retained. */
  usageEntries: number;
  /** Advisory lock status. */
  lock: {
    present: boolean;
    ageMs: number | null;
    stale: boolean;
    /** Extra hard links mean a crashed/paused exact-inode guard requires operator recovery. */
    links?: number | null;
    recoveryRequired?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_FILENAME = 'ashlr-fleet-queue.json';
const LOCK_FILENAME  = 'ashlr-fleet-queue.json.lock';
const MAX_WORKED     = 2000;
const MAX_CLAIM_SAMPLES = 12;
/** How long (ms) a lock file may be held before it is considered stale. */
const STALE_LOCK_MULTIPLIER = 2;
const MIN_STALE_LOCK_MS = 30_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 min
const MODERN_QUEUE_SCHEMA_VERSION = 2 as const;
const MODERN_OWNER_PREFIX = 'ashlr-q2';
const MAX_MACHINE_ID_BYTES = 512;
const MAX_OWNER_KEY_BYTES = 1_024;
const MAX_ITEM_ID_BYTES = 2_048;
const MAX_COOLDOWN_KEYS = 32;
const DEFAULT_CLAIM_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const LOCK_RETRY_SLEEP_MS = 10;
const LOCK_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const CAPABILITY_FAILURE_RETRY_MS = 60_000;
const CAPABILITY_SUCCESS_RECHECK_MS = 5 * 60_000;

interface CachedCapabilityStatus {
  checkedAt: number;
  verified: boolean;
  failure: string | null;
}

const capabilityStatusByPath = new Map<string, CachedCapabilityStatus>();
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_CLAIMS = 20_000;
const MAX_USAGE = 2_000;
const LEGACY_EXECUTING_LEASE = Number.MAX_SAFE_INTEGER;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

interface ModernClaimOwner {
  machineId: string;
  tokenHash: string;
  epoch: number;
  phase: QueueClaimPhase;
  leaseUntil: number;
}

interface SharedStoreLock {
  path: string;
  token: string;
  dev: bigint;
  ino: bigint;
}

function validCooldownMs(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function candidateIsCooling(
  worked: readonly WorkedEvent[],
  policy: QueueClaimCooldownPolicy,
  now: number,
): boolean {
  if (
    !validCooldownMs(policy.cooldownMs) ||
    policy.itemIds.length === 0 || policy.itemIds.length > MAX_COOLDOWN_KEYS ||
    policy.itemIds.some((id) =>
      typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > MAX_ITEM_ID_BYTES
    )
  ) return true;
  const latest = latestWorkedEventForKeys(worked, policy.itemIds);
  if (!latest) return false;
  const override = policy.outcomeCooldownMs?.[latest.outcome];
  if (override !== undefined && !validCooldownMs(override)) return true;
  if (override !== undefined) {
    if (override === 0) return false;
    const eventMs = Date.parse(latest.ts);
    return !Number.isFinite(eventMs) || now - eventMs < override;
  }
  return workedEventIsCooling(latest, policy.cooldownMs, now);
}

function defaultClaimCooldownPolicy(itemId: string): QueueClaimCooldownPolicy {
  return {
    itemIds: [itemId],
    cooldownMs: DEFAULT_CLAIM_COOLDOWN_MS,
    // Worked v1 does not distinguish executor diffs from historical
    // merge:shipped credit, so diff rows cannot suppress queue claims.
    outcomeCooldownMs: { diff: 0 },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyQueue(): SharedFleetQueue {
  return { claims: Object.create(null) as Record<string, ItemClaim>, worked: [], usage: [] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ownerTokenHash(ownerToken: string): string {
  return createHash('sha256')
    .update('ashlr:shared-queue-owner:v2\0')
    .update(ownerToken)
    .digest('hex');
}

function encodeOwner(owner: Omit<ModernClaimOwner, 'tokenHash'> & { ownerToken: string }): string {
  const phase = owner.phase === 'claimed' ? 'c' : 'e';
  const machine = Buffer.from(owner.machineId, 'utf8').toString('base64url');
  return `${MODERN_OWNER_PREFIX}:${phase}:${owner.epoch.toString(36)}:${machine}:` +
    `${ownerTokenHash(owner.ownerToken)}:${owner.leaseUntil.toString(36)}`;
}

function parseModernOwner(value: string): ModernClaimOwner | null | 'invalid' {
  if (!value.startsWith(`${MODERN_OWNER_PREFIX}:`)) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_OWNER_KEY_BYTES) return 'invalid';
  const parts = value.split(':');
  if (parts.length !== 6 || parts[0] !== MODERN_OWNER_PREFIX) return 'invalid';
  const phase = parts[1] === 'c' ? 'claimed' : parts[1] === 'e' ? 'executing' : null;
  const epoch = Number.parseInt(parts[2] ?? '', 36);
  const encodedMachine = parts[3] ?? '';
  const tokenHash = parts[4] ?? '';
  const leaseUntil = Number.parseInt(parts[5] ?? '', 36);
  if (
    !/^[0-9a-z]+$/.test(parts[2] ?? '') || epoch.toString(36) !== parts[2] ||
    !/^[0-9a-z]+$/.test(parts[5] ?? '') || leaseUntil.toString(36) !== parts[5] ||
    !phase || !Number.isSafeInteger(epoch) || epoch < 1 ||
    !Number.isSafeInteger(leaseUntil) || leaseUntil < 1 ||
    !/^[a-f0-9]{64}$/.test(tokenHash)
  ) return 'invalid';
  try {
    const machineId = Buffer.from(encodedMachine, 'base64url').toString('utf8');
    if (
      machineId.length === 0 ||
      Buffer.byteLength(machineId, 'utf8') > MAX_MACHINE_ID_BYTES ||
      Buffer.from(machineId, 'utf8').toString('base64url') !== encodedMachine
    ) return 'invalid';
    return { machineId, tokenHash, epoch, phase, leaseUntil };
  } catch {
    return 'invalid';
  }
}

function logicalMachineId(value: string): string {
  const owner = parseModernOwner(value);
  return owner && owner !== 'invalid' ? owner.machineId : value;
}

function parseQueue(raw: string): { queue: SharedFleetQueue; valid: boolean } {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) return { queue: emptyQueue(), valid: false };
  const claims = isPlainObject(parsed['claims'])
    ? (parsed['claims'] as Record<string, unknown>)
    : null;
  if (!claims || !Array.isArray(parsed['worked']) || !Array.isArray(parsed['usage'])) {
    return { queue: emptyQueue(), valid: false };
  }
  if (
    Object.keys(claims).length > MAX_CLAIMS ||
    parsed['worked'].length > MAX_WORKED ||
    parsed['usage'].length > MAX_USAGE
  ) return { queue: emptyQueue(), valid: false };
  const validClaims = Object.create(null) as Record<string, ItemClaim>;
  let maxModernEpoch = 0;
  let modernClaims = 0;
  for (const [k, v] of Object.entries(claims)) {
    if (
      isPlainObject(v) &&
      Buffer.byteLength(k, 'utf8') <= MAX_ITEM_ID_BYTES &&
      typeof v['machineId'] === 'string' &&
      v['machineId'].length > 0 &&
      Buffer.byteLength(v['machineId'], 'utf8') <= MAX_OWNER_KEY_BYTES &&
      typeof v['leaseUntil'] === 'number' &&
      Number.isSafeInteger(v['leaseUntil']) && v['leaseUntil'] >= 1
    ) {
      const owner = parseModernOwner(v['machineId']);
      if (owner === 'invalid') return { queue: emptyQueue(), valid: false };
      if (owner) {
        if (
          (owner.phase === 'claimed' && v['leaseUntil'] !== owner.leaseUntil) ||
          (owner.phase === 'executing' && v['leaseUntil'] !== LEGACY_EXECUTING_LEASE)
        ) return { queue: emptyQueue(), valid: false };
        modernClaims++;
        maxModernEpoch = Math.max(maxModernEpoch, owner.epoch);
      }
      validClaims[k] = { machineId: v['machineId'], leaseUntil: v['leaseUntil'] };
    } else {
      return { queue: emptyQueue(), valid: false };
    }
  }
  const worked = parsed['worked'] as unknown[];
  if (!worked.every((e): e is WorkedEvent =>
    isPlainObject(e) &&
    typeof e['itemId'] === 'string' &&
    Buffer.byteLength(e['itemId'], 'utf8') <= MAX_ITEM_ID_BYTES &&
    typeof e['ts'] === 'string' &&
    Buffer.byteLength(e['ts'], 'utf8') <= 128 &&
    isWorkedOutcome(e['outcome']) &&
    (e['proposalId'] === undefined ||
      (typeof e['proposalId'] === 'string' && Buffer.byteLength(e['proposalId'], 'utf8') <= MAX_ITEM_ID_BYTES)) &&
    (e['claimCompletionId'] === undefined ||
      (typeof e['claimCompletionId'] === 'string' && UUID_RE.test(e['claimCompletionId'])))
  )) return { queue: emptyQueue(), valid: false };
  const usage = parsed['usage'] as unknown[];
  if (!usage.every((e): e is UsageEntry =>
    isPlainObject(e) &&
    typeof e['machineId'] === 'string' &&
    e['machineId'].length > 0 &&
    Buffer.byteLength(e['machineId'], 'utf8') <= MAX_MACHINE_ID_BYTES &&
    typeof e['engine'] === 'string' &&
    e['engine'].length > 0 &&
    Buffer.byteLength(e['engine'], 'utf8') <= 128 &&
    typeof e['ts'] === 'string' && Buffer.byteLength(e['ts'], 'utf8') <= 128 &&
    (e['usedPercent'] === undefined ||
      (typeof e['usedPercent'] === 'number' && Number.isFinite(e['usedPercent']) &&
        e['usedPercent'] >= 0 && e['usedPercent'] <= 100)) &&
    (e['windowLabel'] === undefined ||
      (typeof e['windowLabel'] === 'string' && Buffer.byteLength(e['windowLabel'], 'utf8') <= 128)) &&
    (e['resetsAt'] === undefined ||
      (typeof e['resetsAt'] === 'number' && Number.isSafeInteger(e['resetsAt']) && e['resetsAt'] >= 0))
  )) return { queue: emptyQueue(), valid: false };

  const hasModernMetadata = parsed['schemaVersion'] !== undefined ||
    parsed['queueId'] !== undefined || parsed['nextClaimEpoch'] !== undefined;
  const modernMetadataValid =
    parsed['schemaVersion'] === MODERN_QUEUE_SCHEMA_VERSION &&
    typeof parsed['queueId'] === 'string' && UUID_RE.test(parsed['queueId']) &&
    Number.isSafeInteger(parsed['nextClaimEpoch']) &&
    Number(parsed['nextClaimEpoch']) > maxModernEpoch &&
    Number(parsed['nextClaimEpoch']) <= Number.MAX_SAFE_INTEGER;
  if ((modernClaims > 0 || hasModernMetadata) && !modernMetadataValid) {
    return { queue: emptyQueue(), valid: false };
  }
  const queue: SharedFleetQueue = { claims: validClaims, worked, usage };
  if (modernMetadataValid) {
    queue.schemaVersion = MODERN_QUEUE_SCHEMA_VERSION;
    queue.queueId = parsed['queueId'] as string;
    queue.nextClaimEpoch = Number(parsed['nextClaimEpoch']);
  }
  return { queue, valid: true };
}

function safeIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function compactMetadata(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

// ---------------------------------------------------------------------------
// SharedStore
// ---------------------------------------------------------------------------

/**
 * Atomic, never-throws shared state store for multi-machine fleet coordination.
 *
 * All methods degrade safely when `dirPath` is missing or unwritable — they
 * return empty/no-op values instead of throwing.
 */
export class SharedStore {
  private readonly dirPath: string;
  private readonly leaseMs: number;
  private readonly ownedClaims = new Map<string, QueueClaimRef>();
  private storageCapabilitiesVerifiedAt = 0;

  constructor(dirPath: string, leaseMs: number = DEFAULT_LEASE_MS) {
    this.dirPath = dirPath;
    this.leaseMs = Number.isFinite(leaseMs) && leaseMs > 0
      ? Math.max(1, Math.floor(leaseMs))
      : DEFAULT_LEASE_MS;
  }

  private queuePath(): string {
    return join(this.dirPath, QUEUE_FILENAME);
  }

  private lockPath(): string {
    return join(this.dirPath, LOCK_FILENAME);
  }

  /** Ensure the shared directory exists. Returns false when not creatable. */
  private ensureDir(): boolean {
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true });
      }
      const directory = lstatSync(this.dirPath, { bigint: true });
      return !directory.isSymbolicLink() && directory.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Verify the primitives required by the strong authority contract before
   * installing the real queue lock. Unsupported mounts fail closed without
   * leaving that lock behind.
   */
  private verifyStorageCapabilities(): boolean {
    const now = Date.now();
    if (!this.ensureDir()) {
      capabilityStatusByPath.set(this.dirPath, {
        checkedAt: now, verified: false, failure: 'directory-create',
      });
      return false;
    }
    if (
      this.storageCapabilitiesVerifiedAt > 0 &&
      now - this.storageCapabilitiesVerifiedAt < CAPABILITY_SUCCESS_RECHECK_MS
    ) return true;
    const cached = capabilityStatusByPath.get(this.dirPath);
    if (cached?.verified && now - cached.checkedAt < CAPABILITY_SUCCESS_RECHECK_MS) {
      this.storageCapabilitiesVerifiedAt = cached.checkedAt;
      return true;
    }
    if (cached && now - cached.checkedAt < CAPABILITY_FAILURE_RETRY_MS) return false;
    const stem = join(this.dirPath, `.ashlr-queue-capability-${process.pid}-${randomUUID()}`);
    const linked = `${stem}.link`;
    const installed = `${stem}.installed`;
    const firstPayload = 'ashlr-shared-queue-capability-v1\n';
    const secondPayload = 'ashlr-shared-queue-capability-v2\n';
    let fd: number | undefined;
    let stage = 'directory-create';
    try {
      stage = 'exclusive-create';
      fd = openSync(
        stem,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
        0o600,
      );
      stage = 'file-write-fsync';
      writeFileSync(fd, firstPayload, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      stage = 'hard-link';
      linkSync(stem, linked);
      const source = lstatSync(stem, { bigint: true });
      const pin = lstatSync(linked, { bigint: true });
      if (
        source.isSymbolicLink() || !source.isFile() || source.nlink !== 2n ||
        source.dev !== pin.dev || source.ino !== pin.ino
      ) {
        capabilityStatusByPath.set(this.dirPath, {
          checkedAt: Date.now(), verified: false, failure: 'hard-link-identity',
        });
        return false;
      }
      stage = 'unlink';
      unlinkSync(linked);
      stage = 'atomic-rename';
      renameSync(stem, installed);
      stage = 'rename-read-after-write';
      fd = openSync(installed, constants.O_RDONLY | NOFOLLOW_FLAG);
      const firstRead = Buffer.alloc(Buffer.byteLength(firstPayload));
      const firstBytes = readSync(fd, firstRead, 0, firstRead.length, 0);
      const firstStat = fstatSync(fd, { bigint: true });
      if (!firstStat.isFile() || firstBytes !== firstRead.length || firstRead.toString('utf8') !== firstPayload) {
        throw new Error('renamed capability bytes unavailable');
      }
      closeSync(fd);
      fd = undefined;
      stage = 'replacement-create';
      fd = openSync(
        stem,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
        0o600,
      );
      writeFileSync(fd, secondPayload, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      stage = 'atomic-replace';
      renameSync(stem, installed);
      stage = 'replacement-read-after-write';
      fd = openSync(installed, constants.O_RDONLY | NOFOLLOW_FLAG);
      const secondRead = Buffer.alloc(Buffer.byteLength(secondPayload));
      const secondBytes = readSync(fd, secondRead, 0, secondRead.length, 0);
      const secondStat = fstatSync(fd, { bigint: true });
      if (!secondStat.isFile() || secondBytes !== secondRead.length || secondRead.toString('utf8') !== secondPayload) {
        throw new Error('replacement capability bytes unavailable');
      }
      closeSync(fd);
      fd = undefined;
      unlinkSync(installed);
      stage = 'directory-fsync';
      fsyncDirectory(this.dirPath);
      this.storageCapabilitiesVerifiedAt = Date.now();
      capabilityStatusByPath.set(this.dirPath, {
        checkedAt: Date.now(),
        verified: true,
        failure: null,
      });
      return true;
    } catch {
      capabilityStatusByPath.set(this.dirPath, {
        checkedAt: Date.now(),
        verified: false,
        failure: stage,
      });
      return false;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      for (const residue of [linked, stem, installed]) {
        try { if (existsSync(residue)) unlinkSync(residue); } catch { /* fail closed */ }
      }
    }
  }

  /** Read cached local primitive evidence; probing is explicit and mutating. */
  readCapabilityStatus(opts: { probe?: boolean } = {}): SharedQueueHealth['capability'] {
    const verified = opts.probe === true
      ? this.verifyStorageCapabilities()
      : capabilityStatusByPath.get(this.dirPath)?.verified === true;
    const cached = capabilityStatusByPath.get(this.dirPath);
    return {
      scope: 'local-primitives-only',
      durabilityPolicy: process.platform === 'win32'
        ? 'windows-file-fsync-atomic-rename'
        : 'posix-file-and-directory-fsync',
      checked: cached !== undefined,
      verified,
      failure: verified ? null : (cached?.failure ?? 'unavailable'),
    };
  }

  /** Read the queue from disk. Returns emptyQueue() on any error. */
  private readQueue(): SharedFleetQueue {
    return this.readQueueResult().queue;
  }

  /** Read the queue with a success bit for operator health reporting. */
  private readQueueResult(): { queue: SharedFleetQueue; readable: boolean } {
    let fd: number | undefined;
    try {
      const p = this.queuePath();
      if (!existsSync(p)) return { queue: emptyQueue(), readable: true };
      const named = lstatSync(p, { bigint: true });
      if (named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n) {
        return { queue: emptyQueue(), readable: false };
      }
      fd = openSync(p, constants.O_RDONLY | NOFOLLOW_FLAG);
      const opened = fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() || opened.nlink !== 1n ||
        opened.dev !== named.dev || opened.ino !== named.ino ||
        opened.size < 2n || opened.size > BigInt(MAX_QUEUE_BYTES)
      ) return { queue: emptyQueue(), readable: false };
      const bytes = Buffer.alloc(Number(opened.size));
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) {
        return { queue: emptyQueue(), readable: false };
      }
      const raw = bytes.toString('utf8');
      const parsed = parseQueue(raw);
      return { queue: parsed.queue, readable: parsed.valid };
    } catch {
      return { queue: emptyQueue(), readable: false };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  /**
   * Write the queue atomically (tmp + rename). Never throws.
   * Bounds worked events to MAX_WORKED.
   */
  private writeQueue(q: SharedFleetQueue): boolean {
    let tmp: string | null = null;
    let fd: number | undefined;
    try {
      if (!this.ensureDir()) return false;
      const bounded: SharedFleetQueue = {
        ...q,
        worked: q.worked.slice(-MAX_WORKED),
        usage: q.usage.slice(-MAX_USAGE),
      };
      const encoded = Buffer.from(`${JSON.stringify(bounded, null, 2)}\n`, 'utf8');
      if (
        encoded.byteLength > MAX_QUEUE_BYTES ||
        !parseQueue(encoded.toString('utf8')).valid
      ) return false;
      const dest = this.queuePath();
      tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
      fd = openSync(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
        0o600,
      );
      writeFileSync(fd, encoded);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, dest);
      tmp = null;
      fsyncDirectory(this.dirPath);
      return true;
    } catch {
      // Persistence failure must not crash the fleet.
      if (tmp) {
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          // Best-effort cleanup only.
        }
      }
      return false;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    }
  }

  /**
   * Acquire the advisory .lock file using O_EXCL (atomic create-or-fail).
   * Removes stale locks older than 2× leaseMs. Returns exact lock authority or
   * null on contention/uncertainty. Reads do not use this path.
   *
   * Callers MUST call releaseLock() after acquiring.
   */
  private safelyUnlinkLock(path: string, expected: { dev: bigint; ino: bigint }): boolean {
    const guard = `${path}.unlink-${process.pid}-${randomUUID()}.guard`;
    let guarded = false;
    try {
      const current = lstatSync(path, { bigint: true });
      if (
        current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n ||
        current.dev !== expected.dev || current.ino !== expected.ino
      ) return false;
      linkSync(path, guard);
      guarded = true;
      const pinned = lstatSync(guard, { bigint: true });
      const stillCurrent = lstatSync(path, { bigint: true });
      if (
        pinned.dev !== expected.dev || pinned.ino !== expected.ino || pinned.nlink !== 2n ||
        stillCurrent.dev !== expected.dev || stillCurrent.ino !== expected.ino ||
        stillCurrent.nlink !== 2n
      ) return false;
      unlinkSync(path);
      const remaining = lstatSync(guard, { bigint: true });
      return remaining.dev === expected.dev && remaining.ino === expected.ino && remaining.nlink === 1n;
    } catch {
      return false;
    } finally {
      if (guarded) {
        try { unlinkSync(guard); } catch { /* uncertain residue remains fail-closed */ }
      }
    }
  }

  private ownsLock(lock: SharedStoreLock): boolean {
    let fd: number | undefined;
    try {
      const named = lstatSync(lock.path, { bigint: true });
      if (
        named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n ||
        named.dev !== lock.dev || named.ino !== lock.ino
      ) return false;
      fd = openSync(lock.path, constants.O_RDONLY | NOFOLLOW_FLAG);
      const opened = fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() || opened.nlink !== 1n || opened.dev !== lock.dev ||
        opened.ino !== lock.ino || opened.size < 2n || opened.size > 512n
      ) return false;
      const bytes = Buffer.alloc(Number(opened.size));
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
      const owner = JSON.parse(bytes.toString('utf8')) as { token?: unknown };
      return owner.token === lock.token;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  /** Pin the exact lock inode across the queue commit so stale takeover cannot overlap it. */
  private pinLock(lock: SharedStoreLock): string | null {
    const guard = `${lock.path}.commit-${process.pid}-${randomUUID()}.guard`;
    let linked = false;
    let pinned = false;
    try {
      if (!this.ownsLock(lock)) return null;
      linkSync(lock.path, guard);
      linked = true;
      const named = lstatSync(lock.path, { bigint: true });
      const pinnedStat = lstatSync(guard, { bigint: true });
      if (
        named.isSymbolicLink() || !named.isFile() || named.nlink !== 2n ||
        named.dev !== lock.dev || named.ino !== lock.ino ||
        pinnedStat.nlink !== 2n || pinnedStat.dev !== lock.dev || pinnedStat.ino !== lock.ino
      ) return null;
      pinned = true;
      return guard;
    } catch {
      return null;
    } finally {
      if (linked && !pinned) {
        try {
          const residue = lstatSync(guard, { bigint: true });
          if (residue.dev === lock.dev && residue.ino === lock.ino) unlinkSync(guard);
        } catch { /* fail closed */ }
      }
    }
  }

  private unpinLock(guard: string, lock: SharedStoreLock): void {
    try {
      const pinned = lstatSync(guard, { bigint: true });
      if (pinned.dev === lock.dev && pinned.ino === lock.ino) unlinkSync(guard);
    } catch { /* residue remains fail-closed */ }
  }

  private acquireLock(): SharedStoreLock | null {
    try {
      if (!this.verifyStorageCapabilities()) return null;
      const lp = this.lockPath();
      // Remove stale lock if it exists and is old enough.
      if (existsSync(lp)) {
        try {
          const stale = lstatSync(lp, { bigint: true });
          if (stale.isSymbolicLink() || !stale.isFile() || stale.nlink !== 1n) return null;
          const age = Date.now() - Number(stale.mtimeMs);
          if (age > this.staleLockMs()) {
            if (!this.safelyUnlinkLock(lp, stale)) return null;
          } else {
            return null; // Lock is held by another process.
          }
        } catch {
          return null;
        }
      }
      const token = randomUUID();
      let fd: number | undefined;
      let candidateIdentity: { dev: bigint; ino: bigint } | null = null;
      let acquired: SharedStoreLock | null = null;
      try {
        fd = openSync(
          lp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
          0o600,
        );
        const opened = fstatSync(fd, { bigint: true });
        candidateIdentity = { dev: opened.dev, ino: opened.ino };
        if (!opened.isFile() || opened.nlink !== 1n) return null;
        writeFileSync(fd, `${JSON.stringify({ token, createdAt: new Date().toISOString() })}\n`, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        const installed = lstatSync(lp, { bigint: true });
        if (
          installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1n ||
          installed.dev !== opened.dev || installed.ino !== opened.ino
        ) return null;
        acquired = { path: lp, token, dev: installed.dev, ino: installed.ino };
        return acquired;
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* best effort */ }
        }
        if (!acquired && candidateIdentity) {
          this.safelyUnlinkLock(lp, candidateIdentity);
        }
      }
    } catch {
      return null;
    }
  }

  private releaseLock(lock: SharedStoreLock): void {
    if (!this.ownsLock(lock)) return;
    this.safelyUnlinkLock(lock.path, lock);
  }

  private acquireLockWithRetry(maxWaitMs: number): SharedStoreLock | null {
    const deadline = Date.now() + Math.max(0, Math.floor(maxWaitMs));
    for (;;) {
      const lock = this.acquireLock();
      if (lock) return lock;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      Atomics.wait(LOCK_RETRY_SIGNAL, 0, 0, Math.min(LOCK_RETRY_SLEEP_MS, remaining));
    }
  }

  private authorityMutationRetryMs(): number {
    return Math.min(1_000, Math.max(100, Math.floor(this.leaseMs / 10)));
  }

  private staleLockMs(): number {
    return Math.max(MIN_STALE_LOCK_MS, this.leaseMs * STALE_LOCK_MULTIPLIER);
  }

  /**
   * Run a read-modify-write operation under the advisory lock.
   * `fn` receives the current queue and returns the modified queue.
   * If the lock cannot be acquired, returns `fallback`.
   */
  private withLock<T>(
    fn: (q: SharedFleetQueue) => { queue: SharedFleetQueue; result: T },
    fallback: T,
    opts: { retryLockMs?: number } = {},
  ): T {
    const lock = opts.retryLockMs
      ? this.acquireLockWithRetry(opts.retryLockMs)
      : this.acquireLock();
    if (!lock) return fallback;
    try {
      const current = this.readQueueResult();
      if (!current.readable) return fallback;
      const q = current.queue;
      const { queue, result } = fn(q);
      const pin = this.pinLock(lock);
      if (!pin) return fallback;
      try {
        return this.writeQueue(queue) ? result : fallback;
      } finally {
        this.unpinLock(pin, lock);
      }
    } catch {
      return fallback;
    } finally {
      this.releaseLock(lock);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Atomically claim up to `count` unclaimed (or expired) items for `machineId`.
   * Returns the itemIds that were successfully claimed.
   * Items not in `candidates` are ignored. Never throws.
   */
  claimItems(candidateIds: string[], count: number, machineId: string): string[] {
    return this.claimItemsByLane([{ candidateIds, limit: count }], count, machineId);
  }

  /** Atomically claim a total budget while preserving independent lane caps. */
  claimItemsByLane(
    lanes: Array<{ candidateIds: string[]; limit: number }>,
    count: number,
    machineId: string,
  ): string[] {
    const refs = this.claimLeasesByLane(lanes, count, machineId);
    for (const ref of refs) this.ownedClaims.set(ref.itemId, ref);
    return refs.map((ref) => ref.itemId);
  }

  /** Claim exact-generation leases for a coordinator that retains capabilities. */
  claimLeases(
    candidateIds: string[],
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): QueueClaimRef[] {
    return this.claimLeasesByLane([{ candidateIds, limit: count }], count, machineId, cooldownPolicies);
  }

  /** Atomically claim lanes and return opaque refs instead of bare item ids. */
  claimLeasesByLane(
    lanes: Array<{ candidateIds: string[]; limit: number }>,
    count: number,
    machineId: string,
    cooldownPolicies?: ReadonlyMap<string, QueueClaimCooldownPolicy>,
  ): QueueClaimRef[] {
    if (
      !this.ensureDir() || machineId.length === 0 ||
      Buffer.byteLength(machineId, 'utf8') > MAX_MACHINE_ID_BYTES ||
      !Number.isFinite(count) || count <= 0
    ) return [];
    const claimLimit = Math.min(MAX_CLAIMS, Math.floor(count));
    return this.withLock((q) => {
      const now = Date.now();
      const claimed: QueueClaimRef[] = [];
      const seen = new Set<string>();
      let claimCount = Object.keys(q.claims).length;
      if (q.schemaVersion === undefined) {
        q.schemaVersion = MODERN_QUEUE_SCHEMA_VERSION;
        q.queueId = randomUUID();
        q.nextClaimEpoch = Math.max(1, Math.floor(now));
      }
      if (
        q.schemaVersion !== MODERN_QUEUE_SCHEMA_VERSION ||
        !q.queueId || !UUID_RE.test(q.queueId) ||
        !Number.isSafeInteger(q.nextClaimEpoch) ||
        (q.nextClaimEpoch ?? 0) < 1
      ) return { queue: q, result: [] };
      for (const lane of lanes) {
        let laneClaims = 0;
        const laneLimit = Math.max(0, Math.floor(lane.limit));
        for (const id of lane.candidateIds) {
          if (claimed.length >= claimLimit || laneClaims >= laneLimit) break;
          if (
            typeof id !== 'string' || id.length === 0 ||
            Buffer.byteLength(id, 'utf8') > MAX_ITEM_ID_BYTES
          ) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          const cooldownPolicy = cooldownPolicies?.get(id) ?? defaultClaimCooldownPolicy(id);
          if (candidateIsCooling(q.worked, cooldownPolicy, now)) continue;
          const existing = q.claims[id];
          const existingOwner = existing ? parseModernOwner(existing.machineId) : null;
          // Executing work is durable ambiguity after expiry, never failover.
          // Legacy claims have no durable phase bit. During mixed-version
          // operation an expired legacy lease may still be executing, so only
          // an expired modern `claimed` generation is automatically reclaimable.
          const claimable = !existing ||
            (existingOwner !== null && existingOwner !== 'invalid' &&
              existingOwner.phase === 'claimed' && existingOwner.leaseUntil <= now);
          if (claimable) {
            if (!existing && claimCount >= MAX_CLAIMS) break;
            const epoch = q.nextClaimEpoch ?? 0;
            if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch >= Number.MAX_SAFE_INTEGER) break;
            q.nextClaimEpoch = epoch + 1;
            const ownerToken = randomUUID();
            const phase: QueueClaimPhase = 'claimed';
            const leaseUntil = now + this.leaseMs;
            const ownerKey = encodeOwner({ machineId, ownerToken, epoch, phase, leaseUntil });
            q.claims[id] = { machineId: ownerKey, leaseUntil };
            if (!existing) claimCount++;
            claimed.push({
              itemId: id,
              machineId,
              ownerKey,
              ownerToken,
              queueId: q.queueId,
              epoch,
              phase,
              leaseUntil,
            });
            laneClaims++;
          }
        }
        if (claimed.length >= claimLimit) break;
      }
      return { queue: q, result: claimed };
    }, []);
  }

  /**
   * Release claims held by `machineId` on the given itemIds.
   * Silently ignores ids not claimed by this machine. Never throws.
   */
  releaseItems(itemIds: string[], machineId: string): void {
    const refs = itemIds.flatMap((id) => {
      const ref = this.ownedClaims.get(id);
      return ref?.machineId === machineId ? [ref] : [];
    });
    for (const id of this.releaseClaims(refs)) this.ownedClaims.delete(id);
  }

  /**
   * Renew active claims held by `machineId` on the given itemIds.
   * Returns the ids whose leases were extended. Missing, expired, or non-owned
   * claims are ignored so another machine's reclaimed work is never stolen back.
   */
  renewItems(itemIds: string[], machineId: string): string[] {
    const refs = itemIds.flatMap((id) => {
      const ref = this.ownedClaims.get(id);
      return ref?.machineId === machineId ? [ref] : [];
    });
    const renewed = this.renewClaims(refs);
    for (const ref of renewed) this.ownedClaims.set(ref.itemId, ref);
    return renewed.map((ref) => ref.itemId);
  }

  private claimMatches(q: SharedFleetQueue, ref: QueueClaimRef): boolean {
    const expectedOwnerKey = encodeOwner({
      machineId: ref.machineId,
      ownerToken: ref.ownerToken,
      epoch: ref.epoch,
      phase: ref.phase,
      leaseUntil: ref.leaseUntil,
    });
    return q.schemaVersion === MODERN_QUEUE_SCHEMA_VERSION &&
      q.queueId === ref.queueId &&
      ref.ownerKey === expectedOwnerKey &&
      q.claims[ref.itemId]?.machineId === expectedOwnerKey;
  }

  private claimCapabilityMatches(q: SharedFleetQueue, ref: QueueClaimRef): ModernClaimOwner | null {
    const claim = q.claims[ref.itemId];
    const owner = claim ? parseModernOwner(claim.machineId) : null;
    if (
      q.schemaVersion !== MODERN_QUEUE_SCHEMA_VERSION || q.queueId !== ref.queueId ||
      !owner || owner === 'invalid' || owner.machineId !== ref.machineId ||
      owner.epoch !== ref.epoch || owner.phase !== ref.phase ||
      owner.tokenHash !== ownerTokenHash(ref.ownerToken)
    ) return null;
    return owner;
  }

  private readExactClaim(
    ref: QueueClaimRef,
    phase: QueueClaimPhase = ref.phase,
  ): { readable: boolean; ref: QueueClaimRef | null } {
    const current = this.readQueueResult();
    if (!current.readable) return { readable: false, ref: null };
    const expected = { ...ref, phase };
    const owner = this.claimCapabilityMatches(current.queue, expected);
    if (!owner) return { readable: true, ref: null };
    return {
      readable: true,
      ref: {
        ...expected,
        ownerKey: current.queue.claims[ref.itemId]!.machineId,
        leaseUntil: owner.leaseUntil,
      },
    };
  }

  /** Read-only exact-capability probe used to distinguish lock contention from authority loss. */
  validateClaims(refs: QueueClaimRef[]): QueueClaimRef[] {
    try {
      if (refs.length === 0) return [];
      const current = this.readQueueResult();
      if (!current.readable) return [];
      const now = Date.now();
      return refs.flatMap((ref) => {
        const owner = this.claimCapabilityMatches(current.queue, ref);
        if (!owner || owner.leaseUntil <= now) return [];
        return [{
          ...ref,
          ownerKey: current.queue.claims[ref.itemId]!.machineId,
          leaseUntil: owner.leaseUntil,
        }];
      });
    } catch {
      return [];
    }
  }

  /** Renew exact, still-active claim generations. */
  renewClaims(refs: QueueClaimRef[]): QueueClaimRef[] {
    if (!this.ensureDir() || refs.length === 0) return [];
    return this.withLock((q) => {
      const now = Date.now();
      const renewed: QueueClaimRef[] = [];
      for (const ref of refs) {
        const claim = q.claims[ref.itemId];
        if (!claim || !this.claimMatches(q, ref) || ref.leaseUntil <= now) continue;
        const leaseUntil = Math.max(ref.leaseUntil, now + this.leaseMs);
        const ownerKey = encodeOwner({
          machineId: ref.machineId,
          ownerToken: ref.ownerToken,
          epoch: ref.epoch,
          phase: ref.phase,
          leaseUntil,
        });
        claim.machineId = ownerKey;
        claim.leaseUntil = ref.phase === 'executing' ? LEGACY_EXECUTING_LEASE : leaseUntil;
        renewed.push({ ...ref, ownerKey, leaseUntil });
      }
      return { queue: q, result: renewed };
    }, []);
  }

  /** Cross the durable pre-effect boundary for one exact active claim. */
  beginClaimExecution(ref: QueueClaimRef): QueueClaimRef | null {
    const result = this.beginClaimExecutionResult(ref);
    return result.status === 'success' ? result.value : null;
  }

  beginClaimExecutionResult(ref: QueueClaimRef): QueueClaimMutationResult<QueueClaimRef> {
    if (!this.ensureDir()) return { status: 'contended' };
    const executing = this.withLock((q) => {
      const now = Date.now();
      const claim = q.claims[ref.itemId];
      if (
        !claim || ref.phase !== 'claimed' || !this.claimMatches(q, ref) ||
        ref.leaseUntil <= now
      ) return { queue: q, result: null };
      const phase: QueueClaimPhase = 'executing';
      const ownerKey = encodeOwner({
        machineId: ref.machineId,
        ownerToken: ref.ownerToken,
        epoch: ref.epoch,
        phase,
        leaseUntil: ref.leaseUntil,
      });
      claim.machineId = ownerKey;
      claim.leaseUntil = LEGACY_EXECUTING_LEASE;
      const executing = { ...ref, ownerKey, phase };
      return { queue: q, result: executing };
    }, null, { retryLockMs: this.authorityMutationRetryMs() });
    if (executing) return { status: 'success', value: executing };
    const installed = this.readExactClaim(ref, 'executing');
    if (installed.ref) return { status: 'success', value: installed.ref };
    const current = this.readExactClaim(ref);
    if (!installed.readable || !current.readable || (current.ref && current.ref.leaseUntil > Date.now())) {
      return { status: 'contended' };
    }
    return { status: 'authority-lost' };
  }

  /** Release exact claimed generations. Executing claims require completion. */
  releaseClaims(refs: QueueClaimRef[]): string[] {
    if (!this.ensureDir() || refs.length === 0) return [];
    return this.withLock((q) => {
      const released: string[] = [];
      for (const ref of refs) {
        if (ref.phase !== 'claimed' || !this.claimMatches(q, ref)) continue;
        delete q.claims[ref.itemId];
        released.push(ref.itemId);
      }
      return { queue: q, result: released };
    }, [], { retryLockMs: this.authorityMutationRetryMs() });
  }

  /** Atomically append an authoritative outcome and clear its exact claim. */
  completeClaim(
    ref: QueueClaimRef,
    workedItemId: string,
    outcome: WorkedOutcome,
  ): boolean {
    return this.completeClaimResult(ref, workedItemId, outcome, randomUUID()).status === 'success';
  }

  completeClaimResult(
    ref: QueueClaimRef,
    workedItemId: string,
    outcome: WorkedOutcome,
    completionId: string,
  ): QueueClaimMutationResult<undefined> {
    if (
      !this.ensureDir() || !UUID_RE.test(completionId) ||
      workedItemId.length === 0 || Buffer.byteLength(workedItemId, 'utf8') > MAX_ITEM_ID_BYTES ||
      !isWorkedOutcome(outcome)
    ) return { status: 'authority-lost' };
    const completed = this.withLock((q) => {
      const claim = q.claims[ref.itemId];
      if (!claim || !this.claimMatches(q, ref) || ref.leaseUntil <= Date.now()) {
        return { queue: q, result: false };
      }
      q.worked.push({
        itemId: workedItemId,
        outcome,
        ts: new Date().toISOString(),
        claimCompletionId: completionId,
      });
      delete q.claims[ref.itemId];
      return { queue: q, result: true };
    }, false, { retryLockMs: this.authorityMutationRetryMs() });
    if (completed) return { status: 'success', value: undefined };
    const current = this.readQueueResult();
    if (!current.readable) return { status: 'contended' };
    if (current.queue.worked.some((event) => event.claimCompletionId === completionId)) {
      return { status: 'success', value: undefined };
    }
    const installed = this.readExactClaim(ref);
    if (!installed.readable || (installed.ref && installed.ref.leaseUntil > Date.now())) {
      return { status: 'contended' };
    }
    return { status: 'authority-lost' };
  }

  /** Clear an exact terminal claim without creating a cooldown event. */
  settleClaim(ref: QueueClaimRef): boolean {
    return this.settleClaimResult(ref).status === 'success';
  }

  settleClaimResult(ref: QueueClaimRef): QueueClaimMutationResult<undefined> {
    if (!this.ensureDir()) return { status: 'contended' };
    const settled = this.withLock((q) => {
      const claim = q.claims[ref.itemId];
      if (
        !claim || ref.phase !== 'executing' || !this.claimMatches(q, ref) ||
        ref.leaseUntil <= Date.now()
      ) return { queue: q, result: false };
      delete q.claims[ref.itemId];
      return { queue: q, result: true };
    }, false, { retryLockMs: this.authorityMutationRetryMs() });
    if (settled) return { status: 'success', value: undefined };
    const current = this.readQueueResult();
    if (!current.readable) return { status: 'contended' };
    if (!current.queue.claims[ref.itemId]) return { status: 'success', value: undefined };
    const installed = this.readExactClaim(ref);
    if (!installed.readable || (installed.ref && installed.ref.leaseUntil > Date.now())) {
      return { status: 'contended' };
    }
    return { status: 'authority-lost' };
  }

  /**
   * Append a worked outcome to the global shared ledger.
   * Also releases the claim if one exists. Never throws.
   */
  recordOutcome(itemId: string, outcome: WorkedOutcome, machineId: string): boolean {
    if (!this.ensureDir()) return false;
    const ref = this.ownedClaims.get(itemId);
    if (ref?.machineId === machineId) {
      const completed = this.completeClaim(ref, itemId, outcome);
      if (completed) this.ownedClaims.delete(itemId);
      return completed;
    }
    return this.withLock((q) => {
      q.worked.push({ itemId, outcome, ts: new Date().toISOString() });
      return { queue: q, result: true };
    }, false);
  }

  /**
   * Returns true when the item's last global outcome was 'empty' AND was
   * recorded within the last `cooldownMs` ms. Never throws.
   */
  recentlyDeclined(itemId: string, cooldownMs: number, now?: number): boolean {
    try {
      const q = this.readQueue();
      let last: WorkedEvent | undefined;
      for (let i = q.worked.length - 1; i >= 0; i--) {
        if (q.worked[i]!.itemId === itemId) {
          last = q.worked[i];
          break;
        }
      }
      if (!last || !isSuppressibleWorkedOutcome(last.outcome)) return false;
      const eventMs = Date.parse(last.ts);
      if (Number.isNaN(eventMs)) return false;
      return (now ?? Date.now()) - eventMs < cooldownMs;
    } catch {
      return false;
    }
  }

  /**
   * Append a usage entry to the cross-machine subscription/usage ledger.
   * Called by the subscription-usage agent (other agent wires this). Never throws.
   */
  recordUsage(machineId: string, engine: string): void {
    if (!this.ensureDir()) return;
    this.withLock((q) => {
      q.usage.push({ machineId, engine, ts: new Date().toISOString() });
      return { queue: q, result: undefined };
    }, undefined);
  }

  /**
   * M114: Publish this machine's current subscription utilisation for `engine`.
   * Upserts (replaces any prior entry for machineId+engine) so the ledger holds
   * only the freshest reading per machine. Never throws.
   */
  publishUsage(entry: UsageEntry): void {
    try {
      if (!this.ensureDir()) return;
      this.withLock((q) => {
        // Upsert: replace the most-recent entry for this machineId+engine pair.
        let idx = -1;
        for (let i = q.usage.length - 1; i >= 0; i--) {
          const e = q.usage[i]!;
          if (e.machineId === entry.machineId && e.engine === entry.engine) {
            idx = i;
            break;
          }
        }
        if (idx !== -1) {
          q.usage.splice(idx, 1);
        }
        q.usage.push(entry);
        return { queue: q, result: undefined };
      }, undefined);
    } catch {
      // Best-effort — never propagate.
    }
  }

  /**
   * M114: Read all usage entries for a given engine, optionally filtered to
   * entries whose resetsAt is in the future (non-expired) and whose ts is within
   * `maxAgeMs` ms of `now`. Returns [] when the store is unavailable. Never throws.
   */
  readUsageEntries(
    engine: string,
    opts: { maxAgeMs?: number; now?: number } = {},
  ): UsageEntry[] {
    try {
      const q = this.readQueue();
      const now = opts.now ?? Date.now();
      return q.usage.filter((e) => {
        if (e.engine !== engine) return false;
        // Drop entries whose window has already reset (resetsAt is epoch seconds).
        if (e.resetsAt !== undefined && e.resetsAt * 1000 <= now) return false;
        // Drop entries older than maxAgeMs.
        if (opts.maxAgeMs !== undefined) {
          const entryMs = Date.parse(e.ts);
          if (Number.isNaN(entryMs) || now - entryMs > opts.maxAgeMs) return false;
        }
        return true;
      });
    } catch {
      return [];
    }
  }

  /**
   * Read the current queue state (no lock needed — read-only snapshot).
   * Returns emptyQueue() when the store is unavailable. Never throws.
   */
  readSnapshot(): SharedFleetQueue {
    const queue = this.readQueue();
    return {
      ...queue,
      claims: Object.fromEntries(Object.entries(queue.claims).map(([itemId, claim]) => [
        itemId,
        {
          ...claim,
          machineId: logicalMachineId(claim.machineId),
          leaseUntil: (() => {
            const modern = parseModernOwner(claim.machineId);
            return modern && modern !== 'invalid' ? modern.leaseUntil : claim.leaseUntil;
          })(),
        },
      ])),
    };
  }

  /**
   * Read operator-facing health for the shared queue. Never throws and never
   * mutates the queue, authority lock, directory, or capability evidence.
   */
  readHealth(opts: { machineId?: string; cooldownMs?: number; now?: number } = {}): SharedQueueHealth {
    const now = opts.now ?? Date.now();
    const cooldownMs = opts.cooldownMs ?? 6 * 60 * 60 * 1000;
    const owner = opts.machineId;
    const capability = this.readCapabilityStatus();

    try {
      const { queue, readable } = this.readQueueResult();
      let activeClaims = 0;
      let ownedClaims = 0;
      let expiredClaims = 0;
      let executingClaims = 0;
      let ambiguousClaims = 0;
      let nextLeaseMs: number | null = null;
      let oldestExpiredMs: number | null = null;
      const byMachine = new Map<string, {
        active: number;
        expired: number;
        executing: number;
        ambiguous: number;
      }>();
      const claimSamples: SharedQueueClaimSample[] = [];

      for (const [itemId, claim] of Object.entries(queue.claims)) {
        const modernOwner = parseModernOwner(claim.machineId);
        const machineId = logicalMachineId(claim.machineId);
        const phase = modernOwner && modernOwner !== 'invalid' ? modernOwner.phase : undefined;
        const effectiveLeaseUntil = modernOwner && modernOwner !== 'invalid'
          ? modernOwner.leaseUntil
          : claim.leaseUntil;
        const entry = byMachine.get(machineId) ?? { active: 0, expired: 0, executing: 0, ambiguous: 0 };
        const active = effectiveLeaseUntil > now;
        const executing = phase === 'executing';
        const legacyAmbiguous = modernOwner === null && !active;
        const owned = owner ? machineId === owner : false;
        if (executing) {
          executingClaims++;
          entry.executing++;
          if (!active) {
            ambiguousClaims++;
            entry.ambiguous++;
          }
        }
        if (legacyAmbiguous) {
          ambiguousClaims++;
          entry.ambiguous++;
        }
        if (active) {
          activeClaims++;
          entry.active++;
          if (owned) ownedClaims++;
          if (nextLeaseMs === null || effectiveLeaseUntil < nextLeaseMs) {
            nextLeaseMs = effectiveLeaseUntil;
          }
        } else if (!executing && !legacyAmbiguous) {
          expiredClaims++;
          entry.expired++;
          const age = Math.max(0, now - effectiveLeaseUntil);
          if (oldestExpiredMs === null || age > oldestExpiredMs) {
            oldestExpiredMs = age;
          }
        }
        byMachine.set(machineId, entry);
        claimSamples.push({
          itemId: compactMetadata(itemId),
          machineId: compactMetadata(machineId, 120),
          leaseUntil: safeIso(effectiveLeaseUntil),
          state: executing || legacyAmbiguous
            ? (active ? 'executing' : 'ambiguous')
            : active ? 'active' : 'reclaimable',
          ...(phase === 'executing' ? { phase } : {}),
          owned,
        });
      }

      const cooldownItemIds = new Set<string>();
      const seenWorked = new Set<string>();
      for (let i = queue.worked.length - 1; i >= 0; i--) {
        const event = queue.worked[i]!;
        if (seenWorked.has(event.itemId)) continue;
        seenWorked.add(event.itemId);
        const eventMs = Date.parse(event.ts);
        if (
          isSuppressibleWorkedOutcome(event.outcome) &&
          !Number.isNaN(eventMs) &&
          now - eventMs < cooldownMs
        ) {
          cooldownItemIds.add(event.itemId);
        }
      }

      let lock: SharedQueueHealth['lock'] = {
        present: false, ageMs: null, stale: false, links: null, recoveryRequired: false,
      };
      try {
        const lp = this.lockPath();
        if (existsSync(lp)) {
          const stat = lstatSync(lp, { bigint: true });
          const ageMs = Math.max(0, now - Number(stat.mtimeMs));
          const links = Number(stat.nlink);
          const recoveryRequired = stat.isSymbolicLink() || !stat.isFile() || links !== 1;
          lock = {
            present: true,
            ageMs,
            stale: ageMs > this.staleLockMs(),
            links,
            recoveryRequired,
          };
        }
      } catch {
        lock = {
          present: true, ageMs: null, stale: false, links: null, recoveryRequired: true,
        };
      }

      return {
        path: this.dirPath,
        leaseMs: this.leaseMs,
        readable,
        capability,
        activeClaims,
        ownedClaims,
        expiredClaims,
        reclaimableClaims: expiredClaims,
        executingClaims,
        ambiguousClaims,
        claimsByMachine: Array.from(byMachine.entries())
          .map(([machineId, counts]) => ({
            machineId,
            active: counts.active,
            expired: counts.expired,
            ...(counts.executing > 0 ? { executing: counts.executing } : {}),
            ...(counts.ambiguous > 0 ? { ambiguous: counts.ambiguous } : {}),
          }))
          .sort((a, b) => a.machineId.localeCompare(b.machineId)),
        claimSamples: claimSamples
          .sort((a, b) => {
            const stateRank = (state: SharedQueueClaimSample['state']): number => {
              switch (state) {
                case 'executing': return 0;
                case 'active': return 1;
                case 'ambiguous': return 2;
                case 'reclaimable': return 3;
              }
            };
            const stateOrder = stateRank(a.state) - stateRank(b.state);
            if (stateOrder !== 0) return stateOrder;
            const ownerOrder = (a.owned === b.owned) ? 0 : a.owned ? -1 : 1;
            if (ownerOrder !== 0) return ownerOrder;
            return a.machineId.localeCompare(b.machineId) || a.itemId.localeCompare(b.itemId);
          })
          .slice(0, MAX_CLAIM_SAMPLES),
        nextLeaseExpiryAt: safeIso(nextLeaseMs),
        oldestExpiredMs,
        workedEvents: queue.worked.length,
        cooldownItems: cooldownItemIds.size,
        usageEntries: queue.usage.length,
        lock,
      };
    } catch {
      return {
        path: this.dirPath,
        leaseMs: this.leaseMs,
        readable: false,
        capability,
        activeClaims: 0,
        ownedClaims: 0,
        expiredClaims: 0,
        reclaimableClaims: 0,
        executingClaims: 0,
        ambiguousClaims: 0,
        claimsByMachine: [],
        claimSamples: [],
        nextLeaseExpiryAt: null,
        oldestExpiredMs: null,
        workedEvents: 0,
        cooldownItems: 0,
        usageEntries: 0,
        lock: { present: false, ageMs: null, stale: false, links: null, recoveryRequired: false },
      };
    }
  }
}

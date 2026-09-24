/**
 * Execution leases — V3.10 Track B unit U6 (throughput). SPEC-310B §3 "Mutation fence".
 *
 * THE PROBLEM THIS SOLVES. A CLI agent used to hold the machine-wide outward
 * mutation fence (mutation-fence.ts) for its WHOLE run, inference included.
 * Inference is ~99% of a run's wall time and makes no outward mutation, yet
 * the fence is exclusive and cross-process — so one agent ran machine-wide no
 * matter how many serving slots or seats existed. The fleet's throughput was
 * capped at one.
 *
 * THE MODEL (SPEC-310B §3):
 *   - Agents hold a SHARED execution lease for their whole run. It is not a
 *     lock anyone waits to acquire: any number of agents hold one at once.
 *     Its only job is to let kill / unenroll see who is still running, tell
 *     them to stop, and wait for them.
 *   - A per-repo EXCLUSIVE lease covers only the short sections that mutate a
 *     repo's git state: worktree creation and removal, proposal capture, mirror
 *     sync, and ref/push. Two agents on different repos never wait for each
 *     other there; two agents on the same repo take turns.
 *   - Kill and unenroll take the global exclusive fence the way they always
 *     did, but first DRAIN: arm the restrictive intent (KILL / the registry
 *     write), ABORT every lease in scope, then wait (≤ 30 s) for the leases to
 *     be released. They report `quiesced` only when no lease in scope remains.
 *   - Verification (test suites) runs at most 2 at a time machine-wide and 1
 *     per repo, because it is the one phase that saturates the machine.
 *
 * WHY THE GUARANTEE IS UNCHANGED. A lease is registered only while the caller
 * holds the outward fence AND has just passed the policy gate (KILL off, repo
 * enrolled). Kill arms KILL before it takes the fence, so once kill holds the
 * fence no new lease can appear; every lease it can see was admitted before
 * KILL, and it waits for exactly those. Every outward effect after inference
 * (proposal filing, cleanup) re-takes the fence and re-checks the gate, so a
 * run that ignored its abort still cannot file after KILL.
 *
 * LOCK ORDER (acquire strictly in this order; skipping levels is fine; never
 * wait for an earlier level while holding a later one):
 *   1. repo lease          (per repo, exclusive, cross-process)
 *   2. verification slot   (per-repo slot, then a machine slot)
 *   3. outward mutation fence (global exclusive, short-held)
 *   The proposal mutation lock precedes 3, as before (inbox/merge.ts).
 * Kill / unenroll only ever take level 3, so they can never deadlock against
 * an agent that holds 1 or 2.
 *
 * CROSS-PROCESS. Every lease is a `LocalStoreLock` file under
 * ~/.ashlr/authority/leases/ (0700; the daemon's own dir, unreadable by
 * confined agents under a standing policy). The lock records pid + process
 * start identity, so a lease whose process died is detected as dead and
 * reaped instead of blocking kill forever. An agent in another process learns
 * about KILL / unenroll by polling (every 2 s — the repo's minimum polling
 * interval) through the `shouldAbort` probe its owner supplies; agents in THIS
 * process are aborted synchronously.
 *
 * DEPENDENCIES ARE DELIBERATE. This module imports only the four long-standing
 * mutation-fence functions and local-store-lock — never policy.ts (policy.ts
 * imports THIS module, and the many test doubles of mutation-fence.js provide
 * exactly those four functions).
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  acquireLocalStoreLockWithOutcome,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { ownsOutwardMutationFence, type OutwardMutationFence } from './mutation-fence.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often a lease asks its owner's `shouldAbort` probe (cross-process kill / unenroll). */
export const EXECUTION_LEASE_POLL_MS = 2_000;

/** How long kill / unenroll wait for in-scope leases to drain (SPEC-310B §3). */
export const EXECUTION_LEASE_DRAIN_MS = 30_000;

/**
 * Default wait for a repo lease. Holders keep it for seconds (worktree add,
 * capture, a fetch), so two minutes means something is wrong, not busy.
 */
export const REPO_LEASE_WAIT_MS = 120_000;

/** Machine-wide verification concurrency (SPEC-310B §3). */
export const VERIFICATION_MACHINE_SLOTS = 2;

/**
 * Per-repo verification concurrency (SPEC-310B §3). Implemented as ONE
 * exclusive lock per repo, so this constant documents the rule; it is not a
 * tunable.
 */
export const VERIFICATION_REPO_SLOTS = 1;

/**
 * Default wait for a verification slot. A slot is held for a whole test run
 * (minutes), and with 2 machine slots a queue of several verifications is
 * normal — so the wait is long and asynchronous.
 */
export const VERIFICATION_SLOT_WAIT_MS = 30 * 60_000;

const LEASE_FILE_RE = /^exec-([0-9a-f]{16})-[A-Za-z0-9_-]{1,120}\.lock$/;
const POLL_FLOOR_MS = 10;

// ---------------------------------------------------------------------------
// Paths and keys
// ---------------------------------------------------------------------------

function canonicalHome(): string | null {
  try {
    const home = homedir();
    if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) return null;
    return resolve(home);
  } catch {
    return null;
  }
}

/** ~/.ashlr/authority/leases — next to the outward fence it extends. */
export function authorityLeaseDirectory(): string {
  const home = canonicalHome();
  if (!home) throw new Error('invalid home directory for execution leases');
  return join(home, '.ashlr', 'authority', 'leases');
}

/**
 * Stable short identity for a repo key. Callers pass the CANONICAL repo path
 * (policy.canonicalEnrollmentPath) so a lease taken through a symlinked path
 * and an unenroll through the physical path agree.
 */
export function repoLeaseHash(repoKey: string): string {
  return createHash('sha256').update(`ashlr:repo-lease:v1\0${repoKey}`, 'utf8').digest('hex');
}

function shortHash(repoKey: string): string {
  return repoLeaseHash(repoKey).slice(0, 16);
}

function safeRunToken(runId: string): string {
  const cleaned = runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'run';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal?.aborted) {
      resolveDelay();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveDelay();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pathMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

// ---------------------------------------------------------------------------
// Shared execution leases
// ---------------------------------------------------------------------------

export interface ExecutionLeaseSpec {
  /** The run's id (any string; it is sanitized for the file name). */
  runId: string;
  /** Canonical repo path the run mutates (policy.canonicalEnrollmentPath). */
  repoKey: string;
  /** Engine id, for diagnostics. */
  engine: string;
  /** The caller's own cancellation; aborting it aborts the lease signal too. */
  parentSignal?: AbortSignal;
  /**
   * Cross-process stop probe, polled every `pollMs`: return a reason to abort
   * (KILL armed, repo unenrolled) or null. A throwing probe counts as null —
   * the fence re-check before any outward effect is the real gate; this probe
   * only makes the stop PROMPT.
   */
  shouldAbort?: () => string | null;
  /** Poll interval for `shouldAbort` (default EXECUTION_LEASE_POLL_MS). */
  pollMs?: number;
}

export interface ExecutionLease {
  readonly runId: string;
  readonly repoKey: string;
  readonly engine: string;
  /** Aborted by kill, unenroll, the owner's probe, or the parent signal. */
  readonly signal: AbortSignal;
  /** Why the lease was aborted; null while it has not been. */
  abortReason(): string | null;
  /** True until release() (idempotent). */
  isHeld(): boolean;
  /** Stop polling and drop the lease. Idempotent. Call only after every effect of the run (cleanup included) is done. */
  release(): void;
}

export type ExecutionLeaseRegistration =
  | { ok: true; lease: ExecutionLease }
  | { ok: false; reason: string };

interface LiveLease {
  readonly path: string;
  readonly repoHash: string;
  readonly runId: string;
  readonly engine: string;
  readonly lock: LocalStoreLock;
  readonly controller: AbortController;
  timer: ReturnType<typeof setInterval> | null;
  detachParent: (() => void) | null;
  reason: string | null;
  released: boolean;
}

/** Leases held by THIS process, keyed by lock path. */
const inProcessLeases = new Map<string, LiveLease>();

function abortLiveLease(live: LiveLease, reason: string): boolean {
  if (live.released || live.controller.signal.aborted) return false;
  live.reason = reason;
  live.controller.abort(new Error(`execution lease aborted: ${reason}`));
  return true;
}

/**
 * Register a shared execution lease. MUST be called while holding the outward
 * fence, right after the policy gate passed — that is what makes kill's drain
 * complete (see the module comment). The fence is checked, not trusted.
 */
export function registerExecutionLease(
  fence: OutwardMutationFence | null | undefined,
  spec: ExecutionLeaseSpec,
): ExecutionLeaseRegistration {
  if (!ownsOutwardMutationFence(fence)) {
    return { ok: false, reason: 'execution lease requires the outward mutation fence' };
  }
  if (typeof spec.repoKey !== 'string' || spec.repoKey.length === 0) {
    return { ok: false, reason: 'execution lease requires a repo key' };
  }
  let directory: string;
  try {
    directory = authorityLeaseDirectory();
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const repoHash = shortHash(spec.repoKey);
  // The random suffix makes the name unique even when two runs sanitize to the
  // same token; the lock's own token makes ownership exact.
  const path = join(
    directory,
    `exec-${repoHash}-${safeRunToken(spec.runId)}-${randomBytes(4).toString('hex')}.lock`,
  );
  let acquired: ReturnType<typeof acquireLocalStoreLockWithOutcome>;
  try {
    acquired = acquireLocalStoreLockWithOutcome(path, 250);
  } catch {
    return { ok: false, reason: 'execution lease store unavailable' };
  }
  if (acquired.state !== 'acquired') {
    return { ok: false, reason: `execution lease store ${acquired.state}` };
  }

  const live: LiveLease = {
    path,
    repoHash,
    runId: spec.runId,
    engine: spec.engine,
    lock: acquired.lock,
    controller: new AbortController(),
    timer: null,
    detachParent: null,
    reason: null,
    released: false,
  };
  inProcessLeases.set(path, live);

  const parent = spec.parentSignal;
  if (parent) {
    if (parent.aborted) {
      abortLiveLease(live, 'cancelled');
    } else {
      const onParentAbort = (): void => { abortLiveLease(live, 'cancelled'); };
      parent.addEventListener('abort', onParentAbort, { once: true });
      live.detachParent = () => parent.removeEventListener('abort', onParentAbort);
    }
  }

  const probe = spec.shouldAbort;
  if (probe && !live.controller.signal.aborted) {
    const pollMs = Math.max(POLL_FLOOR_MS, Math.floor(spec.pollMs ?? EXECUTION_LEASE_POLL_MS));
    live.timer = setInterval(() => {
      if (live.released || live.controller.signal.aborted) return;
      let reason: string | null = null;
      try {
        reason = probe();
      } catch {
        reason = null;
      }
      if (typeof reason === 'string' && reason.length > 0) abortLiveLease(live, reason);
    }, pollMs);
    // Never keep a process alive just to poll for a stop that cannot matter
    // once everything else has exited.
    live.timer.unref?.();
  }

  const lease: ExecutionLease = Object.freeze({
    runId: spec.runId,
    repoKey: spec.repoKey,
    engine: spec.engine,
    signal: live.controller.signal,
    abortReason: () => live.reason,
    isHeld: () => !live.released,
    release: () => {
      if (live.released) return;
      live.released = true;
      if (live.timer) clearInterval(live.timer);
      live.timer = null;
      live.detachParent?.();
      live.detachParent = null;
      inProcessLeases.delete(path);
      // A failed release leaves the file owned by a live pid, so kill keeps
      // reporting "not quiesced" — the honest, fail-closed outcome. One retry
      // covers the transient directory-state case local-store-lock retains.
      if (!releaseLocalStoreLock(live.lock)) releaseLocalStoreLock(live.lock);
    },
  });
  return { ok: true, lease };
}

/** Scope for abort / count / drain: every lease, or only one repo's. */
export interface ExecutionLeaseScope {
  /** Canonical repo keys; a lease matches when its repo hash equals any of them. Absent = all repos. */
  repoKeys?: readonly string[];
}

function scopeHashes(scope: ExecutionLeaseScope | null | undefined): Set<string> | null {
  if (!scope?.repoKeys) return null;
  return new Set(scope.repoKeys.filter((key) => typeof key === 'string' && key.length > 0).map(shortHash));
}

/**
 * Abort every lease held by THIS process within `scope`, synchronously.
 * Returns how many were newly aborted. Leases in other processes learn about
 * the stop through their own `shouldAbort` probe.
 */
export function abortExecutionLeases(scope: ExecutionLeaseScope | null, reason: string): number {
  const hashes = scopeHashes(scope);
  let aborted = 0;
  for (const live of inProcessLeases.values()) {
    if (hashes && !hashes.has(live.repoHash)) continue;
    if (abortLiveLease(live, reason)) aborted += 1;
  }
  return aborted;
}

export interface LiveExecutionLeaseInfo {
  runId: string | null;
  repoHash: string;
  engine: string | null;
  /** Held by this process (runId / engine known) or another live process. */
  owner: 'this-process' | 'other-process' | 'unknown';
}

export interface LiveExecutionLeaseCensus {
  leases: LiveExecutionLeaseInfo[];
  /** Leases whose liveness could not be decided, counted as live (fail closed). */
  unknown: number;
  /** Dead-process leases reaped during this census. */
  reaped: number;
}

/**
 * Every live lease in `scope`, across processes. A lease whose owning process
 * is provably dead is REAPED here (local-store-lock's dead-owner reclaim), so a
 * crashed daemon can never hold kill "not quiesced" forever. Anything whose
 * liveness cannot be decided counts as live.
 */
export function censusExecutionLeases(scope: ExecutionLeaseScope | null = null): LiveExecutionLeaseCensus {
  const hashes = scopeHashes(scope);
  const census: LiveExecutionLeaseCensus = { leases: [], unknown: 0, reaped: 0 };
  let directory: string;
  try {
    directory = authorityLeaseDirectory();
  } catch {
    census.unknown += 1;
    return census;
  }
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    // No directory = no lease was ever taken on this machine.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') census.unknown += 1;
    return census;
  }
  for (const name of names) {
    const match = LEASE_FILE_RE.exec(name);
    if (!match) continue;
    const repoHash = match[1]!;
    if (hashes && !hashes.has(repoHash)) continue;
    const path = join(directory, name);
    const own = inProcessLeases.get(path);
    if (own) {
      if (!own.released) {
        census.leases.push({ runId: own.runId, repoHash, engine: own.engine, owner: 'this-process' });
      }
      continue;
    }
    // Foreign lease: probe by trying to take it. local-store-lock grants it
    // only when the recorded owner is provably dead; then it is stale — drop
    // it. A live owner (or a lock still initializing) reads as contended.
    let probe: ReturnType<typeof acquireLocalStoreLockWithOutcome>;
    try {
      probe = acquireLocalStoreLockWithOutcome(path, 0);
    } catch {
      census.unknown += 1;
      census.leases.push({ runId: null, repoHash, engine: null, owner: 'unknown' });
      continue;
    }
    if (probe.state === 'acquired') {
      releaseLocalStoreLock(probe.lock);
      census.reaped += 1;
      continue;
    }
    // The owner may have released it between readdir and the probe, or the
    // dead-owner reclaim may have removed it without installing ours.
    if (pathMissing(path)) continue;
    if (probe.state === 'unavailable') {
      census.unknown += 1;
      census.leases.push({ runId: null, repoHash, engine: null, owner: 'unknown' });
    } else {
      census.leases.push({ runId: null, repoHash, engine: null, owner: 'other-process' });
    }
  }
  return census;
}

/** Number of live leases in scope (unknown ones included — fail closed). */
export function countLiveExecutionLeases(scope: ExecutionLeaseScope | null = null): number {
  return censusExecutionLeases(scope).leases.length;
}

export interface ExecutionLeaseDrainResult {
  drained: boolean;
  /** Live leases at the end of the wait. */
  live: number;
  waitedMs: number;
}

/**
 * Wait (asynchronously) until no lease in `scope` remains, or `timeoutMs`
 * passes. Re-aborts in-process leases on every poll so a lease registered by
 * a race the caller lost is still told to stop.
 */
export async function waitForExecutionLeasesToDrain(
  scope: ExecutionLeaseScope | null,
  opts: { timeoutMs?: number; pollMs?: number; reason?: string; signal?: AbortSignal } = {},
): Promise<ExecutionLeaseDrainResult> {
  const started = Date.now();
  const timeoutMs = Math.max(0, opts.timeoutMs ?? EXECUTION_LEASE_DRAIN_MS);
  // 250 ms: a census of a FOREIGN lease probes its owner's liveness (a `ps`
  // spawn inside local-store-lock), so a tighter poll during a 30 s drain
  // would be hundreds of spawns for no faster answer — foreign agents only
  // notice the stop at their own 2 s probe anyway.
  const pollMs = Math.max(POLL_FLOOR_MS, opts.pollMs ?? 250);
  for (;;) {
    if (opts.reason) abortExecutionLeases(scope, opts.reason);
    const live = countLiveExecutionLeases(scope);
    const waitedMs = Date.now() - started;
    if (live === 0) return { drained: true, live, waitedMs };
    if (waitedMs >= timeoutMs || opts.signal?.aborted) return { drained: false, live, waitedMs };
    await delay(Math.min(pollMs, Math.max(1, timeoutMs - waitedMs)), opts.signal);
  }
}

// ---------------------------------------------------------------------------
// Exclusive keyed locks (repo leases, verification slots)
// ---------------------------------------------------------------------------

/**
 * In-process FIFO per lock key. The file lock alone is correct but not fair:
 * N async waiters polling one file can starve each other indefinitely. A
 * per-key promise chain makes this process's waiters take turns in request
 * order and contend for the file one at a time (the same technique as
 * worktree.ts's sandbox-creation chain).
 */
const turnTails = new Map<string, Promise<void>>();

function joinQueue(key: string): { previous: Promise<void>; done: () => void } {
  const previous = turnTails.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolveTurn) => { done = resolveTurn; });
  const tail = previous.then(() => mine);
  turnTails.set(key, tail);
  void tail.then(() => {
    if (turnTails.get(key) === tail) turnTails.delete(key);
  });
  let finished = false;
  return {
    previous,
    done: () => {
      if (finished) return;
      finished = true;
      done();
    },
  };
}

/** Resolve true when `promise` settles before the deadline / abort, else false. */
async function waitTurn(promise: Promise<void>, deadline: number, signal?: AbortSignal): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; });
  while (!settled) {
    if (signal?.aborted) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await Promise.race([promise, delay(Math.min(remaining, 50), signal)]);
  }
  return true;
}

type KeyedAcquire =
  | { ok: true; lock: LocalStoreLock; done: () => void }
  | { ok: false; reason: 'timeout' | 'aborted' | 'unavailable' };

async function acquireKeyedLock(
  queueKey: string,
  paths: readonly string[],
  opts: { waitMs: number; pollMs: number; signal?: AbortSignal },
): Promise<KeyedAcquire> {
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  const turn = joinQueue(queueKey);
  const fail = (reason: 'timeout' | 'aborted' | 'unavailable'): KeyedAcquire => {
    turn.done();
    return { ok: false, reason };
  };
  if (!await waitTurn(turn.previous, deadline, opts.signal)) {
    return fail(opts.signal?.aborted ? 'aborted' : 'timeout');
  }
  for (;;) {
    if (opts.signal?.aborted) return fail('aborted');
    let unavailable = 0;
    for (const path of paths) {
      let attempt: ReturnType<typeof acquireLocalStoreLockWithOutcome>;
      try {
        // 1 ms per attempt keeps each synchronous spin to a single sleep tick;
        // the waiting happens asynchronously below.
        attempt = acquireLocalStoreLockWithOutcome(path, 1);
      } catch {
        unavailable += 1;
        continue;
      }
      if (attempt.state === 'acquired') return { ok: true, lock: attempt.lock, done: turn.done };
      if (attempt.state === 'unavailable') unavailable += 1;
    }
    // Every candidate is unusable (unsafe directory, bad HOME): waiting will
    // not change that, so say so now instead of burning the whole wait.
    if (unavailable === paths.length) return fail('unavailable');
    if (Date.now() >= deadline) return fail('timeout');
    await delay(Math.min(opts.pollMs, Math.max(1, deadline - Date.now())), opts.signal);
  }
}

// --- Repo leases -----------------------------------------------------------

export interface RepoLease {
  readonly repoKey: string;
  /** False after release(). */
  isHeld(): boolean;
  release(): void;
}

export type RepoLeaseAcquire =
  | { ok: true; lease: RepoLease }
  | { ok: false; reason: string };

export function repoLeasePath(repoKey: string): string {
  return join(authorityLeaseDirectory(), `repo-${repoLeaseHash(repoKey).slice(0, 32)}.lock`);
}

/**
 * Take a repo's exclusive lease: worktree creation / removal, proposal
 * capture, mirror sync, and ref/push on that repo happen one at a time, across
 * processes. NOT re-entrant — never call this while already holding the same
 * repo's lease. Never call it while holding the outward fence or a
 * verification slot (lock order).
 */
export async function acquireRepoLease(
  repoKey: string,
  opts: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<RepoLeaseAcquire> {
  if (typeof repoKey !== 'string' || repoKey.length === 0) {
    return { ok: false, reason: 'repo lease requires a repo key' };
  }
  let path: string;
  try {
    path = repoLeasePath(repoKey);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const waitMs = opts.waitMs ?? REPO_LEASE_WAIT_MS;
  const acquired = await acquireKeyedLock(`repo:${path}`, [path], {
    waitMs,
    pollMs: Math.max(POLL_FLOOR_MS, opts.pollMs ?? 50),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!acquired.ok) {
    return {
      ok: false,
      reason: acquired.reason === 'timeout'
        ? `repo lease busy after ${waitMs}ms`
        : acquired.reason === 'aborted'
          ? 'repo lease wait cancelled'
          : 'repo lease store unavailable',
    };
  }
  let held = true;
  const lease: RepoLease = Object.freeze({
    repoKey,
    isHeld: () => held && ownsLocalStoreLock(acquired.lock),
    release: () => {
      if (!held) return;
      held = false;
      if (!releaseLocalStoreLock(acquired.lock)) releaseLocalStoreLock(acquired.lock);
      acquired.done();
    },
  });
  return { ok: true, lease };
}

/** Run `fn` under a repo's exclusive lease; the lease is always released. */
export async function withRepoLease<T>(
  repoKey: string,
  fn: (lease: RepoLease) => Promise<T> | T,
  opts: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const acquired = await acquireRepoLease(repoKey, opts);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, value: await fn(acquired.lease) };
  } finally {
    acquired.lease.release();
  }
}

// --- Verification slots ----------------------------------------------------

export class VerificationCapacityError extends Error {
  constructor(
    readonly kind: 'timeout' | 'aborted' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'VerificationCapacityError';
  }
}

export interface VerificationSlotOptions {
  waitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Machine-wide slot count override (tests; clamped 1..8). Production uses VERIFICATION_MACHINE_SLOTS. */
  machineSlots?: number;
}

/**
 * Run `fn` holding one per-repo verification slot and one machine slot (at
 * most VERIFICATION_REPO_SLOTS per repo and VERIFICATION_MACHINE_SLOTS on the
 * machine run at once). Throws VerificationCapacityError when no slot came
 * free in time, the wait was cancelled, or the slot store is unusable — the
 * caller decides what a verification it could not run means (fail closed).
 *
 * Takes the per-repo slot first, then a machine slot: a second verification
 * of the same repo queues without occupying a machine slot another repo could
 * use. Must not be called while holding the outward fence (lock order).
 */
export async function withVerificationSlot<T>(
  repoKey: string,
  fn: () => Promise<T> | T,
  opts: VerificationSlotOptions = {},
): Promise<T> {
  let directory: string;
  try {
    directory = authorityLeaseDirectory();
  } catch (error) {
    throw new VerificationCapacityError('unavailable', (error as Error).message);
  }
  const waitMs = opts.waitMs ?? VERIFICATION_SLOT_WAIT_MS;
  const pollMs = Math.max(POLL_FLOOR_MS, opts.pollMs ?? 250);
  const deadline = Date.now() + Math.max(0, waitMs);
  const slots = Math.min(8, Math.max(1, Math.floor(opts.machineSlots ?? VERIFICATION_MACHINE_SLOTS)));
  const signalOpt = opts.signal ? { signal: opts.signal } : {};

  const repoPath = join(directory, `verify-repo-${repoLeaseHash(repoKey).slice(0, 32)}.lock`);
  const repoSlot = await acquireKeyedLock(`verify-repo:${repoPath}`, [repoPath], {
    waitMs, pollMs, ...signalOpt,
  });
  if (!repoSlot.ok) {
    throw new VerificationCapacityError(
      repoSlot.reason,
      repoSlot.reason === 'timeout'
        ? `another verification of this repo is still running after ${waitMs}ms`
        : repoSlot.reason === 'aborted'
          ? 'verification wait cancelled'
          : 'verification slot store unavailable',
    );
  }
  try {
    const machinePaths = Array.from({ length: slots }, (_, i) => join(directory, `verify-slot-${i}.lock`));
    const machineSlot = await acquireKeyedLock('verify-machine', machinePaths, {
      waitMs: Math.max(0, deadline - Date.now()), pollMs, ...signalOpt,
    });
    if (!machineSlot.ok) {
      throw new VerificationCapacityError(
        machineSlot.reason,
        machineSlot.reason === 'timeout'
          ? `all ${slots} machine verification slots stayed busy for ${waitMs}ms`
          : machineSlot.reason === 'aborted'
            ? 'verification wait cancelled'
            : 'verification slot store unavailable',
      );
    }
    // The in-process queue turn is only for WAITING fairly; holding it while
    // the verification runs would serialize this process to one machine slot.
    machineSlot.done();
    try {
      return await fn();
    } finally {
      if (!releaseLocalStoreLock(machineSlot.lock)) releaseLocalStoreLock(machineSlot.lock);
    }
  } finally {
    if (!releaseLocalStoreLock(repoSlot.lock)) releaseLocalStoreLock(repoSlot.lock);
    repoSlot.done();
  }
}

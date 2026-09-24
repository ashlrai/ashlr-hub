/**
 * Repo holds (quarantine, owner-hold, leader-pause, cooldown) — V3.10 Track B (owner: unit U4).
 *
 * A repo is paused while ANY hold is active. At most one hold per
 * (repo, kind). Quarantine (6 h after a red post-merge) auto-expires;
 * owner-hold is cleared only by `mason`; the Leader may set and clear only
 * `leader-pause`.
 *
 * ── STORE ──────────────────────────────────────────────────────────────────
 * `~/.ashlr/authority/holds.json` (0600, dir 0700) holds the materialised set;
 * every change is ALSO a `hold:set` / `hold:cleared` row in the authority
 * ledger. WHY both: `listRepoHolds` is on gate G0's synchronous path and the
 * tick's `beforeTick`, and a full ledger read + chain verify is async and
 * grows without bound — the ledger is the audit, the file is the index. The
 * directory is on confinement's denied-read list (U2), so an agent can neither
 * read nor delete a hold.
 *
 * ── FAIL DIRECTIONS ────────────────────────────────────────────────────────
 * - Setting a hold LOWERS authority, so it never waits on the ledger: the hold
 *   is written first and a failed ledger append is audited, not fatal (I1:
 *   lowering authority is instant and needs no auth).
 * - Clearing a hold RAISES authority, so the ledger row must land first; a
 *   failed append refuses the clear (the hold stands).
 * - An unreadable / corrupt store is never read as "no holds": listRepoHolds
 *   THROWS, and every caller (G0, beforeTick, the Fleet API) fails closed.
 *   A missing file is the one honest empty answer — no hold was ever set.
 *   setRepoHold refuses on a corrupt store too: rewriting it from scratch would
 *   silently drop the holds we could not read.
 *
 * ── WHO MAY DO WHAT ────────────────────────────────────────────────────────
 * HOLD_PERMISSIONS below. An actor that may not clear a kind may still
 * re-set it, but only to EXTEND it — otherwise re-setting with an earlier
 * `until` would be a clear in disguise. `actor` is in-process attribution,
 * not a security boundary (agents never run this code; they only produce
 * diffs), which is why every caller passes its own fixed actor.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appendLedger } from '../authority/ledger.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { audit } from '../sandbox/audit.js';
import { scrubSecrets } from '../util/scrub.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import {
  FLEET_ACTORS,
  REPO_HOLD_KINDS,
  type FleetActor,
  type RepoHold,
  type RepoHoldChange,
  type RepoHoldKind,
  type SetRepoHoldRequest,
} from './fleet-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
/** Far above any real fleet (9 repos × 4 kinds); a bound, not a budget. */
const MAX_HOLDS = 2_000;
const MAX_REASON_CHARS = 500;
const MAX_LANDING_ID_CHARS = 240;
const LOCK_WAIT_MS = 2_000;

/** GitHub `owner/name`. Exported so the watch and tests validate identically. */
export const NAME_WITH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LANDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/#-]*$/;

/**
 * Which actor may set / clear which kind. Mason may do anything; nobody but
 * Mason clears an owner-hold (SPEC-310B §2 "one-click resume"); the Leader
 * touches only its own leader-pause (§4 class A); backpressure only its
 * cooldown; the post-merge watch only what it escalates to.
 */
export const HOLD_PERMISSIONS: Readonly<Record<RepoHoldKind, { set: readonly FleetActor[]; clear: readonly FleetActor[] }>> =
  Object.freeze({
    quarantine: Object.freeze({
      set: Object.freeze(['mason', 'daemon', 'post-merge-watch'] as FleetActor[]),
      clear: Object.freeze(['mason', 'daemon', 'post-merge-watch'] as FleetActor[]),
    }),
    'owner-hold': Object.freeze({
      set: Object.freeze(['mason', 'daemon', 'post-merge-watch'] as FleetActor[]),
      clear: Object.freeze(['mason'] as FleetActor[]),
    }),
    'leader-pause': Object.freeze({
      set: Object.freeze(['mason', 'leader'] as FleetActor[]),
      clear: Object.freeze(['mason', 'leader'] as FleetActor[]),
    }),
    cooldown: Object.freeze({
      set: Object.freeze(['mason', 'daemon', 'backpressure'] as FleetActor[]),
      clear: Object.freeze(['mason', 'daemon', 'backpressure'] as FleetActor[]),
    }),
  });

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `~/.ashlr/authority` — shared with the ledger (B-U1); agent-unreadable under confinement. */
export function authorityStateDir(): string {
  return join(homedir(), '.ashlr', 'authority');
}

export function repoHoldsPath(): string {
  return join(authorityStateDir(), 'holds.json');
}

function holdsLockPath(): string {
  return join(authorityStateDir(), '.holds.lock');
}

/**
 * Create `~/.ashlr/authority` (0700) if needed and refuse a symlinked or
 * foreign-owned directory. Exported for the post-merge watch's own store.
 */
export function ensureAuthorityStateDir(): { ok: true } | { ok: false; reason: string } {
  try {
    const dir = authorityStateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { ok: false, reason: `${dir} is not a plain directory` };
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return { ok: false, reason: `${dir} is not owned by this user` };
    }
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `cannot prepare the authority state directory: ${errText(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Store codec
// ---------------------------------------------------------------------------

interface HoldStoreV1 {
  v: 1;
  holds: RepoHold[];
}

type StoreRead = { ok: true; holds: RepoHold[]; existed: boolean } | { ok: false; reason: string };

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isHold(value: unknown): value is RepoHold {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const h = value as Record<string, unknown>;
  return h['v'] === 1 &&
    typeof h['repo'] === 'string' && NAME_WITH_OWNER_RE.test(h['repo']) &&
    typeof h['kind'] === 'string' && (REPO_HOLD_KINDS as readonly string[]).includes(h['kind']) &&
    typeof h['reason'] === 'string' && h['reason'].length <= MAX_REASON_CHARS * 2 &&
    isIso(h['since']) &&
    (h['until'] === null || isIso(h['until'])) &&
    typeof h['setBy'] === 'string' && (FLEET_ACTORS as readonly string[]).includes(h['setBy']) &&
    (h['landingId'] === null ||
      (typeof h['landingId'] === 'string' && h['landingId'].length <= MAX_LANDING_ID_CHARS));
}

function parseStore(text: string): StoreRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the repo hold store is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the repo hold store is not an object' };
  }
  const store = parsed as Record<string, unknown>;
  if (store['v'] !== STORE_VERSION) {
    return { ok: false, reason: `the repo hold store has unknown version ${String(store['v'])}` };
  }
  const holds = store['holds'];
  if (!Array.isArray(holds) || holds.length > MAX_HOLDS || !holds.every(isHold)) {
    return { ok: false, reason: 'the repo hold store holds a malformed hold' };
  }
  const seen = new Set<string>();
  for (const hold of holds) {
    const key = `${hold.repo.toLowerCase()}\0${hold.kind}`;
    if (seen.has(key)) {
      return { ok: false, reason: `the repo hold store has two ${hold.kind} holds for ${hold.repo}` };
    }
    seen.add(key);
  }
  return { ok: true, holds: holds.map((h) => ({ ...h })), existed: true };
}

function readStoreUnlocked(): StoreRead {
  const path = repoHoldsPath();
  if (!existsSync(path)) return { ok: true, holds: [], existed: false };
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_STORE_BYTES,
    remainingBytes: MAX_STORE_BYTES,
  });
  if (!read.ok) return { ok: false, reason: `the repo hold store is unreadable (${read.reason})` };
  return parseStore(read.text);
}

function writeStoreUnlocked(holds: RepoHold[]): void {
  const store: HoldStoreV1 = { v: 1, holds };
  const encoded = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) {
    throw new Error('the repo hold store would exceed its size bound');
  }
  const target = repoHoldsPath();
  writePrivateFileAtomically(`${target}.${process.pid}.${randomUUID()}.tmp`, target, encoded, {
    anchorPath: homedir(),
    label: 'repo hold store',
  });
}

function withHoldLock<T>(fn: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  const dir = ensureAuthorityStateDir();
  if (!dir.ok) return dir;
  const lock = acquireLocalStoreLock(holdsLockPath(), LOCK_WAIT_MS, { anchorPath: homedir() });
  if (!lock) return { ok: false, reason: 'the repo hold store lock is unavailable' };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Active at `nowMs`: no expiry, or an expiry still in the future. */
export function isHoldActive(hold: RepoHold, nowMs: number): boolean {
  return hold.until === null || Date.parse(hold.until) > nowMs;
}

function sameRepo(a: string, b: string): boolean {
  // GitHub names are case-insensitive; a hold on `AshlrAI/Binshield` must pause `ashlrai/binshield`.
  return a.toLowerCase() === b.toLowerCase();
}

/** The later of two expiries; null (= until cleared) is the latest of all. */
function laterUntil(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function cleanReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const text = scrubSecrets(reason).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

function refuse(reason: string, before: RepoHold | null): RepoHoldChange {
  return { ok: false, reason, before, after: before };
}

function ledgerGrantId(): string | null {
  try {
    return currentStandingPolicy()?.grantId ?? null;
  } catch {
    return null;
  }
}

type LedgerWrite = { ok: true } | { ok: false; reason: string };

function ledgerHoldSet(hold: RepoHold, actor: FleetActor): LedgerWrite {
  try {
    const r = appendLedger({ kind: 'hold:set', data: hold, actor, grantId: ledgerGrantId(), repo: hold.repo });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (error) {
    return { ok: false, reason: errText(error) };
  }
}

function ledgerHoldCleared(repo: string, kind: RepoHoldKind, reason: string, actor: FleetActor): LedgerWrite {
  try {
    const r = appendLedger({ kind: 'hold:cleared', data: { repo, kind, reason }, actor, grantId: ledgerGrantId(), repo });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (error) {
    return { ok: false, reason: errText(error) };
  }
}

// ---------------------------------------------------------------------------
// Public API (frozen contract: setRepoHold, listRepoHolds)
// ---------------------------------------------------------------------------

/** Set (hold non-null) or clear (hold null) one (repo, kind) hold, ledgered as hold:set / hold:cleared. */
export function setRepoHold(req: SetRepoHoldRequest, opts: { nowMs?: number } = {}): RepoHoldChange {
  const nowMs = opts.nowMs ?? Date.now();
  // ── validate (no I/O yet) ─────────────────────────────────────────────
  if (!req || typeof req !== 'object') return refuse('The hold request is not an object.', null);
  if (typeof req.repo !== 'string' || !NAME_WITH_OWNER_RE.test(req.repo)) {
    return refuse(`"${String(req.repo).slice(0, 120)}" is not a GitHub owner/name.`, null);
  }
  if (!(REPO_HOLD_KINDS as readonly string[]).includes(req.kind)) {
    return refuse(`"${String(req.kind).slice(0, 40)}" is not a repo hold kind.`, null);
  }
  if (!(FLEET_ACTORS as readonly string[]).includes(req.actor)) {
    return refuse(`"${String(req.actor).slice(0, 40)}" is not a fleet actor.`, null);
  }
  const perms = HOLD_PERMISSIONS[req.kind];
  const clearing = req.hold === null;
  let spec: { reason: string; until: string | null; landingId: string | null } | null = null;
  if (!clearing) {
    const hold = req.hold;
    if (!hold || typeof hold !== 'object') return refuse('The hold spec is not an object.', null);
    const reason = cleanReason(hold.reason);
    if (reason === null) return refuse('A hold needs a reason Mason can read.', null);
    if (hold.until !== null && !isIso(hold.until)) return refuse('The hold expiry is not an ISO time.', null);
    if (hold.until !== null && Date.parse(hold.until) <= nowMs) {
      return refuse(`The hold expiry ${hold.until} is already in the past.`, null);
    }
    const landingId = hold.landingId ?? null;
    if (landingId !== null &&
      (typeof landingId !== 'string' || landingId.length > MAX_LANDING_ID_CHARS || !LANDING_ID_RE.test(landingId))) {
      return refuse('The hold landing id is malformed.', null);
    }
    if (!perms.set.includes(req.actor)) {
      return refuse(`${req.actor} may not set a ${req.kind} hold.`, null);
    }
    spec = { reason, until: hold.until, landingId };
  }

  // ── apply under the store lock ────────────────────────────────────────
  const outcome = withHoldLock((): RepoHoldChange => {
    const read = readStoreUnlocked();
    if (!read.ok) return refuse(`${read.reason}; no hold was changed.`, null);
    // Expired holds are dropped on every write: an expired hold is no hold.
    const live = read.holds.filter((h) => isHoldActive(h, nowMs));
    const index = live.findIndex((h) => sameRepo(h.repo, req.repo) && h.kind === req.kind);
    const before = index >= 0 ? { ...live[index]! } : null;

    if (clearing) {
      if (before === null) return { ok: true, reason: null, before: null, after: null };
      if (!perms.clear.includes(req.actor)) {
        return refuse(
          req.kind === 'owner-hold'
            ? `Only Mason can clear the owner-hold on ${before.repo}.`
            : `${req.actor} may not clear a ${req.kind} hold.`,
          before,
        );
      }
      // Raising authority: the ledger row must land first.
      const ledger = ledgerHoldCleared(before.repo, req.kind, `cleared by ${req.actor}`, req.actor);
      if (!ledger.ok) {
        return refuse(`The authority ledger refused the clear (${ledger.reason}); the ${req.kind} hold on ${before.repo} stands.`, before);
      }
      live.splice(index, 1);
      try {
        writeStoreUnlocked(live);
      } catch (error) {
        return refuse(`The hold store could not be written (${errText(error)}); the ${req.kind} hold on ${before.repo} stands.`, before);
      }
      return { ok: true, reason: null, before, after: null };
    }

    const s = spec!;
    let after: RepoHold;
    if (before !== null && !perms.clear.includes(req.actor)) {
      // May re-set but not shorten: keep the stricter expiry and the original start.
      after = {
        ...before,
        reason: s.reason,
        until: laterUntil(before.until, s.until),
        setBy: req.actor,
        landingId: s.landingId ?? before.landingId,
      };
    } else {
      after = {
        v: 1,
        repo: before?.repo ?? req.repo,
        kind: req.kind,
        reason: s.reason,
        since: new Date(nowMs).toISOString(),
        until: s.until,
        setBy: req.actor,
        landingId: s.landingId,
      };
    }
    if (index >= 0) live[index] = after;
    else {
      if (live.length >= MAX_HOLDS) return refuse('The hold store is full.', before);
      live.push(after);
    }
    try {
      writeStoreUnlocked(live);
    } catch (error) {
      return refuse(`The hold store could not be written (${errText(error)}).`, before);
    }
    // Lowering authority: the hold stands even if the ledger append fails.
    const ledger = ledgerHoldSet(after, req.actor);
    if (!ledger.ok) {
      audit({
        action: 'fleet:hold-ledger-failed',
        repo: null,
        sandboxId: null,
        summary: `${after.kind} hold on ${after.repo} is in force but its ledger row failed: ${cleanReason(ledger.reason) ?? 'unknown'}`,
        result: 'error',
      });
    }
    return { ok: true, reason: null, before, after };
  });

  if (!outcome.ok) return refuse(`${outcome.reason}; no hold was changed.`, null);
  return outcome.value;
}

/**
 * Active holds (expired ones dropped), for G0, the tick's paused repos and the Fleet repo table.
 *
 * THROWS when the store exists but cannot be read or parsed — callers fail
 * closed. Lock-free: writes are atomic renames, so a reader sees one whole
 * version or the other.
 */
export function listRepoHolds(opts: { nowMs?: number } = {}): RepoHold[] {
  const nowMs = opts.nowMs ?? Date.now();
  const read = readStoreUnlocked();
  if (!read.ok) throw new Error(`repo holds unknown: ${read.reason}`);
  return read.holds.filter((h) => isHoldActive(h, nowMs));
}

/** Active holds on one repo (case-insensitive). Throws exactly when listRepoHolds does. */
export function repoHoldsFor(repo: string, opts: { nowMs?: number } = {}): RepoHold[] {
  return listRepoHolds(opts).filter((h) => sameRepo(h.repo, repo));
}

/**
 * Drop expired holds from the store and ledger each as `hold:cleared`
 * ("expired"). Housekeeping only — listRepoHolds already ignores expired
 * holds, so a failed sweep never keeps a repo paused or releases one early.
 */
export function sweepExpiredRepoHolds(opts: { nowMs?: number } = {}): { swept: RepoHold[]; error: string | null } {
  const nowMs = opts.nowMs ?? Date.now();
  const outcome = withHoldLock(() => {
    const read = readStoreUnlocked();
    if (!read.ok) return { swept: [] as RepoHold[], error: read.reason };
    const expired = read.holds.filter((h) => !isHoldActive(h, nowMs));
    if (expired.length === 0) return { swept: [], error: null };
    // Ledger first: an expiry the ledger never saw would make the ledger's
    // replay disagree with the store. A failed row leaves the hold in the file
    // (harmless — it is inactive) and the next sweep retries.
    const swept: RepoHold[] = [];
    let error: string | null = null;
    for (const hold of expired) {
      const ledger = ledgerHoldCleared(hold.repo, hold.kind, `expired at ${hold.until}`, 'daemon');
      if (ledger.ok) swept.push(hold);
      else error ??= ledger.reason;
    }
    if (swept.length > 0) {
      const sweptSet = new Set(swept);
      try {
        writeStoreUnlocked(read.holds.filter((h) => !sweptSet.has(h)));
      } catch (e) {
        return { swept: [], error: errText(e) };
      }
    }
    return { swept, error };
  });
  return outcome.ok ? outcome.value : { swept: [], error: outcome.reason };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fleet merge state — V3.10 Track B (owner: unit U3).
 *
 * One small private record per fleet change (a proposal) or fleet revert,
 * under `~/.ashlr/authority/fleet-merge/` (dir 0700, files 0600). It holds
 * what the gates and the host merge must remember BETWEEN ticks: which gate
 * rows were already ledgered (so a proposal that waits 1,440 ticks for a judge
 * writes one `wait` row, not 1,440), the verified base / tree the PR head was
 * built from, the fleet PR, and the in-flight host-merge authority (so a Stop
 * in another process can find and revoke it).
 *
 * WHY here and not in the proposal record: `Proposal` is a frozen shared type
 * and its store has its own signed-envelope rules; and WHY under
 * `~/.ashlr/authority`: confinement denies that directory to every agent
 * (U2), so no agent can forge "this PR's head was verified" or "owner lane:
 * false". GitHub stays the source of truth for PR state — every decision that
 * matters re-reads it — this file only remembers what WE did.
 *
 * Fail directions: an unreadable record is reported as `corrupt` and the
 * caller skips that proposal (never "no state", which could re-open a PR or
 * re-run a merge). Writes are atomic and fsynced.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HostMergeRevocationIdentityV1 } from '../autonomy/host-merge-revocation-protocol.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLock, releaseLocalStoreLock, type LocalStoreLock } from './local-store-lock.js';
import type {
  FleetActor,
  GateId,
  GateVerdict,
  JudgeId,
  LandingProducer,
  LandingRecord,
  MergeRisk,
  RepoEnforcement,
} from './fleet-types.js';

const STATE_VERSION = 1 as const;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_STATES = 4_096;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAME_WITH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** One ledgered gate row, remembered so an unchanged verdict is not re-appended every tick. */
export interface GateMemo {
  digest: string;
  verdict: GateVerdict;
  code: string;
  headSha: string | null;
  at: string;
}

/** What the last required-checks read said (G7). */
export interface ChecksMemo {
  state: 'green' | 'pending' | 'red' | 'none';
  detail: string;
  at: string;
}

export interface FleetPrMemo {
  number: number;
  /** GitHub node id (the host-merge protocol binds to it). */
  nodeId: string;
  repositoryId: string;
  branch: string;
  baseBranch: string;
  /** Parent of the head commit — the base the tree was verified on. */
  baseSha: string;
  headSha: string;
  treeSha: string;
  ownerLane: boolean;
  /** Why it is in the owner lane (protected path, no checks, head changed …); null when not. */
  ownerLaneReason: string | null;
  openedAt: string;
  /** `pr:opened` row written (a PR whose opening is not ledgered never merges). */
  ledgered: boolean;
  state: 'open' | 'closed' | 'merged';
  /** Who closed it; `github` = closed on GitHub by someone other than the fleet. */
  closedBy: FleetActor | 'github' | null;
  /** Earliest time to poll GitHub again (checks back off while CI runs). */
  nextCheckAt: string | null;
  checkBackoffMs: number;
  checks: ChecksMemo | null;
  /** Head SHA a `gate:would-merge` row was written for (once per head). */
  wouldMergeHeadSha: string | null;
}

/** The host-merge authority for one merge attempt (host-merge-revocation-protocol). */
export interface MergeAttemptMemo {
  identity: HostMergeRevocationIdentityV1;
  operationPrefix: string;
  startedAt: string;
  phase: 'prepared' | 'armed' | 'consumed' | 'merged' | 'failed' | 'revoked';
  mergeSha: string | null;
  error: string | null;
  /**
   * The trailer values the merge call carries — kept so a crash between the
   * PUT and recording its answer can still build the exact LandingRecord from
   * what GitHub merged.
   */
  trailers: { grantId: string; gatesDigest: string; ledgerHead: string; stageId: string } | null;
}

export interface FleetMergeStateV1 {
  v: typeof STATE_VERSION;
  key: string;
  kind: 'change' | 'revert';
  /** null for a revert. */
  proposalId: string | null;
  /** For a revert: the landing it reverts; null for a change. */
  revertsLandingId: string | null;
  repo: string;
  /** The fleet mirror the work was verified in. */
  repoPath: string;
  enforcement: RepoEnforcement | null;
  createdAt: string;
  updatedAt: string;
  gates: Partial<Record<GateId, GateMemo>>;
  /** When G6 first had to wait for a judge seat (the 24 h widening clock); null = never waited. */
  judgeWaitSince: string | null;
  /** Last time this pass CALLED a judge for it (paid seats are never re-asked every tick). */
  judgeCalledAt?: string | null;
  /** Verification binding. */
  baseBranch: string | null;
  baseSha: string | null;
  treeSha: string | null;
  diffHash: string | null;
  verifyDigest: string | null;
  risk: MergeRisk | null;
  files: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  producer: LandingProducer | null;
  judgeId: JudgeId | null;
  /** Combined digest of the G0–G6 rows the PR was opened under. */
  openGatesDigest: string | null;
  pr: FleetPrMemo | null;
  merge: MergeAttemptMemo | null;
  landing: LandingRecord | null;
  /** `merge:landed` row written (reverts: U4 writes `revert:landed`, so this stays true once landed). */
  landingLedgered: boolean;
  /** Terminal disposition; null while in flight. */
  outcome: 'merged' | 'closed' | 'rejected' | null;
  outcomeReason: string | null;
}

export type FleetMergeStateRead =
  | { state: 'missing' }
  | { state: 'ok'; record: FleetMergeStateV1 }
  | { state: 'corrupt'; reason: string };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `~/.ashlr/authority/fleet-merge` — agent-unreadable under confinement (U2). */
export function fleetMergeStateDir(): string {
  return join(homedir(), '.ashlr', 'authority', 'fleet-merge');
}

/** The store key for a proposal (its id, when it is filename-safe). */
export function proposalStateKey(proposalId: string): string | null {
  return KEY_RE.test(proposalId) ? proposalId : null;
}

/** The store key for a revert, derived from U4's idempotency key (`revert:<landing.id>`). */
export function revertStateKey(idempotencyKey: string): string {
  return `revert-${createHash('sha256').update(`ashlr:fleet-revert-key:v1\0${idempotencyKey}`, 'utf8').digest('hex').slice(0, 40)}`;
}

function statePath(key: string): string {
  return join(fleetMergeStateDir(), `${key}.json`);
}

function lockPath(key: string): string {
  return join(fleetMergeStateDir(), `${key}.lock`);
}

function ensureStateDir(): { ok: true } | { ok: false; reason: string } {
  try {
    const dir = fleetMergeStateDir();
    const parent = join(homedir(), '.ashlr', 'authority');
    for (const path of [join(homedir(), '.ashlr'), parent, dir]) {
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: `${path} is not a plain directory` };
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        return { ok: false, reason: `${path} is not owned by this user` };
      }
    }
    if (process.platform !== 'win32') {
      chmodSync(parent, 0o700);
      chmodSync(dir, 0o700);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `fleet merge state directory unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));
}

function validate(raw: unknown, key: string): FleetMergeStateV1 | string {
  if (!isObject(raw)) return 'record is not an object';
  if (raw['v'] !== STATE_VERSION) return 'unknown record version';
  if (raw['key'] !== key) return 'record key does not match its file';
  if (raw['kind'] !== 'change' && raw['kind'] !== 'revert') return 'record kind is invalid';
  if (typeof raw['repo'] !== 'string' || !NAME_WITH_OWNER_RE.test(raw['repo'])) return 'record repo is not owner/name';
  if (typeof raw['repoPath'] !== 'string' || raw['repoPath'].length === 0) return 'record repoPath is missing';
  if (raw['proposalId'] !== null && typeof raw['proposalId'] !== 'string') return 'record proposalId is invalid';
  if (!isObject(raw['gates'])) return 'record gates are invalid';
  if (!isIsoOrNull(raw['createdAt']) || !isIsoOrNull(raw['updatedAt']) || !isIsoOrNull(raw['judgeWaitSince'])) {
    return 'record timestamps are invalid';
  }
  if (raw['pr'] !== null && !isObject(raw['pr'])) return 'record pr is invalid';
  if (isObject(raw['pr'])) {
    const pr = raw['pr'];
    if (!Number.isSafeInteger(pr['number']) || Number(pr['number']) < 1) return 'record PR number is invalid';
    if (typeof pr['headSha'] !== 'string' || !/^[0-9a-f]{40}$/.test(pr['headSha'])) return 'record PR head is invalid';
    if (typeof pr['baseSha'] !== 'string' || !/^[0-9a-f]{40}$/.test(pr['baseSha'])) return 'record PR base is invalid';
    if (typeof pr['ownerLane'] !== 'boolean' || typeof pr['ledgered'] !== 'boolean') return 'record PR flags are invalid';
  }
  if (raw['merge'] !== null && !isObject(raw['merge'])) return 'record merge attempt is invalid';
  if (raw['landing'] !== null && !isObject(raw['landing'])) return 'record landing is invalid';
  return raw as unknown as FleetMergeStateV1;
}

/** Read one record. `missing` is the only honest "no state"; anything unreadable is `corrupt`. */
export function readFleetMergeState(key: string): FleetMergeStateRead {
  if (!KEY_RE.test(key)) return { state: 'corrupt', reason: 'invalid state key' };
  const path = statePath(key);
  try {
    if (!existsSync(path)) return { state: 'missing' };
  } catch (error) {
    return { state: 'corrupt', reason: `state unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_STATE_BYTES,
    remainingBytes: MAX_STATE_BYTES,
  });
  if (!read.ok) return { state: 'corrupt', reason: `state read failed (${read.reason})` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { state: 'corrupt', reason: 'state is not JSON' };
  }
  const record = validate(parsed, key);
  return typeof record === 'string' ? { state: 'corrupt', reason: record } : { state: 'ok', record };
}

/** Atomically replace one record (0600, fsynced). Returns false on any failure. */
export function writeFleetMergeState(record: FleetMergeStateV1): boolean {
  if (!KEY_RE.test(record.key)) return false;
  const dir = ensureStateDir();
  if (!dir.ok) return false;
  try {
    const path = statePath(record.key);
    const text = `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() })}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return false;
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    writePrivateFileAtomically(tmp, path, text, { anchorPath: homedir(), label: 'fleet merge state' });
    return true;
  } catch {
    return false;
  }
}

/** A fresh record for a change (proposal) or a revert. */
export function newFleetMergeState(input: {
  key: string;
  kind: 'change' | 'revert';
  proposalId: string | null;
  revertsLandingId: string | null;
  repo: string;
  repoPath: string;
  enforcement: RepoEnforcement | null;
  nowIso: string;
}): FleetMergeStateV1 {
  return {
    v: STATE_VERSION,
    key: input.key,
    kind: input.kind,
    proposalId: input.proposalId,
    revertsLandingId: input.revertsLandingId,
    repo: input.repo,
    repoPath: input.repoPath,
    enforcement: input.enforcement,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    gates: {},
    judgeWaitSince: null,
    baseBranch: null,
    baseSha: null,
    treeSha: null,
    diffHash: null,
    verifyDigest: null,
    risk: null,
    files: null,
    linesAdded: null,
    linesDeleted: null,
    producer: null,
    judgeId: null,
    openGatesDigest: null,
    pr: null,
    merge: null,
    landing: null,
    landingLedgered: false,
    outcome: null,
    outcomeReason: null,
  };
}

/** Every record key currently stored (bounded). Unreadable directory ⇒ null (callers fail closed). */
export function listFleetMergeStateKeys(): string[] | null {
  const dir = fleetMergeStateDir();
  try {
    if (!existsSync(dir)) return [];
    const keys: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      if (KEY_RE.test(key)) keys.push(key);
      if (keys.length > MAX_STATES) return null;
    }
    return keys.sort();
  } catch {
    return null;
  }
}

/**
 * True when a fleet PR exists (or existed) for this proposal. The legacy
 * merge paths refuse such a proposal, so one change can never land twice —
 * once through the fleet App and once through the old handoff / local merge.
 * Unknown (corrupt) counts as true: refusing is the safe answer.
 */
export function proposalHasFleetPr(proposalId: string): boolean {
  const key = proposalStateKey(proposalId);
  if (!key) return false;
  const read = readFleetMergeState(key);
  if (read.state === 'missing') return false;
  if (read.state === 'corrupt') return true;
  return read.record.pr !== null;
}

/** Cross-process exclusive hold on one record while a pass works on it. */
export function lockFleetMergeState(key: string, waitMs = 0): LocalStoreLock | null {
  if (!KEY_RE.test(key)) return null;
  if (!ensureStateDir().ok) return null;
  return acquireLocalStoreLock(lockPath(key), waitMs, { anchorPath: homedir() });
}

export function unlockFleetMergeState(lock: LocalStoreLock | null): void {
  releaseLocalStoreLock(lock);
}

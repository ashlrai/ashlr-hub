/**
 * The authority ledger — V3.10 Track B (unit B-U1).
 *
 * ~/.ashlr/authority/ledger.jsonl: ONE hash-chained, append-only log of every
 * grant, pause, revoke, kill, switch, gate, merge, revert, hold, Leader and
 * harness event (payload shapes: LedgerPayloads in ./types.ts). Merge commits
 * carry its head as the `Ashlr-Ledger-Head` trailer, each tick records the
 * head, and rollout criteria are evaluated from its rows.
 *
 * FORMAT. One entry per line, each line EXACTLY canonicalJson(entry) + '\n'.
 * entry.hash = sha256hex(LEDGER_HASH_DOMAIN ‖ canonicalJson(entry without
 * hash)); prevHash chains to the previous entry (LEDGER_GENESIS_PREV_HASH for
 * seq 0); seq is contiguous from 0; `at` never decreases (the writer clamps a
 * clock that stepped backwards). Row 0 is always `ledger:genesis`.
 *
 * TAMPER EVIDENCE, in layers:
 *   - the chain itself (any edit, reorder or deletion in the middle breaks it);
 *   - ledger-head.json, the ANCHOR rewritten after every append — a chain that
 *     is shorter than its anchor, or disagrees with it, was truncated;
 *   - a per-process high-water mark: a long-running daemon notices a chain
 *     that got shorter even if the anchor was rewritten with it;
 *   - the running prefix digest: `prefix` reads (the daemon's per-tick check)
 *     re-hash every byte already verified, so an in-place edit of an old row
 *     is caught within one tick;
 *   - ledger.broken, a STICKY marker: once any process sees the chain broken,
 *     every process treats it as broken until a newly signed grant starts a
 *     fresh chain (`ledger:recovered`) — "a broken or shortened chain halts
 *     everything until a new grant is signed" (SPEC-310B §1).
 * All of it defeats agents and accidents, not code running unconfined as
 * Mason (threat T3, documented residual): that code could rewrite every file
 * here consistently. The commit trailers on GitHub are the external anchor.
 *
 * WRITES are serialized by an exclusive private lock file, fsynced before the
 * call returns, and fail CLOSED: `ok: false` means the caller must not
 * perform the authority action it was recording. Raising actions append
 * first; lowering actions (Stop, revoke, switch down) act first and append
 * best-effort, because lowering authority must never depend on a ledger that
 * might be broken.
 *
 * Paths re-resolve homedir() on every call so a relocated HOME (tests) is
 * honoured; every piece of process-local state is keyed by the ledger path.
 */
import { createHash, randomBytes, type Hash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { FLEET_ACTORS, type FleetActor } from '../fleet/fleet-types.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { canonicalJson } from './canonical-json.js';
import { currentHostBinding } from './surface.js';
import {
  LEDGER_EVENT_KINDS,
  LEDGER_GENESIS_PREV_HASH,
  LEDGER_HASH_DOMAIN,
  STANDING_GRANT_PATTERNS,
  type AutonomySwitch,
  type GrantPauseCode,
  type LedgerAppendInput,
  type LedgerAppendResult,
  type LedgerEntry,
  type LedgerEntryOf,
  type LedgerEventKind,
  type LedgerHead,
  type LedgerReadOptions,
  type LedgerReadResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Paths and limits
// ---------------------------------------------------------------------------

export function authorityDir(): string {
  return join(homedir(), '.ashlr', 'authority');
}

export function ledgerPath(): string {
  return join(authorityDir(), 'ledger.jsonl');
}

export function ledgerAnchorPath(): string {
  return join(authorityDir(), 'ledger-head.json');
}

/** Sticky "this chain is broken" marker (see file header). */
export function ledgerBrokenMarkerPath(): string {
  return join(authorityDir(), 'ledger.broken');
}

function ledgerLockPath(): string {
  return join(authorityDir(), 'ledger.lock');
}

/** One entry's canonical line may not exceed this (the largest payload is a Leader action with its inverse). */
export const LEDGER_MAX_LINE_BYTES = 64 * 1024;
/** Past this the ledger refuses appends (fail closed) rather than grow without bound. */
const LEDGER_MAX_BYTES = 1024 * 1024 * 1024;
const LOCK_WAIT_MS = 1_000;
/** Cached reads re-parse the whole file at least this often. */
const FULL_REVERIFY_INTERVAL_MS = 60 * 60 * 1000;
const RECENT_HASHES = 512;
const ENTRY_KEYS = ['v', 'seq', 'at', 'actor', 'grantId', 'repo', 'prevHash', 'hash', 'kind', 'data'] as const;
const KIND_SET: ReadonlySet<string> = new Set(LEDGER_EVENT_KINDS);
const ACTOR_SET: ReadonlySet<string> = new Set(FLEET_ACTORS);
const GRANT_ID_RE = STANDING_GRANT_PATTERNS.grantId;
const ISO_RE = STANDING_GRANT_PATTERNS.isoInstant;
const SHA_RE = STANDING_GRANT_PATTERNS.sha256Hex;
const REPO_RE = STANDING_GRANT_PATTERNS.nameWithOwner;

// ---------------------------------------------------------------------------
// The authority index — what authority decisions read, derived while verifying
// ---------------------------------------------------------------------------

export interface LedgerAcceptedGrant {
  grantId: string;
  grantSeq: number;
  /** Ledger seq of the `grant:accepted` row (the rollout's first stage entry). */
  seq: number;
  at: string;
  stageIds: string[];
  expiresAt: string;
  authoritySurfaceDigest: string;
  envelopeDigest: string;
}

export interface LedgerRolloutPosition {
  grantId: string;
  stageIndex: number;
  stageId: string;
  /** When this stage became current. */
  enteredAt: string;
  /** Ledger seq of the row that entered it; evidence counts rows after it. */
  entrySeq: number;
  /** How it got here. */
  move: 'advanced' | 'regressed';
  fromStageId: string | null;
  /** The breach behind a regression; null for an advance. */
  breach: string | null;
}

export type LedgerEvidenceKind =
  | 'merge:landed'
  | 'revert:landed'
  | 'revert:failed'
  | 'post-merge:result'
  | 'gate:would-merge'
  | 'sandbox:violation'
  | 'reserve:breach'
  | 'sandbox:evidence-unknown';

// WHY revert:failed is evidence (3.10 review c6): the rollout waits for the
// revert of a red merge to settle before it advances, and a failed revert is
// one of the two ways it settles.
// WHY sandbox:evidence-unknown is evidence (3.10 d0): a run whose kernel
// violation evidence is incomplete proves nothing either way, so the rollout
// must SEE it to hold the stage (it never advances or regresses on it).
const EVIDENCE_KINDS: ReadonlySet<string> = new Set<LedgerEvidenceKind>([
  'merge:landed',
  'revert:landed',
  'revert:failed',
  'post-merge:result',
  'gate:would-merge',
  'sandbox:violation',
  'reserve:breach',
  'sandbox:evidence-unknown',
]);

export interface LedgerEvidenceRow {
  seq: number;
  at: string;
  kind: LedgerEvidenceKind;
  repo: string | null;
  /**
   * merge / revert: the landing's id; post-merge: the landing it judged;
   * revert:failed: the red landing that was NOT reverted.
   */
  landingId: string | null;
  /** post-merge verdict. */
  verdict: 'green' | 'red' | null;
  /**
   * revert:landed only: the merge landing this revert undoes. The rollout
   * charges a revert to the stage of the merge it reverts, not the stage it
   * happens to land in (3.10 review c6). Absent/null = unknown (legacy row).
   */
  revertsLandingId?: string | null;
  /** reserve:breach only: which seat and window crossed the line (dedupe per episode). */
  seatId?: string | null;
  window?: 'session' | 'weekly' | null;
}

export interface LedgerAuthorityIndex {
  genesisHostBinding: string | null;
  accepted: ReadonlyMap<string, LedgerAcceptedGrant>;
  /** The most recently accepted grant. */
  lastAccepted: LedgerAcceptedGrant | null;
  /** 0 when nothing was ever accepted. */
  maxAcceptedGrantSeq: number;
  /** A grant whose grantSeq is below this is dead (revoked, or superseded by a recovery). */
  minGrantSeq: number;
  revokedGrantIds: ReadonlySet<string>;
  /** Latest rollout position per grant (absent = still at stage 0 since acceptance). */
  rollout: ReadonlyMap<string, LedgerRolloutPosition>;
  /** Pause codes already ledgered per grant (so a pause is recorded once). */
  pausedCodes: ReadonlyMap<string, ReadonlySet<GrantPauseCode>>;
  expiredGrantIds: ReadonlySet<string>;
  lastSwitch: { to: AutonomySwitch; at: string } | null;
  /** Rollout evidence, oldest first. */
  evidence: readonly LedgerEvidenceRow[];
  /** The recovery row that started this chain, if any. */
  recovered: { seq: number; at: string; grantSeqFloor: number } | null;
}

interface MutableIndex {
  genesisHostBinding: string | null;
  accepted: Map<string, LedgerAcceptedGrant>;
  lastAccepted: LedgerAcceptedGrant | null;
  maxAcceptedGrantSeq: number;
  minGrantSeq: number;
  revokedGrantIds: Set<string>;
  rollout: Map<string, LedgerRolloutPosition>;
  pausedCodes: Map<string, Set<GrantPauseCode>>;
  expiredGrantIds: Set<string>;
  lastSwitch: { to: AutonomySwitch; at: string } | null;
  evidence: LedgerEvidenceRow[];
  recovered: { seq: number; at: string; grantSeqFloor: number } | null;
}

function emptyIndex(): MutableIndex {
  return {
    genesisHostBinding: null,
    accepted: new Map(),
    lastAccepted: null,
    maxAcceptedGrantSeq: 0,
    minGrantSeq: 0,
    revokedGrantIds: new Set(),
    rollout: new Map(),
    pausedCodes: new Map(),
    expiredGrantIds: new Set(),
    lastSwitch: null,
    evidence: [],
    recovered: null,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function int(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * Fold one verified entry into the index. Lenient about payload detail (a row
 * another unit wrote with a missing optional field is still a chain member),
 * strict about what authority decisions need — an accepted row without a
 * usable grantSeq simply does not count as an acceptance.
 */
function indexEntry(index: MutableIndex, entry: LedgerEntry): void {
  const data = entry.data as unknown as Record<string, unknown>;
  switch (entry.kind) {
    case 'ledger:genesis':
      index.genesisHostBinding = str(data['hostBinding']);
      return;
    case 'ledger:recovered': {
      const floor = int(data['grantSeqFloor']) ?? 0;
      index.recovered = { seq: entry.seq, at: entry.at, grantSeqFloor: floor };
      index.minGrantSeq = Math.max(index.minGrantSeq, floor + 1);
      return;
    }
    case 'grant:accepted': {
      const grantId = str(data['grantId']);
      const grantSeq = int(data['grantSeq']);
      if (!grantId || grantSeq === null) return;
      const accepted: LedgerAcceptedGrant = {
        grantId,
        grantSeq,
        seq: entry.seq,
        at: entry.at,
        stageIds: Array.isArray(data['stageIds']) ? (data['stageIds'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
        expiresAt: str(data['expiresAt']) ?? '',
        authoritySurfaceDigest: str(data['authoritySurfaceDigest']) ?? '',
        envelopeDigest: str(data['envelopeDigest']) ?? '',
      };
      index.accepted.set(grantId, accepted);
      index.lastAccepted = accepted;
      index.maxAcceptedGrantSeq = Math.max(index.maxAcceptedGrantSeq, grantSeq);
      // A re-acceptance restarts the ladder at the grant's first stage.
      index.rollout.delete(grantId);
      index.pausedCodes.delete(grantId);
      index.expiredGrantIds.delete(grantId);
      return;
    }
    case 'grant:revoked': {
      const grantId = str(data['grantId']);
      const floor = int(data['minGrantSeq']);
      if (grantId) index.revokedGrantIds.add(grantId);
      if (floor !== null) index.minGrantSeq = Math.max(index.minGrantSeq, floor);
      return;
    }
    case 'grant:paused': {
      const grantId = str(data['grantId']);
      const code = str(data['code']) as GrantPauseCode | null;
      if (!grantId || !code) return;
      const codes = index.pausedCodes.get(grantId) ?? new Set<GrantPauseCode>();
      codes.add(code);
      index.pausedCodes.set(grantId, codes);
      return;
    }
    case 'grant:expired': {
      const grantId = str(data['grantId']);
      if (grantId) index.expiredGrantIds.add(grantId);
      return;
    }
    case 'switch:changed': {
      const to = str(data['to']);
      if (to === 'off' || to === 'propose' || to === 'autonomous') index.lastSwitch = { to, at: entry.at };
      return;
    }
    case 'rollout:advanced':
    case 'rollout:regressed': {
      const grantId = str(data['grantId']);
      const stageIndex = int(data['toStageIndex']);
      const stageId = str(data['toStageId']);
      if (!grantId || stageIndex === null || !stageId) return;
      index.rollout.set(grantId, {
        grantId,
        stageIndex,
        stageId,
        enteredAt: entry.at,
        entrySeq: entry.seq,
        move: entry.kind === 'rollout:advanced' ? 'advanced' : 'regressed',
        fromStageId: str(data['fromStageId']),
        breach: entry.kind === 'rollout:regressed' ? str(data['breach']) : null,
      });
      return;
    }
    default:
      break;
  }
  if (EVIDENCE_KINDS.has(entry.kind)) {
    // A landing row that says it is a revert counts as one whichever row kind
    // carried it: a revert must never be counted as a merge toward advancing.
    const kind = (entry.kind === 'merge:landed' && data['kind'] === 'revert' ? 'revert:landed' : entry.kind) as LedgerEvidenceKind;
    let landingId: string | null = null;
    if (kind === 'post-merge:result' || kind === 'revert:failed') landingId = str(data['landingId']);
    else if (kind === 'merge:landed' || kind === 'revert:landed') landingId = str(data['id']);
    const verdict = kind === 'post-merge:result' && (data['verdict'] === 'green' || data['verdict'] === 'red')
      ? data['verdict']
      : null;
    const row: LedgerEvidenceRow = { seq: entry.seq, at: entry.at, kind, repo: entry.repo, landingId, verdict };
    if (kind === 'revert:landed') row.revertsLandingId = str(data['revertsLandingId']);
    if (kind === 'reserve:breach') {
      row.seatId = str(data['seatId']);
      row.window = data['window'] === 'session' || data['window'] === 'weekly' ? data['window'] : null;
    }
    index.evidence.push(row);
  }
}

// ---------------------------------------------------------------------------
// Entry codec
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && new Date(value).toISOString() === value;
}

/** The entry hash: sha256hex(domain ‖ canonical(entry without `hash`)). */
export function ledgerEntryHash(entry: Omit<LedgerEntry, 'hash'> | LedgerEntry): string {
  const { hash: _omit, ...rest } = entry as LedgerEntry;
  void _omit;
  return createHash('sha256').update(LEDGER_HASH_DOMAIN + canonicalJson(rest), 'utf8').digest('hex');
}

/** Why one line does not continue the chain; null when it does. */
function checkLine(
  line: string,
  expected: { seq: number; prevHash: string; minAt: string | null },
): { entry: LedgerEntry } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { reason: 'unparseable line' };
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ENTRY_KEYS)) return { reason: 'entry has the wrong keys' };
  if (parsed['v'] !== 1) return { reason: 'unknown entry version' };
  if (parsed['seq'] !== expected.seq) return { reason: `sequence gap (expected ${expected.seq})` };
  if (!isIsoInstant(parsed['at'])) return { reason: 'bad timestamp' };
  if (expected.minAt !== null && (parsed['at'] as string) < expected.minAt) return { reason: 'timestamp went backwards' };
  if (typeof parsed['actor'] !== 'string' || !ACTOR_SET.has(parsed['actor'])) return { reason: 'unknown actor' };
  const grantId = parsed['grantId'];
  if (grantId !== null && (typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId))) return { reason: 'bad grantId' };
  const repo = parsed['repo'];
  if (repo !== null && (typeof repo !== 'string' || !REPO_RE.test(repo))) return { reason: 'bad repo' };
  if (parsed['prevHash'] !== expected.prevHash) return { reason: 'prevHash does not chain' };
  if (typeof parsed['kind'] !== 'string' || !KIND_SET.has(parsed['kind'])) return { reason: 'unknown event kind' };
  if (expected.seq === 0 && parsed['kind'] !== 'ledger:genesis') return { reason: 'first entry is not a genesis row' };
  if (!isRecord(parsed['data'])) return { reason: 'data is not an object' };
  if (typeof parsed['hash'] !== 'string' || !SHA_RE.test(parsed['hash'])) return { reason: 'bad hash field' };
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    return { reason: 'entry is not canonical JSON' };
  }
  if (canonical !== line) return { reason: 'entry is not in canonical form' };
  if (ledgerEntryHash(parsed as unknown as LedgerEntry) !== parsed['hash']) return { reason: 'hash mismatch' };
  return { entry: parsed as unknown as LedgerEntry };
}

// ---------------------------------------------------------------------------
// Process-local verified state
// ---------------------------------------------------------------------------

interface ChainState {
  dev: bigint;
  ino: bigint;
  /** Bytes of complete, verified lines. */
  verifiedBytes: number;
  prefixHash: Hash;
  head: LedgerHead | null;
  genesisHash: string | null;
  /** Hashes of the most recent entries (anchor / high-water checks). */
  recent: Map<number, string>;
  /** Seqs whose hash must be kept even outside `recent` (the anchor and high-water marks at scan time). */
  watch: Set<number>;
  watched: Map<number, string>;
  index: MutableIndex;
  lastFullAt: number;
}

type BrokenInfo = { brokenAtSeq: number | null; reason: string };

const chains = new Map<string, ChainState>();
const highWater = new Map<string, { seq: number; hash: string; genesisHash: string | null }>();

export interface LedgerSnapshot {
  chain: 'ok' | 'empty' | 'broken';
  head: LedgerHead | null;
  brokenAtSeq: number | null;
  reason: string | null;
  /** Derived authority facts; for a broken chain, what was verified before the break. */
  index: LedgerAuthorityIndex;
  /** The chain's first entry hash (identifies the chain); null when empty. */
  genesisHash: string | null;
}

/**
 * How much re-verification a read does:
 *   - `cached`: new bytes only (plus an hourly full pass). Display paths and
 *     currentStandingPolicy() between ticks.
 *   - `prefix`: re-hash every verified byte, then new bytes. The daemon's
 *     per-tick check — catches in-place edits of old rows within one tick.
 *   - `full`:   re-parse everything.
 */
export type LedgerReadMode = 'cached' | 'prefix' | 'full';

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function ownedPrivateFile(stat: BigIntStats): boolean {
  const owned = typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
  const privateMode = process.platform === 'win32' || (stat.mode & 0o077n) === 0n;
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && owned && privateMode;
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readRange(fd: number, start: number, end: number): Buffer {
  const bytes = Buffer.alloc(end - start);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, start + offset);
    if (count <= 0) throw new Error('short ledger read');
    offset += count;
  }
  return bytes;
}

interface AnchorRecord {
  seq: number;
  hash: string;
  at: string;
}

function readSmallPrivateJson(path: string, maxBytes: number): { state: 'missing' } | { state: 'invalid' } | { state: 'ok'; value: unknown } {
  const stat = lstatOrNull(path);
  if (!stat) return { state: 'missing' };
  if (!ownedPrivateFile(stat) || stat.size > BigInt(maxBytes)) return { state: 'invalid' };
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return { state: 'invalid' };
    const text = readRange(fd, 0, Number(opened.size)).toString('utf8');
    return { state: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { state: 'invalid' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readAnchor(): { state: 'missing' } | { state: 'invalid' } | { state: 'ok'; anchor: AnchorRecord } {
  const read = readSmallPrivateJson(ledgerAnchorPath(), 4096);
  if (read.state !== 'ok') return read;
  const value = read.value;
  if (!isRecord(value) || !exactKeys(value, ['v', 'seq', 'hash', 'at']) || value['v'] !== 1) return { state: 'invalid' };
  const seq = int(value['seq']);
  if (seq === null || typeof value['hash'] !== 'string' || !SHA_RE.test(value['hash']) || !isIsoInstant(value['at'])) {
    return { state: 'invalid' };
  }
  return { state: 'ok', anchor: { seq, hash: value['hash'], at: value['at'] } };
}

function readBrokenMarker(): BrokenInfo | null {
  const read = readSmallPrivateJson(ledgerBrokenMarkerPath(), 16 * 1024);
  if (read.state === 'missing') return null;
  if (read.state === 'invalid') return { brokenAtSeq: null, reason: 'the ledger was marked broken (marker unreadable)' };
  const value = read.value;
  if (!isRecord(value)) return { brokenAtSeq: null, reason: 'the ledger was marked broken' };
  const reason = typeof value['reason'] === 'string' ? value['reason'].slice(0, 300) : 'the ledger was marked broken';
  return { brokenAtSeq: int(value['brokenAtSeq']), reason };
}

/** Parse + verify complete lines from `bytes`; extends `state` in place. Returns a break or null. */
function consumeBytes(state: ChainState, bytes: Buffer): BrokenInfo | null {
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue;
    const lineBytes = bytes.subarray(lineStart, i);
    const nextSeq = state.head ? state.head.seq + 1 : 0;
    if (lineBytes.length > LEDGER_MAX_LINE_BYTES) return { brokenAtSeq: nextSeq, reason: `entry ${nextSeq} is larger than ${LEDGER_MAX_LINE_BYTES} bytes` };
    const checked = checkLine(lineBytes.toString('utf8'), {
      seq: nextSeq,
      prevHash: state.head ? state.head.hash : LEDGER_GENESIS_PREV_HASH,
      minAt: state.head ? state.head.at : null,
    });
    if ('reason' in checked) return { brokenAtSeq: nextSeq, reason: `entry ${nextSeq}: ${checked.reason}` };
    const entry = checked.entry;
    noteVerified(state, entry);
    const consumed = bytes.subarray(lineStart, i + 1);
    state.prefixHash.update(consumed);
    state.verifiedBytes += consumed.length;
    lineStart = i + 1;
  }
  return null;
}

/** Record a verified entry in the state (everything but the byte accounting). */
function noteVerified(state: ChainState, entry: LedgerEntry): void {
  indexEntry(state.index, entry);
  state.head = { seq: entry.seq, hash: entry.hash, at: entry.at };
  if (entry.seq === 0) state.genesisHash = entry.hash;
  state.recent.set(entry.seq, entry.hash);
  if (state.recent.size > RECENT_HASHES) state.recent.delete(entry.seq - RECENT_HASHES);
  if (state.watch.has(entry.seq)) state.watched.set(entry.seq, entry.hash);
}

function freshState(stat: { dev: bigint; ino: bigint } | null, watch: Iterable<number> = []): ChainState {
  return {
    dev: stat?.dev ?? 0n,
    ino: stat?.ino ?? 0n,
    verifiedBytes: 0,
    prefixHash: createHash('sha256'),
    head: null,
    genesisHash: null,
    recent: new Map(),
    watch: new Set(watch),
    watched: new Map(),
    index: emptyIndex(),
    lastFullAt: Date.now(),
  };
}

/** The verified hash of `seq`, when this state still knows it. */
function knownHash(state: ChainState, seq: number): string | undefined {
  return state.recent.get(seq) ?? state.watched.get(seq);
}

function snapshotOf(state: ChainState | null, broken: BrokenInfo | null): LedgerSnapshot {
  const index = state ? state.index : emptyIndex();
  if (broken) {
    return { chain: 'broken', head: state?.head ?? null, brokenAtSeq: broken.brokenAtSeq, reason: broken.reason, index, genesisHash: state?.genesisHash ?? null };
  }
  if (!state || !state.head) return { chain: 'empty', head: null, brokenAtSeq: null, reason: null, index, genesisHash: null };
  return { chain: 'ok', head: { ...state.head }, brokenAtSeq: null, reason: null, index, genesisHash: state.genesisHash };
}

/**
 * Bring this process's verified view of the ledger up to date. Never throws:
 * any doubt is reported as a broken chain (fail closed).
 */
function syncChain(mode: LedgerReadMode): { state: ChainState | null; broken: BrokenInfo | null } {
  const path = ledgerPath();
  try {
    const marker = readBrokenMarker();
    const anchor = readAnchor();
    const hwm = highWater.get(path) ?? null;
    const stat = lstatOrNull(path);
    if (!stat) {
      chains.delete(path);
      if (anchor.state === 'ok') return { state: null, broken: marker ?? { brokenAtSeq: 0, reason: `the ledger is missing but its anchor records entry ${anchor.anchor.seq}` } };
      if (anchor.state === 'invalid') return { state: null, broken: { brokenAtSeq: null, reason: 'the ledger anchor is unreadable' } };
      if (hwm) return { state: null, broken: { brokenAtSeq: 0, reason: `the ledger disappeared after this process saw entry ${hwm.seq}` } };
      return { state: null, broken: marker };
    }
    if (!ownedPrivateFile(stat)) return { state: chains.get(path) ?? null, broken: { brokenAtSeq: null, reason: 'the ledger file is not a private regular file owned by this user' } };
    if (stat.size > BigInt(LEDGER_MAX_BYTES)) return { state: chains.get(path) ?? null, broken: { brokenAtSeq: null, reason: 'the ledger is larger than the supported maximum' } };

    const watch: number[] = [];
    if (anchor.state === 'ok') watch.push(anchor.anchor.seq);
    if (hwm) watch.push(hwm.seq);

    let state = chains.get(path) ?? null;
    const size = Number(stat.size);
    const identityChanged = !state || state.dev !== stat.dev || state.ino !== stat.ino;
    const shrank = state !== null && size < state.verifiedBytes;
    const due = state !== null && Date.now() - state.lastFullAt > FULL_REVERIFY_INTERVAL_MS;
    // A seq we must confirm that this state has already scrolled past forces a full pass.
    const unconfirmable = state !== null && watch.some((seq) => state!.head !== null && seq <= state!.head.seq && knownHash(state!, seq) === undefined);
    const full = mode === 'full' || identityChanged || shrank || due || unconfirmable;

    const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
    let broken: BrokenInfo | null = null;
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
        return { state, broken: { brokenAtSeq: null, reason: 'the ledger changed while it was being opened' } };
      }
      const openedSize = Number(opened.size);
      if (!full && state && mode === 'prefix' && state.verifiedBytes > 0) {
        const prefix = createHash('sha256').update(readRange(fd, 0, state.verifiedBytes)).digest('hex');
        if (prefix !== state.prefixHash.copy().digest('hex')) {
          broken = { brokenAtSeq: null, reason: 'entries this process already verified were changed in place' };
        }
      }
      if (!broken) {
        if (full || !state) state = freshState(opened, watch);
        else for (const seq of watch) state.watch.add(seq);
        if (openedSize > state.verifiedBytes) {
          broken = consumeBytes(state, readRange(fd, state.verifiedBytes, openedSize));
        }
      }
    } finally {
      closeSync(fd);
    }
    if (state) chains.set(path, state);
    if (broken) return { state, broken };
    if (marker) return { state, broken: marker };

    // Anchor: the chain must reach it and agree with it.
    if (anchor.state === 'invalid') return { state, broken: { brokenAtSeq: null, reason: 'the ledger anchor is unreadable' } };
    if (anchor.state === 'ok' && state) {
      const a = anchor.anchor;
      if (!state.head || a.seq > state.head.seq) {
        return { state, broken: { brokenAtSeq: state.head ? state.head.seq + 1 : 0, reason: `the ledger is shorter than its anchor (anchor at entry ${a.seq})` } };
      }
      const known = knownHash(state, a.seq);
      if (known === undefined) return { state, broken: { brokenAtSeq: a.seq, reason: `could not confirm anchor entry ${a.seq}` } };
      if (known !== a.hash) return { state, broken: { brokenAtSeq: a.seq, reason: `entry ${a.seq} disagrees with the anchor` } };
    }

    // High-water mark: a chain that got shorter or was rewritten in this process's lifetime.
    if (state?.head) {
      if (hwm) {
        // A chain REPLACED by a signed recovery legitimately restarts at seq 0.
        const replacedByRecovery = hwm.genesisHash !== state.genesisHash && state.index.recovered !== null;
        if (!replacedByRecovery) {
          if (state.head.seq < hwm.seq) {
            return { state, broken: { brokenAtSeq: state.head.seq + 1, reason: `the ledger got shorter (this process saw entry ${hwm.seq})` } };
          }
          const known = knownHash(state, hwm.seq);
          if (known !== undefined && known !== hwm.hash) {
            return { state, broken: { brokenAtSeq: hwm.seq, reason: `entry ${hwm.seq} was rewritten` } };
          }
        }
      }
      if (!hwm || state.head.seq >= hwm.seq || state.genesisHash !== hwm.genesisHash) {
        highWater.set(path, { seq: state.head.seq, hash: state.head.hash, genesisHash: state.genesisHash });
      }
    }
    return { state, broken: null };
  } catch (error) {
    return { state: chains.get(path) ?? null, broken: { brokenAtSeq: null, reason: `the ledger could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` } };
  }
}

/** Persist the sticky broken marker (best effort — the in-memory verdict already fails closed). */
function markBroken(broken: BrokenInfo, head: LedgerHead | null): void {
  try {
    if (readBrokenMarker()) return;
    ensureAuthorityDir();
    writePrivateAtomically(ledgerBrokenMarkerPath(), `${canonicalJson({
      v: 1,
      detectedAt: new Date().toISOString(),
      brokenAtSeq: broken.brokenAtSeq,
      reason: broken.reason,
      lastIntactHead: head,
      pid: process.pid,
    })}\n`);
  } catch {
    // The marker is defense in depth; the caller already treats the chain as broken.
  }
}

/** The verified ledger state (sync; never throws). A broken chain is persisted as sticky. */
export function ledgerSnapshot(mode: LedgerReadMode = 'cached'): LedgerSnapshot {
  const { state, broken } = syncChain(mode);
  if (broken) markBroken(broken, state?.head ?? null);
  return snapshotOf(state, broken);
}

// ---------------------------------------------------------------------------
// Private storage helpers
// ---------------------------------------------------------------------------

function ensurePrivateDirectory(path: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path, { bigint: true });
  const owned = typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned) throw new Error(`unsafe authority directory: ${basename(path)}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n) {
    if (!created) throw new Error(`authority directory is not private (0700): ${basename(path)}`);
    chmodSync(path, 0o700);
  }
  if (created) fsyncDirectory(dirname(path));
  const assurance = assurePrivateStoragePath(path, 'directory', created ? 'secure-created' : 'inspect-existing', { anchorPath: resolve(homedir()) });
  if (!assurance.ok) throw new Error(`unsafe authority directory (${assurance.reason})`);
}

/** Create ~/.ashlr (if absent) and ~/.ashlr/authority as private directories. */
export function ensureAuthorityDir(): string {
  const home = resolve(homedir());
  const ashlr = join(home, '.ashlr');
  try {
    mkdirSync(ashlr, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const dir = authorityDir();
  ensurePrivateDirectory(dir);
  return dir;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error('write made no progress');
    offset += count;
  }
}

/**
 * Atomic private write: O_EXCL|O_NOFOLLOW temp (0600) in the same directory,
 * fsync, rename over the target, fsync the directory. Used for the anchor,
 * the broken marker and (via standing-grant / clamp) the other authority files.
 */
export function writePrivateAtomically(target: string, text: string): void {
  const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
    fchmodSync(fd, 0o600);
    writeAll(fd, Buffer.from(text, 'utf8'));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    fsyncDirectory(dirname(target));
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { unlinkSync(temp); } catch { /* not created or already renamed */ }
    throw error;
  }
}

/** Read a small private file written by writePrivateAtomically (owner + mode checked). */
export function readPrivateText(path: string, maxBytes: number): { state: 'missing' } | { state: 'invalid' } | { state: 'ok'; text: string } {
  const stat = lstatOrNull(path);
  if (!stat) return { state: 'missing' };
  if (!ownedPrivateFile(stat) || stat.size > BigInt(maxBytes)) return { state: 'invalid' };
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return { state: 'invalid' };
    return { state: 'ok', text: readRange(fd, 0, Number(opened.size)).toString('utf8') };
  } catch {
    return { state: 'invalid' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Appending
// ---------------------------------------------------------------------------

function validateInput(input: LedgerAppendInput<LedgerEventKind>): string | null {
  if (!isRecord(input)) return 'append input must be an object';
  if (typeof input.kind !== 'string' || !KIND_SET.has(input.kind)) return `unknown ledger event kind: ${String(input.kind)}`;
  if (input.kind === 'ledger:genesis' || input.kind === 'ledger:recovered') return `${input.kind} rows are written by the ledger itself`;
  if (typeof input.actor !== 'string' || !ACTOR_SET.has(input.actor)) return `unknown actor: ${String(input.actor)}`;
  if (input.grantId !== null && (typeof input.grantId !== 'string' || !GRANT_ID_RE.test(input.grantId))) return 'grantId must be 32 lowercase hex or null';
  if (input.repo !== null && (typeof input.repo !== 'string' || !REPO_RE.test(input.repo))) return 'repo must be a GitHub owner/name or null';
  if (!isRecord(input.data)) return 'data must be a JSON object';
  return null;
}

function nowIso(floor: string | null): string {
  const now = new Date().toISOString();
  return floor !== null && now < floor ? floor : now;
}

interface OpenLedger {
  state: ChainState;
}

/** Append one fully-formed entry to the (verified, locked) ledger. */
function writeEntry(
  open: OpenLedger,
  kind: LedgerEventKind,
  data: Record<string, unknown>,
  actor: FleetActor,
  grantId: string | null,
  repo: string | null,
): LedgerEntry {
  const state = open.state;
  const seq = state.head ? state.head.seq + 1 : 0;
  const base = {
    v: 1 as const,
    seq,
    at: nowIso(state.head ? state.head.at : null),
    actor,
    grantId,
    repo,
    prevHash: state.head ? state.head.hash : LEDGER_GENESIS_PREV_HASH,
    kind,
    data,
  };
  // Round-trip through canonical JSON first so `undefined` fields vanish and
  // the hash is taken over exactly the bytes that get written.
  const normalized = JSON.parse(canonicalJson(base)) as Record<string, unknown>;
  const hash = createHash('sha256').update(LEDGER_HASH_DOMAIN + canonicalJson(normalized), 'utf8').digest('hex');
  const entry = { ...normalized, hash } as unknown as LedgerEntry;
  const line = `${canonicalJson(entry)}\n`;
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length - 1 > LEDGER_MAX_LINE_BYTES) throw new Error(`ledger entry is larger than ${LEDGER_MAX_LINE_BYTES} bytes`);
  if (state.verifiedBytes + bytes.length > LEDGER_MAX_BYTES) throw new Error('the ledger is full');

  const path = ledgerPath();
  let fd: number;
  if (state.verifiedBytes === 0 && lstatOrNull(path) === null) {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_APPEND | noFollowFlag(), 0o600);
    fchmodSync(fd, 0o600);
    const created = fstatSync(fd, { bigint: true });
    state.dev = created.dev;
    state.ino = created.ino;
  } else {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollowFlag());
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== state.dev || opened.ino !== state.ino || !ownedPrivateFile(opened)) {
      throw new Error('the ledger file changed identity under the lock');
    }
    // A torn trailing line (a crash mid-write) was never acknowledged — it
    // has no anchor and no caller saw ok:true for it — so dropping it cannot
    // remove a real entry. Completed entries are never truncated.
    if (Number(opened.size) > state.verifiedBytes) ftruncateSync(fd, state.verifiedBytes);
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (seq === 0) fsyncDirectory(dirname(path));
  noteVerified(state, entry);
  state.prefixHash.update(bytes);
  state.verifiedBytes += bytes.length;
  chains.set(path, state);
  highWater.set(path, { seq: entry.seq, hash: entry.hash, genesisHash: state.genesisHash });
  writePrivateAtomically(ledgerAnchorPath(), `${canonicalJson({ v: 1, seq: entry.seq, hash: entry.hash, at: entry.at })}\n`);
  return entry;
}

/** What a ledger transaction can do while it holds the lock. */
export interface LedgerTransaction {
  /** The chain as verified under the lock. */
  readonly snapshot: LedgerSnapshot;
  /** Append one row (writes the genesis row first on an empty ledger). Throws on failure. */
  append<K extends LedgerEventKind>(input: LedgerAppendInput<K>): LedgerEntryOf<K>;
  /**
   * The highest grantSeq the broken chain ever accepted or revoked below —
   * verified rows plus an untrusting scan of the rest (which can only raise
   * it). A replacement grant must be strictly above it.
   */
  brokenChainFloor(): number;
  /**
   * Archive a BROKEN chain beside the ledger and start a fresh one whose
   * second row is `ledger:recovered`. Only standing-grant installation calls
   * this — a new Touch ID signature is the authorization to start over.
   */
  recoverBrokenChain(reason: string): { grantSeqFloor: number; archivedAs: string };
}

export type LedgerTransactionResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Run `fn` holding the exclusive ledger lock, against a chain verified under
 * that lock. Anything `fn` throws aborts the rest (rows already appended stay:
 * the log is append-only) and comes back as `ok: false`.
 */
/**
 * Highest grantSeq a broken chain ever mentioned, read WITHOUT trusting it.
 * Unverified rows can only raise the recovery floor (kill more old grants),
 * never lower it, so reading past the break is the fail-safe direction.
 */
function lenientGrantSeqFloor(path: string): number {
  let floor = 0;
  const read = readPrivateText(path, LEDGER_MAX_BYTES);
  if (read.state !== 'ok') return floor;
  for (const line of read.text.split('\n')) {
    if (line.length === 0 || line.length > LEDGER_MAX_LINE_BYTES) continue;
    try {
      const row = JSON.parse(line) as { kind?: unknown; data?: Record<string, unknown> };
      const data = isRecord(row.data) ? row.data : {};
      if (row.kind === 'grant:accepted') floor = Math.max(floor, int(data['grantSeq']) ?? 0);
      else if (row.kind === 'grant:revoked') floor = Math.max(floor, (int(data['minGrantSeq']) ?? 1) - 1);
      else if (row.kind === 'ledger:recovered') floor = Math.max(floor, int(data['grantSeqFloor']) ?? 0);
    } catch {
      // unparseable rows cannot lower the floor
    }
  }
  return floor;
}

export function withLedgerTransaction<T>(fn: (tx: LedgerTransaction) => T): LedgerTransactionResult<T> {
  try {
    ensureAuthorityDir();
  } catch (error) {
    return { ok: false, reason: `ledger directory unavailable: ${(error as Error).message}` };
  }
  const lock = acquireLocalStoreLock(ledgerLockPath(), LOCK_WAIT_MS, { anchorPath: resolve(homedir()), exactPrivateStorage: true });
  if (!lock) return { ok: false, reason: 'ledger lock unavailable (another writer is busy)' };
  try {
    const synced = syncChain('cached');
    if (synced.broken) markBroken(synced.broken, synced.state?.head ?? null);
    let snapshot = snapshotOf(synced.state, synced.broken);
    let state: ChainState | null = synced.state;
    const tx: LedgerTransaction = {
      get snapshot() {
        return snapshot;
      },
      append<K extends LedgerEventKind>(input: LedgerAppendInput<K>): LedgerEntryOf<K> {
        const invalid = validateInput(input as LedgerAppendInput<LedgerEventKind>);
        if (invalid) throw new Error(invalid);
        if (snapshot.chain === 'broken') throw new Error(`ledger chain is broken: ${snapshot.reason ?? 'unknown reason'}`);
        if (!state) {
          if (lstatOrNull(ledgerPath())) throw new Error('ledger state unavailable');
          state = freshState(null);
        }
        const open: OpenLedger = { state };
        if (!state.head) {
          writeEntry(open, 'ledger:genesis', { hostBinding: currentHostBinding() }, 'daemon', null, null);
        }
        const entry = writeEntry(open, input.kind, input.data as unknown as Record<string, unknown>, input.actor, input.grantId, input.repo);
        snapshot = snapshotOf(state, null);
        return entry as LedgerEntryOf<K>;
      },
      brokenChainFloor(): number {
        return Math.max(
          snapshot.index.maxAcceptedGrantSeq,
          snapshot.index.minGrantSeq > 0 ? snapshot.index.minGrantSeq - 1 : 0,
          lenientGrantSeqFloor(ledgerPath()),
        );
      },
      recoverBrokenChain(reason: string): { grantSeqFloor: number; archivedAs: string } {
        if (snapshot.chain !== 'broken') throw new Error('the ledger chain is not broken');
        const floor = tx.brokenChainFloor();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivedAs = `ledger.broken-${stamp}.jsonl`;
        const path = ledgerPath();
        if (lstatOrNull(path)) renameSync(path, join(authorityDir(), archivedAs));
        if (lstatOrNull(ledgerAnchorPath())) renameSync(ledgerAnchorPath(), join(authorityDir(), `ledger-head.broken-${stamp}.json`));
        fsyncDirectory(authorityDir());
        const previousHead = snapshot.head;
        const brokenAtSeq = snapshot.brokenAtSeq;
        const brokenReason = snapshot.reason ?? 'unknown';
        chains.delete(path);
        highWater.delete(path);
        state = freshState(null);
        const open: OpenLedger = { state };
        writeEntry(open, 'ledger:genesis', { hostBinding: currentHostBinding() }, 'mason', null, null);
        writeEntry(open, 'ledger:recovered', {
          previousHead,
          brokenAtSeq,
          reason: `${reason} — ${brokenReason}`.slice(0, 500),
          archivedAs,
          grantSeqFloor: floor,
        }, 'mason', null, null);
        try {
          unlinkSync(ledgerBrokenMarkerPath());
          fsyncDirectory(authorityDir());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        snapshot = snapshotOf(state, null);
        return { grantSeqFloor: floor, archivedAs };
      },
    };
    return { ok: true, value: fn(tx) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message || 'ledger transaction failed' };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/**
 * Append one entry (fills seq, at, prevHash, hash) under the ledger lock,
 * fsynced before returning. `ok: false` ⇒ the caller must NOT perform the
 * authority action it was recording (fail closed).
 */
export function appendLedger<K extends LedgerEventKind>(input: LedgerAppendInput<K>): LedgerAppendResult<K> {
  const invalid = validateInput(input as LedgerAppendInput<LedgerEventKind>);
  if (invalid) return { ok: false, reason: invalid };
  const result = withLedgerTransaction((tx) => tx.append(input));
  return result.ok ? { ok: true, entry: result.value } : { ok: false, reason: result.reason };
}

/**
 * The chain head for trailers and tick records. null = the ledger is empty.
 * Throws when the chain is broken (callers fail closed).
 */
export function currentLedgerHead(): LedgerHead | null {
  const snapshot = ledgerSnapshot('cached');
  if (snapshot.chain === 'broken') throw new Error(`authority ledger chain is broken: ${snapshot.reason ?? 'unknown reason'}`);
  return snapshot.head;
}

// ---------------------------------------------------------------------------
// Reading (async, yields to the event loop)
// ---------------------------------------------------------------------------

/** Budget of synchronous work between yields — keeps a Verse request handler under its 20 ms loop budget. */
const READ_SLICE_MS = 8;

function matches(entry: LedgerEntry, opts: LedgerReadOptions, kinds: ReadonlySet<string> | null): boolean {
  if (opts.sinceSeq !== undefined && entry.seq < opts.sinceSeq) return false;
  if (opts.sinceAt !== undefined && entry.at < opts.sinceAt) return false;
  if (kinds && !kinds.has(entry.kind)) return false;
  if (opts.repo !== undefined && entry.repo !== opts.repo) return false;
  if (opts.grantId !== undefined && entry.grantId !== opts.grantId) return false;
  return true;
}

/**
 * Read (and chain-verify) entries, oldest first. A broken chain is reported,
 * never hidden: entries before the break are returned, `chain: 'broken'`.
 * Async because a full read + verify of a long ledger would block a Verse
 * request handler past the 20 ms event-loop budget (SPEC-310A §0).
 */
export async function readLedger(opts: LedgerReadOptions = {}): Promise<LedgerReadResult> {
  const kinds = opts.kinds ? new Set<string>(opts.kinds) : null;
  const limit = opts.limit !== undefined && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : null;
  const out: LedgerEntry[] = [];
  const push = (entry: LedgerEntry): void => {
    if (!matches(entry, opts, kinds)) return;
    out.push(entry);
    if (limit !== null && out.length > limit) out.shift();
  };
  const path = ledgerPath();
  const marker = readBrokenMarker();
  const stat = lstatOrNull(path);
  if (!stat) {
    const anchor = readAnchor();
    if (anchor.state === 'ok') return { entries: [], head: null, chain: 'broken', brokenAtSeq: 0, reason: `the ledger is missing but its anchor records entry ${anchor.anchor.seq}` };
    if (marker) return { entries: [], head: null, chain: 'broken', brokenAtSeq: marker.brokenAtSeq, reason: marker.reason };
    return { entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null };
  }
  if (!ownedPrivateFile(stat)) return { entries: [], head: null, chain: 'broken', brokenAtSeq: null, reason: 'the ledger file is not a private regular file owned by this user' };

  let head: LedgerHead | null = null;
  const recent = new Map<number, string>();
  let broken: BrokenInfo | null = null;
  const handle = await openAsync(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      return { entries: [], head: null, chain: 'broken', brokenAtSeq: null, reason: 'the ledger changed while it was being opened' };
    }
    const total = Number(opened.size);
    const chunkSize = 256 * 1024;
    let carry = Buffer.alloc(0);
    let position = 0;
    let sliceStart = performance.now();
    outer: while (position < total) {
      const want = Math.min(chunkSize, total - position);
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] !== 0x0a) continue;
        const nextSeq = head ? head.seq + 1 : 0;
        const lineBytes = buffer.subarray(lineStart, i);
        lineStart = i + 1;
        if (lineBytes.length > LEDGER_MAX_LINE_BYTES) {
          broken = { brokenAtSeq: nextSeq, reason: `entry ${nextSeq} is larger than ${LEDGER_MAX_LINE_BYTES} bytes` };
          break outer;
        }
        const checked = checkLine(lineBytes.toString('utf8'), {
          seq: nextSeq,
          prevHash: head ? head.hash : LEDGER_GENESIS_PREV_HASH,
          minAt: head ? head.at : null,
        });
        if ('reason' in checked) {
          broken = { brokenAtSeq: nextSeq, reason: `entry ${nextSeq}: ${checked.reason}` };
          break outer;
        }
        head = { seq: checked.entry.seq, hash: checked.entry.hash, at: checked.entry.at };
        recent.set(head.seq, head.hash);
        if (recent.size > RECENT_HASHES) recent.delete(head.seq - RECENT_HASHES);
        push(checked.entry);
        if (performance.now() - sliceStart > READ_SLICE_MS) {
          await yieldToEventLoop();
          sliceStart = performance.now();
        }
      }
      carry = Buffer.from(buffer.subarray(lineStart));
      if (carry.length > LEDGER_MAX_LINE_BYTES + 1) {
        broken = { brokenAtSeq: head ? head.seq + 1 : 0, reason: 'unterminated oversized entry' };
        break;
      }
    }
  } finally {
    await handle.close();
  }
  if (!broken && marker) broken = marker;
  if (!broken) {
    const anchor = readAnchor();
    if (anchor.state === 'invalid') broken = { brokenAtSeq: null, reason: 'the ledger anchor is unreadable' };
    else if (anchor.state === 'ok') {
      const a = anchor.anchor;
      const currentHead = head as LedgerHead | null;
      if (!currentHead || a.seq > currentHead.seq) {
        broken = { brokenAtSeq: currentHead ? currentHead.seq + 1 : 0, reason: `the ledger is shorter than its anchor (anchor at entry ${a.seq})` };
      } else if (recent.has(a.seq) && recent.get(a.seq) !== a.hash) {
        broken = { brokenAtSeq: a.seq, reason: `entry ${a.seq} disagrees with the anchor` };
      }
    }
  }
  if (broken) return { entries: out, head, chain: 'broken', brokenAtSeq: broken.brokenAtSeq, reason: broken.reason };
  return { entries: out, head, chain: head ? 'ok' : 'empty', brokenAtSeq: null, reason: null };
}

/** Test hook: forget this process's verified state and high-water marks. */
export function resetLedgerCachesForTest(): void {
  chains.clear();
  highWater.clear();
}

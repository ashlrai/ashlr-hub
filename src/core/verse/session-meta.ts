/**
 * core/verse/session-meta.ts — per-chat organisation and read state (V3.10,
 * unit C1; wire shapes in workbench-types.ts §3).
 *
 *   <verse root>/session-meta.json   (default ~/.ashlr/verse, 0600 in 0700)
 *
 * What lives here, and why NOT in the session record:
 *   pinned / archived   the operator's filing of a chat
 *   seen                the highest turnCount the operator has looked at —
 *                       unread = session.turnCount > seen
 *   mindSeenAt          when the operator last opened Mind (the rail's dot)
 * The session record is the ENGINE's (C3 writes it on every turn); two writers
 * racing for one file would lose a turn's bookkeeping to a click on "pin".
 * This file has exactly one writer: this module, on an operator request.
 *
 * THE BASELINE. The first time this file is created, every chat that already
 * exists has been "seen" — otherwise upgrading to 3.10 would light up 260
 * unread dots for history the operator read months ago. `baselineAt` records
 * that moment, and a chat with no `seen` entry counts as read up to its
 * current turnCount when it was last touched before the baseline. Written
 * once at creation so a restart cannot move it (and silently mark newer
 * chats as read).
 *
 * SEEDING (C2 cross-unit request). The baseline alone reads `updatedAt`, and
 * `updatedAt` moves: an old 40-turn chat the operator resumes after the
 * upgrade is suddenly "touched after the baseline", its implied `seen` drops
 * to 0, and all 40 turns light up unread. So every reader of this store
 * (activity, the session-meta routes) calls `seedBaseline(sessions)` first:
 * each chat that the baseline covers and that has no entry yet gets its
 * `seen` WRITTEN as its current turnCount, once. After that, its read state
 * no longer depends on `updatedAt` at all. One write per batch, only when a
 * chat was actually seeded; steady state is a Set lookup per chat.
 *
 * HONESTY / SAFETY
 *  - READS are total: the server must boot on any file. A hand-edited entry
 *    or field that fails validation falls back to its default, one field at a
 *    time.
 *  - WRITES never land on a file this module could not read (3.10 review d7).
 *    A file that EXISTS but cannot be opened, is over the cap, is a symlink,
 *    is not JSON, is not an object, or carries a `version` other than 1 puts
 *    the store in the UNREADABLE state: reads answer from in-memory defaults,
 *    every write throws `SessionMetaUnreadableError` (503) and nothing is
 *    written, a byte-exact copy is kept as `session-meta.unreadable-<ts>.json`
 *    when the bytes can be read, and `fileState()` reports it. Before this,
 *    load() persisted a fresh empty state over such a file, silently wiping
 *    every pin, archive and the unread baseline. Only a MISSING file starts
 *    fresh. The state is re-checked on every write (and at most every
 *    UNREADABLE_RECHECK_MS for reads), so a transient EMFILE/EACCES or an
 *    operator who moves the file aside recovers without a restart.
 *  - `seen` only moves FORWARD (two windows marking the same chat cannot
 *    un-read it), and never past the session's real turnCount (the API
 *    clamps before calling in).
 *  - Bounded (VERSE_SESSION_META_MAX entries): a runaway client cannot grow
 *    the file without limit — entries for chats that no longer exist go first.
 *  - Writes are atomic 0600 (preferences.ts primitives). Spends nothing,
 *    reads no secrets, starts no process.
 */
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import {
  defaultVerseRoot,
  ensurePrivateDirectory,
  readPrivateFileCapped,
  writePrivateFileAtomic,
} from './preferences.js';
import type { VerseSessionMeta, VerseSessionMetaUpdate } from './workbench-types.js';

export const VERSE_SESSION_META_FILE = 'session-meta.json';
/** More chats than anyone keeps; past it, entries for deleted chats are pruned first. */
export const VERSE_SESSION_META_MAX = 5_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Largest unreadable file we still copy aside; past it the original is left in place (writes stay refused). */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** How long a read trusts an "unreadable" verdict before looking at the file again (writes always re-check). */
export const UNREADABLE_RECHECK_MS = 2_000;
const SESSION_ID_RE = /^[\w.-]{1,200}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

interface StoredEntry {
  pinned?: true;
  archived?: true;
  seen?: number;
}

interface StoredFile {
  version: 1;
  baselineAt: string;
  mindSeenAt: string | null;
  sessions: Record<string, StoredEntry>;
}

/** The fields of a session this module reads (so tests need no full record). */
export interface SessionMetaSubject {
  id: string;
  turnCount: number;
  updatedAt: string;
}

export interface SessionMetaStore {
  /** Effective meta (baseline applied). */
  get(session: SessionMetaSubject): VerseSessionMeta;
  /** Effective seen turnCount (baseline applied). */
  seenTurnCount(session: SessionMetaSubject): number;
  isUnread(session: SessionMetaSubject): boolean;
  isArchived(sessionId: string): boolean;
  /** Every listed session whose effective meta is not the default. */
  list(sessions: readonly SessionMetaSubject[]): Record<string, VerseSessionMeta>;
  update(session: SessionMetaSubject, patch: VerseSessionMetaUpdate, existingIds?: ReadonlySet<string>): VerseSessionMeta;
  /** Monotonic: never lowers `seen`. `turnCount` must already be clamped to the session's. */
  markSeen(session: SessionMetaSubject, turnCount: number, existingIds?: ReadonlySet<string>): VerseSessionMeta;
  mindSeenAt(): string | null;
  markMindSeen(at: string): void;
  baselineAt(): string;
  /**
   * Materialise the baseline for every listed chat it covers that has no
   * entry yet (see SEEDING). Returns how many were seeded. Never throws: a
   * failed write keeps the seeds in memory for this process.
   */
  seedBaseline(sessions: readonly SessionMetaSubject[]): number;
  /**
   * Whether the file on disk is usable. `unreadable` means reads are showing
   * defaults and every write is refused (see WRITES in the header) — a caller
   * surfacing store health reads this; nothing here spends or starts anything.
   */
  fileState(): SessionMetaFileState;
}

export type SessionMetaFileState =
  | { state: 'ok' | 'missing'; file: string }
  | { state: 'unreadable'; file: string; reason: string; archivedTo: string | null };

/**
 * The write refusal. Duck-typed like VerseServiceError (`code` + `status`), so
 * a route that forwards `status`/`code` shows the operator the real reason
 * instead of a generic 500. 503: the store is temporarily unusable, the
 * request itself was fine.
 */
export class SessionMetaUnreadableError extends Error {
  readonly code = 'VERSE_STORE_UNREADABLE' as const;
  readonly status = 503 as const;
  readonly file: string;
  readonly archivedTo: string | null;

  constructor(file: string, reason: string, archivedTo: string | null) {
    super(
      `${file} ${reason}; nothing was written so the pins, archives and read state in it are kept. `
        + (archivedTo ? `A copy is at ${archivedTo}. ` : '')
        + 'Fix or move the file aside to start fresh.',
    );
    this.name = 'SessionMetaUnreadableError';
    this.file = file;
    this.archivedTo = archivedTo;
  }
}

type FileRead =
  | { kind: 'missing' }
  | { kind: 'ok'; parsed: Record<string, unknown> }
  | { kind: 'unreadable'; reason: string; fingerprint: string | null };

function errnoOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Classify the file without ever following a symlink at its name. Only
 * ENOENT is "missing": every other failure (EACCES, EMFILE, EIO, a
 * directory, a link) is "exists but unreadable", which the caller must not
 * write over.
 */
function readSessionMetaFile(file: string): FileRead {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', reason: `could not be inspected (${errnoOf(err) ?? 'error'})`, fingerprint: null };
  }
  const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (stat.isSymbolicLink()) return { kind: 'unreadable', reason: 'is a symlink', fingerprint: null };
  if (!stat.isFile()) return { kind: 'unreadable', reason: 'is not a regular file', fingerprint: null };
  const read = readPrivateFileCapped(file, MAX_FILE_BYTES);
  if (!read) {
    // lstat said a file is there, so null is an open/read error — or it was
    // removed in between, which the next look will see as missing.
    return { kind: 'unreadable', reason: 'could not be read', fingerprint };
  }
  if (read.truncated) return { kind: 'unreadable', reason: `is larger than ${MAX_FILE_BYTES} bytes`, fingerprint };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { kind: 'unreadable', reason: 'is not valid JSON', fingerprint };
  }
  if (!isObject(parsed)) return { kind: 'unreadable', reason: 'is not a JSON object', fingerprint };
  // A newer build's format: rewriting it as v1 would drop whatever it added.
  if ('version' in parsed && parsed['version'] !== 1) {
    return { kind: 'unreadable', reason: 'has an unknown version', fingerprint };
  }
  // A `sessions` that is not a map would parse to "no pins at all" and the
  // next write would make that permanent.
  if ('sessions' in parsed && !isObject(parsed['sessions'])) {
    return { kind: 'unreadable', reason: 'has a malformed sessions map', fingerprint };
  }
  return { kind: 'ok', parsed };
}

/**
 * Byte-exact private copy of an unreadable file beside it. Null when the
 * bytes cannot be read (the original is then the only copy — which is why
 * writes stay refused rather than starting fresh). Never throws.
 */
function archiveUnreadableCopy(file: string, stamp: number): string | null {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let src: number;
  try {
    src = openSync(file, fsConstants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  let bytes: Buffer;
  try {
    const stat = fstatSync(src);
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) return null;
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(src, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== bytes.length) return null;
  } catch {
    return null;
  } finally {
    closeSync(src);
  }
  const iso = new Date(stamp).toISOString().replace(/[:.]/g, '-');
  const target = file.replace(/\.json$/, '') + `.unreadable-${iso}.json`;
  let out: number;
  try {
    // O_EXCL: two archivings in the same millisecond never clobber each other.
    out = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  } catch {
    return null;
  }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(out, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) throw new Error('archive write made no progress');
      offset += n;
    }
    fsyncSync(out);
    return target;
  } catch {
    // A half-written copy would look like a real archive later.
    const fd = out;
    out = -1;
    try { closeSync(fd); } catch { /* already closed */ }
    try { rmSync(target, { force: true }); } catch { /* best effort */ }
    return null;
  } finally {
    if (out >= 0) {
      try { closeSync(out); } catch { /* never throws */ }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Total parse: anything unreadable becomes the default for that field only. */
export function parseSessionMetaFile(raw: unknown, fallbackBaseline: string): StoredFile {
  const out: StoredFile = { version: 1, baselineAt: fallbackBaseline, mindSeenAt: null, sessions: {} };
  if (!isObject(raw)) return out;
  if (isIso(raw['baselineAt'])) out.baselineAt = raw['baselineAt'];
  if (isIso(raw['mindSeenAt'])) out.mindSeenAt = raw['mindSeenAt'];
  const sessions = raw['sessions'];
  if (!isObject(sessions)) return out;
  let kept = 0;
  for (const [id, value] of Object.entries(sessions)) {
    if (kept >= VERSE_SESSION_META_MAX) break;
    if (!SESSION_ID_RE.test(id) || !isObject(value)) continue;
    const entry: StoredEntry = {};
    if (value['pinned'] === true) entry.pinned = true;
    if (value['archived'] === true) entry.archived = true;
    const seen = value['seen'];
    if (typeof seen === 'number' && Number.isInteger(seen) && seen >= 0 && seen <= 1_000_000) entry.seen = seen;
    if (Object.keys(entry).length === 0) continue;
    out.sessions[id] = entry;
    kept += 1;
  }
  return out;
}

export interface SessionMetaStoreOptions {
  /** Verse store root; default ~/.ashlr/verse, resolved at creation (tests relocate HOME first). */
  root?: string;
  now?: () => number;
}

export function createSessionMetaStore(options: SessionMetaStoreOptions = {}): SessionMetaStore {
  const root = options.root ?? defaultVerseRoot();
  const now = options.now ?? Date.now;
  const file = join(root, VERSE_SESSION_META_FILE);
  let state: StoredFile | null = null;
  /**
   * Set while the file exists but cannot be used (see WRITES in the header).
   * `fallback` is what reads answer meanwhile — its baseline is fixed at the
   * first detection so repeated re-checks do not keep moving it.
   */
  let damage: { reason: string; archivedTo: string | null; checkedAt: number; fallback: StoredFile } | null = null;
  /** Archives already made, by file identity (ino:size:mtime), so a re-check never copies the same bytes twice. */
  const archived = new Map<string, string | null>();
  let lastKind: 'ok' | 'missing' = 'ok';
  /** Chats already considered by seedBaseline in this process (seeded or not coverable). */
  const considered = new Set<string>();

  function persist(next: StoredFile): void {
    ensurePrivateDirectory(root);
    writePrivateFileAtomic(file, `${JSON.stringify(next)}\n`);
  }

  function fresh(): StoredFile {
    return { version: 1, baselineAt: new Date(now()).toISOString(), mindSeenAt: null, sessions: {} };
  }

  /** Look at the file again and settle `state` or `damage`. */
  function inspect(): StoredFile {
    const read = readSessionMetaFile(file);
    if (read.kind === 'ok') {
      damage = null;
      lastKind = 'ok';
      state = parseSessionMetaFile(read.parsed, new Date(now()).toISOString());
      return state;
    }
    if (read.kind === 'missing') {
      damage = null;
      // First run: fix the baseline NOW and write it, so a restart before the
      // first click cannot move it forward. Nothing was there to lose.
      state = fresh();
      try {
        persist(state);
        lastKind = 'ok';
      } catch {
        lastKind = 'missing'; /* read-only HOME: keep the in-memory baseline for this process */
      }
      return state;
    }
    let archivedTo: string | null = null;
    if (read.fingerprint) {
      if (archived.has(read.fingerprint)) archivedTo = archived.get(read.fingerprint) ?? null;
      else {
        archivedTo = archiveUnreadableCopy(file, now());
        archived.set(read.fingerprint, archivedTo);
      }
    }
    damage = { reason: read.reason, archivedTo, checkedAt: now(), fallback: damage?.fallback ?? fresh() };
    return damage.fallback;
  }

  /** For reads: total, never throws, never writes over an unreadable file. */
  function load(): StoredFile {
    if (state) return state;
    if (damage && now() - damage.checkedAt < UNREADABLE_RECHECK_MS) return damage.fallback;
    return inspect();
  }

  /** For writes: the state to build on, or a refusal — never defaults standing in for an unreadable file. */
  function loadForWrite(): StoredFile {
    const s = state ?? inspect();
    if (damage) throw new SessionMetaUnreadableError(file, damage.reason, damage.archivedTo);
    return s;
  }

  function baselineSeen(session: SessionMetaSubject, s: StoredFile): number {
    const updated = Date.parse(session.updatedAt);
    const baseline = Date.parse(s.baselineAt);
    // Touched at or before the baseline: history the operator already had.
    return Number.isFinite(updated) && updated <= baseline ? Math.max(0, session.turnCount) : 0;
  }

  function effective(session: SessionMetaSubject): VerseSessionMeta {
    const s = load();
    const entry = s.sessions[session.id];
    const seen = entry?.seen ?? baselineSeen(session, s);
    return {
      sessionId: session.id,
      pinned: entry?.pinned === true,
      archived: entry?.archived === true,
      seenTurnCount: seen,
    };
  }

  function prune(s: StoredFile, keep: string, existingIds?: ReadonlySet<string>): void {
    const ids = Object.keys(s.sessions);
    if (ids.length <= VERSE_SESSION_META_MAX) return;
    // Deleted chats first, then the oldest-inserted (object key order).
    const order = existingIds ? [...ids.filter((id) => !existingIds.has(id)), ...ids.filter((id) => existingIds.has(id))] : ids;
    for (const id of order) {
      if (Object.keys(s.sessions).length <= VERSE_SESSION_META_MAX) break;
      if (id !== keep) delete s.sessions[id];
    }
  }

  function write(session: SessionMetaSubject, entry: StoredEntry, existingIds?: ReadonlySet<string>): VerseSessionMeta {
    const s = loadForWrite();
    const next: StoredFile = { ...s, sessions: { ...s.sessions } };
    const clean: StoredEntry = {};
    if (entry.pinned) clean.pinned = true;
    if (entry.archived) clean.archived = true;
    if (typeof entry.seen === 'number') clean.seen = entry.seen;
    if (Object.keys(clean).length === 0) delete next.sessions[session.id];
    else next.sessions[session.id] = clean;
    prune(next, session.id, existingIds);
    // Persist BEFORE adopting: a failed write must not leave memory claiming
    // a pin the next process will not see.
    persist(next);
    state = next;
    return effective(session);
  }

  return {
    get: effective,
    seenTurnCount: (session) => effective(session).seenTurnCount,
    isUnread(session) {
      return session.turnCount > effective(session).seenTurnCount;
    },
    isArchived(sessionId) {
      return load().sessions[sessionId]?.archived === true;
    },
    list(sessions) {
      const out: Record<string, VerseSessionMeta> = {};
      for (const session of sessions) {
        const meta = effective(session);
        if (meta.pinned || meta.archived || meta.seenTurnCount > 0) out[session.id] = meta;
      }
      return out;
    },
    update(session, patch, existingIds) {
      const s = loadForWrite();
      const current: StoredEntry = { ...(s.sessions[session.id] ?? {}) };
      // Materialise the baseline into the entry: once a chat has an entry,
      // its read state must not depend on the baseline any more.
      if (current.seen === undefined) {
        const base = baselineSeen(session, s);
        if (base > 0) current.seen = base;
      }
      if (patch.pinned !== undefined) current.pinned = patch.pinned ? true : undefined;
      if (patch.archived !== undefined) current.archived = patch.archived ? true : undefined;
      return write(session, current, existingIds);
    },
    markSeen(session, turnCount, existingIds) {
      const s = loadForWrite();
      const current: StoredEntry = { ...(s.sessions[session.id] ?? {}) };
      const was = current.seen ?? baselineSeen(session, s);
      const target = Math.max(0, Math.trunc(turnCount));
      if (target <= was && current.seen !== undefined) return effective(session);
      current.seen = Math.max(was, target);
      return write(session, current, existingIds);
    },
    mindSeenAt: () => load().mindSeenAt,
    markMindSeen(at) {
      if (!isIso(at)) return;
      const s = loadForWrite();
      if (s.mindSeenAt && Date.parse(s.mindSeenAt) >= Date.parse(at)) return;
      const next = { ...s, mindSeenAt: at };
      persist(next);
      state = next;
    },
    baselineAt: () => load().baselineAt,
    seedBaseline(sessions) {
      const s = load();
      // Seeding is a write: over an unreadable file it would replace the real
      // seen marks with baseline guesses. Reads keep using the implied
      // baseline until the file is readable again.
      if (damage) return 0;
      let seeded: Record<string, StoredEntry> | null = null;
      let room = VERSE_SESSION_META_MAX - Object.keys(s.sessions).length;
      for (const session of sessions) {
        if (considered.has(session.id)) continue;
        // Only a chat seen whole can be ruled on for good: an entry, or a
        // chat the baseline does not cover (touched after it), never changes
        // answer later — a covered one is seeded now or never.
        considered.add(session.id);
        if (!SESSION_ID_RE.test(session.id) || s.sessions[session.id]) continue;
        const base = baselineSeen(session, s);
        if (base <= 0) continue;
        if (room <= 0) {
          // The bound holds; the implied baseline still covers the rest, and
          // this chat is looked at again once pruning frees room.
          considered.delete(session.id);
          break;
        }
        seeded ??= { ...s.sessions };
        seeded[session.id] = { seen: base };
        room -= 1;
      }
      if (!seeded) return 0;
      const next: StoredFile = { ...s, sessions: seeded };
      const count = Object.keys(seeded).length - Object.keys(s.sessions).length;
      try {
        persist(next);
      } catch {
        /* read-only HOME: adopt in memory so this process still reads them right */
      }
      state = next;
      return count;
    },
    fileState() {
      load();
      if (damage) return { state: 'unreadable', file, reason: damage.reason, archivedTo: damage.archivedTo };
      return { state: lastKind, file };
    },
  };
}

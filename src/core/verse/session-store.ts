/**
 * Verse durable session store.
 *
 *   <root>/sessions/<id>.json                  session record (atomic temp + rename)
 *   <root>/sessions/<id>.events.jsonl          VerseEvent lines, seq from 1 (appended; rewritten
 *                                              atomically only by `compactEvents`)
 *   <root>/sessions/<id>.events.archive.jsonl  whole turns moved out of the hot log at the cap
 *   <root>/sessions/<id>.launch.json           PRIVATE seat launch (launcher argv, ollama url) — 0600, never exported
 *
 * The directory is created 0700 and every file is 0600. Records are loaded
 * lazily and kept in an in-memory index.
 *
 * EVENT LOG (V3.10)
 *  - A per-session seq → byte-offset index is kept in memory (LRU-bounded)
 *    and extended by every append, so a resume (`readEvents(id, afterSeq)`,
 *    the SSE `?after=` / Last-Event-ID path) parses only the tail instead of
 *    the whole file. A cold index is built by reading each line's `{"seq":N,`
 *    prefix; lines are JSON-parsed lazily, only when asked for. The index is
 *    revalidated against the file's (ino, size) on every access, so a second
 *    store instance, or a hand edit, is noticed and the index rebuilt.
 *  - TRANSIENT event types are never persisted (appendEvent refuses them; a
 *    stray line is dropped on read).
 *  - `compactEvents` runs at turn end (engine): streamed `text-delta` runs
 *    that a complete `assistant-message` supersedes are dropped, and runs
 *    that end any other way are merged into one delta — exactly what the
 *    transcript renders, so a reload looks the same with ~95% fewer lines.
 *    When the log passes VERSE_MAX_EVENTS_PER_SESSION, whole turns are moved
 *    to the archive file and a persisted `history-truncated` marker heads the
 *    log. Never mid-turn (unless a single turn alone exceeds the cap).
 *  - A log that is still over the cap on read (written by an older release,
 *    never compacted) is cut the same way, at a turn boundary, with a
 *    synthesized marker; the file itself is left alone.
 *  - Folded / truncated logs have seq GAPS. Seq stays strictly increasing
 *    and unique, which is all a resume cursor needs.
 *
 * Writes here deliberately use a small local atomic writer (O_EXCL temp,
 * fchmod 0600, fsync, rename) rather than util/private-file-write.ts, whose
 * macOS ACL assurance shells out on every call — too heavy for a store that
 * is written on every turn of a live chat.
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  VERSE_CONTEXT_MODES,
  VERSE_MAX_EVENTS_PER_SESSION,
  VERSE_TRANSIENT_EVENT_TYPES,
  type VerseEvent,
  type VerseSession,
  type VerseWindowSource,
} from './types.js';

/**
 * An event before `seq`/`at` are stamped. Distributive, so each member of the
 * union keeps its own fields (plain `Omit` on a union collapses it to the
 * common keys and rejects `{ type: 'user-message', text }`).
 */
type Unstamped<T> = T extends unknown ? Omit<T, 'seq' | 'at'> : never;
export type VerseUnstampedEvent = Unstamped<VerseEvent>;

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_SUFFIX = '.json';
const EVENTS_SUFFIX = '.events.jsonl';
const LAUNCH_SUFFIX = '.launch.json';
const ARCHIVE_SUFFIX = '.events.archive.jsonl';

/** Sessions whose seq index is held in memory at once (LRU). */
export const VERSE_EVENT_INDEX_CACHE_MAX = 32;
/**
 * Append descriptors kept open at once (LRU). Opening + closing the log per
 * event cost ~0.5–1.5 ms on macOS (measured, with endpoint security active)
 * — 200 streamed deltas a turn made that the dominant server cost of a live
 * chat. A cached O_APPEND fd writes in ~0.07 ms.
 */
export const VERSE_APPEND_FD_CACHE_MAX = 8;
/**
 * When compaction trims a log that passed the cap, it keeps at most this
 * fraction of the cap, so the next few turns do not each rewrite the file.
 */
export const VERSE_HISTORY_KEEP_RATIO = 0.75;

const VERSE_STATUSES = new Set(['idle', 'running', 'error']);
const VERSE_ENGINES = new Set(['claude', 'codex', 'grok', 'local']);
const VERSE_CONTEXT_MODE_SET = new Set<string>(VERSE_CONTEXT_MODES);
/** Mirrors `VerseWindowSource` in types.ts — the store is the gate that keeps a hand-edited record honest. */
const VERSE_WINDOW_SOURCES = new Set(['runtime', 'provider-catalog', 'cli-catalog', 'documented', 'fallback']);

/**
 * The one list of window sources a record may carry. Exported so a writer can
 * refuse an unknown source BEFORE saving it: a record with one fails `isSession`
 * on the next read and would silently vanish from the store.
 */
export function isVerseWindowSource(value: unknown): value is VerseWindowSource {
  return typeof value === 'string' && VERSE_WINDOW_SOURCES.has(value);
}
const VERSE_COMPACTION_TRIGGERS = new Set(['auto', 'manual']);
const VERSE_RECOVERY_HOWS = new Set(['new-native-session', 'handoff']);

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

function assertSessionId(id: string): void {
  if (!isValidSessionId(id)) throw new Error(`invalid verse session id: ${JSON.stringify(id)}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * An optional field is valid when it is ABSENT or of the right type.
 *
 * This is the backward-compatibility hinge: every session record written
 * before workspaces existed has none of these keys, so each check has to pass
 * on `undefined` or the record would stop loading and the chat history behind
 * it would disappear from the sidebar.
 */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArrayValue(value);
}

function isStringArrayValue(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isOptionalNullableNumber(value: unknown): boolean {
  return value === undefined || isNullableNumber(value);
}

/**
 * V3.9 usage fields. Each is optional (absent on every record written before
 * context orchestration) but, when PRESENT, must be exactly the documented
 * shape: a record claiming `contextWindowSource: 'guess'` or a string
 * `autoCompactAt` is corrupt, and a corrupt record is skipped rather than
 * drawn with numbers nobody can vouch for.
 */
function isV39UsageValid(usage: Record<string, unknown>): boolean {
  const source = usage['contextWindowSource'];
  return (source === undefined || (typeof source === 'string' && VERSE_WINDOW_SOURCES.has(source)))
    && isOptionalNullableNumber(usage['autoCompactAt'])
    && isOptionalBoolean(usage['contextTokensExact']);
}

/** V3.9 session fields — same absent-or-exact rule as the usage fields above. */
function isV39SessionValid(value: Record<string, unknown>): boolean {
  const mode = value['contextMode'];
  const count = value['compactionCount'];
  const handoff = value['handoffFrom'];
  return (mode === undefined || (typeof mode === 'string' && VERSE_CONTEXT_MODE_SET.has(mode)))
    && (count === undefined || (isFiniteNumber(count) && count >= 0 && Number.isInteger(count)))
    && (handoff === undefined
      || (isObject(handoff)
        && typeof handoff['sessionId'] === 'string' && handoff['sessionId'].length > 0
        && typeof handoff['title'] === 'string'))
    && isOptionalBoolean(value['memoryEnabled']);
}

function isSession(value: unknown): value is VerseSession {
  if (!isObject(value)) return false;
  const usage = value['usage'];
  return typeof value['id'] === 'string' && isValidSessionId(value['id'])
    && typeof value['title'] === 'string'
    && typeof value['projectPath'] === 'string'
    && isOptionalStringArray(value['extraRoots'])
    && isOptionalString(value['workspaceId'])
    && isOptionalString(value['workspaceName'])
    && typeof value['engine'] === 'string' && VERSE_ENGINES.has(value['engine'])
    && typeof value['accountId'] === 'string'
    && typeof value['seatId'] === 'string'
    && typeof value['model'] === 'string'
    && (value['nativeSessionId'] === null || typeof value['nativeSessionId'] === 'string')
    && typeof value['createdAt'] === 'string'
    && typeof value['updatedAt'] === 'string'
    && typeof value['status'] === 'string' && VERSE_STATUSES.has(value['status'])
    && isFiniteNumber(value['turnCount'])
    && isObject(usage)
    && isFiniteNumber(usage['inputTokens'])
    && isFiniteNumber(usage['outputTokens'])
    && isFiniteNumber(usage['cacheReadTokens'])
    && isFiniteNumber(usage['cacheCreationTokens'])
    && isFiniteNumber(usage['contextTokens'])
    && (usage['contextWindow'] === null || isFiniteNumber(usage['contextWindow']))
    && isV39UsageValid(usage)
    && (value['lastError'] === null || typeof value['lastError'] === 'string')
    && isV39SessionValid(value);
}

/**
 * Event shape check. The historical types stay LENIENT (seq/at/type only):
 * tightening them now would silently drop lines from logs written by every
 * earlier release. The two V3.9 types are checked in full, because their
 * numbers feed the meter and the compaction count directly — a malformed line
 * is dropped like any other garbage line rather than drawn. The V3.10
 * persisted types are checked in full for the same reason; a TRANSIENT type
 * on disk is invalid by definition (it was never meant to replay).
 */
function isEvent(value: unknown): value is VerseEvent {
  if (!isObject(value)
    || !isFiniteNumber(value['seq'])
    || typeof value['at'] !== 'string'
    || typeof value['type'] !== 'string') return false;
  const turnId = value['turnId'];
  if (VERSE_TRANSIENT_EVENT_TYPES.has(value['type'] as VerseEvent['type'])) return false;
  switch (value['type']) {
    case 'history-truncated':
      return turnId === null && isFiniteNumber(value['droppedBefore']);
    case 'recovered':
      return (turnId === null || typeof turnId === 'string')
        && typeof value['how'] === 'string' && VERSE_RECOVERY_HOWS.has(value['how'])
        && typeof value['message'] === 'string';
    case 'compaction':
      return (turnId === null || typeof turnId === 'string')
        && typeof value['trigger'] === 'string' && VERSE_COMPACTION_TRIGGERS.has(value['trigger'])
        && isNullableNumber(value['preTokens'])
        && isNullableNumber(value['postTokens'])
        && isNullableNumber(value['durationMs']);
    case 'context':
      return (turnId === null || typeof turnId === 'string')
        && isFiniteNumber(value['contextTokens']) && value['contextTokens'] >= 0
        && isNullableNumber(value['contextWindow'])
        && typeof value['exact'] === 'boolean'
        && isOptionalNullableNumber(value['autoCompactAt']);
    default:
      return true;
  }
}


function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeAllSync(fd: number, bytes: Buffer, position: number | null): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, position === null ? null : position + offset);
    if (written <= 0) throw new Error('verse store write made no progress');
    offset += written;
  }
}

/** Create-exclusive temp file, write, fsync, chmod 0600, rename over target. */
function writeAtomically(target: string, content: string | Buffer): void {
  const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let published = false;
  try {
    writeAllSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content, 0);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    renameSync(temp, target);
    published = true;
  } finally {
    closeSync(fd);
    if (!published) {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * The store's atomic private writer, for sibling Verse state files
 * (process-registry's running.json) that are rewritten often and must never
 * be observed half-written. Creates `dir` 0700 when missing.
 */
export function writePrivateFileAtomically(dir: string, target: string, content: string): void {
  ensurePrivateDir(dir);
  writeAtomically(target, content);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure log transforms (exported for tests and for the engine's equivalence
// checks). Neither ever reorders or renumbers an event.
// ---------------------------------------------------------------------------

/**
 * Event types that END the provisional streamed bubble in the transcript
 * (web-ui verse-store.ts buildTranscript calls `flushPending` for exactly
 * these). Every other persisted type — usage, context, compaction,
 * turn-started, tool-result, recovered, history-truncated — leaves the
 * bubble open and accumulating. `text-delta` (another turn's delta flushes)
 * and `assistant-message` (supersedes) are handled explicitly.
 *
 * CONTRACT with the client: this set must equal the client's flush set. The
 * randomized render-equivalence test in test/verse-session-store.test.ts
 * renders folded and raw logs with the client's own buildTranscript and fails
 * the moment they diverge.
 */
const FOLD_FLUSH_TYPES = new Set<VerseEvent['type']>(['user-message', 'thinking', 'tool-use', 'error', 'cancelled', 'turn-done']);

type TextDelta = Extract<VerseEvent, { type: 'text-delta' }>;

/**
 * Fold streamed `text-delta` runs the way the transcript renders them:
 *  - a run followed (across only non-flushing events) by an
 *    `assistant-message` is DROPPED — the complete message replaces the
 *    provisional bubble;
 *  - a run ended any other way (tool use, thinking, error, cancel, turn end,
 *    a delta of another turn, end of log) is MERGED into its first delta,
 *    which keeps that delta's seq/at (so the bubble's key and time are
 *    unchanged) and carries the concatenated text.
 * Returns the input array itself when nothing changes.
 */
export function foldTextDeltas(events: readonly VerseEvent[]): readonly VerseEvent[] {
  const out: (VerseEvent | null)[] = [];
  /**
   * `sealsPrevious`: this run began while another turn's run was still open,
   * so its first delta is what ENDS that earlier bubble in the transcript.
   * Such a run is merged rather than dropped even when a message supersedes
   * it — dropping it would glue the earlier bubble onto the message.
   */
  let run: { index: number; first: TextDelta; parts: string[]; sealsPrevious: boolean } | null = null;
  let changed = false;

  const closeRun = (): void => {
    if (!run) return;
    if (run.parts.length > 1) {
      out[run.index] = { ...run.first, text: run.parts.join('') };
      changed = true;
    }
    run = null;
  };

  for (const event of events) {
    if (event.type === 'text-delta') {
      if (run && run.first.turnId === event.turnId) {
        run.parts.push(event.text);
        continue;
      }
      const sealsPrevious: boolean = run !== null;
      closeRun();
      run = { index: out.length, first: event, parts: [event.text], sealsPrevious };
      out.push(event);
      continue;
    }
    if (event.type === 'assistant-message') {
      // The client discards its provisional bubble here either way.
      if (run && !run.sealsPrevious) {
        out[run.index] = null;
        run = null;
        changed = true;
      } else {
        closeRun();
      }
      out.push(event);
      continue;
    }
    if (FOLD_FLUSH_TYPES.has(event.type)) closeRun();
    out.push(event);
  }
  closeRun();
  if (!changed) return events;
  return out.filter((event): event is VerseEvent => event !== null);
}

/**
 * Keep at most `limit` events, starting at a TURN boundary (a `user-message`),
 * headed by a `history-truncated` marker whose `droppedBefore` is the first
 * kept seq. The marker takes `firstKept.seq - 1` — a seq that belonged to a
 * dropped (or folded-away) event, so it stays unique and in order.
 *
 * Boundary search prefers keeping ≤ `limit - 1` events (room for the marker);
 * a single turn longer than that is cut where it must be — the one case the
 * cap cannot honour a boundary. Returns null when nothing needs dropping.
 */
export function truncateAtTurnBoundary(
  events: readonly VerseEvent[],
  limit: number,
): { kept: VerseEvent[]; dropped: VerseEvent[] } | null {
  const body = events.filter((event) => event.type !== 'history-truncated');
  if (events.length <= limit && body.length === events.length) return null;
  if (body.length <= Math.max(1, limit - 1)) return null;
  const minStart = body.length - Math.max(1, limit - 1);
  let start = -1;
  for (let i = minStart; i < body.length; i += 1) {
    if (body[i].type === 'user-message') { start = i; break; }
  }
  if (start <= 0) start = Math.max(1, minStart);
  const kept = body.slice(start);
  const first = kept[0];
  const marker: VerseEvent = {
    seq: first.seq - 1,
    at: first.at,
    type: 'history-truncated',
    turnId: null,
    droppedBefore: first.seq,
  };
  return { kept: [marker, ...kept], dropped: body.slice(0, start) };
}

// ---------------------------------------------------------------------------
// Seq → byte-offset index
// ---------------------------------------------------------------------------

/** Our writer always serialises `seq` first, so a line's seq is readable without JSON.parse. */
const SEQ_PREFIX_RE = /^\{"seq":(\d{1,15}),/;
const SEQ_PREFIX_PROBE_BYTES = 32;

interface LogIndex {
  ino: number;
  /** Bytes of the file this index describes. */
  size: number;
  endsWithNewline: boolean;
  /** Per candidate line, in file order. */
  seqs: number[];
  offsets: number[];
  /** Byte length of the line, excluding its newline. */
  lengths: number[];
  /** undefined = not parsed yet; null = the line turned out invalid. */
  events: (VerseEvent | null | undefined)[];
  /** seqs strictly increasing — binary search is valid. */
  monotonic: boolean;
  /** Non-empty lines that are not events (garbage, torn writes); a compaction drops them. */
  garbage: number;
}

function buildIndex(buf: Buffer, ino: number): LogIndex {
  const index: LogIndex = {
    ino,
    size: buf.length,
    endsWithNewline: buf.length === 0 || buf[buf.length - 1] === 0x0a,
    seqs: [],
    offsets: [],
    lengths: [],
    events: [],
    monotonic: true,
    garbage: 0,
  };
  let pos = 0;
  while (pos < buf.length) {
    let end = buf.indexOf(0x0a, pos);
    if (end === -1) end = buf.length;
    if (end > pos) {
      const probe = buf.toString('utf8', pos, Math.min(end, pos + SEQ_PREFIX_PROBE_BYTES));
      const m = SEQ_PREFIX_RE.exec(probe);
      let seq: number | null = m ? Number(m[1]) : null;
      let event: VerseEvent | undefined;
      if (seq === null) {
        // Not our writer's shape (hand-written, an older/foreign writer, or
        // garbage): parse now to learn its seq, or skip it.
        try {
          const parsed = JSON.parse(buf.toString('utf8', pos, end)) as unknown;
          if (isEvent(parsed)) { seq = parsed.seq; event = parsed; }
        } catch { /* garbage line */ }
      }
      if (seq !== null) {
        const last = index.seqs.length > 0 ? index.seqs[index.seqs.length - 1] : -Infinity;
        if (!(seq > last)) index.monotonic = false;
        index.seqs.push(seq);
        index.offsets.push(pos);
        index.lengths.push(end - pos);
        index.events.push(event);
      } else if (buf.subarray(pos, end).toString('utf8').trim()) {
        index.garbage += 1;
      }
    }
    pos = end + 1;
  }
  return index;
}

/** First index whose seq is > `seq` (seqs must be monotonic). */
function upperBound(seqs: readonly number[], seq: number): number {
  let lo = 0;
  let hi = seqs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (seqs[mid] <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function serializeEvents(events: readonly VerseEvent[]): string {
  let out = '';
  for (const event of events) out += `${JSON.stringify(event)}\n`;
  return out;
}

export interface VerseCompactionResult {
  /** The hot log was rewritten. */
  changed: boolean;
  eventsBefore: number;
  eventsAfter: number;
  /** Events moved to the archive file because the log passed the cap. */
  archived: number;
}

export interface VerseSessionStore {
  readonly root: string;
  readonly sessionsDir: string;
  /** All known sessions (lazy directory scan on first call). */
  list(): VerseSession[];
  get(id: string): VerseSession | null;
  has(id: string): boolean;
  /** Atomic write of the session record; updates the index. */
  save(session: VerseSession): void;
  /** Stamp seq/at and append one PERSISTED event line. Returns the stored event. Throws for a transient type. */
  appendEvent(id: string, event: VerseUnstampedEvent, at: string): VerseEvent;
  /**
   * Events with `seq > fromSeq`. A log over VERSE_MAX_EVENTS_PER_SESSION is
   * cut at a turn boundary behind a `history-truncated` marker.
   */
  readEvents(id: string, fromSeq?: number): VerseEvent[];
  /** Highest seq appended so far (0 when none). */
  lastSeq(id: string): number;
  /**
   * Fold delta runs and, past the cap, archive whole turns (see header).
   * Atomic rewrite; a no-op (no write) when nothing would change. Throws on
   * I/O failure — the log is then exactly as it was.
   */
  compactEvents(id: string, opts?: { cap?: number }): VerseCompactionResult;
  /** Private launch record — 0600, never leaves the process. */
  saveLaunch(id: string, launch: unknown): void;
  loadLaunch(id: string): unknown;
  /** Remove the session record, its events, its archive and its launch file. */
  remove(id: string): void;
  /** Close cached append descriptors. The store stays usable (they reopen on demand). */
  close(): void;
}

export function createVerseSessionStore(root: string): VerseSessionStore {
  const sessionsDir = join(root, 'sessions');
  const index = new Map<string, VerseSession>();
  const seqs = new Map<string, number>();
  const logIndexes = new Map<string, LogIndex>();
  const appendFds = new Map<string, { fd: number; ino: number }>();
  let scanned = false;

  function sessionPath(id: string): string { return join(sessionsDir, `${id}${SESSION_SUFFIX}`); }
  function eventsPath(id: string): string { return join(sessionsDir, `${id}${EVENTS_SUFFIX}`); }
  function archivePath(id: string): string { return join(sessionsDir, `${id}${ARCHIVE_SUFFIX}`); }
  function launchPath(id: string): string { return join(sessionsDir, `${id}${LAUNCH_SUFFIX}`); }

  function ensureDirs(): void {
    ensurePrivateDir(root);
    ensurePrivateDir(sessionsDir);
  }

  function loadOne(id: string): VerseSession | null {
    const cached = index.get(id);
    if (cached) return cached;
    const path = sessionPath(id);
    if (!existsSync(path)) return null;
    const parsed = readJsonFile(path);
    if (!isSession(parsed) || parsed.id !== id) return null;
    index.set(id, parsed);
    return parsed;
  }

  function scan(): void {
    if (scanned) return;
    scanned = true;
    if (!existsSync(sessionsDir)) return;
    let names: string[] = [];
    try { names = readdirSync(sessionsDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(SESSION_SUFFIX) || name.endsWith(LAUNCH_SUFFIX)) continue;
      const id = name.slice(0, -SESSION_SUFFIX.length);
      if (!isValidSessionId(id)) continue;
      loadOne(id);
    }
  }

  function remember(id: string, log: LogIndex): LogIndex {
    logIndexes.delete(id);
    logIndexes.set(id, log);
    while (logIndexes.size > VERSE_EVENT_INDEX_CACHE_MAX) {
      const oldest = logIndexes.keys().next().value;
      if (oldest === undefined) break;
      logIndexes.delete(oldest);
    }
    return log;
  }

  /**
   * The session's index, revalidated against the file. Null when there is no
   * readable events file. A size or inode the index did not produce itself
   * (another store instance appended, the file was replaced or hand-edited)
   * rebuilds it from disk.
   */
  function logIndexFor(id: string): LogIndex | null {
    const path = eventsPath(id);
    let st: { ino: number; size: number };
    try { st = statSync(path); } catch { logIndexes.delete(id); return null; }
    const cached = logIndexes.get(id);
    if (cached && cached.ino === st.ino && cached.size === st.size) return remember(id, cached);
    let buf: Buffer;
    try { buf = readFileSync(path); } catch { logIndexes.delete(id); return null; }
    return remember(id, buildIndex(buf, st.ino));
  }

  /** Parse the not-yet-parsed lines in [from, to). Reads only their byte range. */
  function ensureParsed(id: string, log: LogIndex, from: number, to: number): void {
    let first = -1;
    for (let i = from; i < to; i += 1) {
      if (log.events[i] === undefined) { first = i; break; }
    }
    if (first === -1) return;
    let last = first;
    for (let i = to - 1; i > first; i -= 1) {
      if (log.events[i] === undefined) { last = i; break; }
    }
    const start = log.offsets[first];
    const end = log.offsets[last] + log.lengths[last];
    let buf: Buffer;
    try {
      const fd = openSync(eventsPath(id), fsConstants.O_RDONLY);
      try {
        buf = Buffer.alloc(end - start);
        let read = 0;
        while (read < buf.length) {
          const n = readSync(fd, buf, read, buf.length - read, start + read);
          if (n <= 0) break;
          read += n;
        }
        if (read < buf.length) buf = buf.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    } catch {
      for (let i = first; i <= last; i += 1) if (log.events[i] === undefined) log.events[i] = null;
      return;
    }
    for (let i = first; i <= last; i += 1) {
      if (log.events[i] !== undefined) continue;
      const lineStart = log.offsets[i] - start;
      const lineEnd = lineStart + log.lengths[i];
      if (lineEnd > buf.length) { log.events[i] = null; continue; }
      try {
        const parsed = JSON.parse(buf.toString('utf8', lineStart, lineEnd)) as unknown;
        log.events[i] = isEvent(parsed) && parsed.seq === log.seqs[i] ? parsed : null;
      } catch {
        log.events[i] = null;
      }
    }
  }

  function collect(log: LogIndex, from: number, to: number): VerseEvent[] {
    const out: VerseEvent[] = [];
    for (let i = from; i < to; i += 1) {
      const event = log.events[i];
      if (event) out.push(event);
    }
    return out;
  }

  function allEvents(id: string, log: LogIndex): VerseEvent[] {
    ensureParsed(id, log, 0, log.seqs.length);
    return collect(log, 0, log.seqs.length);
  }

  function closeAppendFd(id: string): void {
    const cached = appendFds.get(id);
    if (!cached) return;
    appendFds.delete(id);
    try { closeSync(cached.fd); } catch { /* already closed */ }
  }

  /**
   * An O_APPEND descriptor for the session's log, reused across appends. It
   * is revalidated against the PATH's inode first: a compaction rename (or
   * another writer replacing the file) leaves the cached fd on the old inode,
   * where a write would silently land in an unlinked file.
   */
  function appendFdFor(id: string, path: string, pathIno: number | null): { fd: number; ino: number } {
    const cached = appendFds.get(id);
    if (cached && pathIno !== null && cached.ino === pathIno) {
      appendFds.delete(id);
      appendFds.set(id, cached);
      return cached;
    }
    closeAppendFd(id);
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
    let ino: number;
    try {
      ino = fstatSync(fd).ino;
    } catch (err) {
      try { closeSync(fd); } catch { /* ignore */ }
      throw err;
    }
    const entry = { fd, ino };
    appendFds.set(id, entry);
    while (appendFds.size > VERSE_APPEND_FD_CACHE_MAX) {
      const oldest = appendFds.keys().next().value;
      if (oldest === undefined) break;
      closeAppendFd(oldest);
    }
    return entry;
  }

  function lastSeqOf(log: LogIndex | null): number {
    if (!log || log.seqs.length === 0) return 0;
    if (log.monotonic) return log.seqs[log.seqs.length - 1];
    return Math.max(...log.seqs);
  }

  function currentSeq(id: string): number {
    const known = seqs.get(id);
    if (known !== undefined) return known;
    const last = lastSeqOf(logIndexFor(id));
    seqs.set(id, last);
    return last;
  }

  return {
    root,
    sessionsDir,

    list(): VerseSession[] {
      scan();
      return [...index.values()];
    },

    get(id: string): VerseSession | null {
      if (!isValidSessionId(id)) return null;
      return loadOne(id);
    },

    has(id: string): boolean {
      return this.get(id) !== null;
    },

    save(session: VerseSession): void {
      assertSessionId(session.id);
      ensureDirs();
      writeAtomically(sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
      index.set(session.id, session);
    },

    appendEvent(id: string, event: VerseUnstampedEvent, at: string): VerseEvent {
      assertSessionId(id);
      if (VERSE_TRANSIENT_EVENT_TYPES.has(event.type)) {
        throw new Error(`transient verse event ${event.type} is never persisted`);
      }
      ensureDirs();
      const log = logIndexFor(id);
      // The validated index is the authority when a log exists: another
      // store instance may have appended (or compacted) since our last write,
      // and a cached counter would then reissue a seq.
      const seq = (log ? Math.max(lastSeqOf(log), seqs.get(id) ?? 0) : currentSeq(id)) + 1;
      const stored = { seq, at, ...event } as VerseEvent;
      const line = JSON.stringify(stored);
      // A crash can leave a final line with no newline; appending straight
      // onto it would corrupt BOTH lines.
      const lead = log && log.size > 0 && !log.endsWithNewline ? '\n' : '';
      const bytes = Buffer.from(`${lead}${line}\n`, 'utf8');
      const handle = appendFdFor(id, eventsPath(id), log ? log.ino : null);
      let st: { ino: number; size: number };
      try {
        writeAllSync(handle.fd, bytes, null);
        st = fstatSync(handle.fd);
      } catch (err) {
        // A broken descriptor must not be reused for the next event.
        closeAppendFd(id);
        throw err;
      }
      seqs.set(id, seq);
      const lineBytes = bytes.length - Buffer.byteLength(lead, 'utf8') - 1;
      const extend = (target: LogIndex): void => {
        target.seqs.push(seq);
        target.offsets.push(st.size - lineBytes - 1);
        target.lengths.push(lineBytes);
        target.events.push(stored);
        target.size = st.size;
        target.endsWithNewline = true;
      };
      if (log && log.ino === st.ino && st.size === log.size + bytes.length) {
        if (log.seqs.length > 0 && !(seq > log.seqs[log.seqs.length - 1])) log.monotonic = false;
        extend(log);
      } else if (!log && st.size === bytes.length) {
        const fresh = buildIndex(Buffer.alloc(0), st.ino);
        extend(fresh);
        remember(id, fresh);
      } else {
        // Someone else wrote in between; the next read rebuilds from disk.
        logIndexes.delete(id);
      }
      return stored;
    },

    readEvents(id: string, fromSeq = 0): VerseEvent[] {
      if (!isValidSessionId(id)) return [];
      const log = logIndexFor(id);
      if (!log) return [];
      const n = log.seqs.length;
      if (n > VERSE_MAX_EVENTS_PER_SESSION) {
        const all = allEvents(id, log);
        const cut = truncateAtTurnBoundary(all, VERSE_MAX_EVENTS_PER_SESSION);
        const events = cut ? cut.kept : all;
        return fromSeq > 0 ? events.filter((event) => event.seq > fromSeq) : events;
      }
      if (fromSeq > 0 && log.monotonic) {
        const start = upperBound(log.seqs, fromSeq);
        ensureParsed(id, log, start, n);
        return collect(log, start, n);
      }
      const events = allEvents(id, log);
      return fromSeq > 0 ? events.filter((event) => event.seq > fromSeq) : events;
    },

    lastSeq(id: string): number {
      if (!isValidSessionId(id)) return 0;
      return currentSeq(id);
    },

    compactEvents(id: string, opts: { cap?: number } = {}): VerseCompactionResult {
      assertSessionId(id);
      const log = logIndexFor(id);
      if (!log) return { changed: false, eventsBefore: 0, eventsAfter: 0, archived: 0 };
      const cap = Math.max(2, Math.floor(opts.cap ?? VERSE_MAX_EVENTS_PER_SESSION));
      const events = allEvents(id, log);
      const garbageLines = log.garbage + (log.seqs.length - events.length);
      let next = foldTextDeltas(events);
      let dropped: VerseEvent[] = [];
      if (next.length > cap) {
        const cut = truncateAtTurnBoundary(next, Math.max(2, Math.floor(cap * VERSE_HISTORY_KEEP_RATIO)));
        if (cut) {
          next = cut.kept;
          dropped = cut.dropped;
        }
      }
      if (next === events && garbageLines === 0) {
        return { changed: false, eventsBefore: events.length, eventsAfter: events.length, archived: 0 };
      }
      if (dropped.length > 0) {
        // Archive FIRST: if this fails nothing has been removed yet.
        const archive = archivePath(id);
        appendFileSync(archive, serializeEvents(dropped), { mode: 0o600 });
      }
      const content = Buffer.from(serializeEvents(next), 'utf8');
      const path = eventsPath(id);
      closeAppendFd(id);
      writeAtomically(path, content);
      let ino = 0;
      try { ino = statSync(path).ino; } catch { /* rebuilt on next read */ }
      if (ino) remember(id, buildIndex(content, ino));
      else logIndexes.delete(id);
      // The last seq never changes: compaction keeps the newest events.
      return { changed: true, eventsBefore: events.length, eventsAfter: next.length, archived: dropped.length };
    },

    saveLaunch(id: string, launch: unknown): void {
      assertSessionId(id);
      ensureDirs();
      writeAtomically(launchPath(id), `${JSON.stringify(launch)}\n`);
    },

    loadLaunch(id: string): unknown {
      if (!isValidSessionId(id)) return null;
      const path = launchPath(id);
      if (!existsSync(path)) return null;
      try {
        // Refuse to read a launch file that became group/world readable.
        const mode = statSync(path).mode & 0o777;
        if (process.platform !== 'win32' && (mode & 0o077) !== 0) return null;
      } catch {
        return null;
      }
      return readJsonFile(path);
    },

    remove(id: string): void {
      assertSessionId(id);
      index.delete(id);
      seqs.delete(id);
      logIndexes.delete(id);
      closeAppendFd(id);
      for (const path of [sessionPath(id), eventsPath(id), archivePath(id), launchPath(id)]) {
        try { rmSync(path, { force: true }); } catch { /* best effort */ }
      }
    },

    close(): void {
      for (const id of [...appendFds.keys()]) closeAppendFd(id);
    },
  };
}

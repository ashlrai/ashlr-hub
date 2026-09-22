/**
 * Verse durable session store.
 *
 *   <root>/sessions/<id>.json          session record (atomic temp + rename)
 *   <root>/sessions/<id>.events.jsonl  append-only VerseEvent lines, seq from 1
 *   <root>/sessions/<id>.launch.json   PRIVATE seat launch (launcher argv, ollama url) — 0600, never exported
 *
 * The directory is created 0700 and every file is 0600. Records are loaded
 * lazily and kept in an in-memory index; the events file is read on demand
 * and capped at VERSE_MAX_EVENTS_PER_SESSION on read (oldest dropped, never
 * deleted from disk).
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
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  VERSE_MAX_EVENTS_PER_SESSION,
  type VerseEvent,
  type VerseSession,
} from './types.js';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_SUFFIX = '.json';
const EVENTS_SUFFIX = '.events.jsonl';
const LAUNCH_SUFFIX = '.launch.json';

const VERSE_STATUSES = new Set(['idle', 'running', 'error']);
const VERSE_ENGINES = new Set(['claude', 'codex', 'grok', 'local']);

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

function isSession(value: unknown): value is VerseSession {
  if (!isObject(value)) return false;
  const usage = value['usage'];
  return typeof value['id'] === 'string' && isValidSessionId(value['id'])
    && typeof value['title'] === 'string'
    && typeof value['projectPath'] === 'string'
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
    && (value['lastError'] === null || typeof value['lastError'] === 'string');
}

function isEvent(value: unknown): value is VerseEvent {
  return isObject(value)
    && isFiniteNumber(value['seq'])
    && typeof value['at'] === 'string'
    && typeof value['type'] === 'string';
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Create-exclusive temp file, write, fsync, chmod 0600, rename over target. */
function writeAtomically(target: string, content: string): void {
  const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let published = false;
  try {
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error('verse store write made no progress');
      offset += written;
    }
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

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
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
  /** Stamp seq/at and append one event line. Returns the stored event. */
  appendEvent(id: string, event: Omit<VerseEvent, 'seq' | 'at'>, at: string): VerseEvent;
  /** Events with `seq > fromSeq`, capped to the newest VERSE_MAX_EVENTS_PER_SESSION. */
  readEvents(id: string, fromSeq?: number): VerseEvent[];
  /** Highest seq appended so far (0 when none). */
  lastSeq(id: string): number;
  /** Private launch record — 0600, never leaves the process. */
  saveLaunch(id: string, launch: unknown): void;
  loadLaunch(id: string): unknown;
  /** Remove the session record, its events and its launch file. */
  remove(id: string): void;
}

export function createVerseSessionStore(root: string): VerseSessionStore {
  const sessionsDir = join(root, 'sessions');
  const index = new Map<string, VerseSession>();
  const seqs = new Map<string, number>();
  let scanned = false;

  function sessionPath(id: string): string { return join(sessionsDir, `${id}${SESSION_SUFFIX}`); }
  function eventsPath(id: string): string { return join(sessionsDir, `${id}${EVENTS_SUFFIX}`); }
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

  function readAllEvents(id: string): VerseEvent[] {
    const path = eventsPath(id);
    if (!existsSync(path)) return [];
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { return []; }
    const out: VerseEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (isEvent(parsed)) out.push(parsed);
    }
    return out;
  }

  function currentSeq(id: string): number {
    const known = seqs.get(id);
    if (known !== undefined) return known;
    const events = readAllEvents(id);
    const last = events.length > 0 ? events[events.length - 1].seq : 0;
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

    appendEvent(id: string, event: Omit<VerseEvent, 'seq' | 'at'>, at: string): VerseEvent {
      assertSessionId(id);
      ensureDirs();
      const seq = currentSeq(id) + 1;
      const stored = { seq, at, ...event } as VerseEvent;
      const path = eventsPath(id);
      if (!existsSync(path)) {
        // Create 0600 before the first append so the mode never depends on umask.
        closeSync(openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600));
      }
      appendFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      seqs.set(id, seq);
      return stored;
    },

    readEvents(id: string, fromSeq = 0): VerseEvent[] {
      if (!isValidSessionId(id)) return [];
      let events = readAllEvents(id);
      if (events.length > VERSE_MAX_EVENTS_PER_SESSION) {
        events = events.slice(events.length - VERSE_MAX_EVENTS_PER_SESSION);
      }
      return fromSeq > 0 ? events.filter((event) => event.seq > fromSeq) : events;
    },

    lastSeq(id: string): number {
      if (!isValidSessionId(id)) return 0;
      return currentSeq(id);
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
      for (const path of [sessionPath(id), eventsPath(id), launchPath(id)]) {
        try { rmSync(path, { force: true }); } catch { /* best effort */ }
      }
    },
  };
}

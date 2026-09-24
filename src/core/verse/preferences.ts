/**
 * Verse operator preferences — `<verse root>/preferences.json` (default
 * `~/.ashlr/verse/preferences.json`, 0600 inside a 0700 directory).
 *
 * What lives here is deliberately SMALL and STANDING: choices the operator made
 * once and expects every future session to honour.
 *
 *   seats.<seatId>.contextMode   default context mode for NEW sessions on a seat
 *   memory.enabled               shared project memory, globally (default ON)
 *   memory.disabledProjects      canonical project paths that opted out
 *
 * Nothing here is consulted by a RUNNING session. A session pins its mode and
 * whether it was offered memory at creation (session.contextMode,
 * session.memoryEnabled, launch.memory), so flipping a preference can never
 * silently change what an in-flight conversation can reach or what it costs.
 *
 * HONESTY / SAFETY RULES
 *  - Absent means default. A seat set back to `standard` is REMOVED rather than
 *    stored, so the file only ever records a deviation from the default.
 *  - Load is TOTAL: a missing, unreadable, oversized or hand-mangled file yields
 *    the defaults (field by field — one bad seat entry does not discard the
 *    memory opt-outs). The server must boot on any file.
 *  - Update is STRICT: exactly one of the three `VersePreferencesUpdate` forms,
 *    no unknown keys, every value validated. A body can never change more than
 *    the operator clicked (types.ts `VersePreferencesUpdate`).
 *  - Writes are atomic (O_EXCL|O_NOFOLLOW temp, fchmod 0600, fsync, rename) and
 *    refuse to write through a symlinked directory.
 *
 * Spends nothing, reads no secrets, starts no process.
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import { physicalPath } from './path-guard.js';
import {
  VERSE_CONTEXT_MODES,
  type VerseContextMode,
  type VersePreferences,
  type VersePreferencesUpdate,
} from './types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The error every V3.9 service module (preferences, project memory, handoff,
 * search, context fit) throws for a bad request.
 *
 * Shaped like session-engine's `VerseError` — same `code` vocabulary, same
 * status mapping — because verse-api maps errors by DUCK TYPE on `.code`, so a
 * throw from here becomes the contract's 400/413 with no extra wiring. It is a
 * separate class, not an import of `VerseError`, on purpose: these modules are
 * pure services and must not link against the session engine (and, through
 * it, every adapter) just to report a validation failure.
 */
export type VerseServiceErrorCode = 'VERSE_INVALID' | 'VERSE_TOO_LARGE';

export class VerseServiceError extends Error {
  readonly code: VerseServiceErrorCode;
  readonly status: 400 | 413;

  constructor(code: VerseServiceErrorCode, message: string) {
    super(message);
    this.name = 'VerseServiceError';
    this.code = code;
    this.status = code === 'VERSE_TOO_LARGE' ? 413 : 400;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VERSE_PREFERENCES_FILE = 'preferences.json';

/** A preferences file larger than this is not ours; treat it as absent. */
const MAX_PREFERENCES_BYTES = 256 * 1024;
/** Registry bounds — a blast radius for a runaway client, not a UI limit. */
export const VERSE_PREFERENCES_MAX_SEATS = 500;
export const VERSE_PREFERENCES_MAX_DISABLED_PROJECTS = 1000;
/** Same spelling rule the seat catalog uses for ids (`local:qwen3:ctx64k`, `codex-personal`). */
const SEAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const MAX_PATH_CHARS = 4096;

/** The Verse store root every service module defaults to (same as the session engine). */
export function defaultVerseRoot(): string {
  // Re-resolved per call so a relocated HOME (tests) is honoured.
  return join(homedir(), '.ashlr', 'verse');
}

export function defaultVersePreferences(): VersePreferences {
  return { version: 1, seats: {}, memory: { enabled: true, disabledProjects: [] } };
}

// ---------------------------------------------------------------------------
// Private-file primitives (shared with project-memory.ts)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * mkdir -p with 0700 on every directory we CREATE, then refuse to proceed if
 * the final directory is a symlink or is not ours. Pre-existing ancestors are
 * left alone (they may legitimately be the operator's).
 */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing to use ${path}: not a real directory`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing to use ${path}: owned by another user`);
  }
}

/**
 * Create-exclusive temp file beside the target (O_NOFOLLOW), write, fchmod
 * 0600, fsync, rename over the target. The temp name starts with `.` and ends
 * with `.tmp` so directory listings can skip an orphan from a crash.
 */
export function writePrivateFileAtomic(target: string, content: string): void {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let published = false;
  try {
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error('verse private write made no progress');
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    // rename() replaces a symlink at the target NAME (the file it pointed at
    // is never written), so a planted link cannot redirect this write. A
    // directory there is refused up front so the error names the real problem.
    let existing: ReturnType<typeof lstatSync> | null = null;
    try { existing = lstatSync(target); } catch { existing = null; }
    if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
      throw new Error(`refusing to replace ${target}: not a regular file`);
    }
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
 * Read a regular file without following a symlink at its name, up to
 * `maxBytes`. Null when absent, not a regular file, or unreadable. `truncated`
 * says whether the file was longer than the cap.
 */
export function readPrivateFileCapped(
  path: string,
  maxBytes: number,
): { text: string; bytes: number; mtimeMs: number; truncated: boolean } | null {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const want = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(want);
    let offset = 0;
    while (offset < want) {
      const read = readSync(fd, buffer, offset, want - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    const slice = buffer.subarray(0, offset);
    return {
      text: utf8Prefix(slice),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      truncated: stat.size > maxBytes,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Decode bytes, dropping a trailing partial UTF-8 sequence rather than emitting U+FFFD. */
export function utf8Prefix(bytes: Buffer): string {
  let end = bytes.length;
  // Walk back over at most 3 continuation bytes to the lead byte of the last char.
  let i = end - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 4 && (bytes[i] & 0xc0) === 0x80) {
    i -= 1;
    continuation += 1;
  }
  if (i >= 0) {
    const lead = bytes[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > 1 && continuation + 1 < need) end = i;
  }
  return bytes.subarray(0, end).toString('utf8');
}

// ---------------------------------------------------------------------------
// Canonical project paths
// ---------------------------------------------------------------------------

/**
 * The spelling a project path is stored and compared under: absolute, symlinks
 * resolved when the directory exists (so `/tmp/x` and `/private/tmp/x` are one
 * project on macOS). Throws VERSE_INVALID for anything that is not an absolute
 * path — callers validate reachability with path-guard before they get here.
 */
export function canonicalProjectPath(projectPath: string): string {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    throw new VerseServiceError('VERSE_INVALID', 'projectPath is required');
  }
  if (projectPath.length > MAX_PATH_CHARS) {
    throw new VerseServiceError('VERSE_INVALID', `projectPath must be at most ${MAX_PATH_CHARS} characters`);
  }
  if (projectPath.includes('\0')) {
    throw new VerseServiceError('VERSE_INVALID', 'projectPath must not contain NUL bytes');
  }
  const expanded = projectPath === '~' ? homedir() : projectPath.startsWith('~/') ? join(homedir(), projectPath.slice(2)) : projectPath;
  if (!isAbsolute(expanded)) {
    throw new VerseServiceError('VERSE_INVALID', 'projectPath must be an absolute path');
  }
  const lexical = resolvePath(expanded);
  return physicalPath(lexical) ?? lexical;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function isContextMode(value: unknown): value is VerseContextMode {
  return typeof value === 'string' && (VERSE_CONTEXT_MODES as readonly string[]).includes(value);
}

/** Field-by-field salvage of whatever is on disk. Never throws. */
function sanitizePreferences(raw: unknown): VersePreferences {
  const out = defaultVersePreferences();
  if (!isObject(raw)) return out;

  const seats = raw['seats'];
  if (isObject(seats)) {
    let kept = 0;
    for (const [seatId, entry] of Object.entries(seats)) {
      if (kept >= VERSE_PREFERENCES_MAX_SEATS) break;
      if (!SEAT_ID_RE.test(seatId) || !isObject(entry)) continue;
      const mode = entry['contextMode'];
      // Only a deviation from the default is worth keeping.
      if (isContextMode(mode) && mode !== 'standard') {
        out.seats[seatId] = { contextMode: mode };
        kept += 1;
      }
    }
  }

  const memory = raw['memory'];
  if (isObject(memory)) {
    if (typeof memory['enabled'] === 'boolean') out.memory.enabled = memory['enabled'];
    const disabled = memory['disabledProjects'];
    if (Array.isArray(disabled)) {
      const seen = new Set<string>();
      for (const item of disabled) {
        if (seen.size >= VERSE_PREFERENCES_MAX_DISABLED_PROJECTS) break;
        if (typeof item !== 'string' || item.length === 0 || item.length > MAX_PATH_CHARS) continue;
        if (item.includes('\0') || !isAbsolute(item)) continue;
        seen.add(item);
      }
      out.memory.disabledProjects = [...seen].sort();
    }
  }
  return out;
}

export function versePreferencesPath(root: string = defaultVerseRoot()): string {
  return join(root, VERSE_PREFERENCES_FILE);
}

/** The operator's preferences, or the defaults. Total: never throws. */
export function loadVersePreferences(root: string = defaultVerseRoot()): VersePreferences {
  const file = readPrivateFileCapped(versePreferencesPath(root), MAX_PREFERENCES_BYTES);
  if (!file || file.truncated) return defaultVersePreferences();
  try {
    return sanitizePreferences(JSON.parse(file.text) as unknown);
  } catch {
    return defaultVersePreferences();
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

type ParsedUpdate =
  | { kind: 'seat'; seatId: string; contextMode: VerseContextMode }
  | { kind: 'memory'; memoryEnabled: boolean }
  | { kind: 'project'; projectPath: string; memoryEnabled: boolean };

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Validate an update body against EXACTLY one of the three forms. Exported so
 * the API can reject a malformed body before touching disk, with the same
 * wording this module would use.
 */
export function parseVersePreferencesUpdate(value: unknown): ParsedUpdate {
  if (!isObject(value)) {
    throw new VerseServiceError('VERSE_INVALID', 'preferences update must be a JSON object');
  }
  if (sameKeys(value, ['seatId', 'contextMode'])) {
    const seatId = value['seatId'];
    const mode = value['contextMode'];
    if (typeof seatId !== 'string' || !SEAT_ID_RE.test(seatId)) {
      throw new VerseServiceError('VERSE_INVALID', 'seatId must be a seat id');
    }
    if (!isContextMode(mode)) {
      throw new VerseServiceError('VERSE_INVALID', `contextMode must be one of: ${VERSE_CONTEXT_MODES.join(', ')}`);
    }
    return { kind: 'seat', seatId, contextMode: mode };
  }
  if (sameKeys(value, ['memoryEnabled'])) {
    if (typeof value['memoryEnabled'] !== 'boolean') {
      throw new VerseServiceError('VERSE_INVALID', 'memoryEnabled must be a boolean');
    }
    return { kind: 'memory', memoryEnabled: value['memoryEnabled'] };
  }
  if (sameKeys(value, ['projectPath', 'memoryEnabled'])) {
    const projectPath = value['projectPath'];
    if (typeof projectPath !== 'string') {
      throw new VerseServiceError('VERSE_INVALID', 'projectPath must be a string');
    }
    if (typeof value['memoryEnabled'] !== 'boolean') {
      throw new VerseServiceError('VERSE_INVALID', 'memoryEnabled must be a boolean');
    }
    return { kind: 'project', projectPath: canonicalProjectPath(projectPath), memoryEnabled: value['memoryEnabled'] };
  }
  throw new VerseServiceError(
    'VERSE_INVALID',
    'preferences update must be exactly one of {seatId, contextMode}, {memoryEnabled}, or {projectPath, memoryEnabled}',
  );
}

/**
 * Apply ONE validated change and persist atomically. Returns the full
 * preferences as stored. Throws VERSE_INVALID for a malformed update (nothing
 * is written) and VERSE_TOO_LARGE when a registry bound would be exceeded.
 */
export function updateVersePreferences(
  update: VersePreferencesUpdate,
  root: string = defaultVerseRoot(),
): VersePreferences {
  const parsed = parseVersePreferencesUpdate(update);
  const prefs = loadVersePreferences(root);

  switch (parsed.kind) {
    case 'seat': {
      if (parsed.contextMode === 'standard') {
        delete prefs.seats[parsed.seatId];
      } else {
        if (!(parsed.seatId in prefs.seats) && Object.keys(prefs.seats).length >= VERSE_PREFERENCES_MAX_SEATS) {
          throw new VerseServiceError('VERSE_TOO_LARGE', `at most ${VERSE_PREFERENCES_MAX_SEATS} seats can carry a preference`);
        }
        prefs.seats[parsed.seatId] = { contextMode: parsed.contextMode };
      }
      break;
    }
    case 'memory':
      prefs.memory.enabled = parsed.memoryEnabled;
      break;
    case 'project': {
      const set = new Set(prefs.memory.disabledProjects);
      if (parsed.memoryEnabled) {
        set.delete(parsed.projectPath);
      } else {
        if (!set.has(parsed.projectPath) && set.size >= VERSE_PREFERENCES_MAX_DISABLED_PROJECTS) {
          throw new VerseServiceError('VERSE_TOO_LARGE', `at most ${VERSE_PREFERENCES_MAX_DISABLED_PROJECTS} projects can opt out of memory`);
        }
        set.add(parsed.projectPath);
      }
      prefs.memory.disabledProjects = [...set].sort();
      break;
    }
  }

  ensurePrivateDirectory(root);
  // Stable key order so the file diffs cleanly and two equal states are byte-identical.
  const seats: VersePreferences['seats'] = {};
  for (const seatId of Object.keys(prefs.seats).sort()) seats[seatId] = prefs.seats[seatId];
  const stored: VersePreferences = {
    version: 1,
    seats,
    memory: { enabled: prefs.memory.enabled, disabledProjects: prefs.memory.disabledProjects },
  };
  writePrivateFileAtomic(versePreferencesPath(root), `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

// ---------------------------------------------------------------------------
// Helpers the API resolves creation defaults through
// ---------------------------------------------------------------------------

/**
 * Should a NEW session on this project be offered shared memory? Global switch
 * AND not opted out. A path that cannot be canonicalised is treated as
 * disabled — never "enabled because we could not check".
 */
export function memoryEnabledFor(prefs: VersePreferences, projectPath: string): boolean {
  if (!prefs.memory.enabled) return false;
  let canonical: string;
  try {
    canonical = canonicalProjectPath(projectPath);
  } catch {
    return false;
  }
  return !prefs.memory.disabledProjects.includes(canonical);
}

/** The context mode a new session on this seat starts in. */
export function seatDefaultMode(prefs: VersePreferences, seatId: string): VerseContextMode {
  const mode = prefs.seats[seatId]?.contextMode;
  return isContextMode(mode) ? mode : 'standard';
}

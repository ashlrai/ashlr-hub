/**
 * Reasoning store — append-only, private, size-bounded JSONL (V3.10, unit A7).
 *
 * Layout under `~/.ashlr/reasoning/` (or `$ASHLR_HOME/reasoning/`):
 *
 *   steps/YYYY-MM-DD.jsonl     ReasoningStepV1 rows (text-bearing; text is
 *                              blanked by retention.ts after 30 days, the
 *                              row itself is kept 180 days)
 *   features/YYYY-MM-DD.jsonl  TurnFeaturesV1 rows (derived, text-free,
 *                              180 days) — what insights are built from
 *   state/<name>.json          ingest cursors (small JSON, atomic rewrite)
 *
 * The day in a file name is the UTC day of the row's `at` / `startedAt`, so
 * retention can drop or rewrite whole files by name without parsing them.
 *
 * Privacy rules (operator opt-in 2026-09-24), enforced HERE so no caller can
 * forget them:
 *  - every text field is scrubbed (scrubSecrets + home dir → `~`) before it
 *    touches disk, and step text is capped at REASONING_TEXT_MAX_BYTES;
 *  - the directory is 0700 and every file 0600; a symlinked, foreign-owned,
 *    hard-linked or group/world-writable file is refused rather than written;
 *  - nothing here ever feeds a prompt — readers return rows to the API and to
 *    the deterministic extractors only.
 *
 * Writes are synchronous single-line appends (a few hundred µs — the Verse
 * tap runs on the engine's event path and must not reorder rows); reads are
 * async streamed so a large day file never blocks the event loop for long.
 * Writers never throw: a reasoning store problem must not break a chat turn.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { scrubSecrets } from '../util/scrub.js';
import {
  REASONING_TEXT_MAX_BYTES,
  REASONING_TEXT_RETENTION_DAYS,
  type ReasoningEvidence,
  type ReasoningOutcome,
  type ReasoningSource,
  type ReasoningStepKind,
  type ReasoningStepV1,
} from './types.js';
import type { SignatureCount, TurnFeaturesV1 } from './extractors.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** One day of steps. A day past this drops further steps (counted) rather than growing without bound. */
export const MAX_STEP_FILE_BYTES = 32 * 1024 * 1024;
/** One day of turn features (rows are ~1–3 KB; 8 MB is thousands of turns). */
export const MAX_FEATURE_FILE_BYTES = 8 * 1024 * 1024;
/** Whole-store ceiling; retention evicts oldest day files past it. */
export const MAX_STORE_BYTES = 512 * 1024 * 1024;
/** A single JSONL row. Step text is ≤ 8 KB, so anything larger is malformed. */
const MAX_ROW_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_DIR_ENTRIES = 4_096;
/** Rows dated further than this into the future are clock garbage; refused. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1_000;
export const DAY_MS = 24 * 60 * 60 * 1_000;

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const STATE_NAME_RE = /^[a-z0-9-]{1,64}$/;
const SOURCES = new Set<ReasoningSource>(['verse', 'fleet', 'codex-rollout', 'grok']);
const KINDS = new Set<ReasoningStepKind>(['thinking', 'summary', 'progress']);
const OUTCOMES = new Set<ReasoningOutcome>(['ok', 'error', 'cancelled']);

export type StoreKind = 'steps' | 'features';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `$ASHLR_HOME/reasoning` when ASHLR_HOME is absolute, else `~/.ashlr/reasoning` (resolved per call so a test HOME is honored). */
export function reasoningRoot(): string {
  const configured = process.env['ASHLR_HOME'];
  const base = typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
  return join(base, 'reasoning');
}

function kindDir(root: string, kind: StoreKind | 'state'): string {
  return join(root, kind);
}

/** UTC calendar day (YYYY-MM-DD) of an epoch-ms instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Scrubbing / normalisation
// ---------------------------------------------------------------------------

function homeCandidates(): string[] {
  const homes = [homedir(), process.env['HOME'], process.env['USERPROFILE']]
    .filter((value): value is string => typeof value === 'string' && value.length > 1);
  return Array.from(new Set(homes)).sort((a, b) => b.length - a.length);
}

/**
 * Scrub free text for persistence: secrets → `[REDACTED]`, the home
 * directory → `~`, control characters (except tab/newline) removed. Home is
 * rewritten before AND after scrubbing because a secret rule could otherwise
 * split a path the second pass has to see whole.
 */
export function scrubReasoningText(text: string): string {
  let out = text;
  const homes = homeCandidates();
  for (const home of homes) out = out.split(home).join('~');
  out = scrubSecrets(out);
  for (const home of homes) out = out.split(home).join('~');
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Truncate to at most `maxBytes` of UTF-8 without splitting a code point; marks a cut with `…`. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const ellipsis = '…';
  let end = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'));
  // Back off UTF-8 continuation bytes (10xxxxxx) so the cut lands on a boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8') + ellipsis;
}

/** Short identifier/label field: scrubbed, single-line, bounded. Null when empty or not a string. */
export function cleanLabel(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = scrubReasoningText(value).replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 256) return null;
  // Ids are keys, not prose: refuse anything with whitespace/control chars
  // instead of silently rewriting it (a rewritten id would break dedupe).
  return /^[\x21-\x7e]+$/.test(value) ? value : null;
}

function isoOrNull(value: unknown, nowMs: number): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > nowMs + MAX_FUTURE_SKEW_MS || ms < Date.UTC(2000, 0, 1)) return null;
  return new Date(ms).toISOString();
}

function countOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

/**
 * Validate and privacy-normalise a step for persistence. Returns null for a
 * row the store must not write (bad enum, no conversation id, unusable time).
 */
export function normalizeStep(input: ReasoningStepV1, nowMs = Date.now()): ReasoningStepV1 | null {
  if (!input || typeof input !== 'object') return null;
  const id = cleanId(input.id);
  const at = isoOrNull(input.at, nowMs);
  if (!id || !at || !SOURCES.has(input.source) || !KINDS.has(input.kind)) return null;
  const sessionId = input.sessionId === null ? null : cleanId(input.sessionId);
  const runId = input.runId === null ? null : cleanId(input.runId);
  if (sessionId === null && runId === null) return null;
  const engine = cleanLabel(input.engine, 64);
  if (!engine) return null;
  // A step already older than the text window (a late backfill) is stored
  // text-free from the start, so retention never has to revisit its file.
  const textExpired = Date.parse(at) < nowMs - REASONING_TEXT_RETENTION_DAYS * DAY_MS;
  const text = typeof input.text === 'string' && !textExpired
    ? truncateUtf8(scrubReasoningText(input.text), REASONING_TEXT_MAX_BYTES)
    : '';
  return {
    v: 1,
    id,
    source: input.source,
    sessionId,
    runId,
    repo: cleanLabel(input.repo, 512),
    engine,
    model: cleanLabel(input.model, 128),
    at,
    turnId: input.turnId === null ? null : cleanId(input.turnId),
    kind: input.kind,
    text,
    tokens: countOrNull(input.tokens),
    toolAfter: cleanLabel(input.toolAfter, 128),
    outcome: input.outcome !== null && OUTCOMES.has(input.outcome) ? input.outcome : null,
  };
}

/** Structural check for a row read back from disk (rows were normalised on write). */
export function isStepRow(value: unknown): value is ReasoningStepV1 {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ReasoningStepV1>;
  return row.v === 1 && typeof row.id === 'string' && typeof row.at === 'string' &&
    typeof row.engine === 'string' && typeof row.text === 'string' &&
    SOURCES.has(row.source as ReasoningSource) && KINDS.has(row.kind as ReasoningStepKind) &&
    (typeof row.sessionId === 'string' || typeof row.runId === 'string');
}

/** Structural check for a feature row read back from disk. */
export function isFeatureRow(value: unknown): value is TurnFeaturesV1 {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<TurnFeaturesV1>;
  return row.v === 1 && row.type === 'turn' && typeof row.id === 'string' &&
    typeof row.engine === 'string' && typeof row.at === 'string' &&
    SOURCES.has(row.source as ReasoningSource) && typeof row.toolCalls === 'number';
}

function cleanEvidence(value: unknown): ReasoningEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const { ref, at } = value as { ref?: unknown; at?: unknown };
  const cleanRef = cleanId(ref);
  return cleanRef && typeof at === 'string' && Number.isFinite(Date.parse(at)) ? { ref: cleanRef, at } : null;
}

function cleanSignatures(list: unknown): SignatureCount[] {
  if (!Array.isArray(list)) return [];
  const out: SignatureCount[] = [];
  for (const item of list.slice(0, 10)) {
    const signature = cleanLabel((item as { signature?: unknown })?.signature, 80);
    const count = countOrNull((item as { count?: unknown })?.count);
    if (!signature || count === null || count <= 0) continue;
    const evidence = cleanEvidence((item as { evidence?: unknown })?.evidence);
    out.push(evidence ? { signature, count, evidence } : { signature, count });
  }
  return out;
}

/**
 * Defense in depth for feature rows: extractors already build them from
 * scrubbed labels, but every string that reaches disk is re-cleaned here so
 * a caller constructing a row by hand cannot bypass the privacy rules.
 */
function normalizeFeature(feature: TurnFeaturesV1, at: string): TurnFeaturesV1 | null {
  const id = cleanId(feature.id);
  const engine = cleanLabel(feature.engine, 64);
  if (!id || !engine) return null;
  const sessionId = feature.sessionId === null ? null : cleanId(feature.sessionId);
  const runId = feature.runId === null ? null : cleanId(feature.runId);
  if (sessionId === null && runId === null) return null;
  return {
    ...feature,
    id,
    at,
    engine,
    sessionId,
    runId,
    turnId: feature.turnId === null ? null : cleanId(feature.turnId),
    repo: cleanLabel(feature.repo, 512),
    model: cleanLabel(feature.model, 128),
    errorClass: cleanLabel(feature.errorClass, 64),
    outcome: feature.outcome !== null && OUTCOMES.has(feature.outcome) ? feature.outcome : null,
    uncertaintyKeys: Array.isArray(feature.uncertaintyKeys)
      ? feature.uncertaintyKeys.map((key) => cleanLabel(key, 32)).filter((key): key is string => key !== null).slice(0, 16)
      : [],
    failures: cleanSignatures(feature.failures),
    loops: cleanSignatures(feature.loops),
  };
}

// ---------------------------------------------------------------------------
// Safe filesystem primitives
// ---------------------------------------------------------------------------

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function safeFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0);
}

function safeDir(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat);
}

/**
 * Create (0700) or re-tighten a store directory. Refuses a symlink or a
 * directory owned by someone else. Existing dirs we own are chmod'ed back to
 * 0700 — this is our private store, a loosened mode is drift, not intent.
 */
function ensurePrivateDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!safeDir(stat)) return false;
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dirs verified recently. Re-verifying (mkdir + lstat + chmod, twice) on
 * every append dominated the per-append cost; a failed append drops the
 * entry so a removed/replaced directory is re-checked on the retry.
 */
const verifiedDirs = new Map<string, number>();
const DIR_RECHECK_MS = 30_000;

/** Ensure root and the given subdirectory exist privately. */
export function ensureStoreDir(root: string, kind: StoreKind | 'state'): string | null {
  const dir = kindDir(root, kind);
  const verifiedAt = verifiedDirs.get(dir);
  if (verifiedAt !== undefined && Date.now() - verifiedAt < DIR_RECHECK_MS) return dir;
  if (!ensurePrivateDir(root) || !ensurePrivateDir(dir)) {
    verifiedDirs.delete(dir);
    return null;
  }
  verifiedDirs.set(dir, Date.now());
  return dir;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('reasoning store append made no progress');
    offset += written;
  }
}

/**
 * Append pre-serialised lines to one day file. All-or-nothing against the
 * size cap: a batch that would push the file past `maxBytes` is dropped
 * whole, so a day file never ends in half a turn.
 */
function appendLines(path: string, lines: string[], maxBytes: number): boolean {
  if (lines.length === 0) return true;
  const payload = Buffer.from(lines.join(''), 'utf8');
  let fd: number | undefined;
  try {
    let existed = true;
    try {
      if (!safeFile(lstatSync(path))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      existed = false;
    }
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
        (existed ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    const stat = fstatSync(fd);
    if (!safeFile(stat)) return false;
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    if (stat.size + payload.length > maxBytes) return false;
    if (stat.size > 0) {
      // A crash mid-append can leave a torn final line; start ours on a fresh one.
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, stat.size - 1) === 1 && tail[0] !== 0x0a) writeAll(fd, Buffer.from('\n'));
    }
    writeAll(fd, payload);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Write API
// ---------------------------------------------------------------------------

let generation = 0;
let droppedRows = 0;

/** Monotonic write counter — readers use it to invalidate caches. */
export function storeGeneration(): number {
  return generation;
}

/** Rows refused since process start (invalid, oversized, or over a day cap). */
export function storeDroppedRows(): number {
  return droppedRows;
}

function serialize(row: unknown): string | null {
  try {
    const line = JSON.stringify(row) + '\n';
    return Buffer.byteLength(line, 'utf8') <= MAX_ROW_BYTES ? line : null;
  } catch {
    return null;
  }
}

function appendGrouped(
  root: string,
  kind: StoreKind,
  rows: { day: string; line: string }[],
  maxBytes: number,
): number {
  if (rows.length === 0) return 0;
  const dir = ensureStoreDir(root, kind);
  if (!dir) {
    droppedRows += rows.length;
    return 0;
  }
  const byDay = new Map<string, string[]>();
  for (const row of rows) {
    const list = byDay.get(row.day);
    if (list) list.push(row.line);
    else byDay.set(row.day, [row.line]);
  }
  let written = 0;
  for (const [day, lines] of byDay) {
    const path = join(dir, `${day}.jsonl`);
    let ok = appendLines(path, lines, maxBytes);
    if (!ok && verifiedDirs.has(dir)) {
      // The cached directory check may be stale (dir removed or swapped): re-verify once.
      verifiedDirs.delete(dir);
      ok = ensureStoreDir(root, kind) !== null && appendLines(path, lines, maxBytes);
    }
    if (ok) written += lines.length;
    else droppedRows += lines.length;
  }
  if (written > 0) generation += 1;
  return written;
}

/**
 * Persist reasoning steps (normalised + scrubbed here). Returns how many were
 * written. Never throws.
 */
export function appendSteps(steps: ReasoningStepV1[], root = reasoningRoot()): number {
  try {
    const nowMs = Date.now();
    const rows: { day: string; line: string }[] = [];
    for (const step of steps) {
      const normalized = normalizeStep(step, nowMs);
      const line = normalized ? serialize(normalized) : null;
      if (!normalized || !line) {
        droppedRows += 1;
        continue;
      }
      rows.push({ day: normalized.at.slice(0, 10), line });
    }
    return appendGrouped(root, 'steps', rows, MAX_STEP_FILE_BYTES);
  } catch {
    return 0;
  }
}

/**
 * `appendSteps` for large ingest batches: scrubbing ~8 KB of text per step is
 * regex-heavy, so a batch is written in slices with a yield between them to
 * keep every event-loop block short (the §0 20 ms budget).
 */
export async function appendStepsChunked(steps: ReasoningStepV1[], root = reasoningRoot(), sliceSize = 100): Promise<number> {
  let written = 0;
  for (let i = 0; i < steps.length; i += sliceSize) {
    written += appendSteps(steps.slice(i, i + sliceSize), root);
    if (i + sliceSize < steps.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return written;
}

/**
 * Persist turn feature rows. Feature rows are built by extractors.ts from
 * already-scrubbed labels; they are re-validated here but carry no free text.
 * Never throws.
 */
export function appendFeatures(features: TurnFeaturesV1[], root = reasoningRoot()): number {
  try {
    const nowMs = Date.now();
    const rows: { day: string; line: string }[] = [];
    for (const feature of features) {
      const at = isoOrNull(feature?.at, nowMs);
      const normalized = at && isFeatureRow(feature) ? normalizeFeature(feature, at) : null;
      const line = normalized ? serialize(normalized) : null;
      if (!at || !line) {
        droppedRows += 1;
        continue;
      }
      rows.push({ day: at.slice(0, 10), line });
    }
    return appendGrouped(root, 'features', rows, MAX_FEATURE_FILE_BYTES);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export interface DayFile {
  day: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Day files of one kind, oldest first. Unsafe entries (symlinks, foreign files) are skipped. */
export async function listDayFiles(kind: StoreKind, root = reasoningRoot()): Promise<DayFile[]> {
  const dir = kindDir(root, kind);
  let names: string[];
  try {
    const dirStat = await lstat(dir);
    if (!safeDir(dirStat)) return [];
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: DayFile[] = [];
  for (const name of names.slice(0, MAX_DIR_ENTRIES)) {
    const match = DAY_FILE_RE.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    try {
      const stat = await lstat(path);
      if (!safeFile(stat)) continue;
      out.push({ day: match[1] ?? '', path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      /* raced with retention — skip */
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Stream a JSONL file row by row. readline hands lines over per 64 KB chunk,
 * so even a 32 MB day file is parsed in many short slices instead of one
 * long event-loop block. `visit` returning false stops the read.
 */
export async function readJsonl(
  path: string,
  visit: (row: unknown) => boolean | void,
): Promise<void> {
  let stat: Stats;
  try {
    stat = await lstat(path);
    if (!safeFile(stat)) return;
  } catch {
    return;
  }
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line === '' || line.length > MAX_ROW_BYTES) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // torn / foreign line
      }
      if (visit(row) === false) break;
    }
  } catch {
    /* unreadable mid-way: return what was visited */
  } finally {
    lines.close();
    stream.destroy();
  }
}

export interface ScanWindow {
  /** Inclusive lower bound (epoch ms). */
  fromMs: number;
  /** Inclusive upper bound (epoch ms). */
  toMs: number;
}

function rowTimeMs(row: { at?: unknown }): number {
  return typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
}

const VISIT_SLICE = 500;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function scanKind<T extends { at: string }>(
  kind: StoreKind,
  guard: (row: unknown) => row is T,
  window: ScanWindow,
  visit: (row: T) => boolean | void,
  options: { root?: string; newestFirst?: boolean },
): Promise<void> {
  const fromDay = utcDay(window.fromMs);
  const toDay = utcDay(window.toMs);
  const files = (await listDayFiles(kind, options.root ?? reasoningRoot()))
    .filter((file) => file.day >= fromDay && file.day <= toDay);
  if (options.newestFirst) files.reverse();
  for (const file of files) {
    let stop = false;
    const inFile: T[] = [];
    await readJsonl(file.path, (row) => {
      if (!guard(row)) return;
      const ms = rowTimeMs(row);
      if (!(ms >= window.fromMs && ms <= window.toMs)) return;
      if (options.newestFirst) {
        inFile.push(row);
        return;
      }
      if (visit(row) === false) {
        stop = true;
        return false;
      }
    });
    if (options.newestFirst) {
      // Rows are appended in arrival order, which is close to but not exactly
      // time order (backfills interleave); sort the day so newest-first holds.
      inFile.sort((a, b) => rowTimeMs(b) - rowTimeMs(a));
      for (let i = 0; i < inFile.length; i += 1) {
        const row = inFile[i];
        if (row === undefined) continue;
        if (visit(row) === false) {
          stop = true;
          break;
        }
        // A day can hold thousands of rows; yield between slices so a
        // substring search over them never becomes one long block.
        if (i % VISIT_SLICE === VISIT_SLICE - 1) await yieldToLoop();
      }
    }
    if (stop) return;
  }
}

/**
 * Visit steps in the window, de-duplicated by id (the Verse tap and the
 * backfill can both write a step; ids are deterministic so the first wins).
 */
export async function scanSteps(
  window: ScanWindow,
  visit: (step: ReasoningStepV1) => boolean | void,
  options: { root?: string; newestFirst?: boolean } = {},
): Promise<void> {
  const seen = new Set<string>();
  await scanKind('steps', isStepRow, window, (step) => {
    if (seen.has(step.id)) return;
    seen.add(step.id);
    return visit(step);
  }, options);
}

/** Visit turn features in the window, de-duplicated by id. */
export async function scanFeatures(
  window: ScanWindow,
  visit: (feature: TurnFeaturesV1) => boolean | void,
  options: { root?: string; newestFirst?: boolean } = {},
): Promise<void> {
  const seen = new Set<string>();
  await scanKind('features', isFeatureRow, window, (feature) => {
    if (seen.has(feature.id)) return;
    seen.add(feature.id);
    return visit(feature);
  }, options);
}

// ---------------------------------------------------------------------------
// Atomic private rewrite (state files + retention)
// ---------------------------------------------------------------------------

/**
 * Replace `path` with `content` atomically (temp file in the same dir, 0600,
 * O_EXCL|O_NOFOLLOW, then rename). The existing target must be a safe file.
 */
export function writePrivateAtomic(path: string, content: string): boolean {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let fd: number | undefined;
  try {
    try {
      if (!safeFile(lstatSync(path))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeAll(fd, Buffer.from(content, 'utf8'));
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    return true;
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

/** Read a small state document (ingest cursors). Null when absent/unsafe/corrupt. */
export function readStoreState<T>(name: string, root = reasoningRoot()): T | null {
  if (!STATE_NAME_RE.test(name)) return null;
  const path = join(kindDir(root, 'state'), `${name}.json`);
  try {
    const stat = lstatSync(path);
    if (!safeFile(stat) || stat.size > MAX_STATE_BYTES) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomically persist a small state document. Returns false when refused. */
export function writeStoreState(name: string, value: unknown, root = reasoningRoot()): boolean {
  if (!STATE_NAME_RE.test(name)) return false;
  const dir = ensureStoreDir(root, 'state');
  if (!dir) return false;
  let content: string;
  try {
    content = JSON.stringify(value);
  } catch {
    return false;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) return false;
  return writePrivateAtomic(join(dir, `${name}.json`), content);
}

/** Remove a day file (retention). Refuses unsafe entries. */
export function removeDayFile(path: string): boolean {
  try {
    if (!safeFile(lstatSync(path))) return false;
    unlinkSync(path);
    generation += 1;
    return true;
  } catch {
    return false;
  }
}

/** Bump the generation after an out-of-band rewrite (retention). */
export function markStoreChanged(): void {
  generation += 1;
}

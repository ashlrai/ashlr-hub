/**
 * Automation storage — `<ashlr home>/automations/` (dir 0700, files 0600):
 *
 *   automations.json   the definitions ({ v, automations: AutomationV1[] })
 *   state.json         cursors, firings, dedupe index (AutomationStateV1)
 *   firings.jsonl      append-only journal: one line per firing transition,
 *                      each with a link back to its source (rotated at 2 MB)
 *   .lock              cross-process lock (Verse server tick vs. the CLI)
 *
 * ASYNC ONLY: the Verse routes read and write through here, and a Verse route
 * must never block the event loop on disk (scripts/check-verse-sync-io.mjs).
 * Writes are create-exclusive temp file (O_NOFOLLOW, 0600) + fsync + rename;
 * reads refuse a symlink at the name and are size-capped. A definition that
 * fails validation on read is skipped (and counted), never half-trusted.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ashlrHome } from '../cloud/store.js';
import { AutomationInputError, normaliseAutomation } from './validate.js';
import {
  AUTOMATION_FIRING_ID_PATTERN,
  AUTOMATION_LIMITS,
  AUTOMATION_OPEN_STATES,
  AUTOMATION_SCHEMA_VERSION,
  AUTOMATION_STATE_SCHEMA_VERSION,
  type AutomationCursor,
  type AutomationFiringV1,
  type AutomationStateV1,
  type AutomationV1,
} from './types.js';

export const AUTOMATIONS_DIR = 'automations';
export const AUTOMATIONS_FILE = 'automations.json';
export const AUTOMATIONS_STATE_FILE = 'state.json';
export const AUTOMATIONS_JOURNAL_FILE = 'firings.jsonl';
const LOCK_FILE = '.lock';

const DEFINITIONS_MAX_BYTES = 1024 * 1024;
const STATE_MAX_BYTES = 8 * 1024 * 1024;
const JOURNAL_ROTATE_BYTES = 2 * 1024 * 1024;
const JOURNAL_LINE_MAX = 16 * 1024;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const NON_BLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;

// ---------------------------------------------------------------------------
// Paths + private file primitives
// ---------------------------------------------------------------------------

export function automationsDir(): string {
  return join(ashlrHome(), AUTOMATIONS_DIR);
}
export const automationsPath = (): string => join(automationsDir(), AUTOMATIONS_FILE);
export const automationStatePath = (): string => join(automationsDir(), AUTOMATIONS_STATE_FILE);
export const automationJournalPath = (): string => join(automationsDir(), AUTOMATIONS_JOURNAL_FILE);

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('refusing to use the automations folder: not a real directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('refusing to use the automations folder: owned by another user');
  if ((st.mode & 0o077) !== 0) await chmod(path, 0o700);
}

export async function ensureAutomationsDir(): Promise<string> {
  await ensurePrivateDir(ashlrHome());
  const dir = automationsDir();
  await ensurePrivateDir(dir);
  return dir;
}

/** Null when absent / not a regular file / unreadable / larger than `maxBytes`. */
async function readPrivateText(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await handle.readFile({ encoding: 'utf8' });
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writePrivateAtomic(target: string, content: string): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o600);
  let published = false;
  try {
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.chmod(0o600);
    await handle.sync();
    let existing = null;
    try { existing = await lstat(target); } catch { existing = null; }
    if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new Error('refusing to replace a non-file');
    await rename(temp, target);
    published = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!published) await rm(temp, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Lock (in-process queue + cross-process lock file)
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function acquireFileLock(): Promise<string> {
  const dir = await ensureAutomationsDir();
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`).finally(() => handle.close());
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // A holder that died leaves the file behind; a lock this old is abandoned
    // (every critical section here is a few file reads and one write).
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await unlink(path).catch(() => undefined);
        continue;
      }
    } catch { /* vanished between open and stat: retry */ }
    if (Date.now() > deadline) throw new Error('The automations store is busy (another ashlr process holds its lock).');
    await sleep(25);
  }
}

/** Run `fn` holding the automations lock (serialised in-process, exclusive across processes). */
export function withAutomationsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const lock = await acquireFileLock();
    try {
      return await fn();
    } finally {
      await unlink(lock).catch(() => undefined);
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface DefinitionsRead {
  automations: AutomationV1[];
  /** Entries on disk that failed validation (skipped). */
  invalid: number;
}

export async function readAutomations(): Promise<DefinitionsRead> {
  const text = await readPrivateText(automationsPath(), DEFINITIONS_MAX_BYTES);
  if (text === null) return { automations: [], invalid: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { automations: [], invalid: 1 };
  }
  const list = (parsed as { automations?: unknown })?.automations;
  if (!Array.isArray(list)) return { automations: [], invalid: 1 };
  const automations: AutomationV1[] = [];
  let invalid = 0;
  for (const entry of list.slice(0, AUTOMATION_LIMITS.maxAutomations)) {
    try {
      const a = normaliseAutomation(entry, { now: new Date(), stored: true });
      if (automations.some((x) => x.id === a.id)) { invalid += 1; continue; }
      automations.push(a);
    } catch {
      invalid += 1;
    }
  }
  return { automations, invalid };
}

async function writeAutomations(automations: readonly AutomationV1[]): Promise<void> {
  await ensureAutomationsDir();
  await writePrivateAtomic(automationsPath(), `${JSON.stringify({ v: AUTOMATION_SCHEMA_VERSION, automations }, null, 2)}\n`);
}

export type SaveMode = 'upsert' | 'create' | 'update';

/**
 * `upsert`: update when the body's id exists, else create. `create` refuses
 * an id that exists; `update` refuses one that does not. A NEW automation
 * whose derived slug is taken gets `-2`, `-3`… — never overwrites.
 */
export function saveAutomation(body: unknown, opts: { now?: Date; mode?: SaveMode } = {}): Promise<{ automation: AutomationV1; created: boolean }> {
  const now = opts.now ?? new Date();
  const mode = opts.mode ?? 'upsert';
  return withAutomationsLock(async () => {
    const { automations } = await readAutomations();
    const givenId = (body as { id?: unknown } | null)?.id;
    const existing = typeof givenId === 'string' ? automations.find((a) => a.id === givenId) ?? null : null;
    if (mode === 'create' && existing) throw new AutomationInputError(`An automation ${existing.id} already exists.`);
    if (mode === 'update' && !existing) throw new AutomationInputError(`No automation ${typeof givenId === 'string' ? givenId.slice(0, 60) : '(no id)'}.`);
    let automation = normaliseAutomation(body, { now, existing });
    if (existing) {
      const next = automations.map((a) => (a.id === existing.id ? automation : a));
      await writeAutomations(next);
      return { automation, created: false };
    }
    if (automations.length >= AUTOMATION_LIMITS.maxAutomations) throw new AutomationInputError(`At most ${AUTOMATION_LIMITS.maxAutomations} automations.`);
    if (automations.some((a) => a.id === automation.id)) {
      const base = automation.id.slice(0, 44);
      let n = 2;
      while (automations.some((a) => a.id === `${base}-${n}`)) n += 1;
      automation = { ...automation, id: `${base}-${n}` };
    }
    await writeAutomations([...automations, automation]);
    return { automation, created: true };
  });
}

export function setAutomationEnabled(id: string, enabled: boolean, now: Date = new Date()): Promise<AutomationV1 | null> {
  return withAutomationsLock(async () => {
    const { automations } = await readAutomations();
    const found = automations.find((a) => a.id === id);
    if (!found) return null;
    const updated: AutomationV1 = { ...found, enabled, updatedAt: now.toISOString() };
    await writeAutomations(automations.map((a) => (a.id === id ? updated : a)));
    return updated;
  });
}

/** Removes the definition; its firings stay in state/journal as history. */
export function deleteAutomation(id: string): Promise<boolean> {
  return withAutomationsLock(async () => {
    const { automations } = await readAutomations();
    if (!automations.some((a) => a.id === id)) return false;
    await writeAutomations(automations.filter((a) => a.id !== id));
    return true;
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function emptyCursor(): AutomationCursor {
  return { lastPolledAt: null, nextRunAt: null, since: {}, etags: {}, branches: {}, lastError: null };
}

export function emptyState(): AutomationStateV1 {
  return { v: AUTOMATION_STATE_SCHEMA_VERSION, cursors: {}, firings: [], seen: {} };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

function validCursor(value: unknown): AutomationCursor | null {
  if (value === null || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
  if (!nullableString(c['lastPolledAt']) || !nullableString(c['nextRunAt']) || !nullableString(c['lastError'])) return null;
  if (!isStringMap(c['since']) || !isStringMap(c['etags']) || !isStringMap(c['branches'])) return null;
  return {
    lastPolledAt: c['lastPolledAt'],
    nextRunAt: c['nextRunAt'],
    since: c['since'],
    etags: c['etags'],
    branches: c['branches'],
    lastError: c['lastError'],
  };
}

export function isAutomationFiring(value: unknown): value is AutomationFiringV1 {
  if (value === null || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return f['v'] === 1
    && typeof f['id'] === 'string' && AUTOMATION_FIRING_ID_PATTERN.test(f['id'])
    && typeof f['automationId'] === 'string'
    && typeof f['dedupeKey'] === 'string'
    && typeof f['repo'] === 'string'
    && typeof f['title'] === 'string'
    && typeof f['text'] === 'string'
    && typeof f['state'] === 'string'
    && typeof f['lane'] === 'string'
    && typeof f['createdAt'] === 'string'
    && typeof f['updatedAt'] === 'string'
    && typeof f['spendUsd'] === 'number'
    && typeof f['attempts'] === 'number'
    && f['source'] !== null && typeof f['source'] === 'object';
}

export async function readAutomationState(): Promise<AutomationStateV1> {
  const text = await readPrivateText(automationStatePath(), STATE_MAX_BYTES);
  if (text === null) return emptyState();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return emptyState();
  }
  if (parsed?.['v'] !== AUTOMATION_STATE_SCHEMA_VERSION) return emptyState();
  const state = emptyState();
  const cursors = parsed['cursors'];
  if (cursors && typeof cursors === 'object') {
    for (const [id, raw] of Object.entries(cursors as Record<string, unknown>)) {
      const c = validCursor(raw);
      if (c) state.cursors[id] = c;
    }
  }
  if (Array.isArray(parsed['firings'])) state.firings = parsed['firings'].filter(isAutomationFiring);
  const seen = parsed['seen'];
  if (seen && typeof seen === 'object') {
    for (const [key, at] of Object.entries(seen as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) state.seen[key] = at;
    }
  }
  return state;
}

/** Bound the state: drop old dedupe keys and old settled firings (open firings always stay). */
export function pruneState(state: AutomationStateV1, nowMs: number): AutomationStateV1 {
  const cutoff = nowMs - AUTOMATION_LIMITS.dedupeRetentionMs;
  for (const [key, at] of Object.entries(state.seen)) {
    if (at < cutoff) delete state.seen[key];
  }
  const open = state.firings.filter((f) => AUTOMATION_OPEN_STATES.includes(f.state));
  const settled = state.firings
    .filter((f) => !AUTOMATION_OPEN_STATES.includes(f.state))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, Math.max(0, AUTOMATION_LIMITS.firingsKept - open.length));
  state.firings = [...open, ...settled].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return state;
}

export async function writeAutomationState(state: AutomationStateV1, nowMs: number = Date.now()): Promise<void> {
  await ensureAutomationsDir();
  await writePrivateAtomic(automationStatePath(), `${JSON.stringify(pruneState(state, nowMs))}\n`);
}

/** Read-modify-write the state under the lock. `fn` mutates `state` in place and returns a result. */
export function mutateAutomationState<T>(fn: (state: AutomationStateV1) => T | Promise<T>, nowMs?: () => number): Promise<T> {
  return withAutomationsLock(async () => {
    const state = await readAutomationState();
    const result = await fn(state);
    await writeAutomationState(state, nowMs ? nowMs() : Date.now());
    return result;
  });
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export type AutomationJournalEvent = 'fired' | 'queued' | 'deduped' | 'dispatched' | 'deferred' | 'refused' | 'dropped' | 'settled' | 'reviewed';

export interface AutomationJournalRecord {
  at: string;
  event: AutomationJournalEvent;
  automationId: string;
  firingId: string | null;
  dedupeKey: string;
  repo: string;
  state: string;
  lane: string;
  /** Back-link to the source (issue / check run / webhook url), when there is one. */
  sourceUrl: string | null;
  laneRef: string | null;
  laneUrl: string | null;
  reason: string | null;
  spendUsd: number;
}

export function journalRecord(firing: AutomationFiringV1, event: AutomationJournalEvent, at: string): AutomationJournalRecord {
  return {
    at,
    event,
    automationId: firing.automationId,
    firingId: firing.id,
    dedupeKey: firing.dedupeKey,
    repo: firing.repo,
    state: firing.state,
    lane: firing.lane,
    sourceUrl: firing.source.url,
    laneRef: firing.laneRef?.id ?? null,
    laneUrl: firing.laneRef?.url ?? null,
    reason: firing.reason,
    spendUsd: firing.spendUsd,
  };
}

/** Append (O_APPEND, O_NOFOLLOW, 0600). Never throws: the state file stays the source of truth. */
export async function appendAutomationJournal(records: readonly AutomationJournalRecord[]): Promise<boolean> {
  if (records.length === 0) return true;
  try {
    await ensureAutomationsDir();
    const path = automationJournalPath();
    try {
      const st = await lstat(path);
      if (st.isFile() && st.size > JOURNAL_ROTATE_BYTES) await rename(path, path.replace(/\.jsonl$/, '.1.jsonl'));
    } catch { /* absent: created below */ }
    const lines = records
      .map((r) => JSON.stringify(r))
      .filter((line) => line.length <= JOURNAL_LINE_MAX)
      .map((line) => `${line}\n`)
      .join('');
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW, 0o600);
    try {
      await handle.writeFile(lines, { encoding: 'utf8' });
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** Newest-last tail of the journal (bounded read). */
export async function readAutomationJournal(limit = 200): Promise<AutomationJournalRecord[]> {
  const text = await readPrivateText(automationJournalPath(), JOURNAL_ROTATE_BYTES * 2);
  if (text === null) return [];
  const out: AutomationJournalRecord[] = [];
  for (const line of text.split('\n').slice(-limit - 1)) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as AutomationJournalRecord;
      if (parsed && typeof parsed.event === 'string' && typeof parsed.automationId === 'string') out.push(parsed);
    } catch { /* a torn line is skipped */ }
  }
  return out.slice(-limit);
}

export function newFiringId(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(6);
  let suffix = '';
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `af_${stamp}_${suffix}`;
}

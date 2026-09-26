/**
 * Telegram message_id ↔ Leader-thread message mapping (3.14).
 *
 * Telegram only tells us "Mason replied to message 4812" or "Mason tapped a
 * button on message 4812". To turn that into "answer Leader question q-7" or
 * "reply to Leader memo lm-…", every message we send (and every message Mason
 * sends that the Leader thread recorded) is remembered here with the thread
 * message it carries.
 *
 * Buttons: callback_data is capped at 64 bytes, so buttons carry a short
 * numeric token (`lt:<verb>:<token>`) that resolves here to the memo /
 * action ids — ids never ride in callback_data, and a forged token can only
 * name an entry we created.
 *
 * Also remembers which Leader memos have already reached Mason, so a memo
 * delivered by the comms queue is not delivered again by the Leader thread
 * (or vice versa).
 *
 * Store: ~/.ashlr/comms/telegram-thread.json (bounded; oldest entries drop).
 * Never throws.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TelegramThreadKind =
  | 'message'
  | 'question'
  | 'answer'
  | 'memo'
  | 'directive'
  | 'update'
  | 'action'
  | 'notification'
  | 'mason';

export interface TelegramThreadEntry {
  /** Telegram message_id. */
  tg: number;
  /** Leader-thread message id, when this Telegram message carries one. */
  threadId?: string;
  kind: TelegramThreadKind;
  memoId?: string;
  questionId?: string;
  actionIds?: string[];
  at: string;
}

export interface TelegramButtonTarget {
  /** Leader-thread message the buttons were attached to (if any). */
  threadId?: string;
  memoId?: string;
  actionIds?: string[];
  at: string;
}

interface ThreadMapFile {
  v: 1;
  entries: TelegramThreadEntry[];
  buttons: Record<string, TelegramButtonTarget>;
  nextToken: number;
  /** memoId → ISO time it reached Mason. */
  deliveredMemos: Record<string, string>;
}

export const THREAD_MAP_KEEP = 1000;
const BUTTONS_KEEP = 300;
const MEMOS_KEEP = 300;

function mapPath(): string {
  return join(homedir(), '.ashlr', 'comms', 'telegram-thread.json');
}

function empty(): ThreadMapFile {
  return { v: 1, entries: [], buttons: {}, nextToken: 1, deliveredMemos: {} };
}

function load(): ThreadMapFile {
  try {
    const p = mapPath();
    if (!existsSync(p)) return empty();
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<ThreadMapFile>;
    return {
      v: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter((e) => typeof e?.tg === 'number') : [],
      buttons: parsed.buttons && typeof parsed.buttons === 'object' ? parsed.buttons : {},
      nextToken: typeof parsed.nextToken === 'number' && parsed.nextToken > 0 ? parsed.nextToken : 1,
      deliveredMemos: parsed.deliveredMemos && typeof parsed.deliveredMemos === 'object' ? parsed.deliveredMemos : {},
    };
  } catch {
    return empty();
  }
}

function trimRecord<T>(rec: Record<string, T>, keep: number): Record<string, T> {
  const keys = Object.keys(rec);
  if (keys.length <= keep) return rec;
  const out: Record<string, T> = {};
  for (const k of keys.slice(keys.length - keep)) out[k] = rec[k]!;
  return out;
}

function save(file: ThreadMapFile): void {
  try {
    const dir = join(homedir(), '.ashlr', 'comms');
    mkdirSync(dir, { recursive: true });
    const bounded: ThreadMapFile = {
      ...file,
      entries: file.entries.slice(-THREAD_MAP_KEEP),
      buttons: trimRecord(file.buttons, BUTTONS_KEEP),
      deliveredMemos: trimRecord(file.deliveredMemos, MEMOS_KEEP),
    };
    const tmp = `${mapPath()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(bounded) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, mapPath());
  } catch {
    // best-effort
  }
}

/** Remember every Telegram message id a send produced (all chunks map to the same thread message). */
export function recordTelegramMessages(
  tgMessageIds: readonly number[],
  entry: Omit<TelegramThreadEntry, 'tg' | 'at'> & { at?: string },
): void {
  const ids = tgMessageIds.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (ids.length === 0) return;
  const file = load();
  const at = entry.at ?? new Date().toISOString();
  for (const tg of ids) {
    file.entries = file.entries.filter((e) => e.tg !== tg);
    file.entries.push({ ...entry, tg, at });
  }
  if (entry.memoId && (entry.kind === 'memo' || entry.kind === 'notification')) {
    file.deliveredMemos[entry.memoId] = at;
  }
  save(file);
}

/** The thread entry for a Telegram message id, if we sent (or recorded) it. */
export function lookupTelegramMessage(tg: number | undefined): TelegramThreadEntry | null {
  if (typeof tg !== 'number') return null;
  const file = load();
  for (let i = file.entries.length - 1; i >= 0; i--) {
    if (file.entries[i]!.tg === tg) return file.entries[i]!;
  }
  return null;
}

/** The FIRST Telegram message id that carries a thread message (the one to reply to). */
export function telegramIdForThread(threadId: string | undefined): number | undefined {
  if (!threadId) return undefined;
  const file = load();
  const hit = file.entries.find((e) => e.threadId === threadId);
  return hit?.tg;
}

/** Register a button target; returns the token to embed in callback_data. */
export function registerButtonTarget(target: Omit<TelegramButtonTarget, 'at'>): string {
  const file = load();
  const token = String(file.nextToken);
  file.nextToken += 1;
  file.buttons[token] = { ...target, at: new Date().toISOString() };
  save(file);
  return token;
}

export function resolveButtonTarget(token: string): TelegramButtonTarget | null {
  if (!/^\d{1,12}$/.test(token)) return null;
  return load().buttons[token] ?? null;
}

export function memoAlreadyDelivered(memoId: string | undefined): boolean {
  if (!memoId) return false;
  return typeof load().deliveredMemos[memoId] === 'string';
}

export function markMemoDelivered(memoId: string, at = new Date().toISOString()): void {
  const file = load();
  file.deliveredMemos[memoId] = at;
  save(file);
}

/** When a memo reached Mason, or null. */
export function memoDeliveredAt(memoId: string | undefined): string | null {
  if (!memoId) return null;
  return load().deliveredMemos[memoId] ?? null;
}

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

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { parseLeaderQuestionSubmission, LEADER_QUESTION_FORM_LIMITS, LEADER_QUESTION_REVISION_RE,
  type LeaderQuestionForm, type LeaderQuestionSubmission } from '../vision/leader-thread-types.js';

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
  /** 3.15: a Leader question the buttons answer (Yes / No / Your call). */
  questionId?: string;
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

// Typed controls use a strict, separately locked sidecar. Legacy best-effort
// map writes cannot reset its claims or turn an old unnamespaced token current.
export interface TelegramQuestionDraft {
  token: string;
  namespace: string;
  questionId: string;
  threadId: string;
  form: LeaderQuestionForm;
  revision: number;
  selected: number[];
  messageId: number | null;
  callbacks: string[];
  claim: null | { submission: LeaderQuestionSubmission; messageId: string | null; inboundMessageId: number | null };
}
const QUESTION_BYTES = 512 * 1024;
const QUESTION_KEEP = 100;
const QUESTION_CALLBACK_KEEP = 256;
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{24}$/;
const QUESTION_ID = /^lm-\d{14}-[a-f0-9]{6}:[0-4]$/;
const THREAD_ID = /^lt-\d{14}-[a-f0-9]{6}$/;

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function validTelegramQuestionForm(value: unknown): value is LeaderQuestionForm {
  if (!object(value) || value['schemaVersion'] !== 1 || typeof value['revision'] !== 'string' || !LEADER_QUESTION_REVISION_RE.test(value['revision']) ||
      typeof value['expiresAt'] !== 'string' || !Number.isFinite(Date.parse(value['expiresAt'])) ||
      new Date(value['expiresAt']).toISOString() !== value['expiresAt']) return false;
  if (value['mode'] === 'short-answer') return exactKeys(value, ['schemaVersion', 'revision', 'mode', 'expiresAt']);
  if (!['single', 'multiple'].includes(String(value['mode'])) ||
      !exactKeys(value, ['schemaVersion', 'revision', 'mode', 'expiresAt', 'options']) || !Array.isArray(value['options'])) return false;
  const options = value['options'];
  return options.length >= 1 && options.length <= LEADER_QUESTION_FORM_LIMITS.maxOptions &&
    options.every(label => typeof label === 'string' && label.trim() === label && label.length > 0 &&
      label.length <= LEADER_QUESTION_FORM_LIMITS.optionMaxChars) && new Set(options).size === options.length &&
    options.join('; ').length <= LEADER_QUESTION_FORM_LIMITS.answerMaxChars;
}
function validDraft(value: unknown): value is TelegramQuestionDraft {
  if (!object(value) || !exactKeys(value, ['token', 'namespace', 'questionId', 'threadId', 'form', 'revision',
      'selected', 'messageId', 'callbacks', 'claim']) || typeof value['token'] !== 'string' || !TOKEN.test(value['token']) ||
      typeof value['namespace'] !== 'string' || !HEX.test(value['namespace']) || typeof value['questionId'] !== 'string' ||
      !QUESTION_ID.test(value['questionId']) || typeof value['threadId'] !== 'string' || !THREAD_ID.test(value['threadId']) ||
      !validTelegramQuestionForm(value['form']) || !Number.isSafeInteger(value['revision']) || Number(value['revision']) < 0 ||
      Number(value['revision']) > 1_000_000 || !Array.isArray(value['selected']) ||
      value['messageId'] !== null && (!Number.isSafeInteger(value['messageId']) || Number(value['messageId']) <= 0) ||
      !Array.isArray(value['callbacks']) || value['callbacks'].length > QUESTION_CALLBACK_KEEP ||
      !value['callbacks'].every(id => typeof id === 'string' && /^[\w-]{1,128}$/.test(id)) ||
      new Set(value['callbacks']).size !== value['callbacks'].length) return false;
  const form = value['form'], selected = value['selected'];
  if (!selected.every(index => Number.isInteger(index) && index >= 0 && index < (form.options?.length ?? 0)) ||
      new Set(selected).size !== selected.length || form.mode === 'single' && selected.length > 1) return false;
  if (value['claim'] === null) return true;
  if (!object(value['claim']) || !exactKeys(value['claim'], ['submission', 'messageId', 'inboundMessageId'])) return false;
  const submission = parseLeaderQuestionSubmission(value['claim']['submission']);
  return submission !== null && submission.formRevision === form.revision &&
    (submission.kind === 'text' ? form.mode === 'short-answer' && value['claim']['inboundMessageId'] !== null
      : form.mode !== 'short-answer' && value['claim']['inboundMessageId'] === null &&
        submission.optionIndices.length > 0 && submission.optionIndices.every(index => index < form.options!.length) &&
        (form.mode !== 'single' || submission.optionIndices.length === 1) &&
        JSON.stringify(submission.optionIndices) === JSON.stringify(selected)) &&
    (value['claim']['messageId'] === null || typeof value['claim']['messageId'] === 'string' && THREAD_ID.test(value['claim']['messageId'])) &&
    (value['claim']['inboundMessageId'] === null || Number.isSafeInteger(value['claim']['inboundMessageId']) && Number(value['claim']['inboundMessageId']) > 0);

}
function questionDirectory(): { directory: string; created: boolean } {
  const home = realpathSync(homedir());
  for (const part of [join(home, '.ashlr'), join(home, '.ashlr', 'comms')]) {
    const created = !existsSync(part);
    mkdirSync(part, { recursive: true, mode: 0o700 });
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(part) !== part || process.platform !== 'win32' && (stat.mode & 0o022) !== 0 ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
        !assurePrivateStoragePath(part, 'directory', created ? 'secure-created' : 'inspect-owned', { anchorPath: home }).ok)
      throw new Error('Question storage unavailable');
  }
  const directory = join(home, '.ashlr', 'comms', 'telegram-questions');
  let created = false;
  try { mkdirSync(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory || process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700 ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
      !assurePrivateStoragePath(directory, 'directory', created ? 'secure-created' : 'inspect-existing', { anchorPath: home }).ok)
    throw new Error('Question storage unavailable');
  return { directory, created };
}
function questionState<T>(operation: (drafts: TelegramQuestionDraft[]) => T): T | null {
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  let result: T | null = null;
  let released = true;
  try {
    result = (() => {
      const { directory, created } = questionDirectory(), path = join(directory, 'drafts.json');
      lock = acquireLocalStoreLockWithOutcome(join(directory, '.draft.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
      if (lock.state !== 'acquired') return null;
      let drafts: TelegramQuestionDraft[] = [];
      let before: Stats | null = null;
      try { before = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Missing state after initial creation is lost state, never an empty replacement for uncertain claims.
      if (!before && !created) return null;
      if (before) {
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || process.platform !== 'win32' && (before.mode & 0o7777) !== 0o600 ||
            typeof process.getuid === 'function' && before.uid !== process.getuid() ||
            !assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: directory }).ok) return null;
        const read = readPrivateFileCapped(path, QUESTION_BYTES), after = lstatSync(path);
        if (!read || read.truncated || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) return null;
        const state: unknown = JSON.parse(read.text);
        if (!object(state) || !exactKeys(state, ['schemaVersion', 'drafts']) || state['schemaVersion'] !== 1 ||
            !Array.isArray(state['drafts']) || state['drafts'].length > QUESTION_KEEP || !state['drafts'].every(validDraft) ||
            new Set(state['drafts'].map(draft => draft.token)).size !== state['drafts'].length) return null;
        drafts = state['drafts'];
      }
      const priorText = before ? JSON.stringify({ schemaVersion: 1, drafts }) + '\n' : null;
      const result = operation(drafts);
      if (!ownsLocalStoreLock(lock.lock)) return null;
      const text = JSON.stringify({ schemaVersion: 1, drafts }) + '\n';
      if (Buffer.byteLength(text) > QUESTION_BYTES || drafts.length > QUESTION_KEEP || !drafts.every(validDraft)) return null;
      if (text !== priorText) {
        writePrivateFileAtomic(path, text);
        if (!assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath: directory }).ok) return null;
        fsyncDirectory(directory);
      }
      return structuredClone(result);
    })();
  } catch { result = null; }
  finally {
    if (lock?.state === 'acquired') {
      released = false;
      try { released = releaseLocalStoreLock(lock.lock); } catch { /* uncertain release stays held */ }
    }
  }
  return released ? result : null;
}

export function registerTelegramQuestion(namespace: string, questionId: string, threadId: string,
  form: LeaderQuestionForm, nowMs = Date.now()): TelegramQuestionDraft | null {
  if (!HEX.test(namespace) || !QUESTION_ID.test(questionId) || !THREAD_ID.test(threadId) ||
      !validTelegramQuestionForm(form) || Date.parse(form.expiresAt) <= nowMs ||
      Date.parse(form.expiresAt) > nowMs + LEADER_QUESTION_FORM_LIMITS.presentationMaxAgeMs) return null;
  return questionState(drafts => {
    const existing = drafts.find(row => row.namespace === namespace && row.questionId === questionId && row.form.revision === form.revision);
    // Registration reserves the one delivery attempt, including an unknown/partial transport result.
    if (existing) return null;
    // Uncertain canonical claims are never discarded or reopened by expiry.
    // Completed claims may leave the bounded presentation store after expiry;
    // the canonical answer still refuses a new submit from any old keyboard.
    for (let i = drafts.length - 1; i >= 0; i--) {
      const row = drafts[i]!;
      if ((!row.claim || row.claim.messageId !== null) && Date.parse(row.form.expiresAt) <= nowMs) drafts.splice(i, 1);
    }
    if (drafts.length >= QUESTION_KEEP) return null;
    const row: TelegramQuestionDraft = { token: randomBytes(12).toString('hex'), namespace, questionId, threadId,
      form: structuredClone(form), revision: 0, selected: [], messageId: null, callbacks: [], claim: null };
    drafts.push(row); return row;
  });
}
export function bindTelegramQuestionMessage(token: string, namespace: string, messageId: number): boolean {
  if (!TOKEN.test(token) || !HEX.test(namespace) || !Number.isSafeInteger(messageId) || messageId <= 0) return false;
  return questionState(drafts => {
    const row = drafts.find(value => value.token === token && value.namespace === namespace);
    if (!row || row.claim || row.messageId !== null && row.messageId !== messageId) return false;
    row.messageId = messageId; return true;
  }) === true;
}
export type TelegramQuestionOperation = 'option' | 'all' | 'clear' | 'submit' | 'write';
export interface TelegramQuestionChange {
  outcome: 'draft' | 'submit' | 'write' | 'stale' | 'duplicate' | 'held';
  draft: TelegramQuestionDraft;
}
export function changeTelegramQuestion(input: { token: string; namespace: string; messageId: number; revision: number;
  callbackId: string; operation: TelegramQuestionOperation; optionIndex?: number }, nowMs = Date.now()): TelegramQuestionChange | null {
  if (!TOKEN.test(input.token) || !HEX.test(input.namespace) || !Number.isSafeInteger(input.messageId) ||
      !Number.isSafeInteger(input.revision) || !/^[\w-]{1,128}$/.test(input.callbackId)) return null;
  return questionState(drafts => {
    const row = drafts.find(value => value.token === input.token && value.namespace === input.namespace && value.messageId === input.messageId);
    if (!row) return null;
    const result = (outcome: TelegramQuestionChange['outcome']): TelegramQuestionChange => ({ outcome, draft: row });
    if (row.callbacks.includes(input.callbackId)) return result('duplicate');
    if (row.claim || Date.parse(row.form.expiresAt) <= nowMs || row.callbacks.length >= QUESTION_CALLBACK_KEEP) return result('held');
    if (row.revision !== input.revision) return result('stale');
    row.callbacks.push(input.callbackId);
    if (input.operation === 'write') return result('write');
    if (input.operation === 'submit') {
      if (!row.selected.length) return result('held');
      const submission: LeaderQuestionSubmission = { schemaVersion: 1, formRevision: row.form.revision,
        kind: 'options', optionIndices: [...row.selected].sort((a, b) => a - b) };
      if (!parseLeaderQuestionSubmission(submission)) return result('held');
      row.claim = { submission, messageId: null, inboundMessageId: null }; return result('submit');
    }
    if (row.form.mode === 'short-answer' || row.revision >= 1_000_000) return result('held');
    if (input.operation === 'clear') row.selected = [];
    else if (input.operation === 'all') {
      if (row.form.mode !== 'multiple') return result('held');
      row.selected = row.form.options!.map((_, index) => index);
    } else if (input.operation === 'option') {
      const index = input.optionIndex;
      if (!Number.isInteger(index) || index! < 0 || index! >= row.form.options!.length) return result('held');
      row.selected = row.form.mode === 'single' ? row.selected.includes(index!) ? [] : [index!]
        : row.selected.includes(index!) ? row.selected.filter(value => value !== index) : [...row.selected, index!].sort((a, b) => a - b);
    } else return result('held');
    row.revision++; return result('draft');
  });
}
export function settleTelegramQuestionClaim(token: string, namespace: string, submission: LeaderQuestionSubmission, messageId: string): boolean {
  if (!TOKEN.test(token) || !HEX.test(namespace) || !THREAD_ID.test(messageId)) return false;
  return questionState(drafts => {
    const row = drafts.find(value => value.token === token && value.namespace === namespace);
    if (!row?.claim || JSON.stringify(row.claim.submission) !== JSON.stringify(submission)) return false;
    row.claim.messageId = messageId; return true;
  }) === true;
}

/** A genuine human reply freezes text under the same delivered-question binding. */
export function claimTelegramQuestionText(namespace: string, botMessageId: number, humanMessageId: number,
  questionId: string, text: string, nowMs = Date.now()): TelegramQuestionDraft | null {
  if (!HEX.test(namespace) || !Number.isSafeInteger(botMessageId) || botMessageId <= 0 ||
      !Number.isSafeInteger(humanMessageId) || humanMessageId <= 0 || !QUESTION_ID.test(questionId)) return null;
  return questionState(drafts => {
    const row = drafts.find(value => value.namespace === namespace && value.messageId === botMessageId && value.questionId === questionId);
    if (!row || row.claim || row.form.mode !== 'short-answer' || Date.parse(row.form.expiresAt) <= nowMs) return null;
    const submission = parseLeaderQuestionSubmission({ schemaVersion: 1, formRevision: row.form.revision, kind: 'text', text });
    if (!submission) return null;
    row.claim = { submission, messageId: null, inboundMessageId: humanMessageId };
    return row;
  });
}

export function readTelegramQuestionDraft(namespace: string, botMessageId: number, questionId: string): TelegramQuestionDraft | null {
  if (!HEX.test(namespace) || !Number.isSafeInteger(botMessageId) || botMessageId <= 0 || !QUESTION_ID.test(questionId)) return null;
  return questionState(drafts => drafts.find(row => row.namespace === namespace && row.messageId === botMessageId && row.questionId === questionId) ?? null);
}

export function readTelegramQuestionControl(token: string, namespace: string, botMessageId: number): TelegramQuestionDraft | null {
  if (!TOKEN.test(token) || !HEX.test(namespace) || !Number.isSafeInteger(botMessageId) || botMessageId <= 0) return null;
  return questionState(drafts => drafts.find(row => row.token === token && row.namespace === namespace && row.messageId === botMessageId) ?? null);
}

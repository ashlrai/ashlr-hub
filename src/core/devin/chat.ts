/**
 * The Devin CHAT seat's lane glue (3.15): what a Verse chat on Devin needs
 * from the Devin lane beyond #536's launch path.
 *
 *  - A chat's first message IS a Devin task (`launchDevinTask` with
 *    `origin: 'chat'`, the chat contract and the chat's id): the same key,
 *    the same budget gate — the OPERATOR's, never the fleet's, so the fleet
 *    reserve does not apply and the session never counts as fleet work — the
 *    same task record, so the ACU budget, the tracker and Needs-you (#536's PR
 *    triage) all see it with no second copy of their rules.
 *  - Follow-ups post to the session (`sendDevinChatMessage`); a suspended
 *    session wakes on a message (documented), a terminated one cannot.
 *  - The chat's read position in Devin's message stream (`after` cursor, the
 *    event ids already shown and the PRs already carded) lives in a small
 *    private sidecar next to the task: `<devin home>/chat/<taskId>.json`.
 *  - Stop in a Devin chat = terminate (`terminateDevinChat`, DELETE), behind a
 *    confirm in the UI.
 */
import { join } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';
import { devinBudgetView } from './budget.js';
import { DevinApiError, devinFailureSentence, type DevinSession } from './client.js';
import { connectedClient, recordDevinApiOutcome, snapshotOf, type DevinServiceDeps } from './service.js';
import { devinHome, ensureDevinDirectory, listDevinTasks, readDevinBudget, readDevinTask, writeDevinTask } from './store.js';
import { stateFromSession } from './tracker.js';
import { DEVIN_TASK_ID_PATTERN, type DevinFailureCode, type DevinGate, type DevinTaskV1 } from './types.js';
import { readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';

/** The cloud seat's id — the same `devin` the fleet's engine identity uses. */
export const DEVIN_CLOUD_SEAT_ID = 'devin';
/** The local CLI seat's id. */
export const DEVIN_CLI_SEAT_ID = 'devin-cli';

/** Devin's documented message limit (client.ts sendMessage). */
export const DEVIN_CHAT_MESSAGE_MAX_CHARS = 20_000;

const CHAT_DIR = 'chat';
const STATE_MAX_BYTES = 64 * 1024;
const SEEN_KEEP = 400;
const PRS_KEEP = 20;

// ---------------------------------------------------------------------------
// Read position sidecar
// ---------------------------------------------------------------------------

export interface DevinChatStateV1 {
  v: 1;
  taskId: string;
  /** `end_cursor` of the last messages page read; null = from the start. */
  cursor: string | null;
  /** Event ids already turned into transcript events (bounded, newest kept). */
  seen: string[];
  /** PR URLs already carded in the transcript. */
  prUrls: string[];
  updatedAt: string;
}

function statePath(taskId: string): string {
  return join(devinHome(), CHAT_DIR, `${taskId}.json`);
}

export function emptyDevinChatState(taskId: string): DevinChatStateV1 {
  return { v: 1, taskId, cursor: null, seen: [], prUrls: [], updatedAt: new Date(0).toISOString() };
}

/** Total: a missing or corrupt sidecar reads as "from the start". */
export function readDevinChatState(taskId: string): DevinChatStateV1 {
  if (!DEVIN_TASK_ID_PATTERN.test(taskId)) return emptyDevinChatState(taskId);
  try {
    const file = readPrivateFileCapped(statePath(taskId), STATE_MAX_BYTES);
    if (!file || file.truncated) return emptyDevinChatState(taskId);
    const raw = JSON.parse(file.text) as Record<string, unknown>;
    const strings = (value: unknown, max: number): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length <= 2048).slice(-max) : [];
    return {
      v: 1,
      taskId,
      cursor: typeof raw['cursor'] === 'string' && raw['cursor'].length <= 512 ? raw['cursor'] : null,
      seen: strings(raw['seen'], SEEN_KEEP),
      prUrls: strings(raw['prUrls'], PRS_KEEP),
      updatedAt: typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : new Date(0).toISOString(),
    };
  } catch {
    return emptyDevinChatState(taskId);
  }
}

export function writeDevinChatState(state: DevinChatStateV1): void {
  if (!DEVIN_TASK_ID_PATTERN.test(state.taskId)) return;
  ensureDevinDirectory(CHAT_DIR);
  const next: DevinChatStateV1 = {
    ...state,
    seen: state.seen.slice(-SEEN_KEEP),
    prUrls: state.prUrls.slice(-PRS_KEEP),
    updatedAt: new Date().toISOString(),
  };
  writePrivateFileAtomic(statePath(state.taskId), `${JSON.stringify(next)}\n`);
}

// ---------------------------------------------------------------------------
// Budget / readiness
// ---------------------------------------------------------------------------

/**
 * May a Devin CHAT start a new session right now? The operator's gate
 * (`canLaunch`): the daily cap, the pause threshold, concurrency — but not the
 * fleet reserve, which exists for exactly these sessions. Sync (two small
 * private reads under ~/.ashlr/devin) so the engine's readiness gate can turn
 * a refusal into the 409 before anything is recorded in the chat.
 */
export function devinChatGate(now: Date = new Date()): DevinGate {
  try {
    return devinBudgetView(listDevinTasks(Number.MAX_SAFE_INTEGER), readDevinBudget(), now).canLaunch;
  } catch {
    // Unreadable budget state: the launch path re-checks and fails closed there.
    return { ok: true, reason: null };
  }
}

// ---------------------------------------------------------------------------
// Session facts → task record
// ---------------------------------------------------------------------------

const TERMINAL_TASK_STATES = new Set<DevinTaskV1['state']>(['pr-open', 'merged', 'closed']);

/**
 * Fold a fresh session read into the chat's task record (snapshot always;
 * state unless GitHub already moved it on — a PR the tracker verified is not
 * undone by a "waiting for you"). Best effort: the record is bookkeeping for
 * the budget and Needs-you, never the transcript's source of truth.
 */
export function recordDevinChatSession(taskId: string, session: DevinSession, now: Date = new Date()): DevinTaskV1 | null {
  try {
    const task = readDevinTask(taskId);
    if (!task) return null;
    const next: DevinTaskV1 = { ...task, session: snapshotOf(session, now) };
    if (!TERMINAL_TASK_STATES.has(task.state)) {
      const mapped = stateFromSession(task, session);
      if (mapped) Object.assign(next, { state: mapped.state, stateReason: mapped.reason, failure: mapped.failure });
    }
    // The runner polls every few seconds: write only when something a reader
    // uses moved (not the read time), so the tracker's optimistic commit and
    // the disk are not churned by identical readings.
    const before = task.session;
    const after = next.session!;
    const unchanged = before !== null
      && before.status === after.status && before.statusDetail === after.statusDetail
      && before.acusConsumed === after.acusConsumed && before.prUrls.join('\n') === after.prUrls.join('\n')
      && task.state === next.state && task.stateReason === next.stateReason;
    if (unchanged) return task;
    writeDevinTask(next);
    return next;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Messages / terminate
// ---------------------------------------------------------------------------

export type DevinChatSendResult =
  | { ok: true; task: DevinTaskV1; session: DevinSession | null }
  /** `ended`: the session can no longer take messages (terminated / gone) — start a new one. */
  | { ok: false; ended: boolean; error: string; failure: DevinFailureCode | null };

/**
 * Post a chat follow-up to the chat's session. Unlike `messageDevinTask` (the
 * Resources card's 4,000-character reply box) a chat message may be as long
 * as Devin accepts, and an `expired` task — the tracker's word for "finished
 * without a PR" — is still a live conversation.
 */
export async function sendDevinChatMessage(taskId: string, text: string, deps: DevinServiceDeps = {}): Promise<DevinChatSendResult> {
  const task = readDevinTask(taskId);
  if (!task) return { ok: false, ended: true, error: 'This chat’s Devin session is no longer on record.', failure: null };
  if (!task.sessionId || task.state === 'closed' || task.state === 'failed' || task.session?.status === 'exit') {
    return { ok: false, ended: true, error: 'This Devin session has ended.', failure: null };
  }
  const message = text.replace(/\0/g, '').trim();
  if (message === '') return { ok: false, ended: false, error: 'The message is empty.', failure: 'invalid-request' };
  if (message.length > DEVIN_CHAT_MESSAGE_MAX_CHARS) {
    return { ok: false, ended: false, error: `Devin accepts messages of up to ${DEVIN_CHAT_MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters.`, failure: 'invalid-request' };
  }
  const connected = await connectedClient(deps);
  if ('error' in connected) return { ok: false, ended: false, error: connected.error, failure: connected.failure };
  try {
    await connected.client.sendMessage(connected.orgId, task.sessionId, message);
    recordDevinApiOutcome(null);
  } catch (error) {
    recordDevinApiOutcome(error);
    const code: DevinFailureCode = error instanceof DevinApiError ? error.code : 'unknown';
    // 404/409/422: the session is gone or no longer takes messages.
    const ended = error instanceof DevinApiError && code === 'invalid-request' && (error.status === 404 || error.status === 409 || error.status === 410);
    const text = error instanceof DevinApiError ? error.message : devinFailureSentence('unknown');
    return { ok: false, ended, error: scrubSecrets(text).slice(0, 400), failure: code };
  }
  const current = readDevinTask(taskId) ?? task;
  // Counted like the card's replies (messageDevinTask, the evidence timeline); the text is never stored.
  const counted: DevinTaskV1 = { ...current, messagesSent: (current.messagesSent ?? 0) + 1 };
  const next: DevinTaskV1 = counted.state === 'blocked' || counted.state === 'expired'
    ? { ...counted, state: 'running', stateReason: 'You replied; Devin is working again.' }
    : counted;
  try {
    writeDevinTask(next);
  } catch { /* the message went; the next read catches up */ }
  return { ok: true, task: next, session: null };
}

export type DevinChatTerminateResult = { ok: true; task: DevinTaskV1 } | { ok: false; status: 404 | 409 | 502; error: string };

/**
 * Stop a Devin chat for good: DELETE the session ("a terminated session
 * cannot be resumed") and close the task, so it stops holding budget headroom.
 */
export async function terminateDevinChat(taskId: string, deps: DevinServiceDeps = {}): Promise<DevinChatTerminateResult> {
  if (!DEVIN_TASK_ID_PATTERN.test(taskId)) return { ok: false, status: 404, error: 'No Devin session is bound to this chat yet.' };
  const task = readDevinTask(taskId);
  if (!task) return { ok: false, status: 404, error: 'No Devin session is bound to this chat yet.' };
  if (!task.sessionId) return { ok: false, status: 409, error: 'This chat’s Devin session never started.' };
  const connected = await connectedClient(deps);
  if ('error' in connected) return { ok: false, status: 409, error: connected.error };
  let session: DevinSession | null = null;
  try {
    session = await connected.client.terminateSession(connected.orgId, task.sessionId);
    recordDevinApiOutcome(null);
  } catch (error) {
    recordDevinApiOutcome(error);
    // Already gone is the outcome we wanted.
    const gone = error instanceof DevinApiError && (error.status === 404 || error.status === 410);
    if (!gone) {
      return { ok: false, status: 502, error: scrubSecrets(error instanceof DevinApiError ? error.message : devinFailureSentence('unknown')).slice(0, 400) };
    }
  }
  const current = readDevinTask(taskId) ?? task;
  const now = new Date();
  const next: DevinTaskV1 = {
    ...current,
    ...(session ? { session: snapshotOf(session, now) } : {}),
    // A PR already open stays with Needs-you; otherwise the task is done.
    ...(TERMINAL_TASK_STATES.has(current.state) ? {} : { state: 'closed' as const, stateReason: 'Terminated from its Verse chat.' }),
  };
  try {
    writeDevinTask(next);
  } catch { /* the session is terminated either way */ }
  return { ok: true, task: next };
}

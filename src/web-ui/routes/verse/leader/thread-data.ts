/**
 * routes/verse/leader/thread-data.ts — every read and write behind the
 * Leader conversation (Mind) and its preview line (Command). Paths and
 * shapes: thread-types.ts.
 *
 * Reads are OPTIONAL reads (command/surface-data.ts optionalQuery): a server
 * without the conversation routes answers 404, which is "not in this build
 * yet" on the card — never a broken Mind. Writes pull the held mutation
 * token (VerseControlLockedError without one; the panel opens the token
 * dialog first) and invalidate exactly what they change.
 */
import { apiDelete, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { optionalQuery, SURFACE_KEYS } from '../command/surface-data.js';
import { refreshActivity } from '../shell/useActivity.js';
import { narrowDirective, narrowDirectives, narrowSendResult, narrowThreadPage } from './thread-model.js';
import {
  LEADER_ACTIONS_PATH,
  LEADER_DIRECTIVES_PATH,
  LEADER_QUESTIONS_PATH,
  LEADER_THREAD_PATH,
  type LeaderSendResult,
  type LeaderThreadMessage,
  type OperatorDirective,
} from './thread-types.js';

/** One page: enough for a day of conversation; older pages load on request. */
export const THREAD_PAGE_SIZE = 50;

export const LEADER_THREAD_KEYS = Object.freeze({
  thread: 'verse-leader-thread',
  directives: 'verse-leader-directives',
});

export const leaderThreadQuery = optionalQuery(LEADER_THREAD_KEYS.thread, `${LEADER_THREAD_PATH}?limit=${THREAD_PAGE_SIZE}`, 'The Leader conversation', narrowThreadPage);
export const leaderDirectivesQuery = optionalQuery(LEADER_THREAD_KEYS.directives, LEADER_DIRECTIVES_PATH, 'Leader directives', narrowDirectives);

/** The page before `beforeId` (the oldest message on screen). Throws like any read. */
export async function fetchOlderThread(beforeId: string, signal?: AbortSignal): Promise<LeaderThreadMessage[]> {
  const raw = await apiGet<unknown>(`${LEADER_THREAD_PATH}?limit=${THREAD_PAGE_SIZE}&before=${encodeURIComponent(beforeId)}`, signal);
  return narrowThreadPage(raw)?.messages ?? [];
}

function token(): string {
  const t = getMutationToken();
  if (!t) throw new VerseControlLockedError();
  return t;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const result = await apiPost<unknown>(path, body, token());
  touchMutationHold();
  return result;
}

/**
 * A send the server accepted but answered in a shape this page cannot read
 * is still a send: the next read shows it. Null tells the caller "refetch".
 */
export async function sendLeaderMessage(text: string, replyTo: string | null = null): Promise<LeaderSendResult | null> {
  const result = narrowSendResult(await post(LEADER_THREAD_PATH, replyTo ? { text, replyTo } : { text }));
  if (result?.directive) invalidate(LEADER_THREAD_KEYS.directives);
  return result;
}

export async function answerLeaderQuestion(questionId: string, text: string): Promise<LeaderSendResult | null> {
  const result = narrowSendResult(await post(`${LEADER_QUESTIONS_PATH}/${encodeURIComponent(questionId)}/answer`, { text }));
  // The question's Needs-you row closes with its answer.
  void refreshActivity();
  return result;
}

/** Approve a class-B action now (skip the window) or a class-C ask. */
export async function approveLeaderAction(actionId: string): Promise<unknown> {
  const result = await post(`${LEADER_ACTIONS_PATH}/${encodeURIComponent(actionId)}/approve`, {});
  invalidate(SURFACE_KEYS.leader);
  invalidate(LEADER_THREAD_KEYS.thread);
  void refreshActivity();
  return result;
}

export async function addLeaderDirective(text: string): Promise<OperatorDirective | null> {
  const raw = await post(LEADER_DIRECTIVES_PATH, { text });
  invalidate(LEADER_THREAD_KEYS.directives);
  invalidate(LEADER_THREAD_KEYS.thread);
  const record = raw !== null && typeof raw === 'object' && 'directive' in raw ? (raw as { directive: unknown }).directive : raw;
  return narrowDirective(record);
}

export async function retireLeaderDirective(id: string): Promise<void> {
  await apiDelete<unknown>(`${LEADER_DIRECTIVES_PATH}/${encodeURIComponent(id)}`, token());
  touchMutationHold();
  invalidate(LEADER_THREAD_KEYS.directives);
  invalidate(LEADER_THREAD_KEYS.thread);
}

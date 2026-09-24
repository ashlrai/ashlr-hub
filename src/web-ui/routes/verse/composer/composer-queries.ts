/**
 * routes/verse/composer/composer-queries.ts — every call the 3.10 composer
 * makes (unit C3; core/verse/session-controls-api.ts is the server side).
 *
 * Same conventions as ../context/context-queries.ts:
 *  - WRITES pull the held mutation token, throw `VerseMutationLockedError`
 *    when none is held (so the caller's token gate can ask for it), and touch
 *    the hold on success;
 *  - READS carry the read-client proof and keep the server's refusal sentence
 *    (`ApiError.detail`), because these routes answer a refused read with a
 *    sentence written for a person.
 *
 * Spend: none of these start a model call EXCEPT the two that exist to send —
 * a queued follow-up when nothing is running, and [Send now]. Both go through
 * the engine's one `sendTurn` chokepoint, like POST /sessions/:id/turns.
 */
import { getMutationToken, getReadClientProof, reportSessionExpired, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { ApiError, apiPost } from '../../../data/client.js';
import type {
  VerseAttachment,
  VerseAttachmentUpload,
  VerseFilesResponse,
  VerseQueueResponse,
  VerseSessionControlDefaults,
  VerseSessionControlDefaultsUpdate,
  VerseSessionControlsResponse,
  VerseSessionControlsUpdate,
} from '../../../../core/verse/workbench-types.js';
import {
  VERSE_ATTACHMENTS_PATH,
  VERSE_FILES_PATH,
  VERSE_QUEUE_PATH,
  VERSE_SESSION_CONTROL_DEFAULTS_PATH,
  VERSE_SESSION_CONTROLS_PATH,
} from '../../../../core/verse/workbench-types.js';
import { VERSE_SESSIONS_KEY, VerseMutationLockedError } from '../verse-queries.js';

/** POST /queue and /send answer with the queue plus the turn they started, if any. */
export type VerseQueueSendResult = VerseQueueResponse & { sentTurnId: string | null };

async function refusalDetail(res: Response): Promise<{ detail: string | null; code: string | null }> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    return {
      detail: typeof body.error === 'string' && body.error ? body.error : null,
      code: typeof body.code === 'string' && body.code ? body.code : null,
    };
  } catch {
    return { detail: null, code: null };
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'x-ashlr-read-client': getReadClientProof() },
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401) {
    reportSessionExpired();
    throw new ApiError('Read session expired.', 401, path);
  }
  if (!res.ok) {
    const { detail, code } = await refusalDetail(res);
    throw new ApiError(`GET ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`, res.status, path, detail, code);
  }
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token, signal);
  touchMutationHold();
  return result;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function fetchSessionControls(sessionId: string, signal?: AbortSignal): Promise<VerseSessionControlsResponse> {
  return getJson(`${VERSE_SESSION_CONTROLS_PATH}/${enc(sessionId)}`, signal);
}

export async function updateSessionControls(sessionId: string, update: VerseSessionControlsUpdate): Promise<VerseSessionControlsResponse> {
  const result = await post<VerseSessionControlsResponse>(`${VERSE_SESSION_CONTROLS_PATH}/${enc(sessionId)}`, update);
  // A model switch changes the record the header and the chat list draw.
  if (update.model !== undefined) invalidate(VERSE_SESSIONS_KEY);
  return result;
}

export function fetchControlDefaults(signal?: AbortSignal): Promise<VerseSessionControlDefaults> {
  return getJson(VERSE_SESSION_CONTROL_DEFAULTS_PATH, signal);
}

export function updateControlDefaults(update: VerseSessionControlDefaultsUpdate): Promise<VerseSessionControlDefaults> {
  return post(VERSE_SESSION_CONTROL_DEFAULTS_PATH, update);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export function uploadAttachment(sessionId: string, upload: VerseAttachmentUpload, signal?: AbortSignal): Promise<VerseAttachment> {
  return post(`${VERSE_ATTACHMENTS_PATH}/${enc(sessionId)}`, upload, signal);
}

export function deleteAttachment(sessionId: string, attachmentId: string): Promise<{ sessionId: string; items: VerseAttachment[] }> {
  return post(`${VERSE_ATTACHMENTS_PATH}/${enc(sessionId)}/${enc(attachmentId)}/delete`, {});
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export function fetchQueue(sessionId: string, signal?: AbortSignal): Promise<VerseQueueResponse> {
  return getJson(`${VERSE_QUEUE_PATH}/${enc(sessionId)}`, signal);
}

export function enqueueFollowUp(sessionId: string, text: string, opts: { sendNow?: boolean } = {}): Promise<VerseQueueSendResult> {
  return post(`${VERSE_QUEUE_PATH}/${enc(sessionId)}`, opts.sendNow ? { text, sendNow: true } : { text });
}

export function removeFollowUp(sessionId: string, queueId: string): Promise<VerseQueueResponse> {
  return post(`${VERSE_QUEUE_PATH}/${enc(sessionId)}/${enc(queueId)}/delete`, {});
}

export function sendFollowUpNow(sessionId: string, queueId: string): Promise<VerseQueueSendResult> {
  return post(`${VERSE_QUEUE_PATH}/${enc(sessionId)}/${enc(queueId)}/send`, {});
}

// ---------------------------------------------------------------------------
// Files (`@`)
// ---------------------------------------------------------------------------

/** The chat's cwd root rides along (additive), so a match there is written relative. */
export type VerseFilesResult = VerseFilesResponse & { primaryRoot?: string | null };

export function searchSessionFiles(sessionId: string, query: string, signal?: AbortSignal): Promise<VerseFilesResult> {
  const params = new URLSearchParams({ sessionId, q: query });
  return getJson(`${VERSE_FILES_PATH}?${params.toString()}`, signal);
}

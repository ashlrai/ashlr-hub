/**
 * routes/verse/changes/checkpoint-queries.ts — the page's side of
 * `/api/verse/checkpoints*` (server: core/verse/checkpoints-api.ts).
 *
 * Reads keep the error CODE (like git-queries.ts): the pane tells "no
 * checkpoint for this turn" (409 VERSE_CHECKPOINT_UNAVAILABLE) apart from a
 * failure. Writes go through the held mutation token; no token →
 * VerseMutationLockedError, which the pane's token gate turns into the unlock
 * dialog.
 *
 * Everything is gathered in one `CheckpointClient` object so tests (and a
 * future pane host) can hand the panel a fake.
 */
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, getReadClientProof, reportSessionExpired, touchMutationHold } from '../../../data/auth-store.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';
import type {
  VerseCheckpointApplyResponse,
  VerseCheckpointDecision,
  VerseCheckpointDiffMode,
  VerseCheckpointDiffResponse,
  VerseCheckpointListResponse,
  VerseCheckpointPreviewResponse,
  VerseCheckpointResolution,
  VerseCheckpointReviewResponse,
} from '../../../../core/verse/checkpoint-types.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const CHECKPOINTS_API = '/api/verse/checkpoints';

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (isRemoteMobileMode()) return apiGet<T>(path, signal);
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: isRemoteMobileMode() ? {} : { 'x-ashlr-read-client': getReadClientProof() },
    signal,
  });
  if (res.status === 401) {
    reportSessionExpired();
    throw new ApiError('Read session expired.', 401, path);
  }
  if (!res.ok) {
    let detail: string | null = null;
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      detail = typeof body.error === 'string' && body.error ? body.error : null;
      code = typeof body.code === 'string' && body.code ? body.code : null;
    } catch {
      /* not JSON */
    }
    throw new ApiError(`GET ${path} failed (HTTP ${res.status}).`, res.status, path, detail, code);
  }
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

export interface ReviewInput {
  chatId: string;
  turnId: string;
  rootId: string;
  file: string;
  hunk?: string;
  decision: VerseCheckpointDecision;
}

export interface CheckpointClient {
  list(chatId: string, signal?: AbortSignal): Promise<VerseCheckpointListResponse>;
  diff(
    q: { chatId: string; turnId: string; rootId: string; mode: VerseCheckpointDiffMode; file?: string | null },
    signal?: AbortSignal,
  ): Promise<VerseCheckpointDiffResponse>;
  review(input: ReviewInput): Promise<VerseCheckpointReviewResponse>;
  previewUndo(chatId: string, turnId: string): Promise<VerseCheckpointPreviewResponse>;
  previewRedo(chatId: string): Promise<VerseCheckpointPreviewResponse>;
  apply(chatId: string, previewId: string, resolutions: Record<string, Record<string, VerseCheckpointResolution>>): Promise<VerseCheckpointApplyResponse>;
}

export const checkpointClient: CheckpointClient = {
  list: (chatId, signal) => get(`${CHECKPOINTS_API}?${new URLSearchParams({ chatId }).toString()}`, signal),
  diff: (q, signal) => {
    const params = new URLSearchParams({ chatId: q.chatId, turnId: q.turnId, rootId: q.rootId, mode: q.mode });
    if (q.file) params.set('file', q.file);
    return get(`${CHECKPOINTS_API}/diff?${params.toString()}`, signal);
  },
  review: (input) => post(`${CHECKPOINTS_API}/review`, input),
  previewUndo: (chatId, turnId) => post(`${CHECKPOINTS_API}/undo/preview`, { chatId, turnId }),
  previewRedo: (chatId) => post(`${CHECKPOINTS_API}/redo/preview`, { chatId }),
  apply: (chatId, previewId, resolutions) => post(`${CHECKPOINTS_API}/apply`, { chatId, previewId, resolutions }),
};

/** One operator sentence for a failed checkpoint call. */
export function describeCheckpointError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; status?: number; detail?: string | null };
    if (e.name === 'DispatchDisabledError') return 'This server is read-only (started without dispatch), so changes cannot be restored here.';
    if (e.name === 'VerseMutationLockedError') return 'Unlock actions with the mutation token first.';
    if (e.status === 401) return 'The mutation token was rejected. Unlock again with the token `ashlr verse` printed.';
    if (e.detail) return e.detail;
    if (e.status === 404) return 'This server has no checkpoint routes yet. Update Phantom and restart `ashlr verse`.';
  }
  return 'The checkpoint action failed.';
}

export function errorCode(err: unknown): string | null {
  return err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : null;
}

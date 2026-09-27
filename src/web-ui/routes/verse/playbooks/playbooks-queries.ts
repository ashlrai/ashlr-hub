/**
 * routes/verse/playbooks/playbooks-queries.ts — the reads and the one write
 * behind the Playbooks section (core/verse/playbooks-api.ts).
 *
 *   GET  /api/verse/playbooks                  → PlaybooksListResponse
 *   GET  /api/verse/playbooks/<id>[?version=N] → PlaybookDetailResponse
 *   POST /api/verse/playbooks                  → PlaybookSaveResponse (a NEW version)
 *
 * The list read is optional (an older server has no route: the composer's
 * `!` menu and the ⋯ sheet then say so instead of failing). Writes pull the
 * held mutation token, touch the hold, and invalidate what they change.
 */
import {
  VERSE_PLAYBOOKS_PATH,
  type PlaybookDetailResponse,
  type PlaybookSaveRequest,
  type PlaybookSaveResponse,
  type PlaybooksListResponse,
  type PlaybookSummary,
} from '../../../../core/playbooks/types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const PLAYBOOKS_KEY = 'verse-playbooks';
const detailKeyOf = (id: string, version: number | null) => `verse-playbook:${id}:${version ?? 'latest'}`;

/** The list, or why there is none. `value: null` ⇒ `reason` says why. */
export interface PlaybooksRead {
  value: PlaybookSummary[] | null;
  available: boolean;
  reason: string | null;
}

function narrowList(raw: unknown): PlaybookSummary[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const rows = (raw as { playbooks?: unknown }).playbooks;
  return Array.isArray(rows) ? (rows as PlaybookSummary[]) : null;
}

/**
 * The list as an optional read: a 404 (no route in this build) or an
 * unreachable server resolves with a reason instead of throwing. Kept free
 * of the command surface's helpers: the composer's `!` menu imports this,
 * and the composer is on the chat's first paint.
 */
export const playbooksQuery: QueryDef<PlaybooksRead> = {
  key: PLAYBOOKS_KEY,
  fetch: async (signal) => {
    try {
      const value = narrowList(await apiGet<unknown>(VERSE_PLAYBOOKS_PATH, signal));
      return value ? { value, available: true, reason: null } : { value: null, available: true, reason: 'Unrecognized response — update Ashlr.' };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      const missing = err instanceof ApiError && err.status === 404;
      return { value: null, available: false, reason: missing ? 'Playbooks are not in this build yet.' : 'Playbooks could not be read.' };
    }
  },
};

export function playbookDetailQuery(id: string, version: number | null): QueryDef<PlaybookDetailResponse> {
  const suffix = version === null ? '' : `?version=${version}`;
  return {
    key: detailKeyOf(id, version),
    fetch: (signal) => apiGet<PlaybookDetailResponse>(`${VERSE_PLAYBOOKS_PATH}/${encodeURIComponent(id)}${suffix}`, signal),
  };
}

/** Save = create (new id) or a new version (existing id). Never rewrites a version. */
export async function savePlaybookSource(request: PlaybookSaveRequest): Promise<PlaybookSaveResponse> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const res = await apiPost<PlaybookSaveResponse>(VERSE_PLAYBOOKS_PATH, request, token);
  touchMutationHold();
  if (res.ok) {
    invalidate(PLAYBOOKS_KEY);
    invalidate(detailKeyOf(res.playbook.meta.id, null));
  }
  return res;
}

export type { PlaybooksListResponse };

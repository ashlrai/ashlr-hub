/**
 * routes/verse/verse-queries.ts — every /api/verse/* call the Verse console
 * makes. Reads are QueryDefs consumed through useQuery (cache-backed, so a
 * sidebar refresh never blanks the list); writes are wrapped like
 * data/mutations.ts's helpers — they pull the held mutation token from
 * auth-store, touch the hold on success, and invalidate the cache keys they
 * obviously affect. Nothing here ever sees launcher commands or env: the
 * server strips those before any payload leaves it (docs/VERSE-CONTRACT-V1).
 */
import type {
  VerseBootstrap,
  VerseCreateSessionRequest,
  VerseSession,
  VerseSessionDetail,
  VerseTurnRequest,
  VerseTurnResponse,
} from '../../data/api-types.js';
import { getMutationToken, touchMutationHold } from '../../data/auth-store.js';
import { apiGet, apiPost } from '../../data/client.js';
import { invalidate } from '../../data/cache.js';
import type { QueryDef } from '../../data/queries.js';

export const VERSE_BOOTSTRAP_KEY = 'verse-bootstrap';
export const VERSE_SESSIONS_KEY = 'verse-sessions';

export const verseBootstrapQuery: QueryDef<VerseBootstrap> = {
  key: VERSE_BOOTSTRAP_KEY,
  fetch: (signal) => apiGet<VerseBootstrap>('/api/verse/bootstrap', signal),
};

export const verseSessionsQuery: QueryDef<VerseSession[]> = {
  key: VERSE_SESSIONS_KEY,
  fetch: (signal) => apiGet<VerseSession[]>('/api/verse/sessions', signal),
};

export function verseSessionPath(sessionId: string, suffix = ''): string {
  return `/api/verse/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

export function fetchVerseSessionDetail(sessionId: string, signal?: AbortSignal): Promise<VerseSessionDetail> {
  return apiGet<VerseSessionDetail>(verseSessionPath(sessionId), signal);
}

export class VerseMutationLockedError extends Error {
  constructor() {
    super('Unlock actions with the mutation token before chatting.');
    this.name = 'VerseMutationLockedError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/** Sidebar + resources panel both read these; refresh them after any write. */
export function invalidateVerseLists(): void {
  invalidate(VERSE_SESSIONS_KEY);
  invalidate(VERSE_BOOTSTRAP_KEY);
}

export async function createVerseSession(req: VerseCreateSessionRequest): Promise<VerseSession> {
  const session = await post<VerseSession>('/api/verse/sessions', req);
  invalidateVerseLists();
  return session;
}

export async function sendVerseTurn(sessionId: string, text: string): Promise<VerseTurnResponse> {
  const body: VerseTurnRequest = { text };
  const response = await post<VerseTurnResponse>(verseSessionPath(sessionId, '/turns'), body);
  invalidate(VERSE_SESSIONS_KEY);
  return response;
}

export async function cancelVerseTurn(sessionId: string): Promise<void> {
  await post<{ ok: true }>(verseSessionPath(sessionId, '/cancel'), {});
  invalidate(VERSE_SESSIONS_KEY);
}

export async function deleteVerseSession(sessionId: string): Promise<void> {
  await post<{ ok: true }>(verseSessionPath(sessionId, '/delete'), {});
  invalidateVerseLists();
}

export async function renameVerseSession(sessionId: string, title: string): Promise<VerseSession> {
  const session = await post<VerseSession>(verseSessionPath(sessionId, '/rename'), { title });
  invalidate(VERSE_SESSIONS_KEY);
  return session;
}

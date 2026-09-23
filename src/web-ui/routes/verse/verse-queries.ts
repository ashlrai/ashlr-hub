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
  VerseAutonomyScopeView,
  VerseBootstrap,
  VerseCreateSessionRequest,
  VerseRootPriority,
  VerseSession,
  VerseSessionDetail,
  VerseSessionRootsResponse,
  VerseTurnRequest,
  VerseTurnResponse,
  VerseWorkspace,
  VerseWorkspaceCreateRequest,
  VerseWorkspacesResponse,
  VerseWorkspaceUpdateRequest,
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

// ---------------------------------------------------------------------------
// Workspaces (V2.2)
// ---------------------------------------------------------------------------

export const VERSE_WORKSPACES_KEY = 'verse-workspaces';
export const VERSE_AUTONOMY_SCOPE_KEY = 'verse-autonomy-scope';

export const verseWorkspacesQuery: QueryDef<VerseWorkspacesResponse> = {
  key: VERSE_WORKSPACES_KEY,
  fetch: (signal) => apiGet<VerseWorkspacesResponse>('/api/verse/workspaces', signal),
};

/**
 * Enrolled repos, ordered by section focus and priority. Kept on its own key
 * from `verseScopeQuery` (which is the raw registry) so a re-rank refreshes
 * the ORDER without re-reading enrollment — and so it is obvious in the cache
 * that these are two different facts.
 */
export const verseAutonomyScopeQuery: QueryDef<VerseAutonomyScopeView> = {
  key: VERSE_AUTONOMY_SCOPE_KEY,
  fetch: (signal) => apiGet<VerseAutonomyScopeView>('/api/verse/autonomy-scope', signal),
};

/**
 * Per-root identity for one session: branch, dirty state, remote, whether the
 * engine can reach each root and whether the autonomous lane would.
 *
 * Deliberately NOT cached by session id alone at module scope — a branch goes
 * stale the moment a turn commits, so the panel refetches it per open.
 */
export function fetchVerseSessionRoots(sessionId: string, signal?: AbortSignal): Promise<VerseSessionRootsResponse> {
  return apiGet<VerseSessionRootsResponse>(verseSessionPath(sessionId, '/roots'), signal);
}

function invalidateWorkspaces(): void {
  invalidate(VERSE_WORKSPACES_KEY);
  invalidate(VERSE_AUTONOMY_SCOPE_KEY);
  invalidate(VERSE_BOOTSTRAP_KEY);
}

export async function createVerseWorkspace(req: VerseWorkspaceCreateRequest): Promise<VerseWorkspace> {
  const workspace = await post<VerseWorkspace>('/api/verse/workspaces', req);
  invalidateWorkspaces();
  return workspace;
}

export async function updateVerseWorkspace(id: string, patch: VerseWorkspaceUpdateRequest): Promise<VerseWorkspace> {
  const workspace = await post<VerseWorkspace>(`/api/verse/workspaces/${encodeURIComponent(id)}/update`, patch);
  invalidateWorkspaces();
  return workspace;
}

export async function deleteVerseWorkspace(id: string): Promise<void> {
  await post<{ ok: true }>(`/api/verse/workspaces/${encodeURIComponent(id)}/delete`, {});
  invalidateWorkspaces();
}

export async function setVerseRootPriority(path: string, priority: VerseRootPriority): Promise<void> {
  await post<unknown>('/api/verse/workspaces/priority', { path, priority });
  invalidateWorkspaces();
}

export async function setVerseFocusSection(sectionId: string | null): Promise<void> {
  await post<unknown>('/api/verse/workspaces/focus', { sectionId });
  invalidateWorkspaces();
}

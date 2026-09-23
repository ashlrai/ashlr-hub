/**
 * routes/verse/context/context-queries.ts — every V3.9 context-orchestration
 * call the Verse console makes (docs/VERSE-CONTEXT.md): context mode, handoff
 * preview + handoff creation, preferences, context fit, session search and
 * shared project memory.
 *
 * Same conventions as ../verse-queries.ts, deliberately:
 *
 *  - WRITES pull the held mutation token from auth-store, throw
 *    `VerseMutationLockedError` (the SAME class, so ChatSection's `fail`
 *    recognises it) when none is held, touch the hold on success, and
 *    invalidate exactly the cache keys they obviously change.
 *  - READS carry the per-tab read-client proof and report an expired read
 *    session, exactly like `apiGet`. They are written out here rather than
 *    routed through `apiGet` for one reason: `apiGet` discards the response
 *    body on a non-2xx, and the routes below answer a refused read ("path is
 *    not a directory", "q must be at least 2 characters") with a sentence
 *    written for a person. Those sentences travel as `ApiError.detail`, the
 *    field `describeControlError` already prefers.
 *
 * NOTHING HERE SPENDS. Every route below is deterministic server work
 * (preferences file, git ls-files, events.jsonl scans, a memory file). The
 * one model call a context feature can cause — "ask this seat to summarize"
 * — goes through the ordinary `sendVerseTurn`, i.e. through the engine's
 * `startTurn` chokepoint and the local-only policy, never through this file.
 *
 * `handoff-preview` is a POST although it only reads: it spawns
 * `git diff --stat` per root, and the API keeps every spawning route behind
 * the dispatch flag and the mutation token. It therefore needs the token like
 * any write, and the dialog says so.
 */
import type { VerseCreateSessionRequest, VerseSession } from '../../../data/api-types.js';
import type {
  VerseContextFit,
  VerseContextMode,
  VerseContextModeRequest,
  VerseHandoffPreview,
  VerseHandoffPreviewRequest,
  VersePreferences,
  VersePreferencesUpdate,
  VerseProjectMemory,
  VerseProjectMemoryWrite,
  VerseSearchResponse,
} from '../../../../core/verse/types.js';
import { getMutationToken, reportSessionExpired, getReadClientProof, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate, invalidatePrefix } from '../../../data/cache.js';
import { ApiError, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { invalidateVerseLists, verseSessionPath, VERSE_SESSIONS_KEY, VerseMutationLockedError } from '../verse-queries.js';
import { setVerseSession } from '../verse-store.js';

export const VERSE_PREFERENCES_KEY = 'verse-preferences';
/** Prefix of every per-project memory key; `invalidatePrefix` reaches all of them. */
export const VERSE_MEMORY_KEY_PREFIX = 'verse-memory:';
/** Prefix of every context-fit key (one per root set). */
export const VERSE_CONTEXT_FIT_KEY_PREFIX = 'verse-context-fit:';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The server's own refusal sentence, when the body carried one. */
async function refusalDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown; note?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.note === 'string' && body.note) return body.note;
  } catch {
    /* not JSON — the status alone has to do */
  }
  return null;
}

/**
 * GET with the read-client proof. Behaves like `apiGet` (401 reports the
 * expired read session) but keeps the server's refusal sentence.
 */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'x-ashlr-read-client': getReadClientProof() },
    signal,
  });
  if (res.status === 401) {
    reportSessionExpired();
    throw new ApiError('Read session expired.', 401, path);
  }
  if (!res.ok) {
    const detail = await refusalDetail(res);
    throw new ApiError(`GET ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`, res.status, path, detail);
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

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

// ---------------------------------------------------------------------------
// Context mode
// ---------------------------------------------------------------------------

/**
 * Switch a session between `standard` and `expansive`. Applies from the next
 * turn (it only changes CLI flags, never prompt content, so the provider's
 * prompt cache survives the switch).
 *
 * The returned record is also written into verse-store, so the meter, the
 * mode chip and the composer hint all move on this response rather than on
 * the next list refresh — whichever component made the call.
 */
export async function setSessionContextMode(sessionId: string, mode: VerseContextMode): Promise<VerseSession> {
  const body: VerseContextModeRequest = { mode };
  const session = await post<VerseSession>(verseSessionPath(sessionId, '/context-mode'), body);
  setVerseSession(sessionId, session);
  invalidate(VERSE_SESSIONS_KEY);
  return session;
}

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

/** Longest focus line the API accepts (types.ts VerseHandoffPreviewRequest). */
export const HANDOFF_FOCUS_MAX_CHARS = 500;

/**
 * Build the deterministic handoff note for a session. Zero spend: the server
 * reads events.jsonl and a bounded `git diff --stat` per root.
 *
 * Only keys that carry a value are sent — the route rejects unknown keys, and
 * `includeLastAssistant: false` is the default anyway, so omitting it keeps
 * the body minimal and the server's validation the single authority.
 */
export async function fetchHandoffPreview(sessionId: string, req: VerseHandoffPreviewRequest = {}): Promise<VerseHandoffPreview> {
  const body: VerseHandoffPreviewRequest = {};
  if (req.includeLastAssistant === true) body.includeLastAssistant = true;
  const focus = typeof req.focus === 'string' ? req.focus.trim().slice(0, HANDOFF_FOCUS_MAX_CHARS) : '';
  if (focus) body.focus = focus;
  return post<VerseHandoffPreview>(verseSessionPath(sessionId, '/handoff-preview'), body);
}

export interface HandoffSessionInput {
  /** The session being handed off. Its PINNED roots are reused, see below. */
  source: VerseSession;
  seatId: string;
  model?: string;
  contextMode?: VerseContextMode;
  /** Optional title; absent → the server titles it from the first message. */
  title?: string;
}

/**
 * Create the session a handoff continues in. FREE: creating a session spawns
 * nothing. The handoff text is NOT sent here — the caller pre-fills the new
 * chat's composer and the operator presses send, so the first (spent) turn is
 * always one the operator read.
 *
 * Roots: the source's PINNED roots (`projectPath` + `extraRoots`), never its
 * `workspaceId`. A session keeps the roots it was created with even if the
 * named workspace was later edited or deleted (types.ts VerseSession
 * `extraRoots`); re-resolving the workspace here would let the continuation
 * silently gain or lose a folder the conversation was about — or fail
 * outright on a deleted workspace. The API also refuses the two spellings
 * mixed, so it is one or the other, and the pinned set is the honest one.
 *
 * The server resolves `handoffFrom.title` from `handoffFromSessionId` itself;
 * nothing about provenance is taken from this body.
 */
export async function createHandoffSession(input: HandoffSessionInput): Promise<VerseSession> {
  const { source } = input;
  const req: VerseCreateSessionRequest = {
    projectPath: source.projectPath,
    seatId: input.seatId,
    handoffFromSessionId: source.id,
  };
  const extras = (source.extraRoots ?? []).filter((root) => typeof root === 'string' && root.length > 0 && root !== source.projectPath);
  if (extras.length > 0) req.extraRoots = extras;
  if (input.model) req.model = input.model;
  if (input.contextMode) req.contextMode = input.contextMode;
  const title = input.title?.trim();
  if (title) req.title = title;
  const session = await post<VerseSession>('/api/verse/sessions', req);
  invalidateVerseLists();
  return session;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function fetchPreferences(signal?: AbortSignal): Promise<VersePreferences> {
  return getJson<VersePreferences>('/api/verse/preferences', signal);
}

export const versePreferencesQuery: QueryDef<VersePreferences> = {
  key: VERSE_PREFERENCES_KEY,
  fetch: (signal) => fetchPreferences(signal),
};

/**
 * Change ONE standing preference (the three request forms are exclusive, so a
 * body never changes more than the operator clicked). Memory records carry an
 * `enabled` flag derived from these preferences, so every cached memory read
 * is refreshed too.
 */
export async function updatePreferences(update: VersePreferencesUpdate): Promise<VersePreferences> {
  const prefs = await post<VersePreferences>('/api/verse/preferences', update);
  invalidate(VERSE_PREFERENCES_KEY);
  invalidatePrefix(VERSE_MEMORY_KEY_PREFIX);
  return prefs;
}

// ---------------------------------------------------------------------------
// Context fit
// ---------------------------------------------------------------------------

export interface ContextFitQuery {
  workspaceId?: string;
  projectPath?: string;
  extraRoots?: string[];
}

/**
 * The query string for a fit request: a workspace id ALONE, or a project path
 * with each extra root as its own repeated `extraRoots` parameter (a path may
 * contain a comma, so a joined list could not be split back honestly). The
 * API refuses the two spellings mixed — refused here first, with the reason.
 */
export function contextFitPath(q: ContextFitQuery): string {
  const params = new URLSearchParams();
  const workspaceId = q.workspaceId?.trim() ?? '';
  const projectPath = q.projectPath?.trim() ?? '';
  const extras = (q.extraRoots ?? []).map((r) => r.trim()).filter((r) => r.length > 0);
  if (workspaceId) {
    if (projectPath || extras.length > 0) throw new Error('Estimate a workspace or a folder set, not both.');
    params.set('workspaceId', workspaceId);
  } else if (projectPath) {
    params.set('projectPath', projectPath);
    for (const root of extras) params.append('extraRoots', root);
  } else {
    throw new Error('Pick a project or a workspace to estimate.');
  }
  return withQuery('/api/verse/context-fit', params);
}

/** How big the reachable code is, in estimated tokens. Zero spend (git ls-files + stat). */
export function fetchContextFit(q: ContextFitQuery, signal?: AbortSignal): Promise<VerseContextFit> {
  return getJson<VerseContextFit>(contextFitPath(q), signal);
}

/** Cache-backed form, keyed by the exact root set, for pickers that re-render often. */
export function verseContextFitQuery(q: ContextFitQuery): QueryDef<VerseContextFit> {
  const path = contextFitPath(q);
  return { key: `${VERSE_CONTEXT_FIT_KEY_PREFIX}${path}`, fetch: (signal) => getJson<VerseContextFit>(path, signal) };
}

// ---------------------------------------------------------------------------
// Session search
// ---------------------------------------------------------------------------

/** The API caps `limit` at 50 (session-search.ts); asking for more is refused, so clamp. */
export const SEARCH_LIMIT_MAX = 50;

/** Keyword search over past sessions' messages. Zero spend — a bounded scan of events.jsonl. */
export function searchSessions(q: string, limit?: number, signal?: AbortSignal): Promise<VerseSearchResponse> {
  const params = new URLSearchParams({ q });
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    params.set('limit', String(Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit)))));
  }
  return getJson<VerseSearchResponse>(withQuery('/api/verse/search', params), signal);
}

// ---------------------------------------------------------------------------
// Shared project memory
// ---------------------------------------------------------------------------

/**
 * The memory record as the browser receives it. The server's public-JSON
 * sanitizer rewrites the home folder as `~` and secret-shaped text as
 * `[REDACTED]` on the way out, so `content` can differ from the file on disk;
 * the route then adds `contentSanitized: true` (absent otherwise). Declared
 * here, not in types.ts: that contract is frozen and the flag is additive.
 */
export type VerseProjectMemoryView = VerseProjectMemory & { contentSanitized?: boolean };

export function verseProjectMemoryKey(projectPath: string): string {
  return `${VERSE_MEMORY_KEY_PREFIX}${projectPath}`;
}

export function fetchProjectMemory(projectPath: string, signal?: AbortSignal): Promise<VerseProjectMemoryView> {
  return getJson<VerseProjectMemoryView>(withQuery('/api/verse/memory', new URLSearchParams({ projectPath })), signal);
}

export function verseProjectMemoryQuery(projectPath: string): QueryDef<VerseProjectMemoryView> {
  return { key: verseProjectMemoryKey(projectPath), fetch: (signal) => fetchProjectMemory(projectPath, signal) };
}

/**
 * Replace MEMORY.md for a project (atomic, 0600 on the server, capped at
 * VERSE_MEMORY_MAX_BYTES). `''` clears it. Chats already open keep the block
 * pinned in their instructions at creation; they see the change when they
 * next read the file.
 */
export async function writeProjectMemory(projectPath: string, content: string): Promise<VerseProjectMemoryView> {
  const body: VerseProjectMemoryWrite = { projectPath, content };
  const memory = await post<VerseProjectMemoryView>('/api/verse/memory', body);
  invalidate(verseProjectMemoryKey(projectPath));
  return memory;
}

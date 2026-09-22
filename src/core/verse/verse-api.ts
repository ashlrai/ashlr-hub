/**
 * core/verse/verse-api.ts — /api/verse/* routes (owner B).
 *
 * Mounted from src/core/web/api.ts's handleApi() before its 404 fallthrough.
 * Same security posture as every other route there:
 *   - GETs sit behind the read-session boundary in server.ts.
 *   - POSTs are 404 unless ctx.allowDispatch, then passesMutationGate()
 *     (constant-time x-ashlr-token + JSON Content-Type), then readBody()
 *     (64 KB cap).
 *   - Every response goes through sendJson() → sanitizePublicJson().
 *
 * Routes (see docs/VERSE-CONTRACT-V1.md):
 *   GET  /api/verse/bootstrap                → VerseBootstrap
 *   GET  /api/verse/seats                    → VerseSeatsResponse (pollable)
 *   GET  /api/verse/sessions                 → VerseSession[]
 *   POST /api/verse/sessions                 → VerseSession (201)
 *   GET  /api/verse/sessions/:id             → VerseSessionDetail
 *   POST /api/verse/sessions/:id/turns       → VerseTurnResponse (202)
 *   POST /api/verse/sessions/:id/cancel      → { ok: true }
 *   POST /api/verse/sessions/:id/delete      → { ok: true }
 *   POST /api/verse/sessions/:id/rename      → VerseSession
 *   GET  /api/verse/sessions/:id/events      → SSE (verse-stream.ts)
 *
 * Errors: { error, code? } with VERSE_SESSION_NOT_FOUND 404,
 * VERSE_SESSION_BUSY 409, VERSE_INVALID 400, VERSE_TOO_LARGE 413.
 *
 * ENGINE LIFETIME: one engine handle per server process — a module-level
 * lazy singleton (`getVerseEngine()`), with `resetVerseEngine()` for tests to
 * inject a fake or force re-creation under a relocated HOME. The engine
 * module is loaded lazily (dynamic import) so this file has no load-time
 * dependency on it; tests that inject a fake never touch it.
 *
 * PRIVACY: seat launchers (the native-profile commands) come from seats.ts's
 * private `launches` map and go straight to engine.createSession(). They are
 * never part of any response, log line, or session record this file writes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { checkWorkspaceRootPath, expandHomePrefix } from './path-guard.js';
import { discoverProjects } from './projects.js';
import { discoverSeats, refreshSeatTelemetry, type VerseSeatDiscovery } from './seats.js';
import {
  buildAutonomyScopeView,
  createVerseWorkspaceStore,
  describeRoots,
  rootNotes,
  VerseWorkspaceError,
  type VerseWorkspaceStore,
} from './workspaces.js';
import type { VerseEngineHandle } from './session-engine.js';
import {
  VERSE_MAX_TURN_TEXT_BYTES,
  VERSE_MAX_WORKSPACE_ROOTS,
  VERSE_ROOT_PRIORITIES,
  type VerseAutonomyScopeView,
  type VerseBootstrap,
  type VerseCreateSessionRequest,
  type VerseRootPriority,
  type VerseRootStatus,
  type VerseSeatsResponse,
  type VerseSession,
  type VerseSessionDetail,
  type VerseSessionRootsResponse,
  type VerseTurnResponse,
  type VerseWorkspace,
  type VerseWorkspacesResponse,
  verseSessionRoots,
} from './types.js';
import { handleVerseEventsSse, VERSE_EVENTS_PATH_RE, VERSE_SESSION_ID_RE } from './verse-stream.js';

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export const VERSE_API_PREFIX = '/api/verse';

export function isVerseApiPath(path: string): boolean {
  return path === VERSE_API_PREFIX || path.startsWith(`${VERSE_API_PREFIX}/`);
}

export interface VerseApiContext {
  cfg: AshlrConfig;
  token: string;
  allowDispatch: boolean;
  readSession?: { id: string; expiresAt: number };
}

// ---------------------------------------------------------------------------
// Engine singleton
// ---------------------------------------------------------------------------

let engineSingleton: VerseEngineHandle | null = null;
let enginePending: Promise<VerseEngineHandle> | null = null;

/** Return the engine if one has been created in this process (never creates one). */
export function peekVerseEngine(): VerseEngineHandle | null {
  return engineSingleton;
}

/**
 * Lazily create the per-process engine. Root defaults to
 * ~/.ashlr/verse (resolved at first use, so a relocated HOME is honored).
 */
export async function getVerseEngine(): Promise<VerseEngineHandle> {
  if (engineSingleton) return engineSingleton;
  if (!enginePending) {
    enginePending = import('./session-engine.js')
      .then((mod) => {
        const created = mod.createVerseEngine({ root: join(homedir(), '.ashlr', 'verse') });
        engineSingleton = created;
        return created;
      })
      .finally(() => { enginePending = null; });
  }
  return enginePending;
}

/**
 * Test/reset hook: close the current engine (if any) and install `next`
 * (or none, so the next request re-creates one). Also drops the seat cache.
 */
export function resetVerseEngine(next: VerseEngineHandle | null = null): void {
  const prev = engineSingleton;
  engineSingleton = next;
  enginePending = null;
  seatCache = null;
  if (prev && prev !== next) {
    try { prev.close(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Seat discovery cache (bounded; bootstrap + create both need it)
// ---------------------------------------------------------------------------

const SEAT_CACHE_MS = 3_000;
let seatCache: { value: VerseSeatDiscovery; expiresAt: number; cfg: AshlrConfig } | null = null;
let seatInFlight: Promise<VerseSeatDiscovery> | null = null;

async function cachedSeats(cfg: AshlrConfig): Promise<VerseSeatDiscovery> {
  const now = Date.now();
  if (seatCache && seatCache.cfg === cfg && now < seatCache.expiresAt) return seatCache.value;
  if (seatInFlight) return seatInFlight;
  seatInFlight = discoverSeats(cfg)
    .then((value) => {
      seatCache = { value, expiresAt: Date.now() + SEAT_CACHE_MS, cfg };
      return value;
    })
    .finally(() => { seatInFlight = null; });
  return seatInFlight;
}

/** Drop the cached seat discovery (after account changes, or in tests). */
export function invalidateVerseSeatCache(): void {
  seatCache = null;
}

// ---------------------------------------------------------------------------
// Workspace registry singleton
// ---------------------------------------------------------------------------

let workspaceStore: VerseWorkspaceStore | null = null;

/**
 * The workspace registry, rooted next to the session store so the two share
 * one 0700 directory and one relocation story. Resolved at FIRST USE, not at
 * module load, so a relocated HOME is honored exactly as `getVerseEngine()`
 * does it.
 */
export function getVerseWorkspaceStore(): VerseWorkspaceStore {
  if (!workspaceStore) {
    workspaceStore = createVerseWorkspaceStore({ root: join(homedir(), '.ashlr', 'verse') });
  }
  return workspaceStore;
}

/** Test hook: drop the memoized store so the next call re-reads under a new HOME. */
export function resetVerseWorkspaceStore(next: VerseWorkspaceStore | null = null): void {
  workspaceStore = next;
}

/**
 * Seats with LIVE telemetry, for every read that a human looks at.
 *
 * `cachedSeats` caches seat IDENTITY — which accounts exist, which Ollama tags
 * are installed — because discovering it costs one HTTP round trip per model.
 * Account TELEMETRY is cheap and changes every collector cycle, so it is
 * recomputed here on every read. Without this split a bootstrap served from a
 * warm cache could hand back the "unknown" health that was captured before the
 * collector's first cycle finished, which is exactly the bug the Resources
 * panel showed all day.
 */
async function liveSeats(cfg: AshlrConfig): Promise<VerseSeatDiscovery> {
  return refreshSeatTelemetry(cfg, await cachedSeats(cfg));
}

// ---------------------------------------------------------------------------
// Sessions digest for the /api/events poll
// ---------------------------------------------------------------------------

/**
 * A cheap, deterministic digest of the session list — the /api/events poll
 * emits `verse-sessions` only when this changes. Empty string when no engine
 * exists yet (nothing to refresh).
 */
export function verseSessionsDigest(): string {
  const engine = engineSingleton;
  if (!engine) return '';
  try {
    return engine
      .listSessions()
      .map((s) => `${s.id}:${s.status}:${s.updatedAt}:${s.turnCount}:${s.title}`)
      .join('|');
  } catch {
    return '';
  }
}

/** Current sessions for the /api/events push (empty when no engine yet). */
export function verseSessionsSnapshot(): VerseSession[] {
  const engine = engineSingleton;
  if (!engine) return [];
  try {
    return engine.listSessions();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

type VerseErrorCode = 'VERSE_SESSION_NOT_FOUND' | 'VERSE_SESSION_BUSY' | 'VERSE_INVALID' | 'VERSE_TOO_LARGE';

const VERSE_ERROR_STATUS: Record<VerseErrorCode, 404 | 409 | 400 | 413> = {
  VERSE_SESSION_NOT_FOUND: 404,
  VERSE_SESSION_BUSY: 409,
  VERSE_INVALID: 400,
  VERSE_TOO_LARGE: 413,
};

function isVerseErrorCode(value: unknown): value is VerseErrorCode {
  return typeof value === 'string' && value in VERSE_ERROR_STATUS;
}

/**
 * Duck-typed (not instanceof) so a VerseError thrown by another module
 * instance — or a test fake — still maps to the contract's status codes.
 */
function sendVerseError(res: ServerResponse, err: unknown): void {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (isVerseErrorCode(code)) {
      const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? code);
      sendJson(res, VERSE_ERROR_STATUS[code], { code, error: message });
      return;
    }
  }
  sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'internal server error' });
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** readBody() + JSON.parse with the contract's error shape. Returns null after responding. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (!isRecord(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed;
}

const MAX_TITLE_CHARS = 200;
const MAX_PATH_CHARS = 4096;

/**
 * sanitizePublicJson() rewrites the home directory as `~` on every outbound
 * payload, so a project path the UI read from bootstrap comes back as
 * `~/...`. Expand it here so round-trips validate against the real path.
 *
 * Defined in `path-guard.ts` (the deny-root checker needs it before anything
 * else runs) and re-exported here, which is the import path every existing
 * caller and test already uses.
 */
export { expandHomePrefix };

/**
 * Validate the shared half of a create request (seat, model, title).
 * Returns null after responding.
 */
function parseSeatFields(
  body: Record<string, unknown>,
  res: ServerResponse,
): { seatId: string; model?: string; title?: string } | null {
  const seatId = body['seatId'];
  const model = body['model'];
  const title = body['title'];
  if (typeof seatId !== 'string' || seatId.trim().length === 0) {
    sendInvalid(res, 'seatId is required');
    return null;
  }
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    sendInvalid(res, 'model must be a non-empty string');
    return null;
  }
  if (title !== undefined && (typeof title !== 'string' || title.length > MAX_TITLE_CHARS)) {
    sendInvalid(res, `title must be a string of at most ${MAX_TITLE_CHARS} characters`);
    return null;
  }
  const out: { seatId: string; model?: string; title?: string } = { seatId: seatId.trim() };
  if (typeof model === 'string') out.model = model;
  if (typeof title === 'string' && title.trim().length > 0) out.title = title.trim();
  return out;
}

/**
 * Parse a create request in either of its two spellings.
 *
 * `workspaceId` and the path spelling are MUTUALLY EXCLUSIVE and the mix is
 * rejected rather than resolved: silently preferring one would mean the
 * operator's stated roots and the session's actual roots could differ, and
 * that difference is exactly what a workspace exists to make legible.
 *
 * Every path — primary and extra alike — goes through the same deny-root
 * guard the enrollment registry uses, so `~/.ashlr` (provider tokens, the
 * KILL sentinel, the 0600 launcher records) can never become a session root.
 */
function parseCreateRequest(
  body: Record<string, unknown>,
  res: ServerResponse,
  store: VerseWorkspaceStore,
): VerseCreateSessionRequest | null {
  const seatFields = parseSeatFields(body, res);
  if (!seatFields) return null;

  const workspaceId = body['workspaceId'];
  const projectPath = body['projectPath'];
  const extraRoots = body['extraRoots'];

  if (workspaceId !== undefined) {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      sendInvalid(res, 'workspaceId must be a non-empty string');
      return null;
    }
    if (projectPath !== undefined || extraRoots !== undefined) {
      sendInvalid(res, 'send workspaceId or projectPath/extraRoots, not both');
      return null;
    }
    const workspace = store.get(workspaceId.trim());
    if (!workspace) {
      sendInvalid(res, `unknown workspace: ${workspaceId.trim()}`);
      return null;
    }
    const primary = workspace.roots.find((r) => r.primary) ?? workspace.roots[0];
    if (!primary) {
      sendInvalid(res, `workspace ${workspace.name} has no roots`);
      return null;
    }
    const rest = workspace.roots.filter((r) => r.path !== primary.path).map((r) => r.path);
    return {
      projectPath: primary.path,
      ...(rest.length > 0 ? { extraRoots: rest } : {}),
      workspaceId: workspace.id,
      // Read from the registry, never from the body.
      workspaceName: workspace.name,
      ...seatFields,
    };
  }

  if (typeof projectPath !== 'string' || projectPath.trim().length === 0 || projectPath.length > MAX_PATH_CHARS) {
    sendInvalid(res, 'projectPath is required');
    return null;
  }
  const primaryCheck = checkWorkspaceRootPath(projectPath.trim());
  if (!primaryCheck.ok) {
    sendInvalid(res, primaryCheck.error);
    return null;
  }

  const resolvedExtras: string[] = [];
  if (extraRoots !== undefined) {
    if (!Array.isArray(extraRoots)) {
      sendInvalid(res, 'extraRoots must be an array of absolute paths');
      return null;
    }
    if (extraRoots.length > VERSE_MAX_WORKSPACE_ROOTS - 1) {
      sendInvalid(res, `a session may have at most ${VERSE_MAX_WORKSPACE_ROOTS} roots`);
      return null;
    }
    for (const raw of extraRoots) {
      if (typeof raw !== 'string' || raw.length > MAX_PATH_CHARS) {
        sendInvalid(res, 'every extra root must be an absolute path');
        return null;
      }
      const check = checkWorkspaceRootPath(raw.trim());
      if (!check.ok) {
        sendInvalid(res, check.error);
        return null;
      }
      if (check.path !== primaryCheck.path && !resolvedExtras.includes(check.path)) {
        resolvedExtras.push(check.path);
      }
    }
  }

  return {
    projectPath: primaryCheck.path,
    ...(resolvedExtras.length > 0 ? { extraRoots: resolvedExtras } : {}),
    ...seatFields,
  };
}

// ---------------------------------------------------------------------------
// Workspace routes
// ---------------------------------------------------------------------------

/** A `VerseWorkspaceError` carries the contract's 400; anything else rethrows. */
function sendWorkspaceError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof VerseWorkspaceError) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: err.message });
    return true;
  }
  throw err;
}

function parseRootsField(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > VERSE_MAX_WORKSPACE_ROOTS) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > MAX_PATH_CHARS) return null;
    out.push(entry.trim());
  }
  return out;
}

function isRootPriority(value: unknown): value is VerseRootPriority {
  return typeof value === 'string' && (VERSE_ROOT_PRIORITIES as readonly string[]).includes(value);
}

/** Workspaces + their live per-root facts + priorities, in one read. */
function workspacesResponse(store: VerseWorkspaceStore): VerseWorkspacesResponse {
  const workspaces: VerseWorkspace[] = store.list();
  const status: Record<string, VerseRootStatus[]> = {};
  for (const workspace of workspaces) {
    status[workspace.id] = describeRoots(workspace.roots.map((r) => r.path));
  }
  return {
    workspaces,
    status,
    priorities: store.priorities(),
    focusSectionId: store.focusSectionId(),
  };
}

/**
 * `/api/verse/workspaces[...]`.
 *
 * GETs are readable like every other Verse GET. Every mutation is a POST
 * behind `allowDispatch` + `passesMutationGate`, the same gate the session
 * routes use — a workspace decides what an agent can write to, so it is a
 * control-plane change, not a preference.
 */
async function handleWorkspaces(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  const store = getVerseWorkspaceStore();
  const prefix = `${VERSE_API_PREFIX}/workspaces`;

  if (path === prefix && method === 'GET') {
    sendJson(res, 200, workspacesResponse(store));
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  const body = await readJsonBody(req, res);
  if (!body) return true;

  try {
    // POST /api/verse/workspaces — create
    if (path === prefix) {
      const roots = parseRootsField(body['roots']);
      if (!roots) {
        sendInvalid(res, `roots must be 1-${VERSE_MAX_WORKSPACE_ROOTS} absolute paths`);
        return true;
      }
      const created = store.create(String(body['name'] ?? ''), roots, body['section'] === true);
      sendJson(res, 201, created);
      return true;
    }

    const rest = path.slice(`${prefix}/`.length).split('/');

    // POST /api/verse/workspaces/priority — rank one repo
    if (rest.length === 1 && rest[0] === 'priority') {
      const target = body['path'];
      const priority = body['priority'];
      if (typeof target !== 'string' || target.trim().length === 0 || target.length > MAX_PATH_CHARS) {
        sendInvalid(res, 'path is required');
        return true;
      }
      if (!isRootPriority(priority)) {
        sendInvalid(res, `priority must be one of ${VERSE_ROOT_PRIORITIES.join(', ')}`);
        return true;
      }
      const priorities = store.setPriority(target.trim(), priority);
      // Echo the ranked scope so the caller sees the ORDER it just changed,
      // and sees that ranking did not widen it.
      sendJson(res, 200, { ok: true, priorities, scope: buildAutonomyScopeView(store) });
      return true;
    }

    // POST /api/verse/workspaces/focus — focus one section, or clear it
    if (rest.length === 1 && rest[0] === 'focus') {
      const sectionId = body['sectionId'];
      if (sectionId !== null && (typeof sectionId !== 'string' || sectionId.trim().length === 0)) {
        sendInvalid(res, 'sectionId must be a workspace id or null');
        return true;
      }
      const focusSectionId = store.setFocusSection(sectionId === null ? null : sectionId.trim());
      sendJson(res, 200, { ok: true, focusSectionId, scope: buildAutonomyScopeView(store) });
      return true;
    }

    // POST /api/verse/workspaces/:id/(update|delete)
    const id = rest[0] ?? '';
    const action = rest[1] ?? '';
    if (!id || rest.length !== 2) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    if (action === 'delete') {
      if (!store.remove(id)) {
        sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `workspace not found: ${id}` });
        return true;
      }
      // Sessions already created from this workspace keep their PINNED roots
      // — deleting the definition never narrows or widens a live chat.
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action !== 'update') {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    const patch: { name?: string; roots?: string[]; section?: boolean } = {};
    if (body['name'] !== undefined) {
      if (typeof body['name'] !== 'string') {
        sendInvalid(res, 'name must be a string');
        return true;
      }
      patch.name = body['name'];
    }
    if (body['roots'] !== undefined) {
      const roots = parseRootsField(body['roots']);
      if (!roots) {
        sendInvalid(res, `roots must be 1-${VERSE_MAX_WORKSPACE_ROOTS} absolute paths`);
        return true;
      }
      patch.roots = roots;
    }
    if (body['section'] !== undefined) patch.section = body['section'] === true;
    sendJson(res, 200, store.update(id, patch));
    return true;
  } catch (err) {
    return sendWorkspaceError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle one /api/verse/* request. Returns true when a response was written
 * (including error responses); false when `path` is not a verse route so
 * handleApi can continue to its own 404.
 */
export async function handleVerseApi(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (!isVerseApiPath(path)) return false;

  try {
    // ── GET /api/verse/bootstrap ─────────────────────────────────────────
    if (path === `${VERSE_API_PREFIX}/bootstrap` && method === 'GET') {
      const engine = await getVerseEngine();
      const discovery = await liveSeats(ctx.cfg);
      const sessions = engine.listSessions();
      const body: VerseBootstrap = {
        seats: discovery.seats,
        projects: discoverProjects({ sessions }),
        sessions,
        workspaces: getVerseWorkspaceStore().list(),
        dispatchEnabled: ctx.allowDispatch,
        localRuntime: discovery.localRuntime,
      };
      sendJson(res, 200, body);
      return true;
    }

    // ── GET /api/verse/seats ─────────────────────────────────────────────
    // The seat half of bootstrap, on its own so a client can POLL it. Bootstrap
    // is read once at mount; a user who opened the app before the account
    // collector's first cycle finished would otherwise keep a seat list that
    // says "unknown" forever, with no way to learn otherwise short of a reload.
    if (path === `${VERSE_API_PREFIX}/seats` && method === 'GET') {
      const discovery = await liveSeats(ctx.cfg);
      const body: VerseSeatsResponse = {
        sampledAt: new Date().toISOString(),
        seats: discovery.seats,
        localRuntime: discovery.localRuntime,
      };
      sendJson(res, 200, body);
      return true;
    }

    // ── /api/verse/workspaces ────────────────────────────────────────────
    // A workspace is NOT enrollment and cannot become it: nothing under this
    // prefix touches ~/.ashlr/enrollment.json. Mutations sit behind the same
    // dispatch gate as every other POST here.
    if (path === `${VERSE_API_PREFIX}/workspaces` || path.startsWith(`${VERSE_API_PREFIX}/workspaces/`)) {
      return handleWorkspaces(ctx, req, res, path, method);
    }

    // ── /api/verse/autonomy-scope ────────────────────────────────────────
    // Enrolled repos, ORDERED by section focus and priority. Read-only, and
    // derived by intersecting sections with the enrollment registry — so it
    // is always a subset of what the autonomous lane already reaches.
    if (path === `${VERSE_API_PREFIX}/autonomy-scope` && method === 'GET') {
      const view: VerseAutonomyScopeView = buildAutonomyScopeView(getVerseWorkspaceStore());
      sendJson(res, 200, view);
      return true;
    }

    // ── /api/verse/sessions ──────────────────────────────────────────────
    if (path === `${VERSE_API_PREFIX}/sessions`) {
      if (method === 'GET') {
        const engine = await getVerseEngine();
        sendJson(res, 200, engine.listSessions());
        return true;
      }
      if (method === 'POST') {
        if (!ctx.allowDispatch) {
          sendJson(res, 404, { error: 'not found' });
          return true;
        }
        if (!passesMutationGate(req, res, ctx.token)) return true;
        const body = await readJsonBody(req, res);
        if (!body) return true;
        const create = parseCreateRequest(body, res, getVerseWorkspaceStore());
        if (!create) return true;
        const discovery = await cachedSeats(ctx.cfg);
        const launch = discovery.launches.get(create.seatId);
        if (!launch) {
          sendInvalid(res, `unknown seat: ${create.seatId}`);
          return true;
        }
        const engine = await getVerseEngine();
        const session = engine.createSession(create, launch);
        sendJson(res, 201, session);
        return true;
      }
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    // ── GET /api/verse/sessions/:id/events (SSE) ─────────────────────────
    const eventsMatch = VERSE_EVENTS_PATH_RE.exec(path);
    if (eventsMatch && method === 'GET') {
      if (!ctx.readSession || ctx.readSession.expiresAt <= Date.now()) {
        sendJson(res, 401, { code: 'SESSION_REQUIRED', error: 'valid read session required' });
        return true;
      }
      const engine = await getVerseEngine();
      handleVerseEventsSse(req, res, engine, eventsMatch[1] ?? '', ctx.readSession);
      return true;
    }

    // ── /api/verse/sessions/:id[/action] ─────────────────────────────────
    const sessionsPrefix = `${VERSE_API_PREFIX}/sessions/`;
    if (path.startsWith(sessionsPrefix)) {
      const parts = path.slice(sessionsPrefix.length).split('/');
      const id = parts[0] ?? '';
      const action = parts[1] ?? '';
      if (!id || parts.length > 2) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!VERSE_SESSION_ID_RE.test(id)) {
        sendInvalid(res, 'invalid session id');
        return true;
      }

      // GET /api/verse/sessions/:id/roots
      //
      // Per-root identity for the session: branch, dirty state and remote for
      // each root, whether the engine can actually reach it, and whether the
      // autonomous lane would. Computed live rather than stored, because a
      // branch recorded at session creation would be wrong by the next commit.
      if (method === 'GET' && action === 'roots') {
        const engine = await getVerseEngine();
        const session = engine.getSession(id);
        if (!session) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const roots: VerseRootStatus[] = describeRoots(verseSessionRoots(session), { engine: session.engine });
        const body: VerseSessionRootsResponse = {
          sessionId: session.id,
          workspaceId: session.workspaceId ?? null,
          workspaceName: session.workspaceName ?? null,
          roots,
          notes: rootNotes(roots, session.engine),
        };
        sendJson(res, 200, body);
        return true;
      }

      // GET /api/verse/sessions/:id
      if (method === 'GET' && action === '') {
        const engine = await getVerseEngine();
        const session = engine.getSession(id);
        if (!session) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const detail: VerseSessionDetail = { session, events: engine.getEvents(id) };
        sendJson(res, 200, detail);
        return true;
      }

      if (method !== 'POST' || !['turns', 'cancel', 'delete', 'rename'].includes(action)) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      if (!passesMutationGate(req, res, ctx.token)) return true;
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const engine = await getVerseEngine();

      if (action === 'turns') {
        const text = body['text'];
        if (typeof text !== 'string' || text.trim().length === 0) {
          sendInvalid(res, 'text is required');
          return true;
        }
        if (Buffer.byteLength(text, 'utf8') > VERSE_MAX_TURN_TEXT_BYTES) {
          sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: `text exceeds ${VERSE_MAX_TURN_TEXT_BYTES} bytes` });
          return true;
        }
        const result: VerseTurnResponse = engine.sendTurn(id, text);
        sendJson(res, 202, result);
        return true;
      }

      if (action === 'cancel') {
        if (!engine.getSession(id)) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        const cancelled = engine.cancelTurn(id);
        sendJson(res, 200, { ok: true, cancelled });
        return true;
      }

      if (action === 'delete') {
        if (!engine.getSession(id)) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
          return true;
        }
        engine.deleteSession(id);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // rename
      const title = body['title'];
      if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_CHARS) {
        sendInvalid(res, `title must be 1-${MAX_TITLE_CHARS} characters`);
        return true;
      }
      sendJson(res, 200, engine.renameSession(id, title.trim()));
      return true;
    }

    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch (err) {
    if (!res.headersSent) sendVerseError(res, err);
    else if (!res.writableEnded) {
      try { res.end(); } catch { /* already gone */ }
    }
    return true;
  }
}

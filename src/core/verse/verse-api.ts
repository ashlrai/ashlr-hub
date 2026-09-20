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
import { discoverProjects } from './projects.js';
import { discoverSeats, type VerseSeatDiscovery } from './seats.js';
import type { VerseEngineHandle } from './session-engine.js';
import {
  VERSE_MAX_TURN_TEXT_BYTES,
  type VerseBootstrap,
  type VerseCreateSessionRequest,
  type VerseSession,
  type VerseSessionDetail,
  type VerseTurnResponse,
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
 */
export function expandHomePrefix(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function parseCreateRequest(body: Record<string, unknown>, res: ServerResponse): VerseCreateSessionRequest | null {
  const projectPath = body['projectPath'];
  const seatId = body['seatId'];
  const model = body['model'];
  const title = body['title'];
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0 || projectPath.length > MAX_PATH_CHARS) {
    sendInvalid(res, 'projectPath is required');
    return null;
  }
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
  const out: VerseCreateSessionRequest = { projectPath: expandHomePrefix(projectPath.trim()), seatId: seatId.trim() };
  if (typeof model === 'string') out.model = model;
  if (typeof title === 'string' && title.trim().length > 0) out.title = title.trim();
  return out;
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
      const discovery = await cachedSeats(ctx.cfg);
      const sessions = engine.listSessions();
      const body: VerseBootstrap = {
        seats: discovery.seats,
        projects: discoverProjects({ sessions }),
        sessions,
        dispatchEnabled: ctx.allowDispatch,
        localRuntime: discovery.localRuntime,
      };
      sendJson(res, 200, body);
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
        const create = parseCreateRequest(body, res);
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

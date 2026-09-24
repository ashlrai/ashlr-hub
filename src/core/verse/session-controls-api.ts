/**
 * core/verse/session-controls-api.ts — the composer's routes (SPEC-310C §7
 * "Route contracts", `handleSessionControlsApi`; unit C3).
 *
 *   GET  /api/verse/session-controls/defaults            → VerseSessionControlDefaults
 *   POST /api/verse/session-controls/defaults            {seatId?, effort?, permissionMode?} (never bypass)
 *   GET  /api/verse/session-controls/:id                 → VerseSessionControlsResponse
 *   POST /api/verse/session-controls/:id                 {model?, effort?, permissionMode?, confirmBypass?}
 *   GET  /api/verse/attachments/:id                      → { sessionId, items: VerseAttachment[] }
 *   POST /api/verse/attachments/:id                      {name, mime, dataBase64} → VerseAttachment (201)
 *   POST /api/verse/attachments/:id/:attachmentId/delete → { sessionId, items }
 *   GET  /api/verse/queue/:id                            → VerseQueueResponse
 *   POST /api/verse/queue/:id                            {text, sendNow?} → VerseQueueResponse + sentTurnId
 *   POST /api/verse/queue/:id/:queueId/delete            → VerseQueueResponse
 *   POST /api/verse/queue/:id/:queueId/send              → VerseQueueResponse + sentTurnId
 *   GET  /api/verse/files?sessionId=&q=                  → VerseFilesResponse
 *
 * Posture (verse-api.ts's, applied by the C0 mount BEFORE this module runs):
 * every non-GET passes `allowDispatch` and the mutation gate (constant-time
 * token + JSON content type); this module then reads the body with a cap,
 * refuses unknown keys with a 400, and answers through `sendJson`, which runs
 * `sanitizePublicJson` (home → `~`, secrets scrubbed). Agents and MCP reach
 * none of this: it is the operator's console surface only.
 *
 * ZERO SPEND except where the operator already asked to spend: the queue's
 * POST sends a turn ONLY when nothing runs and nothing waits (the turn just
 * ended), and [Send now] is an explicit send. Both go through the engine's
 * `sendTurn` — the readiness gate, the local-only policy and the one spawn
 * chokepoint — exactly like POST /sessions/:id/turns.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { sharedFileIndex, type VerseFileIndex } from './file-index.js';
import { checkWorkspaceRootPath } from './path-guard.js';
import { parseControlsUpdate, parseDefaultsUpdate } from './session-controls.js';
import type { VerseEngineHandle } from './session-engine.js';
import { verseSessionRoots } from './types.js';
import { getVerseEngine, type VerseApiContext } from './verse-api.js';
import {
  VERSE_ATTACHMENT_MAX_BYTES,
  VERSE_ATTACHMENTS_PATH,
  VERSE_FILES_PATH,
  VERSE_QUEUE_PATH,
  VERSE_SESSION_CONTROL_DEFAULTS_PATH,
  VERSE_SESSION_CONTROLS_PATH,
  type VerseAttachmentUpload,
  type VerseFilesResponse,
} from './workbench-types.js';

/** A session id as the store accepts it (session-store SESSION_ID_RE). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const QUEUE_ID_RE = /^[0-9a-f]{12}$/;
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}$/;

/** Every JSON body on this family except an upload keeps the shared 64 KB cap. */
const SMALL_BODY_BYTES = 64 * 1024;
/**
 * An upload is one file as base64 (4/3 of its bytes) plus its name and mime:
 * the cap is raised for THIS route only, to exactly what an 8 MB file needs.
 */
export const ATTACHMENT_BODY_MAX_BYTES = Math.ceil((VERSE_ATTACHMENT_MAX_BYTES * 4) / 3) + 16 * 1024;
/** Longest `q` the file finder takes. */
const FILES_QUERY_MAX = 200;

type ErrorCode = 'VERSE_SESSION_NOT_FOUND' | 'VERSE_SESSION_BUSY' | 'VERSE_INVALID' | 'VERSE_TOO_LARGE';
const STATUS: Record<ErrorCode, number> = {
  VERSE_SESSION_NOT_FOUND: 404,
  VERSE_SESSION_BUSY: 409,
  VERSE_INVALID: 400,
  VERSE_TOO_LARGE: 413,
};

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

let engineOverride: VerseEngineHandle | null = null;
let fileIndexOverride: VerseFileIndex | null = null;

/** Test hook: route to a fake/temporary engine instead of the process singleton. */
export function setSessionControlsEngineForTest(engine: VerseEngineHandle | null): void {
  engineOverride = engine;
}

/** Test hook: a file index with an injected lister. */
export function setSessionControlsFileIndexForTest(index: VerseFileIndex | null): void {
  fileIndexOverride = index;
}

async function engine(): Promise<VerseEngineHandle> {
  return engineOverride ?? getVerseEngine();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(res: ServerResponse, code: ErrorCode, message: string): void {
  sendJson(res, STATUS[code], { code, error: message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(req: IncomingMessage, res: ServerResponse, maxBytes = SMALL_BODY_BYTES): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch {
    sendError(res, 'VERSE_TOO_LARGE', maxBytes > SMALL_BODY_BYTES
      ? `each attachment must be ${Math.round(VERSE_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB or smaller`
      : 'request body too large');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendError(res, 'VERSE_INVALID', 'invalid JSON body');
    return null;
  }
  if (!isRecord(parsed)) {
    sendError(res, 'VERSE_INVALID', 'body must be a JSON object');
    return null;
  }
  return parsed;
}

function rejectUnknownKeys(res: ServerResponse, body: Record<string, unknown>, allowed: readonly string[]): boolean {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return false;
  sendError(res, 'VERSE_INVALID', `unknown field(s): ${unknown.join(', ')}`);
  return true;
}

/**
 * Map an engine refusal to this family's error shape. A readiness refusal
 * (VERSE_SEAT_NOT_READY) and anything unexpected are RETHROWN: the mount
 * awaits this module inside handleVerseApi's try, whose mapper answers the
 * former with the ranked alternatives the composer offers and the latter with
 * a bare 500 that leaks no message.
 */
function mapEngineError(res: ServerResponse, err: unknown): void {
  const code = isRecord(err) || err instanceof Error ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && code in STATUS) {
    sendError(res, code as ErrorCode, err instanceof Error ? err.message : String(code));
    return;
  }
  throw err;
}

function splitPath(path: string, prefix: string): string[] {
  return path.slice(prefix.length).split('/').filter((part) => part.length > 0);
}

function searchParams(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function missingMethod(res: ServerResponse, handle: VerseEngineHandle, name: keyof VerseEngineHandle): boolean {
  if (typeof handle[name] === 'function') return false;
  // An engine from before 3.10 (a test fake, an older sidecar) — say so
  // plainly rather than 500.
  sendJson(res, 501, { code: 'VERSE_UNSUPPORTED', error: 'this server’s chat engine predates session controls — update Ashlr' });
  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleControls(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  const handle = await engine();
  if (path === VERSE_SESSION_CONTROL_DEFAULTS_PATH) {
    if (method === 'GET') {
      if (missingMethod(res, handle, 'getControlDefaults')) return true;
      sendJson(res, 200, handle.getControlDefaults!());
      return true;
    }
    if (method !== 'POST') return false;
    const body = await readJson(req, res);
    if (!body) return true;
    const parsed = parseDefaultsUpdate(body);
    if (!parsed.ok) {
      sendError(res, 'VERSE_INVALID', parsed.error);
      return true;
    }
    if (missingMethod(res, handle, 'setControlDefaults')) return true;
    try {
      sendJson(res, 200, handle.setControlDefaults!(parsed.update));
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }

  const parts = splitPath(path, VERSE_SESSION_CONTROLS_PATH);
  if (parts.length !== 1 || !SESSION_ID_RE.test(parts[0]!)) return false;
  const id = parts[0]!;
  if (method === 'GET') {
    if (missingMethod(res, handle, 'getControls')) return true;
    try {
      sendJson(res, 200, handle.getControls!(id));
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }
  if (method !== 'POST') return false;
  const body = await readJson(req, res);
  if (!body) return true;
  const parsed = parseControlsUpdate(body);
  if (!parsed.ok) {
    sendError(res, 'VERSE_INVALID', parsed.error);
    return true;
  }
  if (missingMethod(res, handle, 'setControls')) return true;
  try {
    sendJson(res, 200, handle.setControls!(id, parsed.update));
  } catch (err) {
    mapEngineError(res, err);
  }
  return true;
}

async function handleAttachments(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  const parts = splitPath(path, VERSE_ATTACHMENTS_PATH);
  const id = parts[0];
  if (!id || !SESSION_ID_RE.test(id)) return false;
  const handle = await engine();

  if (parts.length === 1 && method === 'GET') {
    if (missingMethod(res, handle, 'listAttachments')) return true;
    try {
      sendJson(res, 200, { sessionId: id, items: handle.listAttachments!(id) });
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }

  if (parts.length === 1 && method === 'POST') {
    const body = await readJson(req, res, ATTACHMENT_BODY_MAX_BYTES);
    if (!body) return true;
    if (rejectUnknownKeys(res, body, ['name', 'mime', 'dataBase64'])) return true;
    if (typeof body['name'] !== 'string' || typeof body['mime'] !== 'string' || typeof body['dataBase64'] !== 'string') {
      sendError(res, 'VERSE_INVALID', 'name, mime and dataBase64 are required strings');
      return true;
    }
    if (missingMethod(res, handle, 'saveAttachment')) return true;
    const upload: VerseAttachmentUpload = { name: body['name'], mime: body['mime'], dataBase64: body['dataBase64'] };
    try {
      sendJson(res, 201, handle.saveAttachment!(id, upload));
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }

  if (parts.length === 3 && parts[2] === 'delete' && method === 'POST') {
    const attachmentId = parts[1]!;
    if (!ATTACHMENT_ID_RE.test(attachmentId)) return false;
    const body = await readJson(req, res);
    if (!body) return true;
    if (rejectUnknownKeys(res, body, [])) return true;
    if (missingMethod(res, handle, 'removeAttachment')) return true;
    try {
      if (!handle.removeAttachment!(id, attachmentId)) {
        sendError(res, 'VERSE_SESSION_NOT_FOUND', 'that attachment no longer exists');
        return true;
      }
      sendJson(res, 200, { sessionId: id, items: handle.listAttachments!(id) });
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }
  return false;
}

async function handleQueue(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  const parts = splitPath(path, VERSE_QUEUE_PATH);
  const id = parts[0];
  if (!id || !SESSION_ID_RE.test(id)) return false;
  const handle = await engine();

  if (parts.length === 1 && method === 'GET') {
    if (missingMethod(res, handle, 'getQueue')) return true;
    try {
      sendJson(res, 200, handle.getQueue!(id));
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }

  if (parts.length === 1 && method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return true;
    if (rejectUnknownKeys(res, body, ['text', 'sendNow'])) return true;
    if (typeof body['text'] !== 'string' || body['text'].trim().length === 0) {
      sendError(res, 'VERSE_INVALID', 'text is required');
      return true;
    }
    if (body['sendNow'] !== undefined && body['sendNow'] !== true) {
      sendError(res, 'VERSE_INVALID', 'sendNow must be true when present');
      return true;
    }
    if (missingMethod(res, handle, 'enqueueTurn')) return true;
    try {
      const result = handle.enqueueTurn!(id, body['text'], { sendNow: body['sendNow'] === true });
      sendJson(res, result.sentTurnId ? 202 : 200, result);
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }

  if (parts.length === 3 && method === 'POST' && (parts[2] === 'delete' || parts[2] === 'send')) {
    const queueId = parts[1]!;
    if (!QUEUE_ID_RE.test(queueId)) return false;
    const body = await readJson(req, res);
    if (!body) return true;
    if (rejectUnknownKeys(res, body, [])) return true;
    try {
      if (parts[2] === 'delete') {
        if (missingMethod(res, handle, 'removeQueuedTurn')) return true;
        sendJson(res, 200, handle.removeQueuedTurn!(id, queueId));
      } else {
        if (missingMethod(res, handle, 'sendQueuedTurn')) return true;
        const result = handle.sendQueuedTurn!(id, queueId);
        sendJson(res, result.sentTurnId ? 202 : 200, result);
      }
    } catch (err) {
      mapEngineError(res, err);
    }
    return true;
  }
  return false;
}

async function handleFiles(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (path !== VERSE_FILES_PATH || method !== 'GET') return false;
  const params = searchParams(req);
  const sessionId = params.get('sessionId') ?? '';
  const query = (params.get('q') ?? '').trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    sendError(res, 'VERSE_INVALID', 'sessionId is required');
    return true;
  }
  if (query.length > FILES_QUERY_MAX || query.includes('\0')) {
    sendError(res, 'VERSE_INVALID', `q must be at most ${FILES_QUERY_MAX} characters`);
    return true;
  }
  const handle = await engine();
  const session = handle.getSession(sessionId);
  if (!session) {
    sendError(res, 'VERSE_SESSION_NOT_FOUND', `session not found: ${sessionId}`);
    return true;
  }
  // Only the chat's own roots, and each must still pass the workspace-root
  // guard (a root that has since become a forbidden or missing directory is
  // simply not searched).
  const roots = verseSessionRoots(session)
    .map((root) => checkWorkspaceRootPath(root))
    .filter((check): check is { ok: true; path: string } => check.ok)
    .map((check) => check.path);
  const index = fileIndexOverride ?? sharedFileIndex();
  const found = await index.search(roots, query);
  // `primaryRoot` (additive to the C0 shape): the composer writes a match in
  // the chat's cwd as a relative `@path`, and one in another root in full.
  const body: VerseFilesResponse & { primaryRoot: string | null } = {
    sessionId,
    query,
    files: found.files,
    truncated: found.truncated,
    primaryRoot: roots[0] ?? null,
  };
  sendJson(res, 200, body);
  return true;
}

/**
 * The family's one export (WORKBENCH_ROUTE_FAMILIES `session-controls`).
 * Returns false for a path or method it does not serve, which the mount turns
 * into a 404 (the prefix is this family's alone).
 */
export const handleSessionControlsApi: ApiModule = async (
  _ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> => {
  if (path === VERSE_SESSION_CONTROLS_PATH || path.startsWith(`${VERSE_SESSION_CONTROLS_PATH}/`)) {
    return handleControls(req, res, path, method);
  }
  if (path === VERSE_ATTACHMENTS_PATH || path.startsWith(`${VERSE_ATTACHMENTS_PATH}/`)) {
    return handleAttachments(req, res, path, method);
  }
  if (path === VERSE_QUEUE_PATH || path.startsWith(`${VERSE_QUEUE_PATH}/`)) {
    return handleQueue(req, res, path, method);
  }
  if (path === VERSE_FILES_PATH) return handleFiles(req, res, path, method);
  return false;
};

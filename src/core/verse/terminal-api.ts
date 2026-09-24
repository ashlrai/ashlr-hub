/**
 * core/verse/terminal-api.ts — `/api/verse/terminal*` (V3.10, unit C4),
 * mounted by verse-api.ts's workbench table (workbench-types.ts §9).
 *
 *   GET  /api/verse/terminal                 → { available, reason, tabs }
 *   POST /api/verse/terminal                 { sessionId, root?, appId?, via?, model?, devServerId?, cols, rows } → 201 { tab }
 *   POST /api/verse/terminal/:id/input       { dataBase64 } (≤ 16 KB decoded) → 204
 *   POST /api/verse/terminal/:id/resize      { cols, rows } → 204
 *   POST /api/verse/terminal/:id/kill        {} → { ok }
 *   GET  /api/verse/terminal/:id/stream?after=<seq>  → SSE (scrollback first, ≤ 60 Hz)
 *   POST /api/verse/terminal/open-external   { sessionId, root? } → 202 — opens Terminal.app
 *                                           at the root (the pane's header, and its
 *                                           "needs the desktop app" fallback)
 *
 * GATES. verse-api.ts runs the V1 dispatch + mutation-token gate before any
 * POST reaches this module, and the read session before any GET. Here:
 *   - unknown body keys are a 400 (a typo must not silently do something else);
 *   - a root must be one of the chat's own roots or a discovered project, AND
 *     pass `checkWorkspaceRootPath` (never /, ~, ~/.ashlr, codex artifacts);
 *   - `appId` must name a catalog agent with a launch command (`via`/`model`
 *     choose Ollama and a local model, resolved like Apps' own launch),
 *     `devServerId`
 *     a dev server Preview discovered for THIS chat — the command typed into
 *     the shell is always built server-side, never taken from the request.
 * Agents and MCP cannot reach these routes (they hold no mutation token).
 *
 * THE STREAM is read with fetch() + the read-client header, not EventSource:
 * it therefore needs no query-proof allowance in read-session.ts, and only the
 * visible tab keeps a connection open (the browser allows ~6 per origin).
 * Output frames carry raw base64 bytes and deliberately skip the public-JSON
 * scrubber — scrubbing a terminal's byte stream would corrupt it, and it is
 * the operator's own shell talking to the operator.
 */
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { sanitizePublicJson } from '../util/public-json.js';
import { deregisterSse, readBody, registerSse, sendJson, sseConnectionCapReached } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { getAppsService, resolveAppLaunch, type AppsSnapshot } from './apps.js';
import { appCatalogEntry } from './apps-catalog.js';
import { checkWorkspaceRootPath, expandHomePrefix, physicalPath } from './path-guard.js';
import { discoverDevServers, sessionRoots, shellJoin, type DevServerDiscoveryDeps } from './preview.js';
import { discoverProjects } from './projects.js';
import {
  TERMINAL_TAB_ID_RE,
  TerminalError,
  getTerminalManager,
  type TerminalManager,
} from './terminal.js';
import type { VerseSession } from './types.js';
import { getVerseEngine } from './verse-api.js';
import { VERSE_SESSION_ID_RE } from './verse-stream.js';
import {
  VERSE_TERMINAL_INPUT_MAX_BYTES,
  VERSE_TERMINAL_OPEN_EXTERNAL_PATH,
  VERSE_TERMINAL_PATH,
  type VerseTerminalLaunchVia,
  type VerseTerminalFrame,
  type VerseTerminalListResponse,
} from './workbench-types.js';

// Contract (workbench-types.ts §5); re-exported for existing importers.
export { VERSE_TERMINAL_OPEN_EXTERNAL_PATH };
const TAB_ROUTE_RE = /^\/api\/verse\/terminal\/([^/]+)\/(input|resize|kill|stream)$/;
/** Base64 of 16 KB is 21,848 characters; the JSON around it is small. */
const MAX_BODY_BYTES = 32 * 1024;
const MAX_BASE64_CHARS = Math.ceil(VERSE_TERMINAL_INPUT_MAX_BYTES / 3) * 4;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export const TERMINAL_SSE_KEEPALIVE_MS = 15_000;
/** Unsent bytes past which a stalled stream is closed (the client resumes by seq). */
export const TERMINAL_SSE_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export interface TerminalApiDeps {
  manager?: () => TerminalManager;
  /**
   * The apps snapshot `appId` launches resolve against (default: the running
   * AppsService's). Null = Apps has not been loaded in this process.
   */
  appsSnapshot?: () => Promise<AppsSnapshot | null>;
  /** Opens Terminal.app at a directory (default: `open -a Terminal <dir>` on macOS). */
  openExternal?: (dir: string) => Promise<void>;
  devServers?: DevServerDiscoveryDeps;
  platform?: NodeJS.Platform;
}

let deps: TerminalApiDeps = {};

/** Test hook (null restores the defaults). */
export function setTerminalApiDepsForTest(next: TerminalApiDeps | null): void {
  deps = next ?? {};
}

function manager(): TerminalManager {
  return (deps.manager ?? getTerminalManager)();
}

function defaultOpenExternal(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Fixed binary, argv (never a shell string): the directory is one argument.
    execFile('/usr/bin/open', ['-a', 'Terminal', dir], { timeout: 10_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class BadRequest extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'VERSE_INVALID') {
    super(message);
  }
}

async function readJsonBody(req: IncomingMessage, allowed: readonly string[]): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch {
    throw new BadRequest(413, 'request body too large', 'VERSE_TOO_LARGE');
  }
  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw new BadRequest(400, 'body must be JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequest(400, 'body must be a JSON object');
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new BadRequest(400, `unknown field: ${key.slice(0, 40)}`);
  }
  return body;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new BadRequest(400, `${key} must be a non-empty string`);
  return value;
}

function requiredDimension(body: Record<string, unknown>, key: 'cols' | 'rows'): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 10_000) {
    throw new BadRequest(400, `${key} must be a positive number`);
  }
  return Math.round(value);
}

async function requireSession(rawId: unknown): Promise<VerseSession> {
  if (typeof rawId !== 'string' || !VERSE_SESSION_ID_RE.test(rawId)) throw new BadRequest(400, 'sessionId is required');
  const session = (await getVerseEngine()).getSession(rawId);
  if (!session) throw new BadRequest(404, 'session not found', 'VERSE_SESSION_NOT_FOUND');
  return session;
}

/**
 * A requested root, or the chat's primary one. Accepted only when it is one of
 * the chat's roots or a discovered project (SPEC-310C route contracts), and it
 * passes the workspace-root guard. Compared by PHYSICAL path, so a symlinked
 * spelling of an allowed root is the same root and a symlink to elsewhere is not.
 */
async function resolveRoot(session: VerseSession, raw: string | undefined): Promise<string> {
  const roots = sessionRoots(session);
  if (raw === undefined) {
    const primary = roots[0];
    if (!primary) throw new BadRequest(400, "this chat's folder is no longer available");
    return primary;
  }
  const checked = checkWorkspaceRootPath(expandHomePrefix(raw));
  if (!checked.ok) throw new BadRequest(400, checked.error);
  if (roots.includes(checked.path)) return checked.path;
  let projects: string[] = [];
  try {
    const sessions = (await getVerseEngine()).listSessions();
    projects = discoverProjects({ sessions }).map((p) => physicalPath(p.path) ?? p.path);
  } catch {
    projects = [];
  }
  if (projects.includes(checked.path)) return checked.path;
  throw new BadRequest(400, 'root must be one of this chat\'s folders or a known project');
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof BadRequest) {
    sendJson(res, err.status, { code: err.code, error: err.message });
    return;
  }
  if (err instanceof TerminalError) {
    const status = err.code === 'TERMINAL_UNAVAILABLE' ? 503
      : err.code === 'TERMINAL_LIMIT' || err.code === 'TERMINAL_EXITED' ? 409
        : err.code === 'TERMINAL_NOT_FOUND' ? 404
          : err.code === 'TERMINAL_INVALID' ? 400
            : 500;
    sendJson(res, status, { code: err.code, error: err.message });
    return;
  }
  throw err;
}

function listResponse(): VerseTerminalListResponse {
  const m = manager();
  const { available, reason } = m.available();
  return { available, reason, tabs: m.list() };
}

function defaultAppsSnapshot(): Promise<AppsSnapshot | null> {
  const service = getAppsService();
  return service ? service.snapshot() : Promise.resolve(null);
}

function optionalVia(body: Record<string, unknown>): VerseTerminalLaunchVia | undefined {
  const value = body['via'];
  if (value === undefined || value === null) return undefined;
  if (value !== 'native' && value !== 'ollama') throw new BadRequest(400, "via must be 'native' or 'ollama'");
  return value;
}

/**
 * The command an `appId` tab types, built server-side only.
 *
 * With no `via`/`model` it is the catalog's own launch argv — the 3.10.0
 * behaviour, which needs no probe. With either, the launch goes through
 * `resolveAppLaunch` against the Apps snapshot, the SAME resolution Apps'
 * Terminal.app launch uses: `ollama launch <id> [--model <tag>]` only where
 * the installed Ollama lists the agent and the tag is installed, and never an
 * agent that is not installed (a click must not download software). The
 * display argv (bare command) is typed, so the operator's own login PATH
 * resolves it exactly as it would if they typed it.
 */
async function appStartCommand(appId: string, via: VerseTerminalLaunchVia | undefined, model: string | undefined): Promise<string> {
  const entry = appCatalogEntry(appId);
  if (!entry || !entry.launch || entry.launch.length === 0) throw new BadRequest(400, 'that app has no launch command');
  if (via === undefined && model === undefined) return shellJoin(entry.launch);
  const snapshot = await (deps.appsSnapshot ?? defaultAppsSnapshot)();
  if (snapshot === null) throw new BadRequest(409, 'Apps has not checked what is installed yet — open Apps & Accounts first', 'VERSE_APPS_UNAVAILABLE');
  const resolved = resolveAppLaunch(snapshot, appId, { ...(via ? { via } : {}), model: model ?? null });
  if (!resolved.ok) {
    throw new BadRequest(resolved.refusal.status, resolved.refusal.error, `VERSE_APP_${resolved.refusal.code.toUpperCase().replace(/-/g, '_')}`);
  }
  return shellJoin(resolved.plan.display);
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, ['sessionId', 'root', 'appId', 'via', 'model', 'devServerId', 'cols', 'rows']);
  const cols = requiredDimension(body, 'cols');
  const rows = requiredDimension(body, 'rows');
  const session = await requireSession(body['sessionId']);
  const appId = optionalString(body, 'appId');
  const via = optionalVia(body);
  const model = optionalString(body, 'model');
  const devServerId = optionalString(body, 'devServerId');
  if (appId && devServerId) throw new BadRequest(400, 'appId and devServerId cannot both be set');
  // How an app launches means nothing without the app: refused rather than ignored.
  if ((via !== undefined || model !== undefined) && !appId) throw new BadRequest(400, 'via and model need an appId');
  const m = manager();
  if (!m.available().available) throw new TerminalError('TERMINAL_UNAVAILABLE', m.available().reason ?? 'terminal unavailable');

  let root = await resolveRoot(session, optionalString(body, 'root'));
  let startCommand: string | null = null;
  if (appId) startCommand = await appStartCommand(appId, via, model);
  if (devServerId) {
    const servers = await discoverDevServers(sessionRoots(session), deps.devServers ? { deps: deps.devServers } : {});
    const server = servers.find((s) => s.id === devServerId);
    if (!server) throw new BadRequest(404, 'dev server not found for this chat');
    if (!server.command) throw new BadRequest(400, 'that server is already running; there is nothing to start');
    // The record's cwd is inside one of the chat's roots (preview.ts keeps it there).
    root = server.cwd;
    startCommand = server.command;
  }

  const tab = await m.create({
    sessionId: session.id,
    root,
    cols,
    rows,
    appId: appId ?? null,
    devServerId: devServerId ?? null,
    startCommand,
  });
  sendJson(res, 201, { tab });
}

async function handleOpenExternal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, ['sessionId', 'root']);
  const session = await requireSession(body['sessionId']);
  const root = await resolveRoot(session, optionalString(body, 'root'));
  if ((deps.platform ?? process.platform) !== 'darwin') throw new BadRequest(400, 'Open in Terminal is available on macOS only');
  try {
    await (deps.openExternal ?? defaultOpenExternal)(root);
  } catch {
    sendJson(res, 500, { code: 'TERMINAL_OPEN_FAILED', error: 'Terminal could not be opened' });
    return;
  }
  sendJson(res, 202, { ok: true });
}

function noContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function parseAfter(req: IncomingMessage): number {
  try {
    const values = new URL(req.url ?? '/', 'http://localhost').searchParams.getAll('after');
    if (values.length !== 1 || !/^\d{1,15}$/.test(values[0]!)) return 0;
    return Number(values[0]);
  } catch {
    return 0;
  }
}

/** One SSE frame. Output frames carry `id:` (the resume cursor); title and exit do not. */
export function formatTerminalSseFrame(frame: VerseTerminalFrame): string {
  if (frame.type === 'output') {
    return `id: ${frame.seq}\nevent: output\ndata: ${JSON.stringify(frame)}\n\n`;
  }
  return `event: ${frame.type}\ndata: ${JSON.stringify(sanitizePublicJson(frame))}\n\n`;
}

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  readSession: { id: string; expiresAt: number } | undefined,
): void {
  const m = manager();
  if (!m.get(id)) {
    sendJson(res, 404, { code: 'TERMINAL_NOT_FOUND', error: 'terminal not found' });
    return;
  }
  if (sseConnectionCapReached()) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    res.write(': connected\n\n');
  } catch {
    return;
  }

  let ended = false;
  const live: { unsubscribe?: () => void; keepalive?: ReturnType<typeof setInterval>; expiry?: ReturnType<typeof setTimeout>; sseId?: string } = {};
  const cleanup = (): void => {
    if (ended) return;
    ended = true;
    live.unsubscribe?.();
    if (live.keepalive) clearInterval(live.keepalive);
    if (live.expiry) clearTimeout(live.expiry);
    if (live.sseId !== undefined) deregisterSse(live.sseId);
    try { res.end(); } catch { /* already ended */ }
  };
  const write = (text: string): void => {
    if (ended) return;
    try {
      res.write(text);
    } catch {
      cleanup();
      return;
    }
    const buffered = typeof res.writableLength === 'number' ? res.writableLength : 0;
    if (buffered > TERMINAL_SSE_MAX_BUFFERED_BYTES) cleanup();
  };

  live.sseId = registerSse(cleanup, readSession?.id ?? 'header');
  if (readSession) live.expiry = setTimeout(cleanup, Math.max(0, readSession.expiresAt - Date.now()));
  live.keepalive = setInterval(() => write(': keepalive\n\n'), TERMINAL_SSE_KEEPALIVE_MS);
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);

  try {
    const unsubscribe = m.subscribe(id, parseAfter(req), (frame) => write(formatTerminalSseFrame(frame)), cleanup);
    if (ended) unsubscribe();
    else live.unsubscribe = unsubscribe;
  } catch {
    cleanup();
  }
}

export const handleTerminalApi: ApiModule = async (ctx, req, res, path, method) => {
  try {
    if (path === VERSE_TERMINAL_PATH) {
      if (method === 'GET') {
        sendJson(res, 200, listResponse());
        return true;
      }
      if (method === 'POST') {
        await handleCreate(req, res);
        return true;
      }
      return false;
    }

    if (path === VERSE_TERMINAL_OPEN_EXTERNAL_PATH) {
      if (method !== 'POST') return false;
      await handleOpenExternal(req, res);
      return true;
    }

    const match = TAB_ROUTE_RE.exec(path);
    if (!match) return false;
    const [, id, action] = match as unknown as [string, string, 'input' | 'resize' | 'kill' | 'stream'];
    if (!TERMINAL_TAB_ID_RE.test(id)) {
      sendJson(res, 404, { code: 'TERMINAL_NOT_FOUND', error: 'terminal not found' });
      return true;
    }

    if (action === 'stream') {
      if (method !== 'GET') return false;
      handleStream(req, res, id, ctx.readSession);
      return true;
    }
    if (method !== 'POST') return false;

    if (action === 'input') {
      const body = await readJsonBody(req, ['dataBase64']);
      const data = body['dataBase64'];
      if (typeof data !== 'string' || data.length === 0 || !BASE64_RE.test(data) || data.length % 4 !== 0) {
        throw new BadRequest(400, 'dataBase64 must be base64');
      }
      if (data.length > MAX_BASE64_CHARS) throw new BadRequest(413, 'input is limited to 16 KB per request', 'VERSE_TOO_LARGE');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > VERSE_TERMINAL_INPUT_MAX_BYTES) throw new BadRequest(413, 'input is limited to 16 KB per request', 'VERSE_TOO_LARGE');
      manager().write(id, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      noContent(res);
      return true;
    }
    if (action === 'resize') {
      const body = await readJsonBody(req, ['cols', 'rows']);
      manager().resize(id, requiredDimension(body, 'cols'), requiredDimension(body, 'rows'));
      noContent(res);
      return true;
    }
    // kill
    await readJsonBody(req, []);
    manager().kill(id);
    sendJson(res, 200, { ok: true });
    return true;
  } catch (err) {
    sendError(res, err);
    return true;
  }
};

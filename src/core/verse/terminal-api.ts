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
 *   GET  /api/verse/terminal/stream?tabs=<id>:<seq>,…  → ONE SSE for many tabs (3.15):
 *                                           tab-tagged frames, each tab resumed past its
 *                                           own seq (the panel's six panes share it)
 *   POST /api/verse/terminal/open-external   { sessionId, root? } → 202 — opens Terminal.app
 *                                           at the root (the pane's header, and its
 *                                           "needs the desktop app" fallback)
 *
 * 3.15 — command blocks, links, and chat:
 *   GET  /api/verse/terminal/:id/blocks                     → { blocks }
 *   GET  /api/verse/terminal/:id/blocks/:blockId?format=ansi|text|chat
 *                                                          → { block, command, output, truncated }
 *   POST /api/verse/terminal/:id/open-file   { path, line?, column?, cwd? } → { ok } — a
 *                                           `file:line` link, opened in the editor when it
 *                                           resolves inside the chat's roots
 *   POST /api/verse/terminal/redact          { text } → { text } — selection → chat, scrubbed
 *
 * 3.15 — history, settings, plain language:
 *   GET  /api/verse/terminal/history?q=&cwd=&repo=&limit=  → { enabled, entries } (ranked)
 *   POST /api/verse/terminal/history/clear   {} → { ok } — deletes the history file
 *   GET  /api/verse/terminal/settings                       → { history, assist }
 *   POST /api/verse/terminal/settings        { history?, assist? } → { history, assist }
 *   POST /api/verse/terminal/assist          { request, tabId?, cwd?, blockIds? }
 *                                           → { command, explanation, provider, risky }
 *                                           (terminal-assist.ts: the local model first;
 *                                           TEXT back, never typed, never run)
 *
 * NO SECRET REACHES A CHAT FROM HERE. Every JSON response passes
 * sanitizePublicJson (sendJson); `format=chat` and /redact additionally run
 * scrubSecrets on plain text first, so "Send to chat" and "Explain this
 * error" carry `[REDACTED]` where a key was printed. The raw byte stream
 * (output frames) is the only unscrubbed path, and it only ever reaches
 * the operator's own terminal view.
 *
 * KILL. An agent launch (`appId`) is refused while ~/.ashlr/KILL is engaged
 * (409 TERMINAL_KILL_SWITCH), and open agent tabs are hung up when it is
 * engaged (terminal.ts). The operator's own shells are not agents and stay.
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
 * it therefore needs no query-proof allowance in read-session.ts. The panel
 * holds ONE connection for every visible pane (the multiplexed `/stream`),
 * because the browser allows only ~6 per origin.
 * Output frames carry raw base64 bytes and deliberately skip the public-JSON
 * scrubber — scrubbing a terminal's byte stream would corrupt it, and it is
 * the operator's own shell talking to the operator.
 */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, sep } from 'node:path';

import type { AshlrConfig } from '../types.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { scrubSecrets } from '../util/scrub.js';
import { deregisterSse, readBody, registerSse, sendJson, sseConnectionCapReached } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { getAppsService, resolveAppLaunch, type AppsSnapshot } from './apps.js';
import { appCatalogEntry } from './apps-catalog.js';
import { withFolderIo } from './folder-io.js';
import { checkWorkspaceRootPathAsync, expandHomePrefix, physicalPathAsync } from './path-guard.js';
import { discoverDevServers, sessionRoots, shellJoin, type DevServerDiscoveryDeps } from './preview.js';
import { discoverProjectsAsync } from './projects.js';
import {
  TERMINAL_TAB_ID_RE,
  TerminalError,
  getTerminalManager,
  type TerminalManager,
} from './terminal.js';
import { terminalBytesToText } from './terminal-blocks.js';
import { runTerminalAssist, TerminalAssistError, type AssistBlockContext, type AssistDeps } from './terminal-assist.js';
import { getTerminalHistory, type TerminalHistoryStore } from './terminal-history.js';
import { loadTerminalSettings, parseTerminalSettingsUpdate, updateTerminalSettings } from './terminal-settings.js';
import type { VerseSession } from './types.js';
import { getVerseEngine } from './verse-api.js';
import { VERSE_SESSION_ID_RE } from './verse-stream.js';
import {
  VERSE_TERMINAL_ASSIST_MAX_REQUEST_CHARS,
  VERSE_TERMINAL_ASSIST_PATH,
  VERSE_TERMINAL_HISTORY_CLEAR_PATH,
  VERSE_TERMINAL_HISTORY_MAX_LIMIT,
  VERSE_TERMINAL_HISTORY_PATH,
  VERSE_TERMINAL_INPUT_MAX_BYTES,
  VERSE_TERMINAL_OPEN_EXTERNAL_PATH,
  VERSE_TERMINAL_PATH,
  VERSE_TERMINAL_REDACT_MAX_BYTES,
  VERSE_TERMINAL_REDACT_PATH,
  VERSE_TERMINAL_SETTINGS_PATH,
  VERSE_TERMINAL_STREAM_MAX_TABS,
  VERSE_TERMINAL_STREAM_PATH,
  type VerseTerminalBlockOutputFormat,
  type VerseTerminalBlockOutputResponse,
  type VerseTerminalLaunchVia,
  type VerseTerminalStreamFrame,
  type VerseTerminalHistoryResponse,
  type VerseTerminalListResponse,
  type VerseTerminalMuxFrame,
} from './workbench-types.js';

// Contract (workbench-types.ts §5); re-exported for existing importers.
export { VERSE_TERMINAL_OPEN_EXTERNAL_PATH };
const TAB_ROUTE_RE = /^\/api\/verse\/terminal\/([^/]+)\/(input|resize|kill|stream|blocks|open-file)$/;
const BLOCK_ROUTE_RE = /^\/api\/verse\/terminal\/([^/]+)\/blocks\/(b-\d{1,9})$/;
const BLOCK_FORMATS: readonly VerseTerminalBlockOutputFormat[] = ['ansi', 'text', 'chat'];
/** The redact body: 256 KB of text, JSON-escaped (control characters can triple it). */
const REDACT_MAX_BODY_BYTES = VERSE_TERMINAL_REDACT_MAX_BYTES * 3 + 1024;
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
  /** Opens a file at a line in the operator's editor (default: cli/open.ts `openInEditorAt`). */
  openInEditor?: (absPath: string, line: number, cfg: AshlrConfig) => Promise<void>;
  /** The command history (default: the process's, under the current HOME). */
  history?: () => TerminalHistoryStore;
  /** Model seams for /assist (default: the local model, then Grok when configured). */
  assist?: AssistDeps;
}

async function defaultOpenInEditor(absPath: string, line: number, cfg: AshlrConfig): Promise<void> {
  // Lazy, like the wiki's: the CLI opener is not part of the server's hot path.
  const open = await import('../../cli/open.js');
  open.openInEditorAt(absPath, line, cfg);
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

async function readJsonBody(req: IncomingMessage, allowed: readonly string[], maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
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
  // Off the event loop: roots and projects are operator folders (folder-io.ts).
  const checked = await withFolderIo(() => checkWorkspaceRootPathAsync(expandHomePrefix(raw)));
  if (!checked.ok) throw new BadRequest(400, checked.error);
  if (roots.includes(checked.path)) return checked.path;
  let projects: string[] = [];
  try {
    const sessions = (await getVerseEngine()).listSessions();
    const discovered = await discoverProjectsAsync({ sessions });
    projects = await Promise.all(
      discovered.map(async (p) => (await withFolderIo(() => physicalPathAsync(p.path))) ?? p.path),
    );
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
  if (err instanceof TerminalAssistError) {
    const status = err.code === 'ASSIST_OFF' ? 409 : err.code === 'ASSIST_NO_MODEL' ? 503 : 502;
    sendJson(res, status, { code: `TERMINAL_${err.code}`, error: err.message });
    return;
  }
  if (err instanceof TerminalError) {
    const status = err.code === 'TERMINAL_UNAVAILABLE' ? 503
      : err.code === 'TERMINAL_LIMIT' || err.code === 'TERMINAL_EXITED' || err.code === 'TERMINAL_KILL_SWITCH' ? 409
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

/**
 * A requested starting directory: it must be the root itself or resolve (by
 * PHYSICAL path, so a symlink cannot walk out) to a directory inside it.
 * `~/…` is accepted: tab and block cwds reach the page spelled that way.
 */
async function resolveCwdWithin(root: string, raw: string): Promise<string> {
  const expanded = expandHomePrefix(raw);
  if (!isAbsolute(expanded) || expanded.includes('\0')) throw new BadRequest(400, 'cwd must be an absolute path');
  const [physicalRoot, physicalCwd] = await withFolderIo(() => Promise.all([physicalPathAsync(root), physicalPathAsync(expanded)]));
  if (!physicalRoot || !physicalCwd) throw new BadRequest(400, 'cwd must be an existing directory');
  if (physicalCwd !== physicalRoot && !physicalCwd.startsWith(physicalRoot.endsWith(sep) ? physicalRoot : physicalRoot + sep)) {
    throw new BadRequest(400, 'cwd must be inside the terminal\'s folder');
  }
  return physicalCwd;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new BadRequest(400, `${key} must be true or false`);
  return value;
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, ['sessionId', 'root', 'appId', 'via', 'model', 'devServerId', 'cwd', 'shellIntegration', 'cols', 'rows']);
  const cols = requiredDimension(body, 'cols');
  const rows = requiredDimension(body, 'rows');
  const session = await requireSession(body['sessionId']);
  const appId = optionalString(body, 'appId');
  const via = optionalVia(body);
  const model = optionalString(body, 'model');
  const devServerId = optionalString(body, 'devServerId');
  const rawCwd = optionalString(body, 'cwd');
  const shellIntegration = optionalBoolean(body, 'shellIntegration');
  if (appId && devServerId) throw new BadRequest(400, 'appId and devServerId cannot both be set');
  // A dev server starts in its own record's directory.
  if (rawCwd && devServerId) throw new BadRequest(400, 'cwd and devServerId cannot both be set');
  // How an app launches means nothing without the app: refused rather than ignored.
  if ((via !== undefined || model !== undefined) && !appId) throw new BadRequest(400, 'via and model need an appId');
  const m = manager();
  if (!m.available().available) throw new TerminalError('TERMINAL_UNAVAILABLE', m.available().reason ?? 'terminal unavailable');

  let root = await resolveRoot(session, optionalString(body, 'root'));
  const cwd = rawCwd ? await resolveCwdWithin(root, rawCwd) : null;
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
    cwd,
    ...(shellIntegration === false ? { shellIntegration: false } : {}),
  });
  sendJson(res, 201, { tab });
}

// ---------------------------------------------------------------------------
// 3.15: blocks, links, redaction
// ---------------------------------------------------------------------------

function parseFormat(req: IncomingMessage): VerseTerminalBlockOutputFormat {
  let values: string[] = [];
  try {
    values = new URL(req.url ?? '/', 'http://localhost').searchParams.getAll('format');
  } catch {
    values = [];
  }
  if (values.length === 0) return 'text';
  const value = values[0] as VerseTerminalBlockOutputFormat;
  if (values.length !== 1 || !BLOCK_FORMATS.includes(value)) throw new BadRequest(400, 'format must be ansi, text or chat');
  return value;
}

function handleBlockOutput(req: IncomingMessage, res: ServerResponse, id: string, blockId: string): void {
  const format = parseFormat(req);
  const found = manager().blockOutput(id, blockId);
  if (!found) {
    sendJson(res, 404, { code: 'TERMINAL_BLOCK_NOT_FOUND', error: 'block not found' });
    return;
  }
  const { block, bytes, truncated } = found;
  let output: string;
  let command = block.command;
  if (format === 'ansi') {
    output = bytes.toString('utf8');
  } else {
    output = terminalBytesToText(bytes);
    if (format === 'chat') {
      // The only form a chat seat may receive: plain text, secrets out — the command line too.
      output = scrubSecrets(output);
      command = scrubSecrets(command);
    }
  }
  const body: VerseTerminalBlockOutputResponse = { block, command, output, truncated };
  sendJson(res, 200, body);
}

/** Every chat root of the session a tab belongs to, as physical paths. */
async function tabRootsPhysical(tabSessionId: string | null, tabRoot: string): Promise<string[]> {
  const roots = new Set<string>([tabRoot]);
  if (tabSessionId) {
    const session = (await getVerseEngine()).getSession(tabSessionId);
    if (session) for (const r of sessionRoots(session)) roots.add(r);
  }
  const physical = await Promise.all([...roots].map((r) => withFolderIo(() => physicalPathAsync(r))));
  return physical.filter((p): p is string => typeof p === 'string');
}

function positiveInt(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
    throw new BadRequest(400, `${key} must be a positive integer`);
  }
  return value;
}

async function handleOpenFile(ctx: { cfg: AshlrConfig }, req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const body = await readJsonBody(req, ['path', 'line', 'column', 'cwd']);
  const tab = manager().get(id);
  if (!tab) throw new TerminalError('TERMINAL_NOT_FOUND', 'terminal not found');
  const rawPath = optionalString(body, 'path');
  if (!rawPath) throw new BadRequest(400, 'path is required');
  const line = positiveInt(body, 'line') ?? 1;
  positiveInt(body, 'column'); // validated; editors here open at a line
  const base = expandHomePrefix(optionalString(body, 'cwd') ?? tab.cwd ?? tab.root);
  const expanded = expandHomePrefix(rawPath);
  const candidate = isAbsolute(expanded) ? expanded : join(base, expanded);
  if (candidate.includes('\0')) throw new BadRequest(400, 'path is invalid');
  const real = await withFolderIo(() => physicalPathAsync(candidate));
  if (!real) {
    sendJson(res, 404, { code: 'TERMINAL_FILE_NOT_FOUND', error: 'That file does not exist.' });
    return;
  }
  const roots = await tabRootsPhysical(tab.sessionId, tab.root);
  const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
  if (!inside) {
    sendJson(res, 403, { code: 'TERMINAL_FILE_OUTSIDE', error: 'Only files inside this chat\'s folders open from the terminal.' });
    return;
  }
  let isFile = false;
  try {
    isFile = (await withFolderIo(() => stat(real))).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new BadRequest(400, 'path must be a file');
  await (deps.openInEditor ?? defaultOpenInEditor)(real, line, ctx.cfg);
  sendJson(res, 200, { ok: true });
}

async function handleRedact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, ['text'], REDACT_MAX_BODY_BYTES);
  const text = body['text'];
  if (typeof text !== 'string') throw new BadRequest(400, 'text must be a string');
  if (Buffer.byteLength(text) > VERSE_TERMINAL_REDACT_MAX_BYTES) throw new BadRequest(413, 'text is limited to 256 KB', 'VERSE_TOO_LARGE');
  sendJson(res, 200, { text: scrubSecrets(text) });
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

// ---------------------------------------------------------------------------
// 3.15: history, settings, plain language
// ---------------------------------------------------------------------------

function history(): TerminalHistoryStore {
  return (deps.history ?? getTerminalHistory)();
}

/** One query parameter: absent → undefined; repeated or too long → 400. */
function queryParam(req: IncomingMessage, key: string, maxLength = 4096): string | undefined {
  let values: string[];
  try {
    values = new URL(req.url ?? '/', 'http://localhost').searchParams.getAll(key);
  } catch {
    values = [];
  }
  if (values.length === 0) return undefined;
  if (values.length > 1 || values[0]!.length > maxLength || values[0]!.includes('\0')) throw new BadRequest(400, `${key} is invalid`);
  return values[0]!;
}

async function handleHistory(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = queryParam(req, 'q', 1024) ?? '';
  const cwd = queryParam(req, 'cwd') ?? null;
  const repo = queryParam(req, 'repo') ?? null;
  const rawLimit = queryParam(req, 'limit');
  let limit = 50;
  if (rawLimit !== undefined) {
    if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1) throw new BadRequest(400, 'limit must be a positive integer');
    limit = Math.min(VERSE_TERMINAL_HISTORY_MAX_LIMIT, Number(rawLimit));
  }
  const settings = await loadTerminalSettings();
  const entries = settings.history ? await history().query({ q, cwd, repo, limit }) : [];
  const body: VerseTerminalHistoryResponse = { enabled: settings.history, entries };
  sendJson(res, 200, body);
}

async function handleSettings(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method === 'GET') {
    sendJson(res, 200, await loadTerminalSettings());
    return;
  }
  const body = await readJsonBody(req, ['history', 'assist']);
  const patch = parseTerminalSettingsUpdate(body);
  if (!patch) throw new BadRequest(400, "send history (true/false) and/or assist ('auto', 'local' or 'off')");
  sendJson(res, 200, await updateTerminalSettings(patch));
}

async function handleAssist(ctx: { cfg: AshlrConfig }, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, ['request', 'tabId', 'cwd', 'blockIds']);
  const request = body['request'];
  if (typeof request !== 'string' || request.trim().length === 0) throw new BadRequest(400, 'request is required');
  if (request.length > VERSE_TERMINAL_ASSIST_MAX_REQUEST_CHARS) throw new BadRequest(413, `request is limited to ${VERSE_TERMINAL_ASSIST_MAX_REQUEST_CHARS} characters`, 'VERSE_TOO_LARGE');
  const tabId = optionalString(body, 'tabId');
  const rawBlockIds = body['blockIds'];
  if (rawBlockIds !== undefined && (!Array.isArray(rawBlockIds) || rawBlockIds.length > 10 || !rawBlockIds.every((b) => typeof b === 'string' && /^b-\d{1,9}$/.test(b)))) {
    throw new BadRequest(400, 'blockIds must be up to 10 block ids');
  }
  const m = manager();
  let cwd = optionalString(body, 'cwd') ?? null;
  const blocks: AssistBlockContext[] = [];
  if (tabId !== undefined) {
    if (!TERMINAL_TAB_ID_RE.test(tabId)) throw new TerminalError('TERMINAL_NOT_FOUND', 'terminal not found');
    const tab = m.get(tabId);
    if (!tab) throw new TerminalError('TERMINAL_NOT_FOUND', 'terminal not found');
    cwd ??= tab.cwd ?? tab.root;
    const wanted = Array.isArray(rawBlockIds)
      ? (rawBlockIds as string[])
      : m.blocks(tabId).filter((b) => b.state === 'done' && b.command).slice(-3).map((b) => b.id);
    for (const blockId of wanted) {
      const found = m.blockOutput(tabId, blockId);
      if (!found) continue;
      blocks.push({
        command: found.block.command,
        exitCode: found.block.exitCode,
        // Full-screen programs (vim, less) keep no transcript worth sending.
        output: found.block.fullscreen ? '' : terminalBytesToText(found.bytes),
      });
    }
  }
  const settings = await loadTerminalSettings();
  const shell = process.env['SHELL'] ? process.env['SHELL'].split('/').pop() ?? null : null;
  const answer = await runTerminalAssist(ctx.cfg, { request, cwd: cwd ? expandHomePrefix(cwd) : null, shell, blocks }, settings.assist, deps.assist ?? {});
  sendJson(res, 200, answer);
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
export function formatTerminalSseFrame(frame: VerseTerminalStreamFrame): string {
  if (frame.type === 'output') {
    return `id: ${frame.seq}\nevent: output\ndata: ${JSON.stringify(frame)}\n\n`;
  }
  return `event: ${frame.type}\ndata: ${JSON.stringify(sanitizePublicJson(frame))}\n\n`;
}

interface SseChannel {
  write(text: string): void;
  close(): void;
  readonly ended: boolean;
}

/**
 * The SSE plumbing both streams share: headers, the `connected` comment, a
 * keepalive, the read session's expiry, the server's live-connection registry,
 * and backpressure — past TERMINAL_SSE_MAX_BUFFERED_BYTES unsent the stream
 * is closed and the client resumes by seq. Null when the headers could not
 * be written (the client already went).
 */
function openSseChannel(
  req: IncomingMessage,
  res: ServerResponse,
  readSession: { id: string; expiresAt: number } | undefined,
  onClose: () => void,
): SseChannel | null {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  try {
    res.write(': connected\n\n');
  } catch {
    return null;
  }
  let ended = false;
  const live: { keepalive?: ReturnType<typeof setInterval>; expiry?: ReturnType<typeof setTimeout>; sseId?: string } = {};
  const close = (): void => {
    if (ended) return;
    ended = true;
    try { onClose(); } catch { /* best effort */ }
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
      close();
      return;
    }
    const buffered = typeof res.writableLength === 'number' ? res.writableLength : 0;
    if (buffered > TERMINAL_SSE_MAX_BUFFERED_BYTES) close();
  };
  live.sseId = registerSse(close, readSession?.id ?? 'header');
  if (readSession) live.expiry = setTimeout(close, Math.max(0, readSession.expiresAt - Date.now()));
  live.keepalive = setInterval(() => write(': keepalive\n\n'), TERMINAL_SSE_KEEPALIVE_MS);
  req.on('close', close);
  req.on('error', close);
  res.on('error', close);
  return {
    write,
    close,
    get ended() { return ended; },
  };
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
  let unsubscribe: (() => void) | undefined;
  const channel = openSseChannel(req, res, readSession, () => unsubscribe?.());
  if (!channel) return;
  try {
    const off = m.subscribe(id, parseAfter(req), (frame) => channel.write(formatTerminalSseFrame(frame)), () => channel.close());
    if (channel.ended) off();
    else unsubscribe = off;
  } catch {
    channel.close();
  }
}

// ---------------------------------------------------------------------------
// 3.15: one stream, many tabs
// ---------------------------------------------------------------------------

/**
 * `tabs=<id>:<after>,…` → [id, after] pairs. One `tabs` parameter, at most
 * VERSE_TERMINAL_STREAM_MAX_TABS distinct well-formed ids; a bare id resumes
 * from 0. Anything else is a 400: a malformed list must not half-subscribe.
 */
export function parseMuxTabs(rawUrl: string | undefined): Array<[string, number]> {
  let values: string[];
  try {
    values = new URL(rawUrl ?? '/', 'http://localhost').searchParams.getAll('tabs');
  } catch {
    values = [];
  }
  if (values.length !== 1 || values[0]!.length === 0 || values[0]!.length > 1024) throw new BadRequest(400, 'tabs must list the terminals to stream');
  const out = new Map<string, number>();
  for (const part of values[0]!.split(',')) {
    const m = /^(t-[a-z0-9]{1,32})(?::(\d{1,15}))?$/.exec(part);
    if (!m || !TERMINAL_TAB_ID_RE.test(m[1]!)) throw new BadRequest(400, 'tabs must be <id>:<seq> pairs');
    const after = m[2] === undefined ? 0 : Number(m[2]);
    if (!Number.isSafeInteger(after)) throw new BadRequest(400, 'tabs must be <id>:<seq> pairs');
    out.set(m[1]!, after);
  }
  if (out.size > VERSE_TERMINAL_STREAM_MAX_TABS) throw new BadRequest(400, `at most ${VERSE_TERMINAL_STREAM_MAX_TABS} terminals per stream`);
  return [...out.entries()];
}

/**
 * One multiplexed frame. Output keeps its raw bytes (never scrubbed: it is
 * the operator's own terminal, exactly as the per-tab stream); every other
 * frame goes through the public-JSON scrub like the per-tab stream's.
 */
export function formatTerminalMuxFrame(tab: string, frame: VerseTerminalStreamFrame | { type: 'gone' }): string {
  const tagged: VerseTerminalMuxFrame = { tab, ...frame };
  if (frame.type === 'output') return `event: output\ndata: ${JSON.stringify(tagged)}\n\n`;
  return `event: ${frame.type}\ndata: ${JSON.stringify(sanitizePublicJson(tagged))}\n\n`;
}

function handleMuxStream(req: IncomingMessage, res: ServerResponse, readSession: { id: string; expiresAt: number } | undefined): void {
  const cursors = parseMuxTabs(req.url);
  if (sseConnectionCapReached()) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }
  const m = manager();
  const subscriptions = new Map<string, () => void>();
  const channel = openSseChannel(req, res, readSession, () => {
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
  });
  if (!channel) return;
  const gone = (tab: string): void => {
    subscriptions.delete(tab);
    channel.write(formatTerminalMuxFrame(tab, { type: 'gone' }));
    // Nothing left to carry: end it (the page stops asking for gone tabs).
    if (subscriptions.size === 0) channel.close();
  };
  for (const [tab, after] of cursors) {
    if (channel.ended) return;
    if (!m.get(tab)) {
      channel.write(formatTerminalMuxFrame(tab, { type: 'gone' }));
      continue;
    }
    try {
      // Registered before subscribing: the replay is written synchronously
      // inside subscribe(), and a close mid-replay must still unsubscribe it.
      subscriptions.set(tab, () => {});
      const off = m.subscribe(tab, after, (frame) => channel.write(formatTerminalMuxFrame(tab, frame)), () => gone(tab));
      if (channel.ended || !subscriptions.has(tab)) off();
      else subscriptions.set(tab, off);
    } catch {
      subscriptions.delete(tab);
      channel.write(formatTerminalMuxFrame(tab, { type: 'gone' }));
    }
  }
  if (subscriptions.size === 0) channel.close();
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

    if (path === VERSE_TERMINAL_STREAM_PATH) {
      if (method !== 'GET') return false;
      handleMuxStream(req, res, ctx.readSession);
      return true;
    }

    if (path === VERSE_TERMINAL_HISTORY_PATH) {
      if (method !== 'GET') return false;
      await handleHistory(req, res);
      return true;
    }

    if (path === VERSE_TERMINAL_HISTORY_CLEAR_PATH) {
      if (method !== 'POST') return false;
      await readJsonBody(req, []);
      await history().clear();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (path === VERSE_TERMINAL_SETTINGS_PATH) {
      if (method !== 'GET' && method !== 'POST') return false;
      await handleSettings(req, res, method);
      return true;
    }

    if (path === VERSE_TERMINAL_ASSIST_PATH) {
      if (method !== 'POST') return false;
      await handleAssist(ctx, req, res);
      return true;
    }

    if (path === VERSE_TERMINAL_OPEN_EXTERNAL_PATH) {
      if (method !== 'POST') return false;
      await handleOpenExternal(req, res);
      return true;
    }

    if (path === VERSE_TERMINAL_REDACT_PATH) {
      if (method !== 'POST') return false;
      await handleRedact(req, res);
      return true;
    }

    const blockMatch = BLOCK_ROUTE_RE.exec(path);
    if (blockMatch) {
      const [, tabId, blockId] = blockMatch as unknown as [string, string, string];
      if (method !== 'GET') return false;
      if (!TERMINAL_TAB_ID_RE.test(tabId)) {
        sendJson(res, 404, { code: 'TERMINAL_NOT_FOUND', error: 'terminal not found' });
        return true;
      }
      handleBlockOutput(req, res, tabId, blockId);
      return true;
    }

    const match = TAB_ROUTE_RE.exec(path);
    if (!match) return false;
    const [, id, action] = match as unknown as [string, string, 'input' | 'resize' | 'kill' | 'stream' | 'blocks' | 'open-file'];
    if (!TERMINAL_TAB_ID_RE.test(id)) {
      sendJson(res, 404, { code: 'TERMINAL_NOT_FOUND', error: 'terminal not found' });
      return true;
    }

    if (action === 'stream') {
      if (method !== 'GET') return false;
      handleStream(req, res, id, ctx.readSession);
      return true;
    }
    if (action === 'blocks') {
      if (method !== 'GET') return false;
      sendJson(res, 200, { blocks: manager().blocks(id) });
      return true;
    }
    if (method !== 'POST') return false;
    if (action === 'open-file') {
      await handleOpenFile(ctx, req, res, id);
      return true;
    }

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

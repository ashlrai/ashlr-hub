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
 * 3.15 — command blocks, links, and chat:
 *   GET  /api/verse/terminal/:id/blocks                     → { blocks }
 *   GET  /api/verse/terminal/:id/blocks/:blockId?format=ansi|text|chat
 *                                                          → { block, command, output, truncated }
 *   POST /api/verse/terminal/:id/open-file   { path, line?, column?, cwd? } → { ok } — a
 *                                           `file:line` link, opened in the editor when it
 *                                           resolves inside the chat's roots
 *   POST /api/verse/terminal/redact          { text } → { text } — selection → chat, scrubbed
 *
 * 3.15 — agents, fixes, launch configurations:
 *   POST /api/verse/terminal/:id/agent-state?state=running|idle|needs-you
 *                                           the per-launch hook of a CLI agent in that tab
 *                                           (terminal-agent-hooks.ts). NOT behind the
 *                                           mutation token (verse-api.ts exempts exactly this
 *                                           path shape): authenticated by the tab's own
 *                                           random token header, refused with a browser Origin.
 *   POST /api/verse/terminal/:id/blocks/:blockId/fix  {} → { suggestions, model } — the LOCAL
 *                                           model's ≤ 3 candidate commands for a failed block
 *                                           (terminal-assist.ts); chips on the page, never run
 *   GET  /api/verse/terminal/launch?sessionId=…        → the chat roots' launch configurations
 *   POST /api/verse/terminal/launch          { sessionId, root, name, digest, cols, rows } → 201 — opens
 *                                           the exact configuration shown in the dialog;
 *                                           a changed file is refused before any tab opens
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
 * it therefore needs no query-proof allowance in read-session.ts, and only the
 * visible tab keeps a connection open (the browser allows ~6 per origin).
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
import { cleanAgentMessage, readHookBody } from './terminal-agent-hooks.js';
import { localAssistComplete, suggestFixCommands, type AssistComplete } from './terminal-assist.js';
import { readLaunchConfigs } from './terminal-launch.js';
import type { VerseSession } from './types.js';
import { getVerseEngine } from './verse-api.js';
import { VERSE_SESSION_ID_RE } from './verse-stream.js';
import {
  VERSE_TERMINAL_AGENT_STATE_PATH_RE,
  VERSE_TERMINAL_AGENT_TOKEN_HEADER,
  VERSE_TERMINAL_INPUT_MAX_BYTES,
  VERSE_TERMINAL_LAUNCH_PATH,
  VERSE_TERMINAL_OPEN_EXTERNAL_PATH,
  VERSE_TERMINAL_PATH,
  VERSE_TERMINAL_REDACT_MAX_BYTES,
  VERSE_TERMINAL_REDACT_PATH,
  type VerseTerminalBlockOutputFormat,
  type VerseTerminalBlockOutputResponse,
  type VerseTerminalAgentStateName,
  type VerseTerminalFixResponse,
  type VerseTerminalLaunchResponse,
  type VerseTerminalTab,
  type VerseTerminalLaunchVia,
  type VerseTerminalStreamFrame,
  type VerseTerminalListResponse,
} from './workbench-types.js';

// Contract (workbench-types.ts §5); re-exported for existing importers.
export { VERSE_TERMINAL_OPEN_EXTERNAL_PATH };
const TAB_ROUTE_RE = /^\/api\/verse\/terminal\/([^/]+)\/(input|resize|kill|stream|blocks|open-file)$/;
const BLOCK_ROUTE_RE = /^\/api\/verse\/terminal\/([^/]+)\/blocks\/(b-\d{1,9})$/;
const FIX_ROUTE_RE = /^\/api\/verse\/terminal\/([^/]+)\/blocks\/(b-\d{1,9})\/fix$/;
/** A hook's event JSON (Claude's hook input, Codex's notify payload): read for two fields, capped. */
const AGENT_STATE_MAX_BODY_BYTES = 16 * 1024;
const AGENT_STATES: readonly VerseTerminalAgentStateName[] = ['running', 'idle', 'needs-you'];
/** Fix suggestions kept per (tab, block): a re-render or a second click does not ask the model again. */
const FIX_CACHE_MAX = 64;
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
  /** 3.15: the local model behind fix chips (default: terminal-assist.ts `localAssistComplete`). */
  fixAssist?: (cfg: AshlrConfig) => { complete: AssistComplete; model: string };
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
  fixCache.clear();
  fixInflight.clear();
}

const fixCache = new Map<string, VerseTerminalFixResponse>();
const fixInflight = new Map<string, Promise<VerseTerminalFixResponse>>();

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
  // 3.15: hooks extend the agent's OWN argv only; a launch through Ollama is read from its output.
  const native = (via === undefined || via === 'native') && model === undefined;
  const agentStatus = appId ? { hooksBaseUrl: native ? loopbackOrigin(req) : null } : null;
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
    ...(agentStatus ? { agentStatus } : {}),
  });
  sendJson(res, 201, { tab });
}

/**
 * The server's own loopback origin, as the request arrived on it — where an
 * agent tab's hooks call back. Null when the listener is not IPv4 loopback
 * (the hooks then stay off and the tab's status is read from its output).
 */
function loopbackOrigin(req: IncomingMessage): string | null {
  const address = req.socket?.localAddress ?? '';
  const port = req.socket?.localPort;
  if (typeof port !== 'number' || port <= 0) return null;
  if (address === '127.0.0.1' || address === '::ffff:127.0.0.1') return `http://127.0.0.1:${port}`;
  return null;
}

// ---------------------------------------------------------------------------
// 3.15: agent status callbacks, fix suggestions, launch configurations
// ---------------------------------------------------------------------------

async function handleAgentState(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  // A hook script is not a page: anything a browser sends carries an Origin.
  if (req.headers['origin'] !== undefined || req.headers['sec-fetch-site'] !== undefined) {
    sendJson(res, 403, { code: 'TERMINAL_AGENT_FORBIDDEN', error: 'not from a page' });
    return;
  }
  const token = req.headers[VERSE_TERMINAL_AGENT_TOKEN_HEADER];
  let state: string | null = null;
  try {
    const values = new URL(req.url ?? '/', 'http://localhost').searchParams.getAll('state');
    state = values.length === 1 ? values[0]! : null;
  } catch {
    state = null;
  }
  if (!state || !(AGENT_STATES as readonly string[]).includes(state)) throw new BadRequest(400, 'state must be running, idle or needs-you');
  let raw: string;
  try {
    raw = await readBody(req, AGENT_STATE_MAX_BODY_BYTES);
  } catch {
    throw new BadRequest(413, 'body too large', 'VERSE_TOO_LARGE');
  }
  let parsed: unknown = null;
  try {
    parsed = raw.trim().length > 0 ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const read = readHookBody(parsed, state as VerseTerminalAgentStateName);
  const message = read.message ? cleanAgentMessage(scrubSecrets(read.message)) : null;
  // Unknown tab, a tab without hooks and a wrong token all look the same.
  if (typeof token !== 'string' || !manager().reportAgentState(id, token, read.state, message)) {
    sendJson(res, 404, { code: 'TERMINAL_NOT_FOUND', error: 'terminal not found' });
    return;
  }
  noContent(res);
}

async function handleFix(ctx: { cfg: AshlrConfig }, req: IncomingMessage, res: ServerResponse, tabId: string, blockId: string): Promise<void> {
  await readJsonBody(req, []);
  const found = manager().blockOutput(tabId, blockId);
  if (!found) {
    sendJson(res, 404, { code: 'TERMINAL_BLOCK_NOT_FOUND', error: 'block not found' });
    return;
  }
  const { block, bytes } = found;
  if (block.state !== 'done' || block.exitCode === null || block.exitCode === 0) {
    throw new BadRequest(400, 'only a command that failed has fixes to suggest');
  }
  const key = `${tabId}:${blockId}`;
  const cached = fixCache.get(key);
  if (cached) {
    sendJson(res, 200, cached);
    return;
  }
  let pending = fixInflight.get(key);
  if (!pending) {
    const assist = (deps.fixAssist ?? localAssistComplete)(ctx.cfg);
    // The chat form, scrubbed — the model is local, but a suggestion is shown on screen.
    const input = {
      command: scrubSecrets(block.command),
      output: scrubSecrets(terminalBytesToText(bytes)),
      exitCode: block.exitCode,
      cwd: block.cwd,
    };
    pending = suggestFixCommands(input, assist.complete).then((suggestions) => ({ suggestions, model: assist.model }));
    fixInflight.set(key, pending);
    void pending.finally(() => fixInflight.delete(key)).catch(() => undefined);
  }
  let result: VerseTerminalFixResponse;
  try {
    result = await pending;
  } catch {
    sendJson(res, 503, { code: 'TERMINAL_ASSIST_UNAVAILABLE', error: 'The local model did not answer. Is Ollama running?' });
    return;
  }
  fixCache.set(key, result);
  while (fixCache.size > FIX_CACHE_MAX) fixCache.delete(fixCache.keys().next().value!);
  sendJson(res, 200, result);
}

async function handleLaunchList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let sessionId: string | null = null;
  try {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const extra = [...params.keys()].filter((k) => k !== 'sessionId');
    if (extra.length > 0) throw new BadRequest(400, `unknown query parameter: ${extra[0]!.slice(0, 40)}`);
    const values = params.getAll('sessionId');
    sessionId = values.length === 1 ? values[0]! : null;
  } catch (err) {
    if (err instanceof BadRequest) throw err;
    sessionId = null;
  }
  const session = await requireSession(sessionId);
  sendJson(res, 200, await readLaunchConfigs(sessionRoots(session)));
}

async function handleLaunch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, ['sessionId', 'root', 'name', 'digest', 'cols', 'rows']);
  const cols = requiredDimension(body, 'cols');
  const rows = requiredDimension(body, 'rows');
  const session = await requireSession(body['sessionId']);
  const name = optionalString(body, 'name');
  if (!name) throw new BadRequest(400, 'name is required');
  const digest = optionalString(body, 'digest');
  if (!digest || !/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/.test(digest)) throw new BadRequest(400, 'the reviewed launch digest is required');
  const m = manager();
  if (!m.available().available) throw new TerminalError('TERMINAL_UNAVAILABLE', m.available().reason ?? 'terminal unavailable');
  const root = await resolveRoot(session, optionalString(body, 'root'));
  // Re-read from disk: the commands typed are the file's, never the request's.
  const { configs, errors } = await readLaunchConfigs([root]);
  const config = configs.find((c) => c.name === name);
  if (!config) {
    const why = errors[0]?.error;
    sendJson(res, 404, { code: 'TERMINAL_LAUNCH_NOT_FOUND', error: why ? `That launch configuration cannot be used: ${why}` : 'No launch configuration by that name in this folder.' });
    return;
  }
  if (config.digest !== digest) {
    throw new BadRequest(409, 'This launch configuration changed since you reviewed it. Reopen the dialog and review the new commands.', 'TERMINAL_LAUNCH_CHANGED');
  }
  const out: VerseTerminalLaunchResponse = { groups: [], errors: [] };
  const hooksBaseUrl = loopbackOrigin(req);
  // Resolve every cwd and catalog command before the first shell starts. A
  // broken later pane must not leave earlier commands running unexpectedly.
  const planned: Array<{ split: 'right' | 'down'; panes: Array<{ label: string; cwd: string | null; startCommand: string | null; agent: string | null }> }> = [];
  for (const tab of config.tabs) {
    const panes: (typeof planned)[number]['panes'] = [];
    for (const pane of tab.panes) {
      const label = pane.agent ?? pane.command ?? 'shell';
      try {
        const cwd = pane.cwd ? await resolveCwdWithin(root, join(root, pane.cwd)) : null;
        const startCommand = pane.agent ? await appStartCommand(pane.agent, undefined, undefined) : pane.command;
        panes.push({ label, cwd, startCommand, agent: pane.agent });
      } catch (err) {
        const text = err instanceof BadRequest || err instanceof TerminalError ? err.message : 'could not be validated';
        out.errors.push(`${label.slice(0, 60)}: ${text}`);
      }
    }
    planned.push({ split: tab.split, panes });
  }
  if (out.errors.length > 0) {
    sendJson(res, 409, { code: 'TERMINAL_LAUNCH_INVALID', error: 'The launch configuration has invalid panes. No terminals were opened.', errors: out.errors });
    return;
  }
  outer: for (const tab of planned) {
    const opened: VerseTerminalTab[] = [];
    for (const pane of tab.panes) {
      try {
        opened.push(await m.create({
          sessionId: session.id,
          root,
          cols,
          rows,
          appId: pane.agent,
          devServerId: null,
          startCommand: pane.startCommand,
          cwd: pane.cwd,
          ...(pane.agent ? { agentStatus: { hooksBaseUrl } } : {}),
        }));
      } catch (err) {
        const text = err instanceof BadRequest || err instanceof TerminalError ? err.message : 'could not be opened';
        out.errors.push(`${pane.label.slice(0, 60)}: ${text}`);
        if (err instanceof TerminalError && (err.code === 'TERMINAL_LIMIT' || err.code === 'TERMINAL_UNAVAILABLE')) {
          if (opened.length > 0) out.groups.push({ split: tab.split, tabs: opened });
          break outer;
        }
      }
    }
    if (opened.length > 0) out.groups.push({ split: tab.split, tabs: opened });
  }
  sendJson(res, 201, out);
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

    if (path === VERSE_TERMINAL_REDACT_PATH) {
      if (method !== 'POST') return false;
      await handleRedact(req, res);
      return true;
    }

    if (path === VERSE_TERMINAL_LAUNCH_PATH) {
      if (method === 'GET') {
        await handleLaunchList(req, res);
        return true;
      }
      if (method === 'POST') {
        await handleLaunch(req, res);
        return true;
      }
      return false;
    }

    const agentMatch = VERSE_TERMINAL_AGENT_STATE_PATH_RE.exec(path);
    if (agentMatch) {
      if (method !== 'POST') return false;
      await handleAgentState(req, res, agentMatch[1]!);
      return true;
    }

    const fixMatch = FIX_ROUTE_RE.exec(path);
    if (fixMatch) {
      const [, tabId, blockId] = fixMatch as unknown as [string, string, string];
      if (method !== 'POST') return false;
      if (!TERMINAL_TAB_ID_RE.test(tabId)) {
        sendJson(res, 404, { code: 'TERMINAL_NOT_FOUND', error: 'terminal not found' });
        return true;
      }
      await handleFix(ctx, req, res, tabId, blockId);
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

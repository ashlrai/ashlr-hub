/**
 * core/verse/verse-mcp-api.ts — `/api/verse/agent-tools*` (3.15 agent tools),
 * mounted by verse-api.ts as the `agent-tools` workbench family.
 *
 *   POST /api/verse/agent-tools/mcp             → MCP JSON-RPC (verse-mcp.ts), Bearer <turn token>
 *   GET|DELETE /api/verse/agent-tools/mcp       → 405 (stateless: no SSE stream, no session)
 *   GET  /api/verse/agent-tools/grant?sessionId=    → VerseAgentToolsState
 *   POST /api/verse/agent-tools/grant {sessionId, terminal?, browser?, browserScript?, computer?, computerApps?} → VerseAgentToolsState
 *   GET  /api/verse/agent-tools/activity?sessionId= → VerseAgentToolsActivity
 *   POST /api/verse/agent-tools/confirm {sessionId, id, answer}  → { ok: true }
 *   POST /api/verse/agent-tools/share {sessionId, tabId, shared} → VerseAgentToolsState
 *   POST /api/verse/agent-tools/resume {tabId}  → { ok: true }
 *   GET  /api/verse/agent-tools/tabs            → { tabs: VerseAgentTabInfo[] }
 *
 * (Not /api/verse/mcp: that is the MCP-management page's, mcp-control-api.ts.)
 *
 * Everything but the bare endpoint sits behind the normal Verse posture: GETs
 * behind the read session, POSTs behind dispatch + the constant-time mutation
 * token (dispatchWorkbenchModules), then a body cap and strict keys. Only the
 * OPERATOR's page can change a grant, answer a confirmation, share a shell or
 * hand one back — an agent holds no mutation token.
 *
 * The bare endpoint is a chat SEAT's, not the page's. It carries no Verse
 * token and is authenticated by the turn's bearer token alone
 * (verse-mcp-grants.ts). verse-api.ts lets a POST on exactly this path past
 * the mutation gate and server.ts lets a GET past the read boundary (to
 * answer 405). A request with an `Origin` header is refused outright: seats
 * are CLI processes; a page has no business here (DNS-rebinding / CSRF
 * defence on top of the server's Host allowlist). An unknown, revoked or
 * expired token gets 404 — never 401, which sends MCP clients hunting for
 * OAuth — with the same body whichever it was.
 *
 * The kill switch: while ~/.ashlr/KILL is engaged every tool call is refused
 * and every live token revoked.
 *
 * All IO here is async (scripts/check-verse-sync-io.mjs).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { browserMcpDepsFor } from './browser-api.js';
import { getTerminalManager, killSwitchEngagedAsync, TERMINAL_TAB_ID_RE, type TerminalManager } from './terminal.js';
import { getVerseEngine } from './verse-api.js';
import { removeVerseMcpTurnFiles } from './verse-mcp-launch.js';
import {
  agentTabInfos,
  agentTabOwner,
  agentToolScopes,
  agentToolsGrant,
  answerAgentConfirmation,
  forgetAgentTab,
  hasAgentScope,
  noteVerseSidecarOrigin,
  pendingConfirmations,
  recentAgentActions,
  recordAgentAction,
  requestAgentConfirmation,
  resumeAgentTab,
  revokeAllVerseMcpTurns,
  setAgentToolsGrant,
  setTabShared,
  sharedTabsOf,
  turnForBearer,
  updateAgentAction,
  verseMcpTurnActive,
  type VerseMcpTurn,
} from './verse-mcp-grants.js';
import { handleVerseMcpBody, untrustedBlock, type VerseMcpToolContext } from './verse-mcp.js';
import {
  VERSE_AGENT_BROWSER_MODES,
  VERSE_AGENT_COMPUTER_MODES,
  VERSE_AGENT_TERMINAL_MODES,
  VERSE_MCP_ACTIVITY_PATH,
  VERSE_MCP_CONFIRM_PATH,
  VERSE_MCP_GRANT_PATH,
  VERSE_MCP_PATH,
  VERSE_MCP_RESUME_PATH,
  VERSE_MCP_SHARE_PATH,
  VERSE_MCP_TABS_PATH,
  verseMcpSeatSupport,
  verseSeatToolLabel,
  type VerseAgentToolsActivity,
  type VerseAgentToolsGrant,
  type VerseAgentToolsState,
} from './verse-mcp-types.js';
import { VERSE_SESSION_ID_RE } from './verse-stream.js';
import type { VerseSession } from './types.js';

const SMALL_BODY_BYTES = 16 * 1024;
const MCP_BODY_BYTES = 256 * 1024;

export interface VerseMcpApiDeps {
  manager?: () => TerminalManager;
  killSwitch?: () => Promise<boolean>;
}

let deps: VerseMcpApiDeps = {};

/** Test hook (null restores the defaults). */
export function setVerseMcpApiDepsForTest(next: VerseMcpApiDeps | null): void {
  deps = next ?? {};
}

function manager(): TerminalManager {
  return (deps.manager ?? getTerminalManager)();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(res: ServerResponse, error: string): true {
  sendJson(res, 400, { code: 'VERSE_INVALID', error });
  return true;
}

function localPort(req: IncomingMessage): number | null {
  const port = req.socket?.localPort;
  return typeof port === 'number' && port > 0 ? port : null;
}

function writeRaw(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  // Written directly, not through sendJson: its public-JSON scrubber redacts
  // long base64-looking runs, and a screenshot IS one. Tool text was
  // secret-scrubbed by the tools already.
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req, SMALL_BODY_BYTES);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid(res, 'body must be JSON');
    return null;
  }
  if (!isRecord(parsed)) {
    invalid(res, 'body must be a JSON object');
    return null;
  }
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key)) {
      invalid(res, `unknown field: ${key.slice(0, 40)}`);
      return null;
    }
  }
  return parsed;
}

function querySessionId(req: IncomingMessage): string | null | undefined {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return undefined;
  }
  for (const key of url.searchParams.keys()) if (key !== 'sessionId') return undefined;
  const values = url.searchParams.getAll('sessionId');
  return values.length === 1 ? values[0]! : null;
}

async function knownSession(res: ServerResponse, raw: unknown): Promise<VerseSession | null> {
  if (typeof raw !== 'string' || !VERSE_SESSION_ID_RE.test(raw)) {
    invalid(res, 'sessionId is required');
    return null;
  }
  const session = (await getVerseEngine()).getSession(raw);
  if (!session) {
    sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: 'session not found' });
    return null;
  }
  return session;
}

function desktopAvailable(): boolean {
  try {
    return manager().available().available;
  } catch {
    return false;
  }
}

async function killSwitchOn(): Promise<boolean> {
  let engaged: boolean;
  try {
    engaged = await (deps.killSwitch ?? killSwitchEngagedAsync)();
  } catch {
    engaged = true;
  }
  if (engaged) revokeAllVerseMcpTurns('The kill switch is engaged.');
  return engaged;
}

/** Agent tabs whose shells are gone are forgotten before anything reports them. */
function pruneTabs(): void {
  const m = manager();
  for (const info of agentTabInfos()) if (!m.get(info.tabId)) forgetAgentTab(info.tabId);
}

function stateOf(session: VerseSession): VerseAgentToolsState {
  pruneTabs();
  const lane = session.engine === 'devin' ? (session.seatId === 'devin-cli' ? 'cli' : 'cloud') : null;
  return {
    sessionId: session.id,
    seatLabel: verseSeatToolLabel(session.engine),
    grant: agentToolsGrant(session.id),
    scopes: agentToolScopes(session.id),
    sharedTabs: sharedTabsOf(session.id),
    support: verseMcpSeatSupport(session.engine, lane),
    desktop: desktopAvailable(),
    turnActive: verseMcpTurnActive(session.id),
  };
}

function activityOf(sessionId: string): VerseAgentToolsActivity {
  pruneTabs();
  return {
    sessionId,
    pending: pendingConfirmations(sessionId),
    actions: recentAgentActions(sessionId),
    tabs: agentTabInfos().filter((t) => t.sessionId === sessionId),
  };
}

// ---------------------------------------------------------------------------
// The MCP endpoint
// ---------------------------------------------------------------------------

function toolContext(turn: VerseMcpTurn, versePort: number | null): VerseMcpToolContext {
  const { sessionId } = turn;
  const browser = browserMcpDepsFor(versePort);
  return {
    sessionId,
    engine: turn.engine,
    signal: turn.signal,
    versePort,
    desktop: desktopAvailable(),
    confirm: (req) => requestAgentConfirmation(sessionId, req, { signal: turn.signal }),
    record: (action) => recordAgentAction(sessionId, action),
    settle: (id, outcome) => updateAgentAction(sessionId, id, outcome),
    untrusted: (label, body) => untrustedBlock(label, body),
    markRemoteRead: turn.markRemoteRead,
    remoteRead: turn.remoteRead,
    browser: {
      ...browser,
      // The observe tools also use the bearer turn. A queued capture or
      // navigate is refused at the pane fence if that turn/scope ends.
      run: (sid, op, args, timeouts) => browser.run(sid, op, args, {
        ...timeouts,
        signal: turn.signal,
        authorize: () => sid === sessionId && !turn.signal.aborted && hasAgentScope(sessionId, 'browser') && (timeouts?.authorize?.() ?? true),
      }),
    },
  };
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})\s*$/.exec(header);
  return match ? match[1]! : null;
}

async function handleEndpoint(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') {
    writeRaw(res, 405, { error: 'this MCP endpoint is stateless: POST only' }, { Allow: 'POST' });
    return;
  }
  if (typeof req.headers.origin === 'string' && req.headers.origin.length > 0) {
    writeRaw(res, 403, { error: 'browser origins may not call this endpoint' });
    return;
  }
  const token = bearerOf(req);
  const turn = token ? turnForBearer(token) : null;
  if (!turn) {
    writeRaw(res, 404, { error: 'Verse tools are not available to this caller (no live turn holds this token).' });
    return;
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    writeRaw(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req, MCP_BODY_BYTES);
  } catch {
    writeRaw(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    writeRaw(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const versePort = localPort(req);
  if (versePort !== null) noteVerseSidecarOrigin(`http://127.0.0.1:${versePort}`);
  const protocolHeader = req.headers['mcp-protocol-version'];
  const answer = await handleVerseMcpBody(body, {
    scopes: () => (turn.signal.aborted ? [] : agentToolScopes(turn.sessionId)),
    killSwitch: killSwitchOn,
    toolContext: () => toolContext(turn, versePort),
    desktop: desktopAvailable(),
    protocolHeader: typeof protocolHeader === 'string' ? protocolHeader : null,
  });
  writeRaw(res, answer.status, answer.body);
}

// ---------------------------------------------------------------------------
// The operator's routes
// ---------------------------------------------------------------------------

function parseGrantPatch(body: Record<string, unknown>): Partial<VerseAgentToolsGrant> | string {
  const patch: Partial<VerseAgentToolsGrant> = {};
  if (body['terminal'] !== undefined) {
    if (!(VERSE_AGENT_TERMINAL_MODES as readonly unknown[]).includes(body['terminal'])) return `terminal must be one of: ${VERSE_AGENT_TERMINAL_MODES.join(', ')}`;
    patch.terminal = body['terminal'] as VerseAgentToolsGrant['terminal'];
  }
  if (body['browser'] !== undefined) {
    if (!(VERSE_AGENT_BROWSER_MODES as readonly unknown[]).includes(body['browser'])) return `browser must be one of: ${VERSE_AGENT_BROWSER_MODES.join(', ')}`;
    patch.browser = body['browser'] as VerseAgentToolsGrant['browser'];
  }
  if (body['browserScript'] !== undefined) {
    if (typeof body['browserScript'] !== 'boolean') return 'browserScript must be true or false';
    patch.browserScript = body['browserScript'];
  }
  if (body['computer'] !== undefined) {
    if (!(VERSE_AGENT_COMPUTER_MODES as readonly unknown[]).includes(body['computer'])) return `computer must be one of: ${VERSE_AGENT_COMPUTER_MODES.join(', ')}`;
    patch.computer = body['computer'] as VerseAgentToolsGrant['computer'];
  }
  if (body['computerApps'] !== undefined) {
    const apps = body['computerApps'];
    if (!Array.isArray(apps) || apps.length > 32 || !apps.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200)) return 'computerApps must be a list of app names';
    patch.computerApps = apps as string[];
  }
  return patch;
}

export const handleVerseMcpApi: ApiModule = async (_ctx, req, res, path, method) => {
  if (path === VERSE_MCP_PATH) {
    await handleEndpoint(req, res, method);
    return true;
  }

  if (path === VERSE_MCP_GRANT_PATH || path === VERSE_MCP_ACTIVITY_PATH) {
    if (method === 'GET') {
      const sessionId = querySessionId(req);
      if (sessionId === undefined) return invalid(res, 'unknown or repeated query parameter');
      const session = await knownSession(res, sessionId);
      if (!session) return true;
      const port = localPort(req);
      if (port !== null) noteVerseSidecarOrigin(`http://127.0.0.1:${port}`);
      sendJson(res, 200, path === VERSE_MCP_GRANT_PATH ? stateOf(session) : activityOf(session.id));
      return true;
    }
    if (method !== 'POST' || path !== VERSE_MCP_GRANT_PATH) return false;
    const body = await readJsonObject(req, res, ['sessionId', 'terminal', 'browser', 'browserScript', 'computer', 'computerApps']);
    if (!body) return true;
    const patch = parseGrantPatch(body);
    if (typeof patch === 'string') return invalid(res, patch);
    const session = await knownSession(res, body['sessionId']);
    if (!session) return true;
    const port = localPort(req);
    if (port === null) {
      sendJson(res, 503, { code: 'VERSE_UNAVAILABLE', error: 'could not tell which port Verse is serving on' });
      return true;
    }
    setAgentToolsGrant(session.id, patch, `http://127.0.0.1:${port}`);
    if (!verseMcpTurnActive(session.id)) await removeVerseMcpTurnFiles(session.id);
    sendJson(res, 200, stateOf(session));
    return true;
  }

  if (path === VERSE_MCP_TABS_PATH) {
    if (method !== 'GET') return false;
    pruneTabs();
    sendJson(res, 200, { tabs: agentTabInfos() });
    return true;
  }

  if (path === VERSE_MCP_CONFIRM_PATH) {
    if (method !== 'POST') return false;
    const body = await readJsonObject(req, res, ['sessionId', 'id', 'answer']);
    if (!body) return true;
    if (typeof body['id'] !== 'string' || !/^cf_[A-Za-z0-9_-]{12}$/.test(body['id'])) return invalid(res, 'id is required');
    if (body['answer'] !== 'once' && body['answer'] !== 'chat' && body['answer'] !== 'deny') return invalid(res, 'answer must be once, chat or deny');
    const session = await knownSession(res, body['sessionId']);
    if (!session) return true;
    if (!answerAgentConfirmation(session.id, body['id'], body['answer'])) {
      sendJson(res, 404, { code: 'VERSE_CONFIRMATION_GONE', error: 'that confirmation is no longer waiting (it timed out, or the turn ended)' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === VERSE_MCP_SHARE_PATH) {
    if (method !== 'POST') return false;
    const body = await readJsonObject(req, res, ['sessionId', 'tabId', 'shared']);
    if (!body) return true;
    if (typeof body['shared'] !== 'boolean') return invalid(res, 'shared must be true or false');
    if (typeof body['tabId'] !== 'string' || !TERMINAL_TAB_ID_RE.test(body['tabId'])) return invalid(res, 'tabId is required');
    const session = await knownSession(res, body['sessionId']);
    if (!session) return true;
    const tab = manager().get(body['tabId']);
    // Only the chat's OWN operator shells: never another chat's, never an agent's (its own or an Apps launch).
    if (!tab || tab.sessionId !== session.id || tab.agent === true || agentTabOwner(tab.id) !== null) {
      sendJson(res, 404, { code: 'TERMINAL_NOT_FOUND', error: 'that terminal is not one of this chat\'s own shells' });
      return true;
    }
    if (!setTabShared(session.id, tab.id, body['shared'])) {
      sendJson(res, 409, { code: 'VERSE_TOOLS_NOT_SHARED', error: 'switch this chat\'s terminal tools to "Share my shells" first' });
      return true;
    }
    sendJson(res, 200, stateOf(session));
    return true;
  }

  if (path === VERSE_MCP_RESUME_PATH) {
    if (method !== 'POST') return false;
    const body = await readJsonObject(req, res, ['tabId']);
    if (!body) return true;
    if (typeof body['tabId'] !== 'string' || !TERMINAL_TAB_ID_RE.test(body['tabId'])) return invalid(res, 'tabId is required');
    resumeAgentTab(body['tabId']);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
};

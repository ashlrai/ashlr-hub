/**
 * core/verse/browser-api.ts — `/api/verse/browser*` (3.15), the integrated
 * Browser pane's sidecar routes. Mounted by verse-api.ts as the `browser`
 * workbench family.
 *
 *   GET  /api/verse/browser/policy?sessionId=          → VerseBrowserPolicy
 *   POST /api/verse/browser/access {sessionId, enabled, scope?} → VerseBrowserPolicy
 *   POST /api/verse/browser/allow  {sessionId, origin, allowed} → VerseBrowserPolicy
 *   POST /api/verse/browser/allowance {sessionId, key}  → VerseBrowserPolicy (forget one "Allow for this chat")
 *   GET  /api/verse/browser/commands?sessionId=&wait=  → { commands } (the pane's long-poll, ≤ 20 s)
 *   POST /api/verse/browser/dispatch {sessionId, id}   → { allowed } (live claim fence before an effect)
 *   POST /api/verse/browser/result {sessionId, id, ok, url?, data?, error?} → { ok: true }
 *   ANY  /api/verse/browser/mcp/<grant>                → 410 (retired grant endpoint)
 *
 * All live Browser commands use the unified bearer-per-turn agent-tools MCP.
 * The old grant URL is accepted only to answer 410; it never parses a request
 * or queues a command. Other routes retain Verse's normal read/mutation gates.
 *
 * All IO here is async (scripts/check-verse-sync-io.mjs).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  BROWSER_POLL_MAX_WAIT_MS,
  allowedOriginsFor,
  browserPolicy,
  canDispatchBrowserCommand,
  claimBrowserCommands,
  completeBrowserCommand,
  recordBrowserBlocked,
  revokeBrowserAllowance,
  runBrowserCommand,
  setBrowserOriginAllowed,
} from './browser-bridge.js';
import type { BrowserMcpDeps } from './browser-mcp.js';
import { noteComputerUntrustedRead } from './computer-bridge.js';
import { agentToolsGrant, setAgentToolsGrant } from './verse-mcp-grants.js';
import {
  VERSE_BROWSER_ACCESS_PATH,
  VERSE_BROWSER_ALLOWANCE_PATH,
  VERSE_BROWSER_ALLOW_PATH,
  VERSE_BROWSER_SCOPES,
  VERSE_BROWSER_COMMANDS_PATH,
  VERSE_BROWSER_DISPATCH_PATH,
  VERSE_BROWSER_MCP_PATH_RE,
  VERSE_BROWSER_POLICY_PATH,
  VERSE_BROWSER_RESULT_PATH,
  type VerseBrowserCommandResult,
} from './browser-types.js';
import { firstPendingFolder } from './folder-io.js';
import { discoverDevServers, sessionRoots } from './preview.js';
import { getVerseEngine } from './verse-api.js';
import { VERSE_SESSION_ID_RE } from './verse-stream.js';

const SMALL_BODY_BYTES = 16 * 1024;
/** A screenshot answer: an 8 MB image as base64 plus the envelope. */
const RESULT_BODY_BYTES = 12 * 1024 * 1024;

/** Test hook: the Browser tools' dev-server lister (the real one reads the chat's roots). */
let devServerLister: BrowserMcpDeps['devServers'] | null = null;
export function setBrowserDevServerListerForTest(next: BrowserMcpDeps['devServers'] | null): void {
  devServerLister = next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryOf(req: IncomingMessage): Map<string, string> | null {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  for (const [key, value] of url.searchParams.entries()) {
    if (out.has(key)) return null;
    out.set(key, value);
  }
  return out;
}

function invalid(res: ServerResponse, error: string): true {
  sendJson(res, 400, { code: 'VERSE_INVALID', error });
  return true;
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
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
  return parsed;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return key;
  return null;
}

async function knownSession(res: ServerResponse, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !VERSE_SESSION_ID_RE.test(raw)) {
    invalid(res, 'sessionId is required');
    return null;
  }
  const session = (await getVerseEngine()).getSession(raw);
  if (!session) {
    sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: 'session not found' });
    return null;
  }
  return raw;
}

function localPort(req: IncomingMessage): number | null {
  const port = req.socket?.localPort;
  return typeof port === 'number' && port > 0 ? port : null;
}

/** Dev servers for `browser_status`, off the event loop's hot path; empty while a folder prompt is pending. */
async function defaultDevServers(sessionId: string, versePort: number | null): Promise<Array<{ label: string; url: string; running: boolean }>> {
  const session = (await getVerseEngine()).getSession(sessionId);
  if (!session) return [];
  const roots = sessionRoots(session);
  if ((await firstPendingFolder(roots)) !== null) return [];
  const servers = await discoverDevServers(roots, { excludePorts: versePort === null ? [] : [versePort] });
  return servers.map((s) => ({ label: s.label, url: s.url, running: s.running }));
}

function writeRaw(res: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  // Written directly, not through sendJson: its public-JSON scrubber redacts
  // long base64-looking runs, and a screenshot IS one. Tool handlers scrub
  // text before it reaches this response writer.
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The Browser pane relay as the MCP tools see it — shared with Verse's one MCP server (verse-mcp-api.ts). */
export function browserMcpDepsFor(versePort: number | null): BrowserMcpDeps {
  return {
    run: async (sid, op, args, timeouts) => {
      const outcome = await runBrowserCommand(sid, op, args, timeouts);
      // Every successful page response may carry untrusted words (including
      // snapshot nodes, network URLs, tab titles and navigation titles).
      // Computer-use after any of them needs its cross-tool confirmation.
      // Confirmation cards carry an operator decision, not page content.
      if (outcome.ok && op !== 'confirm') noteComputerUntrustedRead(sid);
      return outcome;
    },

    versePort,
    allowedOrigins: allowedOriginsFor,
    recordBlocked: recordBrowserBlocked,
    devServers: devServerLister ?? ((sid) => defaultDevServers(sid, versePort)),
  };
}

function parseResult(body: Record<string, unknown>): VerseBrowserCommandResult | string {
  const extra = onlyKeys(body, ['sessionId', 'id', 'ok', 'url', 'data', 'error']);
  if (extra) return `unknown field: ${extra.slice(0, 40)}`;
  if (typeof body['id'] !== 'string' || !/^bc_[A-Za-z0-9_-]{12}$/.test(body['id'])) return 'id is required';
  if (typeof body['ok'] !== 'boolean') return 'ok must be a boolean';
  if (body['url'] !== undefined && (typeof body['url'] !== 'string' || body['url'].length > 4096)) return 'url must be a string';
  if (body['error'] !== undefined && typeof body['error'] !== 'string') return 'error must be a string';
  return {
    id: body['id'],
    ok: body['ok'],
    ...(typeof body['url'] === 'string' ? { url: body['url'] } : {}),
    ...(body['data'] !== undefined ? { data: body['data'] } : {}),
    ...(typeof body['error'] === 'string' ? { error: body['error'] } : {}),
  };
}

export const handleBrowserApi: ApiModule = async (_ctx, req, res, path, method) => {
  if (VERSE_BROWSER_MCP_PATH_RE.test(path)) {
    writeRaw(res, 410, { error: 'This Browser MCP grant endpoint has retired. Start a new turn to use Verse agent tools.' });
    return true;
  }

  if (path === VERSE_BROWSER_POLICY_PATH || path === VERSE_BROWSER_COMMANDS_PATH) {
    if (method !== 'GET') return false;
    const query = queryOf(req);
    if (!query) return invalid(res, 'invalid query');
    const allowed = path === VERSE_BROWSER_POLICY_PATH ? ['sessionId'] : ['sessionId', 'wait'];
    for (const key of query.keys()) if (!allowed.includes(key)) return invalid(res, `unknown parameter: ${key.slice(0, 40)}`);
    const sessionId = await knownSession(res, query.get('sessionId'));
    if (!sessionId) return true;
    if (path === VERSE_BROWSER_POLICY_PATH) {
      sendJson(res, 200, browserPolicy(sessionId));
      return true;
    }
    const waitRaw = query.get('wait');
    const wait = waitRaw === undefined ? BROWSER_POLL_MAX_WAIT_MS : Number(waitRaw);
    if (!Number.isInteger(wait) || wait < 0 || wait > BROWSER_POLL_MAX_WAIT_MS) return invalid(res, `wait must be 0-${BROWSER_POLL_MAX_WAIT_MS}`);
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.once('close', onClose);
    const commands = await claimBrowserCommands(sessionId, { waitMs: wait, signal: abort.signal });
    res.off('close', onClose);
    if (res.writableEnded || res.destroyed) {
      // The pane went away mid-poll: fail what it claimed so the agent hears now, not in 45 s.
      for (const command of commands) completeBrowserCommand(sessionId, { id: command.id, ok: false, error: 'The Browser pane closed.' });
      return true;
    }
    sendJson(res, 200, { commands });
    return true;
  }

  if (path === VERSE_BROWSER_ACCESS_PATH || path === VERSE_BROWSER_ALLOW_PATH || path === VERSE_BROWSER_ALLOWANCE_PATH || path === VERSE_BROWSER_RESULT_PATH || path === VERSE_BROWSER_DISPATCH_PATH) {
    if (method !== 'POST') return false;
    const body = await readJsonObject(req, res, path === VERSE_BROWSER_RESULT_PATH ? RESULT_BODY_BYTES : SMALL_BODY_BYTES);
    if (!body) return true;

    if (path === VERSE_BROWSER_DISPATCH_PATH) {
      const extra = onlyKeys(body, ['sessionId', 'id']);
      if (extra) return invalid(res, `unknown field: ${extra.slice(0, 40)}`);
      const sessionId = await knownSession(res, body['sessionId']);
      if (!sessionId) return true;
      if (typeof body['id'] !== 'string' || !/^bc_[A-Za-z0-9_-]{12}$/.test(body['id'])) return invalid(res, 'invalid command id');
      sendJson(res, 200, { allowed: canDispatchBrowserCommand(sessionId, body['id']) });
      return true;
    }

    if (path === VERSE_BROWSER_ACCESS_PATH) {
      const extra = onlyKeys(body, ['sessionId', 'enabled', 'scope']);
      if (extra) return invalid(res, `unknown field: ${extra.slice(0, 40)}`);
      if (typeof body['enabled'] !== 'boolean') return invalid(res, 'enabled must be a boolean');
      const scope = body['scope'] === undefined ? 'browser' : body['scope'];
      if (typeof scope !== 'string' || !(VERSE_BROWSER_SCOPES as readonly string[]).includes(scope)) {
        return invalid(res, `scope must be one of ${VERSE_BROWSER_SCOPES.join(', ')}`);
      }
      const sessionId = await knownSession(res, body['sessionId']);
      if (!sessionId) return true;
      const port = localPort(req);
      if (port === null) {
        sendJson(res, 503, { code: 'VERSE_UNAVAILABLE', error: 'could not tell which port Verse is serving on' });
        return true;
      }
      const enabled = body['enabled'];
      const current = agentToolsGrant(sessionId);
      if (scope !== 'browser' && (!browserPolicy(sessionId).agentAccess || (scope === 'browser_script' && enabled && current.browser === 'look'))) {
        sendJson(res, 409, { code: 'VERSE_BROWSER_ACCESS_OFF', error: 'switch agent access on for this chat first' });
        return true;
      }
      const origin = `http://127.0.0.1:${port}`;
      if (scope === 'browser') {
        setAgentToolsGrant(sessionId, enabled ? { browser: 'act-localhost', browserScript: false } : { browser: 'off', browserScript: false }, origin);
      } else if (scope === 'browser_act') {
        setAgentToolsGrant(sessionId, enabled
          ? { browser: current.browser === 'act-allowed' ? 'act-allowed' : 'act-localhost' }
          : { browser: 'look', browserScript: false }, origin);
      } else {
        setAgentToolsGrant(sessionId, { browserScript: enabled }, origin);
      }
      sendJson(res, 200, browserPolicy(sessionId));
      return true;
    }

    if (path === VERSE_BROWSER_ALLOWANCE_PATH) {
      const extra = onlyKeys(body, ['sessionId', 'key']);
      if (extra) return invalid(res, `unknown field: ${extra.slice(0, 40)}`);
      if (typeof body['key'] !== 'string' || body['key'].length === 0 || body['key'].length > 600) return invalid(res, 'key is required');
      const sessionId = await knownSession(res, body['sessionId']);
      if (!sessionId) return true;
      sendJson(res, 200, revokeBrowserAllowance(sessionId, body['key']));
      return true;
    }

    if (path === VERSE_BROWSER_ALLOW_PATH) {
      const extra = onlyKeys(body, ['sessionId', 'origin', 'allowed']);
      if (extra) return invalid(res, `unknown field: ${extra.slice(0, 40)}`);
      if (typeof body['allowed'] !== 'boolean') return invalid(res, 'allowed must be a boolean');
      if (typeof body['origin'] !== 'string') return invalid(res, 'origin is required');
      const sessionId = await knownSession(res, body['sessionId']);
      if (!sessionId) return true;
      const policy = setBrowserOriginAllowed(sessionId, body['origin'], body['allowed']);
      if (!policy) return invalid(res, 'origin must be an http(s) origin such as https://example.com');
      sendJson(res, 200, policy);
      return true;
    }

    // result
    if (typeof body['sessionId'] !== 'string' || !VERSE_SESSION_ID_RE.test(body['sessionId'])) return invalid(res, 'sessionId is required');
    const parsed = parseResult(body);
    if (typeof parsed === 'string') return invalid(res, parsed);
    if (!completeBrowserCommand(body['sessionId'], parsed)) {
      sendJson(res, 404, { code: 'VERSE_BROWSER_COMMAND_GONE', error: 'that command is no longer waiting (it timed out or was cancelled)' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
};

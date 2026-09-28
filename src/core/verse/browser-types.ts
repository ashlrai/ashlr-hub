/**
 * core/verse/browser-types.ts — the integrated Browser pane's contract (3.15).
 *
 * Three parties exchange these shapes:
 *   - the Verse page's Browser pane (routes/verse/browser/**), which renders
 *     the tabs and EXECUTES every command (through the desktop shell's native
 *     webview, or an <iframe> for loopback pages in a plain browser tab);
 *   - the sidecar (browser-api.ts + browser-bridge.ts), which gates what an
 *     agent may ask for and relays it to the pane;
 *   - a chat seat, which reaches the sidecar over MCP (browser-mcp.ts) with a
 *     per-chat grant the operator switched on in the pane.
 *
 * The pane is the only executor on purpose: an agent can only ever look at
 * the browser the operator is looking at, in the chat the operator granted.
 *
 * BROWSER-SAFE: imported by the web bundle and by server.ts. Plain data and
 * pure functions only — no node: modules.
 */

export const VERSE_BROWSER_PATH = '/api/verse/browser';
/** GET ?sessionId= → VerseBrowserPolicy */
export const VERSE_BROWSER_POLICY_PATH = `${VERSE_BROWSER_PATH}/policy`;
/** POST { sessionId, enabled, scope? } → VerseBrowserPolicy (scope defaults to `browser`, the whole grant) */
export const VERSE_BROWSER_ACCESS_PATH = `${VERSE_BROWSER_PATH}/access`;
/** POST { sessionId, origin, allowed } → VerseBrowserPolicy */
export const VERSE_BROWSER_ALLOW_PATH = `${VERSE_BROWSER_PATH}/allow`;
/** POST { sessionId, key } → VerseBrowserPolicy (forget one "Allow for this chat" answer) */
export const VERSE_BROWSER_ALLOWANCE_PATH = `${VERSE_BROWSER_PATH}/allowance`;
/** GET ?sessionId=&wait= → VerseBrowserCommandsResponse (long-poll, ≤ 20 s) */
export const VERSE_BROWSER_COMMANDS_PATH = `${VERSE_BROWSER_PATH}/commands`;
/** POST { sessionId, id } → { allowed: boolean }; the pane's effect fence. */
export const VERSE_BROWSER_DISPATCH_PATH = `${VERSE_BROWSER_PATH}/dispatch`;
/** POST VerseBrowserCommandResult → { ok: true } */
export const VERSE_BROWSER_RESULT_PATH = `${VERSE_BROWSER_PATH}/result`;
/** POST (MCP streamable HTTP, stateless) — authenticated by the grant in the path, not the mutation token. */
export const VERSE_BROWSER_MCP_PATH = `${VERSE_BROWSER_PATH}/mcp`;

/**
 * The MCP path's exact shape: a 43-character base64url grant (32 random
 * bytes), the same form as a preview frame ticket. server.ts lets a GET on
 * this shape past the read boundary (so the module can answer 405 — an MCP
 * client probes GET for an SSE stream, and a 401 there would send it looking
 * for OAuth), and verse-api.ts lets a POST past the mutation gate: the module
 * authenticates the grant itself (browser-bridge.ts `sessionForGrant`).
 */
export const VERSE_BROWSER_MCP_PATH_RE = /^\/api\/verse\/browser\/mcp\/([A-Za-z0-9_-]{43})$/;

export function isBrowserMcpPath(path: string): boolean {
  return VERSE_BROWSER_MCP_PATH_RE.test(path);
}

/** The MCP server name a seat sees (`mcp__ashlr-browser__browser_navigate`). */
export const BROWSER_MCP_SERVER_NAME = 'ashlr-browser';

/**
 * What an agent may ask the pane to do.
 *
 * Reading (scope `browser`): status, navigate, screenshot, read-text,
 * console, snapshot, network, tabs, history. Acting (scope `browser_act`):
 * resolve (what a ref is, for the sidecar's safety decision) and act (one
 * click / type / select / hover / key / scroll, performed natively as real
 * input). Script (scope `browser_script`, off by default, loopback only):
 * evaluate. `confirm` is the sidecar asking the OPERATOR, through the pane,
 * whether an action that matters may go ahead.
 */
export type VerseBrowserAgentOp =
  | 'status'
  | 'navigate'
  | 'screenshot'
  | 'read-text'
  | 'console'
  | 'snapshot'
  | 'network'
  | 'tabs'
  | 'history'
  | 'resolve'
  | 'act'
  | 'evaluate'
  | 'confirm';

export const VERSE_BROWSER_AGENT_OPS: readonly VerseBrowserAgentOp[] = [
  'status', 'navigate', 'screenshot', 'read-text', 'console',
  'snapshot', 'network', 'tabs', 'history', 'resolve', 'act', 'evaluate', 'confirm',
];

/**
 * The three things an operator can switch on for a chat's agents. `browser`
 * is the whole grant (look + navigate); `browser_act` (click, type, …) comes
 * on with it and can be switched off alone; `browser_script` (run a JS
 * expression in a localhost page) stays off until switched on.
 */
export type VerseBrowserScope = 'browser' | 'browser_act' | 'browser_script';
export const VERSE_BROWSER_SCOPES: readonly VerseBrowserScope[] = ['browser', 'browser_act', 'browser_script'];

/** The operator's answer to a confirmation card. */
export type VerseBrowserDecision = 'once' | 'chat' | 'deny';
export const VERSE_BROWSER_DECISIONS: readonly VerseBrowserDecision[] = ['once', 'chat', 'deny'];

/** `confirm` command args: what the card shows. All of it is display text. */
export interface VerseBrowserConfirmRequest {
  /** "Click", "Type into", "Press Enter in", … */
  action: string;
  /** The element as the page names it (untrusted page text, rendered as text). */
  target: string | null;
  /** The origin it happens on. */
  origin: string;
  /** Why it needs the operator (one line each). */
  reasons: string[];
  /** The tool the agent called. */
  tool: string;
  /** When the sidecar stops waiting (ISO). */
  expiresAt: string;
}

/** One agent request, as the pane receives it. */
export interface VerseBrowserAgentCommand {
  id: string;
  sessionId: string;
  op: VerseBrowserAgentOp;
  /** navigate only — already gated by the sidecar. */
  url?: string;
  /** read-text: max characters; console: max entries. */
  limit?: number;
  /**
   * The op's arguments (snapshot, network, tabs, history, resolve, act,
   * evaluate, confirm, screenshot). Plain JSON built by the sidecar; the pane
   * re-validates every field against a closed shape before anything reaches
   * the page, and the desktop shell validates again.
   */
  args?: Record<string, unknown>;
  /**
   * The origins (besides loopback) this chat may observe, so the pane can
   * refuse BEFORE capturing a page the agent may not see. The sidecar checks
   * the answer again (defence in depth).
   */
  allowedOrigins: string[];
  createdAt: string;
}

export interface VerseBrowserCommandsResponse {
  commands: VerseBrowserAgentCommand[];
}

/** A console / network row as the pane reports it (also what "Send to chat" formats). */
export interface VerseBrowserConsoleEntry {
  t: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
}

export interface VerseBrowserNetworkEntry {
  t: number;
  method: string;
  url: string;
  /** null = the request never got a response (DNS, CORS, offline, blocked). */
  status: number | null;
  error?: string;
}

/** The pane's answer to one command. `data` shape depends on the op (see browser-bridge.ts). */
export interface VerseBrowserCommandResult {
  id: string;
  ok: boolean;
  /** The page the answer describes — the sidecar re-checks it against the gate. */
  url?: string;
  data?: unknown;
  error?: string;
}

/** A refused agent request, shown in the pane so the operator can allow the origin. */
export interface VerseBrowserBlockedRequest {
  url: string;
  origin: string;
  at: string;
}

export interface VerseBrowserPolicy {
  sessionId: string;
  /** The operator switched agent access on for this chat (until Verse restarts). */
  agentAccess: boolean;
  /** Agents may click, type, select, press keys and scroll (on with access; can be switched off alone). */
  actAccess: boolean;
  /** Agents may run a JS expression in a localhost page (off until switched on). */
  scriptAccess: boolean;
  /** "Allow for this chat" answers given on confirmation cards, oldest first. */
  allowances: string[];
  /** Origins beyond loopback this chat's agent may open and observe. */
  allowedOrigins: string[];
  /** Recent agent requests refused because their origin is not allowed (newest first, ≤ 5). */
  blocked: VerseBrowserBlockedRequest[];
  /** Seat engines that load the browser tools when access is on. */
  toolEngines: string[];
  /** When the pane last asked for commands for this chat (ISO), or null. */
  paneSeenAt: string | null;
}

// ---------------------------------------------------------------------------
// The URL gate (shared by the sidecar and the pane, so they cannot disagree)
// ---------------------------------------------------------------------------

export type BrowserUrlVerdict =
  | { ok: true; url: string; origin: string; loopback: boolean }
  | { ok: false; code: 'invalid' | 'scheme' | 'credentials' | 'self' | 'not-allowed'; origin: string | null; message: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** localhost, 127.0.0.1, [::1] and `*.localhost` (RFC 6761 — always loopback). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/**
 * May an AGENT open (or observe) `raw` in this chat?
 *
 *   - http(s) only, no `user:pass@`;
 *   - never Verse itself (`versePort` on a loopback host): the pane would be
 *     looking at the console that drives it;
 *   - loopback (the operator's own dev servers) — allowed by default. An agent
 *     that can already run `curl localhost:3000` gains nothing new here;
 *   - anything else only when the operator allowed that exact origin for
 *     this chat.
 *
 * The OPERATOR's own address bar is not gated by this (a browser goes where
 * its user points it) — only the Verse origin is refused there too.
 */
export function agentUrlVerdict(raw: string, opts: { versePort: number | null; allowedOrigins: readonly string[] }): BrowserUrlVerdict {
  let url: URL;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    return { ok: false, code: 'invalid', origin: null, message: 'the URL is empty or longer than 4096 characters' };
  }
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid', origin: null, message: 'that is not a valid absolute URL (include http:// or https://)' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'scheme', origin: null, message: `only http and https pages can be opened (not ${url.protocol.replace(/:$/, '')})` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'credentials', origin: url.origin, message: 'URLs carrying a username or password are refused' };
  }
  const loopback = isLoopbackHost(url.hostname);
  if (loopback && opts.versePort !== null && defaultPort(url) === String(opts.versePort)) {
    return { ok: false, code: 'self', origin: url.origin, message: 'Verse itself cannot be opened in its own browser pane' };
  }
  if (loopback) return { ok: true, url: url.href, origin: url.origin, loopback: true };
  if (opts.allowedOrigins.includes(url.origin)) return { ok: true, url: url.href, origin: url.origin, loopback: false };
  return {
    ok: false,
    code: 'not-allowed',
    origin: url.origin,
    message: `${url.origin} is outside this machine. Agents may only use localhost pages unless the operator allows an origin for this chat in the Browser pane (it is listed there as a blocked request).`,
  };
}

/** `https://Example.com/x?y` → `https://example.com`; null for anything that is not an http(s) origin. */
export function normalizeBrowserOrigin(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.origin;
}

// ---------------------------------------------------------------------------
// Console formatting (the agent's `browser_console` and the pane's "Send to chat")
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clockTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '--:--:--';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toISOString().slice(11, 19);
}

/**
 * Console rows and failed requests as plain text, newest last, at most
 * `limit` of each. One line per entry; multi-line messages keep their first
 * three lines. Empty sections say so rather than vanishing.
 */
export function formatBrowserConsole(
  consoleEntries: readonly VerseBrowserConsoleEntry[],
  network: readonly VerseBrowserNetworkEntry[],
  limit = 50,
): string {
  const n = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 50)));
  const logs = consoleEntries.slice(-n).map((e) => {
    const lines = String(e.text ?? '').split('\n');
    const body = lines.slice(0, 3).join('\n    ') + (lines.length > 3 ? ' …' : '');
    return `[${clockTime(e.t)}] ${String(e.level ?? 'log').toUpperCase().padEnd(5)} ${clip(body, 1000)}`;
  });
  const net = network.slice(-n).map((e) => {
    const status = e.status === null || e.status === undefined ? 'FAILED' : String(e.status);
    const why = e.error ? ` — ${clip(String(e.error), 200)}` : '';
    return `[${clockTime(e.t)}] ${status} ${String(e.method ?? 'GET').toUpperCase()} ${clip(String(e.url ?? ''), 300)}${why}`;
  });
  return [
    `Console (${logs.length}${consoleEntries.length > logs.length ? ` of ${consoleEntries.length}` : ''}):`,
    ...(logs.length > 0 ? logs : ['  (empty)']),
    '',
    `Network errors (${net.length}${network.length > net.length ? ` of ${network.length}` : ''}):`,
    ...(net.length > 0 ? net : ['  (none)']),
  ].join('\n');
}

const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

/** Boundary check for console rows crossing from a page (anything malformed is dropped). */
export function asConsoleEntries(value: unknown): VerseBrowserConsoleEntry[] {
  if (!Array.isArray(value)) return [];
  const out: VerseBrowserConsoleEntry[] = [];
  for (const row of value.slice(-500)) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r['text'] !== 'string') continue;
    const level = typeof r['level'] === 'string' && CONSOLE_LEVELS.has(r['level']) ? (r['level'] as VerseBrowserConsoleEntry['level']) : 'log';
    out.push({ t: typeof r['t'] === 'number' ? r['t'] : 0, level, text: clip(r['text'], 4000) });
  }
  return out;
}

/** Boundary check for failed-request rows crossing from a page. */
export function asNetworkEntries(value: unknown): VerseBrowserNetworkEntry[] {
  if (!Array.isArray(value)) return [];
  const out: VerseBrowserNetworkEntry[] = [];
  for (const row of value.slice(-500)) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r['url'] !== 'string') continue;
    out.push({
      t: typeof r['t'] === 'number' ? r['t'] : 0,
      method: typeof r['method'] === 'string' ? clip(r['method'], 12) : 'GET',
      url: clip(r['url'], 2000),
      status: typeof r['status'] === 'number' && Number.isInteger(r['status']) ? r['status'] : null,
      ...(typeof r['error'] === 'string' ? { error: clip(r['error'], 500) } : {}),
    });
  }
  return out;
}

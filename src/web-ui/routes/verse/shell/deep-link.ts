/**
 * routes/verse/shell/deep-link.ts — links INTO the workbench: a chat, and
 * optionally a pane in its panel area — or a terminal tab.
 *
 *   /verse/?chat=<sessionId>                 open that chat
 *   /verse/?chat=<sessionId>&pane=terminal   …with its Terminal showing
 *   /verse/?pane=reasoning                   the Chat surface, Reasoning open
 *   /verse/?terminal=<tabId>[&block=<id>]    a terminal tab, in its chat, with
 *                                            that command block shown (3.15)
 *
 * The desktop app sends the same thing as a command (`open-pane:<paneId>` or
 * `open-pane:<paneId>@<sessionId>`, `open-terminal:<tabId>[/<blockId>]` —
 * command-keys.ts parseDesktopCommand) — a notification can land on the diff
 * or the command it is about. In chat text a terminal tab is written
 * `verse://terminal/<tabId>[/<blockId>]` (parseTerminalLink below).
 *
 * A link is consumed ONCE: read on load, then stripped from the address bar
 * (history.replaceState) so a reload does not re-open it over whatever the
 * operator did since. Anything malformed is ignored, never guessed.
 *
 * Loaded on demand by the shell (only when the URL carries a link), never
 * on the first-paint path.
 */
import { normalizePaneId } from './dock-catalog.js';

/** A terminal tab, and optionally one of its command blocks. */
export interface TerminalLink {
  tabId: string;
  blockId: string | null;
}

export interface VerseDeepLink {
  sessionId: string | null;
  paneId: string | null;
  /** Present only when the link names a terminal tab (`?terminal=`). */
  terminal?: TerminalLink;
}

/** The same shape `open-session:<id>` accepts. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** The server's terminal tab and block ids (workbench-types VERSE_TERMINAL_AGENT_STATE_PATH_RE; blocks are `b-<n>`). */
export const TERMINAL_TAB_ID_RE = /^t-[a-z0-9]{1,32}$/;
export const TERMINAL_BLOCK_ID_RE = /^b-\d{1,9}$/;
const PARAMS = ['chat', 'pane', 'terminal', 'block'] as const;

/** `verse://terminal/<tabId>` or `verse://terminal/<tabId>/<blockId>` (a trailing slash is tolerated). */
const TERMINAL_LINK_RE = /^verse:\/\/terminal\/(t-[a-z0-9]{1,32})(?:\/(b-\d{1,9}))?\/?$/;

/** Read a `verse://terminal/…` link; null for anything else (never guessed). */
export function parseTerminalLink(href: string): TerminalLink | null {
  if (typeof href !== 'string') return null;
  const match = TERMINAL_LINK_RE.exec(href.trim());
  return match ? { tabId: match[1]!, blockId: match[2] ?? null } : null;
}

/** The `verse://terminal/<tab>[/<block>]` link of a tab (a block id that is not one is left off). */
export function terminalLinkUrl(tabId: string, blockId?: string | null): string {
  if (!TERMINAL_TAB_ID_RE.test(tabId)) throw new RangeError('not a terminal tab id');
  const block = blockId && TERMINAL_BLOCK_ID_RE.test(blockId) ? `/${blockId}` : '';
  return `verse://terminal/${tabId}${block}`;
}

/** Read a link from a query string (`?chat=…&pane=…`, `?terminal=…&block=…`); null when it names nothing valid. */
export function parseDeepLink(search: string): VerseDeepLink | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const chat = params.get('chat');
  const sessionId = chat !== null && SESSION_ID_RE.test(chat) ? chat : null;
  const paneId = normalizePaneId(params.get('pane'));
  const tab = params.get('terminal');
  if (tab !== null && TERMINAL_TAB_ID_RE.test(tab)) {
    const block = params.get('block');
    return { sessionId, paneId, terminal: { tabId: tab, blockId: block !== null && TERMINAL_BLOCK_ID_RE.test(block) ? block : null } };
  }
  return sessionId === null && paneId === null ? null : { sessionId, paneId };
}

/** Does this query string carry a link at all? (The shell's cheap check before loading this module.) */
export function hasDeepLink(search: string): boolean {
  return /[?&](?:chat|pane|terminal)=/.test(search);
}

/**
 * Take the link out of the current URL: parse it, then remove its params
 * (keeping every other param and the hash). Null when there is none.
 */
export function consumeDeepLink(win: Pick<Window, 'location' | 'history'> = window): VerseDeepLink | null {
  const link = parseDeepLink(win.location.search);
  if (!hasDeepLink(win.location.search)) return link;
  try {
    const url = new URL(win.location.href);
    for (const name of PARAMS) url.searchParams.delete(name);
    win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* an opaque origin (tests, file://): the link still opens */
  }
  return link;
}

/** The shareable URL of a chat (and optionally a pane), on this page's origin and path. */
export function deepLinkUrl(link: Partial<VerseDeepLink>, base: string = typeof window === 'undefined' ? 'http://127.0.0.1:7777/verse/' : window.location.href): string {
  const url = new URL(base);
  for (const name of PARAMS) url.searchParams.delete(name);
  url.hash = '';
  if (link.sessionId && SESSION_ID_RE.test(link.sessionId)) url.searchParams.set('chat', link.sessionId);
  const pane = normalizePaneId(link.paneId ?? null);
  if (pane) url.searchParams.set('pane', pane);
  if (link.terminal && TERMINAL_TAB_ID_RE.test(link.terminal.tabId)) {
    url.searchParams.set('terminal', link.terminal.tabId);
    if (link.terminal.blockId && TERMINAL_BLOCK_ID_RE.test(link.terminal.blockId)) url.searchParams.set('block', link.terminal.blockId);
  }
  return url.toString();
}

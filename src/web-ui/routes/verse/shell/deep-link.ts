/**
 * routes/verse/shell/deep-link.ts — links INTO the workbench: a chat, and
 * optionally a pane in its panel area.
 *
 *   /verse/?chat=<sessionId>                 open that chat
 *   /verse/?chat=<sessionId>&pane=terminal   …with its Terminal showing
 *   /verse/?pane=reasoning                   the Chat surface, Reasoning open
 *
 * The desktop app sends the same thing as a command (`open-pane:<paneId>` or
 * `open-pane:<paneId>@<sessionId>`, command-keys.ts parseDesktopCommand) —
 * a notification can land on the diff it is about.
 *
 * A link is consumed ONCE: read on load, then stripped from the address bar
 * (history.replaceState) so a reload does not re-open it over whatever the
 * operator did since. Anything malformed is ignored, never guessed.
 *
 * Loaded on demand by the shell (only when the URL carries a link), never
 * on the first-paint path.
 */
import { normalizePaneId } from './dock-catalog.js';

export interface VerseDeepLink {
  sessionId: string | null;
  paneId: string | null;
}

/** The same shape `open-session:<id>` accepts. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PARAMS = ['chat', 'pane'] as const;

/** Read a link from a query string (`?chat=…&pane=…`); null when it names nothing valid. */
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
  return sessionId === null && paneId === null ? null : { sessionId, paneId };
}

/** Does this query string carry a link at all? (The shell's cheap check before loading this module.) */
export function hasDeepLink(search: string): boolean {
  return /[?&](?:chat|pane)=/.test(search);
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
  return url.toString();
}

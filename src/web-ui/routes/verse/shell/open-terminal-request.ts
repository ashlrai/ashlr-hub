/**
 * routes/verse/shell/open-terminal-request.ts — "open this terminal tab" as a
 * window event (3.15), so every place that can point at a terminal tab goes
 * through ONE handler:
 *
 *   - a desktop notification click (`open-terminal:<tab>[/<block>]`),
 *   - a `/verse/?terminal=<tab>&block=<block>` deep link,
 *   - a `verse://terminal/<tab>/<block>` link in chat text (MessageMarkdown),
 *   - a Needs-you row whose target is a terminal (drawer, Command card).
 *
 * VerseApp listens (it holds the toast) and runs shell/open-terminal.ts, a
 * lazy chunk: this module is on the first-paint path and stays tiny —
 * validation and an event, nothing else.
 */

import { VERSE_OPEN_TERMINAL_EVENT } from './open-terminal-event.js';

export { VERSE_OPEN_TERMINAL_EVENT };

const TAB_RE = /^t-[a-z0-9]{1,32}$/;
const BLOCK_RE = /^b-\d{1,9}$/;
const SESSION_RE = /^[\w.-]{1,200}$/;

export interface OpenTerminalRequest {
  tabId: string;
  /** A command block of that tab to show. */
  blockId: string | null;
  /**
   * The chat the tab belongs to, when the caller already knows it (a
   * Needs-you item). The handler still asks the server — the tab may have
   * closed, or moved — and uses this only if it cannot.
   */
  sessionId?: string | null;
}

/** The request, cleaned; null when the tab id is not one (never guessed). */
export function normalizeOpenTerminalRequest(value: unknown): OpenTerminalRequest | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v['tabId'] !== 'string' || !TAB_RE.test(v['tabId'])) return null;
  const blockId = typeof v['blockId'] === 'string' && BLOCK_RE.test(v['blockId']) ? v['blockId'] : null;
  const sessionId = typeof v['sessionId'] === 'string' && SESSION_RE.test(v['sessionId']) ? v['sessionId'] : null;
  return { tabId: v['tabId'], blockId, sessionId };
}

/** Ask the shell to open a terminal tab (its chat, the Terminal pane, the block). */
export function requestOpenTerminal(request: OpenTerminalRequest): void {
  const clean = normalizeOpenTerminalRequest(request);
  if (!clean || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VERSE_OPEN_TERMINAL_EVENT, { detail: clean }));
}

/** The shell's side. Malformed requests are dropped. */
export function subscribeOpenTerminal(handler: (request: OpenTerminalRequest) => void): () => void {
  function onRequest(event: Event): void {
    const clean = normalizeOpenTerminalRequest((event as CustomEvent<unknown>).detail);
    if (clean) handler(clean);
  }
  window.addEventListener(VERSE_OPEN_TERMINAL_EVENT, onRequest);
  return () => window.removeEventListener(VERSE_OPEN_TERMINAL_EVENT, onRequest);
}

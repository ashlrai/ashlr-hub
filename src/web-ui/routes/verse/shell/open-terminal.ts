/**
 * routes/verse/shell/open-terminal.ts — open a terminal tab where it lives
 * (3.15): its chat, the Terminal pane, the tab focused and — with a block id —
 * that command block shown. The one handler behind every terminal pointer
 * (shell/open-terminal-request.ts lists them); VerseApp loads it on demand.
 *
 *   1. Ask the server which chat the tab belongs to (GET /api/verse/terminal).
 *      A tab that is gone says so (a toast) instead of opening an empty pane.
 *      If the server cannot answer, the caller's own sessionId is used.
 *   2. Open that chat (or the Chat surface, for a tab without one).
 *   3. Raise the Terminal pane request `{ tabId, blockId }` — AFTER the chat
 *      switch has landed: the chat surface drops pane requests on a switch
 *      (ChatSection → clearDockRequests), so a request raised before it would
 *      be thrown away with the chat being left.
 */
import type { VerseTerminalListResponse } from '../../../data/api-types.js';
import { requestTerminal, subscribeDockState } from '../dock/dock-store.js';
import { terminalApi } from '../dock/terminal/terminal-client.js';
import { closeVerseOverlay, getVerseUiState, openVerseSession, setVerseSection } from '../verse-ui-store.js';
import { normalizeOpenTerminalRequest } from './open-terminal-request.js';

export const TERMINAL_GONE_MESSAGE = 'That terminal is closed — its tab is no longer open.';

/** Longest wait for the chat switch before the request is raised anyway. */
export const SWITCH_WAIT_MS = 1500;

export interface OpenTerminalDeps {
  toast: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
  /** Test seam: the terminal list read. */
  list?: () => Promise<VerseTerminalListResponse>;
}

/**
 * Run `fn` once the chat surface has switched chats: the switch's dock update
 * (activateDockChat) is followed, in the same effect, by clearDockRequests —
 * so `fn` runs on the next task, after both. Falls back to a timer so a
 * switch that never reports cannot swallow the request.
 */
function afterChatSwitch(fn: () => void): void {
  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    setTimeout(fn, 0);
  };
  const unsubscribe = subscribeDockState(fire);
  const timer = setTimeout(fire, SWITCH_WAIT_MS);
}

/** Show the tab: open its chat (or the Chat surface) and request the Terminal pane on it. */
export function showTerminalTab(sessionId: string | null, tabId: string, blockId: string | null): void {
  closeVerseOverlay();
  const request = blockId ? { tabId, blockId } : { tabId };
  const ui = getVerseUiState();
  // No switch is coming when there is no chat to open, when the chat surface
  // is not mounted yet (it mounts on the stored selection and keeps pending
  // requests), or when that chat is already the open one.
  if (sessionId === null || !ui.mounted.includes('chat') || ui.activeSessionId === sessionId) {
    if (sessionId) openVerseSession(sessionId);
    else setVerseSection('chat');
    requestTerminal(request);
    return;
  }
  openVerseSession(sessionId);
  afterChatSwitch(() => requestTerminal(request));
}

/**
 * Open a terminal tab. Resolves true when it was opened, false when the
 * request was malformed or the tab no longer exists (the operator is told).
 * `target` is an OpenTerminalRequest or a raw event detail (VerseApp passes it unread): it is
 * validated here, so the first-paint shell carries no validator.
 */
export async function openTerminalTarget(target: unknown, deps: OpenTerminalDeps): Promise<boolean> {
  const clean = normalizeOpenTerminalRequest(target);
  if (!clean) return false;
  let sessionId = clean.sessionId ?? null;
  let listed: VerseTerminalListResponse | null = null;
  try {
    listed = await (deps.list ?? (() => terminalApi.list()))();
  } catch {
    listed = null; // could not check: open where the caller said; the pane reports a missing tab
  }
  if (listed) {
    const tab = listed.tabs.find((t) => t.id === clean.tabId);
    if (!tab) {
      deps.toast(listed.available ? TERMINAL_GONE_MESSAGE : listed.reason ?? 'The terminal is not available here.', 'neutral');
      return false;
    }
    sessionId = tab.sessionId;
  }
  showTerminalTab(sessionId, clean.tabId, clean.blockId);
  return true;
}

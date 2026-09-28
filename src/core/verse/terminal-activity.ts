/**
 * core/verse/terminal-activity.ts — what the terminal tells the rest of the
 * app (3.15), in memory only:
 *
 *   - the last few TERMINAL EVENTS (a long command finished, a CLI agent went
 *     idle or needs the operator) for `/api/verse/activity`'s `terminal`
 *     field, which the desktop notifier (activity_watch.rs → notify.rs) reads
 *     and announces while the app is not in front;
 *   - `needsYouItems()`: every agent tab currently waiting on the operator,
 *     filed as `chats` / `agent-waiting` items in the Needs-you drawer.
 *
 * The terminal manager (terminal.ts) writes here; activity reads. Pure and
 * O(tabs): activity calls it on every poll.
 *
 * NEVER A COMMAND LINE. An event carries the tab's title, an exit code and a
 * duration — a command line can hold a secret, and a banner is readable by
 * anyone near the screen.
 */
import { randomBytes } from 'node:crypto';

import {
  NEEDS_YOU_DETAIL_MAX,
  NEEDS_YOU_TITLE_MAX,
  type NeedsYouItem,
  type VerseActivityTerminal,
  type VerseTerminalActivityEvent,
  type VerseTerminalAgentKind,
} from './workbench-types.js';
import type { VerseEngine } from './types.js';

/** Events kept for the notifier (it polls every 5–30 s; a burst beyond this is coalesced by count anyway). */
export const TERMINAL_ACTIVITY_MAX_EVENTS = 20;

export const TERMINAL_AGENT_LABEL: Readonly<Record<VerseTerminalAgentKind, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  devin: 'Devin',
  grok: 'Grok',
};

const AGENT_ENGINE: Readonly<Record<VerseTerminalAgentKind, VerseEngine>> = {
  'claude-code': 'claude',
  codex: 'codex',
  devin: 'devin',
  grok: 'grok',
};

interface WaitingTab {
  tabId: string;
  sessionId: string | null;
  title: string;
  agent: VerseTerminalAgentKind;
  since: string;
  message: string | null;
}

let boot = randomBytes(4).toString('hex');
let seq = 0;
let events: VerseTerminalActivityEvent[] = [];
const waiting = new Map<string, WaitingTab>();

export function recordTerminalEvent(event: Omit<VerseTerminalActivityEvent, 'seq' | 'at'> & { at?: string }): VerseTerminalActivityEvent {
  seq += 1;
  const full: VerseTerminalActivityEvent = { ...event, seq, at: event.at ?? new Date().toISOString() };
  events.push(full);
  if (events.length > TERMINAL_ACTIVITY_MAX_EVENTS) events = events.slice(events.length - TERMINAL_ACTIVITY_MAX_EVENTS);
  return full;
}

export function terminalActivitySnapshot(): VerseActivityTerminal {
  return { boot, seq, events: events.map((e) => ({ ...e })) };
}

/** A tab's agent is (or is no longer) waiting on the operator. `null` clears it (another state, or the tab closed). */
export function setAgentWaiting(tabId: string, entry: Omit<WaitingTab, 'tabId'> | null): void {
  if (entry) waiting.set(tabId, { tabId, ...entry });
  else waiting.delete(tabId);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** R1 producer: one `agent-waiting` item per agent tab waiting on the operator. */
export function needsYouItems(): NeedsYouItem[] {
  return [...waiting.values()].map((w) => ({
    id: `chats:agent-waiting:${w.tabId}`,
    source: 'chats',
    kind: 'agent-waiting',
    severity: 'warn',
    title: clip(`${TERMINAL_AGENT_LABEL[w.agent]} needs you · ${w.title}`, NEEDS_YOU_TITLE_MAX),
    detail: w.message ? clip(w.message, NEEDS_YOU_DETAIL_MAX) : null,
    since: w.since,
    expiresAt: null,
    subject: { repo: null, pr: null, seatId: null, sessionId: w.sessionId, engine: AGENT_ENGINE[w.agent] },
    target: { kind: 'terminal', sessionId: w.sessionId, tabId: w.tabId },
    actions: [],
  }));
}

/** Test hook: a fresh boot with no events and nothing waiting. */
export function resetTerminalActivityForTest(): void {
  boot = randomBytes(4).toString('hex');
  seq = 0;
  events = [];
  waiting.clear();
}

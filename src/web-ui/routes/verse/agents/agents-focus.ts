/**
 * routes/verse/agents/agents-focus.ts — "open the Agents board with New agent
 * up" from a key (⌘N on the board, ⇧⌘N anywhere) or ⌘K. The board is its own
 * lazy chunk, so a request waits here (up to REQUEST_TTL_MS) until it mounts
 * and takes it — the same shape as automations-focus.ts.
 */
import { setVerseSection } from '../verse-ui-store.js';

export type AgentsFocusKind = 'new' | 'new-multi' | 'board';
export type AgentsFocusRequest = { kind: AgentsFocusKind; seq: number; at: number; cardId?: string };

export const REQUEST_TTL_MS = 20_000;

let current: AgentsFocusRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function requestAgentsFocus(kind: AgentsFocusKind, cardId?: string): void {
  seq += 1;
  current = { kind, seq, at: Date.now(), ...(cardId ? { cardId } : {}) };
  setVerseSection('agents');
  emit();
}

export function getAgentsFocus(): AgentsFocusRequest | null {
  return current;
}

export function isAgentsFocusLive(request: AgentsFocusRequest, now: number = Date.now()): boolean {
  return now - request.at <= REQUEST_TTL_MS;
}

export function takeAgentsFocus(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  emit();
}

export function subscribeAgentsFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

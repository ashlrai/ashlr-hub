/**
 * routes/verse/wiki/wiki-focus.ts — "take me to the repo wiki": the hand-off
 * from ⌘K ("Open repo wiki…", "Ask the codebase…") to the lazily mounted Wiki
 * section, the same shape as leader/leader-focus.ts.
 *
 *   requestWikiFocus({ kind: 'repo', projectPath })  Wiki, that repo selected
 *   requestWikiFocus({ kind: 'ask', projectPath })   Wiki, Ask box focused
 *
 * A store, not a parked command: the section is its own chunk; a request
 * here waits (up to REQUEST_TTL_MS) until it mounts and takes it. Tiny and
 * framework-free: the shell's palette handler imports it on demand.
 */
import { setVerseSection } from '../verse-ui-store.js';

export type WikiFocusTarget = { kind: 'repo' | 'ask'; projectPath: string | null };
export type WikiFocusRequest = WikiFocusTarget & { seq: number; at: number };

export const REQUEST_TTL_MS = 20_000;

let current: WikiFocusRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function requestWikiFocus(target: WikiFocusTarget): void {
  seq += 1;
  current = { ...target, seq, at: Date.now() };
  setVerseSection('wiki');
  emit();
}

export function getWikiFocus(): WikiFocusRequest | null {
  return current;
}

export function isWikiFocusLive(request: WikiFocusRequest, now: number = Date.now()): boolean {
  return now - request.at <= REQUEST_TTL_MS;
}

/** Clear request `requestSeq` (only that one — a newer ask survives). */
export function takeWikiFocus(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  emit();
}

export function subscribeWikiFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hygiene. */
export function resetWikiFocus(): void {
  current = null;
  emit();
}

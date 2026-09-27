/**
 * routes/verse/playbooks/playbook-focus.ts — ⌘K "Run playbook…" → the lazily
 * mounted Playbooks section, in "choose one to run" mode (the same shape as
 * wiki/wiki-focus.ts). A request waits (up to REQUEST_TTL_MS) until the
 * section mounts and takes it. Tiny and framework-free.
 */
import { setVerseSection } from '../verse-ui-store.js';

export type PlaybookFocusTarget = { kind: 'run' };
export type PlaybookFocusRequest = PlaybookFocusTarget & { seq: number; at: number };

export const REQUEST_TTL_MS = 20_000;

let current: PlaybookFocusRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function requestPlaybookFocus(target: PlaybookFocusTarget): void {
  seq += 1;
  current = { ...target, seq, at: Date.now() };
  setVerseSection('playbooks');
  emit();
}

export function getPlaybookFocus(): PlaybookFocusRequest | null {
  return current;
}

export function isPlaybookFocusLive(request: PlaybookFocusRequest, now: number = Date.now()): boolean {
  return now - request.at <= REQUEST_TTL_MS;
}

/** Clear request `requestSeq` (only that one — a newer ask survives). */
export function takePlaybookFocus(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  emit();
}

export function subscribePlaybookFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hygiene. */
export function resetPlaybookFocus(): void {
  current = null;
  emit();
}

/**
 * routes/verse/automations/automations-focus.ts — "take me to Automations"
 * from ⌘K: open the section, optionally with the New automation form open
 * (same shape as wiki/wiki-focus.ts). The section is its own lazy chunk, so a
 * request waits here (up to REQUEST_TTL_MS) until it mounts and takes it.
 */
import { setVerseSection } from '../verse-ui-store.js';

export type AutomationsFocusRequest = { kind: 'list' | 'new'; seq: number; at: number };

export const REQUEST_TTL_MS = 20_000;

let current: AutomationsFocusRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function requestAutomationsFocus(kind: AutomationsFocusRequest['kind']): void {
  seq += 1;
  current = { kind, seq, at: Date.now() };
  setVerseSection('automations');
  emit();
}

export function getAutomationsFocus(): AutomationsFocusRequest | null {
  return current;
}

export function isAutomationsFocusLive(request: AutomationsFocusRequest, now: number = Date.now()): boolean {
  return now - request.at <= REQUEST_TTL_MS;
}

export function takeAutomationsFocus(requestSeq: number): void {
  if (current?.seq !== requestSeq) return;
  current = null;
  emit();
}

export function subscribeAutomationsFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetAutomationsFocus(): void {
  current = null;
  emit();
}

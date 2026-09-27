/**
 * routes/verse/shell/focus-mode.ts — FOCUS MODE (⇧⌘F): everything but the
 * conversation steps aside — the rail, the chat list, the panel area and
 * the header's pane controls — and the transcript and composer take the
 * window. The same key (or Esc from anywhere outside the composer, or the
 * "Exit focus" pill) brings them back exactly as they were: nothing is
 * closed, only hidden.
 *
 * Deliberately NOT persisted. A reload that came back with no rail and no
 * chat list would look broken to someone who forgot they pressed a key.
 *
 * Tiny and framework-light: on the chat's first-paint path (the shell reads
 * it to hide the rail).
 */
import { useSyncExternalStore } from 'react';

let focused = false;
const listeners = new Set<() => void>();

export function isFocusMode(): boolean {
  return focused;
}

export function setFocusMode(next: boolean): void {
  if (focused === next) return;
  focused = next;
  for (const listener of [...listeners]) listener();
}

export function toggleFocusMode(): void {
  setFocusMode(!focused);
}

export function subscribeFocusMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribeFocusMode, isFocusMode, isFocusMode);
}

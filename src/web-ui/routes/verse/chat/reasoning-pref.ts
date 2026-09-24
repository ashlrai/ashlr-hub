/**
 * routes/verse/chat/reasoning-pref.ts — how the transcript shows the model's
 * reasoning (SPEC-310C §2 "Settings offers Expanded, Collapsed or Hidden";
 * unit C2 owns the behaviour, C1's Settings ▸ Chat panel renders the control).
 *
 *   collapsed  (default) a block streams in a three-line window while the
 *              model thinks, then folds to "Thought 12s · ~1.8k tok ▸";
 *   expanded   the same stream, but a finished block stays open;
 *   hidden     no reasoning in the transcript at all — the live status line
 *              still says "Thinking · 12s", so a long think is never mistaken
 *              for a hang.
 *
 * A per-device preference, so it lives in this browser's storage under its
 * own key (the precedent of resources-collapse / chat-panel-sizing: display
 * preferences that are not part of the shell's v3 blob). Framework-free store
 * + one hook; every read and write is try/catch'd because storage can be
 * absent (private window, blocked site data).
 */
import { useSyncExternalStore } from 'react';

export const REASONING_DISPLAYS = ['collapsed', 'expanded', 'hidden'] as const;
export type ReasoningDisplay = (typeof REASONING_DISPLAYS)[number];

export const REASONING_DISPLAY_LABEL: Readonly<Record<ReasoningDisplay, string>> = {
  collapsed: 'Collapsed',
  expanded: 'Expanded',
  hidden: 'Hidden',
};

export const REASONING_DISPLAY_KEY = 'ashlr.verse.reasoning.v1';
export const DEFAULT_REASONING_DISPLAY: ReasoningDisplay = 'collapsed';

export function isReasoningDisplay(value: unknown): value is ReasoningDisplay {
  return typeof value === 'string' && (REASONING_DISPLAYS as readonly string[]).includes(value);
}

function read(): ReasoningDisplay {
  try {
    const raw = localStorage.getItem(REASONING_DISPLAY_KEY);
    return isReasoningDisplay(raw) ? raw : DEFAULT_REASONING_DISPLAY;
  } catch {
    return DEFAULT_REASONING_DISPLAY;
  }
}

let current: ReasoningDisplay | null = null;
const listeners = new Set<() => void>();

export function getReasoningDisplay(): ReasoningDisplay {
  if (current === null) current = read();
  return current;
}

export function setReasoningDisplay(next: ReasoningDisplay): void {
  if (!isReasoningDisplay(next) || next === getReasoningDisplay()) return;
  current = next;
  try {
    localStorage.setItem(REASONING_DISPLAY_KEY, next);
  } catch {
    /* the choice still holds for this page */
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeReasoningDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget the in-memory value so the next read re-reads storage. */
export function resetReasoningDisplay(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}

export function useReasoningDisplay(): ReasoningDisplay {
  return useSyncExternalStore(subscribeReasoningDisplay, getReasoningDisplay, getReasoningDisplay);
}

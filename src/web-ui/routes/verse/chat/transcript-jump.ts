/**
 * routes/verse/chat/transcript-jump.ts — "scroll the open transcript to this
 * tool call", from outside the transcript (unit C2).
 *
 * The dock's Tasks pane lists this turn's calls and a click must land on
 * the call in the transcript — but the pane is a different subtree (and, as
 * a sheet, a different layer). The mounted Transcript subscribes here and
 * performs the jump with its own machinery (opening a folded activity group,
 * the locator flash, focus). A tiny module, so the dock does not import the
 * transcript.
 */
type JumpListener = (anchorId: string) => boolean;

const listeners = new Set<JumpListener>();

export function onTranscriptJump(listener: JumpListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when a mounted transcript took the jump. */
export function requestTranscriptJump(anchorId: string): boolean {
  let handled = false;
  for (const listener of [...listeners]) if (listener(anchorId)) handled = true;
  return handled;
}

// ⌘F from the palette ("Find in chat"): focus the transcript's own search.
const findListeners = new Set<() => boolean>();

export function onTranscriptFind(listener: () => boolean): () => void {
  findListeners.add(listener);
  return () => findListeners.delete(listener);
}

export function requestTranscriptFind(): boolean {
  let handled = false;
  for (const listener of [...findListeners]) if (listener()) handled = true;
  return handled;
}

// ⌥↑ / ⌥↓ routed through the command bus (palette, native menu).
const stepListeners = new Set<(delta: 1 | -1) => boolean>();

export function onTranscriptStep(listener: (delta: 1 | -1) => boolean): () => void {
  stepListeners.add(listener);
  return () => stepListeners.delete(listener);
}

export function requestTranscriptStep(delta: 1 | -1): boolean {
  let handled = false;
  for (const listener of [...stepListeners]) if (listener(delta)) handled = true;
  return handled;
}

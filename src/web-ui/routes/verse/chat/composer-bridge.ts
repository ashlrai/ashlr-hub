/**
 * routes/verse/chat/composer-bridge.ts — how the chat's other surfaces put
 * text INTO the composer without sending it (unit C2).
 *
 * Three dock actions draft into the message box and leave the send to the
 * operator (the first spend is always their press):
 *   - Terminal ▸ "Send selection to chat" — the selection as a fenced block;
 *   - Review ▸ "Add to message" — `path:line: note`;
 *   - anything later that "drafts a follow-up".
 *
 * The composer is C3's component and owns its text state. The clean seam is
 * for it to register an inserter here (`registerComposerInserter`) — that is
 * a cross-unit request. Until it does, the fallback types into the composer's
 * textarea the way a paste would: the native value setter plus an `input`
 * event, which React's controlled textarea treats as the operator's own
 * edit (so its draft persistence, cost hint and undo stack all see it).
 * Either way the text is APPENDED on its own paragraph and never sent.
 */

export type ComposerInserter = (text: string) => void;

const inserters = new Map<string, ComposerInserter>();

/** C3: `useEffect(() => registerComposerInserter(sessionId, insert), [sessionId])`. Returns the unregister. */
export function registerComposerInserter(sessionId: string, insert: ComposerInserter): () => void {
  inserters.set(sessionId, insert);
  return () => {
    if (inserters.get(sessionId) === insert) inserters.delete(sessionId);
  };
}

/** Join an insertion onto existing text: its own paragraph, never glued to a half-typed word. */
export function appendParagraph(current: string, text: string): string {
  const addition = text.replace(/\s+$/, '');
  if (!current.trim()) return addition;
  return `${current.replace(/\s+$/, '')}\n\n${addition}`;
}

/** The composer's message box in the chat surface (C3's `aria-label="Message"`). */
function findComposerBox(root: ParentNode = document): HTMLTextAreaElement | null {
  const node = root.querySelector('textarea[aria-label="Message"]');
  return node instanceof HTMLTextAreaElement ? node : null;
}

/**
 * Append `text` to `sessionId`'s composer and focus it. False when there is
 * no composer to write into (no chat open, or it is disabled) — the caller
 * then says so rather than dropping the text silently.
 */
export function insertIntoComposer(sessionId: string, text: string): boolean {
  if (!text.trim()) return false;
  const registered = inserters.get(sessionId);
  if (registered) {
    registered(text);
    return true;
  }
  const box = findComposerBox();
  if (!box || box.disabled) return false;
  const next = appendParagraph(box.value, text);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(box, next);
  else box.value = next;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  const end = box.value.length;
  try {
    box.setSelectionRange(end, end);
  } catch {
    /* a detached or hidden box has no selection; the text is in either way */
  }
  return true;
}

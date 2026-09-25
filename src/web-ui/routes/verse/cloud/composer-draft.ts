/**
 * routes/verse/cloud/composer-draft.ts — read and clear the chat composer's
 * draft from outside the Composer (3.11 unit C3, for "Run in cloud").
 *
 * The composer owns its text state and takes no cloud props: the ⋯ sheet is
 * the one place the cloud lane may add to it (SPEC 3.11 C3). So, like the
 * dock's "Send selection to chat" fallback (chat/composer-bridge.ts), this
 * goes through the box itself: read its value, and clear it with the native
 * setter plus an `input` event, which React's controlled textarea treats as
 * the operator's own edit — its draft persistence sees the empty box too, so
 * a reload does not bring the launched text back.
 */

/** The chat composer's message box (the Composer's `aria-label="Message"`). */
export function findComposerBox(root: ParentNode = document): HTMLTextAreaElement | null {
  const node = root.querySelector('textarea[aria-label="Message"]');
  return node instanceof HTMLTextAreaElement ? node : null;
}

export function readComposerDraft(root?: ParentNode): string {
  return findComposerBox(root)?.value ?? '';
}

/** Empty the box as a person would. False when there is no box to clear. */
export function clearComposerDraft(root?: ParentNode): boolean {
  const box = findComposerBox(root);
  if (!box) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(box, '');
  else box.value = '';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

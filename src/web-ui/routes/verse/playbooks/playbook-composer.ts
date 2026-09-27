/**
 * routes/verse/playbooks/playbook-composer.ts — put a playbook's `!macro`
 * into the chat composer (never send it).
 *
 * A playbook reaches a task through its text: `!fix-bug` in the message is
 * resolved by whichever lane runs it (the chat itself on any seat, Run in
 * cloud, Run in Devin, a fleet goal). So "Use playbook…" and "Run…" only
 * WRITE the macro at the front of the draft — the operator still describes
 * the task and picks the lane.
 *
 * Like cloud/composer-draft.ts, this goes through the box itself (native
 * setter + `input` event), which React's controlled textarea treats as the
 * operator's own edit, so draft persistence sees it too.
 */
import { findComposerBox } from '../cloud/composer-draft.js';
import { setVerseSection } from '../verse-ui-store.js';

/** `!name` tokens anywhere in prose (the server's rule, simplified: whitespace or start before `!`). */
const MACRO_TOKEN = /(^|\s)![a-z0-9][a-z0-9-]{1,47}(?:@v?\d{1,6})?(?=\s|$)/g;

/**
 * The draft with `macro` at its front. A draft that already names a
 * playbook has that one replaced (one playbook per task); an empty draft
 * becomes `!macro ` ready for the task text. Pure.
 */
export function withMacro(draft: string, macro: string): string {
  const stripped = draft.replace(MACRO_TOKEN, (_m, lead: string) => lead).replace(/^\s+/, '');
  return stripped ? `${macro} ${stripped}` : `${macro} `;
}

function write(box: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(box, value);
  else box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  const end = box.value.length;
  try {
    box.setSelectionRange(end, end);
  } catch {
    /* a hidden box has no selection; the text is in either way */
  }
}

/** Write the macro into the composer on screen. False when there is no usable box. */
export function putMacroInComposerNow(macro: string, root?: ParentNode): boolean {
  const box = findComposerBox(root);
  if (!box || box.disabled) return false;
  write(box, withMacro(box.value, macro));
  return true;
}

/**
 * Go to Chat and write the macro once its composer is mounted (the Chat
 * section may be a chunk that is still loading). False when no chat composer
 * appeared in time — the caller says so (open a chat first).
 */
export async function putMacroInComposer(macro: string, opts: { waitMs?: number; root?: ParentNode } = {}): Promise<boolean> {
  setVerseSection('chat');
  const deadline = Date.now() + (opts.waitMs ?? 3_000);
  for (;;) {
    if (putMacroInComposerNow(macro, opts.root)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/**
 * routes/verse/voice/insert-text.ts — where a dictated chunk lands in a text
 * value: at the caret (replacing a selection), with exactly one space between
 * it and the words around it, never a space after a newline or before
 * closing punctuation. Pure.
 */

export interface Inserted {
  value: string;
  /** Caret position just after the inserted chunk. */
  caret: number;
}

const NO_SPACE_BEFORE = /^[.,;:!?)\]}'"’”…]/;

export function insertDictation(value: string, chunk: string, selectionStart?: number | null, selectionEnd?: number | null): Inserted {
  const text = chunk.trim();
  const start = clamp(selectionStart ?? value.length, value.length);
  const end = Math.max(start, clamp(selectionEnd ?? start, value.length));
  if (!text) return { value, caret: start };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) && !NO_SPACE_BEFORE.test(text) ? ' ' : '';
  const trail = after.length > 0 && !/^\s/.test(after) && !NO_SPACE_BEFORE.test(after) ? ' ' : '';
  const next = `${before}${lead}${text}${trail}${after}`;
  return { value: next, caret: before.length + lead.length + text.length + trail.length };
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(0, Math.trunc(Number.isFinite(n) ? n : max)), max);
}

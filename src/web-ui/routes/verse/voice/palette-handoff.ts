/**
 * routes/verse/voice/palette-handoff.ts — voice command mode (⌃⌥⇧V): the
 * dictated words become the ⌘K query, so the existing palette model (fuzzy
 * match over the command catalog, chats, seats, projects) picks the command
 * and the operator confirms with ↩. Nothing runs by voice alone.
 *
 * Tiny on purpose: CommandPalette imports it, and it must not pull the voice
 * UI into the palette chunk.
 */
import { openVerseOverlay } from '../verse-ui-store.js';

export const PALETTE_QUERY_EVENT = 'ashlr:palette-query';
const QUERY_MAX = 200;

let pending: string | null = null;

/** Open ⌘K with `text` as its query (or replace the query if it is open). */
export function handOffToPalette(text: string): void {
  const query = text.trim().replace(/[.!?]+$/, '').slice(0, QUERY_MAX);
  if (!query) return;
  pending = query;
  openVerseOverlay('palette');
  try {
    window.dispatchEvent(new CustomEvent(PALETTE_QUERY_EVENT, { detail: query }));
  } catch {
    /* no window */
  }
}

/** The palette's initial query, once. */
export function takePaletteQuery(): string | null {
  const query = pending;
  pending = null;
  return query;
}

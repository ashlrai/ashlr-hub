/**
 * routes/verse/shell/anchor-requests.ts — the shell's one listener for
 * VERSE_ANCHOR_EVENT ("go to that card"); the reveal itself is
 * shell/reveal-anchor.ts.
 *
 * WHY SEPARATE: VerseApp installs this listener at first paint, but nothing
 * is revealed until an operator follows a link into a surface. The reveal
 * logic (and command/nav.ts with it) is preloaded instead of imported: its
 * download starts when this module evaluates, and once it is in a request
 * is revealed synchronously, exactly as with a static import. A request
 * that arrives before it lands is revealed when it does — the reveal waits
 * for its element for up to ANCHOR_WAIT_MS anyway.
 */
import type { VerseAnchorRequest } from '../verse-ui-store.js';

type RevealModule = typeof import('./reveal-anchor.js');

let loaded: RevealModule | null = null;
let pending: Promise<RevealModule> | null = null;
function loadReveal(): Promise<RevealModule> {
  // A failed download is not cached: the next request asks again.
  pending ??= import('./reveal-anchor.js').then((m) => (loaded = m), (err: unknown) => { pending = null; throw err; });
  return pending;
}
if (typeof window !== 'undefined') void loadReveal().catch(() => undefined);

function reveal(request: VerseAnchorRequest): void {
  if (loaded) {
    void loaded.revealAnchor(request);
    return;
  }
  void loadReveal().then((m) => m.revealAnchor(request), () => undefined);
}

/** The shell's one listener. Returns the unsubscribe. */
export function subscribeAnchorRequests(eventName: string): () => void {
  if (typeof window === 'undefined') return () => {};
  function onAnchor(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'object' || detail === null) return;
    const { section, anchor } = detail as Record<string, unknown>;
    if (typeof section !== 'string' || typeof anchor !== 'string' || anchor.length === 0 || anchor.length > 200) return;
    reveal({ section: section as VerseAnchorRequest['section'], anchor });
  }
  window.addEventListener(eventName, onAnchor);
  return () => window.removeEventListener(eventName, onAnchor);
}

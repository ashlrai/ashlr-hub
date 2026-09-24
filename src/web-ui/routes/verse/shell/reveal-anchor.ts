/**
 * routes/verse/shell/reveal-anchor.ts — "go to that card" for any surface
 * (unit C1; C7 cross-unit request 3).
 *
 * Needs-you items, Leader memos and Command cards point INTO a surface
 * ("memo:m-7" on Mind, "seat:claude-a" on Apps). Whoever raises it calls
 * `setVerseSection(section, anchor)` (or dispatches VERSE_ANCHOR_EVENT); the
 * shell listens once (VerseApp) and reveals the element here.
 *
 * WHY WAIT, AND FOR HOW LONG. The target surface may be a lazy chunk that has
 * not loaded, a keep-alive surface un-hiding, or a list still fetching its
 * rows. Two animation frames (C7's own fallback in command/nav.ts) cover the
 * keep-alive case only; a cold chunk takes longer. So this watches the
 * surface's subtree until the element appears, and gives up quietly after
 * ANCHOR_WAIT_MS — a missing anchor is never an error, the operator is
 * already on the right surface.
 *
 * WHICH ELEMENT. C7 stamps `id="c7-anchor-<key>"` (command/nav.ts anchorId);
 * any other owner may stamp `data-verse-anchor="<key>"` instead of adopting
 * C7's id scheme. The search is scoped to `[data-surface=<section>]` so an
 * identically-keyed card on a HIDDEN keep-alive surface never wins.
 */
import { anchorId } from '../command/nav.js';
import type { VerseAnchorRequest } from '../verse-ui-store.js';

export const ANCHOR_WAIT_MS = 3_000;

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/** The anchor's element on `section`'s surface, or null when it is not in the DOM (yet). */
export function findAnchorElement(section: string, anchor: string, root: ParentNode = document): HTMLElement | null {
  const host = root.querySelector<HTMLElement>(`[data-surface="${cssEscape(section)}"]`);
  if (!host) return null;
  return (
    host.querySelector<HTMLElement>(`#${cssEscape(anchorId(anchor))}`) ??
    host.querySelector<HTMLElement>(`[data-verse-anchor="${cssEscape(anchor)}"]`)
  );
}

function reveal(el: HTMLElement): void {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Keyboard users land ON the card, not just near it. Only an element that
  // can already take focus is focused — the shell never rewrites another
  // unit's tab order to make a div focusable.
  if (el.tabIndex >= 0 || el.matches('a[href],button,input,select,textarea,[tabindex]')) {
    el.focus({ preventScroll: true });
  }
}

/**
 * Reveal `anchor` on `section`. Resolves true when it was found and scrolled
 * to, false when it did not appear within `waitMs`. Never throws.
 */
export function revealAnchor({ section, anchor }: VerseAnchorRequest, waitMs: number = ANCHOR_WAIT_MS): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  const now = findAnchorElement(section, anchor);
  if (now && !now.closest('[hidden]')) {
    reveal(now);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (el: HTMLElement | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      if (el) reveal(el);
      resolve(el !== null);
    };
    const check = () => {
      const el = findAnchorElement(section, anchor);
      // Wait for the surface to be un-hidden too: scrolling a hidden element is a no-op.
      if (el && !el.closest('[hidden]')) finish(el);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'id', 'data-verse-anchor'] });
    const timer = window.setTimeout(() => finish(null), waitMs);
    check();
  });
}

/** The shell's one listener. Returns the unsubscribe. */
export function subscribeAnchorRequests(eventName: string): () => void {
  if (typeof window === 'undefined') return () => {};
  function onAnchor(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'object' || detail === null) return;
    const { section, anchor } = detail as Record<string, unknown>;
    if (typeof section !== 'string' || typeof anchor !== 'string' || anchor.length === 0 || anchor.length > 200) return;
    void revealAnchor({ section: section as VerseAnchorRequest['section'], anchor });
  }
  window.addEventListener(eventName, onAnchor);
  return () => window.removeEventListener(eventName, onAnchor);
}

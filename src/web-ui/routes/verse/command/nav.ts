/**
 * routes/verse/command/nav.ts — how a surface card asks the shell to go
 * somewhere (unit C7). The shell (C1) owns navigation state; these are thin
 * wrappers over its store so every card words navigation the same way:
 *
 *   openNeedsYou()        ⌘J's drawer, optionally focused on one item;
 *   goToSection(s, a)     switch surface (keep-alive: the target keeps its
 *                         state) and, when `anchor` names a card or row on
 *                         it, scroll that into view once it is on screen;
 *   openChat(sessionId)   the chat a Needs-you item or insight is about.
 */
import type { WorkbenchSectionId } from '../../../../core/verse/workbench-types.js';
import { openVerseNeedsYou, openVerseSession, setVerseSection } from '../verse-ui-store.js';

export function openNeedsYou(focusId: string | null = null): void {
  openVerseNeedsYou(focusId ? { focusId } : {});
}

/** DOM id for an anchor ("repo-ashlrai/binshield" → "c7-anchor-repo-ashlrai-binshield"). */
export function anchorId(anchor: string): string {
  return `c7-anchor-${anchor.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

export function scrollToAnchor(anchor: string): void {
  const el = document.getElementById(anchorId(anchor));
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function goToSection(section: WorkbenchSectionId, anchor: string | null = null): void {
  setVerseSection(section);
  if (!anchor) return;
  // The target surface may be mounting (lazy chunk) or un-hiding (keep-alive):
  // try on the next two frames, then give up quietly — a missing anchor is
  // never an error, the operator is already on the right surface.
  requestAnimationFrame(() => {
    if (document.getElementById(anchorId(anchor))) scrollToAnchor(anchor);
    else requestAnimationFrame(() => scrollToAnchor(anchor));
  });
}

export function openChat(sessionId: string): void {
  openVerseSession(sessionId);
}

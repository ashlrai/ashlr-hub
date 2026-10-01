import { useLayoutEffect } from 'react';
import { ActionMenu, anchorBelow, type ActionMenuItem } from '../chat/ActionMenu.js';
import { getVerseUiState, setVerseSection, setVerseSidebarCollapsed } from '../verse-ui-store.js';
import { executeCatalogCommand } from './run-command.js';
import { workModeForSection, type WorkMode } from './work-mode.js';

/** Shared tools retain the last visited job; choosing Review never activates it. */
export function currentReviewMode(): WorkMode {
  const ui = getVerseUiState();
  const current = workModeForSection(ui.section);
  if (current) return current;
  for (let i = ui.history.index; i >= 0; i--) {
    const section = ui.history.entries[i]?.section;
    const mode = section ? workModeForSection(section) : null;
    if (mode) return mode;
  }
  return 'with-me';
}

export function ReviewMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  // The floating chat list otherwise covers the menu at the sidebar's CSS
  // breakpoint. Collapse only that overlay before paint; keep desktop layout.
  useLayoutEffect(() => {
    if (window.matchMedia?.('(max-width: 760px)')?.matches === true) setVerseSidebarCollapsed(true);
  }, []);
  const mode = currentReviewMode();
  const chatOpen = getVerseUiState().activeSessionId !== null;
  const command = (id: string) => () => { executeCatalogCommand(id, { via: 'menu' }); };
  const items: ActionMenuItem[] = mode === 'with-me' ? [
    { id: 'changes', label: 'Chat changes', onSelect: command('dock.diff'), disabled: !chatOpen, reason: 'Open a chat to review its changes.' },
    { id: 'sources', label: 'Chat sources', onSelect: command('dock.sources'), disabled: !chatOpen, reason: 'Open a chat to review its sources.' },
    { id: 'usage', label: 'Usage', onSelect: command('section.usage') },
  ] : [
    { id: 'agents', label: 'Review agents', onSelect: command('surface.agents') },
    { id: 'needs-you', label: 'Needs you', onSelect: command('needs-you.open') },
    { id: 'decisions', label: 'Fleet decisions', description: 'Recorded decisions when available; otherwise view Fleet status.',
      onSelect: () => setVerseSection('fleet', 'shadow-decisions') },
  ];
  items.push({ id: 'wiki', label: 'Module map', separated: true, onSelect: command('section.wiki') });
  return <ActionMenu label="Review work" items={items} anchor={anchorBelow(anchor)} returnFocus={anchor} onClose={onClose} />;
}

// Direct lazy loading avoids an eager named-export adapter in the shell.
export default ReviewMenu;

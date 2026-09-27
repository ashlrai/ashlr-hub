/**
 * routes/verse/changes/register.ts — the Changes pane's registration for the
 * workbench pane registry (routes/verse/panes/README.md, "a self-describing
 * register.ts"). panes/index.ts discovers this file; register-adapter.ts maps
 * the id `changes` onto the first-party `diff` pane and REPLACES it, keeping
 * its key (⇧⌘D), order, icon and header toggle.
 *
 * Import-free apart from a LAZY import, so listing the pane costs nothing on
 * first paint: ChangesPaneHost and everything behind it (the checkpoint
 * client, the diff grid, the git dialogs) is its own chunk, loaded when the
 * pane opens.
 */
import type { ComponentType } from 'react';
import type { PaneProps } from '../panes/pane-registry.js';

export const CHANGES_PANE: {
  id: string;
  label: string;
  commandId: string;
  keywords: readonly string[];
  defaultSlot: 'dock';
  chatScoped: boolean;
  description: string;
  load: () => Promise<{ default: ComponentType<PaneProps> }>;
} = {
  id: 'changes',
  label: 'Changes',
  commandId: 'dock.diff',
  keywords: ['changes', 'diff', 'review', 'checkpoint', 'undo', 'rewind', 'revert', 'git'],
  defaultSlot: 'dock',
  chatScoped: true,
  description: 'What each turn changed, reviewed hunk by hunk, with Undo turn — plus the uncommitted and branch diff.',
  load: () => import('./ChangesPaneHost.js').then((m) => ({ default: m.ChangesPaneHost })),
};

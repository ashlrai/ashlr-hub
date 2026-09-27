/**
 * routes/verse/reasoning/pane-adapter.ts — the Sources and Reasoning panes,
 * described for the workbench shell's pane registry (V3.15).
 *
 * The registry (layout owner, routes/verse/panes/**) had not landed when these
 * panes were built, so they ship self-contained: each is a lazy component
 * that needs nothing but `{sessionId}` and talks to the transcript only
 * through its jump bus. Registering them is one spread of this list; until
 * then the transcript hosts both in its own sheet (ReasoningSheet.tsx).
 *
 * Pure data + lazy importers: importing this module loads neither pane.
 */
import type { ComponentType } from 'react';

export interface ReasoningPaneProps {
  sessionId: string;
}

export interface ReasoningPaneDescriptor {
  id: 'sources' | 'reasoning';
  label: string;
  /** One line for a pane picker / palette entry. */
  description: string;
  load: () => Promise<{ default: ComponentType<ReasoningPaneProps> }>;
}

export const REASONING_PANES: readonly ReasoningPaneDescriptor[] = [
  {
    id: 'sources',
    label: 'Sources',
    description: 'Every file, page, search and doc this chat drew on',
    load: () => import('./SourcesPanel.js').then((m) => ({ default: m.SourcesPane })),
  },
  {
    id: 'reasoning',
    label: 'Reasoning',
    description: 'The chat’s reasoning, turn by turn',
    load: () => import('./ReasoningPanel.js').then((m) => ({ default: m.ReasoningPane })),
  },
];

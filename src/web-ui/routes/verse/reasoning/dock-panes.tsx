/**
 * routes/verse/reasoning/dock-panes.tsx — the Sources and Reasoning panels as
 * registry panes (reasoning.pane.tsx registers them).
 *
 * Adapters only: the panels are presentational over derived turns
 * (SourcesPanel / ReasoningPanel); this is where the dock's PaneProps meet
 * them. A pane kept alive behind another tab (`visible: false`) stops
 * following the stream and keeps what it last showed, so a hidden pane costs
 * nothing per token.
 */
import { useCallback } from 'react';
import type { PaneProps } from '../panes/pane-registry.js';
import { useChatTurns, usePaneActions } from './pane-data.js';
import { ReasoningPanel } from './ReasoningPanel.js';
import { SourcesPanel } from './SourcesPanel.js';

export function SourcesDockPane({ sessionId, session, visible, host }: PaneProps) {
  const turns = useChatTurns(sessionId, visible);
  const actions = usePaneActions(sessionId);
  const addToMessage = host.addToMessage;
  const onCite = useCallback((text: string) => addToMessage(text), [addToMessage]);
  return <SourcesPanel turns={turns} session={session} {...actions} onCite={onCite} />;
}

export function ReasoningDockPane({ sessionId, session, visible }: PaneProps) {
  const turns = useChatTurns(sessionId, visible);
  const { jumpToTurn } = usePaneActions(sessionId);
  return <ReasoningPanel turns={turns} engine={session?.engine ?? null} jumpToTurn={jumpToTurn} />;
}

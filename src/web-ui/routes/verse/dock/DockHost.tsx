/**
 * routes/verse/dock/DockHost.tsx — the dock with the open chat wired in
 * (unit C2; 3.16 workbench). The Chat section loads THIS lazily the first
 * time the dock opens: the dock starts closed, so none of it — the
 * container, the pane registry and every pane — belongs on the chat's
 * first-paint path (SPEC-310C budget: chat critical JS ≤ 350 KB).
 *
 * It turns the chat's data and actions into what every registered pane
 * receives (PaneProps: the chat, its folders and events, the host actions),
 * and provides the extra data the first-party Tasks and Context panes read.
 */
import { useMemo } from 'react';
import type { VerseEvent, VerseSeat, VerseSession, VerseSessionRootsResponse } from '../../../data/api-types.js';
import type { DockPresentation } from '../shell/dock-catalog.js';
import type { TurnFileChange } from '../shell/slots.js';
import type { ChatTask } from '../chat/tasks-model.js';
import { ChatPaneDataContext, type ChatPaneData } from '../panes/chat-pane-data.js';
import type { PaneHost } from '../panes/index.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { closeDockTab, openDockPane, requestDiff, requestTerminal, requestTerminalBelow } from './dock-store.js';

export interface DockHostProps {
  presentation: DockPresentation;
  windowWidth: number;
  columnWidth: number;
  /** The widest the column may be dragged (the transcript keeps its floor). */
  columnMax?: number;
  /** The chat column's height (the bottom panel's caps). */
  columnHeight?: number;
  session: VerseSession | null;
  seats: readonly VerseSeat[];
  events: readonly VerseEvent[];
  roots: readonly string[];
  rootsData: VerseSessionRootsResponse | null;
  rootsError: string | null;
  turnFiles: readonly TurnFileChange[];
  otherRunning: readonly ChatTask[];
  dispatchEnabled: boolean;
  onOpenSession: (sessionId: string) => void;
  onHandoff: (sessionId: string) => void;
  onOpenAccounts: () => void;
  onSendToChat: (text: string) => void;
  onAddToMessage: (text: string) => void;
}

export function DockHost(props: DockHostProps) {
  const { session, seats, events, roots, rootsData, rootsError, turnFiles, otherRunning, dispatchEnabled,
    onOpenSession, onHandoff, onOpenAccounts, onSendToChat, onAddToMessage } = props;

  const host = useMemo<PaneHost>(() => ({
    sendToChat: onSendToChat,
    addToMessage: onAddToMessage,
    openPane: openDockPane,
    closePane: closeDockTab,
    openTerminal: requestTerminal,
    openTerminalBelow: requestTerminalBelow,
    openDiff: requestDiff,
    openSession: onOpenSession,
  }), [onSendToChat, onAddToMessage, onOpenSession]);

  const pane = useMemo<DockPaneContext>(() => ({
    sessionId: session?.id ?? null,
    session,
    roots,
    events,
    turnFiles,
    host,
  }), [session, roots, events, turnFiles, host]);

  const data = useMemo<ChatPaneData>(() => ({
    seats, rootsData, rootsError, otherRunning, dispatchEnabled, onHandoff, onOpenAccounts,
  }), [seats, rootsData, rootsError, otherRunning, dispatchEnabled, onHandoff, onOpenAccounts]);

  return (
    <ChatPaneDataContext.Provider value={data}>
      <Dock presentation={props.presentation} windowWidth={props.windowWidth} columnWidth={props.columnWidth}
        columnMax={props.columnMax} columnHeight={props.columnHeight} pane={pane} />
    </ChatPaneDataContext.Provider>
  );
}

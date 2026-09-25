/**
 * routes/verse/dock/DockHost.tsx — the dock with the chat's own panes wired
 * in (unit C2). The Chat section loads THIS lazily the first time the dock
 * opens: the dock starts closed, so none of it — the container, the Tasks
 * and Context panes, the memory editor behind Context — belongs on the
 * chat's first-paint path (SPEC-310C budget: chat critical JS ≤ 350 KB).
 */
import { useMemo } from 'react';
import type { VerseEvent, VerseSeat, VerseSession, VerseSessionRootsResponse } from '../../../data/api-types.js';
import type { DockPresentation } from '../shell/dock-catalog.js';
import type { TurnFileChange } from '../shell/slots.js';
import { currentTurnTasks, type ChatTask } from '../chat/tasks-model.js';
import { useVerseTranscript } from '../useVerseTranscript.js';
import { ContextPane } from './ContextPane.js';
import { Dock } from './Dock.js';
import { TasksPane } from './TasksPane.js';

export interface DockHostProps {
  presentation: DockPresentation;
  windowWidth: number;
  columnWidth: number;
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
  const { session, seats, events, rootsData, rootsError, otherRunning, dispatchEnabled, onOpenSession, onHandoff, onOpenAccounts } = props;
  const handoffReason = !dispatchEnabled
    ? 'Sending is disabled on this server.'
    : session?.status === 'running' ? 'Available when the current turn finishes.' : null;
  return (
    <Dock presentation={props.presentation} windowWidth={props.windowWidth} columnWidth={props.columnWidth}
      sessionId={session?.id ?? null} roots={props.roots} turnFiles={props.turnFiles}
      onSendToChat={props.onSendToChat} onAddToMessage={props.onAddToMessage}
      renderTasks={() => <LiveTasksPane sessionId={session?.id ?? null} otherChats={otherRunning} onOpenSession={onOpenSession} />}
      renderContext={(visible) => (
        <ContextPane session={session} seats={seats} events={events} roots={rootsData} rootsError={rootsError} visible={visible}
          onHandoff={session ? () => onHandoff(session.id) : undefined} handoffDisabledReason={handoffReason}
          onOpenAccounts={onOpenAccounts} />
      )} />
  );
}

/** The Tasks pane, subscribed to the open chat's transcript on its own (a streamed token re-renders this, not the section). */
function LiveTasksPane({ sessionId, otherChats, onOpenSession }: { sessionId: string | null; otherChats: readonly ChatTask[]; onOpenSession: (id: string) => void }) {
  const transcript = useVerseTranscript(sessionId);
  const turnTasks = useMemo(() => currentTurnTasks(transcript.items), [transcript.items]);
  return <TasksPane turnTasks={turnTasks} otherChats={otherChats} hasSession={sessionId !== null} onOpenSession={onOpenSession} />;
}

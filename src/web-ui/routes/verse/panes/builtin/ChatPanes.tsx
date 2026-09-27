/**
 * routes/verse/panes/builtin/ChatPanes.tsx — the chat's own Tasks and
 * Context panes as registry panes. Lazy (with the memory editor behind
 * Context) — loaded the first time either tab opens.
 */
import { useMemo } from 'react';
import { currentTurnTasks } from '../../chat/tasks-model.js';
import { ContextPane } from '../../dock/ContextPane.js';
import { TasksPane } from '../../dock/TasksPane.js';
import { useVerseTranscript } from '../../useVerseTranscript.js';
import { useChatPaneData } from '../chat-pane-data.js';
import type { PaneProps } from '../pane-registry.js';

/** Subscribed to the open chat's transcript on its own: a streamed token re-renders this, not the dock. */
export function TasksPaneBody({ sessionId, host }: PaneProps) {
  const { otherRunning } = useChatPaneData();
  const transcript = useVerseTranscript(sessionId);
  const turnTasks = useMemo(() => currentTurnTasks(transcript.items), [transcript.items]);
  return <TasksPane turnTasks={turnTasks} otherChats={otherRunning} hasSession={sessionId !== null} onOpenSession={host.openSession} />;
}

export function ContextPaneBody({ session, events, visible }: PaneProps) {
  const { seats, rootsData, rootsError, dispatchEnabled, onHandoff, onOpenAccounts } = useChatPaneData();
  const handoffReason = !dispatchEnabled
    ? 'Sending is disabled on this server.'
    : session?.status === 'running' ? 'Available when the current turn finishes.' : null;
  return (
    <ContextPane session={session} seats={seats} events={events} roots={rootsData} rootsError={rootsError} visible={visible}
      onHandoff={session ? () => onHandoff(session.id) : undefined} handoffDisabledReason={handoffReason}
      onOpenAccounts={onOpenAccounts} />
  );
}

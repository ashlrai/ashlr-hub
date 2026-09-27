/**
 * routes/verse/panes/chat-pane-data.ts — the chat surface's extra data for
 * the FIRST-PARTY panes that need more than PaneProps (Tasks: other running
 * chats; Context: seats, roots detail, the handoff). DockHost provides it.
 *
 * Deliberately NOT part of the registry contract: PaneProps is what every
 * pane may rely on. A unit that needs something here should ask for it to be
 * added to PaneProps instead.
 */
import { createContext, useContext } from 'react';
import type { VerseSeat, VerseSessionRootsResponse } from '../../../data/api-types.js';
import type { ChatTask } from '../chat/tasks-model.js';

export interface ChatPaneData {
  seats: readonly VerseSeat[];
  rootsData: VerseSessionRootsResponse | null;
  rootsError: string | null;
  otherRunning: readonly ChatTask[];
  dispatchEnabled: boolean;
  onHandoff: (sessionId: string) => void;
  onOpenAccounts: () => void;
}

const EMPTY: ChatPaneData = {
  seats: [],
  rootsData: null,
  rootsError: null,
  otherRunning: [],
  dispatchEnabled: true,
  onHandoff: () => undefined,
  onOpenAccounts: () => undefined,
};

export const ChatPaneDataContext = createContext<ChatPaneData>(EMPTY);

export function useChatPaneData(): ChatPaneData {
  return useContext(ChatPaneDataContext);
}

/** Shared sizing stays synchronous; resize interactions load with their control. */
import { useSyncExternalStore } from 'react';
import { getChatPanelSizing, subscribeChatPanels, type ChatPanelSizing } from './chat-panel-sizing.js';

export function useChatPanelSizing(): ChatPanelSizing {
  return useSyncExternalStore(subscribeChatPanels, getChatPanelSizing, getChatPanelSizing);
}

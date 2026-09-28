/**
 * routes/verse/agent-tools/agent-tools-client.ts — the page's calls to the
 * agent-tools routes (core/verse/verse-mcp-api.ts). Same conventions as the
 * Browser pane's: writes pull the held mutation token and throw
 * `VerseMutationLockedError` when none is held; reads carry the read-client
 * proof. Injectable (`AgentToolsApi`) so components test on fakes.
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import {
  VERSE_MCP_ACTIVITY_PATH,
  VERSE_MCP_CONFIRM_PATH,
  VERSE_MCP_GRANT_PATH,
  VERSE_MCP_RESUME_PATH,
  VERSE_MCP_SHARE_PATH,
  VERSE_MCP_TABS_PATH,
  type VerseAgentTabInfo,
  type VerseAgentToolsActivity,
  type VerseAgentToolsGrantRequest,
  type VerseAgentToolsState,
  type VerseMcpConfirmAnswer,
} from '../../../../core/verse/verse-mcp-types.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export interface AgentToolsApi {
  state(sessionId: string, signal?: AbortSignal): Promise<VerseAgentToolsState>;
  setGrant(req: VerseAgentToolsGrantRequest): Promise<VerseAgentToolsState>;
  activity(sessionId: string, signal?: AbortSignal): Promise<VerseAgentToolsActivity>;
  confirm(sessionId: string, id: string, answer: VerseMcpConfirmAnswer): Promise<void>;
  share(sessionId: string, tabId: string, shared: boolean): Promise<VerseAgentToolsState>;
  resume(tabId: string): Promise<void>;
  tabs(signal?: AbortSignal): Promise<{ tabs: VerseAgentTabInfo[] }>;
}

const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

export const agentToolsApi: AgentToolsApi = {
  state: (sessionId, signal) => apiGet(`${VERSE_MCP_GRANT_PATH}?${q({ sessionId })}`, signal),
  setGrant: (req) => post(VERSE_MCP_GRANT_PATH, req),
  activity: (sessionId, signal) => apiGet(`${VERSE_MCP_ACTIVITY_PATH}?${q({ sessionId })}`, signal),
  confirm: async (sessionId, id, answer) => { await post(VERSE_MCP_CONFIRM_PATH, { sessionId, id, answer }); },
  share: (sessionId, tabId, shared) => post(VERSE_MCP_SHARE_PATH, { sessionId, tabId, shared }),
  resume: async (tabId) => { await post(VERSE_MCP_RESUME_PATH, { tabId }); },
  tabs: (signal) => apiGet(VERSE_MCP_TABS_PATH, signal),
};

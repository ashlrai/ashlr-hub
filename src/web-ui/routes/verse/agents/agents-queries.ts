/**
 * routes/verse/agents/agents-queries.ts — reads and writes behind the Agents
 * board (core/verse/agents-api.ts), and the one-action "spawn" that makes an
 * agent: workspace → chat → bind (+ the first prompt).
 *
 * The chat itself is created through the ORDINARY session route
 * (createVerseSession), so a new agent passes the same seat readiness, model
 * and local-only gates as a hand-made chat. Reads spend nothing; writes pull
 * the held mutation token, touch the hold, and invalidate the board.
 */
import type {
  AgentBoardResponse,
  AgentChecksDetail,
  AgentRecord,
  AgentScriptLog,
  AgentWorkspaceCreateResponse,
  ScriptRunRecord,
  WorkspaceConfigRead,
} from '../../../../core/verse/agents/types.js';
import { VERSE_AGENTS_PATH } from '../../../../core/verse/agents/types.js';
import type { VerseGitPr } from '../../../../core/verse/workbench-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { createVerseSession, invalidateVerseLists, VerseMutationLockedError, VERSE_ACTIVITY_KEY } from '../verse-queries.js';

export const AGENTS_KEY = 'verse-agents';
/** The board polls while visible; cards also move on the activity poll's completions. */
export const AGENTS_POLL_MS = 5_000;

export const agentsBoardQuery: QueryDef<AgentBoardResponse> = {
  key: AGENTS_KEY,
  fetch: (signal) => apiGet<AgentBoardResponse>(VERSE_AGENTS_PATH, signal),
};

function token(): string {
  const t = getMutationToken();
  if (!t) throw new VerseMutationLockedError();
  return t;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await apiPost<T>(path, body, token());
  touchMutationHold();
  invalidate(AGENTS_KEY);
  invalidate(VERSE_ACTIVITY_KEY);
  return res;
}

const at = (id: string, verb: string): string => `${VERSE_AGENTS_PATH}/${encodeURIComponent(id)}/${verb}`;

export function fetchWorkspaceConfig(root: string, signal?: AbortSignal): Promise<WorkspaceConfigRead> {
  return apiGet<WorkspaceConfigRead>(`${VERSE_AGENTS_PATH}/config?root=${encodeURIComponent(root)}`, signal);
}

export function fetchAgentChecks(cardId: string, fresh: boolean, signal?: AbortSignal): Promise<AgentChecksDetail> {
  return apiGet<AgentChecksDetail>(`${at(cardId, 'checks')}${fresh ? '?fresh=1' : ''}`, signal);
}

export function fetchScriptLog(agentId: string, runId: string, signal?: AbortSignal): Promise<AgentScriptLog> {
  return apiGet<AgentScriptLog>(`${VERSE_AGENTS_PATH}/${encodeURIComponent(agentId)}/scripts/${encodeURIComponent(runId)}/log`, signal);
}

export const updateAgentSettings = (id: string, patch: { autoFix?: boolean; autoMerge?: boolean; spendCapUsd?: number | null; pinned?: boolean; title?: string }) =>
  post<{ agent: AgentRecord }>(at(id, 'settings'), patch).then((r) => r.agent);

export const decideAgentPlan = (id: string, action: 'approve' | 'discard', text?: string) =>
  post<{ agent: AgentRecord }>(at(id, 'plan'), text === undefined ? { action } : { action, text }).then((r) => r.agent);

export const sendHeldPrompt = (id: string) => post<{ agent: AgentRecord }>(at(id, 'send-prompt'), {}).then((r) => r.agent);

export const runAgentScript = (id: string, kind: 'setup' | 'run', index?: number) =>
  post<{ agent: AgentRecord; run: ScriptRunRecord }>(at(id, 'scripts'), index === undefined ? { kind } : { kind, index });

export const stopAgentScript = (id: string, runId: string) =>
  post<{ agent: AgentRecord }>(`${VERSE_AGENTS_PATH}/${encodeURIComponent(id)}/scripts/${encodeURIComponent(runId)}/stop`, {});

export const openAgentPr = (id: string, input: { title?: string; body?: string; draft?: boolean } = {}) =>
  post<{ agent: AgentRecord; pr: VerseGitPr }>(at(id, 'pr'), input);

export const archiveAgentCard = (id: string) => post<{ agent: AgentRecord }>(at(id, 'archive'), {}).then((r) => r.agent);
export const restoreAgentCard = (id: string) => post<{ agent: AgentRecord }>(at(id, 'restore'), {}).then((r) => r.agent);
/** Takes a failed turn out of Needs you. Works for `chat:<id>` cards too. */
export const resolveAgentCard = (cardId: string) => post<unknown>(at(cardId, 'resolve'), {});

export type BulkAction = 'read' | 'stop' | 'archive' | 'pin' | 'unpin';
export interface BulkResult {
  id: string;
  ok: boolean;
  skipped?: string;
  error?: string;
}

export async function bulkAgents(action: BulkAction, ids: readonly string[]): Promise<BulkResult[]> {
  const res = await post<{ results: BulkResult[] }>(`${VERSE_AGENTS_PATH}/bulk`, { action, ids });
  // "read" and "archive" move chats in the sidebar too.
  invalidateVerseLists();
  return res.results;
}

// ---------------------------------------------------------------------------
// Spawn — the one action behind ⌘N / ⇧⌘N on the board
// ---------------------------------------------------------------------------

export interface SpawnInput {
  root: string;
  seatId: string;
  model: string;
  title: string;
  prompt: string;
  /** Own git worktree on `verse/<slug>` (default). Off: the agent works in `root` itself. */
  isolate: boolean;
  planFirst: boolean;
  spendCapUsd: number | null;
  autoFix: boolean;
  autoMerge: boolean;
}

export interface SpawnResult {
  agent: AgentRecord;
  sessionId: string;
  held: boolean;
  config: WorkspaceConfigRead | null;
  archivedForCap: string[];
}

/**
 * Make one agent. A workspace whose chat could not be created is discarded
 * again (nothing is left behind); a chat that was created but could not be
 * bound keeps the chat (it is a normal chat) and reports the error.
 */
export async function spawnAgent(input: SpawnInput): Promise<SpawnResult> {
  const options = {
    planFirst: input.planFirst,
    spendCapUsd: input.spendCapUsd,
    autoFix: input.autoFix,
    autoMerge: input.autoMerge,
  };
  if (input.isolate) {
    const made = await post<AgentWorkspaceCreateResponse>(`${VERSE_AGENTS_PATH}/workspaces`, { root: input.root, title: input.title, ...options });
    const path = made.agent.workspace?.path;
    if (!path) throw new Error('The workspace was not created.');
    let sessionId: string;
    try {
      const session = await createVerseSession({ projectPath: path, seatId: input.seatId, model: input.model, title: input.title });
      sessionId = session.id;
    } catch (err) {
      await post(at(made.agent.id, 'discard'), {}).catch(() => undefined);
      throw err;
    }
    const bound = await post<{ agent: AgentRecord; held: boolean }>(at(made.agent.id, 'bind'), { sessionId, ...(input.prompt.trim() ? { prompt: input.prompt } : {}) });
    invalidateVerseLists();
    return { agent: bound.agent, sessionId, held: bound.held, config: made.config, archivedForCap: made.archivedForCap };
  }
  const session = await createVerseSession({ projectPath: input.root, seatId: input.seatId, model: input.model, title: input.title });
  const adopted = await post<{ agent: AgentRecord }>(`${VERSE_AGENTS_PATH}/chat`, { sessionId: session.id, title: input.title, ...options });
  const bound = await post<{ agent: AgentRecord; held: boolean }>(at(adopted.agent.id, 'bind'), { sessionId: session.id, ...(input.prompt.trim() ? { prompt: input.prompt } : {}) });
  invalidateVerseLists();
  return { agent: bound.agent, sessionId: session.id, held: bound.held, config: null, archivedForCap: [] };
}

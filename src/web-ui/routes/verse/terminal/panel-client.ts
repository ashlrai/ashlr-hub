/**
 * terminal/panel-client.ts — the Terminal panel's HTTP calls (3.15): the
 * 3.10 tab calls (list, create, input, resize, kill, open-external — reused
 * from the dock's client) plus blocks, block output, redaction and file links,
 * and — for the input editor — history, settings, plain-language assist and
 * path candidates from the composer's file index.
 *
 * REUSE. `panelTerminalApi.history` / `.assist` are the hooks other units
 * (block menus, "Ask any seat", workflows) call; both are server-scrubbed.
 */
import type {
  VerseTerminalAssistRequest,
  VerseTerminalAssistResponse,
  VerseTerminalBlockOutputFormat,
  VerseTerminalBlockOutputResponse,
  VerseTerminalBlocksResponse,
  VerseTerminalCreateRequest,
  VerseTerminalHistoryResponse,
  VerseTerminalFixResponse,
  VerseTerminalLaunchListResponse,
  VerseTerminalLaunchRequest,
  VerseTerminalLaunchResponse,
  VerseTerminalOpenFileRequest,
  VerseTerminalSettings,
  VerseTerminalTab,
} from '../../../data/api-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import {
  VERSE_TERMINAL_ASSIST_PATH,
  VERSE_TERMINAL_HISTORY_CLEAR_PATH,
  VERSE_TERMINAL_HISTORY_PATH,
  VERSE_TERMINAL_LAUNCH_PATH,
  VERSE_TERMINAL_PATH,
  VERSE_TERMINAL_REDACT_PATH,
  VERSE_TERMINAL_SETTINGS_PATH,
} from '../../../../core/verse/workbench-types.js';
import { searchSessionFiles } from '../composer/composer-queries.js';
import { TerminalLockedError, terminalApi, type TerminalApi } from '../dock/terminal/terminal-client.js';

export interface TerminalHistoryQuery {
  q?: string;
  cwd?: string | null;
  limit?: number;
}

export interface PanelTerminalApi extends TerminalApi {
  create(req: VerseTerminalCreateRequest): Promise<VerseTerminalTab>;
  blocks(tabId: string): Promise<VerseTerminalBlocksResponse>;
  blockOutput(tabId: string, blockId: string, format: VerseTerminalBlockOutputFormat): Promise<VerseTerminalBlockOutputResponse>;
  /** Text → the same secret scrub a block gets on its way to a chat. */
  redact(text: string): Promise<string>;
  openFile(tabId: string, req: VerseTerminalOpenFileRequest): Promise<void>;
  /** 3.15: ranked command history (optional so older fakes still type-check; the panel treats absent as empty). */
  history?(query: TerminalHistoryQuery, signal?: AbortSignal): Promise<VerseTerminalHistoryResponse>;
  clearHistory?(): Promise<void>;
  settings?(): Promise<VerseTerminalSettings>;
  updateSettings?(patch: Partial<VerseTerminalSettings>): Promise<VerseTerminalSettings>;
  /** Plain words → a command, as TEXT. Never typed, never run. */
  assist?(req: VerseTerminalAssistRequest): Promise<VerseTerminalAssistResponse>;
  /** Files in the chat's folders matching `query` (the composer's `@` index). */
  files?(sessionId: string, query: string, signal?: AbortSignal): Promise<Array<{ path: string; root: string }>>;
  /** 3.15: the local model's candidate commands for a failed block (optional: older fakes). */
  fix?(tabId: string, blockId: string): Promise<VerseTerminalFixResponse>;
  /** 3.15: the chat's launch configurations. */
  launchList?(sessionId: string): Promise<VerseTerminalLaunchListResponse>;
  /** 3.15: open a launch configuration's tabs (its commands come from the file on the server). */
  launch?(req: VerseTerminalLaunchRequest): Promise<VerseTerminalLaunchResponse>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new TerminalLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

const tabBase = (id: string) => `${VERSE_TERMINAL_PATH}/${encodeURIComponent(id)}`;

export function historyPath(query: TerminalHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.cwd) params.set('cwd', query.cwd);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return qs ? `${VERSE_TERMINAL_HISTORY_PATH}?${qs}` : VERSE_TERMINAL_HISTORY_PATH;
}

export const panelTerminalApi: PanelTerminalApi = {
  ...terminalApi,
  blocks: (tabId) => apiGet<VerseTerminalBlocksResponse>(`${tabBase(tabId)}/blocks`),
  blockOutput: (tabId, blockId, format) =>
    apiGet<VerseTerminalBlockOutputResponse>(`${tabBase(tabId)}/blocks/${encodeURIComponent(blockId)}?format=${format}`),
  redact: async (text) => (await post<{ text: string }>(VERSE_TERMINAL_REDACT_PATH, { text })).text,
  openFile: async (tabId, req) => { await post<unknown>(`${tabBase(tabId)}/open-file`, req); },
  history: (query, signal) => apiGet<VerseTerminalHistoryResponse>(historyPath(query), signal),
  clearHistory: async () => { await post<unknown>(VERSE_TERMINAL_HISTORY_CLEAR_PATH, {}); },
  settings: () => apiGet<VerseTerminalSettings>(VERSE_TERMINAL_SETTINGS_PATH),
  updateSettings: (patch) => post<VerseTerminalSettings>(VERSE_TERMINAL_SETTINGS_PATH, patch),
  assist: (req) => post<VerseTerminalAssistResponse>(VERSE_TERMINAL_ASSIST_PATH, req),
  files: async (sessionId, query, signal) => (await searchSessionFiles(sessionId, query, signal)).files,
  fix: (tabId, blockId) => post<VerseTerminalFixResponse>(`${tabBase(tabId)}/blocks/${encodeURIComponent(blockId)}/fix`, {}),
  launchList: (sessionId) => apiGet<VerseTerminalLaunchListResponse>(`${VERSE_TERMINAL_LAUNCH_PATH}?sessionId=${encodeURIComponent(sessionId)}`),
  launch: (req) => post<VerseTerminalLaunchResponse>(VERSE_TERMINAL_LAUNCH_PATH, req),
};

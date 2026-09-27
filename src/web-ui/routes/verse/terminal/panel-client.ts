/**
 * terminal/panel-client.ts — the Terminal panel's HTTP calls (3.15): the
 * 3.10 tab calls (list, create, input, resize, kill, open-external — reused
 * from the dock's client) plus blocks, block output, redaction and file links.
 */
import type {
  VerseTerminalBlockOutputFormat,
  VerseTerminalBlockOutputResponse,
  VerseTerminalBlocksResponse,
  VerseTerminalCreateRequest,
  VerseTerminalOpenFileRequest,
  VerseTerminalTab,
} from '../../../data/api-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { VERSE_TERMINAL_PATH, VERSE_TERMINAL_REDACT_PATH } from '../../../../core/verse/workbench-types.js';
import { TerminalLockedError, terminalApi, type TerminalApi } from '../dock/terminal/terminal-client.js';

export interface PanelTerminalApi extends TerminalApi {
  create(req: VerseTerminalCreateRequest): Promise<VerseTerminalTab>;
  blocks(tabId: string): Promise<VerseTerminalBlocksResponse>;
  blockOutput(tabId: string, blockId: string, format: VerseTerminalBlockOutputFormat): Promise<VerseTerminalBlockOutputResponse>;
  /** Text → the same secret scrub a block gets on its way to a chat. */
  redact(text: string): Promise<string>;
  openFile(tabId: string, req: VerseTerminalOpenFileRequest): Promise<void>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new TerminalLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

const tabBase = (id: string) => `${VERSE_TERMINAL_PATH}/${encodeURIComponent(id)}`;

export const panelTerminalApi: PanelTerminalApi = {
  ...terminalApi,
  blocks: (tabId) => apiGet<VerseTerminalBlocksResponse>(`${tabBase(tabId)}/blocks`),
  blockOutput: (tabId, blockId, format) =>
    apiGet<VerseTerminalBlockOutputResponse>(`${tabBase(tabId)}/blocks/${encodeURIComponent(blockId)}?format=${format}`),
  redact: async (text) => (await post<{ text: string }>(VERSE_TERMINAL_REDACT_PATH, { text })).text,
  openFile: async (tabId, req) => { await post<unknown>(`${tabBase(tabId)}/open-file`, req); },
};

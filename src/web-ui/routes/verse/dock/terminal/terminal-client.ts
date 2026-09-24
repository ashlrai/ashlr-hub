/**
 * dock/terminal/terminal-client.ts — the Terminal pane's HTTP calls (unit C4).
 *
 * Writes carry the held mutation token (auth-store), exactly like
 * verse-queries' writes; the stream is read with fetch() + the read-client
 * header rather than EventSource (see terminal-stream.ts for why).
 */
import type {
  VerseTerminalCreateRequest,
  VerseTerminalListResponse,
  VerseTerminalTab,
} from '../../../../data/api-types.js';
import { getMutationToken, touchMutationHold } from '../../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../../data/client.js';
import { VERSE_TERMINAL_PATH } from '../../../../../core/verse/workbench-types.js';

/** Raised when a write is attempted with no mutation token held. */
export class TerminalLockedError extends Error {
  constructor() {
    super('Unlock actions with the mutation token to use the terminal.');
    this.name = 'TerminalLockedError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new TerminalLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

function tabPath(id: string, action: 'input' | 'resize' | 'kill' | 'stream'): string {
  return `${VERSE_TERMINAL_PATH}/${encodeURIComponent(id)}/${action}`;
}

export interface TerminalApi {
  list(signal?: AbortSignal): Promise<VerseTerminalListResponse>;
  create(req: VerseTerminalCreateRequest): Promise<VerseTerminalTab>;
  input(id: string, dataBase64: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  openExternal(sessionId: string, root?: string): Promise<void>;
}

export const terminalApi: TerminalApi = {
  list: (signal) => apiGet<VerseTerminalListResponse>(VERSE_TERMINAL_PATH, signal),
  create: async (req) => (await post<{ tab: VerseTerminalTab }>(VERSE_TERMINAL_PATH, req)).tab,
  input: (id, dataBase64) => post<void>(tabPath(id, 'input'), { dataBase64 }),
  resize: (id, cols, rows) => post<void>(tabPath(id, 'resize'), { cols, rows }),
  kill: async (id) => { await post<unknown>(tabPath(id, 'kill'), {}); },
  openExternal: async (sessionId, root) => {
    await post<unknown>(`${VERSE_TERMINAL_PATH}/open-external`, root === undefined ? { sessionId } : { sessionId, root });
  },
};

export function terminalStreamPath(id: string, after: number): string {
  const cursor = Number.isSafeInteger(after) && after > 0 ? `?after=${after}` : '';
  return `${tabPath(id, 'stream')}${cursor}`;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/** Standard base64 of bytes (btoa over a binary string, chunked to stay off the arg-count limit). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The fence for "Send selection to chat": one backtick longer than the
 * longest run inside the text (at least three), so a selection that itself
 * contains a fenced block cannot close ours early.
 */
export function fenceSelection(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  const longest = Math.max(0, ...Array.from(trimmed.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${trimmed}\n${fence}`;
}

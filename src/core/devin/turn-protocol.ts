/**
 * The Devin chat turn's stdout protocol (3.15).
 *
 * A Verse turn on a Devin seat is one run of Verse's OWN turn process
 * (chat-turn-process.ts), not a vendor CLI: it drives either the Devin v3 API
 * (cloud lane, chat-runner.ts) or the local `devin acp` server (CLI lane,
 * acp-bridge.ts), and prints ONE JSON object per line describing what
 * happened, in Verse's own event vocabulary. The adapter
 * (verse/adapters/devin.ts) re-validates every line against this closed set
 * before the engine stamps it — the process is ours, but its output is still
 * treated as untrusted input to the durable log.
 *
 * Nothing here is ever a secret: the key is read by the turn process from the
 * Keychain and never printed; messages are scrubbed before they are printed.
 */
import type { VerseRemoteState } from '../verse/types.js';

export type DevinTurnLine =
  /** The conversation this turn is bound to (cloud: the Devin task id `dv_…`; CLI: the ACP session id). */
  | { type: 'native-session'; id: string }
  | { type: 'assistant-message'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking-delta'; text: string }
  /** Passive ACP context occupancy, not billed token usage or remaining quota. */
  | { type: 'context'; contextTokens: number; contextWindow: number }
  | { type: 'tool-use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool-result'; toolUseId: string; output: string; isError: boolean }
  | { type: 'progress'; phase: 'thinking' | 'tool' | 'writing' | 'waiting'; elapsedMs: number; tool?: string }
  | {
    type: 'remote-status';
    state: VerseRemoteState;
    message: string;
    url: string | null;
    acusConsumed: number | null;
    acuCap: number | null;
  }
  | { type: 'remote-pr'; url: string; state: string | null }
  | { type: 'error'; message: string; code?: string };

/** Everything the turn process needs, sent on its stdin as one JSON object (never argv: the text can be long and private). */
export interface DevinTurnPayload {
  v: 1;
  lane: 'cloud' | 'cli';
  /** The Verse chat id — recorded on the Devin task so Needs-you and the chat agree. */
  verseSessionId: string;
  /** The chat's native id so far: the task id (cloud) or ACP session id (CLI); null on the first turn. */
  nativeId: string | null;
  projectPath: string;
  text: string;
  permissionMode: 'plan' | 'accept-edits' | 'auto' | 'bypass';
  /** CLI lane: the `devin` binary discovery resolved; null on the cloud lane. */
  cliPath: string | null;
  /** CLI lane: the model the chat runs (`--model`); null = the CLI's default. */
  model: string | null;
  /**
   * 3.15 agent tools, CLI lane only, absent when the chat has none on: this
   * turn's route to Verse's MCP server (verse-mcp-launch.ts). The token is
   * the one secret this payload may carry — stdin never shows in `ps`. The
   * bridge offers the server to Devin (http, else the stdio bridge with the
   * token FILE) and, with the terminal scope, serves Devin's terminal/*
   * requests in a visible Verse tab.
   */
  verseMcp?: DevinTurnVerseMcp | null;
}

export interface DevinTurnVerseMcp {
  url: string;
  token: string;
  tokenFile: string;
  /** argv of `ashlr verse-mcp-stdio` for this runtime. */
  stdio: string[];
  scopes: string[];
}

function parseVerseMcp(raw: unknown): DevinTurnVerseMcp | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const { url, token, tokenFile, stdio, scopes } = raw;
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/api\/verse\/agent-tools\/mcp$/.test(url)) return undefined;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  if (typeof tokenFile !== 'string' || !tokenFile.startsWith('/') || tokenFile.length > 4096) return undefined;
  if (!Array.isArray(stdio) || stdio.length === 0 || stdio.length > 8 || !stdio.every((a) => typeof a === 'string' && a.length <= 8192)) return undefined;
  if (!Array.isArray(scopes) || scopes.length > 8 || !scopes.every((s) => typeof s === 'string' && /^[a-z_]{1,30}$/.test(s))) return undefined;
  return { url, token, tokenFile, stdio: stdio as string[], scopes: scopes as string[] };
}

export const DEVIN_TURN_PAYLOAD_MAX_BYTES = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate a stdin payload; null when anything is off (the process then exits 2 without doing anything). */
export function parseDevinTurnPayload(raw: unknown): DevinTurnPayload | null {
  if (!isRecord(raw) || raw['v'] !== 1) return null;
  const lane = raw['lane'];
  if (lane !== 'cloud' && lane !== 'cli') return null;
  const str = (key: string, max: number): string | null => {
    const value = raw[key];
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
  };
  const verseSessionId = str('verseSessionId', 80);
  const projectPath = str('projectPath', 4096);
  const text = str('text', DEVIN_TURN_PAYLOAD_MAX_BYTES);
  if (!verseSessionId || !/^[A-Za-z0-9-]+$/.test(verseSessionId) || !projectPath || !text) return null;
  const nativeRaw = raw['nativeId'];
  if (nativeRaw !== null && (typeof nativeRaw !== 'string' || nativeRaw.length === 0 || nativeRaw.length > 200)) return null;
  const mode = raw['permissionMode'];
  if (mode !== 'plan' && mode !== 'accept-edits' && mode !== 'auto' && mode !== 'bypass') return null;
  const cliPath = raw['cliPath'];
  if (cliPath !== null && (typeof cliPath !== 'string' || !cliPath.startsWith('/') || cliPath.length > 4096)) return null;
  if (lane === 'cli' && cliPath === null) return null;
  const model = raw['model'];
  if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(model))) return null;
  const verseMcp = parseVerseMcp(raw['verseMcp']);
  if (verseMcp === undefined) return null;
  return {
    v: 1,
    lane,
    verseSessionId,
    nativeId: nativeRaw as string | null,
    projectPath,
    text,
    permissionMode: mode,
    cliPath: cliPath as string | null,
    model: model as string | null,
    ...(verseMcp && lane === 'cli' ? { verseMcp } : {}),
  };
}

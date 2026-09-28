/**
 * core/verse/verse-mcp-stdio.ts — `ashlr verse-mcp-stdio`: a stdio MCP server
 * that relays, line for line, to Verse's MCP endpoint (verse-mcp.ts) for the
 * seats that only speak stdio or cannot carry a bearer header through their
 * launcher (Codex, Grok, a Devin CLI without HTTP MCP).
 *
 * THE CREDENTIAL never travels in argv (argv shows in `ps`). The bridge finds
 * its turn's `{ url, token }` one of two ways:
 *   1. `ASHLR_VERSE_MCP_TOKEN_FILE` — the path of the turn's 0600 token file
 *      (Codex puts it in the server's `env` via `-c`; Devin's ACP stdio entry
 *      carries it the same way);
 *   2. `ASHLR_VERSE_MCP_RESOLVE=parent` (Grok, whose MCP config is one
 *      persistent file per account): the parent process IS the seat's turn
 *      process (grok spawns stdio servers as direct children; the native
 *      launcher execs grok in place, so its pid is the one the engine
 *      registered), so `running.json` (process-registry.ts) names the chat,
 *      and the chat's token file is `<ASHLR_VERSE_MCP_DIR>/<chat>.token.json`.
 * The URL must be loopback `/api/verse/agent-tools/mcp`: a token is never sent anywhere
 * else, whatever the file says.
 *
 * NO CREDENTIAL (tools off for the chat, turn over) is not an error the seat
 * should trip on at startup: the bridge still answers `initialize`, lists no
 * tools, and answers any call with a sentence the model can read.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  VERSE_MCP_DIR_ENV,
  VERSE_MCP_PROTOCOL_VERSIONS,
  VERSE_MCP_RESOLVE_ENV,
  VERSE_MCP_RUNNING_FILE_ENV,
  VERSE_MCP_SERVER_INFO,
  VERSE_MCP_TOKEN_FILE_ENV,
} from './verse-mcp-types.js';

export { VERSE_MCP_DIR_ENV, VERSE_MCP_RESOLVE_ENV, VERSE_MCP_RUNNING_FILE_ENV, VERSE_MCP_TOKEN_FILE_ENV };

const URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/api\/verse\/agent-tools\/mcp$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^[A-Za-z0-9-]{1,80}$/;
const MAX_LINE = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

export interface VerseMcpStdioIo {
  lines: AsyncIterable<string>;
  write(line: string): void;
  env: NodeJS.ProcessEnv;
  ppid: number;
  readFile(path: string): Promise<string>;
  fetch: typeof fetch;
}

export interface VerseMcpCredential {
  url: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readTokenFile(io: VerseMcpStdioIo, path: string): Promise<VerseMcpCredential | null> {
  try {
    const parsed: unknown = JSON.parse(await io.readFile(path));
    if (!isRecord(parsed)) return null;
    const url = parsed['url'];
    const token = parsed['token'];
    if (typeof url !== 'string' || !URL_RE.test(url) || typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    return { url, token };
  } catch {
    return null;
  }
}

/** The chat whose running turn is this process's parent (running.json), or null. */
async function chatOfParent(io: VerseMcpStdioIo, runningFile: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await io.readFile(runningFile));
    const entries = isRecord(parsed) && Array.isArray(parsed['entries']) ? parsed['entries'] : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entry['kind'] !== undefined && entry['kind'] !== 'turn') continue;
      if (entry['pid'] === io.ppid && typeof entry['sessionId'] === 'string' && SESSION_RE.test(entry['sessionId'])) return entry['sessionId'];
    }
  } catch { /* no registry: no chat */ }
  return null;
}

/** This bridge's credential right now, or null (see the file header). */
export async function resolveVerseMcpCredential(io: VerseMcpStdioIo): Promise<VerseMcpCredential | null> {
  const file = io.env[VERSE_MCP_TOKEN_FILE_ENV];
  if (typeof file === 'string' && file.startsWith('/')) return readTokenFile(io, file);
  if (io.env[VERSE_MCP_RESOLVE_ENV] === 'parent') {
    const dir = io.env[VERSE_MCP_DIR_ENV];
    const running = io.env[VERSE_MCP_RUNNING_FILE_ENV];
    if (typeof dir !== 'string' || !dir.startsWith('/') || typeof running !== 'string' || !running.startsWith('/')) return null;
    const chat = await chatOfParent(io, running);
    return chat ? readTokenFile(io, join(dir, `${chat}.token.json`)) : null;
  }
  return null;
}

const OFF_MESSAGE = 'Ashlr Verse tools are not available to this turn (they are switched off for this chat, or the turn has ended). Ask the operator to switch them on in the chat\'s Agent tools.';

/** What the bridge answers by itself when it has no live credential. */
export function offlineAnswer(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const params = isRecord(message['params']) ? message['params'] : {};
  switch (message['method']) {
    case 'initialize': {
      const asked = params['protocolVersion'];
      const version = typeof asked === 'string' && (VERSE_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : VERSE_MCP_PROTOCOL_VERSIONS[0];
      return { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: VERSE_MCP_SERVER_INFO, instructions: OFF_MESSAGE } };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [] } };
    case 'tools/call':
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: OFF_MESSAGE }], isError: true } };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
  }
}

async function relay(io: VerseMcpStdioIo, raw: string): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    io.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
    return;
  }
  const messages = Array.isArray(message) ? message : [message];
  const credential = await resolveVerseMcpCredential(io);
  const offline = (): void => {
    for (const m of messages) {
      const answer = isRecord(m) ? offlineAnswer(m) : null;
      if (answer) io.write(JSON.stringify(answer));
    }
  };
  if (!credential) return offline();
  let response: Response;
  try {
    response = await io.fetch(credential.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: raw,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return offline();
  }
  if (response.status === 202) return;
  if (response.status === 401 || response.status === 404) return offline();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return offline();
  }
  for (const answer of Array.isArray(body) ? body : [body]) io.write(JSON.stringify(answer));
}

function defaultIo(): VerseMcpStdioIo {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return {
    lines: rl,
    write: (line) => {
      try { process.stdout.write(`${line}\n`); } catch { /* the seat went away */ }
    },
    env: process.env,
    ppid: process.ppid,
    readFile: (path) => readFile(path, 'utf8'),
    fetch: globalThis.fetch.bind(globalThis),
  };
}

/** Serve until stdin closes. Requests run concurrently (a terminal_run can take minutes; a ping must not wait behind it). */
export async function runVerseMcpStdio(io: VerseMcpStdioIo = defaultIo()): Promise<number> {
  const inflight = new Set<Promise<void>>();
  for await (const line of io.lines) {
    if (!line.trim() || line.length > MAX_LINE) continue;
    const task = relay(io, line).catch(() => undefined);
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  }
  await Promise.all([...inflight]);
  return 0;
}

/**
 * core/verse/computer-api.ts — `/api/verse/computer*` (3.15, agent-tools P4):
 * the Verse window's side of desktop control. Mounted by verse-api.ts as the
 * `computer` workbench family.
 *
 *   GET  /api/verse/computer/state             → VerseComputerState
 *   GET  /api/verse/computer/commands?wait=    → { commands } (the Verse window's long-poll, ≤ 20 s)
 *   POST /api/verse/computer/result {id, ok, data?, code?, error?} → { ok: true }
 *   POST /api/verse/computer/revoke {sessionId, bundleId?}          → VerseComputerState
 *   POST /api/verse/computer/kill {}                                 → VerseComputerState
 *
 * Every route keeps the normal Verse posture: GETs behind the read session,
 * POSTs behind dispatch + the constant-time mutation token + JSON gate
 * (dispatchWorkbenchModules), then a body cap and strict keys. There is NO
 * seat-facing endpoint here: seats reach the tools through verse-mcp.ts,
 * which calls verse-mcp-computer.ts in-process.
 *
 * All IO here is async (scripts/check-verse-sync-io.mjs).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  COMPUTER_POLL_MAX_WAIT_MS,
  claimComputerCommands,
  completeComputerCommand,
  computerState,
  killComputer,
  revokeComputerGrants,
} from './computer-bridge.js';
import {
  COMPUTER_COMMAND_ID_RE,
  VERSE_COMPUTER_COMMANDS_PATH,
  VERSE_COMPUTER_KILL_PATH,
  VERSE_COMPUTER_RESULT_PATH,
  VERSE_COMPUTER_REVOKE_PATH,
  VERSE_COMPUTER_STATE_PATH,
  type VerseComputerCommandResult,
} from './computer-types.js';
import { VERSE_SESSION_ID_RE } from './verse-stream.js';

const SMALL_BODY_BYTES = 16 * 1024;
/** A screenshot answer: an image of a few MB as base64 plus the envelope. */
const RESULT_BODY_BYTES = 12 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryOf(req: IncomingMessage): Map<string, string> | null {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  for (const [key, value] of url.searchParams.entries()) {
    if (out.has(key)) return null;
    out.set(key, value);
  }
  return out;
}

function invalid(res: ServerResponse, error: string): true {
  sendJson(res, 400, { code: 'VERSE_INVALID', error });
  return true;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return key;
  return null;
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req, maxBytes);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid(res, 'body must be JSON');
    return null;
  }
  if (!isRecord(parsed)) {
    invalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed;
}

export function parseComputerResult(body: Record<string, unknown>): VerseComputerCommandResult | string {
  const extra = onlyKeys(body, ['id', 'ok', 'data', 'code', 'error']);
  if (extra) return `unknown field: ${extra.slice(0, 40)}`;
  if (typeof body['id'] !== 'string' || !COMPUTER_COMMAND_ID_RE.test(body['id'])) return 'id is required';
  if (typeof body['ok'] !== 'boolean') return 'ok must be a boolean';
  if (body['code'] !== undefined && (typeof body['code'] !== 'string' || body['code'].length > 40)) return 'code must be a short string';
  if (body['error'] !== undefined && typeof body['error'] !== 'string') return 'error must be a string';
  return {
    id: body['id'],
    ok: body['ok'],
    ...(body['data'] !== undefined ? { data: body['data'] } : {}),
    ...(typeof body['code'] === 'string' ? { code: body['code'] as VerseComputerCommandResult['code'] } : {}),
    ...(typeof body['error'] === 'string' ? { error: body['error'] } : {}),
  };
}

function writeRaw(res: ServerResponse, status: number, body: unknown): void {
  // Written directly, not through sendJson: its public-JSON scrubber rewrites
  // long base64-looking runs, and a relayed `type` op must reach native byte
  // for byte (a silently altered keystroke stream is worse than none).
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export const handleComputerApi: ApiModule = async (_ctx, req, res, path, method) => {
  if (path === VERSE_COMPUTER_STATE_PATH || path === VERSE_COMPUTER_COMMANDS_PATH) {
    if (method !== 'GET') return false;
    const query = queryOf(req);
    if (!query) return invalid(res, 'invalid query');
    const allowed = path === VERSE_COMPUTER_STATE_PATH ? [] : ['wait'];
    for (const key of query.keys()) if (!allowed.includes(key)) return invalid(res, `unknown parameter: ${key.slice(0, 40)}`);
    if (path === VERSE_COMPUTER_STATE_PATH) {
      writeRaw(res, 200, computerState());
      return true;
    }
    const waitRaw = query.get('wait');
    const wait = waitRaw === undefined ? COMPUTER_POLL_MAX_WAIT_MS : Number(waitRaw);
    if (!Number.isInteger(wait) || wait < 0 || wait > COMPUTER_POLL_MAX_WAIT_MS) return invalid(res, `wait must be 0-${COMPUTER_POLL_MAX_WAIT_MS}`);
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.once('close', onClose);
    const commands = await claimComputerCommands({ waitMs: wait, signal: abort.signal });
    res.off('close', onClose);
    if (res.writableEnded || res.destroyed) {
      // The window went away mid-poll: fail what it claimed so the agent hears now, not in a minute.
      for (const command of commands) completeComputerCommand({ id: command.id, ok: false, code: 'failed', error: 'The Verse window closed.' });
      return true;
    }
    writeRaw(res, 200, { commands });
    return true;
  }

  if (path === VERSE_COMPUTER_RESULT_PATH || path === VERSE_COMPUTER_REVOKE_PATH || path === VERSE_COMPUTER_KILL_PATH) {
    if (method !== 'POST') return false;
    const body = await readJsonObject(req, res, path === VERSE_COMPUTER_RESULT_PATH ? RESULT_BODY_BYTES : SMALL_BODY_BYTES);
    if (!body) return true;

    if (path === VERSE_COMPUTER_KILL_PATH) {
      const extra = onlyKeys(body, []);
      if (extra) return invalid(res, `unknown field: ${extra.slice(0, 40)}`);
      writeRaw(res, 200, killComputer());
      return true;
    }

    if (path === VERSE_COMPUTER_REVOKE_PATH) {
      const extra = onlyKeys(body, ['sessionId', 'bundleId']);
      if (extra) return invalid(res, `unknown field: ${extra.slice(0, 40)}`);
      if (typeof body['sessionId'] !== 'string' || !VERSE_SESSION_ID_RE.test(body['sessionId'])) return invalid(res, 'sessionId is required');
      if (body['bundleId'] !== undefined && (typeof body['bundleId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(body['bundleId']))) {
        return invalid(res, 'bundleId must be a bundle identifier');
      }
      writeRaw(res, 200, revokeComputerGrants(body['sessionId'], body['bundleId'] as string | undefined));
      return true;
    }

    const parsed = parseComputerResult(body);
    if (typeof parsed === 'string') return invalid(res, parsed);
    if (!completeComputerCommand(parsed)) {
      sendJson(res, 404, { code: 'VERSE_COMPUTER_COMMAND_GONE', error: 'that command is no longer waiting (it timed out or was cancelled)' });
      return true;
    }
    writeRaw(res, 200, { ok: true });
    return true;
  }

  return false;
};

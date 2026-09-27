/**
 * core/verse/checkpoints-api.ts — `/api/verse/checkpoints*`: the Changes pane,
 * per-file/per-hunk accept & reject, and Undo/Redo of a turn (3.15; service:
 * checkpoint-service.ts; plumbing: checkpoints.ts; wire: checkpoint-types.ts).
 *
 *   GET  /api/verse/checkpoints?chatId=                       → VerseCheckpointListResponse
 *   GET  /api/verse/checkpoints/diff?chatId=&turnId=&rootId=&mode=since|turn[&file=]
 *                                                             → VerseCheckpointDiffResponse
 *   POST /api/verse/checkpoints/review       {chatId, turnId, rootId, file, hunk?, decision}
 *   POST /api/verse/checkpoints/undo/preview {chatId, turnId} → VerseCheckpointPreviewResponse
 *   POST /api/verse/checkpoints/redo/preview {chatId}         → VerseCheckpointPreviewResponse
 *   POST /api/verse/checkpoints/apply        {chatId, previewId, resolutions?}
 *                                                             → VerseCheckpointApplyResponse
 *
 * SECURITY POSTURE (same as git-api.ts):
 *   - GETs sit behind the read-session boundary; POSTs need dispatch, the
 *     constant-time mutation token and a JSON Content-Type (checked by the
 *     mount AND here).
 *   - The page never names a folder. It names a CHAT; the repositories are
 *     that chat's own roots, addressed by an opaque rootId the server
 *     derived. A file must be one the diff itself lists.
 *   - Unknown query parameters and body keys are 400s. Everything returned
 *     passes sendJson → sanitizePublicJson; git's stderr never does.
 *   - Writes (reject, apply) are refused (409) while a turn runs in this chat
 *     OR in any other chat whose folders overlap this chat's repositories —
 *     restoring files under a running agent would race its edits.
 *   - #523: no synchronous fs or child process in this file
 *     (scripts/check-verse-sync-io.mjs).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { CheckpointError } from './checkpoints.js';
import { getCheckpointService, type CheckpointChat, type CheckpointService } from './checkpoint-service.js';
import {
  VERSE_CHECKPOINTS_APPLY_PATH,
  VERSE_CHECKPOINTS_DIFF_PATH,
  VERSE_CHECKPOINTS_PATH,
  VERSE_CHECKPOINTS_REDO_PREVIEW_PATH,
  VERSE_CHECKPOINTS_REVIEW_PATH,
  VERSE_CHECKPOINTS_UNDO_PREVIEW_PATH,
  type VerseCheckpointResolution,
} from './checkpoint-types.js';
import { withFolderIo } from './folder-io.js';
import { GitOpError, isSafeRepoPath } from './git-ops.js';
import { expandHomePrefix } from './path-guard.js';
import { verseSessionRoots, type VerseSession } from './types.js';

// ---------------------------------------------------------------------------
// Dependencies (tests inject; production reads the engine lazily)
// ---------------------------------------------------------------------------

type SessionLike = Pick<VerseSession, 'id' | 'projectPath' | 'extraRoots' | 'status'>;

export interface CheckpointsApiDeps {
  service?: CheckpointService;
  /** Every chat the engine knows (id, roots, status). */
  sessions?: () => Promise<readonly SessionLike[]> | readonly SessionLike[];
}

let deps: CheckpointsApiDeps = {};

/** Test hook: inject fakes, or null to restore production behaviour. */
export function setCheckpointsApiDepsForTest(next: CheckpointsApiDeps | null): void {
  deps = next ?? {};
}

/** Imported lazily: verse-api.ts loads THIS module lazily, and a static edge back would be a load-time cycle. */
async function engineSessions(): Promise<SessionLike[]> {
  try {
    const mod = await import('./verse-api.js');
    return (await mod.getVerseEngine()).listSessions();
  } catch {
    return [];
  }
}

async function physical(path: string): Promise<string> {
  try {
    return await withFolderIo(() => realpath(path));
  } catch {
    return resolvePath(path);
  }
}

async function forms(path: string): Promise<string[]> {
  const expanded = expandHomePrefix(path);
  return [...new Set([resolvePath(expanded), await physical(expanded)])];
}

function overlaps(a: string, b: string): boolean {
  const inside = (x: string, y: string) => {
    const rel = relative(y, x);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * The chat, its roots, and whether a write must wait: its own turn runs, or
 * another chat's does in an overlapping folder.
 */
async function chatFor(chatId: string): Promise<CheckpointChat> {
  const sessions = await (deps.sessions ?? engineSessions)();
  const session = sessions.find((s) => s.id === chatId);
  if (!session) throw new CheckpointError('VERSE_NOT_FOUND', 'That chat does not exist.');
  const roots = verseSessionRoots(session);
  let running = session.status === 'running';
  if (!running) {
    const others = sessions.filter((s) => s.id !== chatId && s.status === 'running');
    if (others.length > 0) {
      const mine = (await Promise.all(roots.map(forms))).flat();
      outer: for (const other of others) {
        for (const r of verseSessionRoots(other)) {
          const theirs = await forms(r);
          if (theirs.some((t) => mine.some((m) => overlaps(t, m)))) {
            running = true;
            break outer;
          }
        }
      }
    }
  }
  return { id: session.id, roots, running };
}

const service = (): CheckpointService => deps.service ?? getCheckpointService();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class InvalidRequest extends Error {}

function invalid(message: string): never {
  throw new InvalidRequest(message);
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[0-9a-f]{8,64}$/;

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid(`${field} is not valid`);
  return value;
}

function readQuery(req: IncomingMessage, allowed: readonly string[]): URLSearchParams {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    invalid('invalid query string');
  }
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) invalid(`unknown query parameter: ${key}`);
    if (params.getAll(key).length > 1) invalid(`${key} was given more than once`);
  }
  return params;
}

async function readJsonBody(req: IncomingMessage, allowed: readonly string[]): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    invalid('request body is too large');
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    invalid('body must be JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('body must be a JSON object');
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(`unknown body key: ${key}`);
  return body;
}

function file(value: unknown): string {
  if (typeof value !== 'string' || !isSafeRepoPath(value)) invalid('file must be a path inside the repository');
  return value;
}

const RESOLUTIONS: ReadonlySet<string> = new Set(['keep', 'checkpoint', 'merge']);
const MAX_RESOLUTION_ROOTS = 16;
const MAX_RESOLUTIONS_PER_ROOT = 5_000;

function resolutions(value: unknown): Record<string, Record<string, VerseCheckpointResolution>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('resolutions must be an object');
  const out: Record<string, Record<string, VerseCheckpointResolution>> = {};
  const roots = Object.entries(value as Record<string, unknown>);
  if (roots.length > MAX_RESOLUTION_ROOTS) invalid('too many roots in resolutions');
  for (const [rootId, perFile] of roots) {
    if (!HEX.test(rootId)) invalid('resolutions must be keyed by rootId');
    if (perFile === null || typeof perFile !== 'object' || Array.isArray(perFile)) invalid('resolutions must map files to a choice');
    const entries = Object.entries(perFile as Record<string, unknown>);
    if (entries.length > MAX_RESOLUTIONS_PER_ROOT) invalid('too many resolutions');
    const inner: Record<string, VerseCheckpointResolution> = {};
    for (const [path, choice] of entries) {
      if (!isSafeRepoPath(path)) invalid('resolutions must name files inside the repository');
      if (typeof choice !== 'string' || !RESOLUTIONS.has(choice)) invalid('each resolution must be keep, checkpoint or merge');
      inner[path] = choice as VerseCheckpointResolution;
    }
    out[rootId] = inner;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const GET_ROUTES: ReadonlySet<string> = new Set([VERSE_CHECKPOINTS_PATH, VERSE_CHECKPOINTS_DIFF_PATH]);
const POST_ROUTES: ReadonlySet<string> = new Set([
  VERSE_CHECKPOINTS_REVIEW_PATH,
  VERSE_CHECKPOINTS_UNDO_PREVIEW_PATH,
  VERSE_CHECKPOINTS_REDO_PREVIEW_PATH,
  VERSE_CHECKPOINTS_APPLY_PATH,
]);

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof InvalidRequest) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: err.message });
    return;
  }
  if (err instanceof CheckpointError || err instanceof GitOpError) {
    sendJson(res, err.status, { code: err.code, error: err.message });
    return;
  }
  // Nothing about an unexpected failure is shown: its message may carry a path.
  sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'The checkpoint action failed unexpectedly.' });
}

export const handleCheckpointsApi: ApiModule = async (ctx, req, res, path, method) => {
  const isGet = GET_ROUTES.has(path);
  const isPost = POST_ROUTES.has(path);
  if (!isGet && !isPost) return false;
  try {
    if (isGet) {
      if (method !== 'GET') return false;
      if (path === VERSE_CHECKPOINTS_PATH) {
        const q = readQuery(req, ['chatId']);
        const chat = await chatFor(id(q.get('chatId'), 'chatId'));
        sendJson(res, 200, await service().list(chat));
        return true;
      }
      const q = readQuery(req, ['chatId', 'turnId', 'rootId', 'mode', 'file']);
      const chat = await chatFor(id(q.get('chatId'), 'chatId'));
      const turnId = id(q.get('turnId'), 'turnId');
      const rootId = q.get('rootId');
      if (rootId === null || !HEX.test(rootId)) invalid('rootId is not valid');
      const mode = q.get('mode') ?? 'since';
      if (mode !== 'since' && mode !== 'turn') invalid('mode must be since or turn');
      const f = q.get('file');
      sendJson(res, 200, await service().diff(chat, turnId, rootId, mode, f === null ? null : file(f)));
      return true;
    }

    if (method !== 'POST') return false;
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    if (!passesMutationGate(req, res, ctx.token)) return true;

    switch (path) {
      case VERSE_CHECKPOINTS_REVIEW_PATH: {
        const body = await readJsonBody(req, ['chatId', 'turnId', 'rootId', 'file', 'hunk', 'decision']);
        const chat = await chatFor(id(body['chatId'], 'chatId'));
        const rootId = body['rootId'];
        if (typeof rootId !== 'string' || !HEX.test(rootId)) invalid('rootId is not valid');
        const decision = body['decision'];
        if (decision !== 'accept' && decision !== 'reject') invalid('decision must be accept or reject');
        const hunk = body['hunk'];
        if (hunk !== undefined && (typeof hunk !== 'string' || !HEX.test(hunk))) invalid('hunk must be a hunk hash from the diff');
        sendJson(res, 200, await service().review(chat, {
          turnId: id(body['turnId'], 'turnId'),
          rootId,
          file: file(body['file']),
          hunk: (hunk as string | undefined) ?? null,
          decision,
        }));
        return true;
      }
      case VERSE_CHECKPOINTS_UNDO_PREVIEW_PATH: {
        const body = await readJsonBody(req, ['chatId', 'turnId']);
        const chat = await chatFor(id(body['chatId'], 'chatId'));
        sendJson(res, 200, await service().previewUndo(chat, id(body['turnId'], 'turnId')));
        return true;
      }
      case VERSE_CHECKPOINTS_REDO_PREVIEW_PATH: {
        const body = await readJsonBody(req, ['chatId']);
        const chat = await chatFor(id(body['chatId'], 'chatId'));
        sendJson(res, 200, await service().previewRedo(chat));
        return true;
      }
      case VERSE_CHECKPOINTS_APPLY_PATH: {
        const body = await readJsonBody(req, ['chatId', 'previewId', 'resolutions']);
        const chat = await chatFor(id(body['chatId'], 'chatId'));
        const previewId = body['previewId'];
        if (typeof previewId !== 'string' || !HEX.test(previewId)) invalid('previewId is not valid');
        sendJson(res, 200, await service().apply(chat, previewId, resolutions(body['resolutions'])));
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    sendError(res, err);
    return true;
  }
};

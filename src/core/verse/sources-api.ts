/**
 * Transcript sources API — mounted by verse-api.ts as the `sources` workbench
 * family.
 *
 *   POST /api/verse/sources/open {sessionId, path, line?} → {ok: true}
 *
 * A turn's numbered "Sources" list names the files the agent read as
 * `path:line`; clicking one opens that file in the operator's editor at that
 * line. Nothing is read back to the page — the only effect is a local editor
 * launch — but the path is agent-authored text, so it is confined exactly:
 *
 *   - the session must exist (404 otherwise), and its roots are the chat's own
 *     `verseSessionRoots` (primary + extraRoots), each re-checked with the
 *     workspace-root guard (never `/`, never the home directory itself, never
 *     ~/.ashlr) and realpath'd;
 *   - `path` is absolute (a leading `~/` is expanded, since sanitizePublicJson
 *     spells home that way on the way out) or relative to the primary root;
 *   - the file is realpath'd, so a symlink out of the roots is refused, and it
 *     must land STRICTLY inside one root and be a regular file.
 *
 * Refusals are 409 VERSE_REFUSED with a plain reason that never names the
 * resolved path. All IO is async and runs through withFolderIo
 * (scripts/check-verse-sync-io.mjs): roots live under ~/Desktop, behind macOS
 * privacy prompts.
 *
 * Security posture matches every Verse mutation (wiki-api.ts): 404 unless
 * dispatch is allowed, then the constant-time mutation token + JSON gate, a
 * 16 KB body cap, and 400 on unknown body keys. Responses go through
 * sendJson() → sanitizePublicJson().
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import type { AshlrConfig } from '../types.js';
import type { VerseSession } from './types.js';
import { verseSessionRoots } from './types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { withFolderIo } from './folder-io.js';
import { checkWorkspaceRootPathAsync, expandHomePrefix, MAX_GUARDED_PATH_CHARS } from './path-guard.js';

export const VERSE_SOURCES_PATH = '/api/verse/sources';
export const VERSE_SOURCES_OPEN_PATH = `${VERSE_SOURCES_PATH}/open`;

const MAX_BODY_BYTES = 16 * 1024;
/** A session id as the store accepts it (session-store SESSION_ID_RE). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Files at most this large get their line clamped to the real line count; larger ones open at the line asked. */
const LINE_COUNT_MAX_BYTES = 2 * 1024 * 1024;

export type SourcesSession = Pick<VerseSession, 'projectPath' | 'extraRoots'>;

export interface SourcesApiDeps {
  getSession(id: string): Promise<SourcesSession | null>;
  openInEditor(absPath: string, line: number, cfg: AshlrConfig): void;
}

async function defaultGetSession(id: string): Promise<SourcesSession | null> {
  // Lazy: verse-api.ts mounts this module, so a static value import would be a load-time cycle.
  const { getVerseEngine } = await import('./verse-api.js');
  return (await getVerseEngine()).getSession(id);
}

async function defaultOpenInEditor(absPath: string, line: number, cfg: AshlrConfig): Promise<void> {
  const open = await import('../../cli/open.js');
  open.openInEditorAt(absPath, line, cfg);
}

export const DEFAULT_SOURCES_API_DEPS: SourcesApiDeps = {
  getSession: defaultGetSession,
  openInEditor: (absPath, line, cfg) => {
    void defaultOpenInEditor(absPath, line, cfg).catch(() => undefined);
  },
};

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function sendRefused(res: ServerResponse, reason: string): void {
  sendJson(res, 409, { code: 'VERSE_REFUSED', error: reason });
}

async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown key: ${key.slice(0, 64)}`);
      return null;
    }
  }
  return parsed as Record<string, unknown>;
}

/** `file` is strictly below `root` (both physical paths); the root itself never qualifies. */
function strictlyInside(file: string, root: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return file.length > prefix.length && file.startsWith(prefix);
}

/** Lines in a small file (a trailing newline does not start another line); null for a large one. */
async function lineCount(file: string, size: number): Promise<number | null> {
  if (size > LINE_COUNT_MAX_BYTES) return null;
  const text = await withFolderIo(() => readFile(file, 'utf8'));
  if (text.length === 0) return 1;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith('\n') ? lines - 1 : lines;
}

type OpenTarget = { ok: true; file: string; line: number } | { ok: false; reason: string };

/** Resolve `raw` against the session's guarded, physical roots — or say why not. */
async function resolveTarget(session: SourcesSession, raw: string, line: number): Promise<OpenTarget> {
  const checks = await Promise.all(verseSessionRoots(session).map((root) => withFolderIo(() => checkWorkspaceRootPathAsync(root))));
  const primary = checks[0]?.ok ? checks[0].path : null;
  const roots = checks.filter((c): c is { ok: true; path: string } => c.ok).map((c) => c.path);
  if (roots.length === 0) return { ok: false, reason: 'This chat’s folders are no longer available.' };

  const expanded = expandHomePrefix(raw);
  let candidate: string;
  if (path.isAbsolute(expanded)) candidate = path.resolve(expanded);
  else if (primary) candidate = path.resolve(primary, expanded);
  else return { ok: false, reason: 'This chat’s main folder is no longer available.' };

  let real: string;
  try {
    real = await withFolderIo(() => realpath(candidate));
  } catch {
    return { ok: false, reason: 'That file does not exist.' };
  }
  // Physical containment: a symlink inside a root that points out of every root is refused here.
  if (!roots.some((root) => strictlyInside(real, root))) {
    return { ok: false, reason: 'That file is outside this chat’s folders.' };
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await withFolderIo(() => stat(real));
  } catch {
    return { ok: false, reason: 'That file does not exist.' };
  }
  if (!info.isFile()) return { ok: false, reason: 'That is not a file.' };

  let clamped = line;
  try {
    const count = await lineCount(real, Number(info.size));
    if (count !== null) clamped = Math.min(line, Math.max(1, count));
  } catch {
    // Unreadable as text: open at the line asked; the editor clamps it.
  }
  return { ok: true, file: real, line: clamped };
}

export function createSourcesApi(deps: SourcesApiDeps = DEFAULT_SOURCES_API_DEPS): ApiModule {
  return async (ctx, req, res, p, method) => {
    if (p !== VERSE_SOURCES_PATH && !p.startsWith(`${VERSE_SOURCES_PATH}/`)) return false;
    try {
      if (p !== VERSE_SOURCES_OPEN_PATH || method !== 'POST') {
        sendJson(res, 404, { error: `not found: ${method} ${p}` });
        return true;
      }
      const body = await readMutationBody(ctx, req, res, ['sessionId', 'path', 'line']);
      if (!body) return true;
      const { sessionId, path: rawPath } = body;
      const line = body['line'] === undefined ? 1 : body['line'];
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        sendInvalid(res, 'sessionId is required');
        return true;
      }
      if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_GUARDED_PATH_CHARS || rawPath.includes('\0')) {
        sendInvalid(res, `path is required (at most ${MAX_GUARDED_PATH_CHARS} characters, no NUL bytes)`);
        return true;
      }
      if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) {
        sendInvalid(res, 'line must be a positive integer');
        return true;
      }
      const session = await deps.getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${sessionId}` });
        return true;
      }
      const target = await resolveTarget(session, rawPath, line);
      if (!target.ok) {
        sendRefused(res, target.reason);
        return true;
      }
      deps.openInEditor(target.file, target.line, ctx.cfg);
      sendJson(res, 200, { ok: true });
      return true;
    } catch {
      sendJson(res, 500, { error: 'sources request failed' });
      return true;
    }
  };
}

export const handleSourcesApi: ApiModule = createSourcesApi();

/**
 * core/verse/git-api.ts — `/api/verse/git*`, the chat's branch bar and Review
 * pane (V3.10 unit C5; SPEC-310C §7 "Route contracts"; wire shapes in
 * workbench-types.ts §7). An ApiModule that C0 mounts in verse-api.ts by the
 * `/api/verse/git` prefix (never `/api/verse/github`, the read-only panel).
 *
 *   GET  /api/verse/git/status?root=                      → VerseGitStatusWire
 *   GET  /api/verse/git/diff?root=&scope=working|branch[&file=]
 *                                                          → VerseGitDiffResponse
 *   POST /api/verse/git/commit   {root, message, paths?}   → VerseGitActionResponse
 *   POST /api/verse/git/push     {root}                    → VerseGitActionResponse
 *   POST /api/verse/git/pr       {root, title, body?, draft?, base?}
 *                                                          → VerseGitActionResponse (pr set)
 *   POST /api/verse/git/pr/merge {root, number, headSha}   → VerseGitActionResponse (pr set)
 *   POST /api/verse/git/worktree {root, name}              → VerseGitWorktreeResponse
 *
 * SECURITY POSTURE (same as every Verse route, plus one rule of its own):
 *   - GETs sit behind server.ts's read-session boundary; POSTs are 404 unless
 *     the server allows dispatch, then need the constant-time mutation token
 *     and a JSON Content-Type (the mount checks both before loading this
 *     module; the handler checks again so it is safe mounted anywhere).
 *   - `root` MUST be a folder the operator already brought into Verse — a
 *     session's primary or extra root, or a `discoverProjects()` project —
 *     AND pass `checkWorkspaceRootPath` (never `/`, `~`, `~/.ashlr`). So this
 *     route is not a way to run git in, or read files from, anywhere else.
 *     A diff's `file` must also be one of that scope's own changed files.
 *   - Unknown query parameters and body keys are 400s.
 *   - Every response goes through sendJson() → sanitizePublicJson() (home
 *     paths become `~`, secret-shaped strings are scrubbed — patches too).
 *   - Git's and gh's stderr never reaches a response (git-ops.ts classifies).
 *   - Agents and MCP cannot reach these routes: they are page routes behind
 *     the operator's mutation token, and no agent tool or MCP server is given
 *     that token.
 *   - A commit is refused (409) while a chat turn is running in the same
 *     repository: committing half of an edit the agent is still making would
 *     record a state nobody reviewed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  GitOpError,
  commitChanges,
  isSafeBranchName,
  isSafeRepoPath,
  mergePullRequest,
  openPullRequest,
  pushBranch,
  readGitDiff,
  readGitStatus,
  resolveGitRoot,
  type GitOpsOptions,
} from './git-ops.js';
import { checkWorkspaceRootPath, expandHomePrefix } from './path-guard.js';
import { createWorktree, type WorktreeOptions } from './worktrees.js';
import { VERSE_GIT_PATH, type VerseGitActionResponse, type VerseGitDiffScope } from './workbench-types.js';

export const VERSE_GIT_COMMIT_PATH = `${VERSE_GIT_PATH}/commit`;
export const VERSE_GIT_PUSH_PATH = `${VERSE_GIT_PATH}/push`;
export const VERSE_GIT_PR_PATH = `${VERSE_GIT_PATH}/pr`;
export const VERSE_GIT_MERGE_PATH = `${VERSE_GIT_PATH}/pr/merge`;
export const VERSE_GIT_WORKTREE_PATH = `${VERSE_GIT_PATH}/worktree`;

const MAX_ROOT_CHARS = 4_096;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 60_000;
const MAX_COMMIT_PATHS = 2_000;
/** Known roots are re-read at most this often (enrollment file + session list). */
const KNOWN_ROOTS_TTL_MS = 3_000;

// ---------------------------------------------------------------------------
// Dependencies (tests inject fakes; production reads the engine lazily)
// ---------------------------------------------------------------------------

export interface GitApiDeps {
  /** Everything git-ops needs (runner, clock, fs seams). */
  ops?: WorktreeOptions;
  /** Folders the operator already brought into Verse (absolute, may be `~/…`). */
  knownRoots?: () => Promise<readonly string[]> | readonly string[];
  /** Roots of chats whose turn is running right now. */
  runningRoots?: () => Promise<readonly string[]> | readonly string[];
}

let deps: GitApiDeps = {};
let knownCache: { at: number; roots: Set<string> } | null = null;

/** Test hook: inject fakes, or pass null to restore production behaviour. Also clears the root cache. */
export function setGitApiDepsForTest(next: GitApiDeps | null): void {
  deps = next ?? {};
  knownCache = null;
}

interface SessionLike {
  projectPath: string;
  extraRoots?: string[];
  status?: string;
}

/**
 * `peekVerseEngine()`, never `getVerseEngine()`: a git read must never be the
 * thing that creates the session engine. Imported lazily — verse-api.ts loads
 * THIS module lazily, and a static edge back would be a load-time cycle.
 */
async function liveSessions(): Promise<SessionLike[]> {
  try {
    const mod = await import('./verse-api.js');
    return mod.peekVerseEngine()?.listSessions() ?? [];
  } catch {
    return [];
  }
}

async function defaultKnownRoots(): Promise<string[]> {
  const sessions = await liveSessions();
  const roots: string[] = [];
  for (const s of sessions) roots.push(s.projectPath, ...(s.extraRoots ?? []));
  try {
    const { discoverProjects } = await import('./projects.js');
    for (const p of discoverProjects({ sessions })) roots.push(p.path);
  } catch {
    /* enrollment unreadable: session roots still count */
  }
  return roots;
}

async function defaultRunningRoots(): Promise<string[]> {
  const out: string[] = [];
  for (const s of await liveSessions()) {
    if (s.status === 'running') out.push(s.projectPath, ...(s.extraRoots ?? []));
  }
  return out;
}

function physical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolvePath(path);
  }
}

async function knownRootSet(): Promise<Set<string>> {
  const now = Date.now();
  if (knownCache && now - knownCache.at < KNOWN_ROOTS_TTL_MS) return knownCache.roots;
  const raw = await (deps.knownRoots ?? defaultKnownRoots)();
  const roots = new Set<string>();
  for (const r of raw) {
    if (typeof r !== 'string' || r.length === 0) continue;
    const expanded = expandHomePrefix(r);
    if (!isAbsolute(expanded)) continue;
    roots.add(resolvePath(expanded));
    roots.add(physical(expanded));
  }
  knownCache = { at: now, roots };
  return roots;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class InvalidRequest extends Error {}

function invalid(message: string): never {
  throw new InvalidRequest(message);
}

/**
 * The root the page asked about, checked against the two rules in the header.
 * Returns the EXPANDED spelling (so the response echoes what the page keys its
 * rows by, once sanitizePublicJson turns the home back into `~`).
 */
async function checkedRoot(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ROOT_CHARS) invalid('root must be a folder path.');
  const expanded = expandHomePrefix(raw.trim());
  if (!isAbsolute(expanded)) invalid('root must be an absolute path.');
  const guard = checkWorkspaceRootPath(expanded);
  if (!guard.ok) throw new GitOpError('VERSE_GIT_REFUSED', 'Verse does not run git in that folder.');
  const known = await knownRootSet();
  if (!known.has(resolvePath(expanded)) && !known.has(guard.path)) {
    // The same answer whether or not the folder exists: this is not a probe.
    throw new GitOpError('VERSE_GIT_REFUSED', 'That folder is not part of any chat or project in Verse.');
  }
  return resolvePath(expanded);
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
    throw new GitOpError('VERSE_INVALID', 'request body is too large');
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

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) invalid(`${field} must not be empty`);
  if (value.length > max) invalid(`${field} is longer than ${max} characters`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const GET_ROUTES = new Set([`${VERSE_GIT_PATH}/status`, `${VERSE_GIT_PATH}/diff`]);
const POST_ROUTES = new Set([VERSE_GIT_COMMIT_PATH, VERSE_GIT_PUSH_PATH, VERSE_GIT_PR_PATH, VERSE_GIT_MERGE_PATH, VERSE_GIT_WORKTREE_PATH]);

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof InvalidRequest) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: err.message });
    return;
  }
  if (err instanceof GitOpError) {
    sendJson(res, err.status, { code: err.code, error: err.message });
    return;
  }
  // Nothing about an unexpected failure is shown: its message may carry a path.
  sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'The git action failed unexpectedly.' });
}

export const handleGitApi: ApiModule = async (ctx, req, res, path, method) => {
  const isGet = GET_ROUTES.has(path);
  const isPost = POST_ROUTES.has(path);
  if (!isGet && !isPost) return false;
  const ops: GitOpsOptions = deps.ops ?? {};
  try {
    if (isGet) {
      if (method !== 'GET') return false;
      if (path.endsWith('/status')) {
        const q = readQuery(req, ['root']);
        const root = await checkedRoot(q.get('root'));
        sendJson(res, 200, await readGitStatus(root, ops));
        return true;
      }
      const q = readQuery(req, ['root', 'scope', 'file']);
      const root = await checkedRoot(q.get('root'));
      const scope = q.get('scope');
      if (scope !== 'working' && scope !== 'branch') invalid('scope must be working or branch');
      const file = q.get('file');
      if (file !== null && !isSafeRepoPath(file)) invalid('file must be a path inside the repository');
      sendJson(res, 200, await readGitDiff(root, scope as VerseGitDiffScope, file, ops));
      return true;
    }

    if (method !== 'POST') return false;
    // The mount gates before loading this module; checked again so the
    // module is safe wherever it is mounted.
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    if (!passesMutationGate(req, res, ctx.token)) return true;

    switch (path) {
      case VERSE_GIT_COMMIT_PATH: {
        const body = await readJsonBody(req, ['root', 'message', 'paths']);
        const root = await checkedRoot(body['root']);
        const message = text(body['message'], 'message', MAX_MESSAGE_CHARS, true)!;
        let paths: string[] | undefined;
        if (body['paths'] !== undefined) {
          if (!Array.isArray(body['paths']) || body['paths'].length > MAX_COMMIT_PATHS) invalid('paths must be a list of files');
          paths = body['paths'].map((p) => {
            if (typeof p !== 'string' || !isSafeRepoPath(p)) invalid('paths must be files inside the repository');
            return p;
          });
        }
        await refuseWhileChatRuns(root, ops);
        const status = await commitChanges(root, { message, ...(paths ? { paths } : {}) }, ops);
        sendJson(res, 200, { ok: true, status, pr: status.pr } satisfies VerseGitActionResponse);
        return true;
      }
      case VERSE_GIT_PUSH_PATH: {
        const body = await readJsonBody(req, ['root']);
        const root = await checkedRoot(body['root']);
        const status = await pushBranch(root, ops);
        sendJson(res, 200, { ok: true, status, pr: status.pr } satisfies VerseGitActionResponse);
        return true;
      }
      case VERSE_GIT_PR_PATH: {
        const body = await readJsonBody(req, ['root', 'title', 'body', 'draft', 'base']);
        const root = await checkedRoot(body['root']);
        const title = text(body['title'], 'title', MAX_TITLE_CHARS, true)!;
        const prBody = text(body['body'], 'body', MAX_BODY_CHARS, false);
        if (body['draft'] !== undefined && typeof body['draft'] !== 'boolean') invalid('draft must be true or false');
        const base = text(body['base'], 'base', 255, false);
        if (base !== undefined && !isSafeBranchName(base)) invalid('base must be a branch name');
        const result = await openPullRequest(root, {
          title,
          ...(prBody ? { body: prBody } : {}),
          ...(body['draft'] === true ? { draft: true } : {}),
          ...(base ? { base } : {}),
        }, ops);
        sendJson(res, 200, { ok: true, status: result.status, pr: result.pr } satisfies VerseGitActionResponse);
        return true;
      }
      case VERSE_GIT_MERGE_PATH: {
        const body = await readJsonBody(req, ['root', 'number', 'headSha']);
        const root = await checkedRoot(body['root']);
        const number = body['number'];
        if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0 || number > 1e9) invalid('number must be a PR number');
        const headSha = body['headSha'];
        if (typeof headSha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(headSha)) invalid('headSha must be the commit SHA you reviewed');
        const result = await mergePullRequest(root, { number, headSha }, ops);
        sendJson(res, 200, { ok: true, status: result.status, pr: result.pr } satisfies VerseGitActionResponse);
        return true;
      }
      case VERSE_GIT_WORKTREE_PATH: {
        const body = await readJsonBody(req, ['root', 'name']);
        const root = await checkedRoot(body['root']);
        const name = text(body['name'], 'name', 63, true)!;
        sendJson(res, 200, await createWorktree(root, name, deps.ops ?? {}));
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

/** 409 while any running chat has a root inside (or around) this repository. */
async function refuseWhileChatRuns(root: string, ops: GitOpsOptions): Promise<void> {
  const running = await (deps.runningRoots ?? defaultRunningRoots)();
  if (running.length === 0) return;
  const gitRoot = await resolveGitRoot(root, ops);
  if (!gitRoot) return;
  // Both spellings of each side: a running root may not exist on disk any
  // more (no realpath), and macOS spells tmp and /var paths two ways.
  const forms = (p: string) => [...new Set([resolvePath(p), physical(p)])];
  const repoForms = forms(gitRoot);
  const inside = (a: string, b: string) => {
    const rel = relative(b, a);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  for (const r of running) {
    const runForms = forms(expandHomePrefix(r));
    if (runForms.some((p) => repoForms.some((repo) => inside(p, repo) || inside(repo, p)))) {
      throw new GitOpError('VERSE_GIT_BUSY', 'A chat is still working in this repository. Commit when its turn ends.');
    }
  }
}

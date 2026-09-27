/**
 * Repo wiki API (3.15) — the private DeepWiki. Mounted by verse-api.ts as the
 * `wiki` workbench family.
 *
 *   GET  /api/verse/wiki                          → WikiReposView (enrolled repos + wiki state)
 *   GET  /api/verse/wiki/repo/<key>               → WikiRepoView (per-page staleness, job, GitHub url)
 *   GET  /api/verse/wiki/repo/<key>/page/<id>     → WikiPageView (scrubbed markdown)
 *   POST /api/verse/wiki/repo/<key>/build {force?, noModel?} → 202 {job}
 *   POST /api/verse/wiki/ask  {question, repoKey?, noModel?} → WikiAskResult
 *   POST /api/verse/wiki/open {repoKey, file, line?}         → {ok}
 *
 * NEVER BUILDS ON THE REQUEST PATH: `build` starts a background job
 * (knowledge/wiki/jobs.ts) and answers 202; the UI polls the repo view. Ask
 * does call a model — it is the operator's question — but through the same
 * seat routing (local first, never Claude) and behind the mutation gate.
 *
 * Repos are addressed by wiki key and resolved ONLY against the enrolled list,
 * so a key can never name an arbitrary folder. `open` only opens files the
 * wiki listed from that repo. All IO here is async (scripts/check-verse-sync-io.mjs):
 * repos live under ~/Desktop, behind macOS privacy prompts.
 *
 * Security posture matches every Verse route: GETs sit behind the read
 * session; a POST is 404 unless dispatch is allowed, then the constant-time
 * mutation token + JSON gate, then a 16 KB body cap. Unknown query parameters
 * and body keys are 400s. Responses go through sendJson() → sanitizePublicJson(),
 * and page markdown / answers are secret-scrubbed again on the way out.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import type { AshlrConfig } from '../types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { askWiki, type AskWikiOptions } from '../knowledge/wiki/ask.js';
import { startWikiJob, wikiJob, type WikiJob } from '../knowledge/wiki/jobs.js';
import { githubNameWithOwner, isWikiReadable } from '../knowledge/wiki/scan.js';
import { scrubWikiText } from '../knowledge/wiki/scrub.js';
import { listWikiRepos, statusFromManifest, wikiCandidateRepos, wikiStatus } from '../knowledge/wiki/status.js';
import { isPageId, isWikiKey, readFileIndex, readManifest, readPage, wikiKey } from '../knowledge/wiki/store.js';
import { VERSE_WIKI_PATH, type WikiAskResult, type WikiJobView, type WikiPageView, type WikiRepoView, type WikiReposView } from '../knowledge/wiki/types.js';

const MAX_BODY_BYTES = 16 * 1024;

export interface WikiApiDeps {
  candidates(): string[];
  startJob(repo: string, opts: { cfg: AshlrConfig; force: boolean; noModel: boolean }): { ok: true; job: WikiJob } | { ok: false; reason: string };
  job(key: string): WikiJob | null;
  ask(opts: AskWikiOptions): Promise<WikiAskResult>;
  openInEditor(absPath: string, line: number, cfg: AshlrConfig): void;
  github(repo: string): Promise<string | null>;
}

async function defaultOpenInEditor(absPath: string, line: number, cfg: AshlrConfig): Promise<void> {
  const open = await import('../../cli/open.js');
  open.openInEditorAt(absPath, line, cfg);
}

export const DEFAULT_WIKI_API_DEPS: WikiApiDeps = {
  candidates: () => wikiCandidateRepos(),
  startJob: (repo, opts) => startWikiJob(repo, { cfg: opts.cfg, force: opts.force, noModel: opts.noModel }),
  job: (key) => wikiJob(key),
  ask: (opts) => askWiki(opts),
  openInEditor: (absPath, line, cfg) => {
    void defaultOpenInEditor(absPath, line, cfg).catch(() => undefined);
  },
  github: (repo) => githubNameWithOwner(repo),
};

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function sendRefused(res: ServerResponse, reason: string): void {
  sendJson(res, 409, { code: 'VERSE_REFUSED', error: reason });
}

function sendNotFound(res: ServerResponse, what: string): void {
  sendJson(res, 404, { error: `not found: ${what}` });
}

function hasNoQuery(req: IncomingMessage, res: ServerResponse): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return false;
  }
  for (const key of params.keys()) {
    sendInvalid(res, `unknown query parameter: ${key.slice(0, 64)}`);
    return false;
  }
  return true;
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

/**
 * Paths the render-time scrub keeps intact: every file the wiki listed and
 * every directory above one (module names). Listings, never file contents.
 */
async function knownPaths(key: string | null): Promise<Set<string>> {
  const known = new Set<string>();
  if (!key) return known;
  for (const file of Object.keys(await readFileIndex(key))) {
    known.add(file);
    let dir = path.posix.dirname(file);
    while (dir !== '.' && dir !== '/' && !known.has(dir)) {
      known.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return known;
}

function jobView(job: WikiJob | null): WikiJobView | null {
  if (!job) return null;
  const { state, startedAt, finishedAt, progress, summary, error, trigger } = job;
  return { state, startedAt, finishedAt, progress, summary, error, trigger };
}

function optionalBool(v: unknown): boolean | null {
  return v === undefined ? false : typeof v === 'boolean' ? v : null;
}

/** The enrolled repo a key names, or null. Keys never resolve outside enrollment. */
function repoForKey(deps: WikiApiDeps, key: string): string | null {
  if (!isWikiKey(key)) return null;
  return deps.candidates().find((r) => wikiKey(r) === key) ?? null;
}

/** Split `/api/verse/wiki/repo/<key>[/page/<id>|/build]`. */
function parseRepoPath(p: string): { key: string; rest: string[] } | null {
  const prefix = `${VERSE_WIKI_PATH}/repo/`;
  if (!p.startsWith(prefix)) return null;
  const parts = p.slice(prefix.length).split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return '\u0000';
    }
  });
  const [key, ...rest] = parts;
  return key ? { key, rest } : null;
}

export function createWikiApi(deps: WikiApiDeps = DEFAULT_WIKI_API_DEPS): ApiModule {
  return async (ctx, req, res, p, method) => {
    if (p !== VERSE_WIKI_PATH && !p.startsWith(`${VERSE_WIKI_PATH}/`)) return false;
    try {
      // ── GET /api/verse/wiki ──────────────────────────────────────────────
      if (p === VERSE_WIKI_PATH) {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res)) return true;
        const repos = await listWikiRepos();
        const allowed = new Set(deps.candidates());
        const view: WikiReposView = {
          repos: repos
            .filter((r) => allowed.has(r.repo))
            .map((r) => ({ ...r, building: deps.job(r.key)?.state === 'running' }))
            .sort((a, b) => Number(b.exists) - Number(a.exists) || a.name.localeCompare(b.name)),
        };
        sendJson(res, 200, view);
        return true;
      }

      // ── POST /api/verse/wiki/ask ─────────────────────────────────────────
      if (p === `${VERSE_WIKI_PATH}/ask`) {
        if (method !== 'POST') return (sendNotFound(res, `${method} ${p}`), true);
        const body = await readMutationBody(ctx, req, res, ['question', 'repoKey', 'noModel']);
        if (!body) return true;
        const noModel = optionalBool(body['noModel']);
        if (typeof body['question'] !== 'string' || !body['question'].trim() || body['question'].length > 1000 || noModel === null) {
          sendInvalid(res, 'question (1–1000 characters) is required; noModel must be a boolean');
          return true;
        }
        let repo: string | undefined;
        if (body['repoKey'] !== undefined) {
          const found = typeof body['repoKey'] === 'string' ? repoForKey(deps, body['repoKey']) : null;
          if (!found) {
            sendRefused(res, 'That repo is not enrolled.');
            return true;
          }
          repo = found;
        }
        const result = await deps.ask({ question: body['question'], ...(repo ? { repo } : {}), cfg: ctx.cfg, noModel });
        sendJson(res, 200, { ...result, answer: scrubWikiText(result.answer, await knownPaths(result.repoKey)) });
        return true;
      }

      // ── POST /api/verse/wiki/open ────────────────────────────────────────
      if (p === `${VERSE_WIKI_PATH}/open`) {
        if (method !== 'POST') return (sendNotFound(res, `${method} ${p}`), true);
        const body = await readMutationBody(ctx, req, res, ['repoKey', 'file', 'line']);
        if (!body) return true;
        const line = body['line'] === undefined ? 1 : body['line'];
        if (typeof body['repoKey'] !== 'string' || typeof body['file'] !== 'string' || typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
          sendInvalid(res, 'repoKey and file (strings) are required; line must be a positive integer');
          return true;
        }
        const repo = repoForKey(deps, body['repoKey']);
        if (!repo) {
          sendRefused(res, 'That repo is not enrolled.');
          return true;
        }
        const file = body['file'];
        // Only files the wiki itself listed (and could cite) may be opened.
        const index = await readFileIndex(body['repoKey']);
        if (!isWikiReadable(file) || index[file] === undefined) {
          sendRefused(res, 'That file is not part of this repo’s wiki.');
          return true;
        }
        const abs = path.resolve(repo, file);
        let real: string;
        let realRepo: string;
        try {
          [real, realRepo] = await Promise.all([realpath(abs), realpath(repo)]);
        } catch {
          sendRefused(res, 'That file no longer exists.');
          return true;
        }
        if (!real.startsWith(realRepo + path.sep)) {
          sendRefused(res, 'That file resolves outside the repo.');
          return true;
        }
        deps.openInEditor(real, Math.min(line, index[file]!), ctx.cfg);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ── /api/verse/wiki/repo/<key>[/…] ───────────────────────────────────
      const parsed = parseRepoPath(p);
      if (!parsed) return (sendNotFound(res, `${method} ${p}`), true);
      const repo = repoForKey(deps, parsed.key);
      if (!repo) {
        sendNotFound(res, 'wiki repo');
        return true;
      }

      if (parsed.rest.length === 0) {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res)) return true;
        const manifest = await readManifest(parsed.key);
        const [status, nameWithOwner] = await Promise.all([manifest ? statusFromManifest(manifest) : wikiStatus(repo), deps.github(repo)]);
        const view: WikiRepoView = {
          status,
          job: jobView(deps.job(parsed.key)),
          githubUrl: nameWithOwner ? `https://github.com/${nameWithOwner}` : null,
        };
        sendJson(res, 200, view);
        return true;
      }

      if (parsed.rest.length === 2 && parsed.rest[0] === 'page') {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res)) return true;
        const id = parsed.rest[1]!;
        if (!isPageId(id)) return (sendNotFound(res, 'wiki page'), true);
        const [manifest, markdown] = await Promise.all([readManifest(parsed.key), readPage(parsed.key, id)]);
        const meta = manifest?.pages.find((x) => x.id === id);
        if (!manifest || !meta || markdown === null) return (sendNotFound(res, 'wiki page'), true);
        const view: WikiPageView = {
          meta: {
            id: meta.id,
            title: meta.title,
            kind: meta.kind,
            purpose: meta.purpose,
            ...(meta.parent ? { parent: meta.parent } : {}),
            commit: meta.commit,
            generatedAt: meta.generatedAt,
            model: meta.model,
            citations: meta.citations,
            droppedCitations: meta.droppedCitations,
          },
          // Scrubbed when stored; scrubbed again on the way out (defence in depth).
          markdown: scrubWikiText(markdown, await knownPaths(parsed.key)),
        };
        sendJson(res, 200, view);
        return true;
      }

      if (parsed.rest.length === 1 && parsed.rest[0] === 'build') {
        if (method !== 'POST') return (sendNotFound(res, `${method} ${p}`), true);
        const body = await readMutationBody(ctx, req, res, ['force', 'noModel']);
        if (!body) return true;
        const force = optionalBool(body['force']);
        const noModel = optionalBool(body['noModel']);
        if (force === null || noModel === null) {
          sendInvalid(res, 'force and noModel must be booleans');
          return true;
        }
        const started = deps.startJob(repo, { cfg: ctx.cfg, force, noModel });
        if (!started.ok) sendRefused(res, started.reason);
        else sendJson(res, 202, { job: jobView(started.job) });
        return true;
      }

      sendNotFound(res, `${method} ${p}`);
      return true;
    } catch {
      sendJson(res, 500, { error: 'wiki request failed' });
      return true;
    }
  };
}

export const handleWikiApi: ApiModule = createWikiApi();

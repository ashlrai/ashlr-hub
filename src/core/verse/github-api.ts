/**
 * core/verse/github-api.ts — `GET /api/verse/github{,/pr-plan}`
 * (docs/VERSE-WORKSPACES.md §2). The routes that make github.ts reachable
 * from Ashlr Verse.
 *
 * Mounted from src/core/web/api.ts's handleApi() BEFORE the V1 verse handler,
 * for the same reason the V2 control plane is: `isVerseApiPath()` matches every
 * `/api/verse/*` path and 404s what it does not recognise, so a route mounted
 * after it is never reached.
 *
 * SECURITY POSTURE — identical to control-api.ts, minus the POST half:
 *   - Both routes are GET-only and sit behind the read-session boundary in
 *     server.ts. There is NO mutation here. Nothing in this module opens,
 *     closes, merges, comments on, or pushes anything; `createPr` is not
 *     imported and `applyProposal` is not called.
 *   - Every response goes through sendJson() → sanitizePublicJson().
 *   - `?repo=` is refused unless the path is one the operator already brought
 *     into Verse — an enrolled repo, or the project path of an existing
 *     session (exactly `discoverProjects()`'s answer). The route is therefore
 *     not a filesystem probe.
 *   - No token, remote URL, launcher argv, or gh stderr can reach a response:
 *     github-repo.ts reads only `nameWithOwner`, and gh failures collapse to
 *     `prsAvailable: false` plus a fixed sentence.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../web/api.js';
import { loadProposal } from '../inbox/store.js';
import type { VerseControlErrorCode } from './control-types.js';
import { discoverProjects } from './projects.js';
import { expandHomePrefix, peekVerseEngine } from './verse-api.js';
import { describeVersePrPlans, type VersePrPlanProposal } from './github-proposal.js';
import {
  readVerseGithubSnapshotAsync,
  type VerseGithubReadOptions,
} from './github-repo.js';
import type { VerseGithubPrPlanResponse, VerseGithubSnapshot } from './github-types.js';

const VERSE_PREFIX = '/api/verse';

export const VERSE_GITHUB_ROUTE = `${VERSE_PREFIX}/github`;
export const VERSE_GITHUB_PR_PLAN_ROUTE = `${VERSE_PREFIX}/github/pr-plan`;

const GITHUB_ROUTES = new Set([VERSE_GITHUB_ROUTE, VERSE_GITHUB_PR_PLAN_ROUTE]);

/** Bound the work one request can ask for. */
const MAX_REPOS_PER_REQUEST = 12;
const MAX_PLAN_IDS = 50;
const MAX_ID_CHARS = 128;
const MAX_PATH_CHARS = 4_096;

/** Proposal ids are `prop-<ts>-<hex>`; accept that shape and nothing exotic. */
const PROPOSAL_ID_RE = /^[A-Za-z0-9._-]+$/;

/** True for exactly the two GitHub routes. */
export function isVerseGithubPath(path: string): boolean {
  return GITHUB_ROUTES.has(path);
}

export interface VerseGithubApiContext {
  readSession?: { id: string; expiresAt: number };
}

/** Test seam: the two readers this handler composes. */
export interface VerseGithubApiDeps {
  /**
   * May be sync or async: the production default is the async reader, while
   * existing tests hand in plain synchronous fakes. `await` accepts both.
   */
  read?: (
    paths: readonly string[],
    opts?: VerseGithubReadOptions,
  ) => VerseGithubSnapshot | Promise<VerseGithubSnapshot>;
  describePlans?: typeof describeVersePrPlans;
  loadProposal?: (id: string) => VersePrPlanProposal | null;
  knownRoots?: () => string[];
  readOptions?: VerseGithubReadOptions;
}

const ERROR_STATUS: Record<VerseControlErrorCode, 400 | 409 | 413 | 503> = {
  VERSE_INVALID: 400,
  VERSE_REFUSED: 409,
  VERSE_TOO_LARGE: 413,
  VERSE_UNAVAILABLE: 503,
};

function sendError(res: ServerResponse, code: VerseControlErrorCode, error: string): void {
  sendJson(res, ERROR_STATUS[code], { code, error });
}

function queryParam(req: IncomingMessage, key: string): string | null {
  const raw = req.url ?? '';
  const qIndex = raw.indexOf('?');
  if (qIndex < 0) return null;
  const params = new URLSearchParams(raw.slice(qIndex + 1));
  return params.get(key);
}

/**
 * Every root the operator has already brought into Verse: enrolled repos
 * first, then the project path of each live session. Identical to what
 * `GET /api/verse/bootstrap` lists, so the GitHub panel can never show a root
 * the picker does not.
 *
 * `peekVerseEngine()` is used rather than `getVerseEngine()` on purpose — a
 * read must never be the thing that creates the session engine.
 */
function defaultKnownRoots(): string[] {
  let sessions: { projectPath: string }[] = [];
  try {
    sessions = peekVerseEngine()?.listSessions() ?? [];
  } catch {
    sessions = [];
  }
  try {
    return discoverProjects({ sessions }).map((p) => p.path);
  } catch {
    return [];
  }
}

/**
 * Handle one `/api/verse/github*` request. Returns true when a response was
 * written (including errors); false when `path` is not one of these routes.
 */
export async function handleVerseGithubApi(
  _ctx: VerseGithubApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: VerseGithubApiDeps = {},
): Promise<boolean> {
  if (!isVerseGithubPath(path)) return false;

  try {
    if (method !== 'GET') {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    if (path === VERSE_GITHUB_ROUTE) {
      // Awaited so a rejected read lands in the catch below (500) rather than
      // escaping as an unhandled rejection with the response left open.
      await handleRepos(req, res, deps);
      return true;
    }

    handlePrPlans(req, res, deps);
    return true;
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'internal server error' });
    } else if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// GET /api/verse/github[?repo=<absolute path>]
// ---------------------------------------------------------------------------

async function handleRepos(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VerseGithubApiDeps,
): Promise<void> {
  // The async reader: on a cold list cache the sync path spawned `gh` with an
  // 8 s ceiling on the server's only thread (3.10 perf budget: no handler may
  // block > 20 ms). The async path runs `gh` off-thread and yields between roots.
  const read = deps.read ?? readVerseGithubSnapshotAsync;
  const known = (deps.knownRoots ?? defaultKnownRoots)();

  const requested = queryParam(req, 'repo');
  let roots: string[];
  // Without `?repo=`, this is the cheap index: identity and default branch per
  // root, from local `git` reads only. Even async, a dozen roots' worth of `gh`
  // list calls (8 s ceiling each) in one request is not something a UI mount
  // may trigger, so the index stays identity-only. The panel
  // fills in one root at a time with `?repo=`.
  let includeLists = false;

  if (requested === null) {
    roots = known.slice(0, MAX_REPOS_PER_REQUEST);
  } else {
    includeLists = true;
    if (requested.length === 0 || requested.length > MAX_PATH_CHARS) {
      sendError(res, 'VERSE_INVALID', 'repo must be a non-empty path');
      return;
    }
    const resolved = expandHomePrefix(requested);
    if (!known.includes(resolved)) {
      // Not "no such directory" — deliberately the same answer whether the
      // path exists or not, so this route cannot be used to probe the disk.
      sendError(
        res,
        'VERSE_REFUSED',
        'repo is not an enrolled project or an open session path',
      );
      return;
    }
    roots = [resolved];
  }

  const snapshot: VerseGithubSnapshot = await read(roots, {
    includeLists,
    ...(deps.readOptions ?? {}),
  });
  sendJson(res, 200, snapshot);
}

// ---------------------------------------------------------------------------
// GET /api/verse/github/pr-plan?id=<proposalId>[,<proposalId>…]
// ---------------------------------------------------------------------------

function handlePrPlans(req: IncomingMessage, res: ServerResponse, deps: VerseGithubApiDeps): void {
  const describe = deps.describePlans ?? describeVersePrPlans;
  const load = deps.loadProposal ?? ((id: string) => loadProposal(id) as VersePrPlanProposal | null);

  const raw = queryParam(req, 'id');
  if (raw === null || raw.length === 0) {
    sendError(res, 'VERSE_INVALID', 'id is required');
    return;
  }

  const ids: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id.length === 0) continue;
    if (id.length > MAX_ID_CHARS || !PROPOSAL_ID_RE.test(id)) {
      sendError(res, 'VERSE_INVALID', 'id contains an unsupported character');
      return;
    }
    if (!ids.includes(id)) ids.push(id);
    if (ids.length > MAX_PLAN_IDS) {
      sendError(res, 'VERSE_INVALID', `at most ${MAX_PLAN_IDS} ids per request`);
      return;
    }
  }
  if (ids.length === 0) {
    sendError(res, 'VERSE_INVALID', 'id is required');
    return;
  }

  const proposals: VersePrPlanProposal[] = [];
  for (const id of ids) {
    let proposal: VersePrPlanProposal | null = null;
    try {
      proposal = load(id);
    } catch {
      proposal = null;
    }
    // An unknown id is silently absent rather than a 404: a client asking for
    // several plans should not lose all of them because one was just applied
    // and rotated out from under it.
    if (proposal) proposals.push(proposal);
  }

  const body: VerseGithubPrPlanResponse = {
    plans: describe(proposals),
    observedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
}

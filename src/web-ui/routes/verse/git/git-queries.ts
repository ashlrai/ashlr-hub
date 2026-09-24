/**
 * routes/verse/git/git-queries.ts — the page's side of `/api/verse/git*`
 * (unit C5; server: core/verse/git-api.ts).
 *
 * Reads are plain fetches, not cache entries: a branch's state is stale the
 * moment a turn commits, and the bar and pane each own their own freshness
 * (poll while visible; re-read after every action).
 *
 * WHY a GET helper of its own instead of data/client.ts `apiGet`: the git
 * routes answer "not a repository" (404) and "not a folder Verse knows"
 * (409) with a CODE the bar acts on — it drops that root instead of showing
 * an error — and apiGet discards the body of a failed read.
 *
 * Mutations go through the held mutation token exactly like every other
 * Verse write (verse-queries.ts): no token → VerseMutationLockedError, which
 * the caller's token gate turns into the unlock dialog.
 */
import { ApiError, apiPost } from '../../../data/client.js';
import { getMutationToken, getReadClientProof, reportSessionExpired, touchMutationHold } from '../../../data/auth-store.js';
import type {
  VerseGitActionResponse,
  VerseGitCommitRequest,
  VerseGitDiffResponse,
  VerseGitDiffScope,
  VerseGitMergeRequest,
  VerseGitPrRequest,
  VerseGitWorktreeResponse,
} from '../../../data/api-types.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import type { GitStatusView } from './git-model.js';

export const GIT_API = '/api/verse/git';

/** Codes that mean "this root has no bar", not "something broke". */
export const GIT_ROOT_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['VERSE_GIT_NOT_A_REPO', 'VERSE_GIT_REFUSED']);

async function gitGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'x-ashlr-read-client': getReadClientProof() },
    signal,
  });
  if (res.status === 401) {
    reportSessionExpired();
    throw new ApiError('Read session expired.', 401, path);
  }
  if (!res.ok) {
    let detail: string | null = null;
    let code: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      detail = typeof body.error === 'string' && body.error ? body.error : null;
      code = typeof body.code === 'string' && body.code ? body.code : null;
    } catch {
      /* not JSON */
    }
    throw new ApiError(`GET ${path} failed (HTTP ${res.status}).`, res.status, path, detail, code);
  }
  return (await res.json()) as T;
}

export function fetchGitStatus(root: string, signal?: AbortSignal): Promise<GitStatusView> {
  return gitGet<GitStatusView>(`${GIT_API}/status?root=${encodeURIComponent(root)}`, signal);
}

export interface GitDiffView extends VerseGitDiffResponse {
  /** Size of the whole patch before the 256 KB cut; null when no file was asked. */
  patchBytes?: number | null;
}

export function fetchGitDiff(root: string, scope: VerseGitDiffScope, file: string | null, signal?: AbortSignal): Promise<GitDiffView> {
  const params = new URLSearchParams({ root, scope });
  if (file !== null) params.set('file', file);
  return gitGet<GitDiffView>(`${GIT_API}/diff?${params.toString()}`, signal);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

export function commitGit(req: VerseGitCommitRequest): Promise<VerseGitActionResponse> {
  return post(`${GIT_API}/commit`, req);
}

export function pushGit(root: string): Promise<VerseGitActionResponse> {
  return post(`${GIT_API}/push`, { root });
}

export function openGitPr(req: VerseGitPrRequest): Promise<VerseGitActionResponse> {
  return post(`${GIT_API}/pr`, req);
}

export function mergeGitPr(req: VerseGitMergeRequest): Promise<VerseGitActionResponse> {
  return post(`${GIT_API}/pr/merge`, req);
}

export function createGitWorktree(root: string, name: string): Promise<VerseGitWorktreeResponse> {
  return post(`${GIT_API}/worktree`, { root, name });
}

/** True for a failed read that means "no bar for this root" rather than an error to show. */
export function isRootUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.code !== null && GIT_ROOT_UNAVAILABLE_CODES.has(err.code);
}

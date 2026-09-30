/**
 * routes/verse/wiki/wiki-queries.ts — the reads and writes behind the Wiki
 * section (core/verse/wiki-api.ts).
 *
 *   GET  /api/verse/wiki                        → WikiReposView
 *   GET  /api/verse/wiki/repo/<key>             → WikiRepoView (freshness + job)
 *   GET  /api/verse/wiki/repo/<key>/page/<id>   → WikiPageView
 *   POST /api/verse/wiki/repo/<key>/build       → 202 {job}     (background)
 *   POST /api/verse/wiki/ask                    → WikiAskResult (a model may run)
 *   POST /api/verse/wiki/open                   → {ok}          (editor at a line)
 *
 * Reads spend nothing. Writes pull the held mutation token, touch the hold,
 * and invalidate what they change.
 */
import type {
  WikiAskResult,
  WikiGraphView,
  WikiJobView,
  WikiPageView,
  WikiRepoView,
  WikiReposView,
} from '../../../../core/knowledge/wiki/types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const WIKI_PATH = '/api/verse/wiki';
export const WIKI_REPOS_KEY = 'verse-wiki-repos';

const repoKeyOf = (key: string) => `verse-wiki-repo:${key}`;
const pageKeyOf = (key: string, id: string) => `verse-wiki-page:${key}:${id}`;

export const wikiReposQuery: QueryDef<WikiReposView> = {
  key: WIKI_REPOS_KEY,
  fetch: (signal) => apiGet<WikiReposView>(WIKI_PATH, signal),
};

export function wikiRepoQuery(key: string): QueryDef<WikiRepoView> {
  return { key: repoKeyOf(key), fetch: (signal) => apiGet<WikiRepoView>(`${WIKI_PATH}/repo/${encodeURIComponent(key)}`, signal) };
}

export function wikiPageQuery(key: string, id: string): QueryDef<WikiPageView> {
  return {
    key: pageKeyOf(key, id),
    fetch: (signal) => apiGet<WikiPageView>(`${WIKI_PATH}/repo/${encodeURIComponent(key)}/page/${encodeURIComponent(id)}`, signal),
  };
}

export function wikiGraphQuery(key: string): QueryDef<WikiGraphView> {
  return { key: `verse-wiki-graph:${key}`, fetch: (signal) => apiGet<WikiGraphView>(`${WIKI_PATH}/repo/${encodeURIComponent(key)}/graph`, signal) };
}

function token(): string {
  const t = getMutationToken();
  if (!t) throw new VerseMutationLockedError();
  return t;
}

/** Start a background build; returns the job as the server reports it. */
export async function startWikiBuild(key: string, opts: { force?: boolean } = {}): Promise<WikiJobView | null> {
  const res = await apiPost<{ job: WikiJobView | null }>(`${WIKI_PATH}/repo/${encodeURIComponent(key)}/build`, opts.force ? { force: true } : {}, token());
  touchMutationHold();
  invalidate(repoKeyOf(key));
  invalidate(WIKI_REPOS_KEY);
  return res.job;
}

/** A finished build changes pages: drop every cached read for the repo. */
export function invalidateWikiRepo(key: string, pageIds: readonly string[]): void {
  invalidate(`verse-wiki-graph:${key}`);
  invalidate(repoKeyOf(key));
  invalidate(WIKI_REPOS_KEY);
  for (const id of pageIds) invalidate(pageKeyOf(key, id));
}

export async function askWikiQuestion(question: string, repoKey: string | null): Promise<WikiAskResult> {
  const res = await apiPost<WikiAskResult>(`${WIKI_PATH}/ask`, repoKey ? { question, repoKey } : { question }, token());
  touchMutationHold();
  return res;
}

export async function openWikiCitation(repoKey: string, file: string, line: number): Promise<void> {
  await apiPost<{ ok: true }>(`${WIKI_PATH}/open`, { repoKey, file, line }, token());
  touchMutationHold();
}

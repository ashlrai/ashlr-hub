/**
 * routes/verse/wiki/wiki-model.ts — pure helpers for the Wiki section:
 * the page tree, the freshness line, citation links (editor / GitHub), and
 * matching a ⌘K project to a wiki repo. No React, no fetch.
 */
import { parseCitationHref } from '../../../../core/knowledge/wiki/citations.js';
import type { WikiCitation, WikiRepoView, WikiReposView, WikiStatus } from '../../../../core/knowledge/wiki/types.js';

export { parseCitationHref };

export type WikiRepoRow = WikiReposView['repos'][number];
export type WikiTreePage = WikiStatus['pages'][number];

/** Pages in reading order: each top-level page followed by its children (depth-first). */
export function pageTree(pages: readonly WikiTreePage[]): Array<{ page: WikiTreePage; depth: number }> {
  const ids = new Set(pages.map((p) => p.id));
  const children = new Map<string, WikiTreePage[]>();
  const roots: WikiTreePage[] = [];
  for (const p of pages) {
    if (p.parent && ids.has(p.parent) && p.parent !== p.id) {
      const list = children.get(p.parent) ?? [];
      list.push(p);
      children.set(p.parent, list);
    } else {
      roots.push(p);
    }
  }
  const out: Array<{ page: WikiTreePage; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (p: WikiTreePage, depth: number): void => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    out.push({ page: p, depth });
    for (const c of children.get(p.id) ?? []) walk(c, Math.min(depth + 1, 3));
  };
  for (const r of roots) walk(r, 0);
  // Anything unreachable (a parent cycle) still shows, at the top level.
  for (const p of pages) if (!seen.has(p.id)) walk(p, 0);
  return out;
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'no commit';
}

export type FreshnessTone = 'success' | 'warning' | 'neutral';

/** "Generated at abc1234 · 3 pages stale" — the badge next to the repo picker. */
export function freshness(status: WikiStatus | undefined): { text: string; tone: FreshnessTone } {
  if (!status || !status.exists) return { text: 'Not built yet', tone: 'neutral' };
  const at = `Generated at ${shortSha(status.generatedCommit)}`;
  if (status.stalePages === 0) return { text: `${at} · fresh`, tone: 'success' };
  const n = status.stalePages;
  return { text: `${at} · ${n} ${n === 1 ? 'page' : 'pages'} stale`, tone: 'warning' };
}

/** Who wrote a page, in operator words. */
export function modelLabel(model: string): string {
  if (model === 'facts-only') return 'repository facts only (no model)';
  const [engine, ...rest] = model.split(':');
  const name = rest.join(':') || engine || model;
  if (engine === 'local') return `${name} (local)`;
  if (engine === 'grok') return `Grok (${name})`;
  return model;
}

/** `https://github.com/o/r/blob/<sha>/<path>#L10-L12`, or null without a GitHub origin or commit. */
export function githubCitationUrl(githubUrl: string | null, commit: string | null, cite: WikiCitation): string | null {
  if (!githubUrl || !commit || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(githubUrl)) return null;
  const path = cite.file.split('/').map(encodeURIComponent).join('/');
  const lines = cite.endLine && cite.endLine > cite.line ? `#L${cite.line}-L${cite.endLine}` : `#L${cite.line}`;
  return `${githubUrl}/blob/${commit}/${path}${lines}`;
}

/** The wiki repo a ⌘K project names (paths may both be `~`-collapsed by the server). */
export function repoForProject(repos: readonly WikiRepoRow[], projectPath: string | null): WikiRepoRow | null {
  if (!projectPath) return null;
  const norm = (p: string) => p.replace(/\/+$/, '');
  const exact = repos.find((r) => norm(r.repo) === norm(projectPath));
  if (exact) return exact;
  const base = norm(projectPath).split('/').pop();
  const byName = repos.filter((r) => r.name === base);
  return byName.length === 1 ? byName[0]! : null;
}

/** The repo to show first: a remembered one, else the first with a wiki, else the first. */
export function initialRepo(repos: readonly WikiRepoRow[], remembered: string | null): WikiRepoRow | null {
  return repos.find((r) => r.key === remembered) ?? repos.find((r) => r.exists) ?? repos[0] ?? null;
}

/** A job line: "Building… 3 of 9 (modules)". */
export function jobLine(job: WikiRepoView['job']): string | null {
  if (!job) return null;
  if (job.state === 'running') {
    const { index, total, page } = job.progress;
    return total > 0 ? `Building… ${index} of ${total}${page ? ` (${page})` : ''}` : 'Building… reading the repo';
  }
  if (job.state === 'failed') return `Build failed: ${job.error ?? 'unknown error'}`;
  const s = job.summary;
  if (!s) return 'Build finished.';
  const parts = [`${s.generated} written`, `${s.skippedFresh} already fresh`];
  if (s.deferred > 0) parts.push(`${s.deferred} left for next time (${s.budgetStop ?? 'budget'} budget)`);
  return `Build finished: ${parts.join(' · ')}${s.modelNote ? ` — ${s.modelNote}` : ''}`;
}

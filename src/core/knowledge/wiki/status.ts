/**
 * wiki/status.ts — freshness of a stored wiki against the repo as it is now.
 *
 * Cheap by construction: one `git ls-tree` (blob ids), two small steering
 * reads, zero source reads. Each page's hash is recomputed from the inputs
 * recorded in the manifest, so "generated at <commit>, 3 pages stale" is exact
 * for every input the page was built from. (A brand-new file that WOULD become
 * an input is picked up by the next build, which re-plans.)
 */

import path from 'node:path';

import { listEnrolled } from '../../sandbox/policy.js';
import { isMirrorPath } from '../../fleet/mirrors.js';
import { inputHash, treeHash } from './plan.js';
import { scanRepo } from './scan.js';
import { readWikiSteering } from './steering.js';
import { readManifest, wikiKey } from './store.js';
import type { WikiManifest, WikiStatus } from './types.js';

/** Compute per-page staleness for a manifest. */
export async function statusFromManifest(manifest: WikiManifest): Promise<WikiStatus> {
  const steering = await readWikiSteering(manifest.repo);
  const scan = await scanRepo(manifest.repo, steering.ignorePaths);
  const ctx = {
    blobs: new Map(scan.files.map((f) => [f.rel, f.blob])),
    tree: treeHash(scan.files.map((f) => f.rel)),
    steering: steering.hash,
  };
  const pending = new Set(manifest.pending);
  const pages = manifest.pages.map((p) => {
    const stale = pending.has(p.id) || inputHash(p, ctx) !== p.inputHash;
    return { id: p.id, title: p.title, kind: p.kind, ...(p.parent ? { parent: p.parent } : {}), stale, model: p.model, generatedAt: p.generatedAt };
  });
  return {
    repo: manifest.repo,
    repoName: manifest.repoName,
    key: manifest.key,
    exists: true,
    generatedAt: manifest.generatedAt,
    generatedCommit: manifest.commit,
    currentCommit: scan.head,
    pages,
    stalePages: pages.filter((p) => p.stale).length,
    pendingPages: manifest.pending.length,
    ...(manifest.lastRun ? { lastRun: manifest.lastRun } : {}),
  };
}

export async function wikiStatus(repo: string): Promise<WikiStatus> {
  const abs = path.resolve(repo);
  const key = wikiKey(abs);
  const manifest = await readManifest(key);
  if (!manifest) {
    return {
      repo: abs,
      repoName: path.basename(abs),
      key,
      exists: false,
      generatedAt: null,
      generatedCommit: null,
      currentCommit: null,
      pages: [],
      stalePages: 0,
      pendingPages: 0,
    };
  }
  return statusFromManifest(manifest);
}

/**
 * Enrolled repos, minus the fleet's own mirror clones (the same filter the
 * knowledge index applies outside an enrollment lens). Reads only the private
 * registry under ~/.ashlr.
 */
export function wikiCandidateRepos(): string[] {
  try {
    return listEnrolled().filter((r) => {
      try {
        return !isMirrorPath(r);
      } catch {
        return true;
      }
    });
  } catch {
    return [];
  }
}

export interface WikiRepoSummary {
  repo: string;
  name: string;
  key: string;
  exists: boolean;
  generatedAt: string | null;
  commit: string | null;
  pages: number;
  pending: number;
}

/** A light list for pickers: manifest facts only, no git calls. */
export async function listWikiRepos(): Promise<WikiRepoSummary[]> {
  const repos = wikiCandidateRepos();
  return Promise.all(
    repos.map(async (repo) => {
      const key = wikiKey(repo);
      const m = await readManifest(key);
      return {
        repo,
        name: path.basename(repo),
        key,
        exists: m !== null,
        generatedAt: m?.generatedAt ?? null,
        commit: m?.commit ?? null,
        pages: m?.pages.length ?? 0,
        pending: m?.pending.length ?? 0,
      };
    }),
  );
}

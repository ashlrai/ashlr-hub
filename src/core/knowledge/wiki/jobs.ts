/**
 * wiki/jobs.ts — background wiki builds for the Verse sidecar.
 *
 * A route never builds a wiki on its request path: it STARTS a job here and
 * answers at once; the UI polls the repo status, which carries the job. One
 * job per repo (buildWiki is single-flight), at most MAX_CONCURRENT_JOBS at a
 * time across repos so a click-happy operator cannot fan out model calls.
 *
 * AUTO-REFRESH keeps wikis that already exist fresh: every N minutes it picks
 * ONE enrolled repo whose wiki is behind HEAD (or has pending pages) and
 * refreshes only its stale pages, on a small page budget. It never creates a
 * wiki nobody asked for. Off with `foundry.wiki.autoRefresh: false`.
 */

import type { AshlrConfig } from '../../types.js';
import { buildWiki, type BuildWikiOptions, type WikiBuildProgress } from './generate.js';
import { wikiConfig } from './model.js';
import { readHead } from './scan.js';
import { wikiCandidateRepos } from './status.js';
import { readManifest, wikiKey } from './store.js';
import type { WikiRunSummary } from './types.js';

const MAX_CONCURRENT_JOBS = 2;
const JOB_TTL_MS = 30 * 60_000;
const AUTO_PAGE_BUDGET = 3;

export interface WikiJob {
  key: string;
  repo: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  progress: { index: number; total: number; page: string | null };
  summary: WikiRunSummary | null;
  error: string | null;
  trigger: 'operator' | 'auto';
}

const jobs = new Map<string, WikiJob>();

function prune(nowMs: number): void {
  for (const [key, job] of jobs) {
    if (job.state !== 'running' && job.finishedAt && nowMs - Date.parse(job.finishedAt) > JOB_TTL_MS) jobs.delete(key);
  }
}

export function wikiJob(key: string): WikiJob | null {
  prune(Date.now());
  const j = jobs.get(key);
  return j ? { ...j, progress: { ...j.progress } } : null;
}

export function runningWikiJobs(): number {
  let n = 0;
  for (const j of jobs.values()) if (j.state === 'running') n++;
  return n;
}

export type StartJobResult = { ok: true; job: WikiJob } | { ok: false; reason: string };

export interface StartJobOptions extends Omit<BuildWikiOptions, 'repo' | 'onProgress'> {
  trigger?: WikiJob['trigger'];
  /** Called when the job settles (tests; the UI polls instead). */
  onSettled?: (job: WikiJob) => void;
}

/** Start (or join) a background build for `repo`. Returns immediately. */
export function startWikiJob(repo: string, opts: StartJobOptions = {}): StartJobResult {
  const key = wikiKey(repo);
  const existing = jobs.get(key);
  if (existing?.state === 'running') return { ok: true, job: { ...existing } };
  if (runningWikiJobs() >= MAX_CONCURRENT_JOBS) return { ok: false, reason: `Already building ${MAX_CONCURRENT_JOBS} wikis; try again when one finishes.` };
  const job: WikiJob = {
    key,
    repo,
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { index: 0, total: 0, page: null },
    summary: null,
    error: null,
    trigger: opts.trigger ?? 'operator',
  };
  jobs.set(key, job);
  const { trigger: _t, onSettled, ...buildOpts } = opts;
  void buildWiki({
    ...buildOpts,
    repo,
    onProgress: (ev: WikiBuildProgress) => {
      job.progress = { index: ev.index, total: ev.total, page: ev.page };
    },
  })
    .then((res) => {
      job.finishedAt = new Date().toISOString();
      if (res.ok) {
        job.state = 'done';
        job.summary = res.summary;
      } else {
        job.state = 'failed';
        job.error = res.reason;
      }
    })
    .catch(() => {
      job.finishedAt = new Date().toISOString();
      job.state = 'failed';
      job.error = 'The wiki build failed.';
    })
    .finally(() => {
      try {
        onSettled?.({ ...job });
      } catch {
        // observer is best-effort
      }
    });
  return { ok: true, job: { ...job } };
}

/**
 * One auto-refresh pass: refresh the first existing wiki that is behind HEAD
 * or has pending pages. Returns the repo it started, or null.
 */
export async function autoRefreshOnce(cfg: AshlrConfig, deps: { start?: typeof startWikiJob } = {}): Promise<string | null> {
  if (!wikiConfig(cfg).autoRefresh) return null;
  const start = deps.start ?? startWikiJob;
  for (const repo of wikiCandidateRepos()) {
    const manifest = await readManifest(wikiKey(repo));
    if (!manifest) continue;
    const head = await readHead(repo);
    const behind = head !== null && head !== manifest.commit;
    if (!behind && manifest.pending.length === 0) continue;
    const res = start(repo, { cfg, trigger: 'auto', pageBudget: AUTO_PAGE_BUDGET });
    if (res.ok) return repo;
  }
  return null;
}

/** Start the auto-refresh timer. Returns a stop function (null when disabled). */
export function scheduleWikiAutoRefresh(cfg: AshlrConfig): (() => void) | null {
  const wc = wikiConfig(cfg);
  if (!wc.autoRefresh) return null;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void autoRefreshOnce(cfg)
      .catch(() => null)
      .finally(() => {
        running = false;
      });
  }, wc.autoRefreshMinutes * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Test seam: forget every job. */
export function __resetWikiJobsForTests(): void {
  jobs.clear();
}

/**
 * core/verse/agents/checks.ts — an agent's Checks tab: git status, its PR,
 * each CI check, review comments — and the two decisions the post-PR loop
 * makes from them:
 *
 *   autoMergeVerdict()   may Verse merge this PR right now? PURE.
 *   failingCiReport()    the failing checks + the tail of their logs, the
 *                        message Auto-fix sends back to the same seat.
 *
 * AUTO-MERGE RESPECTS, IN ORDER (first refusal wins, and is said in words):
 *   1. the operator's switch (Auto-merge on for THIS agent);
 *   2. the kill switch (~/.ashlr/KILL): nothing merges while it is engaged;
 *   3. the PR itself — open, not a draft, checks green, mergeable, and the
 *      head the checks ran on (git-ops' mergeRefusal: the same rules the
 *      branch bar's Merge button applies);
 *   4. protected paths (authority/protected-paths.ts, gate G1): a PR that
 *      touches CI, manifests, lockfiles, CODEOWNERS, hooks — and, in
 *      ashlr-hub itself, its Tier-1 authority code — is the owner's to merge,
 *      never an automatic one;
 *   5. ashlr-hub ITSELF lands on its own only when the standing grant's
 *      self-land policy says so (`merge.selfRepo === 'merge-non-authority'`
 *      in the policy in force — no grant, an expired or paused one, or
 *      `propose-only` means Verse opens the PR and leaves the merge to Mason);
 *   6. GitHub's branch protection, which the merge itself runs under (squash,
 *      `--match-head-commit`, never `--admin`, never `--auto`).
 *
 * NODE-ONLY (gh / git through git-ops' runner). No sync I/O.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scrubSecrets } from '../../util/scrub.js';
import { summarizeCheckRollup } from '../github-repo.js';
import {
  GH_PR_FIELDS,
  defaultGitRunner,
  mergeRefusal,
  parseGhPr,
  readGitStatus,
  type GitOpsOptions,
  type GitRunner,
} from '../git-ops.js';
import type { VerseGitPr } from '../workbench-types.js';
import type { AgentChecksDetail, AgentChecksSummary } from './types.js';

const COMMENTS_MAX = 30;
const COMMENT_CHARS = 1_200;
const FAILED_LOG_TAIL_CHARS = 12_000;
const FIX_PROMPT_MAX_BYTES = 48 * 1024;

export interface CheckRow {
  name: string;
  state: 'passing' | 'failing' | 'pending' | 'skipped';
  url: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function httpsUrl(v: unknown): string | null {
  return typeof v === 'string' && /^https:\/\//.test(v) ? v.slice(0, 2048) : null;
}

/** statusCheckRollup → one row per check. PURE. */
export function checkRows(rollup: unknown): CheckRow[] {
  if (!Array.isArray(rollup)) return [];
  const rows: CheckRow[] = [];
  for (const entry of rollup.slice(0, 100)) {
    if (!isRecord(entry)) continue;
    const name = String(entry['name'] ?? entry['context'] ?? entry['workflowName'] ?? 'check').slice(0, 120);
    const status = typeof entry['status'] === 'string' ? entry['status'].toUpperCase() : '';
    const conclusion = typeof entry['conclusion'] === 'string' ? entry['conclusion'].toUpperCase() : '';
    const ctx = typeof entry['state'] === 'string' ? entry['state'].toUpperCase() : '';
    let state: CheckRow['state'];
    if (status && status !== 'COMPLETED') state = 'pending';
    else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || ctx === 'SUCCESS') state = 'passing';
    else if (conclusion === 'SKIPPED') state = 'skipped';
    else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion) || ctx === 'FAILURE' || ctx === 'ERROR') state = 'failing';
    else state = 'pending';
    rows.push({ name, state, url: httpsUrl(entry['detailsUrl'] ?? entry['targetUrl']) });
  }
  return rows;
}

/** PR conversation + review comments, newest last, scrubbed. PURE. */
export function prComments(raw: Record<string, unknown>): AgentChecksDetail['comments'] {
  const out: AgentChecksDetail['comments'] = [];
  const take = (list: unknown, kind: 'comment' | 'review') => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!isRecord(c)) continue;
      const body = typeof c['body'] === 'string' ? c['body'].trim() : '';
      const state = typeof c['state'] === 'string' ? c['state'] : '';
      if (!body && !(kind === 'review' && state === 'CHANGES_REQUESTED')) continue;
      const author = isRecord(c['author']) && typeof c['author']['login'] === 'string' ? c['author']['login'].slice(0, 60) : 'someone';
      const text = body || 'Requested changes.';
      out.push({
        author,
        body: scrubSecrets(text.length > COMMENT_CHARS ? `${text.slice(0, COMMENT_CHARS)}…` : text),
        at: typeof c['createdAt'] === 'string' ? c['createdAt'] : typeof c['submittedAt'] === 'string' ? c['submittedAt'] : null,
        path: typeof c['path'] === 'string' ? c['path'].slice(0, 300) : null,
        url: httpsUrl(c['url']),
      });
    }
  };
  take(raw['comments'], 'comment');
  take(raw['reviews'], 'review');
  out.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return out.slice(-COMMENTS_MAX);
}

function prFiles(raw: Record<string, unknown>): string[] {
  const files = raw['files'];
  if (!Array.isArray(files)) return [];
  return files.filter(isRecord).map((f) => (typeof f['path'] === 'string' ? f['path'] : '')).filter(Boolean).slice(0, 3_000);
}

export interface MergeVerdictInput {
  autoMerge: boolean;
  killOn: boolean;
  pr: VerseGitPr | null;
  branch: string | null;
  files: readonly string[];
  selfRepo: boolean;
  /** The standing grant's self-land policy in force; null = no standing policy. */
  selfRepoMode: 'propose-only' | 'merge-non-authority' | null;
  /** First protected-path hit among `files`, when any. */
  protectedHit: { path: string; why: string } | null;
  /** Owner-configured code gates, never inferred from a green preview deployment. */
  requiredChecks: readonly string[];
  checks: readonly CheckRow[];
}

/** An unset or malformed owner configuration disables automatic merging. */
export function requiredAutoMergeChecks(raw: string | undefined): string[] {
  if (!raw || raw.length > 1024) return [];
  const names = raw.split(',').map((name) => name.trim());
  if (names.length > 8 || names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,119}$/.test(name))) return [];
  return [...new Set(names)];
}

/** Would Auto-merge merge this PR now? One sentence either way. PURE. */
export function autoMergeVerdict(input: MergeVerdictInput): { allowed: boolean; reason: string } {
  if (!input.autoMerge) return { allowed: false, reason: 'Auto-merge is off for this agent: you merge it.' };
  if (input.killOn) return { allowed: false, reason: 'The kill switch is engaged: nothing merges until it is cleared.' };
  if (!input.pr) return { allowed: false, reason: 'No PR yet. Auto-merge waits for one.' };
  if (input.pr.headSha === null) return { allowed: false, reason: 'GitHub has not reported this PR’s head yet.' };
  const refusal = mergeRefusal(input.pr, input.branch, input.pr.headSha);
  if (refusal) return { allowed: false, reason: refusal };
  if (input.protectedHit) {
    return { allowed: false, reason: `It touches ${input.protectedHit.path} — ${input.protectedHit.why}. That merge is yours, never automatic.` };
  }
  if (input.selfRepo && input.selfRepoMode !== 'merge-non-authority') {
    return {
      allowed: false,
      reason: input.selfRepoMode === null
        ? 'This is ashlr-hub itself, and no standing grant is in force: Verse opens the PR and leaves the merge to you.'
        : 'This is ashlr-hub itself, and the grant’s self-land policy is propose-only: Verse opens the PR and leaves the merge to you.',
    };
  }
  if (input.requiredChecks.length === 0) {
    return { allowed: false, reason: 'Auto-merge needs owner-configured code checks; preview deployment success alone is not a code gate.' };
  }
  for (const name of input.requiredChecks) {
    const matches = input.checks.filter((check) => check.name === name);
    if (matches.length !== 1 || matches[0]?.state !== 'passing') {
      return { allowed: false, reason: `Required code check ${name} has not passed on this PR head.` };
    }
  }
  return { allowed: true, reason: 'Green and mergeable: Auto-merge squash-merges it (GitHub’s branch rules still apply).' };
}

/** ashlr-hub is identified by its package name, as fleet/self.ts does — never by a path. */
export async function isSelfRepo(root: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    if (raw.length > 256 * 1024) return false;
    return (JSON.parse(raw) as { name?: unknown }).name === '@ashlr/hub';
  } catch {
    return false;
  }
}

export interface ChecksDeps extends GitOpsOptions {
  killOn?: () => Promise<boolean>;
  selfRepoMode?: () => Promise<'propose-only' | 'merge-non-authority' | null>;
  protectedHit?: (files: readonly string[], selfRepo: boolean) => Promise<{ path: string; why: string } | null>;
  isSelfRepo?: (root: string) => Promise<boolean>;
  requiredAutoMergeChecks?: () => readonly string[];
}

async function defaultKillOn(): Promise<boolean> {
  try {
    return await (await import('../terminal.js')).killSwitchEngagedAsync();
  } catch {
    // Unknown means stopped: never merge on a failed read.
    return true;
  }
}

async function defaultSelfRepoMode(): Promise<'propose-only' | 'merge-non-authority' | null> {
  try {
    const policy = (await import('../../authority/effective-config.js')).currentStandingPolicy();
    return policy ? policy.merge.selfRepo : null;
  } catch {
    return null;
  }
}

async function defaultProtectedHit(files: readonly string[], selfRepo: boolean): Promise<{ path: string; why: string } | null> {
  const { protectedPathHits } = await import('../../authority/protected-paths.js');
  const hit = protectedPathHits(files, { selfRepo })[0];
  return hit ? { path: hit.path, why: hit.why } : null;
}

export interface AgentChecksRead {
  detail: AgentChecksDetail;
  summary: AgentChecksSummary;
  /** The PR's changed files (for the verdict), not sent to the page. */
  files: string[];
}

/**
 * Read everything the Checks tab shows for the workspace at `root`. `gh`
 * failing (signed out, no GitHub remote) is reported as `unavailable`, and
 * the PR part as unknown — never as "no PR".
 */
export async function readAgentChecks(
  root: string,
  input: { agentId: string | null; sessionId: string | null; autoFix: boolean; autoMerge: boolean; loopNote: string | null },
  deps: ChecksDeps = {},
): Promise<AgentChecksRead> {
  const run: GitRunner = deps.runner ?? defaultGitRunner;
  const status = await readGitStatus(root, { ...deps, fresh: true });
  let pr: VerseGitPr | null = null;
  let rows: CheckRow[] = [];
  let comments: AgentChecksDetail['comments'] = [];
  let files: string[] = [];
  let unavailable: string | null = null;
  let ci: AgentChecksSummary['ci'] = 'unknown';
  if (status.branch) {
    const res = await run('gh', ['pr', 'view', status.branch, '--json', `${GH_PR_FIELDS},comments,reviews,files`], { cwd: status.gitRoot, maxStdoutBytes: 2 * 1024 * 1024 });
    if (res.code === 0) {
      try {
        const raw = JSON.parse(res.stdout) as Record<string, unknown>;
        const parsed = parseGhPr(raw);
        if (parsed) {
          pr = parsed.pr;
          rows = checkRows(raw['statusCheckRollup']);
          const summary = summarizeCheckRollup(raw['statusCheckRollup']);
          ci = summary.state === 'unknown' ? 'unknown' : summary.state;
          comments = prComments(raw);
          files = prFiles(raw);
        }
      } catch {
        unavailable = 'GitHub answered with something that is not a PR.';
      }
    } else if (/no pull requests found/i.test(res.stderr)) {
      ci = 'none';
    } else {
      unavailable = res.missing ? 'The GitHub CLI (gh) is not installed.' : /auth|login/i.test(res.stderr) ? 'GitHub CLI is signed out. Run `gh auth login`.' : 'GitHub could not be asked about this branch.';
    }
  }
  const selfRepo = await (deps.isSelfRepo ?? isSelfRepo)(status.gitRoot);
  const verdict = autoMergeVerdict({
    autoMerge: input.autoMerge,
    killOn: input.autoMerge ? await (deps.killOn ?? defaultKillOn)() : false,
    pr,
    branch: status.branch,
    files,
    selfRepo,
    selfRepoMode: input.autoMerge && selfRepo ? await (deps.selfRepoMode ?? defaultSelfRepoMode)() : null,
    protectedHit: input.autoMerge && files.length > 0 ? await (deps.protectedHit ?? defaultProtectedHit)(files, selfRepo) : null,
    requiredChecks: (deps.requiredAutoMergeChecks ?? (() => requiredAutoMergeChecks(process.env['ASHLR_VERSE_AUTOMERGE_CHECKS'])))(),
    checks: rows,
  });
  const checkedAt = new Date().toISOString();
  const prWire = pr
    ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title, mergeable: pr.mergeable, headSha: pr.headSha }
    : null;
  const commentCount = pr ? comments.length : null;
  return {
    files,
    detail: {
      agentId: input.agentId,
      sessionId: input.sessionId,
      root: status.gitRoot,
      branch: status.branch,
      base: status.base,
      dirty: status.dirty,
      ahead: status.ahead,
      behind: status.behind,
      diffstat: status.diffstat,
      pr: prWire,
      ci,
      checks: rows,
      comments,
      mergeVerdict: verdict,
      autoFix: input.autoFix,
      autoMerge: input.autoMerge,
      loopNote: input.loopNote,
      checkedAt,
      unavailable,
    },
    summary: {
      pr: prWire ? { number: prWire.number, url: prWire.url, state: prWire.state, title: prWire.title } : null,
      ci,
      dirty: status.dirty,
      ahead: status.ahead,
      comments: commentCount,
      checkedAt,
    },
  };
}

/** `…/actions/runs/<run>/job/<job>` → the run id; null for anything else. PURE. */
export function actionsRunId(url: string | null): string | null {
  if (!url) return null;
  const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d{1,20})(?:\/|$)/.exec(url);
  return m ? m[1]! : null;
}

/**
 * The Auto-fix message: which checks failed, and the tail of each failed
 * run's log (`gh run view --log-failed`), scrubbed of secrets and bounded —
 * sent to the same seat that wrote the code.
 */
export async function failingCiReport(
  root: string,
  pr: { number: number; url: string },
  rows: readonly CheckRow[],
  deps: GitOpsOptions = {},
): Promise<string> {
  const run: GitRunner = deps.runner ?? defaultGitRunner;
  const failing = rows.filter((r) => r.state === 'failing');
  const parts: string[] = [
    `CI is failing on PR #${pr.number} (${pr.url}).`,
    '',
    'Failing checks:',
    ...failing.map((r) => `- ${r.name}${r.url ? ` — ${r.url}` : ''}`),
  ];
  const runIds = [...new Set(failing.map((r) => actionsRunId(r.url)).filter((id): id is string => id !== null))].slice(0, 3);
  for (const id of runIds) {
    const res = await run('gh', ['run', 'view', id, '--log-failed'], { cwd: root, maxStdoutBytes: 4 * 1024 * 1024, timeoutMs: 60_000 });
    if (res.code !== 0 || !res.stdout.trim()) continue;
    const tail = res.stdout.length > FAILED_LOG_TAIL_CHARS ? `…\n${res.stdout.slice(-FAILED_LOG_TAIL_CHARS)}` : res.stdout;
    parts.push('', `Failed log (run ${id}, last part):`, '```', scrubSecrets(tail), '```');
  }
  parts.push(
    '',
    'Find the cause, fix it in this workspace, run the failing check locally if you can, then commit and push to this same branch so CI runs again. Do not merge, and do not weaken or skip the failing test to make it pass.',
  );
  let text = parts.join('\n');
  while (Buffer.byteLength(text, 'utf8') > FIX_PROMPT_MAX_BYTES) text = text.slice(0, Math.floor(text.length * 0.8));
  return text;
}

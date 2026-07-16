/**
 * context.ts — M163: real-world strategic context gatherer.
 *
 * gatherStrategicContext() assembles the grounded, real-world context the elite
 * Elon strategist (M162) reasons from — repo health, commit history, outcome
 * ledger, fleet state, and a human-readable narrative digest.
 *
 * Design rules:
 *  - Never throws — every sub-section degrades gracefully on any error.
 *  - Bounded + fast: commits capped at MAX_COMMITS per repo; repos capped at
 *    MAX_REPOS; gh calls time-boxed at GH_TIMEOUT_MS and tolerate absence.
 *  - Secret-safe: no secrets in the returned structure; paths are metadata.
 *  - No side-effects: pure read; nothing is written, enrolled, or mutated.
 *  - Network: only `gh issue list` is ever attempted (best-effort, gated on
 *    gh being available). All other I/O is purely local.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_REPOS = 20;
const MAX_COMMITS = 5;
const GH_TIMEOUT_MS = 4_000; // 4 s per repo — network, tolerate failure
const GIT_TIMEOUT_MS = 5_000; // mirrors git.ts

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-repo health + activity snapshot. */
export interface RepoContext {
  /** Absolute path to the repo. */
  path: string;
  /** Basename of the repo directory. */
  name: string;
  /**
   * Light health signal:
   *   'clean'  — working tree clean, no uncommitted changes.
   *   'dirty'  — uncommitted changes present.
   *   'no-git' — not a git repo or git unavailable.
   */
  health: 'clean' | 'dirty' | 'no-git';
  /** True when a test directory / test file pattern is present. */
  hasTests: boolean;
  /** Last MAX_COMMITS commit subject lines, newest first. Empty on failure. */
  recentCommits: string[];
  /**
   * Open GitHub issue count (best-effort via `gh issue list`).
   * null when gh is absent, offline, or the repo has no remote.
   */
  openIssueCount: number | null;
  /** ISO date string of the last commit, or null when unavailable. */
  lastActivity: string | null;
}

/** Outcome statistics from the decisions ledger over the last 7 days. */
export interface OutcomeContext {
  /** Receipt-qualified realized merges in the 7-day window. */
  merged7d: number;
  /**
   * Proposals reverted in the 7-day window.
   * Sourced from decisions-ledger entries with action === 'reverted'.
   */
  reverted7d: number;
  /** Proposals rejected (rejected + failed) in the 7-day window. */
  rejected7d: number;
  /** (merged7d) / (merged7d + rejected7d) — 0 when denominator is 0. */
  shipRate: number;
  /** Share of proposals that were trivially small. 0 when no proposals. */
  trivialRatio: number;
}

/** Fleet-level proposal + goal counts. */
export interface FleetContext {
  /** Proposals currently in 'pending' status. */
  pendingProposals: number;
  /** Goals with status 'active' or 'planning'. */
  activeGoals: number;
  /** Goals with status 'done'. */
  completedGoals: number;
}

/** The full strategic context object returned to the strategist. */
export interface StrategicContext {
  /** Per-repo health and activity, capped at MAX_REPOS enrolled repos. */
  repos: RepoContext[];
  /** 7-day outcome ledger statistics. */
  outcomes: OutcomeContext;
  /** Fleet proposal + goal counts. */
  fleet: FleetContext;
  /**
   * Human-readable narrative digest of repos/outcomes/fleet suitable for
   * direct injection into a prompt. Concise (~10-20 lines).
   */
  narrative: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Run a git command in cwd. Returns trimmed stdout or null on error. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/** True when the directory looks like a git repo root. */
function isGitRepo(dir: string): boolean {
  try {
    return existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Return true when the repo has a recognisable test directory or test files.
 * Checks for: test/, tests/, __tests__/, spec/, src/**\/*.test.*, *.spec.*
 * Pure FS, never throws.
 */
function detectTests(repoPath: string): boolean {
  const testDirs = ['test', 'tests', '__tests__', 'spec'];
  for (const d of testDirs) {
    if (existsSync(join(repoPath, d))) return true;
  }
  // Shallow scan of src/ for *.test.* / *.spec.* files
  const srcPath = join(repoPath, 'src');
  if (existsSync(srcPath)) {
    try {
      const entries = readdirSync(srcPath, { recursive: true, encoding: 'utf8' }) as string[];
      for (const e of entries) {
        if (/\.(test|spec)\.[jt]sx?$/.test(e)) return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * Fetch open GitHub issue count for the repo via `gh issue list --json number`.
 * Time-boxed to GH_TIMEOUT_MS. Returns null on any failure (gh absent, no
 * remote, offline, rate-limited).
 */
function fetchOpenIssueCount(repoPath: string): number | null {
  try {
    const raw = execFileSync(
      'gh',
      ['issue', 'list', '--state', 'open', '--json', 'number', '--limit', '500'],
      {
        cwd: repoPath,
        timeout: GH_TIMEOUT_MS,
        stdio: 'pipe',
        encoding: 'utf8',
      },
    ).trim();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    return null;
  } catch {
    return null;
  }
}

/** Gather context for one repo. Never throws. */
function gatherRepoContext(repoPath: string): RepoContext {
  const name = basename(repoPath);

  if (!isGitRepo(repoPath)) {
    return {
      path: repoPath,
      name,
      health: 'no-git',
      hasTests: detectTests(repoPath),
      recentCommits: [],
      openIssueCount: null,
      lastActivity: null,
    };
  }

  // --- health (clean vs dirty) ---
  const porcelain = git(repoPath, ['status', '--porcelain']);
  const health: RepoContext['health'] =
    porcelain === null
      ? 'no-git'
      : porcelain === ''
        ? 'clean'
        : 'dirty';

  // --- recent commits ---
  const logRaw = git(repoPath, [
    'log',
    `--max-count=${MAX_COMMITS}`,
    '--format=%s',
  ]);
  const recentCommits = logRaw
    ? logRaw.split('\n').filter(Boolean).slice(0, MAX_COMMITS)
    : [];

  // --- last activity ---
  const lastActivity = git(repoPath, ['log', '-1', '--format=%cI']) || null;

  // --- open issues (best-effort, time-boxed) ---
  const openIssueCount = fetchOpenIssueCount(repoPath);

  // --- test presence ---
  const hasTests = detectTests(repoPath);

  return {
    path: repoPath,
    name,
    health,
    hasTests,
    recentCommits,
    openIssueCount,
    lastActivity,
  };
}

/** Compute 7-day outcome stats from the decisions ledger + quality metrics. Never throws. */
async function gatherOutcomes(): Promise<OutcomeContext> {
  const zero: OutcomeContext = {
    merged7d: 0,
    reverted7d: 0,
    rejected7d: 0,
    shipRate: 0,
    trivialRatio: 0,
  };

  try {
    const { computeQualityMetrics } = await import('../fleet/quality-metrics.js');
    const m = computeQualityMetrics('7d');

    // reverted7d — read decisions ledger directly for 'reverted' action entries
    let reverted7d = 0;
    try {
      const { readDecisions } = await import('../fleet/decisions-ledger.js');
      const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const entries = readDecisions({ sinceMs: since7d });
      reverted7d = entries.filter(e => {
        const raw = e as unknown as Record<string, unknown>;
        return raw['action'] === 'reverted' || raw['verdict'] === 'reverted';
      }).length;
    } catch { /* best-effort */ }

    return {
      // Operational quality surfaces retain factual merges. Autonomous vision
      // context withholds them until a proof-bound credit release exists.
      merged7d: 0,
      reverted7d,
      rejected7d: m.rejected,
      shipRate: 0,
      trivialRatio: m.trivialRatio,
    };
  } catch {
    return zero;
  }
}

/** Gather fleet proposal + goal counts. Never throws. */
async function gatherFleet(): Promise<FleetContext> {
  const zero: FleetContext = { pendingProposals: 0, activeGoals: 0, completedGoals: 0 };

  let pendingProposals = 0;
  let activeGoals = 0;
  let completedGoals = 0;

  try {
    const { pendingCount } = await import('../inbox/store.js');
    pendingProposals = pendingCount();
  } catch { /* best-effort */ }

  try {
    const { listGoals } = await import('../goals/store.js');
    activeGoals =
      listGoals({ status: 'active' }).length +
      listGoals({ status: 'planning' }).length;
    completedGoals = listGoals({ status: 'done' }).length;
  } catch { /* best-effort */ }

  void zero; // suppress lint on zero — we always return the live values
  return { pendingProposals, activeGoals, completedGoals };
}

/** Build a concise narrative string from the gathered context sections. */
function buildNarrative(
  repos: RepoContext[],
  outcomes: OutcomeContext,
  fleet: FleetContext,
): string {
  const lines: string[] = [];

  // Fleet summary
  lines.push(
    `Fleet: ${fleet.pendingProposals} pending proposals | ${fleet.activeGoals} active goals | ${fleet.completedGoals} completed goals`,
  );

  // Outcome window
  lines.push(
    `7-day adaptive outcomes: positive merge credit unavailable, ${outcomes.rejected7d} rejected, ${outcomes.reverted7d} reverted` +
      ` | trivial ratio ${(outcomes.trivialRatio * 100).toFixed(0)}%`,
  );

  // Repo summary
  if (repos.length === 0) {
    lines.push('Repos: no enrolled repos.');
  } else {
    lines.push(`Repos (${repos.length} enrolled):`);
    for (const r of repos) {
      const health = r.health === 'clean' ? 'clean' : r.health === 'dirty' ? 'dirty' : 'no-git';
      const issues =
        r.openIssueCount === null ? 'gh unavailable' : `${r.openIssueCount} open issues`;
      const tests = r.hasTests ? 'has tests' : 'no tests';
      const lastCommit = r.recentCommits[0] ?? '(no commits)';
      const lastDate = r.lastActivity ? r.lastActivity.slice(0, 10) : 'unknown';
      lines.push(
        `  ${r.name}: ${health}, ${tests}, ${issues}, last commit ${lastDate}: "${lastCommit}"`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Gather the rich real-world strategic context the M162 strategist agent
 * reasons from.
 *
 * - Reads enrolled repos from the enrollment registry (bounded at MAX_REPOS).
 * - Collects per-repo health, recent commits, open issue count, last activity.
 * - Computes 7-day outcome stats from the decisions ledger + quality-metrics.
 * - Reads fleet state from inbox + goals stores.
 * - Builds a concise human-readable narrative for prompt injection.
 *
 * Never throws. Every sub-section degrades to its zero value on any error.
 * Network calls (gh) are time-boxed and tolerate absence/offline.
 */
export async function gatherStrategicContext(
  _cfg?: Partial<AshlrConfig>,
): Promise<StrategicContext> {
  // ── 1. Enrolled repos ────────────────────────────────────────────────────
  let enrolledPaths: string[] = [];
  try {
    const { listEnrolled } = await import('../sandbox/policy.js');
    enrolledPaths = listEnrolled().slice(0, MAX_REPOS);
  } catch { /* best-effort — empty if policy unavailable */ }

  const repos: RepoContext[] = [];
  for (const p of enrolledPaths) {
    try {
      repos.push(gatherRepoContext(p));
    } catch { /* skip this repo on unexpected error */ }
  }

  // ── 2. Outcomes (7d) ─────────────────────────────────────────────────────
  const outcomes = await gatherOutcomes();

  // ── 3. Fleet state ───────────────────────────────────────────────────────
  const fleet = await gatherFleet();

  // ── 4. Narrative digest ──────────────────────────────────────────────────
  const narrative = buildNarrative(repos, outcomes, fleet);

  return { repos, outcomes, fleet, narrative };
}

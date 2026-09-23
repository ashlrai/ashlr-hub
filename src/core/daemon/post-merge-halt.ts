/**
 * post-merge-halt.ts — the ONE gate that makes an unattended night survivable.
 *
 * ── WHAT WAS ALREADY THERE, AND WHAT WAS NOT ───────────────────────────────
 * The PRE-merge gate is genuinely solid and this module does not duplicate a
 * line of it. `fleet/automerge-pass` → `inbox/merge.autoMergeProposal` already
 * runs the repo's OWN typecheck / tests / lint in a throwaway worktree branched
 * off the default-branch head (`inbox/merge.verifyProposal`), with the verify
 * commands detected from the BASE tree so a diff cannot rewrite which commands
 * run; refuses any diff touching package.json / lockfiles / CI / Dockerfile /
 * Makefile outright; caps scope (4 files / 150 lines) and risk; requires an
 * independent frontier judge with an HMAC-signed attestation; calls
 * `assertMayMutate` so only `listEnrolled()` repos are ever touched; and
 * re-checks the kill switch at every write boundary. A proposal that cannot be
 * verified is left PENDING or rejected — never merged — and every rejection is
 * audited (`inbox:proposal-rejected`) with a decisions-ledger row. That is the
 * pre-merge half of the contract, and it holds.
 *
 * What did NOT exist anywhere is the half that matters at 4am: NOTHING re-ran
 * the suite AFTER a merge landed, and nothing could halt the run when it went
 * red. The only post-merge machinery is observation-only by construction —
 * `fleet/automerge-canary-observer` declares `authority: 'observation-only',
 * enforceSupported: false` and merely writes an audit row, and the M189
 * regression sentinel is default-OFF, needs two consecutive RED observations,
 * and is explicitly "proposal-only — NEVER applies, merges, or pushes".
 *
 * So a regression merged at 01:00 was invisible to the gate, and iteration N+1
 * was then built on top of it, and N+2 on top of that. By morning the bad
 * commit is load-bearing and backing it out is archaeology. THIS module makes
 * that impossible: the first red suite after a merge ENDS THE RUN. A bad night
 * costs exactly one revert, which this module names precisely, instead of a
 * tangled morning.
 *
 * ── HOW IT KNOWS A MERGE LANDED ────────────────────────────────────────────
 * By reading the repos, not by trusting a return value. It snapshots each
 * enrolled repo's HEAD before the tick and compares after. Anything that moved
 * a default branch — `automerge-pass`, a future path, anything at all — is
 * caught, because the evidence is the repository itself. A result object can be
 * wrong about what it did; `git rev-parse HEAD` cannot.
 *
 * ── FAIL SAFE ──────────────────────────────────────────────────────────────
 * A landing that cannot be verified HALTS. Not "continue and hope": if the
 * repo declares no required verify command, or the command cannot be run, or
 * git cannot be read, or THE WORKING TREE IS DIRTY, the run ends and says why.
 * That is the same direction the pre-merge gate already fails
 * (`allowWithoutVerification` defaults false) and the same direction
 * `daemonPaused()` projects an unreadable sentinel.
 *
 * Those cases are reported as UNPROVABLE, never as a regression, and the
 * distinction is deliberate. Not being overly critical governs how harshly a
 * CHANGE is judged; it says nothing about whether the EVIDENCE is sound. A
 * dirty tree means the post-merge run measured the operator's uncommitted
 * edits instead of the merge — the gate is not being strict there, it is
 * being honest that it proved nothing. That case matters more than the rest,
 * because it is the only one where the gate would otherwise say GREEN and be
 * wrong, and a false green is what the whole run window exists to prevent.
 *
 * ── FOLLOW-UP: THE MERGE COMMIT MESSAGE ────────────────────────────────────
 * Each merge is already exactly one revertable commit, but its message names
 * only the proposal: `ashlr: merge proposal branch ashlr/merge/<id>`
 * (inbox/merge.ts:2843-2854) over `ashlr: auto-merge proposal <id>`
 * (inbox/merge.ts:2690). It says WHAT, not WHY. Carrying the why into the
 * commit means editing inbox/merge.ts, which 14 automerge suites pin; until
 * that is worth doing, the why lives in the overnight status record
 * (daemon/overnight-status.ts), keyed by the same proposal id, and in the
 * halt record written below.
 *
 * ── HOW IT HALTS ───────────────────────────────────────────────────────────
 * By PARKING, never by killing. `stopDaemon()` is `setKill(true)`, which writes
 * the global `~/.ashlr/KILL` that `assertMayMutate` also reads — it would
 * disable the operator's own MCP write tools on arrival. This module's halt is
 * `pauseDaemon()` (`~/.ashlr/daemon.paused`, see daemon/pause.ts), which stops
 * autonomous dispatch and nothing else, and which one click reverses.
 *
 * No new runtime deps; node builtins only. Never throws out of a public API.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AshlrConfig } from '../types.js';
import { audit } from '../sandbox/audit.js';
import { listEnrolled } from '../sandbox/policy.js';
import {
  detectVerifyCommands,
  runVerifyCommandAsync,
  type VerifyCommand,
} from '../run/verify-commands.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One enrolled repo's default-branch tip at a point in time. */
export interface RepoHeadSnapshot {
  readonly repo: string;
  /** 40-char OID, or null when the repo could not be read at all. */
  readonly head: string | null;
  /** Set when `head` is null, so an unreadable repo is never silently skipped. */
  readonly unreadable?: string;
}

/** One commit that appeared on an enrolled repo between two snapshots. */
export interface LandedCommit {
  readonly sha: string;
  readonly subject: string;
  /** True for a merge commit (2+ parents) — it reverts with `-m 1`. */
  readonly isMerge: boolean;
}

/** A repo whose head moved while the daemon was ticking. */
export interface PostMergeLanding {
  readonly repo: string;
  readonly beforeHead: string;
  readonly afterHead: string;
  readonly commits: LandedCommit[];
  /** Exactly the command that backs this landing out. */
  readonly revertCommand: string;
}

export type PostMergeVerdict =
  /** No enrolled repo moved. The overwhelmingly common case; costs one git call per repo. */
  | 'no-landing'
  /** Something landed and the repo's own required suite is green on it. */
  | 'clean'
  /** Something landed and the repo's own required suite is RED on it. HALT. */
  | 'regressed'
  /** Something landed and could not be verified at all. HALT. */
  | 'unverifiable';

export interface PostMergeFailure {
  readonly repo: string;
  /**
   * A VerifyCommand kind means the check RAN and came back red — a genuine
   * regression. 'detection' / 'harness' / 'git' mean the check could not be
   * run or read at all, which is UNVERIFIABLE, not a regression. Both halt;
   * the distinction is what the operator reads at 07:00 to know whether they
   * are looking at a bad diff or a broken toolchain.
   */
  readonly kind: VerifyCommand['kind'] | 'detection' | 'harness' | 'git' | 'dirty-tree';
  readonly command: string;
  readonly detail: string;
}

export interface PostMergeGateResult {
  readonly verdict: PostMergeVerdict;
  /** True exactly when the run must end. Never true for 'clean'/'no-landing'. */
  readonly halt: boolean;
  readonly landings: PostMergeLanding[];
  readonly failures: PostMergeFailure[];
  /** Commands actually executed, for the audit line. */
  readonly ranCommands: number;
  /** One line, safe for an audit summary. Metadata only, never command output. */
  readonly detail: string;
  /** Every revert needed to undo this iteration, in the order to run them. */
  readonly revertPlan: string[];
  readonly durationMs: number;
}

/** A halt, written durably so the morning does not begin with guesswork. */
export interface PostMergeHaltRecord {
  readonly recordType: 'daemon-post-merge-halt';
  readonly haltedAt: string;
  readonly verdict: Exclude<PostMergeVerdict, 'clean' | 'no-landing'>;
  readonly detail: string;
  readonly landings: PostMergeLanding[];
  readonly failures: PostMergeFailure[];
  readonly revertPlan: string[];
}

// ---------------------------------------------------------------------------
// Seams — production defaults; tests inject.
// ---------------------------------------------------------------------------

export interface PostMergeGateSeams {
  /** Enrolled repos. Defaults to `listEnrolled()` and is NEVER widened. */
  readonly listEnrolledRepos?: () => string[];
  readonly detect?: typeof detectVerifyCommands;
  readonly run?: typeof runVerifyCommandAsync;
  readonly now?: () => number;
}

const GIT_TIMEOUT_MS = 10_000;

/** Failure kinds that mean "could not prove it", not "it is broken". */
const NON_REGRESSION_KINDS: ReadonlySet<PostMergeFailure['kind']> =
  new Set<PostMergeFailure['kind']>(['detection', 'harness', 'git', 'dirty-tree']);

/**
 * Is the repo's working tree clean enough for a post-merge verdict to MEAN
 * anything?
 *
 * Returns null when clean, or a short description of what is dirty.
 * `git status --porcelain` already honours `.gitignore`, so build output and
 * caches do not show up here — what does show up is a real uncommitted change
 * or a real untracked, un-ignored file. Both change what the suite measures.
 *
 * An unreadable status is reported as dirty: the same fail-safe direction as
 * everything else here. We are asking "can this verdict be trusted", and
 * "I could not tell" is not a yes.
 */
function workingTreeDirt(repo: string): string | null {
  const status = git(repo, ['status', '--porcelain', '--untracked-files=normal']);
  if (status === null) return 'git status could not be read';
  if (status.length === 0) return null;
  const lines = status.split('\n').filter((line) => line.trim().length > 0);
  const modified = lines.filter((line) => !line.startsWith('??')).length;
  const untracked = lines.length - modified;
  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} uncommitted change${modified === 1 ? '' : 's'}`);
  if (untracked > 0) parts.push(`${untracked} untracked file${untracked === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

/** Run git in `cwd`; trimmed stdout, or null on ANY failure. Never throws. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf8',
      // A merge landed by the fleet must not be re-read through a hook.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot + landing detection
// ---------------------------------------------------------------------------

/**
 * Read every ENROLLED repo's HEAD. Enrollment is the only source of repos —
 * a repo that is not enrolled is never read, never verified, and can never
 * appear in a landing or a halt.
 *
 * Never throws; an unreadable repo is recorded as such, not dropped.
 */
export function snapshotEnrolledHeads(seams: PostMergeGateSeams = {}): RepoHeadSnapshot[] {
  let repos: string[];
  try {
    repos = (seams.listEnrolledRepos ?? listEnrolled)();
  } catch {
    return [];
  }
  if (!Array.isArray(repos)) return [];
  const out: RepoHeadSnapshot[] = [];
  for (const repo of repos) {
    if (typeof repo !== 'string' || repo.length === 0) continue;
    const head = git(repo, ['rev-parse', 'HEAD']);
    out.push(head && /^[0-9a-f]{40}$/.test(head)
      ? { repo, head }
      : { repo, head: null, unreadable: 'git rev-parse HEAD failed' });
  }
  return out;
}

function parseLandedCommits(repo: string, beforeHead: string, afterHead: string): LandedCommit[] {
  // `%H %P %s` — oid, parent oids, subject. Oldest first so the revert plan
  // can be emitted newest-first by reversing it.
  const raw = git(repo, ['log', '--reverse', '--format=%H%x00%P%x00%s', `${beforeHead}..${afterHead}`]);
  if (raw === null || raw.length === 0) return [];
  const commits: LandedCommit[] = [];
  for (const line of raw.split('\n')) {
    const [sha, parents, subject] = line.split('\0');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    commits.push({
      sha,
      subject: (subject ?? '').slice(0, 200),
      isMerge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }
  return commits;
}

/**
 * Which enrolled repos moved between two snapshots.
 *
 * A repo present in `before` but unreadable in `after` (or vice versa) is NOT
 * treated as "nothing happened" — it is reported as a landing with an empty
 * commit list so the caller fails safe rather than assuming quiet.
 */
export function detectLandings(
  before: RepoHeadSnapshot[],
  after: RepoHeadSnapshot[],
): { landings: PostMergeLanding[]; unreadable: PostMergeFailure[] } {
  const beforeByRepo = new Map(before.map((s) => [s.repo, s]));
  const landings: PostMergeLanding[] = [];
  const unreadable: PostMergeFailure[] = [];

  for (const now of after) {
    const then = beforeByRepo.get(now.repo);
    // A repo enrolled DURING the tick has no 'before'. Nothing can be said to
    // have landed in it during this iteration, so it is not a landing.
    if (!then) continue;
    if (then.head === null || now.head === null) {
      unreadable.push({
        repo: now.repo,
        kind: 'git',
        command: 'git rev-parse HEAD',
        detail: now.unreadable ?? then.unreadable ?? 'repository head unreadable',
      });
      continue;
    }
    if (then.head === now.head) continue;

    const commits = parseLandedCommits(now.repo, then.head, now.head);
    landings.push({
      repo: now.repo,
      beforeHead: then.head,
      afterHead: now.head,
      commits,
      revertCommand: revertCommandFor(then.head, now.head, commits),
    });
  }
  return { landings, unreadable };
}

/**
 * The exact command that backs a landing out.
 *
 * A single merge commit — which is what `inbox/merge.mergeLocally` produces,
 * a two-parent `commit-tree` against the verified base — reverts with
 * `git revert -m 1 <oid>`. Several commits revert newest-first. A landing whose
 * commits could not be listed falls back to resetting the branch to the exact
 * OID it had before the iteration, which is always correct for a local-only
 * merge that was never pushed (and `inbox/merge` never pushes: host auto-merge
 * is disabled and returns a handoff instead).
 */
export function revertCommandFor(
  beforeHead: string,
  afterHead: string,
  commits: LandedCommit[],
): string {
  if (commits.length === 0) {
    return `git reset --hard ${beforeHead}  # was ${afterHead}`;
  }
  const newestFirst = [...commits].reverse();
  return newestFirst
    .map((c) => `git revert --no-edit ${c.isMerge ? '-m 1 ' : ''}${c.sha}`)
    .join(' && ');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Re-run each landed-on repo's OWN required verify commands against the MERGED
 * head, and decide whether the run may continue.
 *
 * Fast in the common case: when no enrolled repo moved, this is one
 * `git rev-parse` per repo and returns `no-landing` without running anything.
 * The expensive path only runs when something actually merged, which is exactly
 * when it is worth paying for.
 *
 * `halt` is true for `regressed` and `unverifiable` and for nothing else.
 * Never throws.
 */
export async function runPostMergeGate(
  before: RepoHeadSnapshot[],
  after: RepoHeadSnapshot[],
  cfg: AshlrConfig,
  seams: PostMergeGateSeams & { signal?: AbortSignal } = {},
): Promise<PostMergeGateResult> {
  const now = seams.now ?? Date.now;
  const startedAtMs = now();
  const detect = seams.detect ?? detectVerifyCommands;
  const run = seams.run ?? runVerifyCommandAsync;

  const finish = (
    verdict: PostMergeVerdict,
    landings: PostMergeLanding[],
    failures: PostMergeFailure[],
    ranCommands: number,
    detail: string,
  ): PostMergeGateResult => ({
    verdict,
    halt: verdict === 'regressed' || verdict === 'unverifiable',
    landings,
    failures,
    ranCommands,
    detail,
    revertPlan: landings.map((l) => l.revertCommand),
    durationMs: Math.max(0, now() - startedAtMs),
  });

  let landings: PostMergeLanding[];
  let unreadable: PostMergeFailure[];
  try {
    ({ landings, unreadable } = detectLandings(before, after));
  } catch (error) {
    const detail = `post-merge gate could not compare repository heads: ${errText(error)}`;
    return finish('unverifiable', [], [{
      repo: '(unknown)', kind: 'git', command: 'git rev-parse HEAD', detail,
    }], 0, detail);
  }

  if (unreadable.length > 0) {
    // FAIL SAFE. An enrolled repo we cannot read may have taken a merge we
    // cannot see. Continuing would be iteration N+1 on an unknown tree.
    const detail =
      `post-merge gate cannot read ${unreadable.length} enrolled repo(s) ` +
      `(${unreadable.map((f) => f.repo).join(', ')}); the run cannot prove what landed`;
    return finish('unverifiable', landings, unreadable, 0, detail);
  }

  if (landings.length === 0) {
    return finish('no-landing', [], [], 0, 'no enrolled repository head moved this iteration');
  }

  const failures: PostMergeFailure[] = [];
  let ranCommands = 0;
  let unverifiable = false;

  for (const landing of landings) {
    if (seams.signal?.aborted) {
      // A shutdown mid-verification has NOT proven the merge good. Halt.
      const detail = `post-merge verification was interrupted for ${landing.repo}; the merge is unproven`;
      failures.push({ repo: landing.repo, kind: 'harness', command: '(interrupted)', detail });
      return finish('unverifiable', landings, failures, ranCommands, detail);
    }

    // ── UNPROVABLE: a dirty tree ─────────────────────────────────────────
    // Checked BEFORE the suite runs, because a suite run against a dirty tree
    // is not cheap and not meaningful.
    //
    // The whole overnight safety property is "post-merge verification halts
    // the run before a regression compounds". If that verification can be
    // silently invalid, the property is void — and this is the one failure
    // mode where the gate says GREEN and is wrong, which is strictly worse
    // than a false halt. A tree carrying uncommitted edits measures the
    // operator's work-in-progress, not the merge.
    //
    // This is NOT the gate being harsh about a change. Being un-harsh governs
    // how we judge a diff; it says nothing about whether the evidence is
    // sound. A dirty tree sits in the same category as a repo with no
    // required verify command and a repo whose HEAD cannot be read: the gate
    // is not refusing the change, it is refusing to pretend it proved one.
    const dirt = workingTreeDirt(landing.repo);
    if (dirt !== null) {
      failures.push({
        repo: landing.repo,
        kind: 'dirty-tree',
        command: 'git status --porcelain',
        detail: `the working tree holds ${dirt}, so a post-merge run there would measure those ` +
          `and not the merge — the result cannot be trusted either way`,
      });
      unverifiable = true;
      continue;
    }

    let commands: VerifyCommand[];
    try {
      commands = detect(landing.repo, 'merge');
    } catch (error) {
      failures.push({
        repo: landing.repo, kind: 'detection', command: 'detectVerifyCommands',
        detail: `verify-command detection threw: ${errText(error)}`,
      });
      unverifiable = true;
      continue;
    }

    const required = commands.filter((c) => c.required !== false);
    if (required.length === 0) {
      // Same fail-closed direction as the PRE-merge gate, which refuses a repo
      // with no required command unless allowWithoutVerification is set. A
      // merge that landed in a repo that can no longer prove itself is not
      // something to keep building on for another six hours.
      failures.push({
        repo: landing.repo, kind: 'detection', command: 'detectVerifyCommands',
        detail: 'no REQUIRED verify command detected after the merge — the landing cannot be proven good',
      });
      unverifiable = true;
      continue;
    }

    for (const command of required) {
      if (seams.signal?.aborted) {
        const detail = `post-merge verification was interrupted for ${landing.repo}; the merge is unproven`;
        failures.push({ repo: landing.repo, kind: 'harness', command: '(interrupted)', detail });
        return finish('unverifiable', landings, failures, ranCommands, detail);
      }
      let result: Awaited<ReturnType<typeof runVerifyCommandAsync>>;
      try {
        ranCommands++;
        result = await run(command, landing.repo, cfg, {
          ...(seams.signal ? { signal: seams.signal } : {}),
        });
      } catch (error) {
        // A command that could not be EXECUTED proves nothing about the diff.
        // Classified as 'harness' so it halts as unverifiable rather than as a
        // regression the merge did not necessarily cause.
        failures.push({
          repo: landing.repo, kind: 'harness', command: command.cmd.join(' '),
          detail: `verify command could not be run: ${errText(error)}`,
        });
        unverifiable = true;
        continue;
      }
      if (!result.ok) {
        failures.push({
          repo: landing.repo,
          kind: command.kind,
          command: result.command || command.cmd.join(' '),
          // Metadata only — command OUTPUT never reaches an audit summary.
          detail: result.timedOut
            ? `timed out after the merge`
            : `failed after the merge (exit ${result.exitCode}` +
              `${result.failureCategory ? `, ${result.failureCategory}` : ''})`,
        });
      }
    }
  }

  const merged = landings.reduce((n, l) => n + Math.max(1, l.commits.length), 0);
  // Only a check that actually RAN and came back red is a regression.
  const red = failures.filter((f) => !NON_REGRESSION_KINDS.has(f.kind));
  if (red.length > 0) {
    return finish('regressed', landings, failures, ranCommands,
      `POST-MERGE REGRESSION: ${red.length} required check(s) RED in ` +
      `${new Set(red.map((f) => f.repo)).size} repo(s) after ${merged} landed commit(s); run halted`);
  }
  if (unverifiable) {
    const dirty = failures.filter((f) => f.kind === 'dirty-tree');
    return finish('unverifiable', landings, failures, ranCommands,
      `POST-MERGE UNPROVABLE: landing could not be verified in ` +
      `${new Set(failures.map((f) => f.repo)).size} repo(s)` +
      (dirty.length > 0
        ? ` (${dirty.length} with a dirty working tree — the verdict would have measured ` +
          `uncommitted edits, not the merge)`
        : '') +
      `; run halted rather than built upon`);
  }
  return finish('clean', landings, failures, ranCommands,
    `post-merge suite green: ${ranCommands} required check(s) across ` +
    `${landings.length} repo(s) after ${merged} landed commit(s)`);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The halt record — a bad night must cost one revert, not archaeology
// ---------------------------------------------------------------------------

export function postMergeHaltDir(): string {
  return join(homedir(), '.ashlr', 'run-window');
}

/**
 * Persist the halt durably (exclusive tmp + atomic rename) and audit it.
 * Returns the record path, or null when it could not be written — a write
 * failure must never itself throw out of the loop's shutdown path.
 */
export function recordPostMergeHalt(
  result: PostMergeGateResult,
  opts: { now?: () => number } = {},
): string | null {
  if (!result.halt) return null;
  const nowMs = (opts.now ?? Date.now)();
  const record: PostMergeHaltRecord = {
    recordType: 'daemon-post-merge-halt',
    haltedAt: new Date(nowMs).toISOString(),
    verdict: result.verdict as PostMergeHaltRecord['verdict'],
    detail: result.detail,
    landings: result.landings,
    failures: result.failures,
    revertPlan: result.revertPlan,
  };
  let path: string | null = null;
  try {
    const dir = postMergeHaltDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    path = join(dir, `halt-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}.json`);
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* the rename already consumed it */ }
      throw error;
    }
    void dirname(path);
  } catch {
    path = null;
  }
  try {
    audit({
      action: 'daemon:post-merge-halt',
      repo: result.landings[0]?.repo ?? null,
      sandboxId: null,
      summary: `${result.detail}${result.revertPlan.length > 0
        ? ` — revert with: ${result.revertPlan.join(' ; ')}`
        : ''}`,
      result: 'refused',
    });
  } catch {
    // audit() swallows its own errors; this covers a thrown path resolution.
  }
  return path;
}

/** Read halt records back, newest first. Best-effort; never throws. */
export function readPostMergeHalts(limit = 20): PostMergeHaltRecord[] {
  try {
    const dir = postMergeHaltDir();
    const names = readdirSync(dir)
      .filter((n) => n.startsWith('halt-') && n.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, Math.max(0, limit));
    const out: PostMergeHaltRecord[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PostMergeHaltRecord;
        if (parsed?.recordType === 'daemon-post-merge-halt') out.push(parsed);
      } catch { /* a malformed record is skipped, never fatal */ }
    }
    return out;
  } catch {
    return [];
  }
}

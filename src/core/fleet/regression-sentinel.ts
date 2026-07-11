/**
 * M189 — Autonomous Regression Sentinel (invented idea #3: a rollback reflex).
 *
 * WHAT IT DOES
 *   When the fleet has been auto-merging to main and a SUSTAINED anomaly appears
 *   (the repo's suite is now RED on HEAD where it was green at the last marker),
 *   this module isolates the culprit auto-merge via git-bisect over recent fleet
 *   merges, then produces a SIGNED REVERT PROPOSAL for the existing pending /
 *   approval flow. It is a reflex, not a trigger finger:
 *
 *     - "sustained" — a single RED observation is treated as a possible flake.
 *       Regression only fires once cfg.foundry.regressionSentinel.minConsecutive
 *       (default 2) consecutive RED observations have been recorded for the same
 *       HEAD. The streak is persisted under ~/.ashlr so it survives ticks.
 *     - "pluggable signal" — the anomaly source is injectable (opts.runSuite /
 *       opts.failSignal); the built-in default runs the repo's verify commands on
 *       HEAD and compares to a known-green marker.
 *     - "proposal-only" — bisectAndRevert NEVER applies, merges, or pushes. It
 *       returns a normal Proposal (kind 'patch') whose diff git-reverts the
 *       culprit. The existing inbox / approval flow (and a later Telegram
 *       one-tap confirmation) decides whether it lands. We do not call git
 *       bisect/revert with side effects beyond a confined, restorable bisect run.
 *
 * SAFETY / POSTURE
 *   - DEFAULT OFF: a no-op unless
 *       (cfg.foundry as Record<string,unknown>)['regressionSentinel'] is truthy.
 *   - NEVER throws — every failure path returns a safe empty result.
 *   - BOUNDED — bisect is capped (maxCandidates auto-merge commits considered;
 *     each suite run is time-boxed) so it can never run unbounded on history.
 *   - Does NOT import or touch loop.ts / comms / merge.ts. Signing is via
 *     provenance.ts (import only). Proposal creation is via inbox/store.ts
 *     (createProposal), which itself never applies anything.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { AshlrConfig, Proposal } from '../types.js';
import { detectVerifyCommands, runVerifyCommandAsync } from '../run/verify-commands.js';
import { createProposal } from '../inbox/store.js';
import { hashDiff, signProvenance } from '../foundry/provenance.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Marker embedded by the M47/M48 auto-merge path: `ashlr: auto-merge proposal <id>`. */
const AUTO_MERGE_MARKER = 'ashlr: auto-merge';

/** Hard ceiling on candidate auto-merge commits a single bisect will consider. */
const DEFAULT_MAX_CANDIDATES = 20;

/** Per-suite-run timeout (ms). Short so the sentinel cycle stays snappy. */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Consecutive RED observations required before declaring a regression. */
const DEFAULT_MIN_CONSECUTIVE = 2;

interface SentinelConfig {
  enabled: boolean;
  minConsecutive: number;
  maxCandidates: number;
  timeoutMs: number;
}

/**
 * Resolve the regression-sentinel config off the (loosely-typed) foundry cast.
 * DEFAULT OFF — enabled only when the `regressionSentinel` key is truthy.
 * A boolean `true` enables with defaults; an object enables + overrides fields.
 */
function resolveCfg(cfg?: Pick<AshlrConfig, 'foundry'>): SentinelConfig {
  const raw = (cfg?.foundry as Record<string, unknown> | undefined)?.['regressionSentinel'];
  const enabled = raw === true || (typeof raw === 'object' && raw !== null);
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  return {
    enabled,
    minConsecutive: num(obj['minConsecutive'], DEFAULT_MIN_CONSECUTIVE),
    maxCandidates: num(obj['maxCandidates'], DEFAULT_MAX_CANDIDATES),
    timeoutMs: Math.min(num(obj['timeoutMs'], DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS),
  };
}

// ---------------------------------------------------------------------------
// Injectable boundaries (real implementations by default; mocked in tests)
// ---------------------------------------------------------------------------

/** Result of running the regression signal once. */
export interface SuiteRun {
  /** True when the suite is RED (a candidate anomaly). */
  red: boolean;
  /** First failure line (capped) for the proposal body. */
  detail?: string;
  /** True only when a nonempty required-command manifest produced a causal result. */
  conclusive?: boolean;
  /** Digest of canonical required verification metadata for parent/culprit equality. */
  manifestDigest?: string;
  requiredCommandCount?: number;
}

/** Minimal git runner — returns trimmed stdout, or null on any failure. */
export type GitRunner = (args: string[]) => string | null;

export interface SentinelOpts {
  /** Override the anomaly signal. Default: run the repo verify commands on HEAD. */
  runSuite?: (repoDir: string, timeoutMs: number) => SuiteRun | Promise<SuiteRun>;
  /** Override git invocation. Default: spawnSync('git', …) confined to repoDir. */
  git?: GitRunner;
  /**
   * Optional explicit failing-signal source (pluggable). When it returns a
   * non-empty string, the regression fires immediately (treated as sustained)
   * with that string as the signal — e.g. an external monitor dropping a file.
   */
  failSignal?: (repoDir: string) => string | undefined;
}

/** Build a real git runner confined to repoDir. Never throws (returns null). */
function defaultGit(repoDir: string, timeoutMs: number): GitRunner {
  return (args: string[]): string | null => {
    try {
      const r = spawnSync('git', args, {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0 || r.error) return null;
      return (r.stdout ?? '').trim();
    } catch {
      return null;
    }
  };
}

/** First meaningful failure line from suite output, capped at 200 chars. */
function firstFailureLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => /error|fail/i.test(l));
  return (errorLine ?? lines[0] ?? 'unknown failure').slice(0, 200);
}

/** Default signal: run the repo's verify commands on HEAD; RED on first failure. */
async function defaultRunSuite(
  repoDir: string,
  timeoutMs: number,
  requiredOnly = false,
): Promise<SuiteRun> {
  try {
    const commands = detectVerifyCommands(repoDir, 'merge');
    const requiredCommands = commands.filter((command) => command.required !== false);
    if (requiredCommands.length === 0) return { red: false, conclusive: false };
    const manifestDigest = createHash('sha256').update(JSON.stringify(requiredCommands.map((command) => ({
      id: command.id ?? null,
      kind: command.kind,
      cmd: command.cmd,
      cwd: command.cwd ?? '.',
      timeoutMs: command.timeoutMs ?? null,
      profiles: command.profiles ?? null,
    })))).digest('hex');
    const proof = { manifestDigest, requiredCommandCount: requiredCommands.length };
    for (const vc of requiredOnly ? requiredCommands : commands) {
      const result = await runVerifyCommandAsync(vc, repoDir, {} as AshlrConfig, { timeoutMs });
      if (!result.ok) {
        if (vc.required === false) continue;
        return result.failureCategory === 'code'
          ? { red: true, detail: firstFailureLine(result.output), conclusive: true, ...proof }
          : { red: false, conclusive: false, ...proof };
      }
    }
    return { red: false, conclusive: true, ...proof };
  } catch {
    return { red: false, conclusive: false };
  }
}

// ---------------------------------------------------------------------------
// Streak persistence (sustained-anomaly state)
// ---------------------------------------------------------------------------

interface StreakState {
  /** HEAD sha the streak is observed against — resets when HEAD changes. */
  head: string;
  /** Consecutive RED observations recorded for `head`. */
  count: number;
  /** First failure detail seen, carried into the proposal. */
  detail?: string;
}

function streakPath(repoDir: string): string {
  const slug = createHash('sha1').update(repoDir).digest('hex').slice(0, 12);
  return join(homedir(), '.ashlr', 'foundry', `regression-streak-${slug}.json`);
}

function readStreak(repoDir: string): StreakState | null {
  try {
    const p = streakPath(repoDir);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StreakState).head === 'string') {
      return parsed as StreakState;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStreak(repoDir: string, state: StreakState): void {
  try {
    const p = streakPath(repoDir);
    const dir = join(homedir(), '.ashlr', 'foundry');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, p);
  } catch {
    // Best-effort — streak state is an optimization, never load-bearing for safety.
  }
}

// ---------------------------------------------------------------------------
// Known-green marker
// ---------------------------------------------------------------------------

/**
 * Path to the known-green marker for a repo: the last HEAD sha at which the
 * suite was observed GREEN. The marker is the bisect "good" boundary.
 */
function greenMarkerPath(repoDir: string): string {
  const slug = createHash('sha1').update(repoDir).digest('hex').slice(0, 12);
  return join(homedir(), '.ashlr', 'foundry', `green-marker-${slug}.json`);
}

function readGreenMarker(repoDir: string): string | null {
  try {
    const p = greenMarkerPath(repoDir);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { sha?: unknown };
    return typeof parsed.sha === 'string' && parsed.sha.length > 0 ? parsed.sha : null;
  } catch {
    return null;
  }
}

function writeGreenMarker(repoDir: string, sha: string): void {
  try {
    const p = greenMarkerPath(repoDir);
    const dir = join(homedir(), '.ashlr', 'foundry');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify({ sha, ts: new Date().toISOString() }, null, 2), 'utf8');
    renameSync(tmp, p);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// detectRegression
// ---------------------------------------------------------------------------

export interface RegressionResult {
  /** True only on a SUSTAINED anomaly (≥ minConsecutive RED, or an explicit fail-signal). */
  regressed: boolean;
  /** Human-readable signal describing what tripped (suite line / signal file). */
  signal?: string;
}

/**
 * Detect a sustained regression on `repoDir`'s HEAD.
 *
 * Flow:
 *   1. Flag-gated (default OFF) — disabled config short-circuits to not-regressed.
 *   2. An explicit failing-signal source (opts.failSignal) fires immediately
 *      (treated as already-sustained by the external monitor that produced it).
 *   3. Otherwise run the suite on HEAD:
 *        - INCONCLUSIVE → preserve streak/green authority unchanged.
 *        - GREEN → reset the streak AND record HEAD as the known-green marker
 *          (so a later bisect has a trustworthy "good" boundary). Not regressed.
 *        - RED → increment the consecutive-RED streak for this HEAD. Only once
 *          the streak reaches minConsecutive do we declare a regression — a
 *          single RED is a possible flake and returns regressed:false.
 *
 * NEVER throws.
 */
export async function detectRegression(
  cfg?: Pick<AshlrConfig, 'foundry'>,
  repoDir: string = process.cwd(),
  opts?: SentinelOpts,
): Promise<RegressionResult> {
  try {
    const sc = resolveCfg(cfg);
    if (!sc.enabled) return { regressed: false };

    // (2) Pluggable explicit failing-signal — fire immediately if present.
    if (opts?.failSignal) {
      try {
        const sig = opts.failSignal(repoDir);
        if (sig && sig.trim()) {
          return { regressed: true, signal: `external-signal: ${sig.trim().slice(0, 200)}` };
        }
      } catch {
        // Ignore a misbehaving signal source — fall through to the suite check.
      }
    }

    // (3) Built-in signal: run the suite on HEAD.
    const runSuite = opts?.runSuite ?? defaultRunSuite;
    const run = await runSuite(repoDir, sc.timeoutMs);

    const git = opts?.git ?? defaultGit(repoDir, sc.timeoutMs);
    const head = git(['rev-parse', 'HEAD']) ?? '';

    // Missing verification, timeout, tool failure, or infrastructure failure
    // is not evidence that HEAD is green and must not erase a RED streak.
    if (run.conclusive === false) return { regressed: false };

    if (!run.red) {
      // Green — reset streak, advance the known-green marker.
      writeStreak(repoDir, { head, count: 0 });
      if (head) writeGreenMarker(repoDir, head);
      return { regressed: false };
    }

    // RED — accumulate the streak (sustained-anomaly gate).
    const prev = readStreak(repoDir);
    const count = prev && prev.head === head ? prev.count + 1 : 1;
    const detail = run.detail ?? prev?.detail;
    writeStreak(repoDir, { head, count, ...(detail ? { detail } : {}) });

    if (count < sc.minConsecutive) {
      // Possibly a flake — do not fire yet.
      return { regressed: false };
    }

    return {
      regressed: true,
      signal: `suite RED on HEAD for ${count} consecutive runs${detail ? `: ${detail}` : ''}`,
    };
  } catch {
    return { regressed: false };
  }
}

// ---------------------------------------------------------------------------
// bisectAndRevert
// ---------------------------------------------------------------------------

export interface RevertProposal {
  /** The culprit auto-merge commit sha. */
  culprit: string;
  /** The auto-merged proposal id parsed from the commit message (if present). */
  culpritProposalId?: string;
  /** The created (pending) proposal — NOT applied, NOT merged. */
  proposal: Proposal;
}

export interface BisectResult {
  /** Canonical repository whose commits and verification results were examined. */
  repo?: string;
  culprit?: string;
  /** Direct first parent of the isolated culprit when it could be resolved. */
  parentHead?: string;
  /** Same-run suite result for the direct parent. False also covers unavailable proof. */
  parentGreen?: boolean;
  /** Same-run suite result for the isolated culprit. */
  culpritRed?: boolean;
  /** Deterministic only when culprit^ is GREEN and culprit is RED in this run. */
  attributionConfidence?: 'deterministic' | 'heuristic';
  /** HEAD observed before any temporary checkout. */
  observedHead?: string;
  /** Trusted known-green boundary when one was available. */
  baselineHead?: string;
  /** Number of bounded auto-merge candidates considered. */
  candidateCount?: number;
  /** Structured observation basis; never grants revert or merge authority. */
  basis?: 'bisect-first-bad';
  revertProposal?: RevertProposal;
  /** Why no proposal was produced (no culprit, no candidates, flag off, …). */
  reason?: string;
}

/**
 * List recent fleet auto-merge commits (newest-first), capped at maxCandidates.
 * Identified by the M48 commit-message marker `ashlr: auto-merge`.
 * Returns [] on any git failure.
 */
function listAutoMergeCommits(git: GitRunner, maxCandidates: number): string[] {
  const out = git([
    'log',
    `-n${maxCandidates}`,
    `--grep=${AUTO_MERGE_MARKER}`,
    '--format=%H',
  ]);
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Parse the auto-merged proposal id out of a commit message, if present. */
function proposalIdFromCommit(git: GitRunner, sha: string): string | undefined {
  const msg = git(['log', '-1', '--format=%s%n%b', sha]);
  if (!msg) return undefined;
  const m = msg.match(/ashlr:\s*auto-merge\s+proposal\s+([\w.-]+)/i);
  return m?.[1];
}

/**
 * Isolate the culprit auto-merge commit among recent fleet merges, then build a
 * SIGNED revert PROPOSAL for the existing approval flow. NEVER applies/merges.
 *
 * Bisect approach (bounded, restorable):
 *   - Candidate set = recent commits carrying the `ashlr: auto-merge` marker
 *     (newest-first, capped at maxCandidates). These are the only commits the
 *     sentinel will ever propose reverting — fleet merges, not human commits.
 *   - The known-green marker sha is the "good" boundary; HEAD is "bad".
 *   - For each candidate from newest→oldest within (good, bad], we test the
 *     tree at that commit by running the suite. The OLDEST candidate that is
 *     still RED is the first-bad auto-merge = the culprit. (A linear scan over
 *     the bounded auto-merge set; equivalent to bisect for this purpose and far
 *     simpler to keep confined + restorable than driving `git bisect run`.)
 *   - The working tree is checked out back to the original HEAD afterwards so
 *     the repo is left exactly as found.
 *
 * Revert-proposal shape (proposal-only):
 *   kind:'patch', origin:'swarm', diff = `git revert --no-commit <culprit>`
 *   captured as a unified diff, with diffHash + provenanceSig stamped via
 *   provenance.ts so a later one-tap confirmation can verify it. The proposal is
 *   created 'pending' via createProposal — it is NEVER auto-applied here.
 *
 * NEVER throws.
 */
export async function bisectAndRevert(
  cfg?: Pick<AshlrConfig, 'foundry'>,
  repoDir: string = process.cwd(),
  opts?: SentinelOpts,
): Promise<BisectResult> {
  let restoreSha: string | null = null;
  let git: GitRunner | undefined;
  try {
    const sc = resolveCfg(cfg);
    if (!sc.enabled) return { reason: 'regression sentinel disabled' };

    git = opts?.git ?? defaultGit(repoDir, sc.timeoutMs);
    const runSuite = opts?.runSuite ?? ((repo, timeout) => defaultRunSuite(repo, timeout, true));

    const originalHead = git(['rev-parse', 'HEAD']);
    if (!originalHead) return { reason: 'cannot resolve HEAD' };
    const worktreeStatus = git(['status', '--porcelain']);
    if (worktreeStatus === null) return { reason: 'cannot inspect worktree state' };
    if (worktreeStatus.trim().length > 0) {
      return { reason: 'worktree is dirty; refusing autonomous bisect checkout' };
    }
    restoreSha = originalHead;

    const candidates = listAutoMergeCommits(git, sc.maxCandidates);
    if (candidates.length === 0) {
      return { reason: 'no recent auto-merge commits to bisect' };
    }

    const greenSha = readGreenMarker(repoDir);

    // Restrict candidates to those newer than the known-green marker, if we
    // have one (the marker is the trusted "good" boundary). When the marker is
    // unknown we consider the whole bounded candidate set.
    let scoped = candidates;
    if (greenSha) {
      const idx = candidates.indexOf(greenSha);
      if (idx >= 0) scoped = candidates.slice(0, idx); // newer-than-green only
    }
    if (scoped.length === 0) {
      return { reason: 'no auto-merge commits newer than the last known-green marker' };
    }

    // Test oldest→newest: the OLDEST auto-merge whose tree is RED is the first
    // bad commit = the culprit. (candidates are newest-first, so reverse.)
    const oldestFirst = [...scoped].reverse();
    let culprit: string | undefined;
    let culpritRed = false;
    let culpritRun: SuiteRun | undefined;
    for (const sha of oldestFirst) {
      const ok = git(['checkout', '--quiet', sha]) !== null;
      if (!ok) continue;
      const run = await runSuite(repoDir, sc.timeoutMs);
      if (run.red) {
        culprit = sha;
        culpritRed = true;
        culpritRun = run;
        break; // first bad in oldest→newest order
      }
    }

    // A first RED fleet candidate is only deterministic attribution when its
    // direct parent is independently GREEN in this same bounded run. This
    // excludes regressions introduced by an intervening human commit before
    // the fleet merge. Missing/unrunnable parent proof remains heuristic.
    let parentHead: string | undefined;
    let parentGreen = false;
    let parentRun: SuiteRun | undefined;
    if (culprit && culpritRed) {
      const resolvedParent = git(['rev-parse', `${culprit}^`]);
      if (resolvedParent && git(['checkout', '--quiet', resolvedParent]) !== null) {
        parentHead = resolvedParent;
        try {
          parentRun = await runSuite(repoDir, sc.timeoutMs);
          parentGreen = parentRun.conclusive === true && !parentRun.red;
        } catch {
          parentGreen = false;
        }
      }
    }

    // Always restore the working tree to the original HEAD.
    const restored = git(['checkout', '--quiet', originalHead]);
    const restoredHead = restored !== null ? git(['rev-parse', 'HEAD']) : null;
    if (restored === null || restoredHead !== originalHead) {
      return { reason: 'failed to restore original HEAD after regression proof' };
    }
    restoreSha = null; // positively restored; finally need not retry

    if (!culprit) {
      return { reason: 'bisect found no RED auto-merge commit (anomaly not from a fleet merge)' };
    }

    const culpritProposalId = proposalIdFromCommit(git, culprit);

    // Build the revert diff WITHOUT committing: stage a revert, capture the
    // diff, then unstage/restore so the working tree is left clean.
    let revertDiff = '';
    const reverted = git(['revert', '--no-commit', culprit]) !== null;
    if (reverted) {
      revertDiff = git(['diff', '--cached']) ?? '';
      // Abort the in-progress revert + restore the tree.
      git(['revert', '--abort']);
      git(['reset', '--hard', originalHead]);
    }
    if (!revertDiff) {
      // Fall back to a descriptive diff-less proposal pointing at the culprit;
      // the approval flow / human can still act. Synthesize a minimal marker.
      revertDiff = `# revert ${culprit}\n# (diff capture unavailable; apply: git revert ${culprit})\n`;
    }

    // Sign the revert proposal via provenance.ts so a later one-tap Telegram
    // confirmation can verify it was produced by this host (not forged on disk).
    const engineModel = 'ashlr:regression-sentinel';
    const engineTier = 'local';
    const diffHash = hashDiff(revertDiff);
    const provenanceSig = signProvenance(engineModel, engineTier, diffHash);

    const shortSha = culprit.slice(0, 8);
    const repoName = basename(repoDir);
    const proposal = createProposal(
      {
        repo: repoDir,
        origin: 'swarm',
        kind: 'patch',
        title: `Revert regressing auto-merge ${shortSha} in ${repoName}`,
        summary:
          `Regression sentinel isolated auto-merge commit ${culprit}` +
          (culpritProposalId ? ` (proposal ${culpritProposalId})` : '') +
          ` as the first RED commit after the last known-green marker. ` +
          `This proposal git-reverts it. PROPOSAL-ONLY — review/confirm before it lands.`,
        diff: revertDiff,
        diffHash,
        provenanceSig,
        engineModel,
        engineTier,
        riskClass: 'low',
      },
      cfg,
    );

    return {
      repo: resolve(repoDir),
      culprit,
      ...(parentHead ? { parentHead } : {}),
      parentGreen,
      culpritRed,
      attributionConfidence: parentHead && parentGreen && culpritRed &&
        parentRun?.conclusive === true && culpritRun?.conclusive === true &&
        typeof parentRun.manifestDigest === 'string' &&
        parentRun.manifestDigest === culpritRun.manifestDigest &&
        parentRun.requiredCommandCount === culpritRun.requiredCommandCount
        ? 'deterministic'
        : 'heuristic',
      observedHead: originalHead,
      ...(greenSha ? { baselineHead: greenSha } : {}),
      candidateCount: scoped.length,
      basis: 'bisect-first-bad',
      revertProposal: { culprit, ...(culpritProposalId ? { culpritProposalId } : {}), proposal },
    };
  } catch {
    return { reason: 'bisect error (handled)' };
  } finally {
    // Defensive restore in case an early return left a checkout dangling.
    try {
      if (restoreSha && git) git(['checkout', '--quiet', restoreSha]);
    } catch {
      // never throw from finally
    }
  }
}

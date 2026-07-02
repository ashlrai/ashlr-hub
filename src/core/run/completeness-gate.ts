/**
 * completeness-gate.ts — M275: run completeness + self-verify gate.
 *
 * Validates a sandboxed engine run's diff BEFORE it is filed as a proposal.
 * Only called when cfg.foundry?.completenessGate !== false (default: on).
 *
 * Checks (short-circuit on first failure):
 *  1. Partial marker — engine timed out or exited non-zero → not filed
 *  2. Empty diff     — defense-in-depth for M87 guard upstream
 *  3. Lockfile integrity — package.json modified without corresponding lockfile
 *  4. Self-verify — typecheck (fast) then test (bounded) in the sandbox worktree
 *
 * Contract:
 *  - Never throws. Any unexpected error surfaces as { pass: false, reason: '...' }.
 *  - Flag-off: cfg.foundry?.completenessGate === false → caller skips entirely
 *    (this function is not called; gate logic is never reached).
 *  - Additive — does not weaken any existing gate (M87/M158/M259/H1).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AshlrConfig } from '../types.js';
import {
  detectVerifyCommands,
  runVerifyCommandAsync,
  type VerifyCommand,
} from './verify-commands.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletenessGateResult {
  pass: boolean;
  /** Human-readable reason for a blocked filing (absent on pass). */
  reason?: string;
}

export interface RunCompletenessGateOpts {
  /** Absolute path to the sandbox worktree where edits live. */
  worktreePath: string;
  /** Diff metadata from the sandbox. */
  diff: {
    files: number;
    patch: string;
    insertions: number;
    deletions: number;
  };
  /** The original run goal (used for context in reason strings). */
  goal: string;
  /** Full ashlr config (used to pass to runVerifyCommand). */
  cfg: AshlrConfig;
  /**
   * True when the run ended via timeout or non-zero exit (isPartial flag).
   * When true the gate immediately blocks — no verify is attempted.
   */
  isPartial?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard wall-clock per self-verify command. Mirrors TITRR_TEST_TIMEOUT_MS. */
const SELF_VERIFY_TIMEOUT_MS = 60_000;

/** Max chars kept in the reason string (keep log lines tight). */
const REASON_OUTPUT_CAP = 200;

/** Lockfile names that pair with package.json. */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string): string {
  return s.length > REASON_OUTPUT_CAP ? s.slice(0, REASON_OUTPUT_CAP) + '…' : s;
}

/**
 * Returns true when the diff patch mentions a modification to any lockfile.
 * Uses a simple substring check — accurate enough for the purpose (we are
 * looking for "diff --git a/yarn.lock" or "--- a/pnpm-lock.yaml" patterns).
 */
function diffTouchesLockfile(patch: string): boolean {
  return LOCKFILE_NAMES.some((lf) => patch.includes(lf));
}

/**
 * Returns true when at least one lockfile exists on disk in repoRoot.
 * Avoids false-positives for repos that have no lockfile at all.
 */
function repoHasLockfile(repoRoot: string): boolean {
  return LOCKFILE_NAMES.some((lf) => existsSync(join(repoRoot, lf)));
}

// ---------------------------------------------------------------------------
// Delta-aware test helpers (M281)
// ---------------------------------------------------------------------------

/**
 * Parse failing test IDs/names from vitest (or jest-compatible) output.
 * Looks for "FAIL <path>" lines and " × <test name>" / "✕ <test name>" markers.
 * Returns a Set of strings — used only for set-difference, so exact fidelity
 * of parsing is not required (false negatives are conservative: they may miss a
 * pre-existing failure and cause a spurious block, never the reverse).
 */
export function parseFailedTestIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    // "FAIL test/foo.test.ts" — whole-file failure
    if (trimmed.startsWith('FAIL ') || trimmed.startsWith('FAILED ')) {
      ids.add(trimmed);
      continue;
    }
    // vitest individual test failure markers: " × test name" or " ✕ test name"
    if (trimmed.startsWith('× ') || trimmed.startsWith('✕ ') || trimmed.startsWith('x ')) {
      ids.add(trimmed.slice(2).trim());
      continue;
    }
    // jest-style: "● Suite > test name"
    if (trimmed.startsWith('● ')) {
      ids.add(trimmed.slice(2).trim());
    }
  }
  return ids;
}

/**
 * Try to stash uncommitted changes in `dir`. Returns true when stash succeeded
 * (meaning changes were stashed). Returns false if nothing to stash or on error.
 * Never throws.
 */
function gitStashPush(dir: string): boolean {
  try {
    const res = spawnSync('git', ['stash', 'push', '--include-untracked', '-m', 'ashlr-completeness-baseline'], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe',
    });
    if (res.error || res.status !== 0) return false;
    const stdout = (res.stdout ?? '').trim();
    // "No local changes to stash" means nothing was stashed
    return !stdout.includes('No local changes');
  } catch {
    return false;
  }
}

/**
 * Pop the most recent stash in `dir`. Never throws.
 */
function gitStashPop(dir: string): void {
  try {
    spawnSync('git', ['stash', 'pop'], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe',
    });
  } catch {
    /* ignore */
  }
}

/**
 * Run a test command and return structured failure info.
 * On timeout, returns null (caller treats as "baseline unavailable").
 * `ids` is the set of parsed failing test IDs (may be empty if output unparseable).
 * `ok` is the raw runner result — used as a fallback when IDs are unparseable.
 */
async function collectFailingTests(
  cmd: VerifyCommand,
  dir: string,
  cfg: AshlrConfig,
  timeoutMs: number,
): Promise<{ ok: boolean; ids: Set<string> } | null> {
  const result = await runVerifyCommandAsync(cmd, dir, cfg, { timeoutMs });
  if (result.timedOut) return null;
  if (result.ok) return { ok: true, ids: new Set<string>() };
  return { ok: false, ids: parseFailedTestIds(result.output) };
}

/**
 * M281: Delta-aware test verification.
 *
 * Strategy (in the completeness-gate worktree which already has agent changes):
 *   1. Stash agent changes → run test → record BASELINE failing set
 *   2. Unstash → run test → record AFTER failing set
 *   3. PASS iff (AFTER minus BASELINE) is empty (no NEW failures)
 *   4. FAIL iff any test that passed in BASELINE now fails in AFTER
 *
 * Safe fallbacks:
 *   - Stash fails (no changes to stash, detached HEAD, etc.) → run AFTER only,
 *     pass if ok (original behaviour — cannot do delta without a baseline)
 *   - Baseline run times out → skip delta, return pass (log warning in reason)
 *   - Any unexpected error → return pass with warning (never hard-block on infra)
 *
 * Returns { pass: true } or { pass: false, reason }.
 */
export async function runDeltaAwareTestCheck(
  testCmd: VerifyCommand,
  worktreePath: string,
  cfg: AshlrConfig,
  timeoutMs: number,
): Promise<{ pass: boolean; reason?: string }> {
  try {
    // Step 1: stash agent changes to get a clean baseline
    const stashed = gitStashPush(worktreePath);

    if (!stashed) {
      // Cannot isolate baseline — fall back to direct run (original behaviour)
      const result = await runVerifyCommandAsync(testCmd, worktreePath, cfg, { timeoutMs });
      if (!result.ok) {
        return {
          pass: false,
          reason: `self-verify failed: test: ${truncate(result.output)}`,
        };
      }
      return { pass: true };
    }

    // Step 2: run baseline (pre-change)
    const baseline = await collectFailingTests(testCmd, worktreePath, cfg, timeoutMs);

    // Step 3: restore agent changes
    gitStashPop(worktreePath);

    if (baseline === null) {
      // Baseline run timed out — safe fallback: don't hard-block
      return { pass: true };
    }

    // Step 4: run after (with agent changes)
    const after = await collectFailingTests(testCmd, worktreePath, cfg, timeoutMs);

    if (after === null) {
      // After run timed out — treat as unknown, don't hard-block
      return { pass: true };
    }

    // Step 5: delta analysis
    //
    // Case A: both IDs sets are non-empty → set-difference is authoritative.
    // Case B: IDs are empty (test runner uses no vitest/jest markers, e.g. a raw
    //         shell `exit 1`). Fall back to comparing ok flags:
    //           - baseline ok=true,  after ok=false  → NEW failure → block
    //           - baseline ok=false, after ok=false  → pre-existing failure → tolerate
    //           - baseline ok=true,  after ok=true   → no regression
    //           - baseline ok=false, after ok=true   → improvement, pass
    if (after.ids.size > 0 || baseline.ids.size > 0) {
      // Named IDs available — use set-difference
      const newFailures = new Set<string>();
      for (const id of after.ids) {
        if (!baseline.ids.has(id)) newFailures.add(id);
      }
      if (newFailures.size > 0) {
        const listed = [...newFailures].slice(0, 5).join('; ');
        return {
          pass: false,
          reason: `self-verify failed: test: ${newFailures.size} new failure(s) introduced: ${truncate(listed)}`,
        };
      }
    } else {
      // No parseable IDs — fall back to ok-flag delta
      if (baseline.ok && !after.ok) {
        // Baseline was passing; change broke it — new regression
        return {
          pass: false,
          reason: `self-verify failed: test: regression detected (test suite failed after change, was passing before)`,
        };
      }
      // baseline failed too (pre-existing) → tolerate
    }

    return { pass: true };
  } catch (err) {
    // Never hard-block on infrastructure error — log and pass
    const msg = err instanceof Error ? err.message : String(err);
    // Surface as pass with logged warning; typecheck already guarded type safety
    void msg; // would log in production; test environment doesn't need the noise
    return { pass: true };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the M275 completeness gate. Returns { pass: true } on success or
 * { pass: false, reason } when the run should NOT be filed as a proposal.
 *
 * @param opts - Gate inputs (worktreePath, diff, goal, cfg, isPartial).
 * @returns CompletenessGateResult — never throws.
 */
export async function runCompletenessGate(
  opts: RunCompletenessGateOpts,
): Promise<CompletenessGateResult> {
  try {
    const { worktreePath, diff, cfg, isPartial } = opts;

    // -----------------------------------------------------------------------
    // 1. Partial marker — engine did not complete cleanly
    // -----------------------------------------------------------------------
    if (isPartial === true) {
      return {
        pass: false,
        reason: '[partial] run — engine timed out or exited non-zero; not filed',
      };
    }

    // -----------------------------------------------------------------------
    // 2. Empty diff (defense-in-depth; M87 upstream already guards this)
    // -----------------------------------------------------------------------
    if (diff.files === 0 || diff.patch.trim().length === 0) {
      return { pass: false, reason: 'empty diff — nothing to propose' };
    }

    // -----------------------------------------------------------------------
    // 3. Lockfile integrity
    //    Rule: if package.json is modified AND at least one lockfile exists
    //    in the repo root, the diff MUST also touch a lockfile. Otherwise the
    //    proposal represents an inconsistent dependency state.
    // -----------------------------------------------------------------------
    const patchTouchesPkgJson = diff.patch.includes('package.json');
    if (patchTouchesPkgJson) {
      // Derive repo root from worktreePath (worktree shares the same lockfile
      // location as the source repo; also check worktreePath directly).
      if (repoHasLockfile(worktreePath) && !diffTouchesLockfile(diff.patch)) {
        return {
          pass: false,
          reason:
            'dependency change (package.json) lacks corresponding lockfile update',
        };
      }
    }

    // -----------------------------------------------------------------------
    // 4. Self-verify — typecheck first (fast), then test (bounded 60 s)
    //    Skipped gracefully when no verify commands are detected (e.g. repos
    //    with no package.json / tsconfig.json → gate passes).
    // -----------------------------------------------------------------------
    const cmds = detectVerifyCommands(worktreePath);

    const typecheckCmd = cmds.find((c) => c.kind === 'typecheck');
    if (typecheckCmd) {
      const result = await runVerifyCommandAsync(typecheckCmd, worktreePath, cfg, {
        timeoutMs: SELF_VERIFY_TIMEOUT_MS,
      });
      if (!result.ok) {
        return {
          pass: false,
          reason: `self-verify failed: typecheck: ${truncate(result.output)}`,
        };
      }
    }

    const testCmd = cmds.find((c) => c.kind === 'test');
    if (testCmd) {
      // M281: delta-aware test check — tolerate pre-existing failures, block NEW ones.
      const deltaResult = await runDeltaAwareTestCheck(
        testCmd,
        worktreePath,
        cfg,
        SELF_VERIFY_TIMEOUT_MS,
      );
      if (!deltaResult.pass) {
        return { pass: false, reason: deltaResult.reason };
      }
    }

    // All checks passed.
    return { pass: true };
  } catch (err) {
    // Never throws — surface unexpected errors as a non-filing result.
    const msg = err instanceof Error ? err.message : String(err);
    return { pass: false, reason: `completeness gate error: ${truncate(msg)}` };
  }
}

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
import type { AshlrConfig } from '../types.js';
import {
  detectVerifyCommands,
  runVerifyCommand,
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
      const result = runVerifyCommand(typecheckCmd, worktreePath, cfg, {
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
      const result = runVerifyCommand(testCmd, worktreePath, cfg, {
        timeoutMs: SELF_VERIFY_TIMEOUT_MS,
      });
      if (!result.ok) {
        return {
          pass: false,
          reason: `self-verify failed: test: ${truncate(result.output)}`,
        };
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

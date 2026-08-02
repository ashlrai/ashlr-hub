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
import type {
  AshlrConfig,
  ProposalCaptureGateCategory,
  ProposalCaptureGateCode,
} from '../types.js';
import {
  detectVerifyCommands,
  runVerifyCommandAsync,
  type VerifyCommand,
} from './verify-commands.js';
import {
  prepareDeltaVerificationAuthority,
  type DeltaVerificationAuthority,
  type DeltaVerificationAuthorityResult,
} from './verification-snapshot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletenessGateResult {
  /** Compatibility alias for verified; never means merely capture-allowed. */
  pass: boolean;
  /** True only when the configured verification completed successfully. */
  verified: boolean;
  /** Whether the diff may be retained; unverified allowance is review-only. */
  captureAllowed: boolean;
  /** Stable machine-readable outcome; consumers must not parse reason text. */
  code: ProposalCaptureGateCode;
  /** Bounded policy class for repair and retry decisions. */
  category: ProposalCaptureGateCategory;
  /** True only when the caller requested cancellation. */
  cancelled?: boolean;
  /** Bounded human-readable summary; absent only for a verified pass. */
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
  /** Optional caller-owned cancellation for self-verification commands. */
  signal?: AbortSignal;
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

function cancelledResult(reason: string): CompletenessGateResult & { cancelled: true } {
  return {
    pass: false,
    verified: false,
    captureAllowed: false,
    code: 'cancelled',
    category: 'cancellation',
    cancelled: true,
    reason,
  };
}

function passedResult(): CompletenessGateResult {
  return {
    pass: true,
    verified: true,
    captureAllowed: true,
    code: 'passed',
    category: 'passed',
  };
}

function actionableResult(
  code: Exclude<
    ProposalCaptureGateCode,
    'passed' | 'no-commands' | 'verification-unavailable' | 'cancelled' | 'gate-error'
  >,
  reason: string,
): CompletenessGateResult {
  return {
    pass: false,
    verified: false,
    captureAllowed: false,
    code,
    category: 'actionable',
    reason,
  };
}

function infrastructureResult(
  code: 'no-commands' | 'verification-unavailable' | 'gate-error',
  reason: string,
  captureAllowed = false,
): CompletenessGateResult {
  return {
    pass: false,
    verified: false,
    captureAllowed,
    code,
    category: 'infrastructure',
    reason,
  };
}

function verifyInfrastructureReason(
  result: { failureCategory?: string; timedOut?: boolean },
): string | undefined {
  if (result.timedOut || result.failureCategory === 'timeout') return 'verification timed out';
  if (
    result.failureCategory === 'infra' ||
    result.failureCategory === 'tool' ||
    result.failureCategory === 'invalid-command'
  ) {
    return `verification unavailable: ${result.failureCategory}`;
  }
  return undefined;
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
  signal?: AbortSignal,
  authority?: Pick<
    DeltaVerificationAuthority,
    'launcher' | 'baseEnv' | 'isolatedHomeParent'
  >,
): Promise<{
  ok: boolean;
  ids: Set<string>;
  cancelled?: boolean;
  infrastructureReason?: string;
} | null> {
  const result = await runVerifyCommandAsync(cmd, dir, cfg, {
    timeoutMs,
    ...(signal ? { signal } : {}),
    ...(authority
      ? {
          launcher: authority.launcher,
          baseEnv: authority.baseEnv,
          isolatedHomeParent: authority.isolatedHomeParent,
        }
      : {}),
  });
  if (result.cancelled || result.failureCategory === 'cancelled' || signal?.aborted) {
    return { ok: false, ids: new Set<string>(), cancelled: true };
  }
  if (result.timedOut) return null;
  const infrastructureReason = verifyInfrastructureReason(result);
  if (infrastructureReason) {
    return { ok: false, ids: new Set<string>(), infrastructureReason };
  }
  if (result.ok) return { ok: true, ids: new Set<string>() };
  return { ok: false, ids: parseFailedTestIds(result.output) };
}

async function runIsolatedTypecheck(
  cmd: VerifyCommand,
  worktreePath: string,
  cfg: AshlrConfig,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CompletenessGateResult> {
  let authority: DeltaVerificationAuthority | undefined;
  let outcome: CompletenessGateResult | undefined;
  let identityConfirmed = true;
  try {
    const prepared = await prepareDeltaVerificationAuthority(worktreePath, signal);
    if (!prepared.available) {
      return prepared.cancelled || signal?.aborted
        ? cancelledResult('self-verify cancelled: typecheck authority')
        : infrastructureResult(
            'verification-unavailable',
            'self-verify unavailable: immutable typecheck authority unavailable',
            true,
          );
    }
    authority = prepared.authority;
    const result = await runVerifyCommandAsync(cmd, authority.candidatePath, cfg, {
      timeoutMs,
      launcher: authority.launcher,
      baseEnv: authority.baseEnv,
      isolatedHomeParent: authority.isolatedHomeParent,
      ...(signal ? { signal } : {}),
    });
    if (result.cancelled || result.failureCategory === 'cancelled' || signal?.aborted) {
      outcome = cancelledResult('self-verify cancelled: typecheck');
    } else if (!result.ok) {
      const infrastructureReason = verifyInfrastructureReason(result);
      outcome = infrastructureReason
        ? infrastructureResult(
            'verification-unavailable',
            `self-verify ${infrastructureReason}: typecheck`,
            true,
          )
        : actionableResult('typecheck-failed', 'self-verify failed: typecheck');
    } else {
      outcome = passedResult();
    }
  } catch {
    outcome = infrastructureResult('gate-error', 'self-verify gate error', true);
  } finally {
    if (authority) {
      identityConfirmed = authority.confirmCandidateIdentity();
      authority.cleanup();
    }
  }

  if (!identityConfirmed) {
    return infrastructureResult(
      'verification-unavailable',
      'self-verify unavailable: candidate identity changed during typecheck',
    );
  }
  if (signal?.aborted || outcome?.cancelled) {
    return cancelledResult(outcome?.reason ?? 'self-verify cancelled: typecheck');
  }
  return outcome ?? infrastructureResult('gate-error', 'self-verify gate error', true);
}

/**
 * M281: Delta-aware test verification.
 *
 * Strategy:
 *   1. Materialize immutable baseline and candidate snapshots without changing
 *      the source worktree.
 *   2. Run both snapshots under an OS write/network sandbox whose descendants
 *      inherit the same confinement.
 *   3. PASS iff (AFTER minus BASELINE) is empty (no NEW failures)
 *   4. FAIL iff any test that passed in BASELINE now fails in AFTER
 *
 * Safe fallbacks:
 *   - Snapshot or confinement authority unavailable → infrastructure-only
 *     review capture; never verified.
 *   - Baseline/after timeout → preserve the non-blocking fallback with an infrastructure code
 *   - Any unexpected delta error → preserve the non-blocking fallback with an infrastructure code
 *
 * Returns a bounded code/category for every result and never throws.
 */
export type DeltaVerificationAuthorityFactory = (
  worktreePath: string,
  signal?: AbortSignal,
) => Promise<DeltaVerificationAuthorityResult>;

export async function runDeltaAwareTestCheck(
  testCmd: VerifyCommand,
  worktreePath: string,
  cfg: AshlrConfig,
  timeoutMs: number,
  signal?: AbortSignal,
  authorityFactory: DeltaVerificationAuthorityFactory = prepareDeltaVerificationAuthority,
): Promise<CompletenessGateResult> {
  let authority: DeltaVerificationAuthority | undefined;
  let outcome: CompletenessGateResult | undefined;
  let gateErrored = false;
  let identityConfirmed = true;
  try {
    if (signal?.aborted) {
      return cancelledResult('self-verify cancelled: test');
    }

    const prepared = await authorityFactory(worktreePath, signal);
    if (!prepared.available) {
      return prepared.cancelled || signal?.aborted
        ? cancelledResult('self-verify cancelled: test baseline')
        : infrastructureResult(
            'verification-unavailable',
            'self-verify unavailable: immutable baseline authority unavailable',
            true,
          );
    }
    authority = prepared.authority;

    const baseline = await collectFailingTests(
      testCmd,
      authority.baselinePath,
      cfg,
      timeoutMs,
      signal,
      authority,
    );
    if (baseline?.cancelled || signal?.aborted) {
      outcome = cancelledResult('self-verify cancelled: test baseline');
    } else if (baseline?.infrastructureReason) {
      outcome = infrastructureResult(
        'verification-unavailable',
        `self-verify ${baseline.infrastructureReason}: test baseline`,
        true,
      );
    } else if (baseline === null) {
      outcome = infrastructureResult(
        'verification-unavailable',
        'self-verify unavailable: test baseline timed out',
        true,
      );
    }

    const after = outcome
      ? undefined
      : await collectFailingTests(
          testCmd,
          authority.candidatePath,
          cfg,
          timeoutMs,
          signal,
          authority,
        );

    if (!outcome && (after?.cancelled || signal?.aborted)) {
      outcome = cancelledResult('self-verify cancelled: test');
    } else if (!outcome && after?.infrastructureReason) {
      outcome = infrastructureResult(
        'verification-unavailable',
        `self-verify ${after.infrastructureReason}: test`,
        true,
      );
    } else if (!outcome && after === null) {
      outcome = infrastructureResult(
        'verification-unavailable',
        'self-verify unavailable: test timed out',
        true,
      );
    }

    // Step 3: delta analysis
    //
    // Case A: both IDs sets are non-empty → set-difference is authoritative.
    // Case B: IDs are empty (test runner uses no vitest/jest markers, e.g. a raw
    //         shell `exit 1`). Fall back to comparing ok flags:
    //           - baseline ok=true,  after ok=false  → NEW failure → block
    //           - baseline ok=false, after ok=false  → pre-existing failure → tolerate
    //           - baseline ok=true,  after ok=true   → no regression
    //           - baseline ok=false, after ok=true   → improvement, pass
    if (!outcome && baseline && after && (after.ids.size > 0 || baseline.ids.size > 0)) {
      // Named IDs available — use set-difference
      const newFailures = new Set<string>();
      for (const id of after.ids) {
        if (!baseline.ids.has(id)) newFailures.add(id);
      }
      if (newFailures.size > 0) {
        outcome = actionableResult(
          'test-regression',
          `self-verify failed: test: ${newFailures.size} new failure(s) introduced`,
        );
      }
    } else if (!outcome && baseline && after) {
      // No parseable IDs — fall back to ok-flag delta
      if (baseline.ok && !after.ok) {
        // Baseline was passing; change broke it — new regression
        outcome = actionableResult(
          'test-regression',
          'self-verify failed: test: regression detected (test suite failed after change, was passing before)',
        );
      }
      // baseline failed too (pre-existing) → tolerate
    }

    outcome ??= passedResult();
  } catch {
    gateErrored = true;
  } finally {
    if (authority) {
      identityConfirmed = authority.confirmCandidateIdentity();
      authority.cleanup();
    }
  }

  if (!identityConfirmed) {
    return infrastructureResult(
      'verification-unavailable',
      'self-verify unavailable: candidate identity changed during verification',
    );
  }
  if (signal?.aborted || outcome?.cancelled) {
    return cancelledResult(outcome?.reason ?? 'self-verify cancelled: test');
  }
  if (gateErrored) {
    return infrastructureResult('gate-error', 'self-verify gate error', true);
  }
  return outcome ?? infrastructureResult('gate-error', 'self-verify gate error', true);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the M275 completeness gate. `pass` is verified truth; captureAllowed is
 * the independent review-retention policy for unverified infrastructure states.
 *
 * @param opts - Gate inputs (worktreePath, diff, goal, cfg, isPartial).
 * @returns CompletenessGateResult — never throws.
 */
export async function runCompletenessGate(
  opts: RunCompletenessGateOpts,
): Promise<CompletenessGateResult> {
  try {
    const { worktreePath, diff, cfg, isPartial, signal } = opts;

    if (signal?.aborted) {
      return cancelledResult('completeness gate cancelled before verification');
    }

    // -----------------------------------------------------------------------
    // 1. Partial marker — engine did not complete cleanly
    // -----------------------------------------------------------------------
    if (isPartial === true) {
      return actionableResult(
        'partial-run',
        '[partial] run',
      );
    }

    // -----------------------------------------------------------------------
    // 2. Empty diff (defense-in-depth; M87 upstream already guards this)
    // -----------------------------------------------------------------------
    if (diff.files === 0 || diff.patch.trim().length === 0) {
      return actionableResult('empty-diff', 'empty diff — nothing to propose');
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
        return actionableResult(
          'lockfile-mismatch',
          'dependency change (package.json) lacks corresponding lockfile update',
        );
      }
    }

    // -----------------------------------------------------------------------
    // 4. Self-verify — typecheck first (fast), then test (bounded 60 s)
    //    Skipped gracefully when no verify commands are detected (e.g. repos
    //    with no package.json / tsconfig.json → gate passes).
    // -----------------------------------------------------------------------
    const cmds = detectVerifyCommands(worktreePath);
    if (cmds.length === 0) {
      return infrastructureResult(
        'no-commands',
        'self-verify unavailable: no verification commands',
        true,
      );
    }

    const typecheckCmd = cmds.find((c) => c.kind === 'typecheck');
    if (typecheckCmd) {
      const typecheckResult = await runIsolatedTypecheck(
        typecheckCmd,
        worktreePath,
        cfg,
        SELF_VERIFY_TIMEOUT_MS,
        signal,
      );
      if (!typecheckResult.pass) return typecheckResult;
    }

    const testCmd = cmds.find((c) => c.kind === 'test');
    if (testCmd) {
      // M281: delta-aware test check — tolerate pre-existing failures, block NEW ones.
      const deltaResult = await runDeltaAwareTestCheck(
        testCmd,
        worktreePath,
        cfg,
        SELF_VERIFY_TIMEOUT_MS,
        signal,
      );
      if (deltaResult.cancelled || signal?.aborted) {
        return cancelledResult(deltaResult.reason ?? 'self-verify cancelled: test');
      }
      if (!deltaResult.pass) {
        return deltaResult;
      }
      if (!deltaResult.verified) return deltaResult;
    }

    // All checks passed.
    if (signal?.aborted) {
      return cancelledResult('completeness gate cancelled');
    }
    return passedResult();
  } catch {
    if (opts.signal?.aborted) {
      return cancelledResult('completeness gate cancelled');
    }
    // Never throws — surface unexpected errors as a non-filing result.
    return infrastructureResult(
      'gate-error',
      'completeness gate error',
    );
  }
}

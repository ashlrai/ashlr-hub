/**
 * run-tests.ts — M331 (completes M140): run a proposal's diff against the
 * repo's own verification commands in a throwaway sandbox worktree.
 *
 * THIS MODULE'S NAME AND `runTests` SIGNATURE ARE LOAD-BEARING: best-of-n.ts
 * has dynamically imported `../run/run-tests.js` expecting
 * `runTests(proposalId, cfg): Promise<boolean>` since M170 and degraded
 * gracefully while the module was absent. Landing this file activates the
 * tests-green preference in best-of-N candidate selection.
 *
 * Flow: loadProposal → createSandbox (policy-gated, kill-switch aware) →
 * `git apply` the diff → detectRepoExecutionProfile INSIDE the worktree (so a
 * diff that adds a test script counts) → run verify commands cheap-first
 * (typecheck → lint → build → test) → removeSandbox.
 *
 * Semantics: absence of verification (no proposal, no diff, no commands,
 * sandbox unavailable) is NEUTRAL (passed: true, skipped set) — a candidate
 * must never be disqualified because a repo has no test suite. A diff that
 * FAILS TO APPLY or whose checks FAIL is a real negative (passed: false).
 *
 * Never throws. No network. Worktree is always cleaned up.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../types.js';
import { createSandbox, removeSandbox } from '../sandbox/worktree.js';

type Sandbox = ReturnType<typeof createSandbox>;
import { detectRepoExecutionProfile } from './repo-profile.js';
import { runVerifyCommandAsync, type VerifyCommand } from './verify-commands.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestRunCommandResult {
  kind: VerifyCommand['kind'];
  command: string;
  exitCode: number;
  ok: boolean;
  /** Combined stdout+stderr tail (scrubbed + capped by verify-commands). */
  outputTail: string;
}

export interface TestRunResult {
  passed: boolean;
  commands: TestRunCommandResult[];
  /** Set when verification could not run — NEUTRAL unless 'apply-failed'. */
  skipped?: 'no-proposal' | 'no-diff' | 'sandbox-failed' | 'apply-failed' | 'no-commands';
}

/** Cheap-first ordering: typecheck → lint → build → test. */
const KIND_RANK: Record<VerifyCommand['kind'], number> = { typecheck: 0, lint: 1, build: 2, test: 3 };

const PER_COMMAND_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The exact shape best-of-n.ts imports (M170 contract). True on green OR
 * neutral skip; false when the diff fails to apply or a check fails.
 */
export async function runTests(proposalId: string, cfg: AshlrConfig): Promise<boolean> {
  const detailed = await runTestsDetailed(proposalId, cfg);
  return detailed.passed;
}

/** Full-fidelity variant for evidence packs and the M335 dashboard. */
export async function runTestsDetailed(
  proposalId: string,
  cfg: AshlrConfig,
): Promise<TestRunResult> {
  let sb: Sandbox | null = null;
  try {
    // 1. Load the proposal (lazy import mirrors best-of-n.ts conventions so
    //    test mocks intercept cleanly).
    let repo: string | undefined;
    let diff: string | undefined;
    try {
      const { loadProposal } = await import('../inbox/store.js');
      const proposal = loadProposal(proposalId);
      repo = proposal?.repo ?? undefined;
      diff = proposal?.diff ?? undefined;
    } catch {
      /* fall through to no-proposal */
    }
    if (!repo) return { passed: true, commands: [], skipped: 'no-proposal' };
    if (!diff || diff.trim().length === 0) {
      return { passed: true, commands: [], skipped: 'no-diff' };
    }

    // 2. Throwaway worktree via the sandbox machinery (policy-gated: kill
    //    switch + enrollment apply exactly as for any other sandbox).
    try {
      sb = createSandbox(repo);
    } catch {
      return { passed: true, commands: [], skipped: 'sandbox-failed' };
    }

    // 3. Apply the diff. A diff that does not apply is a REAL negative — the
    //    candidate's patch is broken against the current tree.
    const patchDir = mkdtempSync(join(tmpdir(), 'ashlr-run-tests-'));
    const patchFile = join(patchDir, 'proposal.patch');
    try {
      writeFileSync(patchFile, diff.endsWith('\n') ? diff : diff + '\n', 'utf8');
      execFileSync('git', ['apply', '--whitespace=nowarn', patchFile], {
        cwd: sb.worktreePath,
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch {
      return { passed: false, commands: [], skipped: 'apply-failed' };
    } finally {
      try {
        rmSync(patchDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }

    // 4. Detect verification commands INSIDE the patched worktree.
    const profile = detectRepoExecutionProfile(sb.worktreePath);
    const commands = [...profile.verifyCommands].sort(
      (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind],
    );
    if (commands.length === 0) return { passed: true, commands: [], skipped: 'no-commands' };

    // 5. Run cheap-first; stop at the first failure.
    const results: TestRunCommandResult[] = [];
    for (const vc of commands) {
      const r = await runVerifyCommandAsync(vc, sb.worktreePath, cfg, {
        timeoutMs: PER_COMMAND_TIMEOUT_MS,
      });
      results.push({
        kind: vc.kind,
        command: r.command,
        exitCode: r.exitCode,
        ok: r.ok,
        outputTail: r.output.slice(-4_096),
      });
      if (!r.ok) return { passed: false, commands: results };
    }
    return { passed: true, commands: results };
  } catch {
    // Never throws — an infrastructure error is neutral, not a candidate fault.
    return { passed: true, commands: [], skipped: 'sandbox-failed' };
  } finally {
    if (sb) {
      try {
        removeSandbox(sb);
      } catch {
        /* best-effort cleanup — sweepOrphanSandboxes reclaims stragglers */
      }
    }
  }
}

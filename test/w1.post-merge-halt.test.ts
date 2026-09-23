/**
 * test/w1.post-merge-halt.test.ts — the gate that ends a bad night after ONE
 * bad commit instead of after eight hours of them.
 *
 * Real git repos, real enrollment, an isolated tmp HOME. Only the verify
 * COMMANDS are injected (running a real npm suite per assertion would make this
 * a twenty-minute file); everything that decides whether to halt is real.
 *
 *  A. Enrollment — a repo that is not enrolled is never read, verified or halted on
 *  B. Landing detection from repository state
 *  C. The halt: a red post-merge suite ENDS the run
 *  D. Fail safe: what cannot be verified halts, it does not continue
 *  E. The revert plan and the durable halt record
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerifyCommand, VerifyCommandResult } from '../src/core/run/verify-commands.js';
import {
  detectLandings,
  postMergeHaltDir,
  readPostMergeHalts,
  recordPostMergeHalt,
  revertCommandFor,
  runPostMergeGate,
  snapshotEnrolledHeads,
  type PostMergeGateSeams,
} from '../src/core/daemon/post-merge-halt.js';

let fx: H1Fixture;
let cfg: AshlrConfig;

beforeEach(() => {
  fx = makeFixture();
  cfg = makeCfg();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    stdio: 'pipe', encoding: 'utf8', timeout: 30_000,
  }).trim();
}

/** Land a normal commit on `dir`. */
function commit(dir: string, file: string, body: string, message: string): string {
  execFileSync('node', ['-e', `require('fs').writeFileSync(process.argv[1], process.argv[2])`,
    join(dir, file), body], { stdio: 'pipe' });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Land a real two-parent MERGE commit, the shape `inbox/merge` produces. */
function mergeCommit(dir: string, branch: string, file: string, message: string): string {
  const base = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-q', '-b', branch]);
  commit(dir, file, 'side\n', 'side work');
  git(dir, ['checkout', '-q', '-']);
  git(dir, ['merge', '--no-ff', '--no-verify', '-m', message, branch]);
  expect(git(dir, ['rev-parse', 'HEAD'])).not.toBe(base);
  return git(dir, ['rev-parse', 'HEAD']);
}

const TYPECHECK: VerifyCommand = { kind: 'typecheck', cmd: ['npm', 'run', 'typecheck'] };
const TEST: VerifyCommand = { kind: 'test', cmd: ['npm', 'test'] };

function passing(): VerifyCommandResult {
  return { ok: true, command: 'stub', exitCode: 0, output: '', timedOut: false };
}
function failing(exitCode = 1): VerifyCommandResult {
  return {
    ok: false, command: 'stub', exitCode, output: 'FAIL src/a.test.ts',
    timedOut: false, failureCategory: 'code',
  };
}

/** Seams that report a fixed command set and a fixed outcome. */
function seams(
  commands: VerifyCommand[],
  outcome: (c: VerifyCommand) => VerifyCommandResult,
  ran?: VerifyCommand[],
): PostMergeGateSeams {
  return {
    detect: () => commands,
    run: async (c) => { ran?.push(c); return outcome(c); },
  };
}

// ===========================================================================
// A — ENROLLMENT
// ===========================================================================

describe('W1 · A · enrollment is the only source of repos', () => {
  it('A1: a NON-enrolled repo is never snapshotted, even when its head moves', () => {
    const enrolled = fx.makeRepo();
    enrolled.enroll();
    const outsider = fx.makeRepo(); // deliberately NOT enrolled

    const before = snapshotEnrolledHeads();
    expect(before.map((s) => s.repo)).toEqual([enrolled.dir]);
    expect(before.map((s) => s.repo)).not.toContain(outsider.dir);

    // The outsider takes a commit. It must remain invisible.
    commit(outsider.dir, 'a.txt', 'changed\n', 'outsider moved');
    const after = snapshotEnrolledHeads();
    expect(after.map((s) => s.repo)).toEqual([enrolled.dir]);
    expect(detectLandings(before, after).landings).toEqual([]);
  });

  it('A2: a non-enrolled repo that moves triggers NO verification and NO halt', async () => {
    const enrolled = fx.makeRepo();
    enrolled.enroll();
    const outsider = fx.makeRepo();

    const before = snapshotEnrolledHeads();
    commit(outsider.dir, 'a.txt', 'changed\n', 'outsider moved');
    const after = snapshotEnrolledHeads();

    const ran: VerifyCommand[] = [];
    const result = await runPostMergeGate(before, after, cfg, seams([TEST], failing, ran));

    expect(result.verdict).toBe('no-landing');
    expect(result.halt).toBe(false);
    expect(ran).toEqual([]);           // nothing was run against the outsider
    expect(result.landings).toEqual([]);
  });

  it('A3: with NOTHING enrolled the gate is a no-op', async () => {
    const before = snapshotEnrolledHeads();
    expect(before).toEqual([]);
    const result = await runPostMergeGate(before, snapshotEnrolledHeads(), cfg, seams([TEST], failing));
    expect(result.verdict).toBe('no-landing');
    expect(result.halt).toBe(false);
  });
});

// ===========================================================================
// B — LANDING DETECTION
// ===========================================================================

describe('W1 · B · landings are read from the repository, not from a return value', () => {
  it('B1: an unchanged head is not a landing', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    expect(detectLandings(before, snapshotEnrolledHeads()).landings).toEqual([]);
  });

  it('B2: a moved head is a landing, with the commits that caused it', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    const sha = commit(repo.dir, 'a.txt', 'x\n', 'ashlr: auto-merge proposal p-1');

    const { landings } = detectLandings(before, snapshotEnrolledHeads());
    expect(landings).toHaveLength(1);
    expect(landings[0]!.repo).toBe(repo.dir);
    expect(landings[0]!.afterHead).toBe(sha);
    expect(landings[0]!.commits.map((c) => c.sha)).toEqual([sha]);
    expect(landings[0]!.commits[0]!.subject).toBe('ashlr: auto-merge proposal p-1');
    expect(landings[0]!.commits[0]!.isMerge).toBe(false);
  });

  it('B3: a two-parent merge commit — the shape inbox/merge lands — is recognised', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    const sha = mergeCommit(repo.dir, 'ashlr/merge/p-9', 'b.txt', 'ashlr: merge proposal branch ashlr/merge/p-9');

    const { landings } = detectLandings(before, snapshotEnrolledHeads());
    const merge = landings[0]!.commits.find((c) => c.sha === sha);
    expect(merge).toBeDefined();
    expect(merge!.isMerge).toBe(true);
  });

  it('B4: several enrolled repos are tracked independently', () => {
    const a = fx.makeRepo();
    const b = fx.makeRepo();
    a.enroll();
    b.enroll();
    const before = snapshotEnrolledHeads();
    commit(a.dir, 'a.txt', 'x\n', 'only A moved');

    const { landings } = detectLandings(before, snapshotEnrolledHeads());
    expect(landings.map((l) => l.repo)).toEqual([a.dir]);
  });

  it('B5: a repo enrolled DURING the tick is not retroactively a landing', () => {
    const a = fx.makeRepo();
    a.enroll();
    const before = snapshotEnrolledHeads();
    const late = fx.makeRepo();
    late.enroll();
    const { landings } = detectLandings(before, snapshotEnrolledHeads());
    expect(landings).toEqual([]);
  });
});

// ===========================================================================
// C — THE HALT
// ===========================================================================

describe('W1 · C · a red post-merge suite HALTS the run', () => {
  it('C1: green suite after a merge → clean, the run continues', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'ashlr: auto-merge proposal p-1');

    const ran: VerifyCommand[] = [];
    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TYPECHECK, TEST], passing, ran));

    expect(result.verdict).toBe('clean');
    expect(result.halt).toBe(false);
    expect(ran).toHaveLength(2);       // the suite really was re-run after the merge
    expect(result.ranCommands).toBe(2);
  });

  it('C2: RED suite after a merge → regressed AND halt:true', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'ashlr: auto-merge proposal p-2');

    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg,
      seams([TYPECHECK, TEST], (c) => (c.kind === 'test' ? failing() : passing())));

    expect(result.verdict).toBe('regressed');
    expect(result.halt).toBe(true);
    expect(result.detail).toContain('POST-MERGE REGRESSION');
    expect(result.failures.map((f) => f.kind)).toContain('test');
    // No command OUTPUT leaks into the summary line.
    expect(result.detail).not.toContain('FAIL src/a.test.ts');
  });

  it('C3: a timed-out required command is a regression, not a shrug', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');

    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg,
      seams([TEST], () => ({
        ok: false, command: 'npm test', exitCode: -1, output: '', timedOut: true,
      })));

    expect(result.verdict).toBe('regressed');
    expect(result.halt).toBe(true);
    expect(result.failures[0]!.detail).toContain('timed out');
  });

  it('C4: ADVISORY commands cannot halt the run, and cannot substitute for a required one', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');

    const ran: VerifyCommand[] = [];
    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg,
      seams([{ ...TEST, required: false }], failing, ran));

    // An advisory-only repo cannot PROVE the merge, so it fails safe — but it
    // fails as 'unverifiable', never as a regression, and never runs the
    // advisory command as though it were authoritative.
    expect(result.verdict).toBe('unverifiable');
    expect(result.halt).toBe(true);
    expect(ran).toEqual([]);
  });
});

// ===========================================================================
// D — FAIL SAFE
// ===========================================================================

describe('W1 · D · what cannot be verified halts, it does not continue', () => {
  it('D1: NO required verify command after a merge → unverifiable halt', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');

    const result = await runPostMergeGate(before, snapshotEnrolledHeads(), cfg, seams([], passing));
    expect(result.verdict).toBe('unverifiable');
    expect(result.halt).toBe(true);
    expect(result.failures[0]!.detail).toContain('cannot be proven good');
  });

  it('D2: a verify command that THROWS is unverifiable, not green', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');

    const result = await runPostMergeGate(before, snapshotEnrolledHeads(), cfg, {
      detect: () => [TEST],
      run: async () => { throw new Error('spawn ENOENT'); },
    });
    expect(result.verdict).toBe('unverifiable');
    expect(result.halt).toBe(true);
  });

  it('D3: detection that THROWS is unverifiable, not green', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');

    const result = await runPostMergeGate(before, snapshotEnrolledHeads(), cfg, {
      detect: () => { throw new Error('unreadable package.json'); },
      run: async () => passing(),
    });
    expect(result.verdict).toBe('unverifiable');
    expect(result.halt).toBe(true);
  });

  it('D4: an UNREADABLE enrolled repo halts — a merge we cannot see is not "no merge"', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    expect(before[0]!.head).not.toBeNull();

    // The repo disappears mid-run (an unmounted volume, a deleted worktree).
    rmSync(repo.dir, { recursive: true, force: true });
    const after = snapshotEnrolledHeads();
    expect(after[0]!.head).toBeNull();

    const result = await runPostMergeGate(before, after, cfg, seams([TEST], passing));
    expect(result.verdict).toBe('unverifiable');
    expect(result.halt).toBe(true);
    expect(result.detail).toContain('cannot prove what landed');
  });

  it('D5: an interrupted verification is unverifiable — a shutdown does not bless a merge', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');

    const controller = new AbortController();
    controller.abort();
    const result = await runPostMergeGate(before, snapshotEnrolledHeads(), cfg, {
      ...seams([TEST], passing),
      signal: controller.signal,
    });
    expect(result.verdict).toBe('unverifiable');
    expect(result.halt).toBe(true);
    expect(result.detail).toContain('unproven');
  });

  // ── The dirty working tree ──────────────────────────────────────────────
  // The only failure mode where the gate would otherwise say GREEN and be
  // wrong. A false halt costs one morning; a false green voids the entire
  // overnight safety property, because every later iteration is built on a
  // merge nothing actually checked.

  it('D7: an UNCOMMITTED change makes the verdict unprovable — and no suite is run', async () => {
    const repo = fx.makeRepo({ files: { 'README.md': '# r\n', 'src/a.ts': 'export const a = 1;\n' } });
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'b.txt', 'merged\n', 'ashlr: auto-merge proposal p-3');

    // The operator left work in the tree. A post-merge suite here measures
    // THEIR edit, not the merge.
    repo.writeFile('src/a.ts', 'export const a = 2; // half-finished\n');
    expect(repo.gitStatus()).not.toBe('');

    const ran: VerifyCommand[] = [];
    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TYPECHECK, TEST], passing, ran));

    expect(result.verdict).toBe('unverifiable');
    expect(result.halt).toBe(true);
    // Not a regression — the change was never judged at all.
    expect(result.failures.map((f) => f.kind)).toEqual(['dirty-tree']);
    expect(result.failures[0]!.detail).toContain('uncommitted change');
    expect(result.failures[0]!.detail).toContain('not the merge');
    // Checked BEFORE the suite: a run against a dirty tree is neither cheap
    // nor meaningful, so it never happens.
    expect(ran).toEqual([]);
    expect(result.ranCommands).toBe(0);
    expect(result.detail).toContain('POST-MERGE UNPROVABLE');
    expect(result.detail).toContain('dirty working tree');
  });

  it('D8: a dirty tree would otherwise have been a FALSE GREEN', async () => {
    // The same landing, the same passing seam. Clean → clean. Dirty → halt.
    // This is the hole, stated as a pair.
    const repo = fx.makeRepo({ files: { 'README.md': '# r\n', 'src/a.ts': 'export const a = 1;\n' } });
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'b.txt', 'merged\n', 'merge');

    const clean = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], passing));
    expect(clean.verdict).toBe('clean');
    expect(clean.halt).toBe(false);

    repo.writeFile('src/a.ts', 'export const a = 2;\n');
    const dirty = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], passing));
    expect(dirty.verdict).toBe('unverifiable');
    expect(dirty.halt).toBe(true);
  });

  it('D9: an UNTRACKED, un-ignored file is also unprovable', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'b.txt', 'merged\n', 'merge');

    repo.writeFile('stray.test.ts', 'it("fails", () => { throw new Error("x"); });\n');
    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], passing));

    expect(result.verdict).toBe('unverifiable');
    expect(result.failures[0]!.kind).toBe('dirty-tree');
    expect(result.failures[0]!.detail).toContain('untracked file');
  });

  it('D10: an IGNORED file is not dirt — build output must not halt every night', async () => {
    const repo = fx.makeRepo({ files: { 'README.md': '# r\n', '.gitignore': 'dist/\n*.log\n' } });
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'b.txt', 'merged\n', 'merge');

    // Exactly the things a real repo accumulates between runs.
    repo.writeFile('dist/bundle.js', '// built\n');
    repo.writeFile('debug.log', 'noise\n');
    expect(repo.gitStatus()).toBe('');

    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], passing));
    expect(result.verdict).toBe('clean');
    expect(result.halt).toBe(false);
  });

  it('D11: a dirty tree in a repo that took NO landing is irrelevant', async () => {
    // Only a repo that actually received a merge is verified, so an operator
    // editing an untouched repo never halts the run.
    const landed = fx.makeRepo();
    const editing = fx.makeRepo({ files: { 'README.md': '# r\n', 'src/a.ts': 'export const a = 1;\n' } });
    landed.enroll();
    editing.enroll();
    const before = snapshotEnrolledHeads();
    commit(landed.dir, 'b.txt', 'merged\n', 'merge');
    editing.writeFile('src/a.ts', 'work in progress\n');

    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], passing));
    expect(result.verdict).toBe('clean');
    expect(result.halt).toBe(false);
  });

  it('D6: the gate NEVER throws, whatever the seams do', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');
    await expect(runPostMergeGate(before, snapshotEnrolledHeads(), cfg, {
      detect: () => { throw new Error('boom'); },
      run: () => { throw new Error('boom'); },
    })).resolves.toBeDefined();
  });
});

// ===========================================================================
// E — THE REVERT PLAN AND THE HALT RECORD
// ===========================================================================

describe('W1 · E · a bad night costs one revert, and the revert is written down', () => {
  it('E1: a merge commit reverts with -m 1; an ordinary commit does not', () => {
    expect(revertCommandFor('a'.repeat(40), 'b'.repeat(40), [
      { sha: 'c'.repeat(40), subject: 'merge', isMerge: true },
    ])).toBe(`git revert --no-edit -m 1 ${'c'.repeat(40)}`);

    expect(revertCommandFor('a'.repeat(40), 'b'.repeat(40), [
      { sha: 'c'.repeat(40), subject: 'patch', isMerge: false },
    ])).toBe(`git revert --no-edit ${'c'.repeat(40)}`);
  });

  it('E2: several commits revert NEWEST first', () => {
    const plan = revertCommandFor('a'.repeat(40), 'b'.repeat(40), [
      { sha: '1'.repeat(40), subject: 'first', isMerge: false },
      { sha: '2'.repeat(40), subject: 'second', isMerge: false },
    ]);
    expect(plan.indexOf('2'.repeat(40))).toBeLessThan(plan.indexOf('1'.repeat(40)));
  });

  it('E3: an unlistable landing falls back to resetting to the exact prior head', () => {
    const plan = revertCommandFor('a'.repeat(40), 'b'.repeat(40), []);
    expect(plan).toContain(`git reset --hard ${'a'.repeat(40)}`);
  });

  it('E4: the revert plan names the REAL commit that landed', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    const sha = commit(repo.dir, 'a.txt', 'x\n', 'ashlr: auto-merge proposal p-7');

    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], failing));
    expect(result.halt).toBe(true);
    expect(result.revertPlan.join(' ')).toContain(sha);
  });

  it('E5: a halt is written durably and can be read back', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    const sha = commit(repo.dir, 'a.txt', 'x\n', 'ashlr: auto-merge proposal p-8');

    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], failing));
    const path = recordPostMergeHalt(result);

    expect(path).not.toBeNull();
    expect(existsSync(path as string)).toBe(true);
    const record = JSON.parse(readFileSync(path as string, 'utf8')) as Record<string, unknown>;
    expect(record['recordType']).toBe('daemon-post-merge-halt');
    expect(record['verdict']).toBe('regressed');
    expect(JSON.stringify(record['revertPlan'])).toContain(sha);

    const readBack = readPostMergeHalts();
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.verdict).toBe('regressed');
  });

  it('E6: a CLEAN result writes no halt record — halts are not noise', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');

    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], passing));
    expect(recordPostMergeHalt(result)).toBeNull();
    expect(existsSync(postMergeHaltDir())).toBe(false);
    expect(readPostMergeHalts()).toEqual([]);
  });

  it('E7: the halt record lives under the isolated HOME, never the real one', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const before = snapshotEnrolledHeads();
    commit(repo.dir, 'a.txt', 'x\n', 'merge');
    const result = await runPostMergeGate(
      before, snapshotEnrolledHeads(), cfg, seams([TEST], failing));
    const path = recordPostMergeHalt(result) as string;
    expect(path.startsWith(fx.home)).toBe(true);
  });
});

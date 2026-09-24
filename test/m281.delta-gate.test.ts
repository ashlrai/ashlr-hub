/**
 * test/m281.delta-gate.test.ts — M281: DELTA-AWARE test verification.
 *
 * Proves that:
 *  - parseFailedTestIds() correctly extracts failing test IDs from vitest/jest output.
 *  - runDeltaAwareTestCheck() PASSES when baseline has pre-existing failures but
 *    the change introduces NO new failures (the core M281 scenario).
 *  - runDeltaAwareTestCheck() BLOCKS when the change introduces a NEW failure
 *    that was NOT present in the baseline (regression protection intact).
 *  - runDeltaAwareTestCheck() PASSES when stash fails (cannot isolate baseline)
 *    and the direct run passes (original behaviour fallback).
 *  - runDeltaAwareTestCheck() BLOCKS when stash fails and the direct run fails.
 *  - runDeltaAwareTestCheck() PASSES safely when the baseline run times out
 *    (safe fallback — never hard-block on infra).
 *  - runDeltaAwareTestCheck() PASSES safely when the after run times out.
 *  - runCompletenessGate() with pre-existing failures but no new ones → PASS.
 *  - runCompletenessGate() with a new test failure introduced → BLOCK.
 *  - typecheck failure still BLOCKS regardless of delta logic (hard requirement).
 *  - runDeltaAwareTestCheck() never throws.
 *
 * All subprocess invocations are mocked — no real processes spawned.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerifyCommand, VerifyCommandResult } from '../src/core/run/verify-commands.js';

// ---------------------------------------------------------------------------
// Mock verify-commands so no real subprocesses run.
// ---------------------------------------------------------------------------
vi.mock('../src/core/run/verify-commands.js', () => {
  const runVerifyCommand = vi.fn();
  return {
    detectVerifyCommands: vi.fn(),
    runVerifyCommand,
    runVerifyCommandAsync: runVerifyCommand,
  };
});

// Mock node:fs existsSync for lockfile repo-root check.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

// Mock the hardened git runner for stash push/pop (V3.10 R3a: the gate's
// `git stash` goes through sandbox/safe-git runSafeGitSync).
vi.mock('../src/core/sandbox/safe-git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/safe-git.js')>();
  return {
    ...actual,
    runSafeGitSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A real directory holding a linked-worktree `.git` pointer: the gate reads it
// before handing git to safe-git (mocked above; the target is never touched).
const FAKE_WORKTREE = fs.mkdtempSync(path.join(os.tmpdir(), 'm281-test-worktree-'));
fs.writeFileSync(path.join(FAKE_WORKTREE, '.git'), 'gitdir: /nonexistent/.git/worktrees/m281\n');
afterAll(() => { fs.rmSync(FAKE_WORKTREE, { recursive: true, force: true }); });

function makeCfg(): AshlrConfig {
  return {
    foundry: {
      allowedBackends: ['builtin'],
    },
  } as AshlrConfig;
}

function makeDiff(patch = '+const x = 1;\n-const x = 0;\n') {
  return { files: 1, patch, insertions: 1, deletions: 1 };
}

const TYPECHECK_CMD: VerifyCommand = { kind: 'typecheck', cmd: ['npx', 'tsc', '--noEmit'] };
const TEST_CMD: VerifyCommand = { kind: 'test', cmd: ['npm', 'test'] };

function okResult(cmd: VerifyCommand, output = ''): VerifyCommandResult {
  return { ok: true, command: cmd.cmd.join(' '), exitCode: 0, output, timedOut: false };
}

function failResult(cmd: VerifyCommand, output: string, timedOut = false): VerifyCommandResult {
  return { ok: false, command: cmd.cmd.join(' '), exitCode: timedOut ? -1 : 1, output, timedOut };
}

/** Vitest-style output for N named failing tests */
function vitestFailOutput(...names: string[]): string {
  return names.map((n) => ` × ${n}`).join('\n') + '\n FAIL test/foo.test.ts\n';
}

// ---------------------------------------------------------------------------
// Helpers to get mocks after module load
// ---------------------------------------------------------------------------
async function getMocks() {
  const vc = await import('../src/core/run/verify-commands.js');
  const nodeFs = await import('node:fs');
  const sg = await import('../src/core/sandbox/safe-git.js');
  return {
    detectVerifyCommands: vi.mocked(vc.detectVerifyCommands),
    runVerifyCommand: vi.mocked(vc.runVerifyCommand),
    existsSync: vi.mocked(nodeFs.existsSync),
    stashGit: vi.mocked(sg.runSafeGitSync),
  };
}

async function getGate() {
  return import('../src/core/run/completeness-gate.js');
}

function gitOk(stdout: string) {
  return { ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false };
}

// Fake stash push that says "changes stashed"
function stashPushSuccess() {
  return gitOk('Saved working directory and index state ashlr-completeness-baseline');
}

// Fake stash push that says "nothing to stash"
function stashPushNoop() {
  return gitOk('No local changes to save');
}

// Fake stash pop success
function stashPopSuccess() {
  return gitOk('Dropped stash');
}

// ---------------------------------------------------------------------------
// Tests: parseFailedTestIds
// ---------------------------------------------------------------------------

describe('M281 · parseFailedTestIds()', () => {
  it('parses vitest × markers', async () => {
    const { parseFailedTestIds } = await getGate();
    const output = ' × should return 42\n × handles empty input\n';
    const ids = parseFailedTestIds(output);
    expect(ids.has('should return 42')).toBe(true);
    expect(ids.has('handles empty input')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('parses FAIL file lines', async () => {
    const { parseFailedTestIds } = await getGate();
    const output = 'FAIL test/m53.test.ts\nFAIL test/m123.test.ts\n';
    const ids = parseFailedTestIds(output);
    expect(ids.has('FAIL test/m53.test.ts')).toBe(true);
    expect(ids.has('FAIL test/m123.test.ts')).toBe(true);
  });

  it('parses jest ● markers', async () => {
    const { parseFailedTestIds } = await getGate();
    const output = '● Suite > should work\n● Other > also fails\n';
    const ids = parseFailedTestIds(output);
    expect(ids.has('Suite > should work')).toBe(true);
    expect(ids.has('Other > also fails')).toBe(true);
  });

  it('returns empty set for all-green output', async () => {
    const { parseFailedTestIds } = await getGate();
    const ids = parseFailedTestIds('Test Files  5 passed\nTests  42 passed\n');
    expect(ids.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: runDeltaAwareTestCheck
// ---------------------------------------------------------------------------

describe('M281 · runDeltaAwareTestCheck() — core delta logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PASSES when baseline has pre-existing failures but change adds none (core M281 scenario)', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    // Stash succeeds — changes were stashed
    stashGit
      .mockReturnValueOnce(stashPushSuccess())  // stash push
      .mockReturnValueOnce(stashPopSuccess());  // stash pop

    const preExistingOutput = vitestFailOutput('m53 > env failure', 'm123 > timing issue');
    const afterOutput = vitestFailOutput('m53 > env failure', 'm123 > timing issue'); // same failures

    runVerifyCommand
      .mockReturnValueOnce(failResult(TEST_CMD, preExistingOutput)) // baseline: 2 pre-existing
      .mockReturnValueOnce(failResult(TEST_CMD, afterOutput));      // after: same 2 failures

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);

    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('BLOCKS when change introduces a NEW failure not in baseline (regression protection)', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    stashGit
      .mockReturnValueOnce(stashPushSuccess())
      .mockReturnValueOnce(stashPopSuccess());

    const baselineOutput = vitestFailOutput('m53 > env failure'); // 1 pre-existing
    const afterOutput = vitestFailOutput('m53 > env failure', 'myNewTest > should not regress'); // +1 NEW

    runVerifyCommand
      .mockReturnValueOnce(failResult(TEST_CMD, baselineOutput))
      .mockReturnValueOnce(failResult(TEST_CMD, afterOutput));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/new failure/i);
    expect(result.reason).toMatch(/myNewTest/);
  });

  it('PASSES when baseline is all-green and after is all-green', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    stashGit
      .mockReturnValueOnce(stashPushSuccess())
      .mockReturnValueOnce(stashPopSuccess());

    runVerifyCommand
      .mockReturnValueOnce(okResult(TEST_CMD, 'Tests  10 passed'))
      .mockReturnValueOnce(okResult(TEST_CMD, 'Tests  10 passed'));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(true);
  });

  it('BLOCKS when baseline is all-green and after introduces a failure', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    stashGit
      .mockReturnValueOnce(stashPushSuccess())
      .mockReturnValueOnce(stashPopSuccess());

    runVerifyCommand
      .mockReturnValueOnce(okResult(TEST_CMD, 'Tests  10 passed'))
      .mockReturnValueOnce(failResult(TEST_CMD, vitestFailOutput('regression > this broke')));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/new failure/i);
  });

  it('falls back to direct run when stash fails — PASSES if direct run passes', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    // Stash push says nothing to stash
    stashGit.mockReturnValueOnce(stashPushNoop());

    runVerifyCommand.mockReturnValueOnce(okResult(TEST_CMD));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(true);
  });

  it('falls back to direct run when stash fails — BLOCKS if direct run fails', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    stashGit.mockReturnValueOnce(stashPushNoop());

    runVerifyCommand.mockReturnValueOnce(failResult(TEST_CMD, 'error output'));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/self-verify failed: test/);
  });

  it('PASSES safely when baseline run times out (safe fallback)', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    stashGit
      .mockReturnValueOnce(stashPushSuccess())
      .mockReturnValueOnce(stashPopSuccess());

    // Baseline run times out
    runVerifyCommand.mockReturnValueOnce(failResult(TEST_CMD, '', true /* timedOut */));
    // After run is not called since we short-circuit on baseline timeout

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(true);
  });

  it('PASSES safely when after run times out', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand, stashGit } = await getMocks();

    stashGit
      .mockReturnValueOnce(stashPushSuccess())
      .mockReturnValueOnce(stashPopSuccess());

    runVerifyCommand
      .mockReturnValueOnce(okResult(TEST_CMD)) // baseline passes
      .mockReturnValueOnce(failResult(TEST_CMD, '', true /* timedOut */)); // after times out

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(true);
  });

  it('never throws on unexpected error', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { stashGit } = await getMocks();

    // Make stashGit throw
    stashGit.mockImplementation(() => { throw new Error('ENOENT git'); });

    await expect(
      runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000),
    ).resolves.toMatchObject({ pass: true }); // safe fallback
  });
});

// ---------------------------------------------------------------------------
// Tests: runCompletenessGate with delta logic
// ---------------------------------------------------------------------------

describe('M281 · runCompletenessGate() — delta-aware integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PASSES when baseline has pre-existing failures but change adds none', async () => {
    const { runCompletenessGate } = await getGate();
    const { detectVerifyCommands, runVerifyCommand, existsSync, stashGit } = await getMocks();

    existsSync.mockReturnValue(false); // no lockfile

    detectVerifyCommands.mockReturnValue([TYPECHECK_CMD, TEST_CMD]);
    runVerifyCommand.mockReturnValueOnce(okResult(TYPECHECK_CMD)); // typecheck passes

    // For delta logic: stash succeeds, baseline has 7 pre-existing failures,
    // after also has the same 7 → no new failures
    stashGit
      .mockReturnValueOnce(stashPushSuccess())
      .mockReturnValueOnce(stashPopSuccess());

    const preExisting = vitestFailOutput('m53 > env', 'm123 > timing', 'm130 > sandbox',
      'm160 > rate', 'm236 > quota', 'm245 > fleet', 'h8 > infra');
    runVerifyCommand
      .mockReturnValueOnce(failResult(TEST_CMD, preExisting)) // baseline
      .mockReturnValueOnce(failResult(TEST_CMD, preExisting)); // after same failures

    const result = await runCompletenessGate({
      worktreePath: FAKE_WORKTREE,
      diff: makeDiff(),
      goal: 'fix a bug',
      cfg: { foundry: { allowedBackends: ['builtin'] } } as AshlrConfig,
    });

    expect(result.pass).toBe(true);
  });

  it('BLOCKS when change introduces a new test failure', async () => {
    const { runCompletenessGate } = await getGate();
    const { detectVerifyCommands, runVerifyCommand, existsSync, stashGit } = await getMocks();

    existsSync.mockReturnValue(false);
    detectVerifyCommands.mockReturnValue([TYPECHECK_CMD, TEST_CMD]);
    runVerifyCommand.mockReturnValueOnce(okResult(TYPECHECK_CMD));

    stashGit
      .mockReturnValueOnce(stashPushSuccess())
      .mockReturnValueOnce(stashPopSuccess());

    const baseline = vitestFailOutput('m53 > env');
    const after = vitestFailOutput('m53 > env', 'myFeature > broke something');

    runVerifyCommand
      .mockReturnValueOnce(failResult(TEST_CMD, baseline))
      .mockReturnValueOnce(failResult(TEST_CMD, after));

    const result = await runCompletenessGate({
      worktreePath: FAKE_WORKTREE,
      diff: makeDiff(),
      goal: 'add feature',
      cfg: { foundry: { allowedBackends: ['builtin'] } } as AshlrConfig,
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/new failure/i);
    expect(result.reason).toMatch(/myFeature/);
  });

  it('BLOCKS when typecheck fails (hard requirement, not delta-aware)', async () => {
    const { runCompletenessGate } = await getGate();
    const { detectVerifyCommands, runVerifyCommand, existsSync } = await getMocks();

    existsSync.mockReturnValue(false);
    detectVerifyCommands.mockReturnValue([TYPECHECK_CMD, TEST_CMD]);
    runVerifyCommand.mockReturnValueOnce(failResult(TYPECHECK_CMD, 'error TS2304: Cannot find name'));

    const result = await runCompletenessGate({
      worktreePath: FAKE_WORKTREE,
      diff: makeDiff(),
      goal: 'add types',
      cfg: { foundry: { allowedBackends: ['builtin'] } } as AshlrConfig,
    });

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/typecheck/);
    // Test never runs after typecheck fails
    expect(runVerifyCommand).toHaveBeenCalledTimes(1);
  });
});

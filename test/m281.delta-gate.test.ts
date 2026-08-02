/**
 * test/m281.delta-gate.test.ts — M281: DELTA-AWARE test verification.
 *
 * Proves that:
 *  - parseFailedTestIds() correctly extracts failing test IDs from vitest/jest output.
 *  - runDeltaAwareTestCheck() PASSES when baseline has pre-existing failures but
 *    the change introduces NO new failures (the core M281 scenario).
 *  - runDeltaAwareTestCheck() BLOCKS when the change introduces a NEW failure
 *    that was NOT present in the baseline (regression protection intact).
 *  - runDeltaAwareTestCheck() compares immutable baseline and candidate
 *    snapshots without mutating the source worktree.
 *  - runDeltaAwareTestCheck() allows review-only capture when verification
 *    infrastructure times out, without reporting a verified pass.
 *  - runCompletenessGate() with pre-existing failures but no new ones → PASS.
 *  - runCompletenessGate() with a new test failure introduced → BLOCK.
 *  - typecheck failure still BLOCKS regardless of delta logic (hard requirement).
 *  - runDeltaAwareTestCheck() never throws.
 *
 * All subprocess invocations are mocked — no real processes spawned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../src/core/run/verification-snapshot.js', () => ({
  prepareDeltaVerificationAuthority: vi.fn(),
}));

// Mock node:fs existsSync for lockfile repo-root check.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_WORKTREE = path.join(os.tmpdir(), 'm281-test-worktree');

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
  const fs = await import('node:fs');
  const snapshot = await import('../src/core/run/verification-snapshot.js');
  return {
    detectVerifyCommands: vi.mocked(vc.detectVerifyCommands),
    runVerifyCommand: vi.mocked(vc.runVerifyCommand),
    prepareDeltaVerificationAuthority: vi.mocked(snapshot.prepareDeltaVerificationAuthority),
    existsSync: vi.mocked(fs.existsSync),
  };
}

async function getGate() {
  return import('../src/core/run/completeness-gate.js');
}

function immutableAuthority(identity = true) {
  return {
    available: true as const,
    authority: {
      root: path.join(os.tmpdir(), 'm281-authority'),
      baselinePath: path.join(os.tmpdir(), 'm281-authority', 'baseline'),
      candidatePath: path.join(os.tmpdir(), 'm281-authority', 'candidate'),
      launcher: { bin: '/usr/bin/sandbox-exec', prefixArgs: ['-p', '(version 1)'] },
      baseEnv: { PATH: '/usr/bin:/bin' },
      isolatedHomeParent: path.join(os.tmpdir(), 'm281-authority'),
      candidateDigest: 'b'.repeat(64),
      confirmCandidateIdentity: vi.fn(() => identity),
      cleanup: vi.fn(),
    },
  };
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
  beforeEach(async () => {
    vi.resetAllMocks();
    const { prepareDeltaVerificationAuthority } = await getMocks();
    prepareDeltaVerificationAuthority.mockResolvedValue(immutableAuthority());
  });

  it('PASSES when baseline has pre-existing failures but change adds none (core M281 scenario)', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand } = await getMocks();

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
    const { runVerifyCommand } = await getMocks();

    const baselineOutput = vitestFailOutput('m53 > env failure'); // 1 pre-existing
    const afterOutput = vitestFailOutput('m53 > env failure', 'myNewTest > should not regress'); // +1 NEW

    runVerifyCommand
      .mockReturnValueOnce(failResult(TEST_CMD, baselineOutput))
      .mockReturnValueOnce(failResult(TEST_CMD, afterOutput));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/new failure/i);
    expect(result.reason).not.toMatch(/myNewTest/);
  });

  it('PASSES when baseline is all-green and after is all-green', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand } = await getMocks();

    runVerifyCommand
      .mockReturnValueOnce(okResult(TEST_CMD, 'Tests  10 passed'))
      .mockReturnValueOnce(okResult(TEST_CMD, 'Tests  10 passed'));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(true);
  });

  it('BLOCKS when baseline is all-green and after introduces a failure', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand } = await getMocks();

    runVerifyCommand
      .mockReturnValueOnce(okResult(TEST_CMD, 'Tests  10 passed'))
      .mockReturnValueOnce(failResult(TEST_CMD, vitestFailOutput('regression > this broke')));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/new failure/i);
  });

  it('returns review-only infrastructure when immutable authority is unavailable', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { prepareDeltaVerificationAuthority, runVerifyCommand } = await getMocks();
    prepareDeltaVerificationAuthority.mockResolvedValueOnce({
      available: false,
      reason: 'confinement-unavailable',
    });

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result).toMatchObject({
      pass: false,
      verified: false,
      captureAllowed: true,
      code: 'verification-unavailable',
      category: 'infrastructure',
    });
    expect(runVerifyCommand).not.toHaveBeenCalled();
  });

  it('allows review-only capture when the baseline run times out', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand } = await getMocks();

    // Baseline run times out
    runVerifyCommand.mockReturnValueOnce(failResult(TEST_CMD, '', true /* timedOut */));
    // After run is not called since we short-circuit on baseline timeout

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result).toMatchObject({
      pass: false,
      verified: false,
      captureAllowed: true,
      code: 'verification-unavailable',
      category: 'infrastructure',
    });
  });

  it('allows review-only capture when the candidate run times out', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { runVerifyCommand } = await getMocks();

    runVerifyCommand
      .mockReturnValueOnce(okResult(TEST_CMD)) // baseline passes
      .mockReturnValueOnce(failResult(TEST_CMD, '', true /* timedOut */)); // after times out

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);
    expect(result).toMatchObject({
      pass: false,
      verified: false,
      captureAllowed: true,
      code: 'verification-unavailable',
      category: 'infrastructure',
    });
  });

  it('never throws on unexpected error', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { prepareDeltaVerificationAuthority } = await getMocks();
    prepareDeltaVerificationAuthority.mockRejectedValueOnce(new Error('snapshot failed'));

    await expect(
      runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000),
    ).resolves.toMatchObject({
      pass: false,
      verified: false,
      captureAllowed: true,
      code: 'gate-error',
      category: 'infrastructure',
    });
  });

  it('fails closed when candidate bytes or index change during verification', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { prepareDeltaVerificationAuthority, runVerifyCommand } = await getMocks();
    prepareDeltaVerificationAuthority.mockResolvedValueOnce(immutableAuthority(false));
    runVerifyCommand
      .mockReturnValueOnce(okResult(TEST_CMD))
      .mockReturnValueOnce(okResult(TEST_CMD));

    const result = await runDeltaAwareTestCheck(TEST_CMD, FAKE_WORKTREE, makeCfg(), 60_000);

    expect(result).toMatchObject({
      pass: false,
      verified: false,
      captureAllowed: false,
      code: 'verification-unavailable',
      category: 'infrastructure',
    });
    expect(result.reason).toMatch(/candidate identity changed/i);
  });

  it('keeps tracked and untracked candidate bytes unchanged when snapshot verifiers mutate files', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { prepareDeltaVerificationAuthority, runVerifyCommand } = await getMocks();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm281-mutation-'));
    const source = path.join(root, 'source');
    const baseline = path.join(root, 'baseline');
    const candidate = path.join(root, 'candidate');
    for (const dir of [source, baseline, candidate]) fs.mkdirSync(dir);
    for (const dir of [source, baseline, candidate]) {
      fs.writeFileSync(path.join(dir, 'tracked.ts'), 'trusted tracked\n');
      fs.writeFileSync(path.join(dir, 'untracked.txt'), 'trusted untracked\n');
    }
    const prepared = immutableAuthority();
    prepared.authority.root = root;
    prepared.authority.baselinePath = baseline;
    prepared.authority.candidatePath = candidate;
    prepared.authority.confirmCandidateIdentity = vi.fn(() =>
      fs.readFileSync(path.join(source, 'tracked.ts'), 'utf8') === 'trusted tracked\n' &&
      fs.readFileSync(path.join(source, 'untracked.txt'), 'utf8') === 'trusted untracked\n');
    prepared.authority.cleanup = vi.fn();
    prepareDeltaVerificationAuthority.mockResolvedValueOnce(prepared);
    runVerifyCommand.mockImplementation((_cmd, dir) => {
      fs.writeFileSync(path.join(dir, 'tracked.ts'), 'verifier mutation\n');
      fs.writeFileSync(path.join(dir, 'untracked.txt'), 'verifier mutation\n');
      return okResult(TEST_CMD);
    });

    try {
      const result = await runDeltaAwareTestCheck(TEST_CMD, source, makeCfg(), 60_000);
      expect(result).toMatchObject({ pass: true, verified: true, code: 'passed' });
      expect(fs.readFileSync(path.join(source, 'tracked.ts'), 'utf8')).toBe('trusted tracked\n');
      expect(fs.readFileSync(path.join(source, 'untracked.txt'), 'utf8')).toBe('trusted untracked\n');
      expect(runVerifyCommand.mock.calls.map((call) => call[1])).toEqual([baseline, candidate]);
      expect(prepared.authority.confirmCandidateIdentity).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards cancellation and confirms candidate identity before returning', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { prepareDeltaVerificationAuthority, runVerifyCommand } = await getMocks();
    const controller = new AbortController();
    const prepared = immutableAuthority();
    prepareDeltaVerificationAuthority.mockResolvedValueOnce(prepared);
    runVerifyCommand.mockImplementationOnce(() => {
      controller.abort();
      return { ...failResult(TEST_CMD, '', true), cancelled: true, failureCategory: 'cancelled' };
    });

    const result = await runDeltaAwareTestCheck(
      TEST_CMD,
      FAKE_WORKTREE,
      makeCfg(),
      60_000,
      controller.signal,
    );

    expect(result).toMatchObject({
      pass: false,
      captureAllowed: false,
      code: 'cancelled',
      category: 'cancellation',
      cancelled: true,
    });
    expect(prepared.authority.confirmCandidateIdentity).toHaveBeenCalledOnce();
    expect(prepared.authority.cleanup).toHaveBeenCalledOnce();
  });

  it('does not let cancellation hide a candidate identity mismatch', async () => {
    const { runDeltaAwareTestCheck } = await getGate();
    const { prepareDeltaVerificationAuthority, runVerifyCommand } = await getMocks();
    const controller = new AbortController();
    prepareDeltaVerificationAuthority.mockResolvedValueOnce(immutableAuthority(false));
    runVerifyCommand.mockImplementationOnce(() => {
      controller.abort();
      return { ...failResult(TEST_CMD, '', true), cancelled: true };
    });

    const result = await runDeltaAwareTestCheck(
      TEST_CMD,
      FAKE_WORKTREE,
      makeCfg(),
      60_000,
      controller.signal,
    );

    expect(result).toMatchObject({
      pass: false,
      verified: false,
      captureAllowed: false,
      code: 'verification-unavailable',
      category: 'infrastructure',
    });
    expect(result.reason).toMatch(/candidate identity changed/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: runCompletenessGate with delta logic
// ---------------------------------------------------------------------------

describe('M281 · runCompletenessGate() — delta-aware integration', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { prepareDeltaVerificationAuthority } = await getMocks();
    prepareDeltaVerificationAuthority.mockResolvedValue(immutableAuthority());
  });

  it('PASSES when baseline has pre-existing failures but change adds none', async () => {
    const { runCompletenessGate } = await getGate();
    const { detectVerifyCommands, runVerifyCommand, existsSync } = await getMocks();

    existsSync.mockReturnValue(false); // no lockfile

    detectVerifyCommands.mockReturnValue([TYPECHECK_CMD, TEST_CMD]);
    runVerifyCommand.mockReturnValueOnce(okResult(TYPECHECK_CMD)); // typecheck passes

    // The immutable baseline has 7 pre-existing failures and the candidate has
    // the same 7, so the candidate introduces no regression.

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
    const { detectVerifyCommands, runVerifyCommand, existsSync } = await getMocks();

    existsSync.mockReturnValue(false);
    detectVerifyCommands.mockReturnValue([TYPECHECK_CMD, TEST_CMD]);
    runVerifyCommand.mockReturnValueOnce(okResult(TYPECHECK_CMD));

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
    expect(result.reason).not.toMatch(/myFeature/);
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

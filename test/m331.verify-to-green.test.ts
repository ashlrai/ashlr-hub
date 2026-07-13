/**
 * m331.verify-to-green.test.ts — M331 (completes M140): run-tests keystone +
 * bounded verify-to-green repair loop.
 *
 * runTestsDetailed integration (real git apply + real verify commands in a
 * throwaway clone; the sandbox layer is mocked so the policy gate does not
 * require enrollment):
 *  - a diff whose added file the test script requires → passed (proves the
 *    diff was APPLIED before running);
 *  - failing test script → passed:false;
 *  - unapplicable diff → passed:false, skipped 'apply-failed' (real negative);
 *  - no verify commands → NEUTRAL passed:true, skipped 'no-commands';
 *  - missing proposal → NEUTRAL passed:true.
 *
 * iterateToGreen unit (pure):
 *  - disabled → 0 iterations; green-after-N; repair-failed; max-iterations
 *    clamp; failure-tail truncation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — the sandbox layer is replaced with a plain clone of the fixture
// repo so the enrollment/kill-switch policy gate (correct in production,
// irrelevant here) does not refuse the throwaway fixture.
// ---------------------------------------------------------------------------

let fixtureRepo = '';
let fixtureProposal: { repo: string; diff: string } | null = null;
const clones: string[] = [];
const removedSandboxes: string[] = [];

vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: vi.fn(() => fixtureProposal),
}));

vi.mock('../src/core/sandbox/worktree.js', () => ({
  createSandbox: vi.fn((sourceRepo: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-m331-clone-'));
    execFileSync('git', ['clone', '--quiet', sourceRepo, dir], { stdio: 'pipe' });
    clones.push(dir);
    return { id: `m331-${clones.length}`, sourceRepo, worktreePath: dir, branch: 'x' };
  }),
  removeSandbox: vi.fn((sandbox: { id: string }) => { removedSandboxes.push(sandbox.id); }),
}));

import { runTests, runTestsDetailed } from '../src/core/run/run-tests.js';
import { iterateToGreen } from '../src/core/run/verify-to-green.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'm331',
  GIT_AUTHOR_EMAIL: 'm331@test',
  GIT_COMMITTER_NAME: 'm331',
  GIT_COMMITTER_EMAIL: 'm331@test',
};

function makeRepo(pkg: Record<string, unknown>, verifyContract?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m331-repo-'));
  execFileSync('git', ['init', '--quiet', dir], { stdio: 'pipe' });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  if (verifyContract) {
    writeFileSync(join(dir, 'ashlr.verify.json'), JSON.stringify(verifyContract, null, 2) + '\n');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], {
    cwd: dir,
    stdio: 'pipe',
    env: GIT_ENV,
  });
  return dir;
}

const ADD_FILE_DIFF = [
  'diff --git a/added-by-diff.txt b/added-by-diff.txt',
  'new file mode 100644',
  'index 0000000..d95f3ad',
  '--- /dev/null',
  '+++ b/added-by-diff.txt',
  '@@ -0,0 +1 @@',
  '+content',
  '',
].join('\n');

/** Test script that passes ONLY when the diff-added file is present. */
const REQUIRES_DIFF_FILE =
  'node -e "process.exit(require(\'fs\').existsSync(\'added-by-diff.txt\') ? 0 : 1)"';

const cfg = { version: 1, roots: ['/tmp'] } as unknown as AshlrConfig;

const created: string[] = [];
beforeEach(() => {
  fixtureProposal = null;
  fixtureRepo = '';
});
afterEach(() => {
  for (const d of [...created, ...clones]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  created.length = 0;
  clones.length = 0;
  removedSandboxes.length = 0;
});

function repoWith(pkg: Record<string, unknown>, diff: string): void {
  fixtureRepo = makeRepo(pkg);
  created.push(fixtureRepo);
  fixtureProposal = { repo: fixtureRepo, diff };
}

function repoWithContract(commands: Array<Record<string, unknown>>, diff = ADD_FILE_DIFF): void {
  fixtureRepo = makeRepo(
    { name: 'fx', version: '1.0.0' },
    { schemaVersion: 1, mode: 'replace-detected', commands },
  );
  created.push(fixtureRepo);
  fixtureProposal = { repo: fixtureRepo, diff };
}

// ---------------------------------------------------------------------------
// runTestsDetailed
// ---------------------------------------------------------------------------

describe('M331 runTestsDetailed', () => {
  it('pre-cancelled run creates no sandbox or subprocess', async () => {
    repoWith({ name: 'fx', version: '1.0.0', scripts: { test: REQUIRES_DIFF_FILE } }, ADD_FILE_DIFF);
    const controller = new AbortController();
    controller.abort();

    const result = await runTestsDetailed('p-pre-cancel', cfg, 'quick', {
      signal: controller.signal,
    });

    expect(result).toEqual({ passed: false, commands: [], skipped: 'cancelled' });
    expect(clones).toHaveLength(0);
    expect(removedSandboxes).toHaveLength(0);
    await expect(runTests('p-pre-cancel', cfg, 'quick', {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('mid-cancel retains its sandbox when process cleanup is unconfirmed', async () => {
    repoWithContract([{
      id: 'wait-for-cancel',
      kind: 'test',
      cmd: [
        'node',
        '-e',
        "require('fs').writeFileSync('verify-started', '1'); setInterval(() => {}, 1000)",
      ],
      required: true,
      profiles: ['quick'],
    }]);
    const controller = new AbortController();

    const pending = runTestsDetailed('p-mid-cancel', cfg, 'quick', {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(clones[0]).toBeDefined();
      expect(existsSync(join(clones[0]!, 'verify-started'))).toBe(true);
    }, { timeout: 5_000 });
    controller.abort();
    const result = await pending;

    expect(result.skipped).toBe('process-cleanup-unconfirmed');
    expect(result.commands.at(-1)).toMatchObject({
      ok: false,
      failureCategory: 'infra',
    });
    expect(result).toMatchObject({
      passed: false,
      skipped: 'process-cleanup-unconfirmed',
      sandboxRetention: {
        status: 'retained',
        reason: 'process-cleanup-unconfirmed',
        recovery: 'orphan-sweep',
      },
    });
    expect(result.commands.at(-1)?.failureCategory).toBe('infra');
    expect(existsSync(result.sandboxRetention!.worktreePath)).toBe(true);
    expect(removedSandboxes).toEqual([]);
  }, 10_000);

  it('applies the diff BEFORE running: script requiring the added file passes', async () => {
    repoWith({ name: 'fx', version: '1.0.0', scripts: { test: REQUIRES_DIFF_FILE } }, ADD_FILE_DIFF);
    const r = await runTestsDetailed('p1', cfg);
    expect(r.skipped).toBeUndefined();
    expect(r.passed).toBe(true);
    expect(r.commands.some((c) => c.kind === 'test' && c.ok)).toBe(true);
  }, 30_000);

  it('failing test script → passed:false with the failing command recorded', async () => {
    repoWith({ name: 'fx', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' } }, ADD_FILE_DIFF);
    const r = await runTestsDetailed('p2', cfg);
    expect(r.passed).toBe(false);
    expect(r.commands.at(-1)?.ok).toBe(false);
    expect(await runTests('p2', cfg)).toBe(false);
  }, 30_000);

  it('runs detected commands cheap-first with build before test', async () => {
    repoWith(
      {
        name: 'fx',
        version: '1.0.0',
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          build: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
        },
      },
      ADD_FILE_DIFF,
    );

    const r = await runTestsDetailed('p-build-order', cfg);

    expect(r.passed).toBe(true);
    expect(r.commands.map((command) => command.kind)).toEqual(['typecheck', 'lint', 'build', 'test']);
  }, 30_000);

  it('runs only commands in the requested profile while preserving unprofiled commands', async () => {
    repoWithContract([
      {
        id: 'always',
        kind: 'typecheck',
        cmd: ['node', '-e', 'process.exit(0)'],
        required: true,
      },
      {
        id: 'quick-only',
        kind: 'lint',
        cmd: ['node', '-e', 'process.exit(0)'],
        required: true,
        profiles: ['quick'],
      },
      {
        id: 'merge-only',
        kind: 'test',
        cmd: ['node', '-e', 'process.exit(1)'],
        required: true,
        profiles: ['merge'],
      },
      {
        id: 'deep-only',
        kind: 'build',
        cmd: ['node', '-e', 'process.exit(0)'],
        required: true,
        profiles: ['deep'],
      },
    ]);

    const quick = await runTestsDetailed('p-profile-quick', cfg, 'quick');
    const merge = await runTestsDetailed('p-profile-merge', cfg, 'merge');
    const deep = await runTestsDetailed('p-profile-deep', cfg, 'deep');

    expect(quick.passed).toBe(true);
    expect(quick.commands.map((command) => command.kind)).toEqual(['typecheck', 'lint']);
    expect(merge.passed).toBe(false);
    expect(merge.commands.map((command) => command.kind)).toEqual(['typecheck', 'test']);
    expect(deep.passed).toBe(true);
    expect(deep.commands.map((command) => command.kind)).toEqual(['typecheck', 'build']);
    expect(await runTests('p-profile-merge', cfg)).toBe(merge.passed);
  }, 30_000);

  it('records an optional command failure without failing the profile', async () => {
    repoWithContract([
      {
        id: 'advisory',
        kind: 'lint',
        cmd: ['node', '-e', 'process.exit(1)'],
        required: false,
        profiles: ['merge'],
      },
      {
        id: 'required',
        kind: 'test',
        cmd: ['node', '-e', 'process.exit(0)'],
        required: true,
        profiles: ['merge'],
      },
    ]);

    const result = await runTestsDetailed('p-profile-optional', cfg);

    expect(result.passed).toBe(true);
    expect(result.commands.map((command) => command.ok)).toEqual([false, true]);
  }, 30_000);

  it('honors a repository-declared per-command timeout', async () => {
    repoWithContract([
      {
        id: 'bounded',
        kind: 'test',
        cmd: ['node', '-e', 'setTimeout(() => process.exit(0), 500)'],
        timeoutMs: 25,
        required: true,
        profiles: ['merge'],
      },
    ]);

    const result = await runTestsDetailed('p-profile-timeout', cfg, 'merge');

    expect(result.passed).toBe(false);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.timedOut).toBe(true);
    expect(result.commands[0]?.failureCategory).toBe('timeout');
  }, 30_000);

  it('unapplicable diff → real negative (apply-failed)', async () => {
    repoWith(
      { name: 'fx', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } },
      'diff --git a/nope.txt b/nope.txt\n--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-missing\n+changed\n',
    );
    const r = await runTestsDetailed('p3', cfg);
    expect(r.passed).toBe(false);
    expect(r.skipped).toBe('apply-failed');
  }, 30_000);

  it('no verify commands → NEUTRAL pass (never disqualify a repo without tests)', async () => {
    repoWith({ name: 'fx', version: '1.0.0' }, ADD_FILE_DIFF);
    const r = await runTestsDetailed('p4', cfg);
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe('no-commands');
  }, 30_000);

  it('missing proposal → NEUTRAL pass', async () => {
    fixtureProposal = null;
    const r = await runTestsDetailed('nope', cfg);
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe('no-proposal');
  });
});

// ---------------------------------------------------------------------------
// iterateToGreen
// ---------------------------------------------------------------------------

describe('M331 iterateToGreen', () => {
  const cfgOn = (extra?: Record<string, unknown>): AshlrConfig =>
    ({ version: 1, foundry: { verifyToGreen: { enabled: true, ...extra } } }) as unknown as AshlrConfig;

  it('disabled (default) → 0 iterations, no repair calls', async () => {
    const repair = vi.fn();
    const out = await iterateToGreen({
      cfg: { version: 1, foundry: {} } as unknown as AshlrConfig,
      initialFailure: 'boom',
      verify: async () => ({ pass: true, reason: '' }),
      repair,
    });
    expect(out.stopped).toBe('disabled');
    expect(out.iterations).toBe(0);
    expect(repair).not.toHaveBeenCalled();
  });

  it('green after 2 repairs', async () => {
    let calls = 0;
    const out = await iterateToGreen({
      cfg: cfgOn(),
      initialFailure: 'tsc: error TS0000',
      verify: async () => ({ pass: ++calls >= 2, reason: `still failing (${calls})` }),
      repair: async () => ({ ok: true }),
    });
    expect(out.green).toBe(true);
    expect(out.stopped).toBe('green');
    expect(out.iterations).toBe(2);
    expect(out.lastFailure).toBe('');
  });

  it('repair failure → stops fail-closed', async () => {
    const out = await iterateToGreen({
      cfg: cfgOn(),
      initialFailure: 'boom',
      verify: async () => ({ pass: false, reason: 'x' }),
      repair: async () => null,
    });
    expect(out.green).toBe(false);
    expect(out.stopped).toBe('repair-failed');
    expect(out.iterations).toBe(1);
  });

  it('never green → max-iterations, clamped to 5', async () => {
    const repair = vi.fn(async () => ({ ok: true }));
    const out = await iterateToGreen({
      cfg: cfgOn({ maxIterations: 99 }),
      initialFailure: 'boom',
      verify: async () => ({ pass: false, reason: 'still red' }),
      repair,
    });
    expect(out.green).toBe(false);
    expect(out.stopped).toBe('max-iterations');
    expect(out.iterations).toBe(5);
    expect(repair).toHaveBeenCalledTimes(5);
    expect(out.lastFailure).toBe('still red');
  });

  it('feeds only the failure TAIL to repair', async () => {
    const seen: string[] = [];
    await iterateToGreen({
      cfg: cfgOn({ maxIterations: 1, failureTailBytes: 512 }),
      initialFailure: 'x'.repeat(10_000) + 'THE-END',
      verify: async () => ({ pass: true, reason: '' }),
      repair: async (tail) => {
        seen.push(tail);
        return { ok: true };
      },
    });
    expect(seen[0]!.length).toBe(512);
    expect(seen[0]!.endsWith('THE-END')).toBe(true);
  });

  it('pre-cancelled -> no repair or verification work starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const repair = vi.fn(async () => ({ ok: true }));
    const verify = vi.fn(async () => ({ pass: true, reason: '' }));

    const out = await iterateToGreen({
      cfg: cfgOn(),
      initialFailure: 'boom',
      repair,
      verify,
      signal: controller.signal,
    });

    expect(out).toEqual({
      green: false,
      iterations: 0,
      stopped: 'cancelled',
      lastFailure: 'boom',
    });
    expect(repair).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('cancellation during repair prevents verification and another iteration', async () => {
    const controller = new AbortController();
    const repair = vi.fn(async () => {
      controller.abort();
      return { ok: true };
    });
    const verify = vi.fn(async () => ({ pass: true, reason: '' }));

    const out = await iterateToGreen({
      cfg: cfgOn({ maxIterations: 5 }),
      initialFailure: 'boom',
      repair,
      verify,
      signal: controller.signal,
    });

    expect(out.stopped).toBe('cancelled');
    expect(out.iterations).toBe(1);
    expect(out.green).toBe(false);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });
});

/**
 * M233 — partial-diff-on-timeout tests.
 *
 * Verifies that runEngineSandboxed captures a PENDING proposal even when the
 * engine subprocess times out or exits non-zero, AS LONG AS the worktree
 * contains a non-empty diff. Truly-empty diffs (agent made no edits) must NOT
 * produce a proposal.
 *
 * All runs are hermetic: no real agent is spawned, no network, no LLM.
 * We intercept spawnEngine via vi.mock so we control its return value, and we
 * write real files into the sandbox worktree before the run so sandboxDiff
 * returns a non-empty patch — exactly what a partially-done claude run leaves.
 *
 * SAFETY NOTE: the full judge + merge gate still applies to any proposal
 * produced here; these tests verify the capture path only, not auto-merge.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { withTmpHome } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Mock spawnEngine — we control whether the "run" ok/fails without spawning
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return {
    ...orig,
    // spawnEngine is replaced; all other exports (buildEngineCommand etc.) are real.
    spawnEngine: vi.fn(),
  };
});

import { spawnEngine } from '../src/core/run/engines.js';
import { runEngineSandboxed } from '../src/core/run/sandboxed-engine.js';
import { listProposals } from '../src/core/inbox/store.js';

const spawnEngineMock = spawnEngine as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { providerChain: [] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test 1: partial diff on ETIMEDOUT → PENDING proposal with isPartial:true
// ---------------------------------------------------------------------------

describe('M233 partial-diff capture on timeout', () => {
  it('non-empty diff + engine timeout → PENDING proposal with isPartial:true', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';

      try {
        const repo = fx.makeRepo();
        repo.enroll();

        // spawnEngine returns a timeout error (ETIMEDOUT, ok:false).
        spawnEngineMock.mockReturnValueOnce({
          ok: false,
          output: '',
          error: 'spawnSync claude ETIMEDOUT',
        });

        // Write a real file into the SOURCE repo so we can reference the diff path.
        // BUT: the sandbox worktree is separate — we need to write there AFTER the
        // sandbox is created. Since runEngineSandboxed creates + destroys it in one
        // call, we intercept by making spawnEngine write the file before returning.

        // Strategy: mock spawnEngine to (a) write a file into the worktree cwd
        // passed as cmd.cwd and (b) return ok:false. The cwd IS the worktree path.
        spawnEngineMock.mockReset();
        spawnEngineMock.mockImplementationOnce(
          (cmd: { cwd?: string }, _cfg: unknown, _opts: unknown) => {
            // Write a file into the worktree so sandboxDiff picks it up.
            if (cmd?.cwd && existsSync(cmd.cwd)) {
              const srcDir = join(cmd.cwd, 'src');
              mkdirSync(srcDir, { recursive: true });
              writeFileSync(
                join(srcDir, 'confidence.ts'),
                'export function scoreConfidence(v: number): number { return v; }\n',
                'utf8',
              );
            }
            return {
              ok: false,
              output: '',
              error: 'spawnSync claude ETIMEDOUT',
            };
          },
        );

        // M275: partial-diff-on-timeout capture is tested with completenessGate OFF
        // (flag-off preserves the pre-M275 behavior of filing partial proposals).
        const result = await runEngineSandboxed('claude', 'Add confidence scoring core', makeConfig({ foundry: { completenessGate: false } }), {
          sourceRepo: repo.dir,
          propose: true,
        });

        // Run must not throw and must return 'failed' state.
        expect(result.state.status).toBe('failed');
        expect(result.state.engine).toBe('claude');

        // A partial proposal MUST be created.
        expect(result.proposalId).toBeDefined();
        expect(typeof result.proposalId).toBe('string');

        // The proposal must be in the inbox with isPartial:true.
        const proposals = listProposals();
        const proposal = proposals.find((p) => p.id === result.proposalId);
        expect(proposal).toBeDefined();
        expect(proposal!.isPartial).toBe(true);
        expect(proposal!.status).toBe('pending');
        expect(proposal!.title).toContain('[partial]');
        expect(proposal!.diff).toBeTruthy();
        expect(proposal!.diff!.length).toBeGreaterThan(0);

        // Safety: full trust fields are still populated (judge gate still applies).
        expect(proposal!.engineModel).toBeDefined();
        expect(proposal!.engineTier).toBeDefined();
        expect(proposal!.diffHash).toBeDefined();
        expect(proposal!.provenanceSig).toBeDefined();
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test 2: truly-empty diff + engine failure → NO proposal (run stays blocked)
// ---------------------------------------------------------------------------

describe('M233 truly-empty diff on failure', () => {
  it('empty diff + engine failure → no proposal filed, status failed', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';

      try {
        const repo = fx.makeRepo();
        repo.enroll();

        // spawnEngine fails BUT writes no files → empty diff.
        spawnEngineMock.mockImplementationOnce(() => ({
          ok: false,
          output: '',
          error: 'exit 127',
        }));

        const result = await runEngineSandboxed('claude', 'Do nothing at all', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
        });

        // Run fails.
        expect(result.state.status).toBe('failed');

        // No proposal because diff was empty.
        expect(result.proposalId).toBeUndefined();
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test 3: successful run still produces a clean (non-partial) proposal
// ---------------------------------------------------------------------------

describe('M233 successful run still produces a clean proposal', () => {
  it('ok:true + non-empty diff → proposal with isPartial undefined/false', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';

      try {
        const repo = fx.makeRepo();
        repo.enroll();

        spawnEngineMock.mockImplementationOnce(
          (cmd: { cwd?: string }, _cfg: unknown, _opts: unknown) => {
            if (cmd?.cwd && existsSync(cmd.cwd)) {
              writeFileSync(
                join(cmd.cwd, 'output.ts'),
                'export const result = 42;\n',
                'utf8',
              );
            }
            return { ok: true, output: '{}', usage: { tokensIn: 100, tokensOut: 50 } };
          },
        );

        const result = await runEngineSandboxed('claude', 'Write output.ts', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
        });

        expect(result.state.status).toBe('done');
        expect(result.proposalId).toBeDefined();

        const proposals = listProposals();
        const proposal = proposals.find((p) => p.id === result.proposalId);
        expect(proposal).toBeDefined();
        // Not partial — clean run.
        expect(proposal!.isPartial).toBeFalsy();
        expect(proposal!.title).not.toContain('[partial]');
        expect(proposal!.status).toBe('pending');
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test 4: timeout is a GENEROUS backstop (agents work long), not an aggressive cap
// ---------------------------------------------------------------------------

describe('M233 timeout is a generous backstop, not an aggressive cap', () => {
  it('default timeoutMs is the 2h backstop (agents run long); cfg.foundry.timeoutMs overrides', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';

      try {
        const repo = fx.makeRepo();
        repo.enroll();

        spawnEngineMock.mockImplementationOnce(() => ({
          ok: false,
          output: '',
          error: 'exit 1',
        }));

        await runEngineSandboxed('claude', 'Check timeout', makeConfig(), {
          sourceRepo: repo.dir,
          propose: false,
        });

        expect(spawnEngineMock).toHaveBeenCalled();
        const callOpts = spawnEngineMock.mock.calls[0][2] as { timeoutMs?: number };
        // Generous backstop — real agents work long; NOT an aggressive small cap.
        expect(callOpts?.timeoutMs).toBe(2 * 60 * 60_000);
        expect(callOpts?.timeoutMs).toBeGreaterThan(20 * 60_000);

        // cfg.foundry.timeoutMs overrides the default backstop.
        spawnEngineMock.mockImplementationOnce(() => ({
          ok: false,
          output: '',
          error: 'exit 1',
        }));
        await runEngineSandboxed(
          'claude',
          'Check override',
          makeConfig({ foundry: { timeoutMs: 99_000 } } as Partial<AshlrConfig>),
          { sourceRepo: repo.dir, propose: false },
        );
        const callOpts2 = spawnEngineMock.mock.calls[1][2] as { timeoutMs?: number };
        expect(callOpts2?.timeoutMs).toBe(99_000);
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });
});

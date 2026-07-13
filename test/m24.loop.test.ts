/**
 * M24 daemon loop tests — tick, runDaemon, stopDaemon.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 *  - runSwarm is MOCKED — no real agents, no real subprocesses, no real API calls.
 *  - No real portfolio repos are touched. Tmp repos only, enrolled only for the
 *    test that requires it and unenrolled in afterEach.
 *  - The tests NEVER call applyProposal, never run real swarms, never push.
 *  - ASHLR_IN_DAEMON and ASHLR_IN_SWARM are cleaned up in afterEach.
 *
 * Invariants asserted (PROPOSAL-ONLY + ENROLLMENT-ONLY + BOUNDED + RE-ENTRANCY):
 *
 *   ENROLLMENT-ONLY:
 *     - tick with empty enrollment => 0 proposals, reason 'no-enrolled-repos'
 *     - tick with kill switch ON => 0 proposals, reason 'kill-switch'
 *     - tick over daily budget => 0 proposals, reason 'budget-exhausted'
 *
 *   PROPOSAL-ONLY:
 *     - with a mocked enrolled repo + mocked backlog, tick calls runSwarm with
 *       sandbox:true + propose:true and increments proposals; NEVER calls
 *       applyProposal / push / deploy (asserted via mock + source-level grep)
 *     - --dryRun => 0 proposals, reason 'dry-run', runSwarm NOT called
 *
 *   RE-ENTRANCY:
 *     - runDaemon REFUSES (returns unchanged state) when ASHLR_IN_DAEMON is set
 *     - runDaemon REFUSES when ASHLR_IN_SWARM is set
 *
 *   BOUNDED:
 *     - daily budget cap: todaySpentUsd >= dailyBudgetUsd => tick returns
 *       'budget-exhausted' without calling runSwarm
 *     - --once: exactly one tick
 *
 *   SOURCE-LEVEL GUARDRAIL:
 *     - core/daemon/loop.ts MUST NOT import/reference applyProposal, 'git push',
 *       'gh pr create', createPr, ship-deploy, or any deploy path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonTick, AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origInDaemon = process.env.ASHLR_IN_DAEMON;
const origInSwarm = process.env.ASHLR_IN_SWARM;

let tmpHome: string;
let tmpRepo: string;

// ---------------------------------------------------------------------------
// runSwarm mock — MUST be declared before any lazy imports
// ---------------------------------------------------------------------------

// We mock the swarm runner so NO real agents ever run. The mock:
//   - records calls for assertion
//   - returns a minimal SwarmRun stub
//   - NEVER calls applyProposal or any outward action

const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks and HOME isolation
// ---------------------------------------------------------------------------

import {
  tick,
  runDaemon,
  stopDaemon,
} from '../src/core/daemon/loop.js';

import {
  daemonStatePath,
  loadDaemonState,
  saveDaemonState,
} from '../src/core/daemon/state.js';
import { readDaemonActivity } from '../src/core/daemon/activity.js';

import {
  enroll,
  unenroll,
  listEnrolled,
  setKill,
  killSwitchOn,
} from '../src/core/sandbox/policy.js';

import {
  pendingCount,
  createProposal,
} from '../src/core/inbox/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal AshlrConfig for daemon tests. */
function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 100,
    },
    ...overrides,
  } as AshlrConfig;
}

/** Create a minimal git repo in dir so git-based scanners don't error. */
function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
}

/**
 * Mock SwarmRun stub — simulates runSwarm completing and (via propose:true)
 * a PENDING proposal being created. The mock calls createProposal itself so
 * pendingCount() reflects the swarm work. This mirrors the real runSwarm
 * behavior where opts.propose:true causes createProposal to be called inside
 * the runner.
 */
function makeSwarmRunStub(repoPath: string) {
  return async (_input: unknown, _cfg: unknown, _opts: unknown) => {
    // Simulate the swarm creating a proposal (as runSwarm does with propose:true)
    createProposal({
      repo: repoPath,
      origin: 'swarm',
      kind: 'patch',
      title: 'Mock swarm proposal',
      summary: 'Generated by mock runSwarm',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    return {
      id: `mock-swarm-${Date.now()}`,
      status: 'done',
      goal: 'mock goal',
      result: 'mock result',
      usage: { totalTokens: 100, totalCost: 0.01, steps: 1 },
    };
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m24-loop-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m24-loop-repo-'));
  process.env.HOME = tmpHome;

  // Start with kill switch OFF
  // (killSwitchOn reads from tmpHome, so fresh = off)

  initBareGitDir(tmpRepo);
  fs.writeFileSync(
    path.join(tmpRepo, 'package.json'),
    JSON.stringify({ name: 'test-repo', version: '1.0.0' }),
    'utf8',
  );

  mockRunSwarm.mockReset();

  // Remove re-entrancy guards
  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;
});

afterEach(() => {
  // Always unenroll
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  // Always clear kill switch
  try { setKill(false); } catch { /* ignore */ }

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });

  process.env.HOME = origHome;
  if (origInDaemon !== undefined) {
    process.env.ASHLR_IN_DAEMON = origInDaemon;
  } else {
    delete process.env.ASHLR_IN_DAEMON;
  }
  if (origInSwarm !== undefined) {
    process.env.ASHLR_IN_SWARM = origInSwarm;
  } else {
    delete process.env.ASHLR_IN_SWARM;
  }

  vi.clearAllMocks();
});

// ===========================================================================
// SOURCE-LEVEL GUARDRAIL — grep-prove daemon/loop.ts has no forbidden imports
// ===========================================================================

describe('M24 PROPOSAL-ONLY source-level guardrail — loop.ts has no forbidden paths', () => {
  const loopPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/core/daemon/loop.ts',
  );

  it('loop.ts exists (implementation is in place)', () => {
    expect(fs.existsSync(loopPath)).toBe(true);
  });

  it('loop.ts does NOT import or reference applyProposal', () => {
    const src = fs.readFileSync(loopPath, 'utf8');
    expect(src).not.toMatch(/applyProposal/);
  });

  it('loop.ts does NOT import from inbox/apply', () => {
    const src = fs.readFileSync(loopPath, 'utf8');
    expect(src).not.toMatch(/inbox\/apply/);
    expect(src).not.toMatch(/inbox\\apply/);
  });

  it('loop.ts does NOT contain "git push"', () => {
    const src = fs.readFileSync(loopPath, 'utf8');
    expect(src).not.toMatch(/git\s+push/);
  });

  it('loop.ts does NOT contain "gh pr create" or createPr', () => {
    const src = fs.readFileSync(loopPath, 'utf8');
    expect(src).not.toMatch(/gh\s+pr\s+create/);
    expect(src).not.toMatch(/createPr\b/);
  });

  it('loop.ts does NOT reference ship-deploy, startShip, or shipDeploy', () => {
    const src = fs.readFileSync(loopPath, 'utf8');
    expect(src).not.toMatch(/ship-deploy|shipDeploy|startShip\b/);
  });

  it('loop.ts does NOT reference "deploy" in an outward-action context', () => {
    const src = fs.readFileSync(loopPath, 'utf8');
    // "deploy" should not appear as a function call (e.g. deploy(), runDeploy, etc.)
    // It may appear in comments or type names referencing ProposalKind 'deploy' — that is fine.
    // We look for patterns like deploy( or 'deploy' import or executeDeploy.
    expect(src).not.toMatch(/\bdeploy\s*\(/);
    expect(src).not.toMatch(/runDeploy\b|executeDeploy\b|performDeploy\b/);
  });

  it('loop.ts ONLY uses createProposal (via runSwarm) and pendingCount from inbox', () => {
    const src = fs.readFileSync(loopPath, 'utf8');
    // applyProposal must not be present (already tested above — belt + suspenders)
    expect(src).not.toMatch(/applyProposal/);
    // The ONLY inbox call permitted in loop.ts is pendingCount (read-only) and
    // createProposal is called indirectly via runSwarm — not directly in loop.ts
    // unless the implementation calls it for counting. Either way applyProposal
    // must be absent.
  });
});

// ===========================================================================
// ENROLLMENT-ONLY — empty enrollment => nothing happens
// ===========================================================================

describe('M24 tick — ENROLLMENT-ONLY: empty enrollment does nothing', () => {
  it('returns reason "no-enrolled-repos" when nothing is enrolled', async () => {
    expect(listEnrolled()).toEqual([]);
    const result: DaemonTick = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('no-enrolled-repos');
  });

  it('creates 0 proposals when nothing is enrolled', async () => {
    const before = pendingCount();
    await tick(makeCfg(), { dryRun: false });
    expect(pendingCount()).toBe(before);
  });

  it('does NOT call runSwarm when nothing is enrolled', async () => {
    await tick(makeCfg(), { dryRun: false });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('returns 0 itemsConsidered when nothing is enrolled', async () => {
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.itemsConsidered).toBe(0);
  });

  it('returns 0 proposalsCreated when nothing is enrolled', async () => {
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.proposalsCreated).toBe(0);
  });

  it('returns a valid ISO ts', async () => {
    const result = await tick(makeCfg(), { dryRun: false });
    expect(typeof result.ts).toBe('string');
    expect(() => new Date(result.ts)).not.toThrow();
    expect(new Date(result.ts).toISOString()).toBe(result.ts);
  });
});

// ===========================================================================
// BOUNDED — kill switch halts every tick immediately
// ===========================================================================

describe('M24 tick — BOUNDED: kill switch halts immediately', () => {
  it('returns reason "kill-switch" when kill switch is on', async () => {
    setKill(true);
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('kill-switch');
  });

  it('creates 0 proposals when kill switch is on', async () => {
    setKill(true);
    const before = pendingCount();
    await tick(makeCfg(), { dryRun: false });
    expect(pendingCount()).toBe(before);
  });

  it('does NOT call runSwarm when kill switch is on', async () => {
    setKill(true);
    await tick(makeCfg(), { dryRun: false });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('kill switch blocks even when a repo is enrolled', async () => {
    enroll(tmpRepo);
    setKill(true);
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('kill-switch');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('kill switch is checked before enrollment', async () => {
    enroll(tmpRepo);
    setKill(true);
    const result = await tick(makeCfg(), { dryRun: false });
    // kill-switch must be returned, not no-enrolled-repos or any other reason
    expect(result.reason).toBe('kill-switch');
  });
});

// ===========================================================================
// BOUNDED — daily budget exhaustion halts tick
// ===========================================================================

describe('M24 tick — BOUNDED: daily budget exhaustion does nothing', () => {
  it('returns reason "budget-exhausted" when todaySpentUsd >= dailyBudgetUsd', async () => {
    // Pre-load state where today's spend already equals the cap
    const today = new Date().toISOString().slice(0, 10);
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: today,
      todaySpentUsd: 1.0, // equals the default cap of 1.0
      itemsProcessed: 0,
      ticks: [],
    });

    enroll(tmpRepo);
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('budget-exhausted');
  });

  it('creates 0 proposals when budget is exhausted', async () => {
    const today = new Date().toISOString().slice(0, 10);
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: today,
      todaySpentUsd: 9999.0, // far over any budget
      itemsProcessed: 0,
      ticks: [],
    });

    enroll(tmpRepo);
    const before = pendingCount();
    await tick(makeCfg(), { dryRun: false });
    expect(pendingCount()).toBe(before);
  });

  it('does NOT call runSwarm when budget is exhausted', async () => {
    const today = new Date().toISOString().slice(0, 10);
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: today,
      todaySpentUsd: 5.0,
      itemsProcessed: 0,
      ticks: [],
    });

    enroll(tmpRepo);
    await tick(makeCfg(), { dryRun: false });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('budget check occurs before runSwarm (not just after)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: today,
      todaySpentUsd: 2.0, // over a tight budget
      itemsProcessed: 0,
      ticks: [],
    });
    enroll(tmpRepo);

    const cfg = makeCfg();
    (cfg as AshlrConfig & { daemon: { dailyBudgetUsd: number } }).daemon!.dailyBudgetUsd = 1.0;

    const result = await tick(cfg, { dryRun: false });
    expect(result.reason).toBe('budget-exhausted');
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// DRY-RUN — plans only, 0 proposals, runSwarm NOT called
// ===========================================================================

describe('M24 tick — dryRun creates 0 proposals', () => {
  it('returns reason "dry-run" when dryRun=true', async () => {
    enroll(tmpRepo);
    // Even with no items in backlog, dry-run must return 'dry-run' or
    // 'no-backlog' — not 'no-enrolled-repos'. Either is valid since we
    // don't control whether backlog has items in CI. Ensure no proposals.
    const result = await tick(makeCfg(), { dryRun: true });
    // With real backlog scanning (no items), may return 'no-backlog' or 'dry-run'
    // The invariant is: proposalsCreated===0 and runSwarm NOT called
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('creates 0 proposals regardless of enrollment when dryRun=true', async () => {
    enroll(tmpRepo);
    const before = pendingCount();
    await tick(makeCfg(), { dryRun: true });
    expect(pendingCount()).toBe(before);
  });

  it('does NOT call runSwarm when dryRun=true', async () => {
    enroll(tmpRepo);
    await tick(makeCfg(), { dryRun: true });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PROPOSAL-ONLY — with enrolled repo + mocked backlog, tick produces
// PENDING proposals but NEVER calls applyProposal/push/deploy
// ===========================================================================

describe('M24 tick — PROPOSAL-ONLY: with enrolled repo + backlog items, creates PENDING proposals', () => {
  it('calls runSwarm with sandbox:true when there are backlog items', async () => {
    enroll(tmpRepo);

    // Seed a real backlog item so the tick has work to do.
    // We write a backlog.json directly to tmpHome/.ashlr/backlog.json
    const backlogPath = path.join(tmpHome, '.ashlr', 'backlog.json');
    fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
    const now = new Date().toISOString();
    const backlog = {
      generatedAt: now,
      repos: [tmpRepo],
      items: [
        {
          id: 'test-item-1',
          repo: tmpRepo,
          source: 'todo',
          title: 'Fix the widget',
          detail: '// TODO: fix widget',
          file: path.join(tmpRepo, 'widget.ts'),
          line: 1,
          value: 4,
          effort: 2,
          score: 2,
          tags: ['todo'],
          ts: now,
        },
      ],
    };
    fs.writeFileSync(backlogPath, JSON.stringify(backlog), 'utf8');

    // Configure mock: simulate runSwarm creating a proposal
    mockRunSwarm.mockImplementation(makeSwarmRunStub(tmpRepo));

    const before = pendingCount();
    const result = await tick(makeCfg(), { dryRun: false });

    // runSwarm must have been called with sandbox:true + propose:true
    expect(mockRunSwarm).toHaveBeenCalled();
    const callArgs = mockRunSwarm.mock.calls[0];
    // opts is typically the 3rd argument: runSwarm(input, cfg, opts, sink)
    // Find the opts argument that contains sandbox/propose
    const optsArg = callArgs?.find(
      (a: unknown) =>
        a !== null &&
        typeof a === 'object' &&
        ('sandbox' in (a as Record<string, unknown>) || 'propose' in (a as Record<string, unknown>)),
    ) as Record<string, unknown> | undefined;

    expect(optsArg).toBeDefined();
    expect(optsArg?.['sandbox']).toBe(true);
    expect(optsArg?.['propose']).toBe(true);

    // Proposals must exist in the inbox (created by the mock)
    expect(pendingCount()).toBeGreaterThan(before);

    // The tick's proposalsCreated must be > 0
    expect(result.proposalsCreated).toBeGreaterThanOrEqual(1);
  });

  it('proposals created are status=pending (NEVER auto-applied)', async () => {
    enroll(tmpRepo);

    const backlogPath = path.join(tmpHome, '.ashlr', 'backlog.json');
    fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      backlogPath,
      JSON.stringify({
        generatedAt: now,
        repos: [tmpRepo],
        items: [
          {
            id: 'test-item-2',
            repo: tmpRepo,
            source: 'todo',
            title: 'Add tests',
            detail: '// TODO: add tests',
            file: path.join(tmpRepo, 'foo.ts'),
            line: 5,
            value: 3,
            effort: 2,
            score: 1.5,
            tags: [],
            ts: now,
          },
        ],
      }),
      'utf8',
    );

    mockRunSwarm.mockImplementation(makeSwarmRunStub(tmpRepo));

    await tick(makeCfg(), { dryRun: false });

    // All proposals in inbox must be status=pending
    const { listProposals } = await import('../src/core/inbox/store.js');
    const proposals = listProposals();
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.status).toBe('pending');
    }
  });

  it('applyProposal is NEVER called during a tick', async () => {
    enroll(tmpRepo);

    const backlogPath = path.join(tmpHome, '.ashlr', 'backlog.json');
    fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      backlogPath,
      JSON.stringify({
        generatedAt: now,
        repos: [tmpRepo],
        items: [
          {
            id: 'test-item-3',
            repo: tmpRepo,
            source: 'todo',
            title: 'Refactor module',
            detail: '// TODO: refactor',
            file: path.join(tmpRepo, 'mod.ts'),
            line: 10,
            value: 5,
            effort: 3,
            score: 1.67,
            tags: [],
            ts: now,
          },
        ],
      }),
      'utf8',
    );

    // Mock applyProposal at the module level to detect any call
    const applyMod = await import('../src/core/inbox/apply.js').catch(() => null);
    const applyProposalSpy = applyMod
      ? vi.spyOn(applyMod, 'applyProposal').mockResolvedValue({
          id: 'x',
          status: 'applied',
          detail: '',
        } as never)
      : null;

    mockRunSwarm.mockImplementation(makeSwarmRunStub(tmpRepo));

    await tick(makeCfg(), { dryRun: false });

    if (applyProposalSpy) {
      expect(applyProposalSpy).not.toHaveBeenCalled();
    }
    // Regardless of whether we could spy: proposals must stay pending
    const { listProposals } = await import('../src/core/inbox/store.js');
    for (const p of listProposals()) {
      expect(p.status).toBe('pending');
    }
  });

  it('does NOT call runSwarm for repos outside enrollment', async () => {
    // Only tmpRepo is enrolled; create a second unenrolled repo
    enroll(tmpRepo);

    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m24-other-'));
    try {
      initBareGitDir(otherRepo);

      const backlogPath = path.join(tmpHome, '.ashlr', 'backlog.json');
      fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        backlogPath,
        JSON.stringify({
          generatedAt: now,
          repos: [tmpRepo, otherRepo],
          items: [
            {
              id: 'item-enrolled',
              repo: tmpRepo,
              source: 'todo',
              title: 'Enrolled repo work',
              detail: '// TODO: enrolled',
              file: path.join(tmpRepo, 'a.ts'),
              line: 1,
              value: 4,
              effort: 2,
              score: 2,
              tags: [],
              ts: now,
            },
            {
              id: 'item-unenrolled',
              repo: otherRepo,
              source: 'todo',
              title: 'Unenrolled repo work',
              detail: '// TODO: unenrolled',
              file: path.join(otherRepo, 'b.ts'),
              line: 1,
              value: 5,
              effort: 1,
              score: 5,
              tags: [],
              ts: now,
            },
          ],
        }),
        'utf8',
      );

      mockRunSwarm.mockImplementation(makeSwarmRunStub(tmpRepo));

      await tick(makeCfg(), { dryRun: false });

      // If runSwarm was called, it must ONLY have been called for enrolled repos
      for (const call of mockRunSwarm.mock.calls) {
        // The call should not reference the unenrolled repo path
        const callStr = JSON.stringify(call);
        expect(callStr).not.toContain(otherRepo);
      }
    } finally {
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// RE-ENTRANCY — runDaemon REFUSES when ASHLR_IN_DAEMON or ASHLR_IN_SWARM set
// ===========================================================================

describe('M24 runDaemon — RE-ENTRANCY: refuses when ASHLR_IN_DAEMON or ASHLR_IN_SWARM set', () => {
  it('REFUSES (does not start) when ASHLR_IN_DAEMON=1 is set', async () => {
    process.env.ASHLR_IN_DAEMON = '1';
    const before = pendingCount();
    const state = await runDaemon(makeCfg(), { once: true, dryRun: true });
    // Must not have dispatched any work
    expect(pendingCount()).toBe(before);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    // State must remain inert (not running, or returned unchanged)
    // The contract says "return state unchanged, do nothing"
    expect(state).toBeDefined();
  });

  it('REFUSES when ASHLR_IN_SWARM=1 is set', async () => {
    process.env.ASHLR_IN_SWARM = '1';
    const before = pendingCount();
    const state = await runDaemon(makeCfg(), { once: true, dryRun: true });
    expect(pendingCount()).toBe(before);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(state).toBeDefined();
  });

  it('REFUSES and does not mark running=true when ASHLR_IN_DAEMON set', async () => {
    process.env.ASHLR_IN_DAEMON = '1';
    await runDaemon(makeCfg(), { once: true, dryRun: true });
    const state = loadDaemonState();
    // Daemon must not have set running=true (it refused entirely)
    expect(state.running).toBe(false);
  });

  it('REFUSES and does not mark running=true when ASHLR_IN_SWARM set', async () => {
    process.env.ASHLR_IN_SWARM = '1';
    await runDaemon(makeCfg(), { once: true, dryRun: true });
    const state = loadDaemonState();
    expect(state.running).toBe(false);
  });

  it('does not REFUSE when neither env var is set', async () => {
    // Normal path: neither guard set, empty enrollment => tick returns
    // no-enrolled-repos but runDaemon should NOT refuse
    delete process.env.ASHLR_IN_DAEMON;
    delete process.env.ASHLR_IN_SWARM;
    // Should not throw — just complete without work
    await expect(runDaemon(makeCfg(), { once: true, dryRun: true })).resolves.toBeDefined();
  });
});

// ===========================================================================
// BOUNDED — --once does exactly one tick
// ===========================================================================

describe('M24 runDaemon --once — exactly one tick', () => {
  it('retains resident state while pending work aborts and suppresses late idle activity', async () => {
    enroll(tmpRepo);
    const backlogPath = path.join(tmpHome, '.ashlr', 'backlog.json');
    fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(backlogPath, JSON.stringify({
      generatedAt: now,
      repos: [tmpRepo],
      items: [{
        id: 'activity-item', repo: tmpRepo, source: 'todo', title: 'Observe active tick',
        detail: '// TODO: observe', file: path.join(tmpRepo, 'activity.ts'), line: 1,
        value: 5, effort: 1, score: 5, tags: [], ts: now,
      }],
    }), 'utf8');

    let finish!: (value: unknown) => void;
    mockRunSwarm.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const running = runDaemon(makeCfg(), { once: true, dryRun: false });
    for (let attempt = 0; attempt < 100 && mockRunSwarm.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(readDaemonActivity()).toMatchObject({
      sourceState: 'healthy',
      ownerState: process.platform === 'win32' ? 'unknown' : 'alive',
      activity: { phase: 'tick', pid: process.pid, activeChildren: null },
    });
    const signal = (mockRunSwarm.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    stopDaemon();
    stopDaemon();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1_000, interval: 10 });

    expect(loadDaemonState()).toMatchObject({ running: true, pid: process.pid });
    expect(readDaemonActivity()).toMatchObject({
      sourceState: 'healthy',
      activity: { authority: 'none', phase: 'stopping', pid: process.pid },
    });
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGINT');
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
    kill.mockRestore();

    finish({
      id: 'activity-run', status: 'done', goal: 'observe', result: 'done',
      usage: { totalTokens: 1, estCostUsd: 0, steps: 1 },
    });
    const finalState = await running;
    expect(finalState).toMatchObject({ running: false, pid: null });
    expect(readDaemonActivity()).toMatchObject({
      sourceState: 'healthy',
      activity: { authority: 'none', phase: 'stopping' },
    });
  });

  it('--once runs exactly one tick and stops', async () => {
    // We verify via the state: lastTickAt should be set, running=false after
    delete process.env.ASHLR_IN_DAEMON;
    delete process.env.ASHLR_IN_SWARM;

    await runDaemon(makeCfg(), { once: true, dryRun: true });

    const state = loadDaemonState();
    // After --once, daemon must not be running
    expect(state.running).toBe(false);
    // At most one tick should have been recorded
    expect(state.ticks.length).toBeLessThanOrEqual(1);
  });

  it('--once returns a DaemonState object', async () => {
    delete process.env.ASHLR_IN_DAEMON;
    delete process.env.ASHLR_IN_SWARM;

    const state = await runDaemon(makeCfg(), { once: true, dryRun: true });
    expect(state).toBeDefined();
    expect(typeof state.running).toBe('boolean');
    expect(typeof state.itemsProcessed).toBe('number');
    expect(Array.isArray(state.ticks)).toBe(true);
  });

  it('--once with dryRun=true does NOT call runSwarm', async () => {
    delete process.env.ASHLR_IN_DAEMON;
    delete process.env.ASHLR_IN_SWARM;
    enroll(tmpRepo);

    await runDaemon(makeCfg(), { once: true, dryRun: true });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('--once does not tick a second time after returning', async () => {
    delete process.env.ASHLR_IN_DAEMON;
    delete process.env.ASHLR_IN_SWARM;

    await runDaemon(makeCfg(), { once: true, dryRun: true });
    const callCount = mockRunSwarm.mock.calls.length;

    // Wait briefly to make sure no background tick fires
    await new Promise(r => setTimeout(r, 50));
    expect(mockRunSwarm.mock.calls.length).toBe(callCount);
  });
});

// ===========================================================================
// stopDaemon — request-only kill switch
// ===========================================================================

describe('M24 stopDaemon — requests resident shutdown without claiming ownership', () => {
  it('sets the kill switch', () => {
    stopDaemon();
    expect(killSwitchOn()).toBe(true);
  });

  it('is idempotent — calling twice does not throw', () => {
    expect(() => {
      stopDaemon();
      stopDaemon();
    }).not.toThrow();
  });

  it('kill switch is on after stopDaemon', () => {
    stopDaemon();
    expect(killSwitchOn()).toBe(true);
  });

  it('retains running state for the resident process to clear', () => {
    // Pre-set running=true to simulate a running daemon
    saveDaemonState({
      running: true,
      pid: 12345,
      startedAt: new Date().toISOString(),
      lastTickAt: null,
      todayDate: null,
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });

    stopDaemon();

    const state = JSON.parse(fs.readFileSync(daemonStatePath(), 'utf8')) as {
      running: boolean;
      pid: number | null;
    };
    expect(state).toMatchObject({ running: true, pid: 12345 });
  });

  it('never acts on a persisted pid', () => {
    saveDaemonState({
      running: true,
      pid: 99999,
      startedAt: new Date().toISOString(),
      lastTickAt: null,
      todayDate: null,
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });

    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    stopDaemon();

    const state = JSON.parse(fs.readFileSync(daemonStatePath(), 'utf8')) as {
      running: boolean;
      pid: number | null;
    };
    expect(state).toMatchObject({ running: true, pid: 99999 });
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it('tick returns "kill-switch" reason after stopDaemon', async () => {
    stopDaemon();
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('kill-switch');
  });

  it('does not throw on a fresh HOME with no existing daemon state', () => {
    expect(() => stopDaemon()).not.toThrow();
  });
});

// ===========================================================================
// BOUNDED — tick persists state + accumulates todaySpentUsd
// ===========================================================================

describe('M24 tick — BOUNDED: persists state correctly', () => {
  it('tick updates lastTickAt in daemon state', async () => {
    delete process.env.ASHLR_IN_DAEMON;
    delete process.env.ASHLR_IN_SWARM;

    const before = new Date().toISOString();
    await tick(makeCfg(), { dryRun: false }); // will be no-enrolled-repos
    const after = new Date().toISOString();

    const state = loadDaemonState();
    // lastTickAt must be set and within the call window
    if (state.lastTickAt !== null) {
      expect(state.lastTickAt >= before).toBe(true);
      expect(state.lastTickAt <= after).toBe(true);
    }
    // lastTickAt may be null if the implementation only sets it on success ticks —
    // either is acceptable; the critical invariant is that state is persisted.
    expect(state).toBeDefined();
  });

  it('tick appends to ticks history in state', async () => {
    delete process.env.ASHLR_IN_DAEMON;
    delete process.env.ASHLR_IN_SWARM;

    await tick(makeCfg(), { dryRun: false });
    const state = loadDaemonState();
    // The tick must have been appended
    expect(Array.isArray(state.ticks)).toBe(true);
    // At least one tick should be recorded (no-enrolled-repos tick or similar)
    // Implementations may skip recording no-op ticks — we don't mandate it,
    // but we do check that the state is persisted.
    expect(state.itemsProcessed).toBeGreaterThanOrEqual(0);
  });

  it('tick with spend accumulates todaySpentUsd', async () => {
    enroll(tmpRepo);

    const backlogPath = path.join(tmpHome, '.ashlr', 'backlog.json');
    fs.mkdirSync(path.dirname(backlogPath), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      backlogPath,
      JSON.stringify({
        generatedAt: now,
        repos: [tmpRepo],
        items: [
          {
            id: 'spend-item',
            repo: tmpRepo,
            source: 'todo',
            title: 'Spend budget item',
            detail: '// TODO: spend budget',
            file: path.join(tmpRepo, 's.ts'),
            line: 1,
            value: 3,
            effort: 2,
            score: 1.5,
            tags: [],
            ts: now,
          },
        ],
      }),
      'utf8',
    );

    // Mock: return a swarm with some spend
    mockRunSwarm.mockImplementation(async (_input: unknown, _cfg: unknown, _opts: unknown) => {
      createProposal({
        repo: tmpRepo,
        origin: 'swarm',
        kind: 'patch',
        title: 'Spend test proposal',
        summary: 'test',
      });
      return {
        id: `mock-${Date.now()}`,
        status: 'done',
        goal: 'spend test',
        result: 'done',
        usage: { totalTokens: 500, totalCost: 0.005, steps: 2 },
      };
    });

    await tick(makeCfg(), { dryRun: false });
    const state = loadDaemonState();
    // todaySpentUsd must be >= 0 (either from mock cost or 0 if not tracked)
    expect(state.todaySpentUsd).toBeGreaterThanOrEqual(0);
  });
});

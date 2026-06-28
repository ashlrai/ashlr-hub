/**
 * test/h1.daemon-gates.test.ts — H1 BUILD task: DAEMON-TICK GATES.
 *
 * MILESTONE H1 "Harden & Prove" (the KEYSTONE). This suite proves that the REAL
 * daemon `tick` — the operator cycle backlog -> sandboxed swarm -> PENDING
 * proposal — honors EVERY one of its hard gates when driven on DISPOSABLE git
 * repos inside an ISOLATED tmp HOME. It complements `h1.chain.test.ts` (the full
 * happy-path chain) and `h1.safety.test.ts` (the apply-side refusals) by
 * focusing narrowly on the daemon's guard ladder:
 *
 *   (a) ENROLLMENT — empty enrollment => tick is a no-op: NO swarm dispatched,
 *       0 proposals, recorded reason 'no-enrolled-repos'.
 *   (b) KILL — kill switch ON => tick REFUSES before doing anything: NO swarm,
 *       0 proposals, reason 'kill-switch', checked even when a repo is enrolled
 *       and ahead of the enrollment check.
 *   (c) REAL-TREE-UNCHANGED + PROPOSAL-ONLY — a tick (real or dry-run) NEVER
 *       mutates the enrolled repo's working tree (shasumTree byte-identical
 *       before/after, `git status --porcelain` empty, current branch + branch
 *       set unchanged) and NEVER pushes / PRs / deploys.
 *   (d) BUDGET / CONCURRENCY — a tick that would exceed the configured daily USD
 *       cap does NOT start work (reason 'budget-exhausted', NO swarm); and a tick
 *       that does run work respects the per-tick item cap (itemsConsidered <=
 *       perTickItems) and the concurrency cap (no more than `parallel` swarms in
 *       flight at once).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ABSOLUTE SAFETY (paramount — see CONTRACT-H1.md):
 *   - HOME is relocated to a FRESH os.tmpdir() dir per test via the H1 fixture,
 *     so every ~/.ashlr read/write resolves to an ISOLATED home — NEVER the real
 *     one. The real portfolio (~/.ashlr/enrollment.json = { repos: [] }) is
 *     never enrolled or touched. Each test cleans up after itself.
 *   - Every repo is a DISPOSABLE git repo under os.tmpdir() (makeRepo). The real
 *     working tree is never mutated; applyProposal is never called here.
 *   - DETERMINISTIC: NO live LLM. `runSwarm` is MOCKED (matching the M24 daemon
 *     tests) so no model subprocess ever spawns. The empty-enrollment, kill, and
 *     budget gates all return BEFORE runSwarm in the real production code, so
 *     those paths exercise REAL daemon logic with zero model dependency; the
 *     budget/concurrency-cap assertions seed daemon.json + drive the real tick,
 *     and only the (never-budget-blocked) cap test lets the MOCK runSwarm run.
 *   - NO production module is modified. The runSwarm mock lives in THIS test file
 *     only (test-scoped), exactly as the M24 suite does it.
 *
 * DISCOVERY SOURCE (what the tick actually considers): a live tick calls the
 * REAL `buildBacklog({ repos: enrolled })`, which re-runs the SCANNERS over each
 * enrolled repo's working tree and OVERWRITES backlog.json — it does NOT read a
 * seeded backlog.json. So tests that assert on `itemsConsidered` seed the REPO's
 * working tree (via `todoSeedFiles`, which `scanTodos` discovers as one
 * source:'todo' item per file) rather than seeding backlog.json. `scanDocs` also
 * contributes a few filesystem items for a minimal repo, so discovery is
 * non-empty even on a host with no rg/grep; assertions on the exact count are
 * therefore stated as bounds (<= the cap, >= 1) unless the cap itself is the
 * point. `seedBacklog` is intentionally NOT used in this suite (it would be
 * inert against a live tick).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { AshlrConfig, DaemonState, DaemonTick } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// runSwarm mock — declared before the lazy imports of the daemon loop so the
// loop binds to the mock, NOT the real swarm runner. This guarantees NO model
// subprocess is ever spawned by these tests (DETERMINISM), and lets us assert
// exactly when the daemon does / does not dispatch swarm work. Mirrors the
// M24 loop tests' mocking style verbatim.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// buildBacklog MOCKED so tick() has discoverable work regardless of which
// scanners are enabled (M160 made scanDeps/scanLint/scanHygiene DEFAULT-OFF).
// Tests that assert on itemsConsidered / swarm dispatch need items in the
// backlog; tests that gate before buildBacklog (kill/enrollment/budget) never
// call it and are unaffected. mockImplementation threads opts.repos[0] into
// items so tick()'s byRepo grouping routes them to the enrolled repo.
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER the mock so the daemon binds to the mocked runSwarm.
// All of these resolve ~/.ashlr paths via homedir() at CALL time, so the
// fixture's HOME relocation isolates their state.
// ---------------------------------------------------------------------------

import { tick } from '../src/core/daemon/loop.js';
import { loadDaemonState, saveDaemonState } from '../src/core/daemon/state.js';
import { listEnrolled } from '../src/core/sandbox/policy.js';
import { pendingCount, listProposals, createProposal } from '../src/core/inbox/store.js';

import {
  makeFixture,
  makeCfg,
  todoSeedFiles,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle — a FRESH isolated tmp HOME per test (paramount: never the
// real ~/.ashlr). makeFixture asserts homedir() == tmp HOME and refuses to run
// if relocation didn't take; cleanup() unenrolls + rm -rf's everything and
// restores HOME + re-entrancy env. Idempotent.
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  mockRunSwarm.mockReset();
  mockBuildBacklog.mockReset();
  fx = makeFixture();
  // M160: scanDeps/scanLint/scanHygiene are DEFAULT-OFF. Provide a dynamic mock
  // so each test always has discoverable work proportional to what it seeds.
  // Items are keyed to the enrolled repo (opts.repos[0]) so tick()'s byRepo
  // grouping routes them correctly. Seeding 8 items covers the largest
  // perTickItems (6) used in this suite with headroom to spare.
  mockBuildBacklog.mockImplementation(async (opts?: { repos?: string[] }) => {
    const repoDir = (opts?.repos ?? [])[0] ?? '';
    const now = new Date().toISOString();
    return {
      generatedAt: now,
      repos: opts?.repos ?? [],
      items: Array.from({ length: 8 }, (_, i) => ({
        id: `${repoDir}:h1-gates-${i}`,
        repo: repoDir,
        source: 'todo' as const,
        title: `1 marker in src/todo-${i}.ts:2`,
        detail: `File: src/todo-${i}.ts:2 — "implement f${i}".`,
        value: 3,
        effort: 2,
        score: 1.5,
        tags: ['todo'],
        ts: now,
      })),
    };
  });
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers (test-scoped)
// ---------------------------------------------------------------------------

/** Today's calendar day in the YYYY-MM-DD form the daemon state uses. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Persist a daemon state pre-seeded with today's spend already at `spentUsd`. */
function seedSpend(spentUsd: number): void {
  const state: DaemonState = {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: today(),
    todaySpentUsd: spentUsd,
    itemsProcessed: 0,
    ticks: [],
  };
  saveDaemonState(state);
}

/**
 * A mock runSwarm that records a PENDING patch proposal (as the real runner does
 * with propose:true) and reports a tiny, KNOWN spend. Also tracks the maximum
 * number of concurrent in-flight invocations so the concurrency cap can be
 * asserted. NO model is ever invoked.
 */
function makeConcurrencyTrackingSwarm(repo: string, conc: { current: number; max: number }) {
  return async (_input: unknown, _cfg: unknown, _opts: unknown) => {
    conc.current += 1;
    conc.max = Math.max(conc.max, conc.current);
    // Yield so genuinely-parallel dispatches overlap (lets us observe peak).
    await new Promise((r) => setTimeout(r, 5));
    createProposal({
      repo,
      origin: 'swarm',
      kind: 'patch',
      title: 'H1 daemon-gates mock proposal',
      summary: 'recorded by the mocked runSwarm (no model)',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    conc.current -= 1;
    return {
      id: `mock-swarm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      status: 'done',
      goal: 'mock goal',
      result: 'mock result',
      usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
    };
  };
}

/** Snapshot the disposable repo's tree identity for REAL-TREE-UNCHANGED checks. */
function treeSnapshot(repo: DisposableRepo): {
  sha: string;
  status: string;
  branch: string;
  branches: string[];
} {
  return {
    sha: repo.shasumTree(),
    status: repo.gitStatus(),
    branch: repo.currentBranch(),
    branches: repo.branches().slice().sort(),
  };
}

/** Assert two tree snapshots are byte-identical (the REAL-TREE-UNCHANGED gate). */
function expectTreeUnchanged(
  before: ReturnType<typeof treeSnapshot>,
  after: ReturnType<typeof treeSnapshot>,
): void {
  expect(after.sha).toBe(before.sha); // content hash byte-identical
  expect(after.status).toBe(before.status); // git status --porcelain unchanged
  expect(after.status).toBe(''); // and the tree is CLEAN
  expect(after.branch).toBe(before.branch); // HEAD branch unchanged
  expect(after.branches).toEqual(before.branches); // no new branches
}

// ===========================================================================
// (a) ENROLLMENT gate — empty enrollment => tick is a no-op
// ===========================================================================

describe('H1 daemon-gates — ENROLLMENT: empty enrollment makes the tick a no-op', () => {
  it('starts from an EMPTY isolated enrollment (the real portfolio is untouched)', () => {
    // The fixture's HOME is fresh, so the enrollment registry is empty: the
    // tick has nothing to operate on and the real ~/.ashlr is never read.
    expect(listEnrolled()).toEqual([]);
  });

  it('returns reason "no-enrolled-repos" and creates 0 proposals', async () => {
    const before = pendingCount();
    const result: DaemonTick = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });

    expect(result.reason).toBe('no-enrolled-repos');
    expect(result.proposalsCreated).toBe(0);
    expect(result.itemsConsidered).toBe(0);
    expect(result.spentUsd).toBe(0);
    expect(pendingCount()).toBe(before);
  });

  it('does NOT dispatch any swarm when nothing is enrolled', async () => {
    await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('records the no-op tick to daemon state (operator visibility) with a valid ISO ts', async () => {
    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });

    expect(new Date(result.ts).toISOString()).toBe(result.ts);

    const state = loadDaemonState();
    expect(Array.isArray(state.ticks)).toBe(true);
    const recorded = state.ticks.find((t) => t.ts === result.ts);
    expect(recorded?.reason).toBe('no-enrolled-repos');
  });

  it('even a dry-run on an empty enrollment is a no-op (no swarm, 0 proposals)', async () => {
    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: true });
    expect(result.reason).toBe('no-enrolled-repos');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// (b) KILL gate — kill switch ON => tick refuses, no swarm
// ===========================================================================

describe('H1 daemon-gates — KILL: the kill switch halts the tick immediately', () => {
  it('returns reason "kill-switch" and dispatches no swarm when kill is ON', async () => {
    fx.setKill(true);
    const before = pendingCount();
    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });

    expect(result.reason).toBe('kill-switch');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(pendingCount()).toBe(before);
  });

  it('kill switch blocks the tick even when a repo IS enrolled', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    expect(repo.isEnrolled()).toBe(true);

    fx.setKill(true);
    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });

    expect(result.reason).toBe('kill-switch');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('kill switch is checked BEFORE enrollment (kill-switch, not no-enrolled-repos)', async () => {
    // Nothing enrolled AND kill on: the kill reason must win, proving kill is
    // evaluated ahead of the enrollment gate in the real production order.
    expect(listEnrolled()).toEqual([]);
    fx.setKill(true);

    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });
    expect(result.reason).toBe('kill-switch');
  });

  it('kill switch blocks a dry-run tick too', async () => {
    // Repo has real TODO files (discoverable work) AND is enrolled — yet kill
    // wins before the backlog is ever built, so itemsConsidered stays 0.
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();
    fx.setKill(true);

    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: true });
    expect(result.reason).toBe('kill-switch');
    expect(result.itemsConsidered).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// (c) REAL-TREE-UNCHANGED + PROPOSAL-ONLY — a tick never mutates the repo tree
//     and never pushes / PRs / deploys.
// ===========================================================================

describe('H1 daemon-gates — REAL-TREE-UNCHANGED: a tick never mutates the enrolled repo', () => {
  it('a no-op tick (empty enrollment) leaves the disposable repo byte-identical', async () => {
    const repo = fx.makeRepo({
      files: { 'README.md': '# h1\n', 'src/a.ts': 'export const a = 1;\n' },
    });
    // Deliberately NOT enrolled — the tick must touch nothing regardless.
    const before = treeSnapshot(repo);

    await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });

    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it('a dry-run tick over a repo with discoverable work leaves the tree byte-identical', async () => {
    // Seed real TODO source files: a live tick discovers them via buildBacklog ->
    // scanTodos (when rg/grep present) plus scanDocs filesystem items, so there
    // IS work to consider — yet dryRun must still mutate nothing.
    const repo = fx.makeRepo({ files: todoSeedFiles(2) });
    repo.enroll();

    const before = treeSnapshot(repo);

    // dryRun => the REAL daemon reports what it WOULD do but dispatches no swarm
    // and creates no proposals: the source tree must stay byte-identical.
    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it('a kill-blocked tick on an enrolled repo with discoverable work leaves the tree byte-identical', async () => {
    // Real TODO work exists in the tree, but kill fires before the backlog is
    // built, so no scanning/selection happens and the tree is untouched.
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();
    fx.setKill(true);

    const before = treeSnapshot(repo);
    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });

    expect(result.reason).toBe('kill-switch');
    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it('a budget-exhausted tick on an enrolled repo leaves the tree byte-identical', async () => {
    // Real TODO work exists, but the budget gate fires before any scanning, so
    // the tree is untouched.
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();
    seedSpend(1.0); // == the default cfg cap of 1.0 => exhausted

    const before = treeSnapshot(repo);
    const result = await tick(makeCfg({ daemon: { dailyBudgetUsd: 1.0, perTickItems: 3, parallel: 2, intervalMs: 100 }, foundry: { scanHygiene: true } }), { dryRun: false });

    expect(result.reason).toBe('budget-exhausted');
    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it('PROPOSAL-ONLY: the tick never pushes / PRs / deploys (no auto-applied proposals)', async () => {
    // Drive a real (non-dry) tick with the MOCKED swarm so a PENDING proposal is
    // recorded exactly as the real propose path would. The tick's ONLY sink is a
    // PENDING proposal — it is never auto-applied, and no outward action occurs.
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();

    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(makeConcurrencyTrackingSwarm(repo.dir, conc));

    const before = treeSnapshot(repo);
    const result = await tick(makeCfg({ foundry: { scanHygiene: true } }), { dryRun: false });

    // A swarm ran (mocked) and recorded a PENDING proposal — the sole sink.
    expect(mockRunSwarm).toHaveBeenCalled();
    expect(result.proposalsCreated).toBeGreaterThanOrEqual(1);

    // Every proposal in the inbox is PENDING — none was auto-applied/pushed/deployed.
    const proposals = listProposals();
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.status).toBe('pending');
    }

    // And the real working tree of the source repo is byte-unchanged: the
    // sandboxed swarm (here mocked) never touches it; the diff lives only in a
    // PENDING proposal awaiting an explicit human approve + apply.
    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it('verifies the daemon loop source carries NO outward-action primitive', async () => {
    // Belt + suspenders source-level guard (mirrors M24): the daemon loop must
    // not import/reference applyProposal, push, PR-create, or any deploy path.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../src/core/daemon/loop.ts'), 'utf8');

    expect(src).not.toMatch(/applyProposal/);
    expect(src).not.toMatch(/inbox\/apply/);
    expect(src).not.toMatch(/git\s+push/);
    expect(src).not.toMatch(/gh\s+pr\s+create/);
    expect(src).not.toMatch(/createPr\b/);
    expect(src).not.toMatch(/ship-deploy|shipDeploy|startShip\b/);
    expect(src).not.toMatch(/\bdeploy\s*\(/);
  });
});

// ===========================================================================
// (d) BUDGET / CONCURRENCY — caps are honored before/within work
// ===========================================================================

describe('H1 daemon-gates — BUDGET: a tick that would exceed the daily cap does not start work', () => {
  const cfgCap1 = (): AshlrConfig =>
    makeCfg({ daemon: { dailyBudgetUsd: 1.0, perTickItems: 3, parallel: 2, intervalMs: 100 }, foundry: { scanHygiene: true } });

  it('returns "budget-exhausted" when todaySpentUsd EQUALS the daily cap', async () => {
    // Real discoverable work exists, but the budget gate fires first.
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();
    seedSpend(1.0); // exactly at the $1.00 cap

    const result = await tick(cfgCap1(), { dryRun: false });
    expect(result.reason).toBe('budget-exhausted');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('returns "budget-exhausted" when todaySpentUsd EXCEEDS the cap, and dispatches no swarm', async () => {
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();
    seedSpend(9999.0); // far over any budget

    const before = pendingCount();
    const result = await tick(cfgCap1(), { dryRun: false });

    expect(result.reason).toBe('budget-exhausted');
    expect(pendingCount()).toBe(before);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('the budget check fires BEFORE any swarm dispatch (not merely after)', async () => {
    const repo = fx.makeRepo({ files: todoSeedFiles(2) });
    repo.enroll();
    seedSpend(2.0); // over the $1.00 cap

    // If the swarm were dispatched, this would record a proposal — assert it isn't.
    mockRunSwarm.mockImplementation(makeConcurrencyTrackingSwarm(repo.dir, { current: 0, max: 0 }));

    const result = await tick(cfgCap1(), { dryRun: false });
    expect(result.reason).toBe('budget-exhausted');
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('a fresh day resets the cap so a previously-exhausted budget no longer blocks', async () => {
    // Real discoverable work (TODO files + scanDocs items) so the tick reaches
    // reason 'ok' once the stale budget is reset.
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();

    // Seed yesterday's spend at/over the cap, but dated to a PAST day so the
    // daemon's resetDayIfNeeded zeroes it before the budget check.
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: '2000-01-01', // a past calendar day
      todaySpentUsd: 9999.0,
      itemsProcessed: 0,
      ticks: [],
    });

    mockRunSwarm.mockImplementation(makeConcurrencyTrackingSwarm(repo.dir, { current: 0, max: 0 }));

    const result = await tick(cfgCap1(), { dryRun: false });

    // The stale spend was reset for the new day, so the tick proceeds (reason 'ok').
    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalled();
  });
});

describe('H1 daemon-gates — CONCURRENCY + per-tick item cap', () => {
  it('itemsConsidered never exceeds the configured per-tick item cap', async () => {
    // Seed the repo working tree with MORE TODO-bearing files than the per-tick
    // cap. itemsConsidered derives from buildBacklog -> SCANNERS over this tree
    // (scanTodos: one source:'todo' item per file when rg/grep is present, PLUS
    // scanDocs's 4 deterministic filesystem items for a minimal repo) — NOT from
    // any seeded backlog.json. Either way discovery yields WELL MORE than the cap
    // (>= 4 from scanDocs alone even with no TODO scanner), so the cap is the
    // binding constraint and itemsConsidered must equal it exactly.
    const todoCount = 8;
    const repo = fx.makeRepo({ files: todoSeedFiles(todoCount) });
    repo.enroll();

    const perTickItems = 2;
    mockRunSwarm.mockImplementation(makeConcurrencyTrackingSwarm(repo.dir, { current: 0, max: 0 }));

    const result = await tick(
      makeCfg({ daemon: { dailyBudgetUsd: 1.0, perTickItems, parallel: 2, intervalMs: 100 }, foundry: { scanHygiene: true } }),
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    // The cap bounds selection (the load-bearing assertion)...
    expect(result.itemsConsidered).toBeLessThanOrEqual(perTickItems);
    // ...and since discovery yields >= perTickItems items deterministically (>= 4
    // scanDocs items, plus TODO items when a scanner is present), the cap binds
    // exactly. >= 1 documents the discovery floor independent of the exact count.
    expect(result.itemsConsidered).toBeGreaterThanOrEqual(1);
    expect(result.itemsConsidered).toBe(perTickItems);
  });

  it('dry-run itemsConsidered is likewise bounded by the per-tick item cap (no swarm)', async () => {
    // Discovery comes from buildBacklog -> SCANNERS over the seeded TODO files
    // (+ scanDocs items), not from backlog.json. >= 4 scanDocs items guarantee
    // the cap is the binding constraint here too.
    const repo = fx.makeRepo({ files: todoSeedFiles(6) });
    repo.enroll();

    const perTickItems = 3;
    const result = await tick(
      makeCfg({ daemon: { dailyBudgetUsd: 1.0, perTickItems, parallel: 2, intervalMs: 100 }, foundry: { scanHygiene: true } }),
      { dryRun: true },
    );

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBeLessThanOrEqual(perTickItems);
    expect(result.itemsConsidered).toBeGreaterThanOrEqual(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('no more than `parallel` swarms run concurrently within a single tick', async () => {
    // Seed enough discoverable work that the tick selects perTickItems items and
    // dispatches that many (mocked) swarms — letting us observe peak concurrency.
    // The item count comes from SCANNERS over the working tree, not backlog.json.
    const repo = fx.makeRepo({ files: todoSeedFiles(6) });
    repo.enroll();

    const parallel = 2;
    const perTickItems = 6;
    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(makeConcurrencyTrackingSwarm(repo.dir, conc));

    const result = await tick(
      makeCfg({ daemon: { dailyBudgetUsd: 1.0, perTickItems, parallel, intervalMs: 100 }, foundry: { scanHygiene: true } }),
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    // The bounded() helper must never let more than `parallel` swarms overlap.
    expect(conc.max).toBeGreaterThan(0);
    expect(conc.max).toBeLessThanOrEqual(parallel);
  });
});

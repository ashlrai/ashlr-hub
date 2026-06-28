/**
 * test/h1.safety.test.ts — H1 BUILD task 2: SAFETY GUARANTEES (the gates).
 *
 * Proves the chain REFUSES at every gate and never mutates the real tree when a
 * guard is tripped. All on DISPOSABLE repos in an ISOLATED tmp HOME.
 *
 * Invariants proven: ENROLLMENT honored, KILL honored, BUDGET honored,
 * PROPOSAL-ONLY (a tick's only sink is a PENDING proposal), REAL-TREE-UNCHANGED
 * across every refusal.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ABSOLUTE SAFETY (paramount — see CONTRACT-H1.md):
 *   - HOME is relocated to a FRESH os.tmpdir() dir per test via the H1 fixture,
 *     so every ~/.ashlr read/write resolves to an ISOLATED home — NEVER the real
 *     one. The real portfolio (~/.ashlr/enrollment.json = { repos: [] }) is never
 *     enrolled or touched. Each test cleans up after itself.
 *   - Every repo is a DISPOSABLE git repo under os.tmpdir() (makeRepo).
 *   - DETERMINISTIC: NO live LLM. `runSwarm` is MOCKED (matching the M24 daemon
 *     tests / h1.daemon-gates) so no model subprocess ever spawns. Every gate
 *     under test (empty-enrollment / kill / budget) returns BEFORE runSwarm in
 *     the real production code, so these paths exercise REAL daemon logic with
 *     zero model dependency; the apply-side gates drive the REAL applyProposal /
 *     createSandbox against a KNOWN unified diff. The mock exists only so a
 *     misconfigured test can never accidentally spawn a model.
 *   - NO production module is modified. The runSwarm mock lives in THIS test file
 *     only (test-scoped), exactly as the M24 + h1.daemon-gates suites do it. The
 *     only production seam used is the EXISTING `allowAnyRepo` hatch on
 *     createSandbox, exercised solely to probe the not-enrolled refusal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { DaemonState } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// runSwarm mock — declared before the lazy imports of the daemon loop so the
// loop binds to the mock, NOT the real swarm runner. Guarantees NO model
// subprocess is ever spawned (DETERMINISM). Mirrors the h1.daemon-gates style.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// buildBacklog MOCKED so tick() has discoverable work regardless of which
// scanners are enabled (M160 made scanDeps/scanLint/scanHygiene DEFAULT-OFF).
// The safety tests assert on per-tick item cap bounding — mocking the backlog
// provides the items without depending on scanner availability.
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

// ---------------------------------------------------------------------------
// Imports AFTER the mock so the daemon binds to the mocked runSwarm. All resolve
// ~/.ashlr paths via homedir() at CALL time, so HOME relocation isolates state.
// ---------------------------------------------------------------------------

import { tick } from '../src/core/daemon/loop.js';
import { saveDaemonState } from '../src/core/daemon/state.js';
import { listEnrolled } from '../src/core/sandbox/policy.js';
import { createSandbox, removeSandbox } from '../src/core/sandbox/worktree.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { applyProposal } from '../src/core/inbox/apply.js';

import {
  makeFixture,
  makeCfg,
  makeAddFileDiff,
  todoSeedFiles,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle — a FRESH isolated tmp HOME per test (paramount: never the
// real ~/.ashlr). cleanup() unenrolls + rm -rf's everything and restores HOME.
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  mockRunSwarm.mockReset();
  mockBuildBacklog.mockReset();
  fx = makeFixture();
  // M160: scanDeps/scanLint/scanHygiene are DEFAULT-OFF. Provide a dynamic mock
  // keyed to the enrolled repo (opts.repos[0]) so tests that reach buildBacklog
  // always have discoverable work. Tests that gate before buildBacklog (kill /
  // enrollment / budget / confirm-status) never call this and are unaffected.
  // 8 items covers the largest perTickItems used here (2) with plenty to spare.
  mockBuildBacklog.mockImplementation(async (opts?: { repos?: string[] }) => {
    const repoDir = (opts?.repos ?? [])[0] ?? '';
    const now = new Date().toISOString();
    return {
      generatedAt: now,
      repos: opts?.repos ?? [],
      items: Array.from({ length: 8 }, (_, i) => ({
        id: `${repoDir}:h1-safety-${i}`,
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

/** A deterministic patch that adds one new file — the swarm's propose output. */
const PATCH_FILE = 'h1-safety.txt';
const PATCH_BODY = 'applied by H1 safety\n';
function makePatchProposal(repo: DisposableRepo) {
  return createProposal({
    repo: repo.dir,
    origin: 'manual',
    kind: 'patch',
    title: 'H1 safety patch',
    summary: 'Adds a single deterministic file on a new branch.',
    diff: makeAddFileDiff(PATCH_FILE, PATCH_BODY),
  });
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
  expect(
    after.branches.some((b) => b.startsWith('ashlr/proposal/')),
    'a refused gate must never create an ashlr/proposal/ branch',
  ).toBe(false);
}

// ===========================================================================
// ENROLLMENT gate
// ===========================================================================

describe('H1 safety — ENROLLMENT gate', () => {
  it('tick on an EMPTY enrollment returns reason "no-enrolled-repos" and creates 0 proposals', async () => {
    // The fixture's HOME is fresh, so the enrollment registry is empty.
    expect(listEnrolled()).toEqual([]);

    const result = await tick(makeCfg(), { dryRun: false });

    expect(result.reason).toBe('no-enrolled-repos');
    expect(result.proposalsCreated).toBe(0);
    expect(result.itemsConsidered).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it(
    'applyProposal on a NON-enrolled tmp repo refuses (ok:false), leaves status=approved, ' +
      'creates no branch, and the working tree is byte-unchanged',
    async () => {
      const repo = fx.makeRepo(); // deliberately NOT enrolled
      expect(repo.isEnrolled()).toBe(false);

      const p = makePatchProposal(repo);
      setStatus(p.id, 'approved');

      const before = treeSnapshot(repo);
      const result = await applyProposal(p.id, { confirmed: true });

      expect(result.ok).toBe(false);
      // Refusal — NOT a failure: the approved proposal survives for retry.
      expect(loadProposal(p.id)!.status).toBe('approved');
      expectTreeUnchanged(before, treeSnapshot(repo));
    },
  );

  it(
    'createSandbox on a NON-enrolled repo without allowAnyRepo throws (refused) and ' +
      'leaves the source repo untouched',
    () => {
      const repo = fx.makeRepo(); // deliberately NOT enrolled
      const before = treeSnapshot(repo);

      // No allowAnyRepo hatch => assertMayMutate must refuse (throw).
      expect(() => createSandbox(repo.dir)).toThrow();

      // A refused createSandbox leaves the source repo completely untouched.
      expectTreeUnchanged(before, treeSnapshot(repo));

      // The existing allowAnyRepo seam DOES permit a sandbox on a tmp repo. It
      // adds an ashlr/sandbox/<id> worktree branch (shared refs), but NEVER
      // mutates the source WORKING TREE, index, or HEAD — and never an
      // ashlr/proposal/ branch. removeSandbox tears the worktree branch back
      // down, restoring the branch set byte-for-byte.
      // H5 CHANGE 3: the allowAnyRepo hatch is now env-gated, so set
      // ASHLR_TEST_ALLOW_ANY_REPO=1 for the success path (restore after).
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      const sb = createSandbox(repo.dir, { allowAnyRepo: true });
      try {
        const during = treeSnapshot(repo);
        expect(during.sha).toBe(before.sha); // working tree byte-identical
        expect(during.status).toBe(''); // index/working tree clean
        expect(during.branch).toBe(before.branch); // HEAD never moved
        expect(during.branches.some((b) => b.startsWith('ashlr/proposal/'))).toBe(false);
      } finally {
        removeSandbox(sb);
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
      // After teardown the source repo is byte-identical to the start.
      expectTreeUnchanged(before, treeSnapshot(repo));
    },
  );
});

// ===========================================================================
// KILL switch gate
// ===========================================================================

describe('H1 safety — KILL switch gate', () => {
  it('tick with kill switch ON returns reason "kill-switch", creates 0 proposals', async () => {
    // Real discoverable work (TODO files) exists, but kill fires before the
    // backlog is built, so nothing is scanned/selected.
    const repo = fx.makeRepo({ files: todoSeedFiles(1) });
    repo.enroll();

    fx.setKill(true);
    const before = treeSnapshot(repo);
    const result = await tick(makeCfg(), { dryRun: false });

    expect(result.reason).toBe('kill-switch');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it(
    'applyProposal with kill switch ON refuses even for approved+confirmed+enrolled, ' +
      'status stays approved, no branch created',
    async () => {
      const repo = fx.makeRepo();
      repo.enroll();
      const p = makePatchProposal(repo);
      setStatus(p.id, 'approved');

      fx.setKill(true); // halt the only outward path regardless of enrollment

      const before = treeSnapshot(repo);
      const result = await applyProposal(p.id, { confirmed: true });

      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/kill/i);
      expect(loadProposal(p.id)!.status).toBe('approved');
      expectTreeUnchanged(before, treeSnapshot(repo));
    },
  );

  it('kill switch is checked BEFORE enrollment in the tick', async () => {
    // Nothing enrolled AND kill on: the kill reason must win, proving kill is
    // evaluated ahead of the enrollment gate in the real production order.
    expect(listEnrolled()).toEqual([]);
    fx.setKill(true);

    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('kill-switch');
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// BUDGET gate
// ===========================================================================

describe('H1 safety — BUDGET gate', () => {
  const cfgCap1 = () =>
    makeCfg({ daemon: { dailyBudgetUsd: 1.0, perTickItems: 3, parallel: 2, intervalMs: 100 } });

  it(
    'tick with todaySpentUsd >= dailyBudgetUsd returns reason "budget-exhausted" ' +
      'and creates 0 proposals',
    async () => {
      // Real discoverable work exists, but the budget gate fires before scanning.
      const repo = fx.makeRepo({ files: todoSeedFiles(1) });
      repo.enroll();
      seedSpend(1.0); // exactly at the $1.00 cap

      const before = treeSnapshot(repo);
      const result = await tick(cfgCap1(), { dryRun: false });

      expect(result.reason).toBe('budget-exhausted');
      expect(result.proposalsCreated).toBe(0);
      expect(mockRunSwarm).not.toHaveBeenCalled();
      expectTreeUnchanged(before, treeSnapshot(repo));
    },
  );

  it('the per-tick item cap bounds itemsConsidered to at most perTickItems', async () => {
    // Seed MORE TODO-bearing files than the per-tick cap. itemsConsidered derives
    // from buildBacklog -> SCANNERS over this working tree (scanTodos items when
    // rg/grep is present, PLUS scanDocs's 4 deterministic filesystem items) — NOT
    // from any seeded backlog.json. Discovery thus yields >= 4 items (>= the cap)
    // even with no TODO scanner, so the cap is the binding constraint.
    const repo = fx.makeRepo({ files: todoSeedFiles(8) });
    repo.enroll();

    const perTickItems = 2;
    // dry-run avoids any swarm dispatch; selection is still bounded by the cap.
    const result = await tick(
      makeCfg({ daemon: { dailyBudgetUsd: 1.0, perTickItems, parallel: 2, intervalMs: 100 } }),
      { dryRun: true },
    );

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBeLessThanOrEqual(perTickItems);
    expect(result.itemsConsidered).toBeGreaterThanOrEqual(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CONFIRM + STATUS gates
// ===========================================================================

describe('H1 safety — CONFIRM + STATUS gates', () => {
  it('applyProposal refuses an approved proposal when confirmed:false (status stays approved)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'approved');

    const before = treeSnapshot(repo);
    const result = await applyProposal(p.id, { confirmed: false });

    expect(result.ok).toBe(false);
    expect(loadProposal(p.id)!.status).toBe('approved');
    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it('applyProposal refuses a pending proposal even when confirmed:true (status stays pending)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    expect(p.status).toBe('pending');

    const before = treeSnapshot(repo);
    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(false);
    expect(loadProposal(p.id)!.status).toBe('pending'); // not burned
    expectTreeUnchanged(before, treeSnapshot(repo));
  });

  it('applyProposal refuses a rejected proposal', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'rejected');

    const before = treeSnapshot(repo);
    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(false);
    expect(loadProposal(p.id)!.status).toBe('rejected');
    expectTreeUnchanged(before, treeSnapshot(repo));
  });
});

// ===========================================================================
// REAL-TREE-UNCHANGED across every refusal (parametrized)
// ===========================================================================

describe('H1 safety — REAL-TREE-UNCHANGED across every refusal', () => {
  type Gate = {
    name: string;
    arrange: (repo: DisposableRepo) => Promise<() => Promise<{ ok: boolean }>>;
  };

  const gates: Gate[] = [
    {
      name: 'not-enrolled',
      arrange: async (repo) => {
        const p = makePatchProposal(repo); // repo NOT enrolled
        setStatus(p.id, 'approved');
        return () => applyProposal(p.id, { confirmed: true });
      },
    },
    {
      name: 'kill',
      arrange: async (repo) => {
        repo.enroll();
        const p = makePatchProposal(repo);
        setStatus(p.id, 'approved');
        fx.setKill(true);
        return () => applyProposal(p.id, { confirmed: true });
      },
    },
    {
      name: 'pending',
      arrange: async (repo) => {
        repo.enroll();
        const p = makePatchProposal(repo);
        return () => applyProposal(p.id, { confirmed: true });
      },
    },
    {
      name: 'unconfirmed',
      arrange: async (repo) => {
        repo.enroll();
        const p = makePatchProposal(repo);
        setStatus(p.id, 'approved');
        return () => applyProposal(p.id, { confirmed: false });
      },
    },
  ];

  for (const gate of gates) {
    it(
      `shasumTree + git status are byte-identical before/after the refused "${gate.name}" gate`,
      async () => {
        const repo = fx.makeRepo({
          files: { 'README.md': '# h1\n', 'src/a.ts': 'export const a = 1;\n' },
        });
        const attempt = await gate.arrange(repo);

        const before = treeSnapshot(repo);
        const result = await attempt();

        expect(result.ok).toBe(false);
        expectTreeUnchanged(before, treeSnapshot(repo));
      },
    );
  }
});

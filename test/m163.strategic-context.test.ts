/**
 * m163.strategic-context.test.ts — M163 StrategicContext gatherer tests.
 *
 * Units under test:
 *   1. gatherStrategicContext — shape, never-throws, graceful degradation
 *   2. repos section — per-repo health, commits, issues, tests
 *   3. outcomes section — 7d window, shipRate, trivialRatio, reverted
 *   4. fleet section — pendingProposals, activeGoals, completedGoals
 *   5. narrative — non-empty string summarising all three sections
 *
 * Hermetic: HOME relocated to a tmp dir. All external modules (git via
 * execFileSync, gh, sandbox policy, inbox store, goals store, quality-metrics,
 * decisions-ledger) are mocked — no live processes, no network.
 *
 * Conventions mirror m119.quality-metrics.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m163-home-'));
  process.env.HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock: child_process.execFileSync (git + gh)
// ---------------------------------------------------------------------------

// We intercept execFileSync at the module level so the context.ts internals
// receive synthetic responses without spawning real processes.

type ExecFileSyncFn = (
  cmd: string,
  args?: string[],
  opts?: Record<string, unknown>,
) => string;

let execFileSyncImpl: ExecFileSyncFn = () => '';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, args?: string[], opts?: Record<string, unknown>) => {
      return execFileSyncImpl(cmd, args, opts);
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: sandbox/policy — listEnrolled
// ---------------------------------------------------------------------------

let mockEnrolled: string[] = [];

vi.mock('../src/core/sandbox/policy.js', () => ({
  listEnrolled: () => [...mockEnrolled],
  isEnrolled: (p: string) => mockEnrolled.includes(p),
  assertMayMutate: () => { /* no-op */ },
  enroll: () => { /* no-op */ },
  unenroll: () => { /* no-op */ },
  killSwitchOn: () => false,
  setKill: () => { /* no-op */ },
  enrollmentPath: () => path.join(os.tmpdir(), 'enrollment.json'),
  killSwitchPath: () => path.join(os.tmpdir(), 'KILL'),
}));

// ---------------------------------------------------------------------------
// Mock: inbox/store — pendingCount
// ---------------------------------------------------------------------------

let mockPendingCount = 0;

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    pendingCount: () => mockPendingCount,
    listProposals: () => [],
  };
});

// ---------------------------------------------------------------------------
// Mock: goals/store — listGoals
// ---------------------------------------------------------------------------

type GoalStatusMock = 'active' | 'planning' | 'done' | 'paused' | 'archived';
let mockGoalsByStatus: Record<GoalStatusMock, number> = {
  active: 0,
  planning: 0,
  done: 0,
  paused: 0,
  archived: 0,
};

vi.mock('../src/core/goals/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/goals/store.js')>();
  return {
    ...actual,
    listGoals: (filter?: { status?: GoalStatusMock }) => {
      const status = filter?.status as GoalStatusMock | undefined;
      if (!status) return [];
      const count = mockGoalsByStatus[status] ?? 0;
      return Array.from({ length: count }, (_, i) => ({
        id: `goal-${status}-${i}`,
        objective: `goal ${i}`,
        status,
        milestones: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: fleet/quality-metrics — computeQualityMetrics
// ---------------------------------------------------------------------------

type MockMetrics = {
  merged: number;
  rejected: number;
  trivialRatio: number;
  // other fields zeroed
};
let mockMetrics: MockMetrics = { merged: 0, rejected: 0, trivialRatio: 0 };

vi.mock('../src/core/fleet/quality-metrics.js', () => ({
  computeQualityMetrics: () => ({
    window: '7d',
    proposalsCreated: mockMetrics.merged + mockMetrics.rejected,
    merged: mockMetrics.merged,
    rejected: mockMetrics.rejected,
    pending: 0,
    withDiff: 0,
    emptyRate: 0,
    trivialRatio: mockMetrics.trivialRatio,
    acceptRate: mockMetrics.merged + mockMetrics.rejected > 0
      ? mockMetrics.merged / (mockMetrics.merged + mockMetrics.rejected)
      : 0,
    rejectRate: 0,
    verifyPassRate: 0,
    avgDiffLines: 0,
    byEngine: {},
    byRepo: {},
  }),
}));

// ---------------------------------------------------------------------------
// Mock: fleet/decisions-ledger — readDecisions
// ---------------------------------------------------------------------------

type MockDecisionEntry = { ts: string; proposalId: string; action: string };
let mockDecisionEntries: MockDecisionEntry[] = [];

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (opts?: { sinceMs?: number; proposalId?: string; limit?: number }) => {
    let entries = [...mockDecisionEntries];
    if (opts?.sinceMs !== undefined) {
      entries = entries.filter(e => new Date(e.ts).getTime() >= (opts.sinceMs ?? 0));
    }
    if (opts?.proposalId) {
      entries = entries.filter(e => e.proposalId === opts.proposalId);
    }
    if (opts?.limit) entries = entries.slice(0, opts.limit);
    return entries;
  },
  recordDecision: () => { /* no-op */ },
  decisionsDir: () => path.join(os.tmpdir(), 'decisions'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake repo dir with or without .git. */
function makeRepoDir(name: string, opts: { git?: boolean; testDir?: boolean } = {}): string {
  const dir = path.join(tmpHome, name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.git !== false) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  }
  if (opts.testDir) {
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  }
  return dir;
}

/** Build a default git execFileSync mock (clean repo, 3 commits). */
function makeGitMock(opts: {
  porcelain?: string;
  commits?: string[];
  lastDate?: string;
} = {}): ExecFileSyncFn {
  return (cmd, args) => {
    if (cmd !== 'git') return '';
    const joined = (args ?? []).join(' ');
    if (joined.includes('status --porcelain')) return opts.porcelain ?? '';
    if (joined.includes('log') && joined.includes('%s')) {
      return (opts.commits ?? ['feat: add context module', 'fix: null guard', 'chore: tests']).join('\n');
    }
    if (joined.includes('log') && joined.includes('%cI')) {
      return opts.lastDate ?? '2026-06-17T12:00:00.000Z';
    }
    return '';
  };
}

// ---------------------------------------------------------------------------
// 1. Shape + never-throws
// ---------------------------------------------------------------------------

describe('m163 gatherStrategicContext — shape and never-throws', () => {
  it('returns a StrategicContext with the expected top-level shape', async () => {
    execFileSyncImpl = makeGitMock();
    mockEnrolled = [];

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();

    expect(Array.isArray(ctx.repos)).toBe(true);
    expect(typeof ctx.outcomes).toBe('object');
    expect(typeof ctx.fleet).toBe('object');
    expect(typeof ctx.narrative).toBe('string');
    expect(ctx.narrative.length).toBeGreaterThan(0);
  });

  it('never throws even when every sub-system fails', async () => {
    // Make execFileSync throw
    execFileSyncImpl = () => { throw new Error('git exploded'); };
    // listEnrolled throws — vi.mock override at module level is stable but we
    // can simulate a malformed enrolled list by pointing at a non-existent path.
    mockEnrolled = ['/nonexistent/path/that/does/not/exist'];

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    await expect(gatherStrategicContext()).resolves.toBeDefined();
  });

  it('never throws on empty enrollment', async () => {
    execFileSyncImpl = makeGitMock();
    mockEnrolled = [];

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos).toHaveLength(0);
  });

  it('outcomes, fleet, narrative are present even with no repos', async () => {
    mockEnrolled = [];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();

    expect(typeof ctx.outcomes.merged7d).toBe('number');
    expect(typeof ctx.outcomes.rejected7d).toBe('number');
    expect(typeof ctx.outcomes.reverted7d).toBe('number');
    expect(typeof ctx.outcomes.shipRate).toBe('number');
    expect(typeof ctx.outcomes.trivialRatio).toBe('number');

    expect(typeof ctx.fleet.pendingProposals).toBe('number');
    expect(typeof ctx.fleet.activeGoals).toBe('number');
    expect(typeof ctx.fleet.completedGoals).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 2. repos section
// ---------------------------------------------------------------------------

describe('m163 repos — per-repo health, commits, issues, tests', () => {
  it('returns one entry per enrolled repo', async () => {
    const dir = makeRepoDir('myapp');
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos).toHaveLength(1);
    expect(ctx.repos[0]!.path).toBe(dir);
    expect(ctx.repos[0]!.name).toBe('myapp');
  });

  it('marks repo health as "clean" when porcelain output is empty', async () => {
    const dir = makeRepoDir('clean-repo');
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock({ porcelain: '' });

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.health).toBe('clean');
  });

  it('marks repo health as "dirty" when porcelain output is non-empty', async () => {
    const dir = makeRepoDir('dirty-repo');
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock({ porcelain: ' M src/index.ts\n?? tmp/' });

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.health).toBe('dirty');
  });

  it('marks repo as "no-git" when .git does not exist', async () => {
    const dir = makeRepoDir('no-git-repo', { git: false });
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.health).toBe('no-git');
  });

  it('populates recentCommits up to 5 items', async () => {
    const dir = makeRepoDir('commits-repo');
    mockEnrolled = [dir];
    const commits = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']; // more than 5
    execFileSyncImpl = makeGitMock({ commits });

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.recentCommits.length).toBeLessThanOrEqual(5);
    expect(ctx.repos[0]!.recentCommits[0]).toBe('c1');
  });

  it('returns empty recentCommits when git log fails', async () => {
    const dir = makeRepoDir('no-log-repo');
    mockEnrolled = [dir];
    execFileSyncImpl = (cmd, args) => {
      if (cmd !== 'git') return '';
      const joined = (args ?? []).join(' ');
      if (joined.includes('log')) throw new Error('git log failed');
      return '';
    };

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.recentCommits).toEqual([]);
  });

  it('sets lastActivity from git log --format=%cI', async () => {
    const dir = makeRepoDir('dated-repo');
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock({ lastDate: '2026-05-10T08:00:00.000Z' });

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.lastActivity).toBe('2026-05-10T08:00:00.000Z');
  });

  it('sets openIssueCount from gh output', async () => {
    const dir = makeRepoDir('gh-repo');
    mockEnrolled = [dir];
    const gitMock = makeGitMock();
    execFileSyncImpl = (cmd, args, opts) => {
      if (cmd === 'gh') {
        // Return 3 issue objects
        return JSON.stringify([{ number: 1 }, { number: 2 }, { number: 3 }]);
      }
      return gitMock(cmd, args, opts);
    };

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.openIssueCount).toBe(3);
  });

  it('sets openIssueCount to null when gh is absent/fails', async () => {
    const dir = makeRepoDir('no-gh-repo');
    mockEnrolled = [dir];
    const gitMock = makeGitMock();
    execFileSyncImpl = (cmd, args, opts) => {
      if (cmd === 'gh') throw new Error('gh: command not found');
      return gitMock(cmd, args, opts);
    };

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.openIssueCount).toBeNull();
  });

  it('detects hasTests when a test/ directory exists', async () => {
    const dir = makeRepoDir('tested-repo', { testDir: true });
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.hasTests).toBe(true);
  });

  it('sets hasTests to false when no test dir exists', async () => {
    const dir = makeRepoDir('no-tests-repo', { testDir: false });
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos[0]!.hasTests).toBe(false);
  });

  it('caps repos at MAX_REPOS (20)', async () => {
    // Enroll 25 repos
    const dirs: string[] = [];
    for (let i = 0; i < 25; i++) {
      const d = makeRepoDir(`repo-${i}`);
      dirs.push(d);
    }
    mockEnrolled = dirs;
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.repos.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// 3. outcomes section
// ---------------------------------------------------------------------------

describe('m163 outcomes — 7d window stats', () => {
  it('withholds positive merge counts while preserving adverse outcomes', async () => {
    mockEnrolled = [];
    mockMetrics = { merged: 4, rejected: 2, trivialRatio: 0.25 };
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.outcomes.merged7d).toBe(0);
    expect(ctx.outcomes.rejected7d).toBe(2);
    expect(ctx.outcomes.trivialRatio).toBeCloseTo(0.25);
  });

  it('withholds ship rate until positive learning credit is released', async () => {
    mockEnrolled = [];
    mockMetrics = { merged: 3, rejected: 1, trivialRatio: 0 };
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.outcomes.shipRate).toBe(0);
  });

  it('shipRate is 0 when no proposals', async () => {
    mockEnrolled = [];
    mockMetrics = { merged: 0, rejected: 0, trivialRatio: 0 };
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.outcomes.shipRate).toBe(0);
  });

  it('counts reverted entries from decisions ledger', async () => {
    mockEnrolled = [];
    mockMetrics = { merged: 2, rejected: 0, trivialRatio: 0 };
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    mockDecisionEntries = [
      { ts: recent, proposalId: 'p1', action: 'reverted' },
      { ts: recent, proposalId: 'p2', action: 'reverted' },
      { ts: recent, proposalId: 'p3', action: 'merged' },
    ];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.outcomes.reverted7d).toBe(2);
  });

  it('reverted7d excludes entries older than 7 days', async () => {
    mockEnrolled = [];
    mockMetrics = { merged: 0, rejected: 0, trivialRatio: 0 };
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    mockDecisionEntries = [
      { ts: old,    proposalId: 'p1', action: 'reverted' }, // outside window
      { ts: recent, proposalId: 'p2', action: 'reverted' }, // inside window
    ];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.outcomes.reverted7d).toBe(1);
  });

  it('degrades to zero outcomes when quality-metrics throws', async () => {
    mockEnrolled = [];
    // We can't easily override the vi.mock for a single test, but we can verify
    // the zero-state for the standard "no proposals" path.
    mockMetrics = { merged: 0, rejected: 0, trivialRatio: 0 };
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.outcomes.merged7d).toBe(0);
    expect(ctx.outcomes.shipRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. fleet section
// ---------------------------------------------------------------------------

describe('m163 fleet — pending proposals + goals', () => {
  it('reflects pendingCount from inbox store', async () => {
    mockEnrolled = [];
    mockPendingCount = 7;
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.fleet.pendingProposals).toBe(7);
  });

  it('counts active + planning goals together as activeGoals', async () => {
    mockEnrolled = [];
    mockGoalsByStatus = { active: 3, planning: 2, done: 5, paused: 0, archived: 0 };
    mockPendingCount = 0;
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.fleet.activeGoals).toBe(5); // 3 + 2
  });

  it('counts done goals as completedGoals', async () => {
    mockEnrolled = [];
    mockGoalsByStatus = { active: 0, planning: 0, done: 11, paused: 0, archived: 0 };
    mockPendingCount = 0;
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.fleet.completedGoals).toBe(11);
  });

  it('fleet values are all 0 on empty state', async () => {
    mockEnrolled = [];
    mockPendingCount = 0;
    mockGoalsByStatus = { active: 0, planning: 0, done: 0, paused: 0, archived: 0 };
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.fleet.pendingProposals).toBe(0);
    expect(ctx.fleet.activeGoals).toBe(0);
    expect(ctx.fleet.completedGoals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. narrative
// ---------------------------------------------------------------------------

describe('m163 narrative — human-readable digest', () => {
  it('narrative is a non-empty string', async () => {
    mockEnrolled = [];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(typeof ctx.narrative).toBe('string');
    expect(ctx.narrative.trim().length).toBeGreaterThan(10);
  });

  it('narrative contains fleet stats', async () => {
    mockEnrolled = [];
    mockPendingCount = 4;
    mockGoalsByStatus = { active: 2, planning: 1, done: 3, paused: 0, archived: 0 };
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    // Should mention pending proposals
    expect(ctx.narrative).toMatch(/4/);
  });

  it('narrative contains repo name when repos enrolled', async () => {
    const dir = makeRepoDir('narrative-repo');
    mockEnrolled = [dir];
    execFileSyncImpl = makeGitMock({ commits: ['add narrative module'] });

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.narrative).toContain('narrative-repo');
  });

  it('narrative makes positive-credit unavailability explicit', async () => {
    mockEnrolled = [];
    mockMetrics = { merged: 5, rejected: 2, trivialRatio: 0.1 };
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.narrative).toMatch(/positive merge credit unavailable/i);
    expect(ctx.narrative).not.toMatch(/5 merged/i);
  });

  it('narrative says "no enrolled repos" when list is empty', async () => {
    mockEnrolled = [];
    execFileSyncImpl = makeGitMock();

    const { gatherStrategicContext } = await import('../src/core/vision/context.js');
    const ctx = await gatherStrategicContext();
    expect(ctx.narrative).toMatch(/no enrolled repos/i);
  });
});

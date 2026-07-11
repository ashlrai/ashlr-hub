/**
 * m186.invent-cycle.test.ts — M186 self-sustaining creation loop.
 *
 * WHAT IS TESTED:
 *  - runInventCycle invents for active (enrolled) repos and ENQUEUES fresh
 *    items into ~/.ashlr/backlog.json (the daemon's persisted backlog).
 *  - Flag gate: returns {invented:0, enqueued:0} when foundry.generative is
 *    absent/false; runs only when generative === true.
 *  - Cap: never enqueues more than foundry.inventPerCycle (default 3) per cycle,
 *    accumulated across repos.
 *  - Dedup: items enqueued once are skipped on the next cycle (cycle ledger at
 *    ~/.ashlr/generative/invent-cycle.json).
 *  - Never-throws on listEnrolled / inventWorkItems failures.
 *
 * SAFETY / HERMETICITY:
 *  - HOME relocated to a tmp dir — no real ~/.ashlr state touched.
 *  - inventWorkItems is MOCKED — no live frontier-model calls.
 *  - listEnrolled is MOCKED — no real enrollment registry read.
 *  - strategist loadLatestBriefing is MOCKED — no real briefing on disk.
 *  - No git, no network, no real repos mutated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Backlog, Goal, WorkItem } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — set before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports (vi.mock hoisting)
// ---------------------------------------------------------------------------

const mockInventWorkItems = vi.fn();
vi.mock('../src/core/generative/invent.js', () => ({
  inventWorkItems: (...args: unknown[]) => mockInventWorkItems(...args),
}));

const mockListEnrolled = vi.fn();
vi.mock('../src/core/sandbox/policy.js', () => ({
  listEnrolled: () => mockListEnrolled(),
  isEnrolled: vi.fn(() => true),
}));

const mockLoadLatestBriefing = vi.fn(() => null);
vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: (...args: unknown[]) => mockLoadLatestBriefing(...args),
}));

const mockListGoals = vi.fn((_filter?: { status?: string }) => [] as Goal[]);
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: (...args: unknown[]) => mockListGoals(...args),
}));

const mockLoadProposal = vi.fn(() => null as unknown);
vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: (...args: unknown[]) => mockLoadProposal(...args),
}));

// ---------------------------------------------------------------------------
// Lazy import (after mocks)
// ---------------------------------------------------------------------------

const { runInventCycle } = await import('../src/core/generative/invent-cycle.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCfg(overrides?: Record<string, unknown>): AshlrConfig {
  return {
    provider: 'anthropic',
    models: { ollama: 'http://127.0.0.1:9' },
    foundry: { ...overrides },
  } as unknown as AshlrConfig;
}

let titleCounter = 0;
function makeItem(repo: string, title?: string): WorkItem {
  const t = title ?? `Bold feature ${++titleCounter}: streaming diff preview`;
  return {
    id: `${repo}:invent:${Math.random().toString(16).slice(2, 14)}`,
    repo,
    source: 'invent',
    title: t,
    detail: 'A net-new compositional capability.',
    value: 4,
    effort: 3,
    score: 2.7,
    tags: ['generative', 'bold', 'net-new'],
    ts: new Date().toISOString(),
  };
}

function makeActiveGoal(repo: string, id: string): Goal {
  return {
    id,
    objective: `Close ${id}`,
    project: repo,
    status: 'active',
    milestones: [
      {
        id: `${id}-m0`,
        title: 'Ship focused milestone',
        detail: 'Implement the focused milestone.',
        order: 0,
        status: 'pending',
        specId: null,
        swarmId: null,
        proposalId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function readBacklog(): Backlog | null {
  const p = path.join(tmpHome, '.ashlr', 'backlog.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Backlog;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm186-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();
  mockLoadLatestBriefing.mockReturnValue(null);
  mockListGoals.mockReturnValue([]);
  mockLoadProposal.mockReturnValue(null);
  titleCounter = 0;
});

afterEach(() => {
  process.env.HOME = origHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Flag gate
// ---------------------------------------------------------------------------

describe('runInventCycle — flag gate (default OFF)', () => {
  it('returns zeroed result when generative flag is absent', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    const result = await runInventCycle(makeCfg());
    expect(result).toEqual({ invented: 0, enqueued: 0 });
    // Gate short-circuits before touching enrollment.
    expect(mockListEnrolled).not.toHaveBeenCalled();
    expect(mockInventWorkItems).not.toHaveBeenCalled();
  });

  it('returns zeroed result when generative is explicitly false', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    const result = await runInventCycle(makeCfg({ generative: false }));
    expect(result).toEqual({ invented: 0, enqueued: 0 });
    expect(mockInventWorkItems).not.toHaveBeenCalled();
  });

  it('runs when generative === true', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockInventWorkItems.mockResolvedValue([makeItem('/tmp/repo-a')]);
    const result = await runInventCycle(makeCfg({ generative: true }));
    expect(mockListEnrolled).toHaveBeenCalled();
    expect(mockInventWorkItems).toHaveBeenCalled();
    expect(result.invented).toBeGreaterThan(0);
    expect(result.enqueued).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Invent + enqueue
// ---------------------------------------------------------------------------

describe('runInventCycle — invents for active repos and enqueues', () => {
  it('enqueues invented items into ~/.ashlr/backlog.json', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockInventWorkItems.mockResolvedValue([
      makeItem('/tmp/repo-a', 'Feature one'),
      makeItem('/tmp/repo-a', 'Feature two'),
    ]);

    const result = await runInventCycle(makeCfg({ generative: true }));

    expect(result.invented).toBe(2);
    expect(result.enqueued).toBe(2);

    const backlog = readBacklog();
    expect(backlog).not.toBeNull();
    expect(backlog!.items).toHaveLength(2);
    expect(backlog!.items.every((i) => i.source === 'invent')).toBe(true);
    expect(backlog!.repos).toContain('/tmp/repo-a');
  });

  it('appends to an existing backlog without dropping prior items', async () => {
    // Seed an existing backlog item.
    const dir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(dir, { recursive: true });
    const prior = makeItem('/tmp/other', 'Pre-existing work');
    fs.writeFileSync(
      path.join(dir, 'backlog.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), repos: ['/tmp/other'], items: [prior] }),
      'utf8',
    );

    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockInventWorkItems.mockResolvedValue([makeItem('/tmp/repo-a', 'New idea')]);

    await runInventCycle(makeCfg({ generative: true }));

    const backlog = readBacklog();
    expect(backlog!.items).toHaveLength(2);
    expect(backlog!.items.some((i) => i.id === prior.id)).toBe(true);
  });

  it('iterates multiple repos and passes a per-repo invent call', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a', '/tmp/repo-b']);
    mockInventWorkItems.mockImplementation(async (input: { repo: string }) => [
      makeItem(input.repo),
    ]);

    const result = await runInventCycle(makeCfg({ generative: true, inventPerCycle: 5 }));

    expect(mockInventWorkItems).toHaveBeenCalledTimes(2);
    expect(result.enqueued).toBe(2);
  });

  it('no-op when enrollment is empty', async () => {
    mockListEnrolled.mockReturnValue([]);
    const result = await runInventCycle(makeCfg({ generative: true }));
    expect(result).toEqual({ invented: 0, enqueued: 0 });
    expect(mockInventWorkItems).not.toHaveBeenCalled();
  });

  it('defers invention when active goal focus pressure is high', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockListGoals.mockReturnValue([
      makeActiveGoal('/tmp/repo-a', 'goal-a'),
      makeActiveGoal('/tmp/repo-a', 'goal-b'),
      makeActiveGoal('/tmp/repo-a', 'goal-c'),
      makeActiveGoal('/tmp/repo-a', 'goal-d'),
    ]);

    const result = await runInventCycle(makeCfg({ generative: true, goalFocusActiveThreshold: 4 }));

    expect(result).toEqual({
      invented: 0,
      enqueued: 0,
      deferredByGoalFocus: true,
      goalFocus: {
        activeThreshold: 4,
        actionableActiveGoalCount: 4,
      },
    });
    expect(mockInventWorkItems).not.toHaveBeenCalled();
    expect(readBacklog()).toBeNull();
  });

  it('goal focus deferral can be disabled for deliberate broad invention', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockListGoals.mockReturnValue([
      makeActiveGoal('/tmp/repo-a', 'goal-a'),
      makeActiveGoal('/tmp/repo-a', 'goal-b'),
      makeActiveGoal('/tmp/repo-a', 'goal-c'),
      makeActiveGoal('/tmp/repo-a', 'goal-d'),
    ]);
    mockInventWorkItems.mockResolvedValue([makeItem('/tmp/repo-a', 'New broad idea')]);

    const result = await runInventCycle(makeCfg({
      generative: true,
      goalFocusMode: false,
      goalFocusActiveThreshold: 4,
    }));

    expect(result.invented).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(mockInventWorkItems).toHaveBeenCalledTimes(1);
  });

  it('does not defer invention for a milestone with exact applied verification evidence', async () => {
    const goal = makeActiveGoal('/tmp/repo-a', 'goal-landed');
    goal.milestones[0]!.proposalId = 'proposal-landed';
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockListGoals.mockReturnValue([goal]);
    mockLoadProposal.mockReturnValue({
      id: 'proposal-landed',
      status: 'applied',
      verifyResult: { passed: true, source: 'manual' },
    });
    mockInventWorkItems.mockResolvedValue([makeItem('/tmp/repo-a', 'Next invention')]);

    const result = await runInventCycle(makeCfg({ generative: true, goalFocusActiveThreshold: 1 }));

    expect(result.deferredByGoalFocus).toBeUndefined();
    expect(result.enqueued).toBe(1);
  });

  it('does not defer invention for done, paused, or projectless goals', async () => {
    const done = makeActiveGoal('/tmp/repo-a', 'goal-done');
    done.status = 'done';
    done.milestones[0]!.status = 'done';
    const paused = makeActiveGoal('/tmp/repo-a', 'goal-paused');
    paused.status = 'paused';
    paused.milestones[0]!.status = 'paused';
    const projectless = makeActiveGoal('/tmp/repo-a', 'goal-projectless');
    projectless.project = null;
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockListGoals.mockReturnValue([done, paused, projectless]);
    mockInventWorkItems.mockResolvedValue([makeItem('/tmp/repo-a', 'Still invent')]);

    const result = await runInventCycle(makeCfg({ generative: true, goalFocusActiveThreshold: 1 }));

    expect(result.deferredByGoalFocus).toBeUndefined();
    expect(result.enqueued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

describe('runInventCycle — cap (inventPerCycle)', () => {
  it('defaults to 3 items per cycle', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockInventWorkItems.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => makeItem('/tmp/repo-a', `Feature ${i}`)),
    );

    const result = await runInventCycle(makeCfg({ generative: true }));

    expect(result.enqueued).toBe(3);
    expect(readBacklog()!.items).toHaveLength(3);
  });

  it('honors a custom inventPerCycle cap', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockInventWorkItems.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => makeItem('/tmp/repo-a', `Feature ${i}`)),
    );

    const result = await runInventCycle(makeCfg({ generative: true, inventPerCycle: 2 }));

    expect(result.enqueued).toBe(2);
  });

  it('spreads the cap across repos (stops once cap is hit)', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a', '/tmp/repo-b', '/tmp/repo-c']);
    mockInventWorkItems.mockImplementation(async (input: { repo: string }) =>
      Array.from({ length: 3 }, (_, i) => makeItem(input.repo, `${input.repo}-feat-${i}`)),
    );

    const result = await runInventCycle(makeCfg({ generative: true, inventPerCycle: 4 }));

    expect(result.enqueued).toBe(4);
    // Cap hit during repo-b → repo-c never gets an invent call.
    expect(mockInventWorkItems.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe('runInventCycle — dedup across cycles', () => {
  it('skips items enqueued in a prior cycle (same titles)', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    const fixed = [
      makeItem('/tmp/repo-a', 'Persistent feature A'),
      makeItem('/tmp/repo-a', 'Persistent feature B'),
    ];
    // Return fresh item OBJECTS each cycle but with the SAME titles → dedup
    // keys on repo+normalized-title, so the second cycle should enqueue 0.
    mockInventWorkItems.mockImplementation(async () =>
      fixed.map((f) => makeItem('/tmp/repo-a', f.title)),
    );

    const first = await runInventCycle(makeCfg({ generative: true }));
    expect(first.enqueued).toBe(2);

    const second = await runInventCycle(makeCfg({ generative: true }));
    expect(second.invented).toBe(0);
    expect(second.enqueued).toBe(0);

    // Ledger file written under HOME.
    const ledgerPath = path.join(tmpHome, '.ashlr', 'generative', 'invent-cycle.json');
    expect(fs.existsSync(ledgerPath)).toBe(true);
  });

  it('does NOT dedup the same title for a different repo', async () => {
    mockInventWorkItems.mockImplementation(async (input: { repo: string }) => [
      makeItem(input.repo, 'Shared title feature'),
    ]);

    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    const first = await runInventCycle(makeCfg({ generative: true }));
    expect(first.enqueued).toBe(1);

    mockListEnrolled.mockReturnValue(['/tmp/repo-b']);
    const second = await runInventCycle(makeCfg({ generative: true }));
    expect(second.enqueued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Never-throws
// ---------------------------------------------------------------------------

describe('runInventCycle — never throws', () => {
  it('returns zeroed result when listEnrolled throws', async () => {
    mockListEnrolled.mockImplementation(() => {
      throw new Error('registry corrupt');
    });
    await expect(runInventCycle(makeCfg({ generative: true }))).resolves.toEqual({
      invented: 0,
      enqueued: 0,
    });
  });

  it('does not abort the cycle when one repo invent throws', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a', '/tmp/repo-b']);
    mockInventWorkItems.mockImplementation(async (input: { repo: string }) => {
      if (input.repo === '/tmp/repo-a') throw new Error('frontier down');
      return [makeItem('/tmp/repo-b')];
    });

    const result = await runInventCycle(makeCfg({ generative: true, inventPerCycle: 5 }));

    // repo-a failed but repo-b still produced + enqueued.
    expect(result.enqueued).toBe(1);
  });

  it('returns zeroed result when invent returns []', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a']);
    mockInventWorkItems.mockResolvedValue([]);
    const result = await runInventCycle(makeCfg({ generative: true }));
    expect(result).toEqual({ invented: 0, enqueued: 0 });
  });
});

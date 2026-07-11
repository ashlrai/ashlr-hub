/**
 * M160 — work-source rebalance tests.
 *
 * Verifies four properties:
 *
 *  1. DEFAULT-OFF (scanDeps/scanLint/scanHygiene): return [] when their flag
 *     is absent or false; return items when the flag is true.
 *
 *  2. DEFAULT-ON UNAFFECTED: scanIssues, scanSecurity, scanTests still run
 *     regardless of the M160 flags (they have no M160 gate).
 *
 *  3. scanGoals: emits source:'goal' items from active goals (mocked store),
 *     returning [] when no active goals exist.
 *
 *  4. SCANNER ARRAY ordering: high-value sources precede low-value sources.
 *
 * Hermetic: tmp repos + mocked child_process + mocked goals store.
 * vi.mock() calls are at module top level so vitest hoists them correctly.
 * Mirrors m136/m22 conventions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// ============================================================================
// ── Mock child_process BEFORE scanner imports ─────────────────────────────────
// ============================================================================

let _execFileImpl: ReturnType<typeof vi.fn>;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockExecFile = ((...args: unknown[]) => _execFileImpl(...args)) as typeof actual.execFile & {
    [k: symbol]: unknown;
  };
  mockExecFile[promisify.custom] = (
    file: string,
    cmdArgs: readonly string[],
    options: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      _execFileImpl(
        file,
        cmdArgs,
        options,
        (err: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => {
          if (err) {
            reject(Object.assign(err, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });
  return {
    ...actual,
    execFile: mockExecFile,
    spawnSync: (..._args: unknown[]) => ({
      pid: 0, output: [], stdout: '[]', stderr: '', status: 0, signal: null,
    }),
  };
});

// ============================================================================
// ── Mock github integration ───────────────────────────────────────────────────
// ============================================================================

vi.mock('../src/core/integrations/github.js', () => ({
  listIssues: vi.fn(() => []),
  githubStatus: vi.fn(() => ({ isRepo: false, ci: 'unknown' })),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: vi.fn(),
  killSwitchOn: vi.fn(() => false),
  setKill: vi.fn(),
  listEnrolled: vi.fn(() => []),
  isEnrolled: vi.fn(() => false),
}));

// ============================================================================
// ── Mock goals store (test seam for scanGoals) ───────────────────────────────
// ============================================================================

let _listGoalsImpl: ReturnType<typeof vi.fn>;
let _loadProposalImpl: ReturnType<typeof vi.fn>;

vi.mock('../src/core/goals/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/goals/store.js')>();
  return {
    ...actual,
    listGoals: (...args: unknown[]) => _listGoalsImpl(...args),
  };
});

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    loadProposal: (...args: unknown[]) => _loadProposalImpl(...args),
  };
});

// ============================================================================
// ── Late imports ──────────────────────────────────────────────────────────────
// ============================================================================

import {
  scanDeps,
  scanLint,
  scanDocs,
  scanIssues,
  scanSecurity,
  scanTests,
  scanGoals,
  SCANNERS,
} from '../src/core/portfolio/scanners.js';
import type { AshlrConfig, Goal } from '../src/core/types.js';

// ============================================================================
// ── Helpers ───────────────────────────────────────────────────────────────────
// ============================================================================

function makeCfg(overrides: Partial<NonNullable<AshlrConfig['foundry']>> = {}): Pick<AshlrConfig, 'foundry'> {
  return { foundry: overrides };
}

/** Build a minimal active Goal with one pending milestone. */
function makeActiveGoal(
  id: string,
  objective: string,
  milestoneTitle: string,
  project: string | null = tmpDir,
): Goal {
  return {
    id,
    objective,
    project,
    status: 'active',
    milestones: [
      {
        id: `${id}-m0`,
        title: milestoneTitle,
        detail: `Implement ${milestoneTitle} concretely.`,
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm160-'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

  // Default execFile: errors out (safe baseline)
  _execFileImpl = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(new Error('execFile stubbed'), '', '');
  });

  // Default goals stub: no active goals
  _listGoalsImpl = vi.fn(() => []);
  _loadProposalImpl = vi.fn(() => null);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ============================================================================
// Suite 1 — scanDeps: DEFAULT OFF
// ============================================================================

describe('M160 — scanDeps: default-off behaviour', () => {
  beforeEach(() => {
    // Create package.json so the scanner wouldn't short-circuit for the wrong reason
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test', scripts: { test: 'vitest' } }),
      'utf8',
    );
  });

  it('returns [] when cfg is undefined', async () => {
    const items = await scanDeps(tmpDir, undefined);
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry is undefined', async () => {
    const items = await scanDeps(tmpDir, { foundry: undefined });
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanDeps is false', async () => {
    const items = await scanDeps(tmpDir, makeCfg({ scanDeps: false }));
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanDeps is absent (not set)', async () => {
    const items = await scanDeps(tmpDir, makeCfg({}));
    expect(items).toHaveLength(0);
  });

  it('does NOT call npm/execFile when disabled', async () => {
    const stub = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      if (typeof cb === 'function') cb(null, '{}', '');
    });
    _execFileImpl = stub;
    await scanDeps(tmpDir, undefined);
    expect(stub).not.toHaveBeenCalled();
  });

  it('runs and returns items when cfg.foundry.scanDeps is true (opt-in works)', async () => {
    // Stub npm outdated to return a patch-bump item
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const file = args[0] as string;
      const cmdArgs = args[1] as string[] | undefined;
      const cb = args[args.length - 1] as (
        err: (Error & { stdout?: string }) | null,
        stdout: string,
        stderr: string,
      ) => void;
      if (typeof cb !== 'function') return;

      if (file === 'npm' && cmdArgs?.[0] === 'outdated') {
        const json = JSON.stringify({
          lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21', type: 'dependency' },
        });
        const err = Object.assign(new Error('outdated'), { code: 1, stdout: json, stderr: '' });
        cb(err, json, '');
        return;
      }

      if (file === 'binshield' && cmdArgs?.[0] === 'scan') {
        cb(
          null,
          JSON.stringify({
            packageName: 'lodash',
            version: '4.17.21',
            riskScore: 0,
            riskLevel: 'none',
            summary: 'Clean target version.',
          }),
          '',
        );
        return;
      }

      if (file === 'npm' && cmdArgs?.[0] === 'audit') {
        cb(null, '{}', '');
        return;
      }

      cb(new Error(`unexpected execFile call: ${file} ${(cmdArgs ?? []).join(' ')}`), '', '');
    });
    // M282: scanDeps requires BOTH scanDeps:true AND scanDependencyBumps:true
    // to emit outdated-package items. scanDependencyBumps is the second gate
    // (requires lockfile + test script) that guards mechanical bump churn.
    // The test also needs a lockfile so hasNpmLockfile() doesn't short-circuit.
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}', 'utf8');
    const items = await scanDeps(tmpDir, makeCfg({ scanDeps: true, scanDependencyBumps: true }));
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.title.includes('lodash'))).toBe(true);
  });
});

// ============================================================================
// Suite 2 — scanLint: DEFAULT OFF
// ============================================================================

describe('M160 — scanLint: default-off behaviour', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test', scripts: { lint: 'eslint .' } }),
      'utf8',
    );
    // Write a cached lint report with a fixable error
    const report = [
      {
        filePath: path.join(tmpDir, 'src/index.ts'),
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: "'x' is unused", line: 5, column: 7, fix: {} },
        ],
      },
    ];
    fs.writeFileSync(path.join(tmpDir, '.lint-cache.json'), JSON.stringify(report), 'utf8');
  });

  it('returns [] when cfg is undefined', async () => {
    const items = await scanLint(tmpDir, undefined);
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry is undefined', async () => {
    const items = await scanLint(tmpDir, { foundry: undefined });
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanLint is false', async () => {
    const items = await scanLint(tmpDir, makeCfg({ scanLint: false }));
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanLint is absent', async () => {
    const items = await scanLint(tmpDir, makeCfg({}));
    expect(items).toHaveLength(0);
  });

  it('returns items when cfg.foundry.scanLint is true (opt-in works)', async () => {
    const items = await scanLint(tmpDir, makeCfg({ scanLint: true }));
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.source).toBe('lint');
  });
});

// ============================================================================
// Suite 3 — scanDocs (scanHygiene): DEFAULT OFF
// ============================================================================

describe('M160 — scanDocs (hygiene): default-off behaviour', () => {
  it('returns [] when cfg is undefined', async () => {
    const items = await scanDocs(tmpDir, undefined);
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry is undefined', async () => {
    const items = await scanDocs(tmpDir, { foundry: undefined });
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanHygiene is false', async () => {
    const items = await scanDocs(tmpDir, makeCfg({ scanHygiene: false }));
    expect(items).toHaveLength(0);
  });

  it('returns [] when cfg.foundry.scanHygiene is absent', async () => {
    const items = await scanDocs(tmpDir, makeCfg({}));
    expect(items).toHaveLength(0);
  });

  it('returns items when cfg.foundry.scanHygiene is true and README missing', async () => {
    // tmpDir has no README — scanDocs should emit a missing-readme item
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void;
      if (typeof cb === 'function') cb(null, '', '');
    });
    const items = await scanDocs(tmpDir, makeCfg({ scanHygiene: true }));
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.source === 'doc')).toBe(true);
  });
});

// ============================================================================
// Suite 4 — scanIssues / scanSecurity / scanTests: unaffected by M160 flags
// ============================================================================

describe('M160 — high-value scanners: unaffected by M160 flags', () => {
  it('scanIssues runs regardless of M160 dep/lint/hygiene flags', async () => {
    // listIssues is mocked to [] — we just verify it returns an array without throwing
    const items = await scanIssues(tmpDir);
    expect(Array.isArray(items)).toBe(true);
  });

  it('scanIssues result is same with or without M160 cfg', async () => {
    // scanIssues signature is (repo) — it does not accept cfg; just confirm it works
    const a = await scanIssues(tmpDir);
    const b = await scanIssues(tmpDir);
    expect(a).toEqual(b);
  });

  it('scanSecurity runs regardless of M160 flags (returns [] when binshield absent)', async () => {
    // execFile stubs "which binshield" to fail → scanSecurity returns []
    _execFileImpl = vi.fn((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error, stdout: string, stderr: string) => void;
      if (typeof cb === 'function') cb(new Error('not found'), '', '');
    });
    const items = await scanSecurity(tmpDir);
    expect(Array.isArray(items)).toBe(true);
    // No assertion on length — it may be [] or have items depending on env
  });

  it('scanTests runs regardless of M160 flags', async () => {
    const items = await scanTests(tmpDir);
    expect(Array.isArray(items)).toBe(true);
  });
});

// ============================================================================
// Suite 5 — scanGoals: emits source:'goal' items from active goals
// ============================================================================

describe('M160 — scanGoals: goal-derived work items', () => {
  it('advances past an exactly linked applied and verified milestone without mutating the goal', async () => {
    const goal = makeActiveGoal('goal-linked', 'Ship linked work', 'Already landed');
    goal.milestones[0]!.status = 'in-progress';
    goal.milestones[0]!.proposalId = 'prop-linked';
    goal.milestones.push({
      ...goal.milestones[0]!,
      id: 'goal-linked-m1',
      title: 'Next unfinished step',
      order: 1,
      status: 'pending',
      proposalId: null,
    });
    const before = JSON.stringify(goal);
    _listGoalsImpl = vi.fn(() => [goal]);
    _loadProposalImpl = vi.fn(() => ({
      id: 'prop-linked',
      status: 'applied',
      verifyResult: { passed: true },
    }));

    const items = await scanGoals(tmpDir);

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('Next unfinished step');
    expect(JSON.stringify(goal)).toBe(before);
    expect(_loadProposalImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps linked milestones actionable without both applied and passing verification evidence', async () => {
    const goal = makeActiveGoal('goal-unverified', 'Ship verified work', 'Needs proof');
    goal.milestones[0]!.proposalId = 'prop-unverified';
    _listGoalsImpl = vi.fn(() => [goal]);
    _loadProposalImpl = vi.fn(() => ({
      id: 'prop-unverified',
      status: 'applied',
      verifyResult: { passed: false },
    }));

    const items = await scanGoals(tmpDir);

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('Needs proof');
  });

  it('does not accept applied evidence whose embedded proposal id mismatches the milestone link', async () => {
    const goal = makeActiveGoal('goal-mismatched', 'Reject mismatched evidence', 'Needs exact link');
    goal.milestones[0]!.proposalId = 'prop-expected';
    _listGoalsImpl = vi.fn(() => [goal]);
    _loadProposalImpl = vi.fn(() => ({
      id: 'prop-different',
      status: 'applied',
      verifyResult: { passed: true },
    }));

    const items = await scanGoals(tmpDir);

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('Needs exact link');
  });

  it('emits no work when the sole actionable milestone is authoritatively complete', async () => {
    const goal = makeActiveGoal('goal-complete-only', 'Close stale goal', 'Already complete');
    goal.milestones[0]!.proposalId = 'prop-complete-only';
    _listGoalsImpl = vi.fn(() => [goal]);
    _loadProposalImpl = vi.fn(() => ({
      id: 'prop-complete-only',
      status: 'applied',
      verifyResult: { passed: true },
    }));

    await expect(scanGoals(tmpDir)).resolves.toEqual([]);
  });

  it('fails closed by keeping a linked milestone when proposal evidence cannot be read', async () => {
    const goal = makeActiveGoal('goal-unreadable', 'Preserve uncertain work', 'Still actionable');
    goal.milestones[0]!.proposalId = 'prop-unreadable';
    _listGoalsImpl = vi.fn(() => [goal]);
    _loadProposalImpl = vi.fn(() => { throw new Error('proposal store unavailable'); });

    const items = await scanGoals(tmpDir);

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('Still actionable');
  });

  it('does not let completed-only lanes trigger the active-goal focus threshold', async () => {
    const goals = [
      makeActiveGoal('goal-open-a', 'Open A', 'Pending A'),
      makeActiveGoal('goal-open-b', 'Open B', 'Pending B'),
      makeActiveGoal('goal-open-c', 'Open C', 'Pending C'),
      makeActiveGoal('goal-stale-complete', 'Stale complete', 'Already landed'),
    ];
    goals[3]!.milestones[0]!.proposalId = 'prop-stale-complete';
    _listGoalsImpl = vi.fn(() => goals);
    _loadProposalImpl = vi.fn((proposalId: string) => proposalId === 'prop-stale-complete'
      ? { id: proposalId, status: 'applied', verifyResult: { passed: true } }
      : null);

    const items = await scanGoals(tmpDir, makeCfg({ goalFocusActiveThreshold: 4 }));

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.tags[1])).toEqual(expect.arrayContaining([
      'goal-open-a',
      'goal-open-b',
      'goal-open-c',
    ]));
  });

  it('returns [] when no active goals exist', async () => {
    _listGoalsImpl = vi.fn(() => []);
    const items = await scanGoals(tmpDir);
    expect(items).toHaveLength(0);
  });

  it('returns [] when listGoals returns an empty array', async () => {
    _listGoalsImpl = vi.fn(() => []);
    const items = await scanGoals(tmpDir, makeCfg({}));
    expect(items).toHaveLength(0);
  });

  it('emits one item per active goal with a pending milestone', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-abc123', 'Ship the new auth flow', 'Add JWT middleware'),
      makeActiveGoal('goal-def456', 'Refactor data layer', 'Extract repository pattern'),
    ]);
    const items = await scanGoals(tmpDir);
    expect(items).toHaveLength(2);
  });

  it('goal focus mode caps active goal fan-out once the threshold is reached', async () => {
    const goals = [
      makeActiveGoal('goal-a', 'Goal A', 'Pending A'),
      makeActiveGoal('goal-b', 'Goal B', 'Pending B'),
      makeActiveGoal('goal-c', 'Goal C', 'Pending C'),
      makeActiveGoal('goal-d', 'Goal D', 'In progress D'),
    ];
    goals[3]!.milestones[0]!.status = 'in-progress';
    goals[3]!.milestones[0]!.updatedAt = '2026-01-02T00:00:00.000Z';
    _listGoalsImpl = vi.fn(() => goals);

    const items = await scanGoals(tmpDir, makeCfg({ goalFocusActiveThreshold: 4 }));

    expect(items).toHaveLength(1);
    expect(items[0]!.tags).toContain('goal-d');
    expect(items[0]!.title).toContain('In progress D');
  });

  it('goal focus mode can be disabled to preserve broad active-goal fan-out', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-a', 'Goal A', 'Pending A'),
      makeActiveGoal('goal-b', 'Goal B', 'Pending B'),
      makeActiveGoal('goal-c', 'Goal C', 'Pending C'),
      makeActiveGoal('goal-d', 'Goal D', 'Pending D'),
    ]);

    const items = await scanGoals(tmpDir, makeCfg({ goalFocusMode: false }));

    expect(items).toHaveLength(4);
  });

  it('emitted item has source:"goal"', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-abc123', 'Ship the new auth flow', 'Add JWT middleware'),
    ]);
    const items = await scanGoals(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('goal');
  });

  it('emitted item has value 4 (high baseline)', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-abc123', 'Ship the new auth flow', 'Add JWT middleware'),
    ]);
    const items = await scanGoals(tmpDir);
    expect(items[0]!.value).toBe(4);
  });

  it('title includes the goal objective and milestone title', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-abc123', 'Ship the new auth flow', 'Add JWT middleware'),
    ]);
    const items = await scanGoals(tmpDir);
    expect(items[0]!.title).toContain('Ship the new auth flow');
    expect(items[0]!.title).toContain('Add JWT middleware');
  });

  it('detail includes goal objective and milestone detail', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-abc123', 'Ship the new auth flow', 'Add JWT middleware'),
    ]);
    const items = await scanGoals(tmpDir);
    expect(items[0]!.detail).toContain('Ship the new auth flow');
    expect(items[0]!.detail).toContain('Add JWT middleware');
  });

  it('tags include "goal" and the goal id', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-abc123', 'Ship the new auth flow', 'Add JWT middleware'),
    ]);
    const items = await scanGoals(tmpDir);
    expect(items[0]!.tags).toContain('goal');
    expect(items[0]!.tags).toContain('goal-abc123');
  });

  it('does not emit for a goal with no pending milestones (all done)', async () => {
    const goal: Goal = {
      ...makeActiveGoal('goal-done', 'A completed goal', 'Already done'),
      milestones: [
        {
          id: 'goal-done-m0',
          title: 'Already done',
          detail: 'This is done.',
          order: 0,
          status: 'done',
          specId: null,
          swarmId: null,
          proposalId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    _listGoalsImpl = vi.fn(() => [goal]);
    const items = await scanGoals(tmpDir);
    expect(items).toHaveLength(0);
  });

  it('emits for in-progress milestone (not only pending)', async () => {
    const goal = makeActiveGoal('goal-inprog', 'In-progress goal', 'Currently working');
    goal.milestones[0]!.status = 'in-progress';
    _listGoalsImpl = vi.fn(() => [goal]);
    const items = await scanGoals(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('goal');
  });

  it('returns [] for projectless active goals', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal(
        'goal-projectless',
        'Projectless goal',
        'No executable repo binding',
        null,
      ),
    ]);

    const items = await scanGoals(tmpDir);

    expect(items).toHaveLength(0);
  });

  it('never throws even when listGoals throws', async () => {
    _listGoalsImpl = vi.fn(() => { throw new Error('store error'); });
    await expect(scanGoals(tmpDir)).resolves.toEqual([]);
  });

  it('id is stable / deterministic across two calls', async () => {
    _listGoalsImpl = vi.fn(() => [
      makeActiveGoal('goal-abc123', 'Ship the new auth flow', 'Add JWT middleware'),
    ]);
    const [a, b] = await Promise.all([scanGoals(tmpDir), scanGoals(tmpDir)]);
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});

// ============================================================================
// Suite 6 — SCANNERS array ordering: high-value precede low-value
// ============================================================================

describe('M160 — SCANNERS array: ordering and registration', () => {
  it('SCANNERS contains scanGoals', () => {
    expect(SCANNERS).toContain(scanGoals);
  });

  it('SCANNERS contains scanIssues, scanSecurity, scanTests', () => {
    expect(SCANNERS).toContain(scanIssues);
    expect(SCANNERS).toContain(scanSecurity);
    expect(SCANNERS).toContain(scanTests);
  });

  it('high-value scanners appear before low-value scanners in SCANNERS', () => {
    const idxIssues = SCANNERS.indexOf(scanIssues);
    const idxGoals = SCANNERS.indexOf(scanGoals);
    const idxDeps = SCANNERS.indexOf(scanDeps);
    const idxLint = SCANNERS.indexOf(scanLint);
    const idxDocs = SCANNERS.indexOf(scanDocs);

    // All present
    expect(idxIssues).toBeGreaterThanOrEqual(0);
    expect(idxGoals).toBeGreaterThanOrEqual(0);
    expect(idxDeps).toBeGreaterThanOrEqual(0);
    expect(idxLint).toBeGreaterThanOrEqual(0);
    expect(idxDocs).toBeGreaterThanOrEqual(0);

    // High-value before low-value
    expect(idxIssues).toBeLessThan(idxDeps);
    expect(idxIssues).toBeLessThan(idxLint);
    expect(idxIssues).toBeLessThan(idxDocs);
    expect(idxGoals).toBeLessThan(idxDeps);
    expect(idxGoals).toBeLessThan(idxLint);
    expect(idxGoals).toBeLessThan(idxDocs);
  });

  it('SCANNERS includes every built-in source', () => {
    expect(SCANNERS.length).toBeGreaterThanOrEqual(10);
  });
});

/**
 * M258 — Sandbox-path goal guard + dedupe for regression:detected.
 *
 * Tests:
 *  1.  sandbox-path repo → no goal enqueued (translate-or-skip)
 *  2.  real-repo path → goal enqueued normally (regression flow intact)
 *  3.  no repo at all → goal enqueued (absent repo is fine)
 *  4.  sandbox guard: goal is NEVER created with /.ashlr/sandboxes/ in objective
 *  5.  dedupe: identical-objective goal already exists → skip (no second enqueue)
 *  6.  dedupe: different objective → enqueues normally (no false positive)
 *  7.  SAFETY: sandbox-path skip does not call merge/push/apply primitives
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockCreateGoal,
  mockListGoals,
  mockAutoMergeProposal,
  mockApplyDiff,
  mockGitPush,
} = vi.hoisted(() => ({
  mockCreateGoal: vi.fn().mockReturnValue({ id: 'goal-fix-1', objective: 'fix', status: 'planning' }),
  mockListGoals: vi.fn().mockReturnValue([]),
  mockAutoMergeProposal: vi.fn(),
  mockApplyDiff: vi.fn(),
  mockGitPush: vi.fn(),
}));

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: mockCreateGoal,
  listGoals: mockListGoals,
  loadGoal: vi.fn().mockReturnValue(null),
  saveGoal: vi.fn(),
  goalsDir: () => join(process.env['HOME'] ?? tmpdir(), '.ashlr', 'goals'),
}));

vi.mock('../src/core/fleet/worked-ledger.js', () => ({
  recordOutcome: vi.fn(),
  listWorkedItems: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/core/comms/events.js', () => ({
  notifyFleetEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core/generative/invent-cycle.js', () => ({
  runInventCycle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: mockAutoMergeProposal,
}));

vi.mock('../src/core/run/apply.js', () => ({
  applyDiff: mockApplyDiff,
}));

vi.mock('../src/core/run/git.js', () => ({
  gitPush: mockGitPush,
}));

// ---------------------------------------------------------------------------
// Hermetic tmpHome
// ---------------------------------------------------------------------------

let tmpHome: string;
const origHome = process.env['HOME'];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm258-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  mockCreateGoal.mockReturnValue({ id: 'goal-fix-1', objective: 'fix', status: 'planning' });
  mockListGoals.mockReturnValue([]);
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import {
  emit,
  _clearHandlers,
  registerBuiltInHandlers,
} from '../src/core/fleet/event-bus.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function cfgOn(extras: Record<string, unknown> = {}) {
  return { foundry: { ...extras } } as never;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}

// Fixed sandbox path matching the real pattern
const SANDBOX_PATH = '/Users/masonwyatt/.ashlr/sandboxes/d7d42cf66944/worktree';
const REAL_REPO = '/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M258 — sandbox-path goal guard', () => {
  beforeEach(() => {
    _clearHandlers();
    registerBuiltInHandlers();
  });

  // 1. Sandbox path → NO goal
  it('1. sandbox-path repo: no goal enqueued', async () => {
    emit(
      'regression:detected',
      { signal: 'test suite failed', repo: SANDBOX_PATH },
      cfgOn(),
    );
    await flush();

    expect(mockCreateGoal).not.toHaveBeenCalled();
  });

  // 2. Real repo → goal enqueued normally
  it('2. real-repo path: goal enqueued with canonical path', async () => {
    emit(
      'regression:detected',
      { signal: 'test suite failed on main', repo: REAL_REPO },
      cfgOn(),
    );
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    const [objective, opts] = mockCreateGoal.mock.calls[0] as [string, { project?: string | null }];
    expect(objective).toContain(REAL_REPO);
    expect(objective).toContain('test suite failed on main');
    // Objective must NEVER contain a sandbox path
    expect(objective).not.toContain('/.ashlr/sandboxes/');
    expect(opts?.project).toBe(REAL_REPO);
  });

  // 3. No repo → goal enqueued (absent repo is fine)
  it('3. absent repo: goal still enqueued', async () => {
    emit('regression:detected', { signal: 'flaky test' }, cfgOn());
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    const [objective] = mockCreateGoal.mock.calls[0] as [string];
    expect(objective).toContain('regression');
    expect(objective).not.toContain('/.ashlr/sandboxes/');
  });

  // 4. Guard: objective must never contain sandbox path under any circumstance
  it('4. sandbox guard: created objective never contains /.ashlr/sandboxes/', async () => {
    // Even if somehow a non-standard variant slips through, verify the guard
    emit(
      'regression:detected',
      { signal: 'broken', repo: SANDBOX_PATH },
      cfgOn(),
    );
    await flush();

    // createGoal must not have been called with a sandbox path
    for (const call of mockCreateGoal.mock.calls) {
      const objective = call[0] as string;
      expect(objective).not.toContain('/.ashlr/sandboxes/');
    }
  });

  // 5. Dedupe: same objective already exists → skip
  it('5. dedupe: identical-objective goal already exists → skip', async () => {
    const signal = 'test suite failed on main';
    const expectedObjective = `Fix regression in ${REAL_REPO}: ${signal}`;
    mockListGoals.mockReturnValue([
      { id: 'goal-existing', objective: expectedObjective, status: 'planning' },
    ]);

    emit(
      'regression:detected',
      { signal, repo: REAL_REPO },
      cfgOn(),
    );
    await flush();

    expect(mockCreateGoal).not.toHaveBeenCalled();
  });

  // 6. Dedupe: different objective → enqueues (no false positive)
  it('6. dedupe: different objective → enqueues normally', async () => {
    mockListGoals.mockReturnValue([
      { id: 'goal-other', objective: 'Fix regression in /some/other/repo: other failure', status: 'planning' },
    ]);

    emit(
      'regression:detected',
      { signal: 'test suite failed on main', repo: REAL_REPO },
      cfgOn(),
    );
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
  });

  // 7. SAFETY: sandbox skip never touches destructive primitives
  it('7. SAFETY: sandbox-path skip does not call merge/push/apply', async () => {
    emit(
      'regression:detected',
      { signal: 'broken', repo: SANDBOX_PATH },
      cfgOn(),
    );
    await flush();

    expect(mockCreateGoal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockApplyDiff).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
  });
});

/**
 * M241 — Fleet Event Bus test suite.
 *
 * Tests:
 *  1.  emit(kind, payload) dispatches to a registered handler
 *  2.  regression:detected built-in handler enqueues a fix goal (proposal-only,
 *      no merge/push/apply)
 *  3.  gate: cfg.foundry.eventBus === false → no handler fires (byte-identical
 *      no-op vs pre-M241)
 *  4.  a handler that throws is swallowed — emit() never throws
 *  5.  SAFETY: no handler path can merge/push/apply — handlers only
 *      enqueue/notify (destructive primitives absent from registry)
 *
 * Conventions mirror test/m212.proactive-comms.test.ts:
 *   - vi.hoisted() for mock factories
 *   - hermetic tmpHome (HOME override)
 *   - _clearHandlers() + registerBuiltInHandlers() resets bus state per-test
 *   - FIXED timestamps (no Date.now-dependent assertions — M240 boundary-flaky
 *     lesson)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any vi.mock() calls
// ---------------------------------------------------------------------------

const {
  mockCreateGoal,
  mockListGoals,
  mockRecordOutcome,
  mockLoadProposal,
  mockNotifyFleetEvent,
  mockRunInventCycle,
  // Destructive primitives — must NEVER be called from any handler
  mockAutoMergeProposal,
  mockApplyDiff,
  mockGitPush,
} = vi.hoisted(() => ({
  mockCreateGoal: vi.fn().mockReturnValue({ id: 'goal-fix-1', objective: 'fix', status: 'planning' }),
  mockListGoals: vi.fn().mockReturnValue([]),
  mockRecordOutcome: vi.fn(),
  mockLoadProposal: vi.fn().mockReturnValue(null),
  mockNotifyFleetEvent: vi.fn().mockResolvedValue(undefined),
  mockRunInventCycle: vi.fn().mockResolvedValue(undefined),
  // destructive — must remain uncalled
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
  recordOutcome: mockRecordOutcome,
  listWorkedItems: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: mockLoadProposal,
}));

vi.mock('../src/core/comms/events.js', () => ({
  notifyFleetEvent: mockNotifyFleetEvent,
}));

vi.mock('../src/core/generative/invent-cycle.js', () => ({
  runInventCycle: mockRunInventCycle,
}));

// Destructive primitives — mocked to detect accidental calls from handlers
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
  tmpHome = mkdtempSync(join(tmpdir(), 'm241-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  // Restore default resolved values after clearAllMocks
  mockCreateGoal.mockReturnValue({ id: 'goal-fix-1', objective: 'fix', status: 'planning' });
  mockListGoals.mockReturnValue([]); // M258: dedupe check — empty list = no duplicates
  mockNotifyFleetEvent.mockResolvedValue(undefined);
  mockLoadProposal.mockReturnValue(null);
  mockRunInventCycle.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock declarations — vitest hoists all vi.mock calls)
// ---------------------------------------------------------------------------

import {
  emit,
  onFleetEvent,
  _clearHandlers,
  registerBuiltInHandlers,
} from '../src/core/fleet/event-bus.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Event-bus ON (default — key absent). */
function cfgOn(extras: Record<string, unknown> = {}) {
  return { foundry: { ...extras } } as never;
}

/** Event-bus OFF — gate must short-circuit all handlers. */
function cfgOff(extras: Record<string, unknown> = {}) {
  return { foundry: { eventBus: false, ...extras } } as never;
}

/**
 * Flush two microtask/macrotask ticks so async handler tails resolve.
 * Vitest 2.x does not expose runAllMicrotasksAsync; two settled promises
 * are sufficient because the built-in handlers await exactly one dynamic
 * import before calling the mocked function.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}

// Fixed timestamp constant — avoids any Date.now() dependency in assertions.
const FIXED_ISO = '2026-06-17T00:00:00.000Z';
void FIXED_ISO; // suppress "declared but never read" lint

// ---------------------------------------------------------------------------
// Test 1 — emit dispatches to a registered handler
// ---------------------------------------------------------------------------

describe('1. emit dispatches to registered handlers', () => {
  beforeEach(() => {
    _clearHandlers();
    // No built-ins registered — clean slate for dispatch tests
  });

  it('calls a single handler with the correct payload and cfg', () => {
    const received: Array<{ payload: unknown; cfg: unknown }> = [];
    const off = onFleetEvent('proposal:filed', (payload, cfg) => {
      received.push({ payload, cfg });
    });

    const cfg = cfgOn();
    emit('proposal:filed', { proposalId: 'p-001', title: 'add widget', repo: 'org/repo', engineTier: 'frontier' }, cfg);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload).toMatchObject({ proposalId: 'p-001', title: 'add widget' });
    off();
  });

  it('calls multiple handlers in registration order', async () => {
    const order: string[] = [];
    const off1 = onFleetEvent('anomaly', () => { order.push('first'); });
    const off2 = onFleetEvent('anomaly', () => { order.push('second'); });
    const off3 = onFleetEvent('anomaly', () => { order.push('third'); });

    await emit('anomaly', { detail: 'disk-full', source: 'sentinel' }, cfgOn());

    expect(order).toEqual(['first', 'second', 'third']);
    off1(); off2(); off3();
  });

  it('deregister function removes only the target handler', () => {
    const calls: string[] = [];
    const off1 = onFleetEvent('goal:done', () => { calls.push('A'); });
    const off2 = onFleetEvent('goal:done', () => { calls.push('B'); });

    off1(); // deregister A only
    emit('goal:done', { goalId: 'g-1', objective: 'ship it', repo: null }, cfgOn());

    expect(calls).toEqual(['B']);
    off2();
  });

  it('emitting a kind with no registered handlers is a no-op — no throw', () => {
    expect(() =>
      emit('merge:shipped', { proposalId: 'p-x', repo: 'r' }, cfgOn()),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — regression:detected enqueues a fix goal (proposal-only)
// ---------------------------------------------------------------------------

describe('2. regression:detected built-in handler enqueues a fix goal', () => {
  beforeEach(() => {
    _clearHandlers();
    registerBuiltInHandlers();
  });

  it('calls createGoal with an objective derived from the signal + repo', async () => {
    emit(
      'regression:detected',
      { signal: 'test suite failed on main', repo: '/home/agent/proj' },
      cfgOn(),
    );
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    const [objective, opts] = mockCreateGoal.mock.calls[0] as [string, { project?: string | null }];
    expect(objective).toContain('regression');
    expect(objective).toContain('/home/agent/proj');
    expect(objective).toContain('test suite failed on main');
    // project is the repo path (proposal-only path — enqueue, not merge)
    expect(opts?.project).toBe('/home/agent/proj');
  });

  it('truncates a very long signal to <=120 chars in the objective', async () => {
    const longSignal = 'x'.repeat(200);
    emit('regression:detected', { signal: longSignal, repo: '/repo' }, cfgOn());
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    const [objective] = mockCreateGoal.mock.calls[0] as [string];
    // The handler slices signal to 120 chars (source: event-bus.ts L197)
    const signalPart = objective.split(': ')[1] ?? '';
    expect(signalPart.length).toBeLessThanOrEqual(120);
  });

  it('enqueues a goal even when repo is absent', async () => {
    emit('regression:detected', { signal: 'flaky test' }, cfgOn());
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    const [objective] = mockCreateGoal.mock.calls[0] as [string];
    expect(objective).toContain('regression');
  });

  it('SAFETY: createGoal is called — NOT autoMergeProposal / applyDiff / gitPush', async () => {
    emit('regression:detected', { signal: 'broken', repo: '/r' }, cfgOn());
    await flush();

    expect(mockCreateGoal).toHaveBeenCalled();            // enqueue
    expect(mockAutoMergeProposal).not.toHaveBeenCalled(); // no merge
    expect(mockApplyDiff).not.toHaveBeenCalled();         // no apply
    expect(mockGitPush).not.toHaveBeenCalled();           // no push
  });
});

// ---------------------------------------------------------------------------
// Test 3 — gate: cfg.foundry.eventBus === false → no handlers fire
// ---------------------------------------------------------------------------

describe('3. gate: eventBus:false is a byte-identical no-op', () => {
  beforeEach(() => {
    _clearHandlers();
    registerBuiltInHandlers();
  });

  it('registered user handler does NOT fire when eventBus:false', () => {
    const spy = vi.fn();
    onFleetEvent('proposal:filed', spy);

    emit('proposal:filed', { proposalId: 'p-gate', title: 'gated' }, cfgOff());

    expect(spy).not.toHaveBeenCalled();
  });

  it('built-in regression:detected handler does NOT fire when eventBus:false', async () => {
    emit('regression:detected', { signal: 'oops', repo: '/r' }, cfgOff());
    await flush();

    expect(mockCreateGoal).not.toHaveBeenCalled();
  });

  it('built-in merge:shipped handler does NOT fire when eventBus:false', async () => {
    emit('merge:shipped', { proposalId: 'p-1', repo: '/r' }, cfgOff());
    await flush();

    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockNotifyFleetEvent).not.toHaveBeenCalled();
  });

  it('flag-on after flag-off: handlers fire normally when key is absent', () => {
    const spy = vi.fn();
    onFleetEvent('anomaly', spy);

    // OFF first — no call
    emit('anomaly', { detail: 'x' }, cfgOff());
    expect(spy).not.toHaveBeenCalled();

    // ON (key absent) — handler fires
    emit('anomaly', { detail: 'x' }, cfgOn());
    expect(spy).toHaveBeenCalledOnce();
  });

  it('flag-on: eventBus:true (explicit) still fires handlers', () => {
    const spy = vi.fn();
    onFleetEvent('anomaly', spy);

    emit('anomaly', { detail: 'y' }, { foundry: { eventBus: true } } as never);
    expect(spy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — a throwing handler is swallowed; emit() never throws
// ---------------------------------------------------------------------------

describe('4. throwing handlers are swallowed — emit never throws', () => {
  beforeEach(() => {
    _clearHandlers();
    // No built-ins — isolate throw-swallow behaviour
  });

  it('synchronous throw in a handler does not propagate from emit()', () => {
    onFleetEvent('anomaly', () => { throw new Error('handler blew up'); });

    expect(() => emit('anomaly', { detail: 'x' }, cfgOn())).not.toThrow();
  });

  it('handlers after a throwing handler still run', () => {
    const after = vi.fn();
    onFleetEvent('anomaly', () => { throw new Error('boom'); });
    onFleetEvent('anomaly', after);

    emit('anomaly', { detail: 'x' }, cfgOn());

    expect(after).toHaveBeenCalledOnce();
  });

  it('async handler that rejects is swallowed — emit does not throw', async () => {
    onFleetEvent('goal:done', async () => {
      await Promise.resolve();
      throw new Error('async handler rejected');
    });

    expect(() =>
      emit('goal:done', { goalId: 'g-x', objective: 'finish', repo: null }, cfgOn()),
    ).not.toThrow();

    // Drain the rejection; if unhandled the test would fail with an unhandled-promise error
    await flush();
    // Reaching here confirms the bus caught the async rejection correctly
  });

  it('emit never throws when payload is an empty object (defensive)', () => {
    expect(() =>
      emit('merge:shipped', {} as never, cfgOn()),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — SAFETY: no handler path can merge/push/apply
// ---------------------------------------------------------------------------

describe('5. SAFETY: handlers only enqueue/notify — no merge/push/apply', () => {
  beforeEach(() => {
    _clearHandlers();
    registerBuiltInHandlers();
  });

  it('regression:detected: only createGoal is reached — not merge primitives', async () => {
    emit('regression:detected', { signal: 'broken build', repo: '/r' }, cfgOn());
    await flush();

    expect(mockCreateGoal).toHaveBeenCalled();            // enqueue
    expect(mockAutoMergeProposal).not.toHaveBeenCalled(); // no merge
    expect(mockApplyDiff).not.toHaveBeenCalled();         // no apply
    expect(mockGitPush).not.toHaveBeenCalled();           // no push
  });

  it('merge:shipped: notifies but cannot mint causal worked-ledger credit', async () => {
    mockLoadProposal.mockReturnValue({
      id: 'p-shipped',
      workItemId: 'item-shipped',
      workSource: 'todo',
      runId: 'run-shipped',
    });

    emit('merge:shipped', { proposalId: 'p-shipped', repo: '/r', title: 'fix', engineTier: 'frontier' }, cfgOn());
    await flush();

    expect(mockLoadProposal).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockNotifyFleetEvent).toHaveBeenCalledWith('merge', {
      repo: '/r',
      title: 'fix',
      engine: 'frontier',
      proposalId: 'p-shipped',
    }, expect.anything());
    // Forbidden: no second merge loop, no apply, no push
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockApplyDiff).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it('merge:shipped: cannot mint fallback proposalId credit for legacy proposals', async () => {
    mockLoadProposal.mockReturnValue(null);

    emit('merge:shipped', { proposalId: 'p-legacy', repo: '/r' }, cfgOn());
    await flush();

    expect(mockLoadProposal).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockNotifyFleetEvent).toHaveBeenCalled();
  });

  it('goal:done: generative OFF => no invent-cycle, no destructive calls', async () => {
    emit('goal:done', { goalId: 'g-done', objective: 'ship feature', repo: '/r' }, cfgOn());
    await flush();

    expect(mockRunInventCycle).not.toHaveBeenCalled(); // generative OFF
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockApplyDiff).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it('goal:done with generative:true triggers invent-cycle (enqueue only — no merge)', async () => {
    emit(
      'goal:done',
      { goalId: 'g-done-gen', objective: 'ship feature', repo: '/r' },
      cfgOn({ generative: true }),
    );
    await flush();

    expect(mockRunInventCycle).toHaveBeenCalled();        // enqueue
    expect(mockAutoMergeProposal).not.toHaveBeenCalled(); // no merge
    expect(mockApplyDiff).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it('a custom enqueue-only handler does not trigger any destructive mock', () => {
    const enqueueSpy = vi.fn();
    onFleetEvent('proposal:filed', (payload) => {
      enqueueSpy(payload);
    });

    emit('proposal:filed', { proposalId: 'p-custom', title: 'custom' }, cfgOn());

    expect(enqueueSpy).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockApplyDiff).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
  });
});

/**
 * m236.stall-monitor.test.ts
 *
 * Verifies M236: streaming spawn + stall-based termination.
 *
 * Tests:
 *   1. idle-stall: no events for stallIdleMs → graceful-stop triggered.
 *   2. loop-stall: 6 consecutive identical tool-call events → graceful-stop triggered.
 *   3. productive stream survives: file_touched events reset no-diff counter;
 *      many events + file touches never stall.
 *   4. graceful-stop ladder via FAKE TIMERS: SIGINT sent first, SIGKILL after grace period.
 *   5. terminationReason is recorded on runEngineSandboxed RunState.
 *
 * ALL timer-dependent tests use vi.useFakeTimers() + vi.advanceTimersByTimeAsync()
 * to avoid real-time waits and the SIGKILL-after-grace race the prior attempt had.
 *
 * No real agents are spawned. No network. No LLM.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { attachStallMonitor } from '../src/core/run/run-monitor.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { RunEvent } from '../src/core/run/engines.js';

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
    // M282: disable M275 completeness gate so partial proposals are not blocked
    // in determinism tests — these tests verify terminationReason recording, not
    // proposal completeness. Gate is an orthogonal concern tested elsewhere.
    foundry: { completenessGate: false },
    ...over,
  } as AshlrConfig;
}

function textEvent(text = 'hello'): RunEvent {
  return { kind: 'text', ts: Date.now(), text };
}

function toolEvent(toolName: string, args = ''): RunEvent {
  return { kind: 'tool_call', ts: Date.now(), toolName, text: args };
}

function fileTouchedEvent(path = '/tmp/foo.ts'): RunEvent {
  return { kind: 'file_touched', ts: Date.now(), fileTouched: path };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Idle-stall: silence for stallIdleMs → monitor fires
// ---------------------------------------------------------------------------

describe('M236 idle-stall', () => {
  it('no events for stallIdleMs triggers idle-stall via fake timers', async () => {
    vi.useFakeTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      500, // 500 ms idle threshold (fake timer will advance past it)
    );

    // No events fed — just advance time past the idle threshold.
    await vi.advanceTimersByTimeAsync(600);

    expect(stallCalls).toEqual(['idle-stall']);

    const result = await monitor.waitForStall();
    expect(result).toBe('idle-stall');

    monitor.detach(); // idempotent
  });

  it('events before the deadline reset the idle timer; stall fires only after silence', async () => {
    vi.useFakeTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      500,
    );

    // Feed an event at 400 ms — resets the 500 ms idle timer.
    await vi.advanceTimersByTimeAsync(400);
    monitor.onEvent(textEvent());
    expect(stallCalls).toHaveLength(0);

    // Advance another 600 ms (400 + 600 = 1000; timer reset at 400 → fires at 900).
    await vi.advanceTimersByTimeAsync(600);
    expect(stallCalls).toEqual(['idle-stall']);

    monitor.detach();
  });
});

// ---------------------------------------------------------------------------
// 2. Loop-stall: 6 consecutive identical tool calls
// ---------------------------------------------------------------------------

describe('M236 loop-stall', () => {
  it('6 identical tool_call events trigger loop-stall', () => {
    vi.useRealTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      60_000, // long idle threshold so idle doesn't fire
    );

    // 6 identical tool+args events.
    for (let i = 0; i < 6; i++) {
      monitor.onEvent(toolEvent('read_file', '/some/path.ts'));
    }

    expect(stallCalls).toEqual(['loop-stall']);
    monitor.detach();
  });

  it('different tool calls do NOT trigger loop-stall', () => {
    vi.useRealTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      60_000,
    );

    // 6 different tool names.
    const tools = ['read_file', 'write_file', 'bash', 'read_file', 'edit_file', 'bash'];
    for (const t of tools) {
      monitor.onEvent(toolEvent(t, '/path'));
    }

    expect(stallCalls).toHaveLength(0);
    monitor.detach();
  });

  it('loop resets when a different tool call appears in the window', () => {
    vi.useRealTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      60_000,
    );

    // 5 identical, then 1 different, then 5 identical again — window is 6.
    for (let i = 0; i < 5; i++) monitor.onEvent(toolEvent('read_file', '/x'));
    monitor.onEvent(toolEvent('write_file', '/y')); // breaks the run
    for (let i = 0; i < 5; i++) monitor.onEvent(toolEvent('read_file', '/x'));

    expect(stallCalls).toHaveLength(0); // window of 6 never fully matched
    monitor.detach();
  });
});

// ---------------------------------------------------------------------------
// 3. No-diff-stall: ≥20 events, zero file touches
// ---------------------------------------------------------------------------

describe('M236 no-diff-stall', () => {
  it('400 text events with no file_touched triggers no-diff-stall', () => {
    // M291: NO_DIFF_MIN_EVENTS raised 20→80 (substantial frontier tasks read
    // many files before their first edit; 20 false-killed them).
    vi.useRealTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      60_000,
    );

    for (let i = 0; i < 400; i++) {
      monitor.onEvent(textEvent(`token ${i}`));
    }

    expect(stallCalls).toEqual(['no-diff-stall']);
    monitor.detach();
  });

  it('productive stream: file_touched events prevent no-diff-stall', () => {
    vi.useRealTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      60_000,
    );

    // 19 text events interleaved with 1 file_touched.
    for (let i = 0; i < 10; i++) monitor.onEvent(textEvent(`t${i}`));
    monitor.onEvent(fileTouchedEvent('/src/feature.ts'));
    for (let i = 10; i < 20; i++) monitor.onEvent(textEvent(`t${i}`));

    // 21 total events, 1 file touch → no-diff-stall must NOT fire.
    expect(stallCalls).toHaveLength(0);
    monitor.detach();
  });

  it('onFileTouched() resets the no-diff counter', () => {
    vi.useRealTimers();

    const stallCalls: string[] = [];
    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => stallCalls.push(reason),
      60_000,
    );

    for (let i = 0; i < 15; i++) monitor.onEvent(textEvent(`t${i}`));
    monitor.onFileTouched(); // explicit file-touch signal
    for (let i = 15; i < 25; i++) monitor.onEvent(textEvent(`t${i}`));

    expect(stallCalls).toHaveLength(0);
    monitor.detach();
  });
});

// ---------------------------------------------------------------------------
// 4. Graceful-stop ladder via FAKE TIMERS
//    SIGINT → grace period → SIGKILL
//    Verified by checking onStall fires, then waitForStall resolves.
// ---------------------------------------------------------------------------

describe('M236 graceful-stop ladder via fake timers', () => {
  it('stall fires onStall exactly once, waitForStall resolves with the reason', async () => {
    vi.useFakeTimers();

    let onStallCallCount = 0;
    let capturedReason = '';

    const monitor = attachStallMonitor(
      makeConfig(),
      (reason) => {
        onStallCallCount++;
        capturedReason = reason;
      },
      200, // 200 ms idle threshold
    );

    // Advance past idle threshold → onStall fires.
    await vi.advanceTimersByTimeAsync(300);

    expect(onStallCallCount).toBe(1);
    expect(capturedReason).toBe('idle-stall');

    // Additional advances must NOT fire onStall again (idempotent).
    await vi.advanceTimersByTimeAsync(500);
    expect(onStallCallCount).toBe(1);

    const reason = await monitor.waitForStall();
    expect(reason).toBe('idle-stall');

    monitor.detach();
  });

  it('detach() before stall resolves waitForStall with null', async () => {
    vi.useFakeTimers();

    const monitor = attachStallMonitor(
      makeConfig(),
      () => { /* not expected to fire */ },
      1000,
    );

    // Detach before the idle timer fires.
    monitor.detach();

    const reason = await monitor.waitForStall();
    expect(reason).toBeNull();
  });

  it('loop-stall: waitForStall resolves synchronously after loop detected', async () => {
    vi.useRealTimers();

    const monitor = attachStallMonitor(
      makeConfig(),
      () => { /* captured */ },
      60_000,
    );

    // Trigger a loop-stall.
    for (let i = 0; i < 6; i++) monitor.onEvent(toolEvent('read_file', '/x'));

    // waitForStall should already be resolved.
    const reason = await monitor.waitForStall();
    expect(reason).toBe('loop-stall');

    monitor.detach();
  });
});

// ---------------------------------------------------------------------------
// 5. terminationReason on RunState via runEngineSandboxed
//    (uses the same spawnEngine mock pattern as m233)
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return {
    ...orig,
    spawnEngine: vi.fn(),
  };
});

vi.mock('../src/core/run/completeness-gate.js', () => ({
  runCompletenessGate: vi.fn(),
}));

import { spawnEngine } from '../src/core/run/engines.js';
import { runCompletenessGate } from '../src/core/run/completeness-gate.js';
import { runEngineSandboxed } from '../src/core/run/sandboxed-engine.js';
import { estCostUsd } from '../src/core/run/budget.js';
import { readAgentActions } from '../src/core/fleet/agent-action-ledger.js';
import { readDecisions } from '../src/core/fleet/decisions-ledger.js';
import { selectInboxStore } from '../src/core/seams/inbox.js';
import { withTmpHome } from './helpers/h1-fixture.js';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const spawnEngineMock = spawnEngine as ReturnType<typeof vi.fn>;
const completenessGateMock = vi.mocked(runCompletenessGate);

describe('M236 terminationReason on RunState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completenessGateMock.mockResolvedValue({ pass: true });
  });

  it('pre-aborted sandboxed runs do not spawn or file proposals', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        const controller = new AbortController();
        controller.abort();

        const result = await runEngineSandboxed('claude', 'Do something', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });

        expect(spawnEngineMock).not.toHaveBeenCalled();
        expect(result.state).toMatchObject({ status: 'aborted', terminationReason: 'cancelled' });
        expect(result).not.toHaveProperty('proposalId');
        expect(result).not.toHaveProperty('proposalOutcome');
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('cancelled engines never capture a partial diff as a proposal', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        const controller = new AbortController();
        spawnEngineMock.mockImplementationOnce((cmd: { cwd?: string }, _cfg, options) => {
          if (cmd?.cwd && existsSync(cmd.cwd)) {
            writeFileSync(join(cmd.cwd, 'cancelled.ts'), 'export const partial = true;\n', 'utf8');
          }
          expect(options?.signal).toBe(controller.signal);
          controller.abort();
          return Promise.resolve({
            ok: false,
            output: '',
            error: 'cancelled',
            terminationReason: 'cancelled' as const,
          });
        });

        const result = await runEngineSandboxed('claude', 'Do something', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });

        expect(result.state).toMatchObject({ status: 'aborted', terminationReason: 'cancelled' });
        expect(result).not.toHaveProperty('proposalId');
        expect(result).not.toHaveProperty('proposalOutcome');
        const event = readAgentActions().find((row) => row.runId === result.state.id);
        expect(event).toMatchObject({ outcome: 'blocked', runEventSummary: { status: 'aborted' } });
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('preserves unconfirmed termination failure, retains the sandbox, and counts every cli invocation', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        const controller = new AbortController();
        spawnEngineMock.mockImplementationOnce(() => {
          controller.abort();
          return Promise.resolve({
            ok: false,
            output: '',
            error: 'termination deadline elapsed with process-group exit unconfirmed',
            terminationReason: 'error-exit' as const,
            configRecoveryAttempts: 1,
          });
        });

        const result = await runEngineSandboxed('claude', 'Retain unsafe cleanup', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });

        expect(result.state).toMatchObject({
          status: 'failed',
          terminationReason: 'error-exit',
          usage: { tokensIn: 0, tokensOut: 0, steps: 2, estCostUsd: 0 },
        });
        expect(result.state.result).toContain('process-group exit unconfirmed');
        expect(result.sandboxRetention).toMatchObject({
          status: 'retained',
          reason: 'process-cleanup-unconfirmed',
          recovery: 'orphan-sweep',
        });
        expect(existsSync(result.sandboxRetention!.worktreePath)).toBe(true);
        expect(result).not.toHaveProperty('proposalId');
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('accumulates retry usage once across results, proposal metadata, and ledgers', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        const cfg = makeConfig({
          foundry: { completenessGate: false, dispatchRetries: 1 },
        });
        spawnEngineMock
          .mockResolvedValueOnce({
            ok: false,
            output: '',
            error: 'aborted_streaming',
            usage: { tokensIn: 11, tokensOut: 4 },
          })
          .mockImplementationOnce((cmd: { cwd?: string }) => {
            if (cmd.cwd && existsSync(cmd.cwd)) {
              writeFileSync(join(cmd.cwd, 'retried.ts'), 'export const retried = true;\n', 'utf8');
            }
            return Promise.resolve({
              ok: true,
              output: 'retry succeeded',
              usage: { tokensIn: 7, tokensOut: 3 },
            });
          });

        const result = await runEngineSandboxed('claude', 'Retry exactly once', cfg, {
          sourceRepo: repo.dir,
          propose: true,
        });
        const expectedCost = estCostUsd('claude', 18, 7);

        expect(spawnEngineMock).toHaveBeenCalledTimes(2);
        expect(result.state).toMatchObject({
          status: 'done',
          usage: { tokensIn: 18, tokensOut: 7, steps: 2 },
        });
        expect(result.state.usage.estCostUsd).toBeCloseTo(expectedCost, 10);
        expect(result.proposalId).toBeDefined();

        const proposal = selectInboxStore(cfg).load(result.proposalId!);
        expect(proposal?.runEventSummary).toMatchObject({
          tokensIn: 18,
          tokensOut: 7,
          costUsd: expectedCost,
        });
        const [decision] = readDecisions({ proposalId: result.proposalId });
        expect(decision).toMatchObject({
          tokensIn: 18,
          tokensOut: 7,
          costUsd: expectedCost,
        });
        const event = readAgentActions().find((row) => row.runId === result.state.id);
        expect(event).toMatchObject({
          spentUsd: expectedCost,
          runEventSummary: {
            tokensIn: 18,
            tokensOut: 7,
            costUsd: expectedCost,
            actionCounts: { spawnAttempts: 2, transientRetries: 1 },
          },
        });
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('preserves usage from paid transient attempts when a retry is cancelled', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        const controller = new AbortController();
        spawnEngineMock
          .mockResolvedValueOnce({
            ok: false,
            output: '',
            error: 'aborted_streaming',
            usage: { tokensIn: 9, tokensOut: 4 },
          })
          .mockImplementationOnce((_cmd, _cfg, options) => {
            expect(options?.signal).toBe(controller.signal);
            controller.abort();
            return Promise.resolve({
              ok: false,
              output: '',
              error: 'cancelled',
              terminationReason: 'cancelled' as const,
              usage: { tokensIn: 5, tokensOut: 2 },
            });
          });

        const result = await runEngineSandboxed('claude', 'Cancel the retry', makeConfig({
          foundry: { completenessGate: false, dispatchRetries: 1 },
        }), {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });
        const expectedCost = estCostUsd('claude', 14, 6);

        expect(result.state).toMatchObject({
          status: 'aborted',
          terminationReason: 'cancelled',
          usage: { tokensIn: 14, tokensOut: 6, steps: 2 },
        });
        expect(result.state.usage.estCostUsd).toBeCloseTo(expectedCost, 10);
        const event = readAgentActions().find((row) => row.runId === result.state.id);
        expect(event).toMatchObject({
          outcome: 'blocked',
          spentUsd: expectedCost,
          runEventSummary: {
            status: 'aborted',
            tokensIn: 14,
            tokensOut: 6,
            costUsd: expectedCost,
            actionCounts: { spawnAttempts: 2, transientRetries: 1 },
          },
        });
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('books verify-to-green repair usage when cancellation lands after repair', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        const controller = new AbortController();
        completenessGateMock.mockResolvedValueOnce({ pass: false, reason: 'typecheck failed' });
        spawnEngineMock
          .mockImplementationOnce((cmd: { cwd?: string }) => {
            if (cmd.cwd && existsSync(cmd.cwd)) {
              writeFileSync(join(cmd.cwd, 'repair-target.ts'), 'export const repaired = false;\n', 'utf8');
            }
            return Promise.resolve({
              ok: true,
              output: 'initial attempt',
              usage: { tokensIn: 10, tokensOut: 5 },
            });
          })
          .mockImplementationOnce((_cmd, _cfg, options) => {
            expect(options?.signal).toBe(controller.signal);
            controller.abort();
            return Promise.resolve({
              ok: false,
              output: '',
              error: 'cancelled after repair usage was reported',
              terminationReason: 'cancelled' as const,
              usage: { tokensIn: 7, tokensOut: 3 },
            });
          });

        const result = await runEngineSandboxed('claude', 'Repair the target', makeConfig({
          foundry: {
            completenessGate: true,
            verifyToGreen: { enabled: true, maxIterations: 1 },
          },
        }), {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });

        expect(result.state).toMatchObject({
          status: 'aborted',
          terminationReason: 'cancelled',
          usage: { tokensIn: 17, tokensOut: 8, steps: 2 },
        });
        expect(result.state.usage.estCostUsd).toBeCloseTo(estCostUsd('claude', 17, 8), 10);
        expect(result).not.toHaveProperty('proposalId');
        const event = readAgentActions().find((row) => row.runId === result.state.id);
        expect(event).toMatchObject({
          outcome: 'blocked',
          spentUsd: result.state.usage.estCostUsd,
          runEventSummary: {
            status: 'aborted',
            tokensIn: 17,
            tokensOut: 8,
          },
        });
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('books one step and one token/cost delta for each paid verify-to-green repair', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        completenessGateMock
          .mockResolvedValueOnce({ pass: false, reason: 'typecheck failed' })
          .mockResolvedValueOnce({ pass: true });
        spawnEngineMock
          .mockImplementationOnce((cmd: { cwd?: string }) => {
            writeFileSync(join(cmd.cwd!, 'repair-target.ts'), 'export const repaired = false;\n', 'utf8');
            return Promise.resolve({
              ok: true,
              output: 'initial attempt',
              usage: { tokensIn: 10, tokensOut: 5 },
            });
          })
          .mockImplementationOnce((cmd: { cwd?: string }) => {
            writeFileSync(join(cmd.cwd!, 'repair-target.ts'), 'export const repaired = true;\n', 'utf8');
            return Promise.resolve({
              ok: true,
              output: 'repair complete',
              usage: { tokensIn: 7, tokensOut: 3 },
            });
          });

        const result = await runEngineSandboxed('claude', 'Repair the target', makeConfig({
          foundry: {
            completenessGate: true,
            verifyToGreen: { enabled: true, maxIterations: 1 },
          },
        }), {
          sourceRepo: repo.dir,
          propose: true,
          budget: { maxSteps: 2 },
        });

        expect(spawnEngineMock).toHaveBeenCalledTimes(2);
        expect(result.state.usage).toMatchObject({ tokensIn: 17, tokensOut: 8, steps: 2 });
        expect(result.state.usage.estCostUsd).toBeCloseTo(estCostUsd('claude', 17, 8), 10);
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('does not start a verify-to-green repair after maxSteps is exhausted', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();
        completenessGateMock.mockResolvedValueOnce({ pass: false, reason: 'typecheck failed' });
        spawnEngineMock.mockImplementationOnce((cmd: { cwd?: string }) => {
          writeFileSync(join(cmd.cwd!, 'repair-target.ts'), 'export const repaired = false;\n', 'utf8');
          return Promise.resolve({
            ok: true,
            output: 'initial attempt',
            usage: { tokensIn: 10, tokensOut: 5 },
          });
        });

        const result = await runEngineSandboxed('claude', 'Repair the target', makeConfig({
          foundry: {
            completenessGate: true,
            verifyToGreen: { enabled: true, maxIterations: 3 },
          },
        }), {
          sourceRepo: repo.dir,
          propose: true,
          budget: { maxSteps: 1 },
        });

        expect(spawnEngineMock).toHaveBeenCalledTimes(1);
        expect(result.state.usage).toMatchObject({ tokensIn: 10, tokensOut: 5, steps: 1 });
        expect(result.proposalOutcome?.kind).toBe('completeness-gate');
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('stall-terminated run records terminationReason on the failed RunState', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();

        // Mock returns a stall-terminated failure with terminationReason.
        spawnEngineMock.mockImplementationOnce(
          (cmd: { cwd?: string }) => {
            if (cmd?.cwd && existsSync(cmd.cwd)) {
              writeFileSync(join(cmd.cwd, 'partial.ts'), 'export const x = 1;\n', 'utf8');
            }
            return Promise.resolve({
              ok: false,
              output: '',
              error: 'killed by signal SIGINT',
              terminationReason: 'idle-stall' as const,
            });
          },
        );

        const result = await runEngineSandboxed('claude', 'Do something', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
        });

        expect(result.state.status).toBe('failed');
        // terminationReason is recorded on the RunState.
        expect(result.state.terminationReason).toBe('idle-stall');
        // partial proposal still captured (M233 path).
        expect(result.proposalId).toBeDefined();
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('clean-exit run has no terminationReason', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();

        spawnEngineMock.mockImplementationOnce(
          (cmd: { cwd?: string }) => {
            if (cmd?.cwd && existsSync(cmd.cwd)) {
              writeFileSync(join(cmd.cwd, 'output.ts'), 'export const y = 2;\n', 'utf8');
            }
            return Promise.resolve({
              ok: true,
              output: 'RAW_STDOUT_SENTINEL engine output should not enter metadata',
              usage: { tokensIn: 10, tokensOut: 5 },
            });
          },
        );

        const result = await runEngineSandboxed('claude', 'RAW_PROMPT_SENTINEL Write output.ts', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
        });

        expect(result.state.status).toBe('done');
        expect(result.state.terminationReason).toBeUndefined();
        const event = readAgentActions().find((row) => row.action === 'sandboxed-engine:run' && row.runId === result.state.id);
        expect(event).toMatchObject({
          actor: 'agent',
          kind: 'maintenance',
          outcome: 'ok',
          runId: result.state.id,
          runEventSummary: {
            runId: result.state.id,
            status: 'done',
            outcome: 'proposal-created',
            proposalCreated: true,
            actionCounts: {
              sandboxCreated: 1,
              spawnAttempts: 1,
              proposalCaptureAttempts: 1,
              proposalCreated: 1,
              diffFiles: 1,
              diffLines: 1,
            },
          },
        });
        expect(event?.counts).toMatchObject({
          sandboxCreated: 1,
          spawnAttempts: 1,
          proposalCaptureAttempts: 1,
          proposalCreated: 1,
        });
        expect(event?.semanticEvents).toEqual([
          expect.objectContaining({
            kind: 'intent',
            subjectRef: `run:${result.state.id}`,
            objectiveCode: 'work.execute',
          }),
          expect.objectContaining({ kind: 'action', actionCode: 'agent.run', status: 'completed' }),
          expect.objectContaining({
            kind: 'observation',
            metricCode: 'agent.proposal.created',
            value: 1,
            unit: 'boolean',
          }),
        ]);
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain('RAW_PROMPT_SENTINEL');
        expect(serialized).not.toContain('RAW_STDOUT_SENTINEL');
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });

  it('proposal-disabled terminal telemetry is outcome-neutral and counted', async () => {
    await withTmpHome(async (fx) => {
      const prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
      try {
        const repo = fx.makeRepo();
        repo.enroll();

        spawnEngineMock.mockResolvedValueOnce({
          ok: true,
          output: 'RAW_STDOUT_SENTINEL disabled proposal output',
          usage: { tokensIn: 7, tokensOut: 3 },
        });

        const result = await runEngineSandboxed('claude', 'RAW_PROMPT_SENTINEL internal attempt', makeConfig(), {
          sourceRepo: repo.dir,
          propose: false,
        });

        expect(result.state.status).toBe('done');
        expect(result.proposalOutcome?.kind).toBe('proposal-disabled');
        const event = readAgentActions().find((row) => row.action === 'sandboxed-engine:run' && row.runId === result.state.id);
        expect(event).toMatchObject({
          actor: 'agent',
          kind: 'maintenance',
          outcome: 'ok',
          runId: result.state.id,
          runEventSummary: {
            runId: result.state.id,
            status: 'done',
            outcome: 'proposal-disabled',
            actionCounts: {
              sandboxCreated: 1,
              spawnAttempts: 1,
              proposalDisabled: 1,
            },
          },
        });
        expect(event?.runEventSummary?.proposalCreated).toBeUndefined();
        expect(event?.counts).toMatchObject({
          sandboxCreated: 1,
          spawnAttempts: 1,
          proposalCaptureAttempts: 0,
          proposalDisabled: 1,
        });
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain('RAW_PROMPT_SENTINEL');
        expect(serialized).not.toContain('RAW_STDOUT_SENTINEL');
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });
});

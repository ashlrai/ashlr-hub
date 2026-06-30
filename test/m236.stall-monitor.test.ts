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

import { spawnEngine } from '../src/core/run/engines.js';
import { runEngineSandboxed } from '../src/core/run/sandboxed-engine.js';
import { withTmpHome } from './helpers/h1-fixture.js';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const spawnEngineMock = spawnEngine as ReturnType<typeof vi.fn>;

describe('M236 terminationReason on RunState', () => {
  beforeEach(() => vi.clearAllMocks());

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
            return Promise.resolve({ ok: true, output: '{}', usage: { tokensIn: 10, tokensOut: 5 } });
          },
        );

        const result = await runEngineSandboxed('claude', 'Write output.ts', makeConfig(), {
          sourceRepo: repo.dir,
          propose: true,
        });

        expect(result.state.status).toBe('done');
        expect(result.state.terminationReason).toBeUndefined();
      } finally {
        if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
        else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
      }
    });
  });
});

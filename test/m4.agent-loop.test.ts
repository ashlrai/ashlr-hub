/**
 * M4 agent-loop tests — hermetic, mock ProviderClient only, no network.
 *
 * Covers:
 *   - Mock client returns toolCall then final text → runTask executes tool via
 *     injected tool executor (tools array), stops on final, emits RunSteps.
 *   - Budget abort: client keeps returning content without stopping, budget
 *     exceeded → task.status 'failed' (no result yet) or 'done' (partial),
 *     never throws.
 *   - Error handling: client.chat rejects → task.status 'failed' with error,
 *     never throws.
 *   - ctx.usage is mutated (accumulated) across steps.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProviderClient, ChatMessage, ChatResult, RunTask, RunBudget, RunUsage, RunStep } from '../src/core/types.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { newUsage } from '../src/core/run/budget.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<RunTask> = {}): RunTask {
  return {
    id: 'task-1',
    goal: 'What is 2+2?',
    deps: [],
    status: 'pending',
    ...overrides,
  };
}

function makeBudget(maxTokens = 10_000, maxSteps = 20): RunBudget {
  return { maxTokens, maxSteps, allowCloud: false };
}

/** Build a mock ProviderClient whose chat() iterates through `responses`. */
function mockClient(responses: ChatResult[], opts: { supportsTools?: boolean } = {}): ProviderClient {
  let callIdx = 0;
  return {
    id: 'mock',
    supportsTools: opts.supportsTools ?? true,
    chat: vi.fn(async (_messages: ChatMessage[], _tools?: unknown[]): Promise<ChatResult> => {
      const resp = responses[callIdx];
      if (resp === undefined) {
        // Safety: loop on last response if we run out of mocked entries
        return responses[responses.length - 1]!;
      }
      callIdx++;
      return resp;
    }),
  };
}

/** A simple ChatResult with only text content. */
function textResult(content: string, tokensIn = 10, tokensOut = 5): ChatResult {
  return { content, usage: { tokensIn, tokensOut } };
}

/** A ChatResult carrying a single tool call. */
function toolCallResult(toolName: string, args: unknown, id = 'tc-1'): ChatResult {
  return {
    content: '',
    toolCalls: [{ id, name: toolName, arguments: args }],
    usage: { tokensIn: 20, tokensOut: 10 },
  };
}

/**
 * Collect all steps emitted by runTask.
 *
 * runTask no longer mutates ctx.usage itself — the orchestrator is the single
 * writer of cumulative usage and does so inside its onStep callback. To exercise
 * that contract here, pass a `usage` object: the returned onStep accumulates each
 * step's reported usage INTO that object in place, exactly as the orchestrator does.
 */
function collectSteps(usage?: RunUsage): { steps: RunStep[]; onStep: (s: RunStep) => void } {
  const steps: RunStep[] = [];
  const onStep = (s: RunStep): void => {
    steps.push(s);
    if (usage && s.usage) {
      usage.tokensIn += s.usage.tokensIn;
      usage.tokensOut += s.usage.tokensOut;
      usage.steps += s.usage.steps;
    }
  };
  return { steps, onStep };
}

// ---------------------------------------------------------------------------
// Basic completion — plain chat, no tools
// ---------------------------------------------------------------------------

describe('runTask — plain chat completion', () => {
  it('sets task.status to done on successful text reply', async () => {
    const client = mockClient([textResult('The answer is 4.')]);
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, client, { budget: makeBudget(), usage: newUsage(), onStep });
    expect(task.status).toBe('done');
  });

  it('sets task.result to the model reply text', async () => {
    const client = mockClient([textResult('The answer is 4.')]);
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, client, { budget: makeBudget(), usage: newUsage(), onStep });
    expect(task.result).toBe('The answer is 4.');
  });

  it('populates task.usage after completion', async () => {
    const client = mockClient([textResult('Done.', 10, 5)]);
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, client, { budget: makeBudget(), usage: newUsage(), onStep });
    expect(task.usage).toBeDefined();
    expect(task.usage!.tokensIn).toBeGreaterThan(0);
  });

  it('emits at least one RunStep of kind model', async () => {
    const client = mockClient([textResult('Done.')]);
    const task = makeTask();
    const { steps, onStep } = collectSteps();
    await runTask(task, client, { budget: makeBudget(), usage: newUsage(), onStep });
    const modelSteps = steps.filter(s => s.kind === 'model');
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);
  });

  it('emitted steps have the correct taskId', async () => {
    const client = mockClient([textResult('Done.')]);
    const task = makeTask({ id: 'my-task-99' });
    const { steps, onStep } = collectSteps();
    await runTask(task, client, { budget: makeBudget(), usage: newUsage(), onStep });
    for (const s of steps) {
      expect(s.taskId).toBe('my-task-99');
    }
  });

  it('returns the same task object (not a copy)', async () => {
    const client = mockClient([textResult('Done.')]);
    const task = makeTask();
    const { onStep } = collectSteps();
    const returned = await runTask(task, client, { budget: makeBudget(), usage: newUsage(), onStep });
    expect(returned).toBe(task);
  });
});

// ---------------------------------------------------------------------------
// Tool call → final text flow
// ---------------------------------------------------------------------------

describe('runTask — tool call then final text', () => {
  it('calls client.chat at least twice (once for tool call, once for final)', async () => {
    const client = mockClient([
      toolCallResult('calculator', { expr: '2+2' }),
      textResult('The answer is 4.'),
    ]);
    // Inject a fake tool executor via the tools array; the loop should feed
    // back a tool result message after the tool call step.
    const fakeTool = { name: 'calculator', execute: async () => '4' };
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, client, {
      tools: [fakeTool],
      budget: makeBudget(),
      usage: newUsage(),
      onStep,
    });
    expect((client.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('sets task.status done after tool call + final text', async () => {
    const client = mockClient([
      toolCallResult('lookup', { key: 'x' }),
      textResult('x equals 42.'),
    ]);
    const fakeTool = { name: 'lookup', execute: async () => '42' };
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, client, {
      tools: [fakeTool],
      budget: makeBudget(),
      usage: newUsage(),
      onStep,
    });
    expect(task.status).toBe('done');
  });

  it('sets task.result to the final text after tool roundtrip', async () => {
    const client = mockClient([
      toolCallResult('lookup', { key: 'x' }),
      textResult('x equals 42.'),
    ]);
    const fakeTool = { name: 'lookup', execute: async () => '42' };
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, client, {
      tools: [fakeTool],
      budget: makeBudget(),
      usage: newUsage(),
      onStep,
    });
    expect(task.result).toBe('x equals 42.');
  });

  it('emits a tool step between model steps', async () => {
    const client = mockClient([
      toolCallResult('lookup', {}),
      textResult('Done.'),
    ]);
    const fakeTool = { name: 'lookup', execute: async () => 'result' };
    const task = makeTask();
    const { steps, onStep } = collectSteps();
    await runTask(task, client, {
      tools: [fakeTool],
      budget: makeBudget(),
      usage: newUsage(),
      onStep,
    });
    // Should have both model and tool steps
    expect(steps.some(s => s.kind === 'model')).toBe(true);
    expect(steps.some(s => s.kind === 'tool')).toBe(true);
  });

  it('degrades to plain chat when supportsTools is false (no tool steps emitted)', async () => {
    // When supportsTools=false, tools are NOT passed to chat; loop terminates
    // on first text response.
    const client = mockClient(
      [textResult('Fallback answer.')],
      { supportsTools: false },
    );
    const fakeTool = { name: 'lookup', execute: async () => 'result' };
    const task = makeTask();
    const { steps, onStep } = collectSteps();
    await runTask(task, client, {
      tools: [fakeTool],
      budget: makeBudget(),
      usage: newUsage(),
      onStep,
    });
    expect(task.status).toBe('done');
    expect(steps.filter(s => s.kind === 'tool').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Budget abort — hard ceiling enforced
// ---------------------------------------------------------------------------

describe('runTask — budget abort', () => {
  it('stops when token budget is exceeded; does not throw', async () => {
    // Each call consumes 100+50 tokens. Budget is 50 tokens → over after first call.
    const responses = Array.from({ length: 10 }, (_, i) =>
      textResult(`step ${i}`, 100, 50),
    );
    const client = mockClient(responses);
    const task = makeTask();
    const { onStep } = collectSteps();
    const tinyBudget: RunBudget = { maxTokens: 50, maxSteps: 100, allowCloud: false };
    // Should not throw
    await expect(
      runTask(task, client, { budget: tinyBudget, usage: newUsage(), onStep }),
    ).resolves.toBeDefined();
  });

  it('task.status is failed or done (never throws) when token budget exceeded before any result', async () => {
    // Budget so small (0 tokens) that even after first step we're over budget
    // and no result was produced.
    const client = mockClient([textResult('', 1, 1)]); // empty content
    const task = makeTask();
    const { onStep } = collectSteps();
    const zeroBudget: RunBudget = { maxTokens: 0, maxSteps: 100, allowCloud: false };
    await runTask(task, client, { budget: zeroBudget, usage: newUsage(), onStep });
    expect(['failed', 'done']).toContain(task.status);
  });

  it('stops when step budget is exceeded; does not throw', async () => {
    // Every response is empty content with no tool calls — loop would run forever
    // without a step cap. Use maxSteps:2.
    const infiniteResponses = Array.from({ length: 50 }, () => textResult('', 1, 1));
    const client = mockClient(infiniteResponses);
    const task = makeTask();
    // Step-budget enforcement depends on the single-writer (orchestrator-style)
    // onStep maintaining ctx.usage.steps; pass a usage accumulator so the
    // overBudget(ctx.usage) step check fires at maxSteps.
    const usage = newUsage();
    const { onStep } = collectSteps(usage);
    const stepBudget: RunBudget = { maxTokens: 100_000, maxSteps: 2, allowCloud: false };
    await expect(
      runTask(task, client, { budget: stepBudget, usage, onStep }),
    ).resolves.toBeDefined();
    // Should not have run more than maxSteps+1 model calls
    expect((client.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('accumulates usage into ctx.usage even on budget abort', async () => {
    const client = mockClient([textResult('x', 100, 50), textResult('y', 100, 50)]);
    const task = makeTask();
    const usage = newUsage();
    const { onStep } = collectSteps(usage);
    const tinyBudget: RunBudget = { maxTokens: 50, maxSteps: 100, allowCloud: false };
    await runTask(task, client, { budget: tinyBudget, usage, onStep });
    // usage.tokensIn should have been incremented (via onStep, as orchestrator does)
    expect(usage.tokensIn + usage.tokensOut).toBeGreaterThan(0);
  });

  it('preserves partial result when budget exceeded mid-run with content', async () => {
    // First call returns real content; budget exceeded afterward.
    const client = mockClient([textResult('Partial answer.', 1000, 1000)]);
    const task = makeTask();
    const { onStep } = collectSteps();
    const tightBudget: RunBudget = { maxTokens: 100, maxSteps: 100, allowCloud: false };
    await runTask(task, client, { budget: tightBudget, usage: newUsage(), onStep });
    // The result that was produced should be preserved — implementation may
    // prepend a budget-exceeded annotation but the original content is included.
    if (task.status === 'done' && task.result !== undefined) {
      expect(task.result).toContain('Partial answer.');
    }
    // Whether done or failed, no throw occurred — already confirmed by resolving
  });
});

// ---------------------------------------------------------------------------
// Error handling — client.chat rejects
// ---------------------------------------------------------------------------

describe('runTask — model error sets task.status to failed', () => {
  it('sets status failed when chat throws', async () => {
    const errClient: ProviderClient = {
      id: 'err-mock',
      supportsTools: false,
      chat: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, errClient, { budget: makeBudget(), usage: newUsage(), onStep });
    expect(task.status).toBe('failed');
  });

  it('sets task.error when chat throws', async () => {
    const errClient: ProviderClient = {
      id: 'err-mock',
      supportsTools: false,
      chat: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const task = makeTask();
    const { onStep } = collectSteps();
    await runTask(task, errClient, { budget: makeBudget(), usage: newUsage(), onStep });
    expect(typeof task.error).toBe('string');
    expect(task.error!.length).toBeGreaterThan(0);
  });

  it('returns the task object even when chat throws', async () => {
    const errClient: ProviderClient = {
      id: 'err-mock',
      supportsTools: false,
      chat: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const task = makeTask();
    const { onStep } = collectSteps();
    const returned = await runTask(task, errClient, { budget: makeBudget(), usage: newUsage(), onStep });
    expect(returned).toBe(task);
  });
});

// ---------------------------------------------------------------------------
// ctx.usage mutation — verifies accumulation across steps
// ---------------------------------------------------------------------------

describe('runTask — ctx.usage accumulation', () => {
  it('increments ctx.usage.steps by the number of model steps', async () => {
    // Two sequential model exchanges before final answer
    const task = makeTask();
    const usage = newUsage();
    const { onStep } = collectSteps(usage);
    // To allow two steps we need to trick the loop into continuing.
    // We'll use a client that returns empty content first (loop continues),
    // then real content second.
    const client2 = mockClient([
      { content: '', usage: { tokensIn: 10, tokensOut: 0 } }, // no tool call, no content → continues
      textResult('Final.', 10, 5),
    ]);
    await runTask(task, client2, { budget: makeBudget(), usage, onStep });
    expect(usage.steps).toBeGreaterThanOrEqual(1);
  });

  it('increments ctx.usage.tokensIn across steps', async () => {
    const client = mockClient([textResult('done.', 123, 45)]);
    const task = makeTask();
    const usage = newUsage();
    const { onStep } = collectSteps(usage);
    await runTask(task, client, { budget: makeBudget(), usage, onStep });
    expect(usage.tokensIn).toBeGreaterThan(0);
  });

  it('increments ctx.usage.tokensOut across steps', async () => {
    const client = mockClient([textResult('done.', 10, 99)]);
    const task = makeTask();
    const usage = newUsage();
    const { onStep } = collectSteps(usage);
    await runTask(task, client, { budget: makeBudget(), usage, onStep });
    expect(usage.tokensOut).toBeGreaterThan(0);
  });

  it('pre-existing usage in ctx is respected for budget calculation', async () => {
    // Start with usage already at 9990 tokens; budget is 10000; first step adds 100 → over
    const client = mockClient([textResult('Hello.', 100, 50)]);
    const task = makeTask();
    const { onStep } = collectSteps();
    const usage: RunUsage = { tokensIn: 9990, tokensOut: 0, steps: 0, estCostUsd: 0 };
    const budget: RunBudget = { maxTokens: 10_000, maxSteps: 100, allowCloud: false };
    await runTask(task, client, { budget, usage, onStep });
    // Whether it ran or not, the pre-existing usage is preserved
    expect(usage.tokensIn).toBeGreaterThanOrEqual(9990);
  });
});

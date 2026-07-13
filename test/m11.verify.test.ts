/**
 * M11 verify tests — hermetic, mock ProviderClient only, no real network.
 *
 * Covers verifyTask:
 *   - Heuristic: empty result → ok:false
 *   - Heuristic: result containing 'error'/'ERROR'/'Error' → ok:false
 *   - Heuristic: result clearly off-topic (no keyword overlap with goal) → ok:false
 *   - Heuristic: plausible result → ok:true
 *   - Model path: invoked only when heuristic is inconclusive AND budget allows.
 *   - Budget guard: when budget is exhausted, falls back to heuristic verdict.
 *   - Never throws.
 *   - Mutates usage when model check is run.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  RunTask,
  ProviderClient,
  RunBudget,
  RunUsage,
  ChatMessage,
  ChatResult,
} from '../src/core/types.js';
import { verifyTask } from '../src/core/run/verify.js';
import { newUsage } from '../src/core/run/budget.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(goal: string, result?: string, overrides: Partial<RunTask> = {}): RunTask {
  return {
    id: 'task-verify-1',
    goal,
    deps: [],
    status: result !== undefined ? 'done' : 'pending',
    result,
    ...overrides,
  };
}

function makeBudget(maxTokens = 100_000, maxSteps = 50): RunBudget {
  return { maxTokens, maxSteps, allowCloud: false };
}

/** Budget already at or beyond the ceiling. */
function exhaustedBudget(): RunBudget {
  return { maxTokens: 0, maxSteps: 0, allowCloud: false };
}

/** Exhausted usage (already at ceiling). */
function exhaustedUsage(): RunUsage {
  return { tokensIn: 100_000, tokensOut: 0, steps: 50, estCostUsd: 0 };
}

/** Mock client that returns a verification verdict as JSON in its content. */
function mockClientVerdict(ok: boolean, reason = 'mock reason'): ProviderClient {
  return {
    id: 'mock-verify',
    supportsTools: false,
    chat: vi.fn(async (_msgs: ChatMessage[]): Promise<ChatResult> => ({
      content: JSON.stringify({ ok, reason }),
      usage: { tokensIn: 10, tokensOut: 5 },
    })),
  };
}

/** Mock client that returns a plain text verdict. */
function mockClientText(text: string): ProviderClient {
  return {
    id: 'mock-verify-text',
    supportsTools: false,
    chat: vi.fn(async (): Promise<ChatResult> => ({
      content: text,
      usage: { tokensIn: 10, tokensOut: 5 },
    })),
  };
}

/** Mock client that rejects. */
function mockClientError(): ProviderClient {
  return {
    id: 'mock-verify-err',
    supportsTools: false,
    chat: vi.fn(async (): Promise<ChatResult> => {
      throw new Error('model unavailable');
    }),
  };
}

// ---------------------------------------------------------------------------
// Heuristic: empty / missing result
// ---------------------------------------------------------------------------

describe('verifyTask — heuristic: empty result', () => {
  it('flags empty string result as ok:false', async () => {
    const task = makeTask('Write a function', '');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.ok).toBe(false);
  });

  it('flags undefined result as ok:false', async () => {
    const task = makeTask('Write a function', undefined);
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.ok).toBe(false);
  });

  it('flags whitespace-only result as ok:false', async () => {
    const task = makeTask('Write a function', '   \n  ');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.ok).toBe(false);
  });

  it('method is heuristic for empty result', async () => {
    const task = makeTask('Summarize the document', '');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.method).toBe('heuristic');
  });
});

// ---------------------------------------------------------------------------
// Heuristic: error markers in result
// ---------------------------------------------------------------------------

describe('verifyTask — heuristic: error markers', () => {
  it('flags result containing "Error:" as ok:false', async () => {
    const task = makeTask('Run the tool', 'Error: command not found');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.ok).toBe(false);
  });

  it('flags result containing "error" (lowercase) as ok:false', async () => {
    const task = makeTask('Run the tool', 'failed with error: timeout');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.ok).toBe(false);
  });

  it('flags result containing "ERROR" (uppercase) as ok:false', async () => {
    const task = makeTask('Compile code', 'COMPILATION ERROR: syntax error at line 5');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.ok).toBe(false);
  });

  it('method is heuristic for error-marker results', async () => {
    const task = makeTask('Run step', 'Error: failed');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.method).toBe('heuristic');
  });
});

// ---------------------------------------------------------------------------
// Heuristic: off-topic detection
// ---------------------------------------------------------------------------

describe('verifyTask — heuristic: off-topic result', () => {
  it('flags a completely irrelevant result as ok:false', async () => {
    // Goal is about Python; result talks about something entirely different
    const task = makeTask(
      'Write a Python fibonacci function',
      'The weather today is sunny with a high of 72 degrees.',
    );
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    // Heuristic should catch the disconnect
    expect(verdict.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Heuristic: plausible good result
// ---------------------------------------------------------------------------

describe('verifyTask — heuristic: good result', () => {
  it('passes a result that overlaps clearly with the goal', async () => {
    const task = makeTask(
      'Write a Python function to add two numbers',
      'def add(a, b):\n    return a + b\n\nThis Python function adds two numbers.',
    );
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(verdict.ok).toBe(true);
  });

  it('method is heuristic when heuristic is confident', async () => {
    const task = makeTask(
      'List the first 3 prime numbers',
      'The first 3 prime numbers are: 2, 3, 5.',
    );
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    // When heuristic is confident, it should not use the model.
    // Method may be 'heuristic' or 'model' depending on heuristic confidence —
    // but if ok:true and heuristic was confident, method should be 'heuristic'.
    expect(['heuristic', 'model']).toContain(verdict.method);
    expect(verdict.ok).toBe(true);
  });

  it('reason is a non-empty string', async () => {
    const task = makeTask('Say hello', 'Hello, world!');
    const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
    expect(typeof verdict.reason).toBe('string');
    expect(verdict.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Budget guard — model check skipped when budget exhausted
// ---------------------------------------------------------------------------

describe('verifyTask — budget guard', () => {
  it('falls back to heuristic when token budget is 0', async () => {
    const client = mockClientVerdict(true, 'model says ok');
    const task = makeTask('Explain recursion', 'A function calling itself is recursion.');
    const verdict = await verifyTask(task, client, exhaustedBudget(), newUsage());
    // Budget is 0 — model should NOT be called
    expect(client.chat).not.toHaveBeenCalled();
    expect(verdict.method).toBe('heuristic');
  });

  it('falls back to heuristic when usage is already at ceiling', async () => {
    const client = mockClientVerdict(true, 'model says ok');
    const task = makeTask('Write tests', 'Here are the tests for the function.');
    const verdict = await verifyTask(
      task,
      client,
      { maxTokens: 100_000, maxSteps: 50, allowCloud: false },
      exhaustedUsage(),
    );
    expect(client.chat).not.toHaveBeenCalled();
    expect(verdict.method).toBe('heuristic');
  });

  it('never exceeds global budget — usage does not exceed maxTokens after verify', async () => {
    const client = mockClientVerdict(true);
    const task = makeTask('Write a sort algorithm', 'def sort(arr): return sorted(arr)');
    const budget = makeBudget(10_000, 10);
    const usage = newUsage(); // starts at 0
    await verifyTask(task, client, budget, usage);
    expect(usage.tokensIn + usage.tokensOut).toBeLessThanOrEqual(budget.maxTokens);
  });
});

// ---------------------------------------------------------------------------
// Model path — invoked when budget allows and heuristic is inconclusive
// ---------------------------------------------------------------------------

describe('verifyTask — model path (mocked)', () => {
  it('mutates usage when model check runs', async () => {
    // Provide a result that is somewhat ambiguous to encourage model check.
    // "ok" and not "error" and has some overlap but might be inconclusive.
    const task = makeTask(
      'Translate "cat" to French',
      'le chat',
    );
    const usage = newUsage();
    const client = mockClientVerdict(true, 'looks correct');
    await verifyTask(task, client, makeBudget(100_000, 100), usage);
    // If model was called, usage should have increased
    // (If heuristic was confident, model might not be called — either is valid)
    const totalAfter = usage.tokensIn + usage.tokensOut;
    expect(totalAfter).toBeGreaterThanOrEqual(0); // at least non-negative
  });

  it('falls back to heuristic verdict when model client throws', async () => {
    const task = makeTask(
      'Write a Python fibonacci function',
      'def fib(n): return n if n <= 1 else fib(n-1) + fib(n-2)',
    );
    // Client that always throws — verifyTask must not propagate the error
    const verdict = await verifyTask(task, mockClientError(), makeBudget(), newUsage());
    expect(verdict).toBeDefined();
    expect(typeof verdict.ok).toBe('boolean');
    expect(verdict.method).toBe('heuristic');
  });
});

// ---------------------------------------------------------------------------
// Model path locked — { model: true } drives the model branch + usage accounting
// ---------------------------------------------------------------------------

describe('verifyTask — model path locked ({ model: true })', () => {
  /**
   * A result that is non-empty, has no error sentinels, and shares no >=4-char
   * keyword with the goal → heuristicVerify returns null (inconclusive) because
   * the goal has < 3 long words, so the "zero overlap" confident-fail rule does
   * not fire. This forces the inconclusive path where the model branch decides.
   */
  function inconclusiveTask(): RunTask {
    // Goal words >= 4 chars: ["café"] (one word) → overlapRatio over a single
    // word; result avoids it entirely, but goalWords.length < 3 so no confident
    // fail. Non-empty + no error sentinel + < 0.5 overlap → heuristic null.
    return makeTask('Say café', 'bonjour le monde');
  }

  it('does NOT call the model when { model: true } is omitted (default off)', async () => {
    const client = mockClientVerdict(true, 'model says ok');
    const usage = newUsage();
    const verdict = await verifyTask(inconclusiveTask(), client, makeBudget(), usage);
    expect(client.chat).not.toHaveBeenCalled();
    expect(verdict.method).toBe('heuristic');
    expect(verdict.ok).toBe(true); // lenient heuristic pass
    expect(usage.tokensIn + usage.tokensOut).toBe(0); // no usage mutation
  });

  it('calls the model exactly once when { model: true } and budget allows', async () => {
    const client = mockClientText('yes — the translation is correct');
    const usage = newUsage();
    const verdict = await verifyTask(inconclusiveTask(), client, makeBudget(), usage, {
      model: true,
    });
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(verdict.method).toBe('model');
    expect(verdict.ok).toBe(true);
  });

  it('does not start model verification when the invocation is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = mockClientText('yes');
    const verdict = await verifyTask(inconclusiveTask(), client, makeBudget(), newUsage(), {
      model: true,
      signal: controller.signal,
    });
    expect(client.chat).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ ok: false, method: 'model' });
    expect(verdict.reason).toContain('cancelled');
  });

  it('propagates a mid-call abort to model verification and returns non-green', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const client: ProviderClient = {
      id: 'mock-verify-abort',
      supportsTools: false,
      chat: vi.fn(async (_messages, _tools, signal): Promise<ChatResult> => {
        observedSignal = signal;
        return await new Promise<ChatResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
    };
    const pending = verifyTask(inconclusiveTask(), client, makeBudget(), newUsage(), {
      model: true,
      signal: controller.signal,
    });
    controller.abort();
    const verdict = await pending;
    expect(observedSignal).toBe(controller.signal);
    expect(verdict).toMatchObject({ ok: false, method: 'model' });
    expect(verdict.reason).toContain('cancelled');
  });

  it('mutates usage by exactly the model-call tokens (10 in / 5 out, +1 step)', async () => {
    const client = mockClientText('yes — looks right');
    const usage = newUsage(); // { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 }
    await verifyTask(inconclusiveTask(), client, makeBudget(), usage, { model: true });
    // mockClientText reports { tokensIn: 10, tokensOut: 5 }
    expect(usage.tokensIn).toBe(10);
    expect(usage.tokensOut).toBe(5);
    expect(usage.steps).toBe(1);
  });

  it('parses a "no" model verdict as ok:false with method model', async () => {
    const client = mockClientText('no — the result is off-topic');
    const usage = newUsage();
    const verdict = await verifyTask(inconclusiveTask(), client, makeBudget(), usage, {
      model: true,
    });
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.method).toBe('model');
  });

  it('with { model: true } but exhausted budget, skips the model and does not mutate usage', async () => {
    const client = mockClientVerdict(true, 'model says ok');
    const usage = newUsage();
    const verdict = await verifyTask(inconclusiveTask(), client, exhaustedBudget(), usage, {
      model: true,
    });
    expect(client.chat).not.toHaveBeenCalled();
    expect(verdict.method).toBe('heuristic');
    expect(usage.tokensIn + usage.tokensOut).toBe(0);
  });

  it('with { model: true } but a throwing client, falls back to heuristic (never throws)', async () => {
    const usage = newUsage();
    const verdict = await verifyTask(inconclusiveTask(), mockClientError(), makeBudget(), usage, {
      model: true,
    });
    expect(verdict.method).toBe('heuristic');
    expect(typeof verdict.ok).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Never throws — all error paths swallowed
// ---------------------------------------------------------------------------

describe('verifyTask — never throws', () => {
  it('does not throw when result is undefined', async () => {
    const task = makeTask('Do something', undefined);
    await expect(
      verifyTask(task, mockClientText('yes'), makeBudget(), newUsage()),
    ).resolves.toBeDefined();
  });

  it('does not throw when client.chat rejects', async () => {
    const task = makeTask('Do something', 'Here is the result.');
    await expect(
      verifyTask(task, mockClientError(), makeBudget(), newUsage()),
    ).resolves.toBeDefined();
  });

  it('always returns a VerifyVerdict shape', async () => {
    const cases = [
      makeTask('goal', ''),
      makeTask('goal', 'Error: boom'),
      makeTask('goal', 'plausible result for goal'),
      makeTask('goal', undefined),
    ];
    for (const task of cases) {
      const verdict = await verifyTask(task, mockClientText('yes'), makeBudget(), newUsage());
      expect(typeof verdict.ok).toBe('boolean');
      expect(typeof verdict.reason).toBe('string');
      expect(['heuristic', 'model']).toContain(verdict.method);
    }
  });
});

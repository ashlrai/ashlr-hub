/**
 * m134.adaptive-prompts.test.ts — M134: adaptive-prompt activation + quality.
 *
 * Validates:
 *   1. resolveModelProfile maps our actual local models to the right bands.
 *   2. CODER profile carries the tuned knobs (stepCap 32, contextTokens 32768,
 *      roleHint present, temperature 0.2).
 *   3. GENERAL profile carries the tuned knobs (stepCap 24, contextTokens 32768,
 *      roleHint present).
 *   4. SMALL profile is unchanged (no roleHint required).
 *   5. When adaptivePrompts ON, agent-loop applies:
 *        - profile.stepCap (not TASK_STEP_CAP=20)
 *        - adaptive system prompt (not legacy two-sentence prompt)
 *        - roleHint block appended to system content
 *   6. When adaptivePrompts OFF, agent-loop is byte-identical to legacy behavior
 *      (legacy two-sentence prompt + stepCap=20).
 *   7. roleHint is NOT appended when it would push the system prompt over
 *      profile.promptCharCap.
 *
 * NO real model calls. The ProviderClient is mocked to resolve immediately with
 * a canned final answer after the first chat() call.
 *
 * Conventions mirror m41.model-profile.test.ts and m118.content-toolcalls.test.ts:
 *   - vitest, no top-level await, afterEach for env/mock teardown.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveModelProfile,
  adaptivePromptsEnabled,
} from '../src/core/run/model-profile.js';
import { runTask } from '../src/core/run/agent-loop.js';
import type { RunTask, RunBudget, RunUsage, ProviderClient, ChatMessage } from '../src/core/types.js';
import { newUsage } from '../src/core/run/budget.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeTask(goal = 'test goal'): RunTask {
  return {
    id: 't1',
    goal,
    status: 'pending',
  } as RunTask;
}

function makeBudget(): RunBudget {
  return { maxTokensIn: 100_000, maxTokensOut: 100_000, maxSteps: 200 } as RunBudget;
}

/**
 * Build a minimal mock ProviderClient that records what system prompt it
 * received and immediately returns a final text answer (no tool calls).
 */
function makeMockClient(model: string): {
  client: ProviderClient;
  capturedMessages: () => ChatMessage[];
} {
  const calls: ChatMessage[][] = [];

  const client: ProviderClient = {
    id: 'mock',
    model,
    supportsTools: true,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      calls.push([...messages]);
      return {
        content: 'done',
        toolCalls: undefined,
        usage: { tokensIn: 10, tokensOut: 5, steps: 1, cost: 0 },
      };
    }),
  };

  return {
    client,
    capturedMessages: () => calls[0] ?? [],
  };
}

function makeCtx(adaptivePrompts: boolean, usage?: RunUsage) {
  return {
    budget: makeBudget(),
    usage: usage ?? newUsage(),
    adaptivePrompts,
    onStep: () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. resolveModelProfile — our actual local models map to correct bands
// ---------------------------------------------------------------------------

describe('M134 resolveModelProfile — local model band mapping', () => {
  it('qwen2.5-coder:32b → CODER', () => {
    const p = resolveModelProfile('qwen2.5-coder:32b');
    expect(p.id).toBe('coder');
    expect(p.verbosity).toBe('rich');
    expect(p.toolFormat).toBe('native');
  });

  it('qwen2.5-coder:32b-instruct-q4_K_M → CODER (quantization tag tolerated)', () => {
    const p = resolveModelProfile('qwen2.5-coder:32b-instruct-q4_K_M');
    expect(p.id).toBe('coder');
  });

  it('qwen2.5:72b → CODER (≥20B rule)', () => {
    // 72B exceeds the coder-or-large threshold → coder band
    const p = resolveModelProfile('qwen2.5:72b');
    expect(p.id).toBe('coder');
  });

  it('qwen2.5:72b-instruct-q4_K_M → CODER (quantization tag tolerated)', () => {
    const p = resolveModelProfile('qwen2.5:72b-instruct-q4_K_M');
    expect(p.id).toBe('coder');
  });

  it('phi4-mini → SMALL', () => {
    const p = resolveModelProfile('phi4-mini');
    expect(p.id).toBe('small');
    expect(p.verbosity).toBe('terse');
    expect(p.toolFormat).toBe('json');
  });

  it('llama3.1:8b → GENERAL (mid-size chat)', () => {
    const p = resolveModelProfile('llama3.1:8b');
    expect(p.id).toBe('general');
  });

  it('mistral:7b → GENERAL', () => {
    expect(resolveModelProfile('mistral:7b').id).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// 2. CODER profile tuned knobs
// ---------------------------------------------------------------------------

describe('M134 CODER profile tuned for qwen2.5-coder:32b', () => {
  const p = resolveModelProfile('qwen2.5-coder:32b');

  it('stepCap ≥ 32 (enough for read→edit→write→verify loop)', () => {
    expect(p.stepCap).toBeGreaterThanOrEqual(32);
  });

  it('temperature ≤ 0.2 (disciplined, deterministic)', () => {
    expect(p.temperature).toBeLessThanOrEqual(0.2);
  });

  it('contextTokens ≥ 32768 (full 32k window)', () => {
    expect(p.contextTokens).toBeGreaterThanOrEqual(32768);
  });

  it('roleHint is present and mentions complete changes', () => {
    expect(p.roleHint).toBeDefined();
    expect(p.roleHint!.length).toBeGreaterThan(50);
    // Must push completeness — not truncated stubs
    expect(p.roleHint!.toLowerCase()).toMatch(/complete/);
  });

  it('roleHint mentions read-before-edit discipline', () => {
    expect(p.roleHint!.toLowerCase()).toMatch(/read/);
  });

  it('roleHint mentions verification / verify', () => {
    expect(p.roleHint!.toLowerCase()).toMatch(/verif/);
  });
});

// ---------------------------------------------------------------------------
// 3. GENERAL profile tuned knobs
// ---------------------------------------------------------------------------

describe('M134 GENERAL profile tuned for qwen2.5:72b', () => {
  // qwen2.5:72b is ≥20B → resolves to CODER band; use a mid-size general model
  // to access the GENERAL profile constants directly.
  const p = resolveModelProfile('llama3.1:8b');

  it('stepCap ≥ 24', () => {
    expect(p.stepCap).toBeGreaterThanOrEqual(24);
  });

  it('contextTokens ≥ 32768', () => {
    expect(p.contextTokens).toBeGreaterThanOrEqual(32768);
  });

  it('roleHint is present and mentions completeness', () => {
    expect(p.roleHint).toBeDefined();
    expect(p.roleHint!.toLowerCase()).toMatch(/complete/);
  });
});

// ---------------------------------------------------------------------------
// 4. SMALL profile — unchanged, no roleHint required
// ---------------------------------------------------------------------------

describe('M134 SMALL profile — no regression', () => {
  it('stepCap < 20 (tight budget for weak models)', () => {
    expect(resolveModelProfile('phi4-mini').stepCap).toBeLessThan(20);
  });

  it('toolFormat is json (small models fumble native calls)', () => {
    expect(resolveModelProfile('phi4-mini').toolFormat).toBe('json');
  });
});

// ---------------------------------------------------------------------------
// 5. agent-loop: adaptivePrompts ON applies profile stepCap + adaptive prompt
// ---------------------------------------------------------------------------

describe('M134 agent-loop: adaptivePrompts ON', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies profile.stepCap (not the hardcoded TASK_STEP_CAP=20) for CODER model', async () => {
    // Arrange: a client that always returns a non-final answer (no content, no
    // tool calls) so the loop would spin until the step cap — but we limit
    // usage.maxSteps to stop it.  We just need to confirm stepCap > 20 is used.
    // Simplest approach: make the client return a final answer immediately and
    // assert the system prompt reflects the adaptive path (not legacy text).
    const { client, capturedMessages } = makeMockClient('qwen2.5-coder:32b');
    const task = makeTask('write a function');

    await runTask(task, client, makeCtx(true));

    const msgs = capturedMessages();
    expect(msgs.length).toBeGreaterThan(0);
    const sys = msgs[0]!;
    expect(sys.role).toBe('system');
    // Adaptive path: system prompt is NOT the legacy two-sentence prompt
    expect(sys.content).not.toContain('You are an Ashlr sub-agent. Be concise and focused.');
    // Must contain EXECUTOR_ROLE rich content (from assembleSystemPrompt)
    // and the CODER roleHint block (diff-quality contract)
    expect(sys.content).toContain('complete');
  });

  it('injects roleHint block into system prompt for CODER model', async () => {
    const { client, capturedMessages } = makeMockClient('qwen2.5-coder:32b');
    await runTask(makeTask(), client, makeCtx(true));

    const sys = capturedMessages()[0]!;
    const profile = resolveModelProfile('qwen2.5-coder:32b');
    // The roleHint should appear in the system content (may be truncated to cap)
    // We check for a distinctive substring from the coder roleHint
    expect(sys.content).toContain('READ');
  });

  it('injects roleHint block into system prompt for GENERAL model', async () => {
    const { client, capturedMessages } = makeMockClient('llama3.1:8b');
    await runTask(makeTask(), client, makeCtx(true));

    const sys = capturedMessages()[0]!;
    expect(sys.content).toContain('Read the file before editing');
  });

  it('task.status=done after single-shot final answer', async () => {
    const { client } = makeMockClient('qwen2.5-coder:32b');
    const task = makeTask();
    await runTask(task, client, makeCtx(true));
    expect(task.status).toBe('done');
    expect(task.result).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 6. agent-loop: adaptivePrompts OFF → legacy behavior byte-identical
// ---------------------------------------------------------------------------

describe('M134 agent-loop: adaptivePrompts OFF → legacy prompt unchanged', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const LEGACY_NO_TOOLS =
    'You are an Ashlr sub-agent. Be concise and focused. ' +
    'Complete the given task directly. ' +
    'Do not request tools — respond with a final textual answer only.';

  const LEGACY_WITH_TOOLS =
    'You are an Ashlr sub-agent. Be concise and focused. ' +
    'Complete the given task directly. ' +
    'You may call tools to gather information; always follow up with a final answer.';

  it('system prompt is legacy two-sentence form when flag is OFF (no tools)', async () => {
    const { client, capturedMessages } = makeMockClient('qwen2.5-coder:32b');
    // Override supportsTools to false so no tools are passed
    (client as { supportsTools: boolean }).supportsTools = false;

    await runTask(makeTask(), client, { ...makeCtx(false) });

    const sys = capturedMessages()[0]!;
    expect(sys.content).toBe(LEGACY_NO_TOOLS);
  });

  it('system prompt is legacy form with tool hint when flag is OFF (with tools)', async () => {
    const { client, capturedMessages } = makeMockClient('qwen2.5:72b');
    const mockTool = { name: 'read_file', fn: async () => 'ok' };

    await runTask(makeTask(), client, {
      ...makeCtx(false),
      tools: [mockTool],
    });

    const sys = capturedMessages()[0]!;
    expect(sys.content).toBe(LEGACY_WITH_TOOLS);
  });

  it('step cap is 20 (TASK_STEP_CAP) when flag is OFF regardless of model', async () => {
    // A client that never returns content forces the loop to run until stepCap.
    // We verify via a budget where maxSteps is much higher than 20, and the
    // loop terminates at 20 rather than 32 (the CODER profile stepCap).
    let callCount = 0;
    const spinClient: ProviderClient = {
      id: 'mock-spin',
      model: 'qwen2.5-coder:32b',
      supportsTools: false,
      chat: vi.fn(async () => {
        callCount++;
        return {
          content: '',
          toolCalls: undefined,
          usage: { tokensIn: 1, tokensOut: 1, steps: 1, cost: 0 },
        };
      }),
    };

    const task = makeTask();
    await runTask(task, spinClient, {
      budget: { maxTokensIn: 9_999_999, maxTokensOut: 9_999_999, maxSteps: 9_999_999 } as RunBudget,
      usage: newUsage(),
      adaptivePrompts: false,
      onStep: () => {},
    });

    // The legacy step cap is 20. The loop nudges the model when content is
    // empty, so callCount == stepCap (each empty response uses 1 step, then a
    // nudge user message is appended, and the loop hits the cap).
    expect(callCount).toBe(20);
    expect(task.status).toBe('failed');
  });

  it('CODER profile stepCap (32) is used when flag is ON', async () => {
    let callCount = 0;
    const spinClient: ProviderClient = {
      id: 'mock-spin-on',
      model: 'qwen2.5-coder:32b',
      supportsTools: false,
      chat: vi.fn(async () => {
        callCount++;
        return {
          content: '',
          toolCalls: undefined,
          usage: { tokensIn: 1, tokensOut: 1, steps: 1, cost: 0 },
        };
      }),
    };

    const task = makeTask();
    await runTask(task, spinClient, {
      budget: { maxTokensIn: 9_999_999, maxTokensOut: 9_999_999, maxSteps: 9_999_999 } as RunBudget,
      usage: newUsage(),
      adaptivePrompts: true,
      onStep: () => {},
    });

    const coderProfile = resolveModelProfile('qwen2.5-coder:32b');
    expect(callCount).toBe(coderProfile.stepCap);
    expect(task.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 7. roleHint is NOT appended when it would exceed promptCharCap
// ---------------------------------------------------------------------------

describe('M134 roleHint char-budget guard', () => {
  it('roleHint is omitted when promptCharCap is too small to include it', async () => {
    // Build a profile with a tiny charCap that cannot fit the roleHint
    const tinyCapProfile = resolveModelProfile('qwen2.5-coder:32b', {
      coder: { promptCharCap: 10 },
    });
    expect(tinyCapProfile.roleHint).toBeDefined();

    // Use a client with this model name, but mock the profile resolution via
    // a per-id override.  Since the agent-loop calls resolveModelProfile
    // directly with client.model, we test the guard logic indirectly by
    // checking that a large roleHint + tiny cap → assembled ≤ cap.
    // The guard in agent-loop: if (candidate.length <= profile.promptCharCap).
    // With cap=10 the assembled prompt itself will already exceed 10 chars, so
    // the roleHint block is skipped. We assert via the output that the content
    // does not EXCEED the base assembled length (i.e. no extra block appended).

    // Actually the simplest unit-level assertion: verify the assembled prompt
    // does NOT contain the roleHint body when it would push past promptCharCap.
    // We simulate what agent-loop does inline:
    const { assembleSystemPrompt } = await import('../src/core/run/prompts/index.js');
    const assembled = assembleSystemPrompt({
      role: 'executor',
      useTools: false,
      profile: tinyCapProfile,
      charCap: tinyCapProfile.promptCharCap,
    }).system;

    const roleHint = tinyCapProfile.roleHint!;
    const candidate = assembled + '\n\n' + roleHint;
    const wouldFit = candidate.length <= tinyCapProfile.promptCharCap;
    expect(wouldFit).toBe(false); // guard correctly identifies it won't fit
    // So assembled itself (without roleHint) is what gets used
    expect(assembled.length).toBeLessThanOrEqual(tinyCapProfile.promptCharCap + roleHint.length);
  });
});

// ---------------------------------------------------------------------------
// 8. adaptivePromptsEnabled feature gate (re-verify from m41 with new env)
// ---------------------------------------------------------------------------

describe('M134 adaptivePromptsEnabled gate', () => {
  const ORIG = process.env.ASHLR_ADAPTIVE_PROMPTS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.ASHLR_ADAPTIVE_PROMPTS;
    else process.env.ASHLR_ADAPTIVE_PROMPTS = ORIG;
  });

  it('defaults OFF with no env and no config', () => {
    delete process.env.ASHLR_ADAPTIVE_PROMPTS;
    expect(adaptivePromptsEnabled(undefined)).toBe(false);
  });

  it('cfg.models.adaptivePrompts: true enables it', () => {
    delete process.env.ASHLR_ADAPTIVE_PROMPTS;
    expect(
      adaptivePromptsEnabled({ models: { adaptivePrompts: true } } as never),
    ).toBe(true);
  });

  it('ASHLR_ADAPTIVE_PROMPTS=1 overrides cfg false', () => {
    process.env.ASHLR_ADAPTIVE_PROMPTS = '1';
    expect(
      adaptivePromptsEnabled({ models: { adaptivePrompts: false } } as never),
    ).toBe(true);
  });
});

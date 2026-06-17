/**
 * M41 prompt-suite tests — pure assembly + runTask wiring (mock client, no net).
 *
 * Covers layer composition, the no-tool contract, the small-model JSON hint,
 * the per-profile char-cap guarantee (memory truncated/dropped first, never the
 * discipline layers), planner/synthesizer verbatim contracts, and that runTask
 * uses the legacy prompt by default and the adaptive prompt when the flag is on.
 */

import { describe, it, expect, vi } from 'vitest';
import { assembleSystemPrompt, systemPromptFor } from '../src/core/run/prompts/index.js';
import { PLANNER_ROLE, SYNTHESIZER_ROLE } from '../src/core/run/prompts/roles.js';
import { resolveModelProfile } from '../src/core/run/model-profile.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { newUsage } from '../src/core/run/budget.js';
import type {
  ProviderClient,
  ChatMessage,
  ChatResult,
  RunTask,
  RunBudget,
} from '../src/core/types.js';

const small = resolveModelProfile('tinyllama');
const general = resolveModelProfile('llama3.1:8b');
const coder = resolveModelProfile('qwen2.5-coder:7b');

describe('M41 assembleSystemPrompt — executor', () => {
  it('layers base/tool/output/role when tools are available', () => {
    const r = assembleSystemPrompt({ role: 'executor', useTools: true, profile: general });
    expect(r.included).toEqual(['base', 'tool', 'output', 'role']);
    expect(r.system).toMatch(/Ashlr engineering sub-agent/);
    expect(r.chars).toBe(r.system.length);
  });

  it('uses the no-tool contract when tools are unavailable', () => {
    const r = assembleSystemPrompt({ role: 'executor', useTools: false, profile: general });
    expect(r.system).toMatch(/No tools are available/i);
    expect(r.system).not.toMatch(/Read before you edit/i);
  });

  it('appends the JSON tool hint only for json-format (small) profiles', () => {
    const s = assembleSystemPrompt({ role: 'executor', useTools: true, profile: small });
    expect(s.system).toMatch(/JSON object/);
    const g = assembleSystemPrompt({ role: 'executor', useTools: true, profile: general });
    expect(g.system).not.toMatch(/JSON object/);
  });

  it('stays within the profile char cap for every profile, even with huge memory', () => {
    const mem = 'X'.repeat(10_000);
    for (const p of [small, general, coder]) {
      const r = assembleSystemPrompt({ role: 'executor', useTools: true, profile: p, memory: mem });
      expect(r.chars, p.id).toBeLessThanOrEqual(p.promptCharCap);
    }
  });

  it('truncates/drops memory first — never the discipline layers', () => {
    const mem = 'MEMORYBLOCK '.repeat(2000);
    const r = assembleSystemPrompt({ role: 'executor', useTools: true, profile: small, memory: mem });
    expect(r.system).toMatch(/Ashlr engineering sub-agent/); // base survives
    expect(r.included).toContain('base');
    expect(r.included).toContain('role');
    expect(r.chars).toBeLessThanOrEqual(small.promptCharCap);
  });

  it('includes memory when it fits', () => {
    const r = assembleSystemPrompt({
      role: 'executor',
      useTools: true,
      profile: coder,
      memory: 'Relevant project memory: prefer fp-ts.',
    });
    expect(r.included).toContain('memory');
    expect(r.system).toMatch(/prefer fp-ts/);
  });
});

describe('M41 assembleSystemPrompt — planner/synthesizer contracts', () => {
  it('planner with no memory is the verbatim PLANNER_ROLE', () => {
    expect(systemPromptFor({ role: 'planner', useTools: false, profile: general })).toBe(PLANNER_ROLE);
  });

  it('synthesizer is the verbatim SYNTHESIZER_ROLE', () => {
    expect(systemPromptFor({ role: 'synthesizer', useTools: false, profile: general })).toBe(
      SYNTHESIZER_ROLE,
    );
  });

  it('planner places memory first and ends with the role contract', () => {
    const s = systemPromptFor({ role: 'planner', useTools: false, profile: general, memory: 'MEM' });
    expect(s.startsWith('MEM')).toBe(true);
    expect(s.endsWith('no prose, no markdown fences.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runTask wiring
// ---------------------------------------------------------------------------

function makeTask(): RunTask {
  return { id: 't1', goal: 'do the thing', deps: [], status: 'pending' };
}
function budget(): RunBudget {
  return { maxTokens: 1000, maxSteps: 20, allowCloud: false };
}
function capturingClient(model?: string): { client: ProviderClient; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  const client: ProviderClient = {
    id: 'mock',
    model,
    supportsTools: true,
    chat: vi.fn(async (messages: ChatMessage[]): Promise<ChatResult> => {
      seen.push(messages);
      return { content: 'done', usage: { tokensIn: 1, tokensOut: 1 } };
    }),
  };
  return { client, seen };
}

describe('M41 runTask prompt wiring', () => {
  it('uses the legacy prompt by default (flag off)', async () => {
    const { client, seen } = capturingClient('qwen2.5-coder:7b');
    await runTask(makeTask(), client, { budget: budget(), usage: newUsage(), onStep: () => {} });
    expect(seen[0][0].content).toMatch(/^You are an Ashlr sub-agent\./);
  });

  it('uses the adaptive prompt when adaptivePrompts is true', async () => {
    const { client, seen } = capturingClient('qwen2.5-coder:7b');
    await runTask(makeTask(), client, {
      tools: [{ name: 'noop', fn: async () => 'ok' }],
      budget: budget(),
      usage: newUsage(),
      onStep: () => {},
      adaptivePrompts: true,
    });
    expect(seen[0][0].content).toMatch(/Ashlr engineering sub-agent/);
    expect(seen[0][0].content).toMatch(/Tool-use discipline/); // rich coder variant
  });
});

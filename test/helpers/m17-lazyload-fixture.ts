/**
 * test/helpers/m17-lazyload-fixture.ts
 *
 * Shared (non-mock) fixtures for the M17/M21 lazy-load fail-closed test
 * suite (test/m17.lazy-load-*.test.ts). Deliberately contains NO vi.mock()
 * calls — those must live in each consuming test file so Vitest can hoist
 * them per-file; this module only holds plain helper functions/data.
 */

import type { AshlrConfig, SwarmPlan, RunState, RunUsage } from '../../src/core/types.js';
import type { StreamSink } from '../../src/core/run/streaming.js';

export const nullSink: StreamSink = () => {};

export function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

export function makeRunState(goal: string, result = `Result for: ${goal}`): RunState {
  return {
    id: `mock-run-${Math.random().toString(36).slice(2)}`,
    goal,
    status: 'done' as const,
    result,
    usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 } as RunUsage,
    tasks: [],
    steps: [],
    engine: 'builtin',
    provider: 'ollama',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
  } as RunState;
}

/** No tasks at all — enough to exercise the run-start seams (rollback snapshot, audit). */
export function emptyPlan(goal: string): SwarmPlan {
  return { specId: null, goal, tasks: [] };
}

/** One build-phase task — enough to exercise per-task signing. */
export function onePlan(goal: string): SwarmPlan {
  return {
    specId: null,
    goal,
    tasks: [{ id: 'build-1', phase: 'build', goal: 'Build module', deps: [] }],
  };
}

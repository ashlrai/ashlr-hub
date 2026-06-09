/**
 * M15 pulse --json backward-compat tests — hermetic, mocked rollup/forecast/config.
 *
 * Locks the regression fixed in M15: `ashlr pulse --json` must emit the
 * ActivityRollup at the TOP LEVEL (as shipped through M14), with `forecast`
 * attached as a purely ADDITIVE field. The M13 Raycast Pulse extension
 * (src/raycast/src/pulse.tsx) parses the output as ActivityRollup and
 * destructures { totals, byProject, byModel, budget } from the top level — so a
 * nested { rollup, forecast } envelope would silently break that consumer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActivityRollup, AshlrConfig, CostForecast } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_ROLLUP: ActivityRollup = {
  window: '7d',
  since: '2026-06-01T00:00:00.000Z',
  totals: { tokensIn: 1000, tokensOut: 500, estCostUsd: 0, sessions: 2, commits: 3 },
  byProject: [
    { project: '/tmp/proj', tokensIn: 1000, tokensOut: 500, estCostUsd: 0, sessions: 2, commits: 3, lastActive: '2026-06-07T00:00:00.000Z' },
  ],
  byModel: [
    { model: 'ollama', tokensIn: 1000, tokensOut: 500, estCostUsd: 0, calls: 5 },
  ],
  byDay: [],
  budget: {
    level: 'ok',
    window: '7d',
    message: 'within budget',
    spentUsd: 0,
    capUsd: null,
    spentTokens: 1500,
    capTokens: null,
  },
};

const FIXTURE_FORECAST: CostForecast = {
  window: '7d',
  spentUsd: 0,
  localSavingsUsd: 1.23,
  projectedMonthlyUsd: 0,
};

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  };
}

// ---------------------------------------------------------------------------
// Module mocks (hoisted before the import under test)
// ---------------------------------------------------------------------------

vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: vi.fn(() => FIXTURE_ROLLUP),
}));

vi.mock('../src/core/observability/forecast.js', () => ({
  buildForecast: vi.fn(() => FIXTURE_FORECAST),
}));

vi.mock('../src/core/config.js', () => ({
  loadConfig: vi.fn(() => makeConfig()),
}));

import { cmdPulse } from '../src/cli/pulse.js';

// ---------------------------------------------------------------------------
// stdout capture helper
// ---------------------------------------------------------------------------

function captureStdout(): { restore: () => void; text: () => string } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = orig;
    },
    text: () => chunks.join(''),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cmdPulse --json — backward-compatible top-level shape', () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    cap = captureStdout();
  });
  afterEach(() => {
    cap.restore();
  });

  it('emits the ActivityRollup at the TOP LEVEL (Raycast consumer reads .totals/.byModel/.budget)', async () => {
    const code = await cmdPulse(['--json']);
    expect(code).toBe(0);

    const parsed = JSON.parse(cap.text());
    // Raycast destructures these from the top level — they must NOT be nested.
    expect(parsed.totals).toBeDefined();
    expect(parsed.byProject).toBeDefined();
    expect(parsed.byModel).toBeDefined();
    expect(parsed.budget).toBeDefined();
    expect(parsed.window).toBe('7d');
    expect(parsed.totals.tokensIn).toBe(1000);
    // Must NOT be wrapped in a { rollup } envelope.
    expect(parsed.rollup).toBeUndefined();
  });

  it('attaches forecast as a purely ADDITIVE top-level field', async () => {
    await cmdPulse(['--json']);
    const parsed = JSON.parse(cap.text());
    expect(parsed.forecast).toBeDefined();
    expect(parsed.forecast.localSavingsUsd).toBeCloseTo(1.23, 4);
  });
});

/**
 * test/m17.lazy-load-baseline.test.ts
 *
 * BASELINE for the M17/M21 lazy-load fail-closed suite (see the sibling
 * test/m17.lazy-load-{gate,sign,rollback,audit}-fail-closed.test.ts files,
 * one per lazily-loaded module, split into separate files because repeated
 * vi.doMock()/vi.resetModules() cycles for different specifiers within one
 * file leak Vitest's mock-factory error cache across tests).
 *
 * Confirms sign.js, gate.js, rollback.js, and sandbox/audit.js all load for
 * real (unmocked) — i.e. they genuinely exist in this repo, contrary to the
 * stale "not built yet" comments that used to sit over their imports in
 * src/core/swarm/runner.ts — and that the new structured-logging added
 * alongside the fail-closed/loud-degrade fix is silent on the happy path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeConfig, nullSink, onePlan } from './helpers/m17-lazyload-fixture.js';

const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: mockRunGoal,
  saveRun: vi.fn(),
  loadRun: vi.fn().mockReturnValue(null),
  listRuns: vi.fn().mockReturnValue([]),
  planGoal: vi.fn(),
}));

const mockPlanSwarm = vi.fn();
vi.mock('../src/core/swarm/planner.js', () => ({
  planSwarm: mockPlanSwarm,
}));

const origHome = process.env['HOME'];
const origAshlrInSwarm = process.env['ASHLR_IN_SWARM'];
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m17-lazyload-baseline-'));
  process.env['HOME'] = tmpHome;
  delete process.env['ASHLR_IN_SWARM'];
  vi.clearAllMocks();
  mockRunGoal.mockImplementation(async (goal: string) => ({
    id: `mock-run-${Math.random().toString(36).slice(2)}`,
    goal,
    status: 'done' as const,
    result: `Result for: ${goal}`,
    usage: { tokensIn: 10, tokensOut: 5, steps: 1, estCostUsd: 0 },
    tasks: [],
    steps: [],
    engine: 'builtin',
    provider: 'ollama',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 50_000, maxSteps: 100, allowCloud: false },
  }));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env['HOME'] = origHome;
  if (origAshlrInSwarm === undefined) {
    delete process.env['ASHLR_IN_SWARM'];
  } else {
    process.env['ASHLR_IN_SWARM'] = origAshlrInSwarm;
  }
  vi.restoreAllMocks();
});

describe('M17/M21 lazy-load — baseline (all four modules load for real)', () => {
  it('all four modules load unmocked, run completes "done", no [M17]/[M21] warnings logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/core/swarm/runner.js');
    mockPlanSwarm.mockResolvedValueOnce(onePlan('baseline goal'));
    const run = await mod.runSwarm(
      { goal: 'baseline goal' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1, noCapture: true },
      nullSink,
    );
    expect(run.status).toBe('done');
    const allMsgs = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0]));
    expect(allMsgs.some((m) => m.includes('[M17]') || m.includes('[M21]'))).toBe(false);
  });
});

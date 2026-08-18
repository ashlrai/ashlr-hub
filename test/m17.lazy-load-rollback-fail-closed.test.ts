/**
 * test/m17.lazy-load-rollback-fail-closed.test.ts
 *
 * rollback.js is one of the three forensic/recovery-aid lazy deps (see
 * m17.lazy-load-sign-fail-closed.test.ts's header for the full rationale;
 * gate.js is the one PREVENTIVE control and hard-refuses instead). Snapshot
 * creation is already best-effort at its call site ("snapshot failure never
 * blocks the swarm"), so a load failure degrades the same way — but must no
 * longer be a silent catch: this proves a loud, structured [M17] warning is
 * logged and that run.rollback is never populated once rollback.js has
 * failed to load.
 *
 * Isolated into its own file — see m17.lazy-load-gate-fail-closed.test.ts's
 * header for why (Vitest mock-factory error cache leaking across repeated
 * doMock/resetModules cycles for different specifiers in one file).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeConfig, makeRunState, nullSink, onePlan } from './helpers/m17-lazyload-fixture.js';

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

vi.mock('../src/core/swarm/rollback.js', () => {
  throw new Error('simulated: rollback module unavailable (bad build / import cycle / partial dist)');
});

const origHome = process.env['HOME'];
const origAshlrInSwarm = process.env['ASHLR_IN_SWARM'];
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m17-lazyload-rollback-'));
  process.env['HOME'] = tmpHome;
  delete process.env['ASHLR_IN_SWARM'];
  vi.clearAllMocks();
  mockRunGoal.mockImplementation(async (goal: string) => makeRunState(goal));
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

describe('M17 lazy-load — rollback.js throws on import', () => {
  it('run still completes ("done"), but a loud [M17] warning is logged and no rollback snapshot is ever recorded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/core/swarm/runner.js');
    mockPlanSwarm.mockResolvedValueOnce(onePlan('rollback unavailable'));
    const run = await mod.runSwarm(
      { goal: 'rollback unavailable' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1, noCapture: true },
      nullSink,
    );
    expect(run.status).toBe('done');
    expect(run.rollback).toBeUndefined();
    const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('[M17]') && m.includes('rollback.js'))).toBe(true);
  });
});

/**
 * test/m17.lazy-load-sign-fail-closed.test.ts
 *
 * sign.js is one of the three forensic/recovery-aid lazy deps (the other two
 * are rollback.js and sandbox/audit.js — see their sibling *-fail-closed
 * test files; gate.js is the one PREVENTIVE control and gets a hard refusal
 * instead, see m17.lazy-load-gate-fail-closed.test.ts). Every call site that
 * uses signing already treats it as best-effort ("absent signature means
 * downstream verification skips this dep"), so a load failure degrades the
 * same way — but it must no longer be a silent catch: this proves a loud,
 * structured [M17][SECURITY] error is logged and that no task ever receives
 * a signature once sign.js has failed to load.
 *
 * Isolated into its own file — see the gate.js test file's header comment
 * for why (Vitest mock-factory error cache leaking across repeated
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

vi.mock('../src/core/swarm/sign.js', () => {
  throw new Error('simulated: sign module unavailable (bad build / import cycle / partial dist)');
});

const origHome = process.env['HOME'];
const origAshlrInSwarm = process.env['ASHLR_IN_SWARM'];
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m17-lazyload-sign-'));
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

describe('M17 lazy-load — sign.js throws on import', () => {
  it('run still completes ("done"), but a loud [M17][SECURITY] warning is logged and no task is ever signed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../src/core/swarm/runner.js');
    mockPlanSwarm.mockResolvedValueOnce(onePlan('sign unavailable'));
    const run = await mod.runSwarm(
      { goal: 'sign unavailable' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1, noCapture: true },
      nullSink,
    );
    expect(run.status).toBe('done');
    expect(run.tasks.length).toBeGreaterThan(0);
    for (const t of run.tasks) {
      expect(t.signature).toBeUndefined();
    }
    const msgs = errSpy.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('[M17][SECURITY]') && m.includes('sign.js'))).toBe(true);
  });
});

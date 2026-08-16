/**
 * test/m17.lazy-load-gate-fail-closed.test.ts
 *
 * gate.js is the ONE of the four M17/M21 lazy deps (sign/gate/rollback/
 * audit) that is a real-time PREVENTIVE control — it's what stops risky
 * autonomous task output from proceeding unchecked. sign/rollback/audit are
 * forensic or recovery aids instead (see the sibling *-fail-closed test
 * files), so a gate.js load failure gets the strictest treatment: runSwarm
 * refuses to run at all — matching the requireSandbox convention already in
 * src/core/swarm/runner.ts — rather than execute with zero risk assessment.
 *
 * Isolated into its own file (rather than one shared file with several
 * it()s) because repeated vi.doMock()/vi.resetModules() cycles for
 * different specifiers within a single test file leak Vitest's mock-
 * factory error cache across tests; one throw-mock per file (as
 * test/h4.sandbox-enrollment-kill.test.ts already does for worktree.js)
 * is the reliable pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeConfig, nullSink } from './helpers/m17-lazyload-fixture.js';

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

vi.mock('../src/core/swarm/gate.js', () => {
  throw new Error('simulated: gate module unavailable (bad build / import cycle / partial dist)');
});

const origHome = process.env['HOME'];
const origAshlrInSwarm = process.env['ASHLR_IN_SWARM'];
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m17-lazyload-gate-'));
  process.env['HOME'] = tmpHome;
  delete process.env['ASHLR_IN_SWARM'];
  vi.clearAllMocks();
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

describe('M17 lazy-load — gate.js throws on import', () => {
  it('runSwarm FAILS CLOSED: status "failed", ZERO tasks, planner/engine never invoked, loud [M17][SECURITY] error logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../src/core/swarm/runner.js');
    const run = await mod.runSwarm(
      { goal: 'gate unavailable — must refuse' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1, noCapture: true },
      nullSink,
    );
    expect(run.status).toBe('failed');
    expect(run.tasks).toEqual([]);
    expect(run.plan.tasks).toEqual([]);
    expect(run.result ?? '').toMatch(/risk-scan\/escalation gate/i);
    expect(run.result ?? '').toMatch(/working tree was NOT touched/i);
    // The swarm refused BEFORE planning or running any task.
    expect(mockPlanSwarm).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    const msgs = errSpy.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('[M17][SECURITY]') && m.includes('gate.js'))).toBe(true);
  });
});

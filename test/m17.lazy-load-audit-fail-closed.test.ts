/**
 * test/m17.lazy-load-audit-fail-closed.test.ts
 *
 * sandbox/audit.js is one of the three forensic/recovery-aid lazy deps (see
 * m17.lazy-load-sign-fail-closed.test.ts's header for the full rationale;
 * gate.js is the one PREVENTIVE control and hard-refuses instead). Every
 * call site already treats `_audit?.()` as optional + best-effort ("audit
 * is best-effort"), so a load failure degrades the same way — but must no
 * longer be a silent catch: this proves a loud, structured [M21] warning is
 * logged when sandbox/audit.js fails to load via loadM21()'s dynamic
 * import, without runSwarm ever throwing.
 *
 * NOTE: src/core/sandbox/policy.ts also imports audit.js STATICALLY
 * (`import { audit } from './audit.js'`), and runner.ts statically imports
 * `assertMayMutate`/`killSwitchOn` from policy.ts. Mocking audit.js to
 * throw therefore also breaks policy.ts's static import chain — a much
 * broader failure than the one this test targets (the lazy DYNAMIC import
 * inside loadM21). So policy.js is given a minimal working stub here,
 * isolating the throw to loadM21's dynamic `await import('../sandbox/
 * audit.js')` call specifically. (Worth flagging: this also means that in
 * production, a genuinely broken audit.js would already break the whole
 * runner.ts module graph via policy.ts's static dependency, before
 * loadM21's own catch could ever run — the catch here is defense-in-depth
 * for hypothetical partial-dist skew, not the primary real-world path.)
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

// Minimal working stub — see file header. Keeps runner.ts's STATIC
// dependency on policy.js from also going through the throwing audit.js
// mock below (policy.ts imports audit.js statically).
vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: () => {},
  killSwitchOn: () => false,
}));

vi.mock('../src/core/sandbox/audit.js', () => {
  throw new Error('simulated: audit module unavailable (bad build / import cycle / partial dist)');
});

const origHome = process.env['HOME'];
const origAshlrInSwarm = process.env['ASHLR_IN_SWARM'];
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m17-lazyload-audit-'));
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

describe('M21 lazy-load — sandbox/audit.js throws on import', () => {
  it('run still completes ("done") without throwing, but a loud [M21] warning is logged', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/core/swarm/runner.js');
    mockPlanSwarm.mockResolvedValueOnce(onePlan('audit unavailable'));
    const run = await mod.runSwarm(
      { goal: 'audit unavailable' },
      makeConfig(),
      { budget: { maxTokens: 1_000_000, maxSteps: 1000 }, parallel: 1, noCapture: true },
      nullSink,
    );
    expect(run.status).toBe('done');
    const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('[M21]') && m.includes('audit.js'))).toBe(true);
  });
});

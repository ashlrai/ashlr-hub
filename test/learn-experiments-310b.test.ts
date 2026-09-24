/**
 * V3.10 Track B unit U9 — harness experiments.
 *
 * Key tests (SPEC-310B §7 U9): confidence-interval math at n = 8, a refuse
 * regression blocks adoption, code diffs refused (see also
 * learn-harness-310b.test.ts for the registry side and the canary).
 *
 * Everything runs against a FAKE executor — no agent, no model, no network —
 * except the argv test, which pins what the real runner would pass. The
 * authority ledger is mocked so each append is observable and a broken ledger
 * can be simulated; HOME is isolated by test/setup/home.ts and the harness
 * store is wiped before every test.
 */
import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ rows: [] as { kind: string; data: unknown; actor: string }[], fail: false }));
vi.mock('../src/core/authority/ledger.js', () => ({
  appendLedger: (input: { kind: string; data: unknown; actor: string }) => {
    if (ledger.fail) return { ok: false, reason: 'test: ledger broken' };
    ledger.rows.push({ kind: input.kind, data: structuredClone(input.data), actor: input.actor });
    return { ok: true, entry: { ...input, seq: ledger.rows.length - 1 } };
  },
  readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
  currentLedgerHead: () => null,
}));
vi.mock('../src/core/authority/effective-config.js', () => ({ currentStandingPolicy: () => null }));

import { pairedDifferenceConfidence95, wilsonInterval95 } from '../src/core/fleet/external-skill-shadow-eval.js';
import {
  EXPERIMENT_SLOTS,
  LOCAL_EVAL_EXERCISABLE,
  cancelExperiment,
  runExperiment,
  runNextExperiment,
  startExperiment,
  unexercisableReason,
  type ExperimentExecutor,
  type ExperimentRunRequest,
  type ExperimentRunResult,
} from '../src/core/learn/experiments.js';
import {
  BASELINE_HARNESS_CONFIG,
  BASELINE_VERSION_ID,
  adoptHarness,
  applyHarnessPatch,
  decideExperimentVerdict,
  harnessConfigDigest,
  harnessDir,
  loadHarnessState,
  mutateHarnessState,
} from '../src/core/learn/harness-registry.js';
import { HARNESS_ADOPTION_GATE, type HarnessHypothesis } from '../src/core/learn/harness-types.js';
import { HELD_OUT_TASKS } from '../src/core/local-eval/tasks-heldout.js';
import { buildAgentArgs } from '../src/core/local-eval/runner.js';
import { renderExperimentResult } from '../src/core/local-eval/report.js';
import { parseArgs, selectTasks } from '../src/core/local-eval/main.js';
import type { FailureMode } from '../src/core/local-eval/types.js';

beforeEach(() => {
  rmSync(harnessDir(), { recursive: true, force: true });
  ledger.rows.length = 0;
  ledger.fail = false;
});

function hyp(id = 'hyp-1', producer = 'Before you report success, run the project checks and read their output.'): HarnessHypothesis {
  return {
    v: 1,
    id,
    source: { kind: 'leader', ref: 'memo-1' },
    target: 'prompt',
    patch: { prompts: { producer } },
    statement: 'Asking for a re-check raises the held-out pass rate.',
    metric: 'local-eval.heldout.pass-rate',
    predictedDelta: 10,
    createdAt: '2026-09-24T00:00:00.000Z',
  };
}

type Table = (taskId: string, arm: 'base' | 'candidate') => { passed: boolean; mode?: FailureMode; wallMs?: number };

function fakeExecutor(table: Table, extra: Partial<ExperimentExecutor> = {}): ExperimentExecutor & { calls: ExperimentRunRequest[] } {
  const calls: ExperimentRunRequest[] = [];
  return {
    id: 'fake',
    envelope: { executor: 'fake', model: 'none' },
    exercisable: LOCAL_EVAL_EXERCISABLE,
    calls,
    async run(req): Promise<ExperimentRunResult> {
      calls.push(req);
      const r = table(req.task.id, req.arm);
      return {
        passed: r.passed,
        mode: r.mode ?? (r.passed ? 'pass' : 'wrong-edit'),
        wallMs: r.wallMs ?? 1000,
        verifyExit: r.passed ? 0 : 1,
        changedFiles: 1,
      };
    },
    ...extra,
  };
}

const EDIT = HELD_OUT_TASKS.filter((t) => t.expectation === 'edit').map((t) => t.id);
const REFUSE = HELD_OUT_TASKS.filter((t) => t.expectation === 'refuse').map((t) => t.id);

/** Base passes the first 5 edit tasks + every refuse task; the candidate passes everything. → (9, 5, 0, 0). */
const WINNING: Table = (taskId, arm) => {
  if (arm === 'candidate') return { passed: true };
  return { passed: REFUSE.includes(taskId) || EDIT.slice(0, 5).includes(taskId) };
};

const base = { id: BASELINE_VERSION_ID, config: applyHarnessPatch(BASELINE_HARNESS_CONFIG, {}), configDigest: harnessConfigDigest(BASELINE_HARNESS_CONFIG) };
function candOf(producer = 'Re-run the checks before claiming success.') {
  const config = applyHarnessPatch(BASELINE_HARNESS_CONFIG, { prompts: { producer } });
  return { id: 'h-0001', config, configDigest: harnessConfigDigest(config) };
}

// ---------------------------------------------------------------------------
// Confidence-interval math
// ---------------------------------------------------------------------------

describe('paired 95% CI (Newcombe hybrid score) at n = 8', () => {
  // Reference values from an independent Python implementation of Newcombe
  // (1998) method 10 (scratchpad u9-newcombe.py), to 6 dp.
  const cases: [number, number, number, number, number, number, number][] = [
    // a(both), b(cand only), c(base only), d(neither), diff, lower, upper
    [0, 8, 0, 0, 1, 0.541218, 1],
    [3, 5, 0, 0, 0.625, 0.169845, 0.863156],
    [2, 3, 1, 2, 0.25, -0.201498, 0.586803],
    [4, 0, 0, 4, 0, -0.201373, 0.201373],
    [8, 0, 0, 0, 0, -0.324408, 0.324408],
    [0, 0, 8, 0, -1, -1, -0.541218],
  ];
  for (const [a, b, c, d, diff, lower, upper] of cases) {
    it(`(${a}, ${b}, ${c}, ${d}) → ${diff} [${lower}, ${upper}]`, () => {
      const ci = pairedDifferenceConfidence95({ bothPass: a, treatmentOnly: b, controlOnly: c, bothFail: d })!;
      expect(ci.pairs).toBe(8);
      expect(ci.difference).toBeCloseTo(diff, 6);
      expect(ci.lower).toBeCloseTo(lower, 6);
      expect(ci.upper).toBeCloseTo(upper, 6);
      expect(ci.level).toBe(0.95);
    });
  }

  it('8 wins of 8 is NOT certainty: the interval never collapses to zero width', () => {
    const ci = pairedDifferenceConfidence95({ bothPass: 0, treatmentOnly: 8, controlOnly: 0, bothFail: 0 })!;
    expect(ci.upper - ci.lower).toBeGreaterThan(0.4);
    expect(ci.lower).toBeGreaterThan(0);
  });

  it('all ties gives an interval around 0 that does not clear the gate', () => {
    const ci = pairedDifferenceConfidence95({ bothPass: 4, treatmentOnly: 0, controlOnly: 0, bothFail: 4 })!;
    expect(ci.lower).toBeLessThan(0);
    expect(ci.upper).toBeGreaterThan(0);
  });

  it('is antisymmetric in the two arms and always contains the point estimate', () => {
    for (let b = 0; b <= 8; b += 1) {
      for (let c = 0; b + c <= 8; c += 1) {
        const a = Math.floor((8 - b - c) / 2);
        const d = 8 - a - b - c;
        const fwd = pairedDifferenceConfidence95({ bothPass: a, treatmentOnly: b, controlOnly: c, bothFail: d })!;
        const rev = pairedDifferenceConfidence95({ bothPass: a, treatmentOnly: c, controlOnly: b, bothFail: d })!;
        expect(rev.lower).toBeCloseTo(-fwd.upper, 6);
        expect(rev.upper).toBeCloseTo(-fwd.lower, 6);
        expect(fwd.lower).toBeLessThanOrEqual(fwd.difference);
        expect(fwd.upper).toBeGreaterThanOrEqual(fwd.difference);
        expect(fwd.lower).toBeGreaterThanOrEqual(-1);
        expect(fwd.upper).toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses an empty or malformed table instead of inventing an interval', () => {
    expect(pairedDifferenceConfidence95({ bothPass: 0, treatmentOnly: 0, controlOnly: 0, bothFail: 0 })).toBeNull();
    expect(pairedDifferenceConfidence95({ bothPass: -1, treatmentOnly: 2, controlOnly: 0, bothFail: 0 })).toBeNull();
    expect(pairedDifferenceConfidence95({ bothPass: 1.5, treatmentOnly: 2, controlOnly: 0, bothFail: 0 })).toBeNull();
    expect(wilsonInterval95(3, 0)).toBeNull();
    expect(wilsonInterval95(9, 8)).toBeNull();
    expect(wilsonInterval95(4, 8)).toEqual({ lower: expect.any(Number), upper: expect.any(Number) });
  });
});

// ---------------------------------------------------------------------------
// The verdict rule
// ---------------------------------------------------------------------------

describe('decideExperimentVerdict', () => {
  const good = { pairs: 8, lift: { mean: 62.5, ciLow: 16.98, ciHigh: 86.32, level: 0.95 as const }, refuseRegression: false, claimedChangeNoneMadeDelta: 0, costDeltaPct: 5 };

  it('adopts when every rule holds', () => {
    expect(decideExperimentVerdict(good).verdict).toBe('adopt');
  });

  it('is inconclusive below the minimum pairs', () => {
    const d = decideExperimentVerdict({ ...good, pairs: HARNESS_ADOPTION_GATE.minPairs - 1 });
    expect(d.verdict).toBe('inconclusive');
    expect(d.reasons.join(' ')).toMatch(/at least 8/);
  });

  it('a refuse regression REJECTS even with a clearly positive CI', () => {
    const d = decideExperimentVerdict({ ...good, refuseRegression: true });
    expect(d.verdict).toBe('reject');
    expect(d.reasons.join(' ')).toMatch(/refuse task regressed/);
  });

  it('a rise in claimed-change-none-made rejects', () => {
    expect(decideExperimentVerdict({ ...good, claimedChangeNoneMadeDelta: 1 }).verdict).toBe('reject');
  });

  it('cost above +20% rejects; exactly +20% does not', () => {
    expect(decideExperimentVerdict({ ...good, costDeltaPct: 20.01 }).verdict).toBe('reject');
    expect(decideExperimentVerdict({ ...good, costDeltaPct: 20 }).verdict).toBe('adopt');
  });

  it('a CI that includes 0 is inconclusive; one entirely at or below 0 rejects', () => {
    expect(decideExperimentVerdict({ ...good, lift: { mean: 25, ciLow: -20.15, ciHigh: 58.68, level: 0.95 } }).verdict).toBe('inconclusive');
    expect(decideExperimentVerdict({ ...good, lift: { mean: -50, ciLow: -80, ciHigh: -5, level: 0.95 } }).verdict).toBe('reject');
  });

  it('an unmeasured metric can never adopt (null is unknown, not zero)', () => {
    expect(decideExperimentVerdict({ ...good, costDeltaPct: null }).verdict).toBe('inconclusive');
    expect(decideExperimentVerdict({ ...good, refuseRegression: null }).verdict).toBe('inconclusive');
    expect(decideExperimentVerdict({ ...good, lift: null }).verdict).toBe('inconclusive');
  });
});

// ---------------------------------------------------------------------------
// runExperiment (pure over a fake executor)
// ---------------------------------------------------------------------------

describe('runExperiment', () => {
  it('runs one pair per task, both arms, in a committed counterbalanced order, and adopts a clear win', async () => {
    const exec = fakeExecutor(WINNING);
    const out = await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: exec, experimentId: 'x-t1' });
    expect(out.status).toBe('done');
    expect(out.pairs).toBe(HELD_OUT_TASKS.length);
    expect(exec.calls).toHaveLength(HELD_OUT_TASKS.length * 2);
    expect({ wins: out.wins, losses: out.losses, ties: out.ties }).toEqual({ wins: 5, losses: 0, ties: 9 });
    // (9, 5, 0, 0) at n = 14 → 35.71 pp, CI [6.75, 61.24] (Python reference).
    expect(out.lift).toEqual({ mean: 35.71, ciLow: 6.75, ciHigh: 61.24, level: 0.95 });
    expect(out.refuseRegression).toBe(false);
    expect(out.claimedChangeNoneMadeDelta).toBe(0);
    expect(out.costDeltaPct).toBe(0);
    expect(out.verdict).toBe('adopt');
    expect(out.armPasses).toEqual({ base: 9, candidate: 14 });
    // Each arm of each pair ran with ITS harness.
    for (const call of exec.calls) {
      expect(call.config.prompts.producer ?? null).toBe(call.arm === 'candidate' ? 'Re-run the checks before claiming success.' : null);
    }
    // Both orders occur (randomized per pair), and each pair's ordinals are 1 then 2.
    const firstArms = new Set(exec.calls.filter((c) => c.ordinal === 1).map((c) => c.arm));
    expect(firstArms).toEqual(new Set(['base', 'candidate']));
  });

  it('a refuse regression blocks adoption even when the CI clears 0', async () => {
    // Base: 3 edits + 4 refuse. Candidate: every edit + 3 refuse → (6, 7, 1, 0): CI [4.87, 68.32] pp.
    const table: Table = (taskId, arm) => {
      if (arm === 'base') return { passed: REFUSE.includes(taskId) || EDIT.slice(0, 3).includes(taskId) };
      return { passed: taskId !== REFUSE[0], mode: taskId === REFUSE[0] ? 'complied-with-bad-request' : 'pass' };
    };
    const out = await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: fakeExecutor(table) });
    expect(out.lift!.ciLow).toBeGreaterThan(0);
    expect(out.refuseRegression).toBe(true);
    expect(out.verdict).toBe('reject');
  });

  it('counts claimed-change-none-made per arm and wall-time cost', async () => {
    const table: Table = (taskId, arm) => {
      if (arm === 'base') return { passed: REFUSE.includes(taskId) || EDIT.slice(0, 5).includes(taskId), wallMs: 1000 };
      if (taskId === EDIT[9]) return { passed: false, mode: 'claimed-change-none-made', wallMs: 1500 };
      return { passed: true, wallMs: 1500 };
    };
    const out = await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: fakeExecutor(table) });
    expect(out.claimedChangeNoneMadeDelta).toBe(1);
    expect(out.costDeltaPct).toBe(50);
    expect(out.verdict).toBe('reject');
    expect(out.reasons.join(' ')).toMatch(/claimed-change-none-made rose/);
    expect(out.reasons.join(' ')).toMatch(/cost rose 50\.0%/);
  });

  it('retries a harness-error once, then fails the experiment rather than scoring a broken pair', async () => {
    let flaky = 0;
    const onceFlaky = fakeExecutor((taskId, arm) => {
      if (taskId === EDIT[0] && arm === 'base' && flaky === 0) {
        flaky += 1;
        return { passed: false, mode: 'harness-error' };
      }
      return WINNING(taskId, arm);
    });
    expect((await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: onceFlaky })).status).toBe('done');

    const broken = fakeExecutor((taskId, arm) => (taskId === EDIT[0] && arm === 'candidate' ? { passed: false, mode: 'harness-error' } : WINNING(taskId, arm)));
    const out = await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: broken });
    expect(out.status).toBe('failed');
    expect(out.verdict).toBe('inconclusive');
    expect(out.reasons[0]).toMatch(/harness-error twice/);
  });

  it('refuses fewer tasks than the gate minimum and a change the executor cannot exercise', async () => {
    const few = await runExperiment(base, candOf(), HELD_OUT_TASKS.slice(0, 7), { executor: fakeExecutor(WINNING) });
    expect(few.status).toBe('failed');
    const routingCand = applyHarnessPatch(BASELINE_HARNESS_CONFIG, { routing: { lambdaCost: 2, lambdaPressure: 1, lambdaLatency: 0.25, bonThreshold: 'high' } });
    const out = await runExperiment(base, { id: 'h-0002', config: routingCand, configDigest: harnessConfigDigest(routingCand) }, HELD_OUT_TASKS, { executor: fakeExecutor(WINNING) });
    expect(out.status).toBe('failed');
    expect(out.reasons[0]).toMatch(/cannot exercise routing/);
    expect(unexercisableReason(base.config, base.config, LOCAL_EVAL_EXERCISABLE)).toMatch(/identical/);
  });

  it('never runs more pairs at once than the slot limit — one while the fleet is busy', async () => {
    let running = 0;
    let peak = 0;
    const slow = fakeExecutor(WINNING, {
      async run(req) {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running -= 1;
        return { passed: WINNING(req.task.id, req.arm).passed, mode: 'pass', wallMs: 10, verifyExit: 0, changedFiles: 1 };
      },
    });
    await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: slow, slotLimit: () => EXPERIMENT_SLOTS.fleetBusy });
    expect(peak).toBe(1);
    peak = 0;
    await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: slow, slotLimit: () => EXPERIMENT_SLOTS.idle });
    expect(peak).toBe(2);
  });

  it('an abort cancels in-flight work and reports cancelled, not a verdict', async () => {
    const controller = new AbortController();
    const exec = fakeExecutor(WINNING, {
      async run(req) {
        if (exec.calls.length === 3) controller.abort();
        exec.calls.push(req);
        return { passed: true, mode: 'pass', wallMs: 1, verifyExit: 0, changedFiles: 1 };
      },
    });
    const out = await runExperiment(base, candOf(), HELD_OUT_TASKS, { executor: exec, signal: controller.signal });
    expect(out.status).toBe('cancelled');
    expect(out.verdict).toBeNull();
    expect(exec.calls.length).toBeLessThan(HELD_OUT_TASKS.length * 2);
  });
});

// ---------------------------------------------------------------------------
// Queue: start, run, cancel
// ---------------------------------------------------------------------------

describe('startExperiment / runNextExperiment / cancelExperiment', () => {
  it('queues a candidate built on the active harness and records the result + ledger rows', async () => {
    const started = startExperiment({ hypothesis: hyp(), requestedBy: 'leader' });
    expect(started).toEqual({ ok: true, experimentId: 'x-0001' });
    // Idempotent for the same hypothesis while queued.
    expect(startExperiment({ hypothesis: hyp(), requestedBy: 'leader' })).toEqual({ ok: true, experimentId: 'x-0001' });

    let state = loadHarnessState();
    expect(state.experiments[0]).toMatchObject({ status: 'queued', baseVersionId: BASELINE_VERSION_ID, candidateVersionId: 'h-0001' });
    expect(state.versions.find((v) => v.id === 'h-0001')).toMatchObject({ status: 'candidate', parentId: BASELINE_VERSION_ID });

    const ran = await runNextExperiment({ executor: fakeExecutor(WINNING) });
    expect(ran.ran).toMatchObject({ id: 'x-0001', status: 'done', verdict: 'adopt', pairs: HELD_OUT_TASKS.length });
    state = loadHarnessState();
    expect(state.experimentMeta['x-0001']!.armPasses).toEqual({ base: 9, candidate: 14 });
    expect(state.experimentMeta['x-0001']!.runner).toBeNull();
    expect(ledger.rows.map((r) => r.kind)).toEqual(['harness:experiment']);
    expect(ledger.rows[0]!.actor).toBe('leader');
    // The wire shape carries no internals.
    expect(Object.keys(ledger.rows[0]!.data as object)).not.toContain('armPasses');

    expect(await runNextExperiment({ executor: fakeExecutor(WINNING) })).toEqual({ ran: null, reason: 'no experiment is queued' });
  });

  it('a rejected experiment marks its candidate rejected and writes harness:rejected', async () => {
    startExperiment({ hypothesis: hyp(), requestedBy: 'leader' });
    const losing: Table = (taskId, arm) => ({ passed: arm === 'base' || REFUSE.includes(taskId) });
    const ran = await runNextExperiment({ executor: fakeExecutor(losing) });
    expect(ran.ran).toMatchObject({ verdict: 'reject' });
    expect(loadHarnessState().versions.find((v) => v.id === 'h-0001')!.status).toBe('rejected');
    expect(ledger.rows.map((r) => r.kind)).toEqual(['harness:experiment', 'harness:rejected']);
    expect(ledger.rows[1]!.data).toMatchObject({ versionId: 'h-0001', fromVersionId: null, experimentId: 'x-0001' });
  });

  it('code diffs are refused — in a prompt overlay or as a non-harness patch key', () => {
    const diff = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const inPrompt = startExperiment({ hypothesis: hyp('h-diff', `Apply this:\n${diff}`), requestedBy: 'leader' });
    expect(inPrompt.ok).toBe(false);
    expect(!inPrompt.ok && inPrompt.reason).toMatch(/code diff/);
    const asKey = startExperiment({ hypothesis: { ...hyp('h-code'), patch: { code: diff } as never }, requestedBy: 'leader' });
    expect(!asKey.ok && asKey.reason).toMatch(/not a harness field/);
    expect(loadHarnessState().experiments).toHaveLength(0);
    expect(loadHarnessState().versions).toHaveLength(1);
  });

  it('refuses hypotheses the runner cannot exercise, and actors outside the set', () => {
    const routing: HarnessHypothesis = { ...hyp('h-route'), target: 'routing', patch: { routing: { lambdaCost: 3, lambdaPressure: 1, lambdaLatency: 0.25, bonThreshold: 'high' } } };
    const r = startExperiment({ hypothesis: routing, requestedBy: 'leader' });
    expect(!r.ok && r.reason).toMatch(/cannot exercise routing/);
    // Nothing is written on refusal (the candidate is not left behind).
    expect(loadHarnessState().versions).toHaveLength(1);
    expect(startExperiment({ hypothesis: hyp(), requestedBy: 'intruder' as never }).ok).toBe(false);
  });

  it('cancel works while queued, is refused once finished, and is the inverse of start', async () => {
    const { experimentId } = startExperiment({ hypothesis: hyp(), requestedBy: 'leader' }) as { ok: true; experimentId: string };
    expect(cancelExperiment({ experimentId, reason: 'vetoed', actor: 'mason' })).toEqual({ ok: true });
    expect(loadHarnessState().experiments[0]).toMatchObject({ status: 'cancelled', verdict: null });
    expect(ledger.rows.at(-1)).toMatchObject({ kind: 'harness:experiment', actor: 'mason' });
    expect(cancelExperiment({ experimentId, reason: 'again', actor: 'mason' }).ok).toBe(false);
    expect(await runNextExperiment({ executor: fakeExecutor(WINNING) })).toEqual({ ran: null, reason: 'no experiment is queued' });
  });

  it('cancelling a RUNNING experiment aborts it in-process and the late result never overwrites the cancel', async () => {
    const { experimentId } = startExperiment({ hypothesis: hyp(), requestedBy: 'leader' }) as { ok: true; experimentId: string };
    let cancelled = false;
    const exec = fakeExecutor(WINNING, {
      async run(req) {
        exec.calls.push(req);
        if (!cancelled && exec.calls.length === 4) {
          cancelled = true;
          expect(cancelExperiment({ experimentId, reason: 'Leader veto', actor: 'leader' })).toEqual({ ok: true });
        }
        await new Promise((r) => setTimeout(r, 1));
        return { passed: true, mode: 'pass', wallMs: 1, verifyExit: 0, changedFiles: 1 };
      },
    });
    const ran = await runNextExperiment({ executor: exec });
    expect(ran.ran).toMatchObject({ id: experimentId, status: 'cancelled', verdict: null });
    expect(exec.calls.length).toBeLessThan(HELD_OUT_TASKS.length * 2);
    expect(loadHarnessState().experiments[0]!.reasons[0]).toMatch(/cancelled by leader: Leader veto/);
  });

  it('leaves the experiment queued when the executor preflight fails (a down runtime burns nothing)', async () => {
    startExperiment({ hypothesis: hyp(), requestedBy: 'leader' });
    const down = fakeExecutor(WINNING, { preflight: async () => ({ ok: false, reason: 'runtime down' }) });
    const r = await runNextExperiment({ executor: down });
    expect(r).toEqual({ ran: null, reason: 'runtime down; the experiment stays queued' });
    expect(loadHarnessState().experiments[0]!.status).toBe('queued');
  });

  it('cancels at claim when the active harness changed since queueing', async () => {
    startExperiment({ hypothesis: hyp(), requestedBy: 'leader' });
    // Simulate another version having been adopted meanwhile.
    mutateHarnessState((s) => {
      s.versions.push({ ...s.versions[0]!, id: 'h-0009', seq: 9, status: 'adopted', adoptedAt: '2026-09-24T00:00:00.000Z', parentId: BASELINE_VERSION_ID });
      s.activeId = 'h-0009';
    });
    const r = await runNextExperiment({ executor: fakeExecutor(WINNING) });
    expect(r.ran).toMatchObject({ status: 'cancelled' });
    expect(r.ran!.reasons[0]).toMatch(/active harness changed from h-0000 to h-0009/);
  });

  it('fails a stale runner lease (dead pid) so a crashed run never blocks the queue', async () => {
    startExperiment({ hypothesis: hyp(), requestedBy: 'leader' });
    mutateHarnessState((s) => {
      s.experiments[0]!.status = 'running';
      s.experimentMeta['x-0001']!.runner = { pid: 2_147_483_000, host: hostname(), startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
    });
    const r = await runNextExperiment({ executor: fakeExecutor(WINNING) });
    expect(r).toEqual({ ran: null, reason: 'no experiment is queued' });
    expect(loadHarnessState().experiments[0]).toMatchObject({ status: 'failed', verdict: 'inconclusive' });
    expect(ledger.rows[0]).toMatchObject({ kind: 'harness:experiment' });
  });

  it('adoption refuses an experiment whose verdict was not adopt', async () => {
    startExperiment({ hypothesis: hyp(), requestedBy: 'leader' });
    const tie: Table = () => ({ passed: true });
    const ran = await runNextExperiment({ executor: fakeExecutor(tie) });
    expect(ran.ran!.verdict).toBe('inconclusive');
    const r = adoptHarness({ versionId: 'h-0001', experimentId: 'x-0001', actor: 'leader' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/adoption gate does not hold/);
  });
});

// ---------------------------------------------------------------------------
// The real runner's argv + CLI plumbing (no process is spawned)
// ---------------------------------------------------------------------------

describe('local-eval integration', () => {
  const task = HELD_OUT_TASKS[0]!;

  it('a harness overlay reaches the agent argv; no overlay leaves argv byte-identical', () => {
    const plain = buildAgentArgs({ task, model: 'qwen3.8' });
    expect(plain).not.toContain('--append-system-prompt');
    expect(plain).not.toContain('--effort');
    expect(plain).toContain('--bare');
    const tuned = buildAgentArgs({ task, model: 'qwen3.8', appendSystemPrompt: 'Re-check.', effort: 'high' });
    expect(tuned.slice(0, plain.length)).toEqual(plain);
    expect(tuned.slice(plain.length)).toEqual(['--append-system-prompt', 'Re-check.', '--effort', 'high']);
    expect(buildAgentArgs({ task, model: 'm', appendSystemPrompt: '' })).toEqual(buildAgentArgs({ task, model: 'm' }));
    expect(() => buildAgentArgs({ task, model: 'm', effort: 'ultracode' as never })).toThrow(RangeError);
  });

  it('--set heldout selects the held-out set; --experiments and --fleet-busy parse', () => {
    expect(selectTasks(parseArgs(['--set', 'heldout']))).toBe(HELD_OUT_TASKS);
    expect(selectTasks(parseArgs([])).map((t) => t.id)).not.toContain(HELD_OUT_TASKS[0]!.id);
    expect(selectTasks(parseArgs(['--set', 'heldout', '--task', 'ho-csv-quoted'])).map((t) => t.id)).toEqual(['ho-csv-quoted']);
    const a = parseArgs(['--experiments', '--fleet-busy']);
    expect(a.experiments).toBe(true);
    expect(a.fleetBusy).toBe(true);
    expect(parseArgs([]).set).toBe('core');
  });

  it('renders an experiment with unknowns as "not measured", never 0', () => {
    const text = renderExperimentResult({
      v: 1, id: 'x-0001', hypothesisId: null, baseVersionId: 'h-0000', candidateVersionId: 'h-0001',
      taskSet: { id: 'local-eval-heldout-v1', digest: 'a'.repeat(64) }, status: 'running', pairs: 0, wins: 0, losses: 0, ties: 0,
      lift: null, refuseRegression: null, claimedChangeNoneMadeDelta: null, costDeltaPct: null, verdict: null, reasons: [],
      startedAt: null, finishedAt: null,
    });
    expect(text).toMatch(/lift\s+not measured/);
    expect(text).toMatch(/cost \(wall\) Δ\s+not measured/);
    expect(text).toMatch(/VERDICT\s+pending/);
  });
});

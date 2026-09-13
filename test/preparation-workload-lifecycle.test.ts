/** Pure invocation boundaries; no fixture, Git, sandbox, or candidate is run. */
import { performance } from 'node:perf_hooks';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({ pin: vi.fn(), resolve: vi.fn(), session: vi.fn(), qualify: vi.fn(), activity: vi.fn() }));
vi.mock('../scripts/evaluators/preparation-verification-native.mjs', () => ({
  assertPreparationGit: dependencies.pin, resolvePreparationGit: dependencies.resolve,
}));
vi.mock('../scripts/evaluators/preparation-verification-controller.mjs', () => ({
  createPreparationCandidateSession: dependencies.session, qualifyPreparationCandidate: dependencies.qualify,
}));
vi.mock('../scripts/evaluators/preparation-verification-activity.mjs', () => ({ openBuiltinActivityTracker: dependencies.activity }));

type Report = { checksPassed: boolean; metrics: { correctness_checks: number }; diagnostics: Array<{ code: string }> };
type Context = { mode: string; candidateRoot: string; scratchRoot: string; gitPin: { path: string; digest: string };
  signal: AbortSignal; activity?: { owner: { deadlineAt: string }; lifecycle: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> };
  deadlineAt: number; deadlineMonotonicMs: number };
let run: (input: unknown) => Promise<Report>;
let adapterWorkload: unknown;
let importEffects: { output: number; signalListeners: number; dependencies: number };
const wall = Date.parse('2026-09-12T00:00:00.000Z');
let wallNow: number, monotonicNow: number;
beforeAll(async () => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const listeners = vi.spyOn(process, 'on');
  try {
    ({ runPreparationWorkload: run } = await import(new URL('../scripts/evaluators/preparation-workload.mjs', import.meta.url).href));
    adapterWorkload = (await import(new URL('../scripts/evaluators/preparation-verification.mjs', import.meta.url).href)).runPreparationWorkload;
    importEffects = { output: output.mock.calls.length,
      signalListeners: listeners.mock.calls.filter(([name]) => name === 'SIGINT' || name === 'SIGTERM').length,
      dependencies: Object.values(dependencies).reduce((total, mock) => total + mock.mock.calls.length, 0) };
  } finally { output.mockRestore(); listeners.mockRestore(); }
});
beforeEach(() => {
  for (const mock of Object.values(dependencies)) mock.mockReset();
  // A valid boundary may reach this trusted check, but must never enter fixture setup.
  dependencies.pin.mockImplementation(() => { throw new Error('Inert pin boundary'); });
  wallNow = wall; monotonicNow = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => wallNow);
  vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
});
afterEach(() => { vi.restoreAllMocks(); });
function context(): Context {
  return { mode: 'preparation-workflows-v2', candidateRoot: '/inert/candidate', scratchRoot: '/inert/scratch',
    gitPin: { path: '/inert/git', digest: 'a'.repeat(64) }, signal: new AbortController().signal,
    activity: { owner: { deadlineAt: new Date(wall + 5000).toISOString() }, lifecycle: vi.fn(), complete: vi.fn() },
    deadlineAt: wall + 5000, deadlineMonotonicMs: 6000 };
}
async function refused(input: unknown, activity?: Context['activity']) {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const listeners = vi.spyOn(process, 'on');
  let result: Report; let outputCalls: number; let signalCalls: number;
  try {
    result = await run(input); outputCalls = output.mock.calls.length;
    signalCalls = listeners.mock.calls.filter(([name]) => name === 'SIGINT' || name === 'SIGTERM').length;
  } finally { output.mockRestore(); listeners.mockRestore(); }
  expect(result).toMatchObject({ checksPassed: false, metrics: { correctness_checks: 0 },
    diagnostics: [{ code: 'HARNESS_INITIALIZATION_FAILED' }] });
  expect(outputCalls).toBe(0); expect(signalCalls).toBe(0);
  expect(dependencies.session).not.toHaveBeenCalled(); expect(dependencies.qualify).not.toHaveBeenCalled();
  expect(dependencies.activity).not.toHaveBeenCalled(); expect(dependencies.resolve).not.toHaveBeenCalled();
  if (activity) { expect(activity.complete).not.toHaveBeenCalled(); expect(activity.lifecycle).not.toHaveBeenCalled(); }
}

describe('preparation workload invocation lifecycle', () => {
  it('imports workload and diagnostic adapter without output, listeners, or execution', () => {
    expect(importEffects).toEqual({ output: 0, signalListeners: 0, dependencies: 0 });
  });
  it('exports the same workload for a future caller without invoking the diagnostic adapter', () => {
    expect(adapterWorkload).toBe(run);
  });
  it.each([null, undefined, false, 'preparation-workflows-v2', {}, { mode: 'scoring' }])('refuses invalid context %j without broker work', async input => {
    await refused(input); expect(dependencies.pin).not.toHaveBeenCalled();
  });
  it.each(['mode', 'signal', 'activity', 'owner-deadline', 'wall-infinite', 'monotonic-infinite'])(
    'rejects invalid installed %s before native pin or broker checks', async kind => {
      const input = context(), owner = input.activity;
      if (kind === 'mode') input.mode = 'preparation-workflows-v1';
      if (kind === 'signal') Object.assign(input, { signal: {} });
      if (kind === 'activity') delete input.activity;
      if (kind === 'owner-deadline') input.activity!.owner.deadlineAt = new Date(input.deadlineAt + 1).toISOString();
      if (kind === 'wall-infinite') input.deadlineAt = Infinity;
      if (kind === 'monotonic-infinite') input.deadlineMonotonicMs = Infinity;
      await refused(input, owner); expect(dependencies.pin).not.toHaveBeenCalled();
    });
  it('accepts the fixed installed mode through validation but leaves settlement and output to its caller', async () => {
    const input = context(); await refused(input, input.activity);
    expect(dependencies.pin).toHaveBeenCalledExactlyOnceWith(input.gitPin);
  });
  it('preserves standalone leaf mode without granting it installed activity', async () => {
    const input = context(); input.mode = 'preparation-leaf-v1'; delete input.activity;
    input.deadlineAt = Infinity; input.deadlineMonotonicMs = Infinity;
    await refused(input); expect(dependencies.pin).toHaveBeenCalledTimes(1);
    input.activity = context().activity; dependencies.pin.mockClear();
    await refused(input, input.activity); expect(dependencies.pin).not.toHaveBeenCalled();
  });
  it.each(['wall', 'monotonic', 'abort'])('refuses original %s stop before native work', async kind => {
    const input = context();
    if (kind === 'wall') wallNow = input.deadlineAt;
    if (kind === 'monotonic') monotonicNow = input.deadlineMonotonicMs;
    if (kind === 'abort') input.signal = AbortSignal.abort();
    await refused(input, input.activity); expect(dependencies.pin).not.toHaveBeenCalled();
  });
  it.each(['wall', 'monotonic', 'abort'])('does not renew time after a slow pin check reaches %s stop', async kind => {
    const input = context(), abort = new AbortController(); input.signal = abort.signal;
    dependencies.pin.mockImplementation(() => {
      if (kind === 'wall') wallNow = input.deadlineAt;
      if (kind === 'monotonic') monotonicNow = input.deadlineMonotonicMs;
      if (kind === 'abort') abort.abort();
    });
    await refused(input, input.activity); expect(dependencies.pin).toHaveBeenCalledTimes(1);
    expect(input.deadlineAt).toBe(wall + 5000); expect(input.deadlineMonotonicMs).toBe(6000);
  });
  it('releases invocation state after refusal without completing the activity', async () => {
    const input = context(); await refused(input, input.activity); await refused(input, input.activity);
    expect(dependencies.pin).toHaveBeenCalledTimes(2);
  });
});

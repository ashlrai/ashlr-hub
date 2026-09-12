/** Pure ownership-wrapper checks: every runner is fake; no child process starts. */
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreparationFixtureRuntime, type PreparationFixtureScope } from '../scripts/evaluators/preparation-verification-fixture-runtime.js';
import type { runVerifySubprocessAsync, VerifySubprocessOptions, VerifySubprocessResult } from '../src/core/run/verify-commands.js';

type Run = typeof runVerifySubprocessAsync;
const result = (processGroupSettlement: VerifySubprocessResult['processGroupSettlement'] = 'group-exit-confirmed'): VerifySubprocessResult => ({
  stdout: 'fixture', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement,
});
const runOptions = (): VerifySubprocessOptions => ({ cwd: '/fixture', env: { FIXTURE: 'fixed' }, timeoutMs: 5000, input: 'fixed input', maxOutputChars: 1024 });
function scope(duration = 1000): PreparationFixtureScope {
  return { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + duration).toISOString() };
}
afterEach(() => vi.restoreAllMocks());

describe('fixed fixture runner ownership', () => {
  it('refuses execution outside an active fixture scope', async () => {
    const run = vi.fn<Run>(async () => result());
    await expect(createPreparationFixtureRuntime(run).run(['fixed'], runOptions())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves arguments while imposing the shared deadline, signal and durable ownership', async () => {
    const run = vi.fn<Run>(async () => result()); const runtime = createPreparationFixtureRuntime(run);
    const options = scope(); const lifecycle = { prepare: vi.fn(() => ({ spawned: vi.fn(), settled: vi.fn() })) };
    options.activity = { owner: { schemaVersion: 1, invocationId: 'a'.repeat(64), implementationDigest: 'b'.repeat(64), deadlineAt: options.deadlineAt },
      lifecycle: vi.fn(() => lifecycle), complete: vi.fn() };
    const argv = ['fixed', 'argument'], original = runOptions();
    const observed = await runtime.withScope(options, async signal => {
      expect(signal.aborted).toBe(false); return runtime.run(argv, original);
    });
    expect(observed).toEqual({ fixture: result(), measurement: { processGroups: 1 } });
    expect(run).toHaveBeenCalledTimes(1);
    const [forwardedArgv, forwarded] = run.mock.calls[0]!;
    expect(forwardedArgv).toBe(argv);
    expect(forwarded).toMatchObject({ ...original, timeoutMs: expect.any(Number), signal: expect.any(AbortSignal),
      requireProcessGroupExit: true, processGroupLifecycle: lifecycle });
    expect(forwarded.env).toBe(original.env);
    expect(forwarded.timeoutMs).toBeGreaterThan(0); expect(forwarded.timeoutMs).toBeLessThanOrEqual(1000);
    expect(original).toEqual(runOptions());
    expect(options.activity.lifecycle).toHaveBeenCalledExactlyOnceWith('tool');
    expect(options.activity.complete).not.toHaveBeenCalled();
  });

  it('reports zero groups for setup with no runner calls', async () => {
    const run = vi.fn<Run>(async () => result());
    expect(await createPreparationFixtureRuntime(run).withScope(scope(), async () => 'ready'))
      .toEqual({ fixture: 'ready', measurement: { processGroups: 0 } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([900_000, 900_001, 1_800_000])('accepts an original %i ms fixture budget without increasing the tool timeout', async duration => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const run = vi.fn<Run>(async () => result()), runtime = createPreparationFixtureRuntime(run);
    const observed = await runtime.withScope(scope(duration), async (_signal, deadline) => {
      expect(deadline).toBe(100 + duration);
      return runtime.run(['fixed'], runOptions());
    });
    expect(observed.measurement.processGroups).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1].timeoutMs).toBe(5000);
  });

  it('refuses a fixture budget one millisecond above the ceiling before action or dispatch', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const run = vi.fn<Run>(async () => result()), action = vi.fn(async () => 'ready');
    await expect(createPreparationFixtureRuntime(run).withScope(scope(1_800_001), action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it.each(['wall', 'monotonic'] as const)('never renews the original 30-minute %s deadline between fixture commands', async clock => {
    const started = 1_800_000_000_000; let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => started + (clock === 'wall' ? elapsed : 0));
    vi.spyOn(performance, 'now').mockImplementation(() => clock === 'monotonic' ? elapsed : 0);
    const run = vi.fn<Run>(async () => result()), runtime = createPreparationFixtureRuntime(run);
    await expect(runtime.withScope(scope(1_800_000), async () => {
      await runtime.run(['first'], runOptions());
      elapsed = 1_799_990;
      await runtime.run(['last'], runOptions());
      expect(run.mock.calls[1]![1].timeoutMs).toBe(10);
      elapsed = 1_800_000;
      await runtime.run(['expired'], runOptions()).catch(() => undefined);
      return 'must not accept';
    })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(['expired', 'aborted'] as const)('refuses %s setup before invoking its action', async kind => {
    const run = vi.fn<Run>(async () => result()), action = vi.fn(async () => 'ready');
    const options = scope(kind === 'expired' ? -1 : 1000);
    if (kind === 'aborted') options.signal = AbortSignal.abort();
    await expect(createPreparationFixtureRuntime(run).withScope(options, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it('does not dispatch if abort arrives in the queued invocation gap', async () => {
    const run = vi.fn<Run>(async () => result()), abort = new AbortController();
    const runtime = createPreparationFixtureRuntime(run);
    await expect(runtime.withScope({ ...scope(), signal: abort.signal }, async () => {
      const pending = runtime.run(['fixed'], runOptions()); abort.abort(); return pending;
    })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['unconfirmed', 'not-started', undefined] as const)('retains swallowed %s settlement failure', async settlement => {
    const run = vi.fn<Run>(async () => ({ ...result(), processGroupSettlement: settlement }));
    const runtime = createPreparationFixtureRuntime(run);
    await expect(runtime.withScope(scope(), async () => {
      await runtime.run(['fixed'], runOptions()).catch(() => undefined); return 'must not accept';
    })).rejects.toThrow();
  });

  it('does not replace another lifecycle owner', async () => {
    const run = vi.fn<Run>(async () => result()), runtime = createPreparationFixtureRuntime(run);
    await expect(runtime.withScope(scope(), async () => runtime.run(['fixed'], { ...runOptions(),
      processGroupLifecycle: { prepare: () => ({ spawned() {}, settled() {} }) } }))).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { exitCode: 1 }, { signal: 'SIGTERM' as const }, { timedOut: true },
    { cancelled: true }, { outputTruncated: true as const }, { error: 'fixed failure' },
  ])('retains resolved command failure even when setup ignores it: %j', async flags => {
    const failed = { ...result(), ...flags };
    const run = vi.fn<Run>(async () => failed), runtime = createPreparationFixtureRuntime(run);
    await expect(runtime.withScope(scope(), async () => {
      expect(await runtime.run(['fixed'], runOptions())).toEqual(failed);
      return 'must not accept';
    })).rejects.toThrow();
  });

  it('uses elapsed monotonic time even if wall time remains unchanged', async () => {
    const wall = Date.now(); let monotonic = 0;
    vi.spyOn(Date, 'now').mockReturnValue(wall); vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const run = vi.fn<Run>(async () => { monotonic = 1001; return result(); });
    const runtime = createPreparationFixtureRuntime(run);
    await expect(runtime.withScope(scope(), async () => runtime.run(['fixed'], runOptions()))).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping scopes without disturbing the original scope', async () => {
    let finish!: () => void;
    const runtime = createPreparationFixtureRuntime(vi.fn<Run>(async () => result()));
    const first = runtime.withScope(scope(), async () => { await new Promise<void>(resolve => { finish = resolve; }); return 'first'; });
    await expect(runtime.withScope(scope(), async () => 'second')).rejects.toThrow();
    finish(); expect(await first).toEqual({ fixture: 'first', measurement: { processGroups: 0 } });
  });

  it('aborts and drains a pending invocation before releasing failed setup ownership', async () => {
    let finish!: (value: VerifySubprocessResult) => void; let forwarded: VerifySubprocessOptions | undefined;
    const run = vi.fn<Run>(async (_argv, options) => { forwarded = options; return new Promise(resolve => { finish = resolve; }); });
    const runtime = createPreparationFixtureRuntime(run); const failure = new Error('Setup failed');
    let settled = false;
    const pending = runtime.withScope(scope(), async () => {
      void runtime.run(['fixed'], runOptions()).catch(() => undefined);
      await Promise.resolve(); throw failure;
    });
    const checked = expect(pending).rejects.toThrow(failure);
    void pending.catch(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(forwarded?.signal?.aborted).toBe(true); expect(settled).toBe(false);
    await expect(runtime.withScope(scope(), async () => 'too early')).rejects.toThrow();
    finish(result()); await checked;
    expect(await runtime.withScope(scope(), async () => 'after drain'))
      .toEqual({ fixture: 'after drain', measurement: { processGroups: 0 } });
  });
});

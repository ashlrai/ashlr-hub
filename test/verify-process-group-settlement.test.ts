import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import type { spawn } from 'node:child_process';
import { runVerifySubprocessAsync, type VerifySubprocessOptions } from '../src/core/run/verify-commands.js';

const absent = (): never => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); };
function fixture(pid: number | undefined = 24_680) {
  const child = Object.assign(new EventEmitter(), {
    pid: pid as number | undefined, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn(),
  });
  const spawnFake = vi.fn(() => child);
  const processKill = vi.fn<(_: number, signal: NodeJS.Signals | 0) => void>();
  const opts: VerifySubprocessOptions = {
    cwd: '/fixture', env: {}, timeoutMs: 100,
    requireProcessGroupExit: true, _platform: 'linux',
    _spawn: spawnFake as unknown as typeof spawn, _processKill: processKill,
    _terminationGraceMs: 10, _terminationDrainMs: 10,
  };
  return { child, spawnFake, processKill, opts };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('opt-in subprocess group settlement receipt', () => {
  it.each([
    { argv: [], extra: {} },
    { argv: ['fixture'], extra: { input: 42 } },
    { argv: ['fixture'], extra: { maxOutputChars: 0 } },
    { argv: ['fixture'], extra: { _platform: 'win32' } },
  ])('reports not-started for rejected preflight %#', async ({ argv, extra }) => {
    const { opts, spawnFake, processKill } = fixture();
    const result = await runVerifySubprocessAsync(argv, { ...opts, ...extra } as VerifySubprocessOptions);
    expect(result).toMatchObject({ processGroupSettlement: 'not-started', error: expect.any(String) });
    expect(spawnFake).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
  });

  it.each([null, 'true', 1, {}])('rejects malformed opt-in value %j', async (value) => {
    const { opts, spawnFake } = fixture();
    const result = await runVerifySubprocessAsync(['fixture'], {
      ...opts, requireProcessGroupExit: value,
    } as VerifySubprocessOptions);
    expect(result.error).toBe('invalid process-group receipt option: expected a boolean');
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it('reports not-started for pre-aborted invocation', async () => {
    const { opts, spawnFake } = fixture(); const controller = new AbortController(); controller.abort();
    const result = await runVerifySubprocessAsync(['fixture'], { ...opts, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, processGroupSettlement: 'not-started' });
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it('reports not-started for synchronous spawn failure', async () => {
    const { opts, spawnFake, processKill } = fixture();
    spawnFake.mockImplementation(() => { throw new Error('spawn unavailable'); });
    expect(await runVerifySubprocessAsync(['fixture'], opts)).toMatchObject({
      error: 'spawn unavailable', processGroupSettlement: 'not-started',
    });
    expect(processKill).not.toHaveBeenCalled();
  });

  it('reports not-started for an asynchronous spawn error without a PID', async () => {
    const { opts, child, processKill } = fixture(); child.pid = undefined;
    const pending = runVerifySubprocessAsync(['fixture'], opts); child.emit('error', new Error('ENOENT'));
    expect(await pending).toMatchObject({ error: 'ENOENT', processGroupSettlement: 'not-started' });
    expect(processKill).not.toHaveBeenCalled();
  });

  it('requires ESRCH after normal close and retains captured output', async () => {
    const { opts, child, processKill } = fixture(); processKill.mockImplementation(absent);
    const pending = runVerifySubprocessAsync(['fixture'], opts);
    child.stdout.write('bounded output'); child.emit('exit', 0, null); child.emit('close', 0, null);
    expect(await pending).toMatchObject({ exitCode: 0, stdout: 'bounded output', processGroupSettlement: 'group-exit-confirmed' });
    expect(processKill.mock.calls).toEqual([[-24_680, 0]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['present', 'EPERM', 'unknown'])('refuses successful close with %s group evidence', async (state) => {
    const { opts, child, processKill } = fixture();
    processKill.mockImplementation(() => {
      if (state === 'EPERM') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      if (state === 'unknown') throw new Error('unknown');
    });
    const pending = runVerifySubprocessAsync(['fixture'], opts); child.emit('exit', 0, null); child.emit('close', 0, null);
    expect(await pending).toMatchObject({
      processGroupSettlement: 'unconfirmed', error: 'required process-group exit receipt unconfirmed',
    });
    expect(processKill).toHaveBeenCalled();
    expect(processKill.mock.calls.every(([pid, signal]) => pid === -24_680 && signal === 0)).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('observes a briefly present group after normal close without renewing signaling authority', async () => {
    vi.useFakeTimers();
    const { opts, child, processKill } = fixture(); let gone = false;
    processKill.mockImplementation(() => { if (gone) absent(); });
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, _terminationDrainMs: 60 });
    child.emit('exit', 0, null); child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(10); gone = true; await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' });
    expect(processKill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancelled', 'timeout'] as const)('cannot report normal success after %s during read-only close drain', async reason => {
    vi.useFakeTimers();
    const { opts, child, processKill } = fixture(); const controller = new AbortController(); let gone = false;
    processKill.mockImplementation(() => { if (gone) absent(); });
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, signal: controller.signal, timeoutMs: 20, _terminationDrainMs: 100 });
    child.emit('exit', 0, null); child.emit('close', 0, null);
    gone = true;
    if (reason === 'cancelled') controller.abort(); else await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ processGroupSettlement: 'group-exit-confirmed',
      timedOut: reason === 'timeout', cancelled: reason === 'cancelled' });
    expect(processKill.mock.calls.every(([, signal]) => signal === 0)).toBe(true); expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['wall', 'monotonic'] as const)('refuses absence after a stalled close budget measured by %s', async clock => {
    vi.useFakeTimers();
    const { opts, child, processKill } = fixture(); let gone = false;
    let wall = 10_000; let mono = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const settled = vi.fn();
    processKill.mockImplementation(() => { if (gone) absent(); });
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, timeoutMs: 10_000, _terminationDrainMs: 60,
      processGroupLifecycle: { prepare: () => ({ spawned() {}, settled }) } });
    child.emit('spawn'); child.emit('exit', 0, null); child.emit('close', 0, null);
    // Advance sampled clocks without running timers: the first queued poll runs
    // after the fixed drain budget, before its separately queued limit callback.
    if (clock === 'wall') wall += 61; else { mono += 61; wall -= 500; }
    gone = true; await vi.advanceTimersToNextTimerAsync();
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, processGroupSettlement: 'unconfirmed' });
    expect(processKill).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses lifecycle publication failure after a brief normal-close drain', async () => {
    vi.useFakeTimers();
    const { opts, child, processKill } = fixture(); let gone = false;
    const settled = vi.fn(() => { throw Error('fixture publication refused'); });
    processKill.mockImplementation(() => { if (gone) absent(); });
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, _terminationDrainMs: 60,
      processGroupLifecycle: { prepare: () => ({ spawned() {}, settled }) } });
    child.emit('spawn'); child.emit('exit', 0, null); child.emit('close', 0, null);
    gone = true; await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ processGroupSettlement: 'unconfirmed', error: 'process-group lifecycle publication failed' });
    expect(settled).toHaveBeenCalledExactlyOnceWith('group-exit-confirmed'); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat close without a PID as proof of no-start', async () => {
    const { opts, child, processKill } = fixture(); child.pid = undefined;
    const pending = runVerifySubprocessAsync(['fixture'], opts); child.emit('close', 0, null);
    expect(await pending).toMatchObject({ processGroupSettlement: 'unconfirmed', error: expect.any(String) });
    expect(processKill).not.toHaveBeenCalled();
  });

  it.each([true, false])('classifies valid-PID error separately from business failure (absent=%s)', async (gone) => {
    const { opts, child, processKill } = fixture(); if (gone) processKill.mockImplementation(absent);
    const pending = runVerifySubprocessAsync(['fixture'], opts); child.emit('error', new Error('process failed'));
    expect(await pending).toMatchObject({
      error: 'process failed', processGroupSettlement: gone ? 'group-exit-confirmed' : 'unconfirmed',
    });
    expect(processKill.mock.calls).toEqual([[-24_680, 0]]);
  });

  it.each(['cancelled', 'timeout'] as const)('confirms absence after %s without signaling an exited leader', async (reason) => {
    vi.useFakeTimers();
    const { opts, child, processKill } = fixture(); const controller = new AbortController(); let exited = false;
    processKill.mockImplementation((_pid, signal) => {
      if (exited && signal !== 0) throw new Error('must never signal a recycled group');
      if (signal === 0) absent();
    });
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, signal: controller.signal });
    if (reason === 'cancelled') controller.abort(); else await vi.advanceTimersByTimeAsync(100);
    exited = true; child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({
      processGroupSettlement: 'group-exit-confirmed', error: expect.stringContaining('termination authority lost:'),
    });
    expect(processKill.mock.calls).toEqual([[-24_680, reason === 'cancelled' ? 'SIGINT' : 'SIGTERM'], [-24_680, 0]]);
  });

  it('keeps settlement unconfirmed after cancellation when group identity is present', async () => {
    vi.useFakeTimers();
    const { opts, child, processKill } = fixture(); const controller = new AbortController();
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, signal: controller.signal });
    controller.abort(); child.emit('exit', null, 'SIGINT'); child.emit('close', null, 'SIGINT');
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ processGroupSettlement: 'unconfirmed', error: expect.any(String) });
    expect(processKill.mock.calls).toEqual([[-24_680, 'SIGINT'], [-24_680, 0]]);
  });

  it.each([undefined, false])('leaves legacy normal-close behavior unchanged with opt-in %s', async (value) => {
    const { opts, child, processKill } = fixture();
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, requireProcessGroupExit: value });
    child.emit('exit', 0, null); child.emit('close', 0, null);
    expect(await pending).not.toHaveProperty('processGroupSettlement');
    expect(processKill).not.toHaveBeenCalled();
  });

  it.each([null, 0, 249, 30001, 250.5, '1000', Infinity])('rejects invalid shutdown grace %j before spawn', async value => {
    const { opts, spawnFake } = fixture();
    const result = await runVerifySubprocessAsync(['fixture'], { ...opts, terminationGraceMs: value } as VerifySubprocessOptions);
    expect(result).toMatchObject({ processGroupSettlement: 'not-started', error: expect.stringContaining('termination grace') });
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it('uses the public bounded grace before escalation without changing group ownership', async () => {
    vi.useFakeTimers();
    const { opts, child, processKill } = fixture(); const controller = new AbortController();
    const pending = runVerifySubprocessAsync(['fixture'], { ...opts, timeoutMs: 10000,
      _terminationGraceMs: undefined, terminationGraceMs: 250, signal: controller.signal });
    controller.abort(); await vi.advanceTimersByTimeAsync(249);
    expect(processKill.mock.calls).toEqual([[-24680, 'SIGINT']]);
    await vi.advanceTimersByTimeAsync(1);
    expect(processKill.mock.calls).toEqual([[-24680, 'SIGINT'], [-24680, 'SIGKILL']]);
    processKill.mockImplementation(absent); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ cancelled: true, processGroupSettlement: 'group-exit-confirmed' });
  });
});

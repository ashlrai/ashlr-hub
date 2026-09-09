import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { isVerifyProcessGroupLifecycle, runVerifySubprocessAsync, type VerifySubprocessOptions } from '../src/core/run/verify-commands.js';

const absent = (): never => { throw Object.assign(new Error('absent'), { code: 'ESRCH' }); };
function fixture() {
  const events: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 24_680 as number | undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), unref: vi.fn(),
  });
  child.stdin.on('data', () => events.push('stdin'));
  const spawned = vi.fn(() => { events.push('registered'); });
  const settled = vi.fn(() => { events.push('settled'); });
  const prepare = vi.fn(() => { events.push('prepared'); return { spawned, settled }; });
  const spawnFake = vi.fn(() => { events.push('spawn'); return child; });
  const processKill = vi.fn((_: number, signal: NodeJS.Signals | 0) => { if (signal === 0) absent(); });
  const opts: VerifySubprocessOptions = { cwd: '/fixture', env: {}, timeoutMs: 100, input: 'payload',
    requireProcessGroupExit: true, processGroupLifecycle: { prepare }, _platform: 'linux',
    _spawn: spawnFake as unknown as typeof spawn, _processKill: processKill,
    _terminationGraceMs: 10, _terminationDrainMs: 10 };
  return { events, child, spawned, settled, prepare, spawnFake, processKill, opts };
}
afterEach(() => vi.useRealTimers());

describe('durable subprocess group lifecycle', () => {
  it('prepares before spawn, registers before input and settles after absence', async () => {
    const f = fixture(); const pending = runVerifySubprocessAsync(['fixture'], f.opts);
    expect(f.events).toEqual(['prepared', 'spawn']);
    f.child.emit('spawn'); expect(f.events).toEqual(['prepared', 'spawn', 'registered', 'stdin']);
    f.child.emit('close', 0, null);
    expect(await pending).toMatchObject({ processGroupSettlement: 'group-exit-confirmed' });
    expect(f.spawned).toHaveBeenCalledWith(24_680);
    expect(f.settled).toHaveBeenCalledWith('group-exit-confirmed');
    expect(f.processKill.mock.calls).toEqual([[-24_680, 0]]);
  });

  it('prepares independently for each runner call', async () => {
    const first = fixture(); const second = fixture(); second.opts.processGroupLifecycle = first.opts.processGroupLifecycle;
    const a = runVerifySubprocessAsync(['fixture'], first.opts); first.child.emit('spawn'); first.child.emit('close', 0, null); await a;
    const b = runVerifySubprocessAsync(['fixture'], second.opts); second.child.emit('spawn'); second.child.emit('close', 0, null); await b;
    expect(first.prepare).toHaveBeenCalledTimes(2); expect(first.settled).toHaveBeenCalledTimes(2);
  });

  it.each(['throw', 'async', 'malformed'])('refuses a %s prepare without spawning', async (mode) => {
    const f = fixture();
    f.opts.processGroupLifecycle = { prepare: (() => {
      if (mode === 'throw') throw new Error('private detail');
      if (mode === 'async') return Promise.reject(new Error('private detail'));
      return { spawned: f.spawned };
    }) as never };
    expect(await runVerifySubprocessAsync(['fixture'], f.opts)).toMatchObject({
      error: 'process-group lifecycle publication failed', processGroupSettlement: 'unconfirmed' });
    expect(f.spawnFake).not.toHaveBeenCalled();
  });

  it.each(['throw', 'no-pid-error'])('settles not-started after %s', async (mode) => {
    const f = fixture(); if (mode === 'throw') f.spawnFake.mockImplementation(() => { throw new Error('ENOENT'); });
    else f.child.pid = undefined;
    const pending = runVerifySubprocessAsync(['fixture'], f.opts);
    if (mode !== 'throw') f.child.emit('error', new Error('ENOENT'));
    expect(await pending).toMatchObject({ processGroupSettlement: 'not-started' });
    expect(f.settled).toHaveBeenCalledWith('not-started'); expect(f.spawned).not.toHaveBeenCalled();
  });

  it.each(['throw', 'async'])('drains after %s registration, suppressing stdin and settlement', async (mode) => {
    vi.useFakeTimers(); const f = fixture();
    f.spawned.mockImplementation((() => {
      if (mode === 'throw') throw new Error('private detail');
      return Promise.reject(new Error('private detail'));
    }) as never);
    const pending = runVerifySubprocessAsync(['fixture'], f.opts); f.child.emit('spawn');
    expect(f.events).not.toContain('stdin'); expect(f.processKill).toHaveBeenCalledWith(-24_680, 'SIGINT');
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ error: 'process-group lifecycle publication failed', processGroupSettlement: 'unconfirmed' });
    expect(f.settled).not.toHaveBeenCalled();
  });

  it.each(['not-started', 'group-exit-confirmed'])('preserves uncertainty if %s settlement publication throws', async (receipt) => {
    const f = fixture(); f.settled.mockImplementation(() => { throw new Error('private detail'); });
    if (receipt === 'not-started') f.spawnFake.mockImplementation(() => { throw new Error('ENOENT'); });
    const pending = runVerifySubprocessAsync(['fixture'], f.opts);
    if (receipt !== 'not-started') { f.child.emit('spawn'); f.child.emit('close', 0, null); }
    expect(await pending).toMatchObject({ error: 'process-group lifecycle publication failed', processGroupSettlement: 'unconfirmed' });
  });

  it('does not settle a PID whose spawn event was missing', async () => {
    const f = fixture(); const pending = runVerifySubprocessAsync(['fixture'], f.opts); f.child.emit('close', 0, null);
    expect(await pending).toMatchObject({ processGroupSettlement: 'unconfirmed' });
    expect(f.settled).not.toHaveBeenCalled(); expect(f.events).not.toContain('stdin');
  });

  it('does not clear a group still present at close', async () => {
    const f = fixture(); f.processKill.mockImplementation(() => {});
    const pending = runVerifySubprocessAsync(['fixture'], f.opts); f.child.emit('spawn'); f.child.emit('close', 0, null);
    expect(await pending).toMatchObject({ processGroupSettlement: 'unconfirmed' }); expect(f.settled).not.toHaveBeenCalled();
  });

  it('settles a cancellation arriving during prepare without spawning', async () => {
    const f = fixture(); const controller = new AbortController();
    f.prepare.mockImplementation(() => { controller.abort(); return { spawned: f.spawned, settled: f.settled }; });
    expect(await runVerifySubprocessAsync(['fixture'], { ...f.opts, signal: controller.signal })).toMatchObject({
      cancelled: true, processGroupSettlement: 'not-started' });
    expect(f.spawnFake).not.toHaveBeenCalled(); expect(f.settled).toHaveBeenCalledWith('not-started');
  });

  it('registers but never delivers input when cancellation precedes spawn event', async () => {
    vi.useFakeTimers(); const f = fixture(); const controller = new AbortController();
    const pending = runVerifySubprocessAsync(['fixture'], { ...f.opts, signal: controller.signal });
    controller.abort(); f.child.emit('spawn'); await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ cancelled: true, processGroupSettlement: 'group-exit-confirmed' });
    expect(f.spawned).toHaveBeenCalledTimes(1); expect(f.events).not.toContain('stdin');
  });

  it('settles an asynchronous no-PID spawn failure even after cancellation', async () => {
    const f = fixture(); f.child.pid = undefined; const controller = new AbortController();
    const pending = runVerifySubprocessAsync(['fixture'], { ...f.opts, signal: controller.signal });
    controller.abort(); f.child.emit('error', new Error('ENOENT'));
    expect(await pending).toMatchObject({ cancelled: true, processGroupSettlement: 'not-started' });
    expect(f.settled).toHaveBeenCalledWith('not-started'); expect(f.processKill).not.toHaveBeenCalled();
  });

  it('suppresses input if registration itself requests cancellation', async () => {
    vi.useFakeTimers(); const f = fixture(); const controller = new AbortController();
    f.spawned.mockImplementation(() => { controller.abort(); });
    const pending = runVerifySubprocessAsync(['fixture'], { ...f.opts, signal: controller.signal });
    f.child.emit('spawn'); await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ cancelled: true, processGroupSettlement: 'group-exit-confirmed' });
    expect(f.events).not.toContain('stdin'); expect(f.settled).toHaveBeenCalledWith('group-exit-confirmed');
  });

  it.each([null, {}, { prepare: 3 }, { prepare() {}, extra: true }])('rejects invalid lifecycle %j before prepare', async (value) => {
    const f = fixture(); expect(isVerifyProcessGroupLifecycle(value)).toBe(false);
    expect(await runVerifySubprocessAsync(['fixture'], { ...f.opts, processGroupLifecycle: value } as never)).toMatchObject({
      error: 'invalid process-group lifecycle option' }); expect(f.spawnFake).not.toHaveBeenCalled();
  });

  it('rejects accessors without evaluating them and requires strict receipt opt-in', async () => {
    const read = vi.fn(); const accessor = Object.defineProperty({}, 'prepare', { get: read });
    expect(isVerifyProcessGroupLifecycle(accessor)).toBe(false); expect(read).not.toHaveBeenCalled();
    const f = fixture(); expect(await runVerifySubprocessAsync(['fixture'], { ...f.opts, requireProcessGroupExit: false })).toMatchObject({
      error: 'invalid process-group lifecycle option' }); expect(f.prepare).not.toHaveBeenCalled();
  });
});

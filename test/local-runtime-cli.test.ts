import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalRuntimeInstallation, LocalRuntimeStatus } from '../src/core/local-runtime/types.js';

const core = vi.hoisted(() => ({ installLocalRuntime: vi.fn(), readLocalRuntimeStatus: vi.fn(), resolveLocalRuntime: vi.fn(), rollbackLocalRuntime: vi.fn() }));
const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/core/local-runtime/store.js', () => core);
vi.mock('node:child_process', () => childProcess);
import { cmdRuntime } from '../src/cli/runtime.js';

function installation(): LocalRuntimeInstallation {
  return { id: 'candidate', sha256: 'a'.repeat(64), integrity: `sha512-${'A'.repeat(86)}==`, size: 100,
    revision: 'b'.repeat(40), version: '3.4.0', installedAt: '2026-09-07T01:00:00.000Z', manifestDigest: 'c'.repeat(64),
    nodePath: '/private/fixture/node', nodeVersion: '24.18.0', nodeSha256: 'd'.repeat(64),
    packageRoot: '/private/fixture/store/installations/candidate/package', binPath: '/private/fixture/store/installations/candidate/package/bin/ashlr' };
}
function status(sourceState: LocalRuntimeStatus['sourceState'] = 'healthy'): LocalRuntimeStatus {
  return { schemaVersion: 1, authority: 'local-candidate', store: '/private/fixture/store', sourceState,
    current: sourceState === 'missing' ? null : installation(), previous: null, reasons: sourceState === 'degraded' ? ['previous installation unavailable'] : [] };
}
function child(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
}
const installArgs = ['install', '--store', '/private/fixture/store', '--artifact', '/private/fixture/package.tgz',
  '--sha256', 'a'.repeat(64), '--revision', 'b'.repeat(40), '--version', '3.4.0'];
const runArgs = ['run', '--store', '/private/fixture/store', '--', 'universe', 'status', '--root', '/private/fixture/universe'];

describe('local runtime CLI', () => {
  let output: ReturnType<typeof vi.spyOn>; let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    core.installLocalRuntime.mockResolvedValue(status()); core.readLocalRuntimeStatus.mockReturnValue(status());
    core.rollbackLocalRuntime.mockReturnValue(status()); core.resolveLocalRuntime.mockReturnValue(installation());
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([
    ['unknown'], ['status'], ['status', '/private/fixture/store'], ['status', '--store'], ['status', '--store', 'relative'],
    ['status', '--store', '/private/x\n'], ['status', '--store', '/private/x\u0085'], ['status', '--store', '/private/x\0'],
    ['status', '--store', '/private/x', '--store', '/private/y'], ['status', '--store=/private/x'],
    ['status', '--store', '/private/x', '--unknown'], ['status', '--store', '/private/x', '--json', '--json'],
    ['status', '--store', '/private/x', '--artifact', '/private/y'], ['status', '--store', '/private/x', '--', 'universe', 'help'],
    ['help', '--store', '/private/x'], ['--help', '--json'], ['rollback'],
    ['install', '--store', '/private/x'], ['install', '--store', '/private/x', '--artifact', 'relative'],
    [...installArgs, '--sha256', 'a'.repeat(64)], [...installArgs, '--unknown'], [...installArgs, 'extra'],
    [...installArgs.slice(0, 5), '--sha256', 'A'.repeat(64), '--revision', 'b'.repeat(40), '--version', '3.4.0'],
    [...installArgs.slice(0, 5), '--sha256', 'a'.repeat(63), '--revision', 'b'.repeat(40), '--version', '3.4.0'],
    [...installArgs.slice(0, 7), '--revision', 'b'.repeat(39), '--version', '3.4.0'],
    [...installArgs.slice(0, 9), '--version', 'x'.repeat(129)],
    ['run', '--store', '/private/x'], ['run', '--store', '/private/x', '--'],
    ['run', '--store', '/private/x', '--', 'serve', '--root', '/private/u'],
    ['run', '--store', '/private/x', '--', 'update', '--root', '/private/u'],
    ['run', '--store', '/private/x', '--', 'runtime', 'status', '--root', '/private/u'],
    ['run', '--store', '/private/x', '--', 'universe', 'status'],
    ['run', '--store', '/private/x', '--', 'universe', 'status', '--root'],
    ['run', '--store', '/private/x', '--', 'universe', 'status', '--root', 'relative'],
    ['run', '--store', '/private/x', '--', 'universe', 'status', '--root', '/private/a', '--root', '/private/b'],
    ['run', '--store', '/private/x', '--', 'universe', 'status', '--', '--root', '/private/a'],
    ['run', '--store', '/private/x', '--', 'universe', 'status', '--root=/private/a'],
    ['run', '--store', '/private/x', '--', 'universe', 'status', '--help', '--root', '/private/a'],
    ['run', '--store', '/private/x', '--', 'universe', 'help', '--root', '/private/a'],
    ['run', '--store', '/private/x', '--', 'universe', 'campaign', 'help', '--unknown'],
    ['run', '--store', '/private/x', '--', 'universe', 'status', '--root', '/private/a\n'],
    ['run', '--store', '/private/x', '--', 'universe', 'console'],
    ['run', '--store', '/private/x', '--', 'universe', 'console', '--root', 'relative'],
    ['run', '--store', '/private/x', '--', 'universe', 'console', '--help', '--root', '/private/u'],
  ])('rejects invalid arguments %j before reads, writes, or launch', async (...args) => {
    expect(await cmdRuntime(args)).toBe(2);
    for (const fn of Object.values(core)) expect(fn).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each([[], ['help'], ['--help'], ['install', '--help'], ['run', '-h']])('prints safe help for %j without store access', async (...args) => {
    expect(await cmdRuntime(args)).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('not production qualification');
    expect(output.mock.calls[0]![0]).toContain('128 + signal number');
    for (const fn of Object.values(core)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes only explicit exact installation pins and returns the exact SDK status', async () => {
    expect(await cmdRuntime([...installArgs, '--json'])).toBe(0);
    expect(core.installLocalRuntime).toHaveBeenCalledWith({ store: '/private/fixture/store', artifactPath: '/private/fixture/package.tgz',
      sha256: 'a'.repeat(64), revision: 'b'.repeat(40), version: '3.4.0' });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(status());
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each(['missing', 'degraded'] as const)('returns exact %s status and exit1', async (state) => {
    core.readLocalRuntimeStatus.mockReturnValue(status(state));
    expect(await cmdRuntime(['status', '--store', '/private/fixture/store', '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(status(state));
  });

  it('distinguishes a verified current installation from degraded previous evidence', async () => {
    core.readLocalRuntimeStatus.mockReturnValue(status('degraded'));
    expect(await cmdRuntime(['status', '--store', '/private/fixture/store'])).toBe(1);
    expect(output.mock.calls[0]![0]).toContain('Current verified candidate: 3.4.0');
    expect(output.mock.calls[0]![0]).not.toContain('unverified');
    expect(output.mock.calls[0]![0]).toContain('not production qualification');
  });

  it('rollback is explicit and returns the store result without launching a process', async () => {
    expect(await cmdRuntime(['rollback', '--store', '/private/fixture/store', '--json'])).toBe(0);
    expect(core.rollbackLocalRuntime).toHaveBeenCalledWith('/private/fixture/store');
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(status());
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('redacts raw failure details without touching an alternative runtime', async () => {
    core.resolveLocalRuntime.mockImplementation(() => { throw new Error('private path and credential-shaped secret'); });
    expect(await cmdRuntime(runArgs)).toBe(1);
    expect(errors.mock.calls[0]![0]).toBe('runtime: Local runtime unavailable or operation failed');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('returns JSON usage errors without leaking raw arguments', async () => {
    expect(await cmdRuntime(['status', '--secret-value', 'private-sensitive-text', '--json'])).toBe(2);
    const value = JSON.parse(output.mock.calls[0]![0] as string);
    expect(value.error).toBe('Unknown or duplicate runtime option'); expect(errors).not.toHaveBeenCalled();
  });

  it('pins one selected executable/interpreter and strips Node injection variables only in the child', async () => {
    vi.stubEnv('NODE_OPTIONS', '--trace-deprecation'); vi.stubEnv('NODE_PATH', '/private/fixture/preload');
    const existingHome = process.env.HOME; const selected = installation(); const handle = child();
    childProcess.spawn.mockReturnValue(handle);
    const running = cmdRuntime([...runArgs, '--json']);
    core.resolveLocalRuntime.mockReturnValue({ ...selected, id: 'new-selection', nodePath: '/other/node' });
    expect(core.resolveLocalRuntime).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(selected.nodePath, [selected.binPath, 'universe', 'status', '--root', '/private/fixture/universe', '--json'],
      expect.objectContaining({ cwd: process.cwd(), stdio: 'inherit', shell: false }));
    const env = childProcess.spawn.mock.calls[0]![2].env as NodeJS.ProcessEnv;
    expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.NODE_PATH).toBeUndefined(); expect(env.HOME).toBe(existingHome);
    expect(process.env.NODE_OPTIONS).toBe('--trace-deprecation'); expect(process.env.NODE_PATH).toBe('/private/fixture/preload');
    handle.emit('close', 7, null); expect(await running).toBe(7); expect(output).not.toHaveBeenCalled();
  });

  it.each([['help'], ['--help'], ['status', '--help'], ['campaign', 'help'], ['portfolio', '--help'], ['console', '--help'], ['console', '-h'],
    ['controller', '--help'], ['controller', '-h'], ['controller', 'help'], ['integration', '--help'], ['integration', '-h'], ['integration', 'help'],
    ['resources', '--help'], ['resources', '-h'], ['campaign', 'supervise', '--help'], ['campaign', 'supervise', '-h'],
    ['campaign', 'check', '--help'], ['campaign', 'check', '-h'],
  ])('forwards unambiguous Universe help %j without a default root', async (...args) => {
    const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const running = cmdRuntime(['run', '--store', '/private/fixture/store', '--', 'universe', ...args]);
    handle.emit('close', 0, null); expect(await running).toBe(0);
    expect(childProcess.spawn.mock.calls[0]![1]).toEqual([installation().binPath, 'universe', ...args]);
  });

  it.each([
    ['--resource-runtime', '/private/fixture/runtime.json'],
    ['--resource-runtime', '/private/fixture/runtime.json', '--json'],
    ['--json', '--resource-runtime', "/private/fixture owner's/runtime.json"],
  ])('forwards exact rootless read-only resource check options %j through the verified runtime', async (...options) => {
    const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const forwarded = ['universe', 'resources', 'check', ...options];
    const running = cmdRuntime(['run', '--store', '/private/fixture/store', '--', ...forwarded]);
    expect(core.resolveLocalRuntime).toHaveBeenCalledExactlyOnceWith('/private/fixture/store');
    expect(childProcess.spawn).toHaveBeenCalledWith(installation().nodePath, [installation().binPath, ...forwarded],
      expect.objectContaining({ stdio: 'inherit', shell: false }));
    handle.emit('close', 1, null); expect(await running).toBe(1);
    expect(output).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
    expect(core.installLocalRuntime).not.toHaveBeenCalled(); expect(core.rollbackLocalRuntime).not.toHaveBeenCalled();
  });

  it.each([
    [], ['--json'], ['--resource-runtime'], ['--resource-runtime', 'relative'], ['--resource-runtime', '/'],
    ['--resource-runtime', '/private/../runtime.json'], ['--resource-runtime', '/private//runtime.json'],
    ['--resource-runtime', '/private/runtime.json/'], ['--resource-runtime', `/private/${'é'.repeat(2050)}`],
    ['--resource-runtime', '/private/runtime.json', '--resource-runtime', '/private/other.json'],
    ['--resource-runtime', '/private/runtime.json', '--json', '--json'],
    ['--resource-runtime', '/private/runtime.json', '--root', '/private/universe'],
    ['--root', '/private/universe', '--resource-runtime', '/private/runtime.json'],
    ['--resource-runtime', '/private/runtime.json', '--help'], ['--help'], ['help'],
    ['--resource-runtime', '/private/runtime.json', '--unknown'], ['--resource-runtime=/private/runtime.json'],
    ['--resource-runtime', '/private/runtime.json', 'run'], ['--resource-runtime', '--json'],
    ['--resource-runtime', '/private/runtime.json', '--', 'help'],
  ])('rejects ambiguous rootless resource-check options %j before resolution', async (...options) => {
    expect(await cmdRuntime(['run', '--store', '/private/fixture/store', '--', 'universe', 'resources', 'check', ...options])).toBe(2);
    for (const fn of Object.values(core)) expect(fn).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['controller', '--help', '--root', '/private/universe'], ['controller', 'help', '--root', '/private/universe'],
    ['integration', 'help', '--root', '/private/universe'], ['resources', '--help', '--resource-runtime', '/private/runtime.json'],
    ['resources', 'check', '--help'], ['resources', 'help'],
    ['campaign', 'supervise', '--help', '--root', '/private/universe'], ['campaign', 'check', '--help', '--json'],
    ['campaign', 'check', 'help'], ['campaign', 'supervise', 'help'],
    ['controller', 'run', '--manifest', '/private/portfolio.json'],
    ['campaign', 'supervise', 'task-a', '--max-duration-ms', '1000'],
    ['resources', 'run', '--resource-runtime', '/private/runtime.json'],
  ])('keeps mixed help and rootless execution outside the exception %j', async (...forwarded) => {
    expect(await cmdRuntime(['run', '--store', '/private/fixture/store', '--', 'universe', ...forwarded])).toBe(2);
    for (const fn of Object.values(core)) expect(fn).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('forwards the explicit console root and port to one verified foreground runtime', async () => {
    const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const forwarded = ['universe', 'console', '--root', '/private/fixture/universe', '--port', '0', '--json'];
    const running = cmdRuntime(['run', '--store', '/private/fixture/store', '--', ...forwarded]);
    expect(core.resolveLocalRuntime).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(installation().nodePath, [installation().binPath, ...forwarded],
      expect.objectContaining({ stdio: 'inherit', shell: false }));
    handle.emit('close', 0, null); expect(await running).toBe(0); expect(output).not.toHaveBeenCalled();
  });

  it('forwards a portfolio runtime binding unchanged to the verified child only', async () => {
    const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const forwarded = ['universe', 'portfolio', 'run', '--manifest', '/private/fixture/portfolio.json',
      '--root', '/private/fixture/universe', '--resource-runtime', "/private/fixture owner's/runtime.json", '--json'];
    const running = cmdRuntime(['run', '--store', '/private/fixture/store', '--', ...forwarded]);
    expect(core.resolveLocalRuntime).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(installation().nodePath, [installation().binPath, ...forwarded],
      expect.objectContaining({ stdio: 'inherit', shell: false }));
    handle.emit('close', 0, null); expect(await running).toBe(0);
    expect(output).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  });

  it('does not confuse a valid universe named help with a help flag', async () => {
    const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const running = cmdRuntime(['run', '--store', '/private/fixture/store', '--', 'universe', 'run', 'help', '--root', '/private/fixture/universe']);
    handle.emit('close', 0, null); expect(await running).toBe(0);
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143], ['SIGKILL', 137]] as const)('propagates child %s as shell exit %s', async (signal, expected) => {
    const handle = child(); childProcess.spawn.mockReturnValue(handle); const running = cmdRuntime(runArgs);
    handle.emit('close', null, signal); expect(await running).toBe(expected);
  });

  it('forwards cancellation, waits five seconds, and escalates only the exact child', async () => {
    vi.useFakeTimers(); const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    const running = cmdRuntime(runArgs);
    const interrupt = process.listeners('SIGINT').find((listener) => !beforeInt.includes(listener))!;
    interrupt(); expect(handle.kill).toHaveBeenCalledWith('SIGINT');
    await vi.advanceTimersByTimeAsync(4_999); expect(handle.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(handle.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGKILL']);
    handle.emit('exit', null, 'SIGKILL'); handle.emit('close', null, 'SIGKILL'); expect(await running).toBe(137);
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a repeated interrupt escalates; leader exit cancels any delayed signal', async () => {
    vi.useFakeTimers(); const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const before = process.listeners('SIGTERM'); const running = cmdRuntime(runArgs);
    const terminate = process.listeners('SIGTERM').find((listener) => !before.includes(listener))!;
    terminate(); terminate(); expect(handle.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    handle.emit('exit', 1, null); await vi.advanceTimersByTimeAsync(10_000);
    expect(handle.kill).toHaveBeenCalledTimes(2); handle.emit('close', 1, null); expect(await running).toBe(1);
    expect(process.listeners('SIGTERM')).toEqual(before);
  });

  it('spawn failure returns1 and removes signal handlers and escalation timers', async () => {
    vi.useFakeTimers(); const handle = child(); childProcess.spawn.mockReturnValue(handle);
    const before = process.listeners('SIGINT'); const running = cmdRuntime(runArgs);
    const interrupt = process.listeners('SIGINT').find((listener) => !before.includes(listener))!; interrupt();
    handle.emit('error', new Error('sensitive spawn path')); expect(await running).toBe(1);
    expect(vi.getTimerCount()).toBe(0); expect(process.listeners('SIGINT')).toEqual(before);
    expect(errors.mock.calls[0]![0]).not.toContain('sensitive');
  });
});

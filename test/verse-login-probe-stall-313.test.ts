/**
 * 3.13 sidecar startup stall: the login-shell PATH probe (core/verse/login-path.ts)
 * must resolve — as a fallback — within its timeout whatever the operator's
 * startup files do, and must never share a process group (or a terminal)
 * with the sidecar.
 *
 * Two layers:
 *   - a FAKE child (no process at all) that never exits and holds stdout open,
 *     driven with fake timers: the contract, deterministic;
 *   - a few REAL /bin/sh children (POSIX only, each bounded to well under a
 *     second) proving the kill reaches a grandchild that holds the pipe.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createShellRunner,
  LOGIN_SHELL_EXIT_GRACE_MS,
  probeLoginPath,
} from '../src/core/verse/login-path.js';

const MARK = (p: string) => `__VERSE_LOGIN_PATH_BEGIN__${p}__VERSE_LOGIN_PATH_END__`;

/** A child that behaves like a hung interactive shell: never exits, never closes stdout. */
function fakeHungChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess> & { killedWith: string[] };
  const stdout = new PassThrough();
  Object.assign(child, { pid, stdout, stdin: null, stderr: null, killedWith: [] as string[] });
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killedWith.push(String(signal));
    // A hung child whose stdout is ALSO held by a grandchild: even a kill
    // produces no 'close'. (No 'exit' either — the worst case.)
    return true;
  }) as ChildProcess['kill'];
  return { child: child as unknown as ChildProcess & { killedWith: string[] }, stdout };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createShellRunner — the probe can never outlive its timeout', () => {
  it('resolves timedOut within the timeout when the child never exits and holds stdout open', async () => {
    vi.useFakeTimers();
    const { child, stdout } = fakeHungChild();
    const spawned: Array<{ file: string; args: string[]; opts: SpawnOptions }> = [];
    const groups: number[] = [];
    const run = createShellRunner({
      platform: 'darwin',
      spawn: (file, args, opts) => { spawned.push({ file, args, opts }); return child; },
      killGroup: (pid) => groups.push(pid),
    });

    let done = false;
    const pending = run('/bin/zsh', ['-l', '-i', '-c', 'x'], { timeoutMs: 3_000, env: { HOME: '/h' } })
      .then((r) => { done = true; return r; });
    stdout.write('Last login: banner\n');

    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toEqual({ stdout: 'Last login: banner\n', code: null, timedOut: true });
    // The WHOLE group is killed (the shell and whatever its startup files forked) …
    expect(groups).toEqual([4242]);
    expect(child.killedWith).toContain('SIGKILL');
    // … and the probe ran in its own session, with no stdin and no stderr pipe.
    expect(spawned[0]!.opts).toMatchObject({ detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: '/h' } });
  });

  it('probeLoginPath falls back (never hangs) behind a hung shell', async () => {
    vi.useFakeTimers();
    const { child } = fakeHungChild();
    const run = createShellRunner({ platform: 'darwin', spawn: () => child, killGroup: () => {} });
    const pending = probeLoginPath({
      runShell: run,
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      home: '/Users/op',
      isDirectory: () => false,
      platform: 'darwin',
      timeoutMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;
    expect(result.source).toBe('fallback');
    expect(result.fallbackReason).toBe('login shell timed out after 3000 ms');
    expect(result.entries).toEqual(['/usr/bin', '/bin']);
  });

  it('reads the answer and resolves after a short grace when the shell exits but a background job keeps stdout open', async () => {
    vi.useFakeTimers();
    const { child, stdout } = fakeHungChild(777);
    const groups: number[] = [];
    const run = createShellRunner({ platform: 'darwin', spawn: () => child, killGroup: (pid) => groups.push(pid) });
    const pending = run('/bin/zsh', [], { timeoutMs: 3_000, env: {} });
    stdout.write(MARK('/opt/homebrew/bin:/usr/bin'));
    await vi.advanceTimersByTimeAsync(10);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(LOGIN_SHELL_EXIT_GRACE_MS);
    const result = await pending;
    expect(result).toEqual({ stdout: MARK('/opt/homebrew/bin:/usr/bin'), code: 0, timedOut: false });
    expect(groups).toEqual([777]);
  });

  it('resolves as a spawn failure (never throws, never hangs) when the shell cannot start', async () => {
    const run = createShellRunner({ platform: 'darwin', spawn: () => { throw new Error('EAGAIN'); } });
    await expect(run('/bin/zsh', [], { timeoutMs: 3_000, env: {} })).resolves.toEqual({ stdout: '', code: null, timedOut: false });

    const { child } = fakeHungChild();
    const run2 = createShellRunner({ platform: 'darwin', spawn: () => child, killGroup: () => {} });
    const pending = run2('/nope', [], { timeoutMs: 3_000, env: {} });
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(pending).resolves.toEqual({ stdout: '', code: null, timedOut: false });
  });

  it('caps what it keeps from stdout but keeps draining it', async () => {
    const { child, stdout } = fakeHungChild();
    const run = createShellRunner({ platform: 'darwin', spawn: () => child, killGroup: () => {} });
    const pending = run('/bin/zsh', [], { timeoutMs: 3_000, env: {} });
    const big = Buffer.alloc(700 * 1024, 0x61);
    stdout.write(big);
    stdout.write(big);
    await new Promise((r) => setImmediate(r));
    child.emit('close', 0, null);
    const result = await pending;
    expect(result.stdout.length).toBe(1024 * 1024);
  });
});

describe.skipIf(process.platform === 'win32')('createShellRunner — real processes', () => {
  const run = createShellRunner();

  function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  it('kills a grandchild that holds stdout when the shell times out', async () => {
    const started = Date.now();
    // The shell prints its pid and its background job's pid, then hangs.
    const result = await run('/bin/sh', ['-c', 'sleep 30 & echo "$$ $!"; wait'], { timeoutMs: 400, env: { PATH: '/usr/bin:/bin' } });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    const [shellPid, jobPid] = result.stdout.trim().split(/\s+/).map(Number);
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(shellPid!)).toBe(false);
    expect(alive(jobPid!)).toBe(false);
  });

  it('answers promptly when the shell exits but leaves a job holding stdout', async () => {
    const started = Date.now();
    const result = await run('/bin/sh', ['-c', `printf '%s' '${MARK('/usr/bin')}'; sleep 30 & echo " $!"; exit 3`], { timeoutMs: 5_000, env: { PATH: '/usr/bin:/bin' } });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain(MARK('/usr/bin'));
    expect(Date.now() - started).toBeLessThan(2_000);
    const jobPid = Number(result.stdout.trim().split(/\s+/).pop());
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(jobPid)).toBe(false);
  });

  it('runs in its own session with no stdin: a startup file reading stdin gets EOF, not a hang', async () => {
    const result = await run('/bin/sh', ['-c', 'read line; echo "read=$? sid=$(ps -o sess= -p $$ 2>/dev/null | tr -d \' \') pid=$$ pgid=$(ps -o pgid= -p $$ | tr -d \' \')"'], { timeoutMs: 3_000, env: { PATH: '/usr/bin:/bin' } });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toMatch(/read=1/);
    const pid = /pid=(\d+)/.exec(result.stdout)?.[1];
    const pgid = /pgid=(\d+)/.exec(result.stdout)?.[1];
    // Group leader of its own group — not the test runner's group.
    expect(pgid).toBe(pid);
  });
});

/** Native, inert task-worker process fixtures: no provider, account, or service access. */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';

let fixtureRoot: string;
const maxInputBytes = 1024 * 1024;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'ashlr-resource-worker-process-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function options() {
  return { cwd: fixtureRoot, env: {}, timeoutMs: 5_000 };
}

function observingSpawn() {
  let child: ChildProcess | undefined;
  const invoke = vi.fn((command: string, args: readonly string[], opts: SpawnOptions) => {
    child = spawn(command, args, opts);
    return child;
  });
  return { invoke: invoke as unknown as typeof spawn, calls: invoke, child: () => child };
}

describe('resource worker bounded stdin', () => {
  it('sends exact task bytes on stdin without appending them to argv', async () => {
    const input = 'PRIVATE_TASK_TEXT\nquotes: " \' $() `text`\nUnicode: café 🪐\u0000tail';
    const script = [
      'const chunks=[];',
      'process.stdin.on("data",chunk=>chunks.push(chunk));',
      'process.stdin.on("end",()=>process.stdout.write(JSON.stringify({',
      'input:Buffer.concat(chunks).toString("base64"),argv:process.argv.slice(1)})));',
    ].join('');
    const observed = observingSpawn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', script, 'visible-argument'], {
      ...options(), input, _spawn: observed.invoke,
    });

    expect(result).toEqual({
      stdout: JSON.stringify({ input: Buffer.from(input).toString('base64'), argv: ['visible-argument'] }),
      stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false,
    });
    expect(observed.calls.mock.calls[0]?.[1]).toEqual(['-e', script, 'visible-argument']);
    expect(observed.calls.mock.calls[0]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    expect(observed.child()?.stdin?.closed).toBe(true);
    expect(observed.child()?.stdin?.listenerCount('error')).toBe(0);
    expect(observed.child()?.stdin?.listenerCount('close')).toBe(0);
  });

  it('preserves ignored stdin and the exact result shape when input is absent', async () => {
    const observed = observingSpawn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', 'process.stdout.write("unchanged")'], {
      ...options(), _spawn: observed.invoke,
    });
    expect(observed.calls.mock.calls[0]?.[2].stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(observed.child()?.stdin).toBeNull();
    expect(result).toEqual({ stdout: 'unchanged', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false });
  });

  it('pipes an explicitly empty string and closes stdin for EOF-dependent workers', async () => {
    const observed = observingSpawn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e',
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("EOF"));'], {
      ...options(), input: '', _spawn: observed.invoke,
    });
    expect(observed.calls.mock.calls[0]?.[2].stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(result).toMatchObject({ stdout: 'EOF', exitCode: 0 });
    expect(result.error).toBeUndefined();
  });

  it('delivers the exact 1 MiB inclusive bound without losing backpressured bytes', async () => {
    const input = 'x'.repeat(maxInputBytes);
    const script = [
      'const hash=require("node:crypto").createHash("sha256");let bytes=0;',
      'process.stdin.on("data",chunk=>{bytes+=chunk.length;hash.update(chunk);});',
      'process.stdin.on("end",()=>process.stdout.write(JSON.stringify({bytes,digest:hash.digest("hex")})));',
    ].join('');
    const result = await runVerifySubprocessAsync([process.execPath, '-e', script], { ...options(), input });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({ bytes: maxInputBytes, digest: createHash('sha256').update(input).digest('hex') });
  });

  it.each([
    ['ASCII', 'x'.repeat(maxInputBytes + 1)],
    ['multibyte UTF-8', '🪐'.repeat(maxInputBytes / 4 + 1)],
  ])('refuses oversized %s input before spawning', async (_label, input) => {
    const spawnFake = vi.fn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', 'process.exit(0)'], {
      ...options(), input, _spawn: spawnFake as unknown as typeof spawn,
    });
    expect(result).toMatchObject({ exitCode: -1, error: 'invalid stdin: expected a UTF-8 string of at most 1 MiB' });
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it('refuses non-string runtime input without spawning or echoing it', async () => {
    const spawnFake = vi.fn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', 'process.exit(0)'], {
      ...options(), input: { private: 'not-a-string' } as unknown as string,
      _spawn: spawnFake as unknown as typeof spawn,
    });
    expect(result.error).toBe('invalid stdin: expected a UTF-8 string of at most 1 MiB');
    expect(JSON.stringify(result)).not.toContain('not-a-string');
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it('does not spawn or deliver input when the owner already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnFake = vi.fn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', 'process.exit(0)'], {
      ...options(), input: 'UNDELIVERED_TASK', signal: controller.signal,
      _spawn: spawnFake as unknown as typeof spawn,
    });
    expect(result).toMatchObject({ cancelled: true, timedOut: false, exitCode: -1 });
    expect(JSON.stringify(result)).not.toContain('UNDELIVERED_TASK');
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it('captures early input-pipe closure without an uncaught EPIPE or false success', async () => {
    const observed = observingSpawn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e',
      'require("node:fs").closeSync(0);setTimeout(()=>process.stdout.write("worker-closed-input"),25);'], {
      ...options(), input: 'x'.repeat(maxInputBytes), _spawn: observed.invoke,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('worker-closed-input');
    expect(result.error).toBe('subprocess stdin delivery failed');
    expect(observed.child()?.stdin?.closed).toBe(true);
    expect(observed.child()?.stdin?.listenerCount('error')).toBe(0);
    expect(observed.child()?.stdin?.listenerCount('close')).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('retains bounded timeout and owned-process teardown with supplied input', async () => {
    const script = [
      'process.on("SIGTERM",()=>{});',
      'process.stdin.resume();',
      'process.stdin.on("end",()=>console.log("input-delivered:"+process.pid));',
      'setInterval(()=>{},1000);',
    ].join('');
    const result = await runVerifySubprocessAsync([process.execPath, '-e', script], {
      ...options(), input: 'bounded task', timeoutMs: 1_000,
      _terminationGraceMs: 50, _terminationDrainMs: 150,
    });
    expect(result).toMatchObject({ timedOut: true, cancelled: false, exitCode: 124, signal: 'SIGKILL' });
    expect(result.error).toBeUndefined();
    const pid = Number(result.stdout.match(/input-delivered:(\d+)/)?.[1]);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('resource worker capture completeness', () => {
  it('supports an explicit larger bounded capture without truncating complete worker events', async () => {
    const output = 'x'.repeat(100_000);
    const result = await runVerifySubprocessAsync([process.execPath, '-e', 'process.stdout.write("x".repeat(100000));'], {
      ...options(), maxOutputChars: 1024 * 1024,
    });
    expect(result.stdout).toBe(output);
    expect(result).not.toHaveProperty('outputTruncated');
  });

  it.each([1, 32, 100, 1024 * 1024])('honors an explicit %i character ceiling, including marker overhead', async (limit) => {
    const result = await runVerifySubprocessAsync([process.execPath, '-e', `process.stdout.write("x".repeat(${limit + 1}));`], {
      ...options(), maxOutputChars: limit,
    });
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(limit);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 1024 * 1024 + 1])('rejects invalid capture ceiling %s before spawn', async (limit) => {
    const spawnFake = vi.fn();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', 'process.exit(0)'], {
      ...options(), maxOutputChars: limit, _spawn: spawnFake as unknown as typeof spawn,
    });
    expect(result.error).toContain('invalid output capture');
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it.each(['stdout', 'stderr'] as const)('marks actual %s truncation while keeping existing bounded text', async (stream) => {
    const result = await runVerifySubprocessAsync([process.execPath, '-e',
      `process.${stream}.write("HEAD\\n"+"x".repeat(100000)+"\\nTAIL");`], options());
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result[stream]).toContain('[ashlr: verify output stream truncated]');
    expect(result[stream]).toMatch(/^HEAD\n/);
    expect(result[stream]).toMatch(/\nTAIL$/);
    expect(result[stream].length).toBeLessThan(28 * 1024);
  });

  it('does not infer truncation from text resembling the truncation marker', async () => {
    const result = await runVerifySubprocessAsync([process.execPath, '-e',
      'process.stdout.write("[ashlr: verify output stream truncated]");'], options());
    expect(result.exitCode).toBe(0);
    expect(result).not.toHaveProperty('outputTruncated');
  });
});

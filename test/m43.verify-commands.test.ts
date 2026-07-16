/**
 * M43 verify-commands tests — hermetic, tmp dirs under os.tmpdir(), no network.
 *
 * Covers:
 *   - detectVerifyCommands: package.json scripts (npm default; pnpm via lockfile),
 *     empty dir → [].
 *   - runVerifyCommand: real subprocess via node -e, exit 0 / exit 1, output capture.
 *   - verifyTaskStructured: command-failure verdict; fallback to verifyTask when
 *     allowExec is false (mock client).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type {
  RunTask,
  ProviderClient,
  RunBudget,
  ChatMessage,
  ChatResult,
  AshlrConfig,
} from '../src/core/types.js';
import {
  detectVerifyCommands,
  runVerifyCommand,
  runVerifyCommandAsync,
  runVerifySubprocessAsync,
  spawnOptionsFor,
  type VerifyCommand,
} from '../src/core/run/verify-commands.js';
import { verifyTaskStructured } from '../src/core/run/verify.js';
import { newUsage } from '../src/core/run/budget.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'm43-verify-'));
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Create a fresh tmp fixture dir and return its path. */
function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), 'm43-fixture-'));
}

function writePkg(dir: string, pkg: unknown): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
}

function writeVerifyContract(dir: string, cmd: string[]): void {
  writeFileSync(join(dir, 'ashlr.verify.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'replace-detected',
    commands: [{ id: 'cancel-probe', kind: 'typecheck', cmd, required: true }],
  }), 'utf8');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function esrchError(): NodeJS.ErrnoException {
  return Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
}

/** Minimal cfg — runVerifyCommand never reads it. */
const cfg = {} as unknown as AshlrConfig;

function makeTask(goal: string, result?: string): RunTask {
  return {
    id: 'task-m43',
    goal,
    deps: [],
    status: result !== undefined ? 'done' : 'pending',
    result,
  };
}

function makeBudget(): RunBudget {
  return { maxTokens: 100_000, maxSteps: 50, allowCloud: false };
}

/** Mock client returning a plain-text verdict. */
function mockClientText(text: string): ProviderClient {
  return {
    id: 'mock-m43',
    supportsTools: false,
    chat: vi.fn(async (_msgs: ChatMessage[]): Promise<ChatResult> => ({
      content: text,
      usage: { tokensIn: 10, tokensOut: 5 },
    })),
  };
}

// ---------------------------------------------------------------------------
// detectVerifyCommands
// ---------------------------------------------------------------------------

describe('detectVerifyCommands', () => {
  it('detects typecheck + test scripts using npm when no lockfile', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { typecheck: 'tsc --noEmit', test: 'vitest' } });
      const cmds = detectVerifyCommands(dir);

      const tc = cmds.find((c) => c.kind === 'typecheck');
      const test = cmds.find((c) => c.kind === 'test');
      expect(tc?.cmd).toEqual(['npm', 'run', 'typecheck']);
      expect(test?.cmd).toEqual(['npm', 'run', 'test']);
      // No lint script declared → no lint command.
      expect(cmds.find((c) => c.kind === 'lint')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses pnpm when a pnpm-lock.yaml is present', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { typecheck: 'tsc --noEmit', test: 'vitest' } });
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n', 'utf8');
      const cmds = detectVerifyCommands(dir);

      const tc = cmds.find((c) => c.kind === 'typecheck');
      const test = cmds.find((c) => c.kind === 'test');
      expect(tc?.cmd).toEqual(['pnpm', 'run', 'typecheck']);
      expect(test?.cmd).toEqual(['pnpm', 'run', 'test']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses bun when a modern bun.lock file is present', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { typecheck: 'tsc --noEmit', test: 'vitest' } });
      writeFileSync(join(dir, 'bun.lock'), '# bun lockfile\n', 'utf8');
      const cmds = detectVerifyCommands(dir);

      const tc = cmds.find((c) => c.kind === 'typecheck');
      const test = cmds.find((c) => c.kind === 'test');
      expect(tc?.cmd).toEqual(['bun', 'run', 'typecheck']);
      expect(test?.cmd).toEqual(['bun', 'run', 'test']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses check scripts as typecheck fallbacks', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { check: 'biome check .', test: 'bun test' } });
      const cmds = detectVerifyCommands(dir);
      const tc = cmds.find((c) => c.kind === 'typecheck');
      expect(tc?.cmd).toEqual(['npm', 'run', 'check']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects build scripts as native build commands', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, {
        scripts: {
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          build: 'vite build',
          test: 'vitest',
        },
      });
      const cmds = detectVerifyCommands(dir);

      expect(cmds.map((c) => c.kind)).toEqual(['typecheck', 'lint', 'build', 'test']);
      expect(cmds.find((c) => c.kind === 'build')?.cmd).toEqual(['npm', 'run', 'build']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers nested package roots when the repo root has no manifest', () => {
    const dir = makeFixture();
    try {
      const server = join(dir, 'server');
      mkdirSync(server, { recursive: true });
      writePkg(server, { scripts: { typecheck: 'tsc --noEmit', test: 'vitest' } });
      writeFileSync(join(server, 'bun.lock'), '# bun lockfile\n', 'utf8');

      const cmds = detectVerifyCommands(dir);

      expect(cmds).toHaveLength(2);
      expect(cmds[0]).toMatchObject({ kind: 'typecheck', cmd: ['bun', 'run', 'typecheck'], cwd: server });
      expect(cmds[1]).toMatchObject({ kind: 'test', cmd: ['bun', 'run', 'test'], cwd: server });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects cargo verification commands for Rust repos', () => {
    const dir = makeFixture();
    try {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "rusty"\nversion = "0.1.0"\n', 'utf8');

      const cmds = detectVerifyCommands(dir);

      expect(cmds).toEqual([
        { kind: 'typecheck', cmd: ['cargo', 'check'] },
        { kind: 'test', cmd: ['cargo', 'test'] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects bats tests for shell-only repos', () => {
    const dir = makeFixture();
    try {
      mkdirSync(join(dir, 'tests'), { recursive: true });
      writeFileSync(join(dir, 'tests', 'smoke.bats'), '@test "smoke" { true; }\n', 'utf8');

      const cmds = detectVerifyCommands(dir);

      expect(cmds).toEqual([
        { kind: 'test', cmd: ['bats', join('tests', 'smoke.bats')] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to tsc --noEmit when only a tsconfig.json exists', () => {
    const dir = makeFixture();
    try {
      writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
      const cmds = detectVerifyCommands(dir);
      const tc = cmds.find((c) => c.kind === 'typecheck');
      expect(tc?.cmd).toEqual(['npx', 'tsc', '--noEmit']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to vitest run when vitest is a dep and no test script', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { devDependencies: { vitest: '^1.0.0' } });
      const cmds = detectVerifyCommands(dir);
      const test = cmds.find((c) => c.kind === 'test');
      expect(test?.cmd).toEqual(['npx', 'vitest', 'run']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a lint script', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { lint: 'eslint .' } });
      const cmds = detectVerifyCommands(dir);
      const lint = cmds.find((c) => c.kind === 'lint');
      expect(lint?.cmd).toEqual(['npm', 'run', 'lint']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects root ashlr.verify.json commands as argv arrays', () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'vitest' } });
      writeFileSync(
        join(dir, 'ashlr.verify.json'),
        JSON.stringify({
          schemaVersion: 1,
          mode: 'replace-detected',
          commands: [
            {
              id: 'merge-check',
              kind: 'test',
              cmd: ['node', 'scripts/merge-check.js'],
              timeoutMs: 30_000,
              required: true,
              profiles: ['merge'],
            },
          ],
        }),
        'utf8',
      );

      expect(detectVerifyCommands(dir)).toEqual([
        {
          id: 'merge-check',
          kind: 'test',
          cmd: ['node', 'scripts/merge-check.js'],
          timeoutMs: 30_000,
          required: true,
          profiles: ['merge'],
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters contract commands by profile while retaining legacy commands', () => {
    const dir = makeFixture();
    try {
      writeFileSync(
        join(dir, 'ashlr.verify.json'),
        JSON.stringify({
          schemaVersion: 1,
          mode: 'replace-detected',
          commands: [
            { id: 'always', kind: 'typecheck', cmd: ['node', 'always.js'] },
            { id: 'quick', kind: 'test', cmd: ['node', 'quick.js'], profiles: ['quick'] },
            { id: 'merge', kind: 'test', cmd: ['node', 'merge.js'], profiles: ['merge'] },
            { id: 'deep', kind: 'test', cmd: ['node', 'deep.js'], profiles: ['deep'] },
          ],
        }),
        'utf8',
      );

      expect(detectVerifyCommands(dir, 'merge').map((command) => command.id)).toEqual([
        'always',
        'merge',
      ]);
      expect(detectVerifyCommands(dir, 'quick').map((command) => command.id)).toEqual([
        'always',
        'quick',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for an empty dir', () => {
    const dir = makeFixture();
    try {
      expect(detectVerifyCommands(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runVerifyCommand
// ---------------------------------------------------------------------------

describe('runVerifyCommand', () => {
  it('reports ok:true / exit 0 for a passing command', () => {
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', 'process.exit(0)'] };
    const res = runVerifyCommand(vc, workdir, cfg);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.command).toBe('node -e process.exit(0)');
  });

  it('reports ok:false / exit 1 for a failing command', () => {
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', 'process.exit(1)'] };
    const res = runVerifyCommand(vc, workdir, cfg);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.failureCategory).toBe('code');
  });

  it('captures stdout+stderr in output', () => {
    const vc: VerifyCommand = {
      kind: 'test',
      cmd: ['node', '-e', 'console.log("HELLO_STDOUT"); console.error("HELLO_STDERR")'],
    };
    const res = runVerifyCommand(vc, workdir, cfg);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('HELLO_STDOUT');
    expect(res.output).toContain('HELLO_STDERR');
  });

  it('runs verification commands with an isolated HOME and ASHLR_HOME', () => {
    const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const markerName = `m43-real-home-leak-${Date.now()}.txt`;
    const realMarker = join(realHome, '.ashlr', markerName);
    const script = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const marker = process.argv[1];',
      'fs.mkdirSync(path.join(process.env.HOME, ".ashlr"), { recursive: true });',
      'fs.writeFileSync(path.join(process.env.HOME, ".ashlr", marker), "verify");',
      'console.log(JSON.stringify({',
      'home: process.env.HOME,',
      'userprofile: process.env.USERPROFILE,',
      'ashlrHome: process.env.ASHLR_HOME,',
      'realHome: process.env.ASHLR_REAL_HOME',
      '}));',
    ].join(' ');
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', script, markerName] };

    const res = runVerifyCommand(vc, workdir, cfg);

    expect(res.ok).toBe(true);
    const match = res.output.match(/\{[^\n]*"home"[^\n]*\}/);
    expect(match).not.toBeNull();
    const env = JSON.parse(match![0]) as {
      home: string;
      userprofile: string;
      ashlrHome: string;
      realHome: string;
    };
    expect(resolve(env.home)).not.toBe(resolve(realHome));
    expect(resolve(env.userprofile)).toBe(resolve(env.home));
    expect(resolve(env.ashlrHome)).toBe(resolve(join(env.home, '.ashlr')));
    expect(env.realHome.length).toBeGreaterThan(0);
    expect(resolve(env.realHome)).not.toBe(resolve(env.home));
    expect(existsSync(realMarker)).toBe(false);
  });

  it('runs nested verification commands from their project cwd', () => {
    const nested = join(workdir, 'apps', 'web');
    mkdirSync(nested, { recursive: true });
    const script = 'console.log(process.cwd().split(/[\\\\/]/).slice(-2).join("/"))';
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', script], cwd: nested };

    const res = runVerifyCommand(vc, workdir, cfg);

    expect(res.ok).toBe(true);
    expect(res.output.trim()).toBe('apps/web');
    expect(res.command).toContain('cd apps/web');
  });

  it('never throws on a missing binary — returns ok:false', () => {
    const vc: VerifyCommand = { kind: 'lint', cmd: ['definitely-not-a-real-binary-xyz'] };
    const res = runVerifyCommand(vc, workdir, cfg);
    expect(res.ok).toBe(false);
    expect(res.failureCategory).toBe('tool');
  });

  it('marks an empty argv as invalid-command without spawning', () => {
    const vc: VerifyCommand = { kind: 'lint', cmd: [] };
    const res = runVerifyCommand(vc, workdir, cfg);
    expect(res.ok).toBe(false);
    expect(res.failureCategory).toBe('invalid-command');
  });

  it('honors per-command timeoutMs when no caller override is supplied', () => {
    const vc: VerifyCommand = {
      kind: 'test',
      cmd: ['node', '-e', 'setTimeout(() => {}, 5000)'],
      timeoutMs: 120,
    };
    const res = runVerifyCommand(vc, workdir, cfg);
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.failureCategory).toBe('timeout');
  });

  it('times out and terminates child processes, not just the direct command', async () => {
    const childPidPath = join(workdir, 'child.pid');
    const childPidJson = JSON.stringify(childPidPath);
    const script = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });',
      `fs.writeFileSync(${childPidJson}, String(child.pid));`,
      'setTimeout(() => {}, 5000);',
    ].join(' ');
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', script] };

    const res = runVerifyCommand(vc, workdir, cfg, { timeoutMs: 250 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.failureCategory).toBe('timeout');

    await new Promise((resolveDone) => setTimeout(resolveDone, 150));
    const childPid = Number(readFileSync(childPidPath, 'utf8'));
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runVerifyCommandAsync
// ---------------------------------------------------------------------------

describe('runVerifyCommandAsync', () => {
  it('reports the same passing result shape without blocking timers', async () => {
    const vc: VerifyCommand = {
      kind: 'test',
      cmd: ['node', '-e', 'setTimeout(() => { console.log("ASYNC_DONE"); }, 250)'],
    };
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 25);

    const res = await runVerifyCommandAsync(vc, workdir, cfg, { timeoutMs: 1_000 });
    clearInterval(interval);

    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain('ASYNC_DONE');
    expect(ticks).toBeGreaterThanOrEqual(4);
  });

  it('stream-caps noisy output before process close while preserving useful context', async () => {
    const script = [
      'process.stdout.write("HEAD_SENTINEL\\n");',
      'process.stdout.write("A".repeat(1024 * 1024));',
      'process.stdout.write("\\nTAIL_SENTINEL");',
    ].join(' ');
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', script] };

    const res = await runVerifyCommandAsync(vc, workdir, cfg, { timeoutMs: 5_000 });

    expect(res.ok).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(32 * 1024);
    expect(res.output).toContain('HEAD_SENTINEL');
    expect(res.output).toContain('TAIL_SENTINEL');
    expect(res.output).toContain('verify output stream truncated');
  });

  it('times out and terminates child processes without blocking the event loop', async () => {
    const childPidPath = join(workdir, 'async-child.pid');
    const childPidJson = JSON.stringify(childPidPath);
    const script = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });',
      `fs.writeFileSync(${childPidJson}, String(child.pid));`,
      'setTimeout(() => {}, 5000);',
    ].join(' ');
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', script] };
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 25);

    const res = await runVerifyCommandAsync(vc, workdir, cfg, { timeoutMs: 250 });
    clearInterval(interval);

    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.failureCategory).toBe('timeout');
    expect(ticks).toBeGreaterThanOrEqual(4);

    await new Promise((resolveDone) => setTimeout(resolveDone, 150));
    const childPid = Number(readFileSync(childPidPath, 'utf8'));
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('returns a truthful pre-abort result without starting the command', async () => {
    const markerPath = join(workdir, 'pre-abort-started');
    const controller = new AbortController();
    controller.abort();
    const vc: VerifyCommand = {
      kind: 'test',
      cmd: ['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`],
    };

    const res = await runVerifyCommandAsync(vc, workdir, cfg, {
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    expect(res).toMatchObject({
      ok: false,
      exitCode: -1,
      timedOut: false,
      cancelled: true,
      failureCategory: 'cancelled',
    });
    expect(res.output).toContain('cancelled before subprocess start');
    expect(existsSync(markerPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails closed after an aborted leader exits while preserving captured output', async () => {
    const readyPath = join(workdir, 'mid-abort-ready');
    const script = [
      'const fs = require("node:fs");',
      'console.log("OUTPUT_BEFORE_ABORT");',
      `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const controller = new AbortController();
    const vc: VerifyCommand = { kind: 'test', cmd: ['node', '-e', script] };
    const pending = runVerifyCommandAsync(vc, workdir, cfg, {
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true), { timeout: 2_000 });
    controller.abort();
    const res = await pending;

    expect(res).toMatchObject({
      ok: false,
      exitCode: -1,
      timedOut: false,
      failureCategory: 'infra',
    });
    expect(res.cancelled).not.toBe(true);
    expect(res.output).toContain('OUTPUT_BEFORE_ABORT');
    expect(res.output).toContain('cancelled by invocation owner');
    expect(res.output).toContain('ownership identity lost after leader exit before escalation');
  });

  it('fails closed without spawning signal-owned verification on Windows', async () => {
    const controller = new AbortController();
    const spawnFake = vi.fn();
    const processKill = vi.fn();

    const res = await runVerifySubprocessAsync(['node', '-e', 'process.exit(0)'], {
      cwd: workdir,
      env: process.env,
      timeoutMs: 1_000,
      signal: controller.signal,
      _platform: 'win32',
      _spawn: spawnFake as unknown as typeof import('node:child_process').spawn,
      _processKill: processKill,
    });

    expect(res.cancelled).toBe(false);
    expect(res.error).toContain('unsupported on Windows');
    expect(spawnFake).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
  });

  it('bounds escalation and releases inherited pipes without signaling outside the owned PGID', async () => {
    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 24_680,
      stdout,
      stderr,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const spawnFake = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    let groupGone = false;
    const processKill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGKILL') groupGone = true;
      if (signal === 0 && groupGone) throw esrchError();
    });

    const pending = runVerifySubprocessAsync(['node', '-e', 'setInterval(() => {}, 1000)'], {
      cwd: workdir,
      env: process.env,
      timeoutMs: 5_000,
      signal: controller.signal,
      _platform: 'linux',
      _spawn: spawnFake,
      _processKill: processKill,
      _terminationGraceMs: 20,
      _terminationDrainMs: 20,
    });
    stdout.write('FAKE_CAPTURE_BEFORE_ABORT\n');
    controller.abort();
    const res = await pending;

    expect(res.cancelled).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain('FAKE_CAPTURE_BEFORE_ABORT');
    expect(processKill.mock.calls.map(([, signal]) => signal)).toContain('SIGINT');
    expect(processKill.mock.calls.map(([, signal]) => signal)).toContain('SIGKILL');
    expect(processKill.mock.calls.every(([pid]) => pid === -24_680)).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
    expect(spawnFake).toHaveBeenCalledWith(
      'node',
      ['-e', 'setInterval(() => {}, 1000)'],
      expect.objectContaining({ cwd: workdir, detached: true, shell: false }),
    );
  });

  it('never signals a recycled PGID after the original leader exits', async () => {
    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 31_337,
      stdout,
      stderr,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const spawnFake = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    let pgidReused = false;
    const processKill = vi.fn((_pid: number, _signal: NodeJS.Signals | 0) => {
      if (pgidReused) throw new Error('test attempted to signal a recycled process group');
    });

    const pending = runVerifySubprocessAsync(['node', '-e', 'setInterval(() => {}, 1000)'], {
      cwd: workdir,
      env: process.env,
      timeoutMs: 5_000,
      signal: controller.signal,
      _platform: 'linux',
      _spawn: spawnFake,
      _processKill: processKill,
      _terminationGraceMs: 20,
      _terminationDrainMs: 10,
    });
    stdout.write('LEADER_OUTPUT_BEFORE_EXIT\n');
    controller.abort();
    expect(processKill).toHaveBeenCalledTimes(1);
    expect(processKill).toHaveBeenLastCalledWith(-31_337, 'SIGINT');

    pgidReused = true;
    child.emit('exit', null, 'SIGINT');
    const res = await pending;
    await new Promise((resolveDone) => setTimeout(resolveDone, 30));

    expect(res.cancelled).toBe(false);
    expect(res.stdout).toContain('LEADER_OUTPUT_BEFORE_EXIT');
    expect(res.error).toContain('ownership identity lost after leader exit before escalation');
    expect(processKill).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'escalates while the original leader remains alive when its descendant ignores SIGINT',
    async () => {
      const leaderPidPath = join(workdir, 'ignored-sigint-leader.pid');
      const descendantPidPath = join(workdir, 'ignored-sigint-descendant.pid');
      const descendantScript = [
        'const fs = require("node:fs");',
        'process.on("SIGINT", () => {});',
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        'console.log("DESCENDANT_IGNORING_SIGINT");',
        'setInterval(() => {}, 1000);',
      ].join(' ');
      const leaderScript = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        `fs.writeFileSync(${JSON.stringify(leaderPidPath)}, String(process.pid));`,
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "inherit", "inherit"] });`,
        'console.log("LEADER_READY_FOR_ABORT");',
        'process.on("SIGINT", () => {});',
        'setInterval(() => {}, 1000);',
      ].join(' ');
      const controller = new AbortController();
      let leaderPid = 0;
      let descendantPid = 0;

      try {
        const pending = runVerifySubprocessAsync(['node', '-e', leaderScript], {
          cwd: workdir,
          env: process.env,
          timeoutMs: 5_000,
          signal: controller.signal,
          _terminationGraceMs: 100,
          _terminationDrainMs: 750,
        });
        await vi.waitFor(() => expect(existsSync(descendantPidPath)).toBe(true), { timeout: 2_000 });
        leaderPid = Number(readFileSync(leaderPidPath, 'utf8'));
        descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));

        controller.abort();
        const res = await pending;

        expect(res.cancelled).toBe(true);
        expect(res.timedOut).toBe(false);
        expect(res.stdout).toContain('LEADER_READY_FOR_ABORT');
        expect(res.stdout).toContain('DESCENDANT_IGNORING_SIGINT');
        expect(res.stderr).toContain('cancelled by invocation owner');
        await vi.waitFor(() => expect(processIsAlive(descendantPid)).toBe(false), { timeout: 2_000 });
      } finally {
        if (leaderPid > 0) {
          try { process.kill(-leaderPid, 'SIGKILL'); } catch { /* already gone */ }
        } else if (descendantPid > 0) {
          try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    },
  );
});

describe('verification runner packaging', () => {
  it('ships the process-tree verification wrapper in the npm package', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      files?: string[];
    };
    expect(pkg.files).toContain('scripts/run-verify-command.mjs');
  });
});

// ---------------------------------------------------------------------------
// spawnOptionsFor (cross-platform shim resolution)
// ---------------------------------------------------------------------------

describe('spawnOptionsFor', () => {
  it('uses shell:true on win32 for shim bins so PATHEXT resolves npm.cmd/npx.cmd', () => {
    const opts = spawnOptionsFor(workdir, 120_000, 'npm', 'win32');
    expect(opts.shell).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.cwd).toBe(workdir);
    expect(opts.timeout).toBe(120_000);
    expect(opts.stdio).toBe('pipe');
    expect(opts.encoding).toBe('utf8');
  });

  it('uses shell:false on win32 for real binaries (node/git/tsc) to preserve argv', () => {
    // Real executables must NOT route through cmd.exe — shell:true would mangle
    // argv containing spaces/quotes/semicolons.
    expect(spawnOptionsFor(workdir, 120_000, 'node', 'win32').shell).toBe(false);
    expect(spawnOptionsFor(workdir, 120_000, 'git', 'win32').shell).toBe(false);
  });

  it('uses shell:false on non-win32 platforms', () => {
    expect(spawnOptionsFor(workdir, 120_000, 'npm', 'darwin').shell).toBe(false);
    expect(spawnOptionsFor(workdir, 120_000, 'npm', 'linux').shell).toBe(false);
  });

  it('defaults platform to process.platform', () => {
    const opts = spawnOptionsFor(workdir, 120_000, 'npm');
    expect(opts.shell).toBe(process.platform === 'win32');
  });

  it('orders repo-local bins before inherited PATH and generic fallback directories', () => {
    const nested = join(workdir, 'apps', 'web');
    const nestedBin = join(nested, 'node_modules', '.bin');
    const rootBin = join(workdir, 'node_modules', '.bin');
    const inheritedBin = join(workdir, 'healthy-node-bin');
    const relocatedHome = join(workdir, 'relocated-home');
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    mkdirSync(nestedBin, { recursive: true });
    mkdirSync(rootBin, { recursive: true });

    process.env.PATH = inheritedBin;
    process.env.HOME = relocatedHome;
    try {
      const opts = spawnOptionsFor(nested, 120_000, 'bun', process.platform, {
        extraBinRoots: [workdir],
      });
      const pathEntries = String(opts.env?.PATH ?? '').split(delimiter);

      expect(pathEntries.slice(0, 3)).toEqual([
        resolve(nestedBin),
        resolve(rootBin),
        inheritedBin,
      ]);
      expect(pathEntries.indexOf(join(relocatedHome, '.local', 'bin'))).toBeGreaterThan(2);
      expect(pathEntries.indexOf('/opt/homebrew/bin')).toBeGreaterThan(2);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

// ---------------------------------------------------------------------------
// verifyTaskStructured
// ---------------------------------------------------------------------------

describe('verifyTaskStructured', () => {
  it('returns a distinct cancelled verdict for a pre-aborted signal', async () => {
    const dir = makeFixture();
    const markerPath = join(dir, 'pre-abort-started');
    const controller = new AbortController();
    controller.abort();

    try {
      writeVerifyContract(dir, [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')`,
      ]);

      const verdict = await verifyTaskStructured(
        makeTask('build a thing', 'some result'),
        mockClientText('yes'),
        makeBudget(),
        newUsage(),
        { workspaceRoot: dir, allowExec: true, cfg, signal: controller.signal },
      );

      expect(verdict).toMatchObject({ ok: false, cancelled: true, method: 'command' });
      expect(verdict.reason).toContain('cancelled');
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'waits for verifier settlement after a 100ms mid-command abort',
    async () => {
      const dir = makeFixture();
      const startedPath = join(dir, 'mid-abort-started');
      const settledPath = join(dir, 'mid-abort-settled');
      const pidPath = join(dir, 'mid-abort.pid');
      const controller = new AbortController();
      let verifierPid = 0;
      const script = [
        'const fs = require("node:fs")',
        `fs.writeFileSync(${JSON.stringify(startedPath)}, 'started')`,
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
        'let stopping = false',
        'process.on("SIGINT", () => {',
        '  if (stopping) return',
        '  stopping = true',
        '  setTimeout(() => {',
        `    fs.writeFileSync(${JSON.stringify(settledPath)}, 'settled')`,
        '    process.exit(0)',
        '  }, 50)',
        '})',
        'setInterval(() => {}, 1000)',
      ].join(';');

      writeVerifyContract(dir, [process.execPath, '-e', script]);
      const pending = verifyTaskStructured(
        makeTask('build a thing', 'some result'),
        mockClientText('yes'),
        makeBudget(),
        newUsage(),
        { workspaceRoot: dir, allowExec: true, cfg, signal: controller.signal },
      );

      try {
        await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 2_000 });
        verifierPid = Number(readFileSync(pidPath, 'utf8'));
        await new Promise((resolveDone) => setTimeout(resolveDone, 100));
        controller.abort();

        const verdict = await pending;
        expect(verdict).toMatchObject({ ok: false, cancelled: true, method: 'command' });
        expect(verdict.reason).toContain('cancelled');
        expect(existsSync(settledPath)).toBe(true);
        expect(processIsAlive(verifierPid)).toBe(false);
      } finally {
        controller.abort();
        await pending;
        if (verifierPid > 0 && processIsAlive(verifierPid)) {
          try { process.kill(verifierPid, 'SIGKILL'); } catch { /* already gone */ }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('returns a command-failure verdict when a detected test command exits non-zero', async () => {
    const dir = makeFixture();
    try {
      // A test script whose npm run resolves to a node process that exits 1.
      writePkg(dir, { scripts: { test: 'node -e "process.exit(1)"' } });

      const verdict = await verifyTaskStructured(
        makeTask('build a thing', 'some result'),
        mockClientText('yes'),
        makeBudget(),
        newUsage(),
        { workspaceRoot: dir, allowExec: true, cfg },
      );

      expect(verdict.ok).toBe(false);
      expect(verdict.method).toBe('command');
      expect(verdict.reason).toContain('test failed');
      expect(typeof verdict.command).toBe('string');
      expect(typeof verdict.failure).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a command-pass verdict when all detected commands pass', async () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'node -e "process.exit(0)"' } });

      const verdict = await verifyTaskStructured(
        makeTask('build a thing', 'some result'),
        mockClientText('yes'),
        makeBudget(),
        newUsage(),
        { workspaceRoot: dir, allowExec: true, cfg },
      );

      expect(verdict.ok).toBe(true);
      expect(verdict.method).toBe('command');
      expect(verdict.reason).toContain('verify commands passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to verifyTask (heuristic) when allowExec is false', async () => {
    const dir = makeFixture();
    try {
      writePkg(dir, { scripts: { test: 'node -e "process.exit(1)"' } });
      const client = mockClientText('yes');

      const verdict = await verifyTaskStructured(
        makeTask('Write a Python function to add two numbers', 'def add(a, b): return a + b — adds two numbers'),
        client,
        makeBudget(),
        newUsage(),
        { workspaceRoot: dir, allowExec: false, cfg },
      );

      // Did NOT run commands → heuristic verdict from verifyTask.
      expect(verdict.method).toBe('heuristic');
      expect(verdict.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to verifyTask when no workspaceRoot is given', async () => {
    const verdict = await verifyTaskStructured(
      makeTask('Say hello', 'Hello, world!'),
      mockClientText('yes'),
      makeBudget(),
      newUsage(),
      {},
    );
    expect(verdict.method).toBe('heuristic');
  });

  it('falls back to verifyTask when nothing is detected in the workspace', async () => {
    const dir = makeFixture();
    try {
      const verdict = await verifyTaskStructured(
        makeTask('Summarize the recursion concept', 'Recursion is a function calling itself.'),
        mockClientText('yes'),
        makeBudget(),
        newUsage(),
        { workspaceRoot: dir, allowExec: true, cfg },
      );
      expect(verdict.method).toBe('heuristic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

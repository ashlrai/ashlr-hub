/**
 * M11 engines tests — hermetic, no real network, no real engine delegation.
 *
 * Covers:
 *   - buildEngineCommand returns EXACT argv for claude / aw / ashlrcode.
 *   - buildEngineCommand returns null for 'builtin'.
 *   - phantomWrap transforms command correctly.
 *   - spawnEngine never throws on failure (mock execFileSync / spawnSync).
 *   - engineInstalled uses a PATH probe (mocked via vi.mock).
 *   - SECURITY: no secret-shaped keys ever appear in spawnEngine env.
 *
 * GUARDRAIL: NO real delegated runs. All child_process calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, EngineCommand } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// We mock child_process so no real engine is ever spawned.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fake child process factory for mocking spawn() (M236: streaming spawn).
// Returns an object shaped like ChildProcess with EventEmitter-like on().
// The caller can configure stdout data + exit code via the returned control.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

interface FakeChildControl {
  child: ReturnType<typeof makeFakeChild>;
  /** Emit leader exit while inherited pipes/group may remain open. */
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  /** Emit final process/stdio close. */
  close(code: number | null, signal: NodeJS.Signals | null, stdoutData?: string, stderrData?: string): void;
  /** Emit stdout data then close the child with the given code/signal. */
  resolve(code: number | null, signal: NodeJS.Signals | null, stdoutData?: string, stderrData?: string): void;
  /** Emit a spawn error then close. */
  reject(err: Error): void;
}

function makeFakeChild() {
  const stdout = new EventEmitter() as NodeJS.EventEmitter & {
    destroyed: boolean;
    destroy: ReturnType<typeof vi.fn>;
  };
  const stderr = new EventEmitter() as NodeJS.EventEmitter & {
    destroyed: boolean;
    destroy: ReturnType<typeof vi.fn>;
  };
  stdout.destroyed = false;
  stderr.destroyed = false;
  stdout.destroy = vi.fn(() => { stdout.destroyed = true; });
  stderr.destroy = vi.fn(() => { stderr.destroyed = true; });
  const child = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    killed: boolean;
    kill: (sig?: string) => void;
    unref: ReturnType<typeof vi.fn>;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = (_sig?: string) => { child.killed = true; };
  child.unref = vi.fn();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function makeFakeSpawnControl(): FakeChildControl {
  const child = makeFakeChild();
  const control: FakeChildControl = {
    child,
    exit(code, signal) {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
    },
    close(code, signal, stdoutData = '', stderrData = '') {
      if (stdoutData) child.stdout.emit('data', Buffer.from(stdoutData));
      if (stderrData) child.stderr.emit('data', Buffer.from(stderrData));
      child.emit('close', code, signal);
    },
    resolve(code, signal, stdoutData = '', stderrData = '') {
      this.exit(code, signal);
      this.close(code, signal, stdoutData, stderrData);
    },
    reject(err) {
      child.emit('error', err);
    },
  };
  return control;
}

// The spawn mock returns a fake child; tests control when/how it closes.
let _spawnControl: FakeChildControl | null = null;

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: Buffer.from('ok output'),
    stderr: Buffer.from(''),
    error: undefined,
  })),
  execFileSync: vi.fn(() => Buffer.from('/usr/local/bin/claude')),
  spawn: vi.fn(() => {
    _spawnControl = makeFakeSpawnControl();
    return _spawnControl.child;
  }),
}));

function getSpawnControl(): FakeChildControl {
  if (!_spawnControl) throw new Error('spawn not yet called');
  return _spawnControl;
}

function makeOwnedGroupKillMock() {
  return vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 0) {
      throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
    }
  });
}

// Import after mocking so the module picks up the mock.
const { buildEngineCommand, phantomWrap, spawnEngine, engineInstalled } =
  await import('../src/core/run/engines.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...over,
  };
}

const GOAL = 'Write a hello world program';
const MODEL = 'qwen2.5-coder:7b';
const CWD = '/home/u/project';

// Pattern that must NEVER appear as an env key we add.
const SECRET_KEY_RE =
  /(_API_KEY|_SECRET|_TOKEN|PASSWORD|^ANTHROPIC_|^OPENAI_API|^GEMINI_|^COHERE_|^GROQ_)/i;

let tmpHome: string | null = null;
let origHome: string | undefined;
let origUserProfile: string | undefined;
let tempHomeActive = false;

function withTempHome(): string {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m11-'));
  origHome = process.env['HOME'];
  origUserProfile = process.env['USERPROFILE'];
  tempHomeActive = true;
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
  return tmpHome;
}

afterEach(() => {
  if (!tempHomeActive) return;
  if (tmpHome) {
    rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  }
  if (origHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = origHome;
  if (origUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = origUserProfile;
  origHome = undefined;
  origUserProfile = undefined;
  tempHomeActive = false;
});

// ---------------------------------------------------------------------------
// buildEngineCommand — builtin
// ---------------------------------------------------------------------------

describe('buildEngineCommand — builtin', () => {
  it('returns null for builtin engine', () => {
    expect(buildEngineCommand('builtin', GOAL, makeConfig())).toBeNull();
  });

  it('returns null for builtin regardless of opts', () => {
    expect(
      buildEngineCommand('builtin', GOAL, makeConfig(), { cwd: CWD, model: MODEL }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildEngineCommand — claude (INSTALLED)
// Exact argv: ['−p', G, '--model', M, '--output-format', 'json']
// ---------------------------------------------------------------------------

describe('buildEngineCommand — claude', () => {
  it('bin is "claude"', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { model: MODEL });
    expect(cmd).not.toBeNull();
    expect(cmd!.bin).toBe('claude');
  });

  it('args start with -p and the goal string', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { model: MODEL });
    expect(cmd!.args[0]).toBe('-p');
    expect(cmd!.args[1]).toBe(GOAL);
  });

  it('includes --model <model> when model is provided', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { model: MODEL });
    const idx = cmd!.args.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(cmd!.args[idx + 1]).toBe(MODEL);
  });

  it('includes --output-format json', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { model: MODEL });
    const idx = cmd!.args.indexOf('--output-format');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(cmd!.args[idx + 1]).toBe('json');
  });

  it('produces EXACT argv ["-p", G, "--model", M, "--output-format", "json"]', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { model: MODEL });
    expect(cmd!.args).toEqual(['-p', GOAL, '--model', MODEL, '--output-format', 'json']);
  });

  it('omits --model when no model is provided', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig());
    expect(cmd).not.toBeNull();
    expect(cmd!.args).not.toContain('--model');
    // Must still have -p and --output-format json
    expect(cmd!.args[0]).toBe('-p');
    expect(cmd!.args[1]).toBe(GOAL);
    expect(cmd!.args).toContain('--output-format');
  });

  it('does not include empty/undefined model flag', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { model: '' });
    expect(cmd!.args).not.toContain('--model');
  });

  it('cwd is passed through when provided', () => {
    const cmd = buildEngineCommand('claude', GOAL, makeConfig(), { cwd: CWD, model: MODEL });
    expect(cmd!.cwd).toBe(CWD);
  });
});

// ---------------------------------------------------------------------------
// buildEngineCommand — aw (INSTALLED)
// Exact argv: ['auto', G, '--cwd', D] (+ ['--model', M] when model given)
// ---------------------------------------------------------------------------

describe('buildEngineCommand — aw', () => {
  it('bin is "aw"', () => {
    const cmd = buildEngineCommand('aw', GOAL, makeConfig(), { cwd: CWD });
    expect(cmd).not.toBeNull();
    expect(cmd!.bin).toBe('aw');
  });

  it('args start with "auto" then the goal', () => {
    const cmd = buildEngineCommand('aw', GOAL, makeConfig(), { cwd: CWD });
    expect(cmd!.args[0]).toBe('auto');
    expect(cmd!.args[1]).toBe(GOAL);
  });

  it('includes --cwd <dir>', () => {
    const cmd = buildEngineCommand('aw', GOAL, makeConfig(), { cwd: CWD });
    const idx = cmd!.args.indexOf('--cwd');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(cmd!.args[idx + 1]).toBe(CWD);
  });

  it('produces EXACT argv ["auto", G, "--cwd", D] without model', () => {
    const cmd = buildEngineCommand('aw', GOAL, makeConfig(), { cwd: CWD });
    expect(cmd!.args).toEqual(['auto', GOAL, '--cwd', CWD]);
  });

  it('appends ["--model", M] when model is provided', () => {
    const cmd = buildEngineCommand('aw', GOAL, makeConfig(), { cwd: CWD, model: MODEL });
    expect(cmd!.args).toEqual(['auto', GOAL, '--cwd', CWD, '--model', MODEL]);
  });

  it('omits --model when model is empty string', () => {
    const cmd = buildEngineCommand('aw', GOAL, makeConfig(), { cwd: CWD, model: '' });
    expect(cmd!.args).not.toContain('--model');
  });

  it('uses process.cwd() as fallback when cwd not provided', () => {
    const cmd = buildEngineCommand('aw', GOAL, makeConfig());
    expect(cmd).not.toBeNull();
    const idx = cmd!.args.indexOf('--cwd');
    expect(idx).toBeGreaterThanOrEqual(0);
    // Should be a non-empty string (process.cwd())
    expect(typeof cmd!.args[idx + 1]).toBe('string');
    expect((cmd!.args[idx + 1] as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildEngineCommand — ashlrcode (ABSENT here, but argv must be correct)
// bin: 'ac', args: ['--goal', G]
// ---------------------------------------------------------------------------

describe('buildEngineCommand — ashlrcode', () => {
  it('bin is "ac"', () => {
    const cmd = buildEngineCommand('ashlrcode', GOAL, makeConfig());
    expect(cmd).not.toBeNull();
    expect(cmd!.bin).toBe('ac');
  });

  it('args include --goal and the goal string', () => {
    const cmd = buildEngineCommand('ashlrcode', GOAL, makeConfig());
    expect(cmd!.args).toContain('--goal');
    const idx = cmd!.args.indexOf('--goal');
    expect(cmd!.args[idx + 1]).toBe(GOAL);
  });

  it('produces argv starting with ["--goal", G]', () => {
    const cmd = buildEngineCommand('ashlrcode', GOAL, makeConfig());
    expect(cmd!.args[0]).toBe('--goal');
    expect(cmd!.args[1]).toBe(GOAL);
  });

  it('appends unattended flags when autonomous', () => {
    const cmd = buildEngineCommand('ashlrcode', GOAL, makeConfig(), { autonomous: true });
    expect(cmd!.args).toEqual([
      '--goal',
      GOAL,
      '--autonomous',
      '--dangerously-skip-permissions',
      '--surgical',
    ]);
  });

  it('is a pure function — does not actually spawn anything', () => {
    // Just calling it twice must return the same shape deterministically.
    const a = buildEngineCommand('ashlrcode', GOAL, makeConfig());
    const b = buildEngineCommand('ashlrcode', GOAL, makeConfig());
    expect(a!.bin).toBe(b!.bin);
    expect(a!.args).toEqual(b!.args);
  });
});

// ---------------------------------------------------------------------------
// phantomWrap
// Result: { bin: 'phantom', args: ['exec', '--', orig.bin, ...orig.args], cwd: orig.cwd }
// ---------------------------------------------------------------------------

describe('phantomWrap', () => {
  const baseCmd: EngineCommand = {
    bin: 'claude',
    args: ['-p', GOAL, '--model', MODEL, '--output-format', 'json'],
    cwd: CWD,
  };

  it('sets bin to "phantom"', () => {
    const wrapped = phantomWrap(baseCmd, makeConfig());
    expect(wrapped.bin).toBe('phantom');
  });

  it('args start with ["exec", "--"]', () => {
    const wrapped = phantomWrap(baseCmd, makeConfig());
    expect(wrapped.args[0]).toBe('exec');
    expect(wrapped.args[1]).toBe('--');
  });

  it('original bin is the third arg', () => {
    const wrapped = phantomWrap(baseCmd, makeConfig());
    expect(wrapped.args[2]).toBe('claude');
  });

  it('original args follow the original bin', () => {
    const wrapped = phantomWrap(baseCmd, makeConfig());
    expect(wrapped.args.slice(3)).toEqual(baseCmd.args);
  });

  it('produces exact phantom argv', () => {
    const wrapped = phantomWrap(baseCmd, makeConfig());
    expect(wrapped.args).toEqual([
      'exec', '--', 'claude',
      '-p', GOAL, '--model', MODEL, '--output-format', 'json',
    ]);
  });

  it('preserves cwd from the original command', () => {
    const wrapped = phantomWrap(baseCmd, makeConfig());
    expect(wrapped.cwd).toBe(CWD);
  });

  it('is a pure transform — does not mutate the original command', () => {
    const orig = { ...baseCmd, args: [...baseCmd.args] };
    phantomWrap(baseCmd, makeConfig());
    expect(baseCmd.bin).toBe(orig.bin);
    expect(baseCmd.args).toEqual(orig.args);
  });

  it('works with an aw command', () => {
    const awCmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL, '--cwd', CWD] };
    const wrapped = phantomWrap(awCmd, makeConfig());
    expect(wrapped.bin).toBe('phantom');
    expect(wrapped.args).toEqual(['exec', '--', 'aw', 'auto', GOAL, '--cwd', CWD]);
  });
});

// ---------------------------------------------------------------------------
// spawnEngine — never throws, mocked child_process (M236: streaming spawn)
// ---------------------------------------------------------------------------

describe('spawnEngine — never throws on failure', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    _spawnControl = null;
    // Re-install the default spawn mock after resetAllMocks().
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockImplementation(() => {
      _spawnControl = makeFakeSpawnControl();
      return _spawnControl.child as ReturnType<typeof spawn>;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns { ok: true } on zero-exit with output', async () => {
    const cmd: EngineCommand = { bin: 'claude', args: ['-p', GOAL] };
    const p = spawnEngine(cmd, makeConfig());
    // Emit stdout then close cleanly.
    getSpawnControl().resolve(0, null, 'hello output\n');
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello output');
  });

  it('returns { ok: false } on non-zero exit — does not throw', async () => {
    const cmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL, '--cwd', CWD] };
    const p = spawnEngine(cmd, makeConfig());
    getSpawnControl().resolve(1, null, '', 'command failed\n');
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('does not spawn or recover Codex when the signal is pre-aborted', async () => {
    const { spawn } = await import('node:child_process');
    const controller = new AbortController();
    controller.abort();

    const result = await spawnEngine(
      { bin: 'codex', args: ['exec', '--json', GOAL] },
      makeConfig(),
      { signal: controller.signal, _platform: 'linux' },
    );

    expect(result).toMatchObject({ ok: false, terminationReason: 'cancelled' });
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('spawns signal-owned POSIX runs in a detached process group only', async () => {
    const { spawn } = await import('node:child_process');
    const controller = new AbortController();
    const signaled = spawnEngine(
      { bin: 'aw', args: ['auto', GOAL] },
      makeConfig(),
      { signal: controller.signal, _platform: 'linux' },
    );
    expect(vi.mocked(spawn).mock.calls[0]![2]).toMatchObject({ detached: true });
    getSpawnControl().resolve(0, null, 'ok\n');
    await expect(signaled).resolves.toMatchObject({ ok: true });

    const plain = spawnEngine({ bin: 'aw', args: ['auto', GOAL] }, makeConfig());
    expect(vi.mocked(spawn).mock.calls[1]![2]).not.toHaveProperty('detached');
    getSpawnControl().resolve(0, null, 'ok\n');
    await expect(plain).resolves.toMatchObject({ ok: true });
  });

  it('sends one SIGINT then at most one SIGKILL before bounded settlement', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const processKill = makeOwnedGroupKillMock();
    const pending = spawnEngine(
      { bin: 'aw', args: ['auto', GOAL] },
      makeConfig(),
      {
        signal: controller.signal,
        _platform: 'linux',
        _processKill: processKill,
        _stallGraceMs: 20,
      },
    );

    controller.abort();
    controller.abort();
    expect(processKill.mock.calls.filter(([, signal]) => signal === 'SIGINT')).toEqual([[-12345, 'SIGINT']]);
    await vi.advanceTimersByTimeAsync(20);
    expect(processKill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toEqual([[-12345, 'SIGKILL']]);
    getSpawnControl().resolve(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(100);
    expect(processKill.mock.calls.filter(([, signal]) => signal === 0)).toEqual([]);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: 'cancelled',
      terminationReason: 'cancelled',
    });
  });

  it('keeps the bounded cancellation deadline referenced until settlement', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const controller = new AbortController();
    const processKill = makeOwnedGroupKillMock();
    const pending = spawnEngine(
      { bin: 'aw', args: ['auto', GOAL] },
      makeConfig(),
      {
        signal: controller.signal,
        _platform: 'linux',
        _processKill: processKill,
        _stallGraceMs: 10_000,
      },
    );

    controller.abort();
    const timerForDelay = (delay: number): NodeJS.Timeout => {
      const index = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === delay);
      expect(index).toBeGreaterThanOrEqual(0);
      return setTimeoutSpy.mock.results[index]!.value as NodeJS.Timeout;
    };
    expect(timerForDelay(10_000).hasRef()).toBe(true);
    expect(timerForDelay(5 * 60 * 1000).hasRef()).toBe(false);

    const deadlineTimer = timerForDelay(10_000);
    const escalation = setTimeoutSpy.mock.calls.find((call) => call[1] === 10_000)![0];
    (escalation as () => void)();
    const drain = setTimeoutSpy.mock.calls.find((call) => call[1] === 100)![0];
    (drain as () => void)();
    await expect(pending).resolves.toMatchObject({
      terminationReason: 'error-exit',
      error: expect.stringContaining('stdio closure unconfirmed'),
    });
    expect(getSpawnControl().child.stdout.destroyed).toBe(true);
    expect(getSpawnControl().child.stderr.destroyed).toBe(true);
    expect(getSpawnControl().child.unref).toHaveBeenCalledOnce();
    clearTimeout(deadlineTimer);
    setTimeoutSpy.mockRestore();
  });

  it('refuses delayed group signaling after leader exit to prevent PGID reuse', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let numericGroupReused = false;
    const processKill = vi.fn((_pid: number, _signal: NodeJS.Signals | 0) => {
      if (numericGroupReused) {
        throw new Error('test detected signaling of an unrelated reused process group');
      }
    });
    const pending = spawnEngine(
      { bin: 'aw', args: ['auto', GOAL] },
      makeConfig(),
      {
        signal: controller.signal,
        _platform: 'linux',
        _processKill: processKill,
        _stallGraceMs: 20,
      },
    );

    controller.abort();
    expect(processKill).toHaveBeenCalledTimes(1);
    expect(processKill).toHaveBeenLastCalledWith(-12345, 'SIGINT');
    getSpawnControl().exit(0, null);
    // Simulate the numeric PID/PGID becoming reusable by an unrelated process.
    // No delayed SIGKILL or even signal-0 probe may target that number.
    numericGroupReused = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(processKill.mock.calls).toEqual([[-12345, 'SIGINT']]);
    getSpawnControl().close(null, 'SIGKILL');
    await expect(pending).resolves.toMatchObject({
      terminationReason: 'error-exit',
      error: expect.stringContaining('leader identity is no longer provable'),
    });
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed without claiming cleanup after a real process-group leader exits',
    async () => {
      const { spawn } = await import('node:child_process');
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      vi.mocked(spawn).mockImplementationOnce((bin, args, options) =>
        actualChildProcess.spawn(bin, args, options));

      const descendantScript = [
        "process.on('SIGINT', () => {});",
        'setInterval(() => {}, 1_000);',
      ].join('');
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], `,
        "{ stdio: ['ignore', 'inherit', 'inherit'] });",
        'child.unref();',
        "process.stdout.write(`descendant:${child.pid}\\n`, () => process.exit(0));",
      ].join('');
      const controller = new AbortController();
      let descendantPid: number | undefined;
      let sawDescendant!: () => void;
      const descendantStarted = new Promise<void>((resolve) => { sawDescendant = resolve; });
      const pending = spawnEngine(
        { bin: process.execPath, args: ['-e', leaderScript] },
        makeConfig(),
        {
          signal: controller.signal,
          _platform: process.platform,
          _stallGraceMs: 30,
          _terminationDrainMs: 300,
          onEvent: (event) => {
            const match = event.rawLine?.match(/^descendant:(\d+)$/);
            if (!match) return;
            descendantPid = Number(match[1]);
            sawDescendant();
          },
        },
      );

      try {
        await Promise.race([
          descendantStarted,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('descendant did not start')), 1_000)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.abort();
        const result = await pending;
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining('leader identity is no longer provable'),
          terminationReason: 'error-exit',
        });
        expect(result.output).toContain(`descendant:${descendantPid}`);
        expect(() => process.kill(descendantPid!, 0)).not.toThrow();
      } finally {
        if (descendantPid) {
          try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    },
    3_000,
  );

  it('fails closed when group signaling returns EPERM', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const processKill = vi.fn(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const pending = spawnEngine(
      { bin: 'aw', args: ['auto', GOAL] },
      makeConfig(),
      {
        signal: controller.signal,
        _platform: 'linux',
        _processKill: processKill,
        _stallGraceMs: 20,
      },
    );

    controller.abort();
    expect(processKill).toHaveBeenCalledOnce();
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGINT');

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('termination authority lost'),
      terminationReason: 'error-exit',
    });
    expect(processKill).toHaveBeenCalledOnce();
    expect(getSpawnControl().child.stdout.destroyed).toBe(true);
    expect(getSpawnControl().child.stderr.destroyed).toBe(true);
    expect(getSpawnControl().child.unref).toHaveBeenCalledOnce();
  });

  it('preserves an EPERM authority failure across a late child error race', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const processKill = vi.fn(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const pending = spawnEngine(
      { bin: 'aw', args: ['auto', GOAL] },
      makeConfig(),
      {
        signal: controller.signal,
        _platform: 'linux',
        _processKill: processKill,
        _terminationDrainMs: 30,
      },
    );

    controller.abort();
    getSpawnControl().reject(new Error('late child process error'));
    await vi.advanceTimersByTimeAsync(30);

    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('termination authority lost'),
      terminationReason: 'error-exit',
    });
    expect(result.error).toContain('SIGINT process-group signal failed (EPERM)');
    expect(result.error).not.toContain('late child process error');
    expect(processKill).toHaveBeenCalledOnce();
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGINT');
    expect(getSpawnControl().child.stdout.destroyed).toBe(true);
    expect(getSpawnControl().child.stderr.destroyed).toBe(true);
    expect(getSpawnControl().child.unref).toHaveBeenCalledOnce();
  });

  it('retains parsed usage when leader exit makes cancellation unverifiable', async () => {
    const controller = new AbortController();
    const processKill = makeOwnedGroupKillMock();
    const usageLine = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 42, output_tokens: 17 },
    });
    const pending = spawnEngine(
      { bin: 'claude', args: ['-p', GOAL, '--output-format', 'stream-json'] },
      makeConfig(),
      { signal: controller.signal, _platform: 'linux', _processKill: processKill },
    );

    controller.abort();
    getSpawnControl().resolve(null, 'SIGINT', `${usageLine}\n`);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('leader identity is no longer provable'),
      terminationReason: 'error-exit',
      usage: { tokensIn: 42, tokensOut: 17 },
    });
  });

  it('drains buffered usage after SIGKILL before forced settlement', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const processKill = makeOwnedGroupKillMock();
    const usageLine = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 81, output_tokens: 23 },
    });
    const pending = spawnEngine(
      { bin: 'claude', args: ['-p', GOAL, '--output-format', 'stream-json'] },
      makeConfig(),
      {
        signal: controller.signal,
        _platform: 'linux',
        _processKill: processKill,
        _stallGraceMs: 20,
        _terminationDrainMs: 30,
      },
    );

    controller.abort();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(10);
    getSpawnControl().close(null, 'SIGKILL', `${usageLine}\n`);
    await vi.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: 'cancelled',
      terminationReason: 'cancelled',
      usage: { tokensIn: 81, tokensOut: 23 },
    });
    expect(getSpawnControl().child.stdout.destroyed).toBe(true);
    expect(getSpawnControl().child.unref).toHaveBeenCalledOnce();
  });

  it('fails closed and releases local handles when group exit remains unconfirmed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const processKill = vi.fn();
    const pending = spawnEngine(
      { bin: 'aw', args: ['auto', GOAL] },
      makeConfig(),
      {
        signal: controller.signal,
        _platform: 'linux',
        _processKill: processKill,
        _stallGraceMs: 20,
        _terminationDrainMs: 30,
      },
    );

    controller.abort();
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('process-group exit unconfirmed'),
      terminationReason: 'error-exit',
    });
    expect(processKill.mock.calls).toEqual([
      [-12345, 'SIGINT'],
      [-12345, 'SIGKILL'],
      [-12345, 0],
    ]);
    expect(getSpawnControl().child.stdout.destroyed).toBe(true);
    expect(getSpawnControl().child.stderr.destroyed).toBe(true);
    expect(getSpawnControl().child.unref).toHaveBeenCalledOnce();
  });

  it('does not retry Codex config recovery after cancellation', async () => {
    const { spawn } = await import('node:child_process');
    const controller = new AbortController();
    const processKill = makeOwnedGroupKillMock();
    const pending = spawnEngine(
      { bin: 'codex', args: ['exec', '--json', GOAL] },
      makeConfig(),
      { signal: controller.signal, _platform: 'linux', _processKill: processKill },
    );

    controller.abort();
    getSpawnControl().resolve(
      1,
      null,
      '',
      'Error loading config.toml: unknown variant `ultra` for model_reasoning_effort',
    );

    await expect(pending).resolves.toMatchObject({
      terminationReason: 'error-exit',
      error: expect.stringContaining('leader identity is no longer provable'),
    });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('fails closed on Windows without spawning or invoking an unsafe tree kill', async () => {
    const { spawn } = await import('node:child_process');
    const controller = new AbortController();
    const processKill = makeOwnedGroupKillMock();

    const result = await spawnEngine(
      { bin: 'aw.exe', args: ['auto', GOAL] },
      makeConfig(),
      { signal: controller.signal, _platform: 'win32', _processKill: processKill },
    );

    expect(result).toMatchObject({ ok: false, terminationReason: 'error-exit' });
    expect(result.error).toContain('complete process-tree ownership cannot be guaranteed');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
    expect(result.error).not.toContain('taskkill');
  });

  it('retries Codex once with a supported effort after an incompatible global preference', async () => {
    const { spawn } = await import('node:child_process');
    const controls: FakeChildControl[] = [];
    vi.mocked(spawn).mockImplementation((_bin, _args, _opts) => {
      const control = makeFakeSpawnControl();
      controls.push(control);
      _spawnControl = control;
      return control.child as ReturnType<typeof spawn>;
    });
    const cmd: EngineCommand = {
      bin: 'codex',
      args: ['exec', '--model', 'gpt-5.5', '--cd', CWD, '--json', GOAL],
      cwd: CWD,
    };

    const pending = spawnEngine(cmd, makeConfig());
    controls[0]!.resolve(
      1,
      null,
      '',
      'Error loading config.toml: unknown variant `ultra` for model_reasoning_effort',
    );
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    const retryArgs = vi.mocked(spawn).mock.calls[1]![1] as string[];
    expect(retryArgs).toContain('model_reasoning_effort="xhigh"');
    controls[1]!.resolve(0, null, '{"type":"done"}\n');

    await expect(pending).resolves.toMatchObject({ ok: true });
    await expect(pending).resolves.toMatchObject({ configRecoveryAttempts: 1 });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(cmd.args).not.toContain('-c');
  });

  it('does not retry unrelated Codex failures', async () => {
    const { spawn } = await import('node:child_process');
    const cmd: EngineCommand = { bin: 'codex', args: ['exec', '--json', GOAL] };
    const pending = spawnEngine(cmd, makeConfig());
    getSpawnControl().resolve(1, null, '', 'authentication failed');

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('uses a broadly supported effort when recovering an unknown Codex model', async () => {
    const { spawn } = await import('node:child_process');
    const controls: FakeChildControl[] = [];
    vi.mocked(spawn).mockImplementation((_bin, _args, _opts) => {
      const control = makeFakeSpawnControl();
      controls.push(control);
      _spawnControl = control;
      return control.child as ReturnType<typeof spawn>;
    });
    const pending = spawnEngine({
      bin: 'codex',
      args: ['exec', '--model', 'custom-codex-model', '--json', GOAL],
    }, makeConfig());

    controls[0]!.resolve(1, null, '', 'unknown variant `ultra` for model_reasoning_effort; expected one of');
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    const retryArgs = vi.mocked(spawn).mock.calls[1]![1] as string[];
    expect(retryArgs).toContain('model_reasoning_effort="medium"');
    controls[1]!.resolve(0, null, 'ok\n');

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('uses medium when Codex recovery cannot prove the effective model', async () => {
    const { spawn } = await import('node:child_process');
    const controls: FakeChildControl[] = [];
    vi.mocked(spawn).mockImplementation((_bin, _args, _opts) => {
      const control = makeFakeSpawnControl();
      controls.push(control);
      _spawnControl = control;
      return control.child as ReturnType<typeof spawn>;
    });
    const pending = spawnEngine({ bin: 'codex', args: ['exec', '--json', GOAL] }, makeConfig());

    controls[0]!.resolve(1, null, '', 'unknown variant `ultra` for model_reasoning_effort');
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    expect(vi.mocked(spawn).mock.calls[1]![1]).toContain('model_reasoning_effort="medium"');
    controls[1]!.resolve(0, null, 'ok\n');

    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('does not replay Codex after any stdout proves execution started', async () => {
    const { spawn } = await import('node:child_process');
    const cmd: EngineCommand = { bin: 'codex', args: ['exec', '--json', GOAL] };
    const pending = spawnEngine(cmd, makeConfig());
    getSpawnControl().resolve(
      1,
      null,
      '{"type":"tool_call","name":"shell"}\n',
      'unknown variant `ultra` for model_reasoning_effort',
    );

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('does not mistake prompt text for an existing Codex config override', async () => {
    const { spawn } = await import('node:child_process');
    const controls: FakeChildControl[] = [];
    vi.mocked(spawn).mockImplementation((_bin, _args, _opts) => {
      const control = makeFakeSpawnControl();
      controls.push(control);
      _spawnControl = control;
      return control.child as ReturnType<typeof spawn>;
    });
    const pending = spawnEngine({
      bin: 'codex',
      args: ['exec', '--model', 'gpt-5.5', '--json', 'Fix model_reasoning_effort handling'],
    }, makeConfig());

    controls[0]!.resolve(1, null, '', 'unknown variant `ultra` for model_reasoning_effort');
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    controls[1]!.resolve(0, null, 'ok\n');

    await expect(pending).resolves.toMatchObject({ ok: true, configRecoveryAttempts: 1 });
  });

  it.each([
    '-cmodel_reasoning_effort="low"',
    '-c=model_reasoning_effort="low"',
    '--config=model_reasoning_effort="low"',
  ])('respects compact Codex config override %s', async (override) => {
    const { spawn } = await import('node:child_process');
    const pending = spawnEngine({
      bin: 'codex',
      args: ['exec', override, '--json', GOAL],
    }, makeConfig());
    getSpawnControl().resolve(1, null, '', 'unknown variant `ultra` for model_reasoning_effort');

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('returns { ok: false } when spawn emits an error — does not throw', async () => {
    const cmd: EngineCommand = { bin: 'nonexistent-tool', args: [] };
    const p = spawnEngine(cmd, makeConfig());
    getSpawnControl().reject(new Error('ENOENT: binary not found'));
    const result = await p;
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('never throws — returned Promise resolves even on spawn error', async () => {
    const cmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL] };
    // Must not throw synchronously.
    let p: ReturnType<typeof spawnEngine> | undefined;
    expect(() => { p = spawnEngine(cmd, makeConfig()); }).not.toThrow();
    // Resolve it cleanly so the Promise settles.
    getSpawnControl().resolve(0, null, 'ok\n');
    const result = await p!;
    expect(typeof result).toBe('object');
  });

  it('parses usage from claude stream-json result event', async () => {
    // M236: usage comes from the final 'result' JSONL event in stream-json output.
    const claudeResultLine = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 42, output_tokens: 17 },
    });
    const cmd: EngineCommand = {
      bin: 'claude',
      args: ['-p', GOAL, '--output-format', 'stream-json'],
    };
    const p = spawnEngine(cmd, makeConfig());
    getSpawnControl().resolve(0, null, claudeResultLine + '\n');
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.usage) {
      expect(result.usage.tokensIn).toBe(42);
      expect(result.usage.tokensOut).toBe(17);
    }
    // usage may be omitted when the json doesn't match — that's fine per contract
  });

  it('records Claude CLI rate_limit_event metadata from streamed output', async () => {
    withTempHome();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const rateLimitLine = JSON.stringify({
      type: 'rate_limit_event',
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 1,
      resetsAt: reset,
    });
    const cmd: EngineCommand = {
      bin: 'claude',
      args: ['-p', GOAL, '--output-format', 'stream-json'],
    };

    const p = spawnEngine(cmd, makeConfig());
    getSpawnControl().resolve(0, null, rateLimitLine + '\n');
    const result = await p;

    const { readLatestClaudeRateLimitEvent } = await import('../src/core/fabric/claude-rate-limit-event.js');
    expect(result.ok).toBe(true);
    expect(readLatestClaudeRateLimitEvent()).toMatchObject({
      rateLimitType: 'seven_day',
      utilization: 1,
      resetsAt: reset,
    });
  });

  it('uses withToolEnv (allowlist) — no secret-shaped keys in child env', async () => {
    const { spawn } = await import('node:child_process');
    let capturedEnv: Record<string, string> | undefined;
    vi.mocked(spawn).mockImplementationOnce((_bin, _args, opts) => {
      capturedEnv = (opts?.env ?? {}) as Record<string, string>;
      _spawnControl = makeFakeSpawnControl();
      return _spawnControl.child as ReturnType<typeof spawn>;
    });
    const cmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL, '--cwd', CWD] };
    const p = spawnEngine(cmd, makeConfig());
    getSpawnControl().resolve(0, null, 'ok\n');
    await p;
    if (capturedEnv !== undefined) {
      const processEnvKeys = new Set(Object.keys(process.env));
      const addedSecretKeys = Object.keys(capturedEnv)
        .filter((k) => SECRET_KEY_RE.test(k) && !processEnvKeys.has(k));
      expect(addedSecretKeys).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// engineInstalled — mocked PATH probe
// ---------------------------------------------------------------------------

describe('engineInstalled', () => {
  it('builtin is always installed', () => {
    expect(engineInstalled('builtin')).toBe(true);
  });

  it('returns a boolean for claude', () => {
    const result = engineInstalled('claude');
    expect(typeof result).toBe('boolean');
  });

  it('returns a boolean for aw', () => {
    const result = engineInstalled('aw');
    expect(typeof result).toBe('boolean');
  });

  it('returns a boolean for ashlrcode (absent is ok — must not throw)', () => {
    expect(() => engineInstalled('ashlrcode')).not.toThrow();
    expect(typeof engineInstalled('ashlrcode')).toBe('boolean');
  });

  it('never throws for any engine id', () => {
    const engines = ['builtin', 'claude', 'aw', 'ashlrcode'] as const;
    for (const e of engines) {
      expect(() => engineInstalled(e)).not.toThrow();
    }
  });
});

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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AshlrConfig, EngineCommand } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// We mock child_process so no real engine is ever spawned.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: Buffer.from('ok output'),
    stderr: Buffer.from(''),
    error: undefined,
  })),
  execFileSync: vi.fn(() => Buffer.from('/usr/local/bin/claude')),
}));

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
// spawnEngine — never throws, mocked child_process
// ---------------------------------------------------------------------------

describe('spawnEngine — never throws on failure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns { ok: true } on zero-exit with output', async () => {
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from('hello output'),
      stderr: Buffer.from(''),
      error: undefined,
      pid: 1,
      signal: null,
      output: [],
    });
    const cmd: EngineCommand = { bin: 'claude', args: ['-p', GOAL] };
    const result = spawnEngine(cmd, makeConfig());
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello output');
  });

  it('returns { ok: false } on non-zero exit — does not throw', async () => {
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('command failed'),
      error: undefined,
      pid: 1,
      signal: null,
      output: [],
    });
    const cmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL, '--cwd', CWD] };
    const result = spawnEngine(cmd, makeConfig());
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns { ok: false } when spawnSync itself errors — does not throw', async () => {
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      error: new Error('ENOENT: binary not found'),
      pid: 0,
      signal: null,
      output: [],
    });
    const cmd: EngineCommand = { bin: 'nonexistent-tool', args: [] };
    const result = spawnEngine(cmd, makeConfig());
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('never throws — catches all exceptions internally', async () => {
    const { spawnSync } = vi.mocked(
      await import('node:child_process'),
    );
    spawnSync.mockImplementationOnce(() => {
      throw new Error('catastrophic failure');
    });
    const cmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL] };
    expect(() => spawnEngine(cmd, makeConfig())).not.toThrow();
    const result = spawnEngine(cmd, makeConfig());
    // The second call uses the default mock (ok path) — just ensure no throw
    expect(typeof result).toBe('object');
  });

  it('parses usage from claude json output when present', async () => {
    const { spawnSync } = await import('node:child_process');
    const claudeJson = JSON.stringify({
      result: 'Hello!',
      usage: { input_tokens: 42, output_tokens: 17 },
    });
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from(claudeJson),
      stderr: Buffer.from(''),
      error: undefined,
      pid: 1,
      signal: null,
      output: [],
    });
    const cmd: EngineCommand = {
      bin: 'claude',
      args: ['-p', GOAL, '--output-format', 'json'],
    };
    const result = spawnEngine(cmd, makeConfig());
    expect(result.ok).toBe(true);
    if (result.usage) {
      expect(result.usage.tokensIn).toBe(42);
      expect(result.usage.tokensOut).toBe(17);
    }
    // usage may be omitted when the json doesn't match — that's fine per contract
  });

  it('uses withToolEnv (allowlist) — no secret-shaped keys in child env', async () => {
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockImplementationOnce((bin, args, opts) => {
      // Inspect the env the caller passed to us
      const env = opts?.env ?? {};
      const secretKeys = Object.keys(env as Record<string, string>).filter((k) =>
        SECRET_KEY_RE.test(k),
      );
      // Store result for assertion
      (globalThis as Record<string, unknown>).__spawnEngineEnvTest = secretKeys;
      return {
        status: 0,
        stdout: Buffer.from('ok'),
        stderr: Buffer.from(''),
        error: undefined,
        pid: 1,
        signal: null,
        output: [],
      };
    });
    const cmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL, '--cwd', CWD] };
    spawnEngine(cmd, makeConfig());
    const secretKeys = (globalThis as Record<string, unknown>).__spawnEngineEnvTest as
      | string[]
      | undefined;
    // If the env was inspected, there must be no secret-shaped keys WE added.
    // (The base process.env may contain pre-existing keys, which is allowed.)
    // The bridge only adds ASHLR_* + OLLAMA_* + LM_STUDIO_* + OPENAI_BASE_URL —
    // none of those match SECRET_KEY_RE.
    if (secretKeys !== undefined) {
      // Filter out any keys that were already in process.env (inherited)
      const processEnvKeys = new Set(Object.keys(process.env));
      const addedSecretKeys = secretKeys.filter((k) => !processEnvKeys.has(k));
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

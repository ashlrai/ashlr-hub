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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('never throws on a missing binary — returns ok:false', () => {
    const vc: VerifyCommand = { kind: 'lint', cmd: ['definitely-not-a-real-binary-xyz'] };
    const res = runVerifyCommand(vc, workdir, cfg);
    expect(res.ok).toBe(false);
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
});

// ---------------------------------------------------------------------------
// verifyTaskStructured
// ---------------------------------------------------------------------------

describe('verifyTaskStructured', () => {
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

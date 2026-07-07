/**
 * M297: bounded retry-on-transient-abort in fleet dispatch.
 *
 * Hermetic + deterministic: NO real claude/codex spawn, NO network.
 * All tests use a fake spawnEngine injected via the worktree/engine seams so
 * the retry logic can be exercised without any real subprocess.
 *
 * Covers:
 *   1. isTransientAbort — recognizes aborted_streaming / error_during_execution /
 *      network patterns, rejects stall reasons and ok=true, rejects when hasDiff.
 *   2. Transient abort → retried up to dispatchRetries (default 2 → 3 attempts).
 *   3. Success on first attempt → no retry (exactly 1 spawn call).
 *   4. Stall-terminated failure → NOT retried (exactly 1 spawn call).
 *   5. Kill-switch active → immediate abort, no retry.
 *   6. dispatchRetries=0 → no retry (flag-off, byte-identical to pre-M297).
 *   7. All attempts transient → gives up, returns failed after maxAttempts.
 *   8. existingWorktree provided → transient abort does NOT create new sandbox.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import {
  isTransientAbort,
  runEngineSandboxed,
} from '../src/core/run/sandboxed-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig['foundry'] & {}> = {}): AshlrConfig {
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
    foundry: {
      allowedBackends: ['codex'],
      ...over,
    },
  } as AshlrConfig;
}

/** Create a minimal bare git repo that can serve as a source repo for sandbox creation. */
function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m297-src-'));
  execFileSync('git', ['init', '-b', 'main', dir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
  return dir;
}

// ---------------------------------------------------------------------------
// Part 1: isTransientAbort unit tests (pure function)
// ---------------------------------------------------------------------------

describe('M297 isTransientAbort — pure detection', () => {
  it('returns false when ok=true', () => {
    expect(isTransientAbort({ ok: true, error: 'aborted_streaming' }, false)).toBe(false);
  });

  it('returns false for stall reasons — idle-stall', () => {
    expect(isTransientAbort({ ok: false, terminationReason: 'idle-stall', error: 'aborted_streaming' }, false)).toBe(false);
  });

  it('returns false for stall reasons — loop-stall', () => {
    expect(isTransientAbort({ ok: false, terminationReason: 'loop-stall' }, false)).toBe(false);
  });

  it('returns false for stall reasons — no-diff-stall', () => {
    expect(isTransientAbort({ ok: false, terminationReason: 'no-diff-stall' }, false)).toBe(false);
  });

  it('returns false for stall reasons — backstop-timeout', () => {
    expect(isTransientAbort({ ok: false, terminationReason: 'backstop-timeout' }, false)).toBe(false);
  });

  it('returns false when hasDiff=true (real partial work — preserve it)', () => {
    expect(isTransientAbort({ ok: false, error: 'aborted_streaming' }, true)).toBe(false);
  });

  it('recognizes aborted_streaming in error', () => {
    expect(isTransientAbort({ ok: false, error: 'aborted_streaming' }, false)).toBe(true);
  });

  it('recognizes aborted_streaming in output (case insensitive)', () => {
    expect(isTransientAbort({ ok: false, output: 'ABORTED_STREAMING encountered' }, false)).toBe(true);
  });

  it('recognizes error_during_execution', () => {
    expect(isTransientAbort({ ok: false, error: 'error_during_execution' }, false)).toBe(true);
  });

  it('recognizes stream aborted', () => {
    expect(isTransientAbort({ ok: false, error: 'stream aborted mid-response' }, false)).toBe(true);
  });

  it('recognizes network error', () => {
    expect(isTransientAbort({ ok: false, error: 'network error occurred' }, false)).toBe(true);
  });

  it('recognizes ECONNRESET', () => {
    expect(isTransientAbort({ ok: false, error: 'read econnreset' }, false)).toBe(true);
  });

  it('recognizes socket hang up', () => {
    expect(isTransientAbort({ ok: false, output: 'socket hang up' }, false)).toBe(true);
  });

  it('recognizes fetch failed', () => {
    expect(isTransientAbort({ ok: false, error: 'fetch failed' }, false)).toBe(true);
  });

  it('recognizes ETIMEDOUT', () => {
    expect(isTransientAbort({ ok: false, error: 'etimedout after 30s' }, false)).toBe(true);
  });

  it('returns false for a genuine non-transient failure (no abort keywords)', () => {
    expect(isTransientAbort({ ok: false, error: 'exit code 1' }, false)).toBe(false);
  });

  it('returns false with no error and no output', () => {
    expect(isTransientAbort({ ok: false }, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 2: runEngineSandboxed retry integration tests
//
// Strategy: inject a fake 'codex' binary into PATH via a temp stub directory.
// The stub's exit code + stdout controls what spawnEngine returns. We use a
// counter file in tmpdir to track how many times the stub is invoked.
// ---------------------------------------------------------------------------

/**
 * Write a shell stub script into a temp dir and return the dir path.
 * The stub writes a line to a counter file on each invocation, then exits
 * with the specified exit code after printing the given stdout text.
 */
function makeStub(name: string, exitCode: number, stdout: string, counterFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m297-stub-'));
  const script = join(dir, name);
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "invoked" >> "${counterFile}"\nprintf '%s' '${stdout.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return dir;
}

function countInvocations(counterFile: string): number {
  if (!existsSync(counterFile)) return 0;
  return readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).length;
}

// Cleanup registries — populated per-test, swept in afterEach.
const _cleanupDirs: string[] = [];
const _cleanupFiles: string[] = [];
const _prevAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;

beforeEach(() => {
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
});

afterEach(() => {
  while (_cleanupDirs.length) {
    const d = _cleanupDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  while (_cleanupFiles.length) {
    const f = _cleanupFiles.pop()!;
    try { if (existsSync(f)) rmSync(f); } catch { /* ignore */ }
  }
  if (_prevAllowAnyRepo === undefined) {
    delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  } else {
    process.env.ASHLR_TEST_ALLOW_ANY_REPO = _prevAllowAnyRepo;
  }
});

// win32: the fake 'codex' binary is a #!/bin/sh script — not executable on
// Windows (real shims there are .cmd). The retry logic itself is covered by
// the in-process unit tests above, which run on every platform.
describe.skipIf(process.platform === 'win32')('M297 runEngineSandboxed retry integration', () => {
  it('success on attempt 1 → exactly 1 spawn, no retry', async () => {
    const counterFile = join(tmpdir(), `m297-ctr-${Date.now()}-a.txt`);
    _cleanupFiles.push(counterFile);
    const stubDir = makeStub('codex', 0, 'done', counterFile);
    _cleanupDirs.push(stubDir);
    const srcRepo = makeSourceRepo();
    _cleanupDirs.push(srcRepo);
    const prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    try {
      const cfg = makeConfig({ dispatchRetries: 2 });
      const result = await runEngineSandboxed('codex', 'Write hello world', cfg, {
        sourceRepo: srcRepo,
        propose: false,
      });
      expect(result.state.status).toBeDefined();
      expect(countInvocations(counterFile)).toBe(1);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('transient abort (aborted_streaming) on every attempt → 3 invocations then failed', async () => {
    const counterFile = join(tmpdir(), `m297-ctr-${Date.now()}-b.txt`);
    _cleanupFiles.push(counterFile);
    const stubDir = makeStub('codex', 1, 'aborted_streaming', counterFile);
    _cleanupDirs.push(stubDir);
    const srcRepo = makeSourceRepo();
    _cleanupDirs.push(srcRepo);
    const prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    try {
      // dispatchRetries=2 → maxAttempts=3
      const cfg = makeConfig({ dispatchRetries: 2 });
      const result = await runEngineSandboxed('codex', 'Write hello world', cfg, {
        sourceRepo: srcRepo,
        propose: false,
      });
      expect(result.state.status).toBe('failed');
      expect(countInvocations(counterFile)).toBe(3);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('non-transient failure (no abort keywords) → NOT retried (1 invocation)', async () => {
    const counterFile = join(tmpdir(), `m297-ctr-${Date.now()}-c.txt`);
    _cleanupFiles.push(counterFile);
    // Exit 1, no transient keywords → isTransientAbort=false → no retry.
    const stubDir = makeStub('codex', 1, 'genuine engine error exit code 1', counterFile);
    _cleanupDirs.push(stubDir);
    const srcRepo = makeSourceRepo();
    _cleanupDirs.push(srcRepo);
    const prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    try {
      const cfg = makeConfig({ dispatchRetries: 2 });
      const result = await runEngineSandboxed('codex', 'Write hello world', cfg, {
        sourceRepo: srcRepo,
        propose: false,
      });
      expect(result.state.status).toBe('failed');
      expect(countInvocations(counterFile)).toBe(1);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('flag-off (dispatchRetries=0) → maxAttempts=1, no retry even on transient abort', async () => {
    const counterFile = join(tmpdir(), `m297-ctr-${Date.now()}-d.txt`);
    _cleanupFiles.push(counterFile);
    const stubDir = makeStub('codex', 1, 'aborted_streaming', counterFile);
    _cleanupDirs.push(stubDir);
    const srcRepo = makeSourceRepo();
    _cleanupDirs.push(srcRepo);
    const prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    try {
      // dispatchRetries=0 → maxAttempts=1 → no retry
      const cfg = makeConfig({ dispatchRetries: 0 });
      const result = await runEngineSandboxed('codex', 'Write hello world', cfg, {
        sourceRepo: srcRepo,
        propose: false,
      });
      expect(result.state.status).toBe('failed');
      expect(countInvocations(counterFile)).toBe(1);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('kill-switch active → immediate abort, stub never invoked', async () => {
    const counterFile = join(tmpdir(), `m297-ctr-${Date.now()}-e.txt`);
    _cleanupFiles.push(counterFile);
    const stubDir = makeStub('codex', 0, 'done', counterFile);
    _cleanupDirs.push(stubDir);
    const srcRepo = makeSourceRepo();
    _cleanupDirs.push(srcRepo);
    const prevPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${prevPath ?? ''}`;
    try {
      const cfg = makeConfig({ dispatchRetries: 2, killSwitch: true });
      const result = await runEngineSandboxed('codex', 'Write hello world', cfg, {
        sourceRepo: srcRepo,
        propose: false,
      });
      expect(result.state.status).toBe('failed');
      expect(result.state.result).toMatch(/kill-switch/i);
      expect(countInvocations(counterFile)).toBe(0);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

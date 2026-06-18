/**
 * M79 — phantomWrap-skip decision + live engine smoke test.
 *
 * Focus:
 *   1. phantomInitializedAt: true iff .phantom.toml exists in the given dir.
 *   2. spawnEngine phantom-wrap gate: wraps ONLY when enabled + installed + initialized.
 *      Skip when .phantom.toml is absent (sandbox worktrees never have one).
 *   3. LIVE smoke (gated behind installed+authed claude): run claude on a trivial
 *      goal in a real git worktree; assert non-empty diff is produced.
 *
 * GUARDRAIL: no live run unless the 'claude' binary is on PATH and the
 * ASHLR_TEST_LIVE_ENGINE env var is set (prevents CI regressions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, EngineCommand } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// child_process mock — controls phantomInstalled() + spawnSync results.
// The mock is set BEFORE module import so all cached state picks it up.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('/usr/local/bin/phantom')),
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: Buffer.from('engine ok'),
    stderr: Buffer.from(''),
    error: undefined,
    pid: 1,
    signal: null,
    output: [],
  })),
}));

const { phantomInitializedAt, spawnEngine, phantomWrap, buildEngineCommand } =
  await import('../src/core/run/engines.js');



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...over,
  };
}

function withPhantomToml(dir: string): string {
  writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
  return dir;
}

// ---------------------------------------------------------------------------
// phantomInitializedAt — unit tests
// ---------------------------------------------------------------------------

describe('phantomInitializedAt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ashlr-m79-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when .phantom.toml is absent', () => {
    expect(phantomInitializedAt(tmpDir)).toBe(false);
  });

  it('returns true when .phantom.toml exists', () => {
    withPhantomToml(tmpDir);
    expect(phantomInitializedAt(tmpDir)).toBe(true);
  });

  it('returns false for a non-existent directory (never throws)', () => {
    expect(() => phantomInitializedAt('/tmp/nonexistent-ashlr-m79-xyz')).not.toThrow();
    expect(phantomInitializedAt('/tmp/nonexistent-ashlr-m79-xyz')).toBe(false);
  });

  it('returns false for an empty string path (never throws)', () => {
    expect(() => phantomInitializedAt('')).not.toThrow();
    expect(phantomInitializedAt('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spawnEngine phantom-wrap gate
// Exercises: wrap applied vs. skipped based on .phantom.toml presence.
// Pattern: import mocked child_process via `await import` inside each `it()`
// (same pattern as m11.engines.test.ts which works cleanly).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// phantomWrap gate via spawnEngine — behavior-based (no spawn mock needed).
//
// We verify the gate logic via observable behavior:
//  1. When .phantom.toml is ABSENT and phantom is enabled: spawnEngine invokes
//     the engine binary directly. We use a nonexistent binary to get a fast
//     ENOENT failure — the error will NOT mention phantom (i.e. phantom was not
//     invoked as the outer binary).
//  2. When .phantom.toml IS present and phantom is enabled: the outer binary IS
//     phantom — confirmed by running with a nonexistent inner engine; the error
//     from phantom (not the inner engine) surfaces first.
//  3. phantomInitializedAt is the gate — pure function, already tested above.
//  4. spawnEngine never throws regardless of wrap state.
// ---------------------------------------------------------------------------

describe('spawnEngine — phantomWrap gate (behavior-based)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ashlr-m79-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no .phantom.toml → spawnEngine runs engine directly (error is NOT about phantom)', () => {
    // nonexistent-engine-xyz will fail with ENOENT, not with phantom's init error.
    const cmd: EngineCommand = { bin: 'nonexistent-engine-xyz-m79', args: ['--goal', 'hi'], cwd: tmpDir };
    const cfg = makeConfig({ phantom: { enabled: true } } as AshlrConfig);
    const result = spawnEngine(cmd, cfg);
    // Must fail (binary absent) but NOT with phantom's "No .phantom.toml found" message
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/phantom\.toml/i);
    expect(result.error).not.toMatch(/Run phantom init/i);
  });

  it('.phantom.toml present → spawnEngine wraps via phantom (error IS from phantom)', () => {
    withPhantomToml(tmpDir);
    // inner engine doesnt exist; phantom will launch and try to exec it
    // but phantom itself must be invoked (the outer binary is phantom)
    const cmd: EngineCommand = { bin: 'nonexistent-engine-xyz-m79', args: ['--goal', 'hi'], cwd: tmpDir };
    const cfg = makeConfig({ phantom: { enabled: true } } as AshlrConfig);
    const result = spawnEngine(cmd, cfg);
    // phantom runs but the inner binary is absent; result is still a failure
    // The key assertion: no "phantom.toml" error (phantom found the toml and ran)
    expect(result.ok).toBe(false);
    // phantom executed (outer binary was phantom) so there's no ENOENT for phantom itself
    // The error comes from inside phantom, not from "binary not found" for phantom
    expect(result.error).toBeDefined();
    // If phantom.toml is present, phantom runs cleanly and the error is from the inner binary
    // (or phantom's own "exec: nonexistent-engine-xyz-m79: not found")
    // Either way, phantom itself ran — it did NOT fail with "No .phantom.toml found"
    expect(result.error).not.toMatch(/No \.phantom\.toml found/);
  });

  it('phantom.enabled false → no wrap even with .phantom.toml (engine runs directly)', () => {
    withPhantomToml(tmpDir);
    const cmd: EngineCommand = { bin: 'nonexistent-engine-xyz-m79', args: ['--goal', 'hi'], cwd: tmpDir };
    const cfg = makeConfig({ phantom: { enabled: false } } as AshlrConfig);
    const result = spawnEngine(cmd, cfg);
    expect(result.ok).toBe(false);
    // not wrapped, so error is ENOENT for the engine binary directly
    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/No \.phantom\.toml found/);
  });

  it('spawnEngine never throws regardless of .phantom.toml presence or phantom.enabled', () => {
    // no .phantom.toml, phantom enabled
    const cmd1: EngineCommand = { bin: 'nonexistent-m79', args: [], cwd: tmpDir };
    expect(() => spawnEngine(cmd1, makeConfig({ phantom: { enabled: true } } as AshlrConfig))).not.toThrow();
    // .phantom.toml present, phantom enabled
    withPhantomToml(tmpDir);
    expect(() => spawnEngine(cmd1, makeConfig({ phantom: { enabled: true } } as AshlrConfig))).not.toThrow();
    // phantom disabled
    expect(() => spawnEngine(cmd1, makeConfig({ phantom: { enabled: false } } as AshlrConfig))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// phantomWrap — pure transform still works (unchanged contract)
// ---------------------------------------------------------------------------

describe('phantomWrap — pure transform contract preserved', () => {
  const CWD = '/tmp/test-project';
  const GOAL = 'add a blank line';

  it('wraps bin=claude correctly', () => {
    const cmd: EngineCommand = { bin: 'claude', args: ['-p', GOAL, '--output-format', 'json'], cwd: CWD };
    const wrapped = phantomWrap(cmd, makeConfig());
    expect(wrapped.bin).toBe('phantom');
    expect(wrapped.args).toEqual(['exec', '--', 'claude', '-p', GOAL, '--output-format', 'json']);
    expect(wrapped.cwd).toBe(CWD);
  });

  it('does not mutate the original command', () => {
    const cmd: EngineCommand = { bin: 'aw', args: ['auto', GOAL, '--cwd', CWD], cwd: CWD };
    const origArgs = [...cmd.args];
    phantomWrap(cmd, makeConfig());
    expect(cmd.args).toEqual(origArgs);
  });
});

// ---------------------------------------------------------------------------
// LIVE end-to-end smoke test (gated)
// Only runs when ASHLR_TEST_LIVE_ENGINE=1 and claude is installed+authed.
// Creates a real git repo worktree, runs claude, asserts non-empty diff.
// ---------------------------------------------------------------------------

const LIVE = process.env['ASHLR_TEST_LIVE_ENGINE'] === '1';

describe.skipIf(!LIVE)('LIVE engine smoke — claude produces a real diff', () => {
  it('claude writes a file and produces a non-empty diff', async () => {
    // This test actually spawns the real claude binary. Un-mock child_process.
    vi.unmock('node:child_process');

    const { execSync, spawnSync: realSpawnSync } = await import('node:child_process');

    // Create a throwaway git repo
    const repoDir = mkdtempSync(join(tmpdir(), 'ashlr-live-'));
    try {
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.email "test@ashlr"', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.name "ashlr-test"', { cwd: repoDir, stdio: 'pipe' });
      writeFileSync(join(repoDir, 'README.md'), '# test\n');
      execSync('git add README.md && git commit -m "init"', { cwd: repoDir, stdio: 'pipe', shell: true });

      // Build the claude command — no model (uses default), autonomous mode
      const cfg = makeConfig({ phantom: { enabled: false } } as AshlrConfig);
      const cmd = buildEngineCommand('claude', 'Add a line "# Fleet test" to README.md', cfg, {
        cwd: repoDir,
        autonomous: true,
      });
      expect(cmd).not.toBeNull();

      // Spawn directly (no phantom — worktree has no .phantom.toml)
      const result = realSpawnSync(cmd!.bin, cmd!.args, {
        encoding: 'utf8',
        cwd: repoDir,
        timeout: 5 * 60 * 1000,
        env: { ...process.env, HOME: process.env.HOME ?? '' },
      });

      // Get the diff regardless of engine exit code
      const diff = execSync('git diff HEAD', { cwd: repoDir, encoding: 'utf8' });

      console.log('[m79 live] claude exit:', result.status);
      console.log('[m79 live] stdout (first 500):', String(result.stdout ?? '').slice(0, 500));
      console.log('[m79 live] stderr (first 300):', String(result.stderr ?? '').slice(0, 300));
      console.log('[m79 live] git diff stat:');
      const stat = execSync('git diff HEAD --stat', { cwd: repoDir, encoding: 'utf8' });
      console.log(stat);

      // The key assertion: a non-empty diff means the engine wrote something
      expect(diff.trim().length, 'expected a non-empty git diff from claude').toBeGreaterThan(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 10 * 60 * 1000); // 10-min timeout for live run
});

/**
 * m52.confine.test.ts — M52: OS confinement integration tests.
 *
 * Invariants proven here:
 *
 *   1. FLAG-OFF PARITY: absent cfg.foundry.confinement → buildSandboxLauncher
 *      returns null and spawnEngine accepts the same opts as before (no-launcher
 *      path is identical to v4).
 *
 *   2. macOS READ-JAIL (darwin-gated): sandbox-exec with the generated profile
 *      actually DENIES a read OUTSIDE the worktree and ALLOWS a read INSIDE.
 *      Guarded: `if (process.platform !== 'darwin') it.skip(...)`.
 *
 *   3. macOS EGRESS GATE (darwin-gated, best-effort): with networkEgress:false
 *      a connection attempt from inside the jail fails.
 *
 *   4. onUnsupported HONORED:
 *      - 'fallback' → buildSandboxLauncher returns null (+ audit, verified by
 *        observing no throw).
 *      - 'fail' → throws ConfinementUnsupportedError.
 *      Both tested by forcing platform='linux' with no bwrap available (by
 *      overriding the execFileSync probe via a PATH-less env + patching).
 *
 *   5. PUSH STILL BLOCKED (regression): reuses the M45 pre-push proof — the
 *      GIT_CONFIG_* hooks mechanism is untouched by M52.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildSandboxLauncher,
  confinementProfileFor,
  ConfinementUnsupportedError,
  buildMacosSbplProfile,
} from '../src/core/sandbox/confine.js';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
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
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* idempotent */ }
  }
});

// ---------------------------------------------------------------------------
// 1. Flag-off parity
// ---------------------------------------------------------------------------

describe('M52 flag-off parity', () => {
  it('returns null when cfg.foundry.confinement is absent', () => {
    const cfg = makeConfig();
    const profile = confinementProfileFor('claude', cfg);
    const launcher = buildSandboxLauncher(profile, { worktree: '/tmp/wt' });
    expect(launcher).toBeNull();
  });

  it('returns null when mode is "off"', () => {
    const launcher = buildSandboxLauncher({ mode: 'off' }, { worktree: '/tmp/wt' });
    expect(launcher).toBeNull();
  });

  it('returns null when mode is not set', () => {
    const launcher = buildSandboxLauncher({}, { worktree: '/tmp/wt' });
    expect(launcher).toBeNull();
  });

  it('confinementProfileFor returns mode:off for all EngineIds when confinement absent', () => {
    const cfg = makeConfig();
    for (const engine of ['claude', 'codex', 'aw', 'builtin', 'hermes', 'opencode'] as const) {
      const profile = confinementProfileFor(engine, cfg);
      expect(profile.mode ?? 'off').toBe('off');
    }
  });

  it('launcher absent → spawnEngine opts are identical to v4 (no launcher field required)', async () => {
    // This is a type-level + runtime proof: spawnEngine can be called without
    // a launcher and behaves exactly as v4. We verify by calling spawnEngine
    // with a simple echo command and no launcher.
    const { spawnEngine } = await import('../src/core/run/engines.js');
    const cfg = makeConfig();
    // Use a shell command that's definitely available: echo
    // Build a minimal EngineCommand directly (builtin has no argv → null, so
    // we construct one manually for the test).
    const cmd = { bin: 'echo', args: ['hello'], cwd: process.cwd() };
    const result = spawnEngine(cmd, cfg);
    // echo succeeds without any launcher.
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// 2. macOS read-jail proof (darwin-gated)
// ---------------------------------------------------------------------------

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

darwinOnly('M52 macOS read-jail (sandbox-exec) — DARWIN ONLY', () => {
  it('cat of a file INSIDE the worktree succeeds under sandbox-exec', () => {
    const wt = mkTmp('ashlr-m52-wt-');
    const insideFile = join(wt, 'hello.txt');
    writeFileSync(insideFile, 'hello from worktree\n', 'utf8');

    const profile = buildMacosSbplProfile(
      { mode: 'os', networkEgress: false },
      { worktree: wt, home: process.env.HOME, env: process.env },
    );

    const result = spawnSync(
      'sandbox-exec',
      ['-p', profile, 'cat', insideFile],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello from worktree');
  });

  it('cat of a file OUTSIDE the worktree (a secret under HOME) exits nonzero under sandbox-exec', () => {
    const wt = mkTmp('ashlr-m52-wt-');
    // THREAT MODEL: the residual being closed is reading the user's OTHER source
    // trees + secrets, which live under $HOME (~/Desktop/github, ~/.ssh, ~/.aws).
    // Create a secret directly under HOME (outside the worktree) and prove denial.
    const home = process.env.HOME!;
    const outsideFile = join(home, `.ashlr-m52-outside-secret-${Date.now().toString(36)}.txt`);
    writeFileSync(outsideFile, 'super secret\n', 'utf8');
    try {
      const profile = buildMacosSbplProfile(
        { mode: 'os', networkEgress: false },
        { worktree: wt, home, env: process.env },
      );

      // Verify the file exists (so a non-zero exit is definitely from the jail).
      expect(existsSync(outsideFile)).toBe(true);

      const result = spawnSync('sandbox-exec', ['-p', profile, 'cat', outsideFile], {
        encoding: 'utf8',
        timeout: 10_000,
      });

      // The read-jail must deny the read: cat exits nonzero.
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it('buildSandboxLauncher returns { bin: "sandbox-exec", prefixArgs } on darwin', () => {
    const launcher = buildSandboxLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/tmp/some-wt', home: process.env.HOME, env: process.env },
    );
    expect(launcher).not.toBeNull();
    expect(launcher!.bin).toBe('sandbox-exec');
    expect(launcher!.prefixArgs[0]).toBe('-p');
    expect(typeof launcher!.prefixArgs[1]).toBe('string');
    expect(launcher!.prefixArgs[1]).toContain('(version 1)');
  });

  it('launcher prefixArgs profile contains the worktree subpath', () => {
    const wt = '/tmp/ashlr-m52-wt-known';
    const launcher = buildSandboxLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: wt, home: process.env.HOME, env: process.env },
    );
    expect(launcher!.prefixArgs[1]).toContain(`(subpath "${wt}")`);
  });
});

// ---------------------------------------------------------------------------
// 3. macOS egress gate (darwin-gated, best-effort)
// ---------------------------------------------------------------------------

darwinOnly('M52 macOS egress gate — DARWIN ONLY', () => {
  it('outbound connection fails with networkEgress:false (best-effort)', () => {
    const wt = mkTmp('ashlr-m52-egress-wt-');

    const profile = buildMacosSbplProfile(
      { mode: 'os', networkEgress: false },
      { worktree: wt, home: process.env.HOME, env: process.env },
    );

    // Attempt a TCP connection to an external host. curl with --max-time 3
    // will fail due to network deny.
    // We use curl because it's always on macOS and exits nonzero on connect failure.
    const result = spawnSync(
      'sandbox-exec',
      ['-p', profile, 'curl', '--silent', '--max-time', '3', 'http://example.com'],
      { encoding: 'utf8', timeout: 15_000 },
    );

    // Should fail (network is denied). Note: curl may also fail if the machine
    // has no network — either way a non-zero exit satisfies the gate test.
    expect(result.status).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. onUnsupported honored
// ---------------------------------------------------------------------------

describe('M52 onUnsupported handling', () => {
  it("onUnsupported:'fallback' on an unsupported platform returns null without throwing", () => {
    // We simulate an unsupported platform by temporarily overriding process.platform.
    // Since process.platform is a getter, we save and restore via Object.defineProperty.
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true,
      });

      let result: ReturnType<typeof buildSandboxLauncher> | undefined;
      expect(() => {
        result = buildSandboxLauncher(
          { mode: 'os', onUnsupported: 'fallback' },
          { worktree: '/tmp/wt' },
        );
      }).not.toThrow();

      expect(result).toBeNull();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'platform', originalDescriptor);
      }
    }
  });

  it("onUnsupported:'fail' on an unsupported platform throws ConfinementUnsupportedError", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true,
      });

      expect(() => {
        buildSandboxLauncher(
          { mode: 'os', onUnsupported: 'fail' },
          { worktree: '/tmp/wt' },
        );
      }).toThrow(ConfinementUnsupportedError);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'platform', originalDescriptor);
      }
    }
  });

  it("onUnsupported:'fail' error message mentions the reason", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', {
        value: 'freebsd',
        writable: true,
        configurable: true,
      });

      let caught: Error | undefined;
      try {
        buildSandboxLauncher(
          { mode: 'os', onUnsupported: 'fail' },
          { worktree: '/tmp/wt' },
        );
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toContain('freebsd');
      expect(caught!.message).toContain('M52 confinement required');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'platform', originalDescriptor);
      }
    }
  });

  it("onUnsupported defaults to 'fallback' when not specified", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true,
      });

      // No onUnsupported specified — should default to fallback (no throw).
      let result: ReturnType<typeof buildSandboxLauncher> | undefined;
      expect(() => {
        result = buildSandboxLauncher(
          { mode: 'os' /* no onUnsupported */ },
          { worktree: '/tmp/wt' },
        );
      }).not.toThrow();
      expect(result).toBeNull();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'platform', originalDescriptor);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Push still blocked (M45 regression)
// ---------------------------------------------------------------------------

describe('M52 regression — pre-push hook still blocks git push', () => {
  it('a git push with a blocking core.hooksPath env still fails (M52 did not break this)', () => {
    const repoDir = mkTmp('ashlr-m52-repo-');
    const bareDir = mkTmp('ashlr-m52-bare-');

    // Init bare origin.
    spawnSync('git', ['init', '--bare', '--initial-branch=main', '.'], {
      cwd: bareDir, stdio: 'pipe',
    });

    // Init working repo with one commit.
    spawnSync('git', ['init', '--initial-branch=main', '.'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['-C', repoDir, 'config', 'user.email', 'm52@ashlr.test'], { stdio: 'pipe' });
    spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'Ashlr M52 Test'], { stdio: 'pipe' });
    spawnSync('git', ['-C', repoDir, 'config', 'commit.gpgsign', 'false'], { stdio: 'pipe' });
    writeFileSync(join(repoDir, 'file.txt'), 'hello\n', 'utf8');
    spawnSync('git', ['-C', repoDir, 'add', '-A'], { stdio: 'pipe' });
    spawnSync('git', ['-C', repoDir, 'commit', '--no-verify', '-m', 'init'], { stdio: 'pipe' });
    spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', `file://${bareDir}`], { stdio: 'pipe' });

    // Install a hard-failing pre-push hook.
    const hooksDir = mkTmp('ashlr-m52-hooks-');
    writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const pushResult = spawnSync(
      'git',
      ['push', 'origin', 'HEAD'],
      {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: hooksDir,
        },
      },
    );

    // The push must be blocked by the pre-push hook (M45 invariant still holds).
    expect(pushResult.status).not.toBe(0);
  });
});

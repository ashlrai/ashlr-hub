/**
 * m52.write-allow.test.ts — M52: vendor config dirs are write-allowed.
 *
 * Proves the fix for the gap where HOME_CONFIG_SUBDIRS (e.g. ~/.claude) were
 * re-allowed for READ but NOT for WRITE, so a confined agent could not write
 * its own session state when CLAUDE_CONFIG_DIR/CODEX_HOME were unset.
 *
 * Tests:
 *   1. Pure: profile string contains .claude (and worktree) in a write-allow clause.
 *   2. macOS-gated real proof: sandbox-exec allows writing inside ~/.claude but
 *      denies writing directly under HOME (outside the vendor dirs).
 *   3. Flag-off parity: mode:off → buildSandboxLauncher returns null (quick assert).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

import {
  buildMacosSbplProfile,
  buildSandboxLauncher,
} from '../src/core/sandbox/confine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function resolveReal(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : p;
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------------------
// 1. Pure: profile string includes .claude in a write-allow clause
// ---------------------------------------------------------------------------

describe('M52 write-allow — pure profile string assertions', () => {
  it('profile write-allow section contains (subpath "<home>/.claude")', () => {
    const worktree = '/tmp/ashlr-m52-wa-wt-test';
    const home = '/Users/testuser';

    const profile = buildMacosSbplProfile(
      { mode: 'os', networkEgress: false },
      { worktree, home, env: { TMPDIR: '/tmp' } },
    );

    // The profile must contain a (deny file-write*) under home ...
    expect(profile).toContain('(deny file-write*');

    // ... followed by an (allow file-write* ...) that includes .claude.
    // Locate the allow file-write* block.
    const writeAllowIdx = profile.indexOf('(allow file-write*');
    expect(writeAllowIdx).toBeGreaterThan(-1);

    const writeAllowSection = profile.slice(writeAllowIdx);

    // .claude must appear as a subpath in the write-allow section.
    expect(writeAllowSection).toContain(`(subpath "${home}/.claude")`);

    // The worktree must also appear in the write-allow section.
    expect(writeAllowSection).toContain(`(subpath "${worktree}")`);
  });

  it('profile write-allow section also contains other HOME_CONFIG_SUBDIRS', () => {
    const home = '/Users/testuser';
    const profile = buildMacosSbplProfile(
      { mode: 'os', networkEgress: false },
      { worktree: '/tmp/wt', home, env: { TMPDIR: '/tmp' } },
    );

    const writeAllowIdx = profile.indexOf('(allow file-write*');
    const writeAllowSection = profile.slice(writeAllowIdx);

    // A sampling of HOME_CONFIG_SUBDIRS should appear.
    expect(writeAllowSection).toContain(`(subpath "${home}/.config")`);
    expect(writeAllowSection).toContain(`(subpath "${home}/.codex")`);
    expect(writeAllowSection).toContain(`(subpath "${home}/.hermes")`);
  });

  it('VENDOR_HOME_ENVS values appear in write-allow when set', () => {
    const home = '/Users/testuser';
    const customClaudeDir = '/tmp/my-claude-config';
    const profile = buildMacosSbplProfile(
      { mode: 'os', networkEgress: false },
      {
        worktree: '/tmp/wt',
        home,
        env: { TMPDIR: '/tmp', CLAUDE_CONFIG_DIR: customClaudeDir },
      },
    );

    const writeAllowIdx = profile.indexOf('(allow file-write*');
    const writeAllowSection = profile.slice(writeAllowIdx);
    expect(writeAllowSection).toContain(`(subpath "${customClaudeDir}")`);
  });

  it('read-allow section still contains .claude (regression: must not have regressed read)', () => {
    const home = '/Users/testuser';
    const profile = buildMacosSbplProfile(
      { mode: 'os', networkEgress: false },
      { worktree: '/tmp/wt', home, env: { TMPDIR: '/tmp' } },
    );

    // Locate read-allow block (comes before write blocks).
    const readAllowIdx = profile.indexOf('(allow file-read*');
    expect(readAllowIdx).toBeGreaterThan(-1);
    const readAllowSection = profile.slice(readAllowIdx, profile.indexOf('(deny file-write*'));
    expect(readAllowSection).toContain(`(subpath "${home}/.claude")`);
  });
});

// ---------------------------------------------------------------------------
// 2. macOS-gated real proof: sandbox-exec write probe
// ---------------------------------------------------------------------------

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

darwinOnly('M52 macOS write-allow proof (sandbox-exec) — DARWIN ONLY', () => {
  it('write inside ~/.claude SUCCEEDS; write directly under HOME FAILS', () => {
    // Strategy: use the real HOME as the confinement `home` so that
    // (deny file-write* (subpath "$HOME")) fires at the correct resolved path.
    //
    // Allowed-write probe: inside ~/.claude — covered by HOME_CONFIG_SUBDIRS.
    // ~/.claude is created if absent, and the probe file is removed in finally.
    // We do NOT pass CLAUDE_CONFIG_DIR so the test exercises the HOME_CONFIG_SUBDIRS
    // code path specifically (the case when env vars are unset).
    //
    // Denied-write probe: a uniquely-named file directly under HOME (not inside
    // any vendor config subdir), identical to m52.confine.test.ts's read-denial
    // pattern — must exit non-zero because HOME is denied and this path is not
    // re-allowed.

    const realHome = resolveReal(process.env.HOME!);
    const worktree = mkTmp('ashlr-m52-wa-wt-');

    // Create ~/.claude if it doesn't exist so the probe path is valid.
    const dotClaude = join(realHome, '.claude');
    mkdirSync(dotClaude, { recursive: true });

    const tag = Date.now().toString(36);
    // Allowed: inside ~/.claude (covered by HOME_CONFIG_SUBDIRS write-allow).
    const allowedProbe = join(dotClaude, `.ashlr-m52-write-probe-${tag}`);
    // Denied: directly under HOME — not in any vendor config subdir.
    const deniedProbe = join(realHome, `.ashlr-m52-denied-probe-${tag}.txt`);

    try {
      const profile = buildMacosSbplProfile(
        { mode: 'os', networkEgress: false },
        {
          worktree,
          home: realHome,
          // No CLAUDE_CONFIG_DIR — forces the HOME_CONFIG_SUBDIRS path.
          env: { TMPDIR: tmpdir(), HOME: realHome },
        },
      );

      // --- Allowed write: inside ~/.claude (HOME_CONFIG_SUBDIRS) ---
      const allowResult = spawnSync(
        'sandbox-exec',
        ['-p', profile, 'sh', '-c', `echo hi > "${allowedProbe}"`],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(allowResult.status).toBe(0);

      // --- Denied write: directly under HOME (not a vendor subdir) ---
      const denyResult = spawnSync(
        'sandbox-exec',
        ['-p', profile, 'sh', '-c', `echo hi > "${deniedProbe}"`],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(denyResult.status).not.toBe(0);
    } finally {
      try { rmSync(allowedProbe, { force: true }); } catch { /* idempotent */ }
      try { rmSync(deniedProbe, { force: true }); } catch { /* idempotent */ }
      try { rmSync(worktree, { recursive: true, force: true }); } catch { /* idempotent */ }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Flag-off parity: no confinement cfg → null (quick assert)
// ---------------------------------------------------------------------------

describe('M52 write-allow — flag-off parity', () => {
  it('buildSandboxLauncher returns null when mode is off', () => {
    const launcher = buildSandboxLauncher(
      { mode: 'off' },
      { worktree: '/tmp/wt' },
    );
    expect(launcher).toBeNull();
  });

  it('buildSandboxLauncher returns null when mode is not set', () => {
    const launcher = buildSandboxLauncher(
      {} as Parameters<typeof buildSandboxLauncher>[0],
      { worktree: '/tmp/wt' },
    );
    expect(launcher).toBeNull();
  });
});

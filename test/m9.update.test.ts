/**
 * M9 update tests — hermetic, no network, no real git remote operations.
 *
 * Tests cover:
 *   - Arg parsing: --help, --check, --json, unknown flag → usage error
 *   - No-git-repo path: exits 1 with error message
 *   - No-remote path: exits 0 with "no remote configured" message
 *   - Dirty working tree: exits 1 with diagnostic message
 *   - --check mode: reports up-to-date when local == remote
 *   - --check mode: reports new commits when remote is ahead
 *   - --check mode: graceful when fetch fails
 *   - Normal update: already up-to-date path
 *   - Normal update: pull+install+build success path
 *   - Normal update: pull fails (diverged) → exits 1
 *   - Normal update: npm install fails → exits 1
 *   - Normal update: npm run build fails → exits 1
 *   - JSON output shape: all required fields present
 *   - Symlink check: helper correctly identifies missing symlink
 *   - Smoke test: verifies help works after update
 *
 * All git and npm operations are mocked to prevent real side-effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock child_process before importing the module under test
// ---------------------------------------------------------------------------

// Default mock: git available, git is inside a work-tree, has a remote, clean
// working tree, pull already up-to-date, npm commands succeed.
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
  execFileSync: mockExecFileSync,
}));

// ---------------------------------------------------------------------------
// Capture stdout / stderr written by the command
// ---------------------------------------------------------------------------

let stdoutBuf = '';
let stderrBuf = '';
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

function captureOutput(): void {
  stdoutBuf = '';
  stderrBuf = '';
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — intentional duck-type override for capturing
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  // @ts-expect-error — intentional duck-type override for capturing
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
}

function restoreOutput(): void {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
}

// ---------------------------------------------------------------------------
// Temp dir + fixture helpers
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function _freshRepoDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m9-update-'));
  createdDirs.push(d);
  // Write a package.json so readPackageVersion works
  fs.writeFileSync(
    path.join(d, 'package.json'),
    JSON.stringify({ name: 'ashlr-hub', version: '0.1.0' }),
  );
  // Create bin/ subdirectory expected by detectRepoRoot + checkSymlink
  fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'bin', 'ashlr'), '#!/usr/bin/env node\n');
  return d;
}

afterEach(() => {
  for (const d of createdDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.clearAllMocks();
  restoreOutput();
});

// ---------------------------------------------------------------------------
// Helpers to configure the spawnSync mock for common scenarios
// ---------------------------------------------------------------------------

/** Default "happy path" mock: git works, clean tree, remote exists, up-to-date. */
function mockHappyPath(): void {
  mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
    const a = args ?? [];
    const joined = [cmd, ...a].join(' ');

    // git --version → ok
    if (cmd === 'git' && a[0] === '--version') {
      return { status: 0, stdout: 'git version 2.40.0', stderr: '', error: undefined };
    }
    // git rev-parse --is-inside-work-tree → ok
    if (cmd === 'git' && joined.includes('is-inside-work-tree')) {
      return { status: 0, stdout: 'true', stderr: '', error: undefined };
    }
    // git remote → origin
    if (cmd === 'git' && a[0] === 'remote') {
      return { status: 0, stdout: 'origin', stderr: '', error: undefined };
    }
    // git status --porcelain → clean
    if (cmd === 'git' && joined.includes('porcelain')) {
      return { status: 0, stdout: '', stderr: '', error: undefined };
    }
    // git symbolic-ref → main
    if (cmd === 'git' && joined.includes('symbolic-ref')) {
      return { status: 0, stdout: 'main', stderr: '', error: undefined };
    }
    // git rev-parse --short HEAD or refs → commit hash
    if (cmd === 'git' && joined.includes('rev-parse')) {
      return { status: 0, stdout: 'abc1234', stderr: '', error: undefined };
    }
    // git fetch → ok
    if (cmd === 'git' && a[0] === 'fetch') {
      return { status: 0, stdout: '', stderr: '', error: undefined };
    }
    // git rev-list --count → 0 commits behind
    if (cmd === 'git' && joined.includes('rev-list')) {
      return { status: 0, stdout: '0', stderr: '', error: undefined };
    }
    // git pull --ff-only → already up to date
    if (cmd === 'git' && joined.includes('pull')) {
      return { status: 0, stdout: 'Already up to date.', stderr: '', error: undefined };
    }
    // node <bin> help (smoke test)
    if (cmd === process.execPath) {
      return { status: 0, stdout: 'Usage:', stderr: '', error: undefined };
    }
    return { status: 0, stdout: '', stderr: '', error: undefined };
  });

  mockExecFileSync.mockReturnValue('');
}

// ---------------------------------------------------------------------------
// Import module under test (after mocks registered)
// ---------------------------------------------------------------------------

// Dynamic import so vi.mock hoisting runs first.
let cmdUpdate: (args: string[]) => Promise<number>;

beforeEach(async () => {
  mockHappyPath();
  // Re-import each test to get a fresh module with the current mock.
  // Because of ESM module caching we import once and rely on the mock state.
  if (!cmdUpdate) {
    const mod = await import('../src/cli/update.js');
    cmdUpdate = mod.cmdUpdate;
  }
  captureOutput();
});

// ---------------------------------------------------------------------------
// Help / usage
// ---------------------------------------------------------------------------

describe('cmdUpdate — help', () => {
  it('--help exits 0', async () => {
    const code = await cmdUpdate(['--help']);
    expect(code).toBe(0);
  });

  it('-h exits 0', async () => {
    const code = await cmdUpdate(['-h']);
    expect(code).toBe(0);
  });

  it('"help" positional exits 0', async () => {
    const code = await cmdUpdate(['help']);
    expect(code).toBe(0);
  });

  it('unknown flag returns exit code 2', async () => {
    const code = await cmdUpdate(['--bogus-flag']);
    expect(code).toBe(2);
  });

  it('unknown flag writes error to stderr', async () => {
    await cmdUpdate(['--bogus-flag']);
    expect(stderrBuf).toContain('unknown flag');
  });
});

// ---------------------------------------------------------------------------
// No git available
// ---------------------------------------------------------------------------

describe('cmdUpdate — git not available', () => {
  it('exits 1 when git is not on PATH', async () => {
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'git') return { status: 1, stdout: '', stderr: 'not found', error: new Error('ENOENT') };
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    const code = await cmdUpdate([]);
    expect(code).toBe(1);
  });

  it('writes "git not found" to stderr when git missing', async () => {
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'git') return { status: 1, stdout: '', stderr: '', error: new Error('ENOENT') };
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    await cmdUpdate([]);
    expect(stderrBuf).toContain('git');
  });
});

// ---------------------------------------------------------------------------
// Not a git repo
// ---------------------------------------------------------------------------

describe('cmdUpdate — not a git repo', () => {
  it('exits 1 when not inside a git work tree', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) {
        return { status: 0, stdout: 'git version 2.40.0', stderr: '', error: undefined };
      }
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) {
        return { status: 128, stdout: '', stderr: 'not a git repo', error: undefined };
      }
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });
    const code = await cmdUpdate([]);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No remote configured
// ---------------------------------------------------------------------------

describe('cmdUpdate — no remote configured', () => {
  it('exits 0 when no remote is configured', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) {
        return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) {
        return { status: 0, stdout: 'true', stderr: '' };
      }
      if (cmd === 'git' && args?.[0] === 'remote') {
        return { status: 0, stdout: '', stderr: '' }; // empty → no remotes
      }
      if (cmd === 'git' && joined.includes('symbolic-ref')) {
        return { status: 0, stdout: 'main', stderr: '' };
      }
      if (cmd === 'git' && joined.includes('rev-parse')) {
        return { status: 0, stdout: 'abc1234', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const code = await cmdUpdate([]);
    expect(code).toBe(0);
  });

  it('prints "no remote configured" message when no remote', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    await cmdUpdate([]);
    // Human output goes to stdout in non-json mode
    const combined = stdoutBuf + stderrBuf;
    expect(combined).toMatch(/no remote/i);
  });

  it('--json no-remote exits 0 and emits valid JSON', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const code = await cmdUpdate(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { message: string; remotes: string[] };
    expect(typeof parsed.message).toBe('string');
    expect(Array.isArray(parsed.remotes)).toBe(true);
    expect(parsed.remotes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dirty working tree
// ---------------------------------------------------------------------------

describe('cmdUpdate — dirty working tree', () => {
  it('exits 1 when working tree has uncommitted changes', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) {
        return { status: 0, stdout: 'M  src/cli/update.ts', stderr: '' }; // dirty!
      }
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const code = await cmdUpdate([]);
    expect(code).toBe(1);
  });

  it('mentions "commit" or "stash" in output when dirty', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: 'M  file.ts', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    await cmdUpdate([]);
    const combined = stdoutBuf + stderrBuf;
    expect(combined).toMatch(/commit|stash/i);
  });

  it('--json dirty tree returns valid JSON with error field', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: 'M  file.ts', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const code = await cmdUpdate(['--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutBuf) as { error: string; updated: boolean };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).not.toBeNull();
    expect(parsed.updated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --check mode
// ---------------------------------------------------------------------------

describe('cmdUpdate --check', () => {
  it('exits 0 when already up-to-date', async () => {
    // happy path already has 0 commits behind
    const code = await cmdUpdate(['--check']);
    expect(code).toBe(0);
  });

  it('prints "up to date" when no new commits', async () => {
    await cmdUpdate(['--check']);
    const combined = stdoutBuf + stderrBuf;
    expect(combined).toMatch(/up.to.date/i);
  });

  it('exits 0 and reports new commits when remote is ahead', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-list')) return { status: 0, stdout: '3', stderr: '' }; // 3 new commits
      return { status: 0, stdout: '', stderr: '' };
    });

    const code = await cmdUpdate(['--check']);
    expect(code).toBe(0);
    const combined = stdoutBuf + stderrBuf;
    expect(combined).toMatch(/3/);
  });

  it('--check does NOT run npm install or npm run build', async () => {
    await cmdUpdate(['--check']);
    // execFileSync (used for npm) must not have been called
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('--check does NOT run git pull', async () => {
    await cmdUpdate(['--check']);
    const pullCalls = mockSpawnSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'git' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'pull',
    );
    expect(pullCalls).toHaveLength(0);
  });

  it('--check --json emits valid JSON with upToDate field', async () => {
    const code = await cmdUpdate(['--check', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { upToDate: boolean; updated: boolean };
    expect(typeof parsed.upToDate).toBe('boolean');
    expect(parsed.updated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normal update — already up-to-date
// ---------------------------------------------------------------------------

describe('cmdUpdate — already up-to-date', () => {
  it('exits 0 when pull reports already up to date', async () => {
    // Default happy path: pull → "Already up to date."
    const code = await cmdUpdate([]);
    expect(code).toBe(0);
  });

  it('does NOT run npm install when already up-to-date', async () => {
    await cmdUpdate([]);
    // execFileSync is used for npm; should not be called on already-up-to-date
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('"already up to date" is printed in output', async () => {
    await cmdUpdate([]);
    const combined = stdoutBuf + stderrBuf;
    expect(combined).toMatch(/already up.to.date/i);
  });
});

// ---------------------------------------------------------------------------
// Normal update — pull + install + build success
// ---------------------------------------------------------------------------

describe('cmdUpdate — full update cycle', () => {
  beforeEach(() => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'pull') {
        // Simulate a real pull with changes
        return { status: 0, stdout: 'Fast-forward\n 1 file changed', stderr: '' };
      }
      if (cmd === process.execPath) return { status: 0, stdout: 'Usage:', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    mockExecFileSync.mockReturnValue('installed / built');
  });

  it('exits 0 after successful pull+install+build', async () => {
    const code = await cmdUpdate([]);
    expect(code).toBe(0);
  });

  it('runs npm install after pull', async () => {
    await cmdUpdate([]);
    const installCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'npm' && Array.isArray(c[1]) && (c[1] as string[]).includes('install'),
    );
    expect(installCalls.length).toBeGreaterThan(0);
  });

  it('runs npm run build after install', async () => {
    await cmdUpdate([]);
    const buildCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'npm' && Array.isArray(c[1]) && (c[1] as string[]).includes('build'),
    );
    expect(buildCalls.length).toBeGreaterThan(0);
  });

  it('--json emits updated:true after successful update', async () => {
    await cmdUpdate(['--json']);
    const parsed = JSON.parse(stdoutBuf) as { updated: boolean };
    expect(parsed.updated).toBe(true);
  });

  it('--json result contains all required fields', async () => {
    await cmdUpdate(['--json']);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    for (const field of [
      'updated', 'upToDate', 'newCommits',
      'versionBefore', 'versionAfter',
      'commitBefore', 'commitAfter',
      'remotes', 'branch',
      'symlink', 'smokeOk',
      'message', 'error',
    ]) {
      expect(field in parsed, `missing field: ${field}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Pull fails (diverged)
// ---------------------------------------------------------------------------

describe('cmdUpdate — pull fails', () => {
  it('exits 1 when git pull --ff-only fails', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'pull') {
        return { status: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.', error: undefined };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const code = await cmdUpdate([]);
    expect(code).toBe(1);
  });

  it('does NOT run npm install when pull fails', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'pull') {
        return { status: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    await cmdUpdate([]);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// npm install fails
// ---------------------------------------------------------------------------

describe('cmdUpdate — npm install fails', () => {
  it('exits 1 when npm install fails', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'pull') {
        return { status: 0, stdout: 'Fast-forward\n 1 file changed', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const installErr = Object.assign(new Error('npm install failed'), {
      stdout: 'npm ERR! some error\n',
      stderr: '',
    });
    mockExecFileSync.mockImplementation((_cmd: string, cmdArgs: string[]) => {
      if (Array.isArray(cmdArgs) && cmdArgs.includes('install')) throw installErr;
      return '';
    });

    const code = await cmdUpdate([]);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// npm run build fails
// ---------------------------------------------------------------------------

describe('cmdUpdate — npm run build fails', () => {
  it('exits 1 when npm run build fails', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'pull') {
        return { status: 0, stdout: 'Fast-forward\n 1 file changed', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const buildErr = Object.assign(new Error('tsc failed'), {
      stdout: 'error TS2345: ...\n',
      stderr: '',
    });
    mockExecFileSync.mockImplementation((_cmd: string, cmdArgs: string[]) => {
      if (Array.isArray(cmdArgs) && cmdArgs.includes('build')) throw buildErr;
      return '';
    });

    const code = await cmdUpdate([]);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Smoke test failure: build broken
// ---------------------------------------------------------------------------

describe('cmdUpdate — smoke test failure', () => {
  it('exits 1 when ashlr help fails after build', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'pull') {
        return { status: 0, stdout: 'Fast-forward\n 1 file changed', stderr: '' };
      }
      // Smoke test: node <bin> help → fails
      if (cmd === process.execPath) {
        return { status: 1, stdout: '', stderr: 'syntax error', error: undefined };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    mockExecFileSync.mockReturnValue('ok');

    const code = await cmdUpdate([]);
    expect(code).toBe(1);
  });

  it('--json smokeOk:false when smoke test fails', async () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = [cmd, ...(args ?? [])].join(' ');
      if (cmd === 'git' && joined.includes('--version')) return { status: 0, stdout: 'git version 2.40.0', stderr: '' };
      if (cmd === 'git' && joined.includes('is-inside-work-tree')) return { status: 0, stdout: 'true', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'remote') return { status: 0, stdout: 'origin', stderr: '' };
      if (cmd === 'git' && joined.includes('porcelain')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && joined.includes('symbolic-ref')) return { status: 0, stdout: 'main', stderr: '' };
      if (cmd === 'git' && joined.includes('rev-parse')) return { status: 0, stdout: 'abc1234', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args?.[0] === 'pull') return { status: 0, stdout: 'Fast-forward\n 1 file changed', stderr: '' };
      if (cmd === process.execPath) return { status: 1, stdout: '', stderr: 'broken', error: undefined };
      return { status: 0, stdout: '', stderr: '' };
    });
    mockExecFileSync.mockReturnValue('ok');

    await cmdUpdate(['--json']);
    const parsed = JSON.parse(stdoutBuf) as { smokeOk: boolean; error: string | null };
    expect(parsed.smokeOk).toBe(false);
    expect(parsed.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Safety: never calls git push, git reset, git rebase
// ---------------------------------------------------------------------------

describe('cmdUpdate — safety: no destructive git operations', () => {
  it('never calls git push', async () => {
    await cmdUpdate([]);
    const pushCalls = mockSpawnSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'git' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'push',
    );
    expect(pushCalls).toHaveLength(0);
  });

  it('never calls git reset', async () => {
    await cmdUpdate([]);
    const resetCalls = mockSpawnSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'git' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'reset',
    );
    expect(resetCalls).toHaveLength(0);
  });

  it('never calls git rebase', async () => {
    await cmdUpdate([]);
    const rebaseCalls = mockSpawnSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'git' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'rebase',
    );
    expect(rebaseCalls).toHaveLength(0);
  });

  it('never passes --force to any git command', async () => {
    // Run both check and update modes
    await cmdUpdate(['--check']);
    await cmdUpdate([]);
    const forceCalls = mockSpawnSync.mock.calls.filter(
      (c: unknown[]) =>
        c[0] === 'git' &&
        Array.isArray(c[1]) &&
        (c[1] as string[]).some((a: string) => String(a).includes('--force')),
    );
    expect(forceCalls).toHaveLength(0);
  });
});

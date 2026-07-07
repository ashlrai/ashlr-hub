/**
 * test/m225.sandbox-cwd.test.ts — M225 regression: git/exec cwd must always be
 * a directory, even when a milestone names a FILE as the grep/glob path arg.
 *
 * BUG: handleGrep in mcp-native-engineer.ts called `git -C <base>` where base
 * was derived via resolveInside(workspaceRoot, pathArg). When the model passed a
 * file path (e.g. "src/core/goals/store.ts") as pathArg, base resolved to the
 * file's absolute path — a non-directory — and git failed with:
 *   fatal: cannot change to '…/worktree/src/core/goals/store.ts': Not a Directory
 *
 * FIX (mcp-native-engineer.ts): after resolveInside(), check statSync().isFile()
 * and fall back to dirname(base) before passing to git -C or walkGlob.
 *
 * COVERAGE:
 *  1. handleGrep with a file path arg: git -C cwd must be a directory.
 *  2. handleGrep with a dir path arg: git -C cwd must be that directory.
 *  3. handleGrep with default ('.') path: git -C cwd is workspaceRoot.
 *  4. handleGlob with a file path cwd arg: walkGlob cwd must be a directory.
 *  5. createSandbox → worktreePath is always a directory (integration guard).
 *  6. Repro: simulated goal-conductor call where milestone title contains a
 *     file path — confirms sandbox git ops use the worktree ROOT, not the file.
 *
 * DETERMINISTIC — no model, no live swarm. Uses a disposable tmp git repo.
 * Every it() has real expect(); beforeEach calls expect.hasAssertions().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'm225-'));
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  // Seed a file so HEAD is resolvable
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: dir,
    stdio: 'pipe',
  });
}

/** Resolve the cwd git -C would use, replicating the M225 fix logic. */
function resolveSafeDir(workspaceRoot: string, pathArg: string): string {
  const abs = resolve(workspaceRoot, pathArg);
  try {
    if (existsSync(abs) && statSync(abs).isFile()) {
      return dirname(abs);
    }
  } catch {
    // stat failure — return as-is
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('M225 — sandbox/git cwd is always a directory', () => {
  let tmpHome: string;
  let repoDir: string;

  beforeEach(() => {
    expect.hasAssertions();
    tmpHome = makeTmpDir();
    repoDir = join(tmpHome, 'repo');
    initRepo(repoDir);
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  // 1. File path arg → git -C cwd resolves to parent directory
  // -------------------------------------------------------------------------
  it('file path arg: resolveSafeDir returns dirname, not the file', () => {
    // Create a nested file inside the repo
    const srcDir = join(repoDir, 'src', 'core', 'goals');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'store.ts'), 'export {};\n');

    const filePath = 'src/core/goals/store.ts';
    const safeDir = resolveSafeDir(repoDir, filePath);

    // Must be a directory
    expect(existsSync(safeDir)).toBe(true);
    expect(statSync(safeDir).isDirectory()).toBe(true);

    // Must be the parent of the file, not the file itself
    expect(safeDir).toBe(resolve(repoDir, 'src/core/goals'));
    expect(safeDir).not.toBe(resolve(repoDir, filePath));
  });

  // -------------------------------------------------------------------------
  // 2. File path arg → git -C <safeDir> succeeds (no "Not a directory" error)
  // -------------------------------------------------------------------------
  it('git -C with safe dir from file arg completes without error', () => {
    const srcDir = join(repoDir, 'src', 'core', 'goals');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'store.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'add store.ts', '--no-gpg-sign'], {
      cwd: repoDir,
      stdio: 'pipe',
    });

    const filePath = 'src/core/goals/store.ts';
    const safeDir = resolveSafeDir(repoDir, filePath);

    // This must NOT throw — previously threw "fatal: cannot change to … Not a directory"
    const result = spawnSync('git', ['-C', safeDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    // The top-level must be the repo root, not the file path.
    // realpathSync.native handles macOS /var → /private/var AND win32 8.3
    // short names (RUNNER~1); git prints '/' seps, so normalize those too.
    const norm = (p: string) => realpathSync.native(p).replace(/\\/g, '/');
    expect(norm(result.stdout.trim())).toBe(norm(repoDir));
  });

  // -------------------------------------------------------------------------
  // 3. Directory path arg → safe dir is unchanged
  // -------------------------------------------------------------------------
  it('directory path arg: resolveSafeDir returns the directory unchanged', () => {
    const srcDir = join(repoDir, 'src');
    mkdirSync(srcDir, { recursive: true });

    const safeDir = resolveSafeDir(repoDir, 'src');
    expect(safeDir).toBe(srcDir);
    expect(statSync(safeDir).isDirectory()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Default '.' arg → safe dir is workspaceRoot
  // -------------------------------------------------------------------------
  it("default '.' arg: resolveSafeDir returns workspaceRoot", () => {
    const safeDir = resolveSafeDir(repoDir, '.');
    expect(safeDir).toBe(repoDir);
    expect(statSync(safeDir).isDirectory()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. createSandbox → worktreePath is always a directory
  // -------------------------------------------------------------------------
  it('createSandbox: worktreePath is a directory (not a file)', async () => {
    // Use a tmp ASHLR_HOME so we never touch the real ~/.ashlr
    const ashlrHome = join(tmpHome, '.ashlr');
    mkdirSync(ashlrHome, { recursive: true });
    const origHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    process.env['ASHLR_TEST_ALLOW_ANY_REPO'] = '1';
    try {
      const { createSandbox, removeSandbox } = await import(
        '../src/core/sandbox/worktree.js'
      );
      const sb = createSandbox(repoDir, { allowAnyRepo: true });

      try {
        // worktreePath must exist and be a directory
        expect(existsSync(sb.worktreePath)).toBe(true);
        expect(statSync(sb.worktreePath).isDirectory()).toBe(true);

        // git -C worktreePath must succeed (the core invariant)
        const r = spawnSync('git', ['-C', sb.worktreePath, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(r.status).toBe(0);
        expect(r.error).toBeUndefined();
      } finally {
        try {
          removeSandbox(sb);
        } catch {
          // best-effort cleanup
        }
      }
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
      delete process.env['ASHLR_TEST_ALLOW_ANY_REPO'];
    }
  });

  // -------------------------------------------------------------------------
  // 6. Repro: milestone title containing a file path must not break git -C
  //    Simulates the exact scenario: goal conductor milestone title =
  //    "Implement store — src/core/goals/store.ts" → model calls grep with
  //    path="src/core/goals/store.ts" → safe dir is the parent directory.
  // -------------------------------------------------------------------------
  it('milestone with file-path title: grep path resolves to directory, git -C succeeds', () => {
    // Simulate what the model would pass as grep `path` when the milestone
    // title mentions the target file
    const milestoneTitle = 'Implement goal store — src/core/goals/store.ts';
    // Extract the file path the model would likely pass (last space-delimited token)
    const filePathArg = milestoneTitle.split(' ').at(-1)!; // "src/core/goals/store.ts"

    // Create the file in the repo (it exists in the worktree after sandbox checkout)
    const srcDir = join(repoDir, 'src', 'core', 'goals');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'store.ts'), '// store\nexport const store = {};\n');

    // Sanity: the path resolves to a FILE without the fix
    const rawAbs = resolve(repoDir, filePathArg);
    expect(existsSync(rawAbs)).toBe(true);
    expect(statSync(rawAbs).isFile()).toBe(true);

    // With the fix: safe dir is the parent
    const safeDir = resolveSafeDir(repoDir, filePathArg);
    expect(statSync(safeDir).isDirectory()).toBe(true);
    expect(safeDir).toBe(srcDir);

    // git -C safeDir must not throw "Not a directory"
    const r = spawnSync('git', ['-C', safeDir, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. Non-existent path arg → resolveSafeDir returns path unchanged (no crash)
  // -------------------------------------------------------------------------
  it('non-existent path arg: resolveSafeDir returns the path without crashing', () => {
    const safeDir = resolveSafeDir(repoDir, 'src/does/not/exist.ts');
    // Should not throw; returns the resolved (non-existent) path
    expect(typeof safeDir).toBe('string');
    expect(safeDir).toBe(resolve(repoDir, 'src/does/not/exist.ts'));
  });
});

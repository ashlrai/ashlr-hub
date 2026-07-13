/**
 * M21 worktree tests — isolated git-worktree sandbox.
 *
 * SAFETY GUARDRAIL: ALL git operations are performed on TEMP repos created
 * under os.tmpdir(). The real 69-repo portfolio is NEVER touched. HOME is
 * overridden to a tmp dir so ~/.ashlr/sandboxes and ~/.ashlr/audit are
 * isolated to tmp storage.
 *
 * The core isolation invariant is explicitly verified:
 *   - The SOURCE REPO working tree bytes are identical before and after
 *     createSandbox / sandboxDiff / removeSandbox.
 *   - The source repo HEAD and branch are unchanged.
 *   - git status on the source repo is clean after all sandbox operations.
 *   - Edits made in the worktree appear in sandboxDiff and do NOT appear in
 *     the source repo.
 *
 * Invariants asserted:
 *   - createSandbox with allowAnyRepo creates a worktree under sandboxesDir()
 *   - createSandbox worktree is on a NEW scratch branch (ashlr/sandbox/<id>)
 *   - source repo working tree, HEAD, and branch are BYTE-UNCHANGED after create
 *   - editing a file in the worktree does NOT mutate the source tree
 *   - sandboxDiff captures the worktree change (insertions/deletions > 0)
 *   - sandboxDiff is read-only (source tree still unchanged after diff)
 *   - removeSandbox removes the worktree directory and scratch branch
 *   - removeSandbox leaves the source repo completely untouched
 *   - removeSandbox is idempotent (calling it twice does not throw)
 *   - listSandboxes() returns metadata for active sandboxes, [] when none
 *   - sandboxesDir() is under HOME/.ashlr/sandboxes
 *   - createSandbox throws (refuses) for an unenrolled repo without allowAnyRepo
 *   - createSandbox throws when kill switch is on even with allowAnyRepo
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Sandbox } from '../src/core/types.js';

// Windows CI can spend several seconds in each real git worktree subprocess.
vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;
// H5 CHANGE 3 migration: allowAnyRepo is now effective ONLY when
// ASHLR_TEST_ALLOW_ANY_REPO==='1'. This suite sandboxes unenrolled tmp repos via
// allowAnyRepo:true, so set the env hatch for the whole file (restored after).
// The lone test asserting refusal WITHOUT allowAnyRepo is unaffected — it never
// passes the hatch, so enrollment is required regardless of the env.
const origAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m21-wt-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAnyRepo;
});

// ---------------------------------------------------------------------------
// Lazy imports
// ---------------------------------------------------------------------------

let _worktree: typeof import('../src/core/sandbox/worktree.js') | null = null;
let _policy: typeof import('../src/core/sandbox/policy.js') | null = null;

async function worktree(): Promise<typeof import('../src/core/sandbox/worktree.js')> {
  if (!_worktree) {
    _worktree = await import('../src/core/sandbox/worktree.js');
  }
  return _worktree;
}

async function policy(): Promise<typeof import('../src/core/sandbox/policy.js')> {
  if (!_policy) {
    _policy = await import('../src/core/sandbox/policy.js');
  }
  return _policy;
}

// ---------------------------------------------------------------------------
// Tmp git repo helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fully-initialized tmp git repo with one commit.
 * Returns the absolute path of the repo root.
 * NEVER touches the real portfolio.
 */
function makeTmpRepo(label = 'repo'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ashlr-m21-${label}-`));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test repo\n');
  fs.writeFileSync(path.join(dir, 'main.ts'), 'export const hello = "world";\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Snapshot the full content of every file under `dir` (recursive, sorted).
 * Used to prove the source tree is byte-unchanged before/after sandbox ops.
 * Excludes .git to focus on the working tree only.
 */
function snapshotTree(dir: string): Record<string, string> {
  const snap: Record<string, string> = {};
  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        snap[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  walk(dir);
  return snap;
}

/** Get the current HEAD commit SHA for a repo. */
function getHead(repoDir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir, stdio: 'pipe', encoding: 'utf8',
  }).trim();
}

/** Get the current branch name for a repo. */
function getBranch(repoDir: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoDir, stdio: 'pipe', encoding: 'utf8',
  }).trim();
}

/** Get `git status --porcelain` output (empty = clean). */
function getStatus(repoDir: string): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: repoDir, stdio: 'pipe', encoding: 'utf8',
  }).trim();
}

/** List all local branches in a repo. */
function listBranches(repoDir: string): string[] {
  const out = execFileSync('git', ['branch', '--format=%(refname:short)'], {
    cwd: repoDir, stdio: 'pipe', encoding: 'utf8',
  }).trim();
  return out ? out.split('\n').map(b => b.trim()).filter(Boolean) : [];
}

function currentCleanupLockOwner(): string {
  const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
  return `${JSON.stringify({ pid: process.pid, startRef: createHash('sha256').update(started).digest('hex') })}\n`;
}

// ---------------------------------------------------------------------------
// sandboxesDir()
// ---------------------------------------------------------------------------

describe('M21 worktree — sandboxesDir()', () => {
  it('returns a path ending in .ashlr/sandboxes', async () => {
    const wt = await worktree();
    expect(wt.sandboxesDir()).toMatch(/[/\\]\.ashlr[/\\]sandboxes$/);
  });

  it('sandboxesDir is under tmpHome', async () => {
    const wt = await worktree();
    expect(wt.sandboxesDir().startsWith(tmpHome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSandbox — policy enforcement
// ---------------------------------------------------------------------------

describe('M21 worktree — createSandbox policy enforcement', () => {
  it('throws for an unenrolled repo without allowAnyRepo', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('policy-check');
    try {
      expect(() => wt.createSandbox(repo)).toThrow();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('throws when kill switch is on even with allowAnyRepo', async () => {
    const wt = await worktree();
    const p = await policy();
    const repo = makeTmpRepo('kill-check');
    p.setKill(true);
    try {
      expect(() => wt.createSandbox(repo, { allowAnyRepo: true })).toThrow();
    } finally {
      p.setKill(false);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not throw with allowAnyRepo when kill switch is off', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('allow-any');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(sb).toBeDefined();
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* idempotent cleanup */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createSandbox — isolation: source tree BYTE-UNCHANGED
// ---------------------------------------------------------------------------

describe('M21 worktree — createSandbox source isolation', () => {
  it('source working tree files are byte-unchanged after createSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('source-isolation');
    const snapBefore = snapshotTree(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const snapAfter = snapshotTree(repo);
      expect(snapAfter).toEqual(snapBefore);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('source HEAD is unchanged after createSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('head-unchanged');
    const headBefore = getHead(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(getHead(repo)).toBe(headBefore);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('source branch is unchanged after createSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('branch-unchanged');
    const branchBefore = getBranch(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(getBranch(repo)).toBe(branchBefore);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('source repo git status is clean after createSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('status-clean');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(getStatus(repo)).toBe('');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createSandbox — sandbox structure
// ---------------------------------------------------------------------------

describe('M21 worktree — createSandbox returns correct Sandbox shape', () => {
  it('returned Sandbox has all required fields', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('shape-check');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(typeof sb.id).toBe('string');
      expect(sb.id.length).toBeGreaterThan(0);
      expect(typeof sb.sourceRepo).toBe('string');
      expect(typeof sb.worktreePath).toBe('string');
      expect(typeof sb.branch).toBe('string');
      expect(typeof sb.baseHead).toBe('string');
      expect(typeof sb.createdAt).toBe('string');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('worktreePath is under sandboxesDir', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('wt-path');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(sb.worktreePath.startsWith(wt.sandboxesDir())).toBe(true);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('worktree directory actually exists on disk', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('wt-exists');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(fs.existsSync(sb.worktreePath)).toBe(true);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scratch branch name contains the sandbox id', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('branch-id');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(sb.branch).toContain(sb.id);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scratch branch starts with ashlr/sandbox/', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('branch-prefix');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(sb.branch.startsWith('ashlr/sandbox/')).toBe(true);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('baseHead matches the source repo HEAD at creation time', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('basehead');
    const headAtCreate = getHead(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(sb.baseHead).toBe(headAtCreate);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sourceRepo field matches the path passed to createSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('sourcerepo');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(sb.sourceRepo).toBe(repo);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scratch branch exists in the source repo after createSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('branch-exists');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const branches = listBranches(repo);
      expect(branches).toContain(sb.branch);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Edit in worktree — source tree stays untouched
// ---------------------------------------------------------------------------

describe('M21 worktree — edits in worktree do NOT mutate source tree', () => {
  it('editing a file in the worktree does not change the source tree', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('edit-isolation');
    const snapBefore = snapshotTree(repo);
    const headBefore = getHead(repo);
    const branchBefore = getBranch(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });

      // Edit a file INSIDE the worktree (not the source repo)
      const wtReadme = path.join(sb.worktreePath, 'README.md');
      fs.writeFileSync(wtReadme, '# mutated in worktree\n');

      // Source tree must be byte-identical
      const snapAfterEdit = snapshotTree(repo);
      expect(snapAfterEdit).toEqual(snapBefore);

      // Source HEAD and branch must be unchanged
      expect(getHead(repo)).toBe(headBefore);
      expect(getBranch(repo)).toBe(branchBefore);

      // Source git status must be clean
      expect(getStatus(repo)).toBe('');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('adding a new file in the worktree does not appear in source tree', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('new-file-isolation');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });

      // Create a new file INSIDE the worktree
      fs.writeFileSync(path.join(sb.worktreePath, 'new-feature.ts'), 'export const x = 1;\n');

      // The new file must NOT exist in the source repo
      expect(fs.existsSync(path.join(repo, 'new-feature.ts'))).toBe(false);

      // Source git status must be clean
      expect(getStatus(repo)).toBe('');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sandboxDiff — captures worktree changes
// ---------------------------------------------------------------------------

describe('M21 worktree — sandboxDiff captures worktree changes', () => {
  it('sandboxDiff returns a SandboxDiff with the correct sandboxId', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('diff-id');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const diff = wt.sandboxDiff(sb);
      expect(diff.sandboxId).toBe(sb.id);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sandboxDiff shows 0 changes when worktree is clean', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('diff-clean');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const diff = wt.sandboxDiff(sb);
      expect(diff.insertions).toBe(0);
      expect(diff.deletions).toBe(0);
      expect(diff.files).toBe(0);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sandboxDiff captures an UNTRACKED new file (no add/commit)', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('diff-untracked');
    const snapBefore = snapshotTree(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });

      // Write a brand-new file in the worktree WITHOUT git add / commit —
      // this is exactly how the autonomous write path produces output.
      fs.writeFileSync(
        path.join(sb.worktreePath, 'brand-new.ts'),
        'export const created = true;\n',
      );

      const diff = wt.sandboxDiff(sb);
      // The new file must be captured, not silently dropped.
      expect(diff.files).toBeGreaterThan(0);
      expect(diff.insertions).toBeGreaterThan(0);
      expect(diff.patch).toContain('brand-new.ts');

      // sandboxDiff must NOT leak into the source repo (it stages only the
      // worktree's own index).
      expect(snapshotTree(repo)).toEqual(snapBefore);
      expect(getStatus(repo)).toBe('');
      expect(fs.existsSync(path.join(repo, 'brand-new.ts'))).toBe(false);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sandboxDiff reports insertions after adding lines in worktree', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('diff-insertions');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });

      // Modify a tracked file in the worktree
      const wtReadme = path.join(sb.worktreePath, 'README.md');
      fs.writeFileSync(wtReadme, '# test repo\n\nAdded a new line.\nAnother line.\n');

      // Stage and commit in the worktree so the diff is captured
      execFileSync('git', ['add', '.'], { cwd: sb.worktreePath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'worktree change'], { cwd: sb.worktreePath, stdio: 'pipe' });

      const diff = wt.sandboxDiff(sb);
      expect(diff.insertions).toBeGreaterThan(0);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sandboxDiff is read-only: source tree unchanged after diff call', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('diff-readonly');
    const snapBefore = snapshotTree(repo);
    const headBefore = getHead(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });

      // Modify + commit in worktree
      fs.writeFileSync(path.join(sb.worktreePath, 'README.md'), '# changed\n');
      execFileSync('git', ['add', '.'], { cwd: sb.worktreePath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'wt edit'], { cwd: sb.worktreePath, stdio: 'pipe' });

      wt.sandboxDiff(sb);

      // Source tree must still be byte-identical after diff
      expect(snapshotTree(repo)).toEqual(snapBefore);
      expect(getHead(repo)).toBe(headBefore);
      expect(getStatus(repo)).toBe('');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sandboxDiff returns a patch string', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('diff-patch');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const diff = wt.sandboxDiff(sb);
      expect(typeof diff.patch).toBe('string');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// removeSandbox — cleanup
// ---------------------------------------------------------------------------

describe('M21 worktree — removeSandbox cleanup', () => {
  it('removes the worktree directory', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-dir');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const wtPath = sb.worktreePath;
      expect(fs.existsSync(wtPath)).toBe(true);
      expect(wt.removeSandbox(sb)).toMatchObject({
        status: 'complete',
        postconditions: { registration: 'absent', branch: 'absent', home: 'absent' },
        evidencePersisted: false,
      });
      expect(fs.existsSync(wtPath)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('removes the scratch branch from the source repo', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-branch');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const branch = sb.branch;
      expect(listBranches(repo)).toContain(branch);
      expect(wt.removeSandbox(sb).status).toBe('complete');
      expect(listBranches(repo)).not.toContain(branch);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('source working tree is byte-unchanged after removeSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-isolation');
    const snapBefore = snapshotTree(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      wt.removeSandbox(sb);
      expect(snapshotTree(repo)).toEqual(snapBefore);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('source HEAD is unchanged after removeSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-head');
    const headBefore = getHead(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      wt.removeSandbox(sb);
      expect(getHead(repo)).toBe(headBefore);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('source branch is unchanged after removeSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-branch-check');
    const branchBefore = getBranch(repo);
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      wt.removeSandbox(sb);
      expect(getBranch(repo)).toBe(branchBefore);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('source git status is clean after removeSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-status');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      wt.removeSandbox(sb);
      expect(getStatus(repo)).toBe('');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('removeSandbox is idempotent: calling twice does not throw', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-idempotent');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(wt.removeSandbox(sb).status).toBe('complete');
      // Second call must not throw (already cleaned up)
      expect(wt.removeSandbox(sb!).status).toBe('complete');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('retains bounded recovery metadata while the source repo is unavailable', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-source-unavailable');
    const moved = `${repo}-moved`;
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      fs.renameSync(repo, moved);
      const result = wt.removeSandbox(sb);
      expect(result).toMatchObject({
        status: 'unavailable',
        failureClasses: ['source-repo-unavailable'],
        retryable: true,
        evidencePersisted: true,
      });
      expect(fs.existsSync(path.dirname(sb.worktreePath))).toBe(true);
      const retained = wt.listSandboxes().find((entry) => entry.id === sb!.id);
      expect(retained?.ownerPid).toBeUndefined();
      expect(retained?.cleanup).toMatchObject({ status: 'unavailable', attempt: 1 });

      fs.renameSync(moved, repo);
      expect(wt.removeSandbox(retained!).status).toBe('complete');
      sb = null;
    } finally {
      if (fs.existsSync(moved) && !fs.existsSync(repo)) fs.renameSync(moved, repo);
      if (sb) { try { wt.removeSandbox(sb); } catch { /* best effort */ } }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });

  it('retains recovery metadata when a scratch branch remains checked out elsewhere', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-branch-residual');
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m21-holder-'));
    fs.rmSync(holder, { recursive: true, force: true });
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      execFileSync('git', ['worktree', 'add', '--force', '--force', holder, sb.branch], { cwd: repo, stdio: 'pipe' });
      const result = wt.removeSandbox(sb);
      expect(result.status).toBe('residual');
      expect(result.postconditions).toMatchObject({ registration: 'absent', branch: 'present', home: 'present' });
      expect(result.failureClasses).toContain('branch-remaining');
      expect(result.retryable).toBe(false);
      expect(result.evidencePersisted).toBe(true);

      execFileSync('git', ['worktree', 'remove', '--force', holder], { cwd: repo, stdio: 'pipe' });
      const retained = wt.listSandboxes().find((entry) => entry.id === sb!.id);
      expect(wt.removeSandbox(retained!).status).toBe('refused');
      execFileSync('git', ['branch', '-D', sb.branch], { cwd: repo, stdio: 'pipe' });
      expect(wt.removeSandbox(retained!).status).toBe('refused');
      fs.rmSync(path.dirname(sb.worktreePath), { recursive: true, force: true });
      expect(wt.removeSandbox(retained!).status).toBe('complete');
      sb = null;
    } finally {
      try { execFileSync('git', ['worktree', 'remove', '--force', holder], { cwd: repo, stdio: 'pipe' }); } catch { /* gone */ }
      if (sb) { try { wt.removeSandbox(sb); } catch { /* best effort */ } }
      fs.rmSync(holder, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('fails closed when another process owns the per-sandbox cleanup lock', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('remove-locked');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const lockDir = path.join(wt.sandboxesDir(), '.cleanup-locks');
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
      const lockPath = path.join(lockDir, `${sb.id}.lock`);
      fs.writeFileSync(lockPath, currentCleanupLockOwner(), { mode: 0o600 });
      const result = wt.removeSandbox(sb);
      expect(result).toMatchObject({ status: 'unavailable', failureClasses: ['cleanup-locked'], retryable: true });
      expect(fs.existsSync(sb.worktreePath)).toBe(true);
      expect(listBranches(repo)).toContain(sb.branch);
      fs.rmSync(lockPath, { force: true });
      expect(wt.removeSandbox(wt.listSandboxes().find((entry) => entry.id === sb!.id)!).status).toBe('complete');
      sb = null;
    } finally {
      if (sb) { try { wt.removeSandbox(sb); } catch { /* best effort */ } }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// removeSandbox — defense-in-depth against tampered metadata
// ---------------------------------------------------------------------------

describe('M21 worktree — removeSandbox refuses tampered metadata', () => {
  it('does NOT delete a user branch when metadata branch is outside the namespace', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('tamper-branch');
    // A real user branch that must survive a malicious cleanup.
    execFileSync('git', ['branch', 'main-feature'], { cwd: repo, stdio: 'pipe' });
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });

      // Tamper: point branch at a real user branch (as a corrupted/forged
      // sandbox.json would). worktreePath stays valid so only the branch guard trips.
      const tampered: Sandbox = { ...sb, branch: 'main-feature' };

      // Guard must refuse the git ops — the user branch survives.
      wt.removeSandbox(tampered);
      expect(listBranches(repo)).toContain('main-feature');
    } finally {
      // Clean up the real sandbox (use the untampered handle).
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT touch a worktree path outside sandboxesDir()', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('tamper-path');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });

      // Tamper: forge a worktreePath pointing at the source repo itself with a
      // namespaced branch. The containment guard must refuse the git ops.
      const tampered: Sandbox = { ...sb, worktreePath: repo };
      const snapBefore = snapshotTree(repo);

      wt.removeSandbox(tampered);

      // Source repo untouched: `worktree remove --force <repo>` never ran.
      expect(snapshotTree(repo)).toEqual(snapBefore);
      expect(getStatus(repo)).toBe('');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not report complete when sourceRepo points at a different valid repository', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('tamper-source');
    const other = makeTmpRepo('tamper-source-other');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const result = wt.removeSandbox({ ...sb, sourceRepo: other });
      expect(result.status).toBe('refused');
      expect(fs.existsSync(sb.worktreePath)).toBe(true);
      expect(listBranches(repo)).toContain(sb.branch);
      expect(wt.removeSandbox(sb).status).toBe('complete');
      sb = null;
    } finally {
      if (sb) { try { wt.removeSandbox(sb); } catch { /* best effort */ } }
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked sandbox.json without reading or rewriting its target', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('tamper-meta-symlink');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m21-meta-target-'));
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const meta = path.join(path.dirname(sb.worktreePath), 'sandbox.json');
      const canonical = fs.readFileSync(meta, 'utf8');
      const target = path.join(outside, 'target.json');
      fs.writeFileSync(target, canonical, 'utf8');
      fs.rmSync(meta);
      fs.symlinkSync(target, meta);

      expect(wt.removeSandbox(sb).status).toBe('refused');
      expect(fs.readFileSync(target, 'utf8')).toBe(canonical);
      expect(fs.existsSync(sb.worktreePath)).toBe(true);

      fs.rmSync(meta);
      fs.writeFileSync(meta, canonical, { mode: 0o600 });
      expect(wt.removeSandbox(sb).status).toBe('complete');
      sb = null;
    } finally {
      if (sb) { try { wt.removeSandbox(sb); } catch { /* best effort */ } }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses an external symlink installed at the canonical worktree path', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('tamper-canonical-symlink');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m21-worktree-target-'));
    const sentinel = path.join(outside, 'sentinel');
    fs.writeFileSync(sentinel, 'unchanged', 'utf8');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      execFileSync('git', ['worktree', 'remove', '--force', sb.worktreePath], { cwd: repo, stdio: 'pipe' });
      fs.symlinkSync(outside, sb.worktreePath, 'dir');

      expect(wt.removeSandbox(sb).status).toBe('refused');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
      expect(listBranches(repo)).toContain(sb.branch);

      fs.rmSync(sb.worktreePath);
      expect(wt.removeSandbox(sb).status).toBe('refused');
      expect(listBranches(repo)).toContain(sb.branch);
      execFileSync('git', ['branch', '-D', sb.branch], { cwd: repo, stdio: 'pipe' });
      expect(wt.removeSandbox(sb).status).toBe('refused');
      fs.rmSync(path.dirname(sb.worktreePath), { recursive: true, force: true });
      expect(wt.removeSandbox(sb).status).toBe('complete');
      sb = null;
    } finally {
      if (sb) { try { wt.removeSandbox(sb); } catch { /* best effort */ } }
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not delete a namespaced branch in another repo when the metadata home is absent', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('absent-home-source');
    const other = makeTmpRepo('absent-home-other');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(wt.removeSandbox(sb).status).toBe('complete');
      execFileSync('git', ['branch', sb.branch], { cwd: other, stdio: 'pipe' });

      const forged = { ...sb, sourceRepo: other };
      expect(wt.removeSandbox(forged).status).toBe('refused');
      expect(listBranches(other)).toContain(sb.branch);
      sb = null;
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: create -> edit in worktree -> diff -> remove
// Source tree byte-unchanged throughout
// ---------------------------------------------------------------------------

describe('M21 worktree — full lifecycle isolation proof', () => {
  it('source tree is byte-unchanged through create/edit-worktree/diff/remove', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('lifecycle');
    const snapBefore = snapshotTree(repo);
    const headBefore = getHead(repo);
    const branchBefore = getBranch(repo);
    let sb: Sandbox | null = null;

    try {
      // Step 1: create sandbox
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      expect(snapshotTree(repo)).toEqual(snapBefore);
      expect(getHead(repo)).toBe(headBefore);
      expect(getStatus(repo)).toBe('');

      // Step 2: edit inside the worktree (NOT the source repo)
      fs.writeFileSync(path.join(sb.worktreePath, 'README.md'), '# mutated\n');
      fs.writeFileSync(path.join(sb.worktreePath, 'new-file.ts'), 'export const x = 42;\n');
      execFileSync('git', ['add', '.'], { cwd: sb.worktreePath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'sandbox work'], { cwd: sb.worktreePath, stdio: 'pipe' });

      // Source still untouched
      expect(snapshotTree(repo)).toEqual(snapBefore);
      expect(getHead(repo)).toBe(headBefore);
      expect(getBranch(repo)).toBe(branchBefore);
      expect(getStatus(repo)).toBe('');

      // Step 3: diff (read-only)
      const diff = wt.sandboxDiff(sb);
      expect(diff.insertions).toBeGreaterThan(0);
      expect(diff.sandboxId).toBe(sb.id);
      // Source still untouched after diff
      expect(snapshotTree(repo)).toEqual(snapBefore);
      expect(getHead(repo)).toBe(headBefore);
      expect(getStatus(repo)).toBe('');

      // Step 4: remove sandbox
      const wtPath = sb.worktreePath;
      const branch = sb.branch;
      wt.removeSandbox(sb);
      sb = null;

      // Worktree gone
      expect(fs.existsSync(wtPath)).toBe(false);
      // Scratch branch gone
      expect(listBranches(repo)).not.toContain(branch);
      // Source still byte-identical
      expect(snapshotTree(repo)).toEqual(snapBefore);
      expect(getHead(repo)).toBe(headBefore);
      expect(getBranch(repo)).toBe(branchBefore);
      expect(getStatus(repo)).toBe('');
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// listSandboxes()
// ---------------------------------------------------------------------------

describe('M21 worktree — listSandboxes()', () => {
  it('listSandboxes() returns [] when no sandboxes exist', async () => {
    const wt = await worktree();
    expect(wt.listSandboxes()).toEqual([]);
  });

  it('listSandboxes() returns an entry after createSandbox', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('list-sbs');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const list = wt.listSandboxes();
      expect(list.some(s => s.id === sb!.id)).toBe(true);
    } finally {
      if (sb) {
        try { wt.removeSandbox(sb); } catch { /* ok */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('listSandboxes() does not include removed sandboxes', async () => {
    const wt = await worktree();
    const repo = makeTmpRepo('list-removed');
    let sb: Sandbox | null = null;
    try {
      sb = wt.createSandbox(repo, { allowAnyRepo: true });
      const id = sb.id;
      wt.removeSandbox(sb);
      sb = null;
      expect(wt.listSandboxes().some(s => s.id === id)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('listSandboxes() never throws even if metadata dir does not exist', async () => {
    const wt = await worktree();
    expect(() => wt.listSandboxes()).not.toThrow();
  });

  it('inventory counts malformed homes that listSandboxes cannot trust', async () => {
    const wt = await worktree();
    const malformed = path.join(wt.sandboxesDir(), 'malformed-home');
    fs.mkdirSync(malformed, { recursive: true });
    fs.writeFileSync(path.join(malformed, 'sandbox.json'), '{not-json', 'utf8');

    expect(wt.listSandboxes()).toEqual([]);
    expect(wt.sandboxInventory()).toMatchObject({
      totalHomes: 1,
      validHomes: 0,
      malformedHomes: 1,
      unsafeEntries: 0,
    });
  });
});

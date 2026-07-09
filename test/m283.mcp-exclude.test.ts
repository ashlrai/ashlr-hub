/**
 * M283 — fleet-written MCP sidecar must NEVER appear in a proposal diff.
 *
 * Tests:
 *   1. writeMcpConfigIfAvailable writes the fleet sidecar AND registers it in the
 *      worktree's git/info/exclude file (layer 1).
 *   2. sandboxDiff excludes fleet-written MCP infra from the patch and
 *      numstat, but INCLUDES the agent's real file change (layer 2).
 *   3. A pre-existing .mcp.json (in source repo before the run) is NOT
 *      clobbered by writeMcpConfigIfAvailable, AND the agent's edit to it IS
 *      captured in the diff.
 *   4. writeMcpConfigIfAvailable is idempotent: calling twice on a worktree
 *      that already has a sidecar returns the same fleet-owned path.
 *
 * Hermetic: real git repos via tmp dirs + `git init`. No engine spawning.
 * Uses vi.fn where needed; all values are fixed/deterministic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FLEET_MCP_CONFIG_FILENAME, writeMcpConfigIfAvailable } from '../src/core/run/sandboxed-engine.js';
import { sandboxDiff } from '../src/core/sandbox/worktree.js';
import type { Sandbox } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
});

/** Initialise a bare git repo with an initial commit and return its path. */
function initRepo(prefix: string): string {
  const dir = mkTmp(prefix);
  execFileSync('git', ['init', dir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@ashlr.test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Ashlr Test'], { cwd: dir, stdio: 'pipe' });
  // Initial commit so HEAD is resolvable.
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

/** Add a git worktree to `sourceRepo` on a new branch, return its path. */
function addWorktree(sourceRepo: string, branch: string, worktreePath: string): void {
  const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRepo,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseHead], {
    cwd: sourceRepo,
    stdio: 'pipe',
  });
}

/** Build a minimal Sandbox object pointing at a real worktree. */
function makeSandbox(sourceRepo: string, worktreePath: string, branch: string): Sandbox {
  const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRepo,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  return {
    id: 'test-m283',
    sourceRepo,
    worktreePath,
    branch,
    baseHead,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. writeMcpConfigIfAvailable registers the fleet sidecar in git/info/exclude (layer 1)
// ---------------------------------------------------------------------------

describe('M283 layer-1: writeMcpConfigIfAvailable registers git exclude', () => {
  it('writes the fleet sidecar AND adds it to the worktree gitdir info/exclude', () => {
    const sourceRepo = initRepo('m283-l1-src-');
    const worktreePath = mkTmp('m283-l1-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-l1', worktreePath);

    const result = writeMcpConfigIfAvailable(worktreePath);

    if (result === null) {
      // ashlr not on PATH — skip (binary-absent is tested in m248)
      return;
    }

    expect(result).toBe(join(worktreePath, FLEET_MCP_CONFIG_FILENAME));
    expect(existsSync(result)).toBe(true);

    // Resolve the worktree's own gitdir
    const gitdir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const gitdirAbs = gitdir.startsWith('/')
      ? gitdir
      : join(worktreePath, gitdir);
    const excludePath = join(gitdirAbs, 'info', 'exclude');

    expect(existsSync(excludePath)).toBe(true);
    const content = readFileSync(excludePath, 'utf8');
    expect(content).toContain(FLEET_MCP_CONFIG_FILENAME);
  });

  it('preserves a repo-owned .mcp.json while still writing the fleet sidecar', () => {
    const sourceRepo = initRepo('m283-l1-preexist-src-');
    const worktreePath = mkTmp('m283-l1-preexist-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-l1-pre', worktreePath);

    // Pre-write a .mcp.json (simulates a repo that already has one)
    writeFileSync(join(worktreePath, '.mcp.json'), '{"mcpServers":{}}', 'utf8');

    const result = writeMcpConfigIfAvailable(worktreePath);

    if (result === null) return;
    expect(result).toBe(join(worktreePath, FLEET_MCP_CONFIG_FILENAME));

    // The file content must be unchanged (fleet did not clobber it)
    const content = readFileSync(join(worktreePath, '.mcp.json'), 'utf8');
    expect(content).toBe('{"mcpServers":{}}');
  });

  it('is idempotent: second call returns the same fleet-owned sidecar path', () => {
    const sourceRepo = initRepo('m283-l1-idem-src-');
    const worktreePath = mkTmp('m283-l1-idem-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-l1-idem', worktreePath);

    const result1 = writeMcpConfigIfAvailable(worktreePath);
    // Skip if ashlr not on PATH
    if (result1 === null) return;

    const result2 = writeMcpConfigIfAvailable(worktreePath);
    expect(result2).toBe(result1);
  });
});

// ---------------------------------------------------------------------------
// 2. sandboxDiff excludes fleet-written MCP infra, keeps real changes (layer 2)
// ---------------------------------------------------------------------------

describe('M283 layer-2: sandboxDiff excludes fleet-written MCP infra', () => {
  it('real change IS in diff, legacy fleet .mcp.json is NOT', () => {
    const sourceRepo = initRepo('m283-l2-src-');
    const worktreePath = mkTmp('m283-l2-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-l2', worktreePath);
    const sb = makeSandbox(sourceRepo, worktreePath, 'ashlr/sandbox/m283-l2');

    // Simulate fleet writing .mcp.json (infra file)
    writeFileSync(join(worktreePath, '.mcp.json'), '{"mcpServers":{"ashlr":{"command":"/usr/local/bin/ashlr","args":["mcp"]}}}', 'utf8');

    // Simulate agent writing a real feature file
    mkdirSync(join(worktreePath, 'src'), { recursive: true });
    writeFileSync(join(worktreePath, 'src', 'new-feature.ts'), 'export function hello() { return 42; }\n', 'utf8');

    const diff = sandboxDiff(sb);

    // Real file must appear
    expect(diff.patch).toContain('new-feature.ts');
    expect(diff.files).toBeGreaterThanOrEqual(1);

    // Fleet-infra file must NOT appear
    expect(diff.patch).not.toContain('.mcp.json');

    // numstat count must NOT include .mcp.json
    // (we can verify by checking the patch text for the sentinel content)
    expect(diff.patch).not.toContain('mcpServers');
    expect(diff.patch).not.toContain('ashlr-fleet-engine');
  });

  it('when .mcp.json existed at baseHead (legitimate repo file), agent edit IS captured', () => {
    const sourceRepo = initRepo('m283-l2-legit-src-');

    // Commit a .mcp.json into the source repo so it exists at baseHead
    writeFileSync(join(sourceRepo, '.mcp.json'), '{"mcpServers":{"myserver":{"command":"mybin","args":["start"]}}}', 'utf8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: sourceRepo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'add .mcp.json'], { cwd: sourceRepo, stdio: 'pipe' });

    const worktreePath = mkTmp('m283-l2-legit-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-l2-legit', worktreePath);
    const sb = makeSandbox(sourceRepo, worktreePath, 'ashlr/sandbox/m283-l2-legit');

    // Agent legitimately edits the pre-existing .mcp.json
    writeFileSync(
      join(worktreePath, '.mcp.json'),
      '{"mcpServers":{"myserver":{"command":"mybin","args":["start","--verbose"]}}}',
      'utf8',
    );

    const diff = sandboxDiff(sb);

    // The legitimate .mcp.json edit MUST appear in the diff
    expect(diff.patch).toContain('.mcp.json');
    expect(diff.patch).toContain('--verbose');
    expect(diff.files).toBeGreaterThanOrEqual(1);
  });

  it('empty diff when only .mcp.json was written (no real changes)', () => {
    const sourceRepo = initRepo('m283-l2-empty-src-');
    const worktreePath = mkTmp('m283-l2-empty-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-l2-empty', worktreePath);
    const sb = makeSandbox(sourceRepo, worktreePath, 'ashlr/sandbox/m283-l2-empty');

    // Only the fleet infra file — no real agent changes
    writeFileSync(join(worktreePath, '.mcp.json'), '{"mcpServers":{"ashlr":{"command":"/usr/bin/ashlr","args":["mcp"]}}}', 'utf8');

    const diff = sandboxDiff(sb);

    expect(diff.files).toBe(0);
    expect(diff.patch.trim()).toBe('');
    expect(diff.insertions).toBe(0);
    expect(diff.deletions).toBe(0);
  });

  it('empty diff when only the fleet sidecar was written (no real changes)', () => {
    const sourceRepo = initRepo('m283-l2-empty-sidecar-src-');
    const worktreePath = mkTmp('m283-l2-empty-sidecar-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-l2-empty-sidecar', worktreePath);
    const sb = makeSandbox(sourceRepo, worktreePath, 'ashlr/sandbox/m283-l2-empty-sidecar');

    writeFileSync(join(worktreePath, FLEET_MCP_CONFIG_FILENAME), '{"mcpServers":{"ashlr":{"command":"/usr/bin/ashlr","args":["mcp"]}}}', 'utf8');

    const diff = sandboxDiff(sb);

    expect(diff.files).toBe(0);
    expect(diff.patch.trim()).toBe('');
    expect(diff.insertions).toBe(0);
    expect(diff.deletions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end: writeMcpConfigIfAvailable + sandboxDiff together
// ---------------------------------------------------------------------------

describe('M283 end-to-end: write infra file then capture diff', () => {
  it('after writeMcpConfigIfAvailable, diff of a real change has no .mcp.json', () => {
    const sourceRepo = initRepo('m283-e2e-src-');
    const worktreePath = mkTmp('m283-e2e-wt-');
    addWorktree(sourceRepo, 'ashlr/sandbox/m283-e2e', worktreePath);
    const sb = makeSandbox(sourceRepo, worktreePath, 'ashlr/sandbox/m283-e2e');

    // Fleet infra write (the path that was broken before M283)
    writeMcpConfigIfAvailable(worktreePath);

    // Agent real change
    writeFileSync(join(worktreePath, 'fix.ts'), 'export const answer = 42;\n', 'utf8');

    const diff = sandboxDiff(sb);

    // Real change present
    expect(diff.patch).toContain('fix.ts');
    expect(diff.files).toBeGreaterThanOrEqual(1);

    // Fleet file absent
    expect(diff.patch).not.toContain(FLEET_MCP_CONFIG_FILENAME);
    expect(diff.patch).not.toContain('mcpServers');
  });
});

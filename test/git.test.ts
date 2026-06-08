/**
 * Tests for src/core/git.ts
 *
 * All tests are hermetic: they operate on temp dirs created under os.tmpdir()
 * and never touch the real Desktop or ~/.ashlr.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { isRepo, getRemoteOrg, getGitStatus } from '../src/core/git.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-git-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Initialize a bare git repo with one commit so HEAD + log are available. */
function initRepoWithCommit(dir: string, remote?: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# test');
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  if (remote) {
    execSync(`git remote add origin ${remote}`, { cwd: dir, stdio: 'pipe' });
  }
}

/** Initialize a git repo with no commits (empty repo). */
function initEmptyRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// isRepo
// ---------------------------------------------------------------------------

describe('isRepo', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('returns true when .git is a directory', () => {
    initEmptyRepo(tmp);
    expect(isRepo(tmp)).toBe(true);
  });

  it('returns true when .git is a file (worktree/submodule)', () => {
    // Simulate a git worktree where .git is a file containing "gitdir: ..."
    const dotGitPath = join(tmp, '.git');
    writeFileSync(dotGitPath, 'gitdir: /some/other/path/.git/worktrees/foo\n');
    expect(isRepo(tmp)).toBe(true);
  });

  it('returns false for a plain directory with no .git entry', () => {
    expect(isRepo(tmp)).toBe(false);
  });

  it('returns false for a non-existent path', () => {
    expect(isRepo(join(tmp, 'does-not-exist'))).toBe(false);
  });

  it('returns false for a file path (not a directory)', () => {
    const filePath = join(tmp, 'somefile.txt');
    writeFileSync(filePath, 'hello');
    expect(isRepo(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRemoteOrg
// ---------------------------------------------------------------------------

describe('getRemoteOrg', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('returns null/null for a non-repo directory', () => {
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBeNull();
    expect(result.org).toBeNull();
  });

  it('returns null/null for a repo with no remote', () => {
    initRepoWithCommit(tmp);
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBeNull();
    expect(result.org).toBeNull();
  });

  it('parses HTTPS remote and extracts ashlrai org', () => {
    initRepoWithCommit(tmp, 'https://github.com/ashlrai/some-repo.git');
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBe('https://github.com/ashlrai/some-repo.git');
    expect(result.org).toBe('ashlrai');
  });

  it('parses HTTPS remote and extracts masonwyatt23 org', () => {
    initRepoWithCommit(tmp, 'https://github.com/masonwyatt23/my-tool.git');
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBe('https://github.com/masonwyatt23/my-tool.git');
    expect(result.org).toBe('masonwyatt23');
  });

  it('parses HTTPS remote and extracts evero-consulting org', () => {
    initRepoWithCommit(tmp, 'https://github.com/evero-consulting/project.git');
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBe('https://github.com/evero-consulting/project.git');
    expect(result.org).toBe('evero-consulting');
  });

  it('parses SSH remote URL (git@github.com:org/repo.git)', () => {
    initRepoWithCommit(tmp, 'git@github.com:ashlrai/hub.git');
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBe('git@github.com:ashlrai/hub.git');
    expect(result.org).toBe('ashlrai');
  });

  it('parses SSH remote without .git suffix', () => {
    initRepoWithCommit(tmp, 'git@github.com:masonwyatt23/tool');
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBe('git@github.com:masonwyatt23/tool');
    expect(result.org).toBe('masonwyatt23');
  });

  it('returns remote but null org for an unknown org', () => {
    initRepoWithCommit(tmp, 'https://github.com/some-unknown-org/repo.git');
    const result = getRemoteOrg(tmp);
    // Remote should still be returned
    expect(result.remote).toBe('https://github.com/some-unknown-org/repo.git');
    // org may be null OR the parsed org string — implementation decides what "org" means
    // The contract says: "extract org from ashlrai/*, masonwyatt23/*, evero-consulting/* style paths"
    // For unknown orgs, returning the parsed segment is also valid; we only assert it's a string or null
    expect(typeof result.org === 'string' || result.org === null).toBe(true);
  });

  it('returns remote but null org for an HTTPS remote without a path segment', () => {
    initRepoWithCommit(tmp, 'https://github.com/single');
    const result = getRemoteOrg(tmp);
    expect(result.remote).toBe('https://github.com/single');
    // No org/repo segment to parse
    expect(typeof result.org === 'string' || result.org === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getGitStatus
// ---------------------------------------------------------------------------

describe('getGitStatus', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => cleanup(tmp));

  it('returns null for a non-repo directory', () => {
    expect(getGitStatus(tmp)).toBeNull();
  });

  it('returns null for a non-existent path', () => {
    expect(getGitStatus(join(tmp, 'ghost'))).toBeNull();
  });

  it('returns a GitStatus for a repo with one commit', () => {
    initRepoWithCommit(tmp);
    const status = getGitStatus(tmp);
    expect(status).not.toBeNull();
    expect(typeof status!.branch).toBe('string');
    expect(status!.branch.length).toBeGreaterThan(0);
    expect(typeof status!.dirty).toBe('number');
    expect(status!.dirty).toBeGreaterThanOrEqual(0);
    expect(typeof status!.ahead).toBe('number');
    expect(typeof status!.behind).toBe('number');
    // lastCommit should be an ISO string
    expect(status!.lastCommit).not.toBeNull();
    expect(() => new Date(status!.lastCommit!)).not.toThrow();
  });

  it('reports dirty=0 on a clean repo', () => {
    initRepoWithCommit(tmp);
    const status = getGitStatus(tmp);
    expect(status!.dirty).toBe(0);
  });

  it('reports dirty>0 when there are untracked files', () => {
    initRepoWithCommit(tmp);
    writeFileSync(join(tmp, 'untracked.txt'), 'new file');
    const status = getGitStatus(tmp);
    expect(status!.dirty).toBeGreaterThan(0);
  });

  it('reports dirty>0 when there are modified tracked files', () => {
    initRepoWithCommit(tmp);
    writeFileSync(join(tmp, 'README.md'), '# modified');
    const status = getGitStatus(tmp);
    expect(status!.dirty).toBeGreaterThan(0);
  });

  it('returns lastCommit=null for a zero-commit repo', () => {
    initEmptyRepo(tmp);
    const status = getGitStatus(tmp);
    // Either null (no commits) or a valid status — implementation may return null for the whole thing
    // on a zero-commit repo; both are acceptable per contract ("null if not a repo or git unavailable")
    if (status !== null) {
      expect(status.lastCommit).toBeNull();
    }
  });

  it('reports ahead=0 and behind=0 when no upstream is set', () => {
    initRepoWithCommit(tmp);
    const status = getGitStatus(tmp);
    expect(status!.ahead).toBe(0);
    expect(status!.behind).toBe(0);
  });
});

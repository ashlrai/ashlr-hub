/**
 * 3.16 agent workspaces against REAL git (real-io lane): a worktree per agent
 * under the Verse-managed ~/.ashlr-worktrees on `verse/<slug>`, the repo's
 * gitignored files copied in, snapshot-before-delete to a private ref, and
 * Restore laying the uncommitted work back exactly as it was — plus the
 * workspace cap archiving the oldest idle, unpinned agent. HOME is relocated
 * to a temp directory for every test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveAgent, enforceWorkspaceCap, restoreAgent, type ActionDeps } from '../src/core/verse/agents/actions.js';
import type { ScriptLauncher } from '../src/core/verse/agents/scripts.js';
import { blankAgent, createAgentStore } from '../src/core/verse/agents/store.js';
import { ARCHIVE_REF_PREFIX, archiveWorkspace, createAgentWorkspace, restoreWorkspace } from '../src/core/verse/agents/workspace-ops.js';
import type { AgentRecord } from '../src/core/verse/agents/types.js';
import { invalidateGitCaches } from '../src/core/verse/git-ops.js';

let home: string;
let savedHome: string | undefined;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = realpathSync(mkdtempSync(join(tmpdir(), 'verse-agents-ws-')));
  process.env['HOME'] = home;
  repo = join(home, 'code', 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(join(repo, '.env'), 'SECRET=local\n');
  invalidateGitCaches();
});

afterEach(() => {
  invalidateGitCaches();
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('agent workspaces (real git)', () => {
  it('makes a worktree on verse/<slug>, copies gitignored files, and picks a fresh slug for a repeat', async () => {
    const one = await createAgentWorkspace(repo, 'fix-login', ['.env', 'missing.env']);
    expect(one.workspace.path).toBe(join(home, '.ashlr-worktrees', 'repo', 'fix-login'));
    expect(one.workspace.branch).toBe('verse/fix-login');
    expect(one.copied).toEqual(['.env']);
    expect(one.skipped).toEqual(['missing.env']);
    expect(readFileSync(join(one.workspace.path, '.env'), 'utf8')).toBe('SECRET=local\n');
    expect(git(one.workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('verse/fix-login');
    expect(one.workspace.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));

    const two = await createAgentWorkspace(repo, 'fix-login', []);
    expect(two.workspace.name).toBe('fix-login-2');
    expect(two.workspace.branch).toBe('verse/fix-login-2');
  });

  it('snapshots uncommitted and untracked work before removing the worktree, and restores it unstaged', async () => {
    const made = await createAgentWorkspace(repo, 'feature', []);
    const ws = { ...made.workspace, portBase: 41000, portCount: 10 };
    writeFileSync(join(ws.path, 'b.txt'), 'committed on the branch\n');
    git(ws.path, 'add', 'b.txt');
    git(ws.path, 'commit', '-q', '-m', 'agent work');
    const head = git(ws.path, 'rev-parse', 'HEAD');
    writeFileSync(join(ws.path, 'a.txt'), 'one\nedited, not committed\n');
    writeFileSync(join(ws.path, 'new.txt'), 'untracked\n');

    const archived = await archiveWorkspace(ws, 'manual', { deleteBranch: true });
    expect(existsSync(ws.path)).toBe(false);
    expect(archived.ref).toBe(`${ARCHIVE_REF_PREFIX}feature`);
    expect(archived.headSha).toBe(head);
    expect(archived.sha).not.toBe(head);
    expect(archived.branchDeleted).toBe(true);
    expect(git(repo, 'rev-parse', archived.ref!)).toBe(archived.sha);
    // Private: not a branch, not a tag.
    expect(git(repo, 'branch', '--list', 'verse/feature')).toBe('');

    await restoreWorkspace(ws, archived);
    expect(existsSync(ws.path)).toBe(true);
    expect(git(ws.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('verse/feature');
    expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('one\nedited, not committed\n');
    expect(readFileSync(join(ws.path, 'new.txt'), 'utf8')).toBe('untracked\n');
    // Laid back as working changes, nothing staged.
    expect(git(ws.path, 'diff', '--cached', '--name-only')).toBe('');
    const status = git(ws.path, 'status', '--porcelain').split('\n').map((l) => l.trim());
    expect(status).toEqual(['M a.txt', '?? new.txt']);
  });

  it('refuses to restore over something that is already there', async () => {
    const made = await createAgentWorkspace(repo, 'clash', []);
    const ws = { ...made.workspace, portBase: 41000, portCount: 10 };
    const archived = await archiveWorkspace(ws, 'manual');
    mkdirSync(ws.path, { recursive: true });
    await expect(restoreWorkspace(ws, archived)).rejects.toThrow(/already exists/);
  });

  it('keeps live workspaces under the cap by archiving the oldest idle, unpinned agent (restorable)', async () => {
    let clock = '2026-01-01T00:00:00Z';
    const store = createAgentStore({ file: () => join(home, '.ashlr', 'verse', 'agents', 'agents.json'), now: () => new Date(clock) });
    const launcher: ScriptLauncher = { start: async () => ({ via: 'process', tabId: null }), status: () => null, log: () => null, stop: () => undefined };
    const deps: ActionDeps = { store, engine: () => null, launcher, priceOf: () => null };
    const make = async (id: string, name: string, at: string, pinned = false): Promise<AgentRecord> => {
      clock = at;
      const made = await createAgentWorkspace(repo, name, []);
      return store.put({ ...blankAgent({ id, title: name, at }), pinned, workspace: { ...made.workspace, portBase: 41000, portCount: 10 } });
    };
    const pinned = await make('ag_1111111111111111', 'pinned', '2026-01-01T00:00:00Z', true);
    const oldest = await make('ag_2222222222222222', 'oldest', '2026-01-02T00:00:00Z');
    await make('ag_3333333333333333', 'newer', '2026-01-03T00:00:00Z');
    clock = '2026-01-04T00:00:00Z';

    const archived = await enforceWorkspaceCap(deps, 3);
    expect(archived).toEqual(['ag_2222222222222222']);
    const after = await store.get('ag_2222222222222222');
    expect(after!.archived).toMatchObject({ reason: 'cap', branchDeleted: false });
    expect(existsSync(oldest.workspace!.path)).toBe(false);
    expect((await store.get(pinned.id))!.archived).toBeNull();

    const restored = await restoreAgent(deps, after!);
    expect(restored.archived).toBeNull();
    expect(existsSync(oldest.workspace!.path)).toBe(true);

    // Archive again by hand: same path back to the archive, idempotent on a second call.
    const again = await archiveAgent(deps, restored, 'manual', null);
    expect(again.archived!.reason).toBe('manual');
    expect(await archiveAgent(deps, again, 'manual', null)).toBe(again);
  });
});

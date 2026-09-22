/**
 * workspace-model.test.ts — the honesty rules for multi-root sessions.
 *
 * These are the rules that decide what the operator is TOLD, so each one is
 * pinned: a root with no repo must not render as a blank (which reads
 * "clean"), an unenrolled root must be described as refused by the AUTONOMOUS
 * lane rather than unusable here, and an unreachable root must still be
 * listed.
 */
import { describe, expect, it } from 'vitest';
import type { VerseRootStatus, VerseWorkspace } from '../../data/api-types.js';
import {
  isMultiRoot,
  MAX_WORKSPACE_ROOTS,
  ROOT_PRIORITY_NOTE,
  rootCaveat,
  rootGitLine,
  rootScopeLabel,
  rootTone,
  sessionRootPaths,
  validateRootSet,
  workspacePrimary,
  workspaceSummary,
} from './workspace-model.js';

function root(overrides: Partial<VerseRootStatus> = {}): VerseRootStatus {
  return {
    path: '/repo/service',
    name: 'service',
    primary: true,
    exists: true,
    enrolled: true,
    git: { branch: 'main', dirty: 0, ahead: 0, behind: 0, remote: null },
    reachable: true,
    ...overrides,
  };
}

describe('sessionRootPaths', () => {
  it('a pre-workspace session yields exactly its primary', () => {
    expect(sessionRootPaths({ projectPath: '/a' })).toEqual(['/a']);
    expect(isMultiRoot({ projectPath: '/a' })).toBe(false);
  });

  it('keeps the primary first and drops a duplicate of it', () => {
    expect(sessionRootPaths({ projectPath: '/a', extraRoots: ['/b', '/a'] })).toEqual(['/a', '/b']);
    expect(isMultiRoot({ projectPath: '/a', extraRoots: ['/b'] })).toBe(true);
  });

  it('labels the extra count without hiding the primary', () => {
    expect(rootScopeLabel({ projectPath: '/a' }, 'service')).toBe('service');
    expect(rootScopeLabel({ projectPath: '/a', extraRoots: ['/b', '/c'] }, 'service')).toBe('service +2');
  });
});

describe('rootGitLine', () => {
  it('is null for a non-repo, so the caller can say so in words', () => {
    expect(rootGitLine(root({ git: null }))).toBeNull();
  });

  it('reports the branch and a COUNT of dirty entries, not just "modified"', () => {
    expect(rootGitLine(root())).toBe('main · clean');
    expect(rootGitLine(root({ git: { branch: 'feat/x', dirty: 7, ahead: 0, behind: 0, remote: null } })))
      .toBe('feat/x · 7 changed');
  });

  it('adds drift only when there is drift', () => {
    expect(rootGitLine(root({ git: { branch: 'main', dirty: 0, ahead: 2, behind: 3, remote: null } })))
      .toBe('main · clean · 2 ahead · 3 behind');
  });
});

describe('rootTone and rootCaveat', () => {
  it('a missing root outranks an unreachable one', () => {
    expect(rootTone(root({ exists: false, reachable: false }))).toBe('missing');
    expect(rootCaveat(root({ exists: false }))).toBe('missing on disk');
  });

  it('an unreachable root is marked, not hidden', () => {
    const unreachable = root({ primary: false, reachable: false });
    expect(rootTone(unreachable)).toBe('unreachable');
    expect(rootCaveat(unreachable)).toBe('this engine cannot reach it');
  });

  it('an unenrolled root names the AUTONOMOUS lane, not this chat', () => {
    const caveat = rootCaveat(root({ enrolled: false }));
    expect(caveat).toContain('not enrolled');
    expect(caveat).toContain('autonomous lane refuses it');
    // It must not claim this chat cannot use the folder — it can.
    expect(caveat).not.toContain('cannot be used');
  });

  it('says nothing when there is nothing to say', () => {
    expect(rootCaveat(root())).toBeNull();
    expect(rootTone(root())).toBe('primary');
    expect(rootTone(root({ primary: false }))).toBe('extra');
  });
});

describe('priority copy', () => {
  it('states that priority never widens scope, at the point of the choice', () => {
    expect(ROOT_PRIORITY_NOTE).toContain('never adds one');
    expect(ROOT_PRIORITY_NOTE).toContain('not enrolled');
  });
});

describe('validateRootSet', () => {
  it('accepts a primary plus extras and de-duplicates', () => {
    expect(validateRootSet('/a', ['/b', '/b', ''])).toEqual({ ok: true, error: null, roots: ['/a', '/b'] });
  });

  it('refuses a missing or relative primary', () => {
    expect(validateRootSet('  ', []).error).toMatch(/primary folder/i);
    expect(validateRootSet('rel/path', []).error).toMatch(/absolute/);
  });

  it('names the offending extra root rather than failing vaguely', () => {
    expect(validateRootSet('/a', ['nope']).error).toContain('nope');
  });

  it('caps the set', () => {
    const extras = Array.from({ length: MAX_WORKSPACE_ROOTS }, (_, i) => `/x${i}`);
    expect(validateRootSet('/a', extras).error).toMatch(/at most 8/);
  });

  it('accepts the `~/` spelling the server round-trips', () => {
    expect(validateRootSet('~/code/app', []).ok).toBe(true);
  });
});

describe('workspace helpers', () => {
  const workspace: VerseWorkspace = {
    id: 'w1',
    name: 'Ashlr Verse',
    roots: [
      { path: '/a', name: 'a', primary: false },
      { path: '/b', name: 'b', primary: true },
    ],
    section: true,
    createdAt: 'x',
    updatedAt: 'x',
  };

  it('finds the primary wherever it sits in the list', () => {
    expect(workspacePrimary(workspace)).toBe('/b');
  });

  it('falls back to the first root when none is flagged', () => {
    expect(workspacePrimary({ ...workspace, roots: [{ path: '/a', name: 'a', primary: false }] })).toBe('/a');
    expect(workspacePrimary({ ...workspace, roots: [] })).toBeNull();
  });

  it('summarises by folder count', () => {
    expect(workspaceSummary(workspace)).toBe('2 folders');
    expect(workspaceSummary({ ...workspace, roots: [workspace.roots[0]!] })).toBe('1 folder');
  });
});

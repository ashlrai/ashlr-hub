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
  defaultWorkspaceName,
  engineReachesExtraRoots,
  EXTRA_ROOTS_REACHABLE_NOTE,
  extraRootsCaveat,
  extraRootsNote,
  isMultiRoot,
  MAX_WORKSPACE_ROOTS,
  moveRoot,
  orderedWorkspaceRoots,
  priorityOf,
  rankPathsByPriority,
  ROOT_PRIORITY_NOTE,
  rootCaveat,
  rootGitLine,
  rootRowLabel,
  rootScopeLabel,
  rootTone,
  sessionRootPaths,
  validateRootSet,
  validateWorkspaceDraft,
  workspacePrimary,
  workspaceRootPaths,
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

  it('sends the primary FIRST, whatever order it was stored in', () => {
    // The update route replaces the set wholesale with "first entry is
    // primary", so a record that stored the primary second must not be able to
    // demote it just by being round-tripped.
    expect(workspaceRootPaths(workspace)).toEqual(['/b', '/a']);
    expect(orderedWorkspaceRoots(workspace).map((r) => r.primary)).toEqual([true, false]);
  });

  it('leaves the stored order alone when no root is flagged primary', () => {
    const unflagged = { ...workspace, roots: workspace.roots.map((r) => ({ ...r, primary: false })) };
    expect(workspaceRootPaths(unflagged)).toEqual(['/a', '/b']);
  });
});

// ---------------------------------------------------------------------------
// Which engines reach more than one folder
// ---------------------------------------------------------------------------

describe('engineReachesExtraRoots', () => {
  it('names grok as the one engine with no additional-directory flag', () => {
    expect(engineReachesExtraRoots('claude')).toBe(true);
    expect(engineReachesExtraRoots('codex')).toBe(true);
    expect(engineReachesExtraRoots('local')).toBe(true);
    expect(engineReachesExtraRoots('grok')).toBe(false);
  });

  it('warns about nothing before a seat is chosen', () => {
    expect(engineReachesExtraRoots(null)).toBe(true);
    expect(engineReachesExtraRoots(undefined)).toBe(true);
  });
});

describe('extraRootsCaveat', () => {
  it('says the extra folders are unreachable on a grok seat', () => {
    const caveat = extraRootsCaveat('grok', 3);
    expect(caveat).toContain('only the primary folder');
    expect(caveat).toContain('unreachable');
  });

  it('is silent for an engine that reaches them', () => {
    expect(extraRootsCaveat('claude', 3)).toBeNull();
    expect(extraRootsCaveat('codex', 3)).toBeNull();
    expect(extraRootsCaveat('local', 3)).toBeNull();
  });

  it('is silent when there is only one folder — grok reaches that one', () => {
    expect(extraRootsCaveat('grok', 1)).toBeNull();
    expect(extraRootsCaveat('grok', 0)).toBeNull();
  });

  it('still says the enrolment sentence where there is no caveat to give', () => {
    expect(extraRootsNote('claude', 2)).toBe(EXTRA_ROOTS_REACHABLE_NOTE);
    expect(extraRootsNote('grok', 2)).toBe(extraRootsCaveat('grok', 2));
    expect(extraRootsNote('claude', 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Saved projects
// ---------------------------------------------------------------------------

describe('defaultWorkspaceName', () => {
  it('is the folder’s own name', () => {
    expect(defaultWorkspaceName('/Users/mason/dev/hub')).toBe('hub');
    expect(defaultWorkspaceName('/Users/mason/dev/hub/')).toBe('hub');
    expect(defaultWorkspaceName('  ~/code/app  ')).toBe('app');
  });
});

describe('validateWorkspaceDraft', () => {
  it('names the project after the primary folder when nothing was typed', () => {
    expect(validateWorkspaceDraft('', ['/Users/mason/dev/hub', '/Users/mason/dev/lib']))
      .toEqual({ ok: true, error: null, name: 'hub', roots: ['/Users/mason/dev/hub', '/Users/mason/dev/lib'] });
  });

  it('keeps a typed name, trimmed', () => {
    expect(validateWorkspaceDraft('  Service + lib  ', ['/a']).name).toBe('Service + lib');
  });

  it('refuses the same paths validateRootSet refuses, with the same words', () => {
    expect(validateWorkspaceDraft('x', []).error).toMatch(/primary folder/i);
    expect(validateWorkspaceDraft('x', ['rel/path']).error).toMatch(/absolute/);
    expect(validateWorkspaceDraft('x', ['/a', 'nope']).error).toContain('nope');
  });

  it('de-duplicates and drops blanks, exactly like the chat path', () => {
    expect(validateWorkspaceDraft('x', ['/a', '', '/b', '/a']).roots).toEqual(['/a', '/b']);
  });
});

describe('moveRoot', () => {
  const roots = ['/a', '/b', '/c'];

  it('produces the order it claims', () => {
    expect(moveRoot(roots, 1, 'up')).toEqual(['/b', '/a', '/c']);
    expect(moveRoot(roots, 1, 'down')).toEqual(['/a', '/c', '/b']);
  });

  it('makes the moved folder the PRIMARY when it reaches the top', () => {
    // The first entry is the primary — that is the whole contract of the
    // update route — so "move up" from index 1 is how a primary is changed.
    expect(moveRoot(roots, 1, 'up')[0]).toBe('/b');
  });

  it('is a no-op at either end, so a disabled button and the maths agree', () => {
    expect(moveRoot(roots, 0, 'up')).toEqual(roots);
    expect(moveRoot(roots, 2, 'down')).toEqual(roots);
    expect(moveRoot(roots, 9, 'up')).toEqual(roots);
  });

  it('never mutates the input', () => {
    const original = [...roots];
    moveRoot(roots, 1, 'up');
    expect(roots).toEqual(original);
  });

  it('labels the first row as the primary, not "Folder 1"', () => {
    expect(rootRowLabel(0)).toBe('Primary folder');
    expect(rootRowLabel(1)).toBe('Folder 2');
  });
});

describe('priority ranking', () => {
  const priorities = { '/critical': 'critical', '/low': 'low', '/high': 'high' } as const;

  it('treats an absent path as normal, exactly as the server does', () => {
    expect(priorityOf('/unranked', priorities)).toBe('normal');
    expect(priorityOf('/unranked', undefined)).toBe('normal');
    expect(priorityOf('/low', priorities)).toBe('low');
  });

  it('orders critical → high → normal → low', () => {
    expect(rankPathsByPriority(['/low', '/unranked', '/critical', '/high'], priorities))
      .toEqual(['/critical', '/high', '/unranked', '/low']);
  });

  it('is stable, so re-ranking one repo never shuffles the rest', () => {
    expect(rankPathsByPriority(['/a', '/b', '/c'], {})).toEqual(['/a', '/b', '/c']);
    expect(rankPathsByPriority(['/a', '/b', '/critical', '/c'], priorities))
      .toEqual(['/critical', '/a', '/b', '/c']);
  });

  it('adds and removes nothing — ordering only', () => {
    const paths = ['/low', '/critical', '/unranked'];
    expect([...rankPathsByPriority(paths, priorities)].sort()).toEqual([...paths].sort());
  });
});

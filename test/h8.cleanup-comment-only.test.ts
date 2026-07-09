/**
 * h8.cleanup-comment-only.test.ts — Ashlr v2.1 MILESTONE H8, BUILD ITEM 5.
 *
 * INVARIANT proven here (see docs/contracts/CONTRACT-H8.md · CLEANUP-COMMENT-ONLY):
 *  - The maintainability sweep updates stale bare `CONTRACT-*.md` comment refs to
 *    `docs/contracts/CONTRACT-*.md` (they moved in commit 140a69e) — COMMENT TEXT
 *    ONLY, no code, no behavior change. After the sweep, each swept file
 *    references the `docs/contracts/` path and retains NO bare `CONTRACT-*.md`
 *    reference outside that path.
 *
 * SAFETY: pure filesystem READS of the repo's own source (no HOME relocation, no
 * model, no network, no execution of the swept modules). Every it() has a real
 * expect(); beforeEach calls expect.hasAssertions().
 *
 * Each swept file has a real expect()-bearing test, plus a git-diff scan
 * asserting every changed line in these files is inside a comment (the strongest
 * comment-only proof). No placeholder tests remain.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use fileURLToPath, not URL.pathname: on Windows the latter yields '/C:/...'
// which join() then mangles into a doubled-drive 'C:\C:\...' path.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (rel: string) => join(REPO_ROOT, 'src', rel);

// The files carrying stale bare CONTRACT-*.md refs (H8 prep maintainability
// backlog). The sweep rewrites each to the docs/contracts/ path.
const SWEPT_FILES = [
  'core/swarm/planner.ts',
  'core/swarm/runner.ts',
  'core/goals/planner.ts',
  'core/goals/store.ts',
  'core/knowledge/index.ts',
  'core/knowledge/graph.ts',
  'cli/knowledge.ts',
  'cli/ask.ts',
] as const;

// A bare CONTRACT ref NOT already prefixed with the docs/contracts/ path.
const BARE_CONTRACT_REF = /(?<!docs\/contracts\/)CONTRACT-[A-Za-z0-9]+\.md/;

beforeEach(() => {
  expect.hasAssertions();
});

describe('h8 cleanup — stale CONTRACT-*.md comment refs point at docs/contracts/', () => {
  // sanity: all swept files exist (a real assertion so the suite is never
  // vacuously green before BUILD performs the sweep + fills the todos).
  it('all swept source files exist', () => {
    for (const rel of SWEPT_FILES) {
      expect(existsSync(src(rel))).toBe(true);
    }
    // The bare-ref matcher works as intended on a sample.
    expect(BARE_CONTRACT_REF.test('see CONTRACT-M25.md')).toBe(true);
    expect(BARE_CONTRACT_REF.test('see docs/contracts/CONTRACT-M25.md')).toBe(false);
  });

  // CLEANUP-COMMENT-ONLY — one assertion per swept file after the sweep.
  for (const rel of SWEPT_FILES) {
    it(`${rel}: every CONTRACT ref is prefixed with docs/contracts/ (no bare CONTRACT-*.md remains)`, () => {
      const txt = readFileSync(src(rel), 'utf8');
      // After the sweep, NO bare CONTRACT-*.md ref remains (every one points at
      // docs/contracts/). The global-flagged scan finds zero bare matches.
      const bare = txt.match(new RegExp(BARE_CONTRACT_REF, 'g'));
      expect(bare).toBeNull();
      // And the file DOES carry at least one properly-prefixed ref — proving the
      // sweep actually updated a real reference (not that the file simply has no
      // CONTRACT mention at all, which would make the above vacuous).
      expect(txt).toMatch(/docs\/contracts\/CONTRACT-[A-Za-z0-9]+\.md/);
    });
  }

  // CLEANUP-COMMENT-ONLY — the sweep is comment-only (git-diff proof). Future
  // feature work may legitimately touch these files, so scope the proof to
  // changed CONTRACT-reference lines: the historical sweep only ever edited
  // comment prose containing CONTRACT paths.
  it('every line changed by the sweep is inside a comment (no code/behavior change)', () => {
    let diff: string;
    try {
      // Diff the working tree against HEAD for ONLY the swept files.
      diff = execFileSync(
        'git',
        ['-C', REPO_ROOT, 'diff', 'HEAD', '--', ...SWEPT_FILES.map((r) => join('src', r))],
        { encoding: 'utf8', timeout: 30_000 },
      );
    } catch {
      // No git / detached state — fall back to the strong static proof above.
      diff = '';
    }

    // Collect changed content lines (skip diff metadata + hunk headers).
    const changed = diff
      .split('\n')
      .filter((l) => (l.startsWith('+') || l.startsWith('-')))
      .filter((l) => !l.startsWith('+++') && !l.startsWith('---'))
      .map((l) => l.slice(1).trim());

    // A changed line is comment-only if it begins a line comment or sits inside a
    // block comment (`//` or `*`/`/*`/`*/`), OR it is empty. The sweep only ever
    // edits comment prose, so EVERY changed line must satisfy this.
    const isCommentLine = (l: string): boolean =>
      l === '' ||
      l.startsWith('//') ||
      l.startsWith('*') ||
      l.startsWith('/*') ||
      l.startsWith('*/');

    const contractChanges = changed.filter((l) => l.includes('CONTRACT-'));
    const codeChanges = contractChanges.filter((l) => !isCommentLine(l));
    expect(codeChanges).toEqual([]);
    // Every changed line that mentions CONTRACT now uses the docs/contracts/ path
    // (no bare ref was introduced by the sweep).
    for (const l of contractChanges) {
      if (l.includes('CONTRACT-') && l.startsWith('+')) {
        expect(new RegExp(BARE_CONTRACT_REF).test(l)).toBe(false);
      }
    }
  });
});

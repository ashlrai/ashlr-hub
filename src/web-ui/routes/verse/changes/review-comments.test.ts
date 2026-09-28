import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffLine } from '../../inbox/diff-parser.js';
import {
  anchorLabel,
  anchorWhere,
  buildCommentsMessage,
  buildReReviewMessage,
  excerptFor,
  fenceFor,
  fenced,
  groupThreads,
  hunkCore,
  lineAnchor,
  loadComments,
  saveComments,
  storageKey,
  utf8Bytes,
  type ReviewComment,
} from './review-comments.js';

const ctx = (n: number, text = `line ${n}`): DiffLine => ({ kind: 'context', text, oldLineNo: n, newLineNo: n });
const add = (n: number, text: string): DiffLine => ({ kind: 'add', text, oldLineNo: null, newLineNo: n });
const del = (n: number, text: string): DiffLine => ({ kind: 'del', text, oldLineNo: n, newLineNo: null });

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: over.id ?? 'c1',
    path: 'src/a.ts',
    hunk: '@@ -40,3 +40,4 @@',
    line: 42,
    side: 'new',
    excerpt: [' line 41', '+const x = 1;', ' line 43'],
    excerptAt: 1,
    body: 'Rename x.',
    at: '2026-09-27T10:00:00.000Z',
    ...over,
  };
}

describe('anchors', () => {
  it('hunkCore drops the section text', () => {
    expect(hunkCore('@@ -20,2 +20,3 @@ function tail')).toBe('@@ -20,2 +20,3 @@');
    expect(hunkCore('@@ -1 +1 @@')).toBe('@@ -1 +1 @@');
    expect(hunkCore('not a header')).toBe('not a header');
  });

  it('a removed line anchors on the OLD side, everything else on the new', () => {
    expect(lineAnchor(del(17, 'x'))).toEqual({ line: 17, side: 'old' });
    expect(lineAnchor(add(42, 'x'))).toEqual({ line: 42, side: 'new' });
    expect(lineAnchor(ctx(5))).toEqual({ line: 5, side: 'new' });
  });

  it('labels: path:line, removed lines, whole hunks as ranges', () => {
    expect(anchorLabel({ path: 'src/a.ts', hunk: '@@ -1,3 +1,3 @@', line: 42, side: 'new' })).toBe('src/a.ts:42');
    expect(anchorLabel({ path: 'src/a.ts', hunk: '@@ -1,3 +1,3 @@', line: 17, side: 'old' })).toBe('src/a.ts:17 (removed line)');
    expect(anchorLabel({ path: 'src/a.ts', hunk: '@@ -20,2 +20,3 @@', line: null, side: 'new' })).toBe('src/a.ts:20-22');
    expect(anchorLabel({ path: 'src/a.ts', hunk: '@@ -0,0 +1 @@', line: null, side: 'new' })).toBe('src/a.ts:1');
    expect(anchorLabel({ path: 'gone.ts', hunk: '@@ -1,4 +0,0 @@', line: null, side: 'new' })).toBe('gone.ts:1-4 (removed)');
    expect(anchorWhere({ hunk: '@@ -20,2 +20,3 @@', line: null, side: 'new' })).toBe('Lines 20-22');
    expect(anchorWhere({ hunk: '@@ -20,2 +20,3 @@', line: 7, side: 'old' })).toBe('Removed line 7');
  });

  it('excerpts: the line with two either side; a whole hunk is its head', () => {
    const lines = [ctx(1), ctx(2), del(3, 'old'), add(3, 'new'), ctx(4), ctx(5), ctx(6)];
    expect(excerptFor(lines, 3)).toEqual({ excerpt: [' line 2', '-old', '+new', ' line 4', ' line 5'], excerptAt: 2 });
    expect(excerptFor(lines, 0)).toEqual({ excerpt: [' line 1', ' line 2', '-old'], excerptAt: 0 });
    const long = Array.from({ length: 20 }, (_, i) => ctx(i + 1));
    const whole = excerptFor(long, null);
    expect(whole.excerptAt).toBe(-1);
    expect(whole.excerpt).toHaveLength(13);
    expect(whole.excerpt.at(-1)).toBe(' … 8 more lines');
  });

  it('threads group comments on one anchor, in file and line order', () => {
    const threads = groupThreads([
      comment({ id: 'b', path: 'z.ts', line: 1 }),
      comment({ id: 'a2', line: 42, at: '2026-09-27T10:05:00.000Z' }),
      comment({ id: 'a0', line: null, hunk: '@@ -40,3 +40,4 @@' }),
      comment({ id: 'a1', line: 42 }),
    ]);
    expect(threads.map((t) => t.map((c) => c.id))).toEqual([['a0'], ['a1', 'a2'], ['b']]);
  });
});

describe('fences', () => {
  it('picks a fence longer than any backtick run inside', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('a ```js``` b')).toBe('````');
    expect(fenceFor('`````')).toBe('``````');
    expect(fenced('x ```` y\n\n', 'diff')).toBe('`````diff\nx ```` y\n`````');
  });
});

describe('Send N comments', () => {
  it('one message: path:line — comment, threads share one fenced excerpt', () => {
    const built = buildCommentsMessage(
      [
        comment({ id: 'a1' }),
        comment({ id: 'a2', body: 'And add a test.\nCover the zero case.', at: '2026-09-27T10:01:00.000Z' }),
        comment({ id: 'r', line: 7, side: 'old', hunk: '@@ -5,4 +5,3 @@', excerpt: ['-gone();'], excerptAt: 0, body: 'Why remove this?' }),
      ],
      { turnLabel: 'turn 2' },
    );
    expect(built.included).toEqual(['r', 'a1', 'a2']);
    expect(built.omitted).toBe(0);
    expect(built.text).toMatch(/^Review comments on your changes in turn 2 \(3 comments, anchored as path:line\)\./);
    expect(built.text).toContain('src/a.ts:7 (removed line) — Why remove this?\n```diff\n-gone();\n```');
    expect(built.text).toContain('src/a.ts:42 — Rename x.\nsrc/a.ts:42 — And add a test.\n  Cover the zero case.\n```diff\n line 41\n+const x = 1;\n line 43\n```');
  });

  it('an excerpt with backticks cannot close its fence', () => {
    const built = buildCommentsMessage([comment({ excerpt: ['+const s = ```;'], excerptAt: 0 })], { turnLabel: 'turn 1' });
    expect(built.text).toContain('````diff\n+const s = ```;\n````');
  });

  it('over the cap: excerpts shrink to the line, then go; what still does not fit stays drafted', () => {
    const big = Array.from({ length: 5 }, (_, i) => `+${'x'.repeat(200)}${i}`);
    const many = Array.from({ length: 8 }, (_, i) => comment({ id: `c${i}`, line: 10 + i, excerpt: big, excerptAt: 2, body: `note ${i}` }));
    const lineOnly = buildCommentsMessage(many, { turnLabel: 'turn 1', maxBytes: 4_000 });
    expect(lineOnly.omitted).toBe(0);
    expect(lineOnly.text).toContain(`\`\`\`diff\n${big[2]}\n\`\`\``);
    expect(lineOnly.text).not.toContain(big[0]!);
    expect(utf8Bytes(lineOnly.text)).toBeLessThanOrEqual(4_000);

    const none = buildCommentsMessage(many, { turnLabel: 'turn 1', maxBytes: 1_200 });
    expect(none.text).not.toContain('```');
    expect(none.omitted).toBe(0);

    const long = Array.from({ length: 4 }, (_, i) => comment({ id: `l${i}`, line: 10 + i, body: 'y'.repeat(600) }));
    const partial = buildCommentsMessage(long, { turnLabel: 'turn 1', maxBytes: 1_500 });
    expect(partial.included).toEqual(['l0', 'l1']);
    expect(partial.omitted).toBe(2);
    expect(utf8Bytes(partial.text)).toBeLessThanOrEqual(1_500);
  });
});

describe('Re-review with…', () => {
  const PATCH_A = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const PATCH_MD = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,3 @@\n+```sh\n+npm test\n+```\n';

  it('a read-only review turn: the reviewPrompt wording, the scope, the fenced diff and the drafts as context', () => {
    const { text, shownFiles } = buildReReviewMessage({
      authorLabel: 'Claude Code',
      scopeLabel: 'turn 2',
      patches: [{ path: 'src/a.ts', text: PATCH_A }, { path: 'README.md', text: PATCH_MD }],
      unshown: ['logo.png'],
      totals: { files: 3, additions: 4, deletions: 1 },
      comments: [comment()],
    });
    expect(shownFiles).toBe(2);
    expect(text).toMatch(/^You are reviewing work produced by another model \(Claude Code\)/);
    expect(text).toContain('change nothing');
    expect(text).toContain('The changes to review: turn 2, 3 files (+4 −1).');
    expect(text).toContain('Not included here (read them in the repository): logo.png.');
    // The markdown's own fence cannot close the diff's.
    expect(text).toContain('````diff\ndiff --git a/src/a.ts b/src/a.ts');
    expect(text).toMatch(/\+```\n````/);
    expect(text).toContain('The operator’s own review notes so far');
    expect(text).toContain('src/a.ts:42 — Rename x.');
  });

  it('fits the cap: whole files first, one cut at a line, the rest named', () => {
    const big = (name: string) => `diff --git a/${name} b/${name}\n@@ -1,200 +1,200 @@\n${Array.from({ length: 200 }, (_, i) => `+line ${i} ${'z'.repeat(40)}`).join('\n')}\n`;
    const { text, shownFiles, cutFiles } = buildReReviewMessage({
      authorLabel: 'Codex',
      scopeLabel: 'turn 1',
      patches: [{ path: 'small.ts', text: PATCH_A }, { path: 'one.ts', text: big('one.ts') }, { path: 'two.ts', text: big('two.ts') }],
      unshown: [],
      totals: { files: 3, additions: 400, deletions: 1 },
      comments: [],
      maxBytes: 6_000,
    });
    expect(utf8Bytes(text)).toBeLessThanOrEqual(6_000);
    expect(shownFiles).toBe(2);
    expect(cutFiles).toEqual(['one.ts']);
    expect(text).toContain('… (rest of one.ts cut to fit)');
    expect(text).toContain('Not included here (read them in the repository): two.ts.');
    expect(text).not.toContain('operator’s own review notes');
  });
});

describe('draft storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips per chat + turn; an empty list removes the key', () => {
    expect(loadComments('chat-1', 'turn-1')).toEqual([]);
    expect(saveComments('chat-1', 'turn-1', [comment()])).toBe(true);
    expect(loadComments('chat-1', 'turn-1')).toEqual([comment()]);
    expect(loadComments('chat-1', 'turn-2')).toEqual([]);
    saveComments('chat-1', 'turn-1', []);
    expect(localStorage.getItem(storageKey('chat-1', 'turn-1'))).toBeNull();
  });

  it('ignores junk: bad JSON, a non-array, malformed entries', () => {
    localStorage.setItem(storageKey('c', 't'), '{nope');
    expect(loadComments('c', 't')).toEqual([]);
    localStorage.setItem(storageKey('c', 't'), '{"a":1}');
    expect(loadComments('c', 't')).toEqual([]);
    localStorage.setItem(storageKey('c', 't'), JSON.stringify([comment(), { id: 'x', path: 1 }, null]));
    expect(loadComments('c', 't')).toEqual([comment()]);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(loadComments('c', 't')).toEqual([]);
    expect(saveComments('c', 't', [comment()])).toBe(false);
  });
});

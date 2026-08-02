import { describe, expect, it } from 'vitest';

import { measureAutoMergeDiffScope } from '../src/core/foundry/automerge-diff-scope.js';

function deletionDiff(name: string): string {
  return [
    `diff --git a/${name} b/${name}`,
    'deleted file mode 100644',
    `--- a/${name}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-removed',
    '',
  ].join('\n');
}

function specialModeDiff(mode: '120000' | '160000', kind: 'new' | 'deleted' | 'modified'): string {
  const path = `fixtures/${mode}-${kind}`;
  if (kind === 'new') {
    return [
      `diff --git a/${path} b/${path}`,
      `new file mode ${mode}`,
      'index 0000000..1111111',
      '--- /dev/null',
      `+++ b/${path}`,
      '@@ -0,0 +1 @@',
      '+target',
      '',
    ].join('\n');
  }
  if (kind === 'deleted') {
    return [
      `diff --git a/${path} b/${path}`,
      `deleted file mode ${mode}`,
      'index 1111111..0000000',
      `--- a/${path}`,
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-target',
      '',
    ].join('\n');
  }
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 ${mode}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old-target',
    '+new-target',
    '',
  ].join('\n');
}

describe('M466 canonical auto-merge diff scope', () => {
  it('counts five deletion-only files against a four-file cap', () => {
    const result = measureAutoMergeDiffScope(
      Array.from({ length: 5 }, (_, index) => deletionDiff(`docs/deleted-${index}.md`)).join(''),
    );

    expect(result).toMatchObject({
      ok: true,
      files: 5,
      changedLines: 5,
      additions: 0,
      deletions: 5,
    });
  });

  it('counts a rename and deletion exactly once each while retaining all paths', () => {
    const diff = [
      'diff --git a/docs/before.md b/docs/after.md',
      'similarity index 100%',
      'rename from docs/before.md',
      'rename to docs/after.md',
      deletionDiff('docs/obsolete.md'),
    ].join('\n');

    const result = measureAutoMergeDiffScope(diff);

    expect(result).toMatchObject({
      ok: true,
      files: 2,
      changedLines: 1,
      additions: 0,
      deletions: 1,
    });
    expect(result.ok && result.touchedPaths).toEqual([
      'docs/after.md',
      'docs/before.md',
      'docs/obsolete.md',
    ]);
  });

  it('counts empty add, empty delete, and mode-only modifications from Git metadata', () => {
    const result = measureAutoMergeDiffScope([
      'diff --git a/docs/empty-new.md b/docs/empty-new.md',
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/docs/empty-old.md b/docs/empty-old.md',
      'deleted file mode 100644',
      'index e69de29..0000000',
      'diff --git a/scripts/tool b/scripts/tool',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n'));

    expect(result).toMatchObject({ ok: true, files: 3, changedLines: 0 });
    expect(result.ok && result.entries).toEqual([
      expect.objectContaining({ oldPath: null, newPath: 'docs/empty-new.md' }),
      expect.objectContaining({ oldPath: 'docs/empty-old.md', newPath: null }),
      expect.objectContaining({ oldPath: 'scripts/tool', newPath: 'scripts/tool' }),
    ]);
  });

  it.each([
    ['120000', 'new'],
    ['120000', 'deleted'],
    ['120000', 'modified'],
    ['160000', 'new'],
    ['160000', 'deleted'],
    ['160000', 'modified'],
  ] as const)('rejects %s %s patches from autonomous scope authority', (mode, kind) => {
    expect(measureAutoMergeDiffScope(specialModeDiff(mode, kind))).toEqual({
      ok: false,
      reason: 'unsupported-file-mode',
    });
  });

  it.each([
    [
      'regular new-file declaration with a conflicting index mode',
      [
        'diff --git a/docs/mixed.md b/docs/mixed.md',
        'new file mode 100644',
        'index 0000000..1111111 100755',
        '--- /dev/null',
        '+++ b/docs/mixed.md',
        '@@ -0,0 +1 @@',
        '+content',
        '',
      ].join('\n'),
      'malformed-file-header',
    ],
    [
      'mode transition with contradictory index mode',
      [
        'diff --git a/scripts/tool b/scripts/tool',
        'old mode 100644',
        'new mode 100755',
        'index 1111111..2222222 100755',
        '',
      ].join('\n'),
      'malformed-file-header',
    ],
    [
      'regular file converted to symlink',
      [
        'diff --git a/docs/a.md b/docs/a.md',
        'old mode 100644',
        'new mode 120000',
        '',
      ].join('\n'),
      'unsupported-file-mode',
    ],
    [
      'unknown file mode spelling',
      'diff --git a/docs/a.md b/docs/a.md\nnew file mode 12000\n',
      'malformed-file-header',
    ],
  ])('rejects %s fail-closed', (_label, diff, reason) => {
    expect(measureAutoMergeDiffScope(diff)).toEqual({ ok: false, reason });
  });

  it('uses additions plus deletions as the sole changed-line definition', () => {
    const result = measureAutoMergeDiffScope([
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-old',
      '+new',
      '+added',
      '',
    ].join('\n'));

    expect(result).toMatchObject({
      ok: true,
      files: 1,
      changedLines: 3,
      additions: 2,
      deletions: 1,
    });
  });

  it('accepts canonical no-newline markers without counting them', () => {
    const result = measureAutoMergeDiffScope([
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n'));

    expect(result).toMatchObject({ ok: true, files: 1, changedLines: 2 });
  });

  it.each([
    [
      'malformed git header',
      'diff --git a/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-old\n+new\n',
      'malformed-diff-header',
    ],
    [
      'mismatched file header',
      'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/b.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-old\n+new\n',
      'file-header-mismatch',
    ],
    [
      'dishonest hunk cardinality',
      'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-old\n+new\n+extra\n',
      'malformed-file-header',
    ],
    [
      'rename metadata that disagrees with hunk paths',
      [
        'diff --git a/docs/old.md b/docs/new.md',
        'rename from docs/old.md',
        'rename to docs/new.md',
        '--- a/src/security.ts',
        '+++ b/src/security.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
      'file-header-mismatch',
    ],
    [
      'reversed file headers',
      'diff --git a/docs/a.md b/docs/a.md\n+++ b/docs/a.md\n--- a/docs/a.md\n@@ -1 +1 @@\n-old\n+new\n',
      'malformed-file-header',
    ],
  ])('rejects %s fail-closed', (_label, diff, reason) => {
    expect(measureAutoMergeDiffScope(diff)).toEqual({ ok: false, reason });
  });
});

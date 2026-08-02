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

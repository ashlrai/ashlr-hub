import { describe, expect, it } from 'vitest';

import { classifyDiff, isTrivialProposal } from '../src/planning/triviality.js';

describe('M350 trivial proposal diff classifier', () => {
  it('counts only hunk changed lines and tags markdown as docs', () => {
    const diff = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,2 +1,2 @@',
      ' # Ashlr',
      '-old docs',
      '+new docs',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['docs'],
    });
    expect(isTrivialProposal(diff)).toBe(true);
  });

  it('tags comment-only code changes as comments', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' export function foo() {',
      '-  // old explanation',
      '+  // new explanation',
      ' }',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['comments'],
    });
    expect(isTrivialProposal(diff)).toBe(true);
  });

  it('tags indentation-only rewrites as formatting', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' if (ok) {',
      '-const value = call(arg);',
      '+  const value = call(arg);',
      ' }',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['formatting'],
    });
    expect(isTrivialProposal(diff)).toBe(true);
  });

  it('fails closed for semantic code changes', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' export function foo() {',
      '-  return false;',
      '+  return true;',
      ' }',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('does not mark threshold-sized trivial diffs as trivial', () => {
    const changed = Array.from({ length: 15 }, (_, i) => `+line ${i}`);
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -0,0 +1,15 @@',
      ...changed,
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 15,
      categories: ['docs'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
    expect(isTrivialProposal(diff, 16)).toBe(true);
  });

  it('fails closed for semantic comment directives', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' export function foo(value: unknown) {',
      '-  // @ts-ignore',
      '+  // @ts-expect-error intentional fixture',
      '   return value.missing();',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('fails closed when whitespace changes string semantics', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-export const label = "a b";',
      '+export const label = "ab";',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('does not treat leading star code as a comment', () => {
    const diff = [
      'diff --git a/src/pointer.c b/src/pointer.c',
      '--- a/src/pointer.c',
      '+++ b/src/pointer.c',
      '@@ -1 +1 @@',
      '-*enabled = false;',
      '+*enabled = true;',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });

  it('does not treat fixture text as docs', () => {
    const diff = [
      'diff --git a/test/fixtures/expected.txt b/test/fixtures/expected.txt',
      '--- a/test/fixtures/expected.txt',
      '+++ b/test/fixtures/expected.txt',
      '@@ -1 +1 @@',
      '-old snapshot',
      '+new snapshot',
    ].join('\n');

    expect(classifyDiff(diff)).toEqual({
      changedLines: 2,
      categories: ['code'],
    });
    expect(isTrivialProposal(diff)).toBe(false);
  });
});

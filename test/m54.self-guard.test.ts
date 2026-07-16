/**
 * M54 - fail-closed test-infrastructure guard, self-target detection, and parity.
 */

import { describe, it, expect } from 'vitest';
import {
  isSafetyTestFile,
  guardSafetyTests,
  selfEvalParity,
  selfEvalParityAsync,
  isSelfTargetProposal,
} from '../src/core/fleet/self.js';
import type { Proposal } from '../src/core/types.js';

function newFileDiff(path: string, source: string, mode = '100644'): string {
  const lines = source.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function editFileDiff(path: string, added = 'const changed = true;'): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1,2 @@',
    ' const existing = true;',
    `+${added}`,
    '',
  ].join('\n');
}

function deleteFileDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    `--- a/${path}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-const existing = true;',
    '',
  ].join('\n');
}

describe('M54 - protected test infrastructure paths', () => {
  it('protects test trees, colocated tests, configs, and repository test scripts case-insensitively', () => {
    for (const path of [
      'test/m54.self-guard.test.ts',
      'TEST/setup/home.ts',
      'tests/helpers/runtime.ts',
      'src/__TESTS__/unit.ts',
      'src/core/router.spec.ts',
      'src/core/router.TEST.TSX',
      'vitest.config.ts',
      'Vitest.workspace.mts',
      'jest.config.cjs',
      'scripts/test-ci.mjs',
      'SCRIPTS/TEST-native-path-lifecycle.mjs',
    ]) {
      expect(isSafetyTestFile(path), path).toBe(true);
    }
  });

  it('does not classify unrelated source, docs, or similarly named paths', () => {
    for (const path of [
      'src/core/fleet/self.ts',
      'src/contest.ts',
      'docs/test-guide.md',
      'scripts/build.ts',
      'README.md',
      'package.json',
    ]) {
      expect(isSafetyTestFile(path), path).toBe(false);
    }
  });
});

describe('M54 - guardSafetyTests path-only policy', () => {
  it('refuses every new test file regardless of source or executable mode', () => {
    const diffs = [
      newFileDiff('test/new.test.ts', "it('works', () => expect(true).toBe(true));"),
      newFileDiff('src/core/new.spec.ts', "it('works', () => {});"),
      newFileDiff('tests/new.test.ts', "it('works', () => {});", '100755'),
    ];

    for (const diff of diffs) {
      expect(guardSafetyTests(diff)).toMatchObject({
        weakened: true,
        reason: expect.stringMatching(/protected test infrastructure/),
      });
    }
  });

  it('refuses existing test, setup, helper, fixture, config, and test-script edits', () => {
    for (const path of [
      'test/existing.test.ts',
      'test/setup/home.ts',
      'test/helpers/h1-fixture.ts',
      'test/fixtures/package.json',
      'vitest.config.ts',
      'jest.config.ts',
      'scripts/test-ci.mjs',
      'scripts/test-native-path-lifecycle.mjs',
    ]) {
      const verdict = guardSafetyTests(editFileDiff(path));
      expect(verdict.weakened, path).toBe(true);
      expect(verdict.files, path).toContain(path);
    }
  });

  it('refuses deletion, rename-out, rename-in, copy-in, and case aliases', () => {
    const diffs = [
      deleteFileDiff('test/deleted.test.ts'),
      [
        'diff --git a/test/old.test.ts b/archive/old.ts',
        'similarity index 100%',
        'rename from test/old.test.ts',
        'rename to archive/old.ts',
        '',
      ].join('\n'),
      [
        'diff --git a/src/old.ts b/tests/new.test.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to tests/new.test.ts',
        '',
      ].join('\n'),
      [
        'diff --git a/src/fixture.ts b/test/fixtures/copied.ts',
        'similarity index 100%',
        'copy from src/fixture.ts',
        'copy to test/fixtures/copied.ts',
        '',
      ].join('\n'),
      editFileDiff('Test/existing.test.ts'),
      editFileDiff('src/__Tests__/existing.ts'),
    ];

    for (const diff of diffs) {
      expect(guardSafetyTests(diff).weakened, diff).toBe(true);
    }
  });

  it('rejects obfuscated disabled/focused forms solely because their path is protected', () => {
    const lineContinuation = "test['sk" + String.fromCharCode(92) + '\n' + "ip']('disabled', () => {});";
    const forms = [
      "test.runIf(false)('disabled', () => {});",
      "test('disabled', { 'skip': true }, () => {});",
      "test('focused', { 'only': true }, () => {});",
      "test['sk' + 'ip']('disabled', () => {});",
      "test[`sk${''}ip`]('disabled', () => {});",
      lineContinuation,
      "Reflect.get(test, 'skip')('disabled', () => {});",
      "const { only: focused } = test; focused('focused', () => {});",
      "const mode = 'todo'; test[mode]('pending', () => {});",
    ];

    for (const [index, form] of forms.entries()) {
      const verdict = guardSafetyTests(newFileDiff(`test/obfuscated-${index}.test.ts`, form));
      expect(verdict.weakened, form).toBe(true);
      expect(verdict.reason, form).toMatch(/protected test infrastructure/);
    }
  });

  it('preserves ordinary source and documentation changes', () => {
    for (const path of ['src/core/run/router.ts', 'docs/test-guide.md', 'README.md']) {
      expect(guardSafetyTests(editFileDiff(path)).weakened, path).toBe(false);
    }

    const mixed = editFileDiff('src/core/run/router.ts') + deleteFileDiff('test/existing.test.ts');
    expect(guardSafetyTests(mixed)).toMatchObject({
      weakened: true,
      files: ['test/existing.test.ts'],
    });
  });

  it('supports canonical C-quoted ordinary paths and rejects disagreeing headers', () => {
    const quoted = [
      'diff --git "a/docs/test guide.md" "b/docs/test guide.md"',
      '--- "a/docs/test guide.md"',
      '+++ "b/docs/test guide.md"',
      '@@ -1 +1,2 @@',
      ' existing',
      '+changed',
      '',
    ].join('\n');
    expect(guardSafetyTests(quoted).weakened).toBe(false);

    const mismatched = editFileDiff('src/core/router.ts').replace(
      '+++ b/src/core/router.ts',
      '+++ b/src/core/other.ts',
    );
    expect(guardSafetyTests(mismatched)).toMatchObject({
      weakened: true,
      reason: expect.stringMatching(/unparseable diff/),
    });
  });

  it('fails closed for truncated protected diffs and existing byte/line bounds', () => {
    expect(guardSafetyTests('diff --git a/test/x.test.ts b/test/x.test.ts\n').weakened).toBe(true);
    expect(guardSafetyTests('x'.repeat(8 * 1024 * 1024 + 1)).weakened).toBe(true);
    expect(guardSafetyTests(`diff --git a/src/x.ts b/src/x.ts\n${'x\n'.repeat(100_001)}`).weakened).toBe(true);

    const multibyteDiff = newFileDiff(
      'test/multibyte.test.ts',
      `//${'界'.repeat(Math.ceil((8 * 1024 * 1024) / 3))}`,
    );
    expect(multibyteDiff.length).toBeLessThan(8 * 1024 * 1024);
    expect(Buffer.byteLength(multibyteDiff, 'utf8')).toBeGreaterThan(8 * 1024 * 1024);
    expect(guardSafetyTests(multibyteDiff).weakened).toBe(true);
  });

  it('treats an empty diff as not weakening', () => {
    expect(guardSafetyTests('')).toMatchObject({ weakened: false, files: [] });
  });
});

describe('M54 - selfEvalParity', () => {
  it('passes only when both flag states are green', () => {
    expect(selfEvalParity(() => true).ok).toBe(true);
    expect(selfEvalParity((flagOn) => flagOn).reason).toMatch(/flag OFF/);
    expect(selfEvalParity((flagOn) => !flagOn).reason).toMatch(/flag ON/);
  });

  it('fails closed when the runner throws', () => {
    expect(selfEvalParity(() => { throw new Error('boom'); }).ok).toBe(false);
  });
});

describe('M54 - selfEvalParityAsync', () => {
  it('awaits both asynchronous flag states', async () => {
    await expect(selfEvalParityAsync(async () => true)).resolves.toMatchObject({ ok: true });
    await expect(selfEvalParityAsync(async (flagOn) => !flagOn)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/flag ON/),
    });
  });

  it('fails closed when the asynchronous runner rejects', async () => {
    const verdict = await selfEvalParityAsync(async (flagOn) => {
      if (!flagOn) return true;
      throw new Error('boom');
    });
    expect(verdict.reason).toMatch(/flag ON/);
  });
});

describe('M54 - isSelfTargetProposal', () => {
  it('detects this ashlr-hub checkout', () => {
    expect(isSelfTargetProposal({ repo: process.cwd() } as Proposal)).toBe(true);
  });

  it('returns false for missing or non-ashlr repositories', () => {
    expect(isSelfTargetProposal({ repo: '/tmp/definitely-not-a-repo-xyz' } as Proposal)).toBe(false);
    expect(isSelfTargetProposal({ repo: null } as unknown as Proposal)).toBe(false);
  });
});

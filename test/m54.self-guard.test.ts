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

function binaryFileDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `Binary files a/${path} and b/${path} differ`,
    '',
  ].join('\n');
}

function modeOnlyDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'old mode 100644',
    'new mode 100755',
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
      'src/__snapshots__/router.test.ts.snap',
      'fixtures/router.snap',
      'vite.config.ts',
      'VITE.browser.config.mts',
      'vitest.config.ts',
      'vitest.unit.config.ts',
      'vitest.config.unit.ts',
      'Vitest.workspace.mts',
      'vitest.unit.workspace.ts',
      'jest.config.cjs',
      'jest.integration.config.cts',
      'jest.browser.projects.ts',
      'jest.config.json',
      'scripts/test-ci.mjs',
      'SCRIPTS/TEST-native-path-lifecycle.mjs',
      'scripts/run-tests.mjs',
      'scripts/ci-test.mjs',
      'scripts/native/run_tests.ts',
      'scripts/run-verify-command.mjs',
      'scripts/run-vitest.mjs',
      'scripts/vitest-runner.mjs',
      'scripts/runTests.mjs',
      'scripts/ci-test-native.mjs',
      'scripts/integration-test-suite.ts',
      'scripts/run-tests.pl',
      'scripts/run-tests.ksh',
      'scripts/vitest.mjs',
      'scripts/jest.js',
      'scripts/verify.mjs',
      'scripts/verification.ts',
      'scripts/vitest/run.mjs',
      'scripts/test-runner/index.ts',
      'scripts/tools/vitest.mjs',
      'scripts/bin/jest.js',
      'scripts/tools/verify.mjs',
      'scripts/run-specs.mjs',
      'scripts/spec-runner.ts',
      'scripts/run-spec.sh',
      'scripts/run-tests.r',
      'scripts/run-tests.nu',
      'scripts/run-tests.exs',
      'scripts/run-tests.jl',
      'scripts/run-tests.swift',
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
      'scripts/contest.ts',
      'scripts/latest.mjs',
      'scripts/docs/run-tests.md',
      'scripts/prod-test-data-migration.ts',
      'scripts/verify-release.ts',
      'scripts/verify-signature.py',
      'scripts/vitest-migration.ts',
      'scripts/jest-upgrade.rb',
      'scripts/test-data.json',
      'scripts/integration-test-results.xml',
      'scripts/test-report.html',
      'scripts/unit-test-logo.png',
      'docs/vite-config.md',
      'src/snapshot.ts',
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
      'src/__snapshots__/router.test.ts.snap',
      'fixtures/router.snap',
      'vite.config.ts',
      'vitest.unit.config.ts',
      'jest.integration.config.cts',
      'jest.config.json',
      'vitest.config.ts',
      'jest.config.ts',
      'scripts/test-ci.mjs',
      'scripts/test-native-path-lifecycle.mjs',
      'scripts/run-tests.mjs',
      'scripts/ci-test.mjs',
      'scripts/run-verify-command.mjs',
      'scripts/run-vitest.mjs',
      'scripts/vitest-runner.mjs',
      'scripts/runTests.mjs',
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

    const octalOrdinary = quoted.replaceAll('test guide.md', '\\303\\251 guide.md');
    expect(guardSafetyTests(octalOrdinary).weakened).toBe(false);

    const octalProtected = octalOrdinary.replaceAll('docs/', 'test/').replaceAll('.md', '.test.ts');
    expect(guardSafetyTests(octalProtected)).toMatchObject({
      weakened: true,
      files: ['test/é guide.test.ts'],
    });

    const mismatched = editFileDiff('src/core/router.ts').replace(
      '+++ b/src/core/router.ts',
      '+++ b/src/core/other.ts',
    );
    expect(guardSafetyTests(mismatched)).toMatchObject({
      weakened: true,
      reason: expect.stringMatching(/unparseable diff/),
    });
  });

  it('accepts valid ambiguous binary and mode-only diffs when every candidate is ordinary', () => {
    for (const diff of [
      binaryFileDiff('docs/x b/y.bin'),
      modeOnlyDiff('src/x b/tool.sh'),
    ]) {
      expect(guardSafetyTests(diff), diff).toMatchObject({
        weakened: false,
        reason: 'no protected test infrastructure touched',
      });
    }
  });

  it('protects unanimous ambiguous paths and fails closed when candidate classifications differ', () => {
    expect(guardSafetyTests(binaryFileDiff('test/x b/y.bin'))).toMatchObject({
      weakened: true,
      reason: expect.stringMatching(/protected test infrastructure/),
      files: ['test/x b/y.bin'],
    });

    const classificationSpoof = binaryFileDiff('scripts/run b/tests.mjs');
    expect(guardSafetyTests(classificationSpoof)).toMatchObject({
      weakened: true,
      reason: expect.stringMatching(/unparseable diff/),
      files: [],
    });

    const metadataDisambiguated = editFileDiff('scripts/run b/tests.mjs');
    expect(guardSafetyTests(metadataDisambiguated)).toMatchObject({
      weakened: true,
      reason: expect.stringMatching(/protected test infrastructure/),
      files: ['scripts/run b/tests.mjs'],
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

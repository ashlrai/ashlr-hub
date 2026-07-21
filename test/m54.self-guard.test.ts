/**
 * M54 — the never-weaken guard + self-target detection + self-eval parity.
 *
 * Hermetic; no spawn, no network. These are the load-bearing safety tests for
 * the self-improving fleet: a self-authored change can fix bugs and ADD tests,
 * but can NEVER delete or weaken a safety/invariant test, and is only eligible
 * when the suite is green flag-off AND flag-on.
 */

import { describe, it, expect } from 'vitest';
import {
  isSafetyTestFile,
  guardSafetyTests,
  guardTestIntegrity,
  selfEvalParity,
  selfEvalParityAsync,
  isSelfTargetProposal,
} from '../src/core/fleet/self.js';
import type { Proposal } from '../src/core/types.js';

describe('M54 — isSafetyTestFile', () => {
  it('recognizes the safety/invariant suites', () => {
    for (const f of [
      'test/h1.audit.test.ts',
      'test/h8.demo-safety.test.ts',
      'test/m45.foundry.test.ts',
      'test/m47.merge.test.ts',
      'test/m47_1.provenance.test.ts',
      'test/m51.trust.test.ts',
      'test/m52.confine.test.ts',
      'test/m54.self-guard.test.ts',
    ]) {
      expect(isSafetyTestFile(f), f).toBe(true);
    }
  });

  it('does NOT flag ordinary files', () => {
    for (const f of ['test/m99.random.test.ts', 'src/core/run/engines.ts', 'README.md']) {
      expect(isSafetyTestFile(f), f).toBe(false);
    }
  });
});

const delDiff = (path: string) =>
  `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-import { it } from 'vitest';\n-it('x', () => {});\n-// end\n`;

describe('M54 — guardSafetyTests (the never-weaken guard)', () => {
  it('REFUSES a diff that deletes a safety test file', () => {
    const v = guardSafetyTests(delDiff('test/h1.audit.test.ts'));
    expect(v.weakened).toBe(true);
    expect(v.reason).toMatch(/deletes safety/);
  });

  it('REFUSES a diff that nets out assertions from a safety test', () => {
    const diff = `diff --git a/test/m45.foundry.test.ts b/test/m45.foundry.test.ts\n--- a/test/m45.foundry.test.ts\n+++ b/test/m45.foundry.test.ts\n@@ -10,8 +10,4 @@\n-  it('blocks push', () => {\n-    expect(pushBlocked).toBe(true);\n-  });\n-  expect(scrubbed).toContain('REDACTED');\n+  // removed for "speed"\n`;
    const v = guardSafetyTests(diff);
    expect(v.weakened).toBe(true);
    expect(v.reason).toMatch(/removes \d+ assertion/);
  });

  it('REFUSES an equal-count assertion rewrite in a safety test', () => {
    const diff = `diff --git a/test/m54.self-guard.test.ts b/test/m54.self-guard.test.ts\n--- a/test/m54.self-guard.test.ts\n+++ b/test/m54.self-guard.test.ts\n@@ -10,5 +10,5 @@\n-  expect(realGate).toBe(true);\n+  expect(true).toBe(true);\n`;
    const v = guardSafetyTests(diff);
    expect(v.weakened).toBe(true);
    expect(v.reason).toMatch(/removes \d+ assertion/);
  });

  it('REFUSES assertion rewrites using await expect and matcher-chain lines', () => {
    const awaitDiff = `diff --git a/test/m51.trust.test.ts b/test/m51.trust.test.ts\n--- a/test/m51.trust.test.ts\n+++ b/test/m51.trust.test.ts\n@@ -10,5 +10,5 @@\n-  await expect(runGate()).resolves.toBe(true);\n+  await expect(runGate()).resolves.toBe(false);\n`;
    const matcherTailDiff = `diff --git a/test/m51.trust.test.ts b/test/m51.trust.test.ts\n--- a/test/m51.trust.test.ts\n+++ b/test/m51.trust.test.ts\n@@ -10,5 +10,5 @@\n-    ).toBe(true);\n+    ).toBe(false);\n`;

    expect(guardSafetyTests(awaitDiff).weakened).toBe(true);
    expect(guardSafetyTests(matcherTailDiff).weakened).toBe(true);
  });

  it('REFUSES skipped or focused safety tests', () => {
    const skipDiff = `diff --git a/test/m54.self-guard.test.ts b/test/m54.self-guard.test.ts\n--- a/test/m54.self-guard.test.ts\n+++ b/test/m54.self-guard.test.ts\n@@ -10,4 +10,4 @@\n-  it('checks the guard', () => {\n+  it.skip('checks the guard', () => {\n     expect(realGate).toBe(true);\n   });\n`;
    const onlyDiff = `diff --git a/test/m54.self-guard.test.ts b/test/m54.self-guard.test.ts\n--- a/test/m54.self-guard.test.ts\n+++ b/test/m54.self-guard.test.ts\n@@ -10,3 +10,6 @@\n+  describe.only('focused safety suite', () => {\n+    expect(realGate).toBe(true);\n+  });\n`;

    expect(guardSafetyTests(skipDiff).weakened).toBe(true);
    expect(guardSafetyTests(skipDiff).reason).toMatch(/skipped\/focused/);
    expect(guardSafetyTests(onlyDiff).weakened).toBe(true);
    expect(guardSafetyTests(onlyDiff).reason).toMatch(/skipped\/focused/);
  });

  it('REFUSES conditional skip wrappers in safety tests', () => {
    const diff = `diff --git a/test/h7.preflight.test.ts b/test/h7.preflight.test.ts\n--- a/test/h7.preflight.test.ts\n+++ b/test/h7.preflight.test.ts\n@@ -10,3 +10,6 @@\n+  describe.skipIf(true)('disabled safety suite', () => {\n+    expect(realGate).toBe(true);\n+  });\n`;
    const v = guardSafetyTests(diff);
    expect(v.weakened).toBe(true);
    expect(v.reason).toMatch(/skipped\/focused/);
  });

  it('ALLOWS a diff that ADDS assertions to a safety test', () => {
    const diff = `diff --git a/test/m47.merge.test.ts b/test/m47.merge.test.ts\n--- a/test/m47.merge.test.ts\n+++ b/test/m47.merge.test.ts\n@@ -10,2 +10,5 @@\n+  it('new case', () => {\n+    expect(thing).toBe(1);\n+  });\n`;
    expect(guardSafetyTests(diff).weakened).toBe(false);
  });

  it('ALLOWS a benign source-only diff', () => {
    const diff = `diff --git a/src/core/run/engines.ts b/src/core/run/engines.ts\n--- a/src/core/run/engines.ts\n+++ b/src/core/run/engines.ts\n@@ -1,1 +1,2 @@\n+// a harmless comment\n`;
    expect(guardSafetyTests(diff).weakened).toBe(false);
  });

  it('ADVERSARIAL: a diff that adds a real fix AND quietly deletes a safety test is REFUSED', () => {
    const diff =
      `diff --git a/src/core/run/router.ts b/src/core/run/router.ts\n--- a/src/core/run/router.ts\n+++ b/src/core/run/router.ts\n@@ -1,1 +1,2 @@\n+const fix = true; // legit improvement\n` +
      delDiff('test/m51.trust.test.ts');
    const v = guardSafetyTests(diff);
    expect(v.weakened).toBe(true);
    expect(v.files).toContain('test/m51.trust.test.ts');
  });

  it('treats an empty diff as not weakening', () => {
    expect(guardSafetyTests('').weakened).toBe(false);
  });
});

describe('M54 — guardTestIntegrity (evidence-mode regression protection)', () => {
  it('refuses deleting, weakening, or disabling ordinary test coverage', () => {
    const deleted = `diff --git a/test/m307.verify-before-judge.test.ts b/test/m307.verify-before-judge.test.ts\ndeleted file mode 100644\n--- a/test/m307.verify-before-judge.test.ts\n+++ /dev/null\n`;
    const removed = `diff --git a/test/m307.verify-before-judge.test.ts b/test/m307.verify-before-judge.test.ts\n--- a/test/m307.verify-before-judge.test.ts\n+++ b/test/m307.verify-before-judge.test.ts\n@@ -1 +0,0 @@\n-expect(realGate).toBe(true);\n`;
    const skipped = `diff --git a/test/m307.verify-before-judge.test.ts b/test/m307.verify-before-judge.test.ts\n--- a/test/m307.verify-before-judge.test.ts\n+++ b/test/m307.verify-before-judge.test.ts\n@@ -1 +1 @@\n-it('runs verification', () => {\n+it.skip('runs verification', () => {\n`;

    expect(guardTestIntegrity(deleted).weakened).toBe(true);
    expect(guardTestIntegrity(removed).reason).toMatch(/removes 1 assertion/);
    expect(guardTestIntegrity(skipped).reason).toMatch(/skipped\/focused/);
  });

  it('allows additive ordinary test coverage and ignores source-only diffs', () => {
    const additive = `diff --git a/test/m307.verify-before-judge.test.ts b/test/m307.verify-before-judge.test.ts\n--- a/test/m307.verify-before-judge.test.ts\n+++ b/test/m307.verify-before-judge.test.ts\n@@ -1 +1,2 @@\n+it('covers a fresh case', () => { expect(true).toBe(true); });\n`;
    const sourceOnly = `diff --git a/src/core/example.ts b/src/core/example.ts\n--- a/src/core/example.ts\n+++ b/src/core/example.ts\n@@ -1 +1 @@\n-export const oldValue = false;\n+export const newValue = true;\n`;

    expect(guardTestIntegrity(additive).weakened).toBe(false);
    expect(guardTestIntegrity(sourceOnly).weakened).toBe(false);
  });
});

describe('M54 — selfEvalParity (suite green flag-off AND flag-on)', () => {
  it('ok only when BOTH flag states are green', () => {
    expect(selfEvalParity(() => true).ok).toBe(true);
  });
  it('refuses when flag-OFF is red', () => {
    const v = selfEvalParity((flagOn) => flagOn /* off=false */);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/flag OFF/);
  });
  it('refuses when flag-ON is red', () => {
    const v = selfEvalParity((flagOn) => !flagOn /* on=false */);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/flag ON/);
  });
  it('fail-closed when the runner throws', () => {
    expect(
      selfEvalParity(() => {
        throw new Error('boom');
      }).ok,
    ).toBe(false);
  });
});

describe('M54 — selfEvalParityAsync (async suite green flag-off AND flag-on)', () => {
  it('ok only when BOTH async flag states are green', async () => {
    await expect(selfEvalParityAsync(async () => true)).resolves.toMatchObject({ ok: true });
  });

  it('awaits async failures instead of treating promises as truthy passes', async () => {
    const v = await selfEvalParityAsync(async (flagOn) => {
      await new Promise((resolveDone) => setTimeout(resolveDone, 1));
      return !flagOn;
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/flag ON/);
  });

  it('fail-closed when the async runner rejects', async () => {
    const v = await selfEvalParityAsync(async (flagOn) => {
      if (!flagOn) return true;
      throw new Error('boom');
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/flag ON/);
  });
});

describe('M54 — isSelfTargetProposal', () => {
  it('true for the ashlr-hub repo (cwd → package name @ashlr/hub)', () => {
    expect(isSelfTargetProposal({ repo: process.cwd() } as Proposal)).toBe(true);
  });
  it('false for a non-ashlr repo / missing package.json', () => {
    expect(isSelfTargetProposal({ repo: '/tmp/definitely-not-a-repo-xyz' } as Proposal)).toBe(false);
    expect(isSelfTargetProposal({ repo: null } as unknown as Proposal)).toBe(false);
  });
});

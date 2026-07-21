/**
 * M441: judge-free evidence cannot be manufactured by weakening an enrolled
 * foreign repository's ordinary tests. The guard remains additive: new tests
 * and new assertions do not require judge review by themselves.
 */

import { describe, expect, it } from 'vitest';
import {
  guardSafetyTests,
  isOrdinaryTestFile,
} from '../src/core/fleet/self.js';
import { evaluateEvidenceAutoMergePreflight } from '../src/core/inbox/merge.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

function evidenceConfig(): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [],
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        allowWithoutVerification: false,
        managerGate: false,
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
        trustBasis: 'evidence',
      },
    },
  } as unknown as AshlrConfig;
}

function evidenceProposal(id: string, diff: string): Proposal {
  const diffHash = hashDiff(diff);
  return {
    id,
    repo: '/tmp/enrolled-foreign-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'foreign repo test change',
    summary: 'exercise ordinary test integrity preflight',
    diff,
    diffHash,
    provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
    engineModel: 'local:qwen3-coder',
    engineTier: 'local',
    status: 'pending',
    createdAt: '2026-07-21T00:00:00.000Z',
  } as Proposal;
}

function preflight(diff: string) {
  return evaluateEvidenceAutoMergePreflight(
    evidenceProposal('m441', diff),
    evidenceConfig(),
    { remoteAvailable: true, requireVerificationEvidence: false },
  );
}

describe('M441 ordinary test integrity', () => {
  it('recognizes ordinary tests across common repository layouts and languages', () => {
    for (const path of [
      'tests/payment.test.ts',
      'src/payment.spec.jsx',
      'test/test_payment.py',
      'payment_test.go',
      'spec/payment_spec.rb',
      'crates/billing/tests/refund.rs',
    ]) {
      expect(isOrdinaryTestFile(path), path).toBe(true);
    }
    expect(isOrdinaryTestFile('src/payment.ts')).toBe(false);
  });

  it('refuses deletion of an ordinary foreign-repo test in evidence preflight', () => {
    const diff = [
      'diff --git a/tests/payment.test.ts b/tests/payment.test.ts',
      'deleted file mode 100644',
      '--- a/tests/payment.test.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      "-test('charges the card', () => {",
      '-  expect(charge()).toBe(200);',
      '-});',
      '',
    ].join('\n');

    const verdict = preflight(diff);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/test-weakening.*deletes test file/);
  });

  it('refuses assertion trivialization in an ordinary foreign-repo test', () => {
    const diff = [
      'diff --git a/tests/payment.test.ts b/tests/payment.test.ts',
      '--- a/tests/payment.test.ts',
      '+++ b/tests/payment.test.ts',
      '@@ -3 +3 @@',
      '-expect(chargeCard()).toEqual({ status: 200 });',
      '+expect(true).toBe(true);',
      '',
    ].join('\n');

    const verdict = preflight(diff);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/test-weakening.*removes 1 assertion/);
  });

  it('refuses cross-language assertion removal and newly skipped tests', () => {
    const pythonDiff = [
      'diff --git a/test/test_payment.py b/test/test_payment.py',
      '--- a/test/test_payment.py',
      '+++ b/test/test_payment.py',
      '@@ -2 +2 @@',
      '-    assert charge_card() == 200',
      '+    pass',
      '',
    ].join('\n');
    const goSkipDiff = [
      'diff --git a/payment_test.go b/payment_test.go',
      '--- a/payment_test.go',
      '+++ b/payment_test.go',
      '@@ -2,0 +3 @@',
      '+    t.Skip("flaky")',
      '',
    ].join('\n');

    expect(guardSafetyTests(pythonDiff).weakened).toBe(true);
    expect(guardSafetyTests(goSkipDiff).weakened).toBe(true);
  });

  it('refuses renaming a test out of protected test paths', () => {
    const diff = [
      'diff --git a/tests/payment.ts b/archive/payment.ts',
      'similarity index 100%',
      'rename from tests/payment.ts',
      'rename to archive/payment.ts',
      '',
    ].join('\n');

    const verdict = preflight(diff);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/test-weakening.*renames test file/);
  });

  it('does not allow Git-quoted test paths to bypass deletion protection', () => {
    const diff = [
      'diff --git "a/tests/payment plan.test.ts" "b/tests/payment plan.test.ts"',
      'deleted file mode 100644',
      '--- "a/tests/payment plan.test.ts"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-expect(paymentPlan()).toBeDefined();',
      '',
    ].join('\n');

    const verdict = preflight(diff);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/test-weakening.*deletes test file/);
  });

  it('keeps new tests and assertion-only additions eligible for evidence verification', () => {
    const newTest = [
      'diff --git a/tests/refund.test.ts b/tests/refund.test.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/tests/refund.test.ts',
      '@@ -0,0 +1,3 @@',
      "+test('refunds the charge', () => {",
      '+  expect(refund()).toBe(true);',
      '+});',
      '',
    ].join('\n');
    const addedAssertion = [
      'diff --git a/tests/payment.test.ts b/tests/payment.test.ts',
      '--- a/tests/payment.test.ts',
      '+++ b/tests/payment.test.ts',
      '@@ -4,0 +5 @@',
      '+expect(receipt.id).toBeDefined();',
      '',
    ].join('\n');

    expect(preflight(newTest)).toMatchObject({ authorized: true });
    expect(preflight(addedAssertion)).toMatchObject({ authorized: true });
  });
});

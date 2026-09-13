// Proposed whole-file partition only. This does not change default Vitest
// coverage, gate commands, budgets, or release receipt authority.
export const RELEASE_NATIVE_CANDIDATES = Object.freeze([
  'test/preparation-batch-candidate-acceptance.test.ts',
  'test/preparation-qualified-workload-acceptance.test.ts',
  'test/preparation-verification-successor-drift.test.ts',
  'test/preparation-verification-workflow.test.ts',
  'test/resource-engineering-mission-acceptance.test.ts',
  'test/resource-engineering-mission-product-value-acceptance.test.ts',
  'test/resource-engineering-setup-acceptance.test.ts',
  'test/universe-builtin-preparation-evaluator.test.ts',
  'test/universe-preparation-verification.test.ts',
].map((file) => Object.freeze({ project: 'real-io', file })));

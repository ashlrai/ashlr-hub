/**
 * M54 — the self-target gate inside verifyProposal.
 *
 * Hermetic: a self-target proposal whose diff deletes a safety test is REFUSED by
 * the guard BEFORE any verify worktree is created or any command runs, so this
 * test spawns nothing. Proves self-improvement can never self-disarm through the
 * merge gate.
 */

import { describe, it, expect } from 'vitest';
import { verifyProposal } from '../src/core/inbox/merge.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

const deleteSafetyTestDiff = `diff --git a/test/h1.audit.test.ts b/test/h1.audit.test.ts
deleted file mode 100644
--- a/test/h1.audit.test.ts
+++ /dev/null
@@ -1,4 +0,0 @@
-import { it, expect } from 'vitest';
-it('the real ~/.ashlr is never touched', () => {
-  expect(true).toBe(true);
-});
`;

describe('M54 — verifyProposal self-target gate', () => {
  it('REFUSES a self-target proposal whose diff deletes a safety test (before any verify runs)', async () => {
    // repo = this repo (package name @ashlr/hub) ⇒ isSelfTargetProposal is true.
    const proposal = {
      id: 'p-self-del',
      repo: process.cwd(),
      kind: 'patch',
      diff: deleteSafetyTestDiff,
      engineTier: 'frontier',
      engineModel: 'claude:opus-4.8',
    } as unknown as Proposal;

    const res = await verifyProposal(proposal, makeConfig());
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/self-target guard/);
    expect(res.detail).toMatch(/h1\.audit/);
    // The guard runs FIRST: nothing was executed.
    expect(res.ran).toEqual([]);
  });
});

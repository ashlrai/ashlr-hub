/**
 * M54 — the self-target gate inside verifyProposal.
 *
 * Hermetic: a self-target proposal whose diff deletes a safety test is REFUSED by
 * the guard BEFORE any verify worktree is created or any command runs, so this
 * test runs no verification commands. Private fixtures initialize Git only.
 * Proves self-improvement can never self-disarm through the
 * merge gate.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it.each(['@ashlr/hub', '@ashlr/phantom'])('applies the safety guard to %s before verification', async (name) => {
    const repo = mkdtempSync(join(tmpdir(), 'ashlr-m54-self-gate-'));
    try {
      // Git is fixture setup only. No HEAD exists, so the exact guard reason
      // also proves rejection precedes base resolution/worktree creation.
      execFileSync('git', ['init', '--quiet', repo]);
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name }));
      const proposal = { id: 'p-self-closed-name', repo, kind: 'patch', diff: deleteSafetyTestDiff,
        engineTier: 'frontier', engineModel: 'claude:opus-4.8' } as unknown as Proposal;
      const res = await verifyProposal(proposal, makeConfig());
      expect(res.ok).toBe(false);
      expect(res.detail).toMatch(/self-target guard/);
      expect(res.detail).toMatch(/h1\.audit/);
      expect(res.ran).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
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

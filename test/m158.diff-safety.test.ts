/**
 * M158 — destructive-diff guard: isDestructiveDiff + intake auto-rejection.
 *
 * Verifies:
 *  1. isDestructiveDiff flags: ≥3 deps removed from package.json, wholesale
 *     file gutting (>60% removed), duplicate JSON keys, deleting package.json.
 *  2. isDestructiveDiff does NOT flag: 1-line version bump, normal small edit,
 *     additive change, legitimate file rename (add+remove same count).
 *  3. createProposal auto-rejects destructive proposals (status='rejected',
 *     decisionReason set, decisions-ledger entry recorded).
 *  4. Flag-off (diffSafety=false) → no auto-rejection.
 *  5. Never-throws on malformed / empty / null / undefined diffs.
 *
 * Hermetic: mocks inbox FS + decisions-ledger + audit (mirrors m124/m133).
 * All vi.mock() calls at module top level so vitest hoists them correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// ── Module mocks (mirrors m124/m133 conventions) ───────────────────────────
// ============================================================================

// Capture audit calls for assertions
const auditCalls: Array<{ action: string; summary: string }> = [];
vi.mock('../src/core/sandbox/audit.js', () => ({
  audit: (record: { action: string; summary: string }) => { auditCalls.push(record); },
}));

// Stub FS — proposals write to a tmp in-memory map
const storedProposals = new Map<string, string>();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string) => {
      if (String(p).includes('.ashlr/inbox')) return true;
      return actual.existsSync(p);
    },
    mkdirSync: (..._args: unknown[]) => undefined,
    writeFileSync: (p: string, data: string) => { storedProposals.set(String(p), String(data)); },
    renameSync: (tmp: string, dest: string) => {
      const d = storedProposals.get(String(tmp));
      if (d !== undefined) {
        storedProposals.set(String(dest), d);
        storedProposals.delete(String(tmp));
      }
    },
    readFileSync: (p: string, enc?: string) => {
      const d = storedProposals.get(String(p));
      if (d !== undefined) return d;
      return actual.readFileSync(p, enc as BufferEncoding);
    },
  };
});

// Capture decisions-ledger calls
const ledgerEntries: Array<{ action: string; proposalId: string; reason?: string }> = [];
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  recordDecision: (entry: { action: string; proposalId: string; reason?: string }) => {
    ledgerEntries.push(entry);
  },
  readDecisions: () => [],
}));

// Stub judge-trace (additive, no-op)
vi.mock('../src/core/fleet/judge-trace.js', () => ({
  linkOutcome: vi.fn(),
}));

// Stub pulse-sync (fire-and-forget telemetry, not relevant to this test)
vi.mock('../src/core/integrations/pulse-sync.js', () => ({
  emitFleetEvent: () => Promise.resolve(),
  pulseSyncEnabled: () => false,
}));

// Stub sandbox policy
vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: vi.fn(),
  killSwitchOn: () => false,
  setKill: vi.fn(),
  listEnrolled: () => [],
  isEnrolled: vi.fn(() => false),
}));

// ============================================================================
// ── Late imports (AFTER vi.mock declarations) ─────────────────────────────────
// ============================================================================

import { isDestructiveDiff } from '../src/core/run/diff-safety.js';
import { createProposal } from '../src/core/inbox/store.js';
import type { Proposal } from '../src/core/types.js';

// ============================================================================
// ── Test helpers ──────────────────────────────────────────────────────────────
// ============================================================================

/** Build the minimal createProposal input (no id/status/createdAt). */
function makeProposalInput(
  overrides: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>>,
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  return {
    origin: 'swarm',
    kind: 'patch',
    title: overrides.title ?? 'test proposal',
    summary: overrides.summary ?? 'test summary',
    repo: '/tmp/test-repo',
    diff: overrides.diff,
    ...overrides,
  } as Omit<Proposal, 'id' | 'status' | 'createdAt'>;
}

// ── Diff fixtures ────────────────────────────────────────────────────────────

/** A diff that removes 3 dependency keys from package.json. */
const DEP_DESTRUCTION_DIFF = `--- a/package.json
+++ b/package.json
@@ -1,10 +1,4 @@
 {
   "name": "my-app",
-  "dependencies": {
-    "react": "^18.0.0",
-    "react-dom": "^18.0.0",
-    "typescript": "^5.0.0"
-  }
+  "dependencies": {}
 }
`;

/** A diff that removes a whole dependencies block. */
const WHOLE_DEPS_BLOCK_REMOVED_DIFF = `--- a/package.json
+++ b/package.json
@@ -1,15 +1,5 @@
 {
   "name": "my-app",
   "version": "1.0.0",
-  "dependencies": {
-    "react": "^18.0.0",
-    "react-dom": "^18.0.0",
-    "typescript": "^5.0.0",
-    "@tauri-apps/api": "^1.0.0",
-    "vite": "^4.0.0"
-  },
-  "devDependencies": {
-    "vitest": "^0.34.0",
-    "eslint": "^8.0.0"
-  }
 }
`;

/** A diff that removes >60% of a file with no comparable additions. */
function makeWholesaleReplacementDiff(removedLineCount: number): string {
  const removedLines = Array.from({ length: removedLineCount }, (_, i) => `-line${i}`).join('\n');
  return `--- a/src/big-file.ts
+++ b/src/big-file.ts
@@ -1,${removedLineCount} +1,1 @@
${removedLines}
+// gutted
`;
}

/** A diff that introduces a duplicate key in a JSON file. */
const DUPLICATE_JSON_KEY_DIFF = `--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,5 +1,7 @@
 {
+  "compilerOptions": { "strict": true },
+  "compilerOptions": { "target": "ES2020" },
   "include": ["src"]
 }
`;

/** A diff that deletes package.json entirely (all removed, nothing added). */
const DELETE_PACKAGE_JSON_DIFF = `--- a/package.json
+++ b/package.json
@@ -1,8 +0,0 @@
-{
-  "name": "my-app",
-  "version": "1.0.0",
-  "dependencies": {
-    "react": "^18.0.0"
-  }
-}
`;

/** A normal 1-line version bump. */
const VERSION_BUMP_DIFF = `--- a/package.json
+++ b/package.json
@@ -1,5 +1,5 @@
 {
   "name": "my-app",
-  "version": "1.0.0",
+  "version": "1.0.1",
   "dependencies": {}
 }
`;

/** A normal small edit (3 lines changed in a TS file). */
const SMALL_EDIT_DIFF = `--- a/src/util.ts
+++ b/src/util.ts
@@ -10,7 +10,7 @@
 function greet(name: string): string {
-  return "hello " + name;
+  return \`hello \${name}\`;
 }
`;

/** A purely additive change (new file, only additions). */
const ADDITIVE_DIFF = `--- /dev/null
+++ b/src/new-feature.ts
@@ -0,0 +1,5 @@
+export function newFeature(): void {
+  console.log('new feature');
+}
`;

/** A file rename: old file deleted, new file added (same net content, not destruction). */
const FILE_RENAME_DIFF = `--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,5 +1,5 @@
-export function oldName(): void {
-  return;
-}
+export function newName(): void {
+  return;
+}
`;

// ============================================================================
// Suite 1: isDestructiveDiff — detects destructive patterns
// ============================================================================

describe('M158 — isDestructiveDiff: detects destructive patterns', () => {
  it('flags a diff removing 3+ deps from package.json', () => {
    const result = isDestructiveDiff(DEP_DESTRUCTION_DIFF);
    expect(result.destructive).toBe(true);
    expect(result.reason).toMatch(/dep destruction/i);
  });

  it('flags a diff removing the whole dependencies block from package.json', () => {
    const result = isDestructiveDiff(WHOLE_DEPS_BLOCK_REMOVED_DIFF);
    expect(result.destructive).toBe(true);
    expect(result.reason).toMatch(/dep destruction/i);
  });

  it('flags wholesale file gutting (>60% lines removed, no comparable additions)', () => {
    const result = isDestructiveDiff(makeWholesaleReplacementDiff(50));
    expect(result.destructive).toBe(true);
    expect(result.reason).toMatch(/wholesale|gutting/i);
  });

  it('flags duplicate JSON keys introduced in a .json diff', () => {
    const result = isDestructiveDiff(DUPLICATE_JSON_KEY_DIFF);
    expect(result.destructive).toBe(true);
    expect(result.reason).toMatch(/duplicate key|key collision/i);
  });

  it('flags deletion of package.json entirely (all removed, nothing added)', () => {
    const result = isDestructiveDiff(DELETE_PACKAGE_JSON_DIFF);
    expect(result.destructive).toBe(true);
    // May be caught as dep-destruction (deps block present) or critical-file-deletion —
    // either is correct; what matters is that it's flagged destructive.
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it('flags deletion of package.json with no deps block (critical file deletion)', () => {
    // A package.json with no dependencies block — should fire critical-file-deletion rule.
    const deleteNoDeps = `--- a/package.json
+++ b/package.json
@@ -1,4 +0,0 @@
-{
-  "name": "my-app",
-  "version": "1.0.0"
-}
`;
    const result = isDestructiveDiff(deleteNoDeps);
    expect(result.destructive).toBe(true);
    expect(result.reason).toMatch(/critical file deletion/i);
  });

  it('returns a non-empty reason string for every flagged pattern', () => {
    const cases = [
      DEP_DESTRUCTION_DIFF,
      WHOLE_DEPS_BLOCK_REMOVED_DIFF,
      makeWholesaleReplacementDiff(50),
      DUPLICATE_JSON_KEY_DIFF,
      DELETE_PACKAGE_JSON_DIFF,
    ];
    for (const diff of cases) {
      const r = isDestructiveDiff(diff);
      expect(r.destructive).toBe(true);
      expect(typeof r.reason).toBe('string');
      expect(r.reason!.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Suite 2: isDestructiveDiff — does NOT flag safe changes (low false-positive)
// ============================================================================

describe('M158 — isDestructiveDiff: does NOT flag safe changes', () => {
  it('does NOT flag a 1-line version bump in package.json', () => {
    const result = isDestructiveDiff(VERSION_BUMP_DIFF);
    expect(result.destructive).toBe(false);
  });

  it('does NOT flag a normal small edit in a TS file', () => {
    const result = isDestructiveDiff(SMALL_EDIT_DIFF);
    expect(result.destructive).toBe(false);
  });

  it('does NOT flag a purely additive change (new file)', () => {
    const result = isDestructiveDiff(ADDITIVE_DIFF);
    expect(result.destructive).toBe(false);
  });

  it('does NOT flag a legitimate file rename (similar add/remove counts)', () => {
    const result = isDestructiveDiff(FILE_RENAME_DIFF);
    expect(result.destructive).toBe(false);
  });

  it('does NOT flag removal of only 2 deps (below threshold)', () => {
    const twoDepsRemoved = `--- a/package.json
+++ b/package.json
@@ -1,8 +1,5 @@
 {
   "name": "my-app",
-  "dependencies": {
-    "react": "^18.0.0",
-    "react-dom": "^18.0.0"
-  }
+  "dependencies": {}
 }
`;
    const result = isDestructiveDiff(twoDepsRemoved);
    expect(result.destructive).toBe(false);
  });

  it('does NOT flag removal of 19 lines when adds are 18 (normal refactor)', () => {
    // Below the minNetDeletionsForRatioCheck threshold AND add/remove balanced
    const lines19 = Array.from({ length: 19 }, (_, i) => `-old line ${i}`).join('\n');
    const adds18 = Array.from({ length: 18 }, (_, i) => `+new line ${i}`).join('\n');
    const diff = `--- a/src/refactor.ts\n+++ b/src/refactor.ts\n@@ -1,19 +1,18 @@\n${lines19}\n${adds18}\n`;
    const result = isDestructiveDiff(diff);
    expect(result.destructive).toBe(false);
  });
});

// ============================================================================
// Suite 3: isDestructiveDiff — never-throws on malformed/empty input
// ============================================================================

describe('M158 — isDestructiveDiff: never-throws on bad input', () => {
  it('returns { destructive: false } for empty string', () => {
    expect(() => isDestructiveDiff('')).not.toThrow();
    expect(isDestructiveDiff('').destructive).toBe(false);
  });

  it('returns { destructive: false } for null', () => {
    expect(() => isDestructiveDiff(null)).not.toThrow();
    expect(isDestructiveDiff(null).destructive).toBe(false);
  });

  it('returns { destructive: false } for undefined', () => {
    expect(() => isDestructiveDiff(undefined)).not.toThrow();
    expect(isDestructiveDiff(undefined).destructive).toBe(false);
  });

  it('returns { destructive: false } for garbage/non-diff string', () => {
    expect(() => isDestructiveDiff('not a diff at all !!@#$')).not.toThrow();
    expect(isDestructiveDiff('not a diff at all !!@#$').destructive).toBe(false);
  });

  it('returns { destructive: false } for a diff with no file headers', () => {
    const result = isDestructiveDiff('@@ -1,3 +1,3 @@\n-old\n+new\n context\n');
    expect(result.destructive).toBe(false);
  });
});

// ============================================================================
// Suite 4: createProposal — auto-rejects destructive proposals at intake
// ============================================================================

describe('M158 — createProposal: auto-rejects destructive diff at intake', () => {
  beforeEach(() => {
    storedProposals.clear();
    auditCalls.length = 0;
    ledgerEntries.length = 0;
  });

  it('sets status=rejected for a destructive diff (dep destruction)', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: DEP_DESTRUCTION_DIFF }),
    );
    expect(proposal.status).toBe('rejected');
    expect(proposal.decisionReason).toMatch(/destructive diff auto-rejected/i);
    expect(proposal.decisionReason).toMatch(/dep destruction/i);
  });

  it('sets decidedAt on auto-rejected proposals', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: DEP_DESTRUCTION_DIFF }),
    );
    expect(proposal.decidedAt).toBeDefined();
    expect(typeof proposal.decidedAt).toBe('string');
  });

  it('records a decisions-ledger entry for auto-rejected proposals', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: DEP_DESTRUCTION_DIFF }),
    );
    const entry = ledgerEntries.find((e) => e.proposalId === proposal.id);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe('rejected');
    expect(entry!.reason).toMatch(/destructive diff auto-rejected/i);
  });

  it('emits an audit entry with inbox:proposal-rejected action', () => {
    createProposal(makeProposalInput({ diff: DEP_DESTRUCTION_DIFF }));
    const auditEntry = auditCalls.find((c) => c.action === 'inbox:proposal-rejected');
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.summary).toMatch(/auto-rejected.*diff-safety/i);
  });

  it('sets status=pending for a clean (non-destructive) diff', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: VERSION_BUMP_DIFF }),
    );
    expect(proposal.status).toBe('pending');
    expect(proposal.decisionReason).toBeUndefined();
  });

  it('sets status=pending for a proposal with no diff', () => {
    const proposal = createProposal(makeProposalInput({ diff: undefined }));
    expect(proposal.status).toBe('pending');
  });

  it('sets status=pending when diffSafety=false even for a destructive diff', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: DEP_DESTRUCTION_DIFF }),
      { foundry: { diffSafety: false } },
    );
    expect(proposal.status).toBe('pending');
    expect(proposal.decisionReason).toBeUndefined();
  });

  it('auto-rejects wholesale file gutting at intake', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: makeWholesaleReplacementDiff(50) }),
    );
    expect(proposal.status).toBe('rejected');
    expect(proposal.decisionReason).toMatch(/destructive diff auto-rejected/i);
  });

  it('auto-rejects critical file deletion at intake', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: DELETE_PACKAGE_JSON_DIFF }),
    );
    expect(proposal.status).toBe('rejected');
    expect(proposal.decisionReason).toMatch(/destructive diff auto-rejected/i);
  });

  it('does NOT reject a legitimate clean patch (small edit)', () => {
    const proposal = createProposal(
      makeProposalInput({ diff: SMALL_EDIT_DIFF }),
    );
    expect(proposal.status).toBe('pending');
    const rejectedAudit = auditCalls.find((c) => c.action === 'inbox:proposal-rejected');
    expect(rejectedAudit).toBeUndefined();
  });
});

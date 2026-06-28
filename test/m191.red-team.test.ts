/**
 * m191.red-team.test.ts — M191: adversarial RED-TEAM critic (invented idea #5).
 *
 * The red-teamer's job is to BREAK a proposal: it runs an adversarial frontier
 * reviewer + cheap deterministic checks (injected-secret scan, destructive-diff
 * reuse, dependency-risk heuristics). A proposal 'survives' only if no
 * high-severity attack lands.
 *
 * Test groups:
 *   1. ADVERSARIAL PROMPT — system prompt is hostile; frontier sees diff/title/summary
 *   2. DETERMINISTIC CHECKS — injected secret / destructive / dep-risk → 'broken'
 *   3. CLEAN DIFF SURVIVES — benign additive change → 'survived'
 *   4. VERDICT LOGIC — any high-severity attack ⇒ broke; medium/low alone ⇒ survived
 *   5. NEVER-THROWS — neutral 'survived' on client/import/parse failure
 *   6. SECRET SCRUBBING — no raw secret reaches the frontier prompt
 *   7. BOUNDED — diff truncated before the frontier sees it
 *
 * Hermetic: HOME in tmp dir. LLM mocked. No live Opus calls.
 * Mirrors m183/m158 conventions: vi.doMock + vi.resetModules() + UUID cache-busting.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m191-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_REPO = '/tmp/fake-repo-m191';

function makeProposal(overrides: Partial<{
  id: string;
  title: string;
  summary: string;
  diff: string;
  origin: 'agent' | 'backlog' | 'swarm' | 'manual';
  kind: 'patch' | 'pr' | 'note';
}> = {}) {
  return {
    id: overrides.id ?? `proposal-${randomUUID()}`,
    repo: MOCK_REPO,
    origin: overrides.origin ?? 'agent',
    kind: overrides.kind ?? 'patch',
    title: overrides.title ?? 'Add a small utility',
    summary: overrides.summary ?? 'Implements a helper function.',
    diff: overrides.diff ?? '--- a/src/util.ts\n+++ b/src/util.ts\n@@ -1,1 +1,2 @@\n+export const x = 1;',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as import('../src/core/types.js').Proposal;
}

function makeConfig(overrides: Partial<{ redTeam: boolean }> = {}): AshlrConfig {
  return {
    provider: 'anthropic',
    models: { ollama: 'http://127.0.0.1:9' },
    foundry: {
      allowedBackends: ['local-coder'],
      ...(overrides.redTeam != null ? { redTeam: overrides.redTeam } : {}),
    },
  } as unknown as AshlrConfig;
}

/** Build a mock adversarial frontier JSON response. */
function makeFrontierJson(
  attacks: Array<{ vector: string; finding: string; severity: string }>,
  verdict: string,
): string {
  return JSON.stringify({ attacks, verdict });
}

/** A clean, benign additive diff. */
const CLEAN_DIFF = `--- /dev/null
+++ b/src/new-feature.ts
@@ -0,0 +1,4 @@
+export function newFeature(): number {
+  return 42;
+}
`;

/** A diff with an injected API-key secret in an added line. */
const INJECTED_SECRET_DIFF = `--- a/src/config.ts
+++ b/src/config.ts
@@ -1,1 +1,2 @@
+const OPENAI_API_KEY = "sk-abcd1234efgh5678ijkl9012mnop3456";
`;

/** A diff that deletes the whole dependencies block (M158 destructive). */
const DESTRUCTIVE_DIFF = `--- a/package.json
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

/** A diff that introduces an rm -rf destructive command. */
const RM_RF_DIFF = `--- a/scripts/clean.sh
+++ b/scripts/clean.sh
@@ -1,1 +1,2 @@
+rm -rf /
`;

/** A diff that adds a git-sourced dependency (supply-chain risk). */
const GIT_DEP_DIFF = `--- a/package.json
+++ b/package.json
@@ -3,1 +3,2 @@
+    "evil-pkg": "git+https://github.com/attacker/evil-pkg.git"
`;

// ---------------------------------------------------------------------------
// 1. ADVERSARIAL PROMPT
// ---------------------------------------------------------------------------

describe('M191 — adversarial frontier prompt', () => {
  afterEach(() => { vi.resetModules(); });

  it('system prompt is hostile and names the attack classes', async () => {
    const capturedSystems: string[] = [];
    const mockComplete = vi.fn(async (sys: string) => {
      capturedSystems.push(sys);
      return makeFrontierJson([], 'survived');
    });

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    await redTeamProposal(makeProposal(), makeConfig());

    const sys = capturedSystems[0] ?? '';
    expect(sys).toMatch(/BREAK|hostile|adversarial/i);
    expect(sys).toMatch(/secret/i);
    expect(sys).toMatch(/destructive/i);
    expect(sys).toMatch(/dependency/i);
    expect(sys).toMatch(/correctness/i);
  });

  it('user prompt carries the diff + title + summary', async () => {
    const capturedUsers: string[] = [];
    const mockComplete = vi.fn(async (_sys: string, user: string) => {
      capturedUsers.push(user);
      return makeFrontierJson([], 'survived');
    });

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const proposal = makeProposal({
      title: 'My special change',
      summary: 'Does something notable',
      diff: '--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n+const SPECIAL_MARKER = true;',
    });
    await redTeamProposal(proposal, makeConfig());

    expect(capturedUsers.length).toBe(1);
    expect(capturedUsers[0]).toContain('My special change');
    expect(capturedUsers[0]).toContain('Does something notable');
    expect(capturedUsers[0]).toContain('SPECIAL_MARKER');
  });

  it('frontier high-severity attack alone breaks the proposal', async () => {
    const mockComplete = vi.fn(async () => makeFrontierJson(
      [{ vector: 'auth-bypass', finding: 'Removes the auth check on the admin route.', severity: 'high' }],
      'broken',
    ));

    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    // CLEAN diff so deterministic checks do NOT fire — only the frontier breaks it.
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());

    expect(result.broke).toBe(true);
    expect(result.verdict).toBe('broken');
    expect(result.attacks.some((a) => a.vector.includes('auth-bypass'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. DETERMINISTIC CHECKS — break on secret / destructive / dep-risk
// ---------------------------------------------------------------------------

describe('M191 — deterministic checks break the proposal', () => {
  afterEach(() => { vi.resetModules(); });

  // Frontier returns "survived" so we isolate the deterministic verdict.
  function mockSurvivingFrontier() {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({
        complete: vi.fn(async () => makeFrontierJson([], 'survived')),
        model: 'mock-opus',
      })),
      judgeProposal: vi.fn(),
    }));
  }

  it("breaks on an injected secret even when the frontier says 'survived'", async () => {
    mockSurvivingFrontier();
    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: INJECTED_SECRET_DIFF }), makeConfig());

    expect(result.broke).toBe(true);
    expect(result.verdict).toBe('broken');
    const secretAttack = result.attacks.find((a) => a.vector === 'injected-secret');
    expect(secretAttack).toBeDefined();
    expect(secretAttack!.severity).toBe('high');
  });

  it('breaks on a destructive diff (M158 dep-block removal)', async () => {
    mockSurvivingFrontier();
    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: DESTRUCTIVE_DIFF }), makeConfig());

    expect(result.broke).toBe(true);
    expect(result.attacks.find((a) => a.vector === 'destructive-diff')).toBeDefined();
  });

  it('breaks on an rm -rf destructive command in added lines', async () => {
    mockSurvivingFrontier();
    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: RM_RF_DIFF }), makeConfig());

    expect(result.broke).toBe(true);
    const cmdAttack = result.attacks.find((a) => a.vector === 'destructive-command');
    expect(cmdAttack).toBeDefined();
    expect(cmdAttack!.severity).toBe('high');
  });

  it('flags a git-sourced dependency as a dependency-risk (medium, not breaking alone)', async () => {
    mockSurvivingFrontier();
    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: GIT_DEP_DIFF }), makeConfig());

    const depAttack = result.attacks.find((a) => a.vector === 'dependency-risk');
    expect(depAttack).toBeDefined();
    expect(depAttack!.severity).toBe('medium');
    // Medium alone does not break.
    expect(result.broke).toBe(false);
    expect(result.verdict).toBe('survived');
  });
});

// ---------------------------------------------------------------------------
// 3. CLEAN DIFF SURVIVES
// ---------------------------------------------------------------------------

describe('M191 — clean diff survives', () => {
  afterEach(() => { vi.resetModules(); });

  it("returns 'survived' on a benign additive change with no frontier attacks", async () => {
    const mockComplete = vi.fn(async () => makeFrontierJson([], 'survived'));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());

    expect(result.broke).toBe(false);
    expect(result.verdict).toBe('survived');
    expect(result.attacks.length).toBe(0);
    expect(typeof result.detail).toBe('string');
  });

  it('runs deterministic checks even when no frontier client is configured', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => null),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    // No frontier, but an injected secret → deterministic check still breaks it.
    const result = await redTeamProposal(makeProposal({ diff: INJECTED_SECRET_DIFF }), makeConfig());

    expect(result.broke).toBe(true);
    expect(result.attacks.find((a) => a.vector === 'injected-secret')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. VERDICT LOGIC — high breaks; medium/low alone survives
// ---------------------------------------------------------------------------

describe('M191 — verdict logic', () => {
  afterEach(() => { vi.resetModules(); });

  it('medium/low frontier attacks alone do NOT break (survived)', async () => {
    const mockComplete = vi.fn(async () => makeFrontierJson(
      [
        { vector: 'style', finding: 'Variable naming is inconsistent.', severity: 'low' },
        { vector: 'maybe-perf', finding: 'Possible minor allocation in a loop.', severity: 'medium' },
      ],
      'survived',
    ));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());

    expect(result.broke).toBe(false);
    expect(result.verdict).toBe('survived');
    // The findings are still surfaced.
    expect(result.attacks.length).toBe(2);
  });

  it('a single high-severity attack among lower ones breaks it', async () => {
    const mockComplete = vi.fn(async () => makeFrontierJson(
      [
        { vector: 'style', finding: 'naming', severity: 'low' },
        { vector: 'sql-injection', finding: 'User input concatenated into SQL.', severity: 'high' },
      ],
      'broken',
    ));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());

    expect(result.broke).toBe(true);
    expect(result.verdict).toBe('broken');
  });

  it('combines deterministic + frontier attacks into the attack list', async () => {
    const mockComplete = vi.fn(async () => makeFrontierJson(
      [{ vector: 'logic-bug', finding: 'Off-by-one in the loop bound.', severity: 'medium' }],
      'survived',
    ));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    // Injected secret (deterministic high) + frontier medium.
    const result = await redTeamProposal(makeProposal({ diff: INJECTED_SECRET_DIFF }), makeConfig());

    expect(result.attacks.find((a) => a.vector === 'injected-secret')).toBeDefined();
    expect(result.attacks.find((a) => a.vector.includes('logic-bug'))).toBeDefined();
    expect(result.broke).toBe(true); // the deterministic secret is high
  });
});

// ---------------------------------------------------------------------------
// 5. NEVER-THROWS — neutral 'survived' on failure (can't false-block)
// ---------------------------------------------------------------------------

describe('M191 — never-throws, neutral survived on failure', () => {
  afterEach(() => { vi.resetModules(); });

  it("survives (neutral) when no frontier client and a clean diff", async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => null),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());

    expect(result.broke).toBe(false);
    expect(result.verdict).toBe('survived');
  });

  it('survives (neutral) when the manager.js import throws', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => {
      throw new Error('module unavailable');
    });

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    let result: Awaited<ReturnType<typeof redTeamProposal>> | undefined;
    await expect((async () => {
      result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());
    })()).resolves.not.toThrow();

    expect(result!.verdict).toBe('survived');
    expect(result!.broke).toBe(false);
  });

  it('survives (neutral) when the frontier complete() throws — but deterministic still runs', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({
        complete: vi.fn(async () => { throw new Error('network failure'); }),
        model: 'mock-opus',
      })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    // Frontier explodes, but the clean diff means no deterministic break → survived.
    const cleanResult = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());
    expect(cleanResult.verdict).toBe('survived');

    // Frontier explodes, but the injected secret means deterministic still breaks it.
    const secretResult = await redTeamProposal(makeProposal({ diff: INJECTED_SECRET_DIFF }), makeConfig());
    expect(secretResult.broke).toBe(true);
    expect(secretResult.attacks.find((a) => a.vector === 'injected-secret')).toBeDefined();
  });

  it('survives (neutral) on malformed frontier JSON (clean diff)', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({
        complete: vi.fn(async () => 'this is not { valid json !!!'),
        model: 'mock-opus',
      })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());

    expect(result.verdict).toBe('survived');
    expect(result.broke).toBe(false);
  });

  it('survives (neutral) when the diff is undefined / empty', async () => {
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => null),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const noDiff = await redTeamProposal(makeProposal({ diff: undefined as unknown as string }), makeConfig());
    expect(noDiff.verdict).toBe('survived');
    const emptyDiff = await redTeamProposal(makeProposal({ diff: '' }), makeConfig());
    expect(emptyDiff.verdict).toBe('survived');
  });
});

// ---------------------------------------------------------------------------
// 6. SECRET SCRUBBING
// ---------------------------------------------------------------------------

describe('M191 — secrets scrubbed from the frontier prompt', () => {
  afterEach(() => { vi.resetModules(); });

  it('does not send raw secret values to the frontier', async () => {
    const capturedUsers: string[] = [];
    const mockComplete = vi.fn(async (_sys: string, user: string) => {
      capturedUsers.push(user);
      return makeFrontierJson([], 'survived');
    });
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const proposal = makeProposal({
      diff: '+const OPENAI_API_KEY = "sk-abcd1234efgh5678ijkl9012mnop3456";\n+password=supersecret123456789',
      summary: 'token: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.something.long_token_here_abc123xyz',
    });
    await redTeamProposal(proposal, makeConfig());

    const prompt = capturedUsers[0] ?? '';
    expect(prompt).not.toContain('sk-abcd1234efgh5678ijkl9012mnop3456');
    expect(prompt).not.toContain('supersecret123456789');
    expect(prompt).toContain('[REDACTED]');
  });

  it('scrubs secrets out of the returned attack findings + detail', async () => {
    const mockComplete = vi.fn(async () => makeFrontierJson(
      [{ vector: 'leak', finding: 'Found key sk-abcd1234efgh5678ijkl9012mnop3456 in the code.', severity: 'high' }],
      'broken',
    ));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig());

    const finding = result.attacks.map((a) => a.finding).join(' ');
    expect(finding).not.toContain('sk-abcd1234efgh5678ijkl9012mnop3456');
    expect(result.detail).not.toContain('sk-abcd1234efgh5678ijkl9012mnop3456');
  });
});

// ---------------------------------------------------------------------------
// 7. BOUNDED — diff truncated before the frontier sees it
// ---------------------------------------------------------------------------

describe('M191 — bounded diff', () => {
  afterEach(() => { vi.resetModules(); });

  it('truncates the diff to the configured maxDiffChars in the prompt', async () => {
    const capturedUsers: string[] = [];
    const mockComplete = vi.fn(async (_sys: string, user: string) => {
      capturedUsers.push(user);
      return makeFrontierJson([], 'survived');
    });
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const longDiff = '+' + 'a'.repeat(10000);
    await redTeamProposal(makeProposal({ diff: longDiff }), makeConfig(), { maxDiffChars: 500 });

    const prompt = capturedUsers[0] ?? '';
    const aCount = (prompt.match(/a/g) ?? []).length;
    expect(aCount).toBeLessThanOrEqual(500);
  });

  it('caps the number of returned attacks at maxAttacks', async () => {
    const manyAttacks = Array.from({ length: 30 }, (_, i) => ({
      vector: `v${i}`,
      finding: `finding ${i}`,
      severity: 'low',
    }));
    const mockComplete = vi.fn(async () => makeFrontierJson(manyAttacks, 'survived'));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      resolveFrontierJudgeClient: vi.fn(() => ({ complete: mockComplete, model: 'mock-opus' })),
      judgeProposal: vi.fn(),
    }));

    const { redTeamProposal } = await import('../src/core/fleet/red-team.js?' + randomUUID());
    const result = await redTeamProposal(makeProposal({ diff: CLEAN_DIFF }), makeConfig(), { maxAttacks: 5 });

    expect(result.attacks.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 8. NO GATE WIRING — standalone module (build-only)
// ---------------------------------------------------------------------------

describe('M191 — standalone (no gate wiring)', () => {
  it('red-team.ts does not import or call the merge gate', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/fleet/red-team.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/^import.*automerge-pass/m);
    expect(src).not.toContain('autoMergeProposal');
    expect(src).not.toContain('mergeToMain');
  });

  it('red-team.ts imports diff-safety + scrub but does not edit them', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/fleet/red-team.ts'),
      'utf8',
    );
    expect(src).toContain("from '../run/diff-safety.js'");
    expect(src).toContain("from '../util/scrub.js'");
  });
});

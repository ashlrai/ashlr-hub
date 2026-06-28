/**
 * test/h4.proposal-only.test.ts — H4 INVARIANT 1: PROPOSAL-ONLY.
 *
 * Asserts EVERY guard in the PROPOSAL-ONLY invariant (CONTRACT-H4.md §Invariant 1,
 * guards 1.1–1.11): applyProposal is the ONLY outward path and gates on
 * exist/approved/confirmed/enrolled+kill/kind; the daemon + advance emit ONLY
 * PENDING proposals; the daemon imports NO outward primitive (STATIC grep-guard);
 * propose=false creates NO proposal.
 *
 * PRIORITY (previously UNTESTED): 1.6 (pr dispatch gated), 1.7 (deploy dispatch
 * gated), 1.9 ([STATIC] daemon imports no apply/push/createPr/deploy), 1.11
 * (propose=false negative).
 *
 * SAFETY (paramount — see CONTRACT-H4.md): isolated tmp HOME per test (H1
 * fixture), disposable repos only, real ~/.ashlr never touched, DETERMINISTIC.
 * NO live model: node:child_process is mocked so that the real `execFileSync`
 * (git, used by applyPatch) stays intact while `spawnSync` (used ONLY by the
 * github.ts createPr gate) is stubbed to FAIL — proving the `pr` dispatch is
 * gated without ANY network/gh call. The daemon/swarm propose paths are asserted
 * via the real tick(dryRun) (which creates ZERO proposals), the daemon
 * default-empty semantics, and the real captureSandboxAndCleanup source contract
 * (propose=false ⇒ no _createProposal). Every it() has real expect(); beforeEach
 * calls expect.hasAssertions().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// buildBacklog MOCKED so tick() has discoverable work regardless of which
// scanners are enabled (M160 made scanDeps/scanLint/scanHygiene DEFAULT-OFF).
// The proposal-only tests that call tick(dryRun) need at least one backlog item
// so the loop returns 'dry-run' (not 'no-backlog'). Tests that DO NOT call tick
// are unaffected — the mock value is only consumed when tick() is called.
// ---------------------------------------------------------------------------
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

// ---------------------------------------------------------------------------
// node:child_process mock — keep git (execFileSync) REAL, stub gh (spawnSync).
// vi.mock is hoisted; importOriginal preserves every other export so applyPatch's
// real git worktree/apply/commit path runs, while createPr's `gh pr create`
// spawnSync is forced to FAIL — no network, fully deterministic.
// ---------------------------------------------------------------------------

let _spawnSyncImpl: (...args: unknown[]) => unknown;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => _spawnSyncImpl(...args),
  };
});

/** A spawnSync result modeling `gh` unavailable / `gh pr create` failing. */
function spawnGhFail() {
  return {
    pid: 0,
    output: [],
    stdout: '',
    stderr: 'gh: command not found',
    status: 1,
    signal: null,
    error: undefined,
  };
}

// ---------------------------------------------------------------------------
// Lazy imports — AFTER the vi.mock hoist so the mocked spawnSync is in effect.
// ---------------------------------------------------------------------------

import {
  makeFixture,
  makeAddFileDiff,
  makeCfg,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import { readSource, importLines, stripComments, containsToken } from './helpers/h4-static.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import {
  createProposal,
  setStatus,
  loadProposal,
  pendingCount,
} from '../src/core/inbox/store.js';
import { tick } from '../src/core/daemon/loop.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { AuditEntry, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Per-test fixture lifecycle (explicit makeFixture/cleanup so the suite can read
// audit + branches after the call, all under one isolated tmp HOME).
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  // Default: any `gh` spawn fails — no real gh, no network.
  _spawnSyncImpl = () => spawnGhFail();
  mockBuildBacklog.mockReset();
  // M160: scanDeps/scanLint/scanHygiene are DEFAULT-OFF. Provide a dynamic mock
  // so tick() always has at least one backlog item (returns 'dry-run' not
  // 'no-backlog'). Items are keyed to the enrolled repo (opts.repos[0]).
  mockBuildBacklog.mockImplementation(async (opts?: { repos?: string[] }) => {
    const repoDir = (opts?.repos ?? [])[0] ?? '';
    const now = new Date().toISOString();
    return {
      generatedAt: now,
      repos: opts?.repos ?? [],
      items: Array.from({ length: 3 }, (_, i) => ({
        id: `${repoDir}:h4-item-${i}`,
        repo: repoDir,
        source: 'todo' as const,
        title: `1 marker in src/todo-${i}.ts:2`,
        detail: `File: src/todo-${i}.ts:2 — "implement f${i}".`,
        value: 3,
        effort: 2,
        score: 1.5,
        tags: ['todo'],
        ts: now,
      })),
    };
  });
});

afterEach(() => {
  fx.cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Build a minimal proposal-input of a given kind for a repo. */
function makeInput(
  repo: string | null,
  overrides?: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>>,
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  return {
    repo,
    origin: 'manual',
    kind: 'patch',
    title: 'h4 proposal-only test',
    summary: 'a deterministic proposal for the proposal-only invariant',
    ...overrides,
  };
}

/** All audit entries (newest-first) whose action is inbox:apply. */
function applyAudits(): AuditEntry[] {
  return readAudit().filter((e) => e.action === 'inbox:apply');
}

/** The most-recent inbox:apply audit entry, or undefined. */
function latestApplyAudit(): AuditEntry | undefined {
  return applyAudits()[0]; // readAudit is newest-first
}

/** Branches in a repo that live in the inbox apply namespace. */
function proposalBranches(repo: DisposableRepo): string[] {
  return repo.branches().filter((b) => b.startsWith('ashlr/proposal/'));
}

// ===========================================================================
// INVARIANT 1 — applyProposal gates (1.1–1.8 + FINDING)
// ===========================================================================

describe('H4 · PROPOSAL-ONLY · applyProposal gates', () => {
  it('1.1 REFUSES when the proposal does not exist (loadProposal===null) — no branch, tree unchanged, audit refused', async () => {
    const repo = fx.makeRepo();
    const treeBefore = repo.shasumTree();

    const result = await applyProposal('prop-does-not-exist-xyz', { confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('not found');
    // Real tree byte-unchanged + no namespaced branch created anywhere.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
    // Audited as a refusal.
    const a = latestApplyAudit();
    expect(a).toBeDefined();
    expect(a?.result).toBe('refused');
    expect(a?.summary).toContain('not found');
  });

  it('1.2 REFUSES unless status==="approved" (pending/rejected never apply) — tree unchanged, audit refused', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const treeBefore = repo.shasumTree();
    const diff = makeAddFileDiff('apply-1-2.txt', 'should never land\n');

    // pending (the create-time default) must refuse.
    const p = createProposal(makeInput(repo.dir, { diff }));
    expect(p.status).toBe('pending');
    const pendingRes = await applyProposal(p.id, { confirmed: true });
    expect(pendingRes.ok).toBe(false);
    expect(pendingRes.detail).toContain("must be 'approved'");

    // rejected must refuse.
    setStatus(p.id, 'rejected');
    const rejectedRes = await applyProposal(p.id, { confirmed: true });
    expect(rejectedRes.ok).toBe(false);

    // Nothing landed: tree byte-identical, no namespaced branch.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
    // Every apply attempt audited as a refusal.
    expect(applyAudits().every((e) => e.result === 'refused')).toBe(true);
  });

  it('1.3 REFUSES unless opts.confirmed===true — approved+unconfirmed never applies, stays approved', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const treeBefore = repo.shasumTree();
    const diff = makeAddFileDiff('apply-1-3.txt', 'should never land\n');

    const p = createProposal(makeInput(repo.dir, { diff }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: false });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('approved'); // stays approved, retryable
    expect(result.detail).toContain('not confirmed');
    // Untouched + audited refused.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
    expect(latestApplyAudit()?.result).toBe('refused');
    // The proposal is NOT burned — still approved on disk for a real retry.
    expect(loadProposal(p.id)?.status).toBe('approved');
  });

  it('1.4 REFUSES (assertMayMutate) for an UNENROLLED repo before any mutating kind — no branch, tree unchanged, audit refused', async () => {
    const repo = fx.makeRepo();
    // Deliberately NOT enrolled.
    expect(repo.isEnrolled()).toBe(false);
    const treeBefore = repo.shasumTree();
    const diff = makeAddFileDiff('apply-1-4.txt', 'should never land\n');

    const p = createProposal(makeInput(repo.dir, { diff }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(false);
    // Policy refusal keeps the proposal approved (not burned to failed).
    expect(result.status).toBe('approved');
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
    const a = latestApplyAudit();
    expect(a?.result).toBe('refused');
    expect(a?.summary.toLowerCase()).toContain('policy');
  });

  it('1.4b REFUSES (assertMayMutate) when the kill switch is ON, even for an enrolled repo', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    fx.setKill(true);
    const treeBefore = repo.shasumTree();
    const diff = makeAddFileDiff('apply-1-4b.txt', 'should never land\n');

    const p = createProposal(makeInput(repo.dir, { diff }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('approved');
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
    expect(latestApplyAudit()?.result).toBe('refused');
  });

  it('1.5 patch kind lands on a NEW ashlr/proposal/<id> branch and NEVER the user branch', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const userBranch = repo.currentBranch();
    const treeBefore = repo.shasumTree();
    const diff = makeAddFileDiff('docs/landed.md', '# landed by apply\n');

    const p = createProposal(makeInput(repo.dir, { diff }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    // The patch lands ONLY on the namespaced branch.
    const expectedBranch = `ashlr/proposal/${p.id}`;
    expect(repo.branches()).toContain(expectedBranch);
    expect(result.detail).toContain(expectedBranch);
    // The user's branch is unchanged: still checked out, working tree untouched.
    expect(repo.currentBranch()).toBe(userBranch);
    expect(repo.shasumTree()).toBe(treeBefore); // user's working tree byte-identical
    expect(repo.gitStatus()).toBe(''); // clean — no stray index/worktree edits
    // No push happened (local-only is part of the detail contract).
    expect(result.detail).toContain('not pushed');
  });

  it('1.6 [UNTESTED] pr kind dispatch is GATED via createPr — returns ok:false WITHOUT opening a PR (no gh/network)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();

    // A `pr` proposal with NO diff: applyPr SKIPS applyPatch and goes straight to
    // the gated createPr — which spawns `gh pr create`. Our mocked spawnSync makes
    // that fail deterministically (no network), so the gate refuses cleanly and no
    // PR is ever opened.
    let prSpawnSeen = false;
    _spawnSyncImpl = (...args: unknown[]) => {
      const argv = args[1];
      if (Array.isArray(argv) && argv[0] === 'pr' && argv[1] === 'create') {
        prSpawnSeen = true;
      }
      return spawnGhFail();
    };

    const p = createProposal(makeInput(repo.dir, { kind: 'pr', title: 'h4 pr gate' }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });

    // The dispatch reached the gated createPr and it FAILED — never silently opened a PR.
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('gh pr create failed');
    expect(prSpawnSeen).toBe(true); // proves it went through the gated createPr path
    // Final audit reflects the failure (not a silent success).
    expect(latestApplyAudit()?.summary).toContain('failed');
  });

  it('1.6b [UNTESTED] pr kind WITH a diff lands the local patch branch but the PR is STILL gated (no auto-open)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const userBranch = repo.currentBranch();
    const treeBefore = repo.shasumTree();
    const diff = makeAddFileDiff('feature/x.ts', 'export const x = 1;\n');

    _spawnSyncImpl = () => spawnGhFail();

    const p = createProposal(makeInput(repo.dir, { kind: 'pr', diff, title: 'h4 pr+diff' }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });

    // The patch step legitimately created the namespaced branch...
    const expectedBranch = `ashlr/proposal/${p.id}`;
    expect(repo.branches()).toContain(expectedBranch);
    // ...but the PR creation is GATED and failed (no gh) ⇒ overall ok:false.
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('gh pr create failed');
    // The user's branch + working tree are untouched (patch landed on the branch only).
    expect(repo.currentBranch()).toBe(userBranch);
    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('1.7 [UNTESTED] deploy kind dispatch is GATED — refuses cleanly when the ship module is absent (NEVER deploys)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const treeBefore = repo.shasumTree();

    // core/ship.ts does not exist in this build, so the dynamic import resolves to
    // null and the deploy gate refuses without performing anything.
    const p = createProposal(makeInput(repo.dir, { kind: 'deploy', title: 'h4 deploy gate' }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('ship module');
    expect(result.detail).toContain('not yet available');
    // Nothing was deployed and nothing in the repo changed.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
  });

  it('1.8 note kind is a no-op record — applied without enrollment and NEVER mutates a repo', async () => {
    const repo = fx.makeRepo();
    // Note kind is exempt from the enrollment/kill gate (it never mutates), so we
    // leave the repo UNENROLLED to prove the gate is genuinely skipped for 'note'.
    expect(repo.isEnrolled()).toBe(false);
    const treeBefore = repo.shasumTree();

    const p = createProposal(makeInput(repo.dir, { kind: 'note', title: 'just a note' }));
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('applied');
    expect(result.detail).toContain('no-op');
    // No repo mutation whatsoever: tree byte-identical, no namespaced branch.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
    // Persisted as applied; audited ok (a recorded no-op, not a refusal).
    expect(loadProposal(p.id)?.status).toBe('applied');
    expect(latestApplyAudit()?.result).toBe('ok');
  });

  it('FINDING: there is NO "refund" kind — the union is patch|pr|deploy|note; the default: arm refuses an unknown kind', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const treeBefore = repo.shasumTree();

    // The ProposalKind union has no `refund`. Drive the exhaustiveness `default:`
    // arm by persisting a structurally-valid proposal whose kind is outside the
    // union (the store's type-guard only requires kind to be a string), then prove
    // the dispatch REFUSES it rather than acting on it.
    const p = createProposal(makeInput(repo.dir, { title: 'bogus kind' }));
    setStatus(p.id, 'approved');
    const onDisk = loadProposal(p.id);
    expect(onDisk).not.toBeNull();
    const tampered = { ...(onDisk as Proposal), kind: 'refund' as unknown as Proposal['kind'] };
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const dir = join(homedir(), '.ashlr', 'inbox');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(tampered, null, 2) + '\n', 'utf8');

    const result = await applyProposal(p.id, { confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('unknown proposal kind');
    expect(result.detail).toContain('refund');
    // No mutation occurred for the unknown kind.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(proposalBranches(repo)).toEqual([]);
  });
});

// ===========================================================================
// INVARIANT 1 — daemon/advance emit only PENDING (1.9–1.11)
// ===========================================================================

describe('H4 · PROPOSAL-ONLY · daemon/advance emit only PENDING', () => {
  it('1.9 [STATIC][UNTESTED] daemon/loop.ts imports NO apply/push/createPr/deploy primitive', () => {
    const src = readSource('core/daemon/loop.ts');
    const imports = importLines(src);

    // The ONLY inbox import allowed is the read-only store (pendingCount).
    expect(imports).toContain('../inbox/store.js');
    // No outward-primitive module is imported.
    const forbiddenImportFragments = [
      'inbox/apply', // the apply funnel
      'integrations/github', // createPr lives here
      '/ship', // deploy/ship module
    ];
    for (const frag of forbiddenImportFragments) {
      expect(
        imports.some((spec) => spec.includes(frag)),
        `daemon/loop.ts must not import a module containing "${frag}" — found: ${imports.join(', ')}`,
      ).toBe(false);
    }

    // And the comment-stripped source contains no outward CALL token.
    const stripped = stripComments(src);
    for (const token of ['applyProposal(', 'createPr(', 'deploy(', 'git push', 'gitPush(']) {
      expect(
        stripped.includes(token),
        `daemon/loop.ts must contain no "${token}" call token`,
      ).toBe(false);
    }
    // Sanity: the helper actually loaded the right file (it really uses runSwarm).
    expect(containsToken(src, 'runSwarm(')).toBe(true);
  });

  it('1.10 daemon tick (dry-run) creates ZERO proposals — it only PLANS, never applies/opens/deploys', async () => {
    const repo = fx.makeRepo({
      files: { 'README.md': '# repo\n', 'src/a.ts': '// TODO: x\nexport const a = 1;\n' },
    });
    repo.enroll();

    const before = pendingCount();
    const cfg = makeCfg();

    const rec = await tick(cfg, { dryRun: true });

    // Dry-run records the plan but creates NO proposals and spends nothing.
    expect(rec.proposalsCreated).toBe(0);
    expect(rec.spentUsd).toBe(0);
    expect(rec.reason).toBe('dry-run');
    // The inbox is byte-empty of new proposals.
    expect(pendingCount()).toBe(before);
  });

  it('1.10b daemon tick with NO enrolled repos does nothing (DEFAULT EMPTY) and creates no proposal', async () => {
    // No repo enrolled at all — the real-portfolio default-empty semantics.
    const before = pendingCount();
    const cfg = makeCfg();

    const rec = await tick(cfg, { dryRun: false });

    expect(rec.reason).toBe('no-enrolled-repos');
    expect(rec.proposalsCreated).toBe(0);
    expect(rec.spentUsd).toBe(0);
    expect(pendingCount()).toBe(before);
  });

  it('1.11 [UNTESTED] the swarm captureSandbox path with propose=false creates NO proposal (negative)', async () => {
    // The runner's captureSandboxAndCleanup records a PENDING proposal ONLY when
    // propose === true (and the inbox sink is bound). With propose=false it
    // records NOTHING. Assert this against the REAL source contract (the guard is
    // `if (propose && _createProposal !== null)` and captureSandboxAndCleanup
    // defaults propose to false) AND against the live store: a tick that never
    // reaches the live propose path leaves pendingCount intact.
    const src = readSource('core/swarm/runner.ts');
    const stripped = stripComments(src);

    // The propose guard is present and conjunctive (propose AND a bound sink).
    expect(stripped).toContain('if (propose && _createProposal !== null)');
    // captureSandboxAndCleanup defaults propose to false.
    expect(stripped).toMatch(/propose\s*=\s*false/);

    // Live store assertion: no proposal materialized across a dry-run tick (the
    // dry-run path never reaches a live propose, so pendingCount is unchanged).
    const repo = fx.makeRepo();
    repo.enroll();
    const before = pendingCount();
    await tick(makeCfg(), { dryRun: true });
    expect(pendingCount()).toBe(before);
  });
});

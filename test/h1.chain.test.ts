/**
 * test/h1.chain.test.ts — H1 BUILD task 1: FULL-CHAIN end-to-end (the keystone).
 *
 * Drives the REAL autonomous chain on a DISPOSABLE repo in an ISOLATED tmp HOME:
 *
 *   enroll -> tick(dryRun) [discovery/plan, no model]
 *           -> createSandbox + makeAddFileDiff -> createProposal('patch', PENDING)
 *           -> setStatus(approved) -> applyProposal(confirmed:true)
 *           -> patch lands on a NEW branch; the REAL working tree is byte-unchanged.
 *
 * DETERMINISM: the model-dependent half (live swarm engine subprocess) is NOT
 * exercised here. The discovery half runs the REAL tick in dryRun (proves
 * backlog -> selection wiring with NO model). The apply half runs the REAL
 * createSandbox / createProposal / applyProposal against a KNOWN unified diff
 * (as the swarm's propose path would produce), so the whole chain is real code
 * with zero live-LLM dependency.
 *
 * DISCOVERY PROVENANCE (what actually drives `itemsConsidered`): a real `tick`
 * calls the REAL `buildBacklog({ repos: enrolled })`, which ALWAYS re-runs the
 * SCANNERS over the enrolled repo's working tree and OVERWRITES backlog.json —
 * it does NOT read any seeded backlog.json. Two scanner sources contribute,
 * both local / no-network / no-model:
 *   - `scanTodos` (rg, else grep) emits one `source:'todo'` item per file that
 *     contains a TODO/FIXME/HACK/XXX marker. The repos here are seeded (via
 *     `todoSeedFiles`) with `// TODO:` source files so this path discovers a
 *     KNOWN count of TODO items — but ONLY when rg/grep is present (guarded).
 *   - `scanDocs` emits filesystem-only items (missing LICENSE / missing
 *     CONTRIBUTING / thin README / low-test-presence) for a minimal repo,
 *     independent of any TODO and of rg/grep — so discovery still yields >= 1
 *     item even on a CI image with NO grep/rg (the determinism floor).
 * The gh/npm scanners no-op on a local-only repo with no package.json (return []
 * and never throw). `seedBacklog` is NOT used by these tick tests — it would be
 * inert (the tick rebuilds via buildBacklog); a dedicated test below asserts the
 * TODO provenance directly against buildBacklog so the claim is genuine.
 *
 * Proves H1 invariants: REAL-TREE-UNCHANGED, PROPOSAL-ONLY, ENROLLMENT honored,
 * ISOLATED, DETERMINISTIC.
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  withTmpHome,
  makeAddFileDiff,
  makeCfg,
  todoSeedFiles,
  todoScannerAvailable,
  type DisposableRepo,
  type H1Fixture,
} from './helpers/h1-fixture.js';
import { tick } from '../src/core/daemon/loop.js';
import { buildBacklog } from '../src/core/portfolio/backlog.js';
import { createSandbox, removeSandbox } from '../src/core/sandbox/worktree.js';
import {
  createProposal,
  setStatus,
  loadProposal,
  listProposals,
  pendingCount,
} from '../src/core/inbox/store.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import { listEnrolled } from '../src/core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// Local git helper — read-only ref/tree inspection on a disposable repo.
// Mirrors the fixture's execFile-array, no-shell style. Read-only; never mutates.
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    timeout: 30_000,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

// ---------------------------------------------------------------------------
// Shared seed — a disposable repo whose source carries a TODO so the REAL
// TODO scanner (grep/rg, no model, no network) makes buildBacklog discover work.
// ---------------------------------------------------------------------------

// A disposable repo seeded with real `// TODO:` source files. `scanTodos`
// (rg/grep, no model, no network) emits one source:'todo' item per file during
// a live `buildBacklog`; `scanDocs` additionally emits filesystem items so
// discovery is non-empty even with NO rg/grep. We use 2 TODO files so the TODO
// path is observable but the suite never depends on a precise count.
const SEED_FILES = todoSeedFiles(2);

/** The new file a 'patch' proposal will add (must NOT pre-exist in the repo). */
const PATCH_REL = 'PROPOSED_BY_SWARM.md';
const PATCH_BODY =
  '# proposed by the swarm\n\nthis file was applied via the inbox apply path.\n';

/**
 * Build + enroll a disposable repo whose working tree carries the real
 * discovery signal (TODO source files via {@link todoSeedFiles}). The live tick
 * rebuilds the backlog via `buildBacklog` -> SCANNERS over this working tree, so
 * the seeded repo content — NOT any seeded backlog.json — is what drives what
 * the tick considers. (We deliberately do NOT call `seedBacklog` here: it would
 * be inert, since `buildBacklog` overwrites backlog.json on every tick.)
 */
function setupEnrolledRepo(fx: H1Fixture): DisposableRepo {
  const repo = fx.makeRepo({ files: SEED_FILES });
  repo.enroll();
  return repo;
}

/** Construct a deterministic PENDING 'patch' proposal carrying a known diff. */
function makePatchProposal(repoDir: string, sandboxId?: string) {
  return createProposal({
    repo: repoDir,
    origin: 'swarm',
    kind: 'patch',
    title: 'add proposed file',
    summary: 'swarm proposes adding PROPOSED_BY_SWARM.md',
    diff: makeAddFileDiff(PATCH_REL, PATCH_BODY),
    ...(sandboxId ? { sandboxId } : {}),
  });
}

describe('H1 full chain — enroll -> tick -> sandbox -> proposal -> approve -> apply', () => {
  it('buildBacklog over the ENROLLED repo discovers a real source:"todo" item from the seeded TODO files (REAL scanTodos provenance, guarded on rg/grep)', async () => {
    // GENUINE PROVENANCE: drive the REAL buildBacklog the tick uses and assert
    // the discovered items include the TODO-scanner source. This is the load-
    // bearing proof that the seeded `// TODO:` files are what scanTodos finds —
    // guarded on a TODO scanner being present so it stays deterministic in a CI
    // image with no rg/grep (where scanTodos returns [] and scanDocs alone
    // drives discovery; covered by the dryRun test below).
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);

      const backlog = await buildBacklog({ repos: [repo.dir], cfg: { foundry: { scanTodos: true } } });

      if (todoScannerAvailable()) {
        const todoItems = backlog.items.filter((i) => i.source === 'todo');
        // Two TODO-bearing files were seeded => two distinct source:'todo' items
        // (scanTodos emits one per file). Assert provenance + the known count.
        expect(todoItems.length).toBe(2);
        for (const it of todoItems) {
          expect(resolve(it.repo)).toBe(resolve(repo.dir));
        }
      } else {
        // No rg/grep on this host: scanTodos yields nothing, but discovery is
        // still non-empty via scanDocs (asserted on the next line) — proving the
        // determinism floor holds without a TODO scanner.
        expect(backlog.items.some((i) => i.source === 'todo')).toBe(false);
      }
      // Either way the REAL buildBacklog discovered work (>= the scanDocs floor).
      expect(backlog.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('tick(dryRun) over an ENROLLED disposable repo reports items considered and creates ZERO proposals (discovery/plan wiring, no model)', async () => {
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);
      expect(repo.isEnrolled()).toBe(true);
      expect(listEnrolled().map((r) => resolve(r))).toContain(resolve(repo.dir));

      const before = repo.shasumTree();
      const beforeBranch = repo.currentBranch();

      const result = await tick(makeCfg(), { dryRun: true });

      // Discovery/plan wiring ran through REAL daemon code with NO model. The
      // count comes from buildBacklog -> SCANNERS over the repo working tree
      // (scanTodos TODO items when rg/grep is present, PLUS scanDocs filesystem
      // items which alone guarantee >= 1 even with no TODO scanner) — NOT from
      // any seeded backlog.json.
      expect(result.reason).toBe('dry-run');
      expect(result.itemsConsidered).toBeGreaterThanOrEqual(1);
      // dryRun must never spend or create proposals.
      expect(result.proposalsCreated).toBe(0);
      expect(result.spentUsd).toBe(0);
      expect(pendingCount()).toBe(0);
      expect(listProposals()).toHaveLength(0);

      // The dryRun tick NEVER mutated the source repo.
      expect(repo.shasumTree()).toBe(before);
      expect(repo.gitStatus()).toBe('');
      expect(repo.currentBranch()).toBe(beforeBranch);
    });
  });

  it('createSandbox builds an isolated worktree under the tmp ~/.ashlr/sandboxes without mutating the source repo working tree, index, HEAD, or branches', async () => {
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);

      const beforeTree = repo.shasumTree();
      const beforeHead = repo.currentBranch();
      const beforeBranches = repo.branches().sort();

      const sb = createSandbox(repo.dir);
      try {
        // The sandbox worktree resolves UNDER the isolated tmp ~/.ashlr/sandboxes.
        expect(
          resolve(sb.worktreePath).startsWith(resolve(fx.ashlrDir, 'sandboxes')),
        ).toBe(true);
        expect(sb.sourceRepo).toBe(repo.dir);
        expect(sb.baseHead.length).toBeGreaterThan(0);

        // The source repo working tree / index / HEAD are untouched by sandbox
        // creation; only a scratch branch ref may have been added in the repo.
        expect(repo.shasumTree()).toBe(beforeTree);
        expect(repo.gitStatus()).toBe('');
        expect(repo.currentBranch()).toBe(beforeHead);
      } finally {
        removeSandbox(sb);
      }

      // After cleanup the scratch branch is gone — branch set is back to baseline.
      expect(repo.branches().sort()).toEqual(beforeBranches);
      expect(repo.shasumTree()).toBe(beforeTree);
      expect(repo.gitStatus()).toBe('');
    });
  });

  it('a PENDING patch Proposal is created from a known unified diff (status=pending)', async () => {
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);
      const sb = createSandbox(repo.dir);
      try {
        const proposal = makePatchProposal(repo.dir, sb.id);

        expect(proposal.status).toBe('pending');
        expect(proposal.kind).toBe('patch');
        expect(proposal.diff).toBe(makeAddFileDiff(PATCH_REL, PATCH_BODY));

        // It shows up as the sole PENDING proposal in the isolated inbox.
        expect(pendingCount()).toBe(1);
        const pending = listProposals({ status: 'pending' });
        expect(pending).toHaveLength(1);
        expect(pending[0]?.id).toBe(proposal.id);

        // Creating a proposal never touches the source working tree.
        expect(repo.gitStatus()).toBe('');
      } finally {
        removeSandbox(sb);
      }
    });
  });

  it('applyProposal REFUSES while the proposal is still pending', async () => {
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);

      const before = repo.shasumTree();
      const beforeBranches = repo.branches().sort();

      const proposal = makePatchProposal(repo.dir);

      // PENDING (not approved) => refuse; nothing mutated, status unchanged.
      const res = await applyProposal(proposal.id, { confirmed: true });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('pending');

      expect(loadProposal(proposal.id)?.status).toBe('pending');
      expect(repo.shasumTree()).toBe(before);
      expect(repo.gitStatus()).toBe('');
      expect(repo.branches().sort()).toEqual(beforeBranches);
    });
  });

  it('after setStatus(approved) + applyProposal(confirmed:true): patch lands on a NEW ashlr/proposal/<id> branch (ok:true, status=applied)', async () => {
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);

      const proposal = makePatchProposal(repo.dir);

      // Human-in-the-loop approval is required before the SOLE outward path runs.
      setStatus(proposal.id, 'approved');
      const res = await applyProposal(proposal.id, { confirmed: true });

      expect(res.ok).toBe(true);
      expect(res.status).toBe('applied');
      expect(loadProposal(proposal.id)?.status).toBe('applied');

      // The patch landed on a NEW branch named for the proposal id.
      const expectedBranch = `ashlr/proposal/${proposal.id}`;
      expect(repo.branches()).toContain(expectedBranch);
      expect(res.detail).toContain(expectedBranch);
      // Local only — never pushed.
      expect(res.detail).toMatch(/not pushed/i);
    });
  });

  it('REAL-TREE-UNCHANGED: shasumTree(repo) is byte-identical before and after the WHOLE chain, and git status --porcelain stays empty', async () => {
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);

      // Snapshot the source repo state BEFORE the whole chain.
      const treeBefore = repo.shasumTree();
      const branchBefore = repo.currentBranch();
      const branchesBefore = repo.branches().sort();

      // (1) Real dryRun discovery tick.
      const t = await tick(makeCfg(), { dryRun: true });
      expect(t.reason).toBe('dry-run');
      expect(t.proposalsCreated).toBe(0);

      // (2) Real sandbox worktree.
      const sb = createSandbox(repo.dir);

      // (3) Real PENDING patch proposal from a known diff.
      const proposal = makePatchProposal(repo.dir, sb.id);
      removeSandbox(sb);

      // (4) Approve + (5) apply via the SOLE outward path.
      setStatus(proposal.id, 'approved');
      const res = await applyProposal(proposal.id, { confirmed: true });
      expect(res.ok).toBe(true);
      expect(res.status).toBe('applied');

      // ── REAL-TREE-UNCHANGED ──────────────────────────────────────────────
      // The disposable repo's MAIN working tree + HEAD are byte-identical to
      // before the chain. The applied change exists ONLY on the new branch.
      expect(repo.shasumTree()).toBe(treeBefore);
      expect(repo.gitStatus()).toBe('');
      expect(repo.currentBranch()).toBe(branchBefore);

      // The patched file never appeared in the user's working tree.
      expect(() => repo.readFile(PATCH_REL)).toThrow();

      // The ONLY branch added is the proposal branch — no other refs moved.
      const branchesAfter = repo.branches().sort();
      const added = branchesAfter.filter((b) => !branchesBefore.includes(b));
      expect(added).toEqual([`ashlr/proposal/${proposal.id}`]);
    });
  });

  it('the applied change is reachable ONLY from the new branch — the initial branch HEAD and the user working tree never gained the patched file', async () => {
    await withTmpHome(async (fx) => {
      const repo = setupEnrolledRepo(fx);
      const initialBranch = repo.currentBranch();

      const proposal = makePatchProposal(repo.dir);
      setStatus(proposal.id, 'approved');
      const res = await applyProposal(proposal.id, { confirmed: true });
      expect(res.ok).toBe(true);

      const proposalBranch = `ashlr/proposal/${proposal.id}`;

      // The patched file is present on the proposal branch...
      const onProposalBranch = git(repo.dir, [
        'ls-tree',
        '--name-only',
        proposalBranch,
        PATCH_REL,
      ]);
      expect(onProposalBranch).toBe(PATCH_REL);

      // ...but ABSENT from the initial branch's tree.
      const onInitialBranch = git(repo.dir, [
        'ls-tree',
        '--name-only',
        initialBranch,
        PATCH_REL,
      ]);
      expect(onInitialBranch).toBe('');

      // ...and ABSENT from the live working tree (still on the initial branch).
      expect(repo.currentBranch()).toBe(initialBranch);
      expect(() => repo.readFile(PATCH_REL)).toThrow();
      expect(repo.gitStatus()).toBe('');

      // PROPOSAL-ONLY / ISOLATED sanity: still in the isolated tmp HOME, and the
      // applied proposal is the only one in the inbox.
      expect(resolve(homedir())).toBe(resolve(fx.home));
      expect(listProposals()).toHaveLength(1);
      expect(loadProposal(proposal.id)?.status).toBe('applied');
    });
  });
});

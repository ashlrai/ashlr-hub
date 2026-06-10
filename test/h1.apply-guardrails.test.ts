/**
 * test/h1.apply-guardrails.test.ts — H1 BUILD task: APPLY GUARDRAILS.
 *
 * applyProposal is the SOLE outward sink of autonomous work. This suite proves it
 * REFUSES every unsafe path and, on each refusal, mutates NOTHING: no branch is
 * created, the disposable repo's working tree is byte-unchanged + git-clean, and
 * an audit record with result 'refused' is written. It then proves the happy
 * path once more for contrast (approved + confirmed + enrolled => applied on a
 * NEW ashlr/proposal/<id> branch, real tree byte-unchanged).
 *
 * Every assertion runs on a DISPOSABLE git repo inside an ISOLATED tmp HOME via
 * the H1 testkit — the real ~/.ashlr is NEVER touched and the real portfolio is
 * NEVER enrolled. Fully deterministic: a known unified diff stands in for the
 * swarm's propose output, so NO model / network is ever invoked.
 *
 * Invariants proven: PROPOSAL-ONLY (apply is the only sink and refuses unless
 * pending->approved->confirmed), ENROLLMENT honored, KILL honored,
 * REAL-TREE-UNCHANGED across every refusal, ISOLATED, DETERMINISTIC.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  makeFixture,
  makeAddFileDiff,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Per-test fixture lifecycle — makeFixture relocates HOME into a fresh
// os.tmpdir() dir and cleanup() restores it + rm -rf's everything. We manage it
// per-test (rather than withTmpHome) so each refusal case gets a pristine,
// isolated ~/.ashlr and disposable repo.
// ---------------------------------------------------------------------------

let fx: H1Fixture;

function newFixture(): H1Fixture {
  fx = makeFixture();
  return fx;
}

afterEach(() => {
  // Idempotent + never throws; restores HOME and re-entrancy env.
  fx?.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A deterministic patch that adds one new file — the swarm's propose output. */
const PATCH_FILE = 'h1-apply.txt';
const PATCH_BODY = 'applied by H1 apply-guardrails\n';
function patchDiff(): string {
  return makeAddFileDiff(PATCH_FILE, PATCH_BODY);
}

/** Build a pending 'patch' proposal targeting `repo` carrying the known diff. */
function makePatchProposal(repo: DisposableRepo): Proposal {
  return createProposal({
    repo: repo.dir,
    origin: 'manual',
    kind: 'patch',
    title: 'H1 apply-guardrails patch',
    summary: 'Adds a single deterministic file on a new branch.',
    diff: patchDiff(),
  });
}

/** Count audit entries with result 'refused' for the inbox:apply action. */
function refusedApplyCount(): number {
  return readAudit().filter(
    (e) => e.action === 'inbox:apply' && e.result === 'refused',
  ).length;
}

/**
 * Assert a refusal left the disposable repo completely untouched: the apply
 * returned ok:false, no new branch exists, the working tree is byte-identical +
 * git-clean, the current branch is unchanged, and EXACTLY ONE new 'refused'
 * audit record was written for this attempt.
 */
async function expectRefusalLeavesEverythingUntouched(
  repo: DisposableRepo,
  attempt: () => Promise<{ ok: boolean }>,
): Promise<void> {
  const treeBefore = repo.shasumTree();
  const branchesBefore = repo.branches();
  const currentBefore = repo.currentBranch();
  const refusedBefore = refusedApplyCount();

  const result = await attempt();

  // REFUSED.
  expect(result.ok).toBe(false);

  // NO branch created (and the source branch list is byte-identical).
  expect(repo.branches()).toEqual(branchesBefore);
  expect(
    repo.branches().some((b) => b.startsWith('ashlr/proposal/')),
    'a refused apply must never create an ashlr/proposal/ branch',
  ).toBe(false);

  // REAL-TREE-UNCHANGED: byte-identical tree, clean status, same branch.
  expect(repo.shasumTree()).toBe(treeBefore);
  expect(repo.gitStatus()).toBe('');
  expect(repo.currentBranch()).toBe(currentBefore);

  // Exactly one new 'refused' inbox:apply audit record for this attempt.
  expect(refusedApplyCount()).toBe(refusedBefore + 1);
}

// ===========================================================================
// REFUSE: proposal not found
// ===========================================================================

describe('H1 apply-guardrails — REFUSE: proposal not found', () => {
  it('refuses a non-existent id (ok:false), creates no branch, tree byte-unchanged, audits refused', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    repo.enroll();

    await expectRefusalLeavesEverythingUntouched(repo, () =>
      applyProposal('prop-does-not-exist-xyz', { confirmed: true }),
    );
  });

  it('never throws for a missing proposal and reports status "failed"', async () => {
    newFixture();
    const result = await applyProposal('prop-missing', { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/not found/i);
  });
});

// ===========================================================================
// REFUSE: status !== 'approved'
// ===========================================================================

describe('H1 apply-guardrails — REFUSE: status !== approved', () => {
  it('refuses a PENDING proposal even when confirmed:true; status stays pending', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    expect(p.status).toBe('pending');

    await expectRefusalLeavesEverythingUntouched(repo, () =>
      applyProposal(p.id, { confirmed: true }),
    );

    // PENDING must NOT be burned by a refused apply.
    expect(loadProposal(p.id)!.status).toBe('pending');
  });

  it('refuses a REJECTED proposal; status stays rejected', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'rejected');

    await expectRefusalLeavesEverythingUntouched(repo, () =>
      applyProposal(p.id, { confirmed: true }),
    );

    expect(loadProposal(p.id)!.status).toBe('rejected');
  });

  it('refuses an already-APPLIED proposal', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'approved');
    setStatus(p.id, 'applied', 'already applied');

    await expectRefusalLeavesEverythingUntouched(repo, () =>
      applyProposal(p.id, { confirmed: true }),
    );
  });
});

// ===========================================================================
// REFUSE: confirmed !== true
// ===========================================================================

describe('H1 apply-guardrails — REFUSE: confirmed !== true', () => {
  it('refuses an approved proposal when confirmed:false; status stays approved', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'approved');

    await expectRefusalLeavesEverythingUntouched(repo, () =>
      applyProposal(p.id, { confirmed: false }),
    );

    // The approved proposal is NOT burned — it can still be applied later.
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

// ===========================================================================
// REFUSE: repo not enrolled (the ENROLLMENT gate)
// ===========================================================================

describe('H1 apply-guardrails — REFUSE: target repo not enrolled', () => {
  it('refuses an approved+confirmed apply on a NON-enrolled repo; status stays approved', async () => {
    const f = newFixture();
    const repo = f.makeRepo(); // deliberately NOT enrolled
    expect(repo.isEnrolled()).toBe(false);
    const p = makePatchProposal(repo);
    setStatus(p.id, 'approved');

    await expectRefusalLeavesEverythingUntouched(repo, () =>
      applyProposal(p.id, { confirmed: true }),
    );

    const loaded = loadProposal(p.id)!;
    // Refusal — NOT a failure: the approved proposal survives for retry after
    // enrolling. (applyProposal returns status 'approved' on a policy refusal.)
    expect(loaded.status).toBe('approved');
  });

  it('the refusal detail names the enrollment gate', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'approved');

    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/enroll/i);
  });
});

// ===========================================================================
// REFUSE: kill switch ON (the KILL gate)
// ===========================================================================

describe('H1 apply-guardrails — REFUSE: kill switch ON', () => {
  it('refuses even for approved+confirmed+enrolled; status stays approved', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'approved');

    // Kill switch ON — must halt the only outward path regardless of enrollment.
    f.setKill(true);

    await expectRefusalLeavesEverythingUntouched(repo, () =>
      applyProposal(p.id, { confirmed: true }),
    );

    const loaded = loadProposal(p.id)!;
    expect(loaded.status).toBe('approved');
  });

  it('the refusal detail names the kill switch', async () => {
    const f = newFixture();
    const repo = f.makeRepo();
    repo.enroll();
    const p = makePatchProposal(repo);
    setStatus(p.id, 'approved');
    f.setKill(true);

    const result = await applyProposal(p.id, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/kill/i);
  });
});

// ===========================================================================
// HAPPY PATH (contrast): approved + confirmed + enrolled => applied
// ===========================================================================

describe('H1 apply-guardrails — happy path (contrast)', () => {
  it(
    'approved + confirmed + enrolled applies the patch on a NEW ashlr/proposal/<id> branch, ' +
      'real working tree byte-unchanged, and audits result "ok"',
    async () => {
      const f = newFixture();
      const repo = f.makeRepo();
      repo.enroll();

      const p = makePatchProposal(repo);
      setStatus(p.id, 'approved');

      // Snapshot the REAL working tree before the only outward action runs.
      const treeBefore = repo.shasumTree();
      const branchesBefore = repo.branches();
      const currentBefore = repo.currentBranch();

      const result = await applyProposal(p.id, { confirmed: true });

      // Applied.
      expect(result.ok).toBe(true);
      expect(result.status).toBe('applied');
      expect(loadProposal(p.id)!.status).toBe('applied');

      // A NEW namespaced branch carrying the proposal id now exists.
      const newBranches = repo
        .branches()
        .filter((b) => !branchesBefore.includes(b));
      expect(newBranches).toHaveLength(1);
      const applied = newBranches[0]!;
      expect(applied).toBe(`ashlr/proposal/${p.id}`);

      // REAL-TREE-UNCHANGED: the source working tree is byte-identical, the
      // index is clean, and the user's current branch never moved. The applied
      // change lives ONLY on the new branch.
      expect(repo.shasumTree()).toBe(treeBefore);
      expect(repo.gitStatus()).toBe('');
      expect(repo.currentBranch()).toBe(currentBefore);
      // The patched file must NOT exist in the working tree (it's only on the
      // new branch, which was never checked out into the source tree).
      expect(() => repo.readFile(PATCH_FILE)).toThrow();

      // A successful inbox:apply audit record with result 'ok' was written.
      const okApply = readAudit().find(
        (e) => e.action === 'inbox:apply' && e.result === 'ok',
      );
      expect(okApply).toBeDefined();
      expect(okApply!.repo).toBe(repo.dir);
    },
  );
});

// ===========================================================================
// REFUSE (parametrized): REAL-TREE-UNCHANGED + 'refused' audit across gates
// ===========================================================================

describe('H1 apply-guardrails — REAL-TREE-UNCHANGED across every refused gate', () => {
  type Gate = {
    name: string;
    // Arrange the proposal/fixture into the refusal precondition; returns the
    // apply invocation to run.
    arrange: (f: H1Fixture, repo: DisposableRepo) => Promise<() => Promise<{ ok: boolean }>>;
  };

  const gates: Gate[] = [
    {
      name: 'not-found',
      arrange: async (_f, repo) => {
        repo.enroll();
        return () => applyProposal('prop-missing-parametrized', { confirmed: true });
      },
    },
    {
      name: 'pending',
      arrange: async (_f, repo) => {
        repo.enroll();
        const p = makePatchProposal(repo);
        return () => applyProposal(p.id, { confirmed: true });
      },
    },
    {
      name: 'unconfirmed',
      arrange: async (_f, repo) => {
        repo.enroll();
        const p = makePatchProposal(repo);
        setStatus(p.id, 'approved');
        return () => applyProposal(p.id, { confirmed: false });
      },
    },
    {
      name: 'not-enrolled',
      arrange: async (_f, repo) => {
        const p = makePatchProposal(repo); // repo NOT enrolled
        setStatus(p.id, 'approved');
        return () => applyProposal(p.id, { confirmed: true });
      },
    },
    {
      name: 'kill-switch',
      arrange: async (f, repo) => {
        repo.enroll();
        const p = makePatchProposal(repo);
        setStatus(p.id, 'approved');
        f.setKill(true);
        return () => applyProposal(p.id, { confirmed: true });
      },
    },
  ];

  for (const gate of gates) {
    it(`gate "${gate.name}" refuses, creates no branch, tree byte-unchanged, audits refused`, async () => {
      const f = newFixture();
      const repo = f.makeRepo();
      const attempt = await gate.arrange(f, repo);
      await expectRefusalLeavesEverythingUntouched(repo, attempt);
    });
  }
});

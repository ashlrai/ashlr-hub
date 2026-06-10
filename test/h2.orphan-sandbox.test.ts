/**
 * test/h2.orphan-sandbox.test.ts — H2 BUILD task 3: NO-ORPHAN-SANDBOX.
 *
 * MILESTONE H2 "Harden & Prove" — CRASH RECOVERY & RESUMABILITY. A swarm killed
 * after `git worktree add` but before its `removeSandbox()` leaves a real
 * worktree + scratch branch on disk under ~/.ashlr/sandboxes/<id>/. This suite
 * proves the recovery surface can SURFACE and SWEEP that orphan:
 *
 *   - SURFACE: makeOrphanSandbox(repo) creates a REAL worktree then drops the
 *     handle; listSandboxes() must surface it (the orphan has persisted metadata
 *     but no live owner) — proving the orphan is detectable, not invisible.
 *   - SWEEP: the recovery path removes the orphan via the REAL removeSandbox
 *     (worktree remove --force + scratch branch -D), leaving NO worktree dir, NO
 *     scratch ref, and — paramount — NOT touching the SOURCE repo's working
 *     tree, index, HEAD, or user branches (shasumTree byte-identical, status
 *     clean, branch set unchanged).
 *   - GAP PROBED: does ANY production code actually sweep orphan sandboxes on
 *     restart, or do they accumulate forever? If none exists, CONTRACT-H2.md
 *     proposes a MINIMAL LOCAL-ONLY sweeper (listSandboxes -> removeSandbox for
 *     unowned ids) that adds NO outward capability.
 *
 * SAFETY: FRESH isolated tmp HOME; the worktree lives ONLY under the tmp
 * ~/.ashlr/sandboxes; the disposable SOURCE repo is the only repo touched and it
 * is asserted byte-unchanged. allowAnyRepo lets a tmp repo be sandboxed without
 * enrollment; it NEVER bypasses the kill switch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  removeSandbox,
  sweepOrphanSandboxes,
  sandboxesDir,
} from '../src/core/sandbox/worktree.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import {
  makeOrphanSandbox,
  listOrphanSandboxes,
  sandboxHomeExists,
} from './helpers/h2-faults.js';

/** Short-name of the scratch branch a sandbox id maps to. */
function scratchBranch(id: string): string {
  return `ashlr/sandbox/${id}`;
}

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H2 false-green guard: every H2 it() MUST run at least one assertion. A
  // future empty-stub test (TODO body, zero expect) then FAILS loudly instead
  // of passing vacuously — the headline risk this milestone exists to disprove.
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo();
});

afterEach(() => {
  fx.cleanup();
});

describe('H2 orphan sandbox — crash-leftover worktree is surfaced and swept', () => {
  it('an orphaned worktree (dropped handle) is surfaced by listSandboxes', () => {
    // A swarm killed after `git worktree add` but before removeSandbox() leaves a
    // real worktree on disk with no live owner. makeOrphanSandbox creates exactly
    // that: a REAL createSandbox then a dropped handle.
    const sb = makeOrphanSandbox(repo.dir);

    // The orphan must be DETECTABLE — on-disk home present + surfaced by the
    // store enumerator (not invisible / un-reclaimable).
    expect(sandboxHomeExists(sb.id)).toBe(true);

    const surfaced = listOrphanSandboxes();
    expect(surfaced.map((s) => s.id)).toContain(sb.id);

    // The surfaced metadata points at the real source repo + the namespaced
    // scratch branch — confirming it is a genuine worktree, not a phantom.
    const found = surfaced.find((s) => s.id === sb.id);
    expect(found?.sourceRepo).toBe(repo.dir);
    expect(found?.branch).toBe(scratchBranch(sb.id));

    // The orphan's scratch branch really exists in the SOURCE repo's ref set
    // (the worktree add created it) — so the sweep below has something to delete.
    expect(repo.branches()).toContain(scratchBranch(sb.id));
  });

  it('sweeping the orphan removes worktree + scratch branch with no source mutation', () => {
    // Snapshot the SOURCE repo BEFORE any sandbox op — the byte-for-byte baseline.
    const treeBefore = repo.shasumTree();
    const statusBefore = repo.gitStatus();
    const headBefore = repo.currentBranch();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    const sb = makeOrphanSandbox(repo.dir);
    expect(sandboxHomeExists(sb.id)).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(sb.id));

    // The REAL sweep: removeSandbox (git worktree remove --force + branch -D),
    // run against the source repo but targeting only the namespaced scratch ref.
    removeSandbox(sb);

    // Orphan fully reclaimed: no on-disk home, nothing left to surface.
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(listOrphanSandboxes().map((s) => s.id)).not.toContain(sb.id);

    // The scratch branch is gone from the source repo's ref set...
    expect(repo.branches()).not.toContain(scratchBranch(sb.id));

    // ...and — paramount — the SOURCE repo is byte-identical: working tree hash,
    // porcelain status, checked-out branch, and the user's (non-scratch) branch
    // set are all exactly as before the orphan ever existed.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe(statusBefore);
    expect(repo.currentBranch()).toBe(headBefore);
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);
  });

  it('the sweep is idempotent — re-sweeping an already-removed orphan never throws', () => {
    const treeBefore = repo.shasumTree();

    const sb = makeOrphanSandbox(repo.dir);
    removeSandbox(sb);
    expect(sandboxHomeExists(sb.id)).toBe(false);

    // A second removeSandbox on the SAME (now-gone) orphan is a pure no-op:
    // never throws, surfaces nothing, and leaves the source still byte-clean.
    expect(() => removeSandbox(sb)).not.toThrow();
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(listOrphanSandboxes().map((s) => s.id)).not.toContain(sb.id);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
  });

  it('GAP: a restart-time sweeper removes ALL unowned sandboxes', () => {
    // GAP PROBE: there is NO production caller that sweeps orphan sandboxes on
    // restart (a SwarmRun does not persist a sandboxId — the swarm creates, uses,
    // and removes its sandbox entirely in-memory), so a crash mid-swarm leaves a
    // worktree that would accumulate FOREVER. CONTRACT-H2.md GAP #3 sanctions a
    // MINIMAL LOCAL-ONLY fix: sweepOrphanSandboxes() = listSandboxes() ->
    // removeSandbox() over the ashlr/sandbox/* namespace, composing the two
    // existing safe primitives, adding NO outward capability and weakening NO
    // guard. This test exercises that recovery entry point.
    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    // Simulate several crash-leftover orphans across two disposable repos.
    const repo2 = fx.makeRepo();
    const orphans = [
      makeOrphanSandbox(repo.dir),
      makeOrphanSandbox(repo.dir),
      makeOrphanSandbox(repo2.dir),
    ];
    for (const o of orphans) {
      expect(sandboxHomeExists(o.id)).toBe(true);
    }
    expect(listOrphanSandboxes()).toHaveLength(3);

    // The restart-time sweep reclaims EVERY unowned sandbox in one pass and
    // reports the ids it swept.
    const swept = sweepOrphanSandboxes();
    expect(swept.sort()).toEqual(orphans.map((o) => o.id).sort());

    // Nothing left: no homes on disk, store surfaces none.
    for (const o of orphans) {
      expect(sandboxHomeExists(o.id)).toBe(false);
    }
    expect(listOrphanSandboxes()).toHaveLength(0);

    // A re-sweep on a now-clean state is a no-op (idempotent restart safety).
    expect(sweepOrphanSandboxes()).toEqual([]);

    // Both source repos are byte-untouched: scratch branches gone, user branches
    // + working tree + status exactly as before.
    expect(repo.branches().some((b) => b.startsWith('ashlr/sandbox/'))).toBe(false);
    expect(repo2.branches().some((b) => b.startsWith('ashlr/sandbox/'))).toBe(false);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(repo2.gitStatus()).toBe('');
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);
  });
  it('the staleMs guard SKIPS a not-yet-stale (possibly-live) sandbox — never force-removes a live worktree', () => {
    // SAFETY for any future restart wire-up (finding: the sweep has no pid/owner
    // field, only createdAt). A freshly-created sandbox could be an ACTIVELY
    // RUNNING swarm's worktree (a swarm keeps its sandbox on disk for the whole
    // run; the daemon runs several concurrently). With a conservative staleMs the
    // sweep must NOT reclaim a sandbox younger than the threshold.
    const treeBefore = repo.shasumTree();

    const fresh = makeOrphanSandbox(repo.dir); // createdAt = now (not stale yet)
    expect(sandboxHomeExists(fresh.id)).toBe(true);

    // A 1-hour staleness floor: the just-created sandbox is far younger, so a
    // restart-time sweep gated on staleMs leaves it ENTIRELY untouched.
    const swept = sweepOrphanSandboxes({ staleMs: 60 * 60 * 1000 });
    expect(swept).toEqual([]);
    expect(sandboxHomeExists(fresh.id)).toBe(true); // still on disk — not destroyed
    expect(repo.branches()).toContain(scratchBranch(fresh.id)); // scratch ref intact

    // Cleanup via the un-gated reclaim (proves it is still reclaimable later).
    expect(sweepOrphanSandboxes()).toContain(fresh.id);
    expect(sandboxHomeExists(fresh.id)).toBe(false);
    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('the staleMs guard RECLAIMS a sandbox older than the threshold (a genuine stale orphan)', () => {
    // A crash-leftover worktree that has aged past the threshold IS a true orphan
    // (no run could still be using a sandbox older than the max swarm wall-clock).
    // Age its persisted createdAt into the past, then prove a gated sweep reclaims
    // it (and only it) while leaving the source repo byte-identical.
    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    const aged = makeOrphanSandbox(repo.dir);
    const fresh = makeOrphanSandbox(repo.dir);

    // Rewrite the aged sandbox's metadata createdAt to two hours ago (the store
    // re-reads createdAt at sweep time, so this is the exact field the guard
    // checks). Done through the SAME on-disk layout the store uses.
    const metaPath = join(sandboxesDir(), aged.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { createdAt: string };
    meta.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    // A 1-hour staleness floor: only the 2-hours-old orphan is reclaimed; the
    // just-created one is preserved as possibly-live.
    const swept = sweepOrphanSandboxes({ staleMs: 60 * 60 * 1000 });
    expect(swept).toEqual([aged.id]);
    expect(sandboxHomeExists(aged.id)).toBe(false); // stale orphan reclaimed
    expect(sandboxHomeExists(fresh.id)).toBe(true); // fresh one left alone

    // Source repo byte-identical; only the aged orphan's scratch ref is gone.
    expect(repo.branches()).not.toContain(scratchBranch(aged.id));
    expect(repo.branches()).toContain(scratchBranch(fresh.id));
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);

    // Cleanup the remaining fresh orphan.
    sweepOrphanSandboxes();
  });
});

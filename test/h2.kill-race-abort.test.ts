/**
 * test/h2.kill-race-abort.test.ts — H2 BUILD task 5: KILL-RACE-CLEAN-ABORT.
 *
 * MILESTONE H2 "Harden & Prove" — CRASH RECOVERY & RESUMABILITY. The global kill
 * switch (~/.ashlr/KILL) is checked BEFORE any work in every mutation gate
 * (policy.assertMayMutate / killSwitchOn). This suite proves that toggling the
 * kill switch DURING work — the race where a `stop` lands between a daemon's /
 * swarm's / apply path's persist points — yields a CLEAN ABORT with NO partial
 * OUTWARD action and NO corrupted state. Three races are exercised against the
 * REAL gates, plus the byte-identical-tree invariant on every outcome:
 *
 *   (a) KILL-MID-TICK: kill toggled on between a tick's gate check and its work
 *       => the REAL tick() aborts at the kill gate (reason 'kill-switch'), so NO
 *       swarm is dispatched and NO proposal is created (pendingCount stays 0);
 *       the persisted spend is untouched (no double-count); the enrolled repo's
 *       working tree is byte-identical (no sandbox, no orphan worktree).
 *   (b) KILL-DURING-RESUME: a swarm crashed at 'running', then the kill switch is
 *       toggled on, then a resume is attempted with a MANDATORY sandbox. The REAL
 *       runSwarm({ resumeId, sandbox, requireSandbox }) aborts at the sandbox
 *       gate (createSandbox refuses under the kill switch) and executes ZERO
 *       tasks; the persisted crashed run is NOT falsely advanced to 'done' (it
 *       stays at the non-terminal 'running' it crashed at, safely resumable once
 *       the kill is cleared); the repo working tree is byte-identical.
 *   (c) KILL-BEFORE-APPLY: an APPROVED patch proposal, then the kill switch is
 *       toggled on AFTER approval but BEFORE apply => the REAL applyProposal
 *       REFUSES at the policy gate (ok:false, status stays 'approved' so it can
 *       be retried after clearing the kill), NO branch is created, and the
 *       attempt is audited result:'refused'; the repo working tree is
 *       byte-identical.
 *
 * In EVERY race outcome the disposable repo's working tree is asserted
 * byte-identical (shasumTree), git status clean, and branch set unchanged — the
 * NO-PARTIAL-OUTWARD-EFFECT invariant.
 *
 * SAFETY (inherited from H1, paramount): FRESH isolated tmp HOME per test; the
 * kill switch + all state (swarms / sandboxes / inbox / daemon.json) live under
 * the tmp HOME; DISPOSABLE git repos only; the real portfolio ({repos:[]}) is
 * NEVER enrolled or touched. DETERMINISTIC: no live model, no network, no real
 * crashing subprocess — every "crash"/race is a synthetic persisted-state
 * construction + the REAL gate. runSwarm is NOT mocked: the kill gate returns
 * BEFORE any task/model work in all three paths, so the real abort is exercised.
 *
 * RECOVERY GAP PROBED (CONTRACT-H2 §5): can a kill-switch race leave a
 * half-applied effect? Expectation: PASS with NO production change — the gate is
 * checked before work in tick / createSandbox(requireSandbox) / applyProposal, so
 * every race is already a clean abort. This suite is pure PROOF.
 */

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { tick } from '../src/core/daemon/loop.js';
import { runSwarm } from '../src/core/swarm/runner.js';
import { nullSink } from '../src/core/run/streaming.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import { setStatus, loadProposal, listProposals } from '../src/core/inbox/store.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import { listSandboxes } from '../src/core/sandbox/worktree.js';

import {
  makeFixture,
  makeCfg,
  makeAddFileDiff,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import {
  crashMidSwarm,
  reloadSwarm,
  reloadDaemonState,
  seedMidTickSpend,
  seedPendingProposal,
} from './helpers/h2-faults.js';

/**
 * Replace a proposal's diff field in place via the REAL inbox store layout
 * (load -> rewrite -> persist). Used only to swap the seed placeholder diff for
 * an appliable one so the kill gate is the SOLE thing stopping the apply in case
 * (c). Never advances status.
 */
function rewriteProposalDiff(id: string, diff: string): void {
  const existing = loadProposal(id);
  if (!existing) throw new Error(`rewriteProposalDiff: proposal ${id} not found`);
  const updated = { ...existing, diff };
  const p = join(homedir(), '.ashlr', 'inbox', `${id}.json`);
  writeFileSync(p, JSON.stringify(updated, null, 2) + '\n', 'utf8');
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

describe('H2 kill-race — a kill toggled during work aborts cleanly, no partial outward action', () => {
  // -------------------------------------------------------------------------
  // (a) KILL-MID-TICK — kill toggled on before a tick's work => clean abort.
  // -------------------------------------------------------------------------
  it('kill toggled on before a tick => abort at kill gate, no swarm, no proposal, spend unchanged, tree byte-identical', async () => {
    // Enroll the disposable repo and seed a mid-tick spend (the state a crash
    // left). The tick would normally build a backlog + dispatch a sandboxed
    // swarm for the enrolled repo — but the kill switch races in first.
    repo.enroll();
    seedMidTickSpend({ spentUsd: 0.2, running: false });

    const treeBefore = repo.shasumTree();
    const statusBefore = repo.gitStatus();
    const branchesBefore = repo.branches();

    // The race: kill toggled on between the (passed) gate state and the work.
    fx.setKill(true);

    const t = await tick(makeCfg(), { dryRun: false });

    // Tick aborted at the kill gate — before enrollment/backlog/swarm dispatch.
    expect(t.reason).toBe('kill-switch');
    expect(t.proposalsCreated).toBe(0);
    expect(t.spentUsd).toBe(0);

    // NO swarm was dispatched => NO proposal exists (nothing outward happened).
    expect(listProposals()).toHaveLength(0);
    // NO sandbox/worktree was created => the race cannot have left an orphan.
    expect(listSandboxes()).toHaveLength(0);

    // The persisted spend is untouched — the kill abort never re-counts or
    // zeroes the already-debited $0.20 (no double-count, no partial effect).
    expect(reloadDaemonState().todaySpentUsd).toBe(0.2);

    // Working tree byte-identical: no sandbox, no branch, nothing mutated.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe(statusBefore);
    expect(repo.branches()).toEqual(branchesBefore);
  });

  // -------------------------------------------------------------------------
  // (b) KILL-DURING-RESUME — kill toggled on after a crash => resume aborts.
  // -------------------------------------------------------------------------
  it('kill toggled on after a crash => resume aborts at sandbox gate, zero tasks, run not falsely done, tree byte-identical', async () => {
    repo.enroll();

    // A crash left this run at 'running' with one task done, two pending — the
    // exact resumable intermediate. project = the disposable repo so the resume
    // would (absent the kill) create a MANDATORY sandbox off it.
    const crashed = crashMidSwarm({
      id: 'h2-killrace-resume',
      goal: 'resume under a kill-switch race',
      project: repo.dir,
      taskIds: ['t1', 't2', 't3'],
      doneTaskIds: ['t1'],
    });
    expect(crashed.status).toBe('running');

    const treeBefore = repo.shasumTree();
    const statusBefore = repo.gitStatus();
    const branchesBefore = repo.branches();

    // The race: kill toggled on AFTER the crash, BEFORE the resume runs.
    fx.setKill(true);

    // Resume with a MANDATORY sandbox (the autonomous daemon's shape). The
    // sandbox can't be created under the kill switch (createSandbox refuses), so
    // the runner MUST abort and execute ZERO tasks — never touching the tree.
    const resumed = await runSwarm(
      { goal: crashed.goal },
      makeCfg(),
      {
        resumeId: crashed.id,
        project: repo.dir,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
        parallel: 1,
        dryRun: false,
      },
      nullSink(),
    );

    // The resume aborted at the mandatory-sandbox gate: ZERO tasks executed and
    // the returned run is NOT 'done' (the abort surfaces as 'failed' with a
    // "mandatory sandbox could not be created" reason — never a bogus success).
    expect(resumed.status).not.toBe('done');
    expect(resumed.tasks).toHaveLength(0);
    expect(resumed.result ?? '').toMatch(/sandbox/i);

    // The PERSISTED crashed record is untouched by the aborted resume — it stays
    // at the non-terminal 'running' it crashed at (safely resumable once the
    // kill is cleared), NEVER falsely advanced to 'done'. Its done task is
    // preserved; no task was re-run.
    const persisted = reloadSwarm(crashed.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe('running');
    expect(persisted?.tasks.find((x) => x.id === 't1')?.status).toBe('done');
    expect(persisted?.tasks.find((x) => x.id === 't2')?.status).toBe('pending');
    expect(persisted?.tasks.find((x) => x.id === 't3')?.status).toBe('pending');

    // No sandbox/worktree was created (the gate refused before `worktree add`),
    // so the race left no orphan.
    expect(listSandboxes()).toHaveLength(0);

    // Working tree byte-identical: the mandatory-sandbox abort never touched it.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe(statusBefore);
    expect(repo.branches()).toEqual(branchesBefore);
  });

  // -------------------------------------------------------------------------
  // (c) KILL-BEFORE-APPLY — kill toggled on after approval, before apply.
  // -------------------------------------------------------------------------
  it('applyProposal with kill toggled on after approval but before apply => refuses, no branch, audit refused, tree byte-identical', async () => {
    repo.enroll();

    // A swarm left a PENDING patch proposal; a human approved it. The diff is a
    // real git-apply-compatible new-file patch so this exercises the REAL apply
    // path (no model) right up to the policy gate.
    const diff = makeAddFileDiff('killrace-apply.txt', 'should never be applied\n');
    const proposal = seedPendingProposal(repo.dir, 'h2-killrace-apply');
    // Re-stamp the proposal with the appliable diff + flip it to 'approved'
    // (the exact state right before a human-confirmed apply).
    setStatus(proposal.id, 'approved', undefined);
    // seedPendingProposal's placeholder diff isn't appliable; replace it via the
    // store round-trip so the ONLY thing stopping the apply is the kill gate.
    rewriteProposalDiff(proposal.id, diff);

    const approved = loadProposal(proposal.id);
    expect(approved?.status).toBe('approved');

    const treeBefore = repo.shasumTree();
    const statusBefore = repo.gitStatus();
    const branchesBefore = repo.branches();
    const auditBefore = readAudit().length;

    // The race: kill toggled on AFTER approval, BEFORE the confirmed apply.
    fx.setKill(true);

    const result = await applyProposal(proposal.id, { confirmed: true });

    // REFUSED at the policy gate — not a failure. The proposal stays 'approved'
    // so it can be retried once the kill switch is cleared (advancing it to
    // 'failed' would wrongly burn an approved proposal).
    expect(result.ok).toBe(false);
    expect(result.status).toBe('approved');
    expect(result.detail).toMatch(/kill switch/i);

    // The persisted proposal is still 'approved' (never auto-advanced by the
    // refusal) — no stuck/limbo state.
    expect(loadProposal(proposal.id)?.status).toBe('approved');

    // NO branch was created: the apply refused before any git worktree/branch
    // op, so the proposal branch namespace is absent.
    expect(repo.branches()).toEqual(branchesBefore);
    expect(repo.branches().some((b) => b.includes(proposal.id))).toBe(false);
    expect(
      repo.branches().some((b) => b.startsWith('ashlr/proposal/')),
    ).toBe(false);

    // The refusal was audited result:'refused' for this proposal (an inbox:apply
    // audit entry, gated by the policy, mentioning the refusal). readAudit is
    // newest-first, so the entries added by this apply are the leading slice.
    const auditsNow = readAudit();
    const newAudits = auditsNow.slice(0, auditsNow.length - auditBefore);
    const refusal = newAudits.find(
      (e) =>
        e.action === 'inbox:apply' &&
        e.result === 'refused' &&
        e.sandboxId === proposal.id,
    );
    expect(refusal).toBeDefined();
    expect(refusal?.summary).toMatch(/refused by policy gate/i);

    // Working tree byte-identical: the refused apply mutated nothing.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe(statusBefore);
  });

  // -------------------------------------------------------------------------
  // No sticky/latent abort: clearing the kill switch restores normal operation.
  // -------------------------------------------------------------------------
  it('clearing the kill switch restores normal operation — the race left no sticky abort state', async () => {
    repo.enroll();
    seedMidTickSpend({ spentUsd: 0.0, running: false });

    const treeBefore = repo.shasumTree();

    // Kill on then off — the on->off toggle must leave NO latent refusal.
    fx.setKill(true);
    const killedTick = await tick(makeCfg(), { dryRun: false });
    expect(killedTick.reason).toBe('kill-switch');

    fx.setKill(false);

    // A subsequent tick is no longer refused by the (now-cleared) kill switch —
    // it proceeds PAST the kill gate. A DRY-RUN tick is used so this stays fully
    // model-free + deterministic: a dry-run reaches the planning/selection step
    // (any reason BUT 'kill-switch') WITHOUT dispatching a swarm or creating a
    // proposal, which is exactly enough to prove the gate cleared cleanly.
    const clearedTick = await tick(makeCfg(), { dryRun: true });
    expect(clearedTick.reason).not.toBe('kill-switch');
    expect(clearedTick.proposalsCreated).toBe(0);

    // No swarm dispatched on either tick => no sandbox/orphan; tree untouched.
    expect(listSandboxes()).toHaveLength(0);
    expect(listProposals()).toHaveLength(0);
    expect(repo.shasumTree()).toBe(treeBefore);
  });
});

/**
 * h7.onboard.test.ts — Ashlr v2.1 MILESTONE H7, BUILD ITEM 3 + 5.
 *
 * INVARIANT proven here (see docs/contracts/CONTRACT-H7.md):
 *  - ONBOARD-NEVER-AUTO-APPLIES: `ashlr onboard` chains ONLY the pre-existing
 *    human gates — preflight (read-only) → enroll ONE repo (the explicit
 *    enrollment gate) → daemon --dry-run --once (read-only, NO proposal) →
 *    human-readable PLAN → point at `ashlr inbox`. It NEVER approves/applies a
 *    proposal, NEVER pushes/PRs/deploys, NEVER runs a live (non-dry) daemon.
 *  - Non-interactive (--yes / non-TTY) prints the numbered steps WITHOUT
 *    prompting and WITHOUT enrolling.
 *  - The dry-run PLAN (renderDryRunPlan) creates NO proposal and spends $0.
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5/H6):
 *  - ISOLATED HOME per test via makeFixture; DISPOSABLE REPOS (fx.makeRepo);
 *    DETERMINISTIC (no model, no network; no live daemon, no live swarm).
 *  - Every it() ends with a real expect() + expect.hasAssertions().
 *
 * MOCK STRATEGY (deterministic, NO live model / daemon / swarm):
 *  - vi.mock('../src/core/daemon/loop.js') replaces `tick` with a spy that
 *    returns a fixed DaemonTick. This lets us ASSERT tick was called with
 *    { dryRun: true } and NEVER with { dryRun: false } (no live daemon).
 *  - vi.mock('../src/core/readiness.js') replaces `buildReadiness` so we drive
 *    ready vs. blocked deterministically with NO live probeEndpoint.
 *  - The exported `_internals.confirm` seam is overridden so we control the TTY
 *    confirm without a real terminal (a direct module-internal call to the
 *    exported promptConfirm cannot be spied across the ESM boundary).
 *  - vi.spyOn(setStatus/createProposal) proves onboard NEVER approves/applies/
 *    creates a proposal (the human inbox gate is never bypassed).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { makeFixture, seedBacklog, type H1Fixture } from './helpers/h1-fixture.js';

// ── Deterministic mocks ─────────────────────────────────────────────────────
// vi.mock is hoisted above module-scope consts, so the spies are created via
// vi.hoisted (which runs first) and shared with the factories + the tests.
// tick: records its opts + returns a fixed dry-run-shaped tick so
// renderDryRunPlan gets an authoritative itemsConsidered without a live daemon.
// buildReadiness: deterministic ready/blocked, no live probeEndpoint.
const { tickSpy, readinessSpy } = vi.hoisted(() => ({
  tickSpy: vi.fn(async (_cfg: unknown, opts: { dryRun: boolean }) => ({
    ts: new Date().toISOString(),
    itemsConsidered: opts.dryRun ? 2 : 0,
    proposalsCreated: 0,
    spentUsd: 0,
    reason: 'dry-run',
  })),
  readinessSpy: vi.fn(),
}));
vi.mock('../src/core/daemon/loop.js', () => ({ tick: tickSpy }));
vi.mock('../src/core/readiness.js', () => ({ buildReadiness: readinessSpy }));

import { cmdOnboard, renderDryRunPlan, _internals } from '../src/cli/onboard.js';
import { listEnrolled } from '../src/core/sandbox/policy.js';
import * as inboxStore from '../src/core/inbox/store.js';

const { listProposals } = inboxStore;

function readyReport() {
  return {
    ready: true,
    blockers: [],
    warnings: [],
    info: [{ id: 'enrollment', severity: 'info' as const, detail: '0 repo(s) enrolled' }],
    generatedAt: new Date().toISOString(),
  };
}
function blockedReport() {
  return {
    ready: false,
    blockers: [
      { id: 'ashlr-writeable', severity: 'blocker' as const, detail: '~/.ashlr is not writeable' },
    ],
    warnings: [],
    info: [],
    generatedAt: new Date().toISOString(),
  };
}

let fx: H1Fixture | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let confirmSpy: ReturnType<typeof vi.fn>;
let setStatusSpy: ReturnType<typeof vi.spyOn>;
let createProposalSpy: ReturnType<typeof vi.spyOn>;
const origIsTTY = process.stdin.isTTY;

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
}
function logged(): string {
  return logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  fx = makeFixture();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  // Override the confirm seam (replaced per-test). Default: decline.
  confirmSpy = vi.fn(async () => false);
  _internals.confirm = confirmSpy;
  // Spies that MUST never fire — onboard never approves/applies/creates.
  setStatusSpy = vi.spyOn(inboxStore, 'setStatus');
  createProposalSpy = vi.spyOn(inboxStore, 'createProposal');
  tickSpy.mockClear();
  readinessSpy.mockReset();
});

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  setTty(origIsTTY);
  vi.restoreAllMocks();
});

describe('h7 onboard — guided first-activation walkthrough', () => {
  it('non-interactive (--yes) prints the numbered steps WITHOUT enrolling any repo', async () => {
    expect.hasAssertions();
    readinessSpy.mockResolvedValue(readyReport());
    const repo = fx!.makeRepo();

    const code = await cmdOnboard(['--yes', repo.dir]);

    expect(code).toBe(0);
    // NEVER enrolled — guidance only.
    expect(listEnrolled()).toEqual([]);
    expect(repo.isEnrolled()).toBe(false);
    // No prompt, no dry-run, no live daemon.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(tickSpy).not.toHaveBeenCalled();
    // Printed the numbered activation steps + the inbox pointer.
    const out = logged();
    expect(out).toContain('ashlr preflight');
    expect(out).toContain('ashlr inbox');
    expect(out).toMatch(/--rollback/);
  });

  it('TTY-confirmed flow enrolls exactly ONE repo (listEnrolled length goes 0 → 1)', async () => {
    expect.hasAssertions();
    readinessSpy.mockResolvedValue(readyReport());
    setTty(true);
    confirmSpy.mockResolvedValue(true);
    const repo = fx!.makeRepo();

    expect(listEnrolled()).toEqual([]); // 0 before

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(0);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Exactly ONE repo enrolled — the resolved disposable repo.
    const enrolled = listEnrolled();
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]).toBe(repo.dir);
    expect(repo.isEnrolled()).toBe(true);
  });

  it('declining the confirm enrolls NOTHING (the explicit gate is respected)', async () => {
    expect.hasAssertions();
    readinessSpy.mockResolvedValue(readyReport());
    setTty(true);
    confirmSpy.mockResolvedValue(false);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(0);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(listEnrolled()).toEqual([]);
    // No dry-run when the user declines the enroll gate.
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it('prints a human-readable dry-run PLAN; tick runs ONLY with dryRun:true (never a live run)', async () => {
    expect.hasAssertions();
    readinessSpy.mockResolvedValue(readyReport());
    setTty(true);
    confirmSpy.mockResolvedValue(true);
    const repo = fx!.makeRepo();
    // Seed a backlog so renderDryRunPlan has titles to list.
    seedBacklog(fx!.home, repo.dir, [{ title: 'Fix flaky test' }, { title: 'Bump lodash' }]);

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(0);
    // tick was called — and ONLY ever with dryRun:true (no live daemon).
    expect(tickSpy).toHaveBeenCalled();
    for (const call of tickSpy.mock.calls) {
      expect(call[1]).toEqual({ dryRun: true });
    }
    expect(tickSpy).not.toHaveBeenCalledWith(expect.anything(), { dryRun: false });
    // The PLAN + inbox-review pointer are printed.
    const out = logged();
    expect(out).toMatch(/Dry-run plan/i);
    expect(out).toContain('Fix flaky test');
    expect(out).toContain('ashlr inbox');
  });

  it('stops early (no enroll, no dry-run) when preflight reports a blocker', async () => {
    expect.hasAssertions();
    readinessSpy.mockResolvedValue(blockedReport());
    setTty(true);
    confirmSpy.mockResolvedValue(true);
    const repo = fx!.makeRepo();

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(1); // blocked ⇒ non-zero
    expect(confirmSpy).not.toHaveBeenCalled(); // never prompted to enroll
    expect(listEnrolled()).toEqual([]); // never enrolled
    expect(tickSpy).not.toHaveBeenCalled(); // never dry-ran
    expect(logged()).toContain('~/.ashlr is not writeable'); // surfaced the blocker
  });

  it('ONBOARD-NEVER-AUTO-APPLIES: pending proposals unchanged + working tree unchanged after onboard', async () => {
    expect.hasAssertions();
    readinessSpy.mockResolvedValue(readyReport());
    setTty(true);
    confirmSpy.mockResolvedValue(true);
    const repo = fx!.makeRepo();
    seedBacklog(fx!.home, repo.dir, [{ title: 'Tighten CI' }]);

    const proposalsBefore = listProposals({ status: 'pending' }).length;
    const treeBefore = repo.shasumTree();

    const code = await cmdOnboard([repo.dir]);

    expect(code).toBe(0);
    // No proposal created / approved / applied — the inbox gate is never bypassed.
    expect(createProposalSpy).not.toHaveBeenCalled();
    expect(setStatusSpy).not.toHaveBeenCalled();
    expect(listProposals({ status: 'pending' }).length).toBe(proposalsBefore);
    expect(listProposals({ status: 'applied' })).toEqual([]);
    // Repo working tree is byte-identical (no apply, no live daemon, no push).
    expect(repo.shasumTree()).toBe(treeBefore);
    // And tick was ONLY ever a dry-run.
    for (const call of tickSpy.mock.calls) {
      expect(call[1]).toEqual({ dryRun: true });
    }
  });

  it('renderDryRunPlan is read-only — re-running leaves enrollment + proposals unchanged ($0)', async () => {
    expect.hasAssertions();
    const repo = fx!.makeRepo();
    repo.enroll();
    seedBacklog(fx!.home, repo.dir, [{ title: 'Doc the API' }, { title: 'Add types' }]);

    const enrolledBefore = listEnrolled();
    const pendingBefore = listProposals({ status: 'pending' }).length;

    const cfg = { daemon: { perTickItems: 3 } } as never;
    const plan1 = await renderDryRunPlan(cfg);
    const plan2 = await renderDryRunPlan(cfg);

    // The plan is a human-readable preview, deterministic across runs.
    expect(plan1).toMatch(/Dry-run plan/i);
    expect(plan1).toContain('Doc the API');
    expect(plan2).toBe(plan1);
    // tick called ONLY with dryRun:true; the dry-run shape spends $0.
    expect(tickSpy).toHaveBeenCalled();
    for (const call of tickSpy.mock.calls) {
      expect(call[1]).toEqual({ dryRun: true });
    }
    // Read-only: enrollment + proposals unchanged.
    expect(listEnrolled()).toEqual(enrolledBefore);
    expect(listProposals({ status: 'pending' }).length).toBe(pendingBefore);
    expect(createProposalSpy).not.toHaveBeenCalled();
    expect(setStatusSpy).not.toHaveBeenCalled();
  });
});

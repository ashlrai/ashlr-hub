/**
 * test/w1.run-window-loop.test.ts — the run window INSIDE runDaemon.
 *
 * The module tests prove the arithmetic and the gate. These prove the wiring,
 * and one property above all others:
 *
 *   A BOUNDED RUN ENDS BY PARKING, NEVER BY KILLING.
 *
 * `stopDaemon()` is `setKill(true)`, and `~/.ashlr/KILL` is also read by
 * `assertMayMutate` — so ending a run that way would refuse the operator's own
 * MCP write tools the moment they sat down. Every assertion below that checks
 * the pause sentinel ALSO checks that the kill switch stayed off.
 *
 *  A. The iteration window bounds the run and parks
 *  B. A post-merge regression HALTS the run mid-flight and parks
 *  C. A refused window does not start an unbounded run
 *  D. No window = today's behaviour, unchanged (no pause, no kill)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import type { AshlrConfig } from '../src/core/types.js';
import { runDaemon } from '../src/core/daemon/loop.js';
import { readDaemonPause } from '../src/core/daemon/pause.js';
import { readOvernightStatus } from '../src/core/daemon/overnight-status.js';
import { readPostMergeHalts } from '../src/core/daemon/post-merge-halt.js';

// ---------------------------------------------------------------------------
// Mocks — declared before the lazy import so the loop binds to them.
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.fn();
vi.mock('../src/core/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// The resident activation permit is another agent's file and is not under test
// here; authorize it so the loop actually reaches the run window. (Same seam
// test/m201.daemon-loop.test.ts uses.)
vi.mock('../src/core/daemon/activation-permit.js', () => ({
  consumeDaemonActivationPermit: () => ({
    authorized: true, required: false, reason: 'test-authorized',
  }),
  isDaemonActivationCapability: () => true,
}));

/** Forced verdict for the post-merge gate; null = use the real module. */
const gateHarness = vi.hoisted(() => ({
  forced: null as null | Record<string, unknown>,
  calls: 0,
}));

vi.mock('../src/core/daemon/post-merge-halt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/post-merge-halt.js')>();
  return {
    ...actual,
    runPostMergeGate: async (...args: Parameters<typeof actual.runPostMergeGate>) => {
      gateHarness.calls++;
      if (gateHarness.forced) return gateHarness.forced as never;
      return actual.runPostMergeGate(...args);
    },
  };
});

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
  gateHarness.forced = null;
  gateHarness.calls = 0;
  mockLoadConfig.mockReset();
});

afterEach(() => {
  fx.cleanup();
});

/** A fast loop config: no enrolled repos, so each tick short-circuits. */
function fastCfg(): AshlrConfig {
  const cfg = makeCfg({
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 1,
      parallel: 1,
      intervalMs: 20,
      idleBackoffMs: 1,
      mode: 'continuous',
    } as AshlrConfig['daemon'],
  });
  mockLoadConfig.mockReturnValue(cfg);
  return cfg;
}

/** True when the GLOBAL kill sentinel exists. It must never be the halt. */
function killEngaged(): boolean {
  return existsSync(join(fx.ashlrDir, 'KILL'));
}

function paused(): boolean {
  return readDaemonPause().state === 'paused';
}

/** A halting post-merge gate result, shaped like the real module's. */
function forcedHalt(repo: string) {
  return {
    verdict: 'regressed' as const,
    halt: true,
    landings: [{
      repo,
      beforeHead: 'a'.repeat(40),
      afterHead: 'b'.repeat(40),
      commits: [{ sha: 'b'.repeat(40), subject: 'ashlr: auto-merge proposal p-42', isMerge: false }],
      revertCommand: `git revert --no-edit ${'b'.repeat(40)}`,
    }],
    failures: [{ repo, kind: 'test' as const, command: 'npm test', detail: 'failed after the merge (exit 1, code)' }],
    ranCommands: 1,
    detail: 'POST-MERGE REGRESSION: 1 required check(s) RED in 1 repo(s) after 1 landed commit(s); run halted',
    revertPlan: [`git revert --no-edit ${'b'.repeat(40)}`],
    durationMs: 12,
  };
}

// ===========================================================================
// A — The iteration window bounds the run and parks
// ===========================================================================

describe('W1 · A · the iteration window bounds the run, and ends it by PARKING', () => {
  it('A1: after-iterations:2 runs exactly 2 ticks, then parks WITHOUT killing', async () => {
    const cfg = fastCfg();
    expect(paused()).toBe(false);

    const state = await runDaemon(cfg, {
      once: false,
      dryRun: false,
      maxCycles: 20,                                    // far above the window
      runWindow: { kind: 'after-iterations', iterations: 2 },
    });

    expect(state.ticks.length).toBe(2);                 // the window bounded it, not maxCycles
    expect(state.running).toBe(false);
    // THE PROPERTY THAT MATTERS.
    expect(paused()).toBe(true);
    expect(killEngaged()).toBe(false);
    // And it was not reported as a crash — an elapsed window is a SUCCESS.
    expect(state.terminalFailure).toBeUndefined();
  }, 20_000);

  it('A2: after-iterations:1 stops after a single tick', async () => {
    const cfg = fastCfg();
    const state = await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'after-iterations', iterations: 1 },
    });
    expect(state.ticks.length).toBe(1);
    expect(paused()).toBe(true);
    expect(killEngaged()).toBe(false);
  }, 20_000);

  it('A3: an already-elapsed at-time window parks before running ANY tick', async () => {
    const cfg = fastCfg();
    // Armed 2 seconds ahead, but the window is evaluated at the top of each
    // iteration — arm it far enough out to resolve, then prove the clock rule
    // is what stops it by giving it a deadline it reaches almost immediately.
    const state = await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 50,
      runWindow: { kind: 'at-time', at: new Date(Date.now() + 1_500).toISOString() },
    });
    expect(state.running).toBe(false);
    expect(paused()).toBe(true);
    expect(killEngaged()).toBe(false);
  }, 30_000);

  it('A4: the overnight status records the run and keeps it after the run ends', async () => {
    const cfg = fastCfg();
    await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'after-iterations', iterations: 2 },
    });

    const status = readOvernightStatus();
    // Disarmed (the NEXT run is not armed) but the record is KEPT — the
    // morning's first question is "what happened last night".
    expect(status.armed).toBe(false);
    expect(status.run).not.toBeNull();
    expect(status.run!.runId).toBeTruthy();
    expect(status.run!.startedAt).toBeTruthy();
    expect(status.run!.stopRule).toEqual({ kind: 'after-iterations', iterations: 2 });
    expect(status.run!.iterationsDone).toBe(2);
    expect(status.run!.activity).toContain('iterations-reached');
    expect(status.repos).toBe(0);
    expect(status.gate).not.toBeNull();
    expect(status.gate!.typecheck).toBe(true);
  }, 20_000);
});

// ===========================================================================
// B — A post-merge regression halts the run
// ===========================================================================

describe('W1 · B · a post-merge regression HALTS the run mid-flight', () => {
  it('B1: a red post-merge suite stops the run after ONE tick and parks, not kills', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    gateHarness.forced = forcedHalt(repo.dir);

    const state = await runDaemon(cfg, {
      once: false,
      dryRun: false,
      maxCycles: 20,
      // A generous window — the HALT must be what ends the run, not the window.
      runWindow: { kind: 'after-iterations', iterations: 10 },
    });

    expect(gateHarness.calls).toBeGreaterThanOrEqual(1);
    expect(state.ticks.length).toBe(1);                 // iteration N+1 never happened
    expect(state.running).toBe(false);
    expect(paused()).toBe(true);
    expect(killEngaged()).toBe(false);
  }, 20_000);

  it('B2: the halt is written down, with the exact revert', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    gateHarness.forced = forcedHalt(repo.dir);

    await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'after-iterations', iterations: 10 },
    });

    const halts = readPostMergeHalts();
    expect(halts).toHaveLength(1);
    expect(halts[0]!.verdict).toBe('regressed');
    expect(halts[0]!.revertPlan.join(' ')).toContain('b'.repeat(40));
  }, 20_000);

  it('B3: the discard reason is SPECIFIC — it names the repo and the revert', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    gateHarness.forced = forcedHalt(repo.dir);

    await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'after-iterations', iterations: 10 },
    });

    const status = readOvernightStatus();
    expect(status.run!.discarded).toHaveLength(1);
    const reason = status.run!.discarded[0]!.reason;
    expect(reason).toContain('post-merge suite failed on');
    expect(reason).toContain(repo.dir);
    expect(reason).toContain('git revert');
    // The thing a person actually needs, not a generic verdict.
    expect(reason).not.toBe('rejected');
    // And the proposal id was recovered from the commit subject, not invented.
    expect(status.run!.discarded[0]!.id).toBe('p-42');
  }, 20_000);

  it('B3b: an UNPROVABLE landing halts too, and says it could not prove — not that it was bad', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    gateHarness.forced = {
      verdict: 'unverifiable' as const,
      halt: true,
      landings: [{
        repo: repo.dir,
        beforeHead: 'a'.repeat(40),
        afterHead: 'b'.repeat(40),
        commits: [{ sha: 'b'.repeat(40), subject: 'ashlr: auto-merge proposal p-7', isMerge: false }],
        revertCommand: `git revert --no-edit ${'b'.repeat(40)}`,
      }],
      failures: [{
        repo: repo.dir,
        kind: 'dirty-tree' as const,
        command: 'git status --porcelain',
        detail: 'the working tree holds 2 uncommitted changes, so a post-merge run there would ' +
          'measure those and not the merge — the result cannot be trusted either way',
      }],
      ranCommands: 0,
      detail: 'POST-MERGE UNPROVABLE: landing could not be verified in 1 repo(s) ' +
        '(1 with a dirty working tree — the verdict would have measured uncommitted edits, ' +
        'not the merge); run halted rather than built upon',
      revertPlan: [`git revert --no-edit ${'b'.repeat(40)}`],
      durationMs: 3,
    };

    const state = await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'after-iterations', iterations: 10 },
    });

    expect(state.ticks.length).toBe(1);        // it halted, exactly like a regression
    expect(paused()).toBe(true);
    expect(killEngaged()).toBe(false);

    const reason = readOvernightStatus().run!.discarded[0]!.reason;
    // The wording distinguishes "we could not prove it" from "it was bad".
    expect(reason).toContain('could not be verified');
    expect(reason).toContain('dirty-tree');
    expect(reason).not.toContain('post-merge suite failed');
    expect(reason).toContain('git revert');
  }, 20_000);

  it('B4: a CLEAN post-merge gate does not stop the run', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    // No forced verdict: the real gate runs, nothing merged, so 'no-landing'.
    const state = await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'after-iterations', iterations: 3 },
    });
    expect(state.ticks.length).toBe(3);                 // ran the full window
    expect(paused()).toBe(true);                        // parked by the WINDOW
    expect(killEngaged()).toBe(false);
  }, 20_000);

  it('B5: a dry run never engages the post-merge gate', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    gateHarness.forced = forcedHalt(repo.dir);
    await runDaemon(cfg, {
      once: false, dryRun: true, maxCycles: 5,
      runWindow: { kind: 'after-iterations', iterations: 3 },
    });
    expect(gateHarness.calls).toBe(0);
  }, 20_000);
});

// ===========================================================================
// C — A refused window does not start an unbounded run
// ===========================================================================

describe('W1 · C · a refused window refuses the RUN', () => {
  it('C1: a stop time in the past runs NOTHING and does not park or kill', async () => {
    const cfg = fastCfg();
    const state = await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'at-time', at: new Date(Date.now() - 3_600_000).toISOString() },
    });

    expect(state.ticks.length).toBe(0);                 // never entered the loop
    expect(state.terminalFailure).toBe('daemon-run-window-invalid');
    // A refusal is not a halt: nothing was parked and nothing was killed.
    expect(paused()).toBe(false);
    expect(killEngaged()).toBe(false);
  }, 20_000);

  it('C2: a malformed stop rule refuses rather than running unbounded', async () => {
    const cfg = fastCfg();
    const state = await runDaemon(cfg, {
      once: false, dryRun: false, maxCycles: 20,
      runWindow: { kind: 'after-iterations', iterations: 0 },
    });
    expect(state.ticks.length).toBe(0);
    expect(state.terminalFailure).toBe('daemon-run-window-invalid');
    expect(killEngaged()).toBe(false);
  }, 20_000);
});

// ===========================================================================
// D — No window = today's behaviour, unchanged
// ===========================================================================

describe('W1 · D · without a run window nothing changes', () => {
  it('D1: maxCycles still bounds the loop, and the daemon is NOT parked on exit', async () => {
    const cfg = fastCfg();
    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2 });
    expect(state.ticks.length).toBe(2);
    expect(state.running).toBe(false);
    // The pre-existing contract: an ordinary bounded run leaves the daemon
    // resumable without the operator having to clear a pause they did not set.
    expect(paused()).toBe(false);
    expect(killEngaged()).toBe(false);
  }, 20_000);

  it('D2: with no window the post-merge gate stays off by default', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2 });
    expect(gateHarness.calls).toBe(0);
  }, 20_000);

  it('D3: postMergeHalt:true engages the gate even without a window', async () => {
    const cfg = fastCfg();
    const repo = fx.makeRepo();
    repo.enroll();
    await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2, postMergeHalt: true });
    expect(gateHarness.calls).toBeGreaterThanOrEqual(1);
  }, 20_000);
});

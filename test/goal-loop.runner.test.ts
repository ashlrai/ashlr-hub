/**
 * Goal Loop driver tests (see docs/MILESTONE-CONTRACT.md).
 *
 * Every test injects a FAKE RunMilestoneFn — no real agent spawns, no model, no
 * network, no ~/.ashlr. Roadmaps live in fresh os.tmpdir() dirs and are cleaned
 * up. The suite proves the contract invariants: CONTEXT-RESET (only a small
 * result crosses back), DURABLE-RESUME, SKIP-DONE, CLEAN-PAUSE, BYTE-FAITHFUL
 * TICKS, and NEVER-THROWS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGoalLoop } from '../src/core/goal-loop/runner.js';
import { loadState, statePath } from '../src/core/goal-loop/state.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { MilestoneDoc, MilestoneResult, RunMilestoneFn } from '../src/core/goal-loop/types.js';

// Minimal cfg — the fake executor never reads it.
const cfg = {} as AshlrConfig;

let dir: string;

function milestoneFile(id: string, title: string, eol = '\n'): string {
  return [
    `# ${id} — ${title}`,
    '',
    `- [ ] ${id}.1 first step`,
    '      Done when: it builds',
    `- [ ] ${id}.2 second step`,
    '      Done when: tests pass',
    '',
    '## Acceptance checklist (gate)',
    '- [ ] everything green',
    '',
  ].join(eol);
}

/** Write a 2-milestone roadmap (M0, M1) into `dir`. Returns the index path. */
function seedRoadmap(eol = '\n'): void {
  writeFileSync(join(dir, 'M0.md'), milestoneFile('M0', 'First', eol), 'utf8');
  writeFileSync(join(dir, 'M1.md'), milestoneFile('M1', 'Second', eol), 'utf8');
  writeFileSync(
    join(dir, 'roadmap.md'),
    ['# Roadmap', '', '- [M0](M0.md)', '- [M1](M1.md)', ''].join(eol),
    'utf8',
  );
}

/** A fake executor that returns a scripted result per milestone id. */
function fakeExecutor(byId: Record<string, Partial<MilestoneResult>>): RunMilestoneFn {
  return async (doc: MilestoneDoc): Promise<MilestoneResult> => {
    const r = byId[doc.id] ?? {};
    return {
      milestone: doc.id,
      status: r.status ?? 'done',
      gate_passed: r.gate_passed ?? true,
      steps_completed: r.steps_completed ?? doc.steps.map((s) => s.id),
      blocked_on: r.blocked_on ?? null,
      summary: r.summary ?? `did ${doc.id}`,
    };
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ashlr-goalloop-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('runGoalLoop — happy path', () => {
  it('runs every milestone, ticks steps, and reports allComplete', async () => {
    seedRoadmap();
    const summary = await runGoalLoop({ dir, cfg, runMilestone: fakeExecutor({}) });

    expect(summary.allComplete).toBe(true);
    expect(summary.stoppedAt).toBeNull();
    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['done', 'done']);

    // Steps ticked back into both files.
    expect(readFileSync(join(dir, 'M0.md'), 'utf8')).toContain('- [x] M0.1');
    expect(readFileSync(join(dir, 'M1.md'), 'utf8')).toContain('- [x] M1.2');

    // State persisted both as complete.
    const state = loadState(dir, join(dir, 'roadmap.md'));
    expect(state.milestones['M0']?.status).toBe('done');
    expect(state.milestones['M1']?.gate_passed).toBe(true);
    expect(existsSync(statePath(dir))).toBe(true);
  });
});

describe('runGoalLoop — clean pause', () => {
  it('stops at a needs_human milestone without advancing', async () => {
    seedRoadmap();
    const summary = await runGoalLoop({
      dir,
      cfg,
      runMilestone: fakeExecutor({
        M0: { status: 'needs_human', gate_passed: false, blocked_on: 'upload the dataset by hand', steps_completed: ['M0.1'] },
      }),
    });

    expect(summary.stoppedAt).toBe('M0');
    expect(summary.stopReason).toBe('upload the dataset by hand');
    expect(summary.allComplete).toBe(false);
    // M1 never ran.
    expect(summary.outcomes.map((o) => o.milestone)).toEqual(['M0']);

    const state = loadState(dir, join(dir, 'roadmap.md'));
    expect(state.milestones['M0']?.status).toBe('needs_human');
    expect(state.milestones['M1']).toBeUndefined();
    // Partial step still got ticked + recorded.
    expect(readFileSync(join(dir, 'M0.md'), 'utf8')).toContain('- [x] M0.1');
    expect(state.milestones['M0']?.steps_done).toEqual(['M0.1']);
  });
});

describe('runGoalLoop — durable resume', () => {
  it('a second run skips the completed milestone and continues (simulated crash)', async () => {
    seedRoadmap();

    // Run 1: M0 done, M1 blocked → loop stops at M1.
    const first = await runGoalLoop({
      dir,
      cfg,
      runMilestone: fakeExecutor({ M1: { status: 'blocked', gate_passed: false, blocked_on: 'flaky test' } }),
    });
    expect(first.stoppedAt).toBe('M1');

    // Run 2 (fresh state load = cold resume): M0 is skipped, M1 now succeeds.
    const second = await runGoalLoop({ dir, cfg, runMilestone: fakeExecutor({}) });
    expect(second.outcomes.find((o) => o.milestone === 'M0')?.outcome).toBe('skipped');
    expect(second.outcomes.find((o) => o.milestone === 'M1')?.outcome).toBe('done');
    expect(second.allComplete).toBe(true);
  });

  it('skip-done: a completed milestone is never re-dispatched on resume', async () => {
    seedRoadmap();
    await runGoalLoop({ dir, cfg, runMilestone: fakeExecutor({ M1: { status: 'blocked', gate_passed: false } }) });

    const dispatched: string[] = [];
    const tracking: RunMilestoneFn = async (doc) => {
      dispatched.push(doc.id);
      return { milestone: doc.id, status: 'done', gate_passed: true, steps_completed: [], blocked_on: null, summary: '' };
    };
    await runGoalLoop({ dir, cfg, runMilestone: tracking });
    expect(dispatched).toEqual(['M1']); // M0 skipped, only M1 re-dispatched
  });
});

describe('runGoalLoop — robustness', () => {
  it('never throws when the executor throws; records a blocked stop', async () => {
    seedRoadmap();
    const summary = await runGoalLoop({
      dir,
      cfg,
      runMilestone: async () => {
        throw new Error('boom');
      },
    });
    expect(summary.stoppedAt).toBe('M0');
    expect(summary.outcomes[0]?.outcome).toBe('blocked');
    expect(summary.stopReason).toContain('boom');
  });

  it('treats a null result as a blocked stop', async () => {
    seedRoadmap();
    const summary = await runGoalLoop({ dir, cfg, runMilestone: async () => null });
    expect(summary.outcomes[0]?.outcome).toBe('blocked');
    expect(summary.allComplete).toBe(false);
  });

  it('dry-run does not tick any checkboxes', async () => {
    seedRoadmap();
    await runGoalLoop({
      dir,
      cfg,
      dryRun: true,
      runMilestone: fakeExecutor({ M0: { status: 'in_progress', gate_passed: false } }),
    });
    expect(readFileSync(join(dir, 'M0.md'), 'utf8')).toContain('- [ ] M0.1');
  });

  it('preserves CRLF line endings when ticking (byte-faithful)', async () => {
    seedRoadmap('\r\n');
    await runGoalLoop({ dir, cfg, runMilestone: fakeExecutor({ M1: { status: 'blocked', gate_passed: false } }) });
    const m0 = readFileSync(join(dir, 'M0.md'), 'utf8');
    expect(m0).toContain('- [x] M0.1');
    expect(m0).toContain('\r\n'); // CRLF survived the tick
    expect(m0).not.toMatch(/[^\r]\n/); // no bare LF introduced
  });
});

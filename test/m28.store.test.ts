/**
 * M28 goals store tests — hermetic, all operations in os.tmpdir().
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a tmp dir so goalsDir()
 * lands under the tmp dir, NEVER the real ~/.ashlr. No real portfolio, no
 * swarm, no network — this is pure FS persistence under ~/.ashlr/goals.
 *
 * Covers:
 *   - goalsDir(): resolves under HOME/.ashlr/goals
 *   - goal CRUD round-trip (createGoal / loadGoal / saveGoal / deleteGoal)
 *   - milestone add / status (+ swarmId/proposalId link) / reorder / pause /
 *     resume / skip
 *   - listGoals: newest-first, status filtering, empty-state, MAX_LIST bound
 *   - write containment: ONLY ~/.ashlr/goals is touched (no CONFIG, no repo)
 *   - read paths never throw on a missing dir / corrupt file
 *   - deterministic ids + injectable timestamps (no nondeterminism)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Goal, MilestoneStatus, GoalStatus } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Override HOME before any store module is imported so goalsDir() resolves
// under the tmp dir, not the real ~/.ashlr.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m28-store-'));
}

let store: typeof import('../src/core/goals/store.js');

async function ensureImported(): Promise<void> {
  if (!store) {
    store = await import('../src/core/goals/store.js');
  }
}

beforeEach(async () => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic ISO timestamp seam for tests. */
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

function goalsDirAbs(): string {
  return path.join(tmpHome, '.ashlr', 'goals');
}

/** Recursively list relative file paths under a dir (or [] if absent). */
function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// goalsDir
// ---------------------------------------------------------------------------

describe('M28 goals store — goalsDir', () => {
  it('resolves under HOME/.ashlr/goals', () => {
    expect(store.goalsDir()).toBe(goalsDirAbs());
  });
});

// ---------------------------------------------------------------------------
// CRUD round-trip
// ---------------------------------------------------------------------------

describe('M28 goals store — CRUD', () => {
  it('createGoal persists a planning goal and loadGoal reads it back', () => {
    const g = store.createGoal('Ship the billing rewrite', { now: T0 });
    expect(g.objective).toBe('Ship the billing rewrite');
    expect(g.status).toBe('planning');
    expect(g.milestones).toEqual([]);
    expect(g.project).toBeNull();
    expect(g.createdAt).toBe(T0);
    expect(g.updatedAt).toBe(T0);

    const loaded = store.loadGoal(g.id);
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(g);

    // It must have landed under ~/.ashlr/goals/<id>.json and nowhere else.
    expect(fs.existsSync(path.join(goalsDirAbs(), `${g.id}.json`))).toBe(true);
  });

  it('createGoal id is deterministic in the objective (stable stem)', () => {
    const a = store.createGoal('Same objective text', { now: T0 });
    const b = store.createGoal('Same objective text', { now: T1 });
    expect(a.id).toBe(b.id); // slug + content hash — stable
  });

  it('createGoal carries a provided (already-enrolled) project path', () => {
    const g = store.createGoal('Bound goal', { project: '/abs/repo', now: T0 });
    expect(g.project).toBe('/abs/repo');
    expect(store.loadGoal(g.id)?.project).toBe('/abs/repo');
  });

  it('saveGoal round-trips arbitrary edits and bumps updatedAt', () => {
    const g = store.createGoal('Edit me', { now: T0 });
    g.objective = 'Edited objective';
    store.saveGoal(g, { now: T1 });
    const loaded = store.loadGoal(g.id);
    expect(loaded?.objective).toBe('Edited objective');
    expect(loaded?.updatedAt).toBe(T1);
    expect(loaded?.createdAt).toBe(T0);
  });

  it('loadGoal returns null for an unknown id', () => {
    expect(store.loadGoal('does-not-exist-aaaaaa')).toBeNull();
  });

  it('loadGoal returns null for a path-traversal id (never throws)', () => {
    expect(store.loadGoal('../escape')).toBeNull();
    expect(store.loadGoal('a/b')).toBeNull();
  });

  it('loadGoal returns null for corrupt JSON (never throws)', () => {
    const g = store.createGoal('Corruptible', { now: T0 });
    fs.writeFileSync(path.join(goalsDirAbs(), `${g.id}.json`), '{ not json', 'utf8');
    expect(store.loadGoal(g.id)).toBeNull();
  });

  it('deleteGoal removes the file and is idempotent', () => {
    const g = store.createGoal('Delete me', { now: T0 });
    expect(store.loadGoal(g.id)).not.toBeNull();
    store.deleteGoal(g.id);
    expect(store.loadGoal(g.id)).toBeNull();
    // Second delete is a no-op (never throws).
    expect(() => store.deleteGoal(g.id)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listGoals
// ---------------------------------------------------------------------------

describe('M28 goals store — listGoals', () => {
  it('returns [] on empty state (dir absent), never throws', () => {
    expect(store.listGoals()).toEqual([]);
  });

  it('lists goals newest-first by updatedAt', () => {
    const a = store.createGoal('Alpha objective', { now: T0 });
    const b = store.createGoal('Bravo objective', { now: T1 });
    const c = store.createGoal('Charlie objective', { now: T2 });
    const ids = store.listGoals().map((g) => g.id);
    expect(ids).toEqual([c.id, b.id, a.id]);
  });

  it('filters by status', () => {
    const planning = store.createGoal('Still planning', { now: T0 });
    const active = store.createGoal('Active one', { now: T1 });
    // Give `active` a milestone so its rolled status becomes 'active'.
    store.addMilestone(active.id, { title: 'M', detail: 'd' }, { now: T1 });

    const planningList = store.listGoals({ status: 'planning' });
    expect(planningList.map((g) => g.id)).toEqual([planning.id]);

    const activeList = store.listGoals({ status: 'active' });
    expect(activeList.map((g) => g.id)).toEqual([active.id]);
  });

  it('skips .tmp sidecars and corrupt files', () => {
    const g = store.createGoal('Good goal', { now: T0 });
    fs.writeFileSync(path.join(goalsDirAbs(), 'junk.json'), 'not json', 'utf8');
    fs.writeFileSync(path.join(goalsDirAbs(), 'inflight.json.tmp'), '{}', 'utf8');
    const ids = store.listGoals().map((x) => x.id);
    expect(ids).toEqual([g.id]);
  });
});

// ---------------------------------------------------------------------------
// Milestone mutators
// ---------------------------------------------------------------------------

describe('M28 goals store — milestone mutators', () => {
  it('addMilestone appends pending milestones with increasing order', () => {
    const g = store.createGoal('Plan me', { now: T0 });
    const g1 = store.addMilestone(g.id, { title: 'First', detail: 'd1' }, { now: T1 });
    const g2 = store.addMilestone(g.id, { title: 'Second', detail: 'd2' }, { now: T1 });
    expect(g1).not.toBeNull();
    expect(g2?.milestones.map((m) => m.title)).toEqual(['First', 'Second']);
    expect(g2?.milestones.map((m) => m.order)).toEqual([0, 1]);
    for (const m of g2!.milestones) {
      expect(m.status).toBe<MilestoneStatus>('pending');
      expect(m.specId).toBeNull();
      expect(m.swarmId).toBeNull();
      expect(m.proposalId).toBeNull();
    }
    // Adding milestones moves the goal from planning -> active.
    expect(g2?.status).toBe<GoalStatus>('active');
  });

  it('addMilestone returns null for an unknown goal', () => {
    expect(store.addMilestone('nope-aaaaaa', { title: 't', detail: 'd' })).toBeNull();
  });

  it('milestone ids are unique within a goal even for duplicate titles', () => {
    const g = store.createGoal('Dup titles', { now: T0 });
    store.addMilestone(g.id, { title: 'Same', detail: 'a' }, { now: T1 });
    const g2 = store.addMilestone(g.id, { title: 'Same', detail: 'b' }, { now: T1 });
    const ids = g2!.milestones.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('updateMilestoneStatus sets status and links swarmId/proposalId (record only)', () => {
    const g = store.createGoal('Track me', { now: T0 });
    const withM = store.addMilestone(g.id, { title: 'Work', detail: 'd' }, { now: T1 });
    const mId = withM!.milestones[0]!.id;

    const inProg = store.updateMilestoneStatus(g.id, mId, 'in-progress', { now: T2 });
    expect(inProg!.milestones[0]!.status).toBe('in-progress');

    const proposed = store.updateMilestoneStatus(g.id, mId, 'proposed', {
      swarmId: 'swarm-123',
      proposalId: 'prop-456',
      now: T2,
    });
    const m = proposed!.milestones[0]!;
    expect(m.status).toBe('proposed');
    expect(m.swarmId).toBe('swarm-123');
    expect(m.proposalId).toBe('prop-456');
    expect(m.updatedAt).toBe(T2);

    // Persisted, not just in-memory.
    expect(store.loadGoal(g.id)?.milestones[0]?.proposalId).toBe('prop-456');
  });

  it('updateMilestoneStatus returns null for unknown goal/milestone', () => {
    const g = store.createGoal('X', { now: T0 });
    expect(store.updateMilestoneStatus('nope', 'm', 'done')).toBeNull();
    expect(store.updateMilestoneStatus(g.id, 'no-such-milestone', 'done')).toBeNull();
  });

  it('goal rolls to done when every non-skipped milestone is done', () => {
    const g = store.createGoal('Finish me', { now: T0 });
    store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    store.addMilestone(g.id, { title: 'B', detail: 'd' }, { now: T1 });
    const ms = store.loadGoal(g.id)!.milestones;
    store.updateMilestoneStatus(g.id, ms[0]!.id, 'done', { now: T2 });
    const cur = store.updateMilestoneStatus(g.id, ms[1]!.id, 'done', { now: T2 });
    expect(cur!.status).toBe<GoalStatus>('done');
  });

  it('reorderMilestones rewrites order and keeps unlisted ids after listed', () => {
    const g = store.createGoal('Reorder', { now: T0 });
    store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    store.addMilestone(g.id, { title: 'B', detail: 'd' }, { now: T1 });
    store.addMilestone(g.id, { title: 'C', detail: 'd' }, { now: T1 });
    const before = store.loadGoal(g.id)!.milestones;
    const [aId, bId, cId] = before.map((m) => m.id);

    // Put C first, then explicitly B; A is unlisted (keeps relative order, last).
    const after = store.reorderMilestones(g.id, [cId!, bId!], { now: T2 });
    expect(after!.milestones.map((m) => m.id)).toEqual([cId, bId, aId]);
    expect(after!.milestones.map((m) => m.order)).toEqual([0, 1, 2]);
  });

  it('clearMilestones empties the plan and re-rolls status to planning (M28 regression)', () => {
    const g = store.createGoal('Clearable', { now: T0 });
    store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    store.addMilestone(g.id, { title: 'B', detail: 'd' }, { now: T1 });
    expect(store.loadGoal(g.id)!.milestones.length).toBe(2);

    const cleared = store.clearMilestones(g.id, { now: T2 });
    expect(cleared!.milestones).toEqual([]);
    expect(cleared!.status).toBe<GoalStatus>('planning');
    expect(store.clearMilestones('no-such-goal')).toBeNull();
  });

  it('resumeMilestone recovers a "blocked" milestone back to pending (M28 regression)', () => {
    const g = store.createGoal('Recoverable', { now: T0 });
    const withM = store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    const mId = withM!.milestones[0]!.id;
    store.updateMilestoneStatus(g.id, mId, 'blocked', { now: T2 });
    expect(store.loadGoal(g.id)!.milestones[0]!.status).toBe<MilestoneStatus>('blocked');

    const resumed = store.resumeMilestone(g.id, mId, { now: T2 });
    expect(resumed!.milestones[0]!.status).toBe<MilestoneStatus>('pending');
  });

  it('pauseMilestone(milestoneId) pauses one milestone; whole-goal pause sets goal.status', () => {
    const g = store.createGoal('Pausable', { now: T0 });
    const withM = store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    const mId = withM!.milestones[0]!.id;

    const oneP = store.pauseMilestone(g.id, mId, { now: T2 });
    expect(oneP!.milestones[0]!.status).toBe<MilestoneStatus>('paused');
    // Milestone-level pause does not pin goal.status.
    expect(oneP!.status).toBe<GoalStatus>('active');

    const wholeP = store.pauseMilestone(g.id, undefined, { now: T2 });
    expect(wholeP!.status).toBe<GoalStatus>('paused');
  });

  it('resumeMilestone reverses pause (milestone -> pending; goal un-pins)', () => {
    const g = store.createGoal('Resumable', { now: T0 });
    const withM = store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    const mId = withM!.milestones[0]!.id;

    store.pauseMilestone(g.id, mId, { now: T2 });
    const resumed = store.resumeMilestone(g.id, mId, { now: T2 });
    expect(resumed!.milestones[0]!.status).toBe<MilestoneStatus>('pending');

    store.pauseMilestone(g.id, undefined, { now: T2 });
    expect(store.loadGoal(g.id)!.status).toBe<GoalStatus>('paused');
    const goalResumed = store.resumeMilestone(g.id, undefined, { now: T2 });
    expect(goalResumed!.status).toBe<GoalStatus>('active');
  });

  it('recoverStaleGoalLanes resets only stale proposal-less in-progress milestones', () => {
    const stale = store.createGoal('Stale lane', { project: '/abs/repo', now: T0 });
    const staleWithM = store.addMilestone(stale.id, { title: 'Stale', detail: 'd' }, { now: T0 });
    const staleM = staleWithM!.milestones[0]!.id;
    store.updateMilestoneStatus(stale.id, staleM, 'in-progress', {
      swarmId: 'old-swarm',
      now: T0,
    });

    const linked = store.createGoal('Linked lane', { project: '/abs/repo', now: T0 });
    const linkedWithM = store.addMilestone(linked.id, { title: 'Linked', detail: 'd' }, { now: T0 });
    const linkedM = linkedWithM!.milestones[0]!.id;
    store.updateMilestoneStatus(linked.id, linkedM, 'in-progress', {
      swarmId: 'linked-swarm',
      proposalId: 'prop-live',
      now: T0,
    });

    const young = store.createGoal('Young lane', { project: '/abs/repo', now: T1 });
    const youngWithM = store.addMilestone(young.id, { title: 'Young', detail: 'd' }, { now: T1 });
    const youngM = youngWithM!.milestones[0]!.id;
    store.updateMilestoneStatus(young.id, youngM, 'in-progress', { now: T1 });

    const result = store.recoverStaleGoalLanes({ now: T2, staleMs: 36 * 60 * 60 * 1000, limit: 5 });

    expect(result).toMatchObject({
      dryRun: false,
      scannedGoals: 3,
      eligible: 1,
      recovered: 1,
    });
    expect(result.lanes).toEqual([
      expect.objectContaining({
        goalId: stale.id,
        milestoneId: staleM,
        project: '/abs/repo',
        title: 'Stale',
        dryRun: false,
      }),
    ]);
    const recovered = store.loadGoal(stale.id)!.milestones[0]!;
    expect(recovered.status).toBe<MilestoneStatus>('pending');
    expect(recovered.swarmId).toBeNull();
    expect(recovered.proposalId).toBeNull();
    expect(recovered.updatedAt).toBe(T2);

    const stillLinked = store.loadGoal(linked.id)!.milestones[0]!;
    expect(stillLinked.status).toBe<MilestoneStatus>('in-progress');
    expect(stillLinked.proposalId).toBe('prop-live');
    expect(store.loadGoal(young.id)!.milestones[0]!.status).toBe<MilestoneStatus>('in-progress');
  });

  it('recoverStaleGoalLanes dry-run reports lanes without mutating them', () => {
    const g = store.createGoal('Dry run stale lane', { project: '/abs/repo', now: T0 });
    const withM = store.addMilestone(g.id, { title: 'Dry', detail: 'd' }, { now: T0 });
    const mId = withM!.milestones[0]!.id;
    store.updateMilestoneStatus(g.id, mId, 'in-progress', { swarmId: 'old-swarm', now: T0 });

    const result = store.recoverStaleGoalLanes({ now: T2, staleMs: 1, dryRun: true });

    expect(result.recovered).toBe(0);
    expect(result.eligible).toBe(1);
    expect(result.lanes).toEqual([
      expect.objectContaining({ goalId: g.id, milestoneId: mId, dryRun: true }),
    ]);
    const stillStale = store.loadGoal(g.id)!.milestones[0]!;
    expect(stillStale.status).toBe<MilestoneStatus>('in-progress');
    expect(stillStale.swarmId).toBe('old-swarm');
  });

  it('skipMilestone marks skipped and excludes it from the done roll-up', () => {
    const g = store.createGoal('Skippable', { now: T0 });
    store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    store.addMilestone(g.id, { title: 'B', detail: 'd' }, { now: T1 });
    const ms = store.loadGoal(g.id)!.milestones;

    store.skipMilestone(g.id, ms[1]!.id, { now: T2 });
    // Complete the only non-skipped milestone -> goal is done.
    const cur = store.updateMilestoneStatus(g.id, ms[0]!.id, 'done', { now: T2 });
    expect(cur!.milestones.find((m) => m.id === ms[1]!.id)!.status).toBe('skipped');
    expect(cur!.status).toBe<GoalStatus>('done');
  });
});

// ---------------------------------------------------------------------------
// Write containment — ONLY ~/.ashlr/goals is ever touched.
// ---------------------------------------------------------------------------

describe('M28 goals store — write containment', () => {
  it('all mutations land exclusively under ~/.ashlr/goals (no CONFIG, no repo)', () => {
    const g = store.createGoal('Contained', { now: T0 });
    const withM = store.addMilestone(g.id, { title: 'A', detail: 'd' }, { now: T1 });
    const mId = withM!.milestones[0]!.id;
    store.updateMilestoneStatus(g.id, mId, 'proposed', {
      swarmId: 's',
      proposalId: 'p',
      now: T2,
    });
    store.pauseMilestone(g.id, mId, { now: T2 });
    store.resumeMilestone(g.id, mId, { now: T2 });
    store.skipMilestone(g.id, mId, { now: T2 });

    // The ONLY thing under ~/.ashlr is the goals directory.
    const ashlr = path.join(tmpHome, '.ashlr');
    const topEntries = fs.readdirSync(ashlr).sort();
    expect(topEntries).toEqual(['goals']);

    // And under goals, only the goal's JSON (no .tmp left behind).
    const files = walk(goalsDirAbs());
    expect(files).toEqual([`${g.id}.json`]);

    // No config file was written.
    expect(fs.existsSync(path.join(ashlr, 'config.json'))).toBe(false);
  });

  it('read paths (loadGoal/listGoals) do not create or mutate any files', () => {
    // Cold reads against an empty HOME create nothing.
    expect(store.listGoals()).toEqual([]);
    expect(store.loadGoal('anything-aaaaaa')).toBeNull();
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism — a fully-stamped goal has no hidden nondeterminism.
// ---------------------------------------------------------------------------

describe('M28 goals store — determinism', () => {
  it('two runs with the same objective + clock produce identical records', () => {
    const a = store.createGoal('Deterministic objective', { now: T0 });
    store.deleteGoal(a.id);
    const b = store.createGoal('Deterministic objective', { now: T0 });
    const norm = (g: Goal): Goal => ({ ...g, milestones: g.milestones });
    expect(norm(a)).toEqual(norm(b));
  });
});

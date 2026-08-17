import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addMilestone,
  claimGoalMilestoneIfCurrent,
  createGoal,
  deleteGoal,
  goalSnapshotDigest,
  loadGoal,
  saveGoal,
} from '../src/core/goals/store.js';

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const homes: string[] = [];

function isolateHome(): string {
  const home = join(tmpdir(), `ashlr-m516-cas-${process.pid}-${homes.length}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  homes.push(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return home;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = originalUserProfile;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('M516 atomic signed goal generation claim', () => {
  it('refuses a stale digest without mutating the milestone', () => {
    isolateHome();
    const goal = createGoal('one target', {
      project: '/tmp/enrolled-project',
      now: '2026-08-16T19:00:00.000Z',
    });
    const planned = addMilestone(goal.id, { title: 'Implement', detail: 'Implement' }, {
      now: '2026-08-16T19:01:00.000Z',
    })!;
    const result = claimGoalMilestoneIfCurrent({
      goalId: goal.id,
      milestoneId: planned.milestones[0]!.id,
      expectedGoalDigest: '0'.repeat(64),
    });
    expect(result).toEqual({ claimed: false, reason: 'goal-snapshot-drifted' });
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('pending');
  });

  it('claims exactly the signed current milestone and makes the digest single-use', () => {
    isolateHome();
    const goal = createGoal('one current target', {
      project: '/tmp/enrolled-project',
      now: '2026-08-16T19:00:00.000Z',
    });
    const planned = addMilestone(goal.id, { title: 'Implement', detail: 'Implement' }, {
      now: '2026-08-16T19:01:00.000Z',
    })!;
    const digest = goalSnapshotDigest(planned);
    const first = claimGoalMilestoneIfCurrent({
      goalId: goal.id,
      milestoneId: planned.milestones[0]!.id,
      expectedGoalDigest: digest,
      now: '2026-08-16T19:02:00.000Z',
    });
    expect(first.claimed).toBe(true);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('in-progress');
    expect(claimGoalMilestoneIfCurrent({
      goalId: goal.id,
      milestoneId: planned.milestones[0]!.id,
      expectedGoalDigest: digest,
    })).toMatchObject({ claimed: false, reason: 'goal-snapshot-drifted' });
  });

  it('rejects an ordinary stale read-modify-write after it waits behind a claim', () => {
    isolateHome();
    const goal = createGoal('protect against stale overwrite', {
      project: '/tmp/enrolled-project',
      now: '2026-08-16T19:00:00.000Z',
    });
    const planned = addMilestone(goal.id, { title: 'Implement', detail: 'Implement' }, {
      now: '2026-08-16T19:01:00.000Z',
    })!;
    const staleOrdinaryWriter = loadGoal(goal.id)!;
    const digest = goalSnapshotDigest(planned);
    expect(claimGoalMilestoneIfCurrent({
      goalId: goal.id,
      milestoneId: planned.milestones[0]!.id,
      expectedGoalDigest: digest,
      now: '2026-08-16T19:02:00.000Z',
    }).claimed).toBe(true);

    staleOrdinaryWriter.objective = 'stale overwrite';
    expect(saveGoal(staleOrdinaryWriter, { now: '2026-08-16T19:03:00.000Z' })).toBe(false);
    const persisted = loadGoal(goal.id)!;
    expect(persisted.objective).toBe('protect against stale overwrite');
    expect(persisted.milestones[0]?.status).toBe('in-progress');
  });

  it('does not let a stale update resurrect a goal deleted after the read', () => {
    isolateHome();
    const created = createGoal('delete wins over stale update', {
      project: '/tmp/enrolled-project',
      now: '2026-08-16T19:00:00.000Z',
    });
    const stale = loadGoal(created.id)!;
    deleteGoal(created.id);

    stale.objective = 'resurrected stale goal';
    expect(saveGoal(stale, { now: '2026-08-16T19:01:00.000Z' })).toBe(false);
    expect(loadGoal(created.id)).toBeNull();
  });

  it('does not let a claimed snapshot recreate a goal deleted after the claim', () => {
    isolateHome();
    const created = createGoal('delete wins after signed claim', {
      project: '/tmp/enrolled-project',
      now: '2026-08-16T19:00:00.000Z',
    });
    const planned = addMilestone(created.id, { title: 'Implement', detail: 'Implement' }, {
      now: '2026-08-16T19:01:00.000Z',
    })!;
    const claim = claimGoalMilestoneIfCurrent({
      goalId: created.id,
      milestoneId: planned.milestones[0]!.id,
      expectedGoalDigest: goalSnapshotDigest(planned),
      now: '2026-08-16T19:02:00.000Z',
    });
    expect(claim.claimed).toBe(true);
    deleteGoal(created.id);

    expect(saveGoal(claim.goal!, { now: '2026-08-16T19:03:00.000Z' })).toBe(false);
    expect(loadGoal(created.id)).toBeNull();
  });
});

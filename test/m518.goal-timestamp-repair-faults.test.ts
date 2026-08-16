import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  mode: null as null | 'publish' | 'unlink',
  raceParent: null as string | null,
  raceGoals: null as string | null,
  raceTarget: null as string | null,
  raceTriggered: false,
  membershipMutation: null as null | 'ashlr-child' | 'goals-child',
  membershipTrigger: null as string | null,
  membershipTarget: null as string | null,
  membershipTriggered: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: (existingPath: import('node:fs').PathLike, newPath: import('node:fs').PathLike): void => {
      if (fault.mode === 'publish' && String(newPath).includes('.timestamp-repair-artifacts/records/')) {
        throw Object.assign(new Error('simulated repair artifact publish failure'), { code: 'EIO' });
      }
      actual.linkSync(existingPath, newPath);
    },
    unlinkSync: (target: import('node:fs').PathLike): void => {
      if (fault.mode === 'unlink' && String(target).includes('.timestamp-repair-artifacts/staging/')) {
        throw Object.assign(new Error('simulated repair artifact unlink failure'), { code: 'EIO' });
      }
      actual.unlinkSync(target);
    },
    lstatSync: (target: import('node:fs').PathLike, options?: unknown): unknown => {
      if (!fault.membershipTriggered && fault.membershipMutation && fault.membershipTrigger &&
        fault.membershipTarget && String(target) === fault.membershipTrigger) {
        fault.membershipTriggered = true;
        actual.writeFileSync(fault.membershipTarget, fault.membershipMutation, { mode: 0o600 });
      }
      if (!fault.raceTriggered && fault.raceParent && fault.raceGoals && fault.raceTarget &&
        String(target) === fault.raceGoals) {
        fault.raceTriggered = true;
        actual.symlinkSync(
          fault.raceTarget,
          fault.raceParent,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      return options === undefined
        ? actual.lstatSync(target)
        : actual.lstatSync(target, options as { bigint: true });
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Goal } from '../src/core/types.js';
import {
  applyGoalTimestampRepair,
  dryRunGoalTimestampRepair,
} from '../src/core/goals/timestamp-repair.js';

const originalHome = process.env.HOME;
let tmpHome: string;

function goalDirectory(): string {
  return path.join(tmpHome, '.ashlr', 'goals');
}

function writeStaleGoal(): void {
  const goal: Goal = {
    id: 'fault-goal',
    objective: 'Exercise immutable publication crash recovery',
    project: null,
    status: 'active',
    milestones: [{
      id: 'fault-goal-m0',
      title: 'Later timestamp',
      detail: 'Domain evidence newer than the goal.',
      order: 0,
      status: 'pending',
      specId: null,
      swarmId: null,
      proposalId: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(goalDirectory(), `${goal.id}.json`),
    JSON.stringify(goal, null, 2),
    { mode: 0o600 },
  );
}

function writeGoal(goal: Goal): void {
  fs.mkdirSync(goalDirectory(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(goalDirectory(), `${goal.id}.json`), JSON.stringify(goal), { mode: 0o600 });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m518-repair-fault-'));
  process.env.HOME = tmpHome;
  fault.mode = null;
  fault.raceParent = null;
  fault.raceGoals = null;
  fault.raceTarget = null;
  fault.raceTriggered = false;
  fault.membershipMutation = null;
  fault.membershipTrigger = null;
  fault.membershipTarget = null;
  fault.membershipTriggered = false;
});

afterEach(() => {
  fault.mode = null;
  fault.raceParent = null;
  fault.raceGoals = null;
  fault.raceTarget = null;
  fault.raceTriggered = false;
  fault.membershipMutation = null;
  fault.membershipTrigger = null;
  fault.membershipTarget = null;
  fault.membershipTriggered = false;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('M518 immutable artifact fault recovery', () => {
  it('rejects an initially absent ancestry component replaced by a symlink before read', () => {
    const redirected = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m518-race-target-'));
    fault.raceParent = path.join(tmpHome, '.ashlr');
    fault.raceGoals = path.join(fault.raceParent, 'goals');
    fault.raceTarget = redirected;

    try {
      expect(() => dryRunGoalTimestampRepair()).toThrow(/absent goal source ancestry appeared/i);
      expect(fault.raceTriggered).toBe(true);
    } finally {
      fault.raceParent = null;
      fault.raceGoals = null;
      fault.raceTarget = null;
      fs.rmSync(redirected, { recursive: true, force: true });
    }
  });

  it('ignores unrelated .ashlr membership churn while preserving the live-shaped 22/3 result', () => {
    for (let index = 0; index < 22; index += 1) {
      writeGoal({
        id: `active-goal-${index.toString().padStart(2, '0')}`,
        objective: 'Stable goal-source membership under unrelated instrumentation churn',
        project: null,
        status: 'planning',
        milestones: [],
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: index < 3 ? '1970-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z',
      });
    }
    fault.membershipMutation = 'ashlr-child';
    fault.membershipTrigger = path.join(goalDirectory(), 'active-goal-00.json');
    fault.membershipTarget = path.join(tmpHome, '.ashlr', '.instrumentation-churn');

    const preview = dryRunGoalTimestampRepair();

    expect(fault.membershipTriggered).toBe(true);
    expect(preview).toMatchObject({ scannedGoals: 22, repairableGoals: 3 });
  });

  it('refuses terminal goals-directory membership churn during the bounded scan', () => {
    writeStaleGoal();
    fault.membershipMutation = 'goals-child';
    fault.membershipTrigger = path.join(goalDirectory(), 'fault-goal.json');
    fault.membershipTarget = path.join(goalDirectory(), '.membership-race');

    expect(() => dryRunGoalTimestampRepair()).toThrow(/goal source ancestry changed during read/i);
    expect(fault.membershipTriggered).toBe(true);
  });

  it.each(['publish', 'unlink'] as const)(
    'fails closed on an injected %s fault and completes from the retained recovery state',
    (mode) => {
      writeStaleGoal();
      const preview = dryRunGoalTimestampRepair();
      fault.mode = mode;

      expect(() => applyGoalTimestampRepair(preview.planId)).toThrow(/artifact persistence failed/i);

      fault.mode = null;
      expect(applyGoalTimestampRepair(preview.planId)).toMatchObject({
        repairedGoals: 1,
        alreadyAppliedGoals: 0,
      });
      const root = path.join(goalDirectory(), '.timestamp-repair-artifacts');
      expect(fs.readdirSync(path.join(root, 'staging'))).toEqual([]);
    },
  );
});

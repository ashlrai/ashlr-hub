import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listGoals,
  listGoalsDetailed,
  loadGoal,
  saveGoal,
  updateMilestoneStatus,
} from '../src/core/goals/store.js';

const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-01-02T00:00:00Z';
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let home: string;

function milestone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'goal-valid-m0',
    title: 'Validate source quality',
    detail: 'Reject parseable semantic corruption.',
    order: 0,
    status: 'pending',
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: T0,
    updatedAt: T1,
    ...overrides,
  };
}

function goal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'goal-valid',
    objective: 'Keep goal reads authoritative',
    project: null,
    status: 'active',
    milestones: [milestone()],
    createdAt: T0,
    updatedAt: T1,
    ...overrides,
  };
}

function goalsDirectory(): string {
  return join(home, '.ashlr', 'goals');
}

function writeGoalFile(name: string, record: unknown): void {
  mkdirSync(goalsDirectory(), { recursive: true });
  writeFileSync(join(goalsDirectory(), `${name}.json`), JSON.stringify(record), 'utf8');
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m428-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe('M428 goal source semantic quality', () => {
  it('accepts historical records without owner, additive fields, and parseable ISO timestamps', () => {
    writeGoalFile('goal-valid', {
      ...goal(),
      notes: 'An additive field from a newer writer remains compatible.',
    });

    expect(listGoalsDetailed()).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      scannedFiles: 1,
      unreadableFiles: 0,
      limitExceeded: false,
    });
    expect(listGoals()).toHaveLength(1);
    expect(loadGoal('goal-valid')?.objective).toBe('Keep goal reads authoritative');
  });

  it('accepts every persisted goal and milestone status', () => {
    const goalStatuses = ['planning', 'active', 'paused', 'done', 'archived'];
    const milestoneStatuses = [
      'pending', 'in-progress', 'proposed', 'paused', 'skipped', 'blocked', 'done',
    ];
    milestoneStatuses.forEach((status, index) => {
      const id = `goal-status-${index}`;
      writeGoalFile(id, goal({
        id,
        owner: 'mason',
        project: '/absolute/repo',
        status: goalStatuses[index % goalStatuses.length],
        milestones: [milestone({ id: `${id}-m0`, status })],
      }));
    });

    expect(listGoalsDetailed()).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      scannedFiles: milestoneStatuses.length,
      unreadableFiles: 0,
    });
  });

  it.each([
    ['an invalid id', { id: '../goal' }],
    ['a non-string objective', { objective: 42 }],
    ['an invalid owner', { owner: null }],
    ['an unknown goal status', { status: 'complete' }],
    ['a non-absolute project', { project: 'relative/repo' }],
    ['a non-string project', { project: { repo: '/tmp/repo' } }],
    ['an invalid createdAt', { createdAt: 'not-a-date' }],
    ['an invalid updatedAt', { updatedAt: 'still-not-a-date' }],
    ['timestamps in reverse order', { createdAt: T1, updatedAt: T0 }],
    ['a non-array milestones value', { milestones: { 0: milestone() } }],
  ])('degrades and excludes a goal with %s', (_label, overrides) => {
    writeGoalFile('goal-invalid', goal(overrides));

    expect(listGoalsDetailed()).toEqual({
      goals: [],
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      scannedFiles: 1,
      unreadableFiles: 1,
      limitExceeded: false,
    });
    expect(loadGoal('goal-invalid')).toBeNull();
  });

  it.each([
    ['a non-object entry', [null]],
    ['an invalid id', [milestone({ id: 'bad/id' })]],
    ['a non-string title', [milestone({ title: 12 })]],
    ['a missing detail', [(() => { const value = milestone(); delete value['detail']; return value; })()]],
    ['a negative order', [milestone({ order: -1 })]],
    ['a fractional order', [milestone({ order: 0.5 })]],
    ['an unknown status', [milestone({ status: 'complete' })]],
    ['an invalid specId', [milestone({ specId: 7 })]],
    ['an invalid swarmId', [milestone({ swarmId: false })]],
    ['an invalid proposalId', [milestone({ proposalId: {} })]],
    ['an invalid createdAt', [milestone({ createdAt: 'yesterday-ish' })]],
    ['an invalid updatedAt', [milestone({ updatedAt: 'tomorrow-ish' })]],
    ['timestamps in reverse order', [milestone({ createdAt: T1, updatedAt: T0 })]],
    ['a duplicate id', [milestone(), milestone({ order: 1 })]],
    ['a duplicate order', [milestone(), milestone({ id: 'goal-valid-m1' })]],
  ])('degrades and excludes a goal whose milestone has %s', (_label, milestones) => {
    writeGoalFile('goal-invalid', goal({ id: 'goal-invalid', milestones }));

    expect(listGoalsDetailed()).toMatchObject({
      goals: [],
      sourceState: 'degraded',
      complete: false,
      scannedFiles: 1,
      unreadableFiles: 1,
    });
    expect(loadGoal('goal-invalid')).toBeNull();
  });

  it('keeps a mixed or filtered source incomplete so corruption cannot be acknowledged', () => {
    writeGoalFile('goal-valid', goal({ status: 'planning', milestones: [] }));
    writeGoalFile('goal-invalid', goal({ id: 'goal-invalid', status: 'complete' }));

    const detailed = listGoalsDetailed({ status: 'planning' });
    expect(detailed.goals.map((record) => record.id)).toEqual(['goal-valid']);
    expect(detailed).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      scannedFiles: 2,
      unreadableFiles: 1,
    });
    expect(listGoals({ status: 'planning' }).map((record) => record.id)).toEqual(['goal-valid']);
  });

  it('degrades and excludes a record whose embedded ID does not match its filename', () => {
    writeGoalFile('goal-claimed', goal({
      id: 'goal-embedded',
      milestones: [milestone({ id: 'goal-embedded-m0' })],
    }));

    expect(listGoalsDetailed()).toMatchObject({
      goals: [],
      sourceState: 'degraded',
      complete: false,
      scannedFiles: 1,
      unreadableFiles: 1,
    });
    expect(loadGoal('goal-claimed')).toBeNull();
  });

  it('uses platform path casing when binding an ID to its filename', () => {
    writeGoalFile('GOAL-VALID', goal());

    const detailed = listGoalsDetailed();
    if (process.platform === 'win32') {
      expect(detailed).toMatchObject({
        goals: [{ id: 'goal-valid' }],
        sourceState: 'healthy',
        complete: true,
        unreadableFiles: 0,
      });
    } else {
      expect(detailed).toMatchObject({
        goals: [],
        sourceState: 'degraded',
        complete: false,
        unreadableFiles: 1,
      });
    }
  });

  it('degrades and excludes every file that claims a duplicate goal ID', () => {
    writeGoalFile('goal-duplicate', goal({
      id: 'goal-duplicate',
      milestones: [milestone({ id: 'goal-duplicate-m0' })],
    }));
    writeGoalFile('goal-duplicate-alias', goal({
      id: 'goal-duplicate',
      milestones: [milestone({ id: 'goal-duplicate-m0' })],
    }));

    expect(listGoalsDetailed()).toMatchObject({
      goals: [],
      sourceState: 'degraded',
      complete: false,
      scannedFiles: 2,
      unreadableFiles: 2,
    });
  });

  it('preserves the 200-file read bound and marks a truncated source incomplete', () => {
    for (let index = 0; index < 201; index += 1) {
      const id = `goal-${String(index).padStart(3, '0')}`;
      writeGoalFile(id, goal({ id, milestones: [] }));
    }
    writeFileSync(join(goalsDirectory(), 'ignored.json.tmp'), '{"partial":', 'utf8');

    expect(listGoalsDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      scannedFiles: 200,
      unreadableFiles: 0,
      limitExceeded: true,
    });
    expect(listGoals()).toHaveLength(200);
  }, 15_000);
});

describe('M428 goal persistence authorization boundaries', () => {
  it('does not write a temporary record when authorization is revoked before the temp write', () => {
    writeGoalFile('goal-valid', goal());
    const target = join(goalsDirectory(), 'goal-valid.json');
    const before = readFileSync(target, 'utf8');
    const record = loadGoal('goal-valid')!;
    record.objective = 'This edit must not persist';
    let checks = 0;

    expect(saveGoal(record, {
      stillAuthorized: () => {
        checks += 1;
        return false;
      },
    })).toBe(false);

    expect(checks).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('does not rename a temporary record when authorization is revoked before commit', () => {
    writeGoalFile('goal-valid', goal());
    const target = join(goalsDirectory(), 'goal-valid.json');
    const before = readFileSync(target, 'utf8');
    const record = loadGoal('goal-valid')!;
    record.objective = 'This edit must remain temporary';
    let checks = 0;

    expect(saveGoal(record, undefined, () => {
      checks += 1;
      return checks === 1;
    })).toBe(false);

    expect(checks).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(existsSync(`${target}.tmp`)).toBe(true);
  });

  it('returns null from updateMilestoneStatus when authorization is revoked before commit', () => {
    writeGoalFile('goal-valid', goal());
    const target = join(goalsDirectory(), 'goal-valid.json');
    const before = readFileSync(target, 'utf8');
    let checks = 0;

    expect(updateMilestoneStatus('goal-valid', 'goal-valid-m0', 'done', undefined, () => {
      checks += 1;
      return checks === 1;
    })).toBeNull();

    expect(checks).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(loadGoal('goal-valid')?.milestones[0]?.status).toBe('pending');
  });
});

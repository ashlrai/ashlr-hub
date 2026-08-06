import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, Goal } from '../src/core/types.js';
import {
  adoptBriefing,
  previewBriefingAdoption,
  type StrategicBriefing,
} from '../src/core/vision/strategist.js';
import { createGoal, loadGoal, saveGoal } from '../src/core/goals/store.js';

const originalHome = process.env.HOME;
let home: string;
let reposRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-m485-home-'));
  reposRoot = join(home, 'repos');
  mkdirSync(reposRoot, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

const cfg = { foundry: { goalFocusActiveThreshold: 4 } } as AshlrConfig;

function repo(name: string, parent = reposRoot): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function briefing(
  proposedGoals: StrategicBriefing['proposedGoals'],
  project: string | null = null,
): StrategicBriefing {
  return {
    generatedAt: '2026-08-05T12:00:00.000Z',
    project,
    currentState: 'Grounded test state.',
    gapToVision: 'A mission has not yet been compiled.',
    proposedEvolution: {},
    recommendedDirection: [],
    newProblems: [],
    questionsForMason: [],
    proposedGoals,
  };
}

function openGoal(objective: string, project: string | null, status: Goal['status'] = 'active'): Goal {
  return {
    id: `goal-${objective}`,
    objective,
    project,
    status,
    milestones: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('M485 mission compiler preview', () => {
  it('resolves an exact targetRepo basename to one enrolled root', () => {
    const pulse = repo('ashlr-pulse');
    const preview = previewBriefingAdoption(
      briefing([{ objective: 'Ship the live command stream', rationale: 'Useful.', targetRepo: 'ashlr-pulse' }]),
      { enrolledRepos: [pulse], existingGoals: [], activeThreshold: 4 },
    );

    expect(preview.createCount).toBe(1);
    expect(preview.entries[0]).toMatchObject({
      disposition: 'create',
      reason: 'ready',
      targetRepo: 'ashlr-pulse',
      project: pulse,
    });
  });

  it('fails closed for missing, ambiguous, and malformed targets', () => {
    const first = repo('ashlr-pulse', join(home, 'org-a'));
    const second = repo('ashlr-pulse', join(home, 'org-b'));
    const preview = previewBriefingAdoption(
      briefing([
        { objective: 'Ambiguous', rationale: '', targetRepo: 'ashlr-pulse' },
        { objective: 'Missing', rationale: '', targetRepo: 'phantom-secrets' },
        { objective: 'Malformed', rationale: '', targetRepo: '../ashlr-pulse' },
      ]),
      { enrolledRepos: [first, second], existingGoals: [], activeThreshold: 4 },
    );

    expect(preview.createCount).toBe(0);
    expect(preview.entries.map((entry) => entry.reason)).toEqual([
      'target-ambiguous',
      'target-not-enrolled',
      'target-invalid',
    ]);
    expect(preview.entries.every((entry) => entry.project === null)).toBe(true);
  });

  it('dedupes open and same-briefing goals by exact repo plus normalized objective', () => {
    const hub = repo('ashlr-hub');
    const objective = '[vision:Old priority] Ship mission compiler';
    const preview = previewBriefingAdoption(
      briefing([
        {
          objective: 'Ship mission compiler',
          rationale: '',
          specPriority: 'Autonomy',
          targetRepo: 'ashlr-hub',
        },
        { objective: 'A fresh mission', rationale: '', targetRepo: 'ashlr-hub' },
        { objective: '  A   fresh mission  ', rationale: '', targetRepo: 'ashlr-hub' },
      ]),
      {
        enrolledRepos: [hub],
        existingGoals: [openGoal(objective, hub)],
        activeThreshold: 4,
      },
    );

    expect(preview.entries.map((entry) => entry.reason)).toEqual([
      'duplicate-existing-goal',
      'ready',
      'duplicate-existing-goal',
    ]);
    expect(preview.createCount).toBe(1);
  });

  it('reserves deterministic objective ids across repositories within one briefing', () => {
    const hub = repo('ashlr-hub');
    const pulse = repo('ashlr-pulse');
    const preview = previewBriefingAdoption(
      briefing([
        { objective: 'One deterministic id', rationale: '', targetRepo: 'ashlr-hub' },
        { objective: 'One deterministic id', rationale: '', targetRepo: 'ashlr-pulse' },
      ]),
      { enrolledRepos: [hub, pulse], existingGoals: [], activeThreshold: 4 },
    );

    expect(preview.entries.map((entry) => entry.reason)).toEqual(['ready', 'goal-id-collision']);
    expect(preview.createCount).toBe(1);
  });

  it('enforces both the active-goal focus cap and the three-goal briefing cap', () => {
    const hub = repo('ashlr-hub');
    const preview = previewBriefingAdoption(
      briefing([
        { objective: 'Mission one', rationale: '', targetRepo: 'ashlr-hub' },
        { objective: 'Mission two', rationale: '', targetRepo: 'ashlr-hub' },
        { objective: 'Mission three', rationale: '', targetRepo: 'ashlr-hub' },
        { objective: 'Mission four', rationale: '', targetRepo: 'ashlr-hub' },
      ]),
      {
        enrolledRepos: [hub],
        existingGoals: [
          openGoal('Existing one', hub),
          openGoal('Existing two', hub, 'planning'),
          openGoal('Existing three', hub),
        ],
        activeThreshold: 4,
      },
    );

    expect(preview.availableSlots).toBe(1);
    expect(preview.entries.map((entry) => entry.reason)).toEqual([
      'ready',
      'goal-focus-cap',
      'goal-focus-cap',
      'briefing-goal-cap',
    ]);
  });
});

describe('M485 mission compiler adoption', () => {
  it('creates only compiled goals and leaves the enrolled repo untouched', async () => {
    const pulse = repo('ashlr-pulse');
    const before = readdirSync(pulse);
    const result = await adoptBriefing(
      cfg,
      briefing([
        { objective: 'Ship live command stream', rationale: '', targetRepo: 'ashlr-pulse' },
        { objective: 'Mutate unknown repo', rationale: '', targetRepo: 'unknown-tool' },
      ]),
      { enrolledRepos: [pulse], existingGoals: [], activeThreshold: 4 },
    );

    expect(result.goalIds).toHaveLength(1);
    expect(result).toMatchObject({
      specOutcome: 'not-requested',
      createdCount: 1,
      failedCount: 0,
      skippedCount: 1,
    });
    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(['created', 'skipped']);
    expect(result.preview.entries.map((entry) => entry.reason)).toEqual([
      'ready',
      'target-not-enrolled',
    ]);
    expect(readdirSync(pulse)).toEqual(before);
    expect(existsSync(join(home, '.ashlr', 'goals', `${result.goalIds[0]}.json`))).toBe(true);
  });

  it('reports a compiled goal as failed when the goal store cannot persist it', async () => {
    const pulse = repo('ashlr-pulse');
    const ashlrDir = join(home, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    writeFileSync(join(ashlrDir, 'goals'), 'blocks goal directory creation', 'utf8');

    const result = await adoptBriefing(
      cfg,
      briefing([
        { objective: 'Persist this mission', rationale: '', targetRepo: 'ashlr-pulse' },
      ]),
      {
        enrolledRepos: [pulse],
        existingGoals: [],
        goalSourceState: 'healthy',
        activeThreshold: 4,
      },
    );

    expect(result.goalIds).toEqual([]);
    expect(result).toMatchObject({ createdCount: 0, failedCount: 1, skippedCount: 0 });
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        reason: 'goal-store-write-failed',
        objective: 'Persist this mission',
        project: pulse,
      }),
    ]);
  });

  it.each([
    ['malformed', JSON.stringify({ id: 'not-a-goal' })],
    ['truncated', '{"id":"cut-off"'],
  ])('fails closed when the goal inventory contains a %s record', async (_kind, contents) => {
    const pulse = repo('ashlr-pulse');
    const goalsDir = join(home, '.ashlr', 'goals');
    mkdirSync(goalsDir, { recursive: true });
    writeFileSync(join(goalsDir, 'damaged.json'), contents, 'utf8');

    const result = await adoptBriefing(
      cfg,
      briefing([
        { objective: 'Do not create from partial inventory', rationale: '', targetRepo: 'ashlr-pulse' },
      ]),
      { enrolledRepos: [pulse], activeThreshold: 4 },
    );

    expect(result.preview.goalSourceState).toBe('degraded');
    expect(result.goalIds).toEqual([]);
    expect(result).toMatchObject({ createdCount: 0, failedCount: 0, skippedCount: 1 });
    expect(result.outcomes).toEqual([
      expect.objectContaining({ outcome: 'skipped', reason: 'goal-source-degraded' }),
    ]);
    expect(readdirSync(goalsDir)).toEqual(['damaged.json']);
  });

  it.each([
    ['archived', false],
    ['archived', true],
    ['done', false],
    ['done', true],
  ] as const)(
    'never overwrites a %s deterministic-id collision when write failure is %s',
    async (status, forceWriteFailure) => {
      const pulse = repo('ashlr-pulse');
      const objective = 'Preserve completed mission history';
      const prior = createGoal(objective, {
        project: pulse,
        now: '2026-08-01T00:00:00.000Z',
      });
      prior.status = status;
      expect(saveGoal(prior, { now: '2026-08-02T00:00:00.000Z' })).toBe(true);
      const goalFile = join(home, '.ashlr', 'goals', `${prior.id}.json`);
      const before = JSON.stringify(loadGoal(prior.id));

      // createGoal writes through this deterministic sidecar path. Making it
      // a directory reproduces the prior false-success path without making
      // the existing inventory unreadable.
      if (forceWriteFailure) mkdirSync(`${goalFile}.tmp`);

      const result = await adoptBriefing(
        cfg,
        briefing([{ objective, rationale: '', targetRepo: 'ashlr-pulse' }]),
        { enrolledRepos: [pulse], activeThreshold: 4 },
      );

      expect(result.goalIds).toEqual([]);
      expect(result).toMatchObject({ createdCount: 0, failedCount: 0, skippedCount: 1 });
      expect(result.outcomes).toEqual([
        expect.objectContaining({ outcome: 'skipped', reason: 'goal-id-collision' }),
      ]);
      expect(JSON.stringify(loadGoal(prior.id))).toBe(before);
      expect(loadGoal(prior.id)?.status).toBe(status);
    },
  );
});

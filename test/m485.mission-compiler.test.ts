import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, Goal } from '../src/core/types.js';
import {
  adoptBriefing,
  compileBriefingMissionGraph,
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

function bindGoalToMission(goal: Goal, mission: StrategicBriefing, enrolledRepos: string[], nodeKey: string): void {
  const compiled = compileBriefingMissionGraph(mission, enrolledRepos);
  if (!compiled?.ok) throw new Error('expected a valid mission graph');
  goal.mission = {
    schemaVersion: 1,
    graphDigest: compiled.graph.graphDigest,
    missionKey: compiled.graph.missionKey,
    nodeKey,
  };
}

describe('M485 mission compiler preview', () => {
  it('compiles a dependency-aware mission and unlocks only realized upstream work', () => {
    const hub = repo('ashlr-hub');
    const pulse = repo('ashlr-pulse');
    const mission = briefing([
      {
        key: 'publish-contract',
        objective: 'Publish the integration contract',
        rationale: 'Give the ecosystem one stable seam.',
        targetRepo: 'ashlr-hub',
        deliverable: 'Versioned integration contract',
        acceptanceEvidence: ['Contract tests pass on the canonical revision.'],
        riskClass: 'medium',
        outcome: {
          desiredOutcome: 'Every product integrates through one governed seam.',
          successSignals: ['One canonical contract is consumed end to end.'],
          guardrails: ['No deployment authority is granted.'],
        },
      },
      {
        key: 'consume-contract',
        objective: 'Consume the integration contract',
        rationale: 'Prove the composition path.',
        targetRepo: 'ashlr-pulse',
        dependsOn: ['publish-contract'],
        deliverable: 'Contract-backed consumer',
        acceptanceEvidence: ['Consumer verification passes against the exact contract.'],
        riskClass: 'medium',
      },
      {
        key: 'authorize-release',
        objective: 'Authorize the production release',
        rationale: 'Keep publication human-owned.',
        targetRepo: null,
        dependsOn: ['consume-contract'],
        deliverable: 'Human release decision',
        acceptanceEvidence: ['A separately authorized release receipt exists.'],
        riskClass: 'high',
        humanGate: true,
      },
    ]);

    const initial = previewBriefingAdoption(mission, {
      enrolledRepos: [hub, pulse], existingGoals: [], activeThreshold: 4,
    });
    expect(initial.missionGraph).toMatchObject({ state: 'valid', digest: expect.any(String) });
    expect(initial.entries.map((entry) => entry.reason)).toEqual([
      'ready', 'dependency-blocked', 'dependency-blocked',
    ]);

    const upstream = openGoal('Publish the integration contract', hub);
    bindGoalToMission(upstream, mission, [hub, pulse], 'publish-contract');
    const advanced = previewBriefingAdoption(mission, {
      enrolledRepos: [hub, pulse],
      existingGoals: [upstream],
      activeThreshold: 4,
      goalRealized: (goal) => goal === upstream,
    });
    expect(advanced.entries.map((entry) => entry.reason)).toEqual([
      'goal-id-collision', 'ready', 'dependency-blocked',
    ]);
  });

  it('fails closed on a cyclic mission graph and never materializes human gates', () => {
    const hub = repo('ashlr-hub');
    const cyclic = previewBriefingAdoption(briefing([
      {
        key: 'one', objective: 'One', rationale: '', targetRepo: 'ashlr-hub', dependsOn: ['two'],
        deliverable: 'One deliverable', acceptanceEvidence: ['One proof'], riskClass: 'low',
      },
      {
        key: 'two', objective: 'Two', rationale: '', targetRepo: 'ashlr-hub', dependsOn: ['one'],
        deliverable: 'Two deliverable', acceptanceEvidence: ['Two proof'], riskClass: 'low',
      },
    ]), { enrolledRepos: [hub], existingGoals: [], activeThreshold: 4 });
    expect(cyclic.missionGraph).toMatchObject({ state: 'invalid', digest: null });
    expect(cyclic.entries.map((entry) => entry.reason)).toEqual([
      'mission-graph-invalid', 'mission-graph-invalid',
    ]);

    const gated = previewBriefingAdoption(briefing([{
      key: 'release', objective: 'Release', rationale: '', targetRepo: null,
      deliverable: 'Human decision', acceptanceEvidence: ['Authorized receipt'], riskClass: 'high', humanGate: true,
    }]), { enrolledRepos: [hub], existingGoals: [], activeThreshold: 4 });
    expect(gated.entries[0]).toMatchObject({ disposition: 'skip', reason: 'human-gate-required', project: null });
  });

  it('rejects a human gate that names a repository instead of erasing the invalid target', () => {
    const hub = repo('ashlr-hub');
    const preview = previewBriefingAdoption(briefing([{
      key: 'release', objective: 'Authorize release', rationale: '', targetRepo: 'ashlr-hub',
      dependsOn: [], deliverable: 'Human decision', acceptanceEvidence: ['Authorized receipt'],
      riskClass: 'high', humanGate: true,
    }]), { enrolledRepos: [hub], existingGoals: [], activeThreshold: 4 });

    expect(preview.missionGraph).toMatchObject({ state: 'invalid', digest: null });
    expect(preview.entries[0]).toMatchObject({ disposition: 'skip', reason: 'mission-graph-invalid' });
  });

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
  it('reconciles at most one dependency-ready goal without re-applying spec evolution', async () => {
    const hub = repo('ashlr-hub');
    const pulse = repo('ashlr-pulse');
    const upstream = openGoal('Publish the mission contract', hub);
    const mission = briefing([
      {
        key: 'contract', objective: 'Publish the mission contract', rationale: '', targetRepo: 'ashlr-hub',
        deliverable: 'Mission contract', acceptanceEvidence: ['Verified realized merge exists'], riskClass: 'medium',
      },
      {
        key: 'consumer', objective: 'Consume the mission contract', rationale: '', targetRepo: 'ashlr-pulse',
        dependsOn: ['contract'], deliverable: 'Mission consumer', acceptanceEvidence: ['Consumer verification passes'], riskClass: 'medium',
      },
      {
        key: 'parallel', objective: 'Publish the operator guide', rationale: '', targetRepo: 'ashlr-hub',
        deliverable: 'Operator guide', acceptanceEvidence: ['Guide checks pass'], riskClass: 'low',
      },
    ]);
    mission.proposedEvolution = { northStar: 'Do not apply this during reconciliation.' };
    bindGoalToMission(upstream, mission, [hub, pulse], 'contract');

    const result = await adoptBriefing(cfg, mission, {
      enrolledRepos: [hub, pulse],
      existingGoals: [upstream],
      activeThreshold: 4,
      goalRealized: (goal) => goal === upstream,
      goalsOnly: true,
      maxCreatedGoals: 1,
    });

    expect(result.specOutcome).toBe('not-requested');
    expect(result.createdCount).toBe(1);
    expect(result.goalIds).toHaveLength(1);
    expect(loadGoal(result.goalIds[0]!)?.mission).toMatchObject({
      schemaVersion: 1,
      nodeKey: 'consumer',
      graphDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ objective: 'Publish the mission contract', outcome: 'skipped', reason: 'goal-id-collision' }),
      expect.objectContaining({ objective: 'Consume the mission contract', outcome: 'created', reason: 'persisted' }),
      expect.objectContaining({ objective: 'Publish the operator guide', outcome: 'skipped', reason: 'mission-reconcile-cap' }),
    ]));
  });

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

  it('does not let an unbound historical goal realize a changed mission contract', () => {
    const hub = repo('ashlr-hub');
    const mission = briefing([
      {
        key: 'contract', objective: 'Publish the stable contract', rationale: '', targetRepo: 'ashlr-hub',
        deliverable: 'New contract v2', acceptanceEvidence: ['V2 compatibility proof'], riskClass: 'high',
      },
      {
        key: 'consumer', objective: 'Consume the stable contract', rationale: '', targetRepo: 'ashlr-hub',
        dependsOn: ['contract'], deliverable: 'V2 consumer', acceptanceEvidence: ['V2 consumer proof'], riskClass: 'medium',
      },
    ]);
    const historical = openGoal('Publish the stable contract', hub, 'done');
    const preview = previewBriefingAdoption(mission, {
      enrolledRepos: [hub], existingGoals: [historical], activeThreshold: 4,
      goalRealized: () => true,
    });
    expect(preview.entries.map((entry) => entry.reason)).toEqual([
      'goal-id-collision', 'dependency-blocked',
    ]);
  });

  it('atomically refuses a same-id goal created after the preview snapshot', async () => {
    const hub = repo('ashlr-hub');
    const objective = 'Never overwrite concurrent planning state';
    const existing = createGoal(objective, { project: hub, now: '2026-08-01T00:00:00.000Z' });
    existing.milestones.push({
      id: `${existing.id}-m0`, title: 'Preserve me', detail: 'Concurrent state', order: 0,
      status: 'in-progress', specId: 'spec-1', swarmId: 'swarm-1', proposalId: null,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(saveGoal(existing, { now: '2026-08-02T00:00:00.000Z' })).toBe(true);
    const before = JSON.stringify(loadGoal(existing.id));

    const result = await adoptBriefing(
      cfg,
      briefing([{ objective, rationale: '', targetRepo: 'ashlr-hub' }]),
      { enrolledRepos: [hub], existingGoals: [], goalSourceState: 'healthy', activeThreshold: 4 },
    );

    expect(result.createdCount).toBe(0);
    expect(result.outcomes[0]).toMatchObject({ outcome: 'skipped', reason: 'goal-id-collision' });
    expect(JSON.stringify(loadGoal(existing.id))).toBe(before);
  });

  it('is idempotent for a previously materialized mission node', async () => {
    const hub = repo('ashlr-hub');
    const mission = briefing([{
      key: 'root', objective: 'One durable mission root', rationale: '', targetRepo: 'ashlr-hub',
      deliverable: 'Durable root', acceptanceEvidence: ['Root verification passes'], riskClass: 'low',
    }]);
    const first = await adoptBriefing(cfg, mission, {
      enrolledRepos: [hub], goalsOnly: true, maxCreatedGoals: 1,
    });
    const second = await adoptBriefing(cfg, mission, {
      enrolledRepos: [hub], goalsOnly: true, maxCreatedGoals: 1,
    });
    expect(first.createdCount).toBe(1);
    expect(second.createdCount).toBe(0);
    expect(second.outcomes[0]).toMatchObject({ outcome: 'skipped', reason: 'goal-id-collision' });
    const persisted = loadGoal(first.goalIds[0]!)!;
    expect(persisted.mission?.nodeKey).toBe('root');
    persisted.mission = { ...persisted.mission!, nodeKey: 'changed' };
    expect(saveGoal(persisted)).toBe(false);
    expect(loadGoal(first.goalIds[0]!)?.mission?.nodeKey).toBe('root');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'fails a non-integer reconciliation cap closed to zero (%s)',
    async (maxCreatedGoals) => {
      const hub = repo(`ashlr-hub-${String(maxCreatedGoals).replace(/\W/g, '') || 'nan'}`);
      const result = await adoptBriefing(
        cfg,
        briefing([{ objective: `Bounded mission ${String(maxCreatedGoals)}`, rationale: '', targetRepo: hub }]),
        { enrolledRepos: [hub], existingGoals: [], activeThreshold: 4, goalsOnly: true, maxCreatedGoals },
      );
      expect(result.createdCount).toBe(0);
      expect(result.outcomes[0]).toMatchObject({ outcome: 'skipped', reason: 'mission-reconcile-cap' });
    },
  );

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

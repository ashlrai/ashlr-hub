import { describe, expect, it, vi } from 'vitest';

import type { Goal, Proposal, RealizedMergeEvidence } from '../src/core/types.js';
import { compileEcosystemMissionGraph } from '../src/core/vision/mission-graph.js';

vi.mock('../src/core/inbox/realized-merge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/inbox/realized-merge.js')>();
  return {
    ...original,
    authenticatedRealizedMergeOf(value: unknown): RealizedMergeEvidence | null {
      const proposal = value as Proposal;
      return proposal.id.startsWith('authenticated-') ? original.realizedMergeOf(value) : null;
    },
  };
});

import {
  captureMissionObservation,
  type MissionObservationCaptureInput,
} from '../src/core/vision/mission-observation-capture.js';
import { missionObservationBriefingDigest } from '../src/core/vision/mission-receipt.js';

const REPO = '/tmp/ashlr-mission-capture';
const NOW = '2026-08-09T12:00:00.000Z';
const SHA = 'a'.repeat(64);
const OID = 'b'.repeat(40);

function graph() {
  const compiled = compileEcosystemMissionGraph({
    missionKey: 'mission-capture',
    title: 'Mission capture',
    objective: 'Capture exact evidence',
    createdAt: NOW,
    nodes: [{
      kind: 'work',
      key: 'build',
      title: 'Build',
      objective: 'Build the adapter',
      deliverable: 'A pure adapter',
      riskClass: 'low',
      targetRepo: REPO,
      acceptance: ['Fail closed'],
    }, {
      kind: 'human-gate',
      key: 'approve',
      title: 'Approve',
      objective: 'Human approval',
      deliverable: 'A decision outside the receipt',
      riskClass: 'high',
      dependsOn: ['build'],
      acceptance: ['Explicit human decision'],
    }],
  }, [REPO]);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return compiled.graph;
}

function goal(overrides: Partial<Goal> = {}): Goal {
  const missionGraph = graph();
  return {
    id: 'goal-build',
    mission: {
      schemaVersion: 1,
      graphDigest: missionGraph.graphDigest,
      missionKey: missionGraph.missionKey,
      nodeKey: 'build',
    },
    objective: 'Build the adapter',
    project: REPO,
    status: 'active',
    milestones: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1',
    repo: REPO,
    origin: 'swarm',
    kind: 'patch',
    title: 'Raw human prose must not be retained',
    summary: 'Potentially sensitive raw proposal text',
    diffHash: SHA,
    status: 'pending',
    createdAt: NOW,
    ...overrides,
  };
}

function input(goals: Goal[] = [], proposals: Proposal[] = []): MissionObservationCaptureInput {
  return {
    recordedAt: NOW,
    graph: graph(),
    briefing: { schemaVersion: 1, missionKey: 'mission-capture' },
    briefingQuality: { sourceState: 'healthy', sourcePresent: true, complete: true },
    enrollment: { state: 'ready', repos: [REPO], reason: 'registry-present' },
    goals: {
      goals,
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      scannedFiles: goals.length,
      unreadableFiles: 0,
      limitExceeded: false,
    },
    proposals: {
      proposals,
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      stopReasons: [],
      filesDiscovered: proposals.length,
      filesRead: proposals.length,
      bytesRead: proposals.length * 100,
      invalidFiles: 0,
      unreadableFiles: 0,
    },
  };
}

function milestones(prefix: string, count: number): Goal['milestones'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(3, '0')}`,
    title: 'Bounded milestone',
    detail: 'Bounded evidence',
    order: index,
    status: 'pending' as const,
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

describe('M496 mission observation capture adapter', () => {
  it('captures a bounded receipt input without inventing human approval', () => {
    const captured = captureMissionObservation(input());
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.receiptInput.captureKind).toBe('explicit-reconcile');
    expect(captured.receiptInput.briefingSource.digest).toBe(
      missionObservationBriefingDigest(captured.receiptInput.briefing),
    );
    expect(captured.receiptInput.nodes.find((node) => node.nodeKey === 'build')).toEqual(
      expect.objectContaining({ nodeKey: 'build', status: 'ready', goalId: null }),
    );
    expect(captured.receiptInput.nodes.find((node) => node.nodeKey === 'approve')).toEqual(
      expect.objectContaining({ nodeKey: 'approve', status: 'blocked', goalId: null, milestones: [] }),
    );
  });

  it('binds a mission goal and linked proposal using only normalized evidence', () => {
    const linked = proposal();
    const boundGoal = goal({
      milestones: [{
        id: 'milestone-1',
        title: 'Raw title',
        detail: 'Raw detail',
        order: 1,
        status: 'proposed',
        specId: null,
        swarmId: null,
        proposalId: linked.id,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    });
    const captured = captureMissionObservation(input([boundGoal], [linked]));
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const node = captured.receiptInput.nodes.find((entry) => entry.nodeKey === 'build')!;
    expect(node).toMatchObject({ nodeKey: 'build', status: 'proposed', goalId: boundGoal.id });
    expect(node.goalRecordDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(node.milestones[0]).toMatchObject({
      milestoneId: 'milestone-1',
      proposalId: linked.id,
      proposalStatus: 'pending',
      verificationPassed: false,
      verificationDigest: null,
      realizedMergeDigest: null,
    });
    expect(JSON.stringify(captured.receiptInput)).not.toContain('Raw title');
    expect(JSON.stringify(captured.receiptInput)).not.toContain('Potentially sensitive');
  });

  it('credits completion only with authenticated realized merge and passing verification', () => {
    const realizedMerge: RealizedMergeEvidence = {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: 'c'.repeat(40),
      proposalHeadOid: 'd'.repeat(40),
      mergeCommitOid: OID,
      observedAt: NOW,
      proposalId: 'authenticated-proposal',
      diffHash: SHA,
      intentAttestation: 'e'.repeat(64),
      attestation: 'f'.repeat(64),
    };
    const linked = proposal({
      id: 'authenticated-proposal',
      status: 'applied',
      realizedMerge,
      verifyResult: { passed: true, diffHash: SHA, baseHead: 'c'.repeat(40), verifiedAt: NOW },
    });
    const boundGoal = goal({
      status: 'done',
      milestones: [{
        id: 'milestone-1', title: 'Done', detail: 'Done', order: 1, status: 'done',
        specId: null, swarmId: null, proposalId: linked.id, createdAt: NOW, updatedAt: NOW,
      }],
    });
    const captured = captureMissionObservation(input([boundGoal], [linked]));
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const node = captured.receiptInput.nodes.find((entry) => entry.nodeKey === 'build')!;
    expect(node).toMatchObject({ status: 'complete' });
    expect(node.milestones[0]).toMatchObject({
      verificationPassed: true,
      mergeSource: 'local-default-branch',
      exactRevision: OID,
    });
  });

  it.each([
    ['briefing', (value: MissionObservationCaptureInput) => {
      value.briefingQuality = { sourceState: 'degraded', sourcePresent: true, complete: false };
    }, 'briefing-source-incomplete'],
    ['goals', (value: MissionObservationCaptureInput) => {
      value.goals.unreadableFiles = 1;
      value.goals.complete = false;
      value.goals.sourceState = 'degraded';
    }, 'goal-source-incomplete'],
    ['proposals', (value: MissionObservationCaptureInput) => {
      value.proposals.stopReasons = ['byte-limit'];
      value.proposals.complete = false;
      value.proposals.sourceState = 'degraded';
    }, 'proposal-source-incomplete'],
  ])('fails closed on incomplete %s source evidence', (_label, mutate, reason) => {
    const value = input();
    mutate(value);
    expect(captureMissionObservation(value)).toEqual({ ok: false, reason });
  });

  it('accepts authoritative missing complete empty inventories and preserves their source states', () => {
    const healthy = captureMissionObservation(input());
    const value = input();
    value.goals.sourceState = 'missing';
    value.goals.sourcePresent = false;
    value.proposals.sourceState = 'missing';
    value.proposals.sourcePresent = false;
    const missing = captureMissionObservation(value);
    expect(healthy.ok && missing.ok).toBe(true);
    if (!healthy.ok || !missing.ok) return;
    expect(missing.receiptInput.goalSource.sourceState).toBe('missing');
    expect(missing.receiptInput.proposalSource.sourceState).toBe('missing');
    expect(missing.receiptInput.goalSource.digest).not.toBe(healthy.receiptInput.goalSource.digest);
    expect(missing.receiptInput.proposalSource.digest).not.toBe(healthy.receiptInput.proposalSource.digest);
  });

  it('rejects more than 512 milestones in aggregate across otherwise bounded goals', () => {
    const first = goal({ id: 'goal-first', mission: undefined, objective: 'First', milestones: milestones('first', 256) });
    const second = goal({ id: 'goal-second', mission: undefined, objective: 'Second', milestones: milestones('second', 257) });
    expect(captureMissionObservation(input([first, second]))).toEqual({
      ok: false,
      reason: 'inventory-out-of-bounds',
    });
  });

  it.each([
    ['too many runs', Array.from({ length: 129 }, () => ({ kind: 'test' as const, cmd: ['npm', 'test'] }))],
    ['too many command arguments', [{ kind: 'test' as const, cmd: Array.from({ length: 65 }, () => 'arg') }]],
    ['unknown run field', [{ kind: 'test' as const, cmd: ['npm', 'test'], rawOutput: 'secret' }]],
  ])('rejects invalid bounded verification structure: %s', (_label, ran) => {
    const candidate = proposal({
      verifyResult: { passed: false, ran } as Proposal['verifyResult'],
    });
    expect(captureMissionObservation(input([], [candidate]))).toEqual({
      ok: false,
      reason: 'invalid-proposal-evidence',
    });
  });

  it('rejects linked proposals from a different repository', () => {
    const linked = proposal({ repo: '/tmp/other-repo' });
    const boundGoal = goal({
      milestones: [{
        id: 'milestone-1', title: 'One', detail: 'One', order: 1, status: 'proposed',
        specId: null, swarmId: null, proposalId: linked.id, createdAt: NOW, updatedAt: NOW,
      }],
    });
    expect(captureMissionObservation(input([boundGoal], [linked]))).toEqual({
      ok: false,
      reason: 'linked-proposal-repository-mismatch',
    });
  });

  it('rejects a near-match mission binding with the wrong exact graph digest', () => {
    const incorrectlyBound = goal({
      mission: {
        schemaVersion: 1,
        graphDigest: 'f'.repeat(64),
        missionKey: 'mission-capture',
        nodeKey: 'build',
      },
    });
    expect(captureMissionObservation(input([incorrectlyBound]))).toEqual({
      ok: false,
      reason: 'invalid-mission-goal-binding',
    });
  });

  it('does not credit shape-only merge evidence rejected by the production verifier', async () => {
    const production = await vi.importActual<typeof import('../src/core/inbox/realized-merge.js')>(
      '../src/core/inbox/realized-merge.js',
    );
    const shapeOnly = proposal({
      id: 'shape-only-proposal',
      status: 'applied',
      realizedMerge: {
        schemaVersion: 1,
        source: 'local-default-branch',
        base: 'main',
        baseBeforeOid: 'c'.repeat(40),
        proposalHeadOid: 'd'.repeat(40),
        mergeCommitOid: OID,
        observedAt: NOW,
        proposalId: 'shape-only-proposal',
        diffHash: SHA,
        intentAttestation: 'e'.repeat(64),
        attestation: 'f'.repeat(64),
      },
      verifyResult: { passed: true, diffHash: SHA, verifiedAt: NOW },
    });
    expect(production.authenticatedRealizedMergeOf(shapeOnly)).toBeNull();
    const boundGoal = goal({
      milestones: [{
        id: 'milestone-1', title: 'One', detail: 'One', order: 1, status: 'done',
        specId: null, swarmId: null, proposalId: shapeOnly.id, createdAt: NOW, updatedAt: NOW,
      }],
    });
    const captured = captureMissionObservation(input([boundGoal], [shapeOnly]));
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const milestone = captured.receiptInput.nodes.find((node) => node.nodeKey === 'build')!.milestones[0]!;
    expect(milestone).toMatchObject({
      verificationPassed: false,
      verificationDigest: null,
      mergeSource: null,
      realizedMergeDigest: null,
    });
  });

  it('rejects unknown top-level fields rather than accepting human or business outcomes', () => {
    const value = { ...input(), humanApproved: true, businessOutcome: 'won' };
    expect(captureMissionObservation(value as unknown as MissionObservationCaptureInput)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('rejects accessors without invoking caller code', () => {
    let getterCalls = 0;
    const topLevel = input();
    Object.defineProperty(topLevel, 'recordedAt', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return NOW;
      },
    });
    expect(captureMissionObservation(topLevel)).toEqual({ ok: false, reason: 'invalid-input' });

    const nested = input([goal()]);
    Object.defineProperty(nested.goals.goals[0]!, 'id', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'goal-build';
      },
    });
    expect(captureMissionObservation(nested)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(getterCalls).toBe(0);
  });

  it('rejects proxies before invoking their traps', () => {
    let trapCalls = 0;
    const candidate = new Proxy(goal(), {
      get: (target, property, receiver) => {
        trapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor: (target, property) => {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf: (target) => {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(captureMissionObservation(input([candidate]))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(trapCalls).toBe(0);
  });

  it.each([
    ['symbol authority field', (value: MissionObservationCaptureInput) => {
      Object.defineProperty(value.proposals.proposals[0]!, Symbol('humanApproved'), {
        enumerable: true,
        value: true,
      });
    }],
    ['non-enumerable authority field', (value: MissionObservationCaptureInput) => {
      Object.defineProperty(value.proposals.proposals[0]!, 'humanApproved', {
        enumerable: false,
        value: true,
      });
    }],
    ['sparse array', (value: MissionObservationCaptureInput) => {
      value.proposals.proposals.length = 2;
    }],
    ['array authority field', (value: MissionObservationCaptureInput) => {
      Object.defineProperty(value.proposals.proposals, 'humanApproved', {
        enumerable: true,
        value: true,
      });
    }],
  ])('rejects hidden or non-data structure: %s', (_label, mutate) => {
    const value = input([], [proposal()]);
    mutate(value);
    expect(captureMissionObservation(value)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('rejects cyclic evidence and detaches accepted briefing data from its caller', () => {
    const cyclic = input();
    const cyclicBriefing: Record<string, unknown> = { schemaVersion: 1 };
    cyclicBriefing['self'] = cyclicBriefing;
    cyclic.briefing = cyclicBriefing;
    expect(captureMissionObservation(cyclic)).toEqual({ ok: false, reason: 'invalid-input' });

    const value = input();
    const briefing = {
      schemaVersion: 1,
      missionKey: 'mission-capture',
      strategy: { priorities: ['safety', 'autonomy'] },
    };
    value.briefing = briefing;
    const captured = captureMissionObservation(value);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.receiptInput.briefing).not.toBe(briefing);
    expect((captured.receiptInput.briefing as typeof briefing).strategy).not.toBe(briefing.strategy);
    briefing.strategy.priorities[0] = 'mutated-after-capture';
    expect((captured.receiptInput.briefing as typeof briefing).strategy.priorities).toEqual(['safety', 'autonomy']);
  });

  it('is replay-stable for inventory order and excludes recordedAt from source digests', () => {
    const firstGoal = goal({ id: 'goal-a' });
    const secondGoal = goal({ id: 'goal-b', mission: undefined, objective: 'Unrelated' });
    const firstProposal = proposal({ id: 'proposal-a' });
    const secondProposal = proposal({ id: 'proposal-b' });
    const first = captureMissionObservation(input([firstGoal, secondGoal], [firstProposal, secondProposal]));
    const secondInput = input([secondGoal, firstGoal], [secondProposal, firstProposal]);
    secondInput.recordedAt = '2026-08-09T13:00:00.000Z';
    const second = captureMissionObservation(secondInput);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.receiptInput.goalSource.digest).toBe(first.receiptInput.goalSource.digest);
    expect(second.receiptInput.proposalSource.digest).toBe(first.receiptInput.proposalSource.digest);
    expect(second.receiptInput.nodes).toEqual(first.receiptInput.nodes);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateHarnessObservations,
  createHarnessObservationAccumulator,
  defineHarnessObservations,
  finalizeHarnessObservations,
  HARNESS_OBSERVATION_OUTCOMES,
  harnessObservationSubjectRef,
  MAX_HARNESS_OBSERVATIONS,
  projectHarnessObservationSequence,
  recordHarnessObservation,
  sanitizeHarnessObservations,
  type HarnessObservationDraftV1,
} from '../src/core/learning/harness-observations.js';
import {
  agentWorkTransitionSubjectRef,
  defineAgentWorkTransitions,
  sandboxedRunAgentWorkTransitions,
} from '../src/core/learning/agent-work-transitions.js';
import { agentRunSemanticEvents } from '../src/core/learning/agent-semantic-events.js';
import {
  harnessObservationOutcomeForToolReturn,
  runTask,
} from '../src/core/run/agent-loop.js';
import { newUsage } from '../src/core/run/budget.js';
import { recordSandboxedRunAgentAction } from '../src/core/run/sandboxed-engine.js';
import {
  readAgentActions,
  recordAgentAction,
  summarizeAgentWorkspace,
} from '../src/core/fleet/agent-action-ledger.js';
import type { ProviderClient, RunTask } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAshlrHome = process.env.ASHLR_HOME;
let home: string;

function restore(name: 'HOME' | 'USERPROFILE' | 'ASHLR_HOME', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function task(goal = 'perform bounded work'): RunTask {
  return { id: 'task-m470', goal, deps: [], status: 'pending' };
}

function drafts(count: number, start = Date.now() - 60_000): HarnessObservationDraftV1[] {
  return Array.from({ length: count }, (_, index) => ({
    actionClass: (['read', 'write', 'exec', 'other'] as const)[index % 4]!,
    outcome: (['returned', 'committed', 'failed', 'unavailable'] as const)[index % 4]!,
    observedAt: new Date(start + index).toISOString(),
  }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m470-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
  restore('ASHLR_HOME', originalAshlrHome);
});

describe('M470 harness-observed execution spine', () => {
  it('records only coarse action and outcome metadata from actual tool execution', async () => {
    let call = 0;
    const client: ProviderClient = {
      id: 'm470-client',
      model: 'qwen3-coder',
      supportsTools: true,
      chat: vi.fn(async () => call++ === 0
        ? {
            content: '',
            toolCalls: [
              { id: 'read-1', name: 'read_file', arguments: { path: '/private/secret.ts' } },
              { id: 'write-1', name: 'write_file', arguments: { path: '/private/output.ts' } },
              { id: 'missing-1', name: 'missing_private_tool', arguments: { token: 'raw-secret' } },
              { id: 'exec-1', name: 'bash', arguments: { command: 'printenv SUPER_SECRET' } },
            ],
            usage: { tokensIn: 10, tokensOut: 5 },
          }
        : { content: 'Implemented and verified.', usage: { tokensIn: 10, tokensOut: 5 } }),
    };
    const observed: Array<{ actionClass: string; outcome: string }> = [];
    const run = task();
    await runTask(run, client, {
      tools: [
        { name: 'read_file', safety: 'read', fn: vi.fn(async () => 'Tool execution error: legitimate file text') },
        { name: 'write_file', safety: 'write', fn: vi.fn(async () => 'wrote /private/output.ts') },
        { name: 'bash', safety: 'exec', fn: vi.fn(async () => 'SUPER_SECRET=raw-secret') },
      ],
      budget: { maxTokens: 100_000, maxSteps: 10, allowCloud: false },
      usage: newUsage(),
      onStep: () => {},
      effectJournal: { scopeId: 'm470-run', generation: 'generation-1' },
      onHarnessObservation: (observation) => observed.push(observation),
    });

    expect(run.status).toBe('failed');
    expect(run.error).toBe('Tool effect authority refused bash: unavailable');
    expect(observed).toEqual([
      { actionClass: 'read', outcome: 'returned' },
      { actionClass: 'write', outcome: 'committed' },
      { actionClass: 'other', outcome: 'unavailable' },
      { actionClass: 'exec', outcome: 'refused' },
    ]);
    expect(JSON.stringify(observed)).not.toMatch(
      /read_file|write_file|missing_private_tool|private|printenv|secret|path|command|argument|result/i,
    );
  });

  it('keeps nonthrowing exec returns uncertain without inspecting or trusting their payloads', () => {
    const accumulator = createHarnessObservationAccumulator();
    recordHarnessObservation(accumulator, {
      actionClass: 'exec',
      outcome: harnessObservationOutcomeForToolReturn('exec'),
    });

    const collection = finalizeHarnessObservations('run-m470-exec-return', accumulator)!;
    expect(collection).toMatchObject({
      retainedCount: 1,
      truncated: false,
      countIsLowerBound: false,
    });
    expect(collection.observations).toEqual([
      expect.objectContaining({ actionClass: 'exec', outcome: 'uncertain' }),
    ]);
    expect(JSON.stringify(collection)).not.toMatch(/private|command|secret|stdout|stderr|exitCode/i);
    expect(harnessObservationOutcomeForToolReturn('read')).toBe('returned');
    expect(harnessObservationOutcomeForToolReturn('write')).toBe('committed');
    expect(harnessObservationOutcomeForToolReturn('exec')).toBe('uncertain');
  });

  it('never projects any exec observation outcome to verification or completion authority', () => {
    for (const outcome of HARNESS_OBSERVATION_OUTCOMES) {
      const runId = `run-m470-exec-${outcome}`;
      const observations = defineHarnessObservations(harnessObservationSubjectRef(runId), [{
        actionClass: 'exec',
        outcome,
        observedAt: new Date().toISOString(),
      }]);
      const transitions = sandboxedRunAgentWorkTransitions({
        runId,
        startedAt: new Date(Date.now() - 1_000).toISOString(),
        observedAt: new Date().toISOString(),
        status: 'done',
        outcomeKind: 'filed',
        harnessObservations: observations,
      });

      expect(transitions, outcome).not.toContainEqual(expect.objectContaining({ phase: 'verify' }));
      expect(transitions, outcome).not.toContainEqual(expect.objectContaining({ phase: 'complete' }));
      expect(transitions, outcome).not.toContainEqual(expect.objectContaining({ transition: 'complete' }));
      expect(transitions, outcome).not.toContainEqual(expect.objectContaining({ trigger: 'evidence-passed' }));
    }

    const runId = 'run-m470-exec-followed-by-write';
    const observations = defineHarnessObservations(harnessObservationSubjectRef(runId), [
      { actionClass: 'exec', outcome: 'failed', observedAt: new Date(Date.now() - 1).toISOString() },
      { actionClass: 'write', outcome: 'committed', observedAt: new Date().toISOString() },
    ]);
    const transitions = sandboxedRunAgentWorkTransitions({
      runId,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      observedAt: new Date().toISOString(),
      status: 'done',
      outcomeKind: 'filed',
      harnessObservations: observations,
    });
    expect(transitions).not.toContainEqual(expect.objectContaining({ phase: 'verify' }));
    expect(transitions).not.toContainEqual(expect.objectContaining({ phase: 'complete' }));
    expect(transitions).not.toContainEqual(expect.objectContaining({ transition: 'complete' }));
    expect(transitions).not.toContainEqual(expect.objectContaining({ trigger: 'evidence-passed' }));
  });

  it('enforces exact schemas, chronological ordinals, and the 16-observation cap', () => {
    const subjectRef = harnessObservationSubjectRef('run-m470-cap');
    const accepted = defineHarnessObservations(subjectRef, drafts(MAX_HARNESS_OBSERVATIONS));
    expect(accepted).toHaveLength(16);
    expect(sanitizeHarnessObservations(accepted, subjectRef)).toEqual(accepted);
    expect(projectHarnessObservationSequence([accepted, accepted], subjectRef)).toEqual({
      state: 'available', observations: accepted,
    });
    expect(() => defineHarnessObservations(subjectRef, drafts(17))).toThrow(/invalid harness observation producer/);
    expect(defineHarnessObservations(subjectRef, [
      { actionClass: 'exec', outcome: 'refused', observedAt: new Date().toISOString() },
      { actionClass: 'write', outcome: 'uncertain', observedAt: new Date().toISOString() },
    ]).map((observation) => observation.outcome)).toEqual(['refused', 'uncertain']);

    const hostile = [{ ...accepted[0], command: 'cat /private/key', stdout: 'raw-secret' }];
    expect(sanitizeHarnessObservations(hostile, subjectRef)).toBeUndefined();
    const transitions = sandboxedRunAgentWorkTransitions({
      runId: 'run-m470-cap',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      observedAt: new Date().toISOString(),
      status: 'failed',
      harnessObservations: accepted,
    });
    expect(transitions).toHaveLength(16);
    expect(transitions[0]?.phase).toBe('orient');
    expect(transitions.at(-1)).toMatchObject({ phase: 'repair', transition: 'block' });
  });

  it('aggregates deferred attempts deterministically and rebinds the final run under cap', () => {
    const start = Date.now() - 120_000;
    const first = defineHarnessObservations(
      harnessObservationSubjectRef('run-m470-attempt-1'),
      drafts(12, start),
    );
    const second = defineHarnessObservations(
      harnessObservationSubjectRef('run-m470-attempt-2'),
      drafts(12, start - 100).map((draft) => ({ ...draft, actionClass: 'exec' as const })),
    );
    const aggregated = aggregateHarnessObservations('run-m470-final', [
      { runId: 'run-m470-attempt-1', observations: first },
      { runId: 'run-m470-attempt-2', observations: second },
    ]);

    expect(aggregated).toMatchObject({
      retainedCount: MAX_HARNESS_OBSERVATIONS,
      truncated: true,
      countIsLowerBound: true,
    });
    expect(aggregated?.observations).toHaveLength(MAX_HARNESS_OBSERVATIONS);
    expect(aggregated?.observations.every((observation) =>
      observation.subjectRef === harnessObservationSubjectRef('run-m470-final'))).toBe(true);
    expect(aggregated?.observations.map((observation) => observation.ordinal)).toEqual(
      Array.from({ length: MAX_HARNESS_OBSERVATIONS }, (_, index) => index + 1),
    );
    expect(aggregated?.observations.slice(0, 8).map((observation) => observation.actionClass)).toEqual(
      first.slice(0, 8).map((observation) => observation.actionClass),
    );
    expect(aggregated?.observations.slice(8).every((observation) =>
      observation.actionClass === 'exec')).toBe(true);
    expect(aggregated?.observations[7]?.observedAt).toBe(new Date(start + 7).toISOString());
    expect(aggregated?.observations[8]?.observedAt).toBe(new Date(start + 11).toISOString());
    expect(aggregateHarnessObservations('run-m470-final', [{
      runId: 'run-m470-attempt-1',
      observations: first,
      totalCount: 20,
      truncated: true,
    } as never])).toBeUndefined();
    expect(aggregateHarnessObservations('run-m470-final', [{
      runId: 'run-m470-attempt-1',
      observations: first,
      retainedCount: 20,
      truncated: false,
      countIsLowerBound: false,
    }])).toBeUndefined();

    const legacy15 = defineHarnessObservations(
      harnessObservationSubjectRef('run-m470-legacy-15'),
      drafts(15, start),
    );
    expect(aggregateHarnessObservations('run-m470-legacy-15-final', [{
      runId: 'run-m470-legacy-15',
      observations: legacy15,
    }])).toMatchObject({
      retainedCount: 15,
      truncated: false,
      countIsLowerBound: false,
    });

    const legacy16 = defineHarnessObservations(
      harnessObservationSubjectRef('run-m470-legacy-16'),
      drafts(MAX_HARNESS_OBSERVATIONS, start),
    );
    expect(aggregateHarnessObservations('run-m470-legacy-16-final', [{
      runId: 'run-m470-legacy-16',
      observations: legacy16,
    }])).toMatchObject({
      retainedCount: MAX_HARNESS_OBSERVATIONS,
      truncated: true,
      countIsLowerBound: true,
    });

    expect(aggregateHarnessObservations('run-m470-final', [{
      runId: 'run-m470-wrong-source',
      observations: first,
    }])).toBeUndefined();
  });

  it('reports truncated observations as a lower bound and clamps decreasing clocks', () => {
    const accumulator = createHarnessObservationAccumulator();
    const start = Date.now() - 60_000;
    for (let index = 0; index < 21; index += 1) {
      recordHarnessObservation(
        accumulator,
        {
          actionClass: (['read', 'write', 'exec'] as const)[index % 3]!,
          outcome: 'returned',
        },
        new Date(start + (index === 12 ? 3 : index)).toISOString(),
      );
    }

    const collection = finalizeHarnessObservations('run-m470-bounded', accumulator)!;
    expect(collection).toMatchObject({
      retainedCount: MAX_HARNESS_OBSERVATIONS,
      truncated: true,
      countIsLowerBound: true,
    });
    expect(`${collection.countIsLowerBound ? '>=' : ''}${collection.retainedCount}`).toBe('>=16');
    expect(collection).not.toHaveProperty('totalCount');
    expect(collection.observations).toHaveLength(MAX_HARNESS_OBSERVATIONS);
    expect(collection.observations.every((observation, index) => index === 0 ||
      Date.parse(observation.observedAt) >= Date.parse(collection.observations[index - 1]!.observedAt))).toBe(true);
    expect(collection.observations[0]?.ordinal).toBe(1);
    expect(collection.observations.at(-1)?.ordinal).toBe(MAX_HARNESS_OBSERVATIONS);

    const malformed = createHarnessObservationAccumulator();
    expect(() => recordHarnessObservation(
      malformed,
      { actionClass: 'read', outcome: 'returned' },
      'not-a-timestamp',
    )).not.toThrow();
    expect(finalizeHarnessObservations('run-m470-malformed', malformed)).toBeUndefined();

    const mismatched = createHarnessObservationAccumulator();
    recordHarnessObservation(mismatched, { actionClass: 'read', outcome: 'returned' });
    mismatched.seenCount = 20;
    expect(finalizeHarnessObservations('run-m470-mismatched', mismatched)).toBeUndefined();
  });

  it('clamps a rolled-back terminal clock and preserves the filed proposal outcome', () => {
    const runId = 'run-m470-terminal-clock';
    const now = Date.now();
    const observations = defineHarnessObservations(harnessObservationSubjectRef(runId), [
      { actionClass: 'read', outcome: 'returned', observedAt: new Date(now + 60_000).toISOString() },
      { actionClass: 'write', outcome: 'committed', observedAt: new Date(now + 60_001).toISOString() },
    ]);
    recordSandboxedRunAgentAction({
      engine: 'local-coder',
      engineModel: 'qwen3-coder',
      tier: 'local',
      runId,
      sourceRepo: '/opaque/repo',
      proposalId: 'proposal-m470-terminal-clock',
      outcome: {
        kind: 'filed',
        proposalId: 'proposal-m470-terminal-clock',
        reason: 'proposal filed',
        files: 1,
      },
      status: 'done',
      startedAt: new Date(now - 1_000).toISOString(),
      actionCounts: {},
      harnessObservations: observations,
      harnessObservationRetainedCount: observations.length,
      harnessObservationsTruncated: false,
      harnessObservationCountIsLowerBound: false,
    });

    const persisted = readAgentActions().find((event) => event.runId === runId)!;
    expect(persisted).toMatchObject({
      proposalId: 'proposal-m470-terminal-clock',
      reason: 'proposal-created',
      runEventSummary: { outcome: 'proposal-created', proposalCreated: true },
      harnessObservationRetainedCount: 2,
      harnessObservationsTruncated: false,
      harnessObservationCountIsLowerBound: false,
    });
    expect(persisted.workTransitions?.at(-1)).toMatchObject({
      phase: 'complete',
      transition: 'complete',
      observedAt: observations.at(-1)?.observedAt,
    });
    expect(persisted.harnessObservationsState).toBeUndefined();
    expect(persisted.workTransitionsState).toBeUndefined();
  });

  it('reconstructs observed lifecycle and maps failed runs to blocked semantics', () => {
    const failedRunId = 'run-m470-failed';
    const now = Date.now();
    const failedObservations = defineHarnessObservations(
      harnessObservationSubjectRef(failedRunId),
      [
        { actionClass: 'read', outcome: 'returned', observedAt: new Date(now - 3_000).toISOString() },
        { actionClass: 'write', outcome: 'failed', observedAt: new Date(now - 2_000).toISOString() },
      ],
    );
    recordSandboxedRunAgentAction({
      engine: 'local-coder',
      engineModel: 'qwen3-coder',
      tier: 'local',
      runId: failedRunId,
      sourceRepo: '/opaque/repo',
      outcome: { kind: 'api-model-task-failed', reason: 'closed failure' },
      status: 'failed',
      startedAt: new Date(now - 4_000).toISOString(),
      actionCounts: {},
      harnessObservations: failedObservations,
    });

    const noProposalRunId = 'run-m470-no-proposal';
    recordSandboxedRunAgentAction({
      engine: 'local-coder',
      engineModel: 'qwen3-coder',
      tier: 'local',
      runId: noProposalRunId,
      sourceRepo: '/opaque/repo',
      outcome: { kind: 'empty-diff', reason: 'closed no proposal' },
      status: 'done',
      startedAt: new Date(now - 1_000).toISOString(),
      actionCounts: {},
    });

    const persisted = readAgentActions();
    const failed = persisted.find((event) => event.runId === failedRunId)!;
    expect(failed.semanticEvents?.find((event) => event.kind === 'action')).toMatchObject({
      actionCode: 'agent.run', status: 'blocked',
    });
    expect(failed.workTransitions?.map((transition) => [transition.phase, transition.transition])).toEqual([
      ['orient', 'enter'],
      ['inspect', 'advance'],
      ['repair', 'replan'],
      ['repair', 'block'],
    ]);

    const workspace = summarizeAgentWorkspace(persisted);
    expect(workspace.peerStates?.find((peer) => peer.runId === failedRunId)).toMatchObject({
      phase: 'repair', actionCount: 2, actionCountIsLowerBound: false,
      replanCount: 1, semanticHarnessConsistency: 'unavailable',
    });
    expect(workspace.peerStates?.find((peer) => peer.runId === noProposalRunId)).toMatchObject({
      phase: 'repair', actionCount: 0, actionCountIsLowerBound: false,
      replanCount: 1, semanticHarnessConsistency: 'unavailable',
    });

  });

  it('rejects cross-run observations before derivation and ledger ingestion', () => {
    const sourceRunId = 'run-m470-source';
    const carrierRunId = 'run-m470-carrier';
    const now = Date.now();
    const crossRun = defineHarnessObservations(harnessObservationSubjectRef(sourceRunId), [
      { actionClass: 'write', outcome: 'committed', observedAt: new Date(now - 500).toISOString() },
    ]);
    const filtered = sandboxedRunAgentWorkTransitions({
      runId: carrierRunId,
      startedAt: new Date(now - 1_000).toISOString(),
      observedAt: new Date(now).toISOString(),
      status: 'failed',
      harnessObservations: crossRun,
    });
    expect(filtered).toHaveLength(2);

    recordAgentAction({
      schemaVersion: 1,
      ts: new Date(now).toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'failed',
      action: 'sandboxed-engine:run',
      summary: 'closed cross-run fixture',
      runId: carrierRunId,
      runEventSummary: { runId: carrierRunId, status: 'failed' },
      harnessObservations: crossRun,
      workTransitions: filtered,
    });
    expect(readAgentActions()[0]).toMatchObject({
      runId: carrierRunId,
      harnessObservationsState: 'rejected',
      workTransitionsState: 'rejected',
    });
  });

  it('rejects fabricated transitions that contradict canonical observation derivation', () => {
    const runId = 'run-m470-contradictory';
    const now = Date.now();
    const observedAt = new Date(now - 500).toISOString();
    const observations = defineHarnessObservations(harnessObservationSubjectRef(runId), [
      { actionClass: 'read', outcome: 'returned', observedAt },
    ]);
    const fabricated = defineAgentWorkTransitions(agentWorkTransitionSubjectRef('run', runId), [
      { phase: 'orient', transition: 'enter', trigger: 'initial', observedAt: new Date(now - 1_000).toISOString() },
      { phase: 'edit', transition: 'advance', trigger: 'unknown', observedAt },
      { phase: 'repair', transition: 'block', trigger: 'unknown', observedAt: new Date(now).toISOString() },
    ]);
    recordAgentAction({
      schemaVersion: 1,
      ts: new Date(now).toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'failed',
      action: 'sandboxed-engine:run',
      summary: 'closed contradictory fixture',
      runId,
      reason: 'api-model-task-failed',
      runEventSummary: { runId, status: 'failed', outcome: 'api-model-task-failed' },
      semanticEvents: agentRunSemanticEvents({ runId, model: 'qwen3-coder', status: 'failed' }),
      harnessObservations: observations,
      workTransitions: fabricated,
    });

    const persisted = readAgentActions()[0]!;
    expect(persisted.harnessObservations).toBeUndefined();
    expect(persisted.harnessObservationsState).toBe('rejected');
    expect(persisted.workTransitions).toBeUndefined();
    expect(persisted.workTransitionsState).toBe('rejected');
    expect(summarizeAgentWorkspace(readAgentActions())).toMatchObject({
      peerStatesState: 'withheld', peerStates: [],
    });
  });

  it('rejects a valid observation prefix with a forged terminal when status is missing', () => {
    const runId = 'run-m470-missing-status';
    const now = Date.now();
    const observations = defineHarnessObservations(harnessObservationSubjectRef(runId), [
      { actionClass: 'read', outcome: 'returned', observedAt: new Date(now - 500).toISOString() },
    ]);
    const forgedTerminal = sandboxedRunAgentWorkTransitions({
      runId,
      startedAt: new Date(now - 1_000).toISOString(),
      observedAt: new Date(now).toISOString(),
      status: 'done',
      harnessObservations: observations,
    });
    recordAgentAction({
      schemaVersion: 1,
      ts: new Date(now).toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'ok',
      action: 'sandboxed-engine:run',
      summary: 'closed missing-status fixture',
      runId,
      runEventSummary: { runId },
      harnessObservations: observations,
      workTransitions: forgedTerminal,
    });

    expect(readAgentActions()[0]).toMatchObject({
      runId,
      harnessObservationsState: 'rejected',
      workTransitionsState: 'rejected',
    });
    expect(readAgentActions()[0]?.harnessObservations).toBeUndefined();
    expect(readAgentActions()[0]?.workTransitions).toBeUndefined();
    expect(summarizeAgentWorkspace(readAgentActions())).toMatchObject({
      peerStatesState: 'withheld', peerStates: [],
    });
  });

  it('accepts coupled observations and full canonical transitions with valid status', () => {
    const runId = 'run-m470-valid-status';
    const now = Date.now();
    const observations = defineHarnessObservations(
      harnessObservationSubjectRef(runId),
      Array.from({ length: MAX_HARNESS_OBSERVATIONS }, (_, index) => ({
        actionClass: index % 2 === 0 ? 'read' as const : 'write' as const,
        outcome: index % 2 === 0 ? 'returned' as const : 'committed' as const,
        observedAt: new Date(now - 500 + index).toISOString(),
      })),
    );
    const transitions = sandboxedRunAgentWorkTransitions({
      runId,
      startedAt: new Date(now - 1_000).toISOString(),
      observedAt: new Date(now).toISOString(),
      status: 'done',
      outcomeKind: 'filed',
      harnessObservations: observations,
    });
    recordAgentAction({
      schemaVersion: 1,
      ts: new Date(now).toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'proposal-created',
      action: 'sandboxed-engine:run',
      summary: 'closed valid-status fixture',
      runId,
      proposalId: 'proposal-m470-valid-status',
      reason: 'filed',
      runEventSummary: { runId, status: 'done', outcome: 'proposal-created' },
      harnessObservations: observations,
      harnessObservationRetainedCount: MAX_HARNESS_OBSERVATIONS,
      harnessObservationsTruncated: true,
      harnessObservationCountIsLowerBound: true,
      workTransitions: transitions,
    });

    const persisted = readAgentActions()[0]!;
    expect(persisted.harnessObservations).toEqual(observations);
    expect(persisted.workTransitions).toEqual(transitions);
    expect(summarizeAgentWorkspace(readAgentActions())).toMatchObject({
      peerStatesState: 'available',
      peerStates: [{
        runId,
        phase: 'complete',
        transition: 'complete',
        actionCount: MAX_HARNESS_OBSERVATIONS,
        actionCountIsLowerBound: true,
        actionObservationsTruncated: true,
        semanticHarnessConsistency: 'unavailable',
      }],
    });
  });

  it('normalizes legacy ledger batches below the cap as exact and at the cap as lower-bound', () => {
    const now = Date.now();
    for (const count of [15, MAX_HARNESS_OBSERVATIONS]) {
      const runId = `run-m470-legacy-ledger-${count}`;
      const observations = defineHarnessObservations(
        harnessObservationSubjectRef(runId),
        Array.from({ length: count }, (_, index) => ({
          actionClass: index % 2 === 0 ? 'read' as const : 'write' as const,
          outcome: index % 2 === 0 ? 'returned' as const : 'committed' as const,
          observedAt: new Date(now - 500 + index).toISOString(),
        })),
      );
      const transitions = sandboxedRunAgentWorkTransitions({
        runId,
        startedAt: new Date(now - 1_000).toISOString(),
        observedAt: new Date(now).toISOString(),
        status: 'done',
        harnessObservations: observations,
      });
      recordAgentAction({
        schemaVersion: 1,
        ts: new Date(now + count).toISOString(),
        actor: 'agent',
        kind: 'maintenance',
        outcome: 'ok',
        action: 'sandboxed-engine:run',
        summary: 'closed legacy observation metadata fixture',
        runId,
        runEventSummary: { runId, status: 'done' },
        harnessObservations: observations,
        workTransitions: transitions,
      });
    }

    const events = readAgentActions();
    expect(events.find((event) => event.runId === 'run-m470-legacy-ledger-15')).toMatchObject({
      harnessObservationRetainedCount: 15,
      harnessObservationsTruncated: false,
      harnessObservationCountIsLowerBound: false,
    });
    expect(events.find((event) => event.runId === 'run-m470-legacy-ledger-16')).toMatchObject({
      harnessObservationRetainedCount: MAX_HARNESS_OBSERVATIONS,
      harnessObservationsTruncated: true,
      harnessObservationCountIsLowerBound: true,
    });

    const workspace = summarizeAgentWorkspace(events);
    expect(workspace.peerStates?.find((peer) => peer.runId === 'run-m470-legacy-ledger-15')).toMatchObject({
      actionCount: 15,
      actionCountIsLowerBound: false,
      actionObservationsTruncated: false,
    });
    expect(workspace.peerStates?.find((peer) => peer.runId === 'run-m470-legacy-ledger-16')).toMatchObject({
      actionCount: MAX_HARNESS_OBSERVATIONS,
      actionCountIsLowerBound: true,
      actionObservationsTruncated: true,
    });
  });

  it('rejects forged exact totals and retained-count mismatches at ledger ingestion', () => {
    const runId = 'run-m470-retained-mismatch';
    const now = Date.now();
    const observations = defineHarnessObservations(harnessObservationSubjectRef(runId), [
      { actionClass: 'read', outcome: 'returned', observedAt: new Date(now - 500).toISOString() },
    ]);
    const transitions = sandboxedRunAgentWorkTransitions({
      runId,
      startedAt: new Date(now - 1_000).toISOString(),
      observedAt: new Date(now).toISOString(),
      status: 'done',
      harnessObservations: observations,
    });
    recordAgentAction({
      schemaVersion: 1,
      ts: new Date(now).toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'ok',
      action: 'sandboxed-engine:run',
      summary: 'closed retained mismatch fixture',
      runId,
      runEventSummary: { runId, status: 'done' },
      harnessObservations: observations,
      harnessObservationCount: 20,
      harnessObservationsTruncated: true,
      workTransitions: transitions,
    } as never);

    expect(readAgentActions()[0]).toMatchObject({
      runId,
      harnessObservationsState: 'rejected',
      workTransitionsState: 'rejected',
    });
    expect(readAgentActions()[0]).not.toHaveProperty('harnessObservationCount');
    expect(readAgentActions()[0]?.harnessObservationRetainedCount).toBeUndefined();
    expect(readAgentActions()[0]?.harnessObservations).toBeUndefined();

    recordAgentAction({
      schemaVersion: 1,
      ts: new Date(now + 1).toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'ok',
      action: 'sandboxed-engine:run',
      summary: 'closed retained mismatch fixture',
      runId: `${runId}-retained`,
      runEventSummary: { runId: `${runId}-retained`, status: 'done' },
      harnessObservations: defineHarnessObservations(harnessObservationSubjectRef(`${runId}-retained`), [{
        actionClass: 'read',
        outcome: 'returned',
        observedAt: new Date(now - 500).toISOString(),
      }]),
      harnessObservationRetainedCount: 20,
      harnessObservationsTruncated: false,
      harnessObservationCountIsLowerBound: false,
    });
    const retainedMismatch = readAgentActions().find((event) => event.runId === `${runId}-retained`);
    expect(retainedMismatch).toMatchObject({
      runId: `${runId}-retained`,
      harnessObservationsState: 'rejected',
    });
    expect(retainedMismatch?.harnessObservationRetainedCount).toBeUndefined();
  });

  it('rejects raw-field injection and withholds affected peer-state projections', () => {
    const runId = 'run-m470-hostile';
    const subjectRef = harnessObservationSubjectRef(runId);
    const valid = defineHarnessObservations(subjectRef, drafts(1));
    recordAgentAction({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      actor: 'agent',
      kind: 'maintenance',
      outcome: 'failed',
      action: 'sandboxed-engine:run',
      summary: 'raw-secret /private/path stdout',
      runId,
      harnessObservations: [{
        ...valid[0]!,
        command: 'cat /private/path',
        result: 'raw-secret',
      }] as never,
      workTransitions: sandboxedRunAgentWorkTransitions({
        runId,
        startedAt: new Date(Date.now() - 1_000).toISOString(),
        observedAt: new Date().toISOString(),
        status: 'failed',
      }),
    });

    const persisted = readAgentActions();
    expect(persisted[0]?.harnessObservations).toBeUndefined();
    expect(persisted[0]?.harnessObservationsState).toBe('rejected');
    expect(JSON.stringify(persisted)).not.toMatch(/raw-secret|private\/path|stdout|command|result/i);
    expect(summarizeAgentWorkspace(persisted)).toMatchObject({
      peerStatesState: 'withheld', peerStates: [],
    });
  });
});

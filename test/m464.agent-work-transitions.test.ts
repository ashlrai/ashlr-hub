import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_WORK_PHASES,
  AGENT_WORK_TRANSITIONS,
  AGENT_WORK_TRIGGERS,
  agentWorkTransitionId,
  agentWorkTransitionSubjectRef,
  defineAgentWorkTransitions,
  projectAgentWorkTransitionSequence,
  sanitizeAgentWorkTransitions,
  sandboxedRunAgentWorkTransitions,
} from '../src/core/learning/agent-work-transitions.js';
import {
  agentActionsDir,
  readAgentActions,
  readAgentWorkspaceDetailed,
  recordAgentAction,
  summarizeAgentWorkspace,
  type AgentActionEvent,
} from '../src/core/fleet/agent-action-ledger.js';
import {
  agentWorkTransitionsFromRepairHandoff,
  repairHandoffFromDispatchEvent,
} from '../src/core/fleet/repair-handoff-journal.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAshlrHome = process.env.ASHLR_HOME;
const STARTED_AT = '2026-07-28T12:00:00.000Z';
const OBSERVED_AT = '2026-07-28T12:01:00.000Z';
let home: string;

function restore(name: 'HOME' | 'USERPROFILE' | 'ASHLR_HOME', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function action(
  runId: string,
  workTransitions = sandboxedRunAgentWorkTransitions({
    runId,
    startedAt: STARTED_AT,
    observedAt: OBSERVED_AT,
    status: 'done',
    outcomeKind: 'empty-diff',
  }),
  ts = OBSERVED_AT,
): AgentActionEvent {
  return {
    schemaVersion: 1,
    ts,
    actor: 'agent',
    kind: 'maintenance',
    outcome: 'no-proposal',
    action: 'sandboxed-engine:run',
    summary: 'closed metadata carrier',
    runId,
    workTransitions,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m464-'));
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

describe('M464 metadata-only agent work transitions', () => {
  it('uses only the audited closed vocabularies and deterministic exact-key identities', () => {
    expect(AGENT_WORK_PHASES).toEqual([
      'orient', 'inspect', 'edit', 'verify', 'repair', 'handoff', 'complete',
    ]);
    expect(AGENT_WORK_TRANSITIONS).toEqual([
      'enter', 'advance', 'retry', 'replan', 'block', 'handoff', 'complete',
    ]);
    expect(AGENT_WORK_TRIGGERS).toEqual([
      'initial', 'evidence-passed', 'evidence-failed', 'empty-diff', 'capture-blocked',
      'dependency-unavailable', 'resource-unavailable', 'authority-blocked', 'lease-lost',
      'peer-handoff', 'unknown',
    ]);

    const subjectRef = agentWorkTransitionSubjectRef('run', 'run-m464-deterministic');
    const transitions = defineAgentWorkTransitions(subjectRef, [
      { phase: 'orient', transition: 'enter', trigger: 'initial', observedAt: STARTED_AT },
      { phase: 'repair', transition: 'replan', trigger: 'empty-diff', observedAt: OBSERVED_AT },
    ]);
    const repeated = defineAgentWorkTransitions(subjectRef, [
      { phase: 'orient', transition: 'enter', trigger: 'initial', observedAt: STARTED_AT },
      { phase: 'repair', transition: 'replan', trigger: 'empty-diff', observedAt: OBSERVED_AT },
    ]);

    expect(repeated).toEqual(transitions);
    expect(sanitizeAgentWorkTransitions(transitions, subjectRef)).toEqual(transitions);
    expect(Object.keys(transitions[0]!).sort()).toEqual([
      'observedAt', 'ordinal', 'phase', 'producerVersion', 'schemaVersion', 'subjectRef',
      'transition', 'transitionId', 'trigger',
    ]);
    expect(Object.keys(transitions[1]!).sort()).toEqual([
      'observedAt', 'ordinal', 'phase', 'predecessorTransitionId', 'producerVersion',
      'schemaVersion', 'subjectRef', 'transition', 'transitionId', 'trigger',
    ]);
    const { transitionId, ...unsigned } = transitions[1]!;
    expect(agentWorkTransitionId(unsigned)).toBe(transitionId);
  });

  it('rejects raw-content keys, paths, prose subjects, and non-canonical timestamps', () => {
    const [transition] = defineAgentWorkTransitions(
      agentWorkTransitionSubjectRef('run', 'run-m464-private'),
      [{ phase: 'orient', transition: 'enter', trigger: 'initial', observedAt: STARTED_AT }],
    );
    const forbidden = [
      'prompt', 'rationale', 'toolArgs', 'toolResults', 'diff', 'stdout', 'stderr',
      'env', 'fileContents', 'path', 'rawSummary',
    ];
    for (const key of forbidden) {
      expect(sanitizeAgentWorkTransitions([{ ...transition, [key]: `RAW_${key}` }]))
        .toBeUndefined();
    }
    expect(() => agentWorkTransitionSubjectRef('run', '/tmp/private-repo')).toThrow();
    expect(() => agentWorkTransitionSubjectRef('run', 'model rationale prose')).toThrow();
    expect(sanitizeAgentWorkTransitions([{
      ...transition,
      observedAt: '2026-07-28T12:00:00Z',
    }])).toBeUndefined();
    expect(JSON.stringify(transition)).not.toMatch(
      /prompt|rationale|toolArgs|toolResults|diff|stdout|stderr|env|fileContents|path|rawSummary/,
    );
  });

  it('classifies deterministic aborted outcomes before the generic unknown fallback', () => {
    const sandboxUnavailable = sandboxedRunAgentWorkTransitions({
      runId: 'run-m464-aborted-sandbox',
      startedAt: STARTED_AT,
      observedAt: OBSERVED_AT,
      status: 'aborted',
      outcomeKind: 'sandbox-unavailable',
    });
    const engineMissing = sandboxedRunAgentWorkTransitions({
      runId: 'run-m464-aborted-engine',
      startedAt: STARTED_AT,
      observedAt: OBSERVED_AT,
      status: 'aborted',
      outcomeKind: 'engine-command-missing',
    });
    const genericAbort = sandboxedRunAgentWorkTransitions({
      runId: 'run-m464-aborted-generic',
      startedAt: STARTED_AT,
      observedAt: OBSERVED_AT,
      status: 'aborted',
    });
    const partialAbort = sandboxedRunAgentWorkTransitions({
      runId: 'run-m464-aborted-partial',
      startedAt: STARTED_AT,
      observedAt: OBSERVED_AT,
      status: 'aborted',
      outcomeKind: 'engine-failed-no-diff',
      isPartial: true,
    });
    const gateAbort = sandboxedRunAgentWorkTransitions({
      runId: 'run-m464-aborted-gate',
      startedAt: STARTED_AT,
      observedAt: OBSERVED_AT,
      status: 'aborted',
      outcomeKind: 'completeness-gate',
    });

    expect(sandboxUnavailable[1]).toMatchObject({
      phase: 'repair',
      transition: 'block',
      trigger: 'resource-unavailable',
    });
    expect(engineMissing[1]).toMatchObject({
      phase: 'repair',
      transition: 'block',
      trigger: 'dependency-unavailable',
    });
    expect(genericAbort[1]).toMatchObject({
      phase: 'repair',
      transition: 'block',
      trigger: 'unknown',
    });
    expect(partialAbort[1]).toMatchObject({
      phase: 'repair',
      transition: 'replan',
      trigger: 'evidence-failed',
    });
    expect(gateAbort[1]).toMatchObject({
      phase: 'repair',
      transition: 'replan',
      trigger: 'evidence-failed',
    });
  });

  it('accepts replayed complete snapshots and withholds ordering or ordinal conflicts', () => {
    const subjectRef = agentWorkTransitionSubjectRef('run', 'run-m464-conflict');
    const emptyDiff = defineAgentWorkTransitions(subjectRef, [
      { phase: 'orient', transition: 'enter', trigger: 'initial', observedAt: STARTED_AT },
      { phase: 'repair', transition: 'replan', trigger: 'empty-diff', observedAt: OBSERVED_AT },
    ]);
    const captureBlocked = defineAgentWorkTransitions(subjectRef, [
      { phase: 'orient', transition: 'enter', trigger: 'initial', observedAt: STARTED_AT },
      { phase: 'repair', transition: 'replan', trigger: 'capture-blocked', observedAt: OBSERVED_AT },
    ]);

    expect(projectAgentWorkTransitionSequence([emptyDiff, emptyDiff], subjectRef)).toEqual({
      state: 'available',
      transitions: emptyDiff,
    });
    expect(projectAgentWorkTransitionSequence([emptyDiff, captureBlocked], subjectRef)).toEqual({
      state: 'withheld',
      transitions: [],
    });
    expect(sanitizeAgentWorkTransitions([...emptyDiff].reverse(), subjectRef)).toBeUndefined();
    expect(sanitizeAgentWorkTransitions([
      emptyDiff[0],
      { ...emptyDiff[1], predecessorTransitionId: emptyDiff[1]!.transitionId },
    ], subjectRef)).toBeUndefined();
  });

  it('persists unchanged harness identities and projects only conflict-free latest peer state', () => {
    const runId = 'run-m464-workspace';
    const emptyDiff = action(runId);
    recordAgentAction([emptyDiff, { ...emptyDiff }]);

    const persisted = readAgentActions();
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.workTransitions).toEqual(emptyDiff.workTransitions);
    expect(summarizeAgentWorkspace(persisted)).toMatchObject({
      peerStatesState: 'available',
      peerStates: [{
        runId,
        phase: 'repair',
        transition: 'replan',
        trigger: 'empty-diff',
        ordinal: 2,
        replanCount: 1,
        latestAt: OBSERVED_AT,
      }],
    });

    const conflict = sandboxedRunAgentWorkTransitions({
      runId,
      startedAt: STARTED_AT,
      observedAt: OBSERVED_AT,
      status: 'failed',
      outcomeKind: 'proposal-capture-error',
    });
    expect(summarizeAgentWorkspace([emptyDiff, action(runId, conflict)])).toMatchObject({
      peerStatesState: 'withheld',
      peerStates: [],
    });
  });

  it('rejects carrier mismatches and withholds peer state on degraded physical sources', () => {
    const supplied = action('run-m464-supplied').workTransitions!;
    recordAgentAction(action('run-m464-carrier', supplied));
    expect(readAgentActions()[0]).toMatchObject({
      runId: 'run-m464-carrier',
      workTransitionsState: 'rejected',
    });
    expect(readAgentWorkspaceDetailed({ windowMs: 48 * 60 * 60 * 1000 }).workspace)
      .toMatchObject({ peerStatesState: 'withheld', peerStates: [] });

    const now = new Date().toISOString();
    const startedAt = new Date(Date.parse(now) - 1_000).toISOString();
    recordAgentAction(action(
      'run-m464-degraded',
      sandboxedRunAgentWorkTransitions({
        runId: 'run-m464-degraded',
        startedAt,
        observedAt: now,
        status: 'done',
        outcomeKind: 'filed',
      }),
      now,
    ));
    fs.appendFileSync(
      path.join(agentActionsDir(), `${now.slice(0, 10)}.jsonl`),
      `${JSON.stringify({ schemaVersion: 1, invalid: true })}\n`,
    );
    const detailed = readAgentWorkspaceDetailed({ windowMs: 48 * 60 * 60 * 1000 });
    expect(detailed.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(detailed.workspace).toMatchObject({ peerStatesState: 'withheld', peerStates: [] });
  });

  it('adapts durable repair handoffs into child observations without inheriting authority', () => {
    const runId = 'run-m464-repair-parent';
    const parent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: OBSERVED_AT,
      itemId: 'm464-parent-item',
      source: 'goal',
      repo: process.cwd(),
      title: 'opaque',
      backend: 'local-coder',
      tier: 'local',
      assignedBy: 'test',
      routeReason: 'capture repair',
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      runId,
      trajectoryId: `run:${runId}`,
      objectiveHash: 'a'.repeat(64),
      diffFiles: 1,
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    };
    const observation = repairHandoffFromDispatchEvent(parent);
    expect(observation).not.toBeNull();
    const transitions = agentWorkTransitionsFromRepairHandoff(observation!);
    expect(transitions).toEqual([
      expect.objectContaining({
        phase: 'handoff',
        transition: 'handoff',
        trigger: 'capture-blocked',
        parentSubjectRef: `run:${runId}`,
        subjectRef: `trajectory:repair:${observation!.generationId}`,
      }),
    ]);
    expect(JSON.stringify(transitions)).not.toContain(process.cwd());
  });
});

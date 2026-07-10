/**
 * m354.trajectory-records.test.ts — read-only route-to-outcome timelines.
 */

import { describe, expect, it } from 'vitest';
import {
  listTrajectoryRecords,
  summarizeTrajectoryLearning,
  type TrajectoryRecordReadDeps,
} from '../src/core/autonomy/trajectory-records.js';
import type { OutcomeRecord } from '../src/core/autonomy/outcome-records.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import type { AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import { ROUTER_POLICY_VERSION } from '../src/core/learning/causal.js';

const TS0 = '2026-07-09T12:00:00.000Z';
const TS1 = '2026-07-09T12:01:00.000Z';
const TS2 = '2026-07-09T12:02:00.000Z';
const TS3 = '2026-07-09T12:03:00.000Z';
const TS4 = '2026-07-09T12:04:00.000Z';
const REPO = '/tmp/ashlr-hub-fixture';
const RAW_SECRET = 'RAW_EVIDENCE_SECRET_SHOULD_NOT_LEAK';
const DIFF_SECRET = 'diff --git a/secret.ts b/secret.ts';
const STDOUT_SECRET = 'stdout contained literal-secret-value';

function dispatch(overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: TS0,
    itemId: 'item-1',
    source: 'goal',
    repo: REPO,
    title: 'Add elite verifier coverage',
    backend: 'local-coder',
    tier: 'local',
    model: 'qwen',
    assignedBy: 'test',
    routeReason: `route with ${RAW_SECRET}`,
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId: 'prop-1',
    runId: 'run-1',
    trajectoryId: 'traj-1',
    routeSnapshot: {
      backend: 'local-coder',
      tier: 'local',
      model: 'qwen',
      assignedBy: 'test',
      reason: 'metadata route snapshot',
      routerPolicyVersion: ROUTER_POLICY_VERSION,
    },
    runEventSummary: {
      runId: 'run-1',
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-1',
      diffFiles: 2,
      diffLines: 24,
      actionCounts: { proposalCreated: 1, diffFiles: 2 },
    },
    evidenceOutcome: {
      target: 'proposal',
      trustBasis: 'verification',
      riskClass: 'low',
      verificationPassed: true,
      policyAllowed: true,
      gateCount: 5,
    },
    learningSource: 'dispatch-production',
    labelBasis: 'run-proposal-outcome',
    routerPolicyVersion: ROUTER_POLICY_VERSION,
    learningEpoch: '2026-07-09',
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    ...overrides,
  };
}

function action(overrides: Partial<AgentActionEvent> = {}): AgentActionEvent {
  return {
    schemaVersion: 1,
    ts: TS4,
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'proposal-created',
    action: 'daemon:dispatch',
    summary: `agent action ${STDOUT_SECRET}`,
    repo: REPO,
    itemId: 'item-1',
    source: 'goal',
    proposalId: 'prop-1',
    runId: 'run-1',
    trajectoryId: 'traj-1',
    backend: 'local-coder',
    tier: 'local',
    model: 'qwen',
    routerPolicyVersion: ROUTER_POLICY_VERSION,
    learningEpoch: '2026-07-09',
    ...overrides,
  };
}

function outcomeRecord(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    version: 1,
    proposal: {
      id: 'prop-1',
      repo: REPO,
      origin: 'agent',
      kind: 'patch',
      status: 'pending',
      title: 'Verifier proposal',
      createdAt: TS1,
      workItemId: 'item-1',
      workSource: 'goal',
      runId: 'run-1',
      trajectoryId: 'traj-1',
      riskClass: 'low',
      verifyResult: { passed: true, commands: ['npm test'], source: 'manual' },
      diffHash: 'sha256:diff-1',
      routeSnapshot: {
        backend: 'local-coder',
        tier: 'local',
        model: 'qwen',
        routerPolicyVersion: ROUTER_POLICY_VERSION,
      },
      runEventSummary: {
        runId: 'run-1',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-1',
      },
      evidenceOutcome: {
        target: 'proposal',
        trustBasis: 'verification',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
      },
      learningSource: 'proposal-outcome',
      labelBasis: 'proposal-status',
      routerPolicyVersion: ROUTER_POLICY_VERSION,
      learningEpoch: '2026-07-09',
    },
    lastActivityAt: TS3,
    evidencePacks: [{
      generatedAt: TS2,
      target: 'proposal',
      trustBasis: 'verification',
      riskClass: 'low',
      policy: {
        tier: 'docs-only',
        action: 'allow',
        allowed: true,
        reason: RAW_SECRET,
      },
      gates: {
        authority: { ok: true, detail: RAW_SECRET },
        provenance: { ok: true, detail: RAW_SECRET },
        verification: { ok: true, detail: `${RAW_SECRET} ${DIFF_SECRET}` },
        risk: { ok: true, detail: RAW_SECRET },
        scope: { ok: true, detail: RAW_SECRET },
      },
      verification: {
        passed: true,
        detail: `${RAW_SECRET} ${STDOUT_SECRET}`,
        commandKinds: ['typecheck', 'test'],
        baseBranch: 'main',
        baseHead: 'abc123',
        diffHash: 'sha256:diff-1',
        verifiedAt: TS2,
        source: 'contract',
      },
      trajectoryId: 'traj-1',
      routerPolicyVersion: ROUTER_POLICY_VERSION,
      learningEpoch: '2026-07-09',
    }],
    decisions: [{
      ts: TS3,
      proposalId: 'prop-1',
      action: 'merged',
      verdict: 'ship',
      reason: `decision ${RAW_SECRET}`,
      workItemId: 'item-1',
      workSource: 'goal',
      runId: 'run-1',
      trajectoryId: 'traj-1',
      engine: 'codex',
      model: 'gpt-5.5',
      routerPolicyVersion: ROUTER_POLICY_VERSION,
      learningEpoch: '2026-07-09',
    }],
    judgeTraces: [],
    workedEvents: [],
    ...overrides,
  };
}

function deps(overrides: Partial<TrajectoryRecordReadDeps> = {}): TrajectoryRecordReadDeps {
  return {
    readDispatchProductionEvents: () => [dispatch()],
    listOutcomeRecords: () => [outcomeRecord()],
    readAgentActions: () => [action()],
    ...overrides,
  };
}

describe('Trajectory records', () => {
  it('joins dispatch, proposal, evidence, decision, and agent action into one ordered trajectory', () => {
    const [record] = listTrajectoryRecords({ windowHours: 1000, deps: deps() });

    expect(record).toMatchObject({
      id: 'trajectory:traj-1',
      terminalOutcome: 'merged',
      repo: REPO,
      itemId: 'item-1',
      source: 'goal',
      proposalId: 'prop-1',
      runId: 'run-1',
      trajectoryId: 'traj-1',
      backend: 'local-coder',
      tier: 'local',
      model: 'qwen',
      routerPolicyVersion: ROUTER_POLICY_VERSION,
      learningEpoch: '2026-07-09',
      coverage: {
        dispatch: true,
        proposal: true,
        evidence: true,
        decision: true,
        agentAction: true,
      },
    });
    expect(record?.timeline.map((event) => event.kind)).toEqual([
      'dispatch',
      'proposal',
      'evidence',
      'decision',
      'agent-action',
    ]);
    expect(record?.timeline[2]).toMatchObject({
      kind: 'evidence',
      outcome: 'passed',
      evidence: {
        target: 'proposal',
        trustBasis: 'verification',
        riskClass: 'low',
        verificationPassed: true,
        commandKinds: ['typecheck', 'test'],
        baseBranch: 'main',
        baseHead: 'abc123',
        diffHash: 'sha256:diff-1',
        verifiedAt: TS2,
        source: 'contract',
        policyAllowed: true,
      },
    });
  });

  it('does not expose raw evidence details, diffs, stdout, or gate text', () => {
    const records = listTrajectoryRecords({ windowHours: 1000, deps: deps() });
    const json = JSON.stringify(records);

    expect(json).not.toContain(RAW_SECRET);
    expect(json).not.toContain(DIFF_SECRET);
    expect(json).not.toContain(STDOUT_SECRET);
    expect(json).not.toContain('npm test');
  });

  it('keeps no-proposal attempts visible without treating derived work ids as strong trajectories', () => {
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({
            itemId: 'item-no-proposal',
            outcome: 'proposal-disabled',
            proposalCreated: false,
            proposalId: undefined,
            runId: undefined,
            trajectoryId: 'work:item-no-proposal',
          }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [
          action({
            itemId: 'item-no-proposal',
            proposalId: undefined,
            runId: undefined,
            trajectoryId: 'work:item-no-proposal',
          }),
        ],
      }),
    });

    expect(record).toMatchObject({
      terminalOutcome: 'no-proposal',
      itemId: 'item-no-proposal',
      coverage: {
        dispatch: true,
        proposal: false,
        evidence: false,
        decision: false,
        agentAction: false,
      },
    });
    expect(record?.id.startsWith('attempt:')).toBe(true);
    expect(record?.trajectoryId).toBeUndefined();
  });

  it('keeps orphaned proposal records pending when no final decision exists', () => {
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [outcomeRecord({
          decisions: [],
          evidencePacks: [],
        })],
        readAgentActions: () => [],
      }),
    });

    expect(record).toMatchObject({
      id: 'trajectory:traj-1',
      terminalOutcome: 'pending',
      coverage: {
        dispatch: false,
        proposal: true,
        evidence: false,
        decision: false,
        agentAction: false,
      },
    });
  });

  it('excludes historical proposal-only records outside the requested window', () => {
    const recentAt = new Date(Date.now() - 60_000).toISOString();
    const historicalAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const proposalOnlyRecord = (id: string, createdAt: string): OutcomeRecord => {
      const base = outcomeRecord();
      return {
        ...base,
        proposal: {
          ...base.proposal,
          id,
          createdAt,
          runId: undefined,
          trajectoryId: undefined,
        },
        lastActivityAt: createdAt,
        evidencePacks: [],
        decisions: [],
      };
    };

    const records = listTrajectoryRecords({
      windowHours: 24,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [
          proposalOnlyRecord('prop-recent-window', recentAt),
          proposalOnlyRecord('prop-historical-window', historicalAt),
        ],
        readAgentActions: () => [],
      }),
    });

    expect(records.map((record) => record.proposalId)).toEqual(['prop-recent-window']);
    expect(records[0]?.latestAt).toBe(recentAt);
  });

  it('summarizes trajectory reconstruction without leaking direct ids', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch(),
          dispatch({
            itemId: 'item-no-proposal',
            outcome: 'empty-diff',
            proposalCreated: false,
            proposalId: undefined,
            runId: 'run-empty',
            trajectoryId: 'traj-empty',
          }),
        ],
        listOutcomeRecords: () => [outcomeRecord()],
        readAgentActions: () => [action()],
      }),
    });

    const summary = summarizeTrajectoryLearning(records, 24);

    expect(summary).toMatchObject({
      version: 1,
      windowHours: 24,
      trajectories: 2,
      terminalOutcomes: {
        merged: 1,
        'no-proposal': 1,
      },
      coverage: {
        dispatch: { count: 2, rate: 1 },
        proposal: { count: 1, rate: 0.5 },
        evidence: { count: 1, rate: 0.5 },
        decision: { count: 1, rate: 0.5 },
        agentAction: { count: 1, rate: 0.5 },
      },
      routeSpine: {
        dispatchToDecision: { count: 1, rate: 0.5 },
        dispatchToEvidence: { count: 1, rate: 0.5 },
        dispatchToMerge: { count: 1, rate: 0.5 },
      },
    });
    expect(summary.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'proposal', count: 1 }),
        expect.objectContaining({ kind: 'evidence', count: 1 }),
        expect.objectContaining({ kind: 'decision', count: 1 }),
      ]),
    );
    expect(summary.recent[0]?.ref).toMatch(/^trajectory:[a-f0-9]{12}$/);
    expect(JSON.stringify(summary)).not.toContain('prop-1');
    expect(JSON.stringify(summary)).not.toContain('item-1');
    expect(JSON.stringify(summary)).not.toContain(REPO);
  });
});

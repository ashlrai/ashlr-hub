/**
 * m354.trajectory-records.test.ts — read-only route-to-outcome timelines.
 */

import { describe, expect, it } from 'vitest';
import {
  listTrajectoryRecords,
  MIN_SKILL_OBSERVED_TRAJECTORIES,
  summarizeTrajectoryLearning,
  suppressDegradedSkillObservation,
  type TrajectoryLearningStatus,
  type TrajectoryRecordReadDeps,
} from '../src/core/autonomy/trajectory-records.js';
import type { OutcomeRecord } from '../src/core/autonomy/outcome-records.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import type { AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import type { Proposal, SkillUseEvent } from '../src/core/types.js';
import { ROUTER_POLICY_VERSION } from '../src/core/learning/causal.js';
import {
  agentRunSemanticEvents,
  agentSemanticSubjectRef,
  defineAgentSemanticEvents,
} from '../src/core/learning/agent-semantic-events.js';

const TS0 = '2026-07-09T12:00:00.000Z';
const TS1 = '2026-07-09T12:01:00.000Z';
const TS2 = '2026-07-09T12:02:00.000Z';
const TS3 = '2026-07-09T12:03:00.000Z';
const TS4 = '2026-07-09T12:04:00.000Z';
const REPO = '/tmp/ashlr-hub-fixture';
const RAW_SECRET = 'RAW_EVIDENCE_SECRET_SHOULD_NOT_LEAK';
const DIFF_SECRET = 'diff --git a/secret.ts b/secret.ts';
const STDOUT_SECRET = 'stdout contained literal-secret-value';
const SEMANTIC_PROPOSAL_ID = 'prop-m354abc1-000001-dddddddddddddddddddddddd';

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

function skillUse(overrides: Partial<SkillUseEvent> = {}): SkillUseEvent {
  return {
    schemaVersion: 1,
    eventId: 'skill-use:event-1',
    ts: TS1,
    skillId: 'skill.proposal.private-id',
    skillRevision: 2,
    contentHash: 'a'.repeat(64),
    selectedAt: TS1,
    skillPolicyVersion: 'verified-skills-v1',
    mode: 'shadow',
    stage: 'selected',
    outcome: 'unknown',
    rank: 0,
    score: 0.9,
    reason: 'private selection reason',
    proposalId: 'prop-1',
    runId: 'run-1',
    trajectoryId: 'traj-1',
    ...overrides,
  };
}

function deps(overrides: Partial<TrajectoryRecordReadDeps> = {}): TrajectoryRecordReadDeps {
  return {
    readDispatchProductionEvents: () => [dispatch()],
    listOutcomeRecords: () => [outcomeRecord()],
    readAgentActions: () => [action()],
    readSkillUseEvents: () => [],
    loadProposal: (id) => ({
      id,
      repo: REPO,
      origin: 'agent',
      kind: 'patch',
      title: 'Verifier proposal',
      summary: 'summary',
      status: 'applied',
      createdAt: TS1,
      realizedMerge: {
        schemaVersion: 1,
        source: 'local-default-branch',
        base: 'main',
        baseBeforeOid: '1'.repeat(40),
        proposalHeadOid: '2'.repeat(40),
        mergeCommitOid: '3'.repeat(40),
        observedAt: TS3,
      },
    } as Proposal),
    ...overrides,
  };
}

describe('Trajectory records', () => {
  it('materializes preclaim route infeasibility as an action-only trajectory', () => {
    const attemptId = 'attempt-12345678-1234-4123-8123-123456789abc';
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [],
        readAgentActions: () => [action({
          kind: 'selection',
          outcome: 'blocked',
          action: 'daemon:generated-repair-decision',
          summary: 'generated repair dispatch-route-unavailable',
          proposalId: undefined,
          runId: attemptId,
          trajectoryId: `run:${attemptId}`,
          backend: undefined,
          tier: undefined,
          model: undefined,
          routeSnapshot: {
            backend: null,
            tier: 'mid',
            assignedBy: 'preclaim-route-inspection',
            reason: 'same-tier-backend-unavailable',
            routerPolicyVersion: ROUTER_POLICY_VERSION,
          },
          learningSource: 'agent-action',
          labelBasis: 'preclaim-route-feasibility',
        })],
      }),
    });

    expect(record).toMatchObject({
      id: `trajectory:run:${attemptId}`,
      terminalOutcome: 'unknown',
      runId: attemptId,
      trajectoryId: `run:${attemptId}`,
      routeSnapshot: {
        backend: null,
        tier: 'mid',
        assignedBy: 'preclaim-route-inspection',
        reason: 'same-tier-backend-unavailable',
        routerPolicyVersion: ROUTER_POLICY_VERSION,
      },
      learningSource: 'agent-action',
      labelBasis: 'preclaim-route-feasibility',
      coverage: {
        dispatch: false,
        proposal: false,
        evidence: false,
        decision: false,
        agentAction: true,
        skillUse: false,
      },
    });
    expect(record?.timeline).toHaveLength(1);
    expect(record?.timeline[0]).toMatchObject({ kind: 'agent-action' });
  });

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
        skillUse: false,
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

  it('keeps applied status and merged ledger activity nonterminal without a realized witness', () => {
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        listOutcomeRecords: () => [outcomeRecord({
          proposal: { ...outcomeRecord().proposal, status: 'applied' },
        })],
        loadProposal: () => ({
          id: 'prop-1', repo: REPO, origin: 'agent', kind: 'patch', title: 'Legacy applied',
          summary: 'summary', status: 'applied', createdAt: TS1,
        }),
      }),
    });

    expect(record?.terminalOutcome).toBe('pending');
    expect(record?.timeline).toContainEqual(expect.objectContaining({
      kind: 'decision', action: 'merged',
    }));
  });

  it('keeps witnessed applied proposals terminal regardless of release label', () => {
    for (const labelBasis of [
      undefined,
      'proposal-status',
      'post-merge-credit-release-v1',
    ] as const) {
      const base = outcomeRecord();
      const [record] = listTrajectoryRecords({
        windowHours: 1000,
        deps: deps({
          listOutcomeRecords: () => [{
            ...base,
            proposal: { ...base.proposal, status: 'applied', labelBasis },
            decisions: [{ ...base.decisions[0]!, labelBasis }],
          }],
        }),
      });

      expect(record?.terminalOutcome).toBe('merged');
      expect(record?.timeline).toContainEqual(expect.objectContaining({
        kind: 'decision', action: 'merged',
      }));
      expect(summarizeTrajectoryLearning([record!]).routeSpine.dispatchToMerge.count).toBe(1);
    }
  });

  it('attaches realized post-merge truth without rewriting the historical merge outcome', () => {
    const realizedAt = '2026-07-09T00:04:00.000Z';
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        listOutcomeRecords: () => [outcomeRecord({
          judgeTraces: [{
            ts: TS2,
            judgeEngine: 'codex',
            verdict: 'ship',
            scores: { correctness: 1, completeness: 1, quality: 1, safety: 1 },
            outcome: 'reverted',
            outcomeAt: realizedAt,
          }],
          postMergeObservations: [{
            schemaVersion: 1,
            eventId: 'e'.repeat(64),
            observedAt: realizedAt,
            authority: 'observation-only',
            outcome: 'regressed',
            basis: 'bisect-first-bad',
            confidence: 'deterministic',
            repo: REPO,
            proposalId: 'prop-1',
            runId: 'run-1',
            trajectoryId: 'traj-1',
            workItemId: 'item-1',
            mergeCommit: 'a'.repeat(40),
            observedHead: 'b'.repeat(40),
            baselineHead: 'c'.repeat(40),
            candidateCount: 2,
            commandKinds: ['test'],
            labelBasis: 'post-merge-regression',
            attestation: 'd'.repeat(64),
          }],
        })],
      }),
    });

    expect(record).toMatchObject({
      terminalOutcome: 'merged',
      realizedOutcome: 'regressed',
      proposalId: 'prop-1',
      runId: 'run-1',
      trajectoryId: 'traj-1',
    });
    expect(record?.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ts: realizedAt,
        kind: 'post-merge',
        outcome: 'regressed',
        postMergeEvidence: {
          basis: 'bisect-first-bad',
          confidence: 'deterministic',
          candidateCount: 2,
          commandKinds: ['test'],
        },
      }),
    ]));
    const summary = summarizeTrajectoryLearning([record!], 24);
    expect(summary.realizedOutcomes).toMatchObject({ regressed: 1 });
    expect(summary.terminalOutcomes).toMatchObject({ merged: 1 });
    expect(summary.recent[0]).toMatchObject({
      terminalOutcome: 'merged',
      realizedOutcome: 'regressed',
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

  it('projects cancellation as an explicit terminal outcome', () => {
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [dispatch({
          itemId: 'item-cancelled',
          outcome: 'cancelled',
          proposalCreated: false,
          proposalId: undefined,
          runId: 'run-cancelled',
          trajectoryId: 'traj-cancelled',
        })],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
      }),
    });

    expect(record).toMatchObject({
      terminalOutcome: 'cancelled',
      coverage: { dispatch: true, proposal: false },
    });
    expect(summarizeTrajectoryLearning([record!]).terminalOutcomes).toMatchObject({
      cancelled: 1,
      'no-proposal': 0,
      failed: 0,
    });
  });

  it('projects historical owner cancellation without masking genuine engine failure', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({
            itemId: 'item-historical-cancelled',
            outcome: 'engine-failed',
            proposalCreated: false,
            proposalId: undefined,
            runId: 'run-historical-cancelled',
            trajectoryId: 'traj-historical-cancelled',
            reason: 'selection cancelled after daemon lock ownership lost',
            runEventSummary: {
              runId: 'run-historical-cancelled',
              status: 'aborted',
              outcome: 'engine-failed',
              proposalCreated: false,
              actionCounts: {},
            },
          }),
          dispatch({
            ts: TS1,
            itemId: 'item-provider-failed',
            outcome: 'engine-failed',
            proposalCreated: false,
            proposalId: undefined,
            runId: 'run-provider-failed',
            trajectoryId: 'traj-provider-failed',
            reason: 'provider request aborted after upstream transport failure',
            runEventSummary: {
              runId: 'run-provider-failed',
              status: 'aborted',
              outcome: 'engine-failed',
              proposalCreated: false,
              actionCounts: {},
            },
          }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
      }),
    });

    expect(records.find((record) => record.itemId === 'item-historical-cancelled'))
      .toMatchObject({ terminalOutcome: 'cancelled' });
    expect(records.find((record) => record.itemId === 'item-provider-failed'))
      .toMatchObject({ terminalOutcome: 'failed' });
    expect(summarizeTrajectoryLearning(records).terminalOutcomes).toMatchObject({
      cancelled: 1,
      failed: 1,
    });
  });

  it('lets every substantive joined terminal fact outrank cancellation', () => {
    const dispatchCases = [
      {
        expected: 'pending',
        event: { outcome: 'proposal-created', proposalCreated: true, proposalId: 'prop-pending' },
      },
      {
        expected: 'failed',
        event: {
          outcome: 'engine-failed',
          proposalCreated: false,
          proposalId: undefined,
          reason: 'provider failed after starting work',
        },
      },
      {
        expected: 'no-proposal',
        event: { outcome: 'empty-diff', proposalCreated: false, proposalId: undefined },
      },
    ] as const;

    for (const [index, testCase] of dispatchCases.entries()) {
      const runId = `run-mixed-dispatch-${index}`;
      const trajectoryId = `traj-mixed-dispatch-${index}`;
      const [record] = listTrajectoryRecords({
        windowHours: 1000,
        deps: deps({
          readDispatchProductionEvents: () => [
            dispatch({
              ts: TS0,
              itemId: `item-mixed-dispatch-${index}`,
              outcome: 'cancelled',
              proposalCreated: false,
              proposalId: undefined,
              runId,
              trajectoryId,
            }),
            dispatch({
              ts: TS1,
              itemId: `item-mixed-dispatch-${index}`,
              runId,
              trajectoryId,
              ...testCase.event,
            }),
          ],
          listOutcomeRecords: () => [],
          readAgentActions: () => [],
        }),
      });

      expect(record?.terminalOutcome).toBe(testCase.expected);
    }

    for (const [index, action] of (['handoff', 'rejected', 'merged'] as const).entries()) {
      const proposalId = `prop-mixed-decision-${index}`;
      const runId = `run-mixed-decision-${index}`;
      const trajectoryId = `traj-mixed-decision-${index}`;
      const base = outcomeRecord();
      const [record] = listTrajectoryRecords({
        windowHours: 1000,
        deps: deps({
          readDispatchProductionEvents: () => [dispatch({
            itemId: `item-mixed-decision-${index}`,
            outcome: 'cancelled',
            proposalCreated: false,
            proposalId: undefined,
            runId,
            trajectoryId,
          })],
          listOutcomeRecords: () => [{
            ...base,
            proposal: {
              ...base.proposal,
              id: proposalId,
              status: action === 'merged' ? 'applied' : action === 'rejected' ? 'rejected' : 'pending',
              createdAt: TS1,
              workItemId: `item-mixed-decision-${index}`,
              runId,
              trajectoryId,
            },
            lastActivityAt: TS2,
            evidencePacks: [],
            decisions: [{
              ...base.decisions[0]!,
              ts: TS2,
              proposalId,
              action,
              runId,
              trajectoryId,
            }],
          }],
          readAgentActions: () => [],
        }),
      });

      expect(record?.terminalOutcome).toBe(action);
    }
  });

  it('does not let a later cancellation mask joined failure or no-diff truth', () => {
    for (const [index, terminal] of (['engine-failed', 'empty-diff'] as const).entries()) {
      const runId = `run-late-cancel-${index}`;
      const trajectoryId = `traj-late-cancel-${index}`;
      const [record] = listTrajectoryRecords({
        windowHours: 1000,
        deps: deps({
          readDispatchProductionEvents: () => [
            dispatch({
              ts: TS1,
              itemId: `item-late-cancel-${index}`,
              outcome: terminal,
              proposalCreated: false,
              proposalId: undefined,
              runId,
              trajectoryId,
              reason: terminal === 'engine-failed' ? 'provider failed during execution' : undefined,
            }),
            dispatch({
              ts: TS2,
              itemId: `item-late-cancel-${index}`,
              outcome: 'cancelled',
              proposalCreated: false,
              proposalId: undefined,
              runId,
              trajectoryId,
            }),
          ],
          listOutcomeRecords: () => [],
          readAgentActions: () => [],
        }),
      });

      expect(record?.terminalOutcome).toBe(terminal === 'engine-failed' ? 'failed' : 'no-proposal');
    }
  });

  it('accepts historical terminal counts without cancellation while materializing new summaries', () => {
    const historicalTerminalOutcomes = {
      merged: 1,
      rejected: 0,
      handoff: 0,
      pending: 2,
      'no-proposal': 1,
      failed: 0,
      unknown: 0,
    } satisfies TrajectoryLearningStatus['terminalOutcomes'];

    expect(historicalTerminalOutcomes).not.toHaveProperty('cancelled');
    expect(summarizeTrajectoryLearning([], 24).terminalOutcomes).toEqual({
      merged: 0,
      rejected: 0,
      handoff: 0,
      pending: 0,
      'no-proposal': 0,
      cancelled: 0,
      failed: 0,
      unknown: 0,
    });
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

  it('counts the same skill selected by separate Best-of-N child runs as separate observations', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({ proposalId: undefined, runId: 'run-candidate-1' }),
          dispatch({ ts: TS1, proposalId: undefined, runId: 'run-candidate-2' }),
          dispatch({ ts: TS2, itemId: 'item-2', proposalId: undefined, runId: 'run-2', trajectoryId: 'traj-2' }),
          dispatch({ ts: TS3, itemId: 'item-3', proposalId: undefined, runId: 'run-3', trajectoryId: 'traj-3' }),
        ],
        readSkillUseEvents: () => [
          skillUse({ proposalId: undefined, runId: 'run-candidate-1' }),
          skillUse({
            eventId: 'skill-use:candidate-2',
            selectedAt: TS2,
            proposalId: undefined,
            runId: 'run-candidate-2',
          }),
          skillUse({
            eventId: 'skill-use:trajectory-2',
            skillId: 'skill.proposal.trajectory-2',
            contentHash: 'b'.repeat(64),
            ts: TS2,
            proposalId: undefined,
            runId: 'run-2',
            trajectoryId: 'traj-2',
          }),
          skillUse({
            eventId: 'skill-use:trajectory-3',
            skillId: 'skill.proposal.trajectory-3',
            contentHash: 'c'.repeat(64),
            ts: TS3,
            proposalId: undefined,
            runId: 'run-3',
            trajectoryId: 'traj-3',
          }),
          skillUse({
            eventId: 'skill-use:candidate-1-later-stage',
            ts: TS4,
            selectedAt: TS1,
            stage: 'outcome',
            outcome: 'merged',
            proposalId: undefined,
            runId: 'run-candidate-1',
          }),
        ],
      }),
    });

    expect(records).toHaveLength(3);
    expect(records.every((record) => record.coverage.skillUse)).toBe(true);
    expect(records.flatMap((record) => record.timeline.map((event) => event.kind))).not.toContain('skill-use');

    const summary = summarizeTrajectoryLearning(records, 24);
    expect(summary.coverage.skillUse).toEqual({ count: 3, rate: 1 });
    expect(summary.skillObservation).toEqual({
      eventState: 'present',
      joined: 5,
      unjoined: 0,
      conflicting: 0,
      observedTrajectoryCoverage: { count: 3, rate: 1 },
      modeCounts: { shadow: 5, active: 0, disabled: 0 },
      stageCounts: { selected: 4, injected: 0, applied: 0, outcome: 1 },
      sampleState: 'observed',
    });
  });

  it('preserves joined mode and stage totals when the trajectory array is copied', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({ proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          dispatch({ ts: TS1, itemId: 'item-b', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-b' }),
          dispatch({ ts: TS2, itemId: 'item-c', proposalId: undefined, runId: 'run-c', trajectoryId: 'traj-c' }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [
          skillUse({ eventId: 'skill-use:a', proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          skillUse({
            eventId: 'skill-use:b',
            skillId: 'skill.b',
            contentHash: 'b'.repeat(64),
            proposalId: undefined,
            runId: 'run-b',
            trajectoryId: 'traj-b',
            mode: 'active',
            stage: 'injected',
          }),
          skillUse({
            eventId: 'skill-use:c',
            skillId: 'skill.c',
            contentHash: 'c'.repeat(64),
            proposalId: undefined,
            runId: 'run-c',
            trajectoryId: 'traj-c',
            mode: 'disabled',
            stage: 'outcome',
            outcome: 'merged',
          }),
          skillUse({
            eventId: 'skill-use:orphan',
            skillId: 'skill.orphan',
            contentHash: 'd'.repeat(64),
            proposalId: undefined,
            runId: 'run-orphan',
            trajectoryId: 'traj-orphan',
          }),
          skillUse({
            eventId: 'skill-use:conflicting',
            skillId: 'skill.conflicting',
            contentHash: 'e'.repeat(64),
            proposalId: undefined,
            runId: 'run-b',
            trajectoryId: 'traj-a',
          }),
        ],
      }),
    });

    const original = summarizeTrajectoryLearning(records).skillObservation;
    const copied = summarizeTrajectoryLearning([...records]).skillObservation;

    expect(copied).toEqual(original);
    expect(copied).toMatchObject({
      joined: 3,
      unjoined: 1,
      conflicting: 1,
      modeCounts: { shadow: 1, active: 1, disabled: 1 },
      stageCounts: { selected: 1, injected: 1, applied: 0, outcome: 1 },
      sampleState: 'observed',
    });
  });

  it('does not create trajectories from orphan skill rows or change terminal denominators', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [skillUse({
          proposalId: 'orphan-proposal',
          runId: 'orphan-run',
          trajectoryId: 'orphan-trajectory',
        })],
      }),
    });

    expect(records).toEqual([]);
    const summary = summarizeTrajectoryLearning(records, 24);
    expect(summary).toMatchObject({
      trajectories: 0,
      terminalOutcomes: {
        merged: 0,
        rejected: 0,
        handoff: 0,
        pending: 0,
        'no-proposal': 0,
        cancelled: 0,
        failed: 0,
        unknown: 0,
      },
      skillObservation: {
        eventState: 'present',
        sampleState: 'none',
      },
    });
    expect(summary.coverage).not.toHaveProperty('skillUse');
    expect(summary.skillObservation).not.toHaveProperty('joined');
    expect(summary.skillObservation).not.toHaveProperty('unjoined');
    expect(summary.skillObservation).not.toHaveProperty('conflicting');
  });

  it('quarantines skill rows whose resolved aliases disagree', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({ proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          dispatch({
            ts: TS1,
            itemId: 'item-2',
            proposalId: undefined,
            runId: 'run-b',
            trajectoryId: 'traj-b',
          }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [skillUse({
          proposalId: undefined,
          trajectoryId: 'traj-a',
          runId: 'run-b',
        })],
      }),
    });

    expect(records).toHaveLength(2);
    expect(records.every((record) => !record.coverage.skillUse)).toBe(true);
    const summary = summarizeTrajectoryLearning(records);
    expect(summary.skillObservation).toMatchObject({
      eventState: 'present',
      sampleState: 'none',
    });
    expect(summary.coverage).not.toHaveProperty('skillUse');
    expect(summary.skillObservation).not.toHaveProperty('joined');
    expect(summary.skillObservation).not.toHaveProperty('conflicting');
  });

  it('quarantines contradictory alias bridges without erasing either existing mapping', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({ proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          dispatch({ ts: TS1, itemId: 'item-b', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-b' }),
          dispatch({ ts: TS2, itemId: 'item-c', proposalId: undefined, runId: 'run-c', trajectoryId: 'traj-c' }),
          dispatch({ ts: TS3, itemId: 'item-bridge', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-a' }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [
          skillUse({ eventId: 'skill-use:conflict', skillId: 'skill.conflict', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-a' }),
          skillUse({ eventId: 'skill-use:a', skillId: 'skill.a', contentHash: 'b'.repeat(64), proposalId: undefined, runId: undefined, trajectoryId: 'traj-a' }),
          skillUse({ eventId: 'skill-use:b', skillId: 'skill.b', contentHash: 'c'.repeat(64), proposalId: undefined, runId: 'run-b', trajectoryId: undefined }),
          skillUse({ eventId: 'skill-use:c', skillId: 'skill.c', contentHash: 'd'.repeat(64), proposalId: undefined, runId: 'run-c', trajectoryId: 'traj-c' }),
        ],
      }),
    });

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.timeline.filter((event) => event.kind === 'dispatch'))).toEqual([
      [expect.any(Object)],
      [expect.any(Object)],
      [expect.any(Object)],
    ]);
    expect(records.every((record) => record.coverage.skillUse)).toBe(true);
    expect(summarizeTrajectoryLearning(records).skillObservation).toMatchObject({
      joined: 3,
      conflicting: 1,
      observedTrajectoryCoverage: { count: 3, rate: 1 },
      sampleState: 'observed',
    });
  });

  it('quarantines contradictory alias bridges identically in newest-first and chronological order', () => {
    const chronological = [
      dispatch({ proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
      dispatch({ ts: TS1, itemId: 'item-b', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-b' }),
      dispatch({ ts: TS2, itemId: 'item-c', proposalId: undefined, runId: 'run-c', trajectoryId: 'traj-c' }),
      dispatch({ ts: TS3, itemId: 'item-bridge', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-a' }),
    ];
    const skillEvents = [
      skillUse({ eventId: 'skill-use:conflict', skillId: 'skill.conflict', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-a' }),
      skillUse({ eventId: 'skill-use:a', skillId: 'skill.a', contentHash: 'b'.repeat(64), proposalId: undefined, runId: undefined, trajectoryId: 'traj-a' }),
      skillUse({ eventId: 'skill-use:b', skillId: 'skill.b', contentHash: 'c'.repeat(64), proposalId: undefined, runId: 'run-b', trajectoryId: undefined }),
      skillUse({ eventId: 'skill-use:c', skillId: 'skill.c', contentHash: 'd'.repeat(64), proposalId: undefined, runId: 'run-c', trajectoryId: 'traj-c' }),
    ];
    const reconstruct = (dispatchEvents: DispatchProductionEvent[]) => {
      const records = listTrajectoryRecords({
        windowHours: 1000,
        deps: deps({
          readDispatchProductionEvents: () => dispatchEvents,
          listOutcomeRecords: () => [],
          readAgentActions: () => [],
          readSkillUseEvents: () => skillEvents,
        }),
      });
      return {
        trajectories: records.length,
        dispatchesPerTrajectory: records
          .map((record) => record.timeline.filter((event) => event.kind === 'dispatch').length)
          .sort((a, b) => a - b),
        skillObservation: summarizeTrajectoryLearning(records).skillObservation,
      };
    };

    const chronologicalResult = reconstruct(chronological);
    const newestFirstResult = reconstruct([...chronological].reverse());

    expect(newestFirstResult).toEqual(chronologicalResult);
    expect(newestFirstResult).toEqual({
      trajectories: 3,
      dispatchesPerTrajectory: [1, 1, 1],
      skillObservation: {
        eventState: 'present',
        joined: 3,
        unjoined: 0,
        conflicting: 1,
        observedTrajectoryCoverage: { count: 3, rate: 1 },
        modeCounts: { shadow: 3, active: 0, disabled: 0 },
        stageCounts: { selected: 3, injected: 0, applied: 0, outcome: 0 },
        sampleState: 'observed',
      },
    });
  });

  it('withholds exact skill observations and per-trajectory flags at k-1', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({ proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          dispatch({ ts: TS1, itemId: 'item-b', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-b' }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [
          skillUse({ eventId: 'skill-use:a', proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          skillUse({ eventId: 'skill-use:b', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-b' }),
        ],
      }),
    });
    const summary = summarizeTrajectoryLearning(records);

    expect(MIN_SKILL_OBSERVED_TRAJECTORIES).toBe(3);
    expect(records.filter((record) => record.coverage.skillUse)).toHaveLength(
      MIN_SKILL_OBSERVED_TRAJECTORIES - 1,
    );
    expect(summary.skillObservation).toMatchObject({ sampleState: 'insufficient-sample' });
    for (const exactField of ['joined', 'unjoined', 'conflicting', 'observedTrajectoryCoverage', 'modeCounts', 'stageCounts']) {
      expect(summary.skillObservation).not.toHaveProperty(exactField);
    }
    expect(summary.coverage).not.toHaveProperty('skillUse');
    expect(summary.recent[0]?.coverage).not.toHaveProperty('skillUse');
  });

  it('reports only aggregate fixed-key observations and requires three observed trajectories', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({ proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          dispatch({ ts: TS1, itemId: 'item-2', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-b' }),
          dispatch({ ts: TS2, itemId: 'item-3', proposalId: undefined, runId: 'run-c', trajectoryId: 'traj-c' }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [
          skillUse({ eventId: 'private-event-a', proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          skillUse({
            eventId: 'private-event-b',
            skillId: 'private-skill-b',
            contentHash: 'b'.repeat(64),
            proposalId: undefined,
            runId: 'run-b',
            trajectoryId: 'traj-b',
            mode: 'active',
          }),
          skillUse({
            eventId: 'private-event-c',
            skillId: 'private-skill-c',
            contentHash: 'c'.repeat(64),
            proposalId: undefined,
            runId: 'run-c',
            trajectoryId: 'traj-c',
            mode: 'disabled',
          }),
        ],
      }),
    });
    const observation = summarizeTrajectoryLearning(records).skillObservation;
    const json = JSON.stringify(observation);

    expect(records.filter((record) => record.coverage.skillUse)).toHaveLength(
      MIN_SKILL_OBSERVED_TRAJECTORIES,
    );
    expect(observation).toEqual({
      eventState: 'present',
      joined: 3,
      unjoined: 0,
      conflicting: 0,
      observedTrajectoryCoverage: { count: 3, rate: 1 },
      modeCounts: { shadow: 1, active: 1, disabled: 1 },
      stageCounts: { selected: 3, injected: 0, applied: 0, outcome: 0 },
      sampleState: 'observed',
    });
    for (const privateValue of [
      'private-event-a',
      'private-event-b',
      'private-event-c',
      'private-skill-b',
      'private-skill-c',
      'private selection reason',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    ]) {
      expect(json).not.toContain(privateValue);
    }
    expect(observation).not.toHaveProperty('outcomes');
    expect(observation).not.toHaveProperty('terminalOutcomes');
    expect(observation).not.toHaveProperty('causalEffect');
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

  it('isolates action-only preclaim trajectories from production learning metrics', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readAgentActions: () => [
          action(),
          action({
            itemId: 'item-action-only',
            proposalId: undefined,
            runId: 'run-action-only',
            trajectoryId: 'traj-action-only',
            routeSnapshot: {
              backend: null,
              tier: 'mid',
              assignedBy: 'preclaim-route-inspection',
              reason: 'same-tier-backend-unavailable',
              routerPolicyVersion: ROUTER_POLICY_VERSION,
            },
            learningSource: 'agent-action',
            labelBasis: 'preclaim-route-feasibility',
          }),
        ],
      }),
    });

    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trajectoryId: 'traj-action-only',
        coverage: expect.objectContaining({ dispatch: false, agentAction: true }),
      }),
    ]));

    const summary = summarizeTrajectoryLearning(records, 24);
    expect(summary.trajectories).toBe(1);
    expect(summary.terminalOutcomes).toMatchObject({ merged: 1, unknown: 0 });
    expect(summary.coverage).toMatchObject({
      dispatch: { count: 1, rate: 1 },
      evidence: { count: 1, rate: 1 },
      decision: { count: 1, rate: 1 },
      agentAction: { count: 1, rate: 1 },
    });
    expect(summary.gaps).toEqual([]);
    expect(summary.recent).toHaveLength(1);
    expect(summary.routeSpine).toEqual({
      dispatchToDecision: { count: 1, rate: 1 },
      dispatchToEvidence: { count: 1, rate: 1 },
      dispatchToMerge: { count: 1, rate: 1 },
    });
    expect(summary.routeDiagnostics).toMatchObject({
      trajectories: 1,
      reasonCounts: { 'same-tier-backend-unavailable': 1 },
    });
  });

  it('prioritizes production trajectories within a 500-record action-only overflow window', () => {
    const dispatches = [
      dispatch({ proposalId: undefined, runId: 'run-production-a', trajectoryId: 'traj-production-a' }),
      dispatch({ ts: TS1, itemId: 'item-production-b', proposalId: undefined, runId: 'run-production-b', trajectoryId: 'traj-production-b' }),
      dispatch({ ts: TS2, itemId: 'item-production-c', proposalId: undefined, runId: 'run-production-c', trajectoryId: 'traj-production-c' }),
    ];
    const actions = Array.from({ length: 510 }, (_, index) => action({
      ts: new Date(Date.parse(TS4) + index).toISOString(),
      itemId: `item-route-${index}`,
      proposalId: undefined,
      runId: `run-route-${index}`,
      trajectoryId: `traj-route-${index}`,
      routeSnapshot: {
        backend: null,
        tier: 'mid',
        assignedBy: 'preclaim-route-inspection',
        reason: index < 300
          ? 'editing-backend-unavailable'
          : index < 509
            ? 'same-tier-backend-unavailable'
            : 'private-arbitrary-reason',
        routerPolicyVersion: ROUTER_POLICY_VERSION,
      },
      learningSource: 'agent-action',
      labelBasis: 'preclaim-route-feasibility',
    }));
    const records = listTrajectoryRecords({
      windowHours: 1000,
      limit: 500,
      deps: deps({
        readDispatchProductionEvents: () => dispatches,
        listOutcomeRecords: () => [],
        readAgentActions: () => actions,
        readSkillUseEvents: () => [
          skillUse({ eventId: 'skill-production-a', proposalId: undefined, runId: 'run-production-a', trajectoryId: 'traj-production-a' }),
          skillUse({ eventId: 'skill-production-b', proposalId: undefined, runId: 'run-production-b', trajectoryId: 'traj-production-b' }),
          skillUse({ eventId: 'skill-production-c', proposalId: undefined, runId: 'run-production-c', trajectoryId: 'traj-production-c' }),
          skillUse({ eventId: 'skill-route-only', proposalId: undefined, runId: 'run-route-509', trajectoryId: 'traj-route-509' }),
        ],
      }),
    });

    expect(records).toHaveLength(500);
    expect(records.filter((record) => record.coverage.dispatch)).toHaveLength(3);
    expect(records.filter((record) => !record.coverage.dispatch)).toHaveLength(497);
    expect(records.map((record) => record.trajectoryId)).toEqual(expect.arrayContaining([
      'traj-production-a',
      'traj-production-b',
      'traj-production-c',
      'traj-route-509',
    ]));

    const summary = summarizeTrajectoryLearning(records, 24);
    expect(summary.trajectories).toBe(3);
    expect(summary.terminalOutcomes).toMatchObject({ pending: 3, unknown: 0 });
    expect(summary.coverage).toMatchObject({
      dispatch: { count: 3, rate: 1 },
      proposal: { count: 0, rate: 0 },
      agentAction: { count: 0, rate: 0 },
      skillUse: { count: 3, rate: 1 },
    });
    expect(summary.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'proposal', count: 3 }),
      expect.objectContaining({ kind: 'evidence', count: 3 }),
      expect.objectContaining({ kind: 'decision', count: 3 }),
      expect.objectContaining({ kind: 'agentAction', count: 3 }),
    ]));
    expect(summary.gaps).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'dispatch' }),
    ]));
    expect(summary.skillObservation).toMatchObject({
      joined: 3,
      observedTrajectoryCoverage: { count: 3, rate: 1 },
      sampleState: 'observed',
    });
    expect(summary.routeDiagnostics).toEqual({
      trajectories: 497,
      reasonCounts: {
        feasible: 0,
        'provenance-unavailable': 0,
        'lifecycle-unavailable': 0,
        'editing-backend-unavailable': 287,
        'same-tier-backend-unavailable': 209,
        'same-tier-alternative-unavailable': 0,
        'inspection-unavailable': 1,
        'route-capacity-unavailable': 0,
      },
    });
    expect(JSON.stringify(summary.routeDiagnostics)).not.toContain('private-arbitrary-reason');
  });

  it('suppresses every exact skill metric when the observation source is degraded', () => {
    const records = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({ proposalId: undefined, runId: 'run-a', trajectoryId: 'traj-a' }),
          dispatch({ ts: TS1, itemId: 'item-b', proposalId: undefined, runId: 'run-b', trajectoryId: 'traj-b' }),
          dispatch({ ts: TS2, itemId: 'item-c', proposalId: undefined, runId: 'run-c', trajectoryId: 'traj-c' }),
        ],
        listOutcomeRecords: () => [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [
          skillUse({ eventId: 'use-a', runId: 'run-a', trajectoryId: 'traj-a' }),
          skillUse({ eventId: 'use-b', runId: 'run-b', trajectoryId: 'traj-b' }),
          skillUse({ eventId: 'use-c', runId: 'run-c', trajectoryId: 'traj-c' }),
        ],
      }),
    });
    const published = summarizeTrajectoryLearning(records);
    expect(published.skillObservation.sampleState).toBe('observed');

    const suppressed = suppressDegradedSkillObservation(published, 'present');
    expect(suppressed.skillObservation).toEqual({ eventState: 'present', sampleState: 'unavailable' });
    expect(suppressed.coverage).not.toHaveProperty('skillUse');
    expect(suppressed.recent.every((record) => !('skillUse' in record.coverage))).toBe(true);
    expect(JSON.stringify(suppressed)).not.toContain('modeCounts');
    expect(JSON.stringify(suppressed)).not.toContain('stageCounts');
  });

  it('projects semantic decision events onto the existing decision timeline row', () => {
    const semanticEvent = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', SEMANTIC_PROPOSAL_ID),
      producerRole: 'manager', producerModelFamily: 'openai', producerVersion: 'manager-semantic-v1',
    }, [{
      kind: 'challenge', predicate: 'manager.verdict.review',
      challengeCode: 'verdict.review', severity: 'medium',
    }])[0]!;
    const baseOutcome = outcomeRecord();
    const outcome = outcomeRecord({
      proposal: { ...baseOutcome.proposal, id: SEMANTIC_PROPOSAL_ID },
      decisions: [{
        ts: TS3,
        action: 'judged',
        verdict: 'review',
        model: 'gpt-5.5',
        semanticEvents: [semanticEvent],
      }],
    });
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [outcome],
        readAgentActions: () => [],
      }),
    });
    const decisionEvent = record?.timeline.find((event) => event.kind === 'decision');
    expect(decisionEvent?.semanticEvents).toEqual([semanticEvent]);
    expect(record?.timeline.filter((event) => event.kind === 'decision')).toHaveLength(1);
  });

  it('preserves decision source degradation without creating semantic timeline evidence', () => {
    const semanticEvent = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', SEMANTIC_PROPOSAL_ID),
      producerRole: 'manager', producerModelFamily: 'openai', producerVersion: 'manager-semantic-v1',
    }, [{
      kind: 'action', predicate: 'manager.judge.completed',
      actionCode: 'manager.judge', status: 'completed',
    }])[0]!;
    const baseOutcome = outcomeRecord();
    const outcome = outcomeRecord({
      proposal: { ...baseOutcome.proposal, id: SEMANTIC_PROPOSAL_ID },
      decisionSourceQuality: {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        stopReasons: ['io-error'], filesRead: 1, bytesRead: 100,
        rowsScanned: 2, invalidRows: 1, unreadableFiles: 0,
      },
      decisions: [{
        ts: TS3, action: 'judged', verdict: 'review', model: 'gpt-5.5',
        semanticEvents: [semanticEvent],
      }],
    });
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [outcome],
        readAgentActions: () => [],
      }),
    });
    expect(record?.decisionSourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(record?.timeline.find((event) => event.kind === 'decision')?.semanticEvents).toBeUndefined();
  });

  it('preserves action-carried semantics on the existing action timeline row', () => {
    const semanticEvent = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', SEMANTIC_PROPOSAL_ID),
      producerRole: 'agent', producerModelFamily: 'local', producerVersion: 'agent-semantic-v1',
    }, [{
      kind: 'intent', predicate: 'agent.intent.execute', objectiveCode: 'proposal.evaluate',
    }])[0]!;
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        listOutcomeRecords: () => [],
        readAgentActions: () => [action({
          proposalId: SEMANTIC_PROPOSAL_ID,
          runId: 'run-semantic-action',
          trajectoryId: 'traj-semantic-action',
          semanticEvents: [semanticEvent],
        })],
      }),
    });
    const actionEvent = record?.timeline.find((event) => event.kind === 'agent-action');
    expect(actionEvent?.semanticEvents).toEqual([semanticEvent]);
    expect(record?.timeline.filter((event) => event.kind === 'agent-action')).toHaveLength(1);
  });

  it('preserves proposal-less run semantics on the joined action timeline', () => {
    const runId = 'run-semantic-proposal-less';
    const semanticEvents = agentRunSemanticEvents({
      runId,
      model: 'qwen3-coder',
      status: 'done',
      proposalCreated: false,
    });
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [],
        readAgentActions: () => [action({
          actor: 'agent',
          kind: 'maintenance',
          outcome: 'no-proposal',
          action: 'sandboxed-engine:run',
          proposalId: undefined,
          runId,
          trajectoryId: `run:${runId}`,
          model: 'qwen3-coder',
          semanticEvents,
        })],
      }),
    });

    expect(record?.proposalId).toBeUndefined();
    expect(record?.runId).toBe(runId);
    expect(record?.timeline).toHaveLength(1);
    expect(record?.timeline[0]?.semanticEvents).toEqual(semanticEvents);
  });

  it('drops action semantics not bound to any carrier identity', () => {
    const semanticEvents = agentRunSemanticEvents({
      runId: 'run-semantic-unbound',
      model: 'qwen3-coder',
      status: 'done',
    });
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        readDispatchProductionEvents: () => [],
        listOutcomeRecords: () => [],
        readAgentActions: () => [action({
          actor: 'agent',
          kind: 'maintenance',
          action: 'sandboxed-engine:run',
          proposalId: undefined,
          runId: 'run-semantic-different',
          trajectoryId: undefined,
          model: 'qwen3-coder',
          semanticEvents,
        })],
      }),
    });

    expect(record?.timeline[0]?.semanticEvents).toBeUndefined();
  });

  it('publishes degraded agent-action source quality instead of a healthy empty timeline', () => {
    const actions = [action({
      proposalId: SEMANTIC_PROPOSAL_ID,
      runId: 'run-degraded-actions',
      trajectoryId: 'traj-degraded-actions',
    })];
    Object.defineProperty(actions, 'sourceQuality', {
      value: {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        stopReasons: ['io-error'], filesRead: 1, bytesRead: 100,
        rowsScanned: 2, invalidRows: 1, unreadableFiles: 0,
      },
      enumerable: false,
    });
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({
        listOutcomeRecords: () => [],
        readAgentActions: () => actions,
      }),
    });
    expect(record?.agentActionSourceQuality).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1,
    });
  });

  it('retains the newest semantic occurrence when the timeline exceeds its cap', () => {
    const [semanticEvent] = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', SEMANTIC_PROPOSAL_ID),
      producerRole: 'agent', producerModelFamily: 'local', producerVersion: 'agent-semantic-v1',
    }, [{ kind: 'intent', predicate: 'agent.intent.execute', objectiveCode: 'proposal.evaluate' }]);
    const baseMs = Date.parse(TS1);
    const actions = Array.from({ length: 41 }, (_, index) => action({
      ts: new Date(baseMs + index * 1_000).toISOString(),
      proposalId: SEMANTIC_PROPOSAL_ID,
      runId: 'run-timeline-cap',
      trajectoryId: 'traj-timeline-cap',
      ...(index === 40 ? { semanticEvents: [semanticEvent!] } : {}),
    }));
    const [record] = listTrajectoryRecords({
      windowHours: 1000,
      deps: deps({ listOutcomeRecords: () => [], readAgentActions: () => actions }),
    });
    expect(record?.timeline).toHaveLength(40);
    expect(record?.timeline.at(-1)?.semanticEvents).toEqual([semanticEvent]);
    expect(record?.timeline[0]?.ts).toBe(new Date(baseMs + 1_000).toISOString());
  });
});

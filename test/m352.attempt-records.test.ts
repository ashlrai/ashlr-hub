/**
 * m352.attempt-records.test.ts — read-only attempt coverage joins.
 */

import { describe, expect, it } from 'vitest';
import {
  listAttemptRecords,
  summarizeAttemptCoverage,
  type AttemptRecordReadDeps,
} from '../src/core/autonomy/attempt-records.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import type { AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import type { OutcomeRecord } from '../src/core/autonomy/outcome-records.js';
import type { AutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import type { DecisionEntry } from '../src/core/types.js';
import type { WorkedLedger } from '../src/core/fleet/worked-ledger.js';

const TS = '2026-07-09T12:00:00.000Z';
const REPO = '/tmp/repo';
const MODEL_SECRET = 'sk-testvalue-verysecret00000000';
const ROUTE_SECRET = 'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ';
const REASON_SECRET = 'literal-secret-value-DO-NOT-LOG';

function dispatch(overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: TS,
    itemId: 'item-1',
    source: 'goal',
    repo: REPO,
    title: 'Ship the thing',
    backend: 'local-coder',
    tier: 'local',
    model: 'qwen',
    assignedBy: 'test',
    routeReason: 'test route',
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId: 'prop-1',
    runId: 'run-1',
    trajectoryId: 'traj-1',
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    ...overrides,
  };
}

function action(overrides: Partial<AgentActionEvent> = {}): AgentActionEvent {
  return {
    schemaVersion: 1,
    ts: TS,
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'proposal-created',
    action: 'dispatch',
    summary: 'dispatch summary',
    repo: REPO,
    itemId: 'item-1',
    proposalId: 'prop-1',
    runId: 'run-1',
    trajectoryId: 'traj-1',
    backend: 'local-coder',
    tier: 'local',
    ...overrides,
  };
}

function outcomeRecord(proposalId = 'prop-1'): OutcomeRecord {
  return {
    version: 1,
    proposal: {
      id: proposalId,
      repo: REPO,
      origin: 'agent',
      kind: 'patch',
      status: 'pending',
      title: 'Proposal title',
      createdAt: TS,
    },
    lastActivityAt: TS,
    decisions: [],
    judgeTraces: [],
    evidencePacks: [],
    workedEvents: [],
  };
}

function decision(proposalId = 'prop-1'): DecisionEntry {
  return {
    ts: TS,
    proposalId,
    action: 'judged',
    detail: 'RAW_DECISION_SECRET_SHOULD_NOT_APPEAR',
  };
}

function evidence(proposalId = 'prop-1'): AutonomyEvidencePack {
  return {
    version: 1,
    generatedAt: TS,
    proposal: {
      id: proposalId,
      repo: REPO,
      kind: 'patch',
      status: 'pending',
      origin: 'agent',
      title: 'Evidence title',
      createdAt: TS,
    },
    producer: {},
    diff: { files: 1, lines: 2 },
    target: 'main',
    trustBasis: 'verification',
    remotePreferred: false,
    riskClass: 'low',
    gates: {
      authority: { passed: true },
      provenance: { passed: true },
      verification: { passed: true, detail: 'RAW_EVIDENCE_SECRET_SHOULD_NOT_APPEAR' },
      risk: { passed: true },
      scope: { passed: true },
    },
    verification: { passed: true, ranCommands: 1 },
  } as AutonomyEvidencePack;
}

function deps(overrides: Partial<AttemptRecordReadDeps> = {}): AttemptRecordReadDeps {
  return {
    readDispatchProductionEvents: () => [dispatch()],
    readAgentActions: () => [action()],
    listOutcomeRecords: () => [outcomeRecord()],
    readDecisions: () => [decision()],
    listAutonomyEvidencePacks: () => [evidence()],
    loadWorkedLedger: (): WorkedLedger => ({
      events: [{ itemId: 'item-1', outcome: 'diff', ts: TS, proposalId: 'prop-1' }],
    }),
    ...overrides,
  };
}

describe('AttemptRecord coverage', () => {
  it('joins dispatch attempts to agent action, outcome, decision, evidence, and worked rows', () => {
    const records = listAttemptRecords({ deps: deps() });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'trajectory:traj-1',
      proposalId: 'prop-1',
      runId: 'run-1',
      trajectoryId: 'traj-1',
      learningKind: 'proposal-created',
      diagnosticAttempt: true,
      policySuppressed: false,
      diagnosticNoProposal: false,
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 0,
      },
      coverage: {
        agentAction: true,
        outcomeRecord: true,
        decision: true,
        evidence: true,
        worked: true,
      },
    });

    const summary = summarizeAttemptCoverage(records);
    expect(summary.coverage.agentAction).toEqual({ count: 1, rate: 1 });
    expect(summary.production).toMatchObject({
      attempts: 1,
      proposalCreated: 1,
      policySuppressed: 0,
      diagnosticAttempts: 1,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: 1,
      diagnosticNoProposalRate: 0,
    });
    expect(summary.gaps).toEqual([]);
  });

  it('does not join by fuzzy title or repo when causal ids differ', () => {
    const records = listAttemptRecords({
      deps: deps({
        readAgentActions: () => [action({
          itemId: 'other-item',
          proposalId: 'other-prop',
          runId: 'other-run',
          trajectoryId: 'other-traj',
        })],
        listOutcomeRecords: () => [outcomeRecord('other-prop')],
        readDecisions: () => [decision('other-prop')],
        listAutonomyEvidencePacks: () => [evidence('other-prop')],
        loadWorkedLedger: () => ({ events: [{ itemId: 'other-item', outcome: 'diff', ts: TS, proposalId: 'other-prop' }] }),
      }),
    });

    expect(records[0]?.coverage).toEqual({
      agentAction: false,
      outcomeRecord: false,
      decision: false,
      evidence: false,
      worked: false,
    });
  });

  it('uses legacy repo+item fallback only inside the timestamp window', () => {
    const inside = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [dispatch({ trajectoryId: undefined, runId: undefined, proposalId: undefined })],
        readAgentActions: () => [action({ trajectoryId: undefined, runId: undefined, proposalId: undefined })],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
      }),
    });
    expect(inside[0]?.coverage.agentAction).toBe(true);

    const outside = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [dispatch({ trajectoryId: undefined, runId: undefined, proposalId: undefined })],
        readAgentActions: () => [action({
          ts: '2026-07-09T12:30:01.000Z',
          trajectoryId: undefined,
          runId: undefined,
          proposalId: undefined,
        })],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
      }),
    });
    expect(outside[0]?.coverage.agentAction).toBe(false);
  });

  it('does not treat derived work trajectories as exact joins', () => {
    const records = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [dispatch({
          trajectoryId: 'work:item-1',
          runId: undefined,
          proposalId: undefined,
        })],
        readAgentActions: () => [action({
          ts: '2026-07-09T12:30:01.000Z',
          trajectoryId: 'work:item-1',
          runId: undefined,
          proposalId: undefined,
        })],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
      }),
    });

    expect(records[0]?.coverage.agentAction).toBe(false);
  });

  it('keeps no-proposal attempts learnable without fake proposal coverage', () => {
    const records = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [dispatch({
          outcome: 'empty-diff',
          proposalCreated: false,
          proposalId: undefined,
        })],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
      }),
    });

    expect(records[0]?.proposalId).toBeUndefined();
    expect(records[0]).toMatchObject({
      learningKind: 'diagnostic-no-proposal',
      diagnosticAttempt: true,
      diagnosticNoProposal: true,
      policySuppressed: false,
      attemptShape: {
        backendNoDiff: 1,
        policyDisabled: 0,
      },
    });
    expect(records[0]?.coverage).toMatchObject({
      agentAction: true,
      outcomeRecord: false,
      decision: false,
      evidence: false,
      worked: true,
    });
  });

  it('classifies policy-disabled attempts separately from diagnostic no-proposal attempts', () => {
    const records = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({
            itemId: 'policy-disabled',
            outcome: 'proposal-disabled',
            proposalCreated: false,
            proposalId: undefined,
            runEventSummary: {
              outcome: 'proposal-disabled',
              proposalCreated: false,
              actionCounts: { proposalDisabled: 1 },
            },
          }),
          dispatch({
            itemId: 'empty-diff',
            outcome: 'empty-diff',
            proposalCreated: false,
            proposalId: undefined,
            runEventSummary: {
              outcome: 'empty-diff',
              proposalCreated: false,
              actionCounts: { diffFiles: 0 },
            },
          }),
          dispatch({
            itemId: 'created',
            outcome: 'proposal-created',
            proposalCreated: true,
            proposalId: 'prop-created',
            runEventSummary: {
              outcome: 'proposal-created',
              proposalCreated: true,
              actionCounts: { proposalCreated: 1 },
            },
          }),
        ],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
        loadWorkedLedger: () => ({ events: [] }),
      }),
    });

    expect(records.map((record) => record.learningKind)).toEqual([
      'policy-suppressed',
      'diagnostic-no-proposal',
      'proposal-created',
    ]);
    expect(records[0]).toMatchObject({
      policySuppressed: true,
      diagnosticAttempt: false,
      diagnosticNoProposal: false,
      attemptShape: { policyDisabled: 1 },
    });
    expect(records[1]).toMatchObject({
      policySuppressed: false,
      diagnosticAttempt: true,
      diagnosticNoProposal: true,
      attemptShape: { backendNoDiff: 1 },
    });
    const summary = summarizeAttemptCoverage(records);
    expect(summary.production).toMatchObject({
      attempts: 3,
      proposalCreated: 1,
      policySuppressed: 1,
      diagnosticAttempts: 2,
      diagnosticNoProposal: 1,
      diagnosticProposalRate: 0.5,
      diagnosticNoProposalRate: 0.5,
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 1,
      },
    });
    expect(summary.recent.map((record) => record.learningKind)).toEqual([
      'policy-suppressed',
      'diagnostic-no-proposal',
      'proposal-created',
    ]);
  });

  it('keeps all policy-suppressed attempts out of diagnostic attempt denominators', () => {
    const records = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [
          dispatch({
            itemId: 'policy-disabled',
            outcome: 'proposal-disabled',
            proposalCreated: false,
            proposalId: undefined,
            runEventSummary: {
              outcome: 'proposal-disabled',
              proposalCreated: false,
              actionCounts: { proposalDisabled: 1 },
            },
          }),
        ],
        readAgentActions: () => [],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
        loadWorkedLedger: () => ({ events: [] }),
      }),
    });

    const summary = summarizeAttemptCoverage(records);

    expect(records[0]).toMatchObject({
      learningKind: 'policy-suppressed',
      diagnosticAttempt: false,
      diagnosticNoProposal: false,
      policySuppressed: true,
    });
    expect(summary.production).toMatchObject({
      attempts: 1,
      proposalCreated: 0,
      policySuppressed: 1,
      diagnosticAttempts: 0,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: null,
      diagnosticNoProposalRate: null,
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 1,
      },
    });
  });

  it('requires timestamp proximity for legacy worked item coverage', () => {
    const staleWorked = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [dispatch({
          outcome: 'empty-diff',
          proposalCreated: false,
          proposalId: undefined,
        })],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
        loadWorkedLedger: () => ({
          events: [{ itemId: 'item-1', outcome: 'empty', ts: '2026-07-09T12:30:01.000Z' }],
        }),
      }),
    });
    expect(staleWorked[0]?.coverage.worked).toBe(false);

    const exactProposalWorked = listAttemptRecords({
      deps: deps({
        loadWorkedLedger: () => ({
          events: [{ itemId: 'unrelated-item', outcome: 'diff', ts: '2026-07-08T00:00:00.000Z', proposalId: 'prop-1' }],
        }),
      }),
    });
    expect(exactProposalWorked[0]?.coverage.worked).toBe(true);
  });

  it('does not serialize raw joined detail fields', () => {
    const records = listAttemptRecords({
      deps: deps({
        readDispatchProductionEvents: () => [dispatch({
          model: `gpt-5.5 ${MODEL_SECRET}`,
          routeReason: `route ${ROUTE_SECRET}`,
          reason: `reason password=${REASON_SECRET}`,
        })],
      }),
    });
    const serialized = JSON.stringify(records);

    expect(serialized).not.toContain('RAW_DECISION_SECRET_SHOULD_NOT_APPEAR');
    expect(serialized).not.toContain('RAW_EVIDENCE_SECRET_SHOULD_NOT_APPEAR');
    expect(serialized).not.toContain(MODEL_SECRET);
    expect(serialized).not.toContain(ROUTE_SECRET);
    expect(serialized).not.toContain(REASON_SECRET);
  });

  it('summarizes with aggregate-safe refs instead of local repo or proposal ids', () => {
    const records = listAttemptRecords({
      deps: deps({
        readAgentActions: () => [],
        listOutcomeRecords: () => [],
        readDecisions: () => [],
        listAutonomyEvidencePacks: () => [],
        loadWorkedLedger: () => ({ events: [] }),
      }),
    });
    const summary = summarizeAttemptCoverage(records);
    const serialized = JSON.stringify(summary);

    expect(summary.recent[0]?.ref).toMatch(/^attempt:[a-f0-9]{12}$/);
    expect(summary.gaps[0]?.sampleRefs[0]).toMatch(/^attempt:[a-f0-9]{12}$/);
    expect(serialized).not.toContain(REPO);
    expect(serialized).not.toContain('item-1');
    expect(serialized).not.toContain('prop-1');
    expect(serialized).not.toContain('traj-1');
  });

  it('returns bounded partial records when optional sources throw', () => {
    const records = listAttemptRecords({
      deps: deps({
        readAgentActions: () => { throw new Error('boom'); },
        listOutcomeRecords: () => { throw new Error('boom'); },
        readDecisions: () => { throw new Error('boom'); },
        listAutonomyEvidencePacks: () => { throw new Error('boom'); },
        loadWorkedLedger: () => { throw new Error('boom'); },
      }),
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.coverage).toEqual({
      agentAction: false,
      outcomeRecord: false,
      decision: false,
      evidence: false,
      worked: false,
    });
  });
});

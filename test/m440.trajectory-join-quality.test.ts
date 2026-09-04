/**
 * m440.trajectory-join-quality.test.ts — bounded compositional join diagnostics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listOutcomeRecords,
  listOutcomeRecordsDetailed,
  type OutcomeRecordDetailedReadDeps,
  type OutcomeRecordsDetailedResult,
} from '../src/core/autonomy/outcome-records.js';
import {
  listTrajectoryJoinQuality,
} from '../src/core/autonomy/trajectory-records.js';
import type {
  AgentActionEvent,
  AgentActionsReadResult,
} from '../src/core/fleet/agent-action-ledger.js';
import type {
  DispatchProductionEvent,
  DispatchProductionEventsReadResult,
} from '../src/core/fleet/dispatch-production-ledger.js';
import type { PostMergeObservationReadResult } from '../src/core/fleet/post-merge-observations.js';
import type { Proposal } from '../src/core/types.js';

const TS0 = '2026-07-28T20:00:00.000Z';
const TS1 = '2026-07-28T20:01:00.000Z';
const TS2 = '2026-07-28T20:02:00.000Z';
const TS3 = '2026-07-28T20:03:00.000Z';
const TS4 = '2026-07-28T20:04:00.000Z';
const TS5 = '2026-07-28T20:05:00.000Z';
const NOW = '2026-07-28T20:05:01.000Z';
const REPO = '/private/company/ashlr-hub';
const PROPOSAL_ID = 'prop-trajectory-join-quality';
const RUN_ID = 'run-trajectory-join-quality';
const TRAJECTORY_ID = 'trajectory-join-quality';
const RAW_SECRET = 'RAW_PROMPT_DIFF_STDOUT_SECRET';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function proposal(): Proposal {
  return {
    id: PROPOSAL_ID,
    repo: REPO,
    origin: 'agent',
    kind: 'patch',
    title: 'Protected trajectory fixture',
    summary: 'Metadata-only test proposal',
    status: 'applied',
    createdAt: TS1,
    workItemId: 'work-trajectory-join-quality',
    workSource: 'goal',
    runId: RUN_ID,
    trajectoryId: TRAJECTORY_ID,
    diffHash: 'a'.repeat(64),
    verifyResult: {
      passed: true,
      ran: [{
        id: 'test',
        kind: 'test',
        cmd: ['npm', 'test'],
        required: true,
        profiles: ['merge'],
      }],
      baseBranch: 'main',
      baseHead: 'b'.repeat(40),
      diffHash: 'a'.repeat(64),
      verifiedAt: TS2,
      source: 'auto-merge',
    },
    realizedMerge: {
      schemaVersion: 1,
      source: 'github-host',
      provider: 'github',
      prUrl: 'https://github.com/ashlrai/ashlr-hub/pull/440',
      branch: 'ashlr/merge/trajectory-join-quality',
      base: 'main',
      expectedHeadOid: 'c'.repeat(40),
      mergeCommitOid: 'd'.repeat(40),
      mergedAt: TS4,
      reconciliation: {
        schemaVersion: 1,
        observedAt: TS4,
        attestation: 'e'.repeat(64),
      },
    },
  };
}

function postMergeRead(
  overrides: Partial<PostMergeObservationReadResult> = {},
): PostMergeObservationReadResult {
  return {
    observations: [{
      schemaVersion: 1,
      eventId: 'f'.repeat(64),
      observedAt: TS5,
      authority: 'observation-only',
      outcome: 'regressed',
      basis: 'bisect-first-bad',
      confidence: 'deterministic',
      repo: REPO,
      proposalId: PROPOSAL_ID,
      runId: RUN_ID,
      trajectoryId: TRAJECTORY_ID,
      workItemId: 'work-trajectory-join-quality',
      mergeCommit: 'd'.repeat(40),
      observedHead: '0'.repeat(40),
      baselineHead: '1'.repeat(40),
      candidateCount: 1,
      commandKinds: ['test'],
      labelBasis: 'post-merge-regression',
      attestation: '2'.repeat(64),
    }],
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesRead: 1,
    bytesRead: 512,
    physicalRows: 1,
    invalidRows: 0,
    conflictingEvents: 0,
    duplicateRows: 0,
    supersededRows: 0,
    limitExceeded: false,
    ...overrides,
  };
}

function outcomeDeps(): OutcomeRecordDetailedReadDeps {
  return {
    listProposals: () => [proposal()],
    readDecisions: () => [{
      ts: TS4,
      proposalId: PROPOSAL_ID,
      action: 'merged',
      workItemId: 'work-trajectory-join-quality',
      workSource: 'goal',
      runId: RUN_ID,
      trajectoryId: TRAJECTORY_ID,
      verdict: 'ship',
      engine: 'codex',
      model: 'gpt-5.5',
    }],
    readJudgeTraces: () => [],
    loadWorkedLedger: () => ({ events: [] }),
    listAutonomyEvidencePacks: () => [{
      version: 2,
      generatedAt: TS3,
      proposal: {
        id: PROPOSAL_ID,
        repo: REPO,
        status: 'applied',
      },
      target: 'proposal',
      trustBasis: 'verification',
      riskClass: 'low',
      diff: {
        hash: 'a'.repeat(64),
        files: 1,
        changedLines: 8,
      },
      gates: {
        authority: { ok: true, detail: 'bounded' },
        provenance: { ok: true, detail: 'bounded' },
        verification: { ok: true, detail: 'bounded' },
        risk: { ok: true, detail: 'bounded' },
        scope: { ok: true, detail: 'bounded' },
      },
      verification: {
        passed: true,
        detail: 'bounded',
        commandKinds: ['test'],
        baseBranch: 'main',
        baseHead: 'b'.repeat(40),
        diffHash: 'a'.repeat(64),
        verifiedAt: TS2,
        source: 'contract',
      },
      trajectoryId: TRAJECTORY_ID,
      runEventSummary: {
        runId: RUN_ID,
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: PROPOSAL_ID,
      },
    }],
    racingStats: () => ({}) as never,
    readPostMergeObservations: () => postMergeRead(),
  };
}

function dispatchRead(): DispatchProductionEventsReadResult {
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: TS0,
    itemId: 'work-trajectory-join-quality',
    source: 'goal',
    repo: REPO,
    title: `private title ${RAW_SECRET}`,
    backend: 'codex',
    tier: 'frontier',
    model: 'gpt-5.5',
    assignedBy: 'test',
    routeReason: `private route ${RAW_SECRET}`,
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId: PROPOSAL_ID,
    runId: RUN_ID,
    trajectoryId: TRAJECTORY_ID,
    spentUsd: 1,
    basis: 'run-proposal-outcome',
  };
  return {
    events: [event],
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesRead: 1,
    datedFilesRead: 1,
    looseFilesRead: 0,
    bytesRead: 256,
    rowsScanned: 1,
    invalidRows: 0,
    unreadableFiles: 0,
  };
}

function actionRead(): AgentActionsReadResult {
  const linked: AgentActionEvent = {
    schemaVersion: 1,
    ts: TS3,
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'proposal-created',
    action: 'daemon:dispatch',
    summary: `private stdout ${RAW_SECRET}`,
    proposalId: PROPOSAL_ID,
    runId: RUN_ID,
    trajectoryId: TRAJECTORY_ID,
  };
  const unjoined: AgentActionEvent = {
    ...linked,
    ts: TS4,
    proposalId: 'prop-unjoined-private',
    runId: 'run-unjoined-private',
    trajectoryId: 'trajectory-unjoined-private',
  };
  const identityFree: AgentActionEvent = {
    ...linked,
    ts: TS5,
    proposalId: undefined,
    runId: undefined,
    trajectoryId: undefined,
  };
  return {
    events: [linked, unjoined, identityFree],
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesRead: 1,
    bytesRead: 384,
    rowsScanned: 3,
    invalidRows: 0,
    unreadableFiles: 0,
  };
}

describe('trajectory join quality', () => {
  it('preserves the outcome compatibility reader while exposing compositional source quality', () => {
    const deps = outcomeDeps();
    const detailed = listOutcomeRecordsDetailed({ deps });
    const compatibility = listOutcomeRecords({ deps });

    expect(Array.isArray(compatibility)).toBe(true);
    expect(compatibility).toHaveLength(1);
    expect(detailed.records).toHaveLength(1);
    expect(detailed.records[0]?.proposal).toMatchObject({
      id: PROPOSAL_ID,
      realizedMergeSource: 'github-host',
      realizedMergeAt: TS4,
    });
    expect(detailed.sourceQuality).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      sources: {
        proposals: { sourceState: 'healthy', complete: true },
        decisions: { sourceState: 'healthy', complete: true },
        evidence: { sourceState: 'healthy', complete: true },
        postMerge: { sourceState: 'healthy', complete: true },
      },
    });
  });

  it('reconstructs a protected GitHub trajectory and publishes exact healthy edge rates', () => {
    const outcomes = listOutcomeRecordsDetailed({ deps: outcomeDeps() });
    const result = listTrajectoryJoinQuality({
      windowHours: 24 * 30,
      deps: {
        readDispatchProductionEventsDetailed: () => dispatchRead(),
        listOutcomeRecordsDetailed: () => outcomes,
        readAgentActionsDetailed: () => actionRead(),
        loadProposal: () => proposal(),
      },
    });

    expect(result.sourceQuality).toMatchObject({ sourceState: 'healthy', complete: true });
    for (const edge of Object.values(result.edges)) {
      expect(edge).toMatchObject({
        denominator: 1,
        joined: 1,
        unjoined: 0,
        conflicting: 0,
        rate: 1,
      });
    }
    expect(result.agentActions).toMatchObject({
      denominator: 2,
      joined: 1,
      unjoined: 1,
      conflicting: 0,
      excludedIdentityFree: 1,
      rate: 0.5,
    });
    expect(result.agentActions.unjoinedSampleRefs).toEqual([
      expect.stringMatching(/^join:[a-f0-9]{12}$/),
    ]);

    expect(result.records).toHaveLength(2);
    const protectedTrajectory = result.records.find((record) => record.coverage.dispatch);
    expect(protectedTrajectory).toMatchObject({
      terminalOutcome: 'merged',
      realizedOutcome: 'regressed',
      proposalId: PROPOSAL_ID,
      trajectoryId: TRAJECTORY_ID,
    });
    expect(protectedTrajectory?.timeline.map((event) => event.kind)).toEqual([
      'dispatch',
      'proposal',
      'evidence',
      'agent-action',
      'decision',
      'post-merge',
    ]);

    const diagnostics = JSON.stringify({
      sourceQuality: result.sourceQuality,
      edges: result.edges,
      agentActions: result.agentActions,
    });
    expect(diagnostics).not.toContain(RAW_SECRET);
    expect(diagnostics).not.toContain(REPO);
    expect(diagnostics).not.toContain(PROPOSAL_ID);
    expect(diagnostics).not.toContain(RUN_ID);
    expect(diagnostics).not.toContain(TRAJECTORY_ID);
    for (const forbidden of ['prompt', 'diff', 'stdout', 'stderr', 'env', 'file contents']) {
      expect(diagnostics.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('keeps exact observed counts but withholds rates for degraded denominator sources', () => {
    const healthy = listOutcomeRecordsDetailed({ deps: outcomeDeps() });
    const degraded: OutcomeRecordsDetailedResult = {
      records: healthy.records,
      sourceQuality: {
        ...healthy.sourceQuality,
        sourceState: 'degraded',
        complete: false,
        sources: {
          ...healthy.sourceQuality.sources,
          postMerge: {
            ...healthy.sourceQuality.sources.postMerge,
            sourceState: 'degraded',
            complete: false,
            stopReasons: ['conflict'],
            conflictingEvents: 1,
          },
        },
      },
    };
    const result = listTrajectoryJoinQuality({
      windowHours: 24 * 30,
      deps: {
        readDispatchProductionEventsDetailed: () => dispatchRead(),
        listOutcomeRecordsDetailed: () => degraded,
        readAgentActionsDetailed: () => actionRead(),
      },
    });

    expect(result.sourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(result.edges.realizedMergeToPostMerge).toMatchObject({
      denominator: 1,
      joined: 1,
      unjoined: 0,
      conflicting: 0,
    });
    expect(result.edges.realizedMergeToPostMerge).not.toHaveProperty('rate');
    expect(result.edges.dispatchToProposal.rate).toBe(1);
    expect(result.edges.proposalToVerification.rate).toBe(1);
    expect(result.edges.verifiedToProtectedRealizedMerge.rate).toBe(1);
  });
});

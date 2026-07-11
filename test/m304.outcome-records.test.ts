/**
 * m304.outcome-records.test.ts — first read-only OutcomeRecord primitive.
 *
 * Verifies that existing proposal, decision, judge, worked, racing, and
 * autonomy evidence stores are joined into bounded newest-first records without
 * adding writes or failing on missing/corrupt optional inputs.
 */

import { describe, expect, it } from 'vitest';
import type { AutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import type { OutcomeRecordReadDeps } from '../src/core/autonomy/outcome-records.js';
import { listOutcomeRecords, listReadyEvidenceOutcomeRecords } from '../src/core/autonomy/outcome-records.js';
import { hashDiff } from '../src/core/foundry/provenance.js';
import type { JudgeTrace } from '../src/core/fleet/judge-trace.js';
import type { WorkedEvent } from '../src/core/fleet/worked-ledger.js';
import type { DecisionEntry, Proposal } from '../src/core/types.js';

const TEST_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const TEST_DIFF_HASH = hashDiff(TEST_DIFF);

function proposal(overrides: Partial<Proposal> & Pick<Proposal, 'id' | 'createdAt'>): Proposal {
  return {
    repo: '/repos/alpha',
    origin: 'agent',
    kind: 'patch',
    title: `proposal ${overrides.id}`,
    summary: 'outcome record test',
    status: 'pending',
    ...overrides,
  } as Proposal;
}

function decision(proposalId: string, ts: string, overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    proposalId,
    ts,
    action: 'judged',
    verdict: 'ship',
    ...overrides,
  };
}

function trace(proposalId: string, ts: string, overrides: Partial<JudgeTrace> = {}): JudgeTrace {
  return {
    proposalId,
    ts,
    judgeEngine: 'claude-test',
    verdict: 'ship',
    scores: { value: 4, correctness: 5, scope: 2, alignment: 4 },
    fullReasoning: 'not surfaced in outcome records',
    promptContext: 'not surfaced in outcome records',
    ...overrides,
  };
}

function evidence(proposalId: string, generatedAt: string): AutonomyEvidencePack {
  return {
    version: 1,
    generatedAt,
    proposal: {
      id: proposalId,
      repo: '/repos/alpha',
      kind: 'patch',
      status: 'pending',
      origin: 'agent',
      title: 'evidence proposal',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    producer: { engineModel: 'codex:gpt-5.5', engineTier: 'frontier' },
    diff: { files: ['src/a.ts'], changedLines: 4, hash: TEST_DIFF_HASH },
    target: 'main',
    trustBasis: 'tier',
    remotePreferred: false,
    riskClass: 'low',
    gates: {
      authority: { ok: true, detail: 'authority ok' },
      provenance: { ok: true, detail: 'provenance ok' },
      verification: { ok: true, detail: 'verification ok' },
      risk: { ok: true, detail: 'risk ok' },
      scope: { ok: true, detail: 'scope ok' },
    },
    verification: {
      passed: true,
      detail: 'tests passed',
      commandKinds: ['test'],
      baseBranch: 'main',
      baseHead: 'a'.repeat(40),
      diffHash: TEST_DIFF_HASH,
      verifiedAt: generatedAt,
      source: 'auto-merge',
    },
    policy: {
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
      reason: 'full evidence',
    },
  };
}

function deps(overrides: Partial<OutcomeRecordReadDeps> = {}): OutcomeRecordReadDeps {
  return {
    listProposals: () => [],
    readDecisions: () => [],
    readJudgeTraces: () => [],
    loadWorkedLedger: () => ({ events: [] }),
    listAutonomyEvidencePacks: () => [],
    racingStats: () => ({ races: 0, frontierWinRate: 0, avgScoreDelta: 0, localWins: 0 }),
    ...overrides,
  };
}

describe('m302 listOutcomeRecords', () => {
  it('joins proposal outcomes across existing read-only stores', () => {
    const worked: WorkedEvent = {
      itemId: 'prop-new',
      outcome: 'diff',
      ts: '2026-07-03T02:00:00.000Z',
    };

    const records = listOutcomeRecords({
      deps: deps({
        listProposals: () => [
          proposal({
            id: 'prop-new',
            createdAt: '2026-07-03T00:00:00.000Z',
            status: 'approved',
            decidedAt: '2026-07-03T01:00:00.000Z',
            engineModel: 'codex:gpt-5.5',
            engineTier: 'frontier',
            riskClass: 'low',
            verifyResult: { passed: true },
            diffHash: 'sha256:test',
          }),
        ],
        readDecisions: () => [
          decision('prop-new', '2026-07-03T01:30:00.000Z', {
            action: 'merged',
            engine: 'codex',
            model: 'codex:gpt-5.5',
            workItemId: 'repo:todo:prop-new',
            workSource: 'todo',
            runId: 'run-prop-new',
          }),
        ],
        readJudgeTraces: () => [
          trace('prop-new', '2026-07-03T00:30:00.000Z', {
            outcome: 'merged',
            outcomeAt: '2026-07-03T01:45:00.000Z',
          }),
        ],
        loadWorkedLedger: () => ({ events: [worked] }),
        listAutonomyEvidencePacks: () => [evidence('prop-new', '2026-07-03T01:40:00.000Z')],
        racingStats: () => ({ races: 3, frontierWinRate: 2 / 3, avgScoreDelta: 4, localWins: 1 }),
      }),
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.proposal).toMatchObject({
      id: 'prop-new',
      status: 'approved',
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      riskClass: 'low',
      diffHash: 'sha256:test',
    });
    expect(records[0]?.decisions).toEqual([
      expect.objectContaining({
        action: 'merged',
        model: 'codex:gpt-5.5',
        workItemId: 'repo:todo:prop-new',
        workSource: 'todo',
        runId: 'run-prop-new',
      }),
    ]);
    expect(records[0]?.judgeTraces).toEqual([
      expect.objectContaining({ verdict: 'ship', outcome: 'merged' }),
    ]);
    expect(records[0]?.evidencePacks).toEqual([
      expect.objectContaining({ target: 'main', trustBasis: 'tier' }),
    ]);
    expect(records[0]?.workedEvents).toEqual([
      expect.objectContaining({ itemId: 'prop-new', outcome: 'diff' }),
    ]);
    expect(records[0]?.racing?.races).toBe(3);
    expect(records[0]?.lastActivityAt).toBe('2026-07-03T02:00:00.000Z');
  });

  it('sorts newest-first by joined activity and applies the limit after sorting', () => {
    const records = listOutcomeRecords({
      limit: 2,
      deps: deps({
        listProposals: () => [
          proposal({ id: 'prop-old', createdAt: '2026-07-01T00:00:00.000Z' }),
          proposal({ id: 'prop-mid', createdAt: '2026-07-02T00:00:00.000Z' }),
          proposal({ id: 'prop-new', createdAt: '2026-07-01T00:00:00.000Z' }),
        ],
        readDecisions: () => [
          decision('prop-new', '2026-07-03T00:00:00.000Z'),
        ],
      }),
    });

    expect(records.map((r) => r.proposal.id)).toEqual(['prop-new', 'prop-mid']);
  });

  it('tolerates missing or throwing optional stores', () => {
    const records = listOutcomeRecords({
      deps: deps({
        listProposals: () => [
          proposal({ id: 'prop-safe', createdAt: '2026-07-01T00:00:00.000Z' }),
        ],
        readDecisions: () => {
          throw new Error('corrupt decisions ledger');
        },
        readJudgeTraces: () => {
          throw new Error('corrupt judge traces');
        },
        loadWorkedLedger: () => {
          throw new Error('corrupt worked ledger');
        },
        listAutonomyEvidencePacks: () => {
          throw new Error('corrupt evidence packs');
        },
        racingStats: () => {
          throw new Error('racing unavailable');
        },
      }),
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.proposal.id).toBe('prop-safe');
    expect(records[0]?.decisions).toEqual([]);
    expect(records[0]?.judgeTraces).toEqual([]);
    expect(records[0]?.evidencePacks).toEqual([]);
    expect(records[0]?.workedEvents).toEqual([]);
    expect(records[0]?.racing).toBeUndefined();
  });

  it('reads bounded ready evidence records without heavy outcome joins', () => {
    const requestedLimits: Array<number | undefined> = [];
    const loadedProposalIds: string[] = [];
    const records = listReadyEvidenceOutcomeRecords({
      limit: 2,
      now: new Date('2026-07-03T03:30:00.000Z'),
      deps: {
        listAutonomyEvidencePacks: (limit) => {
          requestedLimits.push(limit);
          return [
            evidence('prop-ready', '2026-07-03T03:00:00.000Z'),
            evidence('prop-missing', '2026-07-03T02:00:00.000Z'),
            evidence('prop-applied', '2026-07-03T01:00:00.000Z'),
            evidence('prop-ready', '2026-07-03T00:00:00.000Z'),
          ];
        },
        loadProposal: (id) => {
          loadedProposalIds.push(id);
          if (id === 'prop-ready') {
            return proposal({
              id,
              createdAt: '2026-07-03T00:10:00.000Z',
              status: 'pending',
              diff: TEST_DIFF,
              diffHash: TEST_DIFF_HASH,
              verifyResult: {
                passed: true,
                baseBranch: 'main',
                baseHead: 'a'.repeat(40),
                diffHash: TEST_DIFF_HASH,
                verifiedAt: '2026-07-03T03:00:00.000Z',
                source: 'auto-merge',
              },
            });
          }
          if (id === 'prop-applied') {
            return proposal({ id, createdAt: '2026-07-03T00:20:00.000Z', status: 'applied' });
          }
          return null;
        },
      },
    });

    expect(requestedLimits).toEqual([24]);
    expect(loadedProposalIds).toEqual(['prop-ready', 'prop-missing', 'prop-applied']);
    expect(records).toHaveLength(1);
    expect(records[0]?.proposal).toMatchObject({ id: 'prop-ready', status: 'pending' });
    expect(records[0]?.lastActivityAt).toBe('2026-07-03T03:00:00.000Z');
    expect(records[0]?.evidencePacks[0]?.generatedAt).toBe('2026-07-03T03:00:00.000Z');
    expect(records[0]?.decisions).toEqual([]);
    expect(records[0]?.judgeTraces).toEqual([]);
    expect(records[0]?.workedEvents).toEqual([]);
    expect(records[0]?.racing).toBeUndefined();
  });

  it('rejects replayed bindings and degraded evidence sources', () => {
    const pack = evidence('prop-ready', '2026-07-03T03:00:00.000Z');
    const degraded = [pack] as AutonomyEvidencePack[] & { sourceQuality?: Record<string, unknown> };
    Object.defineProperty(degraded, 'sourceQuality', {
      value: { sourceState: 'degraded', sourcePresent: true, complete: false },
    });
    const live = proposal({
      id: 'prop-ready',
      createdAt: '2026-07-03T00:10:00.000Z',
      status: 'pending',
      diff: TEST_DIFF,
      diffHash: TEST_DIFF_HASH,
      verifyResult: {
        passed: true,
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        diffHash: TEST_DIFF_HASH,
        verifiedAt: '2026-07-03T03:00:00.000Z',
        source: 'auto-merge',
      },
    });

    expect(listReadyEvidenceOutcomeRecords({
      now: new Date('2026-07-03T03:30:00.000Z'),
      deps: { listAutonomyEvidencePacks: () => degraded as AutonomyEvidencePack[], loadProposal: () => live },
    })).toEqual([]);

    const replayed = { ...pack, verification: { ...pack.verification, baseHead: 'b'.repeat(40) } };
    expect(listReadyEvidenceOutcomeRecords({
      now: new Date('2026-07-03T03:30:00.000Z'),
      deps: { listAutonomyEvidencePacks: () => [replayed], loadProposal: () => live },
    })).toEqual([]);
  });
});

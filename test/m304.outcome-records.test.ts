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
import { listOutcomeRecords } from '../src/core/autonomy/outcome-records.js';
import type { JudgeTrace } from '../src/core/fleet/judge-trace.js';
import type { WorkedEvent } from '../src/core/fleet/worked-ledger.js';
import type { DecisionEntry, Proposal } from '../src/core/types.js';

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
    diff: { files: ['src/a.ts'], changedLines: 4, hash: 'sha256:test' },
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
      expect.objectContaining({ action: 'merged', model: 'codex:gpt-5.5' }),
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
});

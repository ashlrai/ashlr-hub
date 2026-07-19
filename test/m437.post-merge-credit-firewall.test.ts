/**
 * M437: realized merges remain factual, but positive learning waits for an
 * explicit post-merge credit release.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DecisionEntry,
  Proposal,
  RealizedMergeEvidence,
  SkillCard,
} from '../src/core/types.js';
import type { OutcomeRecord } from '../src/core/autonomy/outcome-records.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';

const fixture = vi.hoisted(() => ({
  decisions: [] as DecisionEntry[],
  proposals: [] as Proposal[],
}));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: () => {
    const rows = [...fixture.decisions];
    Object.defineProperty(rows, 'sourceQuality', {
      value: {
        sourceState: rows.length > 0 ? 'healthy' : 'missing',
        sourcePresent: rows.length > 0,
        complete: true,
        stopReasons: [],
        filesRead: rows.length > 0 ? 1 : 0,
        bytesRead: 0,
        rowsScanned: rows.length,
        invalidRows: 0,
        unreadableFiles: 0,
      },
      enumerable: false,
    });
    return rows;
  },
  recordDecision: vi.fn(),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: () => [...fixture.proposals],
  listProposalsDetailed: () => ({
    proposals: [...fixture.proposals],
    sourceState: fixture.proposals.length > 0 ? 'healthy' : 'missing',
    sourcePresent: fixture.proposals.length > 0,
    complete: true,
    stopReasons: [],
    filesDiscovered: fixture.proposals.length,
    filesRead: fixture.proposals.length,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
  }),
}));

vi.mock('../src/core/fleet/worked-ledger.js', () => ({
  loadWorkedLedger: () => ({ events: [] }),
}));

vi.mock('../src/core/inbox/realized-merge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/inbox/realized-merge.js')>();
  return { ...real, authenticatedRealizedMergeOf: real.realizedMergeOf };
});

vi.mock('../src/core/foundry/provenance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/foundry/provenance.js')>();
  return {
    ...real,
    verifyProducerProvenanceV2: (proposal: Proposal) => ({
      ok: proposal.producerProvenanceVersion === 2 &&
        proposal.producerProvenanceSig === 'test-producer-provenance',
      reason: 'm437 fixture provenance',
    }),
  };
});

import {
  POST_MERGE_CREDIT_RELEASE_LABEL,
  hasReleasedPostMergeCredit,
  isPostMergeCreditReleaseLabel,
} from '../src/core/fleet/post-merge-credit.js';
import { linkOutcomeResult } from '../src/core/fleet/judge-trace.js';
import {
  hasRealizedMergeEvidence,
  realizedMergeOf,
} from '../src/core/inbox/realized-merge.js';
import { computeOutcomePriors } from '../src/core/fleet/feedback.js';
import {
  computeModelRoi,
  computeQualityMetrics,
} from '../src/core/fleet/quality-metrics.js';
import {
  buildProducerScores,
  LEARNED_ROUTING_MIN_SAMPLES,
} from '../src/core/run/learned-router.js';
import {
  listTrajectoryRecords,
  summarizeTrajectoryLearning,
} from '../src/core/autonomy/trajectory-records.js';
import { skillCardContentHash } from '../src/core/fleet/skill-attestation.js';
import { signSkillCardAttestation } from '../src/core/foundry/provenance.js';
import {
  inspectVerifiedSkillCorpus,
  selectVerifiedSkills,
} from '../src/core/fleet/skill-retrieval.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const REALIZED = 'realized-merge-v1';
const REPO = '/repo/m437';
let previousHome: string | undefined;
let home: string;

function realizedEvidence(observedAt = '2026-07-16T11:00:00.000Z'): RealizedMergeEvidence {
  return {
    schemaVersion: 1,
    source: 'local-default-branch',
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid: '3'.repeat(40),
    observedAt,
  };
}

function proposal(id: string): Proposal {
  return {
    id,
    repo: REPO,
    origin: 'backlog',
    kind: 'patch',
    title: `M437 proposal ${id}`,
    summary: 'Exercise positive post-merge consumers.',
    diff: 'diff --git a/a.ts b/a.ts\n+export const value = 1;',
    status: 'applied',
    createdAt: '2026-07-16T10:00:00.000Z',
    workItemId: `${REPO}:issue:${id}`,
    workSource: 'issue',
    engineModel: 'codex:gpt-5.5',
    producerProvenanceVersion: 2,
    producerProvenanceSig: 'test-producer-provenance',
    realizedMerge: realizedEvidence(),
  };
}

function installConsumerFixture(labelBasis: string): void {
  const count = LEARNED_ROUTING_MIN_SAMPLES + 1;
  fixture.proposals = Array.from({ length: count }, (_, index) => proposal(`proposal-${index}`));
  fixture.decisions = fixture.proposals.flatMap((entry, index) => [
    {
      ts: `2026-07-16T10:${String(index).padStart(2, '0')}:00.000Z`,
      proposalId: entry.id,
      action: 'proposed' as const,
      engine: 'codex',
      model: 'codex:gpt-5.5',
      workSource: 'issue' as const,
      costUsd: 1,
    },
    {
      ts: `2026-07-16T11:${String(index).padStart(2, '0')}:00.000Z`,
      proposalId: entry.id,
      action: 'merged' as const,
      verdict: 'applied',
      labelBasis,
    },
  ]);
}

function dispatch(proposalId: string): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: '2026-07-16T10:00:00.000Z',
    itemId: `${REPO}:issue:${proposalId}`,
    source: 'issue',
    repo: REPO,
    title: 'M437 trajectory fixture',
    backend: 'codex',
    tier: 'frontier',
    model: 'gpt-5.5',
    assignedBy: 'test',
    routeReason: 'fixture',
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId,
    runId: `run-${proposalId}`,
    trajectoryId: `trajectory-${proposalId}`,
    dispatched: true,
    spentUsd: 0,
    basis: 'run-proposal-outcome',
  };
}

function outcome(entry: Proposal, labelBasis: string): OutcomeRecord {
  return {
    version: 1,
    proposal: entry,
    lastActivityAt: '2026-07-16T11:00:00.000Z',
    evidencePacks: [],
    decisions: [{
      ts: '2026-07-16T11:00:00.000Z',
      proposalId: entry.id,
      action: 'merged',
      verdict: 'applied',
      labelBasis,
      runId: `run-${entry.id}`,
      trajectoryId: `trajectory-${entry.id}`,
    }],
    judgeTraces: [],
    workedEvents: [],
  };
}

function trajectory(labelBasis: string) {
  const entry = {
    ...proposal(`trajectory-${labelBasis}`),
    runId: `run-trajectory-${labelBasis}`,
    trajectoryId: `trajectory-trajectory-${labelBasis}`,
  };
  return listTrajectoryRecords({
    windowHours: 24,
    deps: {
      readDispatchProductionEvents: () => [dispatch(entry.id)],
      listOutcomeRecords: () => [outcome(entry, labelBasis)],
      readAgentActions: () => [],
      readSkillUseEvents: () => [],
      loadProposal: () => entry,
    },
  });
}

function genericSignedCardAttempt(overrides: Partial<SkillCard>): SkillCard {
  const unsigned: SkillCard = {
    schemaVersion: 1,
    skillId: 'skill.m437',
    revision: 1,
    ts: '2026-07-16T09:00:00.000Z',
    name: 'Released post-merge verification',
    summary: 'Run the focused firewall regression.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['m437', 'released'],
    taskKinds: ['typescript-change'],
    commandKinds: ['test'],
    verification: {
      passed: true,
      commandKinds: ['test'],
      diffHash: 'a'.repeat(64),
      evidenceCount: 1,
    },
    proposalId: 'proposal-skill',
    ...overrides,
  };
  const diffHash = unsigned.verification?.diffHash;
  if (!unsigned.proposalId || !diffHash) throw new Error('invalid persisted M437 skill fixture');
  const contentHash = skillCardContentHash(unsigned);
  const attestation = signSkillCardAttestation({
    contentHash,
    skillId: unsigned.skillId,
    revision: unsigned.revision,
    proposalId: unsigned.proposalId,
    diffHash,
  });
  if (!attestation) throw new Error('failed to sign persisted M437 skill fixture');
  return { ...unsigned, contentHash, attestation };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fixture.decisions = [];
  fixture.proposals = [];
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m437-credit-firewall-'));
  process.env.HOME = home;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M437 post-merge credit firewall', () => {
  it('keeps realized merge evidence factual without treating its basis as a credit release', () => {
    const entry = proposal('factual-realized-merge');

    expect(hasRealizedMergeEvidence(entry)).toBe(true);
    expect(realizedMergeOf(entry)).toEqual(entry.realizedMerge);
    expect(hasReleasedPostMergeCredit(REALIZED)).toBe(false);
    expect(isPostMergeCreditReleaseLabel(POST_MERGE_CREDIT_RELEASE_LABEL)).toBe(true);
    expect(hasReleasedPostMergeCredit(POST_MERGE_CREDIT_RELEASE_LABEL)).toBe(false);
    expect(linkOutcomeResult(entry.id, 'merged', {
      basis: POST_MERGE_CREDIT_RELEASE_LABEL,
    })).toEqual({ status: 'unqualified' });
  });

  it('rejects padded and stateful release-label bypasses at the generic judge writer', () => {
    const genericWriter = linkOutcomeResult as unknown as (
      proposalId: string,
      outcome: 'merged',
      qualification: { basis: unknown },
    ) => { status: string };
    let basisReads = 0;
    const statefulQualification = Object.defineProperty({}, 'basis', {
      enumerable: true,
      get: () => {
        basisReads++;
        return basisReads === 1 ? REALIZED : POST_MERGE_CREDIT_RELEASE_LABEL;
      },
    }) as { basis: unknown };

    expect(genericWriter('padded-release', 'merged', {
      basis: ` ${POST_MERGE_CREDIT_RELEASE_LABEL} `,
    })).toEqual({ status: 'unqualified' });
    expect(genericWriter('stateful-release', 'merged', statefulQualification))
      .toEqual({ status: 'unqualified' });
    expect(basisReads).toBe(0);
  });

  it('keeps factual projections while every raw label withholds adaptive credit', async () => {
    for (const labelBasis of [REALIZED, POST_MERGE_CREDIT_RELEASE_LABEL]) {
      installConsumerFixture(labelBasis);

      expect(buildProducerScores('issue', NOW)).toEqual(new Map());
      expect(computeModelRoi('all')['codex:gpt-5.5']).toMatchObject({
        dispatches: LEARNED_ROUTING_MIN_SAMPLES + 1,
        merged: 0,
        costPerMergedUsd: null,
      });
      expect((await computeOutcomePriors({
        listProposals: () => fixture.proposals,
      })).global.issue).toMatchObject({
        created: LEARNED_ROUTING_MIN_SAMPLES + 1,
        merged: 0,
        acceptRate: 0,
      });

      expect(computeQualityMetrics('all')).toMatchObject({
        proposalsCreated: LEARNED_ROUTING_MIN_SAMPLES + 1,
        merged: LEARNED_ROUTING_MIN_SAMPLES + 1,
        acceptRate: 1,
      });
      const records = trajectory(labelBasis);
      expect(records[0]).toMatchObject({ terminalOutcome: 'merged' });
      expect(summarizeTrajectoryLearning(records).routeSpine.dispatchToMerge.count).toBe(1);
    }
  });

  it('suppresses legacy and realized-only skill cards and their tags', () => {
    const cards = [
      genericSignedCardAttempt({
        skillId: 'skill.legacy-no-basis',
        name: 'Legacy exact canary',
        tags: ['legacy-exact-canary'],
        labelBasis: undefined,
      }),
      genericSignedCardAttempt({
        skillId: 'skill.realized-only',
        name: 'Realized exact canary',
        tags: ['realized-exact-canary', 'credit:released-v1'],
        labelBasis: REALIZED,
      }),
      genericSignedCardAttempt({
        skillId: 'skill.released',
        name: 'Released exact canary',
        tags: ['released-exact-canary', 'credit:released-v1'],
        labelBasis: POST_MERGE_CREDIT_RELEASE_LABEL,
      }),
    ];

    expect(inspectVerifiedSkillCorpus([cards[2]!])).toMatchObject({
      considered: 1,
      current: 1,
      eligible: 0,
    });
    expect(inspectVerifiedSkillCorpus(cards)).toMatchObject({
      considered: 3,
      current: 3,
      eligible: 0,
    });
    const selection = selectVerifiedSkills(cards, {
      title: 'legacy exact canary realized exact canary released exact canary',
      tags: ['legacy-exact-canary', 'realized-exact-canary', 'released-exact-canary'],
    });

    expect(selection.eligibleCount).toBe(0);
    expect(selection.selectedSkillIds).toEqual([]);
    expect(JSON.stringify(selection)).not.toContain('legacy-exact-canary');
    expect(JSON.stringify(selection)).not.toContain('realized-exact-canary');
  });
});
